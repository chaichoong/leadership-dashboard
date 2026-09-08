// Property Manager — pure compute. No fetch, no env, no Date.now(): every
// function takes its inputs and `today` so vitest can pin them.
//
// What leaves this module is what Roy sees. Nothing here touches bank
// balances, debt, or a Personal-business row: the transaction feed is already
// Business = Real Estate at the query, and costs are stripped below.

import { F, REC, ROY_EMAIL, REAL_ESTATE_NAME, PNL_SECTIONS, MAINT_TARGET_GBP, WAGES_TARGET_GBP } from './fields.mjs';

const f = (rec, id) => (rec && rec.fields ? rec.fields[id] : undefined);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round(n * 100) / 100;
const firstText = (v) => (Array.isArray(v) ? (v.length ? String(v[0]) : '') : (v == null ? '' : String(v)));
const linkIds = (v) => (Array.isArray(v) ? v.map(x => (typeof x === 'string' ? x : x && x.id)).filter(Boolean) : []);
export const isPersonalCoaName = (name) => /^personal\b/i.test(String(name || '').trim());

export function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseDay(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
function addMonthsClamped(d, n) {
  const day = d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(day, last));
  return t;
}
export function monthKeys(n, today) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// ── Tenancy status (mirrors js/shared.js) ──
const statusName = (v) => (v == null ? '' : (typeof v === 'string' ? v : (v.name || String(v)))).trim().toLowerCase();
export const isTenancyActive = (t) => ['in payment', 'cfv actioned', 'cfv'].includes(statusName(f(t, F.tenPayStatus)));
export const isTenancyIncome = (t) => ['in payment', 'cfv actioned'].includes(statusName(f(t, F.tenPayStatus)));
export const isTenancyBehind = (t) => ['cfv actioned', 'cfv'].includes(statusName(f(t, F.tenPayStatus)));
export function isTenantStatusActive(t, today) {
  const end = parseDay(f(t, F.tenEndDate));
  if (end && end < new Date(today.getFullYear(), today.getMonth(), today.getDate())) return false;
  const s = f(t, F.tenStatus);
  const arr = Array.isArray(s) ? s : (s ? [s] : []);
  return arr.some(x => String(x).trim().toLowerCase() === 'active');
}
export const isUnitVoid = (u) => statusName(f(u, F.unitStatus)).startsWith('void');

// ── Costs: the personal strip ──
// A cost is Roy's running cost when it is active (LEGACY Payment Status, the
// field the app filters on), its Business is Real Estate or blank, and neither
// its category nor sub-category carries the "Personal" prefix.
export function isCostActive(c) {
  if (f(c, F.costInactive)) return false;
  const s = f(c, F.costPayStatus);
  const name = typeof s === 'string' ? s : (s && s.name) || '';
  return name === 'In Payment' || name === 'Overdue';
}
export function classifyCost(c, coaNames) {
  if (!isCostActive(c)) return 'inactive';
  const biz = linkIds(f(c, F.costBusiness));
  if (biz.includes(REC.bizPersonal)) return 'personal';
  const coa = [...linkIds(f(c, F.costSubCategory)), ...linkIds(f(c, F.costCategory))].map(id => coaNames[id] || '');
  if (coa.some(isPersonalCoaName)) return 'personal';
  if (biz.length && !biz.includes(REC.bizRealEstate)) return 'other-business';
  return 'property';
}
export function runningCosts(costs, coaNames) {
  const out = { total: 0, count: 0, excluded: { personal: 0, personalGbp: 0, otherBusiness: 0, otherBusinessGbp: 0 } };
  for (const c of costs) {
    const cls = classifyCost(c, coaNames);
    const amt = num(f(c, F.costExpected));
    if (cls === 'property') { out.total += amt; out.count += 1; }
    else if (cls === 'personal') { out.excluded.personal += 1; out.excluded.personalGbp += amt; }
    else if (cls === 'other-business') { out.excluded.otherBusiness += 1; out.excluded.otherBusinessGbp += amt; }
  }
  out.total = round2(out.total);
  out.excluded.personalGbp = round2(out.excluded.personalGbp);
  out.excluded.otherBusinessGbp = round2(out.excluded.otherBusinessGbp);
  return out;
}

// ── Lookups ──
export function buildNameMap(records, fieldId) {
  const out = {};
  for (const r of records || []) { const n = f(r, fieldId); if (n != null && n !== '') out[r.id] = firstText(n); }
  return out;
}

