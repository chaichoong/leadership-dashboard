import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SRC = readFileSync(DISPATCH, 'utf8');

// AUTONOMY LEVELS (Kevin's ruling, 7 Sep 2026; Chen Book 4 ch 5).
//
// Measured before the change: 260 decisions in 586 minutes since 20 Aug 2026,
// and not one rejection was a bad draft. 42 of 42 close proposals were the
// Task Manager asking Kevin to rubber-stamp a fold he had already unlocked on
// 27 Aug. So `submit` now decides a LEVEL per category of decision and, for
// Level A, VERIFIES the evidence and carries the action out itself.
//
// These tests drive the REAL decision_level with a fake Airtable, so a
// rewrite cannot leave them passing against a ghost. The failure to fear is
// the agent's claim being trusted: a keeper that does not exist, is newer, or
// is the task itself must fall back to a card, exactly as before.

function py(code) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("ad", ${JSON.stringify(DISPATCH)})
ad = importlib.util.module_from_spec(spec)
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec.loader.exec_module(ad)
AF = ad.AF
DB = {
  'recKEEPER00000001': {'id':'recKEEPER00000001','createdTime':'2026-09-01T10:00:00.000Z','fields':{AF['name']:'INBOUND: Sefton licence fee','fldx4qCw17UfrKpaN':'Today'}},
  'recNEWER000000001': {'id':'recNEWER000000001','createdTime':'2026-09-06T10:00:00.000Z','fields':{AF['name']:'newer twin','fldx4qCw17UfrKpaN':'Today'}},
  'recCANCEL00000001': {'id':'recCANCEL00000001','createdTime':'2026-09-01T10:00:00.000Z','fields':{AF['name']:'cancelled','fldx4qCw17UfrKpaN':'Cancelled'}},
  'recDONE0000000001': {'id':'recDONE0000000001','createdTime':'2026-09-01T10:00:00.000Z','fields':{AF['name']:'Reply sent to Sefton','fldx4qCw17UfrKpaN':'Completed'}},
  'recOPEN0000000001': {'id':'recOPEN0000000001','createdTime':'2026-09-01T10:00:00.000Z','fields':{AF['name']:'still open','fldx4qCw17UfrKpaN':'Today'}},
}
def fetch(i):
    if i not in DB: raise RuntimeError('404 NOT_FOUND')
    return DB[i]
def rec(name, notes=''):
    return {'id':'recTHIS0000000001','createdTime':'2026-09-03T10:00:00.000Z','fields':{AF['name']:name,AF['description']:'',AF['notes']:notes}}
def lvl(out, tt, name, notes=''):
    d = ad.decision_level(out, tt, rec(name, notes), fetch=fetch)
    return {k: d.get(k) for k in ('level','category','carry','money')} | {'text': d.get('evidence') or d.get('why')}
${code}
`;
  return JSON.parse(execFileSync('/usr/bin/python3', ['-c', script], { encoding: 'utf8' }));
}

describe('the three levels never collide with the private matter', () => {
  it('names them A, B, C and not "tier"', () => {
    expect(SRC).toMatch(/AUTONOMY_ACT = "A"/);
    expect(SRC).toMatch(/AUTONOMY_APPROVE = "B"/);
    expect(SRC).toMatch(/AUTONOMY_KEVIN = "C"/);
  });
  it('a tier-1 matter is Level C whatever the shape, even a verified duplicate fold', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recKEEPER00000001', 'Admin', 'INBOUND: bailiff notice of enforcement')))`);
    expect(d.level).toBe('C');
    expect(d.category).toBe('tier-1 matter');
  });
  it('the banner alone makes it Level C', () => {
    const d = py(`print(json.dumps(lvl(ad.TIER1_BANNER + '\\n\\nCLOSE PROPOSAL: duplicate of recKEEPER00000001', 'Admin', 'plain name')))`);
    expect(d.level).toBe('C');
  });
});

