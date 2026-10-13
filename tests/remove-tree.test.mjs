import assert from "node:assert/strict";
import test from "node:test";
import { removeTree } from "../lib/remove-tree.mjs";

const denied = (code = "EACCES") => Object.assign(new Error(`${code}: permission denied, unlink '/x/f'`), { code });

test("removeTree removes, and never throws", () => {
  let calls = 0;
  assert.equal(removeTree("/x", { rm: () => { calls++; } }), null);
  assert.equal(calls, 1);
  assert.equal(removeTree("/x", { platform: "darwin", rm: () => { throw denied(); }, unshare: () => assert.fail("Linux only") }),
    "couldn't remove /x: EACCES: permission denied, unlink '/x/f'");
});

test("removeTree clears container-owned files with podman unshare on Linux", () => {
  for (const code of ["EACCES", "EPERM"]) {
    let unshared = null, attempts = 0;
    const rm = () => { if (attempts++ === 0) throw denied(code); };
    assert.equal(removeTree("/x", { platform: "linux", rm, unshare: (dir) => { unshared = dir; } }), null);
    assert.equal(unshared, "/x");
  }
  assert.match(removeTree("/x", { platform: "linux", rm: () => { throw denied(); }, unshare: () => { throw new Error("no podman"); } }), /^couldn't remove \/x: EACCES/);
  assert.match(removeTree("/x", { platform: "linux", rm: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); }, unshare: () => assert.fail("only for permission errors") }), /busy/);
});
