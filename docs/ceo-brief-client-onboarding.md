# CEO Brief: the client onboarding path

Every step a new client goes through to get their own AI CEO, board of directors, worker
agents and daily brief, from the signed order to the fifth morning brief. Written so Mica
can run it without Kevin, and so Kevin can see every question before a client ever sees it.

The questions in phase 3 are printed from `js/ceo-brief-defaults.mjs` (`SETUP_QUESTIONS`).
That file is what the setup screen renders and what the robot reads, so this document,
the screen and the robot cannot drift. `tests/ceo-brief-onboarding-doc.test.js` fails if a
question exists in the code and not here.

Visual map of the pipeline: `ceo-brief-workflow.html`. Product decision: MASTER-PLAN §13,
21 Aug 2026 (the brief is the "daily direction" layer of the Command Centre, base, not an
add-on; the AI Brain is an input, never the home).

## The shape in one screen

| Phase | Who does it | How long | Output |
|---|---|---|---|
| 0. Sale closes | Client + Kevin | done before this starts | Paid order, signed terms |
| 1. Kick-off call | Client + Mica (Kevin optional) | 45 minutes | The answers marked CALL below, the three hated jobs |
| 2. Provision | Mica, in the CRM | 15 minutes | Workspace, login, CEO Brief page visible |
| 3. Setup screen | Client (alone, async), Mica checks | 30 to 40 minutes for the client | Config saved, readiness panel green |
| 4. Dry run | Mica | 10 minutes | A real brief generated, not sent; wording checked with the client |
| 5. Go live | Mica flips the switch | 1 minute | First brief the next weekday at the client's chosen hour |
| 6. Five-day acceptance | Mica + client | 5 working days | Five briefs, health strip green, client confirms the first step was genuinely theirs |
| 7. Quarterly refresh | Client, nudged by the brief | 5 minutes a quarter | New quarter context |

## Phase 0: what the client has already done before we start

- Bought the base plan (the CEO Brief ships with every plan; it is an opt-out, not an add-on).
- Received the welcome email and the set-password link (`create-client` function sends both
  via GoHighLevel).
- Filled the public intake form (`onboarding.html`). Those answers (name, business, team,
  bank accounts, targets, thresholds) land in `onboarding_submissions` and are pre-read by
  Mica before the call. Nothing the client typed there is asked twice: Mica pre-fills the
  setup screen from them in phase 2.

## Phase 1: the kick-off call (45 minutes, Mica leads)

Agenda, in order. Everything captured here is typed into the client's setup screen during
the call or straight after, under the CALL-tagged questions in phase 3.

1. Five minutes. What the brief is: one message every weekday morning, one thing to do, a
   ten-minute first step, what was handed to others. Show `ceo-brief-workflow.html` on
   screen, section 1 only.
2. Ten minutes. The three hated jobs. "Name the three jobs you do every week that you would
   pay to never do again. Which of those follows the same steps every time?" Written into
   the intake notes; this picks the first worker agent (existing §6 step, unchanged).
3. Ten minutes. The board. Walk the eleven seats on the setup screen. Ask: "Any seat you do
   not want? Any author or mentor you would rather hear in a seat?" Tick or rename live.
4. Five minutes. Sensitive flag. "Anything sensitive we should be extra careful with in
   writing: disputes, legal, partners?" Record yes or no only. Details never go into any
   system.
5. Ten minutes. Connections, done together on screen:
   - Where tasks live (Tasks page in the app, or an Airtable base we connect).
   - Money light: none for now, or a manual figure, or later through the Finance add-on.
   - Delivery: Slack webhook created together (Slack, Apps, Incoming Webhooks, choose the
     channel or DM, copy the address into the secret field), or email, or page only.
   - Calendar: the client pastes their private ICS address into the secret field (Google
     Calendar, Settings, the calendar, "Secret address in iCal format"). Never emailed.
6. Five minutes. What happens next: they finish the setup screen alone, Mica runs a dry
   run, they approve the wording, the switch goes on.

Rule for the call: nothing here needs the client to make a phone call afterwards, and no
credential is ever spoken or emailed; secrets go into the two secret fields only.

## Phase 2: provisioning (Mica, 15 minutes)

Each step names the button or file.

1. CRM, Clients tab, "Create client account" (`create-client` function): sends the invite,
   creates the workspace with the 8 base modules on. The CEO Brief page is an opt-out base
   feature (`ceo_brief` in `OPT_OUT_MODULES`), so it is visible with no extra toggle.
2. Confirm the client can sign in and sees "CEO Brief" at the top of the sidebar
   (`supabase-app.html`, page `ceo-brief-supabase.html`).
3. Open the client's CEO Brief page, Setup tab, and pre-fill step 1 and step 3 from the
   intake form answers (name, business, what it sells, targets, act-below and ask-above
   thresholds inform the income floor line). Save.
4. If the tasks source is Airtable: store the client's Airtable token as a worker secret
   (`wrangler secret put <NAME>` on `ceo-brief-tenants`) and type that secret's NAME into
   the "Airtable token reference" field. The token itself never enters the page.