// ── Portfolio ──
export function portfolio(units) {
  const byProp = {};
  const voids = [];
  const empty = { rentReady: 0, notReady: 0 };
  for (const u of units) {
    const prop = firstText(f(u, F.unitPropName)) || 'Unallocated';
    byProp[prop] = byProp[prop] || { property: prop, units: 0, void: 0 };
    byProp[prop].units += 1;
    const st = statusName(f(u, F.unitStatus));
    if (isUnitVoid(u)) { byProp[prop].void += 1; voids.push({ unit: firstText(f(u, F.unitName)), property: prop }); }
    else if (st === 'rent ready') empty.rentReady += 1;
    else if (st === 'not ready') empty.notReady += 1;
  }
  const total = units.length;
  const voidCount = voids.length;
  voids.sort((a, b) => a.property.localeCompare(b.property) || a.unit.localeCompare(b.unit));
  return {
    properties: Object.keys(byProp).filter(p => p !== 'Unallocated').length,
    units: total,
    occupied: total - voidCount,
    void: voidCount,
    occupancyPct: total ? Math.round(((total - voidCount) / total) * 1000) / 10 : 0,
    empty,
    voids,
    byProperty: Object.values(byProp).sort((a, b) => b.void - a.void || a.property.localeCompare(b.property)),
  };
}

// ── Tenancies ──
export function tenancyMetrics(tenancies, today) {
  const live = tenancies.filter(t => isTenancyActive(t) && isTenantStatusActive(t, today));
  const behind = live.filter(isTenancyBehind);
  const rows = behind.map(t => ({
    id: t.id,
    tenant: firstText(f(t, F.tenSurname)) || 'Unknown',
    unit: firstText(f(t, F.tenUnitRef)),
    property: firstText(f(t, F.tenProperty)),
    rent: num(f(t, F.tenRent)),
    status: (typeof f(t, F.tenPayStatus) === 'string') ? f(t, F.tenPayStatus) : '',
    daysOverdue: num(f(t, F.tenDaysOverdue)),
  })).sort((a, b) => b.daysOverdue - a.daysOverdue || b.rent - a.rent);
  return {
    active: live.length,
    inPayment: live.filter(t => statusName(f(t, F.tenPayStatus)) === 'in payment').length,
    behind: behind.length,
    exposure: round2(behind.reduce((s, t) => s + num(f(t, F.tenRent)), 0)),
    expectedRent: round2(live.filter(isTenancyIncome).reduce((s, t) => s + num(f(t, F.tenRent)), 0)),
    behindList: rows,
  };
}

// ── Rent due, next 31 days ──
// Anchor = Airtable's own Next Rent Due Date formula (built off Due Day of
// Month, the one maintained input), stepped forward by Payment Frequency.
export function rentDue(tenancies, tenants, today, windowDays = 31) {
  const uc = new Set();
  for (const t of tenants || []) {
    const pt = f(t, F.tenantPayType);
    const n = typeof pt === 'string' ? pt : (pt && pt.name) || '';
    if (n.toLowerCase().includes('universal credit')) uc.add(t.id);
  }
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const end = new Date(start); end.setDate(end.getDate() + windowDays);
  const rows = [];
  let total = 0;
  for (const t of tenancies) {
    if (!isTenancyIncome(t) || !isTenantStatusActive(t, today)) continue;
    const rent = num(f(t, F.tenRent));
    if (rent <= 0) continue;
    let d = parseDay(f(t, F.tenNextDueDate));
    if (!d) {
      const day = Math.min(Math.max(1, num(f(t, F.tenDueDay)) || 1), 28);
      d = new Date(start.getFullYear(), start.getMonth(), day);
      if (d < start) d = addMonthsClamped(d, 1);
    }
    const freq = String(f(t, F.tenPayFreq) || 'Monthly').toLowerCase();
    const step = (x) => {
      if (freq === 'weekly') { const y = new Date(x); y.setDate(y.getDate() + 7); return y; }
      if (freq === 'fortnightly') { const y = new Date(x); y.setDate(y.getDate() + 14); return y; }
      if (freq === '4-weekly') { const y = new Date(x); y.setDate(y.getDate() + 28); return y; }
      if (freq === 'quarterly') return addMonthsClamped(x, 3);
      return addMonthsClamped(x, 1);
    };
    // Walk back so an anchor in the past still yields the first future date.
    let guard = 0;
    while (d < start && guard++ < 60) d = step(d);
    const tenantIds = linkIds(f(t, F.tenLinkedTenant));
    const isUC = tenantIds.some(id => uc.has(id));
    const paidThisMonth = !!num(f(t, F.tenPaidThisMonth));
    let first = true;
    guard = 0;
    while (d <= end && guard++ < 10) {
      const paid = first && paidThisMonth && d.getMonth() === start.getMonth() && d.getFullYear() === start.getFullYear();
      rows.push({
        tenancyId: t.id,
        tenant: firstText(f(t, F.tenSurname)) || 'Unknown',
        unit: firstText(f(t, F.tenUnitRef)),
        property: firstText(f(t, F.tenProperty)),
        amount: rent,
        due: dateKey(d),
        isUC,
        paid,
      });
      total += rent;
      first = false;
      d = step(d);
    }
  }
  rows.sort((a, b) => a.due.localeCompare(b.due) || a.property.localeCompare(b.property));
  return { rows, total: round2(total) };
}

