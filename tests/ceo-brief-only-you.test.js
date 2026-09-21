import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = readFileSync(resolve(ROOT, 'scripts/slack-automation/money-daily-worker.js'), 'utf8');

// "Only you today" in the 09:00 CEO brief (Kevin, 17 Sep 2026: he stops using a task list;
// a bank change, a payment or a signature reaches him in the brief, due items only).
// The functions are read out of the worker as text, same as ceo-brief-schedule.test.js,
// so the test runs the shipped code rather than a copy of it.
function load() {
  const pick = (re, what) => {
    const m = WORKER.match(re);
    if (!m) throw new Error(`${what} not found in money-daily-worker.js`);
    return m[0];
  };
  const src = [
    pick(/const KEVIN_TEAM_MEMBER = '[^']+';/, 'KEVIN_TEAM_MEMBER'),
    pick(/function selectOnlyYou\([\s\S]*?\n\}/, 'selectOnlyYou'),
    pick(/function onlyYouText\([\s\S]*?\n\}/, 'onlyYouText'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn { selectOnlyYou, onlyYouText, KEVIN_TEAM_MEMBER };`)();
}

const { selectOnlyYou, onlyYouText, KEVIN_TEAM_MEMBER } = load();
const TODAY = '2026-09-17';
const kevin = (name, due, extra = {}) => ({ name, due, holders: [KEVIN_TEAM_MEMBER], deferred: '', ...extra });

// Real task names held by Kevin, read from Tasks tblqB8b22hKBL4PF1 on 17 Sep 2026.
const BANKING = [
  kevin('Set up Standing Order - Anglian Water payment plan - 32 EP , 28 CP on the 22nd of every month', '2026-09-04'),
  kevin('Update SO amount - 13 Chedburgh - £158 per month', '2026-09-04'),
  kevin('Pay Property Redress Membership', '2026-09-04'),
  kevin('Pay tax liability for tax return 2023/24- Jo Example', '2026-09-04'),
  kevin('Create SO - 4 Abington Council Tax - £190 per month', '2026-09-04'),
  kevin('Credit Card Payments - payments due 5th of the month', '2026-09-05'),
];
const NOT_ONLY_YOU = [
  kevin('INBOUND: POST [MEDIUM]: Birmingham Midshires (Bank of Scotland) - IO Mortgage EndTerm_15 Marloe', '2026-08-31'),
  kevin('Fit skirting boards in Theo\'s bedroom', '2026-07-10'),
  kevin('Buy an external SSD and switch on Time Machine for the MacBook Air (no backup exists today)', '2026-09-15'),
  kevin('SIGN-IN: EDF Energy session lapsed', '2026-09-16'),
  kevin('Debt recovery decision session — Monies Owed ledger (~£13k, 13 items)', '2026-09-04'),
  kevin('6. The offer is signable and payable', '2026-09-01'),
  // Review findings, 17 Sep 2026: a session is not a signature, an all-caps subject is not a
  // standing order, and money owed to Kevin is not a payment he makes.
  kevin('SIGN IN NEEDED: HMRC session lapsed', '2026-09-16'),
  kevin('Open your Property Manager dashboard and sign in', '2026-09-16'),
  kevin('Sign up for GHL trial', '2026-09-16'),
  kevin('INBOUND: EMAIL [HIGH]: WHY IS THIS TAKING SO LONG', '2026-09-16'),
  kevin('Chase tenant Lee Example for missed rent payment', '2026-09-16'),
  kevin('INBOUND: EMAIL [HIGH]: Re: WHY IS THIS TAKING SO LONG', '2026-09-16'),
  kevin('Sign into Zempler', '2026-09-16'),
  kevin('Five signs your business runs on you', '2026-09-16'),
  kevin('Order fire door signs', '2026-09-16'),
  kevin('INBOUND: Adobe Sign: agreement signed by Roy Lavin', '2026-09-16'),
  kevin('Email signature for Kevin Brittain', '2026-09-16'),
  kevin('Sign the robot browser into Facebook', '2026-09-16'),
  kevin('UC payment status (Pat Example)', '2026-09-16'),
];

describe('selectOnlyYou picks only bank, payment and signature items', () => {
  it('keeps the banking tasks and skips the rest', () => {
    const out = selectOnlyYou([...NOT_ONLY_YOU, ...BANKING], TODAY);
    expect(out.items).toHaveLength(3);
    expect(out.more).toBe(3);
    for (const x of out.items) expect(BANKING.map(b => b.name)).toContain(x.name);
  });

  it('every non-banking task Kevin holds is left out', () => {
    expect(selectOnlyYou(NOT_ONLY_YOU, TODAY)).toEqual({ items: [], more: 0 });
  });

  it('a real signature counts in any tense', () => {
    const out = selectOnlyYou([
      kevin('Countersign the AST', TODAY),
      kevin('Signing the lease renewal', TODAY),
      kevin('Sign the deed of variation', TODAY),
      kevin('Kent Reliance-Complete with Docusign', TODAY),
    ], TODAY);
    expect(out.items.length + out.more).toBe(4);
  });

  it('payments Kevin makes still count when they mention arrears or a missed payment', () => {
    const out = selectOnlyYou([
      kevin('Pay Council Tax arrears - 13 CP', TODAY),
      kevin('Pay the balance owed to Anglian Water', TODAY),
      kevin('Pay missed credit card payment', TODAY),
      kevin('UPDATE SO - 5 DALHAM £147', TODAY),
      kevin('Update SO for 18 Northfield Park', TODAY),
    ], TODAY);
    expect(out.items.length + out.more).toBe(5);
  });

  it('lists the oldest due first', () => {
    const out = selectOnlyYou([BANKING[5], BANKING[2]], TODAY);
    expect(out.items.map(x => x.due)).toEqual(['2026-09-04', '2026-09-05']);
  });

  it('a task someone else holds is not Kevin\'s, even with a payment in its name', () => {
    const roy = { name: 'Let Unit 1, 18 Siddows Avenue and get the tenant into payment', due: '2026-09-15', holders: ['rec1hYELb4zS8pjjO'], deferred: '' };
    expect(selectOnlyYou([roy], TODAY).items).toEqual([]);
  });

  it('not yet due, no due date, or deferred past today stays out', () => {
    const out = selectOnlyYou([
      kevin('Pay Final Council Tax Adjustment', '2026-09-18'),
      kevin('Pay Final Council Tax Adjustment', ''),
      kevin('Pay Final Council Tax Adjustment', '2026-09-04', { deferred: '2026-09-21' }),
    ], TODAY);
    expect(out).toEqual({ items: [], more: 0 });
  });

  it('due today and a deferral that has run out both count', () => {
    const out = selectOnlyYou([
      kevin('Sign the tenancy renewal', TODAY),
      kevin('Pay Final Council Tax Adjustment', '2026-09-04', { deferred: TODAY }),
    ], TODAY);
    expect(out.items).toHaveLength(2);
  });

  it('empty or missing input gives an empty list', () => {
    expect(selectOnlyYou([], TODAY)).toEqual({ items: [], more: 0 });
    expect(selectOnlyYou(undefined, TODAY)).toEqual({ items: [], more: 0 });
  });
});

describe('onlyYouText renders the section', () => {
  it('shows up to three lines and the remainder', () => {
    const text = onlyYouText(selectOnlyYou(BANKING, TODAY), TODAY);
    expect(text.startsWith('*ONLY YOU TODAY*\n')).toBe(true);
    expect(text.split('\n').filter(l => l.startsWith('• '))).toHaveLength(3);
    expect(text).toContain('(due 4 Sep)');
    expect(text.endsWith('+3 more due')).toBe(true);
  });

  it('says due today for today', () => {
    expect(onlyYouText({ items: [{ name: 'Sign the lease', due: TODAY }], more: 0 }, TODAY)).toContain('(due today)');
  });

  it('is empty when nothing is due, so the section is left out', () => {
    expect(onlyYouText({ items: [], more: 0 }, TODAY)).toBe('');
    expect(onlyYouText(undefined, TODAY)).toBe('');
  });

  it('escapes Slack control characters in a task name', () => {
    expect(onlyYouText({ items: [{ name: 'Pay A&B <urgent>', due: TODAY }], more: 0 }, TODAY))
      .toContain('Pay A&amp;B &lt;urgent&gt;');
  });
});

describe('the brief is wired to the section', () => {
  it('buildBriefBlocks renders it and both brief paths attach the list', () => {
    const build = WORKER.match(/function buildBriefBlocks\([\s\S]*?\n\}/)[0];
    expect(build).toContain('onlyYouText(brief.only_you');
    expect(WORKER.match(/brief\.only_you = tasks\.onlyYou;/g)).toHaveLength(2);
    expect(WORKER).toContain('onlyYou: selectOnlyYou(t, today)');
    expect(WORKER).toContain("'Team Member'");
  });
});
