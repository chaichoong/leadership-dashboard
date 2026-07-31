// approvals.js — the AI agent approval loop, Slack side.
// =====================================================================
//
// Runs inside the contractor-bot Worker (see contractor-bot.js `scheduled`).
// It lives in the same Worker on purpose: that Worker already holds
// SLACK_BOT_TOKEN and AIRTABLE_PAT as secrets, so the loop shipped without
// asking Kevin to paste a credential into a new deployable.
//
// THE LOOP — the gate sits BEFORE the action, never after it.
//   1. An agent PREPARES work and proposes it. It sends, files and executes
//      NOTHING. It sets Status = Approval and records itself in
//      "Sent For Approval By".
//   2. This sweep posts that task to the approvals channel.
//   3. Kevin reacts: ✅ approve · ✏️ changes · ❌ reject.
//   4. Approve hands the task BACK to the agent, due today, so the agent can
//      carry the approved action out and only THEN mark it Completed.
//      Approving is not completing. Kevin never marks anything Completed.
//   5. Reject closes it with a reason and counts against that agent.
//
// THE STALENESS GUARD (mandatory — do not remove).
// A reaction approves whatever the message said when it was POSTED. If the
// task changed after that, the emoji would approve something Kevin never
// read. So every post stamps "Approval Slack Baseline" with the moment it
// went out, and a reaction on a task whose LMT has moved past that baseline
// is REJECTED: the sweep says so in thread and re-posts the task fresh.
//
// STATE — held entirely in Airtable, no KV, so nothing can drift:
//   "Approval Slack TS" set          → a live message is awaiting a reaction
//   TS set + Status is not Approval  → decided elsewhere; close the thread
//                                      and clear the TS (which is what stops
//                                      this from firing twice)

const SLACK = {
    post:     'https://slack.com/api/chat.postMessage',
    history:  'https://slack.com/api/conversations.history',
    list:     'https://slack.com/api/conversations.list',
    create:   'https://slack.com/api/conversations.create',
    join:     'https://slack.com/api/conversations.join',
    invite:   'https://slack.com/api/conversations.invite',
    authTest: 'https://slack.com/api/auth.test',
};

const AIRTABLE_BASE = 'appnqjDpqDniH3IRl';
const TABLE_TASKS   = 'tblqB8b22hKBL4PF1';

// Kevin's Slack user ID. Only HIS reactions count — anyone else adding a tick
// must not be able to release agent work.
const KEVIN_SLACK_ID = 'U08HW8F1MA8';
const KEVIN_AIRTABLE_EMAIL = 'kevin@runpreneur.org.uk';

const DEFAULT_CHANNEL_NAME = 'agent-approvals';

const AF = {
    name:            'fldgFjGBw6bTKJFCD',
    description:     'fldRGhBQViKZKtkQ6',
    status:          'fldx4qCw17UfrKpaN',
    assignee:        'fldELMncVJYPDRJNc',
    dueDate:         'fld7XP8w8kbxfETV4',
    completion:      'fldFOi1SwEKuJRmdN',
    lmt:             'flddJA23cJRX5cs1K', // lastModifiedTime — watches every field
    teamMember:      'flduCtmQGpOA4eWaj',
    sentForApprovalBy:'fld30Yw8SWYVp049g',
    approvalOutcome: 'fldrHBSr6qoUfaKuZ',
    approvedBy:      'fldNntfwSzU5DlYS4',
    approvedAt:      'fldr4Mvf2RzKvhZhi',
    taskType:        'fldZ2moDV2041Sobc',
    slackTs:         'fldHTaX3wP9VhD5Oz',
    slackBaseline:   'fldxsqj9JSRBGNyT9',
};

// Emoji names are workspace-specific: this workspace's picker calls ✅
// "white_tick" while the API reports "white_check_mark" (verified live,
// 31 Jul 2026). Both are mapped, along with the obvious near-misses, so a
// reaction can never be silently ignored because Kevin picked the sibling
// emoji. Verify any addition against a real reaction via /approvals/diag.
const REACTION_OUTCOMES = {
    white_check_mark: 'Approved as-is',
    white_tick:       'Approved as-is',
    heavy_check_mark: 'Approved as-is',
    heavy_tick:       'Approved as-is',
    ballot_box_with_check: 'Approved as-is',
    pencil2:          'Changes requested',
    pencil:           'Changes requested',
    memo:             'Changes requested',
    x:                'Rejected',
    negative_squared_cross_mark: 'Rejected',
    heavy_multiplication_x: 'Rejected',
};

