# Task Hygiene Sweep — 2026-08-08

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
