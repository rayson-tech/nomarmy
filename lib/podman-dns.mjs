import fs from "node:fs";
import path from "node:path";

// Harness services (mock-oidc) and the verification egress proxy are reached
// by name on a private Podman network. Netavark resolves names through
// aardvark-dns; the older CNI backend only with the dnsname plugin, which
// Ubuntu 24.04's podman (CNI by default) doesn't install.

export const DNSNAME_DIRS = ["/usr/lib/cni", "/usr/libexec/cni", "/opt/cni/bin", "/usr/local/lib/cni", "/usr/local/libexec/cni"];

export const PODMAN_DNS_FIX = "sudo apt install golang-github-containernetworking-plugin-dnsname (or your distro's CNI dnsname plugin). Moving Podman to the netavark backend also works, but needs 'podman system reset', which deletes every container and image.";

/** `podman info --format json`'s network backend and DNS plugin path. */
export function parsePodmanNetwork(stdout) {
  try {
    const host = JSON.parse(stdout).host ?? {};
    return { backend: host.networkBackend ?? host.networkBackendInfo?.backend ?? null, dnsPath: host.networkBackendInfo?.dns?.path || null };
  } catch { return null; }
}

/** Why containers on a Podman network can't find each other by name, or null when they can (or it can't be told). */
export function podmanDnsProblem(network, { exists = (file) => fs.existsSync(file), dirs = DNSNAME_DIRS } = {}) {
  if (network?.backend !== "cni") return null;
  if (network.dnsPath || dirs.some((dir) => exists(path.posix.join(dir, "dnsname")))) return null;
  return "Podman uses the CNI network backend without the dnsname plugin, so containers on a private network can't find each other by name (harness services such as mock-oidc, and the verification egress proxy)";
}
