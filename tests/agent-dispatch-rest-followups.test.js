import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// THE REST FOLLOW-UPS LEFT OPEN BY THE REVIEW OF PR 938 (16 Nov 2026, Kevin: "Do it now").
//
//   4. Any sentence passed as --changed, "x" included: it must now name a field that changed or quote
//      the text added since the last rest.
//   5. A plain `complete` closed a task woken by a change with no question: it now asks the same
//      --changed a keep-open does, and writes the sentence with the close.
//   6. A wall and its clear erased the wake: a woken task that met a sign-in wall came back from the
//      clear with no wokeByChange, and a keep-open buried the reply.
//   8. A note one run left blocked every later status filing on that task for good: a status filing is
//      now compared with its last rest only on the fields a run never writes.
//
// Everything drives the real code. Airtable is an in-memory store, every network door raises (urlopen,
// socket connect, create_connection), state goes to temp folders. Names, ids and addresses are invented.

const PRE = `
import importlib.util, json, os, io, sys, contextlib, types, tempfile, socket, urllib.request
from datetime import datetime as _dt, timedelta, timezone
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
socket.socket.connect = boom
socket.create_connection = boom
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
STATE = tempfile.mkdtemp()
m.STATE_DIR = STATE
m.INTENT_LEDGER = os.path.join(STATE, "carryout-intent.jsonl")
m.NOTES_ARCHIVE = STATE
m.HANDOVER_DIR = tempfile.mkdtemp()
m.BROWSER_LEDGER = "/nonexistent/od-test-browser-ledger.jsonl"
AF = m.AF
SHIFT = [timedelta(0)]
_NOON = _dt.now(m.LONDON).replace(hour=12, minute=0, second=0, microsecond=0)
def _real_now(tz=None):
    return _NOON.astimezone(tz) if tz else _NOON.astimezone().replace(tzinfo=None)
class Clock(_dt):
    @classmethod
    def now(cls, tz=None):
        return _real_now(tz) + SHIFT[0]
m.datetime = Clock
AGENT = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-builder"][0]
TODAY = _real_now(m.LONDON).date()
def day(n): return (TODAY + timedelta(days=n)).isoformat()
CREATED = (_real_now(timezone.utc) - timedelta(days=40)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
TASKS = {}
def rec(i, notes="", approved=True, desc="Chase Exampleton Council about the bill. Contact: recovery@exampleton-council.test"):
    f = {AF["name"]: "Chase: Exampleton Council - council tax account 70012345", AF["status"]: {"name": "Today"},
         AF["teamMember"]: [AGENT], AF["notes"]: notes, AF["description"]: desc}
    if approved:
        f.update({AF["approvalOutcome"]: {"name": "Approved as-is"}, AF["approvedAt"]: "2026-09-01T09:00:00.000Z",
                  AF["sentForApprovalBy"]: [AGENT]})
    TASKS[i] = {"id": i, "createdTime": CREATED, "fields": f}
F = lambda i: TASKS[i]["fields"]
m.get_task = lambda i: json.loads(json.dumps(TASKS[i]))
def patch(i, f):
    TASKS[i]["fields"].update(f)
    return {"id": i}
m.patch_task = patch
m.query_tasks = lambda formula, **kw: [json.loads(json.dumps(t)) for t in TASKS.values()] if formula == m.QUEUE_FORMULA else []
m.fetch_role_roster = lambda: {}
m.fetch_ai_agents = lambda: {}
m.finding_details = lambda: {}
m.task_fields_owe_certificate = lambda *a, **k: []
m.task_owes_cost = lambda *a, **k: []
m.task_owes_certificate = lambda *a, **k: ""
def quiet(fn, *a):
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            fn(*a)
        return None
    except SystemExit as e:
        return str(e)
def complete(i, keep_open=True, **kw):
    a = dict(task=i, keep_open=keep_open, note="chased the council", until=day(10) if keep_open else "",
             no_certificate="", evidence="", not_signed="", diary_not_written="", cost_not_written="",
             not_bought="", changed="")
    a.update(kw)
    return quiet(m.cmd_complete, types.SimpleNamespace(**a))
def annotate(i, note):
    return quiet(m.cmd_annotate, types.SimpleNamespace(task=i, note=note, agent=AGENT, by=None))
QUIET = {"terms": ["email x"], "searched": ["tasks", "Gmail"], "entries": [], "notes": []}
def submit_status(i, nxt):
    m.history = lambda **kw: dict(QUIET)
    body = (f"STATUS ONLY: No reply from the council yet and nothing new has arrived.\\nNEXT CHECK: {nxt}\\n\\n"
            "What I checked: the council's portal and both inboxes.\\n\\n"
            "TRACK RECORD: none found (searched tasks + Gmail for email recovery@exampleton-council.test)\\n\\n"
            "**Carrying this out will involve:** Nothing. Information only.")
    fh = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False); fh.write(body); fh.close()
    return quiet(m.cmd_submit, types.SimpleNamespace(task=i, agent=AGENT, type="Research", output_file=fh.name, tier1=False,
                 attach=None, plain_task="Check whether the council has replied about the bill.",
                 plain_approve="Nothing to approve. The update is listed under Handled without you."))
SN = [0]
os.environ.pop("AGENT_RUN_QUEUE", None)
def snapshot():
    q = m.build_queue()
    SN[0] += 1
    d = os.path.join(STATE, "%06d-run" % SN[0]); os.makedirs(d)
    path = os.path.join(d, "queue.json")
    with open(path, "w") as fh:
        json.dump(q, fh, default=str)
    os.environ["AGENT_RUN_QUEUE"] = path
    return {t["id"]: t for t in q["worklist"] + q["reserve"]}
LOOK = "[" + (TODAY - timedelta(days=5)).strftime("%d %b %Y") + " 09:00 — agent-dispatch] SUBMITTED (round 1) as Research with no new file"
REPLY = "NEW MESSAGE " + day(1) + ": Exampleton Council replied on the same thread. FINAL NOTICE. Enforcement agents from the 24th."
def woken(i):
    """A task kept open, then a reply appended, then the rest's date passes: handed to the next run."""
    rec(i)
    assert complete(i, until=day(14)) is None, i
    F(i)[AF["description"]] += "\\n\\n" + REPLY
`;

