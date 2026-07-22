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
- [x] OPUS — Un-park the 4 Some Day tasks: untick the checkbox, set real future due dates (price-increase 30 Sep, Dream 100 1 Sep, Apify 15 Aug, VO3 video 15 Aug) (done when: no OD task uses Some Day; due 8 Jul) *(done 7 Jul in-session)* [AT:-]
- [x] KEVIN — Confirm the 6 flagged unlinked tasks + 3 RECAT candidates from the cleanse report (done when: each closed or recategorised; due 8 Jul) [AT:recVczPN4KgdRudUA] *(ticked 2026-07-07, synced from Airtable)*
- [ ] OPUS — Fix the 92 nameless invoice/AP artefact rows polluting Tasks status views (done when: zero nameless open rows + ingestion stops creating them; due 11 Jul) [AT:recZhtp6ZNnYlQRJi]
- [x] OPUS — (NEW 16 Jul) AI model IDs: single source of truth. 61 hardcoded IDs across 20 files, and the Supabase twins had DRIFTED to older models than production (cutover would have silently regressed quality). New `js/ai-models.js`; all 21 browser pages verified *(built + verified 16 Jul, PR fix/ai-model-single-source)* [AT:-]
- [ ] KEVIN — (NEW 16 Jul) Finish the model-ID sweep: 3 Cloudflare Workers + the Slack contractor-bot. Server-side, so they need wrangler env vars AND a redeploy each (contractor-bot line 76 is on a stale model). A retired ID is an app-wide AI outage (done when: zero hardcoded IDs outside js/ai-models.js + workers redeployed; due 25 Jul) [AT:reckdEpatiqesu6ua]
- [ ] OPUS — Inventory every consumer of the current Airtable PAT (repo, workers, GitHub secrets, HR app chaichoong.github.io/HR, scripts, ~/.config/od) (done when: written list; due 9 Jul) [AT:recO3x3yw9KAcrLjH]
- [x] KEVIN — Generate a new Airtable PAT + revoke the exposed one (done when: old token dead; due 10 Jul) [AT:recDz1ljafVN1CB45] *(ticked 2026-07-14, synced from Airtable)*
- [ ] OPUS — Update every PAT consumer + verify each works (done when: all green; due 10 Jul) [AT:rec8BVrJIDAjp6QY7]
- [ ] ERICAMAE — Change the affiliate admin password + store it outside Slack (done when: new password works; due 9 Jul) [AT:rec0JrMvCKgmsi3lP]
- [x] KEVIN — Agree the no-secrets-in-Slack rule + alternative channel at the team meeting (done when: agreed; due 8 Jul) [AT:rec0j7ZPQl91sGRQx] *(ticked 2026-07-07, synced from Airtable)*
- [x] KEVIN — Rotate PROXY_SERVICE_TOKEN and add it as a GitHub Actions secret (done when: secret exists AND the Worker holds the same new value; due 9 Jul) [AT:recNhmqjkkrJQYGRM] *(done 2026-07-17: rotated to a fresh value, set on the Worker + as a GitHub secret; proven by a dry run — 25 valued, 0 skipped)*
- [x] KEVIN — Add the env line to .github/workflows/monthly-valuations.yml via GitHub web UI (done when: line merged; due 9 Jul) [AT:recd4w48QR3HLhJp6] *(done 2026-07-17, commit 54fdc44)*
- [ ] KEVIN — Apply the saved auto-bump-pagever.yml diff via GitHub web UI, or grant the PAT workflow scope (done when: workflow updated; due 9 Jul) [AT:recNBCvgAQyQQnSNY]
- [ ] KEVIN — Verify the Google API key in follow-up.html is referrer-restricted in Google Cloud Console (done when: restriction confirmed; due 9 Jul) [AT:recG1rKPOaOWnrGnr]
- [ ] KEVIN — Set GCAL_PROXY_TOKEN Script Property + redeploy gcal-proxy + set localStorage gcal_proxy_key on Tasks (done when: calendar loads with gate on; due 11 Jul) [AT:rec3G6KvmgrnO47eq]
- [ ] OPUS — Meetings-script dedupe gate: before creating a task from a meeting summary, check open tasks and link/skip instead of duplicating (done when: test summary naming an existing task creates zero records; due 18 Jul) [gmail-meetings-script.gs — manual paste to redeploy] [AT:reckN5r3NlACstzMU]
- [x] OPUS — Nightly plan↔Airtable sync job: tick this plan from completions, push approved plan tasks to Airtable, flag unmapped/duplicates in a short report (done when: first correct nightly report; due 18 Jul) [AT:recJ1QMTpPUsAGh4j] *(ticked 2026-07-08, synced from Airtable)*
- [x] KEVIN — Adopt this plan at the team meeting (done when: team told this is the only plan; due 8 Jul) [AT:rece90eUsYb2TudAV] *(ticked 2026-07-14, synced from Airtable)*
- [ ] KEVIN+OPUS — GDPR pack: ICO registration check, privacy policy on the sales site, client-facing DPA, sub-processor list (Supabase, Anthropic, Vercel, GHL, Stripe), data-retention line. Claude drafts, Kevin reviews and registers (done when: all five exist + DPA ready to send a design partner; due 18 Jul) [AT:recxhhfUWIGiumUtU]

## 4. Product development (finish + de-Kevin + migrate)

