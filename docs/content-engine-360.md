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

## Thumbnail (R6, 3 Sep 2026)

`thumbnail.py` is a port of the Content Machine app's `thDraw()` so the 360 lane's thumbnails look like the team's: orange ground with the deep-orange stripe, navy slash, the photo panel cut on the diagonal, the white accent lines, the icon card top-left, LINE 1 in white Impact with a navy outline, LINE 2 in a navy box, the red WATCH NOW pill, the Runpreneur logo top-right. The app's icon catalogue (290 Lucide paths), its keyword table (838 pairs) and the logo PNG were lifted verbatim into `cm_thumb_assets.py`; `pick_icon` is the app's first-keyword-wins rule, `speech` when nothing matches.

- The photo is a frame of the 9:16 master at 12 s (or half the clip if shorter), scaled to cover the panel's bounding box and cropped a quarter from the top, so the whole slanted cut is filled and Kevin's head stays in view.
- The two title lines come from Claude on the standard tier with the app's own title prompt (`LINE1:`/`LINE2:`); if that call fails the banner title is split at its bar, so a render never stops for a missing headline. The lines chosen are kept on the ledger entry (`thumb_lines`) with which route produced them.
- Text is measured by rendering it on a black strip and reading the ink, because this Mac has no PIL and a guessed em-width put a 15-character title at half the team's size. Each line goes through `textfile=`: a title with an apostrophe put through `text='...'` ended the quote and vanished, with ffmpeg returning 0.
- The path parser handles M L H V C S Q A Z with relative forms and compact arc flags. The catalogue's `rainbow` ends with a six-number arc; browsers draw what they parsed and stop, so does the parser.
- Output: `Episode_<n>_Thumbnail.png` in the episode's Drive folder, link in `Thumbnail URL` on the episode record. Episode clips only; a teaser has no thumbnail.

Measured against the team's episode 2049 thumbnail at 1280x720: icon 245 px at (127, 55), LINE 1 top at 353 with a 100 px start size that shrinks 4 px at a time until it fits between x=80 and 40 px short of the slash, LINE 2 box top at 434.


## Approval card (R9, 3 Sep 2026)

`approval.py` raises ONE card per finished episode in the same queue as every other agent's work: a Tasks record at Status Approval with Sent For Approval By = the Content Engine (Team Members `recRcy1Edas6rGaaF`, register `recNaC0N5KiTGBPNy`, `ROLE_AGENTS` entry with `dispatch: False`). The 08:00 digest counts it; Kevin decides on the AI Agents page; `sync` writes his verdict onto the episode record (Approved -> "Approved for Publishing", which the publishing step will read; Rejected or Changes requested -> his words into Feedback). The card leads with the ask in one line, lists the videos and thumbnail as links (the approvals page now linkifies the work), the copy for all three records as written, the rules-check result, and ends with the "Carrying this out will involve:" line. It says plainly that scheduling is the next build and nothing goes out on approval until it is live.

- A card needs Record Status "Copies in Progress" plus Video Edited URL, Thumbnail URL and YouTube Copy. Raising it moves the record to "Quality Control" and notes the task id.
- The duplicate gate strips numbers, so every "Publish Episode N" shares one key; the script does its own exact-name check with a control and calls the gate with `--force`.
- `submit` refuses an agent whose register row is not Built or Live; the row was set to Built on 3 Sep 2026.
- Lessons: both Claude calls in the lane (`platform_copy.ask_claude`, `thumbnail.titles_from_transcript`) append `watch.kevin_lessons()`, the "## Lessons from Kevin" section of `~/.claude/agents/content-engine.md`, so "reject and remember" changes the next episode.
- State: `~/knowledge-os/logs/content-engine/approvals.json` (episode -> task, record, verdict).


## Publishing through GoHighLevel (R10, 3 Sep 2026)

`publish.py` schedules APPROVED episodes only (approvals.json verdict approved, record at "Approved for Publishing" or later) through the GHL Social Planner on the Runpreneur sub-account, the same accounts the team posted to by hand (their last 100 posts: TikTok and Kevin's LinkedIn profile, published around 08:00-09:00 UK, type post).

- Stage 1, the night after approval: the full episode to the GHL YouTube account (type video, public, thumbnail attached, title from the "SEO Title:" line of the YouTube copy, 100 chars max), scheduled 06:00 London.
- Stage 2, the night after GHL reports the YouTube post published: the link goes onto the record (YouTube Full Link, Date Published (YT)) and into every social copy (the "[ADD YOUTUBE LINK]" line, or appended), then the Summary clip (09:00) and the Learnings clip (17:00) are scheduled to every connected channel with that record's platform copy: TikTok (public, comments/duet/stitch on, as the team's posts), Facebook Page (Summary as a reel, Learnings as a post), LinkedIn page and profile, Instagram (reels) and Threads once they are connected. X is never scheduled (GHL dropped it Dec 2024). Expired account rows are skipped.
- `sync` every night reads post statuses: published links land in the record's link fields (Link of Tiktok Video, Link of Facebook Reels, Link of Facebook Page Post, Link of Linkedin Post, ...); a failed post is printed; when every post is out the record reads "Published" with Date Published (Other).
- Media goes into the GHL media library once per file (`/medias/upload-file`, multipart through curl with the key in a mode-600 config file, never an argument; Cloudflare bans Python's default user agent, so every call sends a browser one) and the CDN URL is cached in `publishing.json`.
- Holds, with a digest line, until a YouTube account is connected in GHL: `publish.py youtube-link` prints the OAuth start URL (Kevin's one click); after consent the account is attached with the same accounts POST used for LinkedIn and Facebook.
- Proof on 3 Sep 2026: Episode 2195's Summary uploaded to the library and one DRAFT post created on the Runpreneur LinkedIn page (id in publishing.json under proof; a draft publishes nothing).

State: `~/knowledge-os/logs/content-engine/publishing.json` (episode -> media urls, posts with GHL ids/status/link, youtube_link).


## Test mode before going live (3 Sep 2026)

The engine starts in TEST mode and stays there until Kevin writes `live` to `~/.config/od/content_engine_mode`. In test mode the whole chain runs for real, approval card included, but nothing reaches a public feed: the full episode goes to YouTube as UNLISTED (so the link exists and fills the copy), and every social post is created as a DRAFT in the GoHighLevel planner for Kevin to open and check. The approval card's closing line says which mode it is in. Ericamae's daily process is untouched during the test because drafts and unlisted videos never appear on the feeds she posts to; the first live episode is chosen with her so the same day is not published twice.
