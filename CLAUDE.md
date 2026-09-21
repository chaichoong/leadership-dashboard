# Operations Director Platform — Claude Code Rules

## Stack

**Current:** Vanilla JS, Airtable (API + linked records), GitHub Pages, plain `<script>` tags (no bundler).
**Migration (PARKED 8 Sep 2026, Kevin's ruling):** the Supabase + Vercel shadow build (`supabase-app.html` shell, `*-supabase.html` twins + shims, spec `docs/supabase-schema-spec.md`) stays in the repo but no cut-over work runs. Airtable is the system of record. Revisit at client three, or for a client who needs a multi-user login. Ruling: brain `Decisions/2026-09-08 Keep the Airtable stack, park the Supabase and Vercel migration, move the app to the OD domain.md`.

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

## Airtable queries (a wrong query still returns 200)

- Paginate every read: follow `offset`, or use `airtableFetch()`. A hand-rolled fetch once read only the first 100 rows and the card showed a wrong score for a month.
- A GET by record id ignores the table in the URL. To prove which table a record is in, list that table or attempt a write.
- `ARRAYJOIN()` over a link field returns display names, never record ids. Match ids through a lookup of `RECORD_ID()`; a name match needs a control.
- Date equality needs `DATESTR()` or `IS_SAME()`. `{Date}="2026-08-06"` returns zero.
- A blank number field passes `!= 0` and fails `> 0`. Use `ABS({field}) > 0` for "set and non-zero", and test every formula change against a blank record.
- Every count states the number it expects and fails loudly on a miss.
- Anything that accumulates value lives in Airtable, never localStorage, keyed on something stable across records.
- Never set a unit to Void without the six-question gate in the airtable-tenancy-ender skill. Occupancy lives in both the `Tenancies` and `Tenancies copy` links. A payment belongs to the tenancy in its own `Tenancy` link, not the tenancy record that displays it.
- **New KPI compute code ships with its KPI Library entry in the same commit** — add the template to `KPI_LIBRARY` in `js/kpi-library.js` (canonical) and the rationale to `docs/kpi-library-spec.md`. The daily `kpi-library-coverage` invariant in `scripts/check-data-invariants.py` fails the sweep whenever a live automated KPI has no library template, so forgetting is loud, not silent
- Only show ACTIVE businesses in dropdowns (filter by Active field)
- Use exact field names consistently between read and write paths (e.g., 'Quarter End' vs 'QuarterEnd' caused a sync bug)
- Watch for pagination when bulk-creating records to avoid duplicates
- Bulk operations on invoices/transactions: never mark legitimate unpaid items as paid without explicit reconcile logic

Incident write-ups: `docs/incident-lessons.md`.

## Standard Workflow

Two commands cover all work. Kevin talks conversationally after either one. Claude handles the full pipeline.

- **`/build-feature`** — for anything new: new tab, new page, new OS, new feature, significant extension of an existing feature. Rewrites Kevin's input into a BILD prompt, plans, gets approval, builds, runs the full quality pipeline (simplify, test-gaps, review, security-review if auth/data/money, pre-deploy), deploys, verifies live.
- **`/fix`** — for bugs, errors, feedback, amendments, tweaks to existing work. Rewrites Kevin's input into a focused BILD prompt, diagnoses, fixes, runs the quality pipeline (verify, simplify, test-gaps, pre-deploy), deploys, verifies live.

Both skills run start-to-finish. Kevin approves the plan once, then receives a working, deployed result. No manual skill-chaining needed.

- After merging any change to a repo skill or rule, refresh the main checkout (`git fetch origin && git reset --keep origin/main`) and grep the file on disk; skills and rules load from the checkout, not from GitHub. The GOAL contract is injected by a hook; rule: `~/.claude/skills/goal-line/SKILL.md`.

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
- **Airtable rules** (blank fields, the table a record id really lives in, voiding a unit) sit in "Airtable queries" above. The incident write-ups are in `docs/incident-lessons.md`
- **Reconciliation lessons** (split sign, paginated reads, the learning loop): `.claude/rules/reconciliation.md`, loaded when `js/reconciliation.js` or a recon test is read
- **Agent task pipeline lessons** (duplicate key, auto-replies and stranded mail, the alert lane, idle hand-backs): `.claude/rules/agent-task-pipeline.md`, loaded when the agent task scripts, `os/agents/index.html` or their tests are read
- **Python script lessons** (atomic lock-file writes, a deleted name that still passes import): `.claude/rules/python-scripts.md`, loaded when any `scripts/**/*.py` is read
- **Cloudflare cron:** never put the day of the week in a Cloudflare cron. Detail: `.claude/rules/cloudflare-cron.md`, loaded when a wrangler toml or Worker file is read
- **A master switch that reads On is not the setting that earns, and a filter on HOW something was uploaded hides it from the report that would have caught it** — the Content Engine switched every YouTube video's monetisation On and every surface agreed: the morning line read "content monetisation: every YouTube episode and Short On". On 20 Sep 2026 Kevin said the long episodes were not earning. He was right. The master switch buys a pre-roll; **mid-roll ads were off on 817 of the 888 videos over 8 minutes**, with YouTube's own break point already computed and waiting on 695 of them, and a further 923 videos from 2020 to Nov 2023 had no video ads at all, only display banners. Nothing was broken, nothing errored, and the thing being measured was simply not the thing that makes money. Three rules came out of it. **Measure the setting that produces the outcome, not the switch nearest to it.** **A selector on provenance is a selector on visibility** — `monetise_long_video` matched posts with `route == "api"`, so every GoHighLevel upload (which carries GHL's own post id, not a YouTube one) was stepped over in silence, and the report used the same filter, so 2054's episode, 2054's Short and 2195's episode were invisible in both places; match on the identity of the thing (the video id, resolved through the episode's `youtube_link`), never on how it arrived, and report what you cannot resolve. And **a 200 from an undocumented internal endpoint is not a write**: Studio's `metadata_update` needs the page's minted BotGuard `attestationResponseData`, and replayed without it it answers `200 OK` and changes nothing — proved on `Rs8xHbD5miQ`, 200 then `hasMidrollAds` still false on read-back. Same family as the Airtable silent-zero rule above. So a genuine UI save mints an attestation, the rest of the batch replays it, and **every id is read back off the source before anything is called done**. Guarded by `tests/content-engine-ads.test.js` (back-tested: restoring the route filter fails "does not filter YouTube posts by upload route")

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

## File Architecture

Where every file lives: `STRUCTURE.md`. The old source tree below is kept for maintainers only.

<!--
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
-->

## Concurrent sessions

### The Golden Rule
**Two sessions must NEVER edit the same file at the same time.**

Each session edits only the file(s) for its feature, and commits and pushes its branch promptly when done.

### The Golden Rule is necessary but NOT sufficient — use separate worktrees

File-level ownership does not protect what git actually shares: **HEAD, the index, the stash,
and the working tree**. Two sessions in one checkout have swept each other's work into stashes,
shipped each other's commits and pushed to the wrong branch (16 Jul 2026).

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

**The main checkout does NOT hold `main`, and cannot.** `.claude/worktrees/content-engine-runtime`
is checked out on `main` on purpose: the nightly `content-engine` and daytime
`content-engine-publish` launchd jobs run from it and fast-forward it before every run. Git allows
one worktree per branch, so `main` is taken. **Never remove, detach or `worktree.sh done` that
worktree** to free the name; it breaks both jobs and raises no error.

**The main checkout lives on a working branch cut from `origin/main`** (currently
`chore/main-checkout`) for quick fixes, the daily sweep and deploy verification. Refresh it with
`git fetch origin && git reset --keep origin/main`. Reach for a workspace when the work is
multi-file or will run for a while.

A checkout left on a stale topic branch is the normal failure here. Before assuming that branch
holds unique work, prove it with `git cherry -v origin/main HEAD` and a read of
`git diff origin/main...HEAD`; tag it (`git tag archive/<branch>`) before closing it. Note that a
stale branch never reverts main on merge, because git merges by change, not by snapshot.

If a checkout genuinely must be shared: commit before EVERY context switch, never `git stash`
work you did not write (leave it and say so), and run `git status -sb` before assuming which
branch you are on — especially before reading a quiet "Everything up-to-date" as success.

When a feature gets overwritten by another commit, check git history before reimplementing.

### Session hygiene — this Mac has 16 GB and 8 cores

Worktrees fix *correctness* under concurrency. They do nothing for *capacity*, and capacity
is a real limit here: six sessions at once on 6 Aug 2026 made the machine unusable, with no
error raised, because nothing was broken, only oversubscribed.

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
session transcripts on disk. Use a file (`~/.config/od/airtable_pat`) or an env var.

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

## Quality gate

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

## Agent estate sync (Kevin, 7 Sep 2026)

`~/.claude/agents/ESTATE.md` is the one dated page saying how the AI workforce, the approval
gate, Kevin's surfaces and the clocks fit together. The CEO, every head, every worker, the
`/ceo` and `/huddle` skills and the 06:45 CEO slot read it first.

- **Any ruling that changes routing, autonomy levels, the money rule, where Kevin decides, the
  workforce shape or the clocks** goes to the brain's `Decisions/` AND into `ESTATE.md` with
  its `As at` date bumped, in the same session. Wording the ruling retires is added to
  `RETIRED` in `scripts/agent-estate-drift.py`.
- `python3 scripts/agent-estate-drift.py` is the check (daily 06:25 as the wrapped job
  `estate-drift`, and before every huddle). Red is fixed the same day, never silenced.
- Never state a register count or a persona list in a prompt; the register is read live and
  the eleven heads are the `dept-*` files.

## Deployment

The git repo IS the source of truth. Edit files directly here.
- Live URL: https://app.operationsdirector.co.uk/ (GitHub Pages custom domain since 8 Sep 2026; the old https://chaichoong.github.io/leadership-dashboard/ redirects)
- Every push or merge that lands on origin/main auto-deploys in 2-3 minutes
- Push promptly after committing

### Confirm the deploy is live

After every push or merge that lands on origin/main:
1. Push or merge the code
2. Poll the GitHub Pages deployment until it completes (use the poll in memory `reference_deploy_poll.md`, Pages workflow 253912194, or `gh run watch`)
3. Only THEN tell the user the work is done and the changes are live

Never say "done" after pushing and leave the user waiting. The task is not complete until the deploy is confirmed live. If the deploy takes longer than expected, keep the user informed with a short status update.

**Never claim an outcome you have not observed.** Do not say a nightly sync will pick something up, that a cron will fire, or that a deploy carried a change, unless you watched it happen. Report exactly what you clicked and what you saw. Bump the cache-bust version as part of the change, not after Kevin reports a stale page.

## Design System

Sage Executive tokens, and the rule that every new HTML page links `css/tokens.css` first: `.claude/rules/design-system.md`, loaded when a `.js`, `.html` or `.css` file is read.

## Version Tracking

PAGE_REGISTRY in `js/config.js` tracks page and SOP versions.
- **`pageVer` is auto-bumped** by a GitHub Action (`.github/workflows/auto-bump-pagever.yml`) whenever a page's source file is pushed to main. No manual steps needed.
- A local pre-commit hook (`scripts/pre-commit`) also bumps versions at commit time if installed: `ln -sf ../../scripts/pre-commit .git/hooks/pre-commit`
- The file-to-page mapping is in `scripts/pre-commit-action.py`. Update it when adding new pages.
- When the SOP is updated to match, manually bump `sopVer` to match `pageVer`.

## Deployment & Git

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

`gh` is installed and authenticated as `chaichoong`; Claude creates and merges PRs itself, and never sends Kevin a compare URL to click.

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
on local `main`.

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
