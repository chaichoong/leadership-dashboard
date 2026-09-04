// Kevin has to understand what an agent wants to do as if he were thirteen,
// and he has to know which address an email will leave from.
//
// Live examples that failed that bar on 26 Aug 2026, read off his own queue:
//   "sending the Swinton and Premium Credit emails via scripts/send-email.py,
//    updating the Virgin Media cost record in Airtable to £40.36"
//   "this letter being posted or emailed to Fylde Council revenues"
// The first names a script he will never run. The second is a sentence
// fragment, because the stored line CONTINUES the stem "Carrying this out
// will involve:" and the card showed only the tail.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(__dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const PAGE = read('os/agents/index.html');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

const runPy = (expr, arg) => JSON.parse(execFileSync('python3', ['-c', `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("d", ${JSON.stringify(DISPATCH)})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
arg = json.loads(sys.argv[1]) if len(sys.argv) > 1 else None
print(json.dumps(${expr}))`, ...(arg === undefined ? [] : [JSON.stringify(arg)])], { encoding: 'utf8' }));

const body = 'x'.repeat(400) + '\n\n**Carrying this out will involve:** ';

describe('the action line has to be plain English', () => {
  it('refuses a script path, a filename and a record id', () => {
    const cases = {
      script: body + 'sending the emails via scripts/send-email.py',
      filename: body + 'running update.py against the cost records',
      recordId: body + 'updating the Creditor Plans row recDvxwDGcC3pFbPa',   // a real 17-char id
    };
    const out = runPy('{k: mod.carry_out_problem(v) for k, v in arg.items()}', cases);
    for (const [k, problem] of Object.entries(out)) {
      expect(problem, `${k} should be refused`).not.toBe('');
      expect(problem).toMatch(/thirteen-year-old/);
    }
  });

  it('accepts the same actions written for a person', () => {
    const cases = {
      email: body + 'sending the email to Fylde Council about the council tax arrears',
      money: body + 'updating what we think the Virgin Media bill costs to £40.36',
      letter: body + 'posting the signed letter of authority to the creditor',
      // FALSE POSITIVES ARE THE DANGER: this rule blocks submission, so a
      // wrongly-refused line means work never reaches Kevin at all. Each of
      // these is ordinary English that an earlier draft of the regex refused.
      transcript: body + 'adding the transcript/summary of the call to the brain',
      shDomain: body + 'emailing the landlord at info@a.sh about the boiler',
      apiWord: body + 'signing up to the Companies House API service',
      patchWord: body + 'sending a patch of the fence before winter',
    };
    // DELIBERATE GAP, recorded so nobody "fixes" it: bare API/PATCH/endpoint
    // words are NOT blocked. "the Companies House API service" and "a patch of
    // the fence" are ordinary English here, and the two errors are not equal —
    // a false refusal stops work reaching Kevin at all, while a missed bit of
    // jargon costs one unclear card he can send back. Prefer letting it through.
    const out = runPy('{k: mod.carry_out_problem(v) for k, v in arg.items()}', cases);
    for (const [k, problem] of Object.entries(out)) expect(problem, k).toBe('');
    expect(runPy('mod.carry_out_problem(arg)', body + 'a PATCH to the Airtable endpoint'))
      .toBe('');   // the recorded gap above
  });

  it('reads the LAST marker, so a body that MENTIONS the phrase is not policed', () => {
    // strip_carry_out_line and send_promise_problem both take the last match;
    // taking the first meant an output explaining the rule to itself had its
    // whole working scanned and was refused for a closing line that was fine.
    const mentions = 'I was told to end with a Carrying this out will involve: line. '
      + 'I read scripts/send-email.py and checked row recDvxwDGcC3pFbPa. '.repeat(6)
      + '\n\n**Carrying this out will involve:** sending the reply to the council';
    expect(runPy('mod.carry_out_problem(arg)', mentions)).toBe('');
  });

  it('revise does NOT apply the rule — that text is already approved', () => {
    // A plain-English rule added later must not strand an approved edit on a
    // task submitted before it existed.
    const legacy = body + 'sending the emails via scripts/send-email.py';
    expect(runPy('mod.carry_out_problem(arg)', legacy)).not.toBe('');
    expect(runPy('mod.carry_out_problem(arg, strict=False)', legacy)).toBe('');
    expect(read('scripts/agent-dispatch.py')).toMatch(/carry_out_problem\(revised, strict=False\)/);
  });

  it('only the CLOSING line is policed — the body may show its working', () => {
    // An agent explaining HOW it checked something is exactly what the body
    // is for; refusing technical detail there would make the work unreadable.
    const technicalBody = 'I read scripts/create-agent-task.py and queried the '
      + 'Tasks table with filterByFormula.'.repeat(8)
      + '\n\n**Carrying this out will involve:** sending the reply to the council';
    expect(runPy('mod.carry_out_problem(arg)', technicalBody)).toBe('');
  });

  it('the card shows the line as a sentence, not a fragment', () => {
    expect(PAGE).toMatch(/If you approve, this happens:/);
  });

  it('the stem appears ONLY when the summary really is the action line', () => {
    // apvSummary also falls back to a TO/SUBJECT pair and to the first line of
    // the document. "If you approve, this happens: Dear Sir/Madam" would be
    // asserting a consequence about a salutation.
    const fn = new Function(
      PAGE.match(/const APV_SUMMARY_IS_ACTION[\s\S]*?\n\}/)[0] + '; return apvSummary;')();
    const long = 'x'.repeat(400);
    expect(fn(long + '\n\n**Carrying this out will involve:** sending the reply'))
      .toMatch(/\u0000action$/);
    expect(fn(long + '\nTO: a@b.com\nSUBJECT: hello')).not.toMatch(/\u0000action$/);
    expect(PAGE).toMatch(/isAction \? `<span class="apv-ask-stem">/);
  });
});

describe('an email draft says which address it sends from', () => {
  const from = new Function(PAGE.match(/const APV_DEFAULT_SENDER[\s\S]*?\n\}/)[0] + '; return apvEmailFrom;')();

  it('shows the chosen sender', () => {
    expect(from('TO: a@b.com\nFROM: kevin@operationsdirector.co.uk\nSUBJECT: s\n---\nbody'))
      .toMatchObject({ from: 'kevin@operationsdirector.co.uk', isDefault: false });
  });

  it('does NOT promise the default when the copy speaks as the business', () => {
    // send-email.py REFUSES that exact combination, so naming the personal
    // default would promise Kevin a send that cannot happen.
    const r = from('TO: a@b.com\nSUBJECT: hello\n---\nYou booked a call with Operations Director');
    expect(r.blocked).toBe(true);
    expect(r.from).toBe('');
    // The page's brand test must stay in step with the sender's. Read the
    // pattern from the ONE place it is defined rather than repeating it here,
    // so changing the pattern cannot leave this assertion behind.
    //
    // Rewritten 4 Sep 2026. This used to assert the pattern literal appeared
    // in scripts/send-email.py, which quietly REQUIRED that file to keep its
    // own copy of the regex — the test was holding the duplication in place.
    // send-email.py now imports BUSINESS_BRAND_RE, so what it must prove is
    // that it imports rather than redefines.
    const fmt = read('scripts/agent_email_format.py');
    const brand = fmt.match(/BUSINESS_BRAND_RE = re\.compile\(\s*r"([^"]+)"/);
    expect(brand, 'CONTROL: BUSINESS_BRAND_RE moved or changed shape').toBeTruthy();

    const send = read('scripts/send-email.py');
    expect(send, 'send-email.py defines its own brand regex again').not.toMatch(/BUSINESS_BRAND\w* = re\.compile/);
    expect(send, 'send-email.py no longer imports the shared brand regex').toMatch(/BUSINESS_BRAND_RE/);

    // The page cannot import Python, so its copy is a deliberate mirror, and
    // this is what keeps the two in step.
    expect(PAGE, 'the page brand test drifted from the sender rule').toContain(brand[1]);
  });

  it('a four-dash divider still separates headers from body', () => {
    // agent_email_format.py partitions on the SUBSTRING "---", so "----" is a
    // header break there; a stricter split here let a FROM quoted in the body
    // pose as the sender.
    expect(from('TO: a@b.com\nSUBJECT: s\n----\nFROM: spoof@evil.com').from)
      .toBe('kevinbrittain@gmail.com');
  });

  it('the row is shown for Correspondence only', () => {
    expect(PAGE).toMatch(/t\.taskType !== 'Correspondence'/);
  });

  it('names the DEFAULT when the agent chose none, rather than showing nothing', () => {
    // FROM is optional in the Agent Output contract and send-email.py falls
    // back to Kevin's personal Gmail — the difference between writing as
    // himself and writing as Operations Director, previously invisible.
    const r = from('TO: a@b.com\nSUBJECT: s\n---\nbody');
    expect(r).toMatchObject({ from: 'kevinbrittain@gmail.com', isDefault: true });
    expect(read('scripts/send-email.py')).toContain('kevinbrittain@gmail.com');
  });

  it('reads headers only, so a FROM in the body cannot pose as the sender', () => {
    expect(from('TO: a@b.com\nSUBJECT: s\n---\nFROM: spoof@evil.com').from)
      .toBe('kevinbrittain@gmail.com');
  });

  it('says nothing at all when the work is not an email', () => {
    expect(from('# A report\n\nSome analysis.')).toBeNull();
  });
});

describe('a task can go back to the CEO to be reassigned', () => {
  const src = read('scripts/agent-dispatch.py');

  it('reassign exists and route still refuses the CEO', () => {
    expect(src).toMatch(/def cmd_reassign/);
    expect(src).toMatch(/"reassign": cmd_reassign/);
    // Routing is the CEO handing work DOWN; pointing it back up was a loop.
    expect(src).toMatch(/routing back to the CEO is not a route/);
  });

  it('clears the stale approval state so the next agent is judged on its own work', () => {
    const fn = src.slice(src.indexOf('def cmd_reassign'), src.indexOf('def cmd_escalate'));
    expect(fn).toMatch(/AF\["teamMember"\]: \[CEO_REC_ID\]/);
    expect(fn).toMatch(/AF\["approvalOutcome"\]: None/);
    expect(fn).toMatch(/AF\["sentForApprovalBy"\]: \[\]/);
    expect(fn).toMatch(/AF\["status"\]: "Today"/);   // back in the queue the CEO reads
  });

  it('stops after a limited number of bounces rather than looping for ever', () => {
    const fn = src.slice(src.indexOf('def cmd_reassign'), src.indexOf('def cmd_escalate'));
    expect(fn).toMatch(/bounces >= REASSIGN_MAX/);
    expect(fn).toMatch(/escalate/);
    expect(src).toMatch(/REASSIGN_MAX = 2/);
  });

  it('counts only its OWN stamped lines, so a reason quoting the marker cannot lock a task out', () => {
    const counts = runPy('{k: mod.reassign_bounces(v) for k, v in arg.items()}', {
      genuine: '[2026-08-26 10:00] REASSIGNED TO CEO by a: wrong home\n[2026-08-26 11:00] REASSIGNED TO CEO by b: still wrong',
      quoted: '[2026-08-26 10:00] REASSIGNED TO CEO by a: already REASSIGNED TO CEO once, still wrong',
      none: 'ordinary notes',
    });
    expect(counts).toEqual({ genuine: 2, quoted: 1, none: 0 });
  });

  it('archives Kevin\'s feedback before clearing it, and clears the stale decision stamp', () => {
    const fn = src.slice(src.indexOf('def cmd_reassign'), src.indexOf('def cmd_escalate'));
    // Without the archive, the reason for the redo is erased and a ticked
    // "remember this" lesson has no text left to learn from.
    expect(fn).toMatch(/AF\["feedbackHistory"\]/);
    expect(fn.indexOf('feedbackHistory')).toBeLessThan(fn.indexOf('patch_task'));
    expect(fn).toMatch(/AF\["approvedAt"\]: None/);
    expect(fn).toMatch(/AF\["assignee"\]: None/);
  });

  it('agents are told it exists', () => {
    const skill = read('.claude/scheduled-tasks/agent-dispatch/SKILL.md');
    expect(skill).toMatch(/reassign TASKID --reason/);
    expect(skill).toMatch(/wrong home/i);
  });
});
