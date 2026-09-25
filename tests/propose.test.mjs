import assert from "node:assert/strict";
import test from "node:test";

import { buildConfigProposal } from "../lib/propose.mjs";

function evidence({ services = [], commands = [], tooling = [], fixturePaths = [] } = {}) {
  return { services: { items: services }, commands: { items: commands }, tooling: { items: tooling }, fixturePaths };
}

test("buildConfigProposal: no services and no test command yields a valid, fail-loud placeholder proposal", () => {
  const r = buildConfigProposal(evidence());
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.proposal.environment, undefined, "no compose services found -- no environment block proposed");
  assert.match(r.proposal.verification.quick.commands[0], /REPLACE ME/);
  assert.match(r.proposal.verification.quick.commands[0], /exit 1/, "a forgotten placeholder must fail loudly, never silently pass a job");
  assert.deepEqual(r.excludedFixturePaths, []);
});

test("buildConfigProposal: real compose services map 1:1 into environment.services with source compose", () => {
  const r = buildConfigProposal(evidence({
    services: [
      { name: "api", source: "docker-compose.yml" },
      { name: "db", source: "docker-compose.yml" },
    ],
  }));
  assert.equal(r.valid, true);
  assert.deepEqual(r.proposal.environment.compose, { file: "docker-compose.yml" });
  assert.deepEqual(r.proposal.environment.services.api, { source: "compose", service: "api" });
  assert.deepEqual(r.proposal.environment.services.db, { source: "compose", service: "db" });
});

test("buildConfigProposal: a fixture-flagged service is excluded, never proposed as real infrastructure", () => {
  const r = buildConfigProposal(evidence({
    services: [{ name: "api", source: "tests/fixtures/node-stack/compose.yaml" }],
    fixturePaths: ["tests/fixtures/node-stack/compose.yaml"],
  }));
  assert.equal(r.proposal.environment, undefined);
  assert.deepEqual(r.excludedFixturePaths, ["tests/fixtures/node-stack/compose.yaml"]);
});

test("buildConfigProposal: only a command whose kind is exactly 'test' seeds verification -- a start/build/lint command never does", () => {
  const r = buildConfigProposal(evidence({
    commands: [
      { name: "Dockerfile CMD", kind: "start", command: "sleep infinity", source: "docker/Dockerfile" },
      { name: "npm run test", kind: "test", command: "node --test tests/*.test.mjs", source: "package.json" },
      { name: "npm run build", kind: "build", command: "vite build", source: "package.json" },
    ],
  }));
  assert.deepEqual(r.proposal.verification.quick.commands, ["node --test tests/*.test.mjs"]);
});

test("buildConfigProposal: a fixture-flagged test command is excluded and does not seed verification", () => {
  const r = buildConfigProposal(evidence({
    commands: [{ name: "pytest", kind: "test", command: "pytest", source: "tests/fixtures/python-svc/pyproject.toml" }],
    fixturePaths: ["tests/fixtures/python-svc/pyproject.toml"],
  }));
  assert.match(r.proposal.verification.quick.commands[0], /REPLACE ME/);
  assert.ok(r.excludedFixturePaths.includes("tests/fixtures/python-svc/pyproject.toml"));
});

test("buildConfigProposal: services spread across multiple distinct compose files uses one and notes the rest", () => {
  const r = buildConfigProposal(evidence({
    services: [
      { name: "api", source: "docker-compose.yml" },
      { name: "worker", source: "docker-compose.override.yml" },
    ],
  }));
  assert.equal(r.valid, true);
  assert.equal(Object.keys(r.proposal.environment.services).length, 1, "only the first compose file's services are proposed");
  assert.ok(r.notes.some((n) => /different compose files/.test(n)));
});

test("buildConfigProposal: exactly one requirements.txt-shaped file is proposed automatically -- the real bug this closes (nomarmy init silently omitted environment.python.requirements even when evidence found it)", () => {
  const r = buildConfigProposal(evidence({
    tooling: [{ name: "pip", category: "package-manager", detail: "requirements.txt", source: "requirements.txt" }],
  }));
  assert.equal(r.valid, true);
  assert.deepEqual(r.proposal.environment.python, { requirements: ["requirements.txt"] });
});

test("buildConfigProposal: requirements evidence merges into environment alongside compose, not overwriting it", () => {
  const r = buildConfigProposal(evidence({
    services: [{ name: "db", source: "docker-compose.yml" }],
    tooling: [{ name: "pip", category: "package-manager", detail: "requirements.txt", source: "requirements.txt" }],
  }));
  assert.equal(r.valid, true);
  assert.deepEqual(r.proposal.environment.compose, { file: "docker-compose.yml" });
  assert.deepEqual(r.proposal.environment.python, { requirements: ["requirements.txt"] });
});

