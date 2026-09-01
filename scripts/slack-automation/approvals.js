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
//   2. KEVIN'S LANE (1 Sep 2026, his ruling): NO per-task Slack cards. 20+
//      cards a day buried the phone and he stopped reading them. Instead ONE
//      digest DM at 08:00 London — the count, the top few names, and a link
//      to the dashboard approval queue, where every decision now happens
//      (approve / reject / reject-and-remember / amend / knock back all live
//      there already). Zero pending means no message at all.
//   3. MICA'S LANE is unchanged: her label-8 cards still go to her bot DM as
//      full cards, and her emoji verdicts are still read back by this sweep.
//      The card-posting, reaction and staleness machinery below is HERS now
//      (plus any of Kevin's cards still live from before the switch — those
//      keep working until decided, they are just never posted again).
//   4. Approve hands the task BACK to the agent, due today, so the agent can
//      carry the approved action out and only THEN mark it Completed.
//      Approving is not completing. Kevin never marks anything Completed.
//   5. Reject closes it with a reason and counts against that agent.
//
// THE STALENESS GUARD (mandatory — do not remove).
// A reaction approves whatever the message said when it was POSTED. If the
// task changed after that, the emoji would approve something Kevin never
// read. So every post stamps "Approval Slack Baseline" with the moment it
// went out, and an approve or reject on a task whose LMT has moved past that
// baseline is REFUSED: the sweep says so in thread and re-posts the task fresh.
// An AMENDMENT is deliberately exempt — feedback going back to an agent puts
// nothing out into the world, and refusing Kevin's words would be the wrong
// trade. The agent is told the task moved instead.
//
// STATE — held entirely in Airtable, no KV, so nothing can drift:
//   "Approval Slack TS" set          → a live message is awaiting a reaction
//   TS set + Status is not Approval  → decided elsewhere; close the thread
//                                      and clear the TS (which is what stops
//                                      this from firing twice)

