# Task Hygiene Sweep — 2026-08-08

## Score
Open tasks: 326. Fully compliant: 6 (1.8%).

That number looks alarming and it is misleading. Read the "Why the score is meaningless"
section below before reacting to it. The real state of your task list is better than 1.8%.

## Fixed today (no approval needed)

| Task | Field | Value | Why |
|---|---|---|---|
| Contact EDF to reduce monthly direct debit | Business | Real Estate | every other EDF task in the base is Real Estate, 13 Eldon Road |
| Apartment 9 Duckworth Building: Intus email | Business | Real Estate | apartment tenancy and lettings agent |
| Apartment 9 Duckworth Building: Intus email | Time Estimate | 30 min | draft already written; send it and correct one record |
| INBOUND: Outstanding invocies | Business | Real Estate | from Hayden at MHH, the accountants; 7 of 8 MHH tasks are Real Estate |
| Confirm the six GHL prospecting workflows | Business | Operations Director | prospecting setup |
| Confirm the six GHL prospecting workflows | Time Estimate | 30 min | check six folders, their triggers and the booking link |
| Fix email authentication for operationsdirector.co.uk | Business | Operations Director | your OD domain |
| Fix email authentication for operationsdirector.co.uk | Time Estimate | 15 min | the task itself says ten minutes |

8 changes across 5 tasks. All verified in Airtable afterwards.

## Waiting on you

3 decisions held. **This would send 0 Slack messages.** Say "approve the sweep" in any Claude
session to apply them.

| Task | Field | Proposed | Why |
|---|---|---|---|
| Get prospecting ready to go live before Kevin leaves | Project | The outbound engine runs, every day | this task is that project |
| Confirm the six GHL prospecting workflows | Project | The outbound engine runs, every day | the follow-up half of the cold lane |
| Fix email authentication for operationsdirector.co.uk | Project | The outbound engine runs, every day | your domain email fails authentication, which blocks cold email at volume |

## Why the score is meaningless right now

Three things are counted as "missing" that are not actually mess.

**1. Missing recurring: 315 of 326 tasks.** This is the single biggest drag on the score and it
is a counting fault, not untidiness. Most tasks happen once. The correct value for them is an
empty box. But "None" in Airtable is a value, not an empty box, so writing it would push
one-off tasks into your and the team's recurring performance figures. So they stay blank, and
blank counts as a gap. Every night this drags the score to near zero.

I read every one of the 315. Only about 20 even mention a repeating word, and nearly all of
those are one-off jobs about a repeating thing, for example "set up a standing order for the
1st of every month". That is a single task. I proposed no recurring values at all.

The fix is in code, not in the data: stop counting recurring as a gap, or teach the five
formulas to ignore "None". That needs a change to the app, so it goes to the fixer job.

**2. Missing assignee: 133 tasks.** I checked the Team Member field on every one of them.
**125 already have an owner there.** Your ruling is that ownership lives in Team Member, not
Assignee, so those 125 are owned, not orphaned. Filling in Assignee would have fired 125 Slack
messages to name people who are already on the work.

That leaves 8 with no owner in either field. I read all 8:

- 5 are "Drift Monitor" alerts, raised by a monitoring routine about the code
- 1 is an "E2E Sweep" note whose own title says there is nothing for you to fix
- 1 says in its description "OWNER: AI agent"
- 1 is "PARKED — revisit after the first client"

Not one of them should go on a person's plate. So I proposed no assignees. Zero.

**3. Missing project: 230 tasks.** Most day-to-day work belongs to no project, and forcing a
link would be worse than leaving it blank. I checked all 230 against your 8 open projects and
found 3 genuine matches, all in the outbound lane. They are in the table above.

## Left alone
318 tasks, deliberately. Broken down: 315 kept a blank recurring value on purpose, 125 already
have an owner in Team Member, 227 genuinely belong to no project, and 8 are owned by an agent,
by a monitor, or are parked.

## CEO review
Not run. This session is under a standing instruction not to call other agents unless you ask.
The review exists to catch work being pushed onto the wrong person, and today nothing is being
pushed onto anyone: zero assignee changes and zero Slack messages. Say the word if you want it
run before you approve the three project links.

## Also fixed today, outside the sweep
The sweep was blocked this morning by two duplicate choices, "15 mins" and "30 mins", added to
the Time Estimate dropdown. On your instruction I deleted them through the Airtable interface,
because the API refuses to remove select options. Record counts were identical before and
after, so nothing was lost.

## Undo
python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-08.json

---

# Appendix — the earlier run that stopped (02:30 slot, reported 10:31)

Kept verbatim from the first sweep attempt of 2026-08-08, which halted before touching
anything. The completed run above supersedes it and records how it was resolved. It is
retained because it holds the evidence behind that one-line summary, and because a report
is appended to, never overwritten.

## Did not run

The sweep stopped on purpose before touching anything. No tasks were read, judged or changed.
Nothing in Airtable moved.

## Why it stopped

Someone added two new choices to the **Time Estimate** dropdown on the Tasks table:
**"30 mins"** and **"15 mins"** — the same as the existing "30 min" and "15 min", just with an
"s" on the end.

The sweep checks the dropdown against the list it expects before it writes anything. The list
did not match, so it halted. That is the guard working, not a fault.

## How bad is it

Not bad yet. I counted every task using each value:

| Value | Tasks using it |
|---|---|
| "30 mins" (new) | 0 |
| "15 mins" (new) | 0 |
| "30 min" (correct) | 314 |
| "15 min" (correct) | 5,640 |

The two new ones are sitting in the dropdown unused. I checked the counts against the correct
spellings on purpose, so I know a zero here means genuinely zero and not a broken query.

## Why it still needs fixing

The first person who picks "15 mins" from the list splits your time reporting in two. Half the
tasks say "15 min", half say "15 mins", and no report adds them up together. The automation that
turns Time Estimate into the Time field has no entry for the plural version either, so that
task's Time would quietly stay empty.

## What I suggest

Delete the two duplicate choices in Airtable. It is safe to do that today only because nothing
uses them — deleting a choice that tasks were using would wipe those cells. After that the sweep
runs normally with no code change at all.

I have not done it. It changes the structure of your base, so it is your call.

Filed as finding `20260808-task-hygiene-sweep-014` for the fixer job.

## Earlier today

The sweep also missed its 02:30 slot. The internet was down at the time and the check gave up
after 10 minutes. It then sat behind the prospecting job until 10:31. Separately, there is no
sweep output for 5, 6 or 7 August either, so this is four days without a tidy-up. Filed as
`20260808-task-hygiene-sweep-013`.

## Score
Not measured. The audit never got past the dropdown check.

## Fixed today
None.

## Waiting on you
1. Say yes to deleting the two duplicate dropdown choices, then the sweep runs clean tonight.
2. `monitoring/task-sweep-pending.json` still holds the approval set from 4 August, untouched.

## Undo
Nothing to undo. No writes were made.
