// Tier-1 routing must see everything the dispatch engine sees.
//
// THE BUG (finding 20260813-drift-monitor-117, drift monitor, 13 Aug 2026).
// Every routing decision in scripts/slack-automation/approvals.js read exactly
// two fields:
//
//     isKevinOnlyMatter(`${t.name} ${t.description}`)
//
// Name and description are the one part of a task an agent never writes. They
// are set by Inbound Comms when the email lands, before any agent has read a
// word of it. So a tier-1 connection the AGENT discovered while working — and
// stamped onto Agent Output as TIER1_BANNER — was invisible to the router.
//
// The consequence is the one thing the tier-1 rule exists to prevent. A label-8
// inbound task carries Approver = Mica. approverFor() sends a non-tier-1 task to
// its Approver, and Mica's cards go to a bot DM. So an agent that opened a
// routine-looking task, found Kevin's private legal matter behind it, and
// correctly banner-stamped its output would have had that output DM'd to Mica —
// banner and all, which makes it worse, not better.
//
// Latent when found, not live: 6 tasks with Approver = Mica were open and none
// was tier 1. That is the window to close it in.
//
// THE FIX. isTier1Task(t) reads three inputs, each covering the others' blind
// spot: agentOutput (a connection only the agent could see), name+description (a
// task no agent has touched yet), and notes (what a human appended afterwards —
// agent-dispatch.py has always read notes; this half never did). Plus
// agent-dispatch `submit` now writes Approver = Kevin when it decides tier 1, so
// the field the router reads matches the decision the engine made.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approverFor, isTier1Task } from '../scripts/slack-automation/approvals.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const APPROVALS = read('scripts/slack-automation/approvals.js');
const DISPATCH = read('scripts/agent-dispatch.py');
const FORMAT = read('scripts/agent_email_format.py');

// The real banner, read out of the Python that stamps it — never retyped here.
// A literal copy in the test would keep passing while the two sides drifted,
// which is the exact failure this file is about.
const TIER1_BANNER = (() => {
    const block = FORMAT.match(/TIER1_BANNER = \(([\s\S]*?)\n\)/);
    if (!block) throw new Error('TIER1_BANNER not found in scripts/agent_email_format.py');
    return [...block[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
})();

const micaTask = (extra = {}) => ({
    id: 'recTEST0000000001',
    name: 'Invoice from supplier',
    description: 'Please check this attached statement.',
    notes: '',
    agentOutput: '',
    approverEmail: 'micaa.work@gmail.com',
    ...extra,
});

describe('tier-1 routing (control — the haystack is real)', () => {
    it('the banner parsed out of the Python is the real, whole sentence', () => {
        expect(TIER1_BANNER.length).toBeGreaterThan(80);
        expect(TIER1_BANNER).toContain('TIER 1');
        expect(TIER1_BANNER).toContain('private legal and financial');
    });

    it('an ordinary Mica task really does route to Mica (or nothing below proves anything)', () => {
        const t = micaTask();
        expect(isTier1Task(t)).toBe(false);
        expect(approverFor(t, isTier1Task(t)).key).toBe('mica');
    });
});

describe('THE REGRESSION: agent-discovered tier 1 never reaches Mica', () => {
    it('Approver = Mica + TIER1_BANNER in Agent Output routes to Kevin', () => {
        // The exact shape that would have leaked: nothing tier-1 in the title or
        // the description, the whole signal in what the agent produced.
        const t = micaTask({ agentOutput: `${TIER1_BANNER}\n\nDraft reply to the letter.` });
        expect(isTier1Task(t)).toBe(true);
        expect(approverFor(t, isTier1Task(t)).key).toBe('kevin');
    });

    it('a banner anywhere in the output counts, not only as a prefix', () => {
        const t = micaTask({ agentOutput: `Summary first.\n\n${TIER1_BANNER}\n\nBody.` });
        expect(isTier1Task(t)).toBe(true);
    });

    it('a tier-1 phrase a human added to Notes routes to Kevin', () => {
        const t = micaTask({ notes: '[12 Aug 2026 — Kevin] this is from the solicitor, hold it.' });
        expect(isTier1Task(t)).toBe(true);
        expect(approverFor(t, isTier1Task(t)).key).toBe('kevin');
    });

    it('name and description still classify — the old path is kept, not replaced', () => {
        expect(isTier1Task(micaTask({ name: 'Notice of enforcement received' }))).toBe(true);
        expect(isTier1Task(micaTask({ description: 'Restraint order correspondence' }))).toBe(true);
    });

    it('survives missing fields rather than throwing mid-sweep', () => {
        expect(isTier1Task({})).toBe(false);
        expect(isTier1Task(null)).toBe(false);
    });
});

describe('no routing decision reads name + description alone any more', () => {
    it('the five call sites all go through isTier1Task', () => {
        // The pre-fix expression, in the exact form the original four sites used.
        const old = APPROVALS.match(/isKevinOnlyMatter\(`\$\{t\.name\} \$\{t\.description\}`\)/g) || [];
        expect(old, 'a routing site still reads name + description only').toEqual([]);
        // Calls only — the `function isTier1Task(t)` declaration is not a site.
        // Five since 1 Sep 2026: post, reconcile, reactions, digest lane filter,
        // and the approver resolution inside postPending.
        const routed = APPROVALS.match(/(?<!function )isTier1Task\(t\)/g) || [];
        expect(routed.length, 'every routing site should go through isTier1Task').toBe(5);
    });
});

describe('the two halves of the tier-1 decision agree', () => {
    it('approvals.js carries the same banner string as agent_email_format.py', () => {
        const block = APPROVALS.match(/const TIER1_BANNER =([\s\S]*?);\n/);
        expect(block, 'approvals.js no longer defines TIER1_BANNER').not.toBeNull();
        const js = [...block[1].matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');
        expect(js, 'the worker banner drifted from the Python banner').toBe(TIER1_BANNER);
    });

    it('submit writes Approver = Kevin when the engine decides tier 1', () => {
        // Without this, the engine says tier 1 while the field the router reads
        // still says Mica — two halves of one decision disagreeing.
        expect(DISPATCH).toMatch(/if is_tier1:\s*\n\s*fields\[AF\["approver"\]\] = \{"email": KEVIN_AIRTABLE_EMAIL\}/);
    });

    it('a non-tier-1 submit leaves Approver alone', () => {
        // Inbound Comms sets Approver at creation (label 8 = Mica). Submit must
        // not overwrite that; only a tier-1 finding may move it.
        const submit = DISPATCH.match(/def cmd_submit\(args\):([\s\S]*?)\ndef /)?.[1] ?? '';
        expect(submit.length, 'cmd_submit parse went blind').toBeGreaterThan(500);
        const approverWrites = submit.match(/fields\[AF\["approver"\]\]|AF\["approver"\]:/g) || [];
        expect(approverWrites.length, 'Approver is written outside the tier-1 branch').toBe(1);
    });
});
