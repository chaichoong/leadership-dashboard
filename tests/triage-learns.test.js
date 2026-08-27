import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const RUNNER = resolve(ROOT, 'scripts/inbound-triage-run.sh');
const TRIAGE_PY = resolve(ROOT, 'scripts/inbound-triage.py');
const AGENT_FILE = join(process.env.HOME, '.claude/agents/inbound-comms-triage.md');

// ── THE AGENT THAT DECIDES WHAT REACHES KEVIN CAN NOW LEARN (27 Aug 2026) ──
//
// Inbound Comms Triage makes roughly forty create-or-not decisions a day, more
// consequential judgement than any other agent makes. It had a register row
// (recYy33zkoa099uM2) and a Team Members row (recCUfsTXzmVZynEI) and looked
// fully wired — but no entry in ROLE_AGENTS and no definition file, so
// `agent-dispatch.py lessons` had nowhere to land a rule for it and its
// Learning Log was permanently empty.
//
// The measured consequence: of the 58 rejections Kevin had ever made, NOT ONE
// was about the draft. Every one was a decision this agent made. "Only show me
// tasks like this if it's a major issue" landed on the agent that WROTE the
// reply, which never chose the task and cannot stop the next one.

function py(code) {
  const script = `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location("ad", ${JSON.stringify(DISPATCH)})
ad = importlib.util.module_from_spec(spec); spec.loader.exec_module(ad)
${code}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

const RESPONSE = 'recJ8J8idWE8d97tH';
const TRIAGE = 'recCUfsTXzmVZynEI';

/** Where would a lesson on this task actually land? */
function destination(name, reason, inbound) {
  return py(`
f = {ad.AF["name"]: ${JSON.stringify(name)},
     ad.AF["verdictReason"]: ${JSON.stringify(reason)},
     ad.AF["inboundTask"]: ${inbound ? 'True' : 'False'}}
target, why = ad.lesson_destination(f, ${JSON.stringify(RESPONSE)})
print(json.dumps({"agent": ad.ALL_AGENTS.get(target, {}).get("agent", ""), "why": why}))
`);
}

describe('a lesson reaches the agent that made the decision', () => {
  it('a relevance rejection on inbound work teaches TRIAGE, not the writer', () => {
    ['Roy owns it', 'Not worth my attention', 'Already done elsewhere',
     'Duplicate', 'Parked for now', 'No longer relevant'].forEach((reason) => {
      expect(destination('INBOUND: council letter', reason, true).agent, reason)
        .toBe('inbound-comms-triage');
    });
  });

  it('"The work is wrong" still teaches the agent that wrote it', () => {
    expect(destination('INBOUND: reply to SSE', 'The work is wrong', true).agent)
      .toBe('inbound-comms-response');
  });

  it('an unrecorded reason is NOT guessed at', () => {
    // Routing on a guess is how a rule ends up in a file nobody meant to change.
    expect(destination('INBOUND: reply to SSE', '', true).agent)
      .toBe('inbound-comms-response');
  });

  it('non-inbound work stays with its raiser — triage never saw it', () => {
    expect(destination('Warm lane: re-engage Andrew Bizzell', 'Roy owns it', false).agent)
      .toBe('inbound-comms-response');
  });

  it('the MAINTENANCE prefix counts as inbound even with the box unticked', () => {
    // The two disagree on the live board: some rows carry the prefix without
    // the checkbox, and those are triage's tasks just the same.
    expect(destination('MAINTENANCE: 57a West Street letter', 'Roy owns it', false).agent)
      .toBe('inbound-comms-triage');
  });
});

describe('triage can receive lessons but is never handed work', () => {
  it('is in the roster so a lesson has somewhere to land', () => {
    const roster = py('print(json.dumps({k: v["agent"] for k, v in ad.ALL_AGENTS.items()}))');
    expect(roster[TRIAGE]).toBe('inbound-comms-triage');
  });

  it('is marked dispatch:false so the CEO pass cannot hand it tasks', () => {
    // It runs its own Go Signal at 09:00/13:00/17:00. Being in ROLE_AGENTS
    // would otherwise make it dispatchable the moment its register row reads
    // Live — which it does.
    const flag = py(`print(json.dumps({"d": ad.ROLE_AGENTS[${JSON.stringify(TRIAGE)}].get("dispatch", True)}))`);
    expect(flag.d).toBe(false);
  });

  it('the dispatchable flag honours it', () => {
    const src = readFileSync(DISPATCH, 'utf8');
    expect(src).toMatch(/ROLE_AGENTS\[tm\[0\]\]\.get\("dispatch", True\)/);
  });
});

describe('the lessons file is actually READ, not merely written', () => {
  // The failure this whole loop exists to prevent: a lesson written somewhere
  // nothing opens. This runner invokes `claude -p` against SKILL.md files and
  // does not load ~/.claude/agents/ on its own.
  it('the agent definition file exists with a Lessons section', () => {
    expect(existsSync(AGENT_FILE), 'no definition file — lessons have nowhere to land').toBe(true);
    expect(readFileSync(AGENT_FILE, 'utf8')).toContain('## Lessons from Kevin');
  });

  it('the scheduled runner names that exact file in its prompt', () => {
    const runner = readFileSync(RUNNER, 'utf8');
    expect(runner).toContain('.claude/agents/inbound-comms-triage.md');
    expect(runner, 'the prompt must tell it to APPLY the lessons, not just open the file')
      .toMatch(/Lessons from Kevin/);
  });
});

describe('"already dealt with" is checked against what was actually sent', () => {
  // 41% of every rejection Kevin has ever made — the largest single group. The
  // agent could not have known: nothing in the pipeline had ever looked at the
  // sent folder.
  it('the runner pre-reads the sent check before the agent starts', () => {
    const runner = readFileSync(RUNNER, 'utf8');
    expect(runner).toMatch(/inbound-triage\.py" sentcheck/);
    expect(runner).toContain('gmail-sent.json');
  });

  it('the skill is told to use it BEFORE creating a task', () => {
    const runner = readFileSync(RUNNER, 'utf8');
    expect(runner).toMatch(/BEFORE creating a task/);
  });

  it('a failed or truncated check must not read as "nothing was answered"', () => {
    // The dangerous direction. An empty result from a broken query would send
    // the agent to draft replies to every thread Kevin has already handled.
    const runner = readFileSync(RUNNER, 'utf8');
    expect(runner).toMatch(/UNCHECKED/);
    const src = readFileSync(TRIAGE_PY, 'utf8');
    expect(src).toMatch(/CONTROL FAILED: zero sent messages/);
    expect(src).toMatch(/"truncated": truncated/);
  });

  it('the control only fires over a window long enough to mean something', () => {
    const src = readFileSync(TRIAGE_PY, 'utf8');
    expect(src).toMatch(/SENTCHECK_MIN_DAYS_FOR_CONTROL\s*=\s*3/);
  });
});
