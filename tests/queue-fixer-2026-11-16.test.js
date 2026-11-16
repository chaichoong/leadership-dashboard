// Eight TOOL walls the daily fix phase cleared on 16 Nov 2026. Each test fails on the code
// before its fix. Every name, place, figure and address below is invented: this repo is public.
//
//   20261016-agent-dispatch-951  tier-1 CLOSE PROPOSAL refused by the CHECKED gate
//   20261107-agent-dispatch-1242 the same wall, reported again 22 days later
//   20261012-agent-dispatch-844  coverage refuses FY8 for a contractor who covers Lancashire
//   20261014-agent-dispatch-862  an approved .docx attachment refused by the send gate
//   20261030-agent-dispatch-1143 an approved ATTACH in the agent's own run folder refused
//   20261113-agent-dispatch-1301 the same wall, reported again 14 days later
//   20261019-agent-dispatch-979  a SPEND declaration left in the body after the signature
// (20261109-agent-dispatch-1251 asked for the same strip of a KEVIN ONLY block and was reopened
//  instead: Kevin ruled on 7 Oct 2026 that what is his is refused, never cut.)
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');

function py(code, ...args) {
  const src = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
${code}
`;
  return JSON.parse(execFileSync('python3', ['-c', src, ...args], { encoding: 'utf8' }).trim());
}

// agent-dispatch.py is a hyphenated CLI, so it is loaded by path rather than imported.
const LOAD_DISPATCH = `
import importlib.util, os
spec = importlib.util.spec_from_file_location("agent_dispatch", os.path.join(${JSON.stringify(SCRIPTS)}, "agent-dispatch.py"))
ad = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ad)
`;

const BANNER = ':rotating_light: TIER 1. This touches your private legal and financial matter. '
  + 'An AI agent prepared it. Nothing has been sent, filed, paid or changed anywhere. '
  + 'Read it before you approve.';

function checkedProblem(output, taskType, inbound) {
  return py(`${LOAD_DISPATCH}
print(json.dumps({"problem": ad.checked_problem(sys.argv[1], sys.argv[2], sys.argv[3] == "1")}))
`, output, taskType, inbound ? '1' : '0');
}

describe('the tier-1 banner is not the output (findings 951 and 1242)', () => {
  const CLOSE = 'CLOSE PROPOSAL: the sender has already been answered on task recExampleTask001, '
    + 'so there is nothing left to decide here.';

  it('a plain CLOSE PROPOSAL on an inbound report passes the CHECKED gate', () => {
    expect(checkedProblem(CLOSE, 'Admin', true).problem).toBe('');
  });

  it('the SAME output under the tier-1 banner passes too: the banner is written for Kevin', () => {
    // Before the fix this returned "must open with the five questions answered", and adding a
    // CHECKED line was then refused as "not a report". No honest shape passed, so two tasks sat
    // behind this wall for 30 and 8 days.
    expect(checkedProblem(`${BANNER}\n\n${CLOSE}`, 'Admin', true).problem).toBe('');
  });

  it('an ordinary tier-1 report with no CHECKED line is still refused', () => {
    const r = checkedProblem(`${BANNER}\n\nThe council wrote about the licence renewal.`, 'Admin', true);
    expect(r.problem).toMatch(/five questions/);
  });
});

describe('a postcode area sits in a county (finding 844)', () => {
  function covers(areas, address) {
    return py(`${LOAD_DISPATCH}
