// The prospect dedupe key. Two duplicates reached the queue in two days because the
// rule lived as a sentence in a SKILL.md and the agent re-derived it each run.
//
//   8 Aug 2026 — "Smith & Sons Ltd" vs "Smith and Sons Limited" read as two companies.
//                Companies House numbers were compared against the `Companies House No`
//                field only, while 36 records carried the number solely in Notes.
//   9 Aug 2026 — "Q.E.D. Industrial Controls" vs "QED Industrial Controls" likewise:
//                stripping punctuation left three separate one-letter tokens.
//
// The cost of a miss lands on the recipient — the same founder gets cold-emailed
// twice — and nothing errors, because a duplicate prospect looks exactly like a
// new one.
//
// These drive the real functions in scripts/prospect-dedupe.py, so the test cannot
// pass against a stale copy of the rule.

import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT = resolve(__dirname, '../scripts/prospect-dedupe.py');

// One python process for the whole suite: pass every case in, read every key out.
async function keys(names) {
  const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("pd", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.company_key(n) for n in json.loads(sys.argv[1])]))
`;
  const { stdout } = await run('python3', ['-c', py, JSON.stringify(names)],
    { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(stdout.trim().split('\n').pop());
}

async function chNumbers(text) {
  const { stdout } = await run('python3', [SCRIPT, 'ch', text], { encoding: 'utf8' });
  return stdout.trim().split('\n').filter(Boolean);
}

describe('company_key', () => {
  let k;
  const CASES = [
    'Smith & Sons Ltd',
    'Smith and Sons Limited',
    'SMITH AND SONS',
    'Q.E.D. Industrial Controls',
    'QED Industrial Controls',
    'Q E D Industrial Controls Ltd',
    'J & B Plumbing',
    'JB Plumbing Ltd',
    'The Old Bakery Co',
    'Old Bakery',
    'Smith Group',
    'Smith Holdings',
    'Northwood Facilities Management Limited',
  ];
  beforeAll(async () => { k = await keys(CASES); });
  const at = (name) => k[CASES.indexOf(name)];

  it("collapses '&' and 'and' to the same key", () => {
    expect(at('Smith & Sons Ltd')).toBe('smith sons');
    expect(at('Smith and Sons Limited')).toBe('smith sons');
    expect(at('SMITH AND SONS')).toBe('smith sons');
  });

  it('collapses punctuation-separated initials — Q.E.D. == QED', () => {
    expect(at('Q.E.D. Industrial Controls')).toBe('qed industrial controls');
    expect(at('QED Industrial Controls')).toBe('qed industrial controls');
    expect(at('Q E D Industrial Controls Ltd')).toBe('qed industrial controls');
  });

  it("collapses initials split by an '&' — J & B == JB", () => {
    // Only works because stopwords are dropped BEFORE single-letter runs are
    // joined; reverse the order and 'and' sits between the initials for ever.
    expect(at('J & B Plumbing')).toBe('jb plumbing');
    expect(at('JB Plumbing Ltd')).toBe('jb plumbing');
  });

  it('strips legal-form suffixes and leading "The"', () => {
    expect(at('The Old Bakery Co')).toBe('old bakery');
    expect(at('Old Bakery')).toBe('old bakery');
    expect(at('Northwood Facilities Management Limited'))
      .toBe('northwood facilities management');
  });

  it('does NOT merge distinct companies that share a word', () => {
    // 'group' and 'holdings' are deliberately not stopwords. Merging these would
    // drop a real prospect silently, which is worse than the duplicate it saves.
    expect(at('Smith Group')).not.toBe(at('Smith Holdings'));
  });

  it('returns empty for blank input rather than a key that matches everything', async () => {
    expect(await keys(['', null])).toEqual(['', '']);
  });
});

// 11 Aug 2026 — finding 20260811-prospect-daily-086. Prospects held the SAME
// employer twice: recbZXMmAMOo6Mv07 'Cornerstone Supplies Limited (Abbeydale
// Direct)' (3 Aug) and rec9p6crluEJaTSpa 'Cornerstone Supplies Limited (t/a
// Abbeydale Direct)' (10 Aug), same email mail@abbeydale-direct.co.uk, same
// Companies House number 01854182, both sitting in Ready for Review. The 't/a'
// survived punctuation stripping as the token 'ta', so the two keys differed by
// one word and the name gate waved the second through. The same class of miss
// hit 'Abbey Antiques & Furnishings Ltd (The Abbey Group)', which an Indeed
// employer string of 'The Abbey Group' could never match.
describe('company_keys — trading names and aliases', () => {
  async function all(names) {
    const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("pd", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.company_keys(n) for n in json.loads(sys.argv[1])]))
`;
    const { stdout } = await run('python3', ['-c', py, JSON.stringify(names)],
      { encoding: 'utf8', timeout: 30000 });
    return JSON.parse(stdout.trim().split('\n').pop());
  }
  const overlaps = (a, b) => a.some((k) => b.includes(k));

  it("'t/a' does not split a key — the Cornerstone pair", async () => {
    const [plain, ta] = await all([
      'Cornerstone Supplies Limited (Abbeydale Direct)',
      'Cornerstone Supplies Limited (t/a Abbeydale Direct)',
    ]);
    expect(plain[0], 'the whole-name keys still differ').toBe(ta[0]);
    expect(overlaps(plain, ta)).toBe(true);
  });

  it('indexes the registered name and the trading name separately', async () => {
    const [k] = await all(['Cornerstone Supplies Limited (t/a Abbeydale Direct)']);
    expect(k).toContain('cornerstone supplies');
    expect(k).toContain('abbeydale direct');
  });

  it('a trading name on its own still matches — the Abbey Antiques pair', async () => {
    const [stored, incoming] = await all([
      'Abbey Antiques & Furnishings Ltd (The Abbey Group)',
      'The Abbey Group',
    ]);
    expect(overlaps(stored, incoming),
      'a trading name from a job board matched nothing').toBe(true);
  });

  it('handles "trading as" and "formerly" spelled out', async () => {
    const [a, b, c] = await all([
      'Northwood Facilities Management Ltd trading as Northwood FM',
      'Northwood FM',
      'Northwood Facilities Management Limited',
    ]);
    expect(overlaps(a, b)).toBe(true);
    expect(overlaps(a, c)).toBe(true);
  });

  it('still does NOT merge distinct companies that share one word', async () => {
    const [group, holdings] = await all(['Smith Group', 'Smith Holdings']);
    expect(overlaps(group, holdings)).toBe(false);
  });

  it('never emits a one-word alias that would swallow every namesake', async () => {
    const [k] = await all(['Smith Brothers Ltd (Smith)']);
    expect(k).not.toContain('smith');
  });
});

describe('ch_numbers', () => {
  it('finds a number stored only in free-text Notes', async () => {
    expect(await chNumbers('Spoke to owner. Co no 09876543, VAT pending.'))
      .toEqual(['09876543']);
  });

  it('finds Scottish and Northern Irish prefixed numbers', async () => {
    expect(await chNumbers('SC123456 and ni654321 both seen'))
      .toEqual(['SC123456', 'NI654321']);
  });

  it('de-duplicates repeats within one blob', async () => {
    expect(await chNumbers('09876543 ... confirmed 09876543')).toEqual(['09876543']);
  });

  it('ignores numbers that are the wrong length', async () => {
    expect(await chNumbers('called 0771234 and 123456789012')).toEqual([]);
  });
});
