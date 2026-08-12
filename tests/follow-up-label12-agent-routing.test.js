// Labels 8 ("task created") and 12 ("Kevin to respond") both route to the AI
// agents — the only difference is WHO approves the prepared work.
//
// Kevin's instructions, 12 Aug 2026: inbound tasks no longer land on a
// human's plate. Both labels create the task with Team Member = AI CEO
// (Dan Martell), NO Assignee, and an Approver — label 8 → Mica, label 12 →
// Kevin. The dispatch engine picks the task up, the CEO triages it, the agent
// prepares the work, and the APPROVER receives it (Kevin in #agent-approvals,
// Mica in a bot DM). Tier-1 legal/financial matters always divert to Kevin.
//
// Regressions to fear, each caught below:
//  - a label quietly assigning a human again (task looks created, agent queue
//    never sees it).
//  - "has a Team Member link" being read as "an agent owns it": the Team
//    Members table holds humans too.
//  - a task re-routed to the agents keeping a status the dispatch queue
//    cannot see (it only reads Today/Overdue).
//  - a 12 → 13 move leaving the AI CEO link on a maintenance ticket.
//  - tier-1 work routing to Mica because the Approver field said so.
//
// The real source is extracted and evaluated (the tests/follow-up-init-errors
// pattern) so this can never pass against a stale copy.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { approverFor } from '../scripts/slack-automation/approvals.js';

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
const APPROVER_FIELD = constant('AIRTABLE_APPROVER_FIELD');
const AGENT_ROSTER = rosterFromSource();

// eslint-disable-next-line no-new-func
const isAgentRoutedLabel = new Function(
  `${extract('isAgentRoutedLabel')}; return isAgentRoutedLabel;`
)();

// eslint-disable-next-line no-new-func
const getApproverForLabel = new Function(
  'AIRTABLE_ASSIGNEE_KEVIN', 'AIRTABLE_ASSIGNEE_DEFAULT',
  `${extract('getApproverForLabel')}; return getApproverForLabel;`
)(KEVIN_USR, MICA_USR);

// eslint-disable-next-line no-new-func
const isAgentOwned = new Function(
  'AI_AGENT_TEAM_MEMBER_RECS',
  `${extract('isAgentOwned')}; return isAgentOwned;`
)(AGENT_ROSTER);

describe('label ownership routing', () => {
  it('routes BOTH task labels to the agents, and only those', () => {
    expect(isAgentRoutedLabel('8: Task Created')).toBe(true);
    expect(isAgentRoutedLabel('12: Kevin to Respond')).toBe(true);
    expect(isAgentRoutedLabel('13: Maintenance')).toBe(false);
    expect(isAgentRoutedLabel('2: Awaiting Reply')).toBe(false);
  });

  it('label 8 approvals go to Mica, label 12 to Kevin', () => {
    expect(getApproverForLabel('8: Task Created')).toBe(MICA_USR);
    expect(getApproverForLabel('12: Kevin to Respond')).toBe(KEVIN_USR);
    expect(getApproverForLabel('12. Kevin to Respond')).toBe(KEVIN_USR);
    expect(getApproverForLabel('13: Maintenance')).toBeNull();
  });

  it('a human Team Member link is NOT agent ownership', () => {
    expect(isAgentOwned(['recHumanTeamRow00'])).toBe(false);
    expect(isAgentOwned([CEO_REC])).toBe(true);
    expect(isAgentOwned([])).toBe(false);
    expect(isAgentOwned(undefined)).toBe(false);
  });

  it('never assigns a task label to a human via Assignee', () => {
    // The retired getAssigneeForLabel hard-wired label 12 to Kevin's user ID.
    // Nothing in the file may resolve a label to a human ASSIGNEE again —
    // getApproverForLabel returning Kevin is the approver, not the assignee.
    expect(SRC).not.toContain('function getAssigneeForLabel');
  });
});

describe('approvals worker routing (approverFor)', () => {
  it('routes by the Approver field, defaulting to Kevin', () => {
    expect(approverFor({ approverEmail: 'micaa.work@gmail.com' }, false).name).toBe('Mica');
    expect(approverFor({ approverEmail: 'kevin@runpreneur.org.uk' }, false).name).toBe('Kevin');
    expect(approverFor({ approverEmail: '' }, false).name).toBe('Kevin');
  });

  it('tier 1 ALWAYS diverts to Kevin, whatever the field says', () => {
    expect(approverFor({ approverEmail: 'micaa.work@gmail.com' }, true).name).toBe('Kevin');
  });
});

