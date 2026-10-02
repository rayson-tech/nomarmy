// Conservative syntax scanning of raw snapshots, independent of Git attributes.
import { decodeTrustBytes } from "./trust.mjs";

const ACCESS = /\b(?:auth(?:entication|orization|orized)?|permissions?|roles?|scopes?|owners?|tenants?|org|organization|admin|allowed|authorized|can_\w+|is_\w+)(?:_\w+)?\b/i;
const EXIT = /\b(?:raise|throw|return)\b/;
const TENANT = /\b(?:tenant_id|org_id|owner_id|user_id)\b/i;
const clean = (s) => s.replace(/\s+/g, " ").trim();

// Keep offsets and newlines stable, ignoring comments but not string values:
// changing an error status or SQL string can itself weaken a check.
function uncomment(text, python, sql) {
  return text.replace(/("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\*[\s\S]*?\*\/|\/\/[^\n]*|--[^\n]*|#[^\n]*)/g,
    (all, literal, comment) => literal ? literal : ((!python && comment.startsWith("#")) || (!sql && comment.startsWith("--")) ? comment : comment.replace(/[^\n]/g, " ")));
}

function candidates(text, file) {
  const python = /\.pyi?$/i.test(file), sql = /\.sql$/i.test(file);
  if (!python && !sql && !/\.(?:[cm]?[jt]sx?)$/i.test(file)) return [];
  text = uncomment(text, python, sql);
  const lines = text.split("\n"), out = [];
  const add = (kind, line, body) => out.push({ kind, line: line + 1, signature: clean(body) });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], trimmed = line.trim();
    const code = line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "");
    if (!trimmed || /^(?:#|--|['"`])/.test(trimmed)) continue;
    if (!sql && /\b(?:if|elif)\s*\(?/.test(code)) {
      let body = line, end = i;
      if (python) {
        const indent = line.match(/^\s*/)[0].length;
        let balance = (line.match(/[([{]/g)?.length ?? 0) - (line.match(/[)\]}]/g)?.length ?? 0);
        while (end + 1 < lines.length && (balance > 0 || !lines[end + 1].trim() || lines[end + 1].match(/^\s*/)[0].length > indent || /\\\s*$/.test(lines[end]))) {
          const part = lines[++end]; body += `\n${part}`;
          balance += (part.match(/[([{]/g)?.length ?? 0) - (part.match(/[)\]}]/g)?.length ?? 0);
        }
      } else {
        // Track brackets across multiline conditions and bodies. Unbraced
        // guards include their following statement as well.
        let depth = 0, opened = false;
        do {
          const part = lines[end].replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "");
          for (const ch of part) { if ("({[".includes(ch)) { depth++; opened = true; } else if (")}]".includes(ch)) depth--; }
          if (opened && depth <= 0 && (EXIT.test(body) || /[;}]\s*$/.test(part))) break;
          if (end + 1 >= lines.length) break;
          body += `\n${lines[++end]}`;
        } while (end < lines.length - 1);
      }
      // Include the whole guard so changing its condition while leaving its
      // return in place is still detected. False positives demand review.
      const condition = body.split(/\b(?:raise|throw|return)\b/)[0].replace(/([a-z])([A-Z])/g, "$1 $2");
      if (ACCESS.test(condition) && EXIT.test(body)) add("guard", i, body);
    }
    if (!sql && /(?:@|\b)(?:login_required|permission_required|requireAuth|requirePermission|requireRole|isAuthenticated|ensureAuthenticated)\b/.test(code)) add("middleware", i, line);
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
      while (end + 1 < lines.length && (orm ? balance > 0 : !lines[end].includes(";"))) {
        const part = lines[++end]; body += `\n${part}`;
        balance += (part.match(/\(/g)?.length ?? 0) - (part.match(/\)/g)?.length ?? 0);
      }
      if (TENANT.test(body)) add("tenant-filter", i, body);
    }
    if (/\b(?:(?:CREATE|ALTER)\s+POLICY|(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY)\b/i.test(line) ||
        (sql && /^\s*(?:CREATE|ALTER|ENABLE|FORCE)\s*$/.test(line) && /^(?:CREATE|ALTER)\s+POLICY\b|^(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i.test(lines.slice(i, i + 8).join("\n").trim()))) {
      const rest = lines.slice(i).join("\n");
      add("rls", i, /;/.test(rest) ? rest.split(";")[0] : line);
    }
  }
  return out;
}

const descriptions = {
  guard: "an access guard", middleware: "authentication or permission middleware",
  validation: "an assertion or validation", "tenant-filter": "a tenant or ownership filter", rls: "a row-level security policy",
};

export function detectRemovedChecks(fileChanges = []) {
  const findings = [];
  for (const { file, before, after } of fileChanges) {
    const remaining = new Map();
    for (const item of candidates(decodeTrustBytes(after), file)) {
      const key = `${item.kind}:${item.signature}`;
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    for (const { kind, line, signature } of candidates(decodeTrustBytes(before), file)) {
      const key = `${kind}:${signature}`, count = remaining.get(key) ?? 0;
      if (count) { remaining.set(key, count - 1); continue; }
      findings.push({ kind, file, line, reason: `Removes or changes ${descriptions[kind]} at ${clean(file)}:${line}.` });
    }
  }
  return [...new Map(findings.map((f) => [JSON.stringify(f), f])).values()];
}
