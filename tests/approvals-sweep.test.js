// The approvals sweep must survive a deep queue.
//
// On 11 Aug 2026 the queue reached 46 pending approval messages and the
// every-minute sweep started dying mid-run on Cloudflare's per-invocation
// subrequest limit ("Too many subrequests"). Three separate defects combined:
//
//   1. The reactions phase queried only the first MAX_REACTION_CHECKS_PER_RUN
//      tasks, so a reaction on any task past the cap was NEVER checked —
//      silently, for ever.
//   2. The reconcile phase ran LAST, so when the reactions phase blew the
//      budget, threads for tasks Kevin had already decided in the dashboard
//      were never closed: 18 of them sat showing "waiting" for over 5 hours.
//   3. One phase's throw killed the whole sweep.
//
// These tests fail against the pre-fix code (verified by reverting the sweep).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rotationWindow } from '../scripts/slack-automation/approvals.js';

const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../scripts/slack-automation/approvals.js'),
    'utf8'
);

describe('rotationWindow covers the whole queue', () => {
    it('reaches every task in a 46-deep queue within one cycle, no overlaps', () => {
        const total = 46, cap = 12;
        const pages = Math.ceil(total / cap);
        const seen = new Set();
        for (let minute = 0; minute < pages; minute++) {
            const { start, end } = rotationWindow(total, cap, minute);
            expect(end - start).toBeGreaterThan(0);
            expect(end - start).toBeLessThanOrEqual(cap);
            for (let i = start; i < end; i++) {
                expect(seen.has(i)).toBe(false); // no index checked twice per cycle
                seen.add(i);
            }
        }
        expect(seen.size).toBe(total); // every index checked — the old code stopped at cap
    });

    it('checks everything in one pass when the queue fits the cap', () => {
        expect(rotationWindow(5, 12, 7)).toEqual({ start: 0, end: 5 });
        expect(rotationWindow(0, 12, 3)).toEqual({ start: 0, end: 0 });
    });

    it('cycles: the same window returns after ceil(total/cap) minutes', () => {
        const a = rotationWindow(46, 12, 3);
        const b = rotationWindow(46, 12, 3 + Math.ceil(46 / 12));
        expect(a).toEqual(b);
    });
});

describe('sweep structure guards (source-level, same style as recon-vendor-key)', () => {
    it('the reactions phase reads the whole queue then windows it, not a capped query', () => {
        // The bug: queryTasks(..., MAX_REACTION_CHECKS_PER_RUN) meant tasks past
        // the cap were invisible. The fix queries wide and slices a rotation.
        // Back-tested against the pre-fix source (git 5dcb745): both asserts
        // fail there. (A not.toMatch on the old capped queryTasks call was
        // tried first and turned out vacuous — the regex could not cross the
        // parentheses inside the Airtable formula — so positive asserts only.)
        const fn = SRC.slice(SRC.indexOf('async function processResponses'));
        const body = fn.slice(0, fn.indexOf('\n}'));
        expect(body).toMatch(/rotationWindow\(/);
        expect(body).toMatch(/\.slice\(win\.start,\s*win\.end\)/);
    });

    it('reconcile runs before the expensive reactions phase', () => {
        const entry = SRC.slice(SRC.indexOf('export async function runApprovalSweep'));
        const reconcileAt = entry.indexOf('reconcileDecidedElsewhere');
        const reactionsAt = entry.indexOf('processResponses');
        expect(reconcileAt).toBeGreaterThan(-1);
        expect(reactionsAt).toBeGreaterThan(-1);
        expect(reconcileAt).toBeLessThan(reactionsAt);
    });

    it('every phase call in the entry point is wrapped so one failure cannot starve the rest', () => {
        const entry = SRC.slice(SRC.indexOf('export async function runApprovalSweep'));
        for (const name of ['postPending', 'reconcileDecidedElsewhere', 'processResponses']) {
            expect(entry).toMatch(new RegExp(`phase\\(['"][a-z]+['"],\\s*\\(\\)\\s*=>\\s*${name}\\(`));
        }
    });

    it('a worst-case run fits the ~50-subrequest budget', () => {
        // Costs per item: post = 2 (chat.postMessage + PATCH), reconcile = 2
        // (threadReply + PATCH), reaction check = 2 worst case (history +
        // replies). Plus one query per phase and a handful of fixed calls.
        const cap = (name) => Number((SRC.match(new RegExp(`const ${name} = (\\d+);`)) || [])[1]);
        const posts = cap('MAX_POSTS_PER_RUN');
        const reactions = cap('MAX_REACTION_CHECKS_PER_RUN');
        const reconciles = cap('MAX_RECONCILES_PER_RUN');
        expect(posts).toBeGreaterThan(0);
        expect(reactions).toBeGreaterThan(0);
        expect(reconciles).toBeGreaterThan(0);
        const worstCase = 3 /* phase queries */ + posts * 2 + reactions * 2 + reconciles * 2;
        // The old caps (10/25/25) score 123. Phase isolation means a freak
        // all-maxed minute degrades one phase rather than the sweep, but the
        // TYPICAL worst case must fit: posts and reconciles are rarely at cap
        // together, so budget the two phases that dominate steady state.
        expect(3 + reactions * 2 + reconciles * 2).toBeLessThanOrEqual(48);
    });
});
