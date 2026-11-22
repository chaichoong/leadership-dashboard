import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

// mac-nudge.py is how a Mac problem reaches Kevin (22 Nov 2026). Reminders is stubbed here,
// so no test can ever ping his phone.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts/mac-nudge.py');

const py = (body, env = {}) => JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, sys, io, contextlib, datetime as dt
spec = importlib.util.spec_from_file_location("nudge", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class Fake:
    LIST_OPEN, CREATE, COMPLETE = "LIST", "CREATE", "COMPLETE"
    def __init__(self, open_ref=""): self.open_ref, self.calls = open_ref, []
    def osa(self, script, *args):
        self.calls.append([script, *args])
        if script == "LIST": return (self.open_ref + "\\tbody [mac-nudge memory]") if self.open_ref else ""
        return "ref-new" if script == "CREATE" else ""
out = io.StringIO()
with contextlib.redirect_stdout(out):
    result = (lambda: (${body}))()
print(json.dumps({"result": result, "out": out.getvalue().strip()}, default=str))
`, SCRIPT], { encoding: 'utf8', env: { ...process.env, ...env } }));

describe('mac-nudge: when the phone pings', () => {
  const at = (iso) => py(`m.alert_time(dt.datetime.fromisoformat("${iso}")).isoformat()`).result;
  it('pings in two minutes during the day', () => expect(at('2026-11-23T14:10:30')).toBe('2026-11-23T14:12:00'));
  it('holds a night-time problem until 08:00 the same morning', () => expect(at('2026-11-23T03:00:00')).toBe('2026-11-23T08:00:00'));
  it('holds an evening problem until 08:00 the next morning', () => expect(at('2026-11-30T21:00:00')).toBe('2026-12-01T08:00:00'));
  it('still pings from 08:00 up to 20:57', () => {
    expect(at('2026-11-23T08:00:00')).toBe('2026-11-23T08:02:00');
    expect(at('2026-11-23T20:58:00')).toBe('2026-11-24T08:00:00');
    expect(at('2026-11-23T20:57:00')).toBe('2026-11-23T20:59:00');
  });
  // Review, 22 Nov 2026: the two-minute delay itself can land in the quiet hours.
  it('never lets the two-minute delay land at night', () => {
    expect(at('2026-11-23T20:59:00')).toBe('2026-11-24T08:00:00');
    expect(at('2026-11-23T23:59:00')).toBe('2026-11-24T08:00:00');
    expect(at('2026-11-23T07:57:00')).toBe('2026-11-23T08:00:00');
    expect(at('2026-11-23T07:59:00')).toBe('2026-11-23T08:01:00');
  });
});

describe('mac-nudge: one reminder per problem', () => {
  let dir; let state;
  const NOW = '2026-11-23T14:00:00';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mac-nudge-')); state = join(dir, 'state.json'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const env = (now = NOW) => ({ MAC_NUDGE_STATE: state, MAC_NUDGE_NOW: now, HOME: dir });
  const raise = (openRef = '', now = NOW) => py(`(lambda f: (m.cmd_raise("memory", "fseventsd is using 14 GB", f), f.calls))(Fake("${openRef}"))`, env(now)).result[1];
  const clear = (openRef = '') => py(`(lambda f: (m.cmd_clear("memory", f), f.calls))(Fake("${openRef}"))`, env()).result[1];

  it('makes one reminder carrying the reason and its marker', () => {
    const create = raise().find((c) => c[0] === 'CREATE');
    expect(create[1]).toBe('Restart the Mac mini today: memory is running out');
    expect(create[2]).toBe('fseventsd is using 14 GB [mac-nudge memory]');
    expect(create[3]).toBe('Reminders');
    expect(JSON.parse(readFileSync(state, 'utf8')).memory).toMatchObject({ date: '2026-11-23', ref: 'ref-new', broken: false });
  });

  it('never duplicates an open reminder', () => {
    expect(raise('ref-open').some((c) => c[0] === 'CREATE')).toBe(false);
  });

  it('waits until tomorrow when he ticks it off with the problem still there', () => {
    raise();
    expect(raise('', '2026-11-23T15:00:00').some((c) => c[0] === 'CREATE')).toBe(false);
    expect(raise('', '2026-11-24T09:00:00').some((c) => c[0] === 'CREATE')).toBe(true);
  });

  it('ticks the reminder off when the problem clears', () => {
    raise();
    expect(clear('ref-open')).toContainEqual(['COMPLETE', 'ref-open']);
    expect(JSON.parse(readFileSync(state, 'utf8')).memory).toEqual({ date: '2026-11-23' });
  });

  // Review, 22 Nov 2026: memory hovering at the limit must not ping on every crossing.
  it('does not ping twice in a day when the problem clears and returns', () => {
    raise();
    clear('ref-open');
    expect(raise('', '2026-11-23T16:00:00').some((c) => c[0] === 'CREATE')).toBe(false);
  });

  // Review, 22 Nov 2026: made Monday night, ticked Tuesday 08:05, back at 09:00.
  it('an open reminder refreshes its date, so ticking it off holds for that day', () => {
    raise('', '2026-11-23T22:00:00');
    raise('ref-open', '2026-11-24T08:00:00');
    expect(JSON.parse(readFileSync(state, 'utf8')).memory).toMatchObject({ date: '2026-11-24', ref: 'ref-open' });
    expect(raise('', '2026-11-24T09:00:00').some((c) => c[0] === 'CREATE')).toBe(false);
  });

  // A restart is what switches off a job whose launchd file is broken.
  it('says repair first while a launchd file is broken', () => {
    const agents = join(dir, 'Library', 'LaunchAgents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'com.kevinbrittain.some-job.plist'), '["not","a","plist"]');
    const calls = py(`(lambda f: (m.cmd_raise("memory", "fseventsd is using 14 GB", f), f.calls))(Fake(""))`, { ...env(), HOME: dir }).result[1];
    const create = calls.find((c) => c[0] === 'CREATE');
    expect(create[1]).toBe('Mac mini: ask Claude to repair com.kevinbrittain.some-job.plist, then restart');
    expect(create[2]).toMatch(/^Restarting now would switch that job off for good\./);
  });

  const breakFile = () => {
    const agents = join(dir, 'Library', 'LaunchAgents');
    mkdirSync(agents, { recursive: true });
    const f = join(agents, 'com.kevinbrittain.some-job.plist');
    writeFileSync(f, '["not","a","plist"]');
    return f;
  };

  // Review, 22 Nov 2026: the restart that clears the reminder is what lost the job.
  it('keeps a repair reminder open until the file is repaired', () => {
    const f = breakFile();
    raise();
    expect(clear('ref-open').some((c) => c[0] === 'COMPLETE')).toBe(false);
    rmSync(f);
    expect(clear('ref-open')).toContainEqual(['COMPLETE', 'ref-open']);
  });

  it('replaces an open "restart" reminder the moment a file breaks', () => {
    raise();
    breakFile();
    const calls = raise('ref-open', '2026-11-23T15:00:00');
    expect(calls).toContainEqual(['COMPLETE', 'ref-open']);
    expect(calls.find((c) => c[0] === 'CREATE')[1]).toMatch(/^Mac mini: ask Claude to repair/);
  });

  const again = (openRef = '', now = NOW) => py(`(lambda f: (m.cmd_again("memory", f), f.calls))(Fake("${openRef}"))`, env(now)).result[1];

  it('brings a ticked-off reminder back the next day with its reason', () => {
    raise();
    expect(again('', '2026-11-23T18:00:00').some((c) => c[0] === 'CREATE')).toBe(false);
    const create = again('', '2026-11-24T09:00:00').find((c) => c[0] === 'CREATE');
    expect(create[2]).toBe('fseventsd is using 14 GB [mac-nudge memory]');
  });

  it('makes no Reminders call on "again" when nothing is on file or it has cleared', () => {
    expect(again()).toEqual([]);
    raise();
    clear('ref-open');
    expect(again('', '2026-11-24T09:00:00')).toEqual([]);
  });

  it('runs each command under a lock, so two jobs cannot overwrite the state', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/fcntl\.flock\(lock, fcntl\.LOCK_EX\)/);
    expect(src).toMatch(/locked\(cmd_raise,/);
    expect(src).toMatch(/locked\(cmd_clear,/);
  });

  it('makes no Reminders call at all on a healthy run with nothing raised', () => {
    expect(clear()).toEqual([]);
    expect(existsSync(state)).toBe(false);
  });

  it('refuses a broken state file rather than reading it as nothing raised', () => {
    writeFileSync(state, '[1,2]');
    expect(() => clear()).toThrow();
  });

  it('refuses an unknown problem or an empty reason', () => {
    for (const args of [['raise', 'disk', 'x'], ['raise', 'memory', ' '], ['clear', 'disk'], []]) {
      const r = (() => { try { execFileSync('python3', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, MAC_NUDGE_STATE: state } }); return 0; } catch (e) { return e.status; } })();
      expect(r).toBe(64);
    }
  });
});
