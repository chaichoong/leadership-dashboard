"""Chase a tenant details form that has not been filled in (Kevin, 5 Oct 2026). Part of the daily rent check.

WHY THIS EXISTS
A capped tenant is sent a link to the tenant details form (Property Manager Worker, POST /tenant-form/link or
/robot-link), and the council claim cannot start until they fill it in. Kevin, 5 Oct 2026: "We need to have the
follow-up process for those and get Roy's involvement when we get to a certain stage where we're not getting
engagement." He approved the plan as-is the same day:

  day 3 after the link reached them   reminder 1, drafted by the Cash Flow Voids agent (email + text, his approval)
  day 7                               reminder 2, the same
  day 10                              a task for Roy to reach the tenant in person or by phone

counted from the day the email carrying the link went: the first card linked to the tenant whose Agent Output holds
the form link (LINK_MARK) and that the send door stamped SENT on or after the link was made (reviews, 5 Oct 2026: a
link is made when the card is drafted, days before Kevin may approve it, and a tenant's other cards, a late-rent email
or a reply, never carried it). While such a card waits for Kevin's approval, the chase waits; a link no card ever
carried to them is never chased. One step at a time: a step waits while the one before it is with Kevin, and
never comes within GAP_DAYS of the last thing that went. A reminder counts as done only once it went (its SENT
stamp): one closed without going (Kevin's "Reject and close" sets Completed, review 5 Oct 2026) ends the chase, as
Cancelled does. The chase also stops on a save made after the link, or after Roy's step. A tenant on the
do-not-chase list, one a late-rent chase is talking to, or one with no live tenancy linked is left alone. Keys are
`RENT CHECK KEY: details:<tenant>:<day the link was made>:<step>`, so a link made again inside the chase carries on
the same chase instead of starting it over. Never "RENT FORM: ": that prefix is the robot's direct rent payment form
card, whose approval opens the robot's window (agent_email_format.FORM_CARDS).
"""

import re
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

LINK_DAYS = 14                      # workers/property-manager/worker.js LINK_DAYS: a link is made `expires - 14`
STEPS = (("1", 3), ("2", 7), ("roy", 10))
GAP_DAYS = 3                        # never a step within three days of the last thing that went to the tenant
WINDOW_DAYS = 30                    # a chase is started only inside this; one under way runs to its end
LINK_MARK = "tenant-details.html"   # the form's page: in the Agent Output of every card that carries a link
AGENT_OUTPUT = "fldzswp8fx6PqpLQ5"  # Tasks: Agent Output (send-email.py AF["agentOutput"])
PREFIX = "RENT DETAILS: "           # never "RENT FORM: ": the robot's direct rent payment form card
KEY_MARK = "RENT CHECK KEY: details:"
TN = {"name": "fldxBKW7QnujSDWqA", "saved": "fldc7XMcQcYY6C2Xa", "expires": "fldsgGmWIUX48t4I7",
      "tenancies": "fldWijr5nOIcKJMP4"}
LINKS_FORMULA = "LEN({Tenant Form Code Expires}&'')>0"     # field NAME: a rename is an error, never zero rows
SENT_RE = re.compile(r"\[(\d{2} \w{3} \d{4}) \d{2}:\d{2} — send-email\] SENT:")
CLOSED = ("Completed", "Cancelled")
WAITING = "Approval"                # a card waiting for Kevin's verdict
LONDON = ZoneInfo("Europe/London")


def _day(v):
    try:
        return date.fromisoformat(str(v)[:10]) if v else None
    except ValueError:
        return None


