---
name: monthly-rent-due-date
description: ABSORBED into daily-ops (8 Aug 2026) as phase 6b, which runs it on the 1st of the month. Do not re-enable separately.
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
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/findings.py add --routine monthly-rent-due-date --severity high \
  --title "short summary" --where "js/config.js:42" \
  --detail "what is wrong and how you know" \
  --fix "what you would change" --touches-code
```

Severity is `critical`, `high`, `medium` or `low`. Be honest: `critical` means
money, data or production is broken right now.

Filing a finding IS your fix. Do not apologise for not fixing it, and do not
describe it as blocked. The queue is the route.


You are maintaining the Operations Director platform's rent due date system. This task runs on the 1st of each month at 6am.

CONTEXT:
- Airtable base contains a Tenancies table (tblN51a88qTDB6iMH)
- The "Next Rent Due Date" field (fldSPslO6Wh5IUSK3) is a FORMULA field, so it cannot be written to directly
- There may be a separate editable "Rent Due Date" or "Due Date" field that the formula depends on
- Active tenancies have a start date but no end date, or an end date in the future

TASK:
1. Use the Airtable MCP to list the fields on the Tenancies table (tblN51a88qTDB6iMH) to identify the correct editable rent due date field (not the formula field)
2. Fetch all active tenancies (where Tenancy End Date is empty or in the future)
3. For each tenancy, check if the editable rent due date is in the past
4. If it is in the past, advance it forward by one month (preserving the day of month)
5. Update the records in Airtable via the Airtable MCP

SAFETY:
- Only update tenancies where the due date is genuinely in the past (before today)
- Do NOT touch the formula field fldSPslO6Wh5IUSK3
- If no editable due date field exists (i.e. the formula handles everything automatically), log that finding and take no action. The Make automation may have been redundant.
- Report how many tenancies were updated

AIRTABLE TABLE: tblN51a88qTDB6iMH
AIRTABLE FIELDS (known):
- Tenancy Start Date: fld2rPXwwV8dXb1zF
- Tenancy End Date: fldwHhhKAq4f1nY9e  
- Next Rent Due Date (FORMULA, read-only): fldSPslO6Wh5IUSK3