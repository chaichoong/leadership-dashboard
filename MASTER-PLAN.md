# Operations Director — Master Plan

**THE one plan. There is no other.** Every session (Fable, Opus, Cowork), every team member, and every future roadmap conversation works from this document. Amend it, never fork it. If you are Claude and you are about to create a plan, roadmap, or task list for Operations Director: STOP and edit this file instead.

- Owner: Kevin. Maintainer: any Claude session.
- Canonical location: repo root `MASTER-PLAN.md`.
- Legend: `[ ]` open · `[x]` done · `[~]` in progress · `[D]` dropped (reason in Changelog)
- Lanes: **KEVIN** · **MICA** · **ERICAMAE** · **OPUS** (any Claude build session)
- OPUS driver rule (Kevin, 7 Jul): hybrid by lane — Kevin runs product/shared-file/security/worker Opus tasks; Mica runs migration-lane Opus tasks; every OPUS task has a named human owner in Airtable who starts the session and ticks the box.
- Task format: one action, one owner, one sitting, binary done-test in brackets. `[AT:recXXX]` = existing Airtable task record.

---

## 0. How this plan changes (the protocol)

1. **One plan.** No session creates a new plan, roadmap, or task-list doc for OD. Additions come here.
2. **Every change is dated and sourced** in the Changelog (§11): "Kevin, team meeting 14 Jul", "Hormozi transcript via brain", "Opus session, bug found".
3. **Tasks are never silently deleted or reworded.** Done stays `[x]`. Dropped becomes `[D]` with a reason logged.
4. **Learning material goes through the holding pen.** Ideas from transcripts, mentor calls, or KOL content land in §10 Proposed Amendments. Kevin approves; then they lock in as tasks. Never straight into the live list.
5. **Structural changes** (new phase, scope change, new module) need Kevin's explicit approval before locking.
6. **Airtable is the team's working copy; this file is canonical.** New tasks flow plan → Airtable (project "Launch & First Revenue"). Status flows back at each weekly review.
7. **Weekly review** at the Monday team check-in: tick, re-sequence, log.

## 1. The goal line

Live, taking money, generating leads, and delivering what we sell:
- Launch: **1 August 2026**.
- **2 design partners signed by 31 July.**
- 9 clients / £5k MRR by end-2026. 50 clients is the multi-year cap, not the year-one goal.
- Deliver = client's first AI agent live inside a month of signup.

## 2. Where we are (snapshot 7 Jul 2026 — update each review)

- Product 78% / GTM 40% (2 Jul audit). Funnel pages BUILT and Stripe-tested at locked pricing (£1,500 setup + £350/mo + 30-day trial — simple swap locked 29 Jun; modular pricing = Phase 2).
- Migration: 10 pages cloned onto the Supabase shell (leadership-dashboard-gamma.vercel.app). Airtable still system of record. Transactions mirror hourly, AI Brain nightly. Mica leads.
- Agents: execution engine LIVE, CFV agent in TESTING with a pending approval queue, 0 agents fully live.
- Leads: **zero. Outreach has never started.** This is the revenue-critical gap.
- Team: Mica (migration + property ops), Ericamae (funnel built; outreach proposal owed since 16 Jun).

## 3. Phase 1 — Decisions & foundations (7–11 Jul)

