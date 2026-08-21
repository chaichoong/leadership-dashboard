// The approval-loop "not moving" rules exist in two places on purpose: the
// Approvals tab (os/tasks/index.html) and the morning Slack message
// (scripts/loop-health.py).
//
// WHAT THIS IS GUARDING (14 Aug 2026)
// Kevin lost trust in the agent loop because work stopped moving silently.
// These rules are the surface that is supposed to catch that, so a bug in THEM
// is worse than no surface at all — it manufactures false confidence. The first
// cut had four, every one of which this file now reproduces:
//
//  1. It flagged 156 tasks, 101 merely "Upcoming" — future-dated work that is
//     not late. A list that long is noise, and noise is what stops it being read.
//  2. "Waiting on a decision" anchored to Due Date, which the rescheduler
//     re-stamps to today, so 28 of 29 waiting approvals read as due today
//     however long they had sat and the rule silently never fired.
//  3. The tab keyed on the DERIVED status (computed from the due date) while
//     the script and the dispatcher key on the STORED one — 126 stalled vs 65.
//  4. The tab's draft rule anchored to `createdDate`, which is not a creation
//     time at all but "Due Date for Interface".
//
// An earlier version of this file compared the two implementations by regexing
// three integers out of each and never executed the JavaScript. All 16 tests
// passed while the two sides disagreed by 61 tasks. So the parity block below
// RUNS BOTH over identical fixtures and compares output, which is the only
// version of this claim worth making.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const PY = resolve(ROOT, 'scripts/loop-health.py');
const TASKS_HTML = resolve(ROOT, 'os/tasks/index.html');

const html = readFileSync(TASKS_HTML, 'utf8');
const py = readFileSync(PY, 'utf8');

// ── Extract the real JS, rather than reimplementing it here ──────────
function slice(startMarker, endMarker) {
  const a = html.indexOf(startMarker);
  if (a < 0) throw new Error(`not found in os/tasks/index.html: ${startMarker}`);
  const b = html.indexOf(endMarker, a);
  if (b < 0) throw new Error(`end not found after ${startMarker}: ${endMarker}`);
  return html.slice(a, b + endMarker.length);
}

const loopSrc = slice('const STALL_AMEND_HOURS', 'return {needsYou,done,stalled};\n}');
const deriveSrc = slice('function deriveTaskStatus(', '\n}');

// Build the JS side with the same globals the page provides.
function makeJs(nowMs) {
  const factory = new Function('NOW_MS', `
    const AGENT_MAP = {recAGENT1: 'AI Worker — Analyst'};
    let currentUser = {email: 'kevin@runpreneur.org.uk'};
    // agentCompletions is declared by the extracted source itself, so it is
    // assigned below rather than redeclared here.
    const todayStr = () => new Date(NOW_MS).toISOString().slice(0, 10);
    const Date_ = Date;
    // Freeze "now" so day counts are deterministic.
    Date = class extends Date_ {
      constructor(...a) { return a.length ? new Date_(...a) : new Date_(NOW_MS); }
      static now() { return NOW_MS; }
    };
    Date.parse = Date_.parse;
    ${deriveSrc}
    ${loopSrc}
    return {
      run: (tasks, completions) => { agentCompletions = completions || []; return computeApprovalLoop(tasks); },
      derive: deriveTaskStatus,
    };
  `);
  return factory(nowMs);
}

// Mirrors the fields parseTask() produces that these rules read. Kept explicit
// so a divergence shows up here rather than being papered over.
function toParsed(rec, derive) {
  const f = rec.fields || {};
  const stored = f.Status || '';
  return {
    id: rec.id,
    name: f['Task Name'] || '(Untitled)',
    status: derive(f['Due Date'] || '', stored),
    storedStatus: stored,
    dueDate: f['Due Date'] || '',
    created: f['Created Time'] || '',
    completion: f['Completion Date'] || '',
    teamMemberIds: f['Team Member'] || [],
    raisedByIds: [],
    approvalOutcome: f['Approval Outcome'] || '',
    approvedAt: f['Approved At'] || '',
    agentOutput: f['Agent Output'] || '',
    approvalSlackTs: f['Approval Slack TS'] || '',
    assigneeEmail: (f.Assignee || {}).email || '',
  };
}

