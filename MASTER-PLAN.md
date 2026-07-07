# Operations Director — Master Plan

**THE one plan. There is no other.** Every session (Fable, Opus, Cowork), every team member, and every future roadmap conversation works from this document. Amend it, never fork it. If you are Claude and you are about to create a plan, roadmap, or task list for Operations Director: STOP and edit this file instead.

- Owner: Kevin. Maintainer: any Claude session.
- Canonical location: repo root `MASTER-PLAN.md`. Team working copy: Airtable project "Launch & First Revenue" (web app → Tasks & Projects).
- Legend: `[ ]` NOT done yet · `[x]` done · `[~]` in progress · `[D]` dropped (reason in Changelog). The `(done when: …)` bracket on each task is its pass test — what must be true before anyone ticks it, NOT its status.
- Lanes: **KEVIN** · **MICA** · **ERICAMAE** · **OPUS** (any Claude build session)
- OPUS driver rule (Kevin, 7 Jul): hybrid by lane — Kevin runs product/shared-file/security/worker Opus tasks; Mica runs migration-lane Opus tasks; every OPUS task has a named human owner in Airtable who starts the session and ticks the box.
- Task format (SMART): Specific one action · Measurable binary done-test in brackets · Achievable in one sitting · Relevant to its section · Time-bound due date. `[AT:recXXX]` = Airtable record. `(NEW)` = added in the 7 Jul gap-fill; if it turns out already done, tick it with a note — a duplicate beats a miss.

---

## 0. How this plan changes (the protocol)

1. **One plan.** No session creates a new plan, roadmap, or task-list doc for OD. Additions come here.
2. **Every change is dated and sourced** in the Changelog (§14).
3. **Tasks are never silently deleted or reworded.** Done stays `[x]`. Dropped becomes `[D]` with a reason logged.
4. **Learning material goes through the holding pen** (§13 Proposed Amendments). Kevin approves; then it locks in.
5. **Structural changes** need Kevin's explicit approval before locking.
6. **Airtable is the team's working copy; this file is canonical.** New tasks flow plan → Airtable; status flows back nightly (sync job, §3) and at the Monday review.
7. **Weekly review** at the Monday team check-in: tick, re-sequence, log.

## 1. The goal line

Live, taking money, generating leads, and delivering what we sell:
- Launch: **1 August 2026**. 2 design partners signed by 31 July.
- 9 clients / £5k MRR by end-2026. 50 clients is the multi-year cap, not the year-one goal.
- Deliver = client's first AI agent live inside a month of signup.
- Demo evidence = **10 AI agents running Kevin's own businesses** (§5).

## 2. Where we are (snapshot 7 Jul 2026 — update each review)

- Product 78% / GTM 40% (2 Jul audit). Funnel pages built and Stripe-tested at locked pricing (£1,500 setup + £350/mo + 30-day trial; modular pricing = Phase 2).
- Migration: 12+ pages on the Supabase shell (Vercel), Mica shipping daily. Airtable still system of record.
- Agents: engine LIVE; CFV agent TESTING; rent-chase + reconciliation approval-queue agents built; 0 fully live.
- Leads: zero; outreach never started. D1-D9 decided. Airtable cleansed 7 Jul (zero dupes, 93 open OD tasks).

## 3. Foundations, security & plan hygiene

