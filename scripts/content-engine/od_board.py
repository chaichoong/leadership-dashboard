"""Content Engine, Operations Director lane: the BOARD renderer (pictures v4, Kevin 8 Sep 2026: "the infographics you're producing are
substandard, glitchy, text overlapping; the bar is the lead magnet").

The lead magnet page hit the bar because a strong writer laid it out by hand in the Operations Director design language and then looked
at it. A model composing a fresh layout every night cannot be trusted to do that (measured 4-8 Sep: props on text, ghost numerals, empty
thirds, required lines rewritten). So the layouts are now CODE: five boards built from the lead magnet's own components (scaffold CSS,
route, stations, placards, lanes, the owner's gold stop, the strip), with the model contributing only the words. Nothing can overlap text
because nothing is placed by a model; the skill's preflight and a rendered-picture review still run as the gate. Variation comes from the
shape of the week, the route, and a rotating prop set, not from a fresh composition.
"""
import html, json, os, re, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
EPIC = os.path.join(HERE, "epic")
SCAFFOLD = os.path.join(EPIC, "templates", "od-scaffold.html")
W, H = 1080, 1350
STRIP_TOP = H - 96

PROPS = {   # the lead magnet's line props, 124x120 viewBox, stroke currentColor
    "clock": '<g transform="translate(62 60)"><circle r="34"/><path d="M0 -22 V0 L14 8"/><path d="M0 -30 v4 M30 0 h-4 M0 30 v-4 M-30 0 h4"/></g>',
    "clip": '<g transform="translate(40 24) rotate(-28)"><path d="M0 0 v52 a10 10 0 0 0 20 0 V9 a6 6 0 0 0 -12 0 v36 a3 3 0 0 0 6 0 V15"/></g>',
    "tray": '<path d="M14 62 h96 l-10 38 h-76 z"/><path d="M28 62 v-14 h68 v14"/>',
    "folder": '<path d="M14 30 h34 l10 10 h52 v58 h-96 z"/><path d="M14 52 h96"/>',
    "screen": '<rect x="12" y="20" width="100" height="66" rx="6"/><rect x="12" y="20" width="100" height="14" rx="6" fill="var(--surface-2)"/><circle cx="62" cy="58" r="16"/><circle cx="62" cy="58" r="7" fill="var(--accent-soft)"/><circle cx="100" cy="27" r="4" fill="var(--gold)" stroke="none"/><path d="M38 98 h48 M28 108 h68"/>',
    "database": '<ellipse cx="62" cy="30" rx="34" ry="11"/><path d="M28 30 V86 a34 11 0 0 0 68 0 V30"/><path d="M28 58 a34 11 0 0 0 68 0"/>',
    "notebook": '<rect x="20" y="16" width="84" height="88" rx="4"/><path d="M34 16 V104"/><path d="M44 34 h46 M44 48 h34 M44 62 h42 M44 76 h28"/>',
    "gauge": '<path d="M15 86 A47 47 0 0 1 109 86"/><path d="M19 76 l6 2 M34 51 l4 5 M62 40 v6 M90 51 l-4 5 M105 76 l-6 2"/><path d="M62 86 L41 56" stroke="var(--gold)" stroke-width="4"/><circle cx="62" cy="86" r="6" fill="var(--gold)" stroke="none"/>',
    "meter": '<rect x="8" y="50" width="108" height="18" rx="3" fill="var(--surface-2)"/><rect x="8" y="50" width="86" height="18" rx="3" fill="var(--accent-soft)" stroke="none"/><path d="M94 42 V76" stroke="var(--gold)" stroke-width="3"/><path d="M8 92 h108 M8 88 v8 M62 88 v8 M116 88 v8"/>',
    "agent": '<use href="#agent" x="30" y="6" width="64" height="64"/><g><rect x="22" y="80" width="80" height="26" rx="3"/><path d="M32 93 h30"/><circle cx="90" cy="93" r="6" fill="var(--accent-soft)"/></g>',
    "person": '<use href="#person" x="50" y="40" width="24" height="30" fill="var(--ink)" stroke="none"/><g stroke="var(--ink-faint)"><path d="M14 20 L44 44 M110 20 L80 44 M14 100 L44 72 M110 100 L80 72 M62 6 V32 M62 112 V84 M10 60 H40 M114 60 H84"/></g>',
    "inbox": '<path d="M14 40 h96 v56 h-96 z"/><path d="M14 40 l48 34 l48 -34"/>',
    "checklist": '<rect x="24" y="14" width="76" height="92" rx="4"/><path d="M36 38 h18 M62 38 h28 M36 58 h18 M62 58 h28 M36 78 h18 M62 78 h20"/><path d="M38 36 l4 4 l8 -8 M38 56 l4 4 l8 -8" stroke="var(--accent)"/>',
}
PROP_ORDER = ["inbox", "screen", "agent", "checklist", "notebook", "database", "gauge", "meter", "clock", "folder"]
SIDE_PROPS = ["clock", "clip", "tray", "folder"]


def esc(s): return html.escape(str(s or "").strip())


def prop_svg(name, cls="prop", style=""):
    return '<svg class="%s" style="%s" viewBox="0 0 124 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">%s</svg>' % (cls, style, PROPS.get(name, PROPS["clock"]))


