"""Content Engine, Operations Director lane: the infographics (VERSION 2, Kevin 4 Sep 2026: "it can't just be a blank
quote", infographic-style visuals).

Five templates, one per post shape, rendered from HTML with the repo's own design tokens (css/tokens.css, DM Sans via
Google Fonts with the platform's fallback) through Playwright Chromium (render_infographic.js). Every visual is drawn by
code from the post's own method or number: playbook rule 2 (AI imagery is illustration, never proof) is satisfied because
nothing here can be mistaken for a screenshot, a person or a result that did not happen. 1200x1500 (4:5) PNG, which
LinkedIn and Facebook both take; the Tuesday steps template can also emit a slide-per-step PDF for a LinkedIn carousel.
"""
import html, json, os, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
TOKENS = os.path.join(REPO, "css", "tokens.css")
RENDER = os.path.join(HERE, "render_infographic.js")
W, H = 1200, 1500
TEMPLATES = ("before_after", "steps", "stat", "flow", "checklist")

BASE_CSS = """
*{box-sizing:border-box} body{margin:0;width:%dpx;height:%dpx;background:var(--bg-app);font-family:var(--font-family-base,'DM Sans',sans-serif);color:var(--text-primary)}
.card{position:relative;margin:72px;padding:72px 80px;background:var(--bg-surface);border-left:16px solid var(--accent);height:%dpx;display:flex;flex-direction:column}
.kicker{color:var(--accent);font-weight:700;font-size:26px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:28px}
h1{font-size:62px;line-height:1.12;margin:0 0 44px;font-weight:700;letter-spacing:-.01em}
.foot{margin-top:auto;padding-top:36px;border-top:3px solid var(--border-default);display:flex;justify-content:space-between;align-items:flex-end;font-size:26px;color:var(--text-secondary)}
.foot b{color:var(--text-primary);font-weight:700}
.gold{display:inline-block;width:72px;height:8px;background:var(--accent-gold);margin-bottom:14px}
ol.steps{list-style:none;padding:0;margin:0;counter-reset:s} ol.steps li{counter-increment:s;display:flex;gap:28px;align-items:flex-start;font-size:38px;line-height:1.3;margin:0 0 26px}
ol.steps li::before{content:counter(s);flex:0 0 66px;height:66px;border-radius:50%%;background:var(--accent);color:#fff;font-weight:700;font-size:32px;display:flex;align-items:center;justify-content:center}
.cols{display:flex;gap:40px} .col{flex:1;padding:40px;border-radius:16px;background:var(--bg-surface-2);border:2px solid var(--border-default)} .col h2{margin:0 0 24px;font-size:30px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-secondary)} .col.after{background:var(--accent-soft);border-color:var(--accent)} .col.after h2{color:var(--accent)}
.col p{font-size:34px;line-height:1.3;margin:0 0 20px;padding-left:34px;position:relative} .col p::before{content:'';position:absolute;left:0;top:18px;width:14px;height:14px;border-radius:50%%;background:var(--text-muted)} .col.after p::before{background:var(--accent)}
.big{font-size:200px;font-weight:700;line-height:1;color:var(--accent);letter-spacing:-.03em;margin:40px 0 24px;word-break:break-word} .big.small{font-size:96px}
.label{font-size:44px;line-height:1.25;font-weight:700;margin-bottom:28px} .src{font-size:28px;color:var(--text-secondary)}
.flow{display:flex;flex-direction:column;gap:0;margin-top:10px} .box{padding:26px 34px;border-radius:14px;border:3px solid var(--border-default);background:var(--bg-surface-2);font-size:36px;font-weight:700;line-height:1.2}
.box.human{border-color:var(--accent-gold);background:#F7F1E3} .box.agent{border-color:var(--accent);background:var(--accent-soft)}
.arrow{height:44px;display:flex;justify-content:center;align-items:center;color:var(--text-muted);font-size:34px}
.tag{font-size:22px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;display:block;margin-bottom:6px;color:var(--text-secondary)} .box.human .tag{color:#8A6A24} .box.agent .tag{color:var(--accent)}
ul.check{list-style:none;padding:0;margin:0} ul.check li{display:flex;gap:26px;align-items:flex-start;font-size:38px;line-height:1.3;margin:0 0 28px} ul.check li::before{content:'';flex:0 0 52px;height:52px;border-radius:10px;border:4px solid var(--accent);margin-top:4px}
.legend{font-size:24px;color:var(--text-secondary);margin-top:18px}
""" % (W, H, H - 144)


