"""Chase a tenant details form that has not been filled in (Kevin, 5 Oct 2026). Part of the daily rent check.

WHY THIS EXISTS
A capped tenant is sent a link to the tenant details form (Property Manager Worker, POST /tenant-form/link or
/robot-link), and the council claim cannot start until they fill it in. Kevin, 5 Oct 2026: "We need to have the
follow-up process for those and get Roy's involvement when we get to a certain stage where we're not getting
engagement." He approved the plan as-is the same day:

  day 3 after the link was made   reminder 1, drafted by the Cash Flow Voids agent (email + text, his approval)
  day 7                           reminder 2, the same
  day 10                          a task for Roy to reach the tenant in person or by phone

counted from the day the link was made (its expiry less LINK_DAYS: the Worker's own constant). One step at a
time: a step waits while the one before it is still with Kevin, and never comes within GAP_DAYS of the one before
it went. The chase stops when the form is saved after the link was made, when Kevin rejects a reminder (his call),
or after Roy's step. A tenant on the do-not-chase list, one a late-rent chase is talking to, or one with no live
tenancy linked is left alone. Only rent-check keys write here: `RENT CHECK KEY: details:<tenant>:<day made>:<step>`,
so a link made again inside the chase carries on the same chase instead of starting it over.
"""

import re
from datetime import date, datetime, timedelta

LINK_DAYS = 14                      # workers/property-manager/worker.js LINK_DAYS: a link is made `expires - 14`
STEPS = (("1", 3), ("2", 7), ("roy", 10))
GAP_DAYS = 3                        # never two steps within three days, however late Kevin approved the first
WINDOW_DAYS = 30                    # a chase older than this is history
PREFIX = "RENT DETAILS: "  # never "RENT FORM: ": the robot's direct rent payment form card
KEY_MARK = "RENT CHECK KEY: details:"
TN = {"name": "fldxBKW7QnujSDWqA", "saved": "fldc7XMcQcYY6C2Xa", "expires": "fldsgGmWIUX48t4I7",
      "tenancies": "fldWijr5nOIcKJMP4"}
LINKS_FORMULA = "LEN({Tenant Form Code Expires}&'')>0"     # field NAME: a rename is an error, never zero rows
SENT_RE = re.compile(r"\[(\d{2} \w{3} \d{4}) \d{2}:\d{2} — send-email\] SENT:")
CLOSED = ("Completed", "Cancelled")


def _day(v):
    try:
        return date.fromisoformat(str(v)[:10]) if v else None
    except ValueError:
        return None


def sent_on(notes):
    """The day the send door stamped a card SENT, or None."""
    m = SENT_RE.search(str(notes or ""))
    return datetime.strptime(m.group(1), "%d %b %Y").date() if m else None


def read_links(rc):
    """{tenant id: fields} for every tenant who was ever sent a details-form link."""
    rows = rc.fetch_all(rc.T_TENANTS, {"fields[]": list(TN.values()), "filterByFormula": LINKS_FORMULA})
    return {r["id"]: r.get("fields") or {} for r in rows}


def read_chases(rc):
    """{key: {id, status, sent}} for every form-chase task, whatever its status (a closed one is a step done)."""
    out = {}
    for rec in rc.fetch_all(rc.T_TASKS, {"fields[]": [rc.TK["status"], rc.TK["notes"]],
                                         "filterByFormula": f"FIND('{KEY_MARK}', {{Notes}}&'')"}):
        f = rec.get("fields") or {}
        notes = str(f.get(rc.TK["notes"]) or "")
        for line in notes.splitlines():
            if line.strip().startswith(KEY_MARK):
                out[line.strip()[len(KEY_MARK):].strip()] = {"id": rec["id"], "status": rc.sel(f.get(rc.TK["status"])),
                                                              "sent": sent_on(notes)}
    return out


