# Operations Director Platform — Claude Code Rules

## Stack

**Current:** Vanilla JS, Airtable (API + linked records), GitHub Pages, plain `<script>` tags (no bundler).
**Migration (IN PROGRESS):** Supabase (Postgres + RLS) + Vercel via the parallel shadow build (`supabase-app.html` shell, `*-supabase.html` twins + shims). Airtable remains system of record until per-module cutover. Spec: `docs/supabase-schema-spec.md`.

## THE MASTER PLAN (one plan, always)

`MASTER-PLAN.md` (repo root) is the ONLY plan, roadmap, or launch task list for Operations Director. Rules for every session:

1. Never create a new plan/roadmap/task-list document for OD — in the repo, in Drive, or anywhere else. Amend MASTER-PLAN.md instead.
2. Every amendment is dated and sourced in its Changelog. Tasks are never silently deleted: done stays ticked, dropped is marked `[D]` with a reason.
3. Ideas from learning material (transcripts, mentor calls, KOL content — e.g. via /transcript-to-brain) go into its Proposed Amendments holding pen (the "## Proposed Amendments" section, §13 as of Jul 2026 — find it by heading, not number), never straight into the live checklist. Kevin approves before they lock in.
4. Structural changes to the plan need Kevin's explicit approval.
5. Airtable (project "Launch & First Revenue") is the team's working copy; the plan is canonical. New tasks flow plan → Airtable; status flows back at the weekly review.

## File Locations

`STRUCTURE.md` is the single source of truth for where every file lives: repo folders, the AI context layer (CLAUDE.md, memory, skills), and Google Drive. Read it before creating any file. If you add a file in a location it does not cover, update STRUCTURE.md in the same commit. Code is ONLY edited in this repo; copies found in Google Drive are stale exports.

## Data Lookups

Never guess an entity attribute — property location, tenancy status, cost status, model ID, record count, table or field name. Query the source of truth first (Airtable via curl, or the constant in `js/config.js`) and cite the record or line you read. If you cannot find it, say so. An inferred value presented as a fact is worse than "I don't know", because it gets acted on.

- **Every number in a report needs a source.** State the field or formula it came from and a sample record proving the derivation. Flag anything inferred rather than read.
- **Airtable access:** the `airtable` MCP connector is broken (auth error). Use curl with the PAT at `~/.config/od/airtable_pat` — never print the token. Base `appnqjDpqDniH3IRl`.
- **Match on the right field.** Costs use the LEGACY `Payment Status`, not `Cost Status`. Filtering the wrong status field has produced confidently wrong impact stories before.
- **A skill's own learning log is evidence, not proof.** Verify its claims against the table before acting on them.

## Standard Workflow

Two commands cover all work. Kevin talks conversationally after either one. Claude handles the full pipeline.

- **`/build-feature`** — for anything new: new tab, new page, new OS, new feature, significant extension of an existing feature. Rewrites Kevin's input into a BILD prompt, plans, gets approval, builds, runs the full quality pipeline (simplify, test-gaps, review, security-review if auth/data/money, pre-deploy), deploys, verifies live.
- **`/fix`** — for bugs, errors, feedback, amendments, tweaks to existing work. Rewrites Kevin's input into a focused BILD prompt, diagnoses, fixes, runs the quality pipeline (verify, simplify, test-gaps, pre-deploy), deploys, verifies live.

Both skills run start-to-finish. Kevin approves the plan once, then receives a working, deployed result. No manual skill-chaining needed.

## Forbidden Patterns

These patterns cause production bugs. Never introduce them:

- `console.log` or `debugger` left in production code paths
- Inline SQL or Airtable formulas without parameterisation
- `catch` blocks that swallow errors silently (must log or toast)
- `TODO` / `FIXME` comments without a linked issue or concrete next action
- Secrets, API keys, or PAT tokens hardcoded anywhere (use env vars or runtime auth)
- Hardcoded AI model IDs in feature files (use `AI_MODEL_DEFAULT` / `AI_MODEL_LIGHT` from `js/config.js`; a retired ID is an app-wide AI outage)
- `eval()`, `document.write()`, or `Function()` constructor
- `innerHTML` with unescaped external data (use `escHtml()`)

## Known Anti-Patterns (bugs we have hit before)

These have caused production bugs in this codebase. Check for them during every build, fix, and audit.

