// OpenClaw's file restriction for CLI backends that bring their own sandbox.
// Kept apart from openclaw-run.mjs so the model probe can use it too.

// CLI backends that run the vendor's own tools inside the vendor's own
// sandbox. OpenClaw 2026.11 turns on its workspace-only file restriction by
// default and refuses a run on a backend that can't enforce it ("CLI backend
// muse-cli cannot enforce workspace-only tool policy"); muse's tools aren't
// OpenClaw's, so it never could, and 2026.10 never applied it to them. Muse's
// own sandbox keeps its writes in the workspace (openclaw-plugin/muse-cli).
export const OWN_SANDBOX_CLI_BACKENDS = new Set(["muse-cli"]);

/** A run config for `provider/model`: OpenClaw's workspace-only restriction off for a backend whose own sandbox does that job. */
export function withCliBackendFsPolicy(config, modelRef) {
  const provider = String(modelRef ?? "").split("/")[0];
  if (!OWN_SANDBOX_CLI_BACKENDS.has(provider)) return config;
  const out = structuredClone(config ?? {});
  out.tools ??= {};
  out.tools.fs = { ...(out.tools.fs ?? {}), workspaceOnly: false };
  return out;
}
