import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SRC = readFileSync(DISPATCH, 'utf8');

// ─── THE BUG ─────────────────────────────────────────────────────────
//
// Filed six times in two days: findings 20260905-agent-dispatch-468 and -470,
// 20260906-agent-dispatch-481, -482, -484 and -485. Six reports of one
// mechanism is what a loop looks like from the outside.
//
// `complete --keep-open` deliberately leaves Status and Approval Outcome
// alone, because the obligation is ongoing and destroying its reminder is the
// 13 Aug 2026 bug. But build_queue classifies ANY approved task as a
// carry_out, so every 30-minute tick re-dispatched work that had already been
// done. Compliance renewals cycled for ever and each pass stamped another
// CARRIED OUT line into Notes.
//
// Five of the six findings recommended clearing Approval Outcome. That is
// WRONG and this file guards against it: an outcome-less task falls into
// new_work, so the agent would re-draft it and ask Kevin to approve the thing
// he already approved — and his decision record would be gone.
//
// The fix remembers WHICH decision was carried out, in the intent ledger,
// keyed on approvedAt (stamped by approvals.js on every decide).

function py(snippet, env = {}) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
${snippet}
`;
  return JSON.parse(
    execFileSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } })
  );
}

describe('the ledger remembers WHICH decision was carried out', () => {
  function withLedger(lines) {
    const dir = mkdtempSync(join(tmpdir(), 'od-keepopen-'));
    const file = join(dir, 'carryout-intent.jsonl');
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  }

  it('reports a kept-open carry-out with the decision it belongs to', () => {
    const file = withLedger([
      { task: 'recAAA', ts: '2026-09-06T10:00:00.000Z', event: 'done', keptOpenFor: '2026-09-06T09:00:00.000Z' },
    ]);
    const out = py(`m.INTENT_LEDGER = ${JSON.stringify(file)}
print(json.dumps(m.kept_open_decisions()))`);
    expect(out).toEqual({ recAAA: '2026-09-06T09:00:00.000Z' });
  });

  it('an ordinary completion is NOT a kept-open carry-out', () => {
    // Without this the whole board would be suppressed: `complete` writes a
    // plain "done" for every closed task.
    const file = withLedger([
      { task: 'recBBB', ts: '2026-09-06T10:00:00.000Z', event: 'done' },
    ]);
    const out = py(`m.INTENT_LEDGER = ${JSON.stringify(file)}
print(json.dumps(m.kept_open_decisions()))`);
    expect(out).toEqual({});
  });

  it('a later entry for the same task wins, so a fresh cycle is not suppressed', () => {
    const file = withLedger([
      { task: 'recCCC', ts: '2026-09-06T10:00:00.000Z', event: 'done', keptOpenFor: '2026-09-06T09:00:00.000Z' },
      { task: 'recCCC', ts: '2026-09-07T10:00:00.000Z', event: 'intent' },
    ]);
    const out = py(`m.INTENT_LEDGER = ${JSON.stringify(file)}
print(json.dumps(m.kept_open_decisions()))`);
    expect(out).toEqual({});
  });

  it('a missing ledger is empty, never an exception', () => {
    const out = py(`m.INTENT_LEDGER = "/nonexistent/od/carryout-intent.jsonl"
print(json.dumps(m.kept_open_decisions()))`);
    expect(out).toEqual({});
  });

  it('open_intents still works — the two readers must not have diverged', () => {
    const file = withLedger([
      { task: 'recDDD', ts: '2026-09-06T10:00:00.000Z', event: 'intent' },
      { task: 'recEEE', ts: '2026-09-06T10:00:00.000Z', event: 'done', keptOpenFor: '2026-09-06T09:00:00.000Z' },
    ]);
    const out = py(`m.INTENT_LEDGER = ${JSON.stringify(file)}
print(json.dumps(sorted(m.open_intents())))`);
    expect(out).toEqual(['recDDD']);
  });
});

describe('the queue skips a carry-out already done for THIS decision', () => {
  const branch = SRC.match(
    /if t\["outcome"\] in APPROVED and t\["agentId"\]:([\s\S]*?)elif t\["outcome"\] == "Changes requested":/
  );

  it('the approved hand-back branch consults the kept-open ledger', () => {
    expect(branch, 'the approved hand-back branch is gone').not.toBeNull();
    expect(branch[1]).toContain('kept_open_for');
    expect(branch[1]).toContain('t["approvedAt"]');
  });

  it('it matches on the DECISION, not merely on the marker being present', () => {
    // A marker-only test would suppress the task for ever: the Notes line
    // survives Kevin's next decision. The approvedAt comparison is what lets
    // a re-approved task flow again.
    expect(branch[1]).toMatch(/kept_open_for\[t\["id"\]\] == t\["approvedAt"\]/);
  });

  it('it also requires the Notes evidence, not the ledger alone', () => {
    // The ledger is a local file. A claim with no record on the task itself
    // is exactly the "nothing proves the action happened" state verify
    // refuses, so the queue holds the same bar.
    expect(branch[1]).toContain('CARRIED_OUT_MARK in (t["notes"] or "")');
  });

  it('the skipped task is listed and counted, never silently dropped', () => {
    expect(SRC).toContain('"keptOpen": kept_open,');
    expect(SRC).toContain('"keptOpen": len(kept_open),');
  });

  it('BACK-TEST: the rejected fix — clearing Approval Outcome — is NOT what shipped', () => {
    // Five of the six findings asked for this. It would drop the task into
    // new_work and re-ask Kevin for an approval he already gave.
    const body = SRC.match(/def cmd_complete\(args\):([\s\S]*?)\ndef /)[1];
    const keepBranch = body.match(/if args\.keep_open:([\s\S]*?)\n\n    patch_task/)[1];
    expect(keepBranch, 'keep-open must not clear the approval outcome').not.toContain(
      'AF["approvalOutcome"]'
    );
  });

  it('task_view exposes approvedAt, or the comparison is against undefined', () => {
    expect(SRC).toMatch(/"approvedAt": str\(f\.get\(AF\["approvedAt"\]\) or ""\)/);
  });
});

describe('verify survives a queue read that returned null counts', () => {
  // Finding 20260906-agent-dispatch-475. `report.get("queueCounts", {})`
  // returns None when the key exists and is null — which is what a failed
  // queue read writes — and every `in` test below it raised TypeError, so
  // verify died before it could report the blind run.
  it('reports the blind run instead of crashing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'od-verify-'));
    const report = join(dir, 'report.json');
    writeFileSync(report, JSON.stringify({ queueCounts: null, actions: [] }));
    let out = '';
    try {
      out = execFileSync('python3', [DISPATCH, 'verify', '--report', report], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      out = (e.stdout || '') + (e.stderr || '');
    }
    expect(out).not.toContain('TypeError');
    expect(out).toContain('queueCounts is missing or empty');
  });

  it('the guard is `or {}`, not a default argument', () => {
    expect(SRC).toContain('report.get("queueCounts") or {}');
  });
});
