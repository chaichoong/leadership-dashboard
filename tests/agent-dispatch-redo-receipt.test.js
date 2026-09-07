import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SRC = readFileSync(DISPATCH, 'utf8');

// THE REDO RECEIPT and THE REPORT GATE (Kevin, 7 Sep 2026).
//
// Measured that day: 30 of 132 feedback tasks went round twice or more, 13
// three or more ("changes haven't been understood"); 61% of reports reaching
// the gate were rejected on the triage five questions; and 32% of Feedback
// History blocks were exact duplicates because two writers archived the same
// words with different stamps. All three are now decided in code, and these
// tests drive the real Python.

function py(code) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("ad", ${JSON.stringify(DISPATCH)})
ad = importlib.util.module_from_spec(spec)
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec.loader.exec_module(ad)
${code}
`;
  return execFileSync('/usr/bin/python3', ['-c', script], { encoding: 'utf8' }).trim();
}
const j = (code) => JSON.parse(py(code));

const FEEDBACK = 'This is incorrect. You need to check the property details in Operations Director and look at Number of Bedrooms. Then revise the email response and resend it to me for approval.';

describe('the redo receipt', () => {
  it('splits Kevin\'s feedback into the points that need answering (short fragments are not points)', () => {
    const pts = j(`print(json.dumps(ad.feedback_points(${JSON.stringify(FEEDBACK)})))`);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toMatch(/Number of Bedrooms/);
  });
  it('a redo with no receipt is refused, and the error names his points', () => {
    const p = py(`print(ad.receipt_problem("", ${JSON.stringify(FEEDBACK)}, "old", "new"))`);
    expect(p).toMatch(/no receipt/);
  });
  it('a receipt with fewer lines than his points is refused', () => {
    const p = py(`print(ad.receipt_problem("- checked bedrooms → now 4", ${JSON.stringify(FEEDBACK)}, "old", "new"))`);
    expect(p).toMatch(/answers 1 point\(s\) but Kevin made 2/);
  });
  it('a redo whose text is identical to what he sent back is refused', () => {
    const p = py(`print(ad.receipt_problem("- bedrooms → now 4\\n- resend → done", ${JSON.stringify(FEEDBACK)}, "same  text", "same text"))`);
    expect(p).toMatch(/nothing changed/);
  });
  it('a full receipt with a change per point passes, and "cannot" counts as an answer', () => {
    const p = py(`print(repr(ad.receipt_problem("- check Number of Bedrooms → 6 Chedburgh Place has 5 bedrooms across 2 units; email now says 5\\n- resend for approval -> cannot: the sender has since withdrawn the quote", ${JSON.stringify(FEEDBACK)}, "old", "new")))`);
    expect(p).toBe("''");
  });
  it('the receipt block is stamped, numbered and one line per point', () => {
    const b = py(`print(ad.receipt_block("- a → b\\n- c -> d", 2, "07 Sep 2026 12:00"))`);
    expect(b).toBe('[07 Sep 2026 12:00 — agent-dispatch] FEEDBACK ANSWERED (round 2):\n- a → b\n- c → d');
  });
  it('submit refuses a Changes-requested resubmit without --receipt and writes the receipt into Notes', () => {
    expect(SRC).toMatch(/if stored_outcome == "Changes requested" and prior:/);
    expect(SRC).toMatch(/problem = receipt_problem\(receipt_text, prior, stored_output, output\)\n\s+if problem:\n\s+sys\.exit\(/);
    expect(SRC).toMatch(/tf\["_receiptAdded"\] = True/);
    expect(SRC).toMatch(/if tf\.get\("_receiptAdded"\):\n\s+fields\[AF\["notes"\]\]/);
  });
});

describe('the archive is written once', () => {
  it('the same words already archived under another stamp are not archived again', () => {
    const r = j(`print(json.dumps([ad.feedback_archived("[2026-09-04 12:03] Check the bedrooms.\\n\\n[2026-09-04 19:08] Check the bedrooms.", "Check   the bedrooms."), ad.feedback_archived("[2026-09-04 12:03] Check the bedrooms.", "Something new"), ad.feedback_archived("", "")]))`);
    expect(r).toEqual([true, false, true]);
  });
  it('submit consults it instead of comparing stamped blocks', () => {
    expect(SRC).toMatch(/if not feedback_archived\(hist, prior\):/);
    expect(SRC).not.toMatch(/if block not in hist:/);
  });
});

describe('the report gate', () => {
  const ok = 'CHECKED: handled=no; roy=no; machine=no; open-task=no; trigger=deadline\n\nThe council wants the EICR by 26 Sep.\n\n**Carrying this out will involve:** sending the quote request.';
  it('a report on an inbound item with no CHECKED line is refused', () => {
    const p = py(`print(ad.checked_problem("Findings...", "Analysis", True))`);
    expect(p).toMatch(/must open with the five questions answered/);
  });
  it('not inbound, or Correspondence, or an exempt shape, needs no line', () => {
    const r = j(`print(json.dumps([ad.checked_problem("Findings", "Analysis", False), ad.checked_problem("TO: a@b.com", "Correspondence", True), ad.checked_problem("CLOSE PROPOSAL: duplicate of recX", "Admin", True), ad.checked_problem("PASS TO ROY: boiler", "Admin", True), ad.checked_problem("CALENDAR:\\nTITLE: x", "Admin", True)]))`);
    expect(r).toEqual(['', '', '', '', '']);
  });
  it('a yes on any of the first four is not a report', () => {
    const p = py(`print(ad.checked_problem("CHECKED: handled=yes; roy=no; machine=no; open-task=no; trigger=none", "Analysis", True))`);
    expect(p).toMatch(/handled=yes.*propose the close/);
    const p2 = py(`print(ad.checked_problem("CHECKED: handled=no; roy=yes; machine=no; open-task=no; trigger=none", "Admin", True))`);
    expect(p2).toMatch(/PASS TO ROY/);
  });
  it('a missing key or an unknown trigger is refused', () => {
    expect(py(`print(ad.checked_problem("CHECKED: handled=no; trigger=money", "Analysis", True))`)).toMatch(/missing roy, machine, open-task/);
    expect(py(`print(ad.checked_problem("CHECKED: handled=no; roy=no; machine=no; open-task=no; trigger=vibes", "Analysis", True))`)).toMatch(/not one of/);
  });
  it('a named trigger passes and is read back for the card; other:<why> is allowed', () => {
    expect(py(`print(repr(ad.checked_problem(${JSON.stringify(ok)}, "Research", True)))`)).toBe("''");
    expect(py(`print(ad.checked_trigger(${JSON.stringify(ok)}))`)).toBe('deadline');
    expect(py(`print(repr(ad.checked_problem("CHECKED: handled=no | roy=no | machine=no | open-task=no | trigger=other: tenant is vulnerable", "Admin", True)))`)).toBe("''");
  });
  it('trigger=none files the report instead of queuing it, never on a tier-1 matter', () => {
    expect(SRC).toMatch(/checked_trigger\(output\) == "none" and not is_tier1:\n\s+files_itself = True/);
    expect(SRC).toMatch(/checked = checked_problem\(output, args\.type, is_inbound\)\n\s+if checked:\n\s+sys\.exit\(/);
  });
});
