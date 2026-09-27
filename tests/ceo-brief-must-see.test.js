import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = readFileSync(resolve(ROOT, 'scripts/slack-automation/money-daily-worker.js'), 'utf8');

// What Kevin must see in the 09:00 brief whatever the model says (Kevin, 23 Sep 2026: "build it").
// That morning a legal deadline due the same day had waited in a 155-card approval queue since
// 26 Aug; the brief never named it and the 07:00 check that did wrote only to
// a file. The functions are read out of the worker as text, the same approach as the other
// ceo-brief tests, so these run the shipped code.
function pick(n) {
  const m = WORKER.match(new RegExp(`\\n(?:async )?function ${n}\\([\\s\\S]*?\\n\\}`))
    || WORKER.match(new RegExp(`\\nconst ${n} = [^\\n]*;`));
  if (!m) throw new Error(`${n} not found in money-daily-worker.js`);
  return m[0];
}
const HELPERS = ['KEVIN_TEAM_MEMBER', 'ROY_TEAM_MEMBER', 'ONLY_YOU_SHOW', 'MONTHS', 'dayMonth', 'whenText',
  'slackEsc', 'selectOnlyYou', 'onlyYouText', 'DEADLINE_DAYS', 'DEADLINE_SHOW', 'LEGAL_RE', 'MONEY_RE',
  'addDaysISO', 'deadlineHolder', 'selectDeadlines', 'deadlinesText', 'NEEDS_YOU_SHOW', 'needsYouText',
  'deadlinePreview', 'SECTION_MAX', 'capSection', 'TENANT_LIGHT', 'tenantChainText', 'mustSeeBlocks', 'fmt', 'LIGHT_EMOJI', 'LIGHT_LABEL', 'londonDateLabel', 'buildBlocks',
  'buildBriefBlocks'];
// eslint-disable-next-line no-new-func
const W = new Function(`${HELPERS.map(pick).join('\n')}\nreturn { ${HELPERS.join(', ')} };`)();
const { selectDeadlines, deadlinesText, needsYouText, deadlinePreview, mustSeeBlocks, buildBriefBlocks,
  selectOnlyYou, KEVIN_TEAM_MEMBER, ROY_TEAM_MEMBER, tenantChainText } = W;

const TODAY = '2026-09-23';
let n = 0;
// inQueue mirrors gatherTasks: Status Approval AND raised by the loop.
const task = (name, due, extra = {}) => ({ id: `rec${++n}`, name, due, hard: true, holders: [], who: 'unassigned',
  status: 'Today', deferred: '', someDay: false, inQueue: extra.status === 'Approval', ...extra });

// The shape of the hard-deadline tasks open on 23-24 Sep 2026 (Tasks tblqB8b22hKBL4PF1), with
// every name, address and amount replaced: this repo is public.
const LIVE = [
  task('INBOUND: Final court notice 50000 over 1 Example Road', TODAY, { status: 'Approval', holders: [KEVIN_TEAM_MEMBER] }),
  task('INBOUND: respond to court order Jo Example X00XX000 GBP 1000 costs', '2026-06-03', { status: 'Approval', deferred: '2026-09-23' }),
  task('MAINTENANCE: pest warning re-inspection 2 Example Street', '2026-08-30', { holders: [ROY_TEAM_MEMBER] }),
  task('COMPLIANCE: Property Owners Insurance renewal due 3 Oct 2026 - Example Insurer', '2026-09-17', { status: 'Approval' }),
  task('INBOUND: Example Bank card statement - minimum GBP5.16 due 3 Oct 2026', '2026-09-18', { status: 'Approval' }),
  task('POST: UNILATERAL NOTICE- 3EX', TODAY, { holders: ['recAgentXXXXXXXXX'] }),
  task('Lender arrears top up payments', TODAY, { holders: [KEVIN_TEAM_MEMBER] }),
  task('UC verification: Pat Example, £500.00 due 2 October 2026', TODAY),
  task('Send the first batch of papers by 9 Oct', '2026-09-30'),
  task('Update Master Prompt', '2026-10-03', { status: 'Approval' }),
];

