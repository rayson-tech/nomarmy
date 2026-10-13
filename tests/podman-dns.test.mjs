import assert from "node:assert/strict";
import test from "node:test";
import { parsePodmanNetwork, podmanDnsProblem } from "../lib/podman-dns.mjs";
import { checkPodmanDns } from "../lib/doctor.mjs";

const info = (backend, dnsPath) => JSON.stringify({ host: { networkBackend: backend, networkBackendInfo: { backend, dns: dnsPath ? { path: dnsPath } : {} } } });

test("podmanDnsProblem flags CNI without dnsname, and nothing else", () => {
  assert.deepEqual(parsePodmanNetwork(info("cni", null)), { backend: "cni", dnsPath: null });
  assert.equal(parsePodmanNetwork("not json"), null);
  const none = () => false;
  assert.match(podmanDnsProblem(parsePodmanNetwork(info("cni", null)), { exists: none }), /CNI network backend without the dnsname plugin/);
  assert.equal(podmanDnsProblem(parsePodmanNetwork(info("cni", "/usr/lib/cni/dnsname")), { exists: none }), null, "podman info found the plugin");
  assert.equal(podmanDnsProblem(parsePodmanNetwork(info("cni", null)), { exists: (f) => f === "/usr/lib/cni/dnsname" }), null, "plugin in a standard directory");
  assert.equal(podmanDnsProblem(parsePodmanNetwork(info("netavark", "/usr/libexec/podman/aardvark-dns")), { exists: none }), null);
  assert.equal(podmanDnsProblem(null), null, "unknown: no claim");
});

test("doctor's podman-dns check fails only on Linux CNI without dnsname", () => {
  const cni = { backend: "cni", dnsPath: null };
  const failed = checkPodmanDns({ platform: "linux", podmanNetwork: cni });
  if (podmanDnsProblem(cni)) {
    assert.equal(failed.ok, false);
    assert.match(failed.fix, /golang-github-containernetworking-plugin-dnsname.*podman system reset/);
  }
  assert.equal(checkPodmanDns({ platform: "linux", podmanNetwork: { backend: "netavark", dnsPath: "/x" } }).ok, true);
  assert.equal(checkPodmanDns({ platform: "darwin", podmanNetwork: cni }).ok, true);
  assert.equal(checkPodmanDns({ platform: "linux", podmanNetwork: null }).ok, true);
});
