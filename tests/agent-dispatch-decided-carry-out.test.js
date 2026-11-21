// Finding 20261119-agent-dispatch-1379. Kevin approved option A on a DECIDE: card
// at 10:00 on 19 Nov 2026 (file the approved GitHub Support request word for word).
// `decided` carried the answer out, which ARCHIVES the verdict: it clears Approval
// Outcome and Approved At and leaves "DECIDED (Kevin, <date>): Approved as-is" at
// the top of the Agent Output. The 13:00 dispatch then read the task as `new` work,
// handed it the prepare-only brief that forbids sending, and the approved request
// was never filed. No alarm: every step behaved as written.
//
// The fix reads the archived verdict with decided_card_verdict, the same reader
// `complete` already trusts to close such a task. Back-test: every case here fails
// on the code before, where the archived verdict is read as `new`.
//
// Everything drives the real build_queue. Airtable is in memory, every network call
// raises, state goes to a temp folder. Names, ids and dates are invented.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts', 'agent-dispatch.py');

const PRE = `
import importlib.util, json, os, tempfile, urllib.request
from datetime import datetime as _dt, timedelta, timezone
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
AGENT = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-builder"][0]
TODAY = _dt.now(m.LONDON).date()
STAMP = TODAY.strftime("%d %b %Y")
CREATED = (_dt.now(timezone.utc) - timedelta(days=40)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
TASKS = {}

DECIDED_MARK = "[%s 10:00 \u2014 agent-dispatch] %s: " % (STAMP, m.DECIDED_NOTE_MARK)

def rec(i, output="", notes="", outcome=None):
    """A task the way \`decided\` leaves it: no live verdict, the verdict in the output and a stamped mark."""
    f = {AF["name"]: "DATA PROTECTION: ask Exampleton Support to remove the old files",
         AF["status"]: {"name": "Today"}, AF["teamMember"]: [AGENT],
         AF["description"]: "File the approved request with Exampleton Support.",
         AF["notes"]: notes, AF["agentOutput"]: output, AF["taskType"]: {"name": "Drafting"}}
    if outcome:
        f.update({AF["approvalOutcome"]: {"name": outcome}, AF["approvedAt"]: m.now_iso(),
                  AF["sentForApprovalBy"]: [AGENT]})
    TASKS[i] = {"id": i, "createdTime": CREATED, "fields": f}
    return TASKS[i]

m.get_task = lambda i: json.loads(json.dumps(TASKS[i]))
m.patch_task = lambda i, f: TASKS[i]["fields"].update(f) or {"id": i}
m.query_tasks = lambda formula, **kw: ([json.loads(json.dumps(t)) for t in TASKS.values()]
                                       if formula == m.QUEUE_FORMULA else [])
m.fetch_role_roster = lambda: {}
m.fetch_ai_agents = lambda: {}
m.finding_details = lambda: {}
m.task_fields_owe_certificate = lambda *a, **k: []
m.task_owes_cost = lambda *a, **k: []

def kinds():
    q = m.build_queue()
    return {t["id"]: {"kind": t.get("kind"), "archived": t.get("archivedVerdict", "")}
            for t in q["worklist"] + q["reserve"]}
`;

function py(snippet) {
  const out = execFileSync('python3', ['-c', PRE + snippet], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OD_HOLDS_FILE: resolve(ROOT, 'tests/does-not-exist-holds.json'), SIGNIN_SKIP_WALK: '1' },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const DECIDED = 'DECIDED (Kevin, 19 Nov 2026): Approved as-is\n\nDECIDE: file the approved request?';

describe("an approval the dispatcher archived is a carry-out, never new work", () => {
  it('reads the archived verdict and hands the run an approved carry-out', () => {
    const r = py(`
rec("recDecidedAaaaaaa", output=${JSON.stringify(DECIDED)}, notes=DECIDED_MARK + "Approved as-is")
print(json.dumps(kinds()))`);
    expect(r.recDecidedAaaaaaa.kind).toBe('carry_out');
    expect(r.recDecidedAaaaaaa.archived).toBe('Approved as-is');
  });

  it('a LIVE verdict always wins: Changes requested is a redo and the archive is never read', () => {
    // A verdict of his that came after the decision decides, so a task he sent
    // back must not be carried out on the strength of the archived approval.
    const r = py(`
rec("recRedoAaaaaaaaaa", output=${JSON.stringify(DECIDED)}, notes=DECIDED_MARK + "Approved as-is",
    outcome="Changes requested")
print(json.dumps(kinds()))`);
    expect(r.recRedoAaaaaaaaaa.kind).toBe('redo');
    expect(r.recRedoAaaaaaaaaa.archived).toBe('');
  });

  it('an output that only mentions a decision, or a mark nobody stamped, is still new work', () => {
    const r = py(`
# the words, but not as the dispatcher wrote them, and no stamped mark in Notes
rec("recWordsAaaaaaaaa", output="The card was DECIDED (Kevin, 19 Nov 2026): Approved as-is")
rec("recNoMarkAaaaaaaa", output=${JSON.stringify(DECIDED)}, notes="nothing stamped here")
print(json.dumps(kinds()))`);
    expect(r.recWordsAaaaaaaaa.kind).toBe('new');
    expect(r.recNoMarkAaaaaaaa.kind).toBe('new');
  });

  it('a card SUBMITTED after the decision carries its own verdict, so the archive no longer decides', () => {
    const r = py(`
later = "[%s 11:00 \u2014 agent-dispatch] SUBMITTED (round 2) as Correspondence" % STAMP
rec("recNewCardAaaaaaa", output=${JSON.stringify(DECIDED)},
    notes=DECIDED_MARK + "Approved as-is\\n\\n" + later)
print(json.dumps(kinds()))`);
    expect(r.recNewCardAaaaaaa.kind).toBe('new');
  });
});
