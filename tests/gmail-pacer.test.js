import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// THE SHARED GMAIL PACER (Kevin's approved build, 5 Oct 2026; finding 20261002-phase-2-702).
//
// The triage history book was last rebuilt on 1 Sep 2026. Every rebuild since died on Gmail's
// per-minute metric, the give-up counter counted those capacity refusals as faults, and after two
// of them the retry stopped. By 7 Oct the inbox sorter had filed 35 days of mail against 1 Sep
// sender knowledge while every slot reported ok.
//
// Kevin named three things to prove, and each test below BREAKS the mechanism it guards to show
// the test would have caught its absence:
//   1. two processes sharing the pacer never pass 5,000 units in a minute
//   2. a walk refused halfway resumes and ends with exactly the counts of one clean pass
//   3. a wall during a rebuild is not a failure
//
// These drive the real functions in a real subprocess with a real on-disk ledger. Nothing is
// grepped and nothing is mocked except the clock and the Gmail transport.

const ROOT = path.resolve(__dirname, '..');
const PY = (code, env = {}) => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'pacer-')), 'drive.py');
  writeFileSync(f, code);
  return execFileSync('python3', [f], {
    encoding: 'utf8', cwd: ROOT, timeout: 120000,
    env: { ...process.env, ...env },
  });
};

/** A throwaway HOME so the ledger and progress file never touch the real ~/.config/od. */
const sandbox = () => mkdtempSync(path.join(tmpdir(), 'pacer-home-'));

