import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Two approved cards whose send was refused by the email parser (18 Nov 2026). Each finding has its own tests.
// They drive the real scripts/agent_email_format.py. Names, numbers and amounts are invented.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function py(body) {
  const out = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
import agent_email_format as f
${body}`], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('finding 20261118-agent-dispatch-1355: the rent lane arrears card may be texted', () => {
  it('a RENT ARREARS card is a rent lane tenant card; other cards still are not', () => {
    const r = py(`print(json.dumps([
  f.text_card(name="RENT ARREARS: Unit 2 – 1 Example Place, rent due 31 Oct unpaid"),
  f.text_card(name="RENT LATE: Flat 1 – 2 Example Road"),
  f.text_card(name="INBOUND: tenant asks about arrears"),
  f.text_card(name="Chase: RENT ARREARS: written mid-name")]))`);
    expect(r).toEqual([true, true, false, false]);
  });
});

describe("finding 20261117-agent-dispatch-1337: a SPEND line closing the email belongs to the card, not the email", () => {
  const EMAIL = (tail) => `TO: bookings@example-gas.test\nFROM: info@agilelets.co.uk\nSUBJECT: Gas safety check, 1 Example Place\n---\nHello,\n\nPlease book the annual gas safety check for 1 Example Place.\n\nKind regards,\nRoy Lavin\nAgile Lets${tail}`;
  it('a trailing SPEND line is taken off the email, and the email is otherwise whole', () => {
    const r = py(`
out = f.parse_output(${JSON.stringify(EMAIL('\nSPEND: £59 (one gas safety check)'))})
print(json.dumps({"body": out["body"] if isinstance(out, dict) else out[3]}))`);
    expect(r.body).not.toMatch(/SPEND/);
    expect(r.body).toMatch(/Roy Lavin\nAgile Lets$/);
  });

  it('a SPEND line anywhere else in the email is still refused', () => {
    const r = py(`
try:
    f.parse_output(${JSON.stringify(EMAIL('').replace('Kind regards', 'SPEND: £59\n\nKind regards'))})
    print(json.dumps("accepted"))
except f.EmailFormatError as e:
    print(json.dumps(str(e)))`);
    expect(r).toMatch(/a SPEND line sits inside the email/);
  });
});
