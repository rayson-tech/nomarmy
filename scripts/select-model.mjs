#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
let query = "";
let repo = "";
let configPath = path.join(root, "config", "common.env");

for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (value === "--repo") repo = args[++index] ?? "";
  else if (value === "--config") configPath = path.resolve(args[++index] ?? "");
  else if (value === "--help" || value === "-h") {
    console.log("Usage: ./scripts/select-model.sh <search term> | --repo <owner/model-GGUF> [--config <env file>]");
    process.exit(0);
  } else if (!query) query = value;
  else throw new Error(`Unexpected argument: ${value}`);
}

if (!repo && !query) throw new Error("Provide a model search term or --repo <owner/model-GGUF>.");
if (!process.stdin.isTTY) throw new Error("Model selection requires an interactive terminal so the configuration change can be confirmed.");

const rl = createInterface({ input, output });
const hf = async (endpoint) => {
  const response = await fetch(`https://huggingface.co/api/${endpoint}`, {
    headers: { "User-Agent": "nomArmy-model-selector/1.2" },
  });
  if (!response.ok) throw new Error(`Hugging Face request failed: ${response.status} ${response.statusText}`);
  return response.json();
};

try {
  if (!repo) {
    const models = await hf(`models?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&direction=-1&limit=12&full=true`);
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error(`No GGUF repositories matched "${query}". Try a more specific search or pass --repo owner/model-GGUF.`);
    }
    console.log(`\nGGUF repositories matching "${query}":`);
    models.forEach((model, index) => console.log(`  ${index + 1}. ${model.id} (${model.downloads ?? 0} downloads)`));
    const choice = Number.parseInt(await rl.question("Choose a repository number (or press Enter to cancel): "), 10);
    if (!Number.isInteger(choice) || choice < 1 || choice > models.length) throw new Error("Cancelled; no model configuration changed.");
    repo = models[choice - 1].id;
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error("Repository must use the form owner/model.");
  // encodeURIComponent(repo) as one call also escapes the real path-separating
  // "/" between owner and name into "%2F" -- confirmed live: the HF API
  // returns 400 for .../models/unsloth%2FMuse-Glimmer-30B-GGUF and 200 for
  // .../models/unsloth/Muse-Glimmer-30B-GGUF. Encode each segment on its own
  // and rejoin with a literal "/" so an owner or model name with its own
  // special characters is still escaped correctly.
  const details = await hf(`models/${repo.split("/").map(encodeURIComponent).join("/")}?blobs=true`);
  const files = (details.siblings ?? []).map((file) => file.rfilename).filter((name) => /\.gguf$/i.test(name));
  if (files.length === 0) throw new Error(`${repo} has no GGUF files. Choose a GGUF conversion repository for llama.cpp.`);

  const preferred = ["Q4_K_M", "Q4_K_S", "Q4_0", "Q5_K_M", "Q5_K_S", "Q6_K", "Q8_0"];
  const quants = [...new Set(files.map((name) => name.match(/(?:[._-])(IQ\d+_[A-Z0-9_]+|Q\d+_[A-Z0-9_]+)(?:[._-]|\.gguf$)/i)?.[1]?.toUpperCase()).filter(Boolean))];
  quants.sort((left, right) => (preferred.indexOf(left) === -1 ? 99 : preferred.indexOf(left)) - (preferred.indexOf(right) === -1 ? 99 : preferred.indexOf(right)) || left.localeCompare(right));
  const quant = quants[0] ?? "Q4_K_M";
  console.log(`\nSelected repository: ${repo}`);
  console.log(`Available quants: ${quants.length ? quants.join(", ") : "not detected; llama.cpp will choose its default"}`);
  const requestedQuant = (await rl.question(`Quantization [${quant}]: `)).trim().toUpperCase() || quant;
  if (!/^[A-Z0-9_]+$/.test(requestedQuant)) throw new Error("Quantization may contain only uppercase letters, numbers, and underscores.");
  if (quants.length && !quants.includes(requestedQuant)) throw new Error(`Quantization ${requestedQuant} is not available in ${repo}.`);
  const defaultAlias = repo.split("/").at(-1).replace(/-GGUF$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const alias = (await rl.question(`Local model alias [${defaultAlias}]: `)).trim() || defaultAlias;
  if (!/^[A-Za-z0-9._-]+$/.test(alias)) throw new Error("Alias may contain only letters, numbers, dots, underscores, and hyphens.");

  console.log(`\nReady to update ${path.relative(root, configPath)}:`);
  console.log(`  NOMARMY_MODEL_REPO=${repo}`);
  console.log(`  NOMARMY_MODEL_QUANT=${requestedQuant}`);
  console.log(`  NOMARMY_MODEL_ALIAS=${alias}`);
  if ((await rl.question("Apply this model configuration? [y/N] ")).trim().toLowerCase() !== "y") {
    console.log("Cancelled; no model configuration changed.");
    process.exit(0);
  }

  const existing = await readFile(configPath, "utf8");
  const replace = (key, value, text) => {
    const line = `${key}=${value}`;
    return new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${text.trimEnd()}\n${line}\n`;
  };
  let updated = replace("NOMARMY_MODEL_REPO", repo, existing);
  updated = replace("NOMARMY_MODEL_QUANT", requestedQuant, updated);
  updated = replace("NOMARMY_MODEL_ALIAS", alias, updated);
  await writeFile(configPath, updated);
  console.log("Configuration updated. Restart inference to download and load the new model:");
  console.log("  ./scripts/stop-inference.sh");
  console.log("  ./scripts/start-inference.sh <profile>");
} finally {
  rl.close();
}