describe('selectDeadlines: every hard deadline in the next seven days, whoever holds it', () => {
  const out = selectDeadlines(LIVE, TODAY);
  const names = out.all.map(x => x.name);

  it('the two legal items waiting in the queue lead: the overdue court order, then the court notice due today', () => {
    expect(out.items[0].name).toMatch(/court order Jo Example/);
    expect(out.items[1].name).toMatch(/Final court notice/);
    expect(out.items[1].who).toBe('waiting in your approval queue');
  });

  it('a task nobody holds says NO OWNER', () => {
    expect(out.all.find(x => /first batch of papers/.test(x.name)).who).toBe('NO OWNER');
  });

  it('names who holds each one: Kevin, Roy, an agent', () => {
    expect(out.all.find(x => /Lender arrears/.test(x.name)).who).toBe('yours');
    expect(out.all.find(x => /pest warning/.test(x.name)).who).toBe('with Roy');
    expect(out.all.find(x => /UNILATERAL/.test(x.name)).who).toBe('with an AI agent');
  });

  it('overdue and due-today come first, legal before money before the rest within each', () => {
    const now = out.all.filter(x => x.due <= TODAY);
    const later = out.all.filter(x => x.due > TODAY);
    expect(out.all.slice(0, now.length)).toEqual(now);
    expect(now.map(x => x.kind)).toEqual([...now.map(x => x.kind)].sort((a, b) => a - b));
    expect(later.map(x => x.kind)).toEqual([...later.map(x => x.kind)].sort((a, b) => a - b));
    expect(now[0].kind).toBe(0);
  });

  it('includes overdue items and a deferral that has run out', () => {
    expect(names).toContain('INBOUND: respond to court order Jo Example X00XX000 GBP 1000 costs');
    expect(names).toContain('MAINTENANCE: pest warning re-inspection 2 Example Street');
  });

  it('leaves out the retired UC process and anything past the seven days', () => {
    expect(names.some(x => /^UC verification/.test(x))).toBe(false);
    expect(names).not.toContain('Update Master Prompt');
    expect(selectDeadlines([task('Due in eight days', '2026-10-01')], TODAY).all).toEqual([]);
    expect(selectDeadlines([task('Due in seven days', '2026-09-30')], TODAY).all).toHaveLength(1);
  });

  it('respects a knock-back to a later date', () => {
    expect(selectDeadlines([task('Parked court reply', TODAY, { deferred: '2026-09-24' })], TODAY).all).toEqual([]);
  });

  it('a task without the Hard Deadline tick is not a deadline, whatever its due date', () => {
    expect(selectDeadlines([task('Soft reminder', TODAY, { hard: false })], TODAY).all).toEqual([]);
  });

  it('shows five and counts the rest', () => {
    expect(out.items).toHaveLength(5);
    expect(out.more).toBe(out.all.length - 5);
  });

  it('empty or missing input gives an empty list', () => {
    expect(selectDeadlines([], TODAY)).toEqual({ all: [], items: [], more: 0, ticked: 0 });
    expect(selectDeadlines(undefined, TODAY)).toEqual({ all: [], items: [], more: 0, ticked: 0 });
  });
});

describe('deadlinesText renders the section, and says so when there is nothing', () => {
  it('lines carry when and who, overdue in words', () => {
    const text = deadlinesText(selectDeadlines(LIVE, TODAY), TODAY);
    expect(text.startsWith('*HARD DEADLINES, NEXT 7 DAYS*\n')).toBe(true);
    expect(text).toContain('(due today, waiting in your approval queue)');
    expect(text).toContain('overdue since 3 Jun');
    expect(text).toMatch(/\+\d+ more with a hard deadline this week$/);
  });

  it('an empty week is stated, never silent', () => {
    expect(deadlinesText(selectDeadlines([task('Next month', '2026-11-01')], TODAY), TODAY)).toBe('*HARD DEADLINES, NEXT 7 DAYS:* none.');
  });

  it('CONTROL: no open task carrying the tick at all is a warning, never a calm "none"', () => {
    const text = deadlinesText(selectDeadlines([task('Soft', TODAY, { hard: false })], TODAY), TODAY);
    expect(text).toMatch(/No open task carries the Hard Deadline tick at all/);
  });

  it('a failed read is stated', () => {
    expect(deadlinesText(null, TODAY)).toMatch(/could not be read/);
  });

  it('escapes Slack control characters', () => {
    expect(deadlinesText(selectDeadlines([task('Court <urgent> A&B', TODAY)], TODAY), TODAY))
      .toContain('Court &lt;urgent&gt; A&amp;B');
  });
});

