---
paths:
  - "js/**/*.js"
  - "**/*.html"
  - "css/**/*.css"
---

# Front-end rules

Moved from CLAUDE.md on 21 Sep 2026, word for word: the front-end Known Anti-Patterns, the file-ownership table, Protected Sections, Global Variables, the Verification Checklist with the Regression Protocol, and Version Tracking. Loads when Claude reads a file under `js/`, any `.html` file, or a file under `css/`. CLAUDE.md keeps the rules that apply to every task: "No Done Without Proof", "When You Find Issues During Verification" and "The No Handoff Rule".

## Known Anti-Patterns (front end)

These have caused production bugs in this codebase. Check for them during every build, fix, and audit.

- **Only show ACTIVE businesses in dropdowns** (filter by the Active field). Moved from CLAUDE.md "Airtable queries" on 21 Sep 2026
- **Missing typecast on PATCH calls** — Airtable number fields must receive a Number, not a string. Always wrap with `Number()` before sending: `fields: { [F.amount]: Number(value) }`
- **renderTasks vs renderAll stale-state** — after an inline edit, status change, or filter change, call the full list re-render function (e.g. `renderAll()`), not just the single-item updater. Partial re-renders leave badges, counts, and visible rows out of sync
- **returnFieldsByFieldId returning IDs not names** — when using `returnFieldsByFieldId=true` in Airtable API calls, field keys in the response are field IDs (e.g. `fldXyz123`), not human-readable names. If your code expects `rec.fields['Amount']` but gets `rec.fields['fldXyz123']`, every field read silently returns undefined. Match the approach used by the rest of the codebase (this project uses field names via the `F` constants in config.js, not raw field IDs)
- **CSS overflow truncation** — long tenant names, property addresses, and note text clip without ellipsis or wrapping. Use `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` on single-line cells, or `word-break: break-word` on multi-line content
- **localStorage quota issues** — Safari has a 5MB localStorage limit. Large cached datasets (100+ transaction records with all fields) can exceed this. Use IndexedDB for large caches (follow the `dashboard.js` pattern), keep localStorage for small UI state only

## Which file to edit for each feature

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

## The Verification Checklist (run EVERY time before declaring done)

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

## Regression Protocol

After any change to a shared file (config.js, shared.js, index.html, styles.css):
- Load the Leadership Dashboard tab and verify it renders
- Spot-check at least one other tab that uses the shared code
- Check the browser console across tabs for new errors

## Version Tracking

PAGE_REGISTRY in `js/config.js` tracks page and SOP versions.
- **`pageVer` is auto-bumped** by a GitHub Action (`.github/workflows/auto-bump-pagever.yml`) whenever a page's source file is pushed to main. No manual steps needed.
- A local pre-commit hook (`scripts/pre-commit`) also bumps versions at commit time if installed: `ln -sf ../../scripts/pre-commit .git/hooks/pre-commit`
- The file-to-page mapping is in `scripts/pre-commit-action.py`. Update it when adding new pages.
- When the SOP is updated to match, manually bump `sopVer` to match `pageVer`.
