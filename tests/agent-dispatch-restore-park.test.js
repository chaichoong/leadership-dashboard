import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// A FOLD MUST NOT UNDO HIS PARK.
//
// On 19 Oct 2026 Kevin parked the weekly trust review card to 17 Jan 2027 (`decided --until`). On 2 Nov the
// next weekly trust review folded into it and the creation gate's build_update moved it back to Approval.
//   - finding 20261105-agent-dispatch-1207: the fold must keep a standing park (Status and Due Date).
//   - finding 20261105-agent-dispatch-1209: he approved putting the card back to Upcoming, and no command could
//     (`due` refuses a task at Approval, `decided` refuses a card without DECIDE:): `restore-park` now does.
// Each finding has its own tests. They drive the real build_update and the real cmd_restore_park against an
// in-memory task. Ids and dates are invented.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const GATE = resolve(ROOT, 'scripts/create-agent-task.py');

const LOAD = `
import importlib.util, json, io, sys, contextlib, types, urllib.request
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod
PARK = "[19 Oct 2026 — agent-dispatch] Parked until 2027-01-17 on Kevin's answer; it comes back on the board that day."
`;

function py(body) {
  const out = execFileSync('python3', ['-c', LOAD + body], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('finding 20261105-agent-dispatch-1207: a fold keeps a park Kevin gave', () => {
  const fold = (status, notes, due = '2027-01-17') => py(`
g = load("g", ${JSON.stringify(GATE)})
F = g.F
existing = {F["status"]: "${status}", F["due"]: "${due}", F["notes"]: ${JSON.stringify(notes)}, F["desc"]: "TRUST REVIEW 2026-10-19"}
incoming = {F["status"]: "Approval", F["sentForApprovalBy"]: ["recCEOxxxxxxxxxx1"], F["due"]: "2026-11-02",
            F["desc"]: "TRUST REVIEW 2026-11-02"}
p = g.build_update(existing, incoming, "2026-11-02")
print(json.dumps({"status": p.get(F["status"]), "due": p.get(F["due"]), "sender": p.get(F["sentForApprovalBy"])}))`);

  it('the weekly review folding into the parked card leaves it Upcoming on its date', () => {
    const r = fold('Upcoming', '[19 Oct 2026 — agent-dispatch] Parked until 2027-01-17 on Kevin\'s answer; it comes back on the board that day.');
    expect(r.status).toBe(null);
    expect(r.sender).toBe(null);
    expect([null, '2027-01-17']).toContain(r.due);
  });

  it('CONTROL: with no park, or a park that has passed, the fold moves it as before', () => {
    expect(fold('Upcoming', '').status).toBe('Approval');
    expect(fold('Upcoming', '[19 Oct 2026 — agent-dispatch] Parked until 2026-10-30 on Kevin\'s answer', '2026-10-30').status).toBe('Approval');
    // a park line someone typed is not the dispatcher's stamp
    expect(fold('Upcoming', '[19 Oct 2026 — agent] Parked until 2027-01-17 on Kevin\'s answer').status).toBe('Approval');
  });

  it('a hard deadline earlier than the park ends it, and a fold the park holds says so in Notes (review of PR #978)', () => {
    const r = py(`
g = load("g", ${JSON.stringify(GATE)})
F = g.F
existing = {F["status"]: "Upcoming", F["due"]: "2027-01-17", F["notes"]: PARK, F["desc"]: "x"}
hard = g.build_update(existing, {F["status"]: "Today", F["due"]: "2026-11-25", F["hardDeadline"]: True, F["desc"]: "pay by 25 Nov"}, "2026-11-18")
held = g.build_update(existing, {F["status"]: "Approval", F["sentForApprovalBy"]: ["recCEOxxxxxxxxxx1"], F["desc"]: "weekly"}, "2026-11-18")
print(json.dumps({"hardStatus": hard.get(F["status"]), "hardDue": hard.get(F["due"]),
                  "heldNote": str(held.get(F["notes"]) or "").split("\\n\\n")[-1]}))`);
    expect(r.hardStatus).toBe('Today');
    expect(r.hardDue).toBe('2026-11-25');
    expect(r.heldNote).toMatch(/Folded in while Kevin's park stands until 2027-01-17/);
  });

  it('the gate reads the same park line the dispatcher writes (no drift)', () => {
    const r = py(`
g = load("g", ${JSON.stringify(GATE)}); d = load("d", ${JSON.stringify(DISPATCH)})
print(json.dumps([g.KEVIN_PARK_LINE_RE.pattern == d.KEVIN_PARK_RE.pattern, g.KEVIN_PARK_LINE_RE.flags == d.KEVIN_PARK_RE.flags]))`);
    expect(r).toEqual([true, true]);
  });
});

describe('finding 20261105-agent-dispatch-1209: restore-park puts back a park the fold undid', () => {
  const restore = (over = {}) => py(`
d = load("d", ${JSON.stringify(DISPATCH)})
AF = d.AF
d.today_london = lambda: "2026-11-18"
f = {AF["name"]: "TRUST REVIEW: 2026-10-19, 1 bar crossed", AF["status"]: {"name": "Approval"},
     AF["dueDate"]: "2027-01-17", AF["notes"]: PARK, AF["sentForApprovalBy"]: ["recCEOxxxxxxxxxx1"]}
for k, v in json.loads(${JSON.stringify(JSON.stringify(over))}).items():
    f[d.HARD_DEADLINE_FIELD if k == "hardDeadline" else AF[k]] = v
T = {"id": "recTRUSTxxxxxxxx1", "createdTime": "2026-10-19T06:48:00.000Z", "fields": f}
d.get_task = lambda i: json.loads(json.dumps(T))
def patch(i, fields):
    T["fields"].update(fields)
d.patch_task = patch
err = None
try:
    with contextlib.redirect_stdout(io.StringIO()):
        d.cmd_restore_park(types.SimpleNamespace(task="recTRUSTxxxxxxxx1"))
except SystemExit as e:
    err = str(e)
nf = T["fields"]
print(json.dumps({"err": err, "status": d.sel(nf.get(AF["status"])), "due": nf.get(AF["dueDate"]),
                  "sender": nf.get(AF["sentForApprovalBy"]), "last": str(nf.get(AF["notes"]) or "").split("\\n\\n")[-1]}))`);

  it('a card the fold moved back to Approval goes back to Upcoming on his date, out of his queue', () => {
    const r = restore();
    expect(r.err).toBe(null);
    expect(r.status).toBe('Upcoming');
    expect(r.due).toBe('2027-01-17');
    expect(r.sender).toEqual([]);
    expect(r.last).toMatch(/^\[\d{2} \w{3} \d{4} — agent-dispatch\] Parked until 2027-01-17 on Kevin's answer \(his earlier park/);
  });

  it('never when anything newer than the park is on record, or a hard deadline falls before it (review of PR #978)', () => {
    const after = (line) => restore({ notes: "[19 Oct 2026 — agent-dispatch] Parked until 2027-01-17 on Kevin's answer\n\n" + line });
    expect(after('[10 Nov 2026 09:00 — agent-dispatch] SUBMITTED (round 2) as Admin with no new file').err).toMatch(/a card was submitted/);
    expect(after('[10 Nov 2026 — agent-dispatch] Escalated to Kevin as a decision card (holder recX)').err).toMatch(/escalated to him/);
    expect(after('[12 Nov 2026 — agent-dispatch] Decision carried out: Approved as-is').err).toMatch(/decision of his was carried out/);
    expect(after('[12 Nov 2026 09:00 — agent-dispatch] DUE MOVED from 2027-01-17 to 2026-12-01: his words').err).toMatch(/due date was moved/);
    expect(restore({ hardDeadline: true, dueDate: '2026-12-01' }).err).toMatch(/Hard Deadline of 2026-12-01 falls before the park/);
  });

  it('never without his park, after it ran out, or when he answered again since', () => {
    expect(restore({ notes: '' }).err).toMatch(/no park of Kevin's is recorded/);
    expect(restore({ notes: '[19 Oct 2026 — agent] Parked until 2027-01-17 on Kevin\'s answer' }).err).toMatch(/no park of Kevin's/);
    expect(restore({ notes: '[19 Oct 2026 — agent-dispatch] Parked until 2026-11-01 on Kevin\'s answer' }).err).toMatch(/has passed/);
    expect(restore({ approvedAt: '2026-11-03T09:00:00.000Z' }).err).toMatch(/his newer answer decides/);
    expect(restore({ status: { name: 'Completed' } }).err).toMatch(/is Completed/);
    expect(restore({ status: { name: 'Upcoming' } }).err).toMatch(/already stands/);
  });
});
