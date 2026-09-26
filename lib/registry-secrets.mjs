// Operator-only registry declarations. Never merge these into job configuration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";

const fail = (message) => { throw new Error("registries: " + message); };
const mapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Inspect only the local YAML key; never resolve or inspect declared paths.
export function hasRegistryDeclarations(cwd) {
  const local = path.join(cwd, ".nomarmy.local.yml");
  if (!fs.existsSync(local)) return false;
  let doc;
  try { doc = YAML.parse(fs.readFileSync(local, "utf8")); }
  catch { fail("cannot parse .nomarmy.local.yml"); }
  return mapping(doc) && Object.hasOwn(doc, "registries");
}

export function readRegistrySecrets(cwd) {
  // Check both spellings, even if the normal loader would select only one.
  for (const name of [".nomarmy.yml", ".nomarmy.yaml"]) {
    const file = path.join(cwd, name);
    if (!fs.existsSync(file)) continue;
    let doc;
    try { doc = YAML.parse(fs.readFileSync(file, "utf8")); }
    catch { fail("cannot parse repository configuration"); }
    if (mapping(doc) && Object.hasOwn(doc, "registries")) {
      fail("allowed only in .nomarmy.local.yml, never in committed repository configuration");
    }
  }
  const local = path.join(cwd, ".nomarmy.local.yml");
  if (!fs.existsSync(local)) return [];
  let doc;
  // Parser errors can echo input; do not include them in a public error.
  try { doc = YAML.parse(fs.readFileSync(local, "utf8")); }
  catch { fail("cannot parse .nomarmy.local.yml"); }
  if (!mapping(doc) || !Object.hasOwn(doc, "registries")) return [];
  if (!mapping(doc.registries)) fail("must be a mapping of credential file paths");
  const declarations = doc.registries;
  if (Object.keys(declarations).some((key) => !["npm", "pip", "go", "cargo"].includes(key))) {
    fail("supported ecosystems are npm, pip, go and cargo");
  }
  return ["npm", "pip", "go", "cargo"].filter((key) => Object.hasOwn(declarations, key)).map((ecosystem) => {
    const value = declarations[ecosystem];
    let source = value, format = "config", privatePatterns = "";
    if (ecosystem === "go" || (ecosystem === "pip" && mapping(value))) {
      const keys = ecosystem === "go" ? ["netrc", "private"] : ["netrc"];
      if (!mapping(value) || Object.keys(value).some((key) => !keys.includes(key)) || !Object.hasOwn(value, "netrc")) {
        fail(ecosystem + " accepts only a netrc file path" + (ecosystem === "go" ? " and private patterns" : ""));
      }
      source = value.netrc;
      format = "netrc";
      if (ecosystem === "go" && value.private !== undefined) {
        if (typeof value.private !== "string" || !/^[a-zA-Z0-9_.*?\/[\],!~+-]+$/.test(value.private)) {
          fail("go.private must contain module patterns, not credentials or shell commands");
        }
        privatePatterns = value.private;
      }
    }
    if (typeof source !== "string" || !source || /[\r\n\0,]/.test(source) ||
        !(path.isAbsolute(source) || source.startsWith("~/") || source.startsWith("./") || source.startsWith("../"))) {
      fail(ecosystem + " requires an absolute, ~/ or ./ credential file path; inline credentials are not accepted");
    }
    if (ecosystem === "pip" && [".netrc", "netrc"].includes(path.basename(source))) format = "netrc";
    const resolved = path.resolve(cwd, source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source);
    let stat, bytes;
    try {
      stat = fs.statSync(resolved);
      if (!stat.isFile()) fail(ecosystem + " credential must be a regular file");
      bytes = fs.readFileSync(resolved);
    } catch { fail(ecosystem + " credential must be an existing readable regular file"); }
    return {
      ecosystem, id: ecosystem === "go" ? "go-netrc" : ecosystem, source: resolved, format, privatePatterns,
      digest: crypto.createHash("sha256").update(bytes).digest("hex"),
      device: stat.dev, inode: stat.ino,
    };
  });
}

// A selected credential must not also be a dependency input (including hardlinks).
export function assertNoRegistryCopies(cwd, files, secrets) {
  for (const { source } of files) {
    if (!source) continue;
    const stat = fs.statSync(path.resolve(cwd, source));
    if (secrets.some((secret) => secret.device === stat.dev && secret.inode === stat.ino)) {
      fail("a credential file cannot also be a build-context input");
    }
  }
}

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

// Only built-in install RUNs get mounts. Custom harness commands never do.
// /tmp and manager caches are ephemeral so diagnostics/auth caches cannot
// survive a successful install. No credentialed command output is retained.
export function registryInstallRun(command, ecosystem, secrets) {
  const secret = secrets.find((entry) => entry.ecosystem === ecosystem);
  if (!secret) return "RUN " + command;
  const target = ecosystem === "npm" ? "/home/node/.npmrc"
    : ecosystem === "pip" ? (secret.format === "netrc" ? "/root/.netrc" : "/etc/pip.conf")
    : ecosystem === "go" ? "/home/node/.netrc" : "/home/node/.cargo/credentials.toml";
  const uid = ecosystem === "pip" ? 0 : 1000;
  const mounts = [
    `--mount=type=secret,id=${secret.id},target=${target},uid=${uid},required=true`,
    "--mount=type=tmpfs,target=/tmp",
    "--mount=type=tmpfs,target=/root/.cache",
    // Corepack lives in ~/.cache/node/corepack: do not hide its prepared binaries.
    // npm-family archive caches are redirected to tmpfs by the environment below.
    ...(ecosystem === "npm" ? [] : ["--mount=type=tmpfs,target=/home/node/.cache"]),
    ...(ecosystem === "npm" ? ["--mount=type=tmpfs,target=/home/node/.npm"] : []),
  ].join(" ");
  const env = ecosystem === "go"
    ? `export GOPRIVATE=${quote(secret.privatePatterns)} GONOSUMDB=${quote(secret.privatePatterns)}; `
    : ecosystem === "pip" ? "export UV_CACHE_DIR=/tmp/uv-cache POETRY_CACHE_DIR=/tmp/poetry-cache; "
    : ecosystem === "npm" ? "export npm_config_cache=/tmp/npm-cache COREPACK_ENABLE_NETWORK=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 YARN_CACHE_FOLDER=/tmp/yarn-cache YARN_GLOBAL_FOLDER=/tmp/yarn-global BUN_INSTALL_CACHE_DIR=/tmp/bun-cache; " : "";
  // Podman's layer cache does not include secret contents. A one-way salt in
  // the RUN is necessary: a new image tag alone could reuse a failed install.
  const { source, format, privatePatterns, digest } = secret;
  const salt = crypto.createHash("sha256").update(JSON.stringify({ ecosystem, source, format, privatePatterns, digest })).digest("hex");
  const run = `RUN ${mounts} { : ${salt}; ${env}${command}; } >/dev/null 2>&1`;
  // Python has no rebuild step to check mount removal. Fail closed before
  // subsequent layers can execute installed code. npm checks before rebuild.
  return ecosystem === "pip"
    ? run + `\nRUN (test ! -e ${target} && test ! -L ${target}) || { touch /deps/.nomarmy-pip-install-failed; exit 1; }`
    : run;
}
