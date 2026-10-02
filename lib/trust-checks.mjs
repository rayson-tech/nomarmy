// Conservative syntax scanning of raw snapshots, independent of Git attributes.
import { lineDiff } from "./line-diff.mjs";
import { decodeTrustBytes } from "./trust.mjs";
import { classifyTrustFiles, isTrustSourceFile } from "./trust-files.mjs";
export { isTestFile } from "./trust-files.mjs";

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
const maskDollars = text => text.replace(/\$([A-Za-z_][A-Za-z0-9_]*|)\$[\s\S]*?\$\1\$/g, s => s.replace(/[^\n]/g, " "));

function uncomment(text, python, sql, hashComments = python) {
  const pattern = python
    ? /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[^\n]*/g
    : /\$([A-Za-z_][A-Za-z0-9_]*|)\$[\s\S]*?\$\1\$|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|--[^\n]*|#[^\n]*/g;
  return text.replace(pattern, all => /^["'`$]/.test(all) ||
    (!hashComments && !sql && all.startsWith("#")) || (!sql && all.startsWith("--"))
    ? all : all.replace(/[^\n]/g, " "));
}

// Values can be nested or wrapped in spread and conditional expressions.
// Strings and comments have already been masked before this pass.
function authArgumentLines(code) {
  const found = new Set();
  let depth = 0, line = 0;
  for (const [token] of code.matchAll(/[()[\]]|\n|[A-Za-z_$][\w$]*/g)) {
    if (token === "\n") line++;
    else if (token === "(" || token === "[") depth++;
    else if (token === ")" || token === "]") depth = Math.max(0, depth - 1);
    else if (depth > 0 && AUTH_NAME.test(token)) found.add(line);
  }
  return found;
}

function candidates(text, file, tenantColumns, referencedDoc = false) {
  const python = /\.pyi?$/i.test(file) || (referencedDoc && /^\s*(?:if\b[^\n]*:|assert\b)/m.test(text));
  const sql = /\.sql$/i.test(file) || (referencedDoc && !python && /\b(?:SELECT|WHERE|POLICY)\b/i.test(text));
  if (!sql && !referencedDoc && !isTrustSourceFile(file)) return [];
  text = uncomment(text, python, sql, python || /\.(?:rb|sh)$/i.test(file));
  const mask = value => maskStrings(sql ? maskDollars(value) : value);
  const lines = text.split("\n"), codeLines = mask(text).split("\n"), out = [];
  const authValues = authArgumentLines(codeLines.join("\n"));
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
            if (!/\belse\s*$/.test(part) && !/^\s*else\b/.test(codeLines[next] ?? "")) break;
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
        (authValues.has(i) || [...code.matchAll(/(?:@\s*|[(,\[]\s*|^\s*)([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g)].some((match) => AUTH_NAME.test(match[1])))) add("middleware", i, line);
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
        const endOfStatement = mask(body).indexOf(";");
        if (endOfStatement >= 0) body = body.slice(0, endOfStatement + 1);
      }
      if ((body.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []).some((name) => tenantColumns.has(name.toLowerCase()))) add("tenant-filter", i, body);
    }
    if (/\b(?:(?:CREATE|ALTER)\s+POLICY|(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY)\b/i.test(line) ||
        (sql && /^\s*(?:CREATE|ALTER|ENABLE|FORCE)\s*$/.test(line) && /^(?:CREATE|ALTER)\s+POLICY\b|^(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i.test(lines.slice(i, i + 8).join("\n").trim()))) {
      const rest = lines.slice(i).join("\n");
      const endOfStatement = mask(rest).indexOf(";");
      add("rls", i, endOfStatement >= 0 ? rest.slice(0, endOfStatement) : line);
    }
  }
  return out;
}

const descriptions = {
  guard: "an access guard", middleware: "authentication or permission middleware",
  validation: "an assertion or validation", "tenant-filter": "a tenant or ownership filter", rls: "a row-level security policy",
};

// Lexical function ranges only. Masked comments/literals keep their offsets so
// nested callbacks and methods do not donate exits to an enclosing function.
function functionRanges(code, python) {
  const ranges = [];
  if (python) {
    const lines = code.split("\n");
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(?:async\s+)?def\s+\w+\s*\(/.test(line)) {
        const indent = line.match(/^\s*/)[0].length;
        let end = i + 1, balance = 0, headerEnd = i;
        // The header can span multiple lines, including unindented parameters.
        for (let j = i; j < lines.length; j++) {
          for (const ch of lines[j]) {
            if ("([{".includes(ch)) balance++;
            else if (")]}".includes(ch)) balance--;
          }
          headerEnd = j;
          if (balance <= 0 && lines[j].includes(":")) break;
        }
        end = headerEnd + 1;
        while (end < lines.length && (!lines[end].trim() || lines[end].match(/^\s*/)[0].length > indent)) end++;
        ranges.push({ start: offset, end: offset + lines.slice(i, end).join("\n").length });
      }
      offset += line.length + 1;
    }
    return ranges;
  }
  const tokens = [...code.matchAll(/=>|[A-Za-z_$][\w$]*|[^\s]/g)];
  const parens = [], braces = [], closed = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i][0];
    if (token === "(") parens.push(i);
    if (token === ")" && parens.length) closed.set(i, parens.pop());
    if (token === "{") {
      let previous = i - 1;
      // TypeScript return annotations between a parameter list and its body.
      if (/^[\w$\[\]|<>?:.,]+$/.test(tokens[previous]?.[0] ?? "")) {
        while (previous >= 0 && ![";", "{", "}", ")", "=>", "="].includes(tokens[previous][0])) previous--;
      }
      let isFunction = tokens[previous]?.[0] === "=>";
      if (tokens[previous]?.[0] === ")" && closed.has(previous)) {
        const open = closed.get(previous), name = tokens[open - 1]?.[0];
        isFunction = !!name && !(name === "await" && tokens[open - 2]?.[0] === "for") &&
          !/^(?:if|for|while|switch|catch|with)$/.test(name) &&
          (/^[A-Za-z_$][\w$]*$/.test(name) || name === "*");
      }
      braces.push({ start: tokens[i].index, isFunction });
    }
    if (token === "}" && braces.length) {
      const scope = braces.pop();
      if (scope.isFunction) ranges.push({ start: scope.start, end: tokens[i].index });
    }
  }
  return ranges;
}

