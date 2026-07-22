import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveConfig } from "./config_resolver.mjs";

const execFileAsync = promisify(execFile);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");
const WEB_ROOT = path.join(PROJECT_ROOT, "web");
const DEFAULT_PORT = 8787;

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return parseJsonText(text);
}

function parseJsonText(text) {
  return JSON.parse(String(text || "").replace(/^\uFEFF/, ""));
}

function assertSafeValue(value, pattern, fieldName) {
  const text = String(value || "");
  if (!text) return "";
  if (!pattern.test(text)) throw new Error(`Invalid ${fieldName}: ${text}`);
  return text;
}

function buildInstallArgsFromBody(body = {}) {
  const args = ["-File", path.join(PROJECT_ROOT, "tools", "install-next-formal-run.ps1")];
  const addString = (flag, value, pattern, fieldName = flag) => {
    const text = assertSafeValue(value, pattern, fieldName);
    if (text) args.push(flag, text);
  };
  const addNumber = (flag, value, min, max, fieldName = flag) => {
    if (value === undefined || value === null || value === "") return;
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
      throw new Error(`Invalid ${fieldName}: ${value}`);
    }
    args.push(flag, String(number));
  };
  addString("-RunDate", body.runDate, /^\d{4}-\d{2}-\d{2}$/, "runDate");
  addString("-TargetDate", body.targetDate, /^\d{4}-\d{2}-\d{2}$/, "targetDate");
  addString("-PrimaryCampus", body.primaryCampus, /^(lxd|xlh)$/, "primaryCampus");
  addString("-FallbackCampus", body.fallbackCampus, /^(lxd|xlh|none|auto)$/, "fallbackCampus");
  addString("-DesiredStartTime", body.desiredStartTime, /^\d{2}:\d{2}$/, "desiredStartTime");
  addString("-DesiredEndTime", body.desiredEndTime, /^\d{2}:\d{2}$/, "desiredEndTime");
  addNumber("-MaxBookingMinutes", body.maxBookingMinutes, 60, 120, "maxBookingMinutes");
  addNumber("-MaxBookingAmount", body.maxBookingAmount, 1, 1000, "maxBookingAmount");
  addNumber("-PartialMinMinutes", body.partialMinMinutes, 60, 120, "partialMinMinutes");
  if (body.autoPay === false) args.push("-NoConfirmPayment");
  return args;
}

function extractLastJsonObject(text) {
  const input = String(text || "").trim();
  if (!input) return null;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    if (input[i] !== "{") continue;
    const candidate = input.slice(i);
    try {
      return parseJsonText(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function repairMojibake(text) {
  if (!text) return "";
  const value = String(text);
  try {
    const fixed = Buffer.from(value, "latin1").toString("utf8");
    if (/[\u4e00-\u9fff]/.test(fixed)) return fixed;
  } catch {
    return value;
  }
  return value;
}

function stampForFile(date = new Date()) {
  return date.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

function resolveProjectPath(value) {
  const text = String(value || "");
  if (!text) return "";
  return path.isAbsolute(text) ? text : path.join(PROJECT_ROOT, text);
}

function parseCheckLines(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    const match = /^(OK|FAIL)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) return { status: "INFO", name: "", ok: true, detail: repairMojibake(line), line };
    return {
      status: match[1],
      name: match[2],
      ok: match[1] === "OK",
      detail: repairMojibake(match[3] || ""),
      line,
    };
  });
}

function formatSelfCheckReport(report) {
  const failed = report.checks.filter((check) => !check.ok);
  const lines = [
    "羽毛球预约助手自检" + (report.ok ? "通过" : "失败"),
    "时间：" + report.completedAt,
    "项目：" + report.projectRoot,
    "检查项：" + report.passed + "/" + report.total + " 通过，" + report.failed + " 失败",
    "报告文件：" + report.resultPath,
  ];
  if (report.mail) lines.push("邮件：" + (report.mail.sent ? "已发送" : (report.mail.skipped ? "已关闭" : "发送失败")));
  if (failed.length) {
    lines.push("", "失败项：");
    for (const check of failed) lines.push("- " + check.name + (check.detail ? "：" + check.detail : ""));
  }
  lines.push("", "完整明细：");
  for (const check of report.checks) lines.push((check.status || "INFO") + " " + check.name + (check.detail ? " " + check.detail : ""));
  if (report.stderr) lines.push("", "错误输出：", repairMojibake(report.stderr));
  return lines.join("\r\n") + "\r\n";
}

function refreshSelfCheckCounts(report) {
  report.total = report.checks.length;
  report.failed = report.checks.filter((check) => !check.ok).length;
  report.passed = report.checks.filter((check) => check.ok && check.status !== "INFO").length;
  report.ok = report.failed === 0;
  return report;
}

async function runPowerShell(args, timeout = 120000) {
  try {
    const { stdout, stderr } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      ...args,
    ], {
      cwd: PROJECT_ROOT,
      timeout,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      ok: true,
      stdout: String(stdout || ""),
      stderr: String(stderr || ""),
      json: extractLastJsonObject(`${stdout || ""}\n${stderr || ""}`),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || error?.message || error),
      json: extractLastJsonObject(`${error?.stdout || ""}\n${error?.stderr || ""}`),
    };
  }
}

