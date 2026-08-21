import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Runs the REAL js/reconciliation.js (with js/config.js) in a sandbox, the way the
// replay harness did on 21 Aug 2026 when these lookups were calibrated. Pasting copies
// of the functions into the test would let them drift from the shipped code.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(resolve(root, f), 'utf8');

function sandbox() {
  const store = {};
  const ctx = {
    console,
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {}, createElement: () => ({ style: {} }) },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ records: [] }) }),
    setTimeout, clearTimeout, URL,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('js/config.js'), ctx, { filename: 'config.js' });
  vm.runInContext(`
    function getField(rec, id) { return rec?.fields?.[id]; }
    function getPaymentStatusName(f) { if (!f) return ''; if (typeof f === 'string') return f; if (f.name) return f.name; return String(f); }
    function isTenancyActive(s) { const n = getPaymentStatusName(s).trim().toLowerCase(); return ['in payment','cfv actioned','cfv'].includes(n); }
    function isCostActive(rec) { if (getField(rec, F.costInactive)) return false; const s = getPaymentStatusName(getField(rec, F.costPayStatus)); return s === 'In Payment' || s === 'Overdue'; }
    function buildTenantLookup() { const l = {}; allTenants.forEach(t => { l[t.id] = t; }); return l; }
    function getTenantForTenancy(t, lk) { const linked = getField(t, F.tenLinkedTenant); if (!linked) return null; const id = Array.isArray(linked) ? (typeof linked[0] === 'string' ? linked[0] : linked[0]?.id) : null; return id ? lk[id] : null; }
    function escHtml(s) { return String(s ?? ''); }
    function fmt(n) { return String(n); }
    function loadDashboard() {}
  `, ctx);
  vm.runInContext(process.env.RECON_SRC ? readFileSync(process.env.RECON_SRC, 'utf8') : read('js/reconciliation.js'), ctx, { filename: 'reconciliation.js' });
  // config.js declares F / REC / allTenancies… with const/let, so they live in the
  // context's lexical scope, not on the global object: read and assign them in-context.
  ctx.get = name => vm.runInContext(name, ctx);
  ctx.set = (name, value) => vm.runInContext(`${name} = ${JSON.stringify(value)};`, ctx);
  ctx.F = ctx.get('F');
  ctx.REC = ctx.get('REC');
  return ctx;
}

// ── Fixture: two properties sharing a street (needs the number), one unique street,
// one landlord tenant across five units, two tenants sharing a surname, three mortgages.
const P = { elm32: 'propElm32', elm42: 'propElm42', dalham: 'propDalham', duck: 'propDuck' };
const units = [
  ['u32_1', P.elm32, '32 Elmdon Place', 1], ['u32_2', P.elm32, '32 Elmdon Place', 2], ['u32_3', P.elm32, '32 Elmdon Place', 3],
  ['u32_4', P.elm32, '32 Elmdon Place', 4], ['u32_5', P.elm32, '32 Elmdon Place', 5],
  ['u42_1', P.elm42, '42 Elmdon Place', 1],
  ['uD_1', P.dalham, '5 Dalham Place', 1], ['uD_3', P.dalham, '5 Dalham Place', 3],
  ['uDk_3', P.duck, 'Duckworth Building', 3], ['uDk_9', P.duck, 'Duckworth Building', 9],
];
const tenants = [['tRoc', 'ROC IMMO LTD'], ['tWalker', 'Gary Walker'], ['tMartinM', 'Marilyn Martin'], ['tMartinA', 'Andrew Martin'], ['tIntus', 'Intus Lettings'], ['tLambert', 'Ryan Lambert'], ['tCheff', 'Cheffins']];
const tenancies = [
  ['ten32_1', 'tRoc', 'IMMO LTD', 'u32_1', 350], ['ten32_2', 'tRoc', 'IMMO LTD', 'u32_2', 350], ['ten32_3', 'tRoc', 'IMMO LTD', 'u32_3', 350],
  ['ten32_4', 'tRoc', 'IMMO LTD', 'u32_4', 350], ['ten32_5', 'tRoc', 'IMMO LTD', 'u32_5', 350],
  ['tenWalker', 'tWalker', 'Walker', 'u42_1', 524.6],
  ['tenMartinM', 'tMartinM', 'Martin', 'uD_1', 1296.45], ['tenMartinA', 'tMartinA', 'Martin', 'uD_3', 897.52],
  ['tenIntus3', 'tIntus', 'Lettings', 'uDk_3', 651], ['tenIntus9', 'tIntus', 'Lettings', 'uDk_9', 641.2],
  ['tenLambert', 'tLambert', 'Lambert', 'u42_1', 524.9],
  ['tenCheff', 'tCheff', 'Cheffins', 'uD_1', 1096.8],
];
const costs = [
  ['c32', 'Kent Reliance - 32EP - 70015544', P.elm32, 660.69, 'In Payment'],
  ['c42', 'Kent Reliance - 42EP - MOM0840079BRI1', P.elm42, 724.07, 'In Payment'],
  ['cBM', 'Birmingham Midshires - 5DP - 60922354580600', P.dalham, 223.33, 'In Payment'],
  ['cOld', 'Kent Reliance - OLD - 70099999', P.elm32, 500, 'Inactive'],
  ['cSwA', 'Swinton - Policy RSAP68 - Ref 85376969', P.dalham, 42.01, 'In Payment'],
  ['cSwB', 'Swinton - Policy BE26AC - Ref 168263862', P.dalham, 45.3, 'Overdue'],
];

