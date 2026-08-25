// The Inbound Comms Triage agent sorts Kevin's inbox every morning and turns
// actionable email into agent-routed tasks. Regressions to fear:
//
//  - the skill's task shape drifting away from what the Inbound Comms page
//    and the dispatch engine expect (a human assigned again, an approver
//    other than Kevin creeping back in, a dedupe key format the page cannot
//    see) — inbound mail would then double-task or fall off the agent queue
//    with no error;
//  - the triage plumbing growing a way to SEND or DELETE — this agent is
//    triage-only by Kevin's ruling, enforced by a separate read/label-only
//    key and worker-side SPAM/TRASH refusal;
//  - truncation dishonesty: Gmail lists newest-first, so a capped listing
//    plus a blindly-advanced watermark silently loses the OLDEST mail for
//    ever (the review's critical finding) — the pagination plumbing and the
//    frozen-on-truncation watermark rule are what prevent it;
//  - the daily Go Signal falling out of the daily-ops sequence, or drifting
//    to run AFTER agent-dispatch so the tasks it creates sit a full day
//    before any agent picks them up.
//
// Constants are compared against follow-up.html (the routing's source of
// truth) rather than copied, so a rename there fails here.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
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
// The agents panel (Daily decisions) moved from os/systemisation to the
// Leadership → AI Agents page on 25 Aug 2026.
const agentsPage = readFileSync(path.join(root, 'os/agents/index.html'), 'utf8');

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

    it("Kevin is the only approver the skill ever writes (his ruling, 24 Aug 2026)", () => {
        const mica = fromFollowUp(/AIRTABLE_ASSIGNEE_DEFAULT = '(usr\w+)'/, 'Mica collaborator id');
        const kevin = fromFollowUp(/AIRTABLE_ASSIGNEE_KEVIN = '(usr\w+)'/, 'Kevin collaborator id');
        const approver = fromFollowUp(/AIRTABLE_APPROVER_FIELD = '(fld\w+)'/, 'Approver field id');
        expect(skill).toContain(kevin);
        expect(skill).toContain(approver);
        // Nothing the triage agent creates routes to Mica's approval, and the
        // script refuses label8 as a destination outright.
        expect(skill).not.toContain(mica);
        expect(script).toMatch(/label8 is not a triage destination/);
    });

    it('creates the CURRENT #all/ dedupe key, matches both forms, one task per thread', () => {
        // The page writes #all/ links (they survive archiving); its dedupe
        // reads #all/ and legacy #inbox/. The skill must do the same or
        // page-created and triage-created tasks stop seeing each other.
        expect(followUp).toContain("'https://mail.google.com/mail/u/0/#all/' + email.threadId");
        expect(skill).toContain('https://mail.google.com/mail/u/0/#all/{threadId}');
        expect(skill).toMatch(/FIND\("#all\/\{threadId\}"/);
        expect(skill).toMatch(/FIND\("#inbox\/\{threadId\}"/);
        expect(skill).toContain('fldXf1p0vtHqOZcKl');
        // Two overnight messages in one thread must not become two tasks.
        expect(skill).toMatch(/one thread = one task/i);
    });

    it('keeps the tier-1 rule and the email-typed sender field', () => {
        expect(skill).toMatch(/PREPARED only/);
        expect(skill).toMatch(/BARE email address/);
    });
});

describe('triage stays triage-only', () => {
    it('the /gmail/* gate uses its own read/label key, never the send key', () => {
        const triageBlock = worker.slice(worker.indexOf("'/gmail/labels'"), worker.indexOf('const allowOrigin'));
        expect(triageBlock).toContain('GMAIL_TRIAGE_KEY');
        expect(triageBlock).not.toContain('GMAIL_SEND_KEY');
        expect(triageBlock).not.toContain('buildRawEmail');
        expect(triageBlock).not.toContain('/messages/send');
    });

    it('worker /gmail/modify refuses SPAM and TRASH', () => {
        expect(worker).toMatch(/Refusing to add \$\{name\}/);
        expect(worker).toMatch(/SPAM\|TRASH/);
    });

    it('gmail.modify scope is requested at consent (without it every triage call 403s)', () => {
        expect(worker).toContain('https://www.googleapis.com/auth/gmail.modify');
    });

    it('the script only ever calls the three read/label endpoints, with its own key', () => {
        const endpoints = [...script.matchAll(/worker_post\("([^"]+)"/g)].map(m => m[1]);
        expect(endpoints.length).toBeGreaterThan(0);
        const allowed = new Set(['/gmail/labels', '/gmail/list', '/gmail/modify']);
        for (const e of endpoints) expect(allowed.has(e), `unexpected worker endpoint ${e}`).toBe(true);
        expect(script).toContain('gmail_triage_key');
        expect(script).not.toContain('gmail_send_key');
        // No raw Gmail API or send-path fallback outside the worker.
        expect(script).not.toContain('gmail.googleapis.com');
        expect(script).not.toContain('/send-email');
    });

    it('email text never rides on a command line — act/note take ids and own-words reasons only', () => {
        expect(script).not.toMatch(/--sender|--subject/);
        expect(script).toContain('read_scan_cache');
        expect(skill).toMatch(/never text copied from the email/i);
    });


    it('targets the business mailbox and enforces the file-label allowlist', () => {
        expect(script).toContain('kevin@runpreneur.org.uk');
        expect(script).toMatch(/payload\.setdefault\("account", TRIAGE_ACCOUNT\)/);
        const allow = script.match(/FILE_LABEL_ALLOW = \{([^}]+)\}/)[1];
        for (const banned of ['"7"', '"9"', '"14"']) expect(allow).not.toContain(banned);
        expect(skill).toMatch(/NEVER APPLY.*7 "delete"/s);
    });

    it('the skill forbids archiving human mail without a task', () => {
        expect(skill).toMatch(/NEVER archive an email written by\s+a human/i);
    });
});