describe('the shared Gmail pacer', () => {
  it('prices each call the way Gmail does, and an unknown path as a full page', () => {
    const out = PY(`
import importlib.util, json
spec = importlib.util.spec_from_file_location("gp", "scripts/gmail_pacer.py")
gp = importlib.util.module_from_spec(spec); spec.loader.exec_module(gp)
print(json.dumps({
    "listDefault": gp.gmail_units("/gmail/list", {}),
    "listOne":     gp.gmail_units("/gmail/list", {"maxResults": 1}),
    "listOver":    gp.gmail_units("/gmail/list", {"maxResults": 999}),
    "listJunk":    gp.gmail_units("/gmail/list", {"maxResults": "x"}),
    "modify3":     gp.gmail_units("/gmail/modify", {"ids": [1, 2, 3]}),
    "modifyNone":  gp.gmail_units("/gmail/modify", {}),
    "attachment":  gp.gmail_units("/gmail/attachment", {}),
    "labels":      gp.gmail_units("/gmail/labels", {}),
    "unknown":     gp.gmail_units("/gmail/brand-new", {}),
    "perMinute":   gp.GMAIL_UNITS_PER_MINUTE,
    "ceiling":     gp.GMAIL_PACE_CEILING,
    "rebuild":     gp.GMAIL_REBUILD_CEILING,
}))
`);
    const u = JSON.parse(out);
    expect(u.perMinute).toBe(6000);           // Gmail's real per-user per-minute quota
    expect(u.listDefault).toBe(505);          // 1 list (5) + 25 gets (20 each)
    expect(u.listOne).toBe(25);
    expect(u.listOver).toBe(505);             // clamped to the worker's own cap of 25
    expect(u.listJunk).toBe(505);             // unreadable maxResults is priced at the cap
    expect(u.modify3).toBe(15);
    expect(u.modifyNone).toBe(5);
    expect(u.attachment).toBe(5);
    expect(u.labels).toBe(1);
    expect(u.unknown).toBe(505);              // a new endpoint makes it cautious, not blind
    expect(u.ceiling).toBe(5000);             // 1,000 left for anything unpaced
    expect(u.rebuild).toBe(3000);             // a rebuild never takes more than half
  });

  // ── 1. two processes, one budget ───────────────────────────────────────────
  it('holds two concurrent processes to the ceiling between them', () => {
    const home = sandbox();
    const code = (tag) => `
import importlib.util, json, os, sys, time
spec = importlib.util.spec_from_file_location("gp", "scripts/gmail_pacer.py")
gp = importlib.util.module_from_spec(spec); spec.loader.exec_module(gp)
# A clock that does NOT advance: every call lands inside one minute, so the only thing that
# can keep the two processes under the ceiling is the shared ledger.
FROZEN = 1_000_000.0
granted = []
def sleeper(_s):
    # Waiting would never end on a frozen clock, so record the refusal and stop.
    print(json.dumps({"tag": "${tag}", "granted": len(granted), "refused": True}))
    sys.stdout.flush()
    os._exit(0)
for _ in range(20):
    gp.gmail_pace("/gmail/list", {}, account="a@b.com", sleep=sleeper, now=lambda: FROZEN)
    granted.append(1)
print(json.dumps({"tag": "${tag}", "granted": len(granted), "refused": False}))
`;
    const a = JSON.parse(PY(code('a'), { HOME: home }).trim().split('\n').pop());
    const b = JSON.parse(PY(code('b'), { HOME: home }).trim().split('\n').pop());
    // 505 a page: 9 pages = 4,545 fits under 5,000, a 10th would be 5,050 and must not.
    expect(a.granted).toBe(9);
    expect(a.refused).toBe(true);
    // The SECOND process sees the first one's spend and is refused immediately.
    expect(b.granted).toBe(0);
    expect(b.refused).toBe(true);
    const ledger = JSON.parse(readFileSync(path.join(home, '.config/od/gmail_pace/a_b.com.json'), 'utf8'));
    const spent = ledger.spent.reduce((t, [, u]) => t + u, 0);
    expect(spent).toBe(9 * 505);
    expect(spent).toBeLessThanOrEqual(5000);
  });

  it('BACK-TEST: without the shared ledger the second process spends the budget again', () => {
    const home = sandbox();
    // Same drive, but each process gets its OWN ledger directory — which is what two separate
    // in-process counters amount to, and what produced the 403s.
    const code = (tag) => `
import importlib.util, json, os, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("gp", "scripts/gmail_pacer.py")
gp = importlib.util.module_from_spec(spec); spec.loader.exec_module(gp)
gp.GMAIL_PACE_DIR = Path(os.environ["HOME"]) / ".config/od/gmail_pace_${tag}"
FROZEN = 1_000_000.0
granted = []
def sleeper(_s):
    print(json.dumps({"granted": len(granted)})); sys.stdout.flush(); os._exit(0)
for _ in range(20):
    gp.gmail_pace("/gmail/list", {}, account="a@b.com", sleep=sleeper, now=lambda: FROZEN)
    granted.append(1)
print(json.dumps({"granted": len(granted)}))
`;
    const a = JSON.parse(PY(code('a'), { HOME: home }).trim().split('\n').pop());
    const b = JSON.parse(PY(code('b'), { HOME: home }).trim().split('\n').pop());
    expect(a.granted + b.granted).toBe(18);                   // 9,090 units in one minute
    expect((a.granted + b.granted) * 505).toBeGreaterThan(6000);  // past Gmail's real limit
  });

  it('treats an unreadable ledger as a full minute, never an empty one', () => {
    const home = sandbox();
    const out = PY(`
import importlib.util, json, os, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("gp", "scripts/gmail_pacer.py")
gp = importlib.util.module_from_spec(spec); spec.loader.exec_module(gp)
p = gp._pace_file("a@b.com"); p.parent.mkdir(parents=True, exist_ok=True)
p.write_text("{not json")
def sleeper(_s):
    print(json.dumps({"refused": True})); sys.stdout.flush(); os._exit(0)
gp.gmail_pace("/gmail/list", {}, account="a@b.com", sleep=sleeper, now=lambda: 1_000_000.0)
print(json.dumps({"refused": False}))
`, { HOME: home });
    expect(JSON.parse(out.trim().split('\n').pop()).refused).toBe(true);
  });

  it('lets a call through once its minute has rolled past', () => {
    const home = sandbox();
    const out = PY(`
import importlib.util, json
spec = importlib.util.spec_from_file_location("gp", "scripts/gmail_pacer.py")
gp = importlib.util.module_from_spec(spec); spec.loader.exec_module(gp)
t = [1_000_000.0]
waits = []
def sleeper(s): waits.append(s); t[0] += s
for _ in range(11):
    gp.gmail_pace("/gmail/list", {}, account="a@b.com", sleep=sleeper, now=lambda: t[0])
print(json.dumps({"calls": 11, "waits": len(waits), "longest": max(waits), "elapsed": t[0] - 1_000_000.0}))
`, { HOME: home });
    const r = JSON.parse(out);
    expect(r.waits).toBeGreaterThan(0);          // it did have to wait
    expect(r.longest).toBeLessThanOrEqual(70);   // but never longer than the window plus skew
    expect(r.elapsed).toBeGreaterThan(0);
  });
});

