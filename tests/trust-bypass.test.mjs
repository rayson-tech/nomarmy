import test from "node:test";
import assert from "node:assert/strict";
import { detectRemovedChecks } from "../lib/trust-checks.mjs";
import { evaluateDiffTrust } from "../lib/trust-judgment.mjs";
import { evaluateTrust } from "../lib/trust.mjs";

const disabled = { status: "disabled", validator: null, answers: {}, error: null };
const js = `export function listOrders(req, db) {
  const user = requireTenantUser(req);
  return db.orders.filter((order) => order.tenant_id === user.tenant_id);
}`;
const exit = "  if (req.query?.all === true) return db.orders;\n";
const expected = (file, line = 3, kind = "a tenant or ownership filter") => ({
  kind: "bypass", file, line, reason: `Adds an early exit before ${kind} at ${file}:${line}.`,
});
const insert = (text, value, line = 3) => text.split("\n").toSpliced(line - 1, 0, ...value.trimEnd().split("\n")).join("\n");

// Each regression includes a positive tripwire plus near misses. Reverting the
// detector must fail the test, even when all of its negative cases still pass.
for (const file of ["src/orders.mjs", "src/orders.ts"]) {
  test(`bypass scopes and added lines in ${file}`, () => {
    const detect = (before, after) => detectRemovedChecks([{ file, before, after }]);
    assert.deepEqual(detect(js, insert(js, exit)), [expected(file)]);
    assert.deepEqual(detect(js, insert(js, exit, 4)), []);
    assert.deepEqual(detect(js, `function other(req, db) {\n${exit}}\n${js}`), []);
    assert.deepEqual(detect(js, insert(js, `  function other() {\n${exit}  }`)), []);
    assert.deepEqual(detect(js, insert(js, `  const other = () => {\n${exit}  };`)), []);
    const prior = insert(js, exit);
    assert.deepEqual(detect(prior, prior + "\nconst unrelated = 1;"), []);
    const noCheck = js.replace(".filter((order) => order.tenant_id === user.tenant_id)", "");
    assert.deepEqual(detect(noCheck, insert(noCheck, exit)), []);
    assert.deepEqual(detect(js, insert(js, '  // return db.orders;\n  const note = "throw early";')), []);
    assert.deepEqual(detect("", insert(js, exit)), []);
    // The identical exit in a different function must not hide a new exit here.
    const other = `function other(req, db) {\n${exit}}\n`;
    assert.deepEqual(detect(other + js, other + insert(js, exit)), [expected(file, 6)]);
  });
}

for (const [file, before, added, line, description] of [
  ["src/access.js", "function access(user) {\n  if (!user.isAdmin) throw new Error('denied');\n  return data;\n}", "  return data;", 2, "an access guard"],
  ["src/access.ts", "const access = (user: User): Data => {\n  if (!user.isAdmin) throw new Error('denied');\n  return data;\n};", "  if (cached) {\n    throw new Error('cached');\n  }", 3, "an access guard"],
  ["src/orders.py", "def orders(user, db):\n    user = current_user()\n    return db.orders.filter(tenant_id=user.tenant_id)", "    if all_orders:\n        return db.orders", 4, "a tenant or ownership filter"],
  ["src/access.py", "async def access(user):\n    if not user.is_admin:\n        raise PermissionError()\n    return data", "    return data", 2, "an access guard"],
  ["src/raise.py", "def access(user):\n    if not user.is_admin:\n        raise PermissionError()\n    return data", "    raise RuntimeError()", 2, "an access guard"],
  ["src/method.js", "class Orders {\n  list(req) {\n    return db.orders.filter(order => order.tenant_id === req.tenant_id);\n  }\n}", "    return db.orders;", 3, "a tenant or ownership filter"],
]) {
  test(`bypass exit patterns in ${file}`, () => {
    const at = file.endsWith("orders.py") || file.endsWith("method.js") ? 3 : 2;
    assert.deepEqual(detectRemovedChecks([{ file, before, after: insert(before, added, at) }]), [expected(file, line, description)]);
    assert.deepEqual(detectRemovedChecks([{ file, before, after: before + "\n" }]), []);
  });
}

