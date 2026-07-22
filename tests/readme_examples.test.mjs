import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(path.join(root, "README.md"), "utf8");
for (const command of [".\\badminton.ps1 setup", ".\\badminton.ps1 doctor", ".\\badminton.ps1 schedule -TargetDate 2026-07-29 -Start 19:30 -End 21:00 -PlanOnly"]) assert.ok(readme.includes(command), "README missing: " + command);
for (const section of ["核心能力", "快速开始", "工作原理", "兼容性", "安全", "常见问题", "文档"]) assert.ok(readme.includes(section), "README missing section: " + section);
for (const onboardingText of [
  "统一身份认证（CAS）账号",
  "Windows DPAPI 加密保存",
  "不要把密码写进 `config/local.json`",
  "自动检测",
  ".\\badminton.ps1 config -SelectVpnShortcut",
  ".\\badminton.ps1 config -UpdatePassword",
]) assert.ok(readme.includes(onboardingText), "README missing onboarding guidance: " + onboardingText);
assert.doesNotMatch(readme, /alt="Release"|label=Release/i, "README should not show a release badge");
const hero = readme.split(String.fromCharCode(10)).slice(0, 35).join(String.fromCharCode(10));
assert.doesNotMatch(hero, /大学|学院|校园门户/i, "README hero must stay institution-neutral");
assert.ok(readme.length < 16000, "README should stay concise; move reference tables to docs");
console.log("README examples OK");
