---
name: strategy-session
description: The quarterly objective and strategy session for ONE of Kevin's businesses (Real Estate, Operations Director, Runpreneur), run once a quarter per business. Measures last quarter against its plan, puts it to the fitting board seats, holds the direction conversation with Kevin, builds next quarter's pack from last quarter's baseline, closes the old quarter, writes the plan, projects, monthly stepping stones and tasks to Airtable, agrees the KPIs for the leadership dashboard and ends with the write-back. Use when Kevin says "strategy session", "quarterly session", "plan next quarter", "Q1/Q2/Q3/Q4 plan for <business>", "objective and strategy session" or "/strategy-session".
---

# Strategy session (built from the first live run, Q4 2026 Real Estate, 1-2 Oct 2026)

One business, one quarter, per run. Kevin invokes it. It is a skill, not a standing agent.
The Objective & Strategy page (`os/strategy/index.html`, code `os/strategy/strategy.js`) owns
the record this session writes. This skill mirrors that page's rules. It does not replace the
page and it does not run the page's wizard: the conversation happens here, the result lands on
the same record, and Kevin gets the finished plan as a PDF in the page's own export layout.

## Rules that hold in every phase

- **Nothing is written to Airtable before Kevin's yes.** For a new quarter that is his yes on
  the final draft (Phase 5). When the quarter's record already exists and the session is
  reviewing it, each section is written as soon as he rules on it (Phase 3b).
- **Working files are private.** This repo is public. The numbers pack and every draft go in a
  dated folder in the business's private project: `~/Projects/kevin-hq/property/`,
  `~/Projects/kevin-hq/runpreneur/`, or `~/Projects/kevin-hq/` for Operations Director, as
  `<YYYY-MM-DD> q<N> strategy session/`. Never in this repo.
- **Send every draft to Kevin as a file, never just a path.** He often reads on another Mac
  from the one the session runs on. Use SendUserFile for each new draft.
- **Never guess a figure, a name or a record.** Read it live and cite the record id, field or
  code line. Airtable: curl with the PAT at `~/.config/od/airtable_pat`, base
  `appnqjDpqDniH3IRl`, every read paginated. Never print the token.
- **One question at a time** with Kevin. Lead with the ask.

## Inputs: ask only for what is missing

- The business. Read the Businesses table (`TABLES.businesses` in `js/config.js`) live and
  match by name. Never hard-code a business id.
- The quarter being planned. Default: the quarter that contains today, or the next one if
  today is in a quarter's last two weeks.

## Phase 1: measure before targets (the numbers pack)

No target is discussed until this pack exists. Write it to `numbers-pack.md` in the session
folder and send it to Kevin.

1. Read last quarter's Objective and Strategy record for the business (`TABLES.objStrat`,
   one row per business per quarter, matched on Business, Quarter and Year) and its projects
   through the `QP1 Project`, `QP2 Project` and `QP3 Project` links.
2. For each project: every line of its definition of done against today's reading, as
   target, actual, met or missed. Then its tasks, done of total.
3. The one-year measurables: the reading when set, the reading now, the one-year target.
4. Anything found that changes the next plan (a KPI that measures the wrong thing, a project
   with no owner, work nobody was driving).

Every figure in the pack obeys all four:

- **It is traced.** State the field, formula or code line that produces it, and one sample
  record. A dashboard figure is re-run from the dashboard's own code on live data, never
  rebuilt from a new formula.
- **It says what it is: a quarter total or a monthly average.** Write the words next to the
  number. The first run needed a correction because "Q3 actual" was read both ways.
- **Each business's money stays separate from Kevin's personal money.** Never subtract
  personal costs from a business figure or quote one figure for both. Kevin's income is its
  own line.
- **Personal figures use the Wealth page's own grouping** (Needs, Wants and the buckets, from
  `buildMonthlyCashflow` in `js/wealth.js`). Do not build a second grouping. Six drafts were
  needed on the first run because the early ones mixed these.

Check the pack states, for every project, whether the work was ever named. "The four
tenancies" with no list is a finding, not a detail.

## Phase 2: board scrutiny

Give the numbers pack to only the seats whose lane fits the business. Each seat answers three
questions in under 250 words: what was done, what was not done well, what to change.

- Real Estate (the first run): `dept-finance`, `dept-wealth`, `dept-operations`,
  `dept-strategy`.
- Operations Director: `dept-strategy`, `dept-finance`, `dept-sales`, `dept-marketing`.
- Runpreneur: `dept-strategy`, `dept-marketing`, `dept-mindset`, `dept-productivity`.

Four seats, launched together, each handed the pack's path and told to read it. Swap a seat
only when the pack shows a problem in another lane. Never all eleven. Put the four answers in
`board.md`, with a three-line summary on top: where they agree, where they split, the one
change most of them ask for.