function load(ctx) {
  const F = ctx.F;
  ctx.set('allRentalUnits', units.map(([id, prop, name, n]) => ({ id, fields: { [F.unitProperty]: [prop], [F.unitPropName]: [name], [F.unitNumber]: n } })));
  ctx.set('allTenants', tenants.map(([id, name]) => ({ id, fields: { [F.tenantName]: name } })));
  ctx.set('allTenancies', tenancies.map(([id, tenant, surname, unit, rent]) => ({ id, fields: {
    [F.tenLinkedTenant]: [tenant], [F.tenSurname]: [surname], [F.tenUnit]: [unit], [F.tenRent]: rent,
    [F.tenPayStatus]: 'In Payment', [F.tenRef]: `${surname.toUpperCase()} – ${unit}`, [F.tenUnitRef]: [unit],
  } })));
  ctx.set('allCosts', costs.map(([id, name, prop, expected, status]) => ({ id, fields: {
    [F.costName]: name, [F.costProperty]: [prop], [F.costExpected]: expected, [F.costPayStatus]: status,
    [F.costBusiness]: ['bizRE'], [F.costCategory]: ['catCogs'], [F.costSubCategory]: ['subMortgage'],
  } })));
  ctx.set('allBusinesses', [{ id: 'bizRE', fields: { fldbbRqVxLxUdHwIR: 'Real Estate' } }]);
  ctx.set('allCategories', [{ id: 'catRev', fields: { fldii4oUzSfmplihO: 'Revenue' } }, { id: 'catCogs', fields: { fldii4oUzSfmplihO: 'COGS' } }]);
  ctx.set('allSubCategories', [{ id: ctx.REC.subRentalInc, fields: { fldO4BTJhFv5EsN6i: 'Rental Income' } }, { id: 'subMortgage', fields: { fldO4BTJhFv5EsN6i: 'Mortgage Interest' } }]);
  ctx.set('allTransactions', []);
}

let ctx, idx;
beforeEach(() => { ctx = sandbox(); load(ctx); idx = ctx.buildDirectIndex(); });

describe('propertyNameParts', () => {
  it('derives the short code the cost names and landlord references use', () => {
    expect(ctx.propertyNameParts('5 Dalham Place')).toEqual({ number: '5', code: '5DP', words: ['DALHAM'] });
    expect(ctx.propertyNameParts('282 Stanley Park Avenue South').code).toBe('282SPAS');
    expect(ctx.propertyNameParts('1406 Oldham Road').code).toBe('1406OR');
    expect(ctx.propertyNameParts('57A West Street').code).toBe('57AWS');
  });
  it('treats a building with no number as words only, minus street types', () => {
    expect(ctx.propertyNameParts('Duckworth Building')).toEqual({ number: '', code: '', words: ['DUCKWORTH'] });
  });
});

