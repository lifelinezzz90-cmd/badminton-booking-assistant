import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  LOGIN_URL,
  VENUES,
  buildRunKey,
  campusOrder,
  confirmPaymentPageFunction,
  courtPriority,
  paymentOutcome,
  submitBookingPageFunction,
  validateConfig,
  venueStatePageFunction,
} from "./booking_logic.mjs";
import { resolveConfig } from "./config_resolver.mjs";

const execFileAsync = promisify(execFile);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");
const APP_INDEX_URL = "https://ydsz.szpu.edu.cn/easyserp/index.html#/index";
const USERNAME_LOGIN_URL =
  "https://authserver.szpu.edu.cn/authserver/login?type=userNameLogin&service=https%3A%2F%2Fydsz.szpu.edu.cn%3A443%2Fcas%2F%2Flogin";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

function localDateText(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00`);
  date.setDate(date.getDate() + days);
  return localDateText(date);
}

function dateTimeOn(dateText, timeText) {
  return new Date(`${dateText}T${timeText}`);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

class Logger {
  constructor() {
    this.lines = [];
  }

  step(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    this.lines.push(line);
    console.log(line);
  }
}

function jsonSafeString(value) {
  return String(value)
    .replace(/\\/g, "/")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ");
}

function parseJsonText(text) {
  return JSON.parse(String(text || "").replace(/^\uFEFF/, ""));
}

function stringifyResult(value) {
  return `${JSON.stringify(value, (_key, item) => (
    typeof item === "string" ? jsonSafeString(item) : item
  ), 2)}\n`;
}

async function loadConfig(configPath) {
  const config = await resolveConfig({ configPath: configPath || "config/local.json" });
  validateConfig(config);
  return config;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readDpapiSecret(secretPath) {
  if (!secretPath) return "";
  const fullPath = resolveProjectPath(secretPath);
  if (!(await exists(fullPath))) return "";
  const quotedPath = `'${String(fullPath).replace(/'/g, "''")}'`;
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `$ErrorActionPreference='Stop'; $raw = (Get-Content -LiteralPath ${quotedPath} -Raw).Trim(); $secure = $raw | ConvertTo-SecureString; $credential = [System.Management.Automation.PSCredential]::new('codex', $secure); [Console]::Out.Write($credential.GetNetworkCredential().Password)`,
  ], {
    cwd: PROJECT_ROOT,
    timeout: 30000,
    windowsHide: true,
  });
  return String(stdout || "");
}

async function writeDpapiSecret(secretPath, plainText) {
  if (!secretPath) return;
  const fullPath = resolveProjectPath(secretPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const encoded = Buffer.from(String(plainText || ""), "utf8").toString("base64");
  const quotedPath = `'${String(fullPath).replace(/'/g, "''")}'`;
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `$ErrorActionPreference='Stop'; $plain=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CODEX_YDSZ_SNAPSHOT_B64)); $secure=ConvertTo-SecureString -String $plain -AsPlainText -Force; $secure | ConvertFrom-SecureString | Set-Content -LiteralPath ${quotedPath} -Encoding UTF8`,
  ], {
    cwd: PROJECT_ROOT,
    timeout: 30000,
    windowsHide: true,
    env: { ...process.env, CODEX_YDSZ_SNAPSHOT_B64: encoded },
  });
}

async function resolveLoginPassword({ config, password, logger }) {
  if (password) return password;
  try {
    const secretPassword = await readDpapiSecret(config.passwordSecret);
    if (secretPassword) {
      logger.step("CAS password loaded from DPAPI secret for this run.");
      return secretPassword;
    }
  } catch (error) {
    logger.step(`CAS DPAPI secret could not be read; existing browser session is required. ${error?.message || error}`);
  }
  return "";
}

async function saveYdszSessionSnapshot({ config, session, logger }) {
  if (!config.sessionSnapshotSecret) return null;
  const snapshot = await evaluate(`(() => {
    const copyStorage = (storage) => {
      const data = {};
      if (!storage) return data;
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        data[key] = storage.getItem(key);
      }
      return data;
    };
    const sessionData = copyStorage(typeof sessionStorage !== "undefined" ? sessionStorage : null);
    const localData = copyStorage(typeof localStorage !== "undefined" ? localStorage : null);
    return {
      savedAt: new Date().toISOString(),
      url: location.href,
      token: sessionData.token || "",
      sessionStorage: sessionData,
      localStorage: localData,
    };
  })()`, session);
  if (!snapshot?.token) return null;
  await writeDpapiSecret(config.sessionSnapshotSecret, JSON.stringify(snapshot));
  logger.step(`Saved ydsz session snapshot to DPAPI secret. token=present url=${snapshot.url}`);
  return snapshot;
}

async function restoreYdszSessionSnapshot({ config, session, logger }) {
  if (!config.sessionSnapshotSecret) return null;
  let snapshotText = "";
  try {
    snapshotText = await readDpapiSecret(config.sessionSnapshotSecret);
  } catch (error) {
    logger.step(`ydsz session snapshot could not be decrypted: ${error?.message || error}`);
    return null;
  }
  if (!snapshotText) return null;
  let snapshot = null;
  try {
    snapshot = JSON.parse(snapshotText);
  } catch (error) {
    logger.step(`ydsz session snapshot is invalid JSON: ${error?.message || error}`);
    return null;
  }
  if (!snapshot?.token || !snapshot.sessionStorage) return null;
  logger.step(`Trying saved ydsz session snapshot from ${snapshot.savedAt || "unknown time"}.`);
  await navigate(APP_INDEX_URL, { session, logger });
  await evaluate(`(() => {
    const sessionData = ${JSON.stringify(snapshot.sessionStorage || {})};
    const localData = ${JSON.stringify(snapshot.localStorage || {})};
    for (const [key, value] of Object.entries(localData)) {
      try { localStorage.setItem(key, value == null ? "" : String(value)); } catch {}
    }
    for (const [key, value] of Object.entries(sessionData)) {
      try { sessionStorage.setItem(key, value == null ? "" : String(value)); } catch {}
    }
    try { location.href = ${JSON.stringify(APP_INDEX_URL)}; } catch {}
    return {
      token: (() => { try { return sessionStorage.getItem("token") || ""; } catch { return ""; } })(),
      url: location.href,
    };
  })()`, session);
  const restored = await waitExistingAppSession({ session, logger }).catch(() => null);
  if (restored?.token || Number(restored?.siteCount || 0) > 0) {
    logger.step(`Saved ydsz session snapshot restored. token=${restored.token ? "present" : "empty"} siteCount=${restored.siteCount}`);
    return restored;
  }
  logger.step("Saved ydsz session snapshot did not produce a usable app session.");
  return null;
}

async function ensureVpn(config, logger) {
  if (!config.openVpn) {
    logger.step("VPN untouched by config.");
    return;
  }
  const script = path.join(PROJECT_ROOT, "tools", "open-vpn.ps1");
  const shortcut = config.easyConnectShortcutPath || "";
  logger.step("Ensuring EasyConnect through project shortcut launcher.");
  const waitSeconds = Number(config.vpnPostLaunchWaitSeconds || 10);
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-ShortcutPath",
    shortcut,
    "-WaitSeconds",
    String(waitSeconds),
  ], {
    cwd: PROJECT_ROOT,
    timeout: Math.max(60000, (waitSeconds + 30) * 1000),
    windowsHide: true,
  });
}

async function ensureWebBridge(logger, config) {
  const webBridge = process.env.KIMI_WEBBRIDGE_EXE || config.webBridgeExecutablePath;
  if (!webBridge) throw new Error("Kimi WebBridge executable path is not configured");
  async function status() {
    const { stdout } = await execFileAsync(webBridge, ["status"], { timeout: 15000, windowsHide: true });
    return JSON.parse(stdout);
  }
  async function wakeExtension() {
    const script = path.join(PROJECT_ROOT, "tools", "start-webbridge.ps1");
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-WaitSeconds",
      "30",
      "-ExecutablePath",
      String(webBridge),
      "-ExtensionId",
      String(config.webBridgeExtensionId || "fldmhceldgbpfpkbgopacenieobmligc"),
    ], {
      cwd: PROJECT_ROOT,
      timeout: 45000,
      windowsHide: true,
    });
  }
  let current = await status().catch(() => null);
  if (!current?.running) {
    logger.step("Starting Kimi WebBridge daemon.");
    await wakeExtension();
    current = await status().catch(() => null);
  }
  if (current?.running && !current.extension_connected) {
    logger.step("Kimi WebBridge daemon is running but extension is disconnected; waking Chrome extension popup.");
    await wakeExtension();
    current = await status().catch(() => null);
  }
  if (!current?.running || !current.extension_connected) {
    throw new Error(`Kimi WebBridge is not ready: ${JSON.stringify(current)}`);
  }
  logger.step(`Kimi WebBridge ready version=${current.version} extension=${current.extension_version}.`);
}

async function wb(action, args = {}, session = "badminton-webbridge") {
  const res = await fetch("http://127.0.0.1:10086/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, args, session }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${action} failed: ${JSON.stringify(json)}`);
  return json.data;
}

async function navigate(url, { session, newTab = false, groupTitle = "badminton-webbridge", logger } = {}) {
  try {
    return await wb("navigate", { url, newTab, group_title: groupTitle }, session);
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("page load timeout")) {
      logger?.step(`Navigation timed out after browser accepted URL; continuing with page-state polling. url=${url}`);
      return { success: false, timeout: true, url };
    }
    throw error;
  }
}

async function evaluate(code, session) {
  const out = await wb("evaluate", { code }, session);
  return out?.value ?? out;
}

