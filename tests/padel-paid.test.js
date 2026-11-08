// scripts/padel-paid.mjs: the padel page's Booked and paid carried out on the Mac (Kevin, 30 Oct 2026):
// one Splitwise entry in the Padel group, then one text to each player. These drive the script's own
// runOnce() with the Worker, Splitwise (through agent-browser) and Messages replaced by fakes that
// behave like them. Every person here is invented; the phone numbers are Ofcom's drama range.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  description, equalShares, firstNames, textFor, sameBooking, buildPlan, checkEntry, runOnce, texted, textHours, textStart, makeLedger, PAID_URL, perPersonShown, deliveryOf,
  matchSplitwise, matchPhone, linkPlayer, saveLink, readWhatsapp, newNote, emailStep, heldByEmail, readEmails, makeEmailLedger, BOOKING_URL,
} from '../scripts/padel-paid.mjs';

const require_ = createRequire(import.meta.url);
const tmp = () => mkdtempSync(join(tmpdir(), 'padel-paid-'));
const GROUP = 900;
const MEMBERS = [11, 12, 13, 14, 15, 16];               // Splitwise ids in the group; 11 is the payer
const PLAYERS = {
  splitwise_group: { id: GROUP, name: 'Padel' },
  players: {
    1: { page_name: 'Test Payer', self: true, phones: ['+447700900001'], splitwise_id: 11 },
    2: { page_name: 'Test Bob', phones: ['+447700900002'], splitwise_id: 12 },
    3: { page_name: 'Test Cat', phones: ['+447700900003'], splitwise_id: 13 },
    4: { page_name: 'Test Dan', phones: ['+447700900004'], splitwise_id: 14 },
    9: { page_name: 'Test Out', phones: ['+447700900009'] },             // not in the Splitwise group
  },
};
const AT = '2026-11-01T10:00:00.000Z';
const NOON = Date.parse('2026-11-01T12:00:00Z');        // 12:00 London (GMT): inside the text hours
const booking = (extra = {}) => ({
  slot: '2026-11-03|19', date: '2026-11-03', day: 'Tue 3 Nov', venue: { code: 'pdl', short: 'Testford', label: 'Test Padel Club' },
  start: '19:30', minutes: 90, pricePence: 3600, paidAt: AT,
  players: [{ id: 1, name: 'Test Payer' }, { id: 2, name: 'Test Bob' }, { id: 3, name: 'Test Cat' }, { id: 4, name: 'Test Dan' }],
  splitwise: { state: null, at: null, note: null }, texts: { state: null, at: null, note: null }, ...extra,
});
// An entry as Splitwise lists it: paid by `paid`, owed as given (Splitwise id -> pence).
const entry = (id, desc, owes, { cost = Object.values(owes).reduce((a, x) => a + x, 0), paid = 11, deleted = null } = {}) => ({
  id, description: desc, cost: (cost / 100).toFixed(2), date: AT, created_at: AT, deleted_at: deleted,
  users: [...new Set([...MEMBERS, ...Object.keys(owes).map(Number)])].map((u) => ({ user_id: u, paid_share: u === paid ? (cost / 100).toFixed(2) : '0.00', owed_share: ((owes[u] || 0) / 100).toFixed(2) })),
});
const NINES = { 11: 900, 12: 900, 13: 900, 14: 900 };

// A fake padel Worker: the robot's GET and its claimed/done/failed POSTs, with the Worker's own rules.
function worker(bookings, { refuse = () => false, clock = () => AT } = {}) {
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    if (url !== PAID_URL) throw new Error(`unexpected ${url}`);
    if (!init.method) return new Response(JSON.stringify({ ok: true, bookings: bookings.filter((b) => !(b.splitwise.state === 'done' && b.texts.state === 'done')) }), { status: 200 });
    const body = JSON.parse(init.body);
    posts.push(body);
    const b = bookings.find((x) => x.slot === body.slot);
    const cur = b[body.step].state;
    const ok = !refuse(body) && (body.state === 'claimed' ? cur === null && body.paidAt === b.paidAt && (body.step === 'splitwise' || b.splitwise.state === 'done') : cur === 'claimed');
    if (ok) b[body.step] = { state: body.state, at: clock(), note: body.note || null };
    return new Response(JSON.stringify({ ok: true, changed: ok }), { status: 200 });
  };
  return { fetchImpl, posts };
}
// A fake Splitwise behind agent-browser: read gives the group and its entries; commit saves the plan's
// entry with the ticked members owing equal shares (what the real form does), unless told to fail.
function splitwise({ expenses = [], commitCode = 0, groupReadable = true, savedCost = null, members = MEMBERS.map((id) => ({ id })) } = {}) {
  const calls = [];
  const memberIds = () => members.map((m) => m.id);   // read live: a test may add a member between runs
  const ab = async (args) => {
    calls.push(args);
    const page = (obj) => ({ code: 0, stdout: JSON.stringify({ text: JSON.stringify(obj) }), stderr: '' });
    if (args[0] === 'read' && args[2].includes('get_group/')) return groupReadable ? page({ group: { id: GROUP, members } }) : { code: 1, stdout: '', stderr: 'signed out' };
    if (args[0] === 'read' && args[2].includes('get_expenses')) return page({ expenses });
    if (args[0] === 'commit') {
      if (commitCode) return { code: commitCode, stdout: '', stderr: 'BROWSER ERROR' };
      const plan = JSON.parse(readFileSync(args[args.indexOf('--plan') + 1], 'utf8'));
      const desc = plan.steps.find((s) => s.do === 'fill' && s.selector === 'input.description').value;
      const cost = Math.round((savedCost ?? Number(plan.steps.find((s) => s.selector && s.selector.includes('0.00')).value)) * 100);
      const out = plan.steps.filter((s) => s.do === 'click' && s.selector.includes('data-id')).map((s) => Number(/data-id='(\d+)'/.exec(s.selector)[1]));
      const owing = memberIds().filter((id) => !out.includes(id));
      const shares = equalShares(cost, owing.length);
      expenses.push(entry(5000 + expenses.length, desc, Object.fromEntries(owing.map((id, i) => [id, shares[i]])), { cost }));
      return { code: 0, stdout: '{}', stderr: '' };
    }
    throw new Error(`unexpected agent-browser call ${args.join(' ')}`);
  };
  return { ab, calls, expenses };
}
const go = (w, s, extra = {}) => {
  const lines = [];
  const sent = [];
  const saved = [];
  const ledger = extra.ledger || makeLedger(join(tmp(), 'texts.jsonl'));
  const logDir = tmp();                                   // plans and screenshots never land in the robot's real log folder
  const players = structuredClone(extra.players || PLAYERS);
  const emailLedger = extra.emailLedger || makeEmailLedger(join(tmp(), 'emails-done.json'));
  return {
    lines, sent, ledger, saved, players, emailLedger,
    // The WhatsApp list and the players file are fakes too: a test never reads or writes the real ones.
    run: () => runOnce({ fetchImpl: w.fetchImpl, ab: s.ab, now: () => NOON, log: (l) => lines.push(l), key: 'robot-key-test', players, ledger, logDir,
      whatsapp: () => extra.whatsapp || null,
      // The booking emails and their ledger are fakes as well: never the robot's real files.
      emails: () => extra.emails || null, emailLedger,
      save: (id, add) => { saved.push([id, add]); return { ...(players.players[String(id)] || {}), ...add }; },
      textOne: async (number, text) => { sent.push({ number, text }); return (extra.textOk || (() => ({ ok: true, via: 'iMessage' })))(number); },
      ...extra.opts }),
  };
};

describe('the pure parts', () => {
  const b = booking();
  it('names the entry by day, venue, time and length, as Kevin asked', () => {
    expect(description(b)).toBe('Tue 3 Nov, Testford, 19:30, 90 min');
  });
  it('splits to the penny and always adds up', () => {
    expect(equalShares(3600, 4)).toEqual([900, 900, 900, 900]);
    expect(equalShares(3601, 4)).toEqual([901, 900, 900, 900]);
    for (const [p, n] of [[1000, 3], [3459, 7], [1, 2]]) expect(equalShares(p, n).reduce((a, x) => a + x, 0)).toBe(p);
  });
  it('first names in the text, with an initial when two share one', () => {
    expect(firstNames(['Test Payer', 'Rob Alpha', 'Rob Beta', 'Cat'])).toEqual(['Test', 'Rob A', 'Rob B', 'Cat']);
    expect(textFor(b, ['Ann One', 'Bob Two'], 1800)).toBe('Padel booked: Tue 3 Nov at Testford (Test Padel Club), 19:30 for 90 min. Playing: Ann, Bob. Your share is £18.00 and it\'s in Splitwise to settle up. Kev');
  });
  it('knows an entry for the same date, written any usual way, whatever time it says, and nothing else', () => {
    for (const d of ['Tues 3rd Nov @ 19:30 (90mins)', 'Tue 3 Nov 19:30 Testford', 'Tue 3 Nov, Testford, 19:30, 90 min', '3 nov 19.30',
      'Nov 3rd 19:30', 'Tuesday 3 November 7.30pm', '03 Nov', 'Tues 3rd Nov', 'Padel 3 Nov £36.00', 'Tue 3rd of Nov', '3Nov 19:30', 'Nov. 3',
      'Tue 3 Nov 18:30', 'Tue 3 Nov, Testford, 08:00, 60 min'])           // one booking a day: the time never decides
      expect([d, sameBooking({ description: d, date: AT }, b)]).toEqual([d, true]);
    for (const d of ['Tue 13 Nov 19:30', 'Sun 1 Nov 19:30', 'Tue 3 Oct 19:30', 'Padel', '13/11', '3/12', 'Nov 30th', '23 Nov'])
      expect([d, sameBooking({ description: d, date: AT }, b)]).toEqual([d, false]);
    // Ordinary words and fractions are not dates.
    const on = (date) => booking({ date, day: 'x' });
    for (const [d, date] of [['market 3 balls', '2026-03-03'], ['maybe 5 of us', '2026-05-05'], ['Padel 1/2 court hire', '2026-02-01'],
      ['3 novel ideas', '2026-11-03'], ['juniper 4', '2026-06-04'], ['Padel 3/11', '2026-11-03']])
      expect([d, sameBooking({ description: d }, on(date))]).toEqual([d, false]);
    for (const [d, date] of [['Sat 7 March', '2026-03-07'], ['May 5th', '2026-05-05'], ['4 Sept', '2026-09-04'], ['1st June', '2026-06-01']])
      expect([d, sameBooking({ description: d }, on(date))]).toEqual([d, true]);
    expect(sameBooking({ description: 'Tues 3rd Nov @ 19:30', date: AT, deleted_at: '2026-11-01' }, b)).toBe(false);
    expect(sameBooking({ description: 'Tues 3rd Nov @ 19:30', date: '2025-10-30T10:00:00Z' }, b)).toBe(false);   // last year's
  });
  it('the form unticks exactly the members not playing, saves last, and declares its proof', () => {
    const plan = buildPlan(b, GROUP, MEMBERS, [11, 12, 13]);
    const unticked = plan.steps.filter((s) => s.selector && s.selector.includes('data-id')).map((s) => s.selector);
    expect(unticked).toEqual([".split_method.equal .person[data-id='14'] input.share", ".split_method.equal .person[data-id='15'] input.share", ".split_method.equal .person[data-id='16'] input.share"]);
    expect(plan.steps[plan.steps.length - 1]).toEqual({ do: 'submit', selector: "button.submit:has-text('Save')" });
    expect(plan.steps.filter((s) => s.do === 'submit')).toHaveLength(1);
    expect(plan.confirm.selector).toBe('text="Tue 3 Nov, Testford, 19:30, 90 min"');
    expect(plan.steps.find((s) => s.selector === "input[placeholder='0.00']")).toEqual({ do: 'fill', selector: "input[placeholder='0.00']", value: '36.00', typed: true });
    // Save only once the form shows a real share per person (5 Nov 2026: "£0.00/person" at 06:00).
    expect(plan.steps[plan.steps.length - 2]).toEqual({ do: 'wait', for: 'text=/\\(£(12\\.00)\\/person\\)/', ms: 15000 });   // £36 for 3
    expect(perPersonShown(3460, 7)).toBe('text=/\\(£(4\\.94)\\/person\\)/');                     // Tue 10 Nov: £34.60 for seven
    expect(perPersonShown(1000, 6)).toBe('text=/\\(£(1\\.66|1\\.67)\\/person\\)/');            // rounded down or to the nearest
  });
  it('checks an entry against the booking: total, exactly the players owing, paid by Kevin', () => {
    const d = description(b);
    expect(checkEntry(entry(1, d, NINES), b, 11, [11, 12, 13, 14])).toMatchObject({ ok: true, id: 1, owes: NINES });
    expect(checkEntry(entry(1, d, { 11: 1200, 12: 800, 13: 800, 14: 800 }), b, 11, [14, 12, 13, 11]).ok).toBe(true);     // uneven is fine
    expect(checkEntry(entry(1, d, { 11: 750, 12: 750, 13: 750, 14: 750 }), b, 11, [11, 12, 13, 14]).why).toBe('the entry says £30.00, not £36.00');
    expect(checkEntry(entry(1, d, { 11: 720, 12: 720, 13: 720, 14: 720, 15: 720 }), b, 11, [11, 12, 13, 14]).ok).toBe(false);
    expect(checkEntry(entry(1, d, NINES, { paid: 12 }), b, 11, [11, 12, 13, 14]).why).toBe('the entry is not paid by Kevin');
    expect(checkEntry(null, b, 11, [11]).ok).toBe(false);
    // Ids of different lengths: compared as numbers, not as text.
    expect(checkEntry(entry(1, d, { 11: 1800, 127: 1800 }), b, 11, [127, 11]).ok).toBe(true);
  });
  it('texts only by day: a step starts 07:30 to 21:00, and no text goes after 21:30 London', () => {
    expect(textStart(Date.parse('2026-11-01T20:59:00Z'))).toBe(true);
    expect(textStart(Date.parse('2026-11-01T21:00:00Z'))).toBe(false);
    expect(textHours(Date.parse('2026-11-01T21:00:00Z'))).toBe(true);
    expect(textHours(Date.parse('2026-11-01T07:29:00Z'))).toBe(false);
    expect(textHours(Date.parse('2026-11-01T07:30:00Z'))).toBe(true);
    expect(textHours(Date.parse('2026-07-01T20:29:00Z'))).toBe(true);    // 21:29 BST
    expect(textHours(Date.parse('2026-07-01T20:30:00Z'))).toBe(false);   // 21:30 BST
  });
});

