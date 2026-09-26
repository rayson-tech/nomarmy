import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { harnessSchemaFor } from "./harness-schema.mjs";
import { nodeDependencyFiles } from "./sandbox-images.mjs";

export const HARNESS_ROOT = fileURLToPath(new URL("../harnesses/", import.meta.url));

// Resolve the whole graph before publishing any specs, including dependents
// of broken harnesses. A partial layer stack is not a usable harness.
function orderedNames(harnesses) {
  const order = [], state = new Map(), failures = new Map();
  function visit(name, trail = []) {
    if (state.get(name) === "done") return !failures.has(name);
    if (state.get(name) === "visiting") {
      const cycle = [...trail.slice(trail.indexOf(name)), name];
      for (const member of cycle) failures.set(member, `after cycle: ${cycle.join(" -> ")}`);
      return false;
    }
    state.set(name, "visiting");
    for (const parent of harnesses[name].after) {
      if (!Object.hasOwn(harnesses, parent)) failures.set(name, `unknown after harness: ${parent}`);
      else if (!visit(parent, [...trail, name]) && !failures.has(name)) failures.set(name, `invalid after harness: ${parent}`);
    }
    state.set(name, "done");
    if (!failures.has(name)) order.push(name);
    return !failures.has(name);
  }
  for (const name of Object.keys(harnesses).sort()) visit(name);
  return { order, failures };
}

export function loadHarnesses(root = HARNESS_ROOT) {
  const harnesses = {}, problems = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) { return { harnesses, problems: [{ name: path.basename(root), reason: error.message }] }; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    try {
      const raw = parse(fs.readFileSync(path.join(root, entry.name, "harness.yml"), "utf8"));
      harnesses[entry.name] = harnessSchemaFor(entry.name).parse(raw);
    } catch (error) {
      problems.push({ name: entry.name, reason: error.message });
    }
  }
  const { failures } = orderedNames(harnesses);
  for (const [name, reason] of failures) {
    delete harnesses[name];
    problems.push({ name, reason });
  }
  return { harnesses, problems };
}

export function matchHarnesses(repoDir, harnesses) {
  let nodeDirs, packages;
  function directories() {
    if (!nodeDirs) {
      const found = nodeDependencyFiles(repoDir);
      nodeDirs = [...new Set([".", ...found.packages, ...(found.links ?? []), ...found.skipped.map(({ dir }) => dir)])];
    }
    return nodeDirs;
  }
  function dependencies() {
    if (!packages) {
      packages = new Set();
      for (const dir of directories()) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, dir, "package.json"), "utf8"));
          for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
            for (const name of Object.keys(pkg[field] ?? {})) packages.add(name);
          }
        } catch { /* An unreadable manifest cannot establish a match. */ }
      }
    }
    return packages;
  }
  const isFile = (relative) => {
    try { return fs.statSync(path.join(repoDir, relative)).isFile(); } catch { return false; }
  };
  const matched = Object.keys(harnesses).filter((name) => harnesses[name].detect.some((rule) => {
    if (rule.package) return dependencies().has(rule.package);
    if (rule.file) return isFile(rule.file);
    return isFile(rule.lockfile) || directories().some((dir) => isFile(path.join(dir, rule.lockfile)));
  }));
  // Unmatched harnesses must not reorder unrelated matches through their after edges.
  return orderedNames(Object.fromEntries(matched.map((name) => [name, {
    ...harnesses[name], after: harnesses[name].after.filter((parent) => matched.includes(parent)),
  }]))).order;
}