print(json.dumps({"covers": ad.area_covers(json.loads(sys.argv[1]), sys.argv[2])}))
`, JSON.stringify(areas), address).covers;
  }

  it('a contractor covering the North West covers an FY8 address', () => {
    // The wall: a fire-alarm firm "covers Lancashire / North West" against an FY8 property.
    // The reply and quote email sat written-but-unsent for 34 days.
    expect(covers(['LANCASHIRE', 'NORTH WEST'], '12 Example Parade, Example Town FY8 1AA')).toBe(true);
    expect(covers(['NORTH WEST'], '3 Example Row, Example Town PR4 2BB')).toBe(true);
    expect(covers(['NORTH WEST'], '7 Example Street, Example City M14 5CC')).toBe(true);
  });

  it('a contractor covering the North West does NOT cover a Kent address', () => {
    expect(covers(['NORTH WEST'], '9 Example Lane, Example Village ME13 7DD')).toBe(false);
  });

  it('no COUNTY name is mapped at all: a county can be read two ways, a region cannot', () => {
    // Review round 1: the first version mapped whole areas to counties, and several areas cross
    // a county line, so "Cheshire" would have passed for a property outside the contractor's
    // area. No county name is mapped now, so each of these falls through and refuses.
    expect(covers(['LANCASHIRE'], '12 Example Parade, Example Town FY8 1AA')).toBe(false);
    expect(covers(['CHESHIRE'], '12 Example Parade, Example Town FY8 1AA')).toBe(false);
    expect(covers(['GREATER MANCHESTER'], '7 Example Street, Example City M14 5CC')).toBe(false);
  });

  it('the four postcode areas that cross a boundary are not mapped: CH, LA, OL, SK', () => {
    // CH5-CH8 is Flintshire in Wales, LA2 and LA6 reach into North Yorkshire, OL14 is West
    // Yorkshire, SK17 is Derbyshire. A refusal costs one reply; a wrong pass writes to a
    // tradesperson about a house they do not cover.
    for (const pc of ['CH7 1AA', 'LA6 2BB', 'OL14 5CC', 'SK17 9DD']) {
      expect(covers(['NORTH WEST'], `1 Example Street, Example Town ${pc}`)).toBe(false);
    }
  });
});

describe('the send gate and the files an approved email names (findings 862, 1143, 1301)', () => {
  // The run root is read from AGENT_DISPATCH_DIR, the same variable the dispatcher itself uses,
  // so the test names the folder rather than trusting whatever this machine happens to have.
  const RUN_DIR = resolve(ROOT, 'tests');
  const TASK = 'recExampleTask777';
  const OTHER = 'recExampleOther99';

  function gate() {
    const src = `