- **Missing typecast on PATCH calls** — Airtable number fields must receive a Number, not a string. Always wrap with `Number()` before sending: `fields: { [F.amount]: Number(value) }`
- **renderTasks vs renderAll stale-state** — after an inline edit, status change, or filter change, call the full list re-render function (e.g. `renderAll()`), not just the single-item updater. Partial re-renders leave badges, counts, and visible rows out of sync
- **returnFieldsByFieldId returning IDs not names** — when using `returnFieldsByFieldId=true` in Airtable API calls, field keys in the response are field IDs (e.g. `fldXyz123`), not human-readable names. If your code expects `rec.fields['Amount']` but gets `rec.fields['fldXyz123']`, every field read silently returns undefined. Match the approach used by the rest of the codebase (this project uses field names via the `F` constants in config.js, not raw field IDs)
- **CSS overflow truncation** — long tenant names, property addresses, and note text clip without ellipsis or wrapping. Use `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` on single-line cells, or `word-break: break-word` on multi-line content
- **localStorage quota issues** — Safari has a 5MB localStorage limit. Large cached datasets (100+ transaction records with all fields) can exceed this. Use IndexedDB for large caches (follow the `dashboard.js` pattern), keep localStorage for small UI state only
- **Airtable blank fields pass `!= 0` but fail `> 0`** — in an Airtable formula an empty number/currency field is NOT equal to 0, so `{blank} != 0` is TRUE while `{blank} > 0` is FALSE. Swapping `> 0` for `!= 0` to allow negatives makes every blank-field record take the wrong branch. This blanked `Report Amount` on 8,667 of 8,690 transactions in Jul 2026, taking out the P&L, dashboard, wealth and cashflow at once. To test "is this signed value set and non-zero" while keeping the blank fall-through, use **`ABS({field}) > 0`**. Whenever you change a formula condition, check it against a blank record, not just a populated one
- **Split Override Amount must carry the sign of `**GBP`** — the split modal collects positive magnitudes (`totalRaw` uses `Math.abs`, validation requires every portion `> 0`), but Airtable's `Report Amount` returns the override verbatim. Writing a positive override on an expense flips an outflow into revenue across every report. Always multiply the portion by the sign of `**GBP` before writing (see `performReconSplit` in `js/reconciliation.js`). Inflow splits hid this for years because their sign is already positive — the first expense split would have posted £1,742.60 of costs as income
- **A hand-rolled Airtable read must paginate, and a metric graded all-or-nothing must say which part failed** — `refreshReconAccuracyStats()` fetched the AI Recon Audit table with `pageSize=100` and never followed the `offset` token, so the AI Reconciliation Accuracy card measured the FIRST 100 rows and presented that as the score. On 6 Aug 2026 there were 259 rows in the window: the card read "66/100" while the truth was 167/259 = 64%. Nothing errored, and the number looked plausible for a month. The shared `airtableFetch()` helper paginates correctly; this code bypassed it with its own `fetch`, which is exactly how it escaped the existing `pagination-dedup` guard. **Any hand-rolled Airtable read is vulnerable the same way — grep for `fetch(` against `api.airtable.com` before trusting a number.** The same metric was also graded all-or-nothing across seven fields (category, sub-category, business, tenancy, unit, property, cost), so one habitually blank link dragged the headline down while the other six were fine, and the audit row recorded only a yes/no — never which field missed. A score you cannot attribute cannot be acted on. Guarded by `tests/sync-invariants/recon-accuracy-stats.spec.js` (back-tested: reverting the loop makes it report exactly 100)

- **A learning loop that stores what it learned in localStorage is not learning** — the reconciliation knowledge base saved a rule for every correction Kevin made, applied it at top priority, and looked like a working feedback loop. It was not compounding, for three reasons that only showed up in the stored data. (1) The key was the first three words with punctuation deleted and digits kept, so a per-transaction reference became part of the rule's identity: five separate rules existed for one recurring £2 charge (`british a1252236611488` … `492`), and **131 of 238 rules (55%) had fired exactly once**. Strip pure-digit tokens and tokens mixing letters with 3+ digits; two digits is a brand (`v12`, `57a`), three or more is a reference. (2) `findReconRule` returned the FIRST rule whose key appeared in the descriptor, so with 15 overlapping keys the winner depended on insertion order and a generic rule could hijack a specific one — prefer the LONGEST match. (3) The whole base lived in `localStorage`: one browser, one device, one cache clear from zero, which had already destroyed the accuracy log in Apr 2026. **Any store that accumulates value over time belongs in Airtable, and the key it is indexed by must be stable across transactions or nothing ever gets a second hit.** Keep the raw source text on each row: the old key format deleted token boundaries, so the existing keys could not be re-derived and had to be migrated best-effort. Guarded by `tests/recon-vendor-key.test.js` (extracts the real function from source rather than copying it) and `tests/sync-invariants/recon-knowledge-base.spec.js`

