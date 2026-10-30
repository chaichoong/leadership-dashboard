#!/usr/bin/env node
// padel-paid.mjs: the padel page's "Booked and paid", carried out on the Mac mini (Kevin, 30 Oct 2026).
//
// WHAT IT DOES
// ------------
// When Kevin saves Booked and paid on his phone (the price and who is playing), the padel Worker
// lists that booking at /api/robot/paid. Every 15 minutes, right after the court read, this job:
//   1. SPLITWISE: adds one expense in Kevin's "Padel" Splitwise group, paid by Kevin and split
//      equally among the players on the booking, named "Tue 3 Nov, Cambridge, 19:30, 90 min".
//      Splitwise notifies the players itself. Splitwise's API needs a Pro account, so the robot
//      adds it in its own signed-in browser (scripts/agent-browser.js, the robot's only browser
//      route): open the group, Add an expense, the description and total, untick everyone not on
//      the booking under "equally", Save. Kevin's Booked and paid is the approval agent-browser
//      checks (commit --padel-slot). Then it reads the entry back from Splitwise and checks the
//      total and who owes what before it counts as done.
//   2. TEXTS: once that entry is done, one text from Kevin's own number (Messages: iMessage, or
//      SMS when iMessage does not deliver) to each player except Kevin, with his or her own share.
//
// SAFETY, IN CODE
// ---------------
//   * Each step is claimed at the Worker before it starts, naming the version of the booking it
//     read; the Worker refuses a second claim, and refuses any change to the booking once the
//     Splitwise step is claimed. A step that fails stays failed until Kevin taps Retry.
//   * One entry per booking. Before adding one, the group is searched for an entry on the same
//     date (Kevin may have added it himself; one booking a day is the group's rule). If there is
//     one, no second entry is made, and it must agree with the booking (total, who owes, paid by
//     Kevin) or the step fails for Kevin to check. The texts quote that entry's own shares.
//   * One text per person per booking: a ledger on this Mac (~/knowledge-os/logs/padel-paid/
//     texts.jsonl) gets a line BEFORE each send, and only a send Messages definitely refused may
//     go again. SMS follows an iMessage only when Messages shows the iMessage failed.
//   * Texts go between 07:30 and 21:30 London only, checked before every single text.
//   * No phone number, name or key is ever printed or sent to the Worker; notes say counts only.
//   * The players' phone numbers and Splitwise ids live in ~/Projects/kevin-hq/padel/players.json
//     (private, never in this repo).
//
// Usage:
//   node scripts/padel-paid.mjs run                     what launchd runs after each court read
//   node scripts/padel-paid.mjs dry-run --slot "2026-11-03|19" --price 36 --players 1,3,4,6
//        fills the Splitwise form for that booking WITHOUT saving (agent-browser prepare), prints the
//        screenshot path and the texts that would go. Claims nothing, sends nothing.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { londonParts, dayLabel } from '../workers/padel/padel.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PAID_URL = 'https://padel.runpreneur.org.uk/api/robot/paid';
export const STATE_URL = 'https://padel.runpreneur.org.uk/api/state';
export const KEY_FILE = join(homedir(), '.config/od/padel_robot_key');
export const PLAYERS_FILE = join(homedir(), 'Projects/kevin-hq/padel/players.json');
export const LOG_DIR = join(homedir(), 'knowledge-os/logs/padel-paid');
export const SW = 'https://secure.splitwise.com';
export const STALE_CLAIM_MS = 30 * 60 * 1000;      // a claim this old means the robot stopped part-way
export const TEXT_FROM = '07:30';                   // texts go out between these London times only
export const TEXT_UNTIL = '21:30';
export const TEXT_LAST_START = '21:00';
export const DELIVERY_WAIT_MS = 20000;              // how long an iMessage has to show it was delivered

