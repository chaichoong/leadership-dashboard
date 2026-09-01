// The Task Manager agent is the foreman of the task board: three slots a day
// it reads every open task and forces one move on each stuck one. Regressions
// to fear:
//
//  - the movement maths quietly anchoring on a re-stamped field (Due Date is
//    rolled forward daily by the rescheduler; Last Modified Time is touched
//    by every automation) — every task would then read as "moving" for ever
//    and the agent would report a healthy board while nothing progressed;
//  - the slot job's name colliding with a skill folder, which the one-routine
//    guard (check-routines.py) reads as an illegal second Claude routine;
//  - the wiring drifting apart: the dispatch roster, the follow-up pages'
//    agent set, and the register row identity must all name the same rec ids
//    or routed tasks fall off every surface with no error;
//  - the runner growing a way to write tasks directly instead of through
//    agent-dispatch.py, which would bypass the approval gate and the
//    register's pause lever;
//  - legacy Status=Approval rows (never raised by the loop) counting as
//    "waiting on Kevin", hiding years-old stuck work behind his queue.
//
// Constants are compared against agent-dispatch.py and follow-up.html rather
// than copied, so a rename there fails here.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(path.join(root, 'scripts/task-manager.py'), 'utf8');
const runner = readFileSync(path.join(root, 'scripts/task-manager-run.sh'), 'utf8');
const skill = readFileSync(path.join(root, '.claude/scheduled-tasks/task-manager-board/SKILL.md'), 'utf8');
const dispatch = readFileSync(path.join(root, 'scripts/agent-dispatch.py'), 'utf8');
const followUp = readFileSync(path.join(root, 'follow-up.html'), 'utf8');
const followUpSupabase = readFileSync(path.join(root, 'follow-up-supabase.html'), 'utf8');
const sched = JSON.parse(readFileSync(path.join(root, 'scripts/job-schedule.json'), 'utf8'));
const triageSkill = readFileSync(path.join(root, '.claude/scheduled-tasks/inbound-email-triage/SKILL.md'), 'utf8');
const dailyOpsDoc = readFileSync(path.join(root, 'docs/daily-ops-routine.md'), 'utf8');
const dailyOpsSkill = readFileSync(path.join(root, '.claude/scheduled-tasks/daily-ops/SKILL.md'), 'utf8');

const TASKMGR_TEAM_REC = 'rec1hYELb4zS8pjjO';
const TASKMGR_REGISTER_ROW = 'reczg8BygPFnJMQnh';
const ROY_REC = 'reclbdjfVev3bqNHS';

describe('movement maths never trusts a re-stamped field', () => {
    it('the board read anchors on Activity, Approved At, Slack TS and Created Time only', () => {
        expect(script).toContain('"Approved At"');
        expect(script).toContain('"Approval Slack TS"');
        expect(script).toContain('"Created Time"');
        expect(script).toContain('{At}');
        // Due Date may be displayed but must never feed last_movement.
        const lastMovement = script.slice(script.indexOf('def last_movement'), script.indexOf('def classify'));
        expect(lastMovement).not.toContain('Due Date');
        expect(lastMovement).not.toContain('Last Modified');
    });

    it('legacy Approval rows without Sent For Approval By are stuck, not Kevin\'s queue', () => {
        const classify = script.slice(script.indexOf('def classify'), script.indexOf('def metric_text'));
        expect(classify).toContain('Sent For Approval By');
    });

    it('a zero-task board read fails loudly instead of reporting all-clear', () => {
        expect(script).toMatch(/ZERO open tasks/);
    });

    it('transient approval stamps are population-gated, never per-read controls', () => {
        // Finding 20260825-task-manager-board-365, filed by the agent's own
        // first live run: a clean board holds none of the approval stamps,
        // so requiring them per-read false-positives every slot.
        const control = script.slice(script.indexOf('CONTROL_FIELDS = ['), script.indexOf(']', script.indexOf('CONTROL_FIELDS = [')));
        for (const f of ['Approved At', 'Approval Outcome', 'Approval Slack TS', 'Sent For Approval By']) {
            expect(control).not.toContain(f);
        }
        expect(script).toContain('APPROVAL_STAMP_FIELDS');
        expect(script).toMatch(/approval_rows >= 5/);
    });

    it('the board read paginates (offset followed to the end)', () => {
        const queryAll = script.slice(script.indexOf('def query_all'), script.indexOf('# ---'));
        expect(queryAll).toMatch(/offset = out\.get\("offset"\)/);
    });

    it('selftest passes offline', () => {
        const out = execFileSync('python3', [path.join(root, 'scripts/task-manager.py'), 'selftest'],
            { encoding: 'utf8' });
        expect(out).toContain('selftest OK');
    });
});

