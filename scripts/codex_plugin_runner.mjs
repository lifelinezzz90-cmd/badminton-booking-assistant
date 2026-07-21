import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LOGIN_URL,
  VENUES,
  buildRunKey,
  campusOrder,
  confirmPaymentPageFunction,
  courtPriority,
  paymentOutcome,
  selectSlotPageFunction,
  submitBookingPageFunction,
  validateConfig,
  venueStatePageFunction,
} from "./booking_logic.mjs";
import { resolveConfig } from "./config_resolver.mjs";

const execFileAsync = promisify(execFile);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");

const CODEX_HOME = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");
const CODEX_PLUGIN_CACHE_ROOT =
  process.env.CODEX_PLUGIN_CACHE_ROOT || path.join(CODEX_HOME, "plugins", "cache");
const EASYCONNECT_APP_PATTERN = /EasyConnect|Sangfor|SSLVPN|\u542f\u52a8EasyConnect/i;

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

function parseJsonText(text) {
  return JSON.parse(String(text || "").replace(/^\uFEFF/, ""));
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

function isBeforeToday(dateText) {
  return new Date(`${dateText}T00:00:00`).getTime() < new Date(`${localDateText()}T00:00:00`).getTime();
}

function applyRuntimeDefaults(config) {
  config.easyConnectAppPattern ||= EASYCONNECT_APP_PATTERN.source;
  config.vpnLaunchMode ||= "explorer_shortcut";
  config.vpnPostLaunchWaitSeconds ||= 120;
  return config;
}

export async function loadConfig(configPath = "config/local.json") {
  const fullPath = resolveProjectPath(configPath);
  const config = applyRuntimeDefaults(await resolveConfig({ configPath: fullPath }));
  validateConfig(config);
  return { config, configPath: fullPath };
}

export async function setupCodexPluginRuntime({ sessionName = "badminton booking" } = {}) {
  if (!globalThis.agent) {
    const browserClient = await findPluginClient({ pluginName: "chrome", clientFile: "browser-client.mjs" });
    const { setupBrowserRuntime } = await import(pathToFileURL(browserClient).href);
    await setupBrowserRuntime({ globals: globalThis });
  }
  const browser = await globalThis.agent.browsers.get("extension");
  await browser.nameSession(`badminton ${sessionName}`);

  if (!globalThis.sky) {
    try {
      const computerUseClient = await findPluginClient({ pluginName: "computer-use", clientFile: "computer-use-client.mjs" });
      const { setupComputerUseRuntime } = await import(pathToFileURL(computerUseClient).href);
      await setupComputerUseRuntime({ globals: globalThis });
      globalThis.__computerUseSetupError = "";
    } catch (error) {
      globalThis.__computerUseSetupError = error?.message || String(error);
    }
  }

  return { browser, sky: globalThis.sky || null, computerUseSetupError: globalThis.__computerUseSetupError || "" };
}

export class BookingLogger {
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

function stringifyResult(value) {
  return `${JSON.stringify(value, (_key, item) => (
    typeof item === "string" ? jsonSafeString(item) : item
  ), 2)}\n`;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findPluginClient({ pluginName, clientFile }) {
  const roots = [
    path.join(CODEX_PLUGIN_CACHE_ROOT, "openai-bundled", pluginName),
    path.join(CODEX_PLUGIN_CACHE_ROOT, "openai-curated", pluginName),
    path.join(CODEX_PLUGIN_CACHE_ROOT, "openai-primary-runtime", pluginName),
  ];
  const matches = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name === clientFile) {
        matches.push(fullPath);
      }
    }
  }

  for (const root of roots) await walk(root);
  matches.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  if (!matches.length) {
    throw new Error(
      `Required Codex plugin client not found: plugin=${pluginName} file=${clientFile} under ${CODEX_PLUGIN_CACHE_ROOT}`,
    );
  }
  return matches[0].replace(/\\/g, "/");
}