describe('findPropertiesInText', () => {
  it('reads the short code, number + street, and a unique street word', () => {
    expect(ctx.findPropertiesInText('REF.32EP-LANDLORD-PAY FROM ROC IMMO LTD', idx)).toEqual([P.elm32]);
    expect(ctx.findPropertiesInText('Gary Marsh 5 Dalham', idx)).toEqual([P.dalham]);
    expect(ctx.findPropertiesInText('JOELIN LIMITED REFERENCE DUCKWORTH ELECTRIC', idx)).toEqual([P.duck]);
  });
  it('does not pick a property from a street word shared by several (ELMDON)', () => {
    expect(ctx.findPropertiesInText('GARY MARSH REFERENCE ELMDON', idx)).toEqual([]);
  });
  it('returns every property named, so callers can refuse an ambiguous one', () => {
    expect(ctx.findPropertiesInText('Gary Marsh 32 Elmdon 42 Elmdon', idx).sort()).toEqual([P.elm32, P.elm42].sort());
  });
});

describe('matchTenancyDirect', () => {
  it('finds a tenancy from the surname in a bank giro credit', () => {
    expect(ctx.matchTenancyDirect('BANK GIRO CREDIT REF WALKER, 000000003868222204', '', 524.6, idx)).toEqual({ tenancyId: 'tenWalker' });
  });
  it('never links an outgoing payment to a tenancy', () => {
    expect(ctx.matchTenancyDirect('BILL PAYMENT TO GARY WALKER REFERENCE 42 ELMDON', 'GARY WALKER', -90, idx)).toBeNull();
  });
  it('splits two tenants who share a surname by rent', () => {
    expect(ctx.matchTenancyDirect('BANK GIRO CREDIT REF MARTIN', '', 1296.45, idx)).toEqual({ tenancyId: 'tenMartinM' });
    expect(ctx.matchTenancyDirect('BANK GIRO CREDIT REF MARTIN', '', 897.52, idx)).toEqual({ tenancyId: 'tenMartinA' });
  });
  it('uses the apartment number in the descriptor, not the rent, to pick the unit', () => {
    // £641.20 is Apartment 9's rent, but the descriptor says Apartment 3.
    expect(ctx.matchTenancyDirect('INTUS LETTINGS LTDRENT APARTMENT 3', '', 641.2, idx)).toEqual({ tenancyId: 'tenIntus3' });
  });
  it('reads the split position as the unit when one landlord pays several units', () => {
    expect(ctx.matchTenancyDirect('FASTER PAYMENTS RECEIPT REF.32EP-LANDLORD-PAY FROM ROC IMMO LTD -- ROC IMMO LTD (Split 4 of 5)', 'ROC IMMO LTD', 382.7, idx)).toEqual({ tenancyId: 'ten32_4' });
  });
  it('returns the candidates, not a guess, when the tenant is known but the unit is not', () => {
    const m = ctx.matchTenancyDirect('FASTER PAYMENTS RECEIPT REF.32EP-LANDLORD FROM ROC IMMO LTD', 'ROC IMMO LTD', 1750, idx);
    expect(m.tenancyId).toBeUndefined();
    expect(m.candidates.sort()).toEqual(['ten32_1', 'ten32_2', 'ten32_3', 'ten32_4', 'ten32_5']);
  });
  it('copes with the bank truncating the name', () => {
    expect(ctx.matchTenancyDirect('BANK GIRO CREDIT REF CHEFF ELY CLIENT, .', '', 1096.8, idx)).toEqual({ tenancyId: 'tenCheff' });
  });
  it('finds nothing when no active tenant is named', () => {
    expect(ctx.matchTenancyDirect('BANK GIRO CREDIT REF SERCO LIMITED, S10115028210222026', '', 320, idx)).toBeNull();
  });
});