function runPython(tasks, agentIds, nowIso) {
  const script = `
import json, sys, importlib.util
from datetime import datetime
spec = importlib.util.spec_from_file_location("lh", ${JSON.stringify(PY)})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
a = json.loads(sys.argv[1])
now = datetime.fromisoformat(a["now"].replace("Z", "+00:00"))
print(json.dumps(mod.compute(a["tasks"], set(a["agentIds"]), now=now)))
`;
  return JSON.parse(execFileSync('python3', ['-c', script,
    JSON.stringify({ tasks, agentIds, now: nowIso })], { encoding: 'utf8' }));
}

const NOW_ISO = '2026-08-14T09:00:00Z';
const NOW_MS = Date.parse(NOW_ISO);
const AGENT = 'recAGENT1';
const epoch = (iso) => `${Math.floor(Date.parse(iso) / 1000)}.001900`;

let seq = 0;
const task = (fields) => ({ id: `rec${++seq}`, fields });

function runBoth(records) {
  // makeJs freezes the clock by replacing the global Date. That assignment
  // escapes the new Function scope, so it is always restored — otherwise each
  // call re-subclasses the previous subclass and anything later in the file
  // needing a real clock or `instanceof Date` gets a silently wrong answer.
  const realDate = globalThis.Date;
  try {
    const js = makeJs(NOW_MS);
    const parsed = records.map(r => toParsed(r, js.derive));
    const completions = parsed.filter(t => t.completion && t.teamMemberIds.includes(AGENT));
    return {
      js: js.run(parsed, completions),
      py: runPython(records, [AGENT], NOW_ISO),
    };
  } finally {
    globalThis.Date = realDate;
  }
}
const ids = (list) => list.map(x => x.id || (x.t && x.t.id)).sort();
const rules = (list) => list.map(x => `${x.id || x.t.id}:${x.rule}`).sort();

