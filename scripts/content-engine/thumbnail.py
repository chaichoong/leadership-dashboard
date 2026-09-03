#!/usr/bin/env python3
"""Content Engine R6: the YouTube thumbnail, drawn exactly like the Content Machine's thumbnail maker.

Layout, palette and geometry are a port of the app's thDraw() (measured from the team's template
1707): orange field with a darker diagonal band on the left, an angular photo panel of Kevin on the
right, a navy slash top-left and a navy wedge bottom-right, two white accent lines, the icon card,
the Runpreneur logo, LINE 1 in large white Impact with a navy outline, LINE 2 in a navy box, and the
red WATCH NOW pill. Icons are the app's own Lucide paths (cm_thumb_assets.py), picked by the app's
keyword rules from LINE 1. Title lines come from Claude with the app's own prompt, LINE1/LINE2.

Usage:
  thumbnail.py make PHOTO.png OUT.png --line1 "KIDS CAN'T FIND" --line2 "WORK TRY THIS" [--icon sad]
  thumbnail.py titles TRANSCRIPT.txt              # prints LINE1 / LINE2 from Claude
  thumbnail.py selftest
"""
import argparse, base64, json, math, os, re, subprocess, sys

import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cm_thumb_assets as A   # noqa: E402

FFMPEG = os.path.expanduser("~/tools/bin/ffmpeg")
CLAUDE = os.path.expanduser("~/.local/bin/claude")
TOKEN_FILE = os.path.expanduser("~/.config/od/claude_oauth_token")
FONT_IMPACT = "/System/Library/Fonts/Supplemental/Impact.ttf"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
TW, TH = 1280, 720
# palette, app's names (BGR for OpenCV)
def bgr(hexs): return (int(hexs[5:7], 16), int(hexs[3:5], 16), int(hexs[1:3], 16))
ORANGE_LIGHT, ORANGE_MAIN, ORANGE_DEEP, NAVY, WHITE, RED = bgr("#F39A4F"), bgr("#EC7B27"), bgr("#D86619"), bgr("#2C4E5E"), (255, 255, 255), bgr("#E32D24")
KEVIN_CONTEXT = """You are helping Kevin Brittain's Runpreneur content operation.
Kevin runs a daily barefoot running streak, currently on Day 1940+.
Mission: run 40,075km and raise £1M for children's charities (GOSH, BBC Children in Need).
He holds two Guinness World Records in running.
UK English. Direct. No fluff. No clichés. No em dashes."""
TITLE_PROMPT = "Transcript:\n%s\n\nGenerate 2 punchy thumbnail title lines from this Runpreneur episode. Format EXACTLY like this, nothing else:\nLINE1: [3-4 words max, UPPERCASE]\nLINE2: [2-3 words, UPPERCASE]"


# ---------- geometry (thDraw) ----------

def slashL(y): return 697 - (697 - 600) * (y / TH)
def slashR(y): return 787 - (787 - 690) * (y / TH)
def photoRightAt(y): return 1268 - (1268 - 1035) * (y / TH)
SLASH_END_Y = TH * 0.32

def photoLeftAt(y):
    if y < SLASH_END_Y: return slashR(y) + 8
    x_break = slashR(SLASH_END_Y) + 8; x_bottom = slashR(TH) + 8
    return x_break - (x_break - x_bottom) * ((y - SLASH_END_Y) / (TH - SLASH_END_Y))


def poly(img, pts, colour):
    cv2.fillPoly(img, [np.array(pts, np.int32)], colour, lineType=cv2.LINE_AA)


def pick_icon(line1):
    """Port of pickIcon(): whole-word match first, then substring for keywords of 5+ letters."""
    tokens = set(re.findall(r"[a-z]+", (line1 or "").lower()))
    if not tokens: return "speech"
    for kw, icon in A.ICON_KEYS:
        if kw in tokens: return icon
    t = (line1 or "").lower()
    for kw, icon in A.ICON_KEYS:
        if len(kw) >= 5 and kw in t: return icon
    return "speech"


