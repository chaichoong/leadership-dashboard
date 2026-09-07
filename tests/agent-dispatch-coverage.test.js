import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SRC = readFileSync(DISPATCH, 'utf8');

// THE COVERAGE CHECK (Kevin, 7 Sep 2026): "We're not emailing somebody a
// property address that's not within their location, because that just looks
// clueless from our perspective. Double and treble check the geographic
// location of the contractor." Three quotes per job; one email may cover
// several properties only when the tradesperson covers every one.

function py(code) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("ad", ${JSON.stringify(DISPATCH)})
ad = importlib.util.module_from_spec(spec)
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec.loader.exec_module(ad)
${code}
`;
  return execFileSync('/usr/bin/python3', ['-c', script], { encoding: 'utf8' }).trim();
}
const EMAIL = 'TO: info@ac1.example\nFROM: info@agilelets.co.uk\nSUBJECT: EICR quote\n---\nPlease quote for an EICR at 6 Chedburgh Place, CB9 0AB and 13 Chedburgh Place, CB9 0AB.';
const COV = 'PROPERTY: 6 Chedburgh Place, Haverhill, CB9 0AB\nPROPERTY: 13 Chedburgh Place, Haverhill, CB9 0AB\nCONTRACTOR: AC1 Electrical Services covers CB9, CB8, IP33 (source: https://ac1electrical.example/areas)';
const check = (cov, out, name, type = 'Correspondence') =>
  py(`print(ad.coverage_problem(${JSON.stringify(cov)}, ${JSON.stringify(out)}, ${JSON.stringify(name)}, ${JSON.stringify(type)}))`);

describe('the coverage check on quote emails', () => {
  it('passes when every property is in the districts the contractor states, with a source', () => {
    expect(check(COV, EMAIL, 'COMPLIANCE: EICR quote request - AC1 - 6 Chedburgh Place')).toBe('');
  });
  it('refuses a quote email on a property task with no coverage file', () => {
    expect(check('', EMAIL, 'COMPLIANCE: EICR quote')).toMatch(/needs a coverage file/);
  });
  it('refuses a contractor line with no source: the areas must be read, never guessed', () => {
    expect(check('PROPERTY: 6 Chedburgh Place, CB9 0AB\nCONTRACTOR: X covers CB9', EMAIL, 'COMPLIANCE: x')).toMatch(/needs a coverage file/);
  });
  it('refuses a property outside the stated area and names it', () => {
    const out = EMAIL.replace('6 Chedburgh Place, CB9 0AB', '22 Newton Street, BB11 1AA');
    const p = check('PROPERTY: 22 Newton Street, Burnley, BB11 1AA\nCONTRACTOR: AC1 covers CB9, CB8 (source: https://x)', out, 'COMPLIANCE: GSC');
    expect(p).toMatch(/22 Newton Street.*is BB11: outside their area/);
  });
  it('refuses an email that names a postcode no PROPERTY line declared', () => {
    expect(check(COV, EMAIL + ' Also 22 Newton Street BB11 1AA.', 'COMPLIANCE: x')).toMatch(/names postcode BB11 1AA but no PROPERTY line/);
  });
  it('a town the contractor lists, or an area code, counts as coverage', () => {
    expect(check('PROPERTY: 6 Chedburgh Place, Haverhill, CB9 0AB\nCONTRACTOR: CJ Plumbing covers Haverhill, Cambridge and Newmarket (source: https://x)', EMAIL, 'COMPLIANCE: GSC')).toBe('');
    expect(check('PROPERTY: 6 Chedburgh Place, Haverhill, CB9 0AB\nCONTRACTOR: X covers CB, IP (source: https://x)', EMAIL, 'COMPLIANCE: GSC')).toBe('');
    expect(check('PROPERTY: 6 Chedburgh Place, Haverhill, CB9 0AB\nCONTRACTOR: X covers nationwide (source: https://x)', EMAIL, 'COMPLIANCE: GSC')).toBe('');
  });
  it('a property line without a postcode is refused: the district is the check', () => {
    expect(check('PROPERTY: 6 Chedburgh Place\nCONTRACTOR: X covers CB9 (source: https://x)', EMAIL, 'COMPLIANCE: GSC')).toMatch(/no postcode/);
  });
  it('only quote-related emails on property-lane tasks are checked', () => {
    expect(check('', 'TO: a@b\n---\nThanks for the visit yesterday.', 'COMPLIANCE: thanks')).toBe('');
    expect(check('', EMAIL, 'INBOUND: quote for x')).toBe('');
    expect(check('', EMAIL, 'COMPLIANCE: x', 'Analysis')).toBe('');
  });
  it('submit reads --coverage before the send-promise check and stamps what passed into Notes', () => {
    expect(SRC).toMatch(/cov = coverage_problem\(coverage_text, output, tf_early\.get\(AF\["name"\], ""\) or "", args\.type\)\n\s+if cov:\n\s+sys\.exit\(/);
    expect(SRC).toMatch(/cs = coverage_stamp\(coverage_text/);
    const stamp = py(`print(ad.coverage_stamp(${JSON.stringify(COV)}, "07 Sep 2026 13:00"))`);
    expect(stamp).toBe('[07 Sep 2026 13:00 — agent-dispatch] COVERAGE CHECKED: CB9 (6 Chedburgh Place), CB9 (13 Chedburgh Place) within AC1 Electrical Services covers CB9, CB8, IP33 (https://ac1electrical.example/areas).');
  });
});
