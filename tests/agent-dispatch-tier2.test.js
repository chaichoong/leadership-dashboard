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
// The real compiled regexes are exercised through the actual Python
// `tier_match()`. Python and JS regex dialects differ, and a test that
// re-implements the patterns in JS quietly stops guarding the code it names.

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
    outbound = m.tier_match(m.TIER2_OUTBOUND_PATTERNS, c, '', '') if subject else ''
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
});