describe('the texts ledger', () => {
  it('a person\'s last line decides: sent or unsure is never again, only a refused send may go again', () => {
    const file = join(tmp(), 'texts.jsonl');
    const l = makeLedger(file);
    const mayGo = (slot, person) => { const r = l.last(slot, person); return !r || r.ok === false; };
    expect(mayGo('s', 2)).toBe(true);                                    // no file yet
    l.add({ slot: 's', person: 2, state: 'sending' });
    expect(mayGo('s', 2)).toBe(false);                                   // stopped mid-send: never risk a second
    l.add({ slot: 's', person: 2, ok: false });
    expect(mayGo('s', 2)).toBe(true);                                    // Messages refused it: may go again
    l.add({ slot: 's', person: 2, state: 'sending' });
    l.add({ slot: 's', person: 2, ok: null });
    expect(mayGo('s', 2)).toBe(false);                                   // unsure: never again
    l.add({ slot: 's', person: 3, ok: true });
    expect(mayGo('s', 3)).toBe(false);
    expect(mayGo('other', 2)).toBe(true);
  });
  it('a ledger it cannot read stops the run rather than guessing', () => {
    const file = join(tmp(), 'texts.jsonl');
    writeFileSync(file, '{"slot":"s","person":2,"ok":true}\n{not json\n');
    expect(() => makeLedger(file).last('s', 2)).toThrow();
  });
});