# ---------- mini SVG path renderer (M L H V C Q A Z, absolute and relative) ----------

def _arc_points(p0, rx, ry, phi, large, sweep, p1, n=24):
    """SVG elliptical arc -> polyline (endpoint to centre parameterisation)."""
    x1, y1 = p0; x2, y2 = p1
    if rx == 0 or ry == 0: return [p1]
    phi = math.radians(phi); cp, sp = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p = cp * dx + sp * dy; y1p = -sp * dx + cp * dy
    lam = (x1p ** 2) / rx ** 2 + (y1p ** 2) / ry ** 2
    if lam > 1: rx *= math.sqrt(lam); ry *= math.sqrt(lam)
    num = rx ** 2 * ry ** 2 - rx ** 2 * y1p ** 2 - ry ** 2 * x1p ** 2
    den = rx ** 2 * y1p ** 2 + ry ** 2 * x1p ** 2
    coef = (1 if large != sweep else -1) * math.sqrt(max(0.0, num / den)) if den else 0.0
    cxp = coef * rx * y1p / ry; cyp = -coef * ry * x1p / rx
    cx = cp * cxp - sp * cyp + (x1 + x2) / 2; cy = sp * cxp + cp * cyp + (y1 + y2) / 2
    def ang(ux, uy, vx, vy):
        d = ux * vx + uy * vy; l = math.hypot(ux, uy) * math.hypot(vx, vy)
        a = math.acos(max(-1, min(1, d / l))) if l else 0
        return -a if ux * vy - uy * vx < 0 else a
    th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not sweep and dth > 0: dth -= 2 * math.pi
    if sweep and dth < 0: dth += 2 * math.pi
    pts = []
    for i in range(1, n + 1):
        t = th1 + dth * i / n
        x = cp * rx * math.cos(t) - sp * ry * math.sin(t) + cx; y = sp * rx * math.cos(t) + cp * ry * math.sin(t) + cy
        pts.append((x, y))
    return pts


