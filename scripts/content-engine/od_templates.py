"""Content Engine, Operations Director lane: the TEMPLATE LIBRARY (pictures v6, Kevin 10 Sep 2026: "all of the infographics
now for each post are following exactly the same format ... I want enough significant variation in the infographics to make
them look useful and classy").

v5 drew every post with one function: banner, icon rows, hero pill, rule box, guide band. Ten posts, one look. This module
holds TEN layout families with genuinely different geometry, all in the same brand: DM Sans, the sage palette, the gold
rule above every panel, the corner ticks, the title strip. Variation is in the SHAPE of the picture, consistency is in the
ink.

  columns    two ways of covering the same work        comparison
  fork       one moment, two roads                     decision
  staircase  steps that build to an end state           sequence
  loop       something that goes round again            cycle
  phases     set it up once, then it runs               phases
  dial       one instrument, one reading                interval
  ring       a part of a whole                          share
  conveyor   work moving through stages in order        pipeline
  hub        several sources feeding one agent          fan_in
  bins       sorting into named groups                  classification
  ladder     signs you score yourself against           scored_list
  grid       a set of equal points, no order            list

Kevin, 10 Sep 2026, on the first ten: "pick the correct style for the correct post ... you don't want to pick the wrong
infographic type for a post and try and make it fit." So the template is chosen by WHAT THE POST IS. Six carry a hard
content test and only win when the words really are that shape; the rest are general and rotate for variety. On the ten
posts of 7-18 Sep the picker chose ten different layouts with no calendar input at all.

The 8 Sep rule holds: CODE draws the layout, the model supplies only the words. Nothing is composed by a model, so nothing
can be placed on top of a line of text. Every template is gated by the same mechanical preflight (epic/scripts/check.mjs)
before its PNG is rendered.
"""
import html, json, math, os, re, subprocess, tempfile

import od_board as B

W, H = B.W, B.H
STRIP_TOP = B.STRIP_TOP
BOTTOM = STRIP_TOP - 36          # nothing is drawn below this
esc = B.esc

# Kevin, 10 Sep 2026, on the first ten: "pick the correct style for the correct post ... you don't want to pick the wrong
# infographic type for a post and try and make it fit, as it won't look very good."
#
# So the template is chosen by WHAT THE POST IS, not by which week it is. Six templates carry a hard content test and only
# ever win when the words really are that shape (GATED). The rest are general and rotate for variety among themselves.
# The order below is the preference order per weekday shape: the most specific first, the safe default last.
PREFER = {
    "before_after": ["columns", "fork"],
    "steps":        ["phases", "loop", "staircase"],
    "stat":         ["ring", "dial"],
    "flow":         ["hub", "conveyor"],
    "checklist":    ["bins", "ladder", "grid"],
}
# A gated template beats a general one whenever its test passes, because a specific fit always reads better than a
# competent default. A general template is interchangeable with its peers, so those rotate week to week.
GATED = {"phases", "loop", "ring", "hub", "bins", "ladder"}
TEMPLATES = sorted({t for ts in PREFER.values() for t in ts})
SUITS = PREFER          # the old name, kept for callers

# What the model may name in its enrichment. One figure, one template: the model says what KIND of thing the post is and
# code decides whether the words can actually carry it.
FIGURES = {"comparison": "columns", "decision": "fork", "sequence": "staircase", "cycle": "loop", "phases": "phases",
           "interval": "dial", "share": "ring", "pipeline": "conveyor", "fan_in": "hub", "classification": "bins",
           "scored_list": "ladder", "list": "grid"}

WORD_NUM = {"two": 2, "three": 3, "four": 4, "2": 2, "3": 3, "4": 4}


def _words(ctx):
    return " ".join([ctx.get("title", ""), ctx.get("standfirst", ""), ctx.get("rule", "")]).lower()


def _all_text(ctx):
    return (_words(ctx) + " " + " ".join((i.get("head", "") + " " + i.get("detail", "")) for i in ctx["items"])
            + " " + str(ctx.get("hero", {}).get("value", "")) + " " + str(ctx.get("hero", {}).get("label", ""))).lower()


def is_share(ctx):
    """A part of a whole: 95%, 9 of 10. Only these can honestly be drawn as a ring."""
    v = str(ctx.get("hero", {}).get("value", "")).strip()
    return bool(re.match(r"^\d{1,3}\s*%$", v) or re.match(r"^\d+\s*of\s*\d+$", v, re.I))


def is_reading(ctx):
    """An instrument reading: an interval, a rate, a count with a unit. A dial is honest for these and nothing else."""
    v = str(ctx.get("hero", {}).get("value", "")).strip()
    return bool(v) and not is_share(ctx) and bool(re.search(r"\d", v)) and len(v) <= 16


def repeats(ctx):
    """The words say the thing goes round again. Without that, a ring of steps tells the reader a lie about the method."""
    return bool(re.search(r"\b(every time|each time|again and again|round again|cycle|loop|repeats?|continuous)\b", _words(ctx)))


def names_sources(ctx):
    """Several inputs feeding one agent, which is what a hub draws. A sequential workflow is not that."""
    return bool(re.search(r"\b(\d+|two|three|four|five)\s+(sources|inputs|feeds|places|systems)\b", _all_text(ctx)))


def group_count(ctx):
    """How many named groups the post sorts things into. 0 when it does not sort anything."""
    m = re.search(r"\b(two|three|four|2|3|4)[\s-]*(groups?|buckets?|lists?|categories|piles?|columns?|types?)\b", _words(ctx))
    if m:
        return WORD_NUM.get(m.group(1), 3)
    if re.search(r"\b(group one|group 1)\b", _all_text(ctx)):
        return 3
    return 0


def has_score(ctx):
    """The reader scores themselves against the list, which is what the ladder's meter is for."""
    return bool(ctx.get("hero", {}).get("value")) and bool(re.search(r"\bscore|signs|tick|how many\b", _all_text(ctx)))


def two_sides(ctx):
    spec = ctx.get("spec") or {}
    return len(spec.get("before") or []) >= 2 and len(spec.get("after") or []) >= 2


def phase_split(ctx):
    """Where the reader's setup stops and the agent's running starts: the first item whose subject is the agent.
    Returns 0 when the method never hands over, which means `phases` must not be used."""
    items = ctx["items"]
    for i, it in enumerate(items):
        if i >= 2 and re.match(r"^(the )?agent\b", it.get("head", "").strip(), re.I):
            return i
    return 0


REQUIRES = {
    "columns":   lambda c: two_sides(c) and len(c["items"]) >= 4,
    "fork":      lambda c: two_sides(c) and len(c["items"]) >= 4,
    "staircase": lambda c: len(c["items"]) >= 3,
    "loop":      lambda c: len(c["items"]) >= 3 and repeats(c),
    "phases":    lambda c: phase_split(c) >= 2 and len(c["items"]) - phase_split(c) >= 1,
    "dial":      lambda c: is_reading(c),
    "ring":      lambda c: is_share(c),
    "conveyor":  lambda c: 3 <= len(c["items"]) <= 6,
    "hub":       lambda c: len(c["items"]) >= 4 and names_sources(c),
    "bins":      lambda c: group_count(c) >= 2 and len(c["items"]) >= group_count(c),
    "ladder":    lambda c: len(c["items"]) >= 4 and has_score(c),
    "grid":      lambda c: len(c["items"]) >= 4,
}

