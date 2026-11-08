// OpenClaw's file restriction for CLI backends that bring their own sandbox.
// Kept apart from openclaw-run.mjs so the model probes can use it too.

import fs from "node:fs";
import path from "node:path";

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

/**
 * `--config` args for a one-off `openclaw agent exec` on `provider/model`
 * (a model test call), or none for a backend that keeps OpenClaw's
 * restriction. Writes the policy-applied copy of the ambient config into
 * `dir`, readable only by you. `ambientPath` is what `openclaw config file`
 * printed; when it can't be read, OpenClaw's defaults apply.
 * @returns {string[]}
 */
export function cliBackendConfigArgs({ provider, model, dir, ambientPath }) {
  if (!OWN_SANDBOX_CLI_BACKENDS.has(provider)) return [];
  let ambient = {};
  try { ambient = JSON.parse(fs.readFileSync(String(ambientPath ?? "").trim(), "utf8")); } catch { /* no ambient config: OpenClaw's defaults */ }
  const configPath = path.join(dir, "probe.openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify(withCliBackendFsPolicy(ambient, `${provider}/${model}`)), { mode: 0o600 });
  return ["--config", configPath];
}