### Decisions (KEVIN — briefs prepared, mostly yes/no)
- [x] KEVIN — Decide D1 CRM entity model (done 7 Jul: generic entities table)
- [x] KEVIN — Decide D2 mentor-profile onboarding (done 7 Jul: approved)
- [x] KEVIN — Decide D3 recurring-revenue rebuild timing (done 7 Jul: defer; companion decision on no-Finance KPIs below)
- [x] KEVIN — Decide D4 skills starter set rule (done 7 Jul: curated universal set)
- [x] KEVIN — Decide D5 Money Confidence module home (done 7 Jul: Finance)
- [x] KEVIN — Decide D6 derived fields: views vs columns (done 7 Jul: computed views)
- [x] KEVIN — Decide D7 comms label taxonomy (done 7 Jul: opinionated 1-14 standard)
- [x] KEVIN — Decide D8 site map internal-only (done 7 Jul: confirmed)
- [x] KEVIN — Decide D9 AI cost policy (done 7 Jul: clients pay their own — per-tenant API key provisioned at onboarding)
- [x] OPUS — Record all nine D-outcomes in PRODUCTISATION.md §5 in one commit (done 7 Jul, same session)
- [ ] KEVIN — Answer Ericamae on the sales-page trust video, yes or no (done: Slack reply sent; also resolves [AT:recG4RxL6ewQoEvPX])
- [ ] KEVIN — Adopt this plan at the team meeting (done: both team members told this is the only plan)

### Airtable cleanse + plan-sync automation
- [x] KEVIN — Approve the cleanse proposal (docs/airtable-cleanse-2026-07-07.md) (done 7 Jul, with added scope: scan no-business tasks for open-ended OD items + SMART pass on everything)
- [x] OPUS — Apply the cleanse: close duplicates/stale with a comment naming this plan, re-date/reassign keepers, create the missing tasks under "Launch & First Revenue" (done 7 Jul: 53 closed with comments, 52 created, 16 re-dated, 4 parked, 9 orphans re-linked; verified zero exact-name duplicates; 93 open OD tasks, all with owner + due date)
- [ ] OPUS — Fix the 92 nameless invoice/AP artefact rows sitting in Tasks with Status "Today" (found by the cleanse; likely invoice-ingestion artefacts polluting status views) (done: zero nameless rows in open-status views + ingestion no longer creates them)
- [ ] OPUS — Add a dedupe gate to the meetings task-extraction script: before creating a task, check open tasks for a match and link/skip instead of duplicating (done: a test meeting summary naming an existing task creates zero new records) [gmail-meetings-script.gs — merging does NOT redeploy; manual paste into Apps Script]
- [ ] OPUS — Nightly plan↔Airtable sync job: tick this plan from Airtable completions, push approved new plan tasks to Airtable, flag unmapped/duplicate tasks in a short report (done: first nightly run produces a correct report)

### Security (this week)
- [ ] OPUS — Inventory every consumer of the current Airtable PAT (repo, workers, GitHub secrets, HR app, scripts, ~/.config/od) (done: written list)
- [ ] KEVIN — Generate a new Airtable PAT + revoke the exposed one (done: old token dead)
- [ ] OPUS — Update every consumer from the inventory + verify each works (done: all green)
- [ ] ERICAMAE — Change the affiliate admin password + store it outside Slack (done: new password works)
- [ ] KEVIN — Agree the no-secrets-in-Slack rule + the alternative channel at the team meeting (done: agreed)
- [ ] MICA — Investigate + fix the Stripe webhook delivery failures on od-billing-bridge [AT:recjybZNepSBpDLeP] (done: Stripe dashboard shows deliveries succeeding)

### Launch-audit manual steps (KEVIN — specs written 2 Jul, ~30 min total)
- [ ] KEVIN — Add PROXY_SERVICE_TOKEN as a GitHub Actions secret (done: secret exists) [without it the 1 Aug valuations run fails]
- [ ] KEVIN — Add the env line to .github/workflows/monthly-valuations.yml via GitHub web UI (done: line merged)
- [ ] KEVIN — Apply the saved auto-bump-pagever.yml diff via GitHub web UI, or grant the PAT workflow scope (done: workflow updated)
- [ ] KEVIN — Verify the Google API key in follow-up.html is referrer-restricted in Google Cloud Console (done: restriction confirmed)
- [ ] KEVIN — Set GCAL_PROXY_TOKEN Script Property + redeploy gcal-proxy, then set localStorage gcal_proxy_key on the Tasks page (done: calendar loads with the gate on)