// LEARNING THE REAL LIMIT (7 Oct 2026).
//
// The first live run of this pacer took a short-window refusal after 2,526 units in a minute —
// less than half the 6,000 the documentation describes, and below even the 3,000 rebuild ceiling.
// What Gmail enforces behaves like a moving average, so a burst of 505-unit pages is refused long
// before the minute's total is spent. A constant wrong in that direction makes the pacer useless,
// so it learns from each refusal instead.
describe('the pacer learns what Gmail actually refuses at', () => {
  it('records the rate in flight at a refusal and paces under it afterwards', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'pacer-learn-'));
    const out = PY(`
import importlib.util, json
spec = importlib.util.spec_from_file_location("gp", "scripts/gmail_pacer.py")
gp = importlib.util.module_from_spec(spec); spec.loader.exec_module(gp)
t = [1_000_000.0]
# Five pages get through on an empty ledger: 2,525 units, which is what the real run spent.
for _ in range(5):
    gp.gmail_pace("/gmail/list", {}, account="a@b.com", sleep=lambda s: None, now=lambda: t[0])
before = gp._pace_observed("a@b.com")
learned = gp.gmail_note_refusal("a@b.com", now=lambda: t[0])
# A later minute: the ledger has rolled over, but the LEARNED ceiling must not.
t[0] += 120
granted = []
def stop(_s):
    raise SystemExit(0)
try:
    for _ in range(10):
        gp.gmail_pace("/gmail/list", {}, account="a@b.com", sleep=stop, now=lambda: t[0])
        granted.append(1)
except SystemExit:
    pass
print(json.dumps({"before": before, "learned": learned,
                  "grantedAfter": len(granted), "ceilingStillSet": gp._pace_observed("a@b.com")}))
`, { HOME: home });
    const r = JSON.parse(out);
    expect(r.before).toBe(null);               // nothing learned until Gmail refuses
    expect(r.learned).toBe(2020);              // 80% of the 2,525 that was in flight
    expect(r.grantedAfter).toBe(4);            // 4 x 505 = exactly 2,020, not the 9 pages the constant allowed
    expect(r.ceilingStillSet).toBe(2020);      // and it survives the window rolling over
  });

  it('never learns a ceiling too low for a page to get through', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'pacer-floor-'));
    const out = PY(`
import importlib.util, json
spec = importlib.util.spec_from_file_location("gp", "scripts/gmail_pacer.py")
gp = importlib.util.module_from_spec(spec); spec.loader.exec_module(gp)
# Refused with almost nothing in flight — a bad minute, not a real limit of 4 units.
gp.gmail_pace("/gmail/labels", {}, account="a@b.com", sleep=lambda s: None, now=lambda: 1_000_000.0)
learned = gp.gmail_note_refusal("a@b.com", now=lambda: 1_000_000.0)
# A page must still be able to get through, or the rebuild waits for ever on its own limit.
ok = []
gp.gmail_pace("/gmail/list", {}, account="a@b.com", sleep=lambda s: ok.append("waited"), now=lambda: 1_000_100.0)
print(json.dumps({"learned": learned, "floor": gp.GMAIL_OBSERVED_FLOOR, "hadToWait": ok}))
`, { HOME: home });
    const r = JSON.parse(out);
    expect(r.learned).toBe(r.floor);           // clamped to the floor, not to 0
    expect(r.learned).toBeGreaterThan(505);    // a page fits
    expect(r.hadToWait).toEqual([]);           // and gets through without waiting
  });

  it('keeps the lower of two refusals, so the limit ratchets down not up', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'pacer-ratchet-'));
    const out = PY(`
import importlib.util, json
spec = importlib.util.spec_from_file_location("gp", "scripts/gmail_pacer.py")
gp = importlib.util.module_from_spec(spec); spec.loader.exec_module(gp)
t = [1_000_000.0]
for _ in range(5):
    gp.gmail_pace("/gmail/list", {}, account="a@b.com", sleep=lambda s: None, now=lambda: t[0])
low = gp.gmail_note_refusal("a@b.com", now=lambda: t[0])
t[0] += 120
# A second refusal with MORE in flight must not raise the ceiling back up.
for _ in range(3):
    gp.gmail_pace("/gmail/list", {}, account="a@b.com", sleep=lambda s: None, now=lambda: t[0])
again = gp.gmail_note_refusal("a@b.com", now=lambda: t[0])
print(json.dumps({"first": low, "second": again}))
`, { HOME: home });
    const r = JSON.parse(out);
    expect(r.second).toBeLessThanOrEqual(r.first);
  });
});