async function evaluate(tab, code, timeoutMs = 60000) {
  return await tab.playwright.evaluate(code, undefined, { timeoutMs });
}

async function waitUntil(fn, { timeoutMs, intervalMs = 500, timeoutMessage }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(timeoutMessage || `Timed out after ${timeoutMs}ms`);
}

async function getOrCreateTab(browser) {
  try {
    const selected = await browser.tabs.selected();
    if (selected) return selected;
  } catch {}
  return await browser.tabs.new();
}

async function runPowerShell({ script, args = [], timeout = 30000 }) {
  const quoteArg = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const wrappedScript = `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
& {
${script}
}${args.length ? ` ${args.map(quoteArg).join(" ")}` : ""}`;
  const encodedCommand = Buffer.from(wrappedScript, "utf16le").toString("base64");
  return await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedCommand,
  ], {
    cwd: PROJECT_ROOT,
    timeout,
    windowsHide: true,
  });
}

async function runPowerShellJson({ script, args = [], timeout = 30000 }) {
  const { stdout } = await runPowerShell({ script, args, timeout });
  const text = String(stdout || "").trim();
  if (!text) return {};
  try {
    return parseJsonText(text);
  } catch (error) {
    throw new Error(`PowerShell returned non-JSON output: ${text.slice(0, 500)}`);
  }
}

async function getEasyConnectProcessState() {
  return await runPowerShellJson({
    script: `
$easyConnect = @(Get-Process -Name "EasyConnect" -ErrorAction SilentlyContinue)
$sangfor = @(Get-Process -Name "ECAgent","SangforCSClient","SangforCSService" -ErrorAction SilentlyContinue)
$names = @($easyConnect + $sangfor | Select-Object -ExpandProperty ProcessName -Unique)
[pscustomobject]@{
  easyConnectRunning = ($easyConnect.Count -gt 0)
  easyConnectCount = $easyConnect.Count
  helperProcessNames = @($names)
} | ConvertTo-Json -Compress
`,
  });
}

async function probeVpnReachability(config) {
  const probeUrl = String(config.vpnProbeUrl || "https://ydsz.szpu.edu.cn/easyserp/index.html");
  return await runPowerShellJson({
    script: `
param([string]$ProbeUrl)
$ProgressPreference = "SilentlyContinue"
try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri $ProbeUrl -TimeoutSec 8
  [pscustomobject]@{
    ok = $true
    status = [int]$response.StatusCode
    final = $response.BaseResponse.ResponseUri.AbsoluteUri
  } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{
    ok = $false
    error = $_.Exception.Message
  } | ConvertTo-Json -Compress
}
`,
    args: [probeUrl],
    timeout: 15000,
  });
}

async function waitForVpnReachable({ config, logger }) {
  const timeoutMs = Number(config.vpnReadyTimeoutSeconds || 45) * 1000;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probeVpnReachability(config);
    if (last?.ok) {
      logger.step(`VPN business probe reachable: status=${last.status} url=${last.final || ""}`);
      return last;
    }
    await sleep(3000);
  }
  throw new Error(`VPN_NOT_CONNECTED: EasyConnect process/startup check completed, but business probe is unreachable. last=${JSON.stringify(last)}`);
}

async function readDpapiSecret(secretPath) {
  if (!secretPath) return "";
  const fullPath = resolveProjectPath(secretPath);
  if (!(await exists(fullPath))) return "";
  const { stdout } = await runPowerShell({
    script: `
param([string]$SecretPath)
$ErrorActionPreference = "Stop"
$raw = (Get-Content -LiteralPath $SecretPath -Raw).Trim().TrimStart([char]0xfeff)
$secure = $raw | ConvertTo-SecureString
$credential = [System.Management.Automation.PSCredential]::new("codex", $secure)
[Console]::Out.Write($credential.GetNetworkCredential().Password)
`,
    args: [fullPath],
    timeout: 30000,
  });
  return String(stdout || "");
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
    logger.step(`CAS DPAPI secret could not be read; relying on existing browser session. ${error?.message || error}`);
  }
  return "";
}