describe('matchCostDirect', () => {
  it('finds the mortgage from the account number the cost is named after, with no history', () => {
    expect(ctx.matchCostDirect('DIRECT DEBIT PAYMENT TO ONESAVINGS BANK REF 70015544, MANDATE NO 0111', -660.69, idx, {})).toBe('c32');
    expect(ctx.matchCostDirect('DIRECT DEBIT PAYMENT TO KENT RELIANCE IP REF MOM0840079BRI1, MANDATE NO 0153', -724.07, idx, {})).toBe('c42');
  });
  it('accepts a bank-padded account number', () => {
    expect(ctx.matchCostDirect('DIRECT DEBIT PAYMENT TO BHAM MIDSHIRES REF 6092235458060000, MANDATE NO 0166', -223.33, idx, {})).toBe('cBM');
  });
  it('never proposes an inactive cost', () => {
    expect(ctx.matchCostDirect('DIRECT DEBIT PAYMENT TO ONESAVINGS BANK REF 70099999', -500, idx, {})).toBe('');
  });
  it('defers to history when the reference is known to serve two costs (Close Brothers / Swinton)', () => {
    const refIndex = { '85376969': new Set(['cSwA', 'cSwB']) };
    expect(ctx.matchCostDirect('DIRECT DEBIT PAYMENT TO CLOSE-SWINTON REF 85376969, MANDATE NO 0207', -45.3, idx, refIndex)).toBe('');
  });
  it('keeps a direct debit reversal on the cost it reverses, even though the money is incoming', () => {
    expect(ctx.matchCostDirect('DIRECT DEBIT REVERSAL REF 70015544, MANDATE NO 0111', 660.69, idx, {})).toBe('c32');
    expect(ctx.matchCostDirect('BANK GIRO CREDIT REF 70015544', 660.69, idx, {})).toBe('');
  });
});

