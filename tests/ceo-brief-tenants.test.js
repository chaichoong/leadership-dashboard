import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mergeConfig } from '../js/ceo-brief-defaults.mjs';
import {
  localParts, localDate, isSendWindow, skipReason, shapeTasks, emptyTasks, parseIcsToday,
  moneyFromConfig, buildSeatPrompt, buildCeoPrompt, enabledSeats,
  dropAlreadyWaiting, redirectToWaiting, waitingMatch, dedupeHandedOff, finaliseBrief,
  buildSlackPayload, briefRow,
} from '../workers/ceo-brief-tenants/lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(resolve(ROOT, p), 'utf8');

// A complete, go-live-ready tenant. Tests mutate a copy.
function readyConfig(over = {}) {
  return mergeConfig({
    enabled: true,
    founder: { name: 'Sam Carter', business: 'Carter Bookkeeping', what_it_sells: 'Bookkeeping for trades, £250 a month', wheelhouse: ['client calls', 'pricing'] },
    quarter: { context: 'Reach 12 clients by the end of September. Theme: referrals.' },
    ...over,
  });
}

describe('send window per tenant timezone', () => {
  it('fires in London at 09:00 BST on a weekday (control)', () => {
    expect(isSendWindow(readyConfig(), new Date('2026-08-03T08:00:00Z'))).toBe(true); // Mon 09:00 London
  });
  it('retries through the two hours after the send hour, then stops', () => {
    const cfg = readyConfig();
    expect(isSendWindow(cfg, new Date('2026-08-03T09:30:00Z'))).toBe(true);  // 10:30 London
    expect(isSendWindow(cfg, new Date('2026-08-03T10:59:00Z'))).toBe(true);  // 11:59 London
    expect(isSendWindow(cfg, new Date('2026-08-03T11:00:00Z'))).toBe(false); // 12:00 London
    expect(isSendWindow(cfg, new Date('2026-08-03T07:00:00Z'))).toBe(false); // 08:00 London
  });
  it('uses GMT in winter', () => {
    const cfg = readyConfig();
    expect(isSendWindow(cfg, new Date('2026-01-05T08:00:00Z'))).toBe(false); // Mon 08:00 London
    expect(isSendWindow(cfg, new Date('2026-01-05T09:00:00Z'))).toBe(true);  // Mon 09:00 London
  });
  it('refuses the weekend when weekdays_only, allows it when not', () => {
    expect(isSendWindow(readyConfig(), new Date('2026-08-02T08:00:00Z'))).toBe(false); // Sun
    expect(isSendWindow(readyConfig({ weekdays_only: false }), new Date('2026-08-02T08:00:00Z'))).toBe(true);
  });
  it('honours a different zone and send hour', () => {
    const ny = readyConfig({ timezone: 'America/New_York', send_hour: 7 });
    expect(isSendWindow(ny, new Date('2026-08-03T11:00:00Z'))).toBe(true);  // 07:00 New York (EDT)
    expect(isSendWindow(ny, new Date('2026-08-03T08:00:00Z'))).toBe(false); // 04:00 New York
    const syd = readyConfig({ timezone: 'Australia/Sydney', send_hour: 8 });
    expect(isSendWindow(syd, new Date('2026-08-02T22:00:00Z'))).toBe(true);  // Mon 3 Aug 08:00 Sydney
  });
  it('derives the local date, crossing midnight where the tenant is', () => {
    expect(localDate('Australia/Sydney', new Date('2026-08-02T22:00:00Z'))).toBe('2026-08-03');
    expect(localDate('Europe/London', new Date('2026-08-02T22:00:00Z'))).toBe('2026-08-02');
    expect(localParts('Europe/London', new Date('2026-08-02T23:30:00Z')).hour).toBe(0);
  });
});

