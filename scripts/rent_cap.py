"""Benefit-cap claims: lane C of the Cash Flow Voids agent (Kevin approved "Build as-is" on 4 Oct 2026; brain:
Decisions/2026-10-04 Rent agent - replies, payment plans and benefit-cap claims).

A Universal Credit tenant whose housing money is cut by the benefit cap pays short. The council's Crisis and
Resilience Fund Housing Payment (once called a Discretionary Housing Payment) can make up the gap, paid to the
landlord. This file runs once a day inside scripts/rent-check.py and keeps each tenancy's claim moving:

1. RENT CAP task, the agent's, ON TRIAL like RENT LATE (agent_email_format.TRIAL_TASK_MARKS). Raised for a
   Universal Credit tenancy the check calls "paid short" on trusted bank data, once per short rent cycle, and
   never while a cap task for the tenancy is still open, a claim is under way or an award is in force. The
   agent drafts the email asking the tenant to fill in the details form (scripts/tenant-link.py makes the link)
   and to sign the letter of authority. A renewal RENT CAP task is raised from RENEW_DAYS before a recorded award
   ends (later if a chase, a plan or an open cap task holds it back, until a newer case takes over). One ask at a
   time: never two cap tasks open at once, and no short-cycle task within a month of a renewal task.
2. RENT CLAIM card, Kevin's, runs for real (Kevin, 4 Oct 2026: he fills in the council's form himself). Raised
   once the tenancy has a cap case, the tenant saved the form recently, their Authority Signed is ticked and every
   answer the council needs is on their record. It lists every answer and where it came from, the evidence and
   the council's form. Approve = he sent it: marked SENT and closed. Request changes = withdrawn, raised again
   CHANGES_WAIT_DAYS later or as soon as the tenant saves the form again. Reject ends the case.
3. RENT CLAIM DECISION card, Kevin's: DECISION_WAIT_DAYS after the claim went, asking for the council's answer.
   His note is read in three exact forms only: "AWARD UNTIL: 31 Mar 2027" records the award, "ONE-OFF" a payment
   made once, "REFUSED" a refusal; any other note is asked again the next day. Request changes means no answer
   yet: asked again REASK_DAYS later, at most DECISION_ASKS such times. Reject stops asking.

Kevin's two cards are shut to every agent door (agent_email_format.KEVIN_CARDS): never an agent's work, never
sent, never settled as a trial check. This file reads his verdict and closes each card itself, writing one mark
line so a verdict is acted on once. Nothing here sends anything to a tenant or a council.

Every key rides in a task's Notes:
  RENT CHECK KEY: cap:<tenancy>:<cycle day>            a short cycle's RENT CAP task (the trial mark)
  RENT CHECK KEY: cap:<tenancy>:renew:<award end>      a renewal RENT CAP task
  RENT CLAIM KEY: claim:<tenancy>:<case>:<n>            the n-th claim card for a case (case = the cap key's tail)
  RENT CLAIM KEY: decision:<tenancy>:<case>:<n>         the n-th decision card for that case's claim
"""
import argparse
import os
import re
import tempfile
from datetime import date, datetime, timedelta, timezone

import agent_email_format as aef

CAP_PREFIX = "RENT CAP: "
CLAIM_PREFIX, DECISION_PREFIX = "RENT CLAIM: ", "RENT CLAIM DECISION: "
CAP_KEY_MARK = "RENT CHECK KEY: "          # the lane's trial mark (rent-check.py KEY_MARK), with a cap: key
CLAIM_KEY_MARK = "RENT CLAIM KEY: "        # agent_email_format.KEVIN_CARDS: the doors-shut mark
SENT_MARK = "RENT CLAIM SENT: "            # Kevin approved the claim card: he sent the council's form
WITHDRAWN_MARK = "RENT CLAIM WITHDRAWN: "  # Request changes, or a card that never reached his queue
ENDED_MARK = "RENT CLAIM ENDED: "          # Reject, or closed by hand with no verdict: this case gets no claim
AWARD_MARK = "RENT CLAIM AWARD: "          # the council's answer from his note: an end date, or REFUSED
NO_ANSWER_MARK = "RENT CLAIM NO ANSWER: "  # no answer yet (Request changes, or a note with no readable answer)
STOPPED_MARK = "RENT CLAIM STOPPED: "      # Reject on a decision card, or closed by hand: no more asking
CLAIM_FOR_MARK = "RENT CLAIM FOR: "        # the claimant's tenant record, on the claim card (never a mark of a verdict)
PAYEE_MARK = "RENT CLAIM PAYEE: "          # who the claim asked the council to pay: tenant or landlord (read by renewals)
DONE_MARKS = (SENT_MARK, WITHDRAWN_MARK, ENDED_MARK, AWARD_MARK, NO_ANSWER_MARK, STOPPED_MARK)
REFUSED, ONE_OFF = "REFUSED", "ONE-OFF"
SUBMITTED_RE = re.compile(r"^\[[^\]\n]*— agent-dispatch\] SUBMITTED", re.M)

CASE_DAYS = 90              # a cap case this old with no claim is over: the next short cycle starts a fresh one
FORM_BEFORE_DAYS = 60       # a short case accepts a form the tenant saved up to this long before it began
CHANGES_WAIT_DAYS = 7       # a claim card sent back comes again this much later, or when the tenant saves the form again
DECISION_WAIT_DAYS = 21     # Hyndburn aims for two weeks, Fylde "several weeks": first ask three weeks on
REASK_DAYS = 14             # no answer yet: asked again this much later
DECISION_ASKS = 6           # then asking stops, said on the row
RENEW_DAYS = 30             # Kevin's ruling: a renewal reminder a month before the award ends
# A CAPPED TENANT WHO PAYS IN FULL (Kevin, 5 Oct 2026): "If the tenant has had a reduction and it's come off their
# money, then we put the application in place for them so they get the top-up." No short payment raises the case:
# the tenant's own details form does, when it answers the benefit cap question "None (capped)" and was saved in the
# last FULL_FRESH_DAYS. The award is paid to the tenant ("full:<day saved>" case); a short payer's comes to us.
CAPPED = "None (capped)"
FULL_FRESH_DAYS = 60
AWARD_MAX_DAYS = 800        # an end date further off than this is read as a typing slip, not an award
APPROVED = ("Approved as-is", "Approved with minor edits")
CLOSED = ("Completed", "Cancelled")
PARKED = ("Upcoming",)

# Tasks fields by id (scripts/agent-dispatch.py AF).
F = {"name": "fldgFjGBw6bTKJFCD", "status": "fldx4qCw17UfrKpaN", "notes": "fldR7apBzSp3oxFxz", "description": "fldRGhBQViKZKtkQ6",
     "outcome": "fldrHBSr6qoUfaKuZ", "approvedAt": "fldr4Mvf2RzKvhZhi", "feedback": "fldtI7SJI4gEohHD1",
     "tenancies": "fldmne4RYJU22ICub", "someDay": "fldmhkeRaDkiL3Ga4", "completion": "fldFOi1SwEKuJRmdN"}
