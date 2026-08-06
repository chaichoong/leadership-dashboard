import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The project loads js/ files as plain <script> tags, so there is nothing to import.
// Other specs work round that by pasting a copy of the function into the test, which then
// drifts from the source silently. Instead, pull the real function text out of
// js/reconciliation.js and evaluate it, so this suite always tests the shipped code.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'js/reconciliation.js'), 'utf8');

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in js/reconciliation.js`);
  // Walk braces from the function's opening brace to its matching close.
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`could not parse ${name}`);
  return src.slice(start, end);
}

const reconVendorKey = new Function(`${extract('reconVendorKey')}; return reconVendorKey;`)();

describe('reconVendorKey', () => {
  it('is the real function from js/reconciliation.js', () => {
    expect(typeof reconVendorKey).toBe('function');
  });

  // The bug: per-transaction references were baked into the rule's identity, so each
  // payment minted a fresh single-use rule. These five were one £2 recurring charge with
  // identical category, sub-category and business, stored as five separate rules.
  it('collapses reference numbers so one vendor is one rule', () => {
    const keys = [
      'BRITISH A1252236611488', 'BRITISH A1252236611489', 'BRITISH A1252236611490',
      'BRITISH A1252236611491', 'BRITISH A1252236611492',
    ].map(reconVendorKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('british');
  });

  it('strips store and card numbers, so the same shop matches itself', () => {
    expect(reconVendorKey('ONE STOP 1036')).toBe(reconVendorKey('One Stop'));
    expect(reconVendorKey('ONE STOP 1036')).toBe('one stop');
    expect(reconVendorKey('MCDONALDS 849')).toBe('mcdonalds');
    expect(reconVendorKey('American Express 3773')).toBe('american express');
  });

  it('keeps digits that are part of the name, not a reference', () => {
    // Two digits in a token is a brand ("V12", "57A"); three or more is a reference.
    expect(reconVendorKey('V12 Retail Finance')).toBe('v12 retail finance');
    expect(reconVendorKey('57A WEST STREET')).toBe('57a west street');
  });

  it('strips mixed-character references', () => {
    expect(reconVendorKey('NAMECHEAP.COM 503FA4')).toBe('namecheap com');
  });

  it('spaces punctuation instead of deleting it', () => {
    // The old rule deleted punctuation, turning this into the single blob "amazoncouk".
    expect(reconVendorKey('AMAZON.CO.UK')).toBe('amazon co uk');
  });

  it('never returns empty for an all-reference descriptor', () => {
    // Stripping everything would make the vendor permanently unlearnable, so it falls back.
    const key = reconVendorKey('AMZNMKTPLACE 3E0S44DZ5');
    expect(key.length).toBeGreaterThanOrEqual(3);
  });

  it('is stable across case and spacing', () => {
    expect(reconVendorKey('  Tesco   Stores  ')).toBe(reconVendorKey('TESCO STORES'));
  });

  it('handles empty and null input without throwing', () => {
    expect(reconVendorKey('')).toBe('');
    expect(reconVendorKey(null)).toBe('');
    expect(reconVendorKey(undefined)).toBe('');
  });

  it('caps the key at three tokens', () => {
    expect(reconVendorKey('one two three four five').split(' ')).toHaveLength(3);
  });
});
