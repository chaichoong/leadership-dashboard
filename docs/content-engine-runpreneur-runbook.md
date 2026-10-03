# Runpreneur Content Engine — the full running order

**What this is:** every step the Content Engine takes for Runpreneur, in the order it takes them, so
Kevin can check nothing is missing. Written 20 Sep 2026 from the code, not from memory. This is a
reference doc, not a plan: content tasks live in `MASTER-PLAN.md`.

**The other lane:** Operations Director content runs through the same engine (`od_lane.py`) on a
different brand profile. It is steps 20 to 26 below and is listed only so the running order is complete.

---

## The two clocks

| Job | When | What it does | File |
|---|---|---|---|
| `content-engine` | **22:00, once a night** | The heavy half: pull a clip, render it, write the copy, raise the approval card | `scripts/content-engine-run.sh` |
| `content-engine-publish` | **Hourly, 07:15 to 20:15** | The light half: read Kevin's verdicts, publish, switch the ads on, share to his profile | `scripts/content-engine-publish.sh` |

Both run behind `job-queue.py`, so they never overlap another job. Both fast-forward the runtime
checkout to the latest merged code before they start, and both say so in the log.

> The nightly script's own header said 02:00 for months while the launchd trigger fired at **22:00**.
> Corrected in the script on 20 Sep 2026, along with the two other places it repeated the wrong time.

---

## Nightly, 22:00 — from raw footage to a card in Kevin's queue

**1. Scan the Drive folder** (`watch.py scan --create`)
Every new clip in the raw Insta360 folder gets a ledger entry. Every new shooting day gets one
"Episode N Full Episode" record at New Upload, carrying the Drive link of its first clip.
A clip named by its day must read exactly `2066 Full.insv`, `2066 Summary.insv` or `2071 Full Part 2.insv`.
Any other day-numbered name (`2066 Full-Real.insv`, `2006 Full (1).insv`) is skipped, listed in
`skipped_names.json` and shown on the Publishing page under "Raw files the engine skips". Until
21 Sep 2026 it was skipped without a word, and 2066's full episode sat on Drive unseen.

