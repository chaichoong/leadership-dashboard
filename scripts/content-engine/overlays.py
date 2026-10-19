#!/usr/bin/env python3
"""Content Engine overlays: captions and title banners for the three Runpreneur formats.

Kevin's rules (2 Sep 2026): titles sit centred in the band between the top edge and his head,
captions (<= 5 words, orange box) sit centred in the band between his feet and the bottom edge,
on ALL formats (full 16:9, LFMD 9:16, Summary 9:16). Nothing over the face or body.

Usage:
  overlays.py captions IN.srt OUT.srt              # re-chunk whisper SRT, apply brand dictionary
  overlays.py full   IN.mp4 CAPTIONS.srt OUT.mp4   # 1920x1080 + captions
  overlays.py lfmd   IN.mp4 CAPTIONS.srt OUT.mp4 --day 2225
  overlays.py summary IN.mp4 CAPTIONS.srt OUT.mp4 --day 2225 --title "TURN A VIDEO INTO|AN AI AGENT"
  overlays.py selftest
"""
import argparse, math, os, re, subprocess, sys

FFMPEG = os.path.expanduser("~/tools/bin/ffmpeg")
FONT_DIR = "/System/Library/Fonts/Supplemental"
FONT_BLACK = os.path.join(FONT_DIR, "Arial Black.ttf")
FONT_BOLD = os.path.join(FONT_DIR, "Arial Bold.ttf")
ORANGE_HEX = "0xFF7A1A"          # drawbox
ORANGE_ASS = "&H001A7AFF"        # libass is BGR
PILL_HEX = "0x2F4858"
MAX_WORDS = 5

# whisper.cpp base.en mis-hears the brand; fix at caption time (never in the transcript file)
BRAND_FIXES = [
    (re.compile(r"\b[Rr]umpren(?:er|eur)\b|\b[Rr]umpener\b|\b[Rr]unprinter\b|\b[Rr]on ?[Pp]renner\b|\b[Rr]on ?preneur\b|\b[Rr]un ?preneur\b|\b[Rr]unpreneurs?\b"), "Runpreneur"),
]

# libass measures in a 288-line space whatever the video height
CAPTION_STYLE = {
    "16:9": "FontName=Arial,Bold=1,FontSize=13,PrimaryColour=&H00FFFFFF,BorderStyle=4,BackColour=%s,OutlineColour=%s,Outline=4,Shadow=0,MarginV=28,Alignment=2" % (ORANGE_ASS, ORANGE_ASS),
    "9:16": "FontName=Arial,Bold=1,FontSize=9,PrimaryColour=&H00FFFFFF,BorderStyle=4,BackColour=%s,OutlineColour=%s,Outline=3,Shadow=0,MarginV=34,Alignment=2" % (ORANGE_ASS, ORANGE_ASS),
}
BANNER_Y = 190   # 9:16: centred between the top edge and Kevin's head (~y 570)


def _ts(s):
    h, m, rest = s.split(":"); sec, ms = rest.split(",")
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000


def _fmt(t):
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return ("%02d:%02d:%06.3f" % (h, m, s)).replace(".", ",")


def fix_brand(text):
    for rx, rep in BRAND_FIXES:
        text = rx.sub(rep, text)
    return text


def chunk_words(words, max_words=MAX_WORDS):
    """Split into groups of at most max_words, as even as possible (no one-word leftovers)."""
    if not words: return []
    groups = max(1, math.ceil(len(words) / max_words))
    k = math.ceil(len(words) / groups)
    return [words[i:i + k] for i in range(0, len(words), k)]


def rechunk_srt(src_text):
    """Whisper SRT -> short caption SRT. Drops bracketed noise like [BLANK_AUDIO]."""
    out = []; n = 1
    for blk in src_text.strip().split("\n\n"):
        lines = blk.strip().split("\n")
        if len(lines) < 3 or " --> " not in lines[1]: continue
        a, b = lines[1].split(" --> "); t0, t1 = _ts(a.strip()), _ts(b.strip())
        text = fix_brand(" ".join(lines[2:]).strip())
        if not text or text.startswith("["): continue
        chunks = chunk_words(text.split())
        dur = (t1 - t0) / len(chunks)
        for i, c in enumerate(chunks):
            out.append("%d\n%s --> %s\n%s\n" % (n, _fmt(t0 + i * dur), _fmt(t0 + (i + 1) * dur), " ".join(c)))
            n += 1
    return "\n".join(out)


