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

## Project config can select, never define

A repository's `.nomarmy.yml` (and `.nomarmy.local.yml`) can carry an `army:` section that assigns roles to agents. That file is repository content, and a cloned repository is not trusted, so the army schema (`lib/army.mjs`) has no field for a credential, an `auth_env`, a `base_url`, an owner or a provider, and rejects any unknown field. A role can only name a subscription worker, a pool, or the local model already defined in the operator's own global `providers.yml` / `subscriptions.yml`. The worst a hostile army section can do is route a job to one of the operator's own agents; it can never add an endpoint that would receive a key. `.nomarmy.local.yml` is refused outright if git tracks it, since a committed "local" file is shared with everyone who pulls.

## Shared machines

On a machine several people use (a team DGX Spark), isolation comes from separate OS accounts. Every subscription credential lives in the account's home directory or keychain, outside every nomArmy file, and each person's coordinator session runs as that person. nomArmy refuses to load a global `providers.yml` or `subscriptions.yml` owned by a different account or writable by group or others (`privateConfigProblem`), since anyone who could edit another person's `providers.yml` could point that person's key at their own `base_url`. What nomArmy cannot detect is several people sharing one OS account: that pools every login in one home directory, and `on_behalf_of` is self-reported. Don't run it that way.

## Subscription-backed workers: attestation is not authentication

A `subscription_worker` job (`config/subscriptions.yml`) runs against one specific person's own already-authenticated Claude, OpenAI (ChatGPT plan) or Meta Muse Code subscription, never a shared or pooled credential. For Claude and Codex, nomArmy never stores, reads, or forwards that credential; OpenClaw uses the local CLI's own logged-in session, or its own login, entirely outside nomArmy's control.

Meta is the one exception, and it is deliberate: OpenClaw's Meta plugin only accepts an API key, and the subscription-covered key is the one Muse Code's own login mints into the macOS keychain. `nomarmy subscriptions setup meta` reads that item with `security find-generic-password` (macOS may prompt the operator to allow it), accepts only the minted `LLM|...|...` key shape (never the OAuth access token stored beside it), and pipes it to `openclaw models auth paste-api-key` on stdin. It is never printed, never on argv, never written to a file nomArmy owns, and child output is discarded so no error path can echo it. This runs only when the operator runs setup in their own terminal; dispatch never touches the keychain.

The one thing nomArmy does enforce is `on_behalf_of`: a job dispatched against a subscription worker must name the exact person that entry's `owner` field declares, or nomArmy refuses it outright (`resolveSubscriptionSelection` in `mcp/server.mjs`). Be plain about what this guarantees and what it doesn't: nomArmy has no concept of caller identity today -- every job arrives from whatever process is talking to the MCP server over stdio, with no authentication boundary between callers. `on_behalf_of` is a **self-reported field**, not an independently verified identity check. What it actually buys is explicit, auditable intent (the job's own metadata states who it's for) and hard refusal on a mismatch or omission -- not cryptographic proof of who actually issued the call. Anyone who can already reach this MCP server can name anyone as `on_behalf_of` and pass the check; the real access control is who can reach the server at all, the same boundary every other tool here already depends on.
