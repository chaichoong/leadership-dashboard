#!/usr/bin/env python3
"""The robots' keys: one private register, a daily check, and a one-paste replace (Kevin, 16 Oct 2026).

WHY THIS EXISTS
---------------
Kevin, 16 Oct 2026: "There are so many occasions where it's updating API keys and stuff like that,
which I appreciate the security of. If you log them all in a central place that's not publicly
available and police that, then you can manage that side of things for me. I don't need to be doing
that." The same day he ruled that he does four things only: approve, correct wrong work, pay and
give access. A key is access: he gives it once, and the estate keeps it.

Before this, nothing knew which keys existed, which script read each one, where its copies lived or
when it ran out. The exposed Airtable key's card asked him for 18 steps because nobody knew that
five Cloudflare Workers and GitHub held copies, so a one-click Regenerate would have broken them.

WHAT IT DOES
------------
- The register, ~/.config/od/key-register.json (0600, on the Mac mini, never in the repo): one row per
  file in ~/.config/od and per Worker or GitHub secret, saying what it is, what reads it, every copy,
  how it renews, when it runs out and when it last passed a test. Names, places and dates only. A
  key's value is never in it.
- `check`: tests each key against its own service with a harmless read (the value is never printed),
  watches end dates, tightens any key file another user could read to 0600, finds files and copies
  nobody has described, and deletes a pasted key left behind. Saved to
  ~/knowledge-os/logs/key-register/last-check.json; scripts/estate-status.py turns it into the "keys"
  row every ten minutes and re-runs it once a day, or as soon as a key file changes. A row red for
  2 days becomes one Builder task (estate-status.py's red pass): never a card for Kevin.
- `replace NAME`: the new value arrives in a file the Robot sign-in app wrote with mode 0600 (Kevin
  pastes it into a hidden box), or on stdin. It is tested BEFORE anything is written, then written to
  the key file and pushed to every Worker and GitHub copy, all through stdin, then tested again.
  `--generate` makes a new value for a key we made ourselves (a key shared between the Mac and a
  Worker), so those never need Kevin at all.

THE RULES THAT MATTER MORE THAN THE CODE
----------------------------------------
- No key value ever reaches stdout, stderr, a log, the register, a command line (`ps` shows every
  process's arguments) or an AI. Values move only through stdin and 0600 files. Passwords and payment
  details are not keys and never come here: they stay Kevin's.
- A key that cannot be tested here is "not tested", never green. A service that cannot be reached is
  "could not test", never a failure of the key and never a pass.
- A passcode people type is never changed by a script.

Usage:
  python3 scripts/key-register.py seed                 build or refresh the register (reads the Workers and GitHub)
  python3 scripts/key-register.py check [--json]       test every key now and save the result
  python3 scripts/key-register.py report               the register and the last check, in plain words
  python3 scripts/key-register.py names                the keys Replace a key offers: name<TAB>label
  python3 scripts/key-register.py replace NAME (--from-file PATH | --stdin | --generate)
  python3 scripts/key-register.py selftest
"""
import glob
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
CONFIG_DIR = os.path.expanduser("~/.config/od")
REGISTER = os.path.join(CONFIG_DIR, "key-register.json")
INCOMING = os.path.join(CONFIG_DIR, ".incoming")       # where the Robot sign-in app writes a pasted key
LOGS = os.path.expanduser("~/knowledge-os/logs/key-register")
LAST_CHECK = os.path.join(LOGS, "last-check.json")
REPLACE_LOG = os.path.join(LOGS, "replace.jsonl")
GITHUB_REPO = "chaichoong/leadership-dashboard"
CF_ACCOUNT = "c4206efef5c8ea5d6b9bfac3d281e0db"   # an account id, not a secret (wrangler whoami prints it)
CF_API = "https://api.cloudflare.com/client/v4/accounts/%s/workers/scripts/%%s/secrets" % CF_ACCOUNT
STATUS_KEY = "keys"

CHECK_EVERY_HOURS = 24
EXPIRY_RED_DAYS = 14          # red this close to the end: the red pass raises its Builder task 2 days later
EXPIRY_AMBER_DAYS = 30
INCOMING_MAX_MINUTES = 60
HTTP_TIMEOUT = 20
CLAUDE_TOKEN_DAYS = 365       # a `claude setup-token` sign-in lasts a year (Anthropic's own wording)

# Commands, overridable so a test can stand in for them (never a real Worker or GitHub write).
WRANGLER = os.environ.get("KEY_REGISTER_WRANGLER", "npx --yes wrangler").split()
GH = os.environ.get("KEY_REGISTER_GH", "gh").split()

KINDS = ("key", "renews", "shared", "passcode", "id", "setting", "worker-only", "unknown")

