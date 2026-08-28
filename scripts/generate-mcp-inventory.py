#!/usr/bin/env python3
"""
generate-mcp-inventory.py — regenerate js/mcp-tools-data.js

WHY THIS EXISTS (28 Aug 2026)
-----------------------------
Kevin asked a simple question: what tools are we actually connected to? There
was no answer anywhere, because MCP servers reach Claude Code from four
different places and no single file lists them.

The trap this script is built around: `claude mcp list` from a shell returns
only TWO servers (github, metricool). The ~20 connectors Kevin uses
interactively are delivered through the desktop app's session and are invisible
to any script. So a naively "generated" list would confidently report an estate
of 2 and be wrong by an order of magnitude.

Every row therefore carries `source`:
  verified — read from a real config file or a live health check THIS RUN
  declared — hand-listed here because no machine-readable source exists

The page shows that split in its header. A list you cannot attribute cannot be
acted on, which is the same lesson as the recon-accuracy card.

THE SECOND FACT THIS ANSWERS. Kevin's MCPs are NOT his agents' MCPs.
scripts/agent-tools.sh is the one definition of what a headless agent run may
use, and it contains no MCP tools at all. That is deliberate (see its header),
but it means an agent cannot reach any connector Kevin can. This script reads
that allowlist rather than assuming, so the number on the page moves the day
the policy moves.

CONTROLS. Every source has an expected floor. A wrong path, a renamed key or a
Claude Code upgrade that moves a file would otherwise return nothing and read
as "the estate shrank" forever. Any source coming back empty FAILS the run
instead of writing a shorter list.

SECRETS. Local MCP configs carry tokens in their `env` block. This script reads
config to learn WHICH servers exist and never copies a value out of `env`, and
the writer asserts no known secret marker reaches the output file.
"""

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLAUDE_JSON = os.path.join(HOME, ".claude.json")
NEEDS_AUTH = os.path.join(HOME, ".claude", "mcp-needs-auth-cache.json")
AGENT_TOOLS = os.path.join(REPO, "scripts", "agent-tools.sh")
OUT = os.path.join(REPO, "js", "mcp-tools-data.js")

# Plain English, for a non-technical operator. Keyed by the server name as it
# appears in its own source. Anything missing renders an honest placeholder
# rather than a blank, so a new tool is visibly undescribed instead of silently
# meaningless.
DESCRIPTIONS = {
    # Local / repo
    "github": "Reads and writes code on GitHub: pull requests, issues, file contents. This is how the platform ships.",
    "metricool": "Social media scheduling and stats. Never authorised, so nothing uses it.",
    "gmail-write": "A second, separate Gmail connection that can send. Set up outside this repo; day-to-day sending goes through scripts/send-email.py instead.",
    # claude.ai connectors
    "claude.ai Airtable": "Reads and writes the Operations Director base: tasks, tenancies, costs, agents.",
    "claude.ai Gmail": "Reads, labels and drafts email in your inbox.",
    "claude.ai Google Calendar": "Reads and creates calendar events.",
    "claude.ai Google Drive": "Reads and writes files in Drive, including the AI brain vault.",
    "claude.ai Slack": "Reads channels and sends messages.",
    "claude.ai Zoom for Claude": "Reads Zoom recordings, transcripts and meeting notes.",
    "claude.ai Claude Code Remote": "Lets you drive a Claude Code session from another device.",
    "claude.ai Make": "Make.com automations. Never authorised, so nothing uses it.",
    "claude.ai Stripe": "Payments and subscriptions. Never authorised. Will matter at the Supabase cutover when clients start paying.",
    # Built into the Claude apps
    "Claude_Browser": "An in-app browser for opening pages, filling forms and checking the deployed site.",
    "claude-in-chrome": "Drives your real Chrome, with your logged-in sessions. This is the lane the prospecting agent uses.",
    "computer-use": "Clicks and types on your Mac desktop for apps that have no other connection.",
    "PDF_Tools": "Reads, fills, signs and splits PDFs.",
    "Read_and_Send_iMessages": "Reads and sends iMessages. The inbound sweep uses this.",
    "terminal": "Reads what is on screen in a terminal window.",
    "scheduled-tasks": "Creates and lists scheduled Claude tasks.",
    "mcp-registry": "Searches the public directory of available connectors.",
    "Claude_Code_iOS_Simulator": "Builds and drives iOS apps in the simulator. Nothing here uses it.",
    "visualize": "Draws diagrams and charts inline in a session.",
    "ccd_session": "Session housekeeping inside the Claude desktop app: chapters, background task chips.",
    "ccd_session_mgmt": "Lists and searches your past Claude Code sessions.",
    "ccd_directory": "Changes which folder a session is working in.",
}

