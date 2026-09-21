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
//
// 21 Sep 2026: the scan also reads Kevin's global ~/.claude/CLAUDE.md and the
// project memory folder, because every session loads them before it acts and
// the memory still told sessions to route to Mica and post to #agent-approvals
// after the agent files were cleaned. Memory topic files keep history on
// purpose, so a dated SUPERSEDED marker line ends the scan of a TOPIC file;
// MEMORY.md and CLAUDE.md are fully live.
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
  const claudeMd = join(box, 'CLAUDE.md');
  const memory = join(box, 'memory');
  // 17 strategic files + 3 skills + 5 tasks + 5 brain + 1 worker = 31 surfaces,
  // plus CLAUDE.md, MEMORY.md and one topic file, which do not count toward the floor.
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
  writeFileSync(claudeMd, '# global\nAI first, Kevin last.\n');
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, 'MEMORY.md'), '- [Topic](project_topic.md) — clean.\n');
  writeFileSync(join(memory, 'project_topic.md'), '---\nname: topic\n---\nclean\n');
  return { agents, skills, tasks, brain, repo, claudeMd, memory };
}

function run(e, extra = []) {
  const r = spawnSync('python3', [SCRIPT, '--json', '--agents', e.agents, '--skills', e.skills,
    '--tasks', e.tasks, '--brain', e.brain, '--repo', e.repo,
    '--claude-md', e.claudeMd, '--memory', e.memory, ...extra], { encoding: 'utf8' });
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
    expect(r.json.memory_files_scanned).toBe(3);
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

  // The three memory-scope rules. Each uses the same retired phrase, so the only
  // thing that differs is WHERE it sits.
  const STALE = 'Delegation order: AI first, then Mica or Ericamae, then Kevin.';
  const MARKER = '**SUPERSEDED in part (noted 21 Sep 2026):** no work routes to Mica since 25 Aug 2026. The order below is history.';

  it('a retired phrase in ~/.claude/CLAUDE.md fires', () => {
    const e = estate();
    writeFileSync(e.claudeMd, `# global\n${STALE}\n`);
    const r = run(e);
    expect(r.code).toBe(1);
    expect(r.json.hits).toHaveLength(1);
    expect(r.json.hits[0].file).toBe(e.claudeMd);
    expect(r.json.hits[0].line).toBe(2);
  });

  it('the same phrase under a dated SUPERSEDED marker in a memory topic file does not fire', () => {
    const e = estate();
    writeFileSync(join(e.memory, 'feedback_old_order.md'),
      `---\nname: old\n---\nThe rule itself stands.\n\n${MARKER}\n\n${STALE}\n`);
    const r = run(e);
    expect(r.code, JSON.stringify(r.json && r.json.hits)).toBe(0);
    expect(r.json.memory_files_scanned).toBe(4);
  });

  it('in a topic file the phrase ABOVE the marker is live, and an undated marker exempts nothing', () => {
    const e = estate();
    writeFileSync(join(e.memory, 'feedback_live_above.md'), `# t\n${STALE}\n${MARKER}\n${STALE}\n`);
    writeFileSync(join(e.memory, 'feedback_undated.md'), `# t\n**SUPERSEDED:** see below.\n${STALE}\n`);
    const r = run(e);
    expect(r.code).toBe(1);
    const got = r.json.hits.map((h) => `${h.file.split('/').pop()}:${h.line}`).sort();
    expect(got).toEqual(['feedback_live_above.md:2', 'feedback_undated.md:3']);
  });

  it('the same phrase in MEMORY.md fires, even below a SUPERSEDED marker (the index is fully live)', () => {
    const e = estate();
    writeFileSync(join(e.memory, 'MEMORY.md'), `- [Topic](project_topic.md) — clean.\n${MARKER}\n${STALE}\n`);
    const r = run(e);
    expect(r.code).toBe(1);
    expect(r.json.hits).toHaveLength(1);
    expect(r.json.hits[0].file).toMatch(/memory\/MEMORY\.md$/);
    expect(r.json.hits[0].line).toBe(3);
  });

  it('CONTROL: a missing ~/.claude/CLAUDE.md or MEMORY.md exits 2, never a clean pass', () => {
    const e = estate();
    rmSync(e.claudeMd);
    const a = run(e);
    expect(a.code).toBe(2);
    expect(a.stderr).toMatch(/CLAUDE\.md/);
    const f = estate();
    rmSync(join(f.memory, 'MEMORY.md'));
    const b = run(f);
    expect(b.code).toBe(2);
    expect(b.stderr).toMatch(/MEMORY\.md/);
  });

  it('CONTROL: memory files do not count toward the estate floor', () => {
    // Two hundred memory files must not hide an emptied agents folder.
    const e = estate();
    rmSync(e.agents, { recursive: true, force: true });
    mkdirSync(e.agents);
    writeFileSync(join(e.agents, 'ESTATE.md'), 'As at: 2026-09-07\n');
    for (let i = 0; i < 30; i++) writeFileSync(join(e.memory, `project_${i}.md`), 'clean\n');
    const r = run(e);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/estate surfaces readable/);
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
