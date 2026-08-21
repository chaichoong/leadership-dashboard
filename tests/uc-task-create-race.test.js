// The last look before a UC task is created (finding 20260818-uc-check-slack-notifier-201).
//
// WHY
// uc-task-sync.py reads every existing task ONCE, at the top, then loops
// creating what is missing. Two overlapping runs — the script beside
// js/arrears.js, or the Mac waking a stalled run next to a fresh one — both
// read "not there" and both create. Two creators sharing nothing but a naming
// convention is exactly the drift CONTROL 3 in that script was written to
// catch, and it was catching it after the fact rather than preventing it.
//
// The fix re-asks Airtable immediately before the POST. The interesting part
// is not the re-ask — it is that the re-ask CANNOT be trusted on its own.
// CLAUDE.md's silent-zero trap: a filterByFormula naming a field wrongly
// returns 200 OK and an empty list, which reads as "no duplicate exists" and
// writes exactly the duplicate the check was added to prevent. So the query
// carries its own control, and these tests are mostly about that control.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/uc-task-sync.py');

// Load the real module and swap fetch_all for a recorder. Re-implementing the
// helper in JS would guard nothing.
function check({ want, existing, rows, raises = false, capture = false }) {
  const py = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('uc', ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
seen = {}
def fake(pat, table, fields=None, formula=None, by_field_id=False):
    seen['formula'] = formula
    if ${raises ? 'True' : 'False'}:
        raise RuntimeError('network')
    return [{'fields': {'Task Name': n}} for n in ${JSON.stringify(rows)}]
m.fetch_all = fake
existing = [{'fields': {'Task Name': n}} for n in ${JSON.stringify(existing)}]
out = m.name_already_taken('pat', ${JSON.stringify(want)}, existing)
print('---JSON---'); print(json.dumps({'result': out, 'formula': seen.get('formula')}))
`;
  const raw = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
  const r = JSON.parse(raw.split('---JSON---')[1]);
  return capture ? r : r.result;
}

describe('UC task create: the duplicate check before the write', () => {
  it('says yes when the name is already in Airtable', () => {
    expect(check({ want: 'UC A', existing: ['UC B'], rows: ['UC A', 'UC B'] })).toBe(true);
  });

  it('says no when it genuinely is not', () => {
    expect(check({ want: 'UC A', existing: ['UC B'], rows: ['UC B'] })).toBe(false);
  });

  it('catches the race: a name created since the first read', () => {
    // `existing` is the stale top-of-run snapshot. Airtable has moved on.
    expect(check({ want: 'UC A', existing: ['UC B'], rows: ['UC A', 'UC B'] })).toBe(true);
  });

  // ── THE CONTROL ────────────────────────────────────────────────────
  it('returns None, not false, when the query comes back with nothing at all', () => {
    // A wrong field name returns 200 OK and []. Reading that as "no duplicate"
    // is what writes the duplicate. The known-good name is missing from the
    // response, so the response is not believed.
    expect(check({ want: 'UC A', existing: ['UC B'], rows: [] })).toBeNull();
  });

  it('returns None when the control name is absent but others came back', () => {
    // A partial or wrong-table answer is still an answer that cannot be trusted.
    expect(check({ want: 'UC A', existing: ['UC B'], rows: ['UC Z'] })).toBeNull();
  });

  it('returns None when the query throws rather than assuming safety', () => {
    expect(check({ want: 'UC A', existing: ['UC B'], rows: [], raises: true })).toBeNull();
  });

  it('asks both questions in ONE formula — the check and its control', () => {
    const { formula } = check({ want: 'UC A', existing: ['UC B'], rows: ['UC A', 'UC B'], capture: true });
    expect(formula).toContain('UC A');
    expect(formula, 'the control name is not in the query, so nothing verifies it').toContain('UC B');
    expect(formula).toMatch(/^OR\(/);
  });

  it('escapes a quote in a tenant name instead of breaking the formula', () => {
    // Tenant names carry apostrophes and the odd quote. A broken formula is an
    // error at best and a silent zero at worst.
    const { formula } = check({ want: 'UC O"Neill', existing: ['UC B'], rows: ['UC B'], capture: true });
    expect(formula).toContain('\\"');
  });

  it('falls back to the in-memory read when there is nothing to control against', () => {
    // First-ever run, empty table. Refusing every create would be worse than
    // an unverified one, so it degrades honestly rather than blocking.
    expect(check({ want: 'UC A', existing: [], rows: [] })).toBe(false);
    expect(check({ want: 'UC A', existing: ['UC A'], rows: [] })).toBe(true);
  });
});
