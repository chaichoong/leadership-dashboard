// Property Manager — pure compute. No fetch, no env, no Date.now(): every
// function takes its inputs and `today` so vitest can pin them.
//
// What leaves this module is what Roy sees. Nothing here touches bank
// balances, debt, or a Personal-business transaction: the transaction feed is
// already Business = Real Estate at the query. Running costs are the FULL
// fixed-cost total on purpose (Kevin, 9 Sep 2026): some of his own fixed costs
// sit inside it and Roy needs the true cash-flow figure, never the breakdown.

import { F, REC, ROY_EMAIL, REAL_ESTATE_NAME, PNL_SECTIONS, MAINT_TARGET_GBP, WAGES_TARGET_GBP } from './fields.mjs';

const f = (rec, id) => (rec && rec.fields ? rec.fields[id] : undefined);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round(n * 100) / 100;
const firstText = (v) => (Array.isArray(v) ? (v.length ? String(v[0]) : '') : (v == null ? '' : String(v)));
const linkIds = (v) => (Array.isArray(v) ? v.map(x => (typeof x === 'string' ? x : x && x.id)).filter(Boolean) : []);
const selName = (v) => (v == null ? '' : (typeof v === 'string' ? v : (v.name || String(v))));
export const isPersonalCoaName = (name) => /^personal\b/i.test(String(name || '').trim());

