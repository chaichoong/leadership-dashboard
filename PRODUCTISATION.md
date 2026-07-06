# PRODUCTISATION.md — Generic Client Blueprint

Single source of truth for what a new Operations Director client gets on day one, page by page. Written 2026-07-06 from a full source review of every page and tab. Any session building the generic (Supabase) version of a page must read this file first.

**The rule:** a feature ships as standard only if any founder-led micro/SMB (service, trades, agency, e-commerce) would use it. Anything built for Kevin's businesses is stripped from the client build and catalogued in the Optional Extras Register at the end. Clients get Kevin's customisations only when they ask and Kevin approves.

**Commercial frame (locked 2026-06-17, not reopened here):**
- **Standard spine:** Command Centre (Tasks & Projects) + Operations CRM + Team + Leadership Dashboard
- **Paid modules (£100/mo each):** Finance, Strategy & Execution, Systemisation, Inbound Comms, Content Machine, Personal Wealth
- **Vertical pack:** Property Management
- Sold as a service at £350/mo base + add-ons + one-request-at-a-time queue.

**Classification key**
- `UNIVERSAL` — ships in the standard spine
- `MODULE:<name>` — ships in that paid module
- `VERTICAL` — ships in the Property Management pack
- `BESPOKE` — Kevin-only; stripped from client builds, catalogued as an optional extra

---

## 1. Summary — every page, its home, and how much survives

"Survives" = share of the current build that ships to a generic client unchanged or with config only (in its module home). The remainder is vertical or bespoke.

| Page (registry id) | Product home | Survives | One-line verdict |
|---|---|---|---|
| Leadership Dashboard (`overview`) | Spine | ~85% | KPI/projects/cash position are universal; strip hardcoded accounts, team, budgets |
| Tasks & Projects (`tasks`) | Spine (Command Centre) | ~90% | Strongest spine page; strip Contractor tab (vertical) and Kevin-only auto-pull |
| Operations (`operations`) | Spine (Operations CRM) | ~30% | Currently a property CRM. Generic version = Customers/Contacts CRM; tenants/units/properties/valuations move to vertical |
| Team Members (`os-team`) | Spine (Team) | ~90% | Directory, onboarding, org chart, achievements are universal; Training matrix follows Systemisation module |
| Objective & Strategy (`os-strategy`) | MODULE: Strategy & Execution | ~95% | Already generic; Boardroom Mentor wizard needs a per-client profile |
| Business Launch Plan Builder (`os-bplan`) | MODULE: Strategy & Execution | ~95% | Fully generic AI wizard; watch API cost per plan |
| Systemisation (`systemisation`) | MODULE: Systemisation | ~95% | Workflows, AI/Staff/Both steps, SOP auto-generation all generic |
| CFVs (`cfv`) | MODULE: Finance (core) + VERTICAL (rent version) | ~40% | Detection engine generalises to any expected recurring payment; current rent/UC implementation is vertical |
| Money Confidence (`money`) | MODULE: Finance | ~70% | "Safe to Act Today" is universal; rent haircut logic is vertical; accounts/thresholds are config |
| Wealth (`wealth`) | MODULE: Personal Wealth | ~75% | Net worth, debt amortisation, buckets, budgets universal; property valuation workflow is vertical |
| AR Fixed (`income`) | VERTICAL (today) → MODULE: Finance (rebuild) | ~10% | Pure tenancy/rent page. Generic replacement = "Recurring Revenue" (retainers, subscriptions) |
| AR Variable (`ar-variable`) | MODULE: Finance | ~90% | Generic outbound invoice tracker already |
| AP Fixed (`costs`) | MODULE: Finance | ~85% | Generic recurring-cost engine; thresholds and property links are config/vertical |
| AP Variable (`invoices`) | MODULE: Finance | ~75% | Generic once Gmail label ingestion is abstracted per client |
| Profit & Loss (`pnl`) | MODULE: Finance | ~85% | Grid/charts/drilldown universal; targets and property sub-categories are config |
| Transactions (`transactions`) | MODULE: Finance | ~80% | Explorer + inline categorisation universal; tenant/unit/property columns vertical |
| Bank Accounts (`fintable`) | MODULE: Finance | ~80% | Sync monitor universal for any Fintable client; exclusion list to config |
| Inbound Comms (`comms`) | MODULE: Inbound Comms | ~70% | Triage, AI labels, drafting universal; labels 3/10/11 automations vertical; GHL SMS premium |
| Property Compliance (`compliance`) | VERTICAL | ~5% | UK landlord certificates. Generic clients never see it |
| Content Machine (`content-machine`) | MODULE: Content Machine | ~90% | Separate repo; genericise branding/GHL wiring at integration time |
| Skills Library (`skills`) | Spine | ~85% | The AI-agent hub; central to the 90% AI promise |
| Site Map & Guides (`sitemap`) | Internal ops tool | n/a | Version/SOP drift tooling is for running the service, not for clients (decision D8) |
| AI Brain (`ai-brain`) | BESPOKE | 0% | Kevin's second brain. Catalogue as a future premium module |
| How It Works (`how-it-works`) | Spine (redrawn) | pattern only | Keep the page pattern; redraw content per client's actual integrations |
| Shell, AI Assistant, Quick Task FAB | Spine | ~90% | Universal chassis; Boardroom Mentor prompt must become per-client |