describe('a run', () => {
  it('nothing paid and waiting: silent, and Splitwise is not touched', async () => {
    const s = splitwise();
    const r = go(worker([]), s);
    expect(await r.run()).toBe(0);
    expect(s.calls).toEqual([]);
    expect(r.lines).toEqual([]);
  });

  it('a new paid booking: read the group, claim with the version read, save through commit --padel-slot, read it back, done', async () => {
    const w = worker([booking()]);
    const s = splitwise();
    const r = go(w, s);
    expect(await r.run()).toBe(0);
    expect(w.posts.map((p) => [p.step, p.state, p.paidAt])).toEqual([['splitwise', 'claimed', AT], ['splitwise', 'done', AT]]);
    expect(w.posts[1].note).toBe('entry 5000');
    const commit = s.calls.find((c) => c[0] === 'commit');
    expect(commit.slice(commit.indexOf('--padel-slot'), commit.indexOf('--padel-slot') + 4)).toEqual(['--padel-slot', '2026-11-03|19', '--padel-paid-at', AT]);
    expect(s.calls.map((c) => c[0])).toEqual(['read', 'read', 'commit', 'read']);
    expect(s.expenses[0].users.filter((u) => u.owed_share !== '0.00').map((u) => u.user_id)).toEqual([11, 12, 13, 14]);
    expect(r.sent).toEqual([]);                               // texts wait for the next run, after Splitwise is done
  });

  it('Splitwise pings the players too, so the step waits for 07:30 to 21:00 (5 Nov 2026: paid at 00:40 would have pinged six phones at 06:00)', async () => {
    const w = worker([booking()]);
    const s = splitwise();
    for (const t of ['2026-11-01T06:00:00Z', '2026-11-01T07:29:00Z', '2026-11-01T21:05:00Z', '2026-11-01T23:59:00Z']) {
      expect(await go(w, s, { opts: { now: () => Date.parse(t) } }).run()).toBe(0);
    }
    expect(w.posts).toEqual([]);                              // not even claimed
    expect(s.calls).toEqual([]);                              // Splitwise not opened
    expect(await go(w, s, { opts: { now: () => Date.parse('2026-11-01T07:30:00Z') } }).run()).toBe(0);
    expect(w.posts.map((p) => [p.step, p.state])).toEqual([['splitwise', 'claimed'], ['splitwise', 'done']]);
    const late = worker([booking()]);
    expect(await go(late, splitwise(), { opts: { now: () => Date.parse('2026-11-01T21:00:00Z') } }).run()).toBe(0);
    expect(late.posts).toEqual([]);                           // 21:00 is past the last start
    expect(await go(late, splitwise(), { opts: { now: () => Date.parse('2026-11-01T20:59:00Z') } }).run()).toBe(0);
    expect(late.posts[0]).toMatchObject({ step: 'splitwise', state: 'claimed' });
  });

  it('then the texts: each player but Kevin gets one, with his or her own share from the entry', async () => {
    const w = worker([booking({ pricePence: 3601 })]);
    const r = go(w, splitwise());
    await r.run();                                            // Splitwise
    expect(await r.run()).toBe(0);                            // texts
    expect(r.sent.map((x) => x.number)).toEqual(['+447700900002', '+447700900003', '+447700900004']);
    // Splitwise gave the odd penny to the first person owing (the payer here), so each text says £9.00.
    expect(r.sent.every((x) => x.text.includes('Your share is £9.00'))).toBe(true);
    expect(r.sent[0].text).toMatch(/^Padel booked: Tue 3 Nov at Testford \(Test Padel Club\), 19:30 for 90 min\. Playing: Test P, Test B, Test C, Test D\./);
    expect(w.posts.slice(-2).map((p) => [p.step, p.state, p.note])).toEqual([['texts', 'claimed', undefined], ['texts', 'done', '3 of 3 sent']]);
    await r.run();                                            // finished: nothing more
    expect(r.sent).toHaveLength(3);
  });

  it('an entry Kevin added himself that agrees: no second entry, done, and the texts quote HIS shares', async () => {
    const w = worker([booking()]);
    const s = splitwise({ expenses: [entry(77, 'Tues 3rd Nov @ 19:30 (90mins)', { 11: 1200, 12: 800, 13: 800, 14: 800 })] });
    const r = go(w, s);
    expect(await r.run()).toBe(0);
    expect(s.calls.some((c) => c[0] === 'commit')).toBe(false);
    expect(w.posts.map((p) => [p.state, p.note])).toEqual([['claimed', undefined], ['done', 'already in Splitwise (entry 77)']]);
    expect(await r.run()).toBe(0);
    expect(r.sent.map((x) => /£[\d.]+/.exec(x.text)[0])).toEqual(['£8.00', '£8.00', '£8.00']);
  });

  it('an entry already there that disagrees (Kevin\'s own, or the robot\'s wrong one before a Retry): failed, never done, no texts', async () => {
    for (const e of [entry(77, 'Tue 3 Nov 19:30 padel', { 11: 1000, 12: 1000, 13: 1000, 14: 1000 }),       // £40, not £36
      entry(78, 'Tue 3 Nov, Testford, 19:30, 90 min', { 11: 750, 12: 750, 13: 750, 14: 750 })]) {            // the robot's, saved at £30
      const w = worker([booking()]);
      const s = splitwise({ expenses: [e] });
      const r = go(w, s);
      expect(await r.run()).toBe(1);
      expect(s.calls.some((c) => c[0] === 'commit')).toBe(false);
      expect(w.posts.at(-1)).toMatchObject({ step: 'splitwise', state: 'failed' });
      expect(w.posts.at(-1).note).toMatch(/^an entry for this day is already in Splitwise, but the entry says £\d+\.00, not £36\.00: correct it, then Retry$/);
      await r.run();
      expect(r.sent).toEqual([]);
    }
  });

  it('two entries for the day already: failed for Kevin to sort out, no third', async () => {
    const w = worker([booking()]);
    const s = splitwise({ expenses: [entry(77, 'Tues 3rd Nov @ 19:30', NINES), entry(78, 'Padel 3 Nov', NINES)] });
    expect(await go(w, s).run()).toBe(1);
    expect(s.calls.some((c) => c[0] === 'commit')).toBe(false);
    expect(w.posts.at(-1).note).toBe('2 entries for this day are already in Splitwise: check them before Retry');
  });

  it('a claim that does not win (the booking changed, or another run has it): no save at all', async () => {
    const w = worker([booking()], { refuse: (p) => p.state === 'claimed' });
    const s = splitwise();
    expect(await go(w, s).run()).toBe(0);
    expect(s.calls.some((c) => c[0] === 'commit')).toBe(false);
  });

  it('a done the Worker does not record is loud', async () => {
    const w = worker([booking()], { refuse: (p) => p.state === 'done' });
    const r = go(w, splitwise());
    expect(await r.run()).toBe(1);
    expect(r.lines[0]).toMatch(/2026-11-03\|19 splitwise: the Worker did not record done/);
  });

  it('a robot signed out of Splitwise: nothing claimed, FAILED, tried again next run', async () => {
    const w = worker([booking()]);
    const r = go(w, splitwise({ groupReadable: false }));
    expect(await r.run()).toBe(1);
    expect(w.posts).toEqual([]);
    expect(r.lines[0]).toMatch(/^FAILED: padel-paid: 2026-11-03\|19 Splitwise: could not read the Splitwise group/);
  });

  it('a player not in the Splitwise group: the step fails naming the player for Kevin (the log says a count), and nothing is saved', async () => {
    const w = worker([booking({ players: [{ id: 1, name: 'Test Payer' }, { id: 9, name: 'Test Out' }] })]);
    const s = splitwise();
    const r = go(w, s);
    expect(await r.run()).toBe(1);
    expect(s.calls.some((c) => c[0] === 'commit')).toBe(false);
    expect(w.posts.map((p) => [p.state, p.note])).toEqual([['claimed', undefined], ['failed', 'Test Out: not in the Splitwise group under that name. Fix it, then Retry']]);
    expect(r.saved).toEqual([]);
    expect(r.lines.join('\n')).not.toMatch(/Test Out/);
  });

  it('a save that does not go through, or saves the wrong thing: failed, and only Kevin\'s Retry tries again', async () => {
    const w = worker([booking()]);
    expect(await go(w, splitwise({ commitCode: 1 })).run()).toBe(1);
    expect(w.posts.at(-1)).toMatchObject({ step: 'splitwise', state: 'failed', note: 'the robot could not save it: check Splitwise before Retry' });
    const w2 = worker([booking()]);
    expect(await go(w2, splitwise({ savedCost: 30 })).run()).toBe(1);
    expect(w2.posts.at(-1).note).toBe('saved, but the entry says £30.00, not £36.00: check Splitwise');
    const before = w2.posts.length;
    await go(w2, splitwise()).run();                         // failed waits: no claim, no save
    expect(w2.posts.length).toBe(before);
  });

  it('a text is never sent twice to one person, and a step with a refused text says how many went and why', async () => {
    const b = booking({ splitwise: { state: 'done', at: AT, note: 'entry 1' } });
    const w = worker([b]);
    const s = splitwise({ expenses: [entry(1, description(b), NINES)] });
    const r = go(w, s, { textOk: (n) => (n.endsWith('03') ? { ok: false, why: 'Messages refused both iMessage and SMS' } : { ok: true, via: 'SMS' }) });
    r.ledger.add({ slot: b.slot, person: 2, ok: true });     // Bob was already texted
    expect(await r.run()).toBe(1);
    expect(r.sent.map((x) => x.number)).toEqual(['+447700900003', '+447700900004']);
    expect(w.posts.at(-1)).toMatchObject({ step: 'texts', state: 'failed', note: '2 of 3 sent: Messages refused both iMessage and SMS' });
  });

  // 5 Nov 2026: from the scheduled run the robot (node) may not read Messages, so a text is checked a run
  // later, against the record padel-delivery.py writes under bash.
  it('texts not yet confirmed keep the step open; the next run decides each once: delivered, one SMS only for a recorded failure, else not confirmed', async () => {
    const b = booking({ splitwise: { state: 'done', at: AT, note: 'entry 1' } });
    const w = worker([b], { clock: () => new Date(NOON).toISOString() });
    const sms = [];
    const record = {
      '+447700900002': { known: true, readable: true, error: 0, sent: true, delivered: true },
      '+447700900003': { known: true, readable: true, error: 22, sent: false, delivered: false },
      '+447700900004': { known: false, readable: true },                         // Messages holds no such text
    };
    const r = go(w, splitwise({ expenses: [entry(1, description(b), NINES)] }), {
      textOk: () => ({ ok: null, via: 'iMessage (checked on the next run)' }),
      opts: { delivery: async (n) => record[n], sendSms: async (n, t) => { sms.push({ n, t }); return { code: 0 }; } } });
    expect(await r.run()).toBe(0);
    expect(r.sent).toHaveLength(3);
    expect(w.posts.map((p) => [p.step, p.state])).toEqual([['texts', 'claimed']]);   // open: nothing confirmed yet
    expect(await r.run()).toBe(0);                                                   // the next run
    expect(sms.map((x) => x.n)).toEqual(['+447700900003']);                          // a recorded failure only
    expect(sms[0].t).toBe(r.sent[1].text);                                            // the same words, once
    expect(w.posts.at(-1)).toMatchObject({ step: 'texts', state: 'done', note: '3 of 3 sent, 1 by SMS (2 not confirmed)' });   // an SMS is only queued
    expect(r.sent).toHaveLength(3);                                                   // no second iMessage
    await r.run();
    expect(sms).toHaveLength(1);                                                      // finished: nothing more
  });

  it('a follow-up that still cannot read Messages counts them as sent, sends nothing more, and says so', async () => {
    const b = booking({ splitwise: { state: 'done', at: AT, note: 'entry 1' } });
    const w = worker([b], { clock: () => new Date(NOON).toISOString() });
    const sms = [];
    const r = go(w, splitwise({ expenses: [entry(1, description(b), NINES)] }), {
      textOk: () => ({ ok: null, via: 'iMessage (delivery not readable)' }),
      opts: { delivery: async () => ({ known: false, readable: false }), sendSms: async (n) => { sms.push(n); return { code: 0 }; } } });
    r.ledger.add({ at: new Date(NOON).toISOString(), slot: b.slot, person: 2, state: 'sending' });   // a run that stopped mid-send for Bob
    await r.run();
    expect(r.sent.map((x) => x.number)).toEqual(['+447700900003', '+447700900004']);   // Bob is never texted twice
    await r.run();
    expect(sms).toEqual([]);
    expect(w.posts.at(-1)).toMatchObject({ state: 'done', note: '3 of 3 sent (3 not confirmed)' });
  });

  it('a mobile the robot linked this week is named on the follow-up\'s note too (review, 6 Nov 2026)', async () => {
    const b = booking({ splitwise: { state: 'done', at: AT, note: 'entry 1' } });
    const w = worker([b], { clock: () => new Date(NOON).toISOString() });
    const players = structuredClone(PLAYERS);
    Object.assign(players.players[3], { mobile_as: 'mobile from your contacts', linked_at: '2026-11-01' });
    const r = go(w, splitwise({ expenses: [entry(1, description(b), NINES)] }), { players,
      textOk: () => ({ ok: null, via: 'iMessage (delivery not readable)' }),
      opts: { delivery: async () => ({ known: false, readable: false }), sendSms: async () => ({ code: 0 }) } });
    await r.run();
    expect(w.posts.at(-1)).toMatchObject({ step: 'texts', state: 'claimed' });   // not confirmed yet: no note
    await r.run();
    expect(w.posts.at(-1)).toMatchObject({ state: 'done', note: '3 of 3 sent (3 not confirmed); new: Test Cat = Splitwise set by you, mobile from your contacts' });
  });

  // Review of PR 887: pending, sent-not-delivered and missing are never a reason for a second text;
  // the decision is made once; the SMS cut-off is checked before each SMS; THE text is the one sent.
  const followUp = async ({ record, refuseDone = false, clocks = null }) => {
    const b = booking({ splitwise: { state: 'done', at: AT, note: 'entry 1' } });
    let doneRefused = refuseDone;
    let n = 0;
    const clock = () => (clocks ? clocks(n) : NOON);
    const w = worker([b], { clock: () => new Date(clock()).toISOString(), refuse: (p) => p.state === 'done' && doneRefused && ((doneRefused = false) || true) });
    const sms = [];
    const asked = [];
    const r = go(w, splitwise({ expenses: [entry(1, description(b), NINES)] }), {
      textOk: () => ({ ok: null, via: 'iMessage (checked on the next run)' }),
      opts: { now: clock, delivery: async (num, since) => { asked.push(since); return record[num] || { known: false, readable: true }; },
        sendSms: async (num) => { sms.push(num); n++; return { code: 0 }; } } });
    await r.run();
    await r.run();
    return { r, w, sms, asked };
  };
  it('a pending iMessage, or one sent but not delivered: not confirmed, no SMS', async () => {
    const { sms, w } = await followUp({ record: {
      '+447700900002': { known: true, readable: true, error: 0, sent: false, delivered: false },
      '+447700900003': { known: true, readable: true, error: 0, sent: true, delivered: false },
      '+447700900004': { known: true, readable: true, error: 0, sent: true, delivered: true } } });
    expect(sms).toEqual([]);
    expect(w.posts.at(-1)).toMatchObject({ state: 'done', note: '3 of 3 sent (2 not confirmed)' });
  });
  it('the follow-up asks about the moment each text went, and decides once even when the Worker misses the done', async () => {
    const fail = { known: true, readable: true, error: 22 };
    const { r, sms, asked, w } = await followUp({ record: { '+447700900003': fail }, refuseDone: true });
    expect(asked).toEqual(Array(3).fill(NOON - 2000));                               // the sending moment, not the result line
    expect(sms).toEqual(['+447700900003']);
    expect(w.posts.at(-1)).toMatchObject({ state: 'done' });                         // refused once, then written on the next run
    await r.run();
    expect(sms).toEqual(['+447700900003']);                                           // never a second SMS
  });
  it('a send Messages never answered is not confirmed by a later delivered text to the same person', async () => {
    const b = booking({ splitwise: { state: 'done', at: AT, note: 'entry 1' } });
    const w = worker([b], { clock: () => new Date(NOON).toISOString() });
    const r = go(w, splitwise({ expenses: [entry(1, description(b), NINES)] }), {
      textOk: () => ({ ok: null, via: 'iMessage (Messages did not answer)' }),
      opts: { delivery: async () => ({ known: true, readable: true, error: 0, sent: true, delivered: true }), sendSms: async () => ({ code: 0 }) } });
    await r.run();
    await r.run();
    expect(w.posts.at(-1)).toMatchObject({ state: 'done', note: '3 of 3 sent (3 not confirmed)' });
  });
  it('the 21:30 cut-off is checked before each SMS', async () => {
    const fail = { known: true, readable: true, error: 22 };
    const { sms, w } = await followUp({ record: { '+447700900002': fail, '+447700900003': fail },
      clocks: (sent) => (sent ? Date.parse('2026-11-01T21:31:00Z') : Date.parse('2026-11-01T20:50:00Z')) });
    expect(sms).toEqual(['+447700900002']);
    expect(w.posts.at(-1).note).toBe('3 of 3 sent, 1 by SMS (3 not confirmed)');
  });

  it('the follow-up waits outside the text hours, and a stale open step is failed, not followed up', async () => {
    const b = booking({ splitwise: { state: 'done', at: AT, note: 'entry 1' }, texts: { state: 'claimed', at: '2026-11-01T21:20:00.000Z', note: null } });
    const w = worker([b]);
    const sms = [];
    const opts = { delivery: async () => ({ known: true, readable: true, error: 22 }), sendSms: async (n) => { sms.push(n); return { code: 0 }; } };
    const r = go(w, splitwise(), { opts: { ...opts, now: () => Date.parse('2026-11-01T21:35:00Z') } });
    r.ledger.add({ at: '2026-11-01T21:20:00.000Z', slot: b.slot, person: 2, ok: null, via: 'x', text: 'hi' });
    expect(await r.run()).toBe(0);
    expect(sms).toEqual([]);                                                          // 21:35: no SMS at night
    expect(w.posts).toEqual([]);
    expect(await go(w, splitwise(), { ledger: r.ledger, opts: { ...opts, now: () => Date.parse('2026-11-02T08:00:00Z') } }).run()).toBe(1);
    expect(sms).toEqual([]);                                                          // left overnight: failed for Kevin, no SMS
    expect(w.posts).toEqual([expect.objectContaining({ step: 'texts', state: 'failed' })]);
  });

  it('an entry changed in Splitwise after it was checked: no texts, and the step says why', async () => {
    const b = booking({ splitwise: { state: 'done', at: AT, note: 'entry 1' } });
    const w = worker([b]);
    const r = go(w, splitwise({ expenses: [entry(1, description(b), { 11: 1200, 12: 1200, 13: 1200 })] }));
    expect(await r.run()).toBe(1);
    expect(r.sent).toEqual([]);
    expect(w.posts.at(-1).note).toBe('no texts sent: the Splitwise entry no longer matches (3 people owe on the entry, not the 4 playing)');
  });

  it('texts stop at 21:30 even mid-run, and a claim left half-done for 30 minutes is failed for Kevin to check', async () => {
    const b = booking({ splitwise: { state: 'done', at: AT, note: 'entry 1' } });
    const w = worker([b]);
    const r = go(w, splitwise({ expenses: [entry(1, description(b), NINES)] }), {
      opts: { now: () => Date.parse(r.sent.length ? '2026-11-01T21:31:00Z' : '2026-11-01T20:59:00Z') } });   // the Mac slept mid-run
    expect(await r.run()).toBe(1);
    expect(r.sent).toHaveLength(1);
    expect(w.posts.at(-1)).toMatchObject({ step: 'texts', state: 'failed', note: '1 of 3 sent; the rest wait: Retry after 07:30' });
    const w2 = worker([booking({ splitwise: { state: 'done', at: AT, note: 'entry 1' } })]);
    for (const late of ['2026-11-01T21:05:00Z', '2026-11-01T22:00:00Z', '2026-11-01T07:00:00Z']) {
      const r2 = go(w2, splitwise(), { opts: { now: () => Date.parse(late) } });
      expect(await r2.run()).toBe(0);
    }
    expect(w2.posts).toEqual([]);                             // outside 07:30 to 21:00: not even claimed
    const w3 = worker([booking({ splitwise: { state: 'claimed', at: '2026-11-01T11:00:00.000Z', note: null } })]);
    expect(await go(w3, splitwise()).run()).toBe(1);
    expect(w3.posts).toEqual([expect.objectContaining({ step: 'splitwise', state: 'failed', note: 'the robot stopped part-way: check Splitwise before Retry' })]);
  });
});