async function waitEval(code, predicate, { session, timeoutMs = 120000, intervalMs = 1000, label = "condition" }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(code, session);
    if (predicate(last)) return last;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last).slice(0, 1000)}`);
}

async function ensureBrowserBusinessReachable({ config, session, logger }) {
  const probeUrl = String(config.vpnProbeUrl || APP_INDEX_URL);
  logger.step(`Checking VPN business reachability in browser. url=${probeUrl}`);
  await navigate(probeUrl, { session, newTab: true, logger });
  const state = await waitEval(`(() => ({
    url: location.href,
    title: document.title || "",
    token: (() => { try { return sessionStorage.getItem("token") || ""; } catch { return ""; } })(),
    text: (document.body?.innerText || "").slice(0, 800),
    reachable: location.href.includes("ydsz.szpu.edu.cn") &&
      !/ERR_CONNECTION_TIMED_OUT|ERR_TUNNEL_CONNECTION_FAILED|This site can.t be reached|\u65e0\u6cd5\u8bbf\u95ee\u6b64\u7f51\u7ad9/i.test(document.body?.innerText || "")
  }))()`, (value) => value.reachable, {
    session,
    timeoutMs: Number(config.vpnReadyTimeoutSeconds || 45) * 1000,
    intervalMs: 1000,
    label: "browser VPN business probe",
  });
  logger.step(`Browser VPN business probe reachable: url=${state.url}`);
  return state;
}

async function clickWechatAllowInDesktop({ logger }) {
  const script = path.join(PROJECT_ROOT, "tools", "click-wechat-allow.ps1");
  try {
    const { stdout, stderr } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-MaxAttempts",
      "1",
    ], {
      cwd: PROJECT_ROOT,
      timeout: 10000,
      windowsHide: true,
    });
    const text = `${stdout || ""}${stderr || ""}`.trim();
    logger.step(`WeChat desktop allow click helper result: ${text.slice(0, 500)}`);
    return text;
  } catch (error) {
    logger.step(`WeChat desktop allow click helper failed: ${error?.message || error}`);
    return "";
  }
}

async function openAppIndex({ session, logger }) {
  logger.step("Opening ydsz app index directly.");
  await navigate(APP_INDEX_URL, { session, newTab: true, logger });
  return await waitEval(`(() => ({
    url: location.href,
    title: document.title || "",
    token: (() => { try { return sessionStorage.getItem("token") || ""; } catch { return ""; } })(),
    text: (document.body?.innerText || "").slice(0, 1000),
    appReady: location.href.includes("ydsz.szpu.edu.cn/easyserp") &&
      !!document.querySelector("#app") &&
      /\u9996\u9875|\u6211\u7684|\u9884\u7ea6|\u66f4\u591a|\u8054\u7cfb\u5546\u5bb6/.test(document.body?.innerText || "")
  }))()`, (value) => value.appReady || !!value.token, {
    session,
    timeoutMs: 60000,
    intervalMs: 1000,
    label: "ydsz direct app index",
  });
}

async function readYdszSessionState(session) {
  return await evaluate(`(() => ({
    url: location.href,
    title: document.title || "",
    token: (() => { try { return sessionStorage.getItem("token") || ""; } catch { return ""; } })(),
    text: (document.body?.innerText || "").slice(0, 1000),
    siteCount: document.querySelectorAll(".sitecontentWrap li, .sitecontent li").length,
    usable: !!(() => { try { return sessionStorage.getItem("token") || ""; } catch { return ""; } })() ||
      document.querySelectorAll(".sitecontentWrap li, .sitecontent li").length > 0
  }))()`, session);
}

async function findExistingYdszSession({ session, logger }) {
  logger.step("Looking for an existing logged-in ydsz tab before opening new tabs.");
  let tabCount = 0;
  try {
    const listed = await wb("list_tabs", {}, session).catch(() => null);
    tabCount = (listed?.tabs || []).filter((tab) => String(tab.url || "").includes("ydsz.szpu.edu.cn")).length;
    if (tabCount) logger.step(`Found ${tabCount} existing ydsz tab(s); checking them before CAS.`);
  } catch {}
  for (let attempt = 1; attempt <= Math.max(1, Math.min(tabCount || 1, 8)); attempt += 1) {
    try {
      await wb("find_tab", { url: "https://ydsz.szpu.edu.cn", active: false }, session);
      const state = await readYdszSessionState(session);
      if (state.usable) {
        logger.step(`Existing ydsz tab is usable: token=${state.token ? "present" : "empty"} siteCount=${state.siteCount} url=${state.url}`);
        return state;
      }
      logger.step(`Existing ydsz tab ${attempt} is not logged in: token=empty siteCount=${state.siteCount} url=${state.url}`);
      if (String(state.url || "").includes("ydsz.szpu.edu.cn") && attempt < tabCount) {
        await wb("close_tab", {}, session).catch((error) => logger.step(`Could not close unusable ydsz tab: ${error?.message || error}`));
        continue;
      }
      return null;
    } catch (error) {
      logger.step(`No reusable ydsz tab found: ${error?.message || error}`);
      return null;
    }
  }
  return null;
}

async function waitExistingAppSession({ session, logger, timeoutMs = 15000 }) {
  logger.step("Checking existing ydsz browser session before CAS account login.");
  return await waitEval(`(() => ({
    url: location.href,
    title: document.title || "",
    token: (() => { try { return sessionStorage.getItem("token") || ""; } catch { return ""; } })(),
    text: (document.body?.innerText || "").slice(0, 1000),
    siteCount: document.querySelectorAll(".sitecontentWrap li, .sitecontent li").length,
    appReady: location.href.includes("ydsz.szpu.edu.cn/easyserp") &&
      !!document.querySelector("#app") &&
      /\u9996\u9875|\u6211\u7684|\u9884\u7ea6|\u66f4\u591a|\u8054\u7cfb\u5546\u5bb6/.test(document.body?.innerText || "")
  }))()`, (value) => !!value.token || Number(value.siteCount || 0) > 0, {
    session,
    timeoutMs,
    intervalMs: 500,
    label: "existing ydsz browser session",
  });
}

async function openCasAndApp(session, logger) {
  logger.step("Opening CAS entry after VPN is ready.");
  await navigate(LOGIN_URL, { session, newTab: true, logger });
  return await waitEval(`(() => ({
    url: location.href,
    text: (document.body?.innerText || "").slice(0, 1200),
    ready: location.href.includes("ydsz.szpu.edu.cn/easyserp") &&
      /\u9996\u9875|\u9884\u7ea6|\u6211\u7684|\u67e5\u770b\u5176\u4ed6\u56ed\u533a/.test(document.body?.innerText || ""),
    timeout: /ERR_CONNECTION_TIMED_OUT|This site can.t be reached|\u65e0\u6cd5\u8bbf\u95ee\u6b64\u7f51\u7ad9/i.test(document.body?.innerText || "")
  }))()`, (state) => state.ready || state.timeout, {
    session,
    timeoutMs: 120000,
    label: "CAS redirect into ydsz app",
  });
}

function casStateFunction() {
  return `(() => {
    const readToken = () => { try { return sessionStorage.getItem("token") || ""; } catch { return ""; } };
    const text = (document.body?.innerText || "").slice(0, 1200);
    const url = location.href;
    const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const pwdForm = document.querySelector("#pwdFromId");
    const hiddenPassword = !!(pwdForm && pwdForm.querySelector("#password,input[name=passwordText],input[type=password]"));
    const hiddenAccount = !!(pwdForm && pwdForm.querySelector("#username,input[name=username]"));
    const visiblePassword = [...document.querySelectorAll("#password,input[name=password],input[type=password]")]
      .some((el) => visible(el));
    const visibleAccount = [...document.querySelectorAll("#username,input[name=username],input[type=text]")]
      .some((el) => visible(el) && !/captcha|dynamic|code|phone|mobile|sms|verify|yzm|\u9a8c\u8bc1\u7801|\u624b\u673a|\u77ed\u4fe1|\u52a8\u6001/i.test(el.id || el.name || el.placeholder || ""));
    return {
      url,
      text,
      hasUsername: visibleAccount,
      hasPassword: visiblePassword,
      hasHiddenAccountPasswordForm: hiddenAccount && hiddenPassword,
      hasAccountPasswordForm: (visibleAccount && visiblePassword) || (hiddenAccount && hiddenPassword),
      hasWechatOrSmsOnly: (!!document.querySelector("#wxLogin_a,#dynamicLogin_a,#phoneLoginSpan,#wxLoginSpan") ||
        /\u5fae\u4fe1|\u77ed\u4fe1|\u52a8\u6001\u7801|\u624b\u673a\u53f7/.test(text)) && !visiblePassword && !(hiddenAccount && hiddenPassword),
      token: readToken(),
      appReady: url.includes("ydsz.szpu.edu.cn/easyserp") && !!document.querySelector("#app") && !visiblePassword,
      timeout: /ERR_CONNECTION_TIMED_OUT|This site can.t be reached|\u65e0\u6cd5\u8bbf\u95ee\u6b64\u7f51\u7ad9/i.test(text)
    };
  })()`;
}

async function submitCasLogin({ config, password, session, logger }) {
  logger.step("Submitting CAS login with configured account.");
  try {
    return await evaluate(`(async () => {
    const accountLogin = document.querySelector("#userNameLogin_a");
    if (accountLogin) {
      accountLogin.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    let form = document.querySelector("#pwdFromId");
    if (form) {
      const wrapper = document.querySelector("#pwdLoginDiv");
      if (wrapper) wrapper.style.display = "block";
      form.style.display = "block";
      const clltInput = form.querySelector('input[name="cllt"],#cllt');
      if (clltInput) clltInput.value = "userNameLogin";
      const dlltInput = form.querySelector('input[name="dllt"],#dllt');
      if (dlltInput) dlltInput.value = "generalLogin";
    }
    if (!form) {
      const loginUrl = ${JSON.stringify(USERNAME_LOGIN_URL)};
      const response = await fetch(loginUrl, { credentials: "include" });
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const fetchedForm = doc.querySelector("#pwdFromId");
      if (fetchedForm) {
        const action = new URL(fetchedForm.getAttribute("action") || "/authserver/login", location.origin).href;
        const execution = fetchedForm.querySelector('input[name="execution"]')?.value ||
          document.querySelector('input[name="execution"]')?.value || "";
        const lt = fetchedForm.querySelector('input[name="lt"]')?.value || "";
        const salt = fetchedForm.querySelector("#pwdEncryptSalt")?.value || "";
        const encrypted = (salt && typeof encryptPassword === "function")
          ? encryptPassword(${JSON.stringify(password || "")}, salt)
          : ${JSON.stringify(password || "")};
        const built = document.createElement("form");
        built.id = "pwdFromId";
        built.method = "post";
        built.action = action;
        built.style.display = "none";
        const add = (name, value, id = "") => {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = name;
          if (id) input.id = id;
          input.value = value == null ? "" : String(value);
          built.appendChild(input);
        };
        add("username", ${JSON.stringify(String(config.username))}, "username");
        add("password", encrypted, "saltPassword");
        add("_eventId", "submit");
        add("cllt", "userNameLogin", "cllt");
        add("dllt", "generalLogin", "dllt");
        add("lt", lt, "lt");
        add("execution", execution, "execution");
        add("rmShown", "1");
        document.body.appendChild(built);
        built.submit();
        return { ok:true, submittedFetchedForm:true, encrypted:!!salt, saltLength:salt.length, execution };
      }
    }
    const username = (form ? [...form.querySelectorAll("#username,input[name=username],input[type=text]")] : [...document.querySelectorAll("#username,input[name=username],input[type=text]")])
      .find((el) => visible(el) && !/captcha|dynamic|code|phone|mobile|sms|verify|yzm|\u9a8c\u8bc1\u7801|\u624b\u673a|\u77ed\u4fe1|\u52a8\u6001/i.test(el.id || el.name || el.placeholder || ""));
    const hiddenUsername = form && form.querySelector("#username,input[name=username]");
    const passwordInput = (form ? [...form.querySelectorAll("#password,input[name=passwordText],input[type=password]")] : [...document.querySelectorAll("#password,input[name=passwordText],input[type=password]")])
      .find((el) => visible(el));
    const hiddenPasswordInput = form && form.querySelector("#password,input[name=passwordText],input[type=password]");
    const userField = username || hiddenUsername;
    const passField = passwordInput || hiddenPasswordInput;
    if (!passField) return { ok:false, reason:"CAS account/password login form is not available", text:(document.body?.innerText || "").slice(0, 1200) };
    if (!${JSON.stringify(Boolean(password))}) return { ok:false, reason:"No configured CAS password is available for the account/password form" };
    if (!userField || !passField) return { ok:false, reason:"CAS username/password fields not found" };
    const setValue = (el, value) => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (descriptor && descriptor.set) descriptor.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles:true }));
      el.dispatchEvent(new Event("change", { bubbles:true }));
    };
    setValue(userField, ${JSON.stringify(String(config.username))});
    setValue(passField, ${JSON.stringify(password)});
    document.cookie = "popYhxy=true; path=/; max-age=2592000";
    const checkbox = document.querySelector("#agreeDeal,input[type=checkbox]");
    if (checkbox) {
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event("change", { bubbles:true }));
    }
    document.querySelectorAll("#szpuYhxy,.ways-zzc,.modal,.el-dialog__wrapper").forEach((el) => { el.style.display = "none"; });
    if (typeof checkNeedCaptcha === "function") {
      try { checkNeedCaptcha(); } catch {}
    }
    const needsSlider = !!(window.needCaptcha && window.captchaSwitch === "2" && (form?.querySelector('input[name="cllt"]')?.value || document.querySelector("#cllt")?.value || "") === "userNameLogin");
    if (needsSlider) return { ok:false, reason:"CAS slider captcha is required after username check" };
    const saltPassword = (form && form.querySelector("#saltPassword")) || document.querySelector("#saltPassword");
    const salt = ((form && form.querySelector("#pwdEncryptSalt")) || document.querySelector("#pwdEncryptSalt"))?.value || "";
    if (saltPassword && typeof encryptPassword === "function") {
      saltPassword.value = encryptPassword(passField.value, salt);
      passField.disabled = true;
    }
    const submitForm = form || userField.closest("form");
    if (submitForm) {
      submitForm.submit();
      return { ok:true, submittedForm:true, encrypted:!!saltPassword, saltLength:salt.length };
    }
    return { ok:false, reason:"CAS submit button/form not found" };
  })()`, session);
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("Inspected target navigated or closed")) {
      return { ok:true, navigated:true };
    }
    throw error;
  }
}

async function tryWechatQuickLogin({ session, logger }) {
  logger.step("Trying CAS WeChat quick-login fallback.");
  const firstClick = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = (el) => (el.innerText || el.textContent || el.value || el.title || el.alt || "").trim();
    const clickElement = (el) => {
      if (!el) return false;
      try { el.scrollIntoView({ block:"center", inline:"center" }); } catch {}
      el.click();
      return true;
    };
    const candidates = [...document.querySelectorAll("a,button,span,div,input")].filter(visible);
    const sms = document.querySelector("#dynamicLogin_a,#phoneLogin_a") ||
      document.querySelector("#phoneLoginSpan,#dynamicLoginSpan") ||
      candidates.find((el) => /短信验证码登录|验证码登录|动态码登录|手机号登录/.test(textOf(el)));
    const beforeUrl = location.href;
    if (sms) {
      const href = sms.href || sms.closest("a")?.href || "";
      if (href && !/javascript:/i.test(href)) {
        setTimeout(() => { location.href = href; }, 0);
        return { ok:false, clickedWechat:false, clickedSms:true, scheduledDynamic:true, text:(document.body?.innerText || "").slice(0, 800), url:location.href };
      } else {
        clickElement(sms);
      }
      for (let i = 0; i < 20; i += 1) {
        await sleep(250);
        if (
          location.href !== beforeUrl ||
          location.href.includes("type=dynamicLogin") ||
          document.querySelector("#phoneLoginDiv,#dynamicLoginDiv,#combinedLogin_a_weiXin,#combinedLogin_a_weiXinDiv")
        ) break;
      }
    }
    const refreshed = [...document.querySelectorAll("a,button,span,div,input")].filter(visible);
    const bottomWechat =
      document.querySelector("#combinedLogin_a_weiXin") ||
      document.querySelector("#combinedLogin_a_weiXinDiv") ||
      refreshed.find((el) => {
        const id = String(el.id || "") + " " + String(el.className || "");
        const t = textOf(el);
        return /combinedLogin|weiXin|weixin|wechat/i.test(id) && /微信/.test(t) && !/企业微信/.test(t);
      });
    const wechat = bottomWechat ||
      refreshed.find((el) => {
        const t = textOf(el);
        const id = String(el.id || "") + " " + String(el.className || "");
        if (!/微信登录|微信/.test(t) || /企业微信/.test(t)) return false;
        return /combined|第三方|other|bottom|weiXin|weixin|wechat/i.test(id) ||
          !!el.closest("#combinedLoginDiv,.combinedLogin,.third-login,.other-login");
      });
    if (wechat) {
      const href = wechat.href || wechat.closest("a")?.href || "";
      if (href && !/javascript:/i.test(href)) {
        setTimeout(() => { location.href = href; }, 0);
        return { ok:true, clickedWechat:true, clickedSms:!!sms, usedBottomWechat:!!bottomWechat, scheduledWechat:true, text:(document.body?.innerText || "").slice(0, 800), url:location.href };
      } else {
        clickElement(wechat);
      }
      return { ok:true, clickedWechat:true, clickedSms:!!sms, usedBottomWechat:!!bottomWechat, text:(document.body?.innerText || "").slice(0, 800), url:location.href };
    }
    return { ok:false, clickedWechat:false, clickedSms:!!sms, text:(document.body?.innerText || "").slice(0, 800), url:location.href };
  })()`, session);
  logger.step(`CAS WeChat entry click result: ${JSON.stringify(firstClick).slice(0, 500)}`);

  const deadline = Date.now() + 90000;
  let lastState = null;
  let lastWechatDesktopClickAt = 0;
  while (Date.now() < deadline) {
    await sleep(1000);
    lastState = await evaluate(`(() => {
      const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const textOf = (el) => (el.innerText || el.textContent || el.value || el.title || el.alt || "").trim();
      const text = (document.body?.innerText || "").slice(0, 1200);
      const token = (() => { try { return sessionStorage.getItem("token") || ""; } catch { return ""; } })();
      const appReady = location.href.includes("ydsz.szpu.edu.cn/easyserp") && !!document.querySelector("#app");
      let clicked = "";
      const bottomWechat = document.querySelector("#combinedLogin_a_weiXin") ||
        document.querySelector("#combinedLogin_a_weiXinDiv");
      const clickable = [...document.querySelectorAll("a,button,input,[role=button],.btn,.button")].filter(visible);
      const button = clickable.find((el) => {
        const t = textOf(el);
        if (!t || t.length > 60) return false;
        if (/取消|返回|关闭|不同意/.test(t)) return false;
        return /快捷登录|确认登录|允许|同意|授权|登录/.test(t);
      });
      if (!appReady && !token && bottomWechat) {
        clicked = "bottom-wechat";
        const href = bottomWechat.href || bottomWechat.closest("a")?.href || "";
        if (href && !/javascript:/i.test(href)) {
          setTimeout(() => { location.href = href; }, 0);
        } else {
          try { bottomWechat.scrollIntoView({ block:"center", inline:"center" }); } catch {}
          bottomWechat.click();
        }
      } else if (!appReady && !token && button) {
        clicked = textOf(button).slice(0, 40);
        try { button.scrollIntoView({ block:"center", inline:"center" }); } catch {}
        button.click();
      }
      return {
        url: location.href,
        title: document.title || "",
        token,
        appReady,
        clicked,
        hasQr: /二维码|扫码|扫一扫|微信扫码/.test(text),
        hasQuick: /快捷登录|确认登录|允许|授权/.test(text),
        needsBinding: /首次绑定需验证用户信息|一网通办绑定的手机号/.test(text),
        text,
      };
    })()`, session);
    if (lastState?.clicked) logger.step(`Clicked WeChat quick-login control: ${lastState.clicked}`);
    const shouldTryDesktopAllow = String(lastState?.url || "").includes("open.weixin.qq.com") ||
      /微信快捷登录|申请使用|昵称|头像/.test(String(lastState?.text || ""));
    if (shouldTryDesktopAllow && Date.now() - lastWechatDesktopClickAt > 3000) {
      lastWechatDesktopClickAt = Date.now();
      await clickWechatAllowInDesktop({ logger });
    }
    if (lastState?.token || lastState?.appReady) {
      const app = await waitExistingAppSession({ session, logger, timeoutMs: 20000 }).catch(() => lastState);
      logger.step(`CAS WeChat quick-login succeeded: url=${app.url || lastState.url}`);
      return { ok: true, state: app };
    }
    if (lastState?.needsBinding && !lastState?.hasQr && !lastState?.hasQuick) {
      return { ok: false, reason: "CAS WeChat page requires first binding/phone verification and exposes no quick-login control", state: lastState };
    }
  }
  return { ok: false, reason: "CAS WeChat quick-login did not reach ydsz before timeout", state: lastState };
}