async function resolveEasyConnectShortcut(candidatePath) {
  return await runPowerShellJson({
    script: `
param([string]$CandidatePath)
$ErrorActionPreference = "Stop"
function Get-EasyConnectShortcut {
  param([string]$Path)
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    if ([System.IO.Path]::GetFileName($shortcut.TargetPath) -ieq "EasyConnect.exe") {
      return [pscustomobject]@{ ok = $true; path = $Path; target = $shortcut.TargetPath }
    }
  } catch {}
  return $null
}
$candidate = Get-EasyConnectShortcut -Path $CandidatePath
if ($candidate) {
  $candidate | ConvertTo-Json -Compress
  return
}
$roots = @(
  (Join-Path $env:ProgramData "Microsoft\\Windows\\Start Menu\\Programs"),
  (Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs")
)
foreach ($rootPath in $roots) {
  if (-not (Test-Path -LiteralPath $rootPath)) { continue }
  $shortcuts = Get-ChildItem -LiteralPath $rootPath -Recurse -Filter "*EasyConnect*.lnk" -ErrorAction SilentlyContinue
  foreach ($shortcutFile in $shortcuts) {
    $resolved = Get-EasyConnectShortcut -Path $shortcutFile.FullName
    if ($resolved) {
      $resolved | ConvertTo-Json -Compress
      return
    }
  }
}
[pscustomobject]@{ ok = $false; path = ""; target = ""; reason = "EasyConnect Start Menu shortcut not found" } | ConvertTo-Json -Compress
`,
    args: [candidatePath || ""],
  });
}

async function openEasyConnectViaExplorerShortcut({ config, logger }) {
  const resolved = await resolveEasyConnectShortcut(config.easyConnectShortcutPath || "");
  if (!resolved.ok || !resolved.path) {
    throw new Error("EasyConnect shortcut not found; refusing direct executable/app-id EasyConnect launch to avoid VPN anomaly.");
  }

  logger.step(`Opening EasyConnect once via Start Menu shortcut; direct executable launch is avoided. shortcut=${resolved.path}`);
  await runPowerShell({
    script: `
param([string]$ShortcutPath)
if (-not (Test-Path -LiteralPath $ShortcutPath)) {
  throw "EasyConnect shortcut not found: $ShortcutPath"
}
Start-Process -FilePath "explorer.exe" -ArgumentList ('"{0}"' -f $ShortcutPath)
`,
    args: [resolved.path],
  });
}

async function ensureVpn({ config, logger }) {
  if (!config.openVpn) {
    logger.step("VPN untouched by config.");
    return;
  }
  const processState = await getEasyConnectProcessState();
  if (processState.easyConnectRunning) {
    logger.step("EasyConnect already running; leaving it untouched to avoid duplicate-launch anomaly.");
    logger.step(`Waiting ${config.vpnPostLaunchWaitSeconds} seconds after VPN check before opening CAS.`);
    await sleep(Number(config.vpnPostLaunchWaitSeconds || 10) * 1000);
    return;
  }

  if (String(config.vpnLaunchMode || "manual_only") === "manual_only") {
    throw new Error("EasyConnect is not running. vpnLaunchMode=manual_only, so the runner will not start VPN automatically; start VPN manually and rerun.");
  }

  const launchMode = String(config.vpnLaunchMode || "");
  if (launchMode === "explorer_shortcut" || launchMode === "shortcut_shell") {
    await openEasyConnectViaExplorerShortcut({ config, logger });
    logger.step(`Waiting ${config.vpnPostLaunchWaitSeconds} seconds after VPN start/check before opening CAS.`);
    await sleep(Number(config.vpnPostLaunchWaitSeconds || 10) * 1000);
    const refreshedState = await getEasyConnectProcessState();
    if (!refreshedState.easyConnectRunning) {
      throw new Error("EasyConnect Start Menu shortcut was opened, but EasyConnect.exe was not detected afterward.");
    }
    return;
  }

  throw new Error(`Unsupported vpnLaunchMode=${launchMode}; direct executable/app-id EasyConnect launch is disabled to avoid VPN anomaly.`);
}