**The night's order** (`watch.py plan`): three days a night (Kevin, 2 Oct 2026; the number is in
`~/.config/od/content_engine_episodes_per_night`). New days first, oldest first, and never fewer than two of them.
A day Kevin sent back, which `render.py redo-day` set to re-render, comes after the new days and takes the spare
third slot: two new days and the redo. With no redo waiting, three new days. So a day he sends one episode back
still leaves two to publish, and the redo lands the next night (Kevin, 2 Oct 2026: "anything that is sent back for
editing goes to the back of the queue"). Until then the sent-back day was the oldest waiting day, took slot 1, and a
new episode lost its place. One redo a night at two or three slots, oldest first; a redo whose footage would not
download steps behind a younger one. A second sent-back day waits for the next night and the plan says so.
No day starts rendering from 04:00: a day begun late would be killed at the 07:00 stop and the copy, cards and
publishing steps after the loop would never run. The copy step (`platform_copy.py run --pending`) follows the same
order: new days first, and the oldest sent-back day always gets its copy. The night raises a card for every episode
it planned.

**2. Pull one clip** (`watch.py next`)
The oldest waiting clip comes down to the local work folder. One per run, never more than two waiting
locally. Disk is about 60 GB, clips are 0.3 to 5 GB, and Drive streams cold files at roughly 1 GB per
15 minutes, so it deliberately does not hurry.

**3. Render it** (`render.py run --limit 1`)
One clip, about 10 minutes of work for a 40 second clip:
- Transcribe it with whisper.
- Work out the episode number from the date (1 Jun 2020 = day 1), checked against the day Kevin says.
- Stitch the two fisheye lenses, level the horizon from the camera's own gyro, follow the selfie stick,
  and cut to a face view when he raises the camera.
- Render the 16:9 master and the 9:16 master.
- Cut the three deliverables: **Full Episode**, **Learnings From My Diary (LFMD)**, **Summary**.
- Burn in captions and banners.
- Splice the 8 second branded intro in after his sign-off line.
- Write the podcast MP3.
- Upload to the edited Drive folder and write the links, transcript and status onto the record.
- Delete the local copy.

The day folder holds two transcripts (2 Oct 2026): `Ep<day>_transcript.txt` is the episode's and
`Ep<day>_Summary_transcript.txt` is the teaser's. Until then every clip wrote the first name, the teaser
rendered last, and 26 of the 36 stored files held the teaser's words, which is what the output gate read.

The Learnings clip runs from the last diary line to the sign-off. The cutter (`render.lfmd_window`) and the
output gate (`qa.py`) read the talk the same way, as one text with whisper's noise notes left out
(`render.spoken`), so a line split across captions is cut and the two never disagree. The gate also refuses a
clip that starts in the first 40% of the episode: 2081's was cut from an aside at 14% and reached the card,
while every other clip on the ledger starts 54% in or later. The refusal names both ways out: rebuild it with
`render.py redo --day N --only lfmd`, or, once someone has watched the clip and it is the diary section,
`qa.py accept-early --day N`. Any re-render or rebuild drops that acceptance.

The 40% is measured against the clip length. When the render recorded that the clip runs to his sign-off with
no more than a few words after it (`lfmd_closes_talk` on the ledger), it is measured against the sign-off
instead, so a recording left running after he has finished does not refuse a good clip. A measure taken from
the caption file was tried and dropped the same day: a caption file cut short would have let 2081 through.

**4. Rebuild anything Kevin asked to be redone** (`render.py redo-requested`)

**5. Write the platform copy** (`platform_copy.py run --pending --limit 2`)
For each episode whose transcript is in and whose copy is not: titles, descriptions and per-platform
copy for all three records, using the Content Machine's own prompts through headless Claude, then
checked against the rules (UK English, no em dashes, banned phrases, Threads and X limits, no figure
that is not in the transcript).

**6. Make the thumbnail** (inside the render step, `thumbnail.py`)
A frame of the 9:16 master in the team's layout, with two title lines from Claude, written to the
episode folder and to `Thumbnail URL`.

**7. Read Kevin's verdicts** (`approval.py sync`)
Whatever he has approved or knocked back on open cards goes onto the episode record: "Approved for
Publishing", or his own words into Feedback. This never publishes anything.

**8. Read the numbers** (`performance.py`)
Every night: public YouTube counts per episode onto the records. Mondays: the GoHighLevel 7-day
platform totals snapshot. The 1st of the month: the full read, plus one card with three
recommendations that become lessons when he approves them.

**9. Raise the approval card** (`approval.py run --pending --limit 2`)
One card per finished episode, once the video, thumbnail and copy are all in. Through the duplicate
gate and `agent-dispatch submit`, so the 08:00 digest counts it and Kevin decides on the AI Agents page.

**10 to 12. Publish anything already approved** (`publish.py sync`, `publish.py run --limit 2`)
Same steps as the daytime job below.

**13. Update the website numbers** (`runpreneur_sync.py run`)
The four "How far I've run" figures and the Strava run name, from Strava, Stripe and GHL.

**14. Update the map** (`runpreneur_map.py run`)

**15 to 19. The morning report lines** (`watch.py report`, `approval.py report`, `publish.py report`,
`runpreneur_sync.py report`, `content_report.py write`)
One line each into the digest, and the Publishing page on the dashboard.

---

## Hourly, 07:15 to 20:15 — publishing and the money

**20. Update the website numbers and map** (`runpreneur_sync.py run --then-map`)

**21. Read Kevin's verdicts** (`approval.py sync`)

**22. Raise any card that became ready** (`approval.py run --pending --limit 2`)

**23. Sync what is already out** (`publish.py sync`) — and this is where the money steps live:

- **23a. Post statuses to links.** GoHighLevel post statuses become published links on the record, in
  both the "Link of ..." fields and the ones the QC page reads.
- **23b. Switch monetisation on.** Every YouTube upload of the episode — the long episode's "Watch page
  ads" and the Short's "Shorts Feed ads". The first switch asks YouTube for a content rating; that is
  Kevin's declaration, so it is answered "None of the above" **only** for an episode whose card he
  approved. Anything else is recorded as `needs-rating` and named in the morning report.
- **23c. Switch mid-roll ads on** *(added 20 Sep 2026)*. For the long episode, once it is earning and
  once it is over 8 minutes. The master switch alone buys a pre-roll and a post-roll; mid-roll is the
  bulk of long-form revenue. An episode under 8 minutes is recorded `not-eligible`, which is an answer,
  not a backlog.
- **23d. Share BOTH Facebook page posts to Kevin's own profile** *(the second one added 20 Sep 2026)*.
  The page publishes two posts an episode: the Summary reel and the Learnings post. Each is found on
  the page itself (GoHighLevel never hands back a post URL), shared as Kevin, to Feed, Public, with the
  first line of the copy and the YouTube link above it. Every share is checked on his profile
  afterwards; one that cannot be confirmed is shared once more and never a third time.
  **A reel goes to his profile once** *(2 Oct 2026)*. The finder matches a caption's first six words, and
  both of 2083's captions opened "Three months after breaking my foot,". Both clips went up at the same
  moment, so the Learnings share found the Summary reel and shared it a second time (2056 the same way).
  Now every reel a share has already taken is skipped by the finder, and Share is never pressed on one
  (`publish.reels_already_shared`). Guarded by `tests/content-engine-fb-share-once.test.js`.
- **23e. Spotify.** Once the video podcast has processed, its public link goes on the record.

**23f. Close the card of a finished episode** (`publish.py close-cards`, daytime job only)
An episode out on every section it owes (a clip never made is not owed) has its card completed through `agent-dispatch.py complete`,
once, with a note carrying the YouTube link. A Completed or Cancelled card is left alone; a refusal is an ERROR once and a
report line ("content cards not closed") until it clears. Until 30 Sep 2026
nothing did this, 2059-2077 sat open for up to two weeks, and the Task Manager read them as unpublished.

**24. Publish every approved episode** (`publish.py run --limit 3`)
Approved episodes only, lowest day number first, two stages. An approved episode never waits for another day
(Kevin, 2 Oct 2026): a day that was sent back, failed to render or has no card yet steps aside, and goes out late,
out of number order, once its own card is approved. Until then one such day held every approved day behind it
(2081 held 2082 and 2083 on 2 Oct). The Publishing page names any day the run has gone past under "Not out yet".

| Stage | What goes out | When |
|---|---|---|
| 1 | The **full episode** to YouTube, direct upload (not through GoHighLevel: its edge refuses files over about 450 MB, cannot set the language, and cannot attach captions) with the thumbnail and the caption file | 06:00 slot |
| 2 | Everything else, the day after the YouTube link exists | below |

Stage 2, per channel and clip:

| Channel | Summary clip | Learnings clip |
|---|---|---|
| YouTube | — | Short, 17:00 |
| Facebook page | reel, 09:00 | post, 17:00 |
| Instagram | reel, 09:00 | reel, 17:00 |
| TikTok | 09:00 | 17:00 |
| LinkedIn | 09:00 | 17:00 |
| Threads | 09:00 | 17:00 |

Plus, the same day: the **blog article** on runpreneur.org.uk through GHL's Blog API with the thumbnail
as header image, and the **podcast** uploaded to Spotify as a video podcast.

**25 to 26. The report lines** (`approval.py report`, `publish.py report`, `runpreneur_sync.py report`,
`content_report.py write`)

---

## The seven sections — how "done" is decided

An episode is only complete when every section it has is done. Anything short shows in the morning report
and on the Publishing page. A clip the render never made is not owed (2 Oct 2026): an episode with no diary
section has no Learnings clip and no Short, the output gate says so, and the page shows those two struck out
as "not in this episode" and counts the episode against five (`publish.owed_sections`, one rule for the card
closer, the hourly line and the page). A clip that was made and not posted still shows as missing.

1. YouTube episode
2. YouTube Short
3. Teaser clips (the Summary, on every social channel)
4. Learnings clips (the LFMD, on every social channel)
5. Blog
6. Podcast
7. Facebook share — **both** page posts on Kevin's profile, confirmed there, not just pressed

Monetisation is reported separately: the morning line names every YouTube upload that is not On, and
every long episode whose mid-roll is not set.

---

## Test mode and live mode

`mode()` reads a file and defaults to **test** until Kevin says live. Test mode runs the whole chain but
keeps it off the public feeds: YouTube goes up unlisted so the link exists and the copy fills, and the
socials are created as drafts in the planner for him to open. Live mode publishes.

---

## Where the human decisions sit

Only three, and only Kevin makes them:

1. **Approve the episode card.** Nothing publishes without it, and approving it is also his content
   rating declaration for YouTube.
2. **Sign in when the robot is signed out.** The Facebook share stops and says SIGN-IN NEEDED rather
   than guessing.
3. **Switch the engine from test to live.**

---

## What was wrong before 20 Sep 2026

Three faults, all of which reported success:

1. **Mid-roll ads were off on 817 of the 888 videos over 8 minutes**, including the three most recent
   long episodes. The master switch was On everywhere, so every report said the channel was monetised.
   It was, at a pre-roll an episode.
2. **Every GoHighLevel upload was skipped in silence.** The monetisation step matched posts on upload
   route, and a GoHighLevel upload carries GHL's post id, not a YouTube one. Episode 2054's episode and
   Short, and episode 2195's episode, were never checked once. The report used the same filter, so they
   were invisible there too.
3. **Only one of the two Facebook page posts reached Kevin's profile.** The Learnings post publishes as
   a plain post, and the finder only ever looked at the page's reels list.

Guarded by `tests/content-engine-ads.test.js`.
