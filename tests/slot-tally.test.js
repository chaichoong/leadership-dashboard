// The clause a slot's "run OK" line carries (finding 20261111-daily-ops-1278). Until 13 Nov 2026
// the inbox sort's whole summary was "inbound-triage run OK", so a run that decided 113 messages
// and one that decided none wrote the identical line, and daily-ops had to run its own Gmail
// search before it could call the slot green.
//
// These drive scripts/slot-tally.py itself with real digest shapes written to a temp directory —
// no real log is read or written. Back-tested by making tally() return "" for a missing digest:
// "says so in words when there is no digest" fails, which is the silent zero the finding is about.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../scripts/slot-tally.py', import.meta.url).pathname;
const run = (job, path) =>
  execFileSync('python3', path ? [SCRIPT, job, path] : [SCRIPT, job], { encoding: 'utf8' });

function digest(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'slot-tally-'));
  const p = join(dir, 'digest.jsonl');
  writeFileSync(p, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return p;
}

describe('the inbox sort says what it decided', () => {
  it('counts tasks, filing, archiving and what it left', () => {
    const p = digest([
      { do: 'task-created' }, { do: 'task-created' },
      { do: 'archive' }, { do: 'archive' }, { do: 'archive' },
      { do: 'file-6' }, { do: 'label12' }, { do: 'label13' },
      { do: 'leave' },
    ]);
    expect(run('inbound-triage', p)).toBe(
      ' — decided 9 today: 2 tasks, 3 filed, 3 archived, 1 left for Kevin');
  });

  it('says one task, not 1 tasks', () => {
    expect(run('inbound-triage', digest([{ do: 'task-created' }]))).toContain('1 task,');
  });

  // The whole point: a run that read nothing must not look like a run that read everything.
  it('says so in words when there is no digest, and never prints a zero tally', () => {
    const out = run('inbound-triage', join(tmpdir(), 'slot-tally-does-not-exist', 'digest.jsonl'));
    expect(out).toBe(' — nothing decided today (no digest written)');
    expect(out).not.toMatch(/decided 0/);
  });

  it('says so when the digest is there but empty', () => {
    expect(run('inbound-triage', digest([]))).toBe(' — nothing decided today (digest empty)');
  });

  // A damaged line is named, not quietly dropped into a smaller count.
  it('names unreadable lines rather than hiding them', () => {
    const out = run('inbound-triage', digest([{ do: 'archive' }, 'not json at all']));
    expect(out).toContain('decided 2 today');
    expect(out).toContain('1 line unreadable');
  });

  it('adds nothing to a slot that has no tally of its own', () => {
    expect(run('task-manager')).toBe('');
    expect(run('ceo-agent')).toBe('');
  });
});
