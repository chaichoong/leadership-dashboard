# Task Hygiene Sweep — 2026-08-06

## Score

**No score tonight. The sweep did not run.**

It stopped at the first step on purpose, before reading a single task. Nothing was
written to Airtable. Last known score: 323 open tasks, 6 fully compliant (1.9%) on
4 Aug.

## Why it stopped

The sweep checks the shape of the Tasks table before it touches anything. Tonight the
"Time Estimate" box had two options in it that should not exist:

| Options the sweep expects | Options actually there |
|---|---|
| 15 min, 30 min, 45 min, 1 hr, 2 hr, 3 hr, 4 hr, 8 hr | the same eight, **plus "15 mins" and "30 mins"** |

"15 mins" and "30 mins" are duplicates of "15 min" and "30 min" with an extra letter s.
To Airtable they are completely separate options. Any report that counts time by option
now splits the same thing across two buckets.

The sweep is built to stop dead when the table changes shape, rather than carry on and
write values into a table it no longer understands. That is what happened. This is the
guard working, not a bug.

## Where the two bad options came from

I traced them. Both were created this morning, **6 Aug at 08:28**, by the **Drift Monitor**
job, which is another nightly task of yours. It created two tasks for you to review and
filled in the time estimate by guessing sensible-sounding English instead of picking from
the list of eight.

| Task | Time Estimate it wrote |
|---|---|
| Drift Monitor: [INFO] Install the local pre-commit hook... (`recdQvsB0WXEUgIIi`) | 15 mins |
| Drift Monitor: [WARNING] 53 leftover rows in Arrears Records... (`recQgPMVY9e6bRP1z`) | 30 mins |

Only those two tasks use the bad options. I checked every record in the table:

- "15 min" — 5,639 records
- "30 min" — 313 records
- "15 mins" — **1 record**
- "30 mins" — **1 record**

So the damage is tiny and easy to undo. The concern is that it will happen again tomorrow
night, and every night, until the Drift Monitor is told to pick from the list.

The reason Airtable allowed it: when a job writes a value that is not on the list, Airtable
can quietly add it as a brand new option rather than refusing. So a typo becomes permanent
schema.

## What I need from you

Three things, in this order. I have not done any of them, because the sweep's rules say to
stop and report when the table has changed shape, and because deleting options from a live
table is your call, not mine.

**1. Fix the Drift Monitor so it stops inventing options.** This is the real fix. Its
instructions at `~/.claude/scheduled-tasks/drift-monitor/SKILL.md` (around line 147) tell it
to look up field IDs but never tell it that Time Estimate has a fixed list. Say the word and
I will add that list to its instructions.

**2. Point the two tasks at the right option.** Change `recdQvsB0WXEUgIIi` from "15 mins" to
"15 min", and `recQgPMVY9e6bRP1z` from "30 mins" to "30 min".

**3. Delete the two empty options.** Once step 2 is done, "15 mins" and "30 mins" have no
records left. Delete them in the Airtable field editor. Airtable does not allow deleting
options through the API, so this one is a click job in the browser.

Once those are done the sweep runs normally again with no code change. The list it checks
against is correct; the table drifted away from it, not the other way round.

## Second thing I noticed

**No sweep ran on 5 Aug.** There is no `monitoring/task-sweep-2026-08-05.md`, and no
worklist, decisions or applied file for that date either. Every other night since 1 Aug
wrote all four. I cannot tell you why from here — this sweep is a Claude scheduled task, so
it does not write to the job log that the shell jobs use, and I did not watch the scheduler.
What I can say is that no evidence of a 5 Aug run exists on disk.

That means the field gaps have gone two nights without a pass, not one.

## Also worth a glance (not mine to fix)

The `masterplan-sync` job failed on both 5 Aug and 6 Aug, both times on `git pull` inside
this repo. There are three files sitting uncommitted in the checkout from another session
(`.claude/skills/prospect-daily/SKILL.md`, `monitoring/ceo-brief-cron-findings.md`,
`scripts/agent-dispatch.py`). A shared checkout with loose edits in it is exactly the
situation that breaks an automatic pull. I left those files alone.

## Fixed tonight

Nothing. No Airtable writes were made.

## Waiting on you

Nothing in the usual pending queue, because the sweep never got as far as making decisions.
`monitoring/task-sweep-pending.json` has not been touched, so anything already sitting in it
from a previous night is still there and still valid.

## CEO review

Skipped. There were no decisions to review.

## Undo

Nothing to undo. No writes were made.
