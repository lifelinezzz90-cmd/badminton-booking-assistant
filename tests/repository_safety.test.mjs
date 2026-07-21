import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
const files = listed.stdout.split(/\r?\n/).filter(Boolean);
const forbiddenPaths = [/^secrets\//i, /^logs\//i, /^config\/generated\//i, /^config\/local(?:\.|$)/i, /\.result\.json$/i, /\.dpapi\./i];
const textExtensions = new Set([".js", ".mjs", ".json", ".md", ".ps1", ".yml", ".yaml", ".txt", ".svg", ".html", ".css", ".toml", ".gitignore"]);
test("repository excludes runtime and personal data", () => {
  for (const file of files) for (const pattern of forbiddenPaths) assert.doesNotMatch(file.replaceAll("\\", "/"), pattern, "forbidden tracked/runtime path: " + file);
  for (const file of files) {
    if (!textExtensions.has(path.extname(file)) && path.basename(file) !== ".gitignore") continue;
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(text, /C:[\\/]Users[\\/][^%<\s]+/i, "absolute user path in " + file);
    assert.ok(!text.toLowerCase().includes(["hao", "yilang"].join("")), "local username in " + file);
    assert.doesNotMatch(text, /(?<!\d)1[3-9]\d{9}(?!\d)/, "phone number in " + file);
    const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    assert.deepEqual(emails.filter((email) => /(?:qq|163|gmail|outlook|hotmail)\./i.test(email)), [], "personal-looking email in " + file);
  }
});
