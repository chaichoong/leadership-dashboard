---
name: test
description: Live end-to-end testing against the deployed site. Creates real test data, exercises features through the browser, verifies results in both UI and backend (Airtable, Gmail, Slack), cleans up all test data, and reports pass/fail with evidence. Use after deploying a feature or fix to prove it works in production.
---

# Test -- Live End-to-End Verification

Runs real tests against the live deployed site. Creates test data, exercises features through the UI, verifies backend state, cleans up, and reports results. This is not a code review or a diff check. This is proof that the feature works in production.

## When to use

- After `/build-feature` deploys a new feature
- After `/fix` deploys a bug fix
- When Kevin says "test this", "prove it works", "run a test"
- As the final step in the quality pipeline before declaring done
- When re-testing something that was previously broken

## Input

The skill accepts a description of what to test:

- `/test` -- auto-detects from recent git changes and the current page context
- `/test inbound comms label 13 maintenance flow` -- tests a specific feature
- `/test the badge counts on contractor tasks` -- tests a specific element

---

## Phase 1: UNDERSTAND WHAT TO TEST

### 1a. Identify the feature

From the input (or auto-detect from `git diff HEAD~1 HEAD`):
- What feature or fix was deployed?
- Which page/tab does it affect?
- What are the key user actions to exercise?
- What backend systems are involved (Airtable tables, Gmail labels, Slack channels)?

### 1b. Design the test sequence

Before touching the browser, write out the full test plan:

```
Feature: [name]
Page: [URL]

Test 1: [action] -> [expected result]
Test 2: [action] -> [expected result]
...

Cleanup: [what to restore/delete after testing]
```

Rules for test design:
- Test the golden path first (the primary use case)
- Test at least one edge case (empty data, duplicate, rapid action)
- Test the integration point (does the backend update correctly?)
- Every test must have a concrete expected result, not "it should work"
- Plan cleanup from the start. Know what test data you will create and how to remove it

### 1c. Identify test data needed

For each test, determine:
- What data needs to exist before the test? (existing records, labels, states)
- What data will the test create? (new records, label changes, status updates)
- What is the original state that must be restored after testing?

Use throwaway data wherever possible. Never test with production data that cannot be restored. Good test subjects:
- Promotional/junk emails for Gmail label tests
- Tasks with obvious test names ("TEST -- delete me") for Airtable tests
- Non-critical records that can be safely created and deleted

---

## Phase 2: PREPARE

### 2a. Establish browser connection

Before anything else, connect to Chrome MCP. If the first `tabs_context_mcp` call fails:
1. Retry up to 3 times with a short pause between attempts
2. If Chrome MCP still fails, fall back to preview tools (`preview_start`, `preview_eval`, `preview_snapshot`, `preview_screenshot`) to run the tests
3. Only ask Kevin to check Chrome is open as an absolute last resort after all retries and fallbacks are exhausted
4. NEVER ask Kevin to test manually or "check it yourself". Testing is always Claude's job. A connection failure is Claude's problem to solve.

### 2b. Confirm deploy is live

Before testing, verify the latest code is deployed:

```bash
git log --oneline -1
```

Check that the live site reflects the changes (use Chrome MCP to navigate and verify).

### 2c. Record the starting state

Before creating any test data, document the current state of everything you will touch:
- Record IDs of existing items
- Current label assignments
- Current counts/badges
- Screenshot of the starting state

This is your restoration target. If anything goes wrong, you revert to this state.

### 2d. Authenticate

If the feature requires authentication (Airtable, Gmail, Slack):
1. Navigate to the page in Chrome MCP
2. Check if already signed in
3. If not, ask Kevin to sign in (do NOT enter credentials yourself)

---

## Phase 3: EXECUTE TESTS

Run each test in sequence. For each test:

### 3a. Perform the action

Use Chrome MCP browser tools to interact with the live site:
- Navigate to the correct page/tab
- Perform the user action (click buttons, select dropdowns, submit forms)
- Wait for the action to complete (watch for toasts, loading indicators, page updates)

### 3b. Verify the UI result

After each action:
1. Take a screenshot showing the result
2. Check for success/error toasts
3. Verify counts, badges, and visible data updated correctly
4. Check the browser console for errors (`read_console_messages` with `onlyErrors: true`)

### 3c. Verify the backend result

After each action that should affect the backend:
1. Query Airtable directly (use the page's own API functions via `javascript_tool`)
2. Check Gmail labels (use GAPI client via `javascript_tool`)
3. Verify the backend state matches expectations

### 3d. Record the result

For each test, record:
```
Test N: [description]
Action: [what was done]
UI result: [PASS/FAIL] -- [what was seen]
Backend result: [PASS/FAIL] -- [what was verified]
Evidence: [screenshot ID, API response summary]
```

### 3e. Handle failures

If a test fails:
1. Record the failure with full evidence (screenshot, console errors, API response)
2. Continue with remaining tests (do not stop on first failure)
3. Note whether the failure is blocking (feature broken) or minor (cosmetic, edge case)

---

## Phase 4: CLEANUP

### 4a. Restore original state

After all tests complete, restore everything to the starting state documented in Phase 2b:

1. Delete any Airtable records created during testing
2. Remove any Gmail labels applied during testing
3. Restore emails to their original labels
4. Revert any status changes made during testing

### 4b. Verify cleanup

After restoration:
1. Query the backend to confirm test data is deleted
2. Refresh the page and verify counts/badges match the pre-test state
3. Take a final screenshot confirming clean state

### 4c. Cleanup failure handling

If cleanup fails (API error, record not found):
1. Log the failure with the record ID and what needs manual cleanup
2. Tell Kevin exactly what needs manual cleanup and where
3. Do not leave test data behind silently

---

## Phase 5: REPORT

Output the report in this format:

```
## Test Report: [feature name]

### Test environment
- URL: [deployed URL]
- Commit: [hash]
- Date: [timestamp]

### Results

| # | Test | UI | Backend | Result |
|---|------|----|---------|--------|
| 1 | [description] | PASS | PASS | PASS |
| 2 | [description] | PASS | FAIL | FAIL |

### Details

**Test 1: [description]**
- Action: [what was done]
- Expected: [what should happen]
- Actual: [what happened]
- Evidence: [screenshot, API response]

**Test 2: [description]**
...

### Cleanup
- [PASS] All test data removed
- [PASS] Original state restored

### Overall: PASS / FAIL
[If FAIL: list exactly what is broken and what needs fixing]
```

Rules for the report:
- Every result must have evidence (screenshot, API response, console output)
- "It works" is not evidence. "Toast showed 'Task created for Mica', Airtable record recXYZ created with status Today and assignee Mica" is evidence
- Failed cleanup is a FAIL regardless of test results
- Include screenshot evidence for at least the first and last test

---

## What this skill does NOT do

- Does not fix issues found during testing. Reports only.
- Does not test in a staging environment (there is no staging; tests run against production).
- Does not perform load testing or performance benchmarks.
- Does not modify code. If tests fail, Kevin decides the next step.
- Does not skip cleanup. Test data must always be removed.