- **Never express the day of the week in a Cloudflare cron** — `"0 8 * * 1-5"` reads as Mon–Fri to every human and to standard cron, where Sunday is 0. Cloudflare starts the week at **Sunday = 1**, so `1-5` runs **Sun–Thu**. The CEO brief lost every Friday and gained a Sunday for a week before anyone noticed, because a brief still arrived most mornings and no error was ever raised. Measured via `workersInvocationsAdaptive` for 27 Jul – 3 Aug 2026: zero invocations Sat 1 Aug, a full pair Sun 2 Aug, no 08:00 firing Fri 31 Jul. Set the cron to `* * *` (every day) and decide the day **in the worker**, in the target timezone, with a test. See `isLondonSendTime()` in `scripts/slack-automation/money-daily-worker.js` and `tests/ceo-brief-schedule.test.js`, which also fails if a day-of-week filter reappears in the cron. Applies to the hour too: a scheduled job that must land at a UK local time needs two UTC crons plus a code gate, never one cron and an assumption about BST

## Regression Tests (no bug is fixed until it is caught)

A bug is not fixed when the symptom goes away. It is fixed when a test reproduces it and
passes. Every entry in "Known Anti-Patterns" above is something that shipped, broke
production, got fixed, and came back or nearly did. Add the test in the same commit as the fix.

**Pick the right layer — this is the part that gets it wrong:**

| The bug lives in | Test goes in | Runs |
|---|---|---|
| JS: render, state, filters, PATCH payloads, auth | `tests/sync-invariants/*.spec.js` (Playwright, fixtures) | `npm run test:sync`, pre-push gate |
| Pure functions/helpers | `tests/*.test.js` (vitest) | `npm test` |
| **Airtable: formulas, computed fields, real data shape** | `scripts/check-data-invariants.py` | daily `prod-e2e-sweep` STEP 4.5 |

`tests/sync-invariants/` mocks the Airtable API (`page.route` on `/v0/**`). That keeps the
pre-push gate deterministic, and it means those tests **cannot see an Airtable-side bug** —
they stub out the layer that broke. Both of this platform's worst incidents (the 8,667-txn
`Report Amount` blanking and the split sign-flip) would ship green through the whole fixture
suite. If your bug is in a formula or in the shape of real data, a fixture test is theatre.
Add a live invariant instead.

**Every live invariant needs a control.** A `filterByFormula` with a typo'd field name
returns zero rows and reads as a pass forever. Each invariant declares a `control` formula
matching the population the bug would corrupt; if the control matches nothing, the run FAILS
rather than passing. Back-test a new invariant by evaluating the *broken* formula inline in a
read-only query and confirming it fires — never by writing bad data.

## File Architecture (Split for Concurrent Editing)

The platform has been split from a single monolith into separate files so that **multiple Claude sessions can work on different features at the same time** without overwriting each other.

### Source Files

```
index.html          ← HTML shell only (sidebar, tab containers, no logic)
css/tokens.css      ← Design tokens (colour, typography, spacing) — single source of truth
css/styles.css      ← Main stylesheet (consumes tokens.css)
js/config.js        ← Constants, Table IDs, Field IDs, Budget Targets
js/shared.js        ← Auth, API layer, helpers, UI utilities (expandableCard, switchTab, escHtml)
js/dashboard.js     ← Leadership Dashboard tab (loadDashboard, renderDashboard)
js/cashflow.js      ← Cash flow forecast, balance calculator, UC checks, what-if
js/reconciliation.js ← Reconciliation engine, knowledge base, accuracy tracking
js/invoices.js      ← Invoices tab (fetch, render, match, approve, pay)
js/cfv.js           ← CFV tab (detection, actions, comments)
js/fintable.js      ← Fintable Sync Monitor tab
js/sitemap.js       ← Site Map & Links tab, SOP update requests
js/ai-assistant.js  ← AI chat panel, context gathering, streaming
os/                 ← Operating Systems (separate pages loaded via iframe)
```

### Other Files
- `follow-up.html` — Inbound Comms (standalone, loaded via iframe)
- `compliance.html` — Property Compliance (standalone, loaded via iframe)
- `sop*.html` — SOPs for each page
- `os/business-plan-builder/` — retired from the shell 1 Aug 2026 (no sidebar entry); files kept for the Supabase client product, where Plan Builder remains a toggleable module
- `os/tasks/`, `os/operations/`, `os/strategy/`, `os/systemisation/`, `os/team/` — Operating Systems pages (loaded via iframe; the old os/index.html hub and os/launch-plan.html were removed in the sidebar restructure)
- `sitemap.xml` / `robots.txt` — SEO files (update when adding new pages)

