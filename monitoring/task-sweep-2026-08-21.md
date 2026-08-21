# Task Hygiene Sweep — 2026-08-21

## Read this bit first

**13 decisions are queued and not one of them needs a person. The queue is the bug,
not the backlog.**

Approving all 13 sends ZERO Slack messages to anyone. Eleven of them have been sitting
since Tuesday. Your CEO's fix is one rule, not one approval: **handing a task to an AI
agent, and linking a task to a project, should happen on the night they are found, with
no queue.** Anything that names a real person keeps the gate exactly as it is now.

Say yes to that and the file stops growing. Say nothing and it is 15 tomorrow.
(Filed as 20260821-task-hygiene-sweep-285 so it is not lost. It will not be built
without your word, because it changes the scope you approved on 30 July.)

## Score

Live tasks: 232. Fully compliant: 223 (96.1%). Was 96.6% yesterday.
Owned by an AI agent: 116 (50.0%). Owned by a person: 108. Owned by nobody: 8.
Left out of the score: 53 waiting on your approval, 16 with no status.

Gaps: 147 no project, 8 no owner, 3 no business, 1 no time estimate, 1 no due date.

The small drop is one new task arriving this morning with four blanks, not anything
going backwards. Your CEO also asked me to stop counting "no project" as a daily gap:
at 63% of the whole list it is the normal shape of the work, not mess. I have left the
number in tonight so you can see it, but it should move to a monthly review.

## Fixed tonight (no approval needed)

| Task | Field | Value | Why |
|---|---|---|---|
| E2E Sweep [WARNING]: AI Brain feed 3 days stale, and 19 prospects with no entity type | Time estimate | 2 hr | two fixes in one job: a dead nightly publisher, plus filling in 19 prospect records |
| E2E Sweep [WARNING]: AI Brain feed 3 days stale, and 19 prospects with no entity type | Business | Operations Director | platform and prospecting work |

Two writes, on one task. Nothing else could be filled in safely.

## Waiting on you

**13 decisions held. Not one names a person, so approving the whole lot sends ZERO
Slack DMs.** Say "approve the sweep" in any Claude session.

New tonight (1):

| Task | Field | Proposed | Why |
|---|---|---|---|
| E2E Sweep [WARNING]: AI Brain feed / 19 prospects | owner | AI Worker — Builder | the publisher failure is a code fix, the prospect fill-in is a data job |

Carried over, still unfilled and still live (12):

| Task | Field | Proposed | Why |
|---|---|---|---|
| INBOUND: Urgent Update required: 1406 Oldham Road | owner | AI Legal & Compliance | Manchester Council chasing an electrical safety certificate |
| INBOUND: 18 Siddows Avenue Clitheroe | owner | AI Legal & Compliance | Ribble Valley Council complaint about garden condition |
| INBOUND: SMS reply from a tenant [number redacted] | owner | AI Operations | tenant SMS about a maintenance job, needs a reply drafted |
| Replace window hinge – second bedroom | owner | AI Operations | security defect at an occupied unit; the agent books the contractor |
| Measure and quote carpets – both bedrooms | owner | AI Operations | quote only, agent books the contractor |
| Tenant COA and rent into payment [name redacted] | project | Close the payment gap | that is exactly what the project covers |
| Together arrears top up payments | project | £12k Operating Cushion | the project names the £500 Together allowance in its own title |
| Mortgage Product Transfers Plan | project | £12k Operating Cushion | product transfers cut monthly fixed costs |
| Contact EDF to reduce monthly direct debit | project | £12k Operating Cushion | a lower direct debit is a lower monthly fixed cost |
| Spec the OD quarterly client-journey renewal report | project | Complete all modules for OD Web App | it is a web app module |
| INBOUND: reply to SSE Energy Solutions | business | Real Estate | every past SSE task is tagged Real Estate |
| INBOUND: POST: DBS Enhanced Certificate | business | Real Estate | existing DBS and screening tasks are tagged Real Estate |

I checked all 12 against Airtable before carrying them. Every one is still blank. The
DBS one has moved into "waiting on approval" since yesterday, which is why it dropped
out of the live count, but its business tag is still empty so I have kept it.

