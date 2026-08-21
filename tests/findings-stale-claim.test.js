// A claimed finding whose run died must come back (finding 20260814-daily-ops-144).
//
// WHY
// The findings queue is the ONLY route a read-only routine has to get code
// changed. `claim` marked a finding as owned and there was no way to un-own it:
// no reopen, no expiry. So a fixer run that claimed three findings and then
// died — the Mac sleeping, an agent stalling, the context running out — took
// those three out of circulation permanently. `list --status open` could not
// see them, no later run would ever pick them up, and the only recovery was
// hand-editing an append-only log.
//
// That is worse than a long queue, because a long queue is at least visible.
// A claim is now a LEASE.
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/findings.py');
let store;

// Stamps in the store are UTC, "%Y-%m-%dT%H:%M:%SZ" — the format findings.py
// writes. Building them here rather than shelling out keeps the clock in the
// test's hands.
const stamp = (hoursAgo) =>
  new Date(Date.now() - hoursAgo * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');

function fnd(args) {
  try {
    return { code: 0, out: execFileSync('python3', [SCRIPT, ...args],
      { encoding: 'utf8', env: { ...process.env, FINDINGS_FILE: store } }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

// Write the append-only log directly so a claim can be back-dated. This is the
// state a dead run leaves behind; there is no other way to reach it.
function seed(records) {
  writeFileSync(store, records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

const added = (id, extra = {}) => ({
  op: 'add', id, ts: stamp(30), routine: 'drift', severity: 'high',
  title: 'something broke', where: 'js/x.js:1', detail: 'd', proposed_fix: 'f',
  ...extra,
});
const claimed = (id, hoursAgo, by = 'queue-fixer') =>
  ({ op: 'claim', id, ts: stamp(hoursAgo), by });

const ids = (out) => (out.match(/\[[\w-]+\]/g) || []).map(s => s.slice(1, -1));

describe('findings queue: a dead run does not swallow a finding', () => {
  beforeEach(() => { store = join(mkdtempSync(join(tmpdir(), 'findings-')), 'q.jsonl'); });

  it('replays the bug: a claimed finding is invisible to `list --status open`', () => {
    seed([added('f-1'), claimed('f-1', 30)]);
    expect(ids(fnd(['list', '--status', 'open']).out)).toEqual([]);
  });

  it('`list --stale` surfaces it', () => {
    seed([added('f-1'), claimed('f-1', 30)]);
    expect(ids(fnd(['list', '--stale']).out)).toEqual(['f-1']);
  });

  it('`reopen --stale` puts it back in the open queue', () => {
    seed([added('f-1'), claimed('f-1', 30)]);
    expect(fnd(['reopen', '--stale']).out).toMatch(/reopened f-1/);
    expect(ids(fnd(['list', '--status', 'open']).out)).toEqual(['f-1']);
  });

  it('a reopened finding can be claimed again — the recovery is complete', () => {
    // Without this, reopen would only change a label: claim() refuses anything
    // not "open", so a half-reopen would leave the finding just as stuck.
    seed([added('f-1'), claimed('f-1', 30)]);
    fnd(['reopen', '--stale']);
    expect(fnd(['claim', 'f-1', '--by', 'queue-fixer']).code).toBe(0);
  });

  it('leaves a claim that is still inside its lease alone', () => {
    // A run in progress must not have its work reassigned underneath it. That
    // would produce the double-fix the single-writer design exists to prevent.
    seed([added('f-1'), claimed('f-1', 1)]);
    expect(fnd(['reopen', '--stale']).out).toMatch(/reopened 0 finding\(s\)/);
    expect(ids(fnd(['list', '--status', 'open']).out)).toEqual([]);
  });

  it('honours --stale-hours so the lease can be tightened without a code change', () => {
    seed([added('f-1'), claimed('f-1', 3)]);
    expect(fnd(['reopen', '--stale']).out).toMatch(/reopened 0 finding\(s\)/);
    expect(fnd(['reopen', '--stale', '--stale-hours', '2']).out).toMatch(/reopened f-1/);
  });

  it('treats an unreadable claim timestamp as stale, not as fresh', () => {
    // THE CONTROL. Reading a broken stamp as age 0 would keep the finding
    // stuck for ever while reporting a clean queue — the original bug wearing
    // a different hat.
    seed([added('f-1'), { op: 'claim', id: 'f-1', ts: 'not-a-date', by: 'x' }]);
    expect(ids(fnd(['list', '--stale']).out)).toEqual(['f-1']);
  });

  it('never touches an open or closed finding', () => {
    seed([added('f-open'), added('f-done'),
          { op: 'close', id: 'f-done', ts: stamp(20), outcome: 'fixed', note: 'n' }]);
    expect(fnd(['reopen', '--stale']).out).toMatch(/reopened 0 finding\(s\)/);
    expect(fnd(['reopen', 'f-done']).code, 'a closed finding reopened without --force').toBe(1);
    expect(fnd(['reopen', 'f-done', '--force']).code).toBe(0);
  });

  it('appends rather than rewriting — the claim history survives', () => {
    // The store is append-only on purpose: two routines writing at once must
    // never truncate each other, and who claimed what has to stay auditable.
    seed([added('f-1'), claimed('f-1', 30, 'dead-run')]);
    fnd(['reopen', '--stale']);
    const ops = readFileSync(store, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    expect(ops.map(o => o.op)).toEqual(['add', 'claim', 'reopen']);
    expect(ops.find(o => o.op === 'claim').by).toBe('dead-run');
  });

  it('says WHY it reopened, naming the dead run and the age', () => {
    seed([added('f-1'), claimed('f-1', 30, 'dead-run')]);
    fnd(['reopen', '--stale']);
    const note = readFileSync(store, 'utf8').split('\n').filter(Boolean)
      .map(JSON.parse).find(r => r.op === 'reopen').note;
    expect(note).toMatch(/dead-run/);
    expect(note).toMatch(/hours/);
  });
});