function py(snippet) {
  const out = execFileSync('python3', ['-c', PRE + snippet], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OD_HOLDS_FILE: resolve(ROOT, 'tests/does-not-exist-holds.json'), SIGNIN_SKIP_WALK: '1',
           AGENT_RUN_QUEUE: '' },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('4. a --changed sentence must be about the change', () => {
  it('"x" is refused; naming the field passes; quoting four words of the added text passes', () => {
    const r = py(`
for i in ("recBlankAaaaaaaaa", "recFieldAaaaaaaaa", "recQuoteAaaaaaaaa"):
    woken(i)
SHIFT[0] = timedelta(days=2, hours=1)
by = snapshot()
x = complete("recBlankAaaaaaaaa", until=day(10), changed="x")
vague = complete("recBlankAaaaaaaaa", until=day(10), changed="Checked everything, all fine, nothing to do.")
field = complete("recFieldAaaaaaaaa", until=day(10), changed="Description: the council's final notice arrived; raised as its own card.")
quote = complete("recQuoteAaaaaaaaa", until=day(10), changed="They wrote 'enforcement agents from the 24th', so I raised it as a card.")
print(json.dumps({"x": x, "vague": vague, "field": field, "quote": quote,
                  "woke": by["recBlankAaaaaaaaa"].get("wokeByChange", {}).get("changed")}))`);
    expect(r.woke).toEqual(['Description']);
    expect(r.x).toMatch(/refusing to keep recBlankAaaaaaaaa open: --changed must say what changed: name at least one of the fields that changed \(Description\), or quote 4 words in a row/);
    expect(r.vague).toMatch(/--changed must say what changed/);
    expect(r.field).toBeNull();
    expect(r.quote).toBeNull();
  });
});

describe('5. a plain complete on a task woken by a change asks the same question a keep-open does', () => {
  it('refused without --changed, refused with a sentence about nothing, closed with one about the change; a task that woke on its date closes as before', () => {
    const r = py(`
woken("recCloseAaaaaaaaa")
rec("recDateCloseAaaaa"); assert complete("recDateCloseAaaaa", until=day(2)) is None
SHIFT[0] = timedelta(days=3, hours=1)
snapshot()
bare = complete("recCloseAaaaaaaaa", keep_open=False)
status_after_bare = F("recCloseAaaaaaaaa")[AF["status"]]
vague = complete("recCloseAaaaaaaaa", keep_open=False, changed="done")
ok = complete("recCloseAaaaaaaaa", keep_open=False, changed="Description: the final notice was raised as its own card; this chase is finished.")
date_ok = complete("recDateCloseAaaaa", keep_open=False)
print(json.dumps({"bare": bare, "statusAfterBare": status_after_bare, "vague": vague, "ok": ok,
                  "status": F("recCloseAaaaaaaaa")[AF["status"]], "notes": F("recCloseAaaaaaaaa")[AF["notes"]].split("\\n\\n")[-1],
                  "dateOk": date_ok, "dateStatus": F("recDateCloseAaaaa")[AF["status"]]}))`);
    expect(r.bare).toMatch(/refusing to close recCloseAaaaaaaaa: it woke because something on it changed since its last rest \(Description changed\)/);
    expect(r.statusAfterBare).toEqual({ name: 'Today' });          // nothing written by the refused close
    expect(r.vague).toMatch(/refusing to close recCloseAaaaaaaaa: --changed must say what changed/);
    expect(r.ok).toBeNull();
    expect(r.status).toBe('Completed');
    expect(r.notes).toMatch(/— agent\] What changed since the last look: Description: the final notice was raised as its own card; this chase is finished\.$/);
    expect(r.dateOk).toBeNull();
    expect(r.dateStatus).toBe('Completed');
  });
});

