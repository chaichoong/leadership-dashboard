import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = readFileSync(resolve(ROOT, 'scripts/agent-dispatch.py'), 'utf8');
const RUNNER = readFileSync(resolve(ROOT, 'scripts/inbound-triage-run.sh'), 'utf8');

// ── FIXING THE TAP AND LEAVING THE BATH FULL (29 Aug 2026) ─────────────────
//
// The alert lane shipped 27 Aug and classifies in `build_queue`, which reads
// Today/Overdue only. It stopped NEW breakage tasks reaching the gate — zero
// created since, verified — and did nothing at all about the ones already
// sitting at Approval.
//
// Kevin cleared his queue on 29 Aug. 15 of the 17 remaining were this exact
// class, every one created 24-27 Aug, every one predating the fix. In his
// words: "I can't fix them, so they need to be dealt with separately."
//
// The measured gap: 13 tasks the classifier matches perfectly, sitting in his
// queue where nothing would ever have removed them.

describe('the backlog is swept, not just the inflow', () => {
  it('there is a command for tasks already AT Approval', () => {
    expect(DISPATCH).toMatch(/def cmd_clear_alerts/);
    // It must read the approval queue, not the Today/Overdue board the lane
    // classifies — reading the same population would be the same bug again.
    const fn = DISPATCH.slice(DISPATCH.indexOf('def cmd_clear_alerts'),
                              DISPATCH.indexOf('def cmd_handover_property'));
    expect(fn).toMatch(/\{Status\}='Approval'/);
  });

  it('honours the knock-back, like every other surface that reads the queue', () => {
    const fn = DISPATCH.slice(DISPATCH.indexOf('def cmd_clear_alerts'),
                              DISPATCH.indexOf('def cmd_handover_property'));
    expect(fn).toMatch(/NOT\(IS_AFTER\(\{Deferred Until\}, TODAY\(\)\)\)/);
  });

  it('uses the SAME classifier the lane uses', () => {
    // A second definition of "is this a machine breakage" would be a second
    // answer, and the sweep would disagree with the lane about the same task.
    const fn = DISPATCH.slice(DISPATCH.indexOf('def cmd_clear_alerts'),
                              DISPATCH.indexOf('def cmd_handover_property'));
    expect(fn).toMatch(/system_alert_match\(/);
  });
});

describe('what the sweep may and may not do', () => {
  const fn = DISPATCH.slice(DISPATCH.indexOf('def cmd_clear_alerts'),
                            DISPATCH.indexOf('def cmd_handover_property'));

  it('CLOSES NOTHING — it reassigns', () => {
    // Destroying 13 of Kevin's approvals would need his explicit yes. Moving
    // them to the board is reversible and loses nothing.
    expect(fn).toMatch(/AF\["status"\]: "Today"/);
    expect(fn).not.toMatch(/"Completed"/);
    expect(fn).not.toMatch(/completionDate/);
  });

  it('leaves TIER 1 with Kevin whatever address it came from', () => {
    // A monitoring sender is not a reason to skip the gate that protects the
    // private legal matter.
    // Assert the GUARD, not a mention of it. `if False and tier_match(...)`
    // leaves the substring intact while disabling the check, and the first
    // version of this test passed against exactly that.
    expect(fn).toMatch(/^\s*if tier_match\(TIER1_PATTERNS, t\["name"\], t\["description"\], t\["notes"\]\):$/m);
    expect(fn).toMatch(/left with Kevin on purpose/);
    // And the guard must SKIP, not merely note it.
    const guard = fn.slice(fn.indexOf('if tier_match(TIER1_PATTERNS'));
    expect(guard.slice(0, 400)).toMatch(/continue/);
  });

  it('clears the verdict, so a moved task cannot read as an approved carry-out', () => {
    expect(fn).toMatch(/AF\["approvalOutcome"\]: None/);
    expect(fn).toMatch(/AF\["sentForApprovalBy"\]: \[\]/);
  });

  it('records WHY on the task, so the move is auditable', () => {
    expect(fn).toMatch(/Moved off the approval queue/);
    expect(fn).toMatch(/AF\["notes"\]/);
  });

  it('has a dry run, because a sweep over Kevin’s queue is worth proving first', () => {
    expect(fn).toMatch(/args\.dry_run/);
  });
});

describe('the gap cannot reopen', () => {
  it('runs every slot, not once as a cleanup', () => {
    // A one-off would leave the same hole behind it: a task can still reach
    // Approval by a path build_queue never classified.
    expect(RUNNER).toMatch(/agent-dispatch\.py" clear-alerts/);
  });
});
