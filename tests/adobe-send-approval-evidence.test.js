// Findings 20261117-agent-dispatch-1338 and 20261114-agent-dispatch-1307 (both high, one root cause).
// Kevin approved a tenant's tenancy pack on 17 Nov 2026 (task recTJKgCkUjK5O7o9) and nothing was
// sent: scripts/adobe-send.js refused every unattended run in code, and no robot slot could press
// Send on work he had already said yes to. The 14 Nov carry-out (rec3lTCCcwNHCttoE) died the same way.
// So an approved task id now stands in for Kevin sitting in the chat, and ONLY when the approval is
// real (scripts/approval_evidence.py, finding 20260922-agent-dispatch-572: an Approval Outcome
// STRING is never an approval) and the card names THIS draft.
//
// These tests drive the REAL exports of adobe-send.js, and the REAL approval_evidence.py through
// its real evidenceProblem() shell-out, with only the Airtable record faked. The refusal under test
// is the one the send path runs.
//
// BACK-TEST: every test in "an approved task opens an unattended send" fails on HEAD, where
// sendRefusal, approvalProblem and cardNamesDraft do not exist at all (adobe-send.js exported only
// headlessRefusal, checkTitle, checkRecipients, confirmed) and headlessRefusal had no route round it.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = createRequire(import.meta.url)(path.join(root, 'scripts/adobe-send.js'));

const GATE = 'fld30Yw8SWYVp049g';   // Sent For Approval By (scripts/approval_evidence.py)
const AT = 'fldr4Mvf2RzKvhZhi';     // Approved At
const TITLE = 'AST_Jordan_Hale_6_Mapleford_Place';
const CREATED = '2026-11-17T09:00:00.000Z';

// The words the script refuses an unattended run with. Word for word from headlessRefusal().
const UNATTENDED = 'this session is not one Kevin is in (CLAUDE_CODE_SESSION_ATTENDED is not 1). '
  + 'Sending needs his yes in the chat.';
const ROBOT = 'this is a robot slot run. Robots build drafts with adobe-assign.js and never send.';

/** A Tasks record keyed by field id, with the REAL approval_evidence.py verdict on it. */
function task(extra, { created = CREATED, name = `TENANCY PACK: send ${TITLE} to Jordan Hale` } = {}) {
  const rec = {
    createdTime: created,
    fields: Object.assign({
      [S.TF.name]: name,
      [S.TF.approvalOutcome]: { name: 'Approved as-is' },
    }, extra),
  };
  return { fields: rec.fields, createdTime: rec.createdTime, evidenceProblem: S.evidenceProblem(rec) };
}

const real = { [GATE]: ['recAGENT000000001'], [AT]: '2026-11-17T10:30:00.000Z' };

/** What the gate decides for an unattended env, given this task and draft. */
function decide(fields, opts = {}, { env = {}, title = TITLE } = {}) {
  const t = task(fields, opts);
  const approval = { taskId: 'recTJKgCkUjK5O7o9', problem: S.approvalProblem('recTJKgCkUjK5O7o9', t, title) };
  return { refusal: S.sendRefusal(env, approval), problem: approval.problem };
}

describe('an approved task opens an unattended send', () => {
  it('a real approval that names this draft proceeds, with no Kevin in the chat', () => {
    const r = decide(real);
    expect(r.problem).toBe('');
    expect(r.refusal).toBe('');
  });

  it('it also opens the dispatch slot, which is where the 14 Nov carry-out died', () => {
    expect(decide(real, {}, { env: { AGENT_SLOT_SCRATCH: '/tmp/slot' } }).refusal).toBe('');
    expect(decide(real, {}, { env: { TASK_MANAGER_SCRATCH: '/tmp/tm' } }).refusal).toBe('');
  });

  it('an unattended run with no task id still refuses, word for word', () => {
    expect(S.sendRefusal({}, null)).toBe(UNATTENDED);
    expect(S.sendRefusal({ AGENT_SLOT_SCRATCH: '/tmp/slot' }, null)).toBe(ROBOT);
    expect(S.approvalProblem('', null, TITLE)).toBe('no --task was given');
  });

  it('an attended chat sends as it always has, task or no task', () => {
    expect(S.sendRefusal({ CLAUDE_CODE_SESSION_ATTENDED: '1' }, null)).toBe('');
  });
});

