#!/usr/bin/env python3
"""runpreneur_sync.py — the four numbers on the "How far I've run" page, and the name of each run.

What Ericamae's app did by hand (its Runpreneur Sync page, SOP 62), now nightly and deterministic:

  1. Latest run from Strava (activity distance in km).
  2. Total distance = last stored total + that run (the app's running total, seeded from the
     website's live value the first time). Total days = the streak day from the DATE (1 Jun 2020
     = day 1), Kevin's ruling, not "last stored + 1".
  3. Total raised = £70,000 baseline (donations before Stripe) + Stripe lifetime gross of
     succeeded GBP charges on the Runpreneur account (read-only key in ~/.config/od/).
  4. Progress bar = total distance / 40,075 km, as "43.66%".
  5. Push the four onto the GoHighLevel custom values the website's merge tags read
     (total_of_days, total_disctance [sic], total_raised, progress_bar).
  6. Rename the run on Strava with the app's exact wording:
        Day #2,286/5,000 #runpreneurchallenge
        Total raised so far £76,842/£1,000,000
        Total distance so far 17,503.21km/40,075km
     (first line = the activity name, the whole block = the description).

Idempotent per activity: the ledger remembers which activity id was folded into the total, so
a re-run never double-counts. Strava's app quota is shared with the Make.com scenario; a 429
leaves everything untouched and says so.

State: ~/knowledge-os/logs/content-engine/runpreneur_sync.json. Secrets in ~/.config/od/.
"""
import argparse, base64, datetime as dt, json, os, sys, time, urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import watch  # noqa: E402

CFG = os.path.expanduser("~/.config/od")
STATE = os.path.join(os.path.dirname(watch.LEDGER), "runpreneur_sync.json")
STREAK_START = dt.date(2020, 6, 1)
GOAL_KM, GOAL_GBP, DAYS_TARGET = 40075, 1_000_000, 5000
BASELINE_RAISED = 70000.0          # donations before Stripe; the app's default, matches the live site (76,840 = 70,000 + 6,840)
CV = {"total_of_days": "CYXc0eQHefxIgnTibBR3", "total_disctance": "IX7TbNQdQTNQwVrlEq1X", "total_raised": "vF4rXf0z65ZYPlD6sSql", "progress_bar": "uJ11hqWOSE34nj9unf8s"}
UA = "Mozilla/5.0 od-content-engine"


# ---------- pure (selftested) ----------

def streak_day(d):
    return (d - STREAK_START).days + 1


def fmt_num(n, decimals=None):
    if decimals is None: decimals = 2 if abs(n - round(n)) > 1e-9 else 0
    return ("{:,.%df}" % decimals).format(n)


def caption(day, raised, km):
    return ("Day #%s/%s #runpreneurchallenge\nTotal raised so far £%s/£1,000,000\nTotal distance so far %skm/40,075km"
            % (fmt_num(day), fmt_num(DAYS_TARGET), fmt_num(raised), fmt_num(km, 2)))


def progress(km):
    return "%.2f%%" % min(100.0, km / GOAL_KM * 100)


def fold(state, activity, today):
    """Add one activity to the running total once. Returns (new_state, changed)."""
    aid = str(activity["id"])
    if aid in state.get("folded", []): return state, False
    km = activity["distance"] / 1000.0
    state["total_km"] = round(state.get("total_km", 0.0) + km, 2)
    state.setdefault("folded", []).append(aid); state["folded"] = state["folded"][-400:]
    state["last_activity"] = {"id": aid, "km": round(km, 2), "start": activity.get("start_date_local"), "name": activity.get("name")}
    state["day"] = streak_day(today)
    return state, True


def values(state, raised):
    km = state["total_km"]
    return {"total_of_days": str(state["day"]), "total_disctance": "%.2f" % km, "total_raised": "%d" % round(raised), "progress_bar": progress(km)}


# ---------- Strava ----------