describe('close as duplicate — the keeper is verified, never trusted', () => {
  it('acts when the keeper exists, is older, open and a different task', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recKEEPER00000001 — folded into it', 'Admin', 'INBOUND: pay Sefton licence')))`);
    expect(d.level).toBe('A');
    expect(d.carry).toBe('close');
    expect(d.text).toMatch(/keeper recKEEPER00000001 "INBOUND: Sefton licence fee"/);
  });
  it('is a card when the keeper is NEWER — the older task keeps', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recNEWER000000001', 'Admin', 'x')))`);
    expect(d.level).toBe('B');
    expect(d.text).toMatch(/NEWER/);
  });
  it('is a card when the keeper does not exist', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recMISSING0000001', 'Admin', 'x')))`);
    expect(d.level).toBe('B');
    expect(d.text).toMatch(/could not be read/);
  });
  it('is a card when the keeper is Cancelled', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recCANCEL00000001', 'Admin', 'x')))`);
    expect(d.level).toBe('B');
    expect(d.text).toMatch(/Cancelled/);
  });
  it('is a card when the keeper cited is this very task', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recTHIS0000000001', 'Admin', 'x')))`);
    expect(d.level).toBe('B');
    expect(d.text).toMatch(/this very task/);
  });
});

describe('close as already handled — the Completed task is verified', () => {
  it('acts when the cited task is Completed', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: already handled — see recDONE0000000001 (reply went out 2 Sep)', 'Admin', 'x')))`);
    expect(d.level).toBe('A');
    expect(d.carry).toBe('close');
    expect(d.text).toMatch(/Completed task recDONE0000000001/);
  });
  it('accepts the Task Manager\'s "done already" wording', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: done already, see recDONE0000000001', 'Admin', 'x')))`);
    expect(d.level).toBe('A');
  });
  it('is a card when the cited task is still open', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: already handled — see recOPEN0000000001', 'Admin', 'x')))`);
    expect(d.level).toBe('B');
    expect(d.text).toMatch(/is Today, not Completed/);
  });
  it('a close with no citable evidence (dead, stale, judgement) stays a card', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: dead — 300 days old with no deadline', 'Admin', 'x')))`);
    expect(d.level).toBe('B');
    expect(d.category).toBe('close: judgement');
  });
});

describe('pass to Roy — match the NAME, veto on everything', () => {
  it('acts on a property-lane name with nothing vetoing it', () => {
    const d = py(`print(json.dumps(lvl('PASS TO ROY: boiler not firing, tenant reports', 'Admin', 'MAINTENANCE: boiler repair 6 Chedburgh Place')))`);
    expect(d.level).toBe('A');
    expect(d.carry).toBe('roy');
  });
  it('is a card when a veto word is present (a fee is money)', () => {
    const d = py(`print(json.dumps(lvl('PASS TO ROY: forward the licence email', 'Admin', 'INBOUND: pay Sefton landlord licence fee 150 GBP')))`);
    expect(d.level).toBe('B');
  });
});

describe('the money rule — £25 log, £100 inform, above a card, recurring always Kevin', () => {
  it('constants are the figures Kevin chose on 7 Sep 2026', () => {
    const d = py(`print(json.dumps(ad.DECISION_MONEY))`);
    expect(d).toEqual({ log: 25, inform: 100 });
  });
  it('under £25 logs, £25 to £100 informs, over £100 is a card, recurring is Kevin', () => {
    const d = py(`print(json.dumps([ad.money_level(24.99), ad.money_level(25), ad.money_level(100), ad.money_level(100.01), ad.money_level(5, True), ad.money_level(None)]))`);
    expect(d).toEqual(['log', 'inform', 'inform', 'card', 'kevin', 'log']);
  });
  it('reads SPEND: lines with commas, pence and recurring words', () => {
    const d = py(`print(json.dumps([ad.spend_declared('SPEND: £1,250.50 per year'), ad.spend_declared('spend: 80'), ad.spend_declared('SPEND: £20/month'), ad.spend_declared('no line')]))`);
    expect(d).toEqual([[1250.5, true], [80, false], [20, true], [null, false]]);
  });
  it('a Level A shape over the rule becomes a card with the figure', () => {
    const d = py(`print(json.dumps(lvl('PASS TO ROY: book the gas engineer\\nSPEND: £180', 'Admin', 'MAINTENANCE: gas safety visit')))`);
    expect(d.level).toBe('B');
    expect(d.text).toMatch(/£180\.00 is over the money rule \(£100\)/);
  });
  it('a recurring commitment is Kevin\'s whatever the amount', () => {
    const d = py(`print(json.dumps(lvl('PASS TO ROY: weekly cleaner\\nSPEND: £20/month', 'Admin', 'MAINTENANCE: weekly clean')))`);
    expect(d.level).toBe('B');
    expect(d.money).toBe('kevin');
  });
  it('£25 to £100 still acts, flagged inform for the 08:00 message', () => {
    const d = py(`print(json.dumps(lvl('PASS TO ROY: book the gas engineer\\nSPEND: £80', 'Admin', 'MAINTENANCE: gas safety visit 6 Chedburgh Place')))`);
    expect(d.level).toBe('A');
    expect(d.money).toBe('inform');
  });
});

