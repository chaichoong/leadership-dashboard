// Guards for the Magic device battery nudge (28 Sep 2026).
//
// The failures these exist for:
//
//  1. Bluetooth settings (system_profiler) shows NO level for the Magic Mouse,
//     only the IO registry does. A reader built on the settings pane would have
//     watched two of three devices and called the mouse fine for ever.
//  2. A switched-off or flat device simply vanishes from the registry. "No low
//     readings" must never read as all clear, so absence gets its own reminder
//     and a blank reading closes nothing.
//  3. One reminder per device per evening. Ticking it off without charging must
//     not bring it straight back the same night, and an open one is never doubled.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(root, 'scripts/magic-battery.py');

// Drives decide() directly with a fixed clock. Returns the parsed actions.
function decide(body) {
    const py = `
import importlib.util, json, datetime as dt
spec = importlib.util.spec_from_file_location('mb', ${JSON.stringify(script)})
mb = importlib.util.module_from_spec(spec); spec.loader.exec_module(mb)
now = dt.datetime(2026, 9, 28, 21, 25)
M = '90:9C:4A:00:F9:1F'
K = '68:FE:F7:00:7D:04'
${body}
print(json.dumps(acts, default=str))
`;
    return JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' }).trim());
}

describe('magic-battery nudge', () => {
    it('offline selftest passes', () => {
        const out = execFileSync('python3', [script, 'selftest'], { encoding: 'utf8' });
        expect(out).toMatch(/selftest OK/);
    });

    it('nudges at 20% and below, not at 21%', () => {
        // Back-tested 28 Sep 2026: changing `<= threshold` to `< threshold` in
        // decide() fails the 20% half of this test.
        const at20 = decide(`acts = mb.decide(now, [{'id': M, 'name': 'Magic Mouse 2', 'level': 20}], {}, [], {})`);
        expect(at20.filter((a) => a.do === 'create').map((a) => a.title))
            .toEqual(['Charge the Magic Mouse tonight (20%)']);
        const at21 = decide(`acts = mb.decide(now, [{'id': M, 'name': 'Magic Mouse 2', 'level': 21}], {}, [], {})`);
        expect(at21).toEqual([]);
    });

    it('uses the default threshold of 20 when none is passed', () => {
        const acts = decide(`acts = [mb.THRESHOLD]`);
        expect(acts).toEqual([20]);
    });

    it('never doubles an open reminder or re-nudges the same evening', () => {
        const open = decide(`acts = mb.decide(now, [{'id': M, 'name': 'x', 'level': 10}], {}, [{'key': mb.marker('low', M), 'ref': 'r1'}], {})`);
        expect(open).toEqual([]);
        const same = decide(`acts = mb.decide(now, [{'id': M, 'name': 'x', 'level': 10}], {}, [], {'low:' + M: '2026-09-28'})`);
        expect(same).toEqual([]);
    });

    it('a blank reading closes nothing and a long silence raises a not-seen reminder', () => {
        const blank = decide(`acts = mb.decide(now.replace(hour=9), [{'id': M, 'name': 'x', 'level': None}], {}, [{'key': mb.marker('low', M), 'ref': 'r1'}], {})`);
        expect(blank).toEqual([]);
        const silent = decide(`
h = {M: {'name': 'Magic Mouse 2', 'last_seen': now - dt.timedelta(hours=49), 'level': 70, 'level_at': now - dt.timedelta(hours=49)}}
acts = mb.decide(now, [], h, [], {})`);
        expect(silent.map((a) => [a.do, a.kind])).toEqual([['create', 'missing']]);
        expect(silent[0].title).toMatch(/Check the Magic Mouse: not seen for 2 days/);
    });

    it('a charged device ticks its own reminder off', () => {
        const acts = decide(`acts = mb.decide(now.replace(hour=9), [{'id': M, 'name': 'x', 'level': 55}], {}, [{'key': mb.marker('low', M), 'ref': 'r9'}], {})`);
        expect(acts.map((a) => [a.do, a.ref])).toEqual([['complete', 'r9']]);
    });

    it('takes the level from the registry and the name from Bluetooth settings', () => {
        // The keyboard's registry name is its owner string, not "Magic Keyboard".
        const acts = decide(`
import plistlib
raw = plistlib.dumps([{'DeviceAddress': '68-fe-f7-00-7d-04', 'Product': "System Administrator's Keyboard", 'BatteryPercent': 12, 'Built-In': False}])
levels = mb.parse_ioreg(raw)
names = mb.parse_profiler({'SPBluetoothDataType': [{'device_connected': [{'Magic Keyboard 2': {'device_address': '68:FE:F7:00:7D:04'}}]}]})
acts = [levels[K]['level'], names[K]]`);
        expect(acts).toEqual([12, 'Magic Keyboard 2']);
    });

    it('never puts a reminder in the Captures list, which feeds the brain', () => {
        const acts = decide(`acts = [mb.LIST_NAME]`);
        expect(acts).toEqual(['Reminders']);
    });
});