// ── Pure parts ──
export const money = (pence) => (pence / 100).toFixed(2);
export const description = (b) => `${b.day}, ${b.venue.short}, ${b.start}, ${b.minutes} min`;
// Equal shares to the penny: Splitwise's own rule (the first players take the odd pennies).
export function equalShares(pricePence, n) {
  const base = Math.floor(pricePence / n);
  return Array.from({ length: n }, (_, i) => base + (i < pricePence - base * n ? 1 : 0));
}
// First names for the text; two players with one first name get an initial each ("Sam A", "Sam B").
export function firstNames(names) {
  const first = names.map((n) => String(n).trim().split(/\s+/)[0]);
  return names.map((n, i) => {
    const parts = String(n).trim().split(/\s+/);
    const clash = first.filter((f) => f === first[i]).length > 1;
    return clash && parts.length > 1 ? `${first[i]} ${parts[parts.length - 1][0]}` : first[i];
  });
}
export function textFor(b, names, sharePence) {
  return `Padel booked: ${b.day} at ${b.venue.short} (${b.venue.label}), ${b.start} for ${b.minutes} min. `
    + `Playing: ${firstNames(names).join(', ')}. Your share is £${money(sharePence)} and it's in Splitwise to settle up. Kev`;
}
// An entry already in the group for a booking. One booking a day is the group's rule, so the date
// is the match, never the time: the robot's own description, or the day and month written any usual
// way ("Tues 3rd Nov @ 19:30 (90mins)", "Nov 3rd", "3rd of Nov", "3Nov", "3 November"), on an entry dated
// within 45 days of the game (last year's "3 Nov" is not this year's). checkEntry then decides
// whether that entry agrees with the booking.
// Each month as people spell it, and nothing longer: "mar" must not find "market", nor "may" "maybe".
const MONTHS = ['jan(uary)?', 'feb(ruary)?', 'mar(ch)?', 'apr(il)?', 'may', 'june?', 'july?', 'aug(ust)?', 'sep(t|tember)?', 'oct(ober)?', 'nov(ember)?', 'dec(ember)?'];
export function sameBooking(expense, b) {
  if (!expense || expense.deleted_at) return false;
  const when = Date.parse(expense.date || expense.created_at || '');
  if (Number.isFinite(when) && Math.abs(when - Date.parse(`${b.date}T12:00:00Z`)) > 45 * 86400000) return false;
  const d = String(expense.description || '');
  if (d === description(b)) return true;
  const day = Number(b.date.slice(8, 10));
  const mon = `(${MONTHS[Number(b.date.slice(5, 7)) - 1]})`;
  const th = '(st|nd|rd|th)?';
  return new RegExp(`\\b0?${day}${th}(\\s+of)?\\s*${mon}\\b|\\b${mon}\\.?\\s*0?${day}${th}\\b`, 'i').test(d);
}
// The Splitwise form, as agent-browser plan steps. Everyone in the group who is not playing is
// unticked under "equally", by the Splitwise id on his or her row; the players stay ticked.
export function buildPlan(b, groupId, memberIds, playerIds) {
  const desc = description(b);
  const out = memberIds.filter((id) => !playerIds.includes(id));
  return {
    host: 'secure.splitwise.com',
    steps: [
      { do: 'goto', url: `${SW}/#/groups/${groupId}` },
      { do: 'wait', for: 'text=Add an expense' },
      { do: 'click', selector: 'text=Add an expense' },
      { do: 'wait', for: 'input.description' },
      { do: 'fill', selector: 'input.description', value: desc },
      { do: 'fill', selector: "input[placeholder='0.00']", value: money(b.pricePence) },
      { do: 'click', selector: 'text=equally' },
      { do: 'wait', for: '.split_method.equal .person' },
      ...out.map((id) => ({ do: 'click', selector: `.split_method.equal .person[data-id='${id}'] input.share` })),
      { do: 'wait', ms: 1000 },
      { do: 'submit', selector: "button.submit:has-text('Save')" },
    ],
    confirm: { selector: `text="${desc}"`, timeoutMs: 20000 },
  };
}
// The entries in the group for a booking: the robot's own (by its exact description) and any Kevin
// added himself. More than one is a mess for Kevin to sort out, never a reason to add another.
export const entriesFor = (expenses, b) => (expenses || []).filter((e) => sameBooking(e, b));
// An entry checked against the booking: the total, exactly the players owing, and paid by Kevin.
export function checkEntry(e, b, kevinId, playerIds) {
  if (!e) return { ok: false, why: 'the entry is not in the group' };
  const cost = Math.round(Number(e.cost) * 100);
  if (cost !== b.pricePence) return { ok: false, why: `the entry says £${money(cost)}, not £${money(b.pricePence)}`, id: e.id };
  const owes = {};
  for (const u of e.users || []) { const o = Math.round(Number(u.owed_share) * 100); if (o > 0) owes[u.user_id ?? u.user?.id] = o; }
  const byNumber = (x, y) => x - y;
  const owing = Object.keys(owes).map(Number).sort(byNumber);
  if (JSON.stringify(owing) !== JSON.stringify([...playerIds].sort(byNumber))) return { ok: false, why: `${owing.length} people owe on the entry, not the ${playerIds.length} playing`, id: e.id };
  const payer = (e.users || []).find((u) => (u.user_id ?? u.user?.id) === kevinId);
  if (!payer || Math.round(Number(payer.paid_share) * 100) !== b.pricePence) return { ok: false, why: 'the entry is not paid by Kevin', id: e.id };
  return { ok: true, id: e.id, owes };
}
const clock = (ms) => { const p = londonParts(ms); return `${p.hh}:${p.mm}`; };
export const textHours = (ms) => clock(ms) >= TEXT_FROM && clock(ms) < TEXT_UNTIL;
// A texts step starts by 21:00, so a normal run (a few players, under a minute each) ends well
// before 21:30; the 21:30 check before each text only bites if the Mac slept mid-run.
export const textStart = (ms) => textHours(ms) && clock(ms) < TEXT_LAST_START;