def svg_path_polylines(d):
    """Flatten an SVG path into a list of polylines (lists of (x, y))."""
    toks = re.findall(r"[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e-?\d+)?", d)
    out = []; cur = []; pos = (0.0, 0.0); start = (0.0, 0.0); i = 0; cmd = None; last_c2 = None
    class _PathEnd(Exception):
        """The path ran out of numbers mid-command (the catalogue's "rainbow" ends "a0 0 0 0 0-0",
        six numbers where an arc needs seven). Browsers draw what they parsed and stop; so do we."""
    def num():
        nonlocal i
        if i >= len(toks): raise _PathEnd()
        v = float(toks[i]); i += 1; return v
    while i < len(toks):
      try:
        if re.match(r"[A-Za-z]", toks[i]): cmd = toks[i]; i += 1
        rel = cmd.islower(); c = cmd.upper()
        if c not in ("C", "S"): last_c2 = None
        if c == "M":
            x, y = num(), num()
            if rel: x += pos[0]; y += pos[1]
            if cur: out.append(cur)
            cur = [(x, y)]; pos = start = (x, y); cmd = "l" if rel else "L"
        elif c == "L":
            x, y = num(), num()
            if rel: x += pos[0]; y += pos[1]
            cur.append((x, y)); pos = (x, y)
        elif c == "H":
            x = num(); x = x + pos[0] if rel else x; cur.append((x, pos[1])); pos = (x, pos[1])
        elif c == "V":
            y = num(); y = y + pos[1] if rel else y; cur.append((pos[0], y)); pos = (pos[0], y)
        elif c in ("C", "S"):
            if c == "C":
                x1, y1, x2, y2, x, y = [num() for _ in range(6)]
                if rel: x1 += pos[0]; y1 += pos[1]; x2 += pos[0]; y2 += pos[1]; x += pos[0]; y += pos[1]
            else:   # smooth: first control point mirrors the previous curve's second one
                x2, y2, x, y = [num() for _ in range(4)]
                if rel: x2 += pos[0]; y2 += pos[1]; x += pos[0]; y += pos[1]
                x1, y1 = (2 * pos[0] - last_c2[0], 2 * pos[1] - last_c2[1]) if last_c2 else pos
            p0 = pos
            for k in range(1, 17):
                t = k / 16; u = 1 - t
                cur.append((u**3*p0[0] + 3*u*u*t*x1 + 3*u*t*t*x2 + t**3*x, u**3*p0[1] + 3*u*u*t*y1 + 3*u*t*t*y2 + t**3*y))
            pos = (x, y); last_c2 = (x2, y2); continue
        elif c == "Q":
            x1, y1, x, y = [num() for _ in range(4)]
            if rel: x1 += pos[0]; y1 += pos[1]; x += pos[0]; y += pos[1]
            p0 = pos
            for k in range(1, 13):
                t = k / 12; u = 1 - t
                cur.append((u*u*p0[0] + 2*u*t*x1 + t*t*x, u*u*p0[1] + 2*u*t*y1 + t*t*y))
            pos = (x, y)
        elif c == "A":
            rx, ry, phi = num(), num(), num()
            # the two flags may be written compactly ("01", "10", even "011.5"): read them digit by digit
            flags = []
            while len(flags) < 2:
                tok = toks[i]
                if tok[0] in "01" and len(tok) > 1 and tok[1] != ".":
                    flags.append(int(tok[0])); toks[i] = tok[1:]
                else:
                    flags.append(int(float(tok))); i += 1
            large, sweep = flags; x, y = num(), num()
            if rel: x += pos[0]; y += pos[1]
            cur.extend(_arc_points(pos, rx, ry, phi, int(large), int(sweep), (x, y))); pos = (x, y)
        elif c == "Z":
            if cur: cur.append(start); out.append(cur); cur = []
            pos = start
        else:
            i += 1
      except (_PathEnd, IndexError):
        break
    if cur: out.append(cur)
    return out


def draw_icon(img, key, x, y, s):
    """White rounded card with navy outline and the navy stroked icon, as drawIcon()."""
    r = int(s * 0.12)
    card = np.zeros_like(img)
    cv2.rectangle(card, (x + r, y), (x + s - r, y + s), WHITE, -1); cv2.rectangle(card, (x, y + r), (x + s, y + s - r), WHITE, -1)
    for cx, cy in ((x + r, y + r), (x + s - r, y + r), (x + r, y + s - r), (x + s - r, y + s - r)):
        cv2.circle(card, (cx, cy), r, WHITE, -1, cv2.LINE_AA)
    mask = card.any(axis=2)
    img[mask] = WHITE
    # navy outline of the card
    outline = cv2.Canny((mask * 255).astype(np.uint8), 50, 150)
    ys, xs = np.nonzero(outline)
    for px, py in zip(xs, ys): cv2.circle(img, (px, py), max(1, int(s * 0.025)), NAVY, -1)
    pad = s * 0.18; isz = s - pad * 2; scale = isz / 24.0
    lw = max(2, int(round(s * 0.06)))
    for pl in svg_path_polylines(A.ICONS.get(key, A.ICONS["speech"])):
        pts = np.array([(x + pad + px * scale, y + pad + py * scale) for px, py in pl], np.float32)
        if len(pts) >= 2:
            cv2.polylines(img, [np.round(pts).astype(np.int32)], False, NAVY, lw, cv2.LINE_AA)
    return img