async function openCasAndAppWithLogin({ config, password, session, logger, forceWechat = false }) {
  const existing = forceWechat ? null : await waitExistingAppSession({ session, logger }).catch(() => null);
  if (!forceWechat && (existing?.token || Number(existing?.siteCount || 0) > 0)) {
    logger.step("Existing ydsz browser session is usable; skipping CAS account login.");
    return existing;
  }
  logger.step("Opening CAS entry after VPN is ready.");
  await navigate(USERNAME_LOGIN_URL, { session, newTab: true, logger });
  const state = await waitEval(casStateFunction(), (value) =>
    value.appReady || value.timeout || value.hasAccountPasswordForm || value.hasWechatOrSmsOnly,
  {
    session,
    timeoutMs: 60000,
    label: "CAS login or ydsz app shell",
  });
  if ((state.appReady || state.timeout) && !forceWechat) return state;
  if (forceWechat) {
    const wechat = await tryWechatQuickLogin({ session, logger });
    if (wechat.ok) return wechat.state;
    logger.step(`Forced CAS WeChat quick-login did not complete before account-password fallback: ${JSON.stringify(wechat).slice(0, 800)}`);
  }
  if (!state.hasAccountPasswordForm) {
    if (state.hasWechatOrSmsOnly) {
      const wechat = await tryWechatQuickLogin({ session, logger });
      if (wechat.ok) return wechat.state;
      if (!password) {
        throw new Error(`CAS_AUTH_METHOD_UNAVAILABLE: CAS only exposes WeChat/SMS login and WeChat quick-login failed. result=${JSON.stringify(wechat).slice(0, 1000)} text=${String(state.text || "").slice(0, 600)}`);
      }
    }
    if (!password) {
      return await waitEval(casStateFunction(), (value) => value.appReady || value.timeout, {
        session,
        timeoutMs: 60000,
        label: "existing CAS session redirect into ydsz app",
      });
    }
  }
  const submitState = await submitCasLogin({ config, password, session, logger });
  if (!submitState?.ok) throw new Error(`CAS login submit failed: ${JSON.stringify(submitState)}`);
  const postSubmitState = await waitEval(casStateFunction(), (value) =>
    value.appReady || value.timeout || value.hasWechatOrSmsOnly || value.hasAccountPasswordForm,
  {
    session,
    timeoutMs: 15000,
    intervalMs: 500,
    label: "CAS login immediate outcome",
  });
  if (postSubmitState.appReady || postSubmitState.timeout) return postSubmitState;
  if (postSubmitState.hasWechatOrSmsOnly && !postSubmitState.hasAccountPasswordForm) {
    const wechat = await tryWechatQuickLogin({ session, logger });
    if (wechat.ok) return wechat.state;
    throw new Error(
      `CAS_ACCOUNT_LOGIN_REJECTED: CAS returned to WeChat/SMS login after account-password submit. ` +
      `Account-password automation is blocked for this browser/account session; SMS/WeChat login is required. ` +
      `WeChat quick-login failed: ${JSON.stringify(wechat).slice(0, 1000)} ` +
      `submit=${JSON.stringify(submitState)} text=${String(postSubmitState.text || "").slice(0, 600)}`,
    );
  }
  if (postSubmitState.hasAccountPasswordForm) {
    throw new Error(
      `CAS_ACCOUNT_LOGIN_NOT_ACCEPTED: CAS stayed on the account login form after submit; password/captcha/manual verification may be required. ` +
      `submit=${JSON.stringify(submitState)} text=${String(postSubmitState.text || "").slice(0, 600)}`,
    );
  }
  return postSubmitState;
}

