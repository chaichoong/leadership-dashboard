import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// These run against the REAL js/shared.js, not a copy. A copy passes whatever
// the real code does, so an edit that broke escaping would ship green.
//
// shared.js is a plain <script> with side effects at load: it registers
// listeners on window and document, starts two timers, and checks
// document.readyState. The stubs below cover exactly that. readyState is
// 'loading' so the DOM-bound init (_opsDirectorInit, restoreSidebarSectionState)
// is deferred to a DOMContentLoaded that never fires here. If shared.js gains a
// new load-time dependency, runInContext throws and every test fails loudly.
function loadShared() {
  const noop = () => {};
  const store = new Map();
  const sandbox = {
    window: { addEventListener: noop },
    document: { readyState: 'loading', addEventListener: noop },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    setTimeout: noop,
    setInterval: noop,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(resolve(ROOT, 'js/shared.js'), 'utf8'), sandbox, { filename: 'js/shared.js' });
  // Top-level function declarations become properties of the context object.
  return sandbox;
}

const { escJs, escHtml, getField } = loadShared();

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

describe('escHtml', () => {
  it('returns empty string for null and undefined', () => {
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
  });

  it('keeps zero rather than blanking it', () => {
    expect(escHtml(0)).toBe('0');
  });

  it('escapes a script tag', () => {
    expect(escHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes both quote kinds so attribute values are safe', () => {
    expect(escHtml(`" onmouseover='x'`)).toBe('&quot; onmouseover=&#39;x&#39;');
  });

  it('escapes ampersands first, so it never double-escapes its own output', () => {
    expect(escHtml('Tom & Jerry <b>')).toBe('Tom &amp; Jerry &lt;b&gt;');
  });

  it('passes through safe strings unchanged', () => {
    expect(escHtml('hello world')).toBe('hello world');
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
    expect(getField(null, 'Name')).toBeUndefined();
  });

  it('returns undefined for undefined record (missed lookup)', () => {
    // The crash behind "Couldn't load your dashboard" on a fresh Supabase
    // client: accounts is empty, so accounts.find(...) is undefined and the
    // dashboard calls getField(undefined, F.accGBP). Must not throw.
    const accounts = [];
    const santanderRec = accounts.find(r => r.id === 'recSantander'); // undefined
    expect(getField(santanderRec, 'GBP')).toBeUndefined();
  });

  it('handles array field values', () => {
    const rec = { fields: { Tags: ['rent', 'overdue'] } };
    expect(getField(rec, 'Tags')).toEqual(['rent', 'overdue']);
  });
});