describe('runReconciliationMatching with the direct layer', () => {
  const F = () => ctx.F;
  const tx = (id, desc, vendor, amount, extra = {}) => ({ id, fields: { [F().txDescription]: desc, [F().txVendor]: vendor, [F().txAmount]: amount, [F().txReportAmount]: amount, [F().txDate]: '2026-08-20', ...extra } });

  it('overrides a vendor-keyed knowledge-base rule that points at the wrong mortgage', () => {
    // The bug: "ONESAVINGS BANK" → one Kent Reliance cost for all 13 mortgages.
    ctx.localStorage.setItem('recon_rules', JSON.stringify([{ vendorKey: 'onesavings bank', costId: 'c42', costLabel: 'wrong', subCatId: 'subMortgage', categoryId: 'catCogs', businessId: 'bizRE', propertyId: P.elm42, confidence: 5 }]));
    ctx.set('allTransactions', [tx('t1', 'DIRECT DEBIT PAYMENT TO ONESAVINGS BANK REF 70015544, MANDATE NO 0111 -- ONESAVINGS BANK', 'ONESAVINGS BANK', -660.69)]);
    const [r] = ctx.runReconciliationMatching();
    expect(r.costId).toBe('c32');
    expect(r.propertyId).toBe(P.elm32);
    expect(r.matchType).toBe('Knowledge Base'); // untouched: isAutoApprovable reads it
    expect(r.direct).toEqual(['cost ref']);
  });

  it('overrides the generic "bank giro|credit ref" history key with the named tenant', () => {
    const hist = tx('h1', 'BANK GIRO CREDIT REF LAMBERT, 000000003702570561', '', 524.9, { [F().txReconciled]: true, [F().txTenancy]: ['tenLambert'], [F().txUnit]: ['u42_1'], [F().txSubCategory]: [ctx.REC.subRentalInc], [F().txCategory]: ['catRev'], [F().txBusiness]: ['bizRE'] });
    ctx.set('allTransactions', [hist, tx('t2', 'BANK GIRO CREDIT REF WALKER, 000000003868222204', '', 524.6)]);
    const r = ctx.runReconciliationMatching().find(x => x.txId === 't2');
    expect(r.tenancyId).toBe('tenWalker');
    expect(r.propertyId).toBe(P.elm42);
    expect(r.businessId).toBe('bizRE');
    expect(r.categoryId).toBe('catRev');
    expect(r.subCatId).toBe(ctx.REC.subRentalInc);
  });

  it('clears a tenancy proposed by the generic "bank giro|credit ref" key when no active tenant is named', () => {
    const hist = tx('h1', 'BANK GIRO CREDIT REF LAMBERT, 000000003702570561', '', 524.9, { [F().txReconciled]: true, [F().txTenancy]: ['tenLambert'], [F().txUnit]: ['u42_1'], [F().txSubCategory]: [ctx.REC.subRentalInc] });
    ctx.set('allTransactions', [hist, tx('t3', 'BANK GIRO CREDIT REF SERCO LIMITED, S10115028210222026', '', 320)]);
    const r = ctx.runReconciliationMatching().find(x => x.txId === 't3');
    expect(r.tenancySource).toBe('composite-short');
    expect(r.tenancyId).toBe('');
  });

  it('keeps a tenancy learned from the identical descriptor when rent is paid by a third party', () => {
    // Universal Credit never names the tenant; the full-description history does.
    const uc = 'BANK GIRO CREDIT REF JB701135D DWP UC, 000000003750000000';
    const hist = tx('h2', uc, '', 524.9, { [F().txReconciled]: true, [F().txTenancy]: ['tenLambert'], [F().txUnit]: ['u42_1'], [F().txSubCategory]: [ctx.REC.subRentalInc] });
    ctx.set('allTransactions', [hist, tx('t6', uc, '', 524.9)]);
    const r = ctx.runReconciliationMatching().find(x => x.txId === 't6');
    expect(r.tenancySource).toBe('composite-full');
    expect(r.tenancyId).toBe('tenLambert');
  });

  it('a bare street word fills a blank property but does not override a learned one', () => {
    // History never carries a property on its own (only via tenancy or cost); a
    // knowledge-base rule does, so that is the learned value to protect.
    ctx.localStorage.setItem('recon_rules', JSON.stringify([{ vendorKey: 'oldham council', subCatId: 'subMortgage', categoryId: 'catCogs', businessId: 'bizRE', propertyId: P.elm42, confidence: 5 }]));
    ctx.set('allRentalUnits', [...ctx.get('allRentalUnits'), { id: 'uOld', fields: { [F().unitProperty]: ['propOld'], [F().unitPropName]: ['1406 Oldham Road'], [F().unitNumber]: 1 } }]);
    ctx.set('allTransactions', [tx('t7', 'OLDHAM COUNCIL TAX', 'OLDHAM COUNCIL', -20), tx('t8', 'Shaun Lingham Oldham', 'Shaun Lingham Oldham', -66), tx('t9', 'OLDHAM COUNCIL 1406 OLDHAM', 'OLDHAM COUNCIL', -20)]);
    const rs = ctx.runReconciliationMatching();
    expect(rs.find(x => x.txId === 't7').propertyId).toBe(P.elm42);   // bare word: keep the rule
    expect(rs.find(x => x.txId === 't8').propertyId).toBe('propOld'); // bare word: fill the blank
    expect(rs.find(x => x.txId === 't9').propertyId).toBe('propOld'); // number + street: override
  });

  it('a first name alone does not identify a tenancy', () => {
    expect(ctx.matchTenancyDirect('FASTER PAYMENTS RECEIPT REF.REFUND FROM GARY MARSH', 'GARY MARSH', 90, idx)).toBeNull();
  });

  it('ignores the split position when the candidates are different tenants', () => {
    // Two Martins at different units: "(Split 1 of 2)" must not pick unit 1 by position.
    expect(ctx.matchTenancyDirect('BANK GIRO CREDIT REF MARTIN (Split 1 of 2)', '', 897.52, idx)).toEqual({ tenancyId: 'tenMartinA' });
  });

  it('compares unit numbers numerically', () => {
    expect(ctx.matchTenancyDirect('INTUS LETTINGS LTDRENT FLAT 03', '', 641.2, idx)).toEqual({ tenancyId: 'tenIntus3' });
  });

  it('the rent tiebreaker no longer undoes a unit-number match', () => {
    ctx.set('allTransactions', [tx('t4', 'INTUS LETTINGS LTDRENT APARTMENT 3', '', 641.2)]);
    const [r] = ctx.runReconciliationMatching();
    expect(r.tenancyId).toBe('tenIntus3');
  });

  it('sets the property from the address when nothing more specific applies', () => {
    ctx.set('allTransactions', [tx('t5', 'Gary Marsh 5 Dalham', 'Gary Marsh 5 Dalham', -90)]);
    const [r] = ctx.runReconciliationMatching();
    expect(r.propertyId).toBe(P.dalham);
    expect(r.tenancyId).toBe('');
    expect(r.direct).toEqual(['address']);
  });
});