def london_day(v):
    """The London day of an Airtable dateTime (the Worker stamps saves in UTC): a save at 00:30 BST is that day."""
    try:
        return datetime.strptime(str(v)[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).astimezone(LONDON).date()
    except ValueError:
        return _day(v)


def sent_on(notes):
    """The day the send door stamped a card SENT, or None. The stamp is written in London time."""
    m = SENT_RE.search(str(notes or ""))
    return datetime.strptime(m.group(1), "%d %b %Y").date() if m else None


def read_links(rc):
    """{tenant id: fields} for every tenant who was ever sent a details-form link."""
    rows = rc.fetch_all(rc.T_TENANTS, {"fields[]": list(TN.values()), "filterByFormula": LINKS_FORMULA})
    return {r["id"]: r.get("fields") or {} for r in rows}


def read_cards(rc, day):
    """(chases, cards). chases: {key: {id, status, sent}} for every form-chase task, whatever its status (a closed
    one is a step done or ended). cards: {tenant id: [{id, status, sent}]} for every OTHER task whose Agent Output
    carries the form link (LINK_MARK) and that links the tenant, however old: the card that carried a link, or one
    still waiting for Kevin. Field NAMES in the formula: a rename is an error, never zero rows."""
    chases, cards = {}, {}
    for rec in rc.fetch_all(rc.T_TASKS, {"fields[]": [rc.TK["status"], rc.TK["notes"], rc.TK["description"],
                                                      rc.TK["tenants"], AGENT_OUTPUT],
                                         "filterByFormula": f"OR(FIND('{LINK_MARK}', {{Agent Output}}&''), "
                                                            f"FIND('{KEY_MARK}', {{Notes}}&''))"}):
        f = rec.get("fields") or {}
        notes = str(f.get(rc.TK["notes"]) or "")
        view = {"id": rec["id"], "status": rc.sel(f.get(rc.TK["status"])), "sent": sent_on(notes)}
        keys = [ln.strip()[len(KEY_MARK):].strip()
                for ln in (notes + "\n" + str(f.get(rc.TK["description"]) or "")).splitlines()
                if ln.strip().startswith(KEY_MARK)]
        for key in keys:
            chases[key] = view
        if not keys and LINK_MARK in str(f.get(AGENT_OUTPUT) or ""):
            for t in f.get(rc.TK["tenants"]) or []:
                cards.setdefault(t, []).append(view)
    return chases, cards


def plan(tid, f, chases, cards, day, live, busy=False, no_chase=False):
    """Pure. ({step, key, anchor, tenancy, made, expires, carried} to raise today or None, the stage in words or "").
    `cards` is this tenant's other cards ([{status, sent}]); `live` the tenancies the rent check judged live today."""
    expires = _day(f.get(TN["expires"]))
    if expires is None:
        return None, ""
    made = expires - timedelta(days=LINK_DAYS)
    saved = london_day(f.get(TN["saved"])) if f.get(TN["saved"]) else None
    if saved and saved >= made:
        return None, ""                               # filled in since the link was made: nothing to chase
    # The chase this link belongs to: an earlier chase still inside the window that the tenant has not answered
    # by saving the form, so a link made again mid-chase carries on the same chase.
    anchors = [made]
    for key in chases:
        parts = key.split(":")
        if len(parts) == 3 and parts[0] == tid:
            a = _day(parts[1])
            if a and a <= made and (made - a).days <= WINDOW_DAYS and not (saved and saved >= a):
                anchors.append(a)
    anchor = min(anchors)
    steps = {step: chases.get(f"{tid}:{anchor.isoformat()}:{step}") for step, _ in STEPS}
    went = sorted(c["sent"] for c in cards if c["sent"] and c["sent"] >= anchor)
    waiting = any(c["status"] == WAITING for c in cards)
    if not went:
        if waiting:
            return None, "the form link's email is with Kevin, so no reminder yet"
        return None, ("" if (day - anchor).days > WINDOW_DAYS
                      else "a form link was made, but no card has emailed it to the tenant, so nobody is chased")
    carried = went[0]
    if not steps["1"] and (day - carried).days > WINDOW_DAYS:
        return None, ""                               # never started inside the window: history
    tenancy = next((t for t in f.get(TN["tenancies"]) or [] if t in live), None)
    if tenancy is None:
        return None, "the form is not filled in, but the tenant has no live tenancy linked, so nobody is chased"
    if no_chase:
        return None, "the form is not filled in; the tenant is on the do-not-chase list"
    if busy:
        return None, "the form is not filled in; a late-rent chase is talking to the tenant, so this one waits"
    if waiting:
        return None, "the form is not filled in; a new form link email to the tenant is with Kevin, so this one waits"
    last = max(went)                                  # the last thing that went to the tenant, chase steps included
    for step, at in STEPS:
        task = steps[step]
        if task:
            if step == "roy":
                return None, ("Roy is reaching the tenant" if task["status"] not in CLOSED
                              else "the form chase is done: Roy has had it")
            if task["status"] not in CLOSED:
                return None, f"form chase reminder {step} is with Kevin"
            if not task["sent"]:
                return None, f"the form chase stopped: reminder {step} was closed without going (turned down or refused)"
            last = max(last, task["sent"])
            continue
        due = max(carried + timedelta(days=at), last + timedelta(days=GAP_DAYS))
        if day < due:
            what = f"reminder {step}" if step != "roy" else "Roy"
            return None, f"the form is not filled in; {what} on {due.strftime('%-d %b')}"
        return {"step": step, "key": f"{tid}:{anchor.isoformat()}:{step}", "anchor": anchor, "tenancy": tenancy,
                "made": made, "expires": expires, "carried": carried}, ""
    return None, ""


def describe(item, first, place, chases, tid, day):
    """The name and description of the task a step raises."""
    carried, expires = item["carried"].strftime("%-d %b %Y"), item["expires"].strftime("%-d %b %Y")
    ref = f"\n\nReference for the rent check, please leave it in:\n{KEY_MARK}{item['key']}"
    if item["step"] != "roy":
        lapsed = (" The link has lapsed: make a new one with `python3 scripts/tenant-link.py make --tenant "
                  f"{tid}` and put it in the email.") if item["expires"] < day else ""
        return (f"{PREFIX}{place}, reminder {item['step']} to fill in the details form",
                f"Raised by the daily rent check on {day.strftime('%-d %b %Y')}.\n\n"
                f"{first} was emailed the tenant details form link on {carried} (it works until {expires}) and has "
                f"not filled it in. Draft reminder {item['step']}: a short, friendly email from info@agilelets.co.uk, "
                "signed Roy Lavin, Agile Lets, with the TEXT TO and TEXT lines, asking them to fill in the form with the "
                f"link in our earlier email and to reply if they need any help.{lapsed} Never mention arrears, court "
                "or notice." + ref)
    went = [str(chases.get(f"{tid}:{item['anchor'].isoformat()}:{s}", {}).get("sent") or "?") for s in ("1", "2")]
    return (f"{PREFIX}{place}, reach {first} in person: details form not filled in",
            f"Raised by the daily rent check on {day.strftime('%-d %b %Y')}.\n\n"
            f"{first} was emailed the tenant details form link on {carried}, and reminders went on {went[0]} and "
            f"{went[1]}, but the form is still not filled in, so the council claim cannot start. Please reach them by "
            "phone or in person and help them fill it in. You can make a fresh link with the Tenant form button on "
            "your Property Manager page. Reply to this email with what they say." + ref)


def first_name(name):
    words = str(name or "").split()
    return words[0] if words else "the tenant"


def run(rc, data, day, res, writes, on):
    """The form chase for every tenant ever sent a link, once a day. Never stops the rent check: a failure is said on
    the row and in the exit code. Writes only on a real run with the agent switched on."""
    out = {"on": bool(on), "raised": [], "planned": [], "stages": [], "problems": [], "failed": ""}
    if not on:
        return out
    fails = []
    try:
        links = read_links(rc)
        chases, cards = read_cards(rc, day)
        busy = rc.rent_cap.read_busy(rc)
        # Every tenancy judged live today: a green one carries no row of its own, only its lane (rent_cap.run).
        live = set(res.get("lanes") or {}) | {r["id"] for r in res.get("tenancies") or []}
        tys = {r["id"]: r.get("fields") or {} for r in data.get("tenancies") or []}
        no_chase = set(data.get("noChase") or ())
        ad = None
        if writes:
            # Roy's step is emailed to him; one still open is offered again (notify's ledger never sends twice).
            for key, task in chases.items():
                if key.endswith(":roy") and task["status"] not in CLOSED:
                    ad = ad or rc.lane_b_rules.module("ad")
                    try:
                        if rc.lane_b_rules.cut_off(rc.lane_b_rules.notify_roy(task["id"], ad.ROY_EMAIL)):
                            out["problems"].append(f"the email of task {task['id']} to Roy was cut off part way and is not sent twice")
                    except Exception as exc:      # noqa: BLE001 — said on the row
                        (out["problems"] if "REFUSED" in str(exc) else fails).append(
                            f"task {task['id']} could not be emailed to Roy: {str(exc)[:120]}")
        for tid, f in sorted(links.items()):
            item, stage = plan(tid, f, chases, cards.get(tid, []), day, live,
                               busy=bool(busy & set(f.get(TN["tenancies"]) or [])), no_chase=tid in no_chase)
            tenancy = item["tenancy"] if item else next((t for t in f.get(TN["tenancies"]) or [] if t in live), None)
            place = rc.lane_b_rules.place_name(rc.first((tys.get(tenancy) or {}).get(rc.TY["unitRef"]))
                                               or "(no unit linked)")
            if stage:
                out["stages"].append(f"{place}: {stage}")
            if not item:
                continue
            name, description = describe(item, first_name(f.get(TN["name"])), place, chases, tid, day)
            out["planned"].append(name)
            if not writes:
                continue
            fields = {rc.TK["name"]: name, rc.TK["status"]: "Today", rc.TK["due"]: day.isoformat(),
                      rc.TK["description"]: description, rc.TK["notes"]: KEY_MARK + item["key"],
                      rc.TK["tenancies"]: [item["tenancy"]], rc.TK["tenants"]: [tid]}
            if item["step"] == "roy":
                ad = ad or rc.lane_b_rules.module("ad")
                fields[rc.TK["teamMember"]] = [ad.HUMANS[ad.ROY_EMAIL]["rec"]]
                fields[ad.AF["assignee"]] = {"email": ad.ROY_EMAIL}
            else:
                fields[rc.TK["teamMember"]] = [rc.AGENT_TEAM_MEMBER]
            new = rc.api("POST", rc.T_TASKS, {"records": [{"fields": fields}]})["records"][0]["id"]
            out["raised"].append(name)
            if item["step"] == "roy":
                try:
                    if rc.lane_b_rules.cut_off(rc.lane_b_rules.notify_roy(new, ad.ROY_EMAIL)):
                        out["problems"].append(f"the email of task {new} to Roy was cut off part way and is not sent twice")
                except Exception as exc:          # noqa: BLE001 — the task stands on Roy's list; offered again next run
                    (out["problems"] if "REFUSED" in str(exc) else fails).append(
                        f"task {new} was raised but its email to Roy failed (offered again next run): {str(exc)[:120]}")
    except Exception as exc:                          # noqa: BLE001 — the row is the monitor; said, never swallowed
        fails.append(f"the form chase could not run: {str(exc)[:200]}")
    out["failed"] = "; ".join(fails)[:600]
    return out


def line(out):
    """The rent check row's line. Places and steps only: never a tenant's answers."""
    check = (" Check: " + "; ".join(out["problems"]) + ".") if out.get("problems") else ""
    if out.get("failed"):
        return f"Form chase FAILED: {out['failed']}{check}"
    if not out.get("on"):
        return f"Form chase: nothing raised, the Cash Flow Voids agent is switched off or unread.{check}"
    bits = []
    if out.get("raised"):
        bits.append("raised: " + "; ".join(out["raised"]))
    elif out.get("planned"):
        bits.append("a real run would raise: " + "; ".join(out["planned"]))
    if out.get("stages"):
        bits.append("; ".join(out["stages"]))
    return ("Form chase: " + ". ".join(bits) + "." if bits else "Form chase: no details form waiting.") + check
