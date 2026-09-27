// A link is not a reference, and a record has a ceiling (25 Sep 2026). A task
// whose description held the Airtable form link
// https://airtable.com/appnqjDpqDniH3IRl/shrTuDF8s04Kp5XGT made the create
// gate search for APPNQJDPQDNIH3IRL (the base id, in nearly every task and
// email that links to Airtable) and SHRTUDF8S04KP5XGT. The search matched
// hundreds of unrelated tasks and Gmail threads and wrote ~72,000 characters
// into recNm5hLOrVICCooy and recWuiNEW2BL59xbY, a tier-1 line among them.
// These drive the real functions: the token reader, the history command the
// create gate shells out to, and the block it prints.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = join(ROOT, 'scripts', 'agent-dispatch.py');
const CREATE = join(ROOT, 'scripts', 'create-agent-task.py');

function py(body, arg) {
  const script = `
import importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}
`;
  return JSON.parse(execFileSync('python3', ['-c', script, JSON.stringify(arg || {})], { encoding: 'utf8' }).split('---JSON---')[1]);
}

const FORM_URL = 'https://airtable.com/appnqjDpqDniH3IRl/shrTuDF8s04Kp5XGT';
const DESC = `Rooms at 6 Chedburgh Place. Applicants apply here: ${FORM_URL} . `
  + 'Call 07700900747 or 447700900123. Policy AB12345. '
  + 'Also see airtable.com/appnqjDpqDniH3IRl/tblqB8b22hKBL4PF1 and the old task recNm5hLOrVICCooy.';