---

## 2. Page-by-page blueprint

### 2.1 Leadership Dashboard (`overview`) — Spine

**Purpose:** real-time operational overview: strategic project KPIs, cash position, sync alerts, reconciliation accuracy.

**Day-one client offer:** strategic projects board with KPI templates (revenue, profit, margin, task completion), 31-day cash position cards, unreconciled transaction count, bank sync alert banner. Empty-state friendly from the first login.

| Feature | Class |
|---|---|
| Strategic KPI project display, health calc, drilldown modal | UNIVERSAL |
| KPI compute engine (founder-authored JS, sandboxed) | UNIVERSAL |
| KPI source template library | MODULE: Strategy & Execution |
| Cash position KPI cards (31-day forecast) | UNIVERSAL |
| Cash flow forecast engine (js/cashflow.js, hosted here) | MODULE: Finance |
| Tenancy rent projection inside forecast | VERTICAL |
| Variable cost reserve (£3k maint + £1.5k wages + £1.5k CFV) | BESPOKE → configurable reserve |
| Weekly commitments (£330 wages / £140 top-up Fridays) | BESPOKE → standing orders config |
| Withdrawal algorithm + safety floor | UNIVERSAL |
| What-if exclusions, 4-line chart | UNIVERSAL |
| Universal Credit uncertainty flags | VERTICAL |
| AI reconciliation accuracy KPI (31-day) | MODULE: Finance |
| Fintable sync alert banner + sidebar badge | MODULE: Finance |
| Santander + TNT Zempler balance display | BESPOKE → account selector |
| IndexedDB stale-while-revalidate cache | UNIVERSAL |

**Open questions:** should AI recon accuracy be on by default; per-business vs global KPI filtering default.

### 2.2 Tasks & Projects (`tasks`) — Spine (Command Centre)

**Purpose:** multi-view task and project management: My Day, List, Kanban, Projects, Capacity, Recurring.

**Day-one client offer:** My Day calendar scheduling, task list with inline edit and bulk actions, 4-week Kanban, 14-day per-person capacity, recurring tasks with auto-roll, Slack assignment/completion notifications, auto-derived statuses, sync health bar.

