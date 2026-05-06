---
name: health-bar
description: Add a sync bar with health checks to a new or existing page/tab. Analyses the page's JS to auto-generate data-sync checks, automation checks, and a refresh function, then wires up the HTML container and sidebar health dot. Use when a page or section has been built and needs the reliability bar added.
---

# Health Bar Generator

Add the standard sync bar + health check system to a page or tab that doesn't have one yet.

## Pre-requisites

The sync bar system (`js/sync-bar.js` + `css/sync-bar.css`) is already loaded globally by `index.html`. This skill only needs to:
1. Add the HTML container
2. Write the `registerSyncBar()` call with appropriate checks
3. Wire up the sidebar health dot

## Procedure

### 1. Identify the target

Determine from the user's request:
- **Tab ID** — the string used in `switchTab('xxx')` (e.g. `'overview'`, `'cfv'`, `'invoices'`)
- **JS file** — which `js/*.js` file contains the tab's render logic
- **Render function** — the function called after data loads (e.g. `renderCFVTab`, `renderInvoiceTab`)
- **Data refresh function** — what to call when the user clicks Refresh (e.g. `loadDashboard`, `fetchInvoicesFromAirtable`)

If the target is an **iframe page** (e.g. `os/*.html`, `follow-up.html`, `compliance.html`), the pattern differs slightly — see the iframe section below.

### 2. Read and analyse the page's code

Read the target JS file end-to-end. Build a mental model of:

**Data sources** — what globals or fetches does the page depend on?
- Airtable tables fetched (look for `fetch(` calls with Airtable URLs, or globals like `allTenancies`, `allTransactions`, `allCosts`)
- External APIs called (Gmail sync, Apps Script, webhooks)
- LocalStorage/IDB data used
- Globals consumed from other files (e.g. `allTenancies` loaded by `dashboard.js`)

**Core computations** — what does the page calculate or derive?
- Detection algorithms (e.g. `detectCFVs()`)
- Matching/reconciliation logic
- Aggregations, counts, totals
- Filters applied (active/inactive, status-based)

**Automations & features** — what should be running?
- Timers/intervals (`setInterval`, refresh loops)
- Sidebar badge updates
- Write-back to Airtable
- Cache mechanisms
- Linked record resolution

**UI outputs** — what does the user see?
- Cards, tables, counts, badges
- Status indicators
- Action buttons (approve, dismiss, mark paid)

### 3. Design the checks

Generate two categories of checks:

#### Data sync checks (`kind: 'sync'`)
These verify that the page's data arrived correctly. They run automatically on every `markTabSynced()`.

Standard patterns:
- **"X records fetched"** — verify the primary data array has length > 0, report the count
- **"Y count within expected range"** — warn if a count is suspiciously low (e.g. active tenancies < 30)
- **"Each record has required field Z"** — check for missing linked records, null fields, orphan references
- **"Computation produces valid result"** — run the core algorithm, verify it doesn't throw and produces a sane number
- **"Freshness of source data"** — if bank sync or API has a "last updated" field, check it's not stale

#### Automation & feature checks (`kind: 'automation'`)
These verify that features and integrations are wired up correctly.

Standard patterns:
- **"Function X is loaded"** — `typeof myFunction === 'function'`
- **"Sidebar badge matches data"** — compare badge count to actual computed count
- **"Timer/interval is running"** — check the timer variable isn't null
- **"External URL configured"** — check that config constants exist
- **"Last action succeeded"** — if the page tracks last-action status, report it
- **"Cache is fresh / localStorage persists"** — check persistence layer

#### Active checks (`active: true`)
Mark a check as active if it does something heavy: Airtable writes, HTTP pings, or O(n) API calls. These only run when the user clicks "Re-run" in the drawer. Most checks should be passive (default).

### 4. Write the code

#### a) HTML container

There are two patterns — use whichever matches the existing tab:

**Static placement (most tabs):** The tab panel already exists in `index.html` with child elements. Add `<div data-sync-bar="TAB_ID"></div>` as the **first child** inside it:

```html
<div class="tab-panel" id="tab-TAB_ID">
    <div data-sync-bar="TAB_ID"></div>   <!-- ADD THIS -->
    <!-- existing content -->
</div>
```

**Dynamic placement (tabs that build via innerHTML):** Some tabs (e.g. `pnl`, `transactions`) have an empty `<div class="tab-panel" id="tab-TAB_ID"></div>` in `index.html` and build all content dynamically in JS. For these, include `<div data-sync-bar="TAB_ID"></div>` at the top of the innerHTML template string in the JS file.

Check which pattern applies: if the tab's `<div>` in `index.html` already has child elements, use static. If it's empty or self-closing, use dynamic.

For iframe pages, add it at the top of `<main>` or the first content container.