describe("a new player's entry: Kevin sets them up, the robot links them (6 Nov 2026)", () => {
  // Splitwise members as the group lists them. Every name is invented.
  const SWM = [
    { id: 21, first_name: 'Ola', last_name: 'Nordmann' }, { id: 22, first_name: 'Samuel', last_name: 'Fairweather' },
    { id: 23, first_name: 'Ivo', last_name: 'T' }, { id: 24, first_name: 'Pip', last_name: null },
    { id: 25, first_name: 'Pat', last_name: 'One' }, { id: 26, first_name: 'Pat', last_name: 'Two' },
    { id: 27, first_name: 'José', last_name: 'Ávila' },
  ];
  // The Padel WhatsApp group as padel-delivery.py writes it.
  const WA = [
    { contact: ['Ola Nordmann'], pushname: 'Ola', phones: ['+447700900051'] },
    { contact: ['Sam Fairweather'], pushname: 'Sammy', phones: ['+447700900052'] },
    { contact: [], pushname: 'Ivo Testerton', phones: ['+447700900053'] },
    { contact: ['Ola Nordmann'], pushname: null, phones: ['+447700900051'] },     // the same person under an old id
    { contact: [], pushname: 'Rich', phones: ['+447700900054'] },
    { contact: [], pushname: 'Rich', phones: ['+447700900055'] },
  ];

  it('Splitwise: the full name first, then a longer first name or a surname initial, then a member with no surname; two at one level is never a guess', () => {
    expect(matchSplitwise(['Ola Nordmann'], SWM)).toEqual({ id: 21, as: 'Ola Nordmann' });
    expect(matchSplitwise(['Ivo Testerton'], SWM).as).toBe('Ivo T');                 // what Splitwise calls them, for Kevin's note
    expect(matchSplitwise(['Sam Fairweather'], SWM).id).toBe(22);          // "Sam" starts "Samuel"
    expect(matchSplitwise(['Ivo Testerton'], SWM).id).toBe(23);            // "Ivo T"
    expect(matchSplitwise(['Pip Larkin'], SWM).id).toBe(24);               // "Pip", no surname
    expect(matchSplitwise(['jose avila'], SWM).id).toBe(27);               // accents and case do not matter
    expect(matchSplitwise(['Pat'], SWM).why).toBe('not in the Splitwise group under that name');   // a first name alone never picks one
    expect(matchSplitwise(['Pat One', 'Pat Two'], SWM).why).toBe('2 people in the Splitwise group could be them');
    expect(matchSplitwise(['Al Nordmann'], SWM).why).toBe('not in the Splitwise group under that name');   // two letters is not a first name that fits
    expect(matchSplitwise(['Una Known'], SWM).why).toBe('not in the Splitwise group under that name');
  });

  it('Splitwise: never a look-alike (review, 6 Nov 2026): a longer surname, a full name held as a first name, a one-word name over a surname', () => {
    expect(matchSplitwise(['Tom Smithson'], [{ id: 31, first_name: 'Tom', last_name: 'Smith' }]).why).toBe('not in the Splitwise group under that name');
    expect(matchSplitwise(['Sam Fox'], [{ id: 32, first_name: 'Sam Fairweather', last_name: null }]).why).toBe('not in the Splitwise group under that name');
    expect(matchSplitwise(['Sam Fairweather'], [{ id: 32, first_name: 'Sam Fairweather', last_name: null }]).id).toBe(32);
    expect(matchSplitwise(['Rich', 'Richard Jones'], [{ id: 33, first_name: 'Rich', last_name: null }, { id: 34, first_name: 'Richard', last_name: 'J' }]).id).toBe(34);
    expect(matchSplitwise(['Lee Drake', 'Leon Drake'], [{ id: 35, first_name: 'Lee', last_name: 'Drake' }, { id: 36, first_name: 'Leon', last_name: 'Drake' }]).why).toBe('2 people in the Splitwise group could be them');   // the app and Kevin's contacts disagree: no guess
  });

  it("Splitwise: a member another player's entry already has is never picked, even when the name fits", () => {
    expect(matchSplitwise(['Pip Larkin'], SWM, new Set([24])).why).toBe('not in the Splitwise group under that name');
    expect(matchSplitwise(['Pat One', 'Pat Two'], SWM, new Set([26])).id).toBe(25);
  });

  it("mobile: by the name in Kevin's contacts, else the name the person gave WhatsApp; one number, and nobody else's", () => {
    expect(matchPhone(['Ola Nordmann'], WA)).toMatchObject({ phone: '+447700900051', contact: 'Ola Nordmann' });   // listed twice, one number
    expect(matchPhone(['Sam Fairweather'], WA)).toMatchObject({ phone: '+447700900052', contact: 'Sam Fairweather' });
    expect(matchPhone(['Ivo Testerton'], WA)).toEqual({ phone: '+447700900053', contact: null, as: 'mobile from their WhatsApp name' });
    expect(matchPhone(['Ola Nordmann'], WA).as).toBe('mobile from your contacts');
    expect(matchPhone(['Rich'], WA).why).toBe('2 mobiles in the Padel WhatsApp group fit that name');
    expect(matchPhone(['Una Known'], WA).why).toBe('not in the Padel WhatsApp group under that name');
    expect(matchPhone(['Ola Nordmann'], WA, new Set(['7700900051'])).why).toBe('their mobile is already on another player');
    // Found by elimination: the contact name comes with THAT number, never the other Rich's.
    const twoRichs = [{ contact: ['Richard Jones'], pushname: 'Rich', phones: ['+447700900061'] }, { contact: [], pushname: 'Rich', phones: ['+447700900062'] }];
    expect(matchPhone(['Rich'], twoRichs, new Set(['7700900061']))).toMatchObject({ phone: '+447700900062', contact: null });
  });

  it('an entry is only ever added to: what is there stays, and a new one gets the name the app shows and the contact name', () => {
    const players = { players: { 1: { self: true, splitwise_id: 99, phones: ['+447700900001'] }, 5: { page_name: 'Ivo', phones: ['+447700900099'] } } };
    const today = '2026-11-06';
    expect(linkPlayer({ id: 5, name: 'Ivo Testerton' }, players, { members: SWM, whatsapp: WA, today }))
      .toEqual({ add: { splitwise_id: 23, splitwise_as: 'Ivo T', linked_at: today }, problems: [] });
    expect(linkPlayer({ id: 7, name: 'Sam Fairweather', nick: 'Sammy' }, players, { members: SWM, whatsapp: WA, today }))
      .toEqual({ add: { phones: ['+447700900052'], mobile_as: 'mobile from your contacts', splitwise_id: 22, splitwise_as: 'Samuel Fairweather', page_name: 'Sammy', contact: 'Sam Fairweather', linked_at: today }, problems: [] });
    expect(linkPlayer({ id: 8, name: 'Una Known' }, players, { members: SWM, whatsapp: null }))
      .toEqual({ add: {}, problems: ["couldn't read the Padel WhatsApp group", 'not in the Splitwise group under that name'] });
    expect(linkPlayer({ id: 1, name: 'Test Payer' }, players, { members: SWM, whatsapp: null })).toEqual({ add: {}, problems: [] });   // complete: nothing looked for
    const noPhone = { players: { 1: { self: true, splitwise_id: 99 } } };
    expect(linkPlayer({ id: 1, name: 'Ola Nordmann' }, noPhone, { members: SWM, whatsapp: WA })).toEqual({ add: {}, problems: [] });   // Kevin's own entry is never touched
    expect(linkPlayer({ id: 9, name: 'Ivo Testerton' }, players, { members: SWM, whatsapp: WA, today }).add)
      .toEqual({ phones: ['+447700900053'], mobile_as: 'mobile from their WhatsApp name', splitwise_id: 23, splitwise_as: 'Ivo T', page_name: 'Ivo Testerton', linked_at: today });   // no contact name known: none written, so a real one can follow
  });

  it('the WhatsApp list is used only while padel-delivery.py keeps it fresh (a day)', () => {
    const file = join(tmp(), 'whatsapp.json');
    writeFileSync(file, JSON.stringify({ at: NOON - 3600000, members: WA }));
    expect(readWhatsapp(file, () => NOON)).toEqual(WA);
    expect(readWhatsapp(file, () => NOON + 25 * 3600000)).toBe(null);
    writeFileSync(file, JSON.stringify({ at: NOON, members: [] }));
    expect(readWhatsapp(file, () => NOON)).toBe(null);
  });

  it('the save reads the file fresh, adds only what is missing, keeps it private, and leaves no temp file', () => {
    const dir = tmp();
    const file = join(dir, 'players.json');
    writeFileSync(file, JSON.stringify({ _note: 'kept', players: { 1: { self: true, splitwise_id: 99 }, 5: { page_name: 'Ivo', phones: ['+447700900099'] } }, splitwise_group: { id: GROUP } }), { mode: 0o644 });
    saveLink(5, { splitwise_id: 23, splitwise_as: 'Ivo T', phones: ['+447700900053'], mobile_as: 'mobile from your contacts', linked_at: '2026-11-01' }, file);
    saveLink(7, { phones: ['+447700900052'], splitwise_id: 22, page_name: 'Sammy', contact: 'Sam Fairweather' }, file);
    const got = JSON.parse(readFileSync(file, 'utf8'));
    expect(got._note).toBe('kept');
    expect(got.players[1]).toEqual({ self: true, splitwise_id: 99 });
    // The number already there stays, and no note is written about a number the robot did not set.
    expect(got.players[5]).toEqual({ page_name: 'Ivo', phones: ['+447700900099'], splitwise_id: 23, splitwise_as: 'Ivo T', linked_at: '2026-11-01' });
    saveLink(5, { splitwise_id: 24, splitwise_as: 'Pip', linked_at: '2026-11-09' }, file);   // nothing new written: the day stays too
    expect(JSON.parse(readFileSync(file, 'utf8')).players[5]).toMatchObject({ splitwise_id: 23, splitwise_as: 'Ivo T', linked_at: '2026-11-01' });
    saveLink(5, { contact: 'Ivo Testerton', linked_at: '2026-11-09' }, file);                 // something new: the week starts again
    expect(JSON.parse(readFileSync(file, 'utf8')).players[5]).toMatchObject({ contact: 'Ivo Testerton', linked_at: '2026-11-09' });
    expect(got.players[7]).toEqual({ phones: ['+447700900052'], splitwise_id: 22, page_name: 'Sammy', contact: 'Sam Fairweather' });
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).players)).toEqual(['1', '5', '7']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => statSync(`${file}.tmp`)).toThrow();
    expect(readWhatsapp(join(dir, 'missing.json'))).toBe(null);
  });

  const NEWBIE = [{ id: 1, name: 'Test Payer' }, { id: 2, name: 'Test Bob' }, { id: 7, name: 'Sam Fairweather', nick: 'Sammy' }];
  const NEW_MEMBERS = [...MEMBERS.map((id) => ({ id })), { id: 22, first_name: 'Samuel', last_name: 'Fairweather' }];

  it('a player with no entry on a paid booking: linked, saved, on the Splitwise entry, and texted; the log names nobody', async () => {
    const w = worker([booking({ players: NEWBIE, pricePence: 3000 })]);
    const s = splitwise({ members: NEW_MEMBERS });
    const r = go(w, s, { whatsapp: WA });
    expect(await r.run()).toBe(0);
    expect(r.saved).toEqual([[7, { phones: ['+447700900052'], mobile_as: 'mobile from your contacts', splitwise_id: 22, splitwise_as: 'Samuel Fairweather', page_name: 'Sammy', contact: 'Sam Fairweather', linked_at: '2026-11-01' }]]);
    expect(w.posts.map((p) => [p.step, p.state])).toEqual([['splitwise', 'claimed'], ['splitwise', 'done']]);
    expect(w.posts[1].note).toBe('entry 5000; new: Sam Fairweather = Splitwise Samuel Fairweather, mobile from your contacts');   // Kevin sees what the robot matched
    expect(Object.keys(s.expenses[0].users.filter((u) => Number(u.owed_share) > 0).reduce((a, u) => ({ ...a, [u.user_id]: 1 }), {})).map(Number)).toEqual([11, 12, 22]);
    expect(await r.run()).toBe(0);                                    // the next run: the texts
    expect(r.sent.map((x) => x.number)).toEqual(['+447700900002', '+447700900052']);
    expect(r.lines.join('\n')).not.toMatch(/Sam|Fairweather|7700900052/);
  });

  it('a new player Kevin has not put in Splitwise: failed with the name and both fixes, nothing on Splitwise, the mobile it found kept', async () => {
    const w = worker([booking({ players: [{ id: 1, name: 'Test Payer' }, { id: 7, name: 'Sam Fairweather' }] })]);
    const s = splitwise();
    const r = go(w, s, { whatsapp: [] });
    expect(await r.run()).toBe(1);
    expect(s.calls.some((c) => c[0] === 'commit')).toBe(false);
    expect(w.posts.at(-1).note).toBe('Sam Fairweather: not in the Padel WhatsApp group under that name, not in the Splitwise group under that name. Fix it, then Retry');
    expect(r.saved).toEqual([]);
    const r2 = go(worker([booking({ players: [{ id: 1, name: 'Test Payer' }, { id: 7, name: 'Sam Fairweather' }] })]), splitwise(), { whatsapp: WA });
    expect(await r2.run()).toBe(1);
    expect(r2.saved).toEqual([[7, { phones: ['+447700900052'], mobile_as: 'mobile from your contacts', page_name: 'Sam Fairweather', contact: 'Sam Fairweather', linked_at: '2026-11-01' }]]);
  });

  it('a link made in an earlier run that failed is still shown when the step goes through, and only for a week (review, 6 Nov 2026)', async () => {
    const b = booking({ players: [{ id: 1, name: 'Test Payer' }, { id: 7, name: 'Sam Fairweather' }, { id: 8, name: 'Ola Nordmann' }], pricePence: 3000 });
    const w = worker([b]);
    const members = [...NEW_MEMBERS];                                 // Ola is not in Splitwise yet
    const r = go(w, splitwise({ members }), { whatsapp: WA });
    expect(await r.run()).toBe(1);
    expect(w.posts.at(-1).note).toBe('Ola Nordmann: not in the Splitwise group under that name. Fix it, then Retry');
    members.push({ id: 21, first_name: 'Ola', last_name: 'Nordmann' });   // Kevin adds Ola, then taps Retry
    b.splitwise = { state: null, at: null, note: null };
    expect(await r.run()).toBe(0);
    expect(w.posts.at(-1).note).toBe('entry 5000; new: Sam Fairweather = Splitwise Samuel Fairweather, mobile from your contacts; Ola Nordmann = Splitwise Ola Nordmann, mobile from your contacts');
    const players = { players: { 7: { linked_at: '2026-11-01', splitwise_as: 'Samuel Fairweather' } } };
    const one = { players: [{ id: 7, name: 'Sam Fairweather' }] };
    expect(newNote(one, players, Date.parse('2026-11-07T23:00:00Z'))).toBe('; new: Sam Fairweather = Splitwise Samuel Fairweather, no mobile yet');
    expect(newNote(one, players, Date.parse('2026-11-08T00:00:01Z'))).toBe('');   // a week from the day it was linked
  });

  it('a note never runs past the 200 characters the Worker keeps, and a save that fails says so', async () => {
    const many = [{ id: 1, name: 'Test Payer' }, { id: 7, name: 'Bartholomew Fairweather-Smythe' }, { id: 8, name: 'Maximilian Featherstonehaugh' }];
    const w = worker([booking({ players: many })]);
    expect(await go(w, splitwise(), { whatsapp: [] }).run()).toBe(1);
    const note = w.posts.at(-1).note;
    expect(note.length).toBeLessThanOrEqual(200);
    expect(note).toMatch(/^Can't link Bartholomew Fairweather-Smythe, Maximilian Featherstonehaugh: check each is in the Splitwise group/);
    const w2 = worker([booking({ players: [{ id: 1, name: 'Test Payer' }, { id: 7, name: 'Sam Fairweather' }] })]);
    const r2 = go(w2, splitwise({ members: NEW_MEMBERS }), { whatsapp: WA, opts: { save: () => { throw Object.assign(new Error('disk'), { code: 'EACCES' }); } } });
    expect(await r2.run()).toBe(1);
    expect(w2.posts.at(-1).note).toBe('Sam Fairweather: found, but the entry could not be saved. Fix it, then Retry');
    expect(r2.lines.join('\n')).toMatch(/could not save a new player's entry \(EACCES\)/);
  });

  it('texts: a mobile still missing is looked for again; one that cannot be found fails the step by name, and the others still go', async () => {
    const players = structuredClone(PLAYERS);
    delete players.players[3].phones;                                 // Test Cat: in Splitwise, no mobile yet
    const done = { splitwise: { state: 'done', at: AT, note: 'entry 5000' } };
    const shares = { 11: 900, 12: 900, 13: 900, 14: 900 };
    const w = worker([booking(done)]);
    const r = go(w, splitwise({ expenses: [entry(5000, 'Tue 3 Nov, Testford, 19:30, 90 min', shares)] }), { players, whatsapp: [{ contact: ['Test Cat'], pushname: null, phones: ['+447700900033'] }] });
    expect(await r.run()).toBe(0);
    expect(r.sent.map((x) => x.number)).toEqual(['+447700900002', '+447700900033', '+447700900004']);
    expect(r.saved).toEqual([[3, { phones: ['+447700900033'], mobile_as: 'mobile from your contacts', contact: 'Test Cat', linked_at: '2026-11-01' }]]);   // the contact name was missing too
    expect(w.posts.at(-1).note).toBe('3 of 3 sent; new: Test Cat = Splitwise set by you, mobile from your contacts');

    const w2 = worker([booking(structuredClone(done))]);
    const r2 = go(w2, splitwise({ expenses: [entry(5000, 'Tue 3 Nov, Testford, 19:30, 90 min', shares)] }), { players, whatsapp: [] });
    expect(await r2.run()).toBe(1);
    expect(r2.sent.map((x) => x.number)).toEqual(['+447700900002', '+447700900004']);
    expect(w2.posts.at(-1)).toMatchObject({ step: 'texts', state: 'failed', note: '2 of 3 sent: no mobile for Test Cat: not in the Padel WhatsApp group under that name. Fix it, then Retry' });
    expect(r2.lines.join('\n')).toMatch(/2 of 3 sent, 1 with no mobile/);
    expect(r2.lines.join('\n')).not.toMatch(/Test Cat/);
  });
});

