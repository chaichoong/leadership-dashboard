---
name: monthly-rent-due-date
description: Advance rent due dates for all active tenancies at the start of each month (replaces Make scenario M11).
---

## QUEUE AND WRITE POLICY (added 6 Aug 2026 — do this before anything else)

On 6 Aug 2026 ten routines woke together after the Mac slept and all ran between
08:07 and 08:33. They produced nine commits in twenty-eight minutes and left the
working tree dirty across four unrelated features. Two rules came out of it, and
they override anything below that contradicts them.

### Rule 1 — take the queue lock first

```
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/job-queue.py acquire monthly-rent-due-date --lease 45
```

- exit **0** — you hold the machine. Carry on.
- exit **3** — you are too late for this work to be useful. STOP. Do nothing else.
- exit **75** — another routine holds the machine. STOP. Do nothing else.

Never continue past a non-zero exit code. Running anyway is precisely the
behaviour this replaces. Release it as your last step, success or failure:

```
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/job-queue.py release monthly-rent-due-date
```

If your run will take longer than 45 minutes, extend the lease as you go:
`python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/job-queue.py heartbeat monthly-rent-due-date --lease 45`.

### Rule 2 — you are read-only with respect to code

You MAY still: read anything, query Airtable, write the Airtable data your job
owns, send Slack messages, send email through the approved gate, and save reports
under `monitoring/`.

You MAY NOT, for any reason: edit a file in the repo, `git add`, `git commit`,
`git push`, create a branch, or open a pull request. Even a one-line change. Even
an obvious one. Even a report you have always committed. `queue-fixer` is the only
scheduled routine permitted to write code, and it runs at 10:15 daily.

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