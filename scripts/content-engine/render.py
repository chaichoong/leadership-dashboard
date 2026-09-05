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
import argparse, datetime as dt, json, os, re, shutil, subprocess, sys, time, urllib.parse

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
INTRO_SIGNOFF_RE = re.compile(r"keep on (?:watching|listening)|hope you find (?:it|this) useful|stay with me|let'?s go\b", re.I)
WELCOME_RES = [re.compile(r"welcome back to (?:consecutive )?day", re.I), re.compile(r"consecutive day", re.I)]   # in the app's order
INTRO_SEARCH_FRACTION = 0.35    # the sign-off lives in the cold open; a "let's go" at 80% is not it
INTRO_TRIM_START = 1.0          # Kevin, 4 Sep 2026: the jingle's first second (black, then an indoor shot in a dark top) is cut
CUT_THRESHOLDS_DB = (-35, -30, -25, -20)   # studio-quiet first; a windy road needs -20 before the pause shows
CUT_PAUSE_MIN = 0.5             # a pause between sentences, not a gap between words
CUT_LEAD = 0.15                 # seconds of the pause kept after the last word before the jingle


def pick_cut(silences, seg_start, at):
    """The jingle goes in at the pause after Kevin's last sign-off word, not at the caption's end (Kevin,
    4 Sep 2026: on 2194 the caption ran 3 s past the last word). `silences` = [(start, end)] in clip
    seconds. Take the LAST pause of half a second or more that starts at least a second into the
    sign-off caption and no later than 1.5 s after the caption end. Returns (cut, resume) where resume
    is where speech starts again, or None when no such pause exists (caller falls back to caption times)."""
    cands = [(s, e) for s, e in silences if seg_start + 1.0 <= s <= at + 1.5 and e - s >= CUT_PAUSE_MIN]
    if not cands: return None
    s, e = cands[-1]
    return round(s + CUT_LEAD, 2), round(max(s + CUT_LEAD, e - 0.2), 2)


def silences(video, start, length, db):
    """ffmpeg silencedetect over [start, start+length] at `db`, as [(abs_start, abs_end)]."""
    r = subprocess.run([FFMPEG, "-v", "info", "-ss", "%.3f" % start, "-t", "%.3f" % length, "-i", video, "-af",
                        "silencedetect=n=%ddB:d=%.2f" % (db, 0.2), "-f", "null", "-"], capture_output=True, text=True)
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", r.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", r.stderr)]
    return [(start + s, start + (ends[i] if i < len(ends) else start + length)) for i, s in enumerate(starts)]


def find_pause(video, segments, at):
    """(cut, resume) tightened to the real pause after the sign-off; caption times when none is found.
    The threshold adapts: the first level (quiet first) that shows a pause of CUT_PAUSE_MIN wins."""
    later = [s for s in segments if s[0] >= at - 0.05]
    fallback = (at, round(max(at, later[0][0] - 0.2), 2) if later else at)
    if at <= 0.05: return fallback
    seg = [s for s in segments if abs(s[1] - at) < 0.01 or (s[0] < at <= s[1])]
    seg_start = seg[0][0] if seg else max(0.0, at - 6.0)
    for db in CUT_THRESHOLDS_DB:
        got = pick_cut(silences(video, seg_start, (at - seg_start) + 2.0, db), seg_start, at)
        if got: return got
    return fallback


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


def intro_insert_seconds(segments, duration=None):
    """Where the intro goes: the END of the caption carrying the sign-off phrase, else the START of the
    'welcome back' caption, else 0. Only the first part of the clip is searched."""
    if not segments: return 0.0
    limit = (duration or segments[-1][1]) * INTRO_SEARCH_FRACTION
    for a, b, text in segments:
        if a > limit: break
        if INTRO_SIGNOFF_RE.search(text): return float(b)
    for rx in WELCOME_RES:              # the specific phrase first, across the whole opening, then the loose one
        for a, b, text in segments:
            if a > limit: break
            if rx.search(text): return float(a)
    return 0.0


def insert_intro(full_path, at, out_path, intro=None):
    """Splice the intro into the finished (captioned) full episode at `at` seconds. Re-encodes once with the
    hardware encoder; the intro is scaled to the episode's frame and both audio tracks are made alike."""
    intro = intro or INTRO_CLIP
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
    return out_path


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
    return {"full": "Episode_%d_Full_Episode.mp4" % day, "lfmd": "Ep%d_LFMD.mp4" % day, "summary": "Ep%d_Summary.mp4" % day, "podcast": "Ep%d_Podcast.mp3" % day}


