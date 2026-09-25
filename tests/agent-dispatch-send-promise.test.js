import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// Finding 20260923-agent-dispatch-586 (25 Sep 2026). submit refuses a card whose
// closing line promises an email when its Task Type is not Correspondence, because
// send-email.py sends nothing else. The pattern missed the wording agents use, so
// three approved cards could never be sent. These are their real closing lines,
// and the look-alikes the 765-line back-test showed must stay out.
const out = (tail) => `Body.\n\n**Carrying this out will involve:** ${tail}`;
const LINES = {
  pib: 'sending the acknowledgement reply to Monika at PIB Insurance. Kevin has chosen the TopCashback route instead of renewing with PIB direct.',
  siddows: 'Kevin approves the email, then it goes to the council asking for the 12-month empty-property exemption for 18 Siddows Avenue.',
  lcs: 'Kevin approving this draft response to LCS, confirming the reply email from the physical letter, then the response being sent either by email or Pingen post.',
  nothing: 'Nothing changes or gets sent, this just checked old records to answer Kevin\'s question.',
  noResponse: 'Nothing further. Kevin has decided no response will be sent to Square.',
  without: 'closing this task without sending any reply, as this is an unsolicited cold sales pitch.',
  imessage: 'sending this iMessage reply to SSE via the osascript channel, noting the restraint order position.',
  another: 'approving the Gate 2 email in the companion task, which sends Ciara\'s signed Letter of Authority to CreditStyle.',
  // second review, 25 Sep 2026: the first widening let these three through
  before: 'checking the balance before sending the reply to Barclaycard.',
  or: 'updating the record or sending the reply to the council.',
  textAndEmail: 'a text message to Roy and sending the email to the council.',
  // and these are not our send
  supplier: 'the invoice will be sent by the supplier.',
  condition: 'this chase task closes when that email is sent.',
};

function problems(type) {
  return JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
lines = ${JSON.stringify(Object.fromEntries(Object.entries(LINES).map(([k, v]) => [k, out(v)])))}
print(json.dumps({k: bool(m.send_promise_problem(v, ${JSON.stringify(type)})) for k, v in lines.items()}))`], { encoding: 'utf8' }));
}

describe('a promise to send an email needs a Correspondence card', () => {
  it('the three stuck cards are refused as Admin/Analysis; denials, iMessage and another task\'s email are not', () => {
    expect(problems('Analysis')).toEqual({
      pib: true, siddows: true, lcs: true, before: true, or: true, textAndEmail: true,
      nothing: false, noResponse: false, without: false, imessage: false, another: false,
      supplier: false, condition: false,
    });
  });

  it('a Correspondence card is never refused by this check', () => {
    expect(Object.values(problems('Correspondence')).some(Boolean)).toBe(false);
  });
});
