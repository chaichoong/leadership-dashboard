#!/usr/bin/env python3
"""Kevin's weekly FPL Draft swap card (approved build recQZZjNELK1x3cAc, 26 Nov 2026).

PHASE 1 IS PREPARE-ONLY. This script reads, scores and RECOMMENDS. It never signs a
player, never saves a team and never touches Kevin's league. Making the swaps in Chrome
is phase 2 and has its own card.

What it does, once waivers are processed and the next deadline is inside 36 hours:
  * reads Kevin's live squad (draft entry 96186, league 18988) and the free agents,
  * applies his five confirmed rules (brain Decisions/2026-11-20 FPL Draft swap rules),
  * puts ONE card in his approval queue: swap X for Y, put Z in goal, with the numbers.

Every read is fetched live at run time. Nothing is cached, nothing comes from a memory
file, and the card prints the time each source was read.

NO SILENT ZEROS (CLAUDE.md: "a reply with no records key is an error, not an empty
population"). Any read that fails, returns a non-JSON body, returns "No pick history"
or is missing the key it needs ends the run as NOT CHECKED, exit 2, and raises no card.
A "no swaps" card is only ever raised when every read succeeded.

Subcommands:
  plan      print the plan and every figure behind it. Writes nothing.
  card      the same gate, then raise the approval card. Quiet on a quiet hour.
  selftest  run the recorded fixtures in tests/fixtures/fpl/ and print the verdicts.

Reads can be served from a recorded directory with --fixtures <dir> (or FPL_FIXTURES),
which is how the tests run with no network.
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    LONDON = ZoneInfo("Europe/London")
except Exception:                                     # pragma: no cover - stdlib always has it
    LONDON = None

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── Kevin's league, confirmed in memory reference_fpl_draft_league_2026.md ──
LEAGUE_ID = 18988
ENTRY_ID = 96186

DRAFT = "https://draft.premierleague.com/api"
FANTASY = "https://fantasy.premierleague.com/api"
UA = "od-fpl-draft-swaps/1.0 (+automation)"

# ── The five rules (brain Decisions/2026-11-20 FPL Draft swap rules) ──
# Rule 1: weekly score = points per game x fixture difficulty x fitness x form.
DIFFICULTY_FACTOR = {1: 1.3, 2: 1.2, 3: 1.0, 4: 0.85, 5: 0.7}
FORM_CLAMP = 0.10
# Rule 3: never drop a draft A-grade on one bad week.
A_GRADE = ("Isak", "Palmer", "Gibbs-White")
# Rule 4: ignore free agents under 300 minutes this season.
MIN_MINUTES = 300
# Status codes that mean the player cannot play: injured, suspended, unavailable, not in the league.
OUT_STATUSES = frozenset("isun")
HORIZON = 5                                            # rule 2's "next five gameweeks"
DEADLINE_WINDOW_HOURS = 36                             # how close the deadline must be to raise a card

POSITION_NAME = {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}

# Tasks field ids, exactly as scripts/session-keepalive.py reads them.
F = {
    "name": "fldgFjGBw6bTKJFCD", "status": "fldx4qCw17UfrKpaN", "dueDate": "fld7XP8w8kbxfETV4",
    "teamMember": "flduCtmQGpOA4eWaj", "sentForApprovalBy": "fld30Yw8SWYVp049g",
    "agentOutput": "fldzswp8fx6PqpLQ5", "taskType": "fldZ2moDV2041Sobc", "notes": "fldR7apBzSp3oxFxz",
    "description": "fldRGhBQViKZKtkQ6",
}
TASK_MANAGER = "rec1hYELb4zS8pjjO"      # Team Members row of the Operations Manager agent (read live 27 Nov 2026)


class FplReadError(RuntimeError):
    """A read that could not happen. Never swallowed, never turned into a zero."""


def now_london():
    return datetime.now(LONDON) if LONDON else datetime.now(timezone.utc)


# ──────────────────────────── reads ────────────────────────────

class Reader:
    """Live HTTP, or a recorded directory when --fixtures is given."""

    def __init__(self, fixtures=None):
        self.fixtures = fixtures
        self.read_at = {}                              # source label -> time it was read

    def _record(self, label):
        self.read_at[label] = now_london().strftime("%H:%M:%S")

    def _from_file(self, label, filename):
        path = os.path.join(self.fixtures, filename)
        if not os.path.exists(path):
            raise FplReadError("%s: no recorded fixture at %s" % (label, path))
        with open(path, "r", encoding="utf-8") as fh:
            body = fh.read()
        self._record(label)
        return self._decode(label, body)

    @staticmethod
    def _decode(label, body):
        try:
            return json.loads(body)
        except ValueError as exc:
            raise FplReadError("%s: body was not JSON (%s)" % (label, exc))

    def get(self, label, url, filename):
        if self.fixtures:
            return self._from_file(label, filename)
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:   # follows the 301 the fantasy site sends
                if resp.status != 200:
                    raise FplReadError("%s: HTTP %s from %s" % (label, resp.status, url))
                body = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            raise FplReadError("%s: HTTP %s from %s" % (label, exc.code, url))
        except urllib.error.URLError as exc:
            raise FplReadError("%s: could not reach %s (%s)" % (label, url, exc.reason))
        self._record(label)
        return self._decode(label, body)


def need(obj, key, label):
    """A missing key is a failed read, not an empty population."""
    if not isinstance(obj, dict) or key not in obj:
        raise FplReadError("%s: reply has no '%s' key" % (label, key))
    return obj[key]


def read_game(reader):
    got = reader.get("draft game", DRAFT + "/game", "game.json")
    need(got, "waivers_processed", "draft game")
    need(got, "current_event", "draft game")
    return got


def read_bootstrap(reader):
    got = reader.get("draft bootstrap", DRAFT + "/bootstrap-static", "bootstrap.json")
    for key in ("elements", "teams", "events"):
        need(got, key, "draft bootstrap")
    need(got["events"], "data", "draft bootstrap events")
    return got


def read_fixtures(reader, gw):
    label = "fantasy fixtures GW%d" % gw
    got = reader.get(label, "%s/fixtures/?event=%d" % (FANTASY, gw), "fixtures-%d.json" % gw)
    if not isinstance(got, list):
        raise FplReadError("%s: expected a list of fixtures, got %s" % (label, type(got).__name__))
    for fix in got:
        for key in ("team_h", "team_a", "team_h_difficulty", "team_a_difficulty"):
            need(fix, key, label)
    return got


def read_picks(reader, gw):
    label = "entry %d picks GW%d" % (ENTRY_ID, gw)
    got = reader.get(label, "%s/entry/%d/event/%d" % (DRAFT, ENTRY_ID, gw), "picks-%d.json" % gw)
    if isinstance(got, str):
        # "No pick history" is the draft site's answer for a gameweek not yet played. It is a
        # string, not a list, and treating it as an empty squad would read as "sell everything".
        raise FplReadError("%s: site answered %r, not a squad" % (label, got))
    picks = need(got, "picks", label)
    if not isinstance(picks, list) or not picks:
        raise FplReadError("%s: 'picks' is not a non-empty list" % label)
    return picks


def read_status(reader):
    label = "league %d element-status" % LEAGUE_ID
    got = reader.get(label, "%s/league/%d/element-status" % (DRAFT, LEAGUE_ID), "element-status.json")
    rows = need(got, "element_status", label)
    if not isinstance(rows, list) or not rows:
        raise FplReadError("%s: 'element_status' is not a non-empty list" % label)
    return rows


# ──────────────────────────── the gameweek calendar ────────────────────────────

def parse_utc(stamp):
    if not stamp:
        return None
    try:
        return datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        try:
            return datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        except ValueError:
            return None


def events_by_gw(bootstrap):
    out = {}
    for ev in bootstrap["events"]["data"]:
        if isinstance(ev, dict) and ev.get("id") is not None:
            out[int(ev["id"])] = ev
    if not out:
        raise FplReadError("draft bootstrap events: no gameweeks with an id")
    return out


def next_deadline(bootstrap, when=None):
    """The first gameweek whose deadline is still ahead. (gw, deadline in UTC)."""
    when = when or datetime.now(timezone.utc)
    ahead = []
    for gw, ev in events_by_gw(bootstrap).items():
        dl = parse_utc(ev.get("deadline_time"))
        if dl and dl > when:
            ahead.append((dl, gw))
    if not ahead:
        raise FplReadError("draft bootstrap events: no gameweek deadline is still ahead")
    dl, gw = min(ahead)
    return gw, dl


# ──────────────────────────── scoring ────────────────────────────

def team_map(bootstrap, fantasy_fixtures, draft_fixtures):
    """Prove the two sites' team ids mean the same clubs before using one site's difficulty
    against the other's players. The control: the set of fixtures the draft site lists for a
    gameweek must match the set the fantasy site lists for it. A silent id shift would move
    every difficulty figure one club sideways and never raise an error."""
    draft_pairs = {(int(f["team_h"]), int(f["team_a"])) for f in draft_fixtures
                   if f.get("team_h") and f.get("team_a")}
    fantasy_pairs = {(int(f["team_h"]), int(f["team_a"])) for f in fantasy_fixtures}
    if draft_pairs and draft_pairs != fantasy_pairs:
        raise FplReadError("team ids do not line up between the draft and fantasy sites: "
                           "%d fixtures matched of %d" % (len(draft_pairs & fantasy_pairs), len(draft_pairs)))
    return {int(t["id"]): t.get("short_name", "?") for t in bootstrap["teams"]}


def difficulty_factors(team_id, fixtures):
    """Every fixture that team has this gameweek, as a factor. A blank gameweek gives []."""
    out = []
    for fix in fixtures:
        if int(fix["team_h"]) == team_id:
            out.append(DIFFICULTY_FACTOR.get(int(fix["team_h_difficulty"]), 1.0))
        elif int(fix["team_a"]) == team_id:
            out.append(DIFFICULTY_FACTOR.get(int(fix["team_a_difficulty"]), 1.0))
    return out


def ppg(player):
    try:
        return float(player.get("points_per_game") or 0)
    except (TypeError, ValueError):
        return 0.0


def fitness(player):
    """Rule 1. Returns (factor, note). A doubtful player with no percentage is not scored:
    the rule cannot be applied to him, so the no-action side is taken (see fitness_unknown)."""
    status = (player.get("status") or "a").lower()
    if status in OUT_STATUSES:
        return 0.0, "%s (0)" % {"i": "injured", "s": "suspended",
                                "u": "unavailable", "n": "not in the league"}[status]
    if status == "d":
        chance = player.get("chance_of_playing_next_round")
        if chance is None:
            return 1.0, "doubtful, no percentage given"
        return max(0.0, min(1.0, float(chance) / 100.0)), "doubtful %d%%" % int(chance)
    return 1.0, "fit"


def fitness_unknown(player):
    return (player.get("status") or "a").lower() == "d" and player.get("chance_of_playing_next_round") is None


def form_factor(player):
    """Rule 1's tie-breaker: form against the season's own rate, capped at +/-10%."""
    try:
        form = float(player.get("form") or 0)
    except (TypeError, ValueError):
        form = 0.0
    base = ppg(player)
    delta = (form - base) / max(base, 1.0)
    return 1.0 + max(-FORM_CLAMP, min(FORM_CLAMP, delta))


def week_score(player, fixtures):
    fits, _ = fitness(player)
    return ppg(player) * sum(difficulty_factors(int(player["team"]), fixtures)) * fits * form_factor(player)


def horizon_score(player, gw, fixtures_by_gw):
    """Rule 2's five-gameweek check: the same score summed over gw..gw+4."""
    total = 0.0
    for n in range(gw, gw + HORIZON):
        if n in fixtures_by_gw:
            total += week_score(player, fixtures_by_gw[n])
    return total


