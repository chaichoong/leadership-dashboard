# Build Feature — Pre-Ship Checklist

Use this as a final gate before committing. Every box must be checked. Mark N/A where genuinely not applicable.

## Data Layer
- [ ] Airtable fetch uses field constants from config.js (not hardcoded strings)
- [ ] Pagination handled (offset loop until no more pages)
- [ ] try/catch on all fetch calls with toast on failure
- [ ] 429 rate-limit handling with backoff (500ms pause between bulk writes)
- [ ] Active-only filtering where applicable
- [ ] Linked record fields filtered by record ID (not ARRAYJOIN display names)
- [ ] Reuses shared global arrays where possible (not redundant fetches)
- [ ] `fields[]` parameter used to limit Airtable response size
- [ ] IndexedDB caching with TTL for expensive fetches (if applicable)

## Render Layer
- [ ] Loading state visible during fetch (spinner + explainer if >3s)
- [ ] Empty state when zero records match
- [ ] All colours from tokens.css (grep for hardcoded `#` values)
- [ ] No hardcoded font-family
- [ ] `escHtml()` on all user-supplied text in innerHTML
- [ ] Responsive at 1024px width (no horizontal scroll)
- [ ] Print-friendly `@media print` rules (if feature has printable data)

## Actions
- [ ] Confirm dialog before destructive actions
- [ ] Toast on success and failure
- [ ] Button disabled during async (prevent double-submit)
- [ ] Display updates after action (local mutate or refetch)
- [ ] Undo toast for reversible destructive actions (dismiss, status change, field edit)

## State Persistence
- [ ] localStorage keys namespaced with feature prefix
- [ ] Graceful degradation when localStorage is cleared
- [ ] Cross-device state written to Airtable (not just localStorage) where it matters

## Accessibility
- [ ] `aria-expanded` on collapsible sections
- [ ] `aria-modal="true"` on dialogs
- [ ] `aria-live="polite"` on dynamic content regions
- [ ] Escape closes drawers/modals, Enter submits
- [ ] Logical tab order, visible `:focus-visible` styles
- [ ] Decorative icons get `aria-hidden="true"`

## Health & Monitoring
- [ ] `registerSyncBar()` with 5-8 checks
- [ ] `markTabSynced()` after successful render
- [ ] Sidebar health dot wired in index.html
- [ ] Sidebar badge (if feature has a count)
- [ ] Integrates with idle auto-refresh cycle

## Integration
- [ ] Sidebar menu item in index.html (with switchTab onclick)
- [ ] Tab panel `id="tab-xxx"` matches switchTab ID
- [ ] `data-sync-bar="xxx"` container present
- [ ] `tabLabelMap` entry in shared.js
- [ ] `PAGE_REGISTRY` entry in config.js
- [ ] OS-INTEGRATION sections untouched
- [ ] AI Assistant context block added in ai-assistant.js (if feature has queryable data)
- [ ] Iframe postMessage wiring (iframe pages only)

## Cross-Feature Regression
- [ ] Airtable write-backs don't break other tabs' data (dashboard KPIs, cashflow, recon, CFV)
- [ ] Sidebar badge counts on OTHER tabs still correct after this feature's actions

## Performance
- [ ] Initial load makes ≤3 Airtable API calls (reuse globals where possible)
- [ ] No N+1 queries (batch related-record lookups)
- [ ] Large datasets (200+ rows) have pagination or "show more"
- [ ] `fields[]` parameter limits response payload

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

## Audit (run /audit skill)
- [ ] Audit score reported (target 80+)
- [ ] All HIGH-severity bugs fixed
- [ ] Re-audit confirms no self-introduced bugs
- [ ] Deploy verified live (pageVer matches)

## SOP & Sitemap
- [ ] SOP file created or updated (`sop-[feature].html`)
- [ ] SOP imports `css/tokens.css` with correct relative path
- [ ] `sopFile` path set in PAGE_REGISTRY entry
- [ ] `sopVer` set to match `pageVer`
- [ ] `sitemap.xml` updated with new page URL and SOP URL
- [ ] `scripts/pre-commit-action.py` mapping updated for auto-bump
