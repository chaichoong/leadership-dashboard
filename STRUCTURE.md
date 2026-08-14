# STRUCTURE.md — Where Everything Lives

Single source of truth for file locations across the Operations Director Platform and its AI working layer. Every Claude session must follow this. **Maintenance rule: if you add a file somewhere this document does not cover, update this document in the same commit.**

## 1. The one rule that prevents disasters

**The git repo is the ONLY place code is edited.** Copies of repo files found anywhere else (Google Drive, Claude Outputs, downloads) are stale exports. Never read or edit them as source. If asked to work on a file and you find it outside the repo, locate it in the repo first.

## 2. Repo layout (`~/Projects/leadership-dashboard`)

| Location | Purpose | New files go here when… |
|---|---|---|
| `/` (root) | Live HTML pages served by GitHub Pages (`index.html`, `follow-up.html`, `compliance.html`, `sop*.html`, `inbound-comms-sop.html`, `ai-brain.html`, `architecture.html`, `how-it-works.html`, `onboarding.html` — public client onboarding intake form, POSTs to the `onboarding-submit` Edge Function, `journey.html` — internal clickable walkthrough of the prospect journey, client onboarding and product state; static replicas only, makes no network calls and loads no data, `noindex`) plus repo config (`CLAUDE.md`, `STRUCTURE.md`, `MASTER-PLAN.md` — THE single living plan, see CLAUDE.md "THE MASTER PLAN", `PRODUCTISATION.md`, `CONTRIBUTING.md`, `CHEAT-SHEET.md`, `DESIGN.md` (portable brand/design system mirroring `css/tokens.css`, for external tools like Claude Design), `sitemap.xml`, `robots.txt`, `package.json`, `vercel.json`, `playwright.config.js`, `vitest.config.js`, `serve-test.py`). Legacy exceptions grandfathered at root: the two Apps Script sources (`gmail-invoice-script.gs`, `gmail-meetings-script.gs` — new `.gs` files go in `scripts/`), the Supabase-migration variants (`*-supabase.html`, `supabase-app.html`) and their boot/shim JS (`comms-boot.js`, `comms-shim.js`, `dashboard-boot.js`, `dashboard-shim.js`) | The file is a new public page. Nothing else new goes at root |
| `js/` | One file per feature tab (see CLAUDE.md table). `config.js` = constants, `shared.js` = helpers, `agent-accuracy.js` = the AI-agent approval outcomes and the autonomy threshold, shared by the Task OS and the Leadership Dashboard so both score identically (its constants are drift-tested against `scripts/agent-accuracy-report.py`), `project-health.js` = the single on-track/off-track rule (time elapsed vs progress to target), shared by the Leadership Dashboard, the Tasks & Projects page and `scripts/sync-project-status.mjs` so all three give the same answer | New feature tab logic, or a scoring/threshold rule two pages must agree on |
| `js/prompts/` | AI prompt sources (`boardroom-mentor.js`) | New AI prompt used by the app |
| `css/` | `tokens.css` (design tokens, single source of truth) + `styles.css` | Never add per-feature stylesheets without checking tokens first |
| `assets/` | Brand/image assets (`od-logo.svg` — the Operations Director mark) | New brand image or icon asset |
| `guides/` | Client-facing page guides (plain-language, ~13-yr-old reading level), one HTML file per client page. Shown in the Supabase Site Map's "Guide" column for clients; the owner keeps the developer `sop*.html`. Each links `../css/tokens.css` | New client-facing guide for a page |
| `os/` | Operating System pages, one folder per OS, loaded via iframe. Each OS folder may carry its own `index-supabase.html` migration variant, `supabase-boot.js`/`supabase-shim.js`, `sop.html`, `workflow.html`, and support files (`os/operations/ops-schema.json`, `os/tasks/gcal-proxy.gs`, `os/business-plan-builder/serve.py`) | New OS page |
| `supabase-migration/` | Supabase shadow build: `supabase/migrations/*.sql` (schema + RLS, incl. the multi-tenancy foundation), `supabase/functions/*` (Edge Functions), and `stress-test/` (live multi-tenancy isolation harness + findings). See `docs/supabase-schema-spec.md` and `docs/supabase-multitenancy-stress-audit.md` | New migration, Edge Function, or Supabase-specific test tooling |
| `workers/` | Cloudflare Workers, one folder per worker | New server-side endpoint |
| `cloudflare-worker/` | Legacy worker folder. Do not add to it; new workers go in `workers/` | Never |
| `scripts/` | Build/automation scripts (`pre-commit`, `pre-push` — the push gate, runs vitest then Playwright, `worktree.sh` — creates/removes the isolated workspaces in `.claude/worktrees/`, `check-routines.py` — asserts exactly ONE enabled Claude routine (`daily-ops`) by reading the scheduler's own store, so a routine added through the app cannot quietly restart the stacking; run in phase 1 of the routine and again in the 11:00 digest, **`job-queue.py` — the scheduled-job queue: every launchd job and every Claude routine takes its lock so no two ever run at once, with a per-job staleness cut-off from `job-schedule.json` (the one place every job's cron and max lateness is recorded), `findings.py` — the queue of problems the read-only routines find and the `queue-fixer` routine later repairs (the file itself lives outside the repo, in `~/knowledge-os/logs/`, because findings quote real records and this repo is public), `morning-digest.py` — the single morning Slack message, invoked by `~/tools/job-digest.sh` at 11:00; all three covered by `tests/job-queue.test.js`**, `mac-status.sh` — plain-English memory health check for this Mac (free RAM, compression ratio, swap, what is holding it), `mac-guard.sh` — reaps preview servers and test browsers that outlived the session that started them (launchd `com.kevinbrittain.mac-guard`, hourly, wrapped by `~/tools/run-job.sh`; its safety rails are asserted in `tests/mac-guard.test.js` because it kills processes), Slack automation, `agent-accuracy-report.py` — what the CEO huddle reads out about agent accuracy, `agent-dispatch.py` — the deterministic half of the agent dispatch engine (stage 2 of the approval loop; driven by the `agent-dispatch` scheduled task on Kevin's Mac, its field IDs drift-tested in `tests/constant-drift.test.js`), `uc-task-sync.py` + `uc-check-notify.py` — book the Universal Credit checks and decide what Mica is DM'd, both with control checks, `uc-notifier-watchdog.py` — proves the `uc-check-slack-notifier` routine actually sent them (launchd `com.kevinbrittain.uc-notifier-watchdog`, 09:00 daily, wrapped by `~/tools/run-job.sh`), `agent_email_format.py` — THE Correspondence Agent Output contract (TO/CC/FROM/SUBJECT headers, `---`, body) plus the tier-1 banner constant, imported by BOTH `agent-dispatch.py` (which validates a Correspondence submit against it) and `send-email.py` (which parses the approved output with it); two copies meant submit accepted output the send gate could not parse, and the tier-1 banner one script prepended was rejected by the other, so a task could be approved and never sent; guarded by `tests/agent-dispatch-submit-gate.test.js`, `whatsapp-sweep.py` — reads WhatsApp's local `ChatStorage.sqlite` read-only (scan / mark / sent / selftest), the WhatsApp twin of `imessage-sweep.py`; it replaced a computer-use path that could never run on a schedule, because `request_access` needs a human to approve it and the grant dies with the session, so the WhatsApp half skipped silently every day. Watch the units: WhatsApp timestamps are SECONDS since 2001-01-01, iMessage are NANOseconds, and the two watermarks live in separate state files. Broadcast surfaces (`@newsletter`, `@status`, `@lid.status`, `@broadcast`) are dropped, without which 5,719 of 6,160 unread messages are one newsletter, `prospect-dedupe.py` — THE prospect dedupe key (company-name normalisation, Companies House numbers from the field AND from Notes, LinkedIn path); `/prospect-daily` calls it instead of re-deriving the rule from prose, which drifted twice in two days and cold-emailed the same founder twice; guarded by `tests/prospect-dedupe.test.js`, `sync-project-status.mjs` — writes each project's derived health (`js/project-health.js`) back to Airtable's Project Status so the base agrees with the dashboard; run daily, `--dry-run` to preview, fails loudly if the Projects table returns zero rows). `scripts/slack-automation/` holds the Cloudflare Workers: `contractor-bot.js` (Slack app + the AI-agent approval loop cron) and its `approvals.js` module, `money-daily-worker.js` (09:00 CEO brief), `notify-slack-worker.js` | New automation script. Apps Script sources (`*.gs`) also belong here |
| `monitoring/` | Airtable schema snapshots and drift reports | Generated by drift monitoring only |
| `tests/` | Vitest unit tests plus Playwright sync-invariant suite (`tests/sync-invariants/`). `test-results/` is generated output, never committed intentionally | New tests |
| `docs/` | Internal docs not served as part of the product, including `daily-ops-routine.md` — the version-controlled original of THE one scheduled Claude routine, whose live copy is `~/.claude/scheduled-tasks/daily-ops/SKILL.md`. Routine instructions kept only outside git skip review entirely, so the repo copy is the one to edit | New internal documentation |
| `.claude/skills/` | Project workflow skills (`build-feature`, `fix`, `audit`, `test`, `verify`, `pre-deploy`, `test-gaps`, `health-bar`, `prospect-daily`) | New project-specific skill |
| `.claude/scheduled-tasks/` | **Reviewed mirror** of the scheduled routines' instructions (`<name>/SKILL.md`). The files the Claude app actually runs live at `~/.claude/scheduled-tasks/`; this copy exists so a change to what a routine may read, write or touch goes through a PR like any other code. Sync with `scripts/sync-scheduled-tasks.py --pull` (adopt a live edit) or `--push` (restore the reviewed version); `--check` runs in `npm test` and fails on drift. Only `SKILL.md` is mirrored — routine runtime state (`state.json`, `notified.json`) stays local | Editing a routine's behaviour |
| `.claude/worktrees/` | Isolated workspaces for parallel sessions, one subfolder per topic. Gitignored. Created and removed ONLY via `./scripts/worktree.sh` (`new` / `list` / `done`) — never by hand, and never left to accumulate. `done` refuses while the workspace holds uncommitted, unpushed or unmerged work | Created by tooling only |

## 3. AI context layer (what Claude reads, in order)

1. **`~/.claude/CLAUDE.md`** — who Kevin is, decision frameworks, writing style. Applies to every project.
2. **`CLAUDE.md` (this repo)** — build rules, quality gates, file ownership for concurrent sessions.
3. **`STRUCTURE.md` (this file)** — where everything lives.
   **`MASTER-PLAN.md`** — THE one plan for OD (launch, migration, GTM, delivery). Never create another plan doc; amend this one. Protocol in the file + CLAUDE.md.
   **`PRODUCTISATION.md`** — what a generic client gets on each page (universal / module / vertical / bespoke). Read before building any client-facing version of a page.
4. **Memory** (`~/.claude/projects/-Users-kevinbrittain-Projects-leadership-dashboard/memory/`) — durable facts, preferences, project state. Indexed by `MEMORY.md`.
5. **Skills** — three tiers, by design:
   - Project skills: `.claude/skills/` in this repo (workflow pipeline)
   - Personal skills: `~/.claude/skills/` (`build-prompt`, `challenge`)
   - Cowork plugin skills: managed by the Claude desktop app (Airtable automations, document tools)

Do not move skills between tiers without reason: project skills travel with the repo, personal skills apply everywhere, plugin skills are managed by the app.

6. **Scheduled routines** — `~/.claude/scheduled-tasks/<name>/SKILL.md` is what the app runs; `.claude/scheduled-tasks/` in this repo is the reviewed mirror of the same files. Edit the live one, then `scripts/sync-scheduled-tasks.py --pull` and commit, so the change is reviewed. They are not symlinked on purpose: the app's handling of a symlinked task directory is unverified, and getting it wrong stops all eighteen routines at once.

## 4. Google Drive (`My Drive/Claude/`)

| Folder | Purpose | Rules |
|---|---|---|
| `Claude Outputs/<topic>/` | Deliverables produced FOR Kevin (reports, documents, exports) | Name files `YYYY-MM-DD description`. NEVER put copies of repo code here. Stale items move to `_ARCHIVE/` |
| `Knowledge Base/` | Reference content for sessions (tone, standard responses) | Update in place; no duplicates |
| `About Me/` | Kevin's profile, style and decision documents | Update in place |
| `Templates/` | Document templates (ASTs, loan agreements) | One copy per template, no "(1)" duplicates |
| `Projects/<name>/` | Per-project context for Cowork sessions. Contains a pointer CLAUDE.md only | No source code |

## 5. Data: files vs database

| Content | Lives in | Moves to |
|---|---|---|
| Code, pages, styles | Git repo | Stays in git |
| SOP content | HTML files in repo root | Supabase tables at SaaS migration (per-tenant data) |
| Business data (tenants, transactions, invoices, costs, tasks) | Airtable | Supabase at migration |
| Skills, prompts, memory | Files (see §3) | Stays as files |
| Reports and deliverables | Drive `Claude Outputs/` | Stays in Drive |
| Business records (invoices, certs, legal) | Drive (currently unstructured at root) | Planned folders: `Properties/`, `Finance/`, `Legal/`, `Operations Director/`, `Runpreneur/`, `Archive/` — reorganisation pending as its own task |

## 6. Hygiene rules

- After a branch merges, delete the branch and its worktree in the same session.
- Commit or stash uncommitted edits before context-switching; parallel sessions sweep loose files.
- Generated snapshots (`monitoring/`) older than 3 months can be pruned, keep `schema-baseline.json`.
- One copy of everything. A "(1)" or "(2)" suffix anywhere is a bug to fix, not a pattern to follow.
