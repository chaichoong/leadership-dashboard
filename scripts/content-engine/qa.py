#!/usr/bin/env python3
"""qa.py — the output-proof gate: no approval card until the episode's files prove themselves.

Kevin, 10 Sep 2026, after 2055 and 2056 shipped without the jingle, 2056 without its Learnings clip and
1841 with a rolling horizon while every step reported ok: "we need consistency here and the output
consistently good every day... I'm only going to get to autonomous when I'm confident you can get it right
every time without fail." Every check here is something a step once got wrong. A hard failure blocks the
card and shows in the morning report; the card itself lists the checks that passed, so Kevin sees proof,
not a promise.

  qa.py check --day N      # print the checks for one rendered day
  qa.py accept-early --day N   # an early Learnings clip has been watched and IS the diary section
  qa.py accept-no-learnings --day N   # a held episode has been watched and really has no Learnings section
  qa.py selftest
"""
import argparse, datetime as dt, json, math, os, re, subprocess, sys, time
HERE =os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import watch  # noqa: E402

HORIZON_MAX_DEG = 8.0        # the horizon lock must be within this of gravity by 10 s and stay there (2056 opened at 26-51 deg)
JINGLE_MIN_S = 5.5           # the jingle is 7.0 s after its trim; the full must be at least this much longer than the podcast
GENERIC_TITLE = "DIARY OF A|RUNPRENEUR"
WAIT_CHECK = "files readable"      # the one check whose failure means "try again", never "this episode is bad"
MIN_CUES_PER_MINUTE = 4
# The diary section closes the episode. Across the 33 episodes on the ledger with a clip (2 Oct 2026) it starts between
# 54% and 81% of the way in, except 2081: cut from an aside at 14%, it reached Kevin's card ("you've clipped the wrong
# section"). A clip starting before this share of the episode is refused until someone has looked (accept-early).
LFMD_EARLIEST_START = 0.40


UNREADABLE_TRIES, UNREADABLE_WAIT = 5, 15
FRESH_MINUTES = 30        # a file written this recently and not readable is the mount catching up, not a bad render


def fresh(path, minutes=FRESH_MINUTES):
    try: return (time.time() - os.path.getmtime(path)) < minutes * 60
    except OSError: return False


