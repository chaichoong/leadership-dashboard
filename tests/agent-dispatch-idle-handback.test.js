import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SRC = readFileSync(DISPATCH, 'utf8');

// 14 Sep 2026. The 30-minute hand-back poll woke a full Claude run for the
// same five approved tasks 48 times a day. Two were EICR quote chases Kevin
// approved to STAY OPEN until a chase date: every poll "carried them out"
// again and appended a note (one task's Notes reached 46,000 characters).
// Three needed a sign-in only Kevin can do: every poll re-parked them with
// the same note. Measured over 8-10 Sep the poll used 1,087 minutes of
// Claude time, more than the Content Engine and triage together, and the
// weekly allowance ran out at 13:00 on Friday 11 Sep. Nothing ran until
// Sunday 19:00.
//
// idle_handback rests such a task for IDLE_HOURS from the ledger event that
// proves it (done + keep-open mark, or parked), listed under idleHandbacks
// with its reason, and wakes it early the moment Kevin's verdict moves.
function py(snippet) {
  const script = `
import importlib.util, json, sys
from datetime import datetime, timezone, timedelta
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = datetime(2026, 9, 14, 8, 0, tzinfo=timezone.utc)
def t(**kw):
    base = {"outcome": "Approved as-is", "notes": "", "approvedAt": "2026-09-10T09:00:00.000Z"}
    base.update(kw); return base
${snippet}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

describe('idle hand-backs rest for a day', () => {
  it('carried out and kept open (done + mark, 1h ago) rests', () => {
    const r = py(`print(json.dumps(m.idle_handback(t(notes="x " + m.CARRIED_OUT_MARK + " chase due 16 Sep"), ("done", "2026-09-14T07:03:50.000Z"), NOW)))`);
    expect(r).toMatch(/^carried out and kept open at 2026-09-14T07:03; rests 2[0-3]h more/);
  });

  it('a done with NO keep-open mark is an incomplete close and is NOT rested', () => {
    const r = py(`print(json.dumps(m.idle_handback(t(notes="sent the email"), ("done", "2026-09-14T07:03:50.000Z"), NOW)))`);
    expect(r).toBe('');
  });

  it('parked on a sign-in (2h ago) rests; after 24h it is looked at again', () => {
    const r = py(`print(json.dumps([
  m.idle_handback(t(), ("parked", "2026-09-14T06:00:00.000Z"), NOW),
  m.idle_handback(t(), ("parked", "2026-09-13T06:00:00.000Z"), NOW)]))`);
    expect(r[0]).toMatch(/^parked on a sign-in only Kevin can do at 2026-09-14T06:00; rests 2[0-3]h more/);
    expect(r[1]).toBe('');
  });

  it("wakes at once when Kevin's verdict moves (Approved At newer than the event, or Changes requested)", () => {
    const r = py(`print(json.dumps([
  m.idle_handback(t(approvedAt="2026-09-14T07:30:00.000Z", notes=m.CARRIED_OUT_MARK), ("done", "2026-09-14T07:03:50.000Z"), NOW),
  m.idle_handback(t(outcome="Changes requested"), ("parked", "2026-09-14T07:03:50.000Z"), NOW),
  m.idle_handback(t(), None, NOW),
  m.idle_handback(t(), ("intent", "2026-09-14T07:03:50.000Z"), NOW)]))`);
    expect(r).toEqual(['', '', '', '']);
  });

  it('the queue lists idle hand-backs with the reason and counts them apart from approvedHandbacks', () => {
    const fn = SRC.slice(SRC.indexOf('def build_queue('), SRC.indexOf('def cmd_queue('));
    expect(fn).toMatch(/t\["idleReason"\] = why/);
    expect(fn).toMatch(/"idleHandbacks": idle_hb,/);
    expect(fn).toMatch(/"idleHandbacks": len\(idle_hb\),/);
    // the rested tasks leave approved_hb BEFORE the worklist is chosen
    expect(fn.indexOf('approved_hb = [t for t in approved_hb if t["id"] not in idle_ids]'))
      .toBeLessThan(fn.indexOf('worklist = select_worklist('));
  });

  it('annotate records a PARKED or BLOCKED note in the ledger, so the rest has evidence', () => {
    const fn = SRC.slice(SRC.indexOf('def cmd_annotate('), SRC.indexOf('# ─── THE LEARNING LOOP'));
    expect(fn).toMatch(/PARKED_NOTE_RE\.match\(args\.note or ""\)/);
    expect(fn).toMatch(/ledger_append\(args\.task, "parked"\)/);
    const r = py(`print(json.dumps([bool(m.PARKED_NOTE_RE.match(s)) for s in ["PARKED run 2026: portal login", "BLOCKED: robot has no access", "CARRIED OUT (task left open): x", "Sent the email"]]))`);
    expect(r).toEqual([true, true, false, false]);
  });

  it('the poll prompt tells agents to open a sign-in note with PARKED:, so the convention is written down', () => {
    const runner = readFileSync(resolve(ROOT, 'scripts/handback-poll-run.sh'), 'utf8');
    expect(runner).toMatch(/OPENS with 'PARKED:'/);
  });

  it('the task view carries Approved At (the early-wake signal)', () => {
    expect(SRC).toMatch(/"approvedAt": f\.get\(AF\["approvedAt"\], ""\),/);
  });
});
