import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// THE APPROVE LINE IS THE BUTTON (Kevin, 27 Oct 2026): "If I approve should basically mean what
// happens if I press the approve button. If there's anything that I need to do, it needs to be the
// other version of the approval card where it tells me to do it, and then I have to prove it's
// done." The card that day read "You get a ready prompt to review the records": Approve set nothing
// going and the review chat it left him was declared nowhere, so no Your step card would have
// brought it back. The real cmd_submit, cmd_escalate and cmd_block run here with Airtable swapped
// for an in-memory task: every write lands in `captured`, every read comes from `stored`.
function run({ op = 'submit', plainTask = TASK, plainApprove = APPROVE, output = 'Some drafted work.',
               stored = {}, kind = 'KEVIN', subject = 'review', steps = '1. Paste the prompt. 2. Go through it.' }) {
  const script = `
import importlib.util, json, sys, tempfile, os, types, io, contextlib
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
p = json.loads(sys.argv[1])
fields = {m.AF[k]: v for k, v in p['stored'].items()}
fields.setdefault(m.AF['teamMember'], ['recAgentAaaaaaaaa'])
captured = {}
def fake_patch(task, f):
    captured.setdefault('fields', {}).update(f)
    fields.update(f)
    return {'id': task}
m.patch_task = fake_patch
m.get_task = lambda task: {'id': task, 'fields': json.loads(json.dumps(fields))}
m.ledger_append = lambda *a, **k: None
m.ledger_last_events = lambda: {}
m.finding_details = lambda: {}
m.BROWSER_LEDGER = '/nonexistent/od-test-browser-ledger.jsonl'
m.HANDOVER_DIR = tempfile.mkdtemp()
fh = tempfile.NamedTemporaryFile('w', suffix='.md', delete=False)
fh.write(p['output']); fh.close()
out = {'fieldMap': m.AF}
try:
    with contextlib.redirect_stdout(io.StringIO()):
        if p['op'] == 'escalate':
            m.history = lambda **kw: {'terms': [], 'searched': ['tasks'], 'entries': [], 'notes': []}
            bh = tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False)
            bh.write('WHAT THIS IS:\\nThe lease on the office runs out at the end of the year.\\n\\n'
                     'WHAT HAS HAPPENED:\\nThe landlord wrote on 1 Sep 2026 offering a renewal on the same terms.\\n\\n'
                     'OPTIONS:\\nA. Renew it for another year.\\nB. Let it end and hand the keys back.\\n\\n'
                     'RECOMMENDED: A, because nothing else is lined up.')
            bh.close()
            m.cmd_escalate(types.SimpleNamespace(task='recTESTTESTTEST01', reason='Keep the lease or end it?',
                                                 brief_file=bh.name, plain_task=p['plainTask'], plain_approve=p['plainApprove']))
        elif p['op'] == 'block':
            m.cmd_block(types.SimpleNamespace(task='recTESTTESTTEST01', kind=p['kind'], subject=p['subject'],
                                              why='Kevin asked to go through it himself.', finding=None, steps=p['steps']))
        else:
            m.cmd_submit(types.SimpleNamespace(task='recTESTTESTTEST01', agent=sorted(m.AGENTS)[0], type='Drafting',
                                               output_file=fh.name, tier1=False,
                                               plain_task=p['plainTask'], plain_approve=p['plainApprove']))
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
  const raw = execFileSync('python3', ['-c', script, JSON.stringify({ op, plainTask, plainApprove, output, stored, kind, subject, steps })],
    { encoding: 'utf8', env: { ...process.env, SIGNIN_SKIP_WALK: '1' } });
  return JSON.parse(raw.split('---JSON---')[1]);
}

function lineCheck(lines) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print('---JSON---')
print(json.dumps({k: m.kevin_step_in_line(v) for k, v in json.loads(sys.argv[1]).items()}))
`;
  const raw = execFileSync('python3', ['-c', script, JSON.stringify(lines)], { encoding: 'utf8' });
  return JSON.parse(raw.split('---JSON---')[1]);
}