# What each file in ~/.config/od is. A name not here is "unknown" and is flagged, so a new key is
# never silently left out. `test` names a function in TESTS ("" = no safe test here).
CATALOGUE = {
    "airtable_pat": {"service": "Airtable", "kind": "key", "test": "airtable",
                     "purpose": "the robots' Airtable key: almost every script, five Workers and GitHub",
                     "renew": "Kevin presses Regenerate on airtable.com/create/tokens (the robots' row), then pastes it into Replace a key"},
    "github_pat": {"service": "GitHub", "kind": "key", "test": "github",
                   "purpose": "reads the repo's tools list and site map",
                   "renew": "Kevin makes a new token on github.com/settings/personal-access-tokens, then pastes it into Replace a key"},
    "cloudflare_token": {"service": "Cloudflare", "kind": "key", "test": "cloudflare",
                         "purpose": "Cloudflare account key (Workers are deployed with the separate wrangler sign-in)",
                         "renew": "Kevin presses Roll on dash.cloudflare.com/profile/api-tokens, then pastes it into Replace a key"},
    "claude_oauth_token": {"service": "Claude", "kind": "key", "test": "", "expires": "mtime+365",
                           "purpose": "the robots' Claude sign-in: every robot run",
                           "renew": "Kevin runs claude setup-token once on the Mac mini (a sign-in), then pastes it into Replace a key"},
    "gemini_api_key": {"service": "Google Gemini", "kind": "key", "test": "gemini",
                       "purpose": "illustrations for the Content Engine",
                       "renew": "Kevin makes a new key on aistudio.google.com/apikey, then pastes it into Replace a key"},
    "ghl_api_key": {"service": "GoHighLevel", "kind": "key", "test": "",
                    "purpose": "the prospecting and reply-watch lookups", "renew": "a new key in GoHighLevel settings, pasted into Replace a key"},
    "ghl_social_key_od": {"service": "GoHighLevel", "kind": "key", "test": "",
                          "purpose": "Operations Director social posting", "renew": "a new key in GoHighLevel settings, pasted into Replace a key"},
    "ghl_social_key_runpreneur": {"service": "GoHighLevel", "kind": "key", "test": "",
                                  "purpose": "Runpreneur social posting", "renew": "a new key in GoHighLevel settings, pasted into Replace a key"},
    "gdrive_service_account.json": {"service": "Google Drive", "kind": "key", "test": "gdrive", "json": True,
                                    "purpose": "the Content Engine's Drive uploads",
                                    "renew": "a new key for the service account in the Google Cloud console, pasted into Replace a key"},
    "homeassistant_token": {"service": "Home Assistant", "kind": "key", "test": "homeassistant",
                            "purpose": "the home battery watch", "renew": "a new long-lived token in Home Assistant, pasted into Replace a key"},
    "pingen_client_secret": {"service": "Pingen", "kind": "key", "test": "pingen",
                             "purpose": "posting letters", "renew": "a new client secret in Pingen, pasted into Replace a key"},
    "stripe_runpreneur_key": {"service": "Stripe", "kind": "key", "test": "stripe",
                              "purpose": "Runpreneur donations for the map", "renew": "a new restricted key in Stripe, pasted into Replace a key"},
    "strava_client_secret": {"service": "Strava", "kind": "key", "test": "",
                             "purpose": "the Strava app's own secret", "renew": "only if Strava resets the app"},
    "ticketmaster_api_key": {"service": "Ticketmaster", "kind": "key", "test": "ticketmaster",
                             "purpose": "the UK gigs list", "renew": "a new key on developer.ticketmaster.com, pasted into Replace a key"},
    "youtube_oauth_client.json": {"service": "YouTube", "kind": "key", "test": "", "json": True,
                                  "purpose": "the YouTube app's own client (its sign-in is youtube_token.json)",
                                  "renew": "only if the Google Cloud client is reset"},
    "strava_access_token": {"service": "Strava", "kind": "renews", "test": "fresh:72",
                            "purpose": "Strava access, renewed by the nightly Runpreneur sync", "renew": "renews itself"},
    "strava_refresh_token": {"service": "Strava", "kind": "renews", "test": "",
                             "purpose": "Strava's renewal key, rewritten by the same sync", "renew": "renews itself"},
    "youtube_token.json": {"service": "YouTube", "kind": "renews", "test": "youtube", "json": True,
                           "purpose": "the YouTube sign-in for publishing", "renew": "renews itself; a new consent only if Google drops it"},
    # Keys we made, shared between the Mac and a Worker: they never expire, and --generate replaces them.
    "agent_runner_token": {"service": "agent-runner Worker", "kind": "shared", "test": "", "purpose": "the Mac and the agent-runner Worker"},
    "approvals_admin_key": {"service": "contractor-bot Worker", "kind": "shared", "test": "", "purpose": "the approvals admin pages"},
    "ceo_transcript_key": {"service": "contractor-bot Worker", "kind": "shared", "test": "", "purpose": "CEO transcripts"},
    "gmail_send_key": {"service": "drive-upload Worker", "kind": "shared", "test": "", "purpose": "sending email through the Worker"},
    "gmail_triage_key": {"service": "drive-upload Worker", "kind": "shared", "test": "", "purpose": "reading the inbox through the Worker"},
    "money_trigger_key": {"service": "a Worker", "kind": "shared", "test": "", "purpose": "the money trigger"},
    "pm_robot_key": {"service": "property-manager Worker", "kind": "shared", "test": "", "purpose": "the robots' door to Roy's page"},
    "property_manager_session_secret": {"service": "property-manager Worker", "kind": "shared", "test": "", "purpose": "signs Roy's page sessions"},
    "proxy_service_token2": {"service": "claude-proxy", "kind": "shared", "test": "", "purpose": "the Claude proxy"},
    "slack_relay_key": {"service": "apple-inbound Worker", "kind": "shared", "test": "", "purpose": "Slack messages through the relay"},
    "property_manager_passcode_kevin": {"service": "property-manager Worker", "kind": "passcode", "test": "", "purpose": "Kevin's passcode for Roy's page"},
    "property_manager_passcode_roy": {"service": "property-manager Worker", "kind": "passcode", "test": "", "purpose": "Roy's passcode for his page"},
}
IDS = ("ghl_location_id", "ghl_location_id_od", "ghl_location_id_runpreneur", "ghl_user_id_kevin",
       "pingen_client_id", "pingen_org_id", "strava_client_id")
