// lib.mjs — the pure half of the multi-tenant CEO Brief worker.
//
// Everything here takes plain values and returns plain values: no fetch, no env,
// no secrets. worker.js imports it for the real run; tests/ceo-brief-tenants.test.js
// imports it directly. The logic is ported from Kevin's single-tenant brief
// (scripts/slack-automation/money-daily-worker.js) with every Kevin-specific
// fact replaced by a field on the tenant's config (js/ceo-brief-defaults.mjs).

import { mergeConfig, missingForGoLive, FOUNDER_ONLY } from '../../js/ceo-brief-defaults.mjs';

// ── Time, per tenant timezone ──────────────────────────────────────────────
// Cron fires hourly across the world's mornings; the DAY and the HOUR are decided
// here, in the tenant's own zone. Never in the cron (Cloudflare counts Sunday as 1).
export function localParts(tz, now = new Date()) {
  const zone = tz || 'Europe/London';
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: 'numeric', hour12: false })
    .formatToParts(now).find(p => p.type === 'hour').value) % 24;
  const weekday = new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0 = Sun … 6 = Sat
  return { ymd, hour, weekday };
}

export function localDate(tz, now = new Date()) { return localParts(tz, now).ymd; }

export function localDateLabel(tz, now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/London', weekday: 'long', day: 'numeric', month: 'long' }).format(now);
}

// True when this tenant's brief is due: a working day (if they asked for weekdays
// only) and the local hour is send_hour, send_hour+1 or send_hour+2. The wide
// window plus the idempotency check in worker.js is what makes a missed firing
// recoverable without sending three briefs.
export function isSendWindow(cfg, now = new Date()) {
  const c = mergeConfig(cfg);
  const { hour, weekday } = localParts(c.timezone, now);
  const dayOk = !c.weekdays_only || (weekday >= 1 && weekday <= 5);
  const start = Number(c.send_hour);
  return dayOk && hour >= start && hour <= start + 2;
}

// Plain-English description of the next window, for the tenants endpoint.
export function nextWindow(cfg) {
  const c = mergeConfig(cfg);
  return `${String(c.send_hour).padStart(2, '0')}:00 to ${String(c.send_hour + 2).padStart(2, '0')}:59 ${c.timezone}${c.weekdays_only ? ', Monday to Friday' : ', every day'}`;
}

// Why a tenant is skipped before any work is done, or null when it may run.
export function skipReason(cfg) {
  const c = mergeConfig(cfg);
  if (!c.enabled) return 'brief is switched off for this workspace';
  const missing = missingForGoLive(c);
  if (missing.length) return `setup incomplete: ${missing.join(', ')}`;
  return null;
}

export const surname = head => String(head || '').trim().split(/\s+/).pop() || 'Board';
export const firstName = name => String(name || '').trim().split(/\s+/)[0] || 'you';

// ── Tasks ──────────────────────────────────────────────────────────────────
// Status 'Approval' is FINISHED agent work waiting on one tick. It is its own
// bucket and never counted as overdue. `rows` are already mapped to
// { name, who, due, status, priority, type }.
export function shapeTasks(rows, todayISO, cfg) {
  const c = mergeConfig(cfg);
  const approvalStatus = c.tasks_source.approval_status || 'Approval';
  const sendType = c.tasks_source.correspondence_type || 'Correspondence';
  const founder = firstName(c.founder.name).toLowerCase();
  const t = (rows || []).map(x => ({
    name: String(x.name || '').slice(0, 90),
    who: String(x.who || 'unassigned'),
    due: String(x.due || '').slice(0, 10),
    status: String(x.status || ''),
    priority: String(x.priority || ''),
    type: String(x.type || ''),
  })).filter(x => x.name);
  const waiting = t.filter(x => x.status === approvalStatus);
  const live = t.filter(x => x.status !== approvalStatus);
  const overdue = live.filter(x => x.due && x.due < todayISO);
  const dueToday = live.filter(x => x.due === todayISO);
  const founders = founder ? live.filter(x => x.who.toLowerCase().includes(founder)) : [];
  const sends = waiting.filter(x => x.type === sendType);
  const line = x => `- ${x.name} | ${x.who} | due ${x.due || 'none'} | ${x.priority || x.status}`;
  const waitLine = x => `- ${x.name}${x.type === sendType ? ' | APPROVING SENDS THE EMAIL' : ''} | waiting since ${x.due || 'unknown'}`;
  return {
    connected: true,
    counts: { open: live.length, overdue: overdue.length, dueToday: dueToday.length, founders: founders.length, awaitingApproval: waiting.length, awaitingSend: sends.length },
    overdueList: overdue.slice(0, 20).map(line).join('\n'),
    dueTodayList: dueToday.slice(0, 15).map(line).join('\n'),
    founderList: founders.slice(0, 25).map(line).join('\n'),
    approvalList: waiting.slice(0, 20).map(waitLine).join('\n'),
    approvalNames: waiting.map(x => x.name.toLowerCase()),
    approvalDisplayNames: waiting.map(x => x.name),
  };
}

