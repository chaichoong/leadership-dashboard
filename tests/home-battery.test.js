// Guards for the smart-home battery and offline watch (28 Sep 2026).
//
// The failures these exist for:
//
//  1. The Aqara Office camera dropped off the network at 18:32 on 28 Sep 2026
//     and nobody knew. An offline device must become a reminder, a device that
//     vanishes from Aqara's list must too, and a device whose state is unknown
//     must never read as online or offline.
//  2. A watch that cannot reach Aqara (expired sign-in, no network, a missing
//     page, a reply in an unexpected shape) must say so, never crash and never
//     pass as "nothing is low".
//  3. A battery level is read, never guessed, and a battery device is never
//     mistaken for a mains one because its model only reports a voltage.
//  4. Aqara rejects a request with a wrong signature and the whole watch goes
//     blind, so the signature is pinned to Aqara's own worked example.
// Items 1-3 beyond the first cut were found by the independent review of
// 28 Sep 2026; each check below was back-tested by breaking the fix.
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
now = dt.datetime(2026, 9, 28, 21, 20)
iso = lambda t: t.isoformat(timespec='seconds')
def dev(i, online=True, level=None, battery=True, name=None, at=None):
    return {'id': i, 'name': name or i, 'model': 'm', 'online': online, 'battery': battery, 'level': level,
            'level_at': iso(at or now) if level is not None else None, 'low_flag': None, 'flag_at': None}
