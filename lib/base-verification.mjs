import crypto from "node:crypto";

const LIMIT = 500;
// Require a complete, attributable failure count. A partial log, collection
// error, nested suite failure or unfamiliar reporter is not evidence of parity.
export function parseTestFailures(output) {
  const text = String(output ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const bad = () => ({ complete: false, format: null, failures: [] });
  if (/output truncated|output withheld|^(?:ERROR|INTERNALERROR)\b|\b[1-9]\d* errors?\b|Bail out!|^\s*(?:#|ℹ) cancelled [1-9]\d*\s*$/im.test(text)) return bad();
  const failures = new Map();
  const add = (id, reason = "") => {
    if (id.length > 500 || reason.length > 1000) return false;
    const prior = failures.get(id);
    if (prior && reason && prior !== reason) return false;
    failures.set(id, reason || prior || "");
    return true;
  };
  let format = null, activeNode = null;
  const diagnostics = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pytest = /^(?:FAILED\s+(\S+::\S+)(?:\s+-\s+(.*))?|(\S+::\S+)\s+FAILED(?:\s+\[.*\])?)\s*$/.exec(line.trim());
    if (pytest) {
      if (format && format !== "pytest") return bad();
      format = "pytest";
      if (!add(pytest[1] ?? pytest[3], pytest[2] ?? "")) return bad();
    }
    const node = /^\s*(?:not ok\s+\d+\s+-\s+(.+)|✖\s+(.+?)(?:\s+\([\d.]+m?s\))?)\s*$/.exec(line);
    if (node && !/^(?:failing tests:?|fail \d+)$/.test(node[1] ?? node[2])) {
      if (format && format !== "node") return bad();
      format = "node";
      const name = (node[1] ?? node[2]).trim();
      if (/ # (?:SKIP|TODO)/.test(name) || !add(name)) return bad();
      activeNode = name;
    }
    // TAP supplies stable failure diagnostics. Ignore duration and stack paths,
    // which differ between the job and disposable base directories.
    const diagnostic = /^(\s+)(failureType|error|code):\s*(.*)$/.exec(line);
    if (activeNode && diagnostic) {
      let value = diagnostic[3];
      if (/^[|>][-+]?$/.test(value)) {
        const block = [];
        while (i + 1 < lines.length && lines[i + 1].search(/\S/) > diagnostic[1].length) block.push(lines[++i].trim());
        value = block.join("\n");
      }
      const values = diagnostics.get(activeNode) ?? new Map();
      if (values.has(diagnostic[2]) && values.get(diagnostic[2]) !== value) return bad();
      values.set(diagnostic[2], value);
      diagnostics.set(activeNode, values);
    }
  }
  for (const [id, values] of diagnostics) {
    const reason = JSON.stringify([...values].sort(([a], [b]) => a.localeCompare(b)));
    if (reason.length > 1000) return bad();
    failures.set(id, reason);
  }
  const counts = format === "pytest" ? [...text.matchAll(/\b(\d+) failed\b/g)].map(m => Number(m[1]))
    : [...text.matchAll(/^\s*(?:#|ℹ) fail (\d+)\s*$/gm)].map(m => Number(m[1]));
  if (!format || !failures.size || failures.size > LIMIT || !counts.length || counts.some(n => n !== failures.size)) return bad();
  // Keep unknown or ambiguous pass totals explicit. Failure evidence is still
  // useful to the revert gate, but cannot establish parity with the base.
  // pytest: the number right before "passed". "124 subtests passed" (pytest-
  // subtests) is a different count, so a non-numeric word there is skipped,
  // not read as an unknown total. Disagreeing totals still fail closed below.
  const passTokens = format === "pytest"
    ? [...text.matchAll(/(?:^|[,=]\s*|\s)(\d+) passed\b/g)].map(m => m[1])
    : [...text.matchAll(/^\s*(?:#|ℹ) pass(?:\s+(.*?))?\s*$/gm)].map(m => m[1] ?? "");
  const passCounts = passTokens.map(token => /^\d+$/.test(token) ? Number(token) : NaN);
  const passedCount = passCounts.length && passCounts.every(n => Number.isSafeInteger(n) && n >= 0 && n === passCounts[0])
    ? passCounts[0] : null;
  return { complete: true, format, passedCount, failures: [...failures].sort(([a], [b]) => a.localeCompare(b)).map(([id, reason]) => ({ id, reason })) };
}

// Only runner-owned, sanitized command results enter this evidence record.
export function verificationEvidence(results) {
  const failed = results.filter(r => r.exitCode !== 0);
  if (failed.length !== 1) return null;
  const r = failed[0];
  if (!r.started || r.timedOut || r.exitCode !== 1 || r.truncated?.stdout || r.truncated?.stderr) return null;
  const parsed = parseTestFailures(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  if (!parsed.complete) return null;
  return { command: r.command, exitCode: r.exitCode, ...parsed };
}

export function verificationFingerprint(settings) {
  return crypto.createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

export function compareBaseVerification(job, base) {
  const a = job.failureEvidence, b = base.failureEvidence;
  const valid = e => e?.complete === true && ["pytest", "node"].includes(e.format)
    && typeof e.command === "string" && e.command.length > 0 && e.exitCode === 1
    && Array.isArray(e.failures) && e.failures.length > 0 && e.failures.length <= LIMIT
    && e.failures.every(f => typeof f?.id === "string" && f.id.length > 0 && f.id.length <= 500 && typeof f.reason === "string" && f.reason.length <= 1000)
    && new Set(e.failures.map(f => f.id)).size === e.failures.length;
  const known = valid(a) && valid(b);
  const old = new Map(known ? b.failures.map(f => [f.id, f.reason]) : []);
  const preexistingFailures = known ? a.failures.filter(f => old.has(f.id) && old.get(f.id) === f.reason).map(f => f.id) : [];
  const newFailures = known ? a.failures.filter(f => !old.has(f.id) || old.get(f.id) !== f.reason).map(f => f.id) : [];
  const count = e => Number.isSafeInteger(e?.passedCount) && e.passedCount >= 0 ? e.passedCount : null;
  const jobPassedCount = count(a), basePassedCount = count(b);
  const reason = jobPassedCount === null || basePassedCount === null
    ? `missing or unparseable passed count (job: ${jobPassedCount ?? "unknown"}, base: ${basePassedCount ?? "unknown"})`
    : jobPassedCount < basePassedCount
      ? `passed count decreased (job: ${jobPassedCount}, base: ${basePassedCount})`
      : null;
  const matches = reason === null && job.status === "fail" && base.status === "fail" && known && a.failures.length > 0
    && a.failures.length <= LIMIT && a.command === b.command && a.exitCode === b.exitCode && a.format === b.format
    && job.environment?.fingerprint && job.environment.fingerprint === base.environment?.fingerprint
    && job.environment.image === base.environment.image && newFailures.length === 0;
  return { classification: matches ? "preexisting" : "failure", jobPassedCount, basePassedCount, reason, preexistingFailures: preexistingFailures.slice(0, LIMIT), newFailures: newFailures.slice(0, LIMIT) };
}

export function failureList(names) {
  return names.slice(0, 5).map(n => n.slice(0, 160)).join(", ") + (names.length > 5 ? ", ..." : "");
}
