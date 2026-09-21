# Build Feature: self-audit (Phase 4a to 4f)

Moved from SKILL.md on 21 Sep 2026, word for word. Read once all the code is written, before you show Kevin anything.

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
