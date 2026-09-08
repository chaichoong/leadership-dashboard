#!/usr/bin/env python3
"""runpreneur_map.py — the numbers behind the "How far I've run" map page, redrawn every night.

Kevin (8 Sep 2026): the website's map was a hand-drawn route and typed text that went stale
("average of 8 km daily", "Cambridge to Tasmania", a countries list). This computes all of it
from Strava, nightly, and publishes one JSON file the page reads:

  - the headline: days, total km, % of the 40,075 km lap, £ raised (the same figures the
    website's counters show, from runpreneur_sync's running total, so the two never disagree)
  - the route: a lap of the world through named waypoints, and the point reached at today's km
  - the countries: every country a run STARTED in, from the start point of each Strava run
    matched offline against Natural Earth country outlines (no run location is ever published,
    only the country and its run count)
  - the facts: average per day, longest run, most-run country, the city pair the total now
    matches, the next milestone and when it lands at the current pace

Publishing goes through the GitHub API (gh) straight into main, so it never depends on which
branch the local checkout sits on. Page: runpreneur-map/index.html on GitHub Pages, embedded on
the website in place of the old Footpath frame.

  run        fetch new runs, recompute, publish progress.json (the nightly step)
  compute    recompute from the cached runs and print the JSON (no publish)
  selftest
"""
import argparse, base64, datetime as dt, json, math, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import watch  # noqa: E402

STREAK_START = dt.date(2020, 6, 1)
LAP_KM = 40075.0
RAISE_TARGET = 1_000_000
STATE_DIR = os.path.dirname(watch.LEDGER)
ACTIVITIES = os.path.join(STATE_DIR, "strava_activities.json")
SYNC_STATE = os.path.join(STATE_DIR, "runpreneur_sync.json")
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
COUNTRIES = os.path.join(REPO_ROOT, "runpreneur-map", "data", "countries.geojson")
PROGRESS_PATH = "runpreneur-map/data/progress.json"
GH_REPO = "chaichoong/leadership-dashboard"
GH = os.path.expanduser("~/tools/bin/gh")

# A lap of the world from home, through the places the mission talks about. Great-circle legs,
# scaled so the whole lap is exactly 40,075 km. Kevin's marker sits at today's total along it.
ROUTE = [("Cambridge, UK", 52.2053, 0.1218), ("Paris", 48.8566, 2.3522), ("Rome", 41.9028, 12.4964), ("Athens", 37.9838, 23.7275),
         ("Istanbul", 41.0082, 28.9784), ("Tehran", 35.6892, 51.3890), ("Delhi", 28.6139, 77.2090), ("Bangkok", 13.7563, 100.5018),
         ("Singapore", 1.3521, 103.8198), ("Perth", -31.9505, 115.8605), ("Hobart, Tasmania", -42.8821, 147.3272), ("Auckland", -36.8485, 174.7633),
         ("Honolulu", 21.3069, -157.8583), ("Los Angeles", 34.0522, -118.2437), ("Mexico City", 19.4326, -99.1332), ("New York", 40.7128, -74.0060),
         ("Reykjavik", 64.1466, -21.9426), ("Cambridge, UK", 52.2053, 0.1218)]
# Distances the total is compared with (km, as the crow flies), for the "that's the same as..." line.
EQUIVALENTS = [("London to Paris", 344), ("London to Rome", 1434), ("London to Cairo", 3520), ("London to New York", 5570),
               ("London to Mumbai", 7200), ("London to Beijing", 8150), ("London to Cape Town", 9670), ("London to Tokyo", 9560),
               ("London to Rio de Janeiro", 9280), ("London to Buenos Aires", 11100), ("London to Perth", 14500),
               ("Cambridge to Sydney", 17000), ("Cambridge to Tasmania", 17300), ("Cambridge to Auckland", 18350),
               ("halfway round the world", 20037), ("London to Tokyo and back", 19120), ("London to Sydney and back", 34000), ("once round the world", 40075)]


# ---------- geometry (pure) ----------

def haversine(lat1, lon1, lat2, lon2):
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2); dphi = p2 - p1; dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def route_legs(route=ROUTE):
    raw = [haversine(route[i][1], route[i][2], route[i + 1][1], route[i + 1][2]) for i in range(len(route) - 1)]
    scale = LAP_KM / sum(raw)
    return [d * scale for d in raw], scale


def point_along(km, route=ROUTE):
    """(lat, lon, leg name) at `km` along the scaled lap. Past the end sits at home again."""
    legs, _ = route_legs(route)
    left = max(0.0, min(km, LAP_KM))
    for i, d in enumerate(legs):
        if left <= d:
            f = left / d if d else 0
            a, b = route[i], route[i + 1]
            return a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, "%s to %s" % (a[0], b[0])
        left -= d
    return route[-1][1], route[-1][2], "home"