export function emptyTasks(note = '(tasks not connected)') {
  return {
    connected: false, note,
    counts: { open: 0, overdue: 0, dueToday: 0, founders: 0, awaitingApproval: 0, awaitingSend: 0 },
    overdueList: '', dueTodayList: '', founderList: '', approvalList: '', approvalNames: [], approvalDisplayNames: [],
  };
}

// ── Calendar ───────────────────────────────────────────────────────────────
// Today's events from an ICS feed as "HH:MM — title" lines. Folded lines are
// joined, SUMMARY parameters tolerated, and a trailing Z is converted to the
// tenant's zone. Recurring events are not expanded (known gap, documented).
export function parseIcsToday(ics, todayISO, tz = 'Europe/London') {
  const unfolded = String(ics).replace(/\r?\n[ \t]/g, '');
  const today = todayISO.replace(/-/g, '');
  const events = [];
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const dt = (block.match(/DTSTART[^:]*:(\d{8}(T\d{6}Z?)?)/) || [])[1] || '';
    if (!dt) continue;
    let time;
    if (!dt.includes('T')) {
      if (dt !== today) continue;
      time = 'all day';
    } else if (dt.endsWith('Z')) {
      const utc = new Date(`${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}T${dt.slice(9, 11)}:${dt.slice(11, 13)}:${dt.slice(13, 15)}Z`);
      if (new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(utc) !== todayISO) continue;
      time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(utc);
    } else {
      if (!dt.startsWith(today)) continue;
      time = `${dt.slice(9, 11)}:${dt.slice(11, 13)}`;
    }
    const summary = ((block.match(/^SUMMARY[^:\n]*:(.*)$/m) || [])[1] || '').trim();
    if (summary) events.push(`${time} — ${summary}`);
  }
  return events.sort().join('\n');
}

// ── Money ──────────────────────────────────────────────────────────────────
export function moneyFromConfig(cfg) {
  const c = mergeConfig(cfg);
  const src = c.money_source || {};
  if (src.kind === 'manual') {
    const light = ['green', 'amber', 'red'].includes(src.manual_light) ? src.manual_light : 'green';
    const n = src.manual_safe_to_act;
    const safe = n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? null : Number(n);
    return { connected: true, light, safe_to_act: safe };
  }
  return { connected: false, light: null, safe_to_act: null };
}

export const fmtMoney = n => (n === null || n === undefined) ? 'not set' : '£' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function moneyLine(money) {
  if (!money.connected) return 'not connected';
  return `light ${String(money.light).toUpperCase()}, safe to act today ${fmtMoney(money.safe_to_act)}`;
}

