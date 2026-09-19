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

  const { valid, errors } = validateConfig(proposal);
  return { proposal, valid, errors, excludedFixturePaths: [...excludedFixturePaths].sort(), notes };
}
