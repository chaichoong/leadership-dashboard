import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Kevin's workflow, 28 Aug 2026, in his words:
//   "They would create the PDF and show me it for approval. They would then
//    send it off to be signed... Once it comes back, they would then show me
//    that document with the email correspondence ready to go, and I would then
//    confirm it. They would then send it off."
//
// That is TWO gates, and the second is a different shape from the first.
// Correspondence used to mean email and nothing else, so the submit gate
// refused a postal letter outright and an agent could not put a letter in front
// of him at all. Three shapes now exist, in ONE module, because two scripts
// that had to agree on a format once did not.
function py(code) {
  return execFileSync('python3', ['-c',
    `import sys;sys.path.insert(0,'${ROOT}/scripts')\n` + code],
    { encoding: 'utf8', cwd: ROOT }).trim();
}

const POST = ['POST:', 'Corporation Tax', 'HM Revenue and Customs', 'BX9 1AX',
  'United Kingdom', 'DOCUMENT: ~/knowledge-os/attachments/hmrc.pdf', '---',
  'Asks HMRC to hold enforcement.'].join('\\n');
const SIGN = ['DOCUMENT: ~/knowledge-os/attachments/loa.pdf',
  'SIGNERS: kevinbrittain@gmail.com', '---',
  'Authorises the adviser to speak to HMRC on your behalf.'].join('\\n');
const EMAIL = ['TO: a@b.com', 'FROM: kevinbrittain@gmail.com', 'SUBJECT: Hi',
  '---', 'Body.'].join('\\n');

describe('the three Correspondence shapes', () => {
  it('detects each shape', () => {
    const out = py(`from agent_email_format import detect_kind
print(detect_kind("${POST}"), detect_kind("${SIGN}"), detect_kind("${EMAIL}"))`);
    expect(out).toBe('post sign email');
  });

  // The regression that blocked the whole workflow.
  it('the submit gate now ACCEPTS a postal letter', () => {
    const out = py(`from agent_email_format import validate_submission_any
r = validate_submission_any("${POST}")
print(r["kind"], r["address"][0], r["delivery"])`);
    expect(out).toBe('post Corporation Tax cheap');
  });

  it('the submit gate accepts a document going for signature', () => {
    const out = py(`from agent_email_format import validate_submission_any
r = validate_submission_any("${SIGN}")
print(r["kind"], r["signers"][0])`);
    expect(out).toBe('sign kevinbrittain@gmail.com');
  });

  it('email keeps its own strict rules', () => {
    // No FROM: refused, because Kevin corrected that by hand 11 times.
    const out = py(`from agent_email_format import validate_submission_any, EmailFormatError
try:
    validate_submission_any("TO: a@b.com\\nSUBJECT: Hi\\n---\\nBody.")
    print("ACCEPTED")
except EmailFormatError as e:
    print("REFUSED" if "FROM" in str(e) else "OTHER")`);
    expect(out).toBe('REFUSED');
  });

  // Approving a filename is not consent to a document's contents. Kevin's own
  // ruling on the approval surface.
  it('refuses a letter or a signature request with no summary', () => {
    const noBody = ['POST:', 'A Name', 'A Street', 'AB1 2CD',
      'DOCUMENT: ~/a.pdf', '---', ''].join('\\n');
    const out = py(`from agent_email_format import validate_submission_any, EmailFormatError
for t in ["${noBody}", "DOCUMENT: ~/a.pdf\\nSIGNERS: k@b.com\\n---\\n"]:
    try:
        validate_submission_any(t); print("ACCEPTED", end=" ")
    except EmailFormatError: print("REFUSED", end=" ")`);
    expect(out).toBe('REFUSED REFUSED');
  });

  // The defect that put six real HMRC letters in the returned pile.
  it('refuses a bare "To:" line in the address block', () => {
    const bad = ['POST:', 'To:', 'Corporation Tax', 'HM Revenue and Customs',
      'BX9 1AX', 'DOCUMENT: ~/a.pdf', '---', 'x'].join('\\n');
    const out = py(`from agent_email_format import validate_submission_any, EmailFormatError
try:
    validate_submission_any("${bad}"); print("ACCEPTED")
except EmailFormatError as e:
    print("REFUSED" if "To:" in str(e) else "OTHER")`);
    expect(out).toBe('REFUSED');
  });

  // One parser, not two. This module exists because two scripts that had to
  // agree on a format did not, and the carry-out failed days after approval.
  it('send-letter.py uses the shared parser rather than its own', () => {
    const out = py(`src = open("${ROOT}/scripts/send-letter.py").read()
print("shared" if "from agent_email_format import" in src else "OWN",
      "dup" if "class LetterFormatError" in src else "single")`);
    expect(out).toBe('shared single');
  });
});