describe('padel-delivery.py: the Padel WhatsApp group, names and mobiles only', () => {
  it("lists every current member by the name in Kevin's contacts, the name they gave WhatsApp and the mobile, privately, and refuses two groups with one name", () => {
    const dir = tmp();
    const out = join(dir, 'whatsapp.json');
    const py = `import sqlite3, sys, os, importlib.util
d, out = sys.argv[1], sys.argv[2]
c = sqlite3.connect(os.path.join(d, 'ChatStorage.sqlite'))
c.executescript("CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZPARTNERNAME TEXT, ZCONTACTJID TEXT); CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZCHATSESSION INTEGER, ZMEMBERJID TEXT, ZISACTIVE INTEGER); CREATE TABLE ZWAPROFILEPUSHNAME (ZJID TEXT, ZPUSHNAME TEXT); CREATE TABLE ZWAMESSAGE (ZTEXT TEXT);")
c.executemany("INSERT INTO ZWACHATSESSION VALUES (?, ?, ?)", [(1, 'Padel', '1203@g.us'), (2, 'Padel', '447700900051@s.whatsapp.net'), (3, 'Golf', '1204@g.us')])
c.executemany("INSERT INTO ZWAGROUPMEMBER (ZCHATSESSION, ZMEMBERJID, ZISACTIVE) VALUES (?, ?, ?)", [(1, '111@lid', 1), (1, '447700900052@s.whatsapp.net', 1), (1, '447700900056@s.whatsapp.net', 0), (3, '333@lid', 1)])
c.executemany("INSERT INTO ZWAPROFILEPUSHNAME VALUES (?, ?)", [('111@lid', 'Ola'), ('333@lid', 'Golfer')])
c.execute("INSERT INTO ZWAMESSAGE VALUES ('secret words')")
c.commit(); c.close()
b = sqlite3.connect(os.path.join(d, 'ContactsV2.sqlite'))
b.executescript("CREATE TABLE ZWAADDRESSBOOKCONTACT (ZFULLNAME TEXT, ZLID TEXT, ZWHATSAPPID TEXT, ZNOTES TEXT);")
b.executemany("INSERT INTO ZWAADDRESSBOOKCONTACT VALUES (?, ?, ?, ?)", [('Ola Nordmann', '111@lid', '447700900051@s.whatsapp.net', 'a private note'), ('Sam Fairweather', None, '447700900052@s.whatsapp.net', None), ('Golf Pal', '333@lid', '447700900053@s.whatsapp.net', None), ('Gone Player', None, '447700900056@s.whatsapp.net', None)])
b.commit(); b.close()
spec = importlib.util.spec_from_file_location('pd', 'scripts/padel-delivery.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.whatsapp(wa_dir=d, out_path=out, now=1000)
c = sqlite3.connect(os.path.join(d, 'ChatStorage.sqlite')); c.execute("INSERT INTO ZWACHATSESSION VALUES (4, 'Padel', '1205@g.us')"); c.commit(); c.close()
try:
    m.whatsapp(wa_dir=d, out_path=out + '.2', now=1000)
    print('NOT REFUSED')
except RuntimeError as e:
    print('refused:', e)`;
    const said = execFileSync('/usr/bin/python3', ['-c', py, dir, out], { stdio: 'pipe' }).toString();
    expect(said).toMatch(/refused: 2 WhatsApp groups are called Padel/);
    const rec = JSON.parse(readFileSync(out, 'utf8'));
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(rec).toEqual({ at: 1000000, group: 'Padel', members: [
      { contact: ['Ola Nordmann'], pushname: 'Ola', phones: ['+447700900051'] },
      { contact: ['Sam Fairweather'], pushname: null, phones: ['+447700900052'] },     // listed by number: still found
    ] });
    expect(JSON.stringify(rec)).not.toMatch(/secret|private note|Golf|Gone|7700900056/);   // no words, no other group, nobody who left
  });
});

