// Thinking levels, as OpenClaw names them (`openclaw agent exec --thinking`).
// Which ones a model honors is the vendor's business: OpenClaw refuses a level
// a model lacks and names the ones it has, and nomArmy retries once with the
// nearest of those (lib/openclaw-run.mjs).

export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"]);

// Strength order for picking a fallback; "adaptive" lets the model choose, so it sits mid-way.
const RANK = { off: 0, minimal: 1, low: 2, medium: 3, adaptive: 3.5, high: 4, xhigh: 5, max: 6, ultra: 7 };

/**
 * The supported level closest to the one refused: the strongest at or below
 * it, else the weakest above it. The old fallback took the first listed,
 * often "off", so a refused xhigh would have run with no thinking at all.
 */
export function nearestThinkingLevel(requested, supported) {
  const known = supported.filter((l) => l in RANK);
  if (!known.length) return supported[0] ?? null;
  const want = RANK[requested] ?? RANK.medium;
  const below = known.filter((l) => RANK[l] <= want).sort((a, b) => RANK[b] - RANK[a]);
  if (below.length && !(below[0] === "off" && want > 0 && known.some((l) => RANK[l] > 0))) return below[0];
  return known.filter((l) => RANK[l] > 0).sort((a, b) => RANK[a] - RANK[b])[0] ?? below[0];
}
