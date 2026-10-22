// Two weak words are not a subject.
//
// Regression origin: finding 20261017-phase-4-962, the half of
// 20261016-inbound-email-triage-952 that PR 808 left open and that the number
// guard's own notes list as "known and NOT fixed". On 16-17 Oct 2026 a
// hard-deadline brief folded into an unrelated open task on four shared words:
// `date`, `past`, `still`, `their`. None is a subject word; they ride on every
// task name of that shape, so DUPE_MIN_SHARED of 2 was met before anything
// about the matter had been compared.
//
// Fold-only and Python-only, like fold_on_address_only and
// fold_on_a_number_only: grouping SHOWS and folding DESTROYS, so dupe_verdict
// stays byte-identical to its mirror in os/agents/index.html and the page
// still groups the pair in the Duplicates lane.
//
// Back-tested read-only over the 312 open tasks on the live board at 07:19 on
// 22 Oct 2026: of 107 pairs the gate would still fold, this guard newly
// refuses exactly 2 — the incident pair below, and two DIFFERENT certificates
// at one property. The other 105 do not move. Back-tested by deleting the
// fold_on_weak_words_only call, which flips the incident pair back to a fold.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRunPy } from './helpers/dispatch-py.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts/create-agent-task.py');
const runPy = makeRunPy(SCRIPT);
const F = runPy('mod.F');

// THE WIRED PATH. The guard is only a fix if decide() calls it, so these drive
// the real gate end to end. Back-tested by deleting the fold_on_weak_words_only
// call in decide(): both flip to action "update" and these tests go red.
function decide(incoming, existing, status = 'Today') {
  return runPy('mod.decide(arg[0], arg[1])', [
    { [F.name]: incoming },
    [{ id: 'recX', createdTime: '2026-10-01T00:00:00.000Z',
       fields: { [F.name]: existing, [F.status]: { name: status } } }],
  ]);
}

function verdicts(pairs) {
  const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("g", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
out = []
for a, b in json.loads(${JSON.stringify(JSON.stringify(pairs))}):
    v = m.dupe_verdict(a, b, mode="fold")
    refused = bool(v["match"]) and m.fold_on_weak_words_only(a, b, v["shared"])
    out.append({"a": a, "b": b, "match": bool(v["match"]),
                "shared": [str(s) for s in v["shared"]], "weakRefused": refused,
                "folds": bool(v["match"]) and not refused})
print(json.dumps(out))
`;
  return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf8', timeout: 30000 }));
}

describe('a fold needs a shared SUBJECT, not shared function words', () => {
  it('THE WIRED GATE: the incident pair creates, and says why', () => {
    const v = decide(
      'FIXED COST: costs past their end date still counted',
      'DATA CHECK: 12 hard-deadline tasks are past their date and still open');
    expect(v.action).toBe('create');
    expect(v.taskId).toBeUndefined();
    expect(v.note).toContain('function words');
  });

  it('THE WIRED GATE: two different certificates at one property create', () => {
    const v = decide(
      'COMPLIANCE: GSC renewal due 2026-09-08 - 5 Dalham Place',
      'COMPLIANCE: EICR renewal due 2026-10-14 - 5 Dalham Place');
    expect(v.action).toBe('create');
    expect(v.taskId).toBeUndefined();
  });

  it('THE WIRED GATE: a real duplicate still folds', () => {
    const v = decide(
      'COMPLIANCE: file the EICR certificate at 12 Viola Street',
      'COMPLIANCE: file EICR certificate for 12 Viola Street');
    expect(v.action).toBe('update');
    expect(v.taskId).toBe('recX');
  });

  it('refuses the 16-17 Oct 2026 incident pair', () => {
    const [r] = verdicts([[
      'FIXED COST: costs past their end date still counted',
      'DATA CHECK: 12 hard-deadline tasks are past their date and still open',
    ]]);
    // the word pass still matches — that is the bug, and why the page groups them
    expect(r.match).toBe(true);
    expect(r.shared.sort()).toEqual(['date', 'past', 'still', 'their']);
    expect(r.weakRefused).toBe(true);
    expect(r.folds).toBe(false);
  });

  it('refuses two DIFFERENT certificates at one property', () => {
    // Found by the live back-test, not by reasoning: a GSC renewal and an EICR
    // renewal at 5 Dalham Place agreed on `renewal` + `due` + the address only.
    const [r] = verdicts([[
      'COMPLIANCE: GSC renewal due 2026-09-08 - 5 Dalham Place',
      'COMPLIANCE: EICR renewal due 2026-10-14 - 5 Dalham Place',
    ]]);
    expect(r.folds).toBe(false);
  });

  it('still folds the real duplicates the gate exists for', () => {
    const rows = verdicts([
      // the 28 Aug 2026 live-queue pair the two-pass gate was built for
      ['Chase Sefton Council HMO licence fee', 'pay Sefton Council landlord licence fee'],
      // the same certificate at the same house, written twice
      ['COMPLIANCE: file EICR certificate for 12 Viola Street',
       'COMPLIANCE: file the EICR certificate at 12 Viola Street'],
    ]);
    for (const r of rows) {
      expect(r.folds, `${r.a} / ${r.b}`).toBe(true);
    }
  });

  it('a strong id is identity and is never refused as a weak word', () => {
    const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("g", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(json.dumps({
  "ref": m.fold_on_weak_words_only("a", "b", ["num:123456"]),
  "tel": m.fold_on_weak_words_only("a", "b", ["tel:7398536055"]),
  "nothing": m.fold_on_weak_words_only("a", "b", []),
  "odd": m.fold_on_weak_words_only("a", "b", ["something::odd"]),
}))
`;
    const r = JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf8', timeout: 30000 }));
    expect(r.ref).toBe(false);
    expect(r.tel).toBe(false);
    // no evidence, or evidence in a shape this guard cannot read, refuses the
    // fold rather than failing open — the direction the number guard settled on
    expect(r.nothing).toBe(true);
    expect(r.odd).toBe(true);
  });

  it('the weak list holds no word that could be the matter itself', () => {
    const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("g", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
subjects = ["rent", "arrears", "eicr", "gsc", "certificate", "licence", "insurance",
            "renewal", "invoice", "mortgage", "tenancy", "boiler", "epc", "notice",
            "reminder", "quote", "council", "hmrc", "payment", "pest"]
print(json.dumps(sorted(w for w in subjects if w in m.DUPE_WEAK_WORDS)))
`;
    expect(execFileSync('python3', ['-c', code], { encoding: 'utf8', timeout: 30000 }).trim()).toBe('[]');
  });
});
