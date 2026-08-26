// The drift scan replaced a Claude phase with a diff. It must fail loudly
// rather than report "clean" when it cannot actually see anything.
//
// WHY IT STOPPED BEING A CLAUDE PHASE (26 Aug 2026, Kevin's restructure)
// The drift monitor was the largest single source of findings — 68 open, on a
// queue of 202 nothing could drain. Its own reports said what that was worth:
// the SOP version metric was "red every day and carries no signal" (23 Aug),
// the schema had not moved between 16 and 24 Aug, and CHECK 4's browser tests
// were skipped every day because nothing runs a browser unattended. What
// survives is CHECK 1 and CHECK 2, which are arithmetic. They now run in about
// two seconds as a wrapped job instead of inside a run that reached 6h43.
//
// THE POINT OF THIS FILE is the three controls. This codebase has twice
// shipped a query that matched nothing and read as healthy for months: a UC
// search that matched 0 of 91 records from April to August, and an accuracy
// card that measured the first 100 of 259 rows. A scan that finds nothing
// looks exactly like a scan that is broken, so each of these exits 2.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/drift-scan.py');
const MONITORING = resolve(__dirname, '../monitoring');
const ROOT = mkdtempSync(join(tmpdir(), 'driftscan-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let box, repo;

/** A schema of `n` tables, each carrying one field. */
function schema(n, extra = {}) {
  const out = {};
  for (let i = 0; i < n; i++) {
    out[`tbl${String(i).padStart(14, '0')}`] = {
      name: `table ${i}`,
      fields: { [`fld${String(i).padStart(14, '0')}`]: { name: `f${i}`, type: 'singleLineText' } },
    };
  }
  return { ...out, ...extra };
}

function writeSchema(name, obj) {
  const p = join(box, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

/** A repo with enough real-looking ids in it to clear the scan floor. */
function seedRepo(ids) {
  mkdirSync(join(repo, 'js'), { recursive: true });
  writeFileSync(join(repo, 'js', 'config.js'),
    ids.map((i) => `const X = '${i}';`).join('\n'));
}

function idsFrom(sch) {
  const out = [];
  for (const [tid, t] of Object.entries(sch)) {
    out.push(tid);
    out.push(...Object.keys(t.fields));
  }
  return out;
}

function scan(args = [], env = {}) {
  const r = spawnSync('python3', [SCRIPT, '--out', box, '--json', ...args], {
    encoding: 'utf8',
    env: { ...process.env, OD_REPO: repo, ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* control failures print to stderr */ }
  return { code: r.status, json, err: r.stderr || '' };
}

beforeEach(() => {
  box = mkdtempSync(join(ROOT, 'box-'));
  repo = mkdtempSync(join(ROOT, 'repo-'));
});

describe('controls — a scan that cannot see must not report clean', () => {
  it('refuses to diff a schema that came back implausibly short', () => {
    // A revoked token, a wrong base id or a changed endpoint all return
    // something schema-shaped. Five tables where there are 122 is that.
    const s = schema(5);
    writeFileSync(join(box, 'reference-map.json'), JSON.stringify({ fields: {}, tables: {} }));
    seedRepo(idsFrom(schema(60)));
    const r = scan(['--schema-file', writeSchema('short.json', s)]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/only 5 tables/);
  });

  it('refuses when the reference map is empty — zero against zero passes for ever', () => {
    const s = schema(60);
    writeFileSync(join(box, 'reference-map.json'), JSON.stringify({ fields: {}, tables: {} }));
    seedRepo(idsFrom(s));
    const r = scan(['--schema-file', writeSchema('s.json', s)]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/reference map is empty/);
  });

  it('refuses when the repo scan finds nothing — the silent-zero trap', () => {
    // The exact shape in CLAUDE.md: a typo in the pattern returns no matches
    // and reads as "no rogue references, all clean".
    const s = schema(60);
    const ids = idsFrom(s);
    writeFileSync(join(box, 'reference-map.json'),
      JSON.stringify({ fields: Object.fromEntries(ids.map((i) => [i, 'x'])), tables: {} }));
    mkdirSync(join(repo, 'js'), { recursive: true });
    writeFileSync(join(repo, 'js', 'empty.js'), '// no ids here at all\n');
    const r = scan(['--schema-file', writeSchema('s.json', s)]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/repo scan found only 0/);
  });

  it('refuses when the schema file cannot be read at all', () => {
    const r = scan(['--schema-file', join(box, 'nope.json')]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/CANNOT VERIFY/);
  });
});

describe('the diff itself', () => {
  function ready(s) {
    const ids = idsFrom(s);
    writeFileSync(join(box, 'reference-map.json'),
      JSON.stringify({ fields: Object.fromEntries(ids.map((i) => [i, 'x'])), tables: {} }));
    seedRepo(ids);
  }

  it('is CLEAN and exits 0 when nothing moved', () => {
    const s = schema(60);
    ready(s);
    writeFileSync(join(box, 'schema-2020-01-01.json'), JSON.stringify(s));
    const r = scan(['--schema-file', writeSchema('s.json', s)]);
    expect(r.code).toBe(0);
    expect(r.json.verdict).toBe('CLEAN');
  });

  it('reports a new table, a rename and a retype, and exits 1', () => {
    const before = schema(60);
    const after = JSON.parse(JSON.stringify(before));
    after['tbl00000000000099'] = { name: 'Creditor Plans', fields: {} };
    after['tbl00000000000000'].fields['fld00000000000000'].name = 'Opening Balance';
    after['tbl00000000000001'].fields['fld00000000000001'].type = 'number';
    ready(after);
    writeFileSync(join(box, 'schema-2020-01-01.json'), JSON.stringify(before));
    const r = scan(['--schema-file', writeSchema('after.json', after)]);
    expect(r.code).toBe(1);
    expect(r.json.verdict).toBe('DRIFT');
    expect(r.json.schema_changes.new_tables.join()).toMatch(/Creditor Plans/);
    expect(r.json.schema_changes.renamed_fields.join()).toMatch(/Opening Balance/);
    expect(r.json.schema_changes.retyped_fields.join()).toMatch(/number/);
    expect(existsSync(join(box, r.json.exceptions_file.replace('monitoring/', '')))
      || existsSync(join(box, `drift-exceptions-${r.json.date}.json`))).toBe(true);
  });

  it('flags a mapped field that no longer exists upstream as DEAD', () => {
    const s = schema(60);
    const ids = idsFrom(s);
    writeFileSync(join(box, 'reference-map.json'), JSON.stringify({
      fields: { ...Object.fromEntries(ids.map((i) => [i, 'x'])), fldDEADDEADDEAD1: 'gone' },
      tables: {},
    }));
    seedRepo(ids);
    writeFileSync(join(box, 'schema-2020-01-01.json'), JSON.stringify(s));
    const r = scan(['--schema-file', writeSchema('s.json', s)]);
    expect(r.code).toBe(1);
    expect(r.json.dead_mapped_ids).toContain('fldDEADDEADDEAD1');
  });

  it('never diffs today against today — that would report clean for ever', () => {
    const s = schema(60);
    ready(s);
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(box, `schema-${today}.json`), JSON.stringify(schema(1)));
    const r = scan(['--schema-file', writeSchema('s.json', s)]);
    // Today's own snapshot is skipped, so with no earlier one it says so
    // rather than silently comparing against itself.
    expect(r.json.compared_against).not.toBe(`schema-${today}.json`);
  });
});

describe('it is wired into the day', () => {
  it('is registered, so the digest notices if it stops', () => {
    const sched = JSON.parse(
      require('node:fs').readFileSync(resolve(__dirname, '../scripts/job-schedule.json'), 'utf8'));
    expect(sched['drift-scan']).toBeTruthy();
    expect(sched['drift-scan'].mode).toBe('wrapped');
  });

  it('the real reference map is present and non-empty', () => {
    // CONTROL 2 fires on an empty map; this proves production is not in that
    // state, so a passing scan tomorrow means something.
    const ref = JSON.parse(require('node:fs').readFileSync(join(MONITORING, 'reference-map.json'), 'utf8'));
    expect(Object.keys(ref.fields || {}).length).toBeGreaterThan(100);
  });
});
