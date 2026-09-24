#!/usr/bin/env python3
"""Content Engine R2/R3/R5: turn ONE pulled raw clip into the three Runpreneur outputs.

For each clip the watch has pulled (ledger status "pulled"):
  1. transcribe with local whisper.cpp (R3); a clip with no real speech is B-roll: marked and
     skipped, never written up (Kevin's rule: never write copy from an empty transcript)
  2. work out WHICH episode it is: the date-based day (1 Jun 2020 = day 1) checked against the
     day Kevin says in his intro, with the catch-up rule (watch.resolve_episode)
  3. render the 16:9 and 9:16 masters with stab.py (gyro horizon lock, whole body), then
     captions and banners with overlays.py -> Full, LFMD, Summary (R2)
  4. copy the outputs to the edited Drive folder <hundreds>/<episode>/ and write the Drive links,
     the transcript and the status onto the episode record (R5)
  5. delete the local raw copy and mark the ledger "rendered"

Usage:
  render.py run [--limit N] [--keep]        # process pulled clips, oldest first
  render.py one CLIP.insv --day N [--out DIR] # render a clip by hand (no Airtable, no Drive)
  render.py selftest
"""
import argparse, datetime as dt, json, os, re, shutil, subprocess, sys, tempfile, time, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import watch  # noqa: E402
import overlays  # noqa: E402
import thumbnail  # noqa: E402

FFMPEG = os.path.expanduser("~/tools/bin/ffmpeg")
WHISPER = os.path.expanduser("~/tools/whisper.cpp/main")
WHISPER_MODEL = os.path.expanduser("~/tools/whisper.cpp/models/ggml-base.en.bin")
EDITED_ROOT = os.path.expanduser("~/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/Shared drives/Marketing/Runpreneur/Runpreneur Edited Video")
MIN_TRANSCRIPT_CHARS = 50
TEASER_MAX_SECONDS = 150   # Kevin records a short teaser (the Summary) and a long episode (Full + LFMD) each day
RECIPE = {   # docs/content-engine-360.md, Kevin-approved 2 Sep 2026; one angle for the whole clip (3 Sep)
    "16:9": ["--proj", "sg", "--dfov", "250", "--tilt", "11", "--level", "--blend", "0.6", "--size", "1920x1080", "--no-raise-cut"],
    "9:16": ["--proj", "sg", "--dfov", "215", "--tilt", "9", "--level", "--blend", "0.6", "--size", "1080x1920", "--no-raise-cut"],
}
STATUS_DONE = "Optimisation and Design Done"
# The 8 second branded intro Ericamae inserted by hand (SOP: "Intro + Subtitle"). Same rule as her app:
# after Kevin's sign-off line, else before "welcome back", else at the very start.
INTRO_CLIP = os.path.join(EDITED_ROOT, "Vlog Intro", "runprenuer-intro_clip.mp4")
INTRO_LOCAL = os.path.join(os.path.dirname(watch.LEDGER), "intro_clip.mp4")   # one API copy; the mount lied twice (10 Sep 2026). PR #399 deleted this line and left four uses: every long render died with NameError on 13-14 Sep 2026
INTRO_SIGNOFF_RE = re.compile(r"keep on (?:watching|listening)|hope you find (?:it|this) useful|stay with me|let'?s go\b", re.I)
WELCOME_RES = [re.compile(r"welcome back to (?:consecutive )?day", re.I), re.compile(r"consecutive day", re.I)]   # in the app's order
INTRO_SEARCH_FRACTION = 0.35    # the sign-off lives in the cold open; a "let's go" at 80% is not it
INTRO_TRIM_START = 1.0          # Kevin, 4 Sep 2026: the jingle's first second (black, then an indoor shot in a dark top) is cut
CUT_THRESHOLDS_DB = (-35, -30, -25, -20)   # studio-quiet first; a windy road needs -20 before the pause shows
CUT_PAUSE_MIN = 0.5             # a pause between sentences, not a gap between words
CUT_LEAD = 0.15                 # seconds of the pause kept after the last word before the jingle
QUIET_PAD = 0.35                # how far either side of the sign-off/welcome boundary the gap is looked for
QUIET_RISE_DB = 6.0             # the gap runs while the level stays within this of its quietest frame


def flat_captions(segments):
    """The caption chunks as one string, with a mapper from character position back to clip time. Whisper's
    five-word chunks split the sign-off in half ("keep on listening, hope" / "you find it useful."), so the
    phrases are matched across the join and the time interpolated inside the chunk that carries the match."""
    text = ""; spans = []
    for a, b, t in segments:
        t = (t or "").strip()
        if not t: continue
        if text: text += " "
        spans.append((len(text), len(text) + len(t), a, b))
        text += t
    def when(pos):
        if not spans: return 0.0
        for c0, c1, a, b in spans:
            if pos <= c1:
                if pos <= c0: return a
                return a + (b - a) * ((pos - c0) / float(max(c1 - c0, 1)))
        return spans[-1][3]
    return text, when


def intro_window(segments, duration=None):
    """(start, end) of the gap Kevin leaves between his cold-open sign-off and "welcome back to day N".
    The sign-off taken is the LAST one before the welcome: on 2057 he says "keep on listening" and then
    "hope you find it useful", and the jingle belongs after the second (Kevin, 10 Sep 2026)."""
    if not segments: return None
    limit = (duration or segments[-1][1]) * INTRO_SEARCH_FRACTION
    segs = [s for s in segments if s[0] <= limit] or segments[:1]
    text, when = flat_captions(segs)
    if not text: return None
    we_pos = None
    for rx in WELCOME_RES:
        m = rx.search(text)
        if m: we_pos = m.start(); break
    so_pos = None
    for m in INTRO_SIGNOFF_RE.finditer(text):
        if we_pos is not None and m.end() > we_pos: break
        so_pos = m.end()
    if so_pos is None and we_pos is None: return None
    so = when(so_pos) if so_pos is not None else max(0.0, when(we_pos) - 1.0)
    we = when(we_pos) if we_pos is not None else so + 1.0
    if we <= so: we = so + 1.0
    return (round(so, 2), round(we, 2))


def loudness(video, start, length, frame=0.05):
    """[(t, dB)] for the audio in [start, start+length], one reading per `frame` seconds."""
    r = subprocess.run([FFMPEG, "-v", "error", "-ss", "%.3f" % start, "-t", "%.3f" % length, "-i", video, "-map", "0:a:0",
                        "-af", "astats=metadata=1:reset=1:length=%.3f,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-" % frame,
                        "-f", "null", "-"], capture_output=True, text=True)
    out = []
    for t, v in re.findall(r"pts_time:([\d.]+)[\s\S]{0,150}?RMS_level=(-?[\d.]+|-inf)", r.stdout):
        out.append((start + float(t), -120.0 if v == "-inf" else float(v)))
    return out


def quiet_point(video, w0, w1, pad=QUIET_PAD):
    """The quietest moment between the sign-off and the welcome, as (cut, resume). Road noise, wind and
    breathing mean the gap is rarely silent, so the quietest FRAME is found and then widened while the
    level stays within QUIET_RISE_DB of it: that pair of times is the gap Kevin leaves."""
    a0 = max(0.0, w0 - pad); length = max(0.3, (w1 + pad) - a0)
    rows = loudness(video, a0, length)
    if len(rows) < 4: return None
    lo = min(range(len(rows)), key=lambda i: rows[i][1])
    floor = rows[lo][1] + QUIET_RISE_DB
    i = lo
    while i > 0 and rows[i - 1][1] <= floor: i -= 1
    j = lo
    while j < len(rows) - 1 and rows[j + 1][1] <= floor: j += 1
    g0, g1 = rows[i][0], rows[j][0]
    cut = g0 + min(CUT_LEAD, max(0.0, (g1 - g0) / 2))
    return round(cut, 2), round(max(cut, g1), 2)


def pick_cut(sils, w0, w1):
    """A real silence inside the gap, when there is one: the longest that overlaps [w0, w1]."""
    hits = [(s, e) for s, e in sils if e >= w0 - 0.4 and s <= w1 + 0.4 and e - s >= CUT_PAUSE_MIN]
    if not hits: return None
    s, e = max(hits, key=lambda se: se[1] - se[0])
    return round(max(s, max(0.0, w0 - 0.4)) + CUT_LEAD, 2), round(max(s + CUT_LEAD, e - 0.2), 2)


def silences(video, start, length, db):
    """ffmpeg silencedetect over [start, start+length] at `db`, as [(abs_start, abs_end)]."""
    r = subprocess.run([FFMPEG, "-v", "info", "-ss", "%.3f" % start, "-t", "%.3f" % length, "-i", video, "-af",
                        "silencedetect=n=%ddB:d=%.2f" % (db, 0.2), "-f", "null", "-"], capture_output=True, text=True)
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", r.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", r.stderr)]
    return [(start + s, start + (ends[i] if i < len(ends) else start + length)) for i, s in enumerate(starts)]


def find_pause(video, segments, duration=None):
    """(cut, resume): where the jingle goes and where speech starts again. The window is the gap between
    Kevin's cold-open sign-off and his "welcome back"; inside it a real silence wins, otherwise the quietest
    quarter-second. (0, 0) when neither phrase is in the opening, so the jingle leads the episode."""
    win = intro_window(segments, duration)
    if not win: return 0.0, 0.0
    w0, w1 = win
    for db in CUT_THRESHOLDS_DB:
        got = pick_cut(silences(video, max(0.0, w0 - 1.0), (w1 - w0) + 2.0, db), w0, w1)
        if got: return got
    got = quiet_point(video, w0, w1)
    if got: return got
    return round(w0, 2), round(w1, 2)


def clip_caption_at(srt_text, at):
    """The caption carrying the sign-off must end where the jingle goes in, not run on past it: with the
    cut tightened the burned caption would otherwise still be on screen after the jingle."""
    if at <= 0.05: return srt_text
    out = []
    for blk in srt_text.strip().split("\n\n"):
        lines = blk.strip().split("\n")
        if len(lines) >= 3 and " --> " in lines[1]:
            a, b = lines[1].split(" --> ")
            sa, sb = watch_ts(a.strip()), watch_ts(b.strip())
            if sa < at < sb: lines[1] = "%s --> %s" % (a.strip(), srt_ts(at))
        out.append("\n".join(lines))
    return "\n\n".join(out) + "\n"


def podcast_filter(at, resume):
    """The podcast has no jingle: the pause between the sign-off and the welcome is simply removed."""
    if resume <= at + 0.05: return None
    return ("[0:a]atrim=0:%.3f,asetpts=PTS-STARTPTS[a];[0:a]atrim=%.3f,asetpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=0:a=1[out]" % (at, resume))


