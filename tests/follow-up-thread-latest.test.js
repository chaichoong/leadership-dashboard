// Inbound Comms: a thread must show where the conversation IS, and one
// reader for a field that can hold several thread URLs.
//
// Two bugs, both found 26 Aug 2026:
//
//  1. parseThread built the card from messages[0] — the OLDEST message. A
//     creditor's third reply rendered as the original sender and the
//     original preview, so the card said something the thread stopped
//     saying days ago.
//
//  2. Inbound Note URL Link can hold MORE THAN ONE Gmail URL, because the
//     create-time duplicate gate appends a folded thread's URL
//     (scripts/create-agent-task.py build_update). Two of the three readers
//     in this file were $-anchored and saw only the LAST url, so the other
//     thread's email showed as having no task and no assignee — inviting
//     exactly the duplicate the gate exists to prevent.
//
// The real source is extracted and evaluated (the follow-up-init-errors
// pattern) so this can never pass against a stale copy.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../follow-up.html'), 'utf8');

function extractFn(signature, name) {
  const start = SRC.indexOf(signature);
  if (start === -1) throw new Error(`${name} not found in follow-up.html`);
  // Walk braces from the first { after the signature.
  let i = SRC.indexOf('{', start), depth = 0, end = -1;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return SRC.slice(start, end);
}

const inboundThreadIds = new Function(
  extractFn('function inboundThreadIds(url)', 'inboundThreadIds') + '; return inboundThreadIds;')();

// parseThread leans on three helpers defined elsewhere in the page; stub
// them so the thread logic itself is what is under test.
const parseThread = new Function(`
  const extractBody = () => ({ text: '', isHtml: false, attachments: [], inlineImages: [] });
  const cleanFrom = f => f;
  const extractEmail = f => (String(f).match(/<([^>]+)>/) || [null, f])[1];
  ${extractFn('function parseThread(thread)', 'parseThread')}
  return parseThread;`)();

const msg = (from, snippet, dateMs, extra = {}) => ({
  id: 'm' + dateMs,
  internalDate: String(dateMs),
  snippet,
  payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: 'Overdue account' },
    ...(extra.headers || [])] },
});

