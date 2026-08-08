/**
 * Prospect Reply Watch — near-real-time reply detection for cold outbound.
 *
 * Kevin's ruling, 8 Aug 2026 ("let's do the better"): a prospect's reply must
 * reach him in minutes, not at the next morning's sweep. This worker polls the
 * Operations Director GoHighLevel location every 2 minutes for inbound email
 * replies from contacted prospects. On each new reply it:
 *
 *   1. Flips the prospect's Airtable row to "Replied" (which also stops the
 *      day-7/day-14 automatic follow-ups — a human reply always halts them),
 *   2. DMs Kevin on Slack immediately with the reply text and a link to the
 *      GoHighLevel conversation,
 *   3. Creates a "Draft the reply" task for AI Worker — Writer with Status
 *      "Today", so the dispatch engine (07:30/14:30) drafts an answer onto
 *      the approval loop. Nothing is ever sent without Kevin's tick.
 *
 * IDEMPOTENCY: there is deliberately no KV state. The Prospects table IS the
 * state: only rows at Status "Contacted (1:1)" are watched, and detecting a
 * reply moves the row to "Replied", so the same reply can never be processed
 * twice. If a crash lands between the status flip and the task creation, the
 * daily 09:00 sweep drafts the response instead — the backstop existed first.
 *
 * The 09:00 prospect-daily sweep remains the backstop for everything this
 * cannot see, including warm-20 replies (those were sent from Kevin's Gmail,
 * so they land in Gmail, not GoHighLevel).
 *
 * Secrets: GHL_API_KEY, GHL_LOCATION_ID (dgsH… — the OD sub-account, never
 * Runpreneur), AIRTABLE_PAT, ADMIN_KEY (gates the manual /run trigger).
 * SLACK_NOTIFY_URL is public infrastructure (origin-gated, holds no data).
 */

const AIRTABLE_BASE = 'appnqjDpqDniH3IRl';
const PROSPECTS_TABLE = 'tbljHVGJoKJf8acy3';
const TASKS_TABLE = 'tblqB8b22hKBL4PF1';
const WRITER_AGENT = 'recFMVmHmqAOVPAeJ'; // Team Members: AI Worker — Writer
const KEVIN_SLACK_EMAIL = 'kevin@runpreneur.org.uk';
const SLACK_NOTIFY_URL = 'https://slack-notify.kevinbrittain.workers.dev/';
// slack-notify is origin-allowlisted to the web app's origin; worker-to-worker
// calls must present it explicitly.
const NOTIFY_ORIGIN = 'https://chaichoong.github.io';

// Field IDs mirror js/config.js (PROSPECT + TASK_FIELDS). IDs, not names, so a
// field rename cannot silently break the write path.
const P_STATUS = 'fldNFSZrPsUF1NAd1';
const T = {
  name: 'fldgFjGBw6bTKJFCD',
  status: 'fldx4qCw17UfrKpaN',
  description: 'fldRGhBQViKZKtkQ6',
  dueDate: 'fld7XP8w8kbxfETV4',
  teamMember: 'flduCtmQGpOA4eWaj',
  sentForApprovalBy: 'fld30Yw8SWYVp049g',
  taskType: 'fldZ2moDV2041Sobc',
};

// The GHL conversations endpoint rejects botlike user agents (Cloudflare 1010,
// proven 8 Aug 2026 with curl). Present a browser UA on every GHL call.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(poll(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({ status: 'ok', service: 'prospect-reply-watch', mode: 'cron */2' });
    }
    // Manual trigger for testing and for the daily sweep to force a pass.
    // Fails closed: without the secret configured the endpoint does not exist.
    if (url.pathname === '/run' && request.method === 'POST') {
      if (!env.ADMIN_KEY) return json({ error: 'Not configured' }, 503);
      if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) {
        return json({ error: 'Forbidden' }, 403);
      }
      return json(await poll(env));
    }
    return json({ error: 'Not found' }, 404);
  },
};

