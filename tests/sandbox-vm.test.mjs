import "./helpers/isolate-global-config.mjs";
// Tests for lib/sandbox-vm.mjs: sizing the Podman VM from `nomarmy sandbox`.
import assert from "node:assert/strict";
import { test } from "node:test";

import { pickMachine, planResize } from "../lib/sandbox-vm.mjs";
import { checkPodmanMachineMemory, checkPodmanIdMappings } from "../lib/doctor.mjs";

const inspect = (machines) => JSON.stringify(machines);
const vm = { Name: "podman-machine-default", State: "running", Resources: { CPUs: 8, Memory: 2048, DiskSize: 100 } };

test("pickMachine: the running machine, else the first; null on nothing or garbage", () => {
  assert.deepEqual(pickMachine(inspect([{ ...vm, Name: "old", State: "stopped" }, vm])), { name: "podman-machine-default", state: "running", cpus: 8, memoryMb: 2048, diskGb: 100 });
  assert.equal(pickMachine(inspect([])), null);
  assert.equal(pickMachine("not json"), null);
});

test("planResize: stop, set, start the one machine; refuses too small, too big, not whole, or while jobs run", () => {
  const machine = pickMachine(inspect([vm]));
  const hostMemoryMb = 65536;
  const ok = planResize({ gib: 8, machine, hostMemoryMb });
  assert.equal(ok.ok, true);
  assert.equal(ok.memoryMb, 8192);
  assert.deepEqual(ok.commands, [["machine", "stop", "podman-machine-default"], ["machine", "set", "--memory", "8192", "podman-machine-default"], ["machine", "start", "podman-machine-default"]]);
  assert.match(planResize({ gib: 2, machine, hostMemoryMb }).problems[0], /below the 4 GiB/);
  assert.match(planResize({ gib: 60, machine, hostMemoryMb }).problems[0], /three quarters/);
  assert.match(planResize({ gib: 40, machine, hostMemoryMb }).warnings[0], /more than half/);
  assert.match(planResize({ gib: "6.5", machine, hostMemoryMb }).problems[0], /whole number/);
  assert.match(planResize({ gib: 8, machine, hostMemoryMb, runningJobs: 2 }).problems[0], /2 nomArmy job\(s\) are running/);
  assert.match(planResize({ gib: 8, machine: null, hostMemoryMb }).problems[0], /no Podman machine/);
});

test("doctor: a 2 GiB VM fails with the sandbox command as its fix; 8 GiB passes; Linux doesn't apply", () => {
  const small = checkPodmanMachineMemory({ podmanMachineMemoryMb: 2048 });
  assert.equal(small.ok, false);
  assert.match(small.message, /only 2 GiB/);
  assert.equal(small.fix, "nomarmy sandbox --memory 8");
  assert.equal(checkPodmanMachineMemory({ podmanMachineMemoryMb: 8192 }).ok, true);
  assert.match(checkPodmanMachineMemory({ podmanMachineMemoryMb: null }).message, /not applicable/);
});

test("doctor: rootless Podman with one mapped ID fails with the repair; ranges present, or rootful, pass", () => {
  const broken = checkPodmanIdMappings({ podmanIdMappings: { rootless: true, uid: 1, gid: 1 } });
  assert.equal(broken.ok, false);
  assert.match(broken.message, /no subordinate ID ranges/);
  assert.match(broken.fix, /nomarmy sandbox --repair/);
  assert.equal(checkPodmanIdMappings({ podmanIdMappings: { rootless: true, uid: 2, gid: 2 } }).ok, true);
  assert.equal(checkPodmanIdMappings({ podmanIdMappings: { rootless: false, uid: 1, gid: 1 } }).ok, true);
  assert.equal(checkPodmanIdMappings({ podmanIdMappings: null }).ok, true);
});
