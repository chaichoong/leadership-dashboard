import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

// A task is never left with an AI agent no robot works, and none is ever lost (Kevin, 15 Oct
// 2026, after PR #792; design per the review of PR #793).
//
// PR #792 taught the Task Board Manager to move a live task held by an AI agent no robot works.
// Two sources still MADE such tasks: scripts/create-agent-task.py accepted any Team Member, and
// daily-ops phase 2 gave its data-invariant tasks to the AI Bookkeeper (the Reconciliation tab's
// matcher, which takes no tasks) on 30 Sep, 3, 5, 11 and 15 Oct; each waited until the board moved
// it. Now the gate CREATES such a task with a working agent (the Bookkeeper's work goes to the AI
// Analyst, anything else to the AI CEO), exit 0, `rerouted` in its JSON and a dated REROUTED line
// in its Notes. It never refuses: exit 3 means "auto-reply, archive it" to the inbox skills, so a
// refusal would have archived real mail with no task. daily-ops raises with `--owner worker-analyst`.
//
// These tests drive the real create-agent-task.py (through main) and the real agent-dispatch.py
// it imports, against a fake Airtable at the gate's one `_request`. The Team Members and register
// rows are shaped from the live tables as read on 15 Oct 2026.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = resolve(ROOT, 'scripts/create-agent-task.py');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SKILL = readFileSync(resolve(ROOT, '.claude/scheduled-tasks/daily-ops/SKILL.md'), 'utf8');
const EMAIL_SKILL = readFileSync(resolve(ROOT, '.claude/scheduled-tasks/inbound-email-triage/SKILL.md'), 'utf8');
const SMS_SKILL = readFileSync(resolve(ROOT, '.claude/scheduled-tasks/inbound-messages-sweep/SKILL.md'), 'utf8');

const BOOKKEEPER = 'recAdy3T0lcr4I9eZ';   // AI Bookkeeper (Team Members, live 15 Oct 2026)
const ANALYST = 'recqmKBmq8ZGkxVH9';      // AI Worker — Analyst
const CEO = 'reciHUAEcEkbctnZ6';
const RESPONSE = 'recJ8J8idWE8d97tH';     // AI Inbox Response (role agent, Built)
const CFV = 'rec7aHLK1Q8fMLRXH';          // AI Cash Flow Voids (role agent)
const PROPERTY = 'recwWvBju2ycB63i4';     // AI Property Administration (role agent, Built)
const PRODUCER = 'recRcy1Edas6rGaaF';     // AI Content Producer (own schedule)
const TRIAGE = 'recCUfsTXzmVZynEI';       // AI Inbox Triage (own schedule)
const LEAD_FINDER = 'rec0unnz5sNaBoIG2';  // AI Lead Finder (Paused, outside ALL_AGENTS)
const ROY = 'reclbdjfVev3bqNHS';          // a person: no Is AI Agent tick
const KEVIN = 'recHEt2VPYothaqTd';        // a person

const AI_ROWS = {
  [CEO]: 'AI CEO (Dan Martell)', [BOOKKEEPER]: 'AI Bookkeeper', [ANALYST]: 'AI Worker — Analyst',
  [RESPONSE]: 'AI Inbox Response', [CFV]: 'AI Cash Flow Voids', [PRODUCER]: 'AI Content Producer',
  [TRIAGE]: 'AI Inbox Triage', [LEAD_FINDER]: 'AI Lead Finder',
  [PROPERTY]: 'AI Property Administration', 'rec1hYELb4zS8pjjO': 'AI Task Board Manager',
};
const REGISTER = {
  [BOOKKEEPER]: 'Live', [RESPONSE]: 'Built', [CFV]: 'Live', [PRODUCER]: 'Built', [TRIAGE]: 'Live',
  [LEAD_FINDER]: 'Paused', [PROPERTY]: 'Built', 'rec1hYELb4zS8pjjO': 'Live',
};

// A directory whose agent-dispatch.py will not import: the gate pointed at it meets a real
// import failure through its real _dispatch.
const BROKEN = mkdtempSync(join(tmpdir(), 'od-broken-dispatch-'));
writeFileSync(join(BROKEN, 'agent-dispatch.py'), 'def broken(:\n');

