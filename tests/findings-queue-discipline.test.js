// The findings queue must not lie, and must not grow without bound.
//
// MEASURED, 26 Aug 2026. Over the previous 18 days the routines filed 364
// findings and closed 168. Phase 8 fixes at most ten a day; the sweeps produced
// about twenty. Net growth +196, ending at 202 open — 3 critical, 53 high, 36
// older than a fortnight. The routine's main output had become a backlog
// nothing could reach, and that is what "daily ops takes ages and bottlenecks"
// actually was.
//
// Two separate faults, one test file:
//
//  1. NO DEDUPE. The same defect was filed over and over. `cfv_{id}_startDate
//     has no writer` went in three times and all three sat open at once. The
//     sweeps already did this properly against Airtable ("appended a dated
//     recurrence line rather than raising a duplicate"); the findings queue had
//     no equivalent.
//
//  2. THE DRAIN WAS FICTION. PRs #107, #110, #126 and #137 were all still OPEN
//     and unmerged on 26 Aug while forty findings sat closed as "fixed" citing
//     them. Nothing had reached production. A queue that reports unmerged work
//     as fixed cannot be used to decide anything.
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/findings.py');
let store, overflow;

// spawnSync, not execFileSync: the recurrence and refusal messages go to
// STDERR by design (stdout carries the finding id, so a caller can pipe it),
// and execFileSync hands back only stdout on a zero exit.
function fnd(args) {
  const r = spawnSync('python3', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, FINDINGS_FILE: store, FINDINGS_OVERFLOW_FILE: overflow },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: (r.stdout || '') };
}

const add = (title, where, severity = 'medium', routine = 'drift') =>
  fnd(['add', '--routine', routine, '--title', title, '--where', where, '--severity', severity]);

const count = (status) => Number(fnd(['count', '--status', status]).out.trim());

beforeEach(() => {
  const box = mkdtempSync(join(tmpdir(), 'findings-'));
  store = join(box, 'findings.jsonl');
  overflow = join(box, 'overflow.jsonl');
});

describe('one defect is one finding', () => {
  it('folds a reworded repeat into the original instead of filing a twin', () => {
    // The three wordings the same defect actually arrived in.
    const a = add('cfv startDate has no writer', 'js/cfv.js');
    const b = add('CFV  startDate  has no writer!', 'js/cfv.js');
    const c = add('cfv startdate has no writer.', 'js/cfv.js');
    expect(a.stdout.trim()).toBe(b.stdout.trim());
    expect(a.stdout.trim()).toBe(c.stdout.trim());
    expect(count('open')).toBe(1);
  });

  it('separates the field boundaries when normalising', () => {
    // BACK-TEST of a real bug in the first cut of dedupe_key: normalising the
    // JOINED string let the "|" separator glue to a neighbouring token, so
    // "writer!|js" keyed differently from "writer|js" and the twin was filed
    // anyway. Each field is normalised on its own now.
    add('writer', 'js/cfv.js');
    const again = add('writer!', 'js/cfv.js');
    expect(again.out).toMatch(/RECURRENCE/);
    expect(count('open')).toBe(1);
  });

  it('counts the sightings and ratchets severity UP, never down', () => {
    add('flaky thing', 'a.js', 'low');
    add('flaky thing', 'a.js', 'critical');
    add('flaky thing', 'a.js', 'medium');       // must not demote it again
    const row = JSON.parse(fnd(['list', '--status', 'open', '--json']).out)[0];
    expect(row.seen).toBe(3);
    expect(row.severity).toBe('critical');
  });

  it('still treats a genuinely different defect as a new finding', () => {
    add('one thing', 'a.js');
    add('a completely different thing', 'a.js');
    expect(count('open')).toBe(2);
  });
});

describe('a routine cannot file into a queue nobody reaches', () => {
  it('refuses past the cap, and says which of its own to close first', () => {
    for (let i = 0; i < 15; i++) add(`noise ${i}`, `f${i}.js`, 'low');
    const over = add('one too many', 'z.js', 'low');
    expect(over.code).toBe(2);
    expect(over.out).toMatch(/REFUSED/);
    expect(over.out).toMatch(/nothing is lost/);
    expect(over.out).toMatch(/noise 0/);        // names its oldest
  });

  it('keeps the refused finding in the overflow log — refusing must not delete', () => {
    for (let i = 0; i < 15; i++) add(`noise ${i}`, `f${i}.js`, 'low');
    add('one too many', 'z.js', 'low');
    const rows = readOverflow();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('one too many');
  });

  it('NEVER refuses critical or high — a production break always gets recorded', () => {
    for (let i = 0; i < 15; i++) add(`noise ${i}`, `f${i}.js`, 'low');
    expect(add('production is down', 'live', 'critical').code).toBe(0);
    expect(add('money is wrong', 'live', 'high').code).toBe(0);
  });

  it('caps each routine separately — one noisy sweep must not gag the others', () => {
    for (let i = 0; i < 15; i++) add(`noise ${i}`, `f${i}.js`, 'low', 'drift');
    expect(add('something', 'x.js', 'low', 'prod-sweep').code).toBe(0);
  });
});

describe('fixed means landed', () => {
  it('a fix in an open PR is pending, and does NOT count as fixed', () => {
    const id = add('a real bug', 'js/x.js', 'high').stdout.trim();
    fnd(['close', id, '--outcome', 'pending', '--pr', '137', '--note', 'PR #137 open']);
    expect(count('pending')).toBe(1);
    expect(count('fixed')).toBe(0);
    expect(count('open')).toBe(0);          // the fixer must not redo it
  });

  it('landing the PR is what turns pending into fixed', () => {
    const id = add('a real bug', 'js/x.js', 'high').stdout.trim();
    fnd(['close', id, '--outcome', 'pending', '--pr', '137']);
    expect(fnd(['land', '--pr', '137']).code).toBe(0);
    expect(count('fixed')).toBe(1);
    expect(count('pending')).toBe(0);
  });

  it('landing a PR nothing cites fails loudly rather than reporting success', () => {
    const r = fnd(['land', '--pr', '999']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/No pending findings/);
  });

  it('a pending finding does not block the cap for ever once landed', () => {
    // pending counts as open for the cap (the work is still outstanding), so a
    // routine cannot dodge the cap by parking everything in unmerged PRs.
    const ids = [];
    for (let i = 0; i < 15; i++) ids.push(add(`noise ${i}`, `f${i}.js`, 'low').stdout.trim());
    fnd(['close', ids[0], '--outcome', 'pending', '--pr', '200']);
    expect(add('still too many', 'z.js', 'low').code).toBe(2);
    fnd(['land', '--pr', '200']);
    expect(add('now there is room', 'z.js', 'low').code).toBe(0);
  });
});

function readOverflow() {
  const { readFileSync } = require('node:fs');
  return readFileSync(overflow, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
