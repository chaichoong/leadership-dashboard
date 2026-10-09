import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Home (Kevin, 29 Sep 2026): the one list of what needs Kevin today. Its pick rules are COPIED
// from the 09:00 brief worker, because Kevin ruled the worker stays untouched while Home is on
// trial. These tests run both copies on the same tasks and fail the moment they pick differently,
// so there is one rule in effect even though there are two copies of the code.
// The worker's functions are read out of the file as text, the same approach as
// tests/ceo-brief-must-see.test.js, so this runs the shipped brief code.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = readFileSync(resolve(ROOT, 'scripts/slack-automation/money-daily-worker.js'), 'utf8');
function pick(n) {
  const m = WORKER.match(new RegExp(`\\n(?:async )?function ${n}\\([\\s\\S]*?\\n\\}`))
    || WORKER.match(new RegExp(`\\nconst ${n} = [^\\n]*;`));
  if (!m) throw new Error(`${n} not found in money-daily-worker.js`);
  return m[0];
}
const HELPERS = ['KEVIN_TEAM_MEMBER', 'ROY_TEAM_MEMBER', 'ONLY_YOU_SHOW', 'MONTHS', 'dayMonth', 'whenText', 'slackEsc',
  'selectOnlyYou', 'DEADLINE_DAYS', 'DEADLINE_SHOW', 'LEGAL_RE', 'MONEY_RE', 'addDaysISO', 'deadlineHolder', 'selectDeadlines',
  'NEEDS_YOU_SHOW', 'needsYouText', 'TENANT_LIGHT', 'tenantChainText', 'gatherTasks'];
// gatherTasks is run with a stubbed airtableFetch, so the worker's own mapping from Airtable
// records is part of the comparison, not just its selection.
// eslint-disable-next-line no-new-func
const W = new Function('airtableFetch', 'todayLondonISO', 'TBL_TASKS',
  `${HELPERS.map(pick).join('\n')}\nreturn { ${HELPERS.join(', ')} };`);
const worker = (records, today) => W(async () => records, () => today, 'tblTASKS');

// The page's module, loaded the way the browser loads it (a plain script with module.exports).
const HOME_SRC = readFileSync(resolve(ROOT, 'js/home-list.js'), 'utf8');
function loadHome(src = HOME_SRC) {
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', src)(mod);
  return mod.exports;
}
const H = loadHome();
const { KEVIN_TEAM_MEMBER: KEVIN, ROY_TEAM_MEMBER: ROY } = H;

const TODAY = '2026-09-29';
const AGENT = 'recAgentXXXXXXXXX';

// Airtable-shaped records. Every name, address and amount is made up: this repo is public.
let seq = 0;
function rec(name, fields = {}) {
  seq += 1;
  return { id: `recHome${String(seq).padStart(10, '0')}`, fields: { 'Task Name': name, Status: 'Today', ...fields } };
}
const queued = (by = [AGENT]) => ({ Status: 'Approval', 'Sent For Approval By': by });