// The task's LMT is bumped by our own "Approval Slack TS" write, which lands a
// beat after the message goes out, so the baseline needs a little room. Any
// real edit after that window is caught.
const BASELINE_GRACE_MS = 60 * 1000;

// Work caps per run, so one bad day cannot turn into a Slack flood.
const MAX_POSTS_PER_RUN = 10;
const MAX_REACTION_CHECKS_PER_RUN = 25;

// Tier 1 of the delegation rules: Kevin ONLY, never an agent, whatever an
// accuracy score says. If one of these reaches the approval queue from an
// agent, the post says so loudly rather than reading like ordinary work.
const KEVIN_ONLY_PATTERNS = [
    /restraint order/i,
    /operation lily/i,
    /criminal investigation/i,
    /social housing holdings/i,
    /ach investments/i,
    /liquidat/i,
];

// ─── SMALL HELPERS ────────────────────────────────────────────────────

function selName(v) {
    if (!v) return '';
    return typeof v === 'string' ? v : (v.name || '');
}

function linkIds(v) {
    if (!Array.isArray(v)) return [];
    return v.map(x => (x && typeof x === 'object') ? (x.id || '') : String(x || '')).filter(Boolean);
}

// Slack mrkdwn is not HTML: only these three need escaping.
function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isKevinOnlyMatter(text) {
    const hay = String(text || '');
    return KEVIN_ONLY_PATTERNS.some(re => re.test(hay));
}

async function airtable(env, method, path, body) {
    const resp = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) throw new Error(`Airtable ${method} ${path} → ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    return resp.json();
}

async function slack(env, url, init) {
    const resp = await fetch(url, {
        ...init,
        headers: {
            Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
            'Content-Type': 'application/json; charset=utf-8',
            ...((init && init.headers) || {}),
        },
    });
    return resp.json();
}

async function slackGet(env, url) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
    return resp.json();
}

// ─── CHANNEL ──────────────────────────────────────────────────────────

// Find (or create, or join) the dedicated approvals channel. Deliberately NOT
// the 09:00 huddle DM: an approval buried in a digest is an approval missed.
// Falls back to a DM with Kevin so a scope gap can never silence the loop.
async function resolveChannel(env) {
    if (env.APPROVALS_CHANNEL) return { id: env.APPROVALS_CHANNEL, how: 'configured' };
    const name = env.APPROVALS_CHANNEL_NAME || DEFAULT_CHANNEL_NAME;

    let cursor = '';
    for (let page = 0; page < 10; page++) {
        const url = `${SLACK.list}?types=public_channel,private_channel&exclude_archived=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const data = await slackGet(env, url);
        if (!data.ok) break;
        const hit = (data.channels || []).find(c => c.name === name);
        if (hit) {
            if (!hit.is_member) await slack(env, SLACK.join, { method: 'POST', body: JSON.stringify({ channel: hit.id }) });
            return { id: hit.id, how: 'found' };
        }
        cursor = (data.response_metadata && data.response_metadata.next_cursor) || '';
        if (!cursor) break;
    }

    const created = await slack(env, SLACK.create, { method: 'POST', body: JSON.stringify({ name, is_private: false }) });
    if (created.ok && created.channel && created.channel.id) {
        // Best-effort: pull Kevin in, or he never sees the channel.
        await slack(env, SLACK.invite, { method: 'POST', body: JSON.stringify({ channel: created.channel.id, users: KEVIN_SLACK_ID }) });
        return { id: created.channel.id, how: 'created' };
    }

    const dm = await slack(env, 'https://slack.com/api/conversations.open', { method: 'POST', body: JSON.stringify({ users: KEVIN_SLACK_ID }) });
    if (dm.ok && dm.channel && dm.channel.id) {
        return { id: dm.channel.id, how: `dm-fallback (${created.error || 'channel unavailable'})` };
    }
    throw new Error(`No approvals channel: ${created.error || 'unknown'}`);
}

// ─── AIRTABLE READS ───────────────────────────────────────────────────

const TASK_FIELD_LIST = Object.values(AF).map(f => `fields%5B%5D=${f}`).join('&');

