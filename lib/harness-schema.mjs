import { z } from "zod";

const text = z.string().trim().min(1, "must not be empty");
const name = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "must be kebab-case");
const relativePath = text.refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.includes(":") && !value.split("/").includes(".."), "must be a repository-relative path");
const detect = z.union([
  z.object({ file: relativePath }).strict(),
  z.object({ package: text }).strict(),
  z.object({ lockfile: relativePath }).strict(),
]);

const env = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string());
const pinnedImage = text.refine((value) => {
  if (/\s/.test(value) || value.startsWith("-")) return false;
  const reference = value.split("@")[0];
  if (reference.split("/").at(-1).endsWith(":latest")) return false;
  return /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value)
    || /^[a-z0-9][a-z0-9._:/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value)
      && value.split("/").at(-1).includes(":");
}, "image must have an explicit non-latest tag or sha256 digest");
const service = z.object({
  name, image: pinnedImage, port: z.number().int().min(1).max(65535),
  env: env.optional(),
  health: z.string().regex(/^\/(?!\/)[^\s\\#]*$/, "health must be an HTTP path").optional(),
}).strict();

export const harnessSchema = z.object({
  name,
  summary: text,
  detect: z.array(detect),
  after: z.array(name).default([]),
  image: z.union([
    z.object({ builtin: name }).strict(),
    z.object({ apt: z.array(text), run: z.array(text) }).strict(),
  ]),
  verification: z.record(text, z.union([text, z.array(text).min(1)])).default({}),
  artifacts: z.array(relativePath).default([]),
  requires: z.object({
    memoryMb: z.number().int().positive().optional(),
    shmMb: z.number().int().positive().optional(),
    kvm: z.boolean().optional(),
  }).strict().default({}),
  network: z.enum(["none", "services", "allowlist"]).default("none"),
  services: z.array(service).optional(),
  env: env.optional(),
  suggestedRole: z.object({ name, description: text }).strict().optional(),
  docs: relativePath.default("README.md"),
}).strict().superRefine((spec, ctx) => {
  if (new Set(spec.services?.map((service) => service.name)).size !== (spec.services?.length ?? 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["services"], message: "service names must be unique" });
  }
  if (spec.services !== undefined && spec.network === "none") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["services"], message: "services requires network services or allowlist" });
  }
});

export function harnessSchemaFor(folderName) {
  return harnessSchema.refine((spec) => spec.name === folderName, {
    path: ["name"], message: "name must equal its folder name",
  });
}
