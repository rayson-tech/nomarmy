import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { maxVerifications, setMaxVerifications, maxJobs } from "../lib/limits.mjs";
import { createVerificationFlow } from "../lib/verification-flow.mjs";

const tmp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maxverif-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test("max_verifications: unset by default, set and cleared in limits.yml beside max_jobs", (t) => {
  const filePath = path.join(tmp(t), "limits.yml");
  assert.equal(maxVerifications({ filePath }), null);
  fs.writeFileSync(filePath, "# mine\nmax_jobs: 8\n");
  setMaxVerifications(3, { filePath });
  assert.equal(maxVerifications({ filePath }), 3);
  assert.equal(maxJobs({ filePath, env: {} }).value, 8);
  assert.match(fs.readFileSync(filePath, "utf8"), /# mine/);
  setMaxVerifications(null, { filePath });
  assert.equal(maxVerifications({ filePath }), null);
  assert.throws(() => setMaxVerifications(0, { filePath }), /1 to 32, or off/);
});

test("verification runs past max_verifications wait for a slot, machine-wide, and release it when done", async (t) => {
  const root = tmp(t);
  let running = 0, peak = 0;
  const flow = createVerificationFlow({ ensureJobsRoot: () => root, slotsRoot: path.join(root, "slots"), maxVerifications: () => 2 });
  flow.registerVerificationRunner(async () => {
    running++; peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 150));
    running--;
    return { status: "pass", detail: "ok" };
  });
  const results = await Promise.all([1, 2, 3, 4, 5].map((n) => flow.runIndependentVerification({ jobId: `j${n}`, profile: "quick" })));
  assert.deepEqual(results.map((r) => r.status), ["pass", "pass", "pass", "pass", "pass"]);
  assert.equal(peak, 2);
  assert.deepEqual(fs.readdirSync(path.join(root, "slots")), [], "every slot released");
});

test("a slot that never frees reports not_run with the reason, rather than hanging the job", async (t) => {
  const root = tmp(t);
  const flow = createVerificationFlow({ ensureJobsRoot: () => root, slotsRoot: path.join(root, "slots"), maxVerifications: () => 1, verificationWaitMs: 50 });
  let release;
  flow.registerVerificationRunner(() => new Promise((resolve) => { release = () => resolve({ status: "pass" }); }));
  const first = flow.runIndependentVerification({ jobId: "a", profile: "quick" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await flow.runIndependentVerification({ jobId: "b", profile: "quick" });
  assert.equal(second.status, "not_run");
  assert.match(second.reason, /no verification slot freed within 0 minutes \(max_verifications 1 in limits\.yml\)/);
  release();
  assert.equal((await first).status, "pass");
});
