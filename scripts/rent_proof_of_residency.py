"""Send a new tenant their signed proof of residency, with a copy to Roy (Kevin, 8 Oct 2026). Part of the rent check.

WHY THIS EXISTS
A new tenant's pack goes into Adobe as the tenancy agreement, the authority to act and the proof of residency. The
tenant signs the first two, so Adobe emails them those signed copies itself. Only we sign the proof of residency
(info@agilelets.co.uk, typed "Roy Lavin"), so Adobe sends its signed copy to info@ alone, and the tenant needs it for
their Universal Credit journal. Kevin, 28 Sep 2026: forward it from info@, a standing instruction with no approval
card. Kevin, 8 Oct 2026: send it to Roy's own inbox as well, and have the Cash Flow Voids lane do it. Until then every
forward was by hand from a Claude session or by Kevin, and one September proof of residency was never forwarded.

WHAT IT DOES, each rent check
  1. Reads info@'s Adobe "<document> between ... is Signed and Filed!" emails whose document is a proof of residency
     (Proof_of_Residency_<Name>, or the older ProofofResidency_<Name>) and that arrived on or after START. Each one
     earlier was forwarded by hand or left on purpose, and is never sent now.
  2. ONE send per pack. The signed copies of one document whose own "sent out for signature" emails fall within
     PACK_DAYS of each other are one pack (a retried Adobe send, 28 Sep 2026): the newest copy's PDF is sent, and a
     pack whose first copy came before START is never sent. The same name more than PACK_DAYS later is a new pack. It
     counts as sent when this lane's ledger holds a send of it, or when a forward ("Fwd:") naming it went from info@'s
     Sent or from the Sent of the mailbox Kevin works in (his own forwards from info@ land THERE, not in info@'s Sent),
     from a day before THIS pack went into Adobe: an earlier pack's send never covers a new one.
  3. Works out the tenant's address from Adobe's OWN emails for the SAME PACK: the "AST_<Name>_<house number>..." and
     "Authority_<Name>_<house number>..." "has been sent out for signature to <address>" emails from a day before this
     proof of residency first went into Adobe to PACK_DAYS after the last time. A name followed by more name
     (Ann_Lee_Smith for Ann_Lee) is another person. Our own mailboxes are never the tenant. Every such email must give
     the same one address: a second pack of the same name inside the window joins the read, so two people give two
     addresses and the send is held, and so is a pack whose name also went into Adobe earlier and was never signed.
     Never a name match against Airtable, never a guess.
  4. Sends ONE email from info@agilelets.co.uk to that address and Roy (agent-dispatch.py ROY_EMAIL), both in To as
     in Kevin's own forward of 8 Oct 2026, subject "Fwd: <Adobe's subject>", with Adobe's signed PDF attached, signed
     Roy Lavin, Agile Lets. The ledger row is written BEFORE the send: one that died part way is never sent twice.
  5. No address yet (the agreement reaches the tenant once info@ has signed it, often the next morning): waits, and
     says so. Still none after HOLD_DAYS, two different addresses, no signed PDF on Adobe's email, or a send that may
     have gone: ONE task for Kevin. His forward shows in his Sent, and that run, or a send by this lane, closes it.

THE CONTROL
A blind mailbox read and "nothing signed" look the same. Adobe emails info@ for every document sent and signed (the
tenancy packs, creditor letters of authority), so a read of SIGNED_Q over READ_DAYS that finds nothing at all fails
the run loudly rather than reporting "nothing to send". A read cut short is a failure too. Signed emails are read
READ_DAYS back and a pack is acted on only while its newest copy is LOOK_DAYS new, so every pack acted on is seen
whole: its first copy never drops out of the read while a later one is still in it.

KNOWN LIMITS: a proof of residency named some other way is not a proof of residency to this lane; an Adobe signed
email that names a residency document and does not parse is said on the row and on Home. A pack cancelled after its
proof of residency was signed is still sent: cancel nothing after info@ signs, or forward nothing and close the task.

Never sends while the Cash Flow Voids agent is switched off or unread, and never on a dry run.
"""

