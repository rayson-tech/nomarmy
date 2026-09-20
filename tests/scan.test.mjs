// Verification for the nomArmy v1.3 deterministic repository scanner.
// Node built-ins only: this suite must run without `npm install`.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { scanRepository, parseYamlSubset } from "../lib/scan.mjs";
import {
  CATEGORIES,
  EVIDENCE_VERSION,
  classifyCommand,
  compareEvidence,
  emptyEvidence,
  envNamesFromDotenv,
  redactCommand,
} from "../lib/evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const NODE_STACK = path.join(here, "fixtures", "node-stack");
const PYTHON_SVC = path.join(here, "fixtures", "python-svc");
const EMPTY_REPO = path.join(here, "fixtures", "empty-repo");

const nodeEvidence = scanRepository(NODE_STACK);
const pythonEvidence = scanRepository(PYTHON_SVC);

const items = (evidence, category) => evidence[category].items;
const names = (evidence, category, field = "name") => items(evidence, category).map((i) => i[field]);
const find = (evidence, category, predicate) => items(evidence, category).find(predicate);

// Fake values planted in the fixtures. None of these may ever appear in an
// evidence package; the whole point of the scanner is that it records names.
const PLANTED_VALUES = [
  "sup3rs3cret-value-9f2b",
  "tok_live_DO_NOT_LEAK_0001",
  "hunter2-not-a-real-password",
  "ci-password-not-real",
  "py-fixture-secret-7c1a",
  "make-fixture-secret-3b9d",
];

// ---------------------------------------------------------------------------
// Compose extraction
// ---------------------------------------------------------------------------

test("compose services are extracted with image, build, ports and command", () => {
  const serviceNames = names(nodeEvidence, "services");
  for (const expected of ["api", "db", "cache", "e2e"]) {
    assert.ok(serviceNames.includes(expected), `missing service ${expected}`);
  }

  const db = find(nodeEvidence, "services", (s) => s.name === "db" && s.source === "compose.yaml");
  assert.equal(db.image, "postgres:16-alpine");
  assert.equal(db.healthcheck, true);

  const api = find(nodeEvidence, "services", (s) => s.name === "api" && s.source === "compose.yaml");
  assert.ok(api.build.includes("Dockerfile"));
  assert.equal(api.image, null);
  assert.deepEqual(api.ports, ["8080:3000", "9229:9229/tcp"]);
});

test("compose ports are parsed into published/target/protocol", () => {
  const apiHttp = find(
    nodeEvidence,
    "ports",
    (p) => p.service === "api" && p.published === 8080,
  );
  assert.equal(apiHttp.target, 3000);
  assert.equal(apiHttp.protocol, "tcp");
  assert.equal(apiHttp.source, "compose.yaml");

  const debug = find(nodeEvidence, "ports", (p) => p.service === "api" && p.published === 9229);
  assert.equal(debug.protocol, "tcp");

  // `expose:` publishes nothing.
  const exposed = find(nodeEvidence, "ports", (p) => p.service === "cache");
  assert.equal(exposed.published, null);
  assert.equal(exposed.target, 6379);
});

test("compose depends_on becomes a dependency graph with conditions", () => {
  const healthy = find(
    nodeEvidence,
    "dependencies",
    (d) => d.from === "api" && d.to === "db",
  );
  assert.equal(healthy.condition, "service_healthy");
  assert.ok(find(nodeEvidence, "dependencies", (d) => d.from === "api" && d.to === "cache"));
  assert.ok(find(nodeEvidence, "dependencies", (d) => d.from === "e2e" && d.to === "api"));
});

test("compose healthchecks are extracted", () => {
  const apiCheck = find(nodeEvidence, "healthchecks", (h) => h.service === "api");
  assert.ok(apiCheck.test.includes("/healthz"));
  assert.equal(apiCheck.interval, "10s");
  assert.equal(apiCheck.retries, "5");

  const dbCheck = find(nodeEvidence, "healthchecks", (h) => h.service === "db");
  assert.ok(dbCheck.test.includes("pg_isready"));
});