describe('inboundThreadIds — one reader for a multi-URL field', () => {
  it('reads BOTH threads out of a folded task (the bug)', () => {
    expect(inboundThreadIds(
      'https://mail.google.com/mail/u/0/#all/1a0373a0fec1897c https://mail.google.com/mail/u/0/#all/1a02ac3541a86728'
    )).toEqual(['1a0373a0fec1897c', '1a02ac3541a86728']);
  });

  it('still reads a single url, and the legacy #inbox/ form', () => {
    expect(inboundThreadIds('https://mail.google.com/mail/u/0/#all/19f3c53')).toEqual(['19f3c53']);
    expect(inboundThreadIds('https://mail.google.com/mail/u/0/#inbox/187abc')).toEqual(['187abc']);
  });

  it('returns nothing for the non-Gmail shapes the field also holds', () => {
    expect(inboundThreadIds('imessage:259F4464-838C-F860')).toEqual([]);
    expect(inboundThreadIds('')).toEqual([]);
    expect(inboundThreadIds(null)).toEqual([]);
  });

  it('no $-anchored thread regex survives anywhere in the page (control)', () => {
    // The exact shape of bug 2. It must not come back in a fourth reader.
    expect(SRC).not.toMatch(/#\(\?:inbox\|all\)\\\/\(\[a-f0-9\]\+\)\$/);
    // And every reader goes through the one helper.
    expect(SRC.match(/inboundThreadIds\(/g).length).toBeGreaterThanOrEqual(4);
  });
});

describe('parseThread — the newest message is the one that shows', () => {
  it('shows the newest reply’s sender and preview, not the first message’s', () => {
    const e = parseThread({ id: 'th1', messages: [
      msg('Creditor Ltd <a@creditor.co.uk>', 'Original demand for £400.', 1_000_000),
      msg('Creditor Ltd <a@creditor.co.uk>', 'Second notice, now £450.', 2_000_000),
      msg('Enforcement <legal@creditor.co.uk>', 'Final notice before enforcement.', 3_000_000),
    ] });
    expect(e.snippet).toBe('Final notice before enforcement.');
    expect(e.from).toBe('Enforcement <legal@creditor.co.uk>');
    expect(e.fromEmail).toBe('legal@creditor.co.uk');
    expect(e.messageCount).toBe(3);
    expect(e.subject).toBe('Overdue account'); // thread subject stays the thread's
  });

  it('never resolves the sender to Kevin when he replied last', () => {
    // from/fromEmail also become a created task's Inbound Sender and the
    // unsubscribe key, and the duplicate gate folds on sender — Kevin's own
    // address there would poison all three.
    const e = parseThread({ id: 'th2', messages: [
      msg('Creditor Ltd <a@creditor.co.uk>', 'Original demand.', 1_000_000),
      msg('Kevin Brittain <kevin@runpreneur.org.uk>', 'My reply, holding position.', 2_000_000),
    ] });
    expect(e.fromEmail).toBe('a@creditor.co.uk');
    expect(e.from).toBe('Creditor Ltd <a@creditor.co.uk>');
    // The preview still shows where the thread actually stands.
    expect(e.snippet).toBe('My reply, holding position.');
  });

  it('a single-message thread is unchanged', () => {
    const e = parseThread({ id: 'th3', messages: [
      msg('Solo <s@x.com>', 'Only message.', 1_000_000),
    ] });
    expect(e.from).toBe('Solo <s@x.com>');
    expect(e.snippet).toBe('Only message.');
    expect(e.messageCount).toBe(1);
  });

  it('an all-Kevin thread falls back to the first message rather than blanking', () => {
    const e = parseThread({ id: 'th4', messages: [
      msg('Kevin Brittain <kevin@runpreneur.org.uk>', 'Opening note.', 1_000_000),
      msg('Kevin Brittain <kevin@runpreneur.org.uk>', 'Chasing myself.', 2_000_000),
    ] });
    expect(e.from).toBe('Kevin Brittain <kevin@runpreneur.org.uk>');
    expect(e.snippet).toBe('Chasing myself.');
  });

  it('reply-to still prefers an explicit Reply-To header on the first message', () => {
    const e = parseThread({ id: 'th5', messages: [
      msg('Bridge <noreply@bridge.io>', 'Bridged in.', 1_000_000,
        { headers: [{ name: 'Reply-To', value: 'real@person.com' }] }),
      msg('Bridge <noreply@bridge.io>', 'Second bridged message.', 2_000_000),
    ] });
    expect(e.replyTo).toBe('real@person.com');
  });
});

// ── The guards the review found, each verified against live records ─────
// Reading EVERY url off a task (the fix above) makes a folded consolidation
// speak for its folded-in threads too. That is right for showing work and
// dangerous for filing it away, so each consumer needed its own rule.

const FIELDS = { isInbound: 'fldIsInbound', status: 'fldStatus', noteUrl: 'fldXf1p0vtHqOZcKl', taskName: 'fldName', assignee: 'fldAssignee' };

function buildAsync(signature, name, deps) {
  const body = extractFn(signature, name);
  const names = Object.keys(deps);
  return new Function(...names, `${body}; return ${name};`)(...names.map(n => deps[n]));
}

describe('a completed consolidation never files away a thread that is still open', () => {
  // Verified live 26 Aug 2026: completed recI2fF4sflvYdAq4 (folded, two
  // threads) and OPEN Approval recWhPiKKpr4OUPoQ both claim thread
  // 1a0383d003d2b53a. Without this guard the sweep strips label 12 and files
  // that Utilita creditor email as answered while Kevin still owes it a
  // decision.
  const OPEN_THREAD = '1a0383d003d2b53a', DONE_THREAD = '1a0192b8d9003c74';

  const makeFn = (stillOpenIds) => buildAsync(
    'async function fetchCompletedInboundThreadIds()', 'fetchCompletedInboundThreadIds', {
      getAirtablePat: () => 'pat_x',
      getAirtableBaseId: () => 'appX',
      getAirtableTableId: () => 'tblX',
      AIRTABLE_FIELDS: FIELDS,
      inboundThreadIds,
      fetchActiveInboundTaskAssignees: async () => new Map(stillOpenIds.map(i => [i, { id: 'recOpen' }])),
      fetch: async () => ({ ok: true, json: async () => ({ records: [{ id: 'recDone', fields: {
        [FIELDS.noteUrl]: `https://mail.google.com/mail/u/0/#all/${OPEN_THREAD} https://mail.google.com/mail/u/0/#all/${DONE_THREAD}`,
        [FIELDS.taskName]: 'INBOUND: UTILITA payment reminder' } }] }) }),
    });

  it('drops the thread an open task still claims, and keeps the genuinely finished one', async () => {
    const map = await makeFn([OPEN_THREAD])();
    expect(map.has(OPEN_THREAD)).toBe(false);
    expect(map.get(DONE_THREAD)).toBe('INBOUND: UTILITA payment reminder');
  });

  it('with nothing open, BOTH folded threads count as answered (the fix still works)', async () => {
    const map = await makeFn([])();
    expect([...map.keys()].sort()).toEqual([DONE_THREAD, OPEN_THREAD].sort());
  });
});

describe('two open tasks claiming one thread: first claim wins, deterministically', () => {
  // Live: threads 1a02ac3541a86728 and 1a039a3f9cba9a0c are each claimed by
  // two tasks. This map drives label moves and an Assignee PATCH, so a
  // last-write-wins race acts on whichever record Airtable happened to
  // return last.
  const fn = buildAsync('async function fetchActiveInboundTaskAssignees()', 'fetchActiveInboundTaskAssignees', {
    getAirtablePat: () => 'pat_x',
    getAirtableBaseId: () => 'appX',
    getAirtableTableId: () => 'tblX',
    AIRTABLE_FIELDS: FIELDS,
    AIRTABLE_TEAM_MEMBER_FIELD: 'fldTeam',
    AIRTABLE_APPROVER_FIELD: 'fldApprover',
    inboundThreadIds,
    fetch: async () => ({ ok: true, json: async () => ({ records: [
      { id: 'recFirst', fields: { [FIELDS.noteUrl]: 'https://mail.google.com/mail/u/0/#all/aaa111', [FIELDS.taskName]: 'First claim' } },
      { id: 'recSecond', fields: { [FIELDS.noteUrl]: 'https://mail.google.com/mail/u/0/#all/aaa111', [FIELDS.taskName]: 'Second claim' } },
    ] }) }),
  });

  it('does not let the later record silently overwrite the earlier one', async () => {
    const map = await fn();
    expect(map.get('aaa111').taskName).toBe('First claim');
  });

  it('excludes Cancelled tasks from claiming a thread at all', () => {
    const src = extractFn('async function fetchActiveInboundTaskAssignees()', 'fetchActiveInboundTaskAssignees');
    expect(src).toMatch(/!= "Cancelled"/);
  });
});

describe('the duplicate-cleanup tool', () => {
  it('groups under every thread a task claims, and never deletes a consolidation', () => {
    // Drift guard on the two rules: a folded task must still be GROUPED (so
    // its twin is reported) but must never end up in `dupes` (deleting it
    // would drop its other thread's only task).
    const whole = SRC.slice(SRC.indexOf('const threadGroups = new Map()'), SRC.indexOf('if (toDelete.length === 0)'));
    expect(whole).toMatch(/for \(const threadId of ids\)/);
    expect(whole).toMatch(/\.filter\(r => inboundThreadIds\([^)]*\)\.length === 1\)/);
  });
});

describe('the e-sign gate reads the thread, not the newest replier', () => {
  const looksLikeSignedTenancyDoc = new Function(`
    ${SRC.match(/const _ESIGN_SENDERS[\s\S]*?\n    \];/)[0]}
    ${SRC.match(/const _TENANCY_SUBJECT_PATTERNS[\s\S]*?\n    \];/)[0]}
    ${SRC.match(/const _TENANCY_SUBJECT_EXCLUSIONS[\s\S]*?\n    \];/)[0]}
    ${SRC.match(/const _ADOBE_SIGN_COMPLETION = [^;]+;/)[0]}
    ${SRC.match(/const _OTHER_PLATFORM_COMPLETION_PATTERNS[\s\S]*?\n    \];/)[0]}
    ${SRC.match(/const _INTERMEDIATE_PATTERNS[\s\S]*?\n    \];/)[0]}
    ${extractFn('function looksLikeSignedTenancyDoc(email)', 'looksLikeSignedTenancyDoc')}
    return looksLikeSignedTenancyDoc;`)();

  const signed = {
    subject: 'Signed and Filed: Tenancy Agreement - 12 High St',
    fromEmail: 'echosign@adobesign.com',
    messages: [{ from: 'Adobe Sign <echosign@adobesign.com>' }],
  };

  it('still recognises a signed tenancy agreement', () => {
    expect(looksLikeSignedTenancyDoc(signed)).toBe(true);
  });

  it('still recognises it after a tenant replies into the thread', () => {
    // parseThread now reports the newest sender, so fromEmail is the tenant.
    // The AST would otherwise never be filed against the tenancy, silently,
    // on every sweep.
    expect(looksLikeSignedTenancyDoc({
      ...signed,
      fromEmail: 'tenant@example.com',
      messages: [{ from: 'Adobe Sign <echosign@adobesign.com>' }, { from: 'Tenant <tenant@example.com>' }],
    })).toBe(true);
  });

  it('does not fire for a thread no e-sign platform ever touched', () => {
    expect(looksLikeSignedTenancyDoc({
      ...signed, fromEmail: 'tenant@example.com', messages: [{ from: 'Tenant <tenant@example.com>' }],
    })).toBe(false);
  });
});
