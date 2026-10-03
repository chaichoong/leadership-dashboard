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

// A command is not a reference (28 Sep 2026). A task whose description said
// "Run: python3 ~/.claude/skills/model-check/calibrate.py 14" made the create
// gate search for PYTHON3; 682 lines of unrelated history matched and the
// newest 40, 12,454 characters, landed in the task's Notes.
const CALIBRATE = 'Recalibrate the Fable/Opus model check after the week to 4 Oct '
  + 'Kevin approved on 28 Sep 2026: check the new allowance-aware MODEL CHECK after its first full week.\n\n'
  + '1. Run: python3 ~/.claude/skills/model-check/calibrate.py 14 (read-only).\n'
  + '2. Report dollars per point for Opus and for Fable against the 90% target.';

describe('a command or code word is never a reference', () => {
  it('the calibrate task gives no token, so the create gate searches nothing', () => {
    const out = py(`
print('---JSON---'); print(json.dumps(m.reference_tokens(json.loads(sys.argv[1]))))`, CALIBRATE);
    expect(out).toEqual([]);
  });

  it('tool, encoding, hash, architecture, version and model words give nothing', () => {
    // Each of these was a token before the fix.
    const words = ['python3', 'Python3.12', 'sha256', 'SHA3-256', 'base64', 'x86-64', 'HTML5', 'OAuth2',
      'int64', 'arm64', 'win10', 'node20', 'iOS18', 'windows11', 'Insta360', 'WordSection1', 'v=DMARC1',
      'utf16le', 'cp1252', 'claude-haiku-4-5-20251001'];
    // These never reach the rule (under five characters, or letters then a
    // hyphen), and must stay that way.
    const short = ['UTF-8', 'utf-16', 'SHA-256', 'H264', 'MPEG-4', 'MP4'];
    const out = py(`
print('---JSON---'); print(json.dumps({w: m.reference_tokens(w) for w in json.loads(sys.argv[1])}))`, [...words, ...short]);
    for (const w of [...words, ...short]) expect([w, out[w]]).toEqual([w, []]);
  });

  it('a code of letters then one digit stays when a label names it a reference', () => {
    const out = py(`
texts = json.loads(sys.argv[1])
print('---JSON---'); print(json.dumps([m.reference_tokens(t) for t in texts]))`, [
      'PNR XKQJT4, booking ref ABCDE1, confirmation code: QWERT7, Invoice No. ABCDE2, Order #ABCDE3.',
      'Booking reference:\r\nXKQJT4',
      'The ABCDE1 arrived; run python3 again.',
      // An everyday word is not a label, and no label rescues a named code word.
      'Just in case python3 is missing. Run in order: python3 a.py. Close the account\npython3 fix.py',
      'Ref SHA256 of the file, booking ref base64 string, case HTML5.',
      'Ref: python3 then ref html5. Quote our ref.\n\nABCDE1 is in the next paragraph.',
    ]);
    expect(out).toEqual([['XKQJT4', 'ABCDE1', 'QWERT7', 'ABCDE2', 'ABCDE3'], ['XKQJT4'], [], [], [], []]);
  });

  it('real references still come through: invoices, case numbers, claim refs, phones, accounts', () => {
    const text = 'Invoice INV123456 and HMRC case CFS1234567. DWP ref UCD123, our ref PUD45/5, policy AB12345. '
      + 'Call 07700900747 or 447700900123. Account 12345678, sort code 12-34-56. Codes INT123 and X1234567.';
    const out = py(`
print('---JSON---'); print(json.dumps(m.reference_tokens(json.loads(sys.argv[1]))))`, text);
    expect(out).toEqual(['INV123456', 'CFS1234567', 'UCD123', 'PUD45', 'AB12345', '07700900747',
      '447700900123', '12345678']);
    // Past the eight-ref cap, so read on their own.
    const rest = py(`
print('---JSON---'); print(json.dumps(m.reference_tokens(json.loads(sys.argv[1]))))`, 'sort code 12-34-56. Codes INT123 and X1234567.');
    expect(rest).toEqual(['12-34-56', 'INT123', 'X1234567']);
  });

  it('the history command the create gate shells out to gets no ref from the calibrate task', () => {
    const out = py(`
seen = {}
def spy(emails=(), refs=(), properties=(), **k):
    seen['terms'] = m.history_terms(emails, refs, properties)
    return {'terms': [], 'searched': ['tasks'], 'entries': [], 'notes': []}
m.history = spy
import io, contextlib
args = types.SimpleNamespace(from_text=[json.loads(sys.argv[1])], ref=[], email=[], property=[],
                             days=730, task=None, no_gmail=True, text=True)
with contextlib.redirect_stdout(io.StringIO()):
    m.cmd_history(args)
print('---JSON---'); print(json.dumps(seen['terms']))`, CALIBRATE);
    expect(out).toEqual([]);
  });
});

