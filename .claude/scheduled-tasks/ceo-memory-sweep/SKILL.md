---
name: ceo-memory-sweep
description: ABSORBED into daily-ops (8 Aug 2026) as phase 7.3. Now distils the PREVIOUS day, which is a complete day rather than a part one. Do not re-enable separately.
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
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/findings.py add --routine ceo-memory-sweep --severity high \
  --title "short summary" --where "js/config.js:42" \
  --detail "what is wrong and how you know" \
  --fix "what you would change" --touches-code
```

Severity is `critical`, `high`, `medium` or `low`. Be honest: `critical` means
money, data or production is broken right now.

Filing a finding IS your fix. Do not apologise for not fixing it, and do not
describe it as blocked. The queue is the route.


You are the AI CEO's nightly memory. Your job: make sure NOTHING Kevin discussed with the CEO today gets forgotten. Kevin's rule: "anything I discuss is updated in memory — the issue is things get missed." A conversation that leaves no trace is a system failure.

SOURCES (gather both):
1. Slack CEO conversations: GET "https://contractor-bot.kevinbrittain.workers.dev/ceo-transcript?key=KEY&oldest=TS" where KEY is the contents of ~/.config/od/ceo_transcript_key (never print it) and TS is a unix timestamp 24 hours ago. Returns {messages:[{ts,from,text}]} — 'kevin' vs 'ceo'.
2. Deep sessions: any file in "/Users/kevinbrittain/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/My Drive/00 AI Context/CEO Conversations/" dated today (the /ceo skill writes these; they may already contain distilled decisions — do not duplicate what is already recorded).

PROCESS:
- If Kevin sent no messages today (only the automatic morning brief), write nothing, log "quiet day" and stop.
- Otherwise extract, in Kevin's plain words where possible: (a) DECISIONS and rulings — each becomes a dated entry in "00 AI Context/Decisions/YYYY-MM-DD <short title>.md" following the existing files' format there, and if it changes how future work is done, also update Claude memory at /Users/kevinbrittain/.claude/projects/-Users-kevinbrittain-Projects-leadership-dashboard/memory/ (one-fact files + a MEMORY.md pointer line, matching the existing format); (b) COMMITMENTS (who said they'd do what) — check each has an Airtable task if it needs one (Tasks table tblqB8b22hKBL4PF1, base appnqjDpqDniH3IRl, PAT at ~/.config/od/airtable_pat, never print it); (c) CONCERNS Kevin voiced — noted for the next morning's brief context; (d) CORRECTIONS — if Kevin corrected a fact, fix it in the brain (00 AI Context) immediately.
- Write a short day log to "00 AI Context/CEO Conversations/YYYY-MM-DD Slack.md" (create the folder if missing): 5-15 lines, what was discussed, what was decided, what was extracted where.
- The precedent rule is sacred: a ruling stated once is a standing rule — never leave one un-recorded.
- UK English, plain language, no em dashes. Do not message Kevin; this runs silently. If the transcript endpoint fails, retry once, then log the failure to the same folder so the main session sees it.