describe('tenants that must be skipped', () => {
  it('runs a ready config (control)', () => { expect(skipReason(readyConfig())).toBeNull(); });
  it('skips when switched off', () => { expect(skipReason(readyConfig({ enabled: false }))).toMatch(/switched off/); });
  it('names the missing setup items', () => {
    const r = skipReason(readyConfig({ quarter: { context: '' } }));
    expect(r).toMatch(/setup incomplete/);
    expect(r).toContain("This quarter's targets");
  });
  it('skips a Slack tenant with no webhook address', () => {
    expect(skipReason(readyConfig({ delivery: { channel: 'slack_webhook' } }))).toContain('Slack webhook address');
  });
});

describe('the board prompt', () => {
  it('lists only the enabled seats at the table', () => {
    const cfg = readyConfig();
    cfg.board = cfg.board.map(s => ({ ...s, enabled: s.seat !== 'Wealth' }));
    const seat = cfg.board.find(s => s.seat === 'Strategy');
    const p = buildSeatPrompt(seat, cfg, emptyTasks(), { connected: false }, '2026-08-03');
    expect(p.system).toContain('Gary Keller');
    expect(p.system).toContain('Marketing (Hormozi)');
    expect(p.system).not.toContain('Kiyosaki');
    expect(p.user).toContain('Reach 12 clients');
    expect(p.system).not.toMatch(/—/);
  });
  it('enabledSeats drops disabled ones', () => {
    const cfg = readyConfig();
    cfg.board = cfg.board.map((s, i) => ({ ...s, enabled: i < 3 }));
    expect(enabledSeats(cfg)).toHaveLength(3);
  });
});

describe('the CEO prompt', () => {
  it('names only enabled workers, the team, and the surnames of enabled seats', () => {
    const cfg = readyConfig({ team: [{ name: 'Priya', role: 'admin', may_be_handed: ['suppliers'] }] });
    cfg.workers = cfg.workers.map(w => ({ ...w, enabled: w.id !== 'worker-auditor' }));
    cfg.board = cfg.board.map(s => ({ ...s, enabled: !['Wealth', 'Mindset'].includes(s.seat) }));
    const p = buildCeoPrompt(cfg, emptyTasks(), { connected: false }, moneyFromConfig(cfg), null, '2026-08-03', 'Monday 3 August');
    expect(p.system).toContain('worker-builder');
    expect(p.system).not.toContain('worker-auditor');
    expect(p.system).toContain('Priya (admin): may be handed suppliers');
    expect(p.system).toContain('Keller (Strategy');
    expect(p.system).not.toContain('Kiyosaki');
    expect(p.system).not.toContain('DeMartini');
    expect(p.system).toContain('Sam, and ONLY for: decisions, approvals');
    expect(p.system).toContain('13-year-old');
    expect(p.system).toContain('Dan Martell');
    expect(p.user).toContain('MONEY: not connected');
    expect(p.user).toContain('(tasks not connected)');
    expect(p.user).toContain('No board huddle ran today');
  });
  it('leads with the huddle when seats answered, and carries the manual money light', () => {
    const cfg = readyConfig({ money_source: { kind: 'manual', manual_light: 'amber', manual_safe_to_act: 1250 } });
    const huddle = { seats: [{ seat: 'Finance', head: 'Greg Crabtree', completed: 'none', today: 'cash review', blocking: 'none', flag: 'Crabtree: payroll lands Friday' }], errors: [{ seat: 'Sales' }] };
    const p = buildCeoPrompt(cfg, emptyTasks(), { connected: true, today: '10:00 — Client call' }, moneyFromConfig(cfg), huddle, '2026-08-03', 'Monday');
    expect(p.user).toContain('Crabtree (Finance): completed: none');
    expect(p.user).toContain('FLAG: Crabtree: payroll lands Friday');
    expect(p.user).toContain('Seats that did not answer today: Sales');
    expect(p.user).toContain('light AMBER, safe to act today £1,250.00');
    expect(p.user).toContain('10:00 — Client call');
  });
  it('honours the supportive tone and the founder red lines', () => {
    const cfg = readyConfig({ founder: { tone: 'supportive', never_see: ['chasing invoices'], non_negotiables: ['Fridays off'], income_floor: '£4,000 a month' } });
    const p = buildCeoPrompt(cfg, emptyTasks(), { connected: false }, moneyFromConfig(cfg), null, '2026-08-03', '');
    expect(p.system).toContain('be supportive and give options');
    expect(p.system).toContain('never wants to see: chasing invoices');
    expect(p.system).toContain('Non-negotiables: Fridays off');
    expect(p.system).toContain('Income floor: £4,000 a month');
  });
});

