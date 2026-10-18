// Three fixes from the 18 Oct 2026 queue-fixer run, each driving the real code.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

function py(code) {
  return execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})\n${code}`],
    { encoding: 'utf8', timeout: 30000 }).trim();
}

// ── 20261016-agent-dispatch-931 ──────────────────────────────────────────────
// 16 Oct 2026: an approved reply went out as "Re: Apartment 7 &amp; 8 Duckworth
// Building". The inbound subject was read HTML-escaped and copied into SUBJECT,
// and nothing unescaped it before sending.
describe('email SUBJECT is plain text, not HTML', () => {
  const draft = (subject) => `TO: someone@example.com
SUBJECT: ${subject}
---
Morning,

The rent for both flats is settled.

Kevin`;

  it('unescapes an HTML entity carried in from the inbound subject', () => {
    const out = py(`import agent_email_format as f, json
print(json.dumps(f.parse_output(${JSON.stringify(draft('Re: Apartment 7 &amp; 8 Duckworth Building'))})["subject"]))`);
    expect(JSON.parse(out)).toBe('Re: Apartment 7 & 8 Duckworth Building');
  });

  it('leaves an ordinary subject exactly as written', () => {
    const out = py(`import agent_email_format as f, json
print(json.dumps(f.parse_output(${JSON.stringify(draft('Re: Rent for 7 & 8'))})["subject"]))`);
    expect(JSON.parse(out)).toBe('Re: Rent for 7 & 8');
  });
});

// ── 20261015-agent-dispatch-906 ──────────────────────────────────────────────
// Pingen rejected the approved TMW letter with address_zip_invalid: its last
// address line was "Northampton NN3 6NW". The same run's "LS78 1LB" alone passed.
describe('postal address: the postcode sits alone on its own line', () => {
  const problem = (lines) => py(`import agent_email_format as f, json
print(json.dumps(f.postcode_line_problem(${JSON.stringify(lines)})))`);

  it('refuses the town and the postcode on one line', () => {
    const r = JSON.parse(problem(['The Mortgage Works', '1 Charter Place', 'Northampton NN3 6NW']));
    expect(r).toContain('address_zip_invalid');
    expect(r).toContain('Northampton NN3 6NW');
  });

  it('accepts the postcode on its own line', () => {
    expect(JSON.parse(problem(['Birmingham Midshires', 'Pendeford Business Park', 'Leeds', 'LS78 1LB']))).toBe('');
  });

  it('accepts a postcode line sitting above "United Kingdom"', () => {
    expect(JSON.parse(problem(['HM Revenue and Customs', 'Corporation Tax', 'BX9 1AX', 'United Kingdom']))).toBe('');
  });

  it('leaves a non-UK address alone', () => {
    expect(JSON.parse(problem(['Acme Inc', '500 Market Street', 'San Francisco CA 94105', 'United States']))).toBe('');
  });

  it('refuses the whole POST output, before Kevin ever approves it', () => {
    const out = py(`import agent_email_format as f
post = """POST:
The Mortgage Works
1 Charter Place
Northampton NN3 6NW
DOCUMENT: /tmp/x.pdf
---
What this letter says."""
try:
    f.parse_post_output(post); print("ACCEPTED")
except f.EmailFormatError as e: print("REFUSED:", e)`);
    expect(out).toContain('REFUSED');
    expect(out).toContain('two lines');
  });
});

// ── 20261016-task-manager-950 ────────────────────────────────────────────────
// annotate writes "Chase to Roy (16 Oct 2026): ...". ROY_TOUCH_MARKS only held
// the bare "Chase to Roy:", so chaseDue stayed true and Roy would be chased twice
// in one day against the one-per-seven-days rule.
describe('Roy chase detection', () => {
  const stamp = (note) => py(`import importlib.util, json
spec = importlib.util.spec_from_file_location("tm", ${JSON.stringify(resolve(ROOT, 'scripts/task-manager.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
got = m.newest_note_stamp(${JSON.stringify(note)}, *m.ROY_TOUCH_MARKS)
print(json.dumps(got.strftime("%Y-%m-%d") if got else None))`);

  it('counts the dated form annotate actually writes', () => {
    expect(JSON.parse(stamp('[16 Oct 2026 — task-manager] Chase to Roy (16 Oct 2026): any news on the boiler?')))
      .toBe('2026-10-16');
  });

  it('still counts the bare form', () => {
    expect(JSON.parse(stamp('[16 Oct 2026 — task-manager] Chase to Roy: any news on the boiler?'))).toBe('2026-10-16');
  });

  it('does not count a note that merely mentions chasing Roy', () => {
    expect(JSON.parse(stamp('[16 Oct 2026 — task-manager] a chase to Roy is overdue on this one'))).toBe(null);
  });
});