test("bypass Python nested and sibling functions are isolated", () => {
  const file = "src/orders.py";
  const before = "def orders(db):\n    return db.orders.filter(tenant_id=1)\n\ndef other(db):\n    pass";
  assert.deepEqual(detectRemovedChecks([{ file, before, after: insert(before, "    return db.orders", 2) }]), [expected(file, 2)]);
  for (const after of [insert(before, "    return db.orders", 6), insert(before, "    def nested():\n        return db.orders", 2), before + "\n    return db.orders"]) {
    assert.deepEqual(detectRemovedChecks([{ file, before, after }]), []);
  }
});

test("bypass trust floor survives disabled and unavailable judgments and test code is informational", async () => {
  const file = "src/orders.mjs", check = expected(file);
  const fileChanges = [{ file, before: js, after: insert(js, exit) }];
  const floor = evaluateTrust({ changedFiles: [file], fileChanges });
  for (const options of [{ judgment: false }, {}]) {
    assert.deepEqual(await evaluateDiffTrust({ floor, fileChanges, ...options }), {
      level: "review", checks: [check], reasons: [{ rule: "removed-check", reason: check.reason, file, line: 3 }],
      judgment: options.judgment === false ? disabled : { status: "unavailable", validator: null, answers: {}, error: "No trust validator configured." },
    });
  }
  const testFile = "tests/orders.test.mjs";
  assert.deepEqual(await evaluateDiffTrust({ fileChanges: [{ ...fileChanges[0], file: testFile }], judgment: false }), {
    level: "normal", checks: [{ ...expected(testFile), informational: true, reason: "in test code" }], reasons: [], judgment: disabled,
  });
});

test("bypass new-file locations map back to base reach nodes", async () => {
  const file = "src/orders.mjs";
  const padding = "\n".repeat(20);
  const after = padding + insert(js, exit);
  const entry = { symbol: "listOrders", file, category: "tenant", reason: "tenant isolation" };
  const reach = { key: "fixture", baseCommit: "base", heuristic: true, depth: 3, fanOut: 25, caps: [],
    boundaries: [{ entry, nodes: [{ symbol: "listOrders", file, line: 1, end: 4, depth: 0, via: [] }] }] };
  const check = expected(file, 23);
  assert.deepEqual(await evaluateDiffTrust({ fileChanges: [{ file, before: js, after }], judgment: false, reach }), {
    level: "human", checks: [check], judgment: disabled,
    reasons: [
      { rule: "trust-reach", file, line: 1, reason: "removes a check in mapped symbol `listOrders` (src/orders.mjs:1), the tenant boundary" },
      { rule: "removed-check", file, line: 23, reason: check.reason },
    ],
    reach: { key: "fixture", baseCommit: "base", heuristic: true, depth: 3, fanOut: 25, caps: [] },
  });
});

for (const file of ["src/stream.js", "src/stream.ts"]) {
  test(`regression for await owns exits in ${file}`, () => {
    const before = "async function orders(db) {\n  for await (const order of db.stream()) {\n    consume(order);\n  }\n  return db.orders.filter(order => order.tenant_id === tenant);\n}";
    assert.deepEqual(detectRemovedChecks([{ file, before, after: insert(before, "    return db.orders;", 3) }]), [expected(file, 3)]);
    assert.deepEqual(detectRemovedChecks([{ file, before, after: insert(before, "    const nested = () => { return db.orders; };", 3) }]), []);
  });
}

for (const member of ["gen.return()", "promise.throw(error)", "gen . return()", "promise?.throw(error)", "gen.\n    return()"]) {
  test(`regression member is not exit: ${member}`, () => {
    const file = "src/orders.js";
    assert.deepEqual(detectRemovedChecks([{ file, before: js, after: insert(js, `  ${member};`) }]), []);
    for (const statement of ["return db.orders;", "throw error;"]) {
      assert.deepEqual(detectRemovedChecks([{ file, before: js, after: insert(js, `  ${statement}`) }]), [expected(file)]);
    }
  });
}

