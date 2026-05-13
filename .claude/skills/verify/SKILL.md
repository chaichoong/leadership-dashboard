---
name: verify
description: Post-fix QA check — reads the git diff, tests the specific fix in the browser, checks for console errors and regressions, reports pass/fail with screenshot evidence. Use after any bug fix or small change to prove it actually works before committing.
---

# Verify — Post-Fix QA

Lightweight verification that a fix actually works. Treats every change as unproven until browser evidence confirms it. Target: 30-60 seconds, not a full audit.

## When to use

- After fixing a bug (before committing)
- After a small UI change or tweak
- After refactoring logic that affects what the user sees
- Any time Claude says "done" and you want proof

## Input

The skill accepts an optional argument describing what to focus on:

- `/verify` — auto-detects from git diff
- `/verify badge count on CFV tab` — focuses verification on a specific thing

---

## Step 1: Understand what changed

Read the git diff to identify exactly what was modified.

```bash
git diff HEAD
```

If there are no unstaged changes, check the last commit:

```bash
git diff HEAD~1 HEAD
```

From the diff, extract:
- **Which file(s)** changed
- **Which function(s)** were modified
- **What the change does** in plain English (e.g. "fixed the filter that was excluding dismissed items from the badge count")

If the user provided a description with `/verify`, use that as the primary focus. The diff provides supporting context.

Write down a one-line summary of the change. This becomes the report header.

---

## Step 2: Identify what to test

From the diff and the optional description, determine:

1. **The fix itself** — what specific behaviour should now be correct? Frame this as a testable assertion (e.g. "the badge should show 3 when there are 3 unresolved CFVs" or "clicking Dismiss should remove the row from the table").

2. **The most likely regressions** — look at what the change touched:
   - If a shared function was modified → check 1-2 other callers of that function
   - If a filter/query was changed → check that other items are not incorrectly included or excluded
   - If a render function was changed → check that the layout did not break for empty state or full state
   - If `config.js` or `shared.js` was touched → check that other tabs still load
   - If CSS was changed → check that other elements using the same class/token still look right

Limit regression checks to the 1-2 most probable breakages. This is not a full audit.

---

## Step 3: Test in the browser

Use the preview tools (`preview_*`) to verify. If the preview server is not running, start it.

### 3a. Load the page

1. Navigate to the affected tab or page
2. Wait for data to load (check for loading spinners to clear)

### 3b. Verify the fix

Test the specific assertion from Step 2. Collect evidence:

- **Visual check**: Use `preview_snapshot` to read the DOM content. Does the element exist? Does it show the right value?
- **Console check**: Use `preview_console_logs` to look for JavaScript errors. Filter for `error|Error|TypeError|ReferenceError|undefined`.
- **Interaction check**: If the fix involves a button or action, use `preview_click` or `preview_fill` to trigger it, then `preview_snapshot` again to confirm the result.
- **Network check**: If the fix involves an API call, use `preview_network` to confirm the request was made and returned successfully.

Record PASS or FAIL for the fix, with the specific evidence.

### 3c. Check regressions

For each regression target identified in Step 2:

1. Navigate to the affected area (switch tab, scroll to element)
2. Use `preview_snapshot` to confirm it still renders correctly
3. Check console for new errors that were not there before

Record PASS or FAIL for each regression check.

### 3d. Console sweep

Run a final `preview_console_logs` check across the page. Look for:
- Any new errors introduced by the change
- Warnings that indicate a problem (not general deprecation noise)

If the page loaded without errors before the change and has errors now, that is a FAIL regardless of whether the fix itself works.

---

## Step 4: Screenshot evidence

Every fix must include at least one saved screenshot as proof. Kevin must be able to see the change without opening the browser himself.

### CRITICAL: Screenshot visibility rules

Screenshots taken via Chrome MCP (`mcp__Claude_in_Chrome__computer screenshot`) and preview tools (`preview_screenshot`) appear in tool results but are **NOT visible to the user in the chat UI**. Only `mcp__computer-use__screenshot` with `save_to_disk: true` produces images that Kevin can actually see.