/* ------------------------------------------------------------------ */
/*  Core poll                                                          */
/* ------------------------------------------------------------------ */

export async function poll(env) {
  const result = { watched: 0, replies: 0, notified: 0, tasksCreated: 0, control: null, errors: [] };

  // 1. Who are we watching? Only prospects Kevin has contacted.
  const watched = await airtableList(
    env,
    `filterByFormula=${encodeURIComponent(`{Status}='Contacted (1:1)'`)}`
  );
  result.watched = watched.length;

  // CONTROL — a broken formula and "nobody contacted yet" both return zero
  // rows and are otherwise indistinguishable (the silent-zero trap in
  // CLAUDE.md). The review queue is never empty while the pipeline is alive,
  // so if BOTH populations read zero the query itself is broken: say so
  // loudly instead of reporting a clean empty run.
  if (watched.length === 0) {
    const queue = await airtableList(
      env,
      `filterByFormula=${encodeURIComponent(`{Status}='Ready for Review'`)}&maxRecords=1`
    );
    result.control = queue.length > 0 ? 'ok-nothing-contacted-yet' : 'FAIL-both-populations-zero';
    if (result.control !== 'ok-nothing-contacted-yet') {
      result.errors.push('Control failed: Contacted AND Ready for Review both read zero — check the Status field/formula');
    }
    return result;
  }
  result.control = 'ok';

  // 2. Recent GHL conversations, newest first.
  const conversations = await ghlConversations(env);

  // 3. Match inbound email replies to watched prospects.
  const replies = matchReplies(conversations, watched);
  result.replies = replies.length;

  // 4. Process each exactly once: status flip first (the idempotency gate),
  //    then the DM, then the draft task. Later failures are caught by the
  //    09:00 sweep, which drafts responses for anything sitting at Replied.
  for (const r of replies) {
    try {
      await airtablePatch(env, PROSPECTS_TABLE, r.prospect.id, { [P_STATUS]: 'Replied' });
      const dm = await notifyKevin(env, r);
      if (dm) result.notified++;
      await createDraftTask(env, r);
      result.tasksCreated++;
    } catch (e) {
      result.errors.push(`${r.prospect.email}: ${e.message}`);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Pure logic (unit-tested in tests/prospect-reply-watch.test.js)     */
/* ------------------------------------------------------------------ */

// A conversation counts as a new reply when its latest message came IN, by
// email, from an address we are actively watching. Everything else — outbound
// mail, SMS, tenants, unknown senders, prospects not yet contacted — is noise.
export function matchReplies(conversations, watchedProspects) {
  const byEmail = new Map();
  for (const p of watchedProspects) {
    const email = String(p.fields['Contact Email'] || '').trim().toLowerCase();
    if (email) byEmail.set(email, p);
  }
  const out = [];
  const seen = new Set();
  for (const c of conversations || []) {
    const direction = String(c.lastMessageDirection || '').toLowerCase();
    const type = String(c.lastMessageType || '');
    const email = String(c.email || '').trim().toLowerCase();
    if (direction !== 'inbound') continue;
    if (!type.includes('EMAIL')) continue;
    const prospect = byEmail.get(email);
    if (!prospect || seen.has(email)) continue;
    seen.add(email);
    out.push({
      prospect: {
        id: prospect.id,
        email,
        name: prospect.fields['Name'] || 'Unknown prospect',
        company: prospect.fields['Company'] || '',
        pain: prospect.fields['Pain Signal'] || '',
        opener: prospect.fields['Draft Message'] || '',
        subject: prospect.fields['Email Subject'] || '',
      },
      conversationId: c.id,
      replyPreview: String(c.lastMessageBody || '').slice(0, 600),
      locationId: c.locationId,
    });
  }
  return out;
}

export function draftTaskFields(r, todayIso) {
  const co = r.prospect.company ? ` (${r.prospect.company})` : '';
  return {
    [T.name]: `Draft the reply to ${r.prospect.name}${co}`,
    [T.status]: 'Today',
    [T.dueDate]: todayIso,
    [T.teamMember]: [WRITER_AGENT],
    [T.sentForApprovalBy]: [WRITER_AGENT],
    [T.taskType]: 'Prospect Reply',
    [T.description]: [
      `A contacted prospect REPLIED. Draft Kevin's answer and submit it for his approval (agent-dispatch.py submit --type "Prospect Reply").`,
      ``,
      `Prospect: ${r.prospect.name}${co} <${r.prospect.email}>`,
      `Their pain signal: ${r.prospect.pain}`,
      `What we sent them (subject "${r.prospect.subject}"):`,
      r.prospect.opener,
      ``,
      `THEIR REPLY:`,
      r.replyPreview,
      ``,
      `Rules for the draft: Kevin's voice (direct, spartan, UK English, no em dashes), answer their actual question in the first line, never the full sale in a message — answer, then bridge to the call (${'https://operationsdirector.co.uk/book-a-demo/'}). Under 120 words.`,
      ``,
      `SEND METHOD after approval — this is NOT a Gmail send: POST the approved text to the GoHighLevel conversations API (conversation ${r.conversationId}, type Email, emailFrom kevin@operationsdirector.co.uk, browser User-Agent header required — default curl UA gets Cloudflare 403). The whole prospect conversation lives in GHL, never Kevin's Gmail. Then log the reply on the funnel scorecard.`,
    ].join('\n'),
  };
}

/* ------------------------------------------------------------------ */
/*  IO helpers                                                         */
/* ------------------------------------------------------------------ */

async function ghlConversations(env) {
  const url =
    `https://services.leadconnectorhq.com/conversations/search` +
    `?locationId=${env.GHL_LOCATION_ID}&limit=60&sort=desc&sortBy=last_message_date`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GHL_API_KEY}`,
      Version: '2021-04-15',
      'User-Agent': UA,
    },
  });
  if (!r.ok) throw new Error(`GHL conversations HTTP ${r.status}`);
  const data = await r.json();
  return data.conversations || [];
}

async function airtableList(env, query) {
  let all = [];
  let offset = '';
  do {
    const r = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${PROSPECTS_TABLE}?${query}${offset ? `&offset=${offset}` : ''}`,
      { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } }
    );
    if (!r.ok) throw new Error(`Airtable list HTTP ${r.status}`);
    const data = await r.json();
    all = all.concat(data.records || []);
    offset = data.offset || '';
  } while (offset);
  return all;
}

