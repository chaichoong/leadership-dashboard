// Deleting a task must ask first.
//
// Regression origin: 12 Aug 2026, finding 20260812-drift-102. The task drawer's
// Delete button, the small red X on every task row, and the drill-down modal's
// Delete all called performDeleteTask() directly, which fires an immediate
// DELETE against the Airtable Tasks table. openDeleteConfirm() — a full "Delete
// task?" modal, written for exactly this — existed and was called from nowhere.
// The only recovery was a 5.5-second Undo toast, and undo RE-CREATES the row as
// a NEW record: the id, the audit trail and anything linked to it are gone.
//
// os/tasks/index.html is a 9,000-line inline-script page with no module
// boundary and vitest has no DOM here, so this reads the source. That is enough
// for the defect, which is a WIRING mistake: a call site that skips the modal.
// The rule asserted is the one that broke — no path reaches the destructive
// call except through the confirmation.
//
// Back-tested: pointing deleteTask() back at performDeleteTask makes it red.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const src = readFileSync(resolve(ROOT, 'os/tasks/index.html'), 'utf8');

// [start, end) of the balanced { … } block belonging to a top-level function.
function fnRange(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name}() is gone from os/tasks/index.html`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return [start, i + 1]; }
  }
  throw new Error(`could not parse ${name}()`);
}

function callSites(needle) {
  const out = [];
  let i = src.indexOf(needle);
  while (i !== -1) { out.push(i); i = src.indexOf(needle, i + 1); }
  return out;
}

describe('task delete asks before destroying the record', () => {
  it('the confirmation modal is still wired to something', () => {
    // Control. If openDeleteConfirm were deleted, "no unguarded call sites"
    // would pass trivially — which is the shape of the original bug.
    const [defStart] = fnRange('openDeleteConfirm');
    const calls = callSites('openDeleteConfirm(').filter((i) => i !== defStart + 9);
    expect(calls.length, 'openDeleteConfirm() is dead code again').toBeGreaterThanOrEqual(2);
  });

  it('nothing calls performDeleteTask except the confirmation modal', () => {
    const [defStart, defEnd] = fnRange('performDeleteTask');
    const [confStart, confEnd] = fnRange('openDeleteConfirm');

    const unguarded = callSites('performDeleteTask(').filter((i) => {
      if (i >= defStart && i < defEnd) return false;   // its own definition
      if (i >= confStart && i < confEnd) return false; // behind the confirm
      return true;
    });

    // Each survivor is a click that deletes an Airtable record with no prompt.
    const context = unguarded.map((i) => src.slice(Math.max(0, i - 90), i + 30).replace(/\s+/g, ' '));
    expect(context, 'a delete path skips the confirmation modal').toEqual([]);
  });

  it('the drawer button and the row X both route through deleteTask', () => {
    expect(src).toMatch(/onclick="deleteTask\('\$\{t\.id\}'\)"/);
    expect(src).toMatch(/onclick="deleteTask\('\$\{taskId\}',event\)"/);
  });

  it('the guide warns that Delete is permanent', () => {
    // Kevin is the only user of this page and reads guides/, not the source.
    const guide = readFileSync(resolve(ROOT, 'guides/tasks.html'), 'utf8');
    expect(guide).toMatch(/Careful with Delete/i);
    expect(guide).toMatch(/Undo/);
  });
});
