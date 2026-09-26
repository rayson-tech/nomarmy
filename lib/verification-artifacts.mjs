import { credentialForms } from "./verification-network.mjs";
import fs from "node:fs";
import path from "node:path";
import { loadHarnesses, matchHarnesses } from "./harnesses.mjs";
import { matchesGlob } from "./repo-query.mjs";

/** Copy regular evidence files only; never follow repository-controlled symlinks. */
export function collectVerificationArtifacts(cwd, jobDir, { secrets = [], maxFiles = 200, maxBytes = 50 * 1024 * 1024 } = {}) {
  const { harnesses } = loadHarnesses();
  const globs = matchHarnesses(cwd, harnesses).flatMap((name) => harnesses[name].artifacts);
  const artifacts = [];
  let bytes = 0, capped = false, dropped = 0;
  const forms = credentialForms(secrets).map(s => Buffer.from(s));
  const destination = path.join(jobDir, "artifacts");
  // Do not reuse a directory the runner could have populated with symlinks.
  fs.rmSync(destination, { recursive: true, force: true });
  function walk(dir = "") {
    for (const entry of fs.readdirSync(path.join(cwd, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if ([".git", "node_modules"].includes(entry.name) || path.resolve(cwd, rel) === path.resolve(destination)) continue;
        walk(rel);
      } else if (entry.isFile() && globs.some((glob) => matchesGlob(rel, glob))) {
        const source = path.join(cwd, rel);
        const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile()) continue;
          if (artifacts.length >= maxFiles || bytes + stat.size > maxBytes) { capped = true; continue; }
          // Bound reads even if the file grows while verification is finishing.
          const content = Buffer.alloc(stat.size);
          const size = fs.readSync(fd, content, 0, content.length, 0);
          if (forms.some(form => content.subarray(0, size).includes(form) || Buffer.from(rel).includes(form))) { dropped++; continue; }
          const target = path.join(destination, rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, content.subarray(0, size));
          bytes += size;
          artifacts.push(path.posix.join("artifacts", rel));
        } finally { fs.closeSync(fd); }
      }
    }
  }
  if (globs.length) walk();
  return { artifacts, artifactsCapped: capped, ...(dropped ? { artifactsNote: `dropped ${dropped} artifact(s) containing credentials` } : {}) };
}