# Servers built into the Claude desktop app and CLI. There is no file on disk
# that lists these — they arrive with the app — so they are DECLARED. Verified
# by hand against a live session's tool list on 28 Aug 2026. Add to this list in
# the same change that starts using a new built-in.
DECLARED_BUILTINS = [
    "Claude_Browser",
    "claude-in-chrome",
    "computer-use",
    "PDF_Tools",
    "Read_and_Send_iMessages",
    "terminal",
    "scheduled-tasks",
    "mcp-registry",
    "Claude_Code_iOS_Simulator",
    "visualize",
    "ccd_session",
    "ccd_session_mgmt",
    "ccd_directory",
]

# Floors. Each is the number below which the source has plainly failed to read
# rather than genuinely shrunk. Deliberately set at the level that proves the
# read worked, not at today's count, so adding a tool does not fail the run.
FLOORS = {
    "local": 1,
    "claudeai": 3,
    "needsauth": 5,
    "builtins": 5,
    "agenttools": 3,
}


class SourceFailure(Exception):
    """A source returned nothing. Never write a shorter list on a bad read."""


def read_json(path, label):
    if not os.path.exists(path):
        raise SourceFailure(f"{label}: file not found at {path}")
    try:
        with open(path) as fh:
            return json.load(fh)
    except (ValueError, OSError) as exc:
        raise SourceFailure(f"{label}: could not be read ({exc})")


def describe(name):
    return DESCRIPTIONS.get(
        name,
        "No description recorded yet. Add one to DESCRIPTIONS in "
        "scripts/generate-mcp-inventory.py so this tool is not just a name.",
    )


def local_servers(claude_json):
    """MCP servers configured in files on this Mac. Names only, never env."""
    found = {}
    for project, cfg in (claude_json.get("projects") or {}).items():
        for name in (cfg.get("mcpServers") or {}):
            # Worktrees give REPO a different path to the main checkout, so
            # match the project by name rather than by exact path.
            same = os.path.basename(project) == os.path.basename(REPO) or \
                project.rstrip("/").endswith("/leadership-dashboard")
            scope = "this repo" if same else project.replace(HOME, "~")
            found.setdefault(name, []).append(scope)
    if len(found) < FLOORS["local"]:
        raise SourceFailure(
            f"~/.claude.json: found {len(found)} locally configured MCP servers, "
            f"expected at least {FLOORS['local']}. The projects/mcpServers keys "
            "may have moved in a Claude Code upgrade."
        )
    return found


def claudeai_connectors(claude_json):
    ever = claude_json.get("claudeAiMcpEverConnected") or []
    if len(ever) < FLOORS["claudeai"]:
        raise SourceFailure(
            f"~/.claude.json: claudeAiMcpEverConnected held {len(ever)} entries, "
            f"expected at least {FLOORS['claudeai']}."
        )
    return list(ever)


def needs_auth(cache):
    if len(cache) < FLOORS["needsauth"]:
        raise SourceFailure(
            f"mcp-needs-auth-cache.json: held {len(cache)} entries, expected at "
            f"least {FLOORS['needsauth']}."
        )
    return set(cache.keys())


