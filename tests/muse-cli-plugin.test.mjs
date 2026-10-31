import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildMuseCliBackend, parseMuseJsonlEvent, resolveMuseExecutionArgs } from "../openclaw-plugin/muse-cli/backend.js";
import { agentRunsToolsOnHost } from "../lib/agents.mjs";
import { museRouteIssues } from "../lib/health.mjs";

// Records in the shape `muse exec --json` wrote for a real one-tool read job
// ("Read README.md and reply with its first word only."), ids shortened and
// the many task.lifecycle records it also writes trimmed to one.
const record = (payload_type, payload) => JSON.stringify({ schema_version: 1, id: "r", stream: { kind: "session", id: "s" }, sequence: 1, record_type: "event", payload_type, payload });
const RUN = { kind: "run", id: "run-1" };
const REAL_RUN = [
  record("run.model.configured", { kind: "run_model_configured", run_stream: RUN, provider_id: "meta", model_id: "muse-spark-1.3" }),
  record("task.lifecycle.status", { kind: "task_lifecycle", event: { kind: "status", message: "opening meta model stream attempt 1/10" } }),
  record("task.lifecycle.side_effect_intent", { kind: "task_lifecycle", event: { kind: "side_effect_intent", operation: "tool:read_file", idempotency_key: "tool:call_1", policy_decision: "allow:policy" } }),
  record("task.lifecycle.side_effect_intent", { kind: "task_lifecycle", event: { kind: "side_effect_intent", operation: "reminder.child_run", idempotency_key: "reminder_child:skill-reminder:1" } }),
  record("tool.result", { kind: "tool_result", run_stream: RUN, call_id: "call_1", text: "Read text file `README.md`.\n1|Banana split", correlation_facts: { tool_name: "read_file", outcome: "success" } }),
  record("run.output.delta", { kind: "run_output_delta", run_stream: RUN, text: "Banana" }),
  record("run.usage", { kind: "run_usage", run_stream: RUN, models: [{ model: "muse-spark-1.3", input_tokens: 53946, cached_tokens: 26865, output_tokens: 101, reasoning_tokens: 10, calls: 2 }], calls: 2 }),
  record("run.terminal.completed", { kind: "run_terminal", run_stream: RUN, terminal: "completed", text: "Banana", reason: null }),
];

test("parseMuseJsonlEvent: a real run's tool call, reply, usage and final answer; muse's bookkeeping is skipped", () => {
  assert.deepEqual(REAL_RUN.map((line) => parseMuseJsonlEvent(line)).filter(Boolean), [
    { kind: "toolStart", toolCallId: "call_1", name: "read_file" },
    { kind: "toolResult", toolCallId: "call_1", name: "read_file", isError: false, result: "Read text file `README.md`.\n1|Banana split" },
    { kind: "text", text: "Banana" },
    // Cached input is counted once, as a cache read; reasoning is output.
    { kind: "result", usage: { input: 27081, output: 111, cacheRead: 26865, cacheWrite: 0, total: 54057 } },
    { kind: "result", text: "Banana" },
  ]);
});

test("parseMuseJsonlEvent: a run that didn't complete is an error with muse's reason; a failed tool is a failed tool; junk is skipped", () => {
  assert.deepEqual(parseMuseJsonlEvent(record("run.terminal.failed", { kind: "run_terminal", terminal: "failed", text: "", reason: "provider returned 429" })),
    { kind: "result", text: "", errorText: "muse exec ended failed: provider returned 429" });
  assert.equal(parseMuseJsonlEvent(record("tool.result", { call_id: "c", correlation_facts: { tool_name: "shell", outcome: "denied" } })).isError, true);
  assert.equal(parseMuseJsonlEvent("muse: workspace root: /tmp/x (cwd default)"), null);
  assert.equal(parseMuseJsonlEvent(record("run.output.delta", { text: "" })), null);
  assert.equal(parseMuseJsonlEvent(record("run.usage", { models: [] })), null);
});

test("resolveMuseExecutionArgs: model and effort go before the `--` that ends muse's options, so a prompt is never read as a flag", () => {
  const baseArgs = buildMuseCliBackend().config.args;
  const args = resolveMuseExecutionArgs({ baseArgs, modelId: "muse-wonder-1.0", thinkingLevel: "high" });
  assert.deepEqual(args.slice(-6), ["--model", "muse-wonder-1.0", "--reasoning-effort", "high", "--", "{prompt}"]);
  // OpenClaw's "adaptive" (and anything muse doesn't name) keeps muse's default.
  assert.deepEqual(resolveMuseExecutionArgs({ baseArgs, modelId: "muse-spark-1.3", thinkingLevel: "adaptive" }).slice(-4), ["--model", "muse-spark-1.3", "--", "{prompt}"]);
  assert.equal(resolveMuseExecutionArgs({ baseArgs, modelId: "m", thinkingLevel: "off" }).at(-3), "minimal");
});

test("the muse-cli backend: headless, muse's own sandbox kept, no web or operator questions, a fresh session each run", () => {
  const backend = buildMuseCliBackend();
  assert.equal(backend.id, "muse-cli");
  const { args, sessionMode, output } = backend.config;
  assert.deepEqual(args.slice(0, 2), ["exec", "--json"]);
  for (const flag of ["--disable-web-tools", "--disable-request-user-input"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--approval-mode") + 1], "never");
  assert.equal(args[args.indexOf("--sandbox-network") + 1], "restricted");
  for (const off of ["--yolo", "--disable-sandbox", "--trust-workspace"]) assert.equal(args.includes(off), false, off);
  assert.deepEqual([sessionMode, output], ["none", "jsonl"]);
  // The manifest declares the same backend id and models under it.
  const manifest = JSON.parse(fs.readFileSync(new URL("../openclaw-plugin/muse-cli/openclaw.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.cliBackends, ["muse-cli"]);
  assert.ok(manifest.modelCatalog.providers["muse-cli"].models.some((m) => m.id === "muse-spark-1.3"));
});

test("a muse-cli agent runs its tools on the host, like claude-cli: scout and review unless allow_host_tools", () => {
  assert.equal(agentRunsToolsOnHost({ kind: "subscription", provider: "muse-cli", owner: "a@example.com" }), true);
});

test("museRouteIssues: a Muse subscription still on Meta's API route is an error with the way back", () => {
  const issues = museRouteIssues({ meta: { kind: "subscription", provider: "meta", owner: "a@example.com" }, muse: { kind: "subscription", provider: "muse-cli", owner: "a@example.com" }, key: { kind: "api", provider: "meta" } });
  assert.deepEqual(issues.map((i) => [i.id, i.severity]), [["muse-route:meta", "error"]]);
  assert.match(issues[0].fix, /^nomarmy agents remove meta && nomarmy agents add subscription meta/);
});
