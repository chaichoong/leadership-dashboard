# Build Feature — Pre-Ship Checklist

Use this as a final gate before committing. Every box must be checked.

## Data Layer
- [ ] Airtable fetch uses field constants from config.js (not hardcoded strings)
- [ ] Pagination handled (offset loop until no more pages)
- [ ] try/catch on all fetch calls with toast on failure
- [ ] Active-only filtering where applicable
- [ ] Linked record fields filtered by record ID (not ARRAYJOIN display names)

## Render Layer
- [ ] Loading state visible during fetch
- [ ] Empty state when zero records match
- [ ] All colours from tokens.css (grep for hardcoded `#` values)
- [ ] No hardcoded font-family
- [ ] `escHtml()` on all user-supplied text in innerHTML
- [ ] Responsive at 1024px width (no horizontal scroll)

## Actions
- [ ] Confirm dialog before destructive actions
- [ ] Toast on success and failure
- [ ] Button disabled during async (prevent double-submit)
- [ ] Display updates after action (local mutate or refetch)

## Health & Monitoring
- [ ] `registerSyncBar()` with 5-8 checks
- [ ] `markTabSynced()` after successful render
- [ ] Sidebar health dot wired in index.html
- [ ] Sidebar badge (if feature has a count)

## Integration
- [ ] Sidebar menu item in index.html (with switchTab onclick)
- [ ] Tab panel `id="tab-xxx"` matches switchTab ID
- [ ] `data-sync-bar="xxx"` container present
- [ ] `tabLabelMap` entry in shared.js
- [ ] `PAGE_REGISTRY` entry in config.js
- [ ] OS-INTEGRATION sections untouched

## Security
- [ ] No `eval()` or `document.write()`
- [ ] No raw user data in innerHTML without `escHtml()`
- [ ] API token only via `PAT` global
- [ ] No inline `onclick` handlers with user data

## Code Quality
- [ ] `const`/`let` only (no `var`)
- [ ] Template literals for HTML (no string concatenation)
- [ ] Early returns (not deep nesting)
- [ ] No dead code or commented-out blocks left behind
