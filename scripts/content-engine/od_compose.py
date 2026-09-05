"""Content Engine, Operations Director lane: composed infographics with the EpicInfographics method (Kevin, 4 Sep 2026: option 1,
the skill with an Operations Director design language, one language for all five shapes).

The skill (scripts/content-engine/epic/, MIT, vendored from OrRon/EpicInfographics) is a METHOD, not a model: a self-contained
HTML/CSS+SVG page in one fully specified design language, a mechanical preflight that measures every glyph for collisions,
clipping and size, then a Playwright render. Here a headless Claude call composes the page from the post's own words and the
brief; check.mjs must pass with zero errors (two repair rounds, the checker's report fed back); render.mjs draws the PNG; every
required line must appear in the page text exactly (typed, so no misspelling is possible). No image model, no person's name.
"""
import html, json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import platform_copy as pc  # noqa: E402
import od_prompts as P      # noqa: E402

EPIC = os.path.join(HERE, "epic")
REFS = os.path.join(EPIC, "references")
LANGUAGE = os.path.join(REFS, "design-languages", "operations-director.md")
W, H = 1080, 1350
MODEL = "sonnet"            # AI model spend rule: standard tier; escalate by hand if compositions keep failing preflight
REPAIRS = 3
THINKING = 1024              # thinking budget for the composer: the default budget spent ~9 minutes before the first line (5 Sep 2026)

SHAPE_TO_FORM = {
    "steps": "a numbered route with stations (Step flow on the route; the human check, if named in the steps, is the gold owner stop)",
    "before_after": "two lanes on the board (Versus panel): the by-hand lane in de-emphasis with a hand-drawn wobble, the with-an-agent lane in sage with the agent mark; the route crosses between them",
    "stat": "one placard with the hero number huge in sage, its label under it, its source in mono; around it the route or a small scene that explains where the number comes from",
    "flow": "the route with stations, the owner's stop in gold, the agent mark at the agent's stations; a trigger at the start and the output at the end",
    "checklist": "a clipboard placard with tick boxes down the board, the last item set apart as the call to action",
}


def _read(path, limit=None):
    try: t = open(path).read()
    except OSError: return ""
    return t[:limit] if limit else t


def required_lines(template, spec):
    lines = [str(spec.get("title", "")).strip()]
    for k in ("steps", "before", "after", "boxes", "items"): lines += [str(x).strip() for x in (spec.get(k) or [])]
    if template == "stat": lines += [str(spec.get("number", "")).strip(), str(spec.get("label", "")).strip()]
    return [l for l in lines if l]


def _section(text, start, end=None):
    i = text.find(start)
    if i < 0: return ""
    j = text.find(end, i + len(start)) if end else -1
    return text[i: j if j > 0 else None]


def system_prompt():
    """The method, trimmed to what a one-shot composer needs: the build and review rules of SKILL.md (not the interview steps), the
    composition and illustration references, the skeleton, and the design language last. The full pack (charts, data vocabulary,
    motion) pushed one call past ten minutes on 4 Sep 2026."""
    skill = _read(os.path.join(EPIC, "SKILL.md"))
    # steps 9-11 tell an agent to run the checker, render and look at the PNG: with tools switched off the headless call tried to and hung
    # (two 25-minute stalls, 4-5 Sep 2026), so the composer gets steps 7-8 and the hard rules only; this script runs 9-10 for it.
    core = _section(skill, "### 7. Choose data representations", "### 9. Preflight") + "\n" + _section(skill, "## Hard rules")
    core = "\n".join(l for l in core.splitlines() if not re.search(r"check\.mjs|render\.mjs|animate\.mjs|run it", l))
    comp = _read(os.path.join(REFS, "composition.md"))
    illus = _section(_read(os.path.join(REFS, "illustration-and-texture.md")), "# Illustration", "## Texture & finish")
    skeleton = _read(os.path.join(EPIC, "templates", "skeleton.html"))
    lang = _read(LANGUAGE)
    return ("You are producing ONE infographic as a single self-contained HTML file, following the Epic Infographics method below exactly. You are running unattended and you have NO tools: "
            "do not run commands, do not read or write files, do not ask questions, do not offer options, do not pitch angles. The preflight check and the render are run for you after you answer. "
            "Take the brief and write the file in one pass. Keep the page lean: one canvas div, inline SVG for the drawing, no more than about 250 lines. "
            "Output ONLY the HTML document, starting with <!doctype html>, no commentary, no markdown fences.\n\n=== The method (from SKILL.md) ===\n" + core +
            "\n\n=== composition.md ===\n" + comp + "\n\n=== illustration-and-texture.md (drawing method) ===\n" + illus +
            "\n\n=== templates/skeleton.html ===\n" + skeleton + "\n\n=== THE DESIGN LANGUAGE TO USE, AND THE ONLY ONE: operations-director.md ===\n" + lang)


