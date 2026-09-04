// The approval decision has THREE faces writing the same Airtable state:
// the Tasks drawer (apvDecide), the Slack worker (applyDecision in
// scripts/slack-automation/approvals.js), and the AI Agents page
// (applyApprovalDecision in os/agents/index.html). Until 24 Aug 2026 the
// only thing holding them aligned was a comment saying "keep the three in
// step" — the discipline this platform's own history shows does not work.
//
// This suite extracts each REAL function's source and asserts the
// load-bearing write semantics appear in all three:
//   - outcome, approvedAt, approvedBy, approvalFeedback field ids
//   - Rejected → Status Completed + a completion stamp
//   - every other outcome → Status Today + the completion stamp CLEARED
//     (the 88-stale-stamps bug: a reopened task keeping its old stamp is
//     counted as finished work)
//   - hand-back: teamMember AND sentForApprovalBy set, Assignee cleared
// A face may write MORE (the worker clears its Slack fields); it may not
// skip any of these.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AGENTS_PAGE = readFileSync(resolve(__dirname, '../os/agents/index.html'), 'utf8');
const TASKS_PAGE = readFileSync(resolve(__dirname, '../os/tasks/index.html'), 'utf8');
const WORKER = readFileSync(resolve(__dirname, '../scripts/slack-automation/approvals.js'), 'utf8');

function extractFn(source, name, isAsync) {
  const sig = `${isAsync ? 'async ' : ''}function ${name}(`;
  const start = source.indexOf(sig);
  if (start === -1) throw new Error(`${name} not found`);
  let i = source.indexOf('{', start), depth = 0, end = -1;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return source.slice(start, end);
}

const FACES = [
  ['agents page', extractFn(AGENTS_PAGE, 'applyApprovalDecision', true)],
  ['tasks drawer', extractFn(TASKS_PAGE, 'apvDecide', true)],
  ['slack worker', extractFn(WORKER, 'applyDecision', true)],
];

const F = {
  outcome: 'fldrHBSr6qoUfaKuZ',
  approvedAt: 'fldr4Mvf2RzKvhZhi',
  approvedBy: 'fldNntfwSzU5DlYS4',
  feedback: 'fldtI7SJI4gEohHD1',
  status: 'fldx4qCw17UfrKpaN',
  dueDate: 'fld7XP8w8kbxfETV4',
  completion: 'fldFOi1SwEKuJRmdN',
  teamMember: 'flduCtmQGpOA4eWaj',
  sentForApprovalBy: 'fld30Yw8SWYVp049g',
  assignee: 'fldELMncVJYPDRJNc',
};

describe.each(FACES)('%s writes the full decision state', (face, src) => {
  // The pages write via TF.* constants, the worker via its own AF map — so
  // resolve each face's source plus its constants file into raw field ids.
  const constants = face === 'slack worker' ? WORKER
    : face === 'tasks drawer' ? TASKS_PAGE : AGENTS_PAGE;

  it.each(Object.entries(F))('face knows field %s (%s)', (label, id) => {
    // The id must exist in the face's file, and the decide function must
    // write status/outcome/completion state (spot-checked below).
    expect(constants).toContain(id);
  });

  it('rejects close the task; every other outcome reopens it with a cleared stamp', () => {
    expect(src).toMatch(/Rejected/);
    expect(src).toMatch(/Completed/);
    expect(src).toMatch(/Today/);
    // The stamp-clearing rule: a null/cleared completion on the reopen path
    expect(src).toMatch(/completion[A-Za-z]*\]?\s*[:=]\s*null|fldFOi1SwEKuJRmdN\]\s*=\s*null|\[F\.completion\]:\s*null|completionDate:\s*null/i);
  });

  it('hands the task back to the raising agent and clears the assignee', () => {
    expect(src).toMatch(/sentForApprovalBy|fld30Yw8SWYVp049g/i);
    expect(src).toMatch(/teamMember|flduCtmQGpOA4eWaj/i);
    expect(src).toMatch(/assignee[^=]*=\s*null|\[TF\.assignee\]\s*=\s*null|assignee:\s*null|fldELMncVJYPDRJNc\]\s*=\s*null/i);
  });
});

