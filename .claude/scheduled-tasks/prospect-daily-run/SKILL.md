---
name: prospect-daily-run
description: Daily prospecting agent (7 days): target 5 qualified UK founder prospects/day across LinkedIn, X, Threads, FB groups; sync approved to GHL
---

## QUEUE AND WRITE POLICY (added 6 Aug 2026 — do this before anything else)

On 6 Aug 2026 ten routines woke together after the Mac slept and all ran between
08:07 and 08:33. They produced nine commits in twenty-eight minutes and left the
working tree dirty across four unrelated features. Two rules came out of it, and
they override anything below that contradicts them.

### Rule 1 — take the queue lock first

```
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/job-queue.py acquire prospect-daily-run --lease 90
```

- exit **0** — you hold the machine. Carry on.
- exit **3** — you are too late for this work to be useful. STOP. Do nothing else.
- exit **75** — another routine holds the machine. STOP. Do nothing else.

Never continue past a non-zero exit code. Running anyway is precisely the
behaviour this replaces. Release it as your last step, success or failure:

```
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/job-queue.py release prospect-daily-run
```

If your run will take longer than 90 minutes, extend the lease as you go:
`python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/job-queue.py heartbeat prospect-daily-run --lease 90`.

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
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/findings.py add --routine prospect-daily-run --severity high \
  --title "short summary" --where "js/config.js:42" \
  --detail "what is wrong and how you know" \
  --fix "what you would change" --touches-code
```

Severity is `critical`, `high`, `medium` or `low`. Be honest: `critical` means
money, data or production is broken right now.

Filing a finding IS your fix. Do not apologise for not fixing it, and do not
describe it as blocked. The queue is the route.


Run the prospecting agent for Operations Director. Working directory: /Users/kevinbrittain/Projects/leadership-dashboard.

Invoke the project skill `prospect-daily` (defined in .claude/skills/prospect-daily/SKILL.md) and follow it exactly. In brief: read active keywords from the Airtable Prospect Keywords table (base appnqjDpqDniH3IRl, table tblB5tZrXNaKFe02j, PAT at ~/.config/od/airtable_pat — never print it), search LinkedIn posts through Kevin's logged-in Chrome via the claude-in-chrome tools at human pace (max 20 profile views, 5-15s pauses, STOP for the day on any captcha or unusual-activity warning), qualify founder-led UK micro/small business owners posting genuine overload pain, find their website and a PUBLISHED contact email (never guess addresses), classify entity via the public Companies House register (only Limited Company may ever be email-sequenced — PECR), dedupe against existing Prospects (table tbljHVGJoKJf8acy3) including the permanent Suppressed list, write new records with Status "Ready for Review", update keyword Last Used/Prospects Found, then sync any Status "Approved" prospects to GoHighLevel (token at ~/.config/od/ghl_api_key + location at ~/.config/od/ghl_location_id; tag Ltd contacts od-prospect-nurture, all others od-prospect-manual; write back GHL Contact ID and Status "Synced to GHL"; if the token files are missing, skip the sync and say what Kevin must create).

If Chrome is not connected or the Mac was asleep, report "run skipped" honestly. Finish with a one-line Slack DM to Kevin via the Slack connector: found count, synced count, keywords used, warnings.