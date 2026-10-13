import assert from "node:assert/strict";
import test from "node:test";
import { privateTmpHint, privateTmpInThisProcess, privateTmpUnits } from "../lib/private-tmp.mjs";
import { checkPrivateTmp } from "../lib/doctor.mjs";
import { withSandboxProvisioningRetry } from "../lib/openclaw-run.mjs";

const SHARED = "22 1 259:1 / / rw,relatime shared:1 - ext4 /dev/root rw\n";
const PRIVATE = SHARED + "812 22 259:1 /tmp/systemd-private-0f3c-nomarmy.service-Ab12/tmp /tmp rw,relatime shared:500 master:1 - ext4 /dev/root rw\n";

test("privateTmpInThisProcess spots a systemd private /tmp bind mount, on Linux only", () => {
  assert.equal(privateTmpInThisProcess({ platform: "linux", readMountinfo: () => PRIVATE }), true);
  assert.equal(privateTmpInThisProcess({ platform: "linux", readMountinfo: () => SHARED }), false);
  assert.equal(privateTmpInThisProcess({ platform: "linux", readMountinfo: () => { throw new Error("EACCES"); } }), false);
  assert.equal(privateTmpInThisProcess({ platform: "darwin", readMountinfo: () => PRIVATE }), false);
});

test("privateTmpUnits lists nomArmy and OpenClaw services with PrivateTmp=yes, system and user", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const user = args[0] === "--user";
    if (args.includes("list-units")) return user ? "openclaw-gateway.service loaded active running OpenClaw\n" : "nomarmy.service loaded active running nomArmy\nnginx.service loaded active running nginx\nsshd.service loaded active running ssh\n";
    if (user) return "Id=openclaw-gateway.service\nPrivateTmp=no\nExecStart={ path=/usr/bin/openclaw ; argv[]=/usr/bin/openclaw gateway }\n";
    return "Id=nomarmy.service\nPrivateTmp=yes\nExecStart={ path=/usr/bin/nomarmy ; argv[]=/usr/bin/nomarmy mcp }\n\nId=nginx.service\nPrivateTmp=yes\nExecStart={ path=/usr/sbin/nginx }\n\nId=sshd.service\nPrivateTmp=no\nExecStart={ path=/usr/sbin/sshd }\n";
  };
  assert.deepEqual(privateTmpUnits({ platform: "linux", run }), ["nomarmy.service"]);
  assert.deepEqual(calls[1].slice(-3), ["nomarmy.service", "nginx.service", "sshd.service"]);
  assert.deepEqual(privateTmpUnits({ platform: "linux", run: () => { throw new Error("no systemd"); } }), []);
  assert.deepEqual(privateTmpUnits({ platform: "darwin", run }), []);
});

test("doctor fails private-tmp with the unit names and the fix", () => {
  assert.equal(checkPrivateTmp({ platform: "darwin", privateTmp: null }).ok, true);
  assert.equal(checkPrivateTmp({ platform: "linux", privateTmp: { self: false, units: [] } }).ok, true);
  const failed = checkPrivateTmp({ platform: "linux", privateTmp: { self: true, units: ["nomarmy.service"] } });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /this process, nomarmy\.service/);
  assert.match(failed.fix, /PrivateTmp=no/);
});

test("a missing container.env names PrivateTmp and isn't retried", async () => {
  const message = "SandboxProvisioningError: podman run failed: open /tmp/openclaw/sbx-1/container.env: no such file or directory | 125";
  assert.match(privateTmpHint(message, { privateTmp: () => true }), /^This process runs with a systemd private \/tmp\. Set PrivateTmp=no/);
  assert.match(privateTmpHint(message, { privateTmp: () => false }), /usual cause is a systemd unit with PrivateTmp=yes/);
  assert.equal(privateTmpHint("SandboxProvisioningError: crun: mount devpts"), null);

  let attempts = 0;
  await assert.rejects(withSandboxProvisioningRetry(async () => { attempts++; throw new Error(message); }, { delayMs: 0 }), /PrivateTmp/);
  assert.equal(attempts, 1);
});