## CRITICAL: Concurrent Session Rules

### The Golden Rule
**Two sessions must NEVER edit the same file at the same time.**

Each session should only edit the file(s) for its feature. Before starting work:
1. Run `git pull` to get the latest code
2. Edit ONLY the file(s) for your feature
3. Commit and push promptly when done

### The Golden Rule is necessary but NOT sufficient — use separate worktrees

File-level ownership does not protect what git actually shares: **HEAD, the index, the stash,
and the working tree**. On 2026-07-16 two sessions in one checkout produced all of the
following, and not one of them is a file collision:

- Session B ran `git stash` and swept Session A's uncommitted fix into a stash it labelled
  "not-mine", then checked out another branch. A's edits vanished from the tree mid-task.
- Session B pushed `main` while A's unpushed commit sat on it — A's commit shipped inside B's
  push, untested by A.
- Session B switched the checkout onto a feature branch, so A's next commit landed on the
  wrong branch. `git push origin main` then reported "Everything up-to-date" while A was
  three commits ahead somewhere else. A only noticed because the push was suspiciously quiet.
- B's dev server held the Playwright port, so A's pre-push test gate failed for a reason that
  had nothing to do with A's code — a false red that invites a `SKIP_SYNC_TESTS=1` bypass.

**Run concurrent sessions in separate git worktrees.** A single checkout cannot be shared.
Do not hand-roll the `git worktree` command — use the script, which also assigns a preview
port and refuses to delete work:

```bash
./scripts/worktree.sh new <topic> [fix|feature|chore]
```

That creates `.claude/worktrees/<topic>` on `<kind>/<topic>`, branched from **origin/main**
(not local main, which in a shared checkout is whatever the last session left behind) and
with **no upstream** until you push — so a bare `git push` can never fire at main.

- `./scripts/worktree.sh list` — every workspace, its preview config, and whether it holds
  unpushed or uncommitted work
- `./scripts/worktree.sh done <topic>` — removes the workspace and branch, but refuses while
  anything would be lost: uncommitted files, commits that exist nowhere else, or a branch not
  yet merged into origin/main. `--force` overrides, and means you accept the loss.

Preview ports come from the existing named configs in `.claude/launch.json`; the script hands
out a different one per workspace and **reserves the first for the main checkout**, so two
servers never share a port. Never edit `launch.json` per session — it is tracked and shared,
so the edit shows up in every worktree.

**The main checkout stays on `main`** for quick fixes, the daily sweep and deploy verification.
Reach for a workspace when the work is multi-file or will run for a while.

If a checkout genuinely must be shared: commit before EVERY context switch, never `git stash`
work you did not write (leave it and say so), and run `git status -sb` before assuming which
branch you are on — especially before reading a quiet "Everything up-to-date" as success.

### Session hygiene — this Mac has 16 GB and 8 cores

Worktrees fix *correctness* under concurrency. They do nothing for *capacity*, and capacity
is a real limit here. On 2026-08-06 six sessions ran at once in one checkout and the machine
became unusable: 25.5 GB of demand squashed into 16 GB of RAM (a 3.9x compression ratio),
9.2 GB of swap, 0.1 GB genuinely free, and a load average of 105 on 8 cores. Nothing had
leaked and nothing was broken. It was simply oversubscribed, which is why no error was ever
raised and why it went unexplained for days.

- **Three concurrent sessions maximum.** Close one before opening a fourth. Each session
  carries its own MCP servers and helper processes on top of its own memory.
- **Kill any preview server you start.** They are parented to the Claude desktop app, not to
  your session, so they outlive it and hold the port for ever. `com.kevinbrittain.mac-guard`
  reaps them hourly, but only once they are 4 hours old with nothing connected.
- **Never assume you are the only test run.** `playwright.config.js` counts concurrent runs
  and divides its 4 workers between them, so a second run drops to 2 and a fourth to 1. Do
  not replace that with a lock: a gate stuck waiting on a dead session's lock is exactly what
  teaches people to reach for `SKIP_SYNC_TESTS=1`.
- **When the Mac feels slow, measure before guessing.** `./scripts/mac-status.sh` prints the
  three numbers that decide it — genuinely free memory, compression ratio, swap. Activity
  Monitor's "memory used" answers none of them, which is why this went undiagnosed.

### Never pass secrets as command-line arguments

MCP servers and CLI tools configured with `--api-key <token>` put that token in the process
table, where any process running as the same user can read it with `ps`. It also lands in
session transcripts on disk. Use a file (`~/.config/od/airtable_pat`) or an env var. Found on
2026-07-16: the Airtable PAT was visible 7 times in `ps` output, passed to an MCP connector
that was broken and unused anyway.

