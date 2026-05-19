import { describe, it, expect } from 'vitest';

// Pure functions extracted from js/shared.js for testing.
// These are copied here because the project uses global <script> tags,
// not ES modules. As the project migrates to modules, these will import directly.

function escJs(str) {
  if (str == null) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function getField(rec, fieldId) {
  return rec.fields?.[fieldId];
}

describe('escJs', () => {
  it('returns empty string for null', () => {
    expect(escJs(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(escJs(undefined)).toBe('');
  });

  it('escapes backslashes', () => {
    expect(escJs('a\\b')).toBe('a\\\\b');
  });

  it('escapes single quotes', () => {
    expect(escJs("it's")).toBe("it\\'s");
  });

  it('escapes double quotes', () => {
    expect(escJs('say "hello"')).toBe('say \\"hello\\"');
  });

  it('escapes newlines', () => {
    expect(escJs('line1\nline2')).toBe('line1\\nline2');
  });

  it('escapes carriage returns', () => {
    expect(escJs('line1\rline2')).toBe('line1\\rline2');
  });

  it('passes through safe strings unchanged', () => {
    expect(escJs('hello world')).toBe('hello world');
  });
});

describe('getField', () => {
  it('returns field value from record', () => {
    const rec = { fields: { Name: 'Test Tenant' } };
    expect(getField(rec, 'Name')).toBe('Test Tenant');
  });

  it('returns undefined for missing field', () => {
    const rec = { fields: { Name: 'Test' } };
    expect(getField(rec, 'Email')).toBeUndefined();
  });

  it('returns undefined when fields is missing', () => {
    const rec = {};
    expect(getField(rec, 'Name')).toBeUndefined();
  });

  it('returns undefined for null record', () => {
    // Production getField uses rec.fields?. which throws on null rec.
    // This test documents that behaviour. If getField is hardened to
    // rec?.fields?.[fieldId], this test should be updated.
    expect(() => getField(null, 'Name')).toThrow();
  });

  it('handles array field values', () => {
    const rec = { fields: { Tags: ['rent', 'overdue'] } };
    expect(getField(rec, 'Tags')).toEqual(['rent', 'overdue']);
  });
});