// The three worked examples Kevin approved at the gate (29 Sep 2026), plus the shapes around them.
const STRIKE_OFF = rec('INBOUND: POST: Companies House - ActionToStrikeOff Example Holdings Ltd', { ...queued(), 'Hard Deadline': true, 'Due Date': TODAY, 'Team Member': [KEVIN] });
const TOKEN = rec('Rotate the Airtable token: make a new one and tell Claude to swap it everywhere', { 'Due Date': '2026-09-25', 'Team Member': [KEVIN] });
const PEST = rec('MAINTENANCE: pest warning re-inspection 1 Example Avenue', { 'Hard Deadline': true, 'Due Date': '2026-08-30', 'Team Member': [ROY] });
const LIVE = [
  STRIKE_OFF, TOKEN, PEST,
  rec('Official Receiver: prepare the liquidator vote for Example Holdings', { ...queued(), 'Hard Deadline': true, 'Due Date': TODAY }),
  rec('Credit Card Payments - payments due 5th of the month', { 'Hard Deadline': true, 'Due Date': '2026-09-23', 'Team Member': [AGENT] }),
  rec('INBOUND: Final Charging Order 50000 over 2 Example Road', { 'Hard Deadline': true, 'Due Date': '2026-09-24', 'Team Member': [AGENT] }),
  rec('HMRC CFS-0000000: send tranche 1 to the officer by 9 Oct', { 'Hard Deadline': true, 'Due Date': '2026-10-09', 'Team Member': [AGENT] }),
  rec('INBOUND: Example speeding fine EUR 45 - pay online', { 'Hard Deadline': true, 'Due Date': '2026-10-11', 'Team Member': [AGENT] }),
  rec('Far away deadline beyond a fortnight', { 'Hard Deadline': true, 'Due Date': '2026-10-30' }),
  rec('UC verification: Pat Example, £500.00 due 2 October 2026', { 'Hard Deadline': true, 'Due Date': TODAY }),
  rec('INBOUND: respond to court order parked to next week', { ...queued(), 'Hard Deadline': true, 'Due Date': '2026-09-01', 'Deferred Until': '2026-10-06' }),
  rec('Switch the photo backup back on (phone app)', { 'Due Date': TODAY, 'Team Member': [KEVIN] }),
  rec('A parked Some Day idea of yours', { 'Due Date': '2026-09-01', 'Team Member': [KEVIN], 'Some Day': true }),
  rec('Update the standing order for 5 Example Place', { ...queued(), 'Due Date': '2026-09-20', 'Team Member': [KEVIN] }),
  rec('A decide card of yours that is not a bank step', { ...queued(), 'Due Date': '2026-09-20', 'Team Member': [KEVIN] }),
  rec('Reply to the letting agent about the boiler', { ...queued(), 'Task Type': 'Correspondence', 'Due Date': '2026-09-26' }),
  rec('Example Bank card statement - minimum GBP5.16 due 3 Oct', { ...queued(), 'Due Date': '2026-09-27' }),
  rec('Tribunal bundle for Example case', { ...queued(), 'Due Date': '2026-09-28' }),
  rec('Approval with no raiser is ordinary work', { Status: 'Approval', 'Due Date': TODAY, 'Team Member': [KEVIN] }),
  rec('A card knocked back to a later date', { ...queued(), 'Due Date': '2026-09-10', 'Deferred Until': '2026-10-02' }),
  rec('Send the first batch of papers by 9 Oct', { 'Hard Deadline': true, 'Due Date': '2026-09-30' }),
];

// A seeded spread of every combination the rules branch on.
function randomRecords(n, seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const pickOne = a => a[Math.floor(rnd() * a.length)];
  const names = ['Pay the council tax', 'Court hearing notice', 'Sign the lease', 'SIGN-IN to the portal', 'Chase rent payments',
    'UC verification: someone', 'Bank details change for Example', 'Update SO amount', 'TAKING SO LONG', 'Adobe Sign reminder',
    'Mortgage arrears letter', 'HMRC letter', 'Fix the gate', 'Invoice 123', 'Companies House filing', 'Direct debit set up'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const off = Math.floor(rnd() * 60) - 40;
    const f = { 'Due Date': rnd() < 0.9 ? H.addDaysISO(TODAY, off) : undefined };
    if (rnd() < 0.5) f['Hard Deadline'] = true;
    if (rnd() < 0.4) Object.assign(f, queued(rnd() < 0.8 ? [AGENT] : []));
    if (rnd() < 0.2) f['Deferred Until'] = H.addDaysISO(TODAY, Math.floor(rnd() * 10) - 5);
    if (rnd() < 0.1) f['Some Day'] = true;
    const who = rnd();
    if (who < 0.35) f['Team Member'] = [KEVIN]; else if (who < 0.5) f['Team Member'] = [ROY]; else if (who < 0.7) f['Team Member'] = [AGENT];
    if (rnd() < 0.2) f.Assignee = { name: 'Roy Lavin' };
    out.push(rec(`${pickOne(names)} ${i}`, f));
  }
  return out;
}

