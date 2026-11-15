// MAPPED DECLARATIONS (estate fix 3, Nov 2026). RightSure's "Your details" page holds Kevin's name, date
// of birth, address, email and phone AND four declaration radios, so the old rule (a page that asks a
// declaration is his, whole) left him typing every box by hand on every quote. Now one exact per-site map
// (scripts/declaration-maps.json) lets the robot fill the other boxes and answer No to the declarations
// his standing answers cover word for word, for the owner the plan is for; the conviction question, and
// anything not exactly as mapped, stays his. A wrong declaration can void a policy, so every case here
// that is not exactly right must hand the page over whole with no box touched. These drive the real
// functions and the real `handover` command against a practice copy of the page on this machine, with
// the planner stood in. All names, addresses, dates and answers are invented (this repo is public).
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
const BUILT_IN = JSON.parse(readFileSync(join(ROOT, 'scripts', 'declaration-maps.json'), 'utf8'));
const RS = BUILT_IN.maps[0];
const [Q1, Q2, Q3, Q4] = RS.questions;

const TASK = 'recDeclMapTestAaa';
const made = [];
const tmp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };

// ── The page as the robot reads it (a snapshotForm result), for the pure checks ──────────────────────
const radio = (q, labels = ['Yes', 'No'], ids = [q.yes, q.no]) => ({ kind: 'radio', question: q.text,
  options: [{ label: labels[0], target: ids[0], checked: false }, { label: labels[1], target: ids[1], checked: false }] });
// Every item of the mapped page, in order, as the snapshot gives it.
const itemOf = ([kind, question], k) => {
  const mq = RS.questions.find(x => x.text === question);
  if (mq) return radio(mq);
  if (kind === 'radio') return { kind, question, options: [{ label: 'Yes', target: '#hasSecondOccupationyes' }, { label: 'No', target: '#hasSecondOccupationno' }] };
  return { kind, question, target: `#item${k}`, value: '', ...(kind === 'select' ? { options: ['A', 'B'] } : {}) };
};
const ITEMS = () => RS.items.map(itemOf);
function snapOf({ url = 'https://quote.rightsureforbusiness.co.uk/landlord/personal', text = RS.text, items } = {}) {
  return { url, formText: text, buttons: [], prices: [], items: items || ITEMS() };
}
const cover = (q, extra = {}) => ({ site: 'rightsure', question: q.text, pick: 'No', owners: ['test-owner-a'], said: `Test said no to "${q.id}" (test card)`, date: '2026-11-01', ...extra });
// Read when a test runs, not when the file loads.
let mapsRead;
const maps = () => (mapsRead = mapsRead || b.loadDeclarationMaps().maps);
const decide = (snap, covers, ownerKey = 'test-owner-a', url = snap.url, first = true) => b.mappedDeclarations(snap, url, { covers, ownerKey, maps: maps(), first });
const ix = text => ITEMS().findIndex(i => i.question === text);