SKIP_FILES = ("key-register.json",)

# A Worker or GitHub secret that is a copy of a Mac key file. Only names that MUST hold the same value
# (the Mac and the Worker check one against the other), or that are the same key by name. A copy
# whose Mac twin is not certain stays its own row: replacing it with the wrong value breaks a Worker.
COPY_OF = {
    "AIRTABLE_PAT": "airtable_pat", "GMAIL_SEND_KEY": "gmail_send_key", "GMAIL_TRIAGE_KEY": "gmail_triage_key",
    "SLACK_RELAY_KEY": "slack_relay_key", "PM_ROBOT_KEY": "pm_robot_key", "PM_SESSION_SECRET": "property_manager_session_secret",
    "APPROVALS_ADMIN_KEY": "approvals_admin_key", "CEO_TRANSCRIPT_KEY": "ceo_transcript_key",
    "AGENT_RUNNER_TOKEN": "agent_runner_token", "GHL_API_KEY": "ghl_api_key",
}
# Worker secrets that are not secrets at all (text, addresses, ids): listed as settings.
WORKER_SETTINGS = ("FROM_EMAIL", "RECIPIENT_EMAIL", "PERSONA_CONTEXT", "QUARTER_CONTEXT", "DRIVE_PARENT_FOLDER_ID",
                   "GHL_LOCATION_ID", "PM_KEVIN_AIRTABLE_ID", "GOOGLE_CLIENT_ID", "ALLOWED_ORIGIN")
WORKER_PASSCODES = ("PM_PASSCODE", "PM_PASSCODE_KEVIN")        # typed by people: never changed by a script


# ─── small helpers ────────────────────────────────────────────────────
def now_utc():
    return datetime.now(timezone.utc)