def user_prompt(template, spec, post_text, shape_name, day, source_line, feedback=""):
    req = required_lines(template, spec)
    return ("BRIEF\nAudience: founder-led UK business owners, stressed and overwhelmed, everything bottlenecks on them. Goal: one thing they can use this week to hand a real job to an AI agent. "
            "Context: a LinkedIn feed post for the Operations Director company page; the picture must read at phone size. Canvas: %dx%d (portrait, 4:5); set --canvas-w and --canvas-h accordingly and "
            "make .canvas exactly that size with overflow hidden. Still image only.\n\n"
            "DESIGN LANGUAGE: operations-director (the only one). SHAPE: %s (%s). FORM: %s.\n\n"
            "THE POST THIS PICTURE ACCOMPANIES (the picture repeats its method or number; it never adds a fact):\n%s\n\n"
            "TEXT THAT MUST APPEAR ON THE PICTURE, EXACTLY THESE WORDS (UK English, sentence case as given), and nothing beyond them except the design language's own chrome "
            "(kicker, station numbers, mono labels such as STATION 01, OWNER APPROVES, the source line, the title strip):\n%s\n\n"
            "SOURCE LINE for the title strip, exactly this and nothing more: %s\n\n"
            "HARD RULES: no person's name anywhere; the brand is Operations Director with its logo in the title strip (copy the inline SVG from the design language). No emoji. No invented numbers. "
            "Mark exactly ONE element data-hero (the route or the placard), never two. Every string above must be present as VISIBLE text on the canvas, in HTML or SVG <text>, exactly once: "
            "never hidden, never off-canvas, never display:none, opacity 0 or a duplicate copy for the checker; hidden text is a preflight error and fails the picture. No text smaller than 13px. "
            "A station number badge must sit beside its text, never on it: leave 16px between a badge and the label. Fonts via the Google Fonts link in the design language only.%s"
            % (W, H, shape_name, day, SHAPE_TO_FORM.get(template, "the route"), post_text, "\n".join("- " + l for l in req), picture_source(source_line),
               ("\n\nTHE PREVIOUS ATTEMPT FAILED PREFLIGHT. Fix exactly these and change nothing else that works:\n" + feedback) if feedback else ""))


PUBLIC_SOURCES = [(r"prospects table|job ad", "a real job advert, anonymised"), (r"build log|register", "the Operations Director agent register"),
                  (r"frameworks library", "the Operations Director method"), (r"hot-button|playbook", "real sales conversations"), (r"episode (\d+)", "Episode \\1")]


def picture_source(source_line):
    """The source as it may appear ON a picture: a public-facing phrase, never an internal table name, never Kevin's name, never a
    verbatim quote, never a running word."""
    s = (source_line or "")
    for pat, label in PUBLIC_SOURCES:
        m = re.search(pat, s, re.I)
        if m: return re.sub(pat, label, m.group(0), flags=re.I)[:80]
    s = re.sub(r"Kevin's own words on camera|Kevin's|Kevin|,?\s*verbatim|the run diary|run diary", "", s.split(":")[0], flags=re.I)
    return re.sub(r"\s+", " ", s).strip(" ,.")[:80] or "Operations Director"


# ---------- the model call: the app's Claude proxy (Messages API, no extended thinking), the CLI as fallback ----------
PROXY = "https://claude-proxy.kevinbrittain.workers.dev"
PROXY_TOKEN_FILE = os.path.expanduser("~/.config/od/proxy_service_token2")
UA = "Mozilla/5.0 od-content-engine"       # Cloudflare's edge blocks Python's default user agent (error 1010) before the worker sees the request
MAX_TOKENS = 16000


def api_model():
    """The app's default model id from js/ai-models.js (the one source of model ids), else the known standard-tier id."""
    try:
        js = open(os.path.join(os.path.dirname(os.path.dirname(HERE)), "js", "ai-models.js")).read()
        m = re.search(r"\bdefault:\s*['\"]([^'\"]+)['\"]", js)      # js/ai-models.js: `default: 'claude-…'`
        if m: return m.group(1)
    except OSError: pass
    return "claude-sonnet-4-6"


