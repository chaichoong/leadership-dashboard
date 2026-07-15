# DESIGN.md — Operations Director Brand & Design System

Drop this file into any Claude Design, Claude Code, or Cowork session so every output matches the Operations Director platform. It is the portable version of `css/tokens.css`. When these two ever disagree, `css/tokens.css` wins for anything rendered inside the app; use this file for new marketing pages, decks, and prototypes.

Theme name: **Sage Executive** (light only, no dark mode).

---

## 1. Brand in one line

Operations Director is a done-for-you Digital Operations Director service for micro and small businesses. The look must read as calm, precise, premium, and trustworthy. Think a private-office adviser, not a loud SaaS startup. Muted sage and forest greens, warm off-white paper, a single gold highlight, generous space, sober typography.

Tone of the visual system: understated authority. Never neon, never playful gradients, never drop-shadows heavier than the tokens below.

---

## 2. Colour

Use semantic tokens, never raw hex, in anything that will live in the app. For decks and one-off marketing, the hex values are given so external tools can consume them.

### Core surfaces
| Role | Token | Hex |
|---|---|---|
| App / page background | `--bg-app` | `#F1F3EF` (pale sage) |
| Card / panel surface | `--bg-surface` | `#FBFBF9` |
| Hover / secondary panel | `--bg-surface-2` | `#F4F6F1` |
| Table header / subtle chip | `--bg-subtle` | `#E5E8E1` |
| Sidebar (dark accent) | `--bg-sidebar` | `#263330` (forest) |
| Dark tooltip / toast | `--bg-inverse` | `#1C2422` |

### Text
| Role | Token | Hex |
|---|---|---|
| Primary text | `--text-primary` | `#1C2422` |
| Secondary text | `--text-secondary` | `#5A6660` |
| Muted text | `--text-muted` | `#8A928C` |
| Text on dark bg | `--text-inverse` | `#FBFBF9` |
| Link | `--text-link` | `#2C6E49` |

### Accent (brand green + gold)
| Role | Token | Hex |
|---|---|---|
| Primary accent / CTA | `--accent` | `#2C6E49` |
| Accent hover | `--accent-hover` | `#1B4A30` |
| Accent-tinted bg | `--accent-soft` | `#DDE8DF` |
| Text on accent | `--accent-on` | `#FFFFFF` |
| Gold highlight | `--accent-gold` | `#C6A15B` |

### Borders
| Role | Token | Hex |
|---|---|---|
| Subtle / divider | `--border-subtle` | `#E5E8E1` |
| Default | `--border-default` | `#DDE1D9` |
| Strong | `--border-strong` | `#C9CDC3` |
| Focus ring | `--border-focus` | `#2C6E49` |

### Status
| Role | Text | Background |
|---|---|---|
| Success | `#2C6E49` | `#DDE8DF` |
| Warning | `#8A6B2D` | `#EFE3CA` |
| Danger | `#A33B3B` | `#EED9D9` |
| Info | `#3560A8` | `#DCE5F2` |

### Tonal family (categorical only, not status)
Use these five for sequential/categorical colour-coding (e.g. weeks, tags) where you want distinct hues that still read as one family. Same saturation, muted earth tones.
`--tone-sage #2C6E49` · `--tone-olive #5F7A3A` · `--tone-gold #B8933A` · `--tone-blue #5A86CF` · `--tone-plum #8B6FAE`

### Colour rules
- Green is the only brand accent. Gold is a single highlight, used sparingly (one KPI, one warn state), never as a fill for large areas.
- Status colours are for status only. Never use danger-red as a decorative accent.
- Do not introduce a colour outside this list. If a new one is genuinely needed, it gets added to `css/tokens.css` first, not inlined.

---

## 3. Typography

- Typeface: **DM Sans** everywhere (400, 500, 600, 700). Loaded from Google Fonts. Never substitute Inter (the platform migrated off it) or a system stack in visible copy.
- Numbers use tabular figures (`font-variant-numeric: tabular-nums`) so columns align.

Scale (px): `--fs-xs 11` · `--fs-sm 12` · `--fs-base 13` · `--fs-md 14` · `--fs-lg 16` · `--fs-xl 18` · `--fs-2xl 22` · `--fs-3xl 28`.
Weights: regular 400, medium 500, semibold 600, bold 700.
Line height: tight 1.2 (headings), normal 1.5 (body), relaxed 1.65 (long text).

Type rules
- Headings use sentence case, not Title Case (title case reads as AI-generated marketing).
- Body copy sits at 13-14px in-app; marketing pages can go to 16-18px for readability.
- Weight, not size, carries most hierarchy. Prefer 600 semibold over jumping a size.

---

## 4. Space, radius, shadow, motion

- Spacing scale (4px base): 4, 8, 12, 16, 20, 24, 32, 40. Use the scale, never arbitrary values.
- Radii: sm 4px, md 6px, lg 8px, xl 12px, full 999px. Cards use lg/xl; chips/badges use full.
- Shadows are soft and low: `sm 0 1px 2px rgba(28,36,34,.04)`, `md` two-layer at .06/.04, `lg` at .08/.06. Never a hard or dark drop-shadow.
- Motion: ease `cubic-bezier(.4,0,.2,1)`, durations fast 120ms / base 200ms / slow 300ms. Subtle only.

---

## 5. Components

- **Cards / panels**: `--bg-surface`, 1px `--border-default`, radius lg/xl, `--shadow-sm` or `md`. Padding 16-24px.
- **Primary button**: `--accent` bg, `--accent-on` text, radius md, hover to `--accent-hover`. Medium/semibold weight.
- **Secondary button**: surface bg, `--border-default`, `--text-primary`.
- **Badges/chips**: full radius, status bg + status text pairs from §2.
- **Tables**: header row `--bg-subtle`, zebra rows `--bg-surface-2`, cell text 13px. Long values truncate with ellipsis (single line) or wrap with `word-break` (multi-line), never clip silently.
- **Inputs**: surface bg, `--border-default`, focus to `--border-focus` ring.
- **Sidebar**: forest `#263330`, `--text-inverse` items, dim secondary `#BFC3BD`.

---

## 6. Voice for UI copy

- UK English always. Spartan, direct, active voice, no fluff.
- Short labels. "Add client", not "Click here to add a new client".
- No em dashes. No exclamation marks in system copy.
- Empty states, loading states, and error states are mandatory on every screen: say what is happening and the one next action, in plain words a non-technical owner understands.
- Never expose raw errors or jargon to the user.

---

## 7. Prompts to use this file

- Building a page in Claude Design/Code: "Use the attached DESIGN.md as the brand system. Sage Executive theme, DM Sans, sentence-case headings, green `#2C6E49` as the only accent, gold `#C6A15B` used once. Build [page]. Mobile-first responsive."
- Validating: "Review this against DESIGN.md. List any off-palette colours, wrong fonts, title-case headings, or missing empty/error states, with exact fixes."

---

_Source of truth for in-app rendering: `css/tokens.css`. This file mirrors it for external tools. Update both together if the brand changes._
