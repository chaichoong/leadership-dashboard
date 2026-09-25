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
  # 15 Sep 2026 shapes. A NEWER keeper whose name reads as one matter with
  # the twin's under the fold check, one that does not (cross-lane), one that
  # is newer but already Completed, and an OLDER keeper that is Completed.
  'recNEWERSAME00001': {'id':'recNEWERSAME00001','createdTime':'2026-09-07T02:10:00.000Z','fields':{AF['name']:'CORRESPONDENCE: Reply to AC1 Electrical - EICR bedroom count - 6 Chedburgh Place','fldx4qCw17UfrKpaN':'Approval'}},
  'recNEWERLANE00001': {'id':'recNEWERLANE00001','createdTime':'2026-09-07T02:10:00.000Z','fields':{AF['name']:'MAINTENANCE: SMS from 447700900747 - maintenance reply','fldx4qCw17UfrKpaN':'Today'}},
  'recNEWERDONE00001': {'id':'recNEWERDONE00001','createdTime':'2026-09-07T02:10:00.000Z','fields':{AF['name']:'CORRESPONDENCE: Reply to AC1 Electrical - EICR bedroom count - 6 Chedburgh Place','fldx4qCw17UfrKpaN':'Completed'}},
  'recOLDERDONE00001': {'id':'recOLDERDONE00001','createdTime':'2026-09-01T10:00:00.000Z','fields':{AF['name']:'INBOUND: Pingen letters on hold','fldx4qCw17UfrKpaN':'Completed'}},
  # Unprefixed repair keepers: Roy holds one, the other carries the
  # Maintenance Ticket tick. By name alone both read as reply tasks.
  'recROYJOB00000001': {'id':'recROYJOB00000001','createdTime':'2026-09-01T10:00:00.000Z','fields':{AF['name']:'Provision of a valid EICR','fldx4qCw17UfrKpaN':'Today',AF['teamMember']:['reclbdjfVev3bqNHS']}},
  'recTICKED00000001': {'id':'recTICKED00000001','createdTime':'2026-09-01T10:00:00.000Z','fields':{AF['name']:'INBOUND: Inspection Report - 25 Abercorn Court','fldx4qCw17UfrKpaN':'Today',AF['maintenanceTicket']:True}},
  'recPLAIN000000001': {'id':'recPLAIN000000001','createdTime':'2026-09-01T10:00:00.000Z','fields':{AF['name']:'Provision of a valid EICR','fldx4qCw17UfrKpaN':'Today'}},
}
def fetch(i):
    if i not in DB: raise RuntimeError('404 NOT_FOUND')
    return DB[i]
def rec(name, notes='', extra=None):
    return {'id':'recTHIS0000000001','createdTime':'2026-09-03T10:00:00.000Z','fields':{AF['name']:name,AF['description']:'',AF['notes']:notes, **(extra or {})}}
def lvl(out, tt, name, notes='', agent_banner=None, extra=None):
    d = ad.decision_level(out, tt, rec(name, notes, extra), fetch=fetch, agent_banner=agent_banner)
    return {k: d.get(k) for k in ('level','category','carry','money','keeper','tierChecked')} | {'text': d.get('evidence') or d.get('why')}
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
  it('a tier-1 matter is Level C whatever the shape, outside the two verifiable closes', () => {
    const d = py(`print(json.dumps(lvl('PASS TO ROY: forward it', 'Admin', 'INBOUND: bailiff notice of enforcement')))`);
    expect(d.level).toBe('C');
    expect(d.category).toBe('tier-1 matter');
    const n = py(`print(json.dumps(lvl('PASS TO ROY: boiler', 'Admin', 'MAINTENANCE: boiler repair 6 Chedburgh Place', 'run log: this task once touched the restraint order')))`);
    expect(n.level).toBe('C');
  });
  it('the banner alone makes a non-close Level C', () => {
    const d = py(`print(json.dumps(lvl(ad.TIER1_BANNER + '\\n\\nPASS TO ROY: boiler', 'Admin', 'MAINTENANCE: boiler')))`);
    expect(d.level).toBe('C');
  });
});

