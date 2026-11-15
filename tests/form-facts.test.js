// FORM FACTS (estate fix 3, Nov 2026): Kevin was asked the same house facts again on every form,
// because nothing carried a fact from one form to the next. Now one private file holds them
// (scripts/form-facts.js), a handover plan says whose form it is ("factsFor"), and the robot reads the
// stored facts first. These drive the real store, the real CLI and the real `handover` command against
// a practice page, with the planner stood in. Every name, address and value is invented (public repo).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';

const require_ = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// FORM_FACTS_SCRIPTS_DIR points every test at another copy of the scripts folder, and FORM_FACTS_AB_SCRIPT the
// command tests at another copy of agent-browser.js (the red proof on old code).
const SCRIPTS = process.env.FORM_FACTS_SCRIPTS_DIR || join(ROOT, 'scripts');
const AB = process.env.FORM_FACTS_AB_SCRIPT || join(SCRIPTS, 'agent-browser.js');
const FF_CLI = join(SCRIPTS, 'form-facts.js');
const ff = require_(FF_CLI);
const fsCjs = require_('fs');

const made = [];
const tmp = (p = 'od-ff-') => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };
const HOUSE = 'recTestHouseAa001';
const HOUSE2 = 'recTestHouseBb002';
const TODAY = '2026-11-15';

// A store in the private file's shape, all invented.
function storeOf(over = {}) {
  return Object.assign({
    version: 1,
    general: { facts: { contact: { label: 'Contact', value: 'email only', source: 'test ruling', date: '2026-10-01' } } },
    owners: { 'test-owner': { name: 'Testa Owner Ltd', facts: { 'first-name': { value: 'Testa', source: 'test form', date: '2026-01-01' } } } },
    properties: {
      [HOUSE]: { address: '12 Test Lane', town: 'Testtown', postcode: 'ZZ1 1ZZ', owner: 'test-owner', facts: {
        storeys: { value: '2', source: 'survey test', date: '2026-02-01' },
        'year-built': { value: '1930', source: 'deeds test', date: '2026-02-01' } } },
      [HOUSE2]: { address: '7 Sample Road', town: 'Testtown', postcode: 'ZZ2 2ZZ', owner: 'test-owner', facts: {
        storeys: { value: '3', source: 'survey test', date: '2026-02-01' } } },
    },
  }, over);
}
function fileOf(store = storeOf()) {
  const f = join(tmp(), 'form-facts.json');
  writeFileSync(f, JSON.stringify(store));
  return f;
}

afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

describe('linesFor: the lines a planner reads', () => {
  it('one house: general, owner and house lines, a Property line, and no source or date inside any line', () => {
    const r = ff.linesFor(storeOf(), { owner: 'test-owner', properties: [HOUSE], today: TODAY });
    expect(r.lines).toEqual(['Contact: email only', 'First name: Testa', 'Number of storeys: 2', 'Year built: 1930', 'Property: 12 Test Lane, Testtown, ZZ1 1ZZ']);
    for (const l of r.lines) { expect(l).not.toMatch(/test ruling|survey|deeds|2026-/); }
    expect(r.used.find(u => u.key === 'storeys')).toMatchObject({ scope: 'property', ref: HOUSE, source: 'survey test', date: '2026-02-01' });
    expect(r.problems).toEqual([]);
  });

  it('two houses: each house line carries its address as a tag at the end of the label, and a plain Property line each', () => {
    const r = ff.linesFor(storeOf(), { owner: 'Testa Owner Ltd', properties: ['12 Test Lane', '7 sample road, Testtown ZZ2 2ZZ'], today: TODAY });
    expect(r.lines).toContain('Number of storeys [12 Test Lane]: 2');
    expect(r.lines).toContain('Year built [12 Test Lane]: 1930');
    expect(r.lines).toContain('Number of storeys [7 Sample Road]: 3');
    expect(r.lines.filter(l => /^Property/.test(l))).toEqual(['Property: 12 Test Lane, Testtown, ZZ1 1ZZ', 'Property: 7 Sample Road, Testtown, ZZ2 2ZZ']);
    expect(r.lines).toContain('First name: Testa');
    expect(r.lines).toContain('Contact: email only');
    // One house: no tag.
    expect(ff.linesFor(storeOf(), { properties: [HOUSE], today: TODAY }).lines).toContain('Number of storeys: 2');
  });

  it('a name that is not on file, or matches two houses, is a problem, never a guess or a throw', () => {
    const r = ff.linesFor(storeOf(), { owner: 'Nobody', properties: ['99 Missing Street', '12 Test Lane, Testtown ZZ9 9ZZ'], today: TODAY });
    expect(r.problems).toEqual([{ scope: 'property', ref: '99 Missing Street' }, { scope: 'property', ref: '12 Test Lane, Testtown ZZ9 9ZZ' }, { scope: 'owner', ref: 'Nobody' }]);
    expect(r.lines).toEqual(['Contact: email only']);
  });
});

