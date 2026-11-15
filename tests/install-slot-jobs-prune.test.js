// --prune on the launchd installer (finding 20261031-agent-dispatch-1149).
//
// --install only ever touches the jobs in the installer's own JOBS array, so a job Kevin
// retires keeps its plist and keeps firing. feed-brain was retired on 14 Oct 2026 and its
// own schedule note said "launchd job unloaded, plist in ~/Library/LaunchAgents.parked/";
// on 15 Nov 2026 it was still in LaunchAgents and still loaded, 32 days later. Nothing
// errored, because a loaded plist cannot know it was retired.
//
// This drives the real bash with every write path pointed at a scratch folder and a stub
// launchctl, so it never touches the real LaunchAgents folder and never unloads a real job.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/install-slot-jobs.sh');
const ROOT = mkdtempSync(join(tmpdir(), 'slotprune-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let box; let la; let parked; let schedule; let stub; let calls;
let n = 0;
beforeEach(() => {
  box = join(ROOT, String(++n));
  la = join(box, 'LaunchAgents');
  parked = join(box, 'LaunchAgents.parked');
  schedule = join(box, 'job-schedule.json');
  stub = join(box, 'launchctl');
  calls = join(box, 'launchctl-calls.txt');
  mkdirSync(la, { recursive: true });
  writeFileSync(stub, `#!/bin/bash\necho "$@" >> ${calls}\nexit 0\n`, { mode: 0o755 });
});

const plist = (name) => writeFileSync(join(la, `com.kevinbrittain.${name}.plist`), '<plist/>\n');

function prune(mode = '--prune') {
  const r = spawnSync('bash', [SCRIPT, mode], {
    encoding: 'utf8',
    env: {
      ...process.env, LA_DIR: la, LA_PARKED: parked, JOB_SCHEDULE: schedule, LAUNCHCTL_BIN: stub,
    },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('install-slot-jobs.sh --prune', () => {
  // THE REGRESSION: a retired job's plist is unloaded and parked.
  it('parks the plist of a job marked enabled:false and absent from JOBS', () => {
    writeFileSync(schedule, JSON.stringify({ 'feed-brain': { enabled: false } }));
    plist('feed-brain');
    const r = prune();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/parked\s+com\.kevinbrittain\.feed-brain/);
    expect(existsSync(join(la, 'com.kevinbrittain.feed-brain.plist')),
      'the plist is still in LaunchAgents').toBe(false);
    expect(existsSync(join(parked, 'com.kevinbrittain.feed-brain.plist')),
      'the plist was not parked').toBe(true);
    expect(readFileSync(calls, 'utf8'), 'launchctl unload was never called').toMatch(/unload/);
  });

  // CONTROL: the same run must refuse to touch a job that is still live.
  it('leaves a job the schedule still has enabled, and never unloads it', () => {
    writeFileSync(schedule, JSON.stringify({ 'content-engine': { enabled: true } }));
    plist('content-engine');
    const r = prune();
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(la, 'com.kevinbrittain.content-engine.plist')),
      'a LIVE job was parked').toBe(true);
    expect(existsSync(calls), 'launchctl was called for a live job').toBe(false);
    expect(r.out).toMatch(/left alone: 1 live/);
  });

  it('leaves a plist the schedule has never heard of, and says so', () => {
    writeFileSync(schedule, JSON.stringify({}));
    plist('stay-awake');
    const r = prune();
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(la, 'com.kevinbrittain.stay-awake.plist'))).toBe(true);
    expect(r.out).toMatch(/not in job-schedule\.json at all/);
  });

  it('never touches a job that IS in the installer\'s JOBS array', () => {
    // ceo-agent is installed by this very script, so it is live by definition.
    writeFileSync(schedule, JSON.stringify({ 'ceo-agent': { enabled: false } }));
    plist('ceo-agent');
    const r = prune();
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(la, 'com.kevinbrittain.ceo-agent.plist')),
      'a job this installer owns was parked').toBe(true);
  });

  it('--prune-check reports and changes nothing', () => {
    writeFileSync(schedule, JSON.stringify({ 'feed-brain': { enabled: false } }));
    plist('feed-brain');
    const r = prune('--prune-check');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/would park/);
    expect(existsSync(join(la, 'com.kevinbrittain.feed-brain.plist'))).toBe(true);
    expect(existsSync(parked)).toBe(false);
    expect(existsSync(calls)).toBe(false);
  });

  it('says plainly when there is nothing to park', () => {
    // A prune that prints nothing reads like a clean estate.
    writeFileSync(schedule, JSON.stringify({}));
    const r = prune();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/no retired plist to park/);
    expect(readdirSync(la)).toEqual([]);
  });

  // --only (finding 20261111-agent-dispatch-1296). A bare --install unloads and reloads
  // every job, and launchctl unload on a RUNNING job kills it, so reinstalling one plist
  // in the morning was not safe to ask a routine to do.
  describe('--only narrows the run to one job', () => {
    const dry = (args) => {
      const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
      return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
    };

    it('--dry-run --only writes one job to stdout and no other', () => {
      const one = dry(['--dry-run', '--only', 'prod-sweep-weekly']);
      expect(one.code, one.out).toBe(0);
      expect((one.out.match(/^=== /gm) || []).length, 'more than one job was printed').toBe(1);
      expect(one.out).toMatch(/com\.kevinbrittain\.prod-sweep-weekly\.plist/);
      // CONTROL: without --only the same command prints every job.
      const all = dry(['--dry-run']);
      expect((all.out.match(/^=== /gm) || []).length).toBeGreaterThan(1);
    });

    it('prod-sweep-weekly is written with its Sunday, not every day', () => {
      // The installed plist had Hour 11 and no Weekday, so launchd fired the slot daily
      // and the skill stopped at step one on the other six days.
      const r = dry(['--dry-run', '--only', 'prod-sweep-weekly']);
      expect(r.out).toMatch(/<key>Weekday<\/key><integer>0<\/integer>/);
    });

    it('a name that matches nothing fails loudly rather than doing nothing', () => {
      const r = dry(['--dry-run', '--only', 'no-such-job']);
      expect(r.code, 'a typo read as success').toBe(1);
      expect(r.out).toMatch(/NO SUCH JOB/);
    });

    it('--only with no name is refused', () => {
      const r = dry(['--install', '--only']);
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/--only needs a job name/);
    });
  });

  it('an unreadable schedule parks nothing', () => {
    writeFileSync(schedule, 'not json');
    plist('feed-brain');
    const r = prune();
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(la, 'com.kevinbrittain.feed-brain.plist')),
      'an unreadable schedule was treated as a retirement').toBe(true);
    expect(r.out).toMatch(/could not be judged/);
  });
});
