// Personal data must never reach monitoring/ in this PUBLIC repo.
//
// Regression origin: 12 Aug 2026, finding 20260812-daily-ops-115.
// monitoring/task-sweep-2026-08-11.md is tracked and pushed and carried a
// tenant's mobile number twice, because an INBOUND SMS task is titled with the
// sender's number. The 31 Jul 2026 leak fix stopped the sweep JSON (via
// monitoring/.gitignore, guarded by tests/never-commit-paths.test.js) but that
// guard is about WHICH files travel, not what is inside the ones that are meant
// to. The next morning the same number reappeared and was masked BY HAND, which
// is not a control: it lasts as long as somebody is watching a 07:00 job.
//
// Two things are guarded here:
//   1. the scrubber masks what it claims to, and leaves ordinary report text
//      alone (a scrubber that mangles numbers is one somebody switches off);
//   2. no TRACKED text file under monitoring/ contains personal data TODAY.
//      (2) is the one that would have caught the leak, and it keeps catching it
//      if a report is ever committed round the collector.
//
// Back-tested: restoring the raw number in monitoring/task-sweep-2026-08-11.md
// makes the second block fail, and deleting _PHONE_CANDIDATE makes the first.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const SCRUB = resolve(ROOT, 'scripts/report_scrub.py');

// Drive the REAL Python patterns. Re-implementing them in JS would guard a copy
// and let the shipped regex rot (recon-vendor-key.test.js learned this the hard
// way). Python and JS regex dialects differ on exactly the lookbehinds used here.
function scrub(samples) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('rs', ${JSON.stringify(SCRUB)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
out = {'selftest': m.selftest(), 'scrubbed': {}}
for s in json.loads(sys.argv[1]):
    text, hits = m.scrub(s)
    out['scrubbed'][s] = {'text': text, 'hits': [k for k, _ in hits]}
print(json.dumps(out))
`;
  return JSON.parse(
    execFileSync('python3', ['-c', script, JSON.stringify(samples)], { encoding: 'utf8' })
  );
}

describe('report_scrub masks personal data', () => {
  it('passes its own selftest (the control on the control)', () => {
    // A pattern that stopped matching reports "nothing found" for ever, which
    // reads exactly like a clean day. collect-routine-reports.py refuses to
    // copy anything when this fails.
    expect(scrub([]).selftest).toEqual([]);
  });

  it('masks the number that actually leaked', () => {
    const s = '| SMS reply from +447538631747 | Business | Real Estate |';
    const r = scrub([s]).scrubbed[s];
    expect(r.text).not.toContain('7538631747');
    expect(r.text).toContain('+4475XXXXX747');
    expect(r.hits).toContain('phone');
    // The surrounding table cell must survive intact — the first draft ate the
    // trailing space and ran the mask into the next word.
    expect(r.text).toBe('| SMS reply from +4475XXXXX747 | Business | Real Estate |');
  });

  it('masking is idempotent, so a second pass cannot corrupt a masked report', () => {
    const s = 'from +4475XXXXX747 today';
    expect(scrub([s]).scrubbed[s].text).toBe(s);
  });

  it('masks third-party email addresses and UK postcodes', () => {
    const email = 'Chase accounts@some-letting-agent.co.uk for the statement';
    const post = 'Tenant at CB23 6DL reported damp';
    const r = scrub([email, post]).scrubbed;
    expect(r[email].text).not.toContain('some-letting-agent');
    expect(r[post].text).not.toContain('6DL');
    expect(r[post].text).toContain('CB23 XXX');
  });

  it("leaves Kevin's own already-public addresses alone", () => {
    const s = 'Sent from kevinbrittain@gmail.com and kevin@operationsdirector.co.uk';
    expect(scrub([s]).scrubbed[s].text).toBe(s);
  });

  it('does not touch dates, money, counts or Airtable ids', () => {
    const samples = [
      '8,690 transactions on 2026-08-12 totalling 1742.60',
      'Base appnqjDpqDniH3IRl table tblqB8b22hKBL4PF1 record recSvXxaEz57i7YQK',
      '| invocations | 00\n2026-08-05 | 1 |',
      'Version 1.6 vs 1.0, 100 rows of 259, HTTP 200 OK',
    ];
    const r = scrub(samples).scrubbed;
    for (const s of samples) expect(r[s].text, `mangled: ${s}`).toBe(s);
  });
});

describe('no tracked monitoring report contains personal data', () => {
  const files = execFileSync('git', ['ls-files', 'monitoring/'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(md|txt)$/.test(f));

  it('has files to check (a zero-file list would pass for ever)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('contains no raw UK phone number', () => {
    // Deliberately narrower than the scrubber: this asserts on what is already
    // committed, so a false positive here blocks a push. Digits only, no spaces.
    const re = /(\+44\d{9,10}|\b07\d{9})\b/g;
    const offenders = [];
    for (const f of files) {
      const hits = readFileSync(resolve(ROOT, f), 'utf8').match(re);
      if (hits) offenders.push(`${f}: ${hits.length} hit(s)`);
    }
    expect(offenders, 'a raw phone number is in the public repo').toEqual([]);
  });
});