def long_out(player, gw, deadlines):
    """Rule 3's escape hatch: a long injury or leaving the league is not a bad week."""
    status = (player.get("status") or "a").lower()
    if status not in OUT_STATUSES:
        return False
    if status in ("u", "n"):
        return True                                    # unavailable or no longer in the league
    back = parse_utc(player.get("news_return")) if player.get("news_return") else None
    if back is None:
        return True                                    # out with no return date given
    edge = deadlines.get(gw + HORIZON - 1)
    return bool(edge and back >= edge)


def is_a_grade(player):
    return (player.get("web_name") or "") in A_GRADE


# ──────────────────────────── the plan ────────────────────────────

def build_plan(reader, when=None):
    """Every read, every figure, and the swaps the rules give. Raises FplReadError on any
    read that could not happen; never returns a half-read plan."""
    when = when or datetime.now(timezone.utc)
    game = read_game(reader)
    bootstrap = read_bootstrap(reader)
    gw, deadline = next_deadline(bootstrap, when)
    events = events_by_gw(bootstrap)
    deadlines = {n: parse_utc(ev.get("deadline_time")) for n, ev in events.items()}

    fixtures_by_gw = {}
    for n in range(gw, gw + HORIZON):
        if n in events:
            fixtures_by_gw[n] = read_fixtures(reader, n)
    if gw not in fixtures_by_gw:
        raise FplReadError("fantasy fixtures GW%d: the next gameweek has no fixture list" % gw)

    draft_fixtures = (bootstrap.get("fixtures") or {}).get(str(gw)) or []
    teams = team_map(bootstrap, fixtures_by_gw[gw], draft_fixtures)

    elements = {int(e["id"]): e for e in bootstrap["elements"]}
    # The next gameweek has no pick history yet ("No pick history"), so the squad is read from
    # the latest finished gameweek, which is the squad the swaps are made against.
    squad_gw = int(game["current_event"])
    picks = read_picks(reader, squad_gw)
    status_rows = read_status(reader)

    squad = []
    for pick in picks:
        el = elements.get(int(pick["element"]))
        if el is None:
            raise FplReadError("entry picks GW%d: player %s is not in the bootstrap"
                               % (squad_gw, pick.get("element")))
        squad.append({"player": el, "slot": int(pick.get("position") or 0)})

    owned = {int(r["element"]) for r in status_rows if r.get("owner") is not None}
    skipped = {"minutes": 0, "fitness_unknown": 0, "cannot_play": 0}
    free_agents = []
    for row in status_rows:
        if row.get("owner") is not None:
            continue
        el = elements.get(int(row["element"]))
        if el is None:
            continue
        if int(el.get("minutes") or 0) < MIN_MINUTES:   # rule 4
            skipped["minutes"] += 1
            continue
        if fitness_unknown(el):
            # The rule needs a percentage and the site gave none. Signing an unknown is the
            # acting side, so he is left out and counted in the card.
            skipped["fitness_unknown"] += 1
            continue
        if (el.get("status") or "a").lower() in OUT_STATUSES:
            skipped["cannot_play"] += 1
            continue
        free_agents.append(el)

    def wk(player):
        return week_score(player, fixtures_by_gw[gw])

    def five(player):
        return horizon_score(player, gw, fixtures_by_gw)

    # Rule 5: biggest gain first, each free agent used once, each squad slot replaced once.
    # Recomputed after each accepted swap, because the weakest in a position moves.
    swaps = []
    taken = set()
    remaining = list(squad)
    while True:
        best = None
        for pos in sorted(POSITION_NAME):
            droppable = [s for s in remaining
                         if int(s["player"]["element_type"]) == pos
                         and not (is_a_grade(s["player"]) and not long_out(s["player"], gw, deadlines))]
            if not droppable:
                continue
            weakest = min(droppable, key=lambda s: wk(s["player"]))
            for fa in free_agents:
                if int(fa["id"]) in taken or int(fa["element_type"]) != pos:
                    continue
                gain = wk(fa) - wk(weakest["player"])
                if gain <= 0:                                        # rule 2, this week
                    continue
                if five(fa) < five(weakest["player"]):               # rule 2, next five
                    continue
                if best is None or gain > best["gain"]:
                    best = {"gain": gain, "out": weakest, "in": fa, "pos": pos}
        if best is None:
            break
        taken.add(int(best["in"]["id"]))
        remaining = [s for s in remaining if s is not best["out"]]
        remaining.append({"player": best["in"], "slot": best["out"]["slot"]})
        swaps.append({
            "position": POSITION_NAME[best["pos"]],
            "out": best["out"]["player"], "in": best["in"],
            "slot": best["out"]["slot"],
            "out_week": wk(best["out"]["player"]), "in_week": wk(best["in"]),
            "out_five": five(best["out"]["player"]), "in_five": five(best["in"]),
            "gain": best["gain"],
        })

    keepers = [s["player"] for s in remaining if int(s["player"]["element_type"]) == 1]
    starter = max(keepers, key=wk) if keepers else None

    return {
        "gameweek": gw,
        "squad_gameweek": squad_gw,
        "deadline_utc": deadline,
        "waivers_processed": bool(game["waivers_processed"]),
        "teams": teams,
        "squad": squad,
        "final_squad": remaining,
        "free_agents": free_agents,
        "owned_count": len(owned),
        "skipped": skipped,
        "swaps": swaps,
        "goalkeeper": starter,
        "goalkeepers": keepers,
        "week_score": wk,
        "five_score": five,
        "read_at": dict(reader.read_at),
    }


