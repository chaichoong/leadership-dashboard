# Sync-Invariant Tests

Playwright tests that guard the exact sync bug classes listed in `CLAUDE.md` →
"Known Anti-Patterns". They mock the Airtable API with deterministic fixtures
(no PAT needed) and boot the app from a local `python3 -m http.server`.

**33 tests, ~37s, all green.** They catch regressions before they reach the
live GitHub Pages site.

## What each spec guards

| Spec | Invariant |
|------|-----------|
| `two-way-sync` | Read and write paths use identical field IDs (`returnFieldsByFieldId=true`) |
| `stale-data-protection` | UI state derives from live field values, not parsed display strings; loading overlay clears |
| `pagination-dedup` | `airtableFetch` follows offset tokens fully; no duplicate creates from partial reads |
| `badge-count-sync` | Badge/count numbers stay in sync with rendered rows |
| `record-id-matching` | Linked-record fields are stored as record IDs, not display strings |
| `split-safety` | Split operations PATCH only, never POST children (data-corruption guard) |
| `cfv-detection` | `isCurrentlyInArrears` driven directly: reconciled payment clears arrears; UC future-dueDay tenants still evaluated; unreconciled payment does not clear |
| `active-business-filter` | Only Active businesses appear in dropdowns |
| `auth-token-handling` | PAT handling: stored, cleared, never leaked |
| `cascade-sync` | Cascading updates propagate across linked records |
| `no-crash-on-load` | Every tab loads and tab-switching never throws uncaught errors |

## Known follow-ups (UI-layer invariants not yet covered)

Two invariants need a fixture that renders the reconciliation panel under mock data,
so they are tracked rather than guarded by a DOM test that passes whether or not the
element exists:

- Recon dropdown resolves a linked unit by record ID, not by display string.
- The Split button's enabled/disabled state (now driven at source by `Split Count > 1`).

## Run

```bash
npm install            # one time — pulls Playwright
npx playwright install chromium   # one time — pulls the browser
npm run test:sync      # run the suite
npm run test:sync:ui   # run with the Playwright UI
```

## Pre-push gate (optional)

`scripts/pre-push` runs the suite before any push **to main** and blocks the
push if a test fails. It is **safe**: it skips automatically when Playwright is
not installed and when pushing to any non-main branch, and has an escape hatch.

Enable on a machine (one time):

```bash
ln -sf ../../scripts/pre-push .git/hooks/pre-push
```

Disable: `rm .git/hooks/pre-push`

Bypass a single push: `SKIP_SYNC_TESTS=1 git push origin main`