const SLACK = {
    post:     'https://slack.com/api/chat.postMessage',
    update:   'https://slack.com/api/chat.update',
    history:  'https://slack.com/api/conversations.history',
    replies:  'https://slack.com/api/conversations.replies',
    delete:   'https://slack.com/api/chat.delete',
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

// Who can approve agent work (12 Aug 2026). The task's Approver field decides:
// label-8 inbound work goes to Mica, label-12 (and empty) to Kevin, and TIER 1
// ALWAYS diverts to Kevin whatever the field says. Only the routed approver's
// reactions and replies count for that task. Mica's cards go to a bot DM, not
// the approvals channel — the channel carries Kevin's tier-1 legal content and
// she is deliberately not in it.
const APPROVERS = {
    kevin: { key: 'kevin', name: 'Kevin', slackId: KEVIN_SLACK_ID, email: KEVIN_AIRTABLE_EMAIL },
    mica:  { key: 'mica',  name: 'Mica',  slackId: 'U08HW0TAWAE', email: 'micaa.work@gmail.com' },
};

export function approverFor(t, tier1) {
    if (tier1) return APPROVERS.kevin;
    const e = String(t.approverEmail || '').toLowerCase();
    return e === APPROVERS.mica.email ? APPROVERS.mica : APPROVERS.kevin;
}

const DEFAULT_CHANNEL_NAME = 'agent-approvals';

const AF = {
    name:            'fldgFjGBw6bTKJFCD',
    description:     'fldRGhBQViKZKtkQ6',
    notes:           'fldR7apBzSp3oxFxz',
    agentOutput:     'fldzswp8fx6PqpLQ5', // what the agent PRODUCED — the thing Kevin judges
    approvalFeedback:'fldtI7SJI4gEohHD1', // Kevin's words back to the agent
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
    approver:        'fldLLAG5HQPEFEfE5', // singleCollaborator — who approves (see APPROVERS)
    // The learning loop (Kevin's ruling, 26 Aug 2026). "Reject and remember"
    // ticks rememberThis, and scripts/agent-dispatch.py lessons then writes his
    // reason into the agent's own definition file, where it is read on every
    // future run. Feedback History is the durable archive, because
    // approvalFeedback is cleared by the next submit.
    rememberThis:    'fldZurhdHutYIDKVx',
    // Why he decided as he did — see AF.verdictReason in agent-dispatch.py.
    verdictReason:   'fldF9Bs4N5mttQvtl',
    feedbackHistory: 'fldOzsq68lhfprKJu',
    slackTs:         'fldHTaX3wP9VhD5Oz',
    slackBaseline:   'fldxsqj9JSRBGNyT9',
    // Knocked back to a date (28 Aug 2026). Kevin's example: a confirmation
    // statement he cannot file until an authentication code arrives in the
    // post. Approving is wrong, rejecting is wrong, and leaving it posted here
    // for a week is the nag he asked us to stop.
    deferredUntil:   'fldJ9IHS1yxwYzYSN',
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
    // Not advertised on the message any more — replying in the thread is the
    // amendment path. Still mapped, so a pencil out of habit prompts for the
    // detail instead of being silently swallowed.
    pencil2:          'Changes requested',
    pencil:           'Changes requested',
    memo:             'Changes requested',
    x:                'Rejected',
    negative_squared_cross_mark: 'Rejected',
    heavy_multiplication_x: 'Rejected',
    // REJECT AND REMEMBER (Kevin's design, 26 Aug 2026). Same verdict as ❌ —
    // the work is killed and it counts against the agent — but his reason is
    // ALSO stored as a standing lesson in that agent's prompt.
    //
    // A second emoji rather than a cleverer classifier: 47 of the 60 pieces of
    // feedback he had ever given were rejections, some of them genuine rules
    // ("Roy deals with this directly") and some pure one-offs ("already done").
    // Nothing can reliably tell those apart from the text. He can, in the
    // moment, for the price of picking a different emoji.
    brain:            'Rejected',
    bulb:             'Rejected',
    books:            'Rejected',
};

// The subset of the above that also means "remember this". Kept as its own set
// so the outcome map stays a plain emoji → Approval Outcome lookup, and so a
// new reject emoji can never accidentally start storing lessons.
const REMEMBER_REACTIONS = new Set(['brain', 'bulb', 'books']);

// The task's LMT is bumped by our own "Approval Slack TS" write, which lands a
// beat after the message goes out, so the baseline needs a little room. Any
// real edit after that window is caught.
const BASELINE_GRACE_MS = 60 * 1000;

// Work caps per run, so one bad day cannot turn into a Slack flood — and so
// one run stays inside Cloudflare's ~50-subrequest budget. A reaction check
// costs up to 2 Slack reads, a reconcile costs 2 writes, a post costs 2. At 25
// reaction checks the sweep died mid-run on "Too many subrequests" every
// minute once the queue hit 46 (seen live 11 Aug 2026), and the reconcile
// phase — which ran last — never executed: 18 tasks Kevin had decided in the
// dashboard sat showing "waiting" in Slack for over five hours.
const MAX_POSTS_PER_RUN = 10;
const MAX_REACTION_CHECKS_PER_RUN = 12;
const MAX_RECONCILES_PER_RUN = 10;

// Tier 1 of the delegation rules: Kevin's private legal and financial matter.
// Agents PREPARE these and he approves them like anything else (his call,
// 6 Aug 2026) — the guardrail is that nothing is sent, filed, paid or executed
// until he says yes. So the banner's job is no longer "this should not be
// here". It is "know what you are looking at before you tap".
//
// Matched on name + description here, and the dispatch engine ALSO stamps its
// own banner into Agent Output (TIER1_BANNER in scripts/agent-dispatch.py).
// Two labels on purpose: this one cannot see a tier-1 connection an agent only
// discovered while working, and that one cannot fire if the task never reached
// an agent. Keep both.
// MUST stay identical to TIER1_PATTERNS in scripts/agent-dispatch.py — the two
// are independent labels for the same thing (this one stamps the red banner on
// the Slack card, that one stamps it on the Agent Output), and each covers the
// other's blind spot. tests/constant-drift.test.js fails if they diverge.
//
// Widened 7 Aug 2026 alongside the Python list: SKILL.md step 2 enumerates the
// tier-1 categories and six of them matched nothing here either, so enforcement
// notices, settlement offers, disclosure forms and solicitor correspondence
// reached Kevin's phone looking like routine admin.
//
// Bare "financial statement" is deliberately absent: his accountants produce
// company "financial statements" every year and it would put the legal-matter
// banner on routine accounting. The disclosure form is caught by its full name.
const KEVIN_ONLY_PATTERNS = [
    // THE EXPLICIT LABEL COMES FIRST. If a human or an agent has already written
    // "tier 1" on the record, that is the strongest signal there is — yet until
    // 15 Aug 2026 it matched nothing on either side. Descriptions reading
    // literally "TIER 1 MATTER" scored tier1: false, and in that day's recovery
    // run 16 of 16 tier-1 items were caught by an agent's judgement and ZERO by
    // these patterns. A self-declaration the machine ignores is worse than none,
    // because everyone downstream assumes it was honoured.
    //
    // \b after the digit, or "tier 15 pricing model" reads as tier 1. The bias
    // is otherwise deliberately toward matching: a false positive routes
    // something to Kevin with extra caution, a false negative sends a private
    // legal matter to Mica.
    /tier[\s\-_]*1\b/i,
    /tier[\s\-_]*one\b/i,
    /restraint order/i,
    /operation lily/i,
    /criminal investigation/i,
    /social housing holdings/i,
    /ach investments/i,
    /liquidat/i,
    // Enforcement — the vocabulary a bailiff/HCEO notice actually uses.
    /notice of enforcement/i,
    /enforcement agent/i,
    /bailiff/i,
    /writ of control/i,
    /taking control of goods/i,
    // Debt settlement and financial disclosure.
    /standard financial statement/i,
    /income and expenditure/i,
    /settlement offer/i,
    /full and final/i,
    // Creditor correspondence vocabulary (25 Aug 2026) — added with the
    // Creditor Management agent build, in step with agent-dispatch.py:
    // creditor work is always tier-1 by ruling, and these were tier-2-only
    // words that would have reached an approval card unbannered.
    /statutory demand/i,
    /letter of claim/i,
    /bounce ?back loan/i,
    // Legal correspondence, including law-firm senders and invoices.
    /solicitor/i,
    /litigation/i,
];

// The banner the dispatch engine stamps on Agent Output when IT decides a task
// is tier 1. Defined once in scripts/agent_email_format.py (TIER1_BANNER) and
// duplicated here because a Cloudflare Worker cannot import Python — the same
// stranded-copy shape as the money worker's field IDs.
// tests/constant-drift.test.js fails if the two strings diverge.
const TIER1_BANNER =
    ':rotating_light: TIER 1. This touches your private legal and financial '
    + 'matter. An AI agent prepared it. Nothing has been sent, filed, paid or '
    + 'changed anywhere. Read it before you approve.';

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

// Tier 1 as the WHOLE system sees it, not just as the task title spells it.
//
// Until 13 Aug 2026 every routing decision here read `name + description` only,
// which is the one part of a task an agent never writes. So a tier-1 connection
// the agent discovered mid-work — and stamped on Agent Output as TIER1_BANNER —
// was invisible to the router. A label-8 task with Approver = Mica whose agent
// found a solicitor's letter behind it would have been DM'd to her, banner and
// all. Latent when found (6 live Approver = Mica tasks, none tier 1), which is
// exactly the window to close it in.
//
// Three inputs, because each covers the others' blind spot:
//   agentOutput — a connection only the agent could see
//   name + description — a task no agent has touched yet
//   notes — what a human appended after the fact (agent-dispatch already reads
//           notes at scripts/agent-dispatch.py:702-703; this half did not)
export function isTier1Task(t) {
    if (String(t?.agentOutput || '').includes(TIER1_BANNER)) return true;
    return isKevinOnlyMatter(`${t?.name || ''} ${t?.description || ''} ${t?.notes || ''}`);
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

// The conversation each approver's cards live in. Kevin: the pinned approvals
// channel. Mica: a bot DM (im:write/im:history verified live 12 Aug 2026 via
// /approvals/diag). Resolved once per run via `channels` and derived
// DETERMINISTICALLY from the task each time, so the reaction and reconcile
// phases look in the same place the post phase wrote to. If Mica's DM cannot
// be opened, her card goes to Kevin's channel with a loud log line — a
// misrouted approval beats a silent one.
async function resolveChannelFor(env, approver, channels, log) {
    if (channels[approver.key]) return channels[approver.key];
    let id;
    if (approver.key === 'kevin') {
        const ch = await resolveChannel(env);
        log.push(`channel ${ch.id} (${ch.how})`);
        id = ch.id;
    } else {
        const dm = await openDm(env, approver.slackId);
        if (dm) {
            id = dm;
            log.push(`${approver.name} DM ${id}`);
        } else {
            id = await resolveChannelFor(env, APPROVERS.kevin, channels, log);
            log.push(`${approver.name} DM FAILED — routing to Kevin's channel`);
        }
    }
    channels[approver.key] = id;
    return id;
}

// ─── AIRTABLE READS ───────────────────────────────────────────────────

const TASK_FIELD_LIST = Object.values(AF).map(f => `fields%5B%5D=${f}`).join('&');

async function queryTasks(env, formula, max) {
    // Follows the offset token. A single-page read silently caps at 100 and
    // presents the cap as the truth — the exact recon-accuracy-card bug the
    // repo rules warn about — and this file's counts now reach Kevin as his
    // only signal, so they have to be real.
    const cap = max || 50;
    const out = [];
    let offset = '';
    do {
        const params = `returnFieldsByFieldId=true&pageSize=${Math.min(cap - out.length, 100)}&${TASK_FIELD_LIST}&filterByFormula=${encodeURIComponent(formula)}${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`;
        const data = await airtable(env, 'GET', `/${TABLE_TASKS}?${params}`);
        out.push(...(data.records || []));
        offset = data.offset || '';
    } while (offset && out.length < cap);
    return out.slice(0, cap);
}

function taskView(rec) {
    const f = rec.fields || {};
    return {
        id: rec.id,
        name: f[AF.name] || '(Untitled)',
        description: f[AF.description] || '',
        notes: f[AF.notes] || '',
        agentOutput: f[AF.agentOutput] || '',
        dueDate: f[AF.dueDate] || '',
        status: selName(f[AF.status]),
        taskType: selName(f[AF.taskType]),
        lmt: f[AF.lmt] || '',
        ts: f[AF.slackTs] || '',
        baseline: f[AF.slackBaseline] || '',
        outcome: selName(f[AF.approvalOutcome]),
        agentId: linkIds(f[AF.sentForApprovalBy])[0] || linkIds(f[AF.teamMember])[0] || '',
        approverEmail: ((f[AF.approver] || {}).email) || '',
        feedbackHistory: f[AF.feedbackHistory] || '',
        deferredUntil: String(f[AF.deferredUntil] || '').slice(0, 10),
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

// What the agent has PRODUCED lives in the `Agent Output` field, not in record
// comments. This worker's Airtable PAT cannot read comments — it returns 403
// INVALID_PERMISSIONS — so a comment-based design would have posted "no
// write-up" on every task and had Kevin approving work he could not see. A
// field needs no extra token scope and is readable by everything.

// Slack hard-limits a text object to 3000 characters and silently rejects the
// whole message if one goes over, so every block this builds is capped.
function truncate(s, n) {
    const clean = String(s || '').trim();
    return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
}

// Split long text into pieces that each fit one Slack block, breaking on a
// paragraph, then a line, then a word — never mid-sentence unless there is no
// break at all in the whole window.
function chunkText(text, size) {
    const out = [];
    let rest = String(text || '').trim();
    while (rest.length) {
        if (rest.length <= size) { out.push(rest); break; }
        let cut = rest.lastIndexOf('\n\n', size);
        if (cut < size * 0.5) cut = rest.lastIndexOf('\n', size);
        if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
        if (cut < size * 0.5) cut = size;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\s+/, '');
    }
    return out;
}

// Long content arrives WHOLE, spread across as many blocks as it needs. A
// single block caps at 3000 characters but a message allows 50 blocks, so
// splitting — not cutting — is the right response to a long draft. (The
// original 2,400-character cap meant Kevin could not read the bottom of a long
// draft from Slack, and an approval you cannot read to the end is not an
// approval.) maxBlocks keeps one message inside Slack's 50-block ceiling; only
// genuinely enormous content (tens of thousands of characters) overflows, and
// then it says so and points at the task rather than trailing off silently.
function pushLongText(blocks, heading, raw, style, maxBlocks) {
    const text = String(raw || '').replace(/\r/g, '').trim();
    if (!text) return;
    const chunks = chunkText(text, 2600);
    chunks.slice(0, maxBlocks).forEach((chunk, i) => {
        const body = style === 'quote'
            ? '>' + esc(chunk).replace(/\n/g, '\n>')
            : esc(chunk);
        let block = (i === 0 ? `*${heading}*\n` : '') + body;
        if (block.length > 2990) block = block.slice(0, 2989) + '…';
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: block } });
    });
    if (chunks.length > maxBlocks) {
        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `_…too long even for a split message (${text.length} characters). The rest is on the task — use the Open in Airtable link below._`,
            },
        });
    }
}

