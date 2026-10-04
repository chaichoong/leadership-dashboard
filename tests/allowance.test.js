import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = resolve(ROOT, 'scripts/allowance.py');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// From 13:00 Fri 11 Sep 2026 to 19:00 Sun 13 Sep the Claude allowance was out.
// Every headless run started, printed "You've hit your limit · resets Sep 13 at
// 7pm (Europe/London)" and died; nine triage slots, nine board passes and 106
// hand-back polls were lost, and nothing re-ran them at the reset. The guard
// pauses the estate until the reset the message names, records the slots it
// skipped, and re-starts each once when the allowance is back.
describe('allowance.py', () => {
  it('passes its own selftest (three message shapes, latest reset wins, skip while paused, replay once in order, never itself)', () => {
    const out = JSON.parse(execFileSync('python3', [GUARD, 'selftest'], { encoding: 'utf8' }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(16);
  });

  // 4 Oct 2026: from Saturday 16:30 to Sunday 19:00 every run printed "You've hit your
  // WEEKLY limit". The guard looked for the exact phrase "hit your limit", so it never
  // paused, kept no missed list and re-ran nothing at the reset, and the Estate board
  // showed plain red. This drives the real matchers in all three scripts: the guard,
  // the Estate board and the attendance report (check-routines.py).
  const matchAll = (lines) => {
    const py = [
      'import importlib.util, json, sys',
      'from datetime import datetime, timezone',
      'def load(n, p):',
      '    s = importlib.util.spec_from_file_location(n, p); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m',
      `a = load('allowance', ${JSON.stringify(GUARD)})`,
      `e = load('estate_status', ${JSON.stringify(resolve(ROOT, 'scripts/estate-status.py'))})`,
      `c = load('check_routines', ${JSON.stringify(resolve(ROOT, 'scripts/check-routines.py'))})`,
      'now = datetime(2026, 10, 3, 15, 30, tzinfo=timezone.utc)',
      'out = []',
      'for line in json.loads(sys.argv[1]):',
      '    hit, reset = a.find_limit(line, now)',
      '    out.append({"guard": hit, "reset": reset and a.iso(reset), "board": e.blocked_reason(line), "attendance": bool(c.USAGE_CAP_RE.search(line))})',
      'print(json.dumps(out))',
    ].join('\n');
    return JSON.parse(execFileSync('python3', ['-c', py, JSON.stringify(lines)], { encoding: 'utf8' }));
  };

  it('the guard, the Estate board and the attendance report read every limit wording seen', () => {
    const lines = [
      "You've hit your limit · resets 7pm (Europe/London)",
      "You've hit your weekly limit · resets Oct 4 at 7pm (Europe/London)",
      'You’ve hit your weekly limit · resets 7pm (Europe/London)',
      '"api_error_status":429,"result":"You\'ve hit your weekly limit · resets 7pm (Europe/London)","type":"result"',
    ];
    matchAll(lines).forEach((r, i) => {
      expect(r.guard, `guard reads: ${lines[i]}`).toBe(true);
      expect(r.reset, `reset read: ${lines[i]}`).toBe(i === 1 ? '2026-10-04T18:00:00Z' : '2026-10-03T18:00:00Z');
      expect(r.board, `board reads: ${lines[i]}`).toMatch(/Claude allowance ran out/);
      expect(r.attendance, `attendance reads: ${lines[i]}`).toBe(true);
    });
  });

  // Review, 4 Oct 2026: a false match pauses EVERY robot (an hour, or until a quoted
  // reset), so agent prose that mentions a limit must never match in any of the three.
  it('agent prose that mentions a limit never pauses the robots', () => {
    const prose = [
      "Barclaycard email: You've hit your credit limit, resets on your statement date",
      "You've hit your credit limit on this card",
      'every run printed "You\'ve hit your weekly limit · resets 7pm (Europe/London)" and died',
      'Newsletter: when you hit your five-hour limit, Claude pauses',
      "You've hit your weekly\nlimit · resets 7pm",
    ];
    matchAll(prose).forEach((r, i) => {
      expect(r.guard, `guard ignores: ${prose[i]}`).toBe(false);
      expect(r.board, `board ignores: ${prose[i]}`).toBe('');
      expect(r.attendance, `attendance ignores: ${prose[i]}`).toBe(false);
    });
  });

  it('every Claude runner checks before the call and marks after it', () => {
    // the two slots the weekend outage lost most of have their OWN runners (review, 14 Sep 2026)
    for (const f of ['scripts/agent-slot-run.sh', 'scripts/handback-poll-run.sh', 'scripts/task-manager-run.sh', 'scripts/inbound-triage-run.sh']) {
      const src = read(f);
      const check = src.indexOf('allowance.py" check --job');
      const claude = src.indexOf('"$CLAUDE" -p');
      const mark = src.indexOf('allowance.py" mark --job');
      expect(check, `${f} checks the allowance`).toBeGreaterThan(-1);
      expect(check, `${f} checks BEFORE the Claude call`).toBeLessThan(claude);
      expect(mark, `${f} marks AFTER the Claude call`).toBeGreaterThan(claude);
    }
    // a paused slot is not a broken job: exit 0, and the runner's own done line is written
    expect(read('scripts/agent-slot-run.sh')).toMatch(/PAUSED: the Claude allowance is out; queued to re-run at reset/);
    expect(read('scripts/handback-poll-run.sh')).toMatch(/beat skip "the Claude allowance is out; paused"/);
  });

  it("the Content Engine's two Claude-calling steps go through run_guarded", () => {
    for (const f of ['scripts/content-engine/platform_copy.py', 'scripts/content-engine/thumbnail.py']) {
      const src = read(f);
      expect(src, `${f} uses the guard`).toMatch(/_allowance\(\)\.run_guarded\("content-engine"/);
      expect(src, `${f} has no bare claude call left`).not.toMatch(/subprocess\.run\(\[CLAUDE/);
    }
  });

  it('the Estate status board carries the allowance as its own row and runs the replay', () => {
    const src = read('scripts/estate-status.py');
    expect(src).toMatch(/def allowance_row\(now\)/);
    expect(src).toMatch(/al\.cmd_replay\(now=now\)/);
    expect(src).toMatch(/rows\.append\(allowance_row\(now\)\)/);
    const page = read('os/agents/index.html');
    expect(page).toMatch(/gf\(r,'key'\) === 'allowance'/);
    expect(page).toMatch(/Agents paused\./);
  });

  // ── Finding 20260923-daily-ops-577 ────────────────────────────────────
  // The Content Engine's copy and thumbnail steps raised
  //   SystemExit("claude failed: " + r.stderr[-400:])
  // while running the CLI with --output-format json. That flag makes the CLI
  // write its error object to STDOUT, so stderr was empty and the 02:25 run on
  // 23 Sep 2026 died with the literal line "claude failed: " — nothing after
  // the colon, and a night of episodes abandoned with no diagnosable cause.
  //
  // These drive the real helper rather than reading the source, because the bug
  // was never in what the code said, it was in which stream it read.
  describe('a failed claude call always says what went wrong (577)', () => {
    const fmt = (stdout, stderr, rc) => {
      const py = [
        'import importlib.util, json, sys',
        `spec=importlib.util.spec_from_file_location('a', ${JSON.stringify(GUARD)})`,
        'a=importlib.util.module_from_spec(spec); spec.loader.exec_module(a)',
        'class R: pass',
        'r=R()',
        `r.stdout=json.loads(${JSON.stringify(JSON.stringify(stdout))})`,
        `r.stderr=json.loads(${JSON.stringify(JSON.stringify(stderr))})`,
        `r.returncode=${rc}`,
        'print(a.claude_error(r))',
      ].join('\n');
      return execFileSync('python3', ['-c', py], { encoding: 'utf8' }).trim();
    };

    it('reads STDOUT, which is where --output-format json puts the error', () => {
      const msg = fmt('{"type":"result","is_error":true,"result":"Credit balance is too low"}', '', 1);
      expect(msg).toContain('Credit balance is too low');
      expect(msg).toContain('exit 1');
    });

    it('still reads stderr when that is where the text landed', () => {
      const msg = fmt('', 'Error: connection reset by peer', 1);
      expect(msg).toContain('connection reset by peer');
    });

    // The actual 23 Sep failure shape. The old line produced "claude failed: "
    // and stopped there; nothing in the log said even that the process was mute.
    it('never comes out blank when the process said nothing at all', () => {
      const msg = fmt('', '', 143);
      expect(msg).toContain('no output on stdout or stderr');
      expect(msg).toContain('exit 143');
      expect(msg.replace(/claude failed[^a-z]*/i, '').trim().length).toBeGreaterThan(0);
    });

    // CONTROL. Without this the three above would pass against a helper that
    // exists but is wired to nothing, which is exactly the state that let the
    // blank message ship.
    it('both Content Engine call sites use it, and neither reads stderr alone', () => {
      for (const f of ['scripts/content-engine/platform_copy.py',
                       'scripts/content-engine/thumbnail.py']) {
        const src = read(f);
        expect(src, `${f} must raise through the shared formatter`)
          .toMatch(/SystemExit\(_allowance\(\)\.claude_error\(r\)\)/);
        expect(src, `${f} still has a stderr-only claude failure message`)
          .not.toMatch(/"claude failed: " \+ r\.stderr/);
      }
    });
  });
});
