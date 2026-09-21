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

// THE ROUND NUMBER (21 Sep 2026). submit numbered a redo by counting every
// "FEEDBACK ANSWERED" in Notes, which also holds TRACK RECORD lines copied from
// the task history, some from other tasks. On 21 Sep 63 of 109 live tasks were
// misnumbered and rec0D35XfxR2QgvIX's first receipt went out as round 7. Only
// the receipt blocks the task wrote itself count.
const OWN = 'recOwnTaskAAAA001';
const FOREIGN = 'recForeignTask001';
const LINK = 'https://airtable.com/appnqjDpqDniH3IRl/tblqB8b22hKBL4PF1/';
const TWO_OWN_RECEIPTS = [
  '[09 Sep 2026 — create-agent-task] TRACK RECORD: (searched tasks for ref 3-BED)',
  `- 08 Sep 2026 12:31 — agent-dispatch: FEEDBACK ANSWERED (round 7): (${LINK}${FOREIGN})`,
  `- 08 Sep 2026 12:31 — agent-dispatch: SUBMITTED (round 1) as Admin with no new file (${LINK}${FOREIGN})`,
  `- 08 Sep 2026 12:40 — agent-dispatch: FEEDBACK ANSWERED (round 1):`,
  '',
  '[15 Sep 2026 10:11 — agent-dispatch] FEEDBACK ANSWERED (round 1):',
  '- check the bedrooms → 5 bedrooms across 2 units',
  '',
  '[15 Sep 2026 10:11 — agent-dispatch] SUBMITTED (round 1) as Drafting with no new file',
  '',
  '[15 Sep 2026 12:24 — agent-dispatch] FEEDBACK ANSWERED (round 2):',
  '- resend it → resent with the corrected count',
  '',
  '[15 Sep 2026 12:24 — agent-dispatch] SUBMITTED (round 2) as Drafting with no new file',
].join('\n');

describe('the redo round counts only this task\'s own receipts', () => {
  it('a redo submit over a copied foreign trail line and two own receipts writes round 3', () => {
    const redoFeedback = 'The number of bedrooms is still wrong on this draft. Check the Rental Units table and correct the email before resending it.';
    const out = j(`
import types, tempfile, os, io, contextlib
captured = {}
def fake_patch(t, f):
    captured['fields'] = f
    return {'id': t}
ad.patch_task = fake_patch
def fake_get(t):
    f = {ad.AF['notes']: ${JSON.stringify(TWO_OWN_RECEIPTS)}, ad.AF['approvalOutcome']: 'Changes requested',
         ad.AF['approvalFeedback']: ${JSON.stringify(redoFeedback)}, ad.AF['agentOutput']: 'The old draft.'}
    f.update(captured.get('fields', {}))
    return {'id': t, 'fields': f}
ad.get_task = fake_get
ad.supersede_attachments = lambda *a, **k: []
ad.upload_attachment = lambda *a, **k: 'x'
ad.load_login_sites = lambda: {}
def tmp(text):
    fh = tempfile.NamedTemporaryFile('w', suffix='.md', delete=False)
    fh.write(text)
    fh.close()
    return fh.name
draft = tmp('The new draft, with 5 bedrooms across 2 units.')
receipt = tmp('- The number of bedrooms is still wrong on this draft → now 5 across 2 units, read from Rental Units\\n- Check the Rental Units table and correct the email before resending it → done, email corrected')
with contextlib.redirect_stdout(io.StringIO()):
    ad.cmd_submit(types.SimpleNamespace(task=${JSON.stringify(OWN)}, agent=sorted(ad.AGENTS)[0], type='Drafting',
                                        output_file=draft, tier1=False, receipt=receipt))
os.unlink(draft)
os.unlink(receipt)
print(json.dumps(captured['fields'][ad.AF['notes']]))`);
    const added = out.slice(TWO_OWN_RECEIPTS.length);
    expect(added).toMatch(/\] FEEDBACK ANSWERED \(round 3\):\n- The number of bedrooms/);
    expect(added).not.toMatch(/round [4-9]\):/);
  });

  it('trail lines, including ones about this task, never count; a header naming another record never counts', () => {
    const r = j(`print(json.dumps([
  ad.receipt_round("", ${JSON.stringify(OWN)}),
  ad.receipt_round(${JSON.stringify(TWO_OWN_RECEIPTS)}, ${JSON.stringify(OWN)}),
  ad.receipt_round("- 15 Sep 2026 13:22 — agent-dispatch: FEEDBACK ANSWERED (round 9): (${LINK}${OWN})", ${JSON.stringify(OWN)}),
  ad.receipt_round("[15 Sep 2026 13:22 — agent-dispatch] FEEDBACK ANSWERED (round 9): (${LINK}${FOREIGN})\\n- a → b", ${JSON.stringify(OWN)}),
  ad.receipt_round("[15 Sep 2026 13:22 — agent-dispatch] FEEDBACK ANSWERED (round 9): (${LINK}${OWN})\\n- a → b", ${JSON.stringify(OWN)}),
]))`);
    expect(r).toEqual([1, 3, 1, 1, 2]);
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