def draw_cta(img, x, y, label="WATCH NOW"):
    W, H = 240, 56; R = H // 2
    cv2.rectangle(img, (x + R, y), (x + W - R, y + H), RED, -1); cv2.circle(img, (x + R, y + R), R, RED, -1, cv2.LINE_AA); cv2.circle(img, (x + W - R, y + R), R, RED, -1, cv2.LINE_AA)
    ccx, ccy, cr = x + R + 2, y + H // 2, R - 8
    cv2.circle(img, (ccx, ccy), cr, WHITE, -1, cv2.LINE_AA)
    poly(img, [(ccx - 4, ccy - 8), (ccx + 8, ccy), (ccx - 4, ccy + 8)], RED)
    return (x + R * 2 + 10, y + H // 2)   # label anchor, drawn by ffmpeg


def text_width(text, fontsize, fontfile=None):
    """Measure rendered text in pixels by drawing it on a black strip and reading the ink extent.
    No PIL on this Mac, and guessing an em-width put a 15-character title at half the size the team's use."""
    fontfile = fontfile or FONT_IMPACT
    strip = "/tmp/od-thumb-measure-%d.png" % os.getpid()
    with open(strip + ".txt", "w") as fh: fh.write(text)
    r = subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "color=black:s=2400x%d" % (fontsize * 2),
                        "-vf", "drawtext=fontfile='%s':textfile='%s':fontsize=%d:fontcolor=white:x=10:y=%d" % (fontfile, strip + ".txt", fontsize, fontsize // 2),
                        "-frames:v", "1", strip], capture_output=True, text=True)
    os.remove(strip + ".txt")
    if r.returncode != 0: raise SystemExit("ffmpeg measure failed: " + r.stderr[-300:])
    ink = cv2.imread(strip, cv2.IMREAD_GRAYSCALE); os.remove(strip)
    cols = np.where(ink.max(axis=0) > 40)[0]
    return int(cols[-1] - cols[0] + 1) if len(cols) else 0


