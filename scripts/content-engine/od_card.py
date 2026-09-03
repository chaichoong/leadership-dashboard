"""Content Engine, Operations Director lane: the quote card.

A designed graphic from REAL words (Kevin's verbatim quote, or the post's hook), rendered by code with
ffmpeg drawtext. No AI imagery: playbook rule 2 says AI-generated visuals are illustration, never proof,
and a card that is only typography on the Sage Executive palette can never be mistaken for a screenshot,
a person or a result. Square 1200x1200, which LinkedIn and Facebook both take.

Palette: css/tokens.css (bg-app F1F3EF, surface FBFBF9, text 1C2422, secondary 5A6660, accent 2C6E49, gold C6A15B).
Font: Arial (system, the platform's DM Sans is not installed on this Mac; swap FONT_* when it is).
"""
import os, re, subprocess, tempfile

FFMPEG = os.path.expanduser("~/tools/bin/ffmpeg")
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"
SIZE = 1200
BG, SURFACE, TEXT, SECONDARY, ACCENT, GOLD = "0xF1F3EF", "0xFBFBF9", "0x1C2422", "0x5A6660", "0x2C6E49", "0xC6A15B"


def wrap(text, width=30):
    """Word wrap for drawtext (which cannot wrap). Returns the lines."""
    words = re.sub(r"\s+", " ", text.strip()).split(" ")
    lines, cur = [], ""
    for w in words:
        if len(cur) + len(w) + (1 if cur else 0) > width and cur:
            lines.append(cur); cur = w
        else:
            cur = (cur + " " + w).strip()
    if cur: lines.append(cur)
    return lines


def fit(text, max_lines=7):
    """Pick the font size and wrap width so the quote fits the card: long quotes get smaller type."""
    for size, width in ((64, 26), (56, 30), (48, 35), (42, 40), (36, 46)):
        lines = wrap(text, width)
        if len(lines) <= max_lines: return size, lines
    return 36, wrap(text, 46)[:max_lines]


def _textfile(s):
    fh = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False); fh.write(s); fh.close(); return fh.name


def render(quote, out_png, attribution="Kevin Brittain, Operations Director", kicker="FROM THE RUN DIARY"):
    """Write the PNG. Raises SystemExit with ffmpeg's error if it fails; never leaves a half file."""
    size, lines = fit(quote)
    files = []
    filters = ["drawbox=x=0:y=0:w=%d:h=%d:color=%s:t=fill" % (SIZE, SIZE, BG),
               "drawbox=x=80:y=80:w=%d:h=%d:color=%s:t=fill" % (SIZE - 160, SIZE - 160, SURFACE),
               "drawbox=x=80:y=80:w=14:h=%d:color=%s:t=fill" % (SIZE - 160, ACCENT)]
    block_h = len(lines) * int(size * 1.25)
    y0 = (SIZE - block_h) // 2 - 20
    kf = _textfile(kicker); files.append(kf)
    filters.append("drawtext=fontfile='%s':textfile='%s':fontsize=26:fontcolor=%s:x=150:y=%d" % (FONT_BOLD, kf, ACCENT, max(140, y0 - 90)))
    for i, line in enumerate(lines):
        tf = _textfile(line); files.append(tf)
        filters.append("drawtext=fontfile='%s':textfile='%s':fontsize=%d:fontcolor=%s:x=150:y=%d" % (FONT_BOLD, tf, size, TEXT, y0 + i * int(size * 1.25)))
    af = _textfile(attribution); files.append(af)
    filters.append("drawbox=x=150:y=%d:w=90:h=6:color=%s:t=fill" % (SIZE - 220, GOLD))
    filters.append("drawtext=fontfile='%s':textfile='%s':fontsize=30:fontcolor=%s:x=150:y=%d" % (FONT_REG, af, SECONDARY, SIZE - 190))
    r = subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=%dx%d" % (SIZE, SIZE), "-vf", ",".join(filters),
                        "-frames:v", "1", out_png], capture_output=True, text=True)
    for f in files:
        try: os.remove(f)
        except OSError: pass
    if r.returncode != 0 or not os.path.exists(out_png):
        raise SystemExit("quote card failed: " + (r.stderr or "")[-300:])
    return out_png


def selftest():
    assert wrap("one two three four five six", 9) == ["one two", "three", "four five", "six"]
    s, l = fit("short quote"); assert s == 64 and l == ["short quote"]
    s2, l2 = fit("a " * 300); assert s2 == 36 and len(l2) == 7, (s2, len(l2))
    checks = 3
    if os.path.exists(FFMPEG) and os.path.exists(FONT_BOLD):
        out = os.path.join(tempfile.gettempdir(), "od-card-selftest.png")
        render("you've now got the ability to turn SOPs into AI agents and have a universal SOP agent", out)
        assert os.path.getsize(out) > 5000; os.remove(out); checks += 1
    print('{"checks": %d, "failed": []}' % checks)


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 2 and sys.argv[1] == "render": render(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "card.png"); print("ok")
    else: selftest()
