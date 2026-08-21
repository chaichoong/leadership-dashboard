# CEO Brief: client onboarding runbook

Written 21 Aug 2026 by reverse-engineering Kevin's own CEO Brief. This is the checklist for
standing up the same brief for a new Operations Director client. It lists what we need from
the client, what we build, and how we prove it works. It is not a plan; the plan is
MASTER-PLAN.md.

Visual map of how the brief works: `ceo-brief-workflow.html` (linked from the CEO Brief tab).

## 1. What the client gets

Every weekday at 9am London they receive one Slack message from their AI CEO, and the same
brief appears on the CEO Brief tab of their dashboard:

- The ONE thing to do today and a ten-minute first step.
- Why it wins today.
- What to ignore today.
- What was handed off, and to whom (a named AI agent or a named team member).
- At most two board flags from the directors.
- Their money traffic light and the safe-to-act figure.

Behind it sits an AI CEO persona, a board of department heads (each a named author voice with
directors as lenses), and worker agents that do the handed-off work. The huddle runs before
the brief; the brief leads with the board's conclusion.

## 2. The components, and what each one needs

| Stage | Component in Kevin's build | Per-client equivalent | Inputs it needs |
|---|---|---|---|
| Brain | Drive vault `00 AI Context` (founder-profile, current-priorities, Decisions/, People/, Knowledge/) | A client brain folder or Supabase tenant knowledge store | Founder profile, priorities, red lines, key people, decisions log |
| Board | `~/.claude/agents/od-ceo.md` + 11 `dept-*.md` + 5 `worker-*.md` + `GUARDRAILS.md` | Per-tenant persona records (data-shaped, see `docs/ai-org-chart-spec.md` "Productised end state") | CEO voice, department list, lead author per seat, lanes, vetoes, non-negotiables |
| Book context | Audiobook pipeline into `Learning & Reference/Transcripts` and `Knowledge/frameworks-library.md` | Shared OD framework library (already harvested) plus client-specific sources | Nothing from the client unless they want their own sources mined |
| Huddle | daily-ops phase 2 (`.claude/scheduled-tasks/ceo-huddle/SKILL.md`, `~/.claude/skills/huddle/SKILL.md`) | A scheduled agent run per tenant, writing a stub row | Their open tasks, their quarter targets, their calendar |
| Brief writer | Cloudflare Worker `money-confidence-daily` (`scripts/slack-automation/money-daily-worker.js`) | Same worker, parameterised per tenant | Secrets listed in section 4 |
| Money light | `loadAndCompute()` reading Accounts, Tenancies, Costs, Transactions | Their finance tables (Supabase) or a simpler safe-to-act input | Bank balances, expected income, expected costs |
| Tasks | Airtable Tasks table `tblqB8b22hKBL4PF1` (Task Name, Assignee, Due Date, Status, Priority, Task Type) | Their Tasks table | A tasks source with those six fields, and a Status value meaning "finished agent work awaiting approval" |
| Store | Airtable `CEO Briefs` table `tblIxbzDSOCI5hqJn` | Per-tenant briefs table | None; we create it |
| Delivery | Slack bot DM to one user, looked up by email | Their Slack workspace, or email/WhatsApp if no Slack | A Slack workspace with the bot installed and the recipient's email |
| Display | `js/ceo-brief.js` tab, reads by field ID, four health checks | Same tab in the client app | None |
| Watchdog | daily-ops phase 7.2 (`ceo-brief-morning-check`) | Same check per tenant | None |

## 3. What we need FROM the client (intake list)

Collect these on the onboarding call or the intake form. Nothing here needs a phone call from
the client afterwards.

### 3a. Identity and voice (feeds the CEO persona and the brain)

1. Founder name, business name, what the business sells, to whom, at what price.
2. The one-line mission and the 12-month target (revenue, clients, or whatever they score by).
3. This quarter's targets and theme, as two or three sentences. This becomes `QUARTER_CONTEXT`
   and is the ONLY authority on priorities in the prompt. Refresh it every quarter.