async function openVenueLegacy({ campus, config, session, logger }) {
  const venue = VENUES[campus];
  logger.step(`Opening venue campus=${campus} shopNum=${venue.shopNum}.`);
  await navigate("https://ydsz.szpu.edu.cn/easyserp/index.html#/index", { session, logger });
  await waitEval(`(() => ({
    url: location.href,
    ready: location.href.includes("ydsz.szpu.edu.cn/easyserp") &&
      /\u9996\u9875|\u9884\u7ea6|\u6211\u7684|\u67e5\u770b\u5176\u4ed6\u56ed\u533a/.test(document.body?.innerText || "")
  }))()`, (state) => state.ready, { session, timeoutMs: 60000, label: "app shell" });
  await evaluate(`(() => {
    sessionStorage.setItem("shopNum", ${JSON.stringify(venue.shopNum)});
    return sessionStorage.getItem("shopNum");
  })()`, session);
  await navigate(venue.url, { session, logger });
  const state = await waitEval(venueStatePageFunction, (value) =>
    String(value.url || "").includes("/siteList") && Number(value.siteCount || -1) > 0,
  { session, timeoutMs: Number(config.pageWaitSeconds || 180) * 1000, label: `venue ready ${campus}` });
  logger.step(`Venue ready campus=${campus} siteCount=${state.siteCount}.`);
  return state;
}

function venueWarmupFunction({ targetDate, refreshDelayMs = 60, refreshTimeoutMs = 900 }) {
  return `
(async () => {
  const targetDate = ${JSON.stringify(targetDate || "")};
  const refreshDelayMs = Math.max(0, Number(${JSON.stringify(refreshDelayMs)} || 60));
  const refreshTimeoutMs = Math.max(200, Number(${JSON.stringify(refreshTimeoutMs)} || 900));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let vm = null;
  const seen = new Set();
  function walk(x) {
    if (!x || seen.has(x)) return;
    seen.add(x);
    if (x._data && Object.prototype.hasOwnProperty.call(x._data, "siteList")) vm = x;
    (x.$children || []).forEach(walk);
  }
  walk(document.querySelector("#app")?.__vue__);
  const dateItems = [...document.querySelectorAll(".date_top li")];
  const dateArr = Array.isArray(vm?.dateArr) ? vm.dateArr : [];
  const domIndex = dateItems.findIndex((el) => (el.innerText || el.textContent || "").includes(targetDate));
  const vmIndex = dateArr.findIndex((item) => item?.nowDate === targetDate);
  const index = vmIndex >= 0 ? vmIndex : domIndex;
  const clickElement = (el) => {
    if (!el) return false;
    try { el.scrollIntoView({ block:"center", inline:"center" }); } catch {}
    try { el.click(); return true; } catch {}
    try {
      for (const type of ["mousedown", "mouseup", "click"]) {
        el.dispatchEvent(new MouseEvent(type, { bubbles:true, cancelable:true, view:window }));
      }
      return true;
    } catch {}
    return false;
  };
  const waitTick = async () => {
    if (vm?.$nextTick) await new Promise((resolve) => vm.$nextTick(resolve));
    await sleep(refreshDelayMs);
  };
  const refreshTarget = async (label) => {
    if (!vm || index < 0) return { label, ok:false, reason:"target date not found", index, dateCount:dateItems.length };
    if (targetDate) vm.isKey = targetDate;
    if (typeof vm.discountGetSiteList !== "function") return { label, ok:false, reason:"discountGetSiteList unavailable", index };
    await Promise.race([
      Promise.resolve(vm.discountGetSiteList(targetDate, Math.max(0, index))),
      new Promise((_, reject) => setTimeout(() => reject(new Error(label + " timeout after " + refreshTimeoutMs + "ms")), refreshTimeoutMs)),
    ]);
    await waitTick();
    return { label, ok:true, index, siteCount:Array.isArray(vm.siteList) ? vm.siteList.length : -1, buyFlag:!!vm.buyFlag };
  };
  const details = [];
  try {
    if (dateItems[index]) {
      details.push({ label:"target-date-click", ok:clickElement(dateItems[index]), index });
      await waitTick();
    }
    details.push(await refreshTarget("target-date-refresh"));
    if ((!Array.isArray(vm?.siteList) || vm.siteList.length <= 0) && dateItems.length > 1 && index >= 0) {
      const alternateIndex = index + 1 < dateItems.length ? index + 1 : index - 1;
      details.push({ label:"alternate-date-click", ok:clickElement(dateItems[alternateIndex]), index:alternateIndex });
      await waitTick();
      details.push({ label:"target-date-click-2", ok:clickElement(dateItems[index]), index });
      await waitTick();
      details.push(await refreshTarget("date-toggle-refresh"));
    }
  } catch (error) {
    details.push({ label:"warmup-error", ok:false, reason:error?.message || String(error) });
  }
  return {
    url:location.href,
    token:(() => { try { return sessionStorage.getItem("token") || ""; } catch { return ""; } })(),
    shopNum:(() => { try { return sessionStorage.getItem("shopNum") || ""; } catch { return ""; } })(),
    hasVenueVm:!!vm,
    dateCount:dateItems.length,
    index,
    siteCount:Array.isArray(vm?.siteList) ? vm.siteList.length : -1,
    buyFlag:!!vm?.buyFlag,
    details,
  };
})()
`;
}

async function openVenue({ campus, config, targetDate, session, logger }) {
  const venue = VENUES[campus];
  logger.step(`Opening venue campus=${campus} shopNum=${venue.shopNum}.`);
  await navigate(APP_INDEX_URL, { session, logger });
  await waitEval(`(() => ({
    url: location.href,
    ready: location.href.includes("ydsz.szpu.edu.cn/easyserp") &&
      !!document.querySelector("#app") &&
      /\u9996\u9875|\u9884\u7ea6|\u6211\u7684|\u66f4\u591a|\u8054\u7cfb\u5546\u5bb6/.test(document.body?.innerText || "")
  }))()`, (state) => state.ready, { session, timeoutMs: 60000, label: "app shell" });

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await evaluate(`(() => {
      try { sessionStorage.setItem("shopNum", ${JSON.stringify(venue.shopNum)}); } catch {}
      return { shopNum:(() => { try { return sessionStorage.getItem("shopNum") || ""; } catch { return ""; } })(), url:location.href };
    })()`, session);
    if (attempt === 1) {
      await navigate(venue.url, { session, logger });
    } else {
      logger.step(`Retrying venue route campus=${campus} attempt=${attempt}.`);
      await evaluate(`(() => { location.href = ${JSON.stringify(venue.url)}; return location.href; })()`, session);
    }
    try {
      const shellState = await waitEval(venueStatePageFunction, (value) =>
        String(value.url || "").includes("/siteList") && value.hasVenueVm && value.hasDateTop,
      { session, timeoutMs: 30000, label: `venue shell ${campus}` });
      if (Number(shellState.siteCount || -1) <= 0 && targetDate) {
        const warmup = await evaluate(venueWarmupFunction({
          targetDate,
          refreshDelayMs: Number(config.fastRefreshDelayMs || 60),
          refreshTimeoutMs: Number(config.fastRefreshTimeoutMs || 900),
        }), session);
        logger.step(`Venue warmup campus=${campus}: ${JSON.stringify(warmup).slice(0, 800)}`);
      }
      const state = await waitEval(venueStatePageFunction, (value) =>
        String(value.url || "").includes("/siteList") && Number(value.siteCount || -1) > 0,
      { session, timeoutMs: Math.min(Number(config.pageWaitSeconds || 180) * 1000, 30000), label: `venue ready ${campus}` });
      logger.step(`Venue ready campus=${campus} siteCount=${state.siteCount}.`);
      return state;
    } catch (error) {
      lastError = error;
      logger.step(`Venue route not ready campus=${campus} attempt=${attempt}: ${error?.message || error}`);
    }
  }
  throw lastError || new Error(`Venue calendar did not become ready for ${campus}.`);
}

