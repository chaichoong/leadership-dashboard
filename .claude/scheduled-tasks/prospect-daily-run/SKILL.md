---
name: prospect-daily-run
description: ABSORBED into daily-ops (8 Aug 2026) as phase 6.3. Do not re-enable separately.
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

If Chrome is not connected or the Mac was asleep, report "run skipped" honestly. Do NOT DM Kevin (Slack contract, 21 Aug 2026). Finish by returning one line to daily-ops: found count, synced count, keywords used, warnings. If something needs a decision from Kevin, start that line with NEEDS KEVIN and say the decision in one plain sentence, so phase 9 lifts it into the report.