4. Non-negotiables and red lines: income floor, protected time (family, training, health),
   anything that must never be automated or published.
5. Founder wheelhouse: what only they should do (decisions, approvals, signatures, payments,
   client-facing moments) and what they never want to see (admin, chasing, paperwork).
6. Working hours and the time they want the brief. Default 9am local. The worker gates on
   Europe/London today; a client in another zone needs the gate parameterised.

### 3b. The board (feeds the department agents)

7. Which departments they want seated. Default set: Strategy, Marketing, Sales, Operations,
   Systemisation, Finance, Legal and Compliance, People, Productivity, Mindset. Wealth is
   optional.
8. For each seat, the author or mentor whose voice they want. If they have no preference, use
   Kevin's defaults (Keller, Hormozi, Belfort, Wickman, Jenyns, Crabtree, Cunningham, Lencioni,
   Bailey, DeMartini, Kiyosaki) and the shared framework library already covers them.
9. Any books, courses or mentors of their own to mine into the brain (optional; each one goes
   through transcript-to-brain).

### 3c. People and agents (feeds the delegation order)

10. Team members by name and role, and what each may be handed. The CEO delegates AI first,
    then a named human, then the founder. A blank list means everything not AI-shaped reaches
    the founder.
11. Which work types the AI agents may do without approval on day one. Default: none. Reading
    and drafting are always allowed; sending, publishing, paying and signing are always gated.
    This is the trust ramp: the client moves the gears, nothing auto-promotes.

### 3d. Data sources (feeds the gather step)

12. Tasks: where their open work lives. We need six fields per task: name, owner, due date,
    status, priority, type. If they have no task system, the Tasks OS in the app is the source.
13. Money: bank accounts to read (via the app's Fintable or Supabase feed), expected monthly
    income lines, expected monthly cost lines. Without these the brief runs with no money
    light and says so.
14. Calendar: a private ICS address for the founder's calendar (optional). Google Calendar
    gives one under Settings, Integrate calendar, Secret address in iCal format.
15. Slack: workspace name and the founder's Slack email. They install the OD bot (needs
    `chat:write`, `users:read`, `users:read.email`). If no Slack, pick email delivery and
    note the tab becomes the primary surface.

### 3e. Approvals (one-time, done by the client themselves)

16. Slack bot install approval.
17. Calendar ICS address pasted into the secure intake field (never into chat or email).
18. Bank feed consent if the money light is wanted.

## 4. What WE build (setup checklist)

Tick in order. Each step names the file or record it configures.

### Brain and personas

- [ ] Create the client brain: founder-profile, current-priorities, constraints-and-red-lines,
      key-people, a Decisions/ folder with the intake answers as the first dated entries.
- [ ] Generate the CEO persona from the `od-ceo.md` template: swap founder facts, targets, team
      names, delegation order. Keep the huddle rules, lane discipline, escalation rules and the
      precedent rule unchanged.
- [ ] Generate one department file per seat from the `dept-*.md` template: lead voice, directors,
      lane, vetoes, "may NOT advise on", the client's non-negotiables block.
- [ ] Copy the five worker agents and `GUARDRAILS.md`. Set every row to GATED except reading,
      drafting and brain writes. Record the owner's name on the register.
- [ ] Confirm every seated author has at least one processed book in the framework library.
      Queue any gap through the audiobook pipeline or transcript-to-brain.

### Data

- [ ] Create the client's `CEO Briefs` table with these fields: Date (date), One Thing (text),
      First Step (text), Why (long text), Ignore Today (long text, newline-separated), Board
      Flags (long text), Handed Off (long text), Money Light (text), Safe To Act (number), Full
      Brief (long text, JSON). Record the FIELD IDS; both the worker and the tab read by ID.
- [ ] Point the tab and the worker at those IDs (`F.ceo*` in `js/config.js` and the `F` map at
      the top of the worker). A rename in the table must not be able to break the brief.