describe('6. a wall and its clear do not erase the wake', () => {
  it('a woken task parked on a wall and cleared is still handed out with wokeByChange, and its keep-open still asks; a Level A carry-out answers the wake', () => {
    const r = py(`
woken("recWallAaaaaaaaaa")
woken("recHandledAaaaaaa")
m.ledger_append("recWallAaaaaaaaaa", "intent")
m.ledger_append("recWallAaaaaaaaaa", "parked")       # a sign-in wall met before the reply was raised
m.ledger_append("recWallAaaaaaaaaa", "unblocked")    # the wall cleared
m.ledger_append("recWallAaaaaaaaaa", "certificate: recCertAaaaaaaaaa")
m.ledger_append("recHandledAaaaaa", "handled")       # a different id: no effect on the other task
m.ledger_append("recHandledAaaaaaa", "handled")      # carried out at submit, Level A
SHIFT[0] = timedelta(days=2, hours=1)
by = snapshot()
refused = complete("recWallAaaaaaaaaa", until=day(10))
print(json.dumps({"woke": (by.get("recWallAaaaaaaaaa") or {}).get("wokeByChange"),
                  "handled": (by.get("recHandledAaaaaaa") or {}).get("wokeByChange", "absent"),
                  "refused": refused}))`);
    expect(r.woke.changed).toEqual(['Description']);
    expect(r.woke.added.Description).toMatch(/FINAL NOTICE/);
    expect(r.refused).toMatch(/it woke because something on it changed since its last rest \(Description changed\)/);
    expect(r.handled === null || r.handled === 'absent' || r.handled === undefined).toBe(true);
  });
});

