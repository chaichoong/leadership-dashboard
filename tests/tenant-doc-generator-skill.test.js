import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_SKILL = resolve(ROOT, '.claude/skills/tenant-doc-generator/SKILL.md');
const PERSONAL_SKILL = resolve(homedir(), '.claude/skills/anthropic-skills/tenant-doc-generator/SKILL.md');

// 28 Sep 2026. The claude.ai copy of this skill sent a session to a WeasyPrint generator
// that is not installed, and its fallback rendered a proof of residency with no "Signed:"
// label, which Adobe cannot place a box on. The same day a weak send confirmation led to a
// second proof of residency after Kevin had signed the first. The reviewed copy fixes both;
// this test keeps a re-sync or a tidy-up from quietly undoing it.

const CLAUSES = [
  ['scripts/make-tenancy-pack.js', 'the generator Kevin approved'],
  ['info@agilelets.co.uk is ALWAYS the first recipient', 'the signing order rule'],
  ['--fields blocks:2,1', 'the landlord boxes going to info@, not the tenant'],
  ['Recipients must complete in order', 'Kevin\'s order-on ruling'],
  ['A weak confirmation is never a reason to press Send again', 'the duplicate-send guard'],
  ['The saved signature is Kevin\'s', 'whose signature the info@ account holds'],
  ['type "Roy Lavin"', 'how a Roy Lavin box is signed'],
  ['Nothing is sent without his yes', 'the approval gate before Send'],
  ['Airtable onboarding waits until EVERY document is signed', 'onboarding timing'],
  ['Then Claude does it, not Kevin', 'who onboards since 28 Sep 2026'],
  ['Email the signed proof of residency to the tenant', 'the step Adobe does not do for us'],
  ['Do not forward the agreement', 'the tenant already gets the completed agreement from Adobe'],
  ['set Payment Status to CFV Actioned', 'the status move after the UC47'],
  ['stay retired: a missed payment is arrears', 'the limit on the one UC check'],
  ['Ask Kevin every time whether to include the authority to act', 'the authority question on every pack'],
];

describe('tenant-doc-generator reviewed skill', () => {
  const repo = readFileSync(REPO_SKILL, 'utf8');

  it.each(CLAUSES)('repo copy keeps %s', (phrase, loses) => {
    expect(repo, `SKILL.md no longer states: ${loses}`).toContain(phrase);
  });

  it('names only scripts that exist', () => {
    const named = [...new Set(repo.match(/scripts\/[\w.-]+\.(?:js|py)/g))];
    expect(named.length).toBeGreaterThan(0);
    for (const s of named) expect(existsSync(resolve(ROOT, s)), `${s} is named but missing`).toBe(true);
  });

  it('never points back at the old WeasyPrint generator', () => {
    expect(repo).not.toMatch(/generate_docs\.py|pip install weasyprint/);
  });

  // The copy the app loads lives outside git. If it is installed it must match this one.
  it('installed personal copy matches the repo copy', () => {
    if (!existsSync(PERSONAL_SKILL)) return;
    expect(readFileSync(PERSONAL_SKILL, 'utf8')).toBe(repo);
  });
});