describe('a fact goes stale on its own clock', () => {
  it('expires by "until" and by the schema\'s goodForDays; expired facts are left out and listed; missing lists the blank keys', () => {
    const s = storeOf();
    s.properties[HOUSE].facts.occupancy = { value: 'Tenanted', source: 'tenancy test', date: '2026-09-01' };   // 30 days: stale
    s.properties[HOUSE].facts.trees = { value: 'No', source: 'visit test', date: '2026-01-01', until: '2026-11-14' };  // until passed
    s.properties[HOUSE].facts.mortgage = { value: 'Test Lender', source: 'statement test', date: '2026-01-01' };  // 365: live
    s.properties[HOUSE].facts['boiler-age'] = { label: 'Boiler age', value: '5 years', source: 'engineer test', date: '2025-10-01' }; // not in schema: 365
    const r = ff.linesFor(s, { properties: [HOUSE], today: TODAY });
    expect(r.lines).toContain('Mortgage company or lender: Test Lender');
    expect(r.lines.join('\n')).not.toMatch(/Tenanted|Trees|Boiler/);
    expect(r.expired.map(e => e.key).sort()).toEqual(['boiler-age', 'occupancy', 'trees']);
    expect(r.expired.find(e => e.key === 'occupancy')).toMatchObject({ scope: 'property', ref: HOUSE, label: 'Occupancy (tenanted or unoccupied)', date: '2026-09-01' });
    const miss = r.missing.filter(m => m.ref === HOUSE).map(m => m.key);
    expect(miss).toContain('occupancy');
    expect(miss).toContain('bedrooms');
    expect(miss).not.toContain('storeys');
    // No owner named: the house's own owner is read, and its blank keys listed.
    expect(r.lines).toContain('First name: Testa');
    expect(r.missing.some(m => m.scope === 'owner' && m.key === 'date-of-birth')).toBe(true);
    // A goodForDays of null never runs out.
    expect(ff.linesFor(s, { properties: [HOUSE], today: '2040-01-01' }).lines).toContain('Number of storeys: 2');
  });
});

describe('setFact', () => {
  it('refuses a missing source, a missing date, and every declaration topic', () => {
    const f = fileOf();
    const base = { scope: 'property', ref: HOUSE, key: 'bedrooms', value: '3', source: 'test', date: TODAY };
    expect(() => ff.setFact({ ...base, source: '' }, f)).toThrow(/needs its source/);
    expect(() => ff.setFact({ ...base, date: undefined }, f)).toThrow(/needs its date/);
    expect(() => ff.setFact({ ...base, date: '15/11/2026' }, f)).toThrow(/not a date/);
    for (const label of ['Claims in the last 5 years', 'Criminal convictions', 'Insurance refused or cancelled', 'I confirm the above']) {
      expect(() => ff.setFact({ ...base, key: 'history', label }, f), label).toThrow(/declarations are never facts/);
    }
    expect(() => ff.setFact({ ...base, key: 'claims-5y', label: 'Past events' }, f)).toThrow(/declarations are never facts/);
    expect(() => ff.setFact({ ...base, ref: 'recNotThereAa0001' }, f)).toThrow(/not in the facts file/);
    expect(JSON.parse(readFileSync(f, 'utf8')).properties[HOUSE].facts.bedrooms).toBeUndefined();
  });

  it('keeps the old value under "was", newest first, at most five, and writes the file 0600', () => {
    const f = fileOf();
    for (let i = 3; i <= 9; i++) ff.setFact({ scope: 'property', ref: '12 Test Lane', key: 'storeys', value: String(i), source: `test ${i}`, date: TODAY }, f);
    const fact = JSON.parse(readFileSync(f, 'utf8')).properties[HOUSE].facts.storeys;
    expect(fact.value).toBe('9');
    expect(fact.was.map(w => w.value)).toEqual(['8', '7', '6', '5', '4']);
    expect(fact.was[0]).toEqual({ value: '8', source: 'test 8', date: TODAY });
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('a write that fails midway leaves the old file whole, and no temp file behind', () => {
    const f = fileOf();
    const before = readFileSync(f, 'utf8');
    const spy = vi.spyOn(fsCjs, 'renameSync').mockImplementation(() => { throw new Error('disk gone (test)'); });
    try {
      expect(() => ff.setFact({ scope: 'property', ref: HOUSE, key: 'bedrooms', value: '4', source: 'test', date: TODAY }, f)).toThrow(/disk gone/);
    } finally { spy.mockRestore(); }
    expect(readFileSync(f, 'utf8')).toBe(before);
    expect(readdirSync(dirname(f))).toEqual(['form-facts.json']);
  });

  it('a new file is made in a folder that does not exist yet; adding a house again keeps its facts', () => {
    const f = join(tmp(), 'deep', 'er', 'form-facts.json');
    ff.addOwner({ key: 'test-owner', name: 'Testa Owner Ltd' }, f);
    ff.addProperty({ key: HOUSE, address: '12 Test Lane', town: 'Testtown', postcode: 'ZZ1 1ZZ', owner: 'test-owner' }, f);
    ff.setFact({ scope: 'property', ref: HOUSE, key: 'bedrooms', value: '3', source: 'test', date: TODAY }, f);
    ff.addProperty({ key: HOUSE, address: '12 Test Lane', town: 'New Testtown', postcode: 'ZZ1 1ZZ' }, f);
    const s = ff.loadStore(f);
    expect(s.properties[HOUSE]).toMatchObject({ town: 'New Testtown', owner: 'test-owner', facts: { bedrooms: { value: '3' } } });
  });
});

describe('loadStore never reads a broken file as empty', () => {
  it('a missing file is an empty store; a corrupt file, or a fact with no source, throws naming the file', () => {
    expect(ff.loadStore(join(tmp(), 'none.json'))).toMatchObject({ owners: {}, properties: {} });
    const bad = join(tmp(), 'form-facts.json');
    writeFileSync(bad, '{ "version": 1, ');
    expect(() => ff.loadStore(bad)).toThrow(new RegExp(`${bad.replace(/[.]/g, '\\.')} is not valid JSON`));
    const s = storeOf();
    delete s.properties[HOUSE].facts.storeys.source;
    expect(() => ff.loadStore(fileOf(s))).toThrow(/storeys: no source/);
    const s2 = storeOf();
    s2.properties[HOUSE].owner = 'ghost-owner';
    expect(() => ff.loadStore(fileOf(s2))).toThrow(/owner "ghost-owner" is not in owners/);
  });

  it('no schema label is a declaration topic', () => {
    const { DECLARATION_TOPIC_RE } = require_(join(ROOT, 'scripts', 'declaration-words.js'));
    for (const scope of ['property', 'owner']) for (const [k, v] of Object.entries(ff.SCHEMA[scope])) expect(DECLARATION_TOPIC_RE.test(v.label), k).toBe(false);
  });
});

describe('the command line', () => {
  const cli = (file, ...args) => spawnSync(process.execPath, [FF_CLI, ...args], { env: { ...process.env, AGENT_FORM_FACTS: file }, encoding: 'utf8' });

  it('import writes nothing when one item is refused, and everything in one write when all pass', () => {
    const f = fileOf();
    const before = readFileSync(f, 'utf8');
    const spec = join(tmp(), 'import.json');
    const good = { scope: 'property', ref: HOUSE, key: 'bedrooms', value: '3', source: 'test import', date: TODAY };
    writeFileSync(spec, JSON.stringify({ owners: [{ key: 'second-owner', name: 'Second Test Owner' }],
      facts: [good, { scope: 'property', ref: HOUSE, key: 'history', label: 'Criminal convictions', value: 'No', source: 'x', date: TODAY }] }));
    const r = cli(f, 'import', '--file', spec);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).refused[0]).toMatch(/declarations are never facts/);
    expect(readFileSync(f, 'utf8')).toBe(before);
    writeFileSync(spec, JSON.stringify({ owners: [{ key: 'second-owner', name: 'Second Test Owner' }], facts: [good] }));
    const ok = cli(f, 'import', '--file', spec);
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ written: true, owners: 1, facts: 1 });
    expect(ff.loadStore(f).properties[HOUSE].facts.bedrooms.value).toBe('3');
  });

  it('set refuses with a plain message and exit 1; lines --with-source shows where each came from; check counts', () => {
    const f = fileOf();
    const r = cli(f, 'set', '--scope', 'property', '--ref', HOUSE, '--key', 'bedrooms', '--value', '3');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/needs its source/);
    const l = cli(f, 'lines', '--owner', 'test-owner', '--property', HOUSE, '--with-source');
    expect(l.status, l.stderr).toBe(0);
    expect(JSON.parse(l.stdout).lines).toContain('Number of storeys: 2   [survey test, 2026-02-01]');
    const c = JSON.parse(cli(f, 'check').stdout);
    expect(c).toMatchObject({ owners: 1, properties: 2, facts: 5, withoutSource: 0, problems: [] });
  });
});

