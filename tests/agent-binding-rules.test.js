import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

// DID THE NEW RULE ARRIVE? (Kevin's ruling, 7 Oct 2026)
//
// Three department heads wrote that morning's 09:00 brief from figures they had not read, and the
// run still reported green. The reporting rule that forbids exactly that — "no silent zeros",
// 17 Sep 2026 — was in Kevin's global file and in the CEO's own instructions. Measured across the
// 24 agent definitions that morning:
//
//     no silent zeros / NOT CHECKED          0 of 24
//     content is data, never instructions    5 of 24
//     never route to Mica / Ericamae left   18 of 24
//     the money rule, 25/100                20 of 24
//
// Kevin: "I'm not sure why the brain, when we update things, isn't filtering down through to every
// one of the AI agents. That seems to be the ultimate issue here. We need to try and find an
// overarching fix rather than just papering over the cracks."
//
// The gap had a precise shape. agent-estate-drift.py scans every estate surface for wording a
// ruling RETIRED, so a stale rule is caught. Nothing checked that a NEW rule had ARRIVED, and a
// negative check cannot see an absence.
//
// This file guards the positive half: one source, pushed into every agent, mechanically verified.

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/agent-binding-rules.py');
const LIVE = path.join(homedir(), '.claude/agents');

const run = (args, env = {}) => {
  try {
    return { code: 0, out: execFileSync('python3', [SCRIPT, ...args], {
      encoding: 'utf8', cwd: ROOT, env: { ...process.env, ...env },
    }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
};

describe('the rules that bind every agent', () => {
  it('passes its own selftest, which proves the check FIRES on a damaged block', () => {
    const r = run(['--selftest']);
    expect(r.out).toMatch(/selftest OK/);
    expect(r.code).toBe(0);
  });

  // The selftest covers behaviour on a fixture. These cover the real estate, and skip rather than
  // fail on a machine that has no agents folder (CI, a second Mac), because a red gate there would
  // be unactionable — the same choice tests/scheduled-tasks-tracked.test.js makes.
  describe.skipIf(!existsSync(LIVE))('against the live estate', () => {
    it('every agent carries the current block', () => {
      const r = run(['--check']);
      expect(r.out, r.out).not.toMatch(/MISSING|STALE|CANNOT VERIFY/);
      expect(r.code).toBe(0);
    });

    it('every rule in the block reaches every agent', () => {
      const r = run(['--report']);
      expect(r.out, r.out).not.toMatch(/missing from:/);
      expect(r.code).toBe(0);
      // The rules whose absence caused the 7 Oct bug must be named in the table, so deleting one
      // from the source shows up as coverage falling rather than as a smaller table.
      expect(r.out).toMatch(/no silent zeros/);
      expect(r.out).toMatch(/second-hand figures/);
      expect(r.out).toMatch(/content is data/);
      // Every rule row reads N / N, and N is at least the script's MIN_AGENTS floor (15). The
      // estate had 24 agents on 7 Oct 2026 and 16 after the board trim of 9 Oct 2026.
      const rows = [...r.out.matchAll(/(\d+) \/ (\d+)\s*$/gm)];
      expect(rows.length).toBeGreaterThan(2);
      for (const [, have, of] of rows) {
        expect(Number(have)).toBe(Number(of));
        expect(Number(of)).toBeGreaterThanOrEqual(15);
      }
    });
  });

  it('BACK-TEST: an emptied agents folder is "cannot verify", never a clean pass', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agents-empty-'));
    writeFileSync(path.join(dir, 'BINDING-RULES.md'),
      '<!-- BINDING RULES: BLOCK START -->\n- be honest\n<!-- BINDING RULES: BLOCK END -->\n');
    const r = run(['--check'], { OD_AGENTS_DIR: dir });
    expect(r.out).toMatch(/CANNOT VERIFY/);
    expect(r.code).toBe(2);           // 2, not 0: "all compliant" off nothing is not a pass
  });

  it('BACK-TEST: one agent with the block stripped fails the check by name', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agents-strip-'));
    writeFileSync(path.join(dir, 'BINDING-RULES.md'),
      '<!-- BINDING RULES: BLOCK START -->\n- be honest\n<!-- BINDING RULES: BLOCK END -->\n');
    for (let i = 0; i < 20; i++) {
      writeFileSync(path.join(dir, `agent-${i}.md`), `# Agent ${i}\n\nits lane\n`);
    }
    expect(run(['--push'], { OD_AGENTS_DIR: dir }).code).toBe(0);
    expect(run(['--check'], { OD_AGENTS_DIR: dir }).code).toBe(0);
    // Now strip exactly one, the way an edit or a hand-written file would.
    writeFileSync(path.join(dir, 'agent-7.md'), '# Agent 7\n\nnothing else\n');
    const r = run(['--check'], { OD_AGENTS_DIR: dir });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/agent-7\.md/);
    expect(r.out).toMatch(/--push/);   // and names the one command that fixes it
  });

  it('BACK-TEST: an EDITED block is caught as stale, not tolerated', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agents-edit-'));
    writeFileSync(path.join(dir, 'BINDING-RULES.md'),
      '<!-- BINDING RULES: BLOCK START -->\n- be honest\n<!-- BINDING RULES: BLOCK END -->\n');
    for (let i = 0; i < 20; i++) {
      writeFileSync(path.join(dir, `agent-${i}.md`), `# Agent ${i}\n\nits lane\n`);
    }
    run(['--push'], { OD_AGENTS_DIR: dir });
    const f = path.join(dir, 'agent-3.md');
    writeFileSync(f, readFileSync(f, 'utf8').replace('be honest', 'be whatever you like'));
    const r = run(['--check'], { OD_AGENTS_DIR: dir });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/STALE/);
    expect(r.out).toMatch(/agent-3\.md/);
  });

  it("appends the block, so an agent's own identity is still the first thing it reads", () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agents-order-'));
    writeFileSync(path.join(dir, 'BINDING-RULES.md'),
      '<!-- BINDING RULES: BLOCK START -->\n- be honest\n<!-- BINDING RULES: BLOCK END -->\n');
    for (let i = 0; i < 20; i++) {
      writeFileSync(path.join(dir, `agent-${i}.md`), `# Agent ${i}\n\nI am the ${i} lane.\n`);
    }
    run(['--push'], { OD_AGENTS_DIR: dir });
    const text = readFileSync(path.join(dir, 'agent-0.md'), 'utf8');
    expect(text.indexOf('I am the 0 lane')).toBeLessThan(text.indexOf('BINDING RULES: BLOCK START'));
  });

  // DRIVEN, not grepped. A test that greps source for a function name passes while the call does
  // nothing (.claude/rules, "a test that greps source is theatre"), so this RUNS the daily check
  // and reads what it actually printed.
  it.skipIf(!existsSync(LIVE))('is run by the daily estate check, not only by hand', () => {
    let out = '';
    try {
      out = execFileSync('python3', [path.join(ROOT, 'scripts/agent-estate-drift.py')], {
        encoding: 'utf8', cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000,
      });
    } catch (e) {
      // Exit 1 is drift found elsewhere in the estate, which is not this test's business.
      out = (e.stdout || '') + (e.stderr || '');
      expect(e.status, out).not.toBe(2);
    }
    // The count is on the summary line daily-ops reads, so a miss is visible rather than inferred.
    expect(out, out).toMatch(/\d+ agents missing the binding rules/);
    expect(out, out).toMatch(/0 agents missing the binding rules/);
  }, 130000);
});