def plan(tid, f, chases, day, live, busy=False, no_chase=False):
    """Pure. ({step, key, anchor, tenancy} to raise today or None, the stage in words or ""). `live` is the set of
    tenancies the rent check judged live today."""
    expires = _day(f.get(TN["expires"]))
    if expires is None:
        return None, ""
    made = expires - timedelta(days=LINK_DAYS)
    saved = _day(f.get(TN["saved"]))
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
    days = (day - anchor).days
    if days > WINDOW_DAYS or days < 0:
        return None, ""
    tenancy = next((t for t in f.get(TN["tenancies"]) or [] if t in live), None)
    if tenancy is None:
        return None, "the form is not filled in, but the tenant has no live tenancy linked, so nobody is chased"
    if no_chase:
        return None, "the form is not filled in; the tenant is on the do-not-chase list"
    if busy:
        return None, "the form is not filled in; a late-rent chase is talking to the tenant, so this one waits"
    before = None
    for step, at in STEPS:
        key = f"{tid}:{anchor.isoformat()}:{step}"
        task = chases.get(key)
        if task:
            if task["status"] == "Cancelled":
                return None, f"the form chase stopped: Kevin turned down step {step}"
            if task["status"] not in CLOSED:
                return None, f"form chase step {step} is with Kevin" if step != "roy" else "Roy is reaching the tenant"
            before = task["sent"] or before
            continue
        due = anchor + timedelta(days=at)
        if before:
            due = max(due, before + timedelta(days=GAP_DAYS))
        if day < due:
            what = f"reminder {step}" if step != "roy" else "Roy"
            return None, f"the form is not filled in; {what} on {due.strftime('%-d %b')}"
        return {"step": step, "key": key, "anchor": anchor, "tenancy": tenancy, "made": made, "expires": expires}, ""
    return None, "the form chase is done: Roy has it"


def describe(item, first, place, chases, tid, day):
    """The name and description of the task a step raises."""
    made, expires = item["made"].strftime("%-d %b %Y"), item["expires"].strftime("%-d %b %Y")
    ref = f"\n\nReference for the rent check, please leave it in:\n{KEY_MARK}{item['key']}"
    if item["step"] != "roy":
        lapsed = (" The link has lapsed: make a new one with `python3 scripts/tenant-link.py make --tenant "
                  f"{tid}` and put it in the email.") if item["expires"] < day else ""
        return (f"{PREFIX}{place}, reminder {item['step']} to fill in the details form",
                f"Raised by the daily rent check on {day.strftime('%-d %b %Y')}.\n\n"
                f"{first} was sent the tenant details form link on {made} (it works until {expires}) and has not "
                f"filled it in. Draft reminder {item['step']}: a short, friendly email from info@agilelets.co.uk, signed "
                "Roy Lavin, Agile Lets, with the TEXT TO and TEXT lines, asking them to fill in the form with the link "
                f"in our earlier email and to reply if they need any help.{lapsed} Never mention arrears, court or "
                "notice." + ref)
    went = [str(chases.get(f"{tid}:{item['anchor'].isoformat()}:{s}", {}).get("sent") or "?") for s in ("1", "2")]
    return (f"{PREFIX}{place}, reach {first} in person: details form not filled in",
            f"Raised by the daily rent check on {day.strftime('%-d %b %Y')}.\n\n"
            f"{first} was sent the tenant details form link on {made}, and reminders went on {went[0]} and {went[1]}, "
            "but the form is still not filled in, so the council claim cannot start. Please reach them by phone or in "
            "person and help them fill it in. You can make a fresh link with the Tenant form button on your Property "
            "Manager page. Reply to this email with what they say." + ref)


def run(rc, data, day, res, writes, on):
    """The form chase for every tenant ever sent a link, once a day. Never stops the rent check: a failure is said on
    the row and in the exit code. Writes only on a real run with the agent switched on."""
    out = {"on": bool(on), "raised": [], "planned": [], "stages": [], "problems": [], "failed": ""}
    if not on:
        return out
    fails = []
    try:
        links = read_links(rc)
        chases = read_chases(rc)
        busy = rc.rent_cap.read_busy(rc)
        # Every tenancy judged live today: a green one carries no row of its own, only its lane (rent_cap.run).
        live = set(res.get("lanes") or {}) | {r["id"] for r in res.get("tenancies") or []}
        tys = {r["id"]: r.get("fields") or {} for r in data.get("tenancies") or []}
        no_chase = set(data.get("noChase") or ())
        ad = None
        for tid, f in sorted(links.items()):
            item, stage = plan(tid, f, chases, day, live,
                               busy=bool(busy & set(f.get(TN["tenancies"]) or [])), no_chase=tid in no_chase)
            tenancy = item["tenancy"] if item else next((t for t in f.get(TN["tenancies"]) or [] if t in live), None)
            place = rc.lane_b_rules.place_name(rc.first((tys.get(tenancy) or {}).get(rc.TY["unitRef"]))
                                               or "(no unit linked)")
            if stage:
                out["stages"].append(f"{place}: {stage}")
            if not item:
                continue
            first = (str(f.get(TN["name"]) or "the tenant").split() or ["the tenant"])[0]
            name, description = describe(item, first, place, chases, tid, day)
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
                except Exception as exc:          # noqa: BLE001 — the task stands on Roy's list; said on the row
                    (out["problems"] if "REFUSED" in str(exc) else fails).append(
                        f"task {new} was raised but its email to Roy failed: {str(exc)[:120]}")
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
