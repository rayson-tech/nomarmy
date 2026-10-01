// install.sh has already installed nomArmy's dependencies. Nothing is ready
// until the configured vendors and read-only OpenClaw diagnostics pass.
import { loadAgents } from "../lib/agents.mjs";
import { globalConfigDir } from "../lib/army.mjs";
import { ensureOpenClawOnPath } from "../lib/openclaw-path.mjs";
import { configuredSubscriptionVendors, openclawInstallPlan, repairOpenclaw, runOpenclawCommand, PINNED_OPENCLAW_VERSION } from "../lib/openclaw-install.mjs";

ensureOpenClawOnPath();
const command = process.env.NOMARMY_OPENCLAW_CMD || "openclaw";
const version = runOpenclawCommand(command, ["--version"]);
const [major, minor] = process.versions.node.split(".").map(Number);
if (openclawInstallPlan(version.ok ? version.stdout : null).length &&
    !((major === 24 && minor >= 16) || (major === 26 && minor >= 1) || major > 26)) {
  console.error(`OpenClaw ${PINNED_OPENCLAW_VERSION} needs Node 24.16+ or 26.1+. Upgrade Node first.`);
  process.exitCode = 1;
} else {
  const prefixIndex = process.argv.indexOf("--prefix");
  const result = await repairOpenclaw({
    command, yes: true, prefix: prefixIndex < 0 ? null : process.argv[prefixIndex + 1],
    vendors: configuredSubscriptionVendors(loadAgents(globalConfigDir()).agents),
  });
  process.exitCode = result.ok ? 0 : 1;
}