describe('the map holds only when the page is exactly as mapped', () => {
  it('the built-in map loads whole, and its conviction question is marked his and on the never list', () => {
    expect(b.loadDeclarationMaps().problems).toEqual([]);
    expect(maps()).toHaveLength(1);
    expect(maps()[0].questions.find(q => q.id === 'bankruptOrCcj').his).not.toBe('');
    expect(b.NEVER_ROBOT_RE.test(Q2.text)).toBe(true);
    for (const q of [Q1, Q3, Q4]) expect(b.NEVER_ROBOT_RE.test(q.text), q.id).toBe(false);
  });

  it('covered questions are the robot\'s No; the conviction question is never, even with a cover for it', () => {
    const m = decide(snapOf(), [cover(Q1), cover(Q2), cover(Q3), cover(Q4)]);
    expect(m.map.site).toBe('rightsure');
    expect(m.questions.map(q => [q.id, q.decision.robot])).toEqual([['insuranceRefused', true], ['bankruptOrCcj', false], ['hasClaims', true], ['hasOtherPropertyClaims', true]]);
    expect(m.questions[0].decision).toMatchObject({ robot: true, pick: 'No', said: cover(Q1).said, date: '2026-11-01' });
    expect(m.questions[1].decision.why).toBe('always your own answer');
  });

  it('no cover, another owner, no owner, one word different, or the same words twice: never the robot\'s', () => {
    const whys = (covers, owner, extra = {}) => b.mappedDeclarations(snapOf(), snapOf().url, { covers, ownerKey: owner, maps: maps(), ...extra })
      .questions.map(q => q.decision.robot ? 'ROBOT' : q.decision.why);
    expect(whys([], 'test-owner-a')).toEqual(['your standing answers do not cover these exact words', 'always your own answer',
      'your standing answers do not cover these exact words', 'your standing answers do not cover these exact words']);
    expect(whys([cover(Q1, { owners: ['test-owner-b'] })], 'test-owner-a')[0]).toBe('not covered for test-owner-a');
    expect(whys([cover(Q1)], null)[0]).toBe('this plan does not say whose policy it is');
    expect(whys([cover(Q1)], '')[0]).toBe('this plan does not say whose policy it is');
    expect(whys([cover(Q1)], null, { ownerWhy: 'a house on this form is on file under another owner' })[0]).toBe('a house on this form is on file under another owner');
    expect(whys([cover(Q3, { question: Q3.text.replace('any claims', 'any claim') })], 'test-owner-a')[2]).toBe('your standing answers do not cover these exact words');
    expect(whys([cover(Q1), cover(Q1)], 'test-owner-a')[0]).toMatch(/more than once/);
    expect(whys([cover(Q1, { site: 'another-insurer' })], 'test-owner-a')[0]).toBe('your standing answers do not cover these exact words');
    // Spacing and case are not words.
    expect(whys([cover(Q1, { question: `  ${Q1.text.toUpperCase().replace(/ /g, '  ')} ` })], 'test-owner-a')[0]).toBe('ROBOT');
  });

  it('the address: exact host over https, exact path (one trailing slash allowed), any query', () => {
    const s = snapOf();
    expect(decide(s, [], 'x', 'https://quote.rightsureforbusiness.co.uk/landlord/personal/')).not.toBeNull();
    expect(decide(s, [], 'x', 'https://quote.rightsureforbusiness.co.uk/landlord/personal?ref=1')).not.toBeNull();
    for (const u of ['http://quote.rightsureforbusiness.co.uk/landlord/personal', 'https://quote.rightsureforbusiness.co.uk/landlord/personal//',
      'https://quote.rightsureforbusiness.co.uk/landlord/personal/more', 'https://quote.rightsureforbusiness.co.uk/landlord/Personal',
      'https://evil.quote.rightsureforbusiness.co.uk/landlord/personal', 'https://quote.rightsureforbusiness.co.uk.evil.example/landlord/personal',
      'not a url']) expect(decide(s, [], 'x', u), u).toBeNull();
  });

  it('any change in the questions, their answers, their ids or the words round the declarations: null, at first sight and on a re-check', () => {
    const swap = (k, it) => { const a = ITEMS(); a[k] = it; return a; };
    const cases = {
      extra: snapOf({ items: ITEMS().concat([{ kind: 'radio', question: 'Have you ever had a policy cancelled?', options: [{ label: 'Yes', target: '#cy' }, { label: 'No', target: '#cn' }] }]) }),
      missing: snapOf({ items: ITEMS().slice(0, -1) }),
      repeated: snapOf({ items: ITEMS().slice(0, -1).concat([radio(Q3)]) }),
      reworded: snapOf({ items: swap(ix(Q3.text), radio({ ...Q3, text: 'Have you made any claim at the property to be insured?' })) }),
      none: snapOf({ items: swap(ix(Q4.text), radio(Q4, ['Yes', 'None'])) }),
      otherId: snapOf({ items: swap(ix(Q1.text), radio(Q1, ['Yes', 'No'], [Q1.yes, '#insuranceRefusedNo2'])) }),
      threeOptions: snapOf({ items: swap(ix(Q4.text), { ...radio(Q4), options: radio(Q4).options.concat([{ label: 'No', target: '#x' }]) }) }),
      checkbox: snapOf({ items: swap(ix(Q4.text), { kind: 'checkbox', question: Q4.text, option: 'No', target: Q4.no }) }),
      extraQuestionAbove: snapOf({ items: ITEMS().slice(0, 14).concat([{ kind: 'radio', question: 'Is the property your main home?', options: [{ label: 'Yes', target: '#hy' }, { label: 'No', target: '#hn' }] }], ITEMS().slice(14)) }),
      prosecutions: snapOf({ text: RS.text.replace('Claims Have', 'We may pass details to prosecutions teams. Claims Have') }),
      wordBefore: snapOf({ text: RS.text.replace('Do you have a second', 'We never share your details with the police. Do you have a second') }),
      tailEnds: snapOf({ text: `${RS.text} Save` }),
      declarationOption: snapOf({ items: [{ kind: 'select', question: 'What is your occupation type?', target: '#o', options: ['Insolvency practitioner'] }].concat(ITEMS()) }),
    };
    for (const [name, s] of Object.entries(cases)) {
      expect(decide(s, [cover(Q1), cover(Q3), cover(Q4)]), name).toBeNull();
      expect(decide(s, [cover(Q1), cover(Q3), cover(Q4)], 'test-owner-a', s.url, false), `${name} (re-check)`).toBeNull();
    }
  });

  it('at first sight the whole text must be the map\'s: a sentence or heading with no trigger word is enough to stop it', () => {
    const you = snapOf({ text: RS.text.replace('Have you ever had any insurance', "In the questions below, 'you' means you and anyone living at the property. Have you ever had any insurance") });
    const heading = snapOf({ text: RS.text.replace('Your Details', 'About You') });
    for (const s of [you, heading]) expect(decide(s, [cover(Q1)])).toBeNull();
    // Later in the same visit, words a site adds above the declarations (a validation message) do not stop it; a new question would.
    expect(decide(snapOf({ text: RS.text.replace('Your Details', 'Your Details Please check the highlighted boxes') }), [cover(Q1)], 'test-owner-a', snapOf().url, false)).not.toBeNull();
    expect(decide(snapOf({ text: RS.text.replace('Your Details', 'Your Details Please check the highlighted boxes') }), [cover(Q1)])).toBeNull();
  });

  it('a radio hidden behind its label (its snapshot target is the label) maps too; any other label target does not', () => {
    const lab = qq => radio(qq, ['Yes', 'No'], [`label[for="${qq.yes.slice(1)}"] >> nth=0`, `label[for="${qq.no.slice(1)}"] >> nth=0`]);
    const labs = ITEMS().map(it => { const mq = RS.questions.find(x => x.text === it.question); return mq ? lab(mq) : it; });
    expect(decide(snapOf({ items: labs }), [cover(Q1)])).not.toBeNull();
    const off = labs.slice(); off[ix(Q1.text)] = radio(Q1, ['Yes', 'No'], [Q1.yes, `label[for="${Q1.no.slice(1)}"] >> nth=1`]);
    expect(decide(snapOf({ items: off }), [cover(Q1)])).toBeNull();
  });

  it('question words with square brackets, a colon or an apostrophe break nothing', () => {
    const odd = { ...Q1, text: 'Have you [or a spouse] ever had: insurance refused (the "CCJ\'s" kind)?' };
    const m0 = maps()[0];
    const map = [{ ...m0, text: RS.text.replace(Q1.text, odd.text), tail: RS.tail.replace(Q1.text, odd.text),
      items: m0.items.map(([k, t]) => [k, t === Q1.text ? odd.text : t]), questions: [odd, ...m0.questions.slice(1)] }];
    const items = ITEMS(); items[ix(Q1.text)] = radio(odd);
    const s = snapOf({ text: map[0].text, items });
    const m = b.mappedDeclarations(s, s.url, { covers: [cover(odd)], ownerKey: 'test-owner-a', maps: map });
    expect(m.questions[0].decision.robot).toBe(true);
  });

  it('an override maps file counts only for this machine; a real host in it is ignored', () => {
    const f = join(tmp('od-maps-'), 'maps.json');
    const one = (host) => ({ ...RS, host });
    writeFileSync(f, JSON.stringify({ version: 1, maps: [one('quote.rightsureforbusiness.co.uk'), one('evil.example'), one('127.0.0.1.evil.example'),
      one('localhost:99/x'), one('user@127.0.0.1:5'), one('127.0.0.1:4321')] }));
    const was = process.env.AGENT_DECLARATION_MAPS;
    process.env.AGENT_DECLARATION_MAPS = f;
    try {
      const r = b.loadDeclarationMaps();
      expect(r.maps.map(m => m.host)).toEqual(['127.0.0.1:4321']);
      expect(r.problems).toHaveLength(5);
      expect(b.mappedDeclarations(snapOf(), 'https://quote.rightsureforbusiness.co.uk/landlord/personal', { covers: [cover(Q1)], ownerKey: 'test-owner-a', maps: r.maps })).toBeNull();
      expect(b.mappedDeclarations(snapOf(), 'http://127.0.0.1:4321/landlord/personal', { covers: [cover(Q1)], ownerKey: 'test-owner-a', maps: r.maps })).not.toBeNull();
      expect(b.mappedDeclarations(snapOf(), 'http://127.0.0.1:4322/landlord/personal', { covers: [cover(Q1)], ownerKey: 'test-owner-a', maps: r.maps })).toBeNull();
    } finally {
      if (was === undefined) delete process.env.AGENT_DECLARATION_MAPS; else process.env.AGENT_DECLARATION_MAPS = was;
    }
    // A maps file that cannot be read: no map, and the reason.
    process.env.AGENT_DECLARATION_MAPS = join(tmp('od-maps-'), 'nothing.json');
    try { expect(b.loadDeclarationMaps()).toMatchObject({ maps: [], problems: [expect.stringMatching(/cannot be read/)] }); } finally { delete process.env.AGENT_DECLARATION_MAPS; }
  });

  it('his covers: only whole, valid entries with pick "No"; a missing file or list is no covers', () => {
    const d = tmp('od-covers-');
    const f = join(d, 'standing-answers.json');
    expect(b.loadExactCovers(join(d, 'nothing.json'))).toEqual({ covers: [], problems: [] });
    writeFileSync(f, JSON.stringify({ facts: ['a: b'] }));
    expect(b.loadExactCovers(f)).toEqual({ covers: [], problems: [] });
    writeFileSync(f, '{ not json');
    expect(b.loadExactCovers(f).covers).toEqual([]);
    expect(b.loadExactCovers(f).problems[0]).toMatch(/not valid JSON/);
    writeFileSync(f, JSON.stringify({ exact: [cover(Q1), cover(Q3, { pick: 'Yes' }), cover(Q3, { owners: [] }), cover(Q3, { said: '' }), cover(Q3, { date: '1 Nov' }),
      cover(Q3, { owners: 'test-owner-a' }), cover(Q4, { pick: 'no' }), null] }));
    const r = b.loadExactCovers(f);
    expect(r.covers.map(c => c.question)).toEqual([Q1.text]);
    expect(r.problems).toHaveLength(7);
  });
});