// ── The outside world, behind small functions the tests replace ──
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: opts.timeout || 240000 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
  });
});
const AB = join(HERE, 'agent-browser.js');
export async function browser(args) { return run(process.execPath, [AB, ...args]); }
// A JSON page read through the robot's signed-in Splitwise session (agent-browser read).
export async function swJson(url, ab = browser) {
  const r = await ab(['read', '--url', url, '--max-text', '400000']);
  if (r.code !== 0) return null;
  try {
    const text = JSON.parse(r.stdout).text || '';
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}
const OSA_SEND = [
  'on run argv',
  '  set theNumber to item 1 of argv',
  '  set theText to item 2 of argv',
  '  set theService to item 3 of argv',
  '  tell application "Messages"',
  '    if theService is "SMS" then',
  '      set svc to first account whose service type = SMS',
  '    else',
  '      set svc to first account whose service type = iMessage',
  '    end if',
  '    send theText to participant theNumber of svc',
  '  end tell',
  'end run',
];
export async function sendMessage(number, text, service) {
  const args = OSA_SEND.flatMap((l) => ['-e', l]).concat([number, text, service]);
  return run('/usr/bin/osascript', args, { timeout: 60000 });
}
// Did Messages deliver the last text to that number? Read-only on its own database.
export async function deliveryOf(number, sinceMs) {
  const digits = number.replace(/\D/g, '').slice(-10);
  const apple = Math.floor((sinceMs / 1000 - 978307200) * 1e9);
  const sql = `SELECT m.error, m.is_delivered, m.is_sent, m.service FROM message m JOIN handle h ON h.ROWID = m.handle_id
    WHERE m.is_from_me = 1 AND m.date >= ${apple} AND replace(replace(h.id, '+', ''), ' ', '') LIKE '%${digits}' ORDER BY m.date DESC LIMIT 1;`;
  const r = await run('/usr/bin/sqlite3', ['-readonly', '-separator', '|', `file:${join(homedir(), 'Library/Messages/chat.db')}?mode=ro`, sql], { timeout: 20000 });
  if (r.code !== 0) return { known: false, readable: false };
  if (!r.stdout.trim()) return { known: false, readable: true };   // readable, and no such message
  const [error, delivered, sent, service] = r.stdout.trim().split('|');
  return { known: true, readable: true, error: Number(error) || 0, delivered: delivered === '1', sent: sent === '1', service };
}
// One text per person. iMessage first; SMS only when Messages' own record shows the iMessage failed,
// or osascript failed and Messages holds no such message at all. Anything else that is not a clear
// "sent" is unsure (ok: null): never sent again, and counted as not confirmed.
export async function texted(number, text, { send = sendMessage, delivery = deliveryOf, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const t0 = now() - 2000;
  const first = await send(number, text, 'iMessage');
  if (/-1743|not authori[sz]ed/i.test(first.stderr || '')) return { ok: false, why: 'Messages needs permission on the Mac (Privacy, Automation)' };
  let d = { known: false, readable: false };
  for (let waited = 0; waited < DELIVERY_WAIT_MS; waited += 4000) {
    await sleep(4000);
    d = await delivery(number, t0);
    if (d.known && d.error) break;                                   // iMessage refused: send it as a text
    if (d.known && (d.delivered || d.sent)) return { ok: true, via: 'iMessage' };
  }
  const refused = (d.known && d.error) || (first.code !== 0 && d.readable && !d.known);
  if (!refused) {
    return { ok: null, via: first.code !== 0 ? 'iMessage (Messages did not answer)' : d.readable ? 'iMessage (not yet delivered)' : 'iMessage (delivery not readable)' };
  }
  const sms = await send(number, text, 'SMS');
  return sms.code === 0 ? { ok: true, via: 'SMS' } : { ok: false, why: 'Messages refused both iMessage and SMS' };
}

// ── The run ──
function readKey() { try { return readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; } }
function readPlayers() { try { return JSON.parse(readFileSync(PLAYERS_FILE, 'utf8')); } catch { return null; } }
// The texts ledger. A line goes in BEFORE each send and another after it. A person's last line
// decides: sent (ok true) or unsure ("sending", ok null) is never sent again; only a send Messages
// refused (ok false) may go again.
export function makeLedger(file = join(LOG_DIR, 'texts.jsonl')) {
  const rows = () => {
    try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }      // unreadable: stop, never guess
  };
  return {
    last: (slot, person) => rows().filter((r) => r.slot === slot && r.person === person).pop() || null,
    add: (row) => { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, `${JSON.stringify(row)}\n`); },
  };
}