describe("the Go Signal is the agent's own 9/1/5 slot job (Kevin, 25 Aug 2026)", () => {
    it('job-schedule carries task-manager at 09:00, 13:00 and 17:00, wrapped', () => {
        expect(sched['task-manager']).toBeDefined();
        expect(sched['task-manager'].cron).toBe('0 9,13,17 * * *');
        expect(sched['task-manager'].mode).toBe('wrapped');
    });

    it('the runner drives the board skill headlessly and cannot write tasks raw', () => {
        expect(runner).toContain('task-manager-board/SKILL.md');
        expect(runner).toContain('claude_oauth_token');
        expect(runner).toMatch(/never a raw Airtable write to a task/i);
        expect(runner).not.toContain('send-email');
    });

    it('the runner keeps task content out of the public repo and sweeps leaks via the shared epilogue', () => {
        expect(runner).toMatch(/NEVER under the repo/);
        // The sweep itself moved to scripts/slot-postrun.sh on 27 Aug 2026
        // (finding 20260827-phase-2-381): the runner must hand it the leak
        // and failure patterns, and the helper must keep the marker scoping
        // and git-tracked exemption. Behaviour is covered end to end by
        // tests/slot-postrun.test.js.
        expect(runner).toMatch(/slot-postrun\.sh/);
        expect(runner).toMatch(/CREDITOR MATTER/);
        expect(runner).toMatch(/VERIFY FAIL/);
        const postrun = readFileSync(path.join(root, 'scripts/slot-postrun.sh'), 'utf8');
        // Only files THIS run created, never git-tracked ones — the triage
        // sweep quarantined 41 committed schema files on 25 Aug 2026.
        expect(postrun).toMatch(/-newer "\$MARKER"/);
        expect(postrun).toMatch(/ls-files --error-unmatch/);
    });

    it('the failure grep is anchored — a count containing 401 is not a failure', () => {
        expect(runner).not.toMatch(/grep -E '401\|/);
        expect(runner).toMatch(/HTTP Error 401\|401 Unauthorized/);
    });

    it('a missing live skill file is a loud failure, not a polite no-op', () => {
        expect(runner).toMatch(/\[ ! -f "\$SKILL" \]/);
        expect(runner).toMatch(/BROKEN: skill file missing/);
    });

    it('the skill folder is task-manager-board, and it is tracked', () => {
        // This used to be the ONLY thing keeping the one-routine guard quiet:
        // the job was named unlike any skill folder, so the guard classified it
        // as a shell job. That made the verdict depend on a filename — renaming
        // this folder to match the job would have made the guard cry stacking
        // every morning over work Kevin had explicitly sanctioned.
        //
        // Since 26 Aug 2026 the sanction is written down instead, in
        // APPROVED_SLOTS in scripts/check-routines.py, with the date of the
        // ruling. The folder name no longer carries any load. The assertion
        // stays because the runner and the skill both reference this path, and
        // a rename would break them.
        expect(existsSync(path.join(root, '.claude/scheduled-tasks/task-manager-board/SKILL.md'))).toBe(true);
    });

    for (const [name, text] of [['versioned doc', dailyOpsDoc], ['repo mirror of the routine', dailyOpsSkill]]) {
        it(`${name} records the fixed-slot ruling for task-manager`, () => {
            expect(text).toContain('com.kevinbrittain.task-manager');
        });
    }
});

describe('the wiring names one identity everywhere', () => {
    it('dispatch ROLE_AGENTS carries the Task Manager team rec', () => {
        expect(dispatch).toContain(`"${TASKMGR_TEAM_REC}": {"name": "AI Task Manager"`);
        // Since the 25 Aug 2026 table refactor the register row lives INSIDE
        // the ROLE_AGENTS entry (single identity source) and the constant is
        // a derived alias — assert both halves of that shape.
        expect(dispatch).toContain(`"registerRow": "${TASKMGR_REGISTER_ROW}"`);
        expect(dispatch).toContain('TASKMGR_REGISTER_ROW = ROLE_AGENTS[TASKMGR_REC_ID]["registerRow"]');
    });

    it('both follow-up pages count the Task Manager as agent-owned', () => {
        for (const page of [followUp, followUpSupabase]) {
            expect(page).toContain(`'${TASKMGR_TEAM_REC}'`);
        }
    });

    it('script, skill and agent file agree on the register row and team rec', () => {
        expect(script).toContain(TASKMGR_REGISTER_ROW);
        expect(script).toContain(TASKMGR_TEAM_REC);
        expect(skill).toContain(TASKMGR_REGISTER_ROW);
        expect(skill).toContain(TASKMGR_TEAM_REC);
    });

    it('Roy is a permitted handover target in dispatch, with the ruling recorded', () => {
        expect(dispatch).toContain('"roy.lavin1978@gmail.com"');
        expect(dispatch).toContain(`"${ROY_REC}"`);
        expect(dispatch).toMatch(/no NEW routing to Mica or Ericamae/);
    });
});

describe('duplicated constants stay in lockstep with their source copies', () => {
    const triageScript = readFileSync(path.join(root, 'scripts/inbound-triage.py'), 'utf8');

    function pyConst(src, name) {
        const m = src.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm'));
        return m && m[1];
    }
    function pyDict(src, name) {
        const start = src.indexOf(`${name} = {`);
        const end = src.indexOf('}', start);
        const body = src.slice(start, end);
        const out = {};
        for (const m of body.matchAll(/"(\w+)":\s*"(fld\w+)"/g)) out[m[1]] = m[2];
        return out;
    }

    it('ALOG, metric field and daily-log table match inbound-triage.py exactly', () => {
        expect(pyDict(script, 'ALOG')).toEqual(pyDict(triageScript, 'ALOG'));
        expect(pyConst(script, 'METRIC_SCORE_FIELD')).toBe(pyConst(triageScript, 'METRIC_SCORE_FIELD'));
        expect(pyConst(script, 'DAILY_LOG_TABLE')).toBe(pyConst(triageScript, 'DAILY_LOG_TABLE'));
    });

    it('Kevin identities match agent-dispatch.py', () => {
        expect(pyConst(script, 'KEVIN_REC')).toBe(pyConst(dispatch, 'KEVIN_REC_ID'));
        expect(dispatch).toContain(`"${pyConst(script, 'KEVIN_EMAIL')}"`);
    });

    it('the daily-log write is the atomic upsert, not find-then-create', () => {
        expect(script).toContain('performUpsert');
        expect(script).toContain('fieldsToMergeOn');
    });
});

describe('handovers to a non-Kevin human are tier-1 gated in code', () => {
    it('cmd_handover refuses tier-1 content without an approved outcome', () => {
        expect(dispatch).toMatch(/refusing handover .*tier-1 content/s);
        const gate = dispatch.slice(dispatch.indexOf('def cmd_handover'), dispatch.indexOf('def cmd_submit'));
        expect(gate).toContain('tier_match(TIER1_PATTERNS');
        expect(gate).toContain('outcome not in APPROVED');
    });
});

describe('the board skill holds the rules that keep the gate in front', () => {
    it('board pass first, one move per stuck task, no Mica/Ericamae routing', () => {
        expect(skill).toMatch(/board pass always completes first/i);
        expect(skill).toMatch(/Never route work to Mica or Ericamae/);
        expect(skill).toContain('agent-dispatch.py');
    });

    it('closes and Roy passes go through the gate; maintenance is standing-approved', () => {
        expect(skill).toContain('CLOSE PROPOSAL');
        expect(skill).toContain('PASS TO ROY');
        expect(skill).toMatch(/standing approval/i);
        expect(skill).toContain('roy.lavin1978@gmail.com');
    });

    it('the closing steps are score, publish, verify — in that order', () => {
        const closing = skill.slice(skill.indexOf('## Step 6'));
        const iScore = closing.indexOf('score --stuck');
        const iPublish = closing.indexOf('task-manager.py publish');
        const iVerify = closing.indexOf('verify --report');
        expect(iScore).toBeGreaterThan(-1);
        expect(iPublish).toBeGreaterThan(iScore);
        expect(iVerify).toBeGreaterThan(iPublish);
    });
});

describe('one open task per thread and lane (Kevin, 25 Aug 2026)', () => {
    it('the board reads the thread link and emits lane-aware duplicate groups', () => {
        expect(script).toContain('"Inbound Note URL Link"');
        expect(script).toContain('def thread_keys');
        expect(script).toContain('def duplicate_groups');
        // Approval twins are untouchable; maintenance and reply lanes never
        // merge; parked and in-flight tasks are never grouped.
        expect(script).toContain('untouchable');
        expect(script).toMatch(/lane = \("maintenance"/);
        expect(script).toMatch(/buckets\["stuck"\] \+ buckets\["moving"\] \+ buckets\["waitingOnKevin"\]/);
    });

    it('the skill closes twins through the gate and never touches the keeper or Approval twins', () => {
        expect(skill).toMatch(/duplicate of <keeper id>/);
        expect(skill).toMatch(/Never close\s+the keeper/);
        expect(skill).toContain('untouchable');
    });
});

describe('label 13 maintenance mail now raises a Roy task (Kevin, 25 Aug 2026)', () => {
    it('the triage skill carries Step 4b with Roy\'s identities', () => {
        expect(triageSkill).toContain('Step 4b');
        expect(triageSkill).toContain(ROY_REC);
        expect(triageSkill).toContain('roy.lavin1978@gmail.com');
    });

    it('lane-13 threads join the thread dedupe, and the inbound flag stays off', () => {
        expect(triageSkill).toMatch(/lane-12 AND lane-13 messages/);
        expect(triageSkill).toMatch(/Do NOT set Inbound Communication Task/);
    });
});

describe("gate cleanse + brain grounding (Kevin's approved extension, 1 Sep 2026)", () => {
    it('the gate lane read is code, paginated, and structurally excludes legacy Approval rows', () => {
        // A hand-rolled single-page fetch is how the recon accuracy card
        // measured 100 of 259 rows; the lane read must go through query_all.
        const gate = script.slice(script.indexOf('GATE_FORMULA'), script.indexOf('def cmd_note'));
        expect(gate).toContain('query_all');
        expect(gate).not.toContain('urllib.request.urlopen');
        // Legacy rows (4 Aug 2026 lesson) are excluded IN THE FORMULA, so the
        // cleanse can never sweep them however the judgement drifts.
        expect(script).toMatch(/GATE_FORMULA = "AND\(\{Status\}='Approval', LEN\(\{Sent For Approval By\}&''\)>0\)"/);
    });

    it('a zero lane alongside a populated Approval status fails loudly (drifted-formula control)', () => {
        const gate = script.slice(script.indexOf('def cmd_gate'), script.indexOf('def cmd_note'));
        expect(gate).toMatch(/gate control read/);
        expect(gate).toMatch(/len\(status_only\) >= 5/);
        expect(gate).toMatch(/fail\(/);
    });

    it('lane age anchors on Slack TS then Created Time, never a re-stamped field', () => {
        const laneView = script.slice(script.indexOf('def lane_view'), script.indexOf('# ---', script.indexOf('def lane_view')));
        expect(laneView).toContain('Approval Slack TS');
        expect(laneView).toContain('Created Time');
        expect(laneView).not.toContain('Due Date');
        expect(laneView).not.toContain('Last Modified');
        expect(laneView).not.toMatch(/"Approved At"/);
    });

    it('the cleanse preserves the original submission and is capped, aged, and audited', () => {
        // dispatch submit REPLACES Agent Output wholesale, so the skill must
        // prepend the proposal above the preserved original.
        expect(skill).toMatch(/ORIGINAL SUBMISSION \(preserved\)/);
        expect(skill).toMatch(/at most 25 cleanse proposals per pass/i);
        expect(skill).toMatch(/younger than 48 hours/);
        expect(skill).toMatch(/never removed silently|Nothing is ever removed silently/i);
        // Cleanse proposals join the CEO review batch like every other close.
        expect(skill).toMatch(/step 2 or the step 2b cleanse/);
    });

    it('step 3b reads the same coded lane, not its own raw curl formula', () => {
        const step3b = skill.slice(skill.indexOf('Step 3b'), skill.indexOf('Step 4'));
        expect(step3b).toContain('gate.json');
        expect(step3b).not.toMatch(/curl|api\.airtable\.com/);
    });

    it('brain grounding probes by reading a byte and reports UNCHECKED, never silence', () => {
        expect(skill).toMatch(/Step 1c/);
        expect(skill).toMatch(/READING A BYTE/);
        expect(skill).toMatch(/brain UNCHECKED/);
        expect(skill).toMatch(/never a quiet "no rulings"/i);
    });

    it('the report leads gate health with size and median age', () => {
        expect(skill).toMatch(/median age in hours/);
        expect(script).toContain('medianAgeHours');
    });
});

describe('skill paths never depend on the cwd (1 Sep 2026: repo-root report leak)', () => {
  it('the skill only uses the variables the runner actually exports', () => {
    // $LOG_DIR and $SCRATCH are unset in the agent shell — a write through
    // them lands in the cwd, which the wrapper sets to the PUBLIC repo.
    expect(skill).not.toMatch(/\$LOG_DIR\b/);
    expect(skill).not.toMatch(/\$\{?SCRATCH\b/);
    expect(runner).toMatch(/export TASK_MANAGER_SCRATCH=/);
    expect(runner).toMatch(/export TASK_MANAGER_LOG_DIR=/);
    expect(skill).toContain('$TASK_MANAGER_LOG_DIR/report-');
  });

  it('every skill redirect targets the scratch dir by absolute path', () => {
    expect(skill).toMatch(/gate > "\$TASK_MANAGER_SCRATCH\/gate\.json"/);
    expect(skill).toMatch(/queue > "\$TASK_MANAGER_SCRATCH\/dispatch-queue\.json"/);
    expect(skill).toMatch(/> "\$TASK_MANAGER_SCRATCH\/board\.json"/);
    expect(skill).not.toMatch(/> (?:gate|board|dispatch-queue|report)[-.\w]*\.json/);
  });

  it('the shared epilogue sweeps the repo top level, not only monitoring/', () => {
    const postrun = readFileSync(path.join(root, 'scripts/slot-postrun.sh'), 'utf8');
    expect(postrun).toMatch(/-maxdepth 1 -type f -newer/);
    expect(postrun).toMatch(/report\*\|board\*\.json\|gate\*\.json\|dispatch-queue\*\.json/);
  });
});