describe('a link is an address, never a reference', () => {
  it('an Airtable form URL in a description gives no token from the URL', () => {
    const out = py(`
print('---JSON---'); print(json.dumps(m.reference_tokens(json.loads(sys.argv[1]))))`, DESC);
    for (const t of out) {
      expect(FORM_URL.toUpperCase()).not.toContain(t);
    }
    expect(out).not.toContain('APPNQJDPQDNIH3IRL');
    expect(out).not.toContain('SHRTUDF8S04KP5XGT');
    // A scheme-less link and a bare record id are dropped too.
    expect(out).not.toContain('TBLQB8B22HKBL4PF1');
    expect(out).not.toContain('RECNM5HLORVICCOOY');
    // Phones stay (on the SMS lane they are the only thing naming the
    // contact) and so does a real reference.
    expect(out).toEqual(['07700900747', '447700900123', 'AB12345']);
  });

  it('a Gmail link and a link wrapped across lines give nothing; references written with a dot survive', () => {
    const text = 'Thread https://mail.google.com/mail/u/0/#all/18f3a2b4c5d6e7f8 and the form '
      + 'https://airtable.com/appnqjDpq\nDniH3IRl/shrTuDF8s04Kp5XGT again. '
      + 'Receipt RECEIPT1234567890, account Acc.No/12345678.';
    const out = py(`
print('---JSON---'); print(json.dumps(m.reference_tokens(json.loads(sys.argv[1]))))`, text);
    // 18F3A2B4C5D6E7F8 is the Gmail message id; DNIH3IRL is the tail of the
    // base id left on the second line of the wrapped link.
    expect(out).toEqual(['RECEIPT1234567890', '12345678']);
  });

  it('a form link wrapped inside its share id gives nothing, and a wrap that is not an id keeps the next word', () => {
    const out = py(`
texts = json.loads(sys.argv[1])
print('---JSON---'); print(json.dumps([m.reference_tokens(t) for t in texts]))`, [
      'Apply here: https://airtable.com/appnqjDpqDniH3IRl/shrTuDF8s\n04Kp5XGT today.',
      'Apply here: https://airtable.com/app\nnqjDpqDniH3IRl/shrTuDF8s04Kp5XGT today.',
      // A link that ends in a word which merely starts like an id: the next
      // line is not its tail, so the reference on it survives.
      'Portal https://example.com/apply\nAB12345 is the claim.',
      'Portal https://example.com/app\nAB12345 is the claim.',
      // Lengths that add to 14 on a link that is not Airtable's (review).
      'Receipts at https://portal.example.com/receipts\nINV123456 is the one.',
    ]);
    expect(out).toEqual([[], [], ['AB12345'], ['AB12345'], ['INV123456']]);
  });

  it('a pasted TRACK RECORD header gives no refs, so an id it printed in capitals is never searched again', () => {
    const text = 'Follow-up.\nTRACK RECORD: (searched tasks + Gmail for email a@b.com, ref RECNM5HLORVICCOOY, ref TBLQB8B22HKBL4PF1)\n'
      + '- 03 Jul 2026 — task: task opened: Arrears AB12345 (Today)\nPolicy CD67890.';
    const out = py(`
texts = json.loads(sys.argv[1])
print('---JSON---'); print(json.dumps([m.reference_tokens(t) for t in texts]))`, [
      text,
      '[24 Sep 2026 — create-agent-task] TRACK RECORD: (searched tasks for ref RECNM5HLORVICCOOY)\nPolicy CD67890.',
      // Only a line that starts with the header is one: prose that quotes
      // the words mid-line keeps the reference after it (review).
      'Note TRACK RECORD: none found (searched tasks for ref AB12345) then Policy CD67890',
    ]);
    expect(out).toEqual([['AB12345', 'CD67890'], ['CD67890'], ['AB12345', 'CD67890']]);
  });

  it('the history command the create gate shells out to searches none of the URL parts', () => {
    const out = py(`
seen = {}
def spy(emails=(), refs=(), properties=(), **k):
    seen['terms'] = m.history_terms(emails, refs, properties)
    return {'terms': [], 'searched': ['tasks'], 'entries': [], 'notes': []}
m.history = spy
import io, contextlib
args = types.SimpleNamespace(from_text=[json.loads(sys.argv[1])], ref=['recWuiNEW2BL59xbY'], email=[], property=[],
                             days=730, task=None, no_gmail=True, text=True)
with contextlib.redirect_stdout(io.StringIO()):
    m.cmd_history(args)
print('---JSON---'); print(json.dumps(seen['terms']))`, DESC);
    const refs = out.filter(([k]) => k === 'ref').map(([, v]) => v.toUpperCase());
    expect(refs).toEqual(['07700900747', '447700900123', 'AB12345']);
    // An Airtable id passed straight in with --ref is refused as well.
    expect(refs).not.toContain('RECWUINEW2BL59XBY');
  });

  it('the create gate passes the description to the history command as text to read', () => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location('c', ${JSON.stringify(CREATE)})
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
seen = {}
def spy(cmd):
    seen['cmd'] = cmd
    return types.SimpleNamespace(returncode=0, stdout='TRACK RECORD: none found (searched tasks)', stderr='')
c.track_record_for({c.F['name']: 'TENANT LEADS: rooms', c.F['desc']: json.loads(sys.argv[1])}, 'recX', runner=spy)
print(json.dumps(seen['cmd']))`, JSON.stringify(DESC)], { encoding: 'utf8' });
    const cmd = JSON.parse(out);
    const text = cmd[cmd.indexOf('--from-text') + 1];
    expect(text).toContain(FORM_URL);
    expect(cmd).not.toContain('--ref');
  });
});

describe('the TRACK RECORD block has a ceiling', () => {
  it('500 matches print the newest 40 lines and the header says so', () => {
    const out = py(`
from datetime import date, timedelta
entries = [{'date': (date(2025, 1, 1) + timedelta(days=i)).isoformat(), 'source': 'task',
            'text': 'task opened: unrelated %d' % i, 'link': 'https://airtable.com/appnqjDpqDniH3IRl/tblqB8b22hKBL4PF1/rec%014d' % i}
           for i in range(500)]
entries.sort(key=lambda e: e['date'])
r = {'terms': ['ref APPNQJDPQDNIH3IRL'], 'searched': ['tasks', 'Gmail'], 'entries': entries, 'notes': ['Gmail listing truncated (more than shown)']}
small = dict(r, entries=entries[:3], notes=[])
print('---JSON---'); print(json.dumps({'big': m.history_text(r), 'small': m.history_text(small), 'gate': m.track_record_problem(m.history_text(r), True)}))`);
    const lines = out.big.split('\n');
    expect(lines).toHaveLength(41);
    expect(lines[0]).toBe('TRACK RECORD: (searched tasks + Gmail for ref APPNQJDPQDNIH3IRL; '
      + 'Gmail listing truncated (more than shown); showing the newest 40 of 500 lines)');
    // The newest entry is last, the oldest kept one is entry 460.
    expect(lines[40]).toContain('unrelated 499');
    expect(lines[1]).toContain('unrelated 460');
    expect(out.big.length).toBeLessThan(10000);
    // The card still reads the header, and the submit gate still passes it.
    expect(/^TRACK RECORD:\s*\(searched (.+?)\)\s*$/.test(lines[0])).toBe(true);
    expect(out.gate).toBe('');
    // Under the ceiling nothing changes.
    expect(out.small.split('\n')).toHaveLength(4);
    expect(out.small).not.toContain('showing the newest');
  });

  it('a capped block written twice by the create gate still leaves exactly one block', () => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
spec = importlib.util.spec_from_file_location('c', ${JSON.stringify(CREATE)})
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
entries = [{'date': '2026-09-%02d' % (1 + i % 25), 'source': 'task', 'text': 'line %d' % i} for i in range(90)]
entries.sort(key=lambda e: e['date'])
block = m.history_text({'terms': ['ref X12345'], 'searched': ['tasks'], 'entries': entries, 'notes': []})
once = c.merge_track_record('[20 Sep 2026 — agent] kept note', block, '24 Sep 2026')
twice = c.merge_track_record(once, block, '25 Sep 2026')
print(json.dumps({'once': once, 'twice': twice}))`], { encoding: 'utf8' });
    const r = JSON.parse(out);
    expect(r.twice.match(/TRACK RECORD:/g)).toHaveLength(1);
    expect(r.twice).toContain('kept note');
    expect(r.twice.length).toBe(r.once.length);
  });
});