def title_from_transcript(text):
    """Two short banner lines from the 'today's episode I talk about X' sentence, else a fallback."""
    m = re.search(r"talk(?:ing)?\s+(?:all\s+)?about\s+(.{12,160}?)(?:[.,;]|\s+so\b|\s+and\b|\s+which\b|$)", text, re.I)
    if not m: return "DIARY OF A|RUNPRENEUR"
    words = m.group(1).strip().split()
    words = [w for w in words if w.lower() not in ("how", "you", "can", "your", "the", "a", "an", "to", "of")][:7] or words[:6]
    mid = (len(words) + 1) // 2
    return " ".join(words[:mid]).upper() + "|" + " ".join(words[mid:]).upper()


LFMD_START_RE = re.compile(r"learn\w*\s+(?:from|for|of|through|in|to)\s+(?:my|the)\s+diary", re.I)   # whisper heard "learning through my diary" on 2195
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
    starts = [i for i, (_, _, t) in enumerate(segments) if LFMD_START_RE.search(t)]
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


def make_thumbnail(master_916, duration, text, day, workdir):
    """R6: the YouTube thumbnail in the team's layout, from a frame of the 9:16 master (Kevin whole-body, mid-run)."""
    at = min(12.0, max(0.0, duration / 2))
    frame = os.path.join(workdir, "thumb_frame.png")
    subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", "%.2f" % at, "-i", master_916, "-frames:v", "1", frame], check=True)
    l1, l2, how = thumb_lines(text)
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


def render_masters(clip, workdir, only=None):
    out = {}
    for aspect, args in RECIPE.items():
        if only and aspect != only: continue
        dest = os.path.join(workdir, "master_%s.mp4" % aspect.replace(":", "x"))
        if master_complete(dest, clip):
            print("render: reusing finished %s master" % aspect); out[aspect] = dest; continue
        subprocess.run([sys.executable, os.path.join(HERE, "stab.py"), "render", clip, dest, "--map", "z-yx"] + args,
                       check=True, stdout=subprocess.DEVNULL)
        out[aspect] = dest
    return out


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


def build_outputs(masters, srt, day, title, workdir, lfmd=None, role="episode"):
    ov = os.path.join(HERE, "overlays.py")
    caps = os.path.join(workdir, "captions.srt")
    subprocess.run([sys.executable, ov, "captions", srt, caps], check=True, stdout=subprocess.DEVNULL)
    names = output_names(day); paths = {}
    if role == "teaser":
        paths["summary"] = os.path.join(workdir, names["summary"])
        subprocess.run([sys.executable, ov, "summary", masters["9:16"], caps, paths["summary"], "--day", str(day), "--title", title],
                       check=True, stdout=subprocess.DEVNULL)
        return paths
    segs = srt_segments(open(srt).read())
    at, resume = find_pause(masters["16:9"], segs, intro_insert_seconds(segs))     # on the master: same sound, no captions yet
    LAST_CUT.update({"at": at, "resume": resume})
    clipped = clip_caption_at(open(caps).read(), at)                                 # READ before the write opens the file (5 Sep 2026: open(w) first truncated it to nothing)
    with open(caps, "w") as fh: fh.write(clipped)
    captioned = os.path.join(workdir, "full_captioned.mp4")
    subprocess.run([sys.executable, ov, "full", masters["16:9"], caps, captioned], check=True, stdout=subprocess.DEVNULL)
    paths["full"] = os.path.join(workdir, names["full"])
    insert_intro(captioned, at, paths["full"])
    paths["podcast"] = podcast_audio(captioned, os.path.join(workdir, names["podcast"]), at, resume)
    if lfmd:   # the "Learnings from my diary" section only (Kevin, 3 Sep 2026)
        piece = trim(masters["9:16"], lfmd[0], lfmd[1], os.path.join(workdir, "lfmd_master.mp4"))
        lcaps = os.path.join(workdir, "captions_lfmd.srt")
        open(lcaps, "w").write(shift_srt(open(caps).read(), lfmd[0], lfmd[1]))
        paths["lfmd"] = os.path.join(workdir, names["lfmd"])
        subprocess.run([sys.executable, ov, "lfmd", piece, lcaps, paths["lfmd"], "--day", str(day), "--subtitle", title.replace("|", " ").strip()],
                       check=True, stdout=subprocess.DEVNULL)      # the subheading says what the episode is about (Kevin, 4 Sep 2026)
    return paths