5. Leave step 8 (the go-live switch) OFF.

One-time platform steps, done once ever, not per client: migration `0043_ceo_brief.sql`
run in the Supabase SQL editor; `manage-client` redeployed; the worker
`workers/ceo-brief-tenants` deployed with its three secrets. See the worker README.

## Phase 3: the setup screen, every question

The client opens CEO Brief, Setup. Eight steps. A dot marks a required answer. A chip on
each question says who answers it: **You** (the client, alone), **With us on the call**
(typed during phase 1), **We set this** (Mica, never the client).

### Step 1: Who you are

| # | Question | Who | Required | Help shown under the question |
|---|---|---|---|---|
| 1 | Your name | You | yes | |
| 2 | Business name | You | yes | |
| 3 | What does the business sell, and at roughly what price? | You | yes | One or two sentences. Example: "Bookkeeping for trades businesses, £250 a month." |
| 4 | Who buys it? | You | | Example: "Plumbers and electricians with 2 to 10 staff in the North West." |
| 5 | The business in one line, the way you would say it to a friend | You | | |
| 6 | Where should the business be in 12 months? | You | | A number if you have one: revenue, clients, profit, hours you work. |

### Step 2: This quarter

| # | Question | Who | Required | Help |
|---|---|---|---|---|
| 7 | What are you aiming for this quarter, and what is the theme? | You | yes | Two or three sentences. This is the only thing your CEO uses to judge what matters. Update it every quarter. |
| 8 | When does this quarter end? | You | | |

### Step 3: Rules and red lines

| # | Question | Who | Required | Help |
|---|---|---|---|---|
| 9 | The minimum your household needs each month, no exceptions | You | | Your CEO will warn you before anything threatens it. |
| 10 | Up to five things that must never be sacrificed for the business | You | | Health, family time, a day off, training, a side commitment. |
| 11 | What should only YOU do in this business? | You | yes | Decisions, approvals, signatures, payments and anything physical are always yours. Add the rest: client calls, pricing, strategy, deep work. |
| 12 | What do you never want to be asked to do again? | You | | Admin, chasing, paperwork, data entry. Your CEO hands these off instead of giving them to you. |
| 13 | When the numbers look bad, how do you want it? | You | | Straight and blunt, or supportive with options. |
| 14 | Is there anything sensitive we should be extra careful with in writing? (disputes, legal, partners) | With us on the call | | We store yes or no only. The details never go into any prompt. |

### Step 4: Your team and your agents

| # | Question | Who | Required | Help |
|---|---|---|---|---|
| 15 | Your team: name, role, and what each person may be handed | You | | Your CEO hands work to AI first, then to a named person, then to you. Leave empty and everything not AI-shaped reaches you. |
| 16 | The five AI worker agents (on by default) | We set this | | Builder, writer, researcher, analyst, auditor. We switch one off only if a client asks. |

### Step 5: Your board

| # | Question | Who | Required | Help |
|---|---|---|---|---|
| 17 | Your board of directors | You | | Eleven seats, each with a named author as its voice. Untick a seat you do not want. Change a name if you would rather hear a different voice in that seat. |
| 18 | Whose voice should your CEO speak in? | You | | Default: Dan Martell (Buy Back Your Time). Any author or mentor you trust. |

The eleven default seats, what each owns, and what each may not advise on:

| Seat | Default voice | Owns | Must not advise on |
|---|---|---|---|
| Strategy | Gary Keller | The one thing, the 20%, quarterly focus, sequencing | Tactics, money, professional opinions |
| Marketing | Alex Hormozi | Offer strength, leads, positioning | Cash exposure, legal wording, delivery capacity |
| Sales | Jordan Belfort | The call, conversion, pricing and terms | Positioning, finance policy |
| Operations | Gino Wickman | Operating rhythm, accountability, can we deliver | Offer design, personal money |
| Systemisation | Dave Jenyns | Every recurring problem into a system plus an agent | Strategy, money, legal |
| Finance | Greg Crabtree | Real profit, cash discipline, what a target costs | Offer construction, marketing tools, legal |
| Legal and Compliance | Keith Cunningham | Contract risk, compliance calendar, facts for real advisers | Giving legal advice |
| People | Patrick Lencioni | Role clarity, accountability, the agent workforce | Money, legal |
| Wealth | Robert Kiyosaki | Assets versus liabilities, passive income | Operations, tax advice |
| Productivity | Chris Bailey | Attention, habits, how work reaches the founder | What the founder works on |
| Mindset | John DeMartini | Values, overwhelm, the protected assets | Tactics, money |

### Step 6: Where your work lives

| # | Question | Who | Required | Help |
|---|---|---|---|---|
| 19 | Where do your open tasks live? | With us on the call | | The Tasks page in this app, or an Airtable base we connect. Your CEO reads name, owner, due date, status, priority and type. |
| 20 | Should the brief carry a money traffic light? | With us on the call | | Connected later through the Finance add-on. Until then: none, or a manual figure you keep updated. |
| 21 | Your calendar's private address (optional) | You | | Google Calendar: Settings, your calendar, "Secret address in iCal format". Paste it here, never into an email. |

