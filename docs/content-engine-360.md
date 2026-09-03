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


## Closing the gaps against Ericamae's process (3 Sep 2026)

Measured against her app, her SOPs and the last 15 Published records (see `~/Movies/spike-360/ericamae-vs-content-engine.md`):

- **Intro clip.** `render.py` splices the 8 second branded intro (`Runpreneur Edited Video/Vlog Intro/runprenuer-intro_clip.mp4`) into the captioned full episode with her app's rule: after the caption carrying Kevin's sign-off ("keep on watching / listening", "hope you find it useful", "stay with me", "let's go"), else before the "welcome back" caption (specific phrase first, then "consecutive day"), else at the start. Only the first 35% of the clip is searched, so a late "let's go" is not the sign-off. One hardware re-encode; the intro is scaled and padded to the episode's frame, both audio tracks made 48 kHz stereo. Proven on Episode 2195 (40.2 s -> 48.2 s, frames checked).
- **Podcast audio.** `Ep<N>_Podcast.mp3` (128 kbps) from the finished full episode, filed with the videos and uploaded to the GHL library at stage 2 (`publishing.json` -> podcast.audio_url). Spotify for Creators has no API; the upload runs through the agent browser lane once Kevin has logged into it (next step).
- **Blog.** runpreneur.org.uk is a GoHighLevel site, so `blog.py` creates the article through `/blogs/posts` (scopes added to the Content Engine key 3 Sep 2026): title from the "SEO Title:" line, paragraphs to `<p>`, short unpunctuated lines to `<h2>`, thumbnail as the header image, category "Runpreneur Episodes", author Kevin, the YouTube link at the end, slug checked with `url-slug-exists`. DRAFT in test mode, PUBLISHED live. `Blog Link` written on the record in her URL shape.
- **Her link fields.** `sync` now writes both the "Link of ..." fields and the ones her QC/Ready pages read (YouTube Link, TikTok Link, Facebook Post Link, Instagram Post Link, LinkedIn Link, Threads Link), on the Full record and on the clip's own record. Stage 1 also sets `Video Title` (the SEO title) and `Target Publish Date`.
- **Not closed, by decision or by platform:** X (GHL dropped it), sharing the Page post to Kevin's personal Facebook profile (no API), social stats and the "How far I've run" page (her stats fields were empty on all 357 records; decide separately).


## Runpreneur sync and the podcast (3 Sep 2026)

- **`runpreneur_sync.py`** replaces the app's Runpreneur Sync page (SOP 62): every run the site has not counted yet -> running total (seeded from the live site's value and day the first time; each run named for its own calendar day with the total as of that run; one activity folded once), day from the calendar (1 Jun 2020 = day 1), donations = the website's live figure at first run + the Stripe growth since (Kevin's continuity rule, 3 Sep 2026: the historic figure is never restated; Stripe lifetime gross of succeeded GBP charges on the Runpreneur account is only ever read for its difference) (read-only key `~/.config/od/stripe_runpreneur_key`; £6,842 over 1,643 charges on 3 Sep 2026, which matches the site's £76,840), progress = km / 40,075. Pushes the four GHL custom values the website's merge tags read (ids pinned; refuses to write if an id changed) and renames the run on Strava with the app's exact caption. Strava credentials: `strava_client_id/secret/refresh_token` in `~/.config/od/`. **Strava's app (Client 162160, "Performance Analysis") sits on a -1 request tier**, so every call returns 429 until Kevin upgrades it on strava.com/settings/api; the nightly run holds harmlessly and says so. Fallback if the tier never changes: the browser lane (`strava` profile, logged in 3 Sep).
- **`spotify.py`** writes the agent-browser plan for the podcast: Ericamae's episodes are VIDEO episodes (Format: Video in the Episodes list), so the upload is the full episode MP4 with the Podcast Copy title/description and the YouTube link. Wizard: Upload (`#uploadAreaInput`) -> Details -> Review. Test mode ends in "Save as draft"; live presses "Publish now" through `commit`, which needs the episode's approval task Approved. The Details step's selectors are confirmed on the first real episode.
- `agent-browser.js read` gained `--wait MS` / `--wait-for SELECTOR` because single-page apps paint nothing at domcontentloaded.


## Operations Director lane (PLAN, 3 Sep 2026, awaiting Kevin's approval before any build)

The second brand profile of the one Content Engine agent (register row recNaC0N5KiTGBPNy, chain links R3b and
O1-O6 on its Notes). The Runpreneur lane is in its first full test and is not changed by anything here. This
section is the plan Kevin asked for before building; every number below was read on 3 Sep 2026 and says where.

### What the lane does, in one paragraph

Every Runpreneur transcript the render step writes is mined for the talk about AI, agents, systems, delegation
and running a business. The running context is stripped. The moments go into a bank with their verbatim quote
and episode. Each Sunday night the lane fills the coming week's five weekday slots from the bank (pillar to
slot), falls back to the playbook's named sources when the bank has nothing for a slot, drafts one LinkedIn
post per slot in the OD voice, checks the playbook's hard rules, and raises one approval card per post so all
five land in Monday's 08:00 digest. Approved posts are scheduled through GoHighLevel to the Operations Director
LinkedIn page only. Test mode makes them planner drafts. The episode itself still publishes on Runpreneur.

