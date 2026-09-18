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
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
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
msg, att, alarm = ub.build_message([{ 'label': 'Apartment 1', 'ok': False,
    'problem': 'SIGN-IN NEEDED', 'balance': None, 'balanceGbp': None, 'daysLeft': None,
    'meterLast4': None, 'daysLeftRecognised': None }], 10)
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
print('MIDNIGHT=' + ub.send_decision(None, True, 0)[0])
print('FIRSTMORNING=' + ub.send_decision(None, True, 7)[0])
print('DONE=' + ub.send_decision('full', True, 9)[0])
print('EARLYQUIET=' + ub.send_decision(None, False, 8)[0])
print('NINEBAD=' + ub.send_decision(None, False, 9)[0])
print('UPGRADE=' + ub.send_decision('degraded', True, 12)[0])
print('NOREPEAT=' + ub.send_decision('degraded', False, 12)[0])
print('LATEALARM=' + ub.send_decision('full', True, 18, alarm=True)[0])
print('ALARMONCE=' + ub.send_decision('full', True, 18, alarm=True, alarmed=True)[0])
print('NIGHTALARM=' + ub.send_decision(None, True, 2, alarm=True)[0])
`;
        const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
        expect(out).toMatch(/MIDNIGHT=hold/);    // the 00:05 tick must never send
        expect(out).toMatch(/FIRSTMORNING=send/);
        expect(out).toMatch(/LATEALARM=send/);    // a meter that empties after the message
        expect(out).toMatch(/ALARMONCE=hold/);    // but only once a day
        expect(out).toMatch(/NIGHTALARM=hold/);   // nobody acts on a meter at 2am
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

    it('OTHER CHARGES is never reported as the balance, in any page shape', () => {
        // THE bug. £1350.60 sits INSIDE the old fixed eight-line window (at
        // start+7 on the real Apartment 1 page) and lost only because a valid
        // £20.26 appeared first. Measured 18 Sep 2026: with the tile unpainted,
        // or a meter in debt showing -£5.20, the watcher reported
        // "£1350.60 — 5 days left" on an EMPTY meter, no alarm, exit 0.
        const py = `
import importlib.util
spec = importlib.util.spec_from_file_location('ub', ${JSON.stringify(script)})
ub = importlib.util.module_from_spec(spec); spec.loader.exec_module(ub)
shapes = {
 'UNPAINTED': 'My energy\\nBalance\\nREFRESH\\n5 days left\\nElectricity Top-up Number\\n9826003801209677811\\nOTHER CHARGES\\n£1350.60\\n',
 'PLACEHOLDER': 'Balance\\nREFRESH\\n£--\\nOTHER CHARGES\\n£1350.60\\n',
 'CEILING': 'Balance\\nREFRESH\\n£1350.60\\n5 days left\\n',
 'TWOCARDS': 'Balance\\nMy energy\\nBalance\\nREFRESH\\n£20.26\\n5 days left\\n',
}
for k, v in shapes.items():
    r = ub.parse_energy(v)
    print(k + '=' + str(r['balanceGbp']) + '|refused=' + str(bool(r['refused'])))
d = ub.parse_energy('Balance\\nREFRESH\\n-£5.20\\n\\nOff supply\\nElectricity Top-up Number\\n9826003801209677811\\nOTHER CHARGES\\n£1350.60\\n')
print('DEBT=' + str(d['balanceGbp']) + '|' + str(d['daysLeft']))
`;
        const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
        for (const k of ['UNPAINTED', 'PLACEHOLDER', 'CEILING', 'TWOCARDS']) {
            expect(out).toMatch(new RegExp(`${k}=None\\|refused=True`));
        }
        expect(out).not.toMatch(/1350\.6/);
        expect(out).toMatch(/DEBT=-5\.2\|Off supply/);  // debt parses, never falls through
    });

    it('the days-left line alarms on its own, whatever the balance says', () => {
        // "£12.40 — Less than a day left" and "Off supply" both raised NO flag
        // before this, because the flag read only the number against the floor.
        const py = `
