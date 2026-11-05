// Vendor families, not transport or billing providers, determine whether a
// review is independent: claude-cli and anthropic are one vendor, and a
// multi-vendor host (Bedrock, Vertex, DeepInfra, OpenRouter, an OpenAI-
// compatible endpoint) is whichever vendor made the model it serves.

// Providers that only ever serve their own vendor's models.
const FIRST_PARTY = {
  "claude-cli": "anthropic", anthropic: "anthropic",
  openai: "openai", "azure-openai": "openai",
  xai: "xai", "muse-cli": "meta", "gemini-cli": "google",
};

// Model families for every other provider. Tight on purpose: "gpt-" alone
// also names EleutherAI's gpt-neo and gpt-j, and "o\d" alone matched
// MiniCPM-o2.6.
const MODEL_FAMILIES = [
  [/claude|anthropic/, "anthropic"],
  [/(?:^|\/)(?:openai\/)?(?:gpt-\d|gpt-oss|chatgpt|o\d(?:-mini|-pro|-preview)?(?:-|$))|(?:^|\/)openai\//, "openai"],
  [/grok/, "xai"],
  [/llama|(?:^|\/)muse-/, "meta"],
  [/gemini|gemma/, "google"],
  [/qwen/, "alibaba"],
  [/mistral|mixtral|codestral|devstral/, "mistral"],
  [/deepseek/, "deepseek"],
];

// A host whose own models are its vendor's when the model id names no other.
const HOST_DEFAULT = { google: "google", vertex: "google" };

/** Neither the provider nor the model says who made it: independence can't be shown. */
export const UNKNOWN_VENDOR = "unknown";

export function vendorOf(provider, model) {
  const host = String(provider ?? "").trim().toLowerCase();
  if (!host || host === "llama-cpp") return "local";
  if (Object.hasOwn(FIRST_PARTY, host)) return FIRST_PARTY[host];
  const id = String(model ?? "").trim().toLowerCase();
  for (const [pattern, vendor] of MODEL_FAMILIES) if (pattern.test(id)) return vendor;
  return HOST_DEFAULT[host] ?? UNKNOWN_VENDOR;
}

/**
 * Whether a reviewer on `reviewer` is independent of every vendor in
 * `others` (the worker's, the General's). An unknown vendor on either side
 * can't be shown to differ, so it is not independent; a null in `others`
 * (no General configured) is skipped.
 */
export function independentVendor(reviewer, ...others) {
  if (!reviewer || reviewer === UNKNOWN_VENDOR) return false;
  return others.every((other) => other == null || (other !== UNKNOWN_VENDOR && other !== reviewer));
}

/**
 * The General's vendor for a record: its own snapshot when it has one, else
 * the caller's current General (a function of the record, or a value). A
 * record dispatched with no General configured falls back too, so that gap
 * can't be used to count a same-vendor review as independent.
 */
export function recordGeneralVendor(record, fallback = null) {
  const own = record?.general?.vendor;
  if (own) return own;
  return typeof fallback === "function" ? fallback(record) : fallback;
}
