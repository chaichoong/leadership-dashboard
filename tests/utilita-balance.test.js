// Guards for the Duckworth Utilita watcher (18 Sep 2026).
//
// The bugs these exist for, all found while building it rather than reasoned about:
//
//  1. OTHER CHARGES is a four-figure money line a few rows under the balance
//     (£1350.60 on Apartment 1, £957.92 on Apartment 2). A parser that took the
//     first £ on the page would have reported it as the credit on the meter, and
//     a meter apparently holding £1,350 never gets topped up.
//  2. The two flats CANNOT be told apart by address: Utilita shows Apartment 1's
//     with its flat number and Apartment 2's without one. The meter's top-up
//     number is the identity, and a mismatch must refuse to report rather than
//     pair a balance with the wrong flat.
//  3. A lapsed session must say SIGN-IN NEEDED. Reporting £0.00, or nothing at
//     all, reads as "all fine" on exactly the morning the meter is empty.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(root, 'scripts/utilita-balance.py');

describe('utilita-balance watcher', () => {
    it('offline selftest passes (parser, OTHER CHARGES trap, empty meter, lapsed session, low-balance flag)', () => {
        const out = execFileSync('python3', [script, 'selftest'], { encoding: 'utf8' });
        expect(out).toMatch(/selftest OK/);
    });

    it('a lapsed session reports SIGN-IN NEEDED and never a figure', () => {
        const py = `
import importlib.util
spec = importlib.util.spec_from_file_location('ub', ${JSON.stringify(script)})
ub = importlib.util.module_from_spec(spec); spec.loader.exec_module(ub)
msg, att = ub.build_message([{ 'label': 'Apartment 1', 'ok': False,
    'problem': 'SIGN-IN NEEDED', 'balance': None, 'balanceGbp': None, 'daysLeft': None }], 10)
print(msg)
print('ATTENTION=' + str(att))
`;
        const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
        expect(out).toMatch(/SIGN-IN NEEDED/);
        expect(out).toMatch(/Robot sign-in/);
        expect(out).not.toMatch(/£0\.00/);
        expect(out).toMatch(/ATTENTION=True/);
    });

    it('the meter gate itself refuses a different meter and stays quiet on a missing one', () => {
        // Drives meter_problem() directly. An earlier version of this test drove
        // only build_message, so disabling the gate outright left it green: the
        // guard existed and proved nothing. Back-tested by replacing the gate
        // with `if False:`, which now fails this test.
        const py = `
import importlib.util
spec = importlib.util.spec_from_file_location('ub', ${JSON.stringify(script)})
ub = importlib.util.module_from_spec(spec); spec.loader.exec_module(ub)
A, B = '9826003801209677811', '9826003801208182409'
print('DIFFERENT=' + str(ub.meter_problem(A, B)))
print('SAME=' + str(ub.meter_problem(A, A)))
print('MISSING=' + str(ub.meter_problem(A, None)))
print('UNPINNED=' + str(ub.meter_problem(None, B)))
row = ub.parse_energy(ub.SAMPLE_APT1)
print('PARSED=' + str(row['topUpNumber']))
`;
        const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
        expect(out).toMatch(/DIFFERENT=METER CHANGED[^\n]*2409/);
        expect(out).toMatch(/SAME=None/);
        expect(out).toMatch(/MISSING=None/);
        expect(out).toMatch(/UNPINNED=None/);
        expect(out).toMatch(/PARSED=9826003801209677811/);
    });

    it('read_account routes its meter check through that gate, not a private copy', () => {
        const src = readFileSync(script, 'utf8');
        const read = src.slice(src.indexOf('def read_account'), src.indexOf('def build_message'));
        expect(read).toMatch(/meter_problem\(/);
        expect(read).not.toMatch(/METER CHANGED/);
    });

    it('sends once a day, holds early, and never lets a bad morning pass in silence', () => {
        const py = `
import importlib.util
spec = importlib.util.spec_from_file_location('ub', ${JSON.stringify(script)})
ub = importlib.util.module_from_spec(spec); spec.loader.exec_module(ub)
print('FIRSTFULL=' + ub.send_decision(None, True, 6)[0])
print('DONE=' + ub.send_decision('full', True, 9)[0])
print('EARLYQUIET=' + ub.send_decision(None, False, 7)[0])
print('NINEBAD=' + ub.send_decision(None, False, 9)[0])
print('UPGRADE=' + ub.send_decision('degraded', True, 12)[0])
print('NOREPEAT=' + ub.send_decision('degraded', False, 12)[0])
`;
        const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
        expect(out).toMatch(/FIRSTFULL=send/);
        expect(out).toMatch(/DONE=hold/);
        expect(out).toMatch(/EARLYQUIET=hold/);
        expect(out).toMatch(/NINEBAD=send/);     // the bug this exists for: silence
        expect(out).toMatch(/UPGRADE=send/);
        expect(out).toMatch(/NOREPEAT=hold/);
    });

    it('the daily mark is written by rename, never truncate-then-write', () => {
        // scripts/job-queue.py lost a run to exactly this on 2 Sep 2026: a reader
        // caught a lock file in the instant between truncate and write.
        const src = readFileSync(script, 'utf8');
        expect(src).toMatch(/os\.replace\(tmp, SENT_MARK\)/);
    });

    it('the relay call carries a User-Agent, or Cloudflare answers 403 error 1010', () => {
        // Measured 18 Sep 2026: Python's default "Python-urllib/3.x" is refused by
        // Cloudflare's browser integrity check before the worker is ever reached,
        // so the morning message would fail with nothing in the worker's logs.
        const src = readFileSync(script, 'utf8');
        const send = src.slice(src.indexOf('def send_slack'), src.indexOf('def log_readings'));
        expect(send).toMatch(/add_header\(\s*["']User-Agent["']/);
    });

    it('the watcher never types a password and never names one', () => {
        const src = readFileSync(script, 'utf8');
        // It drives agent-browser.js `read` only. `fill`, `login` and `commit` all
        // belong to paths that touch inputs; a watcher has no business near them.
        expect(src).not.toMatch(/"fill"|'fill'/);
        expect(src).not.toMatch(/password\s*=|--password/);
        expect(src).toMatch(/"read",\s*$|"read",/m);
    });

    it('Utilita is kept out of session-keepalive, which would test the wrong profile', () => {
        // session-keepalive.py never passes --profile, so it checks `default`.
        // Utilita's sessions live on utilita-apt1 / utilita-apt2, so a loginUrl on
        // the allowlist entry would raise a false SIGN-IN NEEDED task every morning.
        const keepalive = readFileSync(resolve(root, 'scripts/session-keepalive.py'), 'utf8');
        expect(keepalive).toMatch(/loginUrl/);
        expect(keepalive).not.toMatch(/--profile/);
    });
});
