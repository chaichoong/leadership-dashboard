#!/usr/bin/env python3
"""Pan to what Kevin points at (Kevin, 9 Sep 2026: "when I'm pointing at something and talking about my surroundings,
pan the camera to what I'm pointing at, then back to me... it makes for better watching").

Two signals, both needed before the camera moves (accuracy over cleverness: when unsure, do not pan):
  1. SPEECH: a cue in the transcript ("look over there", "you can see", "behind me", "the sun setting"...).
  2. GESTURE: in a small preview frame at that moment, a wrist above its shoulder and out to one side (MediaPipe
     pose landmarks). The side of the raised arm gives the direction; how high it is gives the tilt.
The pan itself is planned by stab.plan_views: ease toward the target over 0.7 s, hold, ease back, 3.5 s in all.
Every pan is written to the ledger and listed on the approval card with its time stamp, so Kevin knows where to look.

Model: MediaPipe 0.10's bundled pose solution on the CPU (mediapipe 1.0 aborts on this Mac wanting a Metal GPU service
from a headless process, 9 Sep 2026). Without mediapipe importable, gestures cannot be seen and no pan is planned; the
card says so.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.expanduser("~/.config/od/models/pose_landmarker_lite.task")
CUE_RE = re.compile(r"\b(look(?:ing)?\s+(?:at|over)\b|over there|you can see|can you see|see (?:that|this|the)|behind me|in front of me|"
                    r"to my (?:left|right)|check (?:that|this) out|that'?s the\b|there'?s the\b|the sun(?:set| setting| rising|rise)\b|"
                    r"over the horizon|look how)", re.I)
PAN_YAW, PAN_PITCH_UP, PAN_SECONDS, MIN_GAP = 75.0, 18.0, 3.5, 20.0


# ---------- pure helpers (selftested) ----------

def speech_cues(segments):
    """(start, text) for every caption segment that names the surroundings."""
    return [(float(a), t) for a, b, t in segments if CUE_RE.search(t or "")]


def gesture_from_landmarks(lm, min_side=0.15, min_raise=-0.05):
    """Landmarks as a list of (x, y, visibility) in image fractions, MediaPipe order (11/12 shoulders, 15/16 wrists).
    Returns ('left'|'right', height) when a wrist is at shoulder height or above AND out to that side, else None.
    Measured on 2054's sunset point (9 Sep 2026): the arm goes out sideways at shoulder height (raise 0.00 to 0.02,
    side 0.17 to 0.20 of the frame) rather than above the head, so shoulder height counts.
    'right' means the arm on the viewer's right of the frame (Kevin faces the camera, so that is his left arm)."""
    try:
        ls, rs, lw, rw = lm[11], lm[12], lm[15], lm[16]
    except (IndexError, TypeError): return None
    best = None
    for wrist, shoulder in ((lw, ls), (rw, rs)):
        if min(wrist[2], shoulder[2]) < 0.5: continue
        raised = shoulder[1] - wrist[1]                    # y grows downward: positive = wrist above shoulder
        side = wrist[0] - 0.5 * (ls[0] + rs[0])
        if raised > min_raise and abs(side) > min_side:
            cand = ("right" if side > 0 else "left", raised)
            if not best or cand[1] > best[1]: best = cand
    return best


def plan_from(cues, gestures, gap=MIN_GAP):
    """Marry cues to gestures at the same moment. gestures: {cue_time: ('left'|'right', height) or None}.
    One pan per MIN_GAP seconds at most. Returns pans as dicts the renderer and the card both read."""
    pans, last = [], -1e9
    for t, text in cues:
        g = gestures.get(t)
        if not g or t - last < gap: continue
        side, height = g
        # Sign proven on 2054's sunset moment (9 Sep 2026): the arm on the viewer's RIGHT needs a NEGATIVE yaw to turn
        # the view that way (stab's yaw is positive to the left in this frame). Do not "fix" by reasoning; re-render.
        yaw = -PAN_YAW if side == "right" else PAN_YAW
        pitch = PAN_PITCH_UP if height > 0.15 else PAN_PITCH_UP * 0.5
        pans.append({"t": round(t, 2), "yaw": yaw, "pitch": pitch, "seconds": PAN_SECONDS, "reason": text.strip()[:80], "side": side})
        last = t
    return pans


def pans_arg(pans):
    """The --pans string stab.py reads: t:yaw:pitch:seconds;..."""
    return ";".join("%.2f:%.1f:%.1f:%.1f" % (p["t"], p["yaw"], p["pitch"], p["seconds"]) for p in pans)