async function airtablePatch(env, table, recordId, fields) {
  const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}/${recordId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!r.ok) throw new Error(`Airtable patch HTTP ${r.status}`);
  return r.json();
}

async function createDraftTask(env, r) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const resp = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${TASKS_TABLE}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: draftTaskFields(r, todayIso), typecast: true }),
  });
  if (!resp.ok) throw new Error(`Airtable task create HTTP ${resp.status}`);
  return resp.json();
}

async function notifyKevin(env, r) {
  const ghlLink = `https://app.gohighlevel.com/v2/location/${env.GHL_LOCATION_ID}/conversations/conversations/${r.conversationId}`;
  const co = r.prospect.company ? ` (${r.prospect.company})` : '';
  try {
    const resp = await fetch(SLACK_NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: NOTIFY_ORIGIN },
      body: JSON.stringify({
        recipientEmail: KEVIN_SLACK_EMAIL,
        taskName: `Prospect replied: ${r.prospect.name}${co}`,
        taskId: r.prospect.id,
        actorName: 'Prospect reply watch',
        action: 'comment',
        commentText:
          `"${r.replyPreview.slice(0, 400)}"\n\n` +
          `A drafted answer is on its way to the approval loop. ` +
          `To answer immediately yourself, open the conversation: ${ghlLink}`,
      }),
    });
    return resp.ok;
  } catch {
    // The DM is a courtesy, not the system of record — the status flip and the
    // draft task carry the actual work, so a Slack failure must not abort them.
    return false;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