describe('needsYouText: the 07:00 check, or why it is missing', () => {
  const row = payload => ({ fields: { Payload: JSON.stringify(payload) } });

  it('lists today\'s items, numbered', () => {
    const text = needsYouText(row({ date: TODAY, items: ['Decide the legal deadline card.', 'Merge the fix <PR>.'] }), TODAY);
    expect(text).toBe('*FROM THE 07:00 CHECK*\n1. Decide the legal deadline card.\n2. Merge the fix &lt;PR&gt;.');
  });

  it('nothing needed is said in words', () => {
    expect(needsYouText(row({ date: TODAY, items: [] }), TODAY)).toBe('*07:00 CHECK:* nothing needs you.');
  });

  it('yesterday\'s report is never shown as today\'s', () => {
    const text = needsYouText(row({ date: '2026-09-22', items: ['Old item'] }), TODAY);
    expect(text).toMatch(/has not reported this morning/);
    expect(text).toContain('22 Sep');
    expect(text).not.toContain('Old item');
  });

  it('a failed read, a missing row, an unparsed report and a damaged row each say so', () => {
    expect(needsYouText(undefined, TODAY)).toMatch(/could not be read/);
    expect(needsYouText(null, TODAY)).toMatch(/has not reported yet/);
    expect(needsYouText(row({ date: TODAY, unreadable: true }), TODAY)).toMatch(/could not be read/);
    expect(needsYouText({ fields: { Payload: '{broken' } }, TODAY)).toMatch(/damaged/);
  });

  it('caps at five and counts the rest', () => {
    const text = needsYouText(row({ date: TODAY, items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }), TODAY);
    expect(text.split('\n').filter(l => /^\d\. /.test(l))).toHaveLength(5);
    expect(text).toMatch(/\+2 more in the morning report$/);
  });
});

describe('deadlinePreview: the lock-screen line', () => {
  it('counts what is due or overdue, not the rest of the week', () => {
    expect(deadlinePreview(selectDeadlines([task('A', TODAY), task('B', '2026-09-01'), task('C', '2026-09-28')], TODAY), TODAY))
      .toBe('2 hard deadlines due or overdue | ');
    expect(deadlinePreview(selectDeadlines([task('C', '2026-09-28')], TODAY), TODAY)).toBe('');
    expect(deadlinePreview(null, TODAY)).toBe('');
  });
});

describe('the brief carries the sections above the model\'s one thing', () => {
  const tasks = { deadlines: selectDeadlines(LIVE, TODAY), onlyYou: selectOnlyYou(LIVE, TODAY) };
  const needs = { fields: { Payload: JSON.stringify({ date: TODAY, items: ['Decide the legal deadline card.'] }) } };

  const tenants = { fields: { Payload: JSON.stringify({ asAt: TODAY, worst: 'warn', briefLine: 'working, 1 to watch.' }) } };
  it('mustSeeBlocks: deadlines, then only you, then the 07:00 check, then the tenant line', () => {
    const texts = mustSeeBlocks(tasks, needs, TODAY, tenants).map(b => b.text.text);
    expect(texts[0]).toMatch(/^\*HARD DEADLINES/);
    expect(texts[1]).toMatch(/^\*ONLY YOU TODAY/);
    expect(texts[2]).toMatch(/^\*FROM THE 07:00 CHECK/);
    expect(texts[3]).toBe('🟡 *TENANTS:* working, 1 to watch.');
  });

  it('a failed task read still sends the other sections and says the list is missing', () => {
    const texts = mustSeeBlocks(null, needs, TODAY, tenants).map(b => b.text.text);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toMatch(/could not be read/);
  });

  it('buildBriefBlocks puts them straight under the headline, before THE ONE THING', () => {
    const brief = { headline: 'h', one_thing: 'Sales work', first_step: 's', why: 'w', ignore: [], handed_off: [], flags: [] };
    const blocks = buildBriefBlocks({ light: 'green', safeToActToday: 10 }, brief, mustSeeBlocks(tasks, needs, TODAY));
    expect(blocks[0].type).toBe('header');
    expect(blocks[1].text.text).toMatch(/^\*HARD DEADLINES/);
    const oneThing = blocks.findIndex(b => b.text && /THE ONE THING/.test(b.text.text));
    expect(oneThing).toBe(5);
  });
});