### Migration foundations
- [ ] MICA — Commit migrations 0001–0014 to supabase-migration/supabase/migrations/ (done: files in repo, sequence complete)
- [ ] MICA — Publish the table-by-table parity list: full / partial / one-off snapshot (done: list shared in Slack)
- [ ] OPUS — RLS policy audit: confirm every public table has policies; write missing ones (done: audit note + policies applied) [anon-no-login access verified blocked, 7 Jul]

## 4. Phase 2 — Product to sellable (11–25 Jul)

### First LIVE agent (the proof the promise is real)
- [ ] KEVIN — Clear the CFV agent's pending approval queue with feedback on rejects (done: 0 pending)
- [ ] KEVIN — Repeat daily until approval ≥90% over 3 consecutive runs (done: stats bar shows it)
- [ ] KEVIN — Press Go Live with empty autoFields (done: state = LIVE)
- [ ] KEVIN — Widen autoFields to safe writes after 1 clean live week (done: at least one field auto-updating)
- [ ] OPUS — Regenerate remaining title-only SOPs from real transcripts (done: all agent-disposition SOPs regenerated)
- [ ] KEVIN — Choose agent #2: contractor dispatch or inbound triage (done: choice named)
- [ ] OPUS — Build agent #2 onto the runtime in shadow mode (done: first shadow run produces sensible proposals)

### Migration (MICA lead, OPUS support — spec: docs/supabase-schema-spec.md)
- [ ] OPUS — Create the tenancy spine: tenants, tenant_users, tenant_config, ai_usage_log + Kevin's tenant row (done: migration merged + applied)
- [ ] OPUS — Retrofit tenant_id + RLS to every existing table (done: every table passes the policy audit)
- [ ] OPUS — Create the entities table per D1 (done: migration applied)
- [ ] MICA — Next page set onto the shell: Finance group (transactions, P&L, cashflow) [AT:recFxlJnVTFLIJV8C umbrella] (done: pages load real data on Vercel)
- [ ] MICA — Tasks & Projects write-path cutover behind a flag (done: task created on the Vercel build persists in Supabase)
- [ ] OPUS — Parity check script: row counts + spot fields per migrated table (done: script + first green run)
- [ ] MICA — Full test pass of the migrated app, client's-shoes [AT:recAuoApJczmHgXTG] (done: bug list filed or clean report)
- [ ] OPUS — Replace Airtable automations still relied on by migrated pages [AT:recXh2jvXq59eGkQM] (done: no migrated page depends on an Airtable automation)

### De-Kevining (config, not code — per PRODUCTISATION.md §4)
- [ ] OPUS — Identity/branding → tenant_config (done: no Kevin/company hardcodes in migrated pages)
- [ ] OPUS — Team hardcodes → team_members table (done: 6 hardcoded arrays replaced by one helper)
- [ ] OPUS — Thresholds/targets → tenant_config (done: budget targets read from config)
- [ ] OPUS — Infrastructure URLs → tenant_config (done: worker/proxy URLs configurable)
- [ ] OPUS — AI voice: per-tenant mentor prompt per D2 (done: AI features read tenant prompt)
- [ ] OPUS — Per-tenant AI key routing in claude-proxy per D9: client tenants use the client's own Anthropic key (provisioned done-for-you at onboarding), Kevin's key serves only Kevin's tenant, usage logged per tenant (done: a test tenant's calls bill the test key)
- [ ] OPUS — Remove 'enter your API key' prompts from all pages — key handling moves to per-tenant config per D9 (done: no key prompt anywhere)
- [ ] OPUS — Manual KPI entry as STANDARD + honest "Connect your numbers — Finance module" upsell state on finance cards for no-Finance tenants (D3 companion) (done: both states verified on a test tenant)
- [ ] OPUS — Onboarding seeds recurring KPI-update tasks (weekly/monthly per installed manual KPI) in the client's Tasks & Projects (done: provisioning rehearsal creates the recurring tasks)
- [ ] OPUS — Empty-state sweep: every page renders helpfully with zero records [AT:recKYTvkpyVZERmnN] (done: new-tenant walkthrough shows no blank/broken panels)

