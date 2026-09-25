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
#   states the rule). Leaving them off THIS list is not what enforces that:
#   see AGENT_SETTINGS_FILE below.
#
# Sourced by: agent-slot-run.sh, handback-poll-run.sh, inbound-triage-run.sh,
# task-manager-run.sh, signin-pickup-run.sh. Guarded by
# tests/agent-initiative.test.js, which fails if a runner hand-rolls its own
# list again or drops the deny list below.

# Node lives under nvm, which launchd does not put on PATH. Resolve it once
# here so the browser lane is not silently unavailable in exactly the
# unattended runs it exists for.
AGENT_NODE_BIN="$(command -v node || ls -1d /Users/kevinbrittain/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)"
export AGENT_NODE_BIN
# Resolving it was not enough. Agents are allowed `Bash(node:*)` and type
# `node scripts/agent-browser.js`, which looks node up on PATH, and launchd's
# PATH is /usr/bin:/bin:/usr/sbin:/sbin. So every unattended browser step died
# with "command not found: node" while this variable sat unused (6 Chedburgh
# Place insurance, parked 21-25 Sep 2026 after Kevin had signed in). Put its
# folder on PATH, which the agent's shell inherits.
if [ -n "$AGENT_NODE_BIN" ]; then
  case ":$PATH:" in
    *":$(dirname "$AGENT_NODE_BIN"):"*) ;;
    *) PATH="$(dirname "$AGENT_NODE_BIN"):$PATH"; export PATH ;;
  esac
fi

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

# THE ROBOT-ONLY DENY LIST (audit item 121, Kevin approved 21 Sep 2026)
# ----------------------------------------------------------------------
# --allowedTools ADDS permissions; it never takes any away. A headless run also
# loads Kevin's own ~/.claude/settings.json and the repo's untracked
# .claude/settings.local.json, which allow Edit, Write, Bash(git:*) and
# Bash(gh:*). So every agent that "could not edit code" could, and could commit
# and push. Measured from the robots' own transcripts, 14-21 Sep 2026, all
# five runners: 0 commits or pushes, 0 edits to a tracked code file, 3 stray
# `git checkout -- <temp file>` clean-up attempts, and 186 temp-file writes into
# scripts/ plus 114 at the repo root, all against the runners' own
# "scratch only" rule.
#
# agent-settings.json is passed with --settings, which sits above every file
# except managed settings, and a deny there beats an allow from any tier. It
# denies git/gh writes and Edit/Write on the code folders and root code files,
# and deliberately leaves writable: monitoring/ (counts-only reports), the
# per-run scratch under ~/knowledge-os/logs/, the brain, and memory.
#
# Not dropped with --setting-sources, because that would also drop Kevin's
# user hooks, which apply to headless runs on purpose.
#
# Limits (documented by Claude Code, not a gap in this file): a deny rule
# matches the command Claude writes, so `/usr/bin/git push`, `sh -c 'git ...'`
# or a python3 script that opens a file itself are not caught. It closes the
# ordinary route, which is the one every agent actually used.
#
# The engine silently IGNORES a settings file that is not valid JSON and the
# run goes ahead without it (rc=0, back-tested 21 Sep 2026); a missing file
# fails the run loudly. tests/agent-initiative.test.js parses it on every push.
AGENT_SETTINGS_FILE="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-settings.json"
export AGENT_SETTINGS_FILE

# WORKING FOLDERS (Kevin approved 21 Sep 2026)
# --------------------------------------------
# Every runner tells its robot to keep working files in a folder under
# ~/knowledge-os/logs/, outside the repo, and since the deny list above it may
# not write code paths in the repo either. But a run started in the repo may
# only mkdir or redirect (`> file`) inside its working directories, and nothing
# ever added that folder. The robots' own transcripts, 14-21 Sep 2026: "mkdir
# in '.../logs/agent-dispatch/<run>/...' was blocked. For security, Claude Code
# may only create directories in the allowed working directories", in 10 of 12
# robot runs on 19 Sep and 11 of 13 on 20 Sep, on 2.1.128 and 2.1.278 alike;
# refused robots tried /tmp next (refused too) and left temp files in the
# repo. (The Write tool was never blocked: Kevin's user settings allow it.)
#
# So each runner passes `--add-dir` for exactly the folder it is told to write,
# created before claude starts, and nothing wider:
#   agent-slot-run.sh      $SCRATCH        logs/<job>/scratch
#   task-manager-run.sh    $SCRATCH        logs/task-manager/scratch
#   inbound-triage-run.sh  $SCRATCH        logs/inbound-triage/scratch
#                          $DISPATCH_RUNS  logs/agent-dispatch (the dispatch
#                                          skill names its run folder mid-run)
#   handback-poll-run.sh   $RUNDIR         logs/agent-dispatch/<this run>
#   signin-pickup-run.sh   $RUNDIR         logs/agent-dispatch/<this run>-signin
# An added directory follows the working directory's rules (code.claude.com/
# docs/en/permissions, "Working directories"), so under --permission-mode
# acceptEdits mkdir and redirects there are accepted, /tmp and the rest of the
# disk stay refused, and the deny list still wins inside the repo. Back-tested
# on 2.1.278 with each runner's exact flags. Guarded by
# tests/agent-initiative.test.js ("robot working folders").