describe('the Supabase shadow twin carries the same routing', () => {
  // follow-up-supabase.html writes to the SAME Airtable base, so an old copy
  // of the routing there mints human-assigned tasks the dispatch engine
  // never sees.
  const TWIN = readFileSync(resolve(__dirname, '../follow-up-supabase.html'), 'utf8');

  it('routes both labels to the agents with an approver', () => {
    expect(TWIN).toContain('function isAgentRoutedLabel');
    expect(TWIN).toContain('function getApproverForLabel');
    expect(TWIN).not.toContain('function getAssigneeForLabel');
  });

  it('knows the agent roster and the agent-routed health check', () => {
    expect(TWIN).toContain('AI_AGENT_TEAM_MEMBER_RECS');
    expect(TWIN).toContain('healthCheckAgentRoutedTask');
    expect(TWIN).not.toContain('healthCheckKevinTask');
  });
});

describe('the task drawer approval box works for any approver', () => {
  // Mica approves label-8 work in the SAME drawer Kevin uses. Before
  // 12 Aug 2026 the box was gated on assigneeEmail === KEVIN_EMAIL, so Mica
  // opening her own approval was told to "reassign it to yourself".
  const TASKS = readFileSync(resolve(__dirname, '../os/tasks/index.html'), 'utf8');

  it('gates the decision on the logged-in user, not a hardcoded person', () => {
    const start = TASKS.indexOf('function renderApprovalBlock(');
    expect(start).toBeGreaterThan(-1);
    const block = TASKS.slice(start, TASKS.indexOf('async function apvDecide('));
    expect(block).toContain('currentUser');
    expect(block).not.toContain('KEVIN_EMAIL');
  });
});

describe('constant drift vs agent-dispatch.py, approvals.js and config.js', () => {
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

  it('Team Member and Approver field IDs match config.js TASK_FIELDS', () => {
    const block = CONFIG.slice(CONFIG.indexOf('const TASK_FIELDS = {'));
    const body = block.slice(0, block.indexOf('};'));
    expect(TEAM_MEMBER_FIELD).toBe(body.match(/teamMember:\s*'([^']+)'/)?.[1]);
    expect(APPROVER_FIELD).toBe(body.match(/approver:\s*'([^']+)'/)?.[1]);
  });
});