describe('deliveryOf(): the record padel-delivery.py writes', () => {
  const dir = tmp();
  const file = join(dir, 'delivery.json');
  const T = Date.parse('2026-11-05T09:30:00Z');
  const write = (at, numbers) => writeFileSync(file, JSON.stringify({ at, numbers }));
  const msg = (at, extra = {}) => ({ at, service: 'iMessage', sent: true, delivered: false, error: 0, ...extra });
  const ask = (n, since, nowAt) => deliveryOf(n, since, { file, now: () => nowAt });
  it('the first text from the moment asked about (never a later one to the same person), matched on the last ten digits', async () => {
    write(T + 60000, { 7700900002: [msg(T - 5000, { error: 22 }), msg(T + 1000, { delivered: true }), msg(T + 30000, { error: 22 })] });
    expect(await ask('+44 7700 900002', T, T + 120000)).toEqual({ known: true, readable: true, error: 0, delivered: true, sent: true, service: 'iMessage' });
  });
  it('a record written before the text went is stale; none since is "no such text"; an old record or an unknown number is unreadable', async () => {
    write(T - 1000, { 7700900002: [] });
    expect(await ask('+447700900002', T, T + 60000)).toEqual({ known: false, readable: true, stale: true });
    write(T + 60000, { 7700900002: [msg(T - 5000)] });
    expect(await ask('+447700900002', T, T + 120000)).toEqual({ known: false, readable: true });
    expect(await ask('+447700900002', T, T + 60000 + 21 * 60000)).toEqual({ known: false, readable: false });
    expect(await ask('+447700900099', T, T + 120000)).toEqual({ known: false, readable: false });
    expect(await deliveryOf('+447700900002', T, { file: join(dir, 'none.json'), now: () => T })).toEqual({ known: false, readable: false });
  });
});

describe('padel-delivery.py: Messages\' record for the players only, no words', () => {
  it('writes each player\'s texts from the last 48 hours, and nothing else', () => {
    const dir = tmp();
    const db = join(dir, 'chat.db');
    const players = join(dir, 'players.json');
    const out = join(dir, 'delivery.json');
    writeFileSync(players, JSON.stringify(PLAYERS));
    const now = Date.parse('2026-11-05T10:00:00Z') / 1000;
    const apple = (sec) => Math.round((sec - 978307200) * 1e9);
    const py = `import sqlite3, sys, importlib.util
db, players, out, now = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
c = sqlite3.connect(db)
c.executescript("CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT); CREATE TABLE message (ROWID INTEGER PRIMARY KEY, handle_id INTEGER, is_from_me INTEGER, date INTEGER, service TEXT, is_sent INTEGER, is_delivered INTEGER, error INTEGER, text TEXT);")
c.executemany("INSERT INTO handle VALUES (?, ?)", [(1, '+447700900002'), (2, '+447700900077'), (3, '+447700900001')])
c.executemany("INSERT INTO message (handle_id, is_from_me, date, service, is_sent, is_delivered, error, text) VALUES (?,?,?,?,?,?,?,?)", [
  (1, 1, ${apple(now - 600)}, 'iMessage', 1, 1, 0, 'secret words'),
  (1, 0, ${apple(now - 500)}, 'iMessage', 0, 0, 0, 'a reply'),
  (1, 1, ${apple(now - 3 * 86400)}, 'SMS', 1, 1, 0, 'too old'),
  (2, 1, ${apple(now - 600)}, 'iMessage', 1, 1, 0, 'not a player'),
  (3, 1, ${apple(now - 600)}, 'iMessage', 1, 1, 0, 'Kevin himself')])
c.commit(); c.close()
spec = importlib.util.spec_from_file_location('pd', 'scripts/padel-delivery.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.dump(players_path=players, db_path=db, out_path=out, now=now)`;
    execFileSync('/usr/bin/python3', ['-c', py, db, players, out, String(now)], { stdio: 'pipe' });
    const rec = JSON.parse(readFileSync(out, 'utf8'));
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(rec.at).toBe(now * 1000);
    expect(Object.keys(rec.numbers).sort()).toEqual(['7700900002', '7700900003', '7700900004', '7700900009']);   // the players, not Kevin
    expect(rec.numbers['7700900002']).toEqual([{ at: (now - 600) * 1000, service: 'iMessage', sent: true, delivered: true, error: 0 }]);
    expect(JSON.stringify(rec)).not.toMatch(/secret|reply|not a player|Kevin/);
  });
});

describe('texted(): one text per person, SMS only when the iMessage definitely failed', () => {
  const sleep = async () => {};
  const try_ = async (first, deliveries, smsCode = 0) => {
    const sends = [];
    let i = 0;
    const r = await texted('+447700900002', 'hi', {
      send: async (n, t, svc) => { sends.push(svc); return svc === 'SMS' ? { code: smsCode, stderr: '' } : first; },
      delivery: async () => deliveries[Math.min(i++, deliveries.length - 1)], sleep });
    return { r, sends };
  };
  const NONE = { known: false, readable: true };
  const BLIND = { known: false, readable: false };
  it('delivered by iMessage: one send', async () => {
    expect(await try_({ code: 0 }, [{ known: true, readable: true, error: 0, delivered: true }])).toEqual({ r: { ok: true, via: 'iMessage' }, sends: ['iMessage'] });
  });
  it('iMessage refused by Messages: sent again as SMS', async () => {
    expect(await try_({ code: 0 }, [{ known: true, readable: true, error: 22 }])).toEqual({ r: { ok: true, via: 'SMS' }, sends: ['iMessage', 'SMS'] });
  });
  it('a slow iMessage (no error, not yet sent): unsure, no second text', async () => {
    const out = await try_({ code: 0 }, [{ known: true, readable: true, error: 0, delivered: false, sent: false }]);
    expect(out).toEqual({ r: { ok: null, via: 'iMessage (not yet delivered)' }, sends: ['iMessage'] });
  });
  it('delivery unreadable: unsure, no second text', async () => {
    expect(await try_({ code: 0 }, [BLIND])).toEqual({ r: { ok: null, via: 'iMessage (delivery not readable)' }, sends: ['iMessage'] });
  });
  it('osascript failed and Messages holds no message: SMS; failed and unreadable, or still pending: unsure, no second text', async () => {
    expect((await try_({ code: 1, stderr: 'timeout' }, [NONE])).sends).toEqual(['iMessage', 'SMS']);
    expect(await try_({ code: 1, stderr: 'timeout' }, [BLIND])).toEqual({ r: { ok: null, via: 'iMessage (Messages did not answer)' }, sends: ['iMessage'] });
    expect((await try_({ code: 1, stderr: 'timeout' }, [{ known: true, readable: true, error: 0 }])).sends).toEqual(['iMessage']);
  });
  it('a record written before the text went: one iMessage, unsure, checked on the next run', async () => {
    const out = await try_({ code: 0 }, [{ known: false, readable: true, stale: true }]);
    expect(out).toEqual({ r: { ok: null, via: 'iMessage (checked on the next run)' }, sends: ['iMessage'] });
  });
  it('Messages not allowed on the Mac: not sent, and says what to fix', async () => {
    const out = await try_({ code: 1, stderr: 'execution error: Not authorized to send Apple events to Messages. (-1743)' }, [NONE]);
    expect(out.sends).toEqual(['iMessage']);
    expect(out.r).toEqual({ ok: false, why: 'Messages needs permission on the Mac (Privacy, Automation)' });
  });
});

