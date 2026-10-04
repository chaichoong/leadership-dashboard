"""Payment plans: the rent check keeps every promise a tenant made (Cash Flow Voids step 3b).

Kevin approved the plan "Build as-is" on 4 Oct 2026 (brain: Decisions/2026-10-04 Rent agent - replies,
payment plans and benefit-cap claims). A tenant who is late replies; the agent drafts the answer, and when
a plan is agreed the card carries it above the email's headers:

    PLAN FOR: rec…               the tenancy the agent read
    PLAN: 2026-10-10 £100.00     one line per promise (agent_email_format.parse_plan); each amount
                                 includes any rent that falls due by then

Kevin approves the card and the carry-out sends the email. From the moment send-email.py stamps the card
SENT, the plan is AGREED, and this file checks it once a day inside scripts/rent-check.py:

  * At each promise's date plus GRACE_DAYS what is owed is the larger of everything promised by then and all
    the rent that fell due by that promise since the plan began (what the agent tells the tenant: each
    promise includes the rent due by its date), less any of that rent he had already paid early; what is
    paid is the money matched to the tenancy since the plan began, within PLAN_SLACK. Behind = MISSED: one RENT LATE task
    for the agent (back to the chase, carrying lane A's own stage key so lane A raises no twin) and a
    dated line on the card. The plan is over.
  * Every checkpoint met by the last promise + GRACE_DAYS = KEPT: a dated line on the card. Over.
  * While a plan runs (or misses today), lane A raises no ordinary RENT LATE task for that tenancy.
  * A miss is never decided on doubtful bank data: while the rent check calls the tenancy "cannot tell",
    or a bank feed is stale, the plan WAITS (still paused, nothing raised). A kept plan needs no doubt.

Never a plan: a card not approved, a trial card (TRIAL CHECKED, or approved before the trial ended), a card
whose PLAN FOR does not belong to it (neither its own Tenancies link nor the tenancy of the tenant who sent
it), a tenancy that is not live, or a plan longer than PLAN_MAX_DAYS (the rent check reads matched payments
80 days back). Two plans for one tenancy: the newest counts, the older is superseded. Each is said on the
row, never guessed: "unsent" is an approved plan whose email has not gone yet.
"""
import calendar
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import agent_email_format as aef

PLAN_PREFIX = "RENT PLAN: "      # a plan card the rent check or the agent names for the plan; on trial like RENT LATE
GRACE_DAYS = 2                    # the rent check's own TOLERANCE_DAYS: a payment can take this long to show
EARLY_PAY_DAYS = 5                # the rent check's own: a payment this early counts for the day it was promised
PLAN_MAX_DAYS = 70                # inside the rent check's 80-day look-back at matched payments
SENT_RE = re.compile(r"^\[(\d{1,2} \w{3} \d{4})(?: \d{2}:\d{2})? — send-email\] SENT: email to", re.M)
MISSED_MARK = "RENT PLAN MISSED: "
KEPT_MARK = "RENT PLAN KEPT: "
SUPERSEDED_MARK = "RENT PLAN SUPERSEDED: "
WAIT_LOUD_DAYS = 7                # a plan still waiting on bank data this long after the payment it waits on is a problem
PLAN_SLACK = 1.00                 # the rent check's own SHORT_SLACK: pounds under that still count as paid
LOOK_BACK_DAYS = 78               # the rent check reads matched payments 80 days back: older than this cannot be judged
LONDON = ZoneInfo("Europe/London")
APPROVED = ("Approved as-is", "Approved with minor edits")
LIVE_STATES = ("open", "waiting", "missed", "kept")
# Tasks fields by id (scripts/agent-dispatch.py AF; Tenancies and Inbound Sender as there).
F = {"name": "fldgFjGBw6bTKJFCD", "status": "fldx4qCw17UfrKpaN", "notes": "fldR7apBzSp3oxFxz",
     "output": "fldzswp8fx6PqpLQ5", "outcome": "fldrHBSr6qoUfaKuZ", "approvedAt": "fldr4Mvf2RzKvhZhi",
     "sentBy": "fld30Yw8SWYVp049g", "teamMember": "flduCtmQGpOA4eWaj", "tenancies": "fldmne4RYJU22ICub",
     "sender": "fldzf4xlbrQuktx0i"}
