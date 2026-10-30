// scripts/padel-paid.mjs: the padel page's Booked and paid carried out on the Mac (Kevin, 30 Oct 2026):
// one Splitwise entry in the Padel group, then one text to each player. These drive the script's own
// runOnce() with the Worker, Splitwise (through agent-browser) and Messages replaced by fakes that
// behave like them. Every person here is invented; the phone numbers are Ofcom's drama range.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  description, equalShares, firstNames, textFor, sameBooking, buildPlan, checkEntry, runOnce, texted, textHours, textStart, makeLedger, PAID_URL,
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
function worker(bookings, { refuse = () => false } = {}) {
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    if (url !== PAID_URL) throw new Error(`unexpected ${url}`);
    if (!init.method) return new Response(JSON.stringify({ ok: true, bookings: bookings.filter((b) => !(b.splitwise.state === 'done' && b.texts.state === 'done')) }), { status: 200 });
    const body = JSON.parse(init.body);
    posts.push(body);
    const b = bookings.find((x) => x.slot === body.slot);
    const cur = b[body.step].state;
    const ok = !refuse(body) && (body.state === 'claimed' ? cur === null && body.paidAt === b.paidAt && (body.step === 'splitwise' || b.splitwise.state === 'done') : cur === 'claimed');
    if (ok) b[body.step] = { state: body.state, at: AT, note: body.note || null };
    return new Response(JSON.stringify({ ok: true, changed: ok }), { status: 200 });
  };
  return { fetchImpl, posts };
}
// A fake Splitwise behind agent-browser: read gives the group and its entries; commit saves the plan's
// entry with the ticked members owing equal shares (what the real form does), unless told to fail.
function splitwise({ expenses = [], commitCode = 0, groupReadable = true, savedCost = null } = {}) {
  const calls = [];
  const ab = async (args) => {
    calls.push(args);
    const page = (obj) => ({ code: 0, stdout: JSON.stringify({ text: JSON.stringify(obj) }), stderr: '' });
    if (args[0] === 'read' && args[2].includes('get_group/')) return groupReadable ? page({ group: { id: GROUP, members: MEMBERS.map((id) => ({ id })) } }) : { code: 1, stdout: '', stderr: 'signed out' };
    if (args[0] === 'read' && args[2].includes('get_expenses')) return page({ expenses });
    if (args[0] === 'commit') {
      if (commitCode) return { code: commitCode, stdout: '', stderr: 'BROWSER ERROR' };
      const plan = JSON.parse(readFileSync(args[args.indexOf('--plan') + 1], 'utf8'));
      const desc = plan.steps.find((s) => s.do === 'fill' && s.selector === 'input.description').value;
      const cost = Math.round((savedCost ?? Number(plan.steps.find((s) => s.selector && s.selector.includes('0.00')).value)) * 100);
      const out = plan.steps.filter((s) => s.do === 'click' && s.selector.includes('data-id')).map((s) => Number(/data-id='(\d+)'/.exec(s.selector)[1]));
      const owing = MEMBERS.filter((id) => !out.includes(id));
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
  const ledger = extra.ledger || makeLedger(join(tmp(), 'texts.jsonl'));
  const logDir = tmp();                                   // plans and screenshots never land in the robot's real log folder
  return {
    lines, sent, ledger,
    run: () => runOnce({ fetchImpl: w.fetchImpl, ab: s.ab, now: () => NOON, log: (l) => lines.push(l), key: 'robot-key-test', players: PLAYERS, ledger, logDir,
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
    expect(plan.steps.find((s) => s.selector === "input[placeholder='0.00']").value).toBe('36.00');
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

  it('a player not in the Splitwise group: the step fails with a count (never a name) and nothing is saved', async () => {
    const w = worker([booking({ players: [{ id: 1, name: 'Test Payer' }, { id: 9, name: 'Test Out' }] })]);
    const s = splitwise();
    expect(await go(w, s).run()).toBe(1);
    expect(s.calls.some((c) => c[0] === 'commit')).toBe(false);
    expect(w.posts.map((p) => [p.state, p.note])).toEqual([['claimed', undefined], ['failed', '1 of the players is not in the Splitwise group']]);
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

  it('a text Messages did not confirm counts as sent, is never sent again, and the note says so', async () => {
    const b = booking({ splitwise: { state: 'done', at: AT, note: 'entry 1' } });
    const w = worker([b]);
    const r = go(w, splitwise({ expenses: [entry(1, description(b), NINES)] }), { textOk: (n) => (n.endsWith('04') ? { ok: null, via: 'iMessage (delivery not readable)' } : { ok: true, via: 'iMessage' }) });
    r.ledger.add({ slot: b.slot, person: 2, state: 'sending' });      // a run that stopped mid-send for Bob
    expect(await r.run()).toBe(0);
    expect(r.sent.map((x) => x.number)).toEqual(['+447700900003', '+447700900004']);
    expect(w.posts.at(-1)).toMatchObject({ state: 'done', note: '3 of 3 sent (2 not confirmed)' });
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
  const reply = (bookings, status = 200) => async (url, init) => {
    expect(init.headers['X-Robot-Key']).toBe('robot-key-test');
    return new Response(JSON.stringify({ ok: true, bookings }), { status });
  };
  const b = booking({ splitwise: { state: 'claimed' } });
  const plan = buildPlan(b, GROUP, MEMBERS, [11, 12, 13, 14]);
  const ok = (p = plan, bs = [b], opts = {}) => ab.padelApproval('2026-11-03|19', AT, p, { fetchImpl: reply(bs), keyFile, ...opts });
  it('the plan padel-paid builds is approved: that booking, that version, Splitwise claimed', async () => {
    expect(await ok()).toMatchObject({ ok: true });
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
    for (const sel of ['text=Delete', 'text=Settle up', "a[href*='example.com']", 'text=Paid by', ".split_method.equal .person[data-id='12'] input.amount"])
      expect([sel, (await ok(edit((s) => { s.splice(3, 0, { do: 'click', selector: sel }); }))).why]).toEqual([sel, `a padel plan may not click ${sel}`]);
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
