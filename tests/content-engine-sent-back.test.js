import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CE = resolve(ROOT, 'scripts/content-engine');

// 27 Sep 2026: day 2072 held every later episode for two days. Kevin sent its
// card back with a question ("can you confirm the folder that contains the raw
// footage"), the engine only knows how to redo edits, and sent-back content
// cards are kept away from the half-hourly agent since it broke YouTube uploads
// on 16 Sep. Nobody owned it. Kevin's ruling: daily-ops works any sent-back card
// with nothing in motion after 24 hours, through two commands, never by hand.
//
// Everything here drives the real functions with the ledger, the approval state
// and every write stubbed: a test must never touch the live ledger.
const J = (x) => `json.loads(${JSON.stringify(JSON.stringify(x))})`;

function py(body) {
  const script = `
import sys, os, io, json, tempfile, contextlib, datetime as dt
sys.path.insert(0, ${JSON.stringify(CE)})
import render, content_report, watch, approval
saved = []
watch.save_ledger = lambda led: saved.append(json.loads(json.dumps(led)))
out, err = io.StringIO(), io.StringIO()
res = None; code = 0
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
    try:
${body.split('\n').map((l) => '        ' + l).join('\n')}
    except SystemExit as e:
        code = 1; err.write(str(e))
print(json.dumps({"res": res, "code": code, "out": out.getvalue(), "err": err.getvalue(), "saved": saved}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

const Q2072 = "Can you confirm the folder that contains the raw footage for this episode so I can check it, because I'm fairly sure there would be a summary video recorded? I just need to locate it. If you can confirm where the raw video was recorded, I can go back and have a look and see if I can find the summary video, so we can get this as a full set.";
const APPROVALS = { 2072: { task: 'recq728Z43rfFR9FM', verdict: 'changes', synced: '2026-09-25T08:16:00', feedback: Q2072 } };
const LEDGER = {
  'VID_20260201_092713_00_014.insv': { day: 2072, episode: 2072, role: 'episode', status: 'rendered', duration: 514.1 },
  'VID_20260201_093632_00_015.insv': { day: 2072, episode: 2072, role: 'episode', status: 'failed', duration: 43.8, error: 'a second long recording', requeued: 'not requeued: it needs a person', lfmd_window: [0, 38.96] },
  'VID_20260201_092348_00_013.insv': { day: 2071, episode: 2071, role: 'teaser', status: 'rendered' },
};
const RECEIPT = [
  "- Can you confirm the folder that contains the raw footage for this episode so I can check it, because I'm fairly sure there would be a summary video recorded? → Runpreneur Drive, Raw Video > 2026 > 26 Jan 26 - 1 Mar 26. You did: VID_20260201_093632_00_015, 44 s.",
  '- I just need to locate it. → Found, so you do not need to look.',
  '- If you can confirm where the raw video was recorded, I can go back and have a look and see if I can find the summary video, so we can get this as a full set. → This card is now the full set.',
].join('\n');

describe('stuck: a sent-back card with nothing in motion is named', () => {
  it('2072 as it stood on the afternoon of 27 Sep: listed, 59 h, both clips with the failed summary', () => {
    const r = py(`res = content_report.stuck_sent_back(now=dt.datetime(2026, 9, 27, 19, 0), approvals=${J(APPROVALS)}, ledger=${J(LEDGER)}, episodes={}, redo_days=set(), receipts=set())`);
    expect(r.res.map((x) => x.day)).toEqual([2072]);
    expect(r.res[0].hoursWaiting).toBe(59);
    expect(r.res[0].clips.map((c) => c.status)).toEqual(['rendered', 'failed']);
  });

  it('under 24 hours it waits (the night may still be working it)', () => {
    const r = py(`res = content_report.stuck_sent_back(now=dt.datetime(2026, 9, 25, 20, 0), approvals=${J(APPROVALS)}, ledger=${J(LEDGER)}, episodes={}, redo_days=set(), receipts=set())`);
    expect(r.res).toEqual([]);
  });

  for (const [what, extra] of [
    ['a receipt waits', 'receipts={2072}'],
    ['the day is on the Learnings rebuild list', 'redo_days={2072}'],
    ['already on YouTube', 'episodes={"2072": {"youtube_link": "https://youtu.be/x"}}'],
  ]) {
    it(`not stuck when ${what}`, () => {
      const kw = { receipts: 'receipts=set()', redo_days: 'redo_days=set()', episodes: 'episodes={}' };
      const key = extra.split('=')[0];
      kw[key] = extra;
      const r = py(`res = content_report.stuck_sent_back(now=dt.datetime(2026, 9, 27, 19, 0), approvals=${J(APPROVALS)}, ledger=${J(LEDGER)}, ${Object.values(kw).join(', ')})`);
      expect(r.res).toEqual([]);
    });
  }

  it('not stuck when a clip of the day waits to render', () => {
    const led = { ...LEDGER, 'VID_20260201_092713_00_014.insv': { ...LEDGER['VID_20260201_092713_00_014.insv'], status: 'new' } };
    const r = py(`res = content_report.stuck_sent_back(now=dt.datetime(2026, 9, 27, 19, 0), approvals=${J(APPROVALS)}, ledger=${J(led)}, episodes={}, redo_days=set(), receipts=set())`);
    expect(r.res).toEqual([]);
  });

  it('a rejected card is his no, not a job', () => {
    const r = py(`res = content_report.stuck_sent_back(now=dt.datetime(2026, 9, 27, 19, 0), approvals=${J({ 2072: { ...APPROVALS[2072], verdict: 'rejected' } })}, ledger=${J(LEDGER)}, episodes={}, redo_days=set(), receipts=set())`);
    expect(r.res).toEqual([]);
  });
});

describe('redo-day: sets the fix in motion the way 2071 and 2072 were', () => {
  const run = (approvals, receipt, ledger = LEDGER, preReceipt = false) => py(`
root = tempfile.mkdtemp(); rp = os.path.join(root, 'in.md'); open(rp, 'w').write(${JSON.stringify(receipt)})
if ${preReceipt ? 'True' : 'False'}: open(os.path.join(root, '2072.md'), 'w').write('x')
res = render.redo_day(2072, rp, "re-render with the 44 s summary", ledger=${J(ledger)}, state=${J(approvals)}, root=root, today=dt.date(2026, 9, 27))
res = {"reset": res, "receipt": open(os.path.join(root, '2072.md')).read()}`);

  it('resets every clip of the day, not the day before, and parks the receipt', () => {
    const r = run(APPROVALS, RECEIPT);
    expect(r.code).toBe(0);
    expect(r.res.reset.sort()).toEqual(['VID_20260201_092713_00_014.insv', 'VID_20260201_093632_00_015.insv']);
    const led = r.saved.at(-1);
    expect(led['VID_20260201_092713_00_014.insv'].status).toBe('new');
    expect(led['VID_20260201_092713_00_014.insv'].reset).toBe('27 Sep 2026: re-render with the 44 s summary');
    expect(led['VID_20260201_092348_00_013.insv'].status).toBe('rendered');
    expect(r.res.receipt).toContain('Found, so you do not need to look.');
  });

  it("a failed clip loses its old verdicts, so the night judges it afresh", () => {
    const f = run(APPROVALS, RECEIPT).saved.at(-1)['VID_20260201_093632_00_015.insv'];
    for (const k of ['error', 'requeued', 'role', 'episode', 'lfmd_window']) expect(f[k]).toBeUndefined();
    expect(f.day).toBe(2072);
  });

  it('refuses a receipt that misses one of his points, and writes nothing', () => {
    const r = run(APPROVALS, RECEIPT.split('\n').slice(0, 2).join('\n'));
    expect(r.code).toBe(1);
    expect(r.err).toContain('answers 2 point(s) but Kevin made 3');
    expect(r.saved).toEqual([]);
  });

  it('refuses a card that is not sent back', () => {
    const r = run({ 2072: { ...APPROVALS[2072], verdict: 'approved' } }, RECEIPT);
    expect(r.code).toBe(1);
    expect(r.err).toContain('not sent back');
    expect(r.saved).toEqual([]);
  });

  it('refuses while a clip of the day is mid-render', () => {
    const led = { ...LEDGER, 'VID_20260201_092713_00_014.insv': { ...LEDGER['VID_20260201_092713_00_014.insv'], status: 'rendering' } };
    const r = run(APPROVALS, RECEIPT, led);
    expect(r.code).toBe(1);
    expect(r.err).toContain('mid-render');
    expect(r.saved).toEqual([]);
  });

  it('refuses when a receipt already waits (the fix is already in motion)', () => {
    const r = run(APPROVALS, RECEIPT, LEDGER, true);
    expect(r.code).toBe(1);
    expect(r.err).toContain('already waits');
    expect(r.saved).toEqual([]);
  });
});

describe('the Learnings rebuild on a day the gate held before any card', () => {
  const body = (cardState) => `
tmp = tempfile.mkdtemp(); clip = os.path.join(tmp, 'c.insv'); open(clip, 'w').write('x')
led = {"c.insv": {"episode": 2073, "role": "episode", "status": "rendered", "local": clip, "date": "2026-02-02", "drive_id": "d"}}
watch.load_ledger = lambda: led
srt = os.path.join(tmp, 's.srt'); open(srt, 'w').write("1\\n00:00:00,000 --> 00:00:05,000\\nSo ultimately, the learnings of my dive today are that\\n\\n2\\n00:00:30,000 --> 00:00:40,000\\nsee you tomorrow\\n")
render.transcribe = lambda c, w: ("text", srt)
render.render_masters = lambda *a, **k: {}
render.title_from_transcript = lambda t: "t"
render.build_outputs = lambda *a, **k: {"lfmd": "l", "lfmd_yt": "y", "lfmd_srt": "s"}
render.publish_to_drive = lambda *a, **k: ("f", {"lfmd": "L", "lfmd_yt": "Y", "lfmd_srt": "S"})
render.find_or_create_record = lambda *a, **k: ("rec1", "found")
watch._airtable = lambda *a, **k: {}
released = []
render.release_hold = lambda d: released.append(d)
approval.load_state = lambda: ${J(cardState)}
def refuse(day, receipt=None): raise SystemExit("episode %d has no card to refresh" % day)
approval.refresh_card = refuse
render.redo_lfmd(2073)
res = {"released": released}`;

  it('no card yet: the clip is built, the day leaves the rebuild list, no error (2073)', () => {
    const r = py(body({ 2073: { qa_blocked: { failures: ['Learnings section: no clip was cut'] } } }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("no card yet; the night's approval run raises it");
    expect(r.res.released).toEqual([2073]);
  });

  it('CONTROL: a day with a card still refreshes it', () => {
    const r = py(body({ 2073: { task: 'recT' } }));
    expect(r.code).toBe(1);
    expect(r.err).toContain('no card to refresh');
  });
});

describe('daily-ops carries the step, in both copies', () => {
  for (const f of ['.claude/scheduled-tasks/daily-ops/SKILL.md', 'docs/daily-ops-routine.md']) {
    it(f, () => {
      const s = readFileSync(resolve(ROOT, f), 'utf8');
      expect(s).toContain('content_report.py stuck');
      expect(s).toContain('render.py redo-day --day');
    });
  }
});
