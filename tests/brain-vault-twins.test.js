import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// 29 Sep 2026. After the estate moved to the Mac mini, Google Drive rebuilt its
// local database (27 Sep 12:03 UTC) and macOS renamed one of each same-name
// cloud pair to "<name> 2.md": 89 twins in the brain vault, moved by hand to
// Archive/2026-09-29 sync duplicates/. The nightly publisher globbed the whole
// vault, so it indexed every twin and every Archive/ copy into the AI Brain
// Index that "Ask your brain" reads, counted twins as captured documents, and
// counted a twin context doc as a second profile section to confirm.
//
// The publisher lives in ~/knowledge-os, outside git, because it carries
// private markers. It loads the one twin rule, scripts/brain_vault.py, from the
// repo (OD_REPO, default the main checkout). These tests drive the REAL
// publisher's readers against a throwaway vault, with OD_REPO pointed at this
// checkout so they test the helper that is about to ship.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH = join(homedir(), 'knowledge-os', 'publish_brain_today.py');
const COMPOUND_PROMPT = join(homedir(), 'knowledge-os', 'compound_prompt.txt');
const COMPOUND_SKILL = join(homedir(), '.claude', 'skills', 'compound-brain', 'SKILL.md');

const BOX = mkdtempSync(join(tmpdir(), 'brain-twins-'));
afterAll(() => rmSync(BOX, { recursive: true, force: true }));
let n = 0;

// Real notes, including one whose name ends in a number with no sibling, and one
// ending in a year beside its namesake (macOS numbers copies 2 to 99, never 2026).
const LEGIT = 'Decisions/2026-08-24 No caps on agent work, and the triage lane runs at 9, 1 and 5.md';
const YEAR = 'People/Sam Example 2026.md';
const NOTES = ['Decisions/2026-09-20 Rule.md', LEGIT, 'Knowledge/Note.md', 'People/Sam Example.md',
  YEAR, 'founder-profile.md', 'identity/voice.md'];
// Drive sync twins beside their originals, and copies already moved to Archive/.
const TWINS = ['Decisions/2026-09-20 Rule 2.md', 'Knowledge/Note 2.md', 'founder-profile 2.md',
  'identity/voice 2.md'];
const ARCHIVED = ['Archive/2026-09-29 sync duplicates/Knowledge/Old 2.md',
  'Archive/2026-09-29 sync duplicates/Home 2.md'];

function vault() {
  const root = join(BOX, String(++n));
  const put = (rel, body = '# note\nFirst real line.\n') => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  put('_system/brain-questions.md', '# Brain questions\n');
  for (const f of NOTES) put(f);
  for (const f of [...TWINS, ...ARCHIVED]) put(f);
  // Two context docs still await Kevin's check; the twin of one must not count as a third.
  put('founder-profile.md', '# Founder\n[CONFIRM] still open\n');
  put('founder-profile 2.md', '# Founder\n[CONFIRM] still open\n');
  // The twins and the Archive copies are the newest files, so a reader that does
  // not skip them shows them first in "recently filed".
  const later = new Date(Date.now() + 60_000);
  for (const f of [...TWINS, ...ARCHIVED]) utimesSync(join(root, f), later, later);
  return root;
}

function readers(root, repo = ROOT) {
  const py = `
import importlib.util, json, time
spec = importlib.util.spec_from_file_location('pbt', ${JSON.stringify(PUBLISH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.VAULT = ${JSON.stringify(root)}
m.TODAY = time.strftime('%Y-%m-%d')
index = m.brain_index()
print(json.dumps({
    'index': sorted(n['folder'] + '/' + n['name'] for n in index),
    'notes': sorted(rel for _, rel in m.notes_iter()),
    'recent': [c['folder'] + '/' + c['name'] for c in m.recently_filed(limit=3)],
    'counts': m.counts(),
    'profile': m.setup_status(index)['profile'],
}))
`;
  return JSON.parse(execFileSync('python3', ['-c', py],
    { encoding: 'utf8', env: { ...process.env, OD_REPO: repo, PYTHONDONTWRITEBYTECODE: '1' } }));
}

