// The 08:00 approvals digest replaced Kevin's per-task Slack cards
// (his ruling, 1 Sep 2026: 20+ cards a day buried the phone and stopped being
// read). These tests hold the new contract:
//   1. Kevin's lane gets NO per-task card, ever — postPending skips it.
//   2. He gets ONE digest DM in the 08:00 London hour, deduped via KV, silent
//      on a zero-pending morning.
//   3. Mica's lane still gets full cards — her machinery is untouched.
// If a future change quietly re-enables Kevin's cards, the first test fails.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { londonParts, buildDigestText } from '../scripts/slack-automation/approvals.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'scripts/slack-automation/approvals.js'), 'utf8');

describe('Kevin gets no per-task cards', () => {
    it('postPending skips his lane before any Slack call', () => {
        const fn = SRC.match(/async function postPending\(env[\s\S]*?\n\}/);
        expect(fn).not.toBeNull();
        const kevinSkip = fn[0].indexOf("if (approver.key === 'kevin') { kevinHeld++; continue; }");
        const firstPost = fn[0].indexOf('SLACK.post');
        expect(kevinSkip, 'the kevin-lane skip must exist in postPending').toBeGreaterThan(-1);
        expect(kevinSkip, 'the skip must come before the card is posted').toBeLessThan(firstPost);
    });
    it('his skipped rows cannot starve Mica: read wide, cap the posts', () => {
        // Kevin's rows never get a Slack TS, so they match the unposted
        // formula forever. Reading only MAX_POSTS_PER_RUN rows let ten of his
        // rows occupy the whole page and silently stop Mica's cards (review
        // finding, 1 Sep 2026). The read must be far wider than the post cap.
        const fn = SRC.match(/async function postPending\(env[\s\S]*?\n\}/)[0];
        expect(fn).toMatch(/queryTasks\(env, [\s\S]*?, 200\)/);
        expect(fn).toContain('if (posted >= MAX_POSTS_PER_RUN) break;');
        expect(fn, 'held-back rows must be visible in the log').toContain('kevin-lane pending without cards');
    });
    it('queryTasks follows the offset token instead of capping at one page', () => {
        const fn = SRC.match(/async function queryTasks\(env[\s\S]*?\n\}/)[0];
        expect(fn).toMatch(/data\.offset/);
        expect(fn).toMatch(/while \(offset/);
    });
    it('the sweep still posts, reconciles and reads reactions for live cards (Mica + legacy)', () => {
        expect(SRC).toMatch(/phase\('post', \(\) => postPending/);
        expect(SRC).toMatch(/phase\('reconcile', \(\) => reconcileDecidedElsewhere/);
        expect(SRC).toMatch(/phase\('reactions', \(\) => processResponses/);
    });
});

describe('the 08:00 digest', () => {
    it('runs as a sweep phase', () => {
        expect(SRC).toMatch(/phase\('digest', \(\) => postKevinDigest/);
    });
    it('the hour lives in code in Europe/London, never in the cron', () => {
        // Same rule as the CEO brief: Cloudflare crons are UTC and its week
        // starts on Sunday, so local-time decisions belong in the worker.
        expect(SRC).toMatch(/timeZone: 'Europe\/London'/);
        expect(SRC).toMatch(/if \(hour !== 8\) return 0;/);
    });
    it('londonParts reads the London clock through both halves of the year', () => {
        // GMT: 08:30 UTC is 08:30 London.
        expect(londonParts(new Date('2026-01-15T08:30:00Z')).hour).toBe(8);
        // BST: 07:30 UTC is 08:30 London — a UTC-hour gate would miss this.
        expect(londonParts(new Date('2026-07-15T07:30:00Z')).hour).toBe(8);
        expect(londonParts(new Date('2026-07-15T08:30:00Z')).hour).toBe(9);
        expect(londonParts(new Date('2026-01-15T08:30:00Z')).date).toBe('2026-01-15');
    });
    it('sends once per London day via a KV marker, written even on a quiet morning', () => {
        expect(SRC).toMatch(/apv-digest-\$\{date\}/);
        // The marker write sits OUTSIDE the "anything pending" branch, so a
        // task arriving at 08:40 waits for tomorrow rather than pinging him.
        expect(SRC).toMatch(/env\.STATE\.put\(kvKey, mine\.length \? 'sent' : 'quiet-zero'/);
    });
    it('fails CLOSED when the KV binding is missing', () => {
        // Falling through without send-once memory means a DM every minute
        // for the whole hour — the exact flood the digest exists to end.
        expect(SRC).toMatch(/if \(!env\.STATE\) \{ log\.push\('digest SKIPPED: STATE KV binding missing/);
    });
    it('counts the SAME population as the dashboard queue it links to', () => {
        // APV_QUEUE_FORMULA in os/agents/index.html requires Sent For
        // Approval By; a digest without that clause counts items the page
        // cannot show, and Kevin can never find the difference.
        const digest = SRC.match(/async function postKevinDigest[\s\S]*?\n\}/)[0];
        expect(digest).toContain("LEN({Sent For Approval By}&'')>0");
        const dashboard = readFileSync(join(ROOT, 'os/agents/index.html'), 'utf8');
        expect(dashboard).toContain("LEN({Sent For Approval By}&'')>0");
    });
    it('a zero count is only trusted after a control read proves the field works', () => {
        // A broken value comparison returns 200 OK and zero rows — identical
        // to an empty queue — and quiet-zero then locks in for the day.
        const digest = SRC.match(/async function postKevinDigest[\s\S]*?\n\}/)[0];
        expect(digest).toContain('digest CONTROL FAILED');
    });
    it('long agent task names cannot kill the one message of the day', () => {
        // Slack rejects the whole message if a block passes ~3000 chars.
        const digest = SRC.match(/async function postKevinDigest[\s\S]*?\n\}/)[0];
        expect(digest).toMatch(/esc\(truncate\(t\.name, 120\)\)/);
        const build = SRC.match(/export function buildDigestText[\s\S]*?\n\}/)[0];
        expect(build).toMatch(/truncate\([\s\S]*2900\)/);
        // And a capped read says so rather than presenting the cap as truth.
        expect(buildDigestText(500, ['A', 'B', 'C'], 'u', true)).toContain('*500+ items');
    });
    it('says the count, the top names, and where to decide — nothing else', () => {
        const url = 'https://example.test/queue';
        const one = buildDigestText(1, ['Pay the licence fee'], url);
        expect(one).toContain('*1 item waiting for your approval.*');
        expect(one).toContain('• Pay the licence fee');
        expect(one).toContain(url);
        const five = buildDigestText(5, ['A', 'B', 'C', 'D', 'E'], url);
        expect(five).toContain('*5 items waiting for your approval.*');
        expect(five).toContain('…and 2 more.');
        expect(five).not.toContain('• D');
        expect(five).toContain('Nothing has been sent or actioned');
    });
    it('links the dashboard approvals tab, which is where decisions happen now', () => {
        expect(SRC).toContain('os/agents/index.html#tab=approvals');
    });
});