def live_health():
    """`claude mcp list` health. Only ever sees locally-configured servers."""
    binary = shutil.which("claude") or os.path.join(HOME, ".local", "bin", "claude")
    if not os.path.exists(binary):
        return {}, "claude binary not found, health not checked this run"
    try:
        proc = subprocess.run(
            [binary, "mcp", "list"],
            capture_output=True, text=True, timeout=120,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        return {}, f"claude mcp list did not complete ({exc})"
    health = {}
    for line in proc.stdout.splitlines():
        if ":" not in line or " - " not in line:
            continue
        name = line.split(":", 1)[0].strip()
        if not name:
            continue
        tail = line.rsplit(" - ", 1)[1].strip().lower()
        if "connected" in tail:
            health[name] = "connected"
        elif "auth" in tail:
            health[name] = "needs-auth"
        else:
            health[name] = "unknown"
    if not health:
        return {}, "claude mcp list returned no servers"
    return health, ""


def agent_mcp_tools():
    """Parse AGENT_ALLOWED_TOOLS. Returns the MCP server names agents may call."""
    if not os.path.exists(AGENT_TOOLS):
        raise SourceFailure(f"agent-tools.sh not found at {AGENT_TOOLS}")
    with open(AGENT_TOOLS) as fh:
        body = fh.read()
    block = re.search(r"AGENT_ALLOWED_TOOLS=\((.*?)\n\)", body, re.S)
    if not block:
        raise SourceFailure(
            "agent-tools.sh: could not find the AGENT_ALLOWED_TOOLS=( ... ) block. "
            "If the allowlist moved, this parser must move with it."
        )
    entries = re.findall(r'"([^"]+)"', block.group(1))
    if len(entries) < FLOORS["agenttools"]:
        raise SourceFailure(
            f"agent-tools.sh: parsed {len(entries)} allowed tools, expected at "
            f"least {FLOORS['agenttools']}. The parse is probably broken."
        )
    servers = set()
    for entry in entries:
        match = re.match(r"mcp__([A-Za-z0-9_-]+)__", entry)
        if match:
            servers.add(match.group(1))
        elif entry.startswith("mcp__"):
            servers.add(entry[5:].split("__")[0])
    return servers, entries


def build():
    claude_json = read_json(CLAUDE_JSON, "~/.claude.json")
    auth_cache = read_json(NEEDS_AUTH, "mcp-needs-auth-cache.json")

    local = local_servers(claude_json)
    connectors = claudeai_connectors(claude_json)
    unauthorised = needs_auth(auth_cache)
    health, health_note = live_health()
    agent_servers, agent_entries = agent_mcp_tools()
    plugins = sorted(
        k.split("@")[0] for k in (claude_json.get("pluginUsage") or {})
    )

    if len(DECLARED_BUILTINS) < FLOORS["builtins"]:
        raise SourceFailure("DECLARED_BUILTINS has been emptied out.")

    def row(name, label, auth, source, scope="", agents=None):
        return {
            "name": label,
            "what": describe(name),
            "auth": auth,
            "kevin": auth == "connected",
            "agents": bool(agents) if agents is not None else (name in agent_servers),
            "source": source,
            "scope": scope,
        }

    groups = []

    # 1. Configured in files on this Mac. The only group `claude mcp list` sees.
    local_rows = []
    for name in sorted(local):
        auth = health.get(name, "needs-auth" if name in unauthorised else "unknown")
        local_rows.append(row(name, name, auth, "verified", ", ".join(local[name])))
    groups.append({
        "key": "local",
        "title": "Set up in files on this Mac",
        "blurb": "The only tools a script can check the health of. Everything below "
                 "this group is invisible to the command line.",
        "tools": local_rows,
    })

    # 2. claude.ai account connectors. Names are verified from config; their live
    #    health is not readable by a script, only their unauthorised state is.
    connector_names = sorted(set(connectors) | {
        k for k in unauthorised if k.startswith("claude.ai ")
    })
    connector_rows = []
    for name in connector_names:
        auth = "needs-auth" if name in unauthorised else "connected"
        connector_rows.append(row(name, name.replace("claude.ai ", ""), auth, "verified"))
    groups.append({
        "key": "claudeai",
        "title": "claude.ai connectors",
        "blurb": "Authorised on your Claude account and delivered through the app. "
                 "These are the ones you actually use day to day. A script cannot "
                 "confirm they are live, only that they were connected and whether "
                 "authorisation has lapsed.",
        "tools": connector_rows,
    })

    # 3. Built into the Claude apps. No file lists these.
    groups.append({
        "key": "builtin",
        "title": "Built into the Claude apps",
        "blurb": "Arrive with the desktop app and the command line. Nothing to "
                 "authorise and nothing to break, but also nothing on disk that "
                 "lists them, so this group is checked by hand.",
        "tools": [row(n, n.replace("_", " "), "connected", "declared")
                  for n in sorted(DECLARED_BUILTINS)],
    })

    # 4. Plugin marketplaces. Installed, never authorised, never used.
    plugin_rows = []
    for key in sorted(k for k in unauthorised if k.startswith("plugin:")):
        _, bundle, server = key.split(":", 2)
        plugin_rows.append({
            "name": server,
            "what": f"Part of the {bundle} plugin bundle. Installed but never "
                    "authorised, so nothing can use it.",
            "auth": "needs-auth",
            "kevin": False,
            "agents": False,
            "source": "verified",
            "scope": bundle,
        })
    groups.append({
        "key": "plugins",
        "title": "Plugin bundles",
        "blurb": f"{len(plugins)} bundles are installed ({', '.join(plugins)}). "
                 "Every connector inside them is unauthorised, so none of them "
                 "does anything today. Either authorise the ones you want or "
                 "remove the bundles.",
        "tools": plugin_rows,
    })

    all_tools = [t for g in groups for t in g["tools"]]
    return {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generator": "scripts/generate-mcp-inventory.py",
        "healthNote": health_note,
        "agentAllowlistSize": len(agent_entries),
        "counts": {
            "total": len(all_tools),
            "verified": sum(1 for t in all_tools if t["source"] == "verified"),
            "declared": sum(1 for t in all_tools if t["source"] == "declared"),
            "kevin": sum(1 for t in all_tools if t["kevin"]),
            "agents": sum(1 for t in all_tools if t["agents"]),
            "needsAuth": sum(1 for t in all_tools if t["auth"] == "needs-auth"),
        },
        "groups": groups,
    }


HEADER = """// ══════════════════════════════════════════════════════════════════════
// MCP TOOLS DATA — every connector Claude Code can reach
// ══════════════════════════════════════════════════════════════════════
// GENERATED FILE. Do not edit by hand: scripts/generate-mcp-inventory.py
// rewrites it nightly and your edit will be lost. To change a description,
// edit DESCRIPTIONS in that script.
//
// Each row is marked `verified` (read from a real config file or a live health
// check) or `declared` (hand-listed because nothing on disk records it). The
// page shows that split, because `claude mcp list` only ever sees two of these
// servers and a list you cannot attribute cannot be acted on.
//
// Guarded by tests/mcp-inventory.test.js.
"""


def previous_tools(path):
    """The tool set in the file we are about to replace, or None if unreadable.

    Compared WITHOUT generatedAt: the timestamp changes every run, so a naive
    file diff says "changed" every night and means nothing. What Kevin needs to
    know is when a tool actually appeared, vanished or changed authorisation
    state, because that is the thing worth shipping to the page.
    """
    if not os.path.exists(path):
        return None
    try:
        with open(path) as fh:
            body = fh.read()
        start = body.index("var MCP_TOOLS = ") + len("var MCP_TOOLS = ")
        data = json.loads(body[start:].rstrip().rstrip(";\n").rstrip(";"))
    except (ValueError, OSError):
        return None
    return {
        (t["name"], t.get("scope", ""), t["auth"], t["agents"])
        for g in data.get("groups", []) for t in g.get("tools", [])
    }


def current_tools(data):
    return {
        (t["name"], t.get("scope", ""), t["auth"], t["agents"])
        for g in data["groups"] for t in g["tools"]
    }


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    # --out exists so the control tests can exercise a failing read without
    # overwriting the real data file. Without it, a test that proves the
    # generator still succeeds on good input silently replaces the live list
    # with the test's fixture — which is the exact silent-shrink failure this
    # whole script is built to prevent. Found the hard way, 28 Aug 2026.
    out = OUT
    if "--out" in argv:
        out = argv[argv.index("--out") + 1]

    try:
        data = build()
    except SourceFailure as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        print(f"Refusing to write a shorter list. {out} is unchanged.",
              file=sys.stderr)
        return 1

    body = HEADER + "\nvar MCP_TOOLS = " + json.dumps(data, indent=2) + ";\n"

    # A config read that strayed into an env block would put a token in a public
    # repo. Cheap assertion, catastrophic thing to get wrong.
    for marker in ("github_pat_", "ghp_", "xoxb-", "xoxp-", "AKIA", "Bearer "):
        if marker.lower() in body.lower():
            print(f"FAIL: refusing to write, output contains '{marker}'", file=sys.stderr)
            return 1

    before = previous_tools(out)
    after = current_tools(data)

    with open(out, "w") as fh:
        fh.write(body)
    c = data["counts"]
    print(f"Wrote {out}")
    print(f"  {c['total']} tools: {c['verified']} verified, {c['declared']} declared")
    print(f"  reachable by Kevin: {c['kevin']}   by headless agents: {c['agents']}")
    print(f"  unauthorised: {c['needsAuth']}")
    if data["healthNote"]:
        print(f"  note: {data['healthNote']}")

    # The page is served from GitHub Pages, so regenerating the file on this Mac
    # does NOT update what Kevin looks at — that needs a commit. No scheduled job
    # in this repo pushes to main on its own, so instead of pretending, this says
    # loudly when there is something worth shipping. The 11am Job Digest carries
    # it. Silence means the estate genuinely has not moved.
    if before is None:
        print("CHANGED: no previous list to compare against (first run).")
    elif before != after:
        gone = sorted(n for (n, _s, _a, _g) in before - after)
        new_ = sorted(n for (n, _s, _a, _g) in after - before)
        print("CHANGED: the tools list has moved since it was last committed.")
        if new_:
            print(f"  appeared or changed state: {', '.join(new_)}")
        if gone:
            print(f"  gone or changed state: {', '.join(gone)}")
        print("  commit js/mcp-tools-data.js to update the AI Agents page.")
    else:
        print("No change since the committed list.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
