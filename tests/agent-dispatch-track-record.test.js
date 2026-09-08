// The dated trail and the track record (Kevin, 8 Sep 2026). Three complaints
// from one morning on the approval gate: a card came back "done" still
// wearing last week's attachment; a payment-plan draft followed a
// restraint-order letter nobody could see had gone; and agents replied
// without knowing what had already passed with the contact. These pin the
// stamps, the two submit gates, the history command's shape, and that the
// TRACK RECORD never reaches an email.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = join(ROOT, 'scripts', 'agent-dispatch.py');

function py(body, arg) {
  const script = `
import importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}
`;
  return JSON.parse(execFileSync('python3', ['-c', script, JSON.stringify(arg || {})], { encoding: 'utf8' }).split('---JSON---')[1]);
}

const NOTES = [
  '[03 Sep 2026 10:12 — agent] ATTACHED: loa.pdf — signed LOA',
  '[03 Sep 2026 10:13 — agent-dispatch] SUBMITTED (round 1) as Correspondence with loa.pdf',
  '[05 Sep 2026 09:00 — send-letter] SENT: letter 123 posted via Pingen to HMRC',
  '[07 Sep 2026 — agent] Sign-in pickup run: session expired',
  '[08 Sep 2026 08:34 — agent] ATTACHED: cover.pdf — cover letter',
].join('\n\n');

describe('the stamps that make the trail', () => {
  it('reads every stamp shape, with or without a time, and knows which files came this round', () => {
    const out = py(`
notes = json.loads(sys.argv[1])
print('---JSON---'); print(json.dumps({
  'stamps': [[x.group('day'), x.group('time'), x.group('who')] for x in m.NOTE_STAMP_RE.finditer(notes)],
  'round': m.submitted_round(notes),
  'thisRound': sorted(m.files_this_round(notes)),
}))`, NOTES);
    expect(out.stamps).toEqual([
      ['03 Sep 2026', '10:12', 'agent'], ['03 Sep 2026', '10:13', 'agent-dispatch'],
      ['05 Sep 2026', '09:00', 'send-letter'], ['07 Sep 2026', null, 'agent'], ['08 Sep 2026', '08:34', 'agent'],
    ]);
    expect(out.round).toBe(2);
    // loa.pdf came with round 1; only cover.pdf is this round's file.
    expect(out.thisRound).toEqual(['cover.pdf']);
  });
});

describe('the file gate: the document the action uses is on the card, from this round', () => {
  it('an ATTACH header must be matched by the same file attached in this submit', () => {
    const out = py(`
notes = json.loads(sys.argv[1])
out = 'Letter ready.\\nTO: a@b.com\\nFROM: kevinbrittain@gmail.com\\nSUBJECT: x\\nATTACH: /tmp/x/loa.pdf\\n---\\nDear A\\n\\n**Carrying this out will involve:** sending this email with the LOA attached.'
print('---JSON---'); print(json.dumps([
  bool(m.document_action_problem(out, 'Correspondence', notes, set())),          # loa.pdf is from round 1: refused
  bool(m.document_action_problem(out, 'Correspondence', notes, {'loa.pdf'})),    # attached again now: fine
  bool(m.document_action_problem(out, 'Correspondence', notes, {'other.pdf'})),  # a different file: refused
]))`, NOTES);
    expect(out).toEqual([true, false, true]);
  });
  it('a carry-out line that promises something attached needs a file this round; other lines do not', () => {
    const out = py(`
notes = json.loads(sys.argv[1])
promise = 'Report.\\n\\n**Carrying this out will involve:** posting the letter with the signed LOA attached.'
plain = 'Report.\\n\\n**Carrying this out will involve:** Kevin reads the findings and decides.'
mention = 'The sender\\'s attachment is a council tax bill.\\n\\n**Carrying this out will involve:** closing this task.'
print('---JSON---'); print(json.dumps([
  bool(m.document_action_problem(promise, 'Admin', '', set())),
  bool(m.document_action_problem(promise, 'Admin', notes, set())),   # cover.pdf is this round's file
  bool(m.document_action_problem(plain, 'Admin', '', set())),
  bool(m.document_action_problem(mention, 'Admin', '', set())),      # the word in the body, not the promise
]))`, NOTES);
    expect(out).toEqual([true, false, false, false]);
  });
});

