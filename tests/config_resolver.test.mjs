import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverVpnShortcut, resolveConfig } from "../scripts/config_resolver.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, "..");
const minimal = {
  version: 1,
  username: "TEST_ACCOUNT",
  primaryCampus: "lxd",
  fallbackCampus: "xlh",
};

async function resolve(configObject, options = {}) {
  return resolveConfig({ configObject, projectRoot: ROOT, discoverVpn: false, ...options });
}

test("public onboarding config has safe defaults and retains fallback behavior", async () => {
  const config = await resolve(minimal);
  assert.equal(config.mailOnCompletion, false);
  assert.equal(config.paymentAutoConfirm, false);
  assert.equal(config.fallbackCampus, "xlh");
  assert.ok(config.fallbackAfterMisses >= 1);
  assert.equal(config.disablePartialFallback, false);
  assert.ok(config.partialFallbackAfterMisses >= 1);
  assert.ok(config.lxdCourtPriority);
  assert.ok(config.xlhCourtPriority);
  assert.match(config.taskName, /^BadmintonBookingAssistant_LXD_1930_2100$/);
});

test("precedence is defaults, local config, then one-run overrides", async () => {
  const config = await resolve(
    { ...minimal, advanced: { pollIntervalMs: 250, partialMinMinutes: 90 } },
    { overrides: { pollIntervalMs: 40, desiredStartTime: "20:00", desiredEndTime: "21:00" } },
  );
  assert.equal(config.pollIntervalMs, 40);
  assert.equal(config.partialMinMinutes, 90);
  assert.equal(config.desiredStartTime, "20:00");
  assert.equal(config.taskName, "BadmintonBookingAssistant_LXD_2000_2100");
});

test("court priority and manual VPN path remain optional nested settings", async () => {
  const config = await resolve({
    ...minimal,
    courtPriority: { lxd: [9, 3, 1], xlh: "8, 2, 4" },
    vpn: { shortcutPath: "C:\\Example\\EasyConnect.lnk" },
  });
  assert.equal(config.lxdCourtPriority, "9,3,1");
  assert.equal(config.xlhCourtPriority, "8,2,4");
  assert.equal(config.easyConnectShortcutPath, "C:\\Example\\EasyConnect.lnk");
});

test("mail presets resolve without plaintext authorization codes", async () => {
  const cases = [
    ["163", "smtp.163.com", 465],
    ["qq", "smtp.qq.com", 465],
    ["custom", "smtp.example.invalid", 587],
  ];
  for (const [provider, server, port] of cases) {
    const mail = { enabled: true, provider, address: "sender@example.invalid", to: "receiver@example.invalid", secretPath: "secrets/smtp_authorization.dpapi.txt" };
    if (provider === "custom") Object.assign(mail, { smtpServer: server, smtpPort: port });
    const config = await resolve({ ...minimal, mail });
    assert.equal(config.mailOnCompletion, true);
    assert.equal(config.smtpServer, server);
    assert.equal(config.smtpPort, port);
    assert.equal(config.smtpSecret, "secrets/smtp_authorization.dpapi.txt");
  }
});

test("plaintext secret fields are rejected", async () => {
  await assert.rejects(() => resolve({ ...minimal, password: "not-allowed" }), /Plaintext secret field is not allowed/);
  await assert.rejects(() => resolve({ ...minimal, mail: { enabled: false, authorizationCode: "not-allowed" } }), /Plaintext secret field is not allowed/);
});

test("auto-payment is opt-in for new configs", async () => {
  assert.equal((await resolve(minimal)).paymentAutoConfirm, false);
  assert.equal((await resolve({ ...minimal, payment: { autoConfirm: true } })).paymentAutoConfirm, true);
  assert.equal((await resolve({ ...minimal, payment: { autoConfirm: false } })).paymentAutoConfirm, false);
});

test("legacy 46-field config keeps flat behavior and legacy payment default", async () => {
  const legacyPath = path.join(TEST_DIR, "fixtures", "legacy-config.json");
  const legacy = JSON.parse(await fs.readFile(legacyPath, "utf8"));
  assert.equal(Object.keys(legacy).length, 46);
  const config = await resolve(legacy);
  for (const [key, value] of Object.entries(legacy)) {
    if (key === "taskName") continue;
    assert.deepEqual(config[key], value, "legacy field changed: " + key);
  }
  assert.equal(config.paymentAutoConfirm, true);
  assert.match(config.taskName, /^BadmintonBookingAssistant_/);
});

test("an explicit flat legacy payment flag wins over inferred behavior", async () => {
  const legacy = JSON.parse(await fs.readFile(path.join(TEST_DIR, "fixtures", "legacy-config.json"), "utf8"));
  legacy.paymentAutoConfirm = false;
  assert.equal((await resolve(legacy)).paymentAutoConfirm, false);
});

test("VPN discovery searches both Start Menu roots without requiring config paths", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "badminton-vpn-test-"));
  try {
    const programData = path.join(temp, "ProgramData");
    const appData = path.join(temp, "Roaming");
    const shortcut = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "SSLVPN", "EasyConnect.lnk");
    await fs.mkdir(path.dirname(shortcut), { recursive: true });
    await fs.writeFile(shortcut, "fixture", "utf8");
    const found = await discoverVpnShortcut({ env: { ProgramData: programData, APPDATA: appData } });
    assert.equal(found, shortcut);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
