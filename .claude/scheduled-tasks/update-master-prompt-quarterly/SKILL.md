---
name: update-master-prompt-quarterly
description: Quarterly propose-only review of the global master prompt against the AI Brain, memory, and live systems.
---

## QUEUE AND WRITE POLICY (added 6 Aug 2026 — do this before anything else)

On 6 Aug 2026 ten routines woke together after the Mac slept and all ran between
08:07 and 08:33. They produced nine commits in twenty-eight minutes and left the
working tree dirty across four unrelated features. Two rules came out of it, and
they override anything below that contradicts them.

### Rule 1 — take the queue lock first

```
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/job-queue.py acquire update-master-prompt-quarterly --lease 45
```

- exit **0** — you hold the machine. Carry on.
- exit **3** — you are too late for this work to be useful. STOP. Do nothing else.
- exit **75** — another routine holds the machine. STOP. Do nothing else.

Never continue past a non-zero exit code. Running anyway is precisely the
behaviour this replaces. Release it as your last step, success or failure:

```
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/job-queue.py release update-master-prompt-quarterly
```

If your run will take longer than 45 minutes, extend the lease as you go:
`python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/job-queue.py heartbeat update-master-prompt-quarterly --lease 45`.

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