describe('conflicts', () => {
  it('conflicts: the same label with a different value, normalised as lineKey is', () => {
    expect(ff.conflicts(['Number of storeys: 3', 'Year built: 1930.', 'Postcode: ZZ1 1ZZ'], ['number of  storeys: 2', 'Year built: 1930']))
      .toEqual([{ label: 'Number of storeys', plan: 'Number of storeys: 3', stored: 'number of  storeys: 2' }]);
    expect(ff.conflicts(['No colon here'], ['No colon here: x'])).toEqual([]);
  });
});

describe('agent-browser reads the stored facts first', () => {
  const ab = require_(join(SCRIPTS, 'agent-browser.js'));
  it('factsOf: plan lines, then stored, then standing, a repeated whole line dropped', () => {
    expect(ab.factsOf({ carryOn: { facts: ['Year built: 1930'] } }, ['Contact: email only'], ['year built: 1930.', 'Number of storeys: 2']))
      .toEqual(['Year built: 1930', 'Number of storeys: 2', 'Contact: email only']);
    expect(ab.factsOf({ carryOn: { facts: ['a: b'] } }, ['c: d'])).toEqual(['a: b', 'c: d']);
  });
  it('assertHandoverPlan checks only the shape of factsFor; with it, carryOn may carry no facts', () => {
    const p = extra => ({ why: 'buy if you want it', steps: [{ do: 'goto', url: 'https://x.example' }], ...extra });
    expect(() => ab.assertHandoverPlan(p({ carryOn: {}, factsFor: { owner: 'Anyone at all' } }))).not.toThrow();
    expect(() => ab.assertHandoverPlan(p({ carryOn: {} }))).toThrow(/needs "facts"/);
    for (const bad of [{}, { owner: '' }, { properties: 'x' }, { properties: [''] }, []]) {
      expect(() => ab.assertHandoverPlan(p({ factsFor: bad })), JSON.stringify(bad)).toThrow(/"factsFor" must be/);
    }
  });
  it('storedFactsFor: a live run never throws on a clash or a missing house; its plan line wins', () => {
    const f = fileOf();
    const plan = { carryOn: { facts: ['Number of storeys: 4'] }, factsFor: { owner: 'test-owner', properties: [HOUSE, '99 Missing Street'] } };
    expect(() => ab.storedFactsFor(plan, { dryRun: true, file: f, today: TODAY })).toThrow(/99 Missing Street is not in the facts file/);
    const live = ab.storedFactsFor(plan, { dryRun: false, file: f, today: TODAY });
    // Two houses named, one found: the found house's lines keep their tag (second review).
    expect(live.lines).not.toContain('Number of storeys [12 Test Lane]: 2');
    expect(live.lines).toContain('Year built [12 Test Lane]: 1930');
    expect(live.conflicts).toEqual([{ label: 'Number of storeys', plan: 'Number of storeys: 4', stored: 'Number of storeys [12 Test Lane]: 2' }]);
    expect(live.problems).toEqual([{ scope: 'property', ref: '99 Missing Street' }]);
    expect(ab.storedFactsFor({ carryOn: { facts: ['a: b'] } })).toMatchObject({ lines: [], conflicts: [] });
  });
});

