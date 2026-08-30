import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const FORMAT = resolve(ROOT, 'scripts/agent_email_format.py');
const GUARDRAILS = resolve(process.env.HOME, '.claude/agents/GUARDRAILS.md');

// WAVE 1 OF THE APPROVAL-GATE REVIEW (27 Aug 2026).
//
// Measured across every approval decision Kevin had ever made, live from
// Airtable that day:
//
//   * 175 decisions. 58 rejections. NOT ONE said the draft was wrong — every
//     one said the task should not have existed. Raw "accuracy" read 66.9%;
//     excluding relevance failures it was 96.7%.
//   * 22 approvals with minor edits, of which 14 (64%) were him correcting one
//     of two things by hand: the sending address (11x) and a signature block
//     he did not want (3x). Neither rule was written down anywhere.
//   * 13 of the 60 tasks waiting were automation failure emails. Approving
//     "investigate the failing script" does nothing: agents are read-only on
//     code.
//
// Both fixes are in CODE rather than prose, because the sender rule already
// existed as prose in six lesson lines across four agent files and changed
// nothing — the same lesson the learning loop itself learned when 54 redos
// produced zero stored lessons.

function py(code) {
  const script = `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location("ad", ${JSON.stringify(DISPATCH)})
ad = importlib.util.module_from_spec(spec); spec.loader.exec_module(ad)
import agent_email_format as fmt
${code}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

/** Build a Correspondence Agent Output. */
function draft({ from = 'kevinbrittain@gmail.com', subject = 'Council tax arrears',
                 body = 'Please freeze the account while I arrange a plan.',
                 signoff = 'Kind regards\nKevin Brittain' } = {}) {
  const head = ['TO: someone@council.gov.uk',
                from ? `FROM: ${from}` : null,
                `SUBJECT: ${subject}`].filter(Boolean).join('\n');
  return `${head}\n---\n${body}\n\n${signoff}`;
}

function validate(output) {
  return py(`
try:
    fmt.validate_submission(${JSON.stringify(output)})
    print(json.dumps({"ok": True, "error": ""}))
except fmt.EmailFormatError as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`);
}

describe('the sender default Kevin corrected 11 times in a month', () => {
  it('accepts an ordinary letter from the personal address', () => {
    expect(validate(draft()).ok).toBe(true);
  });

  it('REFUSES a draft with no FROM at all, rather than guessing one', () => {
    // This is the whole bug: FROM was optional, so every agent guessed and
    // Kevin corrected the guess at roughly two minutes a go.
    const r = validate(draft({ from: null }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no FROM address/);
  });

  it('REFUSES the Runpreneur address on work that is nothing to do with Runpreneur', () => {
    // Kevin's ruling, 27 Aug 2026, verbatim: "Never send from
    // kevin@runpreneur.org.uk unless it's to do with Runpreneur."
    const r = validate(draft({ from: 'kevin@runpreneur.org.uk' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nothing to do with Runpreneur/);
  });

  it('REFUSES the business address on a council letter', () => {
    const r = validate(draft({ from: 'kevin@operationsdirector.co.uk' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nothing in the copy speaks as the business/);
  });

  it('still catches the 12 Aug bug: business copy going out from a gmail address', () => {
    // Finding 20260812-ceo-huddle-094. Ten warm-lane emails saying "you booked
    // a call with Operations Director" were about to reach Kevin's highest
    // intent audience from a personal address. The new rule must not lose this.
    const r = validate(draft({ body: 'You booked a call with Operations Director and never came.' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/speaks as the business/);
  });

  it('allows each brand address on copy that genuinely speaks as that brand', () => {
    expect(validate(draft({ from: 'kevin@operationsdirector.co.uk',
      body: 'Operations Director can take this off your hands.' })).ok).toBe(true);
    expect(validate(draft({ from: 'kevin@runpreneur.org.uk',
      body: 'A Runpreneur update on the next ultra.' })).ok).toBe(true);
  });

  it('refuses an address that is not one of Kevin identities', () => {
    expect(validate(draft({ from: 'kev@somewhere-else.com' })).ok).toBe(false);
  });
});

describe('the sign-off default Kevin asked for three times in a week', () => {
  it('accepts his name alone', () => {
    expect(validate(draft({ signoff: 'Kind regards\nKevin Brittain' })).ok).toBe(true);
  });

  it('accepts "on behalf of" a company, which he does use', () => {
    expect(validate(draft({
      signoff: 'Kind regards\nKevin Brittain\non behalf of TNT Management Ltd' })).ok).toBe(true);
  });

  it('REFUSES a phone number under the sign-off', () => {
    const r = validate(draft({ signoff: 'Kind regards\nKevin Brittain\n07700 900123' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/phone number/);
  });

  it('REFUSES a home address under the sign-off', () => {
    const r = validate(draft({
      signoff: 'Kind regards\nKevin Brittain\n17 Newington, Willingham, Cambridge, CB24 5JE' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/address/);
  });

  it('REFUSES a contact email under the sign-off', () => {
    const r = validate(draft({ signoff: 'Kind regards\nKevin Brittain\ncontact@example.org' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/email address/);
  });

  // The two false-positive guards. Without these the rule would refuse most
  // genuine property and creditor correspondence, which is the failure mode
  // that would get the whole check disabled.
  it('does NOT mistake a postcode in the body for a signature block', () => {
    expect(validate(draft({
      body: 'Regarding 23 Viola Street Bootle L20 3AB, the EICR is overdue.' })).ok).toBe(true);
  });

  it('does NOT mistake a phone number quoted in the body for a signature block', () => {
    expect(validate(draft({
      body: 'I called their line on 0333 200 5100 and was cut off twice.' })).ok).toBe(true);
  });
});

describe('a machine reporting a breakage is not a decision for Kevin', () => {
  const alert = (sender, name) => py(
    `print(json.dumps({"hit": ad.system_alert_match(${JSON.stringify(sender)}, ${JSON.stringify(name)}, "", "") or ""}))`
  ).hit;

  it('catches every monitoring sender that clogged the queue', () => {
    expect(alert('noreply-apps-scripts-notifications@google.com', 'Meetings Intake failing')).toBeTruthy();
    expect(alert('noreply@airtable.com', 'Automation someday checkbox failing')).toBeTruthy();
    expect(alert('noreply@notify.cloudflare.com', 'KV put limit exceeded')).toBeTruthy();
  });

  it('catches an alert with no sender recorded, by its subject', () => {
    // The second label. The sender check cannot fire on a task an agent raised
    // itself after noticing the failure; the name check cannot fire on an
    // alert whose subject says nothing recognisable. Each covers the other.
    expect(alert('', 'Google Apps Script Invoices Dashboard failing')).toBeTruthy();
    expect(alert('roy.lavin1978@gmail.com', 'Gmail quota exceeded on the meetings script')).toBeTruthy();
  });

  it('leaves genuine decisions alone — this is the expensive direction to get wrong', () => {
    expect(alert('billing@edfenergy.com', 'Overdue payment for Apt 5 Duckworth')).toBe('');
    expect(alert('enforcement@hambury.co.uk', 'Notice of enforcement 36PP')).toBe('');
    // Stripe and Supabase read like monitoring and are genuinely actionable —
    // a verification deadline and a paused production project. Deliberately
    // NOT in the alert lane.
    expect(alert('noreply@stripe.com', 'Stripe action required, provide business info')).toBe('');
    expect(alert('no-reply@supabase.io', 'Supabase project sellmate auto-paused')).toBe('');
  });

  it('reports what it held back, so a diverted lane cannot look like a lost one', () => {
    const src = readFileSync(DISPATCH, 'utf8');
    expect(src).toMatch(/systemAlertsHeldBack/);
    expect(src).toMatch(/"systemAlerts": len\(system_alerts\)/);
  });
});

describe('the rules are enforced where they cannot be skipped', () => {
  it('the submit gate calls the STRICT validator, not the permissive parser', () => {
    // parse_output stays permissive on purpose: it also runs on the send path,
    // days after Kevin approved, and an approved action that cannot be carried
    // out is worse than a refused one. Strictness belongs at submit only.
    //
    // Broadened 28 Aug 2026. Correspondence used to mean email and nothing
    // else, so the gate refused a postal letter outright ("header line is not
    // KEY: value: 'Corporation Tax'") and an agent could not put a letter in
    // front of Kevin at all. validate_submission_any routes email to the same
    // strict checks as before, and post/sign to their own parsers, which ARE
    // their strict layer. The property under test is unchanged: submit
    // validates strictly, and never with the permissive parser.
    const src = readFileSync(DISPATCH, 'utf8');
    expect(src).toMatch(/validate_any_submission\(output\)/);
    expect(src, 'submit fell back to the permissive parser')
      .not.toMatch(/^\s*parse_email_output\(output\)/m);
  });

  it('the send path does NOT use the strict validator', () => {
    const send = readFileSync(resolve(ROOT, 'scripts/send-email.py'), 'utf8');
    expect(send).not.toMatch(/validate_submission/);
  });

  it('every agent is told the rules, not just refused by them', () => {
    const g = readFileSync(GUARDRAILS, 'utf8');
    expect(g).toMatch(/kevinbrittain@gmail\.com/);
    expect(g).toMatch(/on behalf of/);
    expect(g).toMatch(/FROM:` is now a \*\*required\*\* header/);
  });

  it('the three sending identities live in ONE place', () => {
    // A second copy is how the sender rule drifts back apart.
    const fmt = readFileSync(FORMAT, 'utf8');
    expect(fmt).toMatch(/ALLOWED_SENDERS = \(PERSONAL_SENDER, BUSINESS_SENDER, RUNPRENEUR_SENDER\)/);
  });
});

