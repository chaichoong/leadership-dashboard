import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as C from '../workers/property-manager/compute.mjs';
import { F, REC, TABLES, PNL_SECTIONS, MAINT_TARGET_GBP, WAGES_TARGET_GBP, ROY_EMAIL } from '../workers/property-manager/fields.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configSrc = readFileSync(resolve(ROOT, 'js/config.js'), 'utf8');
const tasksSrc = readFileSync(resolve(ROOT, 'os/tasks/index.html'), 'utf8');
const pnlSrc = readFileSync(resolve(ROOT, 'js/pnl.js'), 'utf8');
const TODAY = new Date(2026, 8, 8); // 8 Sep 2026
const rec = (id, fields) => ({ id, fields });

// ── The Worker's field copy must never drift from the browser's ──────────────
// A Worker cannot read js/config.js, so it carries its own IDs. A wrong ID does
// not error in Airtable: the field simply comes back undefined and every figure
// built on it reads zero. This pins each copy to the browser source.
describe('field IDs mirror the browser single source', () => {
  it('every field ID exists in js/config.js or os/tasks/index.html', () => {
    const missing = Object.entries(F).filter(([, id]) => !configSrc.includes(id) && !tasksSrc.includes(id)).map(([k]) => k);
    expect(missing).toEqual([]);
  });
  it('table IDs and pinned records match config.js', () => {
    for (const id of Object.values(TABLES)) expect(configSrc).toContain(id);
    for (const [k, id] of Object.entries(REC)) if (k !== 'roy' && k !== 'bizRealEstate') expect(configSrc).toContain(id);
    expect(configSrc).toContain(ROY_EMAIL);
  });
  it('budgets and the P&L allow-list match the browser copies', () => {
    expect(configSrc).toMatch(new RegExp(`MAINT_TARGET_GBP = ${MAINT_TARGET_GBP};`));
    expect(configSrc).toMatch(new RegExp(`WAGES_TARGET_GBP = ${WAGES_TARGET_GBP};`));
    for (const sec of PNL_SECTIONS) for (const s of sec.subs) expect(pnlSrc).toContain(`'${s}'`);
    // and nothing in pnl.js is missing from ours
    const browserSubs = [...pnlSrc.matchAll(/^\s+'([^']+)',\s*$/gm)].map(m => m[1]);
    const ours = new Set(PNL_SECTIONS.flatMap(s => s.subs));
    for (const s of browserSubs) if (/^(Fixed|Variable|Rental|COGS|Opex|Marketing|Premises|Insurance|Software|Professional|Travel|Operational|Subsistence|Director|Charity|Mortgage|Loan|Bank|Tax)/.test(s)) expect(ours.has(s)).toBe(true);
  });
});

// ── The personal strip ───────────────────────────────────────────────────────
describe('running costs strip personal money', () => {
  const coa = { subP: 'Personal Household Essentials', subRE: 'Insurance', catP: 'Personal Expense Not Deductible', catRE: 'Operating Expenses' };
  const active = (extra) => rec('c', { [F.costPayStatus]: 'In Payment', [F.costExpected]: 100, ...extra });
  it('keeps a Real Estate cost and a blank-business cost', () => {
    expect(C.classifyCost(active({ [F.costBusiness]: [REC.bizRealEstate], [F.costSubCategory]: ['subRE'] }), coa)).toBe('property');
    expect(C.classifyCost(active({ [F.costSubCategory]: ['subRE'] }), coa)).toBe('property');
  });
  it('drops Personal by business link, by sub-category prefix, and by category prefix', () => {
    expect(C.classifyCost(active({ [F.costBusiness]: [REC.bizPersonal] }), coa)).toBe('personal');
    expect(C.classifyCost(active({ [F.costSubCategory]: ['subP'] }), coa)).toBe('personal');
    expect(C.classifyCost(active({ [F.costCategory]: ['catP'] }), coa)).toBe('personal');
  });
  it('drops another business (Operations Director) and inactive rows', () => {
    expect(C.classifyCost(active({ [F.costBusiness]: ['recOD'] }), coa)).toBe('other-business');
    expect(C.classifyCost(rec('c', { [F.costPayStatus]: 'Paused', [F.costExpected]: 100 }), coa)).toBe('inactive');
    expect(C.classifyCost(rec('c', { [F.costPayStatus]: 'In Payment', [F.costInactive]: true }), coa)).toBe('inactive');
  });
  it('totals only the property costs and reports what it excluded', () => {
    const r = C.runningCosts([
      active({ [F.costBusiness]: [REC.bizRealEstate] }),
      active({ [F.costBusiness]: [REC.bizPersonal], [F.costExpected]: 55.5 }),
      active({ [F.costBusiness]: ['recOD'], [F.costExpected]: 9 }),
    ], coa);
    expect(r.total).toBe(100);
    expect(r.count).toBe(1);
    expect(r.excluded).toEqual({ personal: 1, personalGbp: 55.5, otherBusiness: 1, otherBusinessGbp: 9 });
  });
  it('word boundary: "Personalisation" is not personal', () => {
    expect(C.isPersonalCoaName('Personalisation Software')).toBe(false);
    expect(C.isPersonalCoaName('Personal Health')).toBe(true);
  });
});