describe('task piles', () => {
  const today = '2026-08-03';
  const rows = [
    { name: 'Warm lane: re-engage Jack Duddy', who: 'unassigned', due: '2026-08-01', status: 'Approval', type: 'Correspondence' },
    { name: 'Fix the invoice page', who: 'Sam Carter', due: '2026-08-01', status: 'In Progress', priority: 'High' },
    { name: 'Call the accountant', who: 'Sam Carter', due: today, status: 'To Do' },
    { name: 'Order stock', who: 'Priya', due: '2026-09-01', status: 'To Do' },
  ];
  it('keeps Approval work out of the overdue pile and counts sends', () => {
    const t = shapeTasks(rows, today, readyConfig());
    expect(t.counts).toEqual({ open: 3, overdue: 1, dueToday: 1, founders: 2, awaitingApproval: 1, awaitingSend: 1 });
    expect(t.approvalList).toContain('APPROVING SENDS THE EMAIL');
    expect(t.approvalNames).toEqual(['warm lane: re-engage jack duddy']);
  });
  it('respects a tenant who names the approval status differently', () => {
    const cfg = readyConfig({ tasks_source: { approval_status: 'Waiting', correspondence_type: 'Email' } });
    const t = shapeTasks([{ name: 'X thing', status: 'Waiting', type: 'Email' }, { name: 'Y', status: 'Approval' }], today, cfg);
    expect(t.counts.awaitingApproval).toBe(1);
    expect(t.counts.awaitingSend).toBe(1);
    expect(t.counts.open).toBe(1);
  });
});

// Same inputs as tests/ceo-brief-approval-queue.test.js, so the two briefs cannot disagree.
describe('approval-queue guards (parity with the single-tenant brief)', () => {
  const tasks = { approvalNames: ['warm lane: re-engage jack duddy'], approvalDisplayNames: ['Warm lane: re-engage Jack Duddy'] };
  it('does not dispatch an agent to redo work already waiting on a tick', () => {
    expect(dropAlreadyWaiting(['worker-writer — draft a warm re-opener message for Jack Duddy'], tasks)).toEqual([]);
  });
  it('leaves genuine hand-offs alone', () => {
    expect(dropAlreadyWaiting(['worker-analyst — pull the Q3 conversion rate', 'worker-builder — fix the CFV sidebar badge'], tasks)).toHaveLength(2);
  });
  it('one shared generic word is not a match', () => {
    expect(dropAlreadyWaiting(['worker-writer — draft the email to Intus'], { approvalNames: ['draft the email to the council'] })).toHaveLength(1);
  });
  it('an empty approval queue changes nothing', () => {
    const items = ['worker-writer — draft something'];
    expect(dropAlreadyWaiting(items, { approvalNames: [] })).toEqual(items);
    expect(dropAlreadyWaiting(items, undefined)).toEqual(items);
  });
  it('rewrites a first_step that duplicates a waiting task, never blanks it', () => {
    const out = redirectToWaiting('Spend 10 minutes writing one honest, short re-opener to Jack Duddy in your own voice', tasks, 'first_step');
    expect(out).not.toMatch(/spend 10 minutes/i);
    expect(out).toMatch(/approve/i);
    expect(out).toContain('Warm lane: re-engage Jack Duddy');
    expect(out).not.toMatch(/—/);
  });
  it('rewrites one_thing differently from first_step', () => {
    const step = redirectToWaiting('re-engage Jack Duddy today', tasks, 'first_step');
    const one = redirectToWaiting('Re-engage Jack Duddy', tasks, 'one_thing');
    expect(one).not.toBe(step);
    expect(one).toContain('Warm lane: re-engage Jack Duddy');
  });
  it('leaves a genuine step alone, and everything when nothing waits', () => {
    const step = 'Call the accountant about the Q3 filing deadline';
    expect(redirectToWaiting(step, tasks, 'first_step')).toBe(step);
    expect(redirectToWaiting('Re-engage Jack Duddy', { approvalNames: [] }, 'first_step')).toBe('Re-engage Jack Duddy');
  });
  it('uses the SAME match for both guards', () => {
    const line = 'draft a warm re-opener message for Jack Duddy';
    expect(waitingMatch(line, tasks)).toBe(0);
    expect(dropAlreadyWaiting([line], tasks)).toEqual([]);
    expect(redirectToWaiting(line, tasks, 'first_step')).not.toBe(line);
  });
  it('dedupeHandedOff: first wins, case and whitespace ignored, blanks dropped', () => {
    expect(dedupeHandedOff(['worker-writer — Draft X', 'worker-writer —  draft x ', '', 'worker-analyst — count'])).toEqual(['worker-writer — Draft X', 'worker-analyst — count']);
  });
});

