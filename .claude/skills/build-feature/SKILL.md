---
name: build-feature
description: End-to-end workflow for building or extending a feature on the Operations Director Platform. Reduces iteration loops by front-loading requirements, planning, and verification into a single structured pass. Use this whenever Kevin asks to build something new, add a tab, extend an existing feature, create a new page, or do any non-trivial implementation work on the dashboard. Also use when Kevin says "build", "create", "add", "implement", "wire up", or describes a feature he wants.
---

# Build Feature — Zero-Rework Workflow

A structured build process that front-loads every decision and check so features ship right on the first pass. Kevin provides conversational input. Claude restructures it, plans it, builds it, tests it, and deploys it. One command, fully working result.

## Why this workflow exists

Building features iteratively — code a bit, show Kevin, fix, repeat — burns tokens and time. Most rework comes from:
1. **Vague requirements** from conversational input (no clear deliverable or constraints)
2. **Missing requirements** discovered mid-build (field names, business rules, edge cases)
3. **Forgetting platform conventions** (tokens.css, health bar, sidebar wiring, config.js entries)
4. **Not testing thoroughly** before declaring done (stale cache, empty states, mobile layout)
5. **Self-introduced bugs** from the fix itself (badge mismatches, filter logic, double-submit)
6. **Skipping the quality pipeline** (no simplify pass, no test coverage check, no pre-deploy checklist)

This workflow eliminates those by making every step explicit.

---

## Phase 0: BILD PROMPT (restructure Kevin's input)

Kevin talks conversationally. Before doing anything else, restructure his input into a precise BILD prompt. This eliminates the #1 source of rework: misunderstanding what to build.

### 0a. Parse what Kevin gave you

Map every piece of information to one of four sections:
- **B (Background):** role, domain, current state, what exists already
- **I (Instruction):** the actual task, stated as a direct command
- **L (Limitations):** constraints, files not to touch, tone/audience, scope boundaries
- **D (Deliverable):** what "done" looks like, format, success criteria

Note which sections are thin or empty.

### 0b. Fill gaps from available context

Before asking Kevin questions, check what you can answer yourself:
- Read CLAUDE.md for conventions, file architecture, design tokens
- Read `js/config.js` for existing field maps and table IDs
- Check memory files for project state and preferences
- Look at git history for recent changes and patterns
- Read the most similar existing feature's code

### 0c. Ask targeted questions (maximum one round)

Use AskUserQuestion to fill remaining gaps. Batch into a single call (max 4 questions). Only ask where the answer materially changes the output.

**If Background is thin:** What exists already? What prompted this?
**If Instruction is ambiguous:** What is the single most important outcome?
**If Limitations are missing:** What must not change? Any scope boundaries?
**If Deliverable is vague:** What format? How will you judge whether this is done?

Skip questions you can answer from context. One round maximum. Work with what you have.

### 0d. Present the BILD prompt

Format:

```
## B — Background
[Context. 2-5 sentences.]

## I — Instruction
[The task. 1-2 sentences, imperative voice. Priority stated if multi-part.]

## L — Limitations
- [Constraint 1]
- [Constraint 2]

## D — Deliverable
- [Output with success criteria]
- [How to verify it works]
```

Ask: "Should I build this as-is, or adjust anything?"

On approval, the BILD prompt becomes the instruction set for the rest of this workflow. Proceed to Phase 1.

---

## Phase 1: CAPTURE (do not write any code yet)

Before touching a single file, build a complete picture. Ask Kevin targeted questions — but batch them into one message, not a drip-feed of follow-ups.

### 1a. Understand the feature

Extract from Kevin's request (or ask if missing):

- **What it does** — the core user action and outcome
- **Where it lives** — new tab, existing tab extension, new iframe page, or OS page
- **Data source** — which Airtable table(s), which fields, any new fields needed
- **Business rules** — filtering logic, status transitions, edge cases, thresholds
- **Who uses it** — Kevin only, or delegated staff too (affects complexity)

### 1b. Get the "done" picture

Kevin often describes what the finished result looks like. Capture:

- **Layout** — cards, table, kanban, dashboard grid, or something else
- **Key metrics/counts** — what numbers appear, how are they calculated
- **Actions** — what buttons exist, what do they do (Airtable write-back? status change? navigation?)
- **Empty state** — what shows when there's no data
- **Interactions** — expand/collapse, filters, search, modals, drawers