export async function runOnce({ fetchImpl = globalThis.fetch, ab = browser, now = Date.now, log = (l) => process.stdout.write(`${l}\n`),
  key = readKey(), players = readPlayers(), textOne = texted, ledger = makeLedger(), logDir = LOG_DIR } = {}) {
  if (!key) { log(`FAILED: padel-paid: no robot key at ${KEY_FILE}`); return 1; }
  const headers = { 'X-Robot-Key': key, 'Content-Type': 'application/json' };
  const get = await fetchImpl(PAID_URL, { headers, signal: AbortSignal.timeout(20000) }).catch(() => null);
  if (!get || get.status !== 200) { log(`FAILED: padel-paid: the Worker answered ${get ? get.status : 'nothing'}`); return 1; }
  const { bookings = [] } = await get.json();
  if (!bookings.length) return 0;                                   // nothing paid and waiting: silent
  if (!players || !players.players || !players.splitwise_group) { log(`FAILED: padel-paid: no players file at ${PLAYERS_FILE}`); return 1; }
  const problems = [];
  // A claim that does not win is normal (another run has it, or the booking changed). A done or
  // failed the Worker did not record is not: it is reported, and the claim goes stale for Kevin.
  const mark = async (b, step, state, note) => {
    const r = await fetchImpl(PAID_URL, { method: 'POST', headers, body: JSON.stringify({ slot: b.slot, step, state, note, paidAt: b.paidAt }), signal: AbortSignal.timeout(20000) }).catch(() => null);
    const ok = !!(r && r.status === 200 && (await r.json().catch(() => ({}))).changed);
    if (!ok && state !== 'claimed') problems.push(`${b.slot} ${step}: the Worker did not record ${state}`);
    return ok;
  };
  const kevin = Object.entries(players.players).find(([, p]) => p.self);
  const kevinSw = kevin ? kevin[1].splitwise_id : null;
  for (const b of bookings) {
    // A claim left behind by a run that stopped part-way: failed, so Kevin decides (check Splitwise, then Retry).
    for (const step of ['splitwise', 'texts']) {
      if (b[step].state === 'claimed' && now() - Date.parse(b[step].at) > STALE_CLAIM_MS) {
        await mark(b, step, 'failed', 'the robot stopped part-way: check Splitwise before Retry');
        problems.push(`${b.slot} ${step} was left part-way`);
      }
    }
    if (b.splitwise.state === null) {
      const r = await splitwiseStep(b, { players, kevinSw, ab, mark, now, logDir });
      if (r) problems.push(`${b.slot} Splitwise: ${r}`);
    } else if (b.splitwise.state === 'done' && b.texts.state === null) {
      if (!textStart(now())) continue;                              // texts wait for the morning
      const r = await textsStep(b, { players, kevinSw, ab, mark, textOne, ledger, now });
      if (r) problems.push(`${b.slot} texts: ${r}`);
    }
  }
  if (problems.length) { log(`FAILED: padel-paid: ${problems.join('; ')}`); return 1; }
  return 0;
}