// ── THE SLACK EQUIVALENT OF THE REASON CHIPS ───────────────────────────────
//
// Kevin approves from his phone when he is away, so a reject there must record
// the same reason a reject at the desk does — otherwise the away path silently
// degrades the score the desk path just fixed.
describe('a reject from Slack records the same reason as a chip', () => {
  let splitReason;
  beforeAll(async () => {
    ({ splitReason } = await import(resolve(ROOT, 'scripts/slack-automation/approvals.js')));
  });

  it('maps each word to the reason the page uses', () => {
    const pairs = [
      ['done', 'Already done elsewhere'], ['roy', 'Roy owns it'],
      ['noise', 'Not worth my attention'], ['dupe', 'Duplicate'],
      ['park', 'Parked for now'], ['stale', 'No longer relevant'],
      ['wrong', 'The work is wrong'],
    ];
    pairs.forEach(([word, reason]) => {
      expect(splitReason(word).reason, word).toBe(reason);
    });
  });

  it('keeps the rest of the sentence as the note', () => {
    expect(splitReason('Roy - he has the keys')).toEqual({ reason: 'Roy owns it', note: 'he has the keys' });
    expect(splitReason('park until September')).toEqual({ reason: 'Parked for now', note: 'until September' });
  });

  it('a bare word is enough, because a chip needs no sentence either', () => {
    expect(splitReason('dupe')).toEqual({ reason: 'Duplicate', note: '' });
  });

  it('records NO reason rather than guessing one', () => {
    // This is the line that keeps the data honest. An unclassified rejection
    // still counts against the agent and the accuracy report says how many
    // there are; a guessed reason would quietly make an agent look better than
    // the evidence supports.
    expect(splitReason('I have handled this myself').reason).toBe('');
    expect(splitReason('').reason).toBe('');
    expect(splitReason(null).reason).toBe('');
  });

  it('the card tells Kevin the words exist', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/slack-automation/approvals.js'), 'utf8');
    ['done', 'roy', 'noise', 'dupe', 'park', 'stale', 'wrong'].forEach((w) => {
      expect(src, `card never mentions \`${w}\``).toContain('`' + w + '`');
    });
  });

  it('the Slack words and the page chips name the SAME reasons', () => {
    // Three copies of this list now exist (page, worker, scorer). A divergence
    // means a reason recorded on the phone is scored differently from the same
    // reason recorded at the desk.
    const page = readFileSync(resolve(ROOT, 'os/agents/index.html'), 'utf8');
    const worker = readFileSync(resolve(ROOT, 'scripts/slack-automation/approvals.js'), 'utf8');
    const names = ['Already done elsewhere', 'Roy owns it', 'Not worth my attention',
                   'Duplicate', 'Parked for now', 'No longer relevant', 'The work is wrong'];
    names.forEach((n) => {
      expect(page, `page missing ${n}`).toContain(n);
      expect(worker, `worker missing ${n}`).toContain(n);
    });
  });
});

