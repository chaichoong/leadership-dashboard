import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SKILL = resolve(homedir(), '.claude/scheduled-tasks/agent-dispatch/SKILL.md');

// Tier-1 keyword coverage — scripts/agent-dispatch.py TIER1_PATTERNS.
//
// The bug (found 7 Aug 2026 by the agent-dispatch routine's own review): SKILL.md
// step 2 enumerates the categories the dispatcher must label tier 1, and the
// script's keyword filter covered only six of them. Enforcement and bailiff
// notices, debt settlement offers, financial-disclosure forms, and solicitor or
// litigation correspondence matched NOTHING. The script marked them ordinary, and
// the only thing standing between Kevin and an unlabelled legal document was the
// dispatcher agent remembering to apply its own judgement on top.
//
// Nothing failed when this was wrong. A task simply arrived without its banner —
// which is precisely the failure the banner exists to prevent.
//
// The two artefacts must not drift apart again, so this test reads BOTH: the
// categories out of SKILL.md, and the real compiled regexes out of the script.
//
// The regexes are exercised through the actual Python `tier_match()` rather than
// re-implemented as JS RegExp. Python and JS regex dialects differ, and a test
// that quietly diverges from the code it guards is worse than no test.

function pyMatch(cases) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
cases = json.loads(sys.argv[1])
out = {
    'count': len(m.TIER1_PATTERNS),
    'patterns': [p.pattern for p in m.TIER1_PATTERNS],
    'results': {c: m.tier_match(m.TIER1_PATTERNS, c, '', '') for c in cases},
}
print(json.dumps(out))
`;
  return JSON.parse(execFileSync('python3', ['-c', script, JSON.stringify(cases)], { encoding: 'utf8' }));
}

// Each SKILL.md tier-1 category, paired with a task name written the way one
// would really arrive in Airtable. `phrase` is the wording to look for in
// SKILL.md; `examples` must all be matched by TIER1_PATTERNS.
const CATEGORIES = [
  { phrase: 'restraint order',            examples: ['Restraint Order — draft response to variation request'] },
  { phrase: 'Operation Lily',             examples: ['Operation Lily disclosure bundle'] },
  { phrase: 'criminal investigation',     examples: ['Criminal investigation — collate bank statements'] },
  { phrase: 'Social Housing Holdings',    examples: ['Social Housing Holdings liquidation correspondence'] },
  { phrase: 'ACH Investments',            examples: ['ACH Investments — creditor claim form'] },
  { phrase: 'enforcement',                examples: ['Notice of Enforcement — Marston', 'Enforcement agent visit 12 Aug', 'Writ of control served', 'Taking control of goods notice'] },
  { phrase: 'bailiff',                    examples: ['Bailiff letter re council tax'] },
  { phrase: 'settlement offer',           examples: ['Settlement offer from creditor', 'Full and final offer — respond'] },
  { phrase: 'Standard Financial Statement', examples: ['Standard Financial Statement for creditor', 'Complete income and expenditure form'] },
  { phrase: 'solicitor',                  examples: ['Solicitor invoice — August', 'Solicitor correspondence re disclosure'] },
  { phrase: 'litigation',                 examples: ['Litigation hold notice'] },
];

// Ordinary work that must stay UNLABELLED. Without this the whole suite could be
// satisfied by one over-broad pattern, and a banner on everything is a banner on
// nothing. These are real shapes of task from this base — property admin,
// routine accounting, tenancy work.
const MUST_NOT_MATCH = [
  'Fix boiler at 32 Elmdon Place',
  'Chase Anglian Water direct debit',
  'Year end financial statements for the accountant',
  'Renew gas safety certificate — 28 Chedburgh Place',
  'Prepare quarterly VAT return',
  'Book tenant check-in for Flat 3',
];

describe('agent-dispatch tier-1 keyword coverage', () => {
  const all = [...CATEGORIES.flatMap((c) => c.examples), ...MUST_NOT_MATCH];
  const out = pyMatch(all);

  it('loads the real patterns (control — guards against a vacuous pass)', () => {
    expect(out.count).toBeGreaterThanOrEqual(16);
    expect(out.patterns).toContain('restraint order');
  });

  // The explicit label, added 15 Aug 2026.
  //
  // Until then the filter matched subject keywords only, so a record whose
  // description literally read "TIER 1 MATTER" came back tier1: false. In that
  // day's recovery run, 16 of 16 tier-1 items were caught by the dispatcher's
  // judgement pass and ZERO by this filter. A self-declaration the machine
  // ignores is worse than none, because everyone downstream assumes it was
  // honoured — and the failure mode is a private legal matter routed to Mica.
  describe('an explicit tier-1 label on the record', () => {
    const labelled = ['TIER 1 MATTER — do not action without Kevin', 'this is a tier 1 matter',
                      'tier-1 legal', 'TIER1 flagged', 'Tier One matter', 'tier_1'];
    const notLabelled = ['Multi-tier 15 pricing model', 'tier 2 correspondence',
                         'Order 1 tier cake for the office'];
    const res = pyMatch([...labelled, ...notLabelled]);

    it.each(labelled)('matches %s', (c) => {
      expect(res.results[c], `"${c}" must be tier 1 — it says so on the record`).toBeTruthy();
    });

    // A false positive only routes something to Kevin with extra caution, so
    // the bias is deliberately toward matching. "tier 15" is still worth
    // excluding: a banner that cries wolf stops being read.
    it.each(notLabelled)('does not match %s', (c) => {
      expect(res.results[c], `"${c}" is not a tier-1 declaration`).toBeFalsy();
    });
  });

  // SKILL.md is the specification; the script is the implementation. If the doc
  // stops naming a category, this fails and the pair gets re-decided together
  // rather than one side silently going stale.
  it('SKILL.md still exists and names every category this script encodes', () => {
    expect(existsSync(SKILL), `SKILL.md not found at ${SKILL} — the tier-1 spec is the doc; do not skip this check`).toBe(true);
    const doc = readFileSync(SKILL, 'utf8').toLowerCase();
    const missing = CATEGORIES.filter((c) => !doc.includes(c.phrase.toLowerCase())).map((c) => c.phrase);
    expect(missing, 'SKILL.md no longer names these tier-1 categories').toEqual([]);
  });

  it('matches every tier-1 category SKILL.md enumerates', () => {
    const misses = [];
    for (const c of CATEGORIES) {
      for (const ex of c.examples) {
        if (!out.results[ex]) misses.push(`[${c.phrase}] "${ex}" matched no TIER1_PATTERN`);
      }
    }
    expect(misses).toEqual([]);
  });

  it('leaves ordinary property and accounting work unlabelled', () => {
    const wrong = MUST_NOT_MATCH
      .filter((t) => out.results[t])
      .map((t) => `"${t}" wrongly matched /${out.results[t]}/`);
    expect(wrong).toEqual([]);
  });
});