async function queryTasks(env, formula, max) {
    const params = `returnFieldsByFieldId=true&pageSize=${Math.min(max || 50, 100)}&${TASK_FIELD_LIST}&filterByFormula=${encodeURIComponent(formula)}`;
    const data = await airtable(env, 'GET', `/${TABLE_TASKS}?${params}`);
    return (data.records || []).slice(0, max || 50);
}

function taskView(rec) {
    const f = rec.fields || {};
    return {
        id: rec.id,
        name: f[AF.name] || '(Untitled)',
        description: f[AF.description] || '',
        status: selName(f[AF.status]),
        taskType: selName(f[AF.taskType]),
        lmt: f[AF.lmt] || '',
        ts: f[AF.slackTs] || '',
        baseline: f[AF.slackBaseline] || '',
        outcome: selName(f[AF.approvalOutcome]),
        agentId: linkIds(f[AF.sentForApprovalBy])[0] || linkIds(f[AF.teamMember])[0] || '',
    };
}

const _agentNameCache = {};
async function agentName(env, id) {
    if (!id) return '';
    if (_agentNameCache[id]) return _agentNameCache[id];
    try {
        const rec = await airtable(env, 'GET', `/tblco0p2OnlLQVAX7/${id}`);
        const nm = (rec.fields && rec.fields['Name']) || id;
        _agentNameCache[id] = nm;
        return nm;
    } catch (e) { return id; }
}

// ─── POST PHASE ───────────────────────────────────────────────────────