### Which file to edit for each feature

| Feature | Edit this file | DO NOT touch |
|---------|---------------|-------------|
| Leadership Dashboard KPIs | `js/dashboard.js` | Other js/ files |
| Cash flow / balance calculator | `js/cashflow.js` | Other js/ files |
| Reconciliation engine | `js/reconciliation.js` | Other js/ files |
| Invoices | `js/invoices.js` | Other js/ files |
| CFVs | `js/cfv.js` | Other js/ files |
| Fintable monitor | `js/fintable.js` | Other js/ files |
| Site map & links | `js/sitemap.js` | Other js/ files |
| AI assistant | `js/ai-assistant.js` | Other js/ files |
| Styling/CSS | `css/styles.css` | js/ files |
| Sidebar menu items | `index.html` | js/ files |
| Config/constants/field IDs | `js/config.js` | Feature js/ files |
| Shared helpers | `js/shared.js` | Feature js/ files |
| Operating Systems pages | `os/*.html` | index.html, js/ files |
| SOPs | `sop*.html` | index.html, js/ files |

### If you need to change a shared file (config.js, shared.js, index.html, styles.css)
These files are used by ALL features. Only ONE session should edit them at a time. If your feature change requires a config or shared change, make it in the same session — don't leave it for another session.

## Protected Sections

When editing `index.html`, preserve the Operating Systems integration points (the old `<!-- OS-INTEGRATION -->` comment markers were removed in the sidebar restructure; the structures themselves remain protected):
1. **Sidebar** — OS menu items and their health dots
2. **Tab panels** — OS iframe containers (`tab-tasks`, `tab-operations`, `tab-systemisation`, `tab-os-strategy`, `tab-os-team`)
3. **PAGE_REGISTRY** in `js/config.js` — OS entries

Never remove or overwrite these when restructuring the shell.

## Global Variables

All JS files share a global scope (loaded as plain `<script>` tags). Key globals:
- `PAT` — Airtable auth token (set by auth flow)
- `allTransactions`, `allTenancies`, `allTenants`, `allCosts`, `allCategories`, `allSubCategories`, `allBusinesses` — data arrays loaded in `dashboard.js`
- `F`, `TABLES`, `INV`, `REC`, `PS` — field/table/record ID constants in `config.js`
- Helper functions (`getField`, `fmt`, `escHtml`, `expandableCard`, etc.) in `shared.js`

## MANDATORY: Quality Gate (Every Task, No Exceptions)

The user is a non-technical operator. Every task must be delivered working and verified. Do NOT ask the user to check the console, run commands, test manually, or debug. If Claude Code can do it, Claude Code does it.

### Rule: No "Done" Without Proof

Never say a task is complete until you have personally verified it works. "I've made the changes" is not done. "I've verified in the browser that the feature works correctly" is done.

### The Verification Checklist (run EVERY time before declaring done)

**Phase 1: Code Quality (before saving)**
1. Re-read every line you changed. Look for typos, missing brackets, unclosed tags, wrong variable names
2. Check every function you modified still has correct parameters and return values
3. Verify all field names match exactly between read and write paths (this project has been burned by mismatches before)
4. Check for undefined variables, unreachable code, and broken references
5. Ensure no hardcoded colours, fonts, or values that should use design tokens

**Phase 2: Integration Check**
6. Read the surrounding code context. Does your change break any callers or dependencies?
7. If you changed shared.js or config.js, grep for every usage of what you modified across ALL js/ files
8. If you added/removed HTML elements, check that any JS targeting those elements by ID/class still works
9. If you changed data fetching or filtering, verify the filter logic handles edge cases (empty arrays, null fields, missing records)

**Phase 3: Browser Verification (REQUIRED for any UI or JS change)**
10. Start the dev server or use preview tools to load the page in a real browser
11. Navigate to the affected tab/feature and verify it renders correctly
12. Test the primary action (click buttons, open modals, submit forms, expand cards)
13. Check the browser console for errors or warnings. Fix any you find
14. If the change affects counts, badges, or summaries, verify the numbers are correct
15. Check that no other tabs or features are broken by your change (regression check)

**Phase 4: Edge Cases & Robustness**
16. What happens with empty data? (no transactions, no tenants, no records)
17. What happens with malformed data? (null fields, missing linked records)
18. Are loading states handled? (spinners, "no data" messages)
19. Do error paths show user-friendly messages, not raw errors?

