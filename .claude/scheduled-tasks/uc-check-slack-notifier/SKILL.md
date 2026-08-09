---
name: uc-check-slack-notifier
description: ABSORBED into daily-ops (8 Aug 2026) as phase 6.1. Do not re-enable separately.
---

## QUEUE AND WRITE POLICY (added 6 Aug 2026 — do this before anything else)

On 6 Aug 2026 ten routines woke together after the Mac slept and all ran between
08:07 and 08:33. They produced nine commits in twenty-eight minutes and left the
working tree dirty across four unrelated features. Two rules came out of it, and
they override anything below that contradicts them.

### Rule 1 — you are a PHASE of `daily-ops`, not a routine

This no longer runs on its own schedule. Since 8 Aug 2026 it is one phase of the
single `daily-ops` routine, which runs everything in sequence once a day.

**Do NOT take the queue lock.** `daily-ops` already holds the machine, and the
short shell jobs still use that lock. Taking it here would block them for the
length of this phase.

Why the change: serialising fourteen routines behind a lock worked until the Mac
slept mid-run. A suspended routine keeps holding the lock — on 8 Aug 2026
`drift-monitor` held it for **4 hours 54 minutes** while asleep — so everything
behind it waited and was then skipped for being too late. A lock cannot fix a
machine that sleeps, because the lock sleeps too. One routine running in sequence
has nothing to overlap with and nothing to skip.

**Report honestly what you actually did.** Taking a turn is not doing the work.
Between 5 and 8 Aug 2026 the task-hygiene sweep did nothing for four days running
while every morning's digest listed it under "Worked". If you halt early, say you
halted and why. `daily-ops` reports what you tell it.

### Rule 2 — you are read-only with respect to code

You MAY still: read anything, query Airtable, write the Airtable data your job
owns, send Slack messages, send email through the approved gate, and save reports
under `monitoring/`.

You MAY NOT, for any reason: edit a file in the repo, `git add`, `git commit`,
`git push`, create a branch, or open a pull request. Even a one-line change. Even
an obvious one. Even a report you have always committed. Phase 8 of `daily-ops` is the only
thing permitted to write code, and it opens one PR for Kevin to review.

When you find something needing a code change, file it and move on:

```
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/findings.py add --routine uc-check-slack-notifier --severity high \
  --title "short summary" --where "js/config.js:42" \
  --detail "what is wrong and how you know" \
  --fix "what you would change" --touches-code
```

Severity is `critical`, `high`, `medium` or `low`. Be honest: `critical` means
money, data or production is broken right now.

Filing a finding IS your fix. Do not apologise for not fixing it, and do not
describe it as blocked. The queue is the route.


Send Mica ONE Slack DM listing every Universal Credit check that is due today or
already overdue. If nothing is due, say nothing.

## Why this exists, and how it failed before

The dashboard (`js/arrears.js`) creates one Airtable task per UC tenancy, 7 days
before the rent is due, named `UC verification: {tenant}, £{rent} due {date}`.
Mica rings UC to confirm the payment is scheduled and will be paid to us as
landlord.

From 12 Apr to 1 Aug 2026 this routine sent **zero** notifications while 20+ real
tasks came and went. It searched task NAMES for "UC Payment Verification", a
phrase that only ever appears in the task DESCRIPTION. Back-tested on 1 Aug 2026:
that query matched 0 of 91 records. It ran 144 times a day, found nothing every
time, and looked healthy throughout.

So: **never re-introduce a free-text search here.** All the Airtable logic lives
in one script with a built-in control check. Your job is to run it, send the DM,
and record what you sent.

## STEP 0 — Make sure the tasks exist

The dashboard also creates these tasks, but only inside `loadDashboard`, so its
7-day clock depends on somebody opening a browser tab. This step removes that
dependency: the tasks get booked whether or not anyone logs in.

```
cd /Users/kevinbrittain/Projects/leadership-dashboard
git pull origin main
python3 scripts/uc-task-sync.py
```

Both creators are safe to run together: they build identical names and share the
same dedupe rule, so neither can duplicate the other. Read the JSON it prints:

- **Exit code 2 (CONTROL FAILED)** — it read the tenancies but not one qualified
  as a UC check, or the table came back empty. A field ID, the pay-type label or
  the eligible payment statuses have drifted. Slack-DM **Kevin** (U08HW8F1MA8)
  that UC checks are no longer being booked and why, then stop. Do not continue
  to the notify step; there is nothing trustworthy to notify about.
- **`duplicates` is not empty** — two open tasks for one tenancy in one rent
  month. That is what drift between this script and `js/arrears.js` looks like.
  Include it in the Kevin DM at STEP 3. Never quietly tidy it away.
- **Otherwise** — note `created` and `updated` and carry on.

## STEP 1 — Ask the script what is due

```
python3 scripts/uc-check-notify.py due
```

It prints JSON. The fields that matter:

- `message` — the exact Slack DM to send, already formatted. Send it verbatim.
- `due_ids` — the record IDs covered by that message.
- `due_count` — how many checks are due.
- `duplicate_tenants` — a tenant listed twice means `js/arrears.js` created a
  duplicate task. Real bug, not a display quirk.
- `control_total` — how many UC verification tasks exist at all, any status.

## STEP 2 — Decide

- **Exit code 2 (CONTROL FAILED):** the task naming convention has drifted and
  the query no longer matches anything. Do NOT treat this as "nothing due".
  Slack-DM **Kevin** (U08HW8F1MA8), not Mica: the UC notifier is blind because
  the task names in Airtable no longer start with "UC verification", and
  `js/arrears.js` needs checking. Then stop.
- **`due_count` is 0:** nothing to do. Send no message. End the run quietly.
  Kevin does not want a daily "all clear".
- **`due_count` is 1 or more:** go to STEP 3.

## STEP 3 — Send ONE DM to Mica

Send the `message` string, exactly as the script produced it, as a single Slack
direct message to **Mica, user ID `U08HW0TAWAE`** (micaa.work@gmail.com).

One message per run, never one per task. Seven due checks is one DM with seven
lines, not seven pings.

Mica is the only recipient of the working list. Kevin does not get a copy, by his
own instruction on 1 Aug 2026: chasing UC is her call to make and he does not want
routine work in his DMs. He hears from this routine in exactly three cases, all of
them faults — a CONTROL FAILED at STEP 0 or STEP 2, or duplicate tasks.

If `duplicate_tenants` here (or `duplicates` from STEP 0) is not empty, send a
second, separate one-line DM to **Kevin** (U08HW8F1MA8) naming the tenant and the
record IDs. Keep it out of Mica's message; it is a build defect, not her job.

## STEP 4 — Record what you sent, and only what you sent

```
python3 scripts/uc-check-notify.py mark <every id from due_ids>
```

Run this **only after Slack confirms the DM went out.** If the send failed, do
not mark — the next run should retry rather than silently drop the checks.

## Notes

- Kevin asked on 1 Aug 2026 to keep the working DM Mica-only. Do not add him as a
  recipient of the routine list without him saying so.
- The script skips any task whose rent due date has already passed. The point is
  to ring UC *before* the money is missed; afterwards the call has no preventive
  value and the ping is noise.
- Notified IDs live in `notified.json` beside this file, so nothing is sent twice.
- Mica's Slack timezone is Asia/Chongqing. This runs at 08:00 London, when the UC
  lines open, because the call has to happen in UK office hours.