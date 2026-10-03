// The direct rent payment form for a new tenant (Cash Flow Voids lane B, 3 Oct 2026; Kevin's
// ruling "Robot fills, you pick reason"): scripts/rent_form_plan.py builds the answers and the
// robot's plan, scripts/rent_new_tenant.py raises the card and finishes it once Kevin says he
// sent it, scripts/agent-dispatch.py lets that one card open the robot's window and nothing else,
// and scripts/agent-browser.js lets the robot answer the form's "Direct rent payment" radio.
//
// The robot's plan is run for real, in Chromium, against a local copy of the DWP form's pages
// (ids as read from the live form). Every id, name, address and figure here is invented.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import http from 'node:http';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'scripts');
const HOME = mkdtempSync(join(tmpdir(), 'od-rent-form-'));
const SITES = join(HOME, 'sites.json');
writeFileSync(SITES, JSON.stringify({ '127.0.0.1': { label: 'DWP form copy', login: false,
  answers: b_answers() } }));
// The same named answers the robot ships with for the DWP form, so the copy is judged by the real list.
function b_answers() {
  const src = readFileSync(join(SCRIPTS, 'agent-browser.js'), 'utf8');
  const m = src.match(/'directpayment\.universal-credit\.service\.gov\.uk':[^}]*answers: (\[[^\]]*\])/);
  return JSON.parse(m[1].replace(/'/g, '"'));
}
process.env.AGENT_BROWSER_SITES_FILE = SITES;            // before the module reads it
const require_ = createRequire(import.meta.url);
const b = require_(join(SCRIPTS, 'agent-browser.js'));
let chromium;
try { ({ chromium } = require_('playwright-core')); } catch { /* reported in the test */ }

const PY = `
import importlib.util, json, sys, os, io, contextlib, tempfile, argparse, re
from datetime import date, datetime, timedelta, timezone
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def load_mod(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(${JSON.stringify(SCRIPTS)}, file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
import rent_form_plan as fp
TENANCY = {"id": "recFormTest000001", "rent": 900.0, "frequency": "Monthly"}
TENANT = {"id": "recFormTest000002", "name": "Sam Sample", "dob": "1980-03-07"}
PROP = {"id": "recFormTest000003", "address": "1 Example Road, Exampleton, Exampleshire, EX1 2MP", "postcode": "EX1 2MP", "area": "Exampleton"}
LOW = {"months": 1.0, "owed": 900.0, "falls": 1, "paid": 0.0, "asAt": "2026-10-03", "next": "2026-10-25"}
HIGH = {"months": 2.0, "owed": 1800.0, "falls": 2, "paid": 0.0, "asAt": "2026-10-03", "next": "2026-10-25"}
LANDLORD = {"full_name": "Lee Landlord", "phone_number": "07000 000000", "email_address": "info@agilelets.co.uk",
            "address": {"line1": "2 Office Street", "line2": "Suite 3", "town_city": "Officetown", "postcode": "OF1 1CE"},
            "account_holder": "Example Lettings Ltd"}
`;
function py(body) {
  const out = execFileSync('python3', ['-c', PY + body], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('the answers and the plan, built from the records', () => {
  it('fills every answer the records hold, says where each came from, and leaves the reason, the code, the bank numbers and send to Kevin', () => {
    const r = py(`
built = fp.build(TENANCY, TENANT, PROP, LANDLORD, place="Unit 9 – 1 Example Road", arrears=LOW)
print(json.dumps({"answers": built["answers"], "missing": built["missing"], "plan": built["plan"]}))`);
    expect(r.missing).toEqual([]);
    const a = Object.fromEntries(r.answers.map(([q, ans, src]) => [q, [ans, src]]));
    expect(a['Rent']).toEqual(['£900.00, Monthly', 'tenancy record recFormTest000001']);
    expect(a['Tenant']).toEqual(['Sam Sample', 'tenant record recFormTest000002']);
    expect(a["Tenant's address"][0]).toBe('1 Example Road, Exampleton, EX1 2MP');
    expect(a['Payment reference']).toEqual(['Sample', "the tenant's surname"]);
    expect(a['Why the rent should be paid direct'][0]).toMatch(/^YOURS/);
    expect(a['Type of payment']).toEqual(['Direct rent payment', 'the rent check: a new cash flow void']);
    expect(a['Has the tenant missed 2 months or more of rent?'][0]).toBe("No (£900.00 unpaid: 1 month's rent due since the tenancy began, "
      + '£0.00 matched). Good until 24 Oct 2026: the window refuses it after that and a fresh card is raised');
    // The answer holds until the day before the next rent falls due, and the plan says so for the window.
    expect(r.plan.validUntil).toBe('2026-10-24');
    expect(a['Sort code and account number'][0]).toMatch(/^YOURS/);
    // The plan never presses send, never types a secret, and waits for Kevin at his two steps.
    const steps = r.plan.steps;
    expect(() => b.assertHandoverPlan(r.plan)).not.toThrow();
    expect(steps.filter(s => s.do === 'kevin').map(s => s.untilSelector)).toEqual(['#f-rentAmount', '[id="f-accountHolder"]']);
    expect(JSON.stringify(steps)).not.toMatch(/sortCode|accountNumber|Accept and send|submit/i);
    expect(steps[steps.length - 1]).toEqual({ do: 'fill', selector: '[id="f-paymentReference"]', value: 'Sample' });
    // Each answer by its id AND its own words: a reordered form stops the robot, never ticks the wrong one.
    expect(steps[2]).toEqual({ do: 'check', selector: 'label[for="f-typeOfPayment"]:text-matches("^Direct rent")' });
    expect(steps[4]).toEqual({ do: 'check', selector: 'label[for="f-twoMonthsArrears-2"]:text-is("No")' });
    expect(r.plan.site).toBe('directpayment.universal-credit.service.gov.uk');
  });

  it('two months or more unpaid, or arrears the records cannot count: the type and the arrears answer are Kevin\'s, never guessed', () => {
    const r = py(`
out = {}
for key, arrears in (("high", HIGH), ("unknown", None), ("soon", dict(LOW, asAt="2026-10-22"))):
    built = fp.build(TENANCY, TENANT, PROP, LANDLORD, arrears=arrears)
    out[key] = {"answers": {q: a for q, a, _s in built["answers"]}, "steps": built["plan"]["steps"][:3]}
print(json.dumps(out))`);
    // "soon": the next rent is due in 3 days, so a "No" would be out of date before Kevin could use it.
    for (const k of ['high', 'unknown', 'soon']) {
      expect(r[k].answers['Type of payment']).toMatch(/^YOURS to choose in the window/);
      expect(r[k].answers['Has the tenant missed 2 months or more of rent?']).toMatch(/^YOURS to answer in the window/);
      // The robot opens the form and waits for Kevin until the rent page: no type or arrears click of its own.
      expect(r[k].steps.map(s => s.do)).toEqual(['goto', 'click', 'kevin']);
      expect(r[k].steps[2].untilSelector).toBe('#f-rentAmount');
    }
    expect(r.high.steps[2].say).toContain("£1,800.00 unpaid: 2 months' rent due since the tenancy began");
    expect(r.unknown.answers['Type of payment']).toContain('the rent check could not count the arrears');
  });

  it('a blank record raises no plan and says which record is blank; the landlord email must be info@', () => {
    const r = py(`
no_dob = fp.build(TENANCY, dict(TENANT, dob=""), PROP, LANDLORD)
bad_freq = fp.build(dict(TENANCY, frequency="Quarterly"), TENANT, PROP, LANDLORD)
blank_freq = fp.build(dict(TENANCY, frequency=None), TENANT, PROP, LANDLORD)
four = fp.build(dict(TENANCY, frequency="4-Weekly"), TENANT, PROP, LANDLORD)
bad_email = fp.build(TENANCY, TENANT, PROP, dict(LANDLORD, email_address="kevin@example.com"))
no_landlord = fp.build(TENANCY, TENANT, PROP, {})
print(json.dumps({"dob": [no_dob["plan"], no_dob["missing"]], "freq": bad_freq["missing"], "email": bad_email["missing"], "landlord": len(no_landlord["missing"]),
                  "fourWeekly": four["missing"], "blankFreq": [blank_freq["missing"], [a for q, a, _s in blank_freq["answers"] if q == "Rent"]], "split": list(fp.address_lines("1 Example Road, Exampleton, EX1 2MP", "ex1 2mp", "")),
                  "noTown": list(fp.address_lines("1 Example Road, EX1 2MP", "EX1 2MP", ""))}))`);
    expect(r.dob).toEqual([null, ["the tenant's date of birth (tenant record recFormTest000002)"]]);
    expect(r.freq).toEqual(["a monthly rent (tenancy record recFormTest000001 says 'Quarterly', and the rent check only counts monthly rent)"]);
    expect(r.email).toEqual(['the landlord email must be info@agilelets.co.uk (Kevin\'s ruling, 11 Aug 2026), not another address']);
    expect(r.landlord).toBe(7);
    // The rent check counts arrears in months, so a rent paid any other way is not filled here.
    // A blank frequency is monthly, as the app reads it (js/income.js getIncomeFrequency).
    expect(r.blankFreq).toEqual([[], ['£900.00, Monthly']]);
    expect(r.fourWeekly).toEqual(["a monthly rent (tenancy record recFormTest000001 says '4-Weekly', and the rent check only counts monthly rent)"]);
    // The postcode is its own box, and no unit number is ever added.
    expect(r.split).toEqual(['1 Example Road', 'Exampleton']);
    // The postcode is never read as the town: with no town on record the town is blank, and said.
    expect(r.noTown).toEqual(['1 Example Road', '']);
  });

  it('the card leads with the ask, lists every answer with its record, and declares the Kevin-only step', () => {
    const r = py(`
built = fp.build(TENANCY, TENANT, PROP, LANDLORD, place="Unit 9 – 1 Example Road", arrears=LOW)
text = fp.card_text(built["answers"], "Sam Sample", "Unit 9 – 1 Example Road", "Yes, verified this morning", "2 Oct 2026")
again = fp.card_text(built["answers"], "Sam Sample", "Unit 9 – 1 Example Road", "", "", {"on": "30 Sep 2026", "feedback": "The rent is £850"})
ad = load_mod("ad", "agent-dispatch.py")
print(json.dumps({"first": text.splitlines()[0], "roy": 'Roy\\'s words (2 Oct 2026): "Yes, verified this morning"' in text,
                  "again": [l for l in again.splitlines() if l.startswith("Last time")], "noRoy": "Roy's words" in again,
                  "wrong": "IF AN ANSWER IS WRONG" in text, "saves": "each Continue saves that page" in text,
                  "kevin": ad.kevin_only_step(text), "handoff": ad.work_handoff_problem(text, ad.kevin_only_step(text)),
                  "tier1": ad.tier_match(ad.TIER1_PATTERNS, text)}))`);
    expect(r.first).toBe('THE ASK: approve the direct rent payment form for Sam Sample at Unit 9 – 1 Example Road. Roy says the housing costs are verified.');
    expect(r.roy).toBe(true);
    expect(r.again).toEqual(['Last time (30 Sep 2026) you asked for changes: "The rent is £850". The answers below are read from the records again.']);
    expect(r.noRoy).toBe(false);
    expect([r.wrong, r.saves]).toEqual([true, true]);
    expect(r.kevin.reason).toBe('credential');
    expect(r.handoff).toBe('');
    expect(r.tier1).toBe('');
  });
});

// A copy of the DWP form's pages, with the ids read from the live form. The reason page and the
// email code page move on by themselves after a moment, standing in for Kevin doing his part.
const seen = [];
let server, base;
const page = (title, body, action) => `<!doctype html><html><head><title>${title}</title></head><body><main>
<form method="get" action="${action || ''}">${body}<button id="continue-button" type="submit">Continue</button></form></main></body></html>`;
const radio = (name, id, value, label) => `<div><input type="radio" name="${name}" id="${id}" value="${value}"><label for="${id}">${label}</label></div>`;
const text = (id, label) => `<div><label for="${id}">${label}</label><input type="text" id="${id}" name="${id}"></div>`;
const PAGES = {
  '/': `<!doctype html><html><body><h1>Apply for direct rent payments</h1><a href="/questions/type-of-payment" role="button">Start now</a></body></html>`,
  '/questions/type-of-payment': page('Type of payment', `<fieldset><legend>What type of payment are you applying for?</legend>
    ${radio('typeOfPayment', 'f-typeOfPayment', 'direct', 'Direct rent payment')}${radio('typeOfPayment', 'f-typeOfPayment-2', 'arrears', 'Rent arrears')}
    ${radio('typeOfPayment', 'f-typeOfPayment-4', 'both', 'Both direct rent payment and rent arrears')}</fieldset>`, '/questions/two-months-arrears'),
  '/questions/two-months-arrears': page('Two months arrears', `<fieldset><legend>Has your tenant missed 2 months or more of rent?</legend>
    ${radio('twoMonthsArrears', 'f-twoMonthsArrears', 'yes', 'Yes')}${radio('twoMonthsArrears', 'f-twoMonthsArrears-2', 'no', 'No')}</fieldset>`, '/questions/reason'),
  '/questions/reason': `<!doctype html><html><head><meta http-equiv="refresh" content="1;url=/questions/rent-details"></head><body>Reason (Kevin's)</body></html>`,
  '/questions/rent-details': page('Rent details', `${text('f-rentAmount', 'Rent amount, in pounds')}
    <fieldset><legend>How often is the rent paid?</legend>${radio('rentFrequency', 'f-rentFrequency', 'weekly', 'Weekly')}
    ${radio('rentFrequency', 'f-rentFrequency-2', '2weeks', 'Every 2 weeks')}${radio('rentFrequency', 'f-rentFrequency-3', '4weeks', 'Every 4 weeks')}
    ${radio('rentFrequency', 'f-rentFrequency-4', 'monthly', 'Monthly')}</fieldset>`, '/questions/tenant-details'),
  '/questions/tenant-details': page('Tenant details', `${text('f-tenantFullName', 'Full name')}
    <fieldset><legend>Date of birth</legend>${text('f-tenantDob[dd]', 'Day')}${text('f-tenantDob[mm]', 'Month')}${text('f-tenantDob[yyyy]', 'Year')}</fieldset>
    <div><label for="f-tenantAddress[address1]">Building and street <span style="position:absolute;left:-9999px">line 1 of 2</span></label><input id="f-tenantAddress[address1]" name="f-tenantAddress[address1]"></div>
    <div><label for="f-tenantAddress[address2]"><span style="position:absolute;left:-9999px">Building and street line 2 of 2</span></label><input id="f-tenantAddress[address2]" name="f-tenantAddress[address2]"></div>
    ${text('f-tenantAddress[address3]', 'Town or city')}${text('f-tenantAddress[address4]', 'County (optional)')}${text('f-tenantAddress[postcode]', 'Postcode')}`, '/questions/landlord-details'),
  '/questions/landlord-details': page('Landlord details', `${text('f-landlordFullName', 'Full name')}${text('f-landlordPhoneNumber', 'Phone number')}
    ${text('f-landlordEmailAddress', 'Email address')}
    <div><label for="f-landlordAddress[address1]">Building and street <span style="position:absolute;left:-9999px">line 1 of 2</span></label><input id="f-landlordAddress[address1]" name="f-landlordAddress[address1]"></div>
    <div><label for="f-landlordAddress[address2]"><span style="position:absolute;left:-9999px">Building and street line 2 of 2</span></label><input id="f-landlordAddress[address2]" name="f-landlordAddress[address2]"></div>
    ${text('f-landlordAddress[address3]', 'Town or city')}${text('f-landlordAddress[address4]', 'County (optional)')}${text('f-landlordAddress[postcode]', 'Postcode')}`, '/questions/confirm-your-email'),
  '/questions/confirm-your-email': `<!doctype html><html><head><meta http-equiv="refresh" content="1;url=/questions/landlord-bank-details"></head><body><label for="code">Code</label><input id="code"></body></html>`,
  '/questions/landlord-bank-details': page('Landlord bank details', `${text('f-accountHolder', 'Account holder')}${text('f-sortCode', 'Sort code')}
    ${text('f-accountNumber', 'Account number')}${text('f-paymentReference', 'Payment reference')}${text('f-creditorReference', 'Creditor reference number (if known)')}`, '/questions/review'),
  '/questions/review': `<!doctype html><html><body><h1>Check your answers before sending</h1><button id="send">Accept and send</button></body></html>`,
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push([u.pathname, Object.fromEntries(u.searchParams)]);
    res.writeHead(PAGES[u.pathname] ? 200 : 404, { 'content-type': 'text/html' });
    res.end(PAGES[u.pathname] || 'not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
});
afterAll(() => { server.close(); rmSync(HOME, { recursive: true, force: true }); });

describe('the plan, run by the real robot against a copy of the form (real Chromium)', () => {
  it('fills every page it knows, waits for Kevin at the reason and the code, and stops at the bank details with the numbers and send left to him', async () => {
    expect(chromium, 'playwright-core is not installed').toBeTruthy();
    const plan = py(`print(json.dumps(fp.build(TENANCY, TENANT, PROP, LANDLORD, place="Unit 9", arrears=LOW)["plan"]))`);
    plan.steps[0].url = base;                                      // the copy, not the DWP
    seen.length = 0;
    const browser = await chromium.launch({ headless: true });
    try {
      const p = await browser.newPage();
      const r = await b.runHandover(p, plan, { kevinMs: 20000, quiet: true });
      expect(r.stuck).toBeNull();
      expect(p.url()).toBe(base + 'questions/landlord-bank-details');
      const bank = await p.evaluate(() => Object.fromEntries(['f-accountHolder', 'f-sortCode', 'f-accountNumber', 'f-paymentReference']
        .map(id => [id, document.getElementById(id).value])));
      expect(bank).toEqual({ 'f-accountHolder': 'Example Lettings Ltd', 'f-sortCode': '', 'f-accountNumber': '', 'f-paymentReference': 'Sample' });
      const got = Object.fromEntries(seen.filter(([path]) => path.startsWith('/questions/')).map(([path, q]) => [path, q]));
      expect(got['/questions/two-months-arrears']).toEqual({ typeOfPayment: 'direct' });
      expect(got['/questions/reason']).toEqual({ twoMonthsArrears: 'no' });
      expect(got['/questions/tenant-details']).toEqual({ 'f-rentAmount': '900.00', rentFrequency: 'monthly' });
      expect(got['/questions/landlord-details']).toMatchObject({ 'f-tenantFullName': 'Sam Sample', 'f-tenantDob[dd]': '7', 'f-tenantDob[mm]': '3',
        'f-tenantDob[yyyy]': '1980', 'f-tenantAddress[address1]': '1 Example Road', 'f-tenantAddress[address3]': 'Exampleton', 'f-tenantAddress[postcode]': 'EX1 2MP' });
      expect(got['/questions/confirm-your-email']).toMatchObject({ 'f-landlordFullName': 'Lee Landlord', 'f-landlordEmailAddress': 'info@agilelets.co.uk',
        'f-landlordAddress[address1]': '2 Office Street', 'f-landlordAddress[address2]': 'Suite 3', 'f-landlordAddress[address3]': 'Officetown',
        'f-landlordAddress[postcode]': 'OF1 1CE' });
      // The review page and its send button were never reached.
      expect(seen.some(([path]) => path === '/questions/review')).toBe(false);
    } finally {
      await browser.close();
    }
  }, 90000);

  it('two months unpaid: the robot opens the form, Kevin answers the type and the arrears, and the robot carries on from the rent page', async () => {
    expect(chromium, 'playwright-core is not installed').toBeTruthy();
    const plan = py(`print(json.dumps(fp.build(TENANCY, TENANT, PROP, LANDLORD, place="Unit 9", arrears=HIGH)["plan"]))`);
    plan.steps[0].url = base;
    seen.length = 0;
    const browser = await chromium.launch({ headless: true });
    try {
      const p = await browser.newPage();
      const run = b.runHandover(p, plan, { kevinMs: 30000, quiet: true });
      // Kevin, in the window: his own answers on the first two pages.
      await p.waitForURL(base + 'questions/type-of-payment', { timeout: 20000 });
      await p.waitForTimeout(500);
      await p.check('#f-typeOfPayment-4');
      await p.click('#continue-button');
      await p.waitForURL(/two-months-arrears/, { timeout: 20000 });
      await p.check('#f-twoMonthsArrears');
      await p.click('#continue-button');
      const r = await run;
      expect(r.stuck).toBeNull();
      expect(p.url()).toBe(base + 'questions/landlord-bank-details');
      const got = Object.fromEntries(seen.filter(([path]) => path.startsWith('/questions/')).map(([path, q]) => [path, q]));
      expect(got['/questions/two-months-arrears']).toEqual({ typeOfPayment: 'both' });
      expect(got['/questions/reason']).toEqual({ twoMonthsArrears: 'yes' });
      expect(got['/questions/tenant-details']).toEqual({ 'f-rentAmount': '900.00', rentFrequency: 'monthly' });
      expect(seen.some(([path]) => path === '/questions/review')).toBe(false);
    } finally {
      await browser.close();
    }
  }, 90000);

  it('the robot answers the one named payment radio only on the site that names it, and never any other "pay" radio', async () => {
    expect(chromium, 'playwright-core is not installed').toBeTruthy();
    const browser = await chromium.launch({ headless: true });
    try {
      const p = await browser.newPage();
      await p.setContent(`<input type="radio" name="t" id="direct"><label for="direct">Direct rent payment</label>
        <input type="radio" name="t" id="paynow"><label for="paynow">Pay now</label>`);
      // about:blank names no answers: refused, as before this change.
      const off = await b.runHandover(p, { why: 'x', steps: [{ do: 'check', selector: '#direct' }] }, { quiet: true });
      expect(off.stuck.error).toMatch(/looks like the final action/);
      await p.goto(base + 'questions/type-of-payment');
      await p.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<input type="radio" name="z" id="paynow"><label for="paynow">Pay now</label>'); });
      const on = await b.runHandover(p, { why: 'x', steps: [{ do: 'check', selector: '#f-typeOfPayment' }] }, { quiet: true });
      expect(on.stuck).toBeNull();
      // "Both direct rent payment and rent arrears" is Kevin's answer, never the robot's.
      const both = await b.runHandover(p, { why: 'x', steps: [{ do: 'check', selector: '#f-typeOfPayment-4' }] }, { quiet: true });
      expect(both.stuck.error).toMatch(/looks like the final action/);
      const pay = await b.runHandover(p, { why: 'x', steps: [{ do: 'check', selector: '#paynow' }] }, { quiet: true });
      expect(pay.stuck.error).toMatch(/looks like the final action/);
      // The button that sends is still refused on the named site.
      await p.goto(base + 'questions/review');
      const send = await b.runHandover(p, { why: 'x', steps: [{ do: 'click', selector: '#send' }] }, { quiet: true });
      expect(send.stuck.error).toMatch(/looks like the final action/);
    } finally {
      await browser.close();
    }
  }, 60000);

  it('a reordered form stops the robot: it never ticks whatever now sits at the answer\'s id', async () => {
    expect(chromium, 'playwright-core is not installed').toBeTruthy();
    const steps = py(`print(json.dumps(fp.build(TENANCY, TENANT, PROP, LANDLORD, arrears=LOW)["plan"]["steps"]))`);
    const browser = await chromium.launch({ headless: true });
    try {
      const p = await browser.newPage();
      await p.goto(base + 'questions/type-of-payment');
      await p.evaluate(() => {
        document.querySelector('label[for="f-typeOfPayment"]').textContent = 'Rent arrears';
        document.querySelector('label[for="f-typeOfPayment-2"]').textContent = 'Direct rent payment';
      });
      const type = await b.runHandover(p, { why: 'x', steps: [{ ...steps[2], timeout: 2000 }] }, { quiet: true });
      expect(type.stuck).not.toBeNull();
      expect(await p.isChecked('#f-typeOfPayment')).toBe(false);
      await p.goto(base + 'questions/two-months-arrears');
      await p.evaluate(() => {
        document.querySelector('label[for="f-twoMonthsArrears"]').textContent = 'No';
        document.querySelector('label[for="f-twoMonthsArrears-2"]').textContent = 'Yes';
      });
      const arrears = await b.runHandover(p, { why: 'x', steps: [{ ...steps[4], timeout: 2000 }] }, { quiet: true });
      expect(arrears.stuck).not.toBeNull();
      expect(await p.isChecked('#f-twoMonthsArrears-2')).toBe(false);
    } finally {
      await browser.close();
    }
  }, 60000);

  it('the window refuses a plan whose arrears answer has expired (London date), and a malformed date', () => {
    const plan = { why: 'send it', validUntil: '2026-10-24', steps: [{ do: 'goto', url: 'https://example.test/' }] };
    const at = (iso) => { try { b.assertHandoverPlan(plan, new Date(iso)); return 'ok'; } catch (e) { return String(e.message); } };
    expect(at('2026-10-24T22:30:00Z')).toBe('ok');                 // 23:30 in London, still the 24th
    expect(at('2026-10-24T23:30:00Z')).toMatch(/were good until 2026-10-24/);   // 00:30 on the 25th in London
    expect(() => b.assertHandoverPlan({ ...plan, validUntil: '24 Oct' })).toThrow(/must be a date/);
    expect(() => b.assertHandoverPlan({ why: 'x', steps: plan.steps })).not.toThrow();
  });

  it('namedAnswer: exact option words, a radio only, the exact named host only, and nothing else refused in the words', () => {
    const dwp = 'https://127.0.0.1/questions/type-of-payment';
    const ok = { tick: true, option: 'Direct rent payment', value: 'direct', words: 'Direct rent payment direct Direct rent payment' };
    expect(b.namedAnswer(dwp, ok)).toBe(true);
    // A value spelling the option's own words is the option; any other value is read like any other words.
    expect(b.namedAnswer(dwp, { ...ok, value: 'direct-rent-payment', words: 'Direct rent payment direct-rent-payment Direct rent payment' })).toBe(true);
    expect(b.namedAnswer(dwp, { ...ok, value: 'submit-payment', words: 'Direct rent payment submit-payment Direct rent payment' })).toBe(false);
    expect(b.namedAnswer(dwp, { ...ok, option: 'Both direct rent payment and rent arrears', words: 'Both direct rent payment and rent arrears' })).toBe(false);
    expect(b.namedAnswer(dwp, { ...ok, option: 'Direct rent payment now', words: 'Direct rent payment now' })).toBe(false);
    expect(b.namedAnswer(dwp, { ...ok, words: ok.words + ' Submit' })).toBe(false);
    expect(b.namedAnswer(dwp, { ...ok, tick: false })).toBe(false);
    expect(b.namedAnswer('https://www.gov.uk/other', ok)).toBe(false);
    expect(b.namedAnswer('https://127.0.0.1.evil.example/', ok)).toBe(false);
    // The robot's own list names the DWP host exactly; a sub-domain of it is not the form.
    expect(b.namedAnswer('https://directpayment.universal-credit.service.gov.uk/questions/type-of-payment', ok)).toBe(true);
    expect(b.namedAnswer('https://x.directpayment.universal-credit.service.gov.uk/questions/type-of-payment', ok)).toBe(false);
  });
});

describe('the form card opens the robot window and nothing else, on trial or not', () => {
  const AD = `
ad = load_mod("ad", "agent-dispatch.py")
import agent_email_format as aef
CFV = "rec7aHLK1Q8fMLRXH"
CARD = "RENT FORM: direct rent payment form: Unit 9"
CARD_NOTES = "RENT FORM KEY: recFormTest000001:form:1\\nRENT SETUP KEY: recFormTest000001:form:1"
def view(name, notes, outcome="Approved as-is", agent=CFV, status="Today", tid="recCARD0000000001"):
    return {"fields": {ad.AF["name"]: name, ad.AF["notes"]: notes, ad.AF["approvalOutcome"]: outcome,
                       ad.AF["sentForApprovalBy"]: [agent], ad.AF["teamMember"]: [agent], ad.AF["status"]: status}, "id": tid}
def outcome_of(rec):
    ad.get_task = lambda tid: rec
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        ad.cmd_outcome(argparse.Namespace(task=rec["id"]))
    d = json.loads(buf.getvalue())
    return [d["approved"], d["formCard"], d["window"]]
`;
  it('outcome never reads a form card as approved; the window needs both marks, the lane\'s agent and an approval', () => {
    const r = py(AD + `
OTHER = "recOtherAgent0001"
rows = {
  "card": view(CARD, CARD_NOTES), "edits": view(CARD, CARD_NOTES, outcome="Approved with minor edits"),
  "changes": view(CARD, CARD_NOTES, outcome="Changes requested"), "none": view(CARD, CARD_NOTES, outcome=""),
  "renamed": view("A renamed card", CARD_NOTES), "noKey": view(CARD, "nothing"),
  "otherAgent": view(CARD, CARD_NOTES, agent=OTHER),
  "closed": view(CARD, CARD_NOTES, status="Completed"), "cancelled": view(CARD, CARD_NOTES, status="Cancelled"),
  "late": view("RENT LATE: Unit 9, rent due 1 Oct (reminder)", "RENT CHECK KEY: x:1"),
  "ordinary": view("Book the boiler service", "notes", agent=OTHER),
}
out = {k: outcome_of(v) for k, v in rows.items()}
# The trial ends when Kevin removes the agent from TRIAL_AGENTS: the form card's doors must not move.
aef.TRIAL_AGENTS.pop(CFV); ad.TRIAL_AGENTS = aef.TRIAL_AGENTS
out["cardAfterTrial"] = outcome_of(rows["card"])
out["lateAfterTrial"] = outcome_of(rows["late"])
print(json.dumps(out))`);
    expect(r).toEqual({
      card: [false, true, true], edits: [false, true, true], changes: [false, true, false], none: [false, true, false],
      renamed: [false, true, false], noKey: [false, true, false], otherAgent: [false, true, false],
      closed: [false, true, false], cancelled: [false, true, false],
      late: [false, false, false], ordinary: [true, false, false],
      cardAfterTrial: [false, true, true], lateAfterTrial: [true, false, false],
    });
  });

  it('the robot: the window opens for the approved card, and commit (which presses submit) refuses it, from the real outcome read', () => {
    const h = mkdtempSync(join(tmpdir(), 'od-card-'));
    // The robot calls `python3 <script> outcome <task>`: this script answers with the real cmd_outcome.
    const script = join(h, 'outcome.py');
    writeFileSync(script, PY + AD + `
rows = {"recCARD0000000001": view(CARD, CARD_NOTES), "recCARD0000000002": view(CARD, CARD_NOTES, outcome="Changes requested"),
        "recCARD0000000003": view("RENT LATE: Unit 9, rent due 1 Oct (reminder)", "RENT CHECK KEY: x:1")}
rec = rows[sys.argv[2]]
ad.get_task = lambda tid: rec
ad.cmd_outcome(argparse.Namespace(task=rec["id"]))
`);
    const env = { ...process.env, AGENT_OUTCOME_SCRIPT: script, AGENT_BROWSER_PROFILE_ROOT: join(h, 'profiles') };
    const plan = join(h, 'plan.json');
    writeFileSync(plan, JSON.stringify({ steps: [{ do: 'goto', url: 'https://directpayment.universal-credit.service.gov.uk/' }, { do: 'submit', selector: '#send' }],
      confirm: { selector: 'text=Application complete' } }));
    const commit = (task) => {
      try {
        execFileSync('node', [join(SCRIPTS, 'agent-browser.js'), 'commit', '--task', task, '--plan', plan, '--shot', join(h, 's.png')],
          { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
        return 'ran';
      } catch (e) { return String(e.stderr || e.message); }
    };
    const window = (task, opts) => {
      process.env.AGENT_OUTCOME_SCRIPT = script;
      try { b.assertApproved(task, opts); return 'ok'; } catch (e) { return String(e.message || e); } finally { delete process.env.AGENT_OUTCOME_SCRIPT; }
    };
    try {
      expect(commit('recCARD0000000001')).toMatch(/robot form card: only the Your turn window opens it/);
      expect(window('recCARD0000000001', { window: true })).toBe('ok');
      expect(window('recCARD0000000001')).toMatch(/robot form card/);
      expect(window('recCARD0000000002', { window: true })).toMatch(/not approved/);
      expect(window('recCARD0000000003', { window: true })).toMatch(/trial task/);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  }, 120000);

  it('the window command itself opens for the approved card and refuses the one sent back (real Chromium, the real outcome read)', async () => {
    expect(chromium, 'playwright-core is not installed').toBeTruthy();
    const h = mkdtempSync(join(tmpdir(), 'od-card-turn-'));
    const { mkdirSync } = await import('node:fs');
    const { spawn } = await import('node:child_process');
    mkdirSync(join(h, '.config', 'od', 'agent-browser', 'default'), { recursive: true });
    const plans = join(h, 'handover');
    mkdirSync(plans, { recursive: true });
    const script = join(h, 'outcome.py');
    writeFileSync(script, PY + AD + `
rows = {"recCARD0000000001": view(CARD, CARD_NOTES), "recCARD0000000002": view(CARD, CARD_NOTES, outcome="Changes requested")}
rec = rows[sys.argv[2]]
ad.get_task = lambda tid: rec
ad.cmd_outcome(argparse.Namespace(task=rec["id"]))
`);
    for (const t of ['recCARD0000000001', 'recCARD0000000002']) {
      writeFileSync(join(plans, t + '.json'), JSON.stringify({ why: 'send the form', site: 'test', steps: [{ do: 'goto', url: base }] }));
    }
    const env = { ...process.env, HOME: h, AGENT_BROWSER_SITES_FILE: SITES, AGENT_HANDOVER_DIR: plans, AGENT_OUTCOME_SCRIPT: script,
                  AGENT_HANDOVER_HEADLESS: '1', AGENT_HANDOVER_WAIT_MS: '1500', AGENT_HANDOVER_PAUSE_MS: '100' };
    const run = (task) => new Promise(res => {
      const c = spawn(process.execPath, [join(SCRIPTS, 'agent-browser.js'), 'handover', '--task', task], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      c.stdout.on('data', d => { out += d; });
      c.stderr.on('data', d => { err += d; });
      const t = setTimeout(() => c.kill('SIGKILL'), 60000);
      c.on('exit', code => { clearTimeout(t); res({ code, out, err }); });
    });
    try {
      const yes = await run('recCARD0000000001');
      expect(yes.code, yes.err).toBe(0);
      expect(JSON.parse(yes.out.trim().split('\n').pop())).toMatchObject({ mode: 'handover', task: 'recCARD0000000001', handedOver: true });
      const back = await run('recCARD0000000002');
      expect(back.code).not.toBe(0);
      expect(back.err).toMatch(/not approved \(Approval Outcome: Changes requested\)/);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  }, 120000);

  it('the sign-in app\'s own "finished" words, through the real unblock, read as Kevin sending the form (wording drift)', () => {
    const src = readFileSync(join(SCRIPTS, 'robot-signin.applescript'), 'utf8');
    const m = src.match(/agent-dispatch\.py unblock " & quoted form of taskId & " --evidence " & quoted form of \("([^"]*)" & theWhy & "([^"]*)"\)/);
    expect(m, 'the sign-in app no longer unblocks with --evidence the way this test reads it').toBeTruthy();
    const evidence = m[1] + 'send the form' + m[2];
    const r = py(AD + `
lb = load_mod("rnt", "rent_new_tenant.py")
OPEN = "[02 Oct 2026 10:00 — agent-dispatch] BLOCKER OPEN (KEVIN credential): type the code Fix: f [since 2026-10-02T09:00:00.000Z]"
rec = view(CARD, CARD_NOTES + "\\n\\n" + OPEN)
written = []
ad.get_task = lambda tid: rec
ad.patch_task = lambda tid, fields: written.append(fields[ad.AF["notes"]])
ad.ledger_append = lambda *a, **k: None
with contextlib.redirect_stdout(io.StringIO()):
    ad.cmd_unblock(argparse.Namespace(task=rec["id"], evidence=${JSON.stringify(evidence)}))
print(json.dumps({"sent": lb.kevin_sent(written[-1]), "open": lb.open_kevin_wall(written[-1])}))`);
    expect(r).toEqual({ sent: true, open: false });
    // And the app's "Not yet" note, read by lane B to tell a window he left from one he may have used.
    const lb = py(`print(json.dumps(load_mod("rnt3", "rent_new_tenant.py").KEVIN_NOT_DONE))`);
    expect(src).toContain(`--note " & quoted form of "${lb}.`);
  });

  it('the lessons job never turns a form card verdict into an agent rule, and never leaves it pending', () => {
    const r = py(AD + `
rec = view(CARD, CARD_NOTES, outcome="Rejected")
rec["fields"][ad.AF["approvalFeedback"]] = "Not this tenant"
rec["fields"]["Remember This"] = True
ad.pending_lessons = lambda: [rec]
ad.query_tasks = lambda *a, **k: [rec]
stamped, wrote = [], []
ad.patch_task = lambda tid, fields: stamped.append([tid, list(fields)])
ad.append_lesson_to_file = lambda *a, **k: wrote.append(a) or {}
ad.mirror_lesson_to_register = lambda *a, **k: wrote.append(a)
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = ad.cmd_lessons(argparse.Namespace())
out = json.loads(buf.getvalue())
print(json.dumps({"code": code, "formCards": out["formCards"], "written": out["written"], "wrote": len(wrote),
                  "stamped": stamped == [[rec["id"], [ad.AF["lessonWrittenAt"]]]]}))`);
    expect(r).toEqual({ code: 0, formCards: ['recCARD0000000001'], written: [], wrote: 0, stamped: true });
  });

  it('the Your turn button goes once the plan\'s answers have expired, as the window would refuse it', () => {
    const r = py(AD + `
ad.HANDOVER_DIR = tempfile.mkdtemp()
b = {"kind": "KEVIN"}
def ready(plan, today):
    json.dump(plan, open(os.path.join(ad.HANDOVER_DIR, "recCARD0000000001.json"), "w"))
    ad.today_london = lambda: today
    return ad.handover_ready("recCARD0000000001", b, "Approved as-is")
print(json.dumps([ready({"why": "x", "validUntil": "2026-10-24"}, "2026-10-24"), ready({"why": "x", "validUntil": "2026-10-24"}, "2026-10-25"),
                  ready({"why": "x"}, "2027-01-01")]))`);
    expect(r).toEqual([true, false, true]);
  });

  it('the pages score with the same rule: the shared module knows a form card by either mark, and its query clause matches the report\'s', () => {
    const A = require_(join(ROOT, 'js', 'agent-accuracy.js'));
    expect(A.isFormCard('RENT FORM: direct rent payment form: Unit 9', '')).toBe(true);
    expect(A.isFormCard('Renamed', 'x\nRENT FORM KEY: recX:form:1')).toBe(true);
    expect(A.isFormCard('RENT LATE: Unit 9, rent due 1 Oct (reminder)', 'RENT CHECK KEY: x')).toBe(false);
    const r = py(`
import agent_email_format as aef
ar = load_mod("ar2", "agent-accuracy-report.py")
print(json.dumps({"marks": aef.FORM_CARDS, "clause": ar.FORM_KEY_CLAUSE}))`);
    expect(A.FORM_CARD_MARKS).toEqual(r.marks);
    expect(', ' + A.FORM_CARD_CLAUSE).toBe(r.clause);
  });

  it('the accuracy report never scores a form card as the agent\'s draft', () => {
    const r = py(`
ar = load_mod("ar", "agent-accuracy-report.py")
def row(name, notes=None, outcome="Approved as-is"):
    f = {"Task Name": name, "Approval Outcome": outcome, "Sent For Approval By": ["rec7aHLK1Q8fMLRXH"], "Task Type": "Admin"}
    if notes is not None: f["Notes"] = notes
    return {"id": "recX", "fields": f}
got = ar.decisions_from([row("RENT FORM: direct rent payment form: Unit 9"), row("Renamed", "RENT FORM KEY: x:form:1", "Rejected"),
                         row("RENT LATE: Unit 9, rent due 1 Oct (reminder)")])
print(json.dumps({"names": [d["outcome"] for d in got], "clause": ar.FORM_KEY_CLAUSE}))`);
    expect(r.names).toEqual(['Approved as-is']);
    // The query leaves out a card known only by its key line (the Notes are not fetched for every task).
    expect(r.clause).toBe(", NOT(FIND('RENT FORM KEY: ', {Notes}&''))");
  });

  it('the queue lists every form card apart, whatever its outcome, and trial-settle never closes one', () => {
    const r = py(AD + `
cards = [view(CARD, CARD_NOTES, tid="recCARD000000000A"), view(CARD, CARD_NOTES, outcome="Changes requested", tid="recCARD000000000B"),
         view(CARD, CARD_NOTES, outcome="", status="To do", tid="recCARD000000000C"), view("A renamed card", CARD_NOTES, outcome="", tid="recCARD000000000D")]
late = view("RENT LATE: Unit 9, rent due 1 Oct (reminder)", "RENT CHECK KEY: x:1", tid="recLATE0000000001")
ad.query_tasks = lambda *a, **k: cards + [late]
settled = [t["id"] for t in ad.trial_approved_tasks()]
print(json.dumps({"settled": settled, "isCard": [aef.form_card(ad.task_view(c)["name"], ad.task_view(c)["notes"]) for c in cards]}))`);
    expect(r.settled).toEqual(['recLATE0000000001']);
    expect(r.isCard).toEqual([true, true, true, true]);
  });

  it('send, notify and handover still refuse the card on trial: it is mailed to nobody', () => {
    const r = py(AD + `
print(json.dumps({"trialForEveryOtherDoor": bool(aef.trial_problem([CFV], CARD, CARD_NOTES)),
                  "formMarksMatchLaneB": [load_mod("rnt", "rent_new_tenant.py").FORM_PREFIX, load_mod("rnt2", "rent_new_tenant.py").FORM_KEY_MARK],
                  "marks": aef.FORM_CARDS[CFV], "taskManager": load_mod("tm", "task-manager.py").FORM_CARD_MARKS}))`);
    // send-email.py, notify, handover, letters and the diary all ask trial_problem(): it still names the card.
    expect(r.trialForEveryOtherDoor).toBe(true);
    expect(r.formMarksMatchLaneB).toEqual([r.marks.prefix, r.marks.note]);
    expect(r.taskManager).toEqual({ rec7aHLK1Q8fMLRXH: r.marks });
  });
});

describe('the rent check raises the card, and finishes it once Kevin says he sent it', () => {
  const RC = `
rc = load_mod("rc", "rent-check.py")
lb = rc.lane_b_rules
posts, patches, comments, submitted = [], [], [], []
RECORDS = {
  "recFormTest000001": {rc.TY["rent"]: 900.0, "fld5O24mC8vOezjXK": "Monthly", rc.TY["tenants"]: ["recFormTest000002"], "fld7cjLLEHKAx49OK": ["recFormTest000004"], rc.TY["payStatus"]: "CFV"},
  "recFormTest000002": {"fldxBKW7QnujSDWqA": "Sam Sample", "fldv7FKsqXYswyCFE": "1980-03-07"},
  "recFormTest000004": {"fldUJNRGgzgyAwwjt": ["recFormTest000003"]},
  "recFormTest000003": {"fldy2t735TV5e1DIL": "1 Example Road, Exampleton, EX1 2MP", "fld6ebSQgD7eRsobd": "EX1 2MP", "fldYLRz2GgVojKaq9": "Exampleton"},
}
FAIL_SUBMIT, FAIL_PATCH, FAIL_COMMENT, FAIL_TENANCY = [], [], [], []
def api(method, path, payload=None, params=None):
    if method == "POST" and path.endswith("/comments"):
        if FAIL_COMMENT: FAIL_COMMENT.pop(); raise RuntimeError("Airtable comment 500")
        comments.append([path, payload["text"]]); return {}
    if method == "POST":
        posts.append(payload["records"][0]["fields"]); tid = "recNEWCARD%07d" % len(posts)
        RECORDS[tid] = dict(payload["records"][0]["fields"]); return {"records": [{"id": tid}]}
    if method == "PATCH":
        rec = payload["records"][0]
        if FAIL_PATCH: FAIL_PATCH.pop(); raise RuntimeError("Airtable PATCH 503")
        if FAIL_TENANCY and path == rc.T_TENANCIES: FAIL_TENANCY.pop(); raise RuntimeError("Airtable tenancy 422")
        patches.append(rec); RECORDS.setdefault(rec["id"], {}).update(rec["fields"]); return {}
    wanted = re.search(r"RECORD_ID\\(\\)='(rec\\w+)'", params["filterByFormula"]).group(1)
    return {"records": [{"id": wanted, "fields": RECORDS[wanted]}] if wanted in RECORDS else []}
rc.api = api
HANDOVER = tempfile.mkdtemp()
CARD_MODES, CARD_TEXTS = [], []
REAL_AD = load_mod("real_ad", "agent-dispatch.py")
class FakeAd:
    HANDOVER_DIR = HANDOVER
    task_blocker = staticmethod(REAL_AD.task_blocker)
    blocker_note = staticmethod(REAL_AD.blocker_note)
    BLOCKER_CLEARED_MARK = REAL_AD.BLOCKER_CLEARED_MARK
    def cmd_submit(self, args):
        CARD_MODES.append(oct(os.stat(args.output_file).st_mode)[-3:])
        text = open(args.output_file).read()
        CARD_TEXTS.extend(text.splitlines())
        if FAIL_SUBMIT: raise SystemExit("ERROR: refusing to submit: " + FAIL_SUBMIT[0])
        submitted.append({"task": args.task, "agent": args.agent, "type": args.type, "kevin": "KEVIN ONLY: credential:" in text, "plain": args.plain_task})
        print(json.dumps({"submitted": args.task}))
lb.module = lambda key: FakeAd()
lb.ROBOT_LOG = os.path.join(HANDOVER, "runs.jsonl")        # never the real robot log
LANDLORD_FILE = os.path.join(HANDOVER, "landlord.json")
json.dump(LANDLORD, open(LANDLORD_FILE, "w"))
lb.LANDLORD_PATH = LANDLORD_FILE
ITEM = {"kind": "form", "key": "recFormTest000001:form:1", "tenancy": "recFormTest000001", "tenants": ["recFormTest000002"],
        "name": "RENT FORM: direct rent payment form: Unit 9", "label": "form card: Unit 9", "due": date(2026, 10, 3),
        "place": "Unit 9", "tenant": "Sam Sample", "royWords": "Yes, verified", "royDay": "2 Oct 2026",
        "notes": "RENT FORM KEY: recFormTest000001:form:1\\nRENT SETUP KEY: recFormTest000001:form:1"}
DAY = date(2026, 10, 3)
`;

  it('raises the card under the trial agent, puts the plan where Your turn finds it (private), and submits it with the Kevin-only step', () => {
    const r = py(RC + `
tid = lb.raise_one(rc._Here(), dict(ITEM, arrears=LOW), DAY)
plan_path = os.path.join(HANDOVER, tid + ".json")
print(json.dumps({"tid": tid, "owner": posts[0][rc.TK["teamMember"]], "name": posts[0][rc.TK["name"]], "notes": posts[0][rc.TK["notes"]],
                  "description": posts[0][rc.TK["description"]],
                  "plan": os.path.exists(plan_path), "mode": oct(os.stat(plan_path).st_mode)[-3:], "why": json.load(open(plan_path))["why"][:30],
                  "cardMode": CARD_MODES, "submitted": submitted, "cardFileLeft": os.path.exists(os.path.join(HANDOVER, tid + ".card.md"))}))`);
    expect(r.owner).toEqual(['rec7aHLK1Q8fMLRXH']);
    expect(r.name).toBe('RENT FORM: direct rent payment form: Unit 9');
    expect(r.notes).toMatch(/^RENT FORM KEY: recFormTest000001:form:1\nRENT SETUP KEY: recFormTest000001:form:1\nRENT FORM ANSWERS: [0-9a-f]{12}\nRENT FORM GOOD UNTIL: 2026-10-24$/);
    // The keys are in the Description too, so a Notes field cut at the front cannot lose them.
    expect(r.description).toContain('RENT FORM KEY: recFormTest000001:form:1\nRENT SETUP KEY: recFormTest000001:form:1');
    expect([r.plan, r.mode]).toEqual([true, '600']);
    // The card's words name the tenant: its file is the owner's alone while it exists.
    expect(r.cardMode).toEqual(['600']);
    expect(r.why).toBe('choose the reason this tenant ');
    expect(r.submitted).toEqual([{ task: r.tid, agent: 'rec7aHLK1Q8fMLRXH', type: 'Admin', kevin: true,
      plain: 'The DWP direct rent payment form for Sam Sample, filled from the records and waiting for you.' }]);
    expect(r.cardFileLeft).toBe(false);
  });

  it('a blank record raises nothing and is a note, not a failed run; a refused submit withdraws the card (keys kept, so the clock raises the next) and removes the plan', () => {
    const r = py(RC + `
RECORDS["recFormTest000002"]["fldv7FKsqXYswyCFE"] = None
try: lb.raise_one(rc._Here(), ITEM, DAY); blank = "raised"
except lb.NotReady as e: blank = str(e)
blank_posts = len(posts)
RECORDS["recFormTest000002"]["fldv7FKsqXYswyCFE"] = "1980-03-07"
FAIL_SUBMIT.append("its closing line hands the job to Kevin")
try: lb.raise_one(rc._Here(), ITEM, DAY); refused = "raised"
except RuntimeError as e: refused = str(e)
tid = "recNEWCARD%07d" % len(posts)
cancel = patches[-1]
# The withdrawal itself fails too: the card is left outside Kevin's queue, and the next run withdraws it.
FAIL_PATCH.append(1)
try: lb.raise_one(rc._Here(), ITEM, DAY); stranded = "raised"
except RuntimeError as e: stranded = str(e)
print(json.dumps({"blank": [blank, blank_posts], "refused": refused, "cancel": cancel, "plan": os.path.exists(os.path.join(HANDOVER, tid + ".json")),
                  "withdrawal": lb.withdrawal(cancel["fields"][rc.TK["notes"]]) and lb.withdrawal(cancel["fields"][rc.TK["notes"]])["why"],
                  "stranded": stranded}))`);
    expect(r.blank[0]).toBe("form card for Unit 9 not raised yet, blank: the tenant's date of birth (tenant record recFormTest000002)");
    expect(r.blank[1]).toBe(0);
    expect(r.refused).toMatch(/could not be submitted \(recNEWCARD0000001 withdrawn, the next run raises it again\)/);
    expect(r.cancel.fields.fldx4qCw17UfrKpaN).toBe('Cancelled');
    expect(r.cancel.fields.fldR7apBzSp3oxFxz).toMatch(/^RENT FORM KEY: recFormTest000001:form:1\nRENT SETUP KEY: recFormTest000001:form:1\n/);
    expect(r.withdrawal).toMatch(/^it could not be submitted to Kevin's queue: ERROR: refusing to submit/);
    expect(r.plan).toBe(false);
    expect(r.stranded).toMatch(/\(recNEWCARD0000002 and could not be withdrawn; the next run withdraws it and raises it again\)/);
  });

  it('the card text passes the real submit gates', () => {
    const r = py(RC + `
ad = load_mod("ad", "agent-dispatch.py")
ad.require_role_agent_live = lambda *a, **k: None
class Reached(Exception): pass
def stop(*a, **k): raise Reached("REACHED-THE-RECORD")
ad.get_task = stop; ad.query_tasks = stop; ad.load_login_sites = stop
lb.module = lambda key: ad
ad.HANDOVER_DIR = HANDOVER
def attempt(item=ITEM):
    try:
        lb.raise_one(rc._Here(), item, DAY); return "submitted"
    except RuntimeError as e:
        return str(e)
real = attempt()
again = attempt(dict(ITEM, arrears=HIGH, royWords="", prior={"on": date(2026, 9, 20), "feedback": "The rent is wrong", "print": "x"}))
# The control: the same card with its closing line handing the job over is refused by the gates.
import rent_form_plan
keep = rent_form_plan.card_text
rent_form_plan.card_text = lambda *a, **k: keep(*a, **k).replace("It never presses send.", "You will need to send it yourself.")
control = attempt()
print(json.dumps({"real": real, "again": again, "control": control}))`);
    // Every text gate passed, and submit went on to read the task (stubbed here to stop there).
    expect(r.real).toMatch(/\): REACHED-THE-RECORD$/);
    expect(r.again).toMatch(/\): REACHED-THE-RECORD$/);
    expect(r.control).toMatch(/hands the job to Kevin/);
  });

  it('the card goes all the way through the real submit, opens its Your turn step, and lane B then reads it as his, then as his turn', () => {
    const r = py(RC + `
ad = load_mod("ad", "agent-dispatch.py")
ad.HANDOVER_DIR = HANDOVER
lb.module = lambda key: ad
store = {}
# Both scripts key a task's fields by the same field ids, so one record serves both.
assert all(ad.AF[k] == rc.TK[k] for k in ("name", "notes", "status", "description"))
def get_task(tid): return {"id": tid, "fields": dict(RECORDS[tid])}
def patch_task(tid, fields): RECORDS[tid].update(fields)
ad.get_task = get_task; ad.patch_task = patch_task
ad.require_role_agent_live = lambda *a, **k: None
ad.supersede_attachments = lambda *a, **k: []
ad.upload_attachment = lambda *a, **k: None
ad.task_fields_owe_certificate = lambda *a, **k: False
def nope(*a, **k): raise RuntimeError("a test reached a real query")
ad.query_tasks = nope
tid = lb.raise_one(rc._Here(), dict(ITEM, arrears=LOW), DAY)
card = RECORDS[tid]
t = {"id": tid, "name": card[rc.TK["name"]], "notes": card[rc.TK["notes"]], "description": card[rc.TK["description"]],
     "status": card[rc.TK["status"]], "outcome": "", "n": 1, "step": "form", "made": datetime(2026, 10, 3, 9, tzinfo=timezone.utc),
     "created": DAY, "completed": None}
costs = {"id": "recROY", "name": "x", "notes": "", "description": "", "status": "Completed", "n": 1, "step": "costs",
         "made": datetime(2026, 9, 25, 9, tzinfo=timezone.utc), "created": date(2026, 9, 25), "completed": None}
before = lb.position({"costs": [costs], "form": [t]}, DAY, "CFV", {tid})
after = lb.position({"costs": [costs], "form": [dict(t, outcome="Approved as-is", status="Today")]}, DAY, "CFV", {tid})
print(json.dumps({"status": card[rc.TK["status"]], "wall": ad.task_blocker(card[rc.TK["notes"]]), "turn": lb.open_kevin_wall(card[rc.TK["notes"]]),
                  "before": before["short"], "after": after["short"], "ready": ad.handover_ready(tid, ad.task_blocker(card[rc.TK["notes"]]), "Approved as-is")}))`);
    expect(r.status).toBe('Approval');
    expect(r.wall.kind).toBe('KEVIN');
    expect(r.turn).toBe(true);
    expect([r.before, r.after]).toEqual(['form card with Kevin', 'your turn']);
    // And the Your turn button shows for it, its plan being on file and in date.
    expect(r.ready).toBe(true);
  });

  it('a card Kevin sent back for changes comes again only once an answer changes, or a week later, and quotes him', () => {
    const r = py(RC + `
import rent_form_plan
same = rent_form_plan.fingerprint(rent_form_plan.build({"id": "recFormTest000001", "rent": 900.0, "frequency": "Monthly"},
                                  {"id": "recFormTest000002", "name": "Sam Sample", "dob": "1980-03-07"},
                                  {"id": "recFormTest000003", "address": "1 Example Road, Exampleton, EX1 2MP", "postcode": "EX1 2MP", "area": "Exampleton"},
                                  LANDLORD, place="Unit 9", arrears=LOW)["answers"])
prior = {"on": date(2026, 10, 1), "feedback": "The rent is £850, not £900", "print": same}
item = dict(ITEM, key="recFormTest000001:form:2", arrears=LOW, prior=prior,
            notes="RENT FORM KEY: recFormTest000001:form:2\\nRENT SETUP KEY: recFormTest000001:form:2")
try: lb.raise_one(rc._Here(), item, DAY); unchanged = "raised"
except lb.NotReady as e: unchanged = str(e)
week = lb.raise_one(rc._Here(), item, date(2026, 10, 8))
RECORDS["recFormTest000001"][rc.TY["rent"]] = 850.0
fixed = lb.raise_one(rc._Here(), item, DAY)
print(json.dumps({"unchanged": unchanged, "raised": [week, fixed], "texts": [t for t in CARD_TEXTS if t.startswith("Last time")]}))`);
    expect(r.unchanged).toBe('form card for Unit 9 not raised again yet: Kevin asked for changes on 1 Oct and no answer read from '
      + 'the records has changed; it is raised again once one does, or on 8 Oct');
    expect(r.raised).toEqual(['recNEWCARD0000001', 'recNEWCARD0000002']);
    expect(r.texts).toEqual(Array(2).fill('Last time (1 Oct 2026) you asked for changes: "The rent is £850, not £900". The answers below are read from the records again.'));
  });

  it('withdrawing a card cancels it with the reason, clears its Your turn wall in the same write (as the dispatcher reads walls), and removes its plan; never a sent card', () => {
    const r = py(RC + `
ad = load_mod("ad", "agent-dispatch.py")
ad.HANDOVER_DIR = HANDOVER
lb.module = lambda key: ad
OPEN = "[02 Oct 2026 10:00 — agent-dispatch] BLOCKER OPEN (KEVIN credential): type the code Fix: f [since 2026-10-02T09:00:00.000Z]"
DONE = "[02 Oct 2026 14:00 — agent] BLOCKER CLEARED (KEVIN credential): x. evidence: Kevin finished his turn in the robot's window (send it), confirmed in the Robot sign-in app.. Carry on"
KEY = "RENT FORM KEY: recFormTest000001:form:1"
RECORDS["recCARD0000000001"] = {rc.TK["notes"]: KEY + "\\n\\n" + OPEN, rc.TK["status"]: "Today"}
open(os.path.join(HANDOVER, "recCARD0000000001.json"), "w").write("{}")
os.makedirs(os.path.join(HANDOVER, "done"), exist_ok=True)
for name in ("recCARD0000000001-20261003-1200.json", "recOTHER000000001-20261003-1200.json"):
    open(os.path.join(HANDOVER, "done", name), "w").write("{}")
os.makedirs(os.path.join(HANDOVER, "shots"), exist_ok=True)
for name in ("recCARD0000000001-1759490000000.png", "recOTHER000000001-1759490000000.png"):
    open(os.path.join(HANDOVER, "shots", name), "w").write("x")
item = {"id": "recCARD0000000001", "tenancy": "recFormTest000001", "why": 'Kevin asked for changes: "The rent is wrong"'}
first = lb.withdraw_form(rc._Here(), item, DAY)
notes = RECORDS["recCARD0000000001"][rc.TK["notes"]]
writes = len(patches)
again = lb.withdraw_form(rc._Here(), item, DAY)
RECORDS["recCARD0000000002"] = {rc.TK["notes"]: KEY + "\\n\\n" + OPEN + "\\n" + DONE, rc.TK["status"]: "Today"}
try: lb.withdraw_form(rc._Here(), dict(item, id="recCARD0000000002"), DAY); sent = "withdrawn"
except RuntimeError as e: sent = str(e)
SUPERSEDED = "[02 Oct 2026 14:00 — agent-dispatch] BLOCKER CLEARED (KEVIN credential): x. superseded: a new submission replaced the work that met this wall."
RECORDS["recCARD0000000004"] = {rc.TK["notes"]: KEY + "\\n\\n" + OPEN + "\\n" + SUPERSEDED, rc.TK["status"]: "Today"}
try: lb.withdraw_form(rc._Here(), dict(item, id="recCARD0000000004"), DAY); maybe = "withdrawn"
except RuntimeError as e: maybe = str(e)
RECORDS["recCARD0000000003"] = {rc.TK["notes"]: "", rc.TK["status"]: "Today"}
try: lb.withdraw_form(rc._Here(), dict(item, id="recCARD0000000003"), DAY); blank = "withdrawn"
except RuntimeError as e: blank = str(e)
print(json.dumps({"first": first, "writes": writes, "again": [again, len(patches)], "status": RECORDS["recCARD0000000001"][rc.TK["status"]],
                  "wallOpen": ad.task_blocker(notes), "turn": lb.open_kevin_wall(notes), "withdrawal": lb.withdrawal(notes)["why"],
                  "plan": os.path.exists(os.path.join(HANDOVER, "recCARD0000000001.json")), "sent": sent, "blank": blank, "maybe": maybe,
                  "filed": sorted(os.listdir(os.path.join(HANDOVER, "done"))), "shots": sorted(os.listdir(os.path.join(HANDOVER, "shots")))}))`);
    expect([r.first, r.writes]).toEqual([true, 1]);
    expect(r.again).toEqual([false, 1]);
    expect(r.status).toBe('Cancelled');
    // The dispatcher's own reader sees no open wall: the cancelled card never asks Kevin for a step.
    expect(r.wallOpen).toBeNull();
    expect(r.turn).toBe(false);
    expect(r.withdrawal).toBe('Kevin asked for changes: "The rent is wrong"');
    expect(r.plan).toBe(false);
    // The copy the sign-in app files under done/ holds the tenant's details too: gone, and only this card's.
    expect(r.filed).toEqual(['recOTHER000000001-20261003-1200.json']);
    // So do the window's screenshots.
    expect(r.shots).toEqual(['recOTHER000000001-1759490000000.png']);
    expect(r.sent).toMatch(/carries Kevin's word that he sent the form, so it is not withdrawn/);
    // Nor a card he may have sent (its step closed without the app's words).
    expect(r.maybe).toMatch(/never recorded whether Kevin sent the form, so it is not withdrawn/);
    expect(r.blank).toMatch(/blank Notes or no form key; nothing written/);
  });

  it('a closed card whose Your turn step is still open has the step cleared (as the dispatcher reads walls), and nothing else', () => {
    const r = py(RC + `
ad = load_mod("ad", "agent-dispatch.py")
lb.module = lambda key: ad
OPEN = "[02 Oct 2026 10:00 — agent-dispatch] BLOCKER OPEN (KEVIN credential): type the code Fix: f [since 2026-10-02T09:00:00.000Z]"
KEY = "RENT FORM KEY: recFormTest000001:form:1"
RECORDS["recCARD0000000001"] = {rc.TK["notes"]: KEY + "\\n\\n" + OPEN, rc.TK["status"]: "Cancelled"}
RECORDS["recCARD0000000002"] = {rc.TK["notes"]: KEY + "\\n\\n" + OPEN, rc.TK["status"]: "Today"}
first = lb.clear_wall(rc._Here(), "recCARD0000000001", DAY)
again = lb.clear_wall(rc._Here(), "recCARD0000000001", DAY)
live = lb.clear_wall(rc._Here(), "recCARD0000000002", DAY)
notes = RECORDS["recCARD0000000001"][rc.TK["notes"]]
print(json.dumps({"written": [first, again, live, len(patches)], "status": RECORDS["recCARD0000000001"][rc.TK["status"]],
                  "wall": ad.task_blocker(notes), "sent": lb.kevin_sent(notes), "fields": sorted(patches[0]["fields"])}))`);
    expect(r.written).toEqual([true, false, false, 1]);
    expect(r.status).toBe('Cancelled');
    expect(r.wall).toBeNull();
    expect(r.sent).toBe(false);
    expect(r.fields).toEqual(['fldR7apBzSp3oxFxz']);
  });

  it('once Kevin says he sent it: the card is marked and completed, the tenancy gets one comment, then goes CFV to CFV Actioned; each step once, and a failed step is retried without a second comment', () => {
    const r = py(RC + `
DONE = "[02 Oct 2026 14:00 — agent] BLOCKER CLEARED (KEVIN credential): x. evidence: Kevin finished his turn in the robot's window (send it), confirmed in the Robot sign-in app.. Carry on"
KEY = "RENT FORM KEY: recFormTest000001:form:1"
ITEM1 = {"id": "recCARD0000000001", "tenancy": "recFormTest000001"}
RECORDS["recCARD0000000001"] = {rc.TK["notes"]: KEY + "\\n\\n" + DONE, rc.TK["status"]: "Today"}
open(os.path.join(HANDOVER, "recCARD0000000001.json"), "w").write("{}")
first = lb.finish_form(rc._Here(), ITEM1, DAY)
order = [("card" if p["id"].startswith("recCARD") else "tenancy") for p in patches]
once = [len(patches), len(comments)]
again = lb.finish_form(rc._Here(), ITEM1, DAY)
after_again = [len(patches), len(comments)]
# The comment fails: nothing on the tenancy moves, and the next run writes it once, then the status.
RECORDS["recFormTest000001"][rc.TY["payStatus"]] = "CFV"
RECORDS["recCARD0000000004"] = {rc.TK["notes"]: KEY + "\\n\\n" + DONE, rc.TK["status"]: "Today"}
FAIL_COMMENT.append(1)
try: lb.finish_form(rc._Here(), dict(ITEM1, id="recCARD0000000004"), DAY); failed = "ok"
except RuntimeError as e: failed = str(e)
mid = RECORDS["recFormTest000001"][rc.TY["payStatus"]]
retry = lb.finish_form(rc._Here(), dict(ITEM1, id="recCARD0000000004"), DAY)
retry_comments = len(comments)
# The status change fails after the comment: the retry changes it with no second comment.
RECORDS["recFormTest000001"][rc.TY["payStatus"]] = "CFV"
RECORDS["recCARD0000000005"] = {rc.TK["notes"]: KEY + "\\n\\n" + DONE, rc.TK["status"]: "Today"}
FAIL_TENANCY.append(1)
try: lb.finish_form(rc._Here(), dict(ITEM1, id="recCARD0000000005"), DAY); flip = "ok"
except RuntimeError as e: flip = str(e)
before = len(comments)
flipped = [lb.finish_form(rc._Here(), dict(ITEM1, id="recCARD0000000005"), DAY), len(comments) - before]
# Set back to CFV by somebody after the rent check marked it: finish_form never flips it again.
RECORDS["recFormTest000001"][rc.TY["payStatus"]] = "CFV"
before_back = len(patches)
set_back = lb.finish_form(rc._Here(), ITEM1, DAY)
set_back = [set_back, len(patches) - before_back]
# Somebody already moved the tenancy on: the comment says so, and its status is left alone.
RECORDS["recFormTest000001"][rc.TY["payStatus"]] = "In Payment"
RECORDS["recCARD0000000002"] = {rc.TK["notes"]: KEY + "\\n\\n" + DONE, rc.TK["status"]: "Today"}
moved = lb.finish_form(rc._Here(), dict(ITEM1, id="recCARD0000000002"), DAY)
RECORDS["recCARD0000000007"] = {rc.TK["notes"]: KEY + "\\n\\n" + DONE, rc.TK["status"]: "Cancelled"}
lb.finish_form(rc._Here(), dict(ITEM1, id="recCARD0000000007"), DAY)
kept_cancelled = [RECORDS["recCARD0000000007"][rc.TK["status"]], "RENT FORM SENT:" in RECORDS["recCARD0000000007"][rc.TK["notes"]]]
RECORDS["recCARD0000000003"] = {rc.TK["notes"]: KEY, rc.TK["status"]: "Today"}
try: lb.finish_form(rc._Here(), dict(ITEM1, id="recCARD0000000003"), DAY); unsent = "wrote"
except RuntimeError as e: unsent = str(e)
RECORDS["recCARD0000000006"] = {rc.TK["notes"]: "", rc.TK["status"]: "Today"}
try: lb.finish_form(rc._Here(), dict(ITEM1, id="recCARD0000000006"), DAY); blank = "wrote"
except RuntimeError as e: blank = str(e)
print(json.dumps({"first": first, "order": order, "once": once, "again": again, "afterAgain": after_again,
                  "card": RECORDS["recCARD0000000001"], "comment": comments[0], "plan": os.path.exists(os.path.join(HANDOVER, "recCARD0000000001.json")),
                  "failed": failed, "mid": mid, "retry": retry, "retryComments": retry_comments, "flip": flip, "flipped": flipped,
                  "moved": moved, "movedComment": comments[-1][1], "unsent": unsent, "blank": blank, "setBack": set_back, "keptCancelled": kept_cancelled}))`);
    expect(r.first).toBe('CFV Actioned');
    // Card marked, comment, card marked COMMENTED, the tenancy, then card marked ACTIONED: the comment
    // always comes before the status, and the status is changed once.
    expect(r.order).toEqual(['card', 'card', 'tenancy', 'card']);
    expect(r.once).toEqual([4, 1]);
    // Done twice: nothing more is written.
    expect(r.again).toBe('CFV Actioned');
    expect(r.afterAgain).toEqual([4, 1]);
    expect(r.card.fldx4qCw17UfrKpaN).toBe('Completed');
    expect(r.card.fldR7apBzSp3oxFxz).toMatch(/RENT FORM SENT: Kevin confirmed in the Robot sign-in app that he sent the form/);
    expect(r.card.fldR7apBzSp3oxFxz).toMatch(/RENT FORM COMMENTED: tenancy recFormTest000001, 3 Oct 2026\nRENT FORM ACTIONED: tenancy recFormTest000001, 3 Oct 2026$/);
    expect(r.plan).toBe(false);
    expect(r.comment[0]).toBe('tblN51a88qTDB6iMH/recFormTest000001/comments');
    expect(r.comment[1]).toMatch(/^Direct rent payment form sent to the DWP by Kevin \(3 Oct 2026, form card recCARD0000000001\)\. Marked CFV Actioned/);
    expect(r.failed).toMatch(/comment 500/);
    expect(r.mid).toBe('CFV');
    expect([r.retry, r.retryComments]).toEqual(['CFV Actioned', 2]);
    expect(r.flip).toMatch(/tenancy 422/);
    expect(r.flipped).toEqual(['CFV Actioned', 0]);
    expect(r.setBack).toEqual(['CFV', 0]);
    // Kevin cancelled the card by hand after sending: it records the send and stays cancelled.
    expect(r.keptCancelled).toEqual(['Cancelled', true]);
    expect(r.moved).toBe('In Payment');
    expect(r.movedComment).toMatch(/The tenancy reads 'In Payment', so the rent check left its status as it is\.$/);
    // Only Kevin's own word that he sent it finishes a card.
    expect(r.unsent).toMatch(/does not carry Kevin's word that he sent the form; nothing written/);
    expect(r.blank).toMatch(/blank Notes or no form key; nothing written/);
  });
});