### Product finish + fixes
- [ ] KEVIN+OPUS — Wealth module: personal cash flow + net worth statements [AT:recNxHUwt9DQnmjWg, recnbOvfUCXLKRFhJ, receMj0K0O6Ym8qgg] — OR Kevin re-dates to post-launch (decision at team meeting) (done: built or re-dated)
- [ ] OPUS — Fix P&L gross profit % + net profit sign [AT:recBCnFH2tRrUs5BD] (done: /fix run, verified in browser)
- [ ] OPUS — Update sop-cfvs.html for the 3 Jul CFV detection change [AT:rec9ihFqDDSY8DMLZ] (done: drift monitor clear)
- [ ] OPUS — 13-year-old workflow visual aids per page [AT:recinNtKPawy2g3vI] (done: each page has its visual; reusable for website)

### Onboarding path (v1 = manual-assisted; the service IS the product)
- [ ] KEVIN — Review Mica's onboarding sequence (owed since 26 Jun) [AT:recMQlb7uMQZLlFcm] (done: feedback sent)
- [ ] KEVIN — Async client intake form + Loom [AT:recukdbjiqU5UejBo] (done: a test submission collects everything needed)
- [ ] OPUS — Client Profile interview v1 from docs/client-profile-questionnaire.md, writes tenant_config (done: dry-run fills a config for a fictional client)
- [ ] OPUS — Provisioning runbook: create tenant, seed data, module flags (done: runbook + one rehearsal tenant created and removed)

## 5. Phase 3 — GTM to live (parallel, 7–31 Jul)