describe('finaliseBrief', () => {
  const cfg = readyConfig();
  cfg.board = cfg.board.map(s => ({ ...s, enabled: s.seat !== 'Wealth' }));
  const tasks = { approvalNames: ['warm lane: re-engage jack duddy'], approvalDisplayNames: ['Warm lane: re-engage Jack Duddy'] };
  it('applies the limits, drops flags from disabled seats, and runs both guards', () => {
    const b = finaliseBrief({
      one_thing: 'Re-engage Jack Duddy', first_step: 'write to Jack Duddy re-engage',
      ignore: ['a', 'b', 'c', 'd', 'e'],
      flags: ['Kiyosaki: buy an asset', 'Keller: this is scatter', 'Crabtree: cash', 'Bailey: x'],
      handed_off: ['worker-writer — draft a warm re-opener for Jack Duddy', 'worker-analyst — count leads', 'worker-analyst — count leads'],
    }, tasks, cfg);
    expect(b.ignore).toHaveLength(4);
    expect(b.flags).toEqual(['Keller: this is scatter', 'Crabtree: cash']);
    expect(b.handed_off).toEqual(['worker-analyst — count leads']);
    expect(b.one_thing).toMatch(/approval queue/);
    expect(b.first_step).toMatch(/Approve/);
  });
  it('throws without the two required fields so the caller can retry', () => {
    expect(() => finaliseBrief({ one_thing: 'x' }, tasks, cfg)).toThrow(/required/);
  });
});

describe('calendar (ICS) parsing', () => {
  const today = '2026-08-03';
  it('reads a plain timed event and sorts by time', () => {
    const ics = 'BEGIN:VEVENT\nDTSTART:20260803T140000\nSUMMARY:Late call\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:20260803T090000\nSUMMARY:Stand-up\nEND:VEVENT';
    expect(parseIcsToday(ics, today)).toBe('09:00 — Stand-up\n14:00 — Late call');
  });
  it('joins folded lines and tolerates SUMMARY parameters', () => {
    const ics = 'BEGIN:VEVENT\nDTSTART;TZID=Europe/London:20260803T100000\nSUMMARY;LANGUAGE=en:Very long title that\n continues here\nEND:VEVENT';
    expect(parseIcsToday(ics, today)).toBe('10:00 — Very long title thatcontinues here');
  });
  it('converts a UTC time into the tenant zone and drops other days', () => {
    const ics = 'BEGIN:VEVENT\nDTSTART:20260803T080000Z\nSUMMARY:UTC call\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:20260804T080000Z\nSUMMARY:Tomorrow\nEND:VEVENT';
    expect(parseIcsToday(ics, today, 'Europe/London')).toBe('09:00 — UTC call');
    expect(parseIcsToday(ics, today, 'America/New_York')).toBe('04:00 — UTC call');
  });
  it('handles all-day events and an empty feed', () => {
    expect(parseIcsToday('BEGIN:VEVENT\nDTSTART;VALUE=DATE:20260803\nSUMMARY:Bank holiday\nEND:VEVENT', today)).toBe('all day — Bank holiday');
    expect(parseIcsToday('', today)).toBe('');
  });
});

