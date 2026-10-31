// Meta's Muse Code CLI as an OpenClaw CLI backend. A Muse Code subscription
// covers requests made by Meta's own client only: the Model API key that
// `muse login` mints is refused (403) when anything else sends it, which is
// what @openclaw/meta-provider does. This backend runs `muse exec` instead,
// the CLI's headless mode, so every request goes through Meta's client,
// the same way OpenClaw's claude-cli runs `claude -p` for a Claude plan.
//
// `muse exec --json` writes one JSON record per line. Confirmed live against
// muse's own output: the reply streams as run.output.delta, a tool call opens
// as a task.lifecycle.side_effect_intent whose operation is "tool:<name>" and
// closes as tool.result, run.usage carries the token counts, and the run ends
// with run.terminal.<state>, whose text is the final reply.

export const MUSE_CLI_BACKEND_ID = "muse-cli";

// muse's own reasoning efforts; OpenClaw's "adaptive" leaves muse's default.
const EFFORTS = { off: "minimal", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

/**
 * Per-run argv: the model and effort go before the `--` that ends options,
 * so a prompt is never read as a flag.
 */
export function resolveMuseExecutionArgs(ctx) {
  const base = [...ctx.baseArgs];
  const end = base.indexOf("--");
  const extra = [];
  if (ctx.modelId) extra.push("--model", ctx.modelId);
  const effort = EFFORTS[ctx.thinkingLevel];
  if (effort) extra.push("--reasoning-effort", effort);
  if (end === -1) return [...base, ...extra];
  return [...base.slice(0, end), ...extra, ...base.slice(end)];
}

function usageFrom(payload) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  if (models.length === 0) return undefined;
  let input = 0, output = 0, cacheRead = 0;
  for (const m of models) {
    const cached = Number(m.cached_tokens) || 0;
    input += Math.max(0, (Number(m.input_tokens) || 0) - cached);
    cacheRead += cached;
    output += (Number(m.output_tokens) || 0) + (Number(m.reasoning_tokens) || 0);
  }
  return { input, output, cacheRead, cacheWrite: 0, total: input + output + cacheRead };
}

/** One `muse exec --json` line as OpenClaw's parsed events, or null to skip it. */
export function parseMuseJsonlEvent(line) {
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  const type = record?.payload_type;
  const payload = record?.payload;
  if (typeof type !== "string" || !payload || typeof payload !== "object") return null;
  if (type === "run.output.delta") return typeof payload.text === "string" && payload.text ? { kind: "text", text: payload.text } : null;
  if (type === "task.lifecycle.side_effect_intent") {
    const event = payload.event ?? {};
    const operation = String(event.operation ?? "");
    const key = String(event.idempotency_key ?? "");
    if (!operation.startsWith("tool:") || !key.startsWith("tool:")) return null;
    return { kind: "toolStart", toolCallId: key.slice(5), name: operation.slice(5) };
  }
  if (type === "tool.result") {
    if (typeof payload.call_id !== "string") return null;
    const facts = payload.correlation_facts ?? {};
    return { kind: "toolResult", toolCallId: payload.call_id, name: facts.tool_name, isError: facts.outcome !== undefined && facts.outcome !== "success", result: payload.text };
  }
  if (type === "run.usage") {
    const usage = usageFrom(payload);
    return usage ? { kind: "result", usage } : null;
  }
  if (type.startsWith("run.terminal.")) {
    const text = typeof payload.text === "string" ? payload.text : undefined;
    if (payload.terminal === "completed") return { kind: "result", text };
    const why = payload.reason ? (typeof payload.reason === "string" ? payload.reason : JSON.stringify(payload.reason)) : "no reason given";
    return { kind: "result", text, errorText: `muse exec ended ${payload.terminal ?? type.slice(13)}: ${why}` };
  }
  return null;
}

export function buildMuseCliBackend() {
  return {
    id: MUSE_CLI_BACKEND_ID,
    modelProvider: "meta",
    nativeToolMode: "always-on",
    resolveExecutionArgs: resolveMuseExecutionArgs,
    parseJsonlEvent: parseMuseJsonlEvent,
    config: {
      command: "muse",
      // Muse's own OS sandbox and its write limits stay on. Approval is
      // "never" because no one can answer a prompt headless; network is
      // muse's narrowest mode (it has no "none"); web tools and questions
      // to the operator are off, as in every other nomArmy route.
      args: [
        "exec", "--json",
        "--approval-mode", "never",
        "--sandbox-network", "restricted",
        "--disable-web-tools",
        "--disable-request-user-input",
        "--disable-reminders",
        "--no-foreign-personal-context",
        "--", "{prompt}",
      ],
      output: "jsonl",
      input: "arg",
      // `muse resume` only opens the interactive picker; there is no
      // headless resume, so every run is a fresh session.
      sessionMode: "none",
      serialize: true,
    },
  };
}