def iso(t):
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    try:
        t = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def write_private(path, text):
    """Write text so no other user can read it, ever (the temp file is 0600 before a byte goes in)."""
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)            # atomic: a reader sees the old value or the new, never half
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def read_value(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read().strip()


def load_register(path=REGISTER):
    try:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
    except FileNotFoundError:
        return {"version": 1, "keys": {}}
    if not isinstance(d.get("keys"), dict):
        raise SystemExit("ERROR: %s is not a register (no keys)" % path)
    return d


def save_register(reg, path=REGISTER):
    reg["updated"] = iso(now_utc())
    write_private(path, json.dumps(reg, indent=1, sort_keys=True) + "\n")


def worker_names(repo=REPO):
    """Every Worker this repo deploys: the top-level name in each wrangler.toml."""
    out = []
    for p in sorted(glob.glob(os.path.join(repo, "**", "wrangler.toml"), recursive=True)):
        if "/node_modules/" in p or "/.claude/worktrees/" in p[len(repo):]:
            continue
        with open(p, encoding="utf-8") as fh:
            for ln in fh:
                if ln.strip().startswith("["):
                    break
                m = re.match(r'\s*name\s*=\s*"([^"]+)"', ln)
                if m:
                    out.append(m.group(1))
                    break
    return sorted(set(out))


def readers_of(name, repo=REPO):
    """The files that read a key, found by its file name (never by its value)."""
    roots = [os.path.join(repo, d) for d in ("scripts", "workers", "js", "os", "cloudflare-worker")] + \
        [os.path.expanduser("~/tools")]
    try:
        out = subprocess.run(["grep", "-rlF", "--exclude-dir=node_modules", "--exclude-dir=tests", name] +
                             [r for r in roots if os.path.isdir(r)], capture_output=True, text=True, timeout=60).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    home = os.path.expanduser("~")
    return sorted({p.replace(repo + os.sep, "").replace(home, "~") for p in out.splitlines()
                   if not p.endswith("key-register.py")})


# ─── discovery: what the Workers and GitHub hold (names only) ─────────
def run_cmd(args, value=None, timeout=120):
    """A command whose only input is stdin. Its output is never printed whole: it can echo a value."""
    with tempfile.TemporaryDirectory() as d:     # outside any project, so wrangler reads no config
        return subprocess.run(args, input=value, capture_output=True, text=True, timeout=timeout, cwd=d)


def _cf_token():
    try:
        return read_value(os.path.join(CONFIG_DIR, "cloudflare_token"))
    except OSError:
        return ""


def list_worker_secrets(worker):
    """Names only. Cloudflare's API with the Mac's own key answers in a second; wrangler (about 15
    seconds a Worker) is the fallback when that key cannot be read or is refused."""
    tok = _cf_token()
    if tok and not os.environ.get("KEY_REGISTER_WRANGLER"):
        s, _, b = _http(CF_API % urllib.parse.quote(worker), {"Authorization": "Bearer " + tok})
        if s == 200 and isinstance((b or {}).get("result"), list):
            return sorted(x.get("name") for x in b["result"] if x.get("name")), None
    r = run_cmd(WRANGLER + ["secret", "list", "--name", worker])
    if r.returncode != 0:
        return None, (r.stderr.strip().splitlines() or ["exit %d" % r.returncode])[-1][:160]
    t = r.stdout
    i = t.find("[")
    try:
        return sorted(x["name"] for x in json.loads(t[i:])), None
    except (ValueError, KeyError, TypeError):
        return None, "the listing could not be read"


def list_github_secrets():
    r = run_cmd(GH + ["secret", "list", "--repo", GITHUB_REPO, "--json", "name"])
    if r.returncode != 0:
        return None, (r.stderr.strip().splitlines() or ["exit %d" % r.returncode])[-1][:160]
    try:
        return sorted(x["name"] for x in json.loads(r.stdout)), None
    except (ValueError, KeyError, TypeError):
        return None, "the listing could not be read"


def discover():
    """{"workers": {worker: [secret names]}, "github": [names] or None, "errors": [...]}."""
    out = {"workers": {}, "github": None, "errors": []}
    for w in worker_names():
        names, err = list_worker_secrets(w)
        if err:
            out["errors"].append("Worker %s: %s" % (w, err))
        else:
            out["workers"][w] = names
    names, err = list_github_secrets()
    if err:
        out["errors"].append("GitHub: %s" % err)
    else:
        out["github"] = names
    return out


def copy_rows(found):
    """(copies by Mac key file, rows for Worker-only secrets) from what discover() found."""
    copies, own = {}, {}
    places = [("worker", w, n) for w, ns in found["workers"].items() for n in ns] + \
        [("github", "", n) for n in (found["github"] or [])]
    for where, worker, secret in places:
        c = {"where": where, "secret": secret}
        if worker:
            c["worker"] = worker
        if secret in COPY_OF:
            copies.setdefault(COPY_OF[secret], []).append(c)
            continue
        key = "%s:%s" % ("worker" if where == "worker" else "github", secret)
        row = own.setdefault(key, {"service": "Cloudflare Workers" if where == "worker" else "GitHub",
                                   "kind": "setting" if secret in WORKER_SETTINGS else
                                   "passcode" if secret in WORKER_PASSCODES else "worker-only",
                                   "test": "", "file": None, "copies": [],
                                   "purpose": "held only in %s, never on the Mac" % ("Cloudflare" if where == "worker" else "GitHub"),
                                   "renew": "Kevin makes a new one at the service, then pastes it into Replace a key"})
        row["copies"].append(c)
    return copies, own


# ─── seed: build or refresh the register ──────────────────────────────
def describe(name):
    if name in CATALOGUE:
        return dict(CATALOGUE[name])
    if name in IDS:
        return {"service": "", "kind": "id", "test": "", "purpose": "an identifier, not a secret"}
    if name.endswith((".json", ".txt")) or name.startswith(("content_engine_", "text-sending")):
        return {"service": "", "kind": "setting", "test": "", "purpose": "a setting file, not a key"}
    return {"service": "", "kind": "unknown", "test": "", "purpose": "nobody has described this file yet"}


def key_files(config_dir=CONFIG_DIR):
    return sorted(n for n in os.listdir(config_dir)
                  if os.path.isfile(os.path.join(config_dir, n)) and not n.startswith(".") and n not in SKIP_FILES)


def seed(found=None, config_dir=CONFIG_DIR, reg_path=REGISTER, with_readers=True):
    """Additive: a row's own notes, end date and anything written by hand survive; facts are refreshed."""
    reg = load_register(reg_path)
    keys = reg["keys"]
    for name in key_files(config_dir):
        row = keys.setdefault(name, {})
        d = describe(name)
        # The catalogue in this file describes a key. A file it does not know keeps whatever was
        # written on its row by hand, so describing it in the register sticks.
        if d["kind"] != "unknown" or row.get("kind") in (None, "unknown"):
            row.update(d)
        row["file"] = name
        row.pop("missingSince", None)
        if with_readers:
            r = readers_of(name)
            if r is not None:
                row["readers"] = r
    added = []
    if found is not None:
        copies, own = copy_rows(found)
        for name, cs in copies.items():
            if name in keys:
                keys[name]["copies"] = cs
        for key, row in own.items():
            if key not in keys:
                added.append(key)
            keys[key] = dict(keys.get(key, {}), **row)
        reg["discoveredAt"] = iso(now_utc())
        reg["discoveryErrors"] = found["errors"]
    gone = [n for n, r in keys.items() if r.get("file") and not os.path.exists(os.path.join(config_dir, r["file"]))
            and r.get("kind") not in ("id", "setting")]
    for n in gone:
        keys[n]["missingSince"] = keys[n].get("missingSince") or iso(now_utc())
    save_register(reg, reg_path)
    return {"keys": len(keys), "added": added, "missing": gone}


# ─── the tests: one harmless read per service, the value never shown ──
def _http(url, headers=None, data=None, method=None):
    """(status, headers) for one request; (None, why) when the service could not be reached."""
    req = urllib.request.Request(url, data=data, headers=dict(headers or {}, **{"User-Agent": "od-key-register"}),
                                 method=method)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            return r.status, dict(r.headers), json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), {}
    except (urllib.error.URLError, OSError, ValueError) as e:
        return None, {}, {"error": str(getattr(e, "reason", e))[:120]}


def _ok(status, body=None, expires=None):
    if status is None:
        return {"result": "unreachable", "said": "could not reach the service (%s)" % (body or {}).get("error", "no answer")}
    if 200 <= status < 300:
        out = {"result": "ok", "said": "works"}
        if expires:
            out["expires"] = expires
        return out
    if status in (401, 403):
        return {"result": "rejected", "said": "the service refused it (HTTP %d)" % status}
    return {"result": "unreachable", "said": "the service answered HTTP %d, so it could not be judged" % status}