function selectSlotFunction(input) {
  return `
(async () => {
  const input = ${JSON.stringify(input)};
  const targetDate = input.targetDate;
  const desiredStartTime = input.desiredStartTime;
  const desiredEndTime = input.desiredEndTime;
  const courtPriority = input.courtPriority || [];
  const allowAny = !!input.allowAny;
  const minSlots = Math.max(1, Number(input.minSlots || 2));
  const maxSlotsInput = Number(input.maxSlots || 0);
  const maxAmount = Number(input.maxAmount || 0);
  const refreshDelayMs = Math.max(0, Number(input.refreshDelayMs || 60));
  const refreshTimeoutMs = Math.max(200, Number(input.refreshTimeoutMs || 900));
  const refreshThrottleMs = Math.max(100, Number(input.refreshThrottleMs || 250));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const toMinutes = (time) => {
    const m = String(time || "").match(/^(\\d{1,2}):(\\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const desiredStarts = [];
  const desiredWindowStart = toMinutes(desiredStartTime);
  const desiredWindowEnd = toMinutes(desiredEndTime);
  if (!allowAny) {
    const start = desiredWindowStart;
    const end = desiredWindowEnd;
    for (let cursor = start; cursor < end; cursor += 30) {
      desiredStarts.push(String(Math.floor(cursor / 60)).padStart(2, "0") + ":" + String(cursor % 60).padStart(2, "0"));
    }
  }
  const maxSlots = maxSlotsInput > 0 ? Math.max(minSlots, Math.floor(maxSlotsInput)) : (desiredStarts.length || 999);
  const configuredSlotCount = !allowAny && desiredStarts.length > 0 ? Math.min(desiredStarts.length, maxSlots) : maxSlots;
  const configuredWindows = [];
  if (!allowAny && configuredSlotCount > 0) {
    for (let i = 0; i <= desiredStarts.length - configuredSlotCount; i += 1) {
      configuredWindows.push(desiredStarts.slice(i, i + configuredSlotCount));
    }
  }
  let vm = null;
  const seen = new Set();
  function walk(x) {
    if (!x || seen.has(x)) return;
    seen.add(x);
    if (x._data && Object.prototype.hasOwnProperty.call(x._data, "siteList")) vm = x;
    (x.$children || []).forEach(walk);
  }
  walk(document.querySelector("#app")?.__vue__);
  if (!vm) return { ok:false, reason:"venue Vue instance not found" };
  const index = (vm.dateArr || []).findIndex((item) => item.nowDate === targetDate);
  const previousKey = vm.isKey;
  const clickElement = (el) => {
    if (!el) return false;
    try { el.scrollIntoView({ block:"center", inline:"center" }); } catch {}
    try { el.click(); return true; } catch {}
    try {
      for (const type of ["mousedown", "mouseup", "click"]) {
        el.dispatchEvent(new MouseEvent(type, { bubbles:true, cancelable:true, view:window }));
      }
      return true;
    } catch {}
    return false;
  };
  const dateItems = [...document.querySelectorAll(".date_top li")];
  const clickDateByIndex = async (dateIndex) => {
    const el = dateItems[dateIndex];
    if (!el) return false;
    clickElement(el);
    if (vm.$nextTick) await new Promise((resolve) => vm.$nextTick(resolve));
    await sleep(refreshDelayMs);
    return true;
  };
  const refreshTargetDate = async (label) => {
    if (index >= 0) vm.isKey = targetDate;
    if (typeof vm.discountGetSiteList !== "function") return { label, ok:false, reason:"discountGetSiteList unavailable" };
    await Promise.race([
      Promise.resolve(vm.discountGetSiteList(targetDate, Math.max(0, index))),
      new Promise((_, reject) => setTimeout(() => reject(new Error(label + " timeout after " + refreshTimeoutMs + "ms")), refreshTimeoutMs)),
    ]);
    if (vm.$nextTick) await new Promise((resolve) => vm.$nextTick(resolve));
    await sleep(refreshDelayMs);
    return { label, ok:true, siteCount:Array.isArray(vm.siteList) ? vm.siteList.length : -1, buyFlag:!!vm.buyFlag };
  };
  const needsDateSwitch = vm.isKey !== targetDate;
  if (needsDateSwitch) {
    vm.isKey = targetDate;
  }
  const nowMs = Date.now();
  const lastRefreshAt = Number(window.__codexBadmintonLastSiteRefreshAt || 0);
  const shouldRefresh = needsDateSwitch || !vm.buyFlag || (nowMs - lastRefreshAt >= refreshThrottleMs);
  let refreshed = false;
  let refreshError = "";
  const refreshDetails = [];
  if (shouldRefresh && typeof vm.discountGetSiteList === "function") {
    try {
      window.__codexBadmintonLastSiteRefreshAt = nowMs;
      refreshDetails.push(await refreshTargetDate("target-date-refresh"));
      refreshed = true;
    } catch (error) {
      refreshError = error?.message || String(error);
    }
  }
  let dateToggled = false;
  let dateToggleError = "";
  if (!vm.buyFlag && index >= 0 && dateItems.length > 1) {
    const lastToggleAt = Number(window.__codexBadmintonLastDateToggleAt || 0);
    if (nowMs - lastToggleAt >= Math.max(500, refreshThrottleMs * 2)) {
      try {
        window.__codexBadmintonLastDateToggleAt = nowMs;
        const alternateIndex = index + 1 < dateItems.length ? index + 1 : index - 1;
        dateToggled = await clickDateByIndex(alternateIndex);
        await clickDateByIndex(index);
        refreshDetails.push(await refreshTargetDate("date-toggle-refresh"));
      } catch (error) {
        dateToggleError = error?.message || String(error);
      }
    }
  }
  if (!vm.buyFlag) {
    return {
      ok:false,
      reason:"booking not open now",
      isKey:vm.isKey,
      previousKey,
      targetDate,
      buyFlag:vm.buyFlag,
      openTime:vm.openTime,
      closeTime:vm.closeTime,
      refreshed,
      refreshError,
      dateToggled,
      dateToggleError,
      refreshDetails,
      text:(document.body?.innerText || "").slice(-600)
    };
  }
  const sites = Array.isArray(vm.siteList) ? vm.siteList : [];
  const candidates = [];
  const selectedMoney = (selected) => selected.reduce((sum, item) => sum + Number(item.slot.money || 0), 0);
  function push(selected) {
    const money = selectedMoney(selected);
    if (maxAmount > 0 && money > maxAmount + 0.01) return false;
    const first = selected[0];
    const courtNo = String((first.court.name || "").match(/\\d+/)?.[0] || "");
    candidates.push({
      selected,
      courtNo,
      priorityRank: courtPriority.includes(courtNo) ? courtPriority.indexOf(courtNo) : 999,
      start: first.slot.starttime || "",
      durationSlots: selected.length,
      money,
    });
    return true;
  }
  for (let siteIndex = 0; siteIndex < sites.length; siteIndex += 1) {
    const site = sites[siteIndex];
    const court = site.projectName || {};
    const courtNo = String((court.name || "").match(/\\d+/)?.[0] || "");
    if (courtPriority.length && !courtPriority.includes(courtNo)) continue;
    const slots = site.projectInfo || [];
    if (!allowAny) {
      for (const windowStarts of configuredWindows) {
        const selected = [];
        for (const start of windowStarts) {
          const slotIndex = slots.findIndex((slot) => slot.starttime === start && Number(slot.state) === 1);
          if (slotIndex < 0) {
            selected.length = 0;
            break;
          }
          selected.push({ siteIndex, slotIndex, court, slot: slots[slotIndex] });
        }
        if (selected.length === windowStarts.length) push(selected);
      }
    } else {
      let run = [];
      const flush = () => {
        if (run.length >= minSlots) {
          const longest = Math.min(run.length, maxSlots);
          for (let size = longest; size >= minSlots; size -= 1) {
            for (let startIndex = 0; startIndex <= run.length - size; startIndex += 1) {
              push(run.slice(startIndex, startIndex + size));
            }
          }
        }
        run = [];
      };
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
        const slot = slots[slotIndex];
        const start = toMinutes(slot.starttime);
        const withinDesiredWindow = start !== null &&
          (desiredWindowStart === null || start >= desiredWindowStart) &&
          (desiredWindowEnd === null || start < desiredWindowEnd);
        if (Number(slot.state) === 1 && withinDesiredWindow) {
          run.push({ siteIndex, slotIndex, court, slot });
        } else {
          flush();
        }
      }
      flush();
    }
  }
  if (!candidates.length) return { ok:false, reason:allowAny ? "no available slot any time" : "desired slot unavailable", siteCount:sites.length };
  candidates.sort((a, b) => {
    if (allowAny) {
      return a.priorityRank - b.priorityRank ||
        b.durationSlots - a.durationSlots ||
        a.start.localeCompare(b.start) ||
        a.courtNo.localeCompare(b.courtNo);
    }
    return a.priorityRank - b.priorityRank ||
      a.start.localeCompare(b.start) ||
      a.courtNo.localeCompare(b.courtNo);
  });
  const chosen = candidates[0].selected;
  vm.selectList.splice(0, vm.selectList.length);
  vm.changeItems.splice(0, vm.changeItems.length);
  for (const site of sites) {
    for (const slot of site.projectInfo || []) if (Number(slot.state) === 3) slot.state = 1;
  }
  vm.$forceUpdate();
  await sleep(80);
  for (const item of chosen) {
    await vm.select(item.slot, item.siteIndex, item.slotIndex);
    if (vm.$nextTick) await new Promise((resolve) => vm.$nextTick(resolve));
    await sleep(150);
  }
  const first = chosen[0];
  const last = chosen[chosen.length - 1];
  const actualSelected = [];
  for (let siteIndex = 0; siteIndex < sites.length; siteIndex += 1) {
    const site = sites[siteIndex];
    const court = site.projectName || {};
    for (let slotIndex = 0; slotIndex < (site.projectInfo || []).length; slotIndex += 1) {
      const slot = site.projectInfo[slotIndex];
      if (Number(slot.state) === 3) actualSelected.push({ siteIndex, slotIndex, court, slot });
    }
  }
  actualSelected.sort((a, b) => a.siteIndex - b.siteIndex || toMinutes(a.slot.starttime) - toMinutes(b.slot.starttime));
  const selectedCount = actualSelected.length || (Array.isArray(vm.changeItems) ? vm.changeItems.length : 0);
  const total = String(vm.money || vm.totalMoney || "0.00");
  const expectedMoney = chosen.reduce((sum, item) => sum + Number(item.slot.money || 0), 0);
  const actualTotal = Number(String(total).match(/\\d+(?:\\.\\d+)?/)?.[0] || 0);
  const amountMismatch = expectedMoney > 0 && actualTotal > 0 && Math.abs(actualTotal - expectedMoney) > 0.01;
  if (selectedCount < chosen.length || amountMismatch) {
    const minPartialSlots = Math.max(1, Number(input.minSlots || 2));
    let bestPartial = [];
    let run = [];
    const flushActualRun = () => {
      if (run.length >= minPartialSlots && run.length > bestPartial.length) bestPartial = run.slice();
      run = [];
    };
    for (const item of actualSelected) {
      const start = toMinutes(item.slot.starttime);
      const end = toMinutes(item.slot.endtime);
      const prev = run[run.length - 1];
      const prevEnd = prev ? toMinutes(prev.slot.endtime) : null;
      const sameCourt = !prev || prev.siteIndex === item.siteIndex;
      const contiguous = !prev || prevEnd === start;
      const withinDesiredWindow = start !== null && end !== null &&
        (desiredWindowStart === null || start >= desiredWindowStart) &&
        (desiredWindowEnd === null || end <= desiredWindowEnd);
      if (!withinDesiredWindow || !sameCourt || !contiguous) flushActualRun();
      if (withinDesiredWindow) run.push(item);
    }
    flushActualRun();
    if (bestPartial.length >= minPartialSlots) {
      const partialMoney = bestPartial.reduce((sum, item) => sum + Number(item.slot.money || 0), 0);
      const partialAmountMismatch = partialMoney > 0 && actualTotal > 0 && Math.abs(actualTotal - partialMoney) > 0.01;
      if (!partialAmountMismatch) {
        const partialFirst = bestPartial[0];
        const partialLast = bestPartial[bestPartial.length - 1];
        return {
          ok:true,
          campus:input.campus,
          targetDate,
          court:partialFirst.court.name,
          start:partialFirst.slot.starttime,
          end:partialLast.slot.endtime,
          slotCount:bestPartial.length,
          durationMinutes:bestPartial.length * 30,
          times:bestPartial.map((item) => item.slot.starttime + "-" + item.slot.endtime),
          money:partialMoney,
          fallbackMode:"degraded-partial",
          partialFallback:true,
          selectedCount,
          expectedCount:chosen.length,
          total,
          degradedFromFull:true
        };
      }
    }
    return {
      ok:false,
      reason:"selection rejected by page",
      selectedCount,
      expectedCount:chosen.length,
      total,
      expectedMoney,
      amountMismatch,
      isKey:vm.isKey,
      buyFlag:vm.buyFlag,
      toast:(document.body?.innerText || "").slice(-800)
    };
  }
  return {
    ok:true,
    campus:input.campus,
    targetDate,
    court:first.court.name,
    start:first.slot.starttime,
    end:last.slot.endtime,
    slotCount:chosen.length,
    durationMinutes:chosen.length * 30,
    times:chosen.map((item) => item.slot.starttime + "-" + item.slot.endtime),
    money:expectedMoney,
    fallbackMode:allowAny ? "any-available" : "configured",
    selectedCount,
    total
  };
})()
`;
}

