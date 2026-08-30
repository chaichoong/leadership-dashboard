import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = resolve(ROOT, 'scripts/fixer-merge.py');
const SRC = readFileSync(GATE, 'utf8');
const FIXER_SKILL = join(process.env.HOME, '.claude/scheduled-tasks/queue-fixer/SKILL.md');
const OPS_SKILL = join(process.env.HOME, '.claude/scheduled-tasks/daily-ops/SKILL.md');

// ── THE FIXER MERGES ITS OWN WORK (Kevin, 29 Aug 2026) ─────────────────────
//
// "the fixer needs to merge them all so that there's nothing left hanging
// that's not finished."
//
// He was the drain on the entire fix queue and he is not a code reviewer. On
// the day he said it: 213 open findings, 4 critical, 59 high, 8 more in
// overflow, two fixer PRs unmerged — against a cap of ten a day. The routine's
// own skill already said that until he merged them, "everything you write
// today is theatre."
//
// What replaces his review is this gate, and it has to be STRICTER than the
// glance it replaces, or this is just removing a safeguard.

const py = (args) => {
  try {
    return { ok: true, out: execFileSync('python3', [GATE, ...args], { encoding: 'utf8' }) };
  } catch (e) { return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` }; }
};

describe('the gate runs the WHOLE suite, not a subset', () => {
  it('runs vitest AND the browser suite', () => {
    // `npm test` is vitest only. Both of this platform's worst incidents — the
    // 8,667-transaction Report Amount blanking and the split sign-flip — would
    // have walked through a vitest-only check.
    expect(SRC).toMatch(/npx", "vitest", "run/);
    expect(SRC).toMatch(/playwright", "test", "tests\/sync-invariants\//);
  });

  it('a green vitest with a red browser suite is NOT green', () => {
    expect(SRC).toMatch(/out\["vitest"\]\["ok"\] and out\["browser"\]\["ok"\]/);
  });

  it('a red gate merges nothing and leaves the PR open', () => {
    expect(SRC).toMatch(/the gate is RED — left open, nothing merged/);
    const fn = SRC.slice(SRC.indexOf('def cmd_merge'));
    // The merge call must sit AFTER the gate check, not beside it.
    const redAt = fn.indexOf('if not ok:');
    const mergeAt = fn.indexOf('gh", "pr", "merge');
    expect(redAt, 'the red-gate guard is gone').toBeGreaterThan(-1);
    expect(mergeAt).toBeGreaterThan(-1);
    expect(redAt).toBeLessThan(mergeAt);
  });
});

describe('what the fixer may never merge on its own', () => {
  const protectedBlock = SRC.match(/PROTECTED = \(([\s\S]*?)\)/)[1];

  it('money, the approval loop, the send path and the shared files', () => {
    // Chosen by what has actually caused incidents here, not by feel.
    for (const p of ['js/money.js', 'js/reconciliation.js', 'js/cashflow.js',
                     'js/config.js', 'js/shared.js',
                     'scripts/agent-dispatch.py', 'scripts/send-email.py',
                     'scripts/slack-automation/', 'os/agents/index.html']) {
      expect(protectedBlock, `not protected: ${p}`).toContain(p);
    }
  });

  it('the approval loop cannot fix itself', () => {
    // A wrong fix here breaks the mechanism that stops agents acting without
    // Kevin. It must not be able to merge a change to that mechanism.
    expect(protectedBlock).toContain('scripts/agent-dispatch.py');
    expect(protectedBlock).toContain('scripts/slack-automation/');
  });

  it('a protected hit is a REFUSAL, not a warning it proceeds past', () => {
    const fn = SRC.slice(SRC.indexOf('def cmd_merge'), SRC.indexOf('def main'));
    expect(fn).toMatch(/if not d\["mayAutoMerge"\]:[\s\S]{0,400}return 0/);
    // …and it must return BEFORE the gate runs, so a protected PR is never
    // merged by a lucky green run.
    const refuseAt = fn.indexOf('mayAutoMerge');
    const gateAt = fn.indexOf('run_gate()');
    expect(refuseAt, 'the protected-path refusal is gone').toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    expect(refuseAt).toBeLessThan(gateAt);
  });

  it('matches a directory prefix, not just exact paths', () => {
    // scripts/slack-automation/ has several files; protecting only the folder
    // name would protect none of them.
    expect(SRC).toMatch(/p\.endswith\("\/"\) and f\.startswith\(p\)/);
  });
});

describe('a merge is only real when it landed', () => {
  it('confirms against the API, not gh’s exit code', () => {
    // `gh pr merge` exits non-zero when it cannot check out main locally — a
    // worktree holds it — even though the merge succeeded. Trusting the exit
    // code would report a successful merge as a failure every single time.
    expect(SRC).toMatch(/gh", "pr", "view"[\s\S]{0,120}state,mergedAt/);
    expect(SRC).toMatch(/state\.get\("state"\) == "MERGED"/);
  });

  it('lands the findings ONLY after the merge is confirmed', () => {
    // Closing them earlier is what put forty findings on record as "fixed"
    // against four PRs that never landed (26 Aug 2026).
    const fn = SRC.slice(SRC.indexOf('def cmd_merge'));
    // Assert the guard EXISTS before comparing positions. indexOf returns -1
    // when it is gone, and -1 is less than everything, so an ordering test
    // alone passes vacuously against a deleted guard — which is exactly what
    // it did on the first attempt.
    const guardAt = fn.indexOf('if merged:');
    const landAt = fn.indexOf('findings.py');
    expect(guardAt, 'the `if merged:` guard is gone').toBeGreaterThan(-1);
    expect(landAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(landAt);
  });
});

describe('the routines actually use it', () => {
  it('the fixer skill calls the gate, not a bare gh merge', () => {
    const s = readFileSync(FIXER_SKILL, 'utf8');
    expect(s).toMatch(/fixer-merge\.py merge --pr/);
    expect(s).toMatch(/Do not merge with a bare `gh pr merge`/);
  });

  it('daily-ops phase 4 does too', () => {
    expect(readFileSync(OPS_SKILL, 'utf8')).toMatch(/fixer-merge\.py merge --pr/);
  });

  it('the cap was raised, because ten a day could never drain 213', () => {
    const s = readFileSync(FIXER_SKILL, 'utf8');
    expect(s).toMatch(/Cap of 25 per run/);
    // And the report must show whether the queue is actually clearing.
    expect(s).toMatch(/Report the arithmetic, not just the count/);
  });

  it('an open fixer PR now MEANS something specific', () => {
    // Before, it meant "waiting for Kevin". Now it means the gate went red or
    // it touched a protected path — and the report has to say which.
    expect(readFileSync(OPS_SKILL, 'utf8')).toMatch(/gate went RED, or it touched a protected path/);
  });
});

describe('it decides correctly on real pull requests', () => {
  it('flags a PR that touched the approval loop', () => {
    // PR #187 changed scripts/agent-dispatch.py and scripts/send-email.py.
    const r = py(['check', '--pr', '187']);
    if (!r.ok) return;  // offline or gh unavailable — not this test's business
    const d = JSON.parse(r.out);
    expect(d.mayAutoMerge).toBe(false);
    expect(d.protected.map((h) => h.file)).toContain('scripts/agent-dispatch.py');
  });

  it('clears a PR that touched neither', () => {
    // PR #189 added the Loom search and its test only.
    const r = py(['check', '--pr', '189']);
    if (!r.ok) return;
    expect(JSON.parse(r.out).mayAutoMerge).toBe(true);
  });
});
