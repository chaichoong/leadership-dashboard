"""Content Engine, Operations Director lane: illustrated infographics through Gemini (Kevin, 4 Sep 2026: "we need to get better
infographics ... stuff like what Dan Martell uses ... Gemini, maybe with Nano Banana").

Gemini's image model draws the whole infographic (heading, the post's lines, small agent icons, arrows) in the Sage palette.
Because image models misspell, every picture is CHECKED: Gemini's text model transcribes the image and each required line must
appear at 80% or better; a miss is redrawn with the misspelt line called out, twice; then the code-drawn template
(od_infographic.py) is the fallback. Playbook rule 2 holds: the picture illustrates the post's own method or number, never a
screenshot, a person, a client or a result that did not happen, and the prompt forbids all of those.

Key: ~/.config/od/gemini_api_key (Kevin creates it once in Google AI Studio on his Workspace account; the Content Engine never
sees it as an argument). No key = no illustration, the template is used and the card says so.
"""
import base64, difflib, json, os, re, urllib.error, urllib.request

KEY_FILE = os.path.expanduser("~/.config/od/gemini_api_key")
API = "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent"
IMAGE_MODEL = "gemini-2.5-flash-image"     # "Nano Banana"
TEXT_MODEL = "gemini-2.5-flash"
PALETTE = "pale sage background #F1F3EF, off-white panels #FBFBF9, forest green #2C6E49 for accents, icons and numbering, gold #C6A15B for one highlight, charcoal #1C2422 text"
STYLE = ("Clean, modern LinkedIn infographic in flat vector illustration style, the kind top business creators post: generous white space, one bold "
         "heading, clear hierarchy, simple friendly line icons of AI agents (small robot heads or chat bubbles with a spark), arrows and numbered "
         "markers, a subtle grid. Portrait 4:5. Typeface: a clean geometric sans-serif. " + PALETTE + ". Footer line: 'Kevin Brittain, Operations Director'. "
         "Every word of text must be spelled EXACTLY as given, in UK English. No photographs, no realistic people or faces, no logos of other "
         "companies, no fake screenshots or dashboards, no charts of invented data, no watermark, nothing that could be mistaken for a real product screen.")

LAYOUTS = {
    "steps": "Layout: the heading at the top, then the numbered steps as a vertical list, each with a green numbered circle, the step text, and a small icon; a thin connector line running down the numbers.",
    "before_after": "Layout: the heading at the top, then two columns side by side: left column headed 'By hand' in grey with the before lines as bullets and a tired-person icon; right column headed 'With an agent' in green with the after lines as bullets and a small robot icon; a bold arrow from left to right.",
    "stat": "Layout: one very large number in forest green filling the upper half, the label in bold charcoal under it, the source line small and grey at the bottom, one small icon that matches the label.",
    "flow": "Layout: the heading at the top, then the boxes as a vertical or snaking flow connected by arrows; the box marked as the owner's step in gold with a small person icon, the agent boxes in green with a small robot icon, the first box grey; a one-line legend.",
    "checklist": "Layout: the heading at the top, then the items as a checklist with empty green square tick-boxes, the last line set apart as the call to action.",
}


def key():
    try: return open(KEY_FILE).read().strip() or None
    except OSError: return None


def required_lines(template, spec):
    """The text that must be readable on the picture."""
    lines = [str(spec.get("title", "")).strip()]
    for k in ("steps", "before", "after", "boxes", "items"):
        lines += [str(x).strip() for x in (spec.get(k) or [])]
    if template == "stat": lines += [str(spec.get("number", "")).strip(), str(spec.get("label", "")).strip()]
    return [l for l in lines if l]


def build_prompt(template, spec, fixes=None):
    parts = [STYLE, LAYOUTS[template], "Heading: \"%s\"" % spec.get("title", "")]
    if template == "steps": parts.append("Steps, in this order and these exact words:\n" + "\n".join("%d. %s" % (i + 1, s) for i, s in enumerate(spec.get("steps", []))))
    if template == "before_after": parts.append("By hand:\n" + "\n".join("- " + s for s in spec.get("before", [])) + "\nWith an agent:\n" + "\n".join("- " + s for s in spec.get("after", [])))
    if template == "stat": parts.append("The number: \"%s\". The label: \"%s\". The source line: \"Source: %s\"." % (spec.get("number"), spec.get("label"), spec.get("source", "")))
    if template == "flow":
        boxes = spec.get("boxes", []); h = spec.get("human", -1)
        parts.append("Boxes in order:\n" + "\n".join("%d. %s%s" % (i + 1, b, " (the OWNER's step, gold)" if i == h else (" (start, grey)" if i == 0 else " (the agent, green)")) for i, b in enumerate(boxes)))
    if template == "checklist": parts.append("Checklist items, these exact words:\n" + "\n".join("[ ] " + s for s in spec.get("items", [])))
    if fixes: parts.append("The previous attempt misspelt or omitted these lines; render them exactly, letter for letter: " + " | ".join(fixes))
    return "\n\n".join(parts)