**Mandatory process for user-visible screenshots:**

1. Commit and push the changes to GitHub Pages first.
2. Wait for the deploy to complete (use the deploy monitor or poll GitHub Actions).
3. Use computer-use MCP (`mcp__computer-use__screenshot` with `save_to_disk: true`) to capture the **live deployed site** in Chrome. This is the only method that attaches images visibly in the chat.
4. Before capturing, ensure the correct page/tab is visible in Chrome: use `request_access` for Chrome, `switch_display` if Chrome is on a secondary monitor, and visually confirm via a non-saved screenshot that the right content is on screen.

**Do NOT rely on Chrome MCP or preview tool screenshots for the verify report.** Those are useful for Claude's own verification during Steps 2-3 but they are invisible to Kevin. The final report screenshots must come from computer-use.

### 4a. Capture the fix

For each fix verified in Step 3, take a screenshot showing the result:

1. Ensure the deployed version is live and matches the changes (check pageVer or visual confirmation)
2. Navigate Chrome to the affected tab or page on the live site
3. If the fix is small (a badge, a label, a button), use `zoom` on the relevant region first to get a clear close-up
4. Take a screenshot with `mcp__computer-use__screenshot` and `save_to_disk: true`
5. If the fix spans multiple views (e.g. a badge that appears on Kanban, Task List, and drill-downs), capture one screenshot per view where the change is visible

### 4b. What to capture

- **Visual fixes** (UI change, layout fix, badge count, styling): Screenshot showing the element in its new state. Zoom in if the change is small.
- **Interaction fixes** (button behaviour, drawer open/close, toast messages): Screenshot showing the result after the interaction (e.g. the toast visible, the drawer closed, the modal gone).
- **Data fixes** (counts, filters, calculations): Screenshot showing the correct value with enough context to confirm it is right (e.g. badge shows 3, and the table below has 3 rows).
- **Non-visual fixes** (logic change, API call): If there is genuinely nothing to see in the UI, the snapshot/console/network evidence from Step 3 is sufficient. But if the fix affects what the user sees in any way, a screenshot is required.

### 4c. When a fix cannot be shown live

If the fix cannot be demonstrated because the data conditions are not present (e.g. 0 unreconciled transactions, no error state to trigger), state this explicitly in the report. Confirm the code change is deployed via curl or source inspection, and explain what the user will see when the conditions next occur.

---

## Step 5: Report

Output the report in this exact format:

```
## Verify: [one-line summary of the change]

### What changed
- [file]: [summary of change]

### Fix verification
- [PASS/FAIL] [what was tested] — [evidence]
  [saved screenshot attached if visual]

### Regression check
- [PASS/FAIL] [related feature checked] — [evidence]
- [PASS/FAIL] [related feature checked] — [evidence]

### Console
- [CLEAN / list of errors found]

### Screenshots
[Attach all saved screenshots here. For each one, add a one-line caption describing what it shows.]

### Result: PASS / FAIL
[If FAIL: what is still broken and where to look]
```

Rules for the report:
- Every PASS or FAIL must have evidence (a specific value seen, a screenshot, a console output, or a DOM element reference)
- "It looks correct" is not evidence. "Badge shows 3, matching 3 unresolved records in the table below" is evidence.
- Every visual fix must have at least one saved screenshot attached via `mcp__computer-use__screenshot` (the only method visible to Kevin). If the fix spans multiple views, include one screenshot per view.
- If a fix cannot be shown live due to data conditions, state why and confirm the code is deployed.
- If FAIL, state exactly what is wrong and which file/function to investigate. Do not attempt to fix it.
- Keep the report short. No scoring, no readiness percentages, no recommendations beyond the failure description.

---

## What this skill does NOT do

- **Does not fix issues.** Reports only. Kevin decides the next step.
- **Does not audit the whole page.** Use `/audit` for that.
- **Does not deploy.** This runs before commit/push.
- **Does not score readiness.** Pass or fail, with evidence. That is all.