async function readFullConfig() {
  return resolveConfig({ configPath: path.join(PROJECT_ROOT, "config", "local.json") });
}

function summarizeConfig(config, source = "") {
  return {
    taskName: config.taskName,
    primaryCampus: config.primaryCampus,
    fallbackCampus: config.fallbackCampus,
    desiredStartTime: config.desiredStartTime,
    desiredEndTime: config.desiredEndTime,
    maxBookingMinutes: config.maxBookingMinutes,
    maxBookingAmount: config.maxBookingAmount,
    partialMinMinutes: config.partialMinMinutes,
    pollStartTime: config.pollStartTime,
    pollUntilTime: config.pollUntilTime,
    pollIntervalMs: config.pollIntervalMs,
    browserMode: config.browserMode,
    openVpn: !!config.openVpn,
    mailOnCompletion: !!config.mailOnCompletion,
    paymentAutoConfirm: !!config.paymentAutoConfirm,
    source,
  };
}

async function readConfigSummary() {
  return summarizeConfig(await readFullConfig(), "base");
}

async function sendSelfCheckMail({ config, report, bodyPath, mailLogPath }) {
  if (!config.mailOnCompletion) {
    return { sent: false, skipped: true, reason: "mailOnCompletion=false", logPath: mailLogPath };
  }
  const result = await runPowerShell([
    "-File",
    path.join(PROJECT_ROOT, "scripts", "send_status_email.ps1"),
    "-Subject",
    `羽毛球抢场自检 ${report.ok ? "通过" : "失败"} ${report.completedAt.slice(0, 10)}`,
    "-BodyPath",
    bodyPath,
    "-To",
    String(config.mailTo || ""),
    "-From",
    String(config.mailFrom || ""),
    "-SmtpServer",
    String(config.smtpServer || ""),
    "-SmtpPort",
    String(config.smtpPort || ""),
    "-CredentialSecureStringPath",
    resolveProjectPath(config.smtpSecret),
  ], 120000);
  await fs.writeFile(mailLogPath, `${result.stdout || ""}${result.stderr || ""}`, "utf8");
  if (result.ok) {
    return {
      sent: true,
      logPath: mailLogPath,
      to: config.mailTo || "",
      subject: result.json?.subject || `羽毛球抢场自检 ${report.ok ? "通过" : "失败"}`,
    };
  }
  return {
    sent: false,
    logPath: mailLogPath,
    error: repairMojibake(result.stderr || result.stdout || "Mail send failed"),
  };
}