- [x] KEVIN — D1-D9 decided (7 Jul; outcomes in PRODUCTISATION.md §5)
- [x] OPUS — D-outcomes recorded in PRODUCTISATION.md (7 Jul, commit 6ed0ec1)
- [x] KEVIN — Cleanse approved (7 Jul, with no-business scan + SMART pass)
- [x] OPUS — Cleanse applied (7 Jul: 53 closed, 52 created, 16 re-dated, zero dupes verified)
- [ ] OPUS — Un-park the 4 Some Day tasks: untick the checkbox, set real future due dates (price-increase 30 Sep, Dream 100 1 Sep, Apify 15 Aug, VO3 video 15 Aug) (done when: no OD task uses Some Day; due 8 Jul)
- [ ] KEVIN — Confirm the 6 flagged unlinked tasks + 3 RECAT candidates from the cleanse report (done when: each closed or recategorised; due 8 Jul)
- [ ] OPUS — Fix the 92 nameless invoice/AP artefact rows polluting Tasks status views (done when: zero nameless open rows + ingestion stops creating them; due 11 Jul)
- [ ] OPUS — Inventory every consumer of the current Airtable PAT (repo, workers, GitHub secrets, HR app chaichoong.github.io/HR, scripts, ~/.config/od) (done when: written list; due 9 Jul)
- [ ] KEVIN — Generate a new Airtable PAT + revoke the exposed one (done when: old token dead; due 10 Jul)
- [ ] OPUS — Update every PAT consumer + verify each works (done when: all green; due 10 Jul)
- [ ] ERICAMAE — Change the affiliate admin password + store it outside Slack (done when: new password works; due 9 Jul)
- [ ] KEVIN — Agree the no-secrets-in-Slack rule + alternative channel at the team meeting (done when: agreed; due 8 Jul)
- [ ] KEVIN — Add PROXY_SERVICE_TOKEN as a GitHub Actions secret (done when: secret exists; due 9 Jul) [1 Aug valuations run fails without it]
- [ ] KEVIN — Add the env line to .github/workflows/monthly-valuations.yml via GitHub web UI (done when: line merged; due 9 Jul)
- [ ] KEVIN — Apply the saved auto-bump-pagever.yml diff via GitHub web UI, or grant the PAT workflow scope (done when: workflow updated; due 9 Jul)
- [ ] KEVIN — Verify the Google API key in follow-up.html is referrer-restricted in Google Cloud Console (done when: restriction confirmed; due 9 Jul)
- [ ] KEVIN — Set GCAL_PROXY_TOKEN Script Property + redeploy gcal-proxy + set localStorage gcal_proxy_key on Tasks (done when: calendar loads with gate on; due 11 Jul)
- [ ] OPUS — Meetings-script dedupe gate: before creating a task from a meeting summary, check open tasks and link/skip instead of duplicating (done when: test summary naming an existing task creates zero records; due 18 Jul) [gmail-meetings-script.gs — manual paste to redeploy]
- [ ] OPUS — Nightly plan↔Airtable sync job: tick this plan from completions, push approved plan tasks to Airtable, flag unmapped/duplicates in a short report (done when: first correct nightly report; due 18 Jul)
- [ ] KEVIN — Adopt this plan at the team meeting (done when: team told this is the only plan; due 8 Jul)

## 4. Product development (finish + de-Kevin + migrate)

### Migration (MICA lead; spec docs/supabase-schema-spec.md)
- [ ] MICA — Commit migrations 0001–0014 to the repo (done when: sequence complete in supabase-migration/; due 11 Jul)
- [ ] MICA — Publish the table-by-table parity list: full / partial / snapshot (done when: list in Slack; due 11 Jul)
- [ ] OPUS — RLS policy audit; write missing policies (done when: audit note + policies applied; due 14 Jul) [anon-no-login verified blocked 7 Jul]
- [ ] OPUS — Tenancy spine: tenants, tenant_users, tenant_config, ai_usage_log + Kevin's tenant row (done when: migration applied; due 16 Jul)
- [ ] OPUS — Retrofit tenant_id + RLS to every existing table (done when: all tables pass policy audit; due 18 Jul)
- [ ] OPUS — entities table per D1 (done when: migration applied; due 18 Jul)
- [~] MICA — Finance page set onto the shell (Accounts + P&L landed 7 Jul; transactions + cashflow remain) [AT:recFxlJnVTFLIJV8C] (done when: pages load real data on Vercel; due 15 Jul)
- [ ] MICA — Tasks & Projects write-path cutover behind a flag (done when: task created on Vercel persists in Supabase; due 21 Jul)
- [ ] OPUS — Parity check script: row counts + spot fields per migrated table (done when: first green run; due 21 Jul)
- [ ] MICA — Full client's-shoes test pass of the migrated app [AT:recAuoApJczmHgXTG] (done when: bug list or clean report; due 24 Jul)
- [ ] OPUS — Replace Airtable automations that migrated pages rely on [AT:recXh2jvXq59eGkQM] (done when: no migrated page depends on one; due 24 Jul)