async function ensureLogin({ tab, config, password, logger }) {
  const loginStateScript = `(() => {
    const storage = typeof sessionStorage !== "undefined" ? sessionStorage : null;
    const text = (document.body?.innerText || "").slice(0, 1000);
    const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const username = document.querySelector("#username");
    const password = document.querySelector("#password,input[type=password]");
    return {
      url: location.href,
      hasUsername: visible(username),
      hasPassword: visible(password),
      token: storage ? storage.getItem("token") || "" : "",
      text,
      appReady: location.href.includes("ydsz.szpu.edu.cn/easyserp") &&
        !document.querySelector("#username") &&
        /\\u9996\\u9875|\\u9884\\u7ea6|\\u6211\\u7684|\\u67e5\\u770b\\u5176\\u4ed6\\u56ed\\u533a/.test(text),
    };
  })()`;

  logger.step("Probing ydsz app for an existing browser session.");
  await tab.goto("https://ydsz.szpu.edu.cn/easyserp/index.html#/index");
  try {
    const existing = await waitUntil(async () => {
      const state = await evaluate(tab, loginStateScript, 10000);
      return state.url.includes("ydsz.szpu.edu.cn") && (state.token || state.appReady) ? state : null;
    }, {
      timeoutMs: 15000,
      intervalMs: 500,
      timeoutMessage: "Existing ydsz session probe timed out.",
    });
    if (existing) {
      logger.step("Existing ydsz session is ready.");
      return;
    }
  } catch {
    logger.step("Existing ydsz session not ready; opening CAS entry.");
  }

  await tab.goto(LOGIN_URL);
  await waitUntil(async () => {
    return await evaluate(tab, loginStateScript, 10000);
  }, {
    timeoutMs: Number(config.pageWaitSeconds || 120) * 1000,
    timeoutMessage: "Login page did not become ready.",
  });

  const state = await evaluate(tab, loginStateScript);
  if (state.url.includes("ydsz.szpu.edu.cn") && (state.token || state.appReady)) {
    logger.step("Existing ydsz session is ready.");
    return;
  }
  if (!state.hasUsername || !state.hasPassword) {
    logger.step("No username form found; waiting for existing browser session to reach ydsz.");
    await waitUntil(async () => {
      const s = await evaluate(tab, loginStateScript, 10000);
      return s.url.includes("ydsz.szpu.edu.cn") && (s.token || s.appReady) ? s : null;
    }, {
      timeoutMs: Number(config.pageWaitSeconds || 120) * 1000,
      timeoutMessage: "Existing browser session did not reach ydsz.",
    });
    return;
  }
  if (!password) {
    throw new Error("CAS login form is visible, but no password was supplied. Log in once in Chrome or pass a password from a secure Codex prompt.");
  }

  logger.step("Submitting CAS login.");
  await tab.playwright.locator("#username").fill(String(config.username), { timeoutMs: 10000 });
  await tab.playwright.locator("#password").fill(password, { timeoutMs: 10000 });
  await evaluate(tab, `
(() => {
  document.cookie = "popYhxy=true; path=/; max-age=2592000";
  const checkbox = document.querySelector("#agreeDeal,input[type=checkbox]");
  if (checkbox) {
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles:true }));
  }
  const norm = (el) => (el.innerText || el.textContent || "").replace(/\\s+/g, "");
  const agree = [...document.querySelectorAll("button,a,div,span,label")].find((el) => norm(el).includes("\\u540c\\u610f\\u672c\\u5185\\u5bb9"));
  if (agree) agree.click();
  document.querySelectorAll("#szpuYhxy,.ways-zzc,.modal,.el-dialog__wrapper").forEach((el) => { el.style.display = "none"; });
  const submit = document.querySelector("#login_submit,button[type=submit],input[type=submit]");
  if (submit) submit.click();
  return { clicked: !!submit, agreed: !!agree };
})()
`);
  await waitUntil(async () => {
    const s = await evaluate(tab, loginStateScript, 10000);
    return s.url.includes("ydsz.szpu.edu.cn") ? s : null;
  }, {
    timeoutMs: Number(config.pageWaitSeconds || 120) * 1000,
    timeoutMessage: "Login did not reach ydsz.",
  });
}