### Chen's Content Engine chain, mapped onto ours

Chapter 2 of The AI Automation Playbook: 01 AI Research, 02 AI Draft, 03 AI Polish, 04 AUTO Publish, 05 AI
Social clips, 06 AUTO Schedule, 07 AUTO Track, optional HUMAN approve before publish. Our links: Research =
R3b transcript moments plus the O2 brief (Chen's brief rule kept: primary angle, target reader in one sentence,
three specific points, two angles to avoid). Draft and Polish = O3 as two passes with Chen's polish wording
("tighten without sacrificing the voice", never "make it punchier"). Approve = Kevin on the card, not optional.
Publish and Schedule = O6 through GHL. Track = weekly stats onto the record, monthly read that re-weights the
brief (P6, P7). Chen's voice-drift check (read three recent posts side by side, monthly) is P7's five minutes.
Chapter 6's Social Repurposing chain becomes R3b inside this agent, which is exactly Chapter 2's step 6, and
is not a register row of its own (Chen's own two-week rule and the 25 Aug merge verdict).

### Measured before the plan (3 Sep 2026)

- **OD GoHighLevel sub-account** `dgsHwbYbp6xrhRGZr9ik`, accounts read via `/social-media-posting/{loc}/accounts`:
  LinkedIn profile "Kevin Brittain", LinkedIn page "Operations Director" (account id ending `106232134_page`),
  LinkedIn page "Runpreneur", TikTok "Kevin Brittain - Runpreneur". All active to Oct 2026 or later. The OD lane
  may use exactly ONE of these: the Operations Director page. The other three are on the allowlist for nothing.
- **Content Machine Runpreneur table** `tblEPzZdwBZeSXFRB`: Category options are `Social Housing Group` and
  `Runpreneur` only (no Operations Director yet); Content Type has `Written`; Platforms has `LinkedIn Post`;
  the record already carries LinkedIn Copy, Target Publish Date, Link of Linkedin Post, Views/Likes/Comments
  LinkedIn. Nothing new is needed on the table beyond the one Category option.
- **Classifier back-test, read-only, the 30 most recent Long Form transcripts with 1,500+ characters sorted by
  Date Published (YT)** (episodes 1950-1996, scratch files `transcripts30.json`, `od_ai_pass.json`):

  | Pass | Rule | Result on the 30 |
  |---|---|---|
  | 1. Keyword gate (free) | OD words per 1,000 words (ai, agent, automat, system, process, delegat, business, founder, team, decision, productiv, ...) at 3 or more | passes 17 of 30; catches all 9 the AI later rated 7+; saves 13 AI calls |
  | 2. AI score (sonnet, JSON, standard tier) | 0-10 relevance to OD's four pillars, verdict OD at 7+, verbatim 8-25 word quote per moment, running talk excluded by rule | 9 of 30 at 7+ (30%), 6 at 4-6, 15 at 0-3; the 9 support 23 posts by the model's own count; cost $1.08 for all 30, 3.6 cents a transcript |

  A keyword gate alone is not enough: at 7 words per 1,000 it misses episodes 1968, 1977 and 1979 (mindset applied
  to business, scored 7 by the AI) and passes 1969 and 1964 (scored 3 and 4). So: two passes, gate at 3, AI at 7.
  Sample moments the AI pulled, quotes verbatim from the transcript: Episode 1992 "you've now got the ability to
  turn SOPs into AI agents and have a universal SOP agent" (Method); Episode 1979 "I normally look at them over a
  30 day period and that's where I'll determine whether we're making progress or not" (Method); Episode 1977
  "remove as much of the emotion from the process as possible, because it's only gonna mask your logic" (Philosophy).
- **What that means for cadence:** about 2 of 7 weekly episodes carry OD material, worth 2-3 posts each, so the
  bank supplies roughly 4-5 posts a week at best and 3-4 in a normal week. The remaining slots come from the O2
  brief on the playbook's named sources. A slot with neither raises a THIN card asking Kevin for one line of
  context; nothing is invented (playbook rule 1). Transcript-sourced posts are also the cleanest voice source
  we have: the spoken word is the one corpus of Kevin's that cannot have been written by his AI
  (`Knowledge/kevin-voice-profile.md`, contamination rule).

### Decisions in this plan (Kevin approves or amends each)

1. **Record home.** Same table, one record per post: Category `Operations Director` (brand = Category, Kevin's
   ruling), Content Type `Written`, Content Name `OD Post 2026-09-07 Mon Pain - <hook>`, the post in
   `LinkedIn Copy`, `Target Publish Date`, Platforms `LinkedIn Post`, Responsible `Content Engine (AI)`, Notes
   holding the source (episode record id and the verbatim quote, or the named playbook source). The Category option
   is created by the first write with `typecast: true`; if Airtable refuses (the PAT has no schema scope), Kevin adds
   the option once in the table. Verified in the build with one test record, deleted after.
2. **Post shape: text only.** No clip reuse. The Learnings clip shows Kevin running in Vibrams under a DAY pill,
   which is Runpreneur content on an OD channel (playbook rule 4, "no exceptions") and the audience-signal reason
   in playbook section 2. No carousel (rule 2 on visuals; no asset pipeline). A re-cut OD clip with its own overlay
   is a later section 13 option once four weeks of text posts have data.
3. **Cadence and slots.** Sunday night in the existing 02:00 job: mine new transcripts into the bank, then fill
   Mon Pain, Tue Method, Wed Proof, Thu Contrarian, Fri Offer. Pillar match: Pain moments to Monday, Method to
   Tuesday, Philosophy to Thursday; Wednesday Proof comes only from the evidence inventory (decision 8); Friday is
   the week's strongest moment plus the one CTA. Five cards raised together so they sit in Monday's 08:00 digest.
   Approved posts schedule to the OD page at 08:00 London on their weekday (parameter; the register's trigger says
   the 06:00 slot opens, the team's own posts went out 08:00-09:00). Test mode: GHL drafts, nothing on the feed.
4. **Copy prompt** (`od_prompts.py`, new): system prompt built from playbook sections 3 (audience, core message,
   five hot-buttons), 4 (pillars and third acts), 6 (rules 1-12 including locked pricing £1,500 setup, £350 a
   month, 30-day trial), plus the person-to-person register of `Knowledge/kevin-voice-profile.md` loaded at run
   time (never the LinkedIn history, rule 12), plus the agent file's shared "Lessons from Kevin" and a new
   "Lessons from Kevin (Operations Director)" subsection. Two calls per post (draft, then polish with Chen's
   wording). Output: one post, 60-220 words, hook as the first line, "you" and "your", no hashtags (rule 12
   measured 13.4 hashtags a post on the machine-written history; Kevin's real writing carries none), no link and
   no ask Monday to Thursday. Standard tier, same headless `claude -p` route as `platform_copy.py`.
5. **Rules check** (`od_rules_check`, modelled on `platform_copy.rules_check`): em dash fixed in place; UK
   spelling; the master prompt's banned words; a Runpreneur strip list that FAILS the post (run, running, runner,
   km, streak, barefoot, Vibram, Runpreneur, marathon, charity, children, donate, Strava); every £ figure must be
   one of the locked three or appear in the source; every other number must appear in the source; a link or a
   "comment" ask only on Friday; "agent" only for things the evidence inventory calls agents (decision 8). Fail =
   the card says so and the post is left for Kevin, never silently rewritten (the R8 pattern).
6. **Brand guard** (`publish.py`, `BRANDS` map): brand -> key file, location file, allowed accounts by platform
   and type, allowed record Category. Operations Director allows exactly one account, the OD LinkedIn page. The
   publisher reads the brand from the record's Category and refuses a mismatch. Selftests: a Runpreneur record
   handed to the OD publisher raises; an OD record whose Category is Runpreneur raises; the OD allowlist contains
   no profile, no TikTok and no Runpreneur page; an OD post containing a strip-list word fails the rules check; an
   OD card never names the Runpreneur socials; the Runpreneur publisher never reads the OD key.
7. **The card.** Task name `CONTENT (OD): Mon 7 Sep, Pain: <hook>`. First line, the ask: "Post this on the
   Operations Director LinkedIn page on Monday 7 September at 08:00." Then the post exactly as written. Then
   "Where it came from": episode number and the verbatim quote, or the named source. Then the rules-check line.
   Then the closing line "**Carrying this out will involve:**" with the test or live wording. Business =
   Operations Director (`reca9ofzhuw13ZzGE`), Team Member `recRcy1Edas6rGaaF`, type Drafting, created through
   `create-agent-task.py create --force` (the dupe key strips numbers and dates, so every OD card would fold into
   one) after an exact-name check with a control, then `agent-dispatch.py submit`. Same queue as the Runpreneur
   cards, told apart by the `(OD)` prefix; five arrive together on Monday and each reads in about a minute.
   Verdicts: Approved -> record `Approved for Publishing`; Changes requested -> ONE redo with Kevin's words and a
   fresh card, a second miss drops the slot and logs it; Rejected with a reason -> the reason lands in the OD
   lessons subsection (reject and remember), the slot is dropped.
8. **Proof source needs a refresh (playbook amendment, Kevin's call).** Section 4a was verified 21 Jul 2026 and
   names two autonomous agents. The register now holds 26 rows with several Live and Built (Inbound Comms
   Triage, Creditor Management, Task Manager, Property Administration, Content Engine). Proposal: Wednesday Proof
   posts draw on register rows at Live or Built and their measured facts on the row (for example, 83 of 83
   labelled threads already had a task on 2 Sep), with the row id in the card's source line. Until Kevin approves
   this, Wednesday falls back to the THIN card.
9. **Friday CTA route.** The comment-gated "Comment SYSTEMS" route needs the daily comment-reading pass, which is
   not built. Friday uses the plain link to the gated Founder to Free magnet first; comment-gating is a later link.
10. **Measurement.** The register metric is human minutes per published piece, 10 or fewer, both brands. We cannot
    time Kevin, so the lane logs an estimate per card from the verdict (Approved as-is 2 minutes, minor edits 5,
    changes requested 10 plus the redo), flagged as an estimate in the weekly digest line ("OD lane: 5 posts, about
    12 human minutes, 2.4 a post"). GHL statistics (the key has the statistics scope) fill Views, Likes and
    Comments LinkedIn on the record weekly; missing = blank plus a flag, never 0. Playbook section 9's 90-day gate
    stands: fewer than 3 attended calls and the lane drops to 2 posts a week.

### Stress inputs (must pass before Live)

1. A week with no OD moments (the June 2026 window had 1 qualifying episode in 3): the slots fill from named
   sources or raise THIN cards. Nothing invented, no post from an empty brief.
2. GHL 401 mid-schedule (the 2 Sep live example): retry three times over 30 minutes, alert, never Published. Reused.
3. A Runpreneur record reaching the OD publisher, or an OD record reaching the Runpreneur one: refused by the
   brand guard with a named reason. Ten times the volume (the 90-clip batch): the bank grows, the cadence cap
   holds at five a week, bank items older than 60 days are dropped and time-sensitive words ("this week",
   "yesterday") are flagged on the card, Chen's rule.

### Build order after approval (one session)

B1 `od_lane.py mine` (two-pass classifier, bank in `~/knowledge-os/logs/content-engine/od-bank.json`, a note on
the episode record) with `backtest` kept as a read-only command against the live table. B2 `od_lane.py draft`
(slot fill, `od_prompts.py`, `od_rules_check`, the post records). B3 `approval.py` OD cards. B4 `publish.py`
`BRANDS` map, OD scheduling, the brand-guard selftests. B5 weekly stats. B6 the two new lines in
`content-engine-run.sh` (Sunday-gated draft, nightly mine). Selftests on every script as the lane already does;
the first test week runs in test mode with Kevin reading five drafts in the GHL planner.

### Open questions for Kevin (only the ones that change the build)

Q1 Publish time 08:00 or 06:00. Q2 Five cards (recommended, one verdict each) or one weekly card. Q3 No hashtags
(recommended). Q4 Approve decision 8 so Wednesday has a source. Q5 Plain link on Friday until comment-gating exists.


## Operations Director lane: BUILT (3 Sep 2026, Kevin approved the plan above the same day)

Kevin's four additions to the plan: OD posts go to the Operations Director LinkedIn page AND the Operations
Director Facebook page (once he connects it in GHL's Social Planner settings; until then the allowlist finds no
active Facebook page and the post goes to LinkedIn only); two Runpreneur-framed bridge posts a week (Tue Method,
Wed Proof) on his personal LinkedIn profile, amending the 21 Jul lock; Monday talking points for his runs folded
into the 09:00 brief by the huddle; the lead magnet as an urgent master-plan task straight after this build.
Instagram for OD waits until LinkedIn shows a signal; designed quote cards are rendered by code from real words.

- **`od_lane.py`** is the lane. `mine` (nightly, 6 transcripts) runs the two-pass classifier: `gate_density` (OD
  words per 1,000, free) at 3 or more, then `od_prompts.MINE_SYSTEM` through the same headless `claude -p` route as
  the copy step, score 7+ = OD; each moment's quote must be verbatim in the transcript (`verbatim`) or it is
  dropped. The bank is `~/knowledge-os/logs/content-engine/od-bank.json`; an OD episode gets one Notes line. `draft`
  (nightly, idempotent) fills the coming week's five slots: Pain/Method/Philosophy moments to Mon/Tue/Thu by pillar,
  Wednesday only from a real Proof moment, Friday the best remaining moment plus the one CTA (the Operations Review
  Call booking link until the magnet exists); Monday falls back to a playbook hot-button in the customer's words;
  anything else unsourced becomes a THIN card that asks Kevin for one line. Brief -> draft -> polish (Chen's
  wording) -> `rules_check` -> one `Written` record per post under Category `Operations Director` (typecast created
  the option on 3 Sep 2026; the test record was deleted). Two quote cards a week (`od_card.py`, ffmpeg drawtext on
  the Sage palette, Arial until DM Sans is installed) and two bridge posts. `cards` raises one approval card per
  post (Business Operations Director, `--force` after an exact-name check with a control, `CONTENT (OD): Mon 7 Sep,
  Pain: <hook>`). `sync` reads verdicts: Approved -> Approved for Publishing; Changes requested -> ONE redo from
  Kevin's words and a fresh card, a second miss drops the slot; Rejected with a reason -> a lesson appended to
  "## Lessons from Kevin (Operations Director)" in the agent file, which every OD call reads. `publish` schedules
  approved posts 08:00 London on their day to `publish.allowed_accounts("Operations Director", "post", ...)`, the
  bridge post 12:00 to Kevin's profile on the Runpreneur sub-account; drafts in test mode. `publish-sync` writes
  LinkedIn Link / Facebook Page Post Link and Published. `points` (Sun/Mon) writes `talking-points.md`.
- **Brand guard in `publish.py`**: `BRANDS` (key file, location, allowed accounts per lane, record Category),
  `brand_of`, `allowed_accounts`, `assert_brand`; `ghl`, `accounts`, `upload_media`, `create_post` take a brand and
  default to Runpreneur so the episode lane is unchanged. OD allows `("linkedin","page","Operations Director")` and
  `("facebook","page","Operations Director")` and nothing else; names are matched exactly because the OD sub-account
  also carries Kevin's profile, the Runpreneur page and TikTok. Selftests refuse a Runpreneur record at the OD
  publisher, an OD record at any other, a profile or TikTok for OD, and check the two keys differ.
- **Human minutes** are ESTIMATED from verdicts (Approved as-is 2, minor edits 5, changes 10, rejected 3) and
  reported as such in the digest line. GHL exposes no statistics endpoint we could find (`/statistics` 404,
  `posts/list` needs account ids), so weekly view counts are a follow-up, not a promise.
- **Filter lesson from the selftest:** "run" is a business word ("runs without you" is the core message), so the
  strip list catches only the running senses (my run, running streak, km, Vibrams, Strava, charity, children).
- Tests: `tests/content-engine-od.test.js` (selftests, playbook pricing and hot-buttons pinned against the
  prompt, the brand map, the nightly wiring, the business each card lands under).
