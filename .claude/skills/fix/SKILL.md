---
name: fix
description: End-to-end workflow for fixing bugs, errors, feedback, amendments, and tweaks to existing features. Rewrites conversational input into a focused BILD prompt, diagnoses, fixes, runs the quality pipeline, deploys, and verifies. Use when Kevin reports a bug, error, regression, or wants an amendment to something that already exists. Also use when Kevin says "fix", "broken", "not working", "wrong", "change this", "update this", "tweak", or describes a problem with existing functionality.
---

# Fix — Zero-Rework Bug & Amendment Workflow

Kevin describes a problem or amendment conversationally. Claude restructures it, diagnoses root cause, fixes it, runs the quality pipeline, deploys, and verifies. One command, fully working result.

---

## Phase 1: BILD PROMPT (restructure Kevin's input)

Kevin talks conversationally about the problem. Before touching any code, restructure his input into a focused BILD prompt.

### 1a. Parse what Kevin gave you

Map every piece of information to:
- **B (Background):** which feature/page, what was working before, what changed
- **I (Instruction):** what needs fixing, stated as a direct command
- **L (Limitations):** files to touch (and not touch), scope of fix, do not change unrelated behaviour
- **D (Deliverable):** what "fixed" looks like, how to verify

### 1b. Fill gaps from context

Before asking Kevin:
- Read the relevant JS file and surrounding code
- Check browser console for errors (if preview tools available)
- Read git log for recent changes that may have caused the issue
- Check CLAUDE.md for file ownership and conventions

### 1c. Ask targeted questions (only if essential)

Most bug fixes do not need questions. The bug report plus the code gives you enough. Only ask if:
- The problem description is genuinely ambiguous (two plausible interpretations)
- You need to confirm intended behaviour vs current behaviour
- The fix has two valid approaches with different trade-offs

Maximum one round, maximum 2 questions. If in doubt, diagnose first and confirm with Kevin before applying the fix.

### 1d. Present the BILD prompt

Format:

```
## B — Background
[Which feature, what the current state is. 2-3 sentences.]

## I — Instruction
[What to fix. 1 sentence, imperative voice.]

## L — Limitations
- [File scope]
- [Do not change unrelated behaviour]

## D — Deliverable
- [What "fixed" looks like]
- [How to verify]
```

For straightforward bugs (clear error message, obvious root cause), skip presenting the BILD prompt and proceed directly to diagnosis. State what you found and what you are fixing. Kevin does not need to approve a plan for a clear bug fix.

For ambiguous problems or amendments that change behaviour, present the BILD prompt and ask: "Should I fix this as described, or adjust?"

---

## Phase 2: DIAGNOSE

### 2a. Reproduce the problem

Before writing any fix:
1. Read the relevant source file(s) end-to-end
2. If a UI issue: load the page in the browser, navigate to the affected area, check the console for errors
3. If a data issue: check what Airtable returns (read the fetch logic, check filter formulas)
4. If a recent regression: run `git log --oneline -10` and `git diff HEAD~3 HEAD -- [file]` to see what changed

### 2b. Rank possible root causes

Before writing any code, list the top 3 possible root causes ranked by likelihood. For each, state how you would confirm it is the actual cause:

```
1. [Most likely cause] — Confirm by: [specific check: console log, DOM inspection, network request, git diff, variable value]
2. [Second most likely] — Confirm by: [specific check]
3. [Third most likely] — Confirm by: [specific check]
```

Then run the confirmation checks. Do not guess. Gather evidence: read the console, inspect the DOM via Chrome MCP, check network requests, read variable values, or add temporary logging.

State the confirmed root cause in one sentence with the evidence that proves it. "The filter in line 142 excludes dismissed items but the badge count on line 87 includes them — confirmed by DOM inspection showing 3 visible rows but badge reads 5" is a confirmed root cause. "Something is wrong with the badge" is not.

### 2c. Assess blast radius

Before fixing:
- Which other features read/write the same data?
- Does this file export globals that other files depend on?
- If changing a shared file (config.js, shared.js), grep for all usages of what you are modifying

---

## Phase 3: FIX

### 3a. Make the minimum change

