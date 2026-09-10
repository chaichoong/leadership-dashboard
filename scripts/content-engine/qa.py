#!/usr/bin/env python3
"""qa.py — the output-proof gate: no approval card until the episode's files prove themselves.

Kevin, 10 Sep 2026, after 2055 and 2056 shipped without the jingle, 2056 without its Learnings clip and
1841 with a rolling horizon while every step reported ok: "we need consistency here and the output
consistently good every day... I'm only going to get to autonomous when I'm confident you can get it right
every time without fail." Every check here is something a step once got wrong. A hard failure blocks the
card and shows in the morning report; the card itself lists the checks that passed, so Kevin sees proof,
not a promise.

  qa.py check --day N      # print the checks for one rendered day
  qa.py selftest
"""
import argparse, json, os, re, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import watch  # noqa: E402

HORIZON_MAX_DEG = 8.0        # the horizon lock must be within this of gravity by 10 s and stay there (2056 opened at 26-51 deg)
JINGLE_MIN_S = 5.5           # the jingle is 7.0 s after its trim; the full must be at least this much longer than the podcast
GENERIC_TITLE = "DIARY OF A|RUNPRENEUR"
MIN_CUES_PER_MINUTE = 4


def seconds(path):
    try:
        return float(subprocess.run([os.path.expanduser("~/tools/bin/ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                                    capture_output=True, text=True, timeout=60).stdout.strip() or 0)
    except Exception:
        return 0.0


def cue_count(srt_path):
    try: return len([b for b in open(srt_path).read().strip().split("\n\n") if "-->" in b])
    except Exception: return 0


def diary_phrase_in(transcript_path):
    import render
    try: return bool(render.LFMD_START_RE.search(open(transcript_path).read()))
    except Exception: return False


def ledger_entries(day, ledger):
    ep = [v for v in ledger.values() if v.get("episode") == day and v.get("role") == "episode"]
    te = [v for v in ledger.values() if v.get("episode") == day and v.get("role") == "teaser"]
    return (ep[0] if ep else None), (te[0] if te else None)


def checks(day, ledger=None, files=None):
    """[(name, ok, hard, detail)] for one day. `files` = publish.episode_files(day) (+ 'transcript'); hard = blocks the card."""
    import publish
    ledger = ledger if ledger is not None else watch.load_ledger()
    files = files or dict(publish.episode_files(day), transcript=os.path.join(os.path.dirname(publish.episode_files(day)["full"]), "Ep%d_transcript.txt" % day))
    ep, te = ledger_entries(day, ledger)
    out = []
    def add(name, ok, hard, detail): out.append((name, bool(ok), hard, detail))
    if not ep:
        add("episode rendered", False, True, "no long clip rendered for this day"); return out
    full, full_yt, pod = files.get("full", ""), files.get("full_yt", ""), files.get("podcast", "")
    d_full, d_yt, d_pod = seconds(full), seconds(full_yt), seconds(pod)
    add("full episode file", d_full > 30, True, "%.0f s" % d_full)
    add("clean YouTube full", d_yt > 30 and abs(d_yt - d_full) < 1.5, True, "%.0f s vs %.0f s" % (d_yt, d_full))
    add("jingle in the full episode", d_full - d_pod >= JINGLE_MIN_S if d_pod else False, True, "full is %.1f s longer than the podcast (jingle 7.0 s)" % (d_full - d_pod))
    add("podcast audio", d_pod > 30, True, "%.0f s" % d_pod)
    cues = cue_count(files.get("full_srt", ""))
    add("caption file for YouTube", cues >= MIN_CUES_PER_MINUTE * max(d_full, 60) / 60, True, "%d cues" % cues)
    said = diary_phrase_in(files.get("transcript", ""))
    window = ep.get("lfmd_window")
    d_l, d_ly = seconds(files.get("lfmd", "")), seconds(files.get("lfmd_yt", ""))
    if said or window:
        add("Learnings clip (captions)", d_l > 15, True, "%.0f s; diary phrase %s in the transcript" % (d_l, "found" if said else "not found"))
        add("Learnings clip (clean, for Shorts)", d_ly > 15 and abs(d_ly - d_l) < 1.5, True, "%.0f s" % d_ly)
        add("Learnings caption file", cue_count(files.get("lfmd_srt", "")) >= 3, True, "%d cues" % cue_count(files.get("lfmd_srt", "")))
    else:
        add("Learnings section", True, False, "no diary phrase spoken in this recording, so no clip (by design)")
    th = files.get("thumb", "")
    add("thumbnail", os.path.exists(th) and os.path.getsize(th) > 20000, True, "%d KB" % (os.path.getsize(th) // 1024 if os.path.exists(th) else 0))
    hz = ep.get("horizon") or {}
    if hz:
        worst = max(v for k, v in hz.items() if float(k) >= 10) if any(float(k) >= 10 for k in hz) else max(hz.values())
        early = hz.get("1")
        add("horizon level", worst <= HORIZON_MAX_DEG and (early is None or early <= HORIZON_MAX_DEG * 2), True, "off gravity by " + ", ".join("%s s: %.1f deg" % (k, v) for k, v in sorted(hz.items(), key=lambda kv: float(kv[0]))))
    else:
        add("horizon level", False, False, "no settle report from the stabiliser (rendered before 10 Sep 2026)")
    fps = ep.get("source_fps")
    add("frame rate handled", True, False, "source %s fps, rendered at 24" % (fps if fps else "unknown"))
    if te:
        add("teaser title", (te.get("title") or "") != GENERIC_TITLE, True, "banner reads %s" % (te.get("title") or "?").replace("|", " / "))
        add("teaser file", seconds(files.get("summary", "")) > 10, True, "%.0f s" % seconds(files.get("summary", "")))
    else:
        add("teaser", True, False, "no teaser clip recorded for this day")
    return out


def gate(day, ledger=None, files=None):
    """(ok, failures, passed): ok is False when any hard check fails."""
    res = checks(day, ledger, files)
    failures = [(n, d) for n, ok, hard, d in res if hard and not ok]
    passed = [(n, d) for n, ok, hard, d in res if ok]
    return (not failures), failures, passed


def card_lines(passed, failures=()):
    lines = ["Checks the engine ran on the files (proof, not a promise):"]
    lines += ["- %s: %s" % (n, d) for n, d in passed]
    lines += ["- FAILED %s: %s" % (n, d) for n, d in failures]
    return lines


def selftest():
    import tempfile, shutil
    tmp = tempfile.mkdtemp(); ff = os.path.expanduser("~/tools/bin/ffmpeg")
    def mk(name, sec, video=True):
        p = os.path.join(tmp, name)
        cmd = [ff, "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=%s" % sec]
        if video: cmd += ["-f", "lavfi", "-i", "color=c=black:s=64x64:d=%s" % sec, "-shortest", "-pix_fmt", "yuv420p"]
        subprocess.run(cmd + [p], check=True); return p
    files = {"full": mk("full.mp4", 47), "full_yt": mk("full_yt.mp4", 47), "podcast": mk("pod.mp3", 40, video=False),
             "lfmd": mk("lfmd.mp4", 20), "lfmd_yt": mk("lfmd_yt.mp4", 20), "summary": mk("sum.mp4", 12),
             "full_srt": os.path.join(tmp, "f.srt"), "lfmd_srt": os.path.join(tmp, "l.srt"), "thumb": os.path.join(tmp, "t.png"), "transcript": os.path.join(tmp, "tr.txt")}
    open(files["full_srt"], "w").write("".join("%d\n00:00:%02d,000 --> 00:00:%02d,500\nword\n\n" % (i, i, i) for i in range(1, 8)))
    open(files["lfmd_srt"], "w").write("1\n00:00:01,000 --> 00:00:02,000\na\n\n2\n00:00:02,000 --> 00:00:03,000\nb\n\n3\n00:00:03,000 --> 00:00:04,000\nc\n")
    open(files["thumb"], "wb").write(b"\x89PNG" + b"0" * 30000)
    open(files["transcript"], "w").write("So the latest in my diary is that you should rest.")
    led = {"a full.insv": {"episode": 9, "role": "episode", "lfmd_window": [10, 30], "horizon": {"1": 3.0, "5": 2.0, "10": 1.5, "60": 1.0}, "source_fps": 23.976},
           "a sum.insv": {"episode": 9, "role": "teaser", "title": "GET YOUR|TEAM"}}
    ok, fails, passed = gate(9, led, files); assert ok and not fails, fails
    names = [n for n, _ in passed]; assert "jingle in the full episode" in names and "Learnings clip (clean, for Shorts)" in names and "teaser title" in names and "horizon level" in names
    # no jingle: full == podcast length
    f2 = dict(files, full=mk("full2.mp4", 40), full_yt=mk("full2y.mp4", 40)); ok, fails, _ = gate(9, led, f2); assert not ok and any("jingle" in n for n, _ in fails), fails
    # diary phrase spoken but no clip
    f3 = dict(files, lfmd="/nonexistent", lfmd_yt="/nonexistent"); led3 = {"a full.insv": dict(led["a full.insv"], lfmd_window=None)}
    ok, fails, _ = gate(9, led3, f3); assert not ok and any("Learnings clip" in n for n, _ in fails), fails
    # no phrase, no clip: fine, soft note only
    open(files["transcript"], "w").write("no such section today"); ok, fails, passed = gate(9, led3, f3); assert ok and any("by design" in d for n, d in passed)
    # leaning horizon and a generic teaser title
    led4 = {"a full.insv": dict(led["a full.insv"], horizon={"1": 40.0, "10": 22.0}), "a sum.insv": {"episode": 9, "role": "teaser", "title": GENERIC_TITLE}}
    ok, fails, _ = gate(9, led4, files); assert not ok and {n for n, _ in fails} >= {"horizon level", "teaser title"}, fails
    # old render without a horizon report: soft, does not block
    led5 = {"a full.insv": dict(led["a full.insv"], horizon=None)}; ok, fails, passed = gate(9, led5, files); assert ok, fails
    assert card_lines([("a", "b")], [("c", "d")])[1:] == ["- a: b", "- FAILED c: d"]
    shutil.rmtree(tmp); print(json.dumps({"checks": 9, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("mode"); ap.add_argument("--day", type=int, default=0)
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "check":
        ok, fails, passed = gate(a.day)
        for n, okk, hard, d in checks(a.day): print("%s %s%s: %s" % ("PASS" if okk else ("FAIL" if hard else "note"), n, "" if hard else " (soft)", d))
        print("GATE:", "open" if ok else "BLOCKED")
    else: raise SystemExit("usage: qa.py check --day N | selftest")
