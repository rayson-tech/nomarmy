/** Vendor families, not transport or billing providers, determine independence. */
export function vendorOf(provider, model) {
  if (!provider || provider === "llama-cpp") return "local";
  const fixed = {
    "claude-cli": "anthropic", anthropic: "anthropic",
    openai: "openai", "azure-openai": "openai",
    xai: "xai", "muse-cli": "meta", "gemini-cli": "google", google: "google",
  };
  if (Object.hasOwn(fixed, provider)) return fixed[provider];
  const id = String(model ?? "").toLowerCase();
  if (/claude|anthropic/.test(id)) return "anthropic";
  if (/gpt-|(?:^|[^a-z0-9])o\d|openai/.test(id)) return "openai";
  if (/grok/.test(id)) return "xai";
  if (/llama|muse/.test(id)) return "meta";
  if (/gemini/.test(id)) return "google";
  if (/qwen/.test(id)) return "alibaba";
  if (/mistral|mixtral|codestral/.test(id)) return "mistral";
  if (/deepseek/.test(id)) return "deepseek";
  return provider;
}

/** An explicit null General on a new record must not inherit today's config. */
export function recordGeneralVendor(record, fallback = null) {
  if (record && Object.hasOwn(record, "general")) return record.general?.vendor ?? null;
  return typeof fallback === "function" ? fallback(record) : fallback;
}
