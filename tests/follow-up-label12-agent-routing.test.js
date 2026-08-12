// Label 12 ("Kevin to respond") must route to the AI agents, never to Kevin.
//
// Kevin's instruction, 12 Aug 2026: when Mica selects "Kevin to respond" in
// Inbound Comms, the task no longer goes to Kevin's plate. It is created with
// Team Member = AI CEO (Dan Martell) and NO Assignee, so the agent dispatch
// engine (scripts/agent-dispatch.py) picks it up, the CEO triages it to the
// right agent, and the prepared work reaches Kevin as a task approval.
//
// Regressions to fear, each caught below:
//  - getAssigneeForLabel quietly returning Kevin's user ID again for label 12
//    (the task would look created, nobody would error, the agent queue would
//    never see it).
//  - "has a Team Member link" being read as "an agent owns it": the Team
//    Members table holds humans too, so that mistake orphans human-owned
//    tasks moved to label 12 (assignee cleared, no agent seeded).
//  - a task re-routed to the agents keeping a status the dispatch queue
//    cannot see (it only reads Today/Overdue).
//  - a 12 → 13 move leaving the AI CEO link on a maintenance ticket, so the
//    agents and the contractor flow both own one job.
//
// The real source is extracted and evaluated (the tests/follow-up-init-errors
// pattern) so this can never pass against a stale copy.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../follow-up.html'), 'utf8');
const DISPATCH = readFileSync(resolve(__dirname, '../scripts/agent-dispatch.py'), 'utf8');
const CONFIG = readFileSync(resolve(__dirname, '../js/config.js'), 'utf8');

function extract(name) {
  let start = SRC.indexOf(`async function ${name}(`);
  if (start === -1) start = SRC.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in follow-up.html`);
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`could not parse ${name}`);
}

function constant(name) {
  const m = SRC.match(new RegExp(`const ${name} = '([^']+)'`));
  if (!m) throw new Error(`${name} not found in follow-up.html`);
  return m[1];
}

