import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const RUNNER = resolve(ROOT, 'scripts/inbound-triage-run.sh');

// ── ROY'S LANE (28 Aug 2026) ───────────────────────────────────────────────
//
// "Roy is dealing with this directly" was typed SEVEN separate times across the
// 58 rejections Kevin had ever made — 12%, the third largest group, every one
// costing him a read and a decision on work that was never his.
//
// Roy Lavin has been Head of Property since 25 Aug 2026 and `handover` has
// existed since then carrying his standing approval for maintenance. Nothing
// ever routed to him: the capability was built and the instruction to use it
// lived in prose, so it was skipped for three days. Same lesson as the learning
// loop and the two email defaults before it.
//
// THE ASYMMETRY THESE GUARD: missing one costs Kevin a decision he is already
// making. Getting one wrong sends his private legal correspondence, or a
// payment decision, to a contractor.

function py(code) {
  return JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location("ad", ${JSON.stringify(DISPATCH)})
ad = importlib.util.module_from_spec(spec); spec.loader.exec_module(ad)
${code}`], { encoding: 'utf8' }));
}
const roy = (name, description = '', notes = '') =>
  py(`print(json.dumps({"hit": ad.roy_match(${JSON.stringify(name)}, ${JSON.stringify(description)}, ${JSON.stringify(notes)})}))`).hit;

describe('the work that is genuinely Roy’s', () => {
  it('takes the compliance and inspection matters Kevin kept rejecting', () => {
    // Every one of these is a real task name he rejected as Roy's.
    ['INBOUND: Suffolk Council fire safety audit 55 Elmdon Road',
     'INBOUND: Respond to Manchester Council property inspection',
     'INBOUND: 1406 Oldham Road electrical safety cert outstanding',
     'INBOUND: action overdue licensing tasks 23 Viola Street Bootle - EICR and Gas',
     'MAINTENANCE: Emergency lighting certificate renewal at Duckworth',
    ].forEach((n) => expect(roy(n), n).toBeTruthy());
  });

  it('takes the fabric of the building', () => {
    // "urgent kitchen ceiling and rat infestation" — a category-1 hazard that
    // the first cut of the patterns missed entirely.
    ['MAINTENANCE: 1406 Oldham Road - urgent kitchen ceiling and rat infestation',
     'MAINTENANCE: 57a West Street - carpet ceiling and damp repair quote',
     'Repair front room window that won’t open',
    ].forEach((n) => expect(roy(n), n).toBeTruthy());
  });
});

describe('the vetoes, which are the whole safety of this lane', () => {
  it('MONEY never goes to Roy, even wearing property words', () => {
    // "Pay the overdue HMO licence fee" matches `hmo licen`. It is a payment
    // decision. Kevin DID want this one forwarded to Roy — it is vetoed anyway,
    // because the same words on an enforcement letter must not be, and he can
    // forward it himself in one click.
    expect(roy('INBOUND: pay Sefton landlord licence fee 150 GBP for 23 Viola Street')).toBe('');
    expect(roy('INBOUND: Sefton Council HMO licence fee 150 unpaid')).toBe('');
  });

  it('LAW never goes to Roy, even about a fire risk', () => {
    // The risk is Roy's. The enforcement is Kevin's.
    expect(roy('INBOUND: enforcement notice re fire risk assessment at 22 Newton St')).toBe('');
    expect(roy('INBOUND: respond to Burnley Recovery re Liability Order 22 Newton St')).toBe('');
    expect(roy('INBOUND: Fylde Council forwarded restraint order notification')).toBe('');
    expect(roy('INBOUND: POST: HMRC LateTaxReturnPenalty MrKJBrittain')).toBe('');
  });

  it('a veto in the BODY still vetoes, though the body never matches', () => {
    // Deliberately asymmetric: the name decides what a task IS, but the thing
    // that makes it not-Roy's turns up in the body.
    expect(roy('MAINTENANCE: boiler repair at Apt 5', 'the tenant also owes rent arrears')).toBe('');
    expect(roy('MAINTENANCE: boiler repair at Apt 5', 'nothing unusual')).toBeTruthy();
  });

  it('KEVIN’S OWN HOME is not part of the portfolio', () => {
    expect(roy('MAINTENANCE: Yale Smart Lock battery low at Brittain Home front door')).toBe('');
  });

  it('a bare "maintenance" is NOT a pattern', () => {
    // Every task in the MAINTENANCE: lane carries the word, so it matched the
    // whole lane — including Kevin's house and an estate agent's letter. The
    // lane prefix says where a task came from, never what it is.
    expect(roy('MAINTENANCE: 57a West Street - William H Brown letter')).toBe('');
    const src = readFileSync(DISPATCH, 'utf8');
    const block = src.match(/ROY_PATTERNS = \[([\s\S]*?)\n\]/)[1];
    expect(block).not.toMatch(/r"\\bmaintenance\\b"/);
  });

  it('matches the NAME only — a description mentioning a repair is not a repair task', () => {
    // Matching the body sent a PROSPECTING task to the head of property.
    expect(roy('Approve the 6 four-line test emails', 'the garden of the property was mentioned')).toBe('');
  });
});

describe('the lane is wired so nothing has to remember to use it', () => {
  it('tier 1, creditor work and approved work are never diverted', () => {
    const src = readFileSync(DISPATCH, 'utf8');
    expect(src).toMatch(/t\["tier1"\] or t\["creditor"\] or t\["outcome"\] in APPROVED/);
  });

  it('the queue classifies but does not write — one command owns the change', () => {
    const src = readFileSync(DISPATCH, 'utf8');
    expect(src).toMatch(/def cmd_handover_property/);
    // Reuses cmd_handover, so the tier-1 gate and the both-links write are the
    // same code the manual path uses. A second implementation would drift.
    expect(src).toMatch(/cmd_handover\(argparse\.Namespace\(/);
  });

  it('the scheduled runner actually calls it', () => {
    const r = readFileSync(RUNNER, 'utf8');
    expect(r).toMatch(/agent-dispatch\.py" handover-property/);
  });

  it('what left the queue is COUNTED, so a divert cannot look like a loss', () => {
    const src = readFileSync(DISPATCH, 'utf8');
    expect(src).toMatch(/"handedToRoy": len\(roy\)/);
    expect(src).toMatch(/"royLane": len\(roy_lane\)/);
  });

  it('a refused handover is reported, not swallowed and retried for ever', () => {
    const src = readFileSync(DISPATCH, 'utf8');
    expect(src).toMatch(/"refused": failed/);
  });
});