#### b) Sidebar health dot

If not already present, add the health dot to the sidebar item in `index.html`:

```html
<span class="sidebar-health-dot unknown" data-sidebar-health="TAB_ID" title="No checks run yet"></span>
```

#### c) registerSyncBar call

Add the registration block at the **end** of the page's main render function, just before the function's closing brace. Follow this exact pattern:

```javascript
// ── Sync Bar + Health Checks ──
if (typeof registerSyncBar === 'function') {
    registerSyncBar('TAB_ID', {
        refreshFn: async () => { /* call the data refresh function(s) */ },
        checks: [
            // ─── DATA SYNC ───
            {
                name: 'Descriptive check name', kind: 'sync', run: () => {
                    // Return { status: 'pass'|'warn'|'fail', detail: 'human-readable text' }
                }
            },
            // ─── AUTOMATIONS & FEATURE HEALTH ───
            {
                name: 'Feature check name', kind: 'automation', run: () => {
                    // ...
                }
            },
        ],
    });
    markTabSynced('TAB_ID');
}
```

**Load-order note:** `sync-bar.js` is loaded with `defer` in `index.html`, so both `registerSyncBar` and `markTabSynced` are always available by the time any tab renders. The `typeof registerSyncBar === 'function'` guard is a defensive pattern for iframe pages where the script may not be loaded. For in-shell tabs you can rely on both functions existing, but the guard is harmless and consistent.

### 5. refreshFn design

The `refreshFn` must re-fetch the tab's data AND re-render the tab. Some tabs own their data fetch; others depend on globals loaded by `dashboard.js`.

**Tab owns its data** (e.g. `invoices.js`):
```javascript
refreshFn: async () => { await fetchInvoicesFromAirtable(); }
```
The fetch function's success path should call the render function, which calls `markTabSynced`.

**Tab derives from shared globals** (e.g. `cfv.js`):
```javascript
refreshFn: async () => { await loadDashboard(); await renderCFVTab(); }
```
Must reload the base data first, then re-derive the tab's view.

**Tab with external sync** (e.g. `invoices.js` with Gmail):
```javascript
refreshFn: async () => {
    if (typeof triggerGmailInvoiceSync === 'function') triggerGmailInvoiceSync();
    await fetchInvoicesFromAirtable();
}
```

### 6. Check naming conventions

Check names should be **declarative** and describe what's being verified, not how:
- "Invoices fetched from Airtable" (not "Check invoice count")
- "Each CFV has days-overdue populated" (not "Validate daysOverdue")
- "Sidebar badge matches detection count" (not "Test badge")

Detail text should give Kevin enough context to diagnose issues:
- Include counts: `"47 active tenancies (In Payment / CFV / CFV Actioned)"`
- Include values: `"£12,450.00 · last bank sync 2 hours ago"`
- Name the likely cause on failure: `"formula on Tenancies table may be broken"`

### 7. Verify

After adding the health bar:
1. Check the page loads without console errors
2. Confirm the sync bar renders (dot, time, refresh button, health pill)
3. Click the health pill — drawer should expand showing all checks
4. Click Re-run — active checks should execute
5. Click Refresh — data should reload and checks re-run
6. Check the sidebar health dot updates to match

## Iframe page variant

For standalone pages loaded via iframe (`os/*.html`, `follow-up.html`, `compliance.html`):

1. Ensure `sync-bar.css` is in the `<head>` and `sync-bar.js` is loaded near the bottom (after the page's own scripts), both with cache-buster params matching `index.html`:
   ```html
   <!-- In <head> -->
   <link rel="stylesheet" href="css/sync-bar.css?v=2">
   
   <!-- Near bottom of <body>, after page scripts -->
   <script src="js/sync-bar.js?v=4"></script>
   ```
   Adjust path depth for `os/` pages: `../css/sync-bar.css`, `../js/sync-bar.js`. Check the current version numbers in `index.html` and match them.

2. The `_broadcastStatus()` function in `sync-bar.js` will automatically `postMessage` the status up to the parent shell, which updates the sidebar health dot.

3. The parent shell's `shared.js` listens for `syncBarStatus` messages and calls `updateSidebarHealth()`.

## Minimum viable checks

Every health bar should have at minimum:
1. At least one **data loaded** check (primary data array has records)
2. At least one **data quality** check (key fields populated, counts in range)
3. At least one **feature health** check (core function loaded, badge wired)

Aim for 5-8 checks per tab. More than 12 becomes noisy; fewer than 3 doesn't provide enough signal.

## Check return value reference

```javascript
{ status: 'pass', detail: 'Human-readable success message with counts/values' }
{ status: 'warn', detail: 'Something unexpected but not broken — include likely cause' }
{ status: 'fail', detail: 'Something is broken — name the root cause or missing dependency' }
```
