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

    it('the runner keeps email content out of the public repo and sweeps leaks via the shared epilogue', () => {
        // The first proof run dumped raw scan output (full bodies) into
        // monitoring/, which the nightly fixer commits. The prompt forbids it
        // and the post-run sweep quarantines. Since 27 Aug 2026 (finding
        // 20260827-phase-2-381) the sweep lives in scripts/slot-postrun.sh,
        // shared by every slot wrapper; the runner hands it this job's leak
        // and failure patterns. Behaviour is covered end to end by
        // tests/slot-postrun.test.js.
        expect(runner).toMatch(/NEVER under the repo/);
        expect(runner).toMatch(/slot-postrun\.sh/);
        // KEY form on both signals (28 Aug 2026). Matching the field NAME
        // anywhere also matched Airtable schema snapshots, where the string is
        // a VALUE — the table merely naming a column — so 69 legitimate daily
        // snapshots were moved out of monitoring/ and each run reported a false
        // failure. The pattern is now handed to the shared epilogue, so the
        // KEY form has to survive the move.
        expect(runner).toMatch(/"body" \*:\|"Inbound Message Content" \*:/);
        // A broken lane (e.g. Full Disk Access denied) must fail the job.
        expect(runner).toMatch(/BROKEN\|Full Disk Access/);
        const postrun = readFileSync(path.join(root, 'scripts/slot-postrun.sh'), 'utf8');
        // Only files THIS run created, never git-tracked ones — the unscoped
        // sweep quarantined 41 committed schema files on 25 Aug 2026.
        expect(postrun).toMatch(/-newer "\$MARKER"/);
        expect(postrun).toMatch(/ls-files --error-unmatch/);
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

describe('an auto-reply never becomes a task (Kevin, 2 Sep 2026)', () => {
    // Four council receipts of emails Kevin had already sent reached his
    // approval gate as tasks between 28 Aug and 1 Sep 2026, via the
    // stranded-mail rescue. The signal lives in the task gate; the scan
    // stamps it, the stranded lists exclude it, act refuses to lane it.
    const gate = readFileSync(path.join(root, 'scripts/create-agent-task.py'), 'utf8');

    it('the gate owns ONE signal and the scan imports it rather than copying it', () => {
        expect(gate).toMatch(/def auto_reply_signal\(headers, subject, body\)/);
        expect(gate).toMatch(/def auto_reply_refusal\(/);
        expect(script).toMatch(/_load_gate\(\)\.auto_reply_signal/);
        expect(script).not.toMatch(/def auto_reply_signal/);
    });

    it('the gate refuses before the board read, exit 3, and only --force overrides it', () => {
        const create = gate.slice(gate.indexOf('def cmd_create('), gate.indexOf('def cmd_check('));
        expect(create.indexOf('auto_reply_refusal(')).toBeGreaterThan(-1);
        expect(create.indexOf('auto_reply_refusal(')).toBeLessThan(create.indexOf('fetch_open_tasks()'));
        expect(create).toMatch(/"action": "refused"/);
        expect(create).toMatch(/return 3/);
    });

    it('a dry-run create of an auto-reply task is refused without touching Airtable', () => {
        const fields = JSON.stringify({ fldgFjGBw6bTKJFCD: 'INBOUND: Automatic reply: Liability Order — 22 Newton Street' });
        let code = 0, out = '';
        try {
            out = execFileSync('python3', [path.join(root, 'scripts/create-agent-task.py'), 'create', '--fields-json', fields, '--dry-run'],
                { encoding: 'utf8', env: { ...process.env, INBOUND_TRIAGE_DIR: '/nonexistent-dir-for-test' } });
        } catch (e) { code = e.status; out = String(e.stdout || ''); }
        expect(code).toBe(3);
        expect(JSON.parse(out.trim().split('\n').pop()).action).toBe('refused');
    });

    it('the scan stamps auto_reply, keeps flagged mail out of every stranded list, and caches the reason', () => {
        const scan = script.slice(script.indexOf('def cmd_scan('), script.indexOf('def cmd_act('));
        expect(scan).toMatch(/annotate_auto_replies\(lst, signal_fn\)/);
        for (const lane of ['stranded_8', 'stranded_12', 'stranded_13']) {
            expect(scan).toMatch(new RegExp(`${lane}, ar\\d+ = split_auto_replies\\(${lane}\\)`));
        }
        expect(scan).toMatch(/"stranded_auto_replies": len\(stranded_auto_replies\)/);
        expect(script).toMatch(/"auto_reply": m\.get\("auto_reply"\) or None/);
    });

    it('act refuses to lane a flagged message; archive and file stay open; an override is logged', () => {
        expect(script).toMatch(/LANE_ACTIONS = \("label12", "label13", "label8"\)/);
        const act = script.slice(script.indexOf('def cmd_act('), script.indexOf('def cmd_note('));
        expect(act.indexOf('act_block_reason(')).toBeLessThan(act.indexOf('worker_post('));
        expect(act).toMatch(/OVERRIDE auto-reply flag/);
    });

    it('the worker exposes the auto-reply headers; the gate rules on auto-submitted alone and never on a bounce', () => {
        for (const h of ['auto-submitted', 'x-auto-response-suppress', 'x-autoreply', 'precedence']) {
            expect(worker, `worker /gmail/list must return ${h}`).toContain(`'${h}'`);
        }
        expect(gate).toMatch(/AUTO_REPLY_DEFINITIVE_HEADER = \("auto-submitted", "auto-replied"\)/);
        // x-auto-response-suppress alone flagged a phishing mail on the live
        // corpus (2 Sep 2026); it is evidence in the digest, never a rule.
        expect(gate).not.toMatch(/SUPPORTING_HEADERS/);
        // A bounce carries auto-replied too, and a bounce IS a task.
        expect(gate).toMatch(/BOUNCE_SENDER_RE/);
        expect(gate).toMatch(/BOUNCE_SUBJECT_RE/);
    });

    it('the skill carries the rule in the judgement step, the stranded step and the report', () => {
        expect(skill).toMatch(/0a\. \*\*An auto-reply never becomes a task/);
        expect(skill).toMatch(/A stranded auto-reply is never a\s+rescue/);
        expect(skill).toMatch(/auto-replies suppressed/);
        expect(skill).toMatch(/--override "<why it is human>"/);
    });
});

describe('"no open task" is not "no task" (Kevin, 2 Sep 2026)', () => {
    // Eight items Kevin had completed were re-created by the stranded rescue
    // because it only looked for OPEN tasks. A thread that has ever had a
    // task is handled; the lookup is any-status and runs inside the scan.
    it('the scan looks up ANY task on each stranded thread and drops the handled ones before the JSON', () => {
        const scan = script.slice(script.indexOf('def cmd_scan('), script.indexOf('def cmd_act('));
        expect(scan).toMatch(/lookup_thread_tasks\(/);
        for (const lane of ['stranded_8', 'stranded_12', 'stranded_13']) {
            expect(scan).toMatch(new RegExp(`${lane}, h\\d+ = split_handled\\(${lane}, thread_map\\)`));
        }
        expect(scan.indexOf('split_handled(')).toBeLessThan(scan.indexOf('write_scan_cache('));
        expect(scan).toMatch(/"stranded_handled": len\(stranded_handled\)/);
    });

    it('the lookup is any-status (no Status filter) and matches both URL forms', () => {
        const fn = script.slice(script.indexOf('def thread_tasks_formula('), script.indexOf('def _airtable_get_raise('));
        expect(fn).not.toMatch(/Status/);
        expect(fn).toContain('#all/');
        expect(fn).toContain('#inbox/');
    });

    it('a failed lookup reads UNCHECKED and leaves the lists untouched, never as "nothing handled"', () => {
        const scan = script.slice(script.indexOf('def cmd_scan('), script.indexOf('def cmd_act('));
        expect(scan).toMatch(/stranded_lookup = "UNCHECKED: %s"/);
        expect(scan).toMatch(/"stranded_lookup": stranded_lookup/);
        expect(script).toMatch(/def _airtable_get_raise\(/);
    });

    it('the skill tells the agent a completed task on the thread means handled, and what to do when UNCHECKED', () => {
        expect(skill).toMatch(/whatever\s+that task's status/);
        expect(skill).toMatch(/stranded_lookup:\s*"UNCHECKED/);
        expect(skill).toMatch(/stranded already-handled/);
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
