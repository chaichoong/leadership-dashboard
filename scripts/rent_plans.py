"""Payment plans: the rent check keeps every promise a tenant made (Cash Flow Voids step 3b).

Kevin approved the plan "Build as-is" on 4 Oct 2026 (brain: Decisions/2026-10-04 Rent agent - replies,
payment plans and benefit-cap claims). A tenant who is late replies; the agent drafts the answer, and when
a plan is agreed the card carries it above the email's headers:

    PLAN FOR: rec…               the tenancy the agent read
    PLAN: 2026-10-10 £100.00     one line per promise (agent_email_format.parse_plan)

Kevin approves the card and the carry-out sends the email. From the moment send-email.py stamps the card
SENT, the plan is AGREED, and this file checks it once a day inside scripts/rent-check.py:

  * Each promise is checked GRACE_DAYS after its date: everything promised up to then against the money
    matched to the tenancy since the plan was sent. Behind = MISSED: one RENT LATE task for the agent
    ("payment plan promise missed", back to the chase) and a dated line on the card. The plan is over.
  * Every promise kept by the last date + GRACE_DAYS = KEPT: a dated line on the card. The plan is over.
  * While a plan is agreed and on track, lane A raises no ordinary RENT LATE task for that tenancy: the
    plan is the chase.

Never a plan: a card that was not approved, was never sent (nothing reached the tenant), was settled on the
trial (TRIAL CHECKED) or approved before the trial ended (agent_email_format.trial_problem), or runs longer
than PLAN_MAX_DAYS (the rent check reads matched payments TX_LOOKBACK_DAYS back, so a longer plan would
count early payments as missing). A card that cannot be read is said on the row, never guessed.
"""
import re
from datetime import date, datetime, timedelta

import agent_email_format as aef

PLAN_PREFIX = "RENT PLAN: "      # a plan card the rent check or the agent names for the plan; on trial like RENT LATE
GRACE_DAYS = 2                    # the rent check's own TOLERANCE_DAYS: a payment can take this long to show
EARLY_PAY_DAYS = 5                # the rent check's own: a payment this early counts for the day it was promised
PLAN_MAX_DAYS = 70                # inside the rent check's 80-day look-back at matched payments
SENT_RE = re.compile(r"^\[(\d{1,2} \w{3} \d{4})(?: \d{2}:\d{2})? — send-email\] SENT: email to", re.M)
MISSED_MARK = "RENT PLAN MISSED: "
KEPT_MARK = "RENT PLAN KEPT: "
APPROVED = ("Approved as-is", "Approved with minor edits")
# Tasks fields by id (scripts/agent-dispatch.py AF).
F = {"name": "fldgFjGBw6bTKJFCD", "status": "fldx4qCw17UfrKpaN", "notes": "fldR7apBzSp3oxFxz",
     "output": "fldzswp8fx6PqpLQ5", "outcome": "fldrHBSr6qoUfaKuZ", "approvedAt": "fldr4Mvf2RzKvhZhi",
     "sentBy": "fld30Yw8SWYVp049g", "teamMember": "flduCtmQGpOA4eWaj"}
# Field NAMES in the formula: a rename is an Airtable error, never zero rows.
PLAN_FORMULA = "AND(FIND('PLAN FOR: rec', {Agent Output}&''), LEN({Approval Outcome}&'')>0)"


def _sel(v):
    return (v or {}).get("name", "") if isinstance(v, dict) else (v or "")


def sent_on(notes):
    """The day the card's email was first stamped SENT by send-email.py, or None."""
    days = []
    for m in SENT_RE.finditer(str(notes or "")):
        try:
            days.append(datetime.strptime(m.group(1), "%d %b %Y").date())
        except ValueError:
            continue
    return min(days) if days else None