export function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseDay(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
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
export function lastMonthKey(today) { return monthKeys(2, today)[0]; }

// ── Tenancy status (mirrors js/shared.js) ──
const statusName = (v) => selName(v).trim().toLowerCase();
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

// ── Costs ──
// Active = the LEGACY Payment Status rule the whole app filters on.
export function isCostActive(c) {
  if (f(c, F.costInactive)) return false;
  const name = selName(f(c, F.costPayStatus));
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
// Full fixed-cost total (every active cost, any business), plus how much of it
// is not property so the page can SAY so without listing it.
export function runningCosts(costs, coaNames) {
  const out = { total: 0, count: 0, propertyTotal: 0, propertyCount: 0, nonPropertyCount: 0 };
  for (const c of costs) {
    const cls = classifyCost(c, coaNames);
    if (cls === 'inactive') continue;
    const amt = num(f(c, F.costExpected));
    out.total += amt; out.count += 1;
    if (cls === 'property') { out.propertyTotal += amt; out.propertyCount += 1; }
    else out.nonPropertyCount += 1;
  }
  out.total = round2(out.total); out.propertyTotal = round2(out.propertyTotal);
  return out;
}

// ── Lookups ──
export function buildNameMap(records, fieldId) {
  const out = {};
  for (const r of records || []) { const n = f(r, fieldId); if (n != null && n !== '') out[r.id] = firstText(n); }
  return out;
}
const txLabel = (tx) => firstText(f(tx, F.txVendor)) || firstText(f(tx, F.txName)) || 'Transaction';

// Rental-income transactions per tenancy, newest first: [{date, amount}].
export function paymentsByTenancy(transactions) {
  const out = {};
  for (const tx of transactions) {
    if (linkIds(f(tx, F.txSubCategory))[0] !== REC.subRentalInc) continue;
    const tenId = linkIds(f(tx, F.txTenancy))[0];
    if (!tenId) continue;
    const date = String(f(tx, F.txDate) || '').slice(0, 10);
    if (!date) continue;
    (out[tenId] = out[tenId] || []).push({ date, amount: round2(num(f(tx, F.txReportAmount))) });
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

// ── Portfolio ──
export function portfolio(units, tenancies, today) {
  const byProp = {};
  const voids = [];
  const empty = { rentReady: 0, notReady: 0 };
  // Current tenant per unit (live tenancy) and last ended tenancy per unit.
  const currentByUnit = {}, lastEndedByUnit = {};
  for (const t of tenancies || []) {
    const unitId = linkIds(f(t, F.tenUnit))[0];
    if (!unitId) continue;
    if (isTenancyActive(t) && isTenantStatusActive(t, today)) currentByUnit[unitId] = t;
    const end = String(f(t, F.tenEndDate) || '').slice(0, 10);
    if (end && (!lastEndedByUnit[unitId] || end > lastEndedByUnit[unitId].end)) lastEndedByUnit[unitId] = { end, tenant: firstText(f(t, F.tenSurname)) || 'Unknown' };
  }
  for (const u of units) {
    const prop = firstText(f(u, F.unitPropName)) || 'Unallocated';
    const row = (byProp[prop] = byProp[prop] || { property: prop, units: 0, void: 0, occupied: 0, rows: [] });
    row.units += 1;
    const st = statusName(f(u, F.unitStatus));
    const cur = currentByUnit[u.id];
    const unitRow = { unit: firstText(f(u, F.unitName)), status: selName(f(u, F.unitStatus)) || '', unitType: selName(f(u, F.unitType)), tenant: cur ? (firstText(f(cur, F.tenSurname)) || 'Unknown') : '', rent: cur ? num(f(cur, F.tenRent)) : 0 };
    row.rows.push(unitRow);
    if (isUnitVoid(u)) {
      row.void += 1;
      const last = lastEndedByUnit[u.id];
      voids.push({ unit: unitRow.unit, property: prop, unitType: unitRow.unitType, lastTenant: last ? last.tenant : '', endedOn: last ? last.end : '' });
    } else {
      row.occupied += 1;
      if (st === 'rent ready') empty.rentReady += 1;
      else if (st === 'not ready') empty.notReady += 1;
    }
  }
  const total = units.length;
  const voidCount = voids.length;
  voids.sort((a, b) => a.property.localeCompare(b.property) || a.unit.localeCompare(b.unit));
  const byProperty = Object.values(byProp).map(r => ({ ...r, rows: r.rows.sort((a, b) => a.unit.localeCompare(b.unit)) })).sort((a, b) => b.void - a.void || a.property.localeCompare(b.property));
  return {
    properties: byProperty.filter(p => p.property !== 'Unallocated').length,
    units: total, occupied: total - voidCount, void: voidCount,
    occupancyPct: total ? Math.round(((total - voidCount) / total) * 1000) / 10 : 0,
    empty, voids, byProperty,
  };
}

// ── Tenancies ──
function tenancyRow(t, payments) {
  const hist = payments[t.id] || [];
  return {
    id: t.id,
    tenant: firstText(f(t, F.tenSurname)) || 'Unknown',
    unit: firstText(f(t, F.tenUnitRef)),
    property: firstText(f(t, F.tenProperty)),
    rent: num(f(t, F.tenRent)),
    status: selName(f(t, F.tenPayStatus)),
    dueDay: num(f(t, F.tenDueDay)) || null,
    daysOverdue: num(f(t, F.tenDaysOverdue)),
    lastPaid: hist[0] || null,
  };
}
export function tenancyMetrics(tenancies, payments, today) {
  const live = tenancies.filter(t => isTenancyActive(t) && isTenantStatusActive(t, today));
  const rows = live.map(t => tenancyRow(t, payments)).sort((a, b) => a.property.localeCompare(b.property) || a.unit.localeCompare(b.unit));
  const behind = live.filter(isTenancyBehind);
  const behindList = behind.map(t => ({ ...tenancyRow(t, payments), history: (payments[t.id] || []).slice(0, 24) }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue || b.rent - a.rent);
  return {
    active: live.length,
    inPayment: live.filter(t => statusName(f(t, F.tenPayStatus)) === 'in payment').length,
    behind: behind.length,
    exposure: round2(behind.reduce((s, t) => s + num(f(t, F.tenRent)), 0)),
    expectedRent: round2(live.filter(isTenancyIncome).reduce((s, t) => s + num(f(t, F.tenRent)), 0)),
    live: rows,
    behindList,
  };
}

// ── Rent due: 3 days back, 31 days forward ──
// Anchor = Airtable's own Next Rent Due Date formula (built off Due Day of
// Month, the one maintained input), stepped by Payment Frequency. "Paid" comes
// from the bank feed only: a rental-income transaction for that tenancy dated
// from three days before the due date up to today. A future due date can
// never read as paid.
export const RENT_DUE_LOOKBACK_DAYS = 3;
export function rentDue(tenancies, tenants, payments, today, windowDays = 31) {
  const uc = new Set();
  for (const t of tenants || []) if (selName(f(t, F.tenantPayType)).toLowerCase().includes('universal credit')) uc.add(t.id);
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = addDays(todayStart, -RENT_DUE_LOOKBACK_DAYS);
  const end = addDays(todayStart, windowDays);
  const todayKey = dateKey(todayStart);
  const rows = [];
  let total = 0, paidTotal = 0;
  for (const t of tenancies) {
    if (!isTenancyIncome(t) || !isTenantStatusActive(t, today)) continue;
    const rent = num(f(t, F.tenRent));
    if (rent <= 0) continue;
    const freq = String(f(t, F.tenPayFreq) || 'Monthly').toLowerCase();
    const step = (x, n = 1) => {
      if (freq === 'weekly') return addDays(x, 7 * n);
      if (freq === 'fortnightly') return addDays(x, 14 * n);
      if (freq === '4-weekly') return addDays(x, 28 * n);
      if (freq === 'quarterly') return addMonthsClamped(x, 3 * n);
      return addMonthsClamped(x, n);
    };
    let d = parseDay(f(t, F.tenNextDueDate));
    if (!d) {
      const day = Math.min(Math.max(1, num(f(t, F.tenDueDay)) || 1), 28);
      d = new Date(todayStart.getFullYear(), todayStart.getMonth(), day);
    }
    // Walk to the first occurrence inside the window (the anchor may sit a
    // cycle ahead of a due date that fell in the 3-day look-back, or behind).
    let guard = 0;
    while (d > start && step(d, -1) >= start && guard++ < 60) d = step(d, -1);
    guard = 0;
    while (d < start && guard++ < 60) d = step(d);
    const hist = payments[t.id] || [];
    const tenantIds = linkIds(f(t, F.tenLinkedTenant));
    const isUC = tenantIds.some(id => uc.has(id));
    guard = 0;
    while (d <= end && guard++ < 10) {
      const due = dateKey(d);
      const paidFrom = dateKey(addDays(d, -RENT_DUE_LOOKBACK_DAYS));
      const hit = due <= todayKey ? hist.find(h => h.date >= paidFrom && h.date <= todayKey) : null;
      rows.push({
        tenancyId: t.id,
        tenant: firstText(f(t, F.tenSurname)) || 'Unknown',
        unit: firstText(f(t, F.tenUnitRef)),
        property: firstText(f(t, F.tenProperty)),
        amount: rent, due, isUC,
        paid: !!hit, paidOn: hit ? hit.date : '', paidAmount: hit ? hit.amount : 0,
        lastPaid: hist[0] || null,
      });
      total += rent; if (hit) paidTotal += rent;
      d = step(d);
    }
  }
  rows.sort((a, b) => a.due.localeCompare(b.due) || a.property.localeCompare(b.property));
  return { from: dateKey(start), to: dateKey(end), today: todayKey, rows, total: round2(total), paidTotal: round2(paidTotal) };
}

// ── Transactions ──
function txPropertyName(tx, ctx) {
  const direct = linkIds(f(tx, F.txProperty))[0];
  if (direct && ctx.propNames[direct]) return ctx.propNames[direct];
  const tenId = linkIds(f(tx, F.txTenancy))[0];
  if (tenId && ctx.tenancyProp[tenId]) return ctx.tenancyProp[tenId];
  const unitId = linkIds(f(tx, F.txUnit))[0];
  if (unitId && ctx.unitProp[unitId]) return ctx.unitProp[unitId];
  return '';
}
export function buildTxContext({ properties, tenancies, rentalUnits, units, subCategories }) {
  const propNames = {};
  for (const p of properties || []) propNames[p.id] = firstText(f(p, F.propShortName)) || firstText(f(p, F.propName));
  const tenancyProp = {};
  for (const t of tenancies || []) tenancyProp[t.id] = firstText(f(t, F.tenProperty));
  const unitProp = {};
  for (const u of (rentalUnits || units || [])) unitProp[u.id] = firstText(f(u, F.unitPropName));
  const subNames = buildNameMap(subCategories, F.subCatName);
  const subSection = {};
  for (const sec of PNL_SECTIONS) for (const s of sec.subs) subSection[s] = sec.name;
  return { propNames, tenancyProp, unitProp, subNames, subSection };
}

export function last31(transactions, ctx, today) {
  const end = dateKey(today);
  const start = dateKey(addDays(today, -30));
  const out = { rentIn: 0, maintenance: 0, wages: 0, income: 0, costs: 0, profit: 0, from: start, to: end, maintTarget: MAINT_TARGET_GBP, wagesTarget: WAGES_TARGET_GBP, txCount: 0, detail: { rentIn: [], maintenance: [], wages: [], otherCosts: [] } };
  for (const tx of transactions) {
    const d = String(f(tx, F.txDate) || '').slice(0, 10);
    if (!d || d < start || d > end) continue;
    const amt = num(f(tx, F.txReportAmount));
    const subId = linkIds(f(tx, F.txSubCategory))[0];
    const subName = ctx.subNames[subId] || '';
    const section = ctx.subSection[subName];
    if (!section) continue;
    out.txCount += 1;
    const line = { date: d, name: txLabel(tx), amount: round2(Math.abs(amt)), property: txPropertyName(tx, ctx), sub: subName };
    if (subId === REC.subRentalInc) { out.rentIn += amt; out.detail.rentIn.push(line); }
    if (subId === REC.subMaint) { out.maintenance += -amt; out.detail.maintenance.push(line); }
    else if (subId === REC.subOpexLabour || subId === REC.subCOGSLabour) { out.wages += -amt; out.detail.wages.push(line); }
    else if (section !== 'Revenue') out.detail.otherCosts.push(line);
    if (section === 'Revenue') out.income += amt; else out.costs += -amt;
  }
  out.profit = out.income - out.costs;
  for (const k of ['rentIn', 'maintenance', 'wages', 'income', 'costs', 'profit']) out[k] = round2(out[k]);
  for (const k of Object.keys(out.detail)) out.detail[k].sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

export function pnlByProperty(transactions, ctx, keysList, today) {
  const keys = new Set(keysList);
  const rows = {};
  const row = (p) => (rows[p] = rows[p] || { property: p, rentIn: 0, maintenance: 0, otherCosts: 0, profit: 0 });
  const total = { property: 'Whole business', rentIn: 0, maintenance: 0, otherCosts: 0, profit: 0 };
  for (const tx of transactions) {
    const d = String(f(tx, F.txDate) || '');
    if (!keys.has(d.slice(0, 7))) continue;
    const subId = linkIds(f(tx, F.txSubCategory))[0];
    const section = ctx.subSection[ctx.subNames[subId] || ''];
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
  for (const k of ['rentIn', 'maintenance', 'otherCosts']) total[k] = round2(total[k]);
  return { keys: keysList, rows: list, total };
}
export const PNL_WINDOWS = ['this', 'last', '3', '6', '12'];
export function pnlWindowKeys(win, today) {
  if (win === 'this') return monthKeys(1, today);
  if (win === 'last') return [lastMonthKey(today)];
  return monthKeys(Number(win), today);
}

// ── Tasks ──
export function isRoyScope(task) {
  const a = f(task, F.taskAssignee);
  if (a && String(a.email || '').toLowerCase() === ROY_EMAIL) return true;
  if (linkIds(f(task, F.taskTeamMember)).includes(REC.roy)) return true;
  return !!f(task, F.taskMaintenance);
}
export const isTaskOpen = (task) => !['Completed', 'Cancelled'].includes(String(f(task, F.taskStatus) || ''));

// Mirrors deriveTaskStatus() in os/tasks/index.html: Completed and Approval
// are manual terminal states; everything else follows the due date.
export function statusForDue(due, storedStatus, todayKey) {
  if (storedStatus === 'Completed' || storedStatus === 'Approval') return storedStatus;
  if (!due) return 'Upcoming';
  if (due < todayKey) return 'Overdue';
  if (due === todayKey) return 'Today';
  return 'Upcoming';
}

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
  }).sort((a, b) => (b.overdue - a.overdue) || ((a.due || '9999').localeCompare(b.due || '9999')) || a.name.localeCompare(b.name));
}

// Append a dated, signed line to the Notes field. Never overwrites.
export function appendNote(existing, text, who, now) {
  const stamp = `${dateKey(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const line = `[${stamp} ${who}] ${String(text).trim()}`;
  const prev = String(existing || '').trim();
  return prev ? `${prev}\n${line}` : line;
}

// ── Assemble ──
// `today` is London wall-clock (drives every window); `nowIso` is the real
// instant the figures were computed, for the page's freshness stamp.
export function computeAll(data, today, nowIso) {
  const coaNames = { ...buildNameMap(data.subCategories, F.subCatName), ...buildNameMap(data.categories, F.catName) };
  const ctx = buildTxContext(data);
  const payments = paymentsByTenancy(data.transactions);
  const ten = tenancyMetrics(data.tenancies, payments, today);
  const costs = runningCosts(data.costs, coaNames);
  const l31 = last31(data.transactions, ctx, today);
  l31.exposure = ten.exposure;
  const pnl = {};
  for (const w of PNL_WINDOWS) pnl[w] = pnlByProperty(data.transactions, ctx, pnlWindowKeys(w, today), today);
  return {
    generatedAt: nowIso || today.toISOString(),
    business: REAL_ESTATE_NAME,
    portfolio: portfolio(data.rentalUnits, data.tenancies, today),
    tenancies: ten,
    last31: l31,
    planned: {
      expectedRent: ten.expectedRent,
      runningCosts: costs.total, costCount: costs.count,
      nonPropertyCount: costs.nonPropertyCount,
      leaves: round2(ten.expectedRent - costs.total),
    },
    rentDue: rentDue(data.tenancies, data.tenants, payments, today),
    pnl,
    health: {
      txCount: data.transactions.length,
      tenancyCount: data.tenancies.length,
      unitCount: data.rentalUnits.length,
      costCount: costs.count,
      unallocatedTx12m: (pnl['12'].rows.find(r => r.property === 'Unallocated') || { rentIn: 0, maintenance: 0, otherCosts: 0 }),
    },
  };
}