test("buildConfigProposal: several requirements files is ambiguous -- proposes nothing automatically but notes it loudly instead of staying silent", () => {
  const r = buildConfigProposal(evidence({
    tooling: [
      { name: "pip", category: "package-manager", detail: "requirements.txt", source: "requirements.txt" },
      { name: "pip", category: "package-manager", detail: "requirements-dev.txt", source: "requirements-dev.txt" },
    ],
  }));
  assert.equal(r.valid, true);
  assert.equal(r.proposal.environment, undefined, "no environment.python proposed -- the combination is a human judgment call, same as multiple compose files");
  assert.ok(r.notes.some((n) => /2 requirements files/.test(n) && /requirements\.txt/.test(n) && /requirements-dev\.txt/.test(n)));
});

test("buildConfigProposal: a duplicate source (same requirements.txt recorded twice) still counts as exactly one file", () => {
  const r = buildConfigProposal(evidence({
    tooling: [
      { name: "pip", category: "package-manager", detail: "requirements.txt", source: "requirements.txt" },
      { name: "pip", category: "package-manager", detail: "requirements.txt", source: "requirements.txt" },
    ],
  }));
  assert.deepEqual(r.proposal.environment.python, { requirements: ["requirements.txt"] });
});

test("buildConfigProposal: a fixture-flagged requirements file is excluded, never proposed as a real dependency source", () => {
  const r = buildConfigProposal(evidence({
    tooling: [{ name: "pip", category: "package-manager", detail: "x", source: "tests/fixtures/python-svc/requirements.txt" }],
    fixturePaths: ["tests/fixtures/python-svc/requirements.txt"],
  }));
  assert.equal(r.proposal.environment, undefined);
  assert.ok(r.excludedFixturePaths.includes("tests/fixtures/python-svc/requirements.txt"));
});

test("buildConfigProposal: pyproject.toml/poetry/uv tooling evidence alone (no requirements.txt) proposes nothing -- the sandbox builder has no install path for it yet, so proposing environment.python would claim a capability that doesn't exist", () => {
  const r = buildConfigProposal(evidence({
    tooling: [{ name: "poetry", category: "package-manager", detail: "pyproject.toml", source: "pyproject.toml" }],
  }));
  assert.equal(r.proposal.environment, undefined);
});

test("buildConfigProposal: the returned proposal is always independently valid against the real schema", () => {
  const r = buildConfigProposal(evidence({ services: [{ name: "weird name with spaces", source: "compose.yml" }] }));
  // A service name with spaces fails serviceNameSchema's regex -- the mapper
  // must surface that as invalid, never silently produce something that
  // would fail `nomarmy validate` a moment later.
  assert.equal(r.valid, false);
  assert.ok(r.errors.length > 0);
});

test("buildConfigProposal: a bundle step in evidence gets a note suggesting a bundle verification profile; ordinary builds don't", () => {
  const withBundle = buildConfigProposal({ commands: { items: [
    { kind: "build", command: "bash scripts/bundle-lambda-assets.sh", source: ".github/workflows/deploy.yml" },
    { kind: "build", command: "bash scripts/bundle-lambda-assets.sh", source: ".github/workflows/deploy-dev.yml" },
    { kind: "test", command: "pytest", source: "Makefile" },
  ] } });
  const notes = withBundle.notes.filter((n) => /bundle\/packaging step/.test(n));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /\(bash scripts\/bundle-lambda-assets\.sh\)/, "each command once");
  for (const command of ["sam build", "npx cdk synth", "sls package"]) {
    assert.equal(buildConfigProposal({ commands: { items: [{ kind: "build", command, source: "ci.yml" }] } }).notes.filter((n) => /bundle\/packaging/.test(n)).length, 1, command);
  }
  assert.equal(buildConfigProposal({ commands: { items: [{ kind: "build", command: "npm run build", source: "ci.yml" }] } }).notes.filter((n) => /bundle\/packaging/.test(n)).length, 0);
});


test("buildConfigProposal: new repos start with the strict policy, and it validates", () => {
  const out = buildConfigProposal({});
  assert.deepEqual(out.proposal.policy, { require_verification: true, require_regression_check: true });
  assert.equal(out.valid, true, out.errors.join("; "));
});
