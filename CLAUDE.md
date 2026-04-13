# Leadership Dashboard — Claude Code Rules

## Critical: Protected Sections in index.html

When editing `index.html`, you MUST preserve the Operating Systems integration points. These are marked with `<!-- OS-INTEGRATION -->` comment pairs. There are 5 locations:

1. **Sidebar** — The "Operating Systems" group with `os-hub`, `os-bplan`, and `os-launch` sidebar items (between `<!-- OS-INTEGRATION: Sidebar -->` and `<!-- /OS-INTEGRATION: Sidebar -->`)

2. **Tab panels** — The `tab-os-hub`, `tab-os-bplan`, and `tab-os-launch` iframe panels (between `<!-- OS-INTEGRATION: Tab Panels -->` and `<!-- /OS-INTEGRATION: Tab Panels -->`)

3. **PAGE_REGISTRY** — The `os-hub`, `os-bplan`, and `os-launch` entries (between `// OS-INTEGRATION: PAGE_REGISTRY` and `// /OS-INTEGRATION: PAGE_REGISTRY`)

4. **tabLabelMap** — The `'os-hub'`, `'os-bplan'`, and `'os-launch'` keys in the tabLabelMap object (marked with `// OS-INTEGRATION:` comment)

5. **switchTab()** — The lazy-load blocks for `osHubFrame`, `osBplanFrame`, and `osLaunchFrame` (between `// OS-INTEGRATION: Lazy-load` and `// /OS-INTEGRATION: Lazy-load`)

### Rules

- **Never remove or overwrite code between OS-INTEGRATION comment pairs.**
- If you are rewriting a section of `index.html` that contains an OS-INTEGRATION block, you must include it in your rewrite.
- If you are adding new Operating Systems modules, add them inside the existing OS-INTEGRATION blocks following the same pattern.
- The `os/` directory contains the actual Operating Systems files. Do not delete or move it.

## Multi-Session Workflow

Multiple Claude Code sessions may be editing this repo concurrently, each focused on a different page/feature. To avoid overwriting each other's work:

- **Always `git pull` before editing `index.html`.**
- **Make targeted edits** — don't rewrite large sections of `index.html` if you only need to change a few lines.
- **Preserve all code you didn't change** — if you read a section and see code you don't recognise, leave it alone. Another session likely added it.
- **Push promptly** after committing to minimise merge conflicts.

## File Structure

- `index.html` — Main dashboard (single-file app, ~270KB)
- `os/` — Operating Systems directory
  - `os/index.html` — OS hub page
  - `os/business-plan-builder/` — Business Plan Builder (index.html, sop.html, serve.py)
  - `os/launch-plan.html` — 30-day Master Action Plan
- `*.html` — Other standalone pages (follow-up, compliance, SOPs)
- `sitemap.xml` / `robots.txt` — SEO files (update when adding new pages)
