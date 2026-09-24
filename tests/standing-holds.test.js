import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Standing holds (Kevin, 24 Sep 2026). A ruling that stays true only until an
// event ("nothing on that council's tax until the officer replies") is written
// once for the whole team. On 23 Sep 2026 the Task Board Manager raised eight
// cards Kevin had already put on hold, because the ruling lived only in the two
// inbox agents' files. These tests drive the REAL scripts: the holds module's
// own selftest (park, lift, expire, orphan, broken hold) and the REAL
// agent-dispatch build_queue against a fake board, so the queue that hands work
// to every agent is proved to keep a held task back.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOLDS = resolve(ROOT, 'scripts/standing_holds.py');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

const HOLD = {
  id: 'sample-council-tax', title: 'Sample council tax hold', status: 'active',
  ruling: 'Nothing on Sampletown council tax until the officer replies.',
  created: '2026-09-23', review_by: '2026-10-23',
  match: {
    name: ['council\\s*tax|standing order|(?-i:\\bSO\\b)'],
    all: ['sampletown|maple|(?-i:\\b\\d+\\s?MP\\b)'],
    none: ['\\bwater\\b'],
  },
  lift: { gmail_query: 'from:council.example Officer', label: "the officer's reply" },
  examples: {
    held: ['Update SO amount - 5 Maple - £129 per month'],
    free: ['Council Tax 18 Other Road enforcement reply'],
  },
};

function holdsFile(holds) {
  const dir = mkdtempSync(join(tmpdir(), 'holds-'));
  const file = join(dir, 'standing-holds.json');
  if (holds) writeFileSync(file, JSON.stringify({ holds }));
  return file;
}

