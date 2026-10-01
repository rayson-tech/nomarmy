// This entry point runs outside the server event loop. Its input is a snapshot
// of operator contracts, never contract files read from the worker's checkout.
import { spawnSync } from "node:child_process";
import { checkContract } from "./acceptance.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { contracts, worktree, timeoutMs } = JSON.parse(input);
const deadline = Date.now() + timeoutMs;
const results = contracts.map(contract => ({
  file: contract.file,
  results: checkContract(contract, {
    repoDir: worktree,
    run: (command, args, options) => spawnSync(command, args, {
      ...options, timeout: Math.max(1, deadline - Date.now()), killSignal: "SIGKILL",
    }),
  }),
}));
process.stdout.write(JSON.stringify(results));
