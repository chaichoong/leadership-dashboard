import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const RUNNER = resolve(ROOT, 'scripts/handback-poll-run.sh');
const SKILL = resolve(ROOT, '.claude/scheduled-tasks/agent-dispatch/SKILL.md');

// THE LEARNING LOOP (26 Aug 2026).
//
// Kevin asked how he could tell his approval feedback was reaching the agent
// and making it better. Measured that day: it was not. Feedback reached the
// agent for the ONE task and was then wiped by the next submit, and 47 of the
// 60 pieces of feedback he had ever given were rejections, which never reach an
// agent at all because rejecting closes the task and the dispatch queue only
// reads Today/Overdue. The rule telling agents to record a lesson was prose in
// a skill file with nothing checking it: 54 redos in three days, zero lessons
// stored, 14 of 15 register Learning Logs empty, and not one of the 20 agent
// files carrying a `## Lessons from Kevin` section.
//
// So the write lives in code now. These tests cover the ways it could go
// quietly wrong again — the wrong file, the wrong place in the file, a
// duplicate on retry, or a step nobody runs.

/** Call a function inside agent-dispatch.py with AGENT_DIR pointed at a temp
 *  directory. Imports the REAL module rather than copying its logic, so a
 *  rewrite of the writer cannot leave these tests passing against a ghost. */
function py(code) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("ad", ${JSON.stringify(DISPATCH)})
ad = importlib.util.module_from_spec(spec)
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec.loader.exec_module(ad)
${code}
`;
  return execFileSync('/usr/bin/python3', ['-c', script], { encoding: 'utf8' });
}

function agentDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-lessons-'));
  for (const [name, body] of Object.entries(files || {})) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

const FRONTMATTER = `---
name: worker-writer
description: drafts copy
---

You draft copy for Kevin.

## How you work

Short sentences. UK English.
`;

describe('the lesson line', () => {
  it('is dated, names the task, and keeps Kevin\'s words', () => {
    const out = py(`print(ad.lesson_line("2026-08-26", "INBOUND: Suffolk fire safety", "Roy deals with these directly"))`);
    expect(out.trim()).toBe('- 2026-08-26: INBOUND: Suffolk fire safety — Roy deals with these directly');
  });

  it('collapses newlines so one lesson stays one line', () => {
    // A Slack reply arrives with hard wraps. A lesson split across lines would
    // read as several half-rules in the agent's prompt.
    const out = py(`print(repr(ad.lesson_line("2026-08-26", "Task", "first line\\n\\nsecond line")))`);
    expect(out).toContain('first line second line');
    expect(out.match(/\\n/g)).toBeNull();
  });

  it('survives an empty task name rather than crashing the run', () => {
    const out = py(`print(ad.lesson_line("2026-08-26", "", "some rule"))`);
    expect(out.trim()).toBe('- 2026-08-26: untitled task — some rule');
  });
});

describe('writing the lesson into the agent file', () => {
  it('creates the heading on first use and appends the line', () => {
    const dir = agentDir({ 'worker-writer.md': FRONTMATTER });
    py(`ad.AGENT_DIR = ${JSON.stringify(dir)}
print(json.dumps(ad.append_lesson_to_file("worker-writer", "- 2026-08-26: A — rule one")))`);
    const text = readFileSync(join(dir, 'worker-writer.md'), 'utf8');
    expect(text).toContain('## Lessons from Kevin');
    expect(text).toContain('- 2026-08-26: A — rule one');
    // The frontmatter is the agent's identity — never touched.
    expect(text.startsWith('---\nname: worker-writer')).toBe(true);
  });

  it('appends INSIDE the lessons section when a later section follows it', () => {
    // The orphan bug: appending at end-of-file is right only while Lessons is
    // the last section, and silently wrong the moment it is not. An orphaned
    // line still LOOKS stored, which is the failure mode that hides longest.
    const dir = agentDir({
      'worker-writer.md': FRONTMATTER
        + '\n## Lessons from Kevin\n\n- 2026-08-01: Old — first rule\n\n## Escalation\n\nAsk Kevin.\n',
    });
    py(`ad.AGENT_DIR = ${JSON.stringify(dir)}
ad.append_lesson_to_file("worker-writer", "- 2026-08-26: New — second rule")`);
    const text = readFileSync(join(dir, 'worker-writer.md'), 'utf8');
    const lesson = text.indexOf('- 2026-08-26: New — second rule');
    const escalation = text.indexOf('## Escalation');
    expect(lesson).toBeGreaterThan(-1);
    expect(lesson).toBeLessThan(escalation);
    expect(text).toContain('- 2026-08-01: Old — first rule');
  });

  it('is idempotent — a retry after a crash cannot duplicate the lesson', () => {
    const dir = agentDir({ 'worker-writer.md': FRONTMATTER });
    const line = '- 2026-08-26: A — rule one';
    py(`ad.AGENT_DIR = ${JSON.stringify(dir)}
