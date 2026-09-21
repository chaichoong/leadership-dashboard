# Build Feature: common mistakes to avoid (quick reference)

Moved from SKILL.md on 21 Sep 2026, word for word. Read while planning (Phase 1 and 2) and again during the Phase 4 self-audit.

| Mistake | Prevention |
|---------|-----------|
| Wrong Airtable field name (capitalisation/spaces) | Always read from config.js or confirm with Kevin |
| Badge shows raw count, not filtered count | Badge logic must match the rendered/visible items |
| Hardcoded colour | Grep for `#` in your new code |
| Missing health bar | It's in the checklist — don't skip it |
| Missing empty state | Test with zero records |
| Missing loading state | Show spinner/skeleton before fetch resolves |
| Double-submit on buttons | Disable button, re-enable after async completes |
| Stale display after action | Locally mutate or refetch + rerender |
| Missing escHtml on user data | Grep for `innerHTML` assignments, verify all have escHtml |
| Forgot PAGE_REGISTRY entry | Auto-bump won't work without it |
| Forgot tabLabelMap entry | Tab label will show raw ID instead of human name |
| Broke OS-INTEGRATION section | Read index.html first, mark those sections as untouchable |
| Airtable 429 rate limit on bulk writes | 500ms pause between requests, exponential backoff on retry |
| N+1 query pattern (fetch in a loop) | Batch into single `filterByFormula=OR(...)` or resolve from globals |
| Redundant Airtable fetch when global array exists | Check if `allTenancies`, `allTransactions`, etc. already have the data |
| localStorage collision with another feature | Namespace all keys with feature prefix (`cfv_`, `recon_`, `inv_`) |
| Feature write-back breaks another tab's counts | Run cross-feature regression check (Phase 4d) |
| No undo on destructive actions | Add sliding undo toast for dismiss/status-change/field-edit |
| Missing accessibility (no keyboard nav) | Escape closes, Enter submits, aria-expanded on collapsibles |
| AI assistant can't answer questions about new feature | Add context block in `ai-assistant.js` |
| Forgot SOP / sitemap update | Phase 8 — it's not done until the SOP exists |