// ── NOTHING IS SUPPRESSED INVISIBLY (wave 2, 27 Aug 2026) ──────────────────
//
// Two lanes now keep work out of Kevin's queue: system alerts are diverted to
// the board, and threads already answered are filed rather than drafted. Both
// are right, and both are the kind of change that quietly becomes a hole.
//
// The protection he asked for, in his words, is a list he can scan in twenty
// seconds — built in the SAME change as the suppression, never afterwards.
describe('what was kept off the queue is listed where Kevin already looks', () => {
  const page = () => readFileSync(resolve(ROOT, 'os/agents/index.html'), 'utf8');

  it('there is a lane for it on the Check these tab', () => {
    expect(page()).toContain("lane:'Kept off your queue'");
  });

  it('the lane reports a broken read instead of an empty list', () => {
    // An error that renders as "nothing was suppressed" is the failure this
    // lane exists to prevent, wearing the lane's own clothes.
    const src = page();
    const i = src.indexOf("lane:'Kept off your queue', error:");
    expect(i, 'no error branch on the suppression lane').toBeGreaterThan(-1);
  });

  it('the page classifier does not drift from the engine name patterns', () => {
    // The browser cannot see Inbound Sender, so it matches on NAME only and
    // under-reports rather than over-reports. But the name patterns themselves
    // must stay identical, or the list stops showing a whole category.
    const engine = readFileSync(resolve(ROOT, 'scripts/agent-dispatch.py'), 'utf8');
    const block = engine.match(/SYSTEM_ALERT_PATTERNS = \[([\s\S]*?)\]/)[1];
    const enginePatterns = [...block.matchAll(/r"([^"]+)"/g)].map((m) => m[1]);
    const pageRe = page().match(/const APV_ALERT_RE = \/([^/]+)\/i;/);
    expect(pageRe, 'page has no APV_ALERT_RE').toBeTruthy();
    // CONTROL: an empty parse on either side would compare '' to '' and pass.
    expect(enginePatterns.length).toBeGreaterThan(0);
    // Compare the WHOLE source, not a naive split on '|' — that would tear
    // `cloudflare (kv|worker)` in half and fail on identical lists.
    expect(pageRe[1]).toBe(enginePatterns.join('|'));
  });

  it('suppressed work is never coloured as a fault', () => {
    // Nothing in this lane is wrong. Colouring it danger would train him to
    // ignore the one lane whose job is proving nothing is hidden.
    const src = page();
    const lane = src.slice(src.indexOf("lane:'Kept off your queue', items:"),
                           src.indexOf('// 4. Built/Live agents'));
    expect(lane).not.toContain("severity: 'danger'");
    expect(lane).toContain("'warn'");
  });

  it('a repeat of the same incident is escalated, not just repeated', () => {
    const src = page();
    expect(src).toMatch(/Three or more of the same thing means nobody has fixed it/);
  });
});