describe('sendDailyDM sends the sections on both paths', () => {
  // The real sendDailyDM, with its I/O replaced. A CEO failure used to fall back to a money-only
  // message, which would drop the deadline list on exactly the morning the model broke.
  const src = pick('sendDailyDM');
  const deps = ['slackLookup', 'loadAndCompute', 'gatherTasks', 'gatherCalendar', 'gatherHuddle', 'callCeo',
    'buildCeoPrompt', 'slackPost', 'storeBrief', 'storeFallbackMarker', 'readNeedsYouRow', 'todayLondonISO',
    'DEFAULT_RECIPIENT', 'fmt', 'LIGHT_LABEL', 'buildBlocks', 'buildBriefBlocks', 'mustSeeBlocks',
    'needsYouText', 'deadlinePreview', 'readEstateRow', 'TENANT_CHAIN_KEY'];
  // eslint-disable-next-line no-new-func
  const make = new Function(...deps, `${src}\nreturn sendDailyDM;`);
  const run = async ({ ceoFails = false, tasksFail = false } = {}) => {
    const posts = [];
    const tasks = { deadlines: selectDeadlines(LIVE, TODAY), onlyYou: selectOnlyYou(LIVE, TODAY) };
    const send = make(
      async () => 'U1',
      async () => ({ light: 'green', safeToActToday: 10, headline: '' }),
      async () => { if (tasksFail) throw new Error('airtable down'); return tasks; },
      async () => ({ connected: false }),
      async () => null,
      async () => { if (ceoFails) throw new Error('proxy down'); return { headline: 'h', one_thing: 'o', first_step: 'f', why: 'w', ignore: [], handed_off: [], flags: [] }; },
      () => ({}),
      async (token, channel, text, blocks) => { posts.push({ text, blocks }); },
      async () => {}, async () => {},
      async () => ({ fields: { Payload: JSON.stringify({ date: TODAY, items: ['Decide it.'] }) } }),
      () => TODAY, 'k@example.com', W.fmt, W.LIGHT_LABEL, W.buildBlocks, W.buildBriefBlocks, W.mustSeeBlocks,
      W.needsYouText, W.deadlinePreview,
      async (pat, key) => (key === 'tenant-chain'
        ? { fields: { Payload: JSON.stringify({ asAt: TODAY, worst: 'ok', briefLine: 'working. 3 referrers told.' }) } } : null),
      'tenant-chain');
    await send({ SLACK_BOT_TOKEN: 't', AIRTABLE_PAT: 'p' });
    expect(posts).toHaveLength(1);
    return { text: posts[0].text, all: posts[0].blocks.map(b => (b.text && b.text.text) || '').join('\n') };
  };

  it('the CEO brief', async () => {
    const out = await run();
    expect(out.all).toContain('Final court notice');
    expect(out.all).toContain('FROM THE 07:00 CHECK');
    expect(out.all).toContain('🟢 *TENANTS:* working. 3 referrers told.');
    expect(out.text).toMatch(/^\d+ hard deadlines? due or overdue \| ONE thing/);
  });

  it('the money-only fallback when the CEO call fails', async () => {
    const out = await run({ ceoFails: true });
    expect(out.all).toContain('Final court notice');
    expect(out.all).toContain('FROM THE 07:00 CHECK');
    expect(out.all).toContain('*TENANTS:*');
    expect(out.text).toMatch(/hard deadlines? due or overdue \| Safe to act/);
  });

  it('the fallback when the task read itself fails says the list is missing', async () => {
    const out = await run({ tasksFail: true });
    expect(out.all).toMatch(/deadline list could not be read/);
    expect(out.all).toContain('FROM THE 07:00 CHECK');
  });
});

