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
 'TWOCARDS': 'Balance\\nMy energy\\nBalance\\nREFRESH\\n£20.26\\n5 days left\\n',
 'FARDOWN': 'Balance\\nREFRESH\\na\\nb\\nc\\nd\\n£1350.60\\n',
 'TWOAMOUNTS': 'Balance\\nREFRESH\\n£5.00\\n£1350.60\\n5 days left\\n',
 'DECIMALCOMMA': 'Balance\\nREFRESH\\n£2,50\\n1 day left\\n',
 'STRAYAMOUNT': 'Balance\\nREFRESH\\n50p\\nTop up\\n£20\\n5 days left\\n',
}
for k, v in shapes.items():
    r = ub.parse_energy(v)
    print(k + '=' + str(r['balanceGbp']) + '|refused=' + str(bool(r['refused'])))
d = ub.parse_energy('Balance\\nREFRESH\\n-£5.20\\n\\nOff supply\\nElectricity Top-up Number\\n9826003801209677811\\nOTHER CHARGES\\n£1350.60\\n')
print('DEBT=' + str(d['balanceGbp']) + '|' + str(d['daysLeft']))
`;
        const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
        for (const k of ['UNPAINTED', 'PLACEHOLDER', 'TWOCARDS', 'FARDOWN',
                         'TWOAMOUNTS', 'DECIMALCOMMA', 'STRAYAMOUNT']) {
            expect(out).toMatch(new RegExp(`${k}=None\\|refused=True`));
        }
        expect(out).not.toMatch(/=1350\.6/);           // never REPORTED as the balance
        expect(out).not.toMatch(/=250\.0/);             // "£2,50" is not £250
        expect(out).not.toMatch(/=20\.0\|/);            // the top-up button is not the balance
        expect(out).toMatch(/DEBT=-5\.2\|Off supply/);  // debt parses, never falls through
    });

    it('days left is the primary trigger, with pounds as the backstop (driven)', () => {
        // Kevin, 18 Sep 2026: £20 lasts about five days, so a £10 pounds floor
        // gave barely two and a half days' notice — too tight for a flat with
        // paying guests. Utilita recomputes days from real consumption, so the
        // warning now tightens by itself when a flat fills up.
        const py = `
import importlib.util
spec = importlib.util.spec_from_file_location('ub', ${JSON.stringify(script)})
ub = importlib.util.module_from_spec(spec); spec.loader.exec_module(ub)
def r(gbp, days):
    return {'ok': True, 'balanceGbp': gbp, 'daysLeft': days}
print('FIVE=' + str(ub.row_alarm(r(20.12, '5 days left'), 10)))
print('FOUR=' + str(ub.row_alarm(r(16.00, '4 days left'), 10)))
print('THREE=' + str(ub.row_alarm(r(12.00, '3 days left'), 10)))
print('ONE=' + str(ub.row_alarm(r(4.00, '1 day left'), 10)))
print('WEEK=' + str(ub.row_alarm(r(34.30, 'More than a week left'), 10)))
# The case the pounds-only rule got wrong: healthy pounds, few days.
print('RICHBUTSHORT=' + str(ub.row_alarm(r(25.00, '3 days left'), 10)))
# The floor still stands alone when the page shows no days line.
print('NODAYSLOW=' + str(ub.row_alarm(r(4.10, None), 10)))
print('NODAYSFINE=' + str(ub.row_alarm(r(34.30, None), 10)))
# Configurable, not a buried constant.
print('TIGHTER=' + str(ub.row_alarm(r(12.00, '3 days left'), 10, alarm_days=2)))
print('LOOSER=' + str(ub.row_alarm(r(20.00, '5 days left'), 10, alarm_days=5)))
print('THRESHOLD=' + str(ub.ALARM_DAYS_LEFT))
`;
        const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
        expect(out).toMatch(/FIVE=False/);
        expect(out).toMatch(/FOUR=False/);
        expect(out).toMatch(/THREE=True/);
        expect(out).toMatch(/ONE=True/);
        expect(out).toMatch(/WEEK=False/);
        expect(out).toMatch(/RICHBUTSHORT=True/);   // the pounds-only rule missed this
        expect(out).toMatch(/NODAYSLOW=True/);
        expect(out).toMatch(/NODAYSFINE=False/);
        expect(out).toMatch(/TIGHTER=False/);
        expect(out).toMatch(/LOOSER=True/);
        expect(out).toMatch(/THRESHOLD=3/);
    });

    it('the configured threshold reaches the live run, not just the default', () => {
        // A threshold nobody can change is a constant pretending to be config.
        const src = readFileSync(script, 'utf8');
        const run = src.slice(src.indexOf('def cmd_run'), src.indexOf('def cmd_read'));
        expect(run).toMatch(/cfg\.get\("alarmDaysLeft"/);
        expect(run).toMatch(/alarm_days=alarm_days|alarming_labels\(rows, low, alarm_days\)/);
        const live = JSON.parse(readFileSync(
            resolve(process.env.HOME, '.config/od/utilita_accounts.json'), 'utf8'));
        expect(live.alarmDaysLeft, 'the live config must set it explicitly').toBe(3);
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

    it('send_slack returns the SAME shape on every branch, including a missing key', () => {
        // The round-1 refactor left one branch returning a 2-tuple while every
        // caller indexes the result by name, so a rotated or renamed key file
        // produced "TypeError: tuple indices must be integers" and no message.
        // The day-simulation test stubs send_slack, so only this drives the real
        // one. Back-tested: restoring the tuple fails here.
        const py = `