// ── The practice copy of the page, on this machine ───────────────────────────────────────────────
// RightSure's own markup and words (read 15 Nov 2026): no <form>; each answer's input sits INSIDE its label
// under a stylesheet class, and the label is the visible button. `hide` picks how the input sits there:
// `real` is the live page's own (shown, but under the label with pointer-events off).
const answer = (name, id, value, text, over = false) => `<div${over ? ' style="position:relative"' : ''}><label for="${id}" class="action-button-font rounded-corners input text-label radio-label bg-not-selected-col "><input name="${name}" id="${id}" aria-labelledby="${id}" type="radio" class="hide-radio-checkbox" value="${value}"><div class="radio-checkbox-container"><svg aria-labelledby="Checkbox Filled Icon" width="30px" height="30px" viewBox="0 0 22 22" class="radio-checkbox"><g><path d="M1 1"></path></g></svg>${text}</div></label>${over ? '<div class="cover" style="position:absolute;inset:0;z-index:10"></div>' : ''}</div>`;
const q = (name, text, { labels = ['Yes', 'No'], ids = [`${name}yes`, `${name}no`], values = ['yes', 'no'], overNo = false } = {}) => `<div class="q"><p>${text}</p>
  ${answer(name, ids[0], values[0], labels[0])}
  ${answer(name, ids[1], values[1], labels[1], overNo)}</div>`;
const box = (id, text, type = 'text') => `<div class="q"><label for="${id}">${text}</label><input type="${type}" id="${id}" name="${id}"${type === 'date' ? ' max="2009-12-15" value=""' : ''}></div>`;
const select = (id, text, options) => `<div class="q"><label for="${id}">${text}</label><select name="${id}" id="${id}"><option value="" disabled selected hidden></option>${options.map(o => `<option>${o}</option>`).join('')}</select></div>`;
const HIDE = { real: '.hide-radio-checkbox { position: absolute; pointer-events: none; width: 13px; height: 13px; }',
  display: '.hide-radio-checkbox { display: none; }', opacity: '.hide-radio-checkbox { opacity: 0; position: absolute; width: 0; height: 0; }' };
const LABEL_CSS = '.radio-label { display: flex; position: relative; width: 128px; height: 52px; align-items: center; }';
function personal(v = '', hide = 'real') {
  const claimsQ = v === 'reworded' ? 'Have you made any claim at the property to be insured?' : Q3.text;
  return `<!doctype html><html><head><style>${HIDE[hide] || HIDE.real} ${LABEL_CSS}</style></head><body>
  <div id="f">
    <h1>${v === 'heading' ? 'About You' : 'Your Details'}</h1>
    ${select('title', 'What is your title?', ['Dr', 'Miss', 'Mrs', 'Ms', 'Mr', 'Mx'])}
    ${box('firstName', 'What is your first name?')}${box('lastName', 'What is your last name?')}${box('dateOfBirth', 'What is your date of birth?', 'date')}
    ${select('gender', 'What is your gender?', ['Male', 'Female', 'Cisgender', 'Prefer Not To Say'])}
    <div class="q"><label for="postcodeEntered">What is your postcode?</label><input type="text" id="postcodeEntered" name="postcodeEntered"> <button type="button" id="search">Search</button></div>
    ${box('addressLineOne', 'Address Line 1:')}${box('addressLineTwo', 'Address Line 2:')}${box('addressLineThree', 'Address Line 3:')}${box('town', 'Town:')}
    ${box('email', 'What is your email address?')}${box('mainPhoneNumber', 'What is your main telephone number?')}
    ${v === 'declbefore' ? '<p class="help">We never share your details with the police.</p>' : ''}
    ${select('occupationType', 'What is your occupation type?', ['Employee', 'Company Director', 'Self Employed', 'Unemployed', 'Retired', 'Houseperson', 'Student', 'Other'])}
    ${q('hasSecondOccupation', 'Do you have a second occupation?')}
    ${v === 'extraq' ? q('mainHome', 'Is the property your main home?') : ''}
    ${v === 'yousentence' ? "<p>In the questions below, 'you' means you and anyone living at the property</p>" : ''}
    ${q('insuranceRefused', Q1.text, v === 'otherid' ? { ids: ['insuranceRefusedyes', 'insuranceRefusedNo2'] } : v === 'swapvalue' ? { values: ['no', 'yes'] } : v === 'overlay' ? { overNo: true } : {})}
    ${q('bankruptOrCcj', Q2.text)}
    ${v === 'prosecutions' ? '<p>We may pass details to prosecutions teams.</p>' : ''}
    <h3>Claims</h3>
    ${q('hasClaims', claimsQ)}
    <div id="followup"></div>
    ${q('hasOtherPropertyClaims', Q4.text, v === 'yesnone' ? { labels: ['Yes', 'None'] } : {})}
    ${v === 'extra' ? q('policyCancelled', 'Have you ever had a policy cancelled?') : ''}
    <button type="button" id="back">Back</button> <button type="button" id="next">Next</button>
  </div>
  <script>
    // What the page holds, sent on every change, so the test can see exactly which boxes were touched.
    const state = () => { const o = {}; for (const el of document.querySelectorAll('#f input, #f select')) o[el.id] = el.type === 'radio' ? el.checked : el.value;
      fetch('/state', { method: 'POST', body: JSON.stringify(o), keepalive: true }).catch(() => {}); };
    document.addEventListener('input', state, true); document.addEventListener('change', state, true); state();
    ${v === 'datereset' ? "document.getElementById('dateOfBirth').addEventListener('input', e => { e.target.value = ''; });" : ''}
    ${v === 'movetick' ? "document.getElementById('insuranceRefusedno').addEventListener('click', () => history.pushState({}, '', '/landlord/elsewhere'));" : ''}
    ${v === 'untick' ? "document.getElementById('insuranceRefusedno').addEventListener('click', e => e.preventDefault());" : ''}
    ${v === 'preno' ? "document.getElementById('insuranceRefusedno').checked = true; state();" : ''}
    // No <form> on the real page: Next sends the answers itself. "bounce" sends him back to this page once.
    document.getElementById('next').addEventListener('click', () => {
      const p = new URLSearchParams();
      for (const el of document.querySelectorAll('#f input, #f select')) if (el.type !== 'radio' || el.checked) p.append(el.name, el.value);
      location.href = (${JSON.stringify(v)} === 'bounce' ? '/landlord/personal?v=bounced&' : '/landlord/property?') + p.toString();
    });
    ${v === 'followup' ? `document.getElementById('hasClaimsno').addEventListener('click', () => { document.getElementById('followup').innerHTML = ${JSON.stringify(q('claimRefused', 'Has any insurer ever refused one of your claims?'))}; });` : ''}
    // Kevin, stood in: when the robot hands him the page, he reads the bar (sent to the test), answers the
    // conviction question and presses Next.
    setInterval(() => {
      const t = document.getElementById('od-your-turn');
      if (t && /^Your turn/.test(t.textContent) && !window.__answered) {
        window.__answered = 1;
        fetch('/banner', { method: 'POST', body: t.textContent, keepalive: true }).catch(() => {});
        setTimeout(() => { document.querySelector('label[for="bankruptOrCcjno"]').click(); document.getElementById('next').click(); }, 300);
      }
    }, 200);
  </script></body></html>`;
}
const PRICE = `<!doctype html><html><body><h1>Your quote</h1><p>£12.34 a month</p><button id="buy">Buy now</button></body></html>`;

