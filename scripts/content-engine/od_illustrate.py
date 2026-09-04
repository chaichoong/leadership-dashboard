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
IMAGE_MODELS = ["gemini-3.1-flash-image", "gemini-3-pro-image", "gemini-3-pro-image"]   # attempt 1 flash ("Nano Banana"), retries on Pro, which renders text better (models listed on Kevin's key, 4 Sep 2026)
IMAGE_MODEL = IMAGE_MODELS[0]
TEXT_MODEL = "gemini-3.6-flash"   # the current flash text model on Kevin's key (2.5 was retired for new users, 4 Sep 2026)
PALETTE = "pale sage background #F1F3EF, off-white panels #FBFBF9, forest green #2C6E49 for accents, icons and numbering, gold #C6A15B for one highlight, charcoal #1C2422 text"
STYLE = ("Clean, modern LinkedIn infographic in flat vector illustration style, the kind top business creators post: generous white space, one bold "
         "heading, clear hierarchy, simple friendly line icons of AI agents (small robot heads or chat bubbles with a spark), arrows and numbered "
         "markers, a subtle grid. Portrait 4:5. Typeface: a clean geometric sans-serif. " + PALETTE + ". Footer, small, bottom left, the two words Operations Director with no quotation marks around them. No person's name anywhere on the picture, no signature, no headshot: generic and universal. Leave a clear bottom-right corner for the logo. "
         "Every word of text must be spelled EXACTLY as given, in UK English. Use ONLY the text given below: no extra captions, labels, sub-steps or slogans of your own (the Pro model added three invented process boxes on 4 Sep 2026). No photographs, no realistic people or faces, no logos of other "
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
        parts.append("Boxes in order, these exact words and nothing else inside the boxes:\n" + "\n".join("%d. %s" % (i + 1, b) for i, b in enumerate(boxes)))
        parts.append("Colour the boxes without writing the colour names: box 1 grey (the trigger); %s; every other box green (the agent's steps). Number the boxes once, in the green markers only, never inside the box text."
                     % (("box %d gold with a small person icon (the owner's step)" % (h + 1)) if 0 <= h < len(boxes) else "no gold box"))
    if template == "checklist": parts.append("Checklist items, these exact words:\n" + "\n".join("[ ] " + s for s in spec.get("items", [])))
    if fixes: parts.append("The previous attempt misspelt or omitted these lines; render them exactly, letter for letter: " + " | ".join(fixes))
    return "\n\n".join(parts)


def _post(model, body, k):
    req = urllib.request.Request(API % model + "?key=" + k, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r: return json.load(r)


def generate(prompt, k, model=None):
    """One image (PNG bytes) or None."""
    model = model or IMAGE_MODEL
    body = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "4:5"}}}
    try: r = _post(model, body, k)
    except urllib.error.HTTPError as e:
        msg = e.read().decode()[:300]
        if "imageConfig" in msg or "aspectRatio" in msg or "responseModalities" in msg:      # older API surface: retry without the config
            body["generationConfig"] = {"responseModalities": ["IMAGE"]} if "responseModalities" not in msg else {}
            try: r = _post(model, body, k)
            except urllib.error.HTTPError as e2: raise SystemExit("gemini image (%s): %s %s" % (model, e2.code, e2.read().decode()[:200]))
        else: raise SystemExit("gemini image (%s): %s %s" % (model, e.code, msg))
    for cand in r.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            data = (part.get("inlineData") or part.get("inline_data") or {}).get("data")
            if data: return base64.b64decode(data)
    return None


READ_PROMPT = ("Transcribe every piece of text in this image, one line per text element, EXACTLY as the letters appear. Do not correct spelling, "
               "do not complete words, do not guess: copy misspellings and nonsense letter for letter, and write [unreadable] for anything you cannot read. "
               "Then on a final line write VERDICT: CLEAN if every word is a real, correctly spelt English word or a number, or VERDICT: GARBLED "
               "followed by the garbled fragments if any text is misspelt, jumbled, cut off or nonsensical.")


def transcribe(png_bytes, k):
    body = {"contents": [{"parts": [{"inlineData": {"mimeType": "image/png", "data": base64.b64encode(png_bytes).decode()}}, {"text": READ_PROMPT}]}],
            "generationConfig": {"temperature": 0}}
    try: r = _post(TEXT_MODEL, body, k)
    except urllib.error.HTTPError as e: raise SystemExit("gemini read: %s %s" % (e.code, e.read().decode()[:200]))
    out = []
    for cand in r.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            if part.get("text"): out.append(part["text"])
    return "\n".join(out)


def garbled_verdict(transcript):
    """The reader's own judgement line: 'GARBLED ...' or None. A model transcribing tends to auto-correct, so it is also asked to judge."""
    m = re.search(r"VERDICT:\s*(CLEAN|GARBLED.*)", transcript, re.I | re.S)
    if not m: return None
    v = m.group(1).strip()
    return None if v.upper().startswith("CLEAN") else v[:200]