def ask_api(system, user, model=None, max_tokens=MAX_TOKENS, timeout=900):
    """One Messages API call through the proxy: no tools, no extended thinking, a hard max_tokens. Measured 5 Sep 2026: the headless CLI
    spent 9-20 minutes thinking before its first token on this brief; a plain API call writes the page in a few minutes."""
    import urllib.request, urllib.error
    try: token = open(PROXY_TOKEN_FILE).read().strip()
    except OSError: raise SystemExit("no proxy token at %s" % PROXY_TOKEN_FILE)
    body = {"model": model or api_model(), "max_tokens": max_tokens, "system": system, "messages": [{"role": "user", "content": user}]}
    req = urllib.request.Request(PROXY, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + token, "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: d = json.load(r)
    except urllib.error.HTTPError as e: raise SystemExit("proxy %s: %s" % (e.code, e.read().decode()[:300]))
    text = "".join(part.get("text", "") for part in d.get("content", []) if part.get("type") == "text")
    usage = d.get("usage", {})
    return text, usage, None


def strip_html_text(page):
    t = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", page, flags=re.S | re.I)
    t = re.sub(r"<[^>]+>", " ", t); t = html.unescape(t)
    return re.sub(r"\s+", " ", t)


def missing_lines(page, required):
    norm = lambda s: re.sub(r"\s+", " ", re.sub(r"[^a-z0-9£%:.,' ]", "", s.lower())).strip()
    text = norm(strip_html_text(page))
    return [l for l in required if norm(l) not in text]


def extract_html(out):
    s = out.strip()
    if "```" in s: s = re.sub(r"^```[a-z]*\n|\n```$", "", s.strip(), flags=re.M)
    i = s.lower().find("<!doctype html")
    return s[i:] if i >= 0 else s


def run_check(html_path):
    r = subprocess.run(["node", os.path.join(EPIC, "scripts", "check.mjs"), html_path, "--width", str(W), "--height", str(H), "--json"], capture_output=True, text=True, timeout=180)
    out = (r.stdout or "") + (r.stderr or "")
    try:
        j = json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {}
        errors = j.get("errors", []) if isinstance(j, dict) else []
        warnings = j.get("warnings", []) if isinstance(j, dict) else []
        return len(errors), errors, warnings, out[-1500:]
    except (ValueError, IndexError):
        m = re.search(r"check: (\d+) error", out)
        return (int(m.group(1)) if m else (0 if r.returncode == 0 else 1)), [], [], out[-1500:]


def run_render(html_path, png_path, scale=2):
    r = subprocess.run(["node", os.path.join(EPIC, "scripts", "render.mjs"), html_path, png_path, "--width", str(W), "--height", str(H), "--scale", str(scale)], capture_output=True, text=True, timeout=240)
    if r.returncode != 0 or not os.path.exists(png_path): raise SystemExit("epic render failed: " + (r.stderr or r.stdout)[-300:])
    return png_path


def compose(template, spec, post_text, shape_name, day, source_line, out_png, keep_html=None, log=print, model=None):
    """Compose -> preflight (repairs) -> render -> verify text. Returns (png or None, note, html_path or None)."""
    if not os.path.exists(os.path.join(EPIC, "scripts", "check.mjs")): return None, "epic skill not vendored", None
    required = required_lines(template, spec)
    system = system_prompt(); feedback = ""; html_path = keep_html or (out_png[:-4] + ".html")
    for attempt in range(1, REPAIRS + 2):
        env_model = model or MODEL
        prompt = user_prompt(template, spec, post_text, shape_name, day, source_line, feedback)
        try:
            out, usage, cost = ask_api(system, prompt, model=(model if model and model.startswith("claude-") else None))
        except SystemExit as ex:
            log("compose: proxy call failed (%s); falling back to the CLI" % str(ex)[:120])
            out, usage, cost = pc.ask_claude_model(system, prompt, env_model, timeout=1200, thinking=THINKING, no_mcp=True)
        page = extract_html(out)
        if "<!doctype html" not in page.lower(): return None, "composer returned no HTML on attempt %d" % attempt, None
        with open(html_path, "w") as fh: fh.write(page)
        miss = missing_lines(page, required)
        n_err, errors, warnings, report = run_check(html_path)
        if not miss and n_err == 0:
            run_render(html_path, out_png)
            return out_png, "composed with the Epic Infographics method (operations-director language), preflight clean on attempt %d%s" % (attempt, (", %d warning%s" % (len(warnings), "" if len(warnings) == 1 else "s")) if warnings else ""), html_path
        problems = []
        if miss: problems.append("These required lines are missing or altered in the page text: " + " | ".join(miss))
        if n_err: problems.append("Preflight report (every line is a defect to fix; do not hide text to pass, move or shrink it):\n" + ("\n".join(errors)[:3000] if errors else report))
        feedback = "\n".join(problems)
        log("compose: attempt %d failed (%d missing line%s, %d preflight error%s)" % (attempt, len(miss), "" if len(miss) == 1 else "s", n_err, "" if n_err == 1 else "s"))
    return None, "preflight or text check still failing after %d attempts" % (REPAIRS + 1), html_path


def selftest():
    assert os.path.exists(LANGUAGE) and os.path.exists(os.path.join(EPIC, "scripts", "check.mjs")) and os.path.exists(os.path.join(EPIC, "scripts", "render.mjs"))
    lang = _read(LANGUAGE); assert "#2C6E49" in lang and "DM Sans" in lang and "No person" in lang.replace("no person", "No person") and "Runpreneur" in lang
    sp = system_prompt(); assert "operations-director.md" in sp and "Rule zero" in sp and "data-hero" in sp and "Hard rules" in sp and len(sp) < 60000, len(sp)
    assert "check.mjs" not in sp.split("=== composition.md ===")[0] and "Review your own PNG" not in sp, "the composer must never be told to run tools"
    spec = {"title": "Turn your SOP into an agent", "steps": ["Pick one task", "Write the SOP"]}
    up = user_prompt("steps", spec, "post body", "The method", "Tue", "Episode 1992")
    assert "- Turn your SOP into an agent" in up and "- Write the SOP" in up and "1080x1350" in up and "no person's name" in up and "data-hero" in up
    assert "PREVIOUS ATTEMPT FAILED" in user_prompt("steps", spec, "p", "s", "Tue", "src", feedback="fix x") and "never hidden" in up and REPAIRS == 3
    page = "<!doctype html><html><head><style>.x{}</style></head><body><h1>Turn your SOP into an agent</h1><p>Pick one task</p><p>Write the SOP</p></body></html>"
    assert missing_lines(page, required_lines("steps", spec)) == [] and missing_lines(page, ["Not there"]) == ["Not there"]
    assert extract_html("```html\n<!doctype html><p>x</p>\n```").startswith("<!doctype html") and extract_html("Sure! <!DOCTYPE html><p>").lower().startswith("<!doctype html")
    assert required_lines("stat", {"title": "", "number": "30 min", "label": "checks", "source": "s"}) == ["30 min", "checks"]
    assert api_model().startswith("claude-") and PROXY.startswith("https://claude-proxy.")
    assert picture_source("Episode 1992, Kevin's own words on camera: \"you've now got the ability\"") == "Episode 1992"
    assert picture_source("Build log: agent \"Agent Dispatch\" (register, Status Live) and 5 merged pull requests") == "the Operations Director agent register"
    assert picture_source("Prospects table: a real Job Ad (Indeed) harvested by the prospecting agent, anonymised") == "a real job advert, anonymised"
    assert picture_source("Frameworks Library: \"3-Tier\" (author Austin Chen, not to be named), applied") == "the Operations Director method"
    assert "Kevin" not in user_prompt("steps", spec, "p", "s", "Tue", "Episode 1992, Kevin's own words on camera: \"q\"").split("SOURCE LINE")[1].split("\n")[0]
    # the vendored checker runs on the repo's Playwright: a deliberately clipped page must report an error
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as fh:
        fh.write("<!doctype html><html><body style='margin:0'><div style='width:1080px;height:1350px;overflow:hidden;position:relative'><p style='position:absolute;left:1060px;top:10px;font-size:20px;white-space:nowrap'>this text is clipped</p><p style='font-size:20px' data-hero>hero</p></div></body></html>"); bad = fh.name
    n, errors, warnings, report = run_check(bad); os.remove(bad)
    assert n >= 1, report[-300:]
    print(json.dumps({"checks": 15, "failed": []}))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "trial":
        st = json.load(open(os.path.expanduser("~/knowledge-os/logs/content-engine/od-lane.json")))
        p = st["posts"][sys.argv[2]]; tpl = P.SHAPES[p["day"]]["visual"]
        out = sys.argv[3] if len(sys.argv) > 3 else "compose-trial.png"
        print(compose(tpl, p["visual"], p["text"], p["shape"], p["day"], p.get("source_line", ""), out, model=(sys.argv[4] if len(sys.argv) > 4 else None)))
    else: selftest()
