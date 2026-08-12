import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// Tier-2 parking — scripts/agent-dispatch.py TIER2_PATTERNS + TIER2_OUTBOUND_PATTERNS.
//
// The bug (finding 20260810-agent-dispatch-061): tier 2 matched on SUBJECT alone.
// Tier 2 exists because writing to a creditor is Mica's lane, never an agent's.
// But an Urgent, read-only tier-1 task — "verify the current position on the
// statutory demand" — carries the same subject words, so it was parked. A parked
// task is worked by nobody: the dispatcher skips it and, before this fix, the
// skippedTier2 list raised no alarm. It stranded silently, run after run.
//
// The rule now: park only when a tier-2 SUBJECT is joined by an OUTBOUND INTENT.
// The lane is defined by the action, not the topic.
//
// The second half (finding 20260812-agent-dispatch-111, 12 Aug 2026): the intent
// gate shipped as a BARE WORD match, so a PROHIBITION read as an intent. Task
// recSvXxaEz57i7YQK — "Verify the 5 obligations behind the closed POST letters",
// Urgent, due that day — was parked again, and the outbound match came from its
// own description: "Do NOT contact anyone. Read-only evidence only." The words
// forbidding the action are what triggered the park. Because cmd_queue `continue`s
// on a park, the task never reached newWork either, so counts.newWork read 0 while
// an agent-linked, no-outcome, Urgent task sat open.
//
// The real compiled regexes are exercised through the actual Python
// `outbound_intent()` — the function cmd_queue calls, not a look-alike. Python and
// JS regex dialects differ, and a test that re-implements the patterns in JS
// quietly stops guarding the code it names.

function classify(cases) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
cases = json.loads(sys.argv[1])
out = {}
for c in cases:
    subject = m.tier_match(m.TIER2_PATTERNS, c, '', '')
    outbound = m.outbound_intent(c, '', '') if subject else ''
    out[c] = {'subject': subject, 'outbound': outbound, 'parked': bool(subject and outbound)}
print(json.dumps(out))
`;
  return JSON.parse(execFileSync('python3', ['-c', script, JSON.stringify(cases)], { encoding: 'utf8' }));
}

// Read-only work on a tier-2 subject. None of these may be parked.
const READ_ONLY = [
  'Verify the current position on the statutory demand',
  'Check the letter of claim against the restraint order and report back',
  'Read the bounce back loan paperwork and summarise the balance',
  'Audit what we hold on file for the statutory demand',
  'Confirm the deadline stated in the letter of claim',
];

// Outbound work on the same subjects. All of these must stay parked.
const OUTBOUND = [
  'Reply to the statutory demand',
  'Draft a letter in response to the letter of claim',
  'Respond to the bounce back loan default notice',
  'Call the creditor about the statutory demand',
  'Negotiate a settlement on the letter of claim',
  'Chase the bounce back loan lender for a payment plan',
];

// A FORBIDDEN outbound action on a tier-2 subject. None of these may be parked:
// being told not to write is a read, and a read is not Mica's lane.
const NEGATED = [
  // The exact task that stranded, name and description as they really read.
  'Verify the 5 obligations behind the closed POST letters. Do NOT contact anyone. '
    + 'Read-only evidence only. One is a letter of claim.',
  'Review the statutory demand file. Do not reply to anyone.',
  "Pull together what we hold on the letter of claim — don't respond yet.",
  'Summarise the bounce back loan position. No action, report back only.',
  'Check the letter of claim deadline. Never contact the creditor directly.',
];

// No tier-2 subject at all. Outbound wording alone must never park anything.
const NOT_TIER2 = [
  'Reply to the tenant about the boiler',
  'Send the weekly update to Mica',
  'Call the accountant about the year end',
];

describe('agent-dispatch tier-2 parking', () => {
  it('never parks read-only work, whatever the subject', () => {
    const res = classify(READ_ONLY);
    for (const name of READ_ONLY) {
      expect(res[name].parked, `parked read-only task: ${name}`).toBe(false);
    }
  });

  it('still parks outbound creditor correspondence', () => {
    const res = classify(OUTBOUND);
    for (const name of OUTBOUND) {
      expect(res[name].subject, `no tier-2 subject matched: ${name}`).not.toBe('');
      expect(res[name].parked, `failed to park outbound task: ${name}`).toBe(true);
    }
  });

  it('never parks a FORBIDDEN outbound action (111)', () => {
    const res = classify(NEGATED);
    for (const name of NEGATED) {
      // The subject still matches — that is correct, and is why these reached
      // the intent gate at all. Only the intent decision changed.
      expect(res[name].subject, `lost the tier-2 subject: ${name}`).not.toBe('');
      expect(res[name].parked,
        `parked a task that forbids the outbound action: ${name}`).toBe(false);
    }
  });

  it('a prohibition and a real instruction in one task still parks', () => {
    // The negation strips the clause it belongs to, never the whole text: a
    // task that says "do not phone" but "write to them" is still Mica's.
    const s = 'Do not phone the creditor, but write to them about the letter of claim';
    const res = classify([s]);
    expect(res[s].parked, 'a real outbound instruction stopped parking').toBe(true);
  });

  it('outbound wording alone parks nothing', () => {
    const res = classify(NOT_TIER2);
    for (const name of NOT_TIER2) {
      expect(res[name].parked, `parked a non-tier-2 task: ${name}`).toBe(false);
    }
  });

  it('a tier-2 park raises an alarm rather than sitting in the report', () => {
    // The park itself is fine. A park nobody is told about is the defect: the
    // task is worked by no one, and the only record was a JSON key.
    const src = execFileSync('cat', [DISPATCH], { encoding: 'utf8' });
    const alarmBlock = src.slice(src.indexOf('parkedFlags'));
    expect(alarmBlock).toContain('skippedTier2');
  });

  it('a park is counted, so it cannot hide the emptiness it causes (111)', () => {
    // cmd_queue `continue`s on a park, so the task drops out of newWork too.
    // Without a count, counts.newWork reads 0 and looks like a quiet morning.
    const src = execFileSync('cat', [DISPATCH], { encoding: 'utf8' });
    const counts = src.slice(src.indexOf('"counts": {'), src.indexOf('print(json.dumps(out, indent=2))'));
    expect(counts, 'tier-2 parks are not in the counts object').toContain('tier2Parked');
  });
});