test("compose profiles and seed mounts are extracted", () => {
  const tools = find(nodeEvidence, "profiles", (p) => p.name === "tools");
  assert.deepEqual(tools.services, ["e2e"]);

  const seed = find(nodeEvidence, "seeds", (s) => s.target.includes("seed.sql"));
  assert.equal(seed.service, "db");
  assert.equal(seed.kind, "compose-volume");
});

// ---------------------------------------------------------------------------
// package.json / tooling
// ---------------------------------------------------------------------------

test("npm scripts are extracted and classified", () => {
  const byName = new Map(items(nodeEvidence, "commands").map((c) => [c.name, c]));
  assert.equal(byName.get("npm run test").kind, "test");
  assert.equal(byName.get("npm run test:e2e").kind, "e2e");
  assert.equal(byName.get("npm run db:migrate").kind, "migrate");
  assert.equal(byName.get("npm run db:seed").kind, "seed");
  assert.equal(byName.get("npm run build").kind, "build");
  assert.equal(byName.get("npm run lint").kind, "lint");
  assert.equal(byName.get("npm run start").kind, "start");
  assert.equal(byName.get("npm run test").command, "vitest run");
  assert.equal(byName.get("npm run test").source, "package.json");
});

test("playwright is detected from both the config file and the dependency", () => {
  const playwright = items(nodeEvidence, "tooling").filter((t) => t.name === "playwright");
  assert.ok(playwright.length >= 1);
  assert.ok(playwright.every((t) => t.category === "e2e"));
  assert.ok(playwright.some((t) => t.source === "playwright.config.ts"));
  assert.ok(playwright.some((t) => t.source === "package.json"));

  const e2eCommand = find(nodeEvidence, "commands", (c) => c.command === "npx playwright test");
  assert.equal(e2eCommand.kind, "e2e");

  const webServer = find(nodeEvidence, "commands", (c) => c.name === "playwright webServer");
  assert.equal(webServer.command, "npm run start");
  assert.equal(webServer.kind, "start");

  assert.ok(find(nodeEvidence, "ports", (p) => p.source === "playwright.config.ts" && p.target === 8080));
});

test("testcontainers and package manager are detected", () => {
  assert.ok(find(nodeEvidence, "tooling", (t) => t.name === "testcontainers"));
  assert.ok(find(nodeEvidence, "tooling", (t) => t.category === "package-manager" && t.name === "pnpm"));
  assert.ok(find(nodeEvidence, "tooling", (t) => t.name === "docker compose"));
});

// ---------------------------------------------------------------------------
// Dockerfile / CI / scripts
// ---------------------------------------------------------------------------

test("Dockerfile EXPOSE, HEALTHCHECK and CMD are extracted", () => {
  assert.ok(find(nodeEvidence, "ports", (p) => p.source === "Dockerfile" && p.target === 3000));
  const check = find(nodeEvidence, "healthchecks", (h) => h.source === "Dockerfile");
  assert.equal(check.interval, "30s");
  assert.ok(check.test.includes("curl"));
  assert.ok(find(nodeEvidence, "commands", (c) => c.source === "Dockerfile" && c.kind === "start"));
});

test("CI workflow jobs, services and run steps are extracted", () => {
  const workflow = find(nodeEvidence, "ci", (c) => c.path === ".github/workflows/ci.yml");
  assert.equal(workflow.name, "CI");
  assert.deepEqual(workflow.jobs, ["unit", "integration"]);
  assert.ok(workflow.triggers.includes("push"));
  assert.ok(workflow.services.includes("postgres"));

  const ciCommands = items(nodeEvidence, "commands").filter((c) => c.source === ".github/workflows/ci.yml");
  assert.ok(ciCommands.some((c) => c.command === "npm ci"));
  assert.ok(ciCommands.some((c) => c.command === "npm test"));
  // A `run: |` block is recorded as its first line, never the whole file.
  assert.ok(ciCommands.some((c) => c.command === "npm run db:migrate"));
});

