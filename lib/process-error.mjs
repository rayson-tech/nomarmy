import { redactCommand } from "./evidence.mjs";

// Keep the command's reason on its first line, where records and watchers
// summarize it. Never copy stdout or an unbounded stderr dump into that line.
export function processErrorSummary(error) {
  const message = String(error?.message ?? error ?? "");
  const first = message.split(/\r?\n/)[0].replace(/^Error: /, "");
  const git = /^git (?:exited|timed out|stopped)/.test(first);
  const stderr = error?.stderr ?? message.split(/\r?\nSTDERR:\r?\n/)[1]?.split(/\r?\nSTDOUT:/)[0] ?? "";
  const reason = git && !/\b(?:fatal|error):/i.test(first)
    ? String(stderr).split(/\r?\n/).find(line => /^\s*(?:remote:\s*)?(?:fatal|error):/i.test(line))
    : null;
  return redactCommand([first, reason?.trim()].filter(Boolean).join(": "), 600);
}
