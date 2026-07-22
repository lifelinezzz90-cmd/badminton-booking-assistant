import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ps = process.platform === "win32" ? "powershell.exe" : "pwsh";
function taskCount() { if (process.platform !== "win32") return "unsupported"; const r = spawnSync(ps, ["-NoProfile", "-Command", "@(Get-ScheduledTask -TaskName 'BadmintonBookingAssistant_*' -ErrorAction SilentlyContinue).Count"], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : "unavailable"; }
function state() { const rows = []; for (const rel of ["logs", "config/generated"]) { const full = path.join(root, rel); if (!fs.existsSync(full)) rows.push(rel + ":absent"); else rows.push(rel + ":" + fs.readdirSync(full).sort().join(",")); } return rows.join("|"); }
test("PlanOnly creates a five-task preview without project or task mutation", { skip: process.platform !== "win32" }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "badminton-plan-")); const config = path.join(temp, "local.json");
  fs.writeFileSync(config, JSON.stringify({ version: 1, username: "TEST_ACCOUNT", primaryCampus: "lxd", fallbackCampus: "xlh" }, null, 2));
  const beforeFiles = state(); const beforeTasks = taskCount();
  const result = spawnSync(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "tools/install-next-formal-run.ps1"), "-ConfigPath", config, "-RunDate", "2026-07-28", "-TargetDate", "2026-07-29", "-DesiredStartTime", "19:30", "-DesiredEndTime", "21:00", "-NoConfirmPayment", "-PlanOnly"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout); const plan = JSON.parse(result.stdout); assert.equal(plan.planOnly, true); assert.equal(plan.tasks.length, 5); assert.match(plan.taskName, /^BadmintonBookingAssistant_/); assert.equal(plan.paymentEnabled, false);
  assert.equal(state(), beforeFiles, "PlanOnly changed project runtime files"); assert.equal(taskCount(), beforeTasks, "PlanOnly changed scheduled tasks"); fs.rmSync(temp, { recursive: true, force: true });
});
