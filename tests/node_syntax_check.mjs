import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.name === "node_modules" || entry.name === ".git" ? [] : entry.isDirectory() ? walk(path.join(dir, entry.name)) : [/\.(?:mjs|js)$/.test(entry.name) ? path.join(dir, entry.name) : []]); }
for (const file of walk(root)) { const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" }); assert.equal(result.status, 0, file + String.fromCharCode(10) + result.stderr); }
console.log("Node syntax OK");
