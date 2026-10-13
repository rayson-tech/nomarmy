import { execFileSync } from "node:child_process";
import fs from "node:fs";

// OpenClaw writes each sandbox's container.env under /tmp/openclaw (it ignores
// TMPDIR) and hands the path to Podman. Under systemd's PrivateTmp the unit
// sees its own /tmp while Podman's long-lived pause process resolves paths in
// the real one, so every sandbox fails with "container.env: no such file or
// directory". Only Linux has either.

export const PRIVATE_TMP_FIX = "Set PrivateTmp=no in that unit (systemctl edit <unit>), then restart it. OpenClaw writes sandbox files under /tmp/openclaw and ignores TMPDIR, so Podman must see the same /tmp.";

/** Whether this process runs with a systemd private /tmp. */
export function privateTmpInThisProcess({ platform = process.platform, readMountinfo = () => fs.readFileSync("/proc/self/mountinfo", "utf8") } = {}) {
  if (platform !== "linux") return false;
  let text;
  try { text = readMountinfo(); } catch { return false; }
  // mountinfo fields: id parent major:minor root mountpoint ...
  return text.split("\n").some((line) => {
    const fields = line.split(" ");
    return fields[4] === "/tmp" && /systemd-private-/.test(fields[3] ?? "");
  });
}

/** Loaded system and user services that run nomArmy or OpenClaw with PrivateTmp on. */
export function privateTmpUnits({ platform = process.platform, run = (args) => execFileSync("systemctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }) } = {}) {
  if (platform !== "linux") return [];
  const found = [];
  for (const scope of [[], ["--user"]]) {
    let units;
    try {
      units = run([...scope, "list-units", "--type=service", "--all", "--plain", "--no-legend", "--no-pager"])
        .split("\n").map((line) => line.trim().split(/\s+/)[0]).filter((unit) => unit?.endsWith(".service"));
    } catch { continue; }
    if (!units.length) continue;
    let shown;
    try { shown = run([...scope, "show", "--property=Id,PrivateTmp,ExecStart", "--no-pager", ...units]); } catch { continue; }
    for (const block of shown.split(/\n\s*\n/)) {
      const id = /^Id=(.*)$/m.exec(block)?.[1];
      if (id && /^PrivateTmp=yes$/m.test(block) && /nomarmy|openclaw/i.test(/^ExecStart=(.*)$/m.exec(block)?.[1] ?? "")) {
        found.push(scope.length ? `${id} (user)` : id);
      }
    }
  }
  return found;
}

const MISSING_CONTAINER_ENV = /container\.env[^\n]*no such file or directory/i;

/** Names the cause when a sandbox failed because Podman couldn't see OpenClaw's /tmp files. */
export function privateTmpHint(message, { privateTmp = privateTmpInThisProcess } = {}) {
  if (!MISSING_CONTAINER_ENV.test(message ?? "")) return null;
  const confirmed = privateTmp();
  return `${confirmed ? "This process runs with a systemd private /tmp" : "Podman couldn't see OpenClaw's container.env under /tmp/openclaw; the usual cause is a systemd unit with PrivateTmp=yes"}. ${PRIVATE_TMP_FIX} 'nomarmy doctor' lists such units.`;
}
