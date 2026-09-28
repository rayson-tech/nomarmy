// Some tests run python3 3.11+ (tomllib), as lib/registry-python.mjs and the
// sandbox's generated scripts do. Native Windows usually has no python3 (or
// only the Microsoft Store alias); nomArmy's engine runs those inside WSL.
import { spawnSync } from "node:child_process";

const probe = spawnSync("python3", ["-I", "-c", "import tomllib"], { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });

// A `test` skip value: false, or the reason the test can't run here.
export const noPython311 = probe.status === 0 ? false : "needs python3 3.11+ (tomllib) on PATH";
