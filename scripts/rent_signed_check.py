"""A signed tenancy agreement with no tenancy record raises a task (Kevin, 9 Oct 2026). Part of the rent check.

WHY THIS EXISTS
Kevin, 9 Oct 2026: "We've had some move-ins and stuff as well that should have been processed, and I'm not sure they
have been." Read that day: a new tenant who signed on 8 Oct had no tenant or tenancy record, and a continuing
tenant who signed a new agreement at a higher rent on 11 Sep still had the tenancy at the old rent. Nothing compared
what Adobe said was signed with what Airtable held, so both read as "fine": one did not exist to be late, the other
looked paid at the old rent.

WHAT IT DOES, each rent check
  1. Reads info@'s Adobe "AST_<...> between ... is Signed and Filed!" emails that arrived on or after START
     (rent_proof_of_residency's own mailbox read, so its control applies: a blind read fails the run).
  2. Reads each agreement's OWN words from its signed PDF, once (cached per Gmail message id in CACHE, read again when
     the cached house, rent or start is missing or an older parser read it): the rent ("the rent of £X"), the start
     ("commencing on <date>"), and from the HEADER LINE only (the line near the top holding " — " and "£") the
     tenant's name (the words before the first " — ") and the house (the first part of the address after it, a
     numbered house or a named building). Never from any other line: "Assured Shorthold Tenancy - 2 parts" is not a
     house. No house in the header: the Adobe document name (AST_<Name>_<house words>). No name in the header: the one
     person Adobe names besides us. Two people ("A and B"), or two signers besides us with no header to say which is
     the tenant (a guarantor signing last), is SEVERAL: recorded as such, and never onboarded as one person.
  3. The agreement is on record when SOME tenancy (live or ended) starts within START_SLACK_DAYS of that date, at that
     rent, for a tenant whose name shares the agreement's name words: a move-in (a new tenant and tenancy) or a rent
     change (a NEW tenancy at the new rent: Kevin, 5 Oct 2026). It is on record too as a RENEWAL: the same tenant
     still has a live tenancy at that house at that same rent, so nothing changed.
  4. Otherwise ONE task for the Cash Flow Voids agent, who owns the tenancy record (Kevin, 9 Oct 2026):
     `TENANCY RECORD: signed agreement with no tenancy: <house>`, carrying the agreement's facts on fixed lines
     (AGREEMENT NAME/RENT/START/HOUSE) that scripts/tenancy-record.py `onboard` and `rent-change` hold the agent to.
     Key `TENANCY RECORD KEY: <message id>` in Notes and the Description: never raised twice for one agreement.
     While its task is open the row and Home say it is unrecorded. Once its task is Completed or Cancelled the
     agreement leaves Home and the count, and the row lists it as "closed by its task".
  5. An agreement whose rent or start cannot be read still raises the task, saying what could not be read: an
     agreement that cannot be checked is not an agreement on record.

WHAT IT NEVER DOES
Writes no tenancy or tenant: the agent does that through the door. Sends nothing. Raises nothing on a dry run or
while the Cash Flow Voids agent is switched off or unread.
"""
import json
import os
import re
import unicodedata
from datetime import date, datetime

import rent_proof_of_residency as por

START = date(2026, 9, 10)            # the start of the first agreement Kevin's 9 Oct check found unrecorded
START_SLACK_DAYS = 7                 # a tenancy started this close to the agreement's own start is that agreement
RENT_SLACK = 0.01
PARSE_VERSION = 2                    # a cached reading by an older parser is read again (9 Oct 2026 review)
HEADER_LINES = 10                    # the header (the pack's reference line) sits under the title
PREFIX = "TENANCY RECORD: signed agreement with no tenancy: "
KEY_MARK = "TENANCY RECORD KEY: "
CLOSED = ("Completed", "Cancelled")
CACHE = os.path.expanduser("~/knowledge-os/logs/rent-check/signed-agreements.json")
AST_RE = re.compile(r"^AST_", re.I)
SIGNERS_RE = re.compile(r"\sbetween\s+(?P<who>.+?)\s+is\s+Signed\s+and\s+Filed!?\s*$", re.I)
RENT_RE = re.compile(r"rent of £\s*(?P<rent>[\d,]+\.\d{2})", re.I)
START_RE = re.compile(r"commencing on\s+(?P<start>\d{1,2}\s+[A-Za-z]+\s+\d{4})", re.I)
DASH = " — "
# Our own names as Adobe lists the signers: never the tenant.
OURS = {"agile lets", "agile lets limited", "agile lets ltd", "kevin brittain", "roy lavin"}
# "Flat 2, 18 Example Road": the unit part of an address is not the house.
UNIT_PART_RE = re.compile(r"^(flat|unit|room|apartment|apt)\.?\s*\w+$", re.I)
TWO_PEOPLE_RE = re.compile(r"\s(?:and|&)\s", re.I)
# A pack's document name: AST_<Name>_<house>, AST_Joint_<house>, AST_Whole_<Name>_<house>.
DOC_MARKS = {"joint", "whole"}
FIELDS = ("AGREEMENT NAME", "AGREEMENT RENT", "AGREEMENT START", "AGREEMENT HOUSE")