async function splitwiseStep(b, { players, kevinSw, ab, mark, now, logDir }) {
  const gid = players.splitwise_group.id;
  const ids = b.players.map((p) => players.players[String(p.id)] && players.players[String(p.id)].splitwise_id);
  const group = (await swJson(`${SW}/api/v3.0/get_group/${gid}`, ab))?.group;
  if (!group) return 'could not read the Splitwise group (is the robot still signed in?)';   // nothing claimed: tried again next run
  const members = (group.members || []).map((m) => m.id);
  const missing = ids.filter((id) => !id || !members.includes(id)).length;
  if (missing || !kevinSw) {
    if (await mark(b, 'splitwise', 'claimed')) await mark(b, 'splitwise', 'failed', `${missing || 1} of the players is not in the Splitwise group`);
    return `${missing || 1} player(s) not in the Splitwise group`;
  }
  const recent = (await swJson(`${SW}/api/v3.0/get_expenses?group_id=${gid}&limit=40`, ab))?.expenses;
  if (!recent) return 'could not read the group\'s entries';
  if (!(await mark(b, 'splitwise', 'claimed'))) return null;          // someone else has it, or the booking changed
  const already = entriesFor(recent, b);
  if (already.length > 1) {
    await mark(b, 'splitwise', 'failed', `${already.length} entries for this day are already in Splitwise: check them before Retry`);
    return `${already.length} entries for this day already in Splitwise`;
  }
  if (already.length) {
    const c = checkEntry(already[0], b, kevinSw, ids);
    if (c.ok) { await mark(b, 'splitwise', 'done', `already in Splitwise (entry ${c.id})`); return null; }
    await mark(b, 'splitwise', 'failed', `an entry for this day is already in Splitwise, but ${c.why}: correct it, then Retry`);
    return `the entry already in Splitwise disagrees: ${c.why}`;
  }
  const plan = buildPlan(b, gid, members, ids);
  mkdirSync(logDir, { recursive: true });
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const planFile = join(logDir, `plan-${stamp}.json`);
  writeFileSync(planFile, JSON.stringify(plan, null, 1));
  const shot = join(logDir, `splitwise-${stamp}.png`);
  const r = await ab(['commit', '--plan', planFile, '--padel-slot', b.slot, '--padel-paid-at', b.paidAt, '--shot', shot]);
  if (r.code !== 0) {
    await mark(b, 'splitwise', 'failed', 'the robot could not save it: check Splitwise before Retry');
    return `the save did not go through (screenshot ${shot})`;
  }
  const after = (await swJson(`${SW}/api/v3.0/get_expenses?group_id=${gid}&limit=40`, ab))?.expenses;
  const saved = (after || []).filter((e) => !e.deleted_at && e.description === description(b)).sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))[0];
  const check = checkEntry(saved, b, kevinSw, ids);
  if (!check.ok) {
    await mark(b, 'splitwise', 'failed', `saved, but ${check.why}: check Splitwise`);
    return check.why;
  }
  await mark(b, 'splitwise', 'done', `entry ${check.id}`);
  return null;
}

