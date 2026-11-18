// What Kevin has ruled out of anything sent, refused at submit (16 Nov 2026, the 13 Nov estate review:
// a rule code can enforce is a refusal in code, never a lesson the robots keep breaking).
//
//   - No placeholders (creditor-management lessons, 27 and 28 Aug 2026): a letter of authority reached his
//     queue carrying "[Kevin's home address - confirm before approving]".
//   - No em dash in anything that goes out (4 Sep 2026).
//   - Mail signed Roy Lavin is written as Roy (property-administration lesson, 22 Oct 2026: "the email is
//     signed off by Roy, so you can't write it as if Roy is in the third person").
//   - A tenant mail-out never shows its recipients each other (30 Sep 2026).
//
// Back-tested read-only on 16 Nov 2026 against 1,074 distinct outputs (530 stored Correspondence outputs
// and 544 run-folder drafts; 832 of them passed origin/main's gate): 50
// newly refused (29 em dashes, 15 Roy in the third person, 5 placeholders, 1 em dash in a posted
// letter), none of them correct copy. Three shapes the first draft refused were the other side's words
// and are pinned below as passes: a subject tag ("[SMS]", "[EXTERNAL]", "[Quote Ref: ...]"), a details
// line naming the managing agent, and "Roy here."
//
// Every name, address, reference and amount below is invented (this repo is public). The harness blocks
// the network before the module loads. Each case drives the real validate_submission_any.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = process.env.AEF_SCRIPTS || path.join(ROOT, 'scripts');

const PY = `
import json, socket, sys, urllib.request
def _no_network(*a, **k):
    raise RuntimeError("network blocked in this test")
socket.create_connection = _no_network
socket.socket.connect = _no_network
urllib.request.urlopen = _no_network
sys.path.insert(0, sys.argv[1])
import agent_email_format
from agent_email_format import validate_submission_any, EmailFormatError
args = json.loads(sys.argv[2])
if args.get("inbound"):
    agent_email_format.INBOUND_ATTACHMENTS = args["inbound"]
try:
    validate_submission_any(args["output"], **({"task_name": args["task"]} if args.get("task") is not None else {}))
    print(json.dumps({"ok": True}))
except EmailFormatError as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`;

function check(output, task, inbound) {
  const raw = execFileSync('python3', ['-c', PY, SCRIPTS, JSON.stringify({ output, task, inbound })], { encoding: 'utf8' });
  return JSON.parse(raw.trim());
}

const KEVIN = (body, head = 'TO: accounts@example-energy.test\nFROM: kevinbrittain@gmail.com\nSUBJECT: Account 4455 6677') =>
  `${head}\n---\n${body}\n\nKind regards\nKevin Brittain\n\n**Carrying this out will involve:** sending this email.`;
const ROY = (body, head = 'TO: office@example-sparks.test\nFROM: info@agilelets.co.uk\nSUBJECT: EICR at 9 Example Road') =>
  `${head}\n---\n${body}\n\nKind regards\nRoy Lavin\nAgile Lets\n\n**Carrying this out will involve:** sending this email.`;

