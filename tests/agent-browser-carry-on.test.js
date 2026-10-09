// THE ROBOT CARRIES ON (Kevin, 9 Oct 2026): "It signs in, starts doing stuff, but then it gets stuck.
// It asks me to do one thing and then doesn't carry on again." Every insurance plan stopped at page 1:
// a plan is written before it runs, so it covered only pages an agent had seen, and the declaration
// questions were his. Now a plan with "carryOn" goes on page by page from where its steps end, a
// planner maps each question to the plan's facts, and his standing answers (his own 8 Oct words, in a
// private file) answer the declaration questions they cover. These drive the real functions and the
// real `handover` command against a three-page practice form, with the planner stood in. All names,
// addresses and answers are invented (this repo is public).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';

const require_ = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'agent-browser.js');
const b = require_(SCRIPT);

const TASK = 'recCarryOnTestAaa';
const made = [];

// His standing answers, invented for the test, in the private file's shape.
const STANDING = {
  ruling: 'Test ruling',
  answers: [
    { key: 'claims-5y', asks: String.raw`(?:last|past|previous)\s+(?:[1-5]|one|two|three|four|five)\s+years?`, covers: 'claims?', pick: 'No', said: 'No claims in the last 5 years (test)' },
    { key: 'convictions', asks: '.', covers: String.raw`convict\w*|criminal|offences?`, pick: 'No', said: 'No criminal convictions (test)' },
    { key: 'ccj', asks: '.', covers: String.raw`ccjs?|county court|judge?ments?`, pick: 'No', said: 'No CCJs (test)' },
    { key: 'bankrupt', asks: '.', covers: String.raw`bankrupt\w*`, pick: 'No', said: 'Never bankrupt (test)' },
    { key: 'refused', asks: '.', covers: 'refused|cancell?ed|voided|declined', pick: 'No', said: 'Never refused, cancelled or voided (test)' },
  ],
  facts: ['Contact: email only (test)'],
};
function standingFrom(obj) {
  const d = mkdtempSync(join(tmpdir(), 'od-standing-'));
  made.push(d);
  const f = join(d, 'standing-answers.json');
  writeFileSync(f, JSON.stringify(obj));
  return b.loadStanding(f);
}