### De-Kevining (per PRODUCTISATION.md §4)
- [ ] OPUS — Identity/branding → tenant_config (done when: no Kevin hardcodes in migrated pages; due 22 Jul)
- [ ] OPUS — Team hardcodes → team_members table (done when: 6 arrays → one helper; due 22 Jul)
- [ ] OPUS — Thresholds/targets → tenant_config (done when: budget targets from config; due 22 Jul)
- [ ] OPUS — Infrastructure URLs → tenant_config (done when: worker/proxy URLs configurable; due 22 Jul)
- [ ] OPUS — Per-tenant mentor prompt per D2 (done when: AI reads tenant prompt; due 23 Jul)
- [ ] OPUS — Per-tenant AI key routing in claude-proxy per D9 (done when: test tenant bills the test key; due 22 Jul)
- [ ] OPUS — Remove all 'enter your API key' prompts (done when: none anywhere; due 23 Jul)
- [ ] OPUS — Empty-state sweep: every page helpful with zero records [AT:recKYTvkpyVZERmnN] (done when: clean new-tenant walkthrough; due 24 Jul)

### Finish + fixes
- [ ] KEVIN+OPUS — Wealth module: personal cash flow + net worth statements [AT:recNxHUwt9DQnmjWg, recnbOvfUCXLKRFhJ, receMj0K0O6Ym8qgg] — or re-date post-launch at the team meeting (done when: built or re-dated; due 8 Jul decision)
- [ ] OPUS — Fix P&L gross profit % + net profit sign [AT:recBCnFH2tRrUs5BD] (done when: /fix verified in browser; due 11 Jul)
- [ ] OPUS — Update sop-cfvs.html for the 3 Jul CFV detection change [AT:rec9ihFqDDSY8DMLZ] (done when: drift monitor clear; due 14 Jul)
- [ ] OPUS — 13-year-old workflow visual aids per page [AT:recinNtKPawy2g3vI] (done when: every page has one; due 25 Jul)
- [ ] OPUS — Manual KPI entry STANDARD + "Connect your numbers — Finance module" upsell state (D3 companion) (done when: both verified on a test tenant; due 24 Jul)
- [ ] KEVIN — (NEW) Content Machine: merge the hardened branch into the main app marketing section, or explicitly defer (done when: merged or defer logged; due 15 Jul)
- [ ] OPUS — (NEW) Trial-end + payment-failure + cancellation flows: what happens in Stripe/GHL/app when a trial converts, a card fails, or a client cancels — map and close gaps (done when: all three flows tested end-to-end in test mode; due 23 Jul)
- [ ] OPUS — (NEW) Error monitoring on the client-facing app (Sentry free tier per the migration plan) (done when: a forced error appears in Sentry; due 25 Jul)
- [ ] ERICAMAE — (NEW) Mobile responsiveness pass on all client-facing pages (sales, booking, app shell) (done when: screenshots at 375px width, no broken layouts; due 18 Jul)

## 5. AI agent fleet — 10 demo agents on Kevin's businesses (NEW section, Kevin 7 Jul)

The sales evidence: prospects see real agents running real businesses. Route: Systemisation pipeline (Loom → SOP → readiness → disposition → shadow → live). Existing: CFV agent (testing), rent-chase queue (built), reconciliation auto-approve (built). Target: **10 by end of July.**