describe('truncation honesty (the critical finding)', () => {
    it('the worker paginates: pageToken in, nextPageToken out', () => {
        expect(worker).toMatch(/pageToken/);
        expect(worker).toMatch(/nextPageToken: nextPageToken \|\| null/);
    });

    it('the script follows pages, reports truncated, and the scan exposes the flags', () => {
        expect(script).toMatch(/MAX_PAGES/);
        expect(script).toMatch(/"truncated"/);
    });

    it('the watermark freezes on truncation (selftest-backed) and the skill forbids advancing', () => {
        expect(script).toMatch(/def next_watermark\(max_ms, unhandled_ms_list, truncated=False/);
        expect(skill).toMatch(/truncated.*do NOT advance the\s+watermark/is);
        // And the freeze is enforced in code, not just instructed.
        expect(script).toMatch(/refusing to advance the watermark/);
    });

    it('stranded lookups use exact label ids, not label: query syntax, with a first-run control', () => {
        expect(script).toMatch(/label_ids=\[l8\["id"\]\]/);
        expect(script).toMatch(/label_ids=\[l12\["id"\]\]/);
        expect(script).not.toMatch(/label:%s/);
        expect(skill).toMatch(/FIRST-RUN PROOF/);
    });
});

describe('sent mail is measured; threads update, never duplicate (Kevin, 25 Aug 2026)', () => {
    it('the scan reads in:sent and emits the per-thread latest-sent map', () => {
        expect(script).toContain('in:sent');
        expect(script).toContain('sent_threads');
    });

    it('the note taxonomy carries updated and answered', () => {
        expect(script).toContain('"updated"');
        expect(script).toContain('"answered"');
    });

    it('a dedupe hit updates the existing task; approval-loop tasks are never reopened', () => {
        expect(skill).toMatch(/UPDATE it — never a twin/);
        expect(skill).toMatch(/NEVER reopen it/);
        expect(skill).toContain('INBOUND (follow-up):');
    });

    it('the email sent-check closes what Kevin answered himself, with a control and an honest note', () => {
        expect(skill).toContain('Step 2c');
        expect(skill).toMatch(/Closed by inbound-email-triage/);
        expect(skill).toMatch(/Not verified: whether his reply covered everything/);
        expect(skill).toMatch(/broken query must never\s+read as\s+"nothing to close"/);
        // Review findings, 25 Aug 2026: never cancel the approval loop's
        // work, never trust the scan window over the task's own stamps,
        // never decide a close from a truncated sent listing.
        expect(skill).toMatch(/\{Status\}!='Approval', LEN\(\{Approval Outcome\}&''\)=0/);
        expect(skill).toMatch(/Do NOT test against this\s+scan's inbox lists/);
        expect(skill).toMatch(/truncated\.sent: true`?, SKIP/);
    });

    it('every reopen path clears Completion Date in the same PATCH', () => {
        expect(skill).toMatch(/Completion Date `fldFOi1SwEKuJRmdN`\s+set to null IN THE SAME PATCH/);
    });
});

describe("the Go Signal is the agent's own 9/1/5 schedule (Kevin, 24 Aug 2026)", () => {
    const sched = JSON.parse(readFileSync(path.join(root, 'scripts/job-schedule.json'), 'utf8'));
    const runner = readFileSync(path.join(root, 'scripts/inbound-triage-run.sh'), 'utf8');

    it('job-schedule carries inbound-triage at 09:00, 13:00 and 17:00, wrapped', () => {
        expect(sched['inbound-triage']).toBeDefined();
        expect(sched['inbound-triage'].cron).toBe('0 9,13,17 * * *');
        expect(sched['inbound-triage'].mode).toBe('wrapped');
    });

    it('the runner drives both lanes plus dispatch, headlessly, and cannot send', () => {
        expect(runner).toContain('inbound-email-triage/SKILL.md');
        expect(runner).toContain('inbound-messages-sweep/SKILL.md');
        expect(runner).toContain('agent-dispatch/SKILL.md');
        expect(runner).toContain('claude_oauth_token');
        expect(runner).not.toContain('send-email');
    });

    it('the runner pre-reads chat.db before claude starts (FDA attaches to the job root)', () => {
        // Proven by launchd probe, 24 Aug 2026: python3-rooted jobs hold the
        // Messages permission; the claude binary does not (and its path
        // changes every update). The dumps are the sweep's data in the slots.
        expect(runner).toMatch(/imessage-sweep\.py" scan > "\$SCRATCH\/imessage-scan\.json/);
        expect(runner).toMatch(/sentdump --since-hours \d+ > "\$SCRATCH\/imessage-sent\.json/);
        const sweepSkill = readFileSync(path.join(root, '.claude/scheduled-tasks/inbound-messages-sweep/SKILL.md'), 'utf8');
        expect(sweepSkill).toContain('imessage-scan.json');
        expect(sweepSkill).toContain('imessage-sent.json');
        const sweepScript = readFileSync(path.join(root, 'scripts/imessage-sweep.py'), 'utf8');
        expect(sweepScript).toContain('def sent_dump');
    });

    it('the runner keeps email content out of the public repo and fails loudly on leaks', () => {
        // The first proof run dumped raw scan output (full bodies) into
        // monitoring/, which the nightly fixer commits. The prompt forbids it
        // and the post-run sweep quarantines + fails.
        expect(runner).toMatch(/NEVER under the repo/);
        expect(runner).toMatch(/"body":\|Inbound Message Content/);
        expect(runner).toMatch(/__LEAKED/);
        // Only files THIS run created, never git-tracked ones — the unscoped
        // sweep quarantined 41 committed schema files on 25 Aug 2026.
        expect(runner).toMatch(/-newer "\$__MARKER"/);
        expect(runner).toMatch(/ls-files --error-unmatch/);
        // A broken lane (e.g. Full Disk Access denied) must fail the job.
        expect(runner).toMatch(/BROKEN\|Full Disk Access/);
    });

    it('the job name is NOT a skill folder, so the one-routine guard stays quiet', () => {
        // check-routines.py treats any queue event whose name matches a
        // ~/.claude/scheduled-tasks folder as a second Claude routine.
        expect(existsSync(path.join(root, '.claude/scheduled-tasks/inbound-triage'))).toBe(false);
    });

    // Both are REPO copies: the mirror the drift check syncs live at deploy,
    // and the versioned doc.
    for (const [name, text] of [['repo mirror of the routine', dailyOps], ['versioned doc', dailyOpsDoc]]) {
        it(`${name} no longer runs the triage lanes as phases, and records why`, () => {
            expect(text).not.toMatch(/^\d+\. `~\/\.claude\/scheduled-tasks\/inbound-(email-triage|messages-sweep)/m);
            expect(text).toContain('com.kevinbrittain.inbound-triage');
        });
    }
});

describe('the daily decisions log reaches the agent record', () => {
    it('script and panel agree on the AI Agent Daily Log table id', () => {
        const m = script.match(/DAILY_LOG_TABLE = "(tbl\w+)"/);
        expect(m).not.toBeNull();
        expect(agentsPage).toContain(m[1]);
    });

    it('the skill publishes after scoring, non-fatally', () => {
        expect(skill).toMatch(/inbound-triage\.py publish/);
        expect(skill).toMatch(/must never\s+block/i);
    });

    it('the panel renders a Daily decisions section', () => {
        expect(agentsPage).toContain('Daily decisions');
        expect(agentsPage).toContain('loadDailyLogs');
    });
});

describe('inbound-triage.py mechanics', () => {
    it('offline selftest passes (labels, bare-email parse, metric string, watermark rules, cache, digest)', () => {
        const out = execFileSync('python3', [path.join(root, 'scripts/inbound-triage.py'), 'selftest'], { encoding: 'utf8' });
        expect(out).toMatch(/selftest OK/);
    });

    it('writes its Metric Score to its own register row', () => {
        expect(script).toContain('recYy33zkoa099uM2');
        expect(script).toContain('fldkGxrOlrfuLlH3J');
    });
});
