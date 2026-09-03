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
    (re.compile(r"\b[Rr]umpren(?:er|eur)\b|\b[Rr]umpener\b|\b[Rr]unprinter\b|\b[Rr]un ?preneur\b|\b[Rr]unpreneurs?\b"), "Runpreneur"),
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


def _banner_filter(line1, line2, day, full_width=False, y=BANNER_Y):
    """Orange two-line banner with the dark DAY pill, 'Learnings from my Diary' style."""
    x0, w = (0, 1080) if full_width else (60, 960)
    tx = x0 + 50
    fs = 54 if max(len(line1), len(line2)) <= 15 else 46
    pill_w = 380; pill_x = x0 + w - pill_w - 60
    return ",".join([
        "drawbox=x=%d:y=%d:w=%d:h=190:color=%s@1:t=fill" % (x0, y, w, ORANGE_HEX),
        "drawtext=fontfile='%s':text='%s':fontsize=%d:fontcolor=white:x=%d:y=%d" % (FONT_BLACK, line1, fs, tx, y + 25),
        "drawtext=fontfile='%s':text='%s':fontsize=%d:fontcolor=white:x=%d:y=%d" % (FONT_BLACK, line2, fs, tx, y + 95),
        "drawbox=x=%d:y=%d:w=%d:h=66:color=%s@1:t=fill" % (pill_x, y + 98, pill_w, PILL_HEX),
        "drawtext=fontfile='%s':text='DAY %s':fontsize=44:fontcolor=white:x=%d:y=%d" % (FONT_BOLD, day, pill_x + 40, y + 110),
    ])


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


def build_lfmd(inp, srt, out, day):
    vf = _banner_filter("LEARNINGS FROM", "MY DIARY", day) + "," + _subs_filter(srt, "9:16")
    return _run(inp, vf, out, "10M")


def build_summary(inp, srt, out, day, title):
    l1, _, l2 = title.partition("|")
    vf = _banner_filter(_esc(l1.strip().upper()), _esc(l2.strip().upper()), day) + "," + _subs_filter(srt, "9:16")
    return _run(inp, vf, out, "10M")


def _esc(s):
    return s.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def selftest():
    assert chunk_words("a b c d e f".split()) == [["a", "b", "c"], ["d", "e", "f"]], "even split"
    assert chunk_words("a b c d e f g h i j k".split()) == [["a", "b", "c", "d"], ["e", "f", "g", "h"], ["i", "j", "k"]]
    assert chunk_words([]) == []
    assert fix_brand("a diary of a Rumprener today") == "a diary of a Runpreneur today"
    assert fix_brand("rumpener and Run preneur") == "Runpreneur and Runpreneur"
    assert fix_brand("a diary of a runprinter") == "a diary of a Runpreneur"
    srt = "1\n00:00:00,000 --> 00:00:04,000\nSo consecutive day two of a rumpener diary\n\n2\n00:00:04,000 --> 00:00:06,000\n[BLANK_AUDIO]\n"
    out = rechunk_srt(srt)
    assert "[BLANK" not in out and "Runpreneur" in out and out.count("-->") == 2, out
    assert "00:00:02,000 --> 00:00:04,000" in out
    assert "MarginV=28" in CAPTION_STYLE["16:9"] and "MarginV=34" in CAPTION_STYLE["9:16"]
    assert "DAY 2225" in _banner_filter("A", "B", "2225")
    print("overlays selftest ok")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("args", nargs="*")
    ap.add_argument("--day", default=""); ap.add_argument("--title", default="")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "captions":
        open(a.args[1], "w").write(rechunk_srt(open(a.args[0]).read())); print("wrote", a.args[1])
    elif a.mode == "full": print(build_full(*a.args[:3]))
    elif a.mode == "lfmd": print(build_lfmd(*a.args[:3], day=a.day))
    elif a.mode == "summary": print(build_summary(*a.args[:3], day=a.day, title=a.title))
    else: raise SystemExit("unknown mode")
