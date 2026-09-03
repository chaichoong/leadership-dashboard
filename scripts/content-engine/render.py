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

FFMPEG = os.path.expanduser("~/tools/bin/ffmpeg")
WHISPER = os.path.expanduser("~/tools/whisper.cpp/main")
WHISPER_MODEL = os.path.expanduser("~/tools/whisper.cpp/models/ggml-base.en.bin")
EDITED_ROOT = os.path.expanduser("~/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/Shared drives/Marketing/Runpreneur/Runpreneur Edited Video")
MIN_TRANSCRIPT_CHARS = 50
RECIPE = {   # docs/content-engine-360.md, Kevin-approved 2 Sep 2026
    "16:9": ["--proj", "sg", "--dfov", "250", "--tilt", "11", "--level", "--blend", "0.6", "--size", "1920x1080"],
    "9:16": ["--proj", "sg", "--dfov", "215", "--tilt", "9", "--level", "--blend", "0.6", "--size", "1080x1920"],
}
STATUS_DONE = "Optimisation and Design Done"


# ---------- pure helpers ----------

def hundreds_folder(day):
    """Episode 2225 -> '2201-2300' (the edited folder's existing convention)."""
    lo = ((day - 1) // 100) * 100 + 1
    return "%d-%d" % (lo, lo + 99)


def output_names(day):
    return {"full": "Episode_%d_Full_Episode.mp4" % day, "lfmd": "Ep%d_LFMD.mp4" % day, "summary": "Ep%d_Summary.mp4" % day}


def title_from_transcript(text):
    """Two short banner lines from the 'today's episode I talk about X' sentence, else a fallback."""
    m = re.search(r"talk(?:ing)?\s+(?:all\s+)?about\s+(.{12,160}?)(?:[.,;]|\s+so\b|\s+and\b|\s+which\b|$)", text, re.I)
    if not m: return "DIARY OF A|RUNPRENEUR"
    words = m.group(1).strip().split()
    words = [w for w in words if w.lower() not in ("how", "you", "can", "your", "the", "a", "an", "to", "of")][:7] or words[:6]
    mid = (len(words) + 1) // 2
    return " ".join(words[:mid]).upper() + "|" + " ".join(words[mid:]).upper()


def record_updates(day, links, transcript, reason, clip_name):
    fields = {"Transcription": transcript, "Record Status": STATUS_DONE,
              "Notes": "360 lane rendered %s from %s. %s" % (dt.date.today().isoformat(), clip_name, reason)}
    if links.get("full"): fields["Video Edited URL"] = links["full"]; fields["Subtitled Video URL"] = links["full"]
    if links.get("lfmd"): fields["Reframed Video URL"] = links["lfmd"]
    if links.get("summary"): fields["Summary Video URL"] = links["summary"]
    return fields


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


def render_masters(clip, workdir):
    out = {}
    for aspect, args in RECIPE.items():
        dest = os.path.join(workdir, "master_%s.mp4" % aspect.replace(":", "x"))
        subprocess.run([sys.executable, os.path.join(HERE, "stab.py"), "render", clip, dest, "--map", "z-yx"] + args,
                       check=True, stdout=subprocess.DEVNULL)
        out[aspect] = dest
    return out


def build_outputs(masters, srt, day, title, workdir):
    ov = os.path.join(HERE, "overlays.py")
    caps = os.path.join(workdir, "captions.srt")
    subprocess.run([sys.executable, ov, "captions", srt, caps], check=True, stdout=subprocess.DEVNULL)
    names = output_names(day); paths = {}
    paths["full"] = os.path.join(workdir, names["full"])
    subprocess.run([sys.executable, ov, "full", masters["16:9"], caps, paths["full"]], check=True, stdout=subprocess.DEVNULL)
    paths["lfmd"] = os.path.join(workdir, names["lfmd"])
    subprocess.run([sys.executable, ov, "lfmd", masters["9:16"], caps, paths["lfmd"], "--day", str(day)], check=True, stdout=subprocess.DEVNULL)
    paths["summary"] = os.path.join(workdir, names["summary"])
    subprocess.run([sys.executable, ov, "summary", masters["9:16"], caps, paths["summary"], "--day", str(day), "--title", title],
                   check=True, stdout=subprocess.DEVNULL)
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
    masters = render_masters(clip, workdir)
    title = title_from_transcript(text)
    paths = build_outputs(masters, srt, day, title, workdir)
    folder, links = publish_to_drive(paths, day, os.path.join(workdir, "transcript.txt"))
    rid, how = find_or_create_record(day, e.get("drive_id"), key, dt.date.fromisoformat(e["date"]))
    watch._airtable("PATCH", watch.API + "/" + rid, {"fields": record_updates(day, links, text, reason, key)})
    e.update({"status": "rendered", "record_id": rid, "outputs": links, "edited_folder": folder, "title": title,
              "render_seconds": round(time.time() - t0), "rendered": dt.datetime.now().isoformat(timespec="seconds")})
    if not keep:
        os.remove(clip); shutil.rmtree(workdir, ignore_errors=True)
    watch.save_ledger(ledger)
    print("%s -> Episode %d (%s) in %d s; record %s (%s); links %s" % (key, day, reason, e["render_seconds"], rid, how,
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
    assert output_names(2225)["full"] == "Episode_2225_Full_Episode.mp4"
    t = title_from_transcript("So consecutive day, 2,225 of a diary of a Runpreneur, and today's episode I talk all about how you can record a video using a structured script to turn that video into an autonomous AI agent, which is going")
    assert "|" in t and "RECORD" in t and len(t) < 90, t
    assert title_from_transcript("nothing useful here") == "DIARY OF A|RUNPRENEUR"
    f = record_updates(2225, {"full": "u1", "lfmd": "u2", "summary": "u3"}, "text", "why", "clip")
    assert f["Video Edited URL"] == "u1" and f["Reframed Video URL"] == "u2" and f["Summary Video URL"] == "u3"
    assert f["Record Status"] == STATUS_DONE and "why" in f["Notes"]
    f2 = record_updates(2225, {"full": None}, "t", "r", "c"); assert "Video Edited URL" not in f2
    print(json.dumps({"checks": 9, "failed": []}))


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
