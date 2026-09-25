import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// npm installs CLIs on Windows as `<name>.cmd` shims. Node's spawn without a
// shell resolves only exact filenames, so `spawn("openclaw")` fails ENOENT on a
// host where `openclaw` works fine in a terminal. Resolve the real file instead
// of setting shell:true -- the argv here carries repository-derived prompt text,
// and handing that to a Windows command line would be an injection surface.
// npm installs CLIs on Windows as a `<name>.cmd` shim. Two problems follow:
// `spawn("openclaw")` cannot see the shim (ENOENT), and since Node 18.20 /
// 20.12 (CVE-2024-27980) spawning a .cmd without a shell throws EINVAL. Using
// shell:true would fix both and open an argument-injection hole, because the
// argv here carries repository-derived prompt text. So resolve the shim to the
// package's real JS entry point and run it under this same Node binary.
const execCache = new Map();
export function resolveExecutable(command) {
  if (process.platform !== "win32") return { file: command, prefixArgs: [] };
  if (command.includes("/") || command.includes("\\")) return { file: command, prefixArgs: [] };
  if (execCache.has(command)) return execCache.get(command);

  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  let found = null;
  outer: for (const dir of dirs) {
    // PATHEXT variants first: npm also drops an extensionless POSIX shell
    // script beside the shim, and Windows cannot execute that one.
    for (const ext of [...exts, ""]) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      try { if (fs.statSync(candidate).isFile()) { found = candidate; break outer; } } catch { /* not here */ }
    }
  }
  if (!found) return { file: command, prefixArgs: [] };

  let resolved = { file: found, prefixArgs: [] };
  if (/\.(cmd|bat)$/i.test(found)) {
    const pkgDir = path.join(path.dirname(found), "node_modules", command);
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[command];
      const entry = rel ? path.join(pkgDir, rel) : null;
      if (entry && fs.statSync(entry).isFile()) {
        resolved = { file: process.execPath, prefixArgs: [entry] };
      }
    } catch { /* fall through to the shim and let spawn report it */ }
  }
  execCache.set(command, resolved);
  return resolved;
}

export function createProcess(ctx) {
  // onTick, when given, is polled every tickMs with the elapsed ms and may
  // request an early, cooperative stop (e.g. a long-running worker whose diff
  // has gone idle) without waiting for the hard timeoutMs deadline. Both paths
  // kill the same way (SIGTERM) and reject the same shape of error
  // (error.timedOut = true); only error.stopReason distinguishes "ran out of
  // its full budget" (undefined -- the original, unlabeled case) from a named
  // early stop, so a caller can decide whether that specific reason still
  // leaves a resumable session worth following up on.
  // teeTo, when given ({ stdout, stderr } file paths), appends output to those
  // files as it arrives, so a running job can be watched (tail -f) instead of
  // its logs appearing only once it finishes.
  function run(command, args, { cwd = ctx.projectDir, env = process.env, timeoutMs = 120000, trim = true, onTick = null, tickMs = 15000, teeTo = null } = {}) {
    return new Promise((resolve, reject) => {
      const exe = resolveExecutable(command);
      const child = spawn(exe.file, [...exe.prefixArgs, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", settled = false;
      const startedAt = Date.now();
      const stopEarly = (message, stopReason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ticker) clearInterval(ticker);
        child.kill("SIGTERM");
        const error = new Error(message);
        error.timedOut = true;
        if (stopReason) error.stopReason = stopReason;
        reject(error);
      };
      const timer = setTimeout(() => stopEarly(`${command} timed out after ${timeoutMs}ms`, "timeout"), timeoutMs);
      const ticker = onTick ? setInterval(async () => {
        if (settled) return;
        let verdict;
        try { verdict = await onTick(Date.now() - startedAt); } catch { return; } // a broken watcher must never itself kill the run
        if (verdict?.stop) stopEarly(`${command} stopped early: ${verdict.reason ?? "requested by watcher"}`, verdict.reason ?? "early_stop");
      }, tickMs) : null;
      const tee = (file, text) => { if (file) { try { fs.appendFileSync(file, text); } catch { /* a log write must never break the run */ } } };
      child.stdout.on("data", d => { const t = d.toString(); stdout += t; tee(teeTo?.stdout, t); });
      child.stderr.on("data", d => { const t = d.toString(); stderr += t; tee(teeTo?.stderr, t); });
      child.on("error", e => { if (!settled) { settled = true; clearTimeout(timer); if (ticker) clearInterval(ticker); reject(e); } });
      child.on("close", code => {
        if (settled) return;
        settled = true; clearTimeout(timer); if (ticker) clearInterval(ticker);
        if (code !== 0) {
          const error = new Error(`${command} exited ${code}\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`);
          // Structured, not just baked into .message text: a caller that knows
          // this command's own output shape (e.g. OpenClaw's JSON envelope) can
          // inspect the real captured stdout/stderr directly instead of
          // string-scraping the formatted message above.
          error.stdout = stdout; error.stderr = stderr;
          reject(error);
        }
        else resolve({ stdout: trim ? stdout.trim() : stdout, stderr: stderr.trim() });
      });
    });
  }
  async function git(args, cwd = ctx.projectDir) { return (await run("git", args, { cwd })).stdout; }
  async function gitRaw(args, cwd = ctx.projectDir) { return (await run("git", args, { cwd, trim: false })).stdout; }
  return { run, git, gitRaw };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function mapLimit(items, limit, fn, { staggerMs = 0 } = {}) {
  const results = new Array(items.length);
  const slots = Math.min(limit, items.length);
  // Each slot's FIRST item is reserved to that slot (not the shared counter
  // below), so a fast-finishing slot 0 can never steal slot 1's item before
  // slot 1 wakes from its stagger delay -- that race defeated the stagger
  // entirely for any job shorter than staggerMs. Only once every slot has
  // started does the free-for-all queue take over for any items left beyond
  // the initial fill; by then slots are already running on naturally offset
  // schedules, so no further staggering is needed.
  let next = slots;
  async function runner(slot) {
    if (staggerMs && slot > 0) await sleep(staggerMs * slot);
    results[slot] = await fn(items[slot], slot);
    while (true) { const i = next++; if (i >= items.length) return; results[i] = await fn(items[i], i); }
  }
  await Promise.all(Array.from({ length: slots }, (_, slot) => runner(slot))); return results;
}
