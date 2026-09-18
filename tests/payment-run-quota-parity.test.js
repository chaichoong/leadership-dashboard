// scripts/payment-run.py and scripts/inbound-triage.py each classify a non-200
// from the Gmail worker. They MUST agree.
//
// Why a test rather than a shared module: inbound-triage.py is live, runs three
// times a day, and this build was not allowed to touch it. So the classifier
// was copied — and a copied classifier is a classifier that drifts. The failure
// is silent and expensive in both directions: read a per-minute rate metric as
// a hard error and a weekly run throws away the week; read a per-day quota as
// retryable and the run burns every remaining call.
//
// If this test fails, the two copies have diverged. Fix the copy, or extract a
// shared module and point both at it.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The real 403 body Google returned on 18 Sep 2026, re-wrapped by the worker as
// a 500. Read as a plain 500 it retries in two seconds, four times, and dies.
const MINUTE_METRIC = JSON.stringify({
  error: "Gmail list failed: {\"error\": {\"code\": 403, \"message\": \"Quota exceeded for " +
         "quota metric 'Total Query Cost' and limit 'Units per minute per user' of service " +
         "'gmail.googleapis.com' for consumer 'project_number:815949125083'.\"}}",
});

const CASES = [
  [500, MINUTE_METRIC],
  [403, "Quota exceeded for quota metric 'Queries per day'"],
  [403, 'dailyLimitExceeded'],
  [500, 'quotaExceeded'],
  [503, 'service unavailable'],
  [500, 'backendError'],
  [429, 'userRateLimitExceeded'],
  [409, 'Gmail not connected for kevin@runpreneur.org.uk'],
  [401, 'Forbidden'],
  [418, 'something nobody has seen before'],
];

function classify(script, cases) {
  const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(join(ROOT, 'scripts', script))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.classify_worker_error(c, b)[0] for c, b in json.loads(sys.argv[1])]))
`;
  return JSON.parse(execFileSync('python3', ['-c', py, JSON.stringify(cases)], { encoding: 'utf8' }));
}

describe('Gmail quota classification', () => {
  const verdicts = classify('payment-run.py', CASES);

  it('reads a per-minute metric wrapped in a 500 as a slowdown, not a failure', () => {
    expect(verdicts[0]).toBe('slowdown');
  });

  it('reads a per-day quota as the day being gone', () => {
    expect(verdicts[1]).toBe('quota');
    expect(verdicts[2]).toBe('quota');
  });

  it('waits rather than quitting when the metric window is not named', () => {
    expect(verdicts[3]).toBe('slowdown');
  });

  it('retries ordinary transient errors and stops on auth ones', () => {
    expect(verdicts.slice(4, 7)).toEqual(['retry', 'retry', 'retry']);
    expect(verdicts[7]).toBe('stop');
    expect(verdicts[8]).toBe('stop');
    expect(verdicts[9]).toBe('stop');
  });

  it('agrees with the live inbound-triage classifier on every case', () => {
    expect(verdicts).toEqual(classify('inbound-triage.py', CASES));
  });
});