async function trySelectSlot({ campus, config, targetDate, session, allowAny }) {
  return await evaluate(selectSlotFunction({
    campus,
    targetDate,
    desiredStartTime: config.desiredStartTime,
    desiredEndTime: config.desiredEndTime,
    courtPriority: courtPriority(config, campus),
    allowAny,
    minSlots: Math.ceil(Number(config.partialMinMinutes || 60) / 30),
    maxSlots: Math.floor(Number(config.maxBookingMinutes || 0) / 30) || 0,
    maxAmount: Number(config.maxBookingAmount || 0),
    refreshDelayMs: Number(config.fastRefreshDelayMs || 60),
    refreshTimeoutMs: Number(config.fastRefreshTimeoutMs || 900),
    refreshThrottleMs: Number(config.refreshThrottleMs || 250),
  }), session);
}

async function submitAndMaybePayLegacy({ slot, noConfirmPayment, session, logger }) {
  logger.step(`Submitting slot campus=${slot.campus} court=${slot.court} ${slot.start}-${slot.end}.`);
  const submit = await evaluate(submitBookingPageFunction, session);
  await sleep(1500);
  const paymentPage = await waitEval(`(() => ({
    url: location.href,
    text: (document.body?.innerText || "").slice(0, 3000)
  }))()`, (state) => String(state.url || "").includes("confirmPayment") || /支付|付款|订单|预约/.test(state.text || ""), {
    session,
    timeoutMs: 120000,
    label: "payment page",
  });
  if (!String(paymentPage.url || "").includes("confirmPayment")) {
    throw new Error(`Did not reach confirmPayment: ${JSON.stringify(paymentPage).slice(0, 1000)}`);
  }
  const text = String(paymentPage.text || "").replace(/\s+/g, "");
  const hasTime = (slot.times || [`${slot.start}-${slot.end}`]).some((time) =>
    text.includes(time.replace(/\s+/g, "")) || text.includes(time.replace("-", "").replace(/\s+/g, ""))
  );
  const hasCampus = slot.campus === "lxd" ? text.includes("留仙洞") : text.includes("西丽湖");
  const hasCourt = slot.court ? text.includes(String(slot.court).replace(/\s+/g, "")) : true;
  if (!hasTime || !hasCampus || !hasCourt) {
    throw new Error(`Payment page verification failed: ${JSON.stringify({ hasTime, hasCampus, hasCourt, slot })}`);
  }
  const payment = await evaluate(confirmPaymentPageFunction({ noConfirmPayment }), session);
  return {
    submit,
    payment,
    outcome: paymentOutcome(payment, { noConfirmPayment, slot }),
  };
}

async function submitAndMaybePay({ slot, noConfirmPayment, session, logger }) {
  logger.step(`Submitting slot campus=${slot.campus} court=${slot.court} ${slot.start}-${slot.end}.`);
  const submit = await evaluate(submitBookingPageFunction, session);
  await sleep(1500);
  const paymentPage = await waitEval(`(() => ({
    url: location.href,
    text: (document.body?.innerText || "").slice(0, 3000)
  }))()`, (state) => String(state.url || "").includes("confirmPayment") || /支付|付款|订单|预约/.test(state.text || ""), {
    session,
    timeoutMs: 120000,
    label: "payment page",
  });
  if (!String(paymentPage.url || "").includes("confirmPayment")) {
    throw new Error(`Did not reach confirmPayment: ${JSON.stringify(paymentPage).slice(0, 1000)}`);
  }

  const text = String(paymentPage.text || "").replace(/\s+/g, "");
  const hasTime = (slot.times || [`${slot.start}-${slot.end}`]).some((time) =>
    text.includes(time.replace(/\s+/g, "")) || text.includes(time.replace("-", "").replace(/\s+/g, ""))
  );
  const hasCampus = slot.campus === "lxd" ? text.includes("留仙洞") : text.includes("西丽湖");
  const hasCourt = slot.court ? text.includes(String(slot.court).replace(/\s+/g, "")) : false;
  const amount = Number(slot.money || slot.total || 0);
  const hasAmount = amount > 0 ? (
    text.includes(String(amount)) ||
    text.includes(`\u00a5${amount}`) ||
    text.includes(`\uffe5${amount}`)
  ) : true;
  const strongMatch = hasCampus && (hasTime || hasCourt);
  const submitCameFromSelectedSlot = !!submit?.clickedSubmit && String(paymentPage.url || "").includes("confirmPayment");
  if (!hasCampus || (!strongMatch && !hasAmount && !submitCameFromSelectedSlot)) {
    throw new Error(`Payment page verification failed: ${JSON.stringify({ hasTime, hasCampus, hasCourt, hasAmount, submitCameFromSelectedSlot, slot })}`);
  }
  if (!strongMatch) {
    logger.step(`Payment page lacks full court/time text; proceeding because page campus/amount and immediate submit context match selected slot. campus=${slot.campus} amount=${amount}`);
  }

  const payment = await evaluate(confirmPaymentPageFunction({ noConfirmPayment, campus: slot.campus }), session);
  return {
    submit,
    payment,
    outcome: paymentOutcome(payment, { noConfirmPayment, slot }),
  };
}

