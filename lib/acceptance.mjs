// Acceptance contracts keep feature promises tied to executable regression checks.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { z } from "zod";
import { typeError } from "./zod-issues.mjs";
import { toPosix } from "./path-utils.mjs";

export const criterionIdSchema = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/, "must be an ID such as WIN-6");

const string = () => z.string({ error: typeError("a string") }).min(1, "must not be empty");
const platformsSchema = z.array(z.enum([
  "aix", "android", "cygwin", "darwin", "freebsd", "haiku", "linux", "netbsd", "openbsd", "sunos", "win32", "posix",
]));
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "must be a real date");
const referenceSchema = z.union([
  z.object({ file: string(), test: string(), platforms: platformsSchema.optional() }).strict(),
  z.object({ command: string(), cwd: string().optional(), platforms: platformsSchema.optional() }).strict(),
  z.object({ manual: string(), checked_by: string(), date: dateSchema, expires_days: z.number().int().positive().optional(), platforms: platformsSchema.optional() }).strict(),
]);
export const contractSchema = z.object({
  feature: string(),
  run: string().optional(),
  pr: z.union([string(), z.number().int().positive()]).optional(),
  criteria: z.array(z.object({
    id: criterionIdSchema,
    text: string(),
    proven_by: z.array(referenceSchema),
    status: z.enum(["met", "unproven", "broken", "retired"]),
    security: z.boolean().optional(),
    note: z.string().optional(),
  }).strict()),
}).strict().superRefine((contract, ctx) => {
  const seen = new Set();
  contract.criteria.forEach(({ id }, index) => {
    if (seen.has(id)) ctx.addIssue({ code: "custom", path: ["criteria", index, "id"], message: `duplicate criterion ${id}` });
    seen.add(id);
  });
});

/** Load one file while retaining its path for grouped CLI output and errors. */
export function loadContract(file) {
  let data;
  try {
    data = YAML.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
  const parsed = contractSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const index = issue.path[0] === "criteria" ? issue.path[1] : undefined;
      const id = index === undefined ? "contract" : data?.criteria?.[index]?.id ?? `criteria[${index}]`;
      return `${file}: ${id}: ${issue.path.join(".") || "contract"} ${issue.message}`;
    });
    throw new Error(issues.join("\n"));
  }
  return { file, ...parsed.data };
}

export function contractDisplayPath(repoDir, file) {
  return toPosix(path.relative(repoDir, file));
}