## Phase 3: the conversation with Kevin (direction, then every section of the plan)

One question at a time. Record his words as he says them. Every ruling goes to memory the
moment it is made, dated. A ruling made once is not asked again.

### 3a. Direction

1. Here is last quarter in five lines and the board's one change. Does that match what you saw?
2. Has the overall direction changed, or is there anything new?
3. Which projects, in which order? (Offer the board's list. He picks. Three at most.)

### 3b. Every section of the plan, every quarter

Nothing on the plan carries forward unread. The first run copied the Objective half across
without review, and Kevin sent it back: things had changed, and the plan must stay fully up
to date. Walk the sections in the page's order, one section per message:

1. Objective
2. Target statement: what we do, who we do it for, how we do it
3. Customer profile
4. Undertakings
5. Original selling points
6. Main method
7. Enticement
8. One-year target and its measurables
9. Three-year target and its measurables
10. Nine-year target

Sections 8 to 10 are built in Phase 3c, working up from the quarter. Do not walk them as
wording alone.

For each section, in this shape:

- Show the current wording in full (a long list as a numbered list).
- Say what in it no longer matches: check it against the numbers pack, this quarter's
  rulings, the team roster in the brain, and the other sections. Name the line and the fact.
  If nothing conflicts, say so in one line.
- Offer the new wording, ready to approve.
- Ask one question: keep, use the new wording, or change it.

Log each section's ruling (keep or the agreed wording) in `plan-review.md` in the session
folder. A section with no ruling is not done: Phase 5 does not start until all ten have one.

Four habits the first run needed in this walk:

- **A correction ripples.** When Kevin corrects one section, check the sections he has
  already approved for the same fault, name the lines, and offer the fix. On the first run
  one correction touched two earlier sections.
- **Check a count before repeating it.** A number carried in the old wording (properties,
  units, team size) is read live before it goes into the new wording, and Kevin's counting
  rule is recorded with it. If the same stale number sits elsewhere (the master prompt, the
  brain), fix it or log it at the close.
- **Name people and agents from the record.** Before the plan says an agent does a job, find
  that agent in the AI Agents register. If it is not there, say so and describe the job
  without a name.
- **When the record already exists, write each section as it is ruled:** read the field by
  id, stop if it reads blank, check the old wording is the one you showed him, write, and
  read it back. Never batch ten rulings into one write at the end.

### 3c. The targets: work back from the quarter, then prove the money

Kevin's rule: start from what this quarter will deliver, then set one year, then three, then
nine. The first run offered wording for these sections and was sent back for numbers.

1. **The ladder.** One table, the business's main money measure at each point: today, the
   end of this quarter (committed and stretch), each quarter of the next year, one year,
   three years, nine years. Every row says what it is built from, as a named list of
   actions. State the basis once (monthly or total, before or after tax).
2. **The growth pace, in Kevin's words.** Ask him how fast the business should add to itself
   (for property: leases and purchases a year). Record his answer verbatim. The purpose of
   the longest target is his to state: ask for it and quote it.
3. **The unit model.** What one added unit brings in and costs. Use Kevin's own figures when
   he gives them. Show the full figure and the planning figure, and label every assumption
   as an assumption (payment rate, running costs, set-up cash).
4. **The cash check. Does the plan fund itself after Kevin is paid?** Surplus is the main
   measure less the business's variable budget less Kevin's minimum take-home. Show at least
   three cases for the first year: nothing improves on today, this quarter's committed
   figure lands and holds, and the whole ladder lands. For each: the surplus for the year,
   what the growth needs in cash, and whether it is covered or short by how much.
5. **What is not in the numbers.** List it plainly, every time: tax, where the surplus is
   already pointed (the Wealth buckets), the gap between plan and cash, any call on cash
   from outside the business, and whether lending is available. Do not leave these out to
   make the plan look affordable.
6. **A confidence percentage on every row of the ladder,** with the evidence behind it (last
   quarter's hit rate, what is untested). Recommend that "committed" is only a figure you
   would put at 50% or better, and move the rest to stretch or beyond stretch. Kevin signs
   off knowing the odds.
7. **Growth by gates, not dates.** Kevin's standing rule is that nothing scales until it is
   optimised. Write the conditions that must hold before the next unit of growth is added
   into the target itself.
8. **Keep the measurables the dashboard reads.** When a target is rewritten, the measurables
   that this quarter's KPIs are built on stay, with the new figures added to them.

Save the ladder and the cash check as `growth-cash-check.md` in the session folder, number
each version, and send each one to Kevin. Then write the three targets and their measurables
with his sign-off, and log all three in `plan-review.md`.

## Phase 4: build the pack

Last quarter's plan is the baseline: copy it, then change only what Phases 1 to 3 changed.
Write `q<N>-draft-1.md`, send it, and number each redraft. A draft is a proposal until Kevin
rules.

Each of the three quarterly projects carries:

- **A named list.** Name every unit, tenant, property and owner the project covers. The KPI
  counts that list and nothing else. A project whose tracking method has no named list is not
  ready: stop and name it. Last quarter failed on the first run's business because the work
  was never named and two agents picked two different sets.
- **Committed and stretch targets, each built from a named list of actions.** Committed is
  today's reading plus the named actions that will land. Stretch adds the named actions that
  might. Show the sum.
- **One owner, chosen in this order: an AI agent, then Roy Lavin for property work, then
  Kevin.** Kevin only for decisions, approvals, sign-ins, payments and signatures. Never Mica.
  An AI agent has no Airtable login, so it cannot sit in the project's `Owner` field (a
  collaborator field): leave `Owner` blank and name the agent in the tracking method. Roy or
  Kevin goes in `Owner` by email.
- One KPI (name, unit, target), a tracking method, a definition of done with a date, and
  three monthly stepping stones.

Also in the draft: every section as ruled in Phases 3b and 3c, the
targets table (today, committed, stretch), the KPI list for the dashboard, the close proposal
for each of last quarter's projects (outcome, KPI at close, and for every open task: close,
carry or leave), and the open questions for whoever must answer them.