// ── Prompt blocks shared by the seats and the CEO ──────────────────────────
function founderBlock(c) {
  const f = c.founder;
  const lines = [
    `Founder: ${f.name}. Business: ${f.business}. Sells: ${f.what_it_sells}${f.to_whom ? ` to ${f.to_whom}` : ''}.`,
    f.mission ? `Mission: ${f.mission}` : '',
    f.twelve_month_target ? `Twelve-month target: ${f.twelve_month_target}` : '',
    f.wheelhouse.length ? `Only the founder does: ${f.wheelhouse.join('; ')}.` : '',
    f.never_see.length ? `The founder never wants to see: ${f.never_see.join('; ')}.` : '',
    f.non_negotiables.length ? `Non-negotiables: ${f.non_negotiables.join('; ')}.` : '',
    f.income_floor ? `Income floor: ${f.income_floor}.` : '',
    f.sensitive_flag ? 'There is a sensitive matter. Be extra careful in anything written. Never speculate about it.' : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function tasksBlock(t, founderFirst) {
  if (!t.connected) return `TASKS: ${t.note || '(tasks not connected)'}`;
  return `TASKS (live): ${t.counts.open} open, ${t.counts.overdue} overdue, ${t.counts.dueToday} due today, ${t.counts.founders} carrying ${founderFirst}'s name.
WAITING ON ${founderFirst.toUpperCase()}'S TICK: ${t.counts.awaitingApproval} finished pieces of agent work wait for approval, ${t.counts.awaitingSend} of them emails that SEND the moment they are approved. This is DONE work, not work to do.
${t.approvalList || '(none)'}
OVERDUE (top):
${t.overdueList || '(none)'}
DUE TODAY:
${t.dueTodayList || '(none)'}
${founderFirst.toUpperCase()}'S OPEN TASKS (top):
${t.founderList || '(none)'}`;
}

function calendarBlock(calendar) {
  return `CALENDAR TODAY: ${calendar && calendar.connected ? '\n' + (calendar.today || '(no events today)') : 'not connected'}`;
}

export const enabledSeats = cfg => mergeConfig(cfg).board.filter(s => s.enabled);

// ── One board seat ─────────────────────────────────────────────────────────
// Each enabled seat answers the huddle's three questions in its own lane.
export function buildSeatPrompt(seat, cfg, tasks, calendar, todayISO) {
  const c = mergeConfig(cfg);
  const founderFirst = firstName(c.founder.name);
  const seats = enabledSeats(c).map(s => `${s.seat} (${surname(s.head)})`).join(', ');
  const system = `You are the head of ${seat.seat} on ${c.founder.business}'s AI board, speaking in the voice of ${seat.head}.
Your lane: ${seat.lane}
You may: ${seat.vetoes}
You may NOT advise on: ${seat.not}
The other seats at the table: ${seats}. Stay in your lane. If it belongs to another seat, say nothing about it.
${founderBlock(c)}
Write for a 13-year-old reader. Plain UK English. No em dashes. At most two short lines per answer.
Answer ONLY with JSON: {"completed":"what your department finished since yesterday, or none","today":"what your department moves today","blocking":"what is blocking you, or none","flag":"ONE line for the founder only if your lane genuinely triggers today, else an empty string"}`;
  const user = `TODAY: ${todayISO}

QUARTER CONTEXT (the only authority on targets):
${c.quarter.context}${c.quarter.ends ? `\nQuarter ends ${c.quarter.ends}.` : ''}

${calendarBlock(calendar)}

${tasksBlock(tasks, founderFirst)}

Give your three answers and your flag.`;
  return { system, user };
}

export function parseJsonReply(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export function shapeSeatAnswer(seat, raw) {
  const clip = v => String(v || '').trim().slice(0, 400);
  return {
    seat: seat.seat, head: seat.head,
    completed: clip(raw && raw.completed) || 'none',
    today: clip(raw && raw.today) || 'none',
    blocking: clip(raw && raw.blocking) || 'none',
    flag: clip(raw && raw.flag),
  };
}

// ── The CEO ────────────────────────────────────────────────────────────────
export function buildCeoPrompt(cfg, tasks, calendar, money, huddle, todayISO, dateLabel) {
  const c = mergeConfig(cfg);
  const founderFirst = firstName(c.founder.name);
  const workers = c.workers.filter(w => w.enabled);
  const team = c.team || [];
  const seats = enabledSeats(c);
  const seatList = seats.map(s => `${surname(s.head)} (${s.seat}: ${s.lane.split('.')[0].toLowerCase()})`).join('; ');

  const destinations = [];
  if (workers.length) destinations.push(`1. AI first: a named agent. Real agents that exist today: ${workers.map(w => `${w.id} (${w.does})`).join(', ')}. Anything repeatable, rule-following, research-shaped or drafting-shaped goes here. Name the agent; never say "AI" or "an agent" vaguely.`);
  team.forEach((p, i) => destinations.push(`${destinations.length + 1}. ${p.name} (${p.role || 'team'})${p.may_be_handed && p.may_be_handed.length ? `: may be handed ${p.may_be_handed.join(', ')}` : ''}.`));
  destinations.push(`${destinations.length + 1}. ${founderFirst}, and ONLY for: ${FOUNDER_ONLY.join(', ')}${c.founder.wheelhouse.length ? `, plus the founder's own wheelhouse (${c.founder.wheelhouse.join('; ')})` : ''}.`);

  const huddleBlock = huddle && huddle.seats && huddle.seats.length ? `
BOARD HUDDLE, HELD THIS MORNING. Each seat answered: what it completed, what it moves today, what blocks it, and a flag if its lane triggered. Lead with their conclusion; you synthesise, you do not re-decide the day from scratch.
${huddle.seats.map(s => `${surname(s.head)} (${s.seat}): completed: ${s.completed} | today: ${s.today} | blocking: ${s.blocking}${s.flag ? ` | FLAG: ${s.flag}` : ''}`).join('\n')}
${huddle.errors && huddle.errors.length ? `Seats that did not answer today: ${huddle.errors.map(e => e.seat).join(', ')}.` : ''}
Keep at most two of their flags: the two that change what ${founderFirst} does today.` : `
No board huddle ran today, so decide the day yourself from the data below.`;

  const tone = c.founder.tone === 'supportive'
    ? 'When the numbers look bad, be supportive and give options.'
    : 'When the numbers look bad, say so straight. No softening.';

  const system = `You are ${c.founder.name}'s AI CEO, the right hand running the day for ${c.founder.business} so the founder does not have to.
Voice: ${c.ceo.voice || 'Dan Martell'} as the lead voice, with a ONE-thing discipline. Direct, warm, spartan, UK English.
${founderBlock(c)}
HARD RULES:
- Write for a 13-year-old reader. No jargon, no acronyms without explanation, no em dashes.
- Give ONE thing, with a tiny FIRST STEP of about 10 minutes, so starting is easy. Never a list.
- ${tone}
- DELEGATION, and AI COMES FIRST. Before you hand anything to a person, ask whether AI can do it. Destinations, in this order:
${destinations.map(d => '  ' + d).join('\n')}
- A job only reaches ${founderFirst} if it needs the founder. If it does not, hand it off and say where it went. Never quietly drop a job: anything you take off the founder appears in handed_off, written as "destination: the job in plain words".
- THE APPROVAL QUEUE COMES FIRST. The WAITING ON ${founderFirst.toUpperCase()}'S TICK block lists work an agent has ALREADY FINISHED, with the words already written. It needs one tap, not ten minutes of writing. So: never make the first step "write", "draft" or "spend N minutes on" anything in that block; say "approve" and name it. Never put a job in handed_off that dispatches an agent to redo something already sitting there. If that block is not empty, clearing it is a strong candidate for today's one thing, because until the founder taps, nothing was actually sent.
- Triage: genuine urgency first (a real deadline WITH a real consequence); otherwise project work that advances the QUARTER goals; everything else is ignored, batched or delegated. A marketing email or newsletter with a scary subject line is content, not a commitment.
- Max TWO board flags, one line each, only when a lane genuinely triggers. The board seats are: ${seatList}. A flag is written "Surname: one line" and must come from one of these seats and no other. Keep the huddle's flags when they already name one.
- The money traffic light, when provided, is respected. Red or amber changes what today's one thing can be. When it is not connected, say nothing about money.
${c.ceo.extra_rules && c.ceo.extra_rules.length ? c.ceo.extra_rules.map(r => `- ${r}`).join('\n') + '\n' : ''}${c.precedents && c.precedents.length ? `- STANDING ANSWERS from the founder (apply them, do not re-ask): ${c.precedents.slice(-10).map(p => `${p.date}: ${p.rule}`).join(' | ')}\n` : ''}- PRECEDENCE, this overrides everything else: the QUARTER CONTEXT block in the user message is the ONLY authority on targets, priorities and the critical path. Never quote a target that is not in it.
- LENGTH, this is a hard limit: at most 4 ignore items, at most 5 handed_off items, at most 2 flags. One short line each. one_thing, first_step, why and headline are one or two sentences each. A long answer gets cut off and the founder sees nothing.
Respond ONLY with JSON: {"one_thing":"...","first_step":"...","why":"...","ignore":["..."],"handed_off":["destination: the job"],"flags":["Surname: ..."],"headline":"one short sentence for the top of the message"}`;

  const user = `TODAY: ${todayISO}${dateLabel ? ` (${dateLabel})` : ''}

MONEY: ${moneyLine(money)}

QUARTER CONTEXT (the goals today must serve):
${c.quarter.context}${c.quarter.ends ? `\nQuarter ends ${c.quarter.ends}.` : ''}

${calendarBlock(calendar)}

${tasksBlock(tasks, founderFirst)}
${huddleBlock}
Write today's brief.`;
  return { system, user };
}

// ── Guards against re-commissioning finished work (parity with the original) ──
export const HANDOFF_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'with', 'from',
  'draft', 'drafting', 'write', 'send', 'email', 'message', 'task', 'lane',
  'worker', 'writer', 'builder', 'researcher', 'analyst', 'auditor', 'agent',
]);
export function distinctiveWords(text) {
  return new Set(String(text || '').toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !HANDOFF_STOPWORDS.has(w)));
}
export function waitingMatch(text, tasks) {
  const waiting = (tasks && tasks.approvalNames) || [];
  if (!waiting.length) return -1;
  const words = distinctiveWords(text);
  for (let i = 0; i < waiting.length; i++) {
    let shared = 0;
    for (const word of distinctiveWords(waiting[i])) if (words.has(word)) shared++;
    if (shared >= 2) return i;
  }
  return -1;
}
export function dropAlreadyWaiting(handedOff, tasks) {
  const waiting = (tasks && tasks.approvalNames) || [];
  if (!waiting.length) return handedOff;
  return handedOff.filter(item => waitingMatch(item, tasks) < 0);
}
export function redirectToWaiting(text, tasks, kind) {
  const i = waitingMatch(text, tasks);
  if (i < 0) return text;
  const names = (tasks && tasks.approvalDisplayNames) || [];
  const name = names[i] || (tasks.approvalNames || [])[i] || 'the waiting task';
  return kind === 'one_thing'
    ? `Clear "${name}" out of the approval queue. The work is done and waiting on your tick.`
    : `Approve "${name}" in the approval queue. It is already drafted, so this is one tap, not a writing job.`;
}
export function dedupeHandedOff(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const key = String(item).toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(String(item).trim());
  }
  return out;
}

