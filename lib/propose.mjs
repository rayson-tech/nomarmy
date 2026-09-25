// Turns scan evidence into a conservative `.nomarmy.yml` PROPOSAL for
// `nomarmy init` to show a human, never a finished answer.
//
// lib/evidence.mjs's own header already says the evidence shape is meant for
// an LLM's judgment, not a deterministic mapper -- picking an `environment`
// level and a service's `source` are judgment calls evidence alone can't
// answer. So this mapper deliberately stays narrow:
//   * only ever proposes `source: "compose"` services, mapped 1:1 from
//     evidence (mechanical, not a judgment call) -- never `shared`/`remote`,
//     the schema's elevated sources that require explicit human policy
//     approval (see lib/schema.mjs's ELEVATED_SERVICE_SOURCES);
//   * verification always needs review: the schema requires at least one
//     command, so a repo with no detected command gets an explicit,
//     fail-loud placeholder rather than a fake one that would silently
//     "pass" every job;
//   * evidence flagged fixture-like by lib/scan.mjs's fixturePaths is never
//     included.
import { validateConfig } from "./config.mjs";

const PLACEHOLDER_COMMAND = "echo 'REPLACE ME: no verification command configured yet' && exit 1";

/**
 * @param {object} evidence  scanRepository()'s return value
 * @returns {{ proposal: object, valid: boolean, errors: string[], excludedFixturePaths: string[], notes: string[] }}
 */
export function buildConfigProposal(evidence) {
  const fixturePaths = new Set(evidence?.fixturePaths ?? []);
  const notes = [];
  const excludedFixturePaths = new Set();

  const allServices = evidence?.services?.items ?? [];
  const services = allServices.filter((s) => {
    if (fixturePaths.has(s.source)) { excludedFixturePaths.add(s.source); return false; }
    return true;
  });

  const proposal = {};

  // --- environment.services (compose only, mechanical) --------------------
  const composeFiles = [...new Set(services.map((s) => s.source))];
  if (composeFiles.length > 0) {
    const file = composeFiles[0];
    if (composeFiles.length > 1) {
      notes.push(`found real (non-fixture) services across ${composeFiles.length} different compose files (${composeFiles.join(", ")}); only ${file} was used -- review the others by hand.`);
    }
    const fromFile = services.filter((s) => s.source === file);
    const environmentServices = {};
    for (const s of fromFile) environmentServices[s.name] = { source: "compose", service: s.name };
    proposal.environment = { compose: { file }, services: environmentServices };
  }

  // --- environment.python.requirements -------------------------------------
  // lib/sandbox-images.mjs's ensurePythonImageBuilt only ever `pip install
  // -r <file>`s whatever this proposes -- it cannot install from
  // pyproject.toml/poetry/uv directly, so this stays scoped to the same
  // requirements.txt-shaped evidence handleRequirements records (tooling
  // name "pip"), never pyproject.toml evidence alone; proposing something
  // the sandbox builder can't actually act on would be worse than proposing
  // nothing. A repo whose real Python dependency source is poetry/uv with no
  // requirements.txt anywhere gets no proposal here -- a distinct, real gap
  // (the sandbox has no poetry/uv install path at all yet), not this one.
  const pipTooling = (evidence?.tooling?.items ?? []).filter((t) => t.name === "pip" && t.category === "package-manager" && t.source);
  for (const t of pipTooling) if (fixturePaths.has(t.source)) excludedFixturePaths.add(t.source);
  const requirementsFiles = [...new Set(pipTooling.filter((t) => !fixturePaths.has(t.source)).map((t) => t.source))].sort();
  if (requirementsFiles.length === 1) {
    proposal.environment = { ...proposal.environment, python: { requirements: requirementsFiles } };
  } else if (requirementsFiles.length > 1) {
    // The exact ambiguity this file's own header already treats as a human
    // judgment call for compose files: several requirements.txt-shaped files
    // (app, dev, a sub-package's own) with no single conventional
    // combination this could guess -- a wrong guess here is worse than no
    // proposal, since a worker's correct diff would fail verification for
    // an infrastructure reason indistinguishable from broken code (this is
    // exactly the failure this whole field exists to prevent in the first
    // place: silently omitting it entirely did the same thing).
    notes.push(`found ${requirementsFiles.length} requirements files (${requirementsFiles.join(", ")}) -- none was proposed automatically since the right combination is your call; add environment.python.requirements by hand, or verification will silently run in a base image with no Python dependencies installed.`);
  }

  // --- verification (always needs review) ----------------------------------
  // Only ever seed from a command evidence itself already labels "test" --
  // evidence.commands also carries start/build/lint/seed/migrate commands
  // (e.g. a Dockerfile's CMD, "sleep infinity", keeping a container alive),
  // and picking any command regardless of purpose picked exactly that once.
  const testCommandItems = evidence?.commands?.items?.filter((c) => c.kind === "test") ?? [];
  for (const c of testCommandItems) if (fixturePaths.has(c.source)) excludedFixturePaths.add(c.source);
  const commandItems = testCommandItems.filter((c) => !fixturePaths.has(c.source));
  const firstCommand = commandItems.find((c) => c.command)?.command;
  if (firstCommand) {
    notes.push(`verification.quick.commands was seeded from a command found in evidence (${firstCommand}) -- confirm this is actually the right check before trusting it.`);
    proposal.verification = { quick: { environment: "none", commands: [firstCommand] } };
  } else {
    notes.push("no command was found anywhere in evidence; verification.quick.commands is a fail-loud placeholder -- replace it before this profile is usable.");
    proposal.verification = { quick: { environment: "none", commands: [PLACEHOLDER_COMMAND] } };
  }

  // A bundle or packaging step (Lambda assets, SAM, Serverless, CDK): unit
  // tests pass while a module the bundle leaves out crashes the deployed
  // function on import. A real Senti branch had exactly that, and pytest,
  // nomArmy's verification and the revert check were all green. Only a
  // repo-specific check catches it, so say so; the command is the repo's own.
  const BUNDLE_RE = /\bbundle[\w-]*|\bpackage-[\w-]+|prepare-[\w-]*packages?\b|\bsam (?:build|package)\b|\b(?:serverless|sls) package\b|\bcdk synth\b/i;
  const bundleCommands = [...new Set((evidence?.commands?.items ?? []).filter((c) => !fixturePaths.has(c.source) && BUNDLE_RE.test(c.command ?? "")).map((c) => c.command.trim()))];
  if (bundleCommands.length) {
    const shown = bundleCommands.slice(0, 3).join("; ");
    notes.push(`found a bundle/packaging step (${shown}${bundleCommands.length > 3 ? "; ..." : ""}). Tests pass even when a module is left out of the bundle, so consider a verification profile that runs it and then imports each entry point from inside the built bundle (e.g. \`python -c "import handler"\` in each asset directory): that catches a deploy-time import crash before it ships.`);
  }

  // New repos start strict: nomArmy commits only verified work, and the
  // revert check can't be switched off per job (mcp/server.mjs repoPolicy).
  proposal.policy = { require_verification: true, require_regression_check: true };
  notes.push("policy requires verification and the revert check on every implement job; set either to false in .nomarmy.yml to relax it for this repo.");

  const { valid, errors } = validateConfig(proposal);
  return { proposal, valid, errors, excludedFixturePaths: [...excludedFixturePaths].sort(), notes };
}