def seconds(path, tries=None, wait=None, sleep=time.sleep):
    """Length in seconds. 0.0 when the file is not there at all, None when it is there and cannot be read yet.

    15 Sep 2026: the render uploads its outputs to Drive by API and the MOUNT lags behind, so at 22:24 ffprobe
    read 0 s on a 591 MB file that measured 465 s the next morning. A zero read on a file with bytes is the
    mount catching up, never a zero-length episode, so it is retried and then reported as unknown. The gate
    holds the card and tries again; it never fails an episode on a read it could not make."""
    tries = UNREADABLE_TRIES if tries is None else tries
    wait = UNREADABLE_WAIT if wait is None else wait
    if not fresh(path): tries = 1          # an old file that will not read is not waiting on Drive; do not stall the gate
    for n in range(max(1, tries)):
        try:
            out = subprocess.run([os.path.expanduser("~/tools/bin/ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                                 capture_output=True, text=True, timeout=60).stdout.strip()
            if out and float(out) > 0: return float(out)
        except Exception:
            pass
        if not (os.path.exists(path) and os.path.getsize(path) > 0): return 0.0
        if n < tries - 1: sleep(wait)
    return None


def cue_count(srt_path):
    try: return len([b for b in open(srt_path).read().strip().split("\n\n") if "-->" in b])
    except Exception: return 0


def diary_phrase_in(transcript_path):
    import render
    try: return render.lfmd_said(open(transcript_path).read())     # the show's name never counts (2072, 27 Sep 2026)
    except Exception: return False


def caption_text(srt_path):
    """The episode's words from its own caption file, '' when it cannot be read. Only the long clip writes that file
    and it reaches the gate through the Drive API copy, so it is the episode's text on the days whose stored
    transcript is the teaser's (26 of 36 on 2 Oct 2026) and when the Drive folder has not caught up with an upload."""
    import render
    try: return " ".join(t for _, _, t in render.srt_segments(open(srt_path).read()))
    except Exception: return ""


FPS_TOLERANCE = 0.05         # 29.97 probes as 29.97 either side; anything beyond this is a resample


def frame_rate_check(ep):
    """(ok, hard, detail) for 'frame rate held': the delivered episode must come out at the rate it went in at.

    Findings 20261016-phase-3-937, 20261017-phase-3-960, 20261023-phase-3-1052 and 20261025-phase-3-1075. Kevin
    reported the same thing four times: stabilisation was good around the 2080s episodes and has got jolty since.
    The cause was a forced 24 fps output on 29.97 fps clips, which drops frames on an uneven 5:4 cadence. 2099,
    2100 and 2106 all shipped that way and all passed this gate, because the line here was a hardcoded True that
    ASSERTED "rendered at 24" instead of measuring anything. A quality regression no check measures is a
    regression nobody finds until Kevin watches it.

    A day with no measurement is NOT a pass dressed up as one: it says it was not measured, and stays soft, the
    way the horizon report does for days rendered before the stabiliser wrote one."""
    src, out = ep.get("source_fps"), ep.get("render_fps")
    if not src and not out:
        return False, False, "not measured (rendered before 1 Nov 2026)"
    if not out:
        return False, False, "source %s fps; the delivered rate was NOT measured, so a resample cannot be ruled out" % src
    if not src:
        return False, False, "delivered at %s fps; the source rate was NOT measured, so a resample cannot be ruled out" % out
    gap = abs(float(out) - float(src))
    return (gap <= FPS_TOLERANCE, True,
            "source %s fps, delivered %s fps%s" % (src, out, "" if gap <= FPS_TOLERANCE else
                                                   " — resampled by %.3f fps, which reads as stabilisation judder" % gap))


def ledger_entries(day, ledger):
    """(episode entry, teaser entry) for the day, the RENDERED one of each when there is one. A second recording of
    the day that failed ("a second long recording for episode 2108 ... not rendered") keeps the same episode and role
    on the ledger, and on 2107, 2108 and 2109 it comes first, so the gate read the failed entry's empty Learnings
    window and missing horizon instead of the episode's own (found 16 Nov 2026 building the Learnings hold)."""
    ep = [v for v in ledger.values() if v.get("episode") == day and v.get("role") == "episode"]
    te = [v for v in ledger.values() if v.get("episode") == day and v.get("role") == "teaser"]
    pick = lambda xs: next((v for v in xs if v.get("status") == "rendered"), xs[0] if xs else None)
    return pick(ep), pick(te)


def mmss(seconds_in):
    return "%d:%02d" % divmod(int(round(seconds_in)), 60)


def accept_early(day, ledger=None, save=None):
    """Someone has watched it: this day's early Learnings clip IS the diary section. What is accepted is the window
    itself, and every render or Learnings rebuild drops the acceptance (render.py), so a clip cut again is watched again."""
    ledger = ledger if ledger is not None else watch.load_ledger()
    ep, _ = ledger_entries(day, ledger)
    window = ep.get("lfmd_window") if ep else None
    if not (isinstance(window, (list, tuple)) and len(window) == 2): raise SystemExit("episode %d has no Learnings clip to accept" % day)
    if ep.get("status") != "rendered": raise SystemExit("episode %d is waiting to render again (%s): accept its clip once that has run" % (day, ep.get("status")))
    ep["lfmd_early_ok"] = list(window)
    (save or watch.save_ledger)(ledger)
    return ep["lfmd_early_ok"]


def accept_no_learnings(day, ledger=None, save=None, today=None):
    """Someone has watched it: this episode really has no Learnings from my diary section. Lifts the hold below for
    this render only; every render or Learnings rebuild drops it (render.py), so a clip cut again is judged again."""
    ledger = ledger if ledger is not None else watch.load_ledger()
    ep, _ = ledger_entries(day, ledger)
    if not ep: raise SystemExit("episode %d has no long clip on the ledger" % day)
    if ep.get("lfmd_window"): raise SystemExit("episode %d has a Learnings clip, so there is nothing to accept" % day)
    if ep.get("status") != "rendered": raise SystemExit("episode %d is waiting to render again (%s): judge it once that has run" % (day, ep.get("status")))
    ep["lfmd_none_ok"] = (today or dt.date.today()).isoformat()
    (save or watch.save_ledger)(ledger)
    return ep["lfmd_none_ok"]


SIGNOFF_FROM = 0.5     # a sign-off this far into the talk or later closes it; "stay positive" said early on does not


def signoff_at(srt_path):
    """Seconds into the full episode where his sign-off ("thank you as always", "stay positive", "see you tomorrow")
    closes the talk, read off the episode's own captions, or None when none is said there (or only in the first half).
    Raises ValueError naming the file when the captions cannot be read: an unread file is never "no sign-off"."""
    import render
    try: segs = render.srt_segments(open(srt_path).read())
    except (OSError, ValueError, IndexError) as ex: raise ValueError("captions %r could not be read (%s)" % (srt_path, ex))
    if not segs: raise ValueError("captions %r hold no cues" % srt_path)
    late = [a for a, _, t in segs if render.SIGNOFF_RE.search(t) and a >= SIGNOFF_FROM * segs[-1][1]]
    return late[0] if late else None


def no_learnings_check(ep, srt_path, day):
    """(ok, hard, detail) for a long episode with no Learnings clip, no diary line heard and no near miss.

    Kevin's rule (9 Sep 2026, lessons sort line 34): he says the line in almost every episode, so no clip found
    means hold the card. Until 16 Nov 2026 this passed as "by design", and 2086, 2087, 2095, 2096, 2097, 2122,
    2130, 2132 and 1799 each reached him with no clip and came back. NARROWED by the back-test: a recording that
    stops before his sign-off (2082, 2183: the camera cut out mid-sentence) may really have no section, and 2082
    was approved as it was, so it is a note on the card, not a hold. A talk that runs on to his sign-off with no
    clip is held, until someone finds the section or rules there is none (accept-no-learnings)."""
    if ep.get("lfmd_none_ok"):
        return True, False, "no Learnings section: watched, and accepted by hand on %s that there is none" % ep["lfmd_none_ok"]
    try: end = signoff_at(srt_path)
    except ValueError as ex:
        # the caption-file check above refuses the card on the same file; this line only says what could not be judged
        return False, False, "NOT CHECKED: no clip was cut and no diary line was heard, and %s, so whether the talk reaches your sign-off is unknown" % ex
    if end is None:
        return True, False, ("no diary phrase heard, and the recording ends before your sign-off (it may have been cut short), "
                             "so no clip (by design); the card asks you to check")
    return False, True, ("no clip was cut and no diary line was heard, but the talk runs on to your sign-off at %s of the full "
                         "episode, and you say the Learnings line before it in almost every episode: it is most likely there in "
                         "words the finder cannot hear (2086, 2095, 2122). Find it in the captions and rebuild it "
                         "(render.py redo --day %d --only lfmd --window START-END). If it has been watched and there is none: "
                         "qa.py accept-no-learnings --day %d" % (mmss(end), day, day))


def summary_search(ep, ledger):
    """The card line for a long episode with no Summary clip: where the engine looked and what it found there.

    Kevin, 5 Oct 2026 (2090): "It's very seldom I'd forget to do that... check the raw footage for the day this was
    recorded and the day after." The summary is sometimes recorded the next morning (2071, 2072). Until 16 Nov 2026
    the card said only "no teaser clip recorded for this day". Every clip the watcher has seen is on the ledger with
    its date and folder, so this names the folders searched and every short or unmeasured clip on either day."""
    import render
    try: d0 = dt.date.fromisoformat(str(ep.get("date")))
    except ValueError:
        return "NO SUMMARY FOUND, and the recording date is not on the ledger (%r), so no other day was searched" % ep.get("date")
    days = [d0, d0 + dt.timedelta(days=1)]
    on = [v for v in ledger.values() if v is not ep and v.get("date") in (days[0].isoformat(), days[1].isoformat())]
    folders = sorted({os.path.basename(os.path.dirname(v.get("path") or "")) for v in on + [ep]} - {""})
    def short(v):
        try: return float(v["duration"]) <= render.TEASER_MAX_SECONDS
        except (KeyError, TypeError, ValueError): return True      # not pulled yet: unmeasured, so it is listed
    def what(v):
        d = dt.date.fromisoformat(v["date"]).strftime("%-d %b")
        try: size = "%.0f s" % float(v["duration"]) if v.get("duration") is not None else "not pulled yet, %.1f GB" % (float(v.get("size") or 0) / 1e9)
        except (TypeError, ValueError): size = "length on the ledger unreadable (%r)" % v.get("duration")
        role = (" %s of %s" % (v["role"], v.get("episode"))) if v.get("role") and v.get("episode") else ""
        return "%s (%s, %s, %s%s)" % (v.get("name") or "?", d, size, v.get("status") or "?", role)
    cands = sorted((v for v in on if short(v)), key=lambda v: (v.get("date"), v.get("hms") or ""))
    where = "looked in %s for %s and %s" % (" and ".join(folders) or "the ledger (no folder recorded)",
                                            days[0].strftime("%-d %b"), days[1].strftime("%-d %b"))
    if not any(v.get("date") == days[1].isoformat() for v in ledger.values()):
        where += " (nothing recorded on %s is on the ledger yet)" % days[1].strftime("%-d %b")
    if not cands: return "NO SUMMARY FOUND: %s; no other short clip was recorded on either day" % where
    return "NO SUMMARY FOUND: %s; short clips there: %s" % (where, "; ".join(what(v) for v in cands))


def lfmd_position(ep, podcast_seconds, day):
    """(ok, hard, detail) for where the Learnings clip starts. Measured against the clip length the render recorded;
    the podcast (the episode without its jingle) stands in when a render recorded none, so the check is never skipped
    for want of a number. When the render recorded that the clip runs to his sign-off with nothing said after it
    (render.lfmd_closes_talk), the sign-off is the measure: a recording left running is not more episode. Ledger
    values that cannot be read refuse the card: they never stop the night's other cards."""
    window, by_hand = ep.get("lfmd_window"), ep.get("lfmd_early_ok")
    try:
        if not (isinstance(window, (list, tuple)) and len(window) == 2) or isinstance(ep.get("duration"), bool): raise ValueError
        start, end, length = float(window[0]), float(window[1]), float(ep.get("duration") or 0) or float(podcast_seconds or 0)
        if not (math.isfinite(start) and math.isfinite(end) and math.isfinite(length) and 0 <= start <= length and length > 0): raise ValueError
    except (TypeError, ValueError, OverflowError):
        return False, True, "cannot be checked: the ledger holds window %r and length %r for this episode. Put the entry right, or rebuild the clip: render.py redo --day %d --only lfmd" % (window, ep.get("duration"), day)
    noun = "episode"
    if ep.get("lfmd_closes_talk") is True and start < end < length: length, noun = end, "talk"
    share = start / length
    where = "starts at %s of the %s %s (%d%%)" % (mmss(start), mmss(length), noun, int(share * 100 + 1e-9))
    # THE SPOKEN PHRASE DECIDES, NOT THE SHARE (finding 20261019-phase-3-983). The share rule below is a proxy for
    # "the diary section closes the episode", and it blocks a correct clip whenever Kevin reaches his diary early:
    # 1808's clip starts at 4:30 of an 11:30 episode (39%, just under the 40% rule) and sat blocked with no card,
    # and 2112 came back with "I think you might have a rule where you...". When render.py matched the start ON the
    # spoken phrase (render.lfmd_phrase, stored as lfmd_phrase), that match IS the evidence the clip is the diary
    # section, and a percentage cannot overrule it. The share rule still judges a window with no phrase recorded:
    # one read off the captions by hand, and every episode rendered before 19 Oct 2026.
    phrase = ep.get("lfmd_phrase")
    if isinstance(phrase, str) and phrase.strip():
        return True, True, where + ', matched on what he says: "%s"' % " ".join(phrase.split())[:80]
    # A window the DETECTOR placed is a phrase match too, even on a clip cut before lfmd_phrase was recorded:
    # render.lfmd_window only ever returns a window it found by matching LFMD_START_RE and passing is_diary_line.
    # This is what lets episode 1808 — blocked since 17 Oct at 39%, detector-placed — reach its card without a
    # re-render. An episode with no lfmd_window_by at all (rendered before that field) keeps the share rule.
    if ep.get("lfmd_window_by") == "detector":
        return True, True, where + ", placed by the clip finder on the spoken phrase"
    # Kevin's own time is evidence too (16 Nov 2026): a clip placed where his note said it starts (render.note_record)
    # passes on that, or his 4:30 on 1808, at 39% of the episode, would be refused by the share rule below.
    note = ep.get("lfmd_from_note") if isinstance(ep.get("lfmd_from_note"), dict) else {}
    try: from_note = [float(x) for x in note.get("window") or []] == [start, end]; said = mmss(float(note.get("full")))
    except (TypeError, ValueError): from_note = False          # a record that cannot be read is no evidence: the share rule judges
    if from_note:
        return True, True, where + ", placed at the time on your note (%s of the full episode)" % said
    if share >= LFMD_EARLIEST_START: return True, True, where
    if isinstance(by_hand, (list, tuple)) and list(by_hand) == list(window): return True, True, where + ", accepted by hand as the diary section"
    return False, True, ("%s, and no spoken phrase was matched for it (lfmd_phrase is empty, so this clip was cut before "
                         "19 Oct 2026 or its window was placed by hand). The diary section closes the episode, so this is "
                         "probably the wrong part (2081, 1 Oct 2026). Rebuild it: render.py redo --day %d --only lfmd. "
                         "If the clip is right: qa.py accept-early --day %d") % (where, day, day)


def checks(day, ledger=None, files=None):
    """[(name, ok, hard, detail)] for one day. `files` = publish.episode_files(day) (+ 'transcript'); hard = blocks the card."""
    import publish, render
    ledger = ledger if ledger is not None else watch.load_ledger()
    if not files:
        # 17 Sep 2026: the scheduled job read "0 s" for 2059 and 2060 through the Drive folder at 01:25 and 08:16, while
        # the same files measured 575 s from a session at 08:25. The measured files come through publish.fetch_readable
        # (the Drive API copy when the folder does not read), which the publisher then uses as they are.
        base = publish.episode_files(day)
        files = dict(base, transcript=os.path.join(os.path.dirname(base["full"]), render.transcript_name(day)))
        for k in ("full", "full_yt", "podcast", "lfmd", "lfmd_yt", "full_srt", "lfmd_srt", "thumb", "summary"):
            try: files[k] = publish.fetch_readable(day, k, ledger)
            except (Exception, SystemExit) as ex: print("qa: %s for day %d not fetched (%s)" % (k, day, str(ex)[-100:]), file=sys.stderr)
    ep, te = ledger_entries(day, ledger)
    out = []
    def add(name, ok, hard, detail): out.append((name, bool(ok), hard, detail))
    if not ep:
        add("episode rendered", False, True, "no long clip rendered for this day"); return out
    full, full_yt, pod = files.get("full", ""), files.get("full_yt", ""), files.get("podcast", "")
    d_full, d_yt, d_pod = seconds(full), seconds(full_yt), seconds(pod)
    d_l0, d_ly0 = seconds(files.get("lfmd", "")), seconds(files.get("lfmd_yt", ""))
    pairs = (("full episode", d_full, full), ("clean YouTube full", d_yt, full_yt), ("podcast", d_pod, pod),
             ("Learnings clip", d_l0, files.get("lfmd", "")), ("clean Learnings clip", d_ly0, files.get("lfmd_yt", "")))
    stale = [n for n, d, p in pairs if d is None and not fresh(p)]
    if stale:
        # written long ago and still unreadable: that is a broken file, and it IS a refusal
        add("files readable", False, True, "%s: on disk but unreadable (corrupt render)" % ", ".join(stale)); return out
    unreadable = [n for n, d, p in pairs if d is None]
    if unreadable:
        # NOT a failure: the files are on Drive and this Mac cannot read them yet. The card is held, not refused.
        add(WAIT_CHECK, False, "wait", "%s: written to Drive, not readable from this Mac yet (the mount lags an upload). The card is raised as soon as they read." % ", ".join(unreadable))
        return out
    add("full episode file", d_full > 30, True, "%.0f s" % d_full)
    add("clean YouTube full", d_yt > 30 and abs(d_yt - d_full) < 1.5, True, "%.0f s vs %.0f s" % (d_yt, d_full))
    add("jingle in the full episode", d_full - d_pod >= JINGLE_MIN_S if d_pod else False, True, "full is %.1f s longer than the podcast (jingle 7.0 s)" % (d_full - d_pod))
    # Where the jingle went, and whose number put it there. 2100 bounced three nights and 2113 once more with a
    # figure in the note that nothing acted on, so the card now says plainly which it used.
    if ep.get("intro_at") is not None:
        by = ep.get("intro_at_by")
        add("jingle position", True, False, "at %s (%s)" % (mmss(ep["intro_at"]),
            "the figure on your card" if by == "operator" else "found by the pause detector" if by == "detector" else "provenance not recorded"))
    add("podcast audio", d_pod > 30, True, "%.0f s" % d_pod)
    cues = cue_count(files.get("full_srt", ""))
    add("caption file for YouTube", cues >= MIN_CUES_PER_MINUTE * max(d_full, 60) / 60, True, "%d cues" % cues)
    # "Did he say the diary line?" is asked of the episode's transcript AND its captions (2 Oct 2026): the transcript
    # alone was the teaser's on 26 stored days and is read through the Drive folder, which lags an upload.
    cap_text = caption_text(files.get("full_srt", ""))
    in_transcript = diary_phrase_in(files.get("transcript", ""))
    said = in_transcript or render.lfmd_said(cap_text)
    window = ep.get("lfmd_window")
    d_l, d_ly = d_l0, d_ly0
    near_miss = None
    if not (in_transcript or window):
        # 2060 (17 Sep 2026): the Learnings line was mis-heard, no clip was cut, and the card went up saying "no diary
        # phrase spoken (by design)". A near miss now REFUSES the card, so a Learnings section is never lost silently.
        m = render.DIARY_NEAR_MISS_RE.search(cap_text)
        if m: near_miss = cap_text[max(0, m.start() - 30):m.end() + 30]
    if near_miss:
        add("Learnings section", False, True, "no clip was cut, but the captions say '...%s...': that sounds like the diary section. Rebuild it (render.py redo --day %d --only lfmd) before this card goes up" % (near_miss.strip(), day))
    elif said or window:
        heard = "found in the transcript" if in_transcript else "found in the captions" if said else "not found in the transcript or the captions"
        add("Learnings clip (captions)", d_l > 15, True, "%.0f s; diary phrase %s" % (d_l, heard))
        add("Learnings clip (clean, for Shorts)", d_ly > 15 and abs(d_ly - d_l) < 1.5, True, "%.0f s" % d_ly)
        add("Learnings caption file", cue_count(files.get("lfmd_srt", "")) >= 3, True, "%d cues" % cue_count(files.get("lfmd_srt", "")))
        if window: add("Learnings clip position", *lfmd_position(ep, d_pod, day))
    else:
        add("Learnings section", *no_learnings_check(ep, files.get("full_srt", ""), day))
    th = files.get("thumb", "")
    add("thumbnail", os.path.exists(th) and os.path.getsize(th) > 20000, True, "%d KB" % (os.path.getsize(th) // 1024 if os.path.exists(th) else 0))
    hz = ep.get("horizon") or {}
    if hz:
        worst = max(v for k, v in hz.items() if float(k) >= 10) if any(float(k) >= 10 for k in hz) else max(hz.values())
        early = hz.get("1")
        add("horizon level", worst <= HORIZON_MAX_DEG and (early is None or early <= HORIZON_MAX_DEG * 2), True, "off gravity by " + ", ".join("%s s: %.1f deg" % (k, v) for k, v in sorted(hz.items(), key=lambda kv: float(kv[0]))))
    else:
        add("horizon level", False, False, "no settle report from the stabiliser (rendered before 10 Sep 2026)")
    add("frame rate held", *frame_rate_check(ep))
    if te:
        add("teaser title", (te.get("title") or "") != GENERIC_TITLE, True, "banner reads %s" % (te.get("title") or "?").replace("|", " / "))
        add("teaser file", seconds(files.get("summary", "")) > 10, True, "%.0f s" % seconds(files.get("summary", "")))
    else:
        add("teaser", True, False, summary_search(ep, ledger))
    return out


def gate(day, ledger=None, files=None):
    """(ok, failures, passed): ok is False when any hard check fails, or when the files cannot be read yet."""
    res = checks(day, ledger, files)
    failures = [(n, d) for n, ok, hard, d in res if hard and not ok]
    passed = [(n, d) for n, ok, hard, d in res if ok]
    return (not failures), failures, passed


def is_wait(failures):
    """True when the only thing stopping the card is a read this Mac could not make yet."""
    return bool(failures) and all(n == WAIT_CHECK for n, _ in failures)


def card_lines(passed, failures=()):
    lines = ["Checks the engine ran on the files (proof, not a promise):"]
    lines += ["- %s: %s" % (n, d) for n, d in passed]
    lines += ["- FAILED %s: %s" % (n, d) for n, d in failures]
    return lines


def _selftest_unreadable():
    """15 Sep 2026, reproduced: the file is on Drive, this Mac cannot read it yet, and the gate used to call that
    a zero-length episode and refuse the card for a whole day."""
    import tempfile
    tmp = tempfile.mkdtemp()
    junk = os.path.join(tmp, "Episode_9999_Full_Episode.mp4")
    open(junk, "wb").write(b"\x00" * 200000)           # bytes on disk, nothing ffprobe can read: exactly the mount's lag
    naps = []
    assert seconds(junk, tries=3, wait=7, sleep=naps.append) is None, "an unreadable file with bytes is unknown, never 0 s"
    assert naps == [7, 7], "it waits and tries again before giving up"
    old = os.path.join(tmp, "old.mp4"); open(old, "wb").write(b"\x00" * 1000)
    os.utime(old, (time.time() - 7200, time.time() - 7200))
    naps2 = []
    assert seconds(old, tries=3, wait=7, sleep=naps2.append) is None and naps2 == [], "an old unreadable file is not waited on"
    assert seconds(os.path.join(tmp, "not-there.mp4"), tries=2, sleep=naps.append) == 0.0, "a file that is not there is 0 s"
    files = {"full": junk, "full_yt": junk, "podcast": junk, "lfmd": "", "lfmd_yt": "", "summary": "",
             "full_srt": "", "lfmd_srt": "", "thumb": "", "transcript": ""}
    globals()["UNREADABLE_TRIES"] = 1
    try:
        res = checks(2057, {"c": {"episode": 2057, "role": "episode"}}, files)
        ok, failures, passed = gate(2057, {"c": {"episode": 2057, "role": "episode"}}, files)
    finally:
        globals()["UNREADABLE_TRIES"] = 5
    assert [r[0] for r in res] == [WAIT_CHECK] and not ok, res
    os.utime(junk, (time.time() - 7200, time.time() - 7200))
    res_old = checks(2057, {"c": {"episode": 2057, "role": "episode"}}, files)
    assert res_old[0][0] == "files readable" and res_old[0][2] is True, "a file unreadable hours after the render is a real refusal"
    os.utime(junk, None)
    assert is_wait(failures) and "not readable from this Mac yet" in failures[0][1], failures
    assert not is_wait([("full episode file", "0 s")]), "a real fault is still a refusal"
    import shutil as _sh; _sh.rmtree(tmp)


def selftest():
    _selftest_unreadable()
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
    led = {"a full.insv": {"episode": 9, "role": "episode", "lfmd_window": [20, 40], "duration": 40.0, "horizon": {"1": 3.0, "5": 2.0, "10": 1.5, "60": 1.0}, "source_fps": 23.976},
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
    # 2060 (17 Sep 2026): a mis-heard Learnings line in the captions, no clip cut -> the card is REFUSED, never "by design"
    miss_srt = os.path.join(tmp, "miss.srt")
    open(miss_srt, "w").write("1\n00:00:01,000 --> 00:00:02,000\nSo I suppose the learning from\n\n2\n00:00:02,000 --> 00:00:03,000\na diet today is that problems\n\n"
                              + "".join("%d\n00:00:%02d,000 --> 00:00:%02d,500\nword\n\n" % (i, i, i) for i in range(3, 9)))
    ok, fails, _ = gate(9, led3, dict(f3, full_srt=miss_srt))
    assert not ok and any(n == "Learnings section" and "sounds like the diary section" in d for n, d in fails), fails
    # leaning horizon and a generic teaser title
    led4 = {"a full.insv": dict(led["a full.insv"], horizon={"1": 40.0, "10": 22.0}), "a sum.insv": {"episode": 9, "role": "teaser", "title": GENERIC_TITLE}}
    ok, fails, _ = gate(9, led4, files); assert not ok and {n for n, _ in fails} >= {"horizon level", "teaser title"}, fails
    # old render without a horizon report: soft, does not block
    led5 = {"a full.insv": dict(led["a full.insv"], horizon=None)}; ok, fails, passed = gate(9, led5, files); assert ok, fails
    # 2081 (1 Oct 2026): a Learnings clip cut from the first part of the episode is refused until someone has watched it
    led6 = {"a full.insv": dict(led["a full.insv"], lfmd_window=[5, 25])}; ok, fails, _ = gate(9, led6, files)
    assert not ok and [n for n, _ in fails] == ["Learnings clip position"] and "(12%)" in fails[0][1], fails
    led6["a full.insv"]["lfmd_early_ok"] = [5, 25]; ok, fails, _ = gate(9, led6, files); assert ok, fails
    # 1808 / 2112 (finding 20261019-phase-3-983): an early clip the FINDER matched on the spoken phrase passes on the
    # phrase, not on its share of the episode. 1808's real numbers were 4:30 of 11:30 (39%), one point under the 40%
    # rule, and its card never appeared. Back-test by deleting the lfmd_phrase branch in lfmd_position(): this first
    # assertion then fails with "Learnings clip position".
    led7 = {"a full.insv": dict(led["a full.insv"], lfmd_window=[5, 25], lfmd_phrase="the learnings from my diary today")}
    ok, fails, _ = gate(9, led7, files)
    assert ok, "a phrase-matched early clip passes: %s" % (fails,)
    assert any(n == "Learnings clip position" and "matched on what he says" in d for n, d in gate(9, led7, files)[2]), gate(9, led7, files)[2]
    # an empty or blank phrase is NOT a match, so the share rule still refuses the clip
    for blank in (None, "", "   "):
        led8 = {"a full.insv": dict(led["a full.insv"], lfmd_window=[5, 25], lfmd_phrase=blank)}
        assert not gate(9, led8, files)[0], "a blank phrase must not pass an early clip: %r" % blank
    # 1808 itself: cut before lfmd_phrase existed, but lfmd_window_by says the clip finder placed it, and the finder
    # only returns a window it matched on the phrase. That is what unblocks it with no re-render.
    led9 = {"a full.insv": dict(led["a full.insv"], lfmd_window=[5, 25], lfmd_window_by="detector")}
    assert gate(9, led9, files)[0], "a detector-placed early clip passes: %s" % (gate(9, led9, files)[1],)
    led10 = {"a full.insv": dict(led["a full.insv"], lfmd_window=[5, 25], lfmd_window_by="operator")}
    assert not gate(9, led10, files)[0], "a hand-placed early window is still judged on its share until someone accepts it"
    assert card_lines([("a", "b")], [("c", "d")])[1:] == ["- a: b", "- FAILED c: d"]
    # 'frame rate held' (findings 937, 960, 1052, 1075). The 29.97 -> 24 resample that made 2099, 2100 and 2106
    # jolty passed the old line because it was a hardcoded True. These drive the real check.
    assert frame_rate_check({"source_fps": 29.97, "render_fps": 29.97})[:2] == (True, True)
    assert frame_rate_check({"source_fps": 24.0, "render_fps": 23.976})[:2] == (True, True), "probe rounding is not a resample"
    bad = frame_rate_check({"source_fps": 29.97, "render_fps": 24.0})
    assert bad[0] is False and bad[1] is True and "judder" in bad[2], bad
    for part in ({"source_fps": 29.97}, {"render_fps": 29.97}, {}):
        r = frame_rate_check(part)
        assert r[0] is False and r[1] is False and "not measured" in r[2].lower(), (part, r)
    # and through the whole gate: 2106's real numbers REFUSE the card, a matched pair does not.
    led11 = {"a full.insv": dict(led["a full.insv"], source_fps=29.97, render_fps=24.0)}
    ok, fails, _ = gate(9, led11, files)
    assert not ok and [n for n, _ in fails] == ["frame rate held"], fails
    led12 = {"a full.insv": dict(led["a full.insv"], source_fps=29.97, render_fps=29.97)}
    assert gate(9, led12, files)[0], gate(9, led12, files)[1]
    # a day with no measurement is reported as unmeasured and does not block (back-test: make it hard and led's
    # own fixture, which has no render_fps, stops passing above)
    assert gate(9, led, files)[0], "an unmeasured day is held soft, not refused"
    assert any(n == "frame rate held" and "not measured" in d.lower() for n, _, _, d in checks(9, led, files)), checks(9, led, files)
    # the jingle's provenance on the card (findings 973, 1077)
    led13 = {"a full.insv": dict(led["a full.insv"], intro_at=26.0, intro_at_by="operator")}
    assert any(n == "jingle position" and "0:26" in d and "the figure on your card" in d for n, _, _, d in checks(9, led13, files))
    led14 = {"a full.insv": dict(led["a full.insv"], intro_at=33.0, intro_at_by="detector")}
    assert any(n == "jingle position" and "pause detector" in d for n, _, _, d in checks(9, led14, files))
    assert not any(n == "jingle position" for n, _, _, _ in checks(9, led, files)), "no recorded cut, no claim about one"
    _selftest_no_learnings(files, led, tmp)
    shutil.rmtree(tmp); print(json.dumps({"checks": 22, "failed": []}))


def _selftest_no_learnings(files, led, tmp):
    """16 Nov 2026, lessons sort lines 34 and 45, on invented episode data."""
    signed = os.path.join(tmp, "signed.srt")
    open(signed, "w").write("".join("%d\n00:00:%02d,000 --> 00:00:%02d,500\nsome of the talk\n\n" % (i, i, i) for i in range(1, 9))
                            + "9\n00:00:40,000 --> 00:00:41,000\nthank you as always, stay positive\n\n")
    plain = dict(led["a full.insv"], lfmd_window=None)
    nolf = dict(files, lfmd="/nonexistent", lfmd_yt="/nonexistent", full_srt=signed)
    open(files["transcript"], "w").write("no such section today")
    # the talk runs on to his sign-off and no clip was found: HELD (2086, 2095, 2122 came back with none)
    ok, fails, _ = gate(9, {"a full.insv": plain}, nolf)
    assert not ok and [n for n, _ in fails] == ["Learnings section"] and "sign-off at 0:40" in fails[0][1], fails
    # watched, and there is none: released for this render only
    ok, _, passed = gate(9, {"a full.insv": dict(plain, lfmd_none_ok="2026-11-16")}, nolf)
    assert ok and any(n == "Learnings section" and "accepted by hand" in d for n, d in passed), passed
    # a recording that stops before the sign-off may really have none (2082): a note, not a hold
    ok, _, passed = gate(9, {"a full.insv": plain}, dict(nolf, full_srt=files["full_srt"]))
    assert ok and any(n == "Learnings section" and "ends before your sign-off" in d for n, d in passed), passed
    # the release refuses a day it does not fit
    for entry, why in ((dict(plain, lfmd_window=[20, 40]), "has a Learnings clip"), (dict(plain, status="new"), "waiting to render")):
        try: accept_no_learnings(9, {"a": entry}, save=lambda l: None); raise AssertionError(why)
        except SystemExit as ex: assert why in str(ex), str(ex)
    got = {"a": dict(plain, status="rendered")}
    assert accept_no_learnings(9, got, save=lambda l: None, today=dt.date(2026, 11, 16)) == "2026-11-16" and got["a"]["lfmd_none_ok"] == "2026-11-16"
    # the rendered entry is the episode, not a failed second recording that sits first on the ledger (2107, 2108, 2109)
    two = {"a 1.insv": {"episode": 9, "role": "episode", "status": "failed"}, "a 2.insv": dict(led["a full.insv"], status="rendered")}
    assert ledger_entries(9, two)[0] is two["a 2.insv"]
    # Kevin's own time is the evidence for an early clip (1808 at 39%), as long as it is the same window
    early = dict(led["a full.insv"], lfmd_window=[5, 25], lfmd_window_by="operator")
    assert gate(9, {"a full.insv": dict(early, lfmd_from_note={"full": 12.0, "master": 5.0, "window": [5, 25]})}, files)[0]
    assert not gate(9, {"a full.insv": dict(early, lfmd_from_note={"full": 12.0, "master": 5.0, "window": [6, 26]})}, files)[0]
    assert not gate(9, {"a full.insv": dict(early, lfmd_from_note={"full": "x", "window": ["a", 25]})}, files)[0], "an unreadable record is no evidence"
    # no Summary clip: the card says where the engine looked and what short clips are there (2090, 5 Oct)
    day = {"e": {"episode": 9, "role": "episode", "status": "rendered", "date": "2026-03-01", "path": "/raw/1 March 26 - 9 March 26/e.insv", "duration": 500.0},
           "s": {"date": "2026-03-02", "hms": "071000", "name": "VID_s.insv", "status": "new", "size": 4.2e8, "path": "/raw/1 March 26 - 9 March 26/s.insv"},
           "l": {"date": "2026-03-02", "name": "VID_l.insv", "status": "rendered", "role": "episode", "episode": 10, "duration": 600.0, "path": "/raw/1 March 26 - 9 March 26/l.insv"}}
    line = summary_search(day["e"], day)
    assert line.startswith("NO SUMMARY FOUND: looked in 1 March 26 - 9 March 26 for 1 Mar and 2 Mar;") and "VID_s.insv (2 Mar, not pulled yet, 0.4 GB, new)" in line and "VID_l" not in line, line
    alone = {"e": day["e"]}
    assert "nothing recorded on 2 Mar is on the ledger yet" in summary_search(day["e"], alone) and "no other short clip" in summary_search(day["e"], alone)
    assert any(n == "teaser" and d.startswith("NO SUMMARY FOUND") for n, _, _, d in checks(9, {"a full.insv": led["a full.insv"]}, files))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("mode"); ap.add_argument("--day", type=int, default=0)
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "check":
        ok, fails, passed = gate(a.day)
        for n, okk, hard, d in checks(a.day): print("%s %s%s: %s" % ("PASS" if okk else ("FAIL" if hard else "note"), n, "" if hard else " (soft)", d))
        print("GATE:", "open" if ok else "BLOCKED")
    elif a.mode == "accept-early":
        print("episode %d: Learnings clip at %s accepted as the diary section; the next approval run reads the gate again" % (a.day, accept_early(a.day)))
    elif a.mode == "accept-no-learnings":
        print("episode %d: accepted on %s as having no Learnings section; the next approval run reads the gate again" % (a.day, accept_no_learnings(a.day)))
    else: raise SystemExit("usage: qa.py check --day N | accept-early --day N | accept-no-learnings --day N | selftest")