// ─── THE LEARNING LOOP (26 Aug 2026) ──────────────────────────────────
//
// Kevin's question: "how do I know the agent is learning from my feedback?"
// The answer was that it was not. Feedback reached an agent for one task and
// was then wiped by the next submit; a rejection never reached an agent at
// all. His fix: a second reject that says "remember this", so HE classifies
// which feedback is a standing rule and nothing has to guess.
//
// A face that forgets the flag is the silent failure — Kevin clicks a button
// labelled "Reject and remember", the reject lands, and the lesson never
// exists. Nothing errors, so it would go unnoticed exactly as long as the
// last version did.
describe.each(FACES)('%s carries the remember flag into the write', (face, src) => {
  const REMEMBER = 'fldZurhdHutYIDKVx';
  const HISTORY = 'fldOzsq68lhfprKJu';
  const constants = face === 'slack worker' ? WORKER
    : face === 'tasks drawer' ? TASKS_PAGE : AGENTS_PAGE;

  it('knows the Remember This and Feedback History field ids', () => {
    expect(constants).toContain(REMEMBER);
    expect(constants).toContain(HISTORY);
  });

  it('writes Remember This when the decision says to remember', () => {
    expect(src).toMatch(/rememberThis|fldZurhdHutYIDKVx/);
    // Guarded on the note: a remember with no words stores an empty lesson.
    expect(src).toMatch(/remember\s*&&\s*note|remember\s*&&\s*!!note/i);
  });

  it('archives the feedback before the next submit can clear it', () => {
    expect(src).toMatch(/feedbackHistory|fldOzsq68lhfprKJu/);
  });
});

