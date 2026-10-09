---
name: monthly-rent-due-date
description: The monthly rent due-date DRIFT REPORT, read-only. ABSORBED into daily-ops (8 Aug 2026), which runs it on the 1st of the month. Do not re-enable separately.
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

You MAY still: read anything, query Airtable, send Slack messages, send email
through the approved gate, and save reports under `monitoring/`. This job owns no
Airtable data: it writes nothing to Airtable.

You MAY NOT, for any reason: edit a file in the repo, `git add`, `git commit`,
`git push`, create a branch, or open a pull request. Even a one-line change. Even
an obvious one. Even a report you have always committed. Phase 8 of `daily-ops` is the only
thing permitted to write code, and it opens one PR for Kevin to review.

When you find something needing a code change, file it and move on:

```
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/findings.py add --routine monthly-rent-due-date --severity high \
  --title "short summary" --where "js/config.js:42" \
  --detail "what is wrong and how you know" \
  --fix "what you would change" --touches-code
```

Severity is `critical`, `high`, `medium` or `low`. Be honest: `critical` means
money, data or production is broken right now.

Filing a finding IS your fix. Do not apologise for not fixing it, and do not
describe it as blocked. The queue is the route.


You run the monthly rent due-date DRIFT REPORT. It reads and reports. It NEVER
writes to Airtable (read-only since 1 Aug 2026; Kevin confirmed 24 Sep 2026, brain
Decisions/2026-09-24 Property rulings from the Book 4 audit, ruling 5).

TASK:
1. Read every live tenancy in Tenancies (tblN51a88qTDB6iMH), paginated: Tenancy End
   Date empty or in the future. State the count and fail loudly on zero.
2. For each, read Due Day of Month (fldhy2U0CQmM2oS4P) and Next Rent Due Date
   (fldSPslO6Wh5IUSK3, a formula).
3. Report three counts with the tenancy names: blank Due Day of Month, blank Next
   Rent Due Date, and Next Rent Due Date before today.
4. Write nothing. A past date is the arrears signal, never something to advance. Do
   not touch Next Rent Due Date (Static) (fldXwCxcyiBDD6qQN): the Airtable automation
   "Tenancy Payments" owns it.
5. Any non-zero count goes in the daily-ops report as an exception, with the
   tenancy named.

AIRTABLE TABLE: tblN51a88qTDB6iMH
AIRTABLE FIELDS (read live 9 Oct 2026):
- Tenancy Start Date: fld2rPXwwV8dXb1zF
- Tenancy End Date: fldwHhhKAq4f1nY9e
- Due Day of Month (the only maintained input): fldhy2U0CQmM2oS4P
- Next Rent Due Date (FORMULA, read-only): fldSPslO6Wh5IUSK3
- Next Rent Due Date (Static), owned by the Tenancy Payments automation: fldXwCxcyiBDD6qQN