async function bothSides(records) {
  const w = worker(records, TODAY);
  const wt = await w.gatherTasks('pat');
  const tasks = records.map(H.toTask);
  return { w, wt, tasks };
}

describe('Home picks exactly what the 09:00 brief picks', () => {
  for (const [label, records] of [['the worked-example set', LIVE], ['400 random tasks', randomRecords(400, 7)], ['400 more', randomRecords(400, 2026)]]) {
    it(`hard deadlines, next 7 days (${label})`, async () => {
      const { wt, tasks } = await bothSides(records);
      const mine = H.selectDeadlines(tasks, TODAY, 7);
      const strip = x => ({ id: x.id, name: x.name, due: x.due, who: x.who, kind: x.kind });
      expect(wt.deadlines.all.length, 'the set must hold deadlines, or the comparison proves nothing').toBeGreaterThan(0);
      expect(mine.all.map(strip)).toEqual(wt.deadlines.all.map(strip));
      expect(mine.ticked).toBe(wt.deadlines.ticked);
    });

    // Against the worker's OWN end-to-end output (its mapping from the records, not Home's), so a
    // Home mapping slip such as dropping Some Day is caught (review, 29 Sep 2026).
    it(`only you, same items and order before the brief's cap of five (${label})`, async () => {
      const { w, wt, tasks } = await bothSides(records);
      const shown = new Set(wt.deadlines.items.map(x => x.id));
      const mine = H.selectOnlyYou(tasks, TODAY, shown);
      expect(mine.length, 'the set must hold only-you items').toBeGreaterThan(0);
      expect(mine.slice(0, w.ONLY_YOU_SHOW).map(x => ({ name: x.name, due: x.due }))).toEqual(wt.onlyYou.items);
      expect(Math.max(0, mine.length - w.ONLY_YOU_SHOW)).toBe(wt.onlyYou.more);
    });
  }

  it('the 07:00 check: every state reads the same way', () => {
    const w = worker([], TODAY);
    const row = p => ({ fields: { Payload: typeof p === 'string' ? p : JSON.stringify(p) } });
    const cases = [undefined, null, row('{broken'), row({}), row({ date: '2026-09-28', items: ['old'] }),
      row({ date: TODAY, unreadable: true }), row({ date: TODAY, items: [] }),
      row({ date: TODAY, items: ['Companies House deadline is TODAY', 'Vote on the liquidator', 'Three fixes wait', 'four', 'five', 'six'] })];
    for (const c of cases) {
      const theirs = w.needsYouText(c, TODAY);
      const mine = H.readNeedsYou(c, TODAY);
      if (theirs.startsWith('_')) {
        expect(mine.items).toEqual([]);
        expect(mine.note.length).toBeGreaterThan(0);
      } else if (/nothing needs you/.test(theirs)) {
        expect(mine).toEqual({ items: [], note: '' });
      } else {
        const lines = theirs.split('\n').slice(1).filter(l => /^\d+\. /.test(l)).map(l => l.replace(/^\d+\. /, ''));
        expect(mine.items.slice(0, lines.length)).toEqual(lines);
        expect(mine.items.length).toBe(6);
      }
    }
  });

  // REGRESSION, finding 20261002-queue-fixer-707: at 07:05, while daily-ops is still
  // running, estate-status.py writes running:true with LAST night's date (or none). Home
  // read past it and told Kevin the 07:00 check "has not reported today", which is a
  // failure sentence for a job that is working. Back-tested by removing the running
  // branch from readNeedsYou: both assertions below fail.
  it('the 07:00 check: a run still in progress says so, not "has not reported"', () => {
    const row = p => ({ fields: { Payload: JSON.stringify(p) } });
    for (const p of [{ date: '2026-09-28', items: null, running: true }, { date: null, items: null, running: true }]) {
      const mine = H.readNeedsYou(row(p), TODAY);
      expect(mine.items).toEqual([]);
      expect(mine.note).toMatch(/still running/);
      expect(mine.note, 'a running job must never be reported as not having reported').not.toMatch(/has not reported/);
    }
    // CONTROL: without running, the same stale date still reads as not reported today.
    expect(H.readNeedsYou(row({ date: '2026-09-28', items: ['old'] }), TODAY).note).toMatch(/has not reported today/);
  });

  it('the tenants line: same light and words as the brief', () => {
    const w = worker([], TODAY);
    const LIGHT = { '🟢': 'ok', '🟡': 'warn', '🔴': 'fail' };
    const row = p => ({ fields: { Payload: JSON.stringify(p) } });
    for (const c of [undefined, row({}), row({ asAt: '2026-09-28', worst: 'ok' }), row({ asAt: TODAY, worst: 'warn', briefLine: 'working, 4 to watch' }),
      row({ asAt: TODAY, worst: 'ok', briefLine: '' })]) {
      const theirs = w.tenantChainText(c, TODAY);
      const mine = H.readTenants(c, TODAY);
      expect(LIGHT[theirs.slice(0, 2)]).toBe(mine.light);
      // The words too, for a line from today: the brief's text with its light and bold label taken off.
      // The not-current states are worded for a page ("this morning" suits a 09:00 message, not a page).
      const current = /TENANTS:\* (?!_)/.test(theirs) && !/has not run today/.test(theirs);
      expect(mine.current).toBe(current);
      if (current) expect(theirs.replace(/^\S+ \*TENANTS:\* /, '')).toBe(mine.text);
    }
  });
});

