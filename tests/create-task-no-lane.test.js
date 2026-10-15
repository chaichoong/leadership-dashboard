import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// A task is never created for an AI agent no robot works (Kevin, 15 Oct 2026, after PR #792).
//
// PR #792 taught the Task Board Manager to move a live task held by an AI agent no robot works.
// Two sources still MADE such tasks: scripts/create-agent-task.py accepted any Team Member, and
// daily-ops phase 2 gave its data-invariant tasks to the AI Bookkeeper (the Reconciliation tab's
// matcher, which takes no tasks) on 30 Sep, 3, 5, 11 and 15 Oct; each waited until the board moved
// it. Now the gate refuses such a holder, naming a working agent, using agent-dispatch.py's own
// `no_lane_holders` and its own two reads, and daily-ops raises with `--owner worker-analyst`.
//
// These tests drive the real create-agent-task.py (cmd_create through main) and the real
// agent-dispatch.py it imports, against a fake Airtable at the gate's one `_request`. The Team
// Members and register rows are shaped from the live tables as read on 15 Oct 2026.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = resolve(ROOT, 'scripts/create-agent-task.py');
const SKILL = readFileSync(resolve(ROOT, '.claude/scheduled-tasks/daily-ops/SKILL.md'), 'utf8');

const BOOKKEEPER = 'recAdy3T0lcr4I9eZ';   // AI Bookkeeper (Team Members, live 15 Oct 2026)
const ANALYST = 'recqmKBmq8ZGkxVH9';      // AI Worker — Analyst
const CEO = 'reciHUAEcEkbctnZ6';
const RESPONSE = 'recJ8J8idWE8d97tH';     // AI Inbox Response (role agent, Built)
const CFV = 'rec7aHLK1Q8fMLRXH';          // AI Cash Flow Voids (role agent)
const PRODUCER = 'recRcy1Edas6rGaaF';     // AI Content Producer (own schedule)
const TRIAGE = 'recCUfsTXzmVZynEI';       // AI Inbox Triage (own schedule)
const LEAD_FINDER = 'rec0unnz5sNaBoIG2';  // AI Lead Finder (Paused, outside ALL_AGENTS)
const ROY = 'reclbdjfVev3bqNHS';          // a person: no Is AI Agent tick
const KEVIN = 'recHEt2VPYothaqTd';        // a person

const AI_ROWS = {
  [CEO]: 'AI CEO (Dan Martell)', [BOOKKEEPER]: 'AI Bookkeeper', [ANALYST]: 'AI Worker — Analyst',
  [RESPONSE]: 'AI Inbox Response', [CFV]: 'AI Cash Flow Voids', [PRODUCER]: 'AI Content Producer',
  [TRIAGE]: 'AI Inbox Triage', [LEAD_FINDER]: 'AI Lead Finder',
  'recwWvBju2ycB63i4': 'AI Property Administration', 'rec1hYELb4zS8pjjO': 'AI Task Board Manager',
};
const REGISTER = {
  [BOOKKEEPER]: 'Live', [RESPONSE]: 'Built', [CFV]: 'Live', [PRODUCER]: 'Built', [TRIAGE]: 'Live',
  [LEAD_FINDER]: 'Paused', 'recwWvBju2ycB63i4': 'Built', 'rec1hYELb4zS8pjjO': 'Live',
};

