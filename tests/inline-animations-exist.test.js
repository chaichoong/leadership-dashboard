// An inline `animation:<name>` that names no @keyframes does nothing, silently, and it
// also OVERRIDES any animation the element's class gave it. js/pnl.js set
// `animation:blink` on the P&L "Analysing" dots, no `blink` keyframes existed anywhere,
// so the dots sat still from the day they shipped until 18 Nov 2026. No error, no log.
// This scans every shell script for inline animation names and fails on one that no
// stylesheet, page or script defines.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const list = (dir, ext) => readdirSync(join(root, dir)).filter((f) => f.endsWith(ext)).map((f) => join(dir, f));
const read = (f) => readFileSync(join(root, f), 'utf8');

const sources = [...list('css', '.css'), ...list('.', '.html'), ...list('js', '.js')];
const defined = new Set(sources.flatMap((f) => [...read(f).matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])));
const KEYWORDS = new Set(['none', 'inherit', 'initial', 'unset', 'revert']);

const uses = list('js', '.js').flatMap((f) =>
  read(f).split('\n').flatMap((line, i) =>
    [...line.matchAll(/animation(?:-name)?\s*:\s*([a-zA-Z][\w-]*)/g)]
      .map((m) => m[1])
      .filter((n) => !KEYWORDS.has(n))
      .map((name) => ({ at: `${f}:${i + 1}`, name }))));

describe('inline animations name keyframes that exist', () => {
  it('the scan finds keyframes and inline uses (control)', () => {
    // If either regex stops matching, the check below passes on nothing.
    expect(defined.has('ai-bounce')).toBe(true);
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });

  it('every inline animation in js/ names a defined @keyframes', () => {
    expect(uses.filter((u) => !defined.has(u.name)).map((u) => `${u.at} ${u.name}`)).toEqual([]);
  });

  it('the P&L loading dots take the bounce from their class', () => {
    const pnl = read('js/pnl.js');
    expect(pnl).toContain('<div class="ai-typing-dot"></div><div class="ai-typing-dot"></div><div class="ai-typing-dot"></div>');
    expect(read('css/styles.css')).toMatch(/\.ai-typing-dot \{[^}]*animation: ai-bounce/);
  });
});