describe('the track record gate', () => {
  it('requires a dated block, accepts the empty form, and is off where not required', () => {
    const out = py(`
dated = 'TRACK RECORD: (searched tasks + Gmail for email a@b.com)\\n- 03 Jul 2026 09:06 — email: Kevin: Re: arrears\\n\\nDraft...'
none = 'TRACK RECORD: none found (searched tasks + Gmail for email a@b.com)\\n\\nDraft...'
undated = 'TRACK RECORD: (searched tasks)\\n- something happened once\\n\\nDraft...'
print('---JSON---'); print(json.dumps([
  m.track_record_problem(dated, True) == '',
  m.track_record_problem(none, True) == '',
  bool(m.track_record_problem(undated, True)),
  bool(m.track_record_problem('no block at all', True)),
  m.track_record_problem('no block at all', False) == '',
]))`);
    expect(out).toEqual([true, true, true, true, true]);
  });
  it('the refusal says how to build the record', () => {
    const out = py(`
print('---JSON---'); print(json.dumps(m.track_record_problem('Draft only.', True)))`);
    expect(out).toMatch(/agent-dispatch\.py history/);
    expect(out).toMatch(/none found \(searched/);
  });
  it('a submit of a creditor item without the record is refused, and with it passes', () => {
    const out = py(`
captured = {}
m.patch_task = lambda t, f: captured.setdefault('fields', f)
m.get_task = lambda t: {'id': t, 'fields': dict(captured.get('fields', {}))}
m.supersede_attachments = lambda *a, **k: []
m.upload_attachment = lambda *a, **k: 'x'
m.load_login_sites = lambda: {}
import tempfile, os
agent = next(k for k, v in m.ALL_AGENTS.items() if v.get('agent') == 'creditor-management')
import io, contextlib
def run(text):
    fh = tempfile.NamedTemporaryFile('w', suffix='.md', delete=False); fh.write(text); fh.close()
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            m.cmd_submit(types.SimpleNamespace(task='recT1', agent=agent, type='Research', output_file=fh.name, tier1=False))
        return False
    except SystemExit as e:
        return str(e)
    finally:
        os.unlink(fh.name)
body = 'Checked the creditor plans. ' * 12
carry = '\\n\\n**Carrying this out will involve:** updating the Creditor Plans row to Awaiting response.'
print('---JSON---'); print(json.dumps({
  'without': run(body + carry),
  'with': run('TRACK RECORD: none found (searched tasks + Gmail for email orbit@example.com)\\n\\n' + body + carry),
}))`);
    expect(out.without).toMatch(/carries no TRACK RECORD/);
    expect(out.with).toBe(false);
  });
});

describe('history: the record itself', () => {
  it('builds one search formula per term over the six text fields, on the real field names', () => {
    const out = py(`
f = m.history_formula(m.history_terms(emails=['A@B.com'], refs=['12345'], properties=['6 Chedburgh Place']))
print('---JSON---'); print(json.dumps(f))`);
    expect(out).toContain("FIND('a@b.com', LOWER({Task Name}&''))");
    expect(out).toContain("LOWER({Inbound Sender}&'')");
    expect(out).toContain("FIND('12345'");
    expect(out).toContain("FIND('6 chedburgh place'");
    expect(out).not.toContain('{Name}');
  });
  it('turns one task into dated events: opened, every stamp, Kevin\'s feedback, completion; the current task is left out', () => {
    const out = py(`
rec = {'id': 'recX', 'createdTime': '2026-06-25T09:00:00.000Z', 'fields': {
  m.AF['name']: 'INBOUND: Outstanding Arrears', m.AF['status']: {'name': 'Completed'},
  m.AF['completion']: '2026-07-03', m.AF['notes']: json.loads(sys.argv[1]),
  m.AF['feedbackHistory']: '[2026-09-04 11:02] Too soft, ask for a freeze',
  m.AF['agentOutput']: 'Draft\\n\\n**Carrying this out will involve:** sending the freeze request.'}}
ev = m.history_entries_from_task(rec)
print('---JSON---'); print(json.dumps({'ev': [[e['date'], e['source'], e['text'][:40].rstrip()] for e in ev], 'excluded': m.history_entries_from_task(rec, exclude_id='recX')}))`, NOTES);
    expect(out.excluded).toEqual([]);
    expect(out.ev[0]).toEqual(['2026-06-25', 'task', 'task opened: INBOUND: Outstanding Arrear']);
    expect(out.ev).toContainEqual(['2026-09-05 09:00', 'send-letter', 'SENT: letter 123 posted via Pingen to HM']);
    expect(out.ev).toContainEqual(['2026-09-04 11:02', 'Kevin', 'Too soft, ask for a freeze']);
    expect(out.ev).toContainEqual(['2026-07-03', 'task', 'completed: INBOUND: Outstanding Arrears']);
  });
  it('prints the block oldest first, and the empty form names what was searched', () => {
    const out = py(`
r = {'terms': ['email a@b.com'], 'searched': ['tasks', 'Gmail'], 'notes': [], 'entries': [
  {'date': '2026-09-05 09:00', 'source': 'send-letter', 'text': 'SENT: letter'},
  {'date': '2026-07-03', 'source': 'task', 'text': 'completed: X'}]}
r['entries'].sort(key=lambda e: e['date'])
print('---JSON---'); print(json.dumps([m.history_text(r), m.history_text({'terms': ['ref 12345'], 'searched': ['tasks'], 'entries': [], 'notes': ['Gmail not searched (no key)']})]))`);
    expect(out[0].split('\n')).toEqual([
      'TRACK RECORD: (searched tasks + Gmail for email a@b.com)',
      '- 03 Jul 2026 — task: completed: X',
      '- 05 Sep 2026 09:00 — send-letter: SENT: letter',
    ]);
    expect(out[1]).toBe('TRACK RECORD: none found (searched tasks for ref 12345; Gmail not searched (no key))');
  });
  it('the printed block passes the gate it was built for', () => {
    const out = py(`
r = {'terms': ['email a@b.com'], 'searched': ['tasks'], 'notes': [], 'entries': [{'date': '2026-07-03', 'source': 'task', 'text': 'completed: X'}]}
print('---JSON---'); print(json.dumps([m.track_record_problem(m.history_text(r), True), m.track_record_problem(m.history_text({'terms': [], 'searched': ['tasks'], 'entries': [], 'notes': []}), True)]))`);
    expect(out).toEqual(['', '']);
  });
});

describe('the record never reaches the recipient', () => {
  it('parse_output strips a TRACK RECORD block above the headers and one after the body', () => {
    const out = execFileSync('python3', ['-c', `
import sys, json; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})
import agent_email_format as f
above = 'TRACK RECORD: (searched tasks)\\n- 03 Jul 2026 — email: Kevin: Re: arrears\\n\\nTO: a@b.com\\nSUBJECT: Hi\\n---\\nDear A,\\n\\nBody.\\n\\n**Carrying this out will involve:** sending this email.'
below = 'TO: a@b.com\\nSUBJECT: Hi\\n---\\nDear A,\\n\\nBody.\\n\\nTRACK RECORD: none found (searched tasks)\\n\\n**Carrying this out will involve:** sending this email.'
print(json.dumps([f.parse_output(above)['body'], f.parse_output(below)['body']]))`], { encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual(['Dear A,\n\nBody.', 'Dear A,\n\nBody.']);
  });
});

describe('the writers of the trail', () => {
  it('both send paths stamp SENT on the task, and the create gate writes the record at creation and on a fold', () => {
    const email = readFileSync(join(ROOT, 'scripts', 'send-email.py'), 'utf8');
    const letter = readFileSync(join(ROOT, 'scripts', 'send-letter.py'), 'utf8');
    const create = readFileSync(join(ROOT, 'scripts', 'create-agent-task.py'), 'utf8');
    expect(email).toMatch(/— send-email\] SENT: email to/);
    expect(letter).toMatch(/— send-letter\] SENT: letter/);
    expect((create.match(/^\s+write_track_record\(task_id, fields\)$/gm) || []).length).toBe(2);
    expect(create).toMatch(/TRACK RECORD: not built/);
  });
  it('the create gate turns a history failure into a visible line, never silence', () => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location('c', ${JSON.stringify(join(ROOT, 'scripts', 'create-agent-task.py'))})
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
fields = {c.F['name']: 'INBOUND: HMRC ref 1234567890', c.F['desc']: 'x', c.F['inboundSender']: 'hmrc@example.com'}
ok = c.track_record_for(fields, 'recX', runner=lambda cmd: types.SimpleNamespace(returncode=0, stdout='TRACK RECORD: none found (searched tasks)\\n', stderr='', cmd=cmd))
bad = c.track_record_for(fields, 'recX', runner=lambda cmd: types.SimpleNamespace(returncode=1, stdout='', stderr='boom\\nAirtable 422'))
seen = {}
def spy(cmd):
    seen['cmd'] = cmd
    return types.SimpleNamespace(returncode=0, stdout='TRACK RECORD: none found (searched tasks)', stderr='')
c.track_record_for(fields, 'recX', runner=spy)
print(json.dumps({'ok': ok, 'bad': bad, 'cmd': seen['cmd']}))`], { encoding: 'utf8' });
    const r = JSON.parse(out);
    expect(r.ok).toBe('TRACK RECORD: none found (searched tasks)');
    expect(r.bad).toBe('TRACK RECORD: not built (Airtable 422)');
    expect(r.cmd).toContain('--email');
    expect(r.cmd).toContain('hmrc@example.com');
    expect(r.cmd).toContain('--task');
    expect(r.cmd).toContain('--from-text');
  });
});

// The review of 8 Sep 2026 found nine gaps in the first cut; each one is pinned here.
describe('review findings, pinned', () => {
  it('a mention of the sender\'s attachment, or "no attachment", is not a promise (3)', () => {
    const out = py(`
lines = [
  "sending this reply; no attachment is needed.",
  "replying about the attachment they sent.",
  "the enclosed cheque was banked yesterday.",
  "posting the letter with the signed LOA attached.",
  "attaching the statement and sending it to the council.",
  "sending the enclosed form to HMRC.",
]
print('---JSON---'); print(json.dumps([bool(m.document_action_problem('x\\n\\n**Carrying this out will involve:** ' + l, 'Admin', '', set())) for l in lines]))`);
    expect(out).toEqual([false, false, false, true, true, true]);
  });
  it('the submit stamp names a file put on with a separate attach before the submit (4)', () => {
    const out = py(`
captured = {}
m.patch_task = lambda t, f: captured.setdefault('fields', f)
notes = '[08 Sep 2026 08:00 — agent] ATTACHED: loa.pdf — signed LOA'
m.get_task = lambda t: {'id': t, 'fields': {m.AF['notes']: notes, **dict(captured.get('fields', {}))}}
m.supersede_attachments = lambda *a, **k: []
m.upload_attachment = lambda *a, **k: 'x'
m.load_login_sites = lambda: {}
import tempfile, os, io, contextlib
fh = tempfile.NamedTemporaryFile('w', suffix='.md', delete=False)
fh.write('TRACK RECORD: none found (searched tasks)\\n\\nTO: a@b.com\\nFROM: kevinbrittain@gmail.com\\nSUBJECT: x\\nATTACH: /tmp/x/loa.pdf\\n---\\nDear A\\n\\n**Carrying this out will involve:** sending this email with the LOA attached.')
fh.close()
agent = sorted(m.AGENTS)[0]
with contextlib.redirect_stdout(io.StringIO()):
    m.cmd_submit(types.SimpleNamespace(task='recT1', agent=agent, type='Correspondence', output_file=fh.name, tier1=False))
os.unlink(fh.name)
print('---JSON---'); print(json.dumps(captured['fields'].get(m.AF['notes'], '')))`);
    expect(out).toMatch(/SUBMITTED \(round 1\) as Correspondence with loa\.pdf/);
  });
  it('Kevin\'s own addresses, ISO dates and repeats never become search terms (5, 6)', () => {
    const out = py(`
print('---JSON---'); print(json.dumps({
  'terms': m.history_terms(emails=['kevinbrittain@gmail.com', 'Karlo@Example.com', 'karlo@example.com'], refs=['2026-07-29', '12345', '12345']),
  'tokens': m.reference_tokens('Ref 447538631747 dated 2026-07-29, again 447538631747, policy AB12345, ' + ' '.join(str(100000 + i) for i in range(20))),
}))`);
    expect(out.terms).toEqual([['email', 'karlo@example.com'], ['ref', '12345']]);
    expect(out.tokens.slice(0, 2)).toEqual(['447538631747', 'AB12345']);
    expect(out.tokens).not.toContain('2026-07-29');
    expect(out.tokens.length).toBeLessThanOrEqual(8);
  });
  it('the email format strips only dated record lines: body bullets and the separator survive (2)', () => {
    const out = execFileSync('python3', ['-c', `
import sys, json; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})
import agent_email_format as f
between = 'TO: a@b.com\\nSUBJECT: Hi\\nTRACK RECORD: none found (searched tasks)\\n---\\nDear A,\\n\\n- please pay by Friday\\n- or call us\\n\\nRegards\\n\\n**Carrying this out will involve:** sending this email.'
body = 'TRACK RECORD: (searched tasks)\\n- 03 Jul 2026 — email: earlier reply\\n\\nTO: a@b.com\\nSUBJECT: Hi\\n---\\nDear A,\\n\\n- please pay by Friday\\n\\nRegards\\n\\n**Carrying this out will involve:** sending this email.'
print(json.dumps([f.parse_output(between)['body'], f.parse_output(body)['body']]))`], { encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual(['Dear A,\n\n- please pay by Friday\n- or call us\n\nRegards', 'Dear A,\n\n- please pay by Friday\n\nRegards']);
  });
  it('the create gate replaces its previous block and cuts the cap on a line (9)', () => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location('c', ${JSON.stringify(join(ROOT, 'scripts', 'create-agent-task.py'))})
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
notes = '[01 Sep 2026 10:00 — agent] ATTACHED: a.pdf — x\\n\\n[02 Sep 2026 — create-agent-task] TRACK RECORD: (searched tasks)\\n- 01 Jul 2026 — task: old line\\n\\n[03 Sep 2026 10:00 — agent-dispatch] SUBMITTED (round 1) as Admin with a.pdf'
merged = c.merge_track_record(notes, 'TRACK RECORD: (searched tasks)\\n- 05 Sep 2026 — task: new line', '08 Sep 2026')
big = c.merge_track_record('x' * 89990 + '\\n[01 Sep 2026 — agent] keep me', 'TRACK RECORD: none found (searched tasks)', '08 Sep 2026')
print(json.dumps({'merged': merged, 'bigStartsClean': big.startswith('['), 'bigLen': len(big)}))`], { encoding: 'utf8' });
    const r = JSON.parse(out);
    expect(r.merged.match(/TRACK RECORD:/g)).toHaveLength(1);
    expect(r.merged).toContain('new line');
    expect(r.merged).not.toContain('old line');
    expect(r.merged).toContain('SUBMITTED (round 1)');
    expect(r.bigStartsClean).toBe(true);
    expect(r.bigLen).toBeLessThanOrEqual(90000);
  });
  it('a failed Gmail lane leaves no JSON in the record and names the reason (1)', () => {
    const out = py(`
import os
os.environ['HOME'] = '/nonexistent-home'
entries, note = m.history_gmail([('email', 'a@b.com')], 30)
print('---JSON---'); print(json.dumps({'entries': entries, 'note': note}))`);
    expect(out.entries).toEqual([]);
    expect(out.note).toMatch(/Gmail not searched \(cannot read/);
  });
  it('the send scripts survive any error after the send and the file link never interpolates the name (7, 8)', () => {
    const email = readFileSync(join(ROOT, 'scripts', 'send-email.py'), 'utf8');
    const letter = readFileSync(join(ROOT, 'scripts', 'send-letter.py'), 'utf8');
    const html = readFileSync(join(ROOT, 'os', 'agents', 'index.html'), 'utf8');
    expect(email).toMatch(/except \(SystemExit, Exception\) as e:[^\n]*\n\s+print\(f"WARNING: sent/);
    expect(letter).toMatch(/except \(SystemExit, Exception\) as e:[^\n]*\n\s+print\(f"WARNING: posted/);
    expect(html).toContain("apvOpenAttachment(event,'${t.id}',this.dataset.apvFile)");
    expect(html).not.toContain("apvOpenAttachment(event,'${t.id}','${esc(f.filename)}')");
  });
});