def side_props(positions):
    """Small office props on the open grid, in places no text can reach (each caller passes safe coordinates)."""
    out = []
    for i, (x, y) in enumerate(positions):
        out.append('<svg class="abs" style="left:%dpx;top:%dpx;width:72px;height:70px;color:var(--ink-muted)" viewBox="0 0 124 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">%s</svg>' % (x, y, PROPS[SIDE_PROPS[i % len(SIDE_PROPS)]]))
    return "\n".join(out)


def header(kicker, title, standfirst=None, title_width=900, title_size=None):
    """Kicker, title, optional standfirst. Returns (html, bottom_y) so the body starts right under it and fills to the strip."""
    size = title_size or (56 if len(title) <= 34 else (48 if len(title) <= 50 else 42))
    per_line = max(1, int(title_width / (size * 0.52))); lines = max(1, -(-len(title) // per_line))
    title_h = int(size * 1.02 * lines)
    out = ['<div class="abs kicker mono" style="left:56px;top:48px">%s</div>' % esc(kicker),
           '<h1 class="abs title" style="left:56px;top:76px;width:%dpx;font-size:%dpx">%s</h1>' % (title_width, size, esc(title))]
    bottom = 76 + title_h + 16
    if standfirst:
        sf_lines = max(1, -(-len(standfirst) // 78))
        out.append('<p class="abs standfirst" style="left:56px;top:%dpx;width:760px">%s</p>' % (bottom, esc(standfirst)))
        bottom += int(19 * 1.35 * sf_lines) + 12
    return "\n".join(out), bottom + 28


def strip(source):
    return ('<div class="strip"><div class="brand"><span class="logo" style="width:48px;height:48px;color:var(--accent);display:inline-block">%s</span>'
            '<span class="wordmark">Operations Director</span></div><div class="src mono">Source · %s<br>operationsdirector.co.uk</div></div>'
            % (LOGO_SVG, esc(source)))


def route_svg(path_d, arrow_at=None, extra=""):
    arrow = ('<path d="M%d %d L%d %d L%d %d Z" fill="var(--accent)"/>' % (arrow_at[0] - 16, arrow_at[1] - 26, arrow_at[0], arrow_at[1], arrow_at[0] + 16, arrow_at[1] - 26)) if arrow_at else ""
    return ('<svg class="abs route" viewBox="0 0 %d %d" aria-hidden="true"><path d="%s" fill="none" stroke="var(--accent)" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>'
            '<path d="%s" fill="none" stroke="var(--surface)" stroke-width="1.5" stroke-dasharray="14 10"/>%s%s</svg>' % (W, H, path_d, path_d, arrow, extra))


def stations(items, x_route, top, bottom, gold_index=-1, first_grey=False, numbered=True, props=None, hero_index=0):
    """Numbered stops on a vertical route with one card each. The pitch fills the space between top and bottom (capped) so the board
    is never half empty and nothing can collide; text size steps down with length."""
    n = max(1, len(items)); pitch = min(190, (bottom - top) // max(1, n - 1)) if n > 1 else 0
    out = []
    for i, text in enumerate(items):
        y = top + i * pitch; size = 22 if len(text) <= 62 else (19 if len(text) <= 90 else 17)
        cls = "stop"; style = ""
        if i == gold_index: style = "background:var(--gold);box-shadow:0 0 0 3px var(--surface)"
        elif first_grey and i == 0: style = "background:var(--de-emphasis);color:var(--ink)"
        out.append('<div class="%s" style="left:%dpx;top:%dpx;%s">%s</div>' % (cls, x_route - 22, y - 22, style, ("%02d" % (i + 1)) if numbered else ""))
        card_style = "left:%dpx;top:%dpx;width:%dpx;min-height:%dpx" % (x_route + 40, y - 34, W - (x_route + 40) - 56, min(132, pitch - 36) if pitch >= 120 else 72)
        border = "border-color:var(--gold);background:#F7F1E3" if i == gold_index else ""
        label = ("Owner approves" if i == gold_index else ("Trigger" if first_grey and i == 0 else "Station %02d" % (i + 1)))
        prop = prop_svg((props or PROP_ORDER)[i % len(props or PROP_ORDER)], style="width:100px;height:96px;top:50%;transform:translateY(-50%);right:14px") if pitch >= 120 else ""
        out.append('<div class="station%s" style="%s;%s"%s><span class="mono" style="font-size:12px;color:%s">%s</span><h3 style="font-size:%dpx;margin-top:4px">%s</h3>%s</div>'
                   % (" first" if (first_grey and i == 0) else "", card_style, border, ' data-hero' if i == hero_index else "", "var(--gold)" if i == gold_index else "var(--ink-faint)", label, size, esc(text), prop))
    return "\n".join(out), pitch


def keep_block(x, y, text="The one job you keep. Every yes or no teaches the agent, and every no is remembered."):
    return ('<div class="abs keep" style="left:%dpx;top:%dpx"><div class="stop"></div><svg class="fig" viewBox="0 0 24 30" fill="var(--ink)"><use href="#person" width="24" height="30"/></svg>'
            '<div class="t"><span class="mono">Owner approves</span>%s</div></div>' % (x, y, esc(text)))


def lanes_block(x, y, w, h, before, after, hero=True, side_by_side=True, size=19):
    """Then and now. Side by side as two placards (by hand in grey, with an agent in sage) with the route arrow crossing between them,
    or stacked in one placard when the space is narrow. Heights come from the content."""
    li = lambda t, strong: '<div class="lane-text" style="font-size:%dpx;line-height:1.35;margin-top:10px">%s%s%s</div>' % (size, "<strong>" if strong else "• ", esc(t), "</strong>" if strong else "")
    b = "".join(li(t, False) for t in before); a = "".join(li(t, True) for t in after)
    agents = "".join('<use href="#agent" x="%d" y="0" width="32" height="32"/>' % (i * 38) for i in range(min(5, max(2, len(after) + 1))))
    then_svg = '<svg width="256" height="34" viewBox="0 0 256 34"><use href="#person" x="0" y="2" width="24" height="30" fill="var(--ink)"/><g fill="none" stroke="var(--de-emphasis)" stroke-width="1.5" stroke-linecap="round" filter="url(#wobble)"><path d="M40 8 h60 M40 17 h84 M40 26 h48"/><path d="M140 8 h70 M140 17 h50 M140 26 h96"/></g></svg>'
    now_svg = '<svg width="256" height="34" viewBox="0 0 256 34">%s<circle cx="226" cy="16" r="11" fill="var(--gold)" stroke="var(--surface)" stroke-width="2"/></svg>' % agents
    if not side_by_side:
        return ('<div class="placard lanes" style="left:%dpx;top:%dpx;width:%dpx;height:%dpx"%s><div class="lane-then"><div class="lane-label mono">By hand</div>%s%s</div>'
                '<div class="lane-now"><div class="lane-label mono">With an agent</div>%s%s</div></div>' % (x, y, w, h, " data-hero" if hero else "", then_svg, b, now_svg, a))
    half = (w - 48) // 2
    then = ('<div class="placard" style="left:%dpx;top:%dpx;width:%dpx;height:%dpx;padding:22px 24px;background:var(--surface-2);border-style:dashed"><div class="lane-label mono">By hand</div>%s%s</div>' % (x, y, half, h, then_svg, b))
    now = ('<div class="placard plate" style="left:%dpx;top:%dpx;width:%dpx;height:%dpx;padding:22px 24px"%s><div class="lane-label mono" style="color:var(--accent)">With an agent</div>%s%s</div>' % (x + half + 48, y, half, h, " data-hero" if hero else "", now_svg, a))
    mid = x + half + 24; ay = y + h // 2
    arrow = ('<svg class="abs" style="left:%dpx;top:%dpx;width:60px;height:40px" viewBox="0 0 60 40"><path d="M2 20 H44" stroke="var(--accent)" stroke-width="8" stroke-linecap="round"/><path d="M36 6 L56 20 L36 34 Z" fill="var(--accent)"/></svg>' % (mid - 30, ay - 20))
    return then + now + arrow


def post_points(post_text, limit=4):
    """The post's own numbered lines ("1. ...") as short points for a second placard: real content, never filler."""
    pts = []
    for line in (post_text or "").split("\n"):
        m = re.match(r"\s*(\d+)[.)]\s+(.+)", line)
        if m: pts.append(m.group(2).strip())
    return pts[:limit]


def points_placard(x, y, w, h, kicker, items, hook=None, plate=False):
    body = ""
    if hook: body += '<div class="display" style="margin-top:12px;font-size:%dpx;font-weight:700;line-height:1.15;color:var(--ink)">%s</div>' % (32 if len(hook) <= 70 else 26, esc(hook[:160]))
    if items:
        body += '<div style="margin-top:%dpx">' % (22 if hook else 14) + "".join('<div style="display:flex;gap:16px;align-items:flex-start;margin-top:12px"><span class="stop" style="position:static;width:30px;height:30px;font-size:14px;flex:0 0 30px">%02d</span><span style="font-size:%dpx;line-height:1.35;color:var(--ink)">%s</span></div>' % (i + 1, 21 if len(t) <= 70 else 18, esc(t)) for i, t in enumerate(items)) + "</div>"
    return '<div class="placard%s" style="left:%dpx;top:%dpx;width:%dpx;min-height:%dpx;padding:26px 32px 30px"><div class="mono" style="font-size:12px;color:var(--ink-faint)">%s</div>%s</div>' % (" plate" if plate else "", x, y, w, h, esc(kicker), body)


ICONS = {"tick": '<path d="M28 62 l22 22 l46 -50" stroke="var(--accent)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>',
         "cross": '<path d="M34 34 l56 56 M90 34 l-56 56" stroke="var(--ink-faint)" stroke-width="9" stroke-linecap="round"/>'}


def icon_svg(name, size=44, colour="var(--ink-muted)"):
    body = ICONS.get(name) or PROPS.get(name) or PROPS["clock"]
    if name == "person": body = '<use href="#person" x="40" y="20" width="44" height="56" fill="var(--ink)" stroke="none"/>'
    if name == "agent": body = '<use href="#agent" x="22" y="10" width="80" height="80"/>'
    return '<svg style="width:%dpx;height:%dpx;flex:0 0 %dpx;color:%s" viewBox="0 0 124 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">%s</svg>' % (size, size, size, colour, body)


def banner(kicker, title, highlight="", standfirst=""):
    """The Dan Martell title: bold, one phrase highlighted, an italic standfirst on a rule under it. Returns (html, bottom_y)."""
    t = esc(title)
    if highlight and highlight.lower() in title.lower():
        i = title.lower().index(highlight.lower()); h = title[i:i + len(highlight)]
        t = esc(title[:i]) + '<span style="background:var(--accent-soft);padding:0 10px;margin:0 2px;border-radius:6px;color:var(--accent);box-decoration-break:clone;-webkit-box-decoration-break:clone">%s</span>' % esc(h) + esc(title[i + len(highlight):])
    size = 60 if len(title) <= 30 else (52 if len(title) <= 44 else 44)
    per_line = max(1, int(968 / (size * 0.47))); lines = max(1, -(-len(title) // per_line))
    y = 76 + int(size * 1.05 * lines) + 14
    out = ['<div class="abs kicker mono" style="left:56px;top:48px">%s</div>' % esc(kicker),
           '<h1 class="abs title" style="left:56px;top:76px;width:968px;font-size:%dpx;line-height:1.05">%s</h1>' % (size, t)]
    if standfirst:
        out.append('<div class="abs" style="left:56px;top:%dpx;width:968px;padding:10px 0;border-top:2px solid var(--subtle);border-bottom:2px solid var(--subtle);font-size:20px;font-style:italic;color:var(--ink-muted)">%s</div>' % (y, esc(standfirst)))
        y += 64
    return "\n".join(out), y + 16


def pill(text, x, y, colour="accent"):
    return '<div class="abs mono" style="left:%dpx;top:%dpx;padding:6px 16px;border-radius:999px;background:var(--%s);color:%s;font-size:13px;font-weight:500">%s</div>' % (x, y, "accent" if colour == "accent" else "gold", "var(--surface)", esc(text))


def rows_panel(x, y, w, items, icon_default, numbered=False, row_h=None, tone="surface"):
    """Rows of icon + headline + detail on a placard. Returns (html, height)."""
    n = max(1, len(items)); rh = row_h or 96
    rows = []
    for i, it in enumerate(items):
        head = esc(it.get("head") or it.get("text") or ""); det = esc(it.get("detail", ""))
        ic = it.get("icon") or icon_default
        num = '<span class="stop" style="position:static;width:30px;height:30px;font-size:14px;flex:0 0 30px">%02d</span>' % (i + 1) if numbered else ""
        rows.append('<div style="display:flex;gap:16px;align-items:center;height:%dpx;border-bottom:1px dashed var(--subtle)">%s%s<div style="min-width:0"><div style="font-size:%dpx;font-weight:700;line-height:1.15;color:var(--ink)">%s</div>%s</div></div>'
                    % (rh, num, icon_svg(ic, 44), 21 if len(head) <= 34 else 18, head, ('<div style="font-size:15px;line-height:1.3;color:var(--ink-muted);font-style:italic;margin-top:3px">%s</div>' % det) if det else ""))
    h = 26 + n * rh + 18
    return ('<div class="placard" style="left:%dpx;top:%dpx;width:%dpx;height:%dpx;padding:14px 22px 10px;background:var(--%s)">%s</div>' % (x, y, w, h, tone, "".join(rows))), h


def formula_box(x, y, w, label, text):
    return ('<div class="abs" style="left:%dpx;top:%dpx;width:%dpx">%s<div class="placard plate" style="position:relative;width:%dpx;padding:30px 34px 26px;margin-top:16px;background:var(--surface)">'
            '<div class="display" style="font-size:%dpx;line-height:1.2;color:var(--ink)">%s</div></div></div>'
            % (x, y, w, '<div class="mono" style="display:inline-block;padding:6px 16px;background:var(--deep);color:var(--surface);font-size:13px;border-radius:6px">%s</div>' % esc(label), w, 30 if len(text) <= 70 else (26 if len(text) <= 100 else 22), esc(text)))


def guide_band(x, y, w, label, steps):
    cells = "".join('<div style="flex:1;min-width:0;display:flex;gap:10px;align-items:flex-start"><span class="stop" style="position:static;width:28px;height:28px;font-size:13px;flex:0 0 28px">%d</span><span style="font-size:15px;line-height:1.3;color:var(--ink)">%s</span></div>' % (i + 1, esc(t)) for i, t in enumerate(steps))
    return ('<div class="abs" style="left:%dpx;top:%dpx;width:%dpx">%s<div class="placard" style="position:relative;width:%dpx;margin-top:16px;padding:20px 22px;display:flex;gap:18px;background:var(--surface-2)">%s</div></div>'
            % (x, y, w, '<div class="mono" style="display:inline-block;padding:6px 16px;background:var(--accent);color:var(--surface);font-size:13px;border-radius:6px">%s</div>' % esc(label), w, cells))


def hero_pill(x, y, value, label, note="", h=None):
    return ('<div class="placard plate" style="left:%dpx;top:%dpx;width:300px;%spadding:22px 22px 18px;display:flex;flex-direction:column;justify-content:center"><div class="display" style="font-size:%dpx;line-height:1.02;color:var(--accent)">%s</div><div class="mono" style="margin-top:10px;font-size:12px;color:var(--ink-faint)">%s</div>%s</div>'
            % (x, y, ("height:%dpx;" % h) if h else "", 60 if len(value) <= 7 else (38 if len(value) <= 14 else 26), esc(value), esc(label),
               ('<div style="margin-top:22px;padding-top:14px;border-top:1.5px solid var(--subtle);display:flex;gap:10px;align-items:center"><span class="stop" style="position:static;width:26px;height:26px;background:var(--gold);flex:0 0 26px"></span><span class="mono" style="font-size:12px;color:var(--gold)">%s</span></div>' % esc(note)) if note else ""))


def build_rich(template, spec, rich, post_text, source, day):
    """The dense board: banner, panels of icon + headline + detail, a hero, the formula box, the guide band, the strip."""
    base = open(SCAFFOLD).read(); head_html = base.split("<body>")[0]; symbols = base.split('<svg width="0" height="0" style="position:absolute">')[1].split("</svg>")[0]
    shape_name = {"steps": "The method", "before_after": "The mistake", "stat": "The build log", "flow": "The workflow", "checklist": "The checklist"}[template]
    parts = ['<svg width="0" height="0" style="position:absolute">%s</svg>' % symbols,
             '<svg class="tick" style="left:24px;top:24px" viewBox="0 0 16 16"><path d="M8 0v16M0 8h16" stroke="currentColor" stroke-width="1.2"/></svg>',
             '<svg class="tick" style="left:1040px;top:24px" viewBox="0 0 16 16"><path d="M8 0v16M0 8h16" stroke="currentColor" stroke-width="1.2"/></svg>']
    hd, y = banner("Operations Director · " + shape_name, rich.get("title") or spec.get("title", ""), rich.get("highlight", ""), rich.get("standfirst", "")); parts.append(hd)
    items = rich.get("items") or []; hero = rich.get("hero") or {}; rule = rich.get("rule", ""); guide = rich.get("guide") or []
    bottom_limit = STRIP_TOP - 36
    if template == "before_after":
        n_b = len(spec.get("before") or []); left, right = items[:n_b] or items[: len(items) // 2], items[n_b:] if n_b else items[len(items) // 2:]
        parts.append(pill(rich.get("left_label") or "By hand", 56, y)); parts.append(pill(rich.get("right_label") or "With an agent", 56 + 496, y))
        yp = y + 44
        space = bottom_limit - yp - (170 if rule else 0) - (176 if guide else 0) - 28
        rh = max(84, min(150, (space - 44) // max(1, max(len(left), len(right)))))
        lh, h1 = rows_panel(56, yp, 472, [dict(i, icon=i.get("icon") if i.get("icon") in ("cross", "tick") else "cross") for i in left], "cross", row_h=rh, tone="surface-2")
        rhh, h2 = rows_panel(56 + 496, yp, 472, [dict(i, icon=i.get("icon") if i.get("icon") in ("cross", "tick") else "tick") for i in right], "tick", row_h=rh)
        parts.append(lh); parts.append(rhh.replace('class="placard"', 'class="placard plate" data-hero', 1))
        parts.append('<svg class="abs" style="left:%dpx;top:%dpx;width:64px;height:44px" viewBox="0 0 64 44"><path d="M4 22 H44" stroke="var(--accent)" stroke-width="8" stroke-linecap="round"/><path d="M36 6 L58 22 L36 38 Z" fill="var(--accent)"/></svg>' % (56 + 472 - 20, yp + max(h1, h2) // 2 - 22))
        y = yp + max(h1, h2) + 28
    elif template in ("steps", "flow", "checklist"):
        numbered = template != "checklist"
        gold = -1
        if template == "flow":
            try: gold = int(spec.get("human", -1))
            except (TypeError, ValueError): gold = -1
        elif template == "steps": gold = next((i for i, t in enumerate(spec.get("steps", [])) if re.search(r"human check|owner|approve|you review", str(t), re.I)), -1)
        show_guide = bool(guide) and template != "steps"
        space = bottom_limit - y - (170 if rule else 0) - (176 if show_guide else 0) - 28
        rh = max(76, min(150, (space - 44) // max(1, len(items))))
        rows = [dict(i, icon=("tick" if template == "checklist" and not i.get("icon") else i.get("icon"))) for i in items]
        if gold >= 0 and gold < len(rows): rows[gold] = dict(rows[gold], head=rows[gold]["head"], icon="person")
        ph, h = rows_panel(56, y, 968 if not hero.get("value") else 640, rows, "checklist" if template == "checklist" else "agent", numbered=numbered, row_h=rh)
        parts.append(ph.replace('class="placard"', 'class="placard" data-hero', 1))
        note = ("Owner approves at step %02d" % (gold + 1)) if gold >= 0 else ""
        if hero.get("value"): parts.append(hero_pill(56 + 640 + 28, y, hero["value"], hero.get("label", ""), note=note, h=min(h, 360)))
        elif note: parts.append('<div class="abs mono" style="left:56px;top:%dpx;font-size:12px;color:var(--gold)">%s</div>' % (y + h + 8, note))
        y += h + 28
    else:  # stat
        number = str(spec.get("number") or hero.get("value") or "").strip(); label = str(spec.get("label") or hero.get("label") or "").strip()
        rows = items if len(items) >= 3 else [{"head": g, "icon": "agent"} for g in guide] or items
        used_guide = rows is not items
        space = bottom_limit - y - (170 if rule else 0) - (176 if (guide and not used_guide) else 0) - 28
        rh = max(76, min(150, (space - 44) // max(1, len(rows))))
        ph, h = rows_panel(56 + 448, y, 520, rows, "agent", numbered=True, row_h=rh)
        nsize = max(56, min(120, int(360 / (0.6 * max(1, len(number))))))
        parts.append('<div class="placard plate" style="left:56px;top:%dpx;width:420px;height:%dpx;padding:28px 30px;display:flex;flex-direction:column;justify-content:center" data-hero><div class="display" style="font-size:%dpx;line-height:.95;color:var(--accent);white-space:nowrap">%s</div><div style="margin-top:18px;font-size:22px;line-height:1.25;color:var(--ink);font-weight:500">%s</div><div class="mono" style="margin-top:14px;font-size:12px;color:var(--ink-faint)">Measured on our own business</div>'
                     '<svg style="margin-top:26px;width:260px;height:34px" viewBox="0 0 260 34">%s<circle cx="226" cy="16" r="11" fill="var(--gold)" stroke="var(--surface)" stroke-width="2"/></svg></div>'
                     % (y, h, nsize, esc(number), esc(label), "".join('<use href="#agent" x="%d" y="0" width="32" height="32"/>' % (i * 40) for i in range(5))))
        parts.append(ph); y += h + 28
        if used_guide: guide = []
    if rule and y + 130 <= bottom_limit:
        parts.append(formula_box(56, y, 968, "The rule", rule)); y += 170
    if guide and y + 120 <= bottom_limit and template != "steps":
        parts.append(guide_band(56, y, 968, "%d-step guide" % len(guide), guide)); y += 176
    parts.append(strip(source)); parts.append('<div class="grain"></div>')
    page = head_html + "<body>\n<div class=\"canvas\">\n" + "\n".join(parts) + "\n</div>\n</body>\n</html>\n"
    return page.replace("<title>Operations Director picture</title>", "<title>%s</title>" % esc(rich.get("title") or spec.get("title") or shape_name))


def build(template, spec, post_text, source, day):
    """The whole page for one shape. Every position is fixed; only words vary."""
    base = open(SCAFFOLD).read()
    head = base.split("<body>")[0]; symbols = base.split('<svg width="0" height="0" style="position:absolute">')[1].split("</svg>")[0]
    title = str(spec.get("title", "")).strip()
    hook = (post_text or "").strip().split("\n")[0].strip()
    parts = ['<svg width="0" height="0" style="position:absolute">%s</svg>' % symbols,
             '<svg class="tick" style="left:24px;top:24px" viewBox="0 0 16 16"><path d="M8 0v16M0 8h16" stroke="currentColor" stroke-width="1.2"/></svg>',
             '<svg class="tick" style="left:1040px;top:24px" viewBox="0 0 16 16"><path d="M8 0v16M0 8h16" stroke="currentColor" stroke-width="1.2"/></svg>']
    shape_name = {"steps": "The method", "before_after": "The mistake", "stat": "The build log", "flow": "The workflow", "checklist": "The checklist"}[template]
    kicker = "Operations Director · " + shape_name
    if template in ("steps", "flow"):
        items = [str(x) for x in spec.get(("steps" if template == "steps" else "boxes"), [])][:7]
        hd, body_top = header(kicker, title, hook if hook and hook.lower() != title.lower() else None); parts.append(hd)
        if template == "steps": gold = next((i for i, t in enumerate(items) if re.search(r"human check|owner|approve|you review", t, re.I)), -1); grey = False
        else:
            try: gold = int(spec.get("human", -1))
            except (TypeError, ValueError): gold = -1
            grey = True
        top, bottom = body_top + 50, STRIP_TOP - 70
        cards, pitch = stations(items, 120, top, bottom, gold_index=gold, first_grey=grey)
        last_y = top + (len(items) - 1) * pitch
        parts.append(route_svg("M120 %d V%d" % (top - 40, last_y + 50), arrow_at=(120, last_y + 76)))
        parts.append(cards)
    elif template == "before_after":
        before = [str(x) for x in spec.get("before", [])][:4]; after = [str(x) for x in spec.get("after", [])][:4]
        hd, body_top = header(kicker, title); parts.append(hd)
        avail = STRIP_TOP - body_top - 40
        rows = max(len(before), len(after)); lanes_h = min(int(avail * 0.5), 110 + rows * 74)
        parts.append(lanes_block(56, body_top, W - 112, lanes_h, before, after, size=24))
        y2 = body_top + lanes_h + 36; keep_h = 130; h2 = STRIP_TOP - 40 - y2 - keep_h - 30
        parts.append(points_placard(56, y2, W - 112, min(h2, 220), "From the post", post_points(post_text), hook=hook))
        y3 = y2 + h2 + 30
        parts.append(keep_block(56, y3 + 10))
        parts.append('<div class="abs" style="left:%dpx;top:%dpx;width:%dpx;border-top:1.5px solid var(--subtle)"></div>' % (400, y3 + 30, W - 456))
    elif template == "stat":
        number = str(spec.get("number", "")).strip(); label = str(spec.get("label", "")).strip()
        page_title = title or hook or label
        hd, body_top = header(kicker, page_title, None if page_title == hook else hook); parts.append(hd)
        avail = STRIP_TOP - body_top - 40; keep_h = 130; pts = post_points(post_text)
        ph = min(avail - keep_h - 40, 470) if pts else avail - keep_h - 40
        nsize = 150 if len(number) <= 6 else (110 if len(number) <= 9 else 76)
        parts.append('<div class="placard plate" style="left:56px;top:%dpx;width:560px;height:%dpx;padding:34px 36px;display:flex;flex-direction:column;justify-content:center" data-hero><div class="display" style="font-size:%dpx;line-height:.95;color:var(--accent)">%s</div>'
                     '<div style="margin-top:26px;font-size:30px;line-height:1.25;color:var(--ink);font-weight:500">%s</div><div class="mono" style="margin-top:22px;font-size:13px;color:var(--ink-faint)">Measured on our own business</div>'
                     '<svg style="margin-top:34px;width:300px;height:34px" viewBox="0 0 300 34">%s<circle cx="266" cy="16" r="11" fill="var(--gold)" stroke="var(--surface)" stroke-width="2"/></svg></div>'
                     % (body_top, ph, nsize, esc(number), esc(label), "".join('<use href="#agent" x="%d" y="0" width="32" height="32"/>' % (i * 40) for i in range(5))))
        parts.append(lanes_block(656, body_top, 368, ph, ["Every check runs through the owner", "Work waits for a reply", "Nothing moves overnight"], ["The agent checks on a clock", "Finished work is routed on", "The owner approves the output"], hero=False, side_by_side=False, size=19))
        y2 = body_top + ph + 34
        if pts:
            h2 = STRIP_TOP - 40 - y2 - keep_h - 30
            parts.append(points_placard(56, y2, W - 112, min(h2, 200), "From the post: this week, before building anything", pts))
            y2 = y2 + h2 + 30
        parts.append(keep_block(56, y2 + 10))
        parts.append('<div class="abs" style="left:%dpx;top:%dpx;width:%dpx;border-top:1.5px solid var(--subtle)"></div>' % (400, y2 + 40, W - 456))
    else:  # checklist
        items = [str(x) for x in spec.get("items", [])][:6]
        hd, body_top = header(kicker, title, hook if hook and hook.lower() != title.lower() else None); parts.append(hd)
        avail = STRIP_TOP - body_top - 40; ph = avail - 150
        row_pad = max(14, min(64, (ph - 110) // max(1, len(items)) // 2 - 20))
        rows = []
        for i, t in enumerate(items):
            last = i == len(items) - 1 and len(items) > 3
            rows.append('<div style="display:flex;gap:22px;align-items:flex-start;padding:%dpx 0;border-bottom:1px solid var(--subtle)%s"><span style="flex:0 0 34px;height:34px;border:2px solid var(--%s);border-radius:6px;margin-top:2px"></span>'
                        '<span style="font-size:%dpx;line-height:1.3;color:var(--ink);font-weight:%d">%s</span></div>' % (row_pad, ";border-bottom:0" if last else "", "gold" if last else "accent", 27 if len(t) <= 56 else 23, 500 if last else 400, esc(t)))
        parts.append('<div class="placard plate" style="left:56px;top:%dpx;width:968px;height:%dpx;padding:28px 34px 20px" data-hero><div class="mono" style="font-size:12px;color:var(--ink-faint)">Score yourself</div>%s</div>' % (body_top, ph, "".join(rows)))
        y2 = body_top + ph + 34
        parts.append(keep_block(56, y2))
        parts.append('<div class="abs" style="left:%dpx;top:%dpx;width:%dpx;border-top:1.5px solid var(--subtle)"></div>' % (400, y2 + 30, W - 456))
    parts.append(strip(source)); parts.append('<div class="grain"></div>')
    page = head + "<body>\n<div class=\"canvas\">\n" + "\n".join(parts) + "\n</div>\n</body>\n</html>\n"
    page = page.replace("<title>Operations Director picture</title>", "<title>%s</title>" % esc(title or shape_name))
    return page


LOGO_SVG = open(SCAFFOLD).read().split('<span class="logo"')[1].split("</span>")[0].split(">", 1)[1] if os.path.exists(SCAFFOLD) else ""


def render(template, spec, post_text, source, day, out_png, scale=2, rich=None):
    page = build_rich(template, spec, rich, post_text, source, day) if rich else build(template, spec, post_text, source, day)
    html_path = out_png[:-4] + ".html"
    with open(html_path, "w") as fh: fh.write(page)
    r = subprocess.run(["node", os.path.join(EPIC, "scripts", "check.mjs"), html_path, "--width", str(W), "--height", str(H)], capture_output=True, text=True, timeout=180)
    m = re.search(r"check: (\d+) error", (r.stdout or "") + (r.stderr or "")); n_err = int(m.group(1)) if m else (0 if r.returncode == 0 else 1)
    if n_err: raise SystemExit("board preflight: %d error(s): %s" % (n_err, ((r.stdout or "") + (r.stderr or ""))[-400:]))
    r2 = subprocess.run(["node", os.path.join(EPIC, "scripts", "render.mjs"), html_path, out_png, "--width", str(W), "--height", str(H), "--scale", str(scale)], capture_output=True, text=True, timeout=240)
    if r2.returncode != 0 or not os.path.exists(out_png): raise SystemExit("board render failed: " + (r2.stderr or r2.stdout)[-300:])
    return out_png, html_path


def selftest():
    spec = {"title": "Turn your SOP into an agent", "steps": ["Pick one task you still field questions about weekly.", "Write the SOP as decisions and actions.", "Create a universal SOP agent.", "Run on one live example. Human check: compare to your output.", "Correct the SOP where the output went wrong.", "Three clean runs in a row. Step out of the loop."]}
    page = build("steps", spec, "The SOP is not the finish line.\n\nbody", "Episode 1992", "Tue").split("<body>")[1]
    assert page.count('class="station') == 6 and "Owner approves" in page and 'data-hero' in page and "Kevin" not in page and "Source · Episode 1992" in page
    for tpl, sp in [("before_after", {"title": "Hire an agent before you hire a person", "before": ["a", "b", "c"], "after": ["d", "e", "f"]}),
                    ("stat", {"title": "Every handoff waits for the owner", "number": "30 min", "label": "how often the dispatcher checks for finished work", "source": "x"}),
                    ("flow", {"title": "Audiobook Processor workflow", "boxes": ["Book joins the queue", "Transcribe overnight", "Build brain doc", "Read the output"], "human": 3}),
                    ("checklist", {"title": "Five signs your business runs on you", "items": ["one", "two", "three", "four", "Tick three or more: move one job this week"]})]:
        pg = build(tpl, sp, "Hook line.\n\nbody", "the Operations Director agent register", "Wed").split("<body>")[1]
        assert pg.count("data-hero") == 1 and "Operations Director" in pg and '<div class="strip">' in pg, tpl
    fl = build("flow", {"title": "T", "boxes": ["a", "b", "c", "d"], "human": 3}, "h", "s", "Thu"); assert "Trigger" in fl and fl.count("Owner approves") == 1
    rich = {"title": "Turn your SOP into an agent", "highlight": "into an agent", "standfirst": "Six stations, one human check.", "items": [{"head": "Pick one task", "detail": "The one you still answer weekly", "icon": "inbox"}, {"head": "Write the SOP as decisions", "detail": "Not explanations", "icon": "notebook"}, {"head": "Load it into the agent", "detail": "", "icon": "agent"}, {"head": "Run one live example", "detail": "Compare to your output", "icon": "person"}],
            "hero": {"value": "3 clean runs", "label": "then step out"}, "rule": "The SOP without the agent is a document you still follow yourself.", "guide": ["Pick", "Write", "Load", "Run"]}
    rp = build_rich("steps", spec, rich, "The SOP is not the finish line.", "Episode 1992", "Tue").split("<body>")[1]
    assert rp.count("data-hero") == 1 and "into an agent" in rp and "The rule" in rp and "Kevin" not in rp and rp.count("dashed") == 4
    ba = build_rich("before_after", {"title": "T", "before": ["a", "b"], "after": ["c", "d"]}, {"title": "Hire an agent before you hire a person", "highlight": "before you hire", "items": [{"head": "a"}, {"head": "b"}, {"head": "c"}, {"head": "d"}], "rule": "R", "guide": ["1", "2", "3"], "left_label": "By hand", "right_label": "With an agent"}, "hook", "s", "Mon").split("<body>")[1]
    assert ba.count("data-hero") == 1 and "3-step guide" in ba and "By hand" in ba
    assert "<script" not in page and esc("<b>x</b>") == "&lt;b&gt;x&lt;/b&gt;"
    assert post_points("Hook.\n\n1. First thing.\n2. Second thing.\nText\n3) Third") == ["First thing.", "Second thing.", "Third"] and post_points("no numbers") == []
    checks = 8
    if os.path.exists(os.path.join(EPIC, "scripts", "render.mjs")):
        out = os.path.join(tempfile.gettempdir(), "od-board-selftest.png"); render("steps", spec, "The SOP is not the finish line.", "Episode 1992", "Tue", out, scale=1)
        assert os.path.getsize(out) > 20000; os.remove(out); os.remove(out[:-4] + ".html"); checks += 1
    print(json.dumps({"checks": checks + 3, "failed": []}))


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 2 and sys.argv[1] == "trial":
        st = json.load(open(os.path.expanduser("~/knowledge-os/logs/content-engine/od-lane.json"))); p = st["posts"][sys.argv[2]]
        import od_prompts as P, od_compose as C
        tpl = P.SHAPES[p["day"]]["visual"]; out = sys.argv[3] if len(sys.argv) > 3 else "board-trial.png"
        print(render(tpl, p["visual"], p["text"], C.picture_source(p.get("source_line", "")), p["day"], out))
    else: selftest()