EXTRA_CSS = """
.card { position:absolute; background:var(--surface); border:1.5px solid var(--subtle); border-radius:var(--radius); }
.card.dashed { background:var(--surface-2); border-style:dashed; }
.card.gold { border-color:var(--gold); background:#F8F3E8; }
.rulebar { position:absolute; left:24px; top:-4px; width:72px; height:8px; background:var(--gold); }
.band { position:absolute; background:var(--deep); border-radius:var(--radius); color:var(--surface); }
.band .v { font-family:var(--font-display); font-weight:700; color:var(--gold); line-height:1; }
.band .l { font-family:var(--font-mono); text-transform:uppercase; letter-spacing:.06em; font-size:12px; color:#A9B5AE; margin-top:8px; }
.band .r { font-size:20px; line-height:1.35; color:var(--surface); }
.chip { position:absolute; padding:6px 16px; border-radius:6px; font-family:var(--font-mono); text-transform:uppercase; letter-spacing:.06em; font-size:13px; }
.chip.sage { background:var(--accent); color:var(--surface); }
.chip.grey { background:var(--de-emphasis); color:var(--ink-muted); }
.chip.gold { background:var(--gold); color:var(--surface); }
.hd { font-weight:700; line-height:1.15; color:var(--ink); }
.dt { font-size:15px; line-height:1.34; color:var(--ink-muted); font-style:italic; margin-top:4px; }
.num { position:absolute; border-radius:999px; background:var(--accent); color:var(--surface); font-family:var(--font-mono);
       font-weight:500; display:flex; align-items:center; justify-content:center; }
.num.gold { background:var(--gold); }
.tickbox { border:2.5px solid var(--accent); border-radius:5px; }
"""


# ---------- page shell ----------

def _shell():
    base = open(B.SCAFFOLD).read()
    head = base.split("<body>")[0]
    symbols = base.split('<svg width="0" height="0" style="position:absolute">')[1].split("</svg>")[0]
    return head.replace("</style>", EXTRA_CSS + "</style>"), symbols


def page(parts, source, doc_title):
    head, symbols = _shell()
    body = ['<svg width="0" height="0" style="position:absolute">%s</svg>' % symbols,
            '<svg class="tick" style="left:24px;top:24px" viewBox="0 0 16 16"><path d="M8 0v16M0 8h16" stroke="currentColor" stroke-width="1.2"/></svg>',
            '<svg class="tick" style="left:1040px;top:24px" viewBox="0 0 16 16"><path d="M8 0v16M0 8h16" stroke="currentColor" stroke-width="1.2"/></svg>']
    body += [p for p in parts if p]
    body += [B.strip(source), '<div class="grain"></div>']
    out = head + '<body>\n<div class="canvas">\n' + "\n".join(body) + "\n</div>\n</body>\n</html>\n"
    return out.replace("<title>Operations Director picture</title>", "<title>%s</title>" % esc(doc_title))