describe('his standing answers: the code decides, never the planner', () => {
  let st;
  beforeAll(() => { st = standingFrom(STANDING); });
  const ok = (q, pick = 'No') => b.standingAnswerFor(q, pick, st);

  it('answers a question his answers cover, with his pick only', () => {
    expect(ok('Have you had any claims in the last 5 years?')).toMatchObject({ topic: true, ok: true, keys: ['claims-5y'] });
    expect(ok('In the past three years, have you made any claims?')).toMatchObject({ ok: true });
    expect(ok('Have you had any claims in the last 5 years?', 'Yes')).toMatchObject({ ok: false, why: expect.stringMatching(/standing answer is "No"/) });
    expect(ok('Have you ever been declared bankrupt or had a CCJ?')).toMatchObject({ ok: true, keys: ['ccj', 'bankrupt'] });
    expect(ok('Has any insurer ever refused or cancelled your insurance?')).toMatchObject({ ok: true });
    // "Other than motoring offences" narrows the question; it does not ask about motoring.
    expect(ok('Have you been convicted of any criminal offence, other than motoring offences?')).toMatchObject({ ok: true });
  });

  it('a question his answers do not cover exactly is his', () => {
    // His claims answer covers five years, not "ever".
    expect(ok('Have you ever made an insurance claim?')).toMatchObject({ ok: false, why: expect.stringMatching(/no standing answer covers "claim"/) });
    expect(ok('Have you had any claims in the last 10 years?')).toMatchObject({ ok: false });
  });

  it('charges, prosecutions, insolvency, special terms, motoring and "anything else" are never the robot\'s', () => {
    for (const q of [
      'Have you been convicted of, or charged with, any criminal offence?',
      'Do you have any pending prosecutions?',
      'Are you under police investigation?',
      'Have you ever been bankrupt or entered an IVA?',
      'Has the company been in liquidation or administration orders?',
      'Do you have any motoring convictions?',
      'Is there anything else you need to tell us?',
      'Are there any other material facts?',
      'Has the company ever been struck off?',
    ]) expect(ok(q), q).toMatchObject({ topic: true, ok: false });
  });

  it('a declaration about other people (tenants, a co-director) is his unless his answer says it covers them', () => {
    expect(ok('Have you or anyone living at the property been convicted of a criminal offence?')).toMatchObject({ ok: false, why: expect.stringMatching(/"anyone"/) });
    expect(ok('Have you or any director had a CCJ?')).toMatchObject({ ok: false, why: expect.stringMatching(/"director"/) });
    expect(ok('Have any of your tenants been declared bankrupt?')).toMatchObject({ ok: false });
    expect(ok('Has anyone with an interest in the property been declared bankrupt?')).toMatchObject({ ok: false, why: expect.stringMatching(/"anyone"/) });
    const wider = standingFrom({ answers: [Object.assign({}, STANDING.answers[2], { others: 'directors?' })] });
    expect(b.standingAnswerFor('Have you or any director had a CCJ?', 'No', wider)).toMatchObject({ ok: true });
    expect(b.standingAnswerFor('Have you or any tenant had a CCJ?', 'No', wider)).toMatchObject({ ok: false });
  });

  it('special terms stop for him until a standing answer of his covers them (Rightsure, 9 Oct 2026)', () => {
    const q = 'Have you ever had any insurance refused or any renewal declined or any special terms imposed?';
    expect(ok(q)).toMatchObject({ ok: false, why: expect.stringMatching(/no standing answer covers "special terms", "imposed"/) });
    const wider = standingFrom({ answers: [Object.assign({}, STANDING.answers[4], { covers: 'refused|cancell?ed|voided|declined|special terms|terms imposed|imposed' })] });
    expect(b.standingAnswerFor(q, 'No', wider)).toMatchObject({ ok: true });
  });

  it('a first-person declaration is his, even on a covered topic', () => {
    expect(ok('I declare that I have had no claims in the last 5 years')).toMatchObject({ ok: false, why: expect.stringMatching(/first person/) });
  });

  it('a question on none of the topics is not this check\'s', () => {
    expect(ok('Do you want loss of rent cover?', 'Yes')).toEqual({ topic: false });
    expect(ok('How many bedrooms does the property have?', '4')).toEqual({ topic: false });
  });

  it('with no file, or one bad entry, nothing is answered for him', () => {
    expect(b.standingAnswerFor('Have you had any claims in the last 5 years?', 'No', null)).toMatchObject({ ok: false });
    expect(b.loadStanding(join(tmpdir(), 'od-no-such-standing.json'))).toBeNull();
    const bad = standingFrom({ answers: [STANDING.answers[0], { key: 'broken', covers: '(', pick: 'No' }] });
    expect(bad.answers).toEqual([]);
    expect(bad.error).toMatch(/standing answer "broken" is unusable/);
    expect(b.standingAnswerFor('Have you had any claims in the last 5 years?', 'No', bad)).toMatchObject({ ok: false, why: expect.stringMatching(/unusable/) });
  });
});

describe("the planner's steps are checked against the facts", () => {
  const snap = { items: [
    { kind: 'text', question: 'First name', target: '#first', value: '' },
    { kind: 'radio', question: 'Any claims in the last 5 years?', options: [{ label: 'Yes', target: 'label[for="cy"]' }, { label: 'No', target: 'label[for="cn"]' }] },
  ], buttons: [{ kind: 'button', text: 'Next', target: '#next' }] };
  const facts = ['First name: Testa', 'Rebuild value: £235,000'];

  it('keeps a step on a known target that cites a real fact and types its own words', () => {
    const r = b.checkPlannerSteps({ steps: [{ do: 'fill', target: '#first', value: 'Testa', question: 'First name', source: 'First name: Testa' }],
      next: '#next', unknown: [], done: 'no' }, snap, facts);
    expect(r.steps).toEqual([{ do: 'fill', selector: '#first', value: 'Testa', question: 'First name' }]);
    expect(r.next).toBe('#next');
  });

  it('a typed value the facts do not hold, a made-up source or target, and an unknown Next all become his', () => {
    const r = b.checkPlannerSteps({ steps: [
      { do: 'fill', target: '#first', value: 'Testo', question: 'First name', source: 'First name: Testa' },
      { do: 'click', target: 'label[for="cn"]', question: 'Any claims', source: 'Kevin said no claims' },
      { do: 'click', target: '#made-up', question: 'Made up', source: 'First name: Testa' },
    ], next: '#elsewhere', unknown: ['Number of storeys'], done: 'no' }, snap, facts);
    expect(r.steps).toEqual([]);
    expect(r.unknown).toEqual(['Number of storeys', 'First name', 'Any claims', 'Made up']);
    expect(r.next).toBeNull();
  });

  it('a standing answer may be cited for a click, and figures match whatever their commas and pound signs', () => {
    expect(b.valueInFacts('235000', facts.join('\n'))).toBe(true);
    expect(b.valueInFacts('236000', facts.join('\n'))).toBe(false);
    const r = b.checkPlannerSteps({ steps: [{ do: 'click', target: 'label[for="cn"]', question: 'Any claims', source: 'No claims in the last 5 years (test)' }],
      next: null, unknown: [], done: 'no' }, snap, facts, facts.concat(['No claims in the last 5 years (test)']));
    expect(r.steps).toEqual([{ do: 'click', selector: 'label[for="cn"]', question: 'Any claims' }]);
  });
});

