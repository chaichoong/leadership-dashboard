# Client Profile Questionnaire — extraction spec

The onboarding wizard's question set. Method: every piece of Kevin-specific information the platform relies on today was traced to its source (see PRODUCTISATION.md section 4), and each one becomes a question that extracts the same information from a client. If the platform knows it about Kevin, this document defines how we learn it about a client.

Three capture moments:
- **CALL** — discovery call (human, 30-45 min). Judgement questions.
- **WIZARD** — the smart AI interview after the call (Business Plan Builder chat pattern). Factual questions, one at a time, plain English.
- **US** — we derive it or set an opinionated default. The client is never asked.

Every row states what we hold for Kevin today (the source), the question that extracts the client equivalent, and what their answer powers on screen.

---

## Section 1 — Identity and businesses

| We hold for Kevin (source) | Question to the client | Powers |
|---|---|---|
| "Kevin Brittain • Founder" (index.html sidebar) | WIZARD: "What's your name, and what do you call your role?" | Sidebar identity, AI assistant greeting |
| 3 businesses: Real Estate, Operations Director, Runpreneur (Businesses table, Active flags) | WIZARD: "What business(es) do you run? One line on what each does and roughly what it turns over. Which is the main one?" | Businesses table, business filter pills on Dashboard/P&L/Transactions, per-business KPIs |
| Business type knowledge baked into AI prompts ("UK property management micro-business", pnl.js) | WIZARD: "How would you describe your business to a stranger in one sentence? Who do you sell to?" | Every AI analysis prompt, mentor context |
| UK locale, en-GB dates, GBP (ar-variable.js and throughout) | WIZARD: "Where are you based? What currency do you work in?" | Date/currency formatting platform-wide |

## Section 2 — Team

| We hold for Kevin (source) | Question to the client | Powers |
|---|---|---|
| TASK_TEAM: 6 people with emails (config.js) — Kevin, Mica, Erica, Gary, Rob, Roy | WIZARD: "Who works in or on the business? For each: name, email, what they do, and whether they're staff, a VA, or an outside contractor." | Team Members table, task assignees, Directory, Capacity tab, logins |
| Reports-to hierarchy (Team OS org chart) | WIZARD: "Who reports to whom?" (skip if team of 1-2) | Org chart |
| Gary's Slack email differs from his Airtable email (os/tasks hardcode) | WIZARD: "Does anyone use a different email on Slack/chat than the one you gave me?" | Slack notification routing |
| Kevin+Mica+Erica auto-added as project collaborators (os/tasks hardcode) | US: default = founder plus their named right hand. WIZARD confirm: "Who should automatically be kept in the loop on every project?" | Collaborator cascades, notifications |
| UC task assignee micaa.work@gmail.com (arrears.js) | Property pack only: "Who handles rent chasing and benefit verification?" | Vertical automation assignee |

## Section 3 — Bank accounts and cards

| We hold for Kevin (source) | Question to the client | Powers |
|---|---|---|
| Santander + TNT Zempler = cleared/operating accounts (money.js, dashboard.js REC ids) | WIZARD: "List your business bank accounts. Which one or two do you actually run the business from day to day?" | Cash position card, Money Confidence "Safe to Act Today", forecast opening balance |
| AmEx, Santander CC, Lloyds CC (cashflow.js credit card summary) | WIZARD: "Any business credit cards? Rough balance and payment day?" | Credit card summary, Wealth liabilities |
| Fintable exclusion list: 7 personal/side accounts (fintable.js) | WIZARD: "Any accounts we should connect but keep OFF your dashboards (personal, dormant, side projects)?" | Sync monitor scope, dashboard cleanliness |
| Fintable bank feeds active (Accounts table) | CALL: "We connect your accounts through a bank feed so numbers update themselves. OK to set up?" (consent + credentials session) | Live balances, transactions, everything financial |

## Section 4 — Money structure (chart of accounts)

| We hold for Kevin (source) | Question to the client | Powers |
|---|---|---|
| Categories/sub-categories incl. 4 property COGS lines (Categories + SubCategories tables, pnl.js allow-list) | US: standard template (Revenue fixed/variable, COGS, staffing, marketing, premises, software, professional, travel, supplies, finance, tax). WIZARD tune: "What are your 3 biggest costs? Anything unusual about how money comes in or goes out?" | P&L grid rows, transaction categorisation, reconciliation, AI analysis |
| Revenue split fixed/variable/rental (P&L sections) | WIZARD: "Of your income, what repeats every month (retainers, subscriptions, rent) and what varies (one-off jobs, sales)?" | Revenue lines, Recurring Revenue register, CFV detection |
| 11 personal expense sub-categories (wealth.js) | Personal Wealth module only: US default template (essentials, food and drink, lifestyle, transport, travel, health, tax, fees, debt). WIZARD tune: "Any personal spending category you specifically watch?" | Personal expenditure tracking vs budget |

