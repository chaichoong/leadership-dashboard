// The history book + open matters (1 Sep 2026 — agent-gate EXTEND verdict,
// approved chain map on register row recYy33zkoa099uM2).
//
// Two pre-reads ground every triage run: WHERE HUMANS FILED each sender's
// mail (the history book) and WHAT MATTERS ARE ALREADY OPEN across the agent
// estate (the matters snapshot). Regressions to fear, each guarded below:
//
//  - the corpus learning the agent's OWN filing — the book would then teach
//    the agent its own guesses, and the 24 Aug backlog clear means date
//    alone cannot filter it (hundreds of PRE-era messages were agent-moved);
//  - a broken read presenting as an empty-but-valid file — "no history" and
//    "unknown sender" must never be conflated, and zero open tasks is a
//    broken board read, not an empty business;
//  - the matter key drifting from the duplicate gate's key — the snapshot
//    imports dupe_task_key from create-agent-task.py rather than copying it,
//    and this test proves the import path still works;
//  - the runner or skill silently dropping the pre-reads or their UNCHECKED
//    fallback language — a check the agent must remember is a check that
//    gets skipped.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRIAGE = path.join(root, 'scripts/inbound-triage.py');
const runner = readFileSync(path.join(root, 'scripts/inbound-triage-run.sh'), 'utf8');
const skill = readFileSync(
  path.join(root, '.claude/scheduled-tasks/inbound-email-triage/SKILL.md'), 'utf8');

function py(code) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("it", ${JSON.stringify(TRIAGE)})
it = importlib.util.module_from_spec(spec); spec.loader.exec_module(it)
${code}
`;
  return JSON.parse(execFileSync('/usr/bin/python3', ['-c', script], { encoding: 'utf8' }));
}

describe('the era boundary and the own-output exclusion', () => {
  it('era start is midnight 24 Aug 2026 London, derived not asserted', () => {
    const r = py(`
from zoneinfo import ZoneInfo
from datetime import datetime
derived = int(datetime(2026, 8, 24, tzinfo=ZoneInfo("Europe/London")).timestamp() * 1000)
print(json.dumps({"ok": it.AGENT_ERA_START_MS == derived}))
`);
    expect(r.ok).toBe(true);
  });

  it('agent-acted mail is excluded even when it is PRE-era (the backlog clear)', () => {
    const r = py(`
ids = {"m1"}
print(json.dumps({
  "preEraAgent": it.classify_era(it.AGENT_ERA_START_MS - 1000, "m1", ids),
  "preEraHuman": it.classify_era(it.AGENT_ERA_START_MS - 1000, "m2", ids),
  "postEraHand": it.classify_era(it.AGENT_ERA_START_MS + 1000, "m3", ids),
}))
`);
    expect(r.preEraAgent).toBe('agent');
    expect(r.preEraHuman).toBe('human-era');
    expect(r.postEraHand).toBe('hand-move');
  });

  it('only MOVES land in the exclusion set — a stranded rescue keeps its human filing', () => {
    const r = py(`
import tempfile, pathlib
with tempfile.TemporaryDirectory() as tmp:
    rows = [
        {"id": "moved", "do": "label12"},
        {"id": "filed", "do": "file-18"},
        {"id": "arched", "do": "archive"},
        {"id": "rescued", "do": "task-created"},
        {"id": "joined", "do": "updated"},
    ]
    p = pathlib.Path(tmp) / "digest-2026-08-24.jsonl"
    p.write_text("\\n".join(json.dumps(r) for r in rows))
    print(json.dumps(sorted(it.collect_agent_ids(tmp))))
`);
    expect(r).toEqual(['arched', 'filed', 'moved']);
  });
});

describe('the vote is conservative', () => {
  it('thin or split evidence never votes; completion labels fold into label12', () => {
    const r = py(`
print(json.dumps({
  "thin": it.history_vote({"6": 2}),
  "split": it.history_vote({"6": 2, "12": 1}),
  "strong": it.history_vote({"6": 4, "12": 1}),
  "completionFolds": it.history_vote({"8": 2, "9": 1}),
  "neverTouchLabels": it.history_vote({"7": 5, "15": 9}),
}))
`);
    expect(r.thin).toBeNull();
    expect(r.split).toBeNull();
    expect(r.strong).toBe('file-6');
    expect(r.completionFolds).toBe('label12');
    // 7 delete and 15 automation-owned are not evidence of anything.
    expect(r.neverTouchLabels).toBeNull();
  });
});

describe('a broken read is an error object, never an empty file', () => {
  it('an empty history book errors', () => {
    const r = py(`print(json.dumps(it.history_json([], "t")))`);
    expect(r.error).toMatch(/UNKNOWN/);
  });

  it('zero open tasks errors — the board always carries hundreds', () => {
    const r = py(`print(json.dumps(it.matters_json([], [], lambda n: n, {}, "t")))`);
    expect(r.error).toMatch(/UNCHECKED/);
  });

  it('the matter key comes from the real duplicate gate, not a copy', () => {
    const r = py(`
key = it._load_dupe_key()
rows = [{"id": "recX", "fields": {
    it.MT["name"]: "INBOUND: Sefton Council licence fee 23 Viola Street",
    it.MT["status"]: "Today"}}]
out = it.matters_json(rows, [], key, {}, "t")
print(json.dumps({"key": out["open"][0]["key"],
                  "gateKey": key("INBOUND: Sefton Council licence fee 23 Viola Street")}))