describe('the rent line (scripts/rent-check.py, 2 Oct 2026)', () => {
  const row = p => ({ fields: { Payload: JSON.stringify(p) } });
  const LINE = '63 of 64 tenants paying (98.4%, floor 97.5%). Late: Unit 9 – 1 Example Road (2 days). Bank data as at 2 Oct 12:03.';

  it('prints today\'s line with its light', () => {
    expect(H.readRent(row({ asAt: TODAY, worst: 'fail', briefLine: LINE }), TODAY)).toEqual({ light: 'fail', current: true, text: LINE });
    expect(H.readRent(row({ asAt: TODAY, worst: 'ok', briefLine: 'x' }), TODAY).light).toBe('ok');
    expect(H.readRent(row({ asAt: TODAY, worst: 'purple', briefLine: 'x' }), TODAY).light).toBe('unknown');
  });

  it('a row that is missing, unread, damaged or from another day is red and says so, never a stale figure', () => {
    const stale = H.readRent(row({ asAt: '2026-09-28', worst: 'ok', briefLine: LINE }), TODAY);
    expect(stale.current).toBe(false);
    expect(stale.light).toBe('fail');
    expect(stale.text).not.toContain('63 of 64');
    expect(stale.text).toContain('has not run today');
    expect(H.readRent(undefined, TODAY)).toEqual({ light: 'fail', current: false, text: 'The rent check could not be read.' });
    expect(H.readRent(null, TODAY).text).toBe('The rent check has not reported.');
    expect(H.readRent({ fields: { Payload: '{broken' } }, TODAY).text).toContain('damaged report');
  });

  it('reads the row the rent check writes', () => {
    expect(H.ESTATE_KEYS.rent).toBe('rent-position');
  });
});