def fit(text, box_w, box_h, sizes, lh=1.18):
    """The largest size in `sizes` (biggest first) whose wrapped text still fits the box. Nothing is ever clipped."""
    for s in sizes:
        per_line = max(1, int(box_w / (s * 0.52)))
        lines = max(1, -(-len(text) // per_line))
        if lines * s * lh <= box_h:
            return s
    return sizes[-1]


def card(x, y, w, h, inner, cls="", hero=False, pad="20px 24px", rule=True):
    return ('<div class="card %s" style="left:%dpx;top:%dpx;width:%dpx;height:%dpx;padding:%s"%s>%s%s</div>'
            % (cls, x, y, w, h, pad, " data-hero" if hero else "", '<div class="rulebar"></div>' if rule else "", inner))


def head_detail(head_text, detail, w, size=None):
    s = size or fit(head_text, w, 60, [22, 20, 18, 17])
    out = '<div class="hd" style="font-size:%dpx">%s</div>' % (s, esc(head_text))
    if detail:
        out += '<div class="dt">%s</div>' % esc(detail)
    return out


def band(x, y, w, h, value, label, right_text):
    """The dark closing band: the picture's one number in gold on the left, the rule in plain words on the right."""
    vsize = 56 if len(value) <= 7 else (40 if len(value) <= 14 else 28)
    left = ('<div style="flex:0 0 344px"><div class="v" style="font-size:%dpx">%s</div><div class="l">%s</div></div>'
            % (vsize, esc(value), esc(label))) if value else ""
    div = '<div style="flex:0 0 1px;height:%dpx;background:#4A5A54"></div>' % (h - 56) if value and right_text else ""
    right = '<div class="r" style="flex:1;font-size:%dpx">%s</div>' % (fit(right_text, w - 444, h - 48, [21, 19, 17, 16], 1.35), esc(right_text)) if right_text else ""
    return ('<div class="band" style="left:%dpx;top:%dpx;width:%dpx;height:%dpx;padding:0 34px;display:flex;align-items:center;gap:30px">%s%s%s</div>'
            % (x, y, w, h, left, div, right))


def guide_row(x, y, w, steps, label=None):
    cells = "".join('<div style="flex:1;min-width:0;display:flex;gap:10px;align-items:flex-start">'
                    '<span class="num" style="position:static;width:28px;height:28px;font-size:13px;flex:0 0 28px">%d</span>'
                    '<span style="font-size:15px;line-height:1.3;color:var(--ink)">%s</span></div>' % (i + 1, esc(t))
                    for i, t in enumerate(steps))
    chip = ('<div class="chip sage" style="position:relative;display:inline-block;left:0;top:0">%s</div>' % esc(label or ("%d-step guide" % len(steps))))
    return ('<div class="abs" style="left:%dpx;top:%dpx;width:%dpx">%s'
            '<div class="card" style="position:relative;width:%dpx;margin-top:14px;padding:20px 22px;display:flex;gap:18px;background:var(--surface-2)">%s</div></div>'
            % (x, y, w, chip, w, cells))


def arrow(x, y, w=60, h=40, down=False, colour="var(--accent)"):
    if down:
        return ('<svg class="abs" style="left:%dpx;top:%dpx;width:%dpx;height:%dpx" viewBox="0 0 40 60">'
                '<path d="M20 2 V38" stroke="%s" stroke-width="8" stroke-linecap="round"/><path d="M6 30 L20 56 L34 30 Z" fill="%s"/></svg>'
                % (x, y, h, w, colour, colour))
    return ('<svg class="abs" style="left:%dpx;top:%dpx;width:%dpx;height:%dpx" viewBox="0 0 60 40">'
            '<path d="M2 20 H40" stroke="%s" stroke-width="8" stroke-linecap="round"/><path d="M32 6 L56 20 L32 34 Z" fill="%s"/></svg>'
            % (x, y, w, h, colour, colour))


# ---------- the ten templates ----------
# Every one takes (ctx, y) where y is the first free pixel under the brand header, and returns a list of html parts.
# Two rules hold everywhere: the closing band is pinned to the bottom of the canvas so no picture ends in an empty third,
# and text is never cut mid-word (trim() cuts on a space, so a reader never sees "whic" or "the out").

NO_STANDFIRST = {"fork"}          # these templates put the standfirst inside the picture, so the header must not repeat it


def trim(text, n):
    """Cut on a word boundary. A half-word reads as a rendering fault, which is exactly what this library exists to stop."""
    t = str(text or "").strip()
    if len(t) <= n:
        return t
    return t[:n].rsplit(" ", 1)[0].rstrip(" ,;:.") if " " in t[:n] else t[:n]


def whole(text, n):
    """A detail line is shown WHOLE or not at all. A cut on a word boundary still reads as an unfinished sentence,
    which is the same public defect as a clipped one."""
    t = str(text or "").strip()
    return t if len(t) <= n else ""


def row(height, icon_html, head_text, detail, text_w, sizes=(22, 20, 18, 17), last=False, detail_chars=None):
    """One stretched row with its content centred, so a tall row never leaves a gap under the words."""
    det = trim(detail, detail_chars) if detail_chars else (detail or "")
    return ('<div style="display:flex;gap:16px;align-items:center;height:%dpx;border-bottom:%s">%s'
            '<div style="min-width:0;flex:1">%s</div></div>'
            % (height, "0" if last else "1px dashed var(--subtle)", icon_html,
               head_detail(head_text, det, text_w, size=fit(head_text, text_w, max(30, height // 2), list(sizes)))))


def t_columns(ctx, y):
    """Two lanes, by hand and with an agent, closed by a dark cost band. For the Monday mistake."""
    items = ctx["items"]; n = max(1, len(items))
    half = n // 2 if n >= 4 else max(1, n - 1)
    left, right = items[:half], items[half:]
    rows = max(len(left), len(right), 1)
    band_h = 150; band_y = BOTTOM - band_h
    top = y + 46
    panel_h = band_y - 26 - top
    row_h = (panel_h - 34) // rows

    def lane(x, its, plate, icon):
        body = "".join(row(row_h, B.icon_svg(it.get("icon") or icon, 42, "var(--accent)" if plate else "var(--ink-faint)"),
                           it.get("head", ""), it.get("detail", ""), 320, last=(i == len(its) - 1))
                       for i, it in enumerate(its))
        return card(x, top, 472, panel_h, body, cls="plate" if plate else "dashed", hero=plate, pad="16px 22px")

    return ['<div class="chip grey" style="left:56px;top:%dpx">%s</div>' % (y, esc(ctx.get("left_label") or "By hand")),
            '<div class="chip sage" style="left:552px;top:%dpx">%s</div>' % (y, esc(ctx.get("right_label") or "With an agent")),
            lane(56, left, False, "cross"), lane(552, right, True, "tick"),
            arrow(506, top + panel_h // 2 - 20, 68, 40),
            band(56, band_y, 968, band_h, ctx["hero"].get("value", ""), ctx["hero"].get("label", ""), ctx.get("rule", ""))]


def t_fork(ctx, y):
    """One moment, two roads: the hire in grey, the agent in sage. For the Monday mistake."""
    items = ctx["items"]; half = max(1, len(items) // 2)
    left, right = items[:half], items[half:]
    band_h = 132; band_y = BOTTOM - band_h
    node_y = y + 4; node_h = 92
    split = node_y + node_h + 14
    lane_top = split + 96
    lane_h = band_y - 26 - lane_top
    road = ('<svg class="abs route" viewBox="0 0 %d %d" aria-hidden="true">'
            '<path d="M540 %d Q540 %d 292 %d" stroke="var(--de-emphasis)" stroke-width="14" fill="none" stroke-linecap="round"/>'
            '<path d="M540 %d Q540 %d 788 %d" stroke="var(--accent)" stroke-width="14" fill="none" stroke-linecap="round"/>'
            '<path d="M276 %d L292 %d L308 %d Z" fill="var(--de-emphasis)"/><path d="M772 %d L788 %d L804 %d Z" fill="var(--accent)"/>'
            '</svg>' % (W, H, split, split + 58, lane_top - 14, split, split + 58, lane_top - 14,
                        lane_top - 30, lane_top - 4, lane_top - 30, lane_top - 30, lane_top - 4, lane_top - 30))
    node_text = ctx.get("standfirst") or ctx.get("rule") or ctx.get("title", "")

    def lane(x, its, sage, label):
        rh = (lane_h - 78) // max(1, len(its))
        rows = "".join(row(rh, B.icon_svg(it.get("icon") or ("tick" if sage else "cross"), 38,
                                          "var(--accent)" if sage else "var(--ink-faint)"),
                           it.get("head", ""), it.get("detail", ""), 288, sizes=(20, 19, 18, 17), last=(i == len(its) - 1))
                       for i, it in enumerate(its))
        head = ('<div class="chip %s" style="position:relative;left:0;top:0;display:inline-block;margin-bottom:10px">%s</div>'
                % ("sage" if sage else "grey", esc(label)))
        return card(x, lane_top, 440, lane_h, head + rows, cls="plate" if sage else "dashed", hero=sage, pad="16px 22px")

    return [road,
            '<div class="card gold" style="left:300px;top:%dpx;width:480px;height:%dpx;padding:0 26px;display:flex;align-items:center;justify-content:center;text-align:center">'
            '<div class="rulebar"></div><div style="font-size:%dpx;font-weight:700;line-height:1.25;color:var(--ink)">%s</div></div>'
            % (node_y, node_h, fit(node_text, 420, node_h - 26, [21, 19, 18, 17], 1.25), esc(trim(node_text, 100))),
            lane(56, left, False, ctx.get("left_label") or "By hand"),
            lane(584, right, True, ctx.get("right_label") or "With an agent"),
            band(56, band_y, 968, band_h, ctx["hero"].get("value", ""), ctx["hero"].get("label", ""), ctx.get("rule", ""))]


def t_staircase(ctx, y):
    """Steps climbing to a destination, each tread indented further than the last. For the Tuesday method."""
    items = ctx["items"][:6]; n = max(1, len(items))
    band_h = 128; band_y = BOTTOM - band_h
    pitch = (band_y - 26 - y) // n
    indent = lambda i: 56 + i * 30
    risers = []
    for i in range(n):
        x0, x1 = indent(i), indent(i) + 30
        y0 = y + i * pitch + 24
        risers.append("M%d %d H%d V%d" % (x0, y0 + pitch, x1, y0))
    stair = ('<svg class="abs route" viewBox="0 0 %d %d" aria-hidden="true"><path d="%s" fill="none" stroke="var(--accent)" '
             'stroke-width="7" stroke-linecap="round" stroke-linejoin="round" opacity=".28"/></svg>' % (W, H, " ".join(risers)))
    parts = [stair]
    for i, it in enumerate(items):
        x = indent(i); yy = y + i * pitch
        last = i == n - 1
        parts.append('<div class="num%s" style="left:%dpx;top:%dpx;width:48px;height:48px;font-size:20px">%02d</div>'
                     % (" gold" if last else "", x, yy, i + 1))
        cw = 1024 - (x + 68)
        parts.append(card(x + 68, yy - 12, cw, pitch - 18,
                          '<div style="display:flex;gap:16px;align-items:center;height:100%%">%s<div style="min-width:0">%s</div></div>'
                          % (B.icon_svg(it.get("icon") or "agent", 44, "var(--gold)" if last else "var(--accent)"),
                             head_detail(it.get("head", ""), it.get("detail", ""), cw - 116)),
                          cls="gold" if last else "", hero=(i == 0), pad="12px 20px"))
    hero = ctx["hero"]; hv = hero.get("value", "")
    parts.append('<div class="band" style="left:56px;top:%dpx;width:968px;height:%dpx;padding:0 34px;display:flex;align-items:center;gap:28px">'
                 '<svg style="width:46px;height:46px;flex:0 0 46px" viewBox="0 0 40 40"><use href="#agent" width="40" height="40"/></svg>'
                 '<div style="flex:0 0 268px"><div class="v" style="font-size:%dpx">%s</div><div class="l">%s</div></div>'
                 '<div style="flex:0 0 1px;height:%dpx;background:#4A5A54"></div>'
                 '<div class="r" style="flex:1;font-size:19px">%s</div></div>'
                 % (band_y, band_h, 44 if len(hv) <= 12 else 28, esc(hv), esc(whole(hero.get("label", ""), 46) or hero.get("label", "")[:46]),
                    band_h - 44, esc(ctx.get("rule", ""))))
    return parts


def t_loop(ctx, y):
    """A cycle that keeps running, with the payoff in the middle. For the Tuesday method."""
    items = ctx["items"][:6]; n = max(3, len(items))
    band_h = 126; band_y = BOTTOM - band_h
    ring_top = y + 6
    ring_h = band_y - 26 - ring_top
    cy = ring_top + ring_h // 2
    rx = 176; ry = min(300, ring_h // 2 - 46)
    ring = ('<svg class="abs route" viewBox="0 0 %d %d" aria-hidden="true">'
            '<ellipse cx="540" cy="%d" rx="%d" ry="%d" fill="none" stroke="var(--accent-soft)" stroke-width="14"/>'
            '<ellipse cx="540" cy="%d" rx="%d" ry="%d" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="10 12"/>'
            '<path d="M526 %d l14 -20 l14 20 Z" fill="var(--accent)"/></svg>'
            % (W, H, cy, rx, ry, cy, rx, ry, cy - ry - 10))
    parts = [ring]
    rows = max(2, -(-n // 2))
    angle = lambda k: math.radians(30 + k * (120.0 / max(1, rows - 1)))
    order = [(i < rows, i if i < rows else (n - 1 - i)) for i in range(n)]
    slot_h = (2 * ry) // max(1, rows - 1)
    for i, it in enumerate(items[:n]):
        rightside, k = order[i]
        a = angle(k)
        ny = int(cy - ry * math.cos(a))
        nx = 540 + (rx * math.sin(a)) * (1 if rightside else -1)
        parts.append('<div class="num" style="left:%dpx;top:%dpx;width:46px;height:46px;font-size:19px">%02d</div>'
                     % (int(nx) - 23, ny - 23, i + 1))
        tw = 268; tx = 756 if rightside else 56
        head = trim(it.get("head", ""), 46)
        hs = fit(head, tw, 72, [20, 18, 17, 16])
        det = whole(it.get("detail", ""), 112)
        box_h = int(hs * 1.2 * max(1, -(-len(head) // max(1, int(tw / (hs * 0.52)))))) + (44 if det else 0)
        parts.append('<div class="abs" style="left:%dpx;top:%dpx;width:%dpx;text-align:%s">'
                     '<div class="hd" style="font-size:%dpx">%s</div>%s</div>'
                     % (tx, ny - box_h // 2, tw, "left" if rightside else "right", hs, esc(head),
                        ('<div class="dt">%s</div>' % esc(det)) if det and slot_h > 150 else ""))
    hero = ctx["hero"]; hv = hero.get("value", "")
    parts.append(card(540 - 148, cy - 88, 296, 176,
                      '<div style="font-family:var(--font-display);font-weight:700;color:var(--accent);font-size:%dpx;line-height:1.06;text-align:center">%s</div>'
                      '<div class="mono" style="font-size:12px;color:var(--ink-faint);text-align:center;margin-top:12px">%s</div>'
                      % (fit(hv, 250, 84, [46, 34, 28, 22], 1.06), esc(hv), esc(trim(hero.get("label", ""), 40))),
                      cls="plate", hero=True, pad="24px 20px"))
    parts.append(band(56, band_y, 968, band_h, "", "", ctx.get("rule", "")))
    return parts


def t_dial(ctx, y):
    """One instrument, one reading, with the method beside it. For the Wednesday build log."""
    hero = ctx["hero"]; value = hero.get("value", "") or str(ctx.get("spec", {}).get("number", ""))
    band_h = 140; band_y = BOTTOM - band_h
    top = y + 6
    body_h = band_y - 26 - top
    d = min(440, body_h - 20)
    dial_y = top + (body_h - d) // 2
    ticks = "".join('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="var(--accent)" stroke-width="%d" stroke-linecap="round"/>'
                    % (215 + 176 * math.cos(a * math.pi / 180), 215 + 176 * math.sin(a * math.pi / 180),
                       215 + (152 if i % 3 else 140) * math.cos(a * math.pi / 180), 215 + (152 if i % 3 else 140) * math.sin(a * math.pi / 180),
                       3 if i % 3 else 5)
                    for i, a in enumerate(range(-90, 270, 15)))
    vsize = fit(value, 232, 96, [84, 66, 50, 38], 1.0)
    dial = ('<svg class="abs" style="left:56px;top:%dpx;width:%dpx;height:%dpx" viewBox="0 0 430 430">'
            '<circle cx="215" cy="215" r="205" fill="var(--surface)" stroke="var(--subtle)" stroke-width="2"/>'
            '<circle cx="215" cy="215" r="196" fill="none" stroke="var(--accent-soft)" stroke-width="16"/>'
            '<path d="M215 19 A196 196 0 0 1 411 215" fill="none" stroke="var(--accent)" stroke-width="16" stroke-linecap="round"/>'
            '%s<circle cx="215" cy="215" r="122" fill="var(--surface)" stroke="var(--subtle)" stroke-width="1.5"/>'
            '<circle cx="411" cy="215" r="13" fill="var(--gold)" stroke="var(--surface)" stroke-width="3"/></svg>'
            % (dial_y, d, d, ticks))
    cx = 56 + d // 2; cyy = dial_y + d // 2
    reading = ('<div class="abs" style="left:%dpx;top:%dpx;width:232px;text-align:center" data-hero>'
               '<div style="font-family:var(--font-display);font-weight:700;font-size:%dpx;line-height:1;color:var(--accent);letter-spacing:-.02em">%s</div>'
               '<div style="font-size:16px;line-height:1.3;color:var(--ink);margin-top:12px">%s</div></div>'
               % (cx - 116, cyy - (vsize // 2) - 24, vsize, esc(value), esc(trim(hero.get("label", ""), 44))))
    gx = 56 + d + 34; gw = 1024 - gx
    steps = [t for t in (ctx.get("guide") or [i.get("head", "") for i in ctx["items"]]) if t][:5]
    rh = (body_h - 56) // max(1, len(steps))
    rows = "".join('<div style="display:flex;gap:14px;align-items:center;height:%dpx;border-bottom:%s">'
                   '<span class="num" style="position:static;width:34px;height:34px;font-size:15px;flex:0 0 34px">%02d</span>'
                   '<span style="font-size:%dpx;line-height:1.3;color:var(--ink)">%s</span></div>'
                   % (rh, "0" if i == len(steps) - 1 else "1px dashed var(--subtle)", i + 1,
                      fit(t, gw - 116, rh - 16, [20, 19, 18, 17], 1.3), esc(t))
                   for i, t in enumerate(steps))
    return [dial, reading,
            card(gx, top, gw, body_h,
                 '<div class="mono" style="font-size:12px;color:var(--ink-faint);margin-bottom:8px">How you get there</div>%s' % rows,
                 pad="14px 22px"),
            band(56, band_y, 968, band_h, "", "", ctx.get("rule", ""))]


def t_ring(ctx, y):
    """A share of a whole: the figure drawn as a ring, what earns it beside, the guide across the foot."""
    hero = ctx["hero"]; value = (hero.get("value", "") or "").strip()
    m = re.match(r"^(\d{1,3})\s*%$", value) or re.match(r"^(\d+)\s*of\s*(\d+)$", value, re.I)
    if m and m.lastindex == 2:
        pct = max(4, min(100, int(round(100.0 * int(m.group(1)) / max(1, int(m.group(2)))))))
    elif m:
        pct = max(4, min(100, int(m.group(1))))
    else:
        pct = 78
    guide = [g for g in (ctx.get("guide") or []) if g][:5]
    guide_h = 130 if guide else 0
    guide_y = BOTTOM - guide_h
    band_h = 126
    band_y = (guide_y - 26 if guide else BOTTOM) - band_h
    top = y + 6
    body_h = band_y - 26 - top
    d = min(400, body_h - 10)
    ring_y = top + (body_h - d) // 2
    r = 158; circ = 2 * math.pi * r
    ringsvg = ('<svg class="abs" style="left:56px;top:%dpx;width:%dpx;height:%dpx" viewBox="0 0 400 400">'
               '<circle cx="200" cy="200" r="%d" fill="none" stroke="var(--de-emphasis)" stroke-width="40"/>'
               '<circle cx="200" cy="200" r="%d" fill="none" stroke="var(--accent)" stroke-width="40" '
               'stroke-dasharray="%.1f %.1f" transform="rotate(-90 200 200)"/>'
               '<circle cx="200" cy="200" r="%d" fill="none" stroke="var(--gold)" stroke-width="6" stroke-dasharray="4 10" opacity=".8"/></svg>'
               % (ring_y, d, d, r, r, circ * pct / 100.0, circ, r - 26))
    vsize = fit(value, 210, 86, [72, 52, 40, 30], 1.0)
    cx = 56 + d // 2; cyy = ring_y + d // 2
    reading = ('<div class="abs" style="left:%dpx;top:%dpx;width:210px;text-align:center" data-hero>'
               '<div style="font-family:var(--font-display);font-weight:700;font-size:%dpx;line-height:1;color:var(--accent)">%s</div>'
               '<div style="font-size:15px;line-height:1.3;color:var(--ink-muted);margin-top:8px">%s</div></div>'
               % (cx - 105, cyy - (vsize // 2) - 20, vsize, esc(value), esc(trim(hero.get("label", ""), 40))))
    gx = 56 + d + 30; gw = 1024 - gx
    items = ctx["items"][:5]
    rh = (body_h - 40) // max(1, len(items))
    rows = "".join(row(rh, B.icon_svg(it.get("icon") or "agent", 40), it.get("head", ""), it.get("detail", ""),
                       gw - 120, sizes=(20, 19, 18, 17), last=(i == len(items) - 1))
                   for i, it in enumerate(items))
    parts = [ringsvg, reading, card(gx, top, gw, body_h, rows, pad="14px 20px"),
             band(56, band_y, 968, band_h, "", "", ctx.get("rule", ""))]
    if guide:
        parts.append(guide_row(56, guide_y, 968, guide))
    return parts


def t_conveyor(ctx, y):
    """A snake of chevrons with the owner's gold gate on the one box that is theirs. For the Thursday workflow."""
    items = ctx["items"][:6]; n = max(1, len(items))
    human = ctx.get("human", -1)
    band_h = 138; band_y = BOTTOM - band_h
    top = y + 8
    body_h = band_y - 26 - top
    per_row = 3 if n > 2 else n
    rows = -(-n // per_row)
    cw, gap, vgap = 280, 64, 66
    ch = (body_h - (rows - 1) * vgap) // rows
    parts = []
    for i, it in enumerate(items):
        r_i = i // per_row
        col = i % per_row
        rev = bool(r_i % 2)
        if rev:
            col = per_row - 1 - col
        x = 56 + col * (cw + gap)
        yy = top + r_i * (ch + vgap)
        gold = (i == human)
        parts.append(card(x, yy, cw, ch,
                          '<div style="display:flex;flex-direction:column;justify-content:center;height:100%%">'
                          '<div style="display:flex;gap:10px;align-items:center"><span class="num%s" style="position:static;width:32px;height:32px;font-size:14px;flex:0 0 32px">%02d</span>%s</div>'
                          '<div style="margin-top:14px">%s</div></div>'
                          % (" gold" if gold else "", i + 1,
                             B.icon_svg("person" if gold else (it.get("icon") or "agent"), 38, "var(--gold)" if gold else "var(--accent)"),
                             head_detail(it.get("head", ""), it.get("detail", ""), cw - 44,
                                         size=fit(it.get("head", ""), cw - 44, 56, [20, 18, 17]))),
                          cls="gold" if gold else "", hero=(i == 0), pad="16px 18px"))
        nxt = i + 1
        if nxt < n and nxt // per_row == r_i:
            parts.append(chevron(x + cw + 8 if not rev else x - gap - 4, yy + ch // 2 - 20, left=rev))
        elif nxt < n:
            parts.append(arrow(x + cw // 2 - 20, yy + ch + 10, 40, 48, down=True))
    hero = ctx["hero"]
    parts.append(band(56, band_y, 968, band_h, hero.get("value", ""), hero.get("label", ""), ctx.get("rule", "")))
    return parts


def chevron(x, y, left=False):
    d = "M56 6 L4 20 L56 34" if left else "M4 6 L56 20 L4 34"
    tail = "M56 20 H16" if left else "M4 20 H44"
    return ('<svg class="abs" style="left:%dpx;top:%dpx;width:60px;height:40px" viewBox="0 0 60 40">'
            '<path d="%s" stroke="var(--accent)" stroke-width="8" stroke-linecap="round"/>'
            '<path d="%s" fill="var(--accent)"/></svg>'
            % (x, y, tail, ("M18 6 L2 20 L18 34 Z" if left else "M42 6 L58 20 L42 34 Z")))


def t_hub(ctx, y):
    """Sources in, one agent, one output, the owner's gate on the last step. For the Thursday workflow."""
    items = ctx["items"][:6]
    human = ctx.get("human", -1)
    sources = [it for i, it in enumerate(items) if i != human][:4]
    out_item = items[human] if 0 <= human < len(items) else (items[-1] if items else {"head": "The output"})
    band_h = 132; band_y = BOTTOM - band_h
    top = y + 8
    body_h = band_y - 26 - top
    n = max(1, len(sources))
    sh = (body_h - (n - 1) * 20) // n
    parts = []
    hub_cx, hub_cy = 660, top + body_h // 2
    curves = []
    for i, it in enumerate(sources):
        yy = top + i * (sh + 20)
        parts.append(card(56, yy, 336, sh,
                          '<div style="display:flex;gap:12px;align-items:center;height:100%%">%s<div style="min-width:0">%s</div></div>'
                          % (B.icon_svg(it.get("icon") or "inbox", 38),
                             head_detail(it.get("head", ""), whole(it.get("detail", ""), 96), 220, size=18)),
                          pad="12px 16px"))
        curves.append('<path d="M392 %d C480 %d, 500 %d, 566 %d" fill="none" stroke="var(--accent)" stroke-width="5" opacity=".5"/>'
                      % (yy + sh // 2, yy + sh // 2, hub_cy, hub_cy))
    parts.append('<svg class="abs route" viewBox="0 0 %d %d" aria-hidden="true">%s</svg>' % (W, H, "".join(curves)))
    parts.append('<svg class="abs" style="left:%dpx;top:%dpx;width:188px;height:188px" viewBox="0 0 188 188">'
                 '<circle cx="94" cy="94" r="92" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="3"/>'
                 '<use href="#agent" x="49" y="42" width="90" height="90"/></svg>' % (hub_cx - 94, hub_cy - 94))
    parts.append('<div class="abs mono" style="left:%dpx;top:%dpx;width:188px;text-align:center;font-size:12px;color:var(--accent)">The agent</div>'
                 % (hub_cx - 94, hub_cy + 100))
    parts.append(chevron(hub_cx + 100, hub_cy - 20))
    ox = 790; ow = 234
    oh = min(body_h, 300)
    parts.append(card(ox, hub_cy - oh // 2, ow, oh,
                      '<div class="chip gold" style="position:relative;left:0;top:0;display:inline-block;margin-bottom:14px">Owner approves</div>%s'
                      % head_detail(out_item.get("head", ""), whole(out_item.get("detail", ""), 120), ow - 36, size=19),
                      cls="gold", hero=True, pad="16px 18px"))
    hero = ctx["hero"]
    parts.append(band(56, band_y, 968, band_h, hero.get("value", ""), hero.get("label", ""), ctx.get("rule", "")))
    return parts


def t_grid(ctx, y):
    """Numbered cards, two across, the way a good list infographic reads. For the Friday checklist."""
    items = ctx["items"][:6]; n = max(1, len(items))
    hero = ctx["hero"]
    band_h = 132; band_y = BOTTOM - band_h
    top = y + 6
    body_h = band_y - 26 - top
    cells = n + (1 if n % 2 else 0)
    rows = max(1, cells // 2)
    ch = (body_h - (rows - 1) * 24) // rows
    cw = 472
    parts = []
    for i, it in enumerate(items):
        x = 56 + (i % 2) * (cw + 24)
        yy = top + (i // 2) * (ch + 24)
        parts.append(card(x, yy, cw, ch,
                          '<div style="display:flex;gap:16px;align-items:center;height:100%%">'
                          '<div class="num" style="position:relative;left:0;top:0;width:56px;height:56px;font-size:22px;flex:0 0 56px">%02d</div>'
                          '<div style="min-width:0;flex:1">%s</div>%s</div>'
                          % (i + 1, head_detail(it.get("head", ""), it.get("detail", ""), cw - 190,
                                                size=fit(it.get("head", ""), cw - 190, 62, [21, 19, 18])),
                             B.icon_svg(it.get("icon") or "checklist", 50, "var(--accent)")),
                          hero=(i == 0), pad="18px 20px"))
    if n % 2:
        x = 56 + (n % 2) * (cw + 24); yy = top + (n // 2) * (ch + 24)
        parts.append(card(x, yy, cw, ch,
                          '<div style="display:flex;flex-direction:column;justify-content:center;height:100%%">'
                          '<div style="font-family:var(--font-display);font-weight:700;font-size:%dpx;line-height:1;color:var(--accent)">%s</div>'
                          '<div class="mono" style="font-size:12px;color:var(--ink-faint);margin-top:14px">%s</div></div>'
                          % (fit(hero.get("value", ""), 400, 70, [56, 40, 30, 24], 1.0), esc(hero.get("value", "")),
                             esc(trim(hero.get("label", ""), 52))),
                          cls="plate", pad="20px 22px"))
    parts.append(band(56, band_y, 968, band_h, "" if n % 2 else hero.get("value", ""),
                      "" if n % 2 else hero.get("label", ""), ctx.get("rule", "")))
    return parts


def t_ladder(ctx, y):
    """Rungs you tick, with a score meter climbing beside them. For the Friday checklist."""
    items = ctx["items"][:6]; n = max(1, len(items))
    hero = ctx["hero"]
    band_h = 126; band_y = BOTTOM - band_h
    top = y + 6
    panel_h = band_y - 26 - top
    lw = 806
    rh = (panel_h - 46) // n
    rows = "".join('<div style="display:flex;gap:20px;align-items:center;height:%dpx;border-bottom:%s">'
                   '<span class="tickbox" style="flex:0 0 34px;height:34px;border-color:%s"></span>'
                   '<div style="min-width:0;flex:1">%s</div></div>'
                   % (rh, "0" if i == n - 1 else "1px dashed var(--subtle)",
                      "var(--gold)" if i == n - 1 else "var(--accent)",
                      head_detail(it.get("head", ""), it.get("detail", ""), lw - 120,
                                  size=fit(it.get("head", ""), lw - 120, 58, [23, 21, 19, 18])))
                   for i, it in enumerate(items))
    mx = 56 + lw + 28; mw = 162
    seg_h = (panel_h - 120) // max(1, n)
    marks = "".join('<rect x="34" y="%d" width="52" height="%d" rx="4" fill="%s"/>'
                    % ((n - 1 - i) * seg_h, seg_h - 10,
                       "var(--gold)" if i >= n - 2 else ("var(--accent)" if i >= n - 4 else "var(--accent-soft)"))
                    for i in range(n))
    meter = ('<div class="abs" style="left:%dpx;top:%dpx;width:%dpx">'
             '<div class="mono" style="font-size:12px;color:var(--ink-faint);text-align:center">Your score</div>'
             '<div style="font-family:var(--font-display);font-weight:700;font-size:%dpx;line-height:1;color:var(--gold);text-align:center;margin-top:6px">%s</div>'
             '<svg style="width:%dpx;height:%dpx;margin-top:14px" viewBox="0 0 120 %d">%s</svg></div>'
             % (mx, top + 8, mw, fit(hero.get("value", ""), mw, 44, [38, 30, 24, 20], 1.0), esc(hero.get("value", "")),
                mw, n * seg_h, n * seg_h, marks))
    return [card(56, top, lw, panel_h,
                 '<div class="mono" style="font-size:12px;color:var(--ink-faint);margin-bottom:4px">Score yourself</div>%s' % rows,
                 cls="plate", hero=True, pad="14px 22px"),
            meter,
            band(56, band_y, 968, band_h, "", "", ctx.get("rule", ""))]


def t_bins(ctx, y):
    """Sorting into named groups. Colour runs from sage to grey across the bins, which in this content always tracks how
    much of the work the agent takes. For a checklist post whose words name groups."""
    items = ctx["items"]
    k = max(2, min(4, group_count(ctx) or 3, len(items)))   # the gate keeps this honest; the clamp keeps a direct call drawable
    bins, actions = items[:k], items[k:]
    band_h = 132; band_y = BOTTOM - band_h
    strip_h = 126 if actions else 0
    strip_y = band_y - 26 - strip_h
    top = y + 6
    # the bins absorb every spare pixel rather than leaving gaps between blocks, and their contents scale up to match,
    # so a tall column reads as a deliberate bucket instead of a half-empty card
    bin_h = band_y - 26 - top - (strip_h + 26 if actions else 0)
    strip_y = top + bin_h + 26
    bw = (968 - (k - 1) * 24) // k
    tones = ["accent", "gold", "de-emphasis", "ink-faint"]
    parts = []
    for i, it in enumerate(bins):
        x = 56 + i * (bw + 24)
        tone = tones[min(i, len(tones) - 1)]
        head = it.get("head", "")
        parts.append('<div class="abs" style="left:%dpx;top:%dpx;width:%dpx;height:%dpx;background:var(--surface);'
                     'border:1.5px solid var(--subtle);border-radius:var(--radius);overflow:hidden;display:flex;flex-direction:column"%s>'
                     '<div style="height:56px;flex:0 0 56px;background:var(--%s);display:flex;align-items:center;justify-content:center">'
                     '<span class="mono" style="font-size:13px;letter-spacing:.08em;color:%s">%s</span></div>'
                     '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:22px 20px;text-align:center">'
                     '%s<div class="hd" style="font-size:%dpx;margin-top:20px">%s</div>%s</div></div>'
                     % (x, top, bw, bin_h, " data-hero" if i == 0 else "", tone,
                        "var(--ink)" if tone == "de-emphasis" else "var(--surface)",
                        esc(ctx.get("bin_labels", ["Group one", "Group two", "Group three", "Group four"])[min(i, 3)]),
                        B.icon_svg(it.get("icon") or "agent", min(140, max(82, bin_h // 4)),
                                   "var(--accent)" if i == 0 else ("var(--gold)" if i == 1 else "var(--ink-faint)")),
                        fit(head, bw - 44, 70, [26, 23, 21, 19]), esc(head),
                        ('<div class="dt" style="margin-top:12px;font-size:16px">%s</div>' % esc(it.get("detail", ""))) if it.get("detail") else ""))
    if actions:
        rows = "".join('<div style="flex:1;min-width:0;display:flex;gap:12px;align-items:flex-start">'
                       '<span class="num" style="position:static;width:30px;height:30px;font-size:14px;flex:0 0 30px">%d</span>'
                       '<div style="min-width:0"><div class="hd" style="font-size:17px">%s</div>%s</div></div>'
                       % (i + 1, esc(a.get("head", "")),
                          ('<div class="dt" style="font-size:14px">%s</div>' % esc(a.get("detail", ""))) if a.get("detail") else "")
                       for i, a in enumerate(actions))
        parts.append('<div class="abs" style="left:56px;top:%dpx;width:968px">'
                     '<div class="chip sage" style="position:relative;left:0;top:0;display:inline-block">Then, this week</div>'
                     '<div class="card" style="position:relative;width:968px;margin-top:14px;padding:20px 24px;display:flex;gap:26px;background:var(--surface-2)">%s</div></div>'
                     % (strip_y, rows))
    parts.append(band(56, band_y, 968, band_h, ctx["hero"].get("value", ""), ctx["hero"].get("label", ""), ctx.get("rule", "")))
    return parts


def t_phases(ctx, y):
    """Set it up once, then it runs. Two bands with a turn between them, for a method where the reader's work stops and
    the agent's starts. The split is the first item whose subject is the agent acting."""
    items = ctx["items"]
    cut = phase_split(ctx) or max(1, len(items) * 2 // 3)   # the gate keeps this honest; the fallback keeps a direct call drawable
    cut = max(1, min(cut, len(items) - 1))
    setup, run = items[:cut], items[cut:]
    band_h = 126; band_y = BOTTOM - band_h
    top = y + 4
    avail = band_y - 26 - top
    turn_h = 78
    setup_h = int((avail - turn_h) * 0.48)
    run_h = avail - turn_h - setup_h
    n1 = max(1, len(setup)); cw = (968 - (n1 - 1) * 20) // n1
    parts = ['<div class="chip grey" style="left:56px;top:%dpx">Set it up once</div>' % top]
    ct = top + 42; ch = setup_h - 42
    for i, it in enumerate(setup):
        parts.append(card(56 + i * (cw + 20), ct, cw, ch,
                          '<div style="display:flex;gap:10px;align-items:center">'
                          '<span class="num" style="position:static;width:32px;height:32px;font-size:14px;flex:0 0 32px">%02d</span>%s</div>'
                          '<div style="margin-top:14px">%s</div>'
                          % (i + 1, B.icon_svg(it.get("icon") or "notebook", 34),
                             head_detail(it.get("head", ""), whole(it.get("detail", ""), 74), cw - 40,
                                         size=fit(it.get("head", ""), cw - 40, 54, [19, 18, 17, 16]))),
                          hero=(i == 0), pad="14px 16px"))
    ty = top + setup_h
    parts.append('<div class="abs" style="left:56px;top:%dpx;width:968px;border-top:1.5px dashed var(--subtle)"></div>' % (ty + 36))
    parts.append('<div class="abs" style="left:%dpx;top:%dpx;padding:7px 20px;border-radius:999px;background:var(--accent);'
                 'color:var(--surface);font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.06em;font-size:13px">'
                 'Then it runs, every time</div>' % (540 - 130, ty + 18))
    ry = ty + turn_h; rh = (run_h - 42) // max(1, len(run))
    parts.append('<div class="chip sage" style="left:56px;top:%dpx">Without you</div>' % ry)
    for i, it in enumerate(run):
        owner = bool(re.search(r"\b(review|approve|sign off|your check|you decide)\b", it.get("head", ""), re.I))
        parts.append(card(56, ry + 42 + i * rh, 968, rh - 14,
                          '<div style="display:flex;gap:18px;align-items:center;height:100%%">%s<div style="min-width:0;flex:1">%s</div>%s</div>'
                          % (B.icon_svg("person" if owner else (it.get("icon") or "agent"), 46,
                                        "var(--gold)" if owner else "var(--accent)"),
                             head_detail(it.get("head", ""), it.get("detail", ""), 700),
                             ('<div class="chip gold" style="position:relative;left:0;top:0;flex:0 0 auto">Owner approves</div>' if owner else "")),
                          cls="gold" if owner else "", pad="14px 22px"))
    parts.append(band(56, band_y, 968, band_h, ctx["hero"].get("value", ""), ctx["hero"].get("label", ""), ctx.get("rule", "")))
    return parts


RENDERERS = {"columns": t_columns, "fork": t_fork, "staircase": t_staircase, "loop": t_loop, "dial": t_dial,
             "ring": t_ring, "conveyor": t_conveyor, "hub": t_hub, "grid": t_grid, "ladder": t_ladder,
             "bins": t_bins, "phases": t_phases}


# ---------- assembly ----------

SHAPE_NAME = {"steps": "The method", "before_after": "The mistake", "stat": "The build log", "flow": "The workflow", "checklist": "The checklist"}


def context(shape, spec, rich, post_text):
    """Everything a template may draw, from the enriched words with the plain spec as the floor."""
    rich = rich or {}
    items = [dict(i) for i in (rich.get("items") or [])]
    if not items:                                     # no enrichment: build items from the plain spec
        raw = (spec.get("steps") or spec.get("items") or spec.get("boxes")
               or ((spec.get("before") or []) + (spec.get("after") or [])) or [])
        items = [{"head": str(t)[:60], "detail": "", "icon": ""} for t in raw]
    if not items and spec.get("label"):               # a bare stat spec: the label is the only line there is
        items = [{"head": str(spec["label"])[:60], "detail": "", "icon": "gauge"}]
    human = -1
    try: human = int(spec.get("human", -1))
    except (TypeError, ValueError): human = -1
    if human < 0 and shape == "steps":
        human = next((i for i, it in enumerate(items) if re.search(r"human check|owner|approve|you review", it.get("head", "") + " " + it.get("detail", ""), re.I)), -1)
    hero = dict(rich.get("hero") or {})
    if not hero.get("value") and spec.get("number"):
        hero = {"value": str(spec["number"]), "label": str(spec.get("label", ""))}
    return {"title": rich.get("title") or spec.get("title") or "", "highlight": rich.get("highlight", ""),
            "standfirst": rich.get("standfirst", ""), "items": items, "hero": hero, "rule": rich.get("rule", ""),
            "guide": rich.get("guide") or [], "left_label": rich.get("left_label", ""), "right_label": rich.get("right_label", ""),
            "human": human, "spec": spec, "post_text": post_text or "", "shape": shape}


def build(template, shape, spec, rich, post_text, source):
    if template not in RENDERERS:
        raise ValueError("unknown template %r" % template)
    ctx = context(shape, spec, rich, post_text)
    if not ctx["items"]:
        raise ValueError("no items for %s" % template)
    standfirst = "" if template in NO_STANDFIRST else ctx["standfirst"]
    hd, y = B.banner("Operations Director · " + SHAPE_NAME.get(shape, "The method"), ctx["title"], ctx["highlight"], standfirst)
    parts = [hd] + RENDERERS[template](ctx, y)
    return page(parts, source, ctx["title"] or SHAPE_NAME.get(shape, "Operations Director"))


def render(template, shape, spec, rich, post_text, source, out_png, scale=2):
    html_path = out_png[:-4] + ".html"
    with open(html_path, "w") as fh:
        fh.write(build(template, shape, spec, rich, post_text, source))
    r = subprocess.run(["node", os.path.join(B.EPIC, "scripts", "check.mjs"), html_path, "--width", str(W), "--height", str(H)],
                       capture_output=True, text=True, timeout=180)
    m = re.search(r"check: (\d+) error", (r.stdout or "") + (r.stderr or ""))
    n_err = int(m.group(1)) if m else (0 if r.returncode == 0 else 1)
    if n_err:
        raise SystemExit("%s preflight: %d error(s): %s" % (template, n_err, ((r.stdout or "") + (r.stderr or ""))[-500:]))
    r2 = subprocess.run(["node", os.path.join(B.EPIC, "scripts", "render.mjs"), html_path, out_png, "--width", str(W),
                         "--height", str(H), "--scale", str(scale)], capture_output=True, text=True, timeout=240)
    if r2.returncode != 0 or not os.path.exists(out_png):
        raise SystemExit("%s render failed: %s" % (template, (r2.stderr or r2.stdout)[-300:]))
    return out_png, html_path


def pick(shape, ctx, figure=None, week_index=0):
    """Which template this post wears. Content first, calendar last.

    1. The model's own reading of the post (`figure`), but only if the words can actually carry it.
    2. Otherwise the most specific template whose content test passes.
    3. Where several general templates fit equally well, rotate between them so the look still varies week to week.
    """
    order = PREFER.get(shape) or TEMPLATES
    if figure and FIGURES.get(figure) in REQUIRES and REQUIRES[FIGURES[figure]](ctx):
        return FIGURES[figure]
    passing = [t for t in order if REQUIRES[t](ctx)]
    if not passing:
        return order[0]
    gated = [t for t in passing if t in GATED]
    if gated:
        return gated[0]
    return passing[week_index % len(passing)]


def explain(shape, ctx, figure=None, week_index=0):
    """Why this template, in one line, so a choice can be checked rather than trusted."""
    t = pick(shape, ctx, figure, week_index)
    if figure and FIGURES.get(figure) == t:
        return "%s: the post reads as a %s" % (t, figure.replace("_", " "))
    reasons = {"ring": "the figure is a share of a whole", "dial": "the figure is an instrument reading",
               "hub": "the words name several sources feeding one agent", "bins": "the words sort things into %d groups" % group_count(ctx),
               "ladder": "the reader scores themselves against the list", "phases": "setup stops and the agent takes over at step %d" % (phase_split(ctx) + 1),
               "loop": "the words say it goes round again", "conveyor": "work moves through stages in order",
               "staircase": "steps that build to an end state", "columns": "two ways of covering the same work",
               "fork": "one moment, two roads", "grid": "a set of equal points"}
    return "%s: %s" % (t, reasons.get(t, "the default for this shape"))


def selftest():
    specs = {
        "before_after": {"title": "Hire an agent before you hire a person", "before": ["a", "b", "c"], "after": ["d", "e", "f"]},
        "steps": {"title": "Turn your SOP into an agent", "steps": ["one", "two", "three", "four", "five", "six"]},
        "stat": {"title": "Give the routing job to an agent", "number": "30 min", "label": "checks for finished work", "source": "x"},
        "flow": {"title": "Audiobook Processor workflow", "boxes": ["a", "b", "c", "d", "e"], "human": 3},
        "checklist": {"title": "Five signs your business runs on you", "items": ["a", "b", "c", "d", "e"]},
    }
    rich = {"title": "Turn your SOP into an agent", "highlight": "into an agent", "standfirst": "Six stations, one human check.",
            "items": [{"head": "Pick one task fielding weekly questions", "detail": "Start with the task that still lands in your inbox.", "icon": "inbox"},
                      {"head": "Write decisions and actions", "detail": "Numbered decisions give the agent something to execute.", "icon": "notebook"},
                      {"head": "Load it into the agent", "detail": "The SOP becomes the instruction set.", "icon": "agent"},
                      {"head": "Run one live example", "detail": "Compare the output to your own.", "icon": "person"},
                      {"head": "Correct where it went wrong", "detail": "Every correction is remembered.", "icon": "checklist"}],
            "hero": {"value": "3 clean runs", "label": "before you step out"},
            "rule": "The SOP without the agent is a document you still follow yourself.",
            "guide": ["Pick", "Write it down", "Load it in", "Run one example", "Step out"]}
    failed = []
    for shape, opts in list(SUITS.items()) + [("checklist", ["bins"]), ("steps", ["phases"])]:
        for tpl in opts:
            try:
                pg = build(tpl, shape, specs[shape], rich, "Hook line.\n\n1. One.\n2. Two.", "the agent register")
                body = pg.split("<body>")[1]
                assert body.count("data-hero") == 1, "%s: %d heroes" % (tpl, body.count("data-hero"))
                assert '<div class="strip">' in body and "Operations Director" in body, tpl
                assert "Kevin" not in body and "<script" not in body, tpl
            except AssertionError as ex:
                failed.append(str(ex))
            except Exception as ex:
                failed.append("%s: %s" % (tpl, ex))
    # no enrichment at all: every template still draws from the plain spec
    for shape, opts in list(SUITS.items()) + [("checklist", ["bins"]), ("steps", ["phases"])]:
        for tpl in opts:
            try:
                build(tpl, shape, specs[shape], None, "Hook.", "src")
            except Exception as ex:
                failed.append("%s bare: %s" % (tpl, ex))
    assert esc("<b>x</b>") == "&lt;b&gt;x&lt;/b&gt;"

    # the picker: content decides, not the calendar. Each case is a real post from the week of 7 Sep 2026.
    def ctx_of(shape, spec, **rich_over):
        r = dict(rich); r.update(rich_over)
        return context(shape, spec, r, "")

    ba = specs["before_after"]
    cmp_ctx = ctx_of("before_after", ba, title="Hire an agent before you hire a person", rule="Stop hiring for work a rule can handle.",
                     items=[{"head": "Owner reads all emails manually"}, {"head": "Writes each reply from scratch"},
                            {"head": "Agent reads every inbox email"}, {"head": "Owner reviews and approves"}])
    assert pick("before_after", cmp_ctx, week_index=0) == "columns"      # two general fits: rotate
    assert pick("before_after", cmp_ctx, week_index=1) == "fork"

    sop = ctx_of("steps", specs["steps"], title="Turn your SOP into an agent",
                 rule="The SOP without the agent is a document you still follow yourself.",
                 items=[{"head": "Pick one task"}, {"head": "Write decisions and actions"}, {"head": "Create a universal SOP agent"},
                        {"head": "Run one live example"}, {"head": "Three clean runs, then step out"}])
    assert phase_split(sop) == 0 and not repeats(sop)
    assert pick("steps", sop, week_index=0) == "staircase"               # never forced into a cycle it is not

    lib = ctx_of("steps", specs["steps"], title="Hand your process library to one AI agent", rule="One agent holds your full library.",
                 items=[{"head": "Pick one weekly repeated task"}, {"head": "Write it as plain text"}, {"head": "Add one decision rule"},
                        {"head": "Load into a Claude agent"}, {"head": "Agent reads, runs, and files"}, {"head": "Review once, approve or send back"}])
    assert phase_split(lib) == 4 and pick("steps", lib, week_index=1) == "phases"

    assert pick("stat", ctx_of("stat", specs["stat"], hero={"value": "30 min", "label": "check interval"}), week_index=0) == "dial"
    assert pick("stat", ctx_of("stat", specs["stat"], hero={"value": "95%", "label": "accuracy target"}), week_index=0) == "ring"

    audio = ctx_of("flow", specs["flow"], title="Audiobook Processor workflow", hero={"value": "121", "label": "books processed"},
                   items=[{"head": "Book joins the queue"}, {"head": "Transcribe overnight"}, {"head": "Build brain doc"},
                          {"head": "Stops at 3:30am"}, {"head": "Read the output"}])
    ceo = ctx_of("flow", specs["flow"], title="CEO Brief agent workflow", hero={"value": "4 sources", "label": "read overnight"},
                 items=[{"head": "Morning trigger fires itself"}, {"head": "Agent reads four sources"}, {"head": "Agent writes one brief"},
                        {"head": "Owner reads Slack"}, {"head": "Night sweep saves the day"}])
    assert pick("flow", audio, week_index=0) == "conveyor" and pick("flow", ceo, week_index=0) == "hub"

    three = ctx_of("checklist", specs["checklist"], title="The three-group test for daily tasks",
                   standfirst="Split your decisions into three groups and hand the first to an agent.",
                   hero={"value": "9 of 10", "label": "before removing the review"},
                   items=[{"head": "Agent handles it"}, {"head": "Agent produces, you review"}, {"head": "You decide"},
                          {"head": "Start with one task"}, {"head": "Check ten outputs"}])
    signs = ctx_of("checklist", specs["checklist"], title="Five signs your business runs on you",
                   standfirst="Score yourself and find out whether the business needs you.",
                   hero={"value": "4 or 5", "label": "the score that means it runs on you"},
                   items=[{"head": "You answer the same questions"}, {"head": "Only you know the answer"}, {"head": "Doing it feels faster"},
                          {"head": "Nothing moves while you are away"}, {"head": "No list of work only you should do"}])
    assert group_count(three) == 3 and pick("checklist", three, week_index=0) == "bins"
    assert group_count(signs) == 0 and has_score(signs) and pick("checklist", signs, week_index=1) == "ladder"

    # a model figure only wins when the words can carry it
    assert pick("stat", ctx_of("stat", specs["stat"], hero={"value": "30 min", "label": "x"}), figure="share") == "dial"
    assert pick("checklist", three, figure="list") == "grid"
    assert len(TEMPLATES) == 12 and set(FIGURES.values()) == set(TEMPLATES)
    assert "the figure is a share" in explain("stat", ctx_of("stat", specs["stat"], hero={"value": "95%", "label": "x"}))

    print(json.dumps({"checks": len(TEMPLATES) * 2 + 22, "failed": failed}))
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "selftest":
        selftest()
    else:
        raise SystemExit("usage: od_templates.py selftest")
