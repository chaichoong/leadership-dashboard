#!/usr/bin/env bash
# Warn when a file hardcodes an AI model ID inside an API call.
#
# Why: js/ai-models.js is the single source of truth for the browser (window.AI_MODELS;
# js/config.js re-exports it as AI_MODEL_DEFAULT / AI_MODEL_LIGHT). A hardcoded ID that
# Anthropic retires is an app-wide AI outage — it has already happened once.
#
# Cloudflare Workers cannot read window.AI_MODELS, so each worker names the model ONCE
# in its own wrangler.toml [vars] and reads it off `env` at the call site. Do NOT use a
# module-level constant in a worker: module scope cannot see `env`, which is precisely
# how agent-runner and contractor-bot ended up stranded on a stale model (fixed 16 Jul,
# commit b59f0e5).
#
# Matches `model: "claude-..."` only. Bare "claude-" strings are ignored on purpose:
# the claude-proxy.kevinbrittain.workers.dev hostname and the SOP docs that describe
# which model a feature uses are legitimate and must not trip this.
#
# Called from .claude/settings.json PostToolUse. Always exits 0 — advisory, never blocks.

set -uo pipefail

PATTERN='["'"'"']?model["'"'"']?[[:space:]]*:[[:space:]]*["'"'"']claude-'

for f in "$@"; do
  case "$f" in
    */js/config.js|js/config.js) continue ;;   # the source of truth itself
    *node_modules/*) continue ;;
    *.js|*.html) ;;
    *) continue ;;
  esac

  [ -f "$f" ] || continue

  if hits=$(grep -nE "$PATTERN" "$f" 2>/dev/null); then
    echo "WARN: $f hardcodes an AI model ID in an API call:"
    echo "$hits" | sed 's/^/    /'
    echo "    Fix (browser): window.AI_MODELS.default / .light from js/ai-models.js, or"
    echo "                   AI_MODEL_DEFAULT / AI_MODEL_LIGHT from js/config.js."
    echo "    Fix (worker):  env.AI_MODEL_DEFAULT / env.AI_MODEL_LIGHT, with the value in"
    echo "                   that worker's wrangler.toml [vars]. NOT a module-level const —"
    echo "                   module scope cannot see env, which is how the old literals got"
    echo "                   stranded on a retired model in the first place."
    echo "    A retired ID is an app-wide AI outage."
  fi
done

exit 0