describe('the one list (the examples Kevin approved at the gate, 29 Sep 2026)', () => {
  const tasks = LIVE.map(H.toTask);
  const list = H.buildHomeList({ tasks, today: TODAY, needsRow: null, blockersRow: null, now: Date.parse(`${TODAY}T20:00:00Z`) });
  const group = k => list.groups.find(g => g.key === k);
  const everyId = list.groups.flatMap(g => g.items.map(i => i.id)).filter(Boolean);

  // At the gate this was described as leading the list. The brief's order puts OLDER legal
  // deadlines first (the charging order, overdue since 24 Sep), so it leads the items due today.
  it('1. the Companies House strike-off is a deadline due now, among the legal items, waiting in the queue, shown once', () => {
    const now = group('deadlines-now').items;
    const t = now.find(i => i.id === STRIKE_OFF.id);
    expect(t.when).toBe('due today');
    expect(t.who).toBe('waiting in your approval queue');
    expect(t.inQueue).toBe(true);
    expect(t.legal).toBe(true);
    expect(now.filter(i => i.legal).map(i => i.id)).toContain(STRIKE_OFF.id);
    expect(now.findIndex(i => !i.legal)).toBeGreaterThan(now.findIndex(i => i.id === STRIKE_OFF.id));
    expect(everyId.filter(id => id === STRIKE_OFF.id)).toHaveLength(1);
  });

  it('2. the token task is Only you, overdue since 25 Sep', () => {
    const t = group('only-you').items.find(i => i.id === TOKEN.id);
    expect(t.when).toBe('overdue since 25 Sep');
    expect(t.inQueue).toBe(false);
  });

  it('3. the pest re-inspection shows as a deadline with Roy', () => {
    const t = group('deadlines-now').items.find(i => i.id === PEST.id);
    expect(t.who).toBe('with Roy');
    expect(t.when).toBe('overdue since 30 Aug');
  });

  it('deadlines run 14 days, not the brief\'s 7, and never past that', () => {
    const coming = group('deadlines-coming').items.map(i => i.name);
    expect(coming.some(n => /speeding fine/.test(n))).toBe(true);
    expect(coming.some(n => /Far away/.test(n))).toBe(false);
  });

  it('the approvals are the queue the AI Agents page counts: raised by the loop and not parked', () => {
    const names = group('approve').items.map(i => i.name);
    expect(names.some(n => /no raiser/.test(n))).toBe(false);
    expect(names.some(n => /knocked back/.test(n))).toBe(false);
    expect(list.counts.queue).toBe(H.queueCards(tasks, TODAY).length);
  });

  it('no task shows twice anywhere in the list', () => {
    expect(new Set(everyId).size).toBe(everyId.length);
  });

  it('approvals put legal first, then money, then the rest, and say when approving sends an email', () => {
    const items = group('approve').items;
    const rank = t => (t.tag === 'Approve · legal' ? 0 : t.tag === 'Approve · money' ? 1 : 2);
    expect(items.map(rank)).toEqual([...items.map(rank)].sort((a, b) => a - b));
    expect(items[0].name).toMatch(/Tribunal/);
    expect(items.find(i => /letting agent/.test(i.name)).who).toBe('approving sends the email');
  });

  it('every item counted in the summary is a row on the page', () => {
    expect(list.counts.total).toBe(list.groups.reduce((n, g) => n + g.items.length, 0));
  });
});