// The transition handler itself, with its Airtable writes stubbed out.
function loadHandler(deps) {
  const body = [
    extract('isAgentRoutedLabel'),
    extract('getApproverForLabel'),
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

describe('handleLabelTransitionSync → agent lanes', () => {
  it('label 12 creates an AI CEO task with Kevin as approver', async () => {
    const deps = stubs({});
    const handler = loadHandler(deps);
    await handler(EMAIL, '2: Awaiting Reply', '12: Kevin to Respond');
    const opts = deps.createAirtableTask.mock.calls[0][1];
    expect(opts.assigneeId).toBeNull();
    expect(opts.teamMemberIds).toEqual([CEO_REC]);
    expect(opts.approverId).toBe(KEVIN_USR);
  });

  it('label 8 creates an AI CEO task with Mica as approver', async () => {
    const deps = stubs({});
    const handler = loadHandler(deps);
    await handler(EMAIL, 'INBOX', '8: Task Created');
    const opts = deps.createAirtableTask.mock.calls[0][1];
    expect(opts.assigneeId).toBeNull();
    expect(opts.teamMemberIds).toEqual([CEO_REC]);
    expect(opts.approverId).toBe(MICA_USR);
  });

  it('moves an open Mica-assigned task to the agents (clears assignee, links CEO)', async () => {
    const deps = stubs({
      findExistingAirtableTask: async () => ({ id: 'rec1', assigneeId: MICA_USR, teamMemberIds: [], approverId: null, status: 'Today' }),
    });
    const handler = loadHandler(deps);
    await handler(EMAIL, '2: Awaiting Reply', '8: Task Created');
    expect(deps.updateAirtableTaskAssignee).toHaveBeenCalledWith('rec1', null,
      expect.objectContaining({ teamMemberIds: [CEO_REC], agentOwned: true, approverId: MICA_USR }));
  });

  it('an 8 → 12 move on an agent-owned task changes ONLY the approver', async () => {
    const deptAgent = [...AGENT_ROSTER].find(id => id !== CEO_REC);
    const deps = stubs({
      findExistingAirtableTask: async () => ({ id: 'rec1', assigneeId: null, teamMemberIds: [deptAgent], approverId: MICA_USR, status: 'Today' }),
    });
    const handler = loadHandler(deps);
    await handler(EMAIL, '8: Task Created', '12: Kevin to Respond');
    const [, assignee, opts] = deps.updateAirtableTaskAssignee.mock.calls[0];
    expect(assignee).toBeNull();
    expect(opts.approverId).toBe(KEVIN_USR);
    expect(opts.teamMemberIds).toBeUndefined(); // never restart triage
  });

  it('does nothing when the task is already in the right shape', async () => {
    const deps = stubs({
      findExistingAirtableTask: async () => ({ id: 'rec1', assigneeId: null, teamMemberIds: [CEO_REC], approverId: KEVIN_USR, status: 'Today' }),
    });
    const handler = loadHandler(deps);
    await handler(EMAIL, '8: Task Created', '12: Kevin to Respond');
    expect(deps.updateAirtableTaskAssignee).not.toHaveBeenCalled();
  });

  it('seeds the AI CEO even when a HUMAN Team Member link exists', async () => {
    const deps = stubs({
      findExistingAirtableTask: async () => ({ id: 'rec1', assigneeId: null, teamMemberIds: ['recHumanTeamRow00'], approverId: null, status: 'Today' }),
    });
    const handler = loadHandler(deps);
    await handler(EMAIL, '2: Awaiting Reply', '12: Kevin to Respond');
    expect(deps.updateAirtableTaskAssignee).toHaveBeenCalledWith('rec1', null,
      expect.objectContaining({ teamMemberIds: [CEO_REC] }));
  });

  it('bumps a non-queue status to Today so the dispatch engine can see it', async () => {
    const deps = stubs({
      findExistingAirtableTask: async () => ({ id: 'rec1', assigneeId: null, teamMemberIds: [], approverId: null, status: 'Upcoming' }),
    });
    const handler = loadHandler(deps);
    await handler(EMAIL, '13: Maintenance', '12: Kevin to Respond');
    expect(deps.updateAirtableTaskAssignee).toHaveBeenCalledWith('rec1', null,
      expect.objectContaining({ teamMemberIds: [CEO_REC], status: 'Today' }));
  });

  it('a 12 → 13 move strips agent links but keeps human ones (maintenance is contractor territory)', async () => {
    const deps = stubs({
      findExistingAirtableTask: async () => ({ id: 'rec1', assigneeId: null, teamMemberIds: [CEO_REC, 'recHumanTeamRow00'], approverId: KEVIN_USR, status: 'Today' }),
    });
    const handler = loadHandler(deps);
    await handler(EMAIL, '12: Kevin to Respond', '13: Maintenance');
    expect(deps.updateAirtableTaskAssignee).toHaveBeenCalledWith('rec1', null,
      expect.objectContaining({ teamMemberIds: ['recHumanTeamRow00'], agentOwned: false }));
  });
});

describe('collaborators on ownership writes', () => {
  // Kevin must never be pinned to the raw agent task — the approval is his surface.
  function extractUpdate() {
    const calls = [];
    const body = `${extract('ownershipLabel')}\n${extract('updateAirtableTaskAssignee')}; return updateAirtableTaskAssignee;`;
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      'AIRTABLE_ASSIGNEE_DEFAULT', 'AIRTABLE_ASSIGNEE_KEVIN', 'AIRTABLE_ASSIGNEE_ERICAMAE',
      'AIRTABLE_FIELDS', 'AIRTABLE_COLLABORATORS_FIELD', 'AIRTABLE_TEAM_MEMBER_FIELD', 'AIRTABLE_APPROVER_FIELD',
      'getAirtablePat', 'getAirtableBaseId', 'getAirtableTableId', 'addAuditEntry', 'fetch',
      body
    );
    const fn = factory(
      MICA_USR, KEVIN_USR, 'usrEricamae000000',
      { assignee: 'fldA', status: 'fldS' }, 'fldC', TEAM_MEMBER_FIELD, APPROVER_FIELD,
      () => 'pat', () => 'base', () => 'table', () => {},
      async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true }; }
    );
    return { fn, calls };
  }

  it('excludes Kevin from collaborators when the agents own the task', async () => {
    const { fn, calls } = extractUpdate();
    await fn('rec1', null, { teamMemberIds: [CEO_REC], agentOwned: true, approverId: MICA_USR });
    const collabIds = calls[0].fields.fldC.map(c => c.id);
    expect(collabIds).not.toContain(KEVIN_USR);
    expect(collabIds).toContain(MICA_USR);
    expect(calls[0].fields[APPROVER_FIELD]).toEqual({ id: MICA_USR });
  });

  it('keeps Kevin as a collaborator on human-owned writes', async () => {
    const { fn, calls } = extractUpdate();
    await fn('rec1', MICA_USR, { teamMemberIds: [], agentOwned: false });
    const collabIds = calls[0].fields.fldC.map(c => c.id);
    expect(collabIds).toContain(KEVIN_USR);
    expect(collabIds).not.toContain(MICA_USR);
  });
});
