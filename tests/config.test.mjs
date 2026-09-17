// Tests for the `.nomarmy.yml` schema, loader and validator.
// Run: node --test tests/config.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  CONFIG_FILENAMES,
  ConfigError,
  loadConfig,
  validateConfig,
} from "../lib/config.mjs";
import {
  DEFAULT_RETENTION,
  collectElevated,
  hostnameProblem,
} from "../lib/schema.mjs";

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

const tempDirs = [];

function tempRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-config-"));
  tempDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents, "utf8");
  }
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Assert invalid, and that some error line mentions `fragment`. */
function assertInvalid(result, fragment) {
  assert.equal(result.valid, false, `expected invalid, got ${JSON.stringify(result.config)}`);
  assert.equal(result.config, null);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, "expected error lines");
  for (const line of result.errors) {
    assert.equal(typeof line, "string", "errors must be readable strings, not a zod dump");
    assert.match(line, /: /, `error line should be "path: message", got ${line}`);
  }
  if (fragment) {
    assert.ok(
      result.errors.some((line) => line.includes(fragment)),
      `expected an error mentioning "${fragment}", got ${JSON.stringify(result.errors)}`,
    );
  }
}

const FULL_CONFIG = {
  environment: {
    compose: { file: "compose.test.yml" },
    services: {
      postgres: { source: "compose", service: "postgres" },
      "aws-mock": { source: "compose", service: "moto" },
      redis: { source: "image", image: "redis:8" },
      "mock-payments": { source: "process", command: "npm run mock:payments" },
      "legacy-thing": { source: "shared", endpoint: "http://approved-service:4566" },
      "staging-api": { source: "remote", endpoint_env: "TEST_API_URL" },
    },
    application: {
      command: "npm run dev",
      healthcheck: "http://app:3000/health",
    },
    browser: { base_url: "http://app:3000" },
    allowed_hosts: ["app", "postgres", "aws-mock", "redis", "mock-payments"],
  },
  verification: {
    quick: { environment: "none", commands: ["npm run lint"] },
    standard: {
      environment: "basic",
      commands: ["npm run lint", "npm test", "npm run build"],
    },
    integration: { environment: "integration", commands: ["npm run integration"] },
    browser: {
      environment: "e2e",
      commands: ["npm run build", "npx playwright test"],
    },
  },
  environment_retention: { success: "destroy", failure: "logs", debug: "retain" },
};

const FULL_CONFIG_YAML = `environment:
  compose:
    file: compose.test.yml
  services:
    postgres:      { source: compose, service: postgres }
    aws-mock:      { source: compose, service: moto }
    redis:         { source: image,   image: redis:8 }
    mock-payments: { source: process, command: npm run mock:payments }
    legacy-thing:  { source: shared,  endpoint: "http://approved-service:4566" }
    staging-api:   { source: remote,  endpoint_env: TEST_API_URL }
  application:
    command: npm run dev
    healthcheck: "http://app:3000/health"
  browser:
    base_url: "http://app:3000"
  allowed_hosts: [app, postgres, aws-mock, redis, mock-payments]

verification:
  quick:       { environment: none,        commands: [npm run lint] }
  standard:    { environment: basic,       commands: [npm run lint, npm test, npm run build] }
  integration: { environment: integration,  commands: [npm run integration] }
  browser:     { environment: e2e,          commands: [npm run build, npx playwright test] }

environment_retention:
  success: destroy
  failure: logs
  debug: retain
`;

// --------------------------------------------------------------------------
// the five service sources
// --------------------------------------------------------------------------

const SOURCE_CASES = [
  { source: "compose", good: { source: "compose", service: "postgres" } },
  { source: "image", good: { source: "image", image: "redis:8" } },
  { source: "process", good: { source: "process", command: "npm run mock:payments" } },
  { source: "shared", good: { source: "shared", endpoint: "http://approved:4566" } },
  { source: "remote", good: { source: "remote", endpoint_env: "TEST_API_URL" } },
];

