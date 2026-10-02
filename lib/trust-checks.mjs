// Conservative syntax scanning of raw snapshots, independent of Git attributes.
import { decodeTrustBytes } from "./trust.mjs";

const ACCESS = /\b(?:auth(?:entication|orization|orized)?|permissions?|roles?|scopes?|owners?|tenants?|org|organization|admin|allowed|authorized|can_\w+|is_\w+)(?:_\w+)?\b/i;
const EXIT = /\b(?:raise|throw|return)\b/;
const TENANT_COLUMNS = ["tenant_id", "org_id", "owner_id", "user_id", "account_id", "workspace_id", "company_id", "customer_id", "team_id", "project_id"];
const AUTH_NAME = /auth|login|permission|require_|guard|policy|role|scope|admin|staff|superuser/i;
const AUTH_ERROR = /\b\w*(?:Auth\w*|Forbidden|PermissionDenied|PermissionError)\w*\b/i;
const DENIAL = /\babort\s*\(\s*(?:401|403|404)\b|\.\s*(?:sendStatus|status)\s*\(\s*(?:401|403)\b|\b(?:HttpResponseForbidden|PermissionDenied|Unauthorized|Forbidden)\s*\(|\b(?:raise|throw)\s+(?:new\s+)?(?:PermissionDenied|Unauthorized|Forbidden)\b/;
const maskStrings = (text) => text.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|""|[^"\\])*"|'(?:\\.|''|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
  (literal) => literal.replace(/[^\n]/g, " "));
const denial = (body, authCondition = false) => DENIAL.test(body) ||
  (/\bnext\s*\(/.test(body) && (authCondition || AUTH_ERROR.test(body)));
const clean = (s) => s.replace(/\s+/g, " ").trim();

// Keep offsets and newlines stable, ignoring comments but not string values:
// changing an error status or SQL string can itself weaken a check.
function uncomment(text, python, sql) {
  return text.replace(/("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\*[\s\S]*?\*\/|\/\/[^\n]*|--[^\n]*|#[^\n]*)/g,
    (all, literal, comment) => literal ? literal : ((!python && comment.startsWith("#")) || (!sql && comment.startsWith("--")) ? comment : comment.replace(/[^\n]/g, " ")));
}

function candidates(text, file, tenantColumns) {
  const python = /\.pyi?$/i.test(file), sql = /\.sql$/i.test(file);
  if (!python && !sql && !/\.(?:[cm]?[jt]sx?)$/i.test(file)) return [];
  text = uncomment(text, python, sql);
  const lines = text.split("\n"), codeLines = maskStrings(text).split("\n"), out = [];
  let guardEnd = -1;
  const add = (kind, line, body) => out.push({ kind, line: line + 1, signature: clean(body) });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], trimmed = line.trim();
    const code = codeLines[i];
    if (!trimmed || /^(?:#|--|['"`])/.test(trimmed)) continue;
    if (!sql && i > guardEnd && /\b(?:if|elif)\s*\(?/.test(code)) {
      let body = line, end = i;
      if (python) {
        const indent = line.match(/^\s*/)[0].length;
        let balance = (code.match(/[([{]/g)?.length ?? 0) - (code.match(/[)\]}]/g)?.length ?? 0);
        while (end + 1 < lines.length && (balance > 0 || !lines[end + 1].trim() || lines[end + 1].match(/^\s*/)[0].length > indent || /\\\s*$/.test(lines[end]) ||
          (lines[end + 1].match(/^\s*/)[0].length === indent && /^(?:else\s*:|elif\b)/.test(codeLines[end + 1].trim())))) {
          const part = lines[++end]; body += `\n${part}`;
          balance += (codeLines[end].match(/[([{]/g)?.length ?? 0) - (codeLines[end].match(/[)\]}]/g)?.length ?? 0);
        }
      } else {
        // Track brackets across multiline conditions and bodies. Unbraced
        // guards include their following statement as well.
        let depth = 0, opened = false;
        do {
          const part = codeLines[end];
          for (const ch of part) { if ("({[".includes(ch)) { depth++; opened = true; } else if (")}]".includes(ch)) depth--; }
          if (opened && depth <= 0 && (EXIT.test(body) || denial(body) || /[;}]\s*$/.test(part))) {
            let next = end + 1;
            while (next < lines.length && !codeLines[next].trim()) next++;
            if (!/^\s*else\b/.test(codeLines[next] ?? "")) break;
            // The alternate branch belongs to the same guard, even when its
            // else starts on a new line after the closing brace.
          }
          if (end + 1 >= lines.length) break;
          body += `\n${lines[++end]}`;
        } while (end < lines.length - 1);
      }
      // Include the whole guard so changing its condition while leaving its
      // return in place is still detected. False positives demand review.
      const guardCode = maskStrings(body);
      const condition = guardCode.split(/\b(?:raise|throw|return)\b/)[0].replace(/([a-z])([A-Z])/g, "$1 $2");
      if ((ACCESS.test(condition) && EXIT.test(guardCode)) || denial(guardCode, ACCESS.test(condition))) {
        add("guard", i, body);
        guardEnd = end;
      }
    }
    if (!sql && i > guardEnd && denial(code)) add("guard", i, line);
    // Match decorator and middleware identifiers, not arbitrary auth variables
    // in a condition or string literal. Names are deliberately extensible.
    if (!sql && i > guardEnd && !denial(code) && !/\b(?:if|elif)\s*\(?/.test(code) &&
        [...code.matchAll(/(?:@\s*|[(,]\s*|^\s*)([A-Za-z_$][\w$]*)/g)].some((match) => AUTH_NAME.test(match[1]))) add("middleware", i, line);
    if (!sql && /\b(?:assert\b|(?:assert\w*|validate\w*|\w+_validate|\w+_validation)\s*\(|\w+\.validate\s*\()/i.test(code)) {
      let body = line, end = i;
      let balance = (body.match(/\(/g)?.length ?? 0) - (body.match(/\)/g)?.length ?? 0);
      while (balance > 0 && end + 1 < lines.length) {
        const part = lines[++end]; body += `\n${part}`;
        balance += (part.match(/\(/g)?.length ?? 0) - (part.match(/\)/g)?.length ?? 0);
      }
      add("validation", i, body);
    }
    if (/\bWHERE\b|\.(?:filter|filter_by|where)\s*\(/i.test(line)) {
      let body = line, end = i;
      const orm = /\.(?:filter|filter_by|where)\s*\(/i.test(line);
      let balance = (line.match(/\(/g)?.length ?? 0) - (line.match(/\)/g)?.length ?? 0);
      // A nested function's closing parenthesis is not the end of the filter.
      while (end + 1 < lines.length && (orm ? balance > 0 : !codeLines[end].includes(";"))) {
        const part = lines[++end]; body += `\n${part}`;
        balance += (part.match(/\(/g)?.length ?? 0) - (part.match(/\)/g)?.length ?? 0);
      }
      if (!orm) {
        const endOfStatement = maskStrings(body).indexOf(";");
        if (endOfStatement >= 0) body = body.slice(0, endOfStatement + 1);
      }
      if ((body.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []).some((name) => tenantColumns.has(name.toLowerCase()))) add("tenant-filter", i, body);
    }
    if (/\b(?:(?:CREATE|ALTER)\s+POLICY|(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY)\b/i.test(line) ||
        (sql && /^\s*(?:CREATE|ALTER|ENABLE|FORCE)\s*$/.test(line) && /^(?:CREATE|ALTER)\s+POLICY\b|^(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i.test(lines.slice(i, i + 8).join("\n").trim()))) {
      const rest = lines.slice(i).join("\n");
      const endOfStatement = maskStrings(rest).indexOf(";");
      add("rls", i, endOfStatement >= 0 ? rest.slice(0, endOfStatement) : line);
    }
  }
  return out;
}

const isTestFile = file => /(?:^|[\\/])(?:tests?|__tests__|spec)[\\/]|(?:^|[\\/])test_[^\\/]*\.py$|_test\.py$|\.(?:test|spec)\.[^\\/]+$/i.test(file);

const descriptions = {
  guard: "an access guard", middleware: "authentication or permission middleware",
  validation: "an assertion or validation", "tenant-filter": "a tenant or ownership filter", rls: "a row-level security policy",
};

// This scanner compares syntax, not reachability. An early return inserted
// before a guard or a check moved into an unused helper belongs to the judgment
// and phase 3 reachability analysis.
export function detectRemovedChecks(fileChanges = [], { tenantColumns = [] } = {}) {
  const columns = new Set([...TENANT_COLUMNS, ...tenantColumns].map((name) => name.toLowerCase()));
  const findings = [];
  for (const { file, before, after } of fileChanges) {
    const remaining = new Map();
    for (const item of candidates(decodeTrustBytes(after), file, columns)) {
      const key = `${item.kind}:${item.signature}`;
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    for (const { kind, line, signature } of candidates(decodeTrustBytes(before), file, columns)) {
      if (kind === "validation" && isTestFile(file)) continue;
      const key = `${kind}:${signature}`, count = remaining.get(key) ?? 0;
      if (count) { remaining.set(key, count - 1); continue; }
      findings.push({ kind, file, line, reason: `Removes or changes ${descriptions[kind]} at ${clean(file)}:${line}.` });
    }
  }
  return [...new Map(findings.map((f) => [JSON.stringify(f), f])).values()];
}
