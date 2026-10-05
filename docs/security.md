# Security posture

The worker gets a writable worktree inside Podman and nothing else: no Podman socket, no host credentials, no network. Repository content is untrusted input, and `.nomarmy.yml` is data to validate, never authority.

**The exception: a Claude subscription runs its tools on your machine.** OpenClaw reaches a Claude plan by running the real `claude` command on the host, and Claude Code's own tools (Bash, Edit, Write) run there, with your files and the network, not in the sandbox. We checked each route by having a worker report where its shell ran:

| Agent | Its tools run |
|---|---|
| `local`, api keys (xAI, OpenAI, Anthropic, ...), ChatGPT via Codex, Muse Code | in the sandbox: Linux, `/workspace`, no network |
| Claude subscription (`claude-cli`) | **on this machine**: your real paths, with network |

So nomArmy refuses **implement** jobs on a Claude subscription unless that agent says `allow_host_tools: true` in `agents.yml`; scouts and reviews still run, labeled. `nomarmy health` and the `army` tool flag any build role on it, and `agents list` says so. If a job's worktree comes back with a real `node_modules` where nomArmy's dependency link was (packages installed where the sandbox couldn't have), nomArmy flags the job for review and verifies against the sandbox's own dependencies. Sandboxing the Claude route properly needs OpenClaw to run it with only OpenClaw's own (sandboxed) tools, which it supports internally but doesn't expose yet. An Anthropic **api key** runs through OpenClaw's own loop and is sandboxed like the rest.

**Optional [validators](validators.md) can send code excerpts off your machine.** If you add Jev (`nomarmy validators add jev`), scout findings with their cited lines, diffs and worker reports go to TypeSafe for judgment, unless you point it at a System One-compatible server on your own machine (`nomarmy validators add kev --endpoint http://127.0.0.1:<port>`), in which case they stay local. Plain HTTP is accepted only to a loopback host, and redirects are refused. Measure a local model before relying on it: on our corpus, the local models we tried caught far fewer real defects than Jev ([numbers](validators.md#measure-a-local-model-before-relying-on-it)). Its answers only add review flags, since the content it judges is written by the worker being judged. Its key is saved readable only by you and never passed to a worker. A model judge (`nomarmy validators add judge`) sends the diff and report to its agent's vendor, and on an agent whose tools run on your machine it needs `--host-tools`, since OpenClaw can't turn those tools off and the text it reads was written by the worker.

**Never hand a worker** AWS or production credentials, deployment access, SSH keys, Kubernetes contexts or Terraform state.

Every model call, local, api or subscription, is made by OpenClaw on the host, never from inside the sandbox. A subscription is reached through the vendor's own logged-in session; nomArmy never reads or stores the token. What changes with a hosted agent or a Bedrock profile is where your code goes (to that vendor), not what the sandbox can reach.

`on_behalf_of` is a self-reported attestation, not a verified identity: nomArmy has no caller-identity boundary. The secret scan catches known secret shapes, not steered content with no recognizable shape. Both are covered in [SECURITY.md](../SECURITY.md), which is also where to report a vulnerability.

The `trust` rules in `.nomarmy.yml` are read from the operator's checkout, not a worker's worktree. Sensitive paths, changed-line content, and optionally CODEOWNERS paths trigger a human review gate; changing the rules or CODEOWNERS is itself gated. `/feature` stops before integrating such a job until the operator explicitly approves it.

## Trust gates and data flow

Checkout-owned sensitive-path, changed-line-content and optional CODEOWNERS rules set a deterministic human-level floor. The local removed-check detector (`lib/trust-checks.mjs`) looks for literal patterns such as removed guards, denial branches and tenant filters; it raises a job to at least review, or human when the finding is within the accepted map's reach. It is not a semantic proof. The accepted [trust map](trust-map.md) adds review for edits to mapped symbols and statically reachable helpers. Dynamic dispatch is left to the judgment, not certified safe by the mapper; unresolved mapped symbols and capped scans require review.

If configured, Jev or the model judge receives production-code diff hunks at its vendor and judges access control, weakened checks and sensitive data or irreversible operations. The task brief is sent separately for admission judgment, which can mark a job high stakes before dispatch. Documentation and unreferenced tests are excluded from diff judgment. The removed-check detector, floor rules and map/reach checks run locally. Model judgment only escalates: scores at least 0.5 require `review`, and scores at least 0.8 require `human`. Jev scores can vary slightly near these thresholds. `trust.judgment: false` in the operator checkout disables the diff and brief model judgments, not the deterministic layers.

Test-named files outside test directories are production when their language has
no import extraction. Go's `_test.go` files are the exception because the Go
toolchain never links them into production builds. Test directories retain their
existing rule (`tests/`, `test/`, `__tests__/`, and `spec/` with test evidence).
The JS/TS import scan follows only relative `./` and `../` specifiers. A
production file loading a test-named file through a path alias (`@/x`, tsconfig
paths, or package.json `"imports"`), a bare specifier, or a computed import is not
seen by this scan. List such files in `trust.sensitive.paths` in `.nomarmy.yml`
so changes remain human-gated even when the scan excludes them from judgment.

`normal` follows ordinary verification. `review` needs the independent review required for `stakes: high` before acceptance. `human` adds a hard stop before integration until the operator decides. For a repository without a map, run `nomarmy trust map` once, dispatch its scout brief, import the proposal and use `nomarmy trust review` to accept, edit or drop entries. Only accepted entries in `.nomarmy/trust-map.yml` are active. Later review defects and human rejections can suggest additions, never activate them automatically. Record a human-level decision with `nomarmy trust ack <job> --accept|--reject --reason ...`; a rejection does not authorize integration. See [trust map and bounded reach](trust-map.md) for the detailed workflow and limits.