// Every source paired with a field that belongs to a different source.
const FOREIGN_FIELD_CASES = [
  { source: "compose", foreign: "image", value: "redis:8" },
  { source: "image", foreign: "service", value: "postgres" },
  { source: "process", foreign: "endpoint", value: "http://x:1" },
  { source: "shared", foreign: "endpoint_env", value: "TEST_API_URL" },
  { source: "remote", foreign: "endpoint", value: "http://x:1" },
];

for (const { source, good } of SOURCE_CASES) {
  test(`service source "${source}" is accepted`, () => {
    const result = validateConfig({ environment: { services: { svc: good } } });
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual(result.config.environment.services.svc, good);
  });

  test(`service source "${source}" requires its own field`, () => {
    const result = validateConfig({ environment: { services: { svc: { source } } } });
    assertInvalid(result, "environment.services.svc.");
  });
}

for (const { source, foreign, value } of FOREIGN_FIELD_CASES) {
  test(`service source "${source}" rejects foreign field "${foreign}"`, () => {
    const base = SOURCE_CASES.find((entry) => entry.source === source).good;
    const result = validateConfig({
      environment: { services: { svc: { ...base, [foreign]: value } } },
    });
    assertInvalid(result, `"${foreign}"`);
    assert.ok(
      result.errors.some((line) => line.startsWith("environment.services.svc:")),
      `error should point at the service, got ${JSON.stringify(result.errors)}`,
    );
  });
}

test("an unknown service source is rejected with the valid set listed", () => {
  const result = validateConfig({
    environment: { services: { svc: { source: "kubernetes", service: "x" } } },
  });
  assertInvalid(result, "must be one of compose, image, process, shared, remote");
});

test("a service with no source at all is rejected", () => {
  const result = validateConfig({ environment: { services: { svc: { service: "x" } } } });
  assertInvalid(result, "source");
});

// --------------------------------------------------------------------------
// verification profiles
// --------------------------------------------------------------------------

test("verification profile names are free-form", () => {
  const result = validateConfig({
    verification: {
      "my weird profile name": { environment: "basic", commands: ["npm test"] },
    },
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("an invalid verification environment enum is rejected", () => {
  const result = validateConfig({
    verification: { quick: { environment: "turbo", commands: ["npm test"] } },
  });
  assertInvalid(result, "must be one of none, basic, integration, e2e");
  assert.ok(
    result.errors.some((line) => line.startsWith("verification.quick.environment:")),
    JSON.stringify(result.errors),
  );
});

test("all four environment levels are accepted", () => {
  for (const level of ["none", "basic", "integration", "e2e"]) {
    const result = validateConfig({
      verification: { p: { environment: level, commands: ["npm test"] } },
    });
    assert.equal(result.valid, true, `${level}: ${JSON.stringify(result.errors)}`);
    assert.equal(result.config.verification.p.environment, level);
  }
});

test("an omitted profile environment defaults to none", () => {
  const result = validateConfig({ verification: { quick: { commands: ["npm run lint"] } } });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.config.verification.quick.environment, "none");
});

test("empty commands are rejected", () => {
  const result = validateConfig({
    verification: { quick: { environment: "none", commands: [] } },
  });
  assertInvalid(result, "at least one command");
});

test("missing commands are rejected", () => {
  const result = validateConfig({ verification: { quick: { environment: "none" } } });
  assertInvalid(result, "verification.quick.commands");
});

test("non-string commands are rejected", () => {
  const result = validateConfig({ verification: { quick: { commands: ["npm test", 7] } } });
  assertInvalid(result, "verification.quick.commands.1");
});

test("an unknown key inside a verification profile is rejected", () => {
  const result = validateConfig({
    verification: { quick: { commands: ["npm test"], retries: 3 } },
  });
  assertInvalid(result, '"retries"');
});

// --------------------------------------------------------------------------
// allowed_hosts
// --------------------------------------------------------------------------

test("plain hostnames are accepted in allowed_hosts", () => {
  const hosts = ["app", "postgres", "aws-mock", "redis", "mock-payments", "db.internal"];
  const result = validateConfig({ environment: { allowed_hosts: hosts } });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.config.environment.allowed_hosts, hosts);
});

test("allowed_hosts rejects schemes, slashes, ports and whitespace", () => {
  const bad = {
    "http://app:3000": "URI scheme",
    "app/health": "path or slash",
    "postgres:5432": "port",
    "two hosts": "whitespace",
    "": "must not be empty",
    "-leading-hyphen": "plain hostname",
  };
  for (const [host, fragment] of Object.entries(bad)) {
    const result = validateConfig({ environment: { allowed_hosts: [host] } });
    assertInvalid(result, fragment);
    assert.ok(
      result.errors.some((line) => line.startsWith("environment.allowed_hosts.0:")),
      `${host}: ${JSON.stringify(result.errors)}`,
    );
  }
});

test("hostnameProblem returns null only for plain hostnames", () => {
  assert.equal(hostnameProblem("app"), null);
  assert.equal(hostnameProblem("aws-mock"), null);
  assert.equal(hostnameProblem("db.internal.example"), null);
  assert.notEqual(hostnameProblem("http://app"), null);
  assert.notEqual(hostnameProblem(42), null);
});

// --------------------------------------------------------------------------
// environment_retention
// --------------------------------------------------------------------------

test("environment_retention defaults are applied when absent", () => {
  const result = validateConfig({});
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.config.environment_retention, { ...DEFAULT_RETENTION });
});

test("environment_retention values are validated", () => {
  const result = validateConfig({ environment_retention: { success: "burn" } });
  assertInvalid(result, "must be one of destroy, logs, retain");
});

test("a partial environment_retention keeps the defaults for the rest", () => {
  const result = validateConfig({ environment_retention: { failure: "retain" } });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.config.environment_retention, {
    success: "destroy",
    failure: "retain",
    debug: "retain",
  });
});