import json, os, sys, importlib.util
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
spec = importlib.util.spec_from_file_location("send_email", os.path.join(${JSON.stringify(SCRIPTS)}, "send-email.py"))
se = importlib.util.module_from_spec(spec)
spec.loader.exec_module(se)
run = se.ATTACH_RUN_ROOT
task, other = sys.argv[1], sys.argv[2]
out = {
    "exts": sorted(se.ATTACH_EXTENSIONS),
    "mimeKeys": sorted(se.ATTACH_MIME),
    "mimeValues": sorted(set(se.ATTACH_MIME.values())),   # .jpg and .jpeg share one
    "runRoot": run,
    # the file this task's own agent wrote, in its own run folder
    "ownRunFile": se.under_attach_root(os.path.join(run, "20261113-1346", task, "doc.pdf"), task),
    # another lane's run folder, and the dispatcher's own ledgers: never readable
    "otherTaskFile": se.under_attach_root(os.path.join(run, "20261113-1346", other, "doc.pdf"), task),
    "ledgerFile": se.under_attach_root(os.path.join(run, "ledger", "doc.pdf"), task),
    "runRootFile": se.under_attach_root(os.path.join(run, "doc.pdf"), task),
    # the task id as part of a FILE name, not a directory, proves nothing
    "taskNamedFile": se.under_attach_root(os.path.join(run, "20261113-1346", task + ".pdf"), task),
    # no task id, or one that is not a record id, never opens the run root
    "noTaskId": se.under_attach_root(os.path.join(run, "20261113-1346", task, "doc.pdf"), ""),
    "badTaskId": se.under_attach_root(os.path.join(run, "20261113-1346", "..", "doc.pdf"), "selftest"),
    "privateConfig": se.under_attach_root(os.path.expanduser("~/.config/od/secret.pdf"), task),
    "insideAttachDir": se.under_attach_root(os.path.join(se.ATTACH_DIR, "pages.pdf"), task),
}
# The roots are read LIVE, so send-email.py's own selftest, which reassigns ATTACH_DIR to a temp
# directory, is honoured: a tuple frozen at import refused every one of its cases (16 Nov 2026).
se.ATTACH_DIR = "/tmp/example-moved-attachments"
out["liveRoots"] = "/tmp/example-moved-attachments" in se.attach_roots(task)
print(json.dumps(out))
`;
    return JSON.parse(execFileSync('python3', ['-c', src, TASK, OTHER], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_DISPATCH_DIR: RUN_DIR },
    }).trim());
  }

  it('a fillable Word form is an allowed attachment type', () => {
    // An approved email to Roy attached a police form as .docx; the gate allowed only PDF and
    // images, and sending it as a PDF would have changed what Kevin approved.
    expect(gate().exts).toContain('.docx');
  });

  it('every allowed type has a MIME type, so none can be sent as the wrong thing', () => {
    const g = gate();
    expect(g.mimeKeys).toEqual(g.exts);
  });

  it('the WORKER floor allows exactly the same MIME types: an allowlist has two floors', () => {
    // Review round 1: widening send-email.py alone would have refused the approved .docx one
    // step later, at workers/drive-upload, with the email still unsent.
    const worker = readFileSync(resolve(ROOT, 'workers/drive-upload/worker.js'), 'utf8');
    const m = worker.match(/const ATTACH_MIME_ALLOWED = \[([\s\S]*?)\];/);
    expect(m).toBeTruthy();
    const allowed = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(allowed).toEqual(gate().mimeValues);
  });

  it("only THIS task's own run folder is readable, never another lane's and never the ledgers", () => {
    // Review round 1: the first version allowed the whole dispatcher state folder, which also
    // holds the inbound-triage, Roy and sign-in run folders and the ledgers, so an injected
    // ATTACH header could have mailed out any file sitting in any of them.
    const g = gate();
    expect(g.runRoot).toBe(RUN_DIR);
    expect(g.ownRunFile).toBe(true);
    expect(g.insideAttachDir).toBe(true);
    for (const k of ['otherTaskFile', 'ledgerFile', 'runRootFile', 'taskNamedFile',
      'noTaskId', 'badTaskId', 'privateConfig']) {
      expect(`${k}=${g[k]}`).toBe(`${k}=false`);
    }
  });

  it('the roots are read live, so send-email.py\'s own selftest still passes', () => {
    expect(gate().liveRoots).toBe(true);
  });

  it('send-email.py passes its own selftest', () => {
    const out = execFileSync('python3', [resolve(SCRIPTS, 'send-email.py'), 'selftest'], { encoding: 'utf8' });
    expect(out).toMatch(/selftest OK/);
  });
});

describe('his words live on the card, not on the task they move (findings 915 and 1246)', () => {
  // The card is a real Tasks record shape: fields keyed by field id, plus createdTime.
  const CARD = 'recExampleCard01';
  const TARGET = 'recExampleTask777';

  function check(cardOverrides, target, date, fieldOverrides, todayStr) {
    return py(`${LOAD_DISPATCH}
