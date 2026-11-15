import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const DISPATCH = resolve(SCRIPTS, 'agent-dispatch.py');
const LOOP = resolve(SCRIPTS, 'loop-health.py');
const BOARD = resolve(SCRIPTS, 'task-manager.py');
const ESTATE = resolve(SCRIPTS, 'estate-status.py');
const COSTS = resolve(SCRIPTS, 'cost-record.py');
const CE = resolve(SCRIPTS, 'content-engine');

// THE FOLLOW-UPS TO PR 936 (15 Nov 2026), from its independent review and the review of PR 937.
//
// A. A task woken because something on it CHANGED is told so in its queue entry (wokeByChange: what
//    changed and the text appended), `complete --keep-open` refuses it without --changed, and both a
//    keep-open and a status filing refuse when the task changed while the run worked (the queue
//    snapshot the run was handed, compared before the command's own write).
// B. The no-op approve-line check refuses the line Kevin's 14 Nov ruling was measured on and its close
//    family, and still passes the fourteen real cards.
// C. An ended rest is due from a FIXED day (never "today"), and a kept-open task that has waited past
//    the stuck clock is on the Stuck list again, rest or no rest.
// D. A status update is not refused for the agent's own note written in the same run.
// E. A lesson is filed under the real "## Lessons from Kevin" heading LINE, never under a sentence that
//    mentions it, and an empty brand section returns no lesson.
// F. The wall row, the Estate sentence, the runner prompts and cost-record.py say what is true.
//
// Everything drives the real code. Airtable is an in-memory store, every network call raises, state goes
// to temp folders. Names, ids, addresses and dates are invented.

const PRE = `
import importlib.util, json, os, io, sys, contextlib, types, tempfile, urllib.request, urllib.error
from datetime import datetime as _dt, timedelta, timezone, date
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
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
class Clock(_dt):
    @classmethod
    def now(cls, tz=None):
        return _dt.now(tz) + SHIFT[0]
m.datetime = Clock
AGENT = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-builder"][0]
TODAY = _dt.now(m.LONDON).date()
def day(n): return (TODAY + timedelta(days=n)).isoformat()
CREATED = (_dt.now(timezone.utc) - timedelta(days=40)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
TASKS = {}
def rec(i, notes="", approved=True, desc="Chase Exampleton Council about the bill. Contact: recovery@exampleton-council.test",
        approved_at="2026-09-01T09:00:00.000Z"):
    f = {AF["name"]: "Chase: Exampleton Council - council tax account 70012345", AF["status"]: {"name": "Today"},
         AF["teamMember"]: [AGENT], AF["notes"]: notes, AF["description"]: desc}
    if approved:
        f.update({AF["approvalOutcome"]: {"name": "Approved as-is"}, AF["approvedAt"]: approved_at,
                  AF["sentForApprovalBy"]: [AGENT]})
    TASKS[i] = {"id": i, "createdTime": CREATED, "fields": f}
    return TASKS[i]
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
def quiet(fn, *a):
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            fn(*a)
        return None
    except SystemExit as e:
        return str(e)
def complete(i, **kw):
    a = dict(task=i, keep_open=True, note="chased the council", until=day(10), no_certificate="", evidence="",
             not_signed="", diary_not_written="", cost_not_written="", not_bought="", changed="")
    a.update(kw)
    return quiet(m.cmd_complete, types.SimpleNamespace(**a))
def annotate(i, note):
    return quiet(m.cmd_annotate, types.SimpleNamespace(task=i, note=note, agent=AGENT, by=None))
QUIET = {"terms": ["email x"], "searched": ["tasks", "Gmail"], "entries": [], "notes": []}
def status_body(nxt):
    return (f"STATUS ONLY: No reply from the council yet and nothing new has arrived.\\nNEXT CHECK: {nxt}\\n\\n"
            "What I checked: the council's portal and both inboxes.\\n\\n"
            "TRACK RECORD: none found (searched tasks + Gmail for email recovery@exampleton-council.test)\\n\\n"
            "**Carrying this out will involve:** Nothing. Information only.")
def submit_status(i, nxt):
    m.history = lambda **kw: dict(QUIET)
    fh = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False); fh.write(status_body(nxt)); fh.close()
    return quiet(m.cmd_submit, types.SimpleNamespace(task=i, agent=AGENT, type="Research", output_file=fh.name, tier1=False,
                 attach=None, plain_task="Check whether the council has replied about the bill.",
                 plain_approve="Nothing to approve. The update is listed under Handled without you."))
SN = [0]
os.environ.pop("AGENT_RUN_QUEUE", None)
def snapshot(name=None, export=True):
    """The run's queue.json, written where a runner writes it, and exported as the run's own queue the
    way every runner does (AGENT_RUN_QUEUE). name: the run folder's name, chosen by each runner."""
    q = m.build_queue()
    SN[0] += 1
    d = os.path.join(STATE, name or ("%06d-run" % SN[0])); os.makedirs(d)
    path = os.path.join(d, "queue.json")
    with open(path, "w") as fh:
        json.dump(q, fh, default=str)
    if export:
        os.environ["AGENT_RUN_QUEUE"] = path
    return {t["id"]: t for t in q["worklist"] + q["reserve"]}
def fold_twin(keeper, twin, words):
    """Another agent closes a twin onto the keeper at Level A, mid-run (the real carry_output_to_keeper)."""
    rec(twin, approved=False, desc=words)
    F(twin)[AF["name"]] = "INBOUND (follow-up): Exampleton Council final notice"
    return m.carry_output_to_keeper(twin, F(twin), keeper, "15 Nov 2026 10:00")
LOOK = "[" + (TODAY - timedelta(days=5)).strftime("%d %b %Y") + " 09:00 — agent-dispatch] SUBMITTED (round 1) as Research with no new file"
REPLY = "NEW MESSAGE " + day(1) + ": Exampleton Council replied on the same thread. FINAL NOTICE. Enforcement agents from the 24th."
`;