// Each case: {fields, argv?, fail?: {team, teamNoCeo, register}, register?: overrides, stub?}.
// Returns per case {rc, out, err, posted (the create's fields or null), gets (tables read)}.
function gate(cases) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, io, contextlib, urllib.request
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location("g", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
d = g._dispatch()
REAL_NLH = d.no_lane_holders
AI_ROWS = json.loads(${JSON.stringify(JSON.stringify(AI_ROWS))})
REGISTER = json.loads(${JSON.stringify(JSON.stringify(REGISTER))})
CASES = json.loads(sys.argv[1])
g.load_scan_cache = lambda: {}
g.write_track_record = lambda tid, fields: None
results = []
for c in CASES:
    fail = c.get("fail") or {}
    reg = dict(REGISTER, **(c.get("register") or {}))
    state = {"created": None, "gets": []}
    def req(method, path, body=None, fail=fail, reg=reg, state=state):
        parts = path.split("?")[0].strip("/").split("/")
        if method == "GET":
            state["gets"].append(parts[0] if len(parts) == 1 else parts[0] + "/rec")
        if parts[0] == d.TEAM_TABLE:
            if fail.get("team"):
                raise RuntimeError("Airtable GET /%s -> HTTP 503: unavailable" % d.TEAM_TABLE)
            rows = [{"id": i, "fields": {d.TEAM_FIELDS["name"]: n, d.TEAM_FIELDS["isAgent"]: True}}
                    for i, n in AI_ROWS.items() if not (fail.get("teamNoCeo") and i == d.CEO_REC_ID)]
            return {"records": rows}
        if parts[0] == d.AGENTS_TABLE:
            if fail.get("register"):
                raise RuntimeError("Airtable GET /%s -> HTTP 500" % d.AGENTS_TABLE)
            return {"records": [{"id": "reg" + i[3:], "fields": {
                d.REGISTER_FIELDS["name"]: AI_ROWS.get(i, i), d.REGISTER_FIELDS["teamMember"]: [i],
                d.REGISTER_FIELDS["status"]: {"name": s}}} for i, s in reg.items()]}
        if parts[0] == g.TASKS and method == "POST":
            state["created"] = dict(body["fields"])
            return {"id": "recNEWTASK0000001", "fields": body["fields"]}
        if parts[0] == g.TASKS and len(parts) > 1:
            return {"id": parts[1], "fields": dict(state["created"] or {})}
        if parts[0] == g.TASKS:
            # The open board: one unrelated task, so the zero-row control passes and nothing folds.
            return {"records": [{"id": "recOPEN0000000001", "createdTime": "2026-10-01T09:00:00.000Z",
                                 "fields": {g.F["name"]: "MAINTENANCE: garden fence panel down",
                                            g.F["status"]: {"name": "Today"}}}]}
        raise RuntimeError("unexpected request %s %s" % (method, path))
    g._request = req
    stub = c.get("stub")
    d.no_lane_holders = REAL_NLH if not stub else (
        (lambda *a, **k: []) if stub == "never" else (lambda team, *a, **k: list(team)))
    argv = ["create"] + (c.get("argv") or []) + ["--fields-json", json.dumps(c["fields"])]
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = g.main(argv)
    lines = [l for l in out.getvalue().splitlines() if l.startswith("{")]
    results.append({"rc": rc, "out": json.loads(lines[-1]) if lines else None, "err": err.getvalue(),
                    "posted": state["created"], "gets": state["gets"]})
print(json.dumps(results))
`, JSON.stringify(cases)], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

const NAME = 'fldgFjGBw6bTKJFCD';
const STATUS = 'fldx4qCw17UfrKpaN';
const TEAM = 'flduCtmQGpOA4eWaj';
const DESC = 'fldRGhBQViKZKtkQ6';
const ASSIGNEE = 'fldELMncVJYPDRJNc';
// Shaped from the live task daily-ops raised on 15 Oct 2026 (recUjprtRvlhO0xl8).
const INVARIANT = {
  [NAME]: 'Bank re-import duplicates are back: 30 transactions double-counted, mostly Monzo CB',
  [STATUS]: 'Today',
  [DESC]: 'Raised by daily-ops phase 2, 15 October 2026, from the 06:40 data-invariants run (exit 1). '
    + 'THE INVARIANT no-reimport-duplicates FAILED with 30 violations.',
};
const held = (team, extra = {}) => ({ ...INVARIANT, [TEAM]: team, ...extra });

describe('1. a task for an AI agent no robot works is refused, with a working agent named', () => {
  it('the AI Bookkeeper: refused even with --force or --dry-run, before anything else is read or written', () => {
    const [plain, forced, dry] = gate([
      { fields: held([BOOKKEEPER]) },
      { fields: held([BOOKKEEPER]), argv: ['--force'] },
      { fields: held([BOOKKEEPER]), argv: ['--dry-run'] },
    ]);
    for (const r of [plain, forced, dry]) {
      expect(r.rc).toBe(3);
      expect(r.out.action).toBe('refused');
      expect(r.out.reason).toContain(`AI Bookkeeper (${BOOKKEEPER}) takes no tasks: no robot works this agent`);
      expect(r.out.reason).toContain(`Give it to AI Worker — Analyst instead: pass --owner worker-analyst, or put ${ANALYST} in Team Member`);
      expect(r.out.useInstead).toEqual({ id: ANALYST, name: 'AI Worker — Analyst', agentFile: 'worker-analyst' });
      expect(r.err).toContain('REFUSED: Team Member AI Bookkeeper');
      expect(r.posted).toBeNull();
      // Refused before the duplicate gate read the board: the only reads are the two rosters.
      expect(r.gets.filter((t) => t === 'tblqB8b22hKBL4PF1')).toEqual([]);
    }
    expect(dry.out.dryRun).toBe(true);
  });

  it('a role agent Kevin paused, and a planned or paused row outside the roster, are refused and sent to the AI CEO', () => {
    const [paused, outside, withPaused, byName] = gate([
      { fields: held([CFV]), register: { [CFV]: 'Paused' } },
      { fields: held([LEAD_FINDER]) },
      { fields: held([BOOKKEEPER, LEAD_FINDER]) },
      // A link given by NAME: the typecast retry would link it to the Bookkeeper's row.
      { fields: held(['AI Bookkeeper']) },
    ]);
    expect(paused.rc).toBe(3);
    expect(paused.out.reason).toContain('AI Cash Flow Voids');
    expect(paused.out.reason).toContain('register status: Paused');
    expect(paused.out.useInstead.id).toBe(CEO);
    expect(outside.rc).toBe(3);
    expect(outside.out.reason).toContain(`AI Lead Finder (${LEAD_FINDER}) takes no tasks`);
    expect(outside.out.reason).toContain('--owner od-ceo');
    expect(outside.out.useInstead.id).toBe(CEO);
    // Two holders, neither worked: both named, and the first one's successor (the Bookkeeper's).
    expect(withPaused.rc).toBe(3);
    expect(withPaused.out.reason).toContain('AI Bookkeeper');
    expect(withPaused.out.reason).toContain('AI Lead Finder');
    expect(withPaused.posted).toBeNull();
    expect(byName.rc).toBe(3);
    expect(byName.out.useInstead.id).toBe(ANALYST);
    expect(byName.posted).toBeNull();
  });
});

describe('2. a working agent, a person and a blank owner are created as before', () => {
  it('the Analyst, Inbox Response, Roy, Kevin, a person beside the Bookkeeper, an Assignee, and no owner at all', () => {
    const rs = gate([
      { fields: held([ANALYST]) },
      { fields: held([RESPONSE]) },
      { fields: held([ROY]) },
      { fields: held([KEVIN]) },
      { fields: held([BOOKKEEPER, KEVIN]) },
      { fields: held([BOOKKEEPER], { [ASSIGNEE]: { email: 'roy@example.com' } }) },
      { fields: { ...INVARIANT } },
    ]);
    const teams = [[ANALYST], [RESPONSE], [ROY], [KEVIN], [BOOKKEEPER, KEVIN], [BOOKKEEPER], undefined];
    rs.forEach((r, i) => {
      expect(r.rc, JSON.stringify(r)).toBe(0);
      expect(r.out.action).toBe('created');
      expect(r.out.holderCheck).toBeUndefined();
      expect(r.posted[TEAM]).toEqual(teams[i]);
    });
    // No owner, or an Assignee: nothing to judge, so the rosters are not even read.
    expect(rs[5].gets).not.toContain('tblco0p2OnlLQVAX7');
    expect(rs[6].gets).not.toContain('tblco0p2OnlLQVAX7');
    // An owner: both rosters read once each.
    expect(rs[0].gets.filter((t) => t === 'tblco0p2OnlLQVAX7').length).toBe(1);
    expect(rs[0].gets.filter((t) => t === 'tbl9msVjyQWslLOIZ').length).toBe(1);
  });

  it('an agent on its own schedule raising its own card is created: the Content Engine and Inbox Triage', () => {
    // content-engine/approval.py raises each episode card with --force on its own row at Today,
    // then submits it in the same run. Refusing it would stop every episode card.
    const [producer, triage, producerByName] = gate([
      { fields: { [NAME]: 'CONTENT: Publish Episode 2090', [STATUS]: 'Today', [TEAM]: [PRODUCER] }, argv: ['--force'] },
      { fields: { [NAME]: 'TRIAGE: inbox note', [STATUS]: 'Today', [TEAM]: [TRIAGE] }, argv: ['--force'] },
      { fields: { [NAME]: 'CONTENT: Publish Episode 2091', [STATUS]: 'Today', [TEAM]: ['AI Content Producer'] }, argv: ['--force'] },
    ]);
    for (const r of [producer, triage, producerByName]) {
      expect(r.rc).toBe(0);
      expect(r.out.action).toBe('created');
    }
    expect(producer.posted[TEAM]).toEqual([PRODUCER]);
  });
});

describe('3. a roster read that fails never loses the task: it is created and flagged', () => {
  it('a Team Members read that errors, or comes back without the AI CEO, creates and says NOT CHECKED', () => {
    const [down, broken] = gate([
      { fields: held([BOOKKEEPER]), fail: { team: true } },
      { fields: held([BOOKKEEPER]), fail: { teamNoCeo: true } },
    ]);
    for (const r of [down, broken]) {
      expect(r.rc).toBe(0);
      expect(r.out.action).toBe('created');
      expect(r.posted[TEAM]).toEqual([BOOKKEEPER]);
      expect(r.out.holderCheck).toMatch(/^NOT CHECKED: the Team Members read failed/);
      expect(r.err).toContain('HOLDER NOT CHECKED');
      expect(r.err).toContain("The Task Board Manager's ownerless step is the backstop");
    }
    expect(down.out.holderCheck).toContain('HTTP 503');
    expect(broken.out.holderCheck).toContain("not the AI CEO's");
  });

  it('a register read that fails still refuses the Bookkeeper (the list alone), and creates a role agent task flagged', () => {
    const [bk, cfv] = gate([
      { fields: held([BOOKKEEPER]), fail: { register: true } },
      { fields: held([CFV]), fail: { register: true }, register: { [CFV]: 'Paused' } },
    ]);
    expect(bk.rc).toBe(3);
    expect(bk.out.reason).toContain('AI Bookkeeper');
    expect(bk.out.useInstead.id).toBe(ANALYST);
    expect(cfv.rc).toBe(0);
    expect(cfv.out.action).toBe('created');
    expect(cfv.out.holderCheck).toMatch(/^NOT CHECKED: the AI Agents register read failed/);
  });
});

describe("4. daily-ops raises its data-invariant tasks with the Analyst as owner, read live", () => {
  // The flags are read off the skill itself, so the command the routine is told to run is the
  // command this test runs through the real gate.
  const step = SKILL.split('\n').find((l) => l.includes('Who owns it: the AI Analyst'));
  const command = (step || '').match(/`python3 scripts\/create-agent-task\.py create ([^`]*?) --fields-json '<json>'`/);

  it('the skill tells phase 2 to raise through the gate with --owner worker-analyst and no Team Member', () => {
    expect(step).toBeTruthy();
    expect(command).toBeTruthy();
    expect(command[1]).toBe('--owner worker-analyst');
    expect(step).toContain('put NO Team Member in the JSON');
    expect(step).toContain('Never the AI Bookkeeper');
    // It sits in the data-invariants item of phase 2, under its failure rule.
    const inv = SKILL.indexOf('**2. Data invariants**');
    expect(inv).toBeGreaterThan(-1);
    expect(SKILL.indexOf(step)).toBeGreaterThan(inv);
    expect(SKILL.indexOf(step)).toBeLessThan(SKILL.indexOf('**3. Drive auth**'));
  });

  it("the invariant task's owner is the Analyst: its id comes from the live Team Members row, never the JSON", () => {
    const argv = command[1].split(' ');
    const [r, dry, unread] = gate([
      { fields: { ...INVARIANT }, argv },
      { fields: { ...INVARIANT }, argv: [...argv, '--dry-run'] },
      { fields: { ...INVARIANT }, argv, fail: { team: true } },
    ]);
    expect(r.rc).toBe(0);
    expect(r.out.action).toBe('created');
    expect(r.posted[TEAM]).toEqual([ANALYST]);
    expect(r.posted[TEAM]).not.toContain(BOOKKEEPER);
    expect(r.gets).toContain('tblco0p2OnlLQVAX7');
    expect(dry.rc).toBe(0);
    expect(dry.posted).toBeNull();
    // The Team Members read failed: still created, on the dispatcher's own Analyst, and flagged.
    expect(unread.rc).toBe(0);
    expect(unread.posted[TEAM]).toEqual([ANALYST]);
    expect(unread.out.holderCheck).toMatch(/^NOT CHECKED/);
  });

  it('--owner refuses an agent the dispatcher does not work, an unknown file, and a second owner in the fields', () => {
    const [unknown, paused, twice, same] = gate([
      { fields: { ...INVARIANT }, argv: ['--owner', 'bookkeeper'] },
      { fields: { ...INVARIANT }, argv: ['--owner', 'cash-flow-voids'], register: { [CFV]: 'Paused' } },
      { fields: held([BOOKKEEPER]), argv: ['--owner', 'worker-analyst'] },
      { fields: held([ANALYST]), argv: ['--owner', 'worker-analyst'] },
    ]);
    expect(unknown.rc).toBe(3);
    expect(unknown.out.reason).toBe("--owner refused: the dispatcher works no single agent under 'bookkeeper' (0 found)");
    expect(paused.rc).toBe(3);
    expect(paused.out.reason).toMatch(/^--owner refused: no robot works AI Cash Flow Voids/);
    expect(twice.rc).toBe(3);
    expect(twice.out.reason).toContain('pass the owner once');
    for (const r of [unknown, paused, twice]) expect(r.posted).toBeNull();
    expect(same.rc).toBe(0);
    expect(same.posted[TEAM]).toEqual([ANALYST]);
  });
});

