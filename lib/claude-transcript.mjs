// What a Claude CLI worker actually did, from Claude Code's own transcript.
//
// OpenClaw's claude-cli provider runs `claude -p` in the job's worktree, and
// Claude Code runs its own tools there, so OpenClaw's transcript never sees
// them (a real Senti scout: 44 tool calls, none in OpenClaw's record, so
// nomArmy could only check final citations, not what was read). Claude Code
// does record them itself, as one JSONL file per session under
// ~/.claude/projects/<the working directory, every non-alphanumeric
// character turned into "-">/ (confirmed from real job transcripts). This
// reads that file into the same summary shape lib/transcript.mjs produces
// from OpenClaw's, so read tracking and the heartbeat work unchanged.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Claude Code's tools that bring repository content into the worker's context.
const CLAUDE_REPO_READ_TOOLS = ["read", "grep", "glob", "bash", "ls", "notebookread"];

/** Claude Code's per-project transcript directory for a working directory. */
export function claudeProjectDir(cwd, { home = os.homedir() } = {}) {
  return path.join(home, ".claude", "projects", String(cwd).replace(/[^A-Za-z0-9]/g, "-"));
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "")).join("\n");
  return "";
}

/** Summarize Claude Code transcript events (parsed JSONL lines). */
export function summarizeClaudeEvents(events) {
  const out = { modelCalls: 0, toolCalls: [], toolResultChars: 0, repoReadChars: 0, harnessChars: 0, assistantChars: 0,
    filesRead: [], commands: [], lastToolResultText: null, lastAssistantText: null };
  const byId = new Map();
  for (const e of events ?? []) {
    const content = Array.isArray(e?.message?.content) ? e.message.content : [];
    if (e?.type === "assistant") {
      out.modelCalls++;
      const texts = [];
      for (const c of content) {
        if (c?.type === "tool_use") {
          const input = c.input ?? {};
          const tool = c.name ?? null;
          const call = {
            tool, path: typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : null,
            command: typeof input.command === "string" ? input.command : typeof input.pattern === "string" ? input.pattern : null,
            resultChars: 0, repoRead: CLAUDE_REPO_READ_TOOLS.includes(String(tool ?? "").toLowerCase()),
          };
          out.toolCalls.push(call);
          if (c.id) byId.set(c.id, call);
          if (call.path && /^read$/i.test(tool ?? "")) out.filesRead.push(call.path);
          if (typeof input.command === "string") out.commands.push(input.command);
        } else if (c?.type === "text" && typeof c.text === "string") {
          out.assistantChars += c.text.length;
          texts.push(c.text);
        }
      }
      if (texts.length) out.lastAssistantText = texts.join("\n");
    } else if (e?.type === "user") {
      for (const c of content) {
        if (c?.type !== "tool_result") continue;
        const text = textOf(c.content);
        out.toolResultChars += text.length;
        out.lastToolResultText = text;
        const call = byId.get(c.tool_use_id);
        if (call) {
          call.resultChars += text.length;
          if (call.repoRead) out.repoReadChars += text.length; else out.harnessChars += text.length;
        }
      }
    }
  }
  return out;
}

/**
 * The transcript of the Claude Code session that ran in `cwd` since
 * `sinceMs` (the newest such file), summarized; or { available: false }.
 */
// `tailBytes` reads only the file's last N bytes -- enough for a watcher
// that wants the latest tool call, without parsing a whole long session.
export function readClaudeSessionTranscript(cwd, { sinceMs = 0, home = os.homedir(), tailBytes = null } = {}) {
  const candidates = [cwd];
  try { candidates.push(fs.realpathSync(cwd)); } catch { /* the worktree may be gone already */ }
  for (const dir of [...new Set(candidates.map((c) => claudeProjectDir(c, { home })))]) {
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f)); } catch { continue; }
    const recent = files.map((f) => { const st = fs.statSync(f); return { f, mtime: st.mtimeMs, size: st.size }; }).filter((x) => x.mtime >= sinceMs).sort((a, b) => b.mtime - a.mtime);
    if (!recent.length) continue;
    const events = [];
    let text;
    if (tailBytes && recent[0].size > tailBytes) {
      const fd = fs.openSync(recent[0].f, "r");
      try {
        const buf = Buffer.alloc(tailBytes);
        fs.readSync(fd, buf, 0, tailBytes, recent[0].size - tailBytes);
        text = buf.toString("utf8").split("\n").slice(1).join("\n"); // drop the partial first line
      } finally { fs.closeSync(fd); }
    } else text = fs.readFileSync(recent[0].f, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* a torn last line while the session is still writing */ }
    }
    return { available: true, reason: null, source: "claude-code-session", dbPath: recent[0].f, events: events.length, ...summarizeClaudeEvents(events) };
  }
  return { available: false, reason: "no Claude Code session transcript found for this job's working directory" };
}

/**
 * Token usage of every Claude Code session that ran in `cwd` since
 * `sinceMs`, summed: { input, output, cacheRead, cacheWrite, calls } in
 * OpenClaw's usage shape, or null when there's none. A claude-cli job's
 * OpenClaw envelope carries only the final reply's usage (input 2, output
 * 8 for a 29-call job), since the CLI runs its whole loop itself; its own
 * session log has every call. Each call is logged once per content block
 * with the same message id and usage, so ids count once.
 */
export function readClaudeSessionUsage(cwd, { sinceMs = 0, home = os.homedir() } = {}) {
  const candidates = [cwd];
  try { candidates.push(fs.realpathSync(cwd)); } catch { /* the worktree may be gone already */ }
  const seen = new Set(), files = new Set();
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  for (const dir of new Set(candidates.map((c) => claudeProjectDir(c, { home })))) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const name of names) {
      const f = path.join(dir, name);
      try { if (fs.statSync(f).mtimeMs < sinceMs || files.has(fs.realpathSync(f))) continue; files.add(fs.realpathSync(f)); } catch { continue; }
      let text = "";
      try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        if (!line.includes("\"usage\"")) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        const m = e?.message, u = m?.usage;
        if (e?.type !== "assistant" || !u || typeof u !== "object") continue;
        const id = m.id ?? e.uuid;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        total.calls++;
        total.input += Number(u.input_tokens) || 0;
        total.output += Number(u.output_tokens) || 0;
        total.cacheRead += Number(u.cache_read_input_tokens) || 0;
        total.cacheWrite += Number(u.cache_creation_input_tokens) || 0;
      }
    }
  }
  return total.calls ? total : null;
}

