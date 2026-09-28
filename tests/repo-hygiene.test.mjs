import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

// A test-time `ln -s .../node_modules` was committed by `git add -A` (the old
// .gitignore entry, `node_modules/`, matches folders only, not a symlink) and
// merged; pulling it replaced a real node_modules with a link to itself.
test("nothing under node_modules is tracked, symlink or folder", () => {
  let tracked = "";
  try { tracked = execFileSync("git", ["ls-files", "--", "node_modules"], { encoding: "utf8" }).trim(); } catch { return; } // not a git checkout
  assert.equal(tracked, "", `tracked: ${tracked}`);
});

// new URL(import.meta.url).pathname is "/C:/Users/Jason%20Pugh/..." on Windows:
// `nomarmy connect` then failed copying from C:\C:\Users\Jason%20Pugh\...
test("file URLs become paths with fileURLToPath, never URL.pathname (breaks on Windows)", async () => {
  const fs = await import("node:fs"), path = await import("node:path");
  const offenders = [];
  for (const dir of ["bin", "lib", "mcp", "scripts"]) {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(mjs|js)$/.test(f)) continue;
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      if (/URL\([^)]*import\.meta\.url[^)]*\)\.pathname/.test(src.replace(/^\s*\/\/.*$/gm, ""))) offenders.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(offenders, []);
});