// ── The real handover command against a practice page ─────────────────────────────────────────────
const PAGES = {
  '/f1': `<!doctype html><html><body><h1>About the property</h1><form action="/f2" method="get">
    <div class="q"><label for="storeys">Number of storeys</label><input id="storeys" name="storeys"></div>
    <div class="q"><label for="built">Year built</label><input id="built" name="built"></div>
    <button id="next1" type="submit">Next</button></form></body></html>`,
  '/f2': `<!doctype html><html><body><h1>Your quote</h1><p id="price">£31.50 a month</p>
    <button id="buy">Buy now</button></body></html>`,
};
let server, base;
const hits = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url);
    const page = PAGES[req.url.split('?')[0]];
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
    res.end(page || 'not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server && server.close());

// The planner, stood in: a box is answered only from a fact line naming it, citing that line.
const PLANNER = `
const fs = require('fs');
module.exports = async (input) => {
  const p = input.page;
  if (process.env.PLANNER_LOG) fs.appendFileSync(process.env.PLANNER_LOG, JSON.stringify({ facts: input.facts }) + '\\n');
  if (p.prices.length) return { steps: [], next: null, unknown: [], done: 'price' };
  const steps = [], unknown = [];
  for (const it of p.items) {
    if (it.value) continue;
    const line = input.facts.find(f => f.split(':')[0].trim().toLowerCase().endsWith(it.question.toLowerCase()));
    if (line) steps.push({ do: 'fill', target: it.target, value: line.split(': ').slice(1).join(': '), question: it.question, source: line });
    else unknown.push(it.question);
  }
  const next = p.buttons.find(x => /^Next$/.test(x.text));
  return { steps, next: unknown.length || !next ? null : next.target, unknown, done: 'no' };
};
`;
function home(outcome, store) {
  const h = tmp('od-ff-home-');
  const root = join(h, '.config', 'od', 'agent-browser');
  mkdirSync(join(root, 'default'), { recursive: true });
  const sites = join(root, 'sites.json');
  writeFileSync(sites, JSON.stringify({ '127.0.0.1': { label: 'Practice insurer', login: false } }));
  const plans = join(h, 'handover');
  mkdirSync(plans, { recursive: true });
  const outcomeScript = join(h, 'outcome.py');
  writeFileSync(outcomeScript, `import json\nprint(json.dumps({"outcome": ${JSON.stringify(outcome)}}))\n`);
  writeFileSync(join(h, 'planner.js'), PLANNER);
  const facts = join(h, 'form-facts.json');
  if (store) writeFileSync(facts, JSON.stringify(store));
  writeFileSync(join(h, 'standing.json'), JSON.stringify({ facts: [] }));
  // HOME is the throwaway folder, so the ledger (~/knowledge-os/logs/agent-browser/runs.jsonl) lands in it too.
  return { h, plans, facts, env: { HOME: h, AGENT_BROWSER_SITES_FILE: sites, AGENT_HANDOVER_DIR: plans, AGENT_OUTCOME_SCRIPT: outcomeScript,
    AGENT_HANDOVER_HEADLESS: '1', AGENT_HANDOVER_WAIT_MS: '1500', AGENT_HANDOVER_PAUSE_MS: '100', AGENT_BROWSER_PROFILE_ROOT: root,
    AGENT_HANDOVER_PLANNER: join(h, 'planner.js'), AGENT_STANDING_ANSWERS: join(h, 'standing.json'), AGENT_FORM_FACTS: facts, PLANNER_LOG: join(h, 'planner.log') } };
}
function run(env, args, ms = 120000) {
  return new Promise(res => {
    const c = spawn(process.execPath, [AB, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), ms);
    c.on('exit', code => { clearTimeout(t); res({ code, out, err }); });
  });
}
const PLAN = extra => ({ why: 'read the price and buy only if you want it', site: 'practice', label: 'Practice quote',
  steps: [{ do: 'goto', url: `${base}/f1` }], ...extra });
const lastJson = r => JSON.parse(r.out.trim().split('\n').pop());
const ledgerOf = x => readFileSync(join(x.h, 'knowledge-os', 'logs', 'agent-browser', 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const FOR = { factsFor: { owner: 'test-owner', properties: ['12 Test Lane'] } };
const TASK1 = 'recFormFactsTest1', TASK2 = 'recFormFactsTest2';
async function dry(x, task, plan) {
  writeFileSync(join(x.plans, task + '.json'), JSON.stringify(plan));
  return run(x.env, ['handover', '--task', task, '--dry-run', '--shot', join(x.h, `${task}.png`)]);
}

describe('the handover dry run reads the stored facts first', () => {
  it('a plan with factsFor and no house facts of its own is answered from the store and moves on to the price', async () => {
    const x = home('Changes requested', storeOf());
    hits.length = 0;
    const r = await dry(x, TASK1, PLAN({ carryOn: {}, ...FOR }));
    expect(r.code, r.err + r.out).toBe(0);
    const last = lastJson(r);
    expect(last).toMatchObject({ mode: 'handover-dry-run', stuck: null, end: 'price' });
    expect(last.facts.stored).toBe(4);
    expect(last.facts.missing).toContain('Number of bedrooms');
    expect(hits.some(u => u.startsWith('/f2?storeys=2&built=1930'))).toBe(true);
    expect(last).not.toHaveProperty('factsHelp');      // it reached the price: nothing to put on a card
    const typed = ledgerOf(x).find(l => l.cmd === 'handover-dry-run');
    expect(typed.facts).toEqual(last.facts);
    expect(typed.steps.filter(s => s.do === 'fill').map(s => s.selector)).toEqual(['#storeys', '#built']);
  }, 120000);

  it('with the fact gone from the store it stops on that question, and the dry run writes nothing (no asked log)', async () => {
    const s = storeOf();
    delete s.properties[HOUSE].facts.storeys;
    const x = home('Changes requested', s);
    const before = readFileSync(x.facts, 'utf8');
    const r = await dry(x, TASK1, PLAN({ carryOn: {}, ...FOR }));
    expect(r.code).toBe(3);
    const first = lastJson(r);
    expect(first.stuck.unknown).toEqual(['Number of storeys']);
    // The labels it read, never their values; and the reminder to check them before a question reaches his card.
    expect(first.facts.held).toEqual(['Contact', 'First name', 'Year built']);
    expect(JSON.stringify(first.facts.held)).not.toMatch(/Testa|1930|email only/);
    expect(first.factsHelp).toMatch(/^Before any question in stuck\.unknown goes on a card, check facts\.held/);
    for (const k of ['askedBefore', 'askedBeforeHelp', 'askedLogError']) expect(first).not.toHaveProperty(k);
    expect(readFileSync(x.facts, 'utf8')).toBe(before);
    const again = lastJson(await dry(x, TASK2, PLAN({ carryOn: {}, ...FOR })));
    expect(again).not.toHaveProperty('askedBefore');
    expect(readFileSync(x.facts, 'utf8')).toBe(before);
  }, 120000);

  it('a plan that carries on without saying whose form it is, is refused', async () => {
    const x = home('Changes requested', storeOf());
    const r = await dry(x, TASK1, PLAN({ carryOn: { facts: ['Number of storeys: 2', 'Year built: 1930'] } }));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/this plan carries on but does not say whose form it is/);
    expect(r.err).toMatch(/node scripts\/form-facts\.js lines --owner/);
  }, 60000);

  it('a plan line that contradicts a stored fact is refused, naming both and where the stored one came from', async () => {
    const x = home('Changes requested', storeOf());
    const r = await dry(x, TASK1, PLAN({ carryOn: { facts: ['Number of storeys: 3'] }, ...FOR }));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/the plan says 'Number of storeys: 3' but the facts file holds 'Number of storeys: 2' \(survey test, 2026-02-01\)/);
  }, 60000);

  it('a house the facts file does not hold is refused, with the command that adds it', async () => {
    const x = home('Changes requested', storeOf());
    const r = await dry(x, TASK1, PLAN({ carryOn: {}, factsFor: { properties: ['99 Missing Street'] } }));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/99 Missing Street is not in the facts file: add it with `node scripts\/form-facts\.js add-property/);
  }, 60000);
});

describe("Kevin's window opens on what he approved", () => {
  it('a carry-on plan without factsFor is not refused live; it runs on its own facts to the price', async () => {
    const x = home('Approved as-is', null);
    writeFileSync(join(x.plans, TASK1 + '.json'), JSON.stringify(PLAN({ carryOn: { facts: ['Number of storeys: 2', 'Year built: 1930'] } })));
    const r = await run(x.env, ['handover', '--task', TASK1]);
    expect(r.code, r.err + r.out).toBe(0);
    expect(lastJson(r)).toMatchObject({ mode: 'handover', handedOver: true, stuck: null, end: 'price' });
    expect(existsSync(x.facts)).toBe(false);
  }, 120000);

  it('live, a clash never stops the window: the plan line wins and the clash is on the ledger line', async () => {
    const x = home('Approved as-is', storeOf());
    hits.length = 0;
    writeFileSync(join(x.plans, TASK1 + '.json'), JSON.stringify(PLAN({ carryOn: { facts: ['Number of storeys: 3'] }, ...FOR })));
    const r = await run(x.env, ['handover', '--task', TASK1]);
    expect(r.code, r.err + r.out).toBe(0);
    expect(hits.some(u => u.startsWith('/f2?storeys=3&built=1930'))).toBe(true);
    const line = ledgerOf(x).find(l => l.cmd === 'handover');
    expect(line.factConflicts).toEqual([{ label: 'Number of storeys', plan: 'Number of storeys: 3', stored: 'Number of storeys: 2' }]);
  }, 120000);
});

// ── Review fixes (15 Nov 2026) ─────────────────────────────────────────────────────────────────────
describe('A1: a fact line backs only what its value says', () => {
  const ab = require_(join(SCRIPTS, 'agent-browser.js'));
  it('valueInLine: a number in the label or a [house] tag never backs a typed value; the value side still does', () => {
    expect(ab.valueInLine('20', 'Trees over 20 ft within 30 ft of the property: No')).toBe(false);
    expect(ab.valueInLine('30', 'Trees over 20 ft within 30 ft of the property: No')).toBe(false);
    expect(ab.valueInLine('10', 'Flooded in the last 10 years or ever: No')).toBe(false);
    expect(ab.valueInLine('12', 'Number of storeys [12 Test Lane]: 2')).toBe(false);
    expect(ab.valueInLine('2', 'Number of storeys [12 Test Lane]: 2')).toBe(true);
    expect(ab.valueInLine('12', 'Property: 12 Test Lane, Testtown, ZZ1 1ZZ')).toBe(true);
    expect(ab.valueInLine('12 Test Lane', 'Property: 12 Test Lane, Testtown, ZZ1 1ZZ')).toBe(true);
    expect(ab.valueInLine('1930', 'Year built: 1930')).toBe(true);
    expect(ab.valueInLine('Year built', 'Year built: 1930')).toBe(false);
  });
  it('pickInLine: a label word never picks an option, and a tag word never counts as the subject of a Yes or No', () => {
    expect(ab.pickInLine('HMO', 'House in multiple occupation (HMO): No')).toBe(false);
    expect(ab.pickInLine('House in multiple occupation', 'House in multiple occupation (HMO): No')).toBe(false);
    expect(ab.pickInLine('Email', 'Contact: email only; never phone')).toBe(true);
    expect(ab.pickInLine('Phone', 'Contact: email only; never phone')).toBe(false);
    expect(ab.pickInLine('No', 'Listed building [12 Garden Cottage]: No', 'Does the property have a garden?')).toBe(false);
    expect(ab.pickInLine('No', 'Listed building [12 Garden Cottage]: No', 'Is the property a listed building?')).toBe(true);
  });
});

describe('A4: clashes across houses', () => {
  const ab = require_(join(SCRIPTS, 'agent-browser.js'));
  it('two tagged lines clash only for the same house; an untagged plan line clashes with each house', () => {
    const stored = ['Number of storeys [12 Test Lane]: 2', 'Number of storeys [7 Sample Road]: 3'];
    expect(ff.conflicts(['Number of storeys [7 sample road]: 4'], stored)).toEqual([{ label: 'Number of storeys [7 sample road]', plan: 'Number of storeys [7 sample road]: 4', stored: 'Number of storeys [7 Sample Road]: 3' }]);
    expect(ff.conflicts(['Number of storeys [7 Sample Road]: 3'], stored)).toEqual([]);
    expect(ff.conflicts(['Number of storeys: 5'], stored).map(c => c.stored)).toEqual(stored);
  });
  it('storedFactsFor finds a two-house clash, and a plan\'s own address line is never a clash', () => {
    const f = fileOf();
    const two = { owner: 'test-owner', properties: [HOUSE, HOUSE2] };
    expect(() => ab.storedFactsFor({ carryOn: { facts: ['Number of storeys [12 Test Lane]: 9'] }, factsFor: two }, { dryRun: true, file: f, today: TODAY }))
      .toThrow(/the plan says 'Number of storeys \[12 Test Lane\]: 9' but the facts file holds 'Number of storeys \[12 Test Lane\]: 2'/);
    const one = ab.storedFactsFor({ carryOn: { facts: ['Property: 12 Test Lane, Testtown'] }, factsFor: { properties: [HOUSE] } }, { dryRun: true, file: f, today: TODAY });
    expect(one.conflicts).toEqual([]);
    expect(one.lines).toContain('Property: 12 Test Lane, Testtown, ZZ1 1ZZ');
  });
});

describe('B: the asked log is gone', () => {
  it('a store that still carries an "asked" key loads without complaint; nothing exports logAsked; check has no asked count', () => {
    const f = fileOf(storeOf({ asked: 'left over from an old version' }));
    const s = ff.loadStore(f);
    expect(s.properties[HOUSE].facts.storeys.value).toBe('2');
    expect(s).not.toHaveProperty('asked');
    expect(ff.logAsked).toBeUndefined();
    const c = spawnSync(process.execPath, [FF_CLI, 'check'], { env: { ...process.env, AGENT_FORM_FACTS: f }, encoding: 'utf8' });
    expect(c.status, c.stderr).toBe(0);
    expect(JSON.parse(c.stdout)).not.toHaveProperty('asked');
    expect(spawnSync(process.execPath, [FF_CLI, 'asked'], { env: { ...process.env, AGENT_FORM_FACTS: f }, encoding: 'utf8' }).status).toBe(2);
  });
});

describe('C: declarations are screened in the value too', () => {
  it('refuses a declaration answer in the value and an "I/We confirm" label; stores the occupation Administrator', () => {
    const f = fileOf();
    const base = { scope: 'property', ref: HOUSE, key: 'notes', label: 'Notes', value: 'x', source: 'test', date: TODAY };
    expect(() => ff.setFact({ ...base, value: 'No claims, no CCJs' }, f)).toThrow(/declarations are never facts/);
    expect(() => ff.setFact({ ...base, label: 'I/We confirm the above is true' }, f)).toThrow(/declarations are never facts/);
    expect(() => ff.setFact({ ...base, label: 'We declare the house sound' }, f)).toThrow(/declarations are never facts/);
    const occ = { scope: 'owner', ref: 'test-owner', key: 'occupation', source: 'test', date: TODAY };
    expect(ff.setFact({ ...occ, value: 'Administrator' }, f).value).toBe('Administrator');
    expect(() => ff.setFact({ ...occ, value: 'Company in administration; no CCJs' }, f)).toThrow(/declarations are never facts/);
    expect(() => ff.setFact({ ...base, label: 'Administration history', value: 'none' }, f)).toThrow(/declarations are never facts/);
    expect(ff.loadStore(f).owners['test-owner'].facts.occupation.value).toBe('Administrator');
    expect(ff.loadStore(f).properties[HOUSE].facts.notes).toBeUndefined();
    // A file that holds one is refused on load.
    const s = storeOf();
    s.properties[HOUSE].facts.notes = { label: 'Notes', value: 'No claims, no CCJs', source: 'test', date: TODAY };
    expect(() => ff.loadStore(fileOf(s))).toThrow(/declaration topic/);
  });
});

describe('D: findProperty never guesses from a prefix', () => {
  it('matches the key or one of four exact address forms, nothing else', () => {
    const s = storeOf();
    for (const ref of ['12 Test Lane', '12 test lane, Testtown', '12 Test Lane ZZ1 1ZZ', '12 Test Lane, Testtown, ZZ1 1ZZ', HOUSE]) {
      expect(ff.findProperty(s, ref), ref).toMatchObject({ key: HOUSE });
    }
    for (const ref of ['12 Test Lane, Wrongtown', '12 Test Lane, Testtown, ZZ9 9ZZ', '12 Test Lane Flat 2', '12 Test']) {
      expect(ff.findProperty(s, ref), ref).toBeNull();
    }
  });
});

describe('E: a house owned by someone other than the form\'s owner is reported, never refused', () => {
  const ab = require_(join(SCRIPTS, 'agent-browser.js'));
  it('linesFor and storedFactsFor list ownerDiffers; the lines still come', () => {
    const s = storeOf();
    s.owners['other-owner'] = { name: 'Other Test Owner', facts: {} };
    s.properties[HOUSE2].owner = 'other-owner';
    const r = ff.linesFor(s, { owner: 'test-owner', properties: [HOUSE, HOUSE2], today: TODAY });
    expect(r.problems).toEqual([]);
    expect(r.ownerDiffers).toEqual([{ ref: HOUSE2, address: '7 Sample Road', owner: 'other-owner' }]);
    expect(r.lines).toContain('Number of storeys [7 Sample Road]: 3');
    const st = ab.storedFactsFor({ carryOn: {}, factsFor: { owner: 'test-owner', properties: [HOUSE, HOUSE2] } }, { dryRun: true, file: fileOf(s), today: TODAY });
    expect(st.ownerDiffers).toEqual(r.ownerDiffers);
    expect(ff.linesFor(storeOf(), { owner: 'test-owner', properties: [HOUSE], today: TODAY }).ownerDiffers).toEqual([]);
  });
  it('the dry run JSON says which house, and still reaches the price', async () => {
    const s = storeOf();
    s.owners['other-owner'] = { name: 'Other Test Owner', facts: {} };
    s.properties[HOUSE].owner = 'other-owner';
    const x = home('Changes requested', s);
    const r = await dry(x, TASK1, PLAN({ carryOn: {}, ...FOR }));
    expect(r.code, r.err + r.out).toBe(0);
    expect(lastJson(r)).toMatchObject({ end: 'price', facts: { ownerDiffers: ['12 Test Lane'] } });
  }, 120000);
});

describe('F: own keys only', () => {
  it('a caller-supplied name never reaches a prototype', () => {
    const s = storeOf({ general: { facts: {} } });
    const r = ff.linesFor(s, { properties: ['constructor'], owner: 'toString', today: TODAY });
    expect(r.problems).toEqual([{ scope: 'property', ref: 'constructor' }, { scope: 'owner', ref: 'toString' }]);
    expect(r.lines).toEqual([]);
    expect(ff.findOwner(s, 'hasOwnProperty')).toBeNull();
    const f = fileOf();
    const base = { scope: 'property', ref: HOUSE, key: 'bedrooms', value: '3', source: 'test', date: TODAY };
    for (const bad of [{ ref: 'constructor' }, { ref: '__proto__' }, { key: 'constructor' }, { key: 'prototype' }, { scope: 'owner', ref: 'constructor' }]) {
      expect(() => ff.setFact({ ...base, ...bad }, f), JSON.stringify(bad)).toThrow();
    }
    expect(Object.prototype.hasOwnProperty.call(Object, 'facts')).toBe(false);
    expect(({}).facts).toBeUndefined();
    expect(() => ff.addOwner({ key: 'constructor', name: 'x' }, f)).toThrow(/reserved/);
    expect(() => ff.addProperty({ key: 'constructor', address: '1 X' }, f)).toThrow(/reserved/);
    expect(() => ff.addProperty({ key: 'recTestHouseCc003', address: '1 X', owner: 'toString' }, f)).toThrow(/not in the facts file/);
    const s2 = storeOf();
    s2.properties[HOUSE].owner = 'toString';
    expect(ff.validateStore(s2).join('\n')).toMatch(/owner "toString" is not in owners/);
  });
});

describe('G: a facts file that cannot be read never blocks the live window', () => {
  const ab = require_(join(SCRIPTS, 'agent-browser.js'));
  it('storedFactsFor: the dry run refuses, live returns a file problem', () => {
    const broken = join(tmp(), 'form-facts.json');
    writeFileSync(broken, 'not json');
    const plan = { carryOn: {}, factsFor: { owner: 'test-owner' } };
    expect(() => ab.storedFactsFor(plan, { dryRun: true, file: broken })).toThrow(/the facts file cannot be read/);
    const live = ab.storedFactsFor(plan, { file: broken });
    expect(live.lines).toEqual([]);
    expect(live.problems).toHaveLength(1);
    expect(live.problems[0].scope).toBe('file');
    expect(live.problems[0].ref).toMatch(/not valid JSON/);
    expect(live.problems[0].ref.length).toBeLessThanOrEqual(300);
  });
  it('live, the window runs on the plan\'s own facts and the ledger line carries factProblems', async () => {
    const x = home('Approved as-is', null);
    writeFileSync(x.facts, 'not json');
    writeFileSync(join(x.plans, TASK1 + '.json'), JSON.stringify(PLAN({ carryOn: { facts: ['Number of storeys: 2', 'Year built: 1930'] }, ...FOR })));
    const r = await run(x.env, ['handover', '--task', TASK1]);
    expect(r.code, r.err + r.out).toBe(0);
    expect(lastJson(r)).toMatchObject({ mode: 'handover', handedOver: true, end: 'price' });
    const line = ledgerOf(x).find(l => l.cmd === 'handover');
    expect(line.factProblems).toHaveLength(1);
    expect(line.factProblems[0]).toMatchObject({ scope: 'file', ref: expect.stringMatching(/not valid JSON/) });
  }, 120000);
});

describe('H: a fact dated in the future is refused', () => {
  it('setFact refuses it and a file holding one fails its checks', () => {
    const f = fileOf();
    expect(() => ff.setFact({ scope: 'property', ref: HOUSE, key: 'bedrooms', value: '3', source: 'test', date: '2099-01-01' }, f)).toThrow(/in the future/);
    expect(ff.loadStore(f).properties[HOUSE].facts.bedrooms).toBeUndefined();
    const s = storeOf();
    s.properties[HOUSE].facts.storeys.date = '2099-01-01';
    expect(ff.validateStore(s).join('\n')).toMatch(/storeys: dated 2099-01-01, which is in the future/);
  });
});

describe('I: two writers never lose each other\'s write', () => {
  it('4 processes each running the CLI set 10 times against one store keep all 40 facts', async () => {
    const f = fileOf();
    const worker = (n) => `
      const { spawnSync } = require('child_process');
      for (let i = 0; i < 10; i++) {
        const r = spawnSync(process.execPath, [${JSON.stringify(FF_CLI)}, 'set', '--scope', 'general', '--key', 'w${n}-k' + i,
          '--label', 'Test ${n} ' + i, '--value', 'v' + i, '--source', 'race test', '--date', '${TODAY}'], { encoding: 'utf8' });
        if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
      }`;
    const codes = await Promise.all([0, 1, 2, 3].map(n => new Promise(res => {
      const c = spawn(process.execPath, ['-e', worker(n)], { env: { ...process.env, AGENT_FORM_FACTS: f }, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      c.stderr.on('data', d => { err += d; });
      c.on('exit', code => res({ code, err }));
    })));
    for (const c of codes) expect(c.code, c.err).toBe(0);
    const keys = Object.keys(ff.loadStore(f).general.facts).filter(k => /^w\d-k\d$/.test(k));
    expect(keys).toHaveLength(40);
    expect(existsSync(f + '.lock')).toBe(false);
  }, 120000);
  it('a stale lock is taken over; a live one times out with a refusal naming it', () => {
    const f = fileOf();
    mkdirSync(f + '.lock');
    const old = new Date(Date.now() - 120000);
    fsCjs.utimesSync(f + '.lock', old, old);
    ff.setFact({ scope: 'property', ref: HOUSE, key: 'bedrooms', value: '3', source: 'test', date: TODAY }, f);
    expect(ff.loadStore(f).properties[HOUSE].facts.bedrooms.value).toBe('3');
    expect(existsSync(f + '.lock')).toBe(false);
    mkdirSync(f + '.lock');
    const t0 = Date.now();
    expect(() => ff.setFact({ scope: 'property', ref: HOUSE, key: 'bathrooms', value: '1', source: 'test', date: TODAY }, f))
      .toThrow(new RegExp(`locked by another writer \\(${(f + '.lock').replace(/[.]/g, '\\.')}\\)`));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(9000);
    expect(ff.loadStore(f).properties[HOUSE].facts.bathrooms).toBeUndefined();
    rmSync(f + '.lock', { recursive: true });
  }, 30000);
});

// Second review (15 Nov 2026): the value-side rule and the house tag must only ever ADD a check.
describe('review 2: the tighter checks open nothing', () => {
  const ab = require_(AB);
  it('a "never" in the label still blocks the pick, and a "No" or a word inside an address answers nothing', () => {
    expect(ab.pickInLine('Phone', 'Never contact by: phone, SMS or post', 'How should we contact you?')).toBe(false);
    expect(ab.pickInLine('SMS', 'Do not contact by: phone, SMS', '')).toBe(false);
    expect(ab.pickInLine('No', 'Year built [Flat No 3 Mill Lane]: 1930', 'Was the property built before 1900?')).toBe(false);
    expect(ab.pickInLine('No', 'Property: No 3 Mill Lane, Testtown, ZZ1 1ZZ', 'Is the property in Testtown?')).toBe(false);
    expect(ab.pickInLine('No', 'Listed building [12 Garden Cottage]: No', 'Does the property have a garden?')).toBe(false);
    // What worked before still works.
    expect(ab.pickInLine('No', 'Listed building [12 Garden Cottage]: No', 'Is the property a listed building?')).toBe(true);
    expect(ab.pickInLine('Email', 'Contact and marketing preferences: email only; never phone', '')).toBe(true);
    expect(ab.pickInLine('Phone', 'Contact and marketing preferences: email only; never phone', '')).toBe(false);
    expect(ab.pickInLine('Yes', 'Is the property listed? Yes', 'Is the property listed?')).toBe(true);   // no colon: as it always was
  });
  it('a form that names two houses tags its lines even when one house is not on file', () => {
    const r = ff.linesFor(storeOf(), { owner: 'test-owner', properties: [HOUSE, 'recNotOnFile0001'], today: TODAY });
    expect(r.problems).toEqual([{ scope: 'property', ref: 'recNotOnFile0001' }]);
    expect(r.lines).toContain('Year built [12 Test Lane]: 1930');
    expect(r.lines.some(l => /^Year built: /.test(l))).toBe(false);
  });
  it('two houses with the same first line are told apart by postcode', () => {
    const s = storeOf();
    s.properties[HOUSE2].address = '12 Test Lane';
    const r = ff.linesFor(s, { owner: 'test-owner', properties: [HOUSE, HOUSE2], today: TODAY });
    expect(r.lines).toContain('Number of storeys [12 Test Lane, ZZ1 1ZZ]: 2');
    expect(r.lines).toContain('Number of storeys [12 Test Lane, ZZ2 2ZZ]: 3');
  });
  it('an address with a colon or a square bracket is refused, on add and on load', () => {
    const f = fileOf();
    expect(() => ff.addProperty({ key: 'recTestHouseCc003', address: 'Unit 2: Mill House', town: 'Testtown', postcode: 'ZZ3 3ZZ' }, f)).toThrow(/colon or a square bracket/);
    expect(() => ff.addProperty({ key: 'recTestHouseCc003', address: 'Flat [B] Mill House', town: 'Testtown', postcode: 'ZZ3 3ZZ' }, f)).toThrow(/colon or a square bracket/);
    const s = storeOf();
    s.properties[HOUSE].address = 'Unit 2: Mill House';
    expect(ff.validateStore(s).join(' ')).toMatch(/colon or a square bracket/);
  });
  it('a dead writer\'s old lock is taken over once, and the write lands', () => {
    const f = fileOf();
    mkdirSync(f + '.lock');
    const old = new Date(Date.now() - 5 * 60 * 1000);
    fsCjs.utimesSync(f + '.lock', old, old);
    ff.setFact({ scope: 'property', ref: HOUSE, key: 'bathrooms', value: '1', source: 'test card', date: '2026-11-01' }, f);
    expect(ff.loadStore(f).properties[HOUSE].facts.bathrooms.value).toBe('1');
    expect(readdirSync(dirname(f)).filter(n => /\.lock/.test(n))).toEqual([]);
  });
});