| Feature | Class |
|---|---|
| My Day / List / Kanban / Capacity / Recurring tabs | UNIVERSAL |
| Projects tab with linked-task counts and KPI bars | UNIVERSAL (KPI detail = MODULE: Strategy & Execution) |
| Auto-scheduler (calendar, hard deadlines, project pinning) | UNIVERSAL |
| Slack notifications via worker | UNIVERSAL (per-client Slack config) |
| Hard-deadline immobilisation, "past Sunday" project rule | UNIVERSAL (promote, document in onboarding) |
| Contractor Tasks tab (Gary/Rob/Roy maintenance board) | VERTICAL (generalise later as "Outsourced Tasks" extra) |
| Kevin-only overdue auto-pull-forward | BESPOKE → per-user opt-in toggle |
| Gary Slack email override | BESPOKE → generic slackEmail field on Team Members |
| Strategy → Projects AI task extraction | MODULE: Strategy & Execution |

**Open questions:** recurring model (rolling record vs spawn-on-complete) comprehension for generic clients; contractor tab generalisation demand.

### 2.3 Operations (`operations`) — Spine (Operations CRM)

**Purpose:** currently a property CRM (Tenants, Tenancies, Units, Properties, Customers, Compliance).

**Day-one client offer (generic rebuild):** Customers/Contacts CRM: lifecycle stages (Lead → Onboarding → Active → Churned), search/filter, detail drawer with linked transactions and tasks, sync bar. The current Customers tab placeholder becomes the main event.

| Feature | Class |
|---|---|
| Customers tab (lifecycle CRM) | UNIVERSAL — build this out as the generic page |
| Tenants / Tenancies / Rental Units tabs | VERTICAL |
| Properties tab (value, mortgage, LTV, yield, cash-on-cash) | VERTICAL |
| Valuation history + AI valuation button | VERTICAL |
| Compliance iframe tab | VERTICAL |
| Field resolver (metadata API + keyword matching) | UNIVERSAL |
| Drawer + inline transaction expansion | UNIVERSAL |

**Open questions:** what entity model the generic CRM needs day one (customers only, or customers + suppliers); whether derived per-entity revenue ("Rent/mo" pattern) generalises to "Revenue per customer".

### 2.4 Team Members (`os-team`) — Spine (Team)

**Purpose:** people OS: directory, onboarding, org chart, training, reviews, handbook, achievements.

**Day-one client offer:** directory with search/status/department filters, member drawer, onboarding checklist tracker, org chart from Reports To, handbook shell, achievements feed.

| Feature | Class |
|---|---|
| Directory, drawer, status chips, dept filter | UNIVERSAL |
| Onboarding/offboarding tracker | UNIVERSAL |
| Org chart | UNIVERSAL |
| Handbook | UNIVERSAL (client supplies content) |
| Achievements feed | UNIVERSAL |
| Training coverage matrix (joins to workflows) | MODULE: Systemisation |
| Performance reviews | MODULE: Systemisation (or future HR extra) |
| Named avatar CSS classes (kevin/mica/erica/gary/rob/roy) | BESPOKE → dynamic avatar pool |

**Open questions:** where reviews live long-term; achievements moderation rights.

### 2.5 Objective & Strategy (`os-strategy`) — MODULE: Strategy & Execution

**Purpose:** quarterly planning: annual Objective plan + rolling 90-day Strategy plan, pushed into Projects.

**Day-one client offer:** full Objective template (objective, target, customer, undertakings, USPs, method, enticement), Strategy template (9yr/3yr/1yr + 3 quarterly projects with monthly stones, KPI, owner, DoD), push-to-Projects with AI task extraction, PDF export, Boardroom Mentor wizard.

| Feature | Class |
|---|---|
| Objective + Strategy plan templates, per business per quarter | MODULE: Strategy & Execution |
| Quarterly → Projects push + AI task extraction | MODULE: Strategy & Execution |
| Boardroom Mentor AI wizard | MODULE: Strategy & Execution (needs per-client profile, see D2) |
| PDF export | MODULE: Strategy & Execution |

Nothing on this page is Kevin-specific except the AI proxy URL and the mentor prompt voice. Cleanest page in the platform.

**Open questions:** wizard behaviour with no prior quarter (first-run experience); auto-save vs manual save.

### 2.6 Business Launch Plan Builder (`os-bplan`) — MODULE: Strategy & Execution

