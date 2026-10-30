// scripts/padel-paid.mjs: the padel page's Booked and paid carried out on the Mac (Kevin, 30 Oct 2026):
// one Splitwise entry in the Padel group, then one text to each player. These drive the script's own
// runOnce() with the Worker, Splitwise (through agent-browser) and Messages replaced by fakes that
// behave like them. Every person here is invented.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  description, equalShares, firstNames, textFor, sameBooking, buildPlan, checkEntry, runOnce, texted, textHours, PAID_URL,
} from '../scripts/padel-paid.mjs';

const require_ = createRequire(import.meta.url);
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

// A fake padel Worker: the robot's GET and its claimed/done/failed POSTs, with the Worker's own rules.
function worker(bookings) {
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    if (url !== PAID_URL) throw new Error(`unexpected ${url}`);
    if (!init.method) return new Response(JSON.stringify({ ok: true, bookings: bookings.filter((b) => !(b.splitwise.state === 'done' && b.texts.state === 'done')) }), { status: 200 });
    const body = JSON.parse(init.body);
    posts.push(body);
    const b = bookings.find((x) => x.slot === body.slot);
    const cur = b[body.step].state;
    let ok = body.state === 'claimed' ? cur === null && body.paidAt === b.paidAt && (body.step === 'splitwise' || b.splitwise.state === 'done') : cur === 'claimed';
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
      const cost = savedCost ?? Number(plan.steps.find((s) => s.selector && s.selector.includes('0.00')).value);
      const out = plan.steps.filter((s) => s.do === 'click' && s.selector.includes('data-id')).map((s) => Number(/data-id='(\d+)'/.exec(s.selector)[1]));
      const owing = MEMBERS.filter((id) => !out.includes(id));
      const shares = equalShares(Math.round(cost * 100), owing.length);
      expenses.push({ id: 5000 + expenses.length, description: desc, cost: cost.toFixed(2), created_at: AT, deleted_at: null,
        users: MEMBERS.map((id) => ({ user_id: id, paid_share: id === 11 ? cost.toFixed(2) : '0.00', owed_share: owing.includes(id) ? (shares[owing.indexOf(id)] / 100).toFixed(2) : '0.00' })) });
      return { code: 0, stdout: '{}', stderr: '' };
    }
    throw new Error(`unexpected agent-browser call ${args.join(' ')}`);
  };
  return { ab, calls, expenses };
}
const quiet = () => {};
const go = (w, s, extra = {}) => {
  const lines = [];
  const sent = [];
  const ledger = [];
  return {
    lines, sent, ledger,
    run: () => runOnce({ fetchImpl: w.fetchImpl, ab: s.ab, now: () => NOON, log: (l) => lines.push(l), key: 'robot-key-test', players: PLAYERS,
      textOne: async (number, text) => { sent.push({ number, text }); return (extra.textOk || (() => ({ ok: true, via: 'iMessage' })))(number); },
      has: (slot, person) => ledger.some((r) => r.slot === slot && r.person === person && r.ok), add: (r) => ledger.push(r), ...extra.opts }),
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
  it('knows an entry Kevin wrote himself for the same day and time, and nothing else', () => {
    for (const d of ['Tues 3rd Nov @ 19:30 (90mins)', 'Tue 3 Nov 19:30 Testford', 'Tue 3 Nov, Testford, 19:30, 90 min', '3 nov 19.30'])
      expect(sameBooking({ description: d }, b)).toBe(true);
    for (const d of ['Tues 3rd Nov', 'Tue 13 Nov 19:30', 'Sun 1 Nov 19:30', 'Tue 3 Nov 18:30', 'Tue 3 Oct 19:30'])
      expect(sameBooking({ description: d }, b)).toBe(false);
    expect(sameBooking({ description: 'Tues 3rd Nov @ 19:30', deleted_at: '2026-11-01' }, b)).toBe(false);
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
  it('reads an entry back and refuses one with the wrong total, the wrong people or the wrong payer', () => {
    const e = (cost, owe, paid = 11) => [{ id: 1, description: description(b), cost, created_at: AT, deleted_at: null,
      users: MEMBERS.map((id) => ({ user_id: id, paid_share: id === paid ? cost : '0.00', owed_share: owe.includes(id) ? '9.00' : '0.00' })) }];
    expect(checkEntry(e('36.00', [11, 12, 13, 14]), b, 11, [11, 12, 13, 14])).toMatchObject({ ok: true, id: 1, owes: { 11: 900, 12: 900, 13: 900, 14: 900 } });
    expect(checkEntry(e('30.00', [11, 12, 13, 14]), b, 11, [11, 12, 13, 14]).ok).toBe(false);
    expect(checkEntry(e('36.00', [11, 12, 13, 14, 15]), b, 11, [11, 12, 13, 14]).ok).toBe(false);
    expect(checkEntry(e('36.00', [11, 12, 13, 14], 12), b, 11, [11, 12, 13, 14]).ok).toBe(false);
    expect(checkEntry([], b, 11, [11]).ok).toBe(false);
  });
  it('texts only by day: 07:30 to 21:30 London', () => {
    expect(textHours(Date.parse('2026-11-01T07:29:00Z'))).toBe(false);
    expect(textHours(Date.parse('2026-11-01T07:30:00Z'))).toBe(true);
    expect(textHours(Date.parse('2026-07-01T20:29:00Z'))).toBe(true);    // 21:29 BST
    expect(textHours(Date.parse('2026-07-01T20:30:00Z'))).toBe(false);   // 21:30 BST
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
    // The claim came before the save; the group was read before the claim.
    expect(s.calls.map((c) => c[0])).toEqual(['read', 'read', 'commit', 'read']);
    expect(s.expenses[0].users.filter((u) => u.owed_share !== '0.00').map((u) => u.user_id)).toEqual([11, 12, 13, 14]);
    expect(r.sent).toEqual([]);                               // texts wait for the next run, after Splitwise is done
  });

  it('then the texts: each player but Kevin gets one, with their own share from the entry', async () => {
    const w = worker([booking({ pricePence: 3601 })]);
    const s = splitwise();
    const r = go(w, s);
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

  it('an entry already in the group (Kevin added it himself): no second entry, the step is done and says so', async () => {
    const w = worker([booking()]);
    const s = splitwise({ expenses: [{ id: 77, description: 'Tues 3rd Nov @ 19:30 (90mins)', cost: '36.00', deleted_at: null, users: [] }] });
    expect(await go(w, s).run()).toBe(0);
    expect(s.calls.some((c) => c[0] === 'commit')).toBe(false);
    expect(w.posts.map((p) => [p.state, p.note])).toEqual([['claimed', undefined], ['done', 'already in Splitwise (entry 77)']]);
  });

  it('a claim that does not win (the booking changed, or another run has it): no save at all', async () => {
    const b = booking();
    const w = worker([b]);
    const realFetch = w.fetchImpl;
    w.fetchImpl = async (url, init = {}) => (init.method ? new Response(JSON.stringify({ ok: true, changed: false }), { status: 200 }) : realFetch(url, init));
    const s = splitwise();
    expect(await go(w, s).run()).toBe(0);
    expect(s.calls.some((c) => c[0] === 'commit')).toBe(false);
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

  it('a text is never sent twice to one person, and a step with a failed text says how many went', async () => {
    const b = booking({ splitwise: { state: 'done', at: AT, note: 'entry 1' } });
    const w = worker([b]);
    const r = go(w, splitwise(), { textOk: (n) => (n.endsWith('03') ? { ok: false } : { ok: true, via: 'SMS' }) });
    r.ledger.push({ slot: b.slot, person: 2, ok: true });    // Bob was already texted
    expect(await r.run()).toBe(1);
    expect(r.sent.map((x) => x.number)).toEqual(['+447700900003', '+447700900004']);
    expect(w.posts.at(-1)).toMatchObject({ step: 'texts', state: 'failed', note: '2 of 3 sent' });
  });

  it('texts wait outside 07:30 to 21:30, and a claim left half-done for 30 minutes is failed for Kevin to check', async () => {
    const w = worker([booking({ splitwise: { state: 'done', at: AT, note: 'entry 1' } })]);
    const r = go(w, splitwise(), { opts: { now: () => Date.parse('2026-11-01T22:00:00Z') } });
    expect(await r.run()).toBe(0);
    expect(w.posts).toEqual([]);
    const w2 = worker([booking({ splitwise: { state: 'claimed', at: '2026-11-01T11:00:00.000Z', note: null } })]);
    expect(await go(w2, splitwise()).run()).toBe(1);
    expect(w2.posts).toEqual([expect.objectContaining({ step: 'splitwise', state: 'failed', note: 'the robot stopped part-way: check Splitwise before Retry' })]);
  });
});

describe('texted(): iMessage first, SMS when iMessage does not deliver', () => {
  const sleep = async () => {};
  it('delivered by iMessage: one send', async () => {
    const sends = [];
    const r = await texted('+447700900002', 'hi', { send: async (n, t, svc) => { sends.push(svc); return { code: 0 }; }, delivery: async () => ({ known: true, error: 0, delivered: true }), sleep });
    expect(r).toEqual({ ok: true, via: 'iMessage' });
    expect(sends).toEqual(['iMessage']);
  });
  it('iMessage refused: sent again as SMS', async () => {
    const sends = [];
    const r = await texted('+447700900002', 'hi', { send: async (n, t, svc) => { sends.push(svc); return { code: 0 }; }, delivery: async () => ({ known: true, error: 22, delivered: false }), sleep });
    expect(r).toEqual({ ok: true, via: 'SMS' });
    expect(sends).toEqual(['iMessage', 'SMS']);
  });
  it('Messages refusing both: not sent', async () => {
    const r = await texted('+447700900002', 'hi', { send: async () => ({ code: 1 }), delivery: async () => ({ known: false }), sleep });
    expect(r.ok).toBe(false);
  });
});

describe("agent-browser's padel approval (commit --padel-slot)", () => {
  const ab = require_('../scripts/agent-browser.js');
  const dir = mkdtempSync(join(tmpdir(), 'padel-approval-'));
  const keyFile = join(dir, 'key');
  writeFileSync(keyFile, 'robot-key-test\n');
  const reply = (bookings, status = 200) => async (url, init) => {
    expect(init.headers['X-Robot-Key']).toBe('robot-key-test');
    return new Response(JSON.stringify({ ok: true, bookings }), { status });
  };
  const b = { slot: '2026-11-03|19', paidAt: AT, splitwise: { state: 'claimed' } };
  it('holds only for that booking, at that version, with its Splitwise step claimed', async () => {
    expect(await ab.padelApproval('2026-11-03|19', AT, { fetchImpl: reply([b]), keyFile })).toMatchObject({ ok: true });
    expect((await ab.padelApproval('2026-11-03|19', '2026-01-01T00:00:00.000Z', { fetchImpl: reply([b]), keyFile })).why).toMatch(/changed since the robot read it/);
    expect((await ab.padelApproval('2026-11-03|19', AT, { fetchImpl: reply([{ ...b, splitwise: { state: null } }]), keyFile })).why).toMatch(/not claimed/);
    expect((await ab.padelApproval('2026-11-03|19', AT, { fetchImpl: reply([{ ...b, splitwise: { state: 'done' } }]), keyFile })).why).toMatch(/not claimed/);
    expect((await ab.padelApproval('2026-11-04|19', AT, { fetchImpl: reply([b]), keyFile })).why).toMatch(/no paid padel booking/);
    expect((await ab.padelApproval('2026-11-03|19', AT, { fetchImpl: reply([b], 401), keyFile })).why).toMatch(/answered 401/);
    expect((await ab.padelApproval('2026-11-03|19', AT, { fetchImpl: reply([b]), keyFile: join(dir, 'missing') })).why).toMatch(/no padel robot key/);
    expect((await ab.padelApproval('nope', AT, { fetchImpl: reply([b]), keyFile })).ok).toBe(false);
    expect((await ab.padelApproval('2026-11-03|19', null, { fetchImpl: reply([b]), keyFile })).ok).toBe(false);
  });
  it('commit takes the padel approval or the Airtable one, and checks the plan\'s proof first (source contract)', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/agent-browser.js'), 'utf8');
    const gate = src.indexOf('assertConfirmable(plan)');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(src.indexOf("padelApproval(arg(rest, 'padel-slot')"));
    expect(src).toContain("commit takes --task or --padel-slot, never both");
  });
});
