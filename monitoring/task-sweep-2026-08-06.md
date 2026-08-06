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

## Fixed since this report was first written (Kevin approved, 6 Aug)

**1. The Drift Monitor can no longer invent options.** DONE. Its instructions at
`~/.claude/scheduled-tasks/drift-monitor/SKILL.md` said to set status to `"To Do" or
similar` and said nothing at all about Time Estimate. "Or similar" was the licence to guess.
Replaced with a character-exact table of the only permitted values for Status, Time
Estimate, Priority and Recurring, read from the live schema, plus the reason it matters. It
also now says never to set Recurring, including the literal "None".

Worth noting: the real Status option is `To do` with a lower-case d. The job had been
getting that right by luck.

**2. The two tasks are repointed.** DONE.

| Record | Was | Now |
|---|---|---|
| `recdQvsB0WXEUgIIi` | 15 mins | 15 min |
| `recQgPMVY9e6bRP1z` | 30 mins | 30 min |

Counted again afterwards to prove it: "15 min" went 5,639 to 5,640, "30 min" went 313 to
314, and both typo options are now on **0 records**.

The sweep's own `apply` could not do this. It is a gap-filler: it deliberately skips any
field that already holds a value, so it will fill a blank but never correct a wrong one. I
used a targeted one-off with the same safeguards — checked the target against the live
option list, wrote with `typecast:false` so Airtable would reject an unknown option instead
of creating one, and logged the previous values to
`monitoring/task-sweep-applied-2026-08-06.json` in the sweep's own format.

Undo: `python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-06.json`

## Still needs you: one click

**3. Delete the two empty options.** "15 mins" and "30 mins" now have no records behind
them, but they are still in the field. **The sweep stays blocked until they are gone** — I
re-ran the audit after the repoint and it still stops on the same drift. Airtable does not
allow deleting select options through the API, so this one is a browser job:

Tasks table, open the "Time Estimate" field editor, delete "15 mins" and "30 mins".

Once those two are gone the sweep runs normally again with no code change. The list it
checks against is correct; the table drifted away from it, not the other way round.

I did not do this one because deleting from a live table's schema is your call, and you
asked for the drift monitor and the repoint.

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

The sweep itself made no writes. Two corrective writes were made afterwards on Kevin's
instruction, both listed above and both reversible with the undo command.

## Waiting on you

Nothing in the usual pending queue, because the sweep never got as far as making decisions.
`monitoring/task-sweep-pending.json` has not been touched, so anything already sitting in it
from a previous night is still there and still valid.

## CEO review

Skipped. There were no decisions to review.

## Undo

python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-06.json