def _page(kicker, body, footer_right="operationsdirector.co.uk"):
    return ("<!doctype html><html><head><meta charset='utf-8'><link rel='preconnect' href='https://fonts.googleapis.com'>"
            "<link rel='stylesheet' href='https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;700&display=swap'>"
            "<link rel='stylesheet' href='file://%s'><style>%s</style></head><body><div class='card'><div class='kicker'>%s</div>%s"
            "<div class='foot'><div><span class='gold'></span><br><b>Kevin Brittain</b><br>Operations Director</div><div>%s</div></div></div></body></html>"
            % (TOKENS, BASE_CSS, html.escape(kicker), body, html.escape(footer_right)))


def _lines(items, n_min, n_max, maxlen):
    out = [html.escape(str(x).strip())[:maxlen] for x in (items or []) if str(x).strip()]
    if len(out) < n_min: raise ValueError("needs %d-%d lines, got %d" % (n_min, n_max, len(out)))
    return out[:n_max]


def build_html(template, spec):
    """The HTML for one template from the model's VISUAL spec. Raises ValueError when the spec cannot fill it."""
    title = html.escape(str(spec.get("title", "")).strip())[:90]
    if template == "steps":
        steps = _lines(spec.get("steps"), 3, 7, 80)
        return _page("The method", "<h1>%s</h1><ol class='steps'>%s</ol>" % (title, "".join("<li><span>%s</span></li>" % s for s in steps)))
    if template == "before_after":
        before = _lines(spec.get("before"), 2, 4, 70); after = _lines(spec.get("after"), 2, 4, 70)
        return _page("The mistake", "<h1>%s</h1><div class='cols'><div class='col'><h2>By hand</h2>%s</div><div class='col after'><h2>With an agent</h2>%s</div></div>"
                     % (title, "".join("<p>%s</p>" % b for b in before), "".join("<p>%s</p>" % a for a in after)))
    if template == "stat":
        number = html.escape(str(spec.get("number", "")).strip())[:40]; label = html.escape(str(spec.get("label", "")).strip())[:120]; src = html.escape(str(spec.get("source", "")).strip())[:140]
        if not number or not label: raise ValueError("stat needs number and label")
        cls = "big small" if len(number) > 6 else "big"
        return _page("The build log", "<div class='%s'>%s</div><div class='label'>%s</div><div class='src'>Source: %s</div>" % (cls, number, label, src))
    if template == "flow":
        boxes = _lines(spec.get("boxes"), 3, 5, 40); human = spec.get("human", -1)
        try: human = int(human)
        except (TypeError, ValueError): human = -1
        parts = []
        for i, b in enumerate(boxes):
            cls = "box human" if i == human else ("box" if i == 0 else "box agent"); tag = "Owner approves" if i == human else ("Trigger" if i == 0 else "The agent")
            parts.append("<div class='%s'><span class='tag'>%s</span>%s</div>" % (cls, tag, b))
            if i < len(boxes) - 1: parts.append("<div class='arrow'>&#8595;</div>")
        return _page("The workflow", "<h1>%s</h1><div class='flow'>%s</div><div class='legend'>Green: the agent does it. Gold: the owner approves. Grey: what starts it.</div>" % (title, "".join(parts)))
    if template == "checklist":
        items = _lines(spec.get("items"), 3, 6, 70)
        return _page("The checklist", "<h1>%s</h1><ul class='check'>%s</ul>" % (title, "".join("<li><span>%s</span></li>" % i for i in items)))
    raise ValueError("unknown template %s" % template)