// --------------------------------------------------------------------------
// optionality and strictness at the top level
// --------------------------------------------------------------------------

test("a repo with only verification and no environment is valid", () => {
  const result = validateConfig({
    verification: { standard: { environment: "basic", commands: ["npm test"] } },
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.config.environment, undefined);
  assert.deepEqual(result.elevated, { shared: [], remote: [] });
});

test("an empty config is valid", () => {
  for (const input of [{}, null, undefined]) {
    const result = validateConfig(input);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  }
});

test("a non-mapping config is rejected readably", () => {
  for (const input of ["just a string", 42, ["a", "b"]]) {
    const result = validateConfig(input);
    assertInvalid(result, "mapping");
  }
});

test("unknown top-level keys are rejected", () => {
  const result = validateConfig({ enviroment: {} });
  assertInvalid(result, '"enviroment"');
});

test("unknown keys inside environment are rejected", () => {
  const result = validateConfig({ environment: { netwrok: "host" } });
  assertInvalid(result, '"netwrok"');
});

// --------------------------------------------------------------------------
// the elevated flag
// --------------------------------------------------------------------------

test("elevated lists every shared and remote service, in declaration order", () => {
  const result = validateConfig(FULL_CONFIG);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.elevated, {
    shared: ["legacy-thing"],
    remote: ["staging-api"],
  });
});

