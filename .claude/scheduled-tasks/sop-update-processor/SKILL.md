---
name: sop-update-processor
description: PAUSED 30 Jul 2026 — SOPs are being replaced by visual workflows (task 3). Regenerator must not overwrite the new content. Delete once every page has a workflow.
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
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/findings.py add --routine sop-update-processor --severity high \
  --title "short summary" --where "js/config.js:42" \
  --detail "what is wrong and how you know" \
  --fix "what you would change" --touches-code
```

Severity is `critical`, `high`, `medium` or `low`. Be honest: `critical` means
money, data or production is broken right now.

Filing a finding IS your fix. Do not apologise for not fixing it, and do not
describe it as blocked. The queue is the route.


Process pending SOP update requests from the Operations Hub Site Map.

## Step 1: Check for pending requests
Read the SOP Update Requests table (tbltuZz5Omrpo7t1x) in Airtable base appnqjDpqDniH3IRl.
Field IDs: Request=fld0ShElHxR10mmBk, SOP File=fldLvshpipHswyudX, Page Version=fldidv94zf8kd0ApG, Status=fldt4Y6lunSdEF0jX, Page ID=fldsrBokVDBz1ZneD

Filter for records where Status = "Pending". If none found, exit silently.

## Step 2: For each pending request

### 2a. Set status
Update the Airtable record Status to "Processing".

### 2b. Identify source files
Use the Page ID from the request to determine which source files to read.
The repo is at: /tmp/ld-fresh/ (clone from https://github.com/chaichoong/leadership-dashboard.git if missing).
Run `git pull` to ensure you have the latest code.

File-to-page mapping:
| Page ID    | Primary source file         | Also read                              |
|------------|----------------------------|-----------------------------------------|
| overview   | js/dashboard.js            | js/config.js, js/shared.js, index.html  |
| cfv        | js/cfv.js                  | js/config.js, js/shared.js, index.html  |
| invoices   | js/invoices.js             | js/config.js, js/shared.js, index.html  |
| pnl        | js/pnl.js                  | js/config.js, js/shared.js, index.html  |
| fintable   | js/fintable.js             | js/config.js, js/shared.js, index.html  |
| sitemap    | js/sitemap.js              | js/config.js, js/shared.js, index.html  |
| comms      | follow-up.html             | (self-contained)                        |
| compliance | compliance.html            | (self-contained)                        |
| tasks      | os/tasks/index.html        | (self-contained)                        |
| os-hub     | os/index.html              | (self-contained)                        |
| os-bplan   | os/business-plan-builder/index.html | (self-contained)                |

### 2c. Systematic code analysis
Read ALL source files for this page. Extract the following systematically — DO NOT skip any:

**Functions:** List every function name, what it does, and what triggers it.
**Buttons & actions:** Find every onclick, every button element — document what each one does, what API calls it makes, and what status changes result.
**API calls:** Every fetch() to Airtable — which table, which fields, PATCH/GET/POST, what it writes.
**Status transitions:** Map every possible state change (e.g. "In Payment" → "Potential CFV" → "CFV" → "CFV Actioned" → back to "In Payment"). Document the exact conditions for each transition.
**Field IDs:** Cross-reference with js/config.js to get human-readable field names for every field ID used.
**Constants & thresholds:** Tolerance days, chase stages, budget targets, etc.
**localStorage usage:** What keys are stored, what they control, when they expire.
**User-facing features:** Export buttons, print functions, comment systems, badges, indicators.
**Error handling:** What happens when things fail — what messages does the user see?

### 2d. Read the existing SOP
Read the existing SOP file from the repo: /tmp/ld-fresh/[sop-filename]
Note which sections exist and what they currently say.

### 2e. Read the CSS template
Read the FIRST 106 lines of: /tmp/ld-fresh/sop-pnl.html
This contains the complete CSS. Copy it VERBATIM as the <style> block of the new SOP.

### 2f. Gap analysis
Compare the code analysis (step 2c) against the existing SOP content (step 2d).
Identify:
- Features in the code NOT documented in the SOP
- SOP descriptions that no longer match the code
- Workflows described in the SOP that have been changed or removed
- Missing button explanations, missing status transitions, missing error scenarios

### 2g. Write the new SOP
Generate a complete standalone HTML file using these EXACT patterns:

**Required structure (in order):**
1. `<!DOCTYPE html>` + `<head>` with CSS from step 2e
2. `.header` — gradient header with title, subtitle, version, and "Back to Site Map" link
3. `.quick-ref` — quick reference grid with: Access URL, Data Source, Key Tables, Owner, Refresh, Version
4. `.toc` — table of contents linking to all sections (use `.toc-grid` for layout)
5. **Sections** (each wrapped in `.section` with `.section-title`):
   - Overview & Purpose
   - How to Access / Getting Started
   - Feature walkthrough (one section per major feature — be specific)
   - Data fields & table reference (use `.label-table`)
   - Workflow diagrams (use `.flow` → `.flow-step` → `.flow-arrow` chains)
   - Status transitions & lifecycle
   - Action buttons reference (use `.label-table` — every button, what it does, when to use it)
   - Comments / audit trail (if applicable)
   - Export & reporting (if applicable)
   - Troubleshooting (use `.ts-item` → `.ts-problem` / `.ts-solution`)
   - Changelog

**HTML components to use:**
- `.card` + `.card-header` for grouped info
- `.wf-card` + `.wf-num` + `.wf-header` + `.wf-body` for numbered workflows
- `.steps` (ordered list with counter) for step-by-step instructions
- `.info-box.info` / `.info-box.warn` / `.info-box.danger` / `.info-box.tip` for callouts
- `.flow` + `.flow-step` + `.flow-arrow` for process diagrams
- `.label-table` for data reference tables
- `.label-badge` (`.lb-blue`, `.lb-green`, `.lb-amber`, `.lb-red`) for status badges
- `.grid-2` for two-column layouts
- `<code>` for field names, function names, technical references

**Content rules:**
- Every button visible on the page MUST be documented with its exact label and what it does
- Every status badge/colour MUST be listed with its meaning
- Every workflow MUST have a flow diagram showing the full lifecycle
- Every Airtable field referenced MUST be named (human-readable name, not just field ID)
- Use plain English suitable for a client who has never seen the system before
- Include "What happens when..." scenarios (payment comes in, button is clicked, error occurs)
- Include exact thresholds and tolerance values from the code
- The SOP must be self-contained — a reader should be able to operate the system using ONLY this document

**Accuracy rules — CRITICAL:**
- NEVER describe features that don't exist in the code
- NEVER use placeholder text or generic descriptions
- Every claim in the SOP must be traceable to a specific function or code block
- If the code has a constant (e.g. CFV_TOLERANCE_DAYS = 2), quote the exact value
- If a button calls a specific function, document what that function does step by step
- Test your SOP against the code: read each sentence and verify it matches what the code actually does

### 2h. Update version
Set the version in the SOP header to match the pageVer from PAGE_REGISTRY.
Format: `Version X.Y • DD Mon YYYY • Owner: Kevin Brittain`

### 2i. Save the SOP
Write the file to: /tmp/ld-fresh/[sop-filename]

## Step 3: Deploy to GitHub Pages

> **PAUSED, and blocked by the write policy above.** Steps 3 and 4 commit and push,
> which no routine except `queue-fixer` may do. Before re-enabling this task, move
> its file writes into the findings queue so `queue-fixer` carries them. Do not
> re-enable it as written.

```bash
cd /tmp/ld-fresh && git add [sop-filename] && git commit -m "Auto-update SOP: [filename] to v[version] [auto-bump]" && git push
```
Note: include `[auto-bump]` in the commit message to prevent the pageVer GitHub Action from triggering.

## Step 4: Update PAGE_REGISTRY
In /tmp/ld-fresh/js/config.js, find the PAGE_REGISTRY entry for this page ID and set sopVer to match pageVer.
```bash
cd /tmp/ld-fresh && git add js/config.js && git commit -m "Sync sopVer for [page-id] to [version] [auto-bump]" && git push
```

## Step 5: Mark complete
Update the Airtable record Status to "Completed".

## Important rules
- ALWAYS read the LIVE source code from the git repo — never use cached/stale copies
- ALWAYS run `git pull` before reading source files
- Copy CSS VERBATIM from the template — never modify it
- Use the SAME HTML component patterns listed in step 2g
- The SOP MUST be a complete standalone HTML page that works offline
- Rate limit Airtable: 350ms between API calls
- If any step fails, update Status to "Failed" and log the error
- If git push fails, try `git pull --rebase` first
- NEVER describe features that aren't in the code — accuracy over completeness