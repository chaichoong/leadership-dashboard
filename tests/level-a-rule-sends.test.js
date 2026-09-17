import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── THE THREE NARROW LEVEL A SHAPES (Kevin, 17 Sep 2026) ───────────────────
//
// Kevin's tranche 3 rulings: a redirect reply to property mail at his Gmail, a
// quote request for a statutory certificate, and an automated plan instalment
// need no card. Two of them SEND EMAIL without his tap, which the send gate
// was built to prevent, so each is verified in code and anything off-shape
// stays a card. send-email.py re-checks the same rule at send time (its own
// selftest carries those refusal cases).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SEND = resolve(ROOT, 'scripts/send-email.py');

function py(snippet) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
AF = m.AF
def rec(name, desc="", notes="", inbound=False, sender=""):
    return {"id": "recTASK000000001", "fields": {AF["name"]: name, AF["description"]: desc,
            AF["notes"]: notes, AF["inboundTask"]: inbound, AF["inboundSender"]: sender}}
def lv(output, task_type, r, plans=None):
    x = m.decision_level(output, task_type, r, fetch=lambda i: {}, plans_fetch=lambda: plans or [])
    return [x["level"], x["category"], x.get("carry", ""), x.get("rule", "")]
TAIL = "\\n**Carrying this out will involve:** done."
QUOTE = ("TO: jobs@spark.example\\nFROM: info@agilelets.co.uk\\nSUBJECT: EICR quote request - 5 Dalham Place, CB9 0AL\\n---\\n"
         "Hello,\\n\\nCould you quote for an EICR at 5 Dalham Place, CB9 0AL?\\n\\nKind regards,\\nRoy Lavin\\nAgile Lets")
EICR = "COMPLIANCE: EICR renewal due 2026-10-14 - 5 Dalham Place"
${snippet}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());
}

describe('redirect reply: fixed text, only to the inbound sender, property mail only', () => {
  it('acts on property mail and cards everything else', () => {
    const out = py(`print(json.dumps({
  "ok": lv("REDIRECT TO INFO@" + TAIL, "Correspondence", rec("INBOUND: repair request - kitchen tap leak at 6 Chedburgh Place", inbound=True, sender="Jane Cole <jane@example.com>")),
  "notInbound": lv("REDIRECT TO INFO@" + TAIL, "Correspondence", rec("MAINTENANCE: kitchen tap - 6 Chedburgh Place", sender="jane@example.com")),
  "notProperty": lv("REDIRECT TO INFO@" + TAIL, "Correspondence", rec("INBOUND: dinner invitation from Sam", inbound=True, sender="sam@example.com")),
  "noSender": lv("REDIRECT TO INFO@" + TAIL, "Correspondence", rec("INBOUND: repair request - kitchen tap leak at 6 Chedburgh Place", inbound=True)),
  "ownAddress": lv("REDIRECT TO INFO@" + TAIL, "Correspondence", rec("INBOUND: boiler repair - 6 Chedburgh Place", inbound=True, sender="roy.lavin1978@gmail.com")),
  "email": m.redirect_email(rec("INBOUND: kitchen tap dripping - 6 Chedburgh Place", sender="Jane <jane@example.com>")["fields"]),
}))`);
    expect(out.ok).toEqual(['A', 'redirect reply', 'send-rule', 'redirect']);
    expect(out.notInbound[0]).toBe('B');
    expect(out.notProperty[0]).toBe('B');
    expect(out.noSender[0]).toBe('B');
    expect(out.ownAddress[0]).toBe('B');
    expect(out.email).toContain('TO: jane@example.com');
    expect(out.email).toContain('SUBJECT: Re: kitchen tap dripping - 6 Chedburgh Place');
  });
});