- [ ] Map their Tasks source to the six fields the worker's `gatherTasks()` reads, and confirm
      which Status value means "awaiting approval". The brief treats that bucket as finished
      agent work, never as overdue work.
- [ ] Map their money tables to `loadAndCompute()`, or set the money block to "not connected"
      and confirm the brief still sends.

### Worker (one deploy per tenant until the runtime is multi-tenant)

- [ ] `wrangler secret put` for: `SLACK_BOT_TOKEN`, `AIRTABLE_PAT` (or the Supabase key),
      `PROXY_TOKEN`, `QUARTER_CONTEXT`, `PERSONA_CONTEXT` (their founder context paragraph;
      never in the repo), `CALENDAR_ICS_URL` (optional), `RECIPIENT_EMAIL`, `TRIGGER_KEY`.
- [ ] Set the model vars from `js/ai-models.js`; never hardcode a model ID.
- [ ] Cron stays `0 8-11 * * *` (every day, hourly). The weekday and hour are decided in code by
      `isLondonSendTime()`. For a non-London client, parameterise the timezone there and in
      `todayLondonISO()`, and add the test case to `tests/ceo-brief-schedule.test.js`.
- [ ] Deploy, then hit `/?mode=brief&key=…` to see a generated brief without sending, then
      `/?mode=send&key=…` once to prove delivery and storage.

### Huddle and watchdog

- [ ] Add the client's huddle as a phase of their scheduled routine (one routine per tenant,
      never a second routine per job). The huddle writes the stub row by 08:50 local and leaves
      Full Brief empty.
- [ ] Add the morning check: after 09:20 local, today's row must have Full Brief populated;
      if not, trigger `mode=send` manually and file a finding.

### Display

- [ ] Enable the CEO Brief tab for the tenant. Confirm the four health checks read green after
      the first full brief: table reachable, today's brief arrived, latest brief complete,
      robot ran within a week.
- [ ] Link the workflow page from the tab header so the client can see how it works.

## 5. Proving it works (acceptance)

1. Day 0: `mode=brief` returns JSON with one_thing, first_step, why, ignore, handed_off, flags,
   headline. Every handed_off line names a real agent or a real team member.
2. Day 1, 07:30 local: a stub row exists with One Thing, First Step, Board Flags; Full Brief
   empty; the tab labels it "not finished".
3. Day 1, 09:00 local: Slack DM received; the same row now has Full Brief; the tab shows the
   money light and the reasoning; no duplicate row for the day.
4. Day 1, 09:20: the morning check reports the brief landed without sending anything.
5. Day 5: five weekday rows, each complete, zero weekend rows, health checks green.
6. The founder confirms the first step was genuinely theirs (a decision, an approval, a
   signature) and not admin an agent should have taken.

## 6. Known single-tenant assumptions to remove before this is a module

These are facts about Kevin's build that a second client breaks. Each is a build task, not a
runbook step.

- The huddle runs on Kevin's Mac inside daily-ops. A client needs a hosted runner
  (`workers/agent-runner`) that can dispatch the department agents.
- The personas live in `~/.claude/agents/`, outside the repo, and reference Kevin's private
  situation. Client personas must be data records per tenant.
- The worker reads one Airtable base with hardcoded table IDs and one Slack recipient. It needs
  a tenant parameter, or one deploy per tenant.
- The board flag list inside the worker prompt (Crabtree, Michalowicz, Hormozi, Jenyns,
  Martell, Peters, Keller) is hand-typed and already differs from the agent org chart. It must
  be generated from the tenant's seated board.
- The money light depends on the property-portfolio tables. A service business needs a
  simpler safe-to-act input.
- The calendar parser lists only events whose start stamp is today. Recurring events (an RRULE
  with an old start date) and multi-day events that began yesterday are not shown. Expanding
  RRULEs is the follow-up; a client who runs on recurring meetings needs it first.
- Timezone is Europe/London in four places (worker gate, today's date, the tab, the huddle
  clock rules).