TENANT_CONTACT = {"email": "fldybEduFY3DWWTfT", "phone": "fldraHUkWfqo4olLF"}
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


def created_on(rec):
    """The London day the card was made (Airtable keeps UTC: 00:30 BST is the day before in UTC)."""
    try:
        made = datetime.fromisoformat(str(rec.get("createdTime") or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return made.astimezone(LONDON).date() if made.tzinfo else made.date()


def due_day_of(v):
    """The due day as a number 1 to 31, or 0 (a single select arrives as {"name": "15"})."""
    if isinstance(v, dict):
        v = v.get("name")
    try:
        n = int(str(v or "0").strip() or 0)
    except ValueError:
        return 0
    return n if 1 <= n <= 31 else 0


def rent_dues(start, until, due_day):
    """The rent due dates after `start`, up to and including `until` (a day the month lacks is its last)."""
    due_day = due_day_of(due_day)
    if not due_day:
        return []
    out, y, m = [], start.year, start.month
    while True:
        d = date(y, m, min(due_day, calendar.monthrange(y, m)[1]))
        if d > until:
            return out
        if d >= start:                             # rent due on the plan's first day is the plan's too
            out.append(d)
        y, m = (y, m + 1) if m < 12 else (y + 1, 1)


def state(rec, payments, day, tenancy=None, doubt=False, asof=None):
    """Where one plan card stands today. Pure: no reads, no writes. `tenancy` is {"rent", "dueDay"} when the
    rent check knows it; `doubt` is True while the rent check cannot tell about the tenancy's money; `asof`
    is the day this tenancy's bank feed runs to (a promise is judged as at that day, never the calendar's).

    {"id", "name", "tenancy", "state": "not-a-plan" | "unsent" | "bad" | "open" | "waiting" | "missed" |
    "kept" | "over", "why", ...}"""
    f = rec.get("fields") or {}
    out = {"id": rec.get("id", ""), "name": f.get(F["name"], ""), "tenancy": "", "state": "not-a-plan", "why": ""}
    notes = str(f.get(F["notes"]) or "")
    if _sel(f.get(F["outcome"])) not in APPROVED:
        out["why"] = "not approved"
        return out
    holders = list(f.get(F["sentBy"]) or []) + list(f.get(F["teamMember"]) or [])
    if aef.TRIAL_STAMP in notes or aef.trial_problem(holders, out["name"], notes, f.get(F["approvedAt"]) or ""):
        out["why"] = "a trial card: nothing was sent to the tenant"
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
    sent = sent_on(notes)
    if not sent:
        out.update(state="unsent", why="approved, but its email has not gone, so nothing is agreed yet")
        return out
    out["sent"], made = sent.isoformat(), created_on(rec)
    out["madeAt"] = str(rec.get("createdTime") or "")        # the exact moment: two cards a day are told apart
    if MISSED_MARK in notes or KEPT_MARK in notes or SUPERSEDED_MARK in notes:
        out["state"] = "over"
        return out
    # Money counts from the day AFTER the card was drafted: the agent wrote the promises against what he owed
    # then, having read that day's payments (and every promise falls after it), so money from the drafting day
    # or before is already netted off, and money after it (before the email went, or on his word while Kevin
    # was approving) is the plan's (reviews, 4-5 Oct 2026). A card with no creation time (an old record) counts
    # from its email, or a few days before its first promise.
    fallback = min(sent, promises[0][0] - timedelta(days=EARLY_PAY_DAYS))
    start = (made + timedelta(days=1)) if made else fallback
    # Rent falling due ON the drafting day is still the plan's to hold (the promises include it); money paid
    # that day or just before is credited to it below, never counted as plan money.
    rent_start = made or fallback
    out["start"] = start.isoformat()
    end = promises[-1][0]
    if (end - start).days > PLAN_MAX_DAYS:
        out.update(state="bad", why=f"it runs past {PLAN_MAX_DAYS} days from {start.isoformat()}, longer than the rent check can see")
        return out
    if (day - start).days > LOOK_BACK_DAYS:
        out.update(state="bad", why=f"it began {start.isoformat()}, before the payments the rent check reads, so it cannot be judged")
        return out
    rent = float((tenancy or {}).get("rent") or 0)
    if tenancy is not None and (rent <= 0 or not due_day_of(tenancy.get("dueDay"))):
        out.update(state="bad", why="the tenancy has no rent amount or due day, so the plan cannot be held to its rent")
        return out
    seen = min(asof, day) if asof else day
    early = timedelta(days=EARLY_PAY_DAYS)
    grace = timedelta(days=GRACE_DAYS)
    # What each rent inside the plan still needs: the rent, less whatever of it landed early, before the plan
    # began (Universal Credit often lands days ahead, and sometimes a little short).
    dues = {d: max(0.0, rent - sum(p["amount"] for p in payments if d - early <= p["day"] < start))
            for d in (rent_dues(rent_start, end, (tenancy or {}).get("dueDay")) if rent else [])}
    # The checkpoints: (the day it falls, what is owed by then). Each promise holds the promises and the rent
    # due by its date.
    checks = [(when, max(sum(a for d, a in promises if d <= when), sum(n for d, n in dues.items() if d <= when)))
              for when, _ in promises]
    # The first rent after the plan. The rent check credits money paid from 5 days before it to that rent, so
    # when that window reaches into the last promise's, one payment could count for both: the plan would read
    # KEPT on next month's money while lane A reads next month as paid with the plan's (reviews, 5 Oct 2026).
    # So the plan's last check moves to that rent's own date and holds the promises AND that rent: a tenant who
    # keeps his plan and pays his rent is kept; one who misses either is chased, which is right.
    nxt = [d for d in (rent_dues(end, end + timedelta(days=62), (tenancy or {}).get("dueDay")) if rent else []) if d > end][:1]
    if nxt and nxt[0] - early <= end + grace:
        checks[-1] = (nxt[0], checks[-1][1] + rent)

    def waiting(check):
        late = (day - (check - grace)).days
        stuck = late > WAIT_LOUD_DAYS
        out.update(state="waiting", stuck=stuck,
                   why=(f"still cannot be judged {late} days after a payment it was owed, because the rent check cannot tell "
                        "about this tenancy's money" if stuck else "the rent check cannot tell about this tenancy's money today"))
        return out

    for when, owed in checks:
        check = when + grace
        paid = sum(p["amount"] for p in payments if start <= p["day"] <= check)
        if paid + PLAN_SLACK >= owed:
            continue                               # met, whatever the feed: money seen is money in
        if seen < check:
            # The bank has not reached this checkpoint. With doubt about the feed and the day already past it,
            # that is waiting, and it grows loud: a stale feed must never read as "on track" for weeks.
            if doubt and check <= day:
                return waiting(check)
            out["state"] = "open"
            return out
        if doubt:
            return waiting(check)
        out.update(state="missed", missedOn=when.isoformat(), owed=round(owed, 2), paid=round(paid, 2))
        return out
    # Every check met. KEPT only once the last one's day has passed: a plan paid ahead stays open (and lane A
    # stays paused) for its whole length, so rent he prepaid inside it is never chased mid-plan.
    out["state"] = "kept" if day >= checks[-1][0] + grace else "open"
    return out


def read_cards(rc):
    """Every approved card that carries a plan: the one task read this file makes."""
    return rc.fetch_all(rc.T_TASKS, {"fields[]": list(F.values()), "filterByFormula": PLAN_FORMULA})


def read_contacts(rc, tenant_ids):
    """{tenant id: {sender keys}} for the tenants named: email and mobile, as the reply routing spells them."""
    ids = sorted(t for t in tenant_ids if re.fullmatch(r"rec\w+", t))
    out = {}
    for i in range(0, len(ids), 50):
        formula = "OR(" + ",".join(f"RECORD_ID()='{t}'" for t in ids[i:i + 50]) + ")"
        for rec in rc.fetch_all(rc.T_TENANTS, {"fields[]": list(TENANT_CONTACT.values()), "filterByFormula": formula}):
            f = rec.get("fields") or {}
            out[rec["id"]] = {aef.sender_key(f.get(v)) for v in TENANT_CONTACT.values() if f.get(v)}
    return out


def chase_stop(rc, data, tid):
    """Why lane A would never chase this tenancy (and so neither does a missed promise), or ""."""
    f = next((r.get("fields") or {} for r in data["tenancies"] if r["id"] == tid), {})
    tenants = {r["id"]: r.get("fields") or {} for r in data.get("tenants") or []}
    if rc.sel(f.get(rc.TY["payStatus"])) not in (rc.IN_PAYMENT, rc.CFV):
        return "its payment status is not one the rent check chases"
    if rc.tenant_type(f, tenants) == rc.AGENT_MANAGED:
        return "it is agent-managed"
    if set(data.get("noChase") or ()) & set(f.get(rc.TY["tenants"]) or []):
        return "the tenant is on the do-not-chase list"
    return ""


def read(rc, data, day, res, now=None):
    """Every plan card's state today, from one read of the cards, the payments and bank feeds the rent check
    already holds, and its verdict per tenancy. Returns {"plans": [...], "onTrack": {tenancy ids}, "failed": ""}."""
    out = {"plans": [], "onTrack": set(), "failed": ""}
    try:
        cards = read_cards(rc)
        pay = rc.payments_by_tenancy(data["tx"])
        lanes = res.get("lanes") or {}
        # Each tenancy's own bank feed, as the rent check judges it: the day it runs to, and its faults.
        feed = rc.feed_state(data, pay, now) if now is not None else None
        tys = {r["id"]: r.get("fields") or {} for r in data["tenancies"]}
        first = [(rec, state(rec, [], day)) for rec in cards]
        wanted = {st["tenancy"] for _, st in first if st["tenancy"] in tys}
        contacts = read_contacts(rc, {t for tid in wanted for t in (tys[tid].get(rc.TY["tenants"]) or [])}) if wanted else {}
        for rec, st in first:
            tid = st["tenancy"]
            if st["state"] in ("not-a-plan", "bad", "over") or not tid:
                out["plans"].append(st)
                continue
            if tid not in lanes:                      # the rent check judged only live tenancies
                st.update(state="bad", why=f"PLAN FOR names {tid}, which is not a live tenancy")
                st.pop("sent", None)                  # a card this check rejects never outranks a good plan
                out["plans"].append(st)
                continue
            f = rec.get("fields") or {}
            own = tid in (f.get(F["tenancies"]) or [])
            senders = {k for t in (tys[tid].get(rc.TY["tenants"]) or []) for k in contacts.get(t, set())}
            if not own and aef.sender_key(f.get(F["sender"])) not in senders:
                st.update(state="bad", why=f"PLAN FOR names {tid}, but the card is not that tenancy's and was not sent by its tenant")
                st.pop("sent", None)
                out["plans"].append(st)
                continue
            ty = tys[tid]
            asof, faults = rc.bank_view(feed, pay.get(tid, [])) if feed else (None, [])
            st = state(rec, pay.get(tid, []), day,
                       {"rent": ty.get(rc.TY["rent"]), "dueDay": ty.get(rc.TY["dueDay"])},
                       doubt=bool(faults) or (feed is not None and asof is None) or lanes.get(tid) == "unknown",
                       asof=asof)
            if st["state"] == "missed":
                st["noChase"] = chase_stop(rc, data, tid)
            out["plans"].append(st)
        # Two plans for one tenancy: the newest SENT counts, for good. One already over still outranks an older
        # card, so an older plan never wakes when the newer one ends (review, 4 Oct 2026).
        newest = {}
        for p in out["plans"]:
            if p.get("sent") and (p["sent"], p.get("madeAt", ""), p["id"]) >= newest.get(p["tenancy"], ("", "", "")):
                newest[p["tenancy"]] = (p["sent"], p.get("madeAt", ""), p["id"])
        for p in out["plans"]:
            if p["state"] in LIVE_STATES and newest[p["tenancy"]][2] != p["id"]:
                p.update(state="superseded", by=newest[p["tenancy"]][2],
                         why=f"card {newest[p['tenancy']][2]} is the newer plan for this tenancy")
        out["onTrack"] = {p["tenancy"] for p in out["plans"] if p["state"] in ("open", "waiting", "missed")}
    except Exception as exc:                          # noqa: BLE001 — said on the row; lane A still runs
        out["failed"] = f"payment plans could not be read: {str(exc)[:200]}"
    return out


def missed_task(p, day, place):
    """The RENT LATE task a missed promise raises: back to the chase, with what was owed and paid."""
    key = f"{p['tenancy']}:plan:{p['id']}:{p['missedOn']}"
    when = date.fromisoformat(p["missedOn"]).strftime("%-d %b")
    return {"key": key, "tenancy": p["tenancy"], "tenants": [], "alsoKeys": [],
            "name": f"RENT LATE: {place}, payment plan promise of {when} missed",
            "description": "\n".join([
                f"A payment plan promise was missed, found by the daily rent check on {day.strftime('%-d %b %Y')}.",
                f"The plan: card {p['id']} ({p['name']}), agreed with the tenant by email.",
                f"By {when} plus {GRACE_DAYS} days £{p['owed']:,.2f} was owed under the plan (the promises, or the rent "
                f"that fell due, whichever is more) and £{p['paid']:,.2f} had reached us.",
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


def act(rc, plans, data, day, writes, on, res):
    """Raise a RENT LATE task for each newly missed promise and mark each kept plan, on a real run with the
    agent switched on. Never stops the rent check: a failure is said on the row and in the exit code."""
    out = {"on": bool(on), "agreed": [], "waiting": [], "unsent": [], "missed": [], "kept": [], "problems": [],
           "stuck": False, "failed": plans.get("failed", "")}
    for p in plans.get("plans", []):
        if p["state"] == "bad" or (p["state"] == "waiting" and p.get("stuck")):
            out["problems"].append(f"card {p['id']}: {p['why']}")
            out["stuck"] = out["stuck"] or p["state"] == "waiting"
        if p["state"] in ("open", "waiting", "unsent"):
            out[{"open": "agreed", "waiting": "waiting", "unsent": "unsent"}[p["state"]]].append(p["id"])
    if out["failed"] or not on or not writes:
        out["missed"] = [p["id"] for p in plans.get("plans", []) if p["state"] == "missed"]
        out["kept"] = [p["id"] for p in plans.get("plans", []) if p["state"] == "kept"]
        return out
    fails = []
    existing = None
    for p in plans["plans"]:
        try:
            if p["state"] == "superseded":
                append_note(rc, p["id"], f"{SUPERSEDED_MARK}card {p['by']} replaced this plan ({day.isoformat()})")
            elif p["state"] == "missed" and p.get("noChase"):
                append_note(rc, p["id"], f"{MISSED_MARK}{p['missedOn']}: £{p['owed']:,.2f} owed by then, £{p['paid']:,.2f} "
                                         f"received; not chased, because {p['noChase']} ({day.isoformat()})")
                out["missed"].append(p["id"])
            elif p["state"] == "missed":
                if existing is None:
                    existing = rc.read_task_state()["keys"]
                place, tenants = place_and_tenants(rc, data, p["tenancy"])
                item = missed_task(p, day, place)
                item["tenants"] = tenants
                # Lane A's own next stage for the cycle he owes rides on this task, so lane A's next run
                # sees that stage raised and never adds a twin chase for the same money.
                row = next((r for r in res.get("tenancies") or [] if r["id"] == p["tenancy"] and r.get("owed")), None)
                if row:
                    # The next stage up, whatever its gap: this task IS that stage, so lane A never raises a twin.
                    cycle = f"{row['id']}:{row['owed']}"
                    raised = [n for n in rc.STAGES if f"{cycle}:{n}" in existing]
                    stage = max(raised) + 1 if raised else 1
                    if stage <= max(rc.STAGES):
                        item["alsoKeys"].append(f"{cycle}:{stage}")
                if item["key"] not in existing:
                    rc.raise_task(item, day)
                note = (f"{MISSED_MARK}{p['missedOn']}: £{p['owed']:,.2f} owed by then, £{p['paid']:,.2f} received; "
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
    if out.get("waiting"):
        bits.append(f"{len(out['waiting'])} waiting on bank data before a promise can be judged")
    if out.get("unsent"):
        bits.append(f"{len(out['unsent'])} approved with the email not gone yet")
    if out["missed"]:
        bits.append(f"{len(out['missed'])} missed a promise" + ("" if out["on"] else " (not acted on: the agent is switched off)"))
    if out["kept"]:
        bits.append(f"{len(out['kept'])} kept in full")
    return ("Payment plans: " + ("; ".join(bits) if bits else "none agreed") + "." + check)