// The fake Airtable, shared by both harnesses below (Python source).
const FAKE = `
AI_ROWS = json.loads(${JSON.stringify(JSON.stringify(AI_ROWS))})
REGISTER = json.loads(${JSON.stringify(JSON.stringify(REGISTER))})
def make_req(g, d, fail, reg, state):
    def req(method, path, body=None):
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
    return req
`;

// Each case: {fields, argv?, fail?: {team, teamNoCeo, register}, register?: overrides,
// stub?: 'never'|'always'|'raise', breakImport?}. Returns per case
// {rc, out, err, posted (the create's fields or null), gets (tables read)}.
function gate(cases) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, io, contextlib, urllib.request
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location("g", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
d = g._dispatch()
REAL_NLH, REAL_FILE = d.no_lane_holders, g.__file__
${FAKE}
CASES = json.loads(sys.argv[1])
g.load_scan_cache = lambda: {}
g.write_track_record = lambda tid, fields: None
def raiser(*a, **k): raise TypeError("no_lane_holders() changed shape")
results = []
for c in CASES:
    state = {"created": None, "gets": []}
    g._request = make_req(g, d, c.get("fail") or {}, dict(REGISTER, **(c.get("register") or {})), state)
    stub = c.get("stub")
    d.no_lane_holders = {None: REAL_NLH, "never": lambda *a, **k: [],
                         "always": lambda team, *a, **k: list(team), "raise": raiser}[stub]
    if c.get("breakImport"):
        g._DISPATCH, g.__file__ = None, ${JSON.stringify(join(BROKEN, 'create-agent-task.py'))}
    argv = ["create"] + (c.get("argv") or []) + ["--fields-json", json.dumps(c["fields"])]
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = g.main(argv)
    g._DISPATCH, g.__file__ = d, REAL_FILE
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
const NOTES = 'fldR7apBzSp3oxFxz';
const ASSIGNEE = 'fldELMncVJYPDRJNc';
// Shaped from the live task daily-ops raised on 15 Oct 2026 (recUjprtRvlhO0xl8).
const INVARIANT = {
  [NAME]: 'Bank re-import duplicates are back: 30 transactions double-counted, mostly Monzo CB',
  [STATUS]: 'Today',
  [DESC]: 'Raised by daily-ops phase 2, 15 October 2026, from the 06:40 data-invariants run (exit 1). '
    + 'THE INVARIANT no-reimport-duplicates FAILED with 30 violations.',
};
const held = (team, extra = {}) => ({ ...INVARIANT, [TEAM]: team, ...extra });
const REROUTE_LINE = /^\[\d{2} \w{3} \d{4} — create-agent-task\] REROUTED: (.*), so nothing would ever pick this task up on that row\. Given to (.*) \((rec\w{14})\) instead\.$/m;

describe('1. a task for an AI agent no robot works is CREATED with a working agent, never refused', () => {
  it('the AI Bookkeeper: created for the Analyst, exit 0, rerouted in the JSON and a dated Notes line, with or without --force', () => {
    const [plain, forced, dry, withNotes] = gate([
      { fields: held([BOOKKEEPER]) },
      { fields: held([BOOKKEEPER]), argv: ['--force'] },
      { fields: held([BOOKKEEPER]), argv: ['--dry-run'] },
      { fields: held([BOOKKEEPER], { [NOTES]: 'Raised by daily-ops phase 2.' }) },
    ]);
    for (const r of [plain, forced, dry, withNotes]) {
      expect(r.rc).toBe(0);
      expect(r.out.action).toBe('created');
      expect(r.out.rerouted).toEqual({
        from: [{ id: BOOKKEEPER, name: 'AI Bookkeeper' }],
        to: { id: ANALYST, name: 'AI Worker — Analyst' },
        why: `AI Bookkeeper (${BOOKKEEPER}) takes no tasks: no robot works this agent`,
      });
      expect(r.err).toContain('REROUTED: AI Bookkeeper');
    }
    for (const r of [plain, forced, withNotes]) {
      expect(r.posted[TEAM]).toEqual([ANALYST]);
      const m = r.posted[NOTES].match(REROUTE_LINE);
      expect(m).toBeTruthy();
      expect(m[1]).toBe(`AI Bookkeeper (${BOOKKEEPER}) takes no tasks: no robot works this agent`);
      expect([m[2], m[3]]).toEqual(['AI Worker — Analyst', ANALYST]);
    }
    // A Notes value the caller sent is kept, the REROUTED line under it.
    expect(withNotes.posted[NOTES].startsWith('Raised by daily-ops phase 2.\n\n[')).toBe(true);
    expect(dry.posted).toBeNull();
  });

  it('a role agent Kevin paused, a row outside the roster, two such holders and a holder named by NAME are each placed', () => {
    const [paused, outside, both, byName, pausedProperty] = gate([
      { fields: held([CFV]), register: { [CFV]: 'Paused' } },
      { fields: held([LEAD_FINDER]) },
      { fields: held([BOOKKEEPER, LEAD_FINDER]) },
      // A link given by NAME: the typecast retry would link it to the Bookkeeper's row.
      { fields: held(['AI Bookkeeper']) },
      // The review's case: certificate mail for a paused Property Administration is never lost.
      { fields: held([PROPERTY], { [NAME]: 'COMPLIANCE: gas safety certificate arrived for 23 Viola Street' }), register: { [PROPERTY]: 'Paused' } },
    ]);
    for (const r of [paused, outside, both, byName, pausedProperty]) {
      expect(r.rc).toBe(0);
      expect(r.out.action).toBe('created');
      expect(r.posted[NOTES]).toMatch(REROUTE_LINE);
    }
    expect(paused.posted[TEAM]).toEqual([CEO]);
    expect(paused.out.rerouted.why).toContain('register status: Paused');
    expect(outside.posted[TEAM]).toEqual([CEO]);
    expect(outside.out.rerouted.from).toEqual([{ id: LEAD_FINDER, name: 'AI Lead Finder' }]);
    // Two holders, neither worked: both named, and the first one's successor (the Bookkeeper's).
    expect(both.out.rerouted.from.map((h) => h.id)).toEqual([BOOKKEEPER, LEAD_FINDER]);
    expect(both.posted[TEAM]).toEqual([ANALYST]);
    expect(byName.posted[TEAM]).toEqual([ANALYST]);
    expect(pausedProperty.posted[TEAM]).toEqual([CEO]);
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
      expect(r.out.rerouted).toBeUndefined();
      expect(r.out.holderCheck).toBeUndefined();
      expect(r.posted[TEAM]).toEqual(teams[i]);
      expect(r.posted[NOTES] || '').not.toContain('REROUTED');
    });
    // No owner, or an Assignee: nothing to judge, so the rosters are not even read.
    expect(rs[5].gets).not.toContain('tblco0p2OnlLQVAX7');
    expect(rs[6].gets).not.toContain('tblco0p2OnlLQVAX7');
    // An owner: both rosters read once each.
    expect(rs[0].gets.filter((t) => t === 'tblco0p2OnlLQVAX7').length).toBe(1);
    expect(rs[0].gets.filter((t) => t === 'tbl9msVjyQWslLOIZ').length).toBe(1);
  });

  it('an agent on its own schedule raising its own card is created on its own row: the Content Engine and Inbox Triage', () => {
    // content-engine/approval.py raises each episode card with --force on its own row at Today,
    // then submits it in the same run. Moving it would put the card on the wrong agent.
    const [producer, triage, producerByName] = gate([
      { fields: { [NAME]: 'CONTENT: Publish Episode 2090', [STATUS]: 'Today', [TEAM]: [PRODUCER] }, argv: ['--force'] },
      { fields: { [NAME]: 'TRIAGE: inbox note', [STATUS]: 'Today', [TEAM]: [TRIAGE] }, argv: ['--force'] },
      { fields: { [NAME]: 'CONTENT: Publish Episode 2091', [STATUS]: 'Today', [TEAM]: ['AI Content Producer'] }, argv: ['--force'] },
    ]);
    for (const r of [producer, triage, producerByName]) {
      expect(r.rc).toBe(0);
      expect(r.out.action).toBe('created');
      expect(r.out.rerouted).toBeUndefined();
    }
    expect(producer.posted[TEAM]).toEqual([PRODUCER]);
    expect(producerByName.posted[TEAM]).toEqual(['AI Content Producer']);
  });
});