// ─── POST PHASE ───────────────────────────────────────────────────────

// One-glance summary of what the agent is proposing, derived from Agent
// Output. Mirrors apvSummary in os/tasks/index.html — keep the two in step.
// In order of trust:
//   1. The agent's own closing "carrying this out will involve" line.
//   2. An email draft's TO/SUBJECT header, said as an action.
//   3. The first meaningful line (skipping markdown headings, rules, banners).
// Short outputs (readable in one glance anyway) get no separate summary,
// because repeating the whole text twice helps nobody.
export function apvSummary(raw) {
    const text = String(raw || '').replace(/\r/g, '').trim();
    if (!text || text.length < 280) return '';
    const m = text.match(/\*{0,2}carrying this out will involve:?\*{0,2}\s*/i);
    if (m) {
        const s = text.slice(m.index + m[0].length).trim();
        if (s) return s.length > 400 ? s.slice(0, 399) + '…' : s;
    }
    const to = text.match(/^TO:\s*(.+)$/im);
    const subj = text.match(/^SUBJECT:\s*(.+)$/im);
    if (to && subj) return `Send an email to ${to[1].trim()}. Subject: ${subj[1].trim()}`;
    for (const line of text.split('\n')) {
        const l = line.trim();
        if (!l) continue;
        if (/^#{1,6}\s/.test(l)) continue;            // markdown heading
        if (/^[-*_=]{3,}$/.test(l)) continue;          // horizontal rule
        if (/^(:rotating_light:|🚨)/.test(l) || /^\W*tier 1\b/i.test(l)) continue; // tier-1 banner
        const s = l.replace(/^[*_>#\s]+/, '').replace(/[*_\s]+$/, '');
        if (!s) continue;
        return s.length > 300 ? s.slice(0, 299) + '…' : s;
    }
    return '';
}

// The message has to carry enough for Kevin to judge the work from his phone,
// without opening Airtable. Five parts, in the order he needs them:
//   the ask in one line · the full work · what it is · what he was asked for · how to answer
function buildApprovalBlocks(t, agent, warn) {
    const blocks = [];

    // The SUMMARY of what the agent is proposing leads the message (Kevin's
    // request, 11 Aug 2026, matching the web app's approval box). Putting the
    // full work first was not enough: a long report opens with headings and
    // method notes, so the ask stayed buried below the fold on his phone.
    const summary = apvSummary(t.agentOutput);
    if (summary) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: truncate(`*What the agent wants to do*\n${esc(summary)}`, 2900) },
        });
    }

    // The full work follows. It gets the most room and is NEVER cut — a
    // decision made on half a draft is not a decision. Block budget: 28 + 6 +
    // 2 content blocks plus ~7 fixed ones stays under Slack's 50-block
    // ceiling. Trimmed check, or an output of pure whitespace would skip BOTH
    // branches: no work shown and no warning either, which is the worst of
    // all worlds.
    if (String(t.agentOutput || '').trim()) {
        pushLongText(blocks, summary ? 'The agent’s full work' : 'What the agent wants to do', t.agentOutput, 'quote', 28);
    } else {
        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: '*What the agent wants to do*\n:warning: _The agent left its work empty._ '
                    + 'There is nothing here to judge, so do not approve it blind — '
                    + 'reply in this thread and tell it to show its work.',
            },
        });
    }

    // Tier 1 sits directly under the work, before anything else, so it is
    // read before any decision is made.
    if (warn) {
        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: ':rotating_light: *Tier 1. Your private legal and financial matter* (restraint order, '
                    + 'Operation Lily, the investigation, or a liquidation). An AI agent prepared this. Nothing has '
                    + 'been sent, filed, paid or changed anywhere. Read it properly before you approve, and remember '
                    + 'that approving it means the action then happens.',
            },
        });
    }

    blocks.push({
        type: 'section',
        text: {
            type: 'mrkdwn',
            text: truncate(
                `*${esc(t.name)}*\n`
                + (agent ? `Prepared by *${esc(agent)}*` : '*No agent recorded on this task.*')
                + (t.taskType ? ` · ${esc(t.taskType)}` : '')
                + (t.dueDate ? ` · due ${esc(t.dueDate)}` : ''), 2900),
        },
    });

    // The brief it was working to, so he can tell whether it answered the question.
    pushLongText(blocks, 'The task it was given', t.description, 'plain', 6);
    pushLongText(blocks, 'Notes', t.notes, 'plain', 2);

    blocks.push({ type: 'divider' });

    // How to answer. Amendments are a plain thread reply — no emoji to remember.
    blocks.push({
        type: 'section',
        text: {
            type: 'mrkdwn',
            text: 'Nothing has been sent, filed or actioned yet.\n'
                + ':white_check_mark:  *approve* — the agent goes and does it, then closes the task\n'
                + ':x:  *reject* — kill this piece of work entirely, it should not happen\n'
                // The web queue asks WHY with seven chips. Slack has no chips,
                // so one word at the start of the reply is the equivalent — and
                // it decides whether the agent is scored down for it, exactly
                // as the chip does. Advertised HERE because a shortcut nobody
                // is told about is a shortcut nobody uses.
                + '       _with a reply starting_ `done` `roy` `noise` `dupe` `park` `stale` — '
                + 'the task should not have reached you, and the agent is not marked down\n'
                + '       _or_ `wrong` — the draft itself is bad. That one does count against it\n'
                + ':brain:  *reject and remember* — same as reject, but reply with the reason and '
                + 'the agent keeps it as a standing rule so it stops raising these\n'
                + ':speech_balloon:  *changes* — just reply in this thread with what to change. No emoji needed. '
                + 'It goes back to the agent with your words and nothing goes out',
        },
    });

    blocks.push({
        type: 'context',
        elements: [{
            type: 'mrkdwn',
            text: `<https://airtable.com/${AIRTABLE_BASE}/${TABLE_TASKS}/${esc(t.id)}|Open in Airtable> · `
                + `as it stood ${esc(new Date().toISOString().replace('T', ' ').slice(0, 16))} UTC. `
                + `If it changes after this, an approve or reject is refused and it is posted again.`,
        }],
    });

    return blocks;
}

