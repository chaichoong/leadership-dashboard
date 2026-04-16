# Operations Director Platform — Claude Code Rules

## File Architecture (Split for Concurrent Editing)

The platform has been split from a single monolith into separate files so that **multiple Claude sessions can work on different features at the same time** without overwriting each other.

### Source Files

```
index.html          ← HTML shell only (sidebar, tab containers, no logic)
css/tokens.css      ← Design tokens (colour, typography, spacing) — single source of truth
css/styles.css      ← Main stylesheet (consumes tokens.css)
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

## Design System — Sage Executive (light)

The platform uses a **single design-token stylesheet** so every page — main shell, iframe pages, OS pages, SOPs — looks like part of the same software.

### The rule for every new page

**Every new HTML file MUST link `css/tokens.css` in its `<head>` BEFORE any other stylesheet or `<style>` block:**

```html
<!-- Root level (follow-up.html, compliance.html, sop*.html) -->
<link rel="stylesheet" href="css/tokens.css?v=1">

<!-- os/*.html -->
<link rel="stylesheet" href="../css/tokens.css?v=1">

<!-- os/{subdir}/*.html -->
<link rel="stylesheet" href="../../css/tokens.css?v=1">
```

This gives the page:
- **Inter** font (auto-loaded from Google Fonts)
- The sage-executive palette via CSS custom properties
- Default body background, text colour, and font rendering

### Token reference — always use these, never hardcode

| Purpose | Token | Value |
|--------|-------|-------|
| Page/app background | `var(--bg-app)` | pale sage `#F1F3EF` |
| Card/panel surface | `var(--bg-surface)` | `#FBFBF9` |
| Hover surface / zebra | `var(--bg-surface-2)` | `#F4F6F1` |
| Table header / subtle chip | `var(--bg-subtle)` | `#E5E8E1` |
| Sidebar (dark accent) | `var(--bg-sidebar)` | forest `#263330` |
| Primary text | `var(--text-primary)` | `#1C2422` |
| Secondary text | `var(--text-secondary)` | `#5A6660` |
| Muted text | `var(--text-muted)` | `#8A928C` |
| Border (default) | `var(--border-default)` | `#DDE1D9` |
| Border (subtle / divider) | `var(--border-subtle)` | `#E5E8E1` |
| Accent / primary CTA | `var(--accent)` | green `#2C6E49` |
| Accent hover | `var(--accent-hover)` | `#1B4A30` |
| Accent-tinted bg | `var(--accent-soft)` | `#DDE8DF` |
| Gold highlight (KPI / warn) | `var(--accent-gold)` | `#C6A15B` |
| Success (text) / bg | `var(--success)` / `var(--success-bg)` |  |
| Warning | `var(--warning)` / `var(--warning-bg)` |  |
| Danger | `var(--danger)` / `var(--danger-bg)` |  |
| Info | `var(--info)` / `var(--info-bg)` |  |

**Tonal palette** — for categorical colour-coding (e.g. 5 sequential weeks, tag categories) where you want distinct colours that still read as part of the sage-executive family. All five are muted earth tones at the same saturation:

| Token | Colour | Example use |
|-------|--------|------------|
| `var(--tone-sage)` | `#2C6E49` | Week 1 / default / primary group |
| `var(--tone-olive)` | `#5F7A3A` | Week 2 / secondary group |
| `var(--tone-gold)` | `#B8933A` | Week 3 / tertiary group |
| `var(--tone-blue)` | `#5A86CF` | Week 4 / quaternary group |
| `var(--tone-plum)` | `#8B6FAE` | Week 5 / final group |

Use these for sequential/categorical differentiation, NOT for status (use success/warning/danger/info for that).

Typography tokens: `--fs-xs` to `--fs-3xl`, `--fw-regular/medium/semibold/bold`, `--font-family-base`.
Spacing: `--space-1` through `--space-10` (4px scale).
Radii: `--radius-sm/md/lg/xl/full`.
Shadows: `--shadow-sm/md/lg`.

### Rules

1. **Never hardcode a colour.** If the token palette lacks what you need, add it to `css/tokens.css` rather than inlining a hex. Example: a new status colour should be added as `--info-2` in tokens, not `#abcdef` in a feature stylesheet.
2. **Never set `font-family` manually.** Inter comes via tokens.css; body inherits it. Delete any `-apple-system, BlinkMacSystemFont, ...` declarations in new code.
3. **Don't introduce a dark theme** for a single page. The whole platform is light-only for now; a dark-mode toggle would be a platform-level change.
4. **Inline styles should use tokens too:** `<div style="color:var(--text-secondary)">` rather than `color:#64748b`. This makes future rebrands painless.
5. **Iframe pages** must import tokens.css with the correct relative path (see examples above) so they render on the same palette as the parent shell.

### When changing the look of the whole app

Edit `css/tokens.css` only. A change there propagates to every page.

## Version Tracking

PAGE_REGISTRY in `js/config.js` tracks page and SOP versions.
- **`pageVer` is auto-bumped** by a GitHub Action (`.github/workflows/auto-bump-pagever.yml`) whenever a page's source file is pushed to main. No manual steps needed.
- A local pre-commit hook (`scripts/pre-commit`) also bumps versions at commit time if installed: `ln -sf ../../scripts/pre-commit .git/hooks/pre-commit`
- The file-to-page mapping is in `scripts/pre-commit-action.py`. Update it when adding new pages.
- When the SOP is updated to match, manually bump `sopVer` to match `pageVer`.