def state(rec, payments, day):
    """Where one plan card stands today. Pure: no reads, no writes.

    {"id", "name", "tenancy", "state": "not-a-plan" | "bad" | "open" | "missed" | "kept" | "over", ...}"""
    f = rec.get("fields") or {}
    out = {"id": rec.get("id", ""), "name": f.get(F["name"], ""), "tenancy": "", "state": "not-a-plan", "why": ""}
    notes = str(f.get(F["notes"]) or "")
    outcome = _sel(f.get(F["outcome"]))
    if outcome not in APPROVED:
        out["why"] = "not approved"
        return out
    holders = list(f.get(F["sentBy"]) or []) + list(f.get(F["teamMember"]) or [])
    trial = aef.trial_problem(holders, out["name"], notes, f.get(F["approvedAt"]) or "")
    if aef.TRIAL_STAMP in notes or trial:
        out["why"] = "a trial card: nothing was sent to the tenant"
        return out
    start = sent_on(notes)
    if not start:
        out["why"] = "the email has not gone, so nothing is agreed yet"
        return out
    try:
        plan = aef.parse_plan(f.get(F["output"]) or "")
    except aef.EmailFormatError as exc:
        out.update(state="bad", why=f"its plan lines cannot be read: {exc}")
        return out
    if not plan:
        out["why"] = "no plan lines"
        return out
    out["tenancy"] = plan["tenancy"]
    promises = [(date.fromisoformat(d), amount) for d, amount in plan["promises"]]
    out["promises"] = [(d.isoformat(), amount) for d, amount in promises]
    if (promises[-1][0] - start).days > PLAN_MAX_DAYS:
        out.update(state="bad", why=f"it runs past {PLAN_MAX_DAYS} days from {start.isoformat()}, longer than the rent check can see")
        return out
    if MISSED_MARK in notes or KEPT_MARK in notes:
        out["state"] = "over"
        return out
    # Money counts from the plan's email, or from a few days before the first promise if Kevin approved it
    # late: a tenant who paid on his word before the email went has still kept it.
    start = min(start, promises[0][0] - timedelta(days=EARLY_PAY_DAYS))
    owed = 0.0
    for d, amount in promises:
        check = d + timedelta(days=GRACE_DAYS)
        if day < check:
            break
        owed += amount
        paid = sum(p["amount"] for p in payments if start <= p["day"] <= check)
        if paid + 0.005 < owed:
            out.update(state="missed", missedOn=d.isoformat(), owed=round(owed, 2), paid=round(paid, 2))
            return out
    else:
        out["state"] = "kept"
        return out
    out["state"] = "open"
    return out


def read_cards(rc):
    """Every approved card that carries a plan: the one Airtable read this file makes."""
    return rc.fetch_all(rc.T_TASKS, {"fields[]": list(F.values()), "filterByFormula": PLAN_FORMULA})


def read(rc, data, day):
    """Every plan card's state today: one read of the cards, the payments the rent check already holds.
    Returns {"plans": [...], "onTrack": {tenancy ids}, "failed": ""}."""
    out = {"plans": [], "onTrack": set(), "failed": ""}
    try:
        cards = read_cards(rc)
        pay = rc.payments_by_tenancy(data["tx"])
        live = {r["id"] for r in data["tenancies"]}
        for rec in cards:
            st = state(rec, [], day)
            if st["tenancy"]:
                if st["tenancy"] not in live and st["state"] not in ("not-a-plan", "over"):
                    st.update(state="bad", why=f"PLAN FOR names {st['tenancy']}, which is not a live tenancy")
                else:
                    st = state(rec, pay.get(st["tenancy"], []), day)
            out["plans"].append(st)
        out["onTrack"] = {p["tenancy"] for p in out["plans"] if p["state"] == "open"}
    except Exception as exc:                          # noqa: BLE001 — said on the row; lane A still runs
        out["failed"] = f"payment plans could not be read: {str(exc)[:200]}"
    return out


def missed_task(p, day, place):
    """The RENT LATE task a missed promise raises: back to the chase, with what was promised and paid."""
    key = f"{p['tenancy']}:plan:{p['id']}:{p['missedOn']}"
    when = date.fromisoformat(p["missedOn"]).strftime("%-d %b")
    return {"key": key, "tenancy": p["tenancy"], "tenants": [],
            "name": f"RENT LATE: {place}, payment plan promise of {when} missed",
            "description": "\n".join([
                f"A payment plan promise was missed, found by the daily rent check on {day.strftime('%-d %b %Y')}.",
                f"The plan: card {p['id']} ({p['name']}), agreed with the tenant by email.",
                f"By {when} plus {GRACE_DAYS} days he had promised £{p['owed']:,.2f} in all and £{p['paid']:,.2f} had reached us.",
                "",
                "Draft the next message, following your agent file: a plan that slips goes back to the chase.",
                "",
                "RENT CHECK KEY: " + key,
            ])}


