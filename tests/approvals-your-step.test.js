// ─── A "YOUR STEP" CARD MUST NEVER REACH A SLACK LANE THAT IS NOT KEVIN'S ────
//
// Finding 20261015-agent-dispatch-911, task recfTre4IN01T8ttw. A YOUR STEP card
// is work the robot cannot do and only Kevin can: sign in somewhere, put in a
// payment detail, give access. agent-dispatch.py puts that block at the top of
// Agent Output (YOUR_STEP_MARK) and leaves the task in Approval, and
// your_step_fields never checks who the approver reads as. So this worker was the
// only thing standing between such a card and Mica's DM — and it had no guard, so
// it posted them.
//
// Two harms, not one: it asks somebody who cannot act to approve something that is
// not a decision, AND the post stamps a Slack TS, which takes the card out of
// Kevin's own unposted lane (`LEN({Approval Slack TS}&'')=0`) for good.
//
// This drives the real postPending with global fetch stubbed, so it proves the
// behaviour rather than the shape of the source. Back-tested by removing the
// guard: the first case then posts the YOUR STEP card and patches a Slack TS onto
// it, exactly as on 15 Oct 2026.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { postPending, isYourStepCard } from '../scripts/slack-automation/approvals.js';

const AF_NAME = 'fldgFjGBw6bTKJFCD';
const AF_OUTPUT = 'fldzswp8fx6PqpLQ5';
const AF_STATUS = 'fldx4qCw17UfrKpaN';
const AF_APPROVER = 'fldLLAG5HQPEFEfE5';
const MICA = 'micaa.work@gmail.com';

const env = { AIRTABLE_PAT: 'pat', SLACK_BOT_TOKEN: 'xoxb', SLACK_CHANNEL_ID: 'C123' };

function rec(id, name, output) {
    return { id, fields: {
        [AF_NAME]: name, [AF_OUTPUT]: output,
        [AF_STATUS]: 'Approval', [AF_APPROVER]: { email: MICA },
    } };
}

// Every call the worker can make, answered. Records what it tried to do.
function stubFetch(records) {
    const posts = [];
    const patches = [];
    global.fetch = vi.fn(async (url, init = {}) => {
        const u = String(url);
        const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
        if (u.includes('api.airtable.com') && (init.method || 'GET') === 'GET') {
            if (u.includes('tblco0p2OnlLQVAX7')) return ok({ fields: { Name: 'Property Administration' } });
            return ok({ records });
        }
        if (u.includes('api.airtable.com') && init.method === 'PATCH') {
            patches.push({ url: u, body: JSON.parse(init.body) });
            return ok({ id: 'rec' });
        }
        if (u.includes('conversations.open')) return ok({ ok: true, channel: { id: 'D999' } });
        if (u.includes('chat.postMessage')) {
            posts.push(JSON.parse(init.body));
            return ok({ ok: true, ts: '1760000000.0001' });
        }
        return ok({ ok: true });
    });
    return { posts, patches };
}

afterEach(() => { vi.restoreAllMocks(); delete global.fetch; });

describe('postPending holds back YOUR STEP cards (911)', () => {
    it('THE REGRESSION: a YOUR STEP card on Mica\'s lane is neither posted nor stamped', async () => {
        const { posts, patches } = stubFetch([
            rec('recfTre4IN01T8ttw', 'Swinton block policy',
                'YOUR STEP: sign in to Swinton so the robot can read the schedule.'),
        ]);
        const log = [];
        const posted = await postPending(env, {}, log);
        expect(posted, 'nothing may be posted for a step only Kevin can do').toBe(0);
        expect(posts).toEqual([]);
        expect(patches, 'a Slack TS would take the card out of Kevin\'s own lane for good').toEqual([]);
        expect(log.join(' ')).toMatch(/your-step cards held back/);
    });

    it('CONTROL — an ordinary card on the same lane is still posted and stamped', async () => {
        // Without this, a guard that blocked everything would pass the test above.
        const { posts, patches } = stubFetch([
            rec('recORDINARY0000001', 'Quote for the Elmdon EICR',
                'Three quotes gathered. Cheapest is 84 GBP. Book it?'),
        ]);
        const log = [];
        const posted = await postPending(env, {}, log);
        expect(posted).toBe(1);
        expect(posts).toHaveLength(1);
        expect(posts[0].text).toContain('Quote for the Elmdon EICR');
        expect(patches).toHaveLength(1);
    });

    it('one YOUR STEP card does not starve the ordinary cards behind it', async () => {
        const { posts } = stubFetch([
            rec('recYOURSTEP0000001', 'Virgin Media sign-in', 'YOUR STEP: sign in to Virgin Media.'),
            rec('recORDINARY0000002', 'Book the gas safety check', 'Cheapest quote is 72 GBP. Book it?'),
        ]);
        const posted = await postPending(env, {}, []);
        expect(posted).toBe(1);
        expect(posts.map((p) => p.text).join(' ')).toContain('Book the gas safety check');
        expect(posts.map((p) => p.text).join(' ')).not.toContain('Virgin Media sign-in');
    });

    it('the predicate reads the mark at the top, case-insensitively, and survives a blank', () => {
        expect(isYourStepCard({ agentOutput: 'YOUR STEP: give the robot access.' })).toBe(true);
        expect(isYourStepCard({ agentOutput: '  your step: pay this one yourself.' })).toBe(true);
        expect(isYourStepCard({ agentOutput: 'A quote. Your step is not mentioned as a banner.' })).toBe(false);
        expect(isYourStepCard({})).toBe(false);
        expect(isYourStepCard(null)).toBe(false);
    });
});
