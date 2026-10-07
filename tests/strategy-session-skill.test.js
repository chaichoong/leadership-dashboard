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
  ['Nothing on the plan carries forward unread', 'every section is reviewed every quarter'],
  ['Phase 5 does not start until all ten have one', 'no write before every section has a ruling'],
  ['Send Kevin the PDF with SendUserFile', 'Kevin sees the finished plan'],
  ['The overarching reason the business exists', 'the Objective is not the quarter\'s goal'],
  ['never in\nthe Objective plan', 'quarter-only content stays out of the Objective plan'],
  ['Why a customer chooses this business over anyone else', 'selling points are written from the customer\'s side'],
  ['Starting a business from scratch', 'a new business is taken through the wizard\'s questions'],
  ['Every target shows its measurables', 'measurables under the one, three and nine-year targets'],
  ['start from what this quarter will deliver, then set one year, then three, then\nnine', 'targets are worked back from the quarter'],
  ['Does the plan fund itself after Kevin is paid?', 'the cash check against his minimum take-home'],
  ['nothing improves on today', 'the cash check shows the case where nothing lands'],
  ['A confidence percentage on every row of the ladder', 'Kevin signs off knowing the odds'],
  ['What is not in the numbers', 'tax and the other gaps are stated, never hidden'],
  ['A correction ripples', 'earlier approved sections are re-checked after a correction'],
  ['Check a count before repeating it', 'stale counts are read live'],
  ['write each section as it is ruled', 'an existing record is updated section by section'],
  ['Growth by gates, not dates', 'nothing scales until it is optimised'],
  ['Keep the measurables the dashboard reads', 'a rewritten target does not orphan a KPI'],
  ['node scripts/render-strategy-plan.cjs --record', 'the plan PDF comes from the page\'s own export'],
  ['A mid-quarter review date', 'the review date in the write-back'],
  ['Never in this repo', 'private working files stay out of the public repo'],
  // Kevin, 2 Oct 2026: one process. The session asks, and on his yes builds the KPIs itself.
  ['Ask Kevin once whether to update the dashboard now', 'the session asks before any dashboard build'],
  ['Phase 6b: build the KPIs in this session (only on Kevin\'s yes)', 'the KPI build runs inside the session'],
  ['following `/build-feature` from its Phase 2', 'dashboard KPI code still goes through the build workflow and its merge gate'],
  ['Reproduce every "today" figure from live data before any code is written', 'a rule is proven against the signed-off figure first'],
  ['no tenant name, no address', 'private names stay out of the public repo'],
  ['Prove it on the live page', 'the cards are checked live against the approved figures'],
  ['**Coming off:**', 'last quarter\'s KPIs are closed off the dashboard, not left behind'],
  ['A KPI that is not built is a task, never a remembered promise', 'unbuilt dashboard KPI work is tracked'],
  ['every "coming off" KPI has gone', 'the mid-quarter check that the changeover happened'],
  // Kevin, 7 Oct 2026: the rule of three, and the session helps him fill his open slots.
  ['Kevin owns at most three open projects at once, across every business', 'his capacity limit across businesses'],
  ['does not\n  use one of his slots', 'projects Roy or an agent owns leave his slots free'],
  ['Sessions run **Real Estate first**', 'the order of the sessions'],
  ['Slots used: N of 3', 'the slot count is stated'],
  ['Kevin as owner uses one of his three slots', 'the owner rule counts his slots'],
  ["Phase 8: Kevin's open slots", 'the open-slot decision is part of the session'],
  ['An empty slot is a decision, never a default', 'a free slot is ruled on, not left'],
  ['is not offered unless Kevin reopens it', 'a parked business is not offered behind his ruling'],
];

describe('strategy-session skill', () => {
  const skill = readFileSync(SKILL, 'utf8');

  it.each(CLAUSES)('keeps %s', (phrase, loses) => {
    expect(skill, `SKILL.md no longer states: ${loses}`).toContain(phrase);
  });

  it('names only files that exist', () => {
    const named = [...new Set(skill.match(/(?:scripts|js|os\/strategy)\/[\w./-]+\.(?:js|mjs|cjs|py|html)/g))];
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
    // The skill points at the dashboard's slot count; keep it there.
    expect(skill).toContain('renderStrategicCapacity');
    expect(readFileSync(resolve(ROOT, 'js/dashboard.js'), 'utf8')).toContain('function renderStrategicCapacity');
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

  // The skill's section meanings are taken from the page's wizard. If the wizard gains,
  // loses or renames a section, the skill's table must change with it.
  it('defines every section the page\'s wizard asks about', () => {
    const strategy = readFileSync(resolve(ROOT, 'os/strategy/strategy.js'), 'utf8');
    const block = strategy.slice(strategy.indexOf('const WIZARD_STEPS'), strategy.indexOf('\n];', strategy.indexOf('const WIZARD_STEPS')));
    const labels = [...block.matchAll(/label: '([^']+)'/g)].map(m => m[1]);
    expect(labels.length).toBeGreaterThan(30);
    const sections = new Set(labels
      .filter(l => !/^QP\d|Measurable|reflection/i.test(l))
      .map(l => l.replace(/ \(.*\)$/, '').replace(/^Quarterly Project \d$/, 'Quarterly projects').replace('—', ':').replace('Target : ', 'Target: ')));
    const table = skill.slice(skill.indexOf('| Section | What it holds'), skill.indexOf('The first seven sections'));
    for (const name of sections) {
      expect(table.toLowerCase(), `the skill has no meaning for the wizard section "${name}"`).toContain(name.toLowerCase());
    }
    // And the wizard still describes the Objective the way the skill says it does.
    expect(block).toContain('the overarching reason the business exists');
  });

  // Drives the page's real export through the render script. The first run's PDF left out
  // each project's target and owner, and Kevin never saw the finished plan at all.
  describe('the plan PDF', () => {
    const { renderPlanHtml } = require('../scripts/render-strategy-plan.cjs');
    const src = readFileSync(resolve(ROOT, 'js/config.js'), 'utf8');
    const ids = key => src.slice(src.indexOf(key)).match(/fld\w{14}/g);
    const [kpiName, kpiUnit, kpiTarget, owner, tracking, dod] = ids('qpDetails: [');
    const [objective] = ids("objective:      '");
    const [qp1] = ids('quarterlyProjects');
    const fields = {
      [objective]: 'Optimise the portfolio.', [qp1]: 'Fill the named units.',
      [kpiName]: 'Named units let', [kpiUnit]: 'units', [kpiTarget]: 4,
      [owner]: { id: 'usrX', email: 'owner@example.com', name: 'Test Owner' },
      [tracking]: 'Counted by hand.', [dod]: 'Four units let.',
    };

    it('prints each project\'s KPI target and owner', () => {
      const html = renderPlanHtml(fields, 'Test Business', 'Q4', 2026);
      expect(html).toContain('Test Business');
      expect(html).toContain('<strong>Target:</strong> 4 units');
      expect(html).toContain('<strong>Owner:</strong> Test Owner');
      expect(html).toContain('Optimise the portfolio.');
    });

    it('writes a money target as pounds first, and omits a blank owner', () => {
      const html = renderPlanHtml({ ...fields, [kpiUnit]: '£ a month', [kpiTarget]: 2693, [owner]: null }, 'Test Business', 'Q4', 2026);
      expect(html).toContain('<strong>Target:</strong> £2,693 a month');
      expect(html).not.toContain('<strong>Owner:</strong>');
    });
  });
});
