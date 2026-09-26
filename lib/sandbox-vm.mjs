// `nomarmy sandbox`: the Podman VM every sandbox, verification run and image
// build shares on macOS and Windows (on Linux, Podman runs natively and
// there's no VM to size). Pure decisions here; bin/nomarmy.mjs runs Podman.

import { MIN_PODMAN_VM_MB } from "./doctor.mjs";

/** The machine to act on from `podman machine inspect` output: the running one, else the first. */
export function pickMachine(inspectJson) {
  let machines;
  try { machines = JSON.parse(inspectJson || "[]"); } catch { return null; }
  if (!Array.isArray(machines) || !machines.length) return null;
  const m = machines.find((x) => x.State === "running") ?? machines[0];
  return { name: m.Name ?? null, state: m.State ?? null, cpus: m.Resources?.CPUs ?? null, memoryMb: Number(m.Resources?.Memory) || null, diskGb: m.Resources?.DiskSize ?? null };
}

/**
 * What resizing the VM to `gib` would do, or why it won't.
 * @returns {{ ok: boolean, problems: string[], warnings: string[], memoryMb: number, commands: string[][] }}
 */
export function planResize({ gib, machine, hostMemoryMb, runningJobs = 0 }) {
  const problems = [], warnings = [];
  const memoryMb = Math.round(Number(gib) * 1024);
  if (!machine) problems.push("no Podman machine found: run `podman machine init`, or on Linux there's no VM to size");
  if (!Number.isFinite(memoryMb) || memoryMb <= 0 || !Number.isInteger(Number(gib))) problems.push(`--memory takes a whole number of GiB (got "${gib}")`);
  else if (memoryMb < MIN_PODMAN_VM_MB) problems.push(`${gib} GiB is below the ${MIN_PODMAN_VM_MB / 1024} GiB nomArmy needs`);
  else if (hostMemoryMb && memoryMb > hostMemoryMb * 0.75) problems.push(`${gib} GiB is more than three quarters of this machine's ${Math.round(hostMemoryMb / 1024)} GiB`);
  else if (hostMemoryMb && memoryMb > hostMemoryMb / 2) warnings.push(`${gib} GiB is more than half of this machine's ${Math.round(hostMemoryMb / 1024)} GiB; a local model needs room too`);
  if (runningJobs > 0) problems.push(`${runningJobs} nomArmy job(s) are running; resizing restarts the VM and would kill their sandboxes`);
  const name = machine?.name;
  const commands = name ? [["machine", "stop", name], ["machine", "set", "--memory", String(memoryMb), name], ["machine", "start", name]] : [];
  return { ok: problems.length === 0, problems, warnings, memoryMb, commands };
}