def t_airtable(v, row):
    s, _, b = _http("https://api.airtable.com/v0/meta/whoami", {"Authorization": "Bearer " + v})
    return _ok(s, b)


def t_github(v, row):
    s, h, b = _http("https://api.github.com/user", {"Authorization": "Bearer " + v, "Accept": "application/vnd.github+json"})
    exp = next((h[k] for k in h if k.lower() == "github-authentication-token-expiration"), None)
    if exp:
        t = None
        for fmt in ("%Y-%m-%d %H:%M:%S %Z", "%Y-%m-%d %H:%M:%S %z"):
            try:
                t = datetime.strptime(exp.strip(), fmt).replace(tzinfo=timezone.utc)
                break
            except ValueError:
                continue
        exp = iso(t) if t else None
    return _ok(s, b, exp)


def t_cloudflare(v, row):
    s, _, b = _http("https://api.cloudflare.com/client/v4/user/tokens/verify", {"Authorization": "Bearer " + v})
    res = (b or {}).get("result") or {}
    if s == 200 and res.get("status") != "active":
        return {"result": "rejected", "said": "Cloudflare says the key is %s" % (res.get("status") or "not active")}
    return _ok(s, b, res.get("expires_on") or None)


def t_gemini(v, row):
    s, _, b = _http("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {"x-goog-api-key": v})
    return _ok(s, b)


def t_homeassistant(v, row):
    s, _, b = _http("http://homeassistant.local/api/", {"Authorization": "Bearer " + v})
    return _ok(s, b)


def t_stripe(v, row):
    s, _, b = _http("https://api.stripe.com/v1/charges?limit=1", {"Authorization": "Bearer " + v})
    return _ok(s, b)


def t_ticketmaster(v, row):
    s, _, b = _http("https://app.ticketmaster.com/discovery/v2/events.json?size=1&" + urllib.parse.urlencode({"apikey": v}))
    return _ok(s, b)


def t_pingen(v, row):
    try:
        cid = read_value(os.path.join(CONFIG_DIR, "pingen_client_id"))
    except OSError:
        return {"result": "unreachable", "said": "the Pingen client id file could not be read"}
    data = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": cid, "client_secret": v}).encode()
    s, _, b = _http("https://identity.pingen.com/auth/access-tokens", {"Content-Type": "application/x-www-form-urlencoded"}, data, "POST")
    return _ok(s, b)


def _google_token(token_uri, data):
    s, _, b = _http(token_uri, {"Content-Type": "application/x-www-form-urlencoded"}, urllib.parse.urlencode(data).encode(), "POST")
    if s == 400 and (b or {}).get("error") in ("invalid_grant", "invalid_client"):
        s = 401
    return _ok(s, b)


def t_youtube(v, row):
    """Asks Google for a fresh access token from the stored renewal token: it changes nothing."""
    try:
        rt = json.loads(v)["refresh_token"]
        with open(os.path.join(CONFIG_DIR, "youtube_oauth_client.json"), encoding="utf-8") as fh:
            c = json.load(fh)
        c = c.get("installed") or c.get("web") or c
    except (OSError, ValueError, KeyError, TypeError):
        return {"result": "rejected", "said": "the sign-in file or its app client could not be read"}
    return _google_token("https://oauth2.googleapis.com/token", {"refresh_token": rt, "client_id": c.get("client_id", ""),
                                                                 "client_secret": c.get("client_secret", ""), "grant_type": "refresh_token"})


def t_gdrive(v, row):
    """Signs a one-hour token request with the service account (openssl, as drive_api.py does)."""
    import base64
    try:
        sa = json.loads(v)
        b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=")
        now = int(time.time())
        head = b64(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
        claims = b64(json.dumps({"iss": sa["client_email"], "scope": "https://www.googleapis.com/auth/drive.metadata.readonly",
                                 "aud": sa["token_uri"], "iat": now, "exp": now + 600}, separators=(",", ":")).encode())
        signing = head + b"." + claims
        fd, kp = tempfile.mkstemp(prefix=".kr-", dir=CONFIG_DIR)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write(sa["private_key"])
            sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", kp], input=signing, capture_output=True,
                                 check=True, timeout=30).stdout
        finally:
            os.remove(kp)
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        return {"result": "rejected", "said": "the service account file could not be used to sign a request"}
    return _google_token(sa["token_uri"], {"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                           "assertion": (signing + b"." + b64(sig)).decode()})


TESTS = {"airtable": t_airtable, "github": t_github, "cloudflare": t_cloudflare, "gemini": t_gemini,
         "homeassistant": t_homeassistant, "stripe": t_stripe, "ticketmaster": t_ticketmaster, "pingen": t_pingen,
         "youtube": t_youtube, "gdrive": t_gdrive}


def test_value(row, value):
    """The row's test against a value, or None when the key has no safe test here."""
    name = row.get("test") or ""
    if name in TESTS:
        try:
            return TESTS[name](value, row)
        except Exception as exc:  # noqa: BLE001 — a test that breaks says so, never passes
            return {"result": "unreachable", "said": "the test itself failed (%s)" % type(exc).__name__}
    return None


# ─── check ────────────────────────────────────────────────────────────
def judge_row(name, row, now, config_dir=CONFIG_DIR):
    """{name, kind, status, said, ...} for one row. status: green, amber, red, or grey ("not tested")."""
    out = {"name": name, "kind": row.get("kind"), "service": row.get("service", ""), "copies": len(row.get("copies") or [])}
    kind = row.get("kind")
    if kind in ("id", "setting"):
        out.update(status="none", said="not a key")
        return out
    if kind == "unknown":
        out.update(status="amber", said="nobody has described this file: say what it is in the key register")
        return out
    path = os.path.join(config_dir, row["file"]) if row.get("file") else None
    notes = []
    if path:
        try:
            st = os.stat(path)
        except FileNotFoundError:
            out.update(status="red", said="the key file is missing")
            return out
        out["changed"] = iso(datetime.fromtimestamp(st.st_mtime, timezone.utc))
        if stat.S_IMODE(st.st_mode) & 0o077:
            os.chmod(path, 0o600)
            notes.append("other users could read it: tightened to owner-only")
    status, said = "grey", "not tested here"
    if kind == "shared":
        said = "a key we made, shared with a Worker: it never runs out and is not tested here"
    elif kind == "passcode":
        said = "a passcode people type: never changed by a script"
    elif kind == "worker-only":
        said = "held only in %s: not tested here" % row.get("service", "a Worker")
    test = row.get("test") or ""
    if test.startswith("fresh:") and path:
        hours = int(test.split(":", 1)[1])
        age = (now - parse_iso(out["changed"])).total_seconds() / 3600
        status, said = ("green", "renewed itself %d hours ago" % age) if age <= hours else \
            ("red", "has not renewed itself for %d hours (it should every %d)" % (age, hours))
    elif test and path:
        try:
            value = read_value(path)
        except OSError:
            value = ""
        res = test_value(row, value) if value else {"result": "rejected", "said": "the key file is empty"}
        out["test"] = res["result"]
        if res["result"] == "ok":
            status, said = "green", "works"
            if res.get("expires"):
                row["expires"] = res["expires"]
        elif res["result"] == "rejected":
            status, said = "red", res["said"]
        else:
            status, said = "grey", "could not test: " + res["said"]
    exp = row.get("expires")
    if exp == "mtime+365" and out.get("changed"):
        exp = iso(parse_iso(out["changed"]) + timedelta(days=CLAUDE_TOKEN_DAYS))
    t = parse_iso(exp) if exp else None
    if t:
        out["expires"] = iso(t)
        days = (t - now).total_seconds() / 86400
        if days <= 0:
            status, said = "red", "ran out on %s" % t.strftime("%d %b %Y")
        elif days <= EXPIRY_RED_DAYS:
            status, said = "red", "runs out in %d days (%s): renew it now" % (days, t.strftime("%d %b %Y"))
        elif days <= EXPIRY_AMBER_DAYS and status != "red":
            status, said = "amber", "runs out in %d days (%s)" % (days, t.strftime("%d %b %Y"))
    if notes:
        said += "; " + "; ".join(notes)
        if status == "green":
            status = "amber"
    out.update(status=status, said=said)
    return out


def sweep_incoming(now, incoming=INCOMING):
    """A pasted key the replace step never collected: deleted, and named (never its value)."""
    left = []
    for p in glob.glob(os.path.join(incoming, "*")):
        try:
            age = (now.timestamp() - os.stat(p).st_mtime) / 60
        except OSError:
            continue
        if age > INCOMING_MAX_MINUTES:
            os.remove(p)
            left.append(os.path.basename(p))
    return left


def check(now=None, found=None, config_dir=CONFIG_DIR, reg_path=REGISTER, save_path=LAST_CHECK, incoming=INCOMING):
    """Test every key, save the result (names, statuses and dates only) and return it."""
    now = now or now_utc()
    seeded = seed(found, config_dir, reg_path, with_readers=False)
    reg = load_register(reg_path)
    rows = [judge_row(n, r, now, config_dir) for n, r in sorted(reg["keys"].items())]
    save_register(reg, reg_path)                  # an end date a test read is kept on the row
    left = sweep_incoming(now, incoming)
    if left:
        rows.append({"name": "pasted key", "kind": "incoming", "status": "red",
                     "said": "a pasted key was left behind and has been deleted (%s): paste it again" % ", ".join(left)})
    counts = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    res = {"checkedAt": iso(now), "rows": rows, "counts": counts, "added": seeded["added"],
           "discoveredAt": iso(now) if found is not None else reg.get("discoveredAt"),
           "discoveryErrors": found["errors"] if found is not None else reg.get("discoveryErrors")}
    if save_path:
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        write_private(save_path, json.dumps(res, indent=1))
    return res


def summary_detail(res):
    """One sentence for the Estate tab."""
    rows = [r for r in res["rows"] if r["status"] != "none"]
    bad = [r for r in rows if r["status"] == "red"]
    warn = [r for r in rows if r["status"] == "amber"]
    green = [r for r in rows if r["status"] == "green"]
    grey = [r for r in rows if r["status"] == "grey"]
    parts = ["%d keys: %d tested and working" % (len(rows), len(green))]
    if bad:
        parts.append("%d need fixing (%s)" % (len(bad), "; ".join("%s: %s" % (r["name"], r["said"]) for r in bad[:4])))
    if warn:
        parts.append("%d to watch (%s)" % (len(warn), "; ".join("%s: %s" % (r["name"], r["said"]) for r in warn[:4])))
    parts.append("%d not tested here" % len(grey))
    if res.get("discoveryErrors"):
        parts.append("the copies could not all be listed (%s)" % "; ".join(res["discoveryErrors"][:2]))
    return ", ".join(parts) + "."


def needs_check(now, last=LAST_CHECK, config_dir=CONFIG_DIR, reg_path=REGISTER):
    """True when the saved check is a day old, or a key file or the register changed after it."""
    try:
        saved = json.load(open(last, encoding="utf-8"))
        t = parse_iso(saved.get("checkedAt"))
    except (OSError, ValueError):
        return True, None
    if not t or now - t > timedelta(hours=CHECK_EVERY_HOURS):
        return True, saved
    keys = load_register(reg_path)["keys"]
    watched = [n for n in key_files(config_dir) if (keys.get(n) or {}).get("kind", "unknown") not in ("id", "setting")]
    newest = max([os.stat(os.path.join(config_dir, n)).st_mtime for n in watched] + [0])
    return newest > t.timestamp() + 5, saved


def status_row(now):
    """The Estate Status row, for scripts/estate-status.py. Re-checks once a day (with the Workers
    and GitHub listed) or as soon as a key file changes (without), otherwise reads the saved check."""
    stamp = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    row = {"key": STATUS_KEY, "kind": "report", "label": "Robot keys", "lastRun": stamp}
    try:
        due, saved = needs_check(now)
        if due:
            # The Workers and GitHub are listed once a day (about a minute); a key file that
            # changed in between is re-tested at once, without the listing.
            listed = parse_iso((saved or {}).get("discoveredAt"))
            daily = not listed or now - listed > timedelta(hours=CHECK_EVERY_HOURS)
            res = check(now, discover() if daily else None)
        else:
            res = saved
    except Exception as exc:  # noqa: BLE001 — the row says why, never an empty all-clear
        return dict(row, status="Failed", detail="The key check could not run: %s: %s" % (type(exc).__name__, str(exc)[:200]))
    red = [r for r in res["rows"] if r["status"] == "red"]
    return dict(row, status="Failed" if red else "Worked", detail=summary_detail(res),
                payload=json.dumps({"checkedAt": res["checkedAt"], "counts": res["counts"],
                                    "rows": [r for r in res["rows"] if r["status"] != "none"]}),
                **({} if red else {"lastWorked": stamp}))


# ─── replace ──────────────────────────────────────────────────────────
VALUE_OK = re.compile(r"^\S{16,}$")


def take_value(args):
    """The new value from exactly one source, a file that is deleted at once, or stdin. Never argv."""
    if args.get("generate"):
        return secrets.token_urlsafe(32)
    if args.get("from_file"):
        p = args["from_file"]
        try:
            with open(p, encoding="utf-8") as fh:
                return fh.read()
        finally:
            if os.path.exists(p):
                os.remove(p)             # read once, then gone, whatever happens next
    if args.get("stdin"):
        return sys.stdin.read()
    raise SystemExit("ERROR: say where the new value is: --from-file PATH, --stdin or --generate")


def push_copy(c, value):
    """(ok, said) for one copy. The value goes in on stdin and nothing it prints is shown."""
    if c.get("where") == "worker":
        place = "Worker %s (%s)" % (c["worker"], c["secret"])
        tok = _cf_token()
        if tok and not os.environ.get("KEY_REGISTER_WRANGLER"):
            body = json.dumps({"name": c["secret"], "text": value, "type": "secret_text"}).encode()
            s, _, _ = _http(CF_API % urllib.parse.quote(c["worker"]), {"Authorization": "Bearer " + tok,
                                                                       "Content-Type": "application/json"}, body, "PUT")
            if s == 200:
                return True, place
        r = run_cmd(WRANGLER + ["secret", "put", c["secret"], "--name", c["worker"]], value=value)
    elif c.get("where") == "github":
        r = run_cmd(GH + ["secret", "set", c["secret"], "--repo", GITHUB_REPO], value=value)
        place = "GitHub (%s)" % c["secret"]
    else:
        return False, "%s: cannot be reached by a script, change it by hand" % c.get("where", "a copy")
    if r.returncode != 0:
        return False, "%s: refused (exit %d)" % (place, r.returncode)
    return True, place


def replace(name, args, reg_path=REGISTER, config_dir=CONFIG_DIR, log_path=REPLACE_LOG):
    """(exit code, what to say). 0 done; 2 refused before anything changed; 3 the new value failed
    its test, nothing changed; 4 written but at least one copy did not take it (named)."""
    said = []
    print = said.append                           # noqa: A001 — every line comes back to the caller
    rc = _replace(name, args, reg_path, config_dir, log_path, print)
    return rc, said


def _replace(name, args, reg_path, config_dir, log_path, print):
    reg = load_register(reg_path)
    row = reg["keys"].get(name)
    value = take_value(args)                      # always taken first, so a pasted file never lingers
    if not row:
        print("REFUSED: %s is not in the key register. Run seed first." % name)
        return 2
    if row.get("kind") in ("id", "setting", "passcode", "unknown"):
        print("REFUSED: %s is %s, not a key a script may change." % (name, {"passcode": "a passcode people type"}.get(row["kind"], "not a key")))
        return 2
    if args.get("generate") and row.get("kind") != "shared":
        print("REFUSED: only a key we made ourselves (shared with a Worker) may be generated here.")
        return 2
    value = value.strip()
    if row.get("json"):
        try:
            json.loads(value)
        except ValueError:
            print("REFUSED: the pasted text is not the JSON file this key is. Nothing changed.")
            return 2
    elif not VALUE_OK.match(value):
        print("REFUSED: the pasted text is empty, too short or has spaces in it. Nothing changed.")
        return 2
    res = test_value(row, value)
    if res is not None and res["result"] != "ok":
        print("REFUSED: the new key did not work (%s). Nothing was changed: the old key is still in place." % res["said"])
        return 3
    done, failed = [], []
    if row.get("file"):
        write_private(os.path.join(config_dir, row["file"]), value + "\n")
        done.append("the key file on the Mac mini")
    for c in row.get("copies") or []:
        ok, said = push_copy(c, value)
        (done if ok else failed).append(said)
    after = None
    if row.get("file") and res is not None:
        after = test_value(row, read_value(os.path.join(config_dir, row["file"])))
        if after and after["result"] != "ok":
            failed.append("the key file did not pass its test again (%s)" % after["said"])
    stamp = iso(now_utc())
    row["changed"], row["replacedAt"] = stamp, stamp
    row["lastReplace"] = {"at": stamp, "tested": res["result"] if res else "not tested here", "reached": done, "failed": failed}
    save_register(reg, reg_path)
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"at": stamp, "key": name, "tested": row["lastReplace"]["tested"],
                             "reached": done, "failed": failed}) + "\n")
    print("%s: %s." % (name, "the new key works" if res else "the new value is in place (no safe test for this key)"))
    print("Reached %d place%s: %s." % (len(done), "" if len(done) == 1 else "s", "; ".join(done) or "none"))
    if failed:
        print("NOT REACHED (%d): %s." % (len(failed), "; ".join(failed)))
        return 4
    return 0