### Migration (MICA lead; spec docs/supabase-schema-spec.md)
- [ ] MICA — Commit migrations 0001–0014 to the repo (done when: sequence complete in supabase-migration/; due 11 Jul) [AT:rec3AxVCpdco3MnGu]
- [ ] MICA — Publish the table-by-table parity list: full / partial / snapshot (done when: list in Slack; due 11 Jul) [AT:recrpCoGoNgKCK8VF]
- [ ] OPUS — RLS policy audit; write missing policies (done when: audit note + policies applied; due 14 Jul) [AT:recQggeKHzkmdiI4H] [anon-no-login verified blocked 7 Jul]
- [x] OPUS — Tenancy spine: tenants, tenant_users, tenant_config, ai_usage_log + Kevin's tenant row (done when: migration applied; due 16 Jul) [AT:reck83Ohljf9Z6And] *(ticked 2026-07-08, synced from Airtable)*
- [ ] OPUS — Retrofit tenant_id + RLS to every existing table (done when: all tables pass policy audit; due 18 Jul) [AT:reccaeDbqNH68lEE5]
- [ ] OPUS — entities table per D1 (done when: migration applied; due 18 Jul) [AT:recu5PBEpdGlC07M0]
- [~] MICA — Finance page set onto the shell (Accounts + P&L landed 7 Jul; transactions + cashflow remain) [AT:recFxlJnVTFLIJV8C] (done when: pages load real data on Vercel; due 15 Jul)
- [ ] MICA — Tasks & Projects write-path cutover behind a flag (done when: task created on Vercel persists in Supabase; due 21 Jul) [AT:recu6haLe3QZNbQ70]
- [ ] OPUS — Parity check script: row counts + spot fields per migrated table (done when: first green run; due 21 Jul) [AT:recG8ubbnVjfLLOID]
- [ ] MICA — Full client's-shoes test pass of the migrated app [AT:recAuoApJczmHgXTG] (done when: bug list or clean report; due 24 Jul)
- [ ] OPUS — Replace Airtable automations that migrated pages rely on [AT:recXh2jvXq59eGkQM] (done when: no migrated page depends on one; due 24 Jul)

### De-Kevining (per PRODUCTISATION.md §4)
- [ ] OPUS — Identity/branding → tenant_config (done when: no Kevin hardcodes in migrated pages; due 22 Jul) [AT:recZyJQRT2I2MCcaV]
- [ ] OPUS — Team hardcodes → team_members table (done when: 6 arrays → one helper; due 22 Jul) [AT:reczyLcCLX61vkH9i]
- [ ] OPUS — Thresholds/targets → tenant_config (done when: budget targets from config; due 22 Jul) [AT:recek4wnLWICG0DFu]
- [ ] OPUS — Infrastructure URLs → tenant_config (done when: worker/proxy URLs configurable; due 22 Jul) [AT:rec4SPv4gphwEYCjo]
- [ ] OPUS — Per-tenant mentor prompt per D2 (done when: AI reads tenant prompt; due 23 Jul) [AT:rec8lZPeQ9V1VItBw]
- [ ] OPUS — Per-tenant AI key routing in claude-proxy per D9 (done when: test tenant bills the test key; due 22 Jul) [AT:recaLwiwCgaW28XyQ]
- [ ] OPUS — Remove all 'enter your API key' prompts (done when: none anywhere; due 23 Jul) [AT:reccT2gGzI9dPLQkg]
- [ ] OPUS — Empty-state sweep: every page helpful with zero records [AT:recKYTvkpyVZERmnN] (done when: clean new-tenant walkthrough; due 24 Jul)

### Finish + fixes
- [x] KEVIN+OPUS — Wealth module: personal cash flow + net worth statements [AT:recNxHUwt9DQnmjWg, recnbOvfUCXLKRFhJ, receMj0K0O6Ym8qgg] — or re-date post-launch at the team meeting (done when: built or re-dated; due 8 Jul decision) *(ticked 2026-07-14, synced from Airtable)*
- [x] OPUS — Fix P&L gross profit % + net profit sign [AT:recBCnFH2tRrUs5BD] (done when: /fix verified in browser; due 11 Jul) *(ticked 2026-07-14, synced from Airtable)*
- [ ] OPUS — Update sop-cfvs.html for the 3 Jul CFV detection change [AT:rec9ihFqDDSY8DMLZ] (done when: drift monitor clear; due 14 Jul)
- [ ] OPUS — 13-year-old workflow visual aids per page [AT:recinNtKPawy2g3vI] (done when: every page has one; due 25 Jul)
- [ ] OPUS — Manual KPI entry STANDARD + "Connect your numbers — Finance module" upsell state (D3 companion) (done when: both verified on a test tenant; due 24 Jul) [AT:recBACpQPF8x8VORc]
- [ ] KEVIN — (NEW) Content Machine: merge the hardened branch into the main app marketing section, or explicitly defer (done when: merged or defer logged; due 15 Jul) [AT:recLZd4a7hxK9HfH6]
- [ ] OPUS — (NEW) Trial-end + payment-failure + cancellation flows: what happens in Stripe/GHL/app when a trial converts, a card fails, or a client cancels — map and close gaps (done when: all three flows tested end-to-end in test mode; due 23 Jul) [AT:recYAjccWhOGqbFIt]
- [ ] OPUS — (NEW) Error monitoring on the client-facing app (Sentry free tier per the migration plan) (done when: a forced error appears in Sentry; due 25 Jul) [AT:recsN5m4gCi3SaLmD]
- [x] ERICAMAE — (NEW) Mobile responsiveness pass on all client-facing pages (sales, booking, app shell) (done when: screenshots at 375px width, no broken layouts; due 18 Jul) [AT:rec1pullKuO84OX3u] *(ticked 2026-07-18, synced from Airtable)*

## 5. AI agent fleet — 10 demo agents on Kevin's businesses (NEW section, Kevin 7 Jul)

The sales evidence: prospects see real agents running real businesses. Route: Systemisation pipeline (Loom → SOP → readiness → disposition → shadow → live). Existing: CFV agent (testing), rent-chase queue (built), reconciliation auto-approve (built). Target: **10 shortlisted; launch gate = minimum 3 LIVE with demo recordings by 31 Jul** (amended 8 Jul, was "10 live").