**Phase 5: Security & XSS**
20. Any user-supplied or Airtable-sourced text rendered in HTML must use `escHtml()`
21. No `innerHTML` with unescaped external data
22. API keys, PAT tokens must never appear in console logs or error messages

**Phase 6: UX/UI Polish**
23. Text is readable, not clipped, not overflowing
24. Buttons and interactive elements are clearly clickable
25. Mobile/responsive: if the feature should work on smaller screens, check it
26. Colours use design tokens from tokens.css

### When You Find Issues During Verification

Fix them immediately. Do not report "I found 3 issues" and wait for the user to ask you to fix them. Fix first, then report what you found and fixed.

### Regression Protocol

After any change to a shared file (config.js, shared.js, index.html, styles.css):
- Load the Leadership Dashboard tab and verify it renders
- Spot-check at least one other tab that uses the shared code
- Check the browser console across tabs for new errors

### The "No Handoff" Rule

Do NOT ask the user to:
- Check the browser console
- Run any terminal commands
- Test something manually
- Look up field names or IDs
- Debug error messages
- Clear cache or hard-reload

If any of these are needed, do them yourself. The user's role is to describe what they want and review the working result.

## Deployment

The git repo IS the source of truth. Edit files directly here.
- GitHub Pages URL: https://chaichoong.github.io/leadership-dashboard/
- Push to `main` branch → auto-deploys in 2-3 minutes
- Always `git pull` before starting work, and push promptly after committing

### MANDATORY: Confirm Deploy is Live

After every `git push origin main`, you MUST:
1. Push the code
2. Poll the GitHub Pages deployment until it completes (use the deploy monitor script or check the GitHub Actions status)
3. Only THEN tell the user the work is done and the changes are live

Never say "done" after pushing and leave the user waiting. The task is not complete until the deploy is confirmed live. If the deploy takes longer than expected, keep the user informed with a short status update.

**Never claim an outcome you have not observed.** Do not say a nightly sync will pick something up, that a cron will fire, or that a deploy carried a change, unless you watched it happen. Report exactly what you clicked and what you saw. Bump the cache-bust version as part of the change, not after Kevin reports a stale page.

## Communication

Kevin is a non-technical operator. Explain in plain English at roughly a 13-year-old reading level — no jargon, no unexplained acronyms, no internal codenames. Keep it short. Lead with what happened, then the detail. Chunk long output across several messages rather than one wall of text.

## Design System — Sage Executive (light)

The platform uses a **single design-token stylesheet** so every page — main shell, iframe pages, OS pages, SOPs — looks like part of the same software.

### The rule for every new page

**Every new HTML file MUST link `css/tokens.css` in its `<head>` BEFORE any other stylesheet or `<style>` block:**

```html
<!-- Root level (follow-up.html, compliance.html, sop*.html) -->
<link rel="stylesheet" href="css/tokens.css?v=1">

<!-- os/*.html -->
<link rel="stylesheet" href="../css/tokens.css?v=1">

<!-- os/{subdir}/*.html -->
<link rel="stylesheet" href="../../css/tokens.css?v=1">
```

This gives the page:
- **DM Sans** font (auto-loaded from Google Fonts; the platform switched from Inter — never reintroduce Inter in new code or export templates)
- The sage-executive palette via CSS custom properties
- Default body background, text colour, and font rendering

### Token reference — always use these, never hardcode

| Purpose | Token | Value |
|--------|-------|-------|
| Page/app background | `var(--bg-app)` | pale sage `#F1F3EF` |
| Card/panel surface | `var(--bg-surface)` | `#FBFBF9` |
| Hover surface / zebra | `var(--bg-surface-2)` | `#F4F6F1` |
| Table header / subtle chip | `var(--bg-subtle)` | `#E5E8E1` |
| Sidebar (dark accent) | `var(--bg-sidebar)` | forest `#263330` |
| Primary text | `var(--text-primary)` | `#1C2422` |
| Secondary text | `var(--text-secondary)` | `#5A6660` |
| Muted text | `var(--text-muted)` | `#8A928C` |
| Border (default) | `var(--border-default)` | `#DDE1D9` |
| Border (subtle / divider) | `var(--border-subtle)` | `#E5E8E1` |
| Accent / primary CTA | `var(--accent)` | green `#2C6E49` |
| Accent hover | `var(--accent-hover)` | `#1B4A30` |
| Accent-tinted bg | `var(--accent-soft)` | `#DDE8DF` |
| Gold highlight (KPI / warn) | `var(--accent-gold)` | `#C6A15B` |
| Success (text) / bg | `var(--success)` / `var(--success-bg)` |  |
| Warning | `var(--warning)` / `var(--warning-bg)` |  |
| Danger | `var(--danger)` / `var(--danger-bg)` |  |
| Info | `var(--info)` / `var(--info-bg)` |  |

