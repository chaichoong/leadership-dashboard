import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SRC = readFileSync(DISPATCH, 'utf8');

// 14 Sep 2026. The 30-minute hand-back poll woke a full Claude run for the
// same five approved tasks 48 times a day. Two were EICR quote chases Kevin
// approved to STAY OPEN until a chase date: every poll "carried them out"
// again and appended a note (one task's Notes reached 46,000 characters).
// Three needed a sign-in only Kevin can do: every poll re-parked them with
// the same note. Measured over 8-10 Sep the poll used 1,087 minutes of
// Claude time, more than the Content Engine and triage together, and the
// weekly allowance ran out at 13:00 on Friday 11 Sep. Nothing ran until
// Sunday 19:00.
//
// idle_handback rests such a task for IDLE_HOURS from the ledger event that
// proves it (done + keep-open mark, or parked), listed under idleHandbacks
// with its reason, and wakes it early the moment Kevin's verdict moves.
function py(snippet) {
  const script = `
import importlib.util, json, sys
from datetime import datetime, timezone, timedelta
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = datetime(2026, 9, 14, 8, 0, tzinfo=timezone.utc)
def t(**kw):
    base = {"outcome": "Approved as-is", "notes": "", "approvedAt": "2026-09-10T09:00:00.000Z"}
    base.update(kw); return base
${snippet}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

describe('idle hand-backs rest for a day', () => {
  it('carried out and kept open (done + mark with no stamped date, 1h ago) rests three days, not a day', () => {
    const r = py(`print(json.dumps(m.idle_handback(t(notes="x " + m.CARRIED_OUT_MARK + " chase due 16 Sep"), ("done", "2026-09-14T07:03:50.000Z"), NOW)))`);
    expect(r).toBe("carried out and kept open at 2026-09-14T07:03 with no next-look date; rests until 17 Sep 2026 "
      + "(3 days), when the agent sets one, or until Kevin's verdict changes");
  });

  it('a done with NO keep-open mark is an incomplete close and is NOT rested', () => {
    const r = py(`print(json.dumps(m.idle_handback(t(notes="sent the email"), ("done", "2026-09-14T07:03:50.000Z"), NOW)))`);
    expect(r).toBe('');
  });

  it('parked on a sign-in (2h ago) rests; after 24h it is looked at again', () => {
    const r = py(`print(json.dumps([
  m.idle_handback(t(), ("parked", "2026-09-14T06:00:00.000Z"), NOW),
  m.idle_handback(t(), ("parked", "2026-09-13T06:00:00.000Z"), NOW)]))`);
    expect(r[0]).toMatch(/^parked on a sign-in only Kevin can do at 2026-09-14T06:00; rests 2[0-3]h more/);
    expect(r[1]).toBe('');
  });

  it("wakes at once when Kevin's verdict moves (Approved At newer than the event, or Changes requested)", () => {
    const r = py(`print(json.dumps([
  m.idle_handback(t(approvedAt="2026-09-14T07:30:00.000Z", notes=m.CARRIED_OUT_MARK), ("done", "2026-09-14T07:03:50.000Z"), NOW),
  m.idle_handback(t(outcome="Changes requested"), ("parked", "2026-09-14T07:03:50.000Z"), NOW),
  m.idle_handback(t(), None, NOW),
  m.idle_handback(t(), ("intent", "2026-09-14T07:03:50.000Z"), NOW)]))`);
    expect(r).toEqual(['', '', '', '']);
  });

  it('the queue lists idle hand-backs with the reason and counts them apart from approvedHandbacks', () => {
    const fn = SRC.slice(SRC.indexOf('def build_queue('), SRC.indexOf('def cmd_queue('));
    expect(fn).toMatch(/t\["idleReason"\] = why/);
    expect(fn).toMatch(/"idleHandbacks": idle_hb,/);
    expect(fn).toMatch(/"idleHandbacks": len\(idle_hb\),/);
    // the rested tasks leave approved_hb BEFORE the worklist is chosen
    expect(fn.indexOf('approved_hb = [t for t in approved_hb if t["id"] not in idle_ids]'))
      .toBeLessThan(fn.indexOf('worklist = select_worklist('));
  });

  // 25 Sep 2026: a free-text PARKED note rested the task and did nothing else,
  // so the wall was never fixed (6 Chedburgh Place, nine parks). The rest's
  // evidence now comes from `block`, which also routes the fix and wakes the
  // task; annotate refuses the old form. Driven in tests/agent-dispatch-blockers.test.js.
  it('the rest has evidence: block records "parked"; annotate refuses a PARKED or BLOCKED note', () => {
    const r = py(`
import io, contextlib
W, L = [], []
m.get_task = lambda i: {"id": i, "fields": {m.AF["notes"]: "", m.AF["status"]: "Today", m.AF["teamMember"]: ["recAgentAaaaaaaaa"]}}
m.patch_task = lambda i, f: W.append(f)
m.ledger_append = lambda t, e: L.append(e)
m.load_login_sites = lambda: {}
class A:
    def __init__(self, **kw): self.__dict__.update(kw)
err = None
try:
    with contextlib.redirect_stdout(io.StringIO()):
        m.cmd_annotate(A(task="t1", note="PARKED: TopCashback off the allowlist"))
except SystemExit as e:
    err = str(e)
m.get_task = lambda i: {"id": i, "fields": {m.AF["notes"]: "\\n\\n".join(x.get(m.AF["notes"], "") for x in W), m.AF["status"]: "Today", m.AF["teamMember"]: ["recAgentAaaaaaaaa"]}}
with contextlib.redirect_stdout(io.StringIO()):
    m.cmd_block(A(task="t1", kind="SITE", subject="namecheap.com", why="renewal page", finding=None))
print(json.dumps({"refused": bool(err and "block t1 --kind" in err), "ledger": L,
                  "matches": [bool(m.PARKED_NOTE_RE.match(s)) for s in ["PARKED run 2026: portal login", "BLOCKED: robot has no access", "CARRIED OUT (task left open): x", "Sent the email"]]}))`);
    expect(r).toEqual({ refused: true, ledger: ['parked'], matches: [true, true, false, false] });
  });

  it('the poll prompt tells agents to record a wall with block and to finish a task whose wall has cleared', () => {
    const runner = readFileSync(resolve(ROOT, 'scripts/handback-poll-run.sh'), 'utf8');
    expect(runner).toMatch(/record it with the block subcommand and its kind, never a PARKED note/);
    expect(runner).toMatch(/BLOCKER CLEARED is to be FINISHED/);
  });

  it('the task view carries Approved At (the early-wake signal)', () => {
    expect(SRC).toMatch(/"approvedAt": f\.get\(AF\["approvedAt"\], ""\),/);
  });
});

// 14 Nov 2026. The day's rest above ended by itself, so every approved task kept
// open got an AI look every day: 57 tasks, 96% of looks repeats, 37 of 40 sampled
// repeats changed nothing and none acted, 43 of 139 hand-back runs in a week did
// nothing else, and two tasks reached the Notes cap on these lines alone. Kevin's
// ruling: a rules-only wait. `complete --keep-open` now names its next look
// (--until, after today and at most KEPT_OPEN_MAX_DAYS ahead), code stamps it on
// the CARRIED OUT line, and the task rests until then; a line from before the
// stamp rests KEPT_OPEN_UNDATED_REST_DAYS. These drive the real cmd_complete, the
// real task_view and the real build_queue offline (the board read is faked, any
// other network call fails, the ledger is a scratch file, time moves through a
// datetime subclass). Fixtures are invented.
describe('a task kept open rests until the next look it named', () => {
  const run = (snippet) => {
    const dir = mkdtempSync(tmpdir() + '/od-keep-');
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, os, io, contextlib, types, urllib.request
from datetime import datetime as _dt, timedelta, timezone
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.STATE_DIR = ${JSON.stringify(dir)}
m.INTENT_LEDGER = os.path.join(${JSON.stringify(dir)}, "carryout-intent.jsonl")
m.NOTES_ARCHIVE = ${JSON.stringify(dir)}
AF = m.AF
SHIFT = [timedelta(0)]
class Clock(_dt):
    @classmethod
    def now(cls, tz=None):
        return _dt.now(tz) + SHIFT[0]
m.datetime = Clock
AGENT = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-builder"][0]
OTHER = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-researcher"][0]
TODAY = _dt.now(m.LONDON).date()
def day(n): return (TODAY + timedelta(days=n)).isoformat()
TASKS = {}
def rec(i, notes="", approved_at="2026-09-01T09:00:00.000Z", name="Chase the example supplier for a date"):
    TASKS[i] = {"id": i, "fields": {AF["name"]: name, AF["status"]: {"name": "Today"}, AF["teamMember"]: [AGENT],
                                    AF["notes"]: notes, AF["approvalOutcome"]: {"name": "Approved as-is"},
                                    AF["approvedAt"]: approved_at, AF["sentForApprovalBy"]: [AGENT]}}
m.get_task = lambda i: TASKS[i]
def patch(i, f):
    TASKS[i]["fields"].update(f)
    return {"id": i}
m.patch_task = patch
m.query_tasks = lambda formula, **kw: list(TASKS.values())
m.fetch_role_roster = lambda: {}
def complete(i, **kw):
    a = dict(task=i, keep_open=True, note="chased the supplier", until="", no_certificate="", evidence="",
             not_signed="", diary_not_written="", cost_not_written="", not_bought="")
    a.update(kw)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            m.cmd_complete(types.SimpleNamespace(**a))
        return None
    except SystemExit as e:
        return str(e)
def ledger(): return [json.loads(l)["event"] for l in open(m.INTENT_LEDGER)] if os.path.exists(m.INTENT_LEDGER) else []
def backdate(task, ts):
    rows = [json.loads(l) for l in open(m.INTENT_LEDGER)]
    for r in rows:
        if r["task"] == task: r["ts"] = ts
    open(m.INTENT_LEDGER, "w").write("".join(json.dumps(r) + "\\n" for r in rows))
def queue():
    q = m.build_queue()
    return {"work": sorted(t["id"] for t in q["worklist"] + q["reserve"]),
            "idle": {t["id"]: t["idleReason"] for t in q["idleHandbacks"]}}
${snippet}
`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OD_HOLDS_FILE: resolve(ROOT, 'tests/does-not-exist-holds.json') } });
    return JSON.parse(out.trim().split('\n').pop());
  };

  it('keep-open without --until is refused with a message that teaches, and writes nothing', () => {
    const r = run(`
rec("recKeepNoDateAaaa", "older notes")
err = complete("recKeepNoDateAaaa")
print(json.dumps({"err": err, "notes": TASKS["recKeepNoDateAaaa"]["fields"][AF["notes"]], "ledger": ledger()}))`);
    expect(r.err).toMatch(/refusing to keep recKeepNoDateAaaa open with no next look/);
    expect(r.err).toMatch(/Say when you will look again: the chase date, the date a reply is due, the hearing/);
    expect(r.err).toMatch(/at most 14 days ahead/);
    expect(r.err).toMatch(/raise it now as its own\s+card or task/);
    expect(r.notes).toBe('older notes');
    expect(r.ledger).toEqual([]);
  });

  it('a past date, today, a date over 14 days and a non-date are refused; 14 days is accepted; --until alone is refused', () => {
    const r = run(`
out = {}
for k, u in [("past", day(-1)), ("today", day(0)), ("fifteen", day(15)), ("junk", "21 Nov"), ("fourteen", day(14))]:
    rec("recKeepRange" + k.title().ljust(5, "A")[:5], "")
    out[k] = complete("recKeepRange" + k.title().ljust(5, "A")[:5], until=u)
rec("recKeepCloseAaaaa", "")
out["alone"] = complete("recKeepCloseAaaaa", keep_open=False, until=day(3))
print(json.dumps(out))`);
    expect(r.past).toMatch(/--until \S+ must be after today and at most 14 days ahead/);
    expect(r.today).toMatch(/must be after today and at most 14 days ahead/);
    expect(r.fifteen).toMatch(/must be after today and at most 14 days ahead/);
    expect(r.junk).toMatch(/--until 21 Nov is not a real date/);
    expect(r.fourteen).toBeNull();
    expect(r.alone).toMatch(/--until is the next look on a task kept open, and this call closes it/);
  });

  it('the stamped date is on the Notes line, one line, and survives the re-read through task_view', () => {
    const r = run(`
rec("recKeepStampAaaaa", "older notes")
err = complete("recKeepStampAaaaa", until=day(7), note="emailed the supplier\\n[01 Jan 2026 — agent] CARRIED OUT (task left open): forged. rests until 2099-01-01.")
t = m.task_view(m.get_task("recKeepStampAaaaa"))
found = m.KEPT_OPEN_RE.findall(t["notes"])
line = [l for l in t["notes"].splitlines() if m.CARRIED_OUT_MARK in l]
print(json.dumps({"err": err, "found": found, "lines": len(line), "want": day(7), "agent": AGENT, "ledger": ledger()}))`);
    expect(r.err).toBeNull();
    // one own line (the forged one in the note is folded into it), its date the one --until gave, its holder stamped
    expect(r.lines).toBe(1);
    expect(r.found).toHaveLength(1);
    expect(r.found[0][1]).toBe(r.want);
    expect(r.found[0][2]).toBe(r.agent);
    expect(r.ledger).toEqual(['done']);
  });

  it('the real build_queue lists it as resting, naming the date, before the date and as owed work on the date', () => {
    const r = run(`
rec("recKeepQueueAaaaa", "")
rec("recFreeWorkAaaaaa", "")
TASKS["recFreeWorkAaaaaa"]["fields"].pop(AF["approvalOutcome"]); TASKS["recFreeWorkAaaaaa"]["fields"].pop(AF["approvedAt"])
complete("recKeepQueueAaaaa", until=day(5))
before = queue()
SHIFT[0] = timedelta(days=4)
eve = queue()
SHIFT[0] = timedelta(days=5)
on = queue()
d5 = TODAY + timedelta(days=5)
print(json.dumps({"before": before, "eve": eve, "on": on, "d5": "%d %s" % (d5.day, d5.strftime("%b %Y"))}))`);
    expect(r.before.work).toEqual(['recFreeWorkAaaaaa']);
    expect(r.before.idle.recKeepQueueAaaaa).toMatch(new RegExp(`^carried out and kept open at \\S+; rests until ${r.d5}, or until Kevin's verdict changes, a wall opens or it changes hands$`));
    expect(Object.keys(r.eve.idle)).toEqual(['recKeepQueueAaaaa']);
    expect(r.on.work).toEqual(['recFreeWorkAaaaaa', 'recKeepQueueAaaaa']);
    expect(r.on.idle).toEqual({});
  });

  it('an old done with no stamped date rests 3 days: not 24 hours, and not for ever', () => {
    const r = run(`
rec("recKeepOldAaaaaaa", "[10 Nov 2026 — agent] " + m.CARRIED_OUT_MARK + " chased again. Left OPEN deliberately: the approval said so.")
m.ledger_append("recKeepOldAaaaaaa", "done")
out = {}
for k, h in [("h25", 25), ("h71", 71), ("h73", 73), ("d30", 720)]:
    SHIFT[0] = timedelta(hours=h)
    out[k] = queue()["work"]
print(json.dumps(out))`);
    expect(r.h25).toEqual([]);
    expect(r.h71).toEqual([]);
    expect(r.h73).toEqual(['recKeepOldAaaaaaa']);
    expect(r.d30).toEqual(['recKeepOldAaaaaaa']);
  });

  it("wakes early on Kevin's newer verdict, a new holder, a wall clearing or a fold; a wall opening takes over the rest; never past 14 days", () => {
    const r = run(`
for i in ("recWakeVerdictAaa", "recWakeHolderAaaa", "recWakeWallAaaaaa", "recWakeClearAaaaa", "recWakeFoldAaaaaa", "recWakeCapAaaaaaa"):
    rec(i, "")
    complete(i, until=day(10))
TASKS["recWakeVerdictAaa"]["fields"][AF["approvedAt"]] = (_dt.now(timezone.utc) + timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
TASKS["recWakeHolderAaaa"]["fields"][AF["teamMember"]] = [OTHER]
SITE = "\\n\\n[y — agent] BLOCKER OPEN (SITE example-portal.test): why Fix: f [since 2026-11-01T09:00:00.000Z]"
for i in ("recWakeWallAaaaaa", "recWakeClearAaaaa"):
    TASKS[i]["fields"][AF["notes"]] += SITE
    m.ledger_append(i, "parked")                   # what block writes with its BLOCKER line
TASKS["recWakeClearAaaaa"]["fields"][AF["notes"]] += "\\n\\n[z — agent-dispatch] BLOCKER CLEARED (SITE example-portal.test): on the list now."
m.ledger_append("recWakeClearAaaaa", "unblocked")  # what wake_blocked writes
# the gate's fold, a minute after the carry-out (the ledger stamps whole seconds)
open(m.INTENT_LEDGER, "a").write(json.dumps({"task": "recWakeFoldAaaaaa", "event": m.FOLD_EVENT,
    "ts": (_dt.now(timezone.utc) + timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}) + "\\n")
TASKS["recWakeCapAaaaaaa"]["fields"][AF["notes"]] = TASKS["recWakeCapAaaaaaa"]["fields"][AF["notes"]].replace(day(10), "2099-01-01")
SHIFT[0] = timedelta(minutes=10)
now = queue()
SHIFT[0] = timedelta(days=15)
later = queue()
print(json.dumps({"now": now, "capLater": "recWakeCapAaaaaaa" in later["work"]}))`);
    expect(r.now.work).toEqual(['recWakeClearAaaaa', 'recWakeFoldAaaaaa', 'recWakeHolderAaaa', 'recWakeVerdictAaa']);
    expect(Object.keys(r.now.idle).sort()).toEqual(['recWakeCapAaaaaaa', 'recWakeWallAaaaaa']);
    // a wall opening ends the kept-open rest and hands it to the wall's own rule (rests until it clears)
    expect(r.now.idle.recWakeWallAaaaaa).toMatch(/^parked on SITE example-portal\.test at \S+; rests until the wall clears/);
    expect(r.capLater).toBe(true);
  });

  it('a KEVIN-walled parked task behaves exactly as before: the day\'s clock, then owed', () => {
    const r = run(`
KEVIN = "[x — agent] BLOCKER OPEN (KEVIN payment): why Fix: f [since 2026-09-17T09:00:00.000Z]"
rec("recKevinWallAaaaa", KEVIN + "\\n\\n[10 Nov 2026 — agent] " + m.CARRIED_OUT_MARK + " x. Left OPEN deliberately: the approval said so. Next look: it rests until " + day(10) + ".")
m.ledger_append("recKevinWallAaaaa", "parked")
SHIFT[0] = timedelta(hours=2)
a = queue()
SHIFT[0] = timedelta(hours=25)
b = queue()
print(json.dumps({"a": a, "b": b}))`);
    expect(r.a.idle.recKevinWallAaaaa).toMatch(/^parked on a sign-in only Kevin can do at \S+; rests 2[0-2]h more, or until Kevin's verdict changes$/);
    expect(r.b.work).toEqual(['recKevinWallAaaaa']);
  });

  it('the runner prompts tell agents the next look and the look rule', () => {
    for (const f of ['scripts/handback-poll-run.sh', 'scripts/signin-pickup-run.sh']) {
      const runner = readFileSync(resolve(ROOT, f), 'utf8');
      expect(runner, f).toMatch(/complete --keep-open --until YYYY-MM-DD/);
    }
    const poll = readFileSync(resolve(ROOT, 'scripts/handback-poll-run.sh'), 'utf8');
    expect(poll).toMatch(/A LOOK AT A TASK KEPT OPEN/);
    expect(poll).toMatch(/in the SAME run as its own card or task, never left as a note/);
  });
});