def _post(model, body, k):
    req = urllib.request.Request(API % model + "?key=" + k, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r: return json.load(r)


def generate(prompt, k):
    """One image (PNG bytes) or None."""
    body = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "4:5"}}}
    try: r = _post(IMAGE_MODEL, body, k)
    except urllib.error.HTTPError as e:
        msg = e.read().decode()[:300]
        if "imageConfig" in msg or "aspectRatio" in msg:      # older API surface: retry without the config
            body["generationConfig"] = {"responseModalities": ["IMAGE"]}
            try: r = _post(IMAGE_MODEL, body, k)
            except urllib.error.HTTPError as e2: raise SystemExit("gemini image: %s %s" % (e2.code, e2.read().decode()[:200]))
        else: raise SystemExit("gemini image: %s %s" % (e.code, msg))
    for cand in r.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            data = (part.get("inlineData") or part.get("inline_data") or {}).get("data")
            if data: return base64.b64decode(data)
    return None


def transcribe(png_bytes, k):
    body = {"contents": [{"parts": [{"inlineData": {"mimeType": "image/png", "data": base64.b64encode(png_bytes).decode()}},
                                    {"text": "Transcribe every piece of text in this image, one line per text element, exactly as written. Output the lines only."}]}]}
    try: r = _post(TEXT_MODEL, body, k)
    except urllib.error.HTTPError as e: raise SystemExit("gemini read: %s %s" % (e.code, e.read().decode()[:200]))
    out = []
    for cand in r.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            if part.get("text"): out.append(part["text"])
    return "\n".join(out)


def check_text(required, transcript, min_ratio=0.8):
    """Lines the picture got wrong (missing or misspelt). Compared on normalised words against the best transcript line or window."""
    norm = lambda s: re.sub(r"[^a-z0-9 ]", "", re.sub(r"\s+", " ", s.lower())).strip()
    t_lines = [norm(l) for l in transcript.splitlines() if l.strip()]; whole = " ".join(t_lines)
    bad = []
    for line in required:
        q = norm(line)
        if not q: continue
        if q in whole: continue
        best = max([difflib.SequenceMatcher(None, q, tl).ratio() for tl in t_lines] + [0.0])
        if best < min_ratio:
            n = len(q.split()); tw = whole.split()
            for i in range(max(1, len(tw) - n + 1)):
                best = max(best, difflib.SequenceMatcher(None, q, " ".join(tw[i:i + n])).ratio())
                if best >= min_ratio: break
        if best < min_ratio: bad.append(line)
    return bad


def illustrate(template, spec, out_png, attempts=3, log=print):
    """Draw, check, redraw. Returns (path, note) on success or (None, reason)."""
    k = key()
    if not k: return None, "no Gemini key at %s" % KEY_FILE
    if template not in LAYOUTS: return None, "no layout for %s" % template
    required = required_lines(template, spec); fixes = None
    for i in range(1, attempts + 1):
        try:
            png = generate(build_prompt(template, spec, fixes), k)
            if not png: log("illustrate: attempt %d returned no image" % i); continue
            bad = check_text(required, transcribe(png, k))
        except SystemExit as ex:
            return None, str(ex)[:200]
        if not bad:
            with open(out_png, "wb") as fh: fh.write(png)
            return out_png, "Gemini illustration, text verified on attempt %d" % i
        log("illustrate: attempt %d misspelt %d line%s: %s" % (i, len(bad), "" if len(bad) == 1 else "s", "; ".join(bad)[:200]))
        fixes = bad
    return None, "text still wrong after %d attempts" % attempts


def selftest():
    spec = {"title": "Turn your SOP into an agent", "steps": ["Pick one task", "Write the SOP as decisions", "Load it into the agent"]}
    p = build_prompt("steps", spec); assert "Turn your SOP into an agent" in p and "1. Pick one task" in p and "#2C6E49" in p and "No photographs" in p
    p2 = build_prompt("steps", spec, fixes=["Load it into the agent"]); assert "letter for letter" in p2
    assert required_lines("steps", spec) == ["Turn your SOP into an agent", "Pick one task", "Write the SOP as decisions", "Load it into the agent"]
    assert required_lines("stat", {"title": "", "number": "30 min", "label": "how often it checks", "source": "x"}) == ["30 min", "how often it checks"]
    ok = "TURN YOUR SOP INTO AN AGENT\n1 Pick one task\n2 Write the SOP as decisions\n3 Load it into the agent\nKevin Brittain, Operations Director"
    assert check_text(required_lines("steps", spec), ok) == []
    bad = check_text(required_lines("steps", spec), ok.replace("decisions", "decsions").replace("Load it into the agent", "Lod the agnt"))
    assert bad == ["Load it into the agent"], bad
    fp = build_prompt("flow", {"title": "T", "boxes": ["Email in", "Agent sorts", "Owner approves", "Reply out"], "human": 2}); assert "(the OWNER's step, gold)" in fp and fp.count("(the agent, green)") == 2
    old = globals()["KEY_FILE"]; globals()["KEY_FILE"] = "/nonexistent/key"; assert illustrate("steps", spec, "/tmp/x.png")[0] is None and "no Gemini key" in illustrate("steps", spec, "/tmp/x.png")[1]; globals()["KEY_FILE"] = old
    print(json.dumps({"checks": 9, "failed": []}))


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 3 and sys.argv[1] == "draw":
        path, note = illustrate(sys.argv[2], json.load(open(sys.argv[3])), sys.argv[4] if len(sys.argv) > 4 else "illustrated.png"); print(path, note)
    else: selftest()
