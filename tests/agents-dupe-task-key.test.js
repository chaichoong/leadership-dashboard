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
  // eslint-disable-next-line no-new-func
  return new Function(`${v[0]}\n${st[0]}\n${pt[0]}\n${m[0]}; return dupeTaskKey;`)();
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
  const py = (code) => JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(SCRIPT)})
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
${code}`], { encoding: 'utf8' }));

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
  });
});