// Pasted email carries machine text that is never a reference (28 Sep 2026):
// Outlook inline-picture ids and names, style colours, timestamps and prices.
// Measured on the 8,135 live tasks: 146 changed, 171 tokens dropped, none a
// reference. A colour goes only where a style property names it, because
// orders are written with a # too.
describe('machine text in pasted email is never a reference', () => {
  function tokens(texts) {
    return py(`
print('---JSON---'); print(json.dumps([m.reference_tokens(t) for t in json.loads(sys.argv[1])]))`, texts);
  }

  it('an Outlook inline picture gives nothing: neither its content id nor its file name', () => {
    expect(tokens([
      'Kind regards\n\n[cid:image002.jpg@01AB2345.6789CDEF]Jane\n[cid:image001.png@01CD6789.ABCDEF12]<https://example.com>',
      'Signature image003.png attached.',
      '<image001.png@01AB2345.6789CDEF> [image: image002.png@01CD6789.ABCDEF12] Outlook-1a2b3c4d.png',
    ])).toEqual([[], [], []]);
  });

  it('a style colour gives nothing, every colour in the declaration', () => {
    expect(tokens([
      'hr {\n  color: #e5e5e5;\n  background: #1a2b3c;\n  border: 1px solid #22aaee !important }',
      '<body lang="EN-GB" link="#467886" vlink="#96607D"><span style="color:#1188cc">Overdue</span><FONT color=#000000>',
      'border-color: #aa1122 #bb3344; background: linear-gradient(to right, #ccdd11, #ee5566)',
      'outline: 2px dashed #a1b2c3; --brand: #1a2b3c; fill: #123abc; stroke:#456def; box-shadow: 0 0 0 1px #789abc',
    ])).toEqual([[], [], [], []]);
  });

  it('a # reference outside a style survives, prose after a Background or Colour label included', () => {
    expect(tokens([
      'Order #GM123456 and order #123456789012. Invoice #123456, Order #AB1234. Payment link: #654321.',
      'Background: tenant says invoice #12345678 is unpaid. Item: Hoodie | Colour: Navy | Order #445566',
      // Not CSS: a value on the next line, a bare number, a word.
      'Background:\n#445566 raised by tenant. Border: 1 #998877. Colour: 2, #123456. Background: to chase #778899',
    ])).toEqual([['GM123456', '123456789012', '123456', 'AB1234', '654321'], ['12345678', '445566'],
      ['445566', '998877', '123456', '778899']]);
  });

  it('a timestamp is a date, so it gives nothing; eight bare digits stay', () => {
    expect(tokens([
      'Recorded:  2026-01-22T16:27:36.000Z',
      'outgoing message seen 2026-08-18T13:50:52Z and 2026-08-19t10:22:38+00:00',
      'DTSTART:20260122T162736Z and 2026-01-22T1627Z',
      'Account 20260122',
    ])).toEqual([[], [], [], ['20260122']]);
  });

  it('a price run into a word, or beside a currency sign or code, gives nothing', () => {
    expect(tokens([
      '**Description**Amount80.00**Subtotal80.00**Total VAT16.00**Amount Due** GBP96.00',
      'Balance GBP12,345.67, quote GBP160 plus VAT, fine EUR45, owed 12345GBP',
      'Owed £12500 and €99999, cost $10-15/year, GBP 12500 or 12500 GBP',
    ])).toEqual([[], [], []]);
  });

  it('a reference beside a price, a full stop or a currency sign survives', () => {
    expect(tokens([
      'Paid 12345678.00 on account 87654321. Invoice INV123456.pdf, policy AB12345.',
      'Attached INV654321.01.pdf. Section CD12345.123 applies. Ref:$EF12345',
      // A code with the amount after it: the number before is the order.
      'Order 123456 GBP 49.99. Invoice 12345678 EUR 1,200.00. Sort code 12-34-56 GBP account.',
      'Order 234567 GBP\n49.99 and ref 345678 USD, 50.00',
    // A file name is not a reference (Kevin, 29 Sep 2026), so INV123456.pdf
    // and INV654321.01.pdf give nothing; the stop in CD12345.123 still ends a
    // reference.
    ])).toEqual([['87654321', 'AB12345'], ['CD12345', 'EF12345'],
      ['123456', '12345678', '12-34-56'], ['234567', '345678']]);
  });

  it('a long run of blanks or a long word never makes the colour reader slow', () => {
    // Each text is read at one size and at four times that size, and the two
    // times are compared. A reader that goes back over the run at every step
    // takes about 16 times as long on four times the text; a sound one takes
    // about 4. The old check was "under 1 second", and on 2 Oct 2026 a busy
    // Mac took 1.22 seconds on sound code and blocked three merges. The time
    // counted is processor time this process used, never the clock on the
    // wall, so waiting behind other work adds nothing. Best of five rounds,
    // small then big in turn, so a spell on a slow core hits both sizes.
    const out = py(`
import time
cases = {
    'color: then blanks': lambda k: 'color:' + ' ' * (5000 * k) + 'x',
    'Background: then newlines': lambda k: 'Background:' + '\\n' * (5000 * k),
    'color:" then blanks': lambda k: 'color:"' + ' ' * (5000 * k),
    'linear-gradient( then blanks': lambda k: 'background: linear-gradient(' + ' ' * (5000 * k),
    'border: then blank-comma run': lambda k: 'border:' + ' ,' * (2500 * k) + 'x',
    '-- then a long word': lambda k: '--' + 'a' * (5000 * k) + ':',
    'dotted run': lambda k: 'a.' * (2500 * k),
    'dotted run then slash': lambda k: 'x.' * (2500 * k) + '/',
    'hyphen run a-': lambda k: 'a-' * (7500 * k),
    'hyphen run -a': lambda k: '-a' * (7500 * k),
    'many different tokens': lambda k: ' '.join(str(10000 + i) for i in range(7500 * k)),
}
def cpu(t):
    t0 = time.process_time(); m.reference_tokens(t); return time.process_time() - t0
res = {}
for name, make in cases.items():
    small, big = make(1), make(4)
    rounds = [(cpu(small), cpu(big)) for _ in range(5)]
    res[name] = [min(r[0] for r in rounds), min(r[1] for r in rounds)]
print('---JSON---'); print(json.dumps(res))`);
    expect(Object.keys(out).length).toBe(11);
    for (const [name, [small, big]] of Object.entries(out)) {
      // Under 50 milliseconds at full size the small reading is too short
      // for a steady ratio, and nothing that fast is the bug. Every slow pattern this
      // guards took over a second there: 28 seconds on the blanks before the
      // review fix, 1.2 on 'a.' * 10000, 3.1 on 'a-' * 30000 and on 30,000
      // different tokens before the 28 Sep 2026 fixes (0.07 and 0.04 after).
      const ratio = big < 0.05 ? 0 : big / small;
      expect(ratio, `${name}: ${small.toFixed(4)}s, then ${big.toFixed(4)}s on four times the text`).toBeLessThan(8);
      // Backstop only: a hang on any machine, however loaded.
      expect(big, `${name} at full size`).toBeLessThan(10);
    }
  }, 120000);

  it('the faster token reader finds exactly the tokens the old one did', () => {
    // The 28 Sep 2026 speed fix only makes the five-or-more check stop at
    // the first boundary. The old pattern is kept here and random text goes
    // through both, compared on every match's position.
    const out = py(`
import random, re
OLD = re.compile(r"\\b(?=[A-Z0-9-]{5,}\\b)(?:[A-Z]*\\d[A-Z0-9-]*)\\b")
spans = lambda r, s: [(x.start(), x.end()) for x in r.finditer(s)]
pieces = list('AZ09-_ .:/\\n\\tÉé²') + ['AB12345', '12-34-56', '--', 'A-', '-1', 'INV', '2026-09-28', 'X1', 'ABCDE', '_A1']
random.seed(20260928)
diffs, with_tokens = [], 0
for _ in range(20000):
    s = ''.join(random.choice(pieces) for _ in range(random.randint(0, 16)))
    old = spans(OLD, s)
    diffs += [s] if spans(m.REF_TOKEN_RE, s) != old else []
    with_tokens += bool(old)
print('---JSON---'); print(json.dumps({'diffs': diffs[:5], 'with_tokens': with_tokens}))`);
    expect(out.diffs).toEqual([]);
    // Control: the random text really does hold tokens.
    expect(out.with_tokens).toBeGreaterThan(8000);
  });

  it('the faster link reader strips exactly what the old one did', () => {
    // The 28 Sep 2026 speed fix must not change what counts as a link. The
    // old pattern is kept here, with a run group that never matches so the
    // real reader can use it, and random text goes through both.
    const out = py(`
import random, re
OLD = re.compile(r"(?i:https?://|www\\.)\\S+|\\b(?:[a-z0-9-]+\\.)+[a-z]{2,}/\\S*|(?P<run>(?!))")
NEW = m.REF_URL_RE
pieces = list('aAbz09.-/ _:\\néÉ²') + ['www.', 'WwW.', 'http://', 'HTTPS://', 'co.uk/', '.com/', '..', 'Acc.', 'no/',
          'No/', 'Rightmove', 'AB12345', '12345678', 'ttp://', 'ww.', 'x-']
def both(s):
    m.REF_URL_RE = NEW
    new = (NEW.sub(lambda x: x.group('run') or ' ', s), m.reference_tokens(s))
    m.REF_URL_RE = OLD
    old = (OLD.sub(' ', s), m.reference_tokens(s))
    m.REF_URL_RE = NEW
    return new, old
random.seed(20260928)
diffs, linked, bare, with_tokens = [], 0, 0, 0
for _ in range(20000):
    s = ''.join(random.choice(pieces) for _ in range(random.randint(0, 14)))
    new, old = both(s)
    diffs += [s] if new != old else []
    linked += old[0] != s
    bare += old[0] != s and not re.search(r"(?i:http|www)", s)
    with_tokens += bool(old[1])
named = {s: both(s)[0][1] for s in ['Acc.no/12345678', 'Rightmove.co.uk/properties/12345678', 'wait..example.com/123456']}
print('---JSON---'); print(json.dumps({'diffs': diffs[:5], 'linked': linked, 'bare': bare, 'with_tokens': with_tokens, 'named': named}))`);
    expect(out.diffs).toEqual([]);
    // Control: the random text really does hold links, links with no
    // scheme (the ones the fix speeds up) and references.
    expect(out.linked).toBeGreaterThan(10000);
    expect(out.bare).toBeGreaterThan(1000);
    expect(out.with_tokens).toBeGreaterThan(3000);
    // A host glued to a capital or after a double dot reads as before: the
    // lowercase tail of a capitalised link is a link, a mixed-case host with
    // one dot is not.
    expect(out.named).toEqual({
      'Acc.no/12345678': ['12345678'],
      'Rightmove.co.uk/properties/12345678': [],
      'wait..example.com/123456': [],
    });
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

// A file name is not a reference (Kevin, 28 Sep 2026). The TRACK RECORD on a
// new UC47 chase said "searched tasks + Gmail for ref UC47-ANSWERS": the token
// came from the working-file line of its description,
// `.../2026-09-28 uc47 <tenant>/uc47-answers.md`, and the search pulled in a
// different tenant's UC47 history. The description below is that task's, with
// the tenant's name and the record id changed (this repo is public).
// Back-tested: before the fix the first case returns ['UC47-ANSWERS'].
describe('a file path or file name is never a reference', () => {
  const UC47_DESC = "Check DWP decision on Aaron Mitchell's UC47 (55 Elmdon Place) and chase if none "
    + 'UC47 (direct rent payment plus arrears) was submitted online to DWP on 28 Sep 2026 for Aaron Mitchell, '
    + '55 Elmdon Place, Haverhill (tenancy recT3stTenancy012, now CFV Actioned).\n\nOn 12 Oct:\n'
    + '1. Search Gmail: (from:dwp.gov.uk OR from:notifications.service.gov.uk) Mitchell after:2026/09/28.\n'
    + '2. Check Transactions for a DWP credit with reference MITCHELL or MITCHELLRA linked to tenancy recT3stTenancy012.\n\n'
    + 'Working file: ~/Projects/kevin-hq/property/2026-09-28 uc47 mitchell/uc47-answers.md\n';

  it('the working-file line of the UC47 chase gives no reference', () => {
    const out = py(`
print('---JSON---'); print(json.dumps(m.reference_tokens(json.loads(sys.argv[1]))))`, UC47_DESC);
    expect(out).toEqual([]);
  });

  it('paths and file names in every shape give nothing', () => {
    const out = py(`
print('---JSON---'); print(json.dumps([m.reference_tokens(t) for t in json.loads(sys.argv[1])]))`, [
      '/Users/kevinbrittain/Projects/kevin-hq/property/2026-09-21 chedburgh gas safety/GSC-2026-4471.pdf',
      'Saved as ~/Downloads/HMRC-CFS1234567.pdf for the reply.',
      'Output in ./exports/rent-ledger-Q3-2026.csv today.',
      'Read notes/case-AB12345/letter-v22.docx first.',
      'Draft at mitchell/uc47-answers.md',
      'Filed in ~/Library/CloudStorage/GoogleDrive-x/My Drive/00 AI Context/case-AB12345-notes.md',
      // Bare attachment names, file names with spaces in a path or in quotes,
      // and a folder whose second word is lowercase (Kevin, 29 Sep 2026).
      'Attachment INV123456.pdf from the council.',
      'Attached: Invoice_INV-20260928.pdf and scan0042.jpg',
      'Filed in ~/Library/CloudStorage/GoogleDrive-x/My Drive/00 AI Context/Case AB12345 notes.md',
      'Saved "Case AB12345 notes.md" to the drive.',
      'Filed in ~/Library/CloudStorage/GoogleDrive-x/Shared drives/Case-AB12345.pdf today.',
      'SCAN INV123456.PDF attached', "(\u2018Case AB12345 notes.md\u2019)",
    ]);
    expect(out).toEqual([[], [], [], [], [], [], [], [], [], [], [], [], []]);
  });

  it('a long dotted, slashed or spaced run never makes the path reader slow', () => {
    const out = py(`
import time
worst = 0
for t in ['a.' * 10000, '/a' * 10000, '~/' + 'a ' * 10000, 'x/' + 'a.' * 10000, ' ~/a b/' * 3000,
          '~/' + 'a/' * 10000 + 'x', 'a' * 20000 + '.pd',
          # A dated folder shape repeated: exponential before the review fix.
          '~/' + '1 a/' * 40 + 'x', '~/' + '1 a b/' * 40 + 'x', '/' + '2026 x y/' * 60 + 'z',
          '~/' + 'A B/' * 40 + 'x', '~/x/' + 'A ' * 5000 + 'b.md', '"' + 'a ' * 5000 + '.md',
          ("'x " * 3000) + '.md']:
    t0 = time.time(); m.FILE_PATH_RE.sub(' ', t); worst = max(worst, time.time() - t0)
print('---JSON---'); print(json.dumps(worst))`);
    expect(out).toBeLessThan(0.5);
  });

  it('a real reference beside a path, or written with a slash, survives', () => {
    const out = py(`
print('---JSON---'); print(json.dumps([m.reference_tokens(t) for t in json.loads(sys.argv[1])]))`, [
      'Working file ~/x/notes.md, claim AB12345.',
      'Saved to ~/Downloads, ref AB12345, see the letter.',
      'Policy AB12345 and/or claim CD67890.',
      'Account Acc.No/12345678 on the statement.',
      'Letter ref 2026/AB12345 dated today.',
      'Folder ~/Projects/kevin-hq then call re ref AB12345 and/or email.',
      // A file name and the words after it never read as a folder running on
      // to the next path, and a lone /X12345 is not a path (review).
      'Draft ~/work/reply.md for claim AB12345 in ~/Downloads/dwp.pdf',
      'See /tmp/a.md re claim AB12345 then Downloads/scan.pdf',
      'Saved /x.md claim AB12345 sent to roy/kevin.pdf',
      'Letter (/AB12345) today',
      'Rent ref: /TEN-12345 paid',
      'Saved in ~/Downloads for claim AB12345 see notes/x.md',
      // Lowercase words after a path are a sentence, not a file name.
      'Put ~/Downloads/scan re AB12345 x.pdf in the letter.',
      'He said "ref AB12345 is due" and left.',
      // An apostrophe in prose never opens a quoted file name, and a word
      // after a missing space is not a file type (review).
      "Kevin's claim AB12345 is in \u2018scan.pdf\u2019",
      "It's ref AB12345, scan attached as \u201cletter.pdf\u201d",
      "Jane's claim AB12345 filed with scan.pdf's copy",
      'Your claim number is AB12345.Log in to view it.',
      'Policy PX123456.Key dates below',
    ]);
    expect(out).toEqual([['AB12345'], ['AB12345'], ['AB12345', 'CD67890'], ['12345678'], ['AB12345'], ['AB12345'],
      ['AB12345'], ['AB12345'], ['AB12345'], ['AB12345'], ['12345'], ['AB12345'], ['AB12345'], ['AB12345'],
      ['AB12345'], ['AB12345'], ['AB12345'], ['AB12345'], ['PX123456']]);
  });
});