def compose(photo_path, out_png, line1, line2, icon=None, day=None):
    img = np.zeros((TH, TW, 3), np.uint8)
    img[:] = ORANGE_LIGHT; img[:, 85:] = ORANGE_MAIN
    poly(img, [(slashL(0) - 130, 0), (slashL(0) - 60, 0), (slashL(TH) - 60, TH), (slashL(TH) - 130, TH)], ORANGE_DEEP)
    # photo panel, clipped to the angular shape
    photo = cv2.imread(photo_path)
    if photo is None: raise SystemExit("cannot read photo " + photo_path)
    left, right = min(photoLeftAt(0), photoLeftAt(TH)), max(photoRightAt(0), photoRightAt(TH))
    pw = right - left; ph = TH                       # cover the panel's bounding box: no bare edges on a slanted cut
    sc = max(pw / photo.shape[1], ph / photo.shape[0])
    iw, ih = int(photo.shape[1] * sc), int(photo.shape[0] * sc)
    resized = cv2.resize(photo, (iw, ih), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((TH, TW, 3), np.uint8)
    dx = int((left + right) / 2 - iw / 2); dy = int(-(ih - TH) * 0.25)      # bias the crop upward: the 9:16 master keeps Kevin's head in its top third
    x0, y0 = max(dx, 0), max(dy, 0); x1, y1 = min(dx + iw, TW), min(dy + ih, TH)
    canvas[y0:y1, x0:x1] = resized[y0 - dy:y1 - dy, x0 - dx:x1 - dx]
    clip = np.zeros((TH, TW), np.uint8)
    cv2.fillPoly(clip, [np.array([(photoLeftAt(0), 0), (photoRightAt(0), 0), (photoRightAt(TH * 0.74), TH * 0.74), (987, TH * 0.74), (925, TH), (photoLeftAt(TH), TH)], np.int32)], 255)
    img[clip > 0] = canvas[clip > 0]
    poly(img, [(slashL(0), 0), (slashR(0), 0), (slashR(SLASH_END_Y), SLASH_END_Y), (slashL(SLASH_END_Y), SLASH_END_Y)], NAVY)
    poly(img, [(photoRightAt(0), 0), (TW, 0), (TW, TH), (photoRightAt(TH), TH)], ORANGE_MAIN)
    poly(img, [(987, TH * 0.74), (1090, TH * 0.74), (1041, TH), (925, TH)], NAVY)
    # white accent lines
    y_a, y_b = TH * 0.10, TH * 0.55
    cv2.line(img, (int(slashL(y_a) - 40), int(y_a)), (int(slashL(y_b) - 40), int(y_b)), (255, 255, 255), 3, cv2.LINE_AA)
    wedge_slope = (925 - 987) / (TH - TH * 0.74)
    wx = lambda y: 987 + wedge_slope * (y - TH * 0.74)
    cv2.line(img, (int(wx(TH * 0.74 - 10) + 8), int(TH * 0.74 - 10)), (int(wx(TH * 0.30) + 8), int(TH * 0.30)), (255, 255, 255), 3, cv2.LINE_AA)
    draw_icon(img, icon or pick_icon(line1), 127, 55, 245)          # where the team's thumbnails put it
    # logo
    logo = cv2.imdecode(np.frombuffer(base64.b64decode(A.LOGO_PNG_B64), np.uint8), cv2.IMREAD_UNCHANGED)
    lh = 38; lw = int(logo.shape[1] * lh / logo.shape[0]); logo = cv2.resize(logo, (lw, lh), interpolation=cv2.INTER_AREA)
    lx, ly = TW - lw - 35, 50
    alpha = (logo[:, :, 3:4] / 255.0) if logo.shape[2] == 4 else np.ones((lh, lw, 1))
    img[ly:ly + lh, lx:lx + lw] = (logo[:, :, :3] * alpha + img[ly:ly + lh, lx:lx + lw] * (1 - alpha)).astype(np.uint8)
    cta_anchor = draw_cta(img, 65, TH - 115)
    base = out_png + ".base.png"
    cv2.imwrite(base, img)
    # text via ffmpeg (freetype): LINE 1 white with navy outline, LINE 2 in a navy box, CTA label
    fsz = 100
    max_w = slashL(TH * 0.55) - 80 - 40                       # from x=80 to 40 px short of the navy slash
    while fsz > 50 and text_width(line1, fsz) > max_w: fsz -= 4
    l2sz = int(round(fsz * 0.55)); pad_x = int(round(l2sz * 0.55)); pad_y = int(round(l2sz * 0.32))
    # each line goes through a text file: an apostrophe inside text='...' ends the quote and the title vanishes
    tfiles = []
    def textfile(t):
        path = "%s.t%d.txt" % (out_png, len(tfiles))
        with open(path, "w") as fh: fh.write(t)
        tfiles.append(path); return path
    filters = [
        "drawtext=fontfile='%s':textfile='%s':fontsize=%d:fontcolor=white:borderw=%d:bordercolor=0x2C4E5E:x=80:y=%d" % (FONT_IMPACT, textfile(line1), fsz, max(11, int(fsz * 0.11)) // 2, 425 - int(fsz * 0.8)),
    ]
    if line2:
        filters.append("drawtext=fontfile='%s':textfile='%s':fontsize=%d:fontcolor=white:box=1:boxcolor=0x2C4E5E:boxborderw=%d:x=%d:y=%d" % (FONT_IMPACT, textfile(line2), l2sz, pad_y, 65 + pad_x, 425 + int(fsz * 0.10) + pad_y))
    filters.append("drawtext=fontfile='%s':textfile='%s':fontsize=19:fontcolor=white:x=%d:y=%d" % (FONT_BOLD, textfile("WATCH NOW"), cta_anchor[0], cta_anchor[1] - 9))
    r = subprocess.run([FFMPEG, "-v", "error", "-y", "-i", base, "-vf", ",".join(filters), "-frames:v", "1", out_png], capture_output=True, text=True)
    for f in tfiles + [base]: os.remove(f)
    if r.returncode != 0: raise SystemExit("ffmpeg text failed: " + r.stderr[-300:])
    return out_png


def titles_from_transcript(transcript):
    import watch   # the lessons reader lives with the ledger; imported here so `make` needs no Airtable module
    lessons = watch.kevin_lessons()
    system = KEVIN_CONTEXT + ("\n\n" + lessons if lessons else "")
    env = dict(os.environ)
    if os.path.exists(TOKEN_FILE): env["CLAUDE_CODE_OAUTH_TOKEN"] = open(TOKEN_FILE).read().strip()
    r = subprocess.run([CLAUDE, "-p", TITLE_PROMPT % transcript[:2000], "--system-prompt", system, "--model", "sonnet",
                        "--output-format", "json", "--tools", "", "--max-turns", "1"], capture_output=True, text=True, env=env, timeout=300)
    if r.returncode != 0: raise SystemExit("claude failed: " + r.stderr[-300:])
    out = json.loads(r.stdout).get("result", "")
    l1 = re.search(r"LINE1:\s*(.+)", out, re.I); l2 = re.search(r"LINE2:\s*(.+)", out, re.I)
    return (l1.group(1).strip().upper() if l1 else ""), (l2.group(1).strip().upper() if l2 else "")


def selftest():
    assert pick_icon("KIDS CAN'T FIND") in A.ICONS and pick_icon("") == "speech"
    assert pick_icon("COMMUNICATION MATTERS") == "speech"
    pls = svg_path_polylines("M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z")
    assert len(pls) == 1 and len(pls[0]) > 20 and abs(pls[0][-1][0] - 21) < 1e-6, (len(pls), pls[0][-1])
    pls2 = svg_path_polylines("M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v3 M8 22h8")
    assert len(pls2) == 4, len(pls2)
    for name, d in list(A.ICONS.items())[:290]:
        assert svg_path_polylines(d), name        # every catalogue icon parses
    assert abs(slashL(0) - 697) < 1e-9 and abs(photoRightAt(TH) - 1035) < 1e-9
    img = np.zeros((TH, TW, 3), np.uint8); draw_icon(img, "speech", 250, 175, 240)
    assert img[175 + 120, 250 + 120].tolist() == list(WHITE) or img[175 + 30, 250 + 30].tolist() == list(WHITE)
    assert len(base64.b64decode(A.LOGO_PNG_B64)) > 5000
    assert text_width("KIDS CAN'T FIND", 100) > text_width("KIDS CAN'T FIND", 60) > text_width("KIDS", 60) > 0
    # a real composition on a synthetic 9:16 photo: title ink where the team's layout puts it, apostrophe intact
    photo = np.full((1920, 1080, 3), (40, 120, 200), np.uint8); cv2.rectangle(photo, (400, 500), (680, 1400), (0, 0, 255), -1)
    pp = "/tmp/od-thumb-selftest-%d.png" % os.getpid(); cv2.imwrite(pp, photo)
    out = compose(pp, pp.replace(".png", "-out.png"), "KIDS CAN'T FIND", "WORK TRY THIS"); os.remove(pp)
    got = cv2.imread(out); os.remove(out)
    assert got.shape == (TH, TW, 3), got.shape
    title_band = got[340:425, 80:640]; assert (title_band.min(axis=2) > 240).sum() > 2000, "LINE 1 missing (white ink)"
    box_band = got[440:500, 70:400]; assert ((box_band == np.array(NAVY, np.uint8)).all(axis=2)).sum() > 3000, "LINE 2 navy box missing"
    assert (got[100:600, 800:1000, 2] > 200).sum() > 5000, "photo not placed in the panel"
    print(json.dumps({"checks": 13, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("a", nargs="?"); ap.add_argument("b", nargs="?")
    ap.add_argument("--line1", default=""); ap.add_argument("--line2", default=""); ap.add_argument("--icon", default=None)
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "make": print(compose(a.a, a.b, a.line1.upper(), a.line2.upper(), a.icon))
    elif a.mode == "titles": print(titles_from_transcript(open(a.a).read()))
    else: raise SystemExit("usage: thumbnail.py make PHOTO OUT --line1 .. --line2 .. | titles TXT | selftest")