// Kevin, 15 Sep 2026: a duplicate close is decided on the twin's own name,
// description and banner. Its Notes hold every agent's run log, and one
// stale "tier 1" there sent rec5cIuxkG3CfSijF (correct wording, keeper older
// and open) to his queue. Same fault class as the 14 Sep alert-lane bug.
describe('the tier check for a close never reads the Notes', () => {
  it('rec5cIuxkG3CfSijF shape: a tier word only in the Notes still folds at Level A', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recKEEPER00000001', 'Admin', 'INBOUND (follow-up): Pingen PDF action required', '[08 Sep 2026 11:30 — agent-dispatch] HANDLED WITHOUT YOU ... tier 1 ... restraint order')))`);
    expect(d.level).toBe('A');
    expect(d.carry).toBe('close');
    expect(d.keeper).toBe('recKEEPER00000001');
    expect(d.tierChecked).toBe(true);
    expect(d.text).not.toMatch(/tier-1/);
  });
  it('an already-handled close with a tier word only in the Notes acts too', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: already handled — see recDONE0000000001', 'Admin', 'x', 'notes mention a solicitor')))`);
    expect(d.level).toBe('A');
    expect(d.tierChecked).toBe(true);
  });
  it('a tier-1 word in the NAME still folds when the keeper is open, and says the output is carried', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recKEEPER00000001', 'Admin', 'INBOUND: bailiff notice of enforcement')))`);
    expect(d.level).toBe('A');
    expect(d.text).toMatch(/tier-1 twin \(notice of enforcement\): its Agent Output is carried onto the keeper's Notes, the open task Kevin will see/);
  });
  it('the banner on the twin counts the same way: open keeper folds, the twin\'s output carried', () => {
    const d = py(`print(json.dumps(lvl(ad.TIER1_BANNER + '\\n\\nCLOSE PROPOSAL: duplicate of recKEEPER00000001', 'Admin', 'plain name')))`);
    expect(d.level).toBe('A');
    expect(d.text).toMatch(/tier-1 twin \(banner\)/);
  });
  it('THE SUBMIT PATH: a banner submit itself prepended from the Notes is not a tier signal', () => {
    // cmd_submit prepends TIER1_BANNER whenever the Notes match, then calls
    // decision_level with agent_banner=False. The Completed older keeper is
    // the case that separates the two: an agent-written banner makes it C.
    const notesOnly = py(`print(json.dumps(lvl(ad.TIER1_BANNER + '\\n\\nCLOSE PROPOSAL: duplicate of recOLDERDONE00001', 'Admin', 'INBOUND (follow-up): Pingen PDF action required', 'run log says tier 1', agent_banner=False)))`);
    expect(notesOnly.level).toBe('A');
    expect(notesOnly.text).not.toMatch(/tier-1/);
    const agentWrote = py(`print(json.dumps(lvl(ad.TIER1_BANNER + '\\n\\nCLOSE PROPOSAL: duplicate of recOLDERDONE00001', 'Admin', 'plain name', '', agent_banner=True)))`);
    expect(agentWrote.level).toBe('C');
    const handled = py(`print(json.dumps(lvl(ad.TIER1_BANNER + '\\n\\nCLOSE PROPOSAL: already handled — see recDONE0000000001', 'Admin', 'x', 'notes mention a solicitor', agent_banner=False)))`);
    expect(handled.level).toBe('A');
  });
  it('cmd_submit reads the agent\'s banner BEFORE its own prepend and hands it to decision_level', () => {
    // Both prepends come AFTER the read: the --tier1 one (the dispatch queue
    // sets that flag from a Notes match too) and the Notes-match one.
    const sub = SRC.slice(SRC.indexOf('def cmd_submit(args):'));
    const i = sub.indexOf('agent_banner = TIER1_BANNER in output');
    const j1 = sub.indexOf('if args.tier1 and TIER1_BANNER not in output:');
    const j2 = sub.indexOf('if is_tier1 and TIER1_BANNER not in output:');
    const k = sub.indexOf('level = decision_level(output, args.type, trec, agent_banner=agent_banner)');
    expect(i).toBeGreaterThan(0);
    expect(j1).toBeGreaterThan(i);
    expect(j2).toBeGreaterThan(j1);
    expect(k).toBeGreaterThan(j2);
  });
  it('a tier-1 twin whose keeper is Completed stays Level C: no card would carry its output', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recOLDERDONE00001', 'Admin', 'INBOUND: bailiff notice of enforcement')))`);
    expect(d.level).toBe('C');
    expect(d.text).toMatch(/keeper recOLDERDONE00001 is Completed/);
  });
  it('a tier-1 twin on an already-handled close stays Level C', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: already handled — see recDONE0000000001', 'Admin', 'INBOUND: statutory demand')))`);
    expect(d.level).toBe('C');
  });
  it('a non-tier twin still folds into a Completed older keeper, as before', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recOLDERDONE00001', 'Admin', 'INBOUND: Pingen letters')))`);
    expect(d.level).toBe('A');
  });
});

