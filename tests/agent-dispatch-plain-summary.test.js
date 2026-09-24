import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// THE PLAIN SUMMARY (Kevin, 22 Sep 2026). Every card opens with two lines a
// 13-year-old understands: what the task is and what approving does. The
// agent writes them at submit; the real cmd_submit runs here with patch_task
// swapped for a recorder, so the assertions are on the payload Airtable
// would really receive.
function submit({ plainTask, plainApprove, output = 'Some drafted work.', escalate = false, stored = {} }) {
  const script = `
import importlib.util, json, sys, tempfile, os, types
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
captured = {}
def fake_patch(task, fields):
    captured['fields'] = fields
    return {'id': task}
m.patch_task = fake_patch
p = json.loads(sys.argv[1])
def fake_get(task):
    f = {m.AF[k]: v for k, v in p['stored'].items()}
    f.update(captured.get('fields', {}))
    return {'id': task, 'fields': f}
m.get_task = fake_get
fh = tempfile.NamedTemporaryFile('w', suffix='.md', delete=False)
fh.write(p['output'])
fh.close()
args = types.SimpleNamespace(task='recTESTTESTTEST01', agent=sorted(m.AGENTS)[0],
                             type='Drafting', output_file=fh.name, tier1=False,
                             plain_task=p['plainTask'], plain_approve=p['plainApprove'])
out = {'fieldMap': m.AF}
try:
    if p['escalate']:
        m.cmd_escalate(types.SimpleNamespace(task='recTESTTESTTEST01', reason='Keep the lease or end it?'))
    else:
        m.cmd_submit(args)
    out['refused'] = False
except SystemExit as exc:
    out['refused'] = True
    out['error'] = str(exc)
finally:
    os.unlink(fh.name)
out['captured'] = captured
print('---JSON---')
print(json.dumps(out))
`;
  const raw = execFileSync('python3', ['-c', script, JSON.stringify({ plainTask, plainApprove, output, escalate, stored })],
    { encoding: 'utf8', env: { ...process.env, SIGNIN_SKIP_WALK: '1' } });
  return JSON.parse(raw.split('---JSON---')[1]);
}

const TASK = 'A company keeps emailing to say it wants to buy Runpreneur.';
const APPROVE = 'The agent sends one short no-thanks reply and stops answering.';

describe('agent-dispatch submit: the plain summary', () => {
  it('writes both lines into Plain Summary on the card patch', () => {
    const r = submit({ plainTask: TASK, plainApprove: APPROVE });
    expect(r.refused, r.error).toBe(false);
    expect(r.captured.fields[r.fieldMap.plainSummary]).toBe(`TASK: ${TASK}\nIF YOU APPROVE: ${APPROVE}`);
  });

  it.each([
    ['an empty task line', '', APPROVE, 'is empty'],
    ['a record id', 'Close task recAAAAAAAAAAAAA1 as done.', APPROVE, 'machine detail'],
    ['a script name', TASK, 'The agent runs scripts/send-email.py for you.', 'machine detail'],
    ['formatting', '**Reply** to the water company.', APPROVE, 'formatting'],
    ['a report, not a sentence', TASK, 'x'.repeat(201), 'keep it under 200'],
    ['two lines', TASK, 'The agent replies.\nThen it closes the task.', 'one line'],
    ['a bare carriage return', TASK, 'The agent replies.\rThen it closes the task.', 'one line'],
    ['a line too short to explain anything', 'Reply.', APPROVE, 'too short'],
  ])('refuses %s, and writes nothing', (_, t, a, why) => {
    const r = submit({ plainTask: t, plainApprove: a });
    expect(r.refused).toBe(true);
    expect(r.error).toContain(why);
    expect(r.captured.fields).toBeUndefined();
  });

  it('the command line refuses a submit with no plain lines at all', () => {
    const res = spawnSync('python3', [DISPATCH, 'submit', 'recTESTTESTTEST01',
      '--agent', 'recX', '--type', 'Admin', '--output-file', '/dev/null'], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--plain-task/);
    expect(res.stderr).toMatch(/--plain-approve/);
  });

  it('allows an ordinary # in a sentence, such as an invoice number', () => {
    const r = submit({ plainTask: 'Pay invoice #1234 from the electrician for 13 Chedburgh Place.', plainApprove: APPROVE });
    expect(r.refused, r.error).toBe(false);
  });

  it('a report that files itself still carries the new lines, so a reopened task never shows an old round', () => {
    const LONG = 'The invoice was checked against the bank feed line by line. '.repeat(8);
    const r = submit({ plainTask: TASK, plainApprove: 'Nothing happens. This is information only, for your records.',
      output: LONG + '\n\n**Carrying this out will involve:** Nothing. Information only.',
      stored: { plainSummary: 'TASK: an older round\nIF YOU APPROVE: an older proposal' } });
    expect(r.refused, r.error).toBe(false);
    expect(r.captured.fields[r.fieldMap.status]).toBe('Completed');
    expect(r.captured.fields[r.fieldMap.plainSummary]).toContain(TASK);
  });

  it('an escalation clears an earlier summary, because the card is a new question', () => {
    const r = submit({ plainTask: TASK, plainApprove: APPROVE, escalate: true,
      stored: { status: 'This Week', plainSummary: 'TASK: an older round\nIF YOU APPROVE: an older proposal' } });
    expect(r.refused, r.error).toBe(false);
    expect(r.captured.fields[r.fieldMap.status]).toBe('Approval');
    expect(Object.prototype.hasOwnProperty.call(r.captured.fields, r.fieldMap.plainSummary)).toBe(true);
    expect(r.captured.fields[r.fieldMap.plainSummary]).toBeNull();
  });
});