describe('no placeholder in an email body (27 and 28 Aug 2026)', () => {
  it('refuses a square-bracket, angle-bracket or marker placeholder', () => {
    for (const body of [
      'Dear Sir or Madam,\n\nRe: account [reference]. Please confirm the balance.',
      'Dear Sir or Madam,\n\nPlease write to me at <home address>.',
      'Dear Sir or Madam,\n\nI can offer [£X] a month from next month.',
      'Dear Sir or Madam,\n\nThe property has XXXX bedrooms.',
      'Dear Sir or Madam,\n\nThe visit date is TBC.',
      'Dear Sir or Madam,\n\n[INSERT BEDROOM COUNT] bedrooms, all let.',
      // A note for Kevin left inside what is sent, the shape found on a stored creditor card.
      '[ CREDITOR BRIEF - for your approval box only, not sent ]\n\nDear Sir or Madam,\n\nI write about the order.',
    ]) {
      const r = check(KEVIN(body));
      expect(r.ok, body).toBe(false);
      expect(r.error, body).toMatch(/placeholder/);
    }
  });

  it('passes the email\'s own brackets: a link, an address, a web link, and quoted mail below', () => {
    // The control: the same kind of email with a value never found IS refused.
    expect(check(KEVIN('Hi Sam,\n\nPlease fill in the form for account [reference].')).ok).toBe(false);
    for (const body of [
      'Hi Sam,\n\nPlease fill in [the short form](https://forms.example.test/abc) when you can.',
      'Hi Sam,\n\nPlease reply to <billing@example-energy.test> or see <https://example-energy.test/help>.',
      'Hi Sam,\n\nThank you. Please insert the key in the lockbox after the visit.',
      'Hi Sam,\n\nThanks for this.\n\nOn Mon, 9 Nov 2026 at 10:00, Sam Example <sam@example-energy.test> wrote:\n> [cid:image001.png] Your ref [TBC] XXXX',
    ]) {
      const r = check(KEVIN(body));
      expect(r, body).toEqual({ ok: true });
    }
  });

  it('reads a subject the agent wrote, never a reply\'s or a forward\'s (back-test: 12 false refusals on replies)', () => {
    const head = (subject) => `TO: accounts@example-energy.test\nFROM: kevinbrittain@gmail.com\nSUBJECT: ${subject}`;
    // Review of PR 951: an agent's own subject carried "[TENANT NAME]" or an em dash and passed.
    for (const subject of ['Arrears for [TENANT NAME]', 'Rent \u2014 9 Example Road', 'EICR quote request \u2014 9 Example Road']) {
      const r = check(KEVIN('Hi Sam,\n\nThank you, that is fine.', head(subject)));
      expect(r.ok, subject).toBe(false);
      expect(r.error, subject).toMatch(/^the subject (still carries a placeholder|carries an em dash)/);
    }
    // A reply or forward keeps the other side's subject so it threads: their tags and dashes stay.
    for (const subject of ['Re: [EXTERNAL] Rent at 9 Example Road', 'Re: Renewal [Quote Ref: 123456789]',
      'RE: Account 4455 \u2014 9 Example Road', 'Fwd: Notice \u2014 9 Example Road', 'Fw: [SMS] Unit 2']) {
      const r = check(KEVIN('Hi Sam,\n\nThank you, that is fine.',
        `TO: accounts@example-energy.test\nFROM: kevinbrittain@gmail.com\nSUBJECT: ${subject}`));
      expect(r, subject).toEqual({ ok: true });
    }
  });
});