def media_seconds(path):
    try:
        return float(subprocess.run([os.path.expanduser("~/tools/bin/ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                                    capture_output=True, text=True, timeout=60).stdout.strip() or 0)
    except Exception:
        return 0.0


def intro_clip():
    """The jingle from a LOCAL copy fetched once through the Drive API. On 9 and 10 Sep 2026 the mounted copy
    handed ffmpeg an empty stream at night: episodes 2055 and 2056 shipped with no jingle while every step
    reported ok. The mount is only a fallback, and a copy that ffprobe cannot read is thrown away."""
    if os.path.exists(INTRO_LOCAL) and media_seconds(INTRO_LOCAL) > INTRO_TRIM_START + 1: return INTRO_LOCAL
    try:
        import drive_api
        fid = drive_api.folder_id(drive_api.EDITED_PATH + ["Vlog Intro"])
        hits = [f for f in drive_api.list_folder(fid) if f.get("name") == os.path.basename(INTRO_CLIP)]
        if hits:
            tmp = INTRO_LOCAL + ".part"
            if os.path.exists(tmp): os.remove(tmp)
            drive_api.download(hits[0]["id"], tmp, size=int(hits[0].get("size") or 0) or None)
            if media_seconds(tmp) > INTRO_TRIM_START + 1: os.replace(tmp, INTRO_LOCAL); return INTRO_LOCAL
            os.remove(tmp)
    except Exception as ex:
        print("intro: Drive API copy failed (%s); using the mounted clip" % str(ex)[:120], file=sys.stderr)
    if os.path.exists(INTRO_CLIP) and media_seconds(INTRO_CLIP) > INTRO_TRIM_START + 1: return INTRO_CLIP
    raise SystemExit("intro clip unreadable: neither %s nor %s plays" % (INTRO_LOCAL, INTRO_CLIP))


def insert_intro(full_path, at, out_path, intro=None):
    """Splice the intro into the finished (captioned) full episode at `at` seconds. Re-encodes once with the
    hardware encoder; the intro is scaled to the episode's frame and both audio tracks are made alike.
    The output must be longer than the input by the jingle, or the render fails here rather than shipping
    a jingle-less episode that reads ok (2055 and 2056, 10 Sep 2026)."""
    intro = intro or intro_clip()
    if not os.path.exists(intro): raise SystemExit("intro clip missing: " + intro)
    probe = subprocess.run([os.path.expanduser("~/tools/bin/ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate",
                            "-of", "csv=p=0", full_path], capture_output=True, text=True).stdout.strip().split(",")
    w, h, fps = int(probe[0]), int(probe[1]), probe[2]
    au = "aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS"
    iv = "[1:v]trim=start=%.2f,scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,fps=%s,format=yuv420p,setpts=PTS-STARTPTS[iv];[1:a]atrim=start=%.2f,%s[ia]" % (INTRO_TRIM_START, w, h, w, h, fps, INTRO_TRIM_START, au)
    if at <= 0.05:
        fc = iv + ";[0:v]setpts=PTS-STARTPTS[bv];[0:a]%s[ba];[iv][ia][bv][ba]concat=n=2:v=1:a=1[v][a]" % au
    else:
        fc = (iv + ";[0:v]trim=0:%.3f,setpts=PTS-STARTPTS[av];[0:a]atrim=0:%.3f,%s[aa];[0:v]trim=%.3f,setpts=PTS-STARTPTS[bv];[0:a]atrim=%.3f,%s[ba];"
              "[av][aa][iv][ia][bv][ba]concat=n=3:v=1:a=1[v][a]") % (at, at, au, at, at, au)
    r = subprocess.run([FFMPEG, "-v", "error", "-y", "-i", full_path, "-i", intro, "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
                        "-c:v", "h264_videotoolbox", "-b:v", "10M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out_path],
                       capture_output=True, text=True)
    if r.returncode != 0: raise SystemExit("intro insert failed: " + r.stderr[-300:])
    check_intro_length(full_path, out_path, intro)
    return out_path


def check_intro_length(src, out, intro):
    """The proof the jingle is in: out = src + (intro - trim), within a second. Missing frames from a flaky
    input do not fail ffmpeg; they fail here."""
    want = media_seconds(src) + max(0.0, media_seconds(intro) - INTRO_TRIM_START)
    got = media_seconds(out)
    if got < want - 1.0:
        raise SystemExit("intro insert produced %.1f s but %.1f s was expected (%.1f s of jingle missing): %s" % (got, want, want - got, out))


def podcast_audio(captioned_path, out_mp3, at=0.0, resume=0.0):
    """The podcast is the episode's sound WITHOUT the jingle (Kevin, 4 Sep 2026), the pause after the
    sign-off cut out so it runs straight into the episode."""
    fc = podcast_filter(at, resume)
    args = (["-filter_complex", fc, "-map", "[out]"] if fc else ["-vn"])
    r = subprocess.run([FFMPEG, "-v", "error", "-y", "-i", captioned_path] + args + ["-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", out_mp3], capture_output=True, text=True)
    if r.returncode != 0: raise SystemExit("podcast audio failed: " + r.stderr[-300:])
    return out_mp3


# ---------- pure helpers ----------

def hundreds_folder(day):
    """Episode 2225 -> '2201-2300' (the edited folder's existing convention)."""
    lo = ((day - 1) // 100) * 100 + 1
    return "%d-%d" % (lo, lo + 99)


def output_names(day):
    """The _YT pair (Kevin, 9 Sep 2026, after 2054 showed two sets of captions on YouTube): the full episode and the
    Short WITHOUT burnt-in captions, each with its caption file, for the direct YouTube upload. The socials keep the
    burnt-in versions."""
    return {"full": "Episode_%d_Full_Episode.mp4" % day, "lfmd": "Ep%d_LFMD.mp4" % day, "summary": "Ep%d_Summary.mp4" % day, "podcast": "Ep%d_Podcast.mp3" % day,
            "full_yt": "Episode_%d_Full_Episode_YT.mp4" % day, "full_srt": "Episode_%d_Full_Episode_YT.srt" % day,
            "lfmd_yt": "Ep%d_LFMD_YT.mp4" % day, "lfmd_srt": "Ep%d_LFMD_YT.srt" % day}


INTRO_SECONDS_FALLBACK = 7.0    # the jingle clip is 8.0 s (ffprobe, 9 Sep 2026) minus INTRO_TRIM_START


def intro_seconds(intro=None):
    """How much the jingle pushes later captions back, read from the clip; the measured constant when the mount is off."""
    intro = intro or INTRO_CLIP
    try:
        out = subprocess.run([os.path.expanduser("~/tools/bin/ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", intro],
                             capture_output=True, text=True, timeout=60).stdout.strip()
        d = float(out) - INTRO_TRIM_START
        return d if d > 0 else INTRO_SECONDS_FALLBACK
    except Exception:
        return INTRO_SECONDS_FALLBACK


def shift_after(srt_text, at, delta):
    """Caption cues at or after `at` seconds move later by `delta`: the YouTube caption file must line up with the
    episode once the jingle has been spliced in at `at`. Cues before the cut are untouched."""
    out = []
    for blk in srt_text.strip().split("\n\n"):
        lines = blk.split("\n")
        if len(lines) >= 2 and "-->" in lines[1]:
            a, _, b = lines[1].partition("-->")
            sa, sb = _srt_seconds(a.strip()), _srt_seconds(b.strip())
            if at > 0.05 and sa >= at - 0.05: sa, sb = sa + delta, sb + delta
            elif at <= 0.05: sa, sb = sa + delta, sb + delta
            lines[1] = "%s --> %s" % (srt_ts(sa), srt_ts(sb))
        out.append("\n".join(lines))
    return "\n\n".join(out) + "\n"


def _srt_seconds(ts):
    h, m, rest = ts.split(":"); sec, _, ms = rest.partition(",")
    return int(h) * 3600 + int(m) * 60 + int(sec) + (int(ms) if ms else 0) / 1000.0


def title_from_transcript(text):
    """Two short banner lines from the 'today's episode I talk about X' sentence, else a fallback."""
    m = re.search(r"talk(?:ing)?\s+(?:all\s+)?about\s+(.{12,160}?)(?:[.,;]|\s+so\b|\s+and\b|\s+which\b|$)", text, re.I)
    if not m: return "DIARY OF A|RUNPRENEUR"
    words = m.group(1).strip().split()
    words = [w for w in words if w.lower() not in ("how", "you", "can", "your", "the", "a", "an", "to", "of")][:7] or words[:6]
    mid = (len(words) + 1) // 2
    return " ".join(words[:mid]).upper() + "|" + " ".join(words[mid:]).upper()


# Whisper mishears the phrase: "learning through my diary" (2195), "the learnings from my diet" (2054, Kevin 9 Sep 2026:
# "you need to have a little bit of flexibility... pretty much every day I do the learnings from my diary").
# learn*/lesson* + a joining word + my/the + any word starting dia/die/dai (diary, diaries, diet, dairy).
# "Learnings from my diary" as whisper hears it: learnings/lessons/latest/learning ... from/in/for my diary (2056, 10 Sep 2026: "the latest in my diary")
# "diary" is the word the whole Learnings section hangs off, and whisper.cpp base.en keeps mis-hearing it. The
# mis-hearings are only ever accepted in the TIGHT context (learn... + from/for + a/my/the/our + the word), never in
# the loose first alternative, because "dive" and "diet" are ordinary words he uses: this very episode says "when you
# dive deeper into it". Measured 18 Sep 2026 over all 295 stored transcripts: adding "iv" gains exactly 10 matches
# and every one is a real Learnings line ("learnings from my dive", "learning from a diver"). Zero false positives.
LFMD_START_RE = re.compile(r"(?:\w+\s+)?(?:from|for|of|through|in|to)\s+(?:my|the)\s+d(?:ia|ie|ai)\w*\b(?!\s+of\s+(?:a|an|the)\b)"
                           r"|(?:learn\w*|lesson\w*)(?:\s+\w+){0,2}\s+(?:for|of)\s+(?:today|the day)"
                           # 2060 (17 Sep 2026): he said "the learning from my diary today", whisper wrote "the learning from a diet today"
                           # 2062 (18 Sep 2026): "the learning for my diary is there" -> "the learning for my dive is there". The section
                           # was skipped, and because the near-miss guard below did not cover it either, the card reached Kevin with no
                           # Learnings clip and no warning. The same mis-hearing had already cost 1964, 2032, 2033, 2042 and 2043.
                           r"|learn\w*\s+(?:from|for)\s+(?:a|my|the|our)\s+d(?:ia|ie|ai|iv)\w*", re.I)
# A near miss: "learn..." followed within four words by something that sounds like diary. When no section is found but
# this is, the output gate refuses the card (qa.py), so a mis-heard Learnings line can never ship silently.
DIARY_NEAR_MISS_RE = re.compile(r"\blearn\w*\W+(?:\w+\W+){0,4}(?:d(?:ia|ie|ai|iv)\w*|dairy|dire)\b(?!\s+of\s+(?:a|an|the|our)\b)", re.I)
# The \b(?!\s+of a) keeps the show's own name out: "day 2056 of the diary of a Runpreneur" turned 2056's teaser into
# an episode render on 10 Sep 2026 (Kevin's review, 13 Sep 2026).
SIGNOFF_RE = re.compile(r"thank you as always|stay positive|see you (?:again )?tomorrow", re.I)


def srt_segments(srt_text):
    out = []
    for blk in srt_text.strip().split("\n\n"):
        lines = blk.strip().split("\n")
        if len(lines) < 3 or " --> " not in lines[1]: continue
        a, b = lines[1].split(" --> ")
        out.append((watch_ts(a.strip()), watch_ts(b.strip()), " ".join(lines[2:]).strip()))
    return out


def srt_ts(t):
    ms = int(round(t * 1000)); h, rem = divmod(ms, 3600000); m, rem = divmod(rem, 60000); sec, ms = divmod(rem, 1000)
    return "%02d:%02d:%02d,%03d" % (h, m, sec, ms)


def watch_ts(s):
    h, m, rest = s.split(":"); sec, ms = rest.split(",")
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000


def lfmd_window(segments, min_len=20.0, max_len=180.0):
    """(start, end) of the 'Learnings from my diary' section: from the sentence that names it (the
    LAST such mention, since he may trail it earlier) to the sign-off that follows, or None."""
    # Each segment is read together with the next, and the phrase must START in this one: the caption files split
    # speech into five-word chunks, and "the learning from | a diet today" was missed that way (2060, 17 Sep 2026).
    starts = []
    for i, (_, _, t) in enumerate(segments):
        m = LFMD_START_RE.search(t + (" " + segments[i + 1][2] if i + 1 < len(segments) else ""))
        if m and m.start() < len(t): starts.append(i)
    if not starts: return None
    i = starts[-1]
    start = segments[i][0]
    end = segments[-1][1]
    for a, b, t in segments[i + 1:]:
        if SIGNOFF_RE.search(t):
            end = b; break
    if end - start < min_len: end = min(segments[-1][1], start + min_len)
    if end - start > max_len:   # cut on a sentence boundary, never mid-word
        ends = [b for _, b, _ in segments if start + min_len <= b <= start + max_len]
        end = ends[-1] if ends else start + max_len
    return (round(start, 2), round(end, 2))


def clip_role(duration, has_lfmd):
    """'episode' (Full + LFMD) for the long recording, 'teaser' (Summary) for the short one."""
    if duration > TEASER_MAX_SECONDS or has_lfmd: return "episode"
    return "teaser"


def record_updates(day, links, transcript, reason, clip_name, role="episode"):
    fields = {"Notes": "360 lane rendered %s from %s (%s). %s" % (dt.date.today().isoformat(), clip_name, role, reason)}
    if role == "episode":
        fields["Transcription"] = transcript; fields["Record Status"] = STATUS_DONE
    if links.get("full"): fields["Video Edited URL"] = links["full"]; fields["Subtitled Video URL"] = links["full"]
    if links.get("lfmd"): fields["Reframed Video URL"] = links["lfmd"]
    elif role == "episode": fields["Reframed Video URL"] = None      # never leave an older clip's link on the card (2195, 4 Sep 2026)
    if links.get("summary"): fields["Summary Video URL"] = links["summary"]
    if links.get("thumb"): fields["Thumbnail URL"] = links["thumb"]
    return fields


def thumb_lines(text):
    """Two title lines for the thumbnail: Claude on the standard tier with the Content Machine's own prompt;
    if that fails, the banner title split at its bar, so a render never stops for a missing headline."""
    try:
        l1, l2 = thumbnail.titles_from_transcript(text)
        if l1: return l1, l2, "claude"
    except (SystemExit, subprocess.TimeoutExpired, ValueError) as ex:
        print("thumbnail titles: claude failed (%s), using the banner title" % str(ex)[:120], file=sys.stderr)
    parts = title_from_transcript(text).split("|")
    return parts[0].strip(), (parts[1].strip() if len(parts) > 1 else ""), "banner"


def make_thumbnail(master_916, duration, text, day, workdir, lines=None):
    """R6: the YouTube thumbnail in the team's layout, from a frame of the 9:16 master (Kevin whole-body, mid-run).
    `lines` is the headline the banner already used, so Claude writes it once per episode."""
    at = min(12.0, max(0.0, duration / 2))
    frame = os.path.join(workdir, "thumb_frame.png")
    subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", "%.2f" % at, "-i", master_916, "-frames:v", "1", frame], check=True)
    l1, l2, how = lines or thumb_lines(text)
    out = thumbnail.compose(frame, os.path.join(workdir, "Episode_%d_Thumbnail.png" % day), l1, l2)
    return out, (l1, l2, how)


# ---------- steps ----------

def transcribe(clip, workdir):
    wav = os.path.join(workdir, "audio.wav")
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", clip, "-map", "0:a:0", "-ac", "1", "-ar", "16000", wav], check=True)
    base = os.path.join(workdir, "transcript")
    subprocess.run([WHISPER, "-m", WHISPER_MODEL, "-f", wav, "-otxt", "-osrt", "-of", base, "-np"],
                   check=True, capture_output=True)
    text = open(base + ".txt").read().strip()
    text = re.sub(r"\[[A-Z_ ]+\]", "", text).strip()          # [BLANK_AUDIO], [LAUGHTER]
    return overlays.fix_brand(text), base + ".srt"


def master_complete(dest, clip):
    """A master already in the work folder counts if it runs to the clip's length (a crash later in the
    run must not cost the two hours the masters took: 5 Sep 2026)."""
    if not os.path.exists(dest): return False
    pr = os.path.expanduser("~/tools/bin/ffprobe")
    try:
        d1 = float(subprocess.run([pr, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", dest], capture_output=True, text=True).stdout or 0)
        d0 = float(subprocess.run([pr, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clip], capture_output=True, text=True).stdout or 0)
    except ValueError: return False
    return d0 > 0 and abs(d1 - d0) < 2.0


def find_pans_for(clip, srt):
    """Where Kevin points at his surroundings while talking about them (pointing.py). Never stops a render:
    any failure means no pan, said on stderr, and the card says none were planned."""
    try:
        import pointing, stab
        return pointing.find_pans(clip, open(srt).read(), preview=lambda t: stab.preview_frame(clip, t))
    except Exception as ex:
        print("pointing: skipped (%s)" % str(ex)[:120], file=sys.stderr); return []


def render_masters(clip, workdir, only=None, pans=""):
    out = {}
    for aspect, args in RECIPE.items():
        if only and aspect != only: continue
        dest = os.path.join(workdir, "master_%s.mp4" % aspect.replace(":", "x"))
        side = dest + ".pans"
        had = open(side).read() if os.path.exists(side) else ""
        if master_complete(dest, clip) and had == (pans or ""):
            print("render: reusing finished %s master" % aspect); out[aspect] = dest; continue
        extra = ["--pans", pans] if pans else []
        subprocess.run([sys.executable, os.path.join(HERE, "stab.py"), "render", clip, dest, "--map", "z-yx"] + args + extra,
                       check=True, stdout=subprocess.DEVNULL)
        open(side, "w").write(pans or "")
        out[aspect] = dest
    return out


def horizon_for(masters):
    """The stabiliser's settle report for the wide master (or the tall one), from its sidecar."""
    for aspect in ("16:9", "9:16"):
        side = (masters.get(aspect) or "") + ".horizon.json"
        if masters.get(aspect) and os.path.exists(side):
            try: return json.load(open(side))
            except Exception: return None
    return None


def source_fps(clip):
    try:
        r = subprocess.run([os.path.expanduser("~/tools/bin/ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", clip],
                           capture_output=True, text=True, timeout=60).stdout.strip().split("\n")[0]
        a, _, b = r.partition("/"); return round(float(a) / float(b or 1), 3)
    except Exception:
        return None


def trim(src, start, end, dest):
    """Cut [start, end) of a master, re-encoded so the cut is frame-exact."""
    subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", "%.3f" % start, "-to", "%.3f" % end, "-i", src,
                    "-c:v", "h264_videotoolbox", "-b:v", "10M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", dest], check=True)
    return dest


def shift_srt(srt_text, offset, end):
    """Captions for a trimmed piece: keep cues inside [offset, end), re-based to 0."""
    out = []; n = 1
    for a, b, t in srt_segments(srt_text):
        if b <= offset or a >= end: continue
        a2, b2 = max(0.0, a - offset), min(end, b) - offset
        h = lambda x: ("%02d:%02d:%06.3f" % (int(x // 3600), int(x % 3600 // 60), x % 60)).replace(".", ",")
        out.append("%d\n%s --> %s\n%s\n" % (n, h(a2), h(b2), t)); n += 1
    return "\n".join(out)


LAST_CUT = {}


# ---------- one episode recorded in parts (Kevin, 24 Sep 2026) ----------
# 2071: the sound died at 6:48 of an 8:20 recording, so the next morning he recorded part 2: "Sam, if you can stitch this
# together to my previous run, as the sound cut out halfway through", then the learnings again. The engine rendered part 2
# as a second full episode and its outputs replaced part 1's, so the card showed 1:52 of instructions to the editor.
# Kevin's rule: "Anything that relates to the same title relates to the same episode number." A later part is JOINED to
# the part before it; a second long recording that is not a part is never rendered over the first.
# "stitch/splice/merge ... together|onto|previous", or "join/add/attach/put THIS|IT ... together|onto|to my previous"; never
# "join me" or "add to that" in an ordinary opening
STITCH_RE = re.compile(r"\b(?:stitch|splice|merge)\w*\b(?:\W+\w+){0,8}?\W+(?:together|onto|on to|previous|earlier|last one|other (?:one|clip|video|bit))\b"
                       r"|\b(?:join|add|attach|put)\w*\s+(?:this|it|these)\b(?:\W+\w+){0,6}?\W+(?:together|onto|on to|to (?:my|the) (?:previous|last|earlier|other))\b", re.I)
TOKENS_ONLY_RE = re.compile(r"^\s*(?:\[[^\]]*\]\s*)*$")
LOOSE_DIARY_RE = re.compile(r"\b(?:from|for)\s+(?:a|my|the|our)\s+d(?:ia|ie|ai|iv)\w*", re.I)   # part 1's own learnings, as whisper hears it ("loads from a diary")
JOIN_SEARCH_S = 45.0          # the note to the editor comes at the start of the part
PART_KEEP_MIN_BYTES = 900_000_000   # a waiting clip this big (or named "Part N") may be the next part: part 1 keeps its masters for it


def teaser_for_day_before(role, spoken, date_day, ledger):
    """A teaser that names the day before, when that day has none yet, is that day's teaser: 2071's summary was recorded
    the next morning (1 Feb 2026, 09:23) and says "day 2,071"; by date it would have been a second teaser for 2072."""
    return role == "teaser" and spoken is not None and spoken == date_day - 1 and not any(
        v.get("episode") == spoken and v.get("role") == "teaser" and v.get("status") == "rendered" for v in ledger.values())


def part_number(key):
    return watch.part_no(key) or None


def is_continuation(key, text):
    """True when this clip continues an earlier one: named "Part 2" or later, or it opens with a note to the editor."""
    n = part_number(key)
    return bool((n and n >= 2) or STITCH_RE.search((text or "")[:400]))


def speech(segs):
    return [s for s in segs if not TOKENS_ONLY_RE.match(s[2])]


def _at(seg, idx):
    a, b, t = seg
    return a + (b - a) * (idx / max(1, len(t)))


def part_one_end(segs1, next_has_learnings):
    """(seconds, why) where part 1 stops: before its own learnings when the next part re-records them, else where speech stops."""
    sp = speech(segs1)
    if not sp: return None, "no speech"
    if next_has_learnings:
        for i, seg in enumerate(sp):
            if seg[0] < sp[-1][1] * 0.5: continue
            m = LFMD_START_RE.search(seg[2]) or LOOSE_DIARY_RE.search(seg[2])
            if m:
                why = "before its own learnings, which the next part records again"
                t = seg[2]; k = max(t.rfind(". ", 0, m.start()), t.rfind("? ", 0, m.start()), t.rfind("! ", 0, m.start()))
                if k >= 0: return round(_at(seg, k + 2), 2), why
                if i > 0:        # the sentence began in the segment before: "...longer than necessary. So," | "ultimately, loads from a diary"
                    pt = sp[i - 1][2].rstrip(); k = max(pt.rfind(". "), pt.rfind("? "), pt.rfind("! "))
                    if k >= 0 and len(pt) - k < 25: return round(_at(sp[i - 1], k + 2), 2), why
                return round(seg[0], 2), why
    return round(sp[-1][1] + 0.3, 2), "where the speech stops"


def part_two_start(segs2, window2):
    """(seconds, why) where the later part starts: after the note to the editor. None when there is no note."""
    sp = speech(segs2)
    for i, seg in enumerate(sp):
        if seg[0] > JOIN_SEARCH_S: break
        if STITCH_RE.search(seg[2] + (" " + sp[i + 1][2] if i + 1 < len(sp) else "")):
            if window2 and seg[0] <= window2[0] <= seg[1] + 30: return round(window2[0], 2), "at the learnings, after the note to the editor"
            if i + 1 < len(sp): return round(sp[i + 1][0], 2), "after the note to the editor"
            return None, "the part is only the note"
    return 0.0, "no note to the editor; the whole part is used"


def join_srt(segs1, p1_end, segs2, p2_start):
    """One caption track: part 1 up to p1_end, then part 2 from p2_start, re-timed to follow on."""
    out = []
    for a, b, t in segs1:
        if a >= p1_end - 0.2: continue
        if b > p1_end:
            t = t[:int(len(t) * (p1_end - a) / max(0.01, b - a))].rsplit(" ", 1)[0].strip(); b = p1_end
        if t: out.append((a, b, t))
    shift = p1_end - p2_start
    for a, b, t in segs2:
        if b <= p2_start + 0.2: continue
        if a < p2_start:
            t = t[int(len(t) * (p2_start - a) / max(0.01, b - a)):].split(" ", 1)[-1].strip(); a = p2_start
        if t: out.append((a + shift, b + shift, t))
    return "\n".join("%d\n%s --> %s\n%s\n" % (i + 1, srt_ts(a), srt_ts(b), t) for i, (a, b, t) in enumerate(out))


def join_masters(base_dir, part_dir, p1_end, p2_start, workdir):
    """Each aspect's master: part 1 [0, p1_end) then part 2 [p2_start, end), frame-exact (both pieces re-encoded alike)."""
    out = {}
    for aspect in RECIPE:
        name = "master_%s.mp4" % aspect.replace(":", "x")
        src2 = os.path.join(part_dir, name)
        a = trim(os.path.join(base_dir, name), 0.0, p1_end, os.path.join(workdir, "join_a_" + name))
        b = trim(src2, p2_start, media_seconds(src2), os.path.join(workdir, "join_b_" + name))
        lst = os.path.join(workdir, "join_%s.txt" % aspect.replace(":", "x"))
        with open(lst, "w") as fh: fh.write("file '%s'\nfile '%s'\n" % (a.replace("'", "'\\''"), b.replace("'", "'\\''")))
        dest = os.path.join(workdir, "joined_" + name)
        subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", dest], check=True)
        assert_has_video(dest, "joined %s master" % aspect)
        out[aspect] = dest
    return out


def release_kept(ledger, remove=None):
    """Part 1's masters are kept only while a clip of its day still waits; afterwards they go. Returns the released keys."""
    remove = remove or (lambda p: shutil.rmtree(p, ignore_errors=True))
    busy = {v.get("day") for v in ledger.values() if v.get("status") in ("new", "pulled", "pulling", "rendering")
            or (v.get("status") == "failed" and not v.get("requeued"))}      # a failed join gets one retry, and needs part 1's masters for it
    gone = []
    for k, v in ledger.items():
        if v.get("keep_masters") and v.get("day") not in busy:
            remove(v.pop("keep_masters")); gone.append(k)
    return gone


def keep_for_next_part(key, e, ledger):
    """True when a clip of the same day that could be the next part still waits (named Part N, or long-clip sized)."""
    return any(k2 != key and v.get("day") == e.get("day") and v.get("status") in ("new", "pulled", "pulling")
               and ((part_number(k2) or 0) >= 2 or (v.get("size") or 0) >= PART_KEEP_MIN_BYTES) for k2, v in ledger.items())


def srt_cue_count(text):
    """Cues in an SRT body. Zero means ffmpeg's subtitles filter has nothing to burn in and aborts."""
    return len([b for b in re.split(r"\n\s*\n", text.strip()) if "-->" in b])


def check_captions(path, what):
    """A caption file must exist and hold at least one cue BEFORE ffmpeg sees it.

    5 Sep 2026: the nightly run died inside overlays.py 'full' with a filter error and took the
    whole run with it, because captions.srt had been emptied. An empty or unparseable SRT is now
    refused here, naming the clip, instead of surfacing as an ffmpeg traceback.
    """
    if not os.path.exists(path):
        raise RuntimeError("captions file missing for %s: %s" % (what, path))
    n = srt_cue_count(open(path).read())
    if n < 1:
        raise RuntimeError("captions for %s are empty or unparseable (%s): ffmpeg would abort" % (what, path))
    return n


def assert_has_video(path, what):
    """An output with no video stream is not an output (5 Sep 2026: Episode 2196's Learnings clip was audio only,
    cut from a 9:16 master whose picture ended early). Fails the run rather than filing sound as a video."""
    pr = os.path.expanduser("~/tools/bin/ffprobe")
    kinds = subprocess.run([pr, "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path], capture_output=True, text=True).stdout.split()
    if "video" not in kinds: raise RuntimeError("%s has no video stream (%s): refusing to file it" % (what, path))


def overlay(ov, args, what):
    """Run overlays.py and, on failure, raise with its stderr instead of swallowing it."""
    r = subprocess.run([sys.executable, ov] + args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0:
        tail = "\n".join((r.stderr or "").strip().splitlines()[-15:])
        raise RuntimeError("overlays %s failed for %s (exit %d)\n%s" % (args[0], what, r.returncode, tail))


def build_outputs(masters, srt, day, title, workdir, lfmd=None, role="episode"):
    ov = os.path.join(HERE, "overlays.py")
    caps = os.path.join(workdir, "captions.srt")
    overlay(ov, ["captions", srt, caps], "episode %s" % day)
    check_captions(caps, "episode %s" % day)
    names = output_names(day); paths = {}
    if role == "teaser":
        paths["summary"] = os.path.join(workdir, names["summary"])
        overlay(ov, ["summary", masters["9:16"], caps, paths["summary"], "--day", str(day), "--title", title], "episode %s summary" % day)
        return paths
    if role == "lfmd-only":
        # The Learnings clip alone (redo --only lfmd): no intro, no full render, and no 16:9 master to look for the
        # sign-off pause in. 8 Sep 2026, 22:00: this branch sat AFTER the pause search and the 2196 rebuild died on
        # masters["16:9"]. The diary section ends before the sign-off, so the unclipped captions are the right ones.
        assert_has_video(masters["9:16"], "episode %s 9:16 master" % day)
        piece = trim(masters["9:16"], lfmd[0], lfmd[1], os.path.join(workdir, "lfmd_master.mp4")); assert_has_video(piece, "episode %s Learnings cut" % day)
        lcaps = os.path.join(workdir, "captions_lfmd.srt"); open(lcaps, "w").write(shift_srt(open(caps).read(), lfmd[0], lfmd[1]))
        check_captions(lcaps, "episode %s LFMD" % day)
        paths["lfmd"] = os.path.join(workdir, names["lfmd"])
        overlay(ov, ["lfmd", piece, lcaps, paths["lfmd"], "--day", str(day), "--subtitle", title.replace("|", " ").strip()], "episode %s LFMD" % day)
        clean_short(ov, piece, lcaps, paths, names, workdir, day, title)
        assert_has_video(paths["lfmd"], "episode %s lfmd" % day); return paths
    # the five-word caption chunks, not whisper's ten-second segments: the sign-off and the "welcome back"
    # share one segment, so only the chunks can put the cut in Kevin's gap (10 Sep 2026)
    cap_segs = srt_segments(open(caps).read())
    at, resume = find_pause(masters["16:9"], cap_segs, srt_segments(open(srt).read())[-1][1])
    LAST_CUT.update({"at": at, "resume": resume})
    clipped = clip_caption_at(open(caps).read(), at)                                 # READ before the write opens the file (5 Sep 2026: open(w) first truncated it to nothing)
    with open(caps, "w") as fh: fh.write(clipped)
    check_captions(caps, "episode %s full" % day)
    captioned = os.path.join(workdir, "full_captioned.mp4")
    overlay(ov, ["full", masters["16:9"], caps, captioned], "episode %s full" % day)
    paths["full"] = os.path.join(workdir, names["full"])
    insert_intro(captioned, at, paths["full"])
    paths["podcast"] = podcast_audio(captioned, os.path.join(workdir, names["podcast"]), at, resume)
    # YouTube gets the same cut without burnt-in captions, plus the caption file lined up with the jingle
    paths["full_yt"] = insert_intro(masters["16:9"], at, os.path.join(workdir, names["full_yt"]))
    paths["full_srt"] = os.path.join(workdir, names["full_srt"])
    with open(paths["full_srt"], "w") as fh: fh.write(shift_after(clipped, at, intro_seconds()))
    check_captions(paths["full_srt"], "episode %s YouTube captions" % day)
    if lfmd:   # the "Learnings from my diary" section only (Kevin, 3 Sep 2026)
        assert_has_video(masters["9:16"], "episode %s 9:16 master" % day)
        piece = trim(masters["9:16"], lfmd[0], lfmd[1], os.path.join(workdir, "lfmd_master.mp4"))
        assert_has_video(piece, "episode %s Learnings cut" % day)
        lcaps = os.path.join(workdir, "captions_lfmd.srt")
        open(lcaps, "w").write(shift_srt(open(caps).read(), lfmd[0], lfmd[1]))
        check_captions(lcaps, "episode %s LFMD" % day)
        paths["lfmd"] = os.path.join(workdir, names["lfmd"])
        # the subheading says what the episode is about (Kevin, 4 Sep 2026)
        overlay(ov, ["lfmd", piece, lcaps, paths["lfmd"], "--day", str(day), "--subtitle", title.replace("|", " ").strip()], "episode %s LFMD" % day)
        clean_short(ov, piece, lcaps, paths, names, workdir, day, title)
    for kind, p in paths.items():
        if p.endswith(".mp4"): assert_has_video(p, "episode %s %s" % (day, kind))
    return paths


def clean_short(ov, piece, lcaps, paths, names, workdir, day, title):
    """The YouTube Short: banner, no burnt-in captions, caption file beside it."""
    paths["lfmd_yt"] = os.path.join(workdir, names["lfmd_yt"])
    overlay(ov, ["lfmd", piece, lcaps, paths["lfmd_yt"], "--day", str(day), "--subtitle", title.replace("|", " ").strip(), "--no-captions"], "episode %s LFMD (YouTube)" % day)
    paths["lfmd_srt"] = os.path.join(workdir, names["lfmd_srt"]); shutil.copyfile(lcaps, paths["lfmd_srt"])


def publish_via_api(paths, day, transcript_txt):
    """Finished videos straight up to the shared drive through the API (Kevin, 9 Sep 2026): the Mac's Drive cache
    never holds a copy. Returns links by kind, or None when the API is not set up or fails (the mount copy then runs)."""
    try:
        import drive_api
        if not os.path.exists(drive_api.KEY_FILE): return None
        fid = drive_api.folder_id(drive_api.EDITED_PATH + [hundreds_folder(day), str(day)], create=True)
        links = {}
        for kind, p in paths.items():
            mime = "video/mp4" if p.endswith(".mp4") else "audio/mpeg" if p.endswith(".mp3") else "image/png" if p.endswith(".png") else "application/x-subrip" if p.endswith(".srt") else "application/octet-stream"
            links[kind] = drive_api.link(drive_api.upload(p, fid, mime=mime))
        drive_api.upload(transcript_txt, fid, name="Ep%d_transcript.txt" % day, mime="text/plain")
        return links
    except Exception as ex:
        print("publish: Drive API upload failed for episode %d (%s); using the mounted folder" % (day, str(ex)[:120]), file=sys.stderr)
        return None


def publish_to_drive(paths, day, transcript_txt):
    folder = os.path.join(EDITED_ROOT, hundreds_folder(day), str(day))
    links = publish_via_api(paths, day, transcript_txt)
    if links: return folder, links
    os.makedirs(folder, exist_ok=True)
    links = {}
    for kind, p in paths.items():
        dest = os.path.join(folder, os.path.basename(p))
        shutil.copyfile(p, dest)
        links[kind] = dest
    shutil.copyfile(transcript_txt, os.path.join(folder, "Ep%d_transcript.txt" % day))
    # Drive ids appear once the desktop client has synced the file; wait a little, then read them
    for kind, dest in list(links.items()):
        fid = None
        for _ in range(30):
            fid = watch.drive_id(dest)
            if fid: break
            time.sleep(10)
        links[kind] = watch.drive_link(fid) if fid else None
    return folder, links


def find_or_create_record(day, first_drive_id, clip_name, clip_date):
    rid, how = watch.find_record(first_drive_id or "no-id", day)
    if rid: return rid, how
    r = watch._airtable("POST", watch.API, {"fields": watch.record_fields(day, [clip_name], first_drive_id or "", clip_date)})
    return r["id"], "created"


def process(key, ledger, keep=False):
    e = ledger[key]
    clip = e["local"]
    workdir = os.path.join(os.path.dirname(clip), "render_" + key.replace(".insv", ""))
    os.makedirs(workdir, exist_ok=True)
    t0 = time.time()
    text, srt = transcribe(clip, workdir)
    if len(text) < MIN_TRANSCRIPT_CHARS:
        e["status"] = "broll"; e["transcript_chars"] = len(text)
        if not keep: os.remove(clip)
        watch.save_ledger(ledger)
        print("%s: %d chars of speech, B-roll, skipped" % (key, len(text)))
        return
    date_day = e["day"]
    same_day = [v for k2, v in ledger.items() if v["date"] == e["date"] and k2 != key]
    prev = [v for v in ledger.values() if v["date"] == (dt.date.fromisoformat(e["date"]) - dt.timedelta(days=1)).isoformat()]
    prev_has_talk = any(v.get("status") in ("rendered",) for v in prev) or (bool(prev) and not same_day)
    window = lfmd_window(srt_segments(open(srt).read()))
    duration = float(subprocess.run([os.path.expanduser("~/tools/bin/ffprobe"), "-v", "error", "-show_entries", "format=duration",
                                     "-of", "csv=p=0", clip], capture_output=True, text=True).stdout or 0)
    role = clip_role(duration, bool(window))
    spoken = watch.spoken_day(text)
    if teaser_for_day_before(role, spoken, date_day, ledger):
        day, reason = spoken, "teaser for day %d, recorded the next day (it says day %d)" % (spoken, spoken)
    else:
        day, reason = watch.resolve_episode(date_day, spoken, prev_day_has_talk=prev_has_talk)
    e["episode"] = day; e["episode_reason"] = reason; e["status"] = "rendering"; watch.save_ledger(ledger)
    e["lfmd_window"] = window; e["role"] = role; e["duration"] = round(duration, 1); watch.save_ledger(ledger)
    base = None
    if role == "episode":
        earlier = [k2 for k2, v in ledger.items() if k2 != key and v.get("episode") == day and v.get("role") == "episode" and v.get("status") == "rendered"]
        if not earlier and (part_number(key) or 0) >= 2:
            # never render a later part alone: it would become the episode (the 2071 fault itself)
            e["status"] = "failed"; e["error"] = "part %d of episode %d, but no earlier part has rendered to join it to" % (part_number(key), day)
            if not keep: os.remove(clip); shutil.rmtree(workdir, ignore_errors=True)
            watch.save_ledger(ledger); print("%s: NOT rendered: %s" % (key, e["error"]), file=sys.stderr); return
        if earlier:
            b = ledger[earlier[0]]
            kept = b.get("keep_masters") or ""
            if not is_continuation(key, text):
                why = "a second long recording for episode %d (%s is already its episode) and not a part of it: not rendered, so it cannot replace that episode" % (day, earlier[0])
            elif not all(os.path.exists(os.path.join(kept, "master_%s.mp4" % a.replace(":", "x"))) for a in RECIPE) or not os.path.exists(os.path.join(kept, "transcript.srt")):
                why = "part of episode %d, but %s's masters are gone, so it cannot be joined; re-render both parts (set both to new in the ledger)" % (day, earlier[0])
            else:
                why = None; base = earlier[0]
            if why:
                e["status"] = "failed"; e["error"] = why; e["requeued"] = "not requeued: it needs a person"   # the page names it; a retry would do the same
                if not keep: os.remove(clip); shutil.rmtree(workdir, ignore_errors=True)
                watch.save_ledger(ledger); print("%s: NOT rendered: %s" % (key, why), file=sys.stderr); return
    if role == "episode" and base:
        # the later part: its own masters, then part 1 + part 2 joined into the episode's masters and one caption track
        masters2 = render_masters(clip, workdir)
        b = ledger[base]; bdir = b["keep_masters"]
        segs1, segs2 = srt_segments(open(os.path.join(bdir, "transcript.srt")).read()), srt_segments(open(srt).read())
        p2_start, why2 = part_two_start(segs2, window)
        if p2_start is None: raise RuntimeError("%s: %s" % (key, why2))     # run() fails this clip only; a SystemExit would end the night
        p1_end, why1 = part_one_end(segs1, bool(window) and window[0] >= p2_start)
        masters = join_masters(bdir, workdir, p1_end, p2_start, workdir)
        joined = join_srt(segs1, p1_end, segs2, p2_start)
        srt = os.path.join(workdir, "joined.srt"); open(srt, "w").write(joined)
        text = " ".join(t for _, _, t in srt_segments(joined))
        open(os.path.join(workdir, "transcript.txt"), "w").write(text)
        window = lfmd_window(srt_segments(joined)); duration = media_seconds(masters["16:9"])
        e.update({"joined_from": base, "join": {"part1_end": p1_end, "part1_why": why1, "part2_start": p2_start, "part2_why": why2},
                  "lfmd_window": window, "duration": round(duration, 1), "pans": [], "horizon_part1": b.get("horizon")})
        watch.save_ledger(ledger)
        print("join: %s 0-%.1f s (%s) + %s from %.1f s (%s) -> %.0f s" % (base, p1_end, why1, key, p2_start, why2, duration))
    elif role == "episode":
        import pointing
        pans = find_pans_for(clip, srt); e["pans"] = pans; watch.save_ledger(ledger)
        if pans: print("pointing: %d pan(s) planned: %s" % (len(pans), pointing.pans_arg(pans)))
        masters = render_masters(clip, workdir, pans=pointing.pans_arg(pans))
    else:
        masters = {"9:16": render_masters(clip, workdir, only="9:16")["9:16"]}
    title = title_from_transcript(text)
    lines = None
    if role == "episode":
        # one headline for the whole episode: the banner said "TAKING MOST OUT | TEAM FOR" while the thumbnail
        # said "GET YOUR TEAM / ALL IN" (2056, Kevin 10 Sep 2026). Claude writes it once, both use it.
        l1, l2, how = thumb_lines(text)
        lines = (l1, l2, how)
        if how == "claude" and l1: title = (l1 + "|" + l2).upper()
    if role == "teaser":
        title = episode_title_for(day, ledger) or title      # the long clip's title on the teaser banner (Kevin, 10 Sep 2026)
    paths = build_outputs(masters, srt, day, title, workdir, lfmd=window, role=role)
    e["horizon"] = horizon_for(masters) or e.get("horizon_part1"); e["source_fps"] = source_fps(clip)
    if role == "episode":
        e["intro_at"] = LAST_CUT.get("at"); e["podcast_resume"] = LAST_CUT.get("resume")
        paths["thumb"], e["thumb_lines"] = make_thumbnail(masters["9:16"], duration, text, day, workdir, lines=lines)
    folder, links = publish_to_drive(paths, day, os.path.join(workdir, "transcript.txt"))
    rid, how = find_or_create_record(day, e.get("drive_id"), key, dt.date.fromisoformat(e["date"]))
    upd = record_updates(day, links, text, reason, key, role)
    if role == "episode" and card_sent_back(day):
        # the copy was written from the old transcript: cleared, so tonight's copy step writes it from this one (2071, 24 Sep 2026)
        upd.update({f: None for f in FULL_COPY_FIELDS})
    watch._airtable("PATCH", watch.API + "/" + rid, {"fields": upd})
    e.update({"status": "rendered", "record_id": rid, "outputs": links, "edited_folder": folder, "title": title,
              "render_seconds": round(time.time() - t0), "rendered": dt.datetime.now().isoformat(timespec="seconds")})
    if base:
        # the joined episode is the day's episode from now on; part 1 is kept on the ledger as a part (qa, the publisher
        # and the Learnings redo all read the day's "episode" entry)
        b = ledger[base]; b["role"] = "part"; b["joined_into"] = key
        shutil.rmtree(b.pop("keep_masters"), ignore_errors=True)
    if role == "episode" and not base and keep_for_next_part(key, e, ledger):
        e["keep_masters"] = workdir; print("%s: masters kept for the next part of day %s" % (key, e.get("day")))
    elif not keep:
        shutil.rmtree(workdir, ignore_errors=True)
    if not keep: os.remove(clip)
    for k2 in release_kept(ledger): print("%s: kept masters released (no part of its day is waiting)" % k2)
    watch.save_ledger(ledger)
    print("%s -> Episode %d %s (%s) in %d s; record %s (%s); links %s" % (key, day, role, reason, e["render_seconds"], rid, how,
          {k: ("ok" if v else "NO DRIVE ID YET") for k, v in links.items()}))


def redo_lfmd(day):
    """Rebuild one episode's Learnings clip only: re-pull the clip if it is gone, transcribe, render the 9:16
    master (reused when complete), cut the diary section, file it, update the record and refresh the card."""
    ledger = watch.load_ledger()
    keys = [k for k, v in ledger.items() if v.get("episode") == day and v.get("role") == "episode"]
    if not keys: raise SystemExit("no episode clip for day %d in the ledger" % day)
    key = keys[0]; e = ledger[key]
    if e.get("joined_from"):
        raise SystemExit("episode %d is joined from %s and %s: set both back to new in the ledger so the night renders and joins them again" % (day, e["joined_from"], key))
    clip = e.get("local") or ""
    if not clip or not os.path.exists(clip):
        e["status"] = "new"; watch.save_ledger(ledger)
        clip = watch.pull(ledger, key)
        if not clip: raise SystemExit("could not pull %s again" % key)
        e = ledger[key]
    workdir = os.path.join(os.path.dirname(clip), "render_" + key.replace(".insv", ""))
    os.makedirs(workdir, exist_ok=True)
    text, srt = transcribe(clip, workdir)
    window = lfmd_window(srt_segments(open(srt).read()))
    if not window: raise SystemExit("episode %d has no diary section in its transcript" % day)
    masters = render_masters(clip, workdir, only="9:16")
    title = title_from_transcript(text)
    paths = build_outputs(masters, srt, day, title, workdir, lfmd=window, role="lfmd-only")
    # all three: the captioned clip for the socials, the clean clip and its captions for the YouTube Short. Until 17 Sep
    # 2026 only the first was uploaded, so 1841's rebuilt Learnings stayed blocked at "clean Short 0 s".
    folder, links = publish_to_drive({k: paths[k] for k in ("lfmd", "lfmd_yt", "lfmd_srt") if paths.get(k)}, day, os.path.join(workdir, "transcript.txt"))
    rid, how = find_or_create_record(day, e.get("drive_id"), key, dt.date.fromisoformat(e["date"]))
    if links.get("lfmd"): watch._airtable("PATCH", watch.API + "/" + rid, {"fields": {"Reframed Video URL": links["lfmd"]}})
    e["lfmd_window"] = window; e["lfmd_redone"] = dt.datetime.now().isoformat(timespec="seconds"); e["status"] = "rendered"; e["local"] = clip
    e.setdefault("outputs", {}).update({k: v for k, v in links.items() if v})      # the publisher fetches by these links
    watch.save_ledger(ledger)
    print("episode %d: Learnings clip rebuilt -> %s (record %s)" % (day, "ok" if links.get("lfmd") else "NO DRIVE ID YET", rid))
    import approval
    card = approval.load_state().get(str(day)) or {}
    resubmitted = False
    if card.get("verdict") == "approved":
        # Kevin already approved and asked for the clip to be reinstated before publishing: not sent back for a second yes
        print("episode %d: card already approved; not resubmitted" % day)
        resubmitted = True
        # a block the output gate recorded before this rebuild is read again against the new files (1841, 21 Sep 2026)
        print("episode %d: output gate %s" % (day, "passes on the rebuilt files" if approval.recheck_gate(day) else "still BLOCKED on the rebuilt files"))
    elif card.get("verdict") == "changes":
        # 2060 (17 Sep 2026): Kevin sent the card back with "There are no learnings from my diary on this, which need to be
        # added." A sent-back card needs one receipt line per point. When every point is about the missing Learnings
        # clip, the rebuild answers them; anything else is left for a person, never answered with a stock line.
        receipt = lfmd_receipt(card.get("feedback", ""), window)
        if receipt:
            with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fh:
                fh.write(receipt); rpath = fh.name
            try: approval.refresh_card(day, receipt=rpath); resubmitted = True
            finally: os.remove(rpath)
        else:
            print("episode %d: Kevin's feedback asks for more than the Learnings clip; the card is left for a person to resubmit" % day, file=sys.stderr)
            # The clip is built; only the resubmission is left, and the Publishing page shows the card as sent back.
            # Kept listed, 2062 was rebuilt every night from 18 to 20 Sep 2026 while nobody resubmitted it.
            # release_hold, not just the redo line: nothing else would ever lift a hold on this day (review, 21 Sep 2026).
            # Safe, because a sent-back card cannot publish until Kevin approves the resubmitted one.
            if links.get("lfmd") and links.get("lfmd_yt"): release_hold(day)
    else:
        approval.refresh_card(day); resubmitted = True
    if links.get("lfmd") and links.get("lfmd_yt") and resubmitted: release_hold(day)
    return paths["lfmd"]


def feedback_points(feedback):
    """Kevin's feedback split into points exactly as agent-dispatch's submit gate splits it."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("agent_dispatch", os.path.join(os.path.dirname(HERE), "agent-dispatch.py"))
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod.feedback_points(feedback)


def lfmd_receipt(feedback, window, points=None):
    """One '- <his point> -> <what changed>' line per point, or '' unless every point is about the Learnings clip."""
    pts = points if points is not None else feedback_points(feedback)
    if not pts or not all(re.search(r"learn|diary|dairy|lfmd", p, re.I) for p in pts): return ""
    fmt = lambda s: "%d:%02d" % (int(s) // 60, int(s) % 60)
    return "\n".join("- %s → the Learnings from my diary clip is rebuilt from %s to %s and goes to the socials and the YouTube Short with this episode" % (p.strip(), fmt(window[0]), fmt(window[1])) for p in pts) + "\n"


REDO_LFMD_FILE = os.path.expanduser("~/.config/od/content_engine_redo_lfmd")
HOLD_FILE = os.path.expanduser("~/.config/od/content_engine_hold_days")


def _drop_day(path, day):
    try: lines = open(path).read().splitlines()
    except OSError: return False
    keep = [l for l in lines if not re.match(r"\s*%d\b" % day, l)]
    if len(keep) == len(lines): return False
    tmp = path + ".tmp"; open(tmp, "w").write("\n".join(keep) + ("\n" if keep else "")); os.replace(tmp, path)
    return True


def release_hold(day):
    """The Learnings clip exists: the day may publish, and its rebuild request is done."""
    if _drop_day(HOLD_FILE, day): print("episode %d: hold released (Learnings clip in place)" % day)
    _drop_day(REDO_LFMD_FILE, day)


def redo_requested(path=None):
    """Nightly: rebuild the Learnings clip for every day listed in content_engine_redo_lfmd (one day per line, reason
    after it). A failure stays listed for the next night and is printed; a success clears the day and its hold."""
    path = path or REDO_LFMD_FILE
    try: days = [int(m.group(1)) for m in (re.match(r"\s*(\d{3,4})\b", l) for l in open(path)) if m]
    except OSError: days = []
    if not days: print("redo: no Learnings rebuilds requested"); return
    for day in days:
        try: redo_lfmd(day)
        except (Exception, SystemExit) as ex: print("redo: episode %d Learnings rebuild FAILED, kept for the next night (%s)" % (day, str(ex)[-200:]), file=sys.stderr)


def redo_full(day, keep=False):
    """Rebuild one episode's whole output set (Kevin sent 2056 back on 10 Sep 2026: no jingle, no Learnings clip):
    re-pull the clip if it is gone, then run the normal render; the Drive uploads replace the day's files."""
    ledger = watch.load_ledger()
    keys = [k for k, v in ledger.items() if v.get("episode") == day and v.get("role") == "episode"]
    if not keys: raise SystemExit("no episode clip for day %d in the ledger" % day)
    key = keys[0]; e = ledger[key]
    if e.get("joined_from"):
        raise SystemExit("episode %d is joined from %s and %s: set both back to new in the ledger so the night renders and joins them again" % (day, e["joined_from"], key))
    clip = e.get("local") or ""
    if not clip or not os.path.exists(clip):
        e["status"] = "new"; watch.save_ledger(ledger)
        clip = watch.pull(ledger, key)
        if not clip: raise SystemExit("could not pull %s again" % key)
        ledger = watch.load_ledger()
    ledger[key]["status"] = "pulled"; ledger[key]["local"] = clip; ledger[key]["redo"] = dt.datetime.now().isoformat(timespec="seconds")
    ledger[key].pop("outputs", None); watch.save_ledger(ledger)
    process(key, ledger, keep=keep)
    import approval
    if str(day) in approval.load_state():      # a card already exists: refresh it (a sent-back card needs --receipt, see approval.py)
        approval.refresh_card(day, receipt=os.environ.get("CE_RECEIPT") or None)
    return key


FULL_COPY_FIELDS = ("Blog Copy", "Blog Post Description", "YouTube Copy", "Podcast Copy")   # platform_copy.TYPES["Long Form Video"]


def card_sent_back(day):
    try:
        import approval
        return (approval.load_state().get(str(day)) or {}).get("verdict") == "changes"
    except Exception as ex:
        print("render: approval state not readable (%s); the copy is left as it is" % str(ex)[:100], file=sys.stderr); return False


def _when(iso):
    """An aware datetime from the ledger's local stamp or Airtable's UTC one; None when unreadable."""
    try:
        t = dt.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        return t if t.tzinfo else t.astimezone()
    except ValueError:
        return None


RESUBMIT_DIR = os.path.expanduser("~/.config/od/content_engine_resubmit")   # <day>.md: the receipt for a card Kevin sent back


def resubmit_due(day, ledger, receipt_mtime, card, full_fields):
    """'' when a sent-back card may go back to Kevin with its receipt, else why not yet. The receipt is written when the
    fix is set in motion; the card waits until the night has re-rendered the episode AFTER that, nothing of the day is
    still waiting, and the copy has been written again (24 Sep 2026, 2071: re-rendered overnight, copy rewritten after)."""
    if (card or {}).get("verdict") != "changes": return "the card is not sent back"
    mine = [v for v in ledger.values() if v.get("episode") == day or (v.get("day") == day and not v.get("episode"))]
    if any(v.get("status") in ("new", "pulled", "pulling", "rendering") for v in mine): return "a clip of the day is still waiting to render"
    if any(v.get("status") == "failed" for v in mine): return "a clip of the day failed to render; it goes back once that is put right"   # never part 1 alone (review, 24 Sep 2026)
    ep = [v for v in mine if v.get("role") == "episode" and v.get("status") == "rendered"]
    if not ep: return "the episode has not rendered"
    if max((v.get("rendered") or "") for v in ep) < dt.datetime.fromtimestamp(receipt_mtime).isoformat(timespec="seconds"):
        return "the episode has not rendered since the receipt was written"
    if not (full_fields.get("YouTube Copy") or "").strip(): return "the copy has not been written again yet"
    wrote, made = _when(full_fields.get("AI Last Run")), _when(max((v.get("rendered") or "") for v in ep))
    if not wrote or not made or wrote < made: return "the copy is older than the render"
    return ""


def resubmit_ready(root=None):
    """Send back to Kevin every sent-back card whose fix has landed, with the receipt written for it. Returns the days sent."""
    import approval
    root = root or RESUBMIT_DIR
    if not os.path.isdir(root): return []
    ledger = watch.load_ledger(); state = approval.load_state(); sent = []
    for name in sorted(os.listdir(root)):
        m = re.match(r"^(\d+)\.md$", name)
        if not m: continue
        day, path = int(m.group(1)), os.path.join(root, name)
        full = approval.bundle(day)["Long Form Video"] or {"fields": {}}
        why = resubmit_due(day, ledger, os.path.getmtime(path), state.get(str(day)), full["fields"])
        if why: print("resubmit: episode %d waits: %s" % (day, why)); continue
        try:
            approval.refresh_card(day, receipt=path)
        except SystemExit as ex:
            print("resubmit: episode %d NOT resubmitted: %s" % (day, str(ex)[-300:]), file=sys.stderr); continue
        os.replace(path, path + ".sent"); sent.append(day)
        print("resubmit: episode %d card back with Kevin, with its receipt" % day)
    return sent


def teaser_waits(key, ledger):
    """A short clip renders AFTER the day's long one so its banner can carry the episode title (1841's teaser
    said 'Diary of a Runpreneur', Kevin 10 Sep 2026). It waits while a bigger clip of the same day is still
    new, pulled or rendering; a day with no bigger clip, or one whose long clip failed, renders at once."""
    return watch.waits_for_bigger(key, ledger)


def episode_title_for(day, ledger):
    """The banner title the day's long clip produced, if it has rendered."""
    for v in ledger.values():
        if v.get("episode") == day and v.get("role") == "episode" and v.get("status") == "rendered" and v.get("title"):
            return v["title"]
    return None


def run(limit=1, keep=False):
    ledger = watch.load_ledger()
    keys = [k for k, v in ledger.items() if v.get("status") == "pulled" and v.get("local") and os.path.exists(v["local"])]
    keys = sorted(keys, key=lambda k: (ledger[k]["date"], -(ledger[k].get("size") or 0)))     # the long clip of a day first
    waiting = [k for k in keys if teaser_waits(k, ledger)]
    keys = [k for k in keys if k not in waiting][:limit]
    for k in waiting: print("render: %s waits for the day's long clip (title first)" % k)
    if not keys:
        print("render: nothing pulled" + (" (%d waiting)" % len(waiting) if waiting else "")); return
    failed = []
    for k in keys:
        try:
            process(k, ledger, keep)
        except Exception as exc:   # one bad clip must never take the rest of the night with it (5 Sep 2026)
            failed.append(k)
            ledger = watch.load_ledger()
            if k in ledger:
                ledger[k]["status"] = "failed"; ledger[k]["error"] = str(exc)[:500]
                watch.save_ledger(ledger)
            print("render FAILED for %s: %s" % (k, exc), file=sys.stderr)
    print("render: %d of %d clips done, %d failed%s" % (len(keys) - len(failed), len(keys), len(failed),
          (" (" + ", ".join(failed) + ")") if failed else ""))
    ledger = watch.load_ledger()
    for k in waiting:                                    # the short clips whose long clip has just finished
        if k in ledger and ledger[k].get("status") == "pulled" and not teaser_waits(k, ledger):
            try: process(k, ledger, keep); print("render: %s rendered after its episode" % k)
            except Exception as exc:
                ledger = watch.load_ledger(); ledger[k]["status"] = "failed"; ledger[k]["error"] = str(exc)[:500]; watch.save_ledger(ledger)
                print("render FAILED for %s: %s" % (k, exc), file=sys.stderr)


def one(clip, day, out):
    os.makedirs(out, exist_ok=True)
    text, srt = transcribe(clip, out)
    print("transcript chars", len(text), "spoken day", watch.spoken_day(text))
    masters = render_masters(clip, out)
    paths = build_outputs(masters, srt, day, title_from_transcript(text), out)
    print(json.dumps(paths, indent=1))


def _selftest_parts():
    """2071 (24 Sep 2026), from the real captions: part 1's sound died at 6:48, part 2 is a note to Sam and the learnings."""
    segs1 = [(355.12, 362.64, "just don't be afraid to kind of stop having regular breaks. The last thing you want to do is give"),
             (362.64, 368.48, "yourself a longer term injury or make yourself feel rougher for longer than necessary. So,"),
             (368.48, 374.48, "ultimately, loads from a diary is if how can you exercise when you're feeling under the weather?"),
             (374.48, 380.40, "Well, my first suggestion would be that if you are feeling under the weather, your body is"),
             (402.96, 410.96, "and use the exercise as a kind of recovery."), (410.96, 416.96, "[silence]"), (416.96, 422.96, "[silence]")]
    segs2 = [(0.0, 7.54, "So Sam if you can stitch this together to my previous run as it the sound cut out off"), (7.54, 9.38, "way through."),
             (9.38, 17.16, "So learning from my diary for today are that if you are feeling rough and you need to run"),
             (17.16, 21.6, "or exercise there's a few things you can do to try and get through it to mitigate the"),
             (100.0, 109.3, "Thank you as always, stay positive, stay happy and I'll see you again tomorrow.")]
    assert is_continuation("2071 Full Part 2.insv", "") and is_continuation("VID_x.insv", " ".join(t for _, _, t in segs2))
    assert not is_continuation("2071 Full - Part 1.insv", " ".join(t for _, _, t in segs1)) and not is_continuation("2072 Full.insv", "welcome back to day 2072")
    w2 = lfmd_window(segs2); assert w2 and w2[0] == 9.38, w2
    p2, why2 = part_two_start(segs2, w2); assert p2 == 9.38 and "note to the editor" in why2, (p2, why2)
    p1, why1 = part_one_end(segs1, True); assert 367.5 < p1 < 368.48 and "own learnings" in why1, (p1, why1)
    assert part_one_end(segs1, False)[0] == 411.26, "no learnings to replace: part 1 runs to where the speech stops"
    assert part_two_start([(0.0, 5.0, "Welcome back to day 2072")], None) == (0.0, "no note to the editor; the whole part is used")
    j = srt_segments(join_srt(segs1, p1, segs2, p2))
    assert j[1][2].endswith("necessary.") and not any("loads from a diary" in t or "Sam" in t for _, _, t in j), j
    assert j[2][2].startswith("So learning from my diary") and abs(j[2][0] - p1) < 0.01, "part 2 follows on at the join"
    # the summary he recorded the next morning (1 Feb 09:23, "day 2,071") and a clip of the day waiting keep part 1's masters
    led = {"p1": {"day": 2071, "status": "rendered", "keep_masters": "/nonexistent/render_p1"}, "p2": {"day": 2071, "status": "new"},
           "t": {"day": 2072, "status": "new", "size": 5e8}}
    assert release_kept(led, remove=lambda p: None) == [] and led["p1"]["keep_masters"], "part 2 still waits: kept"
    led["p2"]["status"] = "rendered"; assert release_kept(led, remove=lambda p: None) == ["p1"] and "keep_masters" not in led["p1"]
    assert keep_for_next_part("2071 Full - Part 1.insv", {"day": 2071}, {"2071 Full Part 2.insv": {"day": 2071, "status": "new", "size": 1.3e9}})
    assert not keep_for_next_part("2072 Full.insv", {"day": 2072}, {"2072 Summary.insv": {"day": 2072, "status": "new", "size": 5.7e8}}), "a teaser is not a part"
    assert teaser_for_day_before("teaser", 2071, 2072, {}) and not teaser_for_day_before("episode", 2071, 2072, {})
    assert not teaser_for_day_before("teaser", 2072, 2072, {}) and not teaser_for_day_before("teaser", None, 2072, {})
    assert not teaser_for_day_before("teaser", 2071, 2072, {"x": {"episode": 2071, "role": "teaser", "status": "rendered"}}), "the day already has its teaser"
    import time as _t
    t0 = _t.mktime(dt.datetime(2026, 9, 24, 18, 0).timetuple())
    card, fullf = {"verdict": "changes"}, {"YouTube Copy": "x", "AI Last Run": "2026-09-25T02:10:00.000Z"}
    led = {"p2": {"episode": 2071, "day": 2071, "role": "episode", "status": "rendered", "rendered": "2026-09-25T01:30:00"},
           "t": {"episode": 2071, "day": 2072, "role": "teaser", "status": "rendered", "rendered": "2026-09-25T03:40:00"}}
    assert resubmit_due(2071, led, t0, card, fullf) == "", "re-rendered after the receipt, nothing waiting, copy written: goes back"
    assert "not rendered since" in resubmit_due(2071, dict(led, p2=dict(led["p2"], rendered="2026-09-24T00:46:50")), t0, card, fullf)
    assert "still waiting" in resubmit_due(2071, dict(led, p1={"day": 2071, "status": "new"}), t0, card, fullf)
    assert "failed" in resubmit_due(2071, dict(led, p3={"day": 2071, "episode": 2071, "status": "failed"}), t0, card, fullf), "a failed part holds the card"
    assert "copy" in resubmit_due(2071, led, t0, card, {"YouTube Copy": ""}) and "not sent back" in resubmit_due(2071, led, t0, {"verdict": "approved"}, fullf)
    assert "older than the render" in resubmit_due(2071, led, t0, card, {"YouTube Copy": "x", "AI Last Run": "2026-09-23T22:48:00.000Z"}), "yesterday's copy is not today's"
    import platform_copy as _pc
    assert FULL_COPY_FIELDS == tuple(f for _, f in _pc.TYPES["Long Form Video"]["sections"]), "the fields cleared are the fields the writer writes"
    assert STITCH_RE.search("So Sam if you can stitch this together to my previous run") and STITCH_RE.search("can you add this onto the last clip")
    assert not STITCH_RE.search("join me today as I talk about the previous week") and not STITCH_RE.search("I want to add to that the earlier point")


def selftest():
    _selftest_parts()
    assert hundreds_folder(2049) == "2001-2100" and hundreds_folder(2100) == "2001-2100" and hundreds_folder(2101) == "2101-2200"
    assert output_names(2225)["full"] == "Episode_2225_Full_Episode.mp4" and output_names(2225)["podcast"] == "Ep2225_Podcast.mp3"
    assert output_names(2225)["full_yt"] == "Episode_2225_Full_Episode_YT.mp4" and output_names(2225)["lfmd_srt"] == "Ep2225_LFMD_YT.srt"
    s3 = "1\n00:00:01,000 --> 00:00:03,000\nbefore\n\n2\n00:00:10,000 --> 00:00:12,500\nafter\n"
    sh = shift_after(s3, 5.0, 7.0)
    assert "00:00:01,000 --> 00:00:03,000" in sh and "00:00:17,000 --> 00:00:19,500" in sh, sh
    assert "00:00:08,000 --> 00:00:10,000" in shift_after(s3, 0.0, 7.0), "a jingle at the very start moves every cue"
    assert INTRO_SECONDS_FALLBACK == 7.0 and intro_seconds("/nonexistent.mp4") == 7.0
    import inspect as _i; bo = _i.getsource(build_outputs); assert 'paths["full_yt"] = insert_intro(masters["16:9"]' in bo and bo.count("clean_short(") == 2, "both YouTube variants are built"
    segs_i = [(0, 4, "consecutive day 2195 of a diary of a Runpreneur"), (4, 9, "if that resonates with you keep on watching"), (9, 15, "welcome back to consecutive day"), (300, 305, "so let's go")]
    assert INTRO_CLIP.endswith("Vlog Intro/runprenuer-intro_clip.mp4") and INTRO_TRIM_START == 1.0
    segs_c = [(0, 2.2, "So today I want to"), (19.9, 22.2, "So keep in mind,"), (22.2, 24.5, "keep on listening, hope"),
              (24.5, 26.8, "you find it useful."), (26.8, 28.6, "Welcome back to consecutive"), (28.6, 30.4, "day, 2057, with a")]
    txt, when = flat_captions(segs_c)
    assert "listening, hope you find it useful." in txt, "the chunks join, so a phrase split across them still matches"
    assert abs(when(txt.index("Welcome")) - 26.8) < 0.2, when(txt.index("Welcome"))
    w = intro_window(segs_c, 500)
    assert w and 26.3 < w[0] <= 26.9 and abs(w[1] - 26.8) < 0.3, ("the LAST sign-off before the welcome, not the first", w)
    assert intro_window([(0, 5, "just talking"), (300, 305, "let us go")], 600) is None, "no sign-off, no welcome: the jingle leads"
    assert intro_window([(0, 3, "welcome back to consecutive day 9")], 100)[0] >= 0.0
    assert pick_cut([(10.0, 10.9)], 10.2, 10.6) == (10.15, 10.7) and pick_cut([(1.0, 1.9)], 10.2, 10.6) is None
    led = {"a full.insv": {"date": "2026-09-10", "size": 3000, "status": "pulled"}, "a sum.insv": {"date": "2026-09-10", "size": 500, "status": "pulled"},
           "b sum.insv": {"date": "2026-09-11", "size": 500, "status": "pulled"}}
    assert teaser_waits("a sum.insv", led) and not teaser_waits("a full.insv", led) and not teaser_waits("b sum.insv", led), "a teaser waits only while its day's long clip is unfinished"
    led["a full.insv"].update({"status": "rendered", "episode": 2056, "role": "episode", "title": "GET YOUR TEAM|ALL IN"})
    assert not teaser_waits("a sum.insv", led) and episode_title_for(2056, led) == "GET YOUR TEAM|ALL IN" and episode_title_for(2057, led) is None
    import inspect as _i4; pr = _i4.getsource(process); assert "episode_title_for(day, ledger) or title" in pr, "the teaser banner carries the episode title"
    assert 'lines = (l1, l2, how)' in pr and 'title = (l1 + "|" + l2).upper()' in pr and "make_thumbnail(masters[\"9:16\"], duration, text, day, workdir, lines=lines)" in pr, "one headline: banner and thumbnail agree"
    assert 'e["horizon"] = horizon_for(masters)' in pr and source_fps("/nonexistent") is None and horizon_for({"16:9": "/nonexistent"}) is None
    assert lfmd_window([(0, 5, "hello"), (200, 210, "So the latest in my diary is that you should"), (240, 250, "stay positive, see you tomorrow")]) == (200, 250), "whisper's 'latest in my diary' (2056)"
    assert lfmd_window([(0, 5, "the learnings from my diary today"), (30, 40, "thank you as always")]) == (0, 40)
    assert lfmd_window([(0, 5, "I wrote it in my dairy today"), (30, 40, "see you tomorrow")]) == (0, 40), "the mis-spelt diary still counts"
    assert lfmd_window([(0, 5, "a diary of a Runpreneur"), (30, 40, "see you tomorrow")]) is None, "the show's name is not the section"
    assert lfmd_window([(0, 5, "So I suppose the learning from"), (5, 9, "a diet today is that problems"), (60, 70, "see you tomorrow")]) == (0, 70), "2060: mis-heard and split across two caption chunks"
    assert lfmd_window([(0, 5, "the learnings from my"), (5, 9, "diary today"), (40, 50, "stay positive")]) == (0, 50), "a phrase split over two chunks"
    assert lfmd_window([(0, 5, "I changed my diet today"), (40, 50, "stay positive")]) is None, "a diet on its own is not the section"
    assert DIARY_NEAR_MISS_RE.search("so the learning I took from the dire today") and not DIARY_NEAR_MISS_RE.search("the diary of a Runpreneur")
    # 2062 (18 Sep 2026): "the learning for my diary is there" -> "my dive". The section was skipped AND the near-miss
    # guard missed it too, so the card reached Kevin with no Learnings clip and nothing flagged. He sent it back.
    assert lfmd_window([(0, 5, "intro"), (390, 396, "ultimately the learning for my dive is there"), (500, 510, "see you tomorrow")]) == (390.0, 510.0), "2062: whisper heard dive"
    assert lfmd_window([(0, 5, "the learnings from my dive today"), (30, 40, "stay positive")]) == (0, 40), "1964/2032/2033's wording"
    assert lfmd_window([(0, 5, "learning from a diver today"), (30, 40, "stay positive")]) == (0, 40), "2042's wording"
    assert DIARY_NEAR_MISS_RE.search("the learning for my dive is there"), "a mis-heard diary must still reach the output gate"
    # "dive" on its own is an ordinary word (2062 also says "when you dive deeper into it"): only the tight context counts
    assert lfmd_window([(0, 5, "when you dive deeper into it"), (40, 50, "stay positive")]) is None, "a dive on its own is not the section"
    assert lfmd_window([(0, 5, "I want to dive into the numbers"), (40, 50, "stay positive")]) is None
    assert not DIARY_NEAR_MISS_RE.search("we learn a lot when we all go and dive deeper into the numbers together"), "too far from learn to be the section"

    r = lfmd_receipt("", (295.52, 403.35), points=["There are no learnings from my diary on this, which need to be added."])
    assert r.startswith("- There are no learnings from my diary on this") and "4:55 to 6:43" in r and r.count("\n") == 1, r
    assert lfmd_receipt("", (1, 30), points=["No learnings clip", "The title is wrong"]) == "", "a point about something else is never answered by the rebuild"
    import inspect as _ins; rs = _ins.getsource(redo_lfmd); assert "receipt=rpath" in rs and "and resubmitted: release_hold(day)" in rs
    assert lfmd_window([(0, 5, "So I think the learning story for today is"), (30, 40, "see you tomorrow")]) == (0, 40), "1841 (2025): he says 'the learning story for today'"
    assert lfmd_window([(0, 5, "So consecutive day, 2056th of the diary of a Ron Prenner, and today's"), (30, 40, "see you tomorrow")]) is None, "the show's name is not a Learnings section (2056 teaser)"
    assert lfmd_window([(0, 5, "welcome back to consecutive day 2195 of the diary of a Runpreneur"), (30, 40, "stay positive")]) is None
    assert lfmd_window([(0, 5, "So the learnings from my diary of today"), (30, 40, "see you tomorrow")]) == (0, 40), "'my diary of today' still counts"
    assert lfmd_window([(0, 5, "the lessons for today"), (30, 40, "stay positive")]) == (0, 40)
    import inspect as _i3; ii = _i3.getsource(insert_intro); assert "intro_clip()" in ii and "check_intro_length(" in ii, "the jingle comes from the API copy and the output length is proved"
    try: check_intro_length("/nonexistent", "/nonexistent", "/nonexistent"); ok = True
    except SystemExit: ok = False
    assert ok, "unreadable paths measure 0 and pass the arithmetic; the real guard is on real files"
    assert lfmd_window([(0, 5, "intro"), (60, 66, "so anyway, so learning through my diary, running off road"), (66, 90, "one"), (90, 95, "see you again tomorrow")]) == (60.0, 95.0), "2195's wording"
    assert lfmd_window([(0, 5, "intro"), (60, 66, "So I suppose the learnings from my diet today"), (66, 90, "one"), (90, 95, "see you again tomorrow")]) == (60.0, 95.0), "2054: whisper heard diet"
    assert lfmd_window([(0, 5, "intro"), (60, 66, "the lessons from the dairy are"), (66, 90, "one"), (90, 95, "see you again tomorrow")]) == (60.0, 95.0), "lessons / dairy"
    assert lfmd_window([(0, 5, "I learned a lot on this diet plan"), (5, 40, "more")]) is None, "not a diary section"
    assert pick_cut([(4.2, 4.5), (7.9, 9.4)], 4.0, 9.0) == (8.05, 9.2), "the pause after the last sign-off word, speech back at its end"
    assert pick_cut([(4.2, 4.5), (6.0, 6.3)], 4.0, 9.0) is None, "word gaps under half a second never count"
    assert pick_cut([(30.83, 33.72)], 28.0, 34.0) == (30.98, 33.52), "2194: the caption ran 3 s past the last word"
    assert podcast_filter(8.05, 9.4).startswith("[0:a]atrim=0:8.050") and "atrim=9.400" in podcast_filter(8.05, 9.4) and podcast_filter(8.0, 8.0) is None
    f4 = record_updates(2195, {"full": "u1", "thumb": "t"}, "t", "r", "c"); assert f4["Reframed Video URL"] is None, "no Learnings clip means the old link is cleared"
    srt_c = "1\n00:00:28,000 --> 00:00:34,000\nhope you find it useful\n\n2\n00:00:34,000 --> 00:00:40,000\nwelcome back\n"
    assert "00:00:28,000 --> 00:00:30,980" in clip_caption_at(srt_c, 30.98) and "00:00:34,000 --> 00:00:40,000" in clip_caption_at(srt_c, 30.98), clip_caption_at(srt_c, 30.98)
    assert clip_caption_at(srt_c, 0.0) == srt_c
    import tempfile
    tf = os.path.join(tempfile.gettempdir(), "od-caps-%d.srt" % os.getpid()); open(tf, "w").write(srt_c)
    clipped = clip_caption_at(open(tf).read(), 30.98)
    with open(tf, "w") as fh: fh.write(clipped)
    assert len(open(tf).read()) > 50 and "00:00:30,980" in open(tf).read(), "the clipped caption file is written, never emptied"; os.remove(tf)
    assert master_complete("/nonexistent/master.mp4", "/nonexistent/clip.insv") is False
    t = title_from_transcript("So consecutive day, 2,225 of a diary of a Runpreneur, and today's episode I talk all about how you can record a video using a structured script to turn that video into an autonomous AI agent, which is going")
    assert "|" in t and "RECORD" in t and len(t) < 90, t
    assert title_from_transcript("nothing useful here") == "DIARY OF A|RUNPRENEUR"
    f = record_updates(2225, {"full": "u1", "lfmd": "u2", "summary": "u3", "thumb": "u4"}, "text", "why", "clip")
    assert f["Video Edited URL"] == "u1" and f["Reframed Video URL"] == "u2" and f["Summary Video URL"] == "u3"
    assert f["Thumbnail URL"] == "u4" and "Thumbnail URL" not in record_updates(2225, {"full": "u1"}, "t", "r", "c")
    real = thumbnail.titles_from_transcript
    thumbnail.titles_from_transcript = lambda t: (_ for _ in ()).throw(SystemExit("claude failed: offline"))
    try: l1, l2, how = thumb_lines("nothing useful here")
    finally: thumbnail.titles_from_transcript = real
    assert (l1, l2, how) == ("DIARY OF A", "RUNPRENEUR", "banner"), "a Claude failure falls back to the banner title, never stops the render"
    assert f["Record Status"] == STATUS_DONE and "why" in f["Notes"]
    f2 = record_updates(2225, {"full": None}, "t", "r", "c"); assert "Video Edited URL" not in f2
    f3 = record_updates(2225, {"summary": "u3"}, "t", "r", "c", role="teaser")
    assert "Record Status" not in f3 and "Transcription" not in f3 and f3["Summary Video URL"] == "u3", "a teaser never closes the episode"
    assert clip_role(41.6, False) == "teaser" and clip_role(700, True) == "episode" and clip_role(100, True) == "episode"
    segs = [(0, 5, "So consecutive day 2195"), (5, 60, "today I talk about off-road running"), (60, 70, "so the learnings from my diary today are"),
            (70, 95, "be careful on descents"), (95, 100, "Thank you as always, stay positive"), (100, 110, "[BLANK]")]
    assert lfmd_window(segs) == (60.0, 100.0), lfmd_window(segs)
    assert lfmd_window(segs[:2]) is None
    segs2 = [(0, 5, "learning from my diary teaser"), (5, 50, "body"), (50, 55, "learnings for my diary"), (55, 58, "see you tomorrow")]
    assert lfmd_window(segs2) == (50.0, 58.0), "last mention wins; padding never runs past the clip end"
    srt = "1\n00:00:58,000 --> 00:01:02,000\nA\n\n2\n00:01:02,000 --> 00:01:05,000\nB\n"
    shifted = shift_srt(srt, 60.0, 65.0)
    assert "00:00:00,000 --> 00:00:02,000" in shifted and "00:00:02,000 --> 00:00:05,000" in shifted, shifted
    # 5 Sep 2026: an empty captions.srt aborted overlays.py 'full' and killed the whole nightly run
    assert srt_cue_count(srt) == 2 and srt_cue_count("") == 0 and srt_cue_count("   \n\n  ") == 0
    assert srt_cue_count("1\nnot a cue\n") == 0, "a block with no timing line is not a cue"
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        empty = os.path.join(td, "captions.srt"); open(empty, "w").write("")
        for bad, why in ((empty, "empty"), (os.path.join(td, "gone.srt"), "missing")):
            try: check_captions(bad, "test"); raise AssertionError("%s SRT must be refused" % why)
            except RuntimeError as exc: assert "test" in str(exc), str(exc)
        good = os.path.join(td, "ok.srt"); open(good, "w").write(srt)
        assert check_captions(good, "test") == 2
    print(json.dumps({"checks": 47, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("clip", nargs="?"); ap.add_argument("--day", type=int, default=0); ap.add_argument("--only", default="")
    ap.add_argument("--out", default=os.path.expanduser("~/knowledge-os/logs/content-engine/manual"))
    ap.add_argument("--limit", type=int, default=1); ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "run": run(a.limit, a.keep)
    elif a.mode == "redo" and a.only == "lfmd": redo_lfmd(a.day)
    elif a.mode == "redo-requested": redo_requested()
    elif a.mode == "redo": redo_full(a.day, keep=a.keep if hasattr(a, "keep") else False)
    elif a.mode == "one": one(a.clip, a.day, a.out)
    elif a.mode == "resubmit-ready": resubmit_ready()
    else: raise SystemExit("unknown mode")
