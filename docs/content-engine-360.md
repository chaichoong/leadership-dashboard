# 360 spike recipe (2 Sep 2026)

Candidate final look (Kevin: whole body, slight curve OK, as high/looking-down as the footage allows):

    python3 stab.py render CLIP.insv OUT.mp4 --map z-yx --proj sg --dfov 250 --tilt 11 --level \
        --blend 0.6 --smooth 1.0 --gain 0.0003 --size 1920x1080

- `--map z-yx`  IMU-to-image axis mapping for the Insta360 X4 (calibrated 2 Sep 2026)
- `--level`     look horizontally towards Kevin (horizon through frame centre keeps it straight)
- `--tilt 11`   then aim 11 deg down (more = more "from above" but the horizon starts to bend)
- `--dfov 250`  stereographic width; 225 flat-ish, 250 slight curve, 265+ obviously round
- `--blend 0.6` 0 = follow the stick (body steady, background moves), 1 = smoothed path
- vertical: `--size 1080x1920` (LFMD / Summary), same recipe
- Feb 2026 clips are 8K (3840 per lens); insta.py reads the size from the file

Files: final_064.mp4 (July, this recipe), level_feb027.mp4 (Feb, level, dfov 240, tilt 0),
earlier iterations kept for comparison.

## Overlay rules (Kevin, 2 Sep 2026 late)
- Titles: "Learnings from my Diary" banner style (orange box, two lines Arial Black, dark "DAY n" pill),
  centred in the band between the top edge and Kevin's head. Vertical: banner y=190..380 of 1920.
- Captions on ALL formats (full, LFMD, Summary): small orange-box lines (<= 5 words), centred in the band between Kevin's feet and the
  bottom edge. libass force_style: 16:9 FontSize=13 MarginV=28; 9:16 FontSize=9 MarginV=34
  (libass units are 288 lines high regardless of video height).
- Nothing over the face or body. Brand dictionary: Rumprener/rumpener -> Runpreneur.

## Build notes (scripts/content-engine/, 2 Sep 2026 late)
- `stab.py render` now renders with a worker pool (`--workers 4`, forked processes; each frame is
  independent once the per-frame view plan is computed).
- Raised-camera cut: when the stick direction pitches above -25 deg for more than 0.5 s (Kevin lifts
  the camera at the sign-off), frames switch to a tighter rectilinear face view along the stick.
  `--no-raise-cut` disables it.
- `overlays.py` is the single place for caption/title rules; `tests/content-engine.test.js` pins them.
- Still to build: folder watch (R1), transcript-driven LFMD/Summary segment choice (R4, an AI call),
  Drive URL write-back (R5), thumbnail (R6), captions copy (R7), rules check (R8), approval card (R9),
  GHL scheduling with the two Content Engine keys.
