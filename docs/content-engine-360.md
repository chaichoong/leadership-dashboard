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

## Speed (measured 3 Sep 2026, clip 064 = 41.6 s, 999 frames, 1080p)
- Original numpy sampler + software HEVC decode: 11 min.
- Hardware decode (`-hwaccel videotoolbox`, 7x faster than software here) + OpenCV `remap`
  sampling (55 ms/frame vs ~600) + a prefetch thread on each decoder pipe: **4 min 8 s**
  (about 6x real time). Per frame: render 107 ms, the rest is decode/pipe/encode hand-off.
- Time-sliced parallel workers (`--workers N`) were SLOWER on this Mac in every trial (3 or 4
  slices: 20 to 27 min) and the pool version was slower still, so the default is one worker.
  Untested hypothesis: OpenCV and numpy each spin up all cores per process and thrash. Try
  `cv2.setNumThreads(1)` per slice before spending more time here. Half-resolution maps were
  also slower and softer. A 71 s clip is ~7 min, so a 90-clip monthly batch is ~8 machine hours.

## Episode numbering (Kevin, 3 Sep 2026)
- Day 1 = 1 June 2020, so day = (shoot date - 2020-06-01) + 1. 4 Jul 2026 = 2225.
- Kevin says the day in his intro and is usually right; render.py reads it and applies
  `watch.resolve_episode`: match = normal; spoken = date - 1 with no talk clip the day before =
  catch-up (he missed a day and recorded two the next day); anything else = trust the date and
  flag it in the record Notes. A clip with under 50 characters of speech is B-roll and is skipped.

## Fixes after the first real episode (Kevin, 3 Sep 2026)
- No close-up when the camera is raised: the render keeps one angle for the whole clip
  (`--no-raise-cut` is in the recipe). The raise detector stays in the code for a later smooth opening.
- Lens model is now equisolid at 190 deg: fitted on the seam band of three clips, the two lenses agree
  best there (error 29.5 vs 32.8 for equidistant). Front-lens priority: the front lens wins everywhere
  it covers, so anything close to Kevin is never half-blended with the back lens' edge.
- The hand on the stick: in the July 2026 clips the raw lens frames do not contain the hand at all
  (checked frame by frame at 12 s of clip 064), so no stitch can show it. In the winter clips, held out
  in front, the hand is at the bottom of the frame and comes through skewed, as it did in Insta360 Studio.
- LFMD = the "Learnings from my diary" section only: from the last sentence that names it to the
  sign-off ("thank you as always" / "stay positive" / "see you tomorrow"), 20-120 s, cut from the 9:16
  master with its own captions. If a clip has no such section, no LFMD is written for it.
- A shooting day holds a short teaser (the Summary) and a long episode (Full + LFMD). Clips over
  150 s, or any clip with a diary section, are episodes; the rest are teasers. Only the episode clip
  sets the transcript and the status on the record.

## Copy step (R7 + R8, 3 Sep 2026)
- `platform_copy.py run --day N` fills the copy fields on the Full, LFMD and Short records (creating LFMD and
  Short if the render has not). Prompts are the Content Machine's own, byte for byte (`cm_prompts.py`).
- Model route: `claude -p --system-prompt ... --model sonnet --tools ""` with the OAuth token, like the
  other headless agents. About 3 minutes and a few pence per record type.
- Rules check fixes em dashes in place and REPORTS everything else in the record Notes as "REVIEW:":
  banned phrases, US spellings, Threads > 500 / X > 300 chars, money or thousands figures that are not
  in the transcript (the mission figures 40,075 km and £1 million are allowed).
- Status moves to "Copies in Progress" so the team's Copywriting/QC pages pick the records up as before.