// The date clause is what makes a knock-back come back on its own. Nothing
// schedules the return: this query simply stops matching while the date is in
// the future, and starts matching again the morning it is not — at which point
// the task has no Slack timestamp (the dashboard cleared it, and the reconcile
// phase below clears it for anything deferred after it was posted), so a fresh
// card goes out as if it had just arrived. A job that has to remember to
// un-park something is a job that can forget; this one has nothing to
// remember. Mirrors APV_QUEUE_FORMULA in os/agents/index.html.
const NOT_DEFERRED = `NOT(IS_AFTER({Deferred Until}, TODAY()))`;

async function postPending(env, channels, log) {
    // Kevin's lane never receives a Slack TS any more, so his rows match this
    // formula until he decides them in the dashboard. Fetching only
    // MAX_POSTS_PER_RUN rows would let ten of his rows permanently occupy the
    // whole page and silently starve Mica's cards — so over-fetch, filter,
    // and cap the POSTS, not the read.
    const recs = await queryTasks(env, `AND({Status}='Approval', LEN({Approval Slack TS}&'')=0, ${NOT_DEFERRED})`, 200);
    if (recs.length === 200) log.push('post: unposted queue hit the 200-row read cap — some of Mica\u2019s cards may wait a sweep');
    let posted = 0, kevinHeld = 0;
    for (const rec of recs) {
        if (posted >= MAX_POSTS_PER_RUN) break;
        const t = taskView(rec);
        const warn = isTier1Task(t);
        const approver = approverFor(t, warn);
        // Kevin's lane gets NO per-task card (his ruling, 1 Sep 2026) — the
        // 08:00 digest and the dashboard queue replaced them. Leaving the
        // task unposted (no Slack TS) is deliberate: nothing to react to,
        // nothing to reconcile, nothing on his phone.
        if (approver.key === 'kevin') { kevinHeld++; continue; }
        const agent = await agentName(env, t.agentId);
        const channel = await resolveChannelFor(env, approver, channels, log);
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
        posted++;
        log.push(`posted ${t.id}`);
    }
    if (kevinHeld) log.push(`kevin-lane pending without cards (by design): ${kevinHeld}`);
    return posted;
}

// ─── KEVIN'S DAILY DIGEST (1 Sep 2026) ───────────────────────────────

// One DM at 08:00 London: how many items wait for him and where to decide
// them. Replaces his per-task cards entirely. The hour lives in code, not the
// cron, for the same reason as the CEO brief (Cloudflare's week starts on
// Sunday and its clock is UTC — see money-daily-worker.js isLondonSendTime).
// KV remembers "sent today" so the every-minute cron sends exactly once, and
// the marker is written even on a zero-pending morning so a task arriving at
// 08:40 waits for tomorrow's digest rather than pinging him mid-morning.
export function londonParts(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    }).formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

