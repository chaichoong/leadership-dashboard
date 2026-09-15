import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(resolve(ROOT, 'os/agents/index.html'), 'utf8');
const PAGE = resolve(ROOT, 'os/agents/index.html');
const SCRIPT = resolve(ROOT, 'scripts/create-agent-task.py');

// The AI Agents page's Duplicates lane keys open tasks by dupeTaskKey so
// "Chase Acme invoice #2" and "Chase Acme invoice #3" collide. The token
// rules follow the reconciliation vendor-key lesson (Known Anti-Patterns:
// per-transaction references baked into a key mean nothing ever gets a
// second hit). Extract the REAL function from the page source — a copied
// implementation here would let the page drift while the test stays green
// (the recon-vendor-key.test.js rule).

function loadDupeTaskKey() {
  const m = SRC.match(/function dupeTaskKey\([\s\S]*?\n\}/);
  if (!m) throw new Error('dupeTaskKey not found in os/agents/index.html');
  // The key depends on the shared DUPE_GENERIC vocabulary (added 27 Aug 2026
  // when the key became an incident anchor). Extract that from the page too,
  // rather than copying the word list here — a copied vocabulary is exactly
  // the drift this test exists to catch.
  const v = SRC.match(/const DUPE_GENERIC = \[[\s\S]*?\];/);
  if (!v) throw new Error('DUPE_GENERIC not found in os/agents/index.html');
  // Since 28 Aug 2026 the key also defers ADDRESS words to the back of the
  // queue for its two slots, so it needs placeTokens and the street list.
  // Extracted from the page for the same reason as the vocabulary above: a
  // copy here is the drift this file exists to catch.
  const st = SRC.match(/const DUPE_STREET_TYPES = \[[\s\S]*?\];/);
  if (!st) throw new Error('DUPE_STREET_TYPES not found in os/agents/index.html');
  const pt = SRC.match(/function placeTokens\([\s\S]*?\n\}/);
  if (!pt) throw new Error('placeTokens not found in os/agents/index.html');
  // Since 15 Sep 2026 weekday and month words never count as distinctive
  // (Kevin's ruling), so the key needs DUPE_DATE_WORDS too.
  const dw = SRC.match(/const DUPE_DATE_WORDS = \[[\s\S]*?\];/);
  if (!dw) throw new Error('DUPE_DATE_WORDS not found in os/agents/index.html');
  // eslint-disable-next-line no-new-func
  return new Function(`${v[0]}\n${dw[0]}\n${st[0]}\n${pt[0]}\n${m[0]}; return dupeTaskKey;`)();
}

describe('dupeTaskKey — one subject, one key', () => {
  const key = loadDupeTaskKey();

  it('exists in the page source (control)', () => {
    expect(typeof key).toBe('function');
  });

  it('collides the same job carrying different reference numbers', () => {
    expect(key('Chase Acme invoice #2')).toBe(key('Chase Acme invoice #3'));
    expect(key('Reply to British Gas a1252236611488')).toBe(key('Reply to British Gas a1252236611492'));
  });

  it('drops pure numbers and long references, keeps short brand digits', () => {
    expect(key('Renew v12 licence')).toContain('v12');       // two digits = a brand
    expect(key('Pay ref 4471902')).not.toContain('4471902'); // pure digits = reference
    expect(key('Close a1252236611488')).toBe('close');       // letters + 3+ digits = reference
  });

  it('different subjects stay apart', () => {
    expect(key('Chase Acme invoice')).not.toBe(key('Chase Beta invoice'));
  });

  it('a blank or reference-only name yields an empty key, which the lane skips', () => {
    expect(key('')).toBe('');
    expect(key('#12345')).toBe('');
  });
});