import datetime
card = json.loads(sys.argv[1])
target, date_s = sys.argv[2], sys.argv[3]
fields = json.loads(sys.argv[4])
today = datetime.date.fromisoformat(sys.argv[5])
day = datetime.date.fromisoformat(date_s)
print(json.dumps({
    "card": ad.due_card_problem(card, target, day),
    "move": ad.due_move_problem(fields, day, today, None, card=card),
}))
`, JSON.stringify(cardOverrides), target, date, JSON.stringify(fieldOverrides || {}), todayStr);
  }

  function card(output, extra) {
    return {
      id: CARD,
      createdTime: '2026-11-01T09:00:00.000Z',
      fields: {
        fld30Yw8SWYVp049g: 'agent-dispatch',            // Sent For Approval By
        fldr4Mvf2RzKvhZhi: '2026-11-08T10:00:00.000Z',  // Approved At
        fldrHBSr6qoUfaKuZ: 'Approved as-is',            // Approval Outcome
        fldzswp8fx6PqpLQ5: output,                      // Agent Output
        ...(extra || {}),
      },
    };
  }

  const OPEN = { fldx4qCw17UfrKpaN: 'Upcoming' };       // target task Status

  it('an approved card that names the task and the exact date moves it', () => {
    // The wall: an approved card ruled that checkpoint 3 moves, and `due` demanded Kevin's words
    // on the checkpoint itself, which has none. The move waited 31 days.
    const r = check(card(`Move ${TARGET} from 2 November to 2026-11-16.`), TARGET, '2026-11-16', OPEN, '2026-11-10');
    expect(r.card).toBe('');
    expect(r.move).toBe('');
  });

  it('an approved card may put a date back a few days, which --quote never could', () => {
    const r = check(card(`Correct ${TARGET}: the due date goes back to 5 November 2026.`),
      TARGET, '2026-11-05', OPEN, '2026-11-08');
    expect(r.card).toBe('');
    expect(r.move).toBe('');
  });

  it('a card that names another task moves nothing', () => {
    const r = check(card('Move recExampleOther99 to 2026-11-16.'), TARGET, '2026-11-16', OPEN, '2026-11-10');
    expect(r.card).toMatch(/does not name recExampleTask777/);
  });

  it('on a multi-task card, a task moves only to the date written BESIDE it', () => {
    // Review round 1: the first version asked only that the id appeared somewhere and the date
    // appeared somewhere, so on a card ruling on a dozen tasks any task could take any date.
    const multi = card([
      `Move recExampleOther99 from 1 November to 2026-11-16.`,
      `Move ${TARGET} from 2 November to 2026-12-01.`,
      `Close recExampleThird55 on 2026-11-20.`,
    ].join('\n'));
    expect(check(multi, TARGET, '2026-12-01', OPEN, '2026-11-10').card).toBe('');
    // 16 Nov and 20 Nov belong to the other two tasks, not to this one.
    expect(check(multi, TARGET, '2026-11-16', OPEN, '2026-11-10').card).toMatch(/same line/);
    expect(check(multi, TARGET, '2026-11-20', OPEN, '2026-11-10').card).toMatch(/same line/);
  });

  it('the date it is moving FROM is not a date it may move TO', () => {
    // "Move X from 2 November to 2026-11-16" names two dates. Only one is Kevin's ruling.
    const c = card(`Move ${TARGET} from 2 November 2026 to 2026-11-16.`);
    expect(check(c, TARGET, '2026-11-16', OPEN, '2026-11-10').card).toBe('');
    expect(check(c, TARGET, '2026-11-02', OPEN, '2026-11-10').card).toMatch(/same line/);
  });

  it('a card that names only the month moves nothing: the exact date is required', () => {
    const r = check(card(`Move ${TARGET} some time in November.`), TARGET, '2026-11-16', OPEN, '2026-11-10');
    expect(r.card).toMatch(/same line/);
  });

  it('a card with no approval marks moves nothing, however it reads', () => {
    const typed = card(`Move ${TARGET} to 2026-11-16.`, { fld30Yw8SWYVp049g: '', fldr4Mvf2RzKvhZhi: '' });
    expect(check(typed, TARGET, '2026-11-16', OPEN, '2026-11-10').card).toMatch(/not a real approval/);
  });

  it('a card Kevin rejected or has not answered moves nothing', () => {
    const r = check(card(`Move ${TARGET} to 2026-11-16.`, { fldrHBSr6qoUfaKuZ: 'Changes requested' }),
      TARGET, '2026-11-16', OPEN, '2026-11-10');
    expect(r.card).toMatch(/Changes requested/);
  });

  it('a date long gone is still refused, card or no card', () => {
    const r = check(card(`Move ${TARGET} to 2026-01-05.`), TARGET, '2026-01-05', OPEN, '2026-11-10');
    expect(r.move).toMatch(/rewrite history/);
  });

  it('a task at Approval is still refused: his knock-back sets that date', () => {
    const r = check(card(`Move ${TARGET} to 2026-11-16.`), TARGET, '2026-11-16',
      { fldx4qCw17UfrKpaN: 'Approval' }, '2026-11-10');
    expect(r.move).toMatch(/waiting at Approval/);
  });
});

describe('what the approval card declares never reaches the recipient (findings 979 and 1251)', () => {
  function parse(output) {
    return py(`
