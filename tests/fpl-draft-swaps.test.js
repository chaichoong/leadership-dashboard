// Kevin's weekly FPL Draft swap card (approved build recQZZjNELK1x3cAc, 26 Nov 2026).
//
// Phase 1 recommends and never swaps, so what these pin is the rule engine and the
// NOT CHECKED path. The fixtures in tests/fixtures/fpl/ are recorded reads, trimmed to
// the fields the script uses; gw11-expected rebuilds the squad Kevin judged by hand on
// 20 Nov 2026 (see its README.md for what is recorded and what is reconstructed).
//
// Back-tested, 27 Nov 2026: setting MIN_MINUTES to 0 makes the edge scenario fail
// ("a free agent on 299 minutes was considered"), and emptying A_GRADE makes the
// expected scenario fail (Gibbs-White becomes droppable and McGinn is signed against
// rule 2). Neither passes without the build.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'fpl-draft-swaps.py');
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'fpl');

// Reads the plan straight out of the module, so the test sees the figures and not a
// print of them. WHEN is fixed: a scoring rule must not change answer with the clock.
function plan(scenario, when = '2026-11-20T09:00:00+00:00') {
  const py = `
import importlib.util, json, sys
from datetime import datetime
spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
p = m.build_plan(m.Reader(fixtures=sys.argv[1]), when=datetime.fromisoformat(sys.argv[2]))
print('---JSON---')
print(json.dumps({
  'gameweek': p['gameweek'],
  'squad_gameweek': p['squad_gameweek'],
  'swaps': [{'out': s['out']['web_name'], 'in': s['in']['web_name'], 'pos': s['position'],
             'slot': s['slot'], 'out_week': round(s['out_week'], 2), 'in_week': round(s['in_week'], 2),
             'out_five': round(s['out_five'], 2), 'in_five': round(s['in_five'], 2)} for s in p['swaps']],
  'goalkeeper': (p['goalkeeper'] or {}).get('web_name'),
  'free_agents': sorted(e['web_name'] for e in p['free_agents']),
  'skipped': p['skipped'],
  'card': m.card_text(p),
  'fields_name': m.card_fields(p)[m.F['name']],
  'gate': m.gate(p, when=datetime.fromisoformat(sys.argv[2])),
}))
`;
  const out = execFileSync('python3', ['-c', py, join(FIXTURES, scenario), when], { encoding: 'utf8' });
  return JSON.parse(out.split('---JSON---')[1]);
}

