// Guards for the smart-home battery and offline watch (28 Sep 2026).
//
// The failures these exist for:
//
//  1. The Aqara Office camera dropped off the network at 18:32 on 28 Sep 2026
//     and nobody knew. An offline device must become a reminder, and a device
//     whose state is unknown must never read as online or offline.
//  2. A watch that cannot reach Aqara (expired sign-in, no network, an empty or
//     half-answered list) must say so, never pass as "nothing is low".
//  3. A battery level is read, never guessed: a model that only reports voltage
//     gives no level at all.
//  4. Aqara rejects a request with a wrong signature, and the whole watch goes
//     blind; the signature is pinned to Aqara's own worked example.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(root, 'scripts/home-battery.py');

// Runs a Python body with the module loaded as hb and a fixed clock.
function py(body) {
    const code = `
import importlib.util, json, datetime as dt
spec = importlib.util.spec_from_file_location('hb', ${JSON.stringify(script)})
hb = importlib.util.module_from_spec(spec); spec.loader.exec_module(hb)
now = dt.datetime(2026, 9, 28, 21, 25)
iso = lambda t: t.isoformat(timespec='seconds')
def dev(i, online=True, level=None, battery=True, name=None):
    return {'id': i, 'name': name or i, 'model': 'm', 'online': online, 'battery': battery, 'level': level}
${body}
print(json.dumps(out, default=str))
`;
    return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf8' }).trim());
}

describe('home-battery watch', () => {
    it('offline selftest passes', () => {
        const out = execFileSync('python3', [script, 'selftest'], { encoding: 'utf8' });
        expect(out).toMatch(/selftest OK/);
    });

    it('signs requests exactly as Aqara documents', () => {
        // Back-tested 28 Sep 2026: dropping .lower() from sign() changes the hash.
        const out = py(`
h = {'Accesstoken': '532cad73c5493193d63d367016b98b27', 'Appid': '4e693d54d75db580a56d1263',
     'Keyid': '78784564654feda454557', 'Nonce': 'C6wuzd0Qguxzelhb', 'Time': '1618914078668'}
out = hb.sign(h, 'gU7Qtxi4dWnYAdmudyxni52bWZ58b8uN')`);
        expect(out).toBe('bfd8dd0e7c108353e6740d81e05982d8');
    });

    it('an offline device gets a reminder after 2 hours, not before', () => {
        const out = py(`
cam = [dev('cam', online=False, battery=False, name='Office Camera')]
def run(since):
    s = hb.track(now, cam, {}); s['devices']['cam']['offline_since'] = iso(since); s['last_ok'] = iso(now)
    return [a['title'] for a in hb.decide(now, True, cam, s, [], {}) if a['do'] == 'create']
out = [run(now - dt.timedelta(minutes=119)), run(now - dt.timedelta(hours=2))]`);
        expect(out).toEqual([[], ['Office Camera is offline']]);
    });

    it('an unknown state is neither online nor offline', () => {
        const out = py(`
d = [dev('x', online=None, battery=False)]
openr = [{'key': hb.marker('offline', 'x'), 'ref': 'r1'}]
s = hb.track(now, d, {}); s['last_ok'] = iso(now)
out = [hb.parse_state(None), hb.decide(now.replace(hour=9), True, d, s, openr, {})]`);
        expect(out).toEqual([null, []]);
    });

    it('nudges a battery at 20% and below, not 21%', () => {
        const out = py(`
d = [dev('a', level=20, name='Utility Motion'), dev('b', level=21)]
s = hb.track(now, d, {}); s['last_ok'] = iso(now)
out = [a['title'] for a in hb.decide(now, True, d, s, [], {}) if a['do'] == 'create']`);
        expect(out).toEqual(['Battery low: Utility Motion (20%)']);
    });

    it('a failed or partial read raises "cannot see" after 24 hours and closes nothing else', () => {
        const out = py(`
openr = [{'key': hb.marker('offline', 'cam'), 'ref': 'r1'}, {'key': hb.marker('low', 'a'), 'ref': 'r2'}]
st = {'last_ok': iso(now - dt.timedelta(hours=24)), 'last_error': 'Aqara said 108'}
acts = hb.decide(now, False, [], st, openr, {})
out = [[(a['do'], a.get('kind')) for a in acts], hb.count_ok([], 60)[0], hb.count_ok([dev(str(i)) for i in range(47)], 60)[0]]`);
        expect(out).toEqual([[['create', 'blind']], false, false]);
    });

    it('never guesses a percentage from a voltage', () => {
        const out = py(`
out = [hb.pick_battery_resource([{'resourceId': '8.0.2008', 'name': 'Battery voltage', 'unit': 'mV'}]),
       hb.pick_battery_resource([{'resourceId': '8.0.2008', 'name': 'Battery voltage', 'unit': 'mV'},
                                 {'resourceId': '8.0.2001', 'name': 'Battery level', 'unit': '%'}]),
       hb.parse_level('abc'), hb.parse_level('150')]`);
        expect(out).toEqual([null, '8.0.2001', null, null]);
    });

    it('closes reminders only on a fresh read that proves the problem is gone', () => {
        const out = py(`
openr = [{'key': hb.marker('offline', 'cam'), 'ref': 'r1'}, {'key': hb.marker('low', 'a'), 'ref': 'r2'}]
d = [dev('cam', battery=False), dev('a', level=95)]
s = hb.track(now, d, {}); s['last_ok'] = iso(now)
out = sorted(a['ref'] for a in hb.decide(now.replace(hour=9), True, d, s, openr, {}) if a['do'] == 'complete')`);
        expect(out).toEqual(['r1', 'r2']);
    });
});
