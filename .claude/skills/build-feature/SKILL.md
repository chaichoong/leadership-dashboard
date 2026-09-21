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

## THE HARD RULE: read-only until the Phase 2d gate

From the start of this workflow until Kevin approves at the Phase 2d gate, you are **read-only**.

You MAY: read files, grep, run read-only Airtable queries, read git history, load a page in the browser to look at it.

You MAY NOT: create, edit or delete any file, write to Airtable, send anything, commit, push, or deploy.

This is the reason the brief is worth writing. Kevin gets to change the plan while changing it is still free. If you catch yourself thinking "I will just quickly try it and see", that is the rule doing its job. Stop and finish the plan.

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
- Read CLAUDE.md for conventions, `STRUCTURE.md` for file locations, `.claude/rules/frontend.md` for the file-ownership table and front-end rules, and `.claude/rules/design-system.md` for design tokens
- Read `js/config.js` for existing field maps and table IDs
- Check memory files for project state and preferences
- Look at git history for recent changes and patterns
- Read the most similar existing feature's code

**Cite what you read.** Every factual claim in the Background carries its source: a code fact carries `file:line`, a data fact carries the record ID or the filter formula. Anything you could not verify is written as `ASSUMPTION:` in plain sight, so Kevin can shoot it down at the gate. Never state a field name, table ID, record count or status value you have not actually read. This project's worst bugs all started as a plausible guess.

### 0c. Ask targeted questions (maximum one round)

Use AskUserQuestion to fill remaining gaps. Batch into a single call (max 4 questions). Only ask where the answer materially changes the output.

**If Background is thin:** What exists already? What prompted this?
**If Instruction is ambiguous:** What is the single most important outcome?
**If Limitations are missing:** What must not change? Any scope boundaries?
**If Deliverable is vague:** What format? How will you judge whether this is done?

Skip questions you can answer from context. One round maximum. Work with what you have.

### 0d. Draft the BILD prompt (do not present it yet)

Format:

```
## B — Background
[Context. 2-5 sentences.]

## I — Instruction
[The task. 1-2 sentences, imperative voice. Priority stated if multi-part.]
Fork: [the genuine alternative you considered] — recommend [choice], because [reason].

## L — Limitations
- [Constraint 1]
- [Constraint 2]

## D — Deliverable
- [Output with success criteria]
- [How to verify it works]
```

Include the Fork line whenever the change is structural: a new tab, a new page, an architecture decision, a workflow redesign or a data model change. One sentence, no essay. If Kevin says go ahead, do not raise it again.

**Do not ask for approval yet.** Hold the draft brief. Kevin approves it once, together with the implementation plan, at the single gate in Phase 2d. Two approval stops for one build is one too many, and a brief approved before the code has been read is a brief approved on guesswork.

Proceed to Phase 1.

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

- **File scope** — which file(s) will this touch? (check the file table in `.claude/rules/frontend.md`)
- **Shared dependencies** — does this need new entries in `config.js`, `shared.js`, or `index.html`?
- **Existing patterns** — is there a similar feature already built that this should mirror?
- **Airtable field names** — get EXACT field names (including capitalisation and spaces). Read `js/config.js` for existing field maps. If new fields are needed, confirm them before coding.

### 1d. Draft the plan summary (do not present it yet)

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

**Do not ask yet.** Hold this summary alongside the brief. Both go to Kevin at the single gate in Phase 2d, once the code has actually been read and the plan is real rather than intended.

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

### 2d. THE ONE GATE (the only place this workflow stops)

Everything above was read-only research. Now show Kevin the whole thing in one message and ask once.

```
## B — Background
[Context with sources. 2-5 sentences.]

## I — Instruction
[The task. 1-2 sentences, imperative voice. Priority stated if multi-part.]
Fork: [alternative considered] — recommend [choice], because [reason].

## L — Limitations
- [Constraint 1]
- [Constraint 2]

## D — Deliverable
- [Output with success criteria]
- [How to verify it works]

## Steps
1. [file] — [change, anchored to what you read]
2. [file] — [change]

Not touching: [files and areas that stay untouched]
Verified by: [the checks that prove it works]

## Assumptions  (omit if none)
- ASSUMPTION: [anything you could not verify]

GOAL
[One sentence: the end state]
Checks
1. [check] - proved by [a test exit code / the deploy poll printing the new pageVer / a page read or screenshot of the live page / an Airtable record read back by id]
2. [check] - proved by [...]
Not touching: [the same list as above]
```

