import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = readFileSync(path.join(root, "badminton.ps1"), "utf8");

for (const required of [
  "[switch]$SelectVpnShortcut",
  "[switch]$UpdatePassword",
  "function Select-VpnShortcutFile",
  "System.Windows.Forms.OpenFileDialog",
  "统一身份认证（CAS）账号",
  "输入内容不可见",
  "config -SelectVpnShortcut",
  "config -UpdatePassword",
]) assert.ok(cli.includes(required), "CLI onboarding missing: " + required);

assert.ok(cli.includes("if ($EnableMail)"), "Mail must remain explicit opt-in");
assert.ok(!cli.includes("Enable completion email now?"), "Normal setup must not prompt to enable mail");
assert.ok(cli.includes('GetExtension($resolved) -ine ".lnk"'), "VPN picker must only accept .lnk shortcuts");
console.log("CLI onboarding OK");
