# Security policy

## Supported versions

nomArmy does not yet cut release branches; the `main` branch is what's supported. Security fixes land there.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/rayson-tech/nomarmy/security/advisories/new) for this repository, rather than opening a public issue or pull request. That keeps the report and any discussion private until a fix is available.

Include, if you can:

- What you found and why it's exploitable (a repro is ideal, but a clear description is enough to start).
- Which execution profile it applies to (`macbook-pro`/`dgx-spark`/`nvidia-linux`/`cpu-linux`, or `bedrock`/`bedrock-cheap`).
- Whether it requires local access, a malicious repository under `local_worker`, or a compromised worker model.

We'll acknowledge the report, work with you on a fix, and credit you in the fix's commit or release notes unless you'd prefer otherwise.

## Scope

nomArmy's security model is described in the README's [Security posture](README.md#security-posture) section: a worker gets a writable worktree inside a network-isolated Podman sandbox and nothing else, repository content is treated as untrusted input, and configuration is data to validate, never authority. In scope for a report:

- Anything that lets a worker (or repository content a worker reads) escape the sandbox, reach the host filesystem outside its worktree, or reach the coordinator's own credentials or state.
- Anything that lets a worker's report, or content from a scanned repository, be mistaken for a coordinator-verified fact rather than an unverified claim.
- A Bedrock credential or Podman socket reaching somewhere it shouldn't (see `scripts/configure-openclaw.sh` and the README's cloud-profile notes).
- Supply-chain concerns in the dependency set declared in `package.json`.

Out of scope: the safety of a repository a user deliberately points a worker at (that repo's content is explicitly untrusted by design), and vulnerabilities in third-party tools nomArmy orchestrates but doesn't ship (llama.cpp, OpenClaw, Podman); please report those upstream.

## Secret scanning: real, but scoped

The sandbox blocks network egress (`--network none`), which stops a worker from exfiltrating anything itself. It does not stop the diff or the four-line report from *carrying* something out on its own: a worker's file edits and prose are the one channel that always leaves the sandbox, because the coordinator reads them to decide what to commit.

Every implement job's added content (the diff's new lines, plus the worker's own report text) is scanned with [secretlint](https://github.com/secretlint/secretlint)'s recommended rule preset (AWS/GCP/Azure, GitHub/GitLab, Slack, Stripe, OpenAI/Anthropic, npm, private key blocks, and more) before a commit is ever allowed. A match blocks the commit unconditionally, regardless of what verification or the worker's report otherwise say. The scan never surfaces the matched value itself, only which rule fired and where: the raw secretlint result embeds the actual credential in its `message`/`data` fields, so nomArmy reads only the rule identifier and location, never those fields, to avoid the check itself leaking the secret it caught into a log or manifest.

**What this does not solve**: it catches known secret *shapes*, not adversarially steered content with no recognizable shape at all, and a secret in a format none of secretlint's rules recognize can still pass through. The coordinator's own process controls (treating the report as an unverified claim, independently re-running verification, a human reviewing material diffs before they reach a real branch) are what carry that harder half, and they're a different guarantee than "the output channel is inspected." A report on either gap is welcome.