- [ ] KEVIN — Clear the CFV agent's pending approval queue with feedback (done when: 0 pending; due 9 Jul) [AT:recIRpGlkXo8Al1rq]
- [ ] KEVIN — Daily approvals until ≥90% over 3 consecutive runs (done when: stats bar shows it; due 16 Jul) [AT:recIRpGlkXo8Al1rq]
- [ ] KEVIN — CFV agent Go Live with empty autoFields (done when: state LIVE; due 17 Jul) [AT:recIRpGlkXo8Al1rq]
- [ ] KEVIN — Widen CFV autoFields after 1 clean live week (done when: one field auto-updating; due 24 Jul) [AT:recIRpGlkXo8Al1rq]
- [ ] OPUS — Regenerate remaining title-only SOPs from real transcripts (done when: all agent SOPs regenerated; due 14 Jul) [AT:recXsCqS1rBCPhSg9]
- [ ] KEVIN — Shortlist the 10 demo processes across the businesses (candidates: CFV ✓, rent-chase ✓, reconciliation ✓, contractor dispatch, inbound comms triage, invoice matching, compliance cert chasing, meeting-task extraction, weekly KPI digest, content repurposing) (done when: 10 named in this plan; due 10 Jul) [AT:rechRc6pLSjAhiL3Z]
- [ ] KEVIN — Record the Looms for the non-built processes, AGENTIC script on screen (done when: one Loom per process in Systemisation; due 18 Jul) [AT:recwItBqdryXnGspq]
- [ ] OPUS — Run each new process through the pipeline to shadow mode, batch 1 (agents 4-6) (done when: sensible first shadow proposals each; due 22 Jul) [AT:recJiNizaoVMyPmFB]
- [ ] OPUS — Batch 2 (agents 7-10) to shadow mode (done when: same; due 29 Jul) [AT:rec3XMOBOGIBFJq9V]
- [ ] KEVIN — Approval reps on every shadow agent until each is live or honestly parked (done when: live/parked recorded per agent; due 7 Aug) [AT:recAjXoIwgYgd9j1u]
- [ ] KEVIN — (NEW) Demo evidence pack: 2-3 min screen recording per live agent + the "agents live" counter shot (done when: recordings in the sales folder; due 31 Jul) [AT:recmxhP6SvCxzHe58]
- [ ] OPUS — (NEW) Blueprint tab v1 (the "% of work run by AI" map — docs/business-blueprint-spec.md) so demos show the whole fleet on one screen (done when: tab renders real workflow/agent data; due 31 Jul) [AT:recOnw3OvC9Ub2pYE] *(16 Jul: confirmed this task OWNS the 90% number — a duplicate meter was proposed for the skills library and dropped to keep one north-star figure on one screen)*
- [x] OPUS — (NEW 16 Jul) Systemisation: agent identity card (an agent had no self — it borrowed the workflow's name), autonomy dial naming the existing ramp so clients can see which gear they are on, and the Rule of R gate above the disposition choice *(built + verified 16 Jul, PR fix/ai-model-single-source; see §13)* [AT:-]
- [ ] KEVIN — (NEW 16 Jul) Systemisation: reverse-engineer-from-source capture path — learn the playbook from the client's existing data (inbox/CRM/docs) instead of a Loom, where the source data exists. Deferred: needs Supabase tenant data (§4) (done when: a workflow can produce an SOP from source data with no Loom; due 15 Aug) [AT:rec8oJRYKr2XdRLjV]

## 6. Client onboarding & delivery (Ch6 activation)

- [ ] KEVIN — Review Mica's onboarding sequence (owed since 26 Jun) [AT:recMQlb7uMQZLlFcm] (done when: feedback sent; due 9 Jul)
- [~] KEVIN — Async client intake form + Loom [AT:recukdbjiqU5UejBo] (done when: test submission collects everything; due 16 Jul) — public `onboarding.html` + `onboarding-submit` fn built 22 Jul (awaits Mica deploy + a real test submission + the Loom)
- [ ] OPUS — Client Profile interview v1 (docs/client-profile-questionnaire.md) writing tenant_config (done when: dry-run fills a fictional client's config; due 21 Jul) [AT:recTRDQpKIbF01VTt]
- [ ] OPUS — Provisioning runbook: create tenant, seed data, module flags, client AI key (D9) (done when: rehearsal tenant created + removed; due 23 Jul) [AT:recULNUD5SN7lDy4o]
- [ ] OPUS — Onboarding seeds recurring KPI-update tasks per installed manual KPI (done when: rehearsal creates them; due 24 Jul) [AT:recTPB1BJOYdICJT3]
- [ ] KEVIN — (NEW) Welcome pack: welcome email + what-happens-next one-pager + team-invite instructions (done when: drafts approved in GHL; due 18 Jul) [AT:recr5sYAXWJahEuBA]
- [ ] KEVIN — (NEW) "Three hated jobs" first-agent selection step in the intake (fastest route to the Key Event: first agent live) (done when: question in the intake + mapping note to skills; due 18 Jul) [AT:rec6DlDYAQ2LEyUKT]
- [ ] OPUS — (NEW) Data-import checklist per module (what we need from the client, in what format, for each module they buy) (done when: checklist doc per module; due 23 Jul) [AT:rec87uC3UZS7a6t8G]
- [ ] OPUS — (NEW) Client-facing how-it-works guide for their tenant (adapt how-it-works.html to the generic offer) (done when: guide renders for a test tenant; due 28 Jul) [AT:recZssdXwLKCDEhDM]
- [ ] KEVIN — (NEW) 14-day activation checklist (dashboard populated → team using Tasks → first agent live) with owner per step (done when: checklist in the provisioning runbook; due 21 Jul) [AT:recb6s1akOehVzLC9]
- [ ] OPUS — (NEW 15 Jul, from Jenyns Loom) Process-to-Agent delivery runbook (Kevin approves): write the client-facing 5-step method as the standard WRAPPER over the existing §5 Systemisation pipeline and the Systemisation module (do NOT rebuild the module) — (1) point Claude at a real task + its SOP, (2) dry run, (3) 80/20 split with the usual task owner reviewing, (4) iterate 2-3×, (5) schedule recurring with a human on exceptions. STEP ZERO = process-clarity gate: client answers who they serve / the value / how it is delivered / the tasks + checklists, before any tool is connected or agent built ("measure twice, cut once") (done when: one-page runbook + gate checklist exist and reference §5 + the Systemisation module; due 22 Jul) [AT:-]
- [ ] KEVIN — (NEW 15 Jul, from Jenyns Loom) Client team-adoption playbook onboarding asset: mandate (non-optional) + founder leads by example + celebrate small wins; handed to every client at onboarding because adoption, not tooling, stalls the 90%-AI goal (done when: one-pager + first-30-days checklist approved; due 22 Jul) [AT:-]
- [ ] KEVIN — Activation bumpers (automated nudges) [AT:recanqepcizlcNin9] (done when: nudges firing; due 8 Aug)
- [ ] OPUS — Onboarding-stall instrumentation [AT:recOoH5Ce67fgGClC] (done when: activation events tracked; due 12 Aug)

## 7. Lead generation — attention (Ch3/Ch4)

- [x] ERICAMAE — Deliver the LinkedIn outbound proposal [AT:recR5cIwV8A8Q8NDt] (done when: written proposal with Kevin; due 8 Jul) *(ticked 2026-07-16, synced from Airtable)*
- [ ] KEVIN — Approve/adjust it same day (done when: reply sent; due 8 Jul) [AT:-]
- [x] ERICAMAE — Target list v1: 60 founder-led UK SMEs matching the 5 hot-buttons (done when: 60 rows with signal noted; due 10 Jul) [AT:recwTeqcJwSAaSo9R] *(ticked 2026-07-16, synced from Airtable)*
- [ ] ERICAMAE — 3 outreach message templates from the hot-buttons (done when: Kevin approved all 3; due 11 Jul) [AT:rec7CmRC1QiL6cMLZ]
- [ ] KEVIN — (NEW) LinkedIn profile revamp: Kevin's profile is the outreach landing page — headline, about, featured to the core message (done when: profile matches the 13-yo message; due 11 Jul) [AT:recZV6j6rPyPvlRb6]
- [ ] ERICAMAE — First 20 personalised touches sent (done when: 20 logged; due 14 Jul) [AT:recTLE3GO6lSC6fu5]
- [ ] ERICAMAE — (NEW) Reply-handling templates + SOP (positive / question / not-now / referral) so responses never sit (done when: 4 templates approved + response-time rule; due 15 Jul) [AT:recURXC8NvECVuY9e]
- [x] ERICAMAE — Ramp to 60 touches/week from w/c 21 Jul (done when: weekly scorecard shows 60; due 21 Jul) [AT:recHJ5Qn8QdjrI0y4] *(ticked 2026-07-18, synced from Airtable)*
- [x] FABLE — (NEW 13 Jul) Prospecting engine v1: Prospecting tab (review queue + funnel + keyword manager), Prospects + Prospect Keywords Airtable tables, /prospect-daily agent skill (LinkedIn assisted browsing via Kevin's Chrome, Companies House PECR gate, GHL sync), weekday scheduled run *(built + verified 13 Jul)* [AT:-]
- [ ] KEVIN — (NEW 13 Jul) GHL Private Integration token (scope contacts.write) + Location ID saved to `~/.config/od/ghl_api_key` and `~/.config/od/ghl_location_id` — until then the agent queues prospects but cannot sync approved ones (done when: agent reports a successful GHL sync; due 15 Jul) [AT:-]
- [ ] KEVIN — (NEW 13 Jul) First supervised /prospect-daily run: watch quality of the first batch, tune keywords, then let the daily schedule own it (done when: first batch reviewed in the Prospecting tab; due 15 Jul) [AT:-]
- [ ] ERICAMAE — (NEW 13 Jul; amended same day ×2) Nurture sequence triggers on GHL tag `od-prospect-nurture` (the prospecting agent applies this tag only after 7 silent days, Ltd contacts only); **3 emails maximum** (Kevin's call: non-aggressive, value-led, each with a call CTA); templates carry sender identity, postal address and unsubscribe (PECR) with Kevin sign-off before switch-on. Also: build a Smart List filtered on tag `od-prospect`, verify GHL email sending (LC Email) works from the location, and ensure NO workflow ever triggers on `od-prospect` or `od-prospect-manual` (done when: test Ltd contact tagged nurture receives the 3-email sequence + a test send from conversations succeeds; due 18 Jul) [AT:-]
- [x] ERICAMAE — Lead-Magnet Capture & Nurture workflow live [AT:receDDArEOlLDZaBN] (done when: workflow on; due 15 Jul) *(ticked 2026-07-08, synced from Airtable)*
- [x] ERICAMAE — Gate the Founder-to-Free magnet (email → link → thank-you CTA to Teardown) (done when: test lead gets it gated; due 16 Jul) [AT:receDDArEOlLDZaBN] *(ticked 2026-07-08, synced from Airtable)*
- [x] ERICAMAE — GHL nurture sequences by funnel stage [AT:recKlaXRJXupP36pJ] (done when: test lead receives sequence; due 18 Jul) *(ticked 2026-07-14, synced from Airtable)*
- [x] ERICAMAE — Content engine LinkedIn-led, problem-first [AT:recgErOu3AiipDQo4] (done when: 3 posts/week running; due 14 Jul) *(ticked 2026-07-16, synced from Airtable)*
- [ ] ERICAMAE — Comparison pages (vs DIY / VA / agency) [AT:reckGG3pb7U5qJYQV] (done when: pages live; due 12 Aug)
- [ ] ERICAMAE — Retargeting across the funnel [AT:recQnZxHECFiumZwn] (done when: pixels + audiences live; due 12 Aug)

## 8. Sales & conversion (Ch5 Rocket Demo)

- [x] ERICAMAE — Verify sales + thank-you pages show £350/£1,500 + trial everywhere (done when: screenshots in Slack; due 9 Jul) [AT:rect3tMNA5vAUUf0t] *(ticked 2026-07-16, synced from Airtable)*
- [ ] ERICAMAE — Resolve the 2 sales-page placeholders (calendar link, worker URL) (done when: both live; due 9 Jul) [AT:rectDqrReN31yzJcr]
- [x] MICA — Fix the Stripe webhook delivery failures on od-billing-bridge [AT:recjybZNepSBpDLeP] (done when: deliveries succeeding; due 9 Jul) *(ticked 2026-07-14, synced from Airtable)*
- [ ] ERICAMAE — Full dry-run: book Teardown → calendar; checkout → contract + welcome email (done when: evidence in Slack; due 10 Jul) [AT:recrgbZ4SKtCladgr]
- [x] ERICAMAE — Website clarity pass [AT:recSlGxdgHaecSGG1] (done when: Kevin sign-off; due 11 Jul) *(ticked 2026-07-14, synced from Airtable)*
- [x] ERICAMAE — Pricing page from the SIMPLE locked card [AT:recnggtrSkRcjT9fU] (done when: live at 29 Jun pricing; due 11 Jul) *(ticked 2026-07-14, synced from Airtable)*
- [ ] KEVIN — Answer Ericamae on the trust video (waiting since 29 Jun) [AT:recG4RxL6ewQoEvPX] (done when: yes/no sent; due 8 Jul)
- [ ] KEVIN — (NEW) Contract + T&Cs reflect the simple pricing (sendlink contract still at old terms?) + refund/cancellation lines + AI limitation-of-liability clause + human-approval-defaults-on wording (amended 8 Jul) (done when: contract reissued at £350/£1,500 + trial terms + AI clauses; due 11 Jul) [AT:rec87RsSw8UdBbxqc]
- [ ] KEVIN — Founder Dependency Score live-on-call sheet [AT:recFNqmzmeSmOfgJw] (done when: usable on a call; due 10 Jul)
- [ ] KEVIN — Rocket Demo flow one-pager (done when: doc exists; due 12 Jul) [AT:rece60QJYytAQxsiL]
- [ ] KEVIN — (NEW) Objection crib sheet from the real historic calls (price #1, want-a-demo, credibility, burned-before, consult-partner) with your answer to each (done when: one page, used in the dry-run; due 12 Jul) [AT:recgbVSeU22pHeOwV]
- [ ] ERICAMAE — (NEW 15 Jul, from Jenyns Loom) Connector on-ramp copy (Kevin approves wording): "you don't need to know what an MCP server or an API is, it walks you through it" — add to the pricing page + Rocket Demo first-call script to defuse tech fear for non-technical owners (done when: line live on the pricing page + in the demo one-pager; due 22 Jul) [AT:-]
- [ ] KEVIN — (NEW) Demo tenant with anonymised sample data for Rocket Demos (pairs with §5 evidence pack) (done when: demo login shows a populated believable business; due 22 Jul) [AT:recIUH5bvRdFZWeqa]
- [ ] KEVIN — One dry-run Teardown with Mica or Ericamae as prospect (done when: dry-run held; due 14 Jul) [AT:recjhBwlCkKqpnk8I]
- [ ] KEVIN — (NEW 8 Jul) Feedback walkthrough with the letting-agent founder: sit-down session, capture what lands / what confuses / what he'd pay for / his first-agent pick, route fixes into the launch plan (done when: session held + feedback list logged; due 16 Jul) [AT:recr2SE4YjIizu3gQ]
- [ ] KEVIN — Design-partner offer terms (founding rate + case study + testimonial) (done when: one-pager; due 11 Jul) [AT:recGG8hME8rFgTUqG]
- [ ] KEVIN — Seed clauses in the live contract BEFORE partner #1 signs [AT:rec3HGmM6uHgKK1v8] (done when: clauses in; due 11 Jul)
- [ ] KEVIN — (NEW) Case-study template ready before partner #1 (what we capture, when, in what format) (done when: template exists; due 18 Jul) [AT:recyMjpz4Q7PdAD1f]
- [ ] KEVIN — Sign design partner #1 (done when: contract + payment; due 25 Jul) [AT:recuVmLNDMF8YpG5W]
- [ ] KEVIN — Sign design partner #2 (done when: contract + payment; due 31 Jul) [AT:recSskHtwYleopRnc]

## 9. Retention & expansion (Ch7/Ch8)

- [ ] KEVIN — (NEW) Publish the queue SLA + how-to-submit inside the app (the £350 promise made concrete; kills "coaching course" drift) (done when: visible to a test tenant; due 25 Jul) [AT:recrH6jRWrEBjDFrq]
- [ ] KEVIN — (NEW) Monthly client value report template (agents live, hours saved, work done — the retention weapon) (done when: template produced from Kevin's own tenant data; due 8 Aug) [AT:rec8M0KMPHxOgtjLJ]
- [ ] OPUS — Customer health score / CHI v1 [AT:recsQpgEUl9O714gL] (done when: score per tenant; due 14 Aug)
- [ ] KEVIN — Churn monitoring [AT:reczsB25zO4O92EFq] (done when: churn number in weekly review; due 14 Aug)
- [ ] KEVIN — Win-Ask referral machine once the first win exists [AT:recSUUOooDBf2GRqo] (done when: first ask made; due 21 Aug)
- [ ] KEVIN — Honour the first-customer team commitments (done when: actioned privately; on first client) [AT:-]
- [ ] KEVIN — Phase 2 pricing: modules + annual, hand-sold to design partners first (done when: decision review; due 15 Sep) [AT:recAMeghUVwE9EuKx]
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

- [ ] OPUS — Full pre-deploy pass (skill: pre-deploy) (done when: clean report; due 29 Jul) [AT:recRONNTnugjcty0Q]
- [ ] OPUS — Regression: every tab, zero console errors, live + Vercel (done when: evidence saved; due 29 Jul) [AT:reciLx4y5AZJ8VvAC]
- [x] KEVIN — Build + sign off launch-scope modules [AT:rec5bUChevzCQfdyV] (done when: sign-off logged; due 30 Jul) *(ticked 2026-07-14, synced from Airtable)*
- [ ] KEVIN — (NEW) Go/no-go criteria list agreed BEFORE the review (checkout works, zero criticals, support route live, agents demo-able) (done when: list written; due 25 Jul) [AT:rec5jJKKAJne3ncIc]
- [ ] KEVIN — (NEW) Backup/rollback: Supabase backup confirmed + Airtable snapshot taken + how-to-revert note (done when: both verified; due 30 Jul) [AT:recMzgGvDFCldnLyN]
- [ ] KEVIN — (NEW) Support route live: support@ address routed + who answers + response target (done when: test email answered; due 30 Jul) [AT:recT8wabpzF7MnzW3]
- [x] KEVIN — Make the product publicly live and purchasable [AT:rec1oFlkDNI6MRAnU] (done when: a stranger can buy; due 1 Aug) *(ticked 2026-07-14, synced from Airtable)*
- [ ] KEVIN — Confirm the 1 Aug monthly-valuations run succeeded (done when: Action green; due 1 Aug) [AT:recUMjzYVDsXU0EY3]
- [ ] KEVIN — Go/no-go review against this plan (done when: decision in Changelog; due 31 Jul) [AT:reckHAHBcDOH0JxU1]
- [x] ERICAMAE — Launch announcement: website banner + LinkedIn post + email to list (done when: all three live; due 1 Aug) [AT:rec5DeFwALGaHQMH2] *(ticked 2026-07-18, synced from Airtable)*
- [x] KEVIN — Resolve all critical launch-week bugs via /fix [AT:recRhajAjdshE4NqN] (done when: zero criticals; due 3 Aug) *(ticked 2026-07-07, synced from Airtable)*
- [ ] KEVIN — Acquire + onboard the first paid subscriber [AT:recsqZey1t0o4BE0l] (done when: paid, provisioned, activated; due 15 Aug)
- [ ] KEVIN+TEAM — Client #1 activation ladder complete ≤1 month (done when: Key Event logged; due 15 Sep) [AT:recMjHDeP8SwBouSr]

## 12. Superseded plans (absorbed 7 Jul 2026 — kept for history, do not work from them)

**Drive:** Software as a Science Action Plan + Launch Roadmap (17 Jun) · Migration Brief — Team Handoff · Sales & Marketing Team Brief · operations-director-launch-plan (sheet + md — md has PRE-LOCK pricing) · Q2-2026 plan PDF · Q1-2026 strategic plan · Q3-2025 strategic plans (equity model — obsolete) · 12-Week Implementation Plan.
**Still live as STRATEGY REFERENCES:** GTM Playbook · Pricing & Packaging Strategy.
**Still live as SPECS:** PRODUCTISATION.md · docs/client-profile-questionnaire.md · docs/agent-runtime-spec.md · docs/agentic-extraction-spec.md · docs/business-blueprint-spec.md · docs/supabase-schema-spec.md.

## 13. Proposed Amendments (holding pen — nothing live until Kevin approves)

| Date | Source | Proposal | Kevin's call |
|---|---|---|---|
| 2026-07-08 | Fable 5 launch pressure-test (investor/competitor/regulator seats, in-session) | Add KEVIN warm-network lane to §7: 10 direct asks to known founders/contacts by 11 Jul. Cold outreach alone cannot produce 2 signed partners by 31 Jul (first touches 14 Jul → close in 11 days is not credible). | RESOLVED (modified) 8 Jul — Kevin: feedback-first. Letting-agent walkthrough task added to §8 (due 16 Jul); conversion optional, not the goal. The 10-direct-asks element not adopted; paid-partner pipeline stays cold-outreach-only. |
| 2026-07-08 | Fable 5 launch pressure-test | Re-sequence: pull the Ch11 services-economics pass (§10, due 17 Jul) forward to 10 Jul so unit economics are known BEFORE design-partner terms lock on 11 Jul. | REJECTED 8 Jul — Kevin: measure real delivery cost from the first onboarded clients and drive efficiencies from live data; §10 founder-minutes instrumentation already covers the measurement |
| 2026-07-08 | Fable 5 launch pressure-test | New §3 task: GDPR pack by 18 Jul — ICO registration check, privacy policy on the sales site, client-facing DPA, sub-processor list (Supabase, Anthropic, Vercel, GHL, Stripe), retention line. Currently absent from the plan; design partners' accountants will ask. | APPROVED 8 Jul — live in §3 |
| 2026-07-08 | Fable 5 launch pressure-test | Extend the contract task (§8, rec87RsSw8UdBbxqc) to add AI-specific limitation-of-liability + human-approval-defaults-on language, not just pricing/refund terms. | APPROVED 8 Jul — scope added to the §8 task |
| 2026-07-08 | Fable 5 launch pressure-test | Reframe §5 target: 10 processes shortlisted, but launch gate = minimum 3 agents LIVE with demo recordings by 31 Jul. Protects approval-rep quality; sales story needs 3 good agents, not 10 rushed ones. | APPROVED 8 Jul — §5 target updated |
| 2026-07-16 | Dan Martell "You're Not Behind (Yet): How to Build Your First AI Agent" (transcript-to-brain; doc: Learning & Reference/Transcripts/2026-07-16 Dan Martell — Build Your First AI Agent.md) | Five points proposed from the video. **Finding: three of the five already existed in the product under other names** — `disposition` IS the Rule of R, `agent.state` + `autoFields` IS the trust ramp, and the AGENTIC "C" and "I" stages already capture the definition of done and the guardrails. So the adopted scope was only the genuine gaps: **(a)** agent identity card (name, role, DOD, who it serves, voice, lane, never-dos) — an agent had no self, it borrowed the workflow's name; **(b)** autonomy dial naming the existing ramp in plain English so a client can see which gear they are on; **(c)** Rule of R as a gate above the disposition choice; **(d)** admin-only model tier — DROPPED, no role model exists anywhere in the platform, that is a greenfield auth project not a label; **(e)** 90% meter — DROPPED as duplicative, already owned by the §5 Blueprint tab task [AT:recOnw3OvC9Ub2pYE]. Reverse-engineer-from-source capture path deferred (needs Supabase tenant data) [AT:rec8oJRYKr2XdRLjV]. | APPROVED 16 Jul — Kevin: incorporate all, in-session. (a)(b)(c) BUILT + browser-verified (PR `fix/ai-model-single-source`). (d) and (e) dropped as above. Kept AGENTIC as the capture brand; Dan's AGENT steps folded into the existing AI Agents tab rather than surfacing a second competing acronym. |
| 2026-07-16 | Same session (Kevin's call, resolves a spec conflict) | `docs/agent-runtime-spec.md` said autonomy graduates automatically on measured accuracy ("the number drives the autonomy, not a guess"). That contradicted both the shipped code (a human has always flipped the state) and Kevin's choice. Amend the spec: the OWNER moves the ramp, accuracy ADVISES. | APPROVED 16 Jul — spec amended. Rationale: handing autonomy over without a human yes is what breaks client trust, and client trust is what the 90%-AI goal runs on. The accuracy bar drops into `agentGearAdvice()` as guidance once the runtime logs accuracy (today only reconciliation has real metrics). |
| 2026-07-15 | Dave Jenyns / SYSTEMology Loom "How AI Turns Businesses into Systems" (transcript-to-brain; doc: Learning & Reference/Transcripts/2026-07-06 How AI Turns Businesses into Systems.md) | Productise Dave Jenyns' task-to-agent method as OD's standard delivery method, in four parts. **(a) §6 — Process-to-Agent runbook:** fix the client-facing 5-step method — point Claude at a real task + its documented process → dry run → 80/20 split with the usual task owner reviewing → iterate 2-3 times → schedule as recurring with a human on exceptions. **(b) §6 — process-clarity gate (step zero):** before any tool is connected or agent built, client answers who they serve, the value, how it is delivered, and the tasks/checklists underneath ("measure twice, cut once"). **(c) §6 — team-adoption playbook onboarding asset:** mandate (non-optional) + founder leads by example + celebrate small wins; adoption, not tooling, is the real bottleneck to the 90%-AI goal. **(d) §7/§8 — connector on-ramp copy:** "you don't need to know what an MCP server or an API is, it walks you through it" on the pricing page + first-call script. Items (a)+(b) are one delivery-method doc; (c) is an onboarding asset; (d) is sales copy. All reversible, no code, ~1 day of writing. | APPROVED 15 Jul — Kevin: yes, do it. Live as tasks: (a)+(b) §6 runbook + gate (due 22 Jul); (c) §6 adoption playbook (due 22 Jul); (d) §8 connector copy (due 22 Jul). Positioned as a WRAPPER over the existing §5 pipeline + Systemisation module, not a rebuild. |

## 14. Changelog

| Date | Source | Change |
|---|---|---|
| 2026-07-22 | Kevin, in-session (approved plan) | §6 client intake: shipped the **public client onboarding form** (`onboarding.html`) — a signed-up client fills essential account-setup answers (identity, businesses, locale, team, banking, targets, act/ask thresholds); on submit the `onboarding-submit` Edge Function (service-role, `--no-verify-jwt`, honeypot-guarded) saves the full answers to the new `onboarding_submissions` table and creates a CRM contact + a **Won**-stage deal in the Operations Director Main workspace, chaining into the existing "Create client account" provisioning button. DEPLOYED 22 Jul: `0032_onboarding.sql` applied via SQL editor; `onboarding-submit` deployed `--no-verify-jwt`; end-to-end test returned `{ok:true}` with contact + Won deal + submission created. Advances §6 line "Async client intake form" [AT:recukdbjiqU5UejBo] → `[~]`; still owes the Loom walkthrough. CRM gains a "📋 Onboarding link" copy button. Branch `feature/onboarding-form`. |
| 2026-07-17 | Kevin, in-session (prod E2E sweep → /fix, approved: "move the token out of airtable", rotate chosen) | **A live service token was sitting in a PAT-readable Airtable field; removed and rotated.** `PROXY_SERVICE_TOKEN` (the bearer the valuations job uses to call the Claude proxy) had been parked in the `Active Skill IDs` field of the "(Deprecated) Settings" table since 14 Jul, as a stop-gap because the repo PAT cannot create GitHub secrets. Every Airtable PAT on the base could read it — ~23 exist, several stale, one with All-workspaces scope. Found sideways: the daily sweep hit a 422 on the Skills tab, which reads its *own* setting from that same field. Fixing that 422 the obvious way (switch to Airtable's list endpoint, which is what accepts `fields[]`) would have pulled the token into the browser on every Skills tab load — so both fixes are now pinned by regression tests. `scripts/monthly-valuations.py` no longer reads Airtable for the token and exits 1 if it is unset (it used to warn, skip every property, and exit green having valued nothing). Value cleared from Airtable + rotated, so the exposed value is dead, not relocated. Commits `28edb5d`, `ccdb817`. Remaining: the two KEVIN steps in §5 (GitHub secret + workflow env line) — the 1 Aug valuations run exits 1 until both land. |
| 2026-07-16 | Kevin, in-session (/transcript-to-brain → /build-feature, approved) | **Launch risk found and fixed: 61 hardcoded AI model IDs across 20 files.** One model retirement would have taken down AI across the whole platform at once. Worse, the IDs had DRIFTED — the Supabase twins were pinned to OLDER models than production (`os/systemisation/index-supabase.html` on `claude-sonnet-4-20250514` ×9, `os/operations/index-supabase.html` on `claude-sonnet-4-5`, `os/tasks/index-supabase.html` on `claude-sonnet-4-5-20250929`), so the §4 migration cutover would have silently regressed model quality. New `js/ai-models.js` is the single source (window-scoped, so pages that declare their own BASE_ID/PAT/TEAM can load it — that collision is why they hardcoded). All 21 browser pages verified. Found by auditing "is model routing applied?" — the answer was no. Remaining: 3 Workers + the Slack bot (server-side, need redeploys) → task [AT:reckdEpatiqesu6ua]. |
| 2026-07-16 | Kevin, in-session (/build-feature, approved) | §5 Systemisation: agent identity card + autonomy dial + Rule of R gate shipped (PR `fix/ai-model-single-source`). Closes the two real gaps in the process-to-agent pipeline: an agent had no identity of its own, and the trust ramp existed but was invisible to the client. See §13 for the full amendment and what was dropped. `docs/agent-runtime-spec.md` amended: owner moves the ramp, accuracy advises. |
| 2026-07-07 | Fable 5 session with Kevin | Plan created from full audit (repo, Airtable, Slack, Drive). Supersedes all prior plan docs (§12). |
| 2026-07-07 | Kevin, in-session | D1-D9 decided (PRODUCTISATION.md §5). D3 companion: manual KPI standard + upsell state + seeded recurring tasks. D9: clients pay own AI via per-tenant keys. Cleanse approved with no-business scan + SMART pass. Sync-automation tasks added. OPUS driver: hybrid by lane. |
| 2026-07-07 | Cleanse applied (Claude agent, Kevin-approved) | 53 closed (commented), 52 created, 16 re-dated, 4 parked, 9 orphans linked, 3 RECAT-flagged. Zero duplicates verified. 93 open OD tasks. Finding → task: 92 nameless AP rows. Kevin's base identity = kevin@runpreneur.org.uk. |
| 2026-07-07 | Kevin, in-session (structural change, approved) | RESTRUCTURED phases → Software-as-a-Science sections (§3-§11): foundations, product, agent fleet, onboarding, lead gen, sales, retention, metrics, launch. Gap-fill pass added 20 (NEW) tasks on the duplicate-beats-a-miss rule. NEW §5: 10 demo agents on Kevin's businesses by end July. Some Day parking reversed → real future due dates. All prior task states preserved. |
| 2026-07-07 | Nightly sync (scripts/sync-master-plan.py) | ticked 3 from Airtable completions; pushed 1 new plan tasks to Airtable. |
| 2026-07-08 | Nightly sync (scripts/sync-master-plan.py) | ticked 4 from Airtable completions. |
| 2026-07-08 | Kevin, in-session | Approved pressure-test amendment 3: GDPR pack task added to §3 (Kevin+Opus, due 18 Jul, Airtable recxhhfUWIGiumUtU). Amendments 1, 2, 4, 5 remain in §13 pending Kevin's call. |
| 2026-07-08 | Kevin, in-session (second pass) | Amendment decisions: AI-liability contract scope APPROVED (§8 task extended); §5 target reframe APPROVED (launch gate = min 3 live agents with recordings); economics re-sequence REJECTED (measure from live clients, §10 instrumentation covers it); warm-network lane PENDING (Kevin has a free letting-agent pilot; paid design-partner question in discussion). |
| 2026-07-08 | Kevin, in-session (third pass) | Amendment 1 RESOLVED (modified): feedback-first. Letting-agent founder walkthrough task added to §8 (due 16 Jul, Airtable recr2SE4YjIizu3gQ). Conversion optional. All 5 pressure-test amendments now decided. |
| 2026-07-13 | Kevin, in-session (/build-feature, approved) | §7: Prospecting engine v1 added and built — AI agent finds founder-led UK prospects from LinkedIn pain signals (assisted browsing, Kevin's Chrome, kill-switch on LinkedIn friction), Companies House PECR gate (Ltd-only email; sole traders manual track), review queue in new Prospecting tab, GHL sync on approval. 3 follow-on tasks added (GHL token — Kevin; supervised first run — Kevin; nurture tag wiring — Ericamae). Complements Ericamae's manual outbound lane, does not replace it. |
| 2026-07-13 | Kevin, in-session (same day, iterations v1.1–v1.3) | Prospecting engine evolved on Kevin's direction: 5/day target, 7-day schedule, multi-platform (FB buying-signal search = top producer; X/Threads parked), conversation-first contact flow (personal GHL-sent email first, Claude leads replies, 7 silent days → Ltd to nurture, manual-track never sequenced), agent-drafted openers with per-card process lines, agent-sent LinkedIn connects (max 3/day, Kevin accepted account risk), Ericamae's §7 sequence task extended (tag trigger + Smart List + LC email check). End-state agreed: full autonomy after 2 weeks >90% approval rate — Kevin's first touch becomes the booked call. |
| 2026-07-14 | Nightly sync (scripts/sync-master-plan.py) | ticked 10 from Airtable completions. |
| 2026-07-15 | Kevin, in-session (transcript-to-brain) | Added §13 holding-pen proposal: productise Dave Jenyns' task-to-agent method as OD's standard delivery method (Process-to-Agent runbook + process-clarity gate + team-adoption playbook + connector on-ramp copy). PENDING Kevin's call — nothing live yet. |
| 2026-07-15 | Kevin, in-session (approved) | §13 Jenyns-Loom amendment APPROVED. 4 tasks now live: §6 Process-to-Agent delivery runbook + process-clarity gate (due 22 Jul); §6 team-adoption playbook (due 22 Jul); §8 connector on-ramp copy (due 22 Jul). Framed as a client-facing WRAPPER over the existing §5 Systemisation pipeline + Systemisation module, NOT a rebuild. Nightly sync to push new [AT:-] tasks to Airtable. |
| 2026-07-16 | Nightly sync (scripts/sync-master-plan.py) | ticked 4 from Airtable completions. |
| 2026-07-18 | Nightly sync (scripts/sync-master-plan.py) | ticked 3 from Airtable completions. |
