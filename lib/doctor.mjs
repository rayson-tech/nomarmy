// lib/doctor.mjs
// Pure logic for the `nomarmy doctor` command.
// The module exports a `runDoctor` function that performs the checks and
// prints the report.  For unit testing purposes the core check functions
// are also exported.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Minimum Node.js major version required by nomArmy.
const MIN_NODE_MAJOR = 18;

/**
 * Parse a Node.js version string (e.g. "v18.12.1") into an object.
 * @param {string} version
 * @returns {{major: number, minor: number, patch: number} | null}
 */
export function parseNodeVersion(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version || "");
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

/**
 * Check that the Node.js version satisfies the minimum requirement.
 * @param {string} versionString
 * @returns {{ok: boolean, message: string, fix?: string}}
 */
export function checkNodeVersion(versionString) {
  const parsed = parseNodeVersion(versionString);
  if (!parsed) {
    return {
      ok: false,
      message: `Could not parse Node.js version '${versionString}'.`,
      fix: `Install a supported Node.js version (>= v${MIN_NODE_MAJOR}.0.0).`,
    };
  }
  if (parsed.major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      message: `Node.js v${parsed.major}.${parsed.minor}.${parsed.patch} is too old.`,
      fix: `Upgrade Node.js to v${MIN_NODE_MAJOR}.0.0 or newer.`,
    };
  }
  return { ok: true, message: `Node.js v${parsed.major}.${parsed.minor}.${parsed.patch} is OK.` };
}

/**
 * Detect whether a given executable exists in the system PATH.
 * @param {string} name
 * @returns {boolean}
 */
function executableExists(name) {
  const pathEnv = process.env.PATH || os.platform() === "win32" ? process.env.Path || "" : process.env.PATH;
  const paths = pathEnv.split(path.delimiter);
  for (const p of paths) {
    const candidate = path.join(p, name + (os.platform() === "win32" ? ".exe" : ""));
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * Check that the git executable is available.
 * @returns {{ok: boolean, message: string, fix?: string}}
 */
export function checkGitPresent() {
  if (executableExists("git")) {
    return { ok: true, message: "git is available." };
  }
  return {
    ok: false,
    message: "git executable not found.",
    fix: "Install Git and ensure 'git' is in your PATH.",
  };
}

/**
 * Check that the docker executable is available.
 * @returns {{ok: boolean, message: string, fix?: string}}
 */
export function checkDockerPresent() {
  if (executableExists("docker")) {
    return { ok: true, message: "docker is available." };
  }
  return {
    ok: false,
    message: "docker executable not found.",
    fix: "Install Docker Desktop or the Docker CLI and ensure 'docker' is in your PATH.",
  };
}

/**
 * Validate that the NOMARMY_MODEL_ENDPOINT environment variable is set and
 * a syntactically valid URL.
 * @returns {{ok: boolean, message: string, fix?: string}}
 */
export function checkEndpoint() {
  const ep = process.env.NOMARMY_MODEL_ENDPOINT;
  if (!ep) {
    return {
      ok: false,
      message: "NOMARMY_MODEL_ENDPOINT is not set.",
      fix: "Set the environment variable to point to a valid worker model endpoint, e.g. export NOMARMY_MODEL_ENDPOINT='http://localhost:1234'.",
    };
  }
  try {
    // URL constructor will throw if invalid.
    new URL(ep);
  } catch {
    return {
      ok: false,
      message: `NOMARMY_MODEL_ENDPOINT '${ep}' is not a valid URL.",
      fix: "Ensure the endpoint is a proper URL (e.g., https://example.com).",
    };
  }
  return { ok: true, message: `NOMARMY_MODEL_ENDPOINT is set to '${ep}'.` };
}

/**
 * Run the doctor checks and print a report.
 * @param {{json?: boolean, exit?: boolean}} opts
 */
export async function runDoctor(opts = {}) {
  const { json = false, exit = false } = opts;
  const checks = [
    checkNodeVersion(process.version),
    checkGitPresent(),
    checkDockerPresent(),
    checkEndpoint(),
  ];
  const allOk = checks.every((c) => c.ok);
  if (json) {
    console.log(JSON.stringify({ checks, allOk }, null, 2));
    if (exit) process.exit(allOk ? 0 : 1);
    return;
  }
  console.log(`nomArmy doctor report (exit code will be ${allOk ? 0 : 1})\n`);
  for (const c of checks) {
    const status = c.ok ? "✓" : "✗";
    console.log(`  ${status} ${c.message}`);
    if (!c.ok && c.fix) console.log(`    Fix: ${c.fix}`);
  }
  console.log("\nAll checks passed." + (allOk ? "" : "\nSome checks failed."));
  if (exit) process.exit(allOk ? 0 : 1);
}