### Outreach engine ON (the revenue-critical lane)
- [ ] ERICAMAE — Deliver the LinkedIn outbound proposal [AT:recR5cIwV8A8Q8NDt] (done: written proposal with Kevin)
- [ ] KEVIN — Approve/adjust it same day (done: reply sent)
- [ ] ERICAMAE — Target list v1: 60 founder-led UK SMEs matching the 5 hot-buttons (done: 60 rows in the tracker with signal noted)
- [ ] ERICAMAE — 3 outreach message templates from the hot-buttons (done: Kevin approved all 3)
- [ ] ERICAMAE — First 20 personalised touches sent (done: 20 logged)
- [ ] ERICAMAE — Ramp to 60 touches/week from w/c 21 Jul (done: weekly scorecard shows 60)
- [ ] KEVIN — Funnel scorecard live: touches/leads/calls/won, reviewed Mondays [AT:reczybiLcJAYaf51y] (done: sheet + first entry)
- [ ] KEVIN — Design-partner offer terms finalised (founding rate + case study + testimonial) (done: one-pager exists)
- [ ] KEVIN — Seed clauses in the contract + intake [AT:rec3HGmM6uHgKK1v8] (done: clauses in the live contract BEFORE partner #1 signs)
- [ ] KEVIN — Sign design partner #1 (done: contract + payment)
- [ ] KEVIN — Sign design partner #2 (done: contract + payment)

### Funnel truth pass
- [ ] ERICAMAE — Verify sales + thank-you pages show £350/£1,500 + trial everywhere (done: screenshots in Slack)
- [ ] ERICAMAE — Resolve the 2 sales-page placeholders: calendar booking link + worker URL (done: both live)
- [ ] ERICAMAE — Full dry-run: book Teardown → calendar entry; checkout → contract + welcome email (done: evidence in Slack)
- [ ] ERICAMAE — Website clarity pass: outdated references removed [AT:recSlGxdgHaecSGG1] (done: Kevin sign-off)
- [ ] ERICAMAE — Pricing page from the SIMPLE locked card [AT:recnggtrSkRcjT9fU — description needs amending from the modular card] (done: page live at the 29 Jun pricing)

### Lead magnet + nurture
- [ ] ERICAMAE — Lead-Magnet Capture & Nurture workflow draft → live [AT:receDDArEOlLDZaBN] (done: workflow on)
- [ ] ERICAMAE — Gate the Founder-to-Free magnet (email → link → thank-you CTA to Teardown) (done: test lead receives it gated)
- [ ] ERICAMAE — GHL nurture sequences by funnel stage [AT:recKlaXRJXupP36pJ] (done: test lead receives the sequence)
- [ ] ERICAMAE — Content engine LinkedIn-led, problem-first (authority layer) [AT:recgErOu3AiipDQo4] (done: 3 posts/week running)

### Teardown call kit
- [ ] KEVIN — Founder Dependency Score live-on-call sheet finalised [AT:recFNqmzmeSmOfgJw] (done: usable on a call)
- [ ] KEVIN — Rocket Demo flow one-pager (diagnose → matching modules → design-partner close) (done: doc exists)
- [ ] KEVIN — One dry-run Teardown with Mica or Ericamae as prospect (done: dry-run held)

### Metrics
- [ ] KEVIN — North-star + four numbers into the dashboard [AT:recmhr2CP0ixhlgUi] (done: numbers visible)
- [ ] KEVIN — Weekly growth review bolted onto Monday check-in [AT:recqPdq5WNLrkn0Xm] (done: first 15-min slot held)
- [ ] KEVIN — Ch11 services-economics pass [AT:recXb6sE7GeyHsNKg] (done: pressure-test written up)
- [ ] KEVIN — Per-page metrics review for the dashboard [AT:recf5UDf4qj6Zg1Bz] (done: list of pulls agreed)

## 6. Phase 4 — Launch week (28 Jul–1 Aug)

- [ ] OPUS — Full pre-deploy pass on the live app (skill: pre-deploy) (done: report clean)
- [ ] OPUS — Regression: every tab loads, zero console errors, live + Vercel builds (done: evidence saved)
- [ ] KEVIN — Build + internally sign off launch-scope modules [AT:rec5bUChevzCQfdyV] (done: sign-off logged)
- [ ] KEVIN — Make the product publicly live and purchasable [AT:rec1oFlkDNI6MRAnU] (done: a stranger can buy)
- [ ] KEVIN — Confirm the 1 Aug monthly-valuations run succeeded (done: Action green)
- [ ] KEVIN — Go/no-go review against this plan (done: decision in Changelog)
- [ ] ERICAMAE — Launch announcement: website banner + LinkedIn post + email to list (done: all three live)
- [ ] KEVIN — Resolve all critical launch-week bugs via /fix [AT:recRhajAjdshE4NqN] (done: zero criticals open)

## 7. Phase 5 — Sell & deliver (Aug onwards)

- [ ] KEVIN — Acquire + onboard the first paid subscriber [AT:recsqZey1t0o4BE0l] (done: paid, provisioned, activated)
- [ ] KEVIN+TEAM — Client #1 activation ladder: dashboard populated → team in Tasks → first agent live ≤1 month (done: Key Event logged)
- [ ] OPUS — Instrument founder-minutes-per-build from client #1 [AT:recbkvkMcHDpJq3s9] (done: minutes logged per queue item)
- [ ] KEVIN — Honour the first-customer team commitments (done: actioned privately)
- [ ] KEVIN — Activation bumpers (automated onboarding nudges) [AT:recanqepcizlcNin9] (done: nudges firing)
- [ ] OPUS — Onboarding-stall instrumentation [AT:recOoH5Ce67fgGClC] (done: activation events tracked)
- [ ] OPUS — Customer health score / CHI v1 [AT:recsQpgEUl9O714gL] (done: score visible per tenant)
- [ ] KEVIN — Churn monitoring [AT:reczsB25zO4O92EFq] (done: churn number in weekly review)
- [ ] KEVIN — Win-Ask referral machine once the first win exists [AT:recSUUOooDBf2GRqo] (done: first ask made)
- [ ] KEVIN — Phase 2 pricing: modules + annual billing, hand-sold to design partners first (done: decision review ~Sep)
- [ ] ERICAMAE — Content ideas generator for the Content Machine [AT:recmKDLQK0Whz0QJr] (done: generator in use)
- [ ] ERICAMAE — Comparison pages (vs DIY / VA / agency) [AT:reckGG3pb7U5qJYQV] (done: pages live)
- [ ] ERICAMAE — Retargeting across the funnel [AT:recQnZxHECFiumZwn] (done: pixels + audiences live)

**Parked (do not start; revisit dates noted):** price-increase method [AT:recQ1twbykem5cAX0] (after 3-5 case studies) · Dream 100 scorecard [AT:recFaQqsHc51QhGIn] (after channel 1 green) · Apify competitor scraping [AT:rec3jTyLpwQQ9uDhs] · VO3 outreach video [AT:recy19hUfotq92kVh] · automation-candidates audit (memory: post-launch).

## 8. Standing rails (always true, not tasks)

- No scaling before optimisation. No new modules before 2 design partners are live.
- Accuracy over hype in ALL outward copy.
- Every new page ships with refresh, sync status, error + empty states.
- Repo rules apply: CLAUDE.md quality gates, one session per file, deploy = verified live.
- Quarterly master-prompt review stays on its schedule [AT:recoKGkozjGkTjUNc].

## 9. Superseded plans (absorbed here 7 Jul 2026 — kept for history, do not work from them)

**Drive:** Software as a Science Action Plan + Launch Roadmap (17 Jun) · Migration Brief — Team Handoff · Sales & Marketing Team Brief · operations-director-launch-plan (sheet + md — md has PRE-LOCK pricing, do not quote it) · Q2-2026 plan PDF · Q1-2026 strategic plan · Q3-2025 strategic plans (equity model — obsolete direction) · 12-Week Implementation Plan.
**Still live as STRATEGY REFERENCES (not plans):** GTM Playbook · Pricing & Packaging Strategy (Claude Outputs copies).
**Still live as SPECS:** PRODUCTISATION.md · docs/client-profile-questionnaire.md · docs/agent-runtime-spec.md · docs/agentic-extraction-spec.md · docs/business-blueprint-spec.md · docs/supabase-schema-spec.md.

## 10. Proposed Amendments (holding pen — nothing here is live until Kevin approves)

| Date | Source | Proposal | Kevin's call |
|---|---|---|---|
| — | — | — | — |

## 11. Changelog

| Date | Source | Change |
|---|---|---|
| 2026-07-07 | Fable 5 session with Kevin (day-long planning) | Plan created from full audit (repo, Airtable, Slack, Drive). Supersedes all prior plan docs (§9). Baseline snapshot §2. Airtable cleanse proposed (docs/airtable-cleanse-2026-07-07.md), pending Kevin's approval. |
| 2026-07-07 | Kevin, in-session | D1-D9 all decided (outcomes in PRODUCTISATION.md §5). D3 companion: manual KPI entry standard + upsell state + seeded recurring update tasks. D9: clients pay their own AI via per-tenant keys. Cleanse approved with added scope (no-business scan + SMART pass). New tasks: meetings dedupe gate, nightly plan↔Airtable sync, per-tenant key routing, manual-KPI features. OPUS driver rule: hybrid by lane. |
| 2026-07-07 | Cleanse applied (Claude agent, Kevin-approved) | Airtable now matches this plan: 53 closed (16 dup, 37 stale — all commented), 52 created, 16 re-dated, 4 parked (Some Day checkbox), 9 orphans linked to Launch & First Revenue, 3 RECAT-flagged for Kevin. Zero duplicates verified. Open OD tasks: 93 (Kevin 59, Ericamae 18, Mica 16). New finding → task added: 92 nameless invoice/AP rows polluting Tasks status views. Note: Kevin's collaborator identity on the base is kevin@runpreneur.org.uk. |
