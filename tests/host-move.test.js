import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts/host-move.py');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// 24 Sep 2026: the estate moves from the MacBook Air to a new Mac mini by
// Migration Assistant. The copy carries every LaunchAgent, and job-queue.py's
// lock lives on one machine, so a live copy fires every job twice. host-move.py
// pauses the jobs on the old Mac before the copy and resumes them on the new one
// after it, and refuses to resume on the Mac they were paused on.
describe('host-move.py', () => {
  it('passes its own selftest (discovery, empty-estate control, wait for running jobs, pause, same-Mac refusal, missing-path refusal, resume, rollback, retry after a part-failed resume)', () => {
    const out = JSON.parse(execFileSync('python3', [SCRIPT, 'selftest'], { encoding: 'utf8' }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(26);
  });

  it('refuses to run anywhere but a Mac rather than guessing', () => {
    if (process.platform === 'darwin') return;
    let code = 0;
    try {
      execFileSync('python3', [SCRIPT, 'plan'], { encoding: 'utf8' });
    } catch (e) {
      code = e.status;
    }
    expect(code).toBe(2);
  });

  it('the runbook pauses on the Air BEFORE Migration Assistant and resumes on the mini after it', () => {
    const doc = read('docs/mac-mini-host-move.md');
    const pause = doc.indexOf('host-move.py pause');
    const migrate = doc.indexOf('open **Migration Assistant**');
    const resume = doc.indexOf('host-move.py resume`');
    expect(pause, 'runbook runs pause').toBeGreaterThan(-1);
    expect(migrate, 'runbook opens Migration Assistant').toBeGreaterThan(-1);
    expect(pause, 'pause comes before the copy').toBeLessThan(migrate);
    expect(migrate, 'resume comes after the copy').toBeLessThan(resume);
    expect(doc).toMatch(/do not create an account/i);
  });

  it('knows the estate label prefixes the installer and masterplan-sync use', () => {
    const src = read('scripts/host-move.py');
    expect(src).toMatch(/"com\.kevinbrittain\."/);
    expect(src).toMatch(/"com\.od\."/);
    expect(read('scripts/install-slot-jobs.sh')).toMatch(/com\.kevinbrittain\.\$name/);
  });
});