// ── Transactions: last 31 days + P&L by property ──
function txPropertyName(tx, ctx) {
  const direct = linkIds(f(tx, F.txProperty))[0];
  if (direct && ctx.propNames[direct]) return ctx.propNames[direct];
  const tenId = linkIds(f(tx, F.txTenancy))[0];
  if (tenId && ctx.tenancyProp[tenId]) return ctx.tenancyProp[tenId];
  const unitId = linkIds(f(tx, F.txUnit))[0];
  if (unitId && ctx.unitProp[unitId]) return ctx.unitProp[unitId];
  return '';
}
export function buildTxContext({ properties, tenancies, units, subCategories }) {
  const propNames = {};
  for (const p of properties || []) propNames[p.id] = firstText(f(p, F.propShortName)) || firstText(f(p, F.propName));
  const tenancyProp = {};
  for (const t of tenancies || []) tenancyProp[t.id] = firstText(f(t, F.tenProperty));
  const unitProp = {};
  for (const u of units || []) unitProp[u.id] = firstText(f(u, F.unitPropName));
  const subNames = buildNameMap(subCategories, F.subCatName);
  const subSection = {};
  for (const sec of PNL_SECTIONS) for (const s of sec.subs) subSection[s] = sec.name;
  return { propNames, tenancyProp, unitProp, subNames, subSection };
}

export function last31(transactions, ctx, today) {
  const end = dateKey(today);
  const s = new Date(today); s.setDate(s.getDate() - 30);
  const start = dateKey(s);
  const out = { rentIn: 0, maintenance: 0, wages: 0, income: 0, costs: 0, profit: 0, from: start, to: end, maintTarget: MAINT_TARGET_GBP, wagesTarget: WAGES_TARGET_GBP, txCount: 0 };
  for (const tx of transactions) {
    const d = String(f(tx, F.txDate) || '').slice(0, 10);
    if (!d || d < start || d > end) continue;
    const amt = num(f(tx, F.txReportAmount));
    const subId = linkIds(f(tx, F.txSubCategory))[0];
    const section = ctx.subSection[ctx.subNames[subId] || ''];
    if (!section) continue;
    out.txCount += 1;
    if (subId === REC.subRentalInc) out.rentIn += amt;
    if (subId === REC.subMaint) out.maintenance += -amt;
    if (subId === REC.subOpexLabour || subId === REC.subCOGSLabour) out.wages += -amt;
    if (section === 'Revenue') out.income += amt; else out.costs += -amt;
  }
  out.profit = out.income - out.costs;
  for (const k of ['rentIn', 'maintenance', 'wages', 'income', 'costs', 'profit']) out[k] = round2(out[k]);
  return out;
}

export function pnlByProperty(transactions, ctx, months, today) {
  const keys = new Set(monthKeys(months, today));
  const rows = {};
  const row = (p) => (rows[p] = rows[p] || { property: p, rentIn: 0, maintenance: 0, otherCosts: 0, profit: 0 });
  const total = { property: 'Whole business', rentIn: 0, maintenance: 0, otherCosts: 0, profit: 0, revenue: 0 };
  for (const tx of transactions) {
    const d = String(f(tx, F.txDate) || '');
    if (!keys.has(d.slice(0, 7))) continue;
    const subId = linkIds(f(tx, F.txSubCategory))[0];
    const subName = ctx.subNames[subId] || '';
    const section = ctx.subSection[subName];
    if (!section) continue;
    const amt = num(f(tx, F.txReportAmount));
    const r = row(txPropertyName(tx, ctx) || 'Unallocated');
    if (section === 'Revenue') { r.rentIn += amt; total.rentIn += amt; }
    else if (subId === REC.subMaint) { r.maintenance += -amt; total.maintenance += -amt; }
    else { r.otherCosts += -amt; total.otherCosts += -amt; }
  }
  const list = Object.values(rows).map(r => ({ ...r, rentIn: round2(r.rentIn), maintenance: round2(r.maintenance), otherCosts: round2(r.otherCosts), profit: round2(r.rentIn - r.maintenance - r.otherCosts) }));
  list.sort((a, b) => (a.property === 'Unallocated') - (b.property === 'Unallocated') || b.profit - a.profit);
  total.profit = round2(total.rentIn - total.maintenance - total.otherCosts);
  delete total.revenue;
  for (const k of ['rentIn', 'maintenance', 'otherCosts']) total[k] = round2(total[k]);
  return { months, keys: [...keys], rows: list, total };
}