def _subs_filter(srt, aspect):
    return "subtitles=%s:fontsdir=%s:force_style='%s'" % (srt, FONT_DIR, CAPTION_STYLE[aspect])


def _textfile(textdir, name, value):
    """Every drawtext string this module draws comes from a FILE, never from an inline text=' '.

    18 Sep 2026: day 2061's title was "YOUR TEAM IS COASTING HERE'S WHY". ffmpeg's filter parser has no
    working escape for an apostrophe inside a quoted option value. `\\'` does not parse and takes the WHOLE
    filterchain down with it (the force_style quotes further along break too, which is why the error points
    at the captions and not at the title); `'\\''` parses and then draws nothing at all, which is worse
    because it fails silently. The render died, the day produced only a teaser, and the publishing queue
    stalled behind it in date order. A file carries the text verbatim, so no title can ever break a render.
    Named off the output file so two clips rendered into one workdir never share a text file."""
    os.makedirs(textdir, exist_ok=True)
    path = os.path.join(textdir, "drawtext_%s.txt" % name)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(value)
    return "textfile='%s'" % path


PILL_ROW_Y, BANNER_H, BANNER_H_SUB, SUB_ROW_Y = 170, 250, 300, 248   # rows: titles (25, 95), DAY pill (170), subtitle (248)

# ---- measured text fitting (finding 20261019-phase-3-985) ----
# Kevin sent 2114 back: "The title card on the learnings for my diary clips doesn't fit." The size came off a
# CHARACTER COUNT (54 at 15 characters or fewer, else 46), which is not a width: "LOYALTY IS BUSINESS'S MOST" is
# 26 characters of wide capitals and runs past the orange box, while 26 narrow ones would not. A count cannot tell
# those apart, so the text is MEASURED in the font it is drawn in and the size steps down until it fits.
TEXT_PAD = 20            # breathing room inside the box, each side
MIN_TITLE_FS = 30        # below this a title is unreadable on a phone; it wraps rather than shrinking further
MIN_SUB_FS = 20


def text_width(text, font_path, size):
    """The drawn width of `text` in pixels, measured in the real font. None when it cannot be measured (no
    Pillow, or the font file is missing) — the caller then keeps the size it has rather than guessing."""
    if not text: return 0.0
    try:
        from PIL import ImageFont
        return float(ImageFont.truetype(font_path, int(size)).getlength(text))
    except Exception:
        return None


def fit_size(text, font_path, size, max_w, floor):
    """The largest size from `size` down to `floor` at which `text` fits `max_w`. Unmeasurable text keeps `size`:
    a card drawn slightly wide is better than a render that stops, and the caller says so."""
    for fs in range(int(size), int(floor) - 1, -2):
        w = text_width(text, font_path, fs)
        if w is None: return int(size)
        if w <= max_w: return fs
    return int(floor)


def wrap_to_width(text, font_path, size, max_w, lines=2):
    """`text` broken on spaces into at most `lines` lines that each fit `max_w`, longest-first greedy. Returns the
    lines; a single word too wide for the box comes back as it is, for fit_size to shrink."""
    words, out, cur = text.split(), [], ""
    for word in words:
        trial = (cur + " " + word).strip()
        w = text_width(trial, font_path, size)
        if w is None: return [text]
        if cur and w > max_w and len(out) < lines - 1:
            out.append(cur); cur = word
        else:
            cur = trial
    if cur: out.append(cur)
    return out[:lines] or [text]