- [ ] KEVIN — Clear the CFV agent's pending approval queue with feedback (done when: 0 pending; due 9 Jul)
- [ ] KEVIN — Daily approvals until ≥90% over 3 consecutive runs (done when: stats bar shows it; due 16 Jul)
- [ ] KEVIN — CFV agent Go Live with empty autoFields (done when: state LIVE; due 17 Jul)
- [ ] KEVIN — Widen CFV autoFields after 1 clean live week (done when: one field auto-updating; due 24 Jul)
- [ ] OPUS — Regenerate remaining title-only SOPs from real transcripts (done when: all agent SOPs regenerated; due 14 Jul)
- [ ] KEVIN — Shortlist the 10 demo processes across the businesses (candidates: CFV ✓, rent-chase ✓, reconciliation ✓, contractor dispatch, inbound comms triage, invoice matching, compliance cert chasing, meeting-task extraction, weekly KPI digest, content repurposing) (done when: 10 named in this plan; due 10 Jul)
- [ ] KEVIN — Record the Looms for the non-built processes, AGENTIC script on screen (done when: one Loom per process in Systemisation; due 18 Jul)
- [ ] OPUS — Run each new process through the pipeline to shadow mode, batch 1 (agents 4-6) (done when: sensible first shadow proposals each; due 22 Jul)
- [ ] OPUS — Batch 2 (agents 7-10) to shadow mode (done when: same; due 29 Jul)
- [ ] KEVIN — Approval reps on every shadow agent until each is live or honestly parked (done when: live/parked recorded per agent; due 7 Aug)
- [ ] KEVIN — (NEW) Demo evidence pack: 2-3 min screen recording per live agent + the "agents live" counter shot (done when: recordings in the sales folder; due 31 Jul)
- [ ] OPUS — (NEW) Blueprint tab v1 (the "% of work run by AI" map — docs/business-blueprint-spec.md) so demos show the whole fleet on one screen (done when: tab renders real workflow/agent data; due 31 Jul)

## 6. Client onboarding & delivery (Ch6 activation)