**Tonal palette** — for categorical colour-coding (e.g. 5 sequential weeks, tag categories) where you want distinct colours that still read as part of the sage-executive family. All five are muted earth tones at the same saturation:

| Token | Colour | Example use |
|-------|--------|------------|
| `var(--tone-sage)` | `#2C6E49` | Week 1 / default / primary group |
| `var(--tone-olive)` | `#5F7A3A` | Week 2 / secondary group |
| `var(--tone-gold)` | `#B8933A` | Week 3 / tertiary group |
| `var(--tone-blue)` | `#5A86CF` | Week 4 / quaternary group |
| `var(--tone-plum)` | `#8B6FAE` | Week 5 / final group |

Use these for sequential/categorical differentiation, NOT for status (use success/warning/danger/info for that).

Typography tokens: `--fs-xs` to `--fs-3xl`, `--fw-regular/medium/semibold/bold`, `--font-family-base`.
Spacing: `--space-1` through `--space-10` (4px scale).
Radii: `--radius-sm/md/lg/xl/full`.
Shadows: `--shadow-sm/md/lg`.

### Rules

1. **Never hardcode a colour.** If the token palette lacks what you need, add it to `css/tokens.css` rather than inlining a hex. Example: a new status colour should be added as `--info-2` in tokens, not `#abcdef` in a feature stylesheet.
2. **Never set `font-family` manually.** DM Sans comes via tokens.css; body inherits it. Delete any `-apple-system, BlinkMacSystemFont, ...` declarations in new code. Exception: print/export popups that cannot load tokens.css carry their own self-contained 'DM Sans' declaration with a comment saying why.
3. **Don't introduce a dark theme** for a single page. The whole platform is light-only for now; a dark-mode toggle would be a platform-level change.
4. **Inline styles should use tokens too:** `<div style="color:var(--text-secondary)">` rather than `color:#64748b`. This makes future rebrands painless.
5. **Iframe pages** must import tokens.css with the correct relative path (see examples above) so they render on the same palette as the parent shell.

### When changing the look of the whole app

Edit `css/tokens.css` only. A change there propagates to every page.

## Version Tracking

PAGE_REGISTRY in `js/config.js` tracks page and SOP versions.
- **`pageVer` is auto-bumped** by a GitHub Action (`.github/workflows/auto-bump-pagever.yml`) whenever a page's source file is pushed to main. No manual steps needed.
- A local pre-commit hook (`scripts/pre-commit`) also bumps versions at commit time if installed: `ln -sf ../../scripts/pre-commit .git/hooks/pre-commit`
- The file-to-page mapping is in `scripts/pre-commit-action.py`. Update it when adding new pages.
- When the SOP is updated to match, manually bump `sopVer` to match `pageVer`.

## Airtable Conventions

- **New KPI compute code ships with its KPI Library entry in the same commit** — add the template to `KPI_LIBRARY` in `js/kpi-library.js` (canonical) and the rationale to `docs/kpi-library-spec.md`. The daily `kpi-library-coverage` invariant in `scripts/check-data-invariants.py` fails the sweep whenever a live automated KPI has no library template, so forgetting is loud, not silent
- Only show ACTIVE businesses in dropdowns (filter by Active field)
- Use exact field names consistently between read and write paths (e.g., 'Quarter End' vs 'QuarterEnd' caused a sync bug)
- **Filter linked records by record ID — but only a LOOKUP of record IDs, never the link field itself.** `ARRAYJOIN()` over a *link* field yields the linked record's **primary field (its display name)**, never its ID, so `FIND("recXXX", ARRAYJOIN({LinkField}))` matches nothing and returns `200 OK` with an empty list. Verified on Tasks `tblqB8b22hKBL4PF1`, 6 Aug 2026: `FIND("reca9ofzhuw13ZzGE", ARRAYJOIN({Business}))` → **0 rows**, while `ARRAYJOIN({Business})="Operations Director"` and `FIND("rec4b5MDoaxEC7WRE", ARRAYJOIN({Record ID (Used for Automation) (from Team Members)}))` both match. So:
  - **Preferred:** add or use a lookup field that surfaces the linked record's `RECORD_ID()`, then `FIND()` against that. Stable across renames. This is what the rule has always meant
  - **Acceptable when no such lookup exists:** match the display name (`{Business}="Operations Director"`). Works today, but breaks silently the day someone renames the record, so pair it with a control