The GOAL block is built from D and "Verified by". Each check is a numbered line of its own that names its proof. Never "works" or "looks right". Never put the close-out or a Kevin decision inside it. An optional last line may be a paste-ready `/goal ... or stop after 20 turns` for a long run. Format and rules: `~/.claude/skills/goal-line/SKILL.md`. A hook prints this rule when `/build-feature` is typed, and a Stop hook refuses "done" until the GOAL CHECK in Phase 10d answers every check.

Three rules for the Steps block:

- **Each step names a real file you have already read**, with the line you are anchoring to where possible. A step you cannot anchor is a step you have not researched.
- **"Not touching" is compulsory.** Naming what stays untouched is how Kevin spots a build about to sprawl, and it is the half of scope that constraints alone never capture.
- **Verification is stated before the build, not invented after it.** If you cannot say how it will be proved, the deliverable is not testable yet, so sharpen D.

Ask once: "Should I build this as-is, or adjust anything?"

The read-only rule lifts on Kevin's yes. **The first thing in the reply after his yes is the GOAL block, re-posted** (amended if his answer changed it), so the goal the build is checked against sits on screen at the start of the work.

The brief and the steps become the instruction set for the rest of this workflow. If reality contradicts a step once you start building, say so in one line and carry on. Do not silently build something else.

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

### 3b. Mandatory patterns and 3c. code quality gates

Read `references/build-patterns.md` before you write the first line of code. Every feature MUST include every pattern in it (data, render, action, state persistence, accessibility, health and monitoring, integration), and the code must pass its quality gates as you write.

---

## Phase 4: SELF-AUDIT (before showing Kevin anything)

This is the step that eliminates most rework. After writing all the code, audit your own work:

Read `references/self-audit.md` now: logic (4a), integration (4b), design tokens (4c), cross-feature regression (4d), performance (4e) and security (4f). Report every item as pass, fixed or N/A before you show Kevin anything.

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

Read `references/verify.md` now. Run the dev server test (6a), the edge cases (6b) and the visual check (6c), then produce the screenshot walkthrough (6d). The walkthrough is MANDATORY: the feature is not done until it is shared with Kevin.

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

### 8c. Independent review gate (blocking — iterate until approved)

This is a hard gate, not a self-check. Get a fresh, independent perspective on the changed code and do not proceed to deploy until it comes back clean.

1. Run an independent review of the diff. Use the `/code-review` skill, or spawn a fresh reviewer subagent (Agent tool, `code-reviewer` or `general-purpose`) that has NOT seen the build reasoning, so it reviews the code on its own merits.
2. The reviewer checks for:
   - Logic bugs (off-by-one, wrong operator, missing null check)
   - Style inconsistencies with the rest of the codebase
   - Performance issues (N+1 queries, unnecessary re-renders, missing pagination)
   - Accessibility gaps (missing aria attributes, broken keyboard nav)
   - Runs but does nothing: for a date window, catch-up, backfill, scheduled job or lane sort, tell the reviewer to find the input where it silently does nothing or moves the wrong items, and to say which test covers each case
3. Fix every correctness finding. Then run the review AGAIN on the updated diff.
4. Repeat until the review returns no correctness findings (a clean pass). Only then continue to the next step.
5. If the reviewer and you disagree on a finding, surface it to Kevin rather than silently overriding it.

Do not deploy on an unreviewed or failing diff. The independent approval is what lets the agent verify its own work instead of Kevin hand-checking every change.

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

Read `references/pre-deploy.md` now. Run and report pass/fail for every item in it, one line each. Block deployment if any current-stack item fails.

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

GOAL CHECK
[The end state from the GOAL, repeated]
1. [check] - PASS [proof visible in this conversation]
2. [check] - FAIL [why]
Goal met? Yes | No
```

The GOAL CHECK is compulsory. It answers every numbered check from the GOAL block posted at the gate. Run any check you have not run yet so its output is on screen first. `Goal met? Yes` only when every check is PASS. An honest FAIL goes out with `Goal met? No` and becomes an Outstanding item in the close-out. It sits above any CLOSE-OUT block.

Include a screenshot if the feature is visual.

---

## Quick reference: common mistakes to avoid

The table of common mistakes and how to prevent each one is in `references/common-mistakes.md`. Read it while planning (Phase 1 and 2) and again during the Phase 4 self-audit.
