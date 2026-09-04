# Operations Director — the operations board

## Mood & when to use

The brand language of Operations Director (operationsdirector.co.uk): a calm, sage-and-forest operations board on
which one daily workflow is drawn as a route with stations, and AI agents are shown doing the work while the owner
keeps one gold stop for approval. Confident, plain, British; the feel of a well-run back office, never a tech launch.
For every Operations Director LinkedIn picture: a method (numbered stations on a route), a before/after (two lanes of the
board), a build-log stat (one big figure on a placard), a workflow (the route with a gold owner stop), a checklist (a
clipboard on the board). Do not use it for Runpreneur or anything about running; do not use it for somber or dramatic
subjects. It is the house style, so the SCENE carries the variety: change the route's shape, the placard, the props.

**Composition note:** default to **Big Object** (the route or the board object fills 55–70% of the canvas) or
**Editorial spread** (a towering figure or numeral in a narrow column, the stations in the wide one). The canvas is a
PLACE: the reader stands over an operations board on a desk, grid paper under it, a title strip along the bottom. Never
a card grid on a flat ground.

## Palette

Brand tokens from the platform's `css/tokens.css` (sage executive). Two classes: structure/decoration and chart-safe.

| Role | Hex | Notes |
|---|---|---|
| `--bg` | `#F1F3EF` | pale sage board paper |
| `--surface` | `#FBFBF9` | placards, station cards |
| `--surface-2` | `#F4F6F1` | quiet fills, unfilled cells, meter tracks |
| `--subtle` | `#E5E8E1` | grid lines, dividers |
| `--deep` | `#263330` | one dark block per canvas at most (a header band, a big ghosted numeral, the agent's screen) |
| `--ink` | `#1C2422` | primary text |
| `--ink-muted` | `#5A6660` | secondary text, leaders |
| `--ink-faint` | `#8A928C` | captions, source lines |
| `--accent` | `#2C6E49` | forest green: the route, the agent's work, numbering. Decoration AND `--chart-1` |
| `--accent-deep` | `#1B4A30` | route shadow, pressed states |
| `--accent-soft` | `#DDE8DF` | agent zones, tinted fills |
| `--gold` | `#C6A15B` | THE owner's colour: the one human stop, one highlight. Rationed to one or two touches |
| `--chart-1` | `#2C6E49` | sage (agent, primary series) |
| `--chart-2` | `#B8933A` | gold tone (owner, secondary) |
| `--chart-3` | `#5A86CF` | blue tone (third series, always direct-labeled) |
| `--chart-4` | `#8B6FAE` | plum tone (rare fourth) |
| `--de-emphasis` | `#DDE1D9` | context marks, "by hand" lane |

The four chart slots are the platform's tonal palette (same saturation, distinct hues). Sage↔gold and blue↔plum are the
weaker CVD pairs, so every multi-series mark is direct-labeled. Text never wears a chart colour; the coloured mark
beside it carries identity (exception: text inside a `--accent` or `--deep` fill is `--surface`).

## Typography

```html
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,700;1,9..40,400&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
```

- Display: **DM Sans** 700, sentence case, letter-spacing -0.01em, line-height 1.02 — titles, hero numbers.
- Body/labels: **DM Sans** 400/500. Annotations, station numbers, source lines, the title strip: **DM Mono** 400/500,
  uppercase where it labels the board (`STATION 03`, `SOURCE`).
- Scale (1080×1350 canvas): title 60–72px · standfirst 20px DM Sans 400 `--ink-muted` · station text 24–28px ·
  label 15px mono · caption 13px mono. Hero number 140–220px DM Sans 700 `--accent`.
- UK English on every label. No person's name anywhere; the brand is the signature.

## Geometry & spacing

- Radii 8px on placards and station cards, 999px on station numbers (circles). No box-shadows; depth is a 1.5px
  `--subtle` border plus a 6px `--accent-deep` offset "shadow plate" behind one hero object only.
- The route: a 14px `--accent` stroke, round caps and joins, drawn as one SVG path (straight runs and 90° or gentle
  curves), with a 1.5px `--surface` inner line down its middle (a road marking). Stations sit ON the route as 44px
  circles: `--accent` fill, `--surface` numeral in DM Mono 500 20px. The owner's stop is the same circle in `--gold`
  with a 3px `--surface` ring.
- Grid paper: 1px `--subtle` lines at 40px cells over the whole canvas, under everything. Two registration ticks (+) in
  `--ink-faint` at the top corners.
- Spacing scale: 8 / 16 / 24 / 40 / 64. Canvas padding 56px. Title strip 96px tall along the bottom edge.

## Chart styling

- Prefer diegetic forms: the route length as the timeline, a placard's meter as the ratio, stacked station cards as
  bars, a clipboard's ticks as the count.
- Conventional bars only on a placard: 18px thick, square ends, `--accent` for the agent series, `--chart-2` for the
  owner's share, 8px gaps, value in DM Mono 15px at the tip. No gridlines (the board grid serves). No donuts unless
  ≤ 3 segments with the % in the hole.
- Before/after: two lanes side by side on the board. The "by hand" lane is `--de-emphasis` marks with a hand-drawn
  wobble (1px path, 0.5 opacity); the "with an agent" lane is `--accent` marks with the agent mark. An arrow (the
  route) crosses from one lane to the other.
- Every value direct-labeled; a big number has its label under it in `--ink` and its source in mono `--ink-faint`.

## Signature devices

1. **The route with stations**: the workflow as one 14px sage path with numbered stops; the human stop in gold. Data
   as geography: the reader follows the line.
2. **The agent mark**: a geometric robot drawn in SVG, 40–64px: a rounded square head (`--accent-soft` fill, 2px
   `--accent` stroke), two 6px eyes, a 2px antenna with a 4px dot, a small smile arc. Placed at the station it works.
   Never an emoji, never a face photo.
3. **The owner stop**: the single gold circle on the route, with a small standing figure (head circle + shoulders
   arc) in `--ink` beside it and the label `OWNER APPROVES` in mono.
4. **The placard**: a `--surface` block with a 1.5px `--subtle` border and the 6px `--accent-deep` shadow plate,
   holding the hero number or the checklist; a 72×8px `--gold` bar at its top-left.
5. **The title strip**: a 96px band along the bottom in `--surface` above a 1.5px `--subtle` rule: the Operations
   Director logo (inline SVG, `currentColor: var(--accent)`, 48px) and the word-mark "Operations Director" in DM Sans
   700 22px on the left; on the right in mono 13px `--ink-faint`: `SOURCE · <where the facts came from>` and
   `operationsdirector.co.uk`. The strip is the signature; no person's name ever appears.

## Do / Don't

- **Do** put every required line of text on the picture exactly as given, UK spelling, sentence case.
- **Do** let the route or the placard carry the layout; one dense zone, one breathing zone of plain grid.
- **Do** draw at least four small props of the office world (a tray, a stamp, a clip, a folder, a clock face) in
  1.5px `--ink-muted` line: detail density reads as crafted.
- **Do** keep the owner's gold to one stop or one highlight per canvas.
- **Do** end with the title strip and the source line; the source is part of the design.
- **Don't** use any colour outside this file, any font but DM Sans and DM Mono, or any emoji.
- **Don't** write a person's name or show a face; the brand is Operations Director.
- **Don't** invent a figure to fill a placard: if the brief has no number, the placard holds the agent's name.
- **Don't** produce rounded cards in a symmetric grid on a flat ground; that is the slop the method exists to avoid.
- **Don't** mention Runpreneur, running or any other brand.

## CSS tokens (paste into skeleton)

```css
:root {
  --canvas-w:1080px; --canvas-h:1350px;
  --bg:#F1F3EF; --surface:#FBFBF9; --surface-2:#F4F6F1; --subtle:#E5E8E1; --deep:#263330;
  --ink:#1C2422; --ink-muted:#5A6660; --ink-faint:#8A928C;
  --accent:#2C6E49; --accent-deep:#1B4A30; --accent-soft:#DDE8DF; --gold:#C6A15B;
  --chart-1:#2C6E49; --chart-2:#B8933A; --chart-3:#5A86CF; --chart-4:#8B6FAE; --de-emphasis:#DDE1D9;
  --font-display:'DM Sans',sans-serif; --font-body:'DM Sans',sans-serif; --font-mono:'DM Mono',monospace;
  --space-1:8px; --space-2:16px; --space-3:24px; --space-4:40px; --space-5:64px;
  --radius:8px;
}
html, body { background:var(--bg); }
body { font-family:var(--font-body); color:var(--ink); }
h1, .display { font-family:var(--font-display); font-weight:700; letter-spacing:-.01em; line-height:1.02; }
.mono { font-family:var(--font-mono); text-transform:uppercase; letter-spacing:.06em; }
.grid-bg { background-image:linear-gradient(var(--subtle) 1px, transparent 1px), linear-gradient(90deg, var(--subtle) 1px, transparent 1px); background-size:40px 40px; }
.placard { background:var(--surface); border:1.5px solid var(--subtle); border-radius:var(--radius); position:relative; }
.placard::before { content:''; position:absolute; left:24px; top:-4px; width:72px; height:8px; background:var(--gold); }
.plate { box-shadow:6px 6px 0 var(--accent-deep); }
.strip { position:absolute; left:0; right:0; bottom:0; height:96px; background:var(--surface); border-top:1.5px solid var(--subtle); display:flex; align-items:center; justify-content:space-between; padding:0 56px; }
```

The Operations Director logo, for the title strip (inline, sized by the wrapper, coloured by `currentColor`):

```html
<span class="logo" style="width:48px;height:48px;color:var(--accent);display:inline-block">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" role="img" aria-label="Operations Director" width="100%" height="100%">
  <path d="M52 20 H20 V84 H72 V32" stroke="currentColor" stroke-width="7" stroke-linecap="butt" stroke-linejoin="miter"/>
  <path d="M62 32 L72 20 L82 32 Z" fill="currentColor"/>
  <path d="M 46.00 40.40 L 47.45 40.49 L 49.62 36.93 L 54.10 38.78 L 53.11 42.83 L 54.20 43.80 L 55.17 44.89 L 59.22 43.90 L 61.07 48.38 L 57.51 50.55 L 57.60 52.00 L 57.51 53.45 L 61.07 55.62 L 59.22 60.10 L 55.17 59.11 L 54.20 60.20 L 53.11 61.17 L 54.10 65.22 L 49.62 67.07 L 47.45 63.51 L 46.00 63.60 L 44.55 63.51 L 42.38 67.07 L 37.90 65.22 L 38.89 61.17 L 37.80 60.20 L 36.83 59.11 L 32.78 60.10 L 30.93 55.62 L 34.49 53.45 L 34.40 52.00 L 34.49 50.55 L 30.93 48.38 L 32.78 43.90 L 36.83 44.89 L 37.80 43.80 L 38.89 42.83 L 37.90 38.78 L 42.38 36.93 L 44.55 40.49 Z M 52.60 52.00 A 6.6 6.6 0 1 0 39.40 52.00 A 6.6 6.6 0 1 0 52.60 52.00 Z" fill="currentColor" fill-rule="evenodd"/>
</svg></span>
```
