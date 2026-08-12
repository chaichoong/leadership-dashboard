// PECR: an unsolicited marketing email is lawful to a corporate subscriber and
// not to a sole trader. sop-prospecting.html calls that a hard rule and heads
// the section "enforced in the pipeline". It was not enforced anywhere.
//
// Two findings from the 12 Aug 2026 drift sweep, and they hid each other:
//
//   20260812-drift-095  sendProspectEmailViaGHL never read Entity Type. The only
//                       abort was a missing address. Entity Type was read once
//                       in the whole file, to pick a GHL tag. So the gate was a
//                       field the agent wrote about its own work, and a Sole
//                       Trader routed as "Email sequence (Ltd)" was cold-emailed
//                       the moment Kevin clicked Approve.
//
//   20260812-drift-096  the health check that was supposed to catch that
//                       inspected 'In Sequence' and 'Replied'. Nothing in the
//                       file has ever written 'In Sequence'; the send path
//                       writes 'Contacted (1:1)'. The red alert could not fire,
//                       and passed for the wrong reason every day.
//
// Both real functions are pulled out of the source and run, rather than
// re-described here — a copy would go on passing after the shipped code changed.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'js/prospecting.js'), 'utf8');

// End index (exclusive) of the balanced { … } block that starts at or after `from`.
function braceEnd(from) {
  let i = src.indexOf('{', from), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('unbalanced braces');
}

function extractFn(name) {
  let start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in js/prospecting.js`);
  // Keep a leading `async`. Slicing from `function` alone drops it, and the
  // extracted body then fails to parse on its own awaits — a failure that
  // looks like a broken test rather than the missing keyword it is.
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  return src.slice(start, braceEnd(start));
}

// ── The send path ───────────────────────────────────────────────────────────

function runSend(fields) {
  const calls = { fetches: [], patches: [], toasts: [] };
  const harness = new Function(`
    const calls = arguments[0];
    ${extractFn('prosField')}
    ${extractFn('prosIsEmailRoute')}
    const PROS_EMAIL_ROUTES = ${JSON.stringify(['Email sequence (Ltd)', 'Email reply (they asked)'])};
    const showToast = (msg) => calls.toasts.push(msg);
    const buildProspectEmail = () => ({ subject: 's', html: '<p>b</p>', from: 'a@b.com' });
    const patchProspectingRecord = async (...a) => { calls.patches.push(a); };
    const renderProspectingTab = () => {};
    const PROSPECT = { status: 'fldS', nextFollowUp: 'fldF' };
    const TABLES = { prospects: 'tblP' };
    const fetch = async (url, opts) => {
      calls.fetches.push({ url, opts });
      return { ok: true, json: async () => ({}) };
    };
    ${extractFn('sendProspectEmailViaGHL')}
    return sendProspectEmailViaGHL;
  `)(calls);

  return harness({ id: 'recP', fields }, 'ghlContact', 'key', 'loc').then(() => calls);
}

const LTD = {
  'Entity Type': 'Limited Company',
  'Contact Route': 'Email sequence (Ltd)',
  'Draft Message': 'Hi there, saw your post about drowning in admin.',
};

describe('prospect send path enforces the PECR entity rule (095)', () => {
  it('sends to a Limited Company', async () => {
    const calls = await runSend(LTD);
    expect(calls.fetches.length, 'a Limited Company was not emailed').toBe(1);
    expect(calls.fetches[0].url).toContain('conversations/messages');
  });

  it('refuses a Sole Trader even when the agent routed it as an email', async () => {
    const calls = await runSend({ ...LTD, 'Entity Type': 'Sole Trader' });
    expect(calls.fetches, 'a sole trader was cold-emailed').toEqual([]);
    expect(calls.patches, 'a refused send still wrote a Contacted status').toEqual([]);
    expect(calls.toasts.join(' ')).toMatch(/Sole Trader/);
  });

  it('refuses an unknown or blank entity type — uncertain is never emailed', async () => {
    for (const entity of ['', 'Unknown', 'Partnership', 'LLP']) {
      const calls = await runSend({ ...LTD, 'Entity Type': entity });
      expect(calls.fetches, `emailed a prospect whose entity type was "${entity}"`).toEqual([]);
    }
  });

  it('still refuses while the booking-link placeholder is unreplaced', async () => {
    const calls = await runSend({ ...LTD, 'Draft Message': 'Book here: [BOOKING-LINK]' });
    expect(calls.fetches).toEqual([]);
  });
});

// ── The health check ────────────────────────────────────────────────────────

function pecrCheck() {
  const marker = src.indexOf("name: 'PECR gate:");
  if (marker === -1) throw new Error('the PECR health check has been renamed or removed');
  const runAt = src.indexOf('run: () =>', marker);
  const bodyStart = src.indexOf('{', runAt);
  const body = src.slice(bodyStart, braceEnd(runAt));
  return new Function('records', 'prosStatus', 'prosField', `return (() => ${body})();`);
}

function check(records) {
  const fn = pecrCheck();
  const prosField = (rec, name) => (rec.fields && rec.fields[name]) || '';
  const prosStatus = (rec) => prosField(rec, 'Status') || 'Found';
  return fn(records, prosStatus, prosField);
}

const rec = (Status, entity) => ({ fields: { Status, 'Entity Type': entity } });

describe('PECR health check sees the status the send path writes (096)', () => {
  it('fails on a non-Ltd at Contacted (1:1) — the status that was invisible', () => {
    const r = check([rec('Contacted (1:1)', 'Sole Trader'), rec('Contacted (1:1)', 'Limited Company')]);
    expect(r.status, 'the breach status is still not inspected').toBe('fail');
    expect(r.detail).toMatch(/1 non-Ltd/);
  });

  it('passes when everyone contacted is a Limited Company', () => {
    const r = check([rec('Contacted (1:1)', 'Limited Company'), rec('Replied', 'Limited Company')]);
    expect(r.status).toBe('pass');
  });

  it('does not flag a LinkedIn connect to a sole trader — PECR does not govern it', () => {
    // A check that cries wolf on lawful manual outreach is a check that gets
    // ignored, and this one is the last line before a regulator.
    const r = check([rec('Connect Sent', 'Sole Trader'), rec('Contacted (1:1)', 'Limited Company')]);
    expect(r.status).toBe('pass');
  });

  it('warns rather than fails on a downstream status that either channel reaches', () => {
    const r = check([rec('No Response', 'Sole Trader'), rec('Contacted (1:1)', 'Limited Company')]);
    expect(r.status).toBe('warn');
  });

  it('fails loudly when its status list matches nothing but prospects moved past Approved', () => {
    // The control. A list matching zero records reads as a clean gate for ever,
    // which is exactly how the old one survived.
    const r = check([rec('Some New Status', 'Sole Trader')]);
    expect(r.status, 'a blind gate reported clean').toBe('fail');
    expect(r.detail).toMatch(/blind/);
  });

  it('says so plainly when nobody has been contacted at all', () => {
    const r = check([rec('Ready for Review', 'Sole Trader'), rec('Approved', 'Limited Company')]);
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/never been exercised/);
  });
});
