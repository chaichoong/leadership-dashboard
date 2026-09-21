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

**Two folders, one rule (Kevin, 21 Sep 2026): this repo is for code; private working files never land here.** It is PUBLIC. Non-code work runs from the private projects in `~/Projects/kevin-hq`: `property`, `money-legal`, `runpreneur`, and HQ itself (CEO, learning, personal). They share this repo's memory and its task and tenancy skills but are not in git. A SessionStart hook (`~/.claude/hooks/project-check.py`) moves a new chat to the right project on its first reply. A session here that produces a letter, a calculation or a data dump writes it to `~/Projects/kevin-hq`, not the working tree. `scripts/private-name-guard.py` (run by the pre-commit hook) refuses any commit that adds a line naming someone on the private roster.

## Data Lookups

Never guess an entity attribute — property location, tenancy status, cost status, model ID, record count, table or field name. Query the source of truth first (Airtable via curl, or the constant in `js/config.js`) and cite the record or line you read. If you cannot find it, say so. An inferred value presented as a fact is worse than "I don't know", because it gets acted on.

- **Every number in a report needs a source.** State the field or formula it came from and a sample record proving the derivation. Flag anything inferred rather than read.
- **Airtable access:** desktop sessions have a claude.ai Airtable connector, but robots have none, so curl with the PAT at `~/.config/od/airtable_pat` stays the rule for anything a robot might run. Never print the token. Base `appnqjDpqDniH3IRl`.
- **Match on the right field.** Costs use the LEGACY `Payment Status`, not `Cost Status`. Filtering the wrong status field has produced confidently wrong impact stories before.
- **A skill's own learning log is evidence, not proof.** Verify its claims against the table before acting on them.

## Airtable queries (a wrong query still returns 200)

- Paginate every read, including the existence check before a bulk create (a missed page writes duplicates): follow `offset`, or use `airtableFetch()`. A hand-rolled fetch once read only the first 100 rows and the card showed a wrong score for a month.
- A GET by record id ignores the table in the URL. To prove which table a record is in, list that table or attempt a write.
- `ARRAYJOIN()` over a link field returns display names, never record ids. Match ids through a lookup of `RECORD_ID()`; a name match needs a control.
- Date equality needs `DATESTR()` or `IS_SAME()`. `{Date}="2026-08-06"` returns zero.
- A blank number field passes `!= 0` and fails `> 0`. Use `ABS({field}) > 0` for "set and non-zero", and test every formula change against a blank record.
- Every count states the number it expects and fails loudly on a miss.
- Anything that accumulates value lives in Airtable, never localStorage, keyed on something stable across records.
- Never set a unit to Void without the six-question gate in the airtable-tenancy-ender skill. Occupancy lives in both the `Tenancies` and `Tenancies copy` links. A payment belongs to the tenancy in its own `Tenancy` link, not the tenancy record that displays it.
- **New KPI compute code ships with its KPI Library entry in the same commit** — add the template to `KPI_LIBRARY` in `js/kpi-library.js` (canonical) and the rationale to `docs/kpi-library-spec.md`. The daily `kpi-library-coverage` invariant in `scripts/check-data-invariants.py` fails the sweep whenever a live automated KPI has no library template, so forgetting is loud, not silent
- Use exact field names consistently between read and write paths (e.g., 'Quarter End' vs 'QuarterEnd' caused a sync bug)
- Bulk operations on invoices/transactions: never mark legitimate unpaid items as paid without explicit reconcile logic

Incident write-ups: `docs/incident-lessons.md`.

## Standard Workflow

`/build-feature` for anything new, `/fix` for bugs, feedback and tweaks to existing work. Each runs start to finish: Kevin approves the plan once and receives a working, deployed result.

- After merging any change to a repo skill or rule, refresh the main checkout (`git fetch origin && git reset --keep origin/main`) and grep the file on disk; skills and rules load from the checkout, not from GitHub.

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

- **Front end** (lessons: PATCH typecast, renderTasks vs renderAll, `returnFieldsByFieldId`, CSS overflow, localStorage quota; plus the file-ownership table, Protected Sections, Global Variables, the Verification Checklist with the Regression Protocol, and Version Tracking): `.claude/rules/frontend.md`, loaded when a file under `js/`, an `.html` file or a file under `css/` is read
- **Airtable rules** (blank fields, the table a record id really lives in, voiding a unit) sit in "Airtable queries" above. The incident write-ups are in `docs/incident-lessons.md`
- **Reconciliation lessons** (split sign, paginated reads, the learning loop): `.claude/rules/reconciliation.md`, loaded when `js/reconciliation.js` or a recon test is read
- **Agent task pipeline lessons** (duplicate key, auto-replies and stranded mail, the alert lane, idle hand-backs): `.claude/rules/agent-task-pipeline.md`, loaded when the agent task scripts, `os/agents/index.html` or their tests are read
- **Python script lessons** (atomic lock-file writes, a deleted name that still passes import): `.claude/rules/python-scripts.md`, loaded when any `scripts/**/*.py` is read
- **Cloudflare cron:** never put the day of the week in a Cloudflare cron. Detail: `.claude/rules/cloudflare-cron.md`, loaded when a wrangler toml or Worker file is read
- **Content Engine monetisation (20 Sep 2026):** measure the setting that produces the outcome, not the switch nearest to it. A selector on provenance is a selector on visibility: match on the identity of the thing (the video id), never on how it arrived, and report what you cannot resolve. A 200 from an undocumented internal endpoint is not a write: read every id back off the source before calling it done. Write-up: `docs/incident-lessons.md`. Guarded by `tests/content-engine-ads.test.js`

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

### If you need to change a shared file (config.js, shared.js, index.html, styles.css)
These files are used by ALL features. Only ONE session should edit them at a time. If your feature change requires a config or shared change, make it in the same session — don't leave it for another session.

## Quality gate

The user is a non-technical operator. Every task must be delivered working and verified. Do NOT ask the user to check the console, run commands, test manually, or debug. If Claude Code can do it, Claude Code does it.

### Rule: No "Done" Without Proof

Never say a task is complete until you have personally verified it works. "I've made the changes" is not done. "I've verified in the browser that the feature works correctly" is done.

### When You Find Issues During Verification

Fix them immediately. Do not report "I found 3 issues" and wait for the user to ask you to fix them. Fix first, then report what you found and fixed.

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

## Deployment & Git

### Branch Strategy

- **Small fixes, bug fixes, single-file tweaks:** push directly to main
- **New features, multi-file changes, anything touching shared files (config.js, shared.js, index.html, styles.css):** work on a branch, push, create a PR. This protects against concurrent session conflicts
- Branch naming: `feature/short-description` or `fix/short-description`

**Decide branch-or-main BEFORE you commit, and use one route per change.** `gh pr merge --squash`
puts a NEW commit on origin, so a commit made before you branched is stranded as a stale twin
that nothing cleans up. Going to open a PR? Create the branch first with
`./scripts/worktree.sh new <topic>`. A commit on `main` AND a PR for the same change is always
a bug.

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

This fallback is the one that has actually stranded commits, so finish the job:

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