describe('3. nothing that cannot be checked ever blocks or moves a task: it is created as given and flagged', () => {
  it('a Team Members read that errors, or comes back without the AI CEO, creates as given and says NOT CHECKED', () => {
    const [down, broken] = gate([
      { fields: held([BOOKKEEPER]), fail: { team: true } },
      { fields: held([BOOKKEEPER]), fail: { teamNoCeo: true } },
    ]);
    for (const r of [down, broken]) {
      expect(r.rc).toBe(0);
      expect(r.out.action).toBe('created');
      expect(r.posted[TEAM]).toEqual([BOOKKEEPER]);
      expect(r.out.rerouted).toBeUndefined();
      expect(r.out.holderCheck).toMatch(/^NOT CHECKED: the Team Members read failed/);
      expect(r.err).toContain('HOLDER NOT CHECKED');
      expect(r.err).toContain("The Task Board Manager's ownerless step is the backstop");
    }
    expect(down.out.holderCheck).toContain('HTTP 503');
    expect(broken.out.holderCheck).toContain("not the AI CEO's");
  });

  it('a register read that fails still places the Bookkeeper (the list alone), and leaves a role agent as given, flagged', () => {
    const [bk, cfv] = gate([
      { fields: held([BOOKKEEPER]), fail: { register: true } },
      { fields: held([CFV]), fail: { register: true }, register: { [CFV]: 'Paused' } },
    ]);
    expect(bk.rc).toBe(0);
    expect(bk.posted[TEAM]).toEqual([ANALYST]);
    expect(bk.out.holderCheck).toMatch(/^NOT CHECKED: the AI Agents register read failed/);
    expect(cfv.rc).toBe(0);
    expect(cfv.posted[TEAM]).toEqual([CFV]);
    expect(cfv.out.rerouted).toBeUndefined();
    expect(cfv.out.holderCheck).toMatch(/^NOT CHECKED: the AI Agents register read failed/);
  });

  it('agent-dispatch.py that will not import: created with the owner given (or none for --owner), NOT CHECKED, exit 0', () => {
    const [given, owner, blank] = gate([
      { fields: held([BOOKKEEPER]), breakImport: true },
      { fields: { ...INVARIANT }, argv: ['--owner', 'worker-analyst'], breakImport: true },
      { fields: { ...INVARIANT }, breakImport: true },
    ]);
    expect(given.rc).toBe(0);
    expect(given.out.action).toBe('created');
    expect(given.posted[TEAM]).toEqual([BOOKKEEPER]);
    expect(given.out.holderCheck).toMatch(/^NOT CHECKED: agent-dispatch\.py could not be loaded \(SyntaxError/);
    expect(given.gets).not.toContain('tblco0p2OnlLQVAX7');
    // --owner cannot be resolved without the dispatcher's roster: created with no Team Member, so
    // the board's ownerless step places it, and said.
    expect(owner.rc).toBe(0);
    expect(owner.out.action).toBe('created');
    expect(owner.posted[TEAM]).toBeUndefined();
    expect(owner.out.holderCheck).toContain('--owner worker-analyst could not be resolved');
    // No owner at all: the dispatcher is never needed, so a broken one is never mentioned.
    expect(blank.rc).toBe(0);
    expect(blank.out.holderCheck).toBeUndefined();
  });

  it('a holder check that errors (a dispatcher function changed shape) creates as given and says so', () => {
    const [r] = gate([{ fields: held([BOOKKEEPER]), stub: 'raise' }]);
    expect(r.rc).toBe(0);
    expect(r.posted[TEAM]).toEqual([BOOKKEEPER]);
    expect(r.out.holderCheck).toMatch(/^NOT CHECKED: the holder check failed \(TypeError/);
  });
});

describe('4. daily-ops raises its data-invariant tasks with the Analyst as owner, read live', () => {
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
    expect(step).not.toMatch(/exit 3/i);
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
    expect(r.out.rerouted).toBeUndefined();
    expect(r.gets).toContain('tblco0p2OnlLQVAX7');
    expect(dry.rc).toBe(0);
    expect(dry.posted).toBeNull();
    // The Team Members read failed: still created, on the dispatcher's own Analyst, and flagged.
    expect(unread.rc).toBe(0);
    expect(unread.posted[TEAM]).toEqual([ANALYST]);
    expect(unread.out.holderCheck).toMatch(/^NOT CHECKED/);
  });

  it('--owner with an unknown file, a paused agent or a second owner in the fields still creates, placed and said', () => {
    const [unknown, paused, twice, same] = gate([
      { fields: { ...INVARIANT }, argv: ['--owner', 'bookkeeper'] },
      { fields: { ...INVARIANT }, argv: ['--owner', 'cash-flow-voids'], register: { [CFV]: 'Paused' } },
      { fields: held([BOOKKEEPER]), argv: ['--owner', 'worker-analyst'] },
      { fields: held([ANALYST]), argv: ['--owner', 'worker-analyst'] },
    ]);
    for (const r of [unknown, paused, twice, same]) {
      expect(r.rc).toBe(0);
      expect(r.out.action).toBe('created');
    }
    expect(unknown.posted[TEAM]).toEqual([CEO]);
    expect(unknown.out.rerouted.why).toBe("--owner the dispatcher works no single agent under 'bookkeeper' (0 found)");
    expect(unknown.posted[NOTES]).toMatch(REROUTE_LINE);
    expect(paused.posted[TEAM]).toEqual([CEO]);
    expect(paused.out.rerouted.from).toEqual([{ id: CFV, name: 'AI Cash Flow Voids' }]);
    // The fields' own Team Member is kept and checked (here moved off the Bookkeeper), and the
    // unused --owner is said.
    expect(twice.posted[TEAM]).toEqual([ANALYST]);
    expect(twice.out.holderCheck).toContain('--owner worker-analyst was not used');
    expect(same.posted[TEAM]).toEqual([ANALYST]);
    expect(same.out.holderCheck).toBeUndefined();
  });
});