from agent_email_format import parse_output, EmailFormatError
try:
    print(json.dumps({"ok": True, "mail": parse_output(sys.argv[1])}))
except EmailFormatError as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`, output);
  }

  const HEAD = 'TO: lettings@example-agency.test\nFROM: info@example-lets.test\n'
    + 'SUBJECT: Example House: the works quote\n---\n';
  const BODY = 'Hello,\n\nPlease go ahead with the quote for Example House.\n\nRoy, Example Lets';

  it('a SPEND declaration under the signature is taken off, not sent', () => {
    const r = parse(`${HEAD}${BODY}\n\nSPEND: up to £1,188 for the works, taken from the rent by the agency.`);
    expect(r.ok).toBe(true);
    expect(r.mail.body).toBe(BODY);
    expect(r.mail.body).not.toMatch(/SPEND/);
  });

  it('a KEVIN ONLY block is still REFUSED, not stripped: Kevin ruled that on 7 Oct 2026', () => {
    // Finding 20261109-agent-dispatch-1251 asked for a strip here and is deliberately NOT given
    // one. A cut sends a stub of what he approved, and tests/agent-email-kevin-only.test.js
    // holds the refusal. The declared route is to put the line under the Carrying-this-out line.
    const r = parse(`${HEAD}${BODY}\n\nKEVIN ONLY: payment: pay the agency £93.00, reference EXAMPLEREF.`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/KEVIN ONLY line sits inside the email/);
  });

  it('a declaration under the Carrying-this-out line goes too', () => {
    const r = parse(`${HEAD}${BODY}\n\n**Carrying this out will involve:** sending this email.\n\nSPEND: £40.00 for the parts.`);
    expect(r.ok).toBe(true);
    expect(r.mail.body).toBe(BODY);
  });

  it('a SPEND line in the MIDDLE of a short email never cuts the paragraph after it', () => {
    // Review round 1: the first version cut at the first SPEND line with 400 characters or
    // fewer after it, so in a short email it dropped the real closing paragraph and the
    // signature and sent a stub. That is the cut Kevin ruled against on 7 Oct 2026.
    const body = 'Hello,\n\nSPEND: £40.00 for the parts.\n\nPlease confirm the start date in writing.\n\nRoy, Example Lets';
    const r = parse(HEAD + body);
    expect(r.ok).toBe(true);
    expect(r.mail.body).toBe(body);
    expect(r.mail.body).toMatch(/Please confirm the start date/);
    expect(r.mail.body).toMatch(/Roy, Example Lets$/);
  });

  it('a SPEND line sharing a block with the email\'s own words is left alone', () => {
    const body = 'Hello,\n\nPlease go ahead.\n\nRoy, Example Lets\nSPEND: £40.00 for the parts.';
    const r = parse(HEAD + body);
    expect(r.ok).toBe(true);
    expect(r.mail.body).toMatch(/Roy, Example Lets/);
  });

  it('a KEVIN ONLY line with a whole email after it is still REFUSED, never cut', () => {
    // The cut is only ever made where the marker closes the text. A marker in the middle of a
    // long email cannot be told from the email, so it is refused, exactly as before.
    const long = 'Further to your message, the works were agreed on 3 March and the schedule was '
      + 'sent the same week. The surveyor attended on 19 March and reported no damp in either '
      + 'bedroom. The quote attached covers the kitchen only, and the second quote for the '
      + 'bathroom will follow once the plumber has measured. Please confirm the start date in '
      + 'writing so the tenants can be told at least a fortnight beforehand, and let us know if '
      + 'scaffolding will block the shared path at any point during the works.\n\nRoy, Example Lets';
    const r = parse(`${HEAD}Hello,\n\nKEVIN ONLY: payment: pay the agency £93.00.\n\n${long}`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/KEVIN ONLY/);
  });

  it('an email that merely mentions spending in a sentence is untouched', () => {
    const body = 'Hello,\n\nWe spend about £400 a year on this building. Please send the quote.\n\nRoy, Example Lets';
    const r = parse(HEAD + body);
    expect(r.ok).toBe(true);
    expect(r.mail.body).toBe(body);
  });
});