# ─── report, names ────────────────────────────────────────────────────
def report():
    reg = load_register()
    try:
        last = json.load(open(LAST_CHECK, encoding="utf-8"))
    except (OSError, ValueError):
        last = None
    by = {r["name"]: r for r in (last or {}).get("rows", [])}
    print("Key register: %d rows, updated %s. Last check: %s." % (len(reg["keys"]), reg.get("updated", "never"),
                                                                 (last or {}).get("checkedAt", "never")))
    for name, row in sorted(reg["keys"].items(), key=lambda kv: (KINDS.index(kv[1].get("kind", "unknown")) if kv[1].get("kind") in KINDS else 9, kv[0])):
        if row.get("kind") in ("id", "setting"):
            continue
        j = by.get(name, {})
        where = ", ".join(c.get("worker") or c.get("where", "") for c in row.get("copies") or [])
        print("%-34s %-11s %-6s %s%s" % (name[:34], row.get("kind", ""), j.get("status", "-"),
                                         j.get("said", "not checked yet"), (" | copies: " + where) if where else ""))
    return 0


def names():
    reg = load_register()
    for name, row in sorted(reg["keys"].items()):
        if row.get("kind") in ("key", "renews", "shared", "worker-only"):
            print("%s\t%s" % (name, (row.get("service") or "") + (": " + row["purpose"] if row.get("purpose") else "")))
    return 0


