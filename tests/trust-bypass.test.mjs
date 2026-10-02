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
