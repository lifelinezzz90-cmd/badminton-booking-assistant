import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");

const MAIL_PRESETS = Object.freeze({
  "163": { smtpServer: "smtp.163.com", smtpPort: 465 },
  qq: { smtpServer: "smtp.qq.com", smtpPort: 465 },
});

const PLAINTEXT_SECRET_KEYS = new Set([
  "password",
  "casPassword",
  "smtpPassword",
  "smtpAuthorizationCode",
  "authorizationCode",
  "apiKey",
  "token",
  "cookie",
]);

function parseJsonText(text, source = "JSON") {
  try {
    return JSON.parse(String(text || "").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error("Invalid " + source + ": " + error.message);
  }
}

async function readJson(filePath) {
  return parseJsonText(await fs.readFile(filePath, "utf8"), filePath);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, overlay) {
  const result = isPlainObject(base) ? clone(base) : {};
  if (!isPlainObject(overlay)) return result;
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(result[key])) result[key] = deepMerge(result[key], value);
    else result[key] = clone(value);
  }
  return result;
}

function assertNoPlaintextSecrets(value, prefix = "") {
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const field = prefix ? prefix + "." + key : key;
    if (PLAINTEXT_SECRET_KEYS.has(key) && child !== "" && child !== null && child !== undefined) {
      throw new Error("Plaintext secret field is not allowed: " + field + ". Store it with DPAPI instead.");
    }
    if (isPlainObject(child)) assertNoPlaintextSecrets(child, field);
  }
}

function expandEnvironmentPath(value, env = process.env) {
  return String(value || "").replace(/%([^%]+)%/g, (_match, name) => env[name] || env[name.toUpperCase()] || "");
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkShortcuts(root, pattern, depth = 0) {
  if (!root || depth > 8 || !(await exists(root))) return [];
  const matches = [];
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return matches;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) matches.push(...await walkShortcuts(fullPath, pattern, depth + 1));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".lnk") && pattern.test(entry.name)) matches.push(fullPath);
  }
  return matches;
}

export async function discoverVpnShortcut({ env = process.env } = {}) {
  const roots = [
    env.ProgramData && path.join(env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs"),
    env.APPDATA && path.join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
  ].filter(Boolean);
  const pattern = /EasyConnect|Sangfor|SSLVPN/i;
  for (const root of roots) {
    const matches = await walkShortcuts(root, pattern);
    if (matches.length) return matches.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  }
  return "";
}

function priorityToCsv(value, fallback) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean).join(",");
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean).join(",");
  return fallback;
}

function normalizeMail(local, effective) {
  if (!isPlainObject(local.mail)) return;
  const enabled = local.mail.enabled === true;
  effective.mailOnCompletion = enabled;
  if (!enabled) {
    effective.mailTo = "";
    effective.mailFrom = "";
    effective.smtpServer = "";
    return;
  }
  const provider = String(local.mail.provider || "custom").toLowerCase();
  const preset = MAIL_PRESETS[provider] || {};
  const address = String(local.mail.address || local.mail.from || "").trim();
  effective.mailTo = String(local.mail.to || address).trim();
  effective.mailFrom = String(local.mail.from || address).trim();
  effective.smtpServer = String(local.mail.smtpServer || preset.smtpServer || "").trim();
  effective.smtpPort = Number(local.mail.smtpPort || preset.smtpPort || 465);
  if (local.mail.secretPath) effective.smtpSecret = String(local.mail.secretPath);
}

function validateEffectiveConfig(config) {
  const campusValues = new Set(["lxd", "xlh"]);
  const fallbackValues = new Set(["lxd", "xlh", "none", "auto"]);
  if (!String(config.username || "").trim()) throw new Error("username is required");
  if (!campusValues.has(String(config.primaryCampus))) throw new Error("primaryCampus must be lxd or xlh");
  if (!fallbackValues.has(String(config.fallbackCampus))) throw new Error("fallbackCampus must be lxd, xlh, auto, or none");
  if (config.primaryCampus === config.fallbackCampus) throw new Error("fallbackCampus must differ from primaryCampus");
  for (const key of ["desiredStartTime", "desiredEndTime"]) {
    if (!/^\d{2}:\d{2}$/.test(String(config[key] || ""))) throw new Error(key + " must use HH:mm");
  }
  const toMinutes = (text) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
  const start = toMinutes(config.desiredStartTime);
  const end = toMinutes(config.desiredEndTime);
  if (start < 480 || end > 1320 || end <= start || (end - start) % 30 !== 0) {
    throw new Error("Booking time must be within 08:00-22:00 and aligned to 30-minute slots");
  }
  if (!config.lxdCourtPriority || !config.xlhCourtPriority) throw new Error("Court priority cannot be empty");
  if (config.mailOnCompletion) {
    for (const key of ["mailTo", "mailFrom", "smtpServer", "smtpPort", "smtpSecret"]) {
      if (!config[key]) throw new Error("Mail is enabled but " + key + " is missing");
    }
  }
  return config;
}

