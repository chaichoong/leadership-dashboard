import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = resolve(ROOT, '.claude/skills/strategy-session/SKILL.md');
const require = createRequire(import.meta.url);

// 2 Oct 2026. The skill was written from the first live run (Q4 2026 Real Estate). Each
// clause below is a lesson that run paid for; this test keeps a tidy-up from dropping one,
// and checks that every script, function and field map the skill points at still exists.

const CLAUSES = [
  ['Nothing is written to Airtable before Kevin\'s yes', 'the approval gate before any write'],
  ['a quarter total or a monthly average', 'the total-or-average label on every figure'],
  ['Each business\'s money stays separate from Kevin\'s personal money', 'the business and personal split'],
  ['Personal figures use the Wealth page\'s own grouping', 'one grouping for personal figures'],
  ['Name every unit, tenant, property and owner', 'the named list on every project'],
  ['under 250 words', 'the board word limit'],
  ['Never all eleven', 'only the fitting board seats'],
  ['Committed and stretch targets, each built from a named list of actions', 'how targets are built'],
  ['an AI agent, then Roy Lavin for property work, then\n  Kevin', 'the owner order'],
  ['Snapshot first, carry second', 'the quarter-close order'],
  ['by ADDING the new project', 'carry by adding, never moving'],
  ['the snapshot here, the carry in 5c', 'the two-pass close: no carry before the new projects exist'],
  ['Pass Status `Upcoming`', 'plan tasks must not land on today\'s board'],
  ['leave `Owner` blank and name the agent in the tracking method', 'an agent cannot sit in a collaborator field'],
  ['The new projects must NOT be\n   in its list', 'how the dry run proves the status'],
  ['Plan tasks pass `--force`, and each has a distinct subject', 'the duplicate-gate trap'],
  ['Read every create back by its id', 'the task read-back'],
  ['node scripts/sync-project-status.mjs', 'the status set from the shared health rule'],
  ['Send every draft to Kevin as a file, never just a path', 'drafts delivered as files'],
  ['Read every field back against\nthe approved draft', 'the read-back on the Objective & Strategy page'],
  ['A mid-quarter review date', 'the review date in the write-back'],
  ['Never in this repo', 'private working files stay out of the public repo'],
  ['is NOT built inside this skill', 'dashboard KPI code goes through /build-feature'],
  ['**Coming off:**', 'last quarter\'s KPIs are closed off the dashboard, not left behind'],
  ['The handover is a task, never a remembered promise', 'the dashboard KPI work is tracked'],
  ['every "coming off" KPI has gone', 'the mid-quarter check that the changeover happened'],
];

describe('strategy-session skill', () => {
  const skill = readFileSync(SKILL, 'utf8');

  it.each(CLAUSES)('keeps %s', (phrase, loses) => {
    expect(skill, `SKILL.md no longer states: ${loses}`).toContain(phrase);
  });

  it('names only files that exist', () => {
    const named = [...new Set(skill.match(/(?:scripts|js|os\/strategy)\/[\w./-]+\.(?:js|mjs|py|html)/g))];
    expect(named.length).toBeGreaterThan(5);
    for (const f of named) expect(existsSync(resolve(ROOT, f)), `${f} is named but missing`).toBe(true);
  });

  it('names only board seats that are real agent types', () => {
    const seats = [...new Set(skill.match(/dept-[a-z-]+/g))];
    const known = ['dept-finance', 'dept-hr', 'dept-legal-compliance', 'dept-marketing', 'dept-mindset',
      'dept-operations', 'dept-productivity', 'dept-sales', 'dept-strategy', 'dept-systemisation', 'dept-wealth'];
    expect(seats.length).toBeGreaterThan(3);
    for (const s of seats) expect(known, `${s} is not a board seat`).toContain(s);
  });

  it('points at code that still carries the names it relies on', () => {
    const strategy = readFileSync(resolve(ROOT, 'os/strategy/strategy.js'), 'utf8');
    for (const name of ['executeQuarterClose', 'openQuarterClose', 'executePush', 'PROJ_CLOSE_F', 'PROJ_F']) {
      expect(skill).toContain(name);
      expect(strategy, `strategy.js no longer defines ${name}`).toMatch(new RegExp(`(function|const) ${name}\\b`));
    }
    const config = readFileSync(resolve(ROOT, 'js/config.js'), 'utf8');
    for (const name of ['qpDetails', 'monthlyStones', 'objStrat']) expect(config).toContain(name);
    expect(readFileSync(resolve(ROOT, 'js/wealth.js'), 'utf8')).toContain('buildMonthlyCashflow');
    // The skill says a closed project's KPI leaves the dashboard on its own. Keep that true.
    expect(readFileSync(resolve(ROOT, 'js/dashboard.js'), 'utf8')).toMatch(/p\.status!=='Completed'&&!p\.closedOn/);
    const gate = readFileSync(resolve(ROOT, 'scripts/create-agent-task.py'), 'utf8');
    expect(gate).toContain('"--force"');
    // The skill tells plan tasks to pass Upcoming; the gate must still accept it.
    expect(gate).toMatch(/NEW_TASK_STATUSES = \([^)]*"Upcoming"/);
    // The carry runs as a second, carry-only pass; the page must still support one.
    expect(strategy).toContain('carryOnly');
    // The skill tells the session to overwrite this line of the page's closing note.
    expect(strategy).toContain('`Carried into ${ctx.nextQuarter}');
    expect(skill).toContain('starts "Carried into"');
    // Roy's tasks are handed over by the dispatch script, not assigned at create.
    expect(skill).toContain('scripts/agent-dispatch.py handover');
    expect(readFileSync(resolve(ROOT, 'scripts/agent-dispatch.py'), 'utf8')).toContain('handover');
  });

  // The worked example from the build gate: a project one day into a 91-day quarter with a
  // zero KPI is Not Started, not Off-Track. This is the rule the skill's status step applies.
  it('a new project with a zero KPI on day 2 is Not Started', () => {
    const { computeProjectHealth } = require('../js/project-health.js');
    expect(computeProjectHealth(
      { start: '2026-10-01', end: '2026-12-31', kpiTarget: 4, kpiCurrent: 0 }, '2026-10-02T12:00:00',
    )).toBe('Not Started');
  });
});
