// The 26 Aug 2026 restructure: daily-ops stops doing the work.
//
// WHAT WAS MEASURED
//   Runtime, from the queue log's start/end marks: 2h31 (20 Aug), 3h25
//   (21 Aug), 4h45 (23 Aug), 6h43 (26 Aug, 06:05 to 12:49). The work that
//   touches money and people sat at the END of that.
//
//   Findings, over the 18 days to 26 Aug: 364 filed, 168 closed. Phase 8 fixed
//   at most ten a day against about twenty produced. Net +196, ending at 202
//   open. And the drain was not even ten — PRs #107, #110, #126 and #137 were
//   ALL open and unmerged while forty findings sat closed as "fixed" citing
//   them.
//
// THE SHAPE NOW. Mechanical work is a script. Role work is that role's slot.
// What is left here is: read the exceptions, drain the queue, send one report.
//
// These tests guard the joins between those pieces, because every one of them
// is a place where two lists can quietly stop agreeing and nothing errors.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
// Prose in these files is hard-wrapped, so a phrase that reads as one sentence
// is split across a newline in the source. Assert against the flowed text or
// the test fails on where the wrap happened to land.
const flowed = (p) => read(p).replace(/\s+/g, ' ');
const schedule = () => JSON.parse(read('scripts/job-schedule.json'));

