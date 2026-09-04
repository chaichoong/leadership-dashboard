import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SEND_EMAIL = resolve(ROOT, 'scripts/send-email.py');

// The submit gate — scripts/agent-dispatch.py cmd_submit.
//
// Two bugs found on 11 Aug 2026, both of which let the approval loop believe an
// action was ready when it was not.
//
// 1) 20260811-agent-dispatch-083 (critical). submit set Status=Approval and
//    overwrote Agent Output, but never cleared Approval Outcome. Verified live
//    on recPuM3uRVPDmFhs0: Status 'Approval', Outcome 'Approved as-is', Agent
//    Output a brand new email Kevin had never read. send-email.py gates on the
//    outcome ALONE, so the send path would have posted unread words with no
//    fresh decision. The mirror image broke the redo path: a resubmitted
//    Changes-requested task kept that verdict and got re-queued as a redo on
//    every run, rewriting Agent Output under Kevin while he was reading it.
//
// 2) 20260811-agent-dispatch-085 (high). Nothing checked that a --type
//    Correspondence output matched the TO:/SUBJECT:/---/body contract that
//    send-email.py requires. recFdEICxHjYCzDkS went in as an analysis document
//    with the email buried in prose, Kevin approved it, and the failure only
//    surfaced days later at carry-out time.
//
// The real cmd_submit is exercised with patch_task swapped for a recorder, so
// no Airtable call happens and the assertions are against the payload the
// script would really send. Re-implementing the payload in JS would guard
// nothing.
function submit({ type, output, tier1 = false, approverEmail = '', inboundSender = '' }) {
  const script = `
import importlib.util, json, sys, tempfile, os, types
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

captured = {}
def fake_patch(task, fields):
    captured['task'] = task
    captured['fields'] = fields
    return {'id': task}
m.patch_task = fake_patch

payload = json.loads(sys.argv[1])

# submit reads the task to find its Approver — stub it so no Airtable call
# happens. An approverEmail in the payload lands in the Approver field.
# submit calls get_task twice: once BEFORE the patch to find the Approver, and
# once AFTER it to read the record back (finding 20260823-queue-fixer-329 — the
# skill promised that read-back for four days before it existed). The stub has
# to behave like Airtable and return what was just written, or the read-back
# sees an empty Agent Output and correctly refuses.
def fake_get(task):
    fields = {}
    if payload.get('approverEmail'):
        fields[m.AF['approver']] = {'email': payload['approverEmail']}
    if payload.get('inboundSender'):
        fields[m.AF['inboundSender']] = payload['inboundSender']
    fields.update(captured.get('fields', {}))
    return {'id': task, 'fields': fields}
m.get_task = fake_get
fh = tempfile.NamedTemporaryFile('w', suffix='.md', delete=False)
fh.write(payload['output'])
fh.close()

agent_id = sorted(m.AGENTS)[0]
args = types.SimpleNamespace(task='recTESTTESTTEST01', agent=agent_id,
                             type=payload['type'], output_file=fh.name,
                             tier1=payload['tier1'])
out = {'agentId': agent_id, 'fieldMap': m.AF}
try:
    m.cmd_submit(args)
    out['refused'] = False
except SystemExit as exc:
    out['refused'] = True
    out['error'] = str(exc)
finally:
    os.unlink(fh.name)
out['captured'] = captured
print('---JSON---')
print(json.dumps(out))
`;
  const raw = execFileSync('python3', ['-c', script, JSON.stringify({ type, output, tier1, approverEmail, inboundSender })],
    { encoding: 'utf8' });
  return JSON.parse(raw.split('---JSON---')[1]);
}

// FROM is mandatory on a submit since 27 Aug 2026 — Kevin corrected a missing
// or wrong sender by hand 11 times in a month. See tests/approval-gate-defaults.
// It also carries the closing line. Without one this fixture sat one
// character under SUMMARY_MIN_CHARS (280) once the tier-1 banner was
// prepended, so adding any header at all silently flipped that test into
// a different code path. A realistic submission has both.
const GOOD_EMAIL = 'TO: someone@example.com\nFROM: kevinbrittain@gmail.com\nSUBJECT: A subject\n---\nThe body of the email.\n\n**Carrying this out will involve:** sending this email to someone@example.com.';

// A long deliverable — the shape that gets a derived summary in Kevin's approval
// box. Anything under 280 characters is shown whole, so the mandate below does
// not apply to it.
const LONG = 'The invoice was checked against the bank feed line by line. '.repeat(8);
const CARRY_OUT = '**Carrying this out will involve:** closing Airtable task recXYZ as already done.';