describe('lanes, blockers and honest emptiness (review findings, 29 Sep 2026)', () => {
  const now = Date.parse(`${TODAY}T20:00:00Z`);
  it('a card in someone else\'s approval lane is not Kevin\'s to approve, as on the AI Agents page', () => {
    const recs = [
      rec('Kevin lane card, empty Approver', { ...queued(), 'Due Date': '2026-09-20' }),
      rec('Kevin lane card, his address', { ...queued(), 'Due Date': '2026-09-20', Approver: { email: H.APPROVER_EMAIL } }),
      rec('Another lane card', { ...queued(), 'Due Date': '2026-09-20', Approver: { email: 'someone.else@example.com' } }),
    ];
    const list = H.buildHomeList({ tasks: recs.map(H.toTask), today: TODAY, needsRow: null, blockersRow: null, now });
    const names = list.groups.find(g => g.key === 'approve').items.map(i => i.name);
    expect(names).toEqual(expect.arrayContaining(['Kevin lane card, empty Approver', 'Kevin lane card, his address']));
    expect(names).not.toContain('Another lane card');
    expect(list.counts.queue).toBe(2);
  });

  it('a blocked task already listed above is not listed again under robots', () => {
    const tasks = LIVE.map(H.toTask);
    const row = { fields: { Payload: JSON.stringify({ sweptAt: new Date(now).toISOString(), open: [
      // TOOL walls no fixer can reach: the robots this group still lists (8 Oct 2026).
      { task: TOKEN.id, name: 'Rotate the Airtable token', kind: 'TOOL', subject: 'x', days: 2, toolState: 'no-fixer', tool: 'no fixer can reach it' },
      { task: 'recNotElsewhere', name: 'Some other step', kind: 'TOOL', subject: 'y', days: 1, toolState: 'no-fixer', tool: 'no fixer can reach it' }] }) } };
    const list = H.buildHomeList({ tasks, today: TODAY, needsRow: null, blockersRow: row, now });
    const everyId = list.groups.flatMap(g => g.items.map(i => i.id)).filter(Boolean);
    expect(everyId.filter(id => id === TOKEN.id)).toHaveLength(1);
    expect(list.groups.find(g => g.key === 'robots').items.map(i => i.id)).toEqual(['recNotElsewhere']);
  });

  it('a sweep that could not read the board says so, never "no robot stuck"', () => {
    const r = H.readBlockers({ fields: { Payload: JSON.stringify({ open: [], controlFailed: true, sweptAt: new Date(now).toISOString() }), Detail: 'The blocker check could not read the task board.' } }, now);
    expect(r.items).toEqual([]);
    expect(r.note).toMatch(/could not read the task board/);
  });

  it('an empty list with unreadable parts is flagged as not checked, not as a clear day', () => {
    const list = H.buildHomeList({ tasks: [], today: TODAY, needsRow: undefined, blockersRow: undefined, now });
    expect(list.counts.total).toBe(0);
    expect(list.unchecked.length).toBeGreaterThanOrEqual(3);
    expect(list.unchecked[0]).toMatch(/Hard Deadline tick/);
  });

  it('approve items carry the legal flag, so a legal card is marked as urgently as a deadline', () => {
    const list = H.buildHomeList({ tasks: LIVE.map(H.toTask), today: TODAY, needsRow: null, blockersRow: null, now });
    const tribunal = list.groups.find(g => g.key === 'approve').items.find(i => /Tribunal/.test(i.name));
    expect(tribunal.legal).toBe(true);
  });
});