async function openVenue({ browser, campus, logger }) {
  const venue = VENUES[campus];
  if (!venue) throw new Error(`Unknown campus: ${campus}`);
  const tab = await browser.tabs.new();
  logger.step(`Opening venue campus=${campus} through initialized app route.`);
  await tab.goto("https://ydsz.szpu.edu.cn/easyserp/index.html#/index");
  await waitUntil(async () => {
    const state = await evaluate(tab, `(() => {
      const text = (document.body?.innerText || "").slice(0, 1000);
      return {
        url: location.href,
        ready: location.href.includes("ydsz.szpu.edu.cn/easyserp") &&
          /\\u9996\\u9875|\\u9884\\u7ea6|\\u6211\\u7684|\\u67e5\\u770b\\u5176\\u4ed6\\u56ed\\u533a/.test(text)
      };
    })()`, 10000);
    return state.ready ? state : null;
  }, {
    timeoutMs: 30000,
    intervalMs: 250,
    timeoutMessage: `ydsz app shell did not initialize before opening ${campus}.`,
  });
  await evaluate(tab, `(() => {
    const storage = typeof sessionStorage !== "undefined" ? sessionStorage : null;
    if (storage) storage.setItem("shopNum", ${JSON.stringify(venue.shopNum)});
    return { shopNum: storage ? storage.getItem("shopNum") || "" : "", url: location.href };
  })()`);
  await tab.goto(venue.url);
  return tab;
}

async function waitVenueReady({ tab, campus, logger, timeoutMs = 180000 }) {
  return await waitUntil(async () => {
    const state = await evaluate(tab, venueStatePageFunction, 15000);
    const ready = String(state.url || "").includes("/siteList") && Number(state.siteCount || -1) > 0;
    if (ready) {
      logger.step(`Venue ready campus=${campus} siteCount=${state.siteCount} shopNum=${state.shopNum}.`);
      return state;
    }
    return null;
  }, {
    timeoutMs,
    intervalMs: 750,
    timeoutMessage: `Venue calendar did not become ready for ${campus}.`,
  });
}

function nextDateTime(dateText, timeText) {
  return new Date(`${dateText}T${timeText}`);
}

function assertRunWindowOpen({ config, runDate }) {
  const pollUntil = nextDateTime(runDate, config.pollUntilTime);
  const now = new Date();
  if (now.getTime() > pollUntil.getTime()) {
    throw new Error(
      `Refusing stale run: now=${now.toISOString()} is after runDate=${runDate} pollUntil=${pollUntil.toISOString()}.`,
    );
  }
  return { now, pollUntil };
}

async function waitForPollStart({ runDate, config, logger }) {
  const pollStart = nextDateTime(runDate, config.pollStartTime);
  while (Date.now() < pollStart.getTime()) {
    const seconds = Math.ceil((pollStart.getTime() - Date.now()) / 1000);
    if (seconds % 30 === 0 || seconds < 10) logger.step(`Waiting for poll start: ${seconds}s.`);
    await sleep(Math.min(1000, Math.max(100, pollStart.getTime() - Date.now())));
  }
}