describe("5. one answer: the gate asks agent-dispatch.py's own no_lane_holders", () => {
  it('replace the dispatcher function and the gate follows it, both ways', () => {
    const [never, always] = gate([
      { fields: held([BOOKKEEPER]), stub: 'never' },
      { fields: held([ANALYST]), stub: 'always' },
    ]);
    expect(never.rc).toBe(0);
    expect(never.posted[TEAM]).toEqual([BOOKKEEPER]);
    expect(always.rc).toBe(3);
    expect(always.out.reason).toContain('AI Worker — Analyst');
  });

  it('over every live-shaped AI agent row, the gate refuses exactly what the dispatcher names, bar own-schedule cards', () => {
    const ids = Object.keys(AI_ROWS);
    const rs = gate(ids.map((i) => ({ fields: held([i]) })));
    const refused = ids.filter((_, k) => rs[k].rc === 3).sort();
    expect(refused).toEqual([BOOKKEEPER, LEAD_FINDER].sort());
  });

  it('the field ids the gate reads match the dispatcher (a drifted id reads as no owner)', () => {
    const ids = JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location("g", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
d = g._dispatch()
print(json.dumps({"gate": [g.ASSIGNEE_FIELD, g.F["team"], g.F["sentForApprovalBy"], g.F["approvalOutcome"]],
                  "dispatch": [d.AF["assignee"], d.AF["teamMember"], d.AF["sentForApprovalBy"], d.AF["approvalOutcome"]]}))
`], { encoding: 'utf8' }));
    expect(ids.gate).toEqual(ids.dispatch);
  });
});