describe('an approval nobody gave does not open it', () => {
  it('the Approval Outcome string alone: no gate card, no approval time', () => {
    const r = decide({});
    expect(r.problem).toMatch(/never went through the approval gate/);
    expect(r.refusal).toBe(UNATTENDED);
  });

  it('Sent For Approval By missing, even with an Approved At', () => {
    const r = decide({ [AT]: '2026-11-17T10:30:00.000Z' });
    expect(r.problem).toMatch(/never went through the approval gate \(Sent For Approval By is empty\)/);
    expect(r.refusal).toBe(UNATTENDED);
  });

  it('a gate card but no recorded approval', () => {
    const r = decide({ [GATE]: ['recAGENT000000001'] });
    expect(r.problem).toMatch(/no approval was ever recorded/);
    expect(r.refusal).toBe(UNATTENDED);
  });

  it('an Approved At EARLIER than the task itself: copied from a parent, not given', () => {
    const r = decide({ ...real, [AT]: '2026-11-17T08:59:00.000Z' });
    expect(r.problem).toMatch(/earlier than the task itself, so it was copied, not given/);
    expect(r.refusal).toBe(UNATTENDED);
  });

  it('a verdict that is not an approval', () => {
    for (const outcome of [null, { name: 'Changes requested' }, { name: 'Rejected' }]) {
      const r = decide({ ...real, [S.TF.approvalOutcome]: outcome });
      expect(r.problem, JSON.stringify(outcome)).toMatch(/is not approved/);
      expect(r.refusal).toBe(UNATTENDED);
    }
  });

  it('a task whose approval evidence was never checked is a problem, never a pass', () => {
    const t = { fields: { [S.TF.name]: TITLE, [S.TF.approvalOutcome]: { name: 'Approved as-is' } }, createdTime: CREATED };
    expect(S.approvalProblem('recTEST', t, TITLE)).toMatch(/carries no real approval/);
    expect(S.approvalProblem('recTEST', null, TITLE)).toMatch(/could not be read from Tasks/);
  });
});

describe('the approved card must name THIS send', () => {
  it('a task approved for the proof of residency does not unlock the agreement', () => {
    const r = decide(real, { name: `TENANCY PACK: send Proof_of_Residency_Jordan_Hale_6_Mapleford_Place` });
    expect(r.problem).toMatch(/does not name "AST_Jordan_Hale_6_Mapleford_Place"/);
    expect(r.refusal).toBe(UNATTENDED);
  });

  it('an unrelated approved card does not unlock an Adobe draft at all', () => {
    const r = decide(real, { name: 'CORRESPONDENCE: EICR quote follow-up' });
    expect(r.problem).toMatch(/does not name/);
    expect(r.refusal).toBe(UNATTENDED);
  });

  it('the name may sit in Agent Output or Notes, in prose, with spaces for underscores', () => {
    expect(S.cardNamesDraft({ [S.TF.name]: 'Send the pack',
      [S.TF.agentOutput]: `Press Send on ${TITLE} once the boxes are checked.` }, TITLE)).toBe(true);
    expect(S.cardNamesDraft({ [S.TF.notes]: 'Approved: AST Jordan Hale 6 Mapleford Place' }, TITLE)).toBe(true);
    expect(S.cardNamesDraft({ [S.TF.name]: 'AST_Jordan_Hale_7_Mapleford_Place' }, TITLE)).toBe(false);
    expect(S.cardNamesDraft({ [S.TF.name]: 'Send the pack' }, TITLE)).toBe(false);
  });
});

// These are what stop a pack reaching a tenant before Agile Lets has signed. An approval does not
// soften them: approval evidence decides WHO may press Send, never WHAT may be sent.
describe('the first-signer and signing-order checks are untouched', () => {
  const refuses = (f) => { try { f(); return ''; } catch (e) { return e.message; } };

  it('the tenant first is refused, approval evidence or not', () => {
    expect(decide(real).refusal).toBe('');   // the run is allowed...
    expect(refuses(() => S.checkRecipients(['jordan@example.com', 'info@agilelets.co.uk'])))
      .toMatch(/SEND REFUSED: the first recipient is jordan@example.com, not info@agilelets.co.uk/);
  });

  it('a draft with no recipients is refused', () => {
    expect(refuses(() => S.checkRecipients([]))).toMatch(/lists no recipients/);
  });

  it('two recipients still demand the signing order switch', () => {
    const r = S.checkRecipients(['info@agilelets.co.uk (myself)', 'jordan@example.com']);
    expect(r.needsOrder).toBe(true);
    expect(r.recipients[0]).toBe('info@agilelets.co.uk');
    expect(S.checkRecipients(['info@agilelets.co.uk (myself)']).needsOrder).toBe(false);
  });

  it('a title too short to pick one draft is still refused', () => {
    expect(refuses(() => S.checkTitle('AST_Jordan'))).toMatch(/too short to pick one draft safely/);
  });

  it('the confirmation must still name this draft', () => {
    expect(S.confirmed(`${TITLE} was successfully sent for signature`, TITLE)).toBe(true);
    expect(S.confirmed('AST_Someone_Else was successfully sent for signature', TITLE)).toBe(false);
  });
});

describe('the send leaves a trail on the task', () => {
  it('the Notes line is the stamped shape send-email.py writes', () => {
    const line = S.noteLine(TITLE, ['info@agilelets.co.uk', 'jordan@example.com'], true,
      new Date('2026-11-19T07:30:00Z'));
    expect(line).toMatch(/^\[\d{2} Nov 2026 \d{2}:\d{2} — adobe-send\] SENT: "AST_Jordan_Hale_6_Mapleford_Place" for signature to info@agilelets\.co\.uk, jordan@example\.com \(signing order ON\)$/);
  });

  it('one recipient reads "not needed", never a false ON', () => {
    expect(S.noteLine(TITLE, ['info@agilelets.co.uk'], null)).toMatch(/\(signing order not needed\)$/);
  });
});