describe("agent-browser's padel approval (commit --padel-slot)", () => {
  const ab = require_('../scripts/agent-browser.js');
  const dir = tmp();
  const keyFile = join(dir, 'key');
  writeFileSync(keyFile, 'robot-key-test\n');
  const playersFile = join(dir, 'players.json');
  writeFileSync(playersFile, JSON.stringify(PLAYERS));
  const reply = (bookings, status = 200) => async (url, init) => {
    expect(init.headers['X-Robot-Key']).toBe('robot-key-test');
    return new Response(JSON.stringify({ ok: true, bookings }), { status });
  };
  const b = booking({ splitwise: { state: 'claimed' } });
  const plan = buildPlan(b, GROUP, MEMBERS, [11, 12, 13, 14]);
  const ok = (p = plan, bs = [b], opts = {}) => ab.padelApproval('2026-11-03|19', AT, p, { fetchImpl: reply(bs), keyFile, playersFile, ...opts });
  it('the plan padel-paid builds is approved: that booking, that version, Splitwise claimed, with the group and players for the live check', async () => {
    expect(await ok()).toMatchObject({ ok: true, padel: { groupId: GROUP, playerIds: [11, 12, 13, 14] } });
  });
  it('refused when the booking moved on', async () => {
    expect((await ab.padelApproval('2026-11-03|19', '2026-01-01T00:00:00.000Z', plan, { fetchImpl: reply([b]), keyFile })).why).toMatch(/changed since the robot read it/);
    expect((await ok(plan, [{ ...b, splitwise: { state: null } }])).why).toMatch(/not claimed/);
    expect((await ok(plan, [{ ...b, splitwise: { state: 'done' } }])).why).toMatch(/not claimed/);
    expect((await ab.padelApproval('2026-11-04|19', AT, plan, { fetchImpl: reply([b]), keyFile })).why).toMatch(/no paid padel booking/);
    expect((await ok(plan, [b], { fetchImpl: reply([b], 401) })).why).toMatch(/answered 401/);
    expect((await ok(plan, [b], { keyFile: join(dir, 'missing') })).why).toMatch(/no padel robot key/);
    expect((await ab.padelApproval('nope', AT, plan, { fetchImpl: reply([b]), keyFile })).ok).toBe(false);
    expect((await ab.padelApproval('2026-11-03|19', null, plan, { fetchImpl: reply([b]), keyFile })).ok).toBe(false);
  });
  it('refused for any plan that is not that booking\'s Splitwise expense', async () => {
    const edit = (f) => { const p = JSON.parse(JSON.stringify(plan)); f(p.steps); return p; };
    expect((await ok(edit((s) => { s[0].url = 'https://example.com/#/groups/900'; }))).why).toMatch(/Splitwise only/);
    expect((await ok(edit((s) => { s.find((x) => x.selector === "input[placeholder='0.00']").value = '360.00'; }))).why).toMatch(/fills "Tue 3 Nov, Testford, 19:30, 90 min" and 36.00, nothing else/);
    expect((await ok(edit((s) => { s.find((x) => x.selector === 'input.description').value = 'Something else'; }))).ok).toBe(false);
    expect((await ok(edit((s) => { s.splice(3, 0, { do: 'fill', selector: 'input.notes', value: 'x' }); }))).ok).toBe(false);
    expect((await ok(edit((s) => { s.push({ do: 'submit', selector: "button.submit:has-text('Save')" }); }))).why).toBe('a padel plan ends with one Save');
    expect((await ok(edit((s) => { s.splice(2, 0, { do: 'upload', selector: 'input', files: ['x'] }); }))).why).toMatch(/may not "upload"/);
    expect((await ok({ steps: [] })).ok).toBe(false);
    expect((await ok(edit((s) => { s[0].url = 'https://secure.splitwise.com/#/groups/999'; }))).why).toMatch(/opens the Padel group only/);
    expect((await ok(edit((s) => { s.splice(9, 0, { do: 'click', selector: ".split_method.equal .person[data-id='12'] input.share" }); }))).why).toBe('a padel plan may not untick a player');
    expect((await ok(plan, [b], { playersFile: join(dir, 'none.json') })).why).toMatch(/no padel players file/);
    expect((await ok(plan, [{ ...b, players: [...b.players, { id: 9, name: 'Test Out' }] }])).why).toMatch(/every player's Splitwise id/);
    for (const sel of ['text=Delete', 'text=Settle up', "a[href*='example.com']", 'text=Paid by', ".split_method.equal .person[data-id='12'] input.amount"])
      expect([sel, (await ok(edit((s) => { s.splice(3, 0, { do: 'click', selector: sel }); }))).why]).toEqual([sel, `a padel plan may not click ${sel}`]);
  });
  it('in the browser, before the first click: the plan unticks exactly the members not playing, read live from the group', () => {
    const group = (ids) => JSON.stringify({ group: { id: GROUP, members: ids.map((id) => ({ id, first_name: 'x' })) } });
    expect(ab.padelMembersProblem(plan, group(MEMBERS), [11, 12, 13, 14])).toBeNull();
    // Someone joined the group since the plan was built: they would owe a share, so it stops.
    expect(ab.padelMembersProblem(plan, group([...MEMBERS, 17]), [11, 12, 13, 14])).toBe('the plan unticks 2 members, not the 3 who are not playing');
    expect(ab.padelMembersProblem(plan, group([11, 12, 13, 14, 15]), [11, 12, 13, 14])).toMatch(/unticks 2 members, not the 1/);
    expect(ab.padelMembersProblem(plan, group([11, 12, 13, 15, 16]), [11, 12, 13, 14])).toBe('a player is not in the Padel group');
    expect(ab.padelMembersProblem(plan, '<html>Log in</html>', [11, 12, 13, 14])).toBe('could not read the Padel group in Splitwise');
  });
  it('commit checks the plan\'s proof first, and refuses --task with --padel-slot, before any browser opens', () => {
    const runIt = (p, extra) => {
      const f = join(dir, `plan-${Math.random()}.json`);
      writeFileSync(f, JSON.stringify(p));
      try { execFileSync(process.execPath, ['scripts/agent-browser.js', 'commit', '--plan', f, '--shot', join(dir, 'x.png'), ...extra], { stdio: 'pipe', timeout: 30000 }); return 'ran'; }
      catch (e) { return String(e.stderr); }
    };
    const both = ['--task', 'recAAAAAAAAAAAAAA', '--padel-slot', '2026-11-03|19'];
    expect(runIt({ steps: [{ do: 'submit', selector: 'button' }] }, both)).toMatch(/declares no proof of landing/);
    expect(runIt({ steps: [{ do: 'submit', selector: 'button' }], confirm: { selector: 'text=ok' } }, both)).toMatch(/commit takes --task or --padel-slot, never both/);
  });
});

// 5 Nov 2026, 06:00: Splitwise showed £34.60 but "(£0.00/person)": its amount box counts keystrokes,
// and a plain fill makes none, so Save was refused. A page that behaves the same, driven through the
// robot's real step runner in a real browser.
describe.skipIf(!(() => { try { require_('playwright-core'); return true; } catch { return false; } })())('the amount is typed, and Save waits for a real share per person', () => {
  const { chromium } = require_('playwright-core');
  const ab = require_('../scripts/agent-browser.js');
  const dir = tmp();
  const form = join(dir, 'form.html');
  writeFileSync(form, `<!doctype html><meta charset="utf-8">
<input placeholder="0.00"><div class="human_summary">split equally <div class="details">(£0.00/person)</div></div>
<button class="submit" id="save">Save</button><div id="out"></div>
<script>
const box = document.querySelector('input');
box.addEventListener('keyup', () => {
  const v = Number(box.value) || 0;
  document.querySelector('.details').textContent = '(£' + (v / 7).toFixed(2) + '/person)';
});
document.getElementById('save').addEventListener('click', () => { document.getElementById('out').textContent = 'Saved'; });
</script>`);
  const run = async (typed, value = '34.60') => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      await page.goto('file://' + form);
      const steps = [
        { do: 'fill', selector: "input[placeholder='0.00']", value, ...(typed ? { typed: true } : {}) },
        { do: 'wait', for: perPersonShown(3460, 7), ms: 2000 },
        { do: 'submit', selector: '#save' },
      ];
      const r = await ab.runSteps(page, steps, true, { selector: 'text=Saved', timeoutMs: 3000 }).then(() => 'saved', (e) => String(e.message));
      return { r, out: await page.textContent('#out'), details: await page.textContent('.details') };
    } finally { await browser.close(); }
  };
  it('typed: the form shows £4.94 a person and Save goes', async () => {
    expect(await run(true)).toEqual({ r: 'saved', out: 'Saved', details: '(£4.94/person)' });
  });
  it('a plain fill: the form stays at £0.00 a person and Save is never pressed', async () => {
    const r = await run(false);
    expect(r.details).toBe('(£0.00/person)');
    expect(r.out).toBe('');
    expect(r.r).toMatch(/Timeout|waiting for/);
  });
  it('a wrong amount in the box (a dropped keystroke) shows a different share, and Save is never pressed', async () => {
    const r = await run(true, '3.60');
    expect(r.details).toBe('(£0.51/person)');
    expect(r.out).toBe('');
  });
});