- **Every filterByFormula that counts something needs an expected count.** A wrong field name, a link-field ID match, or a bare date comparison all return `200 OK` and `{"records":[]}` — a broken query and a genuinely empty result are indistinguishable. State the number you expect and fail loudly on a miss. Date fields are the sharpest edge: `{Date}="2026-08-06"` returns zero even when the record exists; use `DATESTR({Date})="2026-08-06"` or `IS_SAME({Date},DATETIME_PARSE(...),'day')`. A silent zero on an existence check that gates a create writes the duplicate the check exists to prevent
- Watch for pagination when bulk-creating records to avoid duplicates
- Bulk operations on invoices/transactions: never mark legitimate unpaid items as paid without explicit reconcile logic

## Deployment & Git

- After pushing changes, verify the deploy is live before declaring done (check for stale browser cache, hard reload if needed)
- Be aware that parallel sessions can sweep uncommitted edits into other commits — commit before context-switching
- When a feature gets overwritten by another commit, check git history before reimplementing

### Branch Strategy

- **Small fixes, bug fixes, single-file tweaks:** push directly to main
- **New features, multi-file changes, anything touching shared files (config.js, shared.js, index.html, styles.css):** work on a branch, push, create a PR. This protects against concurrent session conflicts
- Branch naming: `feature/short-description` or `fix/short-description`

**Decide branch-or-main BEFORE you commit, never after.** Committing to local `main` and
*then* branching off it to open a PR leaves a stale twin of every commit on local `main`
forever: `gh pr merge --squash` creates a NEW commit on origin, so the original never
becomes an ancestor of `origin/main` and nothing ever cleans it up. If you are going to
open a PR, create the branch first — `./scripts/worktree.sh new <topic>` — so nothing
lands on `main` at all.

**Never do both for one piece of work.** One change = one route. A commit on `main` AND a
PR for the same change is always a bug, not belt-and-braces.

### Creating the PR

**`gh` IS installed and authenticated** (3 Aug 2026). Binary at `~/tools/bin/gh`, v2.97.0, on PATH via `~/.zshrc`. Logged in as `chaichoong` with scopes `repo`, `workflow`, `read:org`, `gist`. There is no Homebrew on this Mac; it was installed as the official release binary into a user directory, so no admin password is involved. Claude creates and merges PRs itself — do not send Kevin a compare URL to click any more.

```bash
git push -u origin <branch>
gh pr create --title "..." --body "..."
gh pr merge --squash --delete-branch
```

The `github` MCP server remains **read-only** — `create_pull_request` returns "Authentication Failed". Use `gh`, not the MCP, for any write.

**Do not re-test either of these with a read.** This repo is public, so `list_pull_requests`, `get_file_contents` and friends succeed with no credentials at all. A passing read proves nothing about writes; it is exactly what fooled a previous session into recording the MCP as authenticated. Only a write proves a write — `gh` was verified on 3 Aug 2026 by creating and deleting a real remote ref.

Kevin cannot click a terminal link: always `open` the deployed page and any deliverable in his browser rather than printing the URL.

Do NOT quietly merge to main locally as a fallback when a branch was created for review — that discards the review step the branch existed for.

**If the pre-push gate blocks a push to main on a test that is unrelated to your change:** do not reach for `SKIP_SYNC_TESTS=1`. Only `main` is gated (see `scripts/pre-push`), so push a branch and merge it with `gh` instead. Verify the failure really is unrelated first — run the failing test in isolation, and re-run the suite to see whether a *different* test fails, which indicates flakiness rather than a regression.

⚠️ **This fallback is the one that has actually caused duplicates.** You have already
committed to `main`, the gate blocks the push, so you branch off that commit and PR it.
The squash merge then puts a different SHA on origin and your original commit is stranded
on local `main`. On 6 Aug 2026 this happened three times in twenty minutes (PRs #36, #37,
#38), leaving local `main` seven commits ahead of origin while being 379 lines *behind* it.

So when the gate sends you down the branch route, finish the job:

```bash
gh pr merge --squash --delete-branch
git reset --keep origin/main   # MANDATORY — drops the stranded local commit
```

`--keep` is the safe variant: it refuses rather than destroying uncommitted work, which
matters because another session's edits are usually sitting in this checkout. If it
refuses, that other session has unsaved work — leave it and say so, do not use
`--hard`.

**Before any push to `main`, check you are not about to ship a twin:**

```bash
git diff origin/main HEAD --stat   # net deletions = local main is BEHIND; do not push
```

An empty diff means local `main` adds nothing. Net deletions mean your local commits are
stale copies of work already merged, and pushing them would revert origin.
