import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { samePath } from "../lib/same-path.mjs";
import { toPosix } from "../lib/path-utils.mjs";

test("samePath canonicalizes an existing folder and trailing slash", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-same-path-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(samePath(dir, `${dir}${path.sep}`), true);
});

test("samePath compares Windows slash and case spellings case-insensitively", () => {
  assert.equal(samePath("C:\\Users\\RUNNER\\Repo", "c:/users/runner/repo/", "win32"), true);
  assert.equal(samePath("C:\\Users\\RUNNER\\Repo", "c:/users/runner/other", "win32"), false);
});

test("toPosix converts a Windows Docker context source exactly", () => {
  assert.equal(toPosix("nested\\deps.txt"), "nested/deps.txt");
});