## Section 5 — Targets, budgets, thresholds

| We hold for Kevin (source) | Question to the client | Powers |
|---|---|---|
| £35k/mo revenue target (pnl.js) | WIZARD: "What monthly revenue are you aiming for this year?" | P&L target lines, AI analysis, Dashboard KPIs |
| £5k/mo net profit, 80% GP, 15% NP targets (pnl.js) | WIZARD: "What monthly profit would make you happy?" US: propose margin targets from their first 3 months of data, confirm later | P&L cards, charts, AI analysis |
| £1,500/mo wages float (money.js WAGES_TARGET_GBP) | WIZARD: "How much do you pay yourself each month, minimum?" | Money Confidence floor |
| £500 safety buffer (cashflow.js) | WIZARD: "What's the lowest your main account should EVER go?" | Withdrawal algorithm, traffic light |
| £3k maintenance / £1.5k wages / £1.5k CFV monthly reserves (cashflow.js) | WIZARD: "Roughly how much a month should we set aside for surprises (repairs, cover, bad debts)?" one figure or per-category | Worst-case forecast line |
| Variance tolerances £1 / 2% / 10% (costs.js) | US: ship defaults, tune from their data. Never asked | Bill variance flags |
| CFV tolerance 2 days, 30-day cert expiry warning, 62-day S8 (cfv/arrears/compliance) | US: defaults; S8 and certs are Property pack only | Payments-at-risk timing, compliance alerts |
| £50 act / £250 escalate decision thresholds (global CLAUDE.md, mentor prompt) | WIZARD: "Below what amount should we just act? Above what amount must we always ask you first?" | Mentor prompt, future agent autonomy limits |

## Section 6 — Regular money in and out

| We hold for Kevin (source) | Question to the client | Powers |
|---|---|---|
| Tenancies rent roll: amount, due day, frequency, payer (Tenancies table) | WIZARD: "List every regular payment you EXPECT to receive: from whom, how much, what day, how often." (rent goes here for Property pack clients) | Recurring Revenue register, cash flow inflows, payments-at-risk detection |
| Costs table: fixed costs with expected amount, due day, frequency | WIZARD: "List your regular bills: name, rough amount, day of the month, frequency. Don't worry about completeness, the bank feed will catch strays." | AP Fixed register, forecast outflows, overdue detection |
| Weekly commitments £330 wages + £140 top-up Fridays (cashflow.js) | WIZARD: "Anything you pay weekly rather than monthly (wages, subcontractors)? Which day?" | Weekly forecast deductions |
| DATA_START 2025-04-01 (arrears.js) | WIZARD: "From what date onwards are your bank records clean and trustworthy?" | Data import cutoff, statement maths |

## Section 7 — Email and comms routing