describe('no em dash in anything that goes out (4 Sep 2026)', () => {
  it('refuses an em dash in the sender\'s own words', () => {
    const r = check(KEVIN('Dear Sir or Madam,\n\nRe: account 4455 6677 — 9 Example Road, Exampletown.'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/em dash/);
  });

  it('passes an en dash, a hyphen, and an em dash only in the quoted reply below', () => {
    // The control: the same reply with the em dash in its own words is refused.
    expect(check(KEVIN('Hi Sam,\n\nThanks \u2014 noted.\n\n-----Original Message-----\nFrom: Sam\nWe will call soon.')).ok).toBe(false);
    expect(check(KEVIN('Dear Sir or Madam,\n\nUnit 1 – 9 Example Road, and a well-kept garden.'))).toEqual({ ok: true });
    expect(check(KEVIN('Hi Sam,\n\nThanks, noted.\n\n-----Original Message-----\nFrom: Sam\nWe will call — soon.'))).toEqual({ ok: true });
  });
});

describe('mail signed Roy Lavin is written as Roy (22 Oct 2026)', () => {
  it('refuses Roy in the third person above his own sign-off', () => {
    for (const body of [
      'Hello Jordan,\n\nPlease send two or three dates. Roy is copied in and will arrange access.',
      'Hello Jordan,\n\nThe portal sends its login code to Roy’s personal mailbox.',
      'Hello Jordan,\n\nYou asked Roy about the 90 GBP on 3 November.',
    ]) {
      const r = check(ROY(body));
      expect(r.ok, body).toBe(false);
      expect(r.error, body).toMatch(/signed Roy Lavin but names Roy/);
    }
  });

  it('quotes the sentence that names Roy, even below details lines (review of PR 951)', () => {
    const r = check(ROY('Dear Ms Example,\n\nThe details you asked for:\n- Address: 9 Example Road, Exampletown, EX1 1AA\n'
      + '- Bedrooms: 5 (all let)\n- Managing agent: Agile Lets\n\nRoy is copied in and will arrange access.'));
    expect(r.ok).toBe(false);
    // The quote must hold the words the robot has to change, or it cannot fix them in one go.
    expect(r.error).toMatch(/\('[^']*Roy is copied in[^']*'\)/);
  });

  it('refuses it with no sign-off phrase too, when the last lines are his name', () => {
    const r = check('TO: office@example-sparks.test\nFROM: info@agilelets.co.uk\nSUBJECT: Access\n---\n'
      + 'Hello Jordan,\n\nRoy will meet you at the door.\n\nRoy Lavin\nAgile Lets\n\n**Carrying this out will involve:** sending this email.');
    expect(r.ok).toBe(false);
  });

  it('passes Roy introducing himself, a details line, Royal Mail, Roy in the quote, and Kevin naming Roy', () => {
    // The control: the third person, in the same shape, is refused.
    expect(check(ROY('Hi Robin,\n\nRoy has asked me to thank you for telling us about the change.')).ok).toBe(false);
    expect(check(ROY('Hi Robin,\n\nRoy here. Thank you for telling me about the change.'))).toEqual({ ok: true });
    expect(check(ROY('Dear Ms Example,\n\nThe details you asked for:\n- Owner: Mr A Example\n- Managing agent: Roy Lavin, Agile Lets\n\nI confirm receipt of the notice.'))).toEqual({ ok: true });
    expect(check(ROY('Hello Jordan,\n\nThe report went by Royal Mail on Monday. I will arrange access myself.'))).toEqual({ ok: true });
    expect(check(ROY('Hello Jordan,\n\nThank you, Friday suits me.\n\nOn Tue, 10 Nov 2026, Jordan wrote:\n> Can Roy meet us there?'))).toEqual({ ok: true });
    expect(check(KEVIN('Dear Sir or Madam,\n\nRoy Lavin manages the property and is copied in.'))).toEqual({ ok: true });
  });
});

describe('a tenant mail-out never shows its recipients each other (30 Sep 2026)', () => {
  const two = 'TO: one@example-charity.test, two@example-council.test\nFROM: info@agilelets.co.uk\nSUBJECT: Rooms for single adults';
  const each = 'TO-EACH: one@example-charity.test, two@example-council.test\nFROM: info@agilelets.co.uk\nSUBJECT: Rooms for single adults';
  const body = 'Hello,\n\nWe have a room free now in Exampletown.';

  it('refuses two addresses on TO or CC on any tenant chain email card', () => {
    for (const task of ['TENANT MAILOUT: Exampletown rooms 1 Nov 2026', 'TENANT PAST APPLICANTS: Exampletown 1 Nov 2026',
      'TENANT REFERRAL: Exampletown 1 Nov 2026', 'TENANT KEEPWARM: Exampletown 1 Nov 2026', 'tenant past applicants: Exampletown']) {
      const r = check(ROY(body, two), task);
      expect(r.ok, task).toBe(false);
      expect(r.error, task).toMatch(/tenant mail-out/);
    }
    const cc = check(ROY(body, 'TO: one@example-charity.test\nCC: two@example-council.test\nFROM: info@agilelets.co.uk\nSUBJECT: Rooms'),
      'TENANT MAILOUT: Exampletown rooms 1 Nov 2026');
    expect(cc.ok).toBe(false);
  });

  it('passes TO-EACH, one address, another lane, and a call with no task name', () => {
    expect(check(ROY(body, each), 'TENANT MAILOUT: Exampletown rooms 1 Nov 2026')).toEqual({ ok: true });
    expect(check(ROY(body, 'TO: one@example-charity.test\nFROM: info@agilelets.co.uk\nSUBJECT: Rooms'),
      'TENANT PAST APPLICANTS: Exampletown 1 Nov 2026')).toEqual({ ok: true });
    expect(check(ROY(body, two), 'TENANT REFERRAL CHECK: Exampletown 1 Nov 2026')).toEqual({ ok: true });
    expect(check(ROY(body, two), 'COMPLIANCE: EICR quotes - 9 Example Road')).toEqual({ ok: true });
    expect(check(ROY(body, two))).toEqual({ ok: true });
  });

  it('covers every email card the tenant chain writes (scripts/tenant-leads.py PREFIXES)', () => {
    const py = `
import importlib.util, json, socket, sys, urllib.request
def _no(*a, **k):
    raise RuntimeError("network blocked")
socket.create_connection = _no
urllib.request.urlopen = _no
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location("tl", sys.argv[1] + "/tenant-leads.py")
tl = importlib.util.module_from_spec(spec); spec.loader.exec_module(tl)
import agent_email_format as aef
print(json.dumps({"mine": list(getattr(aef, "MAILOUT_TASK_PREFIXES", ())), "chain": [tl.PREFIXES[k] for k in ("mailout", "referral", "keepwarm", "pastmail")]}))
`;
    const r = JSON.parse(execFileSync('python3', ['-c', py, SCRIPTS], { encoding: 'utf8' }).trim());
    expect([...r.mine].sort()).toEqual([...r.chain].sort());
  });
});

describe('the tenant chain\'s own cards still pass (it submits through this gate)', () => {
  it('the documents email is written as Roy, so the check does not refuse a card code wrote', () => {
    const py = `
import importlib.util, json, socket, sys, urllib.request
from datetime import date
def _no(*a, **k):
    raise RuntimeError("network blocked")
socket.create_connection = _no
urllib.request.urlopen = _no
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location("tl", sys.argv[1] + "/tenant-leads.py")
tl = importlib.util.module_from_spec(spec); spec.loader.exec_module(tl)
from agent_email_format import validate_submission_any, EmailFormatError
lead = {"id": "recLEADexample0001", "fields": {tl.L["name"]: "Sam Example", tl.L["email"]: "sam@example-mail.test"}}
card = tl.docs_card({}, lead, "Exampletown", date(2026, 11, 16))
out = {}
for label, text in (("asWritten", card["output"]),
                    ("thirdPerson", card["output"].replace("I will also check your photo ID", "Roy will also check your photo ID"))):
    try:
        validate_submission_any(text)
        out[label] = "ok"
    except EmailFormatError as e:
        out[label] = "refused: " + str(e)[:80]
print(json.dumps(out))
`;
    const r = JSON.parse(execFileSync('python3', ['-c', py, SCRIPTS], { encoding: 'utf8' }).trim());
    expect(r.asWritten).toBe('ok');
    // The wording it had until 16 Nov 2026 would now be refused, so the card had to change with the check.
    expect(r.thirdPerson).toMatch(/^refused: this email is signed Roy Lavin/);
  });
});

// A one-page PDF in WinAnsiEncoding (0x97 is the em dash), so the letter's real text is read back.
const PDF_PY = `
import sys
def tiny_pdf(path, text):
    body = text.encode("cp1252").replace(b"\\\\", b"\\\\\\\\").replace(b"(", b"\\\\(").replace(b")", b"\\\\)")
    stream = b"BT /F1 12 Tf 72 720 Td (" + body + b") Tj ET"
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\\nstream\\n" % len(stream) + stream + b"\\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]
    out = b"%PDF-1.4\\n"; offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(out)); out += b"%d 0 obj\\n" % i + o + b"\\nendobj\\n"
    x = len(out)
    out += b"xref\\n0 %d\\n0000000000 65535 f \\n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \\n" % o for o in offs)
    out += b"trailer\\n<< /Size %d /Root 1 0 R >>\\nstartxref\\n%d\\n%%%%EOF\\n" % (len(objs) + 1, x)
    open(path, "wb").write(out)
tiny_pdf(sys.argv[1], sys.argv[2])
`;

describe('a letter we post, and a document going out for signature, are read too', () => {
  function withPdf(text, fn) {
    const dir = mkdtempSync(path.join(tmpdir(), 'aef-letter-'));
    try {
      const pdf = path.join(dir, 'letter.pdf');
      if (text === null) writeFileSync(pdf, 'this is not a pdf');
      else execFileSync('python3', ['-c', PDF_PY, pdf, text]);
      return fn(pdf);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const POST = (pdf) => `POST:\nAccounts Team\nExample Energy Ltd\nPO Box 1\nExampletown\nEX1 2AB\nDOCUMENT: ${pdf}\nDELIVERY: cheap\n---\nA letter asking the supplier to hold the account.\n\n**Carrying this out will involve:** posting the letter.`;
  const SIGN = (pdf) => `DOCUMENT: ${pdf}\nSIGNERS: kevinbrittain@gmail.com\nSUBJECT: Letter of authority\n---\nA letter of authority for the lender.\n\n**Carrying this out will involve:** sending it for signature.`;

  it('refuses a posted letter with a placeholder or an em dash in its own text', () => {
    withPdf("Dear Sir, please write to me at [Kevin's home address - confirm before approving].", (pdf) => {
      const r = check(POST(pdf));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/the letter still carries a placeholder/);
    });
    withPdf('Dear Sir, Late Filing Penalty — Tax Reference 1234567890.', (pdf) => {
      const r = check(POST(pdf));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/the letter carries an em dash/);
    });
  });

  it('passes a clean letter, and leaves a missing file to the file gate', () => {
    // The control: the same letter with an em dash is refused.
    withPdf('Dear Sir \u2014 please hold the account while the court order stands.', (pdf) => {
      expect(check(POST(pdf)).ok).toBe(false);
    });
    withPdf('Dear Sir, please hold the account while the court order stands. Yours faithfully, A Example', (pdf) => {
      expect(check(POST(pdf))).toEqual({ ok: true });
    });
    expect(check(POST('/nonexistent/folder/letter.pdf'))).toEqual({ ok: true });
  });

  it('refuses a file it cannot read, rather than passing a letter nobody checked', () => {
    withPdf(null, (pdf) => {
      const r = check(POST(pdf));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/could not read the text/);
    });
  });

  it('a document for signature: a placeholder is refused, an em dash is not (the tenancy pack\'s title lines carry one)', () => {
    withPdf('Letter of authority. Address: [Kevin\'s home address - confirm before approving]', (pdf) => {
      const r = check(SIGN(pdf));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/the document still carries a placeholder/);
    });
    withPdf('Tenancy agreement Sam Example — 9 Example Road, Exampletown', (pdf) => {
      expect(check(SIGN(pdf))).toEqual({ ok: true });
    });
  });
});