test("integration scripts are recorded as commands, never executed", () => {
  const script = find(nodeEvidence, "commands", (c) => c.source === "scripts/run-integration.sh");
  assert.equal(script.kind, "e2e");
  assert.equal(script.command, "./scripts/run-integration.sh");
});

// ---------------------------------------------------------------------------
// Environment variables: NAMES only
// ---------------------------------------------------------------------------

test("environment variable names are captured with scope and source", () => {
  const envNames = new Set(names(nodeEvidence, "environment"));
  for (const expected of [
    "DATABASE_URL",
    "API_TOKEN",
    "LOG_LEVEL",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "FEATURE_FLAG_BETA",
    "BARE_NAME",
    "EMPTY_VALUE",
    "NODE_ENV",
    "BUILD_VERSION",
    "E2E_BASE_URL",
  ]) {
    assert.ok(envNames.has(expected), `missing env name ${expected}`);
  }

  const fromExample = find(
    nodeEvidence,
    "environment",
    (e) => e.name === "API_TOKEN" && e.scope === "env-example",
  );
  assert.equal(fromExample.source, ".env.example");
  assert.equal(fromExample.sensitiveName, true);

  assert.ok(find(nodeEvidence, "environment", (e) => e.name === "POSTGRES_PASSWORD" && e.scope === "compose"));
  assert.ok(find(nodeEvidence, "environment", (e) => e.name === "BUILD_VERSION" && e.scope === "dockerfile-arg"));
});

test("environment variable VALUES never appear anywhere in the evidence", () => {
  const serialized = JSON.stringify(nodeEvidence) + JSON.stringify(pythonEvidence);
  for (const planted of PLANTED_VALUES) {
    assert.ok(!serialized.includes(planted), `leaked planted value: ${planted}`);
  }
  // Evidence entries are name-shaped records, never `NAME=value` pairs.
  for (const entry of items(nodeEvidence, "environment")) {
    assert.ok(!entry.name.includes("="), `env entry looks like an assignment: ${entry.name}`);
    assert.equal(Object.prototype.hasOwnProperty.call(entry, "value"), false);
  }
});

test("envNamesFromDotenv discards values entirely", () => {
  const parsed = envNamesFromDotenv("A=1\n# comment\nexport B=two\nC\nD =4\n=bad\n");
  assert.deepEqual(parsed, ["A", "B", "C", "D"]);
});

test("redactCommand strips credential-shaped values", () => {
  assert.equal(
    redactCommand("docker run -e DB_PASSWORD=hunter2 -e LOG_LEVEL=debug app"),
    "docker run -e DB_PASSWORD=<redacted> -e LOG_LEVEL=debug app",
  );
  assert.ok(!redactCommand("psql postgres://u:pw@host/db").includes("pw@"));
  assert.equal(redactCommand("npm run db:migrate"), "npm run db:migrate");
});

test("redactCommand strips an Authorization header's Bearer/Basic/Token value", () => {
  const out = redactCommand('curl -H "Authorization: Bearer sk-abcdef1234567890" https://api.example.com/deploy');
  assert.ok(!out.includes("sk-abcdef1234567890"), out);
  assert.ok(out.includes("Authorization: Bearer <redacted>"), out);
});

test("redactCommand strips a user:pass value after -u/--user", () => {
  const out = redactCommand("curl -u admin:hunter2 https://internal/health");
  assert.ok(!out.includes("hunter2"), out);
  assert.ok(!out.includes("admin"), out);
});

test("redactCommand strips a glued mysql -p<password>, scoped to known DB CLIs", () => {
  const out = redactCommand("mysql -h db -uroot -pMyRealSecret123 mydb");
  assert.ok(!out.includes("MyRealSecret123"), out);
});