function buildApprovalBlocks(t, agent, warn) {
    const desc = String(t.description || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    const lines = [
        `*${esc(t.name)}*`,
        agent ? `Prepared by *${esc(agent)}*${t.taskType ? ` · ${esc(t.taskType)}` : ''}` : 'No agent recorded on this task.',
        desc ? `\n${esc(desc)}${t.description.length > 600 ? '…' : ''}` : '',
        warn ? `\n:rotating_light: *This looks like a Kevin-only matter.* An agent should not be preparing this. Check before you approve.` : '',
        `\nNothing has been sent, filed or actioned. Approving hands it back so the agent can carry it out.`,
        `:white_check_mark: approve · :pencil2: request changes · :x: reject`,
    ].filter(Boolean);
    return [
        { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
        {
            type: 'context',
            elements: [{
                type: 'mrkdwn',
                text: `Task \`${esc(t.id)}\` · as it stood ${esc(new Date().toISOString().replace('T', ' ').slice(0, 16))} UTC. If it changes after this, your reaction is rejected and it is posted again.`,
            }],
        },
    ];
}

async function postPending(env, channel, log) {
    const recs = await queryTasks(env, `AND({Status}='Approval', LEN({Approval Slack TS}&'')=0)`, MAX_POSTS_PER_RUN);
    for (const rec of recs) {
        const t = taskView(rec);
        const agent = await agentName(env, t.agentId);
        const warn = isKevinOnlyMatter(`${t.name} ${t.description}`);
        const res = await slack(env, SLACK.post, {
            method: 'POST',
            body: JSON.stringify({
                channel,
                text: `Approval needed: ${t.name}`,
                blocks: buildApprovalBlocks(t, agent, warn),
            }),
        });
        if (!res.ok) { log.push(`post failed ${t.id}: ${res.error}`); continue; }
        // One write, not two. The baseline is stamped in the SAME patch as the
        // timestamp, so this write is the last thing to touch LMT before Kevin
        // reads the message — a second write would push LMT past its own
        // baseline and make every task look stale immediately.
        await airtable(env, 'PATCH', `/${TABLE_TASKS}/${rec.id}`, {
            fields: { [AF.slackTs]: res.ts, [AF.slackBaseline]: new Date().toISOString() },
            typecast: true,
        });
        log.push(`posted ${t.id}`);
    }
    return recs.length;
}

// ─── REACTION PHASE ───────────────────────────────────────────────────

// Pull the one message back so we can read its reactions. Reactions ride along
// in conversations.history, which is why this needs no Events API subscription
// and no new Slack app scopes.
async function fetchMessage(env, channel, ts) {
    const url = `${SLACK.history}?channel=${encodeURIComponent(channel)}&latest=${encodeURIComponent(ts)}&oldest=${encodeURIComponent(ts)}&inclusive=true&limit=1`;
    const data = await slackGet(env, url);
    if (!data.ok) return null;
    return (data.messages || [])[0] || null;
}

function kevinsReaction(msg) {
    const reactions = (msg && msg.reactions) || [];
    for (const r of reactions) {
        const outcome = REACTION_OUTCOMES[r.name];
        if (!outcome) continue;
        if ((r.users || []).indexOf(KEVIN_SLACK_ID) !== -1) return { outcome, emoji: r.name };
    }
    return null;
}

// True when the task changed after the Slack message went out — i.e. the
// message Kevin reacted to is not the task as it now stands.
function isStale(t) {
    if (!t.baseline || !t.lmt) return false;
    return new Date(t.lmt).getTime() > new Date(t.baseline).getTime() + BASELINE_GRACE_MS;
}

async function threadReply(env, channel, ts, text) {
    return slack(env, SLACK.post, { method: 'POST', body: JSON.stringify({ channel, thread_ts: ts, text }) });
}

// Apply Kevin's verdict. Same semantics as the task drawer: approve hands the
// task BACK to the agent (due today) to carry the action out; reject closes it.
// Nothing here ever marks approved work Completed — that is the agent's job,
// after it has actually done the thing.
async function applyDecision(env, t, outcome, decidedVia) {
    const now = new Date().toISOString();
    const fields = {
        [AF.approvalOutcome]: outcome,
        [AF.approvedAt]: now,
        [AF.approvedBy]: { email: KEVIN_AIRTABLE_EMAIL },
        [AF.slackTs]: '',
        [AF.slackBaseline]: '',
    };
    if (outcome === 'Rejected') {
        fields[AF.status] = 'Completed';
        fields[AF.completion] = now;
    } else {
        fields[AF.status] = 'Today';
        fields[AF.dueDate] = now.slice(0, 10);
    }
    if (t.agentId) {
        fields[AF.teamMember] = [t.agentId];
        fields[AF.sentForApprovalBy] = [t.agentId];
        fields[AF.assignee] = null; // the agent owns it now; Assignee cannot hold one
    }
    await airtable(env, 'PATCH', `/${TABLE_TASKS}/${t.id}`, { fields, typecast: true });
    const agent = await agentName(env, t.agentId);
    const line = outcome === 'Rejected'
        ? `Rejected by Kevin ${decidedVia}. Closed, and counted against ${agent || 'the agent'}.`
        : outcome === 'Changes requested'
            ? `Changes requested by Kevin ${decidedVia}. Back to ${agent || 'the agent'}. Nothing has gone out.`
            : `${outcome} by Kevin ${decidedVia}. Back to ${agent || 'the agent'} to carry out, then it completes itself.`;
    try { await airtable(env, 'POST', `/${TABLE_TASKS}/${t.id}/comments`, { text: line }); } catch (e) { /* comment is a nicety, not the record */ }
    return line;
}

async function processReactions(env, channel, log) {
    const recs = await queryTasks(env, `AND({Status}='Approval', LEN({Approval Slack TS}&'')>0)`, MAX_REACTION_CHECKS_PER_RUN);
    for (const rec of recs) {
        const t = taskView(rec);
        const msg = await fetchMessage(env, channel, t.ts);
        if (!msg) { log.push(`no message for ${t.id}`); continue; }
        const reaction = kevinsReaction(msg);
        if (!reaction) continue;

        // THE STALENESS GUARD. Without this an emoji approves a task that has
        // changed since Kevin read it.
        if (isStale(t)) {
            await threadReply(env, channel, t.ts,
                `:warning: Not applying that. This task changed after I posted it, so your ${reaction.emoji === 'x' ? 'rejection' : 'reaction'} would be approving something you have not read. ` +
                `Posted with the task as at ${t.baseline.replace('T', ' ').slice(0, 16)} UTC, last changed ${String(t.lmt).replace('T', ' ').slice(0, 16)} UTC. I am posting it again as it now stands.`);
            // Clearing the timestamp is what makes the post phase pick it up
            // again on the next sweep, with a fresh baseline.
            await airtable(env, 'PATCH', `/${TABLE_TASKS}/${t.id}`, {
                fields: { [AF.slackTs]: '', [AF.slackBaseline]: '' }, typecast: true,
            });
            log.push(`STALE ${t.id} — reaction rejected, re-queued`);
            continue;
        }

        const line = await applyDecision(env, t, reaction.outcome, 'in Slack');
        await threadReply(env, channel, t.ts, `:heavy_check_mark: ${line}`);
        log.push(`applied ${reaction.outcome} to ${t.id}`);
    }
    return recs.length;
}

// ─── RECONCILE PHASE ──────────────────────────────────────────────────

// Kevin decided in the dashboard while a Slack message was still live. Close
// the thread so the channel never shows a stale "waiting" post, and clear the
// timestamp — which is also what stops this running twice on the same task.
async function reconcileDecidedElsewhere(env, channel, log) {
    const recs = await queryTasks(env, `AND({Status}!='Approval', LEN({Approval Slack TS}&'')>0)`, 25);
    for (const rec of recs) {
        const t = taskView(rec);
        await threadReply(env, channel, t.ts,
            t.outcome ? `:heavy_check_mark: Decided in the dashboard: *${t.outcome}*.`
                      : `:information_source: This task left the approval queue in the dashboard.`);
        await airtable(env, 'PATCH', `/${TABLE_TASKS}/${t.id}`, {
            fields: { [AF.slackTs]: '', [AF.slackBaseline]: '' }, typecast: true,
        });
        log.push(`closed thread for ${t.id}`);
    }
    return recs.length;
}

// ─── ENTRY ────────────────────────────────────────────────────────────

export async function runApprovalSweep(env) {
    const log = [];
    if (!env.SLACK_BOT_TOKEN || !env.AIRTABLE_PAT) {
        return { ok: false, error: 'missing SLACK_BOT_TOKEN or AIRTABLE_PAT', log };
    }
    const ch = await resolveChannel(env);
    log.push(`channel ${ch.id} (${ch.how})`);
    const posted = await postPending(env, ch.id, log);
    const checked = await processReactions(env, ch.id, log);
    const closed = await reconcileDecidedElsewhere(env, ch.id, log);
    return { ok: true, channel: ch.id, posted, checked, closed, log };
}

// Read-only diagnostics for wiring this up: which bot, which scopes, which
// channel. Never returns a token.
export async function approvalsDiag(env) {
    // Slack returns the token's granted scopes in a response header. That is
    // the only honest way to know what this loop can actually do — guessing at
    // scopes is how a silent missing_scope turns into approvals nobody sees.
    const authRes = await fetch(SLACK.authTest, { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
    const scopes = authRes.headers.get('x-oauth-scopes') || '';
    const auth = await authRes.json();
    const probes = {};
    for (const [label, url] of [
        ['public_list', `${SLACK.list}?types=public_channel&limit=1`],
        ['private_list', `${SLACK.list}?types=private_channel&limit=1`],
    ]) {
        try { const r = await slackGet(env, url); probes[label] = r.ok ? 'ok' : r.error; }
        catch (e) { probes[label] = String(e.message || e); }
    }
    if (env.APPROVALS_DIAG_ONLY === 'scopes') return { scopes, probes, botUser: auth.user };

    // What Slack actually calls the reactions sitting on live approval posts.
    // Emoji names are workspace-specific (this workspace calls ✅ "white_tick",
    // not "white_check_mark"), so the map is verified against real reactions
    // rather than assumed.
    let liveReactions = [];
    try {
        const chId = env.APPROVALS_CHANNEL;
        if (chId) {
            const pending = await queryTasks(env, `AND({Status}='Approval', LEN({Approval Slack TS}&'')>0)`, 10);
            for (const rec of pending) {
                const t = taskView(rec);
                const msg = await fetchMessage(env, chId, t.ts);
                liveReactions.push({
                    task: t.id,
                    reactions: ((msg && msg.reactions) || []).map(r => ({ name: r.name, users: r.users, mapped: REACTION_OUTCOMES[r.name] || null })),
                });
            }
        }
    } catch (e) { liveReactions = [{ error: String(e.message || e) }]; }
    let channel = null, channelError = null;
    try { channel = await resolveChannel(env); } catch (e) { channelError = String(e.message || e); }
    return {
        slackOk: !!auth.ok,
        slackError: auth.error || null,
        botUser: auth.user || null,
        team: auth.team || null,
        scopes,
        probes,
        liveReactions,
        channel,
        channelError,
        hasAirtablePat: !!env.AIRTABLE_PAT,
    };
}
