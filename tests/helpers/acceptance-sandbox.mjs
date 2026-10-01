// Test-only sandbox adapter. The test suite itself already runs in the worker
// sandbox; production callers never receive this adapter.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadContract, loadContracts, checkContract } from "../../lib/acceptance.mjs";
import { buildPodmanArgs, createVerificationRunner } from "../../lib/verify.mjs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));

export function assertChecker(input) {
  assert.equal(input.acceptanceToolDir, root);
  assert.equal(input.command.startsWith("node /nomarmy-acceptance/bin/nomarmy.mjs acceptance check --json"), true);
  const mounts = buildPodmanArgs(input).filter(arg => arg.startsWith("type=bind,") && arg.includes("target=/nomarmy-acceptance/"));
  assert.deepEqual(mounts, ["bin", "lib", "node_modules"].map(dir => `type=bind,source=${path.join(root, dir)},target=/nomarmy-acceptance/${dir},readonly`));
}
export function fixtureExecutor() {
  return {
    probe: async () => ({ available: true }),
    run: async input => {
      assertChecker(input);
      const contracts = input.acceptanceContractsDir
        ? fs.readdirSync(input.acceptanceContractsDir).sort().map(name => loadContract(path.join(input.acceptanceContractsDir, name)))
        : loadContracts(input.cwd);
      const results = contracts.map(contract => ({
        file: input.acceptanceContractsDir ? `../nomarmy-contracts/${path.basename(contract.file)}` : path.relative(input.cwd, contract.file),
        criteria: checkContract(contract, { repoDir: input.cwd }),
      }));
      return { started: true, exitCode: results.some(c => c.criteria.some(r => ["broken", "missing"].includes(r.status))) ? 1 : 0,
        stdout: JSON.stringify({ contracts: results }), stderr: "" };
    },
  };
}
export function fixtureVerification(projectDir, options = {}) {
  return createVerificationRunner({ hostProjectDir: projectDir, image: "fixture", executor: fixtureExecutor(), ...options });
}
export function fixtureWorktree(repoDir, calls = []) {
  return async (command, args, options) => {
    assert.equal(command, "git");
    assert.equal(options.cwd, repoDir);
    calls.push([command, args, options]);
    if (args[1] === "add") {
      assert.deepEqual(args.slice(0, 3), ["worktree", "add", "--detach"]);
      assert.equal(args[4], "HEAD");
      fs.cpSync(repoDir, args[3], { recursive: true });
    } else {
      assert.deepEqual(args.slice(0, 3), ["worktree", "remove", "--force"]);
      fs.rmSync(args[3], { recursive: true, force: true });
    }
    return { stdout: "" };
  };
}
