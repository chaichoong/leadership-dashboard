---
name: ceo-brief-morning-check
description: RETIRED 26 Aug 2026 (register entry disabled). Previously ABSORBED into daily-ops (8 Aug 2026) as phase 7.2. Do not re-enable.
disabled: true
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
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/findings.py add --routine ceo-brief-morning-check --severity high \
  --title "short summary" --where "js/config.js:42" \
  --detail "what is wrong and how you know" \
  --fix "what you would change" --touches-code
```

Severity is `critical`, `high`, `medium` or `low`. Be honest: `critical` means
money, data or production is broken right now.

Filing a finding IS your fix. Do not apologise for not fixing it, and do not
describe it as blocked. The queue is the route.


You are checking that Kevin's 9am AI CEO morning brief actually arrived. Context: the Cloudflare worker "money-confidence-daily" (source: /Users/kevinbrittain/Projects/leadership-dashboard/scripts/slack-automation/money-daily-worker.js) fires crons at 08:00 and 09:00 UTC; a London-time gate lets one through at 09:00 London on weekdays. It DMs Kevin in Slack and writes a record to the Airtable "CEO Briefs" table (base appnqjDpqDniH3IRl, table tblIxbzDSOCI5hqJn). On 29 Jul 2026 the cron was invoked but produced nothing, silently; Workers Logs (observability) are now enabled to diagnose exactly this.

Steps:
1. Check Airtable for a CEO Briefs record dated today (Europe/London date). Use curl with the PAT file at ~/.config/od/airtable_pat (never print the token). Sort by Date desc, look at the top record.
   **IMPORTANT (changed 30 Jul 2026): a record existing is NO LONGER proof the brief fired.** The `ceo-huddle` task now creates today's record at ~07:30 with One Thing, First Step and Board Flags, and deliberately leaves `Full Brief` (fldPkiaWvmYAoyHEl) empty. The worker fills `Full Brief` when it runs. So the test is: **is `Full Brief` populated?** Empty means the 09:00 brief did NOT fire, even though a record exists.
2. If today's record has `Full Brief` POPULATED: the run worked. Report one line to the session log and stop. Do not message Kevin — no news is good news.
3. If it does NOT exist: diagnose. Pull worker logs via `npx -y wrangler@4 tail` is live-only, so instead query the Cloudflare API observability/telemetry for the worker (account c4206efef5c8ea5d6b9bfac3d281e0db, wrangler is authenticated on this Mac), or check https://dash.cloudflare.com logs. Also test the pipeline manually: TRIGGER_KEY is in ~/.config/od/money_trigger_key; GET https://money-confidence-daily.kevinbrittain.workers.dev/?mode=brief&key=KEY shows whether generation works.
4. If generation works but the cron path failed again: send today's brief manually with mode=send (same URL pattern), confirm a record appears in the CEO Briefs table, then Slack-DM Kevin (user U08HW8F1MA8, use the Slack MCP tools) ONE short plain-English message: the brief was late, it has been sent manually, and the fix is being worked on. Then fix the root cause if the logs make it clear, or record the findings in /Users/kevinbrittain/Projects/leadership-dashboard/monitoring/ceo-brief-cron-findings.md for the main session. **APPEND to that file under a new `## {date}` heading — never rewrite it.** It is one running log across every failure, not today's snapshot, and the pattern across mornings is the evidence: the day-of-week cron bug was only visible because several dates sat side by side. Overwriting it destroys the diagnosis you are trying to build.
5. Plain English (13-year-old level) in anything Kevin sees. Never print secrets.
This task exists because of the CEO's kaizen duty: the brief must never fail silently.

RETIREMENT NOTE (27 Aug 2026, finding 20260826-ceo-brief-morning-check-374): the self-retirement condition above was met — the cron ran clean for 8 unbroken weekdays to 26 Aug 2026 — and the register entry in scripts/job-schedule.json was disabled on 26 Aug in Kevin's restructure. The frontmatter now carries disabled: true, which resolves the ambiguity between the ABSORBED note and the self-disable rule. The 09:30 daily-ops guard reports a missing brief, so the check is still covered.