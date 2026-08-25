import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(resolve(ROOT, 'os/agents/index.html'), 'utf8');

// The AI Agents page's Duplicates lane keys open tasks by dupeTaskKey so
// "Chase Acme invoice #2" and "Chase Acme invoice #3" collide. The token
// rules follow the reconciliation vendor-key lesson (Known Anti-Patterns:
// per-transaction references baked into a key mean nothing ever gets a
// second hit). Extract the REAL function from the page source — a copied
// implementation here would let the page drift while the test stays green
// (the recon-vendor-key.test.js rule).

function loadDupeTaskKey() {
  const m = SRC.match(/function dupeTaskKey\([\s\S]*?\n\}/);
  if (!m) throw new Error('dupeTaskKey not found in os/agents/index.html');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}; return dupeTaskKey;`)();
}

describe('dupeTaskKey — one subject, one key', () => {
  const key = loadDupeTaskKey();

  it('exists in the page source (control)', () => {
    expect(typeof key).toBe('function');
  });

  it('collides the same job carrying different reference numbers', () => {
    expect(key('Chase Acme invoice #2')).toBe(key('Chase Acme invoice #3'));
    expect(key('Reply to British Gas a1252236611488')).toBe(key('Reply to British Gas a1252236611492'));
  });

  it('drops pure numbers and long references, keeps short brand digits', () => {
    expect(key('Renew v12 licence')).toContain('v12');       // two digits = a brand
    expect(key('Pay ref 4471902')).not.toContain('4471902'); // pure digits = reference
    expect(key('Close a1252236611488')).toBe('close');       // letters + 3+ digits = reference
  });

  it('different subjects stay apart', () => {
    expect(key('Chase Acme invoice')).not.toBe(key('Chase Beta invoice'));
  });

  it('a blank or reference-only name yields an empty key, which the lane skips', () => {
    expect(key('')).toBe('');
    expect(key('#12345')).toBe('');
  });
});
