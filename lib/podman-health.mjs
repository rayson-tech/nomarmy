// Is Podman answering, and when did its VM last start? A job dispatched into
// a stopped Podman, or running while its VM restarts (resizing it with
// `nomarmy sandbox --memory`, say), fails with nothing but "openclaw exited
// 2" unless nomArmy checks. Seen live: two jobs lost to a VM resize.

import { spawnSync } from "node:child_process";

const defaultRun = (args) => spawnSync("podman", args, { encoding: "utf8", timeout: 5000 });

/** Why jobs can't start their sandbox right now, or null. */
export function podmanProblem({ run = defaultRun } = {}) {
  const r = run(["info", "--format", "{{.Host.Arch}}"]);
  if (r.status === 0) return null;
  const why = String(r.stderr || r.error?.message || "").split("\n").find((l) => l.trim()) ?? "no answer";
  return `Podman isn't answering (${why.trim().slice(0, 160)}), so no job was sent: its sandbox couldn't start. Start it with \`podman machine start\` (macOS, Windows), then check with \`nomarmy sandbox\`.`;
}

/** When the Podman VM last started (macOS, Windows), or null where there's no VM. */
export function podmanVmStartedAt({ run = defaultRun, platform = process.platform } = {}) {
  if (!["darwin", "win32"].includes(platform)) return null;
  try {
    const machines = JSON.parse(run(["machine", "inspect"]).stdout || "[]");
    const m = machines.find((x) => x.State === "running") ?? machines[0];
    return m?.LastUp ?? null;
  } catch { return null; }
}

/** A job issue when the VM restarted, or stopped, between two readings. */
export function vmRestartIssue(before, after) {
  if (!before || before === after) return null;
  return after
    ? "the Podman VM restarted during this job, which removed its sandbox: the failure is most likely that, not the work. Re-dispatch once Podman is up (nomarmy sandbox)."
    : "the Podman VM stopped during this job, which removed its sandbox: the failure is most likely that, not the work. Start it (podman machine start) and re-dispatch.";
}
