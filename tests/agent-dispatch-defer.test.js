import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// Delayed hand-backs — scripts/agent-dispatch.py is_delay_feedback / DELAY_PATTERNS.
//
// The bug (found 7 Aug 2026 by the agent-dispatch routine): a "Changes requested"
// hand-back sorts to the HEAD of the worklist, ahead of new work, because a
// hand-back is what Kevin is waiting on. But when his feedback was "leave this
// until next month", there was no deferred state anywhere, so it came back to the
// front on EVERY run — burning one of the five cap slots twice a day and pushing
// real work past the cap. The agent redid it, he asked for the delay again, and
// it repeated indefinitely. Nothing errored; the queue just never moved on.
//
// The real fix is a Deferred Until date on Tasks (schema change, filed separately).
// This is the interim: demote to the back of the combined list so it falls into
// reserve whenever there is other work. Demoted, never dropped.
//
// Tested through the real Python rather than a JS re-implementation, so the
// regexes this asserts on are the ones that actually run.

function py(expr) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(json.dumps(${expr}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

// Real shapes of "not yet" feedback.
const DELAY = [
  'Leave this until next month please',
  'Delay this one, not a priority',
  'Park it for now',
  'Hold off until I have spoken to the accountant',
  'Not yet — wait until the quarter closes',
  'Put this on hold',
  'Revisit after launch',
  'Come back to this in a few weeks',
  'Defer — too early',
  'Postpone until September',
];

// Genuine change requests. These MUST keep their hand-back priority: demoting a
// real redo would be a worse bug than the one being fixed, because Kevin is
// actively waiting on it.
const REAL_CHANGES = [
  'Rewrite the second paragraph, too formal',
  'Wrong figure — should be £3,229.27',
  'Add the property address to the subject line',
  'Take out the apology, just state the facts',
  'Use the restraint-order-first script for this one',
  'Shorten it and send from the Gmail account',
];

describe('agent-dispatch delayed hand-backs', () => {
  const out = py(`{
    'delay': {t: m.is_delay_feedback(t) for t in ${JSON.stringify(DELAY)}},
    'changes': {t: m.is_delay_feedback(t) for t in ${JSON.stringify(REAL_CHANGES)}},
    'blank': m.is_delay_feedback(''),
    'none': m.is_delay_feedback(None),
    'patterns': len(m.DELAY_PATTERNS),
  }`);

  it('loads the real patterns (control — guards against a vacuous pass)', () => {
    expect(out.patterns).toBeGreaterThanOrEqual(10);
  });

  it('recognises every shape of "not yet"', () => {
    const missed = DELAY.filter((t) => !out.delay[t]);
    expect(missed, 'these delay requests would keep jumping the queue').toEqual([]);
  });

  it('leaves genuine change requests at hand-back priority', () => {
    const wrong = REAL_CHANGES.filter((t) => out.changes[t]);
    expect(wrong, 'these are real redos Kevin is waiting on — must NOT be demoted').toEqual([]);
  });

  it('treats empty and missing feedback as not-a-delay', () => {
    expect(out.blank).toBe(false);
    expect(out.none).toBe(false);
  });
});