// Apply the limits and the guards to a raw CEO reply. Throws when the two
// required fields are missing so the caller can retry once, terse.
export function finaliseBrief(raw, tasks, cfg) {
  const b = { ...(raw || {}) };
  if (!b.one_thing || !b.first_step) throw new Error('CEO JSON missing required fields');
  const seatNames = new Set(enabledSeats(cfg).map(s => surname(s.head).toLowerCase()));
  b.ignore = Array.isArray(b.ignore) ? b.ignore.map(String).slice(0, 4) : [];
  // A flag must come from an ENABLED seat. A disabled seat's name is dropped.
  b.flags = (Array.isArray(b.flags) ? b.flags.map(String) : [])
    .filter(f => seatNames.has(String(f).split(':')[0].trim().toLowerCase()))
    .slice(0, 2);
  b.handed_off = Array.isArray(b.handed_off) ? b.handed_off.map(String).slice(0, 5) : [];
  b.handed_off = dropAlreadyWaiting(dedupeHandedOff(b.handed_off), tasks);
  b.one_thing = redirectToWaiting(String(b.one_thing), tasks, 'one_thing');
  b.first_step = redirectToWaiting(String(b.first_step), tasks, 'first_step');
  b.why = String(b.why || '');
  b.headline = String(b.headline || 'Your day, decided.');
  return b;
}