import base64
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_email_format import BUSINESS_SENDER, PERSONAL_SENDER, PROPERTY_SENDER, RUNPRENEUR_SENDER  # noqa: E402

START = date(2026, 10, 8)            # Kevin's ruling day: a proof of residency signed before it is never sent now
HOLD_DAYS = 2                        # how long a proof of residency waits for its tenant's address before Kevin is asked
LOOK_DAYS = 60                       # a pack is acted on while its newest signed copy is this new
PACK_DAYS = 7                        # a pack's agreement reaches the tenant within this of its proof of residency
READ_DAYS = LOOK_DAYS + 2 * PACK_DAYS + 2   # signed emails are read further back than that, so a pack is seen whole
MAX_PAGES = 8                        # 200 emails a read: Adobe sends about ten "Signed and Filed" a month
INBOX = PROPERTY_SENDER              # info@agilelets.co.uk: where Adobe writes, and the sender of this lane's email
KEVIN_MAILBOX = RUNPRENEUR_SENDER    # the mailbox Kevin works in: his own forwards from info@ land in ITS Sent
ADOBE = "adobesign@adobesign.com"
SIGNED_Q = f'from:{ADOBE} subject:"Signed and Filed" newer_than:%dd'
SENT_OUT_Q = f'from:{ADOBE} subject:"sent out for signature" newer_than:%dd'
OUR_SENT_Q = 'in:sent subject:"Signed and Filed" newer_than:%dd'
SIGNED_RE = re.compile(r"^(?P<doc>\S+) between .+ is Signed and Filed!?\s*$", re.I)
RESIDENCY_RE = re.compile(r"^(?:Proof_of_Residency|ProofofResidency)_(?P<stem>\S+)$", re.I)
SENT_OUT_RE = re.compile(r"^(?P<doc>\S+) has been sent out for signature to (?P<to>.+)$", re.I)
FORWARD_RE = re.compile(r"^\s*fwd?\s*:", re.I)
ADDRESS_RE = re.compile(r"[\w.+'-]+@[\w-]+(?:\.[\w-]+)+")
TENANT_DOCS = ("AST", "Authority")   # the pack's documents the tenant signs: Adobe names their address
OWN_DOMAINS = ("agilelets.co.uk", "runpreneur.org.uk", "operationsdirector.co.uk")
OWN_ADDRESSES = {PERSONAL_SENDER, PROPERTY_SENDER, RUNPRENEUR_SENDER, BUSINESS_SENDER}   # never a tenant's
LEDGER = os.path.expanduser("~/knowledge-os/logs/rent-check/proof-of-residency.jsonl")
PREFIX = "PROOF OF RESIDENCY: "
KEY_MARK = "RENT CHECK KEY: residency:"
CLOSED = ("Completed", "Cancelled")
LONDON = ZoneInfo("Europe/London")
# Written in code, never by a model. Kevin's published-copy rules: plain, short, no banned words.
BODY = ("Hello,\n\n"
        "Please find attached your signed proof of residency. Upload the document to your Universal Credit journal "
        "along with your tenancy agreement.\n\n"
        "Kind regards,\nRoy Lavin\nAgile Lets")


def subject(msg):
    return str((msg.get("headers") or {}).get("subject") or "").strip()


def from_adobe(msg):
    return ADOBE in str((msg.get("headers") or {}).get("from") or "").lower()