// ── Tasks ──
export function isRoyScope(task) {
  const a = f(task, F.taskAssignee);
  if (a && String(a.email || '').toLowerCase() === ROY_EMAIL) return true;
  if (linkIds(f(task, F.taskTeamMember)).includes(REC.roy)) return true;
  return !!f(task, F.taskMaintenance);
}
export const isTaskOpen = (task) => !['Completed', 'Cancelled'].includes(String(f(task, F.taskStatus) || ''));

export function shapeTasks(tasks, propNames, today) {
  const todayKey = dateKey(today);
  return tasks.filter(t => isTaskOpen(t) && isRoyScope(t)).map(t => {
    const due = String(f(t, F.taskDueDate) || '').slice(0, 10);
    const props = linkIds(f(t, F.taskProperties)).map(id => propNames[id]).filter(Boolean);
    return {
      id: t.id,
      name: String(f(t, F.taskName) || ''),
      status: String(f(t, F.taskStatus) || ''),
      due,
      overdue: !!due && due < todayKey,
      priority: String(f(t, F.taskPriority) || ''),
      priorityLevel: String(f(t, F.taskPriorityLvl) || ''),
      maintenance: !!f(t, F.taskMaintenance),
      contractor: String(f(t, F.taskContractor) || ''),
      properties: props,
      description: String(f(t, F.taskDescription) || ''),
      notes: String(f(t, F.taskNotes) || ''),
      mine: String((f(t, F.taskAssignee) || {}).email || '').toLowerCase() === ROY_EMAIL || linkIds(f(t, F.taskTeamMember)).includes(REC.roy),
    };
  }).sort((a, b) => (b.overdue - a.overdue) || ((a.due || '9999') .localeCompare(b.due || '9999')) || a.name.localeCompare(b.name));
}

// Append a dated, signed line to the Notes field. Never overwrites.
export function appendNote(existing, text, who, now) {
  const stamp = `${dateKey(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const line = `[${stamp} ${who}] ${String(text).trim()}`;
  const prev = String(existing || '').trim();
  return prev ? `${prev}\n${line}` : line;
}

// ── Assemble ──
export function computeAll(data, today) {
  const coaNames = { ...buildNameMap(data.subCategories, F.subCatName), ...buildNameMap(data.categories, F.catName) };
  const ctx = buildTxContext(data);
  const ten = tenancyMetrics(data.tenancies, today);
  const costs = runningCosts(data.costs, coaNames);
  const l31 = last31(data.transactions, ctx, today);
  l31.exposure = ten.exposure;
  return {
    generatedAt: today.toISOString(),
    business: REAL_ESTATE_NAME,
    portfolio: portfolio(data.rentalUnits),
    tenancies: ten,
    last31: l31,
    planned: { expectedRent: ten.expectedRent, runningCosts: costs.total, leaves: round2(ten.expectedRent - costs.total), costCount: costs.count },
    rentDue: rentDue(data.tenancies, data.tenants, today),
    pnl: { 1: pnlByProperty(data.transactions, ctx, 1, today), 3: pnlByProperty(data.transactions, ctx, 3, today), 12: pnlByProperty(data.transactions, ctx, 12, today) },
    // Health facts for the page's checks. Counts only — no personal rows leave.
    health: {
      txCount: data.transactions.length,
      tenancyCount: data.tenancies.length,
      unitCount: data.rentalUnits.length,
      // Counts only. The £ totals of Kevin's personal and other-business costs
      // stay in the Worker: they are exactly what Roy must not see.
      costsExcluded: { personal: costs.excluded.personal, otherBusiness: costs.excluded.otherBusiness },
      unallocatedTx12m: (pnlByProperty(data.transactions, ctx, 12, today).rows.find(r => r.property === 'Unallocated') || { rentIn: 0, maintenance: 0, otherCosts: 0 }),
    },
  };
}