async function runSelfCheck() {
  const startedAt = new Date();
  const result = await runPowerShell(["-File", path.join(PROJECT_ROOT, "tools", "test-project.ps1")], 120000);
  const completedAt = new Date();
  const checks = parseCheckLines(result.stdout);
  if (!result.ok && checks.every((check) => check.ok)) {
    checks.push({
      status: "FAIL",
      name: "self-check:runner",
      ok: false,
      detail: repairMojibake(result.stderr || "self-check command failed"),
      line: "",
    });
  }
  const report = {
    ok: false,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    projectRoot: PROJECT_ROOT,
    total: 0,
    passed: 0,
    failed: 0,
    checks,
    stdout: repairMojibake(result.stdout || ""),
    stderr: repairMojibake(result.stderr || ""),
    resultPath: "",
    logPath: "",
    mailLogPath: "",
    mail: null,
  };

  const logDir = path.join(PROJECT_ROOT, "logs");
  await fs.mkdir(logDir, { recursive: true });
  const prefix = path.join(logDir, `self_check_${stampForFile(completedAt)}`);
  report.resultPath = `${prefix}.result.json`;
  report.logPath = `${prefix}.log`;
  report.mailLogPath = `${prefix}.mail.log`;
  refreshSelfCheckCounts(report);
  await fs.writeFile(report.logPath, formatSelfCheckReport(report), "utf8");

  const config = await readFullConfig();
  report.mail = await sendSelfCheckMail({
    config,
    report,
    bodyPath: report.logPath,
    mailLogPath: report.mailLogPath,
  });
  report.checks.push({
    status: report.mail.sent ? "OK" : (report.mail.skipped ? "INFO" : "FAIL"),
    name: "mail:self-check",
    ok: !!report.mail.sent || !!report.mail.skipped,
    detail: report.mail.sent ? "sent" : (report.mail.error || report.mail.reason || "not sent"),
    line: "",
  });
  refreshSelfCheckCounts(report);
  await fs.writeFile(report.logPath, formatSelfCheckReport(report), "utf8");
  await fs.writeFile(report.resultPath, JSON.stringify(report, null, 2), "utf8");
  return report;
}