### 1c. Identify constraints early

- **File scope** — which file(s) will this touch? (check CLAUDE.md's file table)
- **Shared dependencies** — does this need new entries in `config.js`, `shared.js`, or `index.html`?
- **Existing patterns** — is there a similar feature already built that this should mirror?
- **Airtable field names** — get EXACT field names (including capitalisation and spaces). Read `js/config.js` for existing field maps. If new fields are needed, confirm them before coding.

### 1d. Confirm the plan in one message

Present a short summary back to Kevin:

```
Building: [feature name]
Location: [tab ID / page path]
Files to edit: [list]
Data: [table(s)] → [key fields]
Layout: [description]
Actions: [list]
Health checks: [what sync bar will verify]
```

Wait for Kevin's "yes" or corrections before proceeding. This single confirmation replaces 3-4 mid-build check-ins.

---

## Phase 2: PLAN (still no code)

### 2a. Read existing code first

Before writing anything, read the files you'll modify end-to-end:
- The target JS file (understand current structure, function names, globals used)
- `js/config.js` (existing field maps, table IDs, page registry)
- `index.html` (sidebar structure, tab panel containers — especially OS-INTEGRATION sections)
- The most similar existing feature's JS file (copy proven patterns, not reinvent)

### 2b. Map out every code change

List every change needed, grouped by file:

```
index.html:
  - Sidebar menu item (with health dot)
  - Tab panel container (with data-sync-bar div)

js/config.js:
  - Field constants (F.xxx or new field map)
  - PAGE_REGISTRY entry

js/[feature].js:
  - Data fetch function
  - Render function
  - Action handlers (button clicks, status changes)
  - registerSyncBar + health checks
  - Sidebar badge update

css/styles.css (only if needed):
  - Feature-specific styles using design tokens
```

### 2c. Identify the Airtable contract

Before writing fetch/write code:
- Confirm table IDs exist in `config.js` or add them
- Confirm field names are exact — read them from existing code or ask Kevin
- Note which fields are linked records (need record ID filtering, not ARRAYJOIN)
- Note which fields are computed/formula (read-only)
- Plan pagination if the table could exceed 100 records

---

## Phase 3: BUILD (one complete pass)

Write all the code in a single pass. Don't commit partial work.

### 3a. Order of implementation

Follow this exact order — it prevents dependency issues:

1. **config.js** — add constants, field maps, PAGE_REGISTRY entry
2. **index.html** — sidebar item + tab panel container (respect OS-INTEGRATION markers)
3. **Feature JS file** — data fetch → render → actions → health bar (all in one file)
4. **css/styles.css** — only if feature needs styles beyond what tokens.css provides
5. **shared.js** — only if adding a genuinely shared utility (not feature-specific logic)

### 3b. Mandatory patterns (baked into every feature)

Every feature MUST include all of these. Not "should" — MUST:

**Data layer:**
- [ ] Airtable fetch with pagination (`offset` handling)
- [ ] Error handling on fetch (try/catch, show toast on failure, don't silently fail)
- [ ] Rate-limit handling — catch 429 responses, pause 500ms between bulk writes, exponential backoff on retries (see `reconciliation.js` for the pattern)
- [ ] Filter by Active status where applicable
- [ ] Field name constants from config.js (never hardcode field names in fetch URLs)
- [ ] Prefer shared global arrays (`allTenancies`, `allTransactions`, `allCosts`, etc.) over independent fetches when the data is already loaded by `dashboard.js`. Only make a separate Airtable call if the feature needs data from a table not already cached globally
- [ ] If the feature makes expensive fetches (multiple tables, 100+ records), add IndexedDB caching with TTL — follow the `dashboard.js` pattern: `_idbSet(key, { savedAt: Date.now(), data })`, check age on load, bypass cache on manual refresh

**Render layer:**
- [ ] Loading state shown during fetch (spinner + explainer text if load takes >3s — see `costs.js` pattern)
- [ ] Empty state when no data matches filters
- [ ] All colours from `tokens.css` custom properties (never hardcode hex)
- [ ] All text uses `escHtml()` for any user-supplied data
- [ ] Responsive — works on tablet width (no horizontal scroll below 1024px)
- [ ] Print-friendly — hide non-essential UI in `@media print` if the feature contains data users might print (tables, reports, summaries)

**Action layer:**
- [ ] Confirm before destructive actions (use the branded `confirmDialog` from shared.js)
- [ ] Toast feedback on success/failure (use `showToast` from shared.js)
- [ ] Disable button during async operation (prevent double-submit)
- [ ] Optimistic UI where possible (update display immediately, roll back on error)
- [ ] Undo pattern for reversible destructive actions — sliding toast with "Undo" button, auto-dismiss after 8s (see `costs.js` `pushUndoAction` pattern). Use for: status changes, dismissals, field edits. Don't use for: Airtable record deletion (not reversible)

**State persistence (when the feature needs to remember things across page loads):**
- [ ] Use localStorage for UI state: dismissed items, filter selections, user preferences, chase/stage tracking
- [ ] Namespace all keys with the feature prefix (e.g. `cfv_`, `recon_`) to avoid collisions
- [ ] Handle the "cleared site data" case — if localStorage is empty, the feature should still work (degrade gracefully, re-derive state from Airtable where possible)
- [ ] Consider what happens on a different device — localStorage is per-browser. If the state matters across devices, write it back to Airtable instead

**Accessibility:**
- [ ] `aria-expanded` on expandable/collapsible sections (cards, drawers)
- [ ] `aria-modal="true"` on modal dialogs
- [ ] `aria-live="polite"` on regions that update dynamically (counts, status messages)
- [ ] Keyboard navigation — Escape closes drawers/modals, Enter submits, Tab order is logical
- [ ] Interactive elements have visible focus styles (`:focus-visible`)
- [ ] Icons/emoji used decoratively get `aria-hidden="true"`; meaningful ones get `aria-label`

**Health & monitoring:**
- [ ] `registerSyncBar()` with 5-8 checks (see health-bar skill for check design)
- [ ] `markTabSynced()` called after successful render
- [ ] Sidebar badge (if the feature has a count worth showing)
- [ ] Sidebar health dot wired up
- [ ] Feature integrates with idle auto-refresh — if `loadDashboard()` is called by the idle timer in `shared.js`, does your feature's data update too? If your feature has its own fetch, consider whether it should also refresh on idle return

**Integration:**
- [ ] `tabLabelMap` entry in shared.js (for tab label display)
- [ ] PAGE_REGISTRY entry in config.js (for version tracking)
- [ ] Sidebar menu item in index.html
- [ ] **AI Assistant context** — if the feature exposes data Kevin might ask the AI about, add a context block in `js/ai-assistant.js` so the AI panel can reference it (see existing `ctx.compliancePage`, `ctx.commsPage` patterns)
- [ ] **Iframe communication** (iframe pages only) — `postMessage` status up to parent shell, listen for messages from parent (e.g. `qt:open-new-task-drawer`). Sync bar handles health broadcasting automatically, but feature-specific messages need manual wiring

### 3c. Code quality gates (check as you write)

- No `var` — use `const` / `let`
- No `document.write` or `eval`
- No inline event handlers (`onclick="..."`) — use `addEventListener` or delegated events
- Template literals for HTML generation (not string concatenation)
- Early returns for guard clauses (not deeply nested if/else)

---

## Phase 4: SELF-AUDIT (before showing Kevin anything)

This is the step that eliminates most rework. After writing all the code, audit your own work:

### 4a. Logic audit

- [ ] **Badge/count mismatch** — does the sidebar badge count match what the user sees in the tab? Account for dismissed items, active filters, and pagination.
- [ ] **Filter state persistence** — if the user filters data, does the filter survive a refresh? Does it reset on tab switch? Is that the right behaviour?
- [ ] **Empty state** — what happens if Airtable returns zero records? What if the filter produces zero results from non-zero data?
- [ ] **Stale data** — after an action (status change, dismiss), does the display update immediately? Does it refetch or locally mutate?
- [ ] **Race conditions** — if the user clicks Refresh while a fetch is in progress, what happens? If they click an action button twice fast?

### 4b. Integration audit

- [ ] **Sidebar wiring** — is the menu item's `onclick` calling `switchTab('correct-id')`?
- [ ] **Tab panel** — does the `id="tab-xxx"` match what `switchTab` expects?
- [ ] **Health bar container** — is `data-sync-bar="xxx"` present and matching the `registerSyncBar` call?
- [ ] **Globals** — are all globals you read (e.g. `allTenancies`) actually loaded before your code runs?
- [ ] **OS-INTEGRATION** — did you accidentally modify or delete code between OS-INTEGRATION comment pairs?

### 4c. Design token audit

- [ ] Grep your new code for any hardcoded hex colour (`#[0-9a-fA-F]{3,8}`)
- [ ] Grep for hardcoded font-family declarations
- [ ] Grep for hardcoded pixel values that should use spacing tokens
- [ ] Verify all status colours use semantic tokens (success/warning/danger/info)

### 4d. Cross-feature regression check

When a feature writes back to Airtable (status changes, field updates, record creation), check which other features read that same data:

- [ ] **Dashboard KPIs** — does changing a tenancy status affect rent roll, void count, arrears totals?
- [ ] **Cash flow** — does marking an invoice paid or changing a cost amount affect the forecast?
- [ ] **Reconciliation** — does a transaction status change break the matching logic?
- [ ] **CFV detection** — does a tenancy status change cause a false positive or miss a real CFV?
- [ ] **Sidebar badges** — do counts on OTHER tabs update correctly after your feature's write-back?

If your feature only reads data (no Airtable writes), this check is N/A.

### 4e. Performance check

- [ ] **API call count** — how many Airtable requests does the feature make on initial load? Target: 1-3 calls. If >5, consider whether shared globals can be reused
- [ ] **Payload size** — are you fetching all fields when you only need 3? Use `fields[]` parameter in the Airtable URL to limit the response
- [ ] **Render cost** — if rendering 100+ rows, use a table (not 100 expandable cards). Consider virtual scrolling or "show more" pagination for >200 items
- [ ] **No N+1 queries** — don't fetch related records one-by-one inside a loop. Batch them into a single `filterByFormula=OR(...)` call, or resolve from global arrays

### 4f. Security audit

- [ ] All user-facing text passed through `escHtml()`
- [ ] No raw Airtable field values inserted into innerHTML without escaping
- [ ] API tokens only accessed via `PAT` global (never hardcoded)
- [ ] No `eval()`, no `innerHTML` with unsanitised input

---

## Phase 5: HEALTH BAR (invoke the health-bar skill)

After the code is written and self-audited, wire up the health bar properly. Use the `/health-bar` skill for the full procedure, but at minimum:

1. Read the target JS file and identify all data sources, computations, and automations
2. Design 5-8 checks (mix of `sync` and `automation` kinds)
3. Add `<div data-sync-bar="TAB_ID"></div>` to the tab panel
4. Add sidebar health dot in index.html
5. Write the `registerSyncBar()` call with all checks
6. Call `markTabSynced()` after successful render
7. Test: bar renders, checks pass, Re-run works, Refresh re-syncs, sidebar dot updates

If the health bar was already included during Phase 3 (as it should be for experienced builds), this phase is a verification pass — confirm all 7 items above are working.

---

## Phase 6: VERIFY (prove it works)

### 6a. Dev server test

Start the preview server and test the golden path:
1. Load the page — does it render without console errors?
2. Does data appear (or correct empty state)?
3. Click every action button — do they work?
4. Check the health bar — does it render, do checks pass?
5. Click Refresh in the health bar — does it re-sync?
6. Check sidebar badge — does the count match?

### 6b. Edge case test

- Empty data (no records match)
- Large data (100+ records — does pagination work?)
- Network error (temporarily wrong PAT — does it show an error toast, not crash?)
- Rapid clicks (double-submit prevention)
- Tab switch and return (does state persist correctly?)

### 6c. Visual check

- Screenshot the feature at desktop width
- Check it at 1024px width (tablet)
- Verify colours match the design system (no rogue greys or blues)

### 6d. Screenshot walkthrough evidence (MANDATORY)

Before declaring the feature done, produce screenshot evidence of a full walkthrough. This proves the feature works and gives Kevin a visual record of what was built. Use the preview tools to capture each screenshot.

**Required screenshots (minimum):**

1. **Initial load state** — the feature as it appears when first opened (or empty state if no data)
2. **Data populated** — the feature with real or representative data loaded
3. **Primary interaction** — the main action being performed (e.g. opening a modal, expanding a card, clicking a button)
4. **Action result** — the outcome of the primary action (e.g. record created, status changed, form submitted)
5. **Secondary views** — if the feature has tabs, filters, or alternative views, screenshot at least one
6. **Tablet width** — the feature at 1024px width to verify responsive behaviour

Present all screenshots to Kevin with a brief caption for each. This is not optional. The feature is not done until the walkthrough is shared.

---

## Phase 7: AUDIT (invoke the audit skill)

Run `/audit` on the completed feature. This is a formal second pass that catches things the self-audit missed:

1. Code-level checks + live site testing via Chrome MCP
2. Bug list with severity and root cause
3. Fix each issue found (commit per fix)
4. Re-audit for self-introduced bugs (the audit-of-the-audit)
5. Score readiness out of 100 (Correctness / Error handling / Performance / UX polish / Maintainability)

The feature is not done until the audit score is reported. Target: 80+ before shipping. If below 80, fix the gaps before proceeding.

---

## Phase 8: QUALITY PIPELINE (automated, no user input needed)

Run these checks sequentially after the audit passes. Fix any issues found before proceeding. Do not ask Kevin for permission at each step — run them all, fix as you go, report the summary at the end.

### 8a. Simplify pass

Scan all changed code for:
1. Duplicate logic that can be extracted
2. Premature abstractions (interfaces with one implementation, factories with one type)
3. Dead code introduced during the build
4. Over-engineered error handling
5. Functions doing more than one thing
6. Comments that restate what the code says

Fix anything found. Do not ask for approval on simplification — just do it and note what changed.

### 8b. Test gaps

If Vitest is set up in the project:
1. List functions in changed files with no test coverage
2. Identify critical paths and edge cases for each
3. Write tests matching the project's test conventions
4. Prioritise: data writes, business logic, filter/calculation functions, error handling
5. Skip trivial getters and pure UI rendering
6. Run the tests. Fix any failures.

If no test framework exists, skip this step and note it in the final report.

### 8c. Code review

Review all changed files for:
1. Logic bugs (off-by-one, wrong operator, missing null check)
2. Style inconsistencies with the rest of the codebase
3. Performance issues (N+1 queries, unnecessary re-renders, missing pagination)
4. Accessibility gaps (missing aria attributes, broken keyboard nav)

Fix anything found.

### 8d. Security review (always run if the feature touches auth, data writes, or money)

Review changed files for:
1. Secrets in code (keys, tokens, passwords)
2. Missing `escHtml()` on user-supplied or Airtable-sourced text
3. `innerHTML` with unescaped external data
4. API tokens exposed in console logs or error messages
5. Unvalidated user input reaching Airtable writes or LLM prompts
6. Auth bypass paths

Output a numbered list of issues with severity (critical, high, medium, low). Fix all critical and high issues before proceeding.

### 8e. Pre-deploy checklist

Run and report pass/fail for each:

**Current stack (GitHub Pages):**
1. No `console.log` or `debugger` in production code paths
2. HTML passes htmlhint (the PostToolUse hook covers this, but verify)
3. All PAGE_REGISTRY entries correct (pageVer, sopFile, standalone URL)
4. `escHtml()` used on all external data rendered in HTML
5. Design tokens used (no hardcoded colours, fonts, or spacing)
6. `sitemap.xml` updated if new pages added
7. Pre-commit mapping updated in `scripts/pre-commit-action.py` if new pages added
8. Rollback path identified (which commit to revert to if this breaks production)

**Future stack (activate when SaaS migration begins):**
9. Supabase RLS policies on any new tables
10. Supabase migrations run on production
11. Cloudflare Worker env vars documented and set
12. CORS origins set correctly on Workers
13. Rate limiting on public endpoints
14. Error tracking/logging in place for new endpoints

Block deployment if any current-stack item fails. Future-stack items are informational until migration begins.

---

## Phase 9: SOP & SITEMAP

Every new page or significant feature extension needs its documentation and registry updated.

### 8a. Create or update the SOP

- **New page/tab**: Create a new SOP file (e.g. `sop-[feature].html`) using the `/sop-generator` skill or by copying the structure from an existing SOP like `sop-cfvs.html`
- **Extension of existing page**: Update the existing SOP file to cover the new functionality
- SOP must import `css/tokens.css` (correct relative path) for design consistency
- SOP should cover: purpose, data sources, key actions, troubleshooting, and the health bar checks
- Set `sopVer` in PAGE_REGISTRY to match `pageVer` once the SOP is current

### 8b. Update PAGE_REGISTRY

Ensure the entry in `js/config.js` has:
- Correct `sopFile` path pointing to the SOP HTML file
- `sopVer` set to match `pageVer` (since both are current as of this build)
- `standalone` URL for direct access

### 8c. Update sitemap.xml

Add the new page and its SOP to `sitemap.xml`:
```xml
<url><loc>https://chaichoong.github.io/leadership-dashboard/[page-path]</loc></url>
<url><loc>https://chaichoong.github.io/leadership-dashboard/[sop-path]</loc></url>
```

### 8d. Update robots.txt (if needed)

Only if the new page should be excluded from crawling.

### 8e. Update pre-commit mapping

Add the new file-to-page mapping in `scripts/pre-commit-action.py` so that the auto-bump workflow knows which PAGE_REGISTRY entry to bump when the file changes.

---

## Phase 10: SHIP

### 10a. Commit

- One logical commit per feature (not micro-commits per file)
- Commit message: `<Feature name>: <what it does>` (match existing style from `git log`)
- Include all files changed in the commit (feature code + SOP + sitemap + config)

### 10b. Deploy

```bash
git pull --rebase origin main && git push origin main
```

Then verify the deploy is live (pageVer matches, hard reload).

### 10c. Live test

After deploy is confirmed live, run `/test` against the deployed site. This creates real test data, exercises the feature through the browser, verifies backend state, and cleans up. The feature is not done until `/test` passes.

Skip `/test` only if:
- The feature is purely informational (read-only display with no actions or backend writes)
- Kevin explicitly says to skip testing

### 10d. Report to Kevin

Short summary:

```
Done: [Feature name]
Files changed: [list]
What it does: [2-3 sentences]
Health checks: [count] checks registered
Audit score: XX/100
Test result: [PASS/FAIL]
SOP: [created/updated] at [path]
Live at: [URL if applicable]
```

Include a screenshot if the feature is visual.

---

## Quick reference: common mistakes to avoid

| Mistake | Prevention |
|---------|-----------|
| Wrong Airtable field name (capitalisation/spaces) | Always read from config.js or confirm with Kevin |
| Badge shows raw count, not filtered count | Badge logic must match the rendered/visible items |
| Hardcoded colour | Grep for `#` in your new code |
| Missing health bar | It's in the checklist — don't skip it |
| Missing empty state | Test with zero records |
| Missing loading state | Show spinner/skeleton before fetch resolves |
| Double-submit on buttons | Disable button, re-enable after async completes |
| Stale display after action | Locally mutate or refetch + rerender |
| Missing escHtml on user data | Grep for `innerHTML` assignments, verify all have escHtml |
| Forgot PAGE_REGISTRY entry | Auto-bump won't work without it |
| Forgot tabLabelMap entry | Tab label will show raw ID instead of human name |
| Broke OS-INTEGRATION section | Read index.html first, mark those sections as untouchable |
| Airtable 429 rate limit on bulk writes | 500ms pause between requests, exponential backoff on retry |
| N+1 query pattern (fetch in a loop) | Batch into single `filterByFormula=OR(...)` or resolve from globals |
| Redundant Airtable fetch when global array exists | Check if `allTenancies`, `allTransactions`, etc. already have the data |
| localStorage collision with another feature | Namespace all keys with feature prefix (`cfv_`, `recon_`, `inv_`) |
| Feature write-back breaks another tab's counts | Run cross-feature regression check (Phase 4d) |
| No undo on destructive actions | Add sliding undo toast for dismiss/status-change/field-edit |
| Missing accessibility (no keyboard nav) | Escape closes, Enter submits, aria-expanded on collapsibles |
| AI assistant can't answer questions about new feature | Add context block in `ai-assistant.js` |
| Forgot SOP / sitemap update | Phase 8 — it's not done until the SOP exists |