describe('agent-dispatch submit gate', () => {
  it('clears the previous approval verdict in the same patch (083)', () => {
    const r = submit({ type: 'Drafting', output: 'Some drafted work.' });
    expect(r.refused, r.error).toBe(false);
    const f = r.captured.fields;
    const AF = r.fieldMap;

    // Status moves to Approval — the gate itself.
    expect(f[AF.status]).toBe('Approval');
    // ...and the stale verdict must go with it, or the gate is decorative.
    expect(Object.prototype.hasOwnProperty.call(f, AF.approvalOutcome),
      'submit does not clear Approval Outcome — a resubmitted task still reads as approved').toBe(true);
    expect(f[AF.approvalOutcome]).toBeNull();
    expect(f[AF.approvalFeedback]).toBeNull();
    expect(f[AF.approvedAt]).toBeNull();
  });

  it('accepts a Correspondence output the send gate can parse (085)', () => {
    const r = submit({ type: 'Correspondence', output: GOOD_EMAIL });
    expect(r.refused, r.error).toBe(false);
    expect(r.captured.fields[r.fieldMap.taskType]).toBe('Correspondence');
  });

  it('refuses a Correspondence output the send gate cannot parse (085)', () => {
    const r = submit({
      type: 'Correspondence',
      output: '## THE EMAIL, word for word\n\nDear Fylde Council, I am writing about...',
    });
    expect(r.refused, 'prose submitted as Correspondence was accepted').toBe(true);
    expect(r.error).toMatch(/Correspondence/);
    // Nothing may be written when the submit is refused.
    expect(r.captured.fields).toBeUndefined();
  });

  it('a tier-1 Correspondence submit still parses once the banner is on it (084)', () => {
    const r = submit({ type: 'Correspondence', output: GOOD_EMAIL, tier1: true });
    expect(r.refused, r.error).toBe(false);
    const written = r.captured.fields[r.fieldMap.agentOutput];
    expect(written, 'the tier-1 banner did not reach Agent Output').toContain('TIER 1');
    expect(written).toContain('TO: someone@example.com');
  });

  it('a non-Correspondence type is not forced into the email format', () => {
    const r = submit({ type: 'Research', output: 'A research note with no headers at all.' });
    expect(r.refused, r.error).toBe(false);
  });

  // The other half of 084: the send gate must accept what submit produced.
  // send-email.py's own offline selftest covers the parser, including the
  // tier-1 banner case, and needs no network or Airtable.
  it('the send gate parser selftest passes, banner included', () => {
    const out = execFileSync('python3', [SEND_EMAIL, 'selftest'], { encoding: 'utf8' });
    expect(out).toContain('PASS tier-1 banner stripped');
    expect(out).toContain('PASS banner not left in body');
    expect(out).toMatch(/selftest OK/);
    expect(out, 'a parser check regressed').not.toContain('FAIL ');
  });

  // ── The mandatory closing line (20260811-kevin-session-093) ──────────────
  //
  // Kevin's approval box leads with one line saying what the agent wants to do,
  // derived by apvSummary(). It prefers the agent's own closing "Carrying this
  // out will involve:" line; both fallbacks are guesses. On 11 Aug 2026 only 9
  // of 46 waiting tasks carried the line, so most summaries were guessed, and
  // he instructed that it be mandated at the gate rather than in prose.
  describe('mandatory "Carrying this out will involve" line', () => {
    it('refuses a long output that does not carry the line', () => {
      const r = submit({ type: 'Analysis', output: LONG });
      expect(r.refused, 'a long output with no closing line was accepted').toBe(true);
      expect(r.error).toMatch(/Carrying this out will involve/i);
      expect(r.captured.fields, 'a refused submit still wrote to Airtable').toBeUndefined();
    });

    it('accepts the same output once the line is there', () => {
      const r = submit({ type: 'Analysis', output: `${LONG}\n\n${CARRY_OUT}` });
      expect(r.refused, r.error).toBe(false);
      expect(r.captured.fields[r.fieldMap.agentOutput]).toContain('Carrying this out will involve');
    });

    it('refuses an empty line — a marker with nothing after it summarises nothing', () => {
      const r = submit({ type: 'Analysis', output: `${LONG}\n\n**Carrying this out will involve:**` });
      expect(r.refused, 'an empty closing line was accepted').toBe(true);
    });

    it('refuses a marker buried mid-document rather than closing it', () => {
      const r = submit({ type: 'Analysis', output: `${CARRY_OUT}\n\n${LONG}${LONG}` });
      expect(r.refused, 'a mid-document marker passed as a closing line').toBe(true);
      expect(r.error).toMatch(/CLOSING/);
    });

    it('does not demand it of a short output, which is shown whole anyway', () => {
      // apvSummary returns '' below 280 characters. Refusing here would cost a
      // retry per submit and buy no summary at all.
      const r = submit({ type: 'Admin', output: 'Closed task recABC as a duplicate.' });
      expect(r.refused, r.error).toBe(false);
    });

    it('a tier-1 output is judged on the text that gets stored, banner and all', () => {
      const r = submit({ type: 'Analysis', output: `${LONG}\n\n${CARRY_OUT}`, tier1: true });
      expect(r.refused, r.error).toBe(false);
      const written = r.captured.fields[r.fieldMap.agentOutput];
      expect(written).toContain('TIER 1');
      expect(written).toContain('Carrying this out will involve');
    });

    // ── A PROMISE TO SEND MUST BE Correspondence (20260818-agent-dispatch-203) ──
  //
  // Tasks were submitted as `--type Drafting` with a closing line saying the
  // email would go out from Kevin's Gmail. Kevin read that, approved it, and
  // send-email.py then refused the carry-out because it only sends
  // Correspondence. The contract is free to fix at draft time and expensive
  // after a decision has been made on it.
  describe('closing line that promises a send', () => {
    it('refuses a Drafting submit whose closing line says it sends the email', () => {
      const r = submit({ type: 'Drafting',
        output: `${LONG}\n\n**Carrying this out will involve:** sending the email to the council from Kevin's Gmail.` });
      expect(r.refused, 'a Drafting task promised a send and was accepted').toBe(true);
      expect(r.error).toMatch(/Correspondence/);
      expect(r.captured.fields, 'a refused submit still wrote to Airtable').toBeUndefined();
    });

    it('accepts the same words once the type is Correspondence', () => {
      const email = ['TO: council@example.com', 'FROM: kevinbrittain@gmail.com', 'SUBJECT: Account 123', '---',
        'Dear Sir,', '', 'x'.repeat(300), '',
        "**Carrying this out will involve:** sending the email to the council from Kevin's Gmail."].join('\n');
      const r = submit({ type: 'Correspondence', output: email });
      expect(r.refused, r.error).toBe(false);
    });

    it('does not refuse an analysis that merely DISCUSSES email', () => {
      // The gate reads the closing line only. Refusing on any mention of email
      // anywhere would block most analysis work and get itself worked around.
      const r = submit({ type: 'Analysis',
        output: `The council sends the email every month, which is why the arrears look odd. ${LONG}\n\n**Carrying this out will involve:** updating the arrears note on the tenancy record.` });
      expect(r.refused, r.error).toBe(false);
    });

    it('catches "email it" phrasing too, not just "send the email"', () => {
      const r = submit({ type: 'Admin',
        output: `${LONG}\n\n**Carrying this out will involve:** emailing it to the managing agent today.` });
      expect(r.refused).toBe(true);
    });

    it('leaves a short output alone, which carries no closing line at all', () => {
      const r = submit({ type: 'Admin', output: 'Sending the email to the council.' });
      expect(r.refused, r.error).toBe(false);
    });
  });

  it('requires the SAME marker the two approval renderers parse', () => {
      // One pattern, so what submit demands and what the box reads cannot drift.
      // tests/approval-summary.test.js holds the renderers to this shape.
      const src = execFileSync('cat', [DISPATCH], { encoding: 'utf8' });
      const approvals = execFileSync('cat', [resolve(ROOT, 'scripts/slack-automation/approvals.js')],
        { encoding: 'utf8' });
      const rx = /carrying this out will involve:\?\\\*\{0,2\}|carrying this out will involve/i;
      expect(src).toMatch(rx);
      expect(approvals).toMatch(rx);
    });

    // 20260819-agent-dispatch-240. The 400-char cap was enforced but stated
    // nowhere, so 5 of 25 submits on 19 Aug failed on it after the whole
    // deliverable was written. The refusal now names the limit and the overrun.
    it('the over-long refusal names the limit and the overrun', () => {
      const r = submit({ type: 'Analysis', output: `${CARRY_OUT} ${'y'.repeat(500)}\n\n${LONG}` });
      expect(r.refused).toBe(true);
      expect(r.error).toMatch(/under 400 characters/);
      expect(r.error).toMatch(/yours is \d+/);
    });

    // 20260819-agent-dispatch-237 (critical). The mandated closing line is a
    // note to Kevin about the action, not a sentence in the letter. Until
    // 19 Aug 2026 parse_output did not strip it, so the only route to sending
    // five approved creditor and Companies House emails would have posted
    // '**Carrying this out will involve:** sending the email above ...'
    // verbatim to the recipient. Back-tested: reverting the strip in
    // agent_email_format.parse_output makes both of these fail.
    describe('it never reaches the recipient (20260819-agent-dispatch-237)', () => {
      const parse = (output) => JSON.parse(execFileSync('python3', ['-c', `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location('fmt', ${JSON.stringify(resolve(ROOT, 'scripts/agent_email_format.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.parse_output(sys.stdin.read())))
`], { encoding: 'utf8', input: output }));

      const EMAIL = 'TO: enquiries@companieshouse.gov.uk\nFROM: kevinbrittain@gmail.com\nSUBJECT: Company 12345678\n---\nDear Sir,\n\nPlease find the response attached.\n\nKind regards\nKevin';

      it('strips the closing line from the email body', () => {
        const body = parse(`${EMAIL}\n\n${CARRY_OUT}`).body;
        expect(body, 'the internal marker would have been emailed out').not.toMatch(/arrying this out/i);
        expect(body).toBe(parse(EMAIL).body);
      });

      it('leaves a mid-body mention alone — it is the letter, not the note', () => {
        const body = parse(`TO: a@b.com\nSUBJECT: x\n---\nCarrying this out will involve ${'word '.repeat(120)}\n\nRegards`).body;
        expect(body).toMatch(/arrying this out/i);
      });

      it('the marker is single-sourced, not re-declared in agent-dispatch.py', () => {
        // Two copies is how the strip and the mandate drift apart.
        const dispatchSrc = execFileSync('cat', [DISPATCH], { encoding: 'utf8' });
        expect(dispatchSrc, 'agent-dispatch.py declares its own copy again')
          .not.toMatch(/^CARRY_OUT_MARKER\s*=/m);
        expect(dispatchSrc).toMatch(/from agent_email_format import \([\s\S]*?CARRY_OUT_MARKER/);
      });
    });
  });

  // WHO the approval lands on (12 Aug 2026): the task's Approver field
  // decides — label-8 inbound work goes to Mica, everything else to Kevin —
  // and tier 1 ALWAYS diverts to Kevin whatever the field says.
  describe('approver routing', () => {
    it('assigns the approval to the task Approver (Mica for label-8 work)', () => {
      const r = submit({ type: 'Drafting', output: 'Some drafted work.', approverEmail: 'micaa.work@gmail.com' });
      expect(r.refused, r.error).toBe(false);
      expect(r.captured.fields[r.fieldMap.assignee]).toEqual({ email: 'micaa.work@gmail.com' });
    });

    it('defaults to Kevin when no Approver is set', () => {
      const r = submit({ type: 'Drafting', output: 'Some drafted work.' });
      expect(r.refused, r.error).toBe(false);
      expect(r.captured.fields[r.fieldMap.assignee]).toEqual({ email: 'kevin@runpreneur.org.uk' });
    });

    it('tier 1 diverts to Kevin even when the Approver says Mica', () => {
      const r = submit({ type: 'Drafting', output: 'Some drafted work.', tier1: true, approverEmail: 'micaa.work@gmail.com' });
      expect(r.refused, r.error).toBe(false);
      expect(r.captured.fields[r.fieldMap.assignee]).toEqual({ email: 'kevin@runpreneur.org.uk' });
      // The label travels with the work, however tier 1 was spotted.
      expect(r.captured.fields[r.fieldMap.agentOutput]).toContain('TIER 1');
    });
  });

  // 1-2 Sep 2026: recPqpTwyBCWs3mPs, an Apps Script alert that triage raised
  // twice. The duplicate rule said fold it into its keeper; this gate said
  // "machine reporting a breakage, never submit" and refused for three slots.
  // A CLOSE PROPOSAL is about the task, not the breakage — Kevin approves
  // removing a duplicate, not investigating a script — so it passes. The
  // original refusal still stands for anything else on an alert thread.
  describe('system-alert tasks', () => {
    const ALERT = 'apps-scripts-notifications@google.com';
    it('still refuses a write-up of the breakage', () => {
      const r = submit({ type: 'Drafting', inboundSender: ALERT,
        output: 'The Meetings Intake script is failing on every run; recommend investigating the trigger.\n\n' + CARRY_OUT });
      expect(r.refused).toBe(true);
      expect(r.error).toMatch(/machine reporting a breakage/);
    });
    it('accepts a CLOSE PROPOSAL, because folding a duplicate alert is hygiene', () => {
      const r = submit({ type: 'Admin', inboundSender: ALERT,
        output: 'CLOSE PROPOSAL: duplicate of recKEEPER0000000 — folded into it.\n\n**Carrying this out will involve:** marking this task complete as a duplicate.' });
      expect(r.refused, r.error).toBe(false);
    });
  });
});

// Kevin's ruling, 4 Sep 2026: a report whose closing line says nothing happens
// on approval is information, not a decision. Measured over 14 days, 29 of 40
// "Analysis" outputs were rejected and every one said the task should not have
// reached him. Such an output is FILED on the task (Completed, report in Agent
// Output) instead of queued. The agent DECLARES it: the closing line opens with
// a bare Nothing / None / No action and no clause follows. Two reviews the
// same day broke two verb-list versions of this rule, so every line they used
// to break it is a case below. Never for Correspondence: an email whose
// closing line says "nothing" is a broken email, and the send-format check
// refuses it.
describe('informational outputs are filed, not queued (4 Sep 2026)', () => {
  const report = 'Portfolio arrears review.\n' + 'Detail line. '.repeat(30) + '\n';
  const CARRY = '**Carrying this out will involve:** ';
  it.each([
    'Nothing. This is for your information only.',
    'None. The report is reference only, no decision needed.',
    'No action required.',
    'Nothing. Information only.',
  ])('the declared form is filed and closed: %s', (tail) => {
    const r = submit({ type: 'Analysis', output: report + CARRY + tail });
    expect(r.refused).toBe(false);
    expect(r.captured.fields[r.fieldMap.status]).toBe('Completed');
    expect(r.captured.fields[r.fieldMap.completion]).toBeTruthy();
    expect(r.captured.fields[r.fieldMap.agentOutput]).toContain('Portfolio arrears review');
    expect(r.captured.fields[r.fieldMap.notes]).toMatch(/FILED, not queued/);
  });
  it('a NO ACTION REQUIRED briefing in the declared form is filed', () => {
    const r = submit({ type: 'Admin', output: 'NO ACTION REQUIRED\n' + report + CARRY + 'Nothing. Information only.' });
    expect(r.refused).toBe(false);
    expect(r.captured.fields[r.fieldMap.status]).toBe('Completed');
  });
  it.each([
    'Sending the arrears letter to the tenant at 6 Chedburgh Place.',
    'Nothing goes out until you approve; then I send the letter to HMRC.',
    'No payment is made; I email the creditor the plan.',
    'None of the tenants are contacted; Roy books the inspection.',
    'No action on the arrears yet, but the reminder is posted today.',
    'Nothing until Roy confirms; then the notice goes to the tenant.',
    'No change now — the DD reduction takes effect on the 6th.',
    'None; the accountant will lodge the return.',
    'No further action from this agent; the tenant moves out on the 14th.',
    'None needed today; the direct debit collects automatically next week.',
    'Nothing to send — the portal takes the payment on its own on the due date.',
    'No decision needed — the licence renews automatically with the council.',
    'Nothing from me — Kevin will call the bank himself.',
    'Kevin reads the briefing.',
    'Nothing further from me as the notice reaches the tenant tomorrow',
    'None required because the payment leaves the account on Friday',
    'No action needed as the eviction proceeds',
    'Nothing to do now the letter goes out by first class post',
    'Nothing required as Roy arranges the inspection',
    'N/A now the contractor is booked for Tuesday',
  ])('anything else stays on the gate or is refused, never closed as done: %s', (tail) => {
    const r = submit({ type: 'Analysis', output: report + CARRY + tail });
    if (r.refused) expect(r.error).toMatch(/refusing to submit/);
    else expect(r.captured.fields[r.fieldMap.status]).toBe('Approval');
    expect(r.captured.fields ? r.captured.fields[r.fieldMap.status] : '').not.toBe('Completed');
  });
  it('a NO ACTION REQUIRED heading does not override a closing line that names an action', () => {
    const r = submit({ type: 'Admin', output: 'NO ACTION REQUIRED\n' + report + CARRY + 'Sending the notice to the council.' });
    expect(r.captured.fields ? r.captured.fields[r.fieldMap.status] : '').not.toBe('Completed');
  });
  it.each([
    'NO ACTION REQUIRED\n\nThe boiler service was booked and completed by the contractor yesterday without incident.',
    'NO ACTION REQUIRED\n\nThe eviction notice was already served on the tenant this morning as scheduled.',
  ])('a short output with the heading but no closing line is never filed', (output) => {
    const r = submit({ type: 'Admin', output });
    expect(r.captured.fields ? r.captured.fields[r.fieldMap.status] : '').not.toBe('Completed');
  });
  it('a tier-1 report is never filed: the banner promises Kevin reads it before anything', () => {
    const r = submit({ type: 'Analysis', tier1: true, output: report + CARRY + 'Nothing. Information only.' });
    expect(r.refused).toBe(false);
    expect(r.captured.fields[r.fieldMap.status]).toBe('Approval');
  });
  it('a Correspondence output is never filed on that rule (its own send-format check decides)', () => {
    const r = submit({ type: 'Correspondence', output: report + CARRY + 'Nothing.' });
    expect(r.captured.fields ? r.captured.fields[r.fieldMap.status] : 'Approval').not.toBe('Completed');
  });
});

// Kevin's ruling, 4 Sep 2026 (fix 2): an output that tells him to log in and
// do it himself is refused at submit. 37 of 233 outputs over 14 days did that.
// The one sanctioned hand-back is the SIGN-IN NEEDED line the Robot sign-in
// app turns into a tap.
describe('hand-backs are refused at submit (4 Sep 2026)', () => {
  const report = 'Portfolio arrears review.\n' + 'Detail line. '.repeat(30) + '\n';
  const CARRY = '**Carrying this out will involve:** Kevin reviews the findings and decides.';
  it.each([
    'Kevin must log into pingen.com and click Send on letter b8caaaf2.',
    'You will need to log in to the Stripe dashboard and complete the verification.',
    'Log into the HL account at hl.co.uk to read the secure message.',
    'KEVIN ACTION: log into pingen and press send.',
    'Kevin should call the bank to confirm the balance.',
  ])('refuses: %s', (line) => {
    const r = submit({ type: 'Research', output: report + line + '\n\n' + CARRY });
    expect(r.refused).toBe(true);
    expect(r.error).toMatch(/hands Kevin a job/);
  });
  it('the SIGN-IN NEEDED line is the sanctioned hand-back and passes', () => {
    const r = submit({ type: 'Research', output: report + 'SIGN-IN NEEDED: Pingen (https://app.pingen.com/)\n\n' + CARRY });
    expect(r.refused).toBe(false);
    expect(r.captured.fields[r.fieldMap.status]).toBe('Approval');
  });
  it.each([
    'Please log into your Starling app and check the balance.',
    'Kevin - log in to GoCardless and reinstate the mandate.',
    'Next step for Kevin: sign in to Stripe.',
    'Kevin needs to ring HMRC on 0300 200 3310.',
    'Kevin, please sign into the HMRC portal to submit this.',
    "You'll need to log in to the EDF account and confirm the meter reading.",
  ])('refuses the phrasings the second review found: %s', (line) => {
    const r = submit({ type: 'Research', output: report + line + '\n\n' + CARRY });
    expect(r.refused).toBe(true);
    expect(r.error).toMatch(/hands Kevin a job/);
  });
  it.each([
    "Kevin's steps only: the security code and the payment. Everything else is prepared.",
    'Once Kevin approves, the letter is posted.',
    'Kevin can review the attached statement.',
    'You can see the balance on the attached PDF.',
    'The tenant must log in to the portal to pay.',
    'Roy should call the contractor.',
    'Kevin can call this done once he checks the figures.',
  ])('is not a hand-back: %s', (line) => {
    const r = submit({ type: 'Research', output: report + line + '\n\n' + CARRY });
    expect(r.refused).toBe(false);
  });
  it('a letter that tells ITS recipient to log in is not a hand-back to Kevin (second review)', () => {
    const email = 'TO: tenant@example.com\nFROM: kevinbrittain@gmail.com\nSUBJECT: Rent this month\n---\nDear Sam,\n\nYou must log in to the tenant portal to pay your rent this month. You should call the office if the portal is down.\n\nKind regards\nKevin\n\n**Carrying this out will involve:** Sending this email to the tenant.';
    const r = submit({ type: 'Correspondence', output: email });
    expect(r.error || '').not.toMatch(/hands Kevin a job/);
  });
});
