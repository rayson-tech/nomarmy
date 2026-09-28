// Your setup choices (where models run, the local model, hardware profiles)
// live in ~/.config/nomarmy/, layered over the package's config/ defaults.
// They used to be written into config/ itself, which for an npm install is
// inside the package: every `nomarmy update` put them back to the defaults
// (found in a fresh-install practice run: hosted silently became local).
//
//   ~/.config/nomarmy/common.env           your overrides of config/common.env
//   ~/.config/nomarmy/profiles/<name>.env  your profiles, used before config/profiles/
//
// scripts/lib.sh layers the same files the same way.

import fs from "node:fs";
import path from "node:path";
import { globalConfigDir } from "./army.mjs";

export function userCommonPath(env = process.env) { return path.join(globalConfigDir(env), "common.env"); }
export function userProfilePath(name, env = process.env) { return path.join(globalConfigDir(env), "profiles", `${name}.env`); }

export function parseEnvFile(filePath) {
  const out = {};
  let text;
  try { text = fs.readFileSync(filePath, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Your value, else the package default. */
export function readSetting(key, { nomarmyRoot, env = process.env }) {
  const mine = parseEnvFile(userCommonPath(env));
  if (key in mine) return mine[key];
  return parseEnvFile(path.join(nomarmyRoot, "config", "common.env"))[key] ?? null;
}

/** Every common setting, package defaults with yours on top. */
export function readSettings({ nomarmyRoot, env = process.env }) {
  return { ...parseEnvFile(path.join(nomarmyRoot, "config", "common.env")), ...parseEnvFile(userCommonPath(env)) };
}

/** A profile's file: yours if you have one by that name, else the shipped one (null if neither). */
export function profilePathFor(name, { nomarmyRoot, env = process.env }) {
  if (!name) return null;
  const mine = userProfilePath(name, env);
  if (fs.existsSync(mine)) return mine;
  const shipped = path.join(nomarmyRoot, "config", "profiles", `${name}.env`);
  return fs.existsSync(shipped) ? shipped : null;
}

const HEADER = "# Your nomArmy settings, layered over the package's config/common.env.\n# Written by nomarmy setup and nomarmy model; kept across updates.\n";

/** Set one KEY=VALUE in a settings file, replacing it if present. */
export function writeEnvLine(filePath, key, value, { header = HEADER } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : header;
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  const updated = re.test(existing) ? existing.replace(re, line) : `${existing.trimEnd()}\n${line}\n`.replace(/^\n/, "");
  fs.writeFileSync(filePath, updated);
}

export function writeSetting(key, value, { env = process.env } = {}) {
  writeEnvLine(userCommonPath(env), key, value);
  return userCommonPath(env);
}

/**
 * One-time rescue, run before an update's copy replaces the installed one:
 * settings that only ever lived in the package (or its installed copy) move
 * to ~/.config/nomarmy/. A key is moved when the old copy's value differs from
 * the new package's default; a profile when the new package doesn't ship it
 * or ships it differently. Never overwrites what you already have there.
 * @returns {{ keys: string[], profiles: string[] }}
 */
export function migrateUserConfig({ oldConfigDir, nomarmyRoot, env = process.env }) {
  const moved = { keys: [], profiles: [] };
  if (!oldConfigDir || !fs.existsSync(oldConfigDir)) return moved;
  if (path.resolve(oldConfigDir) === path.resolve(path.join(nomarmyRoot, "config"))) return moved;
  const old = parseEnvFile(path.join(oldConfigDir, "common.env"));
  const shipped = parseEnvFile(path.join(nomarmyRoot, "config", "common.env"));
  const mine = parseEnvFile(userCommonPath(env));
  for (const [key, value] of Object.entries(old)) {
    if (key in mine || shipped[key] === value) continue;
    writeSetting(key, value, { env });
    moved.keys.push(key);
  }
  let names = [];
  try { names = fs.readdirSync(path.join(oldConfigDir, "profiles")).filter((f) => f.endsWith(".env")); } catch { /* none */ }
  for (const file of names) {
    const target = userProfilePath(path.basename(file, ".env"), env);
    if (fs.existsSync(target)) continue;
    const text = fs.readFileSync(path.join(oldConfigDir, "profiles", file), "utf8");
    const shippedFile = path.join(nomarmyRoot, "config", "profiles", file);
    if (fs.existsSync(shippedFile) && fs.readFileSync(shippedFile, "utf8") === text) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    moved.profiles.push(path.basename(file, ".env"));
  }
  return moved;
}

/** A path for messages: ~ for the home directory. */
export function tildePath(p, home = process.env.HOME) {
  return home && p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}