function detectBypasses(before, after, file, oldCandidates, newCandidates) {
  if (before === after || !/\.(?:[cm]?[jt]sx?|pyi?)$/i.test(file)) return [];
  const python = /\.pyi?$/i.test(file);
  const oldLines = uncomment(before, python, false).split("\n");
  const newLines = uncomment(after, python, false).split("\n");
  const code = maskStrings(newLines.join("\n"));
  const ranges = functionRanges(code, python);
  const owner = offset => ranges.filter(r => r.start <= offset && offset < r.end)
    .sort((a, b) => b.start - a.start)[0];
  const added = new Set(), unchanged = new Map();
  let oldLine = 1, newLine = 1;
  for (const edit of lineDiff(oldLines.map(clean), newLines.map(clean))) {
    if (edit.prefix === "+") added.add(newLine);
    if (edit.prefix === " ") unchanged.set(newLine, oldLine);
    if (edit.prefix !== "+") oldLine++;
    if (edit.prefix !== "-") newLine++;
  }
  const offsets = [];
  let offset = 0;
  for (const line of newLines) { offsets.push(offset); offset += line.length + 1; }
  const targets = newCandidates.filter(c => ["guard", "tenant-filter", "validation"].includes(c.kind) &&
    oldCandidates.some(old => old.line === unchanged.get(c.line) && old.kind === c.kind && old.signature === c.signature))
    .map(c => ({ ...c, scope: owner(offsets[c.line - 1] + newLines[c.line - 1].search(/\S/)) }));
  const findings = [];
  const codeLines = code.split("\n");
  for (const line of added) {
    for (const exit of codeLines[line - 1].matchAll(/\b(?:return|raise|throw|continue|break)\b/g)) {
      // Member names, including spaced and optional chaining, are not exits.
      if (/\.\s*$/.test(code.slice(0, offsets[line - 1] + exit.index))) continue;
      const scope = owner(offsets[line - 1] + exit.index);
      const target = targets.find(c => c.line > line && scope && c.scope === scope);
      if (!target) continue;
      findings.push({ kind: "bypass", file, line,
        reason: `Adds an early exit before ${descriptions[target.kind]} at ${clean(file)}:${line}.` });
      break;
    }
  }
  return findings;
}

// This pattern detector compares syntax, not proven reachability. It also flags
// added exits before unchanged guards, tenant filters or validations in the same function.
// Checks moved into unused helpers and other control-flow bypasses still need
// judgment and phase 3 reachability analysis.
export function detectRemovedChecks(fileChanges = [], { tenantColumns = [], classification = null, repository, worktree } = {}) {
  classification ??= classifyTrustFiles(fileChanges, { repository, worktree });
  const columns = new Set([...TENANT_COLUMNS, ...tenantColumns].map((name) => name.toLowerCase()));
  const findings = [];
  for (const { file, before, after } of fileChanges) {
    const oldText = decodeTrustBytes(before), newText = decodeTrustBytes(after);
    const oldCandidates = candidates(oldText, file, columns, classification.isReferencedDoc(file));
    const newCandidates = candidates(newText, file, columns, classification.isReferencedDoc(file));
    findings.push(...detectBypasses(oldText, newText, file, oldCandidates, newCandidates).map(item => ({
      ...item, ...(classification.isTest(file) ? { informational: true, reason: "in test code" } : {}),
    })));
    const remaining = new Map();
    for (const item of newCandidates) {
      const key = `${item.kind}:${item.signature}`;
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    for (const { kind, line, signature } of oldCandidates) {
      const key = `${kind}:${signature}`, count = remaining.get(key) ?? 0;
      if (count) { remaining.set(key, count - 1); continue; }
      findings.push({ kind, file, line, reason: `Removes or changes ${descriptions[kind]} at ${clean(file)}:${line}.`,
        ...(classification.isTest(file) ? { informational: true, reason: "in test code" } : {}) });
    }
  }
  return [...new Map(findings.map((f) => [JSON.stringify(f), f])).values()];
}
