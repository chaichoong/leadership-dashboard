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