I MERGED onto yesterday's file rather than overwriting it. Overwriting is the bug filed
as 20260819-task-hygiene-sweep-251.

## Left alone

- **The SSE smart-meter circular.** Third day open. On 20 August your CEO ruled that a
  supplier marketing circular with no account action gets closed on arrival and never
  tagged, dated or owned. Tonight it pointed out the rule has nobody carrying it out.
  It told me to close the record. **I did not**, and I want to be plain about why: the
  sweep is only allowed to write six fields, and Status is not one of them. Closing it
  by hand would be routing around the guard rail that exists so this job cannot do
  damage. So it stays open, it will keep showing up as three gaps every night, and the
  real fix is filed as 20260821-task-hygiene-sweep-283 — teach the inbound handler to
  spot a circular and close it on arrival.
- **"PARKED — revisit after the first client".** No owner, due 31 December. You ruled a
  parked container does not need one.
- **2 completed tasks with no business tag.** The 123 Reg renewal (the email never says
  which domain) and "Welcome to NeighborsCU" (a US credit union congratulating somebody
  on a new car). Both guesses would be inventions.
- **147 tasks with no project.** Judged ordinary operations. See the note in the score.
- **Recurring still counts as a gap on nearly every task.** Writing "None" would close
  it and would be wrong: "None" is a value, not an empty box, and it arms the task to
  clone itself. Filed long ago as 20260808-task-hygiene-sweep-018.

## Still real? (8 tasks over 90 days past due — unchanged, 3rd day)

All 8 reached, none acted on, nothing has moved since Wednesday.

**The five March invoices** (PPE & Sons INV-0549, three DD Fire Alarms, one cleaning
invoice — 147 to 154 days late, all owned by the AI Analyst). On 18 August three of the
five turned out to be **already paid**. Your CEO ruled on 20 August: reconcile all five
against the bank once, close what is paid with a note, single payment run for anything
genuinely left. That instruction has not been carried out. Tonight it said this is not a
tidy-up item at all — it is an unexecuted instruction, and it should be chased as one.

**The two payment tasks on a person** — 32 Elmdon Place council tax adjustment (211 days
late) and a family member's 2023/24 tax liability [name redacted] (189 days late). Your CEO's read, again:
this is a payments queue that has stopped moving. It belongs in your blockers, not in a
hygiene report.

**Tenant COA and rent into payment [name redacted]** (121 days late) — still real work. Its project
link is in the approval queue above.

## Keeping the AI metric honest

**Every task completed in the last 30 days carries a time estimate (100%).** Nothing is
invisible to the "Work Done by AI %" figure. Two completed tasks still have no business
tag; that is attribution only and does not affect the KPI. Both are explained above.

## CEO review

Reviewed before anything was written. It kept all three of tonight's decisions and
changed four things around them:

- **Kept** the 2 hr estimate, the Operations Director tag, and the AI Builder owner.
- **Flagged** that the E2E sweep task is really two unrelated jobs in one record, which
  cannot be half-closed. Told me to file it, not restructure it in a hygiene sweep.
  Filed as 20260821-task-hygiene-sweep-284.
- **Changed** its own position on the SSE circular: fields stay blank, but the record
  should be closed and the missing arrival-closer is the real defect. Filed as 283.
  I did not close it myself — see "Left alone" for why.
- **Changed** the whole pending tier. That is the headline at the top of this report.
- **Changed** the "no project" count from a daily gap to a monthly review.

## Filed tonight

- 20260821-task-hygiene-sweep-283 (medium) — no executor for the close-on-arrival rule
- 20260821-task-hygiene-sweep-284 (low) — E2E sweep bundles two jobs into one task
- 20260821-task-hygiene-sweep-285 (medium) — AI-owner routes and project links should be
  auto tier; needs your yes first

## A note on what is in this file

I redacted a tenant's mobile number and two people's names from this report before
writing it. Earlier reports in this folder did not, and they are now public on GitHub.
Filed as 20260821-task-hygiene-sweep-286.

## Undo

python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-21.json