def _banner_filter(line1, line2, day, textdir, full_width=False, y=BANNER_Y, sub=""):
    """Orange two-line banner with the dark DAY pill, 'Learnings from my Diary' style. `sub` adds a
    smaller third line saying what the episode is about (Kevin, 4 Sep 2026)."""
    # Layout (Kevin, 9 Sep 2026: "the day number overlapping the title... no overlaying"): the two title lines,
    # then the DAY pill on its OWN row, then the subtitle. Nothing shares a row, so no width can collide.
    x0, w = (0, 1080) if full_width else (60, 960)
    tx = x0 + 50
    # The text box: from tx to the right edge of the orange box, less the same padding on the right.
    max_w = (x0 + w) - tx - TEXT_PAD
    # The old rule (54 at <= 15 characters, else 46) is kept as the STARTING size, so a title that already fits is
    # drawn exactly as it was and no stored card moves. Measuring only ever steps it down (985).
    fs = 54 if max(len(line1), len(line2)) <= 15 else 46
    fs = min(fit_size(line1, FONT_BLACK, fs, max_w, MIN_TITLE_FS),
             fit_size(line2, FONT_BLACK, fs, max_w, MIN_TITLE_FS))
    pill_w = 300; pill_x = tx; pill_y = y + PILL_ROW_Y
    h = BANNER_H_SUB if sub else BANNER_H
    sub_line = []
    if sub:
        # The subtitle used to be hard-cut at 44 characters and drawn at 30 whatever its width. It is now measured
        # and, when a smaller size would still not fit, wrapped onto the row below (the box grows for it).
        sub_text = sub[:88].upper()
        sub_fs = fit_size(sub_text, FONT_BOLD, 30, max_w, MIN_SUB_FS)
        rows = [sub_text] if (text_width(sub_text, FONT_BOLD, sub_fs) or 0) <= max_w else wrap_to_width(sub_text, FONT_BOLD, sub_fs, max_w)
        for i, row in enumerate(rows):
            sub_line.append("drawtext=fontfile='%s':%s:fontsize=%d:fontcolor=white:x=%d:y=%d"
                            % (FONT_BOLD, _textfile(textdir, "sub%d" % i if i else "sub", row), sub_fs, tx, y + SUB_ROW_Y + i * (sub_fs + 6)))
        if len(rows) > 1: h += (len(rows) - 1) * (sub_fs + 6)
    return ",".join([
        "drawbox=x=%d:y=%d:w=%d:h=%d:color=%s@1:t=fill" % (x0, y, w, h, ORANGE_HEX),
        "drawtext=fontfile='%s':%s:fontsize=%d:fontcolor=white:x=%d:y=%d" % (FONT_BLACK, _textfile(textdir, "line1", line1), fs, tx, y + 25),
        "drawtext=fontfile='%s':%s:fontsize=%d:fontcolor=white:x=%d:y=%d" % (FONT_BLACK, _textfile(textdir, "line2", line2), fs, tx, y + 95),
        "drawbox=x=%d:y=%d:w=%d:h=58:color=%s@1:t=fill" % (pill_x, pill_y, pill_w, PILL_HEX),
        "drawtext=fontfile='%s':%s:fontsize=40:fontcolor=white:x=%d:y=%d" % (FONT_BOLD, _textfile(textdir, "day", "DAY %s" % day), pill_x + 30, pill_y + 9),
    ] + sub_line)


