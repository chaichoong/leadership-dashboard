import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(resolve(ROOT, 'os/agents/index.html'), 'utf8');

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
  // eslint-disable-next-line no-new-func
  return new Function(`${v[0]}\n${m[0]}; return dupeTaskKey;`)();
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