async function textsStep(b, { players, kevinSw, ab, mark, textOne, ledger, now }) {
  // The texts quote the entry Splitwise holds, read before anything is claimed: the one the
  // Splitwise step named, else the one entry for that date.
  const gid = players.splitwise_group.id;
  const ids = b.players.map((p) => players.players[String(p.id)]?.splitwise_id);
  const expenses = (await swJson(`${SW}/api/v3.0/get_expenses?group_id=${gid}&limit=40`, ab))?.expenses;
  if (!expenses) return 'could not read the group\'s entries';           // nothing claimed: tried again next run
  const named = /entry (\d+)/.exec(b.splitwise.note || '');
  const live = expenses.filter((e) => !e.deleted_at);
  const mine = entriesFor(live, b);
  const entry = (named && live.find((e) => String(e.id) === named[1])) || (mine.length === 1 ? mine[0] : null);
  if (!(await mark(b, 'texts', 'claimed'))) return null;
  const check = checkEntry(entry, b, kevinSw, ids);
  if (!check.ok) {
    await mark(b, 'texts', 'failed', `no texts sent: the Splitwise entry no longer matches (${check.why})`);
    return `the Splitwise entry no longer matches: ${check.why}`;
  }
  const names = b.players.map((p) => p.name);
  let sent = 0;
  let due = 0;
  let unsure = 0;
  let why = '';
  let late = false;
  for (const p of b.players) {
    const info = players.players[String(p.id)];
    if (!info || info.self) continue;
    due++;
    const last = ledger.last(b.slot, p.id);
    if (last && last.ok !== false) { sent++; if (last.ok !== true) unsure++; continue; }   // never twice to one person
    if (!textHours(now())) { late = true; continue; }                 // checked before every text
    const number = (info.phones || [])[0];
    if (!number) { why = why || 'a player has no phone number'; continue; }
    ledger.add({ at: new Date(now()).toISOString(), slot: b.slot, person: p.id, state: 'sending' });
    const r = await textOne(number, textFor(b, names, check.owes[info.splitwise_id]));
    ledger.add({ at: new Date(now()).toISOString(), slot: b.slot, person: p.id, ok: r.ok, via: r.via || null });   // ok: true, false or null (unsure)
    if (r.ok !== false) sent++; else why = why || r.why || 'Messages did not send it';
    if (r.ok === null) unsure++;
  }
  const note = `${sent} of ${due} sent${unsure ? ` (${unsure} not confirmed)` : ''}${late ? '; the rest wait: Retry after 07:30' : ''}${why ? `: ${why}` : ''}`;
  if (sent === due) { await mark(b, 'texts', 'done', note); return null; }
  await mark(b, 'texts', 'failed', note);
  return note;
}

// ── The dry run: the Splitwise form filled for a booking, never saved, and the texts shown ──
export async function dryRun({ slot, price, playerIds }, { fetchImpl = globalThis.fetch, ab = browser, log = (l) => process.stdout.write(`${l}\n`), players = readPlayers(), now = Date.now } = {}) {
  const state = await (await fetchImpl(STATE_URL)).json();
  const b0 = state.booked[slot];
  if (!b0 || !b0.start || !b0.minutes) { log(`dry-run: no booking with a start and length at ${slot}`); return 1; }
  const people = new Map(state.people.map((p) => [p.id, p]));
  const date = slot.split('|')[0];
  const b = { slot, date, day: dayLabel(date), venue: { code: b0.venue, short: state.venueInfo[b0.venue].short, label: state.venueInfo[b0.venue].label }, start: b0.start, minutes: b0.minutes,
    pricePence: Math.round(price * 100), players: playerIds.map((id) => ({ id, name: people.get(id)?.name || `person ${id}` })) };
  const gid = players.splitwise_group.id;
  const group = (await swJson(`${SW}/api/v3.0/get_group/${gid}`, ab))?.group;
  if (!group) { log('dry-run: could not read the Splitwise group'); return 1; }
  const ids = playerIds.map((id) => players.players[String(id)]?.splitwise_id);
  const plan = buildPlan(b, gid, group.members.map((x) => x.id), ids);
  mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const planFile = join(LOG_DIR, `dry-run-${stamp}.json`);
  writeFileSync(planFile, JSON.stringify(plan, null, 1));
  const shot = join(LOG_DIR, `dry-run-${stamp}.png`);
  const r = await ab(['prepare', '--plan', planFile, '--shot', shot]);
  log(r.code === 0 ? `dry-run: Splitwise form filled, NOT saved: ${shot}` : `dry-run: the form could not be filled: ${(r.stderr || r.stdout).slice(-300)}`);
  const shares = equalShares(b.pricePence, b.players.length);
  b.players.forEach((p, i) => { if (!players.players[String(p.id)]?.self) log(`dry-run: text to ${p.name}: ${textFor(b, b.players.map((x) => x.name), shares[i])}`); });
  return r.code === 0 ? 0 : 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'run') process.exit(await runOnce());
  else if (cmd === 'dry-run') process.exit(await dryRun({ slot: opt('slot'), price: Number(opt('price')), playerIds: String(opt('players') || '').split(',').map(Number).filter(Boolean) }));
  else { process.stdout.write('Usage: padel-paid.mjs run | dry-run --slot "YYYY-MM-DD|HH" --price 36 --players 1,3,4\n'); process.exit(2); }
}
