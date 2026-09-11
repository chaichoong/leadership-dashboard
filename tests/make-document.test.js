import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = resolve(ROOT, 'scripts/make-document.js');

// make-letter.js is a LETTER generator: it demands a three-line address and pins
// it at 64mm for Pingen's envelope window. A tenancy agreement has no envelope
// and nineteen clauses, so it needed its own renderer. Adobe's API is not
// available on Kevin's plan, so these PDFs reach Adobe through the browser.
describe('make-document', () => {
  it('passes its own selftest', () => {
    const out = execFileSync('node', [DOC, '--selftest'], { encoding: 'utf8' });
    expect(out).not.toContain('FAIL ');
    expect(out).toMatch(/\d+\/\d+ passed/);
  });

  it('refuses a document that still carries a template placeholder', () => {
    // A document that goes out saying "[Tenant Name]" is worse than no document.
    let threw = false;
    try {
      execFileSync('node', [DOC, '--spec', '-'], {
        input: JSON.stringify({ name: 'x', markdown: 'To [Tenant Name] of [Property address]' }),
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      threw = true;
      expect(String(e.stderr)).toMatch(/unfilled placeholders/);
      expect(String(e.stderr)).toMatch(/\[Tenant Name\]/);
    }
    expect(threw).toBe(true);
  });

  it('refuses a spec with no body', () => {
    let threw = false;
    try {
      execFileSync('node', [DOC, '--spec', '-'], { input: '{"name":"x"}', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { threw = true; expect(String(e.stderr)).toMatch(/`markdown` is required/); }
    expect(threw).toBe(true);
  });
});
