import assert from "node:assert/strict";
import test from "node:test";

import { THINKING_LEVELS, nearestThinkingLevel } from "../lib/thinking.mjs";
import { jobSchema } from "../mcp/server.mjs";

test("every OpenClaw thinking level is accepted on a job", () => {
  assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"]);
  for (const level of THINKING_LEVELS) assert.equal(jobSchema.parse({ task: "t", reasoning: level }).reasoning, level);
  assert.equal(jobSchema.safeParse({ task: "t", reasoning: "extreme" }).success, false);
  assert.equal(jobSchema.parse({ task: "t" }).reasoning, "medium", "the default stays medium");
});

test("a refused level falls back to the nearest supported one, never to off when there's thinking to be had", () => {
  assert.equal(nearestThinkingLevel("xhigh", ["off", "minimal", "low", "medium", "high"]), "high", "used to be the first listed: off");
  assert.equal(nearestThinkingLevel("max", ["low", "medium", "high", "xhigh"]), "xhigh");
  assert.equal(nearestThinkingLevel("minimal", ["off", "low", "medium"]), "low", "the weakest above, not off");
  assert.equal(nearestThinkingLevel("off", ["off", "low"]), "off");
  assert.equal(nearestThinkingLevel("adaptive", ["low", "medium", "high"]), "medium");
  assert.equal(nearestThinkingLevel("high", ["dynamic"]), "dynamic", "unknown names: the first, as before");
});