**Purpose:** conversational AI wizard producing a full business plan PDF.

**Day-one client offer:** the whole page as-is: chat wizard, section tracker, review/edit, plan preview, PDF export. No Kevin data anywhere in it.

| Feature | Class |
|---|---|
| Everything | MODULE: Strategy & Execution |

**Open questions:** API cost per generated plan and whether plan runs are metered; plan storage (one-time PDF vs saved history).

### 2.7 Systemisation (`systemisation`) — MODULE: Systemisation

**Purpose:** workflow/process framework with AI-vs-staff step typing and SOP auto-generation. This page is the engine of the process-to-agent pipeline and the 90% AI north star.

**Day-one client offer:** pipeline stages, workflow cards, step tables with AI/Staff/Both typing, SOP auto-generation and viewer, resources panel (Loom, docs), bulk step management.

| Feature | Class |
|---|---|
| Everything on the page | MODULE: Systemisation |
| Demo/seed data | Replace with a starter workflow template pack per client |

**Open questions:** whether steps auto-create tasks in Command Centre (currently manual); workflow status auto-derivation from step completion.

### 2.8 CFVs (`cfv`) — MODULE: Finance core + VERTICAL implementation

**Purpose:** detects expected payments that failed to land, runs a chase pipeline with audit trail.

**Day-one client offer (Finance module):** "Payments at risk" — detection of missed expected recurring payments (from Recurring Revenue records), status pipeline (Potential → Confirmed → Actioned → In Payment), dismissals, comment audit trail, exposure KPIs, sidebar badges. The rent/tenancy implementation, Section 8 flag (62 days), UC tolerances, and rent statements ship only in the vertical pack.

| Feature | Class |
|---|---|
| Detection engine, status pipeline, dismissals, comments, badges, KPIs | MODULE: Finance |
| Rent statements, daily balance, printable statement (arrears.js) | VERTICAL |
| Section 8 readiness flag (62 days) | VERTICAL |
| UC recurring task automation (hardcoded Mica assignee, field IDs) | BESPOKE within VERTICAL → configurable assignee |
| DATA_START cutoff 2025-04-01 | BESPOKE → per-client data-start config |
| explainCFV console tool | BESPOKE (dev tool, keep internal) |

**Open questions:** tolerance days as client setting; whether the generic version launches with the Finance module or waits for Recurring Revenue to exist.

### 2.9 Money Confidence (`money`) — MODULE: Finance

**Purpose:** one conservative "Safe to Act Today" figure with traffic light, protecting wages float and fixed-cost cover.

**Day-one client offer:** Safe to Act Today from nominated operating accounts, editable wages/drawings float, payment-lag cushion, fixed-cost cover shortfall, traffic light, full auditable breakdown. Without the property vertical the rent haircut degrades gracefully to cleared balance minus floor minus fixed costs.

| Feature | Class |
|---|---|
| Safe to Act Today engine, traffic light, breakdown | MODULE: Finance |
| Rental income bucketing + non-payment haircut | VERTICAL |
| Santander/TNT Zempler account IDs, £1,500 wages target | BESPOKE → config |

**Open questions:** module home confirmed as Finance (business cash) rather than Personal Wealth — see decision D5; haircut basis (current month vs trailing 3 months) for the vertical version.

### 2.10 Wealth (`wealth`) — MODULE: Personal Wealth

**Purpose:** net worth by month across six classes, debt amortisation, personal budgets, income buckets, cash flow.

**Day-one client offer:** monthly net worth snapshots with auto roll-forward, live cash/credit-card classes from connected accounts, manual classes (Loans, Businesses, Investments), debt amortisation engine, personal expenditure vs budget with drill-down, income buckets with % allocations, 12-month rolling matrices, AI document reader, staleness alerts.

| Feature | Class |
|---|---|
| Net worth snapshots, roll-forward, matrices, buckets, budgets, debt terms, AI doc reader | MODULE: Personal Wealth |
| Per-property valuations, AI valuation approval workflow, equity per property, orphan-mortgage flags | VERTICAL |
| Account exclusions ('Hyper Jar', 'Operations Director - ANNA'), 11 personal expense sub-categories, bucket names, property-name matching | BESPOKE → per-client config |