| We hold for Kevin (source) | Question to the client | Powers |
|---|---|---|
| Gmail account with OAuth (follow-up.html) | CALL: "Is your business email on Google? We plug into it to triage and draft for you." (Outlook = Optional Extra E16, do not promise day one) | Inbound Comms module entirely |
| Numbered label taxonomy 1-14 ("3. to pay", "4: paid" etc.) | US: install our standard label set. WIZARD: "When an email needs a human, who should it go to: you or a team member?" | AI triage, label→task automation |
| Label→task routing to named people (follow-up automations) | WIZARD: "Which kinds of email should turn into tasks, and for whom? (e.g. supplier invoices, customer enquiries, complaints)" | Task auto-creation rules |
| Sender name "Kevin" (settings default) | US: from Section 1 name | Follow-up draft signatures |
| GHL SMS bridge (Kevin's worker URL) | CALL: only if they mention SMS/GoHighLevel. Optional Extra E10 | SMS in comms inbox |

## Section 8 — Tools already in use

| We hold for Kevin (source) | Question to the client | Powers |
|---|---|---|
| Slack workspace + notify worker (os/tasks) | WIZARD: "Does the team use Slack, WhatsApp, or Teams day to day?" Slack = wire notifications now; others = catalogue | Task/completion notifications |
| Kevin's stack: GoHighLevel, WordPress, Fintable, Zoom, Loom (global context) | WIZARD: "Quick inventory: what do you use for calendar, accounting (Xero/QuickBooks?), CRM, phone, video calls?" | Integration roadmap, extras planning, mentor context |
| Loom for process capture (process-to-agent pipeline) | US: we provide the recording approach at first-robot time. No question | Phase 5 |

## Section 9 — Goals, rules and mentor voice

Source for all rows: js/prompts/boardroom-mentor.js plus Kevin's global CLAUDE.md. This section GENERATES the client's own mentor prompt. Never reuse Kevin's.

| We hold for Kevin | Question to the client | Powers |
|---|---|---|
| 10-year vision, 7-figure exit, quarterly goals | CALL: "Where do you want this business to be in 12 months? And in 3 years?" | Mentor prompt goals block, Strategy page seed |
| £10k/mo personal income floor, protected thresholds | WIZARD: "What's the minimum monthly income your household needs, no exceptions?" | Mentor accountability, Money Confidence floor cross-check |
| Non-negotiables (streak, health, family, no scaling before optimising) | WIZARD: "Name up to five things that must never be sacrificed for the business (health, family time, a day off, a side commitment)." | Mentor prompt non-negotiables, workload warnings |
| Decision framework (OCI, reversible/irreversible, ROI lens) | US: standard OD decision framework ships to every client; their £ thresholds from Section 5 slot in | Mentor decision guidance |
| Ruthless accountability, no sugar-coating style | WIZARD: "When the numbers look bad, do you want it straight and blunt, or supportive with options?" | Mentor tone |
| Writing style rules (UK English, no fluff) | WIZARD: "UK or US English? Anything that annoys you in how AI writes?" | All AI output style |
| Legal/financial sensitivity flag (private matter, extra caution) | CALL: "Anything sensitive we should be extra careful with in writing (disputes, legal, partners)?" Stored as a flag, details never in prompts | Mentor caution rules |

## Section 10 — Module add-on capture (only for modules purchased)

| Module | We hold for Kevin (source) | Client questions |
|---|---|---|
| Personal Wealth | 6 asset classes, debt terms (principal/rate/term/type), income buckets, excluded accounts (wealth.js + Airtable Wealth tables) | "List what you own that counts toward net worth, and every loan/mortgage: amount, rate, term. How do you want spare cash split each month (tax pot, fun, investing)?" |
| Property pack | 27 properties, units, tenancies, agents list, cert types, UC tenants (Operations CRM + compliance.html) | "List properties and units; per tenancy: who, rent, due day, how they pay (working/benefits/agent). Which agents manage which? Gas/EICR/insurance renewal dates?" |
| Strategy & Execution | Current quarter Objective/Strategy records (objStrat table) | None extra: the Boardroom Mentor wizard's first session IS the capture (uses answers from Section 9) |
| Content Machine | Kevin's brand/channels (content-machine repo, GHL) | "Which channels do you publish on? Brand voice in three words? Who writes today?" |
| Inbound Comms premium | GHL SMS config | Covered in Section 7 |

## Section 11 — First robot candidates (asked on the CALL, feeds Phase 5)

Kevin's equivalents: reconciliation engine, invoice matching, email triage, UC task automation, meeting logging — all jobs he hated doing manually and turned into automations.

- CALL: "Name the three jobs you do every week that you'd pay to never do again."
- CALL: "Which of those follows the same steps every time?" That one becomes the first Loom video and the first live agent.
- US: we score the three against the extras register and existing skills; if one already exists as a skill (invoice matching, email triage), the first robot can be live in week 1 instead of week 4.

---

## What we deliberately do NOT ask

Opinionated defaults, tuned later from their data or via the request queue: label taxonomy numbering, chart-of-accounts template detail, variance tolerances, KPI card layout, design/theme, sync thresholds, task statuses and priorities, recurring-task model. Asking would add onboarding friction without better answers than their live data will give us within a month.

## Coverage check

Every hardcode in PRODUCTISATION.md section 4 (de-Kevining checklist) maps to a row above: identity (S1), team (S2), accounts (S3), thresholds and targets (S5), infrastructure URLs (US: per-tenant provisioning, not questions), Airtable/Supabase coupling (US: schema, not questions), AI voice (S9), server-side state (US). If a future feature adds a new Kevin-specific value, add the extracting question here in the same commit.
