// One routine filing one defect twice must fold into a recurrence, even when it describes the
// place differently the second time.
//
// Regression origin: 24 Oct 2026 (finding 20261024-phase-3-1066). dedupe_key is routine + title +
// where, so phase 3 filed 20261024-phase-3-1064 with the title of the open 20261023-phase-3-1053
// character-for-character and still got a new id, because the two said the place in different
// words. A routine is told it may file freely because repeats fold in as recurrences, so a missed
// fold quietly inflates the backlog, spends the filer's cap on copies, and loses the recurrence
// count that says which defect keeps biting. Both had to be merged by hand.
//
// A title here is a whole sentence, so an exact match inside ONE routine is one defect. The rule
// stays that narrow on purpose: folding near-identical titles would swallow real separate defects.
//
// Back-tested: removing the `1a` branch from known_match turns the first test red (two open ids).

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FINDINGS = resolve(__dirname, '../scripts/findings.py');
const BOX = mkdtempSync(join(tmpdir(), 'findings-title-'));
afterAll(() => rmSync(BOX, { recursive: true, force: true }));

// No test reaches Airtable: a fresh agent cache and an empty agents folder stand in for the reads.
const AGENTS_CACHE = join(BOX, 'agents-cache.json');
const AGENTS_DIR = join(BOX, 'agents');
mkdirSync(AGENTS_DIR);
writeFileSync(AGENTS_CACHE, JSON.stringify({ fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), names: [] }));

let store; let overflow; let n = 0;
beforeEach(() => {
  store = join(BOX, `q${n}.jsonl`);
  overflow = join(BOX, `o${n}.jsonl`);
  n += 1;
});

function fnd(args) {
  const r = spawnSync('python3', [FINDINGS, ...args], {
    env: {
      ...process.env, FINDINGS_FILE: store, FINDINGS_OVERFLOW_FILE: overflow, FINDINGS_AGENT: '',
      FINDINGS_AGENTS_CACHE: AGENTS_CACHE, FINDINGS_AGENTS_DIR: AGENTS_DIR,
    },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout.trim(), both: `${r.stdout}${r.stderr}` };
}

// The real pair, with the place worded as each run worded it.
const TITLE = 'Post pass cannot archive its source: destructive Bash refused in an unattended run';
const WHERE_A = '~/.claude/scheduled-tasks/post-manager-weekly/SKILL.md step 6, daily-ops phase 3';
const WHERE_B = 'the post pass, the step that moves the source PDF out of the Post Inbox';

function add(routine, title, where, severity = 'high') {
  return fnd(['add', '--routine', routine, '--title', title, '--where', where,
    '--detail', 'd', '--fix', 'f', '--severity', severity]);
}

describe('findings dedupe: the same routine, the same title', () => {
  it('folds as a recurrence however the place is worded', () => {
    const first = add('phase-3', TITLE, WHERE_A);
    expect(first.code).toBe(0);
    const again = add('phase-3', TITLE, WHERE_B);
    expect(again.code).toBe(0);
    expect(again.out).toBe(first.out);                       // the SAME id, not a second one
    expect(again.both).toMatch(/RECURRENCE of/);
    expect(again.both).toMatch(/exact title/);
    const open = fnd(['list', '--status', 'open']).both;
    expect(open.match(new RegExp(first.out, 'g')) || []).toHaveLength(1);
  });

  it('controls: a different title, and the same title under another routine, still open their own', () => {
    const first = add('phase-3', TITLE, WHERE_A);
    const other = add('phase-3', 'Video stabilisation has degraded since the 2080s episodes', WHERE_A);
    expect(other.out).not.toBe(first.out);
    const elsewhere = add('rent-check', TITLE, WHERE_B);
    expect(elsewhere.out).not.toBe(first.out);
  });

  it('an empty title folds into nothing', () => {
    const first = add('phase-3', '', WHERE_A);
    const second = add('phase-3', '', WHERE_B);
    expect(second.out).not.toBe(first.out);
  });
});