test("elevated is empty when no service reaches outside the sandbox", () => {
  const result = validateConfig({
    environment: {
      services: {
        postgres: { source: "compose", service: "postgres" },
        redis: { source: "image", image: "redis:8" },
        payments: { source: "process", command: "npm run mock:payments" },
      },
    },
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.elevated, { shared: [], remote: [] });
});

test("elevated is structured data, not a warning string", () => {
  const result = validateConfig({
    environment: {
      services: {
        a: { source: "remote", endpoint_env: "A_URL" },
        b: { source: "shared", endpoint: "http://b:1" },
        c: { source: "remote", endpoint_env: "C_URL" },
      },
    },
  });
  assert.ok(Array.isArray(result.elevated.shared));
  assert.ok(Array.isArray(result.elevated.remote));
  assert.deepEqual(result.elevated.remote, ["a", "c"]);
  assert.deepEqual(result.elevated.shared, ["b"]);
  // Accepted, not rejected: policy approval is the caller's decision.
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("elevated is empty on a failed validation", () => {
  const result = validateConfig({
    environment: { services: { a: { source: "remote", endpoint_env: "A_URL", image: "x" } } },
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.elevated, { shared: [], remote: [] });
});

test("collectElevated tolerates a config with no services", () => {
  assert.deepEqual(collectElevated({}), { shared: [], remote: [] });
  assert.deepEqual(collectElevated(null), { shared: [], remote: [] });
});

// --------------------------------------------------------------------------
// full round-trip
// --------------------------------------------------------------------------

test("a full valid config round-trips unchanged", () => {
  const input = structuredClone(FULL_CONFIG);
  const result = validateConfig(input);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.config, FULL_CONFIG);
  assert.deepEqual(input, FULL_CONFIG, "validateConfig must not mutate its input");
});

// --------------------------------------------------------------------------
// loadConfig
// --------------------------------------------------------------------------

test("CONFIG_FILENAMES lists .nomarmy.yml then .nomarmy.yaml", () => {
  assert.deepEqual([...CONFIG_FILENAMES], [".nomarmy.yml", ".nomarmy.yaml"]);
});

test("a missing config file returns found:false and does not throw", () => {
  const dir = tempRepo();
  const result = loadConfig(dir);
  assert.deepEqual(result, {
    found: false,
    path: null,
    config: null,
    elevated: { shared: [], remote: [] },
  });
});

test("loadConfig reads and validates .nomarmy.yml", () => {
  const dir = tempRepo({ ".nomarmy.yml": FULL_CONFIG_YAML });
  const result = loadConfig(dir);
  assert.equal(result.found, true);
  assert.equal(result.path, path.join(dir, ".nomarmy.yml"));
  assert.deepEqual(result.config, FULL_CONFIG);
  assert.deepEqual(result.elevated, { shared: ["legacy-thing"], remote: ["staging-api"] });
});

test("loadConfig also accepts the .nomarmy.yaml spelling", () => {
  const dir = tempRepo({ ".nomarmy.yaml": "verification:\n  quick:\n    commands: [npm run lint]\n" });
  const result = loadConfig(dir);
  assert.equal(result.found, true);
  assert.equal(result.path, path.join(dir, ".nomarmy.yaml"));
  assert.deepEqual(result.config.verification.quick, {
    environment: "none",
    commands: ["npm run lint"],
  });
});

test("the .yml spelling wins when both files exist", () => {
  const dir = tempRepo({
    ".nomarmy.yml": "verification:\n  fromYml:\n    commands: [a]\n",
    ".nomarmy.yaml": "verification:\n  fromYaml:\n    commands: [b]\n",
  });
  const result = loadConfig(dir);
  assert.equal(result.path, path.join(dir, ".nomarmy.yml"));
  assert.ok(result.config.verification.fromYml);
});

test("an empty config file loads as a valid empty config", () => {
  const dir = tempRepo({ ".nomarmy.yml": "# nothing configured yet\n" });
  const result = loadConfig(dir);
  assert.equal(result.found, true);
  assert.deepEqual(result.config.environment_retention, { ...DEFAULT_RETENTION });
});

test("an invalid config file throws ConfigError carrying readable errors", () => {
  const dir = tempRepo({
    ".nomarmy.yml":
      "environment:\n  services:\n    postgres: { source: compose, service: pg, image: redis:8 }\n",
  });
  assert.throws(
    () => loadConfig(dir),
    (error) => {
      assert.ok(error instanceof ConfigError, "expected a ConfigError");
      assert.equal(error.path, path.join(dir, ".nomarmy.yml"));
      assert.ok(Array.isArray(error.errors) && error.errors.length > 0);
      assert.ok(error.errors.some((line) => line.includes('"image"')), error.errors.join("; "));
      return true;
    },
  );
});

test("malformed YAML throws ConfigError rather than a raw parser error", () => {
  const dir = tempRepo({ ".nomarmy.yml": "environment:\n  services:\n   - [unclosed\n" });
  assert.throws(() => loadConfig(dir), ConfigError);
});
