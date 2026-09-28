import fs from "node:fs";
import path from "node:path";

/** Compare canonical paths so Windows case, slash, and 8.3 spellings agree. */
export function samePath(a, b, platform = process.platform) {
  const canonical = (value) => {
    const resolved = path.resolve(value);
    let real = resolved;
    try { real = fs.realpathSync.native(resolved); } catch { /* Missing paths still compare resolved spellings. */ }
    const normalized = platform === "win32" ? real.replaceAll("\\", "/").toLowerCase() : real;
    return normalized.replace(/\/$/, "");
  };
  return canonical(a) === canonical(b);
}