def slides_html(spec):
    """A slide per step for the Tuesday carousel PDF: cover, one step per page, closing page."""
    steps = _lines(spec.get("steps"), 3, 7, 80); title = html.escape(str(spec.get("title", "")).strip())[:90]
    pages = ["<div class='card'><div class='kicker'>The method</div><h1>%s</h1><div class='legend'>Swipe for the %d steps.</div>%s</div>" % (title, len(steps), _foot())]
    for i, s in enumerate(steps, 1):
        pages.append("<div class='card'><div class='kicker'>Step %d of %d</div><div class='big small'>%d</div><div class='label'>%s</div>%s</div>" % (i, len(steps), i, s, _foot()))
    pages.append("<div class='card'><div class='kicker'>Operations Director</div><h1>AI agents doing 90%% of the everyday work, so the business runs without you.</h1>%s</div>" % _foot())
    css = BASE_CSS + ".card{page-break-after:always;break-after:page;margin:72px}"
    return ("<!doctype html><html><head><meta charset='utf-8'><link rel='stylesheet' href='https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;700&display=swap'>"
            "<link rel='stylesheet' href='file://%s'><style>%s body{height:auto}</style></head><body>%s</body></html>" % (TOKENS, css, "".join(pages)))


def _foot():
    return "<div class='foot'><div><span class='gold'></span><br><b>Kevin Brittain</b><br>Operations Director</div><div>operationsdirector.co.uk</div></div>"


def render(template, spec, out_png, out_pdf=None):
    """Write the PNG (and the PDF for a carousel). Raises SystemExit with the renderer's error."""
    page = build_html(template, spec)
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as fh:
        fh.write(page); path = fh.name
    try:
        r = subprocess.run(["node", RENDER, path, out_png], capture_output=True, text=True, timeout=180)
    finally:
        os.remove(path)
    if r.returncode != 0 or not os.path.exists(out_png): raise SystemExit("infographic render failed: " + (r.stderr or r.stdout)[-300:])
    if out_pdf and template == "steps":
        with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as fh:
            fh.write(slides_html(spec)); spath = fh.name
        try:
            r2 = subprocess.run(["node", RENDER, spath, out_png + ".cover.png", "--pdf", out_pdf], capture_output=True, text=True, timeout=180)
        finally:
            os.remove(spath)
        if r2.returncode != 0: raise SystemExit("carousel render failed: " + (r2.stderr or r2.stdout)[-300:])
        try: os.remove(out_png + ".cover.png")
        except OSError: pass
    return out_png


def selftest():
    h = build_html("steps", {"title": "Hand your first job to an agent", "steps": ["Pick one weekly job", "Record it once", "Write the checklist", "Give the agent the checklist", "Approve ten outputs"]})
    assert "The method" in h and h.count("<li>") == 5 and "tokens.css" in h and "DM+Sans" in h
    h2 = build_html("before_after", {"title": "T", "before": ["a", "b"], "after": ["c", "d", "e"]}); assert "By hand" in h2 and "With an agent" in h2 and h2.count("<p>") == 5
    h3 = build_html("stat", {"number": "83 of 83", "label": "threads already had a task", "source": "AI Agents register, 2 Sep 2026"}); assert "big small" in h3 and "Source:" in h3
    h4 = build_html("flow", {"title": "T", "boxes": ["New email", "Agent sorts it", "Kevin approves", "Reply sent"], "human": 2}); assert h4.count("box human") == 1 and h4.count("box agent") == 2 and "Trigger" in h4
    h5 = build_html("checklist", {"title": "T", "items": ["a", "b", "c", "d"]}); assert h5.count("<li>") == 4
    for bad in (("steps", {"steps": ["only two", "steps"]}), ("stat", {"number": "", "label": "x"}), ("nope", {})):
        try: build_html(*bad); raise AssertionError("accepted %r" % (bad,))
        except ValueError: pass
    s = slides_html({"title": "T", "steps": ["a", "b", "c"]}); assert s.count("class='card'") == 5 and "Step 2 of 3" in s
    assert "<script" not in h and html.escape("<b>x</b>") in build_html("checklist", {"title": "<b>x</b>", "items": ["a", "b", "c"]}), "titles are escaped"
    checks = 9
    if os.path.exists(RENDER):
        out = os.path.join(tempfile.gettempdir(), "od-infographic-selftest.png")
        render("steps", {"title": "Hand your first job to an agent", "steps": ["Pick one weekly job", "Record it once", "Write the checklist", "Give the agent the checklist", "Approve ten outputs"]}, out)
        assert os.path.getsize(out) > 20000; os.remove(out); checks += 1
    print(json.dumps({"checks": checks, "failed": []}))


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 3 and sys.argv[1] == "render":
        render(sys.argv[2], json.load(open(sys.argv[3])), sys.argv[4], sys.argv[5] if len(sys.argv) > 5 else None); print("ok")
    else: selftest()