// ── Delivery payloads ──────────────────────────────────────────────────────
const LIGHT_EMOJI = { green: '🟢', amber: '🟡', red: '🔴' };

export function buildSlackPayload(brief, money, dateLabel, sendHour) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `☀️ ${brief.headline || 'Your day, decided.'}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `*THE ONE THING*\n${brief.one_thing}\n\n*Start here (10 min):* ${brief.first_step}` } },
  ];
  if (brief.why) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Why this wins today:* ${brief.why}` } });
  if (money && money.connected) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${LIGHT_EMOJI[money.light] || ''} *Money: ${String(money.light).toUpperCase()}*${money.safe_to_act === null ? '' : ` · safe to act today ${fmtMoney(money.safe_to_act)}`}` } });
  }
  if (brief.ignore.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Ignore today:* ${brief.ignore.join(' · ')}` } });
  if (brief.handed_off.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Not yours today, handed off:*\n${brief.handed_off.map(h => `• ${h}`).join('\n')}` } });
  for (const f of brief.flags) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `⚑ ${f}` } });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${dateLabel} · ${String(sendHour).padStart(2, '0')}:00 CEO brief · the full history is on your CEO Brief page` }] });
  return { text: `${brief.headline || 'Your day, decided.'} The one thing: ${brief.one_thing}`, blocks };
}