function isRetryableBookingFailure({ slot, submitPayment }) {
  const outcome = submitPayment?.outcome || {};
  const submit = submitPayment?.submit || {};
  const payment = submitPayment?.payment || {};
  const paymentText = String(payment.text || "");
  const paymentOrderLooksLive = String(payment.url || "").includes("confirmPayment") && (
    !!payment.clickedPay ||
    Number(payment.cardCount || 0) > 0 ||
    /\u786e\u5b9a\u652f\u4ed8|\u786e\u8ba4\u652f\u4ed8|\u6821\u56ed\u5361|\u4f1a\u5458\u5361\u652f\u4ed8|\u4f1a\u5458\u5361\u6263\u6b3e|\u8d2d\u4e70\u9879\u76ee/.test(paymentText)
  );
  const paymentTextHasConflict = /\u4e0b\u624b\u592a\u665a|\u5df2\u6709\u7528\u6237\u9884\u7ea6|\u5df2\u7ecf\u6709\u7528\u6237\u9884\u7ea6|\u5df2\u88ab\u9884\u7ea6|\u91cd\u65b0\u9009\u62e9/i.test(paymentText);
  if (paymentOrderLooksLive && !paymentTextHasConflict) return false;
  const text = [
    outcome.reason,
    outcome.text,
    submit.reason,
    submit.text,
    payment.reason,
    payment.text,
    slot?.reason,
    slot?.toast,
  ].map((item) => String(item || "")).join("\n");
  return /\u4e0b\u624b\u592a\u665a|\u5df2\u6709\u7528\u6237\u9884\u7ea6|\u5df2\u7ecf\u6709\u7528\u6237\u9884\u7ea6|\u5df2\u88ab\u9884\u7ea6|\u91cd\u65b0\u9009\u62e9|selection rejected|selection click rejected|selection rejected by page/i.test(text);
}

async function writeResult({ config, runDate, targetDate, result, logger, suffix = "webbridge" }) {
  const logDir = path.join(PROJECT_ROOT, "logs");
  await fs.mkdir(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const runKey = buildRunKey({ config, runDate, targetDate });
  const prefix = suffix === "preflight"
    ? path.join(logDir, `preflight_${runDate.replaceAll("-", "")}_for_${targetDate.replaceAll("-", "")}_${stamp}`)
    : path.join(logDir, `${runKey}_${suffix}_${stamp}`);
  const logPath = `${prefix}.log`;
  const errPath = `${prefix}.err.log`;
  const resultPath = `${prefix}.result.json`;
  const mailLogPath = `${prefix}.mail.log`;
  result.logPath = logPath;
  result.errPath = result.success ? "" : errPath;
  result.resultPath = resultPath;
  await fs.writeFile(logPath, `${logger.lines.join("\n")}\n`, "utf8");
  if (!result.success) await fs.writeFile(errPath, `${result.failureReason || "Unknown failure"}\n`, "utf8");
  await fs.writeFile(resultPath, stringifyResult(result), "utf8");
  if (config.mailOnCompletion) {
    result.mail = await sendResultMail({
      config,
      resultPath,
      logPath,
      mailLogPath,
      subjectPrefix: result.preflight ? "羽毛球抢场预检" : "",
    });
    await fs.writeFile(resultPath, stringifyResult(result), "utf8");
  }
  return { resultPath, logPath, errPath: result.errPath, mailLogPath };
}

async function sendResultMail({ config, resultPath, logPath, mailLogPath, subjectPrefix = "" }) {
  const mailScript = path.join(PROJECT_ROOT, "scripts", "send_booking_result_email.ps1");
  const smtpSecret = resolveProjectPath(String(config.smtpSecret || ""));
  try {
    const { stdout, stderr } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      mailScript,
      "-ResultPath",
      resultPath,
      "-LogPath",
      logPath,
      "-To",
      String(config.mailTo),
      "-From",
      String(config.mailFrom),
      "-SmtpServer",
      String(config.smtpServer),
      "-SmtpPort",
      String(config.smtpPort),
      "-CredentialSecureStringPath",
      smtpSecret,
      "-TaskName",
      String(config.taskName || "BadmintonBookingAssistant"),
      ...(subjectPrefix ? ["-SubjectPrefix", subjectPrefix] : []),
    ], {
      cwd: PROJECT_ROOT,
      timeout: 120000,
      windowsHide: true,
    });
    await fs.writeFile(mailLogPath, `${stdout || ""}${stderr || ""}`, "utf8");
    return { sent: true, logPath: mailLogPath };
  } catch (error) {
    const text = `Mail send failed: ${error?.message || error}\n${error?.stdout || ""}\n${error?.stderr || ""}`;
    await fs.writeFile(mailLogPath, text, "utf8");
    return { sent: false, logPath: mailLogPath, error: text };
  }
}

