// The Inbound Comms Triage agent sorts Kevin's inbox every morning and turns
// actionable email into agent-routed tasks. Three regressions to fear:
//
//  - the skill's task shape drifting away from what the Inbound Comms page
//    and the dispatch engine expect (a human assigned again, the wrong
//    approver, a dedupe key format the page cannot see) — inbound mail would
//    then double-task or fall off the agent queue with no error;
//  - the triage plumbing growing a way to SEND or DELETE — this agent is
//    triage-only by Kevin's ruling, and the worker guard is what enforces it;
//  - the daily Go Signal falling out of the daily-ops sequence, or drifting
//    to run AFTER agent-dispatch so the tasks it creates sit a full day
//    before any agent picks them up.
//
// Constants are compared against follow-up.html (the routing's source of
// truth) rather than copied, so a rename there fails here.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = readFileSync(path.join(root, '.claude/scheduled-tasks/inbound-email-triage/SKILL.md'), 'utf8');
const dailyOps = readFileSync(path.join(root, '.claude/scheduled-tasks/daily-ops/SKILL.md'), 'utf8');
const dailyOpsDoc = readFileSync(path.join(root, 'docs/daily-ops-routine.md'), 'utf8');
const followUp = readFileSync(path.join(root, 'follow-up.html'), 'utf8');
const worker = readFileSync(path.join(root, 'workers/drive-upload/worker.js'), 'utf8');
const script = readFileSync(path.join(root, 'scripts/inbound-triage.py'), 'utf8');

function fromFollowUp(pattern, label) {
    const m = followUp.match(pattern);
    if (!m) throw new Error(`follow-up.html no longer defines ${label} — routing source of truth moved`);
    return m[1];
}

describe('task shape matches the routing source of truth (follow-up.html)', () => {
    it('routes to the AI CEO as Team Member, with no Assignee', () => {
        expect(skill).toContain('reciHUAEcEkbctnZ6');   // AI CEO Team Members row
        expect(skill).toContain('flduCtmQGpOA4eWaj');   // Team Member field
        expect(skill).toMatch(/NO Assignee/);
    });

    it('approver ids for each lane match the page constants', () => {
        const mica = fromFollowUp(/AIRTABLE_ASSIGNEE_DEFAULT = '(usr\w+)'/, 'Mica collaborator id');
        const kevin = fromFollowUp(/AIRTABLE_ASSIGNEE_KEVIN = '(usr\w+)'/, 'Kevin collaborator id');
        const approver = fromFollowUp(/AIRTABLE_APPROVER_FIELD = '(fld\w+)'/, 'Approver field id');
        expect(skill).toContain(mica);
        expect(skill).toContain(kevin);
        expect(skill).toContain(approver);
        // Lane 8 is Mica's, lane 12 is Kevin's — the skill must pair them
        // the same way round as getApproverForLabel does.
        expect(skill).toMatch(new RegExp(`lane 8[^\\n]*${mica}`, 'i'));
        expect(skill).toMatch(new RegExp(`lane 12[^\\n]*${kevin}`, 'i'));
    });

    it('creates the CURRENT #all/ dedupe key and matches both forms on read', () => {
        // The page writes #all/ links (they survive archiving); its dedupe
        // reads #all/ and legacy #inbox/. The skill must do the same or
        // page-created and triage-created tasks stop seeing each other.
        expect(followUp).toContain("'https://mail.google.com/mail/u/0/#all/' + email.threadId");
        expect(skill).toContain('https://mail.google.com/mail/u/0/#all/{threadId}');
        expect(skill).toMatch(/FIND\("#all\/\{threadId\}"/);
        expect(skill).toMatch(/FIND\("#inbox\/\{threadId\}"/);
        expect(skill).toContain('fldXf1p0vtHqOZcKl');
    });

    it('keeps the tier-1 rule: always Kevin, prepare only', () => {
        expect(skill).toMatch(/[Tt]ier-1[^\n]*(always Kevin|Kevin's lane)/);
        expect(skill).toMatch(/PREPARED only/);
    });
});

describe('triage stays triage-only', () => {
    it('worker /gmail/modify refuses SPAM and TRASH and never exposes a send path', () => {
        expect(worker).toMatch(/Refusing to add \$\{name\}/);
        expect(worker).toMatch(/SPAM\|TRASH/);
        // The triage route block must not reach the send handler's helpers.
        const triageBlock = worker.slice(worker.indexOf("'/gmail/labels'"), worker.indexOf('const allowOrigin'));
        expect(triageBlock).not.toContain('buildRawEmail');
        expect(triageBlock).not.toContain('/messages/send');
    });

    it('gmail.modify scope is requested at consent (without it every triage call 403s)', () => {
        expect(worker).toContain('https://www.googleapis.com/auth/gmail.modify');
    });

    it('the script only ever calls the three read/label endpoints', () => {
        const endpoints = [...script.matchAll(/worker_post\("([^"]+)"/g)].map(m => m[1]);
        expect(endpoints.length).toBeGreaterThan(0);
        const allowed = new Set(['/gmail/labels', '/gmail/list', '/gmail/modify']);
        for (const e of endpoints) expect(allowed.has(e), `unexpected worker endpoint ${e}`).toBe(true);
        // No raw Gmail API or send-path fallback outside the worker.
        expect(script).not.toContain('gmail.googleapis.com');
        expect(script).not.toContain('/send-email');
    });

    it('the skill forbids archiving human mail without a task', () => {
        expect(skill).toMatch(/NEVER archive an email written by a human/i);
    });
});

describe('the daily Go Signal is wired', () => {
    for (const [name, text] of [['deployed routine', dailyOps], ['versioned doc', dailyOpsDoc]]) {
        it(`${name} runs inbound-email-triage before agent-dispatch`, () => {
            const triageAt = text.indexOf('inbound-email-triage/SKILL.md');
            const dispatchAt = text.indexOf('agent-dispatch/SKILL.md');
            expect(triageAt).toBeGreaterThan(-1);
            expect(dispatchAt).toBeGreaterThan(-1);
            expect(triageAt).toBeLessThan(dispatchAt);
        });
    }
});

describe('inbound-triage.py mechanics', () => {
    it('offline selftest passes (labels, metric string, watermark rules, digest)', () => {
        const out = execFileSync('python3', [path.join(root, 'scripts/inbound-triage.py'), 'selftest'], { encoding: 'utf8' });
        expect(out).toMatch(/selftest OK/);
    });

    it('writes its Metric Score to its own register row', () => {
        expect(script).toContain('recYy33zkoa099uM2');
        expect(script).toContain('fldkGxrOlrfuLlH3J');
    });
});