const TASK = 'Kevin wants to go through a company\'s records before anything is sent to the tax officer.';
const APPROVE = 'The agent keeps the review prompt ready and nothing is sent to the tax officer.';
const BODY = 'The records arrived on 26 October in one folder: a loan account, a trial balance and two bank statements. '.repeat(3);
const CLOSE_UNDECLARED = '**Carrying this out will involve:** Nothing is sent. This job stays open while you run the review chat on the records using the prompt above.';
const CLOSE_CLEAN = '**Carrying this out will involve:** Nothing is sent. The prompt stays on the task and the email to the tax officer comes back as its own card.';
const REVIEW_LINE = 'KEVIN ONLY: review: 1. Paste the prompt above into a new chat in the Money and Legal project. 2. Go through the records with Claude.';
const HIS_ASK = '[2026-10-27 09:24] Can you give me a prompt that we can put into a Claude Code session to go through this information before we submit it?';

describe('the If you approve line says what Approve sets going, never a step of Kevin\'s', () => {
  // Shaped from live approve lines of 27 Oct 2026, with names, places and amounts invented.
  const steps = {
    readyPrompt: 'Nothing is sent. You get a ready prompt to review the records; the email comes back later as its own card.',
    pay: 'You pay £53 on the council\'s page. It goes on the costs list as a one-off.',
    onlyStep: '£35 is approved and the order is set up, so your only step is Pay.',
    phoneStep: 'It becomes your two-minute phone step: switch Backup back on in the photos app.',
    update: 'You update the bank account in the payments site, retry the two bounced payouts and check the next one lands.',
    reminds: 'Nothing is sent. The card reminds you to print the parcel label and drop it at the post office by Friday.',
    bank: 'You agree the standing order goes to £147 a month. The change still has to be made at the bank.',
    andPay: 'You approve the amount and pay the final council tax adjustment for 1 Example Street.',
    roy: 'You or Roy read the quote. The agent compares quotes and recommends one.',
    gerund: 'Kevin updating the bank account registered for the payouts, then retrying the two bounced payouts.',
    getRequest: 'Once the new reader is built you get one sign-in request. The robot then sets up its own access.',
    untilYou: 'Nothing runs until you open one desktop session and paste the line on the card.',
    // The independent review's slips (27 Oct 2026): each passed the first version.
    promptOnCard: 'You get a ready prompt on the card to review the records.',
    approveCardAndPay: 'You approve this card and pay the £53 fee on the council page.',
    checkSignPost: 'The robot fills the form for you to check, sign and post to the council.',
    ifYouSign: 'If you sign it today it goes in tomorrow.',
    meansThat: 'Approve means that you pay £53 on the council page.',
    adverb: 'You personally pay the £53 on the council page.',
    beAsked: "You'll be asked to type the code from the text message.",
    onceYouHave: 'Once you have paid, the robot books the slot.',
    // Round 2 of the review.
    cardsPrompt: "You get the card's prompt to review the records with Claude.",
    checkApproveSign: 'The robot fills it for you to check and approve, then sign and post it.',
  };
  const clean = {
    reply: 'The agent sends one short no-thanks reply and stops answering.',
    email: 'Send a short email confirming the amount and asking whether she pays it or you do.',
    approveCard: 'The robot drafts one email asking for the new policy papers for you to approve.',
    cardBack: 'One email asks for a date. When she answers, you get a card to book.',
    draft: 'Test mode: the episode goes on YouTube as a hidden video and the clips are saved as drafts for you to check.',
    robot: 'The robot fills the quote form for 18 Example Road with your answers.',
    agreeNoun: 'You agree the review and update of your main AI instructions can run when ready.',
    reminderCloses: 'The reminder closes as you decided on the other card today. Nothing is sent.',
    diary: 'A private entry goes in your diary for Monday at 11am. Nobody is emailed.',
    // The rent check's own claim card: approving IS his proof that he sent it.
    approveOnce: "Approve once you have sent it: the rent check notes it and asks for the council's answer in three weeks.",
    asksIf: 'One email asks if you can attend on Friday at 10am.',
    saysYou: 'Her record is updated to say you will write to her again.',
  };

  it('finds the step in every live shape that handed Kevin one', () => {
    const r = lineCheck(steps);
    for (const [k, v] of Object.entries(r)) expect(v, k).not.toBe('');
  });

  it('passes every line that only says what Approve does, an email\'s own words, a card coming back and a draft to look at', () => {
    const r = lineCheck(clean);
    for (const [k, v] of Object.entries(r)) expect(v, k).toBe('');
  });

  it('submit refuses an approve line that hands Kevin a step, and writes nothing', () => {
    const r = run({ plainApprove: steps.readyPrompt });
    expect(r.refused).toBe(true);
    expect(r.error).toContain('--plain-approve gives Kevin a step of his own');
    expect(r.error).toContain('KEVIN ONLY: <payment|purchase|signature|credential|identity|physical|review>');
    expect(r.captured.fields).toBeUndefined();
  });

  it('a decision card is held to the same line', () => {
    const bad = run({ op: 'escalate', plainApprove: steps.onlyStep, stored: { status: 'Today' } });
    expect(bad.refused).toBe(true);
    expect(bad.error).toContain('gives Kevin a step of his own');
    expect(bad.error).toContain('block --kind KEVIN');
    const good = run({ op: 'escalate', plainApprove: 'The lease is renewed for one more year on the same terms.', stored: { status: 'Today' } });
    expect(good.refused, good.error).toBe(false);
  });
});

