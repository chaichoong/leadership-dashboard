// THE ROBOT CARRIES ON (Kevin, 9 Oct 2026): "It signs in, starts doing stuff, but then it gets stuck.
// It asks me to do one thing and then doesn't carry on again." Every insurance plan stopped at page 1:
// a plan is written before it runs, so it covered only pages an agent had seen, and the declaration
// questions were his. Now a plan with "carryOn" goes on page by page from where its steps end, a
// planner maps each question to the plan's facts, and his standing answers (his own 8 Oct words, in a
// private file) answer the declaration questions they cover. A wrong declaration can void a policy,
// so every check here fails CLOSED; the review of 9 Oct found nine ways the first build did not, and
// each is a test below (the "review" cases). These drive the real functions and the real `handover`
// command against practice pages, with the planner stood in. All names, addresses and answers are
// invented (this repo is public).
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
    { key: 'convictions', asks: String.raw`\bconvict`, covers: String.raw`convict\w*|criminal|offences?`, pick: 'No', said: 'No criminal convictions (test)' },
    { key: 'ccj', asks: '.', covers: String.raw`ccjs?|county court|judge?ments?`, pick: 'No', said: 'No CCJs (test)' },
    { key: 'bankrupt', asks: '.', covers: String.raw`bankrupt\w*`, pick: 'No', said: 'Never bankrupt (test)' },
    { key: 'refused', asks: '.', covers: 'refused|cancell?ed|voided|declined', pick: 'No', said: 'Never refused, cancelled or voided (test)' },
  ],
  facts: ['Contact: email only; never phone, SMS or post (test)'],
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
  const ok = (q, pick = 'No', s = st) => b.standingAnswerFor(q, pick, s);

  it('answers a question his answers cover, with his pick only', () => {
    expect(ok('Have you had any claims in the last 5 years?')).toMatchObject({ topic: true, ok: true, keys: ['claims-5y'] });
    expect(ok('In the past three years, have you made any claims?')).toMatchObject({ ok: true });
    expect(ok('Have you had any claims in the last 5 years?', 'Yes')).toMatchObject({ ok: false, why: expect.stringMatching(/standing answer is "No"/) });
    expect(ok('Have you ever been declared bankrupt or had a CCJ?')).toMatchObject({ ok: true });
    expect(ok('Has any insurer ever refused or cancelled your insurance?')).toMatchObject({ ok: true });
    // "Other than motoring offences" narrows the question; it does not ask about motoring.
    expect(ok('Have you been convicted of any criminal offence, other than motoring offences?')).toMatchObject({ ok: true });
  });

  it('a question his answers do not cover exactly is his', () => {
    // His claims answer covers five years, not "ever".
    expect(ok('Have you ever made an insurance claim?')).toMatchObject({ ok: false, why: expect.stringMatching(/no standing answer covers "claim"/) });
    expect(ok('Have you had any claims in the last 10 years?')).toMatchObject({ ok: false });
    expect(ok('Have you committed any criminal offences?')).toMatchObject({ ok: false });
  });

  it('review: a time span is read in the clause that holds the topic, never borrowed from the one beside it', () => {
    expect(ok('Have you had any claims in the last 5 years? Have you ever made a claim on another property?'))
      .toMatchObject({ ok: false, why: expect.stringMatching(/"claim" as asked here \("Have you ever made a claim on another property/) });
    const fiveYearRefused = standingFrom({ answers: [STANDING.answers[0],
      Object.assign({}, STANDING.answers[4], { asks: STANDING.answers[0].asks })] });
    expect(ok('Have you ever been refused insurance, or had any claims in the last 5 years?', 'No', fiveYearRefused))
      .toMatchObject({ ok: false, why: expect.stringMatching(/"refused"/) });
    expect(ok('Have you ever been refused insurance, or had any claims in the last 5 years?')).toMatchObject({ ok: true });
    // review round 2: one clause, two topics, a five-year answer among them: the span could be either's.
    expect(ok('Have you ever had insurance refused or any claims in the last 5 years?'))
      .toMatchObject({ ok: false, why: expect.stringMatching(/in one clause, and a time span there could belong to either/) });
  });

  it('review: wording that can turn a yes into a no is his', () => {
    for (const q of [
      'Have you been claims free for the last 5 years?',
      'Is it true that you have made no claims in the last 5 years?',
      'Have you made no claims in the last 5 years?',
      'Have you never been declared bankrupt?',
    ]) expect(ok(q), q).toMatchObject({ topic: true, ok: false, why: expect.stringMatching(/yes and no could be the wrong way round/) });
  });

  it('charges, prosecutions, insolvency, motoring and "anything else" are never the robot\'s', () => {
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

  it('a declaration about other people (tenants, a co-director, the company) is his unless his answer says it covers them', () => {
    expect(ok('Have you or anyone living at the property been convicted of a criminal offence?')).toMatchObject({ ok: false, why: expect.stringMatching(/"anyone"/) });
    expect(ok('Have you or any director had a CCJ?')).toMatchObject({ ok: false, why: expect.stringMatching(/"director"/) });
    expect(ok('Have any of your tenants been declared bankrupt?')).toMatchObject({ ok: false });
    expect(ok('Has anyone with an interest in the property been declared bankrupt?')).toMatchObject({ ok: false });
    // review: "persons", "insured person" and the company are other people too.
    expect(ok('Has any insured person been declared bankrupt?')).toMatchObject({ ok: false });
    expect(ok('Have you or any persons to be insured ever been bankrupt or had any CCJs?')).toMatchObject({ ok: false });
    expect(ok('Has the company had a CCJ?')).toMatchObject({ ok: false, why: expect.stringMatching(/"company"/) });
    const wider = standingFrom({ answers: [Object.assign({}, STANDING.answers[2], { others: 'directors?|company' })] });
    expect(b.standingAnswerFor('Have you or any director had a CCJ?', 'No', wider)).toMatchObject({ ok: true });
    expect(b.standingAnswerFor('Has the company had a CCJ?', 'No', wider)).toMatchObject({ ok: true });
    expect(b.standingAnswerFor('Have you or any tenant had a CCJ?', 'No', wider)).toMatchObject({ ok: false });
  });

  it('special terms stop for him until a standing answer of his covers them (Rightsure, 9 Oct 2026)', () => {
    const q = 'Have you ever had any insurance refused or any renewal declined or any special terms imposed?';
    expect(ok(q)).toMatchObject({ ok: false, why: expect.stringMatching(/no standing answer covers "special terms"/) });
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
    { kind: 'text', question: 'Year you bought it', target: '#yr', value: '' },
    { kind: 'radio', question: 'Any claims in the last 5 years?', options: [{ label: 'Yes', target: 'label[for="cy"]' }, { label: 'No', target: 'label[for="cn"]' }] },
    { kind: 'checkbox', question: 'Phone', option: 'Phone', target: '#ph' },
    { kind: 'checkbox', question: 'Email', option: 'Email', target: '#em' },
  ], buttons: [{ kind: 'button', text: 'Next', target: '#next' }, { kind: 'button', text: 'No', target: 'a.no' }], prices: [] };
  const facts = ['First name: Testa', 'Bought: 2009', 'Rebuild value: £235,000', 'Contact: email only; never phone, SMS or post (test)'];
  const run = (steps, extra = {}) => b.checkPlannerSteps(Object.assign({ steps, next: null, unknown: [], done: 'no' }, extra), snap, facts,
    facts.concat(['No claims in the last 5 years (test)']));

  it('keeps a step on an answer the robot read, citing one whole fact line, giving that line\'s words', () => {
    const r = run([{ do: 'fill', target: '#first', value: 'Testa', question: 'First name', source: 'First name: Testa' }], { next: '#next' });
    expect(r.steps).toMatchObject([{ do: 'fill', selector: '#first', value: 'Testa', question: 'First name' }]);
    expect(r.next).toMatchObject({ target: '#next', text: 'Next' });
    const c = run([{ do: 'click', target: 'label[for="cn"]', question: 'Any claims', source: 'No claims in the last 5 years (test)' }]);
    expect(c.steps).toMatchObject([{ do: 'click', selector: 'label[for="cn"]', pick: 'No' }]);
    expect(run([{ do: 'check', target: '#em', question: 'Email', source: 'Contact: email only; never phone, SMS or post (test)' }]).steps).toHaveLength(1);
  });

  it('a made-up value, source or target, and an unknown Next, all become his', () => {
    const r = run([
      { do: 'fill', target: '#first', value: 'Testo', question: 'First name', source: 'First name: Testa' },
      { do: 'click', target: 'label[for="cn"]', question: 'Any claims', source: 'Kevin said no claims' },
      { do: 'click', target: '#made-up', question: 'Made up', source: 'First name: Testa' },
    ], { next: '#elsewhere', unknown: ['Number of storeys'] });
    expect(r.steps).toEqual([]);
    expect(r.unknown).toEqual(['Number of storeys', 'First name', 'Any claims in the last 5 years?', 'Made up']);
    expect(r.next).toBeNull();
  });

  it('review: a button is never an answer, a citation is a whole line, and a short value is never a fragment', () => {
    const r = run([
      { do: 'click', target: 'a.no', question: 'Any claims ever?', source: 'No claims in the last 5 years (test)' },
      { do: 'fill', target: '#first', value: 'Testa', question: 'First name', source: 'a' },
      { do: 'fill', target: '#yr', value: '0', question: 'Year', source: 'Bought: 2009' },
      { do: 'check', target: '#ph', question: 'Phone', source: 'Contact: email only; never phone, SMS or post (test)' },
      { do: 'click', target: 'label[for="cy"]', question: 'Any claims', source: 'No claims in the last 5 years (test)' },
    ]);
    // "Yes" cited from a standing answer passes this check: the standing pick is judged by the live check.
    expect(r.steps).toMatchObject([{ selector: 'label[for="cy"]', pick: 'Yes' }]);
    expect(r.unknown).toEqual(['press "No"', 'First name', 'Year you bought it', 'Phone']);
  });

  it('a standing answer is cited for a declaration only, never for another question', () => {
    const listed = { items: [{ kind: 'radio', question: 'Is the property listed?', options: [{ label: 'No', target: '#ln' }] }], buttons: [], prices: [] };
    const r = b.checkPlannerSteps({ steps: [{ do: 'click', target: '#ln', question: 'Listed?', source: 'No claims in the last 5 years (test)' }],
      next: null, unknown: [], done: 'no' }, listed, facts, facts.concat(['No claims in the last 5 years (test)']));
    expect(r.steps).toEqual([]);
    expect(r.unknown).toEqual(['Is the property listed?']);
  });

  it('figures match whatever their commas and pound signs; a picked option must be what the line says it is', () => {
    expect(b.valueInLine('235000', 'Rebuild value: £235,000')).toBe(true);
    expect(b.valueInLine('236000', 'Rebuild value: £235,000')).toBe(false);
    expect(b.valueInLine('0', 'Bought: 2009')).toBe(false);
    const water = 'Is it within a quarter of a mile of water?';
    expect(b.pickInLine('Yes', 'Within a quarter of a mile of water: Yes', water)).toBe(true);
    expect(b.pickInLine('No', 'Within a quarter of a mile of water: Yes', water)).toBe(false);
    // review 2/4: a Yes or No must come from a line about the same thing, holding that one answer.
    const sub = 'Has the property ever suffered from subsidence or flooding?';
    expect(b.pickInLine('No', 'Contact: email only, no phone', sub)).toBe(false);
    expect(b.pickInLine('No', 'Subsidence: No', sub)).toBe(true);
    expect(b.pickInLine('No', 'Subsidence: No; flooded: Yes', sub)).toBe(false);
    // review 6: an option worded with a negation is never a word match.
    expect(b.pickInLine('I have had no claims in the last 5 years', 'I have had claims in the last 5 years (one, 2022)')).toBe(false);
    expect(b.pickInLine('Phone', 'Contact: email only; never phone, SMS or post')).toBe(false);
    expect(b.pickInLine('1850 to 1919', 'Built: 1850 to 1919')).toBe(true);
  });
});

describe('the second net: the live check on the page itself', () => {
  // A page stand-in: the words round the control, as the guard would read them.
  const pg = (local, wide = local) => ({ locator: () => ({ first: () => ({ evaluate: async () => ({ local, wide }) }) }) });
  let st;
  beforeAll(() => { st = standingFrom(STANDING); });
  const step = (question, extra = {}) => Object.assign({ do: 'click', selector: '#x', pick: 'No', item: { kind: 'radio', question } }, extra);

  it('review: a pick with no readable question, or a vague label beside a declaration, is his', async () => {
    expect(await b.liveAnswerProblem(pg('Have you ever made a claim? Yes No'), step(''), st)).toMatch(/its question could not be read/);
    expect(await b.liveAnswerProblem(pg('Have you made any claims ever? Answer Yes No'), step('Answer', { do: 'select', item: { kind: 'select', question: 'Answer' } }), st))
      .toMatch(/a declaration question is beside it and its own words \("Answer"\) do not name it/);
    // review round 2: beside a declaration, a question that does not name it is his, plain or not
    // (a legend over a list of claims, CCJs and convictions; a typed box labelled "Number").
    expect(await b.liveAnswerProblem(pg('Is the property listed? Yes No', 'Is the property listed? Have you ever made a claim?'), step('Is the property listed?'), st))
      .toMatch(/a declaration question is beside it/);
    expect(await b.liveAnswerProblem(pg('In the last 10 years, have you or anyone to be insured had any of the following? A claim, a CCJ, a conviction Yes No'),
      step('In the last 10 years, have you or anyone to be insured had any of the following?'), st)).toMatch(/a declaration question is beside it/);
    expect(await b.liveAnswerProblem(pg('How many insurance claims have you ever made? Number'), step('Number', { do: 'fill', item: { kind: 'number', question: 'Number' } }), st))
      .toMatch(/a declaration question is beside it/);
    expect(await b.liveAnswerProblem(pg('Is the property listed? Yes No'), step('Is the property listed?'), st)).toBe('');
  });

  it('a typed answer or a tick box on a declaration is his; a never-list word on the control is his; a covered one goes ahead', async () => {
    expect(await b.liveAnswerProblem(pg('How many claims in the last 5 years?'), step('How many claims in the last 5 years?', { do: 'fill' }), st)).toMatch(/typed answer/);
    expect(await b.liveAnswerProblem(pg('No claims in the last 5 years'), step('No claims in the last 5 years', { item: { kind: 'checkbox', question: 'Any claims in the last 5 years?' } }), st)).toMatch(/tick box/);
    expect(await b.liveAnswerProblem(pg('Have you been charged with an offence? Yes No'), step('Is the property listed?'), st)).toMatch(/"charged" is asked on it/);
    expect(await b.liveAnswerProblem(pg('Have you had any claims in the last 5 years? Yes No'), step('Have you had any claims in the last 5 years?'), st)).toBe('');
  });
});

describe('the robot has moved on only when the page has', () => {
  const page = (url, headings, qs) => ({ url, headings, items: qs.map(q => ({ question: q })) });
  it('review: a follow-up question appearing is not his Next; a new address, new headings or a new set of questions is', () => {
    const before = page('https://x.example/q', ['About you'], ['Any claims?']);
    expect(b.movedOn(before, page('https://x.example/q', ['About you'], ['Any claims?', 'Give details']))).toBe(false);
    expect(b.movedOn(before, page('https://x.example/q2', ['About you'], ['Any claims?']))).toBe(true);
    expect(b.movedOn(before, page('https://x.example/q', ['Your cover'], ['Any claims?']))).toBe(true);
    expect(b.movedOn(before, page('https://x.example/q', ['About you'], ['Cover start date']))).toBe(true);
  });

  it('review: a page that cannot be read ends the carry-on as stuck, never a throw that closes his window', async () => {
    const fake = { waitForLoadState: async () => {}, waitForTimeout: async () => {}, evaluate: async () => { throw new Error('Execution context was destroyed'); } };
    const r = await b.carryOn(fake, { carryOn: { facts: ['a: b'] } }, { standing: null, planner: async () => ({ steps: [], next: null, unknown: [], done: 'no' }) });
    expect(r.stuck.error).toMatch(/the robot stopped reading the page: Execution context was destroyed/);
  });
});

// ── Practice pages ──────────────────────────────────────────────────────────────────────────────
const hide = '<style>.rb{position:absolute;opacity:0;width:1px;height:1px}</style>';
const PAGES = {
  '/p1': `<!doctype html><html><body><h1>Your details</h1>
    <form action="/p2" method="get">
      <div class="q"><label for="first">First name</label><input id="first" name="first"></div>
      <div class="q"><label for="pc">Postcode</label><input id="pc" name="pc"></div>
      <div class="q"><label for="built">When was it built?</label><select id="built" name="built"><option value="">Select</option><option>1850 to 1919</option><option>1920 to 1945</option></select></div>
      <button id="next1" type="submit">Next</button>
    </form><div id="out"></div></body></html>`,
  '/p2': `<!doctype html><html><head>${hide}</head><body><h1>About the property</h1>
    <form action="/p3" method="get">
      <div class="q"><p>Have you had any claims in the last 5 years?</p>
        <input class="rb" type="radio" name="claims" id="cy" value="y"><label for="cy">Yes</label>
        <input class="rb" type="radio" name="claims" id="cn" value="n"><label for="cn">No</label></div>
      <div class="q"><p>Have you or any director been convicted of, or charged with, any criminal offence?</p>
        <input class="rb" type="radio" name="conv" id="vy" value="y"><label for="vy">Yes</label>
        <input class="rb" type="radio" name="conv" id="vn" value="n"><label for="vn">No</label></div>
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
  // review 1: answers as buttons and links are never the robot's.
  '/q-btn': `<!doctype html><html><body><h1>Claims</h1><div><p>Have you ever made an insurance claim?</p>
    <a class="btn" id="ab" href="#" onclick="document.getElementById('out').textContent='CLICKED';return false">No</a>
    <input type="button" id="ib" value="No" onclick="document.getElementById('out').textContent='CLICKED'"></div>
    <button id="nx">Next</button><div id="out"></div></body></html>`,
  // review 4: a dropdown labelled only "Answer" under a claims question; an unlabelled number box.
  '/q-select': `<!doctype html><html><body><h1>Claims</h1><div class="q"><p>Have you made any claims in the last 5 years?</p>
    <label for="ans">Answer</label><select id="ans"><option value="">Select</option><option>Yes</option><option>No</option></select></div>
    <div class="q"><p>How many insurance claims have you ever made?</p><input type="number" id="howmany"></div>
    <button id="nx">Next</button></body></html>`,
  // review 2: flat radios, one container, a five-year question beside an "ever" one.
  '/q-flat': `<!doctype html><html><body><h1>Claims</h1><div>
    <p>Have you had any claims in the last 5 years?</p><input type="radio" name="a" id="a1"><label for="a1">Yes</label><input type="radio" name="a" id="a2"><label for="a2">No</label>
    <p>Have you ever made a claim on another property?</p><input type="radio" name="c" id="c1"><label for="c1">Yes</label><input type="radio" name="c" id="c2"><label for="c2">No</label>
    </div><button id="nx">Next</button></body></html>`,
  // review 6 and 7: the way on is worded as an agreement, or a sign-in.
  '/q-statement': `<!doctype html><html><body><h1>Statement of fact</h1><div class="q"><label for="em">Email</label><input id="em"></div>
    <button id="ag">Agree and continue</button></body></html>`,
  '/q-account': `<!doctype html><html><body><h1>Your account</h1><div class="q"><label for="em">Email</label><input id="em"></div>
    <button id="si">Sign in</button></body></html>`,
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
// PLANNER_TRY makes it try one thing the code must refuse.
const PLANNER = `
const fs = require('fs');
module.exports = async (input) => {
  const p = input.page;
  if (process.env.PLANNER_LOG) fs.appendFileSync(process.env.PLANNER_LOG, JSON.stringify({ url: p.url, items: p.items.map(i => i.question) }) + '\\n');
  const fact = re => input.facts.find(f => re.test(f)) || '';
  const val = f => f.split(': ').slice(1).join(': ');
  const said = k => (input.standing.find(s => s.topic === k) || {}).said || '';
  const btn = re => p.buttons.find(x => re.test(x.text));
  const tryIt = process.env.PLANNER_TRY || '';
  if (p.prices.length) {
    if (tryIt === 'buy') return { steps: [], next: btn(/Buy/).target, unknown: [], done: 'no' };
    return { steps: [], next: null, unknown: [], done: 'price' };
  }
  const steps = [], unknown = [];
  for (const it of p.items) {
    const q = it.question;
    if (/First name/.test(q) && !it.value) { const f = fact(/^First name/); steps.push({ do: 'fill', target: it.target, value: tryIt === 'invent' ? 'Invented' : val(f), question: q, source: f }); }
    else if (/^Postcode/.test(q) && !it.value) { const f = fact(/^Postcode/); steps.push({ do: 'fill', target: it.target, value: val(f), question: q, source: f }); }
    else if (/^Email/.test(q) && !it.value) { const f = fact(/^Email/); steps.push({ do: 'fill', target: it.target, value: val(f), question: q, source: f }); }
    else if (it.kind === 'radio' && (/claim/.test(q) || !q) && !it.options.some(o => o.checked)) {
      const want = tryIt === 'yes' ? 'Yes' : 'No';
      steps.push({ do: 'click', target: it.options.find(o => o.label === want).target, question: q, source: said('claims-5y') });
    }
    else if (it.kind === 'radio' && /convicted/.test(q) && !it.options.some(o => o.checked)) {
      steps.push({ do: 'click', target: it.options.find(o => o.label === 'No').target, question: q, source: said('convictions') });
    }
    else if (it.kind === 'select' && /built/.test(q) && !/\\d/.test(it.value)) { const f = fact(/^Built/); steps.push({ do: 'select', target: it.target, value: val(f), question: q, source: f }); }
    else if (it.kind === 'select' && /^Answer/.test(q)) steps.push({ do: 'select', target: it.target, value: 'No', question: q, source: said('claims-5y') });
    else if (/claims have you ever/.test(q)) { const f = fact(/^Claims ever/); steps.push({ do: 'fill', target: it.target, value: '0', question: q, source: f }); }
    else if (/storeys/.test(q) && !it.value) unknown.push(q);
  }
  if (tryIt === 'button') { const nb = btn(/^No$/); if (nb) steps.push({ do: 'click', target: nb.target, question: 'Ever made a claim?', source: said('claims-5y') }); }
  const next = tryIt === 'next-no' ? btn(/^No$/) : btn(/^(Next|Agree and continue|Sign in)$/);
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
const FACTS = ['First name: Testa', 'Postcode: ZZ99 9ZZ', 'Built: 1850 to 1919', 'Email: testa@example.com', 'Claims ever made: 0'];
const PLAN = (steps, extra = {}) => ({ why: 'read the price and buy on monthly instalments only if you want it', site: 'practice', label: 'Practice quote',
  steps: steps || [{ do: 'goto', url: `${base}/p1` }], carryOn: { facts: FACTS }, ...extra });
const ledgerOf = x => readFileSync(join(x.h, 'knowledge-os', 'logs', 'agent-browser', 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
async function dryRun(path, env = {}) {
  const x = home('Changes requested', env);
  writeFileSync(join(x.plans, TASK + '.json'), JSON.stringify(PLAN([{ do: 'goto', url: `${base}${path}` }])));
  const r = await run(x.env, ['handover', '--task', TASK, '--dry-run', '--shot', join(x.h, 'dry.png')]);
  return { x, r, last: JSON.parse(r.out.trim().split('\n').pop()) };
}

describe('the Your turn window carries on, page by page, to the price', () => {
  it('fills every page from the facts, answers the claims question from his standing answer, asks him only what it cannot answer, and stops at the price', async () => {
    const x = home();
    writeFileSync(join(x.plans, TASK + '.json'), JSON.stringify(PLAN()));
    hits.length = 0;
    const r = await run(x.env, ['handover', '--task', TASK]);
    expect(r.code, r.err + r.out).toBe(0);
    const last = JSON.parse(r.out.trim().split('\n').pop());
    expect(last).toMatchObject({ mode: 'handover', handedOver: true, stuck: null, end: 'price' });
    expect(hits.some(u => u.startsWith('/p2?first=Testa&pc=ZZ99+9ZZ&built=1850+to+1919'))).toBe(true);
    const p3 = hits.find(u => u.startsWith('/p3?'));
    expect(p3).toMatch(/claims=n/);
    expect(p3).toMatch(/conv=n/);          // his own answer, given in the window
    expect(p3).toMatch(/storeys=2/);
    const handover = ledgerOf(x).find(l => l.cmd === 'handover');
    const kevin = handover.steps.filter(s => s.do === 'kevin');
    expect(kevin).toHaveLength(1);
    expect(kevin[0].say).toMatch(/convicted of, or charged with/);
    expect(kevin[0].say).toMatch(/Number of storeys/);
    expect(handover.steps.filter(s => s.next).length).toBe(1);      // the robot pressed Next on page 1; he pressed it on page 2
    expect(handover.end).toBe('price');
  }, 120000);

  it('a dry run stops on the questions only he can answer and names them, so the agent puts them on his card', async () => {
    hits.length = 0;
    const { r, last } = await dryRun('/p1');
    expect(r.code).toBe(3);
    expect(last.stuck).toMatchObject({ do: 'carry-on' });
    expect(last.stuck.unknown.join(' | ')).toMatch(/charged with/);
    expect(last.stuck.unknown.join(' | ')).toMatch(/Number of storeys/);
    expect(hits.some(u => u.startsWith('/p3'))).toBe(false);
  }, 120000);

  it('a value the planner made up is never typed, and a claims answer other than his standing one is his', async () => {
    expect((await dryRun('/p1', { PLANNER_TRY: 'invent' })).last.stuck.unknown).toEqual(['First name']);
    hits.length = 0;
    const yes = await dryRun('/p1', { PLANNER_TRY: 'yes' });
    expect(yes.last.stuck.unknown.join(' | ')).toMatch(/Have you had any claims in the last 5 years\? \(a declaration question: the standing answer is "No", not "Yes"\)/);
  }, 120000);

  it('review 1: an answer given as a link or a plain button is never pressed, as a step or as the way on', async () => {
    const { last, x } = await dryRun('/q-btn', { PLANNER_TRY: 'button' });
    expect(last.stuck.unknown).toContain('press "No"');
    expect(ledgerOf(x).find(l => l.cmd === 'handover-dry-run').steps.filter(s => s.carryOn)).toEqual([]);
    const asNext = await dryRun('/q-btn', { PLANNER_TRY: 'next-no' });
    expect(asNext.last.stuck.unknown).toEqual(['press "No"']);
    expect(ledgerOf(asNext.x).find(l => l.cmd === 'handover-dry-run').steps.filter(s => s.carryOn)).toEqual([]);
  }, 120000);

  it('review 4: a dropdown labelled "Answer" under a claims question, and a number box asking about claims, are his', async () => {
    const { last, x } = await dryRun('/q-select');
    const said = last.stuck.unknown.join(' | ');
    expect(said).toMatch(/Answer/);
    expect(said).toMatch(/How many insurance claims have you ever made\? \(a typed answer to a declaration question is his\)/);
    expect(ledgerOf(x).find(l => l.cmd === 'handover-dry-run').steps.filter(s => s.carryOn)).toEqual([]);
  }, 120000);

  it('review 2: a radio whose own question cannot be read (flat layout) is his, never answered from the question beside it', async () => {
    const { last, x } = await dryRun('/q-flat');
    expect(last.stuck.unknown.length).toBeGreaterThan(0);
    expect(ledgerOf(x).find(l => l.cmd === 'handover-dry-run').steps.filter(s => s.carryOn)).toEqual([]);
  }, 120000);

  it('review 6 and 7: a way on worded as an agreement or a sign-in is his, never "done"; Buy with a price shown is', async () => {
    const agree = await dryRun('/q-statement');
    expect(agree.last.end).toBeNull();
    expect(agree.last.stuck.unknown).toEqual(['press "Agree and continue"']);
    const signin = await dryRun('/q-account');
    expect(signin.last.stuck.unknown).toEqual(['press "Sign in"']);
    const x = home('Approved as-is', { PLANNER_TRY: 'buy' });
    writeFileSync(join(x.plans, TASK + '.json'), JSON.stringify(PLAN([{ do: 'goto', url: `${base}/p3` }])));
    const r = await run(x.env, ['handover', '--task', TASK]);
    const last = JSON.parse(r.out.trim().split('\n').pop());
    expect(last).toMatchObject({ stuck: null, end: 'final', handedOver: true });
    expect(ledgerOf(x).find(l => l.cmd === 'handover').steps.some(st => st.selector === '#buy' && st.executed)).toBe(false);
  }, 120000);

  it('review 8: a step whose box is missing is carried past (the Swinton email box); a refusal never is', async () => {
    const x = home();
    writeFileSync(join(x.plans, TASK + '.json'), JSON.stringify(PLAN([
      { do: 'goto', url: `${base}/p1` }, { do: 'fill', selector: '#email-not-there', value: 'x' } ])));
    hits.length = 0;
    const r = await run(x.env, ['handover', '--task', TASK]);
    const last = JSON.parse(r.out.trim().split('\n').pop());
    expect(last).toMatchObject({ stuck: null, end: 'price' });
    expect(ledgerOf(x).find(l => l.cmd === 'handover').steps[1]).toMatchObject({ do: 'fill', executed: false, carriedOnPast: true });
    expect(b.CARRY_PAST_RE.test('could not read what "#x" is, so it was not touched: locator.evaluate: Timeout 20000ms exceeded.')).toBe(true);
    for (const e of ['BROWSER REFUSED: https://evil.example/ is not on the allowlist', 'refused: "Buy now" looks like the final action, which is Kevin\'s',
      'refused: the field looks like a password']) {
      expect(b.CARRY_PAST_RE.test(e) && !b.NEVER_PAST_RE.test(e), e).toBe(false);
    }
  }, 120000);

  it('a plan that carries on must say its facts', () => {
    expect(() => b.assertHandoverPlan({ why: 'buy if you want it', steps: [{ do: 'goto', url: 'https://x.example' }], carryOn: {} })).toThrow(/needs "facts"/);
    expect(() => b.assertHandoverPlan({ why: 'buy if you want it', steps: [{ do: 'goto', url: 'https://x.example' }], carryOn: { facts: ['a: b'], maxPages: 99 } })).toThrow(/maxPages/);
    expect(() => b.assertHandoverPlan({ why: 'buy if you want it', steps: [{ do: 'goto', url: 'https://x.example' }], carryOn: { facts: 'a: b' } })).not.toThrow();
  });
});