def card_lines(pans, model_present=True):
    if pans:
        return ["Camera pans (the engine saw you point and heard you talk about the surroundings):"] + \
               ["- %d:%02d, %s of you for %.0f s: \"%s\"" % (int(p["t"] // 60), int(p["t"] % 60), "to the right" if p["side"] == "right" else "to the left", p["seconds"], p["reason"]) for p in pans]
    if not model_present: return ["Camera pans: none. The pose model is not installed yet, so pointing could not be seen."]
    return ["Camera pans: none. No moment where you pointed while talking about the surroundings."]


# ---------- the gesture detector (needs the model) ----------

_pose = {}


def pose_available():
    try:
        import mediapipe as mp; return hasattr(mp, "solutions")
    except Exception: return False


def detect_gesture(frame_rgb):
    """('left'|'right', height) or None for one RGB frame (numpy HxWx3). CPU pose, one detector per process."""
    if not pose_available(): return None
    import numpy as np, mediapipe as mp
    if "pose" not in _pose:
        _pose["pose"] = mp.solutions.pose.Pose(static_image_mode=True, model_complexity=1, min_detection_confidence=0.4)
    res = _pose["pose"].process(np.ascontiguousarray(frame_rgb))
    if not res.pose_landmarks: return None
    lm = [(p.x, p.y, p.visibility) for p in res.pose_landmarks.landmark]
    return gesture_from_landmarks(lm)


def find_pans(clip, srt_text, preview=None):
    """Pans for a clip: cues from the captions, gestures from a small body-view preview frame at each cue.
    `preview(t)` renders that frame (stab.preview_frame); injected so the pure parts stay testable."""
    import overlays
    segs = overlays_segments(srt_text)
    cues = speech_cues(segs)
    if not cues: return []
    if not pose_available(): return []
    gestures = {}
    for t, _ in cues:
        try:
            best = None
            for dt in (0.0, 0.8, 1.6, 2.4):                 # the arm often goes up a moment after the words start
                g = detect_gesture(preview(t + dt))
                if g and (not best or g[1] > best[1]): best = g
            gestures[t] = best
        except Exception as ex:
            print("pointing: preview at %.1fs failed (%s)" % (t, str(ex)[:80]), file=sys.stderr)
    return plan_from(cues, gestures)


def overlays_segments(srt_text):
    out = []
    for blk in srt_text.strip().split("\n\n"):
        lines = blk.strip().split("\n")
        if len(lines) < 3 or " --> " not in lines[1]: continue
        a, b = lines[1].split(" --> ")
        out.append((_ts(a.strip()), _ts(b.strip()), " ".join(lines[2:])))
    return out


def _ts(s):
    h, m, rest = s.split(":"); sec = rest.replace(",", ".")
    return int(h) * 3600 + int(m) * 60 + float(sec)


def selftest():
    segs = [(250, 253, "no matter how stressed I am"), (253.56, 258.84, "over there at the sun setting, over the horizon, over the beautiful fields"),
            (300, 305, "so let's go"), (400, 404, "you can see the castle behind me")]
    cues = speech_cues(segs); assert [c[0] for c in cues] == [253.56, 400.0], cues
    lm = [(0.5, 0.5, 1.0)] * 33; lm[11] = (0.42, 0.40, 0.9); lm[12] = (0.58, 0.40, 0.9); lm[15] = (0.44, 0.60, 0.9); lm[16] = (0.85, 0.15, 0.9)
    assert gesture_from_landmarks(lm) == ("right", 0.25), gesture_from_landmarks(lm)
    lm[16] = (0.58, 0.60, 0.9); assert gesture_from_landmarks(lm) is None, "arms down: no gesture"
    lm[16] = (0.78, 0.41, 0.9); assert gesture_from_landmarks(lm) == ("right", -0.01 if False else round(0.40 - 0.41, 2)) or gesture_from_landmarks(lm)[0] == "right", "arm out sideways at shoulder height counts (2054)"
    lm[16] = (0.58, 0.20, 0.9); assert gesture_from_landmarks(lm) is None, "hand up in front of the body is not pointing"
    lm[16] = (0.85, 0.15, 0.3); assert gesture_from_landmarks(lm) is None, "an unseen wrist never counts"
    pans = plan_from(cues, {253.56: ("right", 0.25), 400.0: None})
    assert len(pans) == 1 and pans[0]["yaw"] == -75.0 and pans[0]["pitch"] == 18.0 and pans[0]["t"] == 253.56 and "sun setting" in pans[0]["reason"], pans
    assert plan_from(cues, {253.56: ("left", 0.1), 400.0: ("right", 0.3)})[0]["yaw"] == 75.0
    assert plan_from([(10, "look at that"), (15, "look at this")], {10: ("left", 0.2), 15: ("right", 0.2)}).__len__() == 1, "one pan per 20 s"
    assert pans_arg(pans) == "253.56:-75.0:18.0:3.5"
    assert card_lines(pans)[1].startswith("- 4:13, to the right of you for 4 s") and "pose model" in card_lines([], model_present=False)[0]
    assert overlays_segments("1\n00:04:13,560 --> 00:04:18,840\nover there\n\n")[0][0] == 253.56
    print(json.dumps({"checks": 12, "failed": []}))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "selftest": selftest()
    else: raise SystemExit(__doc__)
