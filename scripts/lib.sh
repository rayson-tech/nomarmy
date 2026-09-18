#!/usr/bin/env bash
set -euo pipefail
nomarmy_root(){ cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd; }

# v1.3 renamed the configuration namespace RAYSON_* -> NOMARMY_*. Anything a
# user or unit file still exports under the old prefix is translated once, so
# existing installs keep working while they migrate.
nomarmy_compat_prefix(){
  local old new warned=0
  for old in $(compgen -v | grep '^RAYSON_' || true); do
    new="NOMARMY_${old#RAYSON_}"
    [[ -n "${!new:-}" ]] && continue
    export "$new=${!old}"
    if [[ "$warned" -eq 0 ]]; then
      echo "WARN: RAYSON_* environment variables are deprecated; use NOMARMY_* instead." >&2
      warned=1
    fi
    echo "WARN:   $old -> $new" >&2
  done
}

nomarmy_available_profiles(){
  local root; root="$(nomarmy_root)"
  find "$root/config/profiles" -name '*.env' -exec basename {} .env \; | sort | tr '\n' ' '
}

# True when the active profile runs inference on a hosted endpoint rather than
# a local llama-server. Scripts branch on this instead of on the profile name.
nomarmy_is_cloud(){ [[ "${NOMARMY_EXECUTION:-local}" != "local" ]]; }

nomarmy_validate_cloud(){
  local missing=()
  [[ -n "${NOMARMY_BEDROCK_REGION:-}" ]] || missing+=(NOMARMY_BEDROCK_REGION)
  [[ -n "${NOMARMY_WORKER_MODEL:-}" ]] || missing+=(NOMARMY_WORKER_MODEL)
  [[ -n "${NOMARMY_WORKER_PROVIDER:-}" ]] || missing+=(NOMARMY_WORKER_PROVIDER)
  if [[ "${#missing[@]}" -gt 0 ]]; then
    echo "ERROR: profile '$NOMARMY_PROFILE' is a cloud profile but these are unset: ${missing[*]}" >&2
    exit 2
  fi
  # Fail here rather than let a malformed region surface as an opaque 400 from
  # Bedrock in the middle of a worker job.
  if [[ ! "$NOMARMY_BEDROCK_REGION" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]$ ]]; then
    echo "ERROR: NOMARMY_BEDROCK_REGION='$NOMARMY_BEDROCK_REGION' is not a valid AWS region name." >&2
    exit 2
  fi
  export NOMARMY_BEDROCK_BASE_URL="${NOMARMY_BEDROCK_BASE_URL:-https://bedrock-runtime.${NOMARMY_BEDROCK_REGION}.amazonaws.com/openai/v1}"
}

# Precedence is environment > profile > common.env. The config files assign
# unconditionally, so a `${VAR:-default}` in a profile cannot tell a real user
# override from a value common.env set moments earlier. Snapshot what the caller
# exported before sourcing anything, and re-apply it afterwards.
NOMARMY_ENV_OVERRIDES=()
nomarmy_snapshot_env(){
  local v
  NOMARMY_ENV_OVERRIDES=()
  for v in $(compgen -v | grep '^NOMARMY_' || true); do
    # NOMARMY_PROFILE is resolved explicitly by load_profile; an explicit
    # argument must beat an exported one, so it is not restored here.
    [[ "$v" == "NOMARMY_PROFILE" || "$v" == "NOMARMY_ENV_OVERRIDES" ]] && continue
    NOMARMY_ENV_OVERRIDES+=("$v=${!v}")
  done
}
nomarmy_restore_env(){
  local pair name value
  for pair in ${NOMARMY_ENV_OVERRIDES[@]+"${NOMARMY_ENV_OVERRIDES[@]}"}; do
    name="${pair%%=*}"; value="${pair#*=}"
    export "$name=$value"
  done
}

# llama.cpp divides -c across -np, so per-nom context is the quotient. Surface
# the real figure and the two ways a profile can lie about its nom count.
nomarmy_validate_local(){
  local parallel="${NOMARMY_LLAMA_PARALLEL:-1}" workers="${NOMARMY_MAX_WORKERS:-1}" ctx="${NOMARMY_LLAMA_CONTEXT:-0}" per_nom
  [[ "$parallel" -ge 1 ]] || parallel=1
  per_nom=$(( ctx / parallel ))
  export NOMARMY_CONTEXT_PER_NOM="$per_nom"

  if [[ "$workers" -gt "$parallel" ]]; then
    echo "WARN: NOMARMY_MAX_WORKERS=$workers exceeds NOMARMY_LLAMA_PARALLEL=$parallel." >&2
    echo "WARN: only $parallel nom(s) can infer at once; the rest queue for a slot while" >&2
    echo "WARN: still holding a Podman sandbox each. Run 'nomarmy sizing' for a recommendation." >&2
  fi
  if [[ "$ctx" -gt 0 && "$per_nom" -lt 65536 ]]; then
    if [[ "$parallel" -gt 1 ]]; then
      # The surprising case: the operator set 65536 and the slot division ate it.
      echo "WARN: context per nom is $per_nom ($ctx total / $parallel slots), below the" >&2
      echo "WARN: v1.3 target of 65536. Raise NOMARMY_LLAMA_CONTEXT to $(( 65536 * parallel ))" >&2
      echo "WARN: or reduce NOMARMY_LLAMA_PARALLEL. Run 'nomarmy sizing' for a recommendation." >&2
    else
      # Single slot: the operator chose this context directly, so just state it.
      echo "INFO: context per nom is $per_nom; the v1.3 autonomous loop targets 65536." >&2
    fi
  fi
}

