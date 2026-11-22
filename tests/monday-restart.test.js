import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

// scripts/monday-restart.sh restarts the Mac that runs the whole estate (Kevin, 22 Nov
// 2026). FileVault is on, so after a restart nothing runs until Kevin types his
// password. A restart at the wrong moment costs live work and a morning of jobs, so the
// rules are asserted here rather than trusted to review.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts/monday-restart.sh');
const src = readFileSync(SCRIPT, 'utf8');
const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const pick = (re) => src.match(re)[0];

const DAY = 86400;
const decide = (dow, hm, up, idle, bad = '', busy = '') =>
  execFileSync('bash', ['-c', `
    ${pick(/^MIN_UPTIME=\d+/m)}
    ${pick(/^MIN_IDLE=\d+/m)}
    ${pick(/^BUSY_DEADLINE=\d+/m)}
    ${pick(/decide \(\) \{[\s\S]*?\n\}/)}
    decide "$@"`, 'h', dow, hm, String(up), String(idle), bad, busy], { encoding: 'utf8' }).trim();

describe('monday-restart: when it restarts', () => {
  it('restarts on a quiet Monday morning after days switched on', () => {
    expect(decide('1', '0725', 3 * DAY, 3600)).toBe('RESTART');
    expect(decide('1', '0759', 3 * DAY, 3600)).toBe('RESTART');
    expect(decide('1', '0822', 3 * DAY, 3600)).toBe('RESTART');
  });

  it('never outside Monday 07:20-08:45', () => {
    for (const [dow, hm] of [['7', '0725'], ['2', '0725'], ['1', '0719'], ['1', '0846'], ['1', '1925'], ['1', '']]) {
      expect(decide(dow, hm, 3 * DAY, 3600)).toMatch(/^SKIP 0 outside the Monday/);
    }
  });

  it('never within 2 days of the last restart, so it cannot loop', () => {
    expect(decide('1', '0725', DAY, 3600)).toMatch(/^SKIP 0 the Mac was restarted 24 hours ago/);
  });

  it('never while someone is using the Mac', () => {
    expect(decide('1', '0725', 3 * DAY, 120)).toMatch(/^SKIP 0 someone used the Mac 2 minutes ago/);
  });

  // 22 Nov 2026: mac-guard and retry-deferred had broken launchd files since 16 Oct. launchd
  // kept running the copies it loaded at boot, so nobody saw it until a restart dropped them.
  it('refuses, and turns red, while any launchd file is broken', () => {
    expect(decide('1', '0725', 3 * DAY, 3600, 'com.kevinbrittain.mac-guard.plist'))
      .toMatch(/^SKIP 1 launchd file com\.kevinbrittain\.mac-guard\.plist is broken/);
  });

  it('waits for busy work, then skips the week at 08:45 rather than kill it', () => {
    expect(decide('1', '0730', 3 * DAY, 3600, '', 'content-engine')).toBe('WAIT content-engine is running');
    expect(decide('1', '0845', 3 * DAY, 3600, '', 'content-engine')).toMatch(/^SKIP 0 content-engine is still running at 08:45/);
  });

  it('skips, and turns red, on a reading it could not take', () => {
    expect(decide('1', '0725', '', 3600)).toMatch(/^SKIP 1 could not read how long/);
    expect(decide('1', '0725', 3 * DAY, '')).toMatch(/^SKIP 1 could not read when/);
  });
});

