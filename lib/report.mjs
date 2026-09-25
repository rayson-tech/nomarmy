// ---------------------------------------------------------------------------
// Compact report contract and lenient recovery parsing (plan 3 / 4)
// ---------------------------------------------------------------------------
export const REPORT_FIELD_NAMES = Object.freeze(["STATUS", "TESTS", "NOT_DONE", "NOTE"]);
const STATUS_VALUES = ["done", "partial", "blocked"];
const TESTS_VALUES = ["pass", "fail", "not_run"];
const STRICT_PATTERNS = [
  /^STATUS:[ \t]+(done|partial|blocked)[ \t]*$/,
  /^TESTS:[ \t]+(pass|fail|not_run)[ \t]*$/,
  /^NOT_DONE:[ \t]+\S.*$/,
  /^NOTE:[ \t]+\S.*$/
];
const LENIENT_FIELD = /^[\s>*_`#-]*((?:NOT[ _-]?DONE)|STATUS|TESTS|NOTE)[\s*_`]*:[ \t]*(.*)$/i;

function stripCodeFences(text) {
  return String(text).split(/\r?\n/).filter(line => !/^\s*```/.test(line)).join("\n");
}
function cleanValue(value) {
  return String(value ?? "").replace(/[`*_]+/g, " ").replace(/\s+/g, " ").trim();
}
function normalizeEnum(value, allowed) {
  const cleaned = cleanValue(value).toLowerCase().replace(/\.$/, "");
  if (!cleaned) return null;
  // A worker that echoed the template ("done | partial | blocked") has told us
  // nothing. Refuse to pick a value out of the menu it was handed.
  if (cleaned.includes("|")) return null;
  const direct = cleaned.replace(/\s+/g, "_");
  if (allowed.includes(direct)) return direct;
  const first = cleaned.split(/[\s,;(-]+/)[0]?.replace(/\s+/g, "_");
  return allowed.includes(first) ? first : null;
}
/**
 * Lenient-first report parser.
 *   strict  - the four-line contract was emitted exactly as specified
 *   valid   - strict AND the acceptance gate holds (done requires TESTS pass)
 *   lenient - fields were recovered from a non-conforming report
 * The distinction stays visible in the manifest. A leniently recovered report
 * is weaker evidence than a clean one and must never be laundered into one.
 */
export function parseWorkerReport(text) {
  const out = {
    present: false, strict: false, valid: false, lenient: false, truncated: false,
    parseMode: "unparsed", status: null, tests: null, notDone: null, note: null,
    fields: {}, missingFields: [...REPORT_FIELD_NAMES], reason: null,
    gate: { satisfied: false, reason: "no report parsed" },
    // Back-compatible alias for readers of the v1.2 record shape.
    verification: null
  };
  if (!text || !String(text).trim()) { out.reason = "missing final report"; return out; }
  out.present = true;
  const body = stripCodeFences(text).replace(/^\s+/, "").replace(/\s+$/, "");
  const lines = body.split(/\r?\n/);

  const fields = {};
  for (const line of lines) {
    const m = line.match(LENIENT_FIELD);
    if (!m) continue;
    const key = m[1].toUpperCase().replace(/[ -]/g, "_");
    if (!REPORT_FIELD_NAMES.includes(key)) continue;
    // Last occurrence wins, not first: the contract is the worker's FINAL
    // message. An earlier incidental match (quoted instructions, echoed
    // template text, pasted file/tool content) must not outrank the real
    // report the worker actually ends on.
    fields[key] = m[2] ?? "";
  }
  out.fields = { ...fields };
  out.missingFields = REPORT_FIELD_NAMES.filter(k => !(k in fields));

  out.status = normalizeEnum(fields.STATUS, STATUS_VALUES);
  out.tests = normalizeEnum(fields.TESTS, TESTS_VALUES);
  out.notDone = "NOT_DONE" in fields ? cleanValue(fields.NOT_DONE) || null : null;
  out.note = "NOTE" in fields ? cleanValue(fields.NOTE) || null : null;
  out.verification = out.tests;

  // Truncation: some of the contract arrived, the tail did not.
  const emptyTail = ("NOTE" in fields && cleanValue(fields.NOTE) === "") || ("NOT_DONE" in fields && cleanValue(fields.NOT_DONE) === "");
  out.truncated = (out.missingFields.length > 0 || emptyTail) && (out.status !== null || out.tests !== null);

  const head = lines.filter(l => l.trim() !== "").slice(0, 4);
  const shapeOk = head.length === 4 && STRICT_PATTERNS.every((re, i) => re.test(head[i]));
  out.strict = shapeOk && out.missingFields.length === 0 && out.status !== null && out.tests !== null;

  if (out.status !== null || out.tests !== null) { out.lenient = !out.strict; out.parseMode = out.strict ? "strict" : "lenient"; }

  // The v1.2 acceptance gate, unchanged in substance: a claimed `done` is only
  // a valid claim when the worker also claims its tests passed.
  if (out.status === "done" && out.tests !== "pass") {
    out.gate = { satisfied: false, reason: `STATUS done requires TESTS pass, got ${out.tests ?? "nothing"}` };
  } else if (out.status === null) {
    out.gate = { satisfied: false, reason: "no STATUS recovered from report" };
  } else {
    out.gate = { satisfied: true, reason: null };
  }

  out.valid = out.strict && out.gate.satisfied;
  if (!out.valid) {
    out.reason = !out.status ? "no usable STATUS line in report"
      : !out.gate.satisfied ? out.gate.reason
      : out.truncated ? `report truncated; missing ${out.missingFields.join(", ") || "field values"}`
      : `report does not match the four-line contract; missing ${out.missingFields.join(", ") || "exact field formatting"}`;
  }
  return out;
}

