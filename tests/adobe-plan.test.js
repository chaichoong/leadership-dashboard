import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLAN = resolve(ROOT, 'scripts/adobe-plan.js');
const BROWSER = resolve(ROOT, 'scripts/agent-browser.js');
const require_ = createRequire(import.meta.url);
const mod = require_(PLAN);

// agent-browser.js executes plans; it does not invent them. Every Adobe plan
// before this was hand-written in an interactive session, which meant an agent
// could generate a letter and then had no way to get it signed.
describe('adobe-plan', () => {
  it('passes its own selftest', () => {
    const out = execFileSync('node', [PLAN, '--selftest'], { encoding: 'utf8' });
    expect(out).not.toContain('FAIL ');
    expect(out).toContain('PASS presses Enter after every signer');
  });

  // A recipient only becomes a CHIP on Enter. fill alone leaves loose text in a
  // box, Send produces an agreement that goes to nobody, and NOTHING errors.
  it('pairs every fill with a press', () => {
    const plan = mod.buildPlan({ document: '/x/a.pdf', signers: ['k@b.com'] });
    const fills = plan.steps.filter((s) => s.do === 'fill').length;
    const presses = plan.steps.filter((s) => s.do === 'press').length;
    expect(fills).toBeGreaterThan(0);
    expect(presses, 'a fill with no press sends an agreement to nobody, silently').toBe(fills);
  });

  // Auto-place assigns every field to one recipient. With one signer that is
  // harmless; with several it gives one person all the fields and the rest none.
  it('refuses a multi-signer agreement rather than sending it wrong', () => {
    expect(() => mod.parseSigners('a@b.com, c@d.com')).toThrow(/multi|fields on the wrong|one recipient/i);
    expect(() => mod.parseSigners('not-an-email')).toThrow();
    expect(() => mod.parseSigners('')).toThrow();
  });

  it('ends on submit so prepare cannot send', () => {
    const plan = mod.buildPlan({ document: '/x/a.pdf', signers: ['k@b.com'] });
    const dos = plan.steps.map((s) => s.do);
    expect(dos[dos.length - 1]).toBe('submit');
    expect(dos.filter((d) => d === 'submit')).toHaveLength(1);
  });

  // Adobe's card classes are hashed and its field ids React-generated. Both
  // change on their next deploy; text-scoped selectors are what has held still.
  it('uses no selector that dies on an Adobe deploy', () => {
    const json = JSON.stringify(mod.buildPlan({ document: '/x/a.pdf', signers: ['k@b.com'] }));
    expect(json).not.toMatch(/Card__container|react-aria|VerbTile/);
    expect(json).toMatch(/has-text/);
  });

  // The signed copy finds its way back to the task by agreement NAME, and Adobe
  // names the agreement after the file.
  it('predicts the agreement name Adobe will use', () => {
    expect(mod.agreementName('/x/Letter_of_Authority.pdf')).toBe('Letter_of_Authority');
  });

  it('refuses a document outside the attachments directory', () => {
    const r = spawnSync('node', [PLAN, '--document', '/etc/hosts', '--signers', 'k@b.com'],
      { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/outside the attachments directory|must be a PDF/);
  });

  // A plan names the document and the signer. On 28 Aug an agent that could not
  // write to its scratch dir fell back to /tmp world-readable, so the plan gets
  // the same no-temp-file treatment as the letter spec.
  it('the browser lane accepts a plan on stdin', () => {
    const src = readFileSync(BROWSER, 'utf8');
    expect(src).toMatch(/readFileSync\(0, 'utf8'\)/);
    expect(src).toMatch(/--plan FILE\.json or --plan - \(stdin\)/);
  });
});
