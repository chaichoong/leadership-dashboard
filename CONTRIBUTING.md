# Contributor Guide (for team members building modules)

## Your workspace

You are building a standalone module page inside the `os/` directory. Your module lives at:

```
os/[your-module-name]/
  index.html    <- your page
  [name].css    <- your styles (optional, keep it minimal)
  [name].js     <- your JS logic
  sop.html      <- SOP page (create if requested)
```

## Rules you must follow

### 1. Link the design system
Your `index.html` must include this in the `<head>` BEFORE any other stylesheet:
```html
<link rel="stylesheet" href="../../css/tokens.css?v=1">
```
This gives you the full design system (colours, fonts, spacing). Use CSS custom properties from tokens.css for all styling. Never hardcode colours, fonts, or spacing values.

### 2. Copy the page structure from an existing module
Use `os/strategy/index.html` as your template. It shows the correct pattern for:
- Auth screen (PAT input)
- Loading overlay
- App container with header
- Config and shared script imports
- Sync bar integration

Your `<head>` scripts should include at minimum:
```html
<script src="../../js/config.js?v=22"></script>
<script src="../../js/prompts/boardroom-mentor.js?v=2"></script>
```

### 3. Stay in your folder
Only create or edit files inside `os/[your-module-name]/`. Do NOT touch:
- `index.html` (the main app shell)
- `js/config.js`, `js/shared.js`, or any file in `js/`
- `css/styles.css` or `css/tokens.css`
- Any other `os/` folder
- Any file in the repo root

Kevin handles wiring your module into the sidebar and config after review.

### 4. Airtable conventions
- Table IDs and field IDs are in `js/config.js`. Read them, do not change them.
- If you need a new table or field ID, define it as a constant at the top of your own JS file and note it in your PR description so Kevin can add it to config.js.
- Use exact field names. Mismatches between read and write paths cause silent bugs.
- Always filter businesses by Active field in dropdowns.
- Escape all Airtable-sourced text with a helper before putting it in HTML (prevent XSS).

### 5. Security
- Never use `innerHTML` with unescaped external data. Sanitise first.
- Never log the PAT token to the console.
- No `eval()`, `document.write()`, or `Function()` constructor.
- No hardcoded API keys or tokens.

### 6. Design tokens reference (use these, never hardcode)

| Purpose | Token |
|---------|-------|
| Page background | `var(--bg-app)` |
| Card/panel surface | `var(--bg-surface)` |
| Hover/zebra | `var(--bg-surface-2)` |
| Primary text | `var(--text-primary)` |
| Secondary text | `var(--text-secondary)` |
| Muted text | `var(--text-muted)` |
| Border | `var(--border-default)` |
| Accent/primary CTA | `var(--accent)` |
| Accent hover | `var(--accent-hover)` |
| Success | `var(--success)` |
| Warning | `var(--warning)` |
| Danger | `var(--danger)` |
| Font sizes | `var(--fs-xs)` to `var(--fs-3xl)` |
| Spacing | `var(--space-1)` to `var(--space-10)` |
| Border radius | `var(--radius-sm)` / `var(--radius-md)` / `var(--radius-lg)` |
| Shadows | `var(--shadow-sm)` / `var(--shadow-md)` / `var(--shadow-lg)` |

### 7. Branch workflow
- Always work on a branch: `feature/[your-module-name]`
- Never push to `main` directly
- Create a pull request when your module is ready for Kevin to review
- If Kevin requests changes, push fixes to the same branch

### 8. PR description template
When creating your pull request, include:
- What the module does (2-3 sentences)
- Which Airtable tables it reads/writes
- Any new field IDs or table IDs you defined locally (so Kevin can add them to config.js)
- Screenshots of the module working (Claude Code can take these for you)

### 9. Quality before submitting
Before creating your PR, verify in the browser:
- Page loads without console errors
- All buttons, forms, and interactions work
- Data loads from Airtable correctly
- Page looks correct (uses the sage-executive design system, no hardcoded colours)
- Long text does not overflow or clip
- Empty states handled (what happens with no data?)
