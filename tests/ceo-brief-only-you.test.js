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
  const names = ['KEVIN_TEAM_MEMBER', 'ONLY_YOU_SHOW', 'MONTHS', 'dayMonth', 'whenText', 'slackEsc',
    'selectOnlyYou', 'onlyYouText'];
  const src = names.map((n) => {
    const m = WORKER.match(new RegExp(`\\nfunction ${n}\\([\\s\\S]*?\\n\\}`))
      || WORKER.match(new RegExp(`\\nconst ${n} = [^\\n]*;`));
    if (!m) throw new Error(`${n} not found in money-daily-worker.js`);
    return m[0];
  }).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn { ${names.join(', ')} };`)();
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

// Inside the approval queue the name rule still decides: Kevin's holder link also sits on agent
// DECIDE cards there that are not his own to-dos (17 Sep 2026).
const card = (name, due, extra = {}) => kevin(name, due, { status: 'Approval', ...extra });

describe('outside the queue, every due task Kevin holds counts (widened 23 Sep 2026)', () => {
  it('the tasks the bank-and-signature rule used to drop now reach him', () => {
    const out = selectOnlyYou(NOT_ONLY_YOU, TODAY);
    expect(out.items.length + out.more).toBe(NOT_ONLY_YOU.length);
  });

  it('the two dated tasks from the 23 Sep audit are named, whatever their words', () => {
    const day = '2026-10-03';
    const out = selectOnlyYou([
      kevin('Reply to the adviser disengagement letter by 30 Sep', '2026-09-30'),
      kevin('Appoint a new adviser for the open check', day),
    ], day);
    expect(out.items.map(x => x.name)).toEqual([
      'Reply to the adviser disengagement letter by 30 Sep',
      'Appoint a new adviser for the open check',
    ]);
  });

  it('shows five and counts the rest', () => {
    const out = selectOnlyYou(NOT_ONLY_YOU, TODAY);
    expect(out.items).toHaveLength(5);
    expect(out.more).toBe(NOT_ONLY_YOU.length - 5);
  });

  it('a task already shown on the deadline list is not repeated here', () => {
    const a = kevin('Reply to the court', TODAY, { id: 'recA' });
    const b = kevin('Sign the lease', TODAY, { id: 'recB' });
    expect(selectOnlyYou([a, b], TODAY, new Set(['recA'])).items.map(x => x.name)).toEqual(['Sign the lease']);
  });
});

describe('inside the approval queue, only bank, payment and signature cards count', () => {
  it('keeps the banking cards and skips the rest', () => {
    const out = selectOnlyYou([...NOT_ONLY_YOU.map(x => ({ ...x, status: 'Approval' })),
      ...BANKING.map(x => ({ ...x, status: 'Approval' }))], TODAY);
    expect(out.items.length + out.more).toBe(BANKING.length);
    for (const x of out.items) expect(BANKING.map(b => b.name)).toContain(x.name);
  });

  it('every non-banking card Kevin holds is left out', () => {
    expect(selectOnlyYou(NOT_ONLY_YOU.map(x => ({ ...x, status: 'Approval' })), TODAY)).toEqual({ items: [], more: 0 });
  });

  it('a real signature counts in any tense', () => {
    const out = selectOnlyYou([
      card('Countersign the AST', TODAY),
      card('Signing the lease renewal', TODAY),
      card('Sign the deed of variation', TODAY),
      card('Kent Reliance-Complete with Docusign', TODAY),
    ], TODAY);
    expect(out.items.length + out.more).toBe(4);
  });

  it('payments Kevin makes still count when they mention arrears or a missed payment', () => {
    const out = selectOnlyYou([
      card('Pay Council Tax arrears - 13 CP', TODAY),
      card('Pay the balance owed to Anglian Water', TODAY),
      card('Pay missed credit card payment', TODAY),
      card('UPDATE SO - 5 DALHAM £147', TODAY),
      card('Update SO for 18 Northfield Park', TODAY),
    ], TODAY);
    expect(out.items.length + out.more).toBe(5);
  });
});

describe('selectOnlyYou, whichever side of the queue', () => {
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
  it('shows up to five lines and the remainder', () => {
    const text = onlyYouText(selectOnlyYou(BANKING, TODAY), TODAY);
    expect(text.startsWith('*ONLY YOU TODAY*\n')).toBe(true);
    expect(text.split('\n').filter(l => l.startsWith('• '))).toHaveLength(5);
    expect(text).toContain('(overdue since 4 Sep)');
    expect(text.endsWith('+1 more due')).toBe(true);
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