describe('review findings, 24 Sep 2026', () => {
  it('a legacy Approval row with no raiser is in no queue: labelled by its holder, and the name rule does not hide it', () => {
    const legacy = task('Old Approval row nobody raised', TODAY, { status: 'Approval', inQueue: false, holders: [KEVIN_TEAM_MEMBER] });
    expect(selectDeadlines([legacy], TODAY).all[0].who).toBe('yours');
    expect(selectOnlyYou([{ ...legacy, hard: false }], TODAY).items.map(x => x.name)).toEqual(['Old Approval row nobody raised']);
  });

  it('a Some Day task is parked on purpose and stays out of ONLY YOU', () => {
    const parked = task('Parked idea', TODAY, { holders: [KEVIN_TEAM_MEMBER], someDay: true });
    expect(selectOnlyYou([parked], TODAY).items).toEqual([]);
  });

  it('a section never passes Slack\'s 3000 characters, even after escaping', () => {
    const long = Array.from({ length: 5 }, () => '&<>'.repeat(200));
    const row = { fields: { Payload: JSON.stringify({ date: TODAY, items: long }) } };
    for (const b of mustSeeBlocks(null, row, TODAY)) expect(b.text.text.length).toBeLessThanOrEqual(3000);
    expect(needsYouText(row, TODAY).length).toBeGreaterThan(3000);   // control: uncapped it would be refused
  });
});

describe('the reads the brief depends on', () => {
  it('readNeedsYouRow asks the Estate Status table for the one key, and a failed read is undefined, never null', async () => {
    const names = ['BASE_ID', 'ESTATE_STATUS_TBL', 'NEEDS_YOU_KEY'];
    const make = (fetchImpl) => new Function('fetch', 'console',
      `${[...names.map(pick), pick('readEstateRow'), pick('readNeedsYouRow')].join('\n')}\nreturn readNeedsYouRow;`)(fetchImpl, { error() {} });
    let asked = '';
    const row = { id: 'recX', fields: { Key: 'daily-ops-needs-you', Payload: '{}' } };
    const ok = make(async (url) => { asked = url; return { ok: true, json: async () => ({ records: [row] }) }; });
    expect(await ok('pat')).toEqual(row);
    expect(asked).toContain('/tblZVrdzivyBueZVf?');
    expect(decodeURIComponent(asked)).toContain("{Key}='daily-ops-needs-you'");
    expect(await make(async () => ({ ok: true, json: async () => ({ records: [] }) }))('pat')).toBeNull();
    expect(await make(async () => ({ ok: false, status: 500 }))('pat')).toBeUndefined();
    expect(await make(async () => { throw new Error('offline'); })('pat')).toBeUndefined();
  });

  it('gatherTasks reads the tick, the raiser and Some Day, and ONLY YOU skips what the deadline list shows', async () => {
    let params;
    const rec = (id, f) => ({ id, fields: { 'Task Name': id, 'Due Date': TODAY, Status: 'Today', ...f } });
    const rows = [
      rec('onDeadlineList', { 'Team Member': [KEVIN_TEAM_MEMBER], 'Hard Deadline': true }),
      rec('kevinsOwn', { 'Team Member': [KEVIN_TEAM_MEMBER] }),
      rec('queued', { Status: 'Approval', 'Sent For Approval By': ['recAGENT'], 'Hard Deadline': true }),
      rec('parked', { 'Team Member': [KEVIN_TEAM_MEMBER], 'Some Day': true }),
    ];
    const deps = ['KEVIN_TEAM_MEMBER', 'ROY_TEAM_MEMBER', 'ONLY_YOU_SHOW', 'MONTHS', 'dayMonth', 'whenText', 'selectOnlyYou',
      'DEADLINE_DAYS', 'DEADLINE_SHOW', 'LEGAL_RE', 'MONEY_RE', 'addDaysISO', 'deadlineHolder', 'selectDeadlines'];
    // eslint-disable-next-line no-new-func
    const gather = new Function('airtableFetch', 'todayLondonISO', 'TBL_TASKS',
      `${[...deps.map(pick), pick('gatherTasks')].join('\n')}\nreturn gatherTasks;`)(
      async (pat, tbl, p) => { params = p; return rows; }, () => TODAY, 'tblTASKS');
    const t = await gather('pat');
    for (const f of ['Hard Deadline', 'Sent For Approval By', 'Some Day', 'Team Member']) expect(params['fields[]']).toContain(f);
    expect(t.deadlines.all.map(x => [x.id, x.who])).toEqual([['onDeadlineList', 'yours'], ['queued', 'waiting in your approval queue']]);
    expect(t.onlyYou.items.map(x => x.name)).toEqual(['kevinsOwn']);
    expect(t.deadlineList).toContain('onDeadlineList');
  });
});

