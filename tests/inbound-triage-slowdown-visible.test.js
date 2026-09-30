// THE WAIT THAT LOOKED LIKE A HANG (finding 20260925-agent-dispatch-615).
//
// Gmail's per-minute metric refills on the clock minute, so worker_post waits
// it out rather than abandoning the slot. That wait was completely SILENT: the
// 23 Sep 17:00 slot and the 28 Sep 09:00 slot each sat for 585 seconds, decided
// zero messages, and read as hung on every surface Kevin has. Nothing in
// runs.log said "waiting on Gmail".
//
// Two things are guarded here:
//   1. Every slowdown sleep prints a progress line, on STDERR (stdout carries
//      this script's JSON and callers parse it).
//   2. A continuation scan — one that follows a TRUNCATED scan, which is the
//      cycle-2 case — clears the clock minute before its first Gmail call,
//      instead of re-hitting the still-hot window its predecessor just filled.
//
// The real module is loaded and driven. Nothing here greps the source: a test
// that only reads text would pass against a progress line that never prints.

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRIAGE = join(root, 'scripts/inbound-triage.py');
const ROOT = mkdtempSync(join(tmpdir(), 'triage-slowdown-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

// Runs python in-process against the real module. Returns { out, err }.
function drive(body) {
  const src = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('t', ${JSON.stringify(TRIAGE)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}
`;
  const r = execFileSync('python3', ['-c', src], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return r;
}

// Same, but keeps stdout and stderr apart so the "never on stdout" rule can
// actually be asserted.
function driveSplit(body) {
  const dir = mkdtempSync(join(ROOT, 'run-'));
  const script = join(dir, 'run.py');
  writeFileSync(script, `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('t', ${JSON.stringify(TRIAGE)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}
`);
  const outFile = join(dir, 'out.txt');
  const errFile = join(dir, 'err.txt');
  execFileSync('bash', ['-c', `python3 ${JSON.stringify(script)} > ${JSON.stringify(outFile)} 2> ${JSON.stringify(errFile)}`]);
  return { out: readFileSync(outFile, 'utf8'), err: readFileSync(errFile, 'utf8') };
}

describe('a Gmail per-minute wait says so', () => {
  // The per-minute metric, in Google's own words as the worker forwards it.
  const PER_MINUTE = "Quota exceeded for quota metric 'Gmail API units per minute per user'";

  it('prints a progress line to stderr on every slowdown sleep, and none to stdout', () => {
    // A worker that answers with the per-minute metric every time: worker_post
    // should wait, say so, wait, say so, and finally give up loudly.
    const { out, err } = driveSplit(`
import urllib.request, urllib.error, io
class Boom(urllib.error.HTTPError):
    def __init__(self):
        urllib.error.HTTPError.__init__(self, 'http://x', 500, 'err', {},
                                        io.BytesIO(${JSON.stringify(JSON.stringify(PER_MINUTE))}.encode()))
def boom(req, timeout=None):
    raise Boom()
urllib.request.urlopen = boom
m.read_secret = lambda p, w: 'token'
try:
    m.worker_post('/gmail/labels', {}, sleep=lambda s: None)
except SystemExit:
    pass
`);
    const lines = err.trim().split('\n').filter(Boolean);
    // MAX_ATTEMPTS is 4, so three waits happen before the last attempt gives up.
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) {
      expect(l).toMatch(/GMAIL PER-MINUTE METRIC FULL on \/gmail\/labels \(attempt \d+\/\d+\)/);
      expect(l).toMatch(/waiting 65s for the window to refill/);
    }
    // The cumulative figure moves, so a reader can tell a wait from a stall.
    expect(lines[0]).toMatch(/65s of this run's 600s budget spent/);
    expect(lines[1]).toMatch(/130s of this run's 600s budget spent/);
    // BACK-TEST: the old code printed nothing at all here, so this file's whole
    // point is that `lines` is non-empty.
    // stdout must carry ONLY the script's JSON verdict — a progress line there
    // would break every caller that json.loads() it.
    expect(out.trim().split('\n').filter(Boolean).every((l) => {
      try { JSON.parse(l); return true; } catch { return false; }
    })).toBe(true);
    expect(out).not.toMatch(/PER-MINUTE METRIC FULL/);
  });

  it('gives up loudly once the run has spent its slowdown budget', () => {
    // Unchanged behaviour, kept as the control: the progress lines must not
    // have turned a refusal into a narration.
    const { out } = driveSplit(`
import urllib.request, urllib.error, io
class Boom(urllib.error.HTTPError):
    def __init__(self):
        urllib.error.HTTPError.__init__(self, 'http://x', 500, 'err', {},
                                        io.BytesIO(${JSON.stringify(JSON.stringify(PER_MINUTE))}.encode()))
urllib.request.urlopen = lambda req, timeout=None: (_ for _ in ()).throw(Boom())
m.read_secret = lambda p, w: 'token'
m._slowdown['waited'] = m.MAX_SLOWDOWN_SECONDS
try:
    m.worker_post('/gmail/labels', {}, sleep=lambda s: None)
except SystemExit:
    pass
`);
    expect(out).toMatch(/GMAIL RATE METRIC STILL FULL/);
    expect(JSON.parse(out.trim().split('\n').filter(Boolean).pop()).kind).toBe('rate');
  });
});

describe('seconds_to_next_minute — what a cycle-2 scan waits for', () => {
  const at = (t) => JSON.parse(drive(`print(json.dumps(m.seconds_to_next_minute(${t})))`).trim());

  it('waits to the CLOCK boundary, which is where the metric refills', () => {
    expect(at(0)).toBeCloseTo(60, 6);        // exactly on a boundary
    expect(at(10)).toBeCloseTo(50, 6);
    expect(at(59.5)).toBeCloseTo(0.5, 6);
    expect(at(1790000041)).toBeCloseTo(59, 6);   // 1790000040 is itself a boundary
  });

  it('never returns 0, so a run starting on the boundary still clears the window', () => {
    // BACK-TEST: a naive `60 - t % 60` with a floor of 0 would return 0 here
    // and the first call would land in the same minute that was just full.
    for (const t of [0, 60, 120, 1790000040]) expect(at(t)).toBeGreaterThan(0);
    // And it can never exceed a minute, so the wait cannot eat the slot.
    for (const t of [0, 0.001, 30, 59.999]) expect(at(t)).toBeLessThanOrEqual(60);
  });
});

describe('cmd_scan clears the clock minute after a truncated scan', () => {
  // state.json is the only thing that says "cycle 1 was cut short".
  function scanWith(stateJson) {
    const dir = mkdtempSync(join(ROOT, 'state-'));
    mkdirSync(join(dir, 'inbound-triage'), { recursive: true });
    writeFileSync(join(dir, 'inbound-triage/state.json'), stateJson);
    return JSON.parse(drive(`
m.base_dir = lambda: __import__('pathlib').Path(${JSON.stringify(join(dir, 'inbound-triage'))})
waited = []
def stop(*a, **k):
    raise RuntimeError('STOP AT FIRST GMAIL CALL')
m.worker_labels = stop
try:
    m.cmd_scan(12, sleep=lambda s: waited.append(s))
except RuntimeError as e:
    assert 'STOP AT FIRST GMAIL CALL' in str(e), e
print(json.dumps(waited))
`).trim());
  }

  it('waits under a minute before the first Gmail call when the last scan was truncated', () => {
    const waited = scanWith(JSON.stringify({ watermark_ms: 1788000000000, last_scan_truncated: true }));
    expect(waited.length).toBe(1);
    expect(waited[0]).toBeGreaterThan(0);
    expect(waited[0]).toBeLessThanOrEqual(60);
  });

  it('does NOT wait when the last scan saw everything', () => {
    // The ordinary slot must not grow a minute of dead time.
    expect(scanWith(JSON.stringify({ watermark_ms: 1788000000000, last_scan_truncated: false }))).toEqual([]);
    expect(scanWith('{}')).toEqual([]);
  });
});