// The remember route must be REACHABLE in the UI, or the mechanism exists only
// in the code and Kevin has no way to teach anything.
//
// The dedicated "Reject and remember" button was removed on 26 Aug 2026 as a
// duplicate of the tickbox (Kevin's call). That makes the tickbox the ONLY
// route, so losing it silently would turn every lesson off with nothing
// failing — which is precisely the shape of the original bug.
describe('the remember route survives in the UI', () => {
  it.each([['agents page', AGENTS_PAGE], ['tasks drawer', TASKS_PAGE]])(
    '%s has a remember tickbox and reads it in the decide function', (_face, page) => {
      expect(page).toMatch(/id="apvRemember/);
      expect(page).toMatch(/Remember this reason/i);
      expect(page).toMatch(/checked/);
      expect(page).toMatch(/Reject and close/i);
    });

  it('the agents page repeats the choice inside the reject confirm dialog', () => {
    // A tickbox above the buttons is the control you scroll past while typing
    // the reason worth keeping, so the choice is offered again at the moment
    // of commitment and read THEN, not when the dialog opened.
    expect(AGENTS_PAGE).toMatch(/apvRememberConfirm/);
    expect(AGENTS_PAGE).toMatch(/function agConfirmReject/);
    expect(AGENTS_PAGE).toMatch(/box && box\.checked/);
  });

  it('no stray duplicate reject-and-remember button remains', () => {
    for (const page of [AGENTS_PAGE, TASKS_PAGE]) {
      expect(page).not.toMatch(/>Reject and remember</);
    }
  });

  it('the slack worker maps a remember emoji and advertises it', () => {
    expect(WORKER).toMatch(/REMEMBER_REACTIONS/);
    expect(WORKER).toMatch(/brain/);
    expect(WORKER).toMatch(/reject and remember/i);
  });

  it('a remember emoji with no reason asks rather than storing nothing', () => {
    // The lone-pencil precedent: ask, never guess. A silent downgrade to a
    // plain reject looks identical to Kevin and loses the rule.
    expect(WORKER).toMatch(/reaction\.remember\s*&&\s*!replies\.length/);
  });
});

// ─── WHICH KIND OF NO (4 Sep 2026) ────────────────────────────────────
//
// The reason chips shipped on 27 Aug on the AI Agents gate only, and even
// there the red Reject button sat beside them and skipped them. So a rejection
// could still be written with Verdict Reason empty, and five were between
// 1 and 3 Sep — read from Airtable, not from a log:
//
//   rec6x6sfB3kmL7Vfi, rec7alvvt370LsEf6, rec8Gh5YGCNf332Pg, recrHeCCTna0WluLl
//     — Kevin typed his own sentence and pressed Reject on the gate. The same
//       day, 33 rejections taken through the chips all recorded their reason.
//   recUE5JNhNW5rqSnF — decided by Mica in the TASKS DRAWER, which did not
//     know the field existed at all, so no route through it could record one.
//
// A reason-less rejection counts against the agent that wrote the draft, and
// the lesson writer cannot route it, so the learning loop stops compounding on
// that path while every screen still looks healthy.
//
// The guard belongs on the WRITE, not on one button: both browser faces now
// refuse to send the PATCH at all when no reason is recorded.
describe.each(FACES)('%s records WHICH KIND of no', (face, src) => {
  const VERDICT = 'fldF9Bs4N5mttQvtl';
  const constants = face === 'slack worker' ? WORKER
    : face === 'tasks drawer' ? TASKS_PAGE : AGENTS_PAGE;

  it('knows the Verdict Reason field id', () => {
    expect(constants).toContain(VERDICT);
  });

  it('carries the reason into the write', () => {
    expect(src).toMatch(/verdictReason|fldF9Bs4N5mttQvtl/);
  });
});

// A rejection may never store a BLANK reason on any face. Blank is
// indistinguishable from a field that was never written, which is exactly how
// these five went unseen. When Kevin names no kind, the faces store the
// unclassified value instead — not a guess, and it scores as a blank always
// did.
describe.each(FACES)('%s never writes a rejection with a blank reason', (face, src) => {
  it('falls back to the unclassified value on the reject branch', () => {
    expect(src).toMatch(/UNCLASSIFIED|APV_UNCLASSIFIED/);
    // The fallback has to be reached BY the rejection, not sit in dead code.
    expect(src).toMatch(/outcome\s*===\s*'Rejected'[\s\S]{0,220}(APV_)?UNCLASSIFIED/);
  });
});

// The three faces cannot share a module (a Cloudflare Worker imports nothing
// from js/), so the string is repeated — and repeated strings drift.
describe('the unclassified value is one string everywhere', () => {
  const VALUE = "'Something else'";
  it('js/agent-accuracy.js defines it and both pages read it from there', () => {
    const accuracy = readFileSync(resolve(__dirname, '../js/agent-accuracy.js'), 'utf8');
    expect(accuracy).toContain(`UNCLASSIFIED_REASON = ${VALUE}`);
    expect(accuracy).toMatch(/UNCLASSIFIED_REASON: UNCLASSIFIED_REASON/);
    for (const page of [AGENTS_PAGE, TASKS_PAGE]) {
      expect(page).toMatch(/APV_UNCLASSIFIED\s*=\s*AgentAccuracy\.UNCLASSIFIED_REASON/);
    }
  });

  it('the slack worker and the python report carry the same literal', () => {
    expect(WORKER).toContain(`UNCLASSIFIED_REASON = ${VALUE}`);
    const report = readFileSync(resolve(__dirname, '../scripts/agent-accuracy-report.py'), 'utf8');
    expect(report).toContain('UNCLASSIFIED_REASON = "Something else"');
  });

  it('an unclassified rejection still counts as unexplained, not as a pass', () => {
    // Otherwise the "rejections with no reason" number drops to zero the day
    // the blanks stop, with nothing having actually improved.
    const accuracy = readFileSync(resolve(__dirname, '../js/agent-accuracy.js'), 'utf8');
    expect(accuracy).toMatch(/function isUnclassifiedRejection[\s\S]{0,200}UNCLASSIFIED_REASON/);
    expect(accuracy).not.toMatch(/RELEVANCE_REASONS\s*=\s*\[[^\]]*Something else/);
    const report = readFileSync(resolve(__dirname, '../scripts/agent-accuracy-report.py'), 'utf8');
    expect(report).toMatch(/unclassified = sum\([\s\S]{0,240}UNCLASSIFIED_REASON/);
  });
});

// One set of reasons, three faces. If the keys drift, the same rejection is
// stored under two different names and every accuracy split silently splits
// the wrong way.
describe('the reason keys are the same everywhere', () => {
  function keysOf(source) {
    const start = source.indexOf('const APV_REASONS');
    expect(start, 'APV_REASONS not found').toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf('];', start));
    return [...block.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]);
  }

  it('the gate and the drawer offer identical reason keys', () => {
    const gate = keysOf(AGENTS_PAGE);
    expect(gate.length).toBe(7);
    expect(keysOf(TASKS_PAGE)).toEqual(gate);
  });

  it('the slack worker maps its words to those same keys', () => {
    for (const key of keysOf(AGENTS_PAGE)) {
      expect(WORKER, `slack worker cannot record: ${key}`).toContain(`'${key}'`);
    }
  });

  it('the drawer offers the chips in the UI, not only in code', () => {
    expect(TASKS_PAGE).toMatch(/apvReasonChips/);
    expect(TASKS_PAGE).toMatch(/function apvRejectWithReason/);
    expect(TASKS_PAGE).toMatch(/Reject because/);
  });
});