describe('robots stuck on Kevin', () => {
  const now = Date.parse(`${TODAY}T20:00:00Z`);
  const row = p => ({ fields: { Payload: JSON.stringify(p), Detail: 'Robots blocked on 5 tasks.' } });
  const walls = [
    { task: 'recA', name: 'Portal task one', kind: 'SIGN-IN', subject: 'portal.example.co.uk', days: 2 },
    { task: 'recB', name: 'Portal task two', kind: 'SIGN-IN', subject: 'portal.example.co.uk', days: 4 },
    { task: 'recC', name: 'New site task', kind: 'SITE', subject: 'app.example.com', days: 1 },
    { task: 'recD', name: 'Identity check', kind: 'KEVIN', subject: 'identity', days: 3.2 },
    { task: 'recE', name: 'Robot needs a fix', kind: 'TOOL', subject: 'x', days: 1, findingStatus: 'deferred' },
    { task: 'recF', name: 'Daily fix has it', kind: 'TOOL', subject: 'x', days: 1, findingStatus: '' },
  ];

  // Kevin, 8 Oct 2026: a sign-in, a site to add and a step only he can take are approval cards now,
  // listed under "Waiting for your approval" on the same page; named here as well they were the same
  // thing twice. Only a robot no fixer can reach stays in this group.
  it('lists only the robots no fixer can reach: sign-ins, sites and his own steps are cards in the queue', () => {
    const r = H.readBlockers(row({ open: walls, sweptAt: new Date(now - 10 * 60000).toISOString() }), now);
    const texts = r.items.map(i => i.text);
    expect(texts.some(t => /portal\.example\.co\.uk|app\.example\.com|Identity check/.test(t))).toBe(false);
    expect(texts.some(t => /Robot needs a fix/.test(t))).toBe(true);
    expect(texts.some(t => /Daily fix has it/.test(t))).toBe(false);
    expect(r.items).toHaveLength(1);
    expect(r.note).toBe('');
  });

  it('a TOOL wall no fixer can reach says why, in the sweep\'s words; one on a merge card or the daily fix stays off (7 Oct 2026)', () => {
    const r = H.readBlockers(row({ sweptAt: new Date(now - 10 * 60000).toISOString(), open: [
      { task: 'recG', name: 'Stuck on a runner', kind: 'TOOL', subject: 'x', days: 6, findingStatus: 'open', toolState: 'no-fixer', tool: 'no fixer can reach it (protected file: scripts/agent-settings.json)' },
      { task: 'recH', name: 'Card waiting', kind: 'TOOL', subject: 'y', days: 6, findingStatus: 'pending', toolState: 'merge-card', tool: 'waiting on a merge card (PR #812)' },
      { task: 'recI', name: 'Fixer has it', kind: 'TOOL', subject: 'z', days: 1, findingStatus: 'deferred', toolState: 'fixer', tool: 'waiting on the daily robot fix' },
    ] }), now);
    const texts = r.items.map(i => i.text);
    expect(texts).toEqual(['Stuck on a runner: no fixer can reach it (protected file: scripts/agent-settings.json)']);
    expect(texts.join(' ')).not.toMatch(/Claude Code session/);
  });

  it('says so when the sweep is old, missing or unreadable, never a silent empty list', () => {
    expect(H.readBlockers(row({ open: [], sweptAt: new Date(now - 5 * 3600000).toISOString() }), now).note).toMatch(/5 hours ago/);
    expect(H.readBlockers(null, now).note).toMatch(/never reported/);
    expect(H.readBlockers(undefined, now).note).toMatch(/could not be read/);
    expect(H.readBlockers({ fields: { Payload: '{bad', Detail: 'The sweep failed.' } }, now).note).toMatch(/left no list.*The sweep failed/);
  });
});

// Kevin, 9 Oct 2026: "It needs to disappear once I've answered it." A Your step card he has answered
// stays at Status Approval until the half-hourly sweep, but the queue read leaves it out, and js/home.js
// flags it `answered`. Home then never lists it as waiting for him.
describe('an answered Your step card is not waiting on him', () => {
  const H2 = H;
  it('is out of the queue cards and the Only you list, and says where it is going', () => {
    const t = { id: 'recAnsweredAaaaaa', name: 'Pay the example insurer', inQueue: true, answered: true, due: '2026-10-09',
      holders: [H2.KEVIN_TEAM_MEMBER], approverEmail: '', deferred: '' };
    const live = Object.assign({}, t, { id: 'recLiveAaaaaaaaaa', answered: false });
    expect(H2.queueCards([t, live], '2026-10-09').map(x => x.id)).toEqual(['recLiveAaaaaaaaaa']);
    expect(H2.selectOnlyYou([t, live], '2026-10-09').map(x => x.id)).toEqual(['recLiveAaaaaaaaaa']);
    expect(H2.deadlineHolder(t)).toBe('answered, going back to its agent');
    expect(H2.deadlineHolder(live)).toBe('waiting in your approval queue');
  });
});