beforeAll(() => {
  // The publisher lives outside the repo. Without it there is nothing to prove,
  // so say so loudly rather than pass.
  for (const f of [PUBLISH, COMPOUND_PROMPT, COMPOUND_SKILL]) {
    if (!existsSync(f)) throw new Error(`missing ${f}: this test checks the live brain files`);
  }
});

describe('the brain publisher reads live notes only', () => {
  it('BACK-TEST: the AI Brain Index leaves out sync twins and Archive/', () => {
    const r = readers(vault());
    expect(r.index).toEqual([
      'Context/founder-profile',
      'Decisions/2026-08-24 No caps on agent work, and the triage lane runs at 9, 1 and 5',
      'Decisions/2026-09-20 Rule',
      'Knowledge/Note',
      'People/Sam Example',
      'People/Sam Example 2026',
      'identity/voice',
    ]);
  });

  it('BACK-TEST: "recently filed" and its note walk leave out twins and Archive/', () => {
    const r = readers(vault());
    expect(r.notes).toEqual([...NOTES].sort());
    for (const item of r.recent) {
      expect(item).not.toMatch(/ 2$|^Archive/);
    }
  });

  it('BACK-TEST: a twin is not counted as a document captured today', () => {
    // Every file in the throwaway vault was written today: Decisions has two real
    // rulings and Knowledge one note. Their twins must not make it five.
    expect(readers(vault()).counts.documents).toBe(3);
  });

  it('BACK-TEST: a twin context doc is not a second profile section to confirm', () => {
    const p = readers(vault()).profile;
    expect(p.total).toBe(2);
    expect(p.text).toBe('1 of 2 sections confirmed. Awaiting your check: founder-profile.');
  });

  it('CONTROL: a real note whose name ends in a number stays in the index', () => {
    const r = readers(vault());
    expect(r.index).toContain('Decisions/2026-08-24 No caps on agent work, and the triage lane runs at 9, 1 and 5');
    expect(r.notes).toContain(LEGIT);
    // A year ending is not a copy number, even beside a note of the same stem.
    expect(r.index).toContain('People/Sam Example 2026');
    expect(r.notes).toContain(YEAR);
  });

  it('fails closed: stops at load when the shared rule cannot be found', () => {
    // A missing helper must never mean an unguarded publish. The stop comes at
    // load, before main() reads the vault or touches Airtable. Loaded as a module
    // so even a publisher without the guard never runs its main() from this test.
    const empty = mkdtempSync(join(BOX, 'norepo-'));
    const r = JSON.parse(execFileSync('python3', ['-c', `
import contextlib, importlib.util, io, json
spec = importlib.util.spec_from_file_location('pbt', ${JSON.stringify(PUBLISH)})
m = importlib.util.module_from_spec(spec)
buf, code = io.StringIO(), None
with contextlib.redirect_stdout(buf):
    try:
        spec.loader.exec_module(m)
    except SystemExit as e:
        code = e.code
print(json.dumps({'code': code, 'out': buf.getvalue()}))
`], { encoding: 'utf8', env: { ...process.env, OD_REPO: empty, PYTHONDONTWRITEBYTECODE: '1' } }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^ERROR: /m);
    expect(r.out).toContain(join(empty, 'scripts', 'brain_vault.py'));
  });
});

// The compound pass is a prompt, so its text is the behaviour: there is no code
// to drive. This catches the rule being lost when either file is restored from a
// backup (both sit outside git, with .bak copies beside them).
describe('the nightly compound and the manual skill keep out of Archive/ and twins', () => {
  for (const [label, file] of [['nightly prompt', COMPOUND_PROMPT], ['manual skill', COMPOUND_SKILL]]) {
    it(`${label} carries the Archive and sync-twin rule`, () => {
      const text = readFileSync(file, 'utf8');
      expect(text).toMatch(/Never read, edit, merge, link, stub or index anything under `?Archive\/`?/);
      expect(text).toMatch(/is a Google Drive sync duplicate, never a note/);
      expect(text).toMatch(/Sync duplicates/);
      expect(text).toMatch(/runs at 9, 1 and 5\.md/);
    });
  }
});