// ── Tenancies ────────────────────────────────────────────────────────────────
describe('tenancy metrics', () => {
  const t = (id, status, rent, extra = {}) => rec(id, { [F.tenPayStatus]: status, [F.tenRent]: rent, [F.tenStatus]: ['Active'], [F.tenSurname]: id, ...extra });
  it('excludes Former tenants and ended tenancies even when In Payment', () => {
    const m = C.tenancyMetrics([
      t('a', 'In Payment', 500),
      t('b', 'In Payment', 500, { [F.tenStatus]: ['Former'] }),
      t('c', 'In Payment', 500, { [F.tenEndDate]: '2026-09-01' }),
      t('d', 'CFV', 400),
      t('e', 'CFV Actioned', 300),
    ], TODAY);
    expect(m.active).toBe(3);
    expect(m.inPayment).toBe(1);
    expect(m.behind).toBe(2);
    expect(m.exposure).toBe(700);
    expect(m.expectedRent).toBe(800); // In Payment + CFV Actioned, never plain CFV
    expect(m.behindList.map(r => r.tenant)).toEqual(['d', 'e']);
  });
});

// ── Rent due ─────────────────────────────────────────────────────────────────
describe('rent due next 31 days', () => {
  const t = (id, extra) => rec(id, { [F.tenPayStatus]: 'In Payment', [F.tenRent]: 600, [F.tenStatus]: ['Active'], [F.tenSurname]: id, [F.tenPayFreq]: 'Monthly', ...extra });
  it('uses the Airtable next-due anchor and marks a paid month', () => {
    const r = C.rentDue([t('a', { [F.tenNextDueDate]: '2026-09-22', [F.tenPaidThisMonth]: 1 })], [], TODAY);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ due: '2026-09-22', paid: true, amount: 600 });
    expect(r.total).toBe(600);
  });
  it('steps a past anchor forward and a weekly tenancy many times', () => {
    const r = C.rentDue([t('w', { [F.tenNextDueDate]: '2026-09-01', [F.tenPayFreq]: 'Weekly', [F.tenRent]: 100 })], [], TODAY);
    expect(r.rows.map(x => x.due)).toEqual(['2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29', '2026-10-06']);
  });
  it('flags Universal Credit through the linked tenant and skips plain CFV', () => {
    const r = C.rentDue([
      t('u', { [F.tenNextDueDate]: '2026-09-10', [F.tenLinkedTenant]: ['tenUC'] }),
      t('c', { [F.tenNextDueDate]: '2026-09-10', [F.tenPayStatus]: 'CFV' }),
    ], [rec('tenUC', { [F.tenantPayType]: 'Universal Credit' })], TODAY);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].isUC).toBe(true);
  });
});