def point_in_ring(lon, lat, ring):
    inside = False; n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]; x2, y2 = ring[(i + 1) % n]
        if (y1 > lat) != (y2 > lat):
            x = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
            if x > lon: inside = not inside
    return inside


def point_in_geom(lon, lat, geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        if point_in_ring(lon, lat, poly[0]) and not any(point_in_ring(lon, lat, hole) for hole in poly[1:]): return True
    return False


NAME_MAP = {"Turkish Republic of Northern Cyprus": "Northern Cyprus", "United States of America": "United States", "United Republic of Tanzania": "Tanzania",
            "Czechia": "Czech Republic", "Republic of Serbia": "Serbia"}


def country_of(lat, lon, features, cache={}):
    key = (round(lat, 2), round(lon, 2))
    if key in cache: return cache[key]
    name = None
    for f in features:
        if point_in_geom(lon, lat, f["geometry"]):
            name = f["properties"].get("NAME_EN") or f["properties"].get("NAME"); name = NAME_MAP.get(name, name); break
    cache[key] = name
    return name


# ---------- facts (pure) ----------

def equivalent(total_km):
    below = [e for e in EQUIVALENTS if e[1] <= total_km]
    return max(below, key=lambda e: e[1])[0] if below else EQUIVALENTS[0][0]


def next_milestone(total_km, days):
    km_next = (int(total_km // 1000) + 1) * 1000
    day_next = (int(days // 100) + 1) * 100
    return km_next, day_next


def compute(runs, total_km, raised, days, features, today=None):
    """runs: streak runs [{date, km, latlng}] on or after 1 Jun 2020. total_km/raised/days: the website's
    own counters (the sync's running total), so the map never disagrees with the number beside it."""
    today = today or dt.date.today()
    streak = [r for r in runs if r["date"] >= STREAK_START.isoformat()]
    by_country = {}
    for r in streak:
        if not r.get("latlng"): continue
        c = country_of(r["latlng"][0], r["latlng"][1], features)
        if c: by_country[c] = by_country.get(c, 0) + 1
    countries = sorted(by_country.items(), key=lambda kv: -kv[1])
    longest = max(streak, key=lambda r: r["km"]) if streak else None
    avg = total_km / days if days else 0
    km_next, day_next = next_milestone(total_km, days)
    days_to_km = math.ceil((km_next - total_km) / avg) if avg else None
    lat, lon, leg = point_along(total_km)
    raw_names = {NAME_MAP.get(k, k): k for k in NAME_MAP}   # page filter matches outlines by their own name
    return {
        "as_at": today.isoformat(), "outline_names": {c: raw_names.get(c, c) for c, _ in countries}, "days": days, "total_km": round(total_km, 2), "lap_km": LAP_KM, "lap_pct": round(100 * total_km / LAP_KM, 2),
        "km_left": round(LAP_KM - total_km, 2), "raised": raised, "raise_target": RAISE_TARGET,
        "avg_km_per_day": round(avg, 2), "runs_counted": len(streak), "countries_count": len(countries),
        "countries": [{"name": c, "runs": n} for c, n in countries],
        "longest_run": {"km": longest["km"], "date": longest["date"]} if longest else None,
        "equivalent": equivalent(total_km),
        "next_km_milestone": km_next, "days_to_next_km_milestone": days_to_km,
        "next_day_milestone": day_next, "date_of_next_day_milestone": (today + dt.timedelta(days=day_next - days)).isoformat(),
        "lap_finish_estimate": (today + dt.timedelta(days=math.ceil((LAP_KM - total_km) / avg))).isoformat() if avg else None,
        "marker": {"lat": round(lat, 4), "lon": round(lon, 4), "leg": leg},
        "route": [{"name": n, "lat": la, "lon": lo} for n, la, lo in ROUTE],
    }


# ---------- IO ----------

def load_runs():
    d = json.load(open(ACTIVITIES))
    return [a for a in d["activities"] if str(a.get("type", "")).endswith("Run")]


def fetch_new_runs():
    """Runs newer than the newest cached one, appended to the cache. One or two requests a night."""
    import runpreneur_sync as rs
    d = json.load(open(ACTIVITIES)) if os.path.exists(ACTIVITIES) else {"activities": []}
    known = {a["id"] for a in d["activities"]}
    newest = max((a["date"] for a in d["activities"]), default="2016-01-01")
    after = int(time.mktime(dt.datetime.fromisoformat(newest).timetuple())) - 86400
    added = 0
    for a in rs.strava("GET", "/athlete/activities?per_page=200&after=%d" % after):
        if a["id"] in known: continue
        d["activities"].append({"id": a["id"], "date": a["start_date_local"][:10], "km": round(a["distance"] / 1000, 3), "min": round(a.get("moving_time", 0) / 60, 1),
                                "type": a.get("sport_type", a.get("type")), "latlng": a.get("start_latlng") or None, "name": (a.get("name") or "")[:80]})
        added += 1
    d["fetched"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    json.dump(d, open(ACTIVITIES + ".tmp", "w")); os.replace(ACTIVITIES + ".tmp", ACTIVITIES)
    return added


def site_counters():
    st = json.load(open(SYNC_STATE))
    return float(st["total_km"]), float(st.get("raised") or st.get("seeded_from_site", {}).get("raised") or 0), int(st.get("day") or (dt.date.today() - STREAK_START).days + 1)


def publish(progress):
    """Write the JSON into main through the GitHub API: no local branch involved."""
    body = json.dumps(progress, indent=1).encode()
    sha = subprocess.run([GH, "api", "repos/%s/contents/%s" % (GH_REPO, PROGRESS_PATH), "--jq", ".sha"], capture_output=True, text=True).stdout.strip()
    payload = {"message": "Runpreneur map: %s, %.2f km, %d countries [auto]" % (progress["as_at"], progress["total_km"], progress["countries_count"]),
               "content": base64.b64encode(body).decode(), "branch": "main"}
    if sha: payload["sha"] = sha
    r = subprocess.run([GH, "api", "-X", "PUT", "repos/%s/contents/%s" % (GH_REPO, PROGRESS_PATH), "--input", "-"], input=json.dumps(payload), capture_output=True, text=True)
    if r.returncode != 0: raise SystemExit("map publish failed: " + (r.stderr or r.stdout)[-300:])
    return json.loads(r.stdout)["commit"]["sha"][:7]


def run(publish_it=True):
    added = fetch_new_runs() if publish_it else 0
    features = json.load(open(COUNTRIES))["features"]
    total_km, raised, days = site_counters()
    progress = compute(load_runs(), total_km, raised, days, features)
    local = os.path.join(REPO_ROOT, PROGRESS_PATH)
    os.makedirs(os.path.dirname(local), exist_ok=True); json.dump(progress, open(local, "w"), indent=1)
    line = "runpreneur map: day %d, %.2f km (%.1f%% of the lap), %d countries, %d new runs" % (days, total_km, progress["lap_pct"], progress["countries_count"], added)
    if publish_it:
        sha = publish(progress); line += ", published %s" % sha
    print(line)
    return progress


def selftest():
    legs, scale = route_legs(); assert abs(sum(legs) - LAP_KM) < 1e-6 and 0.5 < scale < 2.0
    lat, lon, leg = point_along(0); assert (round(lat, 4), round(lon, 4)) == (52.2053, 0.1218) and leg.startswith("Cambridge")
    assert point_along(LAP_KM)[2] in ("home", "Reykjavik to Cambridge, UK")
    mid = point_along(LAP_KM / 2); assert -50 < mid[0] < 50, "half a lap lands in the southern hemisphere or the tropics"
    square = {"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]]}
    assert point_in_geom(2, 2, square) and not point_in_geom(5, 5, square) and not point_in_geom(12, 2, square), "ring with a hole"
    feats = [{"properties": {"NAME_EN": "Squareland"}, "geometry": square}]
    assert country_of(2, 2, feats, cache={}) == "Squareland" and country_of(50, 50, feats, cache={}) is None
    assert equivalent(17539) == "Cambridge to Tasmania" and equivalent(100) == "London to Paris" and equivalent(45000) == "once round the world"
    assert next_milestone(17539.77, 2290) == (18000, 2300)
    runs = [{"date": "2026-09-01", "km": 7.4, "latlng": [2, 2]}, {"date": "2019-01-01", "km": 42.2, "latlng": [2, 2]}, {"date": "2026-09-02", "km": 12.1, "latlng": None}]
    p = compute(runs, 17539.77, 76860.0, 2290, feats, today=dt.date(2026, 9, 8))
    assert p["runs_counted"] == 2 and p["countries"] == [{"name": "Squareland", "runs": 1}] and p["longest_run"]["km"] == 12.1, "pre-streak runs never count"
    assert p["lap_pct"] == 43.77 and p["equivalent"] == "Cambridge to Tasmania" and p["next_km_milestone"] == 18000 and p["date_of_next_day_milestone"] == "2026-09-18"
    assert p["marker"]["leg"] and len(p["route"]) == len(ROUTE) and p["avg_km_per_day"] == 7.66
    print(json.dumps({"checks": 12, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("mode")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "run": run(True)
    elif a.mode == "compute": print(json.dumps(run(False), indent=1)[:3000])
    else: raise SystemExit("usage: runpreneur_map.py run | compute | selftest")