describe('a step of Kevin\'s in the closing line must be declared, so it comes back to him', () => {
  it('refuses the live shape: the job stays open while he runs the chat, declared nowhere', () => {
    const r = run({ output: `${BODY}\n\n${CLOSE_UNDECLARED}` });
    expect(r.refused).toBe(true);
    expect(r.error).toContain('no KEVIN ONLY line declares it');
    expect(r.error).toContain('while you run the review chat');
    expect(r.captured.fields).toBeUndefined();
  });

  it('a report whose closing line only says Kevin reviews it is refused: it says nothing Approve sets going', () => {
    const r = run({ output: `${BODY}\n\n**Carrying this out will involve:** Kevin reviews the findings and decides.` });
    expect(r.refused).toBe(true);
    expect(r.error).toContain('no KEVIN ONLY line declares it');
  });

  it('a declared step covers its own words only: a second step beside it is still refused', () => {
    const PAY = 'KEVIN ONLY: payment: 1. Open the council page. 2. Pay the £53 fee.';
    const signPost = run({ output: `${BODY}\n\n${PAY}\n\n**Carrying this out will involve:** the robot fills the form, then you sign it and you post it to the council.` });
    expect(signPost.refused).toBe(true);
    expect(signPost.error).toContain('you sign it');
    const chat = run({ output: `${BODY}\n\n${PAY}\n\n${CLOSE_UNDECLARED}` });
    expect(chat.refused).toBe(true);
    expect(chat.error).toContain('while you run the review chat');
    const own = run({ output: `${BODY}\n\n${PAY}\n\n**Carrying this out will involve:** the £53 goes on the costs list, and you pay it on the council page.` });
    expect(own.refused, own.error).toBe(false);
  });

  it('a covered step does not cover the next verb in its clause, a "your part" or a review in its own text', () => {
    const SIGN = 'KEVIN ONLY: signature: 1. Open the email. 2. Sign the agreement.';
    const deposit = run({ output: `${BODY}\n\n${SIGN}\n\n**Carrying this out will involve:** the robot opens the agreement, and you sign it and then pay the deposit by card.` });
    expect(deposit.refused).toBe(true);
    expect(deposit.error).toContain('pay the deposit');
    const part = run({ output: `${BODY}\n\n${SIGN}\n\n**Carrying this out will involve:** the agreement goes out, and your part is the review session with Claude.` });
    expect(part.refused).toBe(true);
    const smuggled = run({ output: `${BODY}\n\nKEVIN ONLY: payment: 1. Pay the £53 fee. 2. Then review the records in a chat with Claude.\n\n`
      + '**Carrying this out will involve:** the fee goes on the list, and you review the records with Claude in a chat.' });
    expect(smuggled.refused).toBe(true);
    // Round 3: a covered step's clause runs on past "no", "in the card", and a payment is not an identity statement.
    const witness = run({ output: `${BODY}\n\n${SIGN}\n\n**Carrying this out will involve:** the agreement opens, and you sign it, no witness needed, and then pay the £500 deposit.` });
    expect(witness.refused).toBe(true);
    const inCard = run({ output: `${BODY}\n\n${SIGN}\n\n**Carrying this out will involve:** the agreement opens, and you sign it in the card and pay the £500 deposit.` });
    expect(inCard.refused).toBe(true);
    const statement = run({ output: `${BODY}\n\nKEVIN ONLY: identity: 1. Give your own statement on the declarations page.\n\n`
      + '**Carrying this out will involve:** the form opens, and you then pay the £400 shown on the statement.' });
    expect(statement.refused).toBe(true);
    const noun = run({ output: `${BODY}\n\nKEVIN ONLY: payment: 1. Pay the £53 fee.\n\n`
      + '**Carrying this out will involve:** the invoice is checked, you pay the £53, and work starts on Monday.' });
    expect(noun.refused, noun.error).toBe(false);
    const yourStep = run({ output: `${BODY}\n\nKEVIN ONLY: physical: 1. Swap the two cameras by hand.\n\n`
      + '**Carrying this out will involve:** the task stays open as your step, with no agent sending, paying or changing anything.' });
    expect(yourStep.refused, yourStep.error).toBe(false);
  });

  it('a purchase covers the declarations that come with it', () => {
    const r = run({ output: `${BODY}\n\nKEVIN ONLY: purchase: buy the chosen policy in one session. 1. Open the window. 2. Buy it.\n\n`
      + '**Carrying this out will involve:** the robot fills the quote form, then you fill in the declarations and buy the policy if it is cheaper.' });
    expect(r.refused, r.error).toBe(false);
  });

  it.each([
    ['the work after it', 'once signed in, the robot opens the letter, then you review the records and sign the declaration.'],
    ['a payment by card', 'once signed in, the robot opens the account, then you pay the £53 with your card.'],
    ['handing over keys', 'once signed in, the robot opens the lease, then you sign the lease and hand over the keys.'],
  ])('a SIGN-IN NEEDED line covers the sign-in, never %s', (_, close) => {
    const r = run({ output: `${BODY}\n\nSIGN-IN NEEDED: Pingen (https://app.pingen.com/)\n\n**Carrying this out will involve:** ${close}` });
    expect(r.refused).toBe(true);
    expect(r.error).toContain('no KEVIN ONLY line declares it');
  });

  it('every KEVIN ONLY line is checked, and a review goes on a card of its own', () => {
    const second = run({ output: `${BODY}\n\nKEVIN ONLY: payment: 1. Pay the £53 fee.\nKEVIN ONLY: quote: get three quotes.\n\n${CLOSE_CLEAN}` });
    expect(second.refused).toBe(true);
    expect(second.error).toContain("names 'quote'");
    const beside = run({ output: `${BODY}\n\nKEVIN ONLY: payment: 1. Pay the £53 fee.\n${REVIEW_LINE}\n\n${CLOSE_CLEAN}`,
      stored: { feedbackHistory: HIS_ASK } });
    expect(beside.refused).toBe(true);
    expect(beside.error).toContain('a KEVIN ONLY review goes on a card of its own');
  });

  it('a closing line that leaves him nothing passes', () => {
    const r = run({ output: `${BODY}\n\n${CLOSE_CLEAN}` });
    expect(r.refused, r.error).toBe(false);
    expect(r.captured.fields[r.fieldMap.status]).toBe('Approval');
  });

  it('a review he asked for is declared as his, and opens the KEVIN wall that brings his Your step card', () => {
    const r = run({ output: `${BODY}\n\n${REVIEW_LINE}\n\n${CLOSE_UNDECLARED}`, stored: { feedbackHistory: HIS_ASK } });
    expect(r.refused, r.error).toBe(false);
    expect(r.captured.fields[r.fieldMap.status]).toBe('Approval');
    expect(r.captured.fields[r.fieldMap.notes]).toMatch(/BLOCKER OPEN \(KEVIN review\)/);
  });

  it.each([
    "Don't send it yet, can we go through it together first?",
    "Hold off without sending anything, let's go through the records in a chat first.",
    'I want to go through this with you before it goes.',
    "Don't send anything; let's go through it in a session first.",
  ])('a real ask beside a "no" about something else still counts: %s', (note) => {
    const r = run({ output: `${BODY}\n\n${REVIEW_LINE}\n\n${CLOSE_CLEAN}`, stored: { feedbackHistory: `[2026-10-20 10:00] ${note}` } });
    expect(r.refused, r.error).toBe(false);
  });

  it('his words in the live note box count as well as the archive', () => {
    const r = run({ output: `${BODY}\n\n${REVIEW_LINE}\n\n${CLOSE_CLEAN}`,
      stored: { approvalFeedback: 'Can we walk through it together before it goes?' } });
    expect(r.refused, r.error).toBe(false);
  });

  it.each([
    ['says no', 'No need for a session or a chat on this one, just send it.'],
    ['asks the agent', 'Please review the figures again.'],
    ['uses the word in passing', 'Chase them for prompt payment.'],
    ['does not want one', "I don't want to go through it together, just send it."],
    ['does not need one', "We don't have to go through it together, it's fine."],
    ['would rather not', "I'd rather not go through it with you, send it as it is."],
  ])('a note that %s is not an ask for a review', (_, note) => {
    const r = run({ output: `${BODY}\n\n${REVIEW_LINE}\n\n${CLOSE_CLEAN}`, stored: { feedbackHistory: `[2026-10-20 10:00] ${note}` } });
    expect(r.refused).toBe(true);
    expect(r.error).toContain("a review step is Kevin's only when his own note on the task asked");
  });

  it('a review he never asked for is refused: the agent does the review and brings what it found', () => {
    const r = run({ output: `${BODY}\n\n${REVIEW_LINE}\n\n${CLOSE_CLEAN}`,
      stored: { feedbackHistory: '[2026-10-20 10:00] Send it as it is.' } });
    expect(r.refused).toBe(true);
    expect(r.error).toContain("a review step is Kevin's only when his own note on the task asked");
    expect(r.captured.fields).toBeUndefined();
  });
});