import importlib.util
spec = importlib.util.spec_from_file_location('ub', ${JSON.stringify(script)})
ub = importlib.util.module_from_spec(spec); spec.loader.exec_module(ub)
ub.RELAY_KEY_PATH = '/nonexistent/slack_relay_key'
r = ub.send_slack('hi', ['kevin@runpreneur.org.uk'])
print('TYPE=' + type(r).__name__)
try:
    # Exactly what cmd_run does with it.
    print('DELIVERED=' + str(r['anyDelivered']))
    print('FAILEDKEY=' + str(bool(r.get('failed') is not None)))
    print('CALLER=OK')
except TypeError as e:
    print('CALLER=CRASH ' + str(e))
`;
        const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
        expect(out).toMatch(/TYPE=dict/);
        // And the worker's own reason survives rather than becoming
        // "unreadable reply", which is all a recipient typo used to log.
        const relaySrc = readFileSync(script, 'utf8');
        const send = relaySrc.slice(relaySrc.indexOf('def send_slack'),
                                    relaySrc.indexOf('def log_readings'));
        expect(send).toMatch(/\.get\("error"\)/);
        expect(out).toMatch(/DELIVERED=False/);
        expect(out).toMatch(/CALLER=OK/);
        expect(out).not.toMatch(/CRASH/);
    });

    it('cmd_run across a simulated day: exit codes, the daily mark, per-flat alarms', () => {
        // The two tests this replaces read cmd_run's SOURCE, and both would have
        // stayed green with their bug reinstated. Nothing executed cmd_run at
        // all, so the wiring of expected_accounts, the mark and send_decision
        // into the job was unproven. This drives the real function with stubbed
        // reads and sends against a temporary state directory.
        const py = `
import importlib.util, json, os, tempfile, datetime
spec = importlib.util.spec_from_file_location('ub', ${JSON.stringify(script)})
ub = importlib.util.module_from_spec(spec); spec.loader.exec_module(ub)

d = tempfile.mkdtemp()
ub.STATE_DIR = d
ub.SENT_MARK = os.path.join(d, 'sent.json')
ub.LEDGER = os.path.join(d, 'readings.jsonl')
cfgp = os.path.join(d, 'cfg.json')
json.dump({'accounts': [{'label': 'Apartment 1', 'profile': 'p1'},
                        {'label': 'Apartment 2', 'profile': 'p2'}],
           'expectedAccounts': 2, 'lowBalanceGbp': 10,
           'recipients': ['kevin@runpreneur.org.uk']}, open(cfgp, 'w'))
ub.CONFIG = cfgp

SENT = []
ub.send_slack = lambda text, rec: (SENT.append(text) or
    {'anyDelivered': True, 'delivered': rec, 'failed': [], 'refused': []})

STATE = {}
ub.read_account = lambda acct, node=None: dict(
    STATE[acct['label']], label=acct['label'], profile=acct['profile'])

def ok(bal, days):
    return {'ok': True, 'balance': '\u00a3%.2f' % bal, 'balanceGbp': bal,
            'daysLeft': days, 'daysLeftRecognised': True, 'meterLast4': '7811',
            'problem': None, 'signedIn': True, 'implausible': False}