def publish_to_drive(paths, day, transcript_txt):
    folder = os.path.join(EDITED_ROOT, hundreds_folder(day), str(day))
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
    day, reason = watch.resolve_episode(date_day, watch.spoken_day(text), prev_day_has_talk=prev_has_talk)
    e["episode"] = day; e["episode_reason"] = reason; e["status"] = "rendering"; watch.save_ledger(ledger)
    window = lfmd_window(srt_segments(open(srt).read()))
    duration = float(subprocess.run([os.path.expanduser("~/tools/bin/ffprobe"), "-v", "error", "-show_entries", "format=duration",
                                     "-of", "csv=p=0", clip], capture_output=True, text=True).stdout or 0)
    role = clip_role(duration, bool(window))
    e["lfmd_window"] = window; e["role"] = role; e["duration"] = round(duration, 1); watch.save_ledger(ledger)
    masters = render_masters(clip, workdir) if role == "episode" else {"9:16": render_masters(clip, workdir, only="9:16")["9:16"]}
    title = title_from_transcript(text)
    paths = build_outputs(masters, srt, day, title, workdir, lfmd=window, role=role)
    if role == "episode":
        e["intro_at"] = LAST_CUT.get("at"); e["podcast_resume"] = LAST_CUT.get("resume")
        paths["thumb"], e["thumb_lines"] = make_thumbnail(masters["9:16"], duration, text, day, workdir)
    folder, links = publish_to_drive(paths, day, os.path.join(workdir, "transcript.txt"))
    rid, how = find_or_create_record(day, e.get("drive_id"), key, dt.date.fromisoformat(e["date"]))
    watch._airtable("PATCH", watch.API + "/" + rid, {"fields": record_updates(day, links, text, reason, key, role)})
    e.update({"status": "rendered", "record_id": rid, "outputs": links, "edited_folder": folder, "title": title,
              "render_seconds": round(time.time() - t0), "rendered": dt.datetime.now().isoformat(timespec="seconds")})
    if not keep:
        os.remove(clip); shutil.rmtree(workdir, ignore_errors=True)
    watch.save_ledger(ledger)
    print("%s -> Episode %d %s (%s) in %d s; record %s (%s); links %s" % (key, day, role, reason, e["render_seconds"], rid, how,
          {k: ("ok" if v else "NO DRIVE ID YET") for k, v in links.items()}))


def run(limit=1, keep=False):
    ledger = watch.load_ledger()
    keys = [k for k, v in ledger.items() if v.get("status") == "pulled" and v.get("local") and os.path.exists(v["local"])]
    keys = sorted(keys, key=lambda k: (ledger[k]["date"], ledger[k].get("size", 0)))[:limit]
    if not keys:
        print("render: nothing pulled"); return
    for k in keys:
        process(k, ledger, keep)


def one(clip, day, out):
    os.makedirs(out, exist_ok=True)
    text, srt = transcribe(clip, out)
    print("transcript chars", len(text), "spoken day", watch.spoken_day(text))
    masters = render_masters(clip, out)
    paths = build_outputs(masters, srt, day, title_from_transcript(text), out)
    print(json.dumps(paths, indent=1))


def selftest():
    assert hundreds_folder(2049) == "2001-2100" and hundreds_folder(2100) == "2001-2100" and hundreds_folder(2101) == "2101-2200"
    assert output_names(2225)["full"] == "Episode_2225_Full_Episode.mp4" and output_names(2225)["podcast"] == "Ep2225_Podcast.mp3"
    segs_i = [(0, 4, "consecutive day 2195 of a diary of a Runpreneur"), (4, 9, "if that resonates with you keep on watching"), (9, 15, "welcome back to consecutive day"), (300, 305, "so let's go")]
    assert intro_insert_seconds(segs_i, 600) == 9.0, "after the sign-off caption"
    assert intro_insert_seconds(segs_i[:1] + segs_i[2:], 600) == 9.0, "before the welcome-back caption when there is no sign-off"
    assert intro_insert_seconds([(0, 5, "just talking"), (300, 305, "let's go")], 600) == 0.0, "a late let's go is not the sign-off"
    assert intro_insert_seconds([], 10) == 0.0
    assert INTRO_CLIP.endswith("Vlog Intro/runprenuer-intro_clip.mp4") and INTRO_TRIM_START == 1.0
    assert lfmd_window([(0, 5, "intro"), (60, 66, "so anyway, so learning through my diary, running off road"), (66, 90, "one"), (90, 95, "see you again tomorrow")]) == (60.0, 95.0), "2195's wording"
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
    print(json.dumps({"checks": 36, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("clip", nargs="?"); ap.add_argument("--day", type=int, default=0)
    ap.add_argument("--out", default=os.path.expanduser("~/knowledge-os/logs/content-engine/manual"))
    ap.add_argument("--limit", type=int, default=1); ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "run": run(a.limit, a.keep)
    elif a.mode == "one": one(a.clip, a.day, a.out)
    else: raise SystemExit("unknown mode")
