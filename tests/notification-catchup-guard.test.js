// The catch-up guard must be REAL in every page that runs the catch-up.
//
// The Playwright spec (tests/sync-invariants/notification-catchup-approvals.spec.js)
// only loads os/tasks/index.html. The first version of the 4 Sep 2026 fix also
// pasted the guard into os/tasks/index-supabase.html, where `raisedByIds` was
// never populated — that page's field map never requested "Sent For Approval By"
// and its parseTask never mapped it, so `Array.isArray(undefined)` was false and
// the guard never fired. The page carried a confident comment saying the bug was
// fixed while the bug was still live in it, and no browser test covered it.
//
// This is the drift guard. It fails if a page runs runNotificationCatchup()
// without the three parts that make the guard work.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['os/tasks/index.html', 'os/tasks/index-supabase.html'];
const RAISER_FIELD_ID = 'fld30Yw8SWYVp049g'; // Tasks → "Sent For Approval By"

describe('the approval-gate guard on the Slack catch-up', () => {
  it('CONTROL — both pages actually run the catch-up', () => {
    for (const p of PAGES) {
      const src = readFileSync(join(ROOT, p), 'utf8');
      expect(src, `${p} should define the catch-up`).toContain('function runNotificationCatchup(');
      expect(src, `${p} should call the catch-up`).toContain('runNotificationCatchup()');
    }
  });

  for (const p of PAGES) {
    describe(p, () => {
      const src = () => readFileSync(join(ROOT, p), 'utf8');

      it('requests the raiser field from Airtable', () => {
        // Without the field ID in the page's field map the API never returns
        // it, so the guard reads undefined on every task.
        expect(src()).toContain(RAISER_FIELD_ID);
      });

      it('maps it onto the task as raisedByIds', () => {
        expect(src()).toMatch(/raisedByIds\s*:/);
      });

      it('skips a task that carries a raiser link', () => {
        const fn = src().split('function runNotificationCatchup(')[1].split('\nfunction ')[0];
        expect(fn).toMatch(/Array\.isArray\(t\.raisedByIds\)&&t\.raisedByIds\.length/);
      });

      it('does not gate on status instead — that matched nothing on 4 Sep 2026', () => {
        // A status test looks like the obvious fix and lets every DECIDED item
        // through, which was seven of the nine duplicate DMs.
        const fn = src().split('function runNotificationCatchup(')[1].split('\nfunction ')[0];
        expect(fn).not.toMatch(/t\.status===['"]Approval['"]/);
      });
    });
  }
});