describe("5. the inbox skills' exit 3 (\"auto-reply, archive it\") is never an owner problem", () => {
  it('both inbox skills still read exit 3 as an auto-reply to archive or log, so an owner exit 3 would lose mail', () => {
    for (const skill of [EMAIL_SKILL, SMS_SKILL]) {
      const at = skill.indexOf('Exit 3 with\n`"action": "refused"`') >= 0
        ? skill.indexOf('Exit 3 with\n`"action": "refused"`') : skill.indexOf('Exit 3 with');
      expect(at).toBeGreaterThan(-1);
      expect(skill.slice(at, at + 260)).toMatch(/auto-reply/);
      expect(skill.slice(at, at + 260)).toMatch(/nothing was created and nothing is unhandled/);
    }
  });

  it('every owner problem the gate can meet exits 0 with a task created, never 3 and never "refused"', () => {
    const rs = gate([
      { fields: held([BOOKKEEPER]) },
      { fields: held([BOOKKEEPER]), argv: ['--force'] },
      { fields: held([LEAD_FINDER]) },
      { fields: held([CFV]), register: { [CFV]: 'Paused' } },
      { fields: held([PROPERTY]), register: { [PROPERTY]: 'Paused' } },
      { fields: held(['AI Bookkeeper']) },
      { fields: held([BOOKKEEPER]), fail: { team: true } },
      { fields: held([BOOKKEEPER]), fail: { register: true } },
      { fields: held([BOOKKEEPER]), breakImport: true },
      { fields: held([BOOKKEEPER]), stub: 'raise' },
      { fields: held([ANALYST]), stub: 'always' },
      { fields: { ...INVARIANT }, argv: ['--owner', 'bookkeeper'] },
      { fields: { ...INVARIANT }, argv: ['--owner', 'cash-flow-voids'], register: { [CFV]: 'Paused' } },
      { fields: held([BOOKKEEPER]), argv: ['--owner', 'worker-analyst'] },
      { fields: { ...INVARIANT }, argv: ['--owner', 'worker-analyst'], breakImport: true },
    ]);
    rs.forEach((r, i) => {
      expect(r.rc, `case ${i}: ${JSON.stringify(r.out)}`).toBe(0);
      expect(r.out.action, `case ${i}`).toBe('created');
      expect(r.posted, `case ${i}`).not.toBeNull();
    });
  });
});