function readError(scenario) {
  const py = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
from datetime import datetime, timezone
try:
    m.build_plan(m.Reader(fixtures=sys.argv[1]), when=datetime(2026, 11, 20, 9, 0, tzinfo=timezone.utc))
except m.FplReadError as exc:
    print('NOT CHECKED: %s' % exc)
else:
    print('NO ERROR RAISED')
`;
  return execFileSync('python3', ['-c', py, join(FIXTURES, scenario)], { encoding: 'utf8' }).trim();
}

describe('the swaps the five rules give (gw11-expected)', () => {
  it("reproduces the two swaps Kevin made that the rules also reach, and starts the best keeper", () => {
    const p = plan('gw11-expected');
    expect(p.gameweek).toBe(11);
    const pairs = p.swaps.map((s) => `${s.out}>${s.in}`);
    expect(pairs).toContain('McBurnie>N.Jackson');
    expect(pairs).toContain('Pickford>Verbruggen');
    // Rule 5: the new player takes the slot of the player he replaces.
    const gk = p.swaps.find((s) => s.in === 'Verbruggen');
    expect(gk.pos).toBe('GKP');
    expect(gk.slot).toBeGreaterThan(0);
    // Rule 5: best-scoring goalkeeper starts.
    expect(p.goalkeeper).toBe('Verbruggen');
  });

  it('refuses the third swap Kevin made by hand, because rule 2 looks five gameweeks out', () => {
    // McGinn beats Dewsbury-Hall this week and is worse over the next five. Kevin signed him
    // anyway on 20 Nov, on that morning's figures. On these figures the rule says no, and the
    // card has to say no too — a rule that bends to the recorded outcome is not a rule.
    const p = plan('gw11-expected');
    expect(p.swaps.some((s) => s.in === 'McGinn')).toBe(false);
    expect(p.free_agents).toContain('McGinn');
  });

  it('the card leads with the ask, says it changed nothing, and names the deadline', () => {
    const p = plan('gw11-expected');
    expect(p.fields_name).toBe('FPL swaps GW11');
    expect(p.card.split('\n')[0]).toMatch(/^FPL SWAPS GW11: .*Put Verbruggen in goal\. Deadline /);
    expect(p.card).toContain('This recommends only. Nothing in your team has changed.');
    expect(p.card).toContain('**Carrying this out will involve:**');
    // Every number in the card carries its source: the read times are printed.
    expect(p.card).toMatch(/Read at: .*draft bootstrap/);
  });

  it('the gate is quiet until the deadline is inside 36 hours', () => {
    // GW11 deadline is Sat 21 Nov 11:00. Two days before, nothing is owed.
    expect(plan('gw11-expected', '2026-11-19T09:00:00+00:00').gate)
      .toMatch(/more than the 36-hour window/);
    expect(plan('gw11-expected', '2026-11-20T09:00:00+00:00').gate).toBeNull();
  });
});

describe('the rule edges (edge)', () => {
  it('keeps an A-grade through one bad week (rule 3)', () => {
    const p = plan('edge');
    expect(p.swaps.some((s) => s.out === 'Palmer')).toBe(false);
  });

  it('ignores a free agent on 299 minutes and considers one on 300 (rule 4)', () => {
    const p = plan('edge');
    expect(p.free_agents).not.toContain('Under300');
    expect(p.free_agents).toContain('Exactly300');
    expect(p.skipped.minutes).toBeGreaterThan(0);
  });

  it('halves a doubtful player at 50% and scores a blank gameweek at zero (rule 1)', () => {
    const p = plan('edge');
    // Doubtful50 and Exactly300 are the same player but for fitness: 9.0 ppg, same club,
    // same fixture. The doubtful one must score about half of the fit one.
    const py = `
import importlib.util, json, sys
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
r = m.Reader(fixtures=sys.argv[1])
b = m.read_bootstrap(r); fx = m.read_fixtures(r, 11)
els = {e['web_name']: e for e in b['elements']}
print('---JSON---')
print(json.dumps({n: round(m.week_score(els[n], fx), 3) for n in ('Exactly300', 'Doubtful50', 'Blanker')}))
`;
    const got = JSON.parse(execFileSync('python3', ['-c', py, join(FIXTURES, 'edge')], { encoding: 'utf8' })
      .split('---JSON---')[1]);
    expect(got.Doubtful50).toBeCloseTo(got.Exactly300 / 2, 3);
    expect(got.Blanker).toBe(0);     // his club has no fixture that gameweek
  });
});

describe('a broken read is NOT CHECKED, never an empty population', () => {
  it('a 500 page instead of JSON stops the run', () => {
    expect(readError('fail-game-500')).toMatch(/^NOT CHECKED: draft game: body was not JSON/);
  });

  it('a reply missing waivers_processed stops the run', () => {
    expect(readError('fail-no-waivers-key'))
      .toBe("NOT CHECKED: draft game: reply has no 'waivers_processed' key");
  });

  it('"No pick history" is not an empty squad', () => {
    // The dangerous one: a string where a squad belongs would read as "you own nobody",
    // and every free agent would beat nobody.
    expect(readError('fail-no-pick-history'))
      .toMatch(/^NOT CHECKED: entry 96186 picks GW11: site answered 'No pick history'/);
  });

  it('no card is ever built from a failed read (the create call is never reached)', () => {
    const py = `
import importlib.util, sys
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def boom(*a, **k):
    raise AssertionError('create_task was called after a failed read')
m.create_task = boom
m.existing_card = boom
code = m.main(['card', '--fixtures', sys.argv[1]])
print('exit %d' % code)
`;
    for (const scenario of ['fail-game-500', 'fail-no-waivers-key', 'fail-no-pick-history']) {
      const out = execFileSync('python3', ['-c', py, join(FIXTURES, scenario)],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(out.trim()).toBe('exit 2');
    }
  });
});

describe('the selftest the job runs', () => {
  it('passes every recorded scenario', () => {
    const out = execFileSync('python3', [SCRIPT, 'selftest'], { encoding: 'utf8' });
    expect(out).toContain('selftest: all scenarios ok');
  });
});