// The AI-agent roster Set literal, parsed from the real source.
function rosterFromSource() {
  const start = SRC.indexOf('const AI_AGENT_TEAM_MEMBER_RECS = new Set([');
  if (start === -1) throw new Error('AI_AGENT_TEAM_MEMBER_RECS not found in follow-up.html');
  const end = SRC.indexOf(']);', start);
  const ids = SRC.slice(start, end).match(/'(rec[A-Za-z0-9]{14})'/g) || [];
  return new Set(ids.map(s => s.replace(/'/g, '')));
}

const KEVIN_USR = constant('AIRTABLE_ASSIGNEE_KEVIN');
const MICA_USR = constant('AIRTABLE_ASSIGNEE_DEFAULT');
const CEO_REC = constant('AI_CEO_TEAM_MEMBER_REC');
const TEAM_MEMBER_FIELD = constant('AIRTABLE_TEAM_MEMBER_FIELD');
const AGENT_ROSTER = rosterFromSource();

// eslint-disable-next-line no-new-func
const isAgentRoutedLabel = new Function(
  `${extract('isAgentRoutedLabel')}; return isAgentRoutedLabel;`
)();

// eslint-disable-next-line no-new-func
const getAssigneeForLabel = new Function(
  'AIRTABLE_ASSIGNEE_KEVIN', 'AIRTABLE_ASSIGNEE_DEFAULT', 'isAgentRoutedLabel',
  `${extract('getAssigneeForLabel')}; return getAssigneeForLabel;`
)(KEVIN_USR, MICA_USR, isAgentRoutedLabel);

// eslint-disable-next-line no-new-func
const isAgentOwned = new Function(
  'AI_AGENT_TEAM_MEMBER_RECS',
  `${extract('isAgentOwned')}; return isAgentOwned;`
)(AGENT_ROSTER);

describe('label 12 ownership routing', () => {
  it('never assigns label 12 to Kevin — the AI agents own it', () => {
    expect(getAssigneeForLabel('12: Kevin to Respond')).toBeNull();
    expect(getAssigneeForLabel('12. Kevin to Respond')).toBeNull();
  });

  it('marks label 12 as agent-routed, and only label 12', () => {
    expect(isAgentRoutedLabel('12: Kevin to Respond')).toBe(true);
    expect(isAgentRoutedLabel('8: Task Created')).toBe(false);
    expect(isAgentRoutedLabel('13: Maintenance')).toBe(false);
  });

  it('keeps Mica as the default and label 13 unassigned', () => {
    expect(getAssigneeForLabel('8: Task Created')).toBe(MICA_USR);
    expect(getAssigneeForLabel('13: Maintenance')).toBeNull();
  });

  it('a human Team Member link is NOT agent ownership', () => {
    expect(isAgentOwned(['recHumanTeamRow00'])).toBe(false);
    expect(isAgentOwned([CEO_REC])).toBe(true);
    expect(isAgentOwned([])).toBe(false);
    expect(isAgentOwned(undefined)).toBe(false);
  });
});

describe('the Supabase shadow twin carries the same routing', () => {
  // follow-up-supabase.html writes to the SAME Airtable base, so an old copy
  // of the routing there mints Kevin-assigned label-12 tasks the dispatch
  // engine never sees.
  const TWIN = readFileSync(resolve(__dirname, '../follow-up-supabase.html'), 'utf8');

  it('routes label 12 to the agents, not Kevin', () => {
    expect(TWIN).toContain("if (isAgentRoutedLabel(labelName)) return null; // agent-routed, not Kevin");
    expect(TWIN).not.toContain("return AIRTABLE_ASSIGNEE_KEVIN;");
  });

  it('knows the agent roster and the agent-routed health check', () => {
    expect(TWIN).toContain('AI_AGENT_TEAM_MEMBER_RECS');
    expect(TWIN).toContain('healthCheckAgentRoutedTask');
    expect(TWIN).not.toContain('healthCheckKevinTask');
  });
});

describe('constant drift vs agent-dispatch.py and config.js', () => {
  it('AI CEO record ID matches CEO_REC_ID in agent-dispatch.py', () => {
    const m = DISPATCH.match(/CEO_REC_ID = "([^"]+)"/);
    expect(m).not.toBeNull();
    expect(CEO_REC).toBe(m[1]);
  });

  it('agent roster matches the AGENTS dict in agent-dispatch.py exactly', () => {
    const dispatchIds = new Set(
      (DISPATCH.match(/"(rec[A-Za-z0-9]{14})":\s*\{"name": "AI /g) || [])
        .map(s => s.match(/rec[A-Za-z0-9]{14}/)[0])
    );
    expect(dispatchIds.size).toBeGreaterThan(0); // control: the parse works
    expect([...AGENT_ROSTER].sort()).toEqual([...dispatchIds].sort());
  });

  it('Team Member field ID matches config.js TASK_FIELDS.teamMember', () => {
    const block = CONFIG.slice(CONFIG.indexOf('const TASK_FIELDS = {'));
    const m = block.slice(0, block.indexOf('};')).match(/teamMember:\s*'([^']+)'/);
    expect(m).not.toBeNull();
    expect(TEAM_MEMBER_FIELD).toBe(m[1]);
  });
});

// The transition handler itself, with its Airtable writes stubbed out.
function loadHandler(deps) {
  const body = [
    extract('isAgentRoutedLabel'),
    extract('getAssigneeForLabel'),
    extract('isAgentOwned'),
    extract('isTaskLinkedLabel'),
    extract('isSourceTaskLabel'),
    extract('isCompletionLabel'),
    extract('handleLabelTransitionSync'),
    'return handleLabelTransitionSync;',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'AIRTABLE_ASSIGNEE_KEVIN', 'AIRTABLE_ASSIGNEE_DEFAULT', 'AI_CEO_TEAM_MEMBER_REC', 'AI_AGENT_TEAM_MEMBER_RECS',
    'findExistingAirtableTask', 'createAirtableTask', 'updateAirtableTaskAssignee',
    'reopenAirtableTask', 'completeAirtableTask', 'showSuccess', 'truncate',
    body
  );
  return factory(
    KEVIN_USR, MICA_USR, CEO_REC, AGENT_ROSTER,
    deps.findExistingAirtableTask, deps.createAirtableTask, deps.updateAirtableTaskAssignee,
    deps.reopenAirtableTask, deps.completeAirtableTask,
    () => {}, (s) => String(s || '')
  );
}

const EMAIL = { threadId: 't123', subject: 'Tenant query' };

function stubs(overrides) {
  return {
    findExistingAirtableTask: async () => null,
    createAirtableTask: vi.fn(async () => true),
    updateAirtableTaskAssignee: vi.fn(async () => true),
    reopenAirtableTask: vi.fn(async () => true),
    completeAirtableTask: vi.fn(async () => true),
    ...overrides,
  };
}

describe('handleLabelTransitionSync → label 12', () => {
  it('creates a new task owned by the AI CEO with no assignee', async () => {
    const deps = stubs({});
    const handler = loadHandler(deps);
    await handler(EMAIL, '2: Awaiting Reply', '12: Kevin to Respond');
    expect(deps.createAirtableTask).toHaveBeenCalledTimes(1);
    const opts = deps.createAirtableTask.mock.calls[0][1];
    expect(opts.assigneeId).toBeNull();
    expect(opts.teamMemberIds).toEqual([CEO_REC]);
  });

  it('moves an open Mica task to the AI CEO (clears assignee, links agent)', async () => {
    const deps = stubs({
      findExistingAirtableTask: async () => ({ id: 'rec1', assigneeId: MICA_USR, teamMemberIds: [], status: 'Today' }),
    });
    const handler = loadHandler(deps);
    await handler(EMAIL, '8: Task Created', '12: Kevin to Respond');
    expect(deps.updateAirtableTaskAssignee).toHaveBeenCalledWith('rec1', null,
      expect.objectContaining({ teamMemberIds: [CEO_REC], agentOwned: true }));
  });

  it('seeds the AI CEO even when a HUMAN Team Member link exists', async () => {
    const deps = stubs({
      findExistingAirtableTask: async () => ({ id: 'rec1', assigneeId: null, teamMemberIds: ['recHumanTeamRow00'], status: 'Today' }),
    });
    const handler = loadHandler(deps);
    await handler(EMAIL, '8: Task Created', '12: Kevin to Respond');
    expect(deps.updateAirtableTaskAssignee).toHaveBeenCalledWith('rec1', null,
      expect.objectContaining({ teamMemberIds: [CEO_REC] }));
  });

  it('does not restart triage when an AI agent already owns the task', async () => {
    const deptAgent = [...AGENT_ROSTER].find(id => id !== CEO_REC);
    const deps = stubs({
      findExistingAirtableTask: async () => ({ id: 'rec1', assigneeId: null, teamMemberIds: [deptAgent], status: 'Today' }),
    });
    const handler = loadHandler(deps);
    await handler(EMAIL, '8: Task Created', '12: Kevin to Respond');
    expect(deps.updateAirtableTaskAssignee).not.toHaveBeenCalled();
  });

  it('bumps a non-queue status to Today so the dispatch engine can see it', async () => {
    const deps = stubs({
      findExistingAirtableTask: async () => ({ id: 'rec1', assigneeId: null, teamMemberIds: [], status: 'Upcoming' }),
    });
    const handler = loadHandler(deps);
    await handler(EMAIL, '13: Maintenance', '12: Kevin to Respond');
    expect(deps.updateAirtableTaskAssignee).toHaveBeenCalledWith('rec1', null,
      expect.objectContaining({ teamMemberIds: [CEO_REC], status: 'Today' }));
  });
});

describe('handleLabelTransitionSync → humans take a task back', () => {
  it('hands an agent-owned task back to Mica on a move to label 8', async () => {
    const deps = stubs({
      findExistingAirtableTask: async () => ({ id: 'rec1', assigneeId: null, teamMemberIds: [CEO_REC], status: 'Today' }),
    });
    const handler = loadHandler(deps);
    await handler(EMAIL, '12: Kevin to Respond', '8: Task Created');
    expect(deps.updateAirtableTaskAssignee).toHaveBeenCalledWith('rec1', MICA_USR,
      expect.objectContaining({ teamMemberIds: [], agentOwned: false }));
  });

  it('strips ONLY agent links on take-back, keeping human ones', async () => {
    const deps = stubs({
      findExistingAirtableTask: async () => ({ id: 'rec1', assigneeId: null, teamMemberIds: [CEO_REC, 'recHumanTeamRow00'], status: 'Today' }),
    });
    const handler = loadHandler(deps);
    await handler(EMAIL, '12: Kevin to Respond', '8: Task Created');
    expect(deps.updateAirtableTaskAssignee).toHaveBeenCalledWith('rec1', MICA_USR,
      expect.objectContaining({ teamMemberIds: ['recHumanTeamRow00'] }));
  });

  it('a 12 → 13 move strips the agent link (maintenance is contractor territory)', async () => {
    const deps = stubs({
      findExistingAirtableTask: async () => ({ id: 'rec1', assigneeId: null, teamMemberIds: [CEO_REC], status: 'Today' }),
    });
    const handler = loadHandler(deps);
    await handler(EMAIL, '12: Kevin to Respond', '13: Maintenance');
    expect(deps.updateAirtableTaskAssignee).toHaveBeenCalledWith('rec1', null,
      expect.objectContaining({ teamMemberIds: [], agentOwned: false }));
  });

  it('leaves a human-linked Mica task alone on a move to label 8 (no wasted PATCH)', async () => {
    const deps = stubs({
      findExistingAirtableTask: async () => ({ id: 'rec1', assigneeId: MICA_USR, teamMemberIds: ['recHumanTeamRow00'], status: 'Today' }),
    });
    const handler = loadHandler(deps);
    await handler(EMAIL, '12: Kevin to Respond', '8: Task Created');
    expect(deps.updateAirtableTaskAssignee).not.toHaveBeenCalled();
  });
});

describe('collaborators on agent-routed writes', () => {
  // Kevin must never be pinned to the raw task — the approval is his surface.
  function extractUpdate() {
    const calls = [];
    const body = `${extract('ownershipLabel')}\n${extract('updateAirtableTaskAssignee')}; return updateAirtableTaskAssignee;`;
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      'AIRTABLE_ASSIGNEE_DEFAULT', 'AIRTABLE_ASSIGNEE_KEVIN', 'AIRTABLE_ASSIGNEE_ERICAMAE',
      'AIRTABLE_FIELDS', 'AIRTABLE_COLLABORATORS_FIELD', 'AIRTABLE_TEAM_MEMBER_FIELD',
      'getAirtablePat', 'getAirtableBaseId', 'getAirtableTableId', 'addAuditEntry', 'fetch',
      body
    );
    const fn = factory(
      MICA_USR, KEVIN_USR, 'usrEricamae000000',
      { assignee: 'fldA', status: 'fldS' }, 'fldC', TEAM_MEMBER_FIELD,
      () => 'pat', () => 'base', () => 'table', () => {},
      async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true }; }
    );
    return { fn, calls };
  }

  it('excludes Kevin from collaborators when the agents own the task', async () => {
    const { fn, calls } = extractUpdate();
    await fn('rec1', null, { teamMemberIds: [CEO_REC], agentOwned: true });
    const collabIds = calls[0].fields.fldC.map(c => c.id);
    expect(collabIds).not.toContain(KEVIN_USR);
    expect(collabIds).toContain(MICA_USR);
  });

  it('keeps Kevin as a collaborator on human-owned writes', async () => {
    const { fn, calls } = extractUpdate();
    await fn('rec1', MICA_USR, { teamMemberIds: [], agentOwned: false });
    const collabIds = calls[0].fields.fldC.map(c => c.id);
    expect(collabIds).toContain(KEVIN_USR);
    expect(collabIds).not.toContain(MICA_USR);
  });
});