// ── Transactions ─────────────────────────────────────────────────────────────
describe('last 31 days and profit by property', () => {
  const subs = [rec('sRent', { [F.subCatName]: 'Rental Income' }), rec('sMaint', { [F.subCatName]: 'COGS Property Reactive Maintenance' }), rec('sIns', { [F.subCatName]: 'Insurance' }), rec('sPers', { [F.subCatName]: 'Personal Travel' }), rec('sLab', { [F.subCatName]: 'Opex Labour' })];
  // REC ids are pinned records, so alias the fixture ids onto them
  subs[0].id = REC.subRentalInc; subs[1].id = REC.subMaint; subs[4].id = REC.subOpexLabour;
  const ctx = C.buildTxContext({
    properties: [rec('p1', { [F.propShortName]: '13 Chedburgh Place' })],
    tenancies: [rec('t1', { [F.tenProperty]: ['42 Elmdon Place'] })],
    units: [rec('u1', { [F.unitPropName]: ['5 Dalham Place'] })],
    subCategories: subs,
  });
  const tx = (date, amt, sub, links = {}) => rec('x' + Math.random(), { [F.txDate]: date, [F.txReportAmount]: amt, [F.txSubCategory]: [sub], ...links });
  const txs = [
    tx('2026-09-01', 800, REC.subRentalInc, { [F.txProperty]: ['p1'] }),
    tx('2026-08-20', -150, REC.subMaint, { [F.txTenancy]: ['t1'] }),
    tx('2026-08-15', -50, 'sIns', { [F.txUnit]: ['u1'] }),
    tx('2026-08-10', -70, 'sIns'),                 // whole-business cost → Unallocated
    tx('2026-08-12', -999, 'sPers'),               // not in the P&L allow-list → dropped
    tx('2026-07-01', 700, REC.subRentalInc, { [F.txProperty]: ['p1'] }), // outside 31 days, inside 3 months
    tx('2026-09-02', -200, REC.subOpexLabour),
  ];
  it('31-day window: rent, maintenance, wages and a simple profit', () => {
    const l = C.last31(txs, ctx, TODAY);
    expect(l.from).toBe('2026-08-09');
    expect(l).toMatchObject({ rentIn: 800, maintenance: 150, wages: 200, income: 800, costs: 470, profit: 330, txCount: 5 });
  });
  it('attributes via property, tenancy, then unit; whole-business costs sit on Unallocated', () => {
    const p = C.pnlByProperty(txs, ctx, 3, TODAY);
    const by = Object.fromEntries(p.rows.map(r => [r.property, r]));
    expect(by['13 Chedburgh Place']).toMatchObject({ rentIn: 1500, profit: 1500 });
    expect(by['42 Elmdon Place']).toMatchObject({ maintenance: 150, profit: -150 });
    expect(by['5 Dalham Place']).toMatchObject({ otherCosts: 50, profit: -50 });
    expect(by['Unallocated']).toMatchObject({ otherCosts: 270, profit: -270 });
    expect(p.total).toMatchObject({ rentIn: 1500, maintenance: 150, otherCosts: 320, profit: 1030 });
    expect(p.rows[p.rows.length - 1].property).toBe('Unallocated');
    // rows tie to the total
    const sum = p.rows.reduce((s, r) => s + r.profit, 0);
    expect(Math.round(sum * 100) / 100).toBe(p.total.profit);
  });
  it('month keys are trailing whole months including the current part-month', () => {
    expect(C.monthKeys(3, TODAY)).toEqual(['2026-07', '2026-08', '2026-09']);
  });
});

// ── Tasks: the scope guard ───────────────────────────────────────────────────
describe('Roy task scope', () => {
  it('in scope by assignee email, by Team Member link, or by Maintenance Ticket', () => {
    expect(C.isRoyScope(rec('a', { [F.taskAssignee]: { email: 'Roy.Lavin1978@gmail.com' } }))).toBe(true);
    expect(C.isRoyScope(rec('b', { [F.taskTeamMember]: [REC.roy] }))).toBe(true);
    expect(C.isRoyScope(rec('c', { [F.taskMaintenance]: true }))).toBe(true);
  });
  it('out of scope: Kevin\'s own task, a content task, an agent task', () => {
    expect(C.isRoyScope(rec('d', { [F.taskAssignee]: { email: 'kevin@runpreneur.org.uk' } }))).toBe(false);
    expect(C.isRoyScope(rec('e', { [F.taskTeamMember]: ['recSomeAgent'] }))).toBe(false);
    expect(C.isRoyScope(rec('f', {}))).toBe(false);
  });
  it('shapes only open tasks, overdue first, and marks which are his', () => {
    const list = C.shapeTasks([
      rec('1', { [F.taskName]: 'Late', [F.taskStatus]: 'Today', [F.taskDueDate]: '2026-09-01', [F.taskMaintenance]: true }),
      rec('2', { [F.taskName]: 'Mine', [F.taskStatus]: 'Upcoming', [F.taskDueDate]: '2026-09-20', [F.taskAssignee]: { email: ROY_EMAIL }, [F.taskProperties]: ['p1'] }),
      rec('3', { [F.taskName]: 'Done', [F.taskStatus]: 'Completed', [F.taskMaintenance]: true }),
      rec('4', { [F.taskName]: 'Cancelled', [F.taskStatus]: 'Cancelled', [F.taskMaintenance]: true }),
    ], { p1: '13 Chedburgh Place' }, TODAY);
    expect(list.map(t => t.name)).toEqual(['Late', 'Mine']);
    expect(list[0]).toMatchObject({ overdue: true, mine: false, maintenance: true });
    expect(list[1]).toMatchObject({ overdue: false, mine: true, properties: ['13 Chedburgh Place'] });
  });
  it('appendNote never overwrites and signs each line', () => {
    const now = new Date(2026, 8, 8, 14, 5);
    expect(C.appendNote('', 'first', 'Roy Lavin', now)).toBe('[2026-09-08 14:05 Roy Lavin] first');
    expect(C.appendNote('old line', ' second ', 'Kevin Brittain', now)).toBe('old line\n[2026-09-08 14:05 Kevin Brittain] second');
  });
});
