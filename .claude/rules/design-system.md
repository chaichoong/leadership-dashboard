---
paths:
  - "js/**/*.js"
  - "**/*.html"
  - "css/**/*.css"
---

Moved from CLAUDE.md on 21 Sep 2026, word for word. Loads when Claude reads a .js, .html or .css file.

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
- **DM Sans** font (auto-loaded from Google Fonts; the platform switched from Inter — never reintroduce Inter in new code or export templates)
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
2. **Never set `font-family` manually.** DM Sans comes via tokens.css; body inherits it. Delete any `-apple-system, BlinkMacSystemFont, ...` declarations in new code. Exception: print/export popups that cannot load tokens.css carry their own self-contained 'DM Sans' declaration with a comment saying why.
3. **Don't introduce a dark theme** for a single page. The whole platform is light-only for now; a dark-mode toggle would be a platform-level change.
4. **Inline styles should use tokens too:** `<div style="color:var(--text-secondary)">` rather than `color:#64748b`. This makes future rebrands painless.
5. **Iframe pages** must import tokens.css with the correct relative path (see examples above) so they render on the same palette as the parent shell.

### When changing the look of the whole app

Edit `css/tokens.css` only. A change there propagates to every page.