**Open questions:** fixed six classes vs client-defined classes; default personal category template; bucket defaults.

### 2.11 AR Fixed (`income`) — VERTICAL today; generic rebuild = "Recurring Revenue" in MODULE: Finance

**Purpose:** currently a tenancy rent roll with CFV statuses and payment-type segmentation.

**Day-one client offer (generic rebuild):** Recurring Revenue register: retainers, subscriptions, service contracts, rent. Amount, due day, frequency, customer link, payment status, collection-rate KPI, breakdowns by customer/business. This record type is what feeds the generic CFV detection (2.8).

| Feature | Class |
|---|---|
| Entire current page (tenancies, UC segmentation, CFV links) | VERTICAL |
| Recurring-revenue pattern extracted from it | MODULE: Finance (rebuild) |

**Open questions:** minimum viable fields for generic recurring revenue; whether the rebuild lands before or after Supabase migration.

### 2.12 AR Variable (`ar-variable`) — MODULE: Finance

**Purpose:** outbound customer invoices: status, ageing, outstanding totals.

**Day-one client offer:** the page nearly as-is: invoice register with Draft/Sent/Overdue/Paid/Written Off, overdue auto-computation, outstanding and ageing KPIs, filters and sorting.

| Feature | Class |
|---|---|
| Everything | MODULE: Finance |
| en-GB date hardcoding, placeholder-table check | BESPOKE polish → locale + connectivity checks |

**Open questions:** partial payments; disputed status; ageing buckets report.

### 2.13 AP Fixed (`costs`) — MODULE: Finance

**Purpose:** recurring fixed costs with reconciliation, overdue detection, variance flags.

**Day-one client offer:** fixed-cost register (amount, due day, frequency), reconciliation against bank transactions, overdue/variance detection, category breakdown, monthly burn KPI, inline edits.

| Feature | Class |
|---|---|
| Core register, reconciliation, variance, KPIs | MODULE: Finance |
| Payment drift tracking, AI analysis | MODULE: Finance |
| Variance thresholds (£1 / 2% / 10%) | BESPOKE → client config |
| Cost→Property link | VERTICAL |
| Derived-field write-back to Airtable | BESPOKE architecture → resolve in Supabase design (D6) |

### 2.14 AP Variable (`invoices`) — MODULE: Finance

**Purpose:** supplier invoice inbox synced from Gmail, AI-matched to bank transactions.

**Day-one client offer:** unpaid invoice register with AI transaction matching, approve/mark-paid flows, inline edits, bulk actions, sync health. Email ingestion configured per client at onboarding (their Gmail + their labels), not Kevin's Apps Script deployment.

| Feature | Class |
|---|---|
| Invoice register, AI matcher, approve flow, bulk actions | MODULE: Finance |
| Gmail Apps Script URL + label names ("3. to pay", "4: paid") | BESPOKE → per-client onboarding config |
| Keyword stop-list for matching | BESPOKE → configurable list |

**Open questions:** non-Gmail clients (Outlook/portal ingestion) — extra, not day one.

### 2.15 Profit & Loss (`pnl`) — MODULE: Finance

**Purpose:** monthly P&L by business with drill-down to transactions, AI analysis, trend charts.

**Day-one client offer:** 12-month P&L grid from the client's own chart of accounts, GP/NP margins, four charts, cell drill-down with inline recategorisation, AI analysis with client-specific targets, business and period filters.

| Feature | Class |
|---|---|
| Grid, charts, drilldown, inline categorisation, sync checks | MODULE: Finance |
| AI analysis panel | MODULE: Finance (prompt parameterised per client) |
| Targets (£35k revenue, 80% GP, 15% NP, £5k profit, £3k maint, £1.5k wages) | BESPOKE → Finance setup wizard |
| Property COGS sub-categories | VERTICAL (grid already renders only populated rows) |