# Tenants: what the claim needs (workers/property-manager/fields.mjs GP.tenant, read live 4-5 Oct 2026).
TN = {"name": "fldxBKW7QnujSDWqA", "dob": "fldv7FKsqXYswyCFE", "ni": "fld1rHf1qZ60qK95l", "phone": "fldraHUkWfqo4olLF",
      "email": "fldybEduFY3DWWTfT", "household": "fldjrOSBkhWeFJvVU", "otherAdults": "fldeKCUmwpmWv7pad",
      "cap": "fldOOi3d1P4vDedm6", "ucPayDay": "fldjTG9xdCLpbwOwC", "ctAccount": "fldlquVIzyesTrI1d",
      "weeklyIncome": "fldbiAag5eoEW23e0", "weeklySpending": "fldlZr8tUocCYzGPT", "otherBenefits": "fldwCMFvYqbFXXzOO",
      "saved": "fldc7XMcQcYY6C2Xa", "authority": "fldHPe9YQ6GmlrKBt", "documents": "flduPLQdNRKBmsSmr"}
# The answers a council cannot decide a claim without: no card is raised while one is blank.
NEEDED = ("name", "dob", "ni", "weeklyIncome", "weeklySpending")
# Kevin, 6 Oct 2026: "They all live on their own." The tenant's form no longer asks who lives with them or about
# other adults, so a blank household on a one-tenant tenancy reads as single and the card says where that came
# from. Two tenants on one tenancy do not live on their own: there the household must be on the record (we fill it
# in on the Growth Plan form) before a claim is raised.
LIVES_ALONE = "Kevin's ruling, 6 Oct 2026: every tenant lives on their own; not asked on the form"
# Each council's claim form, by postcode district (researched 4 Oct 2026; all three run the CRF Housing Payment).
COUNCILS = {
    "CB9": ("West Suffolk Council, through Anglia Revenues Partnership",
            "https://www.angliarevenues.gov.uk/westsuffolk/ (Apply for CRF Housing Payment)", ""),
    "FY8": ("Fylde Council",
            "https://revenuesandbenefits-forms.cloud.mrisoftware.com/LocalWelfareAssistance/Home/Redirector/Index/"
            "?id=4B5B7C9C-96DA-4B3C-A720-77731F3DC748&mod=OA&casetype=DIS&formname=DHPFULL",
            "After the form, Fylde asks for a rent statement and the last two months' bank statements by email to "
            "crf.housingpayments@blackpool.gov.uk."),
    "BB5": ("Hyndburn Borough Council", "https://www.hyndburnbc.gov.uk/services/crfhpcts/",
            "Hyndburn asks a helper to sign its own declaration that the tenant gave permission."),
}
_CAP_KEY_RE = re.compile(r"^cap:(rec[A-Za-z0-9]{14}):(\d{4}-\d{2}-\d{2}|renew:\d{4}-\d{2}-\d{2})$")
_CARD_KEY_RE = re.compile(r"^(claim|decision):(rec[A-Za-z0-9]{14}):(\d{4}-\d{2}-\d{2}|renew:\d{4}-\d{2}-\d{2}|full:\d{4}-\d{2}-\d{2}):(\d+)$")
SHORT_RE = re.compile(r"arrived short: £([\d,]+\.\d{2}) of £([\d,]+\.\d{2})")
_MONTHS = {m: i for i, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov",
                                       "dec"), 1)}


def _sel(v):
    return (v or {}).get("name", "") if isinstance(v, dict) else (v or "")


def _day(v):
    try:
        return date.fromisoformat(str(v or "")[:10])
    except ValueError:
        return None


def _stamped(rec):
    try:
        return datetime.fromisoformat(str(rec.get("createdTime") or "").replace("Z", "+00:00")).date()
    except ValueError:
        return None


def key_of(text, mark):
    """The key on the first line of `text` carrying `mark`, or ''."""
    for line in str(text or "").splitlines():
        if mark in line:
            return line.split(mark, 1)[1].strip()
    return ""


def mark_line(notes, mark):
    """The text after the newest line opening with one of this file's marks, or None."""
    found = None
    for line in str(notes or "").splitlines():
        if line.strip().startswith(mark):
            found = line.strip()[len(mark):].strip()
    return found


def card_line(c, mark):
    """A card's line read from its Notes, else its Description: Notes are trimmed from the front once very long."""
    found = mark_line(c.get("notes"), mark)
    return found if found is not None else mark_line(c.get("description"), mark)


ANSWER_FORMS = "AWARD UNTIL: 31 Mar 2027, ONE-OFF or REFUSED"