def check_text(required, transcript, min_ratio=0.92):
    """Lines the picture got wrong (missing or misspelt). Each required line must match a transcript line or window at 92% AND every
    word of it must appear in the transcript; the reader's GARBLED verdict fails the picture outright. (The first version passed a
    stat card reading "finshed agent agent ela wort aun" at 80%, 4 Sep 2026.)"""
    norm = lambda s: re.sub(r"[^a-z0-9 ]", "", re.sub(r"\s+", " ", s.lower())).strip()
    g = garbled_verdict(transcript)
    if g: return ["reader verdict: " + g]
    transcript = re.sub(r"VERDICT:.*", "", transcript, flags=re.I | re.S)
    t_lines = [norm(l) for l in transcript.splitlines() if l.strip()]; whole = " ".join(t_lines); words = set(whole.split())
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
        missing = [w for w in q.split() if len(w) > 2 and w not in words]
        if best < min_ratio or missing: bad.append(line)
    return bad


FFMPEG = os.path.expanduser("~/tools/bin/ffmpeg")
LOGO = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "assets", "od-logo.png")


def brand(png_path, logo=None, size=110, margin=48):
    """Stamp the Operations Director logo bottom-right (Kevin: the brand and logo, never his name). In place; returns True when done."""
    logo = logo or LOGO
    if not (os.path.exists(FFMPEG) and os.path.exists(logo) and os.path.exists(png_path)): return False
    import subprocess, tempfile
    tmp = png_path + ".branded.png"
    r = subprocess.run([FFMPEG, "-v", "error", "-y", "-i", png_path, "-i", logo, "-filter_complex",
                        "[1:v]scale=%d:-1[l];[0:v][l]overlay=W-w-%d:H-h-%d" % (size, margin, margin), "-frames:v", "1", tmp], capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(tmp): return False
    os.replace(tmp, png_path); return True


def illustrate(template, spec, out_png, attempts=3, log=print):
    """Draw, check, redraw. Returns (path, note) on success or (None, reason)."""
    k = key()
    if not k: return None, "no Gemini key at %s" % KEY_FILE
    if template not in LAYOUTS: return None, "no layout for %s" % template
    required = required_lines(template, spec); fixes = None
    for i in range(1, attempts + 1):
        model = IMAGE_MODELS[min(i - 1, len(IMAGE_MODELS) - 1)]
        try:
            png = generate(build_prompt(template, spec, fixes), k, model)
            if not png: log("illustrate: attempt %d returned no image" % i); continue
            bad = check_text(required, transcribe(png, k))
        except SystemExit as ex:
            return None, str(ex)[:200]
        if not bad:
            with open(out_png, "wb") as fh: fh.write(png)
            stamped = brand(out_png)
            return out_png, "Gemini illustration (%s), text verified on attempt %d%s" % (model, i, ", logo stamped" if stamped else "")
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
    assert check_text(required_lines("steps", spec), ok + "\nVERDICT: CLEAN") == []
    bad = check_text(required_lines("steps", spec), ok.replace("decisions", "decsions").replace("Load it into the agent", "Lod the agnt") + "\nVERDICT: CLEAN")
    assert bad == ["Write the SOP as decisions", "Load it into the agent"], bad
    assert check_text(["30 min", "how often the dispatcher checks for finished agent work"], "30 min\nhow often the dispatcher checks for finshed agent agent ela wort aun\nVERDICT: GARBLED finshed, ela wort aun") == ["reader verdict: GARBLED finshed, ela wort aun"]
    assert check_text(["30 min", "how often the dispatcher checks for finished agent work"], "30 min\nhow often the dispatcher checks for finshed agent agent ela wort aun\nVERDICT: CLEAN") == ["how often the dispatcher checks for finished agent work"], "a wrong CLEAN verdict is still caught by the word check"
    fp = build_prompt("flow", {"title": "T", "boxes": ["Email in", "Agent sorts", "Owner approves", "Reply out"], "human": 2}); assert "box 3 gold" in fp and "(start" not in fp and "3. Owner approves" in fp
    assert "Kevin" not in STYLE and "No person's name" in STYLE and "Operations Director" in STYLE
    assert brand("/nonexistent.png") is False
    old = globals()["KEY_FILE"]; globals()["KEY_FILE"] = "/nonexistent/key"; assert illustrate("steps", spec, "/tmp/x.png")[0] is None and "no Gemini key" in illustrate("steps", spec, "/tmp/x.png")[1]; globals()["KEY_FILE"] = old
    print(json.dumps({"checks": 13, "failed": []}))


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 3 and sys.argv[1] == "draw":
        path, note = illustrate(sys.argv[2], json.load(open(sys.argv[3])), sys.argv[4] if len(sys.argv) > 4 else "illustrated.png"); print(path, note)
    else: selftest()