def place_and_tenants(rc, data, tenancy):
    """The unit as a task name may carry it (never the surname stand-in), and the tenancy's tenants."""
    rec = next((r for r in data["tenancies"] if r["id"] == tenancy), None)
    f = (rec or {}).get("fields") or {}
    unit = rc.first(f.get(rc.TY["unitRef"])) or "(no unit linked)"
    return rc.lane_b_rules.place_name(unit), list(f.get(rc.TY["tenants"]) or [])


def append_note(rc, task_id, text):
    """One dated line on a plan card's Notes, read and written by field id in the same step. A card that
    reads back with no Notes is a failed read (an agreed plan always carries its SENT stamp): stop."""
    rec = rc.api("GET", f"{rc.T_TASKS}/{task_id}", params={"returnFieldsByFieldId": "true"})
    notes = str((rec.get("fields") or {}).get(F["notes"]) or "")
    if not notes.strip():
        raise RuntimeError(f"the Notes of card {task_id} read back empty, so nothing was written")
    stamp = datetime.now().strftime("%d %b %Y %H:%M")
    rc.api("PATCH", f"{rc.T_TASKS}/{task_id}", {"fields": {F["notes"]: f"{notes.rstrip()}\n\n[{stamp} — rent-check] {text}"}})


def act(rc, plans, data, day, writes, on):
    """Raise a RENT LATE task for each newly missed promise and mark each kept plan, on a real run with the
    agent switched on. Never stops the rent check: a failure is said on the row and in the exit code."""
    out = {"on": bool(on), "agreed": [], "missed": [], "kept": [], "problems": [], "failed": plans.get("failed", "")}
    for p in plans.get("plans", []):
        if p["state"] == "bad":
            out["problems"].append(f"card {p['id']}: {p['why']}")
        elif p["state"] == "open":
            out["agreed"].append(p["id"])
    if out["failed"] or not on or not writes:
        out["missed"] = [p["id"] for p in plans.get("plans", []) if p["state"] == "missed"]
        out["kept"] = [p["id"] for p in plans.get("plans", []) if p["state"] == "kept"]
        return out
    fails = []
    existing = None
    for p in plans["plans"]:
        try:
            if p["state"] == "missed":
                if existing is None:
                    existing = rc.read_task_state()["keys"]
                place, tenants = place_and_tenants(rc, data, p["tenancy"])
                item = missed_task(p, day, place)
                item["tenants"] = tenants
                if item["key"] not in existing:
                    rc.raise_task(item, day)
                note = (f"{MISSED_MARK}{p['missedOn']}: £{p['owed']:,.2f} promised by then, £{p['paid']:,.2f} received; "
                        f"the chase starts again ({day.isoformat()})")
                append_note(rc, p["id"], note)
                out["missed"].append(p["id"])
            elif p["state"] == "kept":
                append_note(rc, p["id"], f"{KEPT_MARK}every promise kept ({day.isoformat()})")
                out["kept"].append(p["id"])
        except Exception as exc:                      # noqa: BLE001 — said on the row
            fails.append(f"card {p['id']}: {str(exc)[:150]}")
    out["failed"] = "; ".join(fails)[:600]
    return out


def line(out):
    """The rent check row's line for payment plans."""
    check = (" Check: " + "; ".join(out["problems"]) + ".") if out.get("problems") else ""
    if out.get("failed"):
        return f"Payment plans FAILED: {out['failed']}{check}"
    bits = []
    if out["agreed"]:
        bits.append(f"{len(out['agreed'])} agreed and on track")
    if out["missed"]:
        bits.append(f"{len(out['missed'])} missed a promise" + ("" if out["on"] else " (not acted on: the agent is switched off)"))
    if out["kept"]:
        bits.append(f"{len(out['kept'])} kept in full")
    return ("Payment plans: " + ("; ".join(bits) if bits else "none agreed") + "." + check)