async function trySelect({ tab, campus, config, targetDate, selectionMode }) {
  const code = selectSlotPageFunction({
    campus,
    targetDate,
    desiredStartTime: config.desiredStartTime,
    desiredEndTime: config.desiredEndTime,
    partialMinMinutes: Number(config.partialMinMinutes || 60),
    maxSlots: Math.floor(Number(config.maxBookingMinutes || 0) / 30) || 0,
    maxAmount: Number(config.maxBookingAmount || 0),
    courtPriority: courtPriority(config, campus),
    selectionMode,
    refreshDelayMs: Number(config.fastRefreshDelayMs || 60),
    refreshTimeoutMs: Number(config.fastRefreshTimeoutMs || 900),
    selectDelayMs: Number(config.fastSelectDelayMs || 25),
  });
  const result = await evaluate(tab, code, 60000);
  if (result?.domClickFallback && Array.isArray(result.domCellIndices) && result.domCellIndices.length > 0) {
    return await trustedDomClickSelection({ tab, result, config });
  }
  return result;
}

async function trustedDomClickSelection({ tab, result, config }) {
  const selector = result.domSelector || ".sitecontentWrap li, .sitecontent li";
  const delayMs = Math.max(0, Number(config.fastSelectDelayMs || 25));
  try {
    const locator = tab.playwright.locator(selector);
    for (const index of result.domCellIndices) {
      await locator.nth(Number(index)).click({ force: true, timeoutMs: 1500 });
      if (delayMs) await sleep(delayMs);
    }
    const verify = await evaluate(tab, `(() => {
      const selectedText = (document.querySelector(".selected")?.innerText || "").replace(/\\s+/g, " ").trim();
      const totalText = [...document.querySelectorAll("p,div,span")]
        .map((el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim())
        .find((text) => /共计/.test(text)) || "";
      const selectedCells = [...document.querySelectorAll(".sitecontentWrap li, .sitecontent li")]
        .filter((el) => /colorThree|selected|active/.test(String(el.className || ""))).length;
      return {
        ok:/共计[:：]\\s*(?!0(?:\\.00)?\\s*豆)/.test(totalText) || selectedCells >= ${Number(result.domCellIndices.length)},
        selectedText,
        totalText,
        selectedCells,
      };
    })()`, 10000);
    if (!verify.ok) {
      return { ...result, reason: "trusted DOM click selection rejected", verify };
    }
    return {
      ok: true,
      ...(result.candidate || {}),
      sourceMode: "dom-trusted-click",
      trustedClick: true,
      verify,
      refreshDetails: result.refreshDetails || [],
    };
  } catch (error) {
    return { ...result, reason: `trusted DOM click failed: ${error?.message || error}` };
  }
}

async function selectSlotDuringWindow({ tabsByCampus, config, runDate, targetDate, logger }) {
  const pollUntil = nextDateTime(runDate, config.pollUntilTime);
  const partialFallbackStart = nextDateTime(runDate, config.partialFallbackStartTime || config.pollStartTime || "07:58:00");
  const partialFallbackAfterMisses = Number(config.partialFallbackAfterMisses || 1);
  const campuses = campusOrder(config);
  let misses = 0;
  while (Date.now() < pollUntil.getTime()) {
    for (const campus of campuses) {
      const slot = await trySelect({ tab: tabsByCampus.get(campus), campus, config, targetDate, selectionMode: "full" });
      if (slot.ok) {
        logger.step(`Selected full slot campus=${campus} court=${slot.court} ${slot.start}-${slot.end}.`);
        return slot;
      }
      misses += 1;
      if (Date.now() >= partialFallbackStart.getTime() && misses >= partialFallbackAfterMisses && !config.disablePartialFallback) {
        const partial = await trySelect({ tab: tabsByCampus.get(campus), campus, config, targetDate, selectionMode: "partial" });
        if (partial.ok) {
          logger.step(`Selected partial slot campus=${campus} court=${partial.court} ${partial.start}-${partial.end}.`);
          return partial;
        }
      }
    }
    await sleep(Number(config.pollIntervalMs || 300));
  }
  throw new Error(`No available slot selected before ${config.pollUntilTime}.`);
}