def _run(inp, vf, out, bitrate):
    cmd = [FFMPEG, "-hide_banner", "-v", "error", "-y", "-i", inp, "-vf", vf,
           "-c:v", "h264_videotoolbox", "-b:v", bitrate, "-pix_fmt", "yuv420p", "-c:a", "copy",
           "-movflags", "+faststart", out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    err = "\n".join(l for l in r.stderr.splitlines() if "Fontconfig" not in l)
    if r.returncode != 0:
        raise SystemExit("ffmpeg failed: " + err)
    return out


def build_full(inp, srt, out):
    return _run(inp, _subs_filter(srt, "16:9"), out, "12M")


def build_lfmd(inp, srt, out, day, subtitle="", captions=True):
    """captions=False is the YouTube Short (Kevin, 9 Sep 2026): banner only, our caption file rides alongside
    and YouTube's own captions stay switchable, so viewers never see two sets at once."""
    vf = _banner_filter("LEARNINGS FROM", "MY DIARY", day, _textdir(out), sub=subtitle)
    if captions: vf += "," + _subs_filter(srt, "9:16")
    return _run(inp, vf, out, "10M")


def build_summary(inp, srt, out, day, title):
    l1, _, l2 = title.partition("|")
    vf = _banner_filter(l1.strip().upper(), l2.strip().upper(), day, _textdir(out)) + "," + _subs_filter(srt, "9:16")
    return _run(inp, vf, out, "10M")


def _textdir(out):
    """Where a clip's drawtext text files go: beside the output, i.e. inside the render workdir that
    render.py deletes when the clip is done. Each file is named off the output so the Learnings clip and
    the clean YouTube Short, which share a workdir, never overwrite each other's title."""
    d = os.path.dirname(os.path.abspath(out))
    return os.path.join(d, "drawtext_" + os.path.splitext(os.path.basename(out))[0])


def _selftest_fit(_td):
    """Finding 20261019-phase-3-985: Kevin sent 2114 back because the Learnings title card's wording did not fit.
    The subtitle was hard-cut at 44 characters and drawn at 30 whatever its width, so a real title lost its last
    words mid-word ("...STRESS COPING " for 2080's "RUNNING MAKES BAD DAYS BETTER STRESS COPING MECHANISM", the
    longest in the ledger). The text is now measured in the font it is drawn in and the size steps down until it
    fits. Back-test by putting the 44-character cut back: the first assertion then fails.
    Measuring needs Pillow and the Arial files; where neither is there, text_width returns None, fit_size keeps the
    size it was given, and these checks are skipped rather than passing on nothing."""
    import re as _re
    if text_width("TEST", FONT_BOLD, 30) is None:
        print("overlays selftest: text measuring not available here (no Pillow or no Arial), fit checks SKIPPED")
        return
    longest = "RUNNING MAKES BAD DAYS BETTER STRESS COPING MECHANISM"      # 2080, the longest title in the ledger
    f = _banner_filter("LEARNINGS FROM", "MY DIARY", "2114", _td, sub=longest)
    drawn = open(os.path.join(_td, "drawtext_sub.txt")).read()
    assert drawn == longest.upper(), "the whole wording is drawn, not a 44-character cut: %r" % drawn
    box = 60 + 960 - 110 - TEXT_PAD
    sub_fs = int(_re.search(r"drawtext=[^,]*drawtext_sub\.txt':fontsize=(\d+)", f).group(1))
    assert text_width(drawn, FONT_BOLD, sub_fs) <= box, "and it fits the orange box: %.0f px at %d in a %d px box" % (text_width(drawn, FONT_BOLD, sub_fs), sub_fs, box)
    assert MIN_SUB_FS <= sub_fs <= 30, "never larger than it was, never below the readable floor: %d" % sub_fs
    # a short subtitle is untouched: it still draws at 30, so no stored card moves
    _banner_filter("LEARNINGS FROM", "MY DIARY", "2115", _td, sub="OFF-ROAD RUNNING")
    f2 = _banner_filter("LEARNINGS FROM", "MY DIARY", "2115", _td, sub="OFF-ROAD RUNNING")
    assert int(_re.search(r"drawtext=[^,]*drawtext_sub\.txt':fontsize=(\d+)", f2).group(1)) == 30, "a subtitle that already fits is drawn exactly as before"
    # the title lines are measured too, and the Learnings card's own words still draw at 54
    f3 = _banner_filter("LEARNINGS FROM", "MY DIARY", "2114", _td)
    assert ":fontsize=54:" in f3, "LEARNINGS FROM / MY DIARY measure 546 and 300 px in a 950 px box, so they keep 54"
    # a title far too wide for the box steps down instead of running off it
    wide = "A VERY LONG TITLE LINE THAT CANNOT POSSIBLY FIT THE ORANGE BOX AT ALL"
    f4 = _banner_filter(wide, "SHORT", "2114", _td)
    fs4 = int(_re.search(r"drawtext_line1\.txt':fontsize=(\d+)", f4).group(1))
    assert fs4 < 46 and fs4 >= MIN_TITLE_FS, "a too-wide title shrinks to the floor, never past it: %d" % fs4
    assert wrap_to_width("ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT", FONT_BOLD, 30, 200) == ["ONE TWO", "THREE FOUR FIVE SIX SEVEN EIGHT"], \
        "wrapping fills the first row then puts the rest on the second: %s" % (wrap_to_width("ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT", FONT_BOLD, 30, 200),)


def selftest():
    assert chunk_words("a b c d e f".split()) == [["a", "b", "c"], ["d", "e", "f"]], "even split"
    assert chunk_words("a b c d e f g h i j k".split()) == [["a", "b", "c", "d"], ["e", "f", "g", "h"], ["i", "j", "k"]]
    assert chunk_words([]) == []
    assert fix_brand("a diary of a Rumprener today") == "a diary of a Runpreneur today"
    assert fix_brand("rumpener and Run preneur") == "Runpreneur and Runpreneur"
    assert fix_brand("a diary of a runprinter") == "a diary of a Runpreneur"
    assert fix_brand("the diary of a Ron Prenner") == "the diary of a Runpreneur"
    assert fix_brand("a diary of a ronpreneur,") == "a diary of a Runpreneur,", "1841's caption (10 Sep 2026)"
    srt = "1\n00:00:00,000 --> 00:00:04,000\nSo consecutive day two of a rumpener diary\n\n2\n00:00:04,000 --> 00:00:06,000\n[BLANK_AUDIO]\n"
    out = rechunk_srt(srt)
    assert "[BLANK" not in out and "Runpreneur" in out and out.count("-->") == 2, out
    assert "00:00:02,000 --> 00:00:04,000" in out
    assert "MarginV=28" in CAPTION_STYLE["16:9"] and "MarginV=34" in CAPTION_STYLE["9:16"]
    import tempfile as _tf
    _td = _tf.mkdtemp(prefix="od-overlays-")
    _banner_filter("A", "B", "2225", _td)
    assert open(os.path.join(_td, "drawtext_day.txt")).read() == "DAY 2225"
    # the DAY pill sits below both title lines, never beside line 2 (2054's "STRESS BETTER" ran under it, Kevin 9 Sep 2026)
    import re as _re
    f = _banner_filter("COPE WITH", "STRESS BETTER", "2054", _td, sub="what it is about")
    ys = [int(m) for m in _re.findall(r"drawtext=[^,]*?:y=(\d+)", f)]
    pill_y = int(_re.search(r"drawbox=x=\d+:y=(\d+):w=300", f).group(1))
    assert ys[0] < ys[1] < pill_y < ys[3] and pill_y >= ys[1] + 60, (ys, pill_y)
    import inspect as _i
    src = _i.getsource(build_lfmd); assert "if captions:" in src and "_subs_filter" in src, "the YouTube Short renders without burnt-in captions"
    _selftest_fit(_td)
    _selftest_apostrophe(_td)
    import shutil as _sh; _sh.rmtree(_td, ignore_errors=True)
    print("overlays selftest ok")


def _selftest_apostrophe(td):
    """18 Sep 2026, day 2061: the title "YOUR TEAM IS COASTING HERE'S WHY" broke the render, the day
    produced only a teaser and the publishing queue stalled behind it in date order. No title may ever do
    that again, so this draws a real frame with an apostrophe, a colon and a comma in it and checks the
    pixels: a filter that merely PARSES is not enough, because the '\\'' form parsed and drew a blank.
    Back-tested by putting text='...' back in _banner_filter, which fails this on the ffmpeg exit code."""
    nasty = "HERE'S WHY: IT'S FINE, REALLY"
    vf = _banner_filter(nasty, "MY DIARY", "2061", td, sub=nasty)
    assert "text='" not in vf, "no drawtext string may be inlined; every one comes from a file"
    assert open(os.path.join(td, "drawtext_line1.txt")).read() == nasty, "the file holds the title verbatim"
    out = os.path.join(td, "apostrophe.png")
    r = subprocess.run([FFMPEG, "-hide_banner", "-v", "error", "-y", "-f", "lavfi",
                        "-i", "color=c=black:s=1080x720:d=0.1", "-vf", vf, "-frames:v", "1", out],
                       capture_output=True, text=True)
    assert r.returncode == 0, "ffmpeg refused the filter: " + (r.stderr or "")[:300]
    # the banner is drawn, so the frame cannot still be the black we started from
    assert os.path.getsize(out) > 2000, "the filter parsed but drew nothing (the silent half of the 2061 bug)"


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("args", nargs="*")
    ap.add_argument("--day", default=""); ap.add_argument("--title", default=""); ap.add_argument("--subtitle", default="")
    ap.add_argument("--no-captions", action="store_true", help="banner only (the YouTube Short; our caption file is attached separately)")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "captions":
        open(a.args[1], "w").write(rechunk_srt(open(a.args[0]).read())); print("wrote", a.args[1])
    elif a.mode == "full": print(build_full(*a.args[:3]))
    elif a.mode == "lfmd": print(build_lfmd(*a.args[:3], day=a.day, subtitle=a.subtitle, captions=not a.no_captions))
    elif a.mode == "summary": print(build_summary(*a.args[:3], day=a.day, title=a.title))
    else: raise SystemExit("unknown mode")