describe("8. a note one run left never blocks every later status filing", () => {
  it('runs 2 and 3 file after run 1 left a note, with or without the run snapshot; a reply in the Description still refuses', () => {
    const r = py(`
def filed_then_due(i):
    rec(i, notes=LOOK, approved=False)
    assert submit_status(i, day(3)) is None, i
for i in ("recPriorNoteAaaaa", "recPriorNoSnapAaa", "recPriorReplyAaaa"):
    filed_then_due(i)
SHIFT[0] = timedelta(days=4, hours=1)
annotate("recPriorNoteAaaaa", "Gmail search failed this run, so the status update was not filed.")
annotate("recPriorNoSnapAaa", "Gmail search failed this run, so the status update was not filed.")
F("recPriorReplyAaaa")[AF["description"]] += "\\n\\n" + REPLY
snapshot()                                            # run 2 is handed all three, notes included
run2 = submit_status("recPriorNoteAaaaa", day(7))
reply = submit_status("recPriorReplyAaaa", day(7))
os.environ.pop("AGENT_RUN_QUEUE")                     # a run by hand: no snapshot
nosnap = submit_status("recPriorNoSnapAaa", day(7))
print(json.dumps({"run2": run2, "nosnap": nosnap, "reply": reply}))`);
    expect(r.run2).toBeNull();
    expect(r.nosnap).toBeNull();
    expect(r.reply).toMatch(/the task has changed since it last rested \(Description changed\)/);
  });
});

// REVIEW OF PR 950, FINDING 3 / invariant R4: a wake is answered once. A card raised after the rest (its
// SUBMITTED stamp), a Level A carry-out, or one keep-open with --changed ends it; a card from before the
// rest does not. Two code callers close for a recorded reason and are exempt: a MERGE card on its merge
// and an episode card once it is out.
describe('R4. a wake is answered once', () => {
  it('a change raised as a card, approved and carried out closes with no --changed, with or without a snapshot; a card from before the rest answers nothing', () => {
    const r = py(`
def card_after_rest(i):
    F(i)[AF["notes"]] += "\\n\\n[" + (TODAY + timedelta(days=1)).strftime("%d %b %Y") + " 10:00 — agent-dispatch] SUBMITTED (round 2) as Correspondence with no new file"
    F(i)[AF["approvedAt"]] = (_real_now(timezone.utc) + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
woken("recLifeAaaaaaaaaa"); card_after_rest("recLifeAaaaaaaaaa")
woken("recLifeNoSnapAaaa"); card_after_rest("recLifeNoSnapAaaa")
# a card stamped BEFORE the rest began: the reply after the rest is still unanswered
rec("recOldCardAaaaaaa", notes=LOOK)
assert complete("recOldCardAaaaaaa", until=day(14)) is None
F("recOldCardAaaaaaa")[AF["description"]] += "\\n\\n" + REPLY
SHIFT[0] = timedelta(days=3, hours=1)
by = snapshot()
snap_close = complete("recLifeAaaaaaaaaa", keep_open=False, evidence="the approved reply was sent")
old_card = complete("recOldCardAaaaaaa", keep_open=False)
os.environ.pop("AGENT_RUN_QUEUE")
nosnap_close = complete("recLifeNoSnapAaaa", keep_open=False, evidence="the approved reply was sent")
print(json.dumps({"handed": "recLifeAaaaaaaaaa" in by, "woke": (by.get("recLifeAaaaaaaaaa") or {}).get("wokeByChange"),
                  "snapClose": snap_close, "noSnapClose": nosnap_close, "oldCard": old_card,
                  "status": [F(i)[AF["status"]] for i in ("recLifeAaaaaaaaaa", "recLifeNoSnapAaaa")]}))`);
    expect(r.handed).toBe(true);
    expect(r.woke).toBeNull();
    expect(r.snapClose).toBeNull();
    expect(r.noSnapClose).toBeNull();
    expect(r.status).toEqual(['Completed', 'Completed']);
    expect(r.oldCard).toMatch(/it woke because something on it changed since its last rest \(Description changed\)/);
  });

  it('after one keep-open with --changed the next look is not woken again; a MERGE card on its merge and an episode card close with no --changed', () => {
    const r = py(`
woken("recOnceAaaaaaaaaa")
SHIFT[0] = timedelta(days=2, hours=1)
snapshot()
first = complete("recOnceAaaaaaaaaa", until=day(5), changed="Description: the final notice is raised as its own card.")
SHIFT[0] = timedelta(days=6, hours=1)
by = snapshot()
second = complete("recOnceAaaaaaaaaa", until=day(10), note="checked, nothing new")
# a MERGE card and an episode card that somehow rested, then changed: their code callers pass no sentence
os.environ.pop("AGENT_RUN_QUEUE")
for i, name in (("recMergeAaaaaaaaa", "MERGE: PR #4242 fixture fix"), ("recEpisodeAaaaaaa", "CONTENT: Publish Episode 2190 of Diary of a Runpreneur - FIXTURE")):
    rec(i); F(i)[AF["name"]] = name
    m.ledger_append(i, "done", fingerprint=m.rest_fingerprint(m.rest_view(m.get_task(i))), lengths=m.rest_lengths(m.rest_view(m.get_task(i))))
    F(i)[AF["notes"]] += "\\n\\nPublished to every section." 
merge = complete("recMergeAaaaaaaaa", keep_open=False, evidence="PR #4242 merged as abc1234def (gate green). Findings: none pending. Deploy: success.")
episode = complete("recEpisodeAaaaaaa", keep_open=False)
plain = None
rec("recPlainAaaaaaaaa"); m.ledger_append("recPlainAaaaaaaaa", "done", fingerprint=m.rest_fingerprint(m.rest_view(m.get_task("recPlainAaaaaaaaa"))))
F("recPlainAaaaaaaaa")[AF["notes"]] += "\\n\\nPublished to every section."
plain = complete("recPlainAaaaaaaaa", keep_open=False)
print(json.dumps({"first": first, "secondHanded": "recOnceAaaaaaaaaa" in by, "secondWoke": (by.get("recOnceAaaaaaaaaa") or {}).get("wokeByChange"), "second": second,
                  "merge": merge, "episode": episode, "plain": plain}))`);
    expect(r.first).toBeNull();
    expect(r.secondHanded).toBe(true);
    expect(r.secondWoke).toBeNull();
    expect(r.second).toBeNull();
    expect(r.merge).toBeNull();
    expect(r.episode).toBeNull();
    expect(r.plain).toMatch(/refusing to close recPlainAaaaaaaaa: it woke because something on it changed/);   // the exemption is those two only
  });
});