load_profile(){
  local root profile profile_file os
  nomarmy_compat_prefix
  nomarmy_snapshot_env
  root="$(nomarmy_root)"; profile="${1:-${NOMARMY_PROFILE:-}}"; os="$(uname -s)"
  if [[ -z "$profile" ]]; then
    if [[ "$os" == Darwin ]]; then profile=macbook-pro
    elif command -v nvidia-smi >/dev/null 2>&1; then profile=nvidia-linux
    else profile=cpu-linux; fi
  fi
  profile_file="$root/config/profiles/$profile.env"
  if [[ ! -f "$profile_file" ]]; then
    echo "ERROR: unknown profile '$profile'. Available: $(nomarmy_available_profiles)" >&2
    exit 2
  fi
  set -a
  # shellcheck disable=SC1091
  source "$root/config/common.env"
  # shellcheck disable=SC1090
  source "$profile_file"
  set +a
  nomarmy_restore_env
  export NOMARMY_PROFILE="$profile"
  export NOMARMY_INSTALL_ROOT="${NOMARMY_INSTALL_ROOT/\$HOME/$HOME}"

  if nomarmy_is_cloud; then
    # Cloud profiles host no local model, so they carry no hardware or OS
    # requirement and are the only profiles usable on a machine without a GPU.
    nomarmy_validate_cloud
  else
    if [[ "$os" == Darwin && "$profile" != macbook-pro ]]; then
      echo "ERROR: profile '$profile' requires Linux. Use macbook-pro on macOS." >&2
      exit 2
    fi
    if [[ "$os" == Linux && "$profile" == macbook-pro ]]; then
      echo "ERROR: profile 'macbook-pro' requires macOS. Use dgx-spark, nvidia-linux, or cpu-linux on Linux." >&2
      exit 2
    fi
    nomarmy_validate_local
  fi

  if [[ "${NOMARMY_ORCHESTRATOR_TRUST:-frontier}" == "degraded" ]]; then
    echo "WARN: profile '$profile' runs a DEGRADED orchestrator (${NOMARMY_ORCHESTRATOR_MODEL:-unset})." >&2
    echo "WARN: coordinator and worker are the same capability class; acceptance is not an independent check." >&2
    echo "WARN: see policies/reviewer.md before trusting this profile for anything costly to get wrong." >&2
  fi
}

need(){ command -v "$1" >/dev/null 2>&1 || { echo "ERROR: missing $1" >&2; return 1; }; }

run_as_root(){
  if [[ "${EUID}" -eq 0 ]]; then "$@"; else need sudo; sudo "$@"; fi
}

linux_package_manager(){
  if command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf >/dev/null 2>&1; then echo dnf
  elif command -v yum >/dev/null 2>&1; then echo yum
  elif command -v zypper >/dev/null 2>&1; then echo zypper
  elif command -v pacman >/dev/null 2>&1; then echo pacman
  elif command -v apk >/dev/null 2>&1; then echo apk
  fi
}

install_build_dependencies(){
  local manager; manager="$(linux_package_manager)"
  if [[ -z "$manager" ]]; then
    echo 'ERROR: unsupported Linux package manager. Install a C++ compiler, CMake, curl, Git, and CA certificates, then rerun.' >&2
    return 1
  fi

  echo "==> Installing build prerequisites with $manager"
  case "$manager" in
    apt) run_as_root apt-get update; run_as_root apt-get install -y build-essential cmake curl git ca-certificates nodejs npm ;;
    dnf) run_as_root dnf install -y gcc-c++ cmake curl git ca-certificates nodejs npm ;;
    yum) run_as_root yum install -y gcc-c++ cmake curl git ca-certificates nodejs npm ;;
    zypper) run_as_root zypper --non-interactive install gcc-c++ cmake curl git ca-certificates nodejs npm ;;
    pacman) run_as_root pacman --noconfirm --needed -S base-devel cmake curl git ca-certificates nodejs npm ;;
    apk) run_as_root apk add build-base cmake curl git ca-certificates nodejs npm ;;
  esac
}

# Podman is required on every Linux profile, cloud included -- unlike the
# build toolchain above, which cloud profiles skip entirely.
install_podman(){
  local manager; manager="$(linux_package_manager)"
  if [[ -z "$manager" ]]; then
    echo 'ERROR: unsupported Linux package manager. Install Podman yourself, then rerun.' >&2
    return 1
  fi

  echo "==> Installing Podman with $manager"
  case "$manager" in
    apt) run_as_root apt-get update; run_as_root apt-get install -y podman ;;
    dnf) run_as_root dnf install -y podman ;;
    yum) run_as_root yum install -y podman ;;
    zypper) run_as_root zypper --non-interactive install podman ;;
    pacman) run_as_root pacman --noconfirm --needed -S podman ;;
    apk) run_as_root apk add podman ;;
  esac
}