export function loadContracts(repoDir) {
  const directory = path.join(repoDir, "acceptance");
  let files;
  try {
    files = fs.readdirSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return files.filter((file) => file.endsWith(".yml")).sort().map((file) => loadContract(path.join(directory, file)));
}

const fixedName = (name) => name.split("${", 1)[0];
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const failureFor = (ref, detail) => "file" in ref
  ? { file: ref.file, test: ref.test, detail }
  : { command: ref.command, detail };

const appliesOn = (ref, platform) => !ref.platforms || ref.platforms.some((value) => value === platform || (value === "posix" && platform !== "win32"));

/** Recompute status from evidence, never from a contract's recorded verdict. */
export function checkContract(contract, { repoDir, run = spawnSync, platform = process.platform, today = new Date().toISOString().slice(0, 10) }) {
  // A checker invoked by node:test must start a fresh test runner, not inherit
  // the parent's child-test context (which disables --test on some Node versions).
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const options = { cwd: repoDir, encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024 };
  const execute = (command, args, opts) => {
    try { return run(command, args, opts); }
    catch (error) { return { status: null, error }; }
  };
  const runFailure = (result) => result.error?.message || result.stderr?.trim() || result.stdout?.trim()
    || `process exited ${result.status ?? result.signal ?? "without a status"}`;

  return contract.criteria.map((criterion) => {
    const result = { id: criterion.id, text: criterion.text, status: "met", security: criterion.security ?? false, failures: [] };
    if (criterion.status === "retired") return { ...result, status: "retired" };
    if (!criterion.proven_by.length) return { ...result, status: "unproven" };
    const applicable = criterion.proven_by.filter((ref) => appliesOn(ref, platform));
    const notApplicable = criterion.proven_by.filter((ref) => !appliesOn(ref, platform));
    if (notApplicable.length) result.notApplicable = notApplicable;
    if (!applicable.length) return { ...result, status: "unproven", note: `no proof applies on ${platform}` };
    const manualRefs = applicable.filter((ref) => "manual" in ref);
    const expired = manualRefs.filter((ref) => ref.expires_days !== undefined
      && Date.parse(`${today}T00:00:00Z`) > Date.parse(`${ref.date}T00:00:00Z`) + ref.expires_days * 86400000);
    const currentManual = manualRefs.filter((ref) => !expired.includes(ref));
    if (currentManual.length) result.manual = currentManual;
    const nodeRefs = applicable.filter((ref) => "file" in ref);
    for (const ref of nodeRefs) {
      try {
        const source = fs.readFileSync(path.resolve(repoDir, ref.file), "utf8");
        if (!fixedName(ref.test) || !source.includes(fixedName(ref.test))) {
          throw new Error("test name is absent from the source");
        }
      } catch (error) {
        result.failures.push(failureFor(ref, `${criterion.id}: ${ref.file}: ${ref.test}: ${error.message}`));
      }
    }
    if (result.failures.length) return { ...result, status: "missing" };
    if (nodeRefs.length) {
      // Literal names are exact; template names select the loop's fixed prefix.
      const pattern = nodeRefs.map((ref) => `^${escapeRegex(fixedName(ref.test))}${ref.test.includes("${") ? "" : "$"}`).join("|");
      const files = [...new Set(nodeRefs.map((ref) => path.resolve(repoDir, ref.file)))];
      const execution = execute(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern", pattern, ...files], options);
      // Newer Node versions report the file itself as passing when a filter
      // matches nothing. Count named, non-skipped test results, not file passes.
      const passedNames = [...String(execution.stdout ?? "").matchAll(/^\s*ok \d+ - (.+)$/gm)]
        .map((match) => match[1].trim()).filter((name) => !/ # (?:SKIP|TODO)\b/i.test(name))
        .map((name) => name.replace(/\\#/g, "#"));
      if (execution.status !== 0 || execution.error) {
        const failedNames = [...String(execution.stdout ?? "").matchAll(/^\s*not ok \d+ - (.+)$/gm)]
          .map((match) => match[1].trim().replace(/\\#/g, "#"));
        const failedRefs = nodeRefs.filter((ref) => failedNames.some((name) => ref.test.includes("${") ? name.startsWith(fixedName(ref.test)) : name === ref.test));
        // Startup and runner failures may have no named test result at all.
        result.failures.push(...(failedRefs.length ? failedRefs : nodeRefs).map((ref) => failureFor(ref, runFailure(execution))));
      } else {
        for (const ref of nodeRefs) {
          const matched = passedNames.some((name) => ref.test.includes("${") ? name.startsWith(fixedName(ref.test)) : name === ref.test);
          if (!matched) result.failures.push(failureFor(ref, "no tests passed (zero tests ran or all were skipped/todo)"));
        }
      }
    }
    for (const ref of applicable.filter((ref) => "command" in ref)) {
      const execution = execute(ref.command, [], { ...options, shell: true, cwd: path.resolve(repoDir, ref.cwd ?? ".") });
      if (execution.status !== 0 || execution.error) result.failures.push(failureFor(ref, runFailure(execution)));
    }
    if (result.failures.length) result.status = "broken";
    else if (!currentManual.length && !nodeRefs.length && !applicable.some((ref) => "command" in ref)) {
      result.status = "unproven";
      const ref = expired[0];
      result.note = `manual check by ${ref.checked_by} on ${ref.date} expired after ${ref.expires_days} days`;
    }
    return result;
  });
}
