---
name: test-gaps
description: Find untested code paths in changed files and generate Vitest tests. Prioritises data writes, business logic, and error handling. Use after implementing a feature or fix. Also called automatically by /build-feature and /fix workflows.
---

# Test Gaps — Find and Fill

Identify functions in changed files that lack test coverage, then write tests for the most important ones.

---

## Step 1: Identify what changed

```bash
git diff --name-only HEAD~1 HEAD
```

If there are unstaged changes, also check:
```bash
git diff --name-only
```

Filter to JS files only. Read each changed file and list every function defined or modified.

## Step 2: Check existing coverage

Look for test files matching the changed files:
- `tests/[filename].test.js`
- `tests/[filename].spec.js`
- `__tests__/[filename].test.js`

For each function identified in Step 1, check if a test exists that exercises it.

## Step 3: Prioritise gaps

Rank untested functions by risk:

**High priority (must test):**
- Functions that write to Airtable (create, update, delete records)
- Functions that calculate financial values (rent, arrears, costs, forecasts)
- Filter/query logic (what gets included or excluded)
- Business rule enforcement (status transitions, thresholds, validations)
- Error handling paths (what happens when API calls fail)

**Medium priority (should test):**
- Data transformation functions (parsing, formatting, mapping)
- Sort and group logic
- Badge/count calculations

**Low priority (skip unless time permits):**
- Pure render functions (HTML template generation)
- Event handler wiring
- UI state toggles (show/hide, expand/collapse)

## Step 4: Write tests

For each high-priority gap:

1. Write a Vitest test file at `tests/[filename].test.js`
2. Import the function (if the codebase uses modules) or set up the global scope (if plain script tags)
3. Write tests covering:
   - The happy path (expected input, expected output)
   - Edge cases (empty input, null values, missing fields)
   - The specific bug scenario (if this was triggered by /fix)
4. Use descriptive test names: `"calculates rent arrears correctly when tenant has partial payment"`
5. Keep tests independent (no shared mutable state between tests)

### Test style for this project

The project uses plain `<script>` tags with global functions. To test these:

```js
// tests/shared.test.js
import { describe, it, expect } from 'vitest';

// For global functions, import the source file or recreate the function
// Since the project uses globals, we may need to extract testable functions

describe('escHtml', () => {
  it('escapes angle brackets', () => {
    // Copy or import the function
    const escHtml = (s) => { /* from shared.js */ };
    expect(escHtml('<script>')).toBe('&lt;script&gt;');
  });
});
```

As the project evolves toward modules, tests will import directly. For now, focus on testing pure functions that can be extracted.

## Step 5: Run tests

```bash
npx vitest run
```

Fix any failures. Report results.

## Output format

```
## Test Gap Report

### Changed files
- [file list]

### Functions found: [count]
### Already tested: [count]
### Tests written: [count]

### High priority gaps covered:
- [function] — [test file:line]

### Remaining gaps (lower priority):
- [function] — [reason skipped]

### Test results: [X passed, Y failed]
```
