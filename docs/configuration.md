# Configuration

Local inference is configured in two files, and a shell-exported variable overrides both. Every variable is documented where it's set.

- **`config/common.env`**: defaults shared by every profile.
- **`config/profiles/<name>.env`**: per-machine overrides (context size, GPU layers, threads, workers).

| Variable | Lives in | Default | Controls |
|---|---|---|---|
| `NOMARMY_WORKER_MODEL` | common.env | `gpt-oss-20b` | Which local model runs jobs |
| `NOMARMY_MODEL_REPO` / `_QUANT` | common.env | `ggml-org/gpt-oss-20b-GGUF` / `MXFP4` | Which GGUF to download |
| `NOMARMY_LLAMA_CONTEXT` | profile | `65536` | **Total** context across all slots |
| `NOMARMY_LLAMA_PARALLEL` | profile | `1` | Inference slots (the context is divided across them) |
| `NOMARMY_MAX_WORKERS` | profile | `1` | How many local jobs run at once |
| `NOMARMY_MAX_POOL_WORKERS` | environment | `4` | How many api and subscription jobs run at once |
| `NOMARMY_EXECUTION` | common.env | `local` | `local` or `bedrock` |
| `NOMARMY_ORCHESTRATOR_TRUST` | common.env | `frontier` | `frontier` or `degraded`: see `policies/reviewer.md` |

**The coupling that trips people up**: `NOMARMY_LLAMA_CONTEXT` is divided by `NOMARMY_LLAMA_PARALLEL`, not given to each slot whole. `65536` across 2 slots is `32768` per nom.

A change needs an inference restart: `nomarmy stop && nomarmy start` (logs go to `~/.local/share/nomarmy-local-agents/logs/`). `nomarmy config paths` shows where every config file lives.

## Swapping the local model

```bash
nomarmy model
```

It offers three measured choices (gpt-oss-20b, Qwen3-Coder-Next and Qwen3.6-27B: see the [model bake-off](experiments/2026-09-20-model-bakeoff-and-economics.md)) or a Hugging Face search. It also offers to update the MCP registration and restart inference, since the config, the registration and the running model all need to agree.

## Sizing

Three coupled settings: `NOMARMY_LLAMA_CONTEXT` (total context), `NOMARMY_LLAMA_PARALLEL` (slots) and `NOMARMY_MAX_WORKERS` (concurrent local jobs). `nomarmy sizing` reads your hardware and the model's GGUF metadata, checks live memory pressure, and recommends a combination.

- **Aim for 64K context per nom.** An autonomous explore, implement, test and repair loop needs more room than a one-shot edit.
- **More noms isn't automatically faster.** On one Apple Silicon machine, 4 parallel local workers produced no more accepted work than 1. Measure before raising it.
- **Speed matters more than fit.** CPU-only inference measured about 3.8 tokens per second on a 20-core i7 (an 11.5-minute job for two turns). Use a GPU or a hosted agent for interactive work; CPU-only is a correctness testbed.

Advanced llama-server tuning (`NOMARMY_LLAMA_CACHE_TYPE_K/V`, `_FLASH_ATTN`, `_REASONING_BUDGET`, `_REASONING_PRESERVE`, `_EXTRA_ARGS`) is documented in `config/profiles/*.env`; all unset by default.

## Advanced llama-server tuning

Optional, unset by default, local model only. Set them in your profile or `config/common.env`, then `nomarmy stop && nomarmy start`.

| Variable | Passed to llama-server as |
|---|---|
| `NOMARMY_LLAMA_CACHE_TYPE_K`, `NOMARMY_LLAMA_CACHE_TYPE_V` | `--cache-type-k`, `--cache-type-v`: a quantized KV cache (for example `q8_0`) fits more context in the same memory. `nomarmy sizing` accounts for it. |
| `NOMARMY_LLAMA_FLASH_ATTN` | `--flash-attn` (`on`, `off` or `auto`) |
| `NOMARMY_LLAMA_REASONING_BUDGET` | `--reasoning-budget`: caps a thinking model's reasoning tokens |
| `NOMARMY_LLAMA_REASONING_PRESERVE` | `--reasoning-preserve` when `true`, `--no-reasoning-preserve` otherwise |
| `NOMARMY_LLAMA_EXTRA_ARGS` | appended as is, split on spaces, for any other flag |

## Admission and budgets

A job is admitted only when there's context and memory for it, and briefs and reports are sized to the agent. The local model keeps caps calibrated on a 20B model, where longer briefs made it thrash: a 3,000-character brief, 6,000 characters of evidence, a 512-token implement report. An api or subscription agent gets ceilings that scale with its model's context, up to a 16,000-character brief and 24,000 characters of evidence. A job's `report` (`brief`, `standard`, `full`) sets how much comes back, up to about 2k tokens for an implement job and 4k for a scout. The report lands in the General's own context, so that's its call per job.
