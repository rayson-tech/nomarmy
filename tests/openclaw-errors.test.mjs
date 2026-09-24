import "./helpers/isolate-global-config.mjs";
// Tests for lib/openclaw-errors.mjs, from real OpenClaw run logs.
import assert from "node:assert/strict";
import { test } from "node:test";

import { modelRejection, modelRejectionLine } from "../lib/openclaw-errors.mjs";

const CODEX_SOL = "\u001b[33m[agent/embedded]\u001b[39m \u001b[33membedded run failover decision: runId=c3440138 stage=prompt decision=surface_error reason=model_not_found attempt=1 retry=0 rotations=0 from=openai/gpt-6-sol profile=sha256:107d20f0d567 rawError={\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.\"}}\u001b[39m";

test("modelRejection: the Codex ChatGPT-plan refusal names the model and keeps the vendor's sentence", () => {
  assert.deepEqual(modelRejection(CODEX_SOL, "openai/gpt-6-sol"), {
    model: "openai/gpt-6-sol",
    message: "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.",
  });
  // Without the attempted model, the log's own from= still names it.
  assert.equal(modelRejection(CODEX_SOL).model, "openai/gpt-6-sol");
});

test("modelRejection: OpenClaw's Unknown model (the Muse case)", () => {
  assert.deepEqual(modelRejection("lane task error: error=\"Unknown model: meta/muse-spark-1.3. Run openclaw models list\"", "meta/muse-spark-1.3"),
    { model: "meta/muse-spark-1.3", message: "Unknown model: meta/muse-spark-1.3." });
});

test("modelRejection: any other failure is not a model problem", () => {
  assert.equal(modelRejection("Agent exec cleanup failed: Agent runtime cleanup did not settle", "openai/gpt-6-astra"), null);
  assert.equal(modelRejection("", "x/y"), null);
});

test("modelRejectionLine: starts with model_not_found and says how to fix it", () => {
  const line = modelRejectionLine({ model: "openai/gpt-6-sol", message: "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account." });
  assert.match(line, /^model_not_found: openai\/gpt-6-sol: The 'gpt-6-sol' model is not supported/);
  assert.match(line, /nomarmy army assign/);
});