export function buildDigestText(count, names, dashUrl, capped) {
    const shown = `${count}${capped ? '+' : ''}`;
    const top = names.slice(0, 3).map(n => `• ${n}`).join('\n');
    const more = count > 3 ? `\n…and ${capped ? 'more' : `${count - 3} more`}.` : '';
    return truncate(`*${shown} item${count === 1 && !capped ? '' : 's'} waiting for your approval.*\n`
        + `${top}${more}\n\n`
        + `Decide them here: ${dashUrl}\n`
        + `_This is the only approvals message you get today. Nothing has been sent or actioned._`, 2900);
}

const DASHBOARD_QUEUE_URL = 'https://chaichoong.github.io/leadership-dashboard/os/agents/index.html#tab=approvals';
const DIGEST_MAX = 500;

async function openDm(env, slackId) {
    const dm = await slack(env, 'https://slack.com/api/conversations.open', { method: 'POST', body: JSON.stringify({ users: slackId }) });
    return (dm.ok && dm.channel && dm.channel.id) ? dm.channel.id : null;
}

async function postKevinDigest(env, log) {
    const { date, hour } = londonParts();
    if (hour !== 8) return 0;
    // FAIL CLOSED on a missing KV binding. Falling through without the
    // send-once memory would post this DM every minute for the whole hour —
    // the exact flood the digest exists to end.
    if (!env.STATE) { log.push('digest SKIPPED: STATE KV binding missing — will not send without send-once memory'); return -1; }
    const kvKey = `apv-digest-${date}`;
    if (await env.STATE.get(kvKey)) return 0;

    // EXACTLY the dashboard queue's population (APV_QUEUE_FORMULA plus its
    // lane filter in os/agents/index.html) — the DM links there, so the two
    // numbers must be the same number.
    const recs = await queryTasks(env, `AND({Status}='Approval', LEN({Sent For Approval By}&'')>0, ${NOT_DEFERRED})`, DIGEST_MAX);
    const mine = recs.map(taskView).filter(t => {
        const e = String(t.approverEmail || '').toLowerCase();
        return !e || e === KEVIN_AIRTABLE_EMAIL;
    });

    if (mine.length) {
        const channel = await openDm(env, KEVIN_SLACK_ID);
        if (!channel) { log.push('digest DM open failed'); return -1; }
        const capped = recs.length >= DIGEST_MAX;
        const res = await slack(env, SLACK.post, {
            method: 'POST',
            body: JSON.stringify({
                channel,
                text: `${mine.length}${capped ? '+' : ''} approvals waiting`,
                blocks: [{ type: 'section', text: { type: 'mrkdwn', text: buildDigestText(mine.length, mine.map(t => esc(truncate(t.name, 120))), DASHBOARD_QUEUE_URL, capped) } }],
            }),
        });
        if (!res.ok) { log.push(`digest post failed: ${res.error}`); return -1; }
        log.push(`digest sent: ${mine.length}${capped ? '+' : ''} pending`);
    } else {
        // CONTROL. A broken value comparison returns 200 OK and zero rows,
        // which reads exactly like an empty queue — and quiet-zero then locks
        // the day. Prove the population the formula filters still exists at
        // all before trusting the zero.
        const control = await queryTasks(env, `LEN({Sent For Approval By}&'')>0`, 1);
        if (!control.length) { log.push('digest CONTROL FAILED: no task anywhere has Sent For Approval By — the read is broken, not the queue empty'); return -1; }
        log.push('digest: nothing pending (control passed), staying quiet');
    }
    await env.STATE.put(kvKey, mine.length ? 'sent' : 'quiet-zero', { expirationTtl: 172800 });
    return mine.length;
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

function reactionFrom(msg, slackId) {
    const reactions = (msg && msg.reactions) || [];
    const mine = reactions.filter(r => REACTION_OUTCOMES[r.name]
        && (r.users || []).indexOf(slackId) !== -1);
    if (!mine.length) return null;
    // A remember reaction WINS over a plain one. Kevin hitting ❌ and then 🧠
    // means "actually, learn from this" — reaction order in the Slack payload
    // is arrival order, so first-match would have thrown the lesson away and
    // looked identical to a plain reject.
    const r = mine.find(x => REMEMBER_REACTIONS.has(x.name)) || mine[0];
    return { outcome: REACTION_OUTCOMES[r.name], emoji: r.name,
             remember: REMEMBER_REACTIONS.has(r.name) };
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

// Apply the approver's verdict. Same semantics as the task drawer: approve
// hands the task BACK to the agent (due today) to carry the action out; reject
// ─── THE SAME REASONS AS THE PAGE, AS ONE WORD ──────────────────────
//
// The web queue asks WHY with seven chips (os/agents/index.html, 27 Aug 2026),
// because all 58 rejections Kevin had ever made were classified that day and
// not one was about the draft — every one was about the task existing. Slack
// has no chips, so the equivalent is a thread reply that STARTS with one of
// these words, exactly as ":brain:" is the Slack equivalent of the remember
// tickbox.
//
// This is matching, not inferring. The word is one Kevin chose to type, the
// same act as tapping a chip. A reply that starts with none of them records NO
// reason rather than a guessed one — an unclassified rejection still counts
// against the agent, and the accuracy report says how many there are, which is
// honest. A guessed reason would not be.
//
// Keys MUST stay identical to APV_REASONS in os/agents/index.html and to
// RELEVANCE_REASONS in js/agent-accuracy.js.
const SLACK_REASON_WORDS = [
    [/^done\b[:,.\s-]*/i,     'Already done elsewhere'],
    [/^roy\b[:,.\s-]*/i,      'Roy owns it'],
    [/^noise\b[:,.\s-]*/i,    'Not worth my attention'],
    [/^dupe\b[:,.\s-]*/i,     'Duplicate'],
    [/^park\b[:,.\s-]*/i,     'Parked for now'],
    [/^stale\b[:,.\s-]*/i,    'No longer relevant'],
    [/^wrong\b[:,.\s-]*/i,    'The work is wrong'],
];

/** Split a leading reason word off a thread reply.
 *  → { reason, note }. reason is '' when the reply names none. */
export function splitReason(text) {
    const raw = String(text || '').trim();
    for (const [re, reason] of SLACK_REASON_WORDS) {
        const m = raw.match(re);
        if (m) {
            const rest = raw.slice(m[0].length).trim();
            // A bare word is a complete instruction: the page fills the sentence
            // from the chip, so Slack must not demand more typing than the page.
            return { reason, note: rest };
        }
    }
    return { reason: '', note: raw };
}

// closes it. Nothing here ever marks approved work Completed — that is the
// agent's job, after it has actually done the thing.
async function applyDecision(env, t, outcome, decidedVia, note, approver, remember, reason) {
    approver = approver || APPROVERS.kevin;
    const now = new Date().toISOString();
    const fields = {
        [AF.approvalOutcome]: outcome,
        [AF.approvedAt]: now,
        [AF.approvedBy]: { email: approver.email },
        [AF.slackTs]: '',
        [AF.slackBaseline]: '',
    };
    if (outcome === 'Rejected') {
        fields[AF.status] = 'Completed';
        fields[AF.completion] = now;
    } else {
        fields[AF.status] = 'Today';
        fields[AF.dueDate] = now.slice(0, 10);
        // Reopening MUST clear the completion stamp, or a task completed once
        // and later approved keeps counting as finished work in every
        // throughput and Completed Month figure. Same rule as the Tasks page.
        fields[AF.completion] = null;
    }
    if (t.agentId) {
        fields[AF.teamMember] = [t.agentId];
        fields[AF.sentForApprovalBy] = [t.agentId];
        fields[AF.assignee] = null; // the agent owns it now; Assignee cannot hold one
    }
    // Kevin's words go in a FIELD, because this worker's PAT cannot write record
    // comments either. Without this the whole point of an amendment — telling
    // the agent what to change — would be lost.
    if (note) fields[AF.approvalFeedback] = note;
    // WHY, recorded as data. Without it a reject from the phone degrades the
    // score in a way a reject from the desk no longer does.
    if (reason) fields[AF.verdictReason] = reason;
    // The durable copy. approvalFeedback is cleared by the next submit, so
    // without this the words that caused a redo are gone within the hour and
    // the lesson writer has nothing left to read.
    if (note) {
        const prior = String(t.feedbackHistory || '');
        const block = `[${now.replace('T', ' ').slice(0, 16)}] ${note}`;
        if (prior.indexOf(block) === -1) {
            fields[AF.feedbackHistory] = (prior.replace(/\s+$/, '') + '\n\n' + block).trim();
        }
    }
    // Kevin asked for this one to be remembered. The flag is all this worker
    // does: the lesson itself is written by scripts/agent-dispatch.py lessons,
    // on the Mac, because the destination is the agent's own definition file
    // and a Cloudflare Worker cannot reach the filesystem. Ticking the box here
    // and writing there keeps ONE writer, which is why the register and the
    // agent file can never disagree.
    if (remember && note) fields[AF.rememberThis] = true;
    await airtable(env, 'PATCH', `/${TABLE_TASKS}/${t.id}`, { fields, typecast: true });
    const agent = await agentName(env, t.agentId);
    const line = outcome === 'Rejected'
        ? `Rejected by ${approver.name} ${decidedVia}. Closed`
              + (reason && reason !== 'The work is wrong'
                  ? `. Not counted against ${agent || 'the agent'} — the task should not have reached you (${reason.toLowerCase()}).`
                  : `, and counted against ${agent || 'the agent'}.`)
              + (remember && note ? ` ${agent || 'The agent'} will remember your reason from now on.` : '')
              + (note ? `\n\nReason: ${note}` : '')
        : outcome === 'Changes requested'
            ? `Changes requested by ${approver.name} ${decidedVia}. Back to ${agent || 'the agent'}. Nothing has gone out.`
                  + (note ? `\n\nWhat to change: ${note}` : '')
            : `${outcome} by ${approver.name} ${decidedVia}. Back to ${agent || 'the agent'} to carry out, then it completes itself.`
                  + (note ? `\n\nNote: ${note}` : '');
    return line;
}

// Slack clients decorate messages. A trailing "*Sent using* <@Uxxxx>" footer
// and raw <@U…>/<#C…> markup are noise in an instruction the agent has to
// follow, so they are stripped before the words are stored.
function cleanReply(text) {
    return String(text || '')
        .replace(/\*?_?Sent using_?\*?\s*<@[^>]+>\s*$/i, '')
        .replace(/<@([A-Z0-9]+)\|([^>]+)>/g, '$2')
        .replace(/<@[A-Z0-9]+>/g, '')
        .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
        .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
        .replace(/<(https?:[^>]+)>/g, '$1')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
}

// The approver's own replies in the thread, oldest first, ignoring the bot's.
async function repliesFrom(env, channel, ts, slackId) {
    const url = `${SLACK.replies}?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(ts)}&limit=50`;
    const data = await slackGet(env, url);
    if (!data.ok) return [];
    return (data.messages || [])
        .filter(m => m.ts !== ts && !m.bot_id && m.user === slackId && String(m.text || '').trim())
        .map(m => cleanReply(m.text))
        .filter(Boolean);
}

// Read everything the task's APPROVER has said about a posted task and act on
// it. Only the routed approver's words and reactions count — Kevin for his
// queue, Mica for hers.
//
// A written reply IS the amendment — there is no emoji to remember for changes.
// Reply "make it warmer and drop the deadline" and that goes back to the agent
// as the instruction. The emoji are only for the two verdicts a sentence cannot
// express as safely: release the work, or kill it.
//
//   reply only              → changes requested, their words are the instruction
//   ✅ (with or without a reply) → approved, any reply attached as a note
//   ❌ (with or without a reply) → rejected, any reply attached as the reason
//   ✏️ alone                → they mean "changes" but have not said what yet; ask
async function processResponses(env, channels, log) {
    // Read the WHOLE queue (one subrequest), then check only this minute's
    // rotation window. Capping the QUERY at the check limit — the old design —
    // meant tasks past the cap were never checked at all: a reaction on the
    // 30th of 46 pending messages would sit unapplied for ever, silently.
    const all = await queryTasks(env, `AND({Status}='Approval', LEN({Approval Slack TS}&'')>0)`, 100);
    const win = rotationWindow(all.length, MAX_REACTION_CHECKS_PER_RUN, Math.floor(Date.now() / 60000));
    const recs = all.slice(win.start, win.end);
    if (all.length > recs.length) log.push(`reactions: window ${win.start}-${win.end - 1} of ${all.length}, full cycle every ${Math.ceil(all.length / MAX_REACTION_CHECKS_PER_RUN)} min`);
    for (const rec of recs) {
        const t = taskView(rec);
        const approver = approverFor(t, isTier1Task(t));
        const channel = await resolveChannelFor(env, approver, channels, log);
        const msg = await fetchMessage(env, channel, t.ts);
        if (!msg) { log.push(`no message for ${t.id}`); continue; }
        const reaction = reactionFrom(msg, approver.slackId);
        // The replies fetch is a second subrequest per task — skip it when the
        // parent message says there is no thread to read.
        const replies = msg.reply_count ? await repliesFrom(env, channel, t.ts, approver.slackId) : [];
        const note = replies.join('\n\n');
        if (!reaction && !replies.length) continue;

        // A pencil on its own is a half-finished instruction. Asking beats
        // guessing, and it costs him one line.
        if (reaction && reaction.outcome === 'Changes requested' && !replies.length) {
            await threadReply(env, channel, t.ts,
                'Tell me what to change and I will send it back to the agent with your words. '
                + 'Just reply here — you do not need the emoji.');
            log.push(`asked for detail on ${t.id}`);
            continue;
        }

        // Same principle for "reject and remember": the whole point is the
        // reason, so a lone :brain: has nothing to teach. Ask rather than
        // storing an empty lesson or silently downgrading it to a plain
        // reject, which would look identical to Kevin and lose the rule.
        if (reaction && reaction.remember && !replies.length) {
            await threadReply(env, channel, t.ts,
                'Happy to make that a standing rule — I just need the reason. '
                + 'Reply here with what the agent should learn (for example '
                + '"Roy deals with council fire safety letters directly") and '
                + 'I will reject this and add it to its instructions for good.');
            log.push(`asked for the lesson on ${t.id}`);
            continue;
        }

        const outcome = reaction && reaction.outcome !== 'Changes requested'
            ? reaction.outcome          // approve or reject
            : 'Changes requested';      // a written reply, or pencil plus words

        // THE STALENESS GUARD. It applies to APPROVE and REJECT, which release
        // or kill real work on the strength of what the message said. It does
        // NOT block an amendment: sending feedback back to an agent puts nothing
        // out into the world, and refusing Kevin's words would be the wrong
        // trade. The agent is told the task moved instead.
        if (isStale(t) && outcome !== 'Changes requested') {
            // Where it goes next differs by lane: Mica's card is reposted
            // fresh; Kevin's lane gets no cards any more (1 Sep 2026), so his
            // truth is the dashboard queue and the next digest. Promising him
            // a repost that cannot happen would be a lie in the thread.
            const next = approver.key === 'kevin'
                ? `This card is now closed — read it as it stands and decide it in the dashboard queue: ${DASHBOARD_QUEUE_URL}`
                : 'I am posting it again as it now stands.';
            await threadReply(env, channel, t.ts,
                `:warning: Not applying that. This task changed after I posted it, so your ${outcome === 'Rejected' ? 'rejection' : 'approval'} `
                + `would be acting on something you have not read. Posted as at ${t.baseline.replace('T', ' ').slice(0, 16)} UTC, `
                + `last changed ${String(t.lmt).replace('T', ' ').slice(0, 16)} UTC. ${next}`);
            // Clearing the timestamp takes it out of the reactions loop; for
            // Mica's lane it is also what makes the post phase repost it.
            await airtable(env, 'PATCH', `/${TABLE_TASKS}/${t.id}`, {
                fields: { [AF.slackTs]: '', [AF.slackBaseline]: '' }, typecast: true,
            });
            log.push(`STALE ${t.id} — ${outcome} refused, ${approver.key === 'kevin' ? 'sent to dashboard' : 're-queued'}`);
            continue;
        }

        const staleNote = (isStale(t) && outcome === 'Changes requested')
            ? '\n\n(The task had changed since I posted it, so read the current version before redoing it.)'
            : '';
        // Only a REJECT carries a reason. On an approve or an amendment the
        // leading word is just the first word of Kevin's sentence, and eating
        // it would silently change what the agent is told to do.
        const parsed = outcome === 'Rejected' ? splitReason(note) : { reason: '', note };
        const finalNote = parsed.note ? parsed.note + staleNote : staleNote.trim();
        const line = await applyDecision(env, t, outcome, 'in Slack',
            finalNote, approver,
            !!(reaction && reaction.remember), parsed.reason);
        await threadReply(env, channel, t.ts,
            outcome === 'Changes requested'
                ? `:writing_hand: Sent back with your notes. ${esc(line.split('\n')[0])}`
                : `:heavy_check_mark: ${esc(line.split('\n')[0])}`);
        log.push(`applied ${outcome} to ${t.id}${replies.length ? ' (from a thread reply)' : ''}`);
    }
    return recs.length;
}

// ─── RECONCILE PHASE ──────────────────────────────────────────────────

// The approver decided in the dashboard while a Slack message was still live.
// Close the thread so the conversation never shows a stale "waiting" post, and
// clear the timestamp — which is also what stops this running twice on a task.
//
// A knock-back rides the same path, and belongs here rather than in a phase of
// its own: it is the same event — this stopped being a live ask somewhere else
// — and the same two writes fix it. The only difference is what the thread is
// told and the fact that the task is coming BACK, which the cleared timestamp
// arranges by itself the day postPending's date clause starts matching again.
async function reconcileDecidedElsewhere(env, channels, log) {
    const recs = await queryTasks(env,
        `AND(LEN({Approval Slack TS}&'')>0, OR({Status}!='Approval', IS_AFTER({Deferred Until}, TODAY())))`,
        MAX_RECONCILES_PER_RUN);
    for (const rec of recs) {
        const t = taskView(rec);
        const approver = approverFor(t, isTier1Task(t));
        const channel = await resolveChannelFor(env, approver, channels, log);
        // Deferred is checked FIRST: a task can be both at Status Approval and
        // knocked back, and "left the approval queue" would be the wrong story
        // for something that is due back on a known date.
        const deferred = t.status === 'Approval' && t.deferredUntil;
        const returnsTo = approver.key === 'kevin'
            ? 'your dashboard queue and morning digest'
            : 'you here';
        await threadReply(env, channel, t.ts,
            deferred ? `:alarm_clock: Knocked back until *${t.deferredUntil}*. Nothing approved, nothing sent — it comes back to ${returnsTo} that morning.`
                     : t.outcome ? `:heavy_check_mark: Decided in the dashboard: *${t.outcome}*.`
                                 : `:information_source: This task left the approval queue in the dashboard.`);
        await airtable(env, 'PATCH', `/${TABLE_TASKS}/${t.id}`, {
            fields: { [AF.slackTs]: '', [AF.slackBaseline]: '' }, typecast: true,
        });
        log.push(deferred ? `deferred ${t.id} to ${t.deferredUntil}` : `closed thread for ${t.id}`);
    }
    return recs.length;
}

// ─── ENTRY ────────────────────────────────────────────────────────────

// Pure, exported for tests. Which slice of an n-deep queue this minute's run
// checks: page (minuteIndex mod pages) of size cap, so every pending task is
// reached within ceil(n/cap) minutes instead of everything past the cap being
// reached never.
export function rotationWindow(total, cap, minuteIndex) {
    if (total <= cap) return { start: 0, end: total };
    const pages = Math.ceil(total / cap);
    const page = ((minuteIndex % pages) + pages) % pages;
    const start = page * cap;
    return { start, end: Math.min(start + cap, total) };
}

// Each phase is isolated: the reactions phase is the expensive one and used to
// take the whole sweep down with it when it blew the subrequest budget, which
// starved the phases queued behind it. A failed phase logs and returns -1;
// the others still run. Phase order is deliberate: post first (a new approval
// reaching Kevin beats everything), then reconcile (cheap, bounded, and what
// keeps the channel honest about what is still waiting), then reactions.
export async function runApprovalSweep(env) {
    const log = [];
    if (!env.SLACK_BOT_TOKEN || !env.AIRTABLE_PAT) {
        return { ok: false, error: 'missing SLACK_BOT_TOKEN or AIRTABLE_PAT', log };
    }
    // Per-run cache of approver → conversation id. Resolved lazily so a run
    // with no Mica tasks never spends the subrequest opening her DM.
    const channels = {};
    const phase = async (name, fn) => {
        try { return await fn(); }
        catch (err) { log.push(`${name} FAILED: ${String(err && err.message || err).slice(0, 200)}`); return -1; }
    };
    const digest = await phase('digest', () => postKevinDigest(env, log));
    const posted = await phase('post', () => postPending(env, channels, log));
    const closed = await phase('reconcile', () => reconcileDecidedElsewhere(env, channels, log));
    const checked = await phase('reactions', () => processResponses(env, channels, log));
    return { ok: true, channel: channels.kevin || null, digest, posted, checked, closed, log };
}

// Delete the bot's OWN posts in the approvals channel whose text contains
// `match`, plus their thread replies. Exists because a build or a rehearsal
// leaves test posts in a channel Kevin has to trust at a glance, and a channel
// full of "TEST —" noise is a channel he stops reading.
//
// Deliberately narrow: admin-key gated, this channel only, the bot's own
// messages only, and `match` is REQUIRED — there is no "delete everything".
export async function purgeApprovalPosts(env, match) {
    const needle = String(match || '').trim();
    if (!needle) return { ok: false, error: 'a match string is required — refusing to delete indiscriminately' };
    const ch = await resolveChannel(env);
    const hist = await slackGet(env, `${SLACK.history}?channel=${encodeURIComponent(ch.id)}&limit=200`);
    if (!hist.ok) return { ok: false, error: hist.error };

    const targets = (hist.messages || []).filter(m =>
        (m.bot_id || m.app_id) && String(m.text || JSON.stringify(m.blocks || '')).includes(needle));

    const deleted = [];
    for (const m of targets) {
        // Thread replies first — deleting a parent orphans them otherwise.
        if (m.thread_ts || m.reply_count) {
            const thread = await slackGet(env, `${SLACK.replies}?channel=${encodeURIComponent(ch.id)}&ts=${encodeURIComponent(m.ts)}&limit=100`);
            for (const r of ((thread.messages || []).filter(x => x.ts !== m.ts && (x.bot_id || x.app_id)))) {
                const d = await slack(env, SLACK.delete, { method: 'POST', body: JSON.stringify({ channel: ch.id, ts: r.ts }) });
                if (d.ok) deleted.push(r.ts);
            }
        }
        const d = await slack(env, SLACK.delete, { method: 'POST', body: JSON.stringify({ channel: ch.id, ts: m.ts }) });
        if (d.ok) deleted.push(m.ts); else return { ok: false, error: d.error, deletedSoFar: deleted.length };
    }
    return { ok: true, channel: ch.id, matched: targets.length, deleted: deleted.length };
}

// Rewrite ONE live approval message in place to the current block layout
// (chat.update keeps the ts, the thread and any reactions). One task per call
// on purpose: a bulk rewrite of a 46-deep queue would blow the Worker's
// per-invocation subrequest limit — the same limit that failed a manual
// /approvals/run on 11 Aug 2026 — so the caller loops over record ids instead.
//
// The baseline is re-stamped in the SAME pattern as postPending: the edited
// message shows the task as it stands NOW, so the staleness guard must measure
// from now, not from the original post. Without this, any task edited since
// its first post would refuse an approve of content Kevin can actually read.
export async function rewriteApprovalPost(env, taskId) {
    const id = String(taskId || '').trim();
    if (!/^rec[a-zA-Z0-9]{14}$/.test(id)) return { ok: false, error: 'a task record id (?task=recXXXXXXXXXXXXXX) is required' };
    const recs = await queryTasks(env, `RECORD_ID()='${id}'`, 1);
    if (!recs.length) return { ok: false, error: `task ${id} not found` };
    const t = taskView(recs[0]);
    if (t.status !== 'Approval' || !t.ts) return { ok: false, error: `task ${id} has no live approval message (status ${t.status || 'unknown'}, ts ${t.ts ? 'set' : 'empty'})` };
    const agent = await agentName(env, t.agentId);
    const warn = isTier1Task(t);
    const chId = await resolveChannelFor(env, approverFor(t, warn), {}, []);
    const res = await slack(env, SLACK.update, {
        method: 'POST',
        body: JSON.stringify({
            channel: chId,
            ts: t.ts,
            text: `Approval needed: ${t.name}`,
            blocks: buildApprovalBlocks(t, agent, warn),
        }),
    });
    if (!res.ok) return { ok: false, error: res.error, task: id };
    await airtable(env, 'PATCH', `/${TABLE_TASKS}/${t.id}`, {
        fields: { [AF.slackBaseline]: new Date().toISOString() }, typecast: true,
    });
    return { ok: true, task: t.id, ts: t.ts };
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
        // The agent's work must be READABLE or every post says "nothing to judge".
        agentOutputRead: await (async () => {
            const pending = await queryTasks(env, `{Status}='Approval'`, 1);
            if (!pending.length) return 'no pending task to test against';
            const t = taskView(pending[0]);
            return t.agentOutput ? `ok — ${t.agentOutput.length} chars readable` : 'that task has an empty Agent Output';
        })(),
    };
}