async function submitAndPay({ tab, config, slot, noConfirmPayment, logger }) {
  logger.step("Submitting selected slot.");
  const submit = await evaluate(tab, submitBookingPageFunction, 90000);
  logger.step(`Submit state: ${JSON.stringify({ clickedSubmit: submit.clickedSubmit, url: submit.url })}`);

  await waitUntil(async () => {
    const state = await evaluate(tab, `(() => ({ url: location.href, text: (document.body.innerText || "").slice(0, 1000) }))()`, 10000);
    return state.url.includes("confirmPayment") ? state : null;
  }, {
    timeoutMs: Number(config.pageWaitSeconds || 120) * 1000,
    timeoutMessage: "Payment page did not open.",
  });

  const payment = await evaluate(tab, confirmPaymentPageFunction({ noConfirmPayment, campus: slot.campus }), 120000);
  return paymentOutcome(payment, { noConfirmPayment, slot });
}

async function nextRunPrefix({ config, runDate, targetDate }) {
  const logDir = path.join(PROJECT_ROOT, "logs");
  await fs.mkdir(logDir, { recursive: true });
  const runKey = buildRunKey({ config, runDate, targetDate });
  let prefix = path.join(logDir, runKey);
  if (await exists(`${prefix}.result.json`) || await exists(`${prefix}.log`)) {
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    prefix = path.join(logDir, `${runKey}_rerun_${stamp}`);
  }
  return prefix;
}

async function sendResultMail({ config, resultPath, logPath, mailLogPath }) {
  const smtpSecret = resolveProjectPath(config.smtpSecret);
  const mailScript = path.join(PROJECT_ROOT, "scripts", "send_booking_result_email.ps1");
  const args = [
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
  ];
  try {
    const { stdout, stderr } = await execFileAsync("powershell.exe", args, {
      cwd: PROJECT_ROOT,
      timeout: 120000,
      windowsHide: true,
    });
    await fs.writeFile(mailLogPath, `${stdout || ""}${stderr || ""}`, "utf8");
    return { sent: true, logPath: mailLogPath };
  } catch (error) {
    const message = `Mail send failed: ${error.message || error}\n${error.stdout || ""}\n${error.stderr || ""}`;
    await fs.writeFile(mailLogPath, message, "utf8");
    return { sent: false, logPath: mailLogPath, error: message };
  }
}

async function finalizeRunResult({ config, runDate, targetDate, result, logger }) {
  const prefix = await nextRunPrefix({ config, runDate, targetDate });
  const logPath = `${prefix}.log`;
  const errPath = `${prefix}.err.log`;
  const resultPath = `${prefix}.result.json`;
  const mailLogPath = `${prefix}.mail.log`;
  const logLines = result.log || logger?.lines || [];
  const logText = logLines.length ? `${logLines.join("\n")}\n` : `${result.failureReason || "No log lines captured."}\n`;

  result.logPath = logPath;
  result.errPath = result.success ? "" : errPath;
  result.resultPath = resultPath;
  try {
    await fs.writeFile(logPath, logText, "utf8");
    if (!result.success) {
      await fs.writeFile(errPath, `${result.failureReason || "Unknown failure"}\n`, "utf8");
    }
    await fs.writeFile(resultPath, stringifyResult(result), "utf8");

    if (config.mailOnCompletion && !isBeforeToday(runDate)) {
      result.mail = await sendResultMail({ config, resultPath, logPath, mailLogPath });
      await fs.writeFile(resultPath, stringifyResult(result), "utf8");
    } else if (config.mailOnCompletion) {
      result.mail = {
        sent: false,
        skipped: true,
        logPath: mailLogPath,
        reason: `Skipped mail for stale runDate=${runDate}; today=${localDateText()}.`,
      };
      await fs.writeFile(resultPath, stringifyResult(result), "utf8");
    }
  } catch (error) {
    result.logWriteError = error?.message || String(error);
    result.mail = {
      sent: false,
      logPath: mailLogPath,
      error: `Skipped local SMTP mail because result/log files could not be written: ${result.logWriteError}`,
    };
  }

  return result;
}