def norm(text):
    """NFKC: the PDF's text layer writes ligatures (an "Oakﬁeld" written with one "ﬁ" character; seen live on 9 Oct 2026)."""
    return unicodedata.normalize("NFKC", str(text or ""))


def words(name):
    return {w for w in re.findall(r"[a-z]+", norm(name).lower()) if len(w) >= 2}


def same_person(a, b):
    """Every word of the shorter name is in the longer one, and there are at least two: "Ann lee jones" (Adobe's
    casing) is "Ann Lee Jones", "Sam smith" is "Sam Smith", a lone "Smith" is nobody."""
    wa, wb = words(a), words(b)
    small, big = (wa, wb) if len(wa) <= len(wb) else (wb, wa)
    return len(small) >= 2 and small <= big


def house_key(text):
    """Lower-case words and numbers of a house or unit name, one space apart."""
    return " ".join(re.findall(r"[a-z0-9]+", norm(text).lower()))


def same_house(house, place):
    """True when `place` (a unit name, "Unit 1 – 18 Example Road") names `house` as WHOLE words: "8 Example Road" is
    not "18 Example Road", and "Example Building" is not "Example Buildings"."""
    h, p = house_key(house), house_key(place)
    return bool(h) and re.search(rf"(?<![a-z0-9]){re.escape(h)}(?![a-z0-9])", p) is not None


def signers(subject):
    """The people Adobe lists as signers, ourselves left out, in its order."""
    m = SIGNERS_RE.search(norm(subject))
    if not m:
        return []
    out = []
    for part in re.split(r",\s*|\s+and\s+", m.group("who")):
        part = " ".join(part.split())
        if part and part.lower() not in OURS:
            out.append(part)
    return out


def header_line(text):
    """The agreement's header (its reference line): the first line near the top, above "THIS AGREEMENT is made",
    holding " — " and "£". A header the PDF wrapped before its "£" is read with the line after it."""
    lines = [ln.strip() for ln in norm(text).splitlines() if ln.strip()][:HEADER_LINES]
    body = next((i for i, ln in enumerate(lines) if ln.upper().startswith("THIS AGREEMENT")), None)
    lines = lines[:body] if body is not None else lines        # the header sits above the agreement's own words
    for i, ln in enumerate(lines):
        if DASH in ln and "£" in ln:
            return ln
        if DASH in ln and i + 1 < len(lines) and "£" in lines[i + 1] and DASH not in lines[i + 1]:
            return ln + " " + lines[i + 1]
    return ""


def house_of_address(address):
    """The house in an address: its first part ("18 Example Road, Testtown" is "18 Example Road"), a named building
    with no number included ("Example Building, Back Lane, Testtown"); a unit part before it is skipped."""
    for part in [p.strip(" .") for p in str(address or "").split(",")]:
        if not part or UNIT_PART_RE.match(part):
            continue
        return " ".join(part.split()) if re.search(r"[A-Za-z]{2}", part) else None
    return None


def house_of_doc(doc, names):
    """The house in an Adobe document name, AST_<Name>_<house words>: what follows the name. With no name that fits,
    what follows the first number. None when neither is there."""
    tokens = [t for t in re.split(r"_+", norm(doc)) if t]
    if tokens and tokens[0].upper() == "AST":
        tokens = tokens[1:]
    while tokens and tokens[0].lower() in DOC_MARKS:
        tokens = tokens[1:]
    low = [t.lower() for t in tokens]
    for name in names:
        want = [w.lower() for w in re.findall(r"[A-Za-z0-9]+", norm(name))]
        if want and low[:len(want)] == want and len(tokens) > len(want):
            return " ".join(tokens[len(want):])
    at = next((i for i, t in enumerate(tokens) if re.match(r"^\d", t)), None)
    return " ".join(tokens[at:]) if at is not None else None