### Step 7: Delivery

| # | Question | Who | Required | Help |
|---|---|---|---|---|
| 22 | Your timezone | You | | London, Dublin, Paris, New York, Sydney |
| 23 | What time should the brief arrive? | You | | 7am, 8am, 9am or 10am |
| 24 | Where should it arrive? | You | | Only on this page, Slack, or email |
| 25 | Slack incoming webhook address | With us on the call | if Slack | Set up with us on the call: Slack, Apps, Incoming Webhooks, pick the channel or your DM, copy the address. |
| 26 | Email address for the brief | You | if email | |

### Step 8: Go live

| # | Question | Who | Required | Help |
|---|---|---|---|---|
| 27 | Switch the daily brief on | We set this | | We turn this on after the dry run reads right. The page shows what is still missing until then. |

The readiness panel on the page lists exactly what blocks go-live. The blocking answers are:
founder name, business name, what the business sells, this quarter's targets, what only the founder
should do, at least one board seat, and the delivery address for the chosen channel.

## Phase 4: the dry run (Mica, 10 minutes)

1. Open `https://ceo-brief-tenants.kevinbrittain.workers.dev/?mode=brief&org=<workspace id>&key=<trigger key>`.
   The worker runs every enabled seat, then the CEO, and returns the brief as JSON. Nothing
   is stored or sent.
2. Check four things against the config: the first step names something only the founder
   can do; every handed-off line names an enabled worker or a named team member; the flags
   come from enabled seats only; the quarter context is reflected in the "why".
3. Read the one thing and the first step to the client (Slack message or a two-minute
   Loom). Adjust wording in steps 3 and 5 if the voice is wrong. Re-run.

## Phase 5: go live (1 minute)

Setup, step 8, tick "Switch the daily brief on", Save. The page shows "Ready to go live"
only when the blocking list is empty. The next weekday at the chosen hour, the worker
sends and stores the first brief. Retries happen hourly for two hours if the first firing
is missed; the stored row stops duplicates.

## Phase 6: five-day acceptance

| Day | Check | Where |
|---|---|---|
| 1 | Brief arrived at the chosen hour on the chosen channel and on the Today tab | Today tab health strip: "Today's brief arrived" |
| 1 | No duplicate row for the day | `ceo_briefs` has one row per date |
| 1 to 5 | The founder confirms the first step was genuinely theirs, not admin an agent should have taken | Ask in the Slack thread or by a one-line email |
| 3 | At least one hand-off named a worker agent and that work appeared in the approval queue | Tasks page, approval queue |
| 5 | Five weekday rows, zero weekend rows, health strip green | Today tab |
| 5 | Client can say in one sentence what the board is for | Acceptance call, 10 minutes |

## Phase 7: quarterly refresh

In the last week of each quarter the brief flags "Keller: your quarter context ends on
{date}; update it". The client opens Setup, step 2, rewrites two sentences, saves. Nothing
else changes.

## What is built, what is a handoff, what is not built yet

Built in PR (this branch):
- `js/ceo-brief-defaults.mjs` (config, defaults, every question).
- `workers/ceo-brief-tenants/` (the cloud robot: board in parallel, CEO synthesis, store,
  deliver, idempotent, per-tenant timezone).
- `ceo-brief-supabase.html` (Today + Setup screens) registered in `supabase-app.html`.
- `supabase-migration/supabase/migrations/0043_ceo_brief.sql` (the briefs table).
- Tests: `tests/ceo-brief-tenants.test.js`, `tests/sync-invariants/ceo-brief-supabase.spec.js`,
  `tests/ceo-brief-onboarding-doc.test.js`.

One-time handoffs (Kevin or Mica hold the credentials; Claude cannot do these):
- Run migration 0043 in the Supabase SQL editor. Redeploy `manage-client`.
- Deploy the worker and set its three secrets (README in the worker folder).
- Seed a test workspace and run one dry run end to end. Until this is done, the live proof
  is the test suite, not a real brief.

Not built yet, and the plan for each:
- Per-tenant AI key routing (Supabase D9, due 31 Aug 2026). Until then every client's board
  runs on Kevin's proxy credits. This gates taking a SECOND client onto the brief.
- A Supabase tasks table. The Tasks twin page does not yet store tasks in Supabase, so
  `tasks_source` supports none or Airtable today. When the tasks cutover lands, add kind
  `supabase` in the worker's gather step (one function).
- Email delivery. The worker posts to an `EMAIL_WEBHOOK_URL` if one is set (GoHighLevel
  inbound webhook, the same pattern `create-client` uses); otherwise the brief is page
  only. Choose the webhook once and set the secret.
- Money light for non-finance clients: manual figure today; the Finance add-on feeds it
  later.
- Recurring calendar events (RRULE) are not expanded.
- A precedents log the founder's approvals feed automatically. Today `precedents` is a
  list Mica maintains by hand from the approval queue.
- Kevin's own brief still runs on the Airtable worker and the Mac huddle. Moving Kevin onto
  this tenant worker is a separate cutover, not part of client onboarding.