### 2.16 Transactions (`transactions`) — MODULE: Finance

**Purpose:** virtual-scrolling explorer of all transactions with inline categorisation and the reconciliation engine.

**Day-one client offer:** full transaction explorer (search, 8 filters, sort, CSV export, insights), inline category/business editing, AI reconciliation panel with pattern learning and knowledge base, accuracy audit.

| Feature | Class |
|---|---|
| Explorer, filters, inline edit, CSV, insights | MODULE: Finance |
| Reconciliation engine, pattern learning, knowledge base, split transactions | MODULE: Finance |
| Tenant/Tenancy/Unit/Property columns and auto-fill ("Real Estate"/"Revenue"/"Rental Income") | VERTICAL |
| Fintable exclusion list (7 named accounts) | BESPOKE → checkbox on Accounts records |
| Knowledge base in localStorage | BESPOKE limitation → server-side per client in Supabase |

### 2.17 Bank Accounts (`fintable`) — MODULE: Finance

**Purpose:** bank account sync monitor for Fintable-connected accounts.

**Day-one client offer:** account list with sync freshness tiers (24h/72h/7d), balance display, dashboard alert banner, sidebar badge.

| Feature | Class |
|---|---|
| Everything | MODULE: Finance |
| Hardcoded exclusion list | BESPOKE → config |

### 2.18 Inbound Comms (`comms`) — MODULE: Inbound Comms

**Purpose:** Gmail triage with AI label suggestions, follow-up drafting, and label-triggered automations.

**Day-one client offer:** Google login, age-prioritised email list, AI label suggestions with accuracy tracking and self-building knowledge base, follow-up drafting with revise loop, label→task automation (create/complete tasks from labels), newsletter/unsubscribe handling, audit log, settings.

| Feature | Class |
|---|---|
| Triage, AI labels, knowledge base, drafting, search, audit | MODULE: Inbound Comms |
| Label→task create/complete automations | MODULE: Inbound Comms |
| Label 3 → invoice sync | MODULE: Finance integration (per-client config) |
| Label 10 compliance cert extraction | VERTICAL |
| Label 11 tenancy doc auto-linking | VERTICAL |
| GoHighLevel SMS bridge | MODULE: Inbound Comms premium extra |
| Label numbering scheme 1-14, sender name "Kevin", hardcoded proxy URLs | BESPOKE → editable label map + client settings |

**Open questions:** whether the 1-14 label taxonomy ships as an opinionated standard (recommended) or fully client-defined.

### 2.19 Property Compliance (`compliance`) — VERTICAL

**Purpose:** GSC/EICR/insurance certificate tracking per property and unit.

**Day-one client offer:** none for generic clients. Property Management pack clients get certificate tracking with expiry tiers, block vs standard rules, self- vs agent-managed split.

| Feature | Class |
|---|---|
| Whole page | VERTICAL |
| Hardcoded cert types (3), agent name list (6), 30-day threshold | BESPOKE within VERTICAL → config |

### 2.20 Content Machine (`content-machine`) — MODULE: Content Machine

**Purpose:** marketing content production app (separate repo `chaichoong/content-machine`).

**Day-one client offer:** the app as an iframe page in the marketing section. Genericisation (branding, GHL account wiring, Kevin-specific channels) handled at its pending merge/integration, in its own repo.

### 2.21 Skills Library (`skills`) — Spine

**Purpose:** browse, search and run the AI skills that do the clients' operational work. The visible face of "AI agents run your operations".

**Day-one client offer:** preset skills library, category/tag search, command palette (Cmd+K), skill runner chat modal, custom skills fed from the client's SOP/Systemisation workflows.

| Feature | Class |
|---|---|
| Library, search, runner, palette | UNIVERSAL |
| SOP-generated skills feed | MODULE: Systemisation integration |
| Kevin's preset catalogue (skills-data.js: tenancy enders, UC forms, etc.) | Split: generic presets stay; property/personal presets → VERTICAL/BESPOKE entries |
| Settings table/record IDs, proxy URL | BESPOKE → per-client config |

