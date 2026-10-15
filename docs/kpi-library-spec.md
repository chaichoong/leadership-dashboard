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
14a. **Work done by AI %** — T4: estimated minutes of AI work ÷ estimated minutes of all work, on tasks completed in the window. AI work = agent on Team Member OR raised by an agent and approved first time; NEVER work the owner sent back. Publish estimate coverage beside it. *Live.* (Shipped 9 Aug 2026 in js/kpi-library.js; recorded here 28 Aug 2026 — this doc had fallen behind the canonical array.)
14b. **AI hours + labour cost saved** — T5 on the same engine: AI minutes × a fully-loaded hourly wage rate, as a rolling 30 days and a since-AI-go-live total, plus a full-time-equivalent framing. Rate and go-live date become per-tenant settings (Kevin's build: £17.50/hr, 1 Jun 2026). *Live.*

Sales and growth
15. **Prospects contacted** — T6: status at or beyond the contact stage. *Live.*
16. **Funnel stage counts + found-to-call rate** — T3 + T4.
17. **Calls booked / attended** — T3 (the north-star pattern from the content playbook).
18. **Pipeline value by stage** — T5 on CRM deals (Supabase side).

AI workforce
19. **Agent accuracy %** — T4 per agent per task type. Standardise on `js/agent-accuracy.js` (20 decisions, ≥90%, no recent rejections). The platform currently has THREE competing accuracy definitions (agent-accuracy.js, prospecting funnel, inbound-comms localStorage) — the library carries ONE.
20. **Approvals waiting** — T3: tasks at Status Approval.
21. **AI agents live** — T3 on workflow agent states.
22. **Agent work in vs out** — T3: live agent tasks, stuck agent tasks, and created against done in 7 days. *Live (9 Oct 2026),* on the AI Team section of the Leadership Dashboard. Changed 14 Oct 2026: the card read "190 open, 46 not moving" and Kevin took it as nothing working. Most of the 190 were not live work: 64 were scheduled for later, 18 sat with him for approval, and about 40 were done and waiting on a reply. And 19 of the 46 were not stuck agent work: one was Roy's task, and 18 were compliance tasks the dispatcher holds under a lead task on purpose. So the open count is split four ways (live, waiting for approval, waiting on a reply, scheduled), the headline is live, and stuck counts agent tasks only, leaving out the held ones. A row from before the change still shows the plain open count. The independent review of the change added five rules. A task with an open wall is live, not waiting on a reply. A carry-out must come after the newest approval, read from the dispatcher's carry-out log to the second, because the note holds only the date. A reply waited on for more than 14 days counts as live and stuck, and goes on the Estate tab's not-moving list under its own reason, so every task the card counts as stuck is on a list someone can read. An approval put off to a later date counts as scheduled. A task on no board gets its own row and is never counted as live. The open count is checked against Airtable's own count of open agent tasks, taken just before and just after the main read, and the report fails if a still board disagrees.
23. **Defect queue in vs out** — T3: open findings, and filed against fixed in 7 days. *Live.* Computed on the Mac, because the queue is a local file. Changed 14 Oct 2026 (Kevin: "merge duplicates, move the non-code items to tasks, stop the overflow log"): the card read 230 open when about a fifth were one problem filed again, 62 were matters no code fix can close, and 245 refused findings sat in an overflow log no number counted. Open now counts each problem once (a repeat merged into the first report is `duplicate`, and takes that report's final state when it closes, so a robot's wall on the repeat still wakes), split into code and not code; a not-code finding closes against the open task that carries it (`tasked`, the task read off Airtable first); and the cap's refusals that nobody has sorted are counted as refused, unread. Filed and fixed count distinct problems. The cap is now per filer (routine plus the agent that names itself), because fourteen agents filing under one routine shared one cap of 15. A row from before the change still shows the plain open count.
24. **Robots blocked (bottleneck)** — T3 on the blocker sweep, by kind, with the count that needs Kevin. *Live.*
25. **Fix-of-a-fix rate** — T4 from `scripts/rework-rate.py` over 14 days, against the 32% baseline. *Live.* Kevin's one number for estate health (brain Decisions/2026-10-09): defects arriving faster than they are fixed show up here first.

**Retired 15 Oct 2026: entries 22 to 25.** They stopped being their own cards on the dashboard.
Kevin could not read four true numbers as an answer ("If I can't understand them, I can't use
them"), so the "Is the AI team healthy?" panel (26 to 39) replaced them. Nothing they measured
was lost: the Agent Work split sits inside line 28's detail, the defect split and the fix-of-a-fix
rate inside line 33's, and the blocked count by kind inside line 29's. In `js/kpi-library.js` they
carry `status: 'retired'` with the date and what replaced them; a retired entry is never deleted.

**The "Is the AI team healthy?" panel (Kevin, 15 Oct 2026).** Fourteen of his questions in three
groups, each a colour, a short answer, a number, one sentence of rule and a trend against the
same day last week, under one verdict. Judged on the Mac by `scripts/ai_team_health.py` into the
Estate Status row `ai-team-verdict`; the page only draws it. Three rules hold for every line:
a source that cannot be read, is missing or is older than its own cadence makes the line grey,
"Can't tell", and the verdict names it (never green, never a zero); the trend history is kept
inside the row's payload, one number per line per London day for 30 days, mirrored to a local
file so one failed read cannot wipe it; and no line counts what another counts where that would
mislead, so walled tasks are taken out of "Everything's moving" before it counts. Verdict, in
order (tightened by the independent review of PR #790: no line or verdict may read better than
the truth): a red line worse than a week ago is red "Needs attention: <that line>"; more than two
lines that cannot be read is grey "Can't tell" (red, naming the worst red, when a red is known);
no red and at most two amber is green "Healthy" (amber "Healthy where it can be read" with one or
two grey lines); reds or ambers with more of THOSE lines better than worse than a week ago is
amber "Issues, but going the right way"; otherwise red. A failed build writes an empty payload,
so the page never shows the last good verdict under a fresh Last Run; the page ages the answer
by its own computedAt, and an answer over two hours old turns the verdict and every dot grey.
History keeps the last real number per line per day: a grey line, a missed or failed source and
a part-read floor store nothing and have no direction.

Is work flowing?
26. **Emails cleared (old inbox mail)** — T3: inbox mail older than 2 days after the last triage
    run, from the triage script's own scan and slot record, never its prose. Red also when the
    last scheduled run did not start or failed (Kevin's 14 Oct ruling: mail never ends in the
    inbox), and when it wrote no "done" line in its run log within its own run limit plus 15
    minutes: the slot record is written before the run, so a killed run still reads ok. A
    cut-off listing is a floor, never green.
27. **Email tasks waiting for a draft** — T8: open inbound tasks an agent owns, due, with no draft
    or card, made more than 1 working day ago. Walled and held tasks are left out.
28. **Live work stuck with nothing blocking it** — T4: the not-moving list's agent tasks minus
    every walled task, over live agent work. The walls are subtracted by id, from the sweep and
    a fresh read of each task's Notes, so a wall opened since the sweep is not counted twice.
29. **Blocked tasks past their limit** — T8: open walls past the task manager's own clock
    (`CLOCK_DAYS`: sign-in 1 day, code fix and the owner's step 3). An undated wall counts as past.
30. **Approved work not carried out in 24 hours** — T8: the dispatcher's own carry-out list,
    read from its queue, so work carried out and kept open, or resting on a wall, never counts.

Is anything broken?
31. **Agents idle with live work** — T3: agents holding live, unwalled work for a day with no
    action in 24 hours (a run report action, a completion, or a note line only the agent's own
    commands write). Shown as "N of M worked today".
32. **Scheduled jobs failing or blocked** — T3: Failed and Blocked rows on the job status board,
    by plain name (a Blocked run did no work: an expired sign-in, no network, the drive, the lock,
    a run stopped for its length). Claude limit stops are line 39's, the blocked-tasks report line 29's.
33. **Open code problems against a week ago** — T3: open code findings now against a week ago
    on today's rules (`defects_as_of` in `scripts/estate-status.py`): each finding's status as the
    real `current_state` folds the log cut 7 days back, leaving out findings merged as repeats
    since and using today's code tag. Folding the past with its own rules read 150 where today's
    rules read 127 (15 Oct 2026), so a rise looked smaller than it was. One number drives both the
    colour and the arrow. Plus filed against fixed.
34. **Daily data check result** — T3: the daily invariant sweep's result, each broken check named;
    grey when it has not run in 26 hours.
35. **Things missed** — T3: in 24 hours, parks the dispatcher's own `parked_tasks` reports that
    still have no card, wall or door; jobs that gave up waiting, were skipped as too late or missed
    their time, unless the job then finished cleanly (either log: run-job.sh's or the queue's own)
    before its next due time, which is listed as "ran late"; old inbox mail nobody decided.

Can it keep going?
36. **Agent work done against new (7 days)** — T4.
37. **Approval queue size and oldest card** — T8: the queue population is `APV_QUEUE_FORMULA`'s
    (Approval, not put off past today). Age runs from the newest send stamp in Notes (a submit, an
    escalation, or the KEVIN wall a Your step card waits on) or the day a put-off ended. Last
    Updated is not it: any edit moves it. A card with no stamp is aged from its creation and says so.
38. **Drafts approved first time %** — T4 over 14 days, the accuracy report's own population (form
    cards left out), checked against the task board's read: a verdict the board shows that the
    14-day read missed makes the line grey.
39. **Robot hours paused for the allowance** — T5: hours stopped in 7 days, the allowance guard's
    pauses joined with every limit line in any job's own `runs.log` (allowance.py's own `LIMIT_RE`
    and `parse_reset`), each running from its run's end line to the reset it names. The guard
    missed the 3-4 Oct stop; replayed on the real logs, 4 Oct 18:00 reads red "paused now" and
    6 Oct reads amber, 26 hours stopped, where the guard alone read green.

## 3. Tier 2 — Property pack (add-on only)

Occupancy rate · void units · rent roll (expected monthly income by payment status) · paid
tenancy rate · CFV count and exposure · arrears balance, days in arrears and Section 8
threshold (62 days) · gross and net yield · LTV · equity and capital growth · cash-on-cash ·
compliance certificate counts (expired / expiring 30d / active / missing) · payment-lag
buffer days · UC checks due. All already computed on the Operations, CFV, Compliance and
cashflow surfaces.

Added 2 Oct 2026 (Real Estate Q4 projects, rules in `js/re-kpis.js`, tests in
`tests/re-kpis.test.js`):

- **Named units with a signed tenant in.** A quarterly lettings target is a list of named
  units, not a count. Q3 2026 missed because "the four tenancies" had no list and two agents
  picked different sets. The template takes unit record ids, counts a unit when a live tenancy
  is linked, and lets a unit exclude the tenant who is leaving it.
- **New monthly rent in payment from named tenants.** Measures the plan, not general lettings:
  only the named tenants and units count, only while In Payment, each tenancy once. A
  replacement tenant elsewhere is deliberately invisible to it.
- **Units moved to a new letting arrangement.** The named-units template with a move date. A
  unit that changes arrangement (serviced accommodation to a letting agent, 9 Oct 2026) already
  holds live tenancies, and some old records never got an end date, so "a live tenancy is
  linked" would read the move as done on day one. Only a tenancy that starts on or after the
  move date counts, and the old arrangement shows as "Still on the old arrangement".
- **Pounds a cause confirms it received.** (Fundraising pack, Runpreneur, 10 Oct 2026.) A
  fundraising headline (£76,920 on the website) had a record for only £6,922 of it. The measure
  is the money a cause confirms it received, one row per payment, with a receipt on file and a
  Confirmed tick. The headline and the traced total sit beside it so the gap stays visible.
- **Partners signed (a written yes).** (Fundraising pack, Runpreneur, 10 Oct 2026.) Kevin wants
  partners of several kinds, and money is not required: gear, sharing content with their audience,
  a collaboration, or a sponsorship. A partner counts once their written yes is attached. The
  approach count sits beside it (40 by 31 Dec), because a yes cannot be steered week by week and
  the number of asks can. Cold email goes to limited companies only, so an approached sole trader
  is flagged.
- **Self-managed properties fully compliant.** Certificate counts say how many documents are
  missing; this says how many properties are safe. In date AND on file for all three, with a
  "no gas" mark standing in for the gas certificate. It declares the number of properties it
  expects, so a property quietly handed to an agent shows as a warning, not a better score.

All three are one-line compute code (`return ctx.reKpis.namedUnits();`) calling the tested
rule, and all three refuse to save a value when their input data did not load: the project
shows "Compute failed" and the daily freshness invariant fires.

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