async function readLatestSelfCheck() {
  const logDir = path.join(PROJECT_ROOT, "logs");
  let files = [];
  try {
    files = await fs.readdir(logDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const file of files) {
    if (!file.isFile() || !file.name.startsWith("self_check_") || !file.name.endsWith(".result.json")) continue;
    const fullPath = path.join(logDir, file.name);
    const stat = await fs.stat(fullPath);
    candidates.push({ fullPath, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!candidates[0]) return null;
  try {
    return parseJsonText(await fs.readFile(candidates[0].fullPath, "utf8"));
  } catch {
    return null;
  }
}

async function readTaskStatus() {
  const command = [
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding = $OutputEncoding",
    "$tasks = @(Get-ScheduledTask -TaskName 'BadmintonBookingAssistant_*' -ErrorAction SilentlyContinue | Sort-Object TaskName)",
    "$rows = @($tasks | ForEach-Object {",
    "  $i = Get-ScheduledTaskInfo -TaskName $_.TaskName",
    "  $a = (($_.Actions | ForEach-Object { \"$($_.Execute) $($_.Arguments)\" }) -join ' ')",
    "  [pscustomobject]@{",
    "    taskName = $_.TaskName;",
    "    state = [string]$_.State;",
    "    nextRunTime = $(if ($i.NextRunTime) { $i.NextRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' });",
    "    lastRunTime = $(if ($i.LastRunTime) { $i.LastRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' });",
    "    lastTaskResult = [int]$i.LastTaskResult;",
    "    action = $a",
    "  }",
    "})",
    "$rows | ConvertTo-Json -Depth 8",
  ].join("\n");
  const result = await runPowerShell(["-Command", command], 30000);
  if (!result.ok) return { ok: false, rows: [], error: result.stderr || result.stdout };
  const raw = String(result.stdout || "").trim();
  if (!raw) return { ok: true, rows: [] };
  const parsed = parseJsonText(raw);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  let installedConfig = null;
  for (const row of rows) {
    if (row?.action) {
      const action = String(row.action);
      if (!installedConfig && action.includes("run-booking.ps1") && !action.includes("-Preflight")) {
        const quoted = /-ConfigJsonBase64\s+"([^"]+)"/.exec(action);
        const plain = /-ConfigJsonBase64\s+(\S+)/.exec(action);
        const value = quoted?.[1] || plain?.[1] || "";
        if (value) {
          try {
            installedConfig = summarizeConfig(parseJsonText(Buffer.from(value, "base64").toString("utf8")), "installed-task");
          } catch {
            installedConfig = null;
          }
        }
      }
      delete row.action;
    }
  }
  return { ok: true, rows, installedConfig };
}

async function readLatestResult() {
  const logDir = path.join(PROJECT_ROOT, "logs");
  let files = [];
  try {
    files = await fs.readdir(logDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".result.json") || !file.name.startsWith("booking_")) continue;
    const fullPath = path.join(logDir, file.name);
    const stat = await fs.stat(fullPath);
    candidates.push({ fullPath, name: file.name, mtimeMs: stat.mtimeMs, mtime: stat.mtime.toISOString() });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = candidates[0];
  if (!latest) return null;
  try {
    const json = parseJsonText(await fs.readFile(latest.fullPath, "utf8"));
    const slot = json.slot || {};
    return {
      name: latest.name,
      mtime: latest.mtime,
      success: !!json.success,
      failureReason: repairMojibake(json.failureReason || ""),
      slot: {
        campus: slot.campus || "",
        court: repairMojibake(slot.court || ""),
        targetDate: slot.targetDate || "",
        start: slot.start || "",
        end: slot.end || "",
        times: slot.times || [],
        money: slot.money ?? slot.total ?? "",
        durationMinutes: slot.durationMinutes || "",
        fallbackMode: slot.fallbackMode || "",
      },
    };
  } catch (error) {
    return { name: latest.name, mtime: latest.mtime, success: false, failureReason: String(error?.message || error) };
  }
}

function summarizeSelfCheck(report) {
  if (!report) return null;
  return {
    ok: !!report.ok,
    startedAt: report.startedAt || "",
    completedAt: report.completedAt || "",
    total: Number(report.total || 0),
    passed: Number(report.passed || 0),
    failed: Number(report.failed || 0),
    checks: Array.isArray(report.checks) ? report.checks.map(({ status, name, ok }) => ({ status, name, ok: !!ok })) : [],
  };
}

async function dashboard() {
  const [config, tasks, latestResult, latestSelfCheck] = await Promise.all([
    readConfigSummary(),
    readTaskStatus(),
    readLatestResult(),
    readLatestSelfCheck(),
  ]);
  const installedConfig = tasks.installedConfig || null;
  return {
    generatedAt: new Date().toISOString(),
    config,
    installedConfig,
    effectiveConfig: installedConfig || config,
    tasks,
    latestResult,
    latestSelfCheck: summarizeSelfCheck(latestSelfCheck),
  };
}

async function readRemoteUrl() {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: PROJECT_ROOT,
      timeout: 10000,
      windowsHide: true,
    });
    return String(stdout || "").trim();
  } catch {
    return "";
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const fullPath = path.resolve(WEB_ROOT, `.${pathname}`);
  if (!fullPath.startsWith(WEB_ROOT)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    const data = await fs.readFile(fullPath);
    sendText(res, 200, data, CONTENT_TYPES.get(path.extname(fullPath)) || "application/octet-stream");
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function handleApi(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    sendJson(res, 200, await dashboard());
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/self-check") {
    sendJson(res, 200, summarizeSelfCheck(await runSelfCheck()));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/assert-profile") {
    const result = await runPowerShell(["-File", path.join(PROJECT_ROOT, "tools", "assert-success-profile.ps1"), "-CheckTasks"], 120000);
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/plan-next") {
    const body = await readRequestJson(req);
    const args = buildInstallArgsFromBody(body);
    args.push("-InstallSource", "frontend-preview");
    args.push("-PlanOnly");
    const result = await runPowerShell(args, 120000);
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/install-next") {
    const body = await readRequestJson(req);
    const args = buildInstallArgsFromBody(body);
    args.push("-InstallSource", "frontend");
    const result = await runPowerShell(args, 180000);
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }
  sendJson(res, 404, { ok: false, error: "Unknown API route" });
}

const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const port = Number(portArg?.split("=")[1] || process.env.PORT || DEFAULT_PORT);

const server = http.createServer(async (req, res) => {
  try {
    if ((req.url || "").startsWith("/api/")) await handleApi(req, res);
    else await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.stack || error?.message || error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Badminton dashboard running at http://127.0.0.1:${port}/`);
});
