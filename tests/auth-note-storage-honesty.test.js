// Finding 20260821-drift-275 (21 Aug 2026): the Strategy page told the user the
// Airtable token was kept "in your browser session only" while authenticate()
// wrote it to localStorage, where it outlives the browser session. compliance.html
// carried the same sentence over the same behaviour. A security statement that
// is false is worse than none, so the note must match what the code does.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const PAGES = [
  { html: 'os/strategy/index.html', js: ['os/strategy/strategy.js'] },
  { html: 'compliance.html', js: [] },
];

const PAT_TO_LOCAL = /localStorage\.setItem\(\s*['"](?:_dlr_pat|airtable_pat)['"]/;

describe('the auth note tells the truth about where the token is kept', () => {
  for (const p of PAGES) {
    it(p.html, () => {
      const html = readFileSync(join(ROOT, p.html), 'utf8');
      const code = [html, ...p.js.map((f) => readFileSync(join(ROOT, f), 'utf8'))].join('\n');
      const note = (html.match(/class="auth-note">([^<]*)</) || [])[1];
      expect(note, 'auth note present').toBeTruthy();
      // Control: this page really does persist the token, so the check is live.
      expect(PAT_TO_LOCAL.test(code)).toBe(true);
      expect(note).not.toMatch(/session only/i);
    });
  }
});
