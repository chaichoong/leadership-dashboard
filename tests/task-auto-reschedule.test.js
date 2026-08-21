import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 20260819-drift-monitor-221.
//
// autoRescheduleOverdue was the ONE PATCH site in os/tasks/index.html that
// never looked at the response. Every other one — :2143, :2489, :3127, :3269,
// :3547, :3747, :6688, :7292, :8195, :8327, :8341 — checks res.ok.
//
// It matters because patchWithRetry RESOLVES with a non-ok Response rather
// than throwing. So `.then(...)` ran just as happily on a 422 as on a 200: the
// task's dueDate was moved to today in the browser, the returned count said
// every overdue task had been rescheduled, and nothing was logged. The user
// saw the move, reloaded, and the dates were back where they started.
//
// The real function is pulled out of the page source rather than copied, so
// this test cannot pass against a fixed copy while the shipped page regresses.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'os/tasks/index.html'), 'utf8');

function extract(name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in os/tasks/index.html`);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`could not parse ${name}`);
  return src.slice(start, end);
}

const TODAY = '2026-08-19';

// Builds the globals the function reads, and records every patch attempt.
function harness({ tasks, patchResult }) {
  const calls = [];
  const scope = {
    currentUser: { key: 'kevin' },
    TEAM: [{ key: 'kevin', email: 'kevin@runpreneur.org.uk' }],
    allTasks: tasks,
    F: { dueDate: 'fldDue', origDueDate: 'fldOrig' },
    todayStr: () => TODAY,
    patchTask: async (id, fields) => { calls.push({ id, fields }); return patchResult(id); },
    console: { warn: () => {}, error: () => {} },
    setTimeout: (fn) => fn(),
  };
  const names = Object.keys(scope);
  const fn = new Function(...names,
    `${extract('autoRescheduleOverdue')}; return autoRescheduleOverdue;`)(
    ...names.map((n) => scope[n]));
  return { run: fn, calls, tasks };
}

function overdueTask(id) {
  return {
    id,
    assigneeEmail: 'kevin@runpreneur.org.uk',
    dueDate: '2026-08-01',
    status: 'Today',
    someDay: false,
    hardDeadline: false,
  };
}

describe('autoRescheduleOverdue checks the PATCH response', () => {
  it('moves a task and counts it when Airtable accepts the patch', async () => {
    const h = harness({ tasks: [overdueTask('rec1')], patchResult: () => ({ ok: true }) });
    const r = await h.run();
    expect(r.count).toBe(1);
    expect(h.tasks[0].dueDate).toBe(TODAY);
    expect(h.tasks[0].origDueDate).toBe('2026-08-01');
  });

  // The bug, reproduced. patchWithRetry hands back a 422 Response; it does not
  // throw. Before the fix this reported count:1 and showed the task as moved.
  it('does NOT report a rejected patch as a move', async () => {
    const h = harness({
      tasks: [overdueTask('rec1')],
      patchResult: () => ({ ok: false, status: 422 }),
    });
    const r = await h.run();
    expect(r.count, 'a 422 was counted as a successful reschedule').toBe(0);
    expect(r.failed).toBe(1);
  });

  it('does NOT move the task in the browser when the write failed', async () => {
    const h = harness({
      tasks: [overdueTask('rec1')],
      patchResult: () => ({ ok: false, status: 422 }),
    });
    await h.run();
    expect(h.tasks[0].dueDate, 'the page showed a move Airtable refused').toBe('2026-08-01');
    expect(h.tasks[0].origDueDate).toBeUndefined();
  });

  it('counts only the ones that landed when a batch is mixed', async () => {
    const h = harness({
      tasks: ['rec1', 'rec2', 'rec3'].map(overdueTask),
      patchResult: (id) => ({ ok: id !== 'rec2', status: id === 'rec2' ? 500 : 200 }),
    });
    const r = await h.run();
    expect(r.count).toBe(2);
    expect(r.failed).toBe(1);
    expect(h.tasks.find((t) => t.id === 'rec2').dueDate).toBe('2026-08-01');
  });

  it('survives a patch that throws as well as one that resolves not-ok', async () => {
    const h = harness({
      tasks: [overdueTask('rec1')],
      patchResult: () => { throw new Error('network down'); },
    });
    const r = await h.run();
    expect(r.count).toBe(0);
    expect(r.failed).toBe(1);
  });

  // The eager .map fired every request the moment it ran, so slicing the
  // resulting promises 10 at a time throttled nothing — it only staggered when
  // the answers were read. Requests are built inside the loop now.
  it('does not fire more than one batch of requests before the first is read', async () => {
    let inFlight = 0, peak = 0;
    const tasks = Array.from({ length: 25 }, (_, i) => overdueTask(`rec${i}`));
    const h = harness({
      tasks,
      patchResult: async () => {
        inFlight++; peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight--;
        return { ok: true };
      },
    });
    await h.run();
    expect(peak, 'every request fired at once; the batching is decorative').toBeLessThanOrEqual(10);
    expect(h.calls.length).toBe(25);
  });

  it('leaves someDay and hard-deadline tasks alone', async () => {
    const someDay = { ...overdueTask('recS'), someDay: true };
    const hard = { ...overdueTask('recH'), hardDeadline: true };
    const h = harness({ tasks: [someDay, hard], patchResult: () => ({ ok: true }) });
    const r = await h.run();
    expect(r.count).toBe(0);
    expect(h.calls).toHaveLength(0);
  });
});
