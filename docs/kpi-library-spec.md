# KPI Library — seed specification

> **Canonical entries live in `js/kpi-library.js`** (the admin page renders and
> health-checks them; the daily `kpi-library-coverage` invariant parses them).
> This document holds the design rationale, the harvest provenance and the
> de-Kevining detail. When adding a KPI: library entry + this doc, same commit.

Written 1 Aug 2026 on Kevin's direction, from a full harvest of every metric the platform
already computes: all dashboard tabs, all OS pages, all reports, the scheduled scripts and
the Cloudflare workers (~300 distinct displayed metrics), plus the 8 live automated KPIs
with compute code on Project records. Nothing here is invented; every entry below is a
metric that already runs somewhere in this platform.

**How it will be used.** When a new client's leadership dashboard is built, they pick KPIs
from this library. Each entry is a TEMPLATE with a few blanks (which table, which category,
what window, what target) — the client fills blanks, never writes code. Anything they ask
for that is not in the library gets built through the one-request-at-a-time queue, written
generically, and added here. The library grows itself from real demand.

**Relationship to the module split.** Tier 1 ships with the spine (every client's leadership
dashboard). Tier 2 ships only with the property pack add-on. Tier 3 is Kevin-only and never
enters the client library.

---

## 1. The ten computation shapes

Every harvested metric reduces to one of these. The template engine implements the shapes
once; library entries are data (shape + parameters), not code.

| # | Shape | Parameters | Proven by (live examples) |
|---|-------|-----------|---------------------------|
| T1 | Sum of transactions | category/sub-category, business, window (calendar month / rolling N days / quarter), signed | MRR, Cash collected, Rental income 31d, Maintenance spend |
| T2 | Sum A minus sum B | two T1 configs, window | Operating cushion (cash), Net profit, Net cash flow |
| T3 | Count of records matching filters | table, field filters, date bounds | Active tasks, Overdue, Unpaid invoices, CFV count, AI agents live |
| T4 | Ratio of two counts/sums × 100 | numerator config, denominator config | Occupancy, Gross/net margin, Reconciled %, Collection rate, Agent accuracy, Utilisation |
| T5 | Sum of a field over filtered records | table, field, filters | Monthly fixed costs, Expected income, Outstanding invoices, Arrears exposure |
| T6 | Ordered-status funnel count | table, status field, ordered stage list, threshold stage | Prospects contacted (status ≥ Synced), funnel stages |
| T7 | Task completion on a project | project link (auto), optional name-match | Task Completion %, Rehearsals completed, Recovery packs |
| T8 | Age / staleness | table, date field, filters, aggregation (max/avg) | Oldest overdue, Avg days overdue, KPI staleness |
| T9 | Balance snapshot sum | account/record set (per-tenant setting) | Cleared balance, Credit card total, Net worth classes |
| T10 | Target wrapper | any shape + target + direction (higher/lower is better) + traffic-light bands | Every KPI card with a target indicator |

## 2. Tier 1 — Generic core (any client, day one)

Money
1. **Monthly Recurring Revenue** — T1: fixed-income sub-category + business, calendar month. *Live on OD today.*
2. **Revenue (period)** — T1: revenue categories, chosen window.
3. **Cash collected** — T1: revenue category + business, quarter window, signed so refunds net off. *Live.*
4. **Operating cushion / net cash (rolling)** — T2: income sums minus cost-linked sums, rolling 31 days, reversal-aware. *Live.*
5. **Monthly fixed costs** — T5: expected amount over active cost records.
6. **Net profit and margins** — T2 + T4 from the P&L section mapping.
7. **Cash balance** — T9 over the tenant's chosen accounts.
8. **Safe to act today** — composite (balance − protective floor − uncovered costs). Flagship number; needs the account set, wages float and reliability haircut as tenant settings.
9. **Outstanding / overdue invoices** — T5 + T3 on outbound invoices.
10. **Average days overdue** — T8.

