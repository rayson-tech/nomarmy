// A one-token test call before the first job on a model nomArmy hasn't seen
// work for that agent. From a real run: the General's first pick on a role set
// to "auto" was a model the operator's ChatGPT plan refuses but OpenClaw
// lists, and that cost a whole job. A refusal now costs a few seconds at
// dispatch instead, and a model that has worked (a probe, `army assign` or a
// finished job) is never probed again.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { probeOutcome } from "./subscription-setup.mjs";
import { modelRejection } from "./openclaw-errors.mjs";

const PROBE_TIMEOUT_MS = 120000;

function execBounded(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...opts }, (error, stdout, stderr) =>
      resolve({ error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
  });
}

// OpenClaw leaves the call's sandbox container running; remove it by the
// workspace hash in the probe's own state dir, as jobs and `army assign` do.
async function reapProbeSandbox(stateDir, exec) {
  let hashes = [];
  try {
    hashes = fs.readdirSync(path.join(stateDir, "sandbox", "skills-workspaces"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^workspace-[0-9a-f]{16,}$/.test(d.name)).map((d) => d.name.slice("workspace-".length));
  } catch { return; }
  for (const hash of hashes) {
    const listed = await exec("podman", ["ps", "-a", "--filter", `name=${hash}`, "--format", "{{.Names}}"], { timeout: 20000 });
    for (const name of listed.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) await exec("podman", ["rm", "-f", "-v", name], { timeout: 30000 });
  }
}

/**
 * One real, one-token completion on `provider/model`, the way a job runs it:
 * the ambient OpenClaw config (never --isolated, which skips the Codex runtime
 * that ChatGPT-plan jobs use) and a state dir under stateRoot.
 * @returns {Promise<{ ok: boolean, refused: boolean, reason: string|null }>}
 *   refused: the vendor said it won't run this model. Neither ok nor refused:
 *   inconclusive (a timeout, a network error), so the job is let through.
 */
export async function probeModel({ provider, model, stateRoot, openclawCmd = process.env.NOMARMY_OPENCLAW_CMD || "openclaw", exec = execBounded }) {
  fs.mkdirSync(stateRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(stateRoot, "probe-"));
  const stateDir = path.join(dir, "state"), cwd = path.join(dir, "ws");
  fs.mkdirSync(stateDir); fs.mkdirSync(cwd);
  try {
    const result = await exec(openclawCmd, ["agent", "exec", "Reply with exactly: ok", "--model", `${provider}/${model}`, "--no-auth-env-only",
      "--json", "--cwd", cwd, "--state-dir", stateDir, "--timeout", "90"], { cwd, timeout: PROBE_TIMEOUT_MS });
    const outcome = probeOutcome({ stdout: result.stdout, stderr: result.stderr });
    if (outcome.ok) return { ok: true, refused: false, reason: null };
    const rejected = modelRejection(`${result.stderr}\n${result.stdout}`, `${provider}/${model}`);
    return { ok: false, refused: Boolean(rejected), reason: rejected?.message ?? outcome.reason ?? (result.error?.killed ? "the test call timed out" : null) };
  } finally {
    await reapProbeSandbox(stateDir, exec).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