let server, base, port, lastState = null, lastBanner = null;
const hits = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/banner') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => { lastBanner = body; res.end('ok'); });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/state') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => { try { lastState = JSON.parse(body); } catch (e) { lastState = { error: String(e) }; } res.end('ok'); });
      return;
    }
    hits.push(req.url);
    const page = u.pathname === '/landlord/personal' || u.pathname === '/landlord/personal-copy' ? personal(u.searchParams.get('v') || '', u.searchParams.get('hide') || 'real')
      : u.pathname === '/landlord/property' ? PRICE : null;
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
    res.end(page || 'not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
afterAll(() => { server.close(); for (const d of made) rmSync(d, { recursive: true, force: true }); });

// The planner, stood in: answers from the facts by the question's words, as the real one is told to.
// It names Next whenever it can; PLANNER_TRY=mapped makes it also try to answer the declarations itself.
const PLANNER = `
module.exports = async (input) => {
  const p = input.page;
  const fact = re => input.facts.find(f => re.test(f)) || '';
  const val = f => f.split(': ').slice(1).join(': ');
  const steps = [];
  const fill = (it, re) => { const f = fact(re); if (f && !it.value) steps.push({ do: 'fill', target: it.target, value: val(f), question: it.question, source: f }); };
  const pick = (it, re) => { const f = fact(re); if (f && !it.value) steps.push({ do: 'select', target: it.target, value: val(f), question: it.question, source: f }); };
  for (const it of p.items) {
    const q = it.question;
    if (/title/.test(q)) pick(it, /^Title:/);
    else if (/first name/.test(q)) fill(it, /^First name:/);
    else if (/last name/.test(q)) fill(it, /^Last name:/);
    else if (/date of birth/.test(q)) fill(it, /^Date of birth:/);
    else if (/gender/.test(q)) pick(it, /^Gender:/);
    else if (/postcode/.test(q)) fill(it, /^Correspondence postcode:/);
    else if (/^Address Line 1/.test(q)) fill(it, /^Correspondence address:/);
    else if (/^Town/.test(q)) fill(it, /^Correspondence town:/);
    else if (/email/.test(q)) fill(it, /^Email address:/);
    else if (/telephone/.test(q)) fill(it, /^Phone number:/);
    else if (/occupation type/.test(q)) pick(it, /^Occupation:/);
    else if (it.kind === 'radio' && /second occupation/.test(q) && !it.options.some(o => o.checked)) {
      steps.push({ do: 'click', target: it.options.find(o => o.label === 'No').target, question: q, source: fact(/^Second occupation:/) });
    }
  }
  if (process.env.PLANNER_TRY === 'mapped') {
    steps.push({ do: 'click', target: '#bankruptOrCcjyes', question: 'convictions', source: fact(/^Second occupation:/) });
    steps.push({ do: 'click', target: '#hasClaimsyes', question: 'claims', source: fact(/^Second occupation:/) });
  }
  const unknown = process.env.PLANNER_TRY === 'unknown2' ? ['What is your middle name?', 'How long have you been a landlord?']
    : process.env.PLANNER_TRY === 'long' ? ['How would you describe the property? ' + 'It has a long and winding description. '.repeat(10)] : [];
  const next = p.buttons.find(x => x.text === 'Next');
  return { steps, next: next ? next.target : null, unknown: unknown.map(u => u.slice(0, 400)), done: 'no' };
};
`;

const fact = (value) => ({ value, source: 'test card', date: '2026-01-01' });
const FACTS_STORE = { version: 1, general: { facts: {} },
  owners: {
    'test-owner-a': { name: 'Testa Example', facts: { title: fact('Mr'), 'first-name': fact('Testa'), 'last-name': fact('Example'), 'date-of-birth': fact('01/02/1970'),
      gender: fact('Male'), occupation: fact('Self Employed'), 'second-occupation': fact('No'), 'correspondence-address': fact('1 Practice Row'),
      'correspondence-town': { ...fact('Testtown'), label: 'Correspondence town' }, 'correspondence-postcode': fact('ZZ99 9ZZ'),
      email: fact('testa@example.com'), phone: fact('07700 900123') } },
    'test-owner-b': { name: 'Testb Example', facts: {} } },
  properties: { 'practice-house': { address: '1 Practice Row', town: 'Testtown', postcode: 'ZZ99 9ZZ', owner: 'test-owner-a', facts: {} } } };

// standing: the standing answers file's content, or null for no file. maps: false for no override file.
function home({ store = FACTS_STORE, outcome = 'Changes requested', standing = { facts: ['Contact: email only (test)'], exact: [cover(Q1), cover(Q2), cover(Q3), cover(Q4)] }, mapsFile = true, env = {} } = {}) {
  const h = tmp('od-declmap-');
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
  const standingFile = join(h, 'standing-answers.json');
  if (standing) writeFileSync(standingFile, JSON.stringify(standing));
  const formFacts = join(h, 'form-facts.json');
  writeFileSync(formFacts, JSON.stringify(store));
  const mapsPath = join(h, 'maps.json');
  writeFileSync(mapsPath, JSON.stringify({ version: 1, maps: [{ ...RS, host: `127.0.0.1:${port}` }] }));
  return { h, plans, env: { HOME: h, AGENT_BROWSER_SITES_FILE: sites, AGENT_HANDOVER_DIR: plans, AGENT_OUTCOME_SCRIPT: outcomeScript, AGENT_FORM_FACTS: formFacts,
    AGENT_HANDOVER_HEADLESS: '1', AGENT_HANDOVER_WAIT_MS: '1500', AGENT_HANDOVER_PAUSE_MS: '100', AGENT_HANDOVER_PLANNER: planner,
    AGENT_STANDING_ANSWERS: standingFile, ...(mapsFile ? { AGENT_DECLARATION_MAPS: mapsPath } : {}), ...env } };
}
function run(env, args, ms = 120000) {
  return new Promise(res => {
    const base_ = { ...process.env };
    delete base_.AGENT_DECLARATION_MAPS;
    const c = spawn(process.execPath, [SCRIPT, ...args], { env: { ...base_, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), ms);
    c.on('exit', code => { clearTimeout(t); res({ code, out, err }); });
  });
}
const PLAN = (path, factsFor = { owner: 'test-owner-a', properties: ['practice-house'] }, more = []) => ({ why: 'read the price and buy on monthly instalments only if you want it',
  site: 'practice', label: 'Practice quote', steps: [{ do: 'goto', url: `${base}${path}` }].concat(more), carryOn: { facts: [] }, factsFor });
const ledgerOf = x => readFileSync(join(x.h, 'knowledge-os', 'logs', 'agent-browser', 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
async function dryRun(path, opts = {}) {
  const x = home(opts);
  writeFileSync(join(x.plans, TASK + '.json'), JSON.stringify(PLAN(path, opts.factsFor, opts.steps)));
  lastState = null;
  hits.length = 0;
  const r = await run(x.env, ['handover', '--task', TASK, '--dry-run', '--shot', join(x.h, 'dry.png')]);
  let last;
  try { last = JSON.parse(r.out.trim().split('\n').pop()); } catch (e) { throw new Error(`no JSON from the dry run (${e.message}): ${r.err}${r.out}`); }
  return { x, r, last, line: ledgerOf(x).find(l => l.cmd === 'handover-dry-run') };
}
// Let the page's last change report land.
const settle = () => new Promise(r => setTimeout(r, 300));
const HIS_LINE = `"${Q2.text}" (always your own answer)`;
const CHECK_LINE = 'press Next when the page is right';
const LEAD = n => `The robot ticked No on ${n} declaration ${n === 1 ? 'question' : 'questions'} below: check each one`;
const TEXT_BOXES = ['firstName', 'lastName', 'dateOfBirth', 'postcodeEntered', 'addressLineOne', 'addressLineTwo', 'addressLineThree', 'town', 'email', 'mainPhoneNumber'];
const RADIOS = ['hasSecondOccupation', 'insuranceRefused', 'bankruptOrCcj', 'hasClaims', 'hasOtherPropertyClaims'].flatMap(n => [`${n}yes`, `${n}no`]);
function expectUntouched(state, label) {
  expect(state, label).not.toBeNull();
  for (const id of TEXT_BOXES) expect(state[id], `${label}: ${id}`).toBe('');
  for (const id of ['title', 'gender', 'occupationType']) expect(state[id], `${label}: ${id}`).toBe('');
  for (const [id, v] of Object.entries(state)) if (typeof v === 'boolean') expect(v, `${label}: ${id}`).toBe(false);
}

describe('the RightSure page: the robot fills it and answers only what Kevin covered', () => {
  for (const [how, path] of [['the real page\'s own way', '/landlord/personal'], ['display: none', '/landlord/personal?hide=display'],
    ['opacity: 0', '/landlord/personal?hide=opacity'], ['a cover over one label, so the DOM click is used', '/landlord/personal?v=overlay']]) it(`fills his details, answers questions 1, 3 and 4 No, leaves the conviction question and Next to him (input under its label by ${how})`, async () => {
    const { x, r, last, line } = await dryRun(path);
    await settle();
    expect(r.code, r.err + r.out).toBe(3);
    // The card's questions apart from the notes; the window shows both in one list.
    expect(last.stuck.unknown).toEqual([HIS_LINE]);
    expect(last.stuck.notes).toEqual([LEAD(3), CHECK_LINE]);
    expect(last.declarations.attempted).toEqual([]);
    expect(last.declarations.alreadyNo).toEqual([]);
    expect(last.declarations.answered.map(a => a.id)).toEqual(['insuranceRefused', 'hasClaims', 'hasOtherPropertyClaims']);
    for (const a of last.declarations.answered) expect(a).toMatchObject({ pick: 'No', said: expect.stringMatching(/^Test said no/), date: '2026-11-01' });
    expect(last.declarations.his).toEqual([{ id: 'bankruptOrCcj', question: Q2.text, why: 'always your own answer' }]);
    expect(last.declarationsProblem).toBeNull();
    expect(line.declarations).toEqual(last.declarations);
    expect(existsSync(join(x.h, 'dry.png'))).toBe(true);
    // The page itself: his details typed, three Nos ticked, the conviction question untouched.
    expect(lastState).toMatchObject({ firstName: 'Testa', lastName: 'Example', dateOfBirth: '1970-02-01', addressLineOne: '1 Practice Row', town: 'Testtown',
      postcodeEntered: 'ZZ99 9ZZ', email: 'testa@example.com', title: 'Mr', gender: 'Male', occupationType: 'Self Employed', mainPhoneNumber: '07700 900123', hasSecondOccupationno: true, insuranceRefusedno: true, insuranceRefusedyes: false, hasClaimsno: true, hasClaimsyes: false,
      hasOtherPropertyClaimsno: true, hasOtherPropertyClaimsyes: false, bankruptOrCcjyes: false, bankruptOrCcjno: false });
    // Next was never pressed: the next page was never asked for.
    expect(hits.some(u => u.startsWith('/landlord/property'))).toBe(false);
    expect(line.steps.some(s => s.next)).toBe(false);
  }, 120000);

  for (const [name, opts] of Object.entries({
    'no standing answers file': { standing: null },
    'no "exact" list': { standing: { facts: ['Contact: email only (test)'] } },
    'covers that pick Yes': { standing: { exact: [cover(Q1, { pick: 'Yes' }), cover(Q3, { pick: 'Yes' }), cover(Q4, { pick: 'Yes' })] } },
    'covers for another owner': { standing: { exact: [cover(Q1, { owners: ['test-owner-b'] }), cover(Q3, { owners: ['test-owner-b'] }), cover(Q4, { owners: ['test-owner-b'] })] } },
    'a plan that names no owner': { factsFor: { properties: ['practice-house'] } },
    'a house on file under another owner': { store: (() => { const st = JSON.parse(JSON.stringify(FACTS_STORE)); st.properties['practice-house'].owner = 'test-owner-b'; return st; })(),
      why: 'a house on this form is on file under another owner' },
    'a cover one word different': { standing: { exact: [cover(Q1, { question: Q1.text.replace('ever had', 'had') }), cover(Q3, { question: Q3.text.replace('any claims', 'any claim') }),
      cover(Q4, { question: Q4.text.replace('other', 'another') })] } },
  })) {
    it(`${name}: nothing is answered, all four are his by name, his details are still filled`, async () => {
      const { r, last } = await dryRun('/landlord/personal', opts);
      await settle();
      expect(r.code, r.err + r.out).toBe(3);
      expect(last.stuck.unknown).toHaveLength(4);
      [Q1, Q2, Q3, Q4].forEach((qq, i) => expect(last.stuck.unknown[i]).toMatch(new RegExp(`^"${qq.text.replace(/[?()'.*+[\]]/g, '\\$&')}" \\(`)));
      expect(last.stuck.notes).toEqual([CHECK_LINE]);
      if (opts.why) expect(last.declarations.his.filter(h => h.id !== 'bankruptOrCcj').map(h => h.why)).toEqual([opts.why, opts.why, opts.why]);
      expect(last.declarations.answered).toEqual([]);
      expect(last.declarations.his).toHaveLength(4);
      expect(lastState).toMatchObject({ firstName: 'Testa', email: 'testa@example.com', insuranceRefusedno: false, hasClaimsno: false, hasOtherPropertyClaimsno: false, bankruptOrCcjno: false });
      expect(hits.some(u => u.startsWith('/landlord/property'))).toBe(false);
    }, 120000);
  }

  it('a cover for the conviction question alone: still never answered', async () => {
    const { last } = await dryRun('/landlord/personal', { standing: { exact: [cover(Q2)] } });
    await settle();
    expect(last.declarations.answered).toEqual([]);
    expect(last.stuck.unknown[1]).toBe(HIS_LINE);
    expect(lastState).toMatchObject({ bankruptOrCcjyes: false, bankruptOrCcjno: false });
  }, 120000);

  it('the planner trying to answer a declaration, or naming Next, is dropped and never done', async () => {
    const { last, line } = await dryRun('/landlord/personal', { env: { PLANNER_TRY: 'mapped' } });
    await settle();
    expect(last.stuck.unknown).toEqual([HIS_LINE]);
    expect(last.stuck.notes).toEqual([LEAD(3), CHECK_LINE]);
    expect(line.steps.filter(s => ['#bankruptOrCcjyes', '#hasClaimsyes'].includes(s.selector))).toEqual([]);
    expect(lastState).toMatchObject({ bankruptOrCcjyes: false, bankruptOrCcjno: false, hasClaimsyes: false, hasClaimsno: true });
    expect(hits.some(u => u.startsWith('/landlord/property'))).toBe(false);
  }, 120000);

  it('answering No brings up a follow-up declaration: the robot stops, the page is his whole, and says what it had answered', async () => {
    const { last, line } = await dryRun('/landlord/personal?v=followup');
    await settle();
    expect(last.stuck.notes).toEqual([LEAD(2)]);
    expect(last.stuck.unknown[0]).toMatch(/^this page asks your declarations \(/);
    expect(last.stuck.unknown).not.toContain(CHECK_LINE);
    expect(last.stuck.error).toMatch(/^questions only Kevin can answer: The robot ticked No on 2/);
    expect(last.declarations.answered.map(a => a.id)).toEqual(['insuranceRefused', 'hasClaims']);
    expect(last.declarations.his.map(h => h.id)).toEqual(['bankruptOrCcj', 'hasOtherPropertyClaims']);
    expect(line.declarations).toEqual(last.declarations);
    expect(lastState).toMatchObject({ insuranceRefusedno: true, hasClaimsno: true, hasOtherPropertyClaimsno: false, bankruptOrCcjno: false, claimRefusedno: false, claimRefusedyes: false });
  }, 120000);
});

describe('the robot\'s click on a mapped No checks the live element', () => {
  it('a "No" label on an input that sends "yes" is refused: the page is his whole and nothing is ticked', async () => {
    const { last, line } = await dryRun('/landlord/personal?v=swapvalue');
    await settle();
    expect(last.stuck.unknown[0]).toMatch(/^this page asks your declarations \(/);
    expect(last.declarations.answered).toEqual([]);
    expect(line.steps.find(s => s.selector === '#insuranceRefusedno')).toMatchObject({ executed: false, error: expect.stringMatching(/sends "yes", not "no"/) });
    // The refused question carries the refusal's own words; the others keep their own reasons.
    expect(last.declarations.his.map(h => [h.id, h.why])).toEqual([
      ['insuranceRefused', expect.stringMatching(/^"#insuranceRefusedno" sends "yes", not "no"$/)],
      ['bankruptOrCcj', 'always your own answer'],
      ['hasClaims', 'the robot stopped at an earlier question, so it did not answer this one'],
      ['hasOtherPropertyClaims', 'the robot stopped at an earlier question, so it did not answer this one']]);
    for (const id of RADIOS.filter(r => !r.startsWith('hasSecondOccupation'))) expect(lastState[id], id).toBe(false);
  }, 120000);

  it('a date of birth that is not a real day is never typed into the date box', async () => {
    const store = JSON.parse(JSON.stringify(FACTS_STORE));
    store.owners['test-owner-a'].facts['date-of-birth'] = fact('31/02/1980');
    const { last } = await dryRun('/landlord/personal', { store });
    await settle();
    expect(lastState).toMatchObject({ dateOfBirth: '', firstName: 'Testa' });
    expect(last.declarations.answered).toHaveLength(3);
  }, 120000);

  // The judgement on what the page holds, driven with a stand-in page so each wrong shape is tried alone.
  const Qn = { ...maps()[0].questions[0] };
  const good = () => ({
    no: { count: 1, radio: true, id: 'insuranceRefusedno', name: 'insuranceRefused', value: 'no', inputShown: false, checked: false, labels: [{ text: 'No', shown: true, forId: 'insuranceRefusedno' }], words: 'no No' },
    yes: { count: 1, radio: true, id: 'insuranceRefusedyes', name: 'insuranceRefused', value: 'yes', inputShown: false, checked: false, labels: [{ text: 'Yes', shown: true, forId: 'insuranceRefusedyes' }], words: 'yes Yes' } });
  // labelFails: the label click throws (a cover over it); domOk: what the DOM click on the exact id finds.
  const fakePage = (st, { labelFails = false, domOk = true, tickOnClick = true } = {}) => {
    const clicked = [];
    const loc = sel => ({ count: async () => 1, locator: x => loc(`${sel} ${x}`),
      click: async () => { clicked.push(sel); if (labelFails) throw new Error('element intercepts pointer events'); if (tickOnClick) st.no.checked = true; } });
    return { clicked, page: { locator: loc, evaluate: async (fn, arg) => {
      if (arg && !Array.isArray(arg)) { clicked.push(`dom:${arg.i}`); if (domOk && tickOnClick) st.no.checked = true; return domOk; }
      return JSON.parse(JSON.stringify(st));
    } } };
  };
  it('clicks the one label, never the input with the pointer, shown or not, and reads it back', async () => {
    for (const shown of [false, true]) {
      const st = good(); st.no.inputShown = shown;
      const a = fakePage(st);
      await b.clickMappedNo(a.page, Qn);
      expect(a.clicked).toEqual(['label[for="insuranceRefusedno"]']);
    }
  });
  it('when the label click throws, a DOM click on the exact input, and nothing else', async () => {
    const a = fakePage(good(), { labelFails: true });
    await b.clickMappedNo(a.page, Qn);
    expect(a.clicked).toEqual(['label[for="insuranceRefusedno"]', 'dom:insuranceRefusedno']);
    const c = fakePage(good(), { labelFails: true, domOk: false });
    await expect(b.clickMappedNo(c.page, Qn)).rejects.toMatchObject({ clicked: true, message: expect.stringMatching(/no longer one enabled radio sending "no" in "insuranceRefused"/) });
  });
  it('a No already ticked on arrival: its checks still run, nothing is clicked, and it is said to be the page\'s', async () => {
    const st = good(); st.no.checked = true;
    const a = fakePage(st);
    expect(await b.clickMappedNo(a.page, Qn)).toBe('already');
    expect(a.clicked).toEqual([]);
    const bad = good(); bad.no.checked = true; bad.no.value = 'yes';
    await expect(b.clickMappedNo(fakePage(bad).page, Qn)).rejects.toThrow(/sends "yes"/);
  });
  it('a click that does not read back throws as tried, so the hand-over names it', async () => {
    const a = fakePage(good(), { tickOnClick: false });
    await expect(b.clickMappedNo(a.page, Qn)).rejects.toMatchObject({ clicked: true, message: expect.stringMatching(/did not read back as ticked/) });
  });
  for (const [name, change, why] of [
    ['a label that is not shown', st => { st.no.labels[0].shown = false; }, /label of "#insuranceRefusedno" is not shown/],
    ['two labels on one input', st => { st.no.labels.push({ text: 'No', shown: true, forId: '' }); }, /has 2 labels/],
    ['no label', st => { st.no.labels = []; }, /has 0 labels/],
    ['a label reading otherwise', st => { st.no.labels[0].text = 'No claims'; }, /reads "No claims"/],
    ['the No sending "yes"', st => { st.no.value = 'yes'; }, /sends "yes", not "no"/],
    ['the Yes twin sending "no"', st => { st.yes.value = 'no'; }, /sends "no", not "yes"/],
    ['another group name', st => { st.no.name = 'other'; }, /not in the group "insuranceRefused"/],
    ['a twin in another group', st => { st.yes.name = 'other'; }, /not in the group/],
    ['two elements with the id', st => { st.no.count = 2; }, /not exactly one radio/],
    ['not a radio', st => { st.no.radio = false; }, /not exactly one radio/],
    ['the Yes twin hidden', st => { st.yes.labels[0].shown = false; }, /label of "#insuranceRefusedyes" is not shown/],
    ['Yes already ticked', st => { st.yes.checked = true; }, /already answered Yes/],
  ]) {
    it(`refused, nothing clicked: ${name}`, async () => {
      const st = good(); change(st);
      const f = fakePage(st);
      await expect(b.clickMappedNo(f.page, Qn)).rejects.toThrow(why);
      expect(f.clicked).toEqual([]);
    });
  }
  it('a map question without its group name or values is refused', async () => {
    const f = fakePage(good());
    await expect(b.clickMappedNo(f.page, { ...Qn, noValue: '' })).rejects.toThrow(/no group name or values/);
    expect(f.clicked).toEqual([]);
  });
  it('a UK date becomes ISO only when it is a real day', () => {
    expect(b.isoFromUkDate('01/02/1970')).toBe('1970-02-01');
    expect(b.isoFromUkDate('1/2/1970')).toBe('1970-02-01');
    expect(b.isoFromUkDate('29-02-2024')).toBe('2024-02-29');
    expect(b.isoFromUkDate('05.11.2026')).toBe('2026-11-05');
    for (const v of ['31/02/1980', '29/02/2023', '1/13/1970', '01/02-1970', '1970-02-01', '01/02/70', 'Testa']) expect(b.isoFromUkDate(v), v).toBeNull();
  });
});

describe('anything not exactly as mapped is his whole page, as before, with no box touched', () => {
  for (const [name, path, mapsFile] of [
    ['one extra declaration radio', '/landlord/personal?v=extra', true],
    ['a question reworded', '/landlord/personal?v=reworded', true],
    ['options labelled Yes and None', '/landlord/personal?v=yesnone', true],
    ['a different radio id', '/landlord/personal?v=otherid', true],
    ['"prosecutions" inside the declarations', '/landlord/personal?v=prosecutions', true],
    ['a declaration word before the declarations', '/landlord/personal?v=declbefore', true],
    ['the same page on another path', '/landlord/personal-copy', true],
    ['a sentence above the declarations with no trigger word', '/landlord/personal?v=yousentence', true],
    ['an extra question above with no trigger word', '/landlord/personal?v=extraq', true],
    ['a reworded heading', '/landlord/personal?v=heading', true],
    ['no map for this machine', '/landlord/personal', false],
  ]) {
    it(name, async () => {
      const { r, last, line } = await dryRun(path, { mapsFile });
      await settle();
      expect(r.code, r.err + r.out).toBe(3);
      expect(last.stuck.unknown[0]).toMatch(/^this page asks your declarations \("/);
      expect(last.declarations).toBeNull();
      expect(line.steps.filter(s => s.carryOn && s.executed)).toEqual([]);
      expectUntouched(lastState, name);
    }, 120000);
  }
});

describe('every way out of a mapped page is recorded and said', () => {
  it('the page moves to another address after a tick: the robot stops, says what it ticked, and touches nothing more', async () => {
    const { last } = await dryRun('/landlord/personal?v=movetick');
    await settle();
    expect(last.stuck.unknown).toEqual([]);
    expect(last.stuck.notes).toEqual([LEAD(1), 'the page moved to another address after the robot ticked No, so it stopped: go Back and check its answers']);
    expect(last.declarations.answered.map(a => a.id)).toEqual(['insuranceRefused']);
    expect(last.declarations.his.map(h => h.id)).toEqual(['bankruptOrCcj', 'hasClaims', 'hasOtherPropertyClaims']);
    expect(lastState).toMatchObject({ hasClaimsno: false, hasOtherPropertyClaimsno: false });
  }, 120000);

  it('a tick that does not read back is listed as attempted and named in the hand-over', async () => {
    const { last } = await dryRun('/landlord/personal?v=untick');
    await settle();
    expect(last.declarations.answered).toEqual([]);
    expect(last.declarations.attempted).toEqual([{ id: 'insuranceRefused', question: Q1.text, error: expect.stringMatching(/did not read back as ticked/) }]);
    expect(last.stuck.notes).toEqual([`the robot tried to tick No on "${Q1.text}" and could not confirm it: check it`]);
    expect(last.stuck.unknown[0]).toMatch(/^this page asks your declarations/);
    expect(last.declarations.his.map(h => h.id)).toEqual(['bankruptOrCcj', 'hasClaims', 'hasOtherPropertyClaims']);
    expect(lastState).toMatchObject({ insuranceRefusedno: false, hasClaimsno: false });
  }, 120000);
});

describe('a No the page already had is not the robot\'s', () => {
  it('is listed apart, not counted in the robot\'s ticks, never clicked, and named for him to check', async () => {
    const { last, line } = await dryRun('/landlord/personal?v=preno');
    await settle();
    expect(last.declarations.alreadyNo).toEqual([{ id: 'insuranceRefused', question: Q1.text }]);
    expect(last.declarations.answered.map(a => a.id)).toEqual(['hasClaims', 'hasOtherPropertyClaims']);
    expect(last.stuck.notes).toEqual([LEAD(2), `"${Q1.text}" was already ticked No when the robot arrived: check it`, CHECK_LINE]);
    expect(last.stuck.unknown).toEqual([HIS_LINE]);
    expect(line.steps.filter(s => s.selector === '#insuranceRefusedno')).toEqual([]);
    expect(lastState).toMatchObject({ insuranceRefusedno: true, hasClaimsno: true });
  }, 120000);
});

describe('a date box is always set whole and read back', () => {
  it('a plan step typing a UK date key by key into a date box sets the ISO date instead', async () => {
    const { last } = await dryRun('/landlord/personal', { steps: [{ do: 'fill', selector: '#dateOfBirth', value: '01/02/1970', typed: true }] });
    await settle();
    expect(lastState.dateOfBirth).toBe('1970-02-01');
    expect(last.declarations.answered).toHaveLength(3);
  }, 120000);

  it('a date box that does not hold the date after the fill fails the step', async () => {
    const { r, last } = await dryRun('/landlord/personal?v=datereset', { steps: [{ do: 'fill', selector: '#dateOfBirth', value: '01/02/1970', typed: true }] });
    expect(r.code).toBe(3);
    expect(last.stuck).toMatchObject({ step: 2, do: 'fill', error: expect.stringMatching(/the date box #dateOfBirth did not hold 1970-02-01/) });
  }, 120000);
});

describe('in his window', () => {
  async function live(path, env = {}) {
    const x = home({ outcome: 'Approved as-is', env });
    writeFileSync(join(x.plans, TASK + '.json'), JSON.stringify(PLAN(path)));
    hits.length = 0;
    lastBanner = null;
    const r = await run(x.env, ['handover', '--task', TASK]);
    let last;
    try { last = JSON.parse(r.out.trim().split('\n').pop()); } catch (e) { throw new Error(`no JSON from the window (${e.message}): ${r.err}${r.out}`); }
    return { x, r, last, line: ledgerOf(x).find(l => l.cmd === 'handover') };
  }

  it('after the robot\'s part he answers the conviction question and presses Next, and the robot carries on', async () => {
    const { r, last, line } = await live('/landlord/personal');
    expect(r.code, r.err + r.out).toBe(0);
    expect(last).toMatchObject({ mode: 'handover', handedOver: true, stuck: null, end: 'price' });
    const sent = hits.find(u => u.startsWith('/landlord/property?'));
    expect(sent).toMatch(/firstName=Testa&lastName=Example&dateOfBirth=1970-02-01/);
    expect(sent).toMatch(/insuranceRefused=no&bankruptOrCcj=no&hasClaims=no&hasOtherPropertyClaims=no/);
    expect(line.declarations.answered.map(a => a.id)).toEqual(['insuranceRefused', 'hasClaims', 'hasOtherPropertyClaims']);
    const kevin = line.steps.filter(s => s.do === 'kevin');
    expect(kevin).toHaveLength(1);
    expect(kevin[0].say).toMatch(/^The robot ticked No on 3 declaration questions below: check each one \| .*always your own answer.*press Next when the page is right/);
    expect(lastBanner).toMatch(/^Your turn: The robot ticked No on 3 declaration questions below: check each one\. /);
    // The robot pressed no Next of its own on the mapped page.
    expect(line.steps.filter(s => s.next)).toEqual([]);
  }, 120000);

  it('the bar always opens with the robot\'s ticks: with 3 ticks and 2 open questions, and with one 400-character question', async () => {
    for (const tryIt of ['unknown2', 'long']) {
      const { last } = await live('/landlord/personal', { PLANNER_TRY: tryIt });
      expect(last.end, tryIt).toBe('price');
      expect(lastBanner, tryIt).toMatch(/^Your turn: The robot ticked No on 3 declaration questions below: check each one\. /);
      if (tryIt === 'unknown2') expect(lastBanner).toMatch(/What is your middle name\?/);
      if (tryIt === 'long') expect(lastBanner.length).toBeLessThan(500);
    }
  }, 120000);

  it('the robot works a mapped page once per run: sent back to it, the page is his whole and nothing is ticked again', async () => {
    const { last, line } = await live('/landlord/personal?v=bounce');
    expect(last).toMatchObject({ handedOver: true, end: 'price' });
    const kevin = line.steps.filter(s => s.do === 'kevin');
    expect(kevin).toHaveLength(2);
    const earlier = 'The robot ticked No on 3 declaration questions on this page earlier: check each one is still as you want it';
    expect(kevin[1].say.startsWith(`${earlier} | the robot has already been on this page once in this run`)).toBe(true);
    expect(line.steps.filter(s => s.carryOn === 2 && s.do !== 'kevin')).toEqual([]);
    expect(lastBanner.startsWith(`Your turn: ${earlier}. the robot has already been on this page once in this run`)).toBe(true);
    // On the second visit only his own answer was given: the robot's Nos were not ticked again.
    const sent = hits.find(u => u.startsWith('/landlord/property?'));
    expect(sent).toMatch(/bankruptOrCcj=no/);
    expect(sent).not.toMatch(/insuranceRefused=|hasClaims=|hasOtherPropertyClaims=/);
  }, 180000);
});

// ── The guard and the DOM click on real pages, in a browser of the test's own ─────────────────────
describe('a label target never lets through what the input target refused', () => {
  let browser;
  beforeAll(async () => { browser = await require_('playwright').chromium.launch(); });
  afterAll(async () => { if (browser) await browser.close(); });
  const NOPTR = '<style>.r { position: absolute; pointer-events: none; width: 13px; height: 13px; } label { display: inline-block; position: relative; min-width: 80px; min-height: 30px; }</style>';
  async function pageWith(html) { const pg = await browser.newPage(); await pg.setContent(`<!doctype html><html><head>${NOPTR}</head><body>${html}</body></html>`); return pg; }

  it('a radio taking no pointer, whose question label says "pay": refused by its label exactly as by the input', async () => {
    const pg = await pageWith(`<div><label for="p1">Do you wish to pay now?</label>
      <label for="p1"><input class="r" type="radio" name="p" id="p1" value="y">Yes</label>
      <label for="p2"><input class="r" type="radio" name="p" id="p2" value="n">No</label></div>`);
    const item = (await b.snapshotForm(pg)).items.find(i => i.kind === 'radio');
    const yes = item.options.find(o => o.label === 'Yes');
    expect(yes.target).toMatch(/^label\[for="p1"\] >> nth=1$/);
    for (const selector of ['#p1', yes.target]) {
      await expect(b.assertNotFinalAction(pg, { do: 'click', selector }), selector).rejects.toThrow(/looks like the final action/);
    }
    await pg.close();
  });

  it('a hidden radio clicked by its label keeps its old reading (the other label is the question, not the option)', async () => {
    const pg = await pageWith(`<div><label for="h1">How would you like to pay?</label>
      <label for="h1"><input type="radio" name="h" id="h1" value="m" style="display:none">Monthly</label>
      <label for="h2"><input type="radio" name="h" id="h2" value="a" style="display:none">Annually</label></div>`);
    await expect(b.assertNotFinalAction(pg, { do: 'click', selector: 'label[for="h1"] >> nth=1' })).resolves.toBeUndefined();
    await pg.close();
  });

  it('a radio taking no pointer whose id is not unique keeps the input as its target', async () => {
    const pg = await pageWith(`<div><p>Pick one</p><label for="d1"><input class="r" type="radio" name="d" id="d1" value="a">Alpha</label>
      <label for="d1"><input class="r" type="radio" name="d" id="d1" value="b">Beta</label></div>`);
    const item = (await b.snapshotForm(pg)).items.find(i => i.kind === 'radio');
    for (const o of item.options) expect(o.target, o.label).not.toMatch(/^label\[/);
    await pg.close();
  });

  it('the DOM-click fallback re-checks the element and does not click a disabled radio', async () => {
    const pg = await pageWith(`<div><p>${Q1.text}</p>
      <div style="position:relative"><label for="insuranceRefusedno"><input class="r" type="radio" name="insuranceRefused" id="insuranceRefusedno" value="no" disabled>No</label>
        <div style="position:absolute;inset:0;z-index:10"></div></div>
      <label for="insuranceRefusedyes"><input class="r" type="radio" name="insuranceRefused" id="insuranceRefusedyes" value="yes">Yes</label></div>`);
    await expect(b.clickMappedNo(pg, maps()[0].questions[0])).rejects.toMatchObject({ clicked: true, message: expect.stringMatching(/no longer one enabled radio/) });
    expect(await pg.evaluate(() => document.getElementById('insuranceRefusedno').checked)).toBe(false);
    await pg.close();
  }, 30000);
});