function py(snippet, env = {}) {
  const out = execFileSync('python3', ['-c', PRE + snippet], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OD_HOLDS_FILE: resolve(ROOT, 'tests/does-not-exist-holds.json'), SIGNIN_SKIP_WALK: '1', ...env },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

function plain(body) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, os, sys, tempfile
def boom(*a, **k): raise RuntimeError("network call in a test")
import urllib.request; urllib.request.urlopen = boom
${body}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('A. a task woken by a change says so, and a keep-open cannot bury the change', () => {
  it('the queue entry names what changed and shows the appended text; a rest that ran to its date, or never had a fingerprint, carries nothing', () => {
    const r = py(`
rec("recWokeAaaaaaaaaa"); rec("recDateAaaaaaaaaa"); rec("recRewriteAaaaaaa")
assert complete("recWokeAaaaaaaaaa", until=day(14)) is None
assert complete("recDateAaaaaaaaaa", until=day(2)) is None
assert complete("recRewriteAaaaaaa", until=day(14)) is None
# a rest from before fingerprints: its carry-out line and a ledger line with no fp
old = (TODAY - timedelta(days=6)).strftime("%d %b %Y")
rec("recPreFpAaaaaaaaa", notes="[%s — agent] %s chased. Left OPEN deliberately: the approval said so." % (old, m.CARRIED_OUT_MARK))
with open(m.INTENT_LEDGER, "a") as fh:
    fh.write(json.dumps({"task": "recPreFpAaaaaaaaa", "ts": (_dt.now(timezone.utc) - timedelta(days=6)).strftime("%Y-%m-%dT%H:%M:%S.000Z"), "event": "done"}) + "\\n")
F("recWokeAaaaaaaaaa")[AF["description"]] += "\\n\\n" + REPLY
F("recRewriteAaaaaaa")[AF["description"]] = "Someone rewrote this task by hand."
SHIFT[0] = timedelta(days=3, hours=1)
by = snapshot()
print(json.dumps({"ids": sorted(by), "woke": {k: by[k].get("wokeByChange") for k in by}}))`);
    expect(r.ids).toEqual(['recDateAaaaaaaaaa', 'recPreFpAaaaaaaaa', 'recRewriteAaaaaaa', 'recWokeAaaaaaaaaa']);   // all four handed to the run
    expect(r.woke.recWokeAaaaaaaaaa.changed).toEqual(['Description']);
    expect(r.woke.recWokeAaaaaaaaaa.added).toEqual({ Description: expect.stringMatching(/^NEW MESSAGE .*FINAL NOTICE\. Enforcement agents from the 24th\.$/) });
    expect(r.woke.recWokeAaaaaaaaaa.rewritten).toEqual([]);
    expect(r.woke.recWokeAaaaaaaaaa.restEvent).toBe('done');
    expect(r.woke.recRewriteAaaaaaa.changed).toEqual(['Description']);
    expect(r.woke.recRewriteAaaaaaa.added).toEqual({});
    expect(r.woke.recRewriteAaaaaaa.rewritten).toEqual(['Description']);
    expect(r.woke.recDateAaaaaaaaaa).toBeNull();
    expect(r.woke.recPreFpAaaaaaaaa).toBeNull();
  });

  it('keep-open on a task woken by a change is refused without --changed, names what changed, and writes the sentence for Kevin; a date wake needs no flag', () => {
    const r = py(`
rec("recWokeAaaaaaaaaa"); rec("recDateAaaaaaaaaa"); rec("recVerdictAaaaaaa")
complete("recWokeAaaaaaaaaa", until=day(14)); complete("recDateAaaaaaaaaa", until=day(2)); complete("recVerdictAaaaaaa", until=day(14))
F("recWokeAaaaaaaaaa")[AF["description"]] += "\\n\\n" + REPLY
SHIFT[0] = timedelta(days=3, hours=1)
F("recVerdictAaaaaaa")[AF["approvedAt"]] = m.now_iso()      # Kevin approved again: his verdict is the only change
by = snapshot()
verdict_woke = by["recVerdictAaaaaaa"].get("wokeByChange", {}).get("changed")
verdict_ok = complete("recVerdictAaaaaaa", until=day(10), note="carried out his new approval")
refused = complete("recWokeAaaaaaaaaa", until=day(10), note="checked the portal")
ok = complete("recWokeAaaaaaaaaa", until=day(10), note="checked the portal",
              changed="The council sent a final notice; I raised it as its own card for Kevin.")
date_ok = complete("recDateAaaaaaaaaa", until=day(6), note="checked, nothing new")
print(json.dumps({"verdictWoke": verdict_woke, "verdictOk": verdict_ok, "refused": refused, "ok": ok, "dateOk": date_ok, "line": F("recWokeAaaaaaaaaa")[AF["notes"]].split("\\n\\n")[-1]}))`);
    expect(r.refused).toMatch(/it woke because something on it changed since its last rest \(Description changed\)/);
    expect(r.refused).toMatch(/--changed "<one sentence: what changed on the task and what you did about it>"/);
    expect(r.ok).toBeNull();
    expect(r.line).toMatch(/CARRIED OUT \(task left open\): checked the portal\. What changed since the last look: The council sent a final notice; I raised it as its own card for Kevin\. Left OPEN deliberately/);
    expect(r.dateOk).toBeNull();
    // A wake that is Kevin's verdict alone is named, and the carry-out is its answer: no --changed asked.
    expect(r.verdictWoke).toEqual(['Approved At']);
    expect(r.verdictOk).toBeNull();
  });

  it('with no queue snapshot the wake is read from the last rest, Notes included, and the refusal says so', () => {
    const r = py(`
rec("recNoSnapAaaaaaaa"); rec("recOwnNoteAaaaaaa")
complete("recNoSnapAaaaaaaa", until=day(2)); complete("recOwnNoteAaaaaaa", until=day(2))
F("recNoSnapAaaaaaaa")[AF["description"]] += "\\n\\n" + REPLY
SHIFT[0] = timedelta(days=3, hours=1)
annotate("recOwnNoteAaaaaaa", "Checked the portal today: no reply.")
print(json.dumps({"desc": complete("recNoSnapAaaaaaaa", until=day(8)), "ownNote": complete("recOwnNoteAaaaaaa", until=day(8)),
                  "ownNoteSaid": complete("recOwnNoteAaaaaaa", until=day(8), changed="Only my own note from this look; nothing new arrived.")}))`);
    expect(r.desc).toMatch(/\(Description changed\)/);
    expect(r.desc).toMatch(/No queue snapshot was found for it: AGENT_RUN_QUEUE is not set.*Compared with its last rest instead, Notes included/);
    // No snapshot: a Notes change counts like any other (review of PR 938, finding 3), so the run's own
    // note costs one sentence, the safe direction.
    expect(r.ownNote).toMatch(/\(Notes changed\)/);
    expect(r.ownNoteSaid).toBeNull();
  });

  it("a reply that lands while the run works is refused before the keep-open writes; the run's own note is not", () => {
    const r = py(`
rec("recRaceAaaaaaaaaa"); rec("recOwnAaaaaaaaaaa")
complete("recRaceAaaaaaaaaa", until=day(2)); complete("recOwnAaaaaaaaaaa", until=day(2))
SHIFT[0] = timedelta(days=3, hours=1)
by = snapshot()
assert "recRaceAaaaaaaaaa" in by and "wokeByChange" not in by["recRaceAaaaaaaaaa"]
F("recRaceAaaaaaaaaa")[AF["description"]] += "\\n\\n" + REPLY      # mid-run, after the queue was read
annotate("recOwnAaaaaaaaaaa", "Checked the portal today: no reply.")  # the run's own note
before = F("recRaceAaaaaaaaaa")[AF["notes"]]
race = complete("recRaceAaaaaaaaaa", until=day(9))
print(json.dumps({"race": race, "untouched": F("recRaceAaaaaaaaaa")[AF["notes"]] == before,
                  "own": complete("recOwnAaaaaaaaaaa", until=day(9))}))`);
    expect(r.race).toMatch(/the task changed while you were working \(Description changed since the queue you were handed was read\): read it again/);
    expect(r.untouched).toBe(true);
    expect(r.own).toBeNull();
  });
});

describe("D. a status update is never refused for the agent's own note in the same run", () => {
  it("with the run's snapshot the own note files; with none the refusal says why; a reply mid-run is the window's", () => {
    const r = py(`
def filed_then_due(i):
    rec(i, notes=LOOK, approved=False)
    assert submit_status(i, day(3)) is None, i
for i in ("recOwnStatAaaaaaa", "recNoSnapStatAaaa", "recRaceStatAaaaaa"):
    filed_then_due(i)
SHIFT[0] = timedelta(days=4, hours=1)
snapshot()
annotate("recOwnStatAaaaaaa", "Checked the portal and both inboxes today: no reply.")
own = submit_status("recOwnStatAaaaaaa", day(7))
F("recRaceStatAaaaaa")[AF["description"]] += "\\n\\n" + REPLY
race = submit_status("recRaceStatAaaaaa", day(7))
# no snapshot: a fresh state folder holds the ledger only
os.environ.pop("AGENT_RUN_QUEUE")   # no snapshot: a run by hand
annotate("recNoSnapStatAaaa", "Checked the portal and both inboxes today: no reply.")
nosnap = submit_status("recNoSnapStatAaaa", day(7))
print(json.dumps({"own": own, "race": race, "nosnap": nosnap}))`);
    expect(r.own).toBeNull();
    expect(r.race).toMatch(/the task changed while you were working \(Description changed/);
    expect(r.nosnap).toMatch(/the task has changed since it last rested \(Notes changed\).*no queue snapshot was found for it: .*a note you wrote in this run counts as a change/s);
  });
});

describe("B. the no-op approve line: the ruling's own line and its close family are refused, the fourteen real cards pass", () => {
  it('table', () => {
    const r = py(`
real = [
  "Nothing is paid today. The bill goes on the Friday payment list.",
  "Nothing is sent to the tenant. The agent chases the council for the missing payment instead.",
  "Nothing is signed yet. The robot signs the tenancy agreement in Adobe.",
  "Nothing changes for the tenant. The agent adds the new gas certificate to the compliance book.",
  "Nothing is booked yet. The agent accepts the electrician's quote and asks for a date.",
  "Nothing is sent today. The agent drafts the reply and brings it back for you to check.",
  "No action is taken against the tenant and the arrears task closes.",
  "Nothing happens to the tenancy and the old reminder closes.",
  "Nothing is paid. The agent tells Roy to go ahead with the repair.",
  "No action fraud report exists yet. The agent prepares one for you to check.",
  "Nothing to do with the old policy. The agent asks three insurers for a quote.",
  "Nothing is sent by post. The agent submits the form on the council's website.",
  "Nothing is bought. The agent withdraws the order request and tells the seller.",
  "Nothing changes on the plan. The agent confirms the £20 a month to the creditor in writing.",
  # the five real cards the review of PR 938 wrote (finding 11): each goes on to name who acts
  "Nothing happens. No reply yet, so the agent closes this chase and opens a fresh one for Monday.",
  "No action needed. No reply has come yet, so the task closes and the agent starts the court claim draft.",
  "Nothing else. It only lets you know the agent will now send the final chase letter by post.",
  "Nothing changes: information only goes to the council, and the agent submits the form tonight.",
  "Nothing further. For your information, approving this closes the old reminder.",
]
family = [
  "Nothing happens. This only tells you no reply has come yet and the next check is on 2 November.",
  "Nothing happens. This just tells you the council has not replied.",
  "If you approve, nothing happens: it only tells you where the chase stands.",
  "No action. This is for your information.",
  "Nothing happens. For your information only.",
  "No action needed. Information only, the next check is on Friday.",
  "Nothing happens: no reply yet from the council.",
  "Nothing. No reply has come yet.",
]
print(json.dumps({"realRefused": [l for l in real if m.approve_line_noop(l)],
                  "familyPassed": [l for l in family if not m.approve_line_noop(l)]}))`);
    expect(r.realRefused).toEqual([]);
    expect(r.familyPassed).toEqual([]);
  });
});

describe('C. an ended rest is due from a fixed day, and a long wait is stuck whatever the rest says', () => {
  it('the board: restDue never moves with the clock, so an ended rest reaches the stuck clock', () => {
    const r = py(`
spec2 = importlib.util.spec_from_file_location('tm', ${JSON.stringify(BOARD)})
tm = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(tm)
old = (_dt.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
old_day = (TODAY - timedelta(days=29)).strftime("%d %b %Y")
rec("recUndatedAaaaaaa", notes="[%s — agent] %s chased the council. Left OPEN deliberately: the approval said so." % (old_day, m.CARRIED_OUT_MARK), approved_at=old)
with open(m.INTENT_LEDGER, "a") as fh:
    fh.write(json.dumps({"task": "recUndatedAaaaaaa", "ts": (_dt.now(timezone.utc) - timedelta(days=29)).strftime("%Y-%m-%dT%H:%M:%S.000Z"), "event": "done"}) + "\\n")
rec("recChangedAaaaaaa", approved_at=old); complete("recChangedAaaaaaa", until=day(14))
F("recChangedAaaaaaa")[AF["description"]] += "\\n\\n" + REPLY
rec("recRanOutAaaaaaaa", approved_at=old); complete("recRanOutAaaaaaaa", until=day(2))
def named(i):
    f = TASKS[i]["fields"]
    return {"id": i, "fields": {"Status": "Today", "Approval Outcome": m.sel(f.get(AF["approvalOutcome"])), "Approved At": f.get(AF["approvedAt"]),
            "Created Time": CREATED, "Team Member": [AGENT], "Task Name": f[AF["name"]], "Notes": f[AF["notes"]]}}
out = {}
for d in (3, 5, 10):
    SHIFT[0] = timedelta(days=d, hours=1)
    now = _dt.now(timezone.utc) + SHIFT[0]
    lanes = m.queue_lanes({}, {}, "")
    out[d] = {i[3:10]: [tm.task_view(named(i), set(), set(), now, lanes)[0], (lanes[i][1] or {}).get("restDue")]
              for i in ("recUndatedAaaaaaa", "recChangedAaaaaaa", "recRanOutAaaaaaaa")}
print(json.dumps({"out": out, "d0": day(0), "d2": day(2), "dm29": (TODAY - timedelta(days=29)).isoformat()}))`);
    for (const d of ['3', '5', '10']) {
      expect(r.out[d].Undated[1]).toBe(r.dm29);
      expect(r.out[d].Changed[1]).toBe(r.d0);
      expect(r.out[d].RanOutA[1]).toBe(r.d2);
      expect(r.out[d].Undated[0]).toBe('stuck');
    }
    expect(r.out['5'].Changed[0]).toBe('moving');
    expect(r.out['10'].Changed[0]).toBe('stuck');
  });

  it('loop-health: a chase kept open 60 days is on the Stuck list resting or not; a short wait resting is waiting', () => {
    const r = plain(`
from datetime import datetime, timezone
os.environ["AGENT_DISPATCH_DIR"] = tempfile.mkdtemp()
spec = importlib.util.spec_from_file_location('lh', ${JSON.stringify(LOOP)})
lh = importlib.util.module_from_spec(spec); spec.loader.exec_module(lh)
UTC = timezone.utc
now = datetime(2026, 11, 16, 9, 0, tzinfo=UTC)
H = "recHolderAaaaaaaa"
def task(first, approved):
    lines = ["[%s — agent] CARRIED OUT (task left open): chased the council. Left OPEN deliberately: the approval said so." % first,
             "[13 Nov 2026 — agent] CARRIED OUT (task left open): looked, no reply. Left OPEN deliberately: the approval said so. Next look: it rests until 2026-11-27. Holder: %s." % H]
    return {"Approval Outcome": "Approved as-is", "Approved At": approved, "Notes": "\\n\\n".join(lines), "Status": "Today",
            "Due Date": "2026-09-17", "Task Name": "Chase: Exampleton Council"}
long_f = task("17 Sep 2026", "2026-09-16T09:00:00.000Z")
long_ev = [("done", datetime(2026, 9, 17, 10, 0, tzinfo=UTC)), ("done", datetime(2026, 11, 13, 10, 0, tzinfo=UTC))]
short_f = task("12 Nov 2026", "2026-11-11T09:00:00.000Z")
short_ev = [("done", datetime(2026, 11, 12, 10, 0, tzinfo=UTC)), ("done", datetime(2026, 11, 13, 10, 0, tzinfo=UTC))]
rows = lambda f, ev, rest: [(x["rule"], x["days"]) for x in lh.reply_overdue_rows([{"id": "recLongAaaaaaaaaa", "fields": f}], now, {"recLongAaaaaaaaaa": ev}, resting=rest)]
print(json.dumps({
  "longResting": [lh.work_bucket(long_f, now, long_ev, rest_until="2026-11-27"), rows(long_f, long_ev, {"recLongAaaaaaaaaa": "2026-11-27"})],
  "longEnded": [lh.work_bucket(long_f, now, long_ev, rest_until=""), rows(long_f, long_ev, {})],
  "shortResting": [lh.work_bucket(short_f, now, short_ev, rest_until="2026-11-27"), rows(short_f, short_ev, {"recLongAaaaaaaaaa": "2026-11-27"})],
  "shortEnded": [lh.work_bucket(short_f, now, short_ev, rest_until=""), rows(short_f, short_ev, {})],
}))`);
    expect(r.longResting).toEqual([['live', 'overdue'], [['reply', 60]]]);
    expect(r.longEnded).toEqual([['live', 'overdue'], [['reply', 60]]]);
    expect(r.shortResting).toEqual([['waitingReply', 'resting'], []]);
    expect(r.shortEnded).toEqual([['live', ''], []]);
  });
});

describe('E. a lesson lands under the real heading line, never under a sentence that mentions it', () => {
  const AGENT_FILE = `# Invented agent

Both calls read the \`## Lessons from Kevin\` section below and add it to their instructions.

## How you run

Run the invented steps.

## Lessons from Kevin

Standing rules.

- 2026-01-02: Invented task — the first lesson

## Lessons from Kevin (Operations Director)

<!-- BINDING RULES: BLOCK START -->
## Rules that bind every agent (generated — do not edit here)

- An invented binding rule.
<!-- BINDING RULES: BLOCK END -->
`;
  it('the dispatcher writes it in the real section, a brand section by its own heading, and both readers see only lessons', () => {
    const dir = mkdtempSync(join(tmpdir(), 'od-lessons-'));
    writeFileSync(join(dir, 'invented-agent.md'), AGENT_FILE);
    const r = py(`
m.AGENT_DIR = ${JSON.stringify(dir)}
path = os.path.join(m.AGENT_DIR, "invented-agent.md")
line = m.lesson_line("2026-11-15", "Invented chase", "Always name the account number.")
res = m.append_lesson_to_file("invented-agent", line)
brand = "- 2026-11-15: Invented post — Lead with the client's number."
try:
    bres = m.append_lesson_to_file("invented-agent", brand, heading="## Lessons from Kevin (Operations Director)")
except TypeError as e:
    bres = {"error": str(e)}
text = open(path).read()
sys.path.insert(0, ${JSON.stringify(CE)})
import watch
watch.AGENT_FILE = path
spec3 = importlib.util.spec_from_file_location("od", os.path.join(${JSON.stringify(CE)}, "od_lane.py"))
od = importlib.util.module_from_spec(spec3); spec3.loader.exec_module(od)
empty = text.replace(brand + "\\n", "")
epath = os.path.join(m.AGENT_DIR, "empty.md"); open(epath, "w").write(empty)
watch.AGENT_FILE = epath
od_empty = od.od_lessons()
watch.AGENT_FILE = path
print(json.dumps({"res": res, "bres": bres,
  "inRun": line in text[text.index("## How you run"):text.index("## Lessons from Kevin\\n")],
  "order": [text.index("- 2026-01-02"), text.index(line), text.index("## Lessons from Kevin (Operations Director)"),
            text.index(brand) if brand in text else -1, text.index("<!-- BINDING RULES: BLOCK START")],
  "kevin": watch.kevin_lessons(path), "od": od.od_lessons(), "odEmpty": od_empty}))`);
    expect(r.res.written).toBe(true);
    expect(r.res.lessonCount).toBe(2);
    expect(r.inRun).toBe(false);
    const [first, line, brandHead, brand, marker] = r.order;
    expect(first).toBeLessThan(line);
    expect(line).toBeLessThan(brandHead);
    expect(brandHead).toBeLessThan(brand);
    expect(brand).toBeLessThan(marker);
    expect(r.bres.written).toBe(true);
    expect(r.kevin).toMatch(/Always name the account number\./);
    expect(r.kevin).not.toMatch(/Lead with the client's number|BINDING/);
    expect(r.od).toMatch(/Lead with the client's number\./);
    expect(r.od).not.toMatch(/BINDING|<!--/);
    expect(r.odEmpty).toBe('');
  });
});

describe('F. the words say what is true', () => {
  it('the wall row: a finding pending on a NEW pull request waits on that PR; a stopped moved record is stale once the card is refreshed', () => {
    const r = py(`
fid = "20261101-invented-001"
old_card = {"pr": 812, "id": "recCardOldAaaaaaa", "status": "Completed", "outcome": "Approved as-is", "findings": [fid]}
b = {"finding": fid, "why": "a tool broke"}
moved = {"result": "moved", "head": "aaaa111122223333", "newHead": "bbbb111122223333", "movedTries": 4,
         "lastMovedAt": "2026-11-06T09:00:00", "finding": "20261106-merge-approved-001"}
print(json.dumps({
  "newPr": m.tool_wall_state(b, "pending", {"pr": 840}, [old_card], 1),
  "samePr": m.tool_wall_state(b, "pending", {"pr": 812}, [old_card], 1)[0],
  "refreshed": m.approved_merge_state(812, {"pr": 812, "head": "cccc111122223333"}, moved),
  "notRefreshed": m.approved_merge_state(812, {"pr": 812, "head": "aaaa111122223333"}, moved)[0],
}))`);
    expect(r.newPr).toEqual(['pending', 'waiting on PR #840 to merge']);
    expect(r.samePr).toBe('merge-closed');
    expect(r.refreshed).toBeNull();
    expect(r.notRefreshed).toBe('merge-stopped');
  });

  it('the Estate sentence says what each stopped card stopped on and whether its finding is filed', () => {
    const r = py(`
spec2 = importlib.util.spec_from_file_location('e', ${JSON.stringify(ESTATE)})
e = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(e)
card = lambda pr: {"pr": pr, "head": "aaaa111122223333"}
gate = m.merge_stop_facts(812, card(812), {"result": "error", "errKind": "gate-refused", "errTries": 4, "head": "aaaa111122223333"})
red = m.merge_stop_facts(890, card(890), {"result": "red", "reds": 4, "head": "aaaa111122223333", "finding": "20261106-merge-approved-7"})
W = lambda t, pr, facts: {"task": t, "name": "n", "kind": "TOOL", "subject": t, "fix": "f", "days": 1, "findingStatus": "pending",
                          "toolState": "merge-stopped", "tool": "stopped", "mergeCard": {"pr": pr}, "mergeStop": facts}
s = {"openTasksRead": 1, "woken": [], "closedWhileBlocked": [], "sitesError": "", "findingsError": "", "stale": []}
both = e.blockers_summary(dict(s, open=[W("a", 812, gate), W("b", 890, red)]))[1]
filed = e.blockers_summary(dict(s, open=[W("b", 890, red)]))[1]
print(json.dumps({"gate": gate, "both": both, "filed": filed}))`);
    expect(r.gate).toEqual({ kind: 'gate-refused', words: 'merge-pr.py refused it without a failing test, 4 times', tries: 4, finding: '' });
    expect(r.both).toMatch(/2 tasks waiting on 2 merges you approved that the robot stopped retrying and need a fix \(PR #812: merge-pr\.py refused it without a failing test, 4 times; PR #890: its tests failed 4 times\)\. The stop finding for PR #812 is not filed yet; the next merge run files it\./);
    expect(r.both).not.toMatch(/after failed test runs|filed a stop finding for each/);
    expect(r.filed).toMatch(/\(PR #890: its tests failed 4 times\)\. The robot filed a stop finding for each, for the daily robot fix\./);
  });

  it('cost-record.py tells a keep-open to name its next look', () => {
    const r = plain(`
import sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
os.environ["COST_RECORD_LEDGER"] = os.path.join(tempfile.mkdtemp(), "ledger.jsonl")
spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(COSTS)})
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
out = "THE ASK: approve.\\nRECORD NEW COST: Example Cover - REF 99AA000001 | 10.29 | Monthly | due NOT FOUND | first NOT FOUND | ends NOT FOUND"
print(json.dumps(c.owed_new_costs("recTaskInventedAa", out, "", [["Some other cost", 5]], [])))`);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/complete --keep-open --until <YYYY-MM-DD: the day the payment is due, at most 14 days ahead>/);
  });

  // The prompt's wording IS the deliverable here, so it is RUN through bash (as the blocker tests do),
  // never grepped: the runner must really hand the agent the woken-by-a-change rule.
  it('both runner prompts survive bash and tell the agent about a task woken by a change', () => {
    for (const f of ['scripts/handback-poll-run.sh', 'scripts/signin-pickup-run.sh']) {
      const lines = readFileSync(resolve(ROOT, f), 'utf8').split('\n');
      const start = lines.findIndex(l => l.startsWith('"$CLAUDE" -p "'));
      const end = lines.findIndex((l, i) => i > start && /^\s+--add-dir /.test(l));
      expect(start, f).toBeGreaterThan(0);
      const call = lines.slice(start, end).join('\n').replace(/^"\$CLAUDE"/, 'stub').replace(/\s*\\$/, '');
      const dir = mkdtempSync(resolve(tmpdir(), 'prompt-'));
      const script = resolve(dir, 'run.sh');
      writeFileSync(script, `set -e\ncd "${dir}"\nstub() { printf '%s' "$2" > "${dir}/prompt.txt"; }\n${call}\n`);
      execFileSync('bash', [script], { encoding: 'utf8' });
      const prompt = readFileSync(resolve(dir, 'prompt.txt'), 'utf8');
      expect(prompt, f).toMatch(/WOKEN BY A CHANGE: .*wokeByChange/);
      expect(prompt, f).toContain('--changed "<one sentence: what changed on the task and what you did about it>"');
      expect(prompt, f).not.toMatch(/wakes sooner by itself on Kevin's verdict, a wall, or a new holder/);
    }
  });
});

describe('the review of PR 938: a twin folded in mid-run, the run\'s own queue, the no-snapshot fallback', () => {
  it('a twin closed onto the task while the run works is refused on both routes, and the fold is a dated Description line', () => {
    const r = py(`
rec("recKeepAaaaaaaaaa"); assert complete("recKeepAaaaaaaaaa", until=day(2)) is None
rec("recStatAaaaaaaaaa", notes=LOOK, approved=False); assert submit_status("recStatAaaaaaaaaa", day(3)) is None
SHIFT[0] = timedelta(days=4, hours=1)
by = snapshot()
assert "recKeepAaaaaaaaaa" in by and "recStatAaaaaaaaaa" in by
fold_twin("recKeepAaaaaaaaaa", "recTwinAaaaaaaaaa", "INBOUND: Exampleton Council FINAL NOTICE. Enforcement agents from the 24th.")
fold_twin("recStatAaaaaaaaaa", "recTwinBaaaaaaaaa", "INBOUND: Exampleton Council FINAL NOTICE (second copy).")
keep = complete("recKeepAaaaaaaaaa", until=day(14), note="checked the portal, nothing new")
stat = submit_status("recStatAaaaaaaaaa", day(10))
# a hand run (no snapshot): the same fold refuses the keep-open, Notes and Description both changed
rec("recHandAaaaaaaaaa"); complete("recHandAaaaaaaaaa", until=day(5))
os.environ.pop("AGENT_RUN_QUEUE")
fold_twin("recHandAaaaaaaaaa", "recTwinCaaaaaaaaa", "INBOUND: Exampleton Council FINAL NOTICE (third copy).")
hand = complete("recHandAaaaaaaaaa", until=day(12))
print(json.dumps({"keep": keep, "stat": stat, "hand": hand,
                  "descLine": F("recKeepAaaaaaaaaa")[AF["description"]].split("\\n")[-1],
                  "noteBlock": "FOLDED recTwinAaaaaaaaaa" in F("recKeepAaaaaaaaaa")[AF["notes"]]}))`);
    expect(r.descLine).toMatch(/^UPDATE \d{4}-\d{2}-\d{2}: recTwinAaaaaaaaaa folded in: INBOUND \(follow-up\): Exampleton Council final notice$/);
    expect(r.noteBlock).toBe(true);
    expect(r.keep).toMatch(/the task changed while you were working \(Description changed/);
    expect(r.stat).toMatch(/the task changed while you were working \(Description changed/);
    expect(r.hand).toMatch(/it woke because something on it changed since its last rest \(Description, Notes changed\)/);
  });

  it('the snapshot is the file the runner exported, never a folder chosen by name; no variable is no snapshot; queue writes it', () => {
    const r = py(`
rec("recOrderAaaaaaaaa"); complete("recOrderAaaaaaaaa", until=day(2))
SHIFT[0] = timedelta(days=3, hours=1)
stamp = (TODAY + timedelta(days=3)).strftime("%Y%m%d")
snapshot(name=stamp + "-run17", export=False)           # an earlier slot, its folder named by its runner
F("recOrderAaaaaaaaa")[AF["description"]] += "\\n\\n" + REPLY
SHIFT[0] = timedelta(days=3, hours=1, minutes=30)
by = snapshot(name=stamp + "-173000")                    # this run's own queue, exported
told = by["recOrderAaaaaaaaa"]["wokeByChange"]["changed"]
chosen = m.run_snapshot("recOrderAaaaaaaaa")[1]
ok = complete("recOrderAaaaaaaaa", until=day(10), note="raised the final notice as its own card",
              changed="The council sent a final notice; I raised it as its own card for Kevin.")
os.environ.pop("AGENT_RUN_QUEUE")
none = m.run_snapshot("recOrderAaaaaaaaa")
# the queue subcommand writes the run's own copy where the variable says
target = os.path.join(STATE, "run-queues", "slot-x.json")
os.environ["AGENT_RUN_QUEUE"] = target
with contextlib.redirect_stdout(io.StringIO()):
    m.cmd_queue(types.SimpleNamespace())
written = json.load(open(target))
print(json.dumps({"told": told, "chosen": os.path.basename(os.path.dirname(chosen)), "ok": ok, "none": none,
                  "written": sorted(k for k in ("generatedAt", "worklist", "idleHandbacks") if k in written)}))`);
    expect(r.told).toEqual(['Description']);
    expect(r.chosen).toMatch(/-173000$/);
    expect(r.ok).toBeNull();
    expect(r.none[0]).toBeNull();
    expect(r.none[1]).toMatch(/AGENT_RUN_QUEUE is not set/);
    expect(r.written).toEqual(['generatedAt', 'idleHandbacks', 'worklist']);
  });

  it('every runner that hands a queue to an agent exports AGENT_RUN_QUEUE before it starts the agent', () => {
    for (const f of ['scripts/handback-poll-run.sh', 'scripts/signin-pickup-run.sh', 'scripts/roy-assistant-run.sh', 'scripts/agent-slot-run.sh']) {
      const lines = readFileSync(resolve(ROOT, f), 'utf8').split('\n');
      const start = lines.findIndex(l => l.startsWith('"$CLAUDE" -p '));
      const exp = lines.findIndex(l => /^export AGENT_RUN_QUEUE=/.test(l));
      expect(exp, f).toBeGreaterThan(0);
      expect(exp, f).toBeLessThan(start);
      // RUN the export line through bash with the runner's own variables, and read what the agent inherits
      const dir = mkdtempSync(resolve(tmpdir(), 'runq-'));
      const script = resolve(dir, 'run.sh');
      writeFileSync(script, `set -eu\nHOME="${dir}"; RUNDIR="${dir}/run"; JOB="invented-slot"\n${lines[exp]}\nprintf '%s' "$AGENT_RUN_QUEUE"\n`);
      const got = execFileSync('bash', [script], { encoding: 'utf8' });
      expect(got, f).toMatch(f.includes('agent-slot') ? /\/run-queues\/invented-slot\.json$/ : /\/run\/queue\.json$/);
    }
  });
});