// ── Booking emails (Kevin, 8 Nov 2026: "do it all from the booking confirmation email and the information
// on the app at that time"). A court booked at 20:41 the night before sat with no price and no Splitwise
// entry because the price was a second button. The emails below have the shape of the real ones read on
// 8 Nov 2026 (Matchi: no price; Nettla: a Total line); every name and code in them is invented.
describe('padel-emails.py: what each venue email says, and nothing else', () => {
  const MATCHI = 'BOOKING CONFIRMATION Hello Test Payer You have booked a time slot at PDL Padel United - Cambridge. Date: 2026-11-08 Time: 16:00-17:00 Court: Court 3 Venue access code: XQZW Player: Test Payer';
  const NETTLA = (title, when, total) => `Hi Test, you're booked in! IMPORTANT INFORMATION: CAR GATE CODE: XQZW# ${title} ${when} Pulse Padel, Huntingdon Court 1 Reference: testref Entrance Code: XQZW# Payment Court booking £${total} Technology fee £0.30 Total £${total} Paid with Apple Pay`;
  const msg = (id, from, subject, body, sent = Date.parse('2026-11-07T20:40:02Z')) => ({ id, internalDate: String(sent), headers: { from, subject }, body });
  it('reads Matchi (no price), a Pulse court (its Total), and skips a public match, a cancellation, Playtomic and a bad weekday', () => {
    const dir = tmp();
    const out = join(dir, 'emails.json');
    const msgs = [
      msg('m1', 'PDL Padel United - Cambridge <no-reply@matchi.se>', 'Booking confirmation', MATCHI),
      msg('n1', 'Pulse Padel, Huntingdon <no-reply@nettla.co>', 'Court booking confirmed', NETTLA('Court Booking', 'Tue 10 Nov, 19:30 - 20:30', '34.60'), Date.parse('2026-11-04T22:54:21Z')),
      msg('n2', 'Pulse Padel, Huntingdon <no-reply@nettla.co>', 'Public match confirmed', NETTLA('Public Match', 'Wed 11 Nov, 12:30 - 13:30', '6.80')),
      msg('n3', 'Pulse Padel, Huntingdon <no-reply@nettla.co>', 'Public match cancelled', 'Hi Test, your public match has been cancelled Thu 12 Nov, 12:30 - 13:30'),
      msg('n4', 'Pulse Padel, Huntingdon <no-reply@nettla.co>', 'Court booking confirmed', NETTLA('Court Booking', 'Wed 10 Nov, 19:30 - 20:30', '34.60')),   // 10 Nov 2026 is a Tuesday
      msg('n5', 'Pulse Padel, Huntingdon <no-reply@nettla.co>', 'Court booking confirmed', NETTLA('Court Booking', 'Sat 2 Jan, 10:00 - 11:30', '40.00'), Date.parse('2026-12-30T09:00:00Z')),   // next year
      msg('p1', 'Playtomic <no-reply@playtomic.io>', 'Your booking is confirmed', 'Booking at PDL Padel United'),
    ];
    const py = `import sys, json, importlib.util
spec = importlib.util.spec_from_file_location('pe', 'scripts/padel-emails.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
msgs = json.loads(sys.argv[2])
m.run(out_path=sys.argv[1], now=1000, lister=lambda: msgs)`;
    execFileSync('/usr/bin/python3', ['-c', py, out, JSON.stringify(msgs)], { stdio: 'pipe' });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const rec = JSON.parse(readFileSync(out, 'utf8'));
    expect(rec.at).toBe(1000000);
    expect(rec.bookings).toEqual([
      { id: 'm1', at: Date.parse('2026-11-07T20:40:02Z'), venue: 'pdl', date: '2026-11-08', start: '16:00', minutes: 60, price_pence: null },
      { id: 'n1', at: Date.parse('2026-11-04T22:54:21Z'), venue: 'pp', date: '2026-11-10', start: '19:30', minutes: 60, price_pence: 3460 },
      { id: 'n5', at: Date.parse('2026-12-30T09:00:00Z'), venue: 'pp', date: '2027-01-02', start: '10:00', minutes: 90, price_pence: 4000 },
    ]);
    expect(rec.skipped.map((s) => [s.id, s.skip])).toEqual([
      ['n2', "a public match (Kevin's own place)"],
      ['n3', "a public match (Kevin's own place)"],
      ['n4', 'Nettla email not read (date or time missing, or the weekday disagrees)'],
      ['p1', "unread: Playtomic's format is not known yet"],
    ]);
    expect(JSON.stringify(rec)).not.toMatch(/Test Payer|XQZW|testref|Apple Pay/);   // no names, codes or payment words copied
  });
  it('a £0.00 total is no price (Kevin types it); a booking email it cannot read fails the run loudly; Playtomic alone does not', () => {
    const dir = tmp();
    const run = (msgs) => {
      const py = `import sys, json, importlib.util
spec = importlib.util.spec_from_file_location('pe', 'scripts/padel-emails.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
msgs = json.loads(sys.argv[2])
code = m.main(out_path=sys.argv[1], lister=lambda: msgs)
print('EXIT', code)`;
      const said = execFileSync('/usr/bin/python3', ['-c', py, join(dir, 'e.json'), JSON.stringify(msgs)], { stdio: 'pipe' }).toString();
      return { said, rec: JSON.parse(readFileSync(join(dir, 'e.json'), 'utf8')) };
    };
    const credit = run([msg('n1', 'Pulse Padel, Huntingdon <no-reply@nettla.co>', 'Court booking confirmed', NETTLA('Court Booking', 'Tue 10 Nov, 19:30 - 20:30', '0.00'))]);
    expect(credit.rec.bookings[0]).toMatchObject({ date: '2026-11-10', price_pence: null });
    expect(credit.said).toMatch(/EXIT 0/);
    const changed = run([msg('m1', 'PDL Padel United - Cambridge <no-reply@matchi.se>', 'Booking confirmation', MATCHI.replace('Date: 2026-11-08', 'Date: 8 November 2026'))]);
    expect(changed.said).toMatch(/FAILED: padel-emails: 1 booking email\(s\) not read \(Matchi email not read/);
    expect(changed.said).toMatch(/EXIT 1/);
    const otherClub = run([msg('m2', 'Another Club <no-reply@matchi.se>', 'Booking confirmation', MATCHI.replace('PDL Padel United - Cambridge', 'Test Racket Club'))]);
    expect(otherClub.rec.skipped.map((x) => x.skip)).toEqual(['a Matchi club that is not ours']);
    expect(otherClub.said).toMatch(/EXIT 0/);                           // not a false alarm
    const playtomic = run([msg('p1', 'Playtomic <no-reply@playtomic.io>', 'Your booking is confirmed', 'x')]);
    expect(playtomic.said).toMatch(/1 venue email\(s\) in a format not read yet: Your booking is confirmed\nEXIT 0/);
  });
});

describe('the robot carries out each booking email once', () => {
  const T = Date.parse('2026-11-07T21:00:00Z');
  const email = (extra = {}) => ({ id: 'm1', at: T - 60000, venue: 'pdl', date: '2026-11-08', start: '16:00', minutes: 60, price_pence: null, ...extra });
  const workerFor = (reply) => {
    const posts = [];
    const fetchImpl = async (url, init = {}) => {
      if (url !== BOOKING_URL) throw new Error(`unexpected ${url}`);
      const body = JSON.parse(init.body);
      posts.push(body);
      const [status, json] = reply(body);
      return new Response(JSON.stringify(json), { status });
    };
    return { fetchImpl, posts };
  };
  it('marks the hour from the email, sends the price when there is one, and never sends the same email twice', async () => {
    const ledger = makeEmailLedger(join(tmp(), 'emails-done.json'));
    const w = workerFor(() => [200, { ok: true, booked: true, paid: false }]);
    const step = () => emailStep([email(), email({ id: 'n1', venue: 'pp', date: '2026-11-10', start: '19:30', price_pence: 3460 })], { fetchImpl: w.fetchImpl, headers: {}, kevinId: 1, ledger, now: () => T });
    const r = await step();
    expect(w.posts).toEqual([
      { slot: '2026-11-08|16', venue: 'pdl', start: '16:00', minutes: 60, person_id: 1, price_pence: null },
      { slot: '2026-11-10|19', venue: 'pp', start: '19:30', minutes: 60, person_id: 1, price_pence: 3460 },
    ]);
    expect(r).toMatchObject({ counts: { marked: 2, paid: 0, refused: 0 }, problems: [] });
    await step();                                                       // the next run: nothing sent again
    expect(w.posts).toHaveLength(2);
    expect(Object.keys(ledger.read())).toEqual(['m1', 'n1']);
  });
  it('a refusal the Worker explains is recorded and dropped; no answer is tried again next run; a past game is never sent', async () => {
    const ledger = makeEmailLedger(join(tmp(), 'emails-done.json'));
    let down = true;
    const w = workerFor((b) => (b.slot.endsWith('|22') ? [400, { error: 'Not an hour in the next 14 days' }] : [200, { ok: true, booked: false, paid: true }]));
    const fetchImpl = async (url, init) => (down && JSON.parse(init.body).slot.endsWith('|16') ? null.x : w.fetchImpl(url, init));
    const list = [email(), email({ id: 'late', start: '22:00' }), email({ id: 'old', date: '2026-11-06' })];
    const first = await emailStep(list, { fetchImpl: async (u, i) => { try { return await fetchImpl(u, i); } catch { throw new Error('offline'); } }, headers: {}, kevinId: 1, ledger, now: () => T });
    expect(first.problems).toEqual(['2026-11-08|16: the Worker did not answer the booking email', '2026-11-08|22: the Worker refused the booking email (Not an hour in the next 14 days)']);
    expect(first.counts).toEqual({ marked: 0, paid: 0, refused: 1 });
    expect(ledger.read().late).toMatchObject({ slot: '2026-11-08|22', refused: 'Not an hour in the next 14 days' });
    expect(ledger.read().m1).toBeUndefined();                          // tried again next run
    expect(w.posts.some((p) => p.slot.startsWith('2026-11-06'))).toBe(false);
    down = false;
    const second = await emailStep(list, { fetchImpl, headers: {}, kevinId: 1, ledger, now: () => T });
    expect(second).toMatchObject({ counts: { marked: 0, paid: 1, refused: 0 }, problems: [] });
    expect([...second.paidSlots]).toEqual(['2026-11-08|16']);
  });
  it('a 404 (a Worker without the route, or no such person) is tried again next run, never recorded as done', async () => {
    const ledger = makeEmailLedger(join(tmp(), 'emails-done.json'));
    let up = false;
    const w = workerFor(() => (up ? [200, { ok: true, booked: true, paid: false, venue: 'pdl' }] : [404, { error: 'Not found' }]));
    const first = await emailStep([email()], { fetchImpl: w.fetchImpl, headers: {}, kevinId: 1, ledger, now: () => T });
    expect(first.problems).toEqual(['2026-11-08|16: the Worker answered 404 to the booking email']);
    expect(ledger.read()).toEqual({});
    up = true;
    expect((await emailStep([email()], { fetchImpl: w.fetchImpl, headers: {}, kevinId: 1, ledger, now: () => T })).counts.marked).toBe(1);
  });
  it('an hour already marked at another venue is reported once, so the court in the email is not lost without a word', async () => {
    const ledger = makeEmailLedger(join(tmp(), 'emails-done.json'));
    const w = workerFor(() => [200, { ok: true, booked: false, paid: false, venue: 'si' }]);
    const r = await emailStep([email()], { fetchImpl: w.fetchImpl, headers: {}, kevinId: 1, ledger, now: () => T });
    expect(r.problems).toEqual(['2026-11-08|16: the booking email is for pdl, but that hour is marked at si']);
    expect(ledger.read().m1).toMatchObject({ other_venue: 'si' });
    expect((await emailStep([email()], { fetchImpl: w.fetchImpl, headers: {}, kevinId: 1, ledger, now: () => T })).problems).toEqual([]);   // once
  });
  it('an unreadable email ledger is reported, and a booking priced on Kevin\'s phone still goes to Splitwise', async () => {
    const file = join(tmp(), 'emails-done.json');
    writeFileSync(file, '{not json');
    const w = worker([booking()]);
    const s = splitwise();
    const h = go({ fetchImpl: async (url, init) => (url === BOOKING_URL ? new Response('{}', { status: 500 }) : w.fetchImpl(url, init)) }, s, { emails: [email()], emailLedger: makeEmailLedger(file) });
    expect(await h.run()).toBe(1);
    expect(h.lines.at(-1)).toMatch(/^FAILED: padel-paid: booking emails skipped: SyntaxError reading /);
    expect(s.calls.some((c) => c[0] === 'commit')).toBe(true);           // the Splitwise entry was still made
  });
  it('a booking paid from an email this run is held even when its ledger line could not be written', async () => {
    const b = booking();
    const fetchImpl = async (url, init = {}) => (url === BOOKING_URL ? new Response(JSON.stringify({ ok: true, booked: false, paid: true, venue: 'pdl' }), { status: 200 }) : worker([b]).fetchImpl(url, init));
    const s = splitwise();
    const broken = { read: () => ({}), add: () => { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; } };
    const h = go({ fetchImpl }, s, { emails: [email({ id: 'e1', date: '2026-11-03', start: '19:30', price_pence: 3600 })], emailLedger: broken });
    expect(await h.run()).toBe(1);                                      // the failed write is reported...
    expect(s.calls).toEqual([]);                                        // ...and the booking is still held
  });
  it('a booking paid from an email waits half an hour before Splitwise; one Kevin paid himself does not', () => {
    const done = { m1: { slot: '2026-11-03|19', at: NOON - 10 * 60000, booked: true, paid: true }, m2: { slot: '2026-11-04|19', at: NOON - 10 * 60000, booked: true, paid: false } };
    expect(heldByEmail('2026-11-03|19', done, NOON)).toBe(true);
    expect(heldByEmail('2026-11-03|19', done, NOON + 21 * 60000)).toBe(false);
    expect(heldByEmail('2026-11-04|19', done, NOON)).toBe(false);      // marked from the email, priced on Kevin's phone
  });
  it('runOnce: the email goes to the Worker first, and the booking it paid is held, not sent to Splitwise', async () => {
    const b = booking();
    const posts = [];
    const fetchImpl = async (url, init = {}) => {
      if (url === BOOKING_URL) { posts.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, booked: false, paid: true }), { status: 200 }); }
      return worker([b]).fetchImpl(url, init);
    };
    const s = splitwise();
    const h = go({ fetchImpl }, s, { emails: [email({ id: 'e1', date: '2026-11-03', start: '19:30', price_pence: 3600 })] });
    expect(await h.run()).toBe(0);
    expect(posts).toEqual([{ slot: '2026-11-03|19', venue: 'pdl', start: '19:30', minutes: 60, person_id: 1, price_pence: 3600 }]);
    expect(s.calls).toEqual([]);                                        // held: no Splitwise yet
    expect(h.lines).toEqual(['padel-paid: booking emails: 0 marked booked, 1 paid, 0 refused']);
    expect(JSON.stringify(h.lines)).not.toMatch(/Test /);              // counts only, never a name
  });
  it('readEmails uses a list padel-emails.py wrote this hour, and nothing older', () => {
    const file = join(tmp(), 'emails.json');
    writeFileSync(file, JSON.stringify({ at: NOON, bookings: [email()] }));
    expect(readEmails(file, () => NOON + 59 * 60000)).toHaveLength(1);
    expect(readEmails(file, () => NOON + 61 * 60000)).toBeNull();
    expect(readEmails(join(tmp(), 'missing.json'), () => NOON)).toBeNull();
  });
});