// ── The practice form: three pages, the radios hidden behind their labels as Acturis styles them ──
const PAGES = {
  '/p1': `<!doctype html><html><body><h1>Your details</h1>
    <form action="/p2" method="get">
      <div class="q"><label for="first">First name</label><input id="first" name="first"></div>
      <div class="q"><label for="pc">Postcode</label><input id="pc" name="pc"></div>
      <button id="next1" type="submit">Next</button>
    </form><div id="out"></div></body></html>`,
  '/p2': `<!doctype html><html><head><style>.rb{position:absolute;opacity:0;width:1px;height:1px}</style></head><body><h1>About the property</h1>
    <form action="/p3" method="get">
      <div class="q"><p>Have you had any claims in the last 5 years?</p>
        <input class="rb" type="radio" name="claims" id="cy" value="y"><label for="cy">Yes</label>
        <input class="rb" type="radio" name="claims" id="cn" value="n"><label for="cn">No</label></div>
      <div class="q"><p>Have you or any director been convicted of, or charged with, any criminal offence?</p>
        <input class="rb" type="radio" name="conv" id="vy" value="y"><label for="vy">Yes</label>
        <input class="rb" type="radio" name="conv" id="vn" value="n"><label for="vn">No</label></div>
      <div class="q"><label for="built">When was it built?</label><select id="built" name="built"><option value="">Select</option><option>1850 to 1919</option><option>1920 to 1945</option></select></div>
      <div class="q"><label for="storeys">Number of storeys</label><input id="storeys" name="storeys"></div>
      <button id="next2" type="submit">Next</button>
    </form>
    <script>
      // Kevin, stood in: when the robot hands him a question, he answers it and presses Next.
      setInterval(() => {
        const t = document.getElementById('od-your-turn');
        if (t && /^Your turn/.test(t.textContent) && !window.__answered) {
          window.__answered = 1;
          setTimeout(() => { document.getElementById('vn').checked = true; document.getElementById('storeys').value = '2'; document.getElementById('next2').click(); }, 300);
        }
      }, 200);
    </script></body></html>`,
  '/p3': `<!doctype html><html><body><h1>Your quote</h1><p id="price">£41.20 a month</p>
    <input type="checkbox" id="decl"><label for="decl">I declare the information I have given is true</label>
    <button id="buy" onclick="document.getElementById('out').textContent='BOUGHT'">Buy now</button><div id="out"></div></body></html>`,
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
afterAll(() => { server.close(); for (const d of made) rmSync(d, { recursive: true, force: true }); });

// The planner, stood in: answers from the facts by the question's words, as the real one is told to.
const PLANNER = `
const fs = require('fs');
module.exports = async (input) => {
  if (process.env.PLANNER_LOG) fs.appendFileSync(process.env.PLANNER_LOG, JSON.stringify({ url: input.page.url, unknownFacts: input.facts.length, standing: input.standing.length }) + '\\n');
  const p = input.page;
  const fact = re => input.facts.find(f => re.test(f)) || '';
  const val = f => f.split(': ').slice(1).join(': ');
  if (p.prices.length) {
    if (process.env.PLANNER_BUY) return { steps: [{ do: 'click', target: p.buttons.find(x => /Buy/.test(x.text)).target, question: 'Buy', source: input.facts[0] }], next: null, unknown: [], done: 'no' };
    return { steps: [], next: null, unknown: [], done: 'price' };
  }
  const steps = [], unknown = [];
  for (const it of p.items) {
    const q = it.question;
    if (/First name/.test(q) && !it.value) { const f = fact(/^First name/); steps.push({ do: 'fill', target: it.target, value: process.env.PLANNER_INVENT ? 'Invented' : val(f), question: q, source: f }); }
    else if (/Postcode/.test(q) && !it.value) { const f = fact(/^Postcode/); steps.push({ do: 'fill', target: it.target, value: val(f), question: q, source: f }); }
    else if (/claims/.test(q) && it.kind === 'radio' && !it.options.some(o => o.checked)) {
      const want = process.env.PLANNER_CLAIMS || 'No';
      steps.push({ do: 'click', target: it.options.find(o => o.label === want).target, question: q, source: input.standing.find(s => s.topic === 'claims-5y').said });
    }
    else if (/convicted/.test(q) && it.kind === 'radio' && !it.options.some(o => o.checked)) {
      // The planner tries; the code must refuse ("charged" is never the robot's) and make it his.
      steps.push({ do: 'click', target: it.options.find(o => o.label === 'No').target, question: q, source: input.standing.find(s => s.topic === 'convictions').said });
    }
    else if (/built/.test(q) && !it.value.match(/\\d/)) { const f = fact(/^Built/); steps.push({ do: 'select', target: it.target, value: val(f), question: q, source: f }); }
    else if (/storeys/.test(q) && !it.value) unknown.push(q);
  }
  const next = p.buttons.find(x => /^Next$/.test(x.text));
  return { steps, next: unknown.length ? null : (next ? next.target : null), unknown, done: 'no' };
};
`;

function home(outcome = 'Approved as-is', env = {}) {
  const h = mkdtempSync(join(tmpdir(), 'od-carry-'));
  made.push(h);
  const root = join(h, '.config', 'od', 'agent-browser');
  mkdirSync(join(root, 'default'), { recursive: true });
  const sites = join(root, 'sites.json');
  writeFileSync(sites, JSON.stringify({ '127.0.0.1': { label: 'Practice insurer', login: false } }));
  const plans = join(h, 'handover');
  mkdirSync(plans, { recursive: true });
  const outcomeScript = join(h, 'outcome.py');
  writeFileSync(outcomeScript, `import json\nprint(json.dumps({"outcome": ${JSON.stringify(outcome)}}))\n`);
  const planner = join(h, 'planner.js');
  writeFileSync(planner, PLANNER);
  const standing = join(h, 'standing-answers.json');
  writeFileSync(standing, JSON.stringify(STANDING));
  return { h, plans, env: { HOME: h, AGENT_BROWSER_SITES_FILE: sites, AGENT_HANDOVER_DIR: plans, AGENT_OUTCOME_SCRIPT: outcomeScript,
    AGENT_HANDOVER_HEADLESS: '1', AGENT_HANDOVER_WAIT_MS: '1500', AGENT_HANDOVER_PAUSE_MS: '100',
    AGENT_HANDOVER_PLANNER: planner, AGENT_STANDING_ANSWERS: standing, PLANNER_LOG: join(h, 'planner.log'), ...env } };
}
function run(env, args, ms = 120000) {
  return new Promise(res => {
    const c = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), ms);
    c.on('exit', code => { clearTimeout(t); res({ code, out, err }); });
  });
}
const PLAN = (extra = {}) => ({ why: 'read the price and buy on monthly instalments only if you want it', site: 'practice', label: 'Practice quote',
  steps: [{ do: 'goto', url: `${base}/p1` }],
  carryOn: { facts: ['First name: Testa', 'Postcode: ZZ99 9ZZ', 'Built: 1850 to 1919'] }, ...extra });
