# Operations Director Platform — Claude Code Rules

## File Architecture (Split for Concurrent Editing)

The platform has been split from a single monolith into separate files so that **multiple Claude sessions can work on different features at the same time** without overwriting each other.

### Source Files

```
index.html          ← HTML shell only (sidebar, tab containers, no logic)
css/styles.css      ← All CSS styles
js/config.js        ← Constants, Table IDs, Field IDs, Budget Targets
js/shared.js        ← Auth, API layer, helpers, UI utilities (expandableCard, switchTab, escHtml)
js/dashboard.js     ← Leadership Dashboard tab (loadDashboard, renderDashboard)
js/cashflow.js      ← Cash flow forecast, balance calculator, UC checks, what-if
js/reconciliation.js ← Reconciliation engine, knowledge base, accuracy tracking
js/invoices.js      ← Invoices tab (fetch, render, match, approve, pay)
js/cfv.js           ← CFV tab (detection, actions, comments)
js/fintable.js      ← Fintable Sync Monitor tab
js/sitemap.js       ← Site Map & Links tab, SOP update requests
js/ai-assistant.js  ← AI chat panel, context gathering, streaming
os/                 ← Operating Systems (separate pages loaded via iframe)
```

### Other Files
- `follow-up.html` — Inbound Comms (standalone, loaded via iframe)
- `compliance.html` — Property Compliance (standalone, loaded via iframe)
- `sop*.html` — SOPs for each page
- `os/index.html` — Operating Systems Hub
- `os/business-plan-builder/` — Business Launch Plan Builder
- `os/launch-plan.html` — Operations Director Master Action Plan
- `sitemap.xml` / `robots.txt` — SEO files (update when adding new pages)

## CRITICAL: Concurrent Session Rules

### The Golden Rule
**Two sessions must NEVER edit the same file at the same time.**

Each session should only edit the file(s) for its feature. Before starting work:
1. Run `git pull` to get the latest code
2. Edit ONLY the file(s) for your feature
3. Commit and push promptly when done

### Which file to edit for each feature

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

### If you need to change a shared file (config.js, shared.js, index.html, styles.css)
These files are used by ALL features. Only ONE session should edit them at a time. If your feature change requires a config or shared change, make it in the same session — don't leave it for another session.

## Protected Sections

### OS-INTEGRATION Comment Pairs
When editing `index.html`, preserve the Operating Systems integration points marked with `<!-- OS-INTEGRATION -->` comment pairs:
1. **Sidebar** — OS menu items
2. **Tab panels** — OS iframe containers
3. **PAGE_REGISTRY** in `js/config.js` — OS entries
4. **tabLabelMap** in `js/shared.js` — OS label keys

**Never remove or overwrite code between OS-INTEGRATION comment pairs.**

## Global Variables

All JS files share a global scope (loaded as plain `<script>` tags). Key globals:
- `PAT` — Airtable auth token (set by auth flow)
- `allTransactions`, `allTenancies`, `allTenants`, `allCosts`, `allCategories`, `allSubCategories`, `allBusinesses` — data arrays loaded in `dashboard.js`
- `F`, `TABLES`, `INV`, `REC`, `PS` — field/table/record ID constants in `config.js`
- Helper functions (`getField`, `fmt`, `escHtml`, `expandableCard`, etc.) in `shared.js`

## Deployment

The git repo IS the source of truth. Edit files directly here.
- GitHub Pages URL: https://chaichoong.github.io/leadership-dashboard/
- Push to `main` branch → auto-deploys in 2-3 minutes
- Always `git pull` before starting work, and push promptly after committing

## Version Tracking

PAGE_REGISTRY in `js/config.js` tracks page and SOP versions.
- **`pageVer` is auto-bumped** by a GitHub Action (`.github/workflows/auto-bump-pagever.yml`) whenever a page's source file is pushed to main. No manual steps needed.
- A local pre-commit hook (`scripts/pre-commit`) also bumps versions at commit time if installed: `ln -sf ../../scripts/pre-commit .git/hooks/pre-commit`
- The file-to-page mapping is in `scripts/pre-commit-action.py`. Update it when adding new pages.
- When the SOP is updated to match, manually bump `sopVer` to match `pageVer`.