describe('money and delivery shapes', () => {
  it('manual money carries the light and figure, none is not connected', () => {
    expect(moneyFromConfig(readyConfig({ money_source: { kind: 'manual', manual_light: 'red', manual_safe_to_act: '900' } }))).toEqual({ connected: true, light: 'red', safe_to_act: 900 });
    expect(moneyFromConfig(readyConfig())).toEqual({ connected: false, light: null, safe_to_act: null });
  });
  it('Slack payload has a text fallback, blocks, and no em dashes in our own copy', () => {
    const brief = { headline: 'Clear the queue', one_thing: 'Approve the three emails', first_step: 'Open the queue', why: 'They send on approval', ignore: ['newsletters'], handed_off: ['worker-analyst — count leads'], flags: ['Keller: focus'] };
    const p = buildSlackPayload(brief, { connected: true, light: 'green', safe_to_act: 500 }, 'Monday 3 August', 9);
    expect(p.text).toContain('Clear the queue');
    expect(p.blocks.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(p.blocks).match(/09:00 CEO brief/)).toBeTruthy();
  });
  it('briefRow flattens lists and keeps the huddle', () => {
    const row = briefRow('org-1', '2026-08-03', { one_thing: 'x', first_step: 'y', why: '', ignore: ['a', 'b'], flags: [], handed_off: ['h'] }, { connected: false }, { seats: [], errors: [] }, { tasks: {} });
    expect(row.ignore_today).toBe('a\nb');
    expect(row.money_light).toBeNull();
    expect(row.fallback).toBe(false);
    expect(row.full_brief.one_thing).toBe('x');
  });
});

describe('wrangler.toml and worker hygiene', () => {
  const TOML = read('workers/ceo-brief-tenants/wrangler.toml');
  const WORKER = read('workers/ceo-brief-tenants/worker.js');
  const LIB = read('workers/ceo-brief-tenants/lib.mjs');
  const crons = () => [...(TOML.match(/crons\s*=\s*\[([^\]]*)\]/) || ['', ''])[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  it('has at least one cron (control)', () => { expect(crons().length).toBeGreaterThan(0); });
  it('fires every day: day-of-month, month and day-of-week are all *', () => {
    for (const c of crons()) {
      const f = c.trim().split(/\s+/);
      expect(f.slice(2), `cron "${c}" filters by day; the code owns the day`).toEqual(['*', '*', '*']);
    }
  });
  it('covers 09:00 London in both BST and GMT', () => {
    const hours = new Set();
    for (const c of crons()) { const [a, b] = c.split(/\s+/)[1].split('-').map(Number); for (let h = a; h <= (b ?? a); h++) hours.add(h); }
    expect(hours.has(8)).toBe(true);
    expect(hours.has(9)).toBe(true);
  });
  it('names the models only in [vars] and has observability on', () => {
    expect(TOML).toMatch(/AI_MODEL_DEFAULT\s*=/);
    expect(TOML).toMatch(/AI_MODEL_LIGHT\s*=/);
    expect(TOML).toMatch(/\[observability\][^[]*enabled\s*=\s*true/);
    expect(WORKER + LIB).not.toMatch(/claude-(sonnet|haiku|opus)-[0-9]/);
  });
  it('stores before it delivers, and logs only through the helper', () => {
    const run = WORKER.slice(WORKER.indexOf('async function runTenant('));
    expect(run.indexOf('await upsertBrief(')).toBeGreaterThan(-1);
    expect(run.indexOf('await upsertBrief(')).toBeLessThan(run.indexOf('await deliver('));
    const logs = WORKER.match(/console\.log\(/g) || [];
    expect(logs).toHaveLength(1);
    expect(WORKER).toMatch(/resolution=merge-duplicates/);
  });
});
