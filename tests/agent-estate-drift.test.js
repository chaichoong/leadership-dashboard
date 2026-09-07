// The agent estate drift check. Kevin, 7 Sep 2026: "I haven't really been using
// my CEO at all because I felt that he is outdated." The CEO's own file was
// fresh; the door he talked to him through, the brain files the CEO loaded
// first, the 09:00 brief worker's prompt and eight of eleven heads still carried
// rules retired weeks earlier. On 4 Sep the brief handed a credit card payment
// to Mica. Nothing errored, because a prompt cannot know it is stale.
//
// This drives the real Python against a fake estate so the three verdicts are
// proven: stale wording fires, a ruling newer than ESTATE.md's stamp fires, and
// a scan that can see almost nothing exits 2 rather than reading as clean.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/agent-estate-drift.py');
const ROOT = mkdtempSync(join(tmpdir(), 'estatedrift-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
let box;
function estate(opts = {}) {
  box = join(ROOT, String(++n));
  const agents = join(box, 'agents');
  const skills = join(box, 'skills');
  const tasks = join(box, 'tasks');
  const brain = join(box, 'brain');
  const repo = join(box, 'repo');
  // 17 strategic files + 3 skills + 5 tasks + 5 brain + 1 worker = 31 surfaces.
  mkdirSync(agents, { recursive: true });
  const heads = ['od-ceo', 'worker-writer', ...Array.from({ length: 15 }, (_, i) => `dept-${i}`)];
  for (const h of heads) writeFileSync(join(agents, `${h}.md`), `# ${h}\nRoute to the right agent.\n`);
  for (const s of ['ceo', 'huddle', 'agent-gate']) {
    mkdirSync(join(skills, s), { recursive: true });
    writeFileSync(join(skills, s, 'SKILL.md'), '# skill\nclean\n');
  }
  for (const t of ['ceo-agent', 'ceo-huddle', 'ceo-memory-sweep', 'agent-dispatch', 'task-manager-board']) {
    mkdirSync(join(tasks, t), { recursive: true });
    writeFileSync(join(tasks, t, 'SKILL.md'), '# task\nclean\n');
  }
  mkdirSync(join(brain, 'Knowledge'), { recursive: true });
  mkdirSync(join(brain, 'Decisions'), { recursive: true });
  for (const b of ['founder-profile.md', 'current-priorities.md', 'constraints-and-red-lines.md',
    'Knowledge/escalation-policy.md', 'Knowledge/daily-triage-doctrine.md']) {
    writeFileSync(join(brain, b), '# brain\nclean\n');
  }
  mkdirSync(join(repo, 'scripts', 'slack-automation'), { recursive: true });
  writeFileSync(join(repo, 'scripts/slack-automation/money-daily-worker.js'), '// clean\n');
  if (opts.stamp !== null) {
    writeFileSync(join(agents, 'ESTATE.md'), `# Estate\n\nAs at: ${opts.stamp || '2026-09-07'}\n`);
  }
  return { agents, skills, tasks, brain, repo };
}

function run(e, extra = []) {
  const r = spawnSync('python3', [SCRIPT, '--json', '--agents', e.agents, '--skills', e.skills,
    '--tasks', e.tasks, '--brain', e.brain, '--repo', e.repo, ...extra], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* cannot verify path prints no JSON body */ }
  return { code: r.status, json, stderr: r.stderr, stdout: r.stdout };
}

describe('agent-estate-drift', () => {
  it('selftest proves the retired patterns fire and the exemptions hold', () => {
    const r = spawnSync('python3', [SCRIPT, '--selftest'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/selftest ok/);
  });

  it('a clean estate with a current stamp exits 0', () => {
    const r = run(estate());
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.hits, JSON.stringify(r.json.hits)).toEqual([]);
    expect(r.json.rulings_behind).toEqual([]);
    expect(r.json.files_scanned).toBeGreaterThanOrEqual(20);
  });

  it('retired wording in a department head is a hit with the replacement named', () => {
    const e = estate();
    writeFileSync(join(e.agents, 'dept-3.md'),
      '# dept\nDelegation: AI first, then Mica or Ericamae, then Kevin.\n');
    const r = run(e);
    expect(r.code).toBe(1);
    expect(r.json.hits).toHaveLength(1);
    expect(r.json.hits[0].file).toMatch(/dept-3\.md$/);
    expect(r.json.hits[0].line).toBe(2);
    expect(r.json.hits[0].retired).toBe('2026-08-25');
    expect(r.json.hits[0].fix).toMatch(/AI only/);
  });

  it('the worker prompt is scanned too: a numbered Mica destination fires', () => {
    const e = estate();
    writeFileSync(join(e.repo, 'scripts/slack-automation/money-daily-worker.js'),
      "const system = `\n  1. AI — a named agent.\n  2. Mica — operations work.\n`;\n");
    const r = run(e);
    expect(r.code).toBe(1);
    expect(r.json.hits.map((h) => h.line)).toEqual([3]);
  });

  it('a Lessons line and a line quoting the old rule as history are exempt, even with retired wording', () => {
    // Both lines carry a RETIRED pattern ("under £50 act", "over £250 escalate"), so
    // this fails if either exemption is deleted (review finding, 7 Sep 2026: the
    // first fixture matched no pattern and could not fail).
    const e = estate();
    writeFileSync(join(e.agents, 'dept-4.md'),
      '# dept\n## Lessons from Kevin\n- 2026-08-27: something — under £50 act\n' +
      'Previous rule, kept for history: under £50 act; over £250 escalate.\n');
    const r = run(e);
    expect(r.code, JSON.stringify(r.json && r.json.hits)).toBe(0);
  });

  it('a history word AFTER a stale rule does not exempt it', () => {
    const e = estate();
    writeFileSync(join(e.agents, 'dept-5.md'),
      '# dept\nDelegation: AI first, then Mica or Ericamae, then Kevin (Slack cards retired 1 Sep).\n');
    const r = run(e);
    expect(r.code).toBe(1);
    expect(r.json.hits.map((h) => h.line)).toEqual([2]);
  });

  it('a ruling in Decisions/ newer than the stamp that touches the estate fires', () => {
    const e = estate({ stamp: '2026-09-01' });
    writeFileSync(join(e.brain, 'Decisions', '2026-09-05 Weather.md'), '# rain\nUmbrellas.\n');
    writeFileSync(join(e.brain, 'Decisions', '2026-09-06 Approval gate change.md'),
      '# gate\nAgents now route differently.\n');
    const r = run(e);
    expect(r.code).toBe(1);
    expect(r.json.rulings_behind).toEqual(['2026-09-06 Approval gate change.md']);
  });

  it('a ruling dated on the stamp day fires unless ESTATE.md names it as absorbed', () => {
    // A day-granular stamp cannot see a second ruling written later the same day
    // (review finding, 7 Sep 2026). Naming the file is the proof it was folded in.
    const e = estate({ stamp: '2026-09-07' });
    writeFileSync(join(e.brain, 'Decisions', '2026-09-07 Agent levels.md'), '# agents\nlevels\n');
    const before = run(e);
    expect(before.code).toBe(1);
    expect(before.json.rulings_behind).toEqual(['2026-09-07 Agent levels.md']);
    writeFileSync(join(e.agents, 'ESTATE.md'),
      '# Estate\n\nAs at: 2026-09-07\nAbsorbed today: 2026-09-07 Agent levels\n');
    expect(run(e).code).toBe(0);
  });

  it('CONTROL: an absent brain (Drive unmounted) exits 2, never "0 rulings behind"', () => {
    const e = estate();
    rmSync(e.brain, { recursive: true, force: true });
    const r = run(e);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/CANNOT VERIFY/);
    expect(r.stderr).toMatch(/founder-profile/);
  });

  it('CONTROL: a missing Decisions/ folder alone exits 2', () => {
    const e = estate();
    rmSync(join(e.brain, 'Decisions'), { recursive: true, force: true });
    expect(run(e).code).toBe(2);
  });

  it('a missing ESTATE.md is an exception, never a pass', () => {
    const r = run(estate({ stamp: null }));
    expect(r.code).toBe(1);
    expect(r.json.hits[0].fix).toMatch(/ESTATE\.md missing/);
  });

  it('CONTROL: too few readable surfaces exits 2, not 0', () => {
    const e = estate();
    rmSync(e.agents, { recursive: true, force: true });
    mkdirSync(e.agents);
    writeFileSync(join(e.agents, 'ESTATE.md'), 'As at: 2026-09-07\n');
    const r = run(e);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/CANNOT VERIFY/);
  });
});