// The Content Engine submits with no AI in the loop, so its lines are fixed
// text. Every pair, in both modes, must pass the same check an agent's does,
// or the nightly run is refused at submit (review finding, 22 Sep 2026).
describe('Content Engine cards carry plain lines that pass the gate', () => {
  it('episode, performance read, post (full and thin) and newsletter, test and live', () => {
    const script = `
import importlib.util, json, sys, os
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts/content-engine'))})
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
import approval, od_lane
src = open(${JSON.stringify(resolve(ROOT, 'scripts/content-engine/performance.py'))}).read()
pairs = []
for mode in ('test', 'live'):
    pairs.append(('episode ' + mode, approval.episode_plain(2054, mode)))
    pairs.append(('post ' + mode, od_lane.post_plain({'date': '2026-09-25', 'day': 'Fri'}, mode)))
    pairs.append(('thin ' + mode, od_lane.post_plain({'date': '2026-09-25', 'day': 'Fri', 'thin': True}, mode)))
    pairs.append(('newsletter ' + mode, od_lane.newsletter_plain({'date': '2026-09-25', 'n': 3}, mode)))
out = []
for name, a in pairs:
    assert a[0] == '--plain-task' and a[2] == '--plain-approve', name
    out.append({'name': name, 'problem': m.plain_summary_problem(a[1], a[3])})
out.append({'name': 'performance passes plain lines', 'problem': '' if 'approval.plain_args(' in src else 'missing'})
print('---JSON---'); print(json.dumps(out))
`;
    const raw = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
    const res = JSON.parse(raw.split('---JSON---')[1]);
    expect(res.length).toBe(9);
    for (const r of res) expect(r.problem, r.name).toBe('');
  });

  it('every Content Engine submit command carries the plain flags', () => {
    const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts/content-engine'))})
import approval
captured = []
class R: returncode = 1; stderr = 'stop'; stdout = ''
def fake_run(cmd, **kw):
    captured.append(cmd); return R()
approval.subprocess.run = fake_run
approval.load_state = lambda: {'2054': {'task': 'recTESTTESTTEST01'}}
approval.bundle = lambda day: {'Long Form Video': {'id': 'recX'}, 'Learnings From My Diary': None, 'Short Form Video': None}
approval.watch.load_ledger = lambda: {}
approval.output_gate = lambda *a: []
approval.build_card = lambda *a: ('name', 'desc', 'out')
approval.headline_for = lambda *a: ''
approval.pans_for = lambda *a: []
try: approval.refresh_card(2054)
except SystemExit: pass
print('---JSON---'); print(json.dumps(captured))
`;
    const raw = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
    const cmds = JSON.parse(raw.split('---JSON---')[1]);
    expect(cmds.length).toBe(1);
    expect(cmds[0]).toContain('--plain-task');
    expect(cmds[0]).toContain('--plain-approve');
  });
});