for (const file of ["src/orders.js", "src/orders.ts", "src/orders.py"]) {
  for (const keyword of ["continue", "break"]) {
    test(`regression loop ${keyword} in ${file}`, () => {
      const python = file.endsWith(".py");
      const before = python
        ? "def orders(db):\n    for order in db.orders:\n        rows = db.orders.filter(tenant_id=order.tenant_id)\n        consume(rows)"
        : "function orders(db) {\n  for (const order of db.orders) {\n    const rows = db.orders.filter(row => row.tenant_id === order.tenant_id);\n    consume(rows);\n  }\n}";
      const added = python ? `        if cached: ${keyword}` : `    if (cached) ${keyword};`;
      assert.deepEqual(detectRemovedChecks([{ file, before, after: insert(before, added) }]), [expected(file)]);
      assert.deepEqual(detectRemovedChecks([{ file, before, after: insert(before, added, 4) }]), []);
    });
  }
}

for (const [file, validation, added] of [
  ["src/input.js", "  assertValid(input);", "  return input;"],
  ["src/input.ts", "  validate(input);", "  throw error;"],
  ["src/input.py", "    assert input is not None", "    return input"],
  ["src/validated.py", "    validate(input)", "    raise RuntimeError()"],
  ["tests/input.test.js", "  validate(input);", "  return input;"],
]) {
  test(`regression validation target in ${file}`, async () => {
    const before = file.endsWith(".py") ? `def check(input):\n${validation}\n    consume(input)` : `function check(input) {\n${validation}\n  consume(input);\n}`;
    const fileChanges = [{ file, before, after: insert(before, added, 2) }];
    const informational = file.startsWith("tests/");
    const check = { ...expected(file, 2, "an assertion or validation"), ...(informational ? { informational: true, reason: "in test code" } : {}) };
    assert.deepEqual(detectRemovedChecks(fileChanges), [check]);
    assert.deepEqual(await evaluateDiffTrust({ fileChanges, judgment: false }), {
      level: informational ? "normal" : "review", checks: [check], judgment: disabled,
      reasons: informational ? [] : [{ rule: "removed-check", reason: check.reason, file, line: 2 }],
    });
  });
}

test("regression Python floor division preserves filters and bypasses", () => {
  const file = "src/orders.py";
  const before = "def orders(db, a, b):\n    x = a // b\n    rows = db.orders.filter(tenant_id=x)\n    return rows";
  // Division before a later-line filter must not hide either candidate or exit.
  assert.deepEqual(detectRemovedChecks([{ file, before, after: insert(before, "    x = a // b; return db.orders") }]), [expected(file)]);
  assert.deepEqual(detectRemovedChecks([{ file, before, after: before.replace("    rows = db.orders.filter(tenant_id=x)\n", "") }]), [{
    kind: "tenant-filter", file, line: 3, reason: `Removes or changes a tenant or ownership filter at ${file}:3.`,
  }]);
  // A real Python comment still hides a keyword after division.
  assert.deepEqual(detectRemovedChecks([{ file, before, after: insert(before, "    x = a // b # return db.orders") }]), []);
});

for (const expression of ["x = a // b; rows = db.orders.filter(tenant_id=x)", "rows = db.orders.filter(offset=a // b, tenant_id=x)"]) {
  test(`regression Python removed division filter: ${expression}`, () => {
    const file = "src/orders.py", before = `def orders(db, a, b):\n    ${expression}\n    return rows`;
    assert.deepEqual(detectRemovedChecks([{ file, before, after: "def orders(db, a, b):\n    return rows" }]), [{
      kind: "tenant-filter", file, line: 2, reason: `Removes or changes a tenant or ownership filter at ${file}:2.`,
    }]);
  });
}

test("regression an exit after a line ending in a dot is still an exit", () => {
  const file = "src/orders.mjs";
  const before = "export function listOrders(req, db) {\n  const scale = 1.\n  return db.orders.filter((order) => order.tenant_id === req.user.tenant_id);\n}";
  const after = insert(before, "  return db.orders;\n");
  assert.deepEqual(detectRemovedChecks([{ file, before, after }]), [expected(file)]);
  // A member call named return on its own line is still not an exit.
  assert.deepEqual(detectRemovedChecks([{ file, before, after: insert(before, "  gen.return(db);\n") }]), []);
});
