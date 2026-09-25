# Security posture

The worker gets a writable worktree inside Podman and nothing else: no Podman socket, no host credentials, no network. Repository content is untrusted input, and `.nomarmy.yml` is data to validate, never authority.

**The exception: a Claude subscription runs its tools on your machine.** OpenClaw reaches a Claude plan by running the real `claude` command on the host, and Claude Code's own tools (Bash, Edit, Write) run there, with your files and the network, not in the sandbox. We checked each route by having a worker report where its shell ran:

| Agent | Its tools run |
|---|---|
| `local`, api keys (xAI, OpenAI, Anthropic, ...), ChatGPT via Codex, Muse Code | in the sandbox: Linux, `/workspace`, no network |
| Claude subscription (`claude-cli`) | **on this machine**: your real paths, with network |

So nomArmy refuses **implement** jobs on a Claude subscription unless that agent says `allow_host_tools: true` in `agents.yml`; scouts and reviews still run, labeled. `nomarmy health` and the `army` tool flag any build role on it, and `agents list` says so. If a job's worktree comes back with a real `node_modules` where nomArmy's dependency link was (packages installed where the sandbox couldn't have), nomArmy flags the job for review and verifies against the sandbox's own dependencies. Sandboxing the Claude route properly needs OpenClaw to run it with only OpenClaw's own (sandboxed) tools, which it supports internally but doesn't expose yet. An Anthropic **api key** runs through OpenClaw's own loop and is sandboxed like the rest.

**Never hand a worker** AWS or production credentials, deployment access, SSH keys, Kubernetes contexts or Terraform state.

Every model call, local, api or subscription, is made by OpenClaw on the host, never from inside the sandbox. A subscription is reached through the vendor's own logged-in session; nomArmy never reads or stores the token. What changes with a hosted agent or a Bedrock profile is where your code goes (to that vendor), not what the sandbox can reach.

`on_behalf_of` is a self-reported attestation, not a verified identity: nomArmy has no caller-identity boundary. The secret scan catches known secret shapes, not steered content with no recognizable shape. Both are covered in [SECURITY.md](../SECURITY.md), which is also where to report a vulnerability.