describe('the tenant chain in one line (Kevin, 25 Sep 2026: "One line daily")', () => {
  const row = p => ({ fields: { Payload: typeof p === 'string' ? p : JSON.stringify(p) } });
  it('prints the chain\'s own line with a light for its worst step, escaped for Slack', () => {
    expect(tenantChainText(row({ asAt: TODAY, worst: 'ok', briefLine: 'working. 31 referrers told.' }), TODAY))
      .toBe('🟢 *TENANTS:* working. 31 referrers told.');
    expect(tenantChainText(row({ asAt: TODAY, worst: 'fail', briefLine: 'NOT WORKING: <x>' }), TODAY))
      .toBe('🔴 *TENANTS:* NOT WORKING: &lt;x&gt;');
  });
  it('says so in words when the chain did not run today, left no row, a damaged row, or could not be read', () => {
    expect(tenantChainText(row({ asAt: '2026-09-21', worst: 'ok', briefLine: 'working.' }), TODAY)).toMatch(/^🔴 .*has not run today.*21 Sep/);
    expect(tenantChainText(null, TODAY)).toMatch(/has not reported/);
    expect(tenantChainText(row('{bad'), TODAY)).toMatch(/damaged report/);
    expect(tenantChainText(undefined, TODAY)).toMatch(/could not be read/);
  });
});

describe('a refused section never costs Kevin the money DM', () => {
  it('the fallback retries with the money blocks alone', async () => {
    const src = pick('sendDailyDM');
    const deps = ['slackLookup', 'loadAndCompute', 'gatherTasks', 'gatherCalendar', 'gatherHuddle', 'callCeo',
      'buildCeoPrompt', 'slackPost', 'storeBrief', 'storeFallbackMarker', 'readNeedsYouRow', 'todayLondonISO',
      'DEFAULT_RECIPIENT', 'fmt', 'LIGHT_LABEL', 'buildBlocks', 'buildBriefBlocks', 'mustSeeBlocks',
      'needsYouText', 'deadlinePreview', 'console', 'readEstateRow', 'TENANT_CHAIN_KEY'];
    const posts = [];
    // eslint-disable-next-line no-new-func
    const send = new Function(...deps, `${src}\nreturn sendDailyDM;`)(
      async () => 'U1', async () => ({ light: 'green', safeToActToday: 10 }),
      async () => ({ deadlines: selectDeadlines(LIVE, TODAY), onlyYou: selectOnlyYou(LIVE, TODAY) }),
      async () => ({ connected: false }), async () => null,
      async () => { throw new Error('proxy down'); }, () => ({}),
      async (token, channel, text, blocks) => {
        posts.push(blocks);
        if (blocks.some(b => b.text && /HARD DEADLINES/.test(b.text.text))) throw new Error('invalid_blocks');
      },
      async () => {}, async () => {}, async () => null, () => TODAY, 'k@example.com', W.fmt, W.LIGHT_LABEL,
      W.buildBlocks, W.buildBriefBlocks, W.mustSeeBlocks, W.needsYouText, W.deadlinePreview, { error() {} },
      async () => null, 'tenant-chain');
    await send({ SLACK_BOT_TOKEN: 't', AIRTABLE_PAT: 'p' });
    expect(posts).toHaveLength(2);
    expect(posts[1].some(b => b.text && /HARD DEADLINES/.test(b.text.text))).toBe(false);
  });
});