describe('either creation order folds when both are open and the fold check agrees (15 Sep 2026)', () => {
  it('rec2nZRQ1Y4ZXj9mA shape: a NEWER open keeper whose name is the same matter is Level A, and the evidence says which was kept', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recNEWERSAME00001', 'Admin', 'CORRESPONDENCE: EICR quote follow-up - AC1 Electrical Services - 6 Chedburgh Place')))`);
    expect(d.level).toBe('A');
    expect(d.text).toMatch(/kept the NEWER task \(both about ac1, eicr, electrical/);
  });
  it('an older keeper records that the older task was kept', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recKEEPER00000001', 'Admin', 'INBOUND: pay Sefton licence')))`);
    expect(d.text).toMatch(/kept the older task/);
  });
  it('a NEWER keeper across lanes is still a card: folding may not cross lanes', () => {
    // Since Kevin's ruling of 15 Sep 2026 the lane is read off both RECORDS
    // ahead of the age check, so the refusal names the lanes, not the age.
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recNEWERLANE00001', 'Admin', 'INBOUND: SMS reply from +447700900747')))`);
    expect(d.level).toBe('B');
    expect(d.text).toMatch(/this is a reply task and keeper recNEWERLANE00001 is a maintenance task/);
  });
  // The lane is reply-vs-maintenance ONLY (Kevin, 15 Sep 2026): agent
  // prefixes are not lanes, and the record's Maintenance Ticket tick or Roy
  // as holder says repair whatever the name says. Every ticked ticket on the
  // live board that day was unprefixed or INBOUND:, so a name-only lane read
  // them all as reply tasks and let an agent task absorb Roy's job.
  it('a repair twin never closes as a duplicate of a reply keeper, whichever is older, read off the record', () => {
    const roy = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recKEEPER00000001', 'Admin', 'Sefton licence fee', '', extra={AF['teamMember']:['reclbdjfVev3bqNHS']})))`);
    expect(roy.level).toBe('B');
    expect(roy.text).toMatch(/this is a maintenance task and keeper recKEEPER00000001 is a reply task/);
    const ticked = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recKEEPER00000001', 'Admin', 'INBOUND: Sefton licence fee', '', extra={AF['maintenanceTicket']:True})))`);
    expect(ticked.level).toBe('B');
    expect(ticked.text).toMatch(/this is a maintenance task/);
  });
  it('a reply twin never closes into an unprefixed repair keeper (Roy-held or ticked)', () => {
    for (const k of ['recROYJOB00000001', 'recTICKED00000001']) {
      const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of ${k}', 'Admin', 'COMPLIANCE: Provision of a valid EICR - 18 Siddows Avenue Clitheroe')))`);
      expect(d.level, k).toBe('B');
      expect(d.text).toMatch(new RegExp(`this is a reply task and keeper ${k} is a maintenance task`));
    }
    // CONTROL: the same words into an unprefixed, unticked, un-Roy keeper fold.
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recPLAIN000000001', 'Admin', 'COMPLIANCE: Provision of a valid EICR - 18 Siddows Avenue Clitheroe')))`);
    expect(d.level).toBe('A');
    expect(d.keeper).toBe('recPLAIN000000001');
  });
  it('two reply tasks under different agent prefixes are one lane and fold (COMPLIANCE into CORRESPONDENCE)', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recNEWERSAME00001', 'Admin', 'COMPLIANCE: EICR quote follow-up - AC1 Electrical Services - 6 Chedburgh Place')))`);
    expect(d.level).toBe('A');
    expect(d.text).toMatch(/kept the NEWER task/);
  });
  it('a NEWER keeper that is not open is a card', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of recNEWERDONE00001', 'Admin', 'CORRESPONDENCE: EICR quote follow-up - AC1 Electrical Services - 6 Chedburgh Place')))`);
    expect(d.level).toBe('B');
    expect(d.text).toMatch(/NEWER than this task and Completed/);
  });
});

describe('the widened duplicate wording (15 Sep 2026)', () => {
  it('"CLOSE PROPOSAL: duplicate — ... (recXXX, submitted 7 Sep)" names its keeper and is verified like any other', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate — Property Admin submitted a more recent version of the same reply (recKEEPER00000001, submitted 7 Sep 2026 at 02:10) covering the same step.', 'Admin', 'INBOUND: pay Sefton licence')))`);
    expect(d.level).toBe('A');
    expect(d.keeper).toBe('recKEEPER00000001');
  });
  it('the keeper is the FIRST record id on the line, and a bad one still makes a card', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate: recMISSING0000001 covers this (see also recKEEPER00000001)', 'Admin', 'x')))`);
    expect(d.level).toBe('B');
    expect(d.text).toMatch(/keeper recMISSING0000001 could not be read/);
  });
  it('a duplicate line with no record id at all is still judgement', () => {
    const d = py(`print(json.dumps(lvl('CLOSE PROPOSAL: duplicate of the Sefton task, closing', 'Admin', 'x')))`);
    expect(d.category).toBe('close: judgement');
  });
  it('the page classifier reads the same widened wording', () => {
    const acc = readFileSync(resolve(ROOT, 'js/agent-accuracy.js'), 'utf8');
    expect(acc).toContain('/^CLOSE PROPOSAL:\\s*duplicate\\b[^\\n]*?rec[A-Za-z0-9]{14}\\b/i');
  });
});