// The create-time gate (scripts/create-agent-task.py) carries a Python port
// of dupeTaskKey. If the two ever disagree, the preventer and the detector
// classify the same title differently: the gate lets a sibling through that
// the page then flags, or worse, folds what the page would call distinct.
// Run BOTH implementations over one corpus and demand identical output.
describe('dupe_task_key (Python) matches dupeTaskKey (JS)', () => {
  const key = loadDupeTaskKey();
  const CORPUS = [
    '', '#12345', 'Chase Acme invoice #2', 'Chase Acme invoice #3',
    'INBOUND: Outstanding invoices', 'Renew v12 licence', 'Pay ref 4471902',
    'Reply to British Gas a1252236611488', 'UC47 form for Flat 3B',
    'MAINTENANCE: boiler service, 12 High St', 'Council Tax 23242388 payment arrangement',
    'Fixed cost review: find savings (weekly)', 'Email  with   extra    spaces',
    'MiXeD CaSe TiTlE', '£1,742.60 refund from EDF', '2026-08-25 court hearing',
    'CONTENT (OD): Fri 11 Sep, The offer: Five signs your business runs on you',
    'CONTENT (OD): Mon 14 Sep, The mistake: Most owners write a job advert when admin piles up',
    'Friday 11 September rent statement', 'CONTENT (OD): Fri 11 Sep', 'May Day bank holiday cover',
  ];

  it('every corpus entry keys identically in both languages', () => {
    const script = resolve(ROOT, 'scripts/create-agent-task.py');
    const py = JSON.parse(execFileSync('python3', ['-c', `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(script)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(json.dumps([mod.dupe_task_key(n) for n in json.loads(sys.argv[1])]))
`, JSON.stringify(CORPUS)], { encoding: 'utf8' }));
    expect(py).toEqual(CORPUS.map(key));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 27 Aug 2026: the incident anchor. These ten task names are the REAL open
// approvals from that morning's queue — ten tasks covering four incidents,
// every one of which the old key read as a distinct subject. Back-tested:
// restoring the old "every significant word in order" key regroups them as
// ten singletons and fails every GROUPS case below.
// ─────────────────────────────────────────────────────────────────────────────
describe('dupeTaskKey — the live clog it was rewritten for', () => {
  const key = loadDupeTaskKey();
  const group = (names) => {
    const g = {};
    names.forEach(n => { (g[key(n)] = g[key(n)] || []).push(n); });
    return g;
  };

  const INVOICES = [
    'INBOUND: Google Apps Script Invoices Dashboard failing, investigate and fix',
    'INBOUND: Invoices Dashboard Apps Script failures',
    'INBOUND: Invoices Dashboard Apps Script failing again',
  ];
  const INTAKE = [
    'INBOUND: Google Apps Script Meetings Intake failing repeatedly, investigate and fix',
    'INBOUND: Meetings Intake script failing with Gmail quota error',
    'INBOUND: Google Apps Script Meetings Intake failing, Gmail quota exceeded',
  ];
  const SUPABASE = [
    'INBOUND: Meetings to Supabase Apps Script failures',
    'INBOUND: investigate Meetings to Supabase script failure',
  ];
  const KV = [
    'INBOUND: Cloudflare KV put limit exceeded - investigate and fix',
    'INBOUND: Cloudflare KV at 90 percent daily limit, review usage and consider upgrade',
  ];

  it('GROUPS each incident, however differently the AI worded it', () => {
    for (const [label, set] of Object.entries({ INVOICES, INTAKE, SUPABASE, KV })) {
      expect(Object.keys(group(set)), `${label} must be one key`).toHaveLength(1);
    }
  });

  it('keeps the four incidents apart (control — one key for all ten would also "group")', () => {
    const all = [...INVOICES, ...INTAKE, ...SUPABASE, ...KV];
    expect(Object.keys(group(all))).toHaveLength(4);
  });

  it('does not merge two different scripts that share a word', () => {
    // "Meetings Intake" and "Meetings to Supabase" are separate Apps Scripts.
    // With the lane prefix left in the words this pair merged, because
    // "INBOUND" ate one of the two subject slots.
    expect(key(INTAKE[0])).not.toBe(key(SUPABASE[0]));
  });

  it('keeps the maintenance lane separate from the inbound lane', () => {
    // Deliberate: the triage skill only dedupes a lane-13 thread against other
    // maintenance tasks, so collapsing these would cross a designed boundary.
    expect(key('MAINTENANCE: SMS reply from 447738707077 - unknown content'))
      .not.toBe(key('INBOUND: Incoming SMS from +447738707077'));
  });

  it('platform and outcome words alone never make a key', () => {
    // "Google Apps Script ... failing, investigate and fix" describes any
    // incident equally. Two unrelated failures must not collide on it.
    expect(key('INBOUND: Google Apps Script Payroll Export failing, investigate and fix'))
      .not.toBe(key('INBOUND: Google Apps Script Invoices Dashboard failing, investigate and fix'));
  });
});


// ── A DATE SAYS WHEN, NOT WHICH (Kevin's ruling, 15 Sep 2026) ───────────────
//
// The key keeps the first two distinctive words. Content Engine cards are
// titled "CONTENT (OD): Fri 11 Sep, The offer: ...", so every card on one
// weekday keyed to `fri sep`: measured read-only on 15 Sep 2026, 19 of the 22
// Approval cards paired on the weekday and month alone, and would have folded
// into one had they passed the create gate with no sender. Back-tested:
// removing DUPE_DATE_WORDS from the filter fails the first case below.
describe('dupeTaskKey — weekday and month words never count', () => {
  const key = loadDupeTaskKey();
  // Verbatim off the live Approval queue of 15 Sep 2026.
  const FRI_OFFER = 'CONTENT (OD): Fri 11 Sep, The offer: Five signs your business runs on you';
  const FRI_NEWS = 'CONTENT (OD): Fri 11 Sep, Newsletter: The map: how AI agents take 90% of your daily work';
  const FRI_OFFER_NEXT = 'CONTENT (OD): Fri 18 Sep, The offer: Five signs your business runs on you';

  it('two Content Engine cards on one weekday key apart', () => {
    expect(key(FRI_OFFER)).not.toBe(key(FRI_NEWS));
    expect(key(FRI_OFFER)).not.toMatch(/\b(fri|sep)\b/);
  });

  it('a date in any spelling is not a key slot', () => {
    expect(key('Monday 7 September rent statement')).toBe(key('Friday 11 October rent statement'));
    expect(key('Chase EDF Tues 8 Sept')).toBe(key('Chase EDF Thurs 10 Oct'));
    expect(key('May Day bank holiday cover')).not.toContain('may');
  });

  it('a date-only name still keys by its words rather than to empty', () => {
    // The fallback keeps the full word list so a nameless key cannot collide
    // everything; two different dates stay two keys.
    expect(key('CONTENT (OD): Fri 11 Sep')).not.toBe('');
    expect(key('Fri 11 Sep')).not.toBe(key('Mon 14 Sep'));
  });

  it('the same subject a week apart still groups by the verdict, on its words', () => {
    const py = JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(SCRIPT)})
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
print(json.dumps([c.dupe_verdict(sys.argv[1], sys.argv[2], "group"),
                  c.dupe_verdict(sys.argv[3], sys.argv[2], "group"),
                  c.dupe_verdict("CONTENT (OD): Fri 11 Sep, Newsletter",
                                 "CONTENT (OD): Fri 11 Sep, The offer", "group")]))
`, FRI_OFFER, FRI_OFFER_NEXT, FRI_NEWS], { encoding: 'utf8' }));
    const [same, different, dateOnly] = py;
    expect(same.match, 'same offer post on two Fridays is one matter').toBe(true);
    expect(same.why).toContain('signs');
    expect(same.why).not.toMatch(/\b(fri|sep)\b/);
    // CONTROL: the shared weekday and month alone never make a match.
    expect(different.match, 'a shared Friday in September is not a shared subject').toBe(false);
    // BACK-TEST (the reviewer's find): the long pair above was already refused
    // on the ratio before this change. This short pair shares ONLY the date,
    // and with DUPE_DATE_WORDS emptied it matched on "both about fri, sep".
    expect(dateOnly.match, 'a date is never a subject').toBe(false);
  });
});


// ── THE SECOND PASS (28 Aug 2026) ──────────────────────────────────────────
//
// Kevin, working the queue: "there's still a lot where I seem to see some
// duplication with something referencing the same issue but with slightly
// different information." Measured against the 55 tasks waiting, the exact key
// made 43 cards and missed seven real pairs.
//
// dupe_verdict is the second pass. It lives in Python (create-agent-task.py,
// the creation gate) and in JS (os/agents/index.html, the queue display), and
// the two MUST agree — a pair folded at creation but shown separately in the
// queue, or the reverse, is worse than either behaviour alone.
describe('dupe_verdict — same matter, different words', () => {
  const py = (code, arg = '') => JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(SCRIPT)})
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
${code}`, arg], { encoding: 'utf8' }));

  const verdict = (a, b, mode = 'group') => py(
    `print(json.dumps(c.dupe_verdict(${JSON.stringify(a)}, ${JSON.stringify(b)}, ${JSON.stringify(mode)})))`);

  it('catches the seven pairs the exact key missed', () => {
    const pairs = [
      ['INBOUND: Sefton Council HMO licence fee 150 unpaid 23 Viola St Bootle urgent',
       'INBOUND: pay Sefton landlord licence fee 150 GBP for 23 Viola Street Bootle'],
      ['INBOUND: Anglia Revenues council tax arrears further recovery - call or respond',
       'INBOUND: respond to Anglia Revenues re council tax arrears (Kevin & Ciara)'],
      ['INBOUND: Stripe Boost 100 payouts paused - provide business info urgently',
       'INBOUND: Stripe action required - provide business info for Boost 100'],
      ['INBOUND: 1406 Oldham Road electrical safety cert outstanding - Hannah Lea chasing',
       'INBOUND (follow-up): 1406 Oldham Road EICR cert - send to Manchester Council'],
      ['INBOUND: SMS reply from +447538631747',
       'MAINTENANCE: SMS from 447538631747 - maintenance reply'],
      ['INBOUND: Incoming SMS from +447738707077',
       'MAINTENANCE: SMS reply from 447738707077 - unknown content'],
    ];
    pairs.forEach(([a, b]) => {
      const v = verdict(a, b);
      expect(v.match, `${a}\n  vs ${b}`).toBe(true);
      expect(v.why, 'a fold with no stated reason cannot be audited').toBeTruthy();
    });
  });

  it('an address says WHERE, not WHICH', () => {
    // Kevin has ~27 properties with many open tasks each. Counting address
    // words would eventually fold a garden complaint into a rent arrears chase.
    expect(verdict(
      'INBOUND: Sefton Council HMO licence fee 150 unpaid 23 Viola St Bootle urgent',
      'INBOUND: action overdue licensing tasks 23 Viola Street Bootle - EICR and Gas').match)
      .toBe(false);
  });

  it('two different phone numbers never merge on the words around them', () => {
    expect(verdict('INBOUND: SMS reply from +447538631747',
                   'MAINTENANCE: SMS reply from 447738707077 - unknown content').match).toBe(false);
  });

  it('FOLDING keeps the lane rule that GROUPING drops', () => {
    // Folding is destructive; a maintenance job absorbed into a reply task is
    // a real obligation lost. Showing them together costs nothing.
    const a = 'INBOUND: SMS reply from +447538631747';
    const b = 'MAINTENANCE: SMS from 447538631747 - maintenance reply';
    expect(verdict(a, b, 'group').match).toBe(true);
    expect(verdict(a, b, 'fold').match).toBe(false);
  });

  // Kevin's ruling, 15 Sep 2026: for FOLDING the lane test means only
  // reply-vs-maintenance. Until then the fold lane was the raw name prefix,
  // so two reply tasks written up by different agents refused to fold and
  // both stayed in his queue. The two live shapes, verbatim off the board:
  // rec2nZRQ1Y4ZXj9mA (COMPLIANCE) against its keeper recODSge5r6SZ3IqQ
  // (CORRESPONDENCE), and the "INBOUND (follow-up):" / "INBOUND:" pairs.
  // Back-tested: restoring `lane = prefix` fails the first two expectations.
  it('two reply tasks under different agent prefixes are ONE lane and fold', () => {
    const chedburgh = verdict(
      'COMPLIANCE: EICR quote follow-up - AC1 Electrical Services - 6 Chedburgh Place',
      'CORRESPONDENCE: Reply to AC1 Electrical - EICR bedroom count - 6 Chedburgh Place', 'fold');
    expect(chedburgh.match, 'COMPLIANCE vs CORRESPONDENCE is not a lane difference').toBe(true);
    expect(chedburgh.why).toContain('eicr');
    const oldham = verdict(
      'INBOUND: 1406 Oldham Road electrical safety cert outstanding - Hannah Lea chasing',
      'INBOUND (follow-up): 1406 Oldham Road EICR cert - send to Manchester Council', 'fold');
    expect(oldham.match, 'INBOUND (follow-up) vs INBOUND is not a lane difference').toBe(true);
    expect(oldham.why).toBe('same reference 1406');
    expect(verdict('INBOUND: SMS reply from +447538631747',
                   'INBOUND (follow-up): SMS from 447538631747 - chase', 'fold').match).toBe(true);
  });

  it('a repair ticket still never folds into a reply task, whichever prefix spells it', () => {
    // The 28 Aug lesson stands: a maintenance job absorbed into a reply task
    // is a real obligation lost. REPAIR: and MAINTENANCE: are the same lane
    // as each other and a different lane from every reply prefix.
    const reply = 'INBOUND: SMS reply from +447538631747';
    for (const repair of ['REPAIR: SMS from 447538631747 - leaking tap',
                          'MAINTENANCE: SMS from 447538631747 - leaking tap']) {
      expect(verdict(reply, repair, 'fold').match, repair).toBe(false);
      expect(verdict(reply, repair, 'group').match, `${repair} still SHOWS together`).toBe(true);
    }
    expect(verdict('COMPLIANCE: EICR quote follow-up - AC1 Electrical - 6 Chedburgh Place',
                   'REPAIR: EICR remedial works - AC1 Electrical - 6 Chedburgh Place', 'fold').match)
      .toBe(false);
    // CONTROL: two repair tickets on one thread are one lane and DO fold.
    expect(verdict('REPAIR: SMS from 447538631747 - leaking tap',
                   'MAINTENANCE: SMS reply from +447538631747', 'fold').match).toBe(true);
  });

  // 20260901-inbound-comms-triage-427. On 1 Sep 2026 an HMRC compliance-check
  // task was folded into a Fylde council tax demand and lost, because the
  // 4-digit reference rule read the YEAR "2026" as a shared reference number
  // and a shared strong id is proof on its own. Nearly every task name a post
  // or mail scan produces carries the current year, so the gate was matching
  // against anything. Back-tested: deleting _is_calendar_year makes the first
  // expectation below fail.
  it('a calendar year is never a reference number', () => {
    expect(verdict(
      'INBOUND: HMRC compliance check 2026 self assessment',
      'INBOUND: Fylde Council Tax 2026 demand').match,
      'two unrelated matters must not fold on the year alone').toBe(false);
    // CONTROL: a real reference still folds, so the guard has not simply
    // switched strong ids off.
    const real = verdict('INBOUND: council tax ref 148778 summons',
                         'INBOUND: pay summons 148778 arrangement');
    expect(real.match).toBe(true);
    expect(real.why).toContain('148778');
    // A four-digit number that is not a plausible year is still a reference.
    expect(verdict('INBOUND: account 4821 in arrears',
                   'INBOUND: arrears on account 4821').match).toBe(true);
  });

  it('the page and the creation gate carry the SAME thresholds and word lists', () => {
    const pySrc = readFileSync(SCRIPT, 'utf8');
    const jsSrc = readFileSync(PAGE, 'utf8');
    const nums = (src, name, re) => {
      const m = src.match(re);
      expect(m, `${name} not found`).toBeTruthy();
      return m[1];
    };
    expect(nums(pySrc, 'py MIN_SHARED', /DUPE_MIN_SHARED = (\d+)/))
      .toBe(nums(jsSrc, 'js MIN_SHARED', /DUPE_MIN_SHARED = (\d+)/));
    expect(nums(pySrc, 'py MIN_RATIO', /DUPE_MIN_RATIO = ([\d.]+)/))
      .toBe(nums(jsSrc, 'js MIN_RATIO', /DUPE_MIN_RATIO = ([\d.]+)/));
    const words = (src, name) => {
      const m = src.match(new RegExp(`${name}\\s*=\\s*[[{]([\\s\\S]*?)[\\]}]`));
      expect(m, `${name} not found`).toBeTruthy();
      return [...m[1].matchAll(/["']([a-z]+)["']/g)].map((x) => x[1]).sort();
    };
    // CONTROL: an empty parse either side would compare [] to [] and pass.
    expect(words(pySrc, 'DUPE_ACTION_WORDS').length).toBeGreaterThan(10);
    expect(words(pySrc, 'DUPE_ACTION_WORDS')).toEqual(words(jsSrc, 'DUPE_ACTION_WORDS'));
    expect(words(pySrc, 'DUPE_STREET_TYPES').length).toBeGreaterThan(10);
    expect(words(pySrc, 'DUPE_STREET_TYPES')).toEqual(words(jsSrc, 'DUPE_STREET_TYPES'));
    expect(words(pySrc, 'DUPE_MAINTENANCE_LANE_WORDS').length).toBeGreaterThan(1);
    expect(words(pySrc, 'DUPE_MAINTENANCE_LANE_WORDS')).toEqual(words(jsSrc, 'DUPE_MAINTENANCE_LANE_WORDS'));
    expect(words(pySrc, 'DUPE_DATE_WORDS').length).toBeGreaterThan(30);
    expect(words(pySrc, 'DUPE_DATE_WORDS')).toEqual(words(jsSrc, 'DUPE_DATE_WORDS'));
    expect(words(pySrc, 'DUPE_GENERIC').length).toBeGreaterThan(10);
    expect(words(pySrc, 'DUPE_GENERIC')).toEqual(words(jsSrc, 'DUPE_GENERIC'));
  });

  // Matching constants are necessary, not sufficient: the lane derivation is
  // logic, and the 15 Sep 2026 change touched it in both languages. Run the
  // page's OWN dupeVerdict (extracted, never copied) and the gate's
  // dupe_verdict over one corpus in both modes and demand identical calls.
  it('the page and the creation gate return the SAME verdict on one corpus, both modes', () => {
    const grab = (re, label) => {
      const m = SRC.match(re);
      if (!m) throw new Error(`${label} not found in os/agents/index.html`);
      return m[0];
    };
    const jsVerdict = new Function([
      grab(/const DUPE_GENERIC = \[[\s\S]*?\];/, 'DUPE_GENERIC'),
      grab(/const DUPE_DATE_WORDS = \[[\s\S]*?\];/, 'DUPE_DATE_WORDS'),
      grab(/const DUPE_ACTION_WORDS = \[[\s\S]*?\];/, 'DUPE_ACTION_WORDS'),
      grab(/const DUPE_STREET_TYPES = \[[\s\S]*?\];/, 'DUPE_STREET_TYPES'),
      grab(/const DUPE_MIN_SHARED = [\d.]+;/, 'DUPE_MIN_SHARED'),
      grab(/const DUPE_MIN_RATIO = [\d.]+;/, 'DUPE_MIN_RATIO'),
      grab(/const DUPE_MAINTENANCE_LANE_WORDS = \[[\s\S]*?\];/, 'DUPE_MAINTENANCE_LANE_WORDS'),
      grab(/function placeTokens\([\s\S]*?\n\}/, 'placeTokens'),
      grab(/function isCalendarYear\([\s\S]*?\n\}/, 'isCalendarYear'),
      grab(/function dupeSignals\([\s\S]*?\n\}/, 'dupeSignals'),
      grab(/function dupeVerdict\([\s\S]*?\n\}/, 'dupeVerdict'),
      'return dupeVerdict;',
    ].join('\n'))();
    const CORPUS = [
      'INBOUND: SMS reply from +447538631747',
      'INBOUND (follow-up): SMS from 447538631747 - chase',
      'MAINTENANCE: SMS from 447538631747 - maintenance reply',
      'REPAIR: SMS from 447538631747 - leaking tap',
      'COMPLIANCE: EICR quote follow-up - AC1 Electrical Services - 6 Chedburgh Place',
      'CORRESPONDENCE: Reply to AC1 Electrical - EICR bedroom count - 6 Chedburgh Place',
      'INBOUND: 1406 Oldham Road electrical safety cert outstanding - Hannah Lea chasing',
      'INBOUND (follow-up): 1406 Oldham Road EICR cert - send to Manchester Council',
      'INBOUND: Sefton Council HMO licence fee 150 unpaid 23 Viola St Bootle urgent',
      'INBOUND: action overdue licensing tasks 23 Viola Street Bootle - EICR and Gas',
      'INBOUND: HMRC compliance check 2026 self assessment',
      'INBOUND: Fylde Council Tax 2026 demand',
      'Clear and tidy garden',
      // A letters+digits reference must not read as a phone number: without
      // the word boundary the page matched "223661148" inside a1252236611488
      // (found 15 Sep 2026 by this test's reviewer; Python always had \b).
      'INBOUND: Reply to British Gas a1252236611488',
      'INBOUND: Chase EDF a1252236611488',
      // A repeated distinctive word counts once in the ratio (Python set).
      'INBOUND: boiler boiler boiler service quote',
      'INBOUND: boiler service quote from Gasco',
      // Weekday and month words never count (Kevin, 15 Sep 2026); both
      // languages must drop them from the verdict's word set alike.
      'CONTENT (OD): Fri 11 Sep, The offer: Five signs your business runs on you',
      'CONTENT (OD): Fri 18 Sep, The offer: Five signs your business runs on you',
      'CONTENT (OD): Fri 11 Sep, Newsletter: The map: how AI agents take 90% of your daily work',
      '',
    ];
    const pairs = [];
    for (let i = 0; i < CORPUS.length; i++) for (let j = i + 1; j < CORPUS.length; j++) pairs.push([CORPUS[i], CORPUS[j]]);
    const pyAll = py(`
pairs = json.loads(sys.argv[1])
print(json.dumps([[c.dupe_verdict(a, b, m)["match"], c.dupe_verdict(a, b, m)["why"]]
                  for a, b in pairs for m in ("group", "fold")]))`, JSON.stringify(pairs));
    const jsAll = pairs.flatMap(([a, b]) => ['group', 'fold'].map((m) => {
      const v = jsVerdict(a, b, m);
      return [v.match, v.why];
    }));
    // CONTROL: the corpus must exercise both outcomes in fold mode, or an
    // implementation that always refuses would agree with itself.
    const foldMatches = jsAll.filter((_, i) => i % 2 === 1 && jsAll[i][0]).length;
    expect(foldMatches).toBeGreaterThan(3);
    expect(foldMatches).toBeLessThan(pairs.length);
    expect(pyAll).toEqual(jsAll);
  });
});