// Review of PR 951 (16 Nov 2026), the "can follow" list. Each closed gap has a case that fails on the code
// before (back-tested on origin/main's copy) and a control; each false refusal it removes is pinned as a pass.
describe('an email\'s PDF attachment is read too (review of PR 951, F3)', () => {
  function inFolder(sub, text, fn) {
    const dir = mkdtempSync(path.join(tmpdir(), 'aef-attach-'));
    try {
      const folder = path.join(dir, sub);
      execFileSync('mkdir', ['-p', folder]);
      const pdf = path.join(folder, 'document.pdf');
      execFileSync('python3', ['-c', PDF_PY, pdf, text]);
      return fn(pdf, path.join(dir, 'inbound'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const EMAIL = (pdf) => KEVIN('Dear Sir or Madam,\n\nPlease find the signed letter attached.',
    `TO: accounts@example-lender.test\nFROM: kevinbrittain@gmail.com\nSUBJECT: Letter of authority\nATTACH: ${pdf}`);

  it('refuses an attached PDF still carrying a placeholder, naming the way through', () => {
    inFolder('ours', "Letter of authority. Address: [Kevin's home address - confirm before approving]", (pdf, inbound) => {
      const r = check(EMAIL(pdf), undefined, inbound);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/^the attached document still carries a placeholder/);
      expect(r.error).toMatch(/inbound-triage\.py attachments/);
    });
  });

  it('passes a clean attachment, and someone else\'s document as received (the inbound folder)', () => {
    inFolder('ours', 'Letter of authority for account 4455 6677. Signed, A Example.', (pdf, inbound) => {
      expect(check(EMAIL(pdf), undefined, inbound)).toEqual({ ok: true });
    });
    // An insurer's own words: "[approx.]" is theirs. Control: the same file outside the folder is read.
    inFolder('inbound/18c0ffee00000001', 'Rebuild cost [approx.] 250,000 GBP.', (pdf, inbound) => {
      expect(check(EMAIL(pdf), undefined, inbound)).toEqual({ ok: true });
    });
    inFolder('ours', 'Rebuild cost [approx.] 250,000 GBP.', (pdf, inbound) => {
      expect(check(EMAIL(pdf), undefined, inbound).ok).toBe(false);
    });
  });

  it('a document for signature or a letter in the inbound folder is not read (F7)', () => {
    inFolder('inbound/18c0ffee00000002', 'Statement of fact [for 36 months] to sign and return.', (pdf, inbound) => {
      expect(check(`DOCUMENT: ${pdf}\nSIGNERS: kevinbrittain@gmail.com\n---\nThe insurer's statement of fact to sign.\n\n**Carrying this out will involve:** sending it for signature.`,
        undefined, inbound)).toEqual({ ok: true });
    });
  });

  it('a posted tenancy pack document keeps its code-made em dash lines; control: any other letter is refused (F7)', () => {
    const POSTPACK = (pdf) => `POST:\nCouncil Tax\nExample District Council\nPO Box 1\nExampletown\nEX1 2AB\nDOCUMENT: ${pdf}\nDELIVERY: cheap\n---\nThe tenant's signed authority.\n\n**Carrying this out will involve:** posting the letter.`;
    inFolder('ours', 'Sam Example — authority to act — Example District Council 1', (pdf, inbound) => {
      expect(check(POSTPACK(pdf), undefined, inbound)).toEqual({ ok: true });
    });
    inFolder('ours', 'Sam Example — please treat this as authority.', (pdf, inbound) => {
      expect(check(POSTPACK(pdf), undefined, inbound).ok).toBe(false);
    });
  });
});

describe('the Roy rule has no holes and no false refusals (review of PR 951, F4)', () => {
  it('refuses a "words: words" sentence and a note line naming Roy', () => {
    for (const body of ['Hello Jordan,\n\nRoy will call you on the day to confirm: please keep your phone on.',
      'Hello Jordan,\n\nNote: Roy will meet you at the door.']) {
      const r = check(ROY(body));
      expect(r.ok, body).toBe(false);
      expect(r.error, body).toMatch(/names Roy above the sign-off/);
    }
  });

  it('reads an email signed just "Roy"', () => {
    const head = 'TO: office@example-sparks.test\nFROM: info@agilelets.co.uk\nSUBJECT: Access';
    for (const sign of ['Thanks, Roy', 'Thanks,\nRoy', 'Roy']) {
      const r = check(`${head}\n---\nHello Jordan,\n\nRoy will arrange access on Friday.\n\n${sign}\n\n**Carrying this out will involve:** sending this email.`);
      expect(r.ok, sign).toBe(false);
      expect(r.error, sign).toMatch(/^this email is signed Roy but names Roy/);
    }
    // Control: the same email in the first person is not refused by the Roy rule. Signed just "Roy" from info@, it
    // is refused by Kevin's ruling of 16 Nov 2026 (decision card recinoFWz6fQ6JVVB): signed Roy Lavin, then Agile Lets.
    const short = check(`${head}\n---\nHello Jordan,\n\nI will arrange access on Friday.\n\nThanks, Roy\n\n**Carrying this out will involve:** sending this email.`);
    expect(short.ok).toBe(false);
    expect(short.error).not.toMatch(/names Roy/);
    expect(short.error).toMatch(/`Roy Lavin` and `Agile Lets` on the next line/);
    expect(check(`${head}\n---\nHello Jordan,\n\nI will arrange access on Friday.\n\nThanks,\nRoy Lavin\nAgile Lets\n\n**Carrying this out will involve:** sending this email.`))
      .toEqual({ ok: true });
  });

  it('passes another person named Roy, a street, quoted words and a details line', () => {
    for (const body of [
      'Hello Jordan,\n\nThe tenant in Unit 2, Roy Example, will let you in.',
      'Hello Jordan,\n\nThe job is at 12 Roy Road, Exampletown.',
      'Hello Jordan,\n\nYou wrote that "Roy said Monday works". I can confirm Monday.',
      'Hello Jordan,\n\nThe details:\n- Contact: Roy on 07700 900111\n- Keys: in the lockbox\n\nI will see you there.',
    ]) {
      expect(check(ROY(body)), body).toEqual({ ok: true });
    }
  });
});

describe('placeholders: what the review found refused wrongly, and what it found passing (F5, F6)', () => {
  it('passes "[sic]", a reference in brackets, a link with brackets, a bare domain, a sum, a masked card and a mailto', () => {
    for (const body of [
      'Dear Sir or Madam,\n\nYour letter says the "propery [sic]" was let.',
      'Dear Sir or Madam,\n\nYour reference [AB-123456] and licence [HMO/2026/0042] are noted.',
      'Hi Sam,\n\nThe list is at https://portal.example.test/units?filter[status]=open for you.',
      'Hi Sam,\n\nPlease use the address on <example-lets.test> for anything new.',
      'Hi Sam,\n\nIf the balance is < 100 and > 50 we will settle it in one go.',
      'Hi Sam,\n\nThe refund went to card XXXX-1234 on Monday.',
      'Hi Sam,\n\nPlease write to sam@example-energy.test [mailto:sam@example-energy.test] with the meter reading.',
    ]) {
      expect(check(KEVIN(body)), body).toEqual({ ok: true });
    }
  });

  it('refuses "{amount}", "(insert address)", "£X" and the em dash written as &mdash; or a horizontal bar', () => {
    for (const [body, want] of [
      ['Dear Sir or Madam,\n\nI can pay {amount} a month.', /placeholder/],
      ['Dear Sir or Madam,\n\nPlease write to me at (insert address).', /placeholder/],
      ['Dear Sir or Madam,\n\nI can offer £X a month from next month.', /placeholder/],
      ['Dear Sir or Madam,\n\nAccount 4455 &mdash; 9 Example Road.', /em dash/],
      ['Dear Sir or Madam,\n\nAccount 4455 ― 9 Example Road.', /em dash/],
    ]) {
      const r = check(KEVIN(body));
      expect(r.ok, body).toBe(false);
      expect(r.error, body).toMatch(want);
    }
  });

  it('a refusal names the shape and the way through', () => {
    expect(check(KEVIN('Hi Sam,\n\nYour ref is [EXTERNAL] on our side.')).error).toMatch(/write it without square brackets/);
    expect(check(KEVIN('Hi Sam,\n\nThe date is TBC.')).error).toMatch(/to be confirmed by/);
  });

  it('a details line starting "From:" or ">" is the sender\'s own words, so what follows is still read', () => {
    for (const body of ['Dear Sir or Madam,\n\nThe tenancy details:\nFrom: 1 December 2026\nRent: [amount] a month.',
      'Dear Sir or Madam,\n\nThe block:\n> 50 rooms in the block\nRent: [amount] a room.']) {
      const r = check(KEVIN(body));
      expect(r.ok, body).toBe(false);
      expect(r.error, body).toMatch(/placeholder/);
    }
    // Control: a quoted reply's header block still starts the quote, so the other side's brackets pass.
    expect(check(KEVIN('Hi Sam,\n\nThank you, noted.\n\nFrom: Sam Example\nSent: 10 November 2026 09:00\nSubject: Rent\nYour ref [TBC]')))
      .toEqual({ ok: true });
  });
});
