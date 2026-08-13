import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SRC = readFileSync(DISPATCH, 'utf8');

// Finding 20260813-agent-dispatch-120 — the approval loop had one success state
// and needed two.
//
// `complete` unconditionally wrote Status = Completed and a Completion Date. It
// was the ONLY way to say an approved action had been carried out. So an agent
// that had done exactly what Kevin approved, on a task whose approved text said
// DO NOT CLOSE — a standing obligation, a chase that repeats, a payment plan
// that runs for months — had no way to say "done, still open". Two such tasks
// were marked Completed anyway on 13 Aug 2026, each with an apologetic note
// explaining the obligation continued.
//
// The action was right and the record was wrong, which is the worst combination:
// the obligation is live and the reminder for it has been destroyed, so nothing
// will ever surface it again. Nothing errors and nothing alarms.
//
// `--keep-open` is the second state. It writes the carry-out into Notes (which
// already carries the agent audit trail, so no Airtable schema change gates it)
// and leaves Status and Completion Date untouched. verify() then checks the
// field that actually proves it — re-read from the LIVE record, never trusted
// from the run report.
function py(snippet) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
${snippet}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

describe('CONTROL — the loop still closes an ordinary carry-out', () => {
  it('complete without --keep-open still writes Completed', () => {
    // If this stops being true the fix has broken the normal path, and every
    // approved action would silently stop closing its task.
    const body = SRC.match(/def cmd_complete\(args\):([\s\S]*?)\ndef /)[1];
    expect(body).toContain('AF["status"]: "Completed"');
    expect(body).toContain('AF["completion"]: now_iso()');
  });

  it('neither state can run on an unapproved task', () => {
    // The gate that matters most: the approval, not the closing behaviour.
    const body = SRC.match(/def cmd_complete\(args\):([\s\S]*?)\ndef /)[1];
    const guard = body.indexOf('not in APPROVED');
    const keepOpen = body.indexOf('args.keep_open');
    expect(guard).toBeGreaterThan(-1);
    expect(keepOpen, '--keep-open must sit AFTER the approval gate').toBeGreaterThan(guard);
  });
});

describe('THE REGRESSION: a keep-open carry-out must not close the task', () => {
  it('--keep-open exists as a real flag on complete', () => {
    const help = execFileSync('python3', [DISPATCH, 'complete', '--help'], { encoding: 'utf8' });
    expect(help).toContain('--keep-open');
    expect(help).toContain('--note');
  });

  it('the keep-open branch writes NOTHING to Status or Completion Date', () => {
    const body = SRC.match(/def cmd_complete\(args\):([\s\S]*?)\ndef /)[1];
    const branch = body.match(/if args\.keep_open:([\s\S]*?)\n\n    patch_task/);
    expect(branch, 'the keep-open branch is gone').not.toBeNull();
    expect(branch[1], 'keep-open must not touch Status').not.toContain('AF["status"]');
    expect(branch[1], 'keep-open must not stamp a completion date').not.toContain('AF["completion"]');
    // It must still write SOMETHING, or the carry-out leaves no trace at all.
    expect(branch[1]).toContain('AF["notes"]');
  });

  it('it still records the carry-out in the intent ledger', () => {
    // Without this the next run sees an open intent and could re-execute an
    // action that already happened — the crash-safety rule cmd_intent exists for.
    const branch = SRC.match(/if args\.keep_open:([\s\S]*?)\n\n    patch_task/)[1];
    expect(branch).toContain('ledger_append(args.task, "done")');
  });

  it('the Notes marker is a fixed machine-readable string, not prose', () => {
    const mark = py('print(json.dumps(m.CARRIED_OUT_MARK))');
    expect(typeof mark).toBe('string');
    expect(mark.length).toBeGreaterThan(10);
    // One constant, used by the writer AND the verifier — a second literal is
    // how the tier-1 banner once became unstrippable (finding …-084).
    const uses = SRC.match(/CARRIED_OUT_MARK/g) || [];
    expect(uses.length, 'the marker should be defined once and used twice').toBeGreaterThanOrEqual(3);
    expect(SRC).not.toMatch(/["']CARRIED OUT \(task left open\):["'][\s\S]*["']CARRIED OUT \(task left open\):["']/);
  });
});

describe('verify checks the field that actually proves each end state', () => {
  const verify = SRC.match(/if kind == "carry_out":([\s\S]*?)elif kind in \("redo", "new"\)/)[1];

  it('a keep-open action is verified against Notes, not Status', () => {
    expect(verify).toContain('a.get("keepOpen")');
    expect(verify).toContain('CARRIED_OUT_MARK not in');
  });

  it('a keep-open action with no Notes record is a PROBLEM, not a pass', () => {
    // The whole point of a control: a claimed action with no evidence must fail.
    expect(verify).toMatch(/CARRIED_OUT_MARK not in[\s\S]{0,200}problems\.append/);
    expect(verify).toContain('nothing proves');
  });

  it('a task meant to stay open that ended up Completed is a PROBLEM', () => {
    expect(verify).toMatch(/live\["status"\] == "Completed"[\s\S]{0,200}meant to stay open/);
  });

  it('an ordinary carry-out is still verified against Completed', () => {
    expect(verify).toMatch(/elif live\["status"\] != "Completed"/);
    expect(verify).toContain("expected 'Completed'");
  });
});