Work
11. **Task completion %** — T7. *Live.*
12. **Completed tasks (optionally name-matched)** — T7. *Live twice.*
13. **Active / overdue task counts** — T3.
14. **Team utilisation %** — T4: allocated hours ÷ capacity. BLOCKER: capacity lives in localStorage today; must move to a per-tenant settings table first.

Sales and growth
15. **Prospects contacted** — T6: status at or beyond the contact stage. *Live.*
16. **Funnel stage counts + found-to-call rate** — T3 + T4.
17. **Calls booked / attended** — T3 (the north-star pattern from the content playbook).
18. **Pipeline value by stage** — T5 on CRM deals (Supabase side).

AI workforce
19. **Agent accuracy %** — T4 per agent per task type. Standardise on `js/agent-accuracy.js` (20 decisions, ≥90%, no recent rejections). The platform currently has THREE competing accuracy definitions (agent-accuracy.js, prospecting funnel, inbound-comms localStorage) — the library carries ONE.
20. **Approvals waiting** — T3: tasks at Status Approval.
21. **AI agents live** — T3 on workflow agent states.

## 3. Tier 2 — Property pack (add-on only)

Occupancy rate · void units · rent roll (expected monthly income by payment status) · paid
tenancy rate · CFV count and exposure · arrears balance, days in arrears and Section 8
threshold (62 days) · gross and net yield · LTV · equity and capital growth · cash-on-cash ·
compliance certificate counts (expired / expiring 30d / active / missing) · payment-lag
buffer days · UC checks due. All already computed on the Operations, CFV, Compliance and
cashflow surfaces.

## 4. Tier 3 — OD-internal (never in the client library)

Kevin's personal wealth layer (net worth, Kiyosaki ratios, buckets, personal budgets — a
possible future personal-wealth module, but not leadership-dashboard KPIs), CEO brief
internals, quarter targets, hardcoded account records, the contractor roster, doc/SOP git
sync, schema-drift and invariant counts.

## 5. De-Kevining requirements (found by the harvest — must be done as part of the library build)

1. **Hardcoded account record IDs** (Santander + TnT Zempler in four places, credit cards in
   two) → per-tenant "accounts in cleared balance" setting.
2. **Hardcoded sub-category name lists** (P&L sections, cashflow subcats, personal expense
   lists) → per-tenant chart-of-accounts mapping created at onboarding.
3. **localStorage-only inputs** (team capacity, task-hours budget, inbound-comms accuracy
   log, systemisation pipeline state) → tenant settings/data tables, or the metric is
   per-browser and untestable.
4. **Three accuracy definitions** → one shared module (see Tier 1 #19).
5. **`new Function` compute in the browser** → server-side template evaluation (Supabase Edge
   Function) at the dashboard module's cutover. Templates remove the need for client-authored
   code entirely, which is what makes this safe.
6. **Known defects to fix or exclude before any client sees them:** `kpi-sources.js`
   `completed_tasks_month` is a stub returning 0 but renders as a real value; the Operations
   Customers KPI grid runs on three hard-coded demo rows; the money-daily worker duplicates
   money.js/cashflow.js by hand with no drift test.

## 6. How a client uses it (the build, when it happens)

1. Onboarding: the chart-of-accounts mapping and account set are captured (already part of
   the client profile questionnaire).
2. Their leadership dashboard build: KPI picker offers Tier 1 (+ Tier 2 if property pack).
   Picking an entry = choosing a shape's parameters; the engine computes it server-side on a
   schedule; manual values stay amber-flagged; stale values show STALE.
3. Any request not covered → one-request queue → built generically → becomes the next
   library entry.

Build trigger per Kevin, 1 Aug 2026: the library seed exists NOW (this document); the picker
and template engine are built as part of the first client leadership-dashboard build, on the
Supabase side. Until then, new KPIs on Kevin's own dashboard keep being written generically
so they translate straight into templates.