describe('monday-restart: readings and guard rails', () => {
  // The first version read "usec" as the boot time and put the boot in 1970, which made
  // every uptime enormous and silently disabled the login catch-up.
  it('reads the boot time from the seconds field, not microseconds', () => {
    const fn = pick(/boot_epoch \(\) \{[^\n]*\}/).replace('sysctl -n kern.boottime 2>/dev/null', 'echo "$SAMPLE"');
    const out = execFileSync('bash', ['-c', `${fn}\nboot_epoch`], {
      encoding: 'utf8',
      env: { ...process.env, SAMPLE: '{ sec = 1795350274, usec = 618988 } Sun Nov 22 12:24:34 2026' },
    }).trim();
    expect(out).toBe('1795350274');
  });

  // Review, 22 Nov 2026: daily-ops runs inside the Claude app, so a process check misses it,
  // and it was still running at 07:25 on each of the last four Mondays.
  describe('what counts as busy', () => {
    const busy = (rantoday, live = '', recent = '') => execFileSync('bash', ['-c', `
      HERE_DIR=/x
      python3 () { return "$RANTODAY"; }
      pgrep () { case "$*" in *run-job*) [ -n "$LIVE" ] && printf '%s\\n' "$LIVE";; *) return 1;; esac; }
      find () { [ -n "$RECENT" ] && echo /x/session.jsonl; return 0; }
      ${pick(/busy_work \(\) \{[\s\S]*?\n\}/)}
      busy_work`], { encoding: 'utf8', env: { ...process.env, RANTODAY: String(rantoday), LIVE: live, RECENT: recent } }).trim();
    const wrapped = (job) => `123 /bin/bash /Users/x/tools/run-job.sh ${job} /usr/bin/python3 /x/${job}.py`;

    it('waits for daily-ops until its end mark exists', () => expect(busy(0)).toBe('daily-ops'));
    it('treats a failed daily-ops check as still running', () => expect(busy(1)).toBe('daily-ops'));
    it('is clear once daily-ops has ended and nothing is running', () => expect(busy(3)).toBe(''));
    it('waits for any job under run-job.sh', () => expect(busy(3, wrapped('rent-check'))).toBe('rent-check'));
    it('waits for a Claude app session that wrote in the last 10 minutes', () =>
      expect(busy(3, '', 'yes')).toBe('a Claude session'));
    it('does not wait for its own wrapper', () => expect(busy(3, wrapped('monday-restart'))).toBe(''));
  });

  it('writes the marker after the VM stops, right before the restart command', () => {
    expect(code).toMatch(/still=\$\(busy_work\)[\s\S]*date \+%s > "\$STATE"\s*\n\s*say "  RESTART[^\n]*\n\s*if ! \/usr\/bin\/osascript/);
  });

  it('puts everything back at once if macOS refuses the restart command', () => {
    expect(code).toMatch(/if ! \/usr\/bin\/osascript[^\n]*\n\s*rm -f "\$STATE"\s*\n\s*vm_back_on[^\n]*\n\s*say "RESTART FAILED/);
  });

  // Review, 22 Nov 2026: the slowest real shutdown took 8.8 minutes. A shorter wait would
  // drop the marker mid-shutdown, and a marker kept after "restart it yourself" double-runs.
  it('holds the marker past the slowest shutdown, and clears it before telling Kevin', () => {
    const wait = Number(code.match(/sleep (\d+)\s*\n\s*rm -f "\$STATE"\s*\n\s*vm_back_on "\$vm_was_on"\s*\n\s*say "RESTART BLOCKED/)[1]);
    expect(wait).toBeGreaterThan(8.8 * 60);
  });

  it('re-reads whether Kevin has sat down on every pass after the VM stops', () => {
    const loop = code.slice(code.indexOf('idle=$(idle_s)'), code.indexOf('date +%s > "$STATE"'));
    expect(loop).toMatch(/\[ "\$idle" -lt "\$MIN_IDLE" \][\s\S]*vm_back_on[\s\S]*skip_week 0/);
    expect(loop).toMatch(/\[ "\$waited" -ge 180 \][\s\S]*vm_back_on[\s\S]*skip_week 0/);
  });

  // Review, 22 Nov 2026: a stalled Mac can wake from the wait at 14:00, or the next day.
  it('ends the week, and never restarts, once a wait overruns the deadline', () => {
    expect(code).not.toMatch(/HM_NOW=0845/);
    expect(code).toMatch(/DOW_NOW=\$\(date \+%u\); HM_NOW=\$\(date \+%H%M\)\s*\n\s*if \[ "\$DOW_NOW" != "1" \] \|\| \[ "\$\(\(10#\$HM_NOW\)\)" -gt "\$BUSY_DEADLINE" \]; then\s*\n\s*skip_week 0/);
  });

  it('turns red when a skipped restart has left the Mac on for two weeks', () => {
    expect(code).toMatch(/^OVERDUE_UPTIME=1209600/m);
    expect(code).toMatch(/"\$\{up:-0\}" -ge "\$OVERDUE_UPTIME"[\s\S]*?code=1/);
  });

  // A job firing in the 60 seconds after login ran by itself, and a RunAtLoad job started
  // at login. Counting either as "held up" would run a rent check or a send twice.
  it('never re-runs a job that already ran by itself at login', () => {
    expect(code).toMatch(/login=\$\(date \+%s\)\s*\n\s*\[ "\$DRY_RUN" -eq 0 \] && sleep 60/);
    expect(code).toMatch(/datetime\.fromtimestamp\(login\)/);
    expect(code).toMatch(/if label in started_at_login:\s*\n\s*continue/);
  });

  it('only lets a dry run pretend to be another day or time', () => {
    expect(code).toMatch(/if \[ "\$DRY_RUN" -eq 1 \]; then\s*\n\s*DOW_NOW=\$\{MONDAY_RESTART_DOW/);
    expect(code.match(/MONDAY_RESTART_(DOW|HM)/g)).toHaveLength(2);
  });

  it('needs no admin rights and changes no security setting', () => {
    expect(code).not.toMatch(/\bsudo\b|shutdown -r|fdesetup|pmset|autoLoginUser/);
    expect(code).toMatch(/tell application "System Events" to restart/);
  });

  it('shuts Home Assistant down cleanly, and turns it back on if the restart is refused', () => {
    expect(code).toMatch(/controlvm "\$VM_NAME" acpipowerbutton/);
    expect(code).toMatch(/vm_back_on \(\) \{[^}]*startvm "\$VM_NAME" --type headless/);
    expect(code).toMatch(/sleep 900\s*\n\s*rm -f "\$STATE"\s*\n\s*vm_back_on "\$vm_was_on"\s*\n\s*say "RESTART BLOCKED/);
  });
});

describe('monday-restart: dry runs change nothing', () => {
  let home;
  let agents;
  beforeAll(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mr-home-')));
    agents = join(home, 'Library', 'LaunchAgents');
    mkdirSync(agents, { recursive: true });
    mkdirSync(join(home, 'knowledge-os', 'logs'), { recursive: true });
    const plist = (job) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>com.kevinbrittain.${job}</string>
<key>ProgramArguments</key><array><string>/x/run-job.sh</string><string>${job}</string></array></dict></plist>`;
    writeFileSync(join(agents, 'com.kevinbrittain.rent-check.plist'), plist('rent-check'));
    writeFileSync(join(agents, 'com.kevinbrittain.estate-status.plist'),
      plist('estate-status').replace('</dict>', '<key>RunAtLoad</key><true/></dict>'));
  });
  afterAll(() => home && rmSync(home, { recursive: true, force: true }));

  const run = (env) => spawnSync('bash', [SCRIPT, '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, HOME: home, ...env },
  });

  it('on Monday 07:25 says what it would do, and writes nothing', () => {
    const r = run({ MONDAY_RESTART_DOW: '1', MONDAY_RESTART_HM: '0725' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/READINGS/);
    expect(r.stdout).toMatch(/^(SKIPPED: |WOULD RESTART now|  WAIT )/m);
    expect(existsSync(join(home, 'knowledge-os', 'logs', 'monday-restart.state'))).toBe(false);
    expect(existsSync(join(home, 'knowledge-os', 'logs', 'monday-restart.history.log'))).toBe(false);
  });

  it('after a restart, lists the held-up jobs it would re-run and leaves the marker', () => {
    const boot = Number(execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' }).match(/^\{ sec = (\d+)/)[1]);
    const state = join(home, 'knowledge-os', 'logs', 'monday-restart.state');
    writeFileSync(state, String(boot - 600));   // a restart asked for 10 minutes before this boot
    const r = run({ MONDAY_RESTART_STATE: state });
    expect(r.stdout).toMatch(/RESTARTED/);
    expect(r.stdout).toMatch(/WOULD RUN   rent-check \(was due at \d\d:\d\d\)/);
    expect(r.stdout).not.toMatch(/^\s+RAN /m);
    expect(r.stdout).not.toMatch(/WOULD RUN   estate-status/);   // RunAtLoad: it started by itself
    expect(existsSync(state)).toBe(true);
    rmSync(state);
  });

  // Review, 22 Nov 2026: a marker left by a killed script had no age limit, and a
  // five-day-old one re-ran 39 jobs at the next login.
  it('ignores an old marker, so a later restart re-runs nothing', () => {
    const boot = Number(execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' }).match(/^\{ sec = (\d+)/)[1]);
    const state = join(home, 'knowledge-os', 'logs', 'monday-restart.state');
    writeFileSync(state, String(boot - 5 * DAY));
    const r = run({ MONDAY_RESTART_STATE: state });
    expect(r.stdout).not.toMatch(/RESTARTED|WOULD RUN/);
    rmSync(state);
  });
});