## Phase 5: write it to Airtable (after Kevin's yes, in this order)

### 5a. Close the old quarter first: the snapshot

Snapshot first, carry second. The carry needs the new quarter's projects, which do not exist
yet, so the close runs in two passes: the snapshot here, the carry in 5c.

Use the "Close the quarter" button on the Objective & Strategy page (`openQuarterClose` and
`executeQuarterClose` in `os/strategy/strategy.js`), in Kevin's signed-in Chrome. With no next
plan yet, its preview shows every open task as parked. That is correct for this pass. In the
note box, replace the line that starts "Carried into" with the approved carry plan in words
(which tasks carry, to which new project). Left alone, the button freezes "0 open tasks
re-linked" into the note and the record comment, and the second pass never rewrites it. If the
page cannot be driven, do the same steps by curl in the same order, field ids from
`PROJ_CLOSE_F` in that file:

1. `Status Override` set to the true outcome.
2. `KPI at Close`.
3. `Progress at Close`.
4. `Closed On`, the quarter's end date.
5. `Closing Note`: target, actual, why the gap, what carries and where.
   (Steps 1 to 5 are ONE PATCH.)
6. A record comment with the same note.

Then read each closed project back by curl and confirm all five snapshot fields are set. If a
snapshot failed, stop: that project's tasks are not carried.

### 5b. The plan record and the projects

1. Create the new quarter's Objective and Strategy record from the approved draft. Field ids
   from `OBJSTRAT` in `js/config.js`, including `qpDetails` and `monthlyStones`. The field
   names mix "." and ":", so write by id.
2. Create each project with the fields `executePush` writes (`PROJ_F`): name, business, start
   and end dates, definition of done, KPI name, unit and target, tracking method, owner (see
   the owner rule in Phase 4), and `Project Status`.
3. Write each project's id back onto the plan's `QP<n> Project` link.
4. Set `Project Status` the way the page does, from `computeProjectHealth` in
   `js/project-health.js`: Not Started in the first 5% of the quarter, the real health after
   that. Left unset, the formula field `Project Status (Calc)` read Off-Track on day 2 with a
   zero KPI on the first run, and `Project Status` was blank. Then prove it:

```bash
node scripts/sync-project-status.mjs --dry-run
```

   The dry run lists only projects whose stored status is wrong. The new projects must NOT be
   in its list. If one is, run it without `--dry-run` (it corrects every open project in the
   base, as the daily job does, and never touches a closed one), then read the project back.

### 5c. Carry the open tasks (the second pass of the close)

Only now, with the snapshot frozen and the new projects in place. Press "Close the quarter"
again: closed projects are carry-only, so the snapshot is never written twice, and each open
task now offers the new quarter's project. Or by curl: read the task with
`returnFieldsByFieldId=true` and write back the existing `Projects` links plus the new one.

Carry each task by ADDING the new project. Never remove the old project. Never move a task.
State how many tasks should carry, then read each one back and confirm it holds both links.

### 5d. The tasks

One task per deliverable in each monthly stepping stone, due at that month's end, linked to
the project and the business. Every create goes through the gate script:

```bash
python3 scripts/create-agent-task.py create --force --fields-json '<json keyed by field id>'
```