const ledgerOf = x => readFileSync(join(x.h, 'knowledge-os', 'logs', 'agent-browser', 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

describe('the Your turn window carries on, page by page, to the price', () => {
  it('fills every page from the facts, answers the claims question from his standing answer, asks him only what it cannot answer, and stops at Buy', async () => {
    const x = home();
    writeFileSync(join(x.plans, TASK + '.json'), JSON.stringify(PLAN()));
    hits.length = 0;
    const r = await run(x.env, ['handover', '--task', TASK]);
    expect(r.code, r.err + r.out).toBe(0);
    const last = JSON.parse(r.out.trim().split('\n').pop());
    expect(last).toMatchObject({ mode: 'handover', handedOver: true, stuck: null, end: 'price' });
    // Page 1 filled from the facts, page 2's claims answered No, the build year picked, and Kevin asked for
    // the two questions it may not answer (the conviction question also says "charged"; the storeys are on
    // no fact), then on to the price.
    expect(hits.some(u => u.startsWith('/p2?first=Testa&pc=ZZ99+9ZZ'))).toBe(true);
    const p3 = hits.find(u => u.startsWith('/p3?'));
    expect(p3).toMatch(/claims=n/);
    expect(p3).toMatch(/conv=n/);          // his own answer, given in the window
    expect(p3).toMatch(/built=1850\+to\+1919/);
    expect(p3).toMatch(/storeys=2/);
    const handover = ledgerOf(x).find(l => l.cmd === 'handover');
    const kevin = handover.steps.filter(s => s.do === 'kevin');
    expect(kevin).toHaveLength(1);
    expect(kevin[0].say).toMatch(/convicted of, or charged with/);
    expect(kevin[0].say).toMatch(/Number of storeys/);
    expect(handover.steps.filter(s => s.next).length).toBe(1);      // the robot pressed Next on page 1; he pressed it on page 2
    expect(handover.end).toBe('price');
  }, 120000);

  it('a dry run stops on the first question only he can answer and names it, so the agent puts it on his card', async () => {
    const x = home('Changes requested');
    writeFileSync(join(x.plans, TASK + '.json'), JSON.stringify(PLAN()));
    hits.length = 0;
    const shot = join(x.h, 'dry.png');
    const r = await run(x.env, ['handover', '--task', TASK, '--dry-run', '--shot', shot]);
    expect(r.code).toBe(3);
    const last = JSON.parse(r.out.trim().split('\n').pop());
    expect(last.stuck).toMatchObject({ do: 'carry-on' });
    expect(last.stuck.unknown.join(' | ')).toMatch(/charged with.*\| .*Number of storeys|Number of storeys.*charged with/);
    expect(existsSync(shot)).toBe(true);
    expect(hits.some(u => u.startsWith('/p3'))).toBe(false);
  }, 120000);

  it('the planner can never press Buy, and a value it made up is never typed', async () => {
    const x = home('Approved as-is', { PLANNER_INVENT: '1' });
    writeFileSync(join(x.plans, TASK + '.json'), JSON.stringify(PLAN()));
    const r = await run(x.env, ['handover', '--task', TASK, '--dry-run', '--shot', join(x.h, 'a.png')]);
    const last = JSON.parse(r.out.trim().split('\n').pop());
    expect(last.stuck.unknown).toEqual(['First name']);
    const y = home('Approved as-is', { PLANNER_BUY: '1' });
    // Straight to the price page: Buy is refused by the guard, and the page is his from there.
    writeFileSync(join(y.plans, TASK + '.json'), JSON.stringify(PLAN({ steps: [{ do: 'goto', url: `${base}/p3` }] })));
    const r2 = await run(y.env, ['handover', '--task', TASK]);
    const last2 = JSON.parse(r2.out.trim().split('\n').pop());
    // Buy is refused, and that is where the robot's part ends: his turn, with nothing pressed.
    expect(last2).toMatchObject({ stuck: null, end: 'final', handedOver: true });
    const steps = ledgerOf(y).find(l => l.cmd === 'handover').steps;
    expect(steps.some(st => st.selector === '#buy' && st.executed)).toBe(false);
  }, 120000);

  it('a claims answer other than his standing one is refused and becomes his question', async () => {
    const x = home('Approved as-is', { PLANNER_CLAIMS: 'Yes' });
    writeFileSync(join(x.plans, TASK + '.json'), JSON.stringify(PLAN()));
    const r = await run(x.env, ['handover', '--task', TASK, '--dry-run', '--shot', join(x.h, 'a.png')]);
    const last = JSON.parse(r.out.trim().split('\n').pop());
    expect(last.stuck.unknown.join(' | ')).toMatch(/is a declaration question: the standing answer is "No", not "Yes"/);
  }, 120000);

  it('a scripted step that fails for any reason but the guard is carried past (the Swinton email box, 9 Oct 2026)', async () => {
    const x = home();
    writeFileSync(join(x.plans, TASK + '.json'), JSON.stringify(PLAN({ steps: [
      { do: 'goto', url: `${base}/p1` }, { do: 'wait', for: '#email-not-there', ms: 1000 } ] })));
    hits.length = 0;
    const r = await run(x.env, ['handover', '--task', TASK]);
    const last = JSON.parse(r.out.trim().split('\n').pop());
    expect(last).toMatchObject({ stuck: null, end: 'price' });
    const steps = ledgerOf(x).find(l => l.cmd === 'handover').steps;
    expect(steps[1]).toMatchObject({ do: 'wait', executed: false, carriedOnPast: true });
  }, 120000);

  it('a plan that carries on must say its facts', () => {
    expect(() => b.assertHandoverPlan({ why: 'buy if you want it', steps: [{ do: 'goto', url: 'https://x.example' }], carryOn: {} })).toThrow(/needs "facts"/);
    expect(() => b.assertHandoverPlan({ why: 'buy if you want it', steps: [{ do: 'goto', url: 'https://x.example' }], carryOn: { facts: ['a: b'], maxPages: 99 } })).toThrow(/maxPages/);
    expect(() => b.assertHandoverPlan({ why: 'buy if you want it', steps: [{ do: 'goto', url: 'https://x.example' }], carryOn: { facts: 'a: b' } })).not.toThrow();
  });
});