# ──────────────────────────── the card ────────────────────────────

def london(dt):
    if dt is None:
        return "unknown"
    return (dt.astimezone(LONDON) if LONDON else dt).strftime("%a %d %b %H:%M")


def card_text(plan):
    gw = plan["gameweek"]
    lines = []
    if plan["swaps"]:
        asks = ", ".join("%s out for %s" % (s["out"]["web_name"], s["in"]["web_name"]) for s in plan["swaps"])
        lines.append("FPL SWAPS GW%d: %s. Put %s in goal. Deadline %s."
                     % (gw, asks, (plan["goalkeeper"] or {}).get("web_name", "?"),
                        london(plan["deadline_utc"])))
    else:
        lines.append("FPL SWAPS GW%d: no swap earns its place this week. Put %s in goal. Deadline %s."
                     % (gw, (plan["goalkeeper"] or {}).get("web_name", "?"), london(plan["deadline_utc"])))
    lines.append("")
    lines.append("This recommends only. Nothing in your team has changed.")
    lines.append("")
    if plan["swaps"]:
        lines.append("| Out | In | Pos | This week | Next five | Why |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for s in plan["swaps"]:
            lines.append("| %s (%.2f) | %s (%.2f) | %s | +%.2f | %.2f vs %.2f | %s |"
                         % (s["out"]["web_name"], s["out_week"], s["in"]["web_name"], s["in_week"],
                            s["position"], s["gain"], s["in_five"], s["out_five"],
                            "beats your weakest %s this week and is not worse over five" % s["position"]))
    else:
        lines.append("The five rules were applied to %d free agents (of %d free-agent rows) and none "
                     "beat your weakest player in his position this week without being worse over the "
                     "next five gameweeks." % (len(plan["free_agents"]),
                                               len(plan["free_agents"]) + sum(plan["skipped"].values())))
    lines.append("")
    if plan["goalkeepers"]:
        lines.append("Goalkeeper: " + ", ".join(
            "%s %.2f" % (k.get("web_name"), plan["week_score"](k)) for k in plan["goalkeepers"])
            + ". The best scorer starts.")
    skipped = plan["skipped"]
    lines.append("Left out of the free-agent pool: %d under %d minutes, %d doubtful with no percentage "
                 "given, %d injured, suspended or unavailable."
                 % (skipped["minutes"], MIN_MINUTES, skipped["fitness_unknown"], skipped["cannot_play"]))
    lines.append("Squad read from gameweek %d (the last one with a pick history)." % plan["squad_gameweek"])
    lines.append("Read at: " + ", ".join("%s %s" % (k, v) for k, v in sorted(plan["read_at"].items())) + ".")
    lines.append("")
    lines.append("**Carrying this out will involve:** Opening your FPL Draft team before the deadline "
                 "and making the swaps above by hand, or telling a chat to do it. This card changed "
                 "nothing by itself.")
    return "\n".join(lines)


def card_fields(plan):
    when = now_london()
    stamp = when.strftime("%Y-%m-%d %H:%M")
    gw = plan["gameweek"]
    return {
        F["name"]: "FPL swaps GW%d" % gw,
        F["description"]: "Weekly FPL Draft swap recommendation for gameweek %d (deadline %s)."
                          % (gw, london(plan["deadline_utc"])),
        F["status"]: "Approval",
        F["dueDate"]: when.strftime("%Y-%m-%d"),
        F["teamMember"]: [TASK_MANAGER],
        F["sentForApprovalBy"]: [TASK_MANAGER],
        F["taskType"]: "Admin",
        F["agentOutput"]: card_text(plan),
        F["notes"]: "[%s — fpl-draft-swaps] %d swap(s) recommended, %d free agents scored. "
                    "Recommendation only; no change made to the team."
                    % (stamp, len(plan["swaps"]), len(plan["free_agents"])),
    }


def existing_card(gw):
    """True when a card for this gameweek already exists, open or closed. A second card for
    the same gameweek is noise, and the gate runs hourly."""
    name = "FPL swaps GW%d" % gw
    r = subprocess.run([sys.executable, os.path.join(REPO, "scripts", "airtable-read.py"),
                        "Tasks", "--formula", "{Task Name}=\"%s\"" % name, "--fields", "Task Name"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise FplReadError("existing-card check: airtable-read exit %d (%s)"
                           % (r.returncode, (r.stderr or r.stdout)[:200]))
    try:
        said = json.loads(r.stdout)
    except ValueError:
        raise FplReadError("existing-card check: reader did not return JSON")
    if not said.get("ok"):
        raise FplReadError("existing-card check: %s" % said.get("error", "read refused"))
    if "records" not in said or not isinstance(said["records"], list):
        raise FplReadError("existing-card check: reply has no 'records' list")
    return len(said["records"]) > 0


def create_task(fields, dry_run=False):
    if dry_run:
        return {"dryRun": True}
    r = subprocess.run([sys.executable, os.path.join(REPO, "scripts", "create-agent-task.py"), "create",
                        "--force", "--fields-json", json.dumps(fields)], capture_output=True, text=True)
    out = (r.stdout or "").strip()
    try:
        said = json.loads(out.splitlines()[-1]) if out else {}
    except ValueError:
        said = {}
    if r.returncode != 0:
        if said.get("taskId"):
            raise RuntimeError("card %s was created but incomplete (exit %d): %s"
                               % (said["taskId"], r.returncode, (r.stderr or out)[:250]))
        raise RuntimeError("create-agent-task failed: " + (r.stderr or out)[:300])
    return {"created": True, "taskId": said.get("taskId"), "action": said.get("action")}


def gate(plan, when=None, hours=DEADLINE_WINDOW_HOURS):
    """Why this hour is quiet, or None when a card is owed."""
    when = when or datetime.now(timezone.utc)
    if not plan["waivers_processed"]:
        return "waivers for GW%d are not processed yet" % plan["gameweek"]
    gap = plan["deadline_utc"] - when
    if gap > timedelta(hours=hours):
        return ("GW%d deadline is %s away, more than the %d-hour window"
                % (plan["gameweek"], str(gap).split(".")[0], hours))
    return None


# ──────────────────────────── printing ────────────────────────────

def print_plan(plan):
    print("FPL Draft GW%d — deadline %s (waivers processed: %s)"
          % (plan["gameweek"], london(plan["deadline_utc"]),
             "yes" if plan["waivers_processed"] else "no"))
    print("Squad read from gameweek %d. %d free-agent rows scored, %d left out (%s)."
          % (plan["squad_gameweek"], len(plan["free_agents"]), sum(plan["skipped"].values()),
             ", ".join("%s %d" % (k, v) for k, v in sorted(plan["skipped"].items()))))
    print("")
    print("YOUR SQUAD, this week and next five:")
    for s in sorted(plan["squad"], key=lambda s: (int(s["player"]["element_type"]), -plan["week_score"](s["player"]))):
        p = s["player"]
        fits, note = fitness(p)
        print("  slot %-2d %-4s %-16s ppg %-4s week %5.2f  five %6.2f  %s"
              % (s["slot"], POSITION_NAME[int(p["element_type"])], p["web_name"],
                 p.get("points_per_game"), plan["week_score"](p), plan["five_score"](p), note))
    print("")
    if plan["swaps"]:
        print("SWAPS, biggest gain first:")
        for s in plan["swaps"]:
            print("  %-4s slot %-2d  OUT %-16s %5.2f / %6.2f   IN %-16s %5.2f / %6.2f   gain %+.2f"
                  % (s["position"], s["slot"], s["out"]["web_name"], s["out_week"], s["out_five"],
                     s["in"]["web_name"], s["in_week"], s["in_five"], s["gain"]))
    else:
        print("SWAPS: none. No free agent beat a droppable player this week without being worse over five.")
    print("")
    print("GOALKEEPER: %s starts (%s)."
          % ((plan["goalkeeper"] or {}).get("web_name", "none"),
             ", ".join("%s %.2f" % (k.get("web_name"), plan["week_score"](k)) for k in plan["goalkeepers"])))
    print("Read at: " + ", ".join("%s %s" % (k, v) for k, v in sorted(plan["read_at"].items())))


# ──────────────────────────── selftest ────────────────────────────

def selftest(fixture_root=None):
    """The three recorded scenarios. Returns the number that failed."""
    root = fixture_root or os.path.join(REPO, "tests", "fixtures", "fpl")
    failed = 0
    for name, check in (("gw11-expected", _check_expected), ("edge", _check_edge),
                        ("fail-game-500", _check_fail), ("fail-no-waivers-key", _check_fail),
                        ("fail-no-pick-history", _check_fail)):
        where = os.path.join(root, name)
        if not os.path.isdir(where):
            print("MISSING fixture %s" % where)
            failed += 1
            continue
        try:
            verdict = check(where)
        except Exception as exc:                        # a scenario must never take the run down
            verdict = "RAISED %s: %s" % (type(exc).__name__, exc)
        ok = verdict == "ok"
        print("%-22s %s" % (name, "ok" if ok else verdict))
        failed += 0 if ok else 1
    return failed


def _fixture_plan(where, when):
    return build_plan(Reader(fixtures=where), when=when)


def _check_expected(where):
    """Kevin's 20 Nov gameweek, rebuilt: the three players he signed back in the pool, the
    three he dropped back in his 15. Two of his three swaps come straight out of the rules.

    The third (Dewsbury-Hall out for McGinn) does NOT, and that is the finding, not a fault:
    McGinn beats Dewsbury-Hall this week (4.44 against 4.25) but is worse over the next five
    (21.46 against 23.75), so rule 2 refuses it. The figures behind the reconstruction are the
    live 27 Nov ones, because the draft site keeps no pre-gameweek snapshot of points per game,
    so the week Kevin judged by hand is not the week these numbers describe. The assertion
    below pins what the rules do with THESE numbers, which is what the card will show."""
    plan = _fixture_plan(where, datetime(2026, 11, 20, 9, 0, tzinfo=timezone.utc))
    got = {(s["out"]["web_name"], s["in"]["web_name"]) for s in plan["swaps"]}
    want = {("McBurnie", "N.Jackson"), ("Pickford", "Verbruggen")}
    missing = want - got
    if missing:
        return "missing swaps %s (got %s)" % (sorted(missing), sorted(got))
    if (plan["goalkeeper"] or {}).get("web_name") != "Verbruggen":
        return "goalkeeper was %s, not Verbruggen" % (plan["goalkeeper"] or {}).get("web_name")
    if any(s["in"]["web_name"] == "McGinn" for s in plan["swaps"]):
        return "McGinn was signed although he is worse over the next five gameweeks (rule 2)"
    return "ok"


def _check_edge(where):
    plan = _fixture_plan(where, datetime(2026, 11, 20, 9, 0, tzinfo=timezone.utc))
    out_names = {s["out"]["web_name"] for s in plan["swaps"]}
    in_names = {s["in"]["web_name"] for s in plan["swaps"]}
    if "Palmer" in out_names:
        return "an A-grade was dropped on one bad week"
    names = {p["web_name"] for p in plan["free_agents"]}
    if "Under300" in names:
        return "a free agent on 299 minutes was considered"
    if "Exactly300" not in names:
        return "a free agent on 300 minutes was ignored"
    return "ok" if in_names else "no swap at all in the edge fixture"


def _check_fail(where):
    try:
        _fixture_plan(where, datetime(2026, 11, 20, 9, 0, tzinfo=timezone.utc))
    except FplReadError:
        return "ok"
    return "a broken read was not reported as NOT CHECKED"


# ──────────────────────────── main ────────────────────────────

def main(argv=None):
    ap = argparse.ArgumentParser(description="Kevin's weekly FPL Draft swap card (recommends only).")
    ap.add_argument("command", choices=["plan", "card", "selftest"])
    ap.add_argument("--fixtures", default=os.environ.get("FPL_FIXTURES"),
                    help="read from a recorded fixture directory instead of the live sites")
    ap.add_argument("--dry-run", action="store_true", help="card: build the card but write nothing")
    ap.add_argument("--force", action="store_true", help="card: skip the deadline-window gate")
    args = ap.parse_args(argv)

    if args.command == "selftest":
        failed = selftest(args.fixtures)
        print("selftest: %s" % ("all scenarios ok" if not failed else "%d scenario(s) failed" % failed))
        return 0 if not failed else 2

    try:
        plan = build_plan(Reader(fixtures=args.fixtures))
    except FplReadError as exc:
        print("NOT CHECKED: %s" % exc, file=sys.stderr)
        return 2

    if args.command == "plan":
        print_plan(plan)
        return 0

    quiet = None if args.force else gate(plan)
    if quiet:
        print("quiet: %s. No card." % quiet)
        return 0
    if existing_card(plan["gameweek"]):
        print("quiet: a card named 'FPL swaps GW%d' already exists. No second card." % plan["gameweek"])
        return 0
    said = create_task(card_fields(plan), dry_run=args.dry_run)
    print(json.dumps({"gameweek": plan["gameweek"], "swaps": len(plan["swaps"]),
                      "goalkeeper": (plan["goalkeeper"] or {}).get("web_name"), "card": said}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