- [ ] KEVIN — Review Mica's onboarding sequence (owed since 26 Jun) [AT:recMQlb7uMQZLlFcm] (done when: feedback sent; due 9 Jul)
- [ ] KEVIN — Async client intake form + Loom [AT:recukdbjiqU5UejBo] (done when: test submission collects everything; due 16 Jul)
- [ ] OPUS — Client Profile interview v1 (docs/client-profile-questionnaire.md) writing tenant_config (done when: dry-run fills a fictional client's config; due 21 Jul)
- [ ] OPUS — Provisioning runbook: create tenant, seed data, module flags, client AI key (D9) (done when: rehearsal tenant created + removed; due 23 Jul)
- [ ] OPUS — Onboarding seeds recurring KPI-update tasks per installed manual KPI (done when: rehearsal creates them; due 24 Jul)
- [ ] KEVIN — (NEW) Welcome pack: welcome email + what-happens-next one-pager + team-invite instructions (done when: drafts approved in GHL; due 18 Jul)
- [ ] KEVIN — (NEW) "Three hated jobs" first-agent selection step in the intake (fastest route to the Key Event: first agent live) (done when: question in the intake + mapping note to skills; due 18 Jul)
- [ ] OPUS — (NEW) Data-import checklist per module (what we need from the client, in what format, for each module they buy) (done when: checklist doc per module; due 23 Jul)
- [ ] OPUS — (NEW) Client-facing how-it-works guide for their tenant (adapt how-it-works.html to the generic offer) (done when: guide renders for a test tenant; due 28 Jul)
- [ ] KEVIN — (NEW) 14-day activation checklist (dashboard populated → team using Tasks → first agent live) with owner per step (done when: checklist in the provisioning runbook; due 21 Jul)
- [ ] KEVIN — Activation bumpers (automated nudges) [AT:recanqepcizlcNin9] (done when: nudges firing; due 8 Aug)
- [ ] OPUS — Onboarding-stall instrumentation [AT:recOoH5Ce67fgGClC] (done when: activation events tracked; due 12 Aug)

## 7. Lead generation — attention (Ch3/Ch4)

- [ ] ERICAMAE — Deliver the LinkedIn outbound proposal [AT:recR5cIwV8A8Q8NDt] (done when: written proposal with Kevin; due 8 Jul)
- [ ] KEVIN — Approve/adjust it same day (done when: reply sent; due 8 Jul)
- [ ] ERICAMAE — Target list v1: 60 founder-led UK SMEs matching the 5 hot-buttons (done when: 60 rows with signal noted; due 10 Jul)
- [ ] ERICAMAE — 3 outreach message templates from the hot-buttons (done when: Kevin approved all 3; due 11 Jul)
- [ ] KEVIN — (NEW) LinkedIn profile revamp: Kevin's profile is the outreach landing page — headline, about, featured to the core message (done when: profile matches the 13-yo message; due 11 Jul)
- [ ] ERICAMAE — First 20 personalised touches sent (done when: 20 logged; due 14 Jul)
- [ ] ERICAMAE — (NEW) Reply-handling templates + SOP (positive / question / not-now / referral) so responses never sit (done when: 4 templates approved + response-time rule; due 15 Jul)
- [ ] ERICAMAE — Ramp to 60 touches/week from w/c 21 Jul (done when: weekly scorecard shows 60; due 21 Jul)
- [ ] ERICAMAE — Lead-Magnet Capture & Nurture workflow live [AT:receDDArEOlLDZaBN] (done when: workflow on; due 15 Jul)
- [ ] ERICAMAE — Gate the Founder-to-Free magnet (email → link → thank-you CTA to Teardown) (done when: test lead gets it gated; due 16 Jul)
- [ ] ERICAMAE — GHL nurture sequences by funnel stage [AT:recKlaXRJXupP36pJ] (done when: test lead receives sequence; due 18 Jul)
- [ ] ERICAMAE — Content engine LinkedIn-led, problem-first [AT:recgErOu3AiipDQo4] (done when: 3 posts/week running; due 14 Jul)
- [ ] ERICAMAE — Comparison pages (vs DIY / VA / agency) [AT:reckGG3pb7U5qJYQV] (done when: pages live; due 12 Aug)
- [ ] ERICAMAE — Retargeting across the funnel [AT:recQnZxHECFiumZwn] (done when: pixels + audiences live; due 12 Aug)

## 8. Sales & conversion (Ch5 Rocket Demo)

- [ ] ERICAMAE — Verify sales + thank-you pages show £350/£1,500 + trial everywhere (done when: screenshots in Slack; due 9 Jul)
- [ ] ERICAMAE — Resolve the 2 sales-page placeholders (calendar link, worker URL) (done when: both live; due 9 Jul)
- [ ] MICA — Fix the Stripe webhook delivery failures on od-billing-bridge [AT:recjybZNepSBpDLeP] (done when: deliveries succeeding; due 9 Jul)
- [ ] ERICAMAE — Full dry-run: book Teardown → calendar; checkout → contract + welcome email (done when: evidence in Slack; due 10 Jul)
- [ ] ERICAMAE — Website clarity pass [AT:recSlGxdgHaecSGG1] (done when: Kevin sign-off; due 11 Jul)
- [ ] ERICAMAE — Pricing page from the SIMPLE locked card [AT:recnggtrSkRcjT9fU] (done when: live at 29 Jun pricing; due 11 Jul)
- [ ] KEVIN — Answer Ericamae on the trust video (waiting since 29 Jun) [AT:recG4RxL6ewQoEvPX] (done when: yes/no sent; due 8 Jul)
- [ ] KEVIN — (NEW) Contract + T&Cs reflect the simple pricing (sendlink contract still at old terms?) + refund/cancellation lines (done when: contract reissued at £350/£1,500 + trial terms; due 11 Jul)
- [ ] KEVIN — Founder Dependency Score live-on-call sheet [AT:recFNqmzmeSmOfgJw] (done when: usable on a call; due 10 Jul)
- [ ] KEVIN — Rocket Demo flow one-pager (done when: doc exists; due 12 Jul)
- [ ] KEVIN — (NEW) Objection crib sheet from the real historic calls (price #1, want-a-demo, credibility, burned-before, consult-partner) with your answer to each (done when: one page, used in the dry-run; due 12 Jul)
- [ ] KEVIN — (NEW) Demo tenant with anonymised sample data for Rocket Demos (pairs with §5 evidence pack) (done when: demo login shows a populated believable business; due 22 Jul)
- [ ] KEVIN — One dry-run Teardown with Mica or Ericamae as prospect (done when: dry-run held; due 14 Jul)
- [ ] KEVIN — Design-partner offer terms (founding rate + case study + testimonial) (done when: one-pager; due 11 Jul)
- [ ] KEVIN — Seed clauses in the live contract BEFORE partner #1 signs [AT:rec3HGmM6uHgKK1v8] (done when: clauses in; due 11 Jul)
- [ ] KEVIN — (NEW) Case-study template ready before partner #1 (what we capture, when, in what format) (done when: template exists; due 18 Jul)
- [ ] KEVIN — Sign design partner #1 (done when: contract + payment; due 25 Jul)
- [ ] KEVIN — Sign design partner #2 (done when: contract + payment; due 31 Jul)

## 9. Retention & expansion (Ch7/Ch8)

- [ ] KEVIN — (NEW) Publish the queue SLA + how-to-submit inside the app (the £350 promise made concrete; kills "coaching course" drift) (done when: visible to a test tenant; due 25 Jul)
- [ ] KEVIN — (NEW) Monthly client value report template (agents live, hours saved, work done — the retention weapon) (done when: template produced from Kevin's own tenant data; due 8 Aug)
- [ ] OPUS — Customer health score / CHI v1 [AT:recsQpgEUl9O714gL] (done when: score per tenant; due 14 Aug)
- [ ] KEVIN — Churn monitoring [AT:reczsB25zO4O92EFq] (done when: churn number in weekly review; due 14 Aug)
- [ ] KEVIN — Win-Ask referral machine once the first win exists [AT:recSUUOooDBf2GRqo] (done when: first ask made; due 21 Aug)
- [ ] KEVIN — Honour the first-customer team commitments (done when: actioned privately; on first client)
- [ ] KEVIN — Phase 2 pricing: modules + annual, hand-sold to design partners first (done when: decision review; due 15 Sep)
- [ ] KEVIN — Price-increase method after 3-5 case studies [AT:recQ1twbykem5cAX0] (due 30 Sep)
- [ ] ERICAMAE — Dream 100 accountants channel scorecard [AT:recFaQqsHc51QhGIn] (after channel 1 is green; due 1 Sep)

## 10. Metrics & operating rhythm (Ch1/Ch11)

- [ ] KEVIN — North-star + four numbers into the dashboard [AT:recmhr2CP0ixhlgUi] (done when: numbers visible; due 10 Jul)
- [ ] KEVIN — Funnel scorecard: touches/leads/calls/won [AT:reczybiLcJAYaf51y] (done when: sheet + first entry; due 14 Jul)
- [ ] KEVIN — Weekly growth review bolted onto Monday check-in [AT:recqPdq5WNLrkn0Xm] (done when: first 15-min slot held; due 14 Jul)
- [ ] KEVIN — Ch11 services-economics pass [AT:recXb6sE7GeyHsNKg] (done when: pressure-test written; due 17 Jul)
- [ ] KEVIN — Per-page metrics review for the dashboard [AT:recf5UDf4qj6Zg1Bz] (done when: pulls agreed; due 15 Jul)
- [ ] OPUS — Founder-minutes-per-build instrumentation from client #1 [AT:recbkvkMcHDpJq3s9] (done when: minutes logged per queue item; due 8 Aug)

## 11. Launch week (28 Jul–1 Aug)

- [ ] OPUS — Full pre-deploy pass (skill: pre-deploy) (done when: clean report; due 29 Jul)
- [ ] OPUS — Regression: every tab, zero console errors, live + Vercel (done when: evidence saved; due 29 Jul)
- [ ] KEVIN — Build + sign off launch-scope modules [AT:rec5bUChevzCQfdyV] (done when: sign-off logged; due 30 Jul)
- [ ] KEVIN — (NEW) Go/no-go criteria list agreed BEFORE the review (checkout works, zero criticals, support route live, agents demo-able) (done when: list written; due 25 Jul)
- [ ] KEVIN — (NEW) Backup/rollback: Supabase backup confirmed + Airtable snapshot taken + how-to-revert note (done when: both verified; due 30 Jul)
- [ ] KEVIN — (NEW) Support route live: support@ address routed + who answers + response target (done when: test email answered; due 30 Jul)
- [ ] KEVIN — Make the product publicly live and purchasable [AT:rec1oFlkDNI6MRAnU] (done when: a stranger can buy; due 1 Aug)
- [ ] KEVIN — Confirm the 1 Aug monthly-valuations run succeeded (done when: Action green; due 1 Aug)
- [ ] KEVIN — Go/no-go review against this plan (done when: decision in Changelog; due 31 Jul)
- [ ] ERICAMAE — Launch announcement: website banner + LinkedIn post + email to list (done when: all three live; due 1 Aug)
- [ ] KEVIN — Resolve all critical launch-week bugs via /fix [AT:recRhajAjdshE4NqN] (done when: zero criticals; due 3 Aug)
- [ ] KEVIN — Acquire + onboard the first paid subscriber [AT:recsqZey1t0o4BE0l] (done when: paid, provisioned, activated; due 15 Aug)
- [ ] KEVIN+TEAM — Client #1 activation ladder complete ≤1 month (done when: Key Event logged; due 15 Sep)

## 12. Superseded plans (absorbed 7 Jul 2026 — kept for history, do not work from them)

**Drive:** Software as a Science Action Plan + Launch Roadmap (17 Jun) · Migration Brief — Team Handoff · Sales & Marketing Team Brief · operations-director-launch-plan (sheet + md — md has PRE-LOCK pricing) · Q2-2026 plan PDF · Q1-2026 strategic plan · Q3-2025 strategic plans (equity model — obsolete) · 12-Week Implementation Plan.
**Still live as STRATEGY REFERENCES:** GTM Playbook · Pricing & Packaging Strategy.
**Still live as SPECS:** PRODUCTISATION.md · docs/client-profile-questionnaire.md · docs/agent-runtime-spec.md · docs/agentic-extraction-spec.md · docs/business-blueprint-spec.md · docs/supabase-schema-spec.md.

## 13. Proposed Amendments (holding pen — nothing live until Kevin approves)

| Date | Source | Proposal | Kevin's call |
|---|---|---|---|
| — | — | — | — |

## 14. Changelog

| Date | Source | Change |
|---|---|---|
| 2026-07-07 | Fable 5 session with Kevin | Plan created from full audit (repo, Airtable, Slack, Drive). Supersedes all prior plan docs (§12). |
| 2026-07-07 | Kevin, in-session | D1-D9 decided (PRODUCTISATION.md §5). D3 companion: manual KPI standard + upsell state + seeded recurring tasks. D9: clients pay own AI via per-tenant keys. Cleanse approved with no-business scan + SMART pass. Sync-automation tasks added. OPUS driver: hybrid by lane. |
| 2026-07-07 | Cleanse applied (Claude agent, Kevin-approved) | 53 closed (commented), 52 created, 16 re-dated, 4 parked, 9 orphans linked, 3 RECAT-flagged. Zero duplicates verified. 93 open OD tasks. Finding → task: 92 nameless AP rows. Kevin's base identity = kevin@runpreneur.org.uk. |
| 2026-07-07 | Kevin, in-session (structural change, approved) | RESTRUCTURED phases → Software-as-a-Science sections (§3-§11): foundations, product, agent fleet, onboarding, lead gen, sales, retention, metrics, launch. Gap-fill pass added 20 (NEW) tasks on the duplicate-beats-a-miss rule. NEW §5: 10 demo agents on Kevin's businesses by end July. Some Day parking reversed → real future due dates. All prior task states preserved. |
