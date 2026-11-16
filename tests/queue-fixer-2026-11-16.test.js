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

  it('a contractor covering Lancashire covers an FY8 address', () => {
    // The wall: "DD Fire Alarms covers Lancashire / North West" against an FY8 property, which
    // IS in Lancashire. The reply and quote email sat written-but-unsent for 34 days.
    expect(covers(['LANCASHIRE', 'NORTH WEST'], '12 Example Parade, Example Town FY8 1AA')).toBe(true);
  });

  it('a contractor covering only the North West covers a PR and an M address', () => {
    expect(covers(['NORTH WEST'], '3 Example Row, Example Town PR4 2BB')).toBe(true);
    expect(covers(['NORTH WEST'], '7 Example Street, Example City M14 5CC')).toBe(true);
  });

  it('a contractor covering Lancashire does NOT cover a Kent address', () => {
    expect(covers(['LANCASHIRE'], '9 Example Lane, Example Village ME13 7DD')).toBe(false);
  });

  it('a contractor covering Cheshire does NOT cover an FY address', () => {
    expect(covers(['CHESHIRE'], '12 Example Parade, Example Town FY8 1AA')).toBe(false);
  });
});

describe('the send gate and the files an approved email names (findings 862, 1143, 1301)', () => {
  // The run root is read from AGENT_DISPATCH_DIR, the same variable the dispatcher itself uses,
  // so the test names the folder rather than trusting whatever this machine happens to have.
  const RUN_DIR = resolve(ROOT, 'tests');
  function gate() {
    const src = `
import json, os, sys, importlib.util
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
spec = importlib.util.spec_from_file_location("send_email", os.path.join(${JSON.stringify(SCRIPTS)}, "send-email.py"))
se = importlib.util.module_from_spec(spec)
spec.loader.exec_module(se)
print(json.dumps({
    "exts": sorted(se.ATTACH_EXTENSIONS),
    "mimeKeys": sorted(se.ATTACH_MIME),
    "roots": sorted(se.attach_roots()),
    "runRoot": se.ATTACH_RUN_ROOT,
}))
# The roots are read LIVE, so the selftest's own temp directory is honoured: a tuple frozen at
# import refused every case of send-email.py's selftest (caught by the full suite, 16 Nov 2026).
se.ATTACH_DIR = "/tmp/example-moved-attachments"
assert "/tmp/example-moved-attachments" in se.attach_roots(), "attach_roots() must re-read ATTACH_DIR"
`;
    return JSON.parse(execFileSync('python3', ['-c', src], {
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

  it('the dispatcher run folder is a second permitted root', () => {
    // Two approved emails could not be sent because their ATTACH header named the file where
    // the agent wrote it, and the only way out was to redraft a card Kevin had already read.
    const g = gate();
    expect(g.runRoot).toBe(RUN_DIR);
    expect(g.roots).toContain(RUN_DIR);
    expect(g.roots.length).toBe(2);
  });
});

describe('his words live on the card, not on the task they move (findings 915 and 1246)', () => {
  // The card is a real Tasks record shape: fields keyed by field id, plus createdTime.
  const CARD = 'recExampleCard01';
  const TARGET = 'recExampleTask77';

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
    expect(r.card).toMatch(/does not name recExampleTask77/);
  });

  it('a card that names only the month moves nothing: the exact date is required', () => {
    const r = check(card(`Move ${TARGET} some time in November.`), TARGET, '2026-11-16', OPEN, '2026-11-10');
    expect(r.card).toMatch(/does not name 2026-11-16/);
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
