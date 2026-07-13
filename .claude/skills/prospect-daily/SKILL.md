---
name: prospect-daily
description: Daily cold-outbound prospecting agent. Finds founder-led UK micro/small business owners posting pain signals on LinkedIn (assisted browsing via Kevin's Chrome), locates their website and contact email, runs the Companies House entity gate, writes them to the Airtable Prospects table for review, and syncs Approved prospects to GoHighLevel. Use when Kevin says "run the prospecting agent", "find prospects", "/prospect-daily", or when the scheduled daily prospecting task fires.
---

# Prospect Daily — autonomous prospecting run

One run = find qualified prospects (TARGET: 5 per day, Kevin-set 13 Jul; hard cap 20), queue them for Kevin's review in the Prospecting tab, and sync previously-approved prospects to GoHighLevel. Everything is logged to Airtable. Kevin approves before anyone is contacted. Runs 7 days a week. Quality beats the target: never pad the queue with weak prospects to hit 5 — the funnel maths (prospect→client ≈ 2%) only holds at the quality bar.

## Hard rules (never break these)

1. **No scraping tools.** LinkedIn is browsed only through Kevin's logged-in Chrome via the claude-in-chrome tools, at human pace. Never use HTTP requests, scripts, or third-party scrapers against LinkedIn.
2. **Stop on friction.** If LinkedIn shows a captcha, verification prompt, "unusual activity" notice, or any restriction warning: stop all LinkedIn browsing immediately for the day, note it in the report, and continue the rest of the pipeline with what was already collected.
3. **Volume caps.** Max 20 prospect profiles viewed per run. Max 1 run per day. Pause 5-15 seconds between LinkedIn page loads (vary it).
4. **PECR gate.** Only prospects with Entity Type = "Limited Company" may ever be tagged for the email sequence. Sole Trader / Partnership / Unknown get the manual-track tag and are never cold-emailed.
5. **Suppression is forever.** Before creating any prospect or GHL contact, check the existing Prospects table: if the person's email or LinkedIn URL matches a record with Status = Suppressed, skip them permanently.
6. **Emails only from published sources.** Use only addresses published on the company's own website or public profile. Never pattern-guess addresses (no firstname@domain guessing). Record the source and an honest confidence.
7. **Never print secrets.** Read token files silently; never echo their contents into output, logs, or Airtable.

## Config

- Airtable PAT: `~/.config/od/airtable_pat` (curl, base `appnqjDpqDniH3IRl`)
- Prospects table: `tbljHVGJoKJf8acy3` — field IDs in `js/config.js` (`PROSPECT` map)
- Prospect Keywords table: `tblB5tZrXNaKFe02j` (`PKEY` map)
- GHL Private Integration token: `~/.config/od/ghl_api_key` (optional — if missing, skip step 6 and tell Kevin what to create)
- GHL Location ID: `~/.config/od/ghl_location_id`

## Procedure

### 1. Load state from Airtable

- Fetch all Prospect Keywords where Active is true. Sort by Last Used ascending (never-used first). Pick the top 2-3 for this run.
- Fetch all existing Prospects (paginate). Build a dedupe set of LinkedIn URLs (lowercased, path only) and emails, and a suppression set from Status = Suppressed records.

### 2. Pain-signal search (assisted browsing, Kevin's Chrome)

Platforms, in priority order (rotate 2-3 per run so no single platform gets heavy daily automation):
1. **Facebook — BEST PRODUCER (proven 13 Jul: 3 of 5 day-one prospects).** Post search `https://www.facebook.com/search/posts/?q=<encoded phrase>`, read-only research. Two search modes:
   - **Buying signals (highest yield):** "recommend a virtual assistant", "recommend a VA", "need help with my admin", "looking for someone to help with" — people asking for delegation help are active buyers. The group "I need a UK Virtual Assistant" is a standing watering hole; check it every run.
   - Pain phrases (same keywords as LinkedIn).
   NEVER DM group members, comment, or post from Kevin's account; qualified members are contacted via their business website or LinkedIn instead.
2. **LinkedIn** (procedure below)
3. **X (Twitter)** — `https://x.com/search?q=<encoded keyword>&f=live`. BLOCKED until Kevin logs into X in Chrome (checked 13 Jul: logged out). Resolve handle → real name → business → website before counting anyone.
4. **Threads** — `https://www.threads.com/search?q=<encoded keyword>`. BLOCKED until Kevin logs in (checked 13 Jul: search is login-gated).
5. Instagram/TikTok — PARKED (poor search precision, slow identity resolution). Do not use unless Kevin re-opens them.

The same hard rules apply on every platform: Kevin's logged-in Chrome only, human pacing, stop for the day on any captcha/restriction warning per platform, and the combined 20-profile-view cap across all platforms.

When writing Prospects records with a Signal Source not yet in the select options (e.g. "X Post", "Threads Post", "Facebook Group Post"), add `"typecast": true` to the curl POST body so Airtable auto-creates the option.

For each chosen keyword on LinkedIn:
- Load the claude-in-chrome tools via ToolSearch if not loaded. Confirm Chrome is connected; if not, stop and report "Chrome not available — run skipped".
- Go to `https://www.linkedin.com/search/results/content/?keywords=<encoded keyword>&sortBy=%22date_posted%22` for pain phrases/hashtags. Read the visible results with get_page_text / read_page rather than heavy interaction. Scroll at most 3-4 times per keyword.
- Candidate = the post author of a post genuinely expressing the pain (overloaded founder, no time, doing everything themselves, can't switch off). Ignore coaches/consultants SELLING a solution to the pain — they are competitors, not prospects. Ignore job seekers and employees.
- **Seller test (learned 13 Jul 2026):** most pain-phrase search results are sellers marketing TO the pain. Genuine prospects write first-person, present-tense, incidental pain ("I'm juggling everything", "quiet week panic") — sellers write second-person, listicle, hashtag-heavy posts ending in a CTA. Check the author's headline before counting anyone: if it says coach / mentor / consultant / agency / automation / "I help founders...", skip. Past-tense pain ("the biggest mistake I made was...") from someone now selling the cure = seller.
- **Comment mining:** when a seller's pain post has real engagement, open the post and read its comments — founders who reply "this is me" or share their own version of the pain ARE prospects. Qualify commenters exactly like authors. This often out-produces the search results themselves.
- Quoted exact phrases return sparse results; run each keyword both quoted and unquoted when results are thin, and try the default relevance sort as well as date_posted — relevance surfaces high-engagement posts whose comments are mineable.
- For each candidate (respecting the pacing and the 20-profile cap across the whole run): open their profile, read name, headline, location, current company. Qualify only if ALL of:
  - Founder-led signal: title contains founder / owner / MD / director of their own small company
  - UK-based
  - Micro/small business (solo to ~10 staff, judge from profile/company page)
  - Not already in the dedupe or suppression set
- Capture: full name, LinkedIn profile URL, headline, company name, the pain quote (short, verbatim where possible), signal source (Post/Profile/Comment), keyword matched.

### 3. Website + contact email (open web, no LinkedIn)

For each qualified candidate, using WebSearch/WebFetch (not the browser):
- Find the company website: from their LinkedIn profile/company page if visible, else search `"<company>" <name> UK`.
- Find a contact email on the site (contact page, footer, about). Confidence: High = a named/direct address; Medium = generic (info@/hello@/contact@); Low = found off-site or uncertain. No email found is acceptable — still queue the prospect (Kevin may connect on LinkedIn instead).

### 4. Companies House entity gate

- Search the public register: `https://find-and-update.company-information.service.gov.uk/search?q=<company name>`.
- Confident active match → Entity Type = "Limited Company" + record the company number.
- No plausible match → "Sole Trader / Partnership" if the site/profile suggests a trading individual, else "Unknown". When unsure, choose "Unknown" — the gate errs on the side of NOT emailing.

### 5. Write to Airtable

- Create one Prospects record per candidate via curl (Number()-cast any numerics, 500ms between writes):
  - Status = "Ready for Review", Date Found = today (ISO), plus every captured field.
- Update each keyword used: Last Used = today, Prospects Found += number of new prospects it produced.

### 6. GHL sync (Approved → GoHighLevel)

- Fetch Prospects with Status = "Approved".
- If the GHL token file is missing: leave them untouched and report "GHL sync skipped — create a Private Integration token (Settings → Private Integrations, scope contacts.write) and save it to ~/.config/od/ghl_api_key, plus the Location ID to ~/.config/od/ghl_location_id".
- Otherwise for each approved prospect:
  - POST `https://services.leadconnectorhq.com/contacts/` (headers: `Authorization: Bearer <token>`, `Version: 2021-07-28`) with name, email, companyName, source "od-prospecting", locationId, and tags:
    - Limited Company → `od-prospect-nurture` (Ericamae's sequence triggers on this tag when live)
    - anything else → `od-prospect-manual` (never enters an email workflow)
  - On success: PATCH the prospect — GHL Contact ID, Status = "Synced to GHL".
  - On duplicate-contact response: reuse the returned contact id, same PATCH.
  - 500ms between calls; on 429 back off exponentially.

### 7. Report

Send Kevin a short Slack DM (slack connector) and end with the same summary:
`Prospecting run <date>: <n> found → review queue | <m> synced to GHL | keywords used: <list> | <any warnings: LinkedIn friction, GHL skipped, 0 results>`

Keep it honest — a zero-result run says so plainly, with the likely reason.