describe('approval-loop stall rules', () => {
  describe('the tab and the Slack script agree — run, not asserted', () => {
    it('agrees on a mixed population covering every rule', () => {
      const records = [
        task({ 'Task Name': 'Amended', Status: 'Today', 'Team Member': [AGENT],
               'Approval Outcome': 'Changes requested', 'Approved At': '2026-08-11T09:00:00Z' }),
        task({ 'Task Name': 'Undrafted', Status: 'Today', 'Team Member': [AGENT],
               'Created Time': '2026-08-10T09:00:00Z' }),
        task({ 'Task Name': 'Overdue undrafted', Status: 'Overdue', 'Team Member': [AGENT],
               'Created Time': '2026-08-01T09:00:00Z' }),
        task({ 'Task Name': 'Waiting', Status: 'Approval', 'Team Member': [AGENT],
               'Approval Slack TS': epoch('2026-08-08T09:00:00Z') }),
        task({ 'Task Name': 'Fresh approval', Status: 'Approval', 'Team Member': [AGENT],
               'Approval Slack TS': epoch('2026-08-13T09:00:00Z') }),
        task({ 'Task Name': 'Drafted', Status: 'Today', 'Team Member': [AGENT],
               'Created Time': '2026-08-01T09:00:00Z', 'Agent Output': 'draft' }),
        task({ 'Task Name': 'Human', Status: 'Today', 'Team Member': ['recHUMAN'],
               'Created Time': '2026-08-01T09:00:00Z' }),
        task({ 'Task Name': 'Completed', Status: 'Completed', 'Team Member': [AGENT],
               'Completion Date': '2026-08-13T09:00:00Z' }),
      ];
      const { js, py } = runBoth(records);
      expect(rules(js.stalled)).toEqual(rules(py.stalled));
      expect(ids(js.needsYou)).toEqual(ids(py.needsYou));
      expect(ids(js.done)).toEqual(ids(py.done));
    });

    it('agrees that a stored-Upcoming task due today is NOT stalled', () => {
      // The 126-vs-65 divergence. The derived status of this task is "Today"
      // because its due date is today, but Airtable stores Upcoming and the
      // dispatcher filters on the stored value, so it is not late.
      const records = [task({
        'Task Name': 'Due today but stored Upcoming', Status: 'Upcoming',
        'Due Date': '2026-08-14', 'Team Member': [AGENT], 'Created Time': '2024-01-01T09:00:00Z',
      })];
      const { js, py } = runBoth(records);
      expect(js.stalled).toHaveLength(0);
      expect(py.stalled).toHaveLength(0);
    });

    it('agrees in the same ORDER, so "the worst three" means the same thing', () => {
      const records = [
        task({ 'Task Name': 'Decide', Status: 'Approval', 'Team Member': [AGENT],
               'Approval Slack TS': epoch('2026-08-01T09:00:00Z') }),
        task({ 'Task Name': 'Draft', Status: 'Overdue', 'Team Member': [AGENT],
               'Created Time': '2026-08-01T09:00:00Z' }),
        task({ 'Task Name': 'Amend', Status: 'Today', 'Team Member': [AGENT],
               'Approval Outcome': 'Changes requested', 'Approved At': '2026-08-10T09:00:00Z' }),
      ];
      const { js, py } = runBoth(records);
      // amend, then draft, then decide — the draft rule carries no day count, so
      // a plain age sort would bury it under every dated item.
      expect(js.stalled.map(s => s.rule)).toEqual(['amend', 'draft', 'decide']);
      expect(py.stalled.map(s => s.rule)).toEqual(['amend', 'draft', 'decide']);
    });
  });

  describe('shared thresholds', () => {
    const jsNum = (n) => Number(loopSrc.match(new RegExp(`const ${n}\\s*=\\s*(\\d+)`))[1]);
    const pyNum = (n) => Number(py.match(new RegExp(`^${n}\\s*=\\s*(\\d+)`, 'm'))[1]);

    it('uses identical numbers on both sides', () => {
      expect(jsNum('STALL_AMEND_HOURS')).toBe(pyNum('STALL_AMEND_HOURS'));
      expect(jsNum('STALL_DRAFT_HOURS')).toBe(pyNum('STALL_DRAFT_HOURS'));
      expect(jsNum('STALL_DECIDE_DAYS')).toBe(pyNum('STALL_DECIDE_DAYS'));
    });

    it('restricts the draft rule to the statuses the dispatcher works from', () => {
      const dispatch = readFileSync(resolve(ROOT, 'scripts/agent-dispatch.py'), 'utf8');
      // Set EQUALITY, not "contains". A subset check passes while the
      // dispatcher's tuple grows and the stall rule quietly under-reports the
      // statuses it is meant to cover.
      const parseList = (src, re) => (src.match(re)[1].match(/['"]([^'"]+)['"]/g) || [])
        .map(x => x.slice(1, -1)).sort();
      const fromDispatch = parseList(dispatch, /OPEN_STATUSES\s*=\s*\(([^)]*)\)/);
      const fromJs = parseList(loopSrc, /STALL_DUE_STATUSES\s*=\s*\[([^\]]*)\]/);
      const fromPy = parseList(py, /STALL_DUE_STATUSES\s*=\s*\(([^)]*)\)/);
      expect(fromJs).toEqual(fromDispatch);
      expect(fromPy).toEqual(fromDispatch);
      expect(fromDispatch).toEqual(['Overdue', 'Today']);
    });
  });

  describe('the rules themselves', () => {
    it('flags an amendment that has not come back, and drops it once it has', () => {
      const stale = runBoth([task({ 'Task Name': 'A', Status: 'Today', 'Team Member': [AGENT],
        'Approval Outcome': 'Changes requested', 'Approved At': '2026-08-11T09:00:00Z' })]);
      expect(stale.js.stalled[0].why).toContain('3 days');
      expect(stale.py.stalled[0].why).toContain('3 days');

      // Status back to Approval means the agent resubmitted — the loop working.
      const back = runBoth([task({ 'Task Name': 'A', Status: 'Approval', 'Team Member': [AGENT],
        'Approval Outcome': 'Changes requested', 'Approved At': '2026-08-01T09:00:00Z' })]);
      expect(back.js.stalled.filter(s => s.rule === 'amend')).toHaveLength(0);
      expect(back.py.stalled.filter(s => s.rule === 'amend')).toHaveLength(0);
    });

    it('never claims a day count the draft rule cannot substantiate', () => {
      // Old tasks get routed to an agent recently, so time-since-creation is
      // not time-the-agent-has-had-it and must not be presented as it.
      const { js, py } = runBoth([task({ 'Task Name': 'Ancient', Status: 'Overdue',
        'Team Member': [AGENT], 'Created Time': '2024-01-01T09:00:00Z' })]);
      expect(js.stalled[0].why).not.toMatch(/\d+\s*days/);
      expect(py.stalled[0].why).not.toMatch(/\d+\s*days/);
    });

    it('anchors the decide rule to the Slack post, not the re-stamped due date', () => {
      const out = runBoth([task({ 'Task Name': 'Re-stamped', Status: 'Approval',
        'Team Member': [AGENT], 'Due Date': '2026-08-14',
        'Approval Slack TS': epoch('2026-08-04T09:00:00Z') })]);
      expect(out.js.stalled[0].why).toContain('10 days');
      expect(out.py.stalled[0].why).toContain('10 days');
      // Belt and braces: neither side may read Due Date for this rule again.
      expect(py).not.toMatch(/hours_since\(f\.get\("Due Date"\)/);
      expect(loopSrc).not.toMatch(/_hoursSince\(t\.dueDate\)/);
    });

    it('never reports a completed task as stalled', () => {
      const { js, py } = runBoth([task({ 'Task Name': 'Done', Status: 'Completed',
        'Team Member': [AGENT], 'Completion Date': '2026-08-13T09:00:00Z',
        'Created Time': '2024-01-01T09:00:00Z' })]);
      expect(js.stalled).toHaveLength(0);
      expect(py.stalled).toHaveLength(0);
    });
  });

  describe('the Done panel has a real source', () => {
    it('does not read completions from allTasks, which excludes them', () => {
      // The page fetches AND({Status}!="Completed",...), so sourcing `done` from
      // that array left the panel permanently empty on the surface built to
      // prove work gets finished.
      expect(loopSrc).toMatch(/const done=\(agentCompletions\|\|\[\]\)/);
      expect(html).toMatch(/async function loadAgentCompletions/);
      expect(html).toMatch(/\{Status\}="Completed"/);
    });

    it('distinguishes a failed read from a genuine nothing-done', () => {
      expect(html).toMatch(/agentCompletionsError/);
      expect(html).toMatch(/because the read failed, not because nothing was done/);
    });
  });

  describe('the Python controls cannot report a false all-clear', () => {
    it('controls the fields each rule depends on', () => {
      // Every rule fires on the ABSENCE of something, so a field that silently
      // stops being written turns this into a permanent all-clear.
      expect(py).toMatch(/waiting approvals carrying an Approval Slack TS/);
      expect(py).toMatch(/tasks carrying Agent Output/);
      expect(py).toMatch(/open tasks linked to an AI agent/);
    });

    it('counts the agent-link control over OPEN tasks only', () => {
      // Counted across all rows it passed on 7,099 completed records alone,
      // even if every open agent task had disappeared.
      expect(py).toMatch(/open_tasks = \[f for f in fields/);
      expect(py).toMatch(/sum\(1 for f in open_tasks/);
    });
  });
});