describe('calendar entries and everything else', () => {
  it('a valid CALENDAR output submitted as Admin acts', () => {
    const d = py(`print(json.dumps(lvl('CALENDAR:\\nTITLE: Dentist\\nSTART: 2027-01-05 10:00\\nEND: 2027-01-05 10:30\\n---\\nDentist appointment', 'Admin', 'INBOUND: dentist')))`);
    expect(d.level).toBe('A');
    expect(d.carry).toBe('calendar');
  });
  it('a CALENDAR output under the wrong type is a card (calendar-write refuses it anyway)', () => {
    const d = py(`print(json.dumps(lvl('CALENDAR:\\nTITLE: Dentist\\nSTART: 2027-01-05 10:00\\nEND: 2027-01-05 10:30\\n---\\nx', 'Research', 'x')))`);
    expect(d.level).toBe('B');
  });
  it('correspondence is a card by default — nothing reaches a third party unseen', () => {
    const d = py(`print(json.dumps(lvl('TO: a@b.com\\nFROM: kevinbrittain@gmail.com\\nSUBJECT: hi\\n---\\nbody', 'Correspondence', 'INBOUND: reply')))`);
    expect(d.level).toBe('B');
  });
});

describe('submit wires the level in, and the carry-out leaves its marker', () => {
  it('cmd_submit consults decision_level after the informational branch and only when not tier 1', () => {
    const i = SRC.indexOf('if informational_only(output, args.type');
    const j = SRC.indexOf('level = decision_level(output, args.type, trec)');
    const k = SRC.indexOf('if level["level"] == AUTONOMY_ACT and not is_tier1:');
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    expect(k).toBeGreaterThan(j);
  });
  it('a carry-out that leaves no marker is refused, not assumed', () => {
    expect(SRC).toMatch(/if HANDLED_MARK not in str\(check\.get\(AF\["notes"\]\) or ""\):\n\s+sys\.exit\(/);
  });
  it('the calendar carry-out falls back to a card when the diary write fails', () => {
    expect(SRC).toMatch(/if proc\.returncode != 0:[\s\S]*?AF\["status"\]: "Approval"/);
  });
  it('the marker string is shared with calendar-write.py and the page', () => {
    const cal = readFileSync(resolve(ROOT, 'scripts/calendar-write.py'), 'utf8');
    const acc = readFileSync(resolve(ROOT, 'js/agent-accuracy.js'), 'utf8');
    const apv = readFileSync(resolve(ROOT, 'scripts/slack-automation/approvals.js'), 'utf8');
    const m = SRC.match(/^HANDLED_MARK = "([^"]+)"/m);
    expect(m).not.toBeNull();
    expect(cal).toContain(`HANDLED_MARK = "${m[1]}"`);
    expect(acc).toContain(`var HANDLED_MARK = '${m[1]}'`);
    expect(apv).toContain(`export const HANDLED_MARK = '${m[1]}'`);
  });
});