def strava_token():
    cid = open(os.path.join(CFG, "strava_client_id")).read().strip(); sec = open(os.path.join(CFG, "strava_client_secret")).read().strip()
    path = os.path.join(CFG, "strava_access_token")
    try: cur = json.load(open(path))
    except Exception: cur = {}
    if cur.get("expires_at", 0) > time.time() + 300: return cur["access_token"]
    refresh = open(os.path.join(CFG, "strava_refresh_token")).read().strip()
    body = urllib.parse.urlencode({"client_id": cid, "client_secret": sec, "grant_type": "refresh_token", "refresh_token": refresh}).encode()
    d = json.load(urllib.request.urlopen(urllib.request.Request("https://www.strava.com/oauth/token", data=body, method="POST")))
    os.umask(0o077)
    open(os.path.join(CFG, "strava_refresh_token"), "w").write(d["refresh_token"])
    open(path, "w").write(json.dumps({"access_token": d["access_token"], "expires_at": d["expires_at"]}))
    return d["access_token"]


def strava(method, path, body=None):
    tok = strava_token()
    req = urllib.request.Request("https://www.strava.com/api/v3" + path, data=urllib.parse.urlencode(body).encode() if body else None, method=method,
                                 headers={"Authorization": "Bearer " + tok, "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return json.load(r)
    except urllib.error.HTTPError as e:
        lim = e.headers.get("x-ratelimit-limit"); usage = e.headers.get("x-ratelimit-usage")
        raise SystemExit("Strava %s %s -> %s (limit %s, usage %s): %s" % (method, path, e.code, lim, usage, e.read().decode()[:160]))


def latest_run():
    acts = strava("GET", "/athlete/activities?per_page=5")
    runs = [a for a in acts if a.get("type") in ("Run", "TrailRun", "VirtualRun") or a.get("sport_type", "").endswith("Run")]
    if not runs: raise SystemExit("Strava returned no run in the last five activities")
    return runs[0]


# ---------- Stripe ----------

def stripe_lifetime_gross():
    key = open(os.path.join(CFG, "stripe_runpreneur_key")).read().strip()
    H = {"Authorization": "Basic " + base64.b64encode((key + ":").encode()).decode(), "User-Agent": UA}
    total = 0; count = 0; after = None
    while True:
        url = "https://api.stripe.com/v1/charges?limit=100" + ("&starting_after=" + after if after else "")
        try: d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=60))
        except urllib.error.HTTPError as e: raise SystemExit("Stripe %s: %s" % (e.code, e.read().decode()[:160]))
        for c in d["data"]:
            if c.get("paid") and c.get("status") == "succeeded" and c.get("currency") == "gbp":
                total += c["amount"]; count += 1
        if not d.get("has_more"): break
        after = d["data"][-1]["id"]
    return total / 100.0, count


# ---------- GHL custom values ----------

def ghl_custom_values(loc_key):
    key, loc = loc_key
    H = {"Authorization": "Bearer " + key, "Version": "2021-07-28", "Accept": "application/json", "Content-Type": "application/json", "User-Agent": UA}
    def call(method, path, body=None):
        req = urllib.request.Request("https://services.leadconnectorhq.com" + path, data=json.dumps(body).encode() if body else None, method=method, headers=H)
        try:
            with urllib.request.urlopen(req, timeout=60) as r: return json.load(r)
        except urllib.error.HTTPError as e: raise SystemExit("GHL %s %s -> %s: %s" % (method, path, e.code, e.read().decode()[:160]))
    return call


def push_values(vals, dry_run=False):
    key = open(os.path.join(CFG, "ghl_social_key_runpreneur")).read().strip(); loc = open(os.path.join(CFG, "ghl_location_id_runpreneur")).read().strip()
    call = ghl_custom_values((key, loc))
    live = {v["name"]: v for v in call("GET", "/locations/%s/customValues" % loc).get("customValues", [])}
    out = {}
    for name, cid in CV.items():
        cur = live.get({"total_of_days": "Total of days", "total_disctance": "Total Distance", "total_raised": "Total raised", "progress_bar": "Progress Bar"}[name], {})
        if cur.get("id") and cur["id"] != cid: raise SystemExit("custom value %s id changed (%s vs %s); refusing to write blind" % (name, cur["id"], cid))
        out[name] = (cur.get("value"), vals[name])
        if not dry_run and cur.get("value") != vals[name]:
            call("PUT", "/locations/%s/customValues/%s" % (loc, cid), {"name": cur.get("name"), "value": vals[name]})
    return out


# ---------- state ----------

def load_state():
    if os.path.exists(STATE): return json.load(open(STATE))
    return {}