Fix the root cause. Do not refactor surrounding code, add features, or "improve while you're in there." The fix should be as small and focused as possible.

### 3b. Check your own fix

Before moving to the quality pipeline:
1. Re-read every line you changed
2. Verify field names match between read and write paths
3. Check that your fix does not introduce a new bug (badge/count mismatch, filter logic error, missing null check)
4. If you changed a function signature, grep for all callers

---

## Phase 4: QUALITY PIPELINE

Run these sequentially. Fix issues as you find them. Do not ask Kevin at each step.

### 4a. Verify (browser test)

1. Load the page in the browser
2. Navigate to the affected feature
3. Test the specific fix: does the reported problem no longer occur?
4. Check the browser console for errors or warnings
5. Test one related interaction (if the fix touched a filter, check that the filter still works for other cases)
6. Regression check: does any other visible feature on the same tab look broken?

If the fix does not work, go back to Phase 2. Do not proceed with a broken fix.

### 4b. Simplify pass

Scan only the changed code for:
1. Unnecessary complexity introduced by the fix
2. Dead code (old logic that the fix made unreachable)
3. Duplicate logic

Fix anything found.

### 4c. Test gaps

If Vitest is set up:
1. Check if the fixed function has a test
2. If not, write one that covers the bug scenario (the test should fail without the fix and pass with it)
3. Run the tests

If no test framework, skip and note it.

### 4d. Independent review gate (blocking for anything beyond a cosmetic change)

Get a fresh perspective on the diff before shipping. Skip only for pure CSS/copy tweaks.

1. Run `/code-review` on the diff, or spawn a fresh reviewer subagent (Agent tool) that has not seen the fix reasoning.
2. Fix every correctness finding, then re-run the review on the updated diff.
3. Repeat until the review returns a clean pass. Do not deploy on a failing or unreviewed diff.
4. If you disagree with a finding, surface it to Kevin rather than overriding it silently.

Keep this proportional: a one-line null-check fix needs a quick review pass, not a ceremony. A multi-file behaviour change needs a real one.

### 4e. Pre-deploy checklist

Quick pass (not the full build-feature checklist):
1. No `console.log` or `debugger` left in changed code
2. `escHtml()` used on any external data in changed code
3. Design tokens used (no hardcoded colours in changed code)
4. No secrets or PAT tokens exposed

---

## Phase 5: SHIP

### 5a. Commit

- One commit per fix
- Message format: `Fix: [what was broken and what was fixed]`
- Match existing commit style from `git log`

### 5b. Deploy

For small fixes (single file, clear bug):
```bash
git pull --rebase origin main && git push origin main
```

For larger amendments (multi-file, behaviour change):
Work on a branch, push, create a PR.

Then verify the deploy is live (hard reload, check the fix in the browser).

### 5c. Live test (if the fix is testable end-to-end)

After deploy is confirmed live, run `/test` against the deployed site to prove the fix works in production. This creates real test data, exercises the fix through the browser, verifies backend state, and cleans up.

Skip `/test` only if:
- The fix is purely cosmetic (CSS-only change with no logic)
- The fix cannot be exercised without specific data conditions that do not currently exist
- Kevin explicitly says to skip testing

### 5d. Report to Kevin

Short summary:

```
Fixed: [what was broken]
Root cause: [one sentence]
Files changed: [list]
Verified: [what was tested in browser]
Test result: [PASS/FAIL or SKIPPED with reason]
Live at: [URL]
```

Include a screenshot if the fix is visual.

---

## Quick reference: common fix mistakes

| Mistake | Prevention |
|---------|-----------|
| Fix works but breaks something else | Always regression-check the same tab |
| Fix addresses symptom, not root cause | State root cause before coding |
| Fix is correct but in the wrong file | Check CLAUDE.md file ownership table |
| Scope creep during fix (refactoring, adding features) | Minimum change only |
| Field name mismatch between read and write | Verify exact names in config.js |
| Badge/count mismatch after fix | Check both badge logic and render logic |
| Forgot to test empty state after fix | What if the fix changes filter results to zero? |
| Console.log left in from debugging | Pre-deploy checklist catches this |