def selftest():
    checks = 0
    assert describe("airtable_pat")["test"] == "airtable"; checks += 1
    assert describe("new_mystery_key")["kind"] == "unknown"; checks += 1
    assert describe("ghl_location_id")["kind"] == "id"; checks += 1
    assert _ok(None, {"error": "x"})["result"] == "unreachable"; checks += 1
    assert _ok(401)["result"] == "rejected" and _ok(500)["result"] == "unreachable"; checks += 1
    assert not VALUE_OK.match("short") and not VALUE_OK.match("has a space in it 1234567890"); checks += 1
    copies, own = copy_rows({"workers": {"w1": ["AIRTABLE_PAT", "ANTHROPIC_API_KEY", "FROM_EMAIL"]}, "github": ["AIRTABLE_PAT"], "errors": []})
    assert len(copies["airtable_pat"]) == 2 and own["worker:ANTHROPIC_API_KEY"]["kind"] == "worker-only"; checks += 1
    assert own["worker:FROM_EMAIL"]["kind"] == "setting"; checks += 1
    return {"checks": checks, "failed": []}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = argv[0] if argv else ""
    if cmd == "seed":
        found = discover()
        res = seed(found)
        print("Key register: %d rows. New copies found: %s. Key files gone: %s.%s" % (
            res["keys"], ", ".join(res["added"]) or "none", ", ".join(res["missing"]) or "none",
            (" Could not list: %s." % "; ".join(found["errors"])) if found["errors"] else ""))
        return 1 if found["errors"] else 0
    if cmd == "check":
        res = check(found=discover() if "--discover" in argv else None)
        if "--json" in argv:
            print(json.dumps(res, indent=1))
        else:
            print(summary_detail(res))
        return 1 if res["counts"].get("red") else 0
    if cmd == "report":
        return report()
    if cmd == "names":
        return names()
    if cmd == "replace":
        if len(argv) < 2 or argv[1].startswith("--"):
            raise SystemExit("usage: key-register.py replace NAME (--from-file PATH | --stdin | --generate)")
        a = {"generate": "--generate" in argv, "stdin": "--stdin" in argv,
             "from_file": argv[argv.index("--from-file") + 1] if "--from-file" in argv[:-1] else None}
        rc, said = replace(argv[1], a)
        sys.stdout.write("\n".join(said) + "\n") if rc == 0 else sys.stderr.write("\n".join(said) + "\n")
        return rc
    if cmd == "selftest":
        out = selftest()
        print(json.dumps(out))
        return 1 if out["failed"] else 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
