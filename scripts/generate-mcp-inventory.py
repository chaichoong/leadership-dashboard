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
import glob
import shutil
import subprocess
import time
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


def shell_env():
    """Environment for `claude mcp list` that can actually start the servers.

    The github server is launched with `npx`, so a PATH without node makes the
    health check report "Failed to connect" — true of the job's environment,
    false of Kevin's. launchd hands a job PATH=/usr/bin:/bin and no shell
    profile, so the unattended run measured itself rather than the estate.
    agent-tools.sh solves the same problem the same way; nvm is why node is
    never where a bare launchd job expects it.
    """
    env = dict(os.environ)
    extra = []
    node = shutil.which("node")
    if node:
        extra.append(os.path.dirname(node))
    else:
        nvm = sorted(glob.glob(os.path.join(HOME, ".nvm/versions/node/*/bin")))
        if nvm:
            extra.append(nvm[-1])
    extra += ["/opt/homebrew/bin", "/usr/local/bin"]
    existing = env.get("PATH", "")
    env["PATH"] = ":".join([p for p in extra if os.path.isdir(p)] +
                           ([existing] if existing else []))
    return env


def live_health():
    """`claude mcp list` health. Only ever sees locally-configured servers.

    MUST run with cwd=REPO. MCP servers are stored per PROJECT in ~/.claude.json,
    keyed by working directory, so `claude mcp list` from anywhere else prints
    "No MCP servers configured" and exits 0. Under launchd the job inherits a
    different cwd, which on 28 Aug 2026 made the first real run write github as
    "Not checked" instead of "Connected" and drop Kevin's reachable count from
    21 to 20 — a broken read presented as a fact, nightly.
    """
    binary = shutil.which("claude") or os.path.join(HOME, ".local", "bin", "claude")
    if not os.path.exists(binary):
        return {}, "claude binary not found, health not checked this run"
    try:
        proc = subprocess.run(
            [binary, "mcp", "list"],
            capture_output=True, text=True, timeout=120, cwd=REPO,
            env=shell_env(),
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

    # A health check that finds nothing while the config holds servers has not
    # discovered an empty estate, it has failed to look. Writing that result
    # downgrades every local server to "Not checked" and quietly publishes it.
    # Refusing to write leaves the last good list in place, which is correct and
    # current, and the job failure is what gets noticed.
    if not health:
        raise SourceFailure(
            f"`claude mcp list` returned no servers while ~/.claude.json holds "
            f"{len(local)}. That is a failed check, not an empty estate "
            f"({health_note or 'no reason given'}). Most likely cause: it ran "
            f"with the wrong working directory — MCP servers are stored per "
            f"project, so it must run with cwd={REPO}."
        )
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
            # "authorised" counts as reachable: authorisation is on file and has
            # not lapsed. It is a weaker claim than "connected", which means a
            # live check passed this run. See the claudeai group below.
            "kevin": auth in ("connected", "authorised"),
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
        # NOT "connected". The only signals available are an APPEND-ONLY list of
        # connectors ever authorised, plus the needs-auth cache. Nothing records
        # a disconnection, so a connector Kevin removed today would keep reading
        # "Connected" for ever. "Authorised" is the strongest honest claim: the
        # authorisation is on file and has not lapsed.
        auth = "needs-auth" if name in unauthorised else "authorised"
        connector_rows.append(row(name, name.replace("claude.ai ", ""), auth, "verified"))
    groups.append({
        "key": "claudeai",
        "title": "claude.ai connectors",
        "blurb": "Authorised on your Claude account and delivered through the app. "
                 "These are the ones you use day to day. Nothing on this Mac "
                 "records a DISCONNECTION, so if you remove one of these it will "
                 "keep showing here until its authorisation lapses. Treat this "
                 "group as what you have authorised, not as a live check.",
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
            return parse_tools(fh.read())
    except OSError:
        return None


def parse_tools(body):
    """The tool set inside a mcp-tools-data.js body, or None if unreadable."""
    try:
        start = body.index("var MCP_TOOLS = ") + len("var MCP_TOOLS = ")
        data = json.loads(body[start:].rstrip().rstrip(";\n").rstrip(";"))
    except ValueError:
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



PR_BRANCH = "chore/mcp-inventory"
TARGET_REL = "js/mcp-tools-data.js"
CANDIDATE = os.path.join(REPO, ".git", "mcp-inventory-candidate.js")


def tool(*names):
    """Resolve a binary without relying on PATH. launchd sources no profile."""
    for n in names:
        found = shutil.which(n)
        if found:
            return found
    for cand in (os.path.join(HOME, "tools/bin/gh"),
                 os.path.join(HOME, ".local/bin/claude")):
        if os.path.basename(cand) in names and os.path.exists(cand):
            return cand
    return None


def git(*args, **kw):
    """Run git in the repo. Raises on failure so a broken step is loud."""
    return subprocess.run(["git", "-C", REPO, *args],
                          capture_output=True, text=True, check=True, **kw).stdout.strip()


def published_tools():
    """The tool set in origin/main's copy — what the PAGE is actually showing.

    When publishing, the local working file is the wrong baseline: it may be
    ahead of the page (a previous run wrote it) or behind it (someone merged
    from elsewhere). The question worth asking is "has the estate moved since
    what the page shows", so the answer comes from origin/main.
    """
    git("fetch", "--quiet", "origin", "main")
    try:
        body = git("show", f"origin/main:{TARGET_REL}")
    except subprocess.CalledProcessError:
        return None
    return parse_tools(body)


def run_guard_tests(candidate):
    """Run the data-shape tests against the CANDIDATE before publishing it.

    This is the whole point of auto-merging safely. Nothing runs on a pull
    request in this repo, so merging unchecked would let a brand new tool reach
    the page with no description — defeating the guard that exists to stop
    exactly that. The job therefore checks its own work instead of relying on a
    human being the checkpoint.

    Returns (passed, output).
    """
    npx = tool("npx")
    if not npx:
        return False, "npx not found, cannot run the guard tests"
    # ONLY the data-shape block. The publish-safety tests in the same file check
    # the script and the repo's state against origin/main, and one of them
    # legitimately fails while a change is pending — which would mean the gate
    # blocked every publish it was meant to wave through. The gate's question is
    # narrow: is the DATA about to be published well formed and fully described.
    proc = subprocess.run(
        [npx, "vitest", "run", "tests/mcp-inventory.test.js", "-t", "MCP tools list"],
        cwd=REPO, capture_output=True, text=True, timeout=600,
        env=dict(shell_env(), MCP_TOOLS_FILE=candidate, CI="1"),
    )
    return proc.returncode == 0, (proc.stdout + proc.stderr)[-2000:]


def publish_pr(candidate, merge=False):
    """Open (or refresh) a PR carrying the regenerated list.

    WHY PLUMBING AND NOT `git add`. This runs unattended in the MAIN checkout,
    where other sessions routinely have uncommitted work. Touching the index,
    HEAD or the working tree is exactly how one session eats another's changes
    (see the concurrency rules in CLAUDE.md). So the commit is assembled with
    hash-object / read-tree / commit-tree against a THROWAWAY index, and the
    branch ref is written directly. The working tree is never involved.

    It never pushes to main. A fixed branch name means a change that has sat
    unmerged for three days refreshes one PR instead of opening three.
    """
    gh = tool("gh")
    if not gh:
        raise SourceFailure("gh not found, cannot open a PR for the changed list")

    # The path that lands in the repo is a CONSTANT, never derived from an
    # argument. --out can redirect where a test writes; it must never be able to
    # redirect what gets committed.
    rel = TARGET_REL

    git("fetch", "--quiet", "origin", "main")
    base = git("rev-parse", "origin/main")

    blob = git("hash-object", "-w", "--path", rel, candidate)
    index = os.path.join(REPO, ".git", f"index-mcp-inventory-{os.getpid()}")
    env = dict(os.environ, GIT_INDEX_FILE=index)
    try:
        subprocess.run(["git", "-C", REPO, "read-tree", base],
                       env=env, check=True, capture_output=True)
        subprocess.run(["git", "-C", REPO, "update-index", "--add",
                        "--cacheinfo", f"100644,{blob},{rel}"],
                       env=env, check=True, capture_output=True)
        tree = subprocess.run(["git", "-C", REPO, "write-tree"], env=env,
                              check=True, capture_output=True, text=True).stdout.strip()
    finally:
        if os.path.exists(index):
            os.remove(index)

    if tree == git("rev-parse", f"{base}^{{tree}}"):
        return True, "the regenerated list already matches origin/main; nothing to open"

    msg = ("Tools list: the connected-tool inventory has changed\n\n"
           "Opened automatically by the 06:10 mcp-inventory job, which rebuilds\n"
           "js/mcp-tools-data.js from the real MCP configuration and only writes\n"
           "when something actually moved. Review the diff to see what appeared,\n"
           "vanished, or changed authorisation state.\n")
    commit = git("commit-tree", tree, "-p", base, "-m", msg)

    # --force-with-lease has no meaning for a ref we own outright and rewrite
    # each time; the branch exists only to carry this one file.
    git("push", "--force", "origin", f"{commit}:refs/heads/{PR_BRANCH}")

    existing = subprocess.run(
        [gh, "pr", "list", "--head", PR_BRANCH, "--state", "open", "--json", "number"],
        cwd=REPO, capture_output=True, text=True)
    if existing.returncode == 0 and json.loads(existing.stdout or "[]"):
        n = json.loads(existing.stdout)[0]["number"]
        if not merge:
            return True, f"refreshed the existing PR #{n}"
        ok, note = merge_pr(gh)
        return ok, f"refreshed the existing PR #{n}; {note}"

    made = subprocess.run(
        [gh, "pr", "create", "--base", "main", "--head", PR_BRANCH,
         "--title", "Tools list: the connected-tool inventory has changed",
         "--body", msg],
        cwd=REPO, capture_output=True, text=True)
    if made.returncode != 0:
        raise SourceFailure(f"could not open the PR: {made.stderr.strip()}")
    url = made.stdout.strip()
    if not merge:
        return True, f"opened {url}"
    ok, note = merge_pr(gh)
    return ok, f"opened {url}; {note}"


MERGE_ATTEMPTS = 5
MERGE_WAIT_SECONDS = 12


def merge_pr(gh):
    """Squash-merge the open PR. Only ever called when the guard tests passed.

    RETRIES ON PURPOSE. GitHub computes a PR's mergeability asynchronously, so
    merging straight after the branch push loses a race and comes back with
    "Base branch was modified" — which sounds like a conflict and is really just
    "ask me again in a moment". Observed on the very first live run, 28 Aug 2026.
    Backing off and retrying is the difference between hands-off and a PR that
    silently waits for Kevin every time.

    Returns (merged, message).
    """
    last = ""
    for attempt in range(1, MERGE_ATTEMPTS + 1):
        done = subprocess.run(
            [gh, "pr", "merge", PR_BRANCH, "--squash", "--delete-branch"],
            cwd=REPO, capture_output=True, text=True)
        if done.returncode == 0:
            note = f" (after {attempt} tries)" if attempt > 1 else ""
            return True, f"merged it{note}; the page updates in a couple of minutes"
        last = done.stderr.strip()
        # A genuine conflict or a closed PR will never resolve by waiting.
        if "conflict" in last.lower() or "not open" in last.lower():
            break
        if attempt < MERGE_ATTEMPTS:
            time.sleep(MERGE_WAIT_SECONDS)
    return False, f"could NOT merge it after {MERGE_ATTEMPTS} tries, so it is waiting for you: {last}"


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

    publishing = "--publish" in argv

    # WHEN PUBLISHING, NOTHING IS WRITTEN INTO THE WORKING TREE. The candidate
    # goes inside .git/, which git never tracks, so the shared checkout stays
    # byte-for-byte clean whatever happens. The baseline is origin/main — what
    # the page is actually showing — rather than a local file that may be ahead
    # of it or behind it.
    if publishing:
        before = published_tools()
        target = CANDIDATE
    else:
        before = previous_tools(out)
        target = out
    after = current_tools(data)
    changed = before is None or before != after

    # ONLY WRITE WHEN SOMETHING ACTUALLY MOVED. Rewriting nightly for a fresh
    # timestamp would leave a permanently-modified tracked file in a shared
    # checkout, which is precisely the kind of thing another session sweeps into
    # an unrelated commit (see the concurrency rules in CLAUDE.md).
    #
    # It also solves the alerting problem. The morning digest does not carry job
    # stdout, so a "CHANGED" line printed to a log would be a message nobody
    # reads. Writing only on a real change makes the modified file itself the
    # signal: a clean `git status` means the estate has not moved, and a diff on
    # js/mcp-tools-data.js means it has and is worth shipping.
    if changed:
        with open(target, "w") as fh:
            fh.write(body)
    c = data["counts"]
    # Say which of the two things actually happened. A log claiming "Wrote" on a
    # run that deliberately left the file alone teaches the reader to disbelieve
    # the log, and this log is the only place the nightly run speaks.
    print(f"{'Wrote' if changed else 'Checked'} "
          f"{TARGET_REL if publishing else out}")
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
    elif changed:
        gone = sorted(n for (n, _s, _a, _g) in before - after)
        new_ = sorted(n for (n, _s, _a, _g) in after - before)
        print("CHANGED: the tools list has moved since it was last committed.")
        if new_:
            print(f"  appeared or changed state: {', '.join(new_)}")
        if gone:
            print(f"  gone or changed state: {', '.join(gone)}")
        if publishing:
            try:
                passed, detail = run_guard_tests(target)
                print("  guard tests " + ("passed" if passed
                      else "FAILED, so it will NOT be merged"))
                shipped, note = publish_pr(target, merge=passed)
                print(f"  {note}")
                if passed and not shipped:
                    print(f"FAIL: the list changed and passed its tests, but the "
                          f"merge did not go through: {note}", file=sys.stderr)
                    return 1
                if not passed:
                    print("FAIL: the new list did not pass its own tests. The PR "
                          f"is open for you to look at.\n{detail}", file=sys.stderr)
                    return 1
            except (SourceFailure, subprocess.CalledProcessError,
                    subprocess.TimeoutExpired) as exc:
                why = getattr(exc, "stderr", "") or str(exc)
                print(f"FAIL: the list changed but could not be published: "
                      f"{str(why).strip()}", file=sys.stderr)
                return 1
            finally:
                if os.path.exists(CANDIDATE):
                    os.remove(CANDIDATE)
        else:
            print("  js/mcp-tools-data.js is now modified in git — commit it to "
                  "update the AI Agents page (or run with --publish).")
    else:
        print("No change since the committed list. File left untouched, so a "
              "clean git status means the estate has not moved.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