- **Plan tasks pass `--force`, and each has a distinct subject** that names its tenant, unit,
  property or month. On the first run the duplicate gate folded 5 of 20 distinct plan tasks
  into others (two different tenants, two different months).
- **Pass Status `Upcoming`**, as the page's push does. With no Status the script sets Today,
  and a December task lands on today's board.
- **Owner on a task** follows the three routes in
  `.claude/skills/airtable-task-creator/SKILL.md`: an AI agent goes in `Team Member` (its Team
  Members row) with Assignee blank. A task for Roy is created with no owner fields, then
  handed to him with `scripts/agent-dispatch.py handover`, which writes them and sends his
  email. Kevin goes in Assignee.
- Keep the word "Deadline:" out of task names and descriptions. The script reads such a line
  as a hard deadline and overwrites the due date, even with `--force`.
- **Read every create back by its id**: name, status, project link, business, owner, due date. An
  Airtable automation resets a new task's due date to today, so set the due date again after
  the create and read it back.
- State the number of tasks expected before creating, and fail loudly if the count read back
  differs.

## Phase 6: the KPIs and the leadership dashboard

1. Agree the KPI list with Kevin: each with today's reading, committed and stretch, and the
   field or code that will produce it.
2. For each KPI, say which of three states it is in:
   - **Live already**: the dashboard computes it today. Cite the code.
   - **Project KPI, counted by hand**: write "counted by hand until automated" in the
     project's tracking method, with the named list, and say who counts and when.
   - **Needs code**: the project fields `KPI Automated` and `KPI Compute Code`, or a new
     dashboard card.
3. Anything that needs code is NOT built inside this skill. Write `kpi-spec.md` in the session
   folder and hand it to `/build-feature` in the Operations Director project. New KPI compute
   code ships with its KPI Library entry in the same commit (`js/kpi-library.js`).
4. The spec has two lists, so the changeover is one job and nothing is missed:
   - **Coming off:** every KPI the dashboard showed for this business last quarter, each
     marked retire, keep or change. A closed project's KPI leaves the dashboard's strategic
     KPI list on its own once `Closed On` is set (`js/dashboard.js`), so check 5a did that.
     A KPI card that is not tied to a project does not leave on its own: list it.
   - **Going on:** every agreed KPI, with its formula, source fields, a sample record, the
     reading expected today, and committed and stretch.
5. **The handover is a task, never a remembered promise.** Before the session ends, either
   name the open build that is already doing the dashboard work (its session title or PR) or
   raise one task for it through `scripts/create-agent-task.py`, linked to the business,
   carrying the spec's path, and read back by id. The write-back names which.
6. Never say a KPI updates on its own until you have watched the dashboard show it.

## Phase 7: read it back and send Kevin the finished plan

1. Read the new record back against the approved draft, field by field: the ten sections from
   Phases 3b and 3c, and the three projects with KPI, target, owner, tracking method, definition of
   done and all nine monthly stepping stones. Fix any field that did not land.
2. Render the plan in the page's own export layout:

```bash
node scripts/render-strategy-plan.cjs --record <plan record id> --out "<the session folder>"
```

   It runs `buildPrintableDocument` from `os/strategy/strategy.js`, so it matches the page's
   "Export PDF" button, and it refuses to write inside this repo.
3. **Send Kevin the PDF with SendUserFile. The session is not finished until he has the
   finished plan in front of him.** Send it again after any later change to the record. Tell him where the same plan lives in the app: Objective &
   Strategy, his business, the quarter (`https://app.operationsdirector.co.uk/os/strategy/index.html`).

## Phase 8: the write-back (the session is not finished without it)

1. Brain decision note: `Decisions/<YYYY-MM-DD> Q<N> <business> strategy session - rulings.md`
   in `00 AI Context`, with Kevin's words, the plan record id and the project ids. It carries
   every ruling from the section walk, the growth pace, the signed-off targets with their
   confidence levels, and what was left out of the numbers and why.
2. `current-priorities.md` in the brain: the three projects, in his order.
3. Memory: one dated project memory for the session, linked from `MEMORY.md`.
4. A mid-quarter review date, about week 6, as a task for Kevin through
   `scripts/create-agent-task.py`, read back by id. Its description lists the first check of
   that review: open the leadership dashboard and confirm every "going on" KPI shows a live
   value and every "coming off" KPI has gone. A miss is fixed that day.
5. Anything committed to in the session that has no task gets one, or is named as dropped.

## What this skill does not do

- It does not run for two businesses in one session.
- It does not build dashboard code, change `strategy.js` or edit the task script.
- It does not send anything to a tenant, a contractor or anyone outside. Work for Roy becomes
  tasks; messages go through the approval queue.
- If Kevin asks for this to run on a clock without him, stop and run `/agent-gate` first.