**Open questions:** which of the current presets make the generic starter set (needs a one-pass curation of skills-data.js).

### 2.22 Site Map & Guides (`sitemap`) — Internal ops tool

**Purpose:** page/SOP version drift tracking against GitHub, SOP update queue.

**Recommendation:** this is tooling for running the OD service, not a client feature. Keep it in Kevin's build; give clients a simple "Guides" page listing their SOPs instead. See decision D8.

### 2.23 AI Brain (`ai-brain`) — BESPOKE

**Purpose:** Kevin's personal second brain feed (Apple Notes, Drive, Zoom, nightly filing).

**Day-one client offer:** none. Catalogued as a future premium extra ("Founder Brain") requiring per-client capture pipelines. Remove from client sidebar.

### 2.24 How It Works (`how-it-works`) — Spine (pattern)

**Purpose:** visual architecture map of the platform.

**Day-one client offer:** keep the page pattern; redraw content to the generic product architecture (remove Strava, personal Zoom/Slack/Apple Notes nodes). Long-term: generate per client from their enabled modules.

### 2.25 Shell, AI Assistant, Quick Task — Spine

**Day-one client offer:** sidebar shell with department sections and health dots, module-gated nav items, AI assistant panel on every page (SOP-as-context, page-state context, quick actions), quick task FAB, command palette, share-page links.