function approvedSlots() {
  const src = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('cr', ${JSON.stringify(join(ROOT, 'scripts/check-routines.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.APPROVED_SLOTS))
`;
  return JSON.parse(execFileSync('python3', ['-c', src], { encoding: 'utf8' }));
}

/** The installer's own table, parsed from the shell array it declares. */
function installerJobs() {
  const sh = read('scripts/install-slot-jobs.sh');
  const block = sh.split('JOBS=(')[1].split(')')[0];
  const out = {};
  for (const line of block.split('\n')) {
    const m = line.match(/"([a-z0-9-]+)\|([0-9:,]+)\|/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe('the installer and the register cannot drift apart', () => {
  it('installs a job for every new script and slot, at the registered hour', () => {
    // Two lists describing one schedule is how a job ends up running at a time
    // nobody expects. The register is the source of truth; the installer must
    // match it.
    const sched = schedule();
    for (const [name, times] of Object.entries(installerJobs())) {
      expect(sched[name], `${name} missing from job-schedule.json`).toBeTruthy();
      const [min, hour] = sched[name].cron.split(' ');
      const first = times.split(',')[0];
      expect(`${Number(first.split(':')[0])}:${Number(first.split(':')[1])}`)
        .toBe(`${Number(hour)}:${Number(min)}`);
    }
  });

  it('installs every approved slot — an allowlisted slot with no job never runs', () => {
    const installed = installerJobs();
    for (const slot of Object.keys(approvedSlots())) {
      // inbound-triage and task-manager predate this installer and have their
      // own plists already; the four new ones must be here.
      if (['inbound-triage', 'task-manager'].includes(slot)) continue;
      expect(installed[slot], `${slot} is allowlisted but not installed`).toBeTruthy();
    }
  });

  it('every approved slot has a skill file under review', () => {
    // A slot whose SKILL.md is missing exits 0 after saying it cannot find the
    // file, so the runner would read a silent no-op as success every morning.
    for (const slot of Object.keys(approvedSlots())) {
      const folder = { 'inbound-triage': 'inbound-email-triage',
                       'task-manager': 'task-manager-board' }[slot] || slot;
      expect(existsSync(join(ROOT, '.claude/scheduled-tasks', folder, 'SKILL.md')),
        `no tracked SKILL.md for ${slot}`).toBe(true);
    }
  });

  it('no new job expresses a day of the week in its cron', () => {
    // "0 8 * * 1-5" reads as Mon-Fri to every human and to standard cron, and
    // as Sun-Thu to Cloudflare. The CEO brief lost every Friday for a week to
    // exactly this. The day decision belongs in the skill, in London time.
    const sched = schedule();
    for (const name of Object.keys(installerJobs())) {
      const dow = sched[name].cron.trim().split(/\s+/)[4];
      expect(dow, `${name} has a day-of-week in its cron`).toBe('*');
    }
  });

  it('the weekly sweep decides Sunday in its skill, not its schedule', () => {
    const skill = read('.claude/scheduled-tasks/prod-sweep-weekly/SKILL.md');
    expect(skill).toMatch(/TZ=Europe\/London date \+%A/);
    expect(skill).toMatch(/Sunday/);
  });
});

describe('the routine shrank, and stayed in sync with its source of truth', () => {
  it('the live SKILL.md body is the doc body, verbatim', () => {
    // Routine instructions outside git skip review entirely. The doc is the
    // reviewed original; the skill is generated from it.
    const doc = read('docs/daily-ops-routine.md');
    const marker = '# THE ROUTINE (this section is the live SKILL.md body, verbatim)\n';
    expect(doc).toContain(marker);
    const body = doc.split(marker)[1].replace(/^\n+/, '');
    const skill = read('.claude/scheduled-tasks/daily-ops/SKILL.md');
    expect(skill.split('---\n\n')[1]).toBe(body);
  });

  it('has five phases, not nine', () => {
    const skill = read('.claude/scheduled-tasks/daily-ops/SKILL.md');
    const phases = [...skill.matchAll(/^## Phase (\d+) — /gm)].map((m) => m[1]);
    expect(phases).toEqual(['1', '2', '3', '4', '5']);
  });

  it('no longer runs the sweeps that became scripts or slots', () => {
    const skill = read('.claude/scheduled-tasks/daily-ops/SKILL.md');
    // Each of these was a phase. Naming one as a subagent prompt again means
    // the work is being done twice: once in its slot and once here.
    for (const gone of ['drift-monitor/SKILL.md', 'task-hygiene-sweep/SKILL.md',
                        'prospect-daily-run/SKILL.md', 'ceo-huddle/SKILL.md',
                        'ceo-brief-morning-check/SKILL.md']) {
      expect(skill, `${gone} is still a daily-ops phase`).not.toContain(gone);
    }
  });

  it('still writes the mark the guard depends on, and still runs the guard', () => {
    // Without these two lines phase 1 is invisible and the guard fails every
    // day with "nothing ran at all".
    const skill = read('.claude/scheduled-tasks/daily-ops/SKILL.md');
    expect(skill).toMatch(/job-queue\.py mark daily-ops/);
    expect(skill).toContain('check-routines.py');
  });

  it('tells the fixer to stop calling an unmerged PR "fixed"', () => {
    const skill = flowed('.claude/scheduled-tasks/daily-ops/SKILL.md');
    expect(skill).toMatch(/--outcome pending/);
    expect(skill).toMatch(/findings\.py land --pr/);
  });

  it('surfaces a stalled fix queue to Kevin as something only he can clear', () => {
    // The real drain rate was zero, and no report said so. Four unmerged PRs
    // is not an engineering detail — it is the reason nothing gets fixed.
    const skill = flowed('.claude/scheduled-tasks/daily-ops/SKILL.md');
    expect(skill).toMatch(/three or more/i);
    expect(skill).toMatch(/NEEDS YOU/);
  });
});

describe('the retired phases are retired, not deleted', () => {
  it('keeps their register entries disabled so the digest does not chase them', () => {
    const sched = schedule();
    for (const name of ['task-hygiene-sweep', 'ceo-brief-morning-check']) {
      expect(sched[name], `${name} was deleted rather than retired`).toBeTruthy();
      expect(sched[name].enabled).toBe(false);
    }
  });

  it('the Task Manager picked up the task hygiene work', () => {
    const tm = flowed('.claude/scheduled-tasks/task-manager-board/SKILL.md');
    expect(tm).toMatch(/task-hygiene-sweep\.py audit/);
    expect(tm).toMatch(/09:00 SLOT ONLY/);
    // Assignee fires a Slack DM and a blank one means an AI agent owns the
    // task, so it must never join the auto tier.
    expect(tm).toMatch(/Assignee is NOT auto tier/);
  });
});
