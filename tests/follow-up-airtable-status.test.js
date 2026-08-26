// The Settings panel's Airtable line must report what Airtable says.
//
// Found 26 Aug 2026: it printed "Connected - Tasks will auto-create when
// emails move to label 8" whenever ANY non-empty string sat in localStorage.
// Kevin pasted a token from the wrong one of his ~23 PATs; Airtable rejected
// every call with 401, the three task-creation health checks went red, and
// this line sat directly above them still saying Connected.
//
// The real source is extracted and evaluated so this cannot pass against a
// stale copy.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../follow-up.html'), 'utf8');

function extractFn(signature, name) {
  const start = SRC.indexOf(signature);
  if (start === -1) throw new Error(`${name} not found`);
  let depth = 0, end = -1;
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return SRC.slice(start, end);
}

function run({ pat, response }) {
  const el = { innerHTML: '' };
  let requested = null;
  const fn = new Function('document', 'localStorage', 'fetch', 'escapeHtml',
    `${extractFn('function updateAirtableStatus()', 'updateAirtableStatus')}; return updateAirtableStatus;`)(
    { getElementById: () => el },
    { getItem: () => pat },
    (url, opts) => { requested = { url, auth: opts.headers.Authorization }; return response; },
    (s) => String(s),
  );
  fn();
  return { el, requested };
}

describe('the Airtable line in Settings reports what Airtable says', () => {
  it('says Connected only after Airtable accepts the token', async () => {
    const { el, requested } = run({ pat: 'patGOOD', response: Promise.resolve({ ok: true, status: 200 }) });
    expect(requested.url).toContain('/meta/whoami');   // validated, not assumed
    expect(requested.auth).toBe('Bearer patGOOD');
    await new Promise(r => setTimeout(r, 0));
    expect(el.innerHTML).toContain('Connected');
  });

  it('THE REGRESSION: a rejected token never reads as Connected', async () => {
    const { el } = run({ pat: 'patDEAD', response: Promise.resolve({ ok: false, status: 401 }) });
    await new Promise(r => setTimeout(r, 0));
    expect(el.innerHTML).not.toContain('Connected');
    expect(el.innerHTML).toContain('401');
    expect(el.innerHTML).toMatch(/will NOT auto-create/);
  });

  it('an unreachable Airtable reads as unknown, never as working', async () => {
    const { el } = run({ pat: 'patX', response: Promise.reject(new Error('offline')) });
    await new Promise(r => setTimeout(r, 0));
    expect(el.innerHTML).not.toContain('Connected');
    expect(el.innerHTML).toContain('Could not reach Airtable');
  });

  it('no token still reads as not configured, and asks Airtable nothing', () => {
    const { el, requested } = run({ pat: '', response: Promise.resolve({ ok: true, status: 200 }) });
    expect(requested).toBeNull();
    expect(el.innerHTML).toContain('Not configured');
  });

  it('saving re-validates, so the line answers the token just entered', () => {
    const save = extractFn('function saveSettings()', 'saveSettings');
    expect(save).toContain('updateAirtableStatus()');
  });
});