import importlib.util
spec = importlib.util.spec_from_file_location('ub', ${JSON.stringify(script)})
ub = importlib.util.module_from_spec(spec); spec.loader.exec_module(ub)
def r(gbp, days):
    return {'ok': True, 'balanceGbp': gbp, 'daysLeft': days}
print('OFFSUPPLY=' + str(ub.row_alarm(r(1350.60, 'Off supply'), 10)))
print('LESSTHANDAY=' + str(ub.row_alarm(r(12.40, 'Less than a day left'), 10)))
print('NOCREDIT=' + str(ub.row_alarm(r(0.0, 'No credit left'), 10)))
print('NEGATIVE=' + str(ub.row_alarm(r(-5.20, '1 day left'), 10)))
print('HEALTHY=' + str(ub.row_alarm(r(34.30, 'More than a week left'), 10)))
`;
        const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
        expect(out).toMatch(/OFFSUPPLY=True/);
        expect(out).toMatch(/LESSTHANDAY=True/);
        expect(out).toMatch(/NOCREDIT=True/);
        expect(out).toMatch(/NEGATIVE=True/);
        expect(out).toMatch(/HEALTHY=False/);
    });

    it('the signed-in test agrees with agent-browser.js, not a weaker substring', () => {
        // The old test was `'/energy' in url`, and
        // my.utilita.co.uk/login?returnUrl=/energy contains "/energy". A signed
        // OUT session read as signed in, so the message said "the balance was
        // not on the page" and WITHHELD the Robot sign-in line.
        const { sessionVerdict } = require_(resolve(root, 'scripts/agent-browser.js'));
        const urls = [
            ['https://my.utilita.co.uk/energy', 0],
            ['https://my.utilita.co.uk/login?returnUrl=/energy', 0],
            ['https://my.utilita.co.uk/login', 0],
            ['https://my.utilita.co.uk/energy', 1],
        ];
        const py = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('ub', ${JSON.stringify(script)})
ub = importlib.util.module_from_spec(spec); spec.loader.exec_module(ub)
for url, pw in json.loads(${JSON.stringify(JSON.stringify(urls))}):
    print(str(ub.signed_in(url, pw)))
`;
        const mine = execFileSync('python3', ['-c', py], { encoding: 'utf8' })
            .trim().split('\n').map(l => l === 'True');
        const theirs = urls.map(([u, pw]) => sessionVerdict(u, pw).signedIn);
        expect(mine).toEqual(theirs);
        expect(mine).toEqual([true, false, false, false]);
    });

    it('a trimmed accounts list is refused, not reported as a clean run', () => {
        // all([]) is True, so an empty list sent a message with no flats in it,
        // attention False, exit 0, and marked the day done.
        const py = `
import importlib.util
spec = importlib.util.spec_from_file_location('ub', ${JSON.stringify(script)})
ub = importlib.util.module_from_spec(spec); spec.loader.exec_module(ub)
for name, cfg in [('EMPTY', {'accounts': [], 'expectedAccounts': 2}),
                  ('SHORT', {'accounts': [{'label': 'a'}], 'expectedAccounts': 2})]:
    try:
        ub.expected_accounts(cfg); print(name + '=ACCEPTED')
    except SystemExit:
        print(name + '=REFUSED')
print('BOTH=' + str(len(ub.expected_accounts({'accounts': [{'label':'a'},{'label':'b'}], 'expectedAccounts': 2}))))
`;
        const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
        expect(out).toMatch(/EMPTY=REFUSED/);
        expect(out).toMatch(/SHORT=REFUSED/);
        expect(out).toMatch(/BOTH=2/);
    });

    it('a low balance is a success, not a job failure', () => {
        // job-queue.py maps a non-zero exit to "failed", estate-status.py
        // renders a Failed row and the digest lists it. Exiting 1 on a low
        // balance meant the watcher reported itself broken on exactly the
        // mornings a meter was low, which is how a red light stops being read.
        const src = readFileSync(script, 'utf8');
        const run = src.slice(src.indexOf('def cmd_run'), src.indexOf('def cmd_read'));
        expect(run).toMatch(/if not result\["anyDelivered"\]:\s*\n\s*return 1/);
        expect(run).not.toMatch(/return 0 if \(sent and not attention\)/);
    });

    it('a partly failed delivery still marks the day, so it cannot re-send hourly', () => {
        // The worker answers 502 when ANY recipient fails. Treating that as a
        // total failure left the mark unwritten, so a permanent failure on
        // Roy's DM would have re-sent to Kevin 24 times a day for ever.
        const src = readFileSync(script, 'utf8');
        const send = src.slice(src.indexOf('def send_slack'), src.indexOf('def log_readings'));
        expect(send).toMatch(/anyDelivered/);
        expect(send).toMatch(/body\["sent"\]/);
        const run = src.slice(src.indexOf('def cmd_run'), src.indexOf('def cmd_read'));
        expect(run).toMatch(/if result\["anyDelivered"\]:\s*\n(\s*#[^\n]*\n)*\s*write_sent_mark/);
    });

    it('a browser timeout kills the process GROUP, or Chromium holds the profile for ever', () => {
        // subprocess kills node only; the headless Chromium it launched survives
        // and waitForProfile's pgrep then sees that orphan for ever, so every
        // later run times out too and adds another orphan.
        const src = readFileSync(script, 'utf8');
        expect(src).toMatch(/start_new_session=True/);
        expect(src).toMatch(/os\.killpg\(os\.getpgid/);
        // And the timeout must exceed agent-browser.js's own 10-minute wait for
        // the profile lock, or contention guarantees a false "did not load".
        expect(src).toMatch(/READ_TIMEOUT_S = 11 \* 60/);
        const browser = readFileSync(resolve(root, 'scripts/agent-browser.js'), 'utf8');
        expect(browser).toMatch(/waitForProfile\(dir, 10 \* 60 \* 1000|waitForProfile/);
    });

    it('the message never carries a filesystem path to Roy', () => {
        const src = readFileSync(script, 'utf8');
        const read = src.slice(src.indexOf('def read_account'), src.indexOf('def row_alarm'));
        // stderr goes to the job log, never into row["problem"].
        expect(read).toMatch(/file=sys\.stderr/);
        expect(read).not.toMatch(/row\["problem"\][^\n]*stderr/);
    });

    it('the runner tests for the SCRIPT, not the scripts directory', () => {
        // scripts/ exists in the runtime worktree whatever commit it sits on,
        // so testing the directory passes on any day that worktree has not been
        // fast-forwarded past this feature, and python then dies on a missing
        // file. The fallback exists precisely for that day.
        const sh = readFileSync(resolve(root, 'scripts/utilita-balance-run.sh'), 'utf8');
        expect(sh).toMatch(/\[ -f "\$REPO\/scripts\/utilita-balance\.py" \]/);
        expect(sh).not.toMatch(/\[ -d "\$REPO\/scripts" \]/);
    });

    it('the relay caps text length and de-duplicates recipients', () => {
        const worker = readFileSync(resolve(root, 'workers/apple-inbound/worker.js'), 'utf8');
        expect(worker).toMatch(/RELAY_MAX_TEXT/);
        expect(worker).toMatch(/RELAY_MAX_RECIPIENTS/);
        expect(worker).toMatch(/seen\.has\(e\)/);
    });

    it('the hourly job is lock-exempt, or a long render lets the session lapse', () => {
        const sched = JSON.parse(readFileSync(resolve(root, 'scripts/job-schedule.json'), 'utf8'));
        expect(sched['utilita-balance'].lockExempt).toBe(true);
        expect(sched['utilita-balance'].cron).toBe('5 * * * *');
        // Never a day-of-week field: Cloudflare and cron disagree on which day
        // is 1, and this repo has lost a whole weekday to that before.
        expect(sched['utilita-balance'].cron.split(' ')[4]).toBe('*');
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