`);
    expect(r.key).toBe(r.gateKey);
    expect(r.key.length).toBeGreaterThan(0);
  });
});

describe('the runner and skill carry the pre-reads and their fallbacks', () => {
  it('the runner produces both files and gates the weekly rebuild', () => {
    expect(runner).toMatch(/history-stale/);
    expect(runner).toMatch(/history-build/);
    expect(runner).toMatch(/history-dump[\s\S]{0,80}history-book\.json/);
    expect(runner).toMatch(/matters[\s\S]{0,80}open-matters\.json/);
  });

  it('the runner prompt names both files with the UNCHECKED fallback', () => {
    expect(runner).toMatch(/history-book\.json[\s\S]*open-matters\.json[\s\S]*UNCHECKED/);
    expect(runner).toMatch(/rules WIN over the book/);
    expect(runner).toMatch(/JOINED an existing matter/);
  });

  it('the skill rules the book subordinate and demands the join audit trail', () => {
    expect(skill).toMatch(/history-book\.json/);
    expect(skill).toMatch(/THE RULES IN THIS SKILL WIN/);
    expect(skill).toMatch(/open-matters\.json/);
    expect(skill).toMatch(/joined open matter/);
    expect(skill).toMatch(/matter already handled/);
    // The broken-pre-read fallback must stay loud in BOTH new steps.
    expect(skill.match(/UNCHECKED/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('the skill never tells the agent to log a gate fold as a bare duplicate any more', () => {
    // A fold is an UPDATE with a named matter — the digest line Kevin audits.
    expect(skill).not.toMatch(/log `note --do\s+duplicate` and move on; the fold IS the handling/);
  });
});

describe('the python selftest covers the new helpers', () => {
  it('selftest passes', () => {
    const out = execFileSync('/usr/bin/python3', [TRIAGE, 'selftest'], { encoding: 'utf8' });
    expect(out).toMatch(/selftest OK/);
  });
});

// A DEAD BOOK MUST FAIL THE SLOT (finding 20260926-exceptions-627).
//
// The escalation leaves inbound-triage.py as a word — BROKEN — and slot-postrun.sh
// is what turns that word into a non-zero slot. Three things have to hold together,
// and none of them is visible from either file alone:
//   1. the runner's BAD_ERE still matches the word;
//   2. the runner's TOLERATED_ERE does NOT match the escalation line (it carries
//      `GMAIL RATE METRIC STILL FULL`, which is exactly the phrase this slot
//      tolerates — echoing the raw reason onto the line would subtract it);
//   3. slot-postrun.sh flips rc=0 to exit 1 on it.
// So this drives the real scripts end to end rather than grepping either of them.
describe('a dead history book fails the slot instead of narrating', () => {
  const POSTRUN = path.join(root, 'scripts/slot-postrun.sh');

  // The wrapper's own argument list, read from the file, so a change to the
  // runner's patterns is caught here rather than discovered in production.
  const args = runner.match(/slot-postrun\.sh"[\s\S]*?\n\s*'([^']*)' *\\\n\s*'([^']*)' *\\\n\s*'([^']*)'/);

  function escalationLine() {
    const dir = mkdtempSync(path.join(tmpdir(), 'triage-state-'));
    const script = `
import importlib.util, sys, os
os.environ["INBOUND_TRIAGE_DIR"] = ${JSON.stringify(dir)}
spec = importlib.util.spec_from_file_location("it", ${JSON.stringify(TRIAGE)})
it = importlib.util.module_from_spec(spec); spec.loader.exec_module(it)
it.write_state({"history_built_ms": 1788263430621,
                "history_build_failed_ms": 1790324137597,
                "history_build_fail_count": 3,
                "history_build_fail_kind": "rate",
                "history_build_fail_reason": "GMAIL RATE METRIC STILL FULL after 585s"})
sys.exit(it.cmd_history_stale())
`;
    let out = '', code = 0;
    try {
      out = execFileSync('/usr/bin/python3', ['-c', script], { encoding: 'utf8' });
    } catch (e) { out = e.stdout || ''; code = e.status; }
    return { out, code };
  }

  it('the runner still passes the three patterns this depends on', () => {
    expect(args).not.toBeNull();
    expect(args[2]).toMatch(/BROKEN/);                      // BAD_ERE
    expect(args[3]).toMatch(/GMAIL RATE METRIC STILL FULL/); // TOLERATED_ERE
  });

  it('the escalation line says BROKEN and never carries the tolerated phrase', () => {
    const { out, code } = escalationLine();
    expect(code).toBe(1);                       // no rebuild is attempted
    const j = JSON.parse(out.trim().split('\n').pop());
    expect(j.given_up).toBe(true);
    expect(j.escalate).toMatch(/HISTORY BOOK BROKEN/);
    expect(j.escalate).toMatch(/history-build --force/);
    expect(out).not.toMatch(/GMAIL RATE METRIC STILL FULL/);
    expect(j.cooldown).toBeUndefined();
  });

  it('slot-postrun turns that line into exit 1 on an rc=0 run', () => {
    const { out } = escalationLine();
    const work = mkdtempSync(path.join(tmpdir(), 'postrun-'));
    const repo = path.join(work, 'repo');
    mkdirSync(path.join(repo, 'monitoring'), { recursive: true });
    mkdirSync(path.join(work, 'scratch'), { recursive: true });
    const log = path.join(work, 'log');
    writeFileSync(log, out);
    const marker = path.join(work, 'marker');
    writeFileSync(marker, '');
    let status = 0;
    try {
      execFileSync('/bin/bash', [POSTRUN, 'inbound-triage', '0', log, '0', marker,
                                 path.join(work, 'scratch'),
                                 args[1], args[2], args[3]],
                   { encoding: 'utf8', env: { ...process.env, SLOT_POSTRUN_REPO: repo } });
    } catch (e) { status = e.status; }
    expect(status).toBe(1);
  });
});