def down():
    return {'ok': False, 'balance': None, 'balanceGbp': None, 'daysLeft': None,
            'daysLeftRecognised': None, 'meterLast4': None,
            'problem': 'SIGN-IN NEEDED', 'signedIn': False, 'implausible': False}

class Clock(datetime.datetime):
    H = 7
    @classmethod
    def now(cls, tz=None):
        return datetime.datetime(2026, 9, 21, cls.H, 5, 0)
ub.datetime = Clock

def tick(hour, a1, a2, label):
    Clock.H = hour
    STATE['Apartment 1'], STATE['Apartment 2'] = a1, a2
    before = len(SENT)
    code = ub.cmd_run([])
    print(label + '=' + ('SENT' if len(SENT) > before else 'quiet') + ',exit' + str(code))

healthy1, healthy2 = ok(20.0, '5 days left'), ok(34.0, 'More than a week left')
tick(6,  healthy1, healthy2, 'EARLY')
tick(7,  healthy1, healthy2, 'MORNING')
tick(8,  healthy1, healthy2, 'AGAIN')
tick(10, ok(0.5, 'Less than a day left'), healthy2, 'ALARM1')
tick(11, ok(0.5, 'Less than a day left'), healthy2, 'NOREPEAT')
tick(15, ok(0.5, 'Less than a day left'), ok(5.0, 'Off supply'), 'ALARM2')
tick(17, healthy1, down(), 'LOSTSIGHT')
tick(18, healthy1, down(), 'LOSTAGAIN')

mark = json.load(open(ub.SENT_MARK))
print('MARKED=' + ','.join(mark['alarmedLabels']))
print('LOST=' + ','.join(mark['lostLabels']))

json.dump({'accounts': [], 'expectedAccounts': 2, 'recipients': []}, open(cfgp, 'w'))
try:
    ub.cmd_run([]); print('TRIMMED=ACCEPTED')
except SystemExit:
    print('TRIMMED=REFUSED')
`;
        const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
        expect(out).toMatch(/EARLY=quiet,exit0/);        // never a dawn message
        expect(out).toMatch(/MORNING=SENT,exit0/);       // a healthy send is a SUCCESS, not a failure
        expect(out).toMatch(/AGAIN=quiet,exit0/);
        expect(out).toMatch(/ALARM1=SENT,exit0/);        // a low balance is the job working
        expect(out).toMatch(/NOREPEAT=quiet,exit0/);     // and it does not nag hourly
        expect(out).toMatch(/ALARM2=SENT,exit0/);        // the SECOND flat is not silenced
        expect(out).toMatch(/LOSTSIGHT=SENT,exit1/);     // a dead session is a fault, and reported
        expect(out).toMatch(/LOSTAGAIN=quiet,exit1/);    // held, yet still failing
        expect(out).toMatch(/MARKED=Apartment 1,Apartment 2/);
        expect(out).toMatch(/LOST=Apartment 2/);
        expect(out).toMatch(/TRIMMED=REFUSED/);
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
        // The old assertion was an alternation ending in a bare /waitForProfile/,
        // which always matched: raising agent-browser's own lock wait to 20
        // minutes would have made READ_TIMEOUT_S too short again and stayed green.
        // Read the real number out of agent-browser.js and compare.
        const browser = readFileSync(resolve(root, 'scripts/agent-browser.js'), 'utf8');
        const m = browser.match(/waitForProfile\(dir,\s*(\d+)\s*\*\s*60\s*\*\s*1000/);
        expect(m, 'agent-browser.js must still declare its profile wait in minutes').toBeTruthy();
        const waitMinutes = Number(m[1]);
        const ours = Number(readFileSync(script, 'utf8')
            .match(/READ_TIMEOUT_S = (\d+) \* 60/)[1]);
        expect(ours).toBeGreaterThan(waitMinutes);
    });

    it('a browser failure reports no filesystem path to Roy (driven)', () => {
        // The grep version hunted the literal "stderr", so
        // row["problem"] = f"...: {err}" would leak the profile path and pass.
        // This runs read_account against a fake node that fails loudly.
        const py = `
