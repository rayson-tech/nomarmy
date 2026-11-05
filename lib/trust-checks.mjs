// Conservative syntax scanning of raw snapshots, independent of Git attributes.
import { lineDiff } from "./line-diff.mjs";
import { decodeTrustBytes } from "./trust.mjs";
import { classifyTrustFiles, isTrustSourceFile } from "./trust-files.mjs";
export { isTestFile } from "./trust-files.mjs";

const ACCESS = /\b(?:auth(?:entication|enticated|orization|orized)?|permissions?|roles?|scopes?|owners?|tenants?|org|organization|admin|allowed|authorized|(?:logged|signed)[_\s]?in|can_\w+|is_\w+)(?:_\w+)?\b/i;
// A missing session or user is the usual login guard (`if (!session)`,
// `if not current_user`, `user is None`). A property read (`user.name`) is not.
const SESSION_CHECK = /(?:!\s*|\bnot\s+)(?:[\w$]+\s*\??\.\s*)*(?:session|(?:current[_\s]?)?user|viewer)\b(?!\s*(?:\.|\[|\())|\b(?:session|(?:current[_\s]?)?user)\s*(?:is\s+None|===?\s*(?:null|undefined))/i;
const accessCondition = (condition) => ACCESS.test(condition) || SESSION_CHECK.test(condition);
// Framework helpers that end the request by throwing (Next.js, Remix).
const EXIT = /\b(?:raise|throw|return)\b|\b(?:redirect|permanentRedirect|notFound|unauthorized|forbidden)\s*\(/;
const TENANT_COLUMNS = ["tenant_id", "org_id", "owner_id", "user_id", "account_id", "workspace_id", "company_id", "customer_id", "team_id", "project_id"];
const AUTH_NAME = /auth|log(?:ged)?_?in|signed_?in|permission|require_|guard|policy|role|scope|admin|staff|superuser|jwt|get_?current_?\w*user|(?:verify|validate|check)_?token/i;
// A post's author is data, not auth: `post.author`, `i.authorName`. Middleware
// named for authors (`authorOnly`, `requireAuthor`) still counts.
const AUTHOR_DATA = /^author(?:s|name|_name|id|_id|email|_email|ed|ing)?$/i;
// A bare data word (`role`, `roles`, `scope`, `admin`, `policy`) names a value
// passed along (`role.agent`, `{ role: role }`), not middleware; compound
// names (`requireRole`, `checkScope`, `adminOnly`) and decorators
// (`@Roles('admin')`) still count.
const DATA_WORD = /^(?:roles?|scopes?|polic(?:y|ies)|permissions?|admins?|staff|owners?|guards?|logins?)$/i;
const isAuthName = (name, { decorator = false } = {}) => {
  const parts = name.split(".").map((part) => part.trim()).filter((part) => !AUTHOR_DATA.test(part) && (decorator || !DATA_WORD.test(part)));
  return parts.length > 0 && AUTH_NAME.test(parts.join("."));
};
const AUTH_ERROR = /\b\w*(?:Auth\w*|Forbidden|PermissionDenied|PermissionError)\w*\b/i;
const DENIAL = /\babort\s*\(\s*(?:401|403|404)\b|\.\s*(?:sendStatus|status)\s*\(\s*(?:401|403)\b|\b(?:HttpResponseForbidden|PermissionDenied|Unauthorized|Forbidden)\s*\(|\b(?:raise|throw)\s+(?:new\s+)?(?:PermissionDenied|Unauthorized|Forbidden)\b|\bstatus(?:_?code|Code)?\s*[:=]\s*(?:401|403)\b/;
// JavaScript, TypeScript and Python quotes never span a line (an escaped
// newline aside). Letting them do so paired the apostrophes in JSX copy
// ("Don't share", "It's private") into one long string and masked the real
// code between them, so a removed <RequireAuth> went unflagged. SQL, shell
// and other quotes can span lines and keep doing so.
const SINGLE_LINE_QUOTES = /\.(?:[cm]?[jt]sx?|pyi?)$/i;
const MASK_STRINGS = /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|""|[^"\\])*"|'(?:\\.|''|[^'\\])*'|`(?:\\.|[^`\\])*`/g;
const MASK_STRINGS_1L = /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\[\s\S]|""|[^"\\\n])*"|'(?:\\[\s\S]|''|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g;
const maskStrings = (text, singleLine = false) => text.replace(singleLine ? MASK_STRINGS_1L : MASK_STRINGS,
  (literal) => literal.replace(/[^\n]/g, " "));
const denial = (body, authCondition = false) => DENIAL.test(body) ||
  (/\bnext\s*\(/.test(body) && (authCondition || AUTH_ERROR.test(body)));
const clean = (s) => s.replace(/\s+/g, " ").trim();
const MULTILINE_QUOTES = ["\"\"\"", "'''", "`"];
// How far an open statement may extend a WHERE filter's body.
const STATEMENT_LINES = 40, STATEMENT_HARD_LINES = 400;
const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
// Statements that switch row-level security off or loosen a policy. They are
// additions, so the removed-check comparison alone never sees them.
const RLS_WEAKEN = /\bDROP\s+POLICY\b|\b(?:DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b|\bALTER\s+POLICY\b/i;

// Keep offsets and newlines stable, ignoring comments but not string values:
// changing an error status or SQL string can itself weaken a check.
const maskDollars = text => text.replace(/\$([A-Za-z_][A-Za-z0-9_]*|)\$[\s\S]*?\$\1\$/g, s => s.replace(/[^\n]/g, " "));

function uncomment(text, python, sql, hashComments = python, shell = false, singleLine = false) {
  const pattern = python
    ? /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'|#[^\n]*/g
    : singleLine
      ? /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*/g
      : /\$([A-Za-z_][A-Za-z0-9_]*|)\$[\s\S]*?\$\1\$|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|--[^\n]*|#[^\n]*/g;
  // A shell hash starts a comment only at a word boundary. Do not consume
  // parameter hashes, so a later real comment on the same line still matches.
  const comments = shell ? new RegExp(pattern.source.replace("#[^\\n]*", "(?<![^\\s;&|(])#[^\\n]*"), "g") : pattern;
  return text.replace(comments, all => /^["'`$]/.test(all) ||
    (!hashComments && !sql && all.startsWith("#")) || (!sql && all.startsWith("--"))
    ? all : all.replace(/[^\n]/g, " "));
}

// Values can be nested or wrapped in spread and conditional expressions.
// Strings and comments have already been masked before this pass.
// Inside an object literal, a key (`roles:`) or shorthand property
// (`{ agents, roles }`) is data passed along, not middleware; a value
// (`{ preHandler: requireAuth }`) still counts.
function authArgumentLines(code) {
  const found = new Set();
  const stack = [];
  let line = 0;
  const prevChar = (at) => { let p = at - 1; while (p >= 0 && /\s/.test(code[p])) p--; return code[p] ?? ""; };
  const nextChar = (at) => { let p = at; while (p < code.length && /\s/.test(code[p])) p++; return code[p] ?? ""; };
  for (const match of code.matchAll(/[()[\]{}]|\n|[A-Za-z_$][\w$]*/g)) {
    const token = match[0];
    if (token === "\n") line++;
    else if ("([{".includes(token)) stack.push(token);
    else if (")]}".includes(token)) stack.pop();
    else if (stack.some((s) => s !== "{") && isAuthName(token)) {
      if (stack.at(-1) === "{") {
        const after = nextChar(match.index + token.length), before = prevChar(match.index);
        const defaulted = after === "=" && !/^=[=>]/.test(code.slice(code.indexOf("=", match.index + token.length), code.indexOf("=", match.index + token.length) + 2));
        if (after === ":" || ((after === "," || after === "}" || defaulted) && (before === "{" || before === ","))) continue;
      }
      found.add(line);
    }
  }
  return found;
}

// JSX children that are plain copy ("Permissions control who can see this
// board.") are text, not identifiers, but the middleware pattern reads a
// line-leading word like "Permissions" as a removed auth decorator. Blank a
// run of such lines only when JSX surrounds it: the line before ends a tag
// (">" but not "=>") and the line after opens a tag or expression. Code in
// JSX children must sit in braces, so a bare run there is always text. A
// keyword-led or punctuated line is never blanked: missing a real check is
// worse than a false alarm.
const JSX_FILE = /\.(?:jsx|tsx|js)$/i;
const PROSE_LINE = /^\s*[^\s{}<>()=;`"[\]]+(?:\s+[^\s{}<>()=;`"[\]]+)*\s*$/;
const CODE_KEYWORD = /^\s*(?:export|return|await|yield|const|let|var|new|typeof|async|default|import|case|throw|else|extends|delete|void|in|of)\b/;
// Whether line k ends a JSX tag: `<p>`, `</p>`, `<br/>`, `<>`, `<A b="c">`, or a
// lone `>` closing a tag opened on an earlier line. A comparison (`score >`)
// is not one.
// A tag's "<" never directly follows a name or closing bracket; a comparison's does (`low<score >`).
const TAG_END = /(?<![\w$)\]])(?:<[A-Za-z][\w.:-]*(?:\s[^<>]*)?|<\/[A-Za-z][\w.:-]*\s*|<)\/?>\s*$/;
function endsJsxTag(lines, k) {
  if (TAG_END.test(lines[k])) return true;
  if (!/^\s*\/?>\s*$/.test(lines[k])) return false;
  for (let j = k - 1; j >= Math.max(0, k - 20); j--) {
    if (/[<>;{}]/.test(lines[j].replace(/^\s*<[A-Za-z][\w.:-]*/, ""))) return false;
    if (/^\s*<[A-Za-z][\w.:-]*(?:\s|$)/.test(lines[j])) return true;
  }
  return false;
}
function maskJsxText(text) {
  const lines = text.split("\n");
  const prose = (l) => PROSE_LINE.test(l) && !CODE_KEYWORD.test(l);
  for (let i = 0; i < lines.length; i++) {
    if (!prose(lines[i])) continue;
    let end = i;
    while (end + 1 < lines.length && (prose(lines[end + 1]) || !lines[end + 1].trim())) end++;
    let before = i - 1; while (before >= 0 && !lines[before].trim()) before--;
    let after = end + 1; while (after < lines.length && !lines[after].trim()) after++;
    const opens = before >= 0 && endsJsxTag(lines, before);
    const closes = after < lines.length && /^\s*[<{]/.test(lines[after]);
    if (opens && closes) for (let k = i; k <= end; k++) lines[k] = lines[k].replace(/[^\n]/g, " ");
    i = end;
  }
  return lines.join("\n");
}

function candidates(text, file, tenantColumns, referencedDoc = false) {
  const python = /\.pyi?$/i.test(file) || (referencedDoc && /^\s*(?:if\b[^\n]*:|assert\b)/m.test(text));
  const sql = /\.sql$/i.test(file) || (referencedDoc && !python && /\b(?:SELECT|WHERE|POLICY)\b/i.test(text));
  if (!sql && !referencedDoc && !isTrustSourceFile(file)) return [];
  const singleLine = !sql && SINGLE_LINE_QUOTES.test(file);
  text = uncomment(text, python, sql, python || /\.(?:rb|sh)$/i.test(file), /\.sh$/i.test(file), singleLine);
  if (!python && !sql && JSX_FILE.test(file)) text = maskJsxText(text);
  const mask = value => maskStrings(sql ? maskDollars(value) : value, singleLine);
  const lines = text.split("\n"), codeLines = mask(text).split("\n"), out = [];
  const authValues = authArgumentLines(codeLines.join("\n"));
  // Parenthesis/bracket depth after each line, strings masked: a statement
  // (`q = ("... WHERE "` / `"tenant_id = %s")`) continues while it is open.
  const depthAfter = [];
  for (let k = 0, d = 0; k < codeLines.length; k++) {
    d = Math.max(0, d + (codeLines[k].match(/[([]/g)?.length ?? 0) - (codeLines[k].match(/[)\]]/g)?.length ?? 0));
    depthAfter.push(d);
  }
  // The multi-line string (triple quote or template) open at the start of each line.
  const openQuotes = [];
  for (let k = 0, state = null; k < lines.length; k++) {
    openQuotes.push(state);
    for (const q of MULTILINE_QUOTES) {
      if ((lines[k].split(q).length - 1) % 2 === 0) continue;
      if (state === q) state = null; else if (state === null) state = q;
    }
  }
  let guardEnd = -1;
  const add = (kind, line, body) => out.push({ kind, line: line + 1, end: line + body.split("\n").length, signature: clean(body) });
  const ruby = /\.rb$/i.test(file);
  // Ruby passes filters as symbols: `before_action :authenticate_user!`.
  // Decorators and line-leading names. Names in argument lists come from
  // authArgumentLines, which knows an object literal's keys from its values.
  const NAMES = ruby ? /(?:@\s*|^\s*|(?<![\w:]):)([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g
    : /(?:@\s*|^\s*)([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], trimmed = line.trim();
    const code = codeLines[i];
    if (!trimmed || /^(?:#|--)/.test(trimmed)) continue;
    // A line that is only a string (`"SELECT ... WHERE "` inside a call) holds
    // no code, but its SQL filter and RLS statements still count.
    const quoted = /^['"`]/.test(trimmed);
    if (!quoted && !sql && i > guardEnd && /\b(?:if|elif)\s*\(?/.test(code)) {
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
      const guardCode = maskStrings(body, singleLine);
      const condition = guardCode.split(/\b(?:raise|throw|return)\b/)[0].replace(/([a-z])([A-Z])/g, "$1 $2");
      if ((accessCondition(condition) && EXIT.test(guardCode)) || denial(guardCode, accessCondition(condition))) {
        add("guard", i, body);
        guardEnd = end;
      }
    }
    if (!quoted && !sql && i > guardEnd && denial(code)) add("guard", i, line);
    // Match decorator and middleware identifiers, not arbitrary auth variables
    // in a condition or string literal. Names are deliberately extensible.
    if (!quoted && !sql && i > guardEnd && !denial(code) && !/\b(?:if|elif)\s*\(?/.test(code) &&
        (authValues.has(i) || [...code.matchAll(NAMES)].some((match) => isAuthName(match[1], { decorator: match[0].trimStart().startsWith("@") })))) add("middleware", i, line);
    if (!quoted && !sql && /\b(?:assert\b|(?:assert\w*|validate\w*|\w+_validate|\w+_validation)\s*\(|\w+\.validate\s*\()/i.test(code)) {
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
      // Outside SQL files a WHERE sits in a string, which ends with its line
      // unless a triple-quoted or template string stays open; Python and
      // semicolon-free JS never reach a ";", so waiting for one took in the
      // rest of the file and any later edit "changed" the filter.
      const inside = openQuotes[i];
      const quote = !sql && !orm ? inside ?? MULTILINE_QUOTES.find((q) => (line.split(q).length - 1) % 2 === 1) : undefined;
      const closes = (k) => lines[k].includes(quote) && (inside || k > i);
      const startDepth = i > 0 ? depthAfter[i - 1] : 0;
      // Blank lines don't count toward the statement cap; a hard cap still bounds the work.
      let spent = 0;
      const continues = (k) => {
        if (k - i >= STATEMENT_HARD_LINES) return false;
        if (quote && !closes(k)) return true;
        if (lines[k].trim()) spent++;
        return spent <= STATEMENT_LINES && depthAfter[k] > 0 && depthAfter[k] >= startDepth;
      };
      while (end + 1 < lines.length && (orm ? balance > 0 : sql ? !codeLines[end].includes(";") : continues(end))) {
        const part = lines[++end]; body += `\n${part}`;
        balance += (part.match(/\(/g)?.length ?? 0) - (part.match(/\)/g)?.length ?? 0);
      }
      if (!orm) {
        const endOfStatement = mask(body).indexOf(";");
        if (endOfStatement >= 0) body = body.slice(0, endOfStatement + 1);
      }
      if ((body.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []).some((name) => tenantColumns.has(name.toLowerCase()) || tenantColumns.has(snake(name)))) add("tenant-filter", i, body);
    }
    if (/\b(?:(?:CREATE|ALTER)\s+POLICY|(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY)\b/i.test(line) ||
        (sql && /^\s*(?:CREATE|ALTER|ENABLE|FORCE)\s*$/.test(line) && /^(?:CREATE|ALTER)\s+POLICY\b|^(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i.test(lines.slice(i, i + 8).join("\n").trim()))) {
      const rest = lines.slice(i).join("\n");
      const endOfStatement = mask(rest).indexOf(";");
      add("rls", i, endOfStatement >= 0 ? rest.slice(0, endOfStatement) : line);
    }
    if (RLS_WEAKEN.test(line)) {
      const rest = lines.slice(i).join("\n");
      const endOfStatement = mask(rest).indexOf(";");
      add("rls-weaken", i, endOfStatement >= 0 ? rest.slice(0, endOfStatement) : line);
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
  // A return-type annotation (`): { ok: boolean } {`) can hold braces of its
  // own. After `)` `:`, a brace where a type is expected opens a type literal;
  // the first brace where one is not opens the function body.
  const typeBraces = new Set(), bodyBraces = new Set();
  const EXPECTS_TYPE = new Set([":", "|", "&", "<", "(", "[", ",", "?", "keyof", "typeof", "readonly"]);
  const openOf = new Map();
  for (let i = 0, stack = []; i < tokens.length; i++) {
    if (tokens[i][0] === "(") stack.push(i);
    else if (tokens[i][0] === ")" && stack.length) openOf.set(i, stack.pop());
  }
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i][0] !== ")" || tokens[i + 1][0] !== ":") continue;
    // After a named function's or method's parameters, `=>` belongs to a
    // function type (`function f(x): () => { ok: boolean } {`); after an
    // arrow function's, it ends the annotation.
    let at = (openOf.get(i) ?? 0) - 1;
    if (tokens[at]?.[0] === ">") for (let depth = 0; at >= 0; at--) {
      if (tokens[at][0] === ">") depth++;
      else if (tokens[at][0] === "<" && --depth === 0) { at--; break; }
    }
    const before = tokens[at]?.[0] ?? "";
    const named = /^[A-Za-z_$][\w$]*$/.test(before) && before !== "async";
    let depth = 0, expectType = true;
    for (let j = i + 2; j < tokens.length; j++) {
      const t = tokens[j][0];
      if (depth === 0 && [";", "=", ")", ",", "}"].includes(t)) break;
      if (depth === 0 && t === "=>" && !named) break;
      if (t === "{" && depth === 0) {
        if (!expectType) { bodyBraces.add(j); break; }
        typeBraces.add(j);
      }
      if ("<([{".includes(t)) depth++;
      else if (">)]}".includes(t)) depth--;
      expectType = EXPECTS_TYPE.has(t) || t === "{" || t === "=>";
    }
  }
  const parens = [], braces = [], closed = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i][0];
    if (token === "(") parens.push(i);
    if (token === ")" && parens.length) closed.set(i, parens.pop());
    if (token === "{" && (typeBraces.has(i) || bodyBraces.has(i))) {
      braces.push({ start: tokens[i].index, isFunction: bodyBraces.has(i) });
      continue;
    }
    if (token === "{") {
      let previous = i - 1;
      // TypeScript return annotations between a parameter list and its body.
      if (/^[\w$\[\]|<>?:.,]+$/.test(tokens[previous]?.[0] ?? "")) {
        while (previous >= 0 && ![";", "{", "}", ")", "=>", "="].includes(tokens[previous][0])) previous--;
      }
      let isFunction = tokens[previous]?.[0] === "=>";
      if (tokens[previous]?.[0] === ")" && closed.has(previous)) {
        // Skip type parameters: `function f<T>(` and `function <T>(`.
        const open = closed.get(previous);
        let nameAt = open - 1;
        if (tokens[nameAt]?.[0] === ">") {
          for (let depth = 0; nameAt >= 0; nameAt--) {
            const t = tokens[nameAt][0];
            if (t === ">") depth++;
            else if (t === "<" && --depth === 0) { nameAt--; break; }
          }
        }
        const name = tokens[nameAt]?.[0];
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
  const oldLines = uncomment(before, python, false, python, false, true).split("\n");
  const newLines = uncomment(after, python, false, python, false, true).split("\n");
  const code = maskStrings(newLines.join("\n"), true);
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
  const oldByLine = groupBy(oldCandidates, (c) => c.line);
  const targets = newCandidates.filter(c => ["guard", "tenant-filter", "validation"].includes(c.kind) &&
    (oldByLine.get(unchanged.get(c.line)) ?? []).some(old => old.kind === c.kind && old.signature === c.signature))
    .map(c => ({ ...c, scope: owner(offsets[c.line - 1] + newLines[c.line - 1].search(/\S/)) }));
  const findings = [];
  const codeLines = code.split("\n");
  const functionStarts = new Set(ranges.map((r) => r.start));
  let loopChecks = 0;
  for (const line of added) {
    for (const exit of codeLines[line - 1].matchAll(/\b(?:return|raise|throw|continue|break)\b/g)) {
      // Member names, including spaced, multiline and optional chaining, are not
      // exits. A dot that ends a number literal (1.) is not a member access.
      const at = offsets[line - 1] + exit.index, prefix = code.slice(Math.max(0, at - 200), at);
      if (/\.\s*$/.test(prefix) && !/(?<![\w$.])\d+\.\s*$/.test(prefix)) continue;
      // continue and break only skip the rest of their loop (break also its
      // switch). A labeled one can leave outer loops, so it counts as an exit.
      let limit = Infinity;
      if ((exit[0] === "continue" || exit[0] === "break") && ++loopChecks <= MAX_LOOP_CHECKS) {
        const labeled = !python && /^[ \t]+(?!(?:case|default)\b)[A-Za-z_$][\w$]*/.test(codeLines[line - 1].slice(exit.index + exit[0].length));
        if (!labeled) {
          limit = loopEnd(code, codeLines, offsets, line, at, python, exit[0], functionStarts);
          if (!limit) continue;
        }
      }
      const scope = owner(offsets[line - 1] + exit.index);
      const target = targets.find(c => c.line > line && c.line <= limit && scope && c.scope === scope);
      if (!target) continue;
      findings.push({ kind: "bypass", file, line,
        reason: `Adds an early exit before ${descriptions[target.kind]} at ${clean(file)}:${line}.` });
      break;
    }
  }
  const oldCode = maskStrings(oldLines.join("\n"), true);
  const old = { lines: oldLines, codeLines: oldCode.split("\n"), ranges: functionRanges(oldCode, python), offsets: offsetsOf(oldLines) };
  const now = { lines: newLines, codeLines, ranges, offsets };
  for (const side of [old, now]) side.headers = scopeHeaders(side, python, new Set(side.ranges.map((r) => r.start)));
  const oldToNew = new Map([...unchanged].map(([n, o]) => [o, n]));
  findings.push(...detectMoves(file, old, now, oldToNew, added, oldCandidates, newCandidates));
  findings.push(...detectSwallowed(file, now, code, python, added, oldCandidates, newCandidates));
  return findings;
}

// Qualified headers for each function range start, in one pass: JS by the
// enclosing brace blocks (each named by its line, or the line above a lone
// brace), Python by the enclosing class and def lines.
function scopeHeaders(side, python, starts) {
  const headers = new Map(), { codeLines, lines, offsets } = side;
  const lineText = (n) => {
    let k = n;
    if (clean(lines[k - 1] ?? "") === "{") { k--; while (k > 1 && !lines[k - 1].trim()) k--; }
    return clean(lines[k - 1] ?? "");
  };
  if (python) {
    const stack = [];
    let open = 0;
    codeLines.forEach((text, k) => {
      // Continuation lines of a bracketed header (`class A(\n object):`) are not new blocks.
      const continuation = open > 0;
      open = Math.max(0, open + (text.match(/[([{]/g)?.length ?? 0) - (text.match(/[)\]}]/g)?.length ?? 0));
      if (!text.trim() || continuation) return;
      const ind = text.search(/\S/);
      while (stack.length && stack.at(-1).ind >= ind) stack.pop();
      if (/^\s*(?:async\s+)?(?:def|class)\b/.test(text)) {
        stack.push({ ind, text: clean(lines[k]) });
        headers.set(offsets[k], stack.map((e) => e.text).join(" > "));
      }
    });
    return headers;
  }
  const code = codeLines.join("\n"), stack = [];
  for (let p = 0; p < code.length; p++) {
    if (code[p] === "{") { stack.push(starts.has(p) || stack.length < 64 ? lineText(lineAt(offsets, p)) : "{"); if (starts.has(p)) headers.set(p, stack.join(" > ")); }
    else if (code[p] === "}") stack.pop();
  }
  return headers;
}

// The table an RLS statement acts on: `ALTER TABLE x ...` or `... POLICY p ON x`.
const rlsTable = (signature) => (/\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w."]+)/i.exec(signature) ?? /\bPOLICY\s+[\w."]+\s+ON\s+([\w."]+)/i.exec(signature))?.[1]?.toLowerCase() ?? null;
const groupBy = (list, key) => { const out = new Map(); for (const item of list) { const k = key(item); if (!out.has(k)) out.set(k, []); out.get(k).push(item); } return out; };
const offsetsOf = (lines) => { const out = []; let at = 0; for (const line of lines) { out.push(at); at += line.length + 1; } return out; };
const lineAt = (offsets, offset) => { let lo = 0, hi = offsets.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offsets[mid] <= offset) lo = mid; else hi = mid - 1; } return lo + 1; };
const GUARDED = ["guard", "tenant-filter", "validation"];
// Bounds on the per-file work an adversarial diff can demand. Past them the
// file is flagged for review rather than scanned further.
const MAX_SCAN_CHARS = 1_000_000;
const MAX_MOVE_CHECKS = 200;
const MAX_TRY_CHECKS = 200;
const MAX_LOOP_CHECKS = 500;

// The last line of the innermost loop (for break, also switch) holding the
// exit at offset `at`, or 0 when there is none.
function loopEnd(code, codeLines, offsets, line, at, python, kind, functionStarts) {
  if (python) {
    let indent = codeLines[line - 1].search(/\S/);
    for (let k = line - 2; k >= 0; k--) {
      const text = codeLines[k];
      if (!text.trim()) continue;
      const ind = text.search(/\S/);
      if (ind >= indent) continue;
      if (/^\s*(?:async\s+)?(?:def|class)\b/.test(text)) return 0;
      if (/^\s*(?:async\s+)?(?:for|while)\b/.test(text)) {
        let end = k + 1;
        const past = () => { while (end < codeLines.length && (!codeLines[end].trim() || codeLines[end].search(/\S/) > ind)) end++; };
        past();
        // A break also skips the loop's else block.
        if (kind === "break" && end < codeLines.length && codeLines[end].search(/\S/) === ind && /^\s*else\s*:/.test(codeLines[end])) { end++; past(); }
        return end;
      }
      indent = ind;
    }
    return 0;
  }
  let depth = 0;
  for (let p = at - 1; p >= 0; p--) {
    const ch = code[p];
    if (ch === "}") { depth++; continue; }
    if (ch !== "{") continue;
    if (depth) { depth--; continue; }
    if (functionStarts.has(p)) return 0;
    const head = code.slice(0, p).replace(/\s+$/, "");
    let keyword = /(?:^|[^\w$])do$/.test(head) ? "do" : null;
    if (!keyword && head.endsWith(")")) {
      let d = 0, q = head.length - 1;
      for (; q >= 0; q--) { if (head[q] === ")") d++; else if (head[q] === "(" && --d === 0) break; }
      keyword = /([A-Za-z_$][\w$]*)(?:\s+await)?\s*$/.exec(head.slice(0, Math.max(0, q)))?.[1] ?? null;
    }
    if (/^(?:for|while|do)$/.test(keyword ?? "") || (kind === "break" && keyword === "switch")) {
      let d = 0, q = p;
      for (; q < code.length; q++) { if (code[q] === "{") d++; else if (code[q] === "}" && --d === 0) break; }
      return lineAt(offsets, q);
    }
  }
  return 0;
}

// A guard moved into another function, or code moved from after a guard to
// ahead of it, keeps every signature, so the removed-check comparison misses
// it. Each is reported at its after-line.
function detectMoves(file, old, now, oldToNew, added, oldCandidates, newCandidates) {
  const scopeAt = (side, line) => {
    const at = side.offsets[line - 1] + Math.max(0, side.lines[line - 1].search(/\S/));
    return side.ranges.filter((r) => r.start <= at && at < r.end).sort((a, b) => b.start - a.start)[0];
  };
  // A function's header, qualified by every enclosing block or Python
  // class/def, so `A.run` and `B.run` differ.
  const header = (side, range) => side.headers.get(range.start) ?? "";
  const meaningful = (codeLine) => /[A-Za-z_$][\w$]*\s*\(|[^=!<>]=(?!=)/.test(codeLine);
  const tally = (side, range, from, to) => {
    const counts = new Map();
    for (let l = Math.max(from, lineAt(side.offsets, range.start)); l <= Math.min(to, lineAt(side.offsets, range.end)); l++) {
      if (!meaningful(side.codeLines[l - 1])) continue;
      const text = clean(side.lines[l - 1]);
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    return counts;
  };
  const findings = [], used = new Set();
  // Only a guard whose function lost a line and gained one can have moved.
  // Prefix counts of removed (old) and added (new) lines, so whether a
  // function changed is one subtraction.
  const prefix = (count, has) => { const out = [0]; for (let l = 1; l <= count; l++) out.push(out[l - 1] + (has(l) ? 1 : 0)); return out; };
  const oldRemoved = prefix(old.lines.length, (l) => !oldToNew.has(l)), newAdded = prefix(now.lines.length, (l) => added.has(l));
  const touched = (side, range, counts) => counts[lineAt(side.offsets, range.end)] - counts[lineAt(side.offsets, range.start) - 1] > 0;
  const newByLine = groupBy(newCandidates, (c) => c.line);
  const addedBySignature = groupBy(newCandidates.filter((c) => added.has(c.line)), (c) => `${c.kind}:${c.signature}`);
  let checked = 0;
  for (const o of oldCandidates.filter((c) => GUARDED.includes(c.kind))) {
    const same = (c) => c.kind === o.kind && c.signature === o.signature;
    let n = (newByLine.get(oldToNew.get(o.line)) ?? []).find(same);
    const moved = !n;
    n ??= (addedBySignature.get(`${o.kind}:${o.signature}`) ?? []).find((c) => !used.has(c.line));
    if (!n) continue;
    used.add(n.line);
    const os = scopeAt(old, o.line), ns = scopeAt(now, n.line);
    if (!os || !ns) continue;
    if (!moved && !(touched(old, os, oldRemoved) && touched(now, ns, newAdded))) continue;
    if (++checked > MAX_MOVE_CHECKS) {
      findings.push({ kind: "unscanned", file, line: 1, reason: `Too many changed guards to check for moves at ${clean(file)}; review it.` });
      break;
    }
    if (moved && header(old, os) !== header(now, ns)) {
      findings.push({ kind: "bypass", file, line: n.line, reason: `Moves ${descriptions[o.kind]} into another function at ${clean(file)}:${n.line}.` });
      continue;
    }
    const oldBefore = tally(old, os, 1, o.line - 1), oldAfter = tally(old, os, o.end + 1, Infinity);
    const newAfter = tally(now, ns, n.end + 1, Infinity);
    for (let l = lineAt(now.offsets, ns.start); l < n.line; l++) {
      if (!meaningful(now.codeLines[l - 1])) continue;
      const text = clean(now.lines[l - 1]);
      if (!oldBefore.has(text) && (newAfter.get(text) ?? 0) < (oldAfter.get(text) ?? 0)) {
        findings.push({ kind: "bypass", file, line: l, reason: `Moves code ahead of ${descriptions[o.kind]} at ${clean(file)}:${l}.` });
        break;
      }
    }
  }
  return findings;
}

// An added try whose handler only passes, returns or logs swallows a check
// that already existed inside it: the check still runs but no longer stops
// anything. Reported at the added try.
const SWALLOW_PY = /^(?:pass|\.\.\.|continue|break|return(?:\s+None)?|(?:print|(?:\w+\.)*(?:log\w*|warn\w*|debug|info|error|exception))\s*\(.*)$/i;
const SWALLOW_JS = /^(?:(?:return\s*(?:null|undefined|false)?|(?:console|logger|log)\.\w+\s*\([^;]*\))\s*;?\s*)*$/;
function detectSwallowed(file, now, code, python, added, oldCandidates, newCandidates) {
  const findings = [], { codeLines, offsets } = now;
  const existing = (c) => GUARDED.includes(c.kind) && oldCandidates.some((o) => o.kind === c.kind && o.signature === c.signature);
  let checked = 0;
  for (const a of added) {
    if (!(python ? /^\s*try\s*:\s*$/ : /\btry\s*\{/).test(codeLines[a - 1])) continue;
    if (++checked > MAX_TRY_CHECKS) {
      findings.push({ kind: "unscanned", file, line: 1, reason: `Too many added try blocks to check at ${clean(file)}; review it.` });
      break;
    }
    let tryLast = 0, swallows = false;
    if (python) {
      const text = codeLines[a - 1];
      if (!/^\s*try\s*:\s*$/.test(text)) continue;
      const ind = text.search(/\S/);
      let e = a;
      while (e < codeLines.length && (!codeLines[e].trim() || codeLines[e].search(/\S/) > ind)) e++;
      tryLast = e;
      while (e < codeLines.length && codeLines[e].search(/\S/) === ind && /^\s*except\b/.test(codeLines[e])) {
        const body = [], inline = codeLines[e].replace(/^\s*except\b[^:]*:/, "").trim();
        if (inline) body.push(inline);
        let b = e + 1;
        for (; b < codeLines.length && (!codeLines[b].trim() || codeLines[b].search(/\S/) > ind); b++) if (codeLines[b].trim()) body.push(codeLines[b].trim());
        if (body.length && body.every((t) => SWALLOW_PY.test(t))) swallows = true;
        e = b;
      }
    } else {
      const m = /\btry\s*\{/.exec(codeLines[a - 1]);
      if (!m) continue;
      const match = (from) => { let d = 0, q = from; for (; q < code.length; q++) { if (code[q] === "{") d++; else if (code[q] === "}" && --d === 0) return q; } return -1; };
      const open = offsets[a - 1] + m.index + m[0].length - 1, close = match(open);
      if (close < 0) continue;
      tryLast = lineAt(offsets, close);
      const handler = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(code.slice(close + 1));
      if (!handler) continue;
      const catchOpen = close + 1 + handler[0].length - 1, catchClose = match(catchOpen);
      if (catchClose < 0) continue;
      swallows = SWALLOW_JS.test(code.slice(catchOpen + 1, catchClose).trim());
    }
    if (!swallows) continue;
    const hidden = newCandidates.find((c) => c.line > a && c.line <= tryLast && existing(c));
    if (hidden) findings.push({ kind: "bypass", file, line: a, reason: `Swallows errors from ${descriptions[hidden.kind]} at ${clean(file)}:${a}.` });
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
    // Too large to scan in bounded time: a review flag, never a silent pass.
    const scanned = isTrustSourceFile(file) || /\.sql$/i.test(file) || classification.isReferencedDoc(file);
    if (scanned && oldText !== newText && Math.max(oldText.length, newText.length) > MAX_SCAN_CHARS) {
      findings.push({ kind: "unscanned", file, line: 1, reason: `Too large to scan for removed checks (${Math.max(oldText.length, newText.length)} characters) at ${clean(file)}; review it.`,
        ...(classification.isTest(file) ? { informational: true, reason: "in test code" } : {}) });
      continue;
    }
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
    // An added DROP POLICY / DISABLE ROW LEVEL SECURITY / ALTER POLICY weakens
    // isolation by being there; it is reported at its after-line, like a bypass.
    const priorWeakening = new Map();
    for (const item of oldCandidates.filter((c) => c.kind === "rls-weaken")) priorWeakening.set(item.signature, (priorWeakening.get(item.signature) ?? 0) + 1);
    for (const item of newCandidates.filter((c) => c.kind === "rls-weaken")) {
      const count = priorWeakening.get(item.signature) ?? 0;
      if (count) { priorWeakening.set(item.signature, count - 1); continue; }
      findings.push({ kind: "bypass", file, line: item.line,
        reason: `Adds a statement that drops, disables or alters a row-level security policy at ${clean(file)}:${item.line}.`,
        ...(classification.isTest(file) ? { informational: true, reason: "in test code" } : {}) });
    }
    // The same RLS statements in a new order can end in a different state
    // (DISABLE after ENABLE), which no signature count notices.
    // Compared per table, so reordering statements on unrelated tables is not
    // flagged and an unrelated statement added elsewhere can't hide a reorder.
    const rlsByTable = (list) => groupBy(list.filter((c) => c.kind === "rls" || c.kind === "rls-weaken"), (c) => rlsTable(c.signature));
    const oldTables = rlsByTable(oldCandidates), newTables = rlsByTable(newCandidates);
    for (const [table, newRls] of newTables) {
      const oldRls = oldTables.get(table) ?? [];
      if (table === null || oldRls.length !== newRls.length || oldRls.length < 2) continue;
      const sorted = (list) => list.map((c) => `${c.kind}:${c.signature}`).sort().join("\n");
      const moved = newRls.find((c, k) => c.signature !== oldRls[k].signature || c.kind !== oldRls[k].kind);
      if (moved && sorted(oldRls) === sorted(newRls)) findings.push({ kind: "bypass", file, line: moved.line,
        reason: `Reorders row-level security statements for ${table} at ${clean(file)}:${moved.line}.`,
        ...(classification.isTest(file) ? { informational: true, reason: "in test code" } : {}) });
    }
    for (const { kind, line, signature } of oldCandidates) {
      if (kind === "rls-weaken") continue;
      const key = `${kind}:${signature}`, count = remaining.get(key) ?? 0;
      if (count) { remaining.set(key, count - 1); continue; }
      findings.push({ kind, file, line, reason: `Removes or changes ${descriptions[kind]} at ${clean(file)}:${line}.`,
        ...(classification.isTest(file) ? { informational: true, reason: "in test code" } : {}) });
    }
  }
  return [...new Map(findings.map((f) => [JSON.stringify(f), f])).values()];
}
