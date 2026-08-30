#!/bin/bash
# agent-tools.sh — the ONE definition of what a headless agent run may use.
#
# WHY THIS FILE EXISTS (27 Aug 2026)
# ----------------------------------
# Every agent runner capped itself to `Bash(python3:*)` and `Bash(curl:*)`.
# Nobody chose that as a policy; it was copied from runner to runner and never
# revisited. The effect was that an agent asked to "investigate the Cloudflare
# KV limit" could not read a file, could not search the web, and could not open
# a page. The only action it had a route for was writing a document, so every
# agent looked like it could only draft emails. It was a tool-layer problem
# wearing a reasoning-layer costume.
#
# Measured the same day: `claude mcp list` under the agents' own binary and
# token returned github (connected) and metricool (needs auth). None of the
# connectors Kevin uses interactively — GoHighLevel, Airtable, Supabase, Gmail,
# Slack, Chrome — exist for a headless run. Those are claude.ai account
# connectors delivered through the desktop app's session, and launchd never
# sees them.
#
# So the fix is not "wire up the MCPs". It is: give the agents the built-in
# tools that need no connector, and route everything else through scripts in
# this repo that already hold the credentials properly (agent-dispatch.py,
# send-email.py, agent-browser.js).
#
# WHAT IS DELIBERATELY ABSENT
# ---------------------------
# * The Airtable MCP. It is broken (auth error, see CLAUDE.md) and every
#   Airtable read/write already goes through agent-dispatch.py, which is
#   drift-tested against config.js. Two routes to the same table is how the
#   field IDs drift apart.
# * `Bash(*)`. An unrestricted shell is not an initiative unlock, it is the
#   removal of the audit trail. Each new capability gets its own named script
#   so the run log says what was actually done.
# * Edit / Write. Agents are read-only with respect to code (agent-slot-run.sh
#   states the rule); a tool they cannot use cannot be used by accident.
#
# Sourced by: agent-slot-run.sh, handback-poll-run.sh, inbound-triage-run.sh,
# task-manager-run.sh. Guarded by tests/agent-tools-parity.test.js, which fails
# if a runner hand-rolls its own list again.

# Node lives under nvm, which launchd does not put on PATH. Resolve it once
# here so the browser lane is not silently unavailable in exactly the
# unattended runs it exists for.
AGENT_NODE_BIN="$(command -v node || ls -1d /Users/kevinbrittain/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)"
export AGENT_NODE_BIN

# The shared set. Extra per-runner tools are appended by the caller, never
# substituted (handback-poll needs osascript for iMessage sends).
AGENT_ALLOWED_TOOLS=(
  # Existing capability, unchanged.
  "Bash(python3:*)"
  "Bash(curl:*)"

  # RESEARCH (added 27 Aug 2026). Reading was already UNLOCKED in
  # ~/.claude/agents/GUARDRAILS.md — it simply had no tool behind it. An agent
  # that cannot look anything up has to guess or ask Kevin, and guessing is the
  # failure mode the fabrication rule exists to stop.
  "WebSearch"
  "WebFetch"

  # READING THIS MACHINE. Previously an agent had to shell out to python3 to
  # read a file, which works but produces a run log full of one-line scripts
  # instead of a legible trail of what it looked at.
  "Read"
  "Grep"
  "Glob"

  # THE BROWSER LANE (Kevin's ruling, 27 Aug 2026: "Chrome yes but no
  # submission without screengrab approval at first"). node runs
  # scripts/agent-browser.js, which is the only route to a browser and which
  # physically cannot submit a form without an approved task id.
  "Bash(node:*)"
)
export AGENT_ALLOWED_TOOLS