| Feature | Class |
|---|---|
| Shell, tabs, health dots, auth | UNIVERSAL |
| AI assistant panel, SOP context loader, model routing | UNIVERSAL |
| Quick task FAB | UNIVERSAL |
| Boardroom Mentor prompt (Kevin's voice, goals, non-negotiables) | BESPOKE → per-client mentor profile generated at onboarding (D2) |
| "Kevin Brittain • Founder" sidebar identity | BESPOKE → dynamic from client profile |
| PAGE_PURPOSES descriptions | UNIVERSAL (reword rent-specific lines with module-aware text) |

---

## 3. Optional Extras Register (Kevin's customisations, offered on request)

Effort = rough per-client enablement effort once the platform is multi-tenant. These are NOT in the generic build.

| # | Extra | What it does | Likely asker | Effort |
|---|---|---|---|---|
| E1 | Contractor job board | Maintenance-style task board grouped by location/asset, no due dates, priority+age sort | Trades, property, field services | Med |
| E2 | Overdue auto-pull-forward | Overdue tasks pulled to today on load for one named user | Founders drowning in backlog | Low |
| E3 | UC verification task automation | Auto-creates verification tasks 7 days before benefit-paid income dates, pause/resume by payment status | UK landlords with UC tenants | High |
| E4 | Section 8 readiness flag | Flags 62+ days arrears as court-ready | UK landlords | Low |
| E5 | Printable statements | Date-range statement generator with running balance (rent statement pattern) | Any client owed recurring money | Med |
| E6 | AI property valuations | Monthly AI comparable-based valuations with approve/reject workflow | Property portfolio owners | High |
| E7 | Per-asset equity cards | Value/debt/equity per asset with orphan-debt flags | Asset-heavy clients | Med |
| E8 | Email→record extraction (compliance pattern) | AI reads inbound docs from a label, extracts fields, creates linked records | Any client with document-heavy email | High |
| E9 | E-sign doc auto-linking | Detects fully-signed DocuSign/Adobe emails, links to the right record | Lettings, legal, sales-contract businesses | High |
| E10 | GoHighLevel SMS bridge | Inbound SMS rendered in comms, replies routed back through GHL | Service businesses on GHL | Med |
| E11 | Founder Brain (AI Brain) | Personal second-brain capture, nightly filing, ask-your-brain | Knowledge-heavy founders | Very High |
| E12 | Weekly cash commitments | Named weekly outflows deducted from forecast on set weekdays | Clients with weekly payroll | Low |
| E13 | Credit-card runway projection | Months-to-clear per card at current surplus | Card-financed businesses | Low |
| E14 | Variance dismissal memory | Sticky per-cost variance dismissals until next reconciliation | Detail-oriented finance clients | Med |
| E15 | Custom certificate types | Additional compliance cert types beyond the standard set | Regulated trades (PAT, asbestos, fire) | Med |
| E16 | Outbound invoice non-Gmail ingestion | Outlook/portal/Zapier invoice capture instead of Gmail labels | Non-Google clients | High |

---

## 4. Platform-wide de-Kevining checklist

Hardcodes that must become per-client configuration in the Supabase build, wherever they appear:

1. **Identity:** "Kevin Brittain • Founder" sidebar header; default sender name "Kevin".
2. **Team:** TASK_TEAM emails (Kevin, Mica, Erica, Gary, Rob, Roy), collaborator cascades, Gary's Slack email override, named avatar CSS classes.
3. **Accounts:** Santander/TNT Zempler record IDs, credit-card record IDs, Fintable exclusion list (7 aliases), Wealth exclusions (Hyper Jar, OD-ANNA).
4. **Thresholds/targets:** £35k revenue, 80% GP, 15% NP, £5k profit, £3k maintenance, £1.5k wages targets; £1,500 wages float; variance tolerances (£1/2%/10%); CFV tolerance 2 days; 62-day S8; 30-day cert expiry; DATA_START 2025-04-01.
5. **Infrastructure URLs:** claude-proxy.kevinbrittain.workers.dev, slack-notify.kevinbrittain.workers.dev, sms-email-bridge.kevinbrittain.workers.dev, Gmail Apps Script deployment, chaichoong GitHub repo references.
6. **Airtable coupling:** base ID appnqjDpqDniH3IRl, every hardcoded table/field ID, Gmail label strings ("3. to pay", "4: paid"), select-option record IDs. The Supabase schema replaces these wholesale; this list is the audit trail.
7. **AI voice:** js/prompts/boardroom-mentor.js is Kevin's strategic voice and must never ship to a client; each client gets a generated mentor profile.
8. **localStorage state that must go server-side per client:** reconciliation knowledge base, comms knowledge base, active skill IDs.

---

## 5. Decisions Kevin must make before the Supabase build encodes the generic version

- **D1 — Operations CRM entity model.** Generic day one: customers only, or customers + suppliers + generic "assets"? Determines the spine CRM schema.
- **D2 — Mentor profile onboarding.** Approve building a "Boardroom Mentor profile" setup step (goals, non-negotiables, decision rules → generated per-client prompt). Without it every AI feature speaks with Kevin's voice.
- **D3 — Recurring Revenue rebuild timing.** The generic AR Fixed replacement (2.11) and generic CFV (2.8) depend on it. Build during migration, or ship Finance module v1 without payments-at-risk?
- **D4 — Skills starter set.** Which presets in skills-data.js ship to every client (needs a curation pass; property and personal skills excluded by default).
- **D5 — Money Confidence module home.** Recommended: Finance (it is business cash, not personal wealth). Confirm, since the module split doesn't name it.
- **D6 — Derived-field write-back.** Costs page writes computed fields back to the source table. In Supabase: computed views (recommended) or persisted columns. One-line decision, big schema consequence.
- **D7 — Inbound Comms label taxonomy.** Ship the numbered 1-14 label scheme as an opinionated standard (recommended, faster onboarding) or client-defined labels (flexible, slower).
- **D8 — Site Map page.** Confirm it stays internal-only, with clients getting a simple Guides list instead.
- **D9 — AI cost policy.** Plan Builder, Boardroom Mentor, SOP generation and valuations spend real API money per use. Fair-use within module price (recommended at current scale) or metered?

---

*Maintenance rule: when a page's generic offer changes (feature promoted, extra enabled for all, new page added), update this file in the same commit. When the Supabase build implements a page, record the decision outcomes (D1-D9) here.*
