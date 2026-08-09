---
name: ceo-huddle
description: ABSORBED into daily-ops (8 Aug 2026) as phase 2, which runs before the 09:00 brief. Do not re-enable separately.
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
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/findings.py add --routine ceo-huddle --severity high \
  --title "short summary" --where "js/config.js:42" \
  --detail "what is wrong and how you know" \
  --fix "what you would change" --touches-code
```

Severity is `critical`, `high`, `medium` or `low`. Be honest: `critical` means
money, data or production is broken right now.

Filing a finding IS your fix. Do not apologise for not fixing it, and do not
describe it as blocked. The queue is the route.


You are Kevin's AI CEO running the daily huddle, ahead of the 09:00 brief.

WHY THIS RUNS LOCALLY. The 09:00 brief is produced by a Cloudflare Worker (money-confidence-daily, source /Users/kevinbrittain/Projects/leadership-dashboard/scripts/slack-automation/money-daily-worker.js). A Worker cannot dispatch the department agents in ~/.claude/agents/, so the huddle runs here and hands its result to the worker through Airtable. The worker reads today's record via gatherHuddle(); if this task did not run, it decides the day itself and the brief still arrives.

STEPS

0. CHECK THE CLOCK FIRST, before reading anything else. Run `TZ=Europe/London date`. The write is due by 08:50 London, no exceptions, because the worker reads the record at 09:00. This job is scheduled for 05:00 but it can start late if the Mac was asleep or a longer job ran ahead of it, so size the huddle to the time you actually have:

   - Before 07:30: full huddle. Up to seven departments.
   - 07:30 to 08:15: reduced huddle. Three departments only: dept-strategy plus the two whose lane the nearest deadline sits in.
   - After 08:15: no departments at all. Read the tasks yourself, write the digest from the task data, commit the write. A plain record that lands beats a board-quality one that lands at 09:05.
   - Whatever size you picked, if it reaches 08:45 and some departments have not reported, synthesise from the ones that have and write. Never hold the write for a slow agent.

   Say in your closing log which size you ran and why, so a pattern of late starts is visible rather than hidden.

0b. THE OPENING CLOCK READ HAS NO SHELF LIFE. **This Mac sleeps mid-run.** On 3 Aug 2026 this job fired correctly at 06:10:06 and its first `date` agreed to within five seconds. The Mac then slept, and the next tool call read 09:26. The 09:00 worker had written and delivered the brief inside that gap. Nothing was wrong with the clock; over three hours of real time passed between two steps.

   So: **re-run `TZ=Europe/London date` immediately before the write in step 4, and re-size from THAT reading, not the one in step 0.** Check it again after any long fan-out (parallel department agents, a browser pass) returns. If the second reading has crossed a band boundary, drop to the smaller huddle rather than pressing on with the plan you made at the start. Never assume the gap between two steps was small.

1. Run the huddle. Follow ~/.claude/skills/huddle/SKILL.md. Convene ONLY the departments with live work, not all eleven. Default weekday set: dept-strategy, dept-marketing, dept-sales, dept-systemisation, dept-operations. Add dept-finance on Mondays and at month end. Add dept-legal-compliance when a contract, deadline or compliance date is live. Add dept-productivity or dept-mindset when the day's data suggests overload. Dispatch them in PARALLEL, one Agent call each, and give each the current 11 Operations Director tasks plus the standing targets.

2. Ground them in the truth before they speak. Read 00 AI Context/Decisions/2026-07-29 Launch reset — targets, sequencing and who builds.md. Then read the 11 top-level Operations Director tasks in Airtable base appnqjDpqDniH3IRl, table Tasks tblqB8b22hKBL4PF1. Detail is held as a checklist in each Description. PAT at ~/.config/od/airtable_pat, never print it. A stale plan line is not current state: verify before generating any task for Kevin.

   **Use this query exactly. Two earlier phrasings of this step produced a silent zero.**

   ```bash
   PAT=$(cat ~/.config/od/airtable_pat)
   curl -s -G -H "Authorization: Bearer $PAT" \
     "https://api.airtable.com/v0/appnqjDpqDniH3IRl/tblqB8b22hKBL4PF1" \
     --data-urlencode 'filterByFormula=AND(REGEX_MATCH({Task Name},"^[0-9]+\\. "),{Business}="Operations Director")' \
     --data-urlencode 'fields[]=Task Name' --data-urlencode 'fields[]=Status' \
     --data-urlencode 'fields[]=Due Date' --data-urlencode 'fields[]=Description' \
     --data-urlencode 'maxRecords=40'
   ```

   - **The primary field is `Task Name`, not `Name`.** `{Name}` is not a field on this table. Filtering on it matches nothing and returns 200 OK with an empty list.
   - **Linked-record fields compare by DISPLAY NAME, not record ID.** `{Business}="Operations Director"` works. `FIND("reca9ofzhuw13ZzGE", ARRAYJOIN({Business}))` returns zero rows every time, because ARRAYJOIN on a link field yields the linked record's primary field, never its ID. The record ID reca9ofzhuw13ZzGE is correct for Operations Director and is fine for a direct GET, it just cannot be matched this way. This contradicts the general "filter linked records by record ID" line in the repo CLAUDE.md, which holds for lookup and rollup fields, not for ARRAYJOIN over a link field.
   - **CONTROL, and it is not optional.** This query must return **12** records: the 11 board tasks plus task 12, which was folded into task 6 on 30 Jul 2026 and is marked Completed. **Fewer than 11 means the query is broken, not that the board emptied.** Say so in the log and read the tasks another way before running the huddle. Never let a zero pass as "no live work": a broken filter and a finished launch look identical from here, and a huddle grounded in nothing will confidently invent the day.

3. Synthesise ONE digest, never eleven reports: the one thing today, the tiny first step (about ten minutes), and at most TWO department flags. Anything a worker agent can do gets dispatched, not reported to Kevin. Remember the delegation order: AI first, then Mica or Ericamae, then Kevin and only for founder decisions, approvals, credentials, payments, signatures and physical actions.

3b. Check the agent approval queue and the accuracy scores. Run `python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/agent-accuracy-report.py`. Two things come out of it:

   - **Waiting for Kevin.** If anything is sitting in Status `Approval`, that is agent work that has been PREPARED and not sent. Nothing goes out until he says yes, so a queue that is building up is a real blocker, not a nicety. If the count is 3 or more, that is worth one Board Flag.
   - **Recommendations.** If an agent has cleared the bar (20 decisions of that task type, 90%+, no rejections in the last 10) the script prints a recommendation line. Put it in Board Flags VERBATIM, and never reword it into an announcement. It is a recommendation to Kevin and nothing has changed. Kevin decides whether an agent runs that task type without the gate. Nothing ever auto-promotes: the owner moves the gears, accuracy only advises.

   If the script errors, say so in one line and carry on. It is a report, not a gate.

4. Write it to Airtable. Table CEO Briefs tblIxbzDSOCI5hqJn. Use FIELD IDS, not names, because a rename would silently drop the write:
   - fldzLwBd3Mjg7rDxM Date = today's Europe/London date, YYYY-MM-DD
   - fldQDCAcd74Bb6mpY One Thing = max 250 characters
   - fld4O4EuxHzMWARV7 First Step = max 250 characters
   - fldS7ZoGAS7sAJfJq Board Flags = one flag per line, "Surname: one line"
   LEAVE Full Brief (fldPkiaWvmYAoyHEl) EMPTY. The worker keys on it: populated means the worker already ran and it will ignore your huddle. It also tells the ceo-brief-morning-check task whether the 09:00 brief actually fired.
   If a record already exists for today, PATCH it. Only POST when there is none. Two records for one day breaks the CEO Brief tab's read of the latest.

   **Look today's record up like this. `{Date}="2026-08-06"` on a date field silently returns zero even when the record is sitting there, and a zero here makes you POST the duplicate this step exists to prevent:**

   ```bash
   TODAY=$(TZ=Europe/London date +%F)
   PAT=$(cat ~/.config/od/airtable_pat)
   curl -s -G -H "Authorization: Bearer $PAT" \
     "https://api.airtable.com/v0/appnqjDpqDniH3IRl/tblIxbzDSOCI5hqJn" \
     --data-urlencode "filterByFormula=DATESTR({Date})=\"$TODAY\"" \
     --data-urlencode 'maxRecords=5'
   ```

   Sanity-check a zero before trusting it: re-run with no filter, sorted by Date descending, and look at the newest record. If a record for today is there, your filter is wrong. Do not POST.

4b. IF THE WORKER HAS ALREADY RUN (Full Brief populated when you reach step 4), the brief has been written AND delivered to Kevin. Do not overwrite One Thing, First Step or Board Flags: he has already read them, and the CEO Brief tab plus `ceo-brief-morning-check` both key on that record. **But do not just stop, either.** Kevin's standing instruction (3 Aug 2026): a huddle that missed the brief is still worth having, because the board's read on the day does not expire at 09:00. Take the LATE PATH:

   a. Run the huddle anyway, sized by the clock per step 0 (after 08:15 that means no departments, digest from task data alone).
   b. Deliver it to Kevin DIRECTLY by Slack DM, not to Airtable. Open with one line naming what happened, for example: "Late huddle. The 09:00 brief already went out, so this did not go into it." Then the one thing, the first step and at most two flags, same shape as always.
   c. Leave the CEO Briefs record completely untouched.
   d. Log the elapsed time and the cause, so a pattern is visible.

   The point of the late path is that Kevin gets the board's view of the day either way. Only the delivery channel changes.

5. Verify. Re-read the record, confirm the three fields are populated and Full Brief is empty. If the write failed, log it and stop. Do not retry blindly into a duplicate. On the late path (4b) there is nothing to verify in Airtable: confirm instead that the Slack DM actually sent, and say so.

6. Say NOTHING to Kevin. This is plumbing; he sees the result at 09:00. Message him only if the huddle found something genuinely urgent that cannot wait 90 minutes, and then one short plain-English line.

RULES. Direct, spartan, UK English, no em dashes, plain enough for a 13-year-old. Never print secrets. Workers stay guardrailed per ~/.claude/agents/GUARDRAILS.md. If the Mac was asleep and this fires late, still write the record: a huddle at 08:50 beats none, and the worker takes whatever is there at 09:00. Step 0 tells you how to shrink the huddle to fit, and step 0b says to re-check the clock before the write because this Mac sleeps mid-run. If it fires AFTER the worker has already run (Full Brief populated), never overwrite the brief fields — take the LATE PATH in step 4b: run the huddle anyway and Slack-DM it to Kevin instead.

A record left over from a previous day's run is NOT today's huddle. If today's record already has One Thing, First Step or Board Flags filled in, check them against the tasks before you keep any of it. On 31 Jul 2026 the record was pre-written the afternoon before and carried a flag saying the contract was still at old terms, which had been disproved that same morning.