describe("6. one answer: the gate asks agent-dispatch.py's own no_lane_holders", () => {
  it('replace the dispatcher function and the gate follows it, both ways', () => {
    const [never, always] = gate([
      { fields: held([BOOKKEEPER]), stub: 'never' },
      { fields: held([ANALYST]), stub: 'always' },
    ]);
    expect(never.rc).toBe(0);
    expect(never.posted[TEAM]).toEqual([BOOKKEEPER]);
    expect(never.out.rerouted).toBeUndefined();
    // Every agent reads as unworked, so no working agent can be named: created as given, said.
    expect(always.rc).toBe(0);
    expect(always.posted[TEAM]).toEqual([ANALYST]);
    expect(always.out.holderCheck).toMatch(/^NOT PLACED: AI Worker — Analyst/);
  });

  it('over every live-shaped AI agent row, the gate moves exactly what the dispatcher names, bar own-schedule cards', () => {
    const ids = Object.keys(AI_ROWS);
    const rs = gate(ids.map((i) => ({ fields: held([i]) })));
    const moved = ids.filter((_, k) => rs[k].out.rerouted).sort();
    expect(moved).toEqual([BOOKKEEPER, LEAD_FINDER].sort());
    expect(rs.every((r) => r.rc === 0 && r.out.action === 'created')).toBe(true);
  });

  it('the field ids the gate reads match the dispatcher (a drifted id reads as no owner)', () => {
    const ids = JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location("g", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
d = g._dispatch()
print(json.dumps({"gate": [g.ASSIGNEE_FIELD, g.F["team"], g.F["sentForApprovalBy"], g.F["approvalOutcome"], g.F["notes"]],
                  "dispatch": [d.AF["assignee"], d.AF["teamMember"], d.AF["sentForApprovalBy"], d.AF["approvalOutcome"], d.AF["notes"]]}))
`], { encoding: 'utf8' }));
    expect(ids.gate).toEqual(ids.dispatch);
  });
});

describe("7. agent-dispatch.py's plan_repair_task still gets its task when the card's agent is paused", () => {
  // plan_repair_task raises a YOUR TURN PLAN REFUSED: task for the card's own agent through
  // cmd_create(force=True), and raises RuntimeError unless the answer is "created". A refusal for
  // a paused agent would have made it raise; the reroute design creates it for the AI CEO.
  it('the real plan_repair_task, a paused Property Administration card: created, for the AI CEO, no error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'od-plan-repair-'));
    writeFileSync(join(dir, 'recCARD000000001.json'), '{"steps": []}');
    const r = JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, sys, urllib.request
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location("dd", ${JSON.stringify(DISPATCH)})
dd = importlib.util.module_from_spec(spec); spec.loader.exec_module(dd)
dd.HANDOVER_DIR = dd.STATE_DIR = ${JSON.stringify(dir)}
dd.query_tasks = lambda *a, **k: []
g = dd._gate()
d = g._dispatch()
${FAKE}
state = {"created": None, "gets": []}
g._request = make_req(g, d, {}, dict(REGISTER, **{${JSON.stringify(PROPERTY)}: "Paused"}), state)
g.load_scan_cache = lambda: {}
g.write_track_record = lambda tid, fields: None
t = {"id": "recCARD000000001", "name": "Book the EICR at 23 Viola Street", "agentId": ${JSON.stringify(PROPERTY)}}
res = dd.plan_repair_task(t, "step 6 (kevin) needs say")
print(json.dumps({"res": res, "team": (state["created"] or {}).get(g.F["team"]),
                  "notes": (state["created"] or {}).get(g.F["notes"], "")}))
`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n').pop());
    expect(r.res).toEqual({ task: 'recCARD000000001', repair: 'recNEWTASK0000001', action: 'created' });
    expect(r.team).toEqual([CEO]);
    expect(r.notes).toMatch(REROUTE_LINE);
  });
});
