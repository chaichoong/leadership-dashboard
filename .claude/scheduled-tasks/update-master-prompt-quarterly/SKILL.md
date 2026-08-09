---
name: update-master-prompt-quarterly
description: ABSORBED into daily-ops (8 Aug 2026) as phase 6b, which runs it on 1 Jan/Apr/Jul/Oct. Still propose-only. Do not re-enable separately.
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
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/findings.py add --routine update-master-prompt-quarterly --severity high \
  --title "short summary" --where "js/config.js:42" \
  --detail "what is wrong and how you know" \
  --fix "what you would change" --touches-code
```

Severity is `critical`, `high`, `medium` or `low`. Be honest: `critical` means
money, data or production is broken right now.

Filing a finding IS your fix. Do not apologise for not fixing it, and do not
describe it as blocked. The queue is the route.


Run the quarterly master-prompt review for Kevin Brittain in PROPOSE-ONLY mode. Do not edit any file that governs Claude behaviour.

Invoke the `update-master-prompt` skill at /Users/kevinbrittain/.claude/skills/update-master-prompt/SKILL.md and follow it, with this override: run Phases 1 to 4 only, then stop before applying anything.

Concretely:
1. Read the current master prompt at /Users/kevinbrittain/.claude/CLAUDE.md.
2. Gather ground-truth from three sources: (a) the AI Brain in Google Drive folder "00 AI Context" (id 1hVU7zauAdS8JDCIXQYyrg4HvMXEu9BAn) via the Google Drive MCP — read the identity folder, the last 2-4 weeks of Daily notes, and recent Decisions; (b) the Claude memory files at /Users/kevinbrittain/.claude/projects/-Users-kevinbrittain-Projects-leadership-dashboard/memory/ (read MEMORY.md then the relevant files); (c) recent git log in /Users/kevinbrittain/Projects/leadership-dashboard.
3. Diff each section of the master prompt against ground-truth. Classify every candidate change as STALE, INACCURATE, MISSING, or SENSITIVE, each with a one-line rationale and its source.
4. Apply the sensitive-matter rule: never put a sensitive specific (names, case numbers, creditor names, health) into the master prompt; surface it separately as Kevin's decision, with at most an abstracted option.

Then:
- Write the grouped proposals to /Users/kevinbrittain/.claude/skills/update-master-prompt/reports/ with filename YYYY-Qn-proposals.md (create the reports directory if needed; work out the current quarter from today's date).
- Do NOT edit /Users/kevinbrittain/.claude/CLAUDE.md.
- Send Kevin a short notification that the quarterly master-prompt review is ready, with the report path, so he can approve changes in an interactive session.

Keep everything UK English, no em dashes, no semicolons, spartan and factual.