export function briefAsPlainText(brief, money, dateLabel) {
  const lines = [
    `CEO brief for ${dateLabel}`, '',
    brief.headline || '', '',
    `THE ONE THING: ${brief.one_thing}`,
    `Start here (10 min): ${brief.first_step}`,
    brief.why ? `Why this wins today: ${brief.why}` : '',
  ];
  if (money && money.connected) lines.push(`Money: ${String(money.light).toUpperCase()}${money.safe_to_act === null ? '' : `, safe to act today ${fmtMoney(money.safe_to_act)}`}`);
  if (brief.ignore.length) lines.push('', 'Ignore today:', ...brief.ignore.map(i => `- ${i}`));
  if (brief.handed_off.length) lines.push('', 'Handed off:', ...brief.handed_off.map(h => `- ${h}`));
  if (brief.flags.length) lines.push('', 'Board flags:', ...brief.flags.map(f => `- ${f}`));
  return lines.filter(l => l !== null && l !== undefined).join('\n');
}

// The row written to ceo_briefs.
export function briefRow(orgId, briefDate, brief, money, huddle, sourceStats, fallback = false) {
  return {
    org_id: orgId,
    brief_date: briefDate,
    one_thing: brief.one_thing || '',
    first_step: brief.first_step || '',
    why: brief.why || '',
    ignore_today: (brief.ignore || []).join('\n'),
    board_flags: (brief.flags || []).join('\n'),
    handed_off: (brief.handed_off || []).join('\n'),
    money_light: money && money.connected ? money.light : null,
    safe_to_act: money && money.connected ? money.safe_to_act : null,
    full_brief: brief,
    huddle: huddle || { seats: [], errors: [] },
    fallback: Boolean(fallback),
    source_stats: sourceStats || {},
    updated_at: new Date().toISOString(),
  };
}