def save_state(state):
    os.makedirs(os.path.dirname(STATE), exist_ok=True); tmp = STATE + ".tmp"
    json.dump(state, open(tmp, "w"), indent=1); os.replace(tmp, STATE)


def seed_from_site():
    """First run: the running total starts from the live website value, as the app's did."""
    key = open(os.path.join(CFG, "ghl_social_key_runpreneur")).read().strip(); loc = open(os.path.join(CFG, "ghl_location_id_runpreneur")).read().strip()
    live = {v["name"]: v.get("value") for v in ghl_custom_values((key, loc))("GET", "/locations/%s/customValues" % loc).get("customValues", [])}
    km = float(str(live.get("Total Distance", "0")).replace(",", "") or 0)
    if km <= 0: raise SystemExit("cannot seed: the site's Total Distance is empty")
    return {"total_km": km, "folded": [], "seeded_from_site": {"km": km, "days": live.get("Total of days"), "at": dt.datetime.now().isoformat(timespec="seconds")}}


def run(dry_run=False, rename=True):
    state = load_state() or seed_from_site()
    today = dt.datetime.now(dt.timezone.utc).astimezone().date()
    act = latest_run()
    start = (act.get("start_date_local") or "")[:10]
    if start != today.isoformat():
        print("latest Strava run is dated %s, not today (%s): nothing folded, values unchanged" % (start, today)); save_state(state); return
    state, changed = fold(state, act, today)
    gross, n = stripe_lifetime_gross()
    raised = BASELINE_RAISED + gross
    vals = values(state, raised)
    if dry_run:
        print("DRY RUN", json.dumps({"activity": state["last_activity"], "values": vals, "stripe_gross": gross, "charges": n}, indent=1)); return
    pushed = push_values(vals)
    text = caption(state["day"], raised, state["total_km"])
    if rename:
        strava("PUT", "/activities/%s" % act["id"], {"name": text.split("\n")[0], "description": text})
    state["last_push"] = {"at": dt.datetime.now().isoformat(timespec="seconds"), "values": vals, "renamed": rename, "stripe_charges": n}
    save_state(state)
    print("day %s: run %s (%.2f km) folded=%s; site now %s; raised £%s (Stripe %d charges); Strava run %s" % (
        state["day"], act["id"], state["last_activity"]["km"], changed, {k: v[1] for k, v in pushed.items()}, fmt_num(raised), n, "renamed" if rename else "left"))


def report():
    s = load_state()
    if not s: print("runpreneur sync: never run"); return
    lp = s.get("last_push", {})
    print("runpreneur sync: last push %s, day %s, %s km, raised £%s" % (lp.get("at", "never"), s.get("day"), s.get("total_km"), (lp.get("values") or {}).get("total_raised", "?")))


def selftest():
    assert streak_day(dt.date(2020, 6, 1)) == 1 and streak_day(dt.date(2026, 9, 3)) == 2286
    assert caption(2286, 76842, 17503.21) == "Day #2,286/5,000 #runpreneurchallenge\nTotal raised so far £76,842/£1,000,000\nTotal distance so far 17,503.21km/40,075km"
    assert progress(17496.06) == "43.66%" and progress(50000) == "100.00%"
    st = {"total_km": 17496.06, "folded": []}
    st, ch = fold(st, {"id": 1, "distance": 7150, "start_date_local": "2026-09-03T18:00:00Z", "name": "Evening Run"}, dt.date(2026, 9, 3))
    assert ch and st["total_km"] == 17503.21 and st["day"] == 2286
    st, ch2 = fold(st, {"id": 1, "distance": 7150}, dt.date(2026, 9, 3)); assert not ch2 and st["total_km"] == 17503.21, "never double-count"
    v = values(st, 76842.0); assert v == {"total_of_days": "2286", "total_disctance": "17503.21", "total_raised": "76842", "progress_bar": "43.68%"}, v
    assert set(CV) == {"total_of_days", "total_disctance", "total_raised", "progress_bar"}
    print(json.dumps({"checks": 9, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("mode"); ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--no-rename", action="store_true")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "run": run(dry_run=a.dry_run, rename=not a.no_rename)
    elif a.mode == "report": report()
    else: raise SystemExit("usage: runpreneur_sync.py run [--dry-run] [--no-rename] | report | selftest")