export async function resolveConfig({
  configPath = path.join(PROJECT_ROOT, "config", "local.json"),
  configObject,
  overrides = {},
  projectRoot = PROJECT_ROOT,
  env = process.env,
  discoverVpn = true,
} = {}) {
  const defaults = await readJson(path.join(projectRoot, "config", "defaults.json"));
  const resolvedConfigPath = path.isAbsolute(configPath) ? configPath : path.resolve(projectRoot, configPath);
  const local = configObject === undefined ? await readJson(resolvedConfigPath) : clone(configObject);
  assertNoPlaintextSecrets(local);
  assertNoPlaintextSecrets(overrides);

  const isLegacy = local.version === undefined && Object.keys(local).some((key) => key === "pollIntervalMs" || key === "taskName");
  const onboardingKeys = new Set(["courtPriority", "vpn", "mail", "payment", "advanced"]);
  const flatLocal = Object.fromEntries(Object.entries(local).filter(([key]) => !onboardingKeys.has(key)));
  let effective = deepMerge(defaults, flatLocal);

  if (isPlainObject(local.courtPriority)) {
    effective.lxdCourtPriority = priorityToCsv(local.courtPriority.lxd, effective.lxdCourtPriority);
    effective.xlhCourtPriority = priorityToCsv(local.courtPriority.xlh, effective.xlhCourtPriority);
  }

  if (isPlainObject(local.vpn) && local.vpn.shortcutPath) {
    effective.easyConnectShortcutPath = String(local.vpn.shortcutPath);
  }
  normalizeMail(local, effective);

  if (isPlainObject(local.payment) && Object.prototype.hasOwnProperty.call(local.payment, "autoConfirm")) {
    effective.paymentAutoConfirm = local.payment.autoConfirm === true;
  } else if (Object.prototype.hasOwnProperty.call(local, "paymentAutoConfirm")) {
    effective.paymentAutoConfirm = local.paymentAutoConfirm === true;
  } else if (isLegacy) {
    effective.paymentAutoConfirm = true;
  }

  if (isPlainObject(local.advanced)) effective = deepMerge(effective, local.advanced);
  effective = deepMerge(effective, overrides);

  effective.webBridgeExecutablePath = expandEnvironmentPath(effective.webBridgeExecutablePath, env);
  if (!effective.easyConnectShortcutPath && discoverVpn) {
    effective.easyConnectShortcutPath = await discoverVpnShortcut({ env });
  }
  const start = String(effective.desiredStartTime).replace(":", "");
  const end = String(effective.desiredEndTime).replace(":", "");
  const scopedTaskName = "BadmintonBookingAssistant_" + String(effective.primaryCampus).toUpperCase() + "_" + start + "_" + end;
  if (!String(effective.taskName || "").startsWith("BadmintonBookingAssistant_")) {
    effective.taskName = scopedTaskName;
  }

  validateEffectiveConfig(effective);
  Object.defineProperty(effective, "_configPath", { value: resolvedConfigPath, enumerable: false });
  return effective;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configObject = args["config-base64"]
    ? parseJsonText(Buffer.from(args["config-base64"], "base64").toString("utf8"), "base64 config")
    : undefined;
  const overrides = args["overrides-base64"]
    ? parseJsonText(Buffer.from(args["overrides-base64"], "base64").toString("utf8"), "base64 overrides")
    : {};
  const config = await resolveConfig({
    configPath: args.config || path.join(PROJECT_ROOT, "config", "local.json"),
    configObject,
    overrides,
    discoverVpn: args["no-vpn-discovery"] !== true,
  });
  process.stdout.write(JSON.stringify(config, null, args.pretty ? 2 : 0) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(String(error.message || error) + "\n");
    process.exitCode = 1;
  });
}