export async function runBookingWithPlugins({
  browser,
  sky,
  config,
  runDate,
  targetDate,
  password = "",
  noConfirmPayment = false,
  dryRun = false,
  logger = new BookingLogger(),
}) {
  applyRuntimeDefaults(config);
  validateConfig(config);
  const run = {
    runDate,
    targetDate,
    desiredStartTime: config.desiredStartTime,
    desiredEndTime: config.desiredEndTime,
    primaryCampus: config.primaryCampus,
    fallbackCampus: config.fallbackCampus,
  };
  assertRunWindowOpen({ config, runDate });

  await ensureVpn({ sky, config, logger });
  const loginPassword = await resolveLoginPassword({ config, password, logger });
  const loginTab = await getOrCreateTab(browser);
  await ensureLogin({ tab: loginTab, config, password: loginPassword, logger });

  const tabsByCampus = new Map();
  for (const campus of campusOrder(config)) {
    const tab = await openVenue({ browser, campus, logger });
    await waitVenueReady({ tab, campus, logger, timeoutMs: Number(config.pageWaitSeconds || 180) * 1000 });
    tabsByCampus.set(campus, tab);
  }

  await waitForPollStart({ runDate, config, logger });
  const slot = await selectSlotDuringWindow({ tabsByCampus, config, runDate, targetDate, logger });
  const selectedTab = tabsByCampus.get(slot.campus);

  if (dryRun) {
    return { success: true, dryRun: true, failureReason: "", run, slot, log: logger.lines };
  }
  const outcome = await submitAndPay({ tab: selectedTab, config, slot, noConfirmPayment, logger });
  return {
    success: !!outcome.success,
    failureReason: outcome.success ? "" : outcome.reason,
    run,
    slot,
    finalUrl: outcome.url,
    finalText: outcome.text,
    log: logger.lines,
  };
}

export async function runFromCodexGlobals(options = {}) {
  const {
    configPath = "config/local.json",
    runDate,
    targetDate,
    password = "",
    noConfirmPayment = false,
    dryRun = false,
  } = options;
  const logger = new BookingLogger();
  const { config } = await loadConfig(configPath);
  const resolvedRunDate = runDate || localDateText();
  const resolvedTargetDate = targetDate || addDays(resolvedRunDate, 1);
  try {
    assertRunWindowOpen({ config, runDate: resolvedRunDate });
    const runtime = await setupCodexPluginRuntime({ sessionName: resolvedTargetDate });
    const result = await runBookingWithPlugins({
      ...runtime,
      config,
      runDate: resolvedRunDate,
      targetDate: resolvedTargetDate,
      password,
      noConfirmPayment,
      dryRun,
      logger,
    });
    if (runtime.computerUseSetupError) {
      result.computerUseSetupError = runtime.computerUseSetupError;
    }
    return await finalizeRunResult({ config, runDate: resolvedRunDate, targetDate: resolvedTargetDate, result, logger });
  } catch (error) {
    const result = {
      success: false,
      failureReason: error?.stack || error?.message || String(error),
      run: {
        runDate: resolvedRunDate,
        targetDate: resolvedTargetDate,
        desiredStartTime: config.desiredStartTime,
        desiredEndTime: config.desiredEndTime,
        primaryCampus: config.primaryCampus,
        fallbackCampus: config.fallbackCampus,
      },
      log: logger.lines,
    };
    return await finalizeRunResult({ config, runDate: resolvedRunDate, targetDate: resolvedTargetDate, result, logger });
  }
}

export function runKeyFor(config, runDate, targetDate) {
  return buildRunKey({ config, runDate, targetDate });
}