def _one_day(text):
    """The single date in `text` (2027-03-31, 31/03/2027 or 31 Mar 2027), or (None, why)."""
    found = []
    for y, m, d in re.findall(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", text):
        found.append((int(y), int(m), int(d)))
    for d, m, y in re.findall(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", text):
        found.append((int(y), int(m), int(d)))
    for d, mon, y in re.findall(r"^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$", text):
        if mon[:3].lower() in _MONTHS:
            found.append((int(y), _MONTHS[mon[:3].lower()], int(d)))
    if len(found) != 1:
        return None, "the date after AWARD UNTIL could not be read; write it as 31 Mar 2027"
    y, m, d = found[0]
    try:
        return date(y, m, d), ""
    except ValueError:
        return None, f"the date {d}/{m}/{y} is not a real day"


def award_from(words, said_on):
    """The council's answer in Kevin's note, in one of three exact forms (case and a closing full stop do not
    matter): "AWARD UNTIL: <date>" -> ("award", end day); "ONE-OFF" -> ("one-off", None), paid once, nothing to
    renew; "REFUSED" -> ("refused", None). Anything else is (None, why) and he is asked again: a note in his own
    words is never guessed at ("no award letter yet", "award pending, decision by 20 Nov" read wrong either way
    would close a claim the council still has, or set a renewal for an award that does not exist)."""
    text = " ".join(str(words or "").split()).strip().rstrip(".").strip()
    low = text.lower()
    if low == "refused":
        return "refused", None
    if low in ("one-off", "one off", "oneoff"):
        return "one-off", None
    m = re.fullmatch(r"award until:?\s*(.+)", text, re.I)
    if not m:
        return None, f"write exactly one of {ANSWER_FORMS}"
    end, why = _one_day(m.group(1).strip())
    if end is None:
        return None, why
    if end < said_on - timedelta(days=AWARD_MAX_DAYS) or end > said_on + timedelta(days=AWARD_MAX_DAYS):
        return None, f"{end.isoformat()} is too far from today to be the award's end"
    return "award", end


def card_view(rec, mark):
    """One task as this file reads it. `mark` is the key mark it is found by."""
    f = rec.get("fields") or {}
    notes = str(f.get(F["notes"]) or "")
    approved = str(f.get(F["approvedAt"]) or "")
    # The key is in the Description too: Notes are trimmed from the front once they grow very long.
    return {"id": rec["id"], "name": str(f.get(F["name"]) or ""), "status": _sel(f.get(F["status"])),
            "description": str(f.get(F["description"]) or ""),
            "outcome": str(f.get(F["outcome"]) or ""), "feedback": str(f.get(F["feedback"]) or ""), "notes": notes,
            "approvedOn": _day(approved) if approved else None, "someDay": bool(f.get(F["someDay"])),
            "created": _stamped(rec), "key": key_of(notes + "\n" + str(f.get(F["description"]) or ""), mark),
            "submitted": bool(SUBMITTED_RE.search(notes)),
            "tenancies": list(f.get(F["tenancies"]) or [])}


def verdict(card, day):
    """What this file does with Kevin's card today: (action, detail). Read once: a card carrying one of the
    DONE_MARKS has been acted on. A claim card: "sent", "withdraw", "end", "wait", "parked", "lost". A decision
    card: "award", "refused", "no-answer", "stop", "wait", "parked", "lost"."""
    claim = card["kind"] == "claim"
    for m in DONE_MARKS:
        if mark_line(card["notes"], m) is not None:
            return "done", m
    out = card["outcome"]
    if out in APPROVED:
        if claim:
            return "sent", card["approvedOn"] or day
        what, end = award_from(card["feedback"], card["approvedOn"] or day)
        if what == "award":
            return "award", end
        if what in ("refused", "one-off"):
            return what, None
        return "no-answer", f"your note had no answer the rent check could read ({end})"
    if out == "Changes requested":
        return ("withdraw", " ".join(card["feedback"].split())[:300]) if claim else ("no-answer", "no answer yet")
    if out.startswith("Rejected"):
        return ("end", "Kevin rejected the claim card") if claim else ("stop", "Kevin rejected the question")
    if card["status"] == "Approval":
        return "wait", None
    if card["status"] in CLOSED:
        return ("end", "closed by hand with no verdict") if claim else ("stop", "closed by hand with no verdict")
    if card["someDay"] or card["status"] in PARKED or card["submitted"]:
        # In his queue once, then moved out by him (or parked for some day): his to bring back.
        return "parked", None
    return "lost", "it never reached Kevin's queue"


def read(rc):
    """Every cap task and every card of Kevin's, grouped by tenancy. Formulas use field NAMES: a rename is an
    Airtable error, never zero rows. Returns {tenancy: {"caps": [...], "claims": [...], "decisions": [...]}}."""
    caps = rc.fetch_all(rc.T_TASKS, {"fields[]": list(F.values()), "filterByFormula":
                                     f"OR(LEFT({{Task Name}}, {len(CAP_PREFIX)})='{CAP_PREFIX}', "
                                     f"FIND('{CAP_KEY_MARK}cap:', {{Notes}}&''), FIND('{CAP_KEY_MARK}cap:', {{Description}}&''))"})
    cards = rc.fetch_all(rc.T_TASKS, {"fields[]": list(F.values()), "filterByFormula":
                                      f"OR(LEFT({{Task Name}}, 10)='RENT CLAIM', FIND('{CLAIM_KEY_MARK}', {{Notes}}&''), "
                                      f"FIND('{CLAIM_KEY_MARK}', {{Description}}&''))"})
    out, problems = {}, []
    for rec in caps:
        c = card_view(rec, CAP_KEY_MARK + "cap:")
        m = _CAP_KEY_RE.match("cap:" + c["key"]) if c["key"] else None
        if not m:
            problems.append(f"task {c['id']} is named as a benefit-cap task but carries no readable cap key")
            continue
        c.update(kind="cap", tenancy=m.group(1), case=m.group(2))
        out.setdefault(c["tenancy"], {"caps": [], "claims": [], "decisions": []})["caps"].append(c)
    for rec in cards:
        c = card_view(rec, CLAIM_KEY_MARK)
        m = _CARD_KEY_RE.match(c["key"]) if c["key"] else None
        if not m:
            problems.append(f"card {c['id']} is named as a claim card but carries no readable claim key")
            continue
        c.update(kind=m.group(1), tenancy=m.group(2), case=m.group(3), n=int(m.group(4)))
        out.setdefault(c["tenancy"], {"caps": [], "claims": [], "decisions": []})[m.group(1) + "s"].append(c)
    for t in out.values():
        for k in t:
            t[k].sort(key=lambda c: (c["created"] or date.min, c.get("n", 0), c["id"]))
    return out, problems


def read_busy(rc):
    """The tenancies a late-rent chase is open for (a RENT LATE task not closed): lane C waits while one runs. The
    formula uses field NAMES: a rename is an Airtable error, never zero rows."""
    rows = rc.fetch_all(rc.T_TASKS, {"fields[]": [F["tenancies"]], "filterByFormula":
                                     "AND(LEFT({Task Name}, 11)='RENT LATE: ', NOT({Status}='Completed'), "
                                     "NOT({Status}='Cancelled'))"})
    return {t for r in rows for t in ((r.get("fields") or {}).get(F["tenancies"]) or [])}


def read_capped(rc, day):
    """The tenants whose own details form, saved in the last FULL_FRESH_DAYS, answers the benefit cap question
    "None (capped)": their tenancies are planned even with no short payment. Field NAMES in the formula: a rename
    is an Airtable error, never zero rows."""
    if CAPPED not in rc.field_choices(rc.T_TENANTS, TN["cap"]):
        raise RuntimeError(f"control failed: the Benefit Cap Exemption field has no \"{CAPPED}\" choice, so nobody "
                           "could ever read as capped")
    since = (day - timedelta(days=FULL_FRESH_DAYS)).isoformat()
    rows = rc.fetch_all(rc.T_TENANTS, {"fields[]": [TN["saved"]], "filterByFormula":
                                       f"AND(IS_AFTER({{Tenant Form Last Saved}}, '{since}'), "
                                       f"{{Benefit Cap Exemption}}='{CAPPED}')"})
    return {r["id"] for r in rows}


def read_tenants(rc, ids):
    """{tenant id: fields} for the claim's answers, by field id."""
    ids = sorted(i for i in ids if re.fullmatch(r"rec[A-Za-z0-9]{14}", i))
    got = {}
    for i in range(0, len(ids), 50):
        formula = "OR(" + ",".join(f"RECORD_ID()='{t}'" for t in ids[i:i + 50]) + ")"
        for rec in rc.fetch_all(rc.T_TENANTS, {"fields[]": list(TN.values()), "filterByFormula": formula}):
            got[rec["id"]] = rec.get("fields") or {}
    return got


def claimant(tenant_ids, tenants):
    """The linked tenant who saved the details form most recently, as {id, fields, saved (date)}, or None."""
    best = None
    for tid in tenant_ids:
        f = tenants.get(tid) or {}
        saved = _day(f.get(TN["saved"]))
        if saved and (best is None or saved > best["saved"]):
            best = {"id": tid, "fields": f, "saved": saved}
    return best


ACT_MARK = {"sent": SENT_MARK, "withdraw": WITHDRAWN_MARK, "lost": WITHDRAWN_MARK, "end": ENDED_MARK,
            "award": AWARD_MARK, "refused": AWARD_MARK, "one-off": AWARD_MARK, "no-answer": NO_ANSWER_MARK,
            "stop": STOPPED_MARK}


def real_ask(d):
    """A "no answer yet" from the council, not a note the rent check could not read: only these count toward
    DECISION_ASKS, so badly worded notes are asked again without ever closing the claim (review, 5 Oct 2026)."""
    said = mark_line(d["notes"], NO_ANSWER_MARK) or (str(d.get("detail") or "") if d.get("do") == "no-answer" else "")
    return has(d, NO_ANSWER_MARK) and "your note" not in said


def has(c, mark):
    """The card carries this mark, or will once today's write for Kevin's verdict is made."""
    return mark_line(c["notes"], mark) is not None or ACT_MARK.get(c.get("do")) == mark


def marked_on(c, mark, day):
    """The day a mark line was written (each opens with its ISO day), or today for today's write."""
    line = mark_line(c["notes"], mark)
    return (_day(line[:10]) if line else None) or day


def plan(tid, view, row, tenancy, tenants, day, no_chase=False, busy=False, unlinked=False, uc=False):
    """What lane C does today for one tenancy. Pure. `view` is read()'s entry for it (or empty lists), `row` the
    rent check's verdict on it (None when it is not live), `tenancy` its Tenancies fields by id (rent-check TY),
    `tenants` {tenant id: fields}. Returns {"stage": words, "acts": [cards to write], "raise": [...],
    "problems": [...]}."""
    caps, claims, decisions = view.get("caps", []), view.get("claims", []), view.get("decisions", [])
    out = {"tenancy": tid, "stage": "", "acts": [], "raise": [], "problems": []}
    for c in claims + decisions:
        c["do"], c["detail"] = verdict(c, day)
        if c["do"] not in ("done", "wait", "parked"):
            out["acts"].append(c)

    # An award that "ends" before its claim went in is a typing slip ("31 Mar 2026" for 2027): asked again.
    for d in decisions:
        went_ = next((marked_on(c, SENT_MARK, day) if c["do"] != "sent" else c["detail"]
                      for c in claims if c["case"] == d["case"] and has(c, SENT_MARK)), None)
        if d["do"] == "award" and went_ and d["detail"] < went_:
            d["do"], d["detail"] = "no-answer", (f"your note had no answer the rent check could read (the end date "
                                                 f"{d['detail'].isoformat()} is before the claim went in; a payment "
                                                 "made once is ONE-OFF)")

    # The award: the newest answer recorded on a decision card (an end day, or a refusal).
    award, award_on, award_case = None, None, ""     # the end day, the day Kevin recorded it, the claim's case
    one_off_on = None                                # the last one-off award: no fresh full-payer case for CASE_DAYS
    for d in decisions:
        if d["do"] == "one-off" or (mark_line(d["notes"], AWARD_MARK) or "").startswith(ONE_OFF):
            one_off_on = max(x for x in (one_off_on, d["approvedOn"] or d["created"] or day) if x)
        if d["do"] == "award":
            award = d["detail"]
        elif d["do"] in ("refused", "one-off"):
            award = None
        elif mark_line(d["notes"], AWARD_MARK) is not None:
            award = _day(mark_line(d["notes"], AWARD_MARK)[:10])
        else:
            continue
        award_on, award_case = d["approvedOn"] or d["created"] or day, d["case"]
    in_force = award is not None and award >= day

    # The current case: the newest cap task raised in the last CASE_DAYS, or older with a claim card raised in
    # them (a card withdrawn or parked near the end is still raised again, never dropped in silence).
    def current(c):
        fresh = lambda d: d is not None and (day - d).days <= CASE_DAYS
        return fresh(c["created"]) or any(k["case"] == c["case"] and (fresh(k["created"]) or (
            has(k, WITHDRAWN_MARK) and fresh(marked_on(k, WITHDRAWN_MARK, day)))) for k in claims)
    recent = [c for c in caps if current(c)]
    case = recent[-1] if recent else None
    # No short payment, but the tenant's own form says the cap took their money: a case of its own, paid to them.
    # Only for rent PAID IN FULL on trusted bank data (never late, new, doubtful or short), with nobody else talking
    # to the tenant, and never while an award or its renewal window is live or within CASE_DAYS of a one-off: those
    # carry on through their own case (reviews, 5 Oct 2026).
    full_note = ""
    award_live = award is not None and day <= award + timedelta(days=CASE_DAYS)
    one_off_recent = one_off_on is not None and (day - one_off_on).days <= CASE_DAYS
    if case is None and uc and row is not None and row.get("paidFull") and not busy and not unlinked and not no_chase \
            and not award_live and not one_off_recent:
        saver = claimant(list(tenancy.get("fld1i5bDoHL3B6rUf") or []), tenants)
        if saver and _sel(saver["fields"].get(TN["cap"])) == CAPPED and (day - saver["saved"]).days <= FULL_FRESH_DAYS:
            case = {"case": f"full:{saver['saved'].isoformat()}", "created": saver["saved"], "description": ""}
        elif saver and _sel(saver["fields"].get(TN["cap"])) != CAPPED and any(_sel((tenants.get(t) or {}).get(TN["cap"])) == CAPPED
                           for t in tenancy.get("fld1i5bDoHL3B6rUf") or [] if t != saver["id"]):
            # A joint tenancy: the household's latest answer stands, and it does not say capped. Said, never silent.
            full_note = (f"no claim: the latest details form answers the benefit cap as "
                         f"\"{_sel(saver['fields'].get(TN['cap'])) or 'blank'}\", not capped")

    # A claim that ended without an award (Kevin's Reject, the council's refusal, his stop on the questions, or six
    # asks with no answer) is never followed by another claim until the tenant saves the form again: the first
    # claim may still be with the council, and the same answers would only be refused again.
    closed = []
    for c in claims:
        if has(c, ENDED_MARK):
            closed.append((marked_on(c, ENDED_MARK, day), "the last claim was ended"))
    for d in decisions:
        if has(d, STOPPED_MARK):
            closed.append((marked_on(d, STOPPED_MARK, day), "the questions about the council's answer were stopped"))
        if d["do"] == "refused" or (mark_line(d["notes"], AWARD_MARK) or "").startswith(REFUSED):
            # An AWARD line opens with the award's end, not the day it was written: the day Kevin answered.
            closed.append((d["approvedOn"] or d["created"] or day, "the council refused the last claim"))
    for case_ in {d["case"] for d in decisions}:
        asks = [d for d in decisions if d["case"] == case_ and real_ask(d)]
        if len(asks) >= DECISION_ASKS:
            closed.append((max(marked_on(d, NO_ANSWER_MARK, day) for d in asks), "no council answer was recorded"))

    # Where the newest claim stands, and whether a claim is under way (no new short-cycle task meanwhile).
    newest = claims[-1] if claims else None
    under_way, stage = False, ""
    if newest and newest["do"] == "wait":
        under_way, stage = True, "claim card with Kevin"
    elif newest and newest["do"] == "parked":
        under_way, stage = True, "claim card parked by Kevin"
    elif newest and has(newest, SENT_MARK):
        went = newest["detail"] if newest["do"] == "sent" else marked_on(newest, SENT_MARK, day)
        mine = [d for d in decisions if d["case"] == newest["case"]]
        last = mine[-1] if mine else None
        asked = sum(1 for d in mine if real_ask(d))
        if any(has(d, AWARD_MARK) for d in mine):
            one_off = any(d["do"] == "one-off" or (mark_line(d["notes"], AWARD_MARK) or "").startswith(ONE_OFF)
                          for d in mine)
            stage = (f"award until {award.strftime('%-d %b %Y')}" if award and award >= day else
                     f"the award ended {award.strftime('%-d %b %Y')}" if award else
                     "a one-off award was paid" if one_off else "the council refused the claim")
        elif any(has(d, STOPPED_MARK) for d in mine):
            stage = "claim sent; Kevin stopped the questions about the council's answer"
        elif asked >= DECISION_ASKS:
            stage = f"no council answer recorded after {DECISION_ASKS} asks: asking has stopped"
            out["problems"].append(f"no council answer recorded for the claim sent {went.strftime('%-d %b')} "
                                   f"after {DECISION_ASKS} asks")
        else:
            under_way = True
            if last and last["do"] in ("wait", "parked"):
                stage, nxt = "the council's answer: question with Kevin", None
            elif last and has(last, NO_ANSWER_MARK):
                said = mark_line(last["notes"], NO_ANSWER_MARK) or str(last["detail"] or "")
                nxt = marked_on(last, NO_ANSWER_MARK, day) + timedelta(days=1 if "your note" in said else REASK_DAYS)
            elif last and has(last, WITHDRAWN_MARK):
                nxt = marked_on(last, WITHDRAWN_MARK, day) + timedelta(days=1)
            else:
                nxt = went + timedelta(days=DECISION_WAIT_DAYS)
            if nxt is not None and day >= nxt:
                again = None
                if last and has(last, NO_ANSWER_MARK):
                    again = (mark_line(last["notes"], NO_ANSWER_MARK) or str(last["detail"] or ""))[11:] or None
                # The tenant the claim went for, as its card recorded; a card from before that line, the latest saver.
                for_id = card_line(newest, CLAIM_FOR_MARK)
                who_d = ({"fields": tenants[for_id]} if for_id in tenants
                         else claimant(list(tenancy.get("fld1i5bDoHL3B6rUf") or []), tenants))
                out["raise"].append({"kind": "decision", "case": newest["case"], "n": (last["n"] + 1) if last else 1,
                                     "sent": went, "again": again,
                                     "who": " ".join(str((who_d or {}).get("fields", {}).get(TN["name"]) or "").split())})
                stage = "asking Kevin for the council's answer"
            elif nxt is not None:
                stage = f"claim sent {went.strftime('%-d %b')}; asking for the council's answer from {nxt.strftime('%-d %b')}"
    elif newest and has(newest, WITHDRAWN_MARK):
        # Withdrawn and raised again while its case is current; an expired case frees the tenancy.
        under_way = bool(case and newest["case"] == case["case"])
        stage = "claim card withdrawn, raised again when ready" if under_way else ""
    elif newest and has(newest, ENDED_MARK):
        said = mark_line(newest["notes"], ENDED_MARK) or f"{day.isoformat()} {newest['detail']}"
        stage = f"claim ended ({said[11:]})"

    # A claim that asks for the award to go to the tenant while the rent now arrives short: Kevin is told on the row,
    # every run, so he sends the card back (or tells the council) rather than paying a tenant who is short.
    # Short, or late and red on the rent check (a few days late is often bank timing; a tenancy with no payment
    # for months is red with no day count). Only while the claim can still pay the tenant: waiting with Kevin, or
    # sent with no answer yet, or under an award still in force.
    behind = None
    if row is not None and row.get("lane") == "short":
        behind = "short"
    elif row is not None and row.get("lane") == "late" and row.get("light") == "red":
        behind = "late"
    if newest and behind and (card_line(newest, PAYEE_MARK) or "").startswith("tenant") \
            and newest["do"] in ("wait", "parked", "done", "sent") \
            and not has(newest, WITHDRAWN_MARK) and not has(newest, ENDED_MARK):
        answers = [d for d in decisions if d["case"] == newest["case"]]
        settled = any(has(d, STOPPED_MARK) for d in answers) or (
            any(has(d, AWARD_MARK) for d in answers) and not (in_force and award_case == newest["case"]))
        if newest["do"] in ("wait", "parked"):
            out["problems"].append(f"a claim asks for the award to go to the tenant, but the rent is now {behind}: "
                                   "press Request changes on the card")
        elif not settled:
            out["problems"].append(f"a claim asks for the award to go to the tenant, but the rent is now {behind}: "
                                   "tell the council")
    claim_stage = stage                              # where the claim stands, before anything new is raised
    # 1. RENT CAP: a renewal a month before an award ends, or a Universal Credit tenancy paid short.
    # From a month before the award ends until its case would lapse: a renewal held back (a late-rent chase or a
    # plan open, the agent switched off) still comes once it can, unless a newer case has started meanwhile.
    if award and award - timedelta(days=RENEW_DAYS) <= day <= award + timedelta(days=CASE_DAYS) \
            and row is not None and not no_chase:
        renew = f"renew:{award.isoformat()}"
        # A case raised after the award was recorded (a short payment once it ended) has taken over.
        newer = any(c["created"] and c["created"] > award_on for c in caps)
        if not any(c["case"] == renew for c in caps) and not newer:
            if any(c["status"] not in CLOSED for c in caps):
                stage = "renewal waits: a benefit-cap task is still with the agent"
            elif busy:
                stage = "renewal waits: a late-rent chase or payment plan is open"
            else:
                out["raise"].append({"kind": "cap", "case": renew})
                stage = "renewal task raised for the agent"
    if row and row.get("lane") == "short" and row.get("type") == "Universal Credit" \
            and row.get("status") == "In Payment" and row.get("cycle") and not no_chase:
        if busy:
            # A late-rent chase or an agreed payment plan is already talking to the tenant: one voice at a time.
            stage = stage or "a late-rent chase or payment plan is open, so no benefit-cap task yet"
        elif any(c["status"] not in CLOSED for c in caps) or any(x["kind"] == "cap" for x in out["raise"]) or any(
                c["case"].startswith("renew:") and c["created"] and (day - c["created"]).days < RENEW_DAYS for c in caps):
            # One ask at a time: an open task, a renewal raised this run, or one raised in the last month.
            stage = stage or ("benefit-cap task with the agent" if any(c["status"] not in CLOSED for c in caps)
                              else "a renewal task went out in the last month, so no second ask yet")
        elif not any(c["case"] == row["cycle"] for c in caps) and not under_way and not in_force:
            out["raise"].append({"kind": "cap", "case": row["cycle"], "got": row.get("got"), "rent": row.get("rent")})
            stage = stage or "benefit-cap task raised for the agent"

    # 2. RENT CLAIM: for the current case, once the tenant has done their part.
    if case and row is not None:
        renewal = case["case"].startswith("renew:")
        mine = [c for c in claims if c["case"] == case["case"]]
        last = mine[-1] if mine else None
        if last is None:
            due = not (under_way or (in_force and not renewal))
        elif has(last, WITHDRAWN_MARK) and last["do"] not in ("withdraw", "lost"):
            gone_line = mark_line(last["notes"], WITHDRAWN_MARK) or ""
            gone = marked_on(last, WITHDRAWN_MARK, day)
            who_now = claimant(list(tenancy.get("fld1i5bDoHL3B6rUf") or []), tenants)
            if "asked for changes" in gone_line:
                due = day >= gone + timedelta(days=CHANGES_WAIT_DAYS) or bool(who_now and who_now["saved"] > gone)
            else:
                due = day > gone
        else:
            due = False                               # with Kevin, parked, sent, ended, or withdrawn today
        if due:
            who = claimant(list(tenancy.get("fld1i5bDoHL3B6rUf") or []), tenants)
            why = []
            if not who:
                why.append("the tenant has not saved the details form")
            else:
                start = case["created"] if renewal else case["created"] - timedelta(days=FORM_BEFORE_DAYS)
                if who["saved"] < start:
                    why.append(f"the details form was last saved {who['saved'].strftime('%-d %b')}, before this case")
                if closed and who["saved"] <= max(closed)[0]:
                    why.append(f"{max(closed)[1]} and the form has not been saved since")
                if not who["fields"].get(TN["authority"]):
                    why.append("the letter of authority is not ticked as signed")
                blank = [k for k in NEEDED if who["fields"].get(TN[k]) in (None, "", [], {})]
                if len(tenancy.get("fld1i5bDoHL3B6rUf") or []) > 1 and not _sel(who["fields"].get(TN["household"])):
                    blank.append("household (two tenants on one tenancy)")
                if blank:
                    why.append("blank on the tenant record: " + ", ".join(blank))
            if why:
                stage = "; ".join(x for x in (stage, "claim not raised yet: " + "; ".join(why)) if x)
            else:
                prior = None
                # Kevin's change note carries to the next card, even when the tenant's re-save starts a new case:
                # from the latest claim he sent back (today, or written down before), for the same tenant, recently.
                source = last
                if source is None and claims and (claims[-1]["do"] == "withdraw" or has(claims[-1], WITHDRAWN_MARK)):
                    old = claims[-1]
                    if card_line(old, CLAIM_FOR_MARK) in (None, who["id"]) \
                            and (day - marked_on(old, WITHDRAWN_MARK, day)).days <= FULL_FRESH_DAYS:
                        source = old
                if source and source["do"] == "withdraw":
                    prior = source["detail"] or None  # sent back today: its line is written later in this run
                else:
                    said_ = (mark_line(source["notes"], WITHDRAWN_MARK) or "") if source else ""
                    if "asked for changes: " in said_:
                        prior = said_.split("asked for changes: ", 1)[1].strip().strip('"')
                m = SHORT_RE.search(case["description"])
                short = (float(m.group(1).replace(",", "")), float(m.group(2).replace(",", ""))) if m else None
                # Who is paid: the tenant for a full payer's case, or the renewal of an award a claim paid to the
                # tenant (read off that claim card); never while the rent is short, which is always ours.
                paid_tenant = [c for c in claims if c["case"] == award_case and has(c, SENT_MARK)
                               and (card_line(c, PAYEE_MARK) or "").startswith("tenant")]
                full = case["case"].startswith("full:") or (renewal and bool(paid_tenant))
                if full and row.get("lane") == "short":
                    full = False                     # the rent is short: the top-up is ours
                if full and not row.get("paidFull"):
                    # Paid to the tenant only on a rent seen paid in full; on a doubtful day, wait (review, 5 Oct 2026).
                    stage = "; ".join(x for x in (stage, "claim waits: the rent is not seen paid in full yet") if x)
                else:
                    out["raise"].append({"kind": "claim", "case": case["case"], "n": (last["n"] + 1) if last else 1,
                                         "claimant": who, "prior": prior, "short": short,
                                         "payee": "tenant" if full else "landlord"})
                    stage = "claim card raised for Kevin"
    if full_note and not out["raise"]:
        stage = "; ".join(x for x in (stage, full_note) if x)
    if unlinked:
        # A tenancy left with no unit on purpose (Kevin, 5 Oct 2026): the tenant may have gone without the tenancy
        # being ended, so it is left to stop by itself or be relocated. No new ask goes to it and no new claim is
        # made for it. A claim already sent is still followed up (the council's answer matters most if the tenant
        # has gone), Kevin's verdicts are still read, and the stage keeps what the claim was doing.
        out["raise"] = [x for x in out["raise"] if x["kind"] == "decision"]
        claim_stage = claim_stage.replace("claim card withdrawn, raised again when ready", "claim card withdrawn")
        stage = "; ".join(x for x in (claim_stage, "left unlinked on purpose, so no new benefit-cap task or claim") if x)
    out["stage"] = stage
    return out


# ─── the cards' words ────────────────────────────────────────────────
def council_for(postcode):
    district = str(postcode or "").strip().upper().split(" ")[0]
    return COUNCILS.get(district)


def _money(v):
    try:
        return f"£{float(v):,.2f}"
    except (TypeError, ValueError):
        return ""


INSTRUCTION_LIKE = "(on the tenant record; not copied here, as it reads like an instruction)"


def claim_text(item, rec, landlord, place, screen=lambda v: False):
    """Kevin's claim card: the ask, the council's form, every answer and where it came from, the evidence.
    Every answer is one line. `screen` is the submit step's own hand-back check: a tenant's answer it would read
    as an instruction to Kevin is left on the record, never copied, or the card would be refused every day."""
    who = item["claimant"]
    f = who["fields"]

    def one(v):
        v = " ".join(str(v if v is not None else "").split())
        return INSTRUCTION_LIKE if v and screen(v) else v

    name = one(f.get(TN["name"])) or "the tenant"
    if name == INSTRUCTION_LIKE:
        name = "the tenant"
    council = council_for(rec["property"].get("postcode"))
    rent = float(rec["tenancy"].get("rent") or 0)
    short = item.get("short")                     # (paid, rent) read off the case's own cap task
    gap = short[1] - short[0] if short else None
    files = f.get(TN["documents"]) or []
    lines = [f"THE ASK: send the council housing payment claim for {name} at {place}, then approve this card.", ""]
    if item.get("prior"):
        lines += [f"Last time you asked for changes: \"{' '.join(str(item['prior']).split())[:300]}\". The answers "
                  "below are read from the records again.", ""]
    if item["case"].startswith("renew:"):
        lines += [f"This is a renewal: the award ends {date.fromisoformat(item['case'][6:]).strftime('%-d %b %Y')}.", ""]
    if council:
        lines += [f"WHERE: {council[0]}. Form: {council[1]}"] + ([council[2]] if council[2] else [])
    else:
        lines += [f"WHERE: no claim form is on file for the postcode {rec['property'].get('postcode') or '(blank)'}. "
                  "Use that council's Crisis and Resilience Fund Housing Payment form."]
    why = (f"WHY: {name} is on Universal Credit and the benefit cap cuts their housing money."
           + (f" The rent check saw {_money(short[0])} of {_money(short[1])} for the rent due "
              f"{date.fromisoformat(item['case']).strftime('%-d %b %Y')}, short by {_money(gap)}."
              if short and not item["case"].startswith("renew:") else ""))
    where = landlord.get("address")
    if isinstance(where, dict):
        where = ", ".join(str(where.get(k)) for k in ("line1", "line2", "town_city", "postcode") if where.get(k))
    if item.get("payee") == "tenant":
        # Kevin, 5 Oct 2026: a tenant who pays the full rent gets the top-up back themselves.
        why += " They pay the full rent, so the top-up is paid to them."
        pay = (f"WHO GETS THE MONEY: ask for it to be paid to {name}, the tenant (Kevin's ruling, 5 Oct 2026: they pay "
               "the full rent and the cap came off their own money). The council will ask for their bank details, which "
               "are not on our records: ask them for these, never guess. Their signed letter of authority lets us apply "
               "for them.")
    else:
        pay = (f"WHO GETS THE MONEY: ask for it to be paid to the landlord, {landlord.get('full_name')}, "
               f"{where}. Their signed letter of authority lets us act for them.")
    lines += [why, pay, "", "THE ANSWERS, AND WHERE EACH CAME FROM"]
    # The form no longer asks these three (Kevin, 6 Oct 2026): what is on the record was filled in by us, or by an
    # earlier form. A blank household only reaches this card for a one-tenant tenancy (plan() holds a joint one).
    household, adults, ct = _sel(f.get(TN["household"])), f.get(TN["otherAdults"]), f.get(TN["ctAccount"])
    alone = household in ("", "Single")
    answers = [
        ("Name", f.get(TN["name"]), "tenant record"),
        ("Date of birth", f.get(TN["dob"]), "tenant record"),
        ("National Insurance number", f.get(TN["ni"]), "their details form"),
        ("Address", ", ".join(x for x in (rec["property"].get("address"), rec["property"].get("postcode")) if x),
         "property record"),
        ("Mobile", f.get(TN["phone"]), "their details form"),
        ("Email", f.get(TN["email"]), "their details form"),
        ("Household", household or "Single", "tenant record" if household else LIVES_ALONE),
        ("Other adults in the home", adults or ("none" if alone else "none given"),
         "tenant record" if adults or not alone else LIVES_ALONE),
        ("Benefit cap", _sel(f.get(TN["cap"])) or "not given", "their details form"),
        ("Universal Credit payment day", f.get(TN["ucPayDay"]) or "not given", "their details form"),
        ("Council tax account number", ct or "not given: the form no longer asks for it", "tenant record"),
        ("Weekly income", _money(f.get(TN["weeklyIncome"])), "their details form"),
        ("Weekly spending", _money(f.get(TN["weeklySpending"])), "their details form"),
        ("Other benefits", " ".join(str(f.get(TN["otherBenefits"]) or "none given").split()), "their details form"),
        ("Rent", f"{_money(rent)} ({str(rec['tenancy'].get('frequency') or 'Monthly').lower()})", "tenancy record"),
        ("Shortfall", "none: the tenant pays the full rent" if item.get("payee") == "tenant"
         else _money(gap) if gap and not item["case"].startswith("renew:") else "see the rent statement",
         "the daily rent check"),
    ]
    lines += [f"- {q}: {one(a)} ({src})" for q, a, src in answers]
    lines += ["", f"The details form was last saved on {who['saved'].strftime('%-d %b %Y')}.", "",
              "EVIDENCE THE COUNCIL ASKS FOR",
              f"- The last two months' bank statements ({len(files)} file{'s' if len(files) != 1 else ''} on the tenant record)",
              "- The latest Universal Credit statement",
              "- The tenancy agreement and a rent statement",
              "- The signed letter of authority", "",
              "IF AN ANSWER IS WRONG",
              "- Fix the record and press Request changes: the card comes again a week later, or as soon as the "
              "tenant saves the form again. Reject ends this claim.", "",
              f"{aef.CARRY_OUT_MARKER} the rent check noting the claim as gone in today and asking you for the "
              "council's answer in three weeks."]
    return "\n".join(lines)


def decision_text(item, name, place, council):
    lines = [f"THE ASK: has {council} answered the housing payment claim for {name} at {place}, which went in on "
             f"{item['sent'].strftime('%-d %b %Y')}?", ""]
    if item.get("again"):
        lines += [f"Last time: {item['again']}.", ""]
    lines += ["IF YOU APPROVE, write ONE of these as your note, exactly:",
              "- AWARD UNTIL: 31 Mar 2027 (the date the award ends): the rent check records it and raises a renewal a "
              "month before it ends.",
              "- ONE-OFF: the council paid once; nothing to renew.",
              "- REFUSED: the rent check records the refusal.",
              "Any other note is asked again the next day.", "",
              "No answer yet? Press Request changes: you are asked again in two weeks. Reject stops these questions "
              "for this claim.", "",
              f"{aef.CARRY_OUT_MARKER} the rent check recording the council's answer from your note."]
    return "\n".join(lines)


def cap_item(rc, tid, it, place, tenants, day):
    """The RENT CAP task for rent-check.raise_task."""
    key = f"cap:{tid}:{it['case']}"
    if it["case"].startswith("renew:"):
        end = date.fromisoformat(it["case"][6:])
        name = f"{CAP_PREFIX}{place}, housing payment ends {end.strftime('%-d %b')} (renewal)"
        what = [f"The council's housing payment for this tenancy ends {end.strftime('%-d %b %Y')}. Ask the tenant to check "
                "and save the details form again, so the renewal claim carries today's answers."]
    else:
        due = date.fromisoformat(it["case"])
        name = f"{CAP_PREFIX}{place}, rent due {due.strftime('%-d %b')} paid short"
        what = [f"The rent due {due.strftime('%-d %b %Y')} arrived short: {_money(it.get('got'))} of {_money(it.get('rent'))}. "
                "The tenant is on Universal Credit, so the benefit cap is the likely cause.",
                "Ask the tenant to fill in the details form and sign the letter of authority, so Kevin can claim the "
                "council's housing payment for them."]
    return {"key": key, "tenancy": tid, "tenants": tenants, "alsoKeys": [], "name": name,
            "description": "\n".join([f"Raised by the daily rent check on {day.strftime('%-d %b %Y')}.",
                                      "TRIAL: you draft, Kevin checks, nothing is sent to the tenant.", ""] + what + [
                "", "Draft the email for a benefit-cap tenant, following your agent file.", "", CAP_KEY_MARK + key])}


def raise_card(rc, kind, tid, it, place, tenants, day):
    """Create one of Kevin's cards under the agent and submit it to his queue. A refused submit withdraws it (the
    next run raises it again); if even that write fails, the next run finds it outside his queue and does it."""
    import rent_new_tenant as lane_b                # its submit helper; loaded only when a card is due
    ad = lane_b.module("ad")
    key = f"{kind}:{tid}:{it['case']}:{it['n']}"
    rec = lane_b.read_form_records(rc, tid)
    if kind == "claim":
        text = claim_text(it, rec, lane_b.read_landlord(), place,
                          screen=lambda v: bool(ad.HANDBACK_KEVIN_RE.search(v) or ad.HANDBACK_YOU_RE.search(v)))
        name = f"{CLAIM_PREFIX}{place}, council housing payment"
        first = (str(it["claimant"]["fields"].get(TN["name"]) or "").split() or ["the tenant"])[0]
        plain = (f"The council housing payment claim for {first} at {place}, filled from the records.",
                 "Approve once you have sent it: the rent check notes it and asks for the council's answer in three weeks.")
    else:
        council = (council_for(rec["property"].get("postcode")) or ("the council",))[0]
        who = it.get("who") or str(rec["tenant"].get("name") or "") or "the tenant"
        text = decision_text(it, who, place, council)
        name = f"{DECISION_PREFIX}{place}, has the council answered?"
        plain = (f"Has the council answered the housing payment claim for {who.split()[0]} at {place}?",
                 "Approve with AWARD UNTIL and the end date, ONE-OFF, or REFUSED as your note: the rent check records it.")
    fields = {rc.TK["name"]: name, rc.TK["status"]: "Today", rc.TK["due"]: day.isoformat(),
              rc.TK["description"]: (f"Raised by the daily rent check on {day.strftime('%-d %b %Y')}. Kevin's own card: "
                                     "no agent works it.\n\nReference for the rent check, please leave it in:\n"
                                     + CLAIM_KEY_MARK + key
                                     + (f"\n{CLAIM_FOR_MARK}{it['claimant']['id']}\n{PAYEE_MARK}{it.get('payee', 'landlord')}"
                                        if kind == "claim" else "")),
              rc.TK["notes"]: CLAIM_KEY_MARK + key + (f"\n{CLAIM_FOR_MARK}{it['claimant']['id']}\n{PAYEE_MARK}{it.get('payee', 'landlord')}"
                                                     if kind == "claim" else ""),
              rc.TK["tenancies"]: [tid], rc.TK["teamMember"]: [rc.AGENT_TEAM_MEMBER]}
    if tenants:
        fields[rc.TK["tenants"]] = tenants
    task = rc.api("POST", rc.T_TASKS, {"records": [{"fields": fields}]})["records"][0]["id"]
    fd, path = tempfile.mkstemp(prefix="rent-claim-", suffix=".md")    # 0600: the card names the tenant
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        lane_b.call_in_process(ad.cmd_submit, argparse.Namespace(
            task=task, agent=rc.AGENT_TEAM_MEMBER, type="Admin", output_file=path, plain_task=plain[0],
            plain_approve=plain[1], tier1=False, siblings=None, coverage=None, receipt=None, attach=None))
    except Exception as exc:
        # The refusal is cut at its first quote: a gate quotes the line it matched, and that line can be a
        # tenant's own words, which never go on the rent check's row.
        why = re.split(r"[\"'\u2018\u201c]", " ".join(str(exc).split()))[0].strip()[:160]
        try:
            write_mark(rc, task, WITHDRAWN_MARK, f"{day.isoformat()} it could not be submitted to Kevin's queue: {why}",
                       status="Cancelled")
            gone = "withdrawn, the next run raises it again"
        except Exception:                             # noqa: BLE001 — said in the error below
            gone = "and could not be withdrawn; the next run withdraws it and raises it again"
        raise RuntimeError(f"{name} could not be submitted ({task} {gone}): {why}")
    finally:
        if os.path.exists(path):
            os.unlink(path)
    return task


def write_mark(rc, task_id, mark, text, status=None):
    """One mark line on a card's Notes, read and written by field id in the same step, with its status. Notes that
    read back blank or without the card's key are a failed read: nothing is written."""
    got = rc.api("GET", rc.T_TASKS, params={"filterByFormula": f"RECORD_ID()='{task_id}'", "pageSize": 1,
                                            "returnFieldsByFieldId": "true",
                                            "fields[]": [F["notes"], F["status"], F["description"]]})
    recs = got.get("records") or []
    f = (recs[0].get("fields") or {}) if recs else {}
    notes = str(f.get(F["notes"]) or "")
    if not notes.strip() or CLAIM_KEY_MARK not in notes + str(f.get(F["description"]) or ""):
        raise RuntimeError(f"card {task_id} read back with blank Notes or no claim key; nothing written")
    fields = {F["notes"]: (notes.rstrip() + "\n\n" + mark + " ".join(str(text).split()))[-90000:]}
    if status and _sel(f.get(F["status"])) not in CLOSED:
        fields[F["status"]] = status
        if status == "Completed":
            fields[F["completion"]] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    rc.api("PATCH", rc.T_TASKS, {"records": [{"id": task_id, "fields": fields}]})


def act_on(rc, c, day):
    """Write the one line Kevin's verdict on a card calls for, and close it."""
    do, detail = c["do"], c["detail"]
    if do == "sent":
        write_mark(rc, c["id"], SENT_MARK, f"{detail.isoformat()} Kevin approved the card: the claim went in.", "Completed")
    elif do == "withdraw":
        write_mark(rc, c["id"], WITHDRAWN_MARK, f"{day.isoformat()} Kevin asked for changes: \"{detail}\"", "Cancelled")
    elif do == "lost":
        write_mark(rc, c["id"], WITHDRAWN_MARK, f"{day.isoformat()} {detail}", "Cancelled")
    elif do == "end":
        write_mark(rc, c["id"], ENDED_MARK, f"{day.isoformat()} {detail}", None)
    elif do == "award":
        write_mark(rc, c["id"], AWARD_MARK, f"{detail.isoformat()} (read from Kevin's note on {day.isoformat()})", "Completed")
    elif do in ("refused", "one-off"):
        word = REFUSED if do == "refused" else ONE_OFF
        write_mark(rc, c["id"], AWARD_MARK, f"{word} (read from Kevin's note on {day.isoformat()})", "Completed")
    elif do == "no-answer":
        write_mark(rc, c["id"], NO_ANSWER_MARK, f"{day.isoformat()} {detail}",
                   "Completed" if c["outcome"] in APPROVED else "Cancelled")
    elif do == "stop":
        write_mark(rc, c["id"], STOPPED_MARK, f"{day.isoformat()} {detail}", None)


def run(rc, data, day, res, writes, on, on_plan=frozenset()):
    """Lane C for every tenancy, once a day. Never stops the rent check: a failure is said on the row and in the
    exit code. Writes only on a real run with the agent switched on."""
    out = {"on": bool(on), "caps": [], "claims": [], "decisions": [], "acted": [], "stages": [], "problems": [],
           "failed": ""}
    if not on:                                        # off, or its switch could not be read
        return out
    fails = []
    try:
        views, problems = read(rc)
        out["problems"] += problems
        busy = read_busy(rc) | set(on_plan)
        tys = {r["id"]: r.get("fields") or {} for r in data["tenancies"]}
        rows = {r["id"]: r for r in res.get("tenancies") or []}
        lanes = res.get("lanes") or {}
        no_chase = set(data.get("noChase") or ())
        shorts = {r["id"] for r in rows.values() if r.get("lane") == "short"}
        capped = read_capped(rc, day)
        full = {tid for tid, ty in tys.items() if capped & set(ty.get(rc.TY["tenants"]) or [])}
        types = {r["id"]: r.get("fields") or {} for r in data.get("tenants") or []}
        paid_full = set(res.get("paidFull") or ())
        wanted = set(views) | shorts | full
        tenant_ids = {t for tid in wanted for t in (tys.get(tid, {}).get(rc.TY["tenants"]) or [])}
        tenants = read_tenants(rc, tenant_ids) if tenant_ids else {}
        for tid in sorted(wanted):
            ty = tys.get(tid, {})
            row = rows.get(tid) if tid in lanes else None
            if row is None and tid in lanes:
                row = {"lane": lanes[tid]}           # a green tenancy carries no row of its own
            if row is not None:
                row = dict(row, paidFull=tid in paid_full)
            unit = rc.first(ty.get(rc.TY["unitRef"])) or "(no unit linked)"
            place = rc.lane_b_rules.place_name(unit)
            p = plan(tid, views.get(tid, {}), row, ty, tenants, day,
                     no_chase=bool(no_chase & set(ty.get(rc.TY["tenants"]) or [])), busy=tid in busy,
                     unlinked=not rc.first(ty.get(rc.TY["unitRef"])),
                     uc=rc.tenant_type(ty, types) == "Universal Credit")
            out["problems"] += [f"{place}: {x}" for x in p["problems"]]
            if p["stage"]:
                out["stages"].append(f"{place}: {p['stage']}")
            for c in p["acts"]:
                out["acted"].append(f"{c['name'] or c['id']}: {c['do']}")
                if writes:
                    try:
                        act_on(rc, c, day)
                    except Exception as exc:  # noqa: BLE001 — said on the row
                        fails.append(f"card {c['id']}: {str(exc)[:150]}")
            for it in p["raise"]:
                label = {"cap": out["caps"], "claim": out["claims"], "decision": out["decisions"]}[it["kind"]]
                tenants_here = list(ty.get(rc.TY["tenants"]) or [])
                if it["kind"] == "cap":
                    item = cap_item(rc, tid, it, place, tenants_here, day)
                    label.append(item["name"])
                    if writes:
                        try:
                            rc.raise_task(item, day)
                        except Exception as exc:  # noqa: BLE001
                            fails.append(f"{item['name']}: {str(exc)[:150]}")
                    continue
                label.append(f"{place} ({it['kind']} {it['n']})")
                if writes:
                    try:
                        raise_card(rc, it["kind"], tid, it, place, tenants_here, day)
                    except Exception as exc:  # noqa: BLE001
                        fails.append(str(exc)[:250])
    except Exception as exc:                          # noqa: BLE001 — said on the row
        fails.append(f"benefit-cap claims could not be read: {str(exc)[:200]}")
    out["failed"] = "; ".join(fails)[:600]
    return out


def line(out):
    """The rent check row's line for benefit-cap claims. Place names and stages only: never a tenant's answers."""
    check = (" Check: " + "; ".join(out["problems"]) + ".") if out.get("problems") else ""
    if out.get("failed"):
        return f"Benefit-cap claims FAILED: {out['failed']}{check}"
    if not out.get("on"):
        return f"Benefit-cap claims: nothing raised, the Cash Flow Voids agent is switched off or unread.{check}"
    bits = []
    for k, what in (("caps", "benefit-cap tasks for the agent (trial, nothing is sent)"), ("claims", "claim cards for Kevin"),
                    ("decisions", "questions to Kevin about the council's answer")):
        if out.get(k):
            bits.append(f"{what}: " + "; ".join(out[k]))
    if out.get("stages"):
        bits.append("where each stands: " + "; ".join(out["stages"]))
    return "Benefit-cap claims: " + (". ".join(bits) if bits else "none needed today") + "." + check