export async function runWebBridgeBooking(options = {}) {
  const logger = new Logger();
  const config = await loadConfig(options.configPath);
  if (options.noMail) config.mailOnCompletion = false;
  const runDate = options.runDate || localDateText();
  const targetDate = options.targetDate || addDays(runDate, 1);
  const sessionBase = options.session || "badminton-webbridge";
  const session = `${sessionBase}-${process.pid}-${Date.now()}`;
  logger.step(`Using WebBridge session ${session}.`);
  const noConfirmPayment = !!options.noConfirmPayment;
  const loginPassword = await resolveLoginPassword({ config, password: options.password || "", logger });
  const result = {
    success: false,
    run: {
      runDate,
      targetDate,
      desiredStartTime: config.desiredStartTime,
      desiredEndTime: config.desiredEndTime,
      primaryCampus: config.primaryCampus,
      fallbackCampus: config.fallbackCampus,
    },
    log: logger.lines,
  };
  try {
    if (!options.preflight && !options.noWait) {
      const pollUntil = dateTimeOn(runDate, config.pollUntilTime);
      const now = new Date();
      if (now.getTime() > pollUntil.getTime()) {
        throw new Error(
          `Refusing stale run: now=${now.toISOString()} is after runDate=${runDate} pollUntil=${pollUntil.toISOString()}.`,
        );
      }
    }
    await ensureWebBridge(logger, config);
    await ensureVpn(config, logger);
    const existingApp = options.forceCasWechat ? null : await findExistingYdszSession({ session, logger });
    let appState = existingApp;
    if (!appState) {
      await ensureBrowserBusinessReachable({ config, session, logger });
      appState = options.forceCasWechat ? null : await restoreYdszSessionSnapshot({ config, session, logger });
      if (!appState) {
        const directApp = options.forceCasWechat ? null : await openAppIndex({ session, logger });
        appState = directApp?.token
          ? directApp
          : await openCasAndAppWithLogin({ config, password: loginPassword, session, logger, forceWechat: !!options.forceCasWechat });
      }
    }
    if (appState.timeout) throw new Error(`CAS redirected but ydsz timed out: ${JSON.stringify(appState)}`);
    await saveYdszSessionSnapshot({ config, session, logger }).catch((error) => {
      logger.step(`Could not save ydsz session snapshot: ${error?.message || error}`);
    });
    let slot = null;
    const diagnostics = [];
    if (options.preflight) {
      for (const campus of campusOrder(config)) {
        diagnostics.push({ campus, ready: await openVenue({ campus, config, targetDate, session, logger }) });
        await saveYdszSessionSnapshot({ config, session, logger }).catch((error) => {
          logger.step(`Could not save ydsz session snapshot after venue ready: ${error?.message || error}`);
        });
      }
      result.success = true;
      result.preflight = true;
      result.failureReason = "";
      result.diagnostics = diagnostics;
      return result;
    }
    const campuses = campusOrder(config);
    const pollStart = dateTimeOn(runDate, config.pollStartTime);
    const pollUntil = dateTimeOn(runDate, config.pollUntilTime);
    if (!options.noWait && Date.now() < pollStart.getTime()) {
      const waitMs = pollStart.getTime() - Date.now();
      logger.step(`Waiting until poll start ${config.pollStartTime}; ${Math.ceil(waitMs / 1000)}s remaining.`);
      await sleep(waitMs);
    }
    let campusIndex = 0;
    let activeCampus = "";
    let missCount = 0;
    let lastNotOpen = null;
    const pollIntervalMs = Math.max(50, Number(config.pollIntervalMs || 100));
    const fallbackAfterMisses = Math.max(1, Number(config.fallbackAfterMisses || 3));
    const partialFallbackAfterMisses = Math.max(1, Number(config.partialFallbackAfterMisses || 1));
    const partialFallbackStart = dateTimeOn(runDate, config.partialFallbackStartTime || config.pollStartTime || "07:58:00");
    const staleStateTrigger = Math.max(1, Number(config.staleStateTrigger || 4));
    const primaryCampusHoldSeconds = Math.max(0, Number(config.primaryCampusHoldSeconds || 0));
    let primaryHoldUntilMs = 0;
    let loggedPrimaryHold = false;
    let loggedPartialFallbackGate = false;
    let lastPrimaryHoldActionLogAt = 0;
    const attemptSummary = (attempt) => ({
      ok: !!attempt.ok,
      reason: attempt.reason,
      openTime: attempt.openTime,
      closeTime: attempt.closeTime,
      buyFlag: attempt.buyFlag,
      refreshed: attempt.refreshed,
      dateToggled: attempt.dateToggled,
      refreshDetails: attempt.refreshDetails,
      siteCount: attempt.siteCount,
    });
    const handleSelectedSlot = async ({ candidate, campus, mode }) => {
      slot = candidate;
      if (options.dryRun) {
        result.success = true;
        result.dryRun = true;
        result.slot = slot;
        result.diagnostics = diagnostics;
        return "done";
      }
      let submitPayment = null;
      try {
        submitPayment = await submitAndMaybePay({ slot, noConfirmPayment, session, logger });
      } catch (error) {
        const message = error?.stack || error?.message || String(error);
        logger.step(`Submit/payment threw after slot selection; attempting page-state recovery. ${String(error?.message || error).slice(0, 300)}`);
        await sleep(1000);
        await ensureWebBridge(logger, config).catch((bridgeError) => {
          logger.step(`WebBridge recovery check failed: ${bridgeError?.message || bridgeError}`);
        });
        let recoveredPayment = null;
        let recoveryError = "";
        try {
          recoveredPayment = await evaluate(`(() => ({
            url: location.href,
            text: (document.body?.innerText || "").slice(0, 2000),
            clickedPay:false,
            clickedConfirmPayment:false,
            recoveryRead:true
          }))()`, session);
          if (String(recoveredPayment.url || "").includes("confirmPayment")) {
            logger.step("Recovered on confirmPayment page after WebBridge failure; retrying payment confirmation once.");
            recoveredPayment = await evaluate(confirmPaymentPageFunction({ noConfirmPayment, campus: slot.campus }), session);
          }
        } catch (recoverError) {
          recoveryError = recoverError?.stack || recoverError?.message || String(recoverError);
        }
        const outcome = paymentOutcome(recoveredPayment || { reason: message }, { noConfirmPayment, slot });
        result.success = outcome.success;
        result.failureReason = outcome.success ? "" : `${message}${recoveryError ? ` | recovery failed: ${recoveryError}` : ""}`;
        result.slot = slot;
        result.payment = recoveredPayment;
        result.finalUrl = outcome.url;
        result.finalText = outcome.text;
        result.diagnostics = diagnostics;
        return "done";
      }
      if (submitPayment.outcome.success) {
        result.success = true;
        result.failureReason = "";
        result.slot = slot;
        result.submit = submitPayment.submit;
        result.payment = submitPayment.payment;
        result.finalUrl = submitPayment.outcome.url;
        result.finalText = submitPayment.outcome.text;
        result.diagnostics = diagnostics;
        return "done";
      }
      if (isRetryableBookingFailure({ slot, submitPayment }) && Date.now() < pollUntil.getTime()) {
        diagnostics.push({
          campus,
          mode,
          retryableSubmitFailure: true,
          slot,
          submit: submitPayment.submit,
          payment: submitPayment.payment,
          reason: submitPayment.outcome.reason,
        });
        logger.step(`Retryable submit/payment failure campus=${campus} mode=${mode}; returning to slot polling. reason=${String(submitPayment.outcome.reason || "").slice(0, 300)}`);
        slot = null;
        missCount += 1;
        const holdingPrimary = campusIndex === 0 && primaryHoldUntilMs > 0 && Date.now() < primaryHoldUntilMs;
        if (campuses.length > 1 && campusIndex === 0 && !holdingPrimary && missCount >= fallbackAfterMisses) {
          logger.step(`Primary campus had ${missCount} misses/retryable failures; switching to fallback campus=${campuses[1]}.`);
          campusIndex = 1;
          missCount = 0;
        }
        activeCampus = "";
        await sleep(pollIntervalMs);
        return "retry";
      }
      result.success = false;
      result.failureReason = submitPayment.outcome.reason;
      result.slot = slot;
      result.submit = submitPayment.submit;
      result.payment = submitPayment.payment;
      result.finalUrl = submitPayment.outcome.url;
      result.finalText = submitPayment.outcome.text;
      result.diagnostics = diagnostics;
      return "done";
    };
    while (!slot) {
      const campus = campuses[Math.min(campusIndex, campuses.length - 1)];
      if (campus !== activeCampus) {
        diagnostics.push({ campus, ready: await openVenue({ campus, config, targetDate, session, logger }) });
        await saveYdszSessionSnapshot({ config, session, logger }).catch((error) => {
          logger.step(`Could not save ydsz session snapshot after venue ready: ${error?.message || error}`);
        });
        activeCampus = campus;
      }
      const configured = await trySelectSlot({ campus, config, targetDate, session, allowAny: false });
      diagnostics.push({ campus, mode: "configured", ...attemptSummary(configured) });
      if (configured.ok) {
        const handled = await handleSelectedSlot({ candidate: configured, campus, mode: "configured" });
        if (handled === "done") return result;
        if (handled === "retry") continue;
      }
      const configuredOpenAtMs = configured.openTime ? dateTimeOn(runDate, configured.openTime).getTime() : NaN;
      const configuredBeforeOpen =
        configured.reason === "booking not open now" &&
        Number.isFinite(configuredOpenAtMs) &&
        Date.now() < configuredOpenAtMs;
      const partialFallbackEligible =
        !config.disablePartialFallback &&
        !configuredBeforeOpen &&
        Date.now() >= partialFallbackStart.getTime() &&
        (missCount + 1) >= partialFallbackAfterMisses;
      let any = {
        ok: false,
        reason: "partial fallback gated",
        gateUntil: partialFallbackStart.toISOString(),
        projectedMissCount: missCount + 1,
        partialFallbackAfterMisses,
        openTime: configured.openTime,
        closeTime: configured.closeTime,
        buyFlag: configured.buyFlag,
        siteCount: configured.siteCount,
      };
      let partialTried = false;
      if (partialFallbackEligible) {
        partialTried = true;
        any = await trySelectSlot({ campus, config, targetDate, session, allowAny: true });
        diagnostics.push({ campus, mode: "any", ...attemptSummary(any) });
        if (any.ok) {
          const handled = await handleSelectedSlot({ candidate: any, campus, mode: "any" });
          if (handled === "done") return result;
          if (handled === "retry") continue;
        }
      } else {
        if (!loggedPartialFallbackGate && configuredBeforeOpen) {
          loggedPartialFallbackGate = true;
          logger.step(`Partial fallback gated until booking opens at ${configured.openTime}; continuing primary full-slot polling first.`);
        } else if (!loggedPartialFallbackGate && Date.now() < partialFallbackStart.getTime()) {
          loggedPartialFallbackGate = true;
          logger.step(`Partial fallback gated until ${config.partialFallbackStartTime || config.pollStartTime || "07:58:00"}; continuing full-slot polling first.`);
        }
        diagnostics.push({ campus, mode: "any", skipped: true, ...attemptSummary(any) });
      }
      const stateAttempt = partialTried ? any : configured;
      if (stateAttempt.reason === "booking not open now") {
        lastNotOpen = stateAttempt;
        if (options.noWait) {
          throw new Error(`Booking page is outside active booking window: open=${stateAttempt.openTime} close=${stateAttempt.closeTime}`);
        }
        const openAt = stateAttempt.openTime ? dateTimeOn(runDate, stateAttempt.openTime).getTime() : NaN;
        const beforeOpen = Number.isFinite(openAt) && Date.now() < openAt;
        if (!beforeOpen) {
          missCount += 1;
          if (campusIndex === 0 && primaryCampusHoldSeconds > 0 && primaryHoldUntilMs <= 0) {
            const holdBaseMs = Number.isFinite(openAt) ? openAt : Date.now();
            primaryHoldUntilMs = holdBaseMs + (primaryCampusHoldSeconds * 1000);
          }
          const holdingPrimary = campusIndex === 0 && primaryHoldUntilMs > 0 && Date.now() < primaryHoldUntilMs;
          if (holdingPrimary && !loggedPrimaryHold) {
            logger.step(`Holding primary campus=${campus} until ${new Date(primaryHoldUntilMs).toISOString()} before fallback; current page still reports booking closed.`);
            loggedPrimaryHold = true;
          }
          if (holdingPrimary && Date.now() - lastPrimaryHoldActionLogAt >= 1000) {
            lastPrimaryHoldActionLogAt = Date.now();
            logger.step(`Primary hold active campus=${campus}; forcing refresh/date-toggle/re-entry loop. configured=${JSON.stringify(attemptSummary(configured)).slice(0, 400)} any=${JSON.stringify(attemptSummary(any)).slice(0, 400)}`);
          }
          if (campuses.length > 1 && campusIndex === 0 && !holdingPrimary && missCount >= fallbackAfterMisses) {
            logger.step(`Primary campus still reports booking closed after ${missCount} active-window polling attempts; switching to fallback campus=${campuses[1]}.`);
            campusIndex = 1;
            activeCampus = "";
            missCount = 0;
          } else if (missCount % staleStateTrigger === 0) {
            logger.step(`Venue state still reports booking closed after active window; refreshing campus=${campus}.`);
            activeCampus = "";
          }
        }
      } else {
        missCount += 1;
        const holdingPrimary = campusIndex === 0 && primaryHoldUntilMs > 0 && Date.now() < primaryHoldUntilMs;
        if (holdingPrimary && !loggedPrimaryHold) {
          logger.step(`Holding primary campus=${campus} until ${new Date(primaryHoldUntilMs).toISOString()} before fallback; reason=${configured.reason || any.reason}.`);
          loggedPrimaryHold = true;
        }
        if (holdingPrimary && Date.now() - lastPrimaryHoldActionLogAt >= 1000) {
          lastPrimaryHoldActionLogAt = Date.now();
          logger.step(`Primary hold active campus=${campus}; no selectable slot yet, rechecking primary before fallback. configured=${JSON.stringify(attemptSummary(configured)).slice(0, 400)} any=${JSON.stringify(attemptSummary(any)).slice(0, 400)}`);
        }
        if (campuses.length > 1 && campusIndex === 0 && !holdingPrimary && missCount >= fallbackAfterMisses) {
          logger.step(`Primary campus missed ${missCount} polling attempts; switching to fallback campus=${campuses[1]}.`);
          campusIndex = 1;
          activeCampus = "";
          missCount = 0;
        } else if (holdingPrimary && missCount % staleStateTrigger === 0) {
          logger.step(`Primary hold re-entering venue campus=${campus} after ${missCount} misses to avoid stale slot grid.`);
          activeCampus = "";
        }
      }
      if (options.noWait) {
        if (campusIndex < campuses.length - 1) {
          campusIndex += 1;
          activeCampus = "";
          continue;
        }
        break;
      }
      if (Date.now() >= pollUntil.getTime()) break;
      await sleep(pollIntervalMs);
    }
    if (!slot && lastNotOpen && Date.now() < pollUntil.getTime()) {
      throw new Error(`Booking page is outside active booking window: open=${lastNotOpen.openTime} close=${lastNotOpen.closeTime}`);
    }
    if (!slot) throw new Error(`No selectable slot. diagnostics=${JSON.stringify(diagnostics)}`);
    return result;
  } catch (error) {
    result.success = false;
    result.failureReason = error?.stack || error?.message || String(error);
    return result;
  } finally {
    result.log = logger.lines;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  const result = await runWebBridgeBooking({
    configPath: args.config || "config/local.json",
    runDate: args.runDate,
    targetDate: args.targetDate,
    noConfirmPayment: !!args.noConfirmPayment,
    dryRun: !!args.dryRun,
    noWait: !!args.noWait,
    preflight: !!args.preflight,
    noMail: !!args.noMail,
    forceCasWechat: !!args.forceCasWechat,
    session: args.session || "badminton-webbridge",
  });
  const config = await loadConfig(args.config || "config/local.json");
  if (args.noMail) config.mailOnCompletion = false;
  const paths = await writeResult({
    config,
    runDate: result.run.runDate,
    targetDate: result.run.targetDate,
    result,
    logger: { lines: result.log || [] },
    suffix: result.preflight ? "preflight" : "webbridge",
  });
  console.log(JSON.stringify({ ...result, ...paths }, null, 2));
  process.exit(result.success ? 0 : 1);
}