describe('block takes a review wall only when Kevin asked for one', () => {
  const approved = { approvalOutcome: 'Approved as-is', approvedAt: '2026-10-27T09:30:00.000Z', status: 'Today', notes: '' };

  it('records it when his note asked to go through it', () => {
    const r = run({ op: 'block', stored: { ...approved, feedbackHistory: HIS_ASK } });
    expect(r.refused, r.error).toBe(false);
    expect(r.captured.fields[r.fieldMap.notes]).toMatch(/BLOCKER OPEN \(KEVIN review\)/);
  });

  it('refuses it when no note of his asked', () => {
    const r = run({ op: 'block', stored: approved });
    expect(r.refused).toBe(true);
    expect(r.error).toContain('refusing a KEVIN review wall');
    expect(r.captured.fields).toBeUndefined();
  });
});

// Review round 2 (27 Oct 2026): the new check's cover words live apart from KEVIN_REASON_WORDS,
// because work_handoff_problem reads those, and widening them let these past the older check.
describe('the older closing-line check is no looser than before', () => {
  it.each([
    ['identity', "you will then need to answer the insurer's questions"],
    ['credential', 'you will need to change settings on the bank account and add the payee'],
    ['credential', 'for Kevin to get the token from Google and paste it in'],
    ['purchase', 'you will need to declare the claims history and buy it'],
  ])('a %s step does not cover: %s', (kind, close) => {
    const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
k, c = json.loads(sys.argv[1])
print('---JSON---')
print(json.dumps(m.work_handoff_problem('Report.\\n\\n**Carrying this out will involve:** ' + c, {'reason': k, 'step': '1. Do it. 2. Prove it.'})))
`;
    const raw = execFileSync('python3', ['-c', script, JSON.stringify([kind, close])], { encoding: 'utf8' });
    expect(JSON.parse(raw.split('---JSON---')[1])).not.toBe('');
  });
});
