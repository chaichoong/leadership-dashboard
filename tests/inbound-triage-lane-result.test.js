// A SLOT THAT FIRED IS NOT A SLOT THAT WORKED.
//
// Finding 20260906-daily-ops-477. On 5 Sep 2026 the inbound-triage 13:00 and
// 17:00 slots both fired, both scanned ZERO emails because the shared daily
// Gmail quota was gone (HTTP 403), and both left a normal `acquired` event in
// the queue log. check-routines.py graded the day "inbound-triage 3 of 3" off
// those events, and no email had been triaged since 3 Sep. Nothing anywhere
// said the email lane was dead — the only record was the word BROKEN inside a
// paragraph of the agent's prose report, which nothing parses.
//
// Two halves are tested here:
//   1. inbound-triage.py writes a machine-readable verdict per lane per slot,
//      and escalates (exit 3) once a lane has been broken two slots running.
//   2. check-routines.py grades on THAT, and a missing results file reads as
//      UNCHECKED rather than as clean.

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TRIAGE = resolve(__dirname, '../scripts/inbound-triage.py');
const GUARD = resolve(__dirname, '../scripts/check-routines.py');
const ROOT = mkdtempSync(join(tmpdir(), 'lane-result-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function run(script, args, env = {}) {
  try {
    return { code: 0, out: execFileSync('python3', [script, ...args], {
      encoding: 'utf8', env: { ...process.env, ...env },
    }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function box(name) {
  const d = join(ROOT, name);
  mkdirSync(d, { recursive: true });
  return d;
}

function record(dir, slot, status, reason = '') {
  return run(TRIAGE, ['slot-record', '--slot', slot, '--lane', 'email',
    '--status', status, '--reason', reason], { INBOUND_TRIAGE_DIR: dir });
}

function verify(dir, slot, sinceMs) {
  return run(TRIAGE, ['slot-verify', '--slot', slot, '--lane', 'email',
    '--since-ms', String(sinceMs)], { INBOUND_TRIAGE_DIR: dir });
}

// The only honest evidence that the email lane WORKED. cmd_scan stamps it when
// it reaches the end; writing it here is how a test says "a scan completed at T".
// `workMs` is the watermark, which `mark` moves only after the agent has
// handled mail. From finding 637 (27 Sep 2026) a completed scan alone is no
// longer enough for a slot to pass: it must also show work. Tests that mean
// "this slot worked" pass a watermark at or after the slot start.
function stampScan(dir, ms, workMs = null) {
  const st = ms === null ? {} : { last_scan_ok_ms: ms };
  if (workMs !== null) st.watermark_ms = workMs;
  writeFileSync(join(dir, 'state.json'), JSON.stringify(st));
}

function rowsOf(dir) {
  return readFileSync(join(dir, 'slot-results.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
}

describe('inbound-triage per-slot lane result', () => {
  it('BACK-TEST 5 Sep 2026: the two quota slots both grade as failed', () => {
    const d = box('sep5');
    expect(record(d, '09:00', 'ok').code).toBe(0);
    // 13:00 and 17:00 — both fired, both scanned nothing.
    expect(record(d, '13:00', 'broken', 'quota').code).toBe(0);
    expect(record(d, '17:00', 'broken', 'quota').code).toBe(3); // ESCALATE

    const rows = readFileSync(join(d, 'slot-results.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.ok === false)).toHaveLength(2);
    // The verdict is a field, not a word inside a sentence.
    expect(rows[2]).toMatchObject({ lane: 'email', ok: false, reason: 'quota' });
  });

  it('one good slot clears the escalation run', () => {
    const d = box('recovers');
    record(d, '09:00', 'broken', 'quota');
    expect(record(d, '13:00', 'broken', 'quota').code).toBe(3);
    expect(record(d, '17:00', 'ok').code).toBe(0);
    expect(record(d, '09:00', 'broken', 'quota').code).toBe(0); // run restarted
  });

  it('the health probe is the SMALLEST worker call, never a scan', () => {
    // Probing with a scan would spend the quota the probe exists to check for.
    const src = readFileSync(TRIAGE, 'utf8');
    const health = src.slice(src.indexOf('def cmd_health'), src.indexOf('def cmd_search'));
    expect(health).toMatch(/worker_labels\(\)/);
    expect(health).not.toMatch(/worker_list\(/);
  });

  it('a quota failure carries a machine-readable kind, not just prose', () => {
    const src = readFileSync(TRIAGE, 'utf8');
    expect(src).toMatch(/kind="quota"/);
    expect(src).toMatch(/kind="auth"/);
  });
});

// FINDING 20260907-daily-ops-488 — the CAUSE behind the broken slots above.
//
// The 444 fix taught the classifier to tell a rate limit from the day's quota,
// and put "quota exceeded for quota metric" on the fatal side. Google uses that
// same sentence for its PER-MINUTE metric, so the 3, 5 and 6 Sep slots each
// abandoned the whole email lane over a limit that refills in sixty seconds.
// Four days of mail went untriaged. Verified read-only on 7 Sep: Gmail answers
// normally, so nothing was ever exhausted on Google's side.
describe('a per-minute Gmail metric is a wait, not the day being over', () => {
  // The literal body the worker forwarded, re-wrapped from Google's own JSON.
  const PER_MINUTE = "Gmail list failed: {\"error\":{\"code\":403,\"message\":\"Quota "
    + "exceeded for quota metric 'Gmail API units per minute per user' and limit "
    + "'Gmail API units per minute per user' of service 'gmail.googleapis.com' "
    + "for consumer 'project_number:815949125083'\"}}";

  function classify(code, body) {
    const src = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('t', ${JSON.stringify(TRIAGE)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(list(m.classify_worker_error(${code}, ${JSON.stringify(body)}))))
`;
    return JSON.parse(execFileSync('python3', ['-c', src], { encoding: 'utf8' }).trim());
  }

  it('BACK-TEST 6 Sep: the exact error that killed the slot now waits instead', () => {
    expect(classify(500, PER_MINUTE)[0]).toBe('slowdown');
    expect(classify(403, PER_MINUTE)[0]).toBe('slowdown');
  });

  it('CONTROL: a genuinely DAILY limit still stops the run', () => {
    // Without this the fix could simply never stop, and burning the next two
    // slots on a real daily exhaustion is the bug 444 existed to fix.
    expect(classify(500, 'reason":"dailyLimitExceeded"')[0]).toBe('quota');
    expect(classify(500, "Quota exceeded for quota metric 'Queries per day'")[0]).toBe('quota');
  });

  it('waits longer than one metric window, and caps what a run may spend waiting', () => {
    const src = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('t', ${JSON.stringify(TRIAGE)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.SHORT_WINDOW_WAIT_SECONDS, m.MAX_SLOWDOWN_SECONDS]))
`;
    const [wait, cap] = JSON.parse(execFileSync('python3', ['-c', src], { encoding: 'utf8' }).trim());
    expect(wait).toBeGreaterThan(60);   // a per-minute metric refills on the minute
    expect(cap).toBeLessThanOrEqual(900); // a slot must not become an hour of sleeping
  });
});

// Shared by both grading describes below.
const routineDir = box('routines');
mkdirSync(join(routineDir, 'daily-ops'), { recursive: true });
writeFileSync(join(routineDir, 'daily-ops', 'SKILL.md'), '# daily-ops\n');

// THE SECOND HALF, FOUND THE DAY AFTER THE FIRST WAS FIXED.
//
// Finding 20260907-daily-ops-487. The fix above records a verdict from a
// pre-flight `labels` probe, BEFORE the agent runs. That probe is deliberately
// the smallest call the worker exposes — and it is small enough to succeed on a
// day whose remaining quota cannot carry a full scan. On 6 Sep 2026 both slots
// therefore wrote `ok: true`, the scan died on a 403 mid-run, no digest has been
// written since 3 Sep, and check-routines graded the lane CLEAN off the very
// file built to stop exactly this. A verdict written before the work is a
// forecast; the slot must also record the outcome.
describe('a pre-flight ok is superseded when no scan completed', () => {
  it('BACK-TEST 6 Sep 2026: two ok slots whose scans never ran grade as broken', () => {
    const d = box('sep6');
    const t0 = Date.now();
    // Exactly what the file held on the morning of 7 Sep: two ok lines.
    record(d, '13:00', 'ok', 'ok');
    stampScan(d, t0 - 3 * 86400_000);     // last completed scan was 3 Sep
    expect(verify(d, '13:00', t0).code).toBe(0);
    record(d, '17:00', 'ok', 'ok');
    stampScan(d, t0 - 3 * 86400_000);
    // Two slots broken in a row is the escalation, and it must fire here.
    expect(verify(d, '17:00', t0).code).toBe(3);

    const rows = rowsOf(d);
    expect(rows).toHaveLength(4);         // append-only: the forecast is kept
    expect(rows.filter((r) => r.reason === 'scan-did-not-complete')).toHaveLength(2);
  });

  it('leaves a slot alone when a scan really did complete inside it', () => {
    // CONTROL. Without this the corrector could simply mark everything broken
    // and both assertions above would still pass.
    const d = box('sep6-good');
    const t0 = Date.now();
    record(d, '13:00', 'ok', 'ok');
    // The scan finished after the slot began AND the slot did work: the
    // watermark moved. Finding 637 made the second half load-bearing.
    stampScan(d, t0 + 5000, t0 + 5000);
    const r = verify(d, '13:00', t0);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).changed).toBe(false);
    expect(rowsOf(d)).toHaveLength(1);
  });

  it('a slot already recorded broken is not double-counted', () => {
    const d = box('sep6-broken');
    const t0 = Date.now();
    record(d, '13:00', 'broken', 'quota');
    stampScan(d, null);
    expect(verify(d, '13:00', t0).code).toBe(0);
    expect(rowsOf(d)).toHaveLength(1);
  });

  it('the corrected verdict REPLACES the slot for grading, never adds one', () => {
    // Straight at the grader: 3 slots recorded ok, all 3 corrected. If the
    // grader counted lines it would read 6 slots, 3 of them good.
    const d = box('sep6-graded');
    const t0 = Date.now();
    for (const slot of ['09:00', '13:00', '17:00']) {
      record(d, slot, 'ok', 'ok');
      stampScan(d, t0 - 86400_000);
      verify(d, slot, t0);
    }
    const events = join(ROOT, 'events-sep6.jsonl');
    const now = new Date();
    const rows = [1, 5, 9].map((h) => JSON.stringify({
      ts: new Date(now - h * 3600_000).toISOString().replace('Z', '') + 'Z',
      job: 'inbound-triage', state: 'acquired' }));
    writeFileSync(events, rows.join('\n') + '\n');
    const res = JSON.parse(run(GUARD, ['--json'], {
      JOB_QUEUE_EVENTS: events, CLAUDE_ROUTINE_DIR: routineDir, INBOUND_TRIAGE_DIR: d,
    }).out);
    const lane = res.lane_health['inbound-triage'].email;
    expect(lane).toMatchObject({ slots: 3, ok: 0, broken: 3 });
    expect(res.broken_lanes.join(' ')).toMatch(/email lane: 0 of 3 slots worked/);
  });
});

describe('check-routines grades the lane, not the run marker', () => {
  function guard(laneDir) {
    const events = join(ROOT, 'events.jsonl');
    const now = new Date();
    const rows = [];
    for (const h of [1, 5, 9]) {
      const ts = new Date(now - h * 3600_000).toISOString().replace('Z', '') + 'Z';
      rows.push({ ts, job: 'inbound-triage', state: 'acquired' });
    }
    rows.push({ ts: new Date(now - 2 * 3600_000).toISOString().replace('Z', '') + 'Z',
      job: 'daily-ops', state: 'mark' });
    writeFileSync(events, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return run(GUARD, ['--json'], {
      JOB_QUEUE_EVENTS: events,
      CLAUDE_ROUTINE_DIR: routineDir,
      INBOUND_TRIAGE_DIR: laneDir,
    });
  }

  it('three fired slots with a broken email lane are NOT reported as three good slots', () => {
    const d = box('graded');
    record(d, '09:00', 'ok');
    record(d, '13:00', 'broken', 'quota');
    record(d, '17:00', 'broken', 'quota');

    const r = guard(d);
    const res = JSON.parse(r.out);
    const lane = res.lane_health['inbound-triage'].email;
    expect(lane).toMatchObject({ slots: 3, ok: 1, broken: 2 });
    expect(lane.consecutive_broken).toBeGreaterThanOrEqual(2);
    expect(res.broken_lanes.join(' ')).toMatch(/email lane: 1 of 3 slots worked/);
    expect(res.broken_lanes.join(' ')).toMatch(/ESCALATE/);
  });

  it('a clean day reports no broken lane at all', () => {
    const d = box('clean');
    record(d, '09:00', 'ok');
    record(d, '13:00', 'ok');
    record(d, '17:00', 'ok');
    const res = JSON.parse(guard(d).out);
    expect(res.broken_lanes).toEqual([]);
  });

  it('CONTROL: a missing results file is UNCHECKED, never clean', () => {
    // The failure this whole finding is about was silence reading as success.
    const res = JSON.parse(guard(box('empty')).out);
    expect(res.broken_lanes.join(' ')).toMatch(/UNCHECKED, not clean/);
  });

  it('the selftest that back-tests 5 Sep still passes in full', () => {
    const r = run(TRIAGE, ['selftest'], { INBOUND_TRIAGE_DIR: box('selftest') });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/selftest OK/);
  });
});

// FINDING 20260904-daily-ops-451, the other half of the same silence: a slot
// whose email triage was BROKEN still exited 0, so run-job.sh recorded a
// success and job-failures.log stayed empty. The wrapper now writes an
// EMAIL LANE BROKEN line into runs.log before the agent starts, and the shared
// epilogue turns any failure marker in the tail into a non-zero exit. Tested
// through slot-postrun.sh itself rather than by reading the wrapper's source,
// because the coupling that matters is the marker matching the BAD pattern the
// wrapper actually passes.
describe('a broken email lane makes the slot exit non-zero (finding 451)', () => {
  const POSTRUN = resolve(__dirname, '../scripts/slot-postrun.sh');

  // The exact patterns inbound-triage-run.sh hands slot-postrun.sh. The
  // trailing-backslash strip matters: on 16 Sep 2026 a ninth argument was added
  // (the TOLERATED list, finding 20260915-daily-ops-exceptions-531), which put a
  // line continuation on the end of the marker line. Without the strip this
  // helper fed grep a pattern ending in `\` — grep errored, nothing matched, and
  // this test reported "the epilogue does not treat a broken lane as a failure"
  // when the only broken thing was the extraction.
  const WRAPPER = readFileSync(resolve(__dirname, '../scripts/inbound-triage-run.sh'), 'utf8');
  const quoted = (needle) => WRAPPER.split('\n')
    .filter((l) => l.includes(needle)).pop()
    .replace(/\\\s*$/, '')
    .replace(/^\s*'|'\s*$/g, '');
  const BAD_ERE = quoted('OAuth access token has expired');
  const TOLERATED_ERE = quoted('GMAIL RATE METRIC STILL FULL');

  function postrun(tail, rc = 0) {
    const d = box('postrun-' + Math.random().toString(36).slice(2));
    execFileSync('git', ['-C', d, 'init', '-q']);
    mkdirSync(join(d, 'monitoring'), { recursive: true });
    const scratch = join(d, 'scratch');
    mkdirSync(scratch, { recursive: true });
    const log = join(d, 'runs.log');
    writeFileSync(log, '===== run start =====\n' + tail);
    const marker = join(d, '.marker');
    writeFileSync(marker, '');
    try {
      execFileSync('bash', [POSTRUN, 'inbound-triage', String(rc), log, '1',
        marker, scratch, '"body" *:', BAD_ERE, TOLERATED_ERE],
      { encoding: 'utf8', env: { ...process.env, SLOT_POSTRUN_REPO: d } });
      return 0;
    } catch (e) {
      return e.status;
    }
  }

  it('the wrapper writes a line the shared epilogue treats as a failure', () => {
    // The literal line inbound-triage-run.sh writes when the probe says broken.
    expect(postrun('EMAIL LANE BROKEN (quota) — skill 1 skipped this slot\n'))
      .not.toBe(0);
  });

  it('the extracted patterns are usable regexes, not shell fragments', () => {
    // The guard for the bug this helper hit: a pattern that ends in a line
    // continuation makes grep error out and every match silently disappear.
    expect(BAD_ERE.endsWith('\\')).toBe(false);
    expect(TOLERATED_ERE).toBe('GMAIL RATE METRIC STILL FULL');
    expect(BAD_ERE).toContain('"error"');
  });

  it('CONTROL: a clean tail still exits 0, so this is not a blanket failure', () => {
    expect(postrun('Email: 14 scanned / 3 tasked / 9 archived\n')).toBe(0);
  });
});

// ─── A COMPLETED SCAN IS NOT A DECIDED INBOX (finding 637) ───────────
//
// 26 Sep 2026. The 13:00 slot broke correctly on a Gmail 403 and left the
// watermark alone, so the backlog fell to 17:00. The 17:00 slot recorded
// ok:true, slot-verify confirmed "a scan completed at 1790438627348",
// reported changed:false, and ended 4m33s later having written ZERO digest
// lines. Seven messages that arrived between 09:12 and 17:00 were never
// triaged; the next slot was 09:00 the following day.
//
// Back-tested against the real slot-results.jsonl and digest files for 6-26
// Sep, 62 email slots: 55 ok slots wrote 9 to 398 digest lines, and exactly
// five ok slots wrote zero — 6 Sep 13:00 and 17:00 (the incident finding 487
// was filed for), 7 Sep 17:00, 25 Sep 13:00 and 26 Sep 17:00. It discriminates.
describe('a slot that scanned and decided nothing is broken', () => {
  const START = 1_790_437_200_000;          // 26 Sep 2026, 17:00 local
  const SCANNED_AT = 1_790_438_627_348;     // the real stamp that slot wrote
  const MORNING_WATERMARK = 1_790_409_663_014;

  function state(dir, obj) {
    writeFileSync(join(dir, 'state.json'), JSON.stringify(obj));
  }
  function digestLine(dir, iso) {
    const day = iso.slice(0, 10);
    writeFileSync(join(dir, `digest-${day}.jsonl`),
      JSON.stringify({ id: 'm1', do: 'archive', ts: iso }) + '\n');
  }
  function last(dir) {
    const rows = readFileSync(join(dir, 'slot-results.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    return rows[rows.length - 1];
  }

  it('grades the real 26 Sep 17:00 shape as broken, naming what it measured', () => {
    const d = box('decided-nothing');
    state(d, { last_scan_ok_ms: SCANNED_AT, watermark_ms: MORNING_WATERMARK });
    record(d, '17:00', 'ok');
    verify(d, '17:00', START);
    expect(last(d).ok).toBe(false);
    expect(last(d).reason).toMatch(/scanned-but-decided-nothing/);
    expect(last(d).reason).toMatch(/0 digest lines/);
  });

  it('BACK-TEST: under the old scan-stamp-only rule that slot read clean', () => {
    // The stamp is genuinely newer than the slot start, which is the whole
    // reason the old check passed it. Proving that here stops anyone reading
    // the fix as "the stamp was wrong".
    expect(SCANNED_AT).toBeGreaterThan(START);
  });

  it('CONTROL: the same slot with one decision written passes', () => {
    const d = box('decided-something');
    state(d, { last_scan_ok_ms: SCANNED_AT, watermark_ms: MORNING_WATERMARK });
    // digest_append writes a LOCAL naive timestamp, and the slot start is read
    // back as local too, so the fixture is written in local time. A UTC string
    // here reads an hour early under BST and the line falls outside the window.
    digestLine(d, '2026-09-26T17:01:00');
    record(d, '17:00', 'ok');
    const r = verify(d, '17:00', START);
    expect(last(d).ok).toBe(true);
    expect(r.out).toMatch(/decisions were written/);
  });

  it('CONTROL: a slot that advanced the watermark passes with no digest line', () => {
    const d = box('watermark-moved');
    state(d, { last_scan_ok_ms: SCANNED_AT, watermark_ms: START + 60_000 });
    record(d, '17:00', 'ok');
    verify(d, '17:00', START);
    expect(last(d).ok).toBe(true);
  });

  it('a scan that never completed is still reported as that, not as the new fault', () => {
    const d = box('scan-still-first');
    state(d, { last_scan_ok_ms: START - 60_000, watermark_ms: MORNING_WATERMARK });
    record(d, '17:00', 'ok');
    verify(d, '17:00', START);
    expect(last(d).reason).toBe('scan-did-not-complete');
  });

  it('two silent slots running escalate, exactly as a broken lane does', () => {
    const d = box('silent-escalates');
    state(d, { last_scan_ok_ms: SCANNED_AT, watermark_ms: MORNING_WATERMARK });
    record(d, '13:00', 'ok');
    verify(d, '13:00', START);
    record(d, '17:00', 'ok');
    expect(verify(d, '17:00', START).code).toBe(3);
  });
});