def st(devs, last_ok=None):
    s = hb.track(now, devs, {}); s['last_ok'] = iso(last_ok or now); return s
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

    it('an offline device gets a reminder at 2 hours, allowing a late start', () => {
        const out = py(`
cam = [dev('cam', online=False, battery=False, name='Office Camera')]
def run(since, at=now):
    s = hb.track(since, cam, {}); s['last_ok'] = iso(at)
    return [a['title'] for a in hb.decide(at, True, cam, s, [], {}) if a['do'] == 'create']
out = [run(now - dt.timedelta(minutes=90)), run(now - dt.timedelta(hours=2) + dt.timedelta(seconds=40))]`);
        expect(out).toEqual([[], ['Office Camera is offline']]);
    });

    it('an unknown state is neither online nor offline', () => {
        const out = py(`
d = [dev('x', online=None, battery=False)]
openr = [{'key': hb.marker('offline', 'x'), 'ref': 'r1'}]
out = [hb.parse_state(None), hb.decide(now.replace(hour=9), True, d, st(d), openr, {})]`);
        expect(out).toEqual([null, []]);
    });

    it('nudges a battery at 20% and below, not 21%, and trusts an online device\'s old-dated level', () => {
        // Review round 2 (28 Sep 2026): a level that has not changed keeps its
        // old Aqara date; skipping it dropped real low batteries with no trace.
        const out = py(`
d = [dev('a', level=20, name='Utility Motion'), dev('b', level=21), dev('c', level=5, name='Loft', at=now - dt.timedelta(hours=30))]
unk = [dev('u', online=None, level=5, at=now - dt.timedelta(hours=30))]
out = [[a['title'] for a in hb.decide(now, True, d, st(d), [], {}) if a['do'] == 'create'],
       [a['title'] for a in hb.decide(now, True, unk, st(unk), [], {}) if a['do'] == 'create'],
       hb.stamp(1790640000, now)]`);
        // Review of 29 Sep 2026: an old reading on a device of unknown state is
        // not trusted as low, but it is named, never dropped.
        expect(out).toEqual([['Battery low: Utility Motion (20%)', 'Battery low: Loft (5%)'],
            ['Check 1 battery device in the Aqara app'], null]);
    });

    it('never treats a voltage-only battery device as mains, and never guesses its level', () => {
        const out = py(`
out = [hb.classify([{'resourceId': '8.0.2008', 'name': 'Battery voltage', 'unit': 'mV'}]),
       hb.classify([{'resourceId': '13.1.85', 'name': 'Low battery alarm'}]),
       hb.parse_level('abc'), hb.parse_level('150')]`);
        expect(out).toEqual([
            { battery: true, pct: null, flag: null },
            { battery: true, pct: null, flag: '13.1.85' },
            null, null,
        ]);
    });

    it('a missing page or an odd reply is an error, never a short list or a crash', () => {
        const out = py(`
def err(**kw):
    try:
        return len(hb.fake_read(now, **kw))
    except hb.AqaraError as e:
        return str(e)
out = [err(n=50, total=62), err(n=60, total=None), err(n=3, total=3, bad_row=True), err(n=3, total=3, junk=True)]`);
        expect(out[0]).toMatch(/50 of 62 devices arrived/);
        expect(out[1]).toBe(60);
        expect(out[2]).toMatch(/no id/);
        expect(out[3]).toMatch(/expected a list/);
    });

    it('a device that vanishes from Aqara is reported once per disappearance, only after a good read', () => {
        const out = py(`
here = [dev('x', level=80)]
s = st([dev('gone', name='Loft Motion', level=80)]); s['devices']['gone']['last_seen'] = iso(now - dt.timedelta(hours=25))
good = [a['title'] for a in hb.decide(now, True, here, s, [], {}) if a['do'] == 'create']
again = hb.decide(now, True, here, s, [], {'missing:gone': '2026-09-20'})
failed = [a['kind'] for a in hb.decide(now, False, [], s, [], {}) if a['do'] == 'create']
cleared = 'missing:gone' in hb.track(now, [dev('gone', level=80)], dict(s, nudged={'missing:gone': '2026-09-20'}))['nudged']
out = [good, again, failed, cleared]`);
        expect(out).toEqual([['Loft Motion has vanished from Aqara'], [], [], false]);
    });

    it('battery devices with no readable level get one reminder, and one bad model blinds nothing', () => {
        const out = py(`
nolev = [dev('v1', name='Blind'), dev('v2', name='Switch'), dev('p', level=80)]
made = [a['title'] for a in hb.decide(now, True, nolev, st(nolev), [], {}) if a['do'] == 'create']
devs = {d['id']: d for d in hb.fake_read(now, n=3, total=3, refuse='m.c')}
out = [made, len(devs), devs['aqara:c2']['battery'], devs['aqara:c2']['online']]`);
        expect(out).toEqual([['Check 2 battery devices in the Aqara app'], 3, null, false]);
    });

    it('a failed read says so after 12 hours, nudges from a recent good read, and closes nothing', () => {
        const out = py(`
openr = [{'key': hb.marker('offline', 'cam'), 'ref': 'r1'}, {'key': hb.marker('low', 'a'), 'ref': 'r2'}]
blind = hb.decide(now, False, [], {'last_ok': iso(now - dt.timedelta(hours=12) + dt.timedelta(seconds=40)), 'last_error': 'x'}, openr, {})
cam = [dev('cam', online=False, battery=False)]
s = hb.track(now - dt.timedelta(hours=4), cam, {}); s = hb.track(now - dt.timedelta(hours=1), cam, s)
s['last_ok'] = iso(now - dt.timedelta(hours=1))
fallback = hb.decide(now, False, hb.from_state(s), s, [], {})
closes = hb.decide(now.replace(hour=9), False, hb.from_state(s), s, openr, {})
out = [[(a['do'], a.get('kind')) for a in blind], [(a['do'], a.get('kind')) for a in fallback], closes,
       hb.count_ok([], 60)[0], hb.count_ok([dev(str(i)) for i in range(47)], 60)[0]]`);
        expect(out).toEqual([[['create', 'blind']], [['create', 'offline']], [], false, false]);
    });

    it('reads Home Assistant rows, keeps the two sources apart, and never quotes a damaged key', () => {
        const out = py(`
import tempfile, os
rows = [{'entity': 'binary_sensor.va1_battery', 'device': 'VA1', 'model': 'VA02', 'state': 'on', 'unit': '',
         'changed': '2026-09-29T07:23:15+00:00', 'conn': ['on']}]
ha = hb.ha_devices(rows, {'VA1': 'En Suite radiator valve'}, now)
titles = [a['title'] for a in hb.decide(now, True, ha, st(ha), [], {}, src='ha') if a['do'] == 'create']
other = [{'key': hb.marker('blind', 'watch:aq', 'aq'), 'ref': 'aq-blind'}]
crossed = [a for a in hb.decide(now.replace(hour=9), True, ha, st(ha), other, {}, src='ha') if a['do'] == 'complete']
d = tempfile.mkdtemp(); k = os.path.join(d, 'k'); open(k, 'w').write('FAKEKEY-1\\nFAKEKEY-1')
bad = hb.read_ha(now, k)
out = [titles, crossed, 'FAKEKEY' in bad[1], hb.read_source('ha', {'last_ok': iso(now)}, now, os.path.join(d, 'none'))[1][:39]]`);
        expect(out).toEqual([['Battery low: En Suite radiator valve (low)'], [], false,
            'the Home Assistant key file is missing:']);
    });

    it('closes reminders only on a fresh read that proves the problem is gone', () => {
        const out = py(`
openr = [{'key': hb.marker('offline', 'cam'), 'ref': 'r1'}, {'key': hb.marker('low', 'a'), 'ref': 'r2'}]
d = [dev('cam', battery=False), dev('a', level=95)]
out = sorted(a['ref'] for a in hb.decide(now.replace(hour=9), True, d, st(d), openr, {}) if a['do'] == 'complete')`);
        expect(out).toEqual(['r1', 'r2']);
    });
});
