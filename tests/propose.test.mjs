import assert from "node:assert/strict";
import test from "node:test";

import { buildConfigProposal } from "../lib/propose.mjs";

function evidence({ services = [], commands = [], fixturePaths = [] } = {}) {
  return { services: { items: services }, commands: { items: commands }, fixturePaths };
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

test("buildConfigProposal: the returned proposal is always independently valid against the real schema", () => {
  const r = buildConfigProposal(evidence({ services: [{ name: "weird name with spaces", source: "compose.yml" }] }));
  // A service name with spaces fails serviceNameSchema's regex -- the mapper
  // must surface that as invalid, never silently produce something that
  // would fail `nomarmy validate` a moment later.
  assert.equal(r.valid, false);
  assert.ok(r.errors.length > 0);
});