ad.append_lesson_to_file("worker-writer", ${JSON.stringify(line)})
r = ad.append_lesson_to_file("worker-writer", ${JSON.stringify(line)})
print(json.dumps(r))`);
    const text = readFileSync(join(dir, 'worker-writer.md'), 'utf8');
    expect(text.split(line).length - 1).toBe(1);
  });

  it('counts the lessons so a crowded log can be flagged for distilling', () => {
    const many = Array.from({ length: 5 }, (_, i) => `- 2026-08-0${i + 1}: T${i} — rule ${i}`).join('\n');
    const dir = agentDir({ 'worker-writer.md': `${FRONTMATTER}\n## Lessons from Kevin\n\n${many}\n` });
    const out = py(`ad.AGENT_DIR = ${JSON.stringify(dir)}
print(json.dumps(ad.append_lesson_to_file("worker-writer", "- 2026-08-26: New — sixth rule")))`);
    expect(JSON.parse(out).lessonCount).toBe(6);
  });

  it('RAISES on a missing agent file instead of dropping the lesson', () => {
    // A lesson with nowhere to land must become a visible problem. Swallowing
    // it is how the previous version managed to store nothing at all.
    const dir = agentDir({});
    expect(() => py(`ad.AGENT_DIR = ${JSON.stringify(dir)}
ad.append_lesson_to_file("no-such-agent", "- 2026-08-26: A — rule")`)).toThrow();
  });
});

describe('every agent it can write to actually exists', () => {
  it('each dispatchable agent maps to a real definition file', () => {
    // ALL_AGENTS is the routing table. An entry with no file means every
    // lesson for that agent fails — better caught here than at 2am.
    const out = py(`
import os
missing = [v["agent"] for v in ad.ALL_AGENTS.values()
           if not os.path.exists(os.path.join(ad.AGENT_DIR, v["agent"] + ".md"))]
print(json.dumps(missing))`);
    expect(JSON.parse(out)).toEqual([]);
  });
});

describe('the loop is wired up, not just written', () => {
  const runner = readFileSync(RUNNER, 'utf8');
  const skill = readFileSync(SKILL, 'utf8');
  const dispatch = readFileSync(DISPATCH, 'utf8');

  it('the 30-minute poll stores lessons BEFORE the gate can exit early', () => {
    // A "reject and remember" is usually the last thing Kevin does before
    // closing the queue, so the tick that follows it is an idle one. Behind
    // the gate, every lesson would wait for the next run with real work.
    const lessons = runner.indexOf('agent-dispatch.py" lessons');
    const gate = runner.indexOf('POLL" gate');
    expect(lessons).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(lessons).toBeLessThan(gate);
  });

  it('verify fails the run on a lesson that was never stored', () => {
    expect(dispatch).toMatch(/lesson NOT stored/);
    expect(dispatch).toMatch(/overdue_lessons/);
  });

  it('the control refuses to read a renamed field as "nothing to do"', () => {
    // The silent-zero failure: a filterByFormula on a renamed field returns
    // 200 OK with no rows, and an empty pending list looks identical to a
    // healthy one for ever.
    expect(dispatch).toMatch(/CONTROL FAILED/);
  });

  it('the skill hands the write to the script rather than asking for it', () => {
    expect(skill).toMatch(/agent-dispatch\.py lessons/);
    // The old instruction told the dispatcher to append the line itself. That
    // is exactly what produced nothing, so it must not come back.
    expect(skill).not.toMatch(/append to `fldBdnKB1U4jZM0Jj`/);
  });

  it('submit archives the feedback before clearing it', () => {
    const archive = dispatch.indexOf('ARCHIVE BEFORE THE WIPE');
    expect(archive).toBeGreaterThan(-1);
    expect(dispatch).toMatch(/feedbackHistory/);
  });

  it('submit does not clear a remember flag whose lesson is still pending', () => {
    // A fast redo can resubmit inside the 30-minute poll. Clearing the flag
    // unconditionally would drop exactly the lessons from the fastest agents.
    expect(dispatch).toMatch(/RESET THE REMEMBER CYCLE, BUT ONLY ONCE THE LESSON IS SAFE/);
    expect(dispatch).toMatch(/if str\(tf\.get\(AF\["lessonWrittenAt"\]\) or ""\)\.strip\(\)/);
  });
});
