// A one-token test call before the first job on a model nomArmy hasn't seen
// work for that agent. From a real run: the General's first pick on a role set
// to "auto" was a model the operator's ChatGPT plan refuses but OpenClaw
// lists, and that cost a whole job. A refusal now costs a few seconds at
// dispatch instead, and a model that has worked (a probe, `army assign` or a
// finished job) is never probed again.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { removeTree } from "./remove-tree.mjs";
import { probeOutcome } from "./subscription-setup.mjs";
import { modelRejection } from "./openclaw-errors.mjs";
import { OWN_SANDBOX_CLI_BACKENDS, cliBackendConfigArgs } from "./cli-backend-policy.mjs";
import { loadAgents } from "./agents.mjs";
import { globalConfigDir } from "./army.mjs";
import { gatewayAgentId, gatewayAgentSettings, gatewayResultAsExecResult, runOnGateway } from "./openclaw-gateway-route.mjs";

const PROBE_TIMEOUT_MS = 120000;

/** "gateway" when a subscription agent on `provider` runs its jobs through the Gateway (route: gateway), else null. */
export function routeForProvider(agents, provider) {
  return Object.values(agents ?? {}).some((a) => a?.kind === "subscription" && a.provider === provider && a.route === "gateway") ? "gateway" : null;
}

function configuredRoute(provider) {
  try { return routeForProvider(loadAgents(globalConfigDir()).agents, provider); } catch { return null; }
}

function execBounded(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...opts }, (error, stdout, stderr) =>
      resolve({ error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
  });
}

// OpenClaw leaves the call's sandbox container running; remove it by the
// workspace hash in the probe's own state dir, as jobs and `army assign` do.
/** Removes the sandbox containers an `openclaw agent exec` with this --state-dir started. */
export async function reapProbeSandbox(stateDir, exec) {
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
export async function probeModel({ provider, model, stateRoot, route = configuredRoute(provider), openclawCmd = process.env.NOMARMY_OPENCLAW_CMD || "openclaw", exec = execBounded }) {
  fs.mkdirSync(stateRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(stateRoot, "probe-"));
  const stateDir = path.join(dir, "state"), cwd = path.join(dir, "ws");
  fs.mkdirSync(stateDir); fs.mkdirSync(cwd);
  // An agent on route: gateway is tested the way its jobs run: through the
  // Gateway on a temporary agent (lib/openclaw-gateway-route.mjs).
  if (route === "gateway") return probeOnGateway({ provider, model, dir, cwd, openclawCmd, exec });
  try {
    // A job on a backend with its own sandbox runs with OpenClaw's
    // workspace-only file restriction off (lib/cli-backend-policy.mjs); test
    // it the same way, or the test refuses a model every job would run.
    const configArgs = OWN_SANDBOX_CLI_BACKENDS.has(provider)
      ? cliBackendConfigArgs({ provider, model, dir, ambientPath: (await exec(openclawCmd, ["config", "file"], { cwd, timeout: 20000 })).stdout })
      : [];
    const result = await exec(openclawCmd, ["agent", "exec", "Reply with exactly: ok", "--model", `${provider}/${model}`, "--no-auth-env-only",
      "--json", "--cwd", cwd, "--state-dir", stateDir, ...configArgs, "--timeout", "90"], { cwd, timeout: PROBE_TIMEOUT_MS });
    const outcome = probeOutcome({ stdout: result.stdout, stderr: result.stderr });
    if (outcome.ok) return { ok: true, refused: false, reason: null };
    const rejected = modelRejection(`${result.stderr}\n${result.stdout}`, `${provider}/${model}`);
    return { ok: false, refused: Boolean(rejected), reason: rejected?.message ?? outcome.reason ?? (result.error?.killed ? "the test call timed out" : null) };
  } finally {
    await reapProbeSandbox(stateDir, exec).catch(() => {});
    // OpenClaw 2026.10.1's Codex runtime can still be writing its state when
    // the call returns, so one rm races it (ENOTEMPTY), and a throw here
    // would turn a model that answered into an inconclusive probe: a stale
    // refusal then never clears. A leftover probe dir is harmless.
    removeTree(dir);
  }
}

// exec's { error, stdout, stderr } as the reject-on-failure run runOnGateway takes.
function rejectingRun(exec) {
  return async (cmd, args, opts = {}) => {
    const result = await exec(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? PROBE_TIMEOUT_MS });
    if (result.error) throw Object.assign(new Error(result.stderr || result.error.message), { stdout: result.stdout, stderr: result.stderr, timedOut: Boolean(result.error.killed) });
    return { stdout: result.stdout, stderr: result.stderr };
  };
}

async function probeOnGateway({ provider, model, dir, cwd, openclawCmd, exec }) {
  const promptFile = path.join(dir, "prompt.txt");
  fs.writeFileSync(promptFile, "Reply with exactly: ok\n");
  const agentId = gatewayAgentId(`probe-${path.basename(dir)}`);
  try {
    const { stdout } = await runOnGateway({ run: rejectingRun(exec), command: openclawCmd, agentId, cwd, model: `${provider}/${model}`,
      promptFile, thinking: "low", timeoutSeconds: 90, settings: gatewayAgentSettings(agentId, null), scratchDir: dir, runOpts: { timeoutMs: PROBE_TIMEOUT_MS } });
    let parsed = null;
    try { parsed = gatewayResultAsExecResult(JSON.parse(stdout.slice(stdout.indexOf("{")))); } catch { /* not JSON */ }
    if (parsed?.ok && /\bok\b/i.test(parsed.final ?? "")) return { ok: true, refused: false, reason: null };
    return { ok: false, refused: false, reason: parsed ? `the Gateway turn ended ${parsed.status}` : "the Gateway turn returned no JSON" };
  } catch (error) {
    const text = `${error.stderr ?? ""}\n${error.stdout ?? ""}\n${error.message}`;
    const rejected = modelRejection(text, `${provider}/${model}`);
    return { ok: false, refused: Boolean(rejected), reason: rejected?.message ?? (error.timedOut ? "the test call timed out" : String(error.message).split("\n")[0]) };
  } finally {
    removeTree(dir);
  }
}
