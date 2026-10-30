import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeRunPy } from './helpers/dispatch-py.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = resolve(ROOT, 'scripts/create-agent-task.py');
const runPy = makeRunPy(GATE);

// The create-time duplicate gate (Kevin's rule, 25 Aug 2026: one subject =
// one open task; chasers fold into the existing task). The decision logic is
// pure (decide/build_update take data, return data), so it is exercised here
// through the real module — no copied logic, no network.

describe('the gate script', () => {
  it('passes its own selftest (17 behavioural checks)', () => {
    const out = JSON.parse(execFileSync('python3', [GATE, 'selftest'], { encoding: 'utf8' }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(17);
  });

  it('never folds across counterparties: a matching subject with a different sender creates, with a note', () => {
    // Two creditors can both send "Outstanding invoices". Folding one
    // creditor's tier-1 letter into another creditor's task would be far
    // worse than a duplicate — the gate must refuse and say why.
    const F = runPy('mod.F');
    const verdict = runPy(`mod.decide(
      {mod.F["name"]: "INBOUND: Outstanding invoices", mod.F["inboundSender"]: "a@creditor-one.co.uk"},
      [{"id": "recX", "createdTime": "2026-08-01T00:00:00.000Z", "fields": {
        mod.F["name"]: "INBOUND: Outstanding invoices",
        mod.F["status"]: {"name": "Today"},
        mod.F["inboundSender"]: "b@creditor-two.co.uk"}}])`);
    expect(verdict.action).toBe('create');
    expect(verdict.note).toContain('different sender');
    expect(F.name).toBe('fldgFjGBw6bTKJFCD'); // write-side id sanity
  });

  // REGRESSION, finding 20261001-inbound-triage-693: a supplier's follow-up arrived from
  // a different sending subdomain of the same company domain, so the gate read it as a
  // different counterparty and would have created a twin card. Folded on the registrable
  // domain now. Back-tested by comparing the full host again: the first case flips to
  // create and the whole block fails.
  it('folds one company across two sending subdomains, and still never folds two companies or free mail', () => {
    const agree = (a, b) => runPy(`mod.senders_agree(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    // THE BUG: same company, two sending subdomains.
    expect(agree('billing@mail.supplier.co.uk', 'noreply@email.supplier.co.uk')).toBe(true);
    expect(agree('a@mail.supplier.com', 'b@supplier.com')).toBe(true);
    // CONTROL 1: the .co.uk suffix must not fold two unrelated UK companies.
    expect(agree('a@mail.creditor-one.co.uk', 'b@mail.creditor-two.co.uk')).toBe(false);
    expect(agree('a@creditor-one.co.uk', 'b@creditor-two.co.uk')).toBe(false);
    // CONTROL 2: free mail never folds, whole domain or subdomain.
    expect(agree('a@gmail.com', 'b@gmail.com')).toBe(false);
    expect(agree('a@mail.gmail.com', 'b@smtp.gmail.com')).toBe(false);
    // CONTROL 3: the existing rules still hold.
    expect(agree('', '')).toBe(true);
    expect(agree('a@supplier.co.uk', '')).toBe(false);
    // The registrable-domain helper itself.
    expect(runPy(`mod.registrable_domain("mail.supplier.co.uk")`)).toBe('supplier.co.uk');
    expect(runPy(`mod.registrable_domain("supplier.co.uk")`)).toBe('supplier.co.uk');
    expect(runPy(`mod.registrable_domain("a.b.supplier.com")`)).toBe('supplier.com');
  });

  it('a task sitting at Approval keeps its status and soft due — the fold never pulls it out of the queue', () => {
    // The PATCH itself bumps Last Modified Time, so the Slack stale-approval
    // guard will make Kevin re-read before approving — intended: new material
    // on a matter he is signing off MUST force a re-read. What the fold must
    // never do is move the task out of Approval or drag its dates around on
    // a soft chaser.
    const patch = runPy(`mod.build_update(
      {mod.F["desc"]: "With Kevin.", mod.F["status"]: {"name": "Approval"},
       mod.F["due"]: "2026-08-28", mod.F["priority"]: {"name": "Urgent"}},
      {mod.F["name"]: "INBOUND: chaser", mod.F["desc"]: "Third chaser arrived.",
       mod.F["status"]: "Today", mod.F["due"]: "2026-08-25", mod.F["priority"]: "High"},
      "2026-08-25")`);
    const F = runPy('mod.F');
    expect(patch[F.desc]).toContain('Third chaser arrived.');
    expect(patch[F.desc]).toContain('UPDATE 2026-08-25');
    expect(patch[F.status]).toBeUndefined();
    expect(patch[F.due]).toBeUndefined();
    expect(patch[F.priority]).toBeUndefined();
  });

  it('write-side field ids match the triage create spec in agent-dispatch.py', () => {
    // agent-dispatch.py REVIEW_TASK_FIELDS mirrors the same spec; a drifted
    // id here would silently read/write the wrong field.
    const dispatch = readFileSync(resolve(ROOT, 'scripts/agent-dispatch.py'), 'utf8');
    const block = dispatch.match(/REVIEW_TASK_FIELDS = \{([\s\S]*?)\}/);
    expect(block, 'REVIEW_TASK_FIELDS in agent-dispatch.py (control)').not.toBeNull();
    const F = runPy('mod.F');
    for (const key of ['name', 'status', 'due', 'team', 'priority', 'desc']) {
      const m = block[1].match(new RegExp(`"${key}":\\s*"(fld[A-Za-z0-9]+)"`));
      expect(m, `${key} in REVIEW_TASK_FIELDS`).not.toBeNull();
      expect(F[key], `field id for ${key}`).toBe(m[1]);
    }
  });

  it('the ids REVIEW_TASK_FIELDS lacks are pinned against the triage skill field list', () => {
    // inboundSender gates the never-fold-across-counterparties rule; a wrong
    // id there reads every sender as blank and folds anything with a matching
    // key. inboundUrl carries the fold trace that stops the stranded-sweep
    // refold loop. hardDeadline protects real-world dates. None appear in
    // agent-dispatch.py, so pin them to the skill's own field list.
    const skill = readFileSync(resolve(ROOT, '.claude/scheduled-tasks/inbound-email-triage/SKILL.md'), 'utf8');
    const F = runPy('mod.F');
    const PINS = [
      ['inboundSender', 'Inbound Sender'],
      ['inboundUrl', 'Inbound Note URL Link'],
      ['hardDeadline', 'Hard Deadline'],
    ];
    for (const [key, label] of PINS) {
      const m = skill.match(new RegExp('`(fld[A-Za-z0-9]+)`[^\\n]*' + label));
      expect(m, `${label} id in the triage skill (control)`).not.toBeNull();
      expect(F[key], `field id for ${key}`).toBe(m[1]);
    }
  });
});

describe('the skills actually route creates through the gate', () => {
  // A gate nobody is told to use prevents nothing. Both task-creating
  // inbound skills must name the script in their create steps — this is the
  // same skill-vs-code drift guard pattern as agent-dispatch-tier1.
  const SKILLS = [
    '.claude/scheduled-tasks/inbound-email-triage/SKILL.md',
    '.claude/scheduled-tasks/inbound-messages-sweep/SKILL.md',
  ];
  for (const rel of SKILLS) {
    it(`${rel} calls scripts/create-agent-task.py`, () => {
      const text = readFileSync(resolve(ROOT, rel), 'utf8');
      expect(text).toContain('scripts/create-agent-task.py');
      expect(text).toMatch(/create --fields-json/);
    });
  }
});

// ---------------------------------------------------------------------------
// A HARD DEADLINE IS THE DATE THE LETTER STATES, NOT THE DAY IT ARRIVED.
//
// Finding 20260904-daily-ops-phase2-447. On 4 Sep 2026 the daily
// `hard-deadline-passed-still-open` invariant showed nine open tasks past
// their date. Two of them were not late at all — triage had stamped the day
// the mail arrived while the deadline sat in the task's own name:
//
//   "INBOUND: Simarc - pay ground rent GBP 6 by 29 Sep …"     Due 2026-09-01
//   "INBOUND: HMRC formal compliance check … respond by Sep 17"  Due 2026-09-01
//
// The invariant is the alarm for genuinely missed legal windows, so filling it
// with false alarms is the expensive half of this bug, not the chasing.
//
// The correction is deliberately narrow, and the "never" cases below are the
// point of the test: it only moves a due date LATER, only on one unambiguous
// stated date, only on a HARD deadline, and only inside a real horizon.
// ---------------------------------------------------------------------------
describe('a hard deadline carries the stated date, not the receipt date', () => {
  const TODAY = 'mod.date(2026, 9, 4)';

  function correct(name, due, { hard = true, desc = '' } = {}) {
    const got = runPy(`mod.hard_deadline_correction(
      {mod.F["name"]: arg["name"], mod.F["due"]: arg["due"], mod.F["desc"]: arg["desc"],
       **({mod.F["hardDeadline"]: True} if arg["hard"] else {})}, ${TODAY})`,
      { name, due, desc, hard });
    return got ? got[0] : null;
  }

  it('takes the deadline the task states over the day the item arrived', () => {
    expect(correct('INBOUND: Simarc - pay ground rent GBP 6 by 29 Sep, 23 Viola Street Bootle',
      '2026-09-01')).toBe('2026-09-29');
    expect(correct('INBOUND: HMRC formal compliance check Self Assessment - respond by Sep 17',
      '2026-09-01')).toBe('2026-09-17');
  });

  it('reads the date formats these letters actually use', () => {
    expect(correct('INBOUND: pay by 29/09/2026', '2026-09-01')).toBe('2026-09-29');
    expect(correct('INBOUND: respond no later than 17 September 2026', '2026-09-01')).toBe('2026-09-17');
    expect(correct('INBOUND: hearing', '2026-09-01', { desc: 'attend on or before 2026-10-02' })).toBe('2026-10-02');
    // A slash date is UK order. Reading 29/09 as month-first would silently
    // produce no date at all, which reads exactly like "nothing stated".
    expect(correct('INBOUND: pay by 09/29/2026', '2026-09-01')).toBeNull();
  });

  it('never guesses: two stated dates, or none, leave the due date alone', () => {
    expect(correct('INBOUND: by 5 Sep and by 29 Sep', '2026-09-01')).toBeNull();
    expect(correct('INBOUND: tenant rang about the boiler', '2026-09-01')).toBeNull();
    // A date with no deadline word in front of it is not a deadline.
    expect(correct('INBOUND: your statement dated 29 Sep is attached', '2026-09-01')).toBeNull();
  });

  it('never touches a SOFT due date — only a hard deadline is a real-world date', () => {
    expect(correct('INBOUND: pay by 29 Sep', '2026-09-01', { hard: false })).toBeNull();
  });

  it('only ever moves a due date LATER, never earlier', () => {
    // Pulling a deadline forward invents an obligation. A stated date already
    // behind the due date is a date dealt with, or one we have misread.
    expect(correct('INBOUND: pay by 1 Sep', '2026-09-20')).toBeNull();
  });

  it('refuses a date beyond the horizon, and a bare month/day does not roll a year', () => {
    // "by 29 Sep 2027" on a letter that arrived on 1 Sep 2026 is a misparse.
    expect(correct('INBOUND: renewal by 29 Sep 2027', '2026-09-01')).toBeNull();
    // The wild version of this bug: anchoring the year to the DUE date turned
    // "pay by 1 Sep" on a task due 20 Sep into 1 September of the NEXT year.
    expect(runPy(`[d.isoformat() for d in mod.stated_deadlines("pay by 1 Sep", ${TODAY})]`))
      .toEqual(['2026-09-01']);
    // A genuine rollover still works: a December letter naming 3 January.
    expect(correct('INBOUND: court by 3 Jan', '2026-12-20')).toBe('2027-01-03');
  });

  it('applies the correction before anything reads the due date', () => {
    // build_update keeps the EARLIER of two hard dates, so a receipt date left
    // uncorrected would win the fold and outlive the create it came in on.
    const src = readFileSync(GATE, 'utf8');
    const fix = src.indexOf('hard_deadline_correction(fields, date.today())');
    const dupe = src.indexOf('verdict = {"action": "create"');
    expect(fix).toBeGreaterThan(-1);
    expect(fix).toBeLessThan(dupe);
  });
});

// ─── AN ADDRESS IS NOT A SUBJECT (finding 20260925-agent-dispatch-605) ──
//
// Reproduced before the fix: creating "Send GSC quote requests ... 23 Viola
// Street Bootle L20 7DR" folded into the licence-fee card sitting at Kevin's
// approval gate and overwrote its Description with gas-safety content. The
// two names shared exactly two "telling" words — `l20` and `7dr` — because
// placeTokens recognises a place by its STREET TYPE and nothing marked the
// postcode halves as address.
//
// Back-tested by deleting the fold_on_address_only calls in decide(): the
// first case below flips to action "update" on recX.
describe('a shared address is never enough to fold one task into another', () => {
  const F = runPy('mod.F');
  const board = (name) => ([{
    id: 'recX',
    createdTime: '2026-09-20T00:00:00.000Z',
    fields: { [F.name]: name, [F.status]: { name: 'Approval' } },
  }]);
  const decide = (incoming, existing) => runPy(
    `mod.decide(arg[0], arg[1])`, [{ [F.name]: incoming }, board(existing)]);

  const LICENCE = 'COMPLIANCE: Sefton Council HMO licence fee overdue - 23 Viola Street Bootle L20 7DR';

  it('the incident: gas safety quotes do NOT fold into a licence fee at the same house', () => {
    const v = decide(
      'Send GSC quote requests - Bootle Gas Engineers and Able Group - 23 Viola Street Bootle L20 7DR',
      LICENCE);
    expect(v.action).toBe('create');
    expect(v.taskId).toBeUndefined();
  });

  it('the postcode halves are what did it: both are read as address, not subject', () => {
    expect(runPy('sorted(mod._postcode_tokens(arg))',
      '23 Viola Street Bootle L20 7DR')).toEqual(['7dr', 'bootle', 'l20']);
    // The outward half ALONE is not an address — plenty of harmless tokens
    // look like it — so only the adjacent pair counts.
    expect(runPy('sorted(mod._postcode_tokens(arg))', 'quote ref L20 for the job')).toEqual([]);
  });

  it('CONTROL: the same matter at the same address still folds', () => {
    // Without this the fix would be indistinguishable from switching folding
    // off, which is the failure mode the 28 Aug 2026 second pass exists for.
    const v = decide(
      'INBOUND: Sefton Council HMO licence fee 150 unpaid 23 Viola Street Bootle L20 7DR',
      LICENCE);
    expect(v.action).toBe('update');
    expect(v.taskId).toBe('recX');
  });

  it('CONTROL: a phone number is identity, not address, and still folds across one house', () => {
    const v = decide(
      'INBOUND: SMS reply from +447700900747 about 23 Viola Street Bootle L20 7DR',
      'INBOUND: SMS from 447700900747 - 23 Viola Street Bootle L20 7DR');
    expect(v.action).toBe('update');
    expect(v.matchedWhy).toContain('phone');
  });
});


// ─── A NUMBER ALONE IS NEVER A SUBJECT (14 Oct 2026, twice in one day) ──
//
// Creating a lender request for a mortgage interest certificate at 1406
// Oldham Road folded it into the OPEN, ALREADY-APPROVED pest-control quote
// chase at the same property. The gate exited 0 with {"action": "updated",
// "matchedName": "COMPLIANCE: Pest control quote chase ..."}, so the request
// looked done and was not; the appended paragraph was stripped off the
// pest-control card by hand and the request re-created under a name that did
// not collide.
//
// The house number did it. dupe_signals reads four or more digits as a
// reference number, 1406 is not a calendar year, so both names carried
// `num:1406`; ONE shared strong id is proof of identity on its own, ahead of
// the address rules and the word threshold, and fold_on_address_only lets a
// strong id through by design.
//
// THREE DRAFTS, TWO WRONG, both found by review. All three are pinned here:
//   1. Demoting house numbers out of the strong set — breaks the pairs the
//      strong pass exists for.
//   2. Letting ONE shared telling word carry the fold — a LOWER bar than
//      DUPE_MIN_SHARED, which re-enabled the fold finding 605 refuses.
//   3. Firing only on a number the address reader recognises as a house
//      number — FAILED OPEN on six ordinary spellings of one address, and
//      invented houses out of "claim 1406 small claims court".
// What shipped asks nothing about addresses: when the only agreement is a
// number, the fold must stand on the words, at the bar the word pass sets.
//
// Names are invented (public repo) except the street, which this repo's test
// corpus already carries; the shapes are the incident's and the review's.
// Back-tested by deleting the fold_on_a_number_only call in decide(): the
// first case flips to action "update" on recX and this block fails.
describe('a shared number is never enough to fold one task into another', () => {
  const F = runPy('mod.F');
  const row = (id, name, status = 'Approval', created = '2026-10-13T00:00:00.000Z') => ({
    id, createdTime: created, fields: { [F.name]: name, [F.status]: { name: status } },
  });
  const decide = (incoming, board) => runPy(`mod.decide(arg[0], arg[1])`,
    [{ [F.name]: incoming }, board]);
  const one = (incoming, existing) => decide(incoming, [row('recX', existing)]);
  const guard = (a, b, shared) => runPy(
    `mod.fold_on_a_number_only(arg[0], arg[1], arg[2])`, [a, b, shared]);

  const PEST = 'COMPLIANCE: Pest control quote chase (Vermguard, Able Group) - 1406 Oldham Road';
  const LENDER = 'Mortgage lender - request interest certificate 2019-20 for 1406 Oldham Road (account 90000111)';

  it('the incident: a lender request does NOT fold into an approved pest-control card at the same house', () => {
    const v = one(LENDER, PEST);
    expect(v.action).toBe('create');
    expect(v.taskId).toBeUndefined();
  });

  it('the house number is what did it: four digits read as a reference', () => {
    expect(runPy('sorted(mod.dupe_signals(arg)[1])', LENDER)).toContain('num:1406');
    expect(runPy(`mod.dupe_verdict(arg[0], arg[1], "fold")`, [LENDER, PEST]).shared)
      .toEqual(['num:1406']);
    expect(guard(LENDER, PEST, ['num:1406'])).toBe(true);
  });

  it('REGRESSION, draft three: no spelling of the address can switch the guard off', () => {
    // The draft that fired only on a number the address reader recognised as
    // a house number failed OPEN on all of these, each reproducing the
    // incident. This guard asks nothing about addresses.
    for (const addr of ['1406 Oldham Road', '1406, Oldham Road, Manchester',
      '1406 Deansgate', '1406 New Road', '1406 The Broadway',
      '1406-1408 Oldham Road', 'Flat 1406 Duckworth Court']) {
      expect(one(`Mortgage lender - request interest certificate 2019-20 for ${addr} (account 90000111)`,
        `COMPLIANCE: Pest control quote chase - ${addr}`).action, addr).toBe('create');
    }
  });

  it('REGRESSION, draft two: a shared number must never LOWER the bar (finding 605)', () => {
    // One shared telling word carried the fold in an earlier draft, which
    // re-enabled the gas-quote-into-licence-fee fold finding 605 refuses:
    // the two names share the TOWN, not the subject.
    expect(one(
      'COMPLIANCE: Send GSC quote requests - Manchester Gas Engineers - 1406 Oldham Road M40 1EZ',
      'COMPLIANCE: Manchester Council HMO licence fee overdue - 1406 Oldham Road M40 1EZ',
    ).action).toBe('create');
    expect(one(
      'Mortgage lender - landlord interest certificate for 1406 Oldham Road',
      'COMPLIANCE: Pest control quote chase, landlord to confirm - 1406 Oldham Road',
    ).action).toBe('create');
  });

  it('two different jobs at one house never fold — the live board of 14 Oct 2026', () => {
    // Three open jobs at one property that morning, and all three pairs
    // folded on num:1406 before this fix.
    const JOBS = [
      'MAINTENANCE: Pest control quote requests - 1406 Oldham Road M40 1EZ',
      'MAINTENANCE: Roy fwd - 1406 Oldham Road council matter (add to jobs list)',
      'MAINTENANCE: 1406 Oldham Road - urgent kitchen ceiling and rat infestation',
    ];
    for (const a of JOBS) {
      for (const b of JOBS) {
        if (a !== b) expect(one(a, b).action, `${a}\n  vs ${b}`).toBe('create');
      }
    }
    // NOT claimed here: two DIFFERENT houses sharing a number, one written
    // without a street type ("1406 Deansgate"), when the names also agree on
    // the subject ("gas safety cert due"). The word pass matches that pair on
    // its words with or without the number, and identity_conflict cannot see
    // a street with no street type. Pre-existing, and a separate fix.
  });

  it('a 10-digit reference is not a phone number, so two account numbers are not one thread', () => {
    // dupe_signals calls any 9-to-12 digit run `tel:` and compares the last
    // NINE digits, so two different 10-digit account numbers read as one
    // thread. The thread exemption is spent only on a number written as a UK
    // phone number.
    expect(runPy('sorted(mod._phone_shaped_ids(arg))', 'INBOUND: UTR 1234567890 filing due'))
      .toEqual([]);
    expect(runPy('sorted(mod._phone_shaped_ids(arg))', 'INBOUND: SMS reply from +447700900747'))
      .toContain('tel:700900747');
    // A mobile written with a space reaches the strong set as its PIECES, so
    // each piece is exempt too (found on the live board of 14 Oct 2026: two
    // SMS messages from one tenant, "07700 900318", would have been refused).
    expect(runPy('sorted(mod._phone_shaped_ids(arg))', 'INBOUND: [SMS] 07700 900318: hello'))
      .toEqual(['num:07700', 'num:900318', 'tel:700900318']);
    expect(one('INBOUND: [SMS] 07700 900318: the window in my second bedroom is stuck',
      'INBOUND: [SMS] 07700 900318: Roy asked me to text you about the window').action)
      .toBe('update');
    expect(one('INBOUND: Vectis Water account 1234567890 - arrears',
      'INBOUND: Marlstone Credit account 9234567890 - statement').action).toBe('create');
    // A 10-digit reference beginning with 0 looks like a phone number until
    // the subscriber digits are counted: a UK number carries its trunk
    // prefix AND ten more digits that do not start with 0.
    expect(runPy('sorted(mod._phone_shaped_ids(arg))', 'INBOUND: UTR 0123456789 filing'))
      .toEqual([]);
    expect(runPy('mod._uk_phone_digits(arg)', 'UTR 0123456789')).toBe('');
    expect(runPy('mod._uk_phone_digits(arg)', '+44 (0)7700 900318')).toBe('7700900318');
    expect(one('INBOUND: Vectis Water account 0123456789 - meter reading needed',
      'COMPLIANCE: Pest control quote chase - 1406 Oldham Road, acct 0123456789').action)
      .toBe('create');
  });

  it('a mobile written six ways is one thread, and only when BOTH names carry it', () => {
    // The exemption is the only way past the bar, so it is spent only on a
    // number shaped like a UK phone number, in both names. Each of these is
    // how a signature block, a letterhead or a tenant actually writes one.
    for (const n of ['07700 900318', '07700-900318', '07700900318',
      '+44 (0)7700 900318', '(07700) 900318', '0044 7700 900318']) {
      expect(one(`INBOUND: SMS reply from ${n}`,
        `INBOUND: SMS from ${n} - unknown content`).action, n).toBe('update');
    }
    // Two spellings of the same number are still one thread.
    expect(one('INBOUND: SMS reply from +44 (0)7700 900318',
      'INBOUND: SMS from 07700 900318 - unknown content').action).toBe('update');
    // A reference that happens to equal a run inside someone's mobile is NOT
    // that thread: the exemption needs the number in both names.
    expect(one('COMPLIANCE: Vermguard invoice 900318 overdue',
      'INBOUND: SMS reply from 07700 900318').action).toBe('create');
    expect(one('COMPLIANCE: Vermguard quote 07700 accepted',
      'INBOUND: SMS reply from 07700 900318').action).toBe('create');
    // A number that follows the phone number is not part of it.
    expect(runPy('sorted(mod._phone_shaped_ids(arg))',
      'INBOUND: SMS reply from +447700900747 - 1406 Oldham Road'))
      .toEqual(['num:447700900747', 'tel:700900747']);
  });

  it('two different mobiles are two threads, even sharing a digit group', () => {
    // A spaced mobile reaches the strong set as its PIECES, so a shared
    // 5-digit block ("07700") made two tenants one thread while the ids were
    // flattened across numbers. The queue has its own test against exactly
    // that ("two DIFFERENT phone numbers never merge on the words around
    // them"), written after two threads collapsed into one cluster.
    expect(one('INBOUND: SMS reply from 07700 900318',
      'INBOUND: SMS from 07700 900412 - unknown content').action).toBe('create');
    expect(one('INBOUND: SMS reply from 07700 900318',
      'INBOUND: SMS from 07701 900318 - unknown content').action).toBe('create');
    // Keyed on all TEN digits, not the nine dupe_signals compares, so a
    // mobile and a landline agreeing on their last nine stay two numbers.
    expect(runPy('sorted(mod._phone_numbers(arg).keys())', 'INBOUND: SMS from 07700 900318'))
      .toEqual(['7700900318']);
    expect(one('INBOUND: SMS reply from 07700 900318',
      'INBOUND: voicemail from 01700 900318 - unknown content').action).toBe('create');
  });

  it('the exemption is for a MESSAGE THREAD, not for anything phone-shaped', () => {
    // "account 01406 536055" is digit-for-digit a valid UK landline (01406 is
    // a real area code), so no shape test separates it from "call 01406
    // 536055". An earlier draft read the word in FRONT of the number against
    // a list of reference labels, and review found that list both too broad
    // and too narrow in one pass: "mobile no 07700 900318" was denied (losing
    // a real SMS thread, because "no" was on the list) while "a/c 01406
    // 536055" sailed through. So the test is on the MATTER: both names must
    // be about a message or a call.
    for (const label of ['account', 'a/c', 'customer', 'meter serial']) {
      expect(one(`INBOUND: Vectis Water ${label} 01406 536055 - meter reading needed`,
        `COMPLIANCE: Pest control quote chase - ${label} 01406 536055`).action, label)
        .toBe('create');
    }
    // And a real thread keeps its fold however the number is introduced.
    expect(one('INBOUND: SMS from tenant - mobile no 07700 900318',
      'INBOUND: text from mobile no 07700 900318 - boiler leak').action).toBe('update');
    expect(runPy('mod._about_a_message(arg)', 'COMPLIANCE: Pest control quote chase')).toBe(false);
    expect(runPy('mod._about_a_message(arg)', 'INBOUND: [SMS] 07700 900318: hello')).toBe(true);
    // A word that only SOMETIMES means a message never speaks for one: on
    // this board `missed` attaches to an instalment, an appointment or an
    // inspection, `ring` to a ring main circuit, `mobile` to a mobile home
    // and `call` to a call-out charge. Each granted the exemption to two
    // unrelated matters quoting one phone-shaped reference.
    for (const [a, b] of [['missed meter reading', 'missed appointment'],
      ['missed instalment', 'missed inspection'],
      ['ring main circuit', 'call-out charge disputed']]) {
      expect(one(`INBOUND: Vectis Water a/c 01406 536055 - ${a}`,
        `COMPLIANCE: Pest control quote chase - ${b} - a/c 01406 536055`).action, a)
        .toBe('create');
    }
    expect(runPy('mod._about_a_message(arg)', 'COMPLIANCE: missed inspection')).toBe(false);
    // A UK number cannot start 04, 05 or 06.
    expect(runPy('mod._uk_phone_digits(arg)', '05123456789')).toBe('');
  });

  it('a reference PREFIX is part of the reference, not the subject', () => {
    // Two obligations under the live HMRC compliance check cleared the word
    // bar on `hmrc` (the counterparty) and `cfs` (the case reference's own
    // prefix), at exactly the ratio, and the keeper was at Approval. Read
    // structurally, because no list can hold the prefix of a case nobody has
    // opened yet.
    expect(one('INBOUND: HMRC CFS-0000000 - provide bank statements by 16 Oct',
      'COMPLIANCE: HMRC CFS-0000000 response - rental income schedule').action).toBe('create');
    expect(runPy('sorted(mod._reference_prefixes(arg))', 'HMRC CFS-0000000 response'))
      .toEqual(['cfs']);
    // Two digits are a name, not a reference: UC47 is a form, v12 a version.
    expect(runPy('sorted(mod._reference_prefixes(arg))', 'UC47 form for 5 Dalham Place'))
      .toEqual([]);
    expect(runPy('sorted(mod._reference_prefixes(arg))', 'Renew v12 licence')).toEqual([]);
    expect(runPy('sorted(mod._reference_prefixes(arg))', '1406 Oldham Road M40 1EZ'))
      .toEqual([]);
  });

  it('a reference label is not a subject word', () => {
    // A UTR rides on every HMRC task name, so counting it as subject let an
    // HMRC filing fold into the APPROVED compliance-check response on
    // `hmrc` + `utr`, at exactly the bar. Same family as the address words
    // and the postcode halves.
    expect(one('INBOUND: HMRC self assessment filing due - UTR 0123456789',
      'COMPLIANCE: HMRC check CFS-0000000 response - UTR 0123456789').action).toBe('create');
    // CONTROL: a reference whose words DO agree still folds.
    expect(one('INBOUND: chase Vectis Water on account 44556677',
      'INBOUND: Vectis Water account 44556677 - final demand').action).toBe('update');
  });

  it('the separator people actually type keeps one thread', () => {
    // A number copied out of a PDF, a Word letter or a signature block
    // carries a non-breaking space or an en dash. This file already spells
    // out that character list for the same reason (DUPE_SPACES).
    for (const sep of [' ', '\u00a0', '\u2013', '\u2009', '.', '-']) {
      expect(one(`INBOUND: SMS reply from 07700${sep}900318`,
        `INBOUND: SMS from 07700${sep}900318 - unknown content`).action,
        JSON.stringify(sep)).toBe('update');
    }
  });

  it('the gate SAYS it created instead of folding, and names the card it left alone', () => {
    const v = one(LENDER, PEST);
    expect(v.note).toContain('created rather than folded');
    expect(v.note).toContain('recX');
    // It promises no surface it cannot keep: the page's Duplicates lane is
    // filtered to agent-owned tasks, so a card held by a person is in no lane.
    expect(v.note).not.toContain('Duplicates lane');
  });

  it('a refusal rides along with a fold elsewhere, worded for the path it is on', () => {
    const v = decide('Mortgage lender - interest certificate for 1406 Oldham Road', [
      row('recPEST', 'COMPLIANCE: Pest control quote chase - 1406 Oldham Road'),
      row('recLEND', 'INBOUND: Mortgage lender interest certificate request for 1406 Oldham Road',
        'Today', '2026-10-14T08:00:00.000Z'),
    ]);
    expect(v.action).toBe('update');
    expect(v.taskId).toBe('recLEND');
    expect(v.note).toContain('recPEST');
    expect(v.note).toContain('folded into recLEND');
    // It must not claim the gate created: it folded.
    expect(v.note).not.toContain('created rather than folded');
  });

  it('unreadable evidence refuses the fold — every earlier draft failed open', () => {
    expect(guard(LENDER, PEST, [])).toBe(true);
    expect(guard(LENDER, PEST, null)).toBe(true);
    expect(guard(LENDER, PEST, ['NUM:1406'])).toBe(true);
    expect(guard(LENDER, PEST, ['num:1406 '])).toBe(true);
    // A word-pass match has already cleared the bar and passes through.
    expect(guard('INBOUND: Sefton Council HMO licence fee unpaid',
      'COMPLIANCE: Sefton Council HMO licence fee overdue', ['licence', 'fee'])).toBe(false);
  });

  it('CONTROL: a phone number is one thread and still folds across one house', () => {
    const v = one('INBOUND: SMS reply from +447700900747 - 1406 Oldham Road',
      'INBOUND: SMS from 447700900747 - 1406 Oldham Road');
    expect(v.action).toBe('update');
    expect(v.matchedWhy).toContain('phone');
  });

  it('CONTROL: a reference still folds when the words agree, so the gate is not switched off', () => {
    // Without this the fix would be indistinguishable from disabling the
    // strong pass, which is the failure the 28 Aug second pass exists for.
    expect(one('INBOUND: chase Vectis Water on account 44556677',
      'INBOUND: Vectis Water account 44556677 - final demand').action).toBe('update');
    expect(one('INBOUND: Manchester Council HMO licence fee unpaid - 1406 Oldham Road',
      'COMPLIANCE: Manchester Council HMO licence fee overdue - 1406 Oldham Road').action)
      .toBe('update');
    expect(one('Chase Acme invoice #10', 'Chase Acme invoice #9').action).toBe('update');
  });

  it('THE COST, stated: a chaser that repeats nothing, and one shared word at one house', () => {
    // Deliberate, not a bug, and the price of refusing the incident: no
    // threshold can tell these apart from the pairs above. Kevin's ruling —
    // a duplicate card he can merge beats an approved card quietly rewritten.
    expect(one('INBOUND: 2nd reminder 10045678', 'INBOUND: Acme Roofing invoice 10045678').action)
      .toBe('create');
    expect(one('INBOUND: 1406 Oldham Road electrical safety cert outstanding',
      'INBOUND (follow-up): 1406 Oldham Road EICR cert - send to Manchester Council').action)
      .toBe('create');
    // The page still GROUPS both pairs, so nothing is hidden from Kevin.
    expect(runPy(`mod.dupe_verdict(arg[0], arg[1], "group")`,
      ['INBOUND: 1406 Oldham Road electrical safety cert outstanding',
       'INBOUND (follow-up): 1406 Oldham Road EICR cert - send to Manchester Council']).match)
      .toBe(true);
  });
});

// A CARD KEVIN HAS DECIDED IS NEVER FOLDED INTO.
//
// Finding 20261016-inbound-email-triage-952, seen twice, and the second
// instance of the family: on 16 Oct 2026 the key pass folded three unrelated
// requests from one sender into an APPROVED task on the key `inbound|asks
// roy`, and the day before it folded two unrelated matters from one
// counterparty, one of them into an approved card. The 14 Oct incident at 1406
// Oldham Road was the same ending reached through a shared number.
//
// Kevin has already READ a card he decided, so a paragraph appended to it
// afterwards is invisible by construction: never approved, never carried out,
// and the gate exits 0 with {"action": "updated"} so the work looks done. The
// guard asks nothing about the words — the other two fold guards exist for
// that, and this family keeps arriving through a different one of them.
//
// Back-tested by deleting the fold_into_a_decided_card calls in decide(): the
// first three cases flip to action "update" and this block fails.
describe('a fold never lands on a card Kevin has already decided', () => {
  const F = runPy('mod.F');
  const row = (name, extra = {}) => ({
    id: 'recDecided',
    createdTime: '2026-10-13T00:00:00.000Z',
    fields: { [F.name]: name, [F.status]: { name: 'Approval' }, ...extra },
  });
  const one = (incoming, existing, extra) => runPy(`mod.decide(arg[0], arg[1])`,
    [{ [F.name]: incoming }, [row(existing, extra)]]);

  const ASKS = 'INBOUND: Roy asks for the Devon Street keys';
  const SAME = 'INBOUND: Roy asks for the Devon Street keys back';

  it('an approval alone refuses the fold, on a pair that otherwise folds', () => {
    // The control: with no verdict on the card, this pair IS one matter.
    expect(one(SAME, ASKS).action).toBe('update');
    expect(one(SAME, ASKS, { [F.approvalOutcome]: { name: 'Approved as-is' } }).action)
      .toBe('create');
    expect(one(SAME, ASKS, { [F.approvedAt]: '2026-10-16T09:00:00.000Z' }).action)
      .toBe('create');
  });

  it('a card Kevin SENT BACK is refused too: he has read that one as well', () => {
    expect(one(SAME, ASKS, { [F.approvalOutcome]: { name: 'Request changes' } }).action)
      .toBe('create');
  });

  it('names the record and says why, so the refusal can be audited', () => {
    const v = one(SAME, ASKS, { [F.approvalOutcome]: { name: 'Approved as-is' } });
    expect(v.note).toContain('recDecided');
    expect(v.note).toMatch(/already decided it \(Approved as-is\)/);
  });

  it('refuses through the key pass as well, not only the word pass', () => {
    // Identical names: the exact-key bucket, which is the pass that folded the
    // three requests into the approved card on `inbound|asks roy`.
    const v = one(ASKS, ASKS, { [F.approvalOutcome]: { name: 'Approved as-is' } });
    expect(v.action).toBe('create');
    expect(v.note).toContain('same subject key');
  });

  it('an undecided card elsewhere on the board is never listed as refused', () => {
    // The note is for pairs that LOOKED alike. A board full of approved cards
    // about other things must not fill it.
    const v = runPy(`mod.decide(arg[0], arg[1])`, [{ [F.name]: SAME }, [
      { id: 'recOther', createdTime: '2026-10-01T00:00:00.000Z',
        fields: { [F.name]: 'COMPLIANCE: Gas safety record for 82 Devon Street',
          [F.status]: { name: 'Approval' },
          [F.approvalOutcome]: { name: 'Approved as-is' } } },
    ]]);
    expect(v.action).toBe('create');
    expect(v.note).toBeUndefined();
  });

  it('the fold path can SEE an approval: the open-task read asks for both fields', () => {
    // The gate could not refuse what it never read — fetch_open_tasks listed
    // eleven field ids and neither approval field was among them.
    const src = readFileSync(GATE, 'utf8');
    const fn = src.slice(src.indexOf('def fetch_open_tasks'), src.indexOf('def post_comment'));
    expect(fn).toContain('F["approvalOutcome"]');
    expect(fn).toContain('F["approvedAt"]');
  });
});

// ─── TWO SUBJECT SLOTS ARE NOT A SUBJECT ─────────────────────────────────
//
// Six findings, one mechanism: 20260925-agent-dispatch-623,
// 20261002-inbound-email-triage-711, 20261007-inbound-email-triage-783,
// 20261017-inbound-email-triage-963, 20261019-inbound-email-triage-1000 and
// 20261026-inbound-triage-1091. The KEY pass folded on its two subject slots
// with none of the strictness the verdict pass has carried since 25 Sep, so
// every `COMPLIANCE: file certificate - <type> - <property>` name reduced to
// `compliance|certificate file` and ANY two filing tasks folded into each
// other. Listed in .claude/rules/agent-task-pipeline.md as known and NOT
// fixed: "the key pass folds two different matters from one counterparty on
// its two subject slots".
//
// Three guards, one per way the pairs fail: the key match must clear the word
// pass's own PROPORTION (`fold_on_a_shared_key_only`); the qualifier segments
// after the first " - " must agree with each other when both names have them
// (`fold_on_a_different_qualifier`); and two names that each carry a
// reference and share none are different matters
// (`fold_on_a_different_reference`).
//
// Measured read-only against the live board, 29 Oct 2026, 332 open tasks: 79
// folds under origin/main, 31 under this change, 48 newly refused and ZERO
// newly folded. Every pair sampled was two different matters (two months of
// one project, two repairs at one building, two insurance policies, episode
// after episode of the Content Engine folding into one card). Back-tested by
// removing each guard from decide() in turn: the first case of each `it`
// below flips to "update".
//
// Names are invented or already in this repo's test corpus (public repo); the
// shapes are the findings'.
describe('two subject slots are not a subject', () => {
  const F = runPy('mod.F');
  const row = (id, name, status = 'Today', created = '2026-10-01T00:00:00.000Z') => ({
    id, createdTime: created, fields: { [F.name]: name, [F.status]: { name: status } },
  });
  const one = (incoming, existing, status = 'Today') => runPy('mod.decide(arg[0], arg[1])',
    [{ [F.name]: incoming }, [row('recX', existing, status)]]);

  it('finding 963: two filing tasks for different properties key alike and no longer fold', () => {
    const v = one('COMPLIANCE: file certificate - gas safety record x4 - Roc Immo portfolio',
      'COMPLIANCE: file certificate - fire alarm and emergency lighting - Duckworth Building');
    expect(runPy('mod.dupe_task_key(arg)', 'COMPLIANCE: file certificate - gas safety record x4 - Roc Immo portfolio'))
      .toBe('compliance|certificate file');          // the key really is that generic
    expect(v.action).toBe('create');
    expect(v.note).toContain('too little else to be one matter');
  });

  it('finding 1000: a type and a property the other name does not carry refuse the fold', () => {
    expect(one('COMPLIANCE: file certificate - insurance schedules x6 - TNT Management portfolio',
      'COMPLIANCE: file certificate - fire alarm and emergency lighting - Duckworth Building').action)
      .toBe('create');
  });

  it('finding 783: ONE house, TWO documents — the qualifier says which matter it is', () => {
    const v = one('COMPLIANCE: file certificate - PAT certificate - 22 Newton Street',
      'COMPLIANCE: file certificate - gas safety record - 22 Newton Street');
    expect(v.action).toBe('create');
    expect(v.note).toContain('what the matter IS');
    // ... and the guard compares qualifier to qualifier, never against the
    // whole other name: both of these carry `certificate` in their subject.
    expect(runPy('mod.fold_on_a_different_qualifier(arg[0], arg[1])',
      ['COMPLIANCE: file certificate - PAT certificate - 22 Newton Street',
        'COMPLIANCE: file certificate - gas safety record - 22 Newton Street'])).toBe(true);
  });

  it('finding 623: two policies, two insurers, two references — never one matter', () => {
    const a = 'INSURANCE: Replacement Property Owners cover via TopCashback before 3 Oct 2026 - 30 Burnbank Gardens (PIB 931520229)';
    const b = 'INSURANCE: Replacement Property Owners cover via TopCashback before 15 Oct 2026 - TNT Management portfolio (Swinton 178710769)';
    expect(one(a, b, 'Approval').action).toBe('create');
    expect(runPy('mod.fold_on_a_different_reference(arg[0], arg[1])', [a, b])).toBe(true);
    // One side carrying a reference the other does not decides NOTHING: a
    // chaser often names one the first task never had.
    expect(runPy('mod.fold_on_a_different_reference(arg[0], arg[1])',
      ['INBOUND: chase Vectis Water on account 44556677', 'INBOUND: Vectis Water final demand'])).toBe(false);
  });

  it('finding 1091: one name says WHERE and the other says none, so it must say nothing else new', () => {
    expect(one('COMPLIANCE: landlord insurance renewal quote needed',
      'COMPLIANCE: landlord insurance renewal - 6 Chedburgh Place').action).toBe('create');
    // The control this rule has to keep: a name that adds NOTHING the other
    // does not carry is the same matter and still folds.
    expect(one('Provision of a valid EICR',
      'COMPLIANCE: Provision of a valid EICR - 18 Siddows Avenue Clitheroe').action).toBe('update');
  });

  it('finding 711: a second request from one sender does not land under the first', () => {
    expect(one('INBOUND: Roy asks about a benefit top-up and refund for a tenant',
      'INBOUND: Roy asks for bins to be ordered at 5 Dalham Place', 'Approval').action).toBe('create');
  });

  it('THE COST, and the catches that must survive: a real duplicate still folds', () => {
    // Kevin's ruling, 14 Oct 2026: a duplicate he can merge beats an approved
    // card quietly rewritten. But the key pass must keep what it exists for.
    expect(one('COMPLIANCE: file certificate - gas safety record - 5 Dalham Place',
      'COMPLIANCE: file certificate - gas safety record - 5 Dalham Place').action).toBe('update');
    expect(one('COMPLIANCE: file certificate - gas safety record - 5 Dalham Place',
      'COMPLIANCE: file certificate - gas safety record for 5 Dalham Place').action).toBe('update');
    expect(one('COMPLIANCE: file certificate - EPC - 5 Dalham Place',
      'COMPLIANCE: file certificate - EPC - 5 Dalham Place').action).toBe('update');
    // A short name whose whole subject agrees: the count would refuse this
    // pair (`invoice` is a reference label, leaving one telling word), which
    // is why the key pass asks for the PROPORTION and not the count.
    expect(one('Chase Acme invoice #10', 'Chase Acme invoice #9').action).toBe('update');
    // One SMS thread is one matter however differently the two names put it:
    // a shared strong id is identity and the qualifier guard stays silent.
    expect(one('INBOUND: SMS from tenant - mobile no 07700 900318',
      'INBOUND: text from mobile no 07700 900318 - boiler leak').action).toBe('update');
    // Extra detail on ONE name is not a different matter.
    expect(one('INBOUND: SMS reply from 07700 900318',
      'INBOUND: SMS from 07700 900318 - unknown content').action).toBe('update');
  });

  it('the mirrors are untouched, so the Duplicates lane still SHOWS Kevin every pair', () => {
    // Fold-only and Python-only, like the three guards before it: the page
    // that groups these pairs is protected, and grouping shows while folding
    // destroys. If dupe_verdict or dupe_task_key had moved, the drift test in
    // agents-dupe-task-key.test.js would fail — this asserts the verdict
    // still MATCHES the pairs the fold now refuses.
    const page = readFileSync(resolve(ROOT, 'os/agents/index.html'), 'utf8');
    expect(page).not.toContain('foldOnADifferentQualifier');
    expect(runPy('mod.dupe_verdict(arg[0], arg[1], "fold")',
      ['COMPLIANCE: file certificate - PAT certificate - 22 Newton Street',
        'COMPLIANCE: file certificate - gas safety record - 22 Newton Street']).match).toBe(true);
  });
});