import importlib.util, os, stat, tempfile
spec = importlib.util.spec_from_file_location('ub', ${JSON.stringify(script)})
ub = importlib.util.module_from_spec(spec); spec.loader.exec_module(ub)
d = tempfile.mkdtemp()
fake = os.path.join(d, 'node')
open(fake, 'w').write('#!/bin/bash\\necho "/Users/kevinbrittain/.config/od/agent-browser/utilita-apt1 exploded" >&2\\nexit 1\\n')
os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
r = ub.read_account({'label': 'Apartment 1', 'profile': 'utilita-apt1'}, node=fake)
print('PROBLEM=' + str(r['problem']))
print('OK=' + str(r['ok']))
`;
        const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
        expect(out).toMatch(/OK=False/);
        expect(out).toMatch(/PROBLEM=could not open the page/);
        expect(out).not.toMatch(/\/Users\//);          // no path reaches the message
        expect(out).not.toMatch(/agent-browser/);
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

    it('the relay handler itself enforces its caps and allowlist (driven, not grepped)', async () => {
        // The grep version of this test stayed green with BOTH caps wrapped in
        // `if (false && ...)`, because nothing executed the handler. This calls it.
        const { handleSlackRelay } = await import(
            new URL('../workers/apple-inbound/worker.js', import.meta.url).href);
        const posted = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url, opts) => {
            posted.push({ url: String(url), body: opts && opts.body });
            if (String(url).includes('users.lookupByEmail')) {
                return new Response(JSON.stringify({ ok: true, user: { id: 'U1' } }));
            }
            return new Response(JSON.stringify({ ok: true, ts: '1.2' }));
        };
        const env = { SLACK_RELAY_KEY: 'k', SLACK_BOT_TOKEN: 'xoxb-test' };
        const call = (body, key = 'k') => handleSlackRelay(new Request(
            'https://w/slack-relay',
            { method: 'POST', headers: { 'X-Relay-Key': key, 'Content-Type': 'application/json' },
              body: JSON.stringify(body) }), env);
        try {
            const kevin = 'kevin@runpreneur.org.uk';
            expect((await call({ recipients: [kevin], text: 'x' }, 'wrong')).status).toBe(401);
            expect((await call({ recipients: [kevin], text: 'x'.repeat(4001) })).status).toBe(413);
            expect((await call({ recipients: [kevin], text: 'x'.repeat(4000) })).status).toBe(200);
            expect((await call({ recipients: Array(5).fill(kevin), text: 'x' })).status).toBe(400);
            expect((await call({ recipients: ['stranger@example.com'], text: 'x' })).status).toBe(400);

            // Duplicates collapse to ONE DM, and the cap is applied AFTER
            // de-duplication so four copies of one address is one message.
            posted.length = 0;
            const dup = await call({ recipients: [kevin, kevin.toUpperCase(), kevin], text: 'x' });
            expect(dup.status).toBe(200);
            expect(posted.filter(p => p.url.includes('chat.postMessage')).length).toBe(1);

            // A stranger alongside an allowed recipient is refused, not delivered.
            posted.length = 0;
            const mixed = await call({ recipients: [kevin, 'stranger@example.com'], text: 'x' });
            const outMixed = await mixed.json();
            expect(outMixed.refused).toEqual(['stranger@example.com']);
            expect(posted.filter(p => p.url.includes('chat.postMessage')).length).toBe(1);
        } finally {
            globalThis.fetch = realFetch;
        }
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

    it('Utilita is kept out of session-keepalive by having no loginUrl', () => {
        // The old test never mentioned Utilita at all. The real mechanism is
        // that my.utilita.co.uk has NO loginUrl, which keepalive_sites requires
        // (scripts/session-keepalive.py:79) — and session-keepalive never passes
        // --profile, so it would test the empty `default` profile and mint a
        // false SIGN-IN NEEDED task every morning.
        const { loadSites } = require_(resolve(root, 'scripts/agent-browser.js'));
        const entry = loadSites()['my.utilita.co.uk'];
        expect(entry, 'my.utilita.co.uk must be on the allowlist for `read`').toBeTruthy();
        expect(entry.login).toBe(true);
        expect(entry.loginUrl, 'a loginUrl here enrols Utilita in the daily keepalive on the WRONG profile').toBeFalsy();
        const keepalive = readFileSync(resolve(root, 'scripts/session-keepalive.py'), 'utf8');
        expect(keepalive).toMatch(/v\.get\("loginUrl"\)|entry\.get\("loginUrl"\)|get\("loginUrl"\)/);
        expect(keepalive).not.toMatch(/--profile/);
    });
});