def parse_agreement(text, doc="", subject=""):
    """What the agreement says, read off its own words: {rent, start, house, name, several, signers, v}. A value that
    cannot be read is None (name: "")."""
    text = norm(text)
    rent = start = None
    m = RENT_RE.search(text)
    if m:
        rent = float(m.group("rent").replace(",", ""))
    m = START_RE.search(text)
    if m:
        try:
            start = datetime.strptime(" ".join(m.group("start").split()), "%d %B %Y").date()
        except ValueError:
            start = None
    head = header_line(text)
    parts = [p.strip() for p in head.split(DASH)] if head else []
    head_name = parts[0] if parts and re.search(r"[A-Za-z]{2}", parts[0]) else ""
    house = house_of_address(parts[1]) if len(parts) > 1 else None
    who = signers(subject)
    several = bool(head_name and TWO_PEOPLE_RE.search(head_name)) or (not head_name and len(who) > 1)
    name = head_name or (who[0] if len(who) == 1 else "")
    if not house:
        house = house_of_doc(doc, [n for n in [head_name] + who if n])
    return {"rent": rent, "start": start.isoformat() if start else None, "house": house, "name": name,
            "several": several, "signers": who, "v": PARSE_VERSION}


def read_cache(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {}
    except ValueError:
        return {}                     # an unreadable cache is re-read from Gmail, never trusted


def write_cache(path, cache):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(cache, fh, indent=1)
    os.replace(tmp, path)


def stale(a):
    """A cached reading to take again: missing, by an older parser, or with no house, rent or start."""
    return (not a or a.get("v") != PARSE_VERSION or a.get("rent") is None or not a.get("start")
            or not a.get("house"))


def default_text(raw):
    return por._triage().attachment_pdf_text(raw)


def _day(v):
    try:
        return date.fromisoformat(str(v or "")[:10])
    except ValueError:
        return None


def on_record(agreement, tenancies, tenant_names, day=None):
    """(tenancy id, how) of the tenancy that records this agreement, or None. `tenancies` are {id, fields: {start,
    rent, tenants, unit, end}}. how: "" for a tenancy that starts with it, "renewal" for a live one at that house at
    that same rent (nothing to record)."""
    start = _day(agreement.get("start"))
    if not start or agreement.get("rent") is None:
        return None
    day = day or date.today()

    def mine(f):
        return any(same_person(agreement.get("name"), tenant_names.get(tid, "")) for tid in f.get("tenants") or [])

    renewal = None
    for t in tenancies:
        f = t.get("fields") or {}
        if abs(float(f.get("rent") or 0) - agreement["rent"]) > RENT_SLACK or not mine(f):
            continue
        t_start = _day(f.get("start"))
        if t_start and abs((t_start - start).days) <= START_SLACK_DAYS:
            return t["id"], ""
        end = _day(f.get("end"))
        units = f.get("unit") or []
        units = units if isinstance(units, list) else [units]
        if (renewal is None and (end is None or end >= day) and agreement.get("house")
                and any(same_house(agreement["house"], u) for u in units)):
            renewal = (t["id"], "renewal")
    return renewal


def one_per_agreement(agreements):
    """Adobe can email info@ two copies of one "Signed and Filed" (review, 9 Oct 2026): the same document signed in
    the same minute is ONE agreement, keyed by its lowest Gmail id, carrying every copy's id in `copies`."""
    groups = {}
    for a in agreements:
        groups.setdefault((str(a.get("doc") or "").lower(), a.get("signed")), []).append(a)
    out = []
    for copies in groups.values():
        copies.sort(key=lambda c: c["mail"])
        out.append(dict(copies[0], copies=[c["mail"] for c in copies]))
    return out


def task_text(a, day):
    house = a.get("house") or a["doc"]
    missing = [w for w, k in (("rent", "rent"), ("start date", "start")) if a.get(k) is None]
    rent = f"{a['rent']:.2f}" if a.get("rent") is not None else "not read"
    lines = [f"The daily rent check found a signed tenancy agreement with no tenancy record ({day.strftime('%-d %b %Y')}).",
             "", f"Adobe: {a['subject']} (Gmail {a['mail']}, signed {a['signed']}).",
             f"AGREEMENT NAME: {a.get('name') or 'not read'}", f"AGREEMENT RENT: {rent}",
             f"AGREEMENT START: {a.get('start') or 'not read'}", f"AGREEMENT HOUSE: {house}", ""]
    if missing:
        lines.append(f"Could not read the {' or the '.join(missing)} off the agreement: open the signed PDF on that email.")
    if len(a.get("copies") or []) > 1:
        lines.append(f"Adobe emailed {len(a['copies'])} copies of this agreement (Gmail {', '.join(a['copies'])}): this one "
                     "task is for all of them.")
    if a.get("several"):
        lines.append(f"This agreement names more than one person ({a.get('name') or ', '.join(a.get('signers') or [])}): "
                     "onboard refuses it. A joint tenancy, or a guarantor who signed with the tenant, is Kevin's, on a card.")
    lines += ["What to do (you own the tenancy record, Kevin 9 Oct 2026). Every write needs Kevin's approval of THIS task "
              "as-is, with its RECORD CHANGE line in your output:",
              "- The tenant already has a live tenancy at this house at another rent: it is a rent change. Put "
              f"`RECORD CHANGE: <old tenancy> Rent change = {a['mail']}` on the card; once approved, "
              "`python3 scripts/tenancy-record.py rent-change <old tenancy> --task <this task> --why \"...\"`.",
              "- A new tenant: find the unit from the pack task that built this agreement. Put "
              f"`RECORD CHANGE: {a['mail']} Onboard = unit <rental unit id> (<its Rental Unit name, e.g. Unit 2 – 7 Example "
              "Close>), due <day>, <Universal Credit|Working|Agent-Managed>, <email>` on the card (add `, replace <live "
              "tenancy id> (<its Unit Reference>)` when the unit is occupied; `onboard --dry-run` prints the exact line); "
              "once approved, "
              "`python3 scripts/tenancy-record.py onboard --task <this task> --unit <rental unit> --due-day N --type "
              "\"Universal Credit\" --email ... [--replace <live tenancy>] --why \"...\"`.",
              "- Not ours to record (a cancelled pack, a test): say so in a report, quoting the evidence, and close it.",
              "", KEY_MARK + a["mail"]]
    return PREFIX + house, "\n".join(lines)


def read_raised(rc):
    """{message id: {id, status}} of every task that carries this lane's key, whatever its status."""
    got = {}
    for rec in rc.fetch_all(rc.T_TASKS, {"fields[]": [rc.TK["notes"], rc.TK["description"], rc.TK["status"]],
                                         "filterByFormula": f"FIND('{KEY_MARK.strip()}', {{Notes}} & {{Description}})"}):
        f = rec.get("fields") or {}
        for m in re.finditer(re.escape(KEY_MARK) + r"(\S+)", f"{f.get(rc.TK['notes']) or ''}\n{f.get(rc.TK['description']) or ''}"):
            got.setdefault(m.group(1), {"id": rec["id"], "status": rc.sel(f.get(rc.TK["status"]))})
    return got


def tenancy_rows(rc, tenancies):
    """The rent check's tenancies in on_record's shape."""
    out = []
    for t in tenancies:
        f = t.get("fields") or {}
        out.append({"id": t["id"], "fields": {"start": f.get(rc.TY["start"]), "rent": f.get(rc.TY["rent"]),
                                              "tenants": f.get(rc.TY["tenants"]), "unit": f.get(rc.TY["unitRef"]),
                                              "end": f.get(rc.TY["end"])}})
    return out


def read_names(rc, tys):
    """{tenant id: name} of every tenant those tenancies link. Zero names for a linked tenant is a broken read."""
    wanted = {tid for t in tys for tid in (t["fields"]["tenants"] or [])}
    names = {}
    if wanted:
        for rec in rc.fetch_all(rc.T_TENANTS, {"fields[]": [rc.lane_b_rules.TENANT_NAME_FIELD]}):
            if rec["id"] in wanted:
                names[rec["id"]] = str((rec.get("fields") or {}).get(rc.lane_b_rules.TENANT_NAME_FIELD) or "")
    if wanted and not names:
        raise RuntimeError("control failed: no tenant name could be read, so no agreement can be matched")
    return names


def run(rc, now, writes, on, data, day=None, list_mail=None, fetch=None, text_of=None, cache_path=None, start=START):
    """The step, once per rent check. Never raises: a failure is said on the row and in the exit code."""
    out = {"on": bool(on), "checked": 0, "recorded": [], "unrecorded": [], "closed": [], "raised": [], "planned": [],
           "failed": ""}
    if not on:
        return out
    day = day or now.astimezone(por.LONDON).date()
    list_mail = list_mail or por.default_list_mail
    fetch = fetch or por.default_fetch
    text_of = text_of or default_text
    cache_path = cache_path or CACHE
    try:
        signed, cut = list_mail(por.SIGNED_Q % ((day - start).days + 2), por.INBOX)
        if cut:
            raise RuntimeError(f"the read of Adobe's signed emails to {por.INBOX} was cut short")
        if not signed:
            raise RuntimeError(f"control failed: no Adobe signed email reached {por.INBOX} since {start}, so the "
                               "mailbox read is blind, not empty")
        cache, dirty = read_cache(cache_path), False
        agreements = []
        for msg in signed:
            m = por.SIGNED_RE.match(por.subject(msg))
            when = por.arrived(msg)
            if not m or not por.from_adobe(msg) or not AST_RE.match(m.group("doc")) or not when:
                continue
            if when.astimezone(por.LONDON).date() < start:
                continue
            mail = str(msg.get("id") or "")
            a = cache.get(mail)
            if stale(a):
                pdf = next((x for x in (msg.get("attachments") or [])
                            if str(x.get("filename") or "").lower().endswith(".pdf")), None)
                text = ""
                if pdf:
                    text, _why = text_of(fetch(mail, pdf.get("attachmentId"), por.INBOX))
                a = dict(parse_agreement(text, m.group("doc"), por.subject(msg)), mail=mail, doc=m.group("doc"),
                         subject=por.subject(msg), signed=when.astimezone(por.LONDON).strftime("%-d %b %Y %H:%M"))
                cache[mail], dirty = a, True
            agreements.append(a)
        if dirty and writes:
            write_cache(cache_path, cache)
        agreements = one_per_agreement(agreements)
        out["checked"] = len(agreements)
        if not agreements:
            return out
        tys = tenancy_rows(rc, data["tenancies"])
        names = read_names(rc, tys)
        raised = read_raised(rc)
        for a in sorted(agreements, key=lambda a: a["mail"]):
            label = f"{a.get('name') or 'unknown tenant'}, {a.get('house') or a['doc']}"
            rec = on_record(a, tys, names, day)
            if rec:
                out["recorded"].append(f"{label} ({rec[0]}{', a renewal at the same rent' if rec[1] else ''})")
                continue
            # Any copy's id finds the task: a second copy is the same agreement, never a second task.
            task = next((raised[m] for m in a["copies"] if m in raised), None)
            if task and task["status"] in CLOSED:
                # The agent closed it, with its reason on the task (not ours, a cancelled pack): off Home and the count.
                out["closed"].append(f"{label} (closed by its task {task['id']}, {task['status']})")
                continue
            out["unrecorded"].append(label + (f" (task {task['id']})" if task else ""))
            if task:
                continue
            name, text = task_text(a, day)
            if not writes:
                out["planned"].append(name)
                continue
            fields = {rc.TK["name"]: name, rc.TK["status"]: "Today", rc.TK["due"]: day.isoformat(),
                      rc.TK["teamMember"]: [rc.AGENT_TEAM_MEMBER], rc.TK["description"]: text,
                      rc.TK["notes"]: KEY_MARK + a["mail"]}
            made = rc.api("POST", rc.T_TASKS, {"records": [{"fields": fields}]})
            out["raised"].append(made["records"][0]["id"])
    except (Exception, SystemExit) as exc:                    # noqa: BLE001 — the row is the monitor
        out["failed"] = por.reason(exc)[:300]
    return out


def brief(out):
    """Home's words, or ""."""
    if out.get("unrecorded"):
        n = len(out["unrecorded"])
        return f"Signed agreements with no tenancy record: {n}. The Cash Flow Voids agent has the task."
    if out.get("failed"):
        return "Signed-agreement check FAILED: see the rent check row."
    return ""


def line(out):
    if not out.get("on"):
        return "Signed agreements: not checked, the Cash Flow Voids agent is switched off or unread."
    bits = []
    if out.get("unrecorded"):
        bits.append("NO TENANCY RECORD for: " + "; ".join(out["unrecorded"]))
    if out.get("raised"):
        bits.append("task raised: " + ", ".join(out["raised"]))
    if out.get("planned"):
        bits.append("a real run would raise: " + "; ".join(out["planned"]))
    if out.get("closed"):
        bits.append("not recorded, closed by its task: " + "; ".join(out["closed"]))
    if out.get("failed"):
        bits.append(f"FAILED: {out['failed']}")
    since = START.strftime("%-d %b %Y")
    if not bits:
        return (f"Signed agreements: {out.get('checked', 0)} since {since}, every one on record."
                if out.get("checked") else f"Signed agreements: none since {since}.")
    if not out.get("unrecorded") and not out.get("failed"):
        bits.insert(0, f"{len(out.get('recorded') or [])} of {out.get('checked', 0)} since {since} on record")
    return "Signed agreements: " + ". ".join(bits) + "."