def arrived(msg):
    """When an email arrived (UTC), or None when it carries no readable date."""
    try:
        return datetime.fromtimestamp(int(msg.get("internalDate")) / 1000, tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def own(address):
    """One of our own mailboxes. Roy's own address is NOT one: a tenant with no email signs through it (Kevin's say-so,
    Sep 2026), and then the proof of residency goes to Roy alone."""
    a = address.lower()
    return a in OWN_ADDRESSES or a.endswith(tuple("@" + d for d in OWN_DOMAINS))


def names_doc(text, doc):
    """True when `text` names this exact document: Proof_of_Residency_Ann_Lee never matches ..._Ann_Lee_Smith."""
    return re.search(rf"(?<![\w]){re.escape(doc)}(?![\w])", str(text or ""), re.I) is not None


def residency(msg):
    """(doc, stem) of an Adobe signed email for a proof of residency, else None."""
    m = SIGNED_RE.match(subject(msg))
    if not m or not from_adobe(msg):
        return None
    r = RESIDENCY_RE.match(m.group("doc"))
    return (m.group("doc"), r.group("stem")) if r else None


def _sent_out(msg):
    """(doc, the words after "to") of an Adobe "sent out for signature" email, else None."""
    m = SENT_OUT_RE.match(subject(msg))
    return (m.group("doc"), m.group("to")) if m and from_adobe(msg) and arrived(msg) else None


def residency_outs(doc, sent_out):
    """When this proof of residency went into Adobe: the times of its own "sent out for signature" emails, oldest
    first. A retried send gives more than one."""
    return sorted(arrived(m) for m in sent_out if (_sent_out(m) or ("",))[0].lower() == doc.lower())


def tenant_doc(doc, stem):
    """True when an Adobe document name is this person's agreement or authority: AST_<Name> on its own, or
    AST_<Name>_<property>, where every property name opens with its house number. A longer name that starts the same
    way (AST_Ann_Lee_Smith_4_Other_Road for Ann_Lee) is another person."""
    doc = doc.lower()
    for k in TENANT_DOCS:
        head = f"{k}_{stem}".lower()
        if doc == head or (doc.startswith(head + "_") and doc[len(head) + 1:][:1].isdigit()):
            return True
    return False


def addresses(stem, sent_out, cluster):
    """Every tenant address in Adobe's own "sent out for signature" emails for this pack's agreement and authority:
    the same name, from a day before the first time this proof of residency went into Adobe to PACK_DAYS after the
    last. Lower case, our own mailboxes left out (the pack goes to info@ first, and Adobe names it "Agile Lets")."""
    if not cluster:
        return []
    lo, hi = min(cluster) - timedelta(days=1), max(cluster) + timedelta(days=PACK_DAYS)
    found = set()
    for msg in sent_out:
        got = _sent_out(msg)
        if not got or not (lo <= arrived(msg) <= hi) or not tenant_doc(got[0], stem):
            continue
        for a in ADDRESS_RE.findall(got[1]):
            a = a.lower().rstrip(".")
            if not own(a):
                found.add(a)
    return sorted(found)


def read_ledger(path):
    """[row] in order. A torn line is skipped: it is not a send."""
    out = []
    try:
        with open(path) as fh:
            for line in fh:
                try:
                    row = json.loads(line) if line.strip() else None
                except ValueError:
                    continue
                if row and row.get("doc"):
                    out.append(row)
    except FileNotFoundError:
        pass
    return out


def ledger_state(rows, doc, since):
    """The row that decides this document, among rows written on or after `since`: a `sent` row
    decides for ever; with none, the newest row decides: `intent` (died part way) and `uncertain` mean it may have
    gone, `failed` (refused before anything left) frees it. None when nothing decides."""
    mine = [r for r in rows if str(r.get("doc")).lower() == doc.lower() and _ts(r.get("ts")) >= since]
    sent = [r for r in mine if r.get("event") == "sent"]
    if sent:
        return sent[0]
    return mine[-1] if mine and mine[-1].get("event") in ("intent", "uncertain") else None


def _ts(v):
    try:
        return datetime.strptime(str(v)[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def ledger_append(path, row):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as fh:
        fh.write(json.dumps(row) + "\n")


def assess(signed, sent_mail, sent_out, rows, now, roy, start=START):
    """Pure. ([item], unreadable subjects). One item per proof of residency PACK whose first signed copy came on or
    after `start`, oldest first: {key, mail, doc, stem, at, copies, cluster, since, decision, why, to, pdf, subject}.
    decision: sent | send | wait | hold | uncertain.

    A pack: the signed copies of one document whose own "sent out for signature" emails (or, with none, the copies)
    fall within PACK_DAYS of the first. Copies of a retried send are one pack and one send; a new pack for the same
    name more than PACK_DAYS later is a new document. A send or forward of any copy of it from a day before the pack
    went into Adobe covers it. Its cluster is every time this document went into Adobe from PACK_DAYS before the pack
    to its last copy: a second pack of the same name inside that window joins the address read. Only packs whose
    newest copy is LOOK_DAYS new are returned; `signed` must reach READ_DAYS back, so each is whole."""
    by_doc, unreadable = {}, []
    for msg in signed:
        at = arrived(msg)
        if at is None:
            continue
        found = residency(msg)
        if not found:
            if at.astimezone(LONDON).date() >= start and re.search(r"residen", subject(msg), re.I):
                unreadable.append(subject(msg)[:120])
            continue
        by_doc.setdefault(found[0].lower(), []).append((at, msg, found))
    items = []
    for copies in by_doc.values():
        copies.sort(key=lambda c: c[0])
        outs = residency_outs(copies[0][2][0], sent_out)
        packs = []
        for c in copies:
            point = max([t for t in outs if t <= c[0]], default=None) or c[0]
            if packs and point - packs[-1]["point"] <= timedelta(days=PACK_DAYS):
                packs[-1]["copies"].append(c)
            else:
                packs.append({"point": point, "copies": [c]})
        # A signed pack accounts for every time its name went into Adobe within its own reach-back: a retried send.
        spans = [(pk["point"] - timedelta(days=PACK_DAYS), pk["copies"][-1][0]) for pk in packs]
        for pk in packs:
            first_at, last_at = pk["copies"][0][0], pk["copies"][-1][0]
            if first_at.astimezone(LONDON).date() < start:
                continue                              # the pack began before Kevin's ruling: never sent now
            if now - last_at > timedelta(days=LOOK_DAYS):
                continue                              # older than the step acts on (it is still read, so seen whole)
            newest = pk["copies"][-1][1]
            doc, stem = pk["copies"][-1][2]
            # The address read reaches back PACK_DAYS before this pack, so a same-name pack just before it is read too.
            cluster = [t for t in outs if pk["point"] - timedelta(days=PACK_DAYS) <= t <= last_at]
            # Coverage is this pack's own: an earlier pack's send never covers a new one.
            since = min(pk["point"], first_at) - timedelta(days=1)
            # A time this name went into Adobe before the address read, that no signed copy came from: a pack still
            # unsigned then, which may be this one (and this copy's own "sent out" another person's). Never guessed.
            stray = sorted(t for t in outs if t < pk["point"] - timedelta(days=PACK_DAYS)
                           and not any(lo <= t <= hi for lo, hi in spans))
            item = {"key": f"{doc.lower()}:{(since + timedelta(days=1)).astimezone(LONDON).date().isoformat()}",
                    "mail": str(newest.get("id") or ""), "doc": doc, "stem": stem, "at": first_at,
                    "copies": len(pk["copies"]), "cluster": cluster, "since": since, "to": [], "pdf": None,
                    "subject": subject(newest)}
            pdfs = [a for a in newest.get("attachments") or []
                    if str(a.get("filename") or "").lower().endswith(".pdf") and names_doc(a.get("filename"), doc)]
            item["pdf"] = pdfs[0] if len(pdfs) == 1 else None
            row = ledger_state(rows, doc, since)
            went = [m for m in sent_mail if FORWARD_RE.match(subject(m)) and names_doc(subject(m), doc)
                    and (arrived(m) or now) >= since]
            if row and row.get("event") == "sent":
                item.update(decision="sent", why=f"sent by this lane at {row.get('ts')}")
            elif went:
                item.update(decision="sent", why="already forwarded (it is in Sent)")
            elif row:
                item.update(decision="uncertain", why=f"a send at {row.get('ts')} may have gone and is never sent "
                                                      f"twice; it is not in {INBOX}'s Sent")
            else:
                found_to = addresses(stem, sent_out, cluster)
                late = now - first_at >= timedelta(days=HOLD_DAYS)
                if stray:
                    item.update(decision="hold", why=("this name also went into Adobe on "
                                                      + stray[-1].astimezone(LONDON).strftime("%-d %b %Y")
                                                      + " and that pack was never signed, so which person this is "
                                                        "cannot be told from Adobe's emails"), to=found_to)
                elif len(found_to) > 1:
                    item.update(decision="hold", why="Adobe sent this tenant's pack to more than one address: "
                                                     + ", ".join(found_to), to=found_to)
                elif not found_to:
                    why = ("Adobe's own email sending this proof of residency out was not found" if not cluster
                           else "no tenant address in Adobe's emails for this pack")
                    item.update(decision="hold" if late else "wait",
                                why=(f"{why} after {HOLD_DAYS} days" if late
                                     else "waiting for the agreement to go to the tenant, which names their address"))
                elif item["pdf"] is None:
                    item.update(decision="hold", why="Adobe's email does not carry exactly one signed PDF of it",
                                to=found_to)
                else:
                    item.update(decision="send", why="", to=found_to + ([roy] if roy not in found_to else []))
            items.append(item)
    return sorted(items, key=lambda i: i["at"]), unreadable


_TRI = []


def _triage():
    """scripts/inbound-triage.py, this lane's own copy: its worker calls, with its failure JSON kept off stdout (the
    rent check prints its own) and its reason kept for the row."""
    if not _TRI:
        import importlib.util
        here = os.path.dirname(os.path.abspath(__file__))
        spec = importlib.util.spec_from_file_location("inbound_triage_for_residency", os.path.join(here, "inbound-triage.py"))
        tri = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tri)
        tri._fail_quiet["on"] = True
        _TRI.append(tri)
    return _TRI[0]


def reason(exc):
    """The words a failure is said in: the worker's own message when inbound-triage's fail() raised it."""
    if isinstance(exc, SystemExit) and _TRI and _TRI[0]._last_fail.get("message"):
        return str(_TRI[0]._last_fail["message"])
    return str(exc)


def default_list_mail(q, account):
    """A mailbox through the Gmail worker inbound triage already uses: (messages, truncated)."""
    _triage()._last_fail.clear()                  # an earlier failure's words are never this one's
    return _triage().worker_list(q=q, max_pages=MAX_PAGES, account=account)


def default_fetch(mail_id, attachment_id, account):
    """One attachment's bytes through the Gmail worker."""
    _triage()._last_fail.clear()
    data = (_triage().worker_post("/gmail/attachment", {"messageId": mail_id, "attachmentId": attachment_id,
                                                        "account": account}) or {}).get("data") or ""
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def default_send(payload):
    """send-email.py's road to the worker, and its reading of a refusal: (result, None) or (None, (event, error))."""
    import importlib.util
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("send_email_for_residency", os.path.join(here, "send-email.py"))
    se = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(se)
    try:
        return se.worker_call(se.SEND_URL, payload), None
    except SystemExit as exc:
        error = str(exc)[:300]
        return None, ("failed" if se.NOT_SENT_RE.search(error) else "uncertain", error)


def send_one(item, fetch, send, ledger, now):
    """Send one proof of residency. Returns the message id; raises with the reason when it did not go."""
    raw = fetch(item["mail"], item["pdf"].get("attachmentId"), INBOX)
    if not raw.startswith(b"%PDF"):
        raise RuntimeError(f"the attachment on {item['doc']}'s email is not a PDF, so nothing was sent")
    payload = {"to": ", ".join(item["to"]), "from": INBOX, "subject": "Fwd: " + item["subject"], "text": BODY,
               "attachment": {"filename": os.path.basename(str(item["pdf"].get("filename"))),
                              "mimeType": "application/pdf", "dataB64": base64.b64encode(raw).decode()}}
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    ledger_append(ledger, {"doc": item["doc"], "mail": item["mail"], "ts": stamp, "event": "intent", "to": item["to"]})
    result, refused = send(payload)
    if refused:
        event, error = refused
        ledger_append(ledger, {"doc": item["doc"], "mail": item["mail"], "ts": stamp, "event": event, "error": error})
        raise RuntimeError(f"{item['doc']} was not sent ({event}): {error}")
    mid = str((result or {}).get("id") or "")
    ledger_append(ledger, {"doc": item["doc"], "mail": item["mail"], "ts": stamp, "event": "sent", "to": item["to"],
                           "messageId": mid})
    return mid


def read_holds(rc):
    """{item key: {id, status}} for every task this lane ever raised, whatever its status. The key is read from the
    Notes or the Description, so an edit to one of them never raises a twin."""
    out = {}
    for rec in rc.fetch_all(rc.T_TASKS, {"fields[]": [rc.TK["status"], rc.TK["notes"], rc.TK["description"]],
                                         "filterByFormula": f"OR(FIND('{KEY_MARK}', {{Notes}}&''), "
                                                            f"FIND('{KEY_MARK}', {{Description}}&''))"}):
        f = rec.get("fields") or {}
        for ln in (str(f.get(rc.TK["notes"]) or "") + "\n" + str(f.get(rc.TK["description"]) or "")).splitlines():
            if ln.strip().startswith(KEY_MARK):
                out[ln.strip()[len(KEY_MARK):].strip()] = {"id": rec["id"], "status": rc.sel(f.get(rc.TK["status"]))}
    return out


def raise_hold(rc, item, day):
    ad = rc.lane_b_rules.module("ad")
    found = (" Adobe's emails gave: " + ", ".join(item["to"]) + ".") if item["to"] else ""
    if item["decision"] == "uncertain":
        ask = (f"Look in {INBOX}'s Sent for an email with Adobe's PDF to the tenant and Roy. If it is not there, forward "
               f"Adobe's email (subject \"{item['subject']}\") from {INBOX} to the tenant and to Roy ({ad.ROY_EMAIL}).")
    else:
        ask = (f"Please forward Adobe's email (subject \"{item['subject']}\") from {INBOX} to the tenant and to Roy "
               f"({ad.ROY_EMAIL}). If the tenant has no email address, forward it to Roy only.")
    ref = f"{KEY_MARK}{item['key']}"
    description = (
        f"Raised by the daily rent check on {day.strftime('%-d %b %Y')}.\n\n"
        f"The proof of residency \"{item['doc']}\" was signed on {item['at'].astimezone(LONDON).strftime('%-d %b %Y')}, "
        f"and the robot did not send it to the tenant: {item['why']}.{found}\n\n{ask} The rent check sees your forward "
        f"in Sent and closes this task.\n\nReference for the rent check, please leave it in:\n{ref}")
    fields = {rc.TK["name"]: f"{PREFIX}{item['doc']}, forward it to the tenant and Roy",
              rc.TK["status"]: "Today", rc.TK["due"]: day.isoformat(), rc.TK["description"]: description,
              rc.TK["notes"]: ref,
              rc.TK["teamMember"]: [ad.HUMANS[ad.KEVIN_AIRTABLE_EMAIL]["rec"]],
              ad.AF["assignee"]: {"email": ad.KEVIN_AIRTABLE_EMAIL}}
    return rc.api("POST", rc.T_TASKS, {"records": [{"fields": fields}]})["records"][0]["id"]


def close_hold(rc, task_id, item, how):
    """Close a hold task once its proof of residency went. Field ids on both sides of the read-modify-write, and Notes
    that read blank are a STOP (a hold task always carries its key): see CLAUDE.md "Airtable queries"."""
    rec = rc.api("GET", f"{rc.T_TASKS}/{task_id}", params={"returnFieldsByFieldId": "true"})
    notes = str((rec.get("fields") or {}).get(rc.TK["notes"]) or "")
    if not notes.strip():
        raise RuntimeError(f"STOP: task {task_id}'s Notes read blank, so it was not closed")
    stamp = datetime.now().strftime("%d %b %Y %H:%M")
    line = f"[{stamp} — rent check] CLOSED: {item['doc']} {how}."
    rc.api("PATCH", rc.T_TASKS, {"records": [{"id": task_id, "fields": {
        rc.TK["status"]: "Completed", rc.TK["notes"]: (notes.rstrip() + "\n\n" + line).strip()[-90000:]}}]})


def _lock(ledger):
    """An exclusive lock for this lane's sends, or None when another run holds it (two runs reading the same empty
    ledger would both send)."""
    import fcntl
    os.makedirs(os.path.dirname(ledger), exist_ok=True)
    fh = open(ledger + ".lock", "a")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        return None
    return fh


def run(rc, now, writes, on, day=None, list_mail=None, fetch=None, send=None, ledger=None, start=START):
    """The proof of residency step, once per rent check. Never raises: a failure is said on the row and in the exit
    code. Sends and writes only on a real run with the Cash Flow Voids agent switched on."""
    out = {"on": bool(on), "checked": 0, "sent": [], "waiting": [], "held": [], "raised": [], "closed": [],
           "uncertain": [], "unreadable": [], "planned": [], "busy": False, "failed": ""}
    if not on:
        return out
    day = day or now.astimezone(LONDON).date()
    list_mail, fetch, send = list_mail or default_list_mail, fetch or default_fetch, send or default_send
    ledger = ledger or LEDGER
    fails, lock = [], None
    try:
        ad = rc.lane_b_rules.module("ad")
        signed, cut = list_mail(SIGNED_Q % READ_DAYS, INBOX)
        if cut:
            raise RuntimeError(f"the read of Adobe's signed emails to {INBOX} was cut short")
        if not signed:
            raise RuntimeError(f"control failed: no Adobe signed email reached {INBOX} in {READ_DAYS} days, so the "
                               "mailbox read is blind, not empty")
        pending = [arrived(m) for m in signed if residency(m) and arrived(m) and arrived(m).astimezone(LONDON).date() >= start]
        sent_mail, sent_out = [], []
        if pending:
            # A pack's cluster reaches PACK_DAYS before its anchor, which may come PACK_DAYS before its copy.
            back = (now - min(pending)).days + 2 * PACK_DAYS + 2
            for account in (INBOX, KEVIN_MAILBOX):
                got, cut = list_mail(OUR_SENT_Q % back, account)
                if cut:
                    raise RuntimeError(f"the read of {account}'s Sent was cut short, so nothing is sent")
                sent_mail += got
            sent_out, cut = list_mail(SENT_OUT_Q % back, INBOX)
            if cut:
                raise RuntimeError("the read of Adobe's \"sent out for signature\" emails was cut short")
        items, out["unreadable"] = assess(signed, sent_mail, sent_out, read_ledger(ledger), now, ad.ROY_EMAIL, start=start)
        out["checked"] = len(items)
        if not items:
            return out
        if writes:
            lock = _lock(ledger)
            if lock is None:
                out["busy"] = True
                return out
            items, _ = assess(signed, sent_mail, sent_out, read_ledger(ledger), now, ad.ROY_EMAIL, start=start)
        holds = read_holds(rc)
        for item in items:
            name = item["stem"].replace("_", " ")
            task = holds.get(item["key"])
            open_task = task if task and task["status"] not in CLOSED else None
            try:
                if item["decision"] == "sent":
                    if open_task and writes:
                        close_hold(rc, open_task["id"], item, f"is in Sent ({item['why']})")
                        out["closed"].append(open_task["id"])
                    continue
                if item["decision"] == "wait":
                    out["waiting"].append(name)
                    continue
                if item["decision"] in ("hold", "uncertain"):
                    out["held" if item["decision"] == "hold" else "uncertain"].append(f"{name} ({item['why']})")
                    if writes and not task:
                        out["raised"].append(raise_hold(rc, item, day))
                    continue
                out["planned"].append(f"{name} to {', '.join(item['to'])}")
                if writes:
                    send_one(item, fetch, send, ledger, now)
                    out["sent"].append(f"{name} to {', '.join(item['to'])}")
                    if open_task:
                        close_hold(rc, open_task["id"], item, "was sent to the tenant and Roy by the rent check")
                        out["closed"].append(open_task["id"])
            except (Exception, SystemExit) as exc:    # noqa: BLE001 — one document's failure never stops the next
                fails.append(f"{name}: {reason(exc)[:200]}")
    except (Exception, SystemExit) as exc:            # noqa: BLE001 — the inbox reader exits on a worker error;
        fails.append(f"the proof of residency step could not run: {reason(exc)[:200]}")   # the row is the monitor
    finally:
        if lock:
            lock.close()
    out["failed"] = "; ".join(fails)[:600]
    return out


def brief(out):
    """The words Home shows, or "" when there is nothing for Kevin. Short: Home prints 700 characters."""
    n = len(out.get("held") or []) + len(out.get("uncertain") or []) + len(out.get("unreadable") or [])
    if n:
        return f"Proof of residency: {n} not sent to the tenant, see your task or the rent check row."
    if out.get("failed"):
        return "Proof of residency step FAILED: see the rent check row."
    return ""


def line(out):
    """The rent check row's line: the whole story."""
    if not out.get("on"):
        return "Proof of residency: nothing sent, the Cash Flow Voids agent is switched off or unread."
    bits = []
    if out.get("sent"):
        bits.append("sent from info@: " + "; ".join(out["sent"]))
    elif out.get("planned"):
        bits.append(("a real run would send: " if not out.get("failed") else "not sent: ") + "; ".join(out["planned"]))
    if out.get("busy"):
        bits.append("another rent check was sending, so this run sent nothing")
    if out.get("waiting"):
        bits.append("waiting for the tenant's address: " + "; ".join(out["waiting"]))
    if out.get("held"):
        bits.append("held for Kevin: " + "; ".join(out["held"]))
    if out.get("uncertain"):
        bits.append("may have gone, held for Kevin: " + "; ".join(out["uncertain"]))
    if out.get("raised"):
        bits.append("task raised: " + ", ".join(out["raised"]))
    if out.get("closed"):
        bits.append("task closed: " + ", ".join(out["closed"]))
    if out.get("unreadable"):
        bits.append("cannot read, forward by hand: " + "; ".join(out["unreadable"]))
    if out.get("failed"):
        bits.append(f"FAILED: {out['failed']}")
    if not bits:
        return (f"Proof of residency: {out.get('checked', 0)} signed since {START.strftime('%-d %b %Y')}, "
                "every one sent.") if out.get("checked") else "Proof of residency: none signed and waiting."
    return "Proof of residency: " + ". ".join(bits) + "."


def main(argv=None):
    """`plan [--since YYYY-MM-DD]`: what the step would do now, read only, never sends or writes. --since reads further
    back than START, to show how each earlier proof of residency would have been addressed."""
    import argparse
    import importlib.util
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", choices=["plan"])
    ap.add_argument("--since", type=date.fromisoformat, default=START)
    a = ap.parse_args(argv)
    now = datetime.now(timezone.utc)
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("ad_for_residency", os.path.join(here, "agent-dispatch.py"))
    ad = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ad)
    days = max(READ_DAYS, (now.astimezone(LONDON).date() - a.since).days + 2)
    cut = {}
    signed, cut["signed"] = default_list_mail(SIGNED_Q % days, INBOX)
    sent_mail = []
    for account in (INBOX, KEVIN_MAILBOX):
        got, cut["sent " + account] = default_list_mail(OUR_SENT_Q % days, account)
        sent_mail += got
    sent_out, cut["sentOut"] = default_list_mail(SENT_OUT_Q % (days + 2 * PACK_DAYS), INBOX)
    items, unreadable = assess(signed, sent_mail, sent_out, read_ledger(LEDGER), now, ad.ROY_EMAIL, start=a.since)
    for item in items:
        item["addresses"] = addresses(item["stem"], sent_out, item["cluster"])
        item["cluster"] = [t.isoformat() for t in item["cluster"]]
    print(json.dumps({"since": a.since.isoformat(), "cutShort": [k for k, v in cut.items() if v], "unreadable": unreadable,
                      "items": [{k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in i.items() if k != "pdf"}
                                for i in items]}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