describe('the fold carries the twin\'s Agent Output onto the keeper BEFORE closing it', () => {
  it('carry_output_to_keeper appends the stored output to the keeper Notes, and the twin closes after', () => {
    const d = py(`
calls = []
ad.get_task = lambda i: {'id': i, 'fields': {AF['notes']: 'existing keeper notes'}}
ad.patch_task = lambda i, f: calls.append((i, f))
twin = {AF['name']: 'INBOUND: twin', AF['agentOutput']: 'TO: a@b.com\\nthe draft Kevin never saw', AF['description']: 'desc'}
block = ad.carry_output_to_keeper('recTWIN0000000001', twin, 'recKEEPER00000001', '15 Sep 2026 10:00')
print(json.dumps({'calls': [[i, f[AF['notes']]] for i, f in calls], 'block': block}))`);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0][0]).toBe('recKEEPER00000001');
    expect(d.calls[0][1]).toMatch(/^existing keeper notes\n\n\[15 Sep 2026 10:00 — agent-dispatch\] FOLDED recTWIN0000000001 "INBOUND: twin" into this task at Level A\. Its Agent Output, carried/);
    expect(d.calls[0][1]).toContain('the draft Kevin never saw');
  });
  it('a retry does not write a second FOLDED block onto the keeper', () => {
    const d = py(`
calls = []
ad.get_task = lambda i: {'id': i, 'fields': {AF['notes']: '[s — agent-dispatch] FOLDED recTWIN0000000001 "t" into this task at Level A. Its Agent Output, carried here so nothing on the folded card is lost:\\nold'}}
ad.patch_task = lambda i, f: calls.append(i)
r = ad.carry_output_to_keeper('recTWIN0000000001', {AF['name']: 't', AF['agentOutput']: 'again'}, 'recK', 's')
print(json.dumps([r, calls]))`);
    expect(d).toEqual(['', []]);
  });
  it('falls back to the description when the twin has no stored output, and cuts a huge one', () => {
    const d = py(`
calls = []
ad.get_task = lambda i: {'id': i, 'fields': {}}
ad.patch_task = lambda i, f: calls.append(f[AF['notes']])
ad.carry_output_to_keeper('recTWIN0000000001', {AF['name']: 't', AF['description']: 'only a description'}, 'recK', 's')
ad.carry_output_to_keeper('recTWIN0000000001', {AF['name']: 't', AF['agentOutput']: 'x' * 30000}, 'recK', 's')
print(json.dumps([calls[0], len(calls[1]), '[… cut at' in calls[1]]))`);
    expect(d[0]).toMatch(/Its description, carried here[\s\S]*only a description$/);
    expect(d[1]).toBeLessThan(21000);
    expect(d[2]).toBe(true);
  });
  it('in the close carry-out the keeper write comes before the twin\'s close, and the twin\'s marker says so', () => {
    const close = SRC.slice(SRC.indexOf('    if carry == "close":'), SRC.indexOf('    elif carry == "roy":'));
    const i = close.indexOf('carry_output_to_keeper(args.task, tf, keeper_id, stamp)');
    const j = close.indexOf('patch_task(args.task, fields)');
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    expect(close).toMatch(/carried onto keeper \{keeper_id\}'s Notes/);
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
  it('cmd_submit consults decision_level after the informational branch; tier 1 vetoes Level A unless the close ran its own tier check', () => {
    const i = SRC.indexOf('files_itself = informational_only(output, args.type');
    const j = SRC.indexOf('level = decision_level(output, args.type, trec, agent_banner=agent_banner)');
    // `and not (kevin_step or cur_wall)` (25 Sep 2026): a declared KEVIN ONLY step or an open KEVIN wall is never a Level A close.
    const k = SRC.indexOf('if level["level"] == AUTONOMY_ACT and (not is_tier1 or level.get("tierChecked")) and not (kevin_step or cur_wall):');
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
