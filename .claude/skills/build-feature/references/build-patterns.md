# Build Feature: mandatory patterns and code quality gates (Phase 3b and 3c)

Moved from SKILL.md on 21 Sep 2026, word for word. Read before you write the first line of code in Phase 3.

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