test("redactCommand leaves an unrelated single-dash flag alone (-p is not glued to a DB CLI)", () => {
  assert.equal(redactCommand("go test -parallel 4 ./..."), "go test -parallel 4 ./...");
  assert.equal(redactCommand("sort -u file.txt"), "sort -u file.txt");
});

// ---------------------------------------------------------------------------
// Traceability, determinism, side-effect freedom
// ---------------------------------------------------------------------------

test("every inference carries the source file it came from", () => {
  const traceable = [
    "files",
    "services",
    "commands",
    "ports",
    "healthchecks",
    "dependencies",
    "environment",
    "tooling",
    "profiles",
    "seeds",
  ];
  for (const category of traceable) {
    for (const entry of items(nodeEvidence, category)) {
      const source = category === "files" ? entry.path : entry.source;
      assert.ok(source && typeof source === "string", `${category} entry without a source`);
      assert.ok(!path.isAbsolute(source), `${category} source should be repo-relative: ${source}`);
    }
  }
});

test("scanning the same repository twice yields identical evidence", () => {
  const a = scanRepository(NODE_STACK);
  const b = scanRepository(NODE_STACK);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("scanning does not modify the repository", () => {
  const snapshot = (dir) => {
    const out = [];
    const walk = (current, rel) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
        const next = path.join(current, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(next, relPath);
        else out.push(`${relPath}:${fs.statSync(next).size}`);
      }
    };
    walk(dir, "");
    return out;
  };
  const before = snapshot(NODE_STACK);
  scanRepository(NODE_STACK);
  assert.deepEqual(snapshot(NODE_STACK), before);
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test("output is capped per category and marks truncation", () => {
  const capped = scanRepository(NODE_STACK, { limits: { perCategory: 2 } });
  assert.equal(capped.truncated, true);
  for (const category of CATEGORIES) {
    const bucket = capped[category];
    assert.ok(bucket.items.length <= 2, `${category} exceeded the cap`);
    assert.equal(bucket.truncated, bucket.total > bucket.items.length);
  }
  assert.equal(capped.services.items.length, 2);
  assert.equal(capped.services.truncated, true);
  assert.ok(capped.services.total >= 4);
  // The uncapped scan of the same repo is not truncated.
  assert.equal(nodeEvidence.services.truncated, false);
});

test("long strings are truncated rather than inlined", () => {
  const capped = scanRepository(NODE_STACK, { limits: { commandLength: 12, stringLength: 12 } });
  for (const command of capped.commands.items) {
    if (command.command) assert.ok(command.command.length <= 12, command.command);
  }
});

// ---------------------------------------------------------------------------
// Degenerate repositories
// ---------------------------------------------------------------------------

test("a repository with none of the recognised files returns valid empty evidence", () => {
  const evidence = scanRepository(EMPTY_REPO);
  assert.equal(evidence.evidenceVersion, EVIDENCE_VERSION);
  assert.equal(evidence.truncated, false);
  for (const category of CATEGORIES) {
    assert.deepEqual(evidence[category], { items: [], truncated: false, total: 0 }, category);
  }
  assert.deepEqual(evidence, emptyEvidence(EMPTY_REPO));
  assert.deepEqual(evidence.fixturePaths, []);
});

// ---------------------------------------------------------------------------
// fixturePaths: sample data under a fixtures-style directory is labelled,
// never silently reported as if it were the repo's own real infrastructure.
// ---------------------------------------------------------------------------
test("fixturePaths flags evidence found under a fixtures-style directory, without excluding it from the normal evidence categories", () => {
  const evidence = scanRepository(here); // here = tests/, which contains fixtures/node-stack and fixtures/python-svc
  assert.ok(evidence.fixturePaths.includes(path.join("fixtures", "node-stack", "compose.yaml")));
  assert.ok(evidence.fixturePaths.includes(path.join("fixtures", "python-svc", "pyproject.toml")));
  // Labelled, not excluded: the fixture's fake services still show up normally.
  const apiService = evidence.services.items.find((s) => s.name === "api" && s.source === path.join("fixtures", "node-stack", "compose.yaml"));
  assert.ok(apiService, "the fixture's own fake service is still reported as evidence, just flagged separately");
  assert.ok(evidence.notes.items.some((n) => /looks like test fixture data/.test(n.message) && n.source === path.join("fixtures", "node-stack", "compose.yaml")));
});

test("fixturePaths does not flag a bare tests/ or __tests__/ path with no fixtures-style segment", () => {
  // A repo's genuine test infrastructure (its own real docker-compose for an
  // integration suite) can legitimately live directly under tests/ or
  // __tests__/ with no "fixtures" segment -- that evidence must not be
  // second-guessed just for living in a directory named "tests".
  const evidence = scanRepository(NODE_STACK); // NODE_STACK itself has no "fixtures" segment in its own relative paths
  assert.deepEqual(evidence.fixturePaths, []);
});

test("a missing directory is not an error", () => {
  const missing = path.join(os.tmpdir(), "nomarmy-scan-does-not-exist-31f4a");
  const evidence = scanRepository(missing);
  assert.equal(evidence.evidenceVersion, EVIDENCE_VERSION);
  assert.equal(evidence.files.items.length, 0);
  assert.ok(evidence.notes.items.some((n) => /not found or unreadable/.test(n.message)));
});

test("an unreadable or malformed file degrades to a note instead of throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-scan-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{ this is not json ");
    fs.writeFileSync(path.join(dir, "compose.yaml"), "services:\n  - not: a\n   mapping\n");
    const evidence = scanRepository(dir);
    assert.ok(evidence.notes.items.length > 0);
    assert.equal(evidence.files.items.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Python fixture
// ---------------------------------------------------------------------------

test("python repository evidence: deps, scripts, make targets, Procfile", () => {
  const tooling = names(pythonEvidence, "tooling");
  for (const expected of ["pytest", "testcontainers", "python app server", "alembic"]) {
    assert.ok(tooling.includes(expected), `missing tooling ${expected}`);
  }

  const commands = new Map(items(pythonEvidence, "commands").map((c) => [c.name, c]));
  assert.equal(commands.get("make test").kind, "test");
  assert.equal(commands.get("make migrate").kind, "migrate");
  assert.equal(commands.get("make serve").kind, "start");
  assert.equal(commands.get("make lint").kind, "lint");
  assert.equal(commands.get("serve").command, "app.main:run");
  assert.equal(commands.get("seed-db").kind, "seed");
  assert.equal(commands.get("web").kind, "start");

  const envNames = new Set(names(pythonEvidence, "environment"));
  for (const expected of ["DATABASE_URL", "SENTRY_DSN", "WORKERS", "PORT", "PYTHON"]) {
    assert.ok(envNames.has(expected), `missing env name ${expected}`);
  }
});

test("go repository evidence: module name, build and test commands", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-scan-go-"));
  try {
    fs.writeFileSync(path.join(dir, "go.mod"), "module github.com/example/widget\n\ngo 1.23\n");
    const evidence = scanRepository(dir);
    assert.ok(names(evidence, "tooling").includes("go"));
    const goTool = find(evidence, "tooling", (t) => t.name === "go");
    assert.equal(goTool.detail, "module github.com/example/widget");
    const commands = new Map(items(evidence, "commands").map((c) => [c.name, c]));
    assert.equal(commands.get("go build").command, "go build ./...");
    assert.equal(commands.get("go test").kind, "test");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rust repository evidence: package name, build and test commands", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-scan-rust-"));
  try {
    fs.writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "widget"\nversion = "0.1.0"\nedition = "2021"\n');
    const evidence = scanRepository(dir);
    assert.ok(names(evidence, "tooling").includes("cargo"));
    const cargoTool = find(evidence, "tooling", (t) => t.name === "cargo");
    assert.equal(cargoTool.detail, "package widget");
    const commands = new Map(items(evidence, "commands").map((c) => [c.name, c]));
    assert.equal(commands.get("cargo build").command, "cargo build");
    assert.equal(commands.get("cargo test").kind, "test");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Drift comparison
// ---------------------------------------------------------------------------

test("compareEvidence reports drift in both directions", () => {
  const config = {
    services: [
      { name: "api", ports: ["8080:3000"], environment: { DATABASE_URL: "", LOG_LEVEL: "" } },
      { name: "db", ports: [5432] },
      { name: "legacy-worker", ports: [7000] },
    ],
    commands: { test: "npm test", start: "npm run start" },
  };
  const drift = compareEvidence(nodeEvidence, config);

  assert.equal(drift.configPresent, true);
  assert.equal(drift.ok, false);

  assert.deepEqual(drift.services.matched, ["api", "db"]);
  assert.ok(drift.services.missingFromConfig.includes("cache"));
  assert.ok(drift.services.missingFromConfig.includes("e2e"));
  assert.deepEqual(drift.services.missingFromRepo, ["legacy-worker"]);

  assert.ok(drift.ports.matched.includes(8080));
  assert.ok(drift.ports.matched.includes(5432));
  assert.ok(drift.ports.missingFromConfig.includes(9229));
  assert.deepEqual(drift.ports.missingFromRepo, [7000]);

  assert.ok(drift.environment.matched.includes("DATABASE_URL"));
  assert.ok(drift.environment.missingFromConfig.includes("POSTGRES_PASSWORD"));

  assert.ok(drift.commandKinds.matched.includes("test"));
  assert.ok(drift.commandKinds.missingFromConfig.includes("migrate"));

  assert.equal(drift.summary.total, drift.summary.missingFromConfig + drift.summary.missingFromRepo);
  assert.ok(drift.summary.missingFromConfig > 0);
});

test("compareEvidence with no config reports everything as missing from config", () => {
  const drift = compareEvidence(nodeEvidence, null);
  assert.equal(drift.configPresent, false);
  assert.equal(drift.ok, false);
  assert.equal(drift.summary.missingFromRepo, 0);
  assert.ok(drift.summary.missingFromConfig > 0);
  assert.ok(drift.notes.some((n) => /No existing config/.test(n)));
});

test("compareEvidence on empty evidence and empty config reports no drift", () => {
  const drift = compareEvidence(emptyEvidence(), {});
  assert.equal(drift.ok, true);
  assert.equal(drift.summary.total, 0);
});

test("compareEvidence is pure: it does not mutate its arguments", () => {
  const config = { services: ["api"] };
  const before = JSON.stringify([nodeEvidence, config]);
  compareEvidence(nodeEvidence, config);
  assert.equal(JSON.stringify([nodeEvidence, config]), before);
});

// ---------------------------------------------------------------------------
// Parser units
// ---------------------------------------------------------------------------

test("the narrow YAML parser handles the compose subset", () => {
  const { value } = parseYamlSubset(
    [
      "services:",
      "  web:",
      "    image: nginx  # trailing comment",
      "    ports: [80, '443:443']",
      "    depends_on:",
      "      - db",
      "    command: >",
      "      sh -c",
      "      'echo hi'",
      "  db:",
      "    image: postgres",
      "---",
      "ignored: true",
    ].join("\n"),
  );
  assert.deepEqual(Object.keys(value.services), ["web", "db"]);
  assert.equal(value.services.web.image, "nginx");
  assert.deepEqual(value.services.web.ports, [80, "443:443"]);
  assert.deepEqual(value.services.web.depends_on, ["db"]);
  assert.equal(value.services.web.command, "sh -c 'echo hi'");
  assert.equal(value.ignored, undefined);
});

test("classifyCommand prefers the command name over the body", () => {
  assert.equal(classifyCommand("test:e2e", "playwright test"), "e2e");
  assert.equal(classifyCommand("db:migrate", "prisma migrate deploy"), "migrate");
  assert.equal(classifyCommand("unknown-name", "vitest run"), "test");
  assert.equal(classifyCommand("mystery", "do-something"), "other");
});
