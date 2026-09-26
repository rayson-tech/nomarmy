import { z } from "zod";

const text = z.string().trim().min(1, "must not be empty");
const name = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "must be kebab-case");
const relativePath = text.refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.includes(":") && !value.split("/").includes(".."), "must be a repository-relative path");
const detect = z.union([
  z.object({ file: relativePath }).strict(),
  z.object({ package: text }).strict(),
  z.object({ lockfile: relativePath }).strict(),
]);

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
  services: z.array(name).optional(),
  suggestedRole: z.object({ name, description: text }).strict().optional(),
  docs: relativePath.default("README.md"),
}).strict().superRefine((spec, ctx) => {
  if (spec.services !== undefined && spec.network === "none") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["services"], message: "services requires network services or allowlist" });
  }
});

export function harnessSchemaFor(folderName) {
  return harnessSchema.refine((spec) => spec.name === folderName, {
    path: ["name"], message: "name must equal its folder name",
  });
}