describe('quote request: coverage checked, from info@, signed Roy Lavin, no commitment', () => {
  it('acts only when every condition holds', () => {
    const out = py(`
cov = "COVERAGE CHECKED: CB9 (5 Dalham Place) within Spark Electrical covers CB9"
print(json.dumps({
  "ok": lv(QUOTE + TAIL, "Correspondence", rec(EICR, notes=cov)),
  "noCoverage": lv(QUOTE + TAIL, "Correspondence", rec(EICR)),
  "notCertificate": lv(QUOTE + TAIL, "Correspondence", rec("COMPLIANCE: HMO inspection 22 Sep 2026 - 13 Chedburgh Place", notes=cov)),
  "fromGmail": lv(QUOTE.replace("info@agilelets.co.uk", "kevinbrittain@gmail.com") + TAIL, "Correspondence", rec(EICR, notes=cov)),
  "commits": lv(QUOTE + "\\nPlease book it in for Monday." + TAIL, "Correspondence", rec(EICR, notes=cov)),
  "notQuote": lv(QUOTE.replace("EICR quote request", "EICR booking") + TAIL, "Correspondence", rec(EICR, notes=cov)),
  "fourTo": lv(QUOTE.replace("TO: jobs@spark.example", "TO: a@x.com, b@x.com, c@x.com, d@x.com") + TAIL, "Correspondence", rec(EICR, notes=cov)),
}))`);
    expect(out.ok).toEqual(['A', 'quote request', 'send-rule', 'quote-request']);
    for (const k of ['noCoverage', 'notCertificate', 'fromGmail', 'commits', 'notQuote', 'fourTo']) {
      expect(out[k][0], k).toBe('B');
    }
  });
});

describe('automated plan instalment: tier 1 closes only on an exact record-book match', () => {
  it('closes on Plan agreed at the collected amount and cards any warning', () => {
    const out = py(`
plans = [{"creditor": "Together", "status": "Plan agreed", "monthlyAmount": 85},
         {"creditor": "Lowell", "status": "Frozen", "monthlyAmount": 40}]
name = "INBOUND: Together payment arrangement - instalment collected"
ok_desc = "Your monthly instalment of £85.00 was collected by direct debit on 15 Sep 2026."
print(json.dumps({
  "ok": lv("CLOSE PROPOSAL: plan instalment Together £85" + TAIL, "Admin", rec(name, ok_desc), plans),
  "wrongAmount": lv("CLOSE PROPOSAL: plan instalment Together £95" + TAIL, "Admin", rec(name, ok_desc.replace("85.00", "95.00")), plans),
  "missed": lv("CLOSE PROPOSAL: plan instalment Together £85" + TAIL, "Admin", rec(name, ok_desc + " A previous payment was missed."), plans),
  "notAgreed": lv("CLOSE PROPOSAL: plan instalment Lowell £40" + TAIL, "Admin", rec("INBOUND: Lowell instalment collected", "£40.00 collected by direct debit"), plans),
  "tier1Other": lv("Draft reply to Lowell" + TAIL, "Correspondence", rec("INBOUND: Lowell Solicitors letter before action", "court proceedings")),
}))`);
    expect(out.ok.slice(0, 3)).toEqual(['A', 'close: plan instalment', 'close']);
    expect(out.wrongAmount[0]).toBe('B');
    expect(out.missed[0]).toBe('B');
    expect(out.notAgreed[0]).toBe('B');
    expect(out.tier1Other[0]).toBe('C');
  });
});

describe('the send gate re-checks every rule at send time', () => {
  it('passes its selftest, including the rule refusals', () => {
    const out = execFileSync('python3', [SEND, 'selftest'], { encoding: 'utf8' });
    expect(out).toMatch(/selftest OK/);
    expect((out.match(/PASS rule:/g) || []).length).toBe(13);
  });

  it('the coverage marker the rule reads is the one submit writes', () => {
    const src = readFileSync(DISPATCH, 'utf8');
    const fmt = readFileSync(resolve(ROOT, 'scripts/agent_email_format.py'), 'utf8');
    const a = src.match(/^COVERAGE_MARK = "([^"]+)"/m)[1];
    const b = fmt.match(/^RULE_COVERAGE_MARK = "([^"]+)"/m)[1];
    expect(b).toBe(a);
  });
});
