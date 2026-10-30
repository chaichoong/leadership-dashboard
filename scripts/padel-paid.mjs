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
//   * Before adding an entry, the group is searched for one on the same day and time (Kevin may
//     have added it himself): if there is one, no second entry is made.
//   * A text is never sent twice to the same person for the same booking: a ledger on this Mac
//     (~/knowledge-os/logs/padel-paid/texts.jsonl) is read before every send.
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
export const DELIVERY_WAIT_MS = 20000;              // how long an iMessage has to show it was delivered

// ── Pure parts ──
export const money = (pence) => (pence / 100).toFixed(2);
export const description = (b) => `${b.day}, ${b.venue.short}, ${b.start}, ${b.minutes} min`;
// Equal shares to the penny: Splitwise's own rule (the first players take the odd pennies).
export function equalShares(pricePence, n) {
  const base = Math.floor(pricePence / n);
  return Array.from({ length: n }, (_, i) => base + (i < pricePence - base * n ? 1 : 0));
}
// First names for the text; two players with one first name get an initial each ("Rich B", "Rich M").
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
// An entry already in the group for that day and time: our own name for it, or Kevin's own way of
// writing it ("Tues 3rd Nov @ 19:30 (90mins)", "Sun 1 Nov 13:00 Huntingdon (60 mins)").
export function sameBooking(expense, b) {
  if (!expense || expense.deleted_at) return false;
  const d = String(expense.description || '');
  if (d === description(b)) return true;
  const [, , day] = b.date.split('-').map(Number);
  const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][Number(b.date.slice(5, 7)) - 1];
  const dayRe = new RegExp(`\\b${day}(st|nd|rd|th)?\\s*${mon}`, 'i');
  const time = b.start.replace(':', '[:.]');
  return dayRe.test(d) && new RegExp(`\\b${time}\\b`).test(d);
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
// The entry read back: the newest live expense with our description, its total and who owes what.
export function checkEntry(expenses, b, kevinId, playerIds) {
  const e = (expenses || []).filter((x) => !x.deleted_at && x.description === description(b)).sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))[0];
  if (!e) return { ok: false, why: 'the new entry is not in the group' };
  const cost = Math.round(Number(e.cost) * 100);
  if (cost !== b.pricePence) return { ok: false, why: `the entry says £${money(cost)}, not £${money(b.pricePence)}`, id: e.id };
  const owes = {};
  for (const u of e.users || []) { const o = Math.round(Number(u.owed_share) * 100); if (o > 0) owes[u.user_id ?? u.user?.id] = o; }
  const owing = Object.keys(owes).map(Number).sort();
  if (JSON.stringify(owing) !== JSON.stringify([...playerIds].sort())) return { ok: false, why: `${owing.length} people owe on the entry, not the ${playerIds.length} playing`, id: e.id };
  const payer = (e.users || []).find((u) => (u.user_id ?? u.user?.id) === kevinId);
  if (!payer || Math.round(Number(payer.paid_share) * 100) !== b.pricePence) return { ok: false, why: 'the entry is not paid by Kevin', id: e.id };
  return { ok: true, id: e.id, owes };
}
const clock = (ms) => { const p = londonParts(ms); return `${p.hh}:${p.mm}`; };
export const textHours = (ms) => clock(ms) >= TEXT_FROM && clock(ms) < TEXT_UNTIL;

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
  if (r.code !== 0) return { known: false };
  const [error, delivered, sent, service] = r.stdout.trim().split('|');
  if (!r.stdout.trim()) return { known: false };
  return { known: true, error: Number(error) || 0, delivered: delivered === '1', sent: sent === '1', service };
}
export async function texted(number, text, { send = sendMessage, delivery = deliveryOf, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const t0 = now() - 2000;
  const first = await send(number, text, 'iMessage');
  if (first.code === 0) {
    for (let waited = 0; waited < DELIVERY_WAIT_MS; waited += 4000) {
      await sleep(4000);
      const d = await delivery(number, t0);
      if (d.known && d.error) break;                         // iMessage refused: send it as a text
      if (d.known && (d.delivered || d.sent)) return { ok: true, via: 'iMessage' };
      if (!d.known && waited >= 8000) return { ok: true, via: 'iMessage (delivery not readable)' };
    }
  }
  const sms = await send(number, text, 'SMS');
  return sms.code === 0 ? { ok: true, via: 'SMS' } : { ok: false, why: 'Messages refused both iMessage and SMS' };
}

// ── The run ──
function readKey() { try { return readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; } }
function readPlayers() { try { return JSON.parse(readFileSync(PLAYERS_FILE, 'utf8')); } catch { return null; } }
function ledgerHas(slot, person) {
  try {
    return readFileSync(join(LOG_DIR, 'texts.jsonl'), 'utf8').split('\n').filter(Boolean).some((l) => { const r = JSON.parse(l); return r.slot === slot && r.person === person && r.ok; });
  } catch { return false; }
}
function ledgerAdd(row) { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(join(LOG_DIR, 'texts.jsonl'), `${JSON.stringify(row)}\n`); }

export async function runOnce({ fetchImpl = globalThis.fetch, ab = browser, now = Date.now, log = (l) => process.stdout.write(`${l}\n`),
  key = readKey(), players = readPlayers(), textOne = texted, has = ledgerHas, add = ledgerAdd } = {}) {
  if (!key) { log(`FAILED: padel-paid: no robot key at ${KEY_FILE}`); return 1; }
  const headers = { 'X-Robot-Key': key, 'Content-Type': 'application/json' };
  const get = await fetchImpl(PAID_URL, { headers, signal: AbortSignal.timeout(20000) }).catch(() => null);
  if (!get || get.status !== 200) { log(`FAILED: padel-paid: the Worker answered ${get ? get.status : 'nothing'}`); return 1; }
  const { bookings = [] } = await get.json();
  if (!bookings.length) return 0;                                   // nothing paid and waiting: silent
  if (!players || !players.players || !players.splitwise_group) { log(`FAILED: padel-paid: no players file at ${PLAYERS_FILE}`); return 1; }
  const mark = async (b, step, state, note) => {
    const r = await fetchImpl(PAID_URL, { method: 'POST', headers, body: JSON.stringify({ slot: b.slot, step, state, note, paidAt: b.paidAt }) }).catch(() => null);
    return !!(r && r.status === 200 && (await r.json()).changed);
  };
  const kevin = Object.entries(players.players).find(([, p]) => p.self);
  const kevinSw = kevin ? kevin[1].splitwise_id : null;
  const problems = [];
  for (const b of bookings) {
    // A claim left behind by a run that stopped part-way: failed, so Kevin decides (check Splitwise, then Retry).
    for (const step of ['splitwise', 'texts']) {
      if (b[step].state === 'claimed' && now() - Date.parse(b[step].at) > STALE_CLAIM_MS) {
        await mark(b, step, 'failed', 'the robot stopped part-way: check Splitwise before Retry');
        problems.push(`${b.slot} ${step} was left part-way`);
      }
    }
    if (b.splitwise.state === null) {
      const r = await splitwiseStep(b, { players, kevinSw, ab, mark, now });
      if (r) problems.push(`${b.slot} Splitwise: ${r}`);
    } else if (b.splitwise.state === 'done' && b.texts.state === null) {
      if (!textHours(now())) continue;                               // texts wait for the morning
      const r = await textsStep(b, { players, kevinSw, ab, mark, textOne, has, add, now });
      if (r) problems.push(`${b.slot} texts: ${r}`);
    }
  }
  if (problems.length) { log(`FAILED: padel-paid: ${problems.join('; ')}`); return 1; }
  return 0;
}

async function splitwiseStep(b, { players, kevinSw, ab, mark, now }) {
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
  const already = recent.find((e) => sameBooking(e, b));
  if (already) { await mark(b, 'splitwise', 'done', `already in Splitwise (entry ${already.id})`); return null; }
  const plan = buildPlan(b, gid, members, ids);
  mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const planFile = join(LOG_DIR, `plan-${stamp}.json`);
  writeFileSync(planFile, JSON.stringify(plan, null, 1));
  const shot = join(LOG_DIR, `splitwise-${stamp}.png`);
  const r = await ab(['commit', '--plan', planFile, '--padel-slot', b.slot, '--padel-paid-at', b.paidAt, '--shot', shot]);
  if (r.code !== 0) {
    await mark(b, 'splitwise', 'failed', 'the robot could not save it: check Splitwise before Retry');
    return `the save did not go through (screenshot ${shot})`;
  }
  const after = (await swJson(`${SW}/api/v3.0/get_expenses?group_id=${gid}&limit=40`, ab))?.expenses;
  const check = checkEntry(after, b, kevinSw, ids);
  if (!check.ok) {
    await mark(b, 'splitwise', 'failed', `saved, but ${check.why}: check Splitwise`);
    return check.why;
  }
  await mark(b, 'splitwise', 'done', `entry ${check.id}`);
  return null;
}

async function textsStep(b, { players, kevinSw, ab, mark, textOne, has, add, now }) {
  if (!(await mark(b, 'texts', 'claimed'))) return null;
  const gid = players.splitwise_group.id;
  const ids = b.players.map((p) => players.players[String(p.id)]?.splitwise_id);
  // Each player's own share from the entry; the equal split if the entry cannot be read.
  const expenses = (await swJson(`${SW}/api/v3.0/get_expenses?group_id=${gid}&limit=40`, ab))?.expenses;
  const check = checkEntry(expenses, b, kevinSw, ids);
  const equal = equalShares(b.pricePence, b.players.length);
  const names = b.players.map((p) => p.name);
  let sent = 0;
  let due = 0;
  for (const [i, p] of b.players.entries()) {
    const info = players.players[String(p.id)];
    if (!info || info.self) continue;
    due++;
    if (has(b.slot, p.id)) { sent++; continue; }                     // never twice to one person
    const number = (info.phones || [])[0];
    if (!number) continue;
    const share = check.ok && check.owes[info.splitwise_id] ? check.owes[info.splitwise_id] : equal[i];
    const r = await textOne(number, textFor(b, names, share));
    add({ at: new Date(now()).toISOString(), slot: b.slot, person: p.id, ok: r.ok, via: r.via || null });
    if (r.ok) sent++;
  }
  if (sent === due) { await mark(b, 'texts', 'done', `${sent} of ${due} sent`); return null; }
  await mark(b, 'texts', 'failed', `${sent} of ${due} sent`);
  return `${sent} of ${due} sent`;
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