// Invariant R1 for the close: every refusal names a way through, and doing exactly what it says gets through.
describe('R1. each refusal on a woken task says how to get through, and doing it gets through', () => {
  it('the close and keep-open refusals, and the run-window refusal on the next run', () => {
    const r = py(`
import re
woken("recWayAaaaaaaaaaa"); woken("recWayKeepAaaaaaa"); woken("recWayRaceAaaaaaa")
SHIFT[0] = timedelta(days=2, hours=1)
snapshot()
F("recWayRaceAaaaaaa")[AF["description"]] += "\\n\\nNEW MESSAGE: another reply."   # lands mid-run
out = {}
def follow(err, i, keep):
    # the message's own instruction: --changed naming a field it listed
    field = re.search(r"\\(([A-Za-z ]+?)(?:, [A-Za-z ]+)* changed\\)", err).group(1)
    return complete(i, keep_open=keep, changed=field + ": the change was raised as its own card for Kevin.")
e1 = complete("recWayAaaaaaaaaaa", keep_open=False); out["close"] = [bool(e1), follow(e1, "recWayAaaaaaaaaaa", False)]
e2 = complete("recWayKeepAaaaaaa", until=day(9)); out["keep"] = [bool(e2), follow(e2, "recWayKeepAaaaaaa", True) if e2 else "no refusal"]
e3 = complete("recWayRaceAaaaaaa", keep_open=False, changed="Description: raised as a card.")
out["raceWords"] = e3
SHIFT[0] = timedelta(days=2, hours=2)
snapshot()                                            # the next run is handed it again
out["raceNext"] = complete("recWayRaceAaaaaaa", keep_open=False, changed="Description: both replies were raised as one card.")
print(json.dumps(out))`);
    expect(r.close).toEqual([true, null]);
    expect(r.keep).toEqual([true, null]);
    expect(r.raceWords).toMatch(/the task changed while you were working .*before you rest or close it/);
    expect(r.raceNext).toBeNull();
  });
});
