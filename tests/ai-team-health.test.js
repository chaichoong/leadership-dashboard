import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// The ai-team-health Estate Status row (Kevin, 9 Oct 2026): the Leadership Dashboard's AI
// Team section reads it. The fixture is shaped from the live numbers read on 9 Oct 2026:
// 178 agent tasks open, 164 in and 119 done in 7 days; 207 defects open, 95 filed and 14
// fixed in 7 days; 43 of 105 fixes in 14 days were a fix of a fix (41%, baseline 32%).
// Every test drives the real functions in scripts/estate-status.py and scripts/loop-health.py.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function py(code) {
  const script = `
import importlib.util, json, sys, os, tempfile
from datetime import datetime, timedelta, timezone
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(${JSON.stringify(resolve(ROOT, 'scripts'))}, file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
es = load("es", "estate-status.py")
lh = load("lh", "loop-health.py")
NOW = datetime(2026, 10, 9, 16, 30, tzinfo=timezone.utc)
def iso(dt): return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
${code}
`;
  return JSON.parse(execFileSync('/usr/bin/python3', ['-c', script], { encoding: 'utf8' }));
}

const LH_RES = `{"flow": {"agentOpen": 178, "agentCreated7d": 164, "agentDone7d": 119},
                 "stalled": [{"name": "t%d" % i} for i in range(40)]}`;
const MEASURES = `lambda now: ({"open": 207, "filed7d": 95, "fixed7d": 14},
                               es.rework_counts({"days": 14, "fixes": 105, "fix_of_fix": 43}),
                               "2026-10-09T16:23:52.000Z")`;

describe('the ai-team-health row', () => {
  it('carries the four numbers the dashboard shows (the 9 Oct worked example)', () => {
    const row = py(`print(json.dumps(es.ai_team_row(NOW, ${LH_RES}, None, measures=${MEASURES})))`);
    expect(row.status).toBe('Worked');
    expect(row.key).toBe('ai-team-health');
    const p = JSON.parse(row.payload);
    expect(p.work).toEqual({ open: 178, notMoving: 40, created7d: 164, done7d: 119 });
    expect(p.defects).toEqual({ open: 207, filed7d: 95, fixed7d: 14 });
    expect(p.rework).toEqual({ days: 14, fixes: 105, fixOfFix: 43, pct: 41, baselinePct: 32 });
    expect(row.detail).toMatch(/41% \(43 of 105 fixes\)/);
  });

  it('is Failed with the reason, never a zero, when agent work cannot be read', () => {
    const row = py(`print(json.dumps(es.ai_team_row(NOW, None, "control failed")))`);
    expect(row.status).toBe('Failed');
    expect(row.detail).toMatch(/control failed/);
    expect(row.payload).toBeUndefined();
  });

  it('is Failed when the defect queue or rework rate cannot be read', () => {
    const row = py(`
def boom(now): raise RuntimeError("rework-rate.py exited 1")
print(json.dumps(es.ai_team_row(NOW, ${LH_RES}, None, measures=boom)))`);
    expect(row.status).toBe('Failed');
    expect(row.detail).toMatch(/rework-rate.py exited 1/);
  });

  it('is Failed when loop-health returned no flow counts', () => {
    const row = py(`print(json.dumps(es.ai_team_row(NOW, {"stalled": []}, None, measures=${MEASURES})))`);
    expect(row.status).toBe('Failed');
  });
});

describe('the counts behind it', () => {
  it('defects: open is the backlog; filed and fixed count only the last 7 days', () => {
    const out = py(`
state = {
  "a": {"status": "open", "ts": iso(NOW - timedelta(days=1))},
  "b": {"status": "claimed", "ts": iso(NOW - timedelta(days=20))},
  "c": {"status": "fixed", "ts": iso(NOW - timedelta(days=3)), "landed_at": iso(NOW - timedelta(days=2))},
  "d": {"status": "fixed", "ts": iso(NOW - timedelta(days=30)), "landed_at": iso(NOW - timedelta(days=9))},
  "e": {"status": "rejected", "ts": iso(NOW - timedelta(days=2))},
  "f": {"status": "deferred", "ts": iso(NOW - timedelta(days=40))},
}
print(json.dumps(es.defect_counts(state, NOW)))`);
    expect(out).toEqual({ open: 2, filed7d: 3, fixed7d: 1 });
  });

  it('defects: a finding closed as fixed against a commit counts, by the close op\'s time', () => {
    // Review finding, 9 Oct 2026: counting landed_at alone missed 9 of 23 fixes that week.
    const out = py(`
state = {
  "g": {"status": "fixed", "ts": iso(NOW - timedelta(days=20))},
  "h": {"status": "fixed", "ts": iso(NOW - timedelta(days=20))},
}
ops = [
  {"op": "close", "id": "g", "outcome": "fixed", "ts": iso(NOW - timedelta(days=1))},
  {"op": "close", "id": "h", "outcome": "fixed", "ts": iso(NOW - timedelta(days=12))},
  {"op": "close", "id": "x", "outcome": "rejected", "ts": iso(NOW - timedelta(days=1))},
]
print(json.dumps(es.defect_counts(state, NOW, ops)))`);
    expect(out.fixed7d).toBe(1);
  });

  it('rework: zero fixes is no rate, not 0%', () => {
    expect(py(`print(json.dumps(es.rework_counts({"days": 14, "fixes": 0, "fix_of_fix": 0})))`).pct).toBeNull();
  });

  it('agent flow counts only agent tasks created inside 7 days', () => {
    const out = py(`
fields = [
  {"Team Member": ["recAGENT"], "Created Time": iso(NOW - timedelta(days=2))},
  {"Team Member": ["recAGENT"], "Created Time": iso(NOW - timedelta(days=8))},
  {"Team Member": ["recHUMAN"], "Created Time": iso(NOW - timedelta(days=1))},
  {"Team Member": ["recAGENT"]},
]
print(json.dumps(lh.agent_flow(fields, {"recAGENT"}, 178, 119, now=NOW)))`);
    expect(out).toEqual({ agentOpen: 178, agentCreated7d: 1, agentDone7d: 119 });
  });

  it('the hourly cache is used inside the hour and recomputed after it', () => {
    const out = py(`
calls = []
def measure(now):
    calls.append(now)
    return {"open": 1, "filed7d": 0, "fixed7d": 0}, {"days": 14, "fixes": 0, "fixOfFix": 0, "pct": None, "baselinePct": 32}
d = tempfile.mkdtemp(); cache = os.path.join(d, "c.json")
es._cached_measures(NOW, cache=cache, measure=measure)
es._cached_measures(NOW + timedelta(minutes=30), cache=cache, measure=measure)
es._cached_measures(NOW + timedelta(minutes=61), cache=cache, measure=measure)
print(json.dumps({"calls": len(calls)}))`);
    expect(out.calls).toBe(2);
  });
});