// The real build_queue, offline: the board read and the register read are
// faked, and any other network call fails the test rather than reaching Airtable.
function queue(tasks, file) {
  const script = `
import importlib.util, json, sys, urllib.request
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
agent = next(iter(m.ALL_AGENTS))
AF = m.AF
recs = []
for t in json.loads(${JSON.stringify(JSON.stringify(tasks))}):
    f = {AF["name"]: t["name"], AF["status"]: {"name": "Today"}, AF["teamMember"]: [agent]}
    if t.get("outcome"):
        f[AF["approvalOutcome"]] = {"name": t["outcome"]}
        f[AF["approvedAt"]] = t["approvedAt"]
        f[AF["sentForApprovalBy"]] = [agent]
    recs.append({"id": t["id"], "fields": f})
m.query_tasks = lambda formula, **kw: recs
m.fetch_role_roster = lambda: {}
q = m.build_queue()
lanes = {k: [x["id"] for x in v] for k, v in q.items()
         if isinstance(v, list) and v and isinstance(v[0], dict) and "id" in v[0]}
print(json.dumps({"held": [x["id"] for x in q["heldByStandingHold"]],
                  "holdIds": [x["holdId"] for x in q["heldByStandingHold"]],
                  "count": q["counts"]["heldByStandingHold"],
                  "error": q["standingHoldsError"], "lanes": lanes}))
`;
  const out = execFileSync('python3', ['-c', script], {
    encoding: 'utf8', env: { ...process.env, OD_HOLDS_FILE: file }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

const BOARD = [
  { id: 'recHELD', name: 'Update SO amount - 5 Maple - £129 per month' },
  { id: 'recOTHER', name: 'Council Tax 18 Other Road enforcement reply' },
  // Kevin approved this exact task the day AFTER the hold began: his newer word.
  { id: 'recYES', name: 'Create SO - 3 MP council tax', outcome: 'Approved as-is', approvedAt: '2026-09-24T09:00:00.000Z' },
  // Approved the day the hold began: the hold still stands over it.
  { id: 'recOLD', name: 'Update the council tax SO for 3 MP', outcome: 'Approved as-is', approvedAt: '2026-09-23T12:54:00.000Z' },
];

describe('standing holds — the module', () => {
  it('its selftest passes: park, lift on the reply, expire on the review date, orphan and broken-hold failures', () => {
    const r = spawnSync('python3', [HOLDS, 'selftest'], { encoding: 'utf8' });
    expect(r.stdout).toContain('ALL PASS');
    expect(r.status).toBe(0);
  });

  it('match answers from the file it is pointed at', () => {
    const file = holdsFile([HOLD]);
    const run = (text) => JSON.parse(execFileSync('python3', [HOLDS, 'match', '--text', text],
      { encoding: 'utf8', env: { ...process.env, OD_HOLDS_FILE: file } })).hold;
    expect(run('Update SO amount - 5 Maple')).toBe('sample-council-tax');
    expect(run('Council Tax 18 Other Road')).toBeNull();
    expect(run('Sampletown EICR so we can book')).toBeNull();
  });
});

describe('standing holds — the dispatch queue every agent is fed from', () => {
  it('keeps the held task back and lists it with its hold', () => {
    const q = queue(BOARD, holdsFile([HOLD]));
    expect(q.error).toBe('');
    expect(q.held.sort()).toEqual(['recHELD', 'recOLD']);
    expect(q.holdIds).toEqual(['sample-council-tax', 'sample-council-tax']);
    expect(q.count).toBe(2);
    // Held means in no working lane at all.
    for (const [lane, ids] of Object.entries(q.lanes)) {
      if (lane === 'heldByStandingHold') continue;
      expect(ids, lane).not.toContain('recHELD');
      expect(ids, lane).not.toContain('recOLD');
    }
  });

  it('leaves another council alone, and an approval given after the hold began is carried out', () => {
    const q = queue(BOARD, holdsFile([HOLD]));
    expect(q.held).not.toContain('recOTHER');
    expect(q.held).not.toContain('recYES');
    const working = Object.entries(q.lanes).filter(([k]) => k !== 'heldByStandingHold').flatMap(([, v]) => v);
    expect(working).toContain('recOTHER');
    expect(working).toContain('recYES');
  });

  it('back-test: with no hold on file the same task is worked, so the hold is what kept it back', () => {
    const q = queue(BOARD, holdsFile(null));
    expect(q.held).toEqual([]);
    const working = Object.entries(q.lanes).flatMap(([, v]) => v);
    expect(working).toContain('recHELD');
  });

  it('a lifted hold holds nothing', () => {
    const q = queue(BOARD, holdsFile([{ ...HOLD, status: 'lifted' }]));
    expect(q.held).toEqual([]);
  });

  it('a hold whose own examples fail holds nothing, rather than guessing', () => {
    const broken = JSON.parse(JSON.stringify(HOLD));
    broken.match.all = ['sampeltown'];
    const q = queue(BOARD, holdsFile([broken]));
    expect(q.held).toEqual([]);
  });

  it('an unreadable holds file is reported in the queue, never silent', () => {
    const file = holdsFile(null);
    writeFileSync(file, '{not json');
    const q = queue(BOARD, file);
    expect(q.error).not.toBe('');
    expect(q.held).toEqual([]);
  });
});

describe('standing holds — run before anything reads the board', () => {
  // Order in a shell script cannot be driven offline; this pins it. The
  // behaviour itself is driven above and in the selftest.
  it('the 30-minute poll runs the holds before its queue read', () => {
    const sh = readFileSync(resolve(ROOT, 'scripts/handback-poll-run.sh'), 'utf8');
    const holds = sh.indexOf('scripts/standing_holds.py" run');
    expect(holds).toBeGreaterThan(-1);
    expect(holds).toBeLessThan(sh.indexOf('scripts/agent-dispatch.py" queue'));
  });

  it("the Task Manager's slot runs the holds before its board is read", () => {
    const sh = readFileSync(resolve(ROOT, 'scripts/task-manager-run.sh'), 'utf8');
    const holds = sh.indexOf('scripts/standing_holds.py" run');
    const claude = sh.indexOf('"$CLAUDE" -p');
    expect(claude).toBeGreaterThan(-1);
    expect(holds).toBeGreaterThan(sh.indexOf('task-hygiene-sweep.py" flip-due'));
    expect(holds).toBeLessThan(claude);
  });
});
