---
name: prospect-daily
description: Daily cold-outbound prospecting agent. Finds founder-led UK micro/small business owners posting pain signals on LinkedIn (assisted browsing via Kevin's Chrome), locates their website and contact email, runs the Companies House entity gate, writes them to the Airtable Prospects table for review, and syncs Approved prospects to GoHighLevel. Use when Kevin says "run the prospecting agent", "find prospects", "/prospect-daily", or when the scheduled daily prospecting task fires.
---

# Prospect Daily — autonomous prospecting run

One run = find qualified prospects (TARGET: 5 per day, Kevin-set 13 Jul; hard cap 20), queue them for Kevin's review in the Prospecting tab, and sync previously-approved prospects to GoHighLevel. Everything is logged to Airtable. Kevin approves before anyone is contacted. Runs 7 days a week.

**Hit 5 every day. Widen the net, do not dilute it (Kevin, 14 Jul).** Work the full persistence ladder in §2a before concluding a run is short — never stop after one or two searches. The bar deliberately favours VOLUME, because these are PUBLIC buying signals (much higher intent than cold scraping) and Kevin would rather review a few imperfect-looking leads than miss a buyer who does not look like the textbook fit.

**A prospect = a founder-led UK micro/small business owner (solo up to ~50 staff) who is publicly showing a buying signal or genuine operational pain.** That is the whole gate. It is industry-agnostic on purpose — the wedge is the SITUATION (founder-led, running everything themselves), not the sector. INCLUDE, do not pre-judge on "fit" or budget (Kevin decides that at review):
- Any owner/founder/director asking for or hiring delegation help: VA, PA, admin, bookkeeper, office manager, OBM, "someone to help with…". Bookkeeper/admin/finance requests COUNT — do not skip them.
- Coaches, consultants, therapists, creatives, trades, retail, hospitality, services — any founder-led small business. A coach BUYING a VA for her own business is a buyer.
- Solo founders running a real trading business count.

EXCLUDE only these (they are not buyers):
- **Supply-side sellers** — VAs, agencies, automation/ops consultants, or anyone marketing THEIR OWN services (a VA advertising availability is supply, not demand). This is the main thing to filter.
- **Direct OD competitors** selling the operations/systemisation cure itself.
- Job-seekers and employees; pre-launch / not-yet-trading ("launch and set up a new brand"); non-UK; already deduped/suppressed.

When genuinely unsure whether someone is a founder-buyer or a seller, lean towards INCLUDING and flag the doubt in the record notes — Kevin's review is the filter, not the agent's caution. If the full ladder is genuinely exhausted and 5 are still not there, report the true number and the channel gap; but with the net this wide plus §2a, a normal day should reach 5.

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
- GHL Location ID: `~/.config/od/ghl_location_id` — MUST be `dgsHwbYbp6xrhRGZr9ik` (the "Operations Director" sub-account, Kevin-confirmed 13 Jul). The Runpreneur sub-account (4ags…UT0) is the property business — tenant SMS lives there; prospects must NEVER be created in it.
- Email sends via GHL conversations REQUIRE `"emailFrom": "kevin@operationsdirector.co.uk"` (the location 500s without it). Dedicated sending domain mail.operationsdirector.co.uk is configured.

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
   **Joining groups is authorised (Kevin, 14 Jul):** when driving Kevin's Chrome you MAY click "Join" on public UK buyer-dense Facebook/LinkedIn groups to widen sourcing (join only — the no-DM/comment/post rule still stands). Prefer public groups (posts are visible immediately); if a group needs admin approval, request to join and note it, then move on. Log every group joined in the report.
2. **LinkedIn** (procedure below)
3. Instagram/TikTok — PARKED (poor search precision, slow identity resolution). Do not use unless Kevin re-opens them. (X and Threads dropped by Kevin 14 Jul — do not use.)

The same hard rules apply on every platform: Kevin's logged-in Chrome only, human pacing, stop for the day on any captcha/restriction warning per platform, and the combined 20-profile-view cap across all platforms.

### 2a. Persistence ladder — work these rungs in order until 5 qualified are queued (added 14 Jul)

Global Facebook post search alone will NOT reliably hit 5: buying-signal phrases get recycled day-to-day (yesterday's buyers are already in the dedupe set), pain phrases return sellers, and global results are polluted by Kevin's Cambridge location bias. Climb the ladder each run and stop only when 5 qualified are queued or every rung is exhausted:

1. **Search INSIDE the watering-hole groups, not just global FB.** This is the highest-yield rung (proven 14 Jul: produced Stefan Gordon + Jordan Curtis). Use the group's own search: `https://www.facebook.com/groups/<id>/search/?q=<term>`. The "I need a UK Virtual Assistant" group id is `1067913934417558`. Cycle buyer-phrasing terms — `looking for a virtual assistant`, `wanted`, `my business`, `our team`, `hiring`, `PA required` — and toggle "Recent posts" on. Company-signal wording ("I'm the owner of…", "we're looking for…", "our busy company", "join our team") flags a real SME; a named business is resolvable to a website/email/Companies House.
2. **Rotate additional watering-hole groups, and JOIN more when supply is thin** (Kevin authorised join-on-his-behalf, 14 Jul). One group over-mined = the same recycled posts, so widen. Known UK buyer-dense groups: "I need a UK Virtual Assistant" (1067913934417558), "UK Association of Virtual Assistants" (groups/UKVirtualAssistants), "Virtual Assistant Uk" (1312350108818227). Actively search out and JOIN more UK "find a VA / PA / OBM", "small business owners UK", trades/industry owner groups, and local-business networking groups — a wider group set is the single biggest lever on hitting 5/day. (Groups that are VA-to-VA networking are supply-side and thin on buyers — deprioritise.) Also mine LinkedIn the same way: content search + relevant UK founder/owner groups.
3. **Comment-mine** high-engagement seller pain posts (LinkedIn relevance sort, or a busy FB pain post) for founders replying "this is me".

**Resolution rung (so strong signals still count):** when a candidate clearly IS an ICP founder-buyer but the business is unnamed/unresolvable to a website+email (common — most group buyer posts do not name the company), still queue them with Entity Type = Unknown and Contact Route = "No route yet"; Kevin makes first contact himself via the group/Messenger. A strong, honestly-graded "No route yet" lead counts toward 5; a poor-fit coach with a tidy email does not.

**When still short after the full ladder:** say so plainly in the report, name what limited supply (e.g. "only one VA group mined; buying phrases recycled"), and join more groups next run to widen the net.

When writing Prospects records with a Signal Source not yet in the select options (e.g. "Facebook Group Post"), add `"typecast": true` to the curl POST body so Airtable auto-creates the option.

For each chosen keyword on LinkedIn:
- Load the claude-in-chrome tools via ToolSearch if not loaded. Confirm Chrome is connected; if not, stop and report "Chrome not available — run skipped".
- Go to `https://www.linkedin.com/search/results/content/?keywords=<encoded keyword>&sortBy=%22date_posted%22` for pain phrases/hashtags. Read the visible results with get_page_text / read_page rather than heavy interaction. Scroll at most 3-4 times per keyword.
- Candidate = the post author showing a buying signal (asking for/hiring a VA, PA, admin, bookkeeper, OBM, "someone to help with…") OR genuinely expressing operational pain (overloaded founder, no time, doing everything themselves, can't switch off). Ignore only the SUPPLY side — VAs/agencies/consultants marketing their own services — plus job-seekers and employees. A coach or consultant who is BUYING help for their own business is a prospect, not a competitor; only exclude those SELLING the operations/systemisation cure itself.
- **Seller test (learned 13 Jul 2026):** most pain-phrase search results are sellers marketing TO the pain. Genuine prospects write first-person, present-tense, incidental pain ("I'm juggling everything", "quiet week panic") — sellers write second-person, listicle, hashtag-heavy posts ending in a CTA. Check the author's headline before counting anyone: if it says coach / mentor / consultant / agency / automation / "I help founders...", skip. Past-tense pain ("the biggest mistake I made was...") from someone now selling the cure = seller.
- **Comment mining:** when a seller's pain post has real engagement, open the post and read its comments — founders who reply "this is me" or share their own version of the pain ARE prospects. Qualify commenters exactly like authors. This often out-produces the search results themselves.
- Quoted exact phrases return sparse results; run each keyword both quoted and unquoted when results are thin, and try the default relevance sort as well as date_posted — relevance surfaces high-engagement posts whose comments are mineable.
- For each candidate (respecting the pacing and the 20-profile cap across the whole run): open their profile, read name, headline, location, current company. Qualify if ALL of (targeting per the 2026-06-17 Sales & Marketing Team Brief in Drive — the canon, widened by Kevin 14 Jul to favour volume):
  - Founder-led signal: Founder / Co-founder / CEO / Owner / Director of their own business. Founder-led, not PE-owned, not corporate.
  - UK-based
  - Micro/small business: solo up to about 50 staff. Do NOT screen on turnover, budget, or industry — a small operation with a buying signal is in; Kevin judges fit and budget at review.
  - Publicly showing a buying signal or operational pain (see candidate rule above)
  - Not already in the dedupe or suppression set
  - Not supply-side (see exclusions in the intro)
- **The five hot-buttons (from real sales calls — every prospect should map to at least one):** (1) you ARE the business; (2) drowning in hours; (3) it's all in your head, no systems; (4) flying blind on the numbers; (5) tools a mess, money wasted on software. Verbatim customer phrases double as search keywords: "my business is me", "not enough hours in my day", "it's all in my head", "I can't tell you my profit".
- Capture: full name, LinkedIn profile URL, headline, company name, the pain quote (short, verbatim where possible), signal source (Post/Profile/Comment), keyword matched.

### 2b. Job-ad mining — the primary volume engine (added 15 Jul 2026, Kevin-authorised)

Public FB buyer posts are ~1-2/week from one recycled group and cannot supply 5/day. The reliable engine is UK SMEs ACTIVELY HIRING a delegation/ops role. A small UK business advertising for a Virtual Assistant, Executive Assistant, PA, Office Manager/Administrator, Operations Assistant/Manager, Admin Assistant, or Bookkeeper is a prime OD prospect: named company (so website + email + Companies House are all resolvable), proven budget, dated active intent, and OD's exact wedge is "don't hire another person, get an AI-run operations department". **Work this rung FIRST every run; it refills daily.**

Sources, in order:
1. **LinkedIn Jobs via Kevin's Chrome** (human pace, same stop-on-friction rule + shared 20-view cap). Search each role term with location United Kingdom, sort by Most recent. Open the listing, read the EMPLOYER. Qualify the employer, not the role.
2. **Open-web job search via WebSearch/WebFetch** across Indeed UK, Reed, Gumtree, CV-Library, Totaljobs and company career pages. Search the role + "UK" + small-business qualifiers; open the employer's OWN site for the published application email. (Open web only — this is not LinkedIn scraping.)
3. Then the **FB group roster (§2a)** as top-up.

Qualify the employer:
- INCLUDE: founder-led / owner-managed UK micro/small business (solo up to ~50 staff) hiring the role directly. The job ad IS the buying signal — imperfect-but-real beats empty (Kevin, 15 Jul: widen the net, five a day is the floor).
- EXCLUDE: recruitment agencies posting for an unnamed client (resolve to the real employer if the ad names it, else skip); large/corporate/PE-owned/franchise employers; public sector; non-UK; and any VA/agency hiring sub-contractors (supply-side).
- Resolve the named employer to website (§3) → published email (§3) → Companies House entity (§4). Most will be Limited Company → email-sequenceable (PECR gate still applies — Ltd only).
- Draft message references the SPECIFIC role they are hiring for, then pivots to the OD wedge (an AI-run ops department instead of, or alongside, that hire). Contact Route by the §4.5 tree (Ltd + published email → "Email sequence (Ltd)"; else LinkedIn connect / contact form / no route yet).
- Signal Source = "Job Ad (<board>)" (typecast). Keyword Matched = the role searched.

Daily order of operations: work §2b to 5 qualified first; only drop to FB groups (§2a) to top up or when the job boards are genuinely thin.

### 3. Website + contact email (open web, no LinkedIn)

For each qualified candidate, using WebSearch/WebFetch (not the browser):
- Find the company website: from their LinkedIn profile/company page if visible, else search `"<company>" <name> UK`.
- Find a contact email on the site. **Check ALL of these before concluding "no email" (two real misses on 13 Jul):** the contact page, the homepage INCLUDING footer, the about page, and `/privacy-policy` (privacy policies nearly always contain a contact address). WebFetch truncates long pages — ask it specifically for email addresses, and try the privacy page even when other pages look empty.
- **Booking-platform sites count as the website.** If the main domain is dead or absent, check their Treatwell/Fresha/Squarespace-booking presence — the contact section usually publishes an email (Dr Raghda's was on her mytreatwell page after her main domain failed DNS). If WebFetch cannot resolve a domain, retry it through Kevin's Chrome before declaring it dead.
- Confidence: High = a named/direct address; Medium = generic (info@/hello@/contact@); Low = found off-site or uncertain. No email found is acceptable — still queue the prospect (Kevin may connect on LinkedIn instead).

### 4. Companies House entity gate

- Search the public register: `https://find-and-update.company-information.service.gov.uk/search?q=<company name>`.
- Confident active match → Entity Type = "Limited Company" + record the company number.
- No plausible match → "Sole Trader / Partnership" if the site/profile suggests a trading individual, else "Unknown". When unsure, choose "Unknown" — the gate errs on the side of NOT emailing.

### 4.5 Contact route + draft message (per candidate)

Set **Contact Route** by this decision tree:
1. They publicly ASKED for help (buying signal) and an email/form exists → "Email reply (they asked)" — solicited, any entity type, reply same day.
2. Limited Company + published email (pain signal, unsolicited) → "Email sequence (Ltd)".
3. No email but LinkedIn profile found → "LinkedIn connect" (Kevin sends personally, 2-3/day max).
4. Website form only → "Website contact form".
5. Otherwise → "No route yet".

Write a **Draft Message** tailored to the person and route. Voice = Kevin's: direct, spartan, UK English, no hype words, no em dashes. Shape: (1) reference exactly what they posted, (2) one sentence on what Operations Director does for someone in their position (an AI-run operations department, not another VA), (3) soft CTA to a call with the booking link `https://api.leadconnectorhq.com/widget/booking/BcVVhAg1zLaPVEXj5ih0` (Kevin-confirmed calendar, 13 Jul — say "a quick call"). Under 90 words for email replies, under 40 for LinkedIn connect notes (no link in connect notes; the link goes in the post-accept message). Never fake familiarity; say where we saw their post.

### 5. Write to Airtable

- Create one Prospects record per candidate via curl (Number()-cast any numerics, 500ms between writes, `"typecast": true`):
  - Status = "Ready for Review", Date Found = today (ISO), Contact Route, Draft Message, plus every captured field.
- Update each keyword used: Last Used = today, Prospects Found += number of new prospects it produced.

### 6. First-contact pass (conversation-first — Kevin's design, 13 Jul)

The principle: every emailed prospect gets a PERSONAL first message and a led conversation. The nurture sequence is the FALLBACK for silence, Ltd companies only. Manual-track prospects are never sequenced, ever.

For each prospect with Status = "Approved" (Kevin approved the card AND its draft message):
- **Email routes** (reply / intro / Ltd): SEND the approved Draft Message as an email THROUGH GoHighLevel (POST `https://services.leadconnectorhq.com/conversations/messages`, type Email, contactId, subject + html), so the whole conversation lives in GHL and never touches the team-managed Gmail inbox. The Prospecting tab usually does this at approve time; the agent pass is the catch-up for any still sitting at "Approved" or "Synced to GHL". NEVER send while the text still contains `[BOOKING-LINK]` — flag it to Kevin instead. Fallback if GHL email sending is unconfigured: create a Gmail DRAFT for Kevin and say so in the report.
- **Website contact form route**: submit their site's contact form with the approved message text via the browser (the message was individually approved, which is the send authorisation).
- **All emailed/form prospects**: ensure they exist in GHL as a CRM contact — POST `https://services.leadconnectorhq.com/contacts/` (headers `Authorization: Bearer <token>`, `Version: 2021-07-28`; token from ~/.config/od/ghl_api_key or report it missing) with name, email, companyName, source "od-prospecting", locationId, tags `od-prospect` (+ `od-prospect-manual` if not a Limited Company). Do NOT apply `od-prospect-nurture` here. On duplicate response reuse meta.contactId. 500ms between calls, back off on 429.
- Set Status = "Contacted (1:1)" (typecast) and Next Follow-up = today + 7 days. Record GHL Contact ID.
- **LinkedIn connect routes (Kevin authorised agent sends, 13 Jul)**: send the connection request from Kevin's Chrome — MAX 3 per day, human pacing, no more than one every few minutes, plain connect (use the draft as the message after they accept, not as a connect note). The stop-on-friction rule is absolute: any LinkedIn warning ends ALL LinkedIn activity for the day. Report every connect sent.

### 6b. Follow-up pass (every run)

For each prospect with Status = "Contacted (1:1)" and Next Follow-up ≤ today:
- Check the prospect's GHL conversation for inbound replies (GET conversations search by contactId — same API the sms-email-bridge worker uses). Also search Kevin's Gmail for their address as a belt-and-braces check; if a prospect reply IS found in Gmail, apply the label **"17: OD Prospects"** (Label_940887198997874147) so the Inbound Comms team knows to leave the thread alone.
- **Labelling safety rules (Kevin, 13 Jul — tenant SMS also flows through GHL):**
  1. Label a thread ONLY when the sender address exactly matches a Contact Email in the Prospects table. The prospect's address is the key — never the platform.
  2. NEVER label based on a message merely coming from or mentioning GoHighLevel/LeadConnector — GHL system notifications, tenant SMS-bridge emails, and workflow alerts must never receive this label.
  3. When unsure, do not label; note it in the report instead. A missed label is recoverable; a tenant thread pulled out of the team's flow is not.
- **Reply found** → Status = "Replied", flag it prominently in the report, and draft a suggested response (send via GHL after Kevin approves it, or leave as a pending draft in the record Notes). Track what wording gets replies vs silence and feed it back into future drafts.
- **No reply + Limited Company** → add tag `od-prospect-nurture` to their GHL contact (PUT the contact's tags), Status = "In Sequence". The 3-email sequence takes over.
- **No reply + manual track** → send ONE polite follow-up via GHL the first time (note it in the record), and after a second silent week set Status = "No Response" and stop. NEVER add manual-track contacts to any email workflow.

**Sequence timeout (Status = "In Sequence"):** 14 days after enrolment (the 3 emails span ~10 days), check for any reply. Reply → "Replied". Nothing → Status = "No Response". No prospect ever sits in a stage forever.

**"No route yet" prospects:** these wait for Kevin's one personal action (e.g. a Facebook message from his account). When he confirms he has made contact, set Status = "Contacted (1:1)" + Next Follow-up +7 days so the conversation is tracked like any other.

**LinkedIn lane lifecycle (Status = "Connect Sent"):** each run, check Kevin's sent invitations (linkedin.com/mynetwork — read-only look). Accepted → send the already-approved Draft Message as the first LinkedIn message (this is the send Kevin pre-approved on the card), Status = "Contacted (1:1)", Next Follow-up = +7 days. Not accepted after 14 days → Status = "No Response" (do not withdraw, do not retry). Any inbound LinkedIn reply → Status = "Replied", draft a response for Kevin's approval in the report.

**Draft freshness:** Kevin may approve cards days after they were found. At send time, if Date Found is older than ~10 days, soften the post reference ("saw your post a little while back") before sending — never send wording that pretends the post was yesterday.

**Accuracy tracking (the autonomy gate metric):** every run, compute and report: prospects reviewed to date, approved vs rejected, current approval rate, and the rate over the trailing 14 days. The Prospecting tab shows the same number on its Agent accuracy card. When the trailing-14-day rate exceeds 90% with meaningful volume, remind Kevin the auto-approve proposal is available (see 6c).

### 6c. Autonomy roadmap (NOT yet active)

Kevin's end state: he first sees a prospect when the call lands in his diary. The review gate stays until quality is proven: once Kevin's approval rate exceeds 90% across 2 consecutive weeks, propose switching high-confidence prospects (buying signal + Ltd + High email confidence + no [BOOKING-LINK] placeholder) to auto-approve-and-send, with a daily digest instead of per-card review. Do not enable this without Kevin's explicit yes — track the approval stats in the report from day one.

### 8. Learning loop (self-evolution — run at the END of every run)

**North star: calls ATTENDED.** The full chain is found → contacted → replied → booked → attended. Each run, compute the funnel numbers and identify the current bottleneck stage; bias the next run's effort toward it (more finding, sharper drafts, faster follow-ups, or reminder tuning).

1. **Keyword evolution:** using each prospect's Keyword Matched field, score keywords by what they produced DOWNSTREAM (approvals, replies, calls — not just finds). After a keyword has been used 4+ times with zero approved prospects, deactivate it (never delete; note why in its Notes). When producing posts reveal new first-person pain language, add at most 2 new keyword variants per week, marked "agent-proposed" in Notes.
2. **Playbook write-back:** any repeatable discovery (where an email was hiding, which group produced, which platform pattern worked or failed, which draft wording got a reply) gets appended as ONE dated bullet to the "Learned playbook" section at the bottom of this file. Keep it curated: merge duplicates, prune bullets disproven later. This is how the agent gets permanently smarter.
3. **Draft evolution:** track which opener styles get replies (the Pain Signal + Draft Message of Replied prospects vs silent ones). Fold winning patterns into the drafting rules in §4.5 by editing them — with a dated note of what changed and the evidence.
4. **Attendance loop:** read appointment outcomes from GHL for booked calls. If no-shows exceed 1 in 3, say so in the report and propose reminder-sequence changes to Kevin.
5. **Evidence bar:** at 5 prospects/day the numbers are small — never change anything on fewer than 4 data points, and log EVERY self-change in the daily report so Kevin sees each mutation.

**IMMUTABLE — the agent must NEVER self-modify these, regardless of what it learns:** the Hard rules section (scraping ban, stop-on-friction, volume caps, PECR gate, suppression, published-emails-only, secrets), the approval gate while it is active, targeting canon, and spend. Changes there are proposed to Kevin, never applied. Better conversion never justifies breaking compliance.

### 7. Report

Send Kevin a short Slack DM (slack connector) and end with the same summary:
`Prospecting run <date>: <n> found → review queue | <m> synced to GHL | keywords used: <list> | <any warnings: LinkedIn friction, GHL skipped, 0 results>`

Keep it honest — a zero-result run says so plainly, with the likely reason. Include the full funnel (found → contacted → replied → booked → ATTENDED), the current bottleneck, and any self-changes made by the learning loop.

---

## Learned playbook (agent-maintained — append dated bullets via §8 only)

- 2026-07-13: Privacy policies nearly always publish an email when the contact page shows only a form (Lucy Williams case).
- 2026-07-13: Booking-platform pages (Treatwell/Fresha) count as the prospect's website; check their contact section when the main domain is dead (Dr Raghda case). Retry dead domains through Kevin's Chrome before giving up.
- 2026-07-13: Pain-phrase searches surface ~90% sellers; buying-signal searches ("recommend a virtual assistant") out-produce them — 3 of 5 day-one prospects. The FB group "I need a UK Virtual Assistant" is a standing source.
- 2026-07-13: Sellers write second-person listicles with CTAs; genuine prospects write first-person, present-tense, incidental pain. Past-tense pain from someone selling the cure = seller.
- 2026-07-15: The "I need a UK Virtual Assistant" group recycles buyer posts fast. Every buyer-term search (looking for a VA, PA required, need someone to help, VA wanted, join our team, medical secretary) plus the Recent-posts toggle and the chronological group feed all returned the SAME ~5 posts already captured 13-14 Jul, because the group produces only ~1-2 NEW buyer posts a week against a flood of daily seller posts. Day-to-day yield from this single group is near zero once its recent batch is in the pipeline.
- 2026-07-15: Global FB post search "recommend a virtual assistant UK" and LinkedIn content search "looking for a virtual assistant" (date sort) were 100% sellers / job-seekers / offshore agencies. These phrasings surface supply, not demand. Low value; deprioritise.
- 2026-07-15: The alt group "Virtual Assistant Uk" (1312350108818227) is US/Philippines agency-hiring, not UK buyers. The public group "UK Small Business Owners" / uksmallbusinessesadvertsfree (31K, joined this run to widen) is promo/seller-heavy: its top posts are "share your business in comments" threads and VA/EA/automation sellers. Widening to generic SB groups did NOT help. Next lever: find and join more NARROW UK owner/industry groups (trades, hospitality, coaching, "find a bookkeeper/PA" groups) rather than broad SB or VA groups, both of which are saturated with supply.
- 2026-07-15: REAL bottleneck is not finding, it is the review gate. 11-12 prospects sit at "Ready for Review" with zero approved since 13 Jul, so nothing can move to contact. More finding cannot unblock the funnel until Kevin reviews the queue.
- 2026-07-15 (JOB-AD ENGINE — the fix for 5/day): browse Indeed UK in Kevin's Chrome, NOT WebFetch. WebFetch on Indeed/Reed/Gumtree list pages only returns the sponsored top slice (big corporates + agencies) and looks empty of SMEs; the Chrome-rendered page shows every listing including small direct employers. This single tooling switch turned a 1-prospect day into 5.
- 2026-07-15: Filters that isolate small founder-led employers on Indeed: (a) job-type = part-time — append `&sc=0kf%3Ajt(parttime)%3B` — surfaced Signature Hosts Ltd, The Code Zone Ltd and small e-commerce sellers; (b) query `amazon virtual assistant` / `ecommerce virtual assistant` — small UK Amazon/eBay sellers hiring cheap remote help, near-pure ICP (Picture Frames UK, Beviqua Ltd). Broad `virtual assistant` sorted by date is polluted by corporate "assistant" roles past page 1; the freshest small ads sit at the very top of page 1.
- 2026-07-15: Small-business job ads usually publish the application email IN the ad body ("How to Apply: email your CV to X"). Use it, but the PECR gate still applies: confirm Limited Company on Companies House before any sequence; Unknown/Sole Trader = never cold-emailed even when the ad shows an email (Picture Frames UK: gmail + "20 years" claim vs a 2017 incorporation = Unknown -> No route yet).
- 2026-07-15: LinkedIn Jobs broad-matches to big VERIFIED employers (MANGO, Specsavers, Williams F1, Deloitte, Citi) and ranks them top even sorted by date; low yield for SMEs. Deprioritise LinkedIn Jobs vs Indeed-in-Chrome.
- 2026-07-15: Companies House is fast/reliable via WebFetch on find-and-update.company-information.service.gov.uk/search?q=NAME — exact registered name + number + status + incorporation date for the PECR gate. Run it on every job-ad employer.
- 2026-07-16 (BEST SINGLE QUERY so far): the role-term OR query `"personal assistant" OR "executive assistant" OR "office manager"` on Indeed + part-time filter + date sort produced 3 of 5 today (Geo Expert Search, Arona St James, Freight Link Solutions). It beats broad `virtual assistant`, which is swamped by care/rehab/healthcare "assistant" roles that share the word but are not delegation hires.
- 2026-07-16: `"operations assistant" OR "bookkeeper" OR "admin assistant"` (part-time) works BUT filter by who the role serves: accountancy/bookkeeping PRACTICES (Alliott Wingham, Beatons, Sharp Bookkeeping, 123 Easy Books) hire bookkeepers as DELIVERY capacity for clients, not to delegate the owner's own load — weak ICP. The strong ones are non-finance SMEs hiring their FIRST bookkeeper/admin (Goodland, North Product Design). Ask: does this hire serve the owner, or the customers?
- 2026-07-16: Recruitment ADVERTISERS masquerade as SME employers. Equals One Ltd (Leeds, flat-fee job-board advertising since 2000) posts small-looking ads for unnamed clients. Exclude per §2b. Tell-tale: one employer posting many unrelated roles across regions.
- 2026-07-16: Some prospect sites sit behind bot-verification walls (aronastjames.co.uk). NEVER bypass one — it is a hard rule and a safety rule. Fall back to the address published in directory listings (Yelp / 192.com / allinlondon) which counts as a published source, and grade it Medium. Do not guess.
- 2026-07-16: Fast size disqualifier before spending effort: incorporation age + branch count. Access Garage Doors (inc. 1976, 5 showrooms across the South East) ran a textbook "PA to Managing Director" ad but is far beyond micro/small. Check Companies House date and the site's location count FIRST.
- 2026-07-16 (BOTTLENECK, 2nd day running): 21 prospects now sit at "Ready for Review", 0 approved, 0 contacted, 0 replied, 0 booked, 0 attended — nothing has EVER left the review gate since the pipeline started on 13 Jul. The finding engine is not the constraint and more finding cannot move the north star (calls attended). Every future run should lead its report with this until Kevin reviews the queue.
- 2026-07-17 (SOLE-DIRECTOR TELL — best ICP filter found so far): Companies House `/company/<number>/officers` states "N officers / M resignations" and names every director. **"1 officer / 0 resignations" is the strongest founder-led micro signal available**, and it is free, public and instant. It confirmed Mach 4 Solutions (Tim Good) and Artifact Lighting (Gregory Bailey) as owner-does-everything businesses in one fetch each. Run /officers on every job-ad employer: it gives the founder's NAME for the draft opener AND grades the ICP. Two directors appointed at incorporation (Neatwork) = co-founder micro, also strong.
- 2026-07-17 (EMAIL-GUESSING TRAP — hard rule nearly broken): searching a company + "contact" surfaces email-permutation sites (prospeo.io, contactout.com, rocketreach) presenting a GUESSED pattern (e.g. "john@psychworks.org.uk") as if published. These are pattern-guesses and are banned by hard rule 6. Never take an address from an email-format/lead-database site; only the company's own site or a directory listing of their real address.
- 2026-07-17 (NAMESAKE TRAP — nearly emailed the wrong company): psychworks.org is a US company in Los Angeles; the UK prospect is psychworks.org.uk. A search for "<company> contact" happily returns a same-named foreign business with a plausible info@ address. Always confirm the site's own address/location matches the Companies House record BEFORE trusting its email.
- 2026-07-17: WebFetch silently truncates some small-business sites ("[Content truncated due to length...]") and returns nothing useful even for a short contact page (mach4engineering.com failed twice). Chrome `get_page_text` read the same page instantly, giving the address AND "Tim Good Managing Director". Same lesson as the Indeed one: when WebFetch looks empty, retry in Chrome before concluding "no email".
- 2026-07-17: Both job-ad OR-queries are now logged as keywords in the Prospect Keywords table (agent-proposed) so the engine is scoreable: the PA/EA/office-manager query has produced 3 of 5 on two consecutive runs; the VA/ops-assistant/business-support query produced 2 of 5. Reliable ~5/day without touching LinkedIn at all — 0 profile views, 0 friction risk.
- 2026-07-17: The §8.1 rule "deactivate a keyword after 4+ uses with zero approved prospects" is UNUSABLE while the review gate is untouched — zero prospects have EVER been approved, so scoring on approvals would deactivate every keyword regardless of quality. Do not apply that rule until Kevin has reviewed a batch; score on finds until then, and say so.
- 2026-07-22 (NEW BEST-YIELD QUERY): `"assistant to the owner" OR "business administrator" OR "accounts assistant"` (Indeed, UK, part-time, date sort) produced 3 of 5 on its first use (Balloon Land, Mapperley PM, My Student Digs) and is now logged as a keyword. It reaches SMEs the PA/EA/office-manager query misses, because micro businesses title their first back-office hire "business administrator" or "accounts assistant", not "executive assistant".
- 2026-07-22: The PA/EA/office-manager query is now visibly recycling. Page 1 was ~70% public sector, care, nurseries, councils and multi-site employers (Cabinet Office, NHS, Busy Bees, Select Car Leasing's 250-person head office), and two of its genuine SMEs (Arona St James, Freight Link) were already captured on 16 Jul. It still yields 2 a day but no longer 3-4; rotate a second OR-query alongside it every run.
- 2026-07-22 (FAST SIZE DISQUALIFIER, confirmed again): officer count beats guesswork. Giro Food Limited (00947901) looked like an ideal small Birmingham food business hiring a part-time accounts assistant, but /officers shows "14 officers / 8 resignations" and incorporation in 1969. Run /officers BEFORE resolving website and email; it costs one fetch and killed a bad lead in seconds.
- 2026-07-22 (SISTER-COMPANY EMAIL): the employer on an ad is often a group entity with no site of its own. Argo Homes Property Group Ltd (14394162) has no website; the group's site argohomesltd.co.uk belongs to Argo Homes Ltd (11117994) at the SAME registered address. Treat that as a published address but grade it Medium and say so in Notes. Same address + same director = same group, and is NOT the namesake trap (which is same NAME, different address).
- 2026-07-22 (BOTTLENECK, 8th day running): 52 prospects now sit at "Ready for Review". 0 approved, 0 rejected, 0 contacted, 0 replied, 0 booked, 0 attended since the pipeline started on 13 Jul. The finding engine has now delivered ~5/day for a week and cannot move the north star. Nothing in §6, §6b or §6c can run at all while the queue is untouched, so every run is currently find-only.
