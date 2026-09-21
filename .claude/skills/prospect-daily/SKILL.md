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
- Prospecting Playbook table: `tbldWLYm49Bw21WB8` — the learned playbook, one row per lesson (see "Learned playbook" at the bottom)
- GHL Private Integration token: `~/.config/od/ghl_api_key` (optional — if missing, skip step 6 and tell Kevin what to create)
- GHL Location ID: `~/.config/od/ghl_location_id` — MUST be `dgsHwbYbp6xrhRGZr9ik` (the "Operations Director" sub-account, Kevin-confirmed 13 Jul). The Runpreneur sub-account (4ags…UT0) is the property business — tenant SMS lives there; prospects must NEVER be created in it.
- Email sends via GHL conversations REQUIRE `"emailFrom": "kevin@operationsdirector.co.uk"` (the location 500s without it). Dedicated sending domain mail.operationsdirector.co.uk is configured.

## Procedure

### 1. Load state from Airtable

- Fetch all Prospect Keywords where Active is true. Sort by Last Used ascending (never-used first). Pick the top 2-3 for this run.
- Read the learned playbook from Airtable with the READ command in "Learned playbook" at the bottom of this file. It writes every lesson to a scratch file and prints the row count; search that file by keyword whenever a step needs a past lesson.
- **Build the dedupe set with the script, never by hand:**

  ```
  python3 scripts/prospect-dedupe.py build
  ```

  That returns `{companyKeys, emails, linkedin, chNumbers, suppressed, recordCount}`
  read live from the Prospects table (paginated), and it exits non-zero if the table
  returns zero records — a dedupe set built from nothing waves every duplicate through.

  For a single candidate, get its key the same way so both sides of the comparison
  are built by the same code:

  ```
  python3 scripts/prospect-dedupe.py keys "Cornerstone Supplies Ltd (t/a Abbeydale Direct)"
  python3 scripts/prospect-dedupe.py key  "Q.E.D. Industrial Controls Ltd"   # -> qed industrial controls
  python3 scripts/prospect-dedupe.py ch   "Spoke to owner, co no 09876543"   # -> 09876543
  ```

  Use `keys` (plural), not `key`. One company is legitimately written three ways —
  the whole name, the registered name alone, and the trading name alone — and the
  candidate is a duplicate if **any** of its keys is already in `companyKeys`.
  Matching only the whole name is how `Cornerstone Supplies Limited (Abbeydale
  Direct)` and `Cornerstone Supplies Limited (t/a Abbeydale Direct)` both reached
  the review queue (11 Aug).

  Do NOT re-derive the normalisation from this paragraph. It has drifted twice —
  `Smith & Sons Ltd` vs `Smith and Sons Limited` (8 Aug) and `Q.E.D.` vs `QED`
  (9 Aug) — and each drift cold-emailed the same founder twice. The rule lives in
  `scripts/prospect-dedupe.py`, guarded by `tests/prospect-dedupe.test.js`.

- The name and CH-number keys are not optional: job-ad prospects usually have no
  LinkedIn URL and sometimes no email, and matching on those two alone let three
  duplicates through on 27 Jul. The CH set is built from the `Companies House No`
  field **and** a regex over Notes, because 36 records carry the number only in
  Notes. Check the company key against the set BEFORE opening an employer's website
  or running Companies House.
- When you create a prospect, always populate `Companies House No` as a field (not
  just in Notes) and keep the raw company string in `Company`, so the key can be
  re-derived if the rule changes again.

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
- Find a contact email on the site. **All FOUR of these are required before you may write "no published email". Tick them off one at a time; a prospect marked no-email without all four is a defect, not a dead end.**
  1. The contact page
  2. The homepage, INCLUDING the footer
  3. The about page
  4. **The privacy policy — the single highest-yield page, and the one that keeps getting skipped.** Try `/privacy-policy` AND the Shopify path `/policies/privacy-policy`; on Shopify stores the bare `/privacy-policy` 404s while the `/policies/` one carries the address. A privacy policy has to name a data controller, so it publishes an address even when the contact page is a form.

  **Check each one in Chrome, not WebFetch alone.** WebFetch truncates long pages, does not run JavaScript, and returns nothing useful on plenty of small-business sites. A page that looks empty in WebFetch is not evidence of no email; the 17 Jul and 23 Jul lessons below are both this same mistake.

  Audited 7 Aug 2026: **4 of the 7 prospects recorded as "no published email" had one published all along**, because this was one bullet in a list rather than a checklist, and the privacy policy was the item that got skipped.
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

Write a **Draft Message** in **Kevin's four-line shape**. This shape is measured from his own
sent email and from a 32,607-word corpus of him speaking, not invented. Source of truth:
`00 AI Context/Knowledge/kevin-voice-profile.md`. Adopted 21 Aug 2026 after 137 cold emails
produced zero replies.

```
Hi <first name>,

Hope you're well. I'm getting in touch about <the exact thing they posted>.

I run a service that <what it does for THIS business>, so <what that means for them>.

<One direct question they can answer in a single line.>
```

**40 to 55 words for email.** Kevin's own outreach runs to about 38 words of prose. The old spec
allowed 90 and the 133 drafts sent under it ran to a median of 69.

Six rules, each one measured rather than asserted:

1. **First person. Kevin is the actor.** "I run a service that..." NEVER "Operations Director sets
   up..." Brand-as-actor is not how he writes, and it appeared in 87% of the 133 emails that
   produced nothing.
2. **Never reuse a fixed product phrase.** "AI-run operations department" appeared in **87%** of
   those drafts. Describe what the service does for THIS business, in their own terms, every time.
   Test: if your sentence would fit another prospect unchanged, rewrite it.
3. **No research-display paragraph.** Do not parade what you found out about them. Kevin states
   his business plainly and stops. One clause of context, never a showcase.
4. **End with a question that invites a REPLY, not a click. No booking link in the first touch.**
   137 strangers were asked to book a calendar slot before exchanging a single word, and none did.
   A question costs them one line. The link belongs in touch 2 or 3, after they have replied.
5. **Always greet by first name.** Two directors, use the first named one. Never a bare "Hi,".
6. **Hedge, then commit** ("Would that be worth a look?"), which is his actual pattern in speech.
   Keep the banned-word list and the no-em-dash rule.

**LinkedIn connect notes:** under 40 words, same shape without the greeting line and without any
link.

Never fake familiarity; say where we saw their post.

**When a touch DOES carry the link (touch 2 or 3, never touch 1), it is `https://operationsdirector.co.uk/book-a-demo/` and nothing else.** That page embeds the same GoHighLevel calendar (`BcVVhAg1zLaPVEXj5ih0`, Kevin-confirmed 13 Jul) in an iframe, so the booking outcome is identical, but the raw `api.leadconnectorhq.com/widget/booking/...` widget URL reads as spam in a cold email and names the CRM vendor. The canonical copy lives in `OD_BOOKING_URL` in `js/config.js`. Never paste the widget URL into a draft; `tests/prospect-email.test.js` fails the build if it reappears in source.

**Do NOT write a sign-off or signature into the Draft Message.** The Prospecting tab appends Kevin's signature (name, title, website, email) at send time, from `OD_SENDER` in `js/config.js`. A signature in the draft ships twice.

**Do NOT write a postal address or an unsubscribe line into the draft either, and never send a touch that bypasses `buildProspectEmail`.** UK PECR requires a sender identity, a postal address and a simple way to refuse further mail in every marketing email, and these are unsolicited. All three now come from `OD_SENDER` and are appended once, to every touch, in both the plain-text and HTML versions. Guarded by `tests/prospect-email.test.js`. If a follow-up is ever sent by some other path, that path must add the same footer or it must not send.

For the two email routes ("Email reply (they asked)", "Email sequence (Ltd)") also write an **Email Subject**: lower case where natural, 4-8 words, specific to their post or business, no colons-and-buzzwords, never a generic "Quick question". Kevin sees and can edit it in the review card before approving. Leave it blank on non-email routes.

### 5. Write to Airtable

- **Re-check the dedupe set IMMEDIATELY before each create — on email and Companies
  House number, not only the company name.** The step-1 check happens before you
  open the employer's website, so at that point you do not yet know either. On
  11 Aug both `mail@abbeydale-direct.co.uk` and CH `01854182` were ALREADY in the
  set when the duplicate was written; nothing looked at them again after the name
  gate passed. The last thing before the POST:

  ```
  python3 scripts/prospect-dedupe.py keys "<company as you will store it>"
  python3 scripts/prospect-dedupe.py ch   "<notes + CH field text>"
  ```
  and compare the email (lowercased, trimmed) against `emails`. Any hit on any
  axis — key, email, CH number, LinkedIn — means skip and say so in the report.
- Create one Prospects record per candidate via curl (Number()-cast any numerics, 500ms between writes, `"typecast": true`):
  - Status = "Ready for Review", Date Found = today (ISO), Contact Route, Draft Message, Email Subject (email routes only), plus every captured field.
- Update each keyword used: Last Used = today, Prospects Found += number of new prospects it produced.

### 6. First-contact pass (conversation-first — Kevin's design, 13 Jul)

The principle: every emailed prospect gets a PERSONAL first message and a led conversation. The nurture sequence is the FALLBACK for silence, Ltd companies only. Manual-track prospects are never sequenced, ever.

For each prospect with Status = "Approved" (Kevin approved the card AND its draft message):
- **Email routes** (reply / intro / Ltd): SEND the approved Draft Message as an email THROUGH GoHighLevel (POST `https://services.leadconnectorhq.com/conversations/messages`, type Email, contactId, subject + html), so the whole conversation lives in GHL and never touches the team-managed Gmail inbox. The Prospecting tab usually does this at approve time; the agent pass is the catch-up for any still sitting at "Approved" or "Synced to GHL". **DEDUPE GUARD, mandatory before every catch-up send (born 12 Aug 2026): fetch the contact's GHL conversation first. If it already contains ANY outbound email, the opener already went — do NOT send again; repair the record instead (Status "Contacted (1:1)", Next Follow-up = the send date + 7).** The 12 Aug incident was exactly this shape: 18 emails sent from the tab, every status write 422'd on a missing select option, and all 18 sat in the catch-up population looking unsent. A status field can lie; the conversation log cannot. NEVER send while the text still contains `[BOOKING-LINK]` — flag it to Kevin instead. Fallback if GHL email sending is unconfigured: create a Gmail DRAFT for Kevin and say so in the report.
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
- **Reply detection is now near-real-time (8 Aug 2026):** the `prospect-reply-watch` Cloudflare worker polls the OD location every 2 minutes. On a new inbound email from a Contacted prospect it flips the row to "Replied", DMs Kevin instantly with the reply text and the GHL conversation link, and creates a "Draft the reply to <name>" task (Status Today, Team Member = Writer) that the dispatch engine drafts onto the approval loop. Manual trigger: `POST /run` with `x-admin-key` (key at `~/.config/od/approvals_admin_key`); health at `/health`. THIS SWEEP IS THE BACKSTOP, not the primary: it catches anything the worker missed (worker outage, and ALL warm-20 replies, which arrive in Gmail, not GHL).
- **Reply found by this sweep** → Status = "Replied", flag it prominently in the report, and **check for an existing open "Draft the reply to <name>" task before drafting** — the worker usually created it within minutes of the reply, and a second draft task means Kevin approves the same answer twice. If none exists, create it (same shape: full context in Description, send method = GHL conversations API into the same thread, never send-email.py). Track what wording gets replies vs silence and feed it back into future drafts.
- **No reply + Limited Company → PERSONALISED follow-ups, not the generic tag (Kevin's ruling, 8 Aug 2026).** Kevin's requirement: every follow-up must FOLLOW ON from the personalised opener he approved, never read as a template blast. So the agent writes and sends touch 2 and touch 3 itself, personalised per prospect from the approved Draft Message + Pain Signal:
  - **Touch 2 (first due date, day 7):** subject `re: <their Email Subject>`. Shape: (1) one line picking up the opener's specific hook ("a week back I mentioned your bookkeeper ad…"), (2) ONE new angle not in the opener — usually the cost comparison (the salary in their ad vs one monthly fee) or one concrete job an agent would take over, (3) the booking link. Under 60 words. Write "FU2 sent YYYY-MM-DD" into Notes, Next Follow-up = +7 days, Status stays "Contacted (1:1)".
  - **Touch 3 (next due date, day 14, the close-out):** subject unchanged. Shape: "Last note from me. If [their specific load] is sorted, ignore this. If not, the door is open: <link>. Either way, good luck with [something real from their post]." Under 45 words. Write "FU3 sent YYYY-MM-DD" into Notes, Next Follow-up = +7 days.
  - **7 days after FU3, still silent** → Status = "No Response", stop. Three touches total, then out — never more.
  - Sends go through the same GHL conversations endpoint as the opener (same emailFrom, signature appended by the same rules — no signature in the drafted body). **curl needs a browser User-Agent header on this endpoint — the default curl UA gets a Cloudflare 403 (error 1010), proven 8 Aug 2026.**
  - **The PECR footer is your job on FU2 and FU3.** The opener is built by `buildProspectEmail` in `js/prospecting.js`, which appends the signature, the postal address and the opt-out automatically. Your curl send does NOT go through that function, so nothing appends it for you. Every follow-up body you post to the conversations endpoint must end with the signature followed by, on their own lines, the `postal` and opt-out wording from `OD_SENDER` in `js/config.js`:

    ```
    Operations Director, 61 Bridge Street, Kington, HR5 3DJ
    Prefer not to hear from me? Reply "unsubscribe" or email kevin@operationsdirector.co.uk with Unsubscribe in the subject.
    ```

    Read the current values out of `js/config.js` at run time rather than copying them from here, so the two cannot drift. Never send a touch without it: these are unsolicited marketing emails and the address and opt-out are legally required in every one, not only the first.
  - **Honour an opt-out the moment it arrives.** If a prospect replies asking to be removed, or the word "unsubscribe" appears in their reply, set Status = "No Response", write "OPTED OUT YYYY-MM-DD" into Notes, cancel any pending follow-up, and never contact them again on any channel. Do not send a confirmation email. Report it, and treat a missed opt-out as a serious defect, not a slip.
  - The `od-prospect-nurture` tag stays RETIRED: do not apply it. **Triggers confirmed 8 Aug 2026 from Ericamae's Customer Journey Map v6 (https://chaichoong.github.io/Email-Copy/):** W1 = booking confirmation + reminders (fires on Appointment Booked — unaffected, welcome); W2 = no-show rebooking, four emails over five days (appointment outcome — welcome); W3 = 3-email nurture, fires ONLY on the `od-prospect-nurture` tag, so while the tag is unapplied W3 is parked and cannot double-send on the agent's personalised touches; W4 = post-call follow-up (attended outcome); W5 = replied-but-not-booked, fires on `od-replied-no-booking`, which only the agent applies — apply it ONLY where the conversation has genuinely stalled after a reply, and never alongside FU2/FU3 in the same window. PUBLISHED state verified by API 8 Aug 2026 (all six live: W1 v28, W2 v19, W3 v6, W4 v24, W5 v5, W6 v6; built May-Jul, finished 29-31 Jul). The token now carries `workflows.readonly`, `calendars.readonly` and `calendars/events.readonly` (Kevin added them 8 Aug) — verify workflows by API (`GET /workflows/?locationId=…`, browser UA required), never by driving the GHL UI.
- **No reply + manual track** → send ONE polite follow-up via GHL the first time (note it in the record), and after a second silent week set Status = "No Response" and stop. NEVER add manual-track contacts to any email workflow.

**Send ramp (deliverability — applies to APPROVALS feeding sends):** the domain is cold. Cap NEW first-contact sends at 15 per day for the first week, 25/day the second, then review. If Kevin approves more cards than the day's cap, the surplus stays at "Approved" and the agent's catch-up pass sends them on following days, oldest first. Follow-ups (FU2/FU3) do not count against the cap.

**"No route yet" prospects:** these wait for Kevin's one personal action (e.g. a Facebook message from his account). When he confirms he has made contact, set Status = "Contacted (1:1)" + Next Follow-up +7 days so the conversation is tracked like any other.

**LinkedIn lane lifecycle (Status = "Connect Sent"):** each run, check Kevin's sent invitations (linkedin.com/mynetwork — read-only look). Accepted → send the already-approved Draft Message as the first LinkedIn message (this is the send Kevin pre-approved on the card), Status = "Contacted (1:1)", Next Follow-up = +7 days. Not accepted after 14 days → Status = "No Response" (do not withdraw, do not retry). Any inbound LinkedIn reply → Status = "Replied", draft a response for Kevin's approval in the report.

**Draft freshness:** Kevin may approve cards days after they were found. At send time, if Date Found is older than ~10 days, soften the post reference ("saw your post a little while back") before sending — never send wording that pretends the post was yesterday.

**Accuracy tracking (the autonomy gate metric):** every run, compute and report: prospects reviewed to date, approved vs rejected, current approval rate, and the rate over the trailing 14 days. The Prospecting tab shows the same number on its Agent accuracy card. When the trailing-14-day rate exceeds 90% with meaningful volume, remind Kevin the auto-approve proposal is available (see 6c).

### 6c. Autonomy roadmap (NOT yet active)

Kevin's end state: he first sees a prospect when the call lands in his diary. The review gate stays until quality is proven: once Kevin's approval rate exceeds 90% across 2 consecutive weeks, propose switching high-confidence prospects (buying signal + Ltd + High email confidence + no [BOOKING-LINK] placeholder) to auto-approve-and-send, with a daily digest instead of per-card review. Do not enable this without Kevin's explicit yes — track the approval stats in the report from day one.

### 8. Learning loop (self-evolution — run at the END of every run)

**North star: calls ATTENDED.** The full chain is found → contacted → replied → booked → attended. Each run, compute the funnel numbers and identify the current bottleneck stage; bias the next run's effort toward it (more finding, sharper drafts, faster follow-ups, or reminder tuning).

1. **Keyword evolution:** using each prospect's Keyword Matched field, score keywords by what they produced DOWNSTREAM (approvals, replies, calls — not just finds). After a keyword has been used 4+ times with zero approved prospects, deactivate it (never delete; note why in its Notes). When producing posts reveal new first-person pain language, add at most 2 new keyword variants per week, marked "agent-proposed" in Notes.
2. **Playbook write-back:** any repeatable discovery (where an email was hiding, which group produced, which platform pattern worked or failed, which draft wording got a reply) gets appended as ONE new row in the Airtable Prospecting Playbook table with the APPEND command in the "Learned playbook" section at the bottom of this file (never to this file, never to the local snapshot). Keep it curated: correct or retire a lesson disproven later with a dated note on its row, and check the scratch copy for an existing lesson before adding a near-duplicate. This is how the agent gets permanently smarter.
3. **Draft evolution:** track which opener styles get replies (the Pain Signal + Draft Message of Replied prospects vs silent ones). Fold winning patterns into the drafting rules in §4.5 by editing them — with a dated note of what changed and the evidence.
4. **Attendance loop:** read appointment outcomes from GHL for booked calls. If no-shows exceed 1 in 3, say so in the report and propose reminder-sequence changes to Kevin.
5. **Evidence bar:** at 5 prospects/day the numbers are small — never change anything on fewer than 4 data points, and log EVERY self-change in the daily report so Kevin sees each mutation.

**IMMUTABLE — the agent must NEVER self-modify these, regardless of what it learns:** the Hard rules section (scraping ban, stop-on-friction, volume caps, PECR gate, suppression, published-emails-only, secrets), the approval gate while it is active, targeting canon, and spend. Changes there are proposed to Kevin, never applied. Better conversion never justifies breaking compliance.

### 7. Report

Send Kevin a short Slack DM (slack connector) and end with the same summary:
`Prospecting run <date>: <n> found → review queue | <m> synced to GHL | keywords used: <list> | <any warnings: LinkedIn friction, GHL skipped, 0 results>`

Keep it honest — a zero-result run says so plainly, with the likely reason. Include the full funnel (found → contacted → replied → booked → ATTENDED), the current bottleneck, and any self-changes made by the learning loop.

**Follow-up visibility (Kevin's gate design, 8 Aug 2026):** FU2 and FU3 send WITHOUT re-approval — approving the card approves the conversation, and the follow-up shapes are fixed (§6b). In exchange, every run report LISTS each follow-up sent that morning (name, touch number, one-line body summary) so Kevin sees exactly what went out without having to gate it. Any REPLY still always comes to him before an answer is sent — that gate never moves.

**The steering number (added 8 Aug 2026): reply rate per 100 first emails sent.** Report it in every run once sends begin: `replies ÷ first-contact emails sent × 100`, cumulative and trailing-7-days. Calls attended stays the north star, but it is too far downstream to steer copy and targeting by; reply rate is the weekly dial. Under 2% after 100 sends = change ONE thing (subject style, first line, or the ask) and measure again — never several at once.

---

## Learned playbook (Airtable, read on demand)

The learned playbook lives in Airtable: table **Prospecting Playbook** (`tbldWLYm49Bw21WB8`, base `appnqjDpqDniH3IRl`), one row per lesson. Fields: `Title` (short label), `Lesson` (the lesson, verbatim, starting with its date), `Section` (`Learned playbook`), `Added` (date), `Source` (where the row came from), `Key` (the stable dedupe key). It moved there on 21 Sep 2026 (Kevin approved): 120 lessons, every byte kept. It left this public file that morning because the lessons name real prospects and their email addresses. It left the local file the same day because the robot runners may no longer write under `.claude/`, and because a store that builds up value belongs in Airtable, not on one Mac.

Both commands read the PAT file inside the command and never print it or put it on a command line. They run on python3 (covered by the robots' `Bash(python3:*)`) and call the same Airtable REST API the curl steps above use.

**READ (start of every run, §1).** Pages through the whole table, writes every lesson to a scratch file and prints the row count. Search that file by keyword (Grep) when a step needs a past lesson: where an email was hiding, which query produces or has decayed, a namesake trap, draft wording. Do not load it whole; it is about 16,000 tokens.

```
python3 - <<'EOF'
import json, os, tempfile, urllib.parse, urllib.request
PAT = open(os.path.expanduser("~/.config/od/airtable_pat")).read().strip()
URL = "https://api.airtable.com/v0/appnqjDpqDniH3IRl/tbldWLYm49Bw21WB8"
rows, offset = [], None
try:
    while True:
        q = {"pageSize": "100", "sort[0][field]": "Added", "sort[0][direction]": "asc"}
        if offset:
            q["offset"] = offset
        req = urllib.request.Request(URL + "?" + urllib.parse.urlencode(q), headers={"Authorization": "Bearer " + PAT})
        d = json.load(urllib.request.urlopen(req, timeout=60))
        rows += d["records"]
        offset = d.get("offset")
        if not offset:
            break
except Exception as e:
    raise SystemExit("PLAYBOOK READ FAILED: %s. Search the local read-only snapshot instead and say so in the report." % e)
out = os.path.join(os.environ.get("AGENT_SLOT_SCRATCH") or tempfile.gettempdir(), "prospecting-playbook.txt")
with open(out, "w", encoding="utf-8") as fh:
    for r in rows:
        f = r["fields"]
        fh.write("[%s] %s (%s)\n%s\n\n" % (f.get("Added", "?"), f.get("Title", ""), r["id"], f.get("Lesson", "")))
print("PLAYBOOK: %d rows read from Airtable -> %s" % (len(rows), out))
if len(rows) < 120:
    print("PLAYBOOK READ SUSPECT: fewer than the 120 rows migrated on 21 Sep 2026, and rows are never deleted. Treat it as a broken read.")
EOF
```

**APPEND (end of every run, §8.2).** One command per lesson. Fill in `TITLE` and `LESSON` only, and write the lesson the way the existing rows read: `YYYY-MM-DD (SHORT LABEL): what happened, the evidence, and the rule it gives`. The command builds the key from Section plus the whitespace-collapsed Lesson and reads every existing key first (paginated). If the key is already there it skips the write, so a retried append never makes a duplicate. It refuses to write at all if it reads fewer than 120 rows, because a broken read would wave a duplicate through. It reads the new row back before it reports success. If the lesson contains three single quotes in a row, change them; nothing else needs escaping.

```
python3 - <<'EOF'
import datetime, hashlib, json, os, re, urllib.parse, urllib.request
TITLE = r'''SHORT LABEL'''
LESSON = r'''YYYY-MM-DD (SHORT LABEL): the lesson.'''
SOURCE = "prospecting run " + datetime.date.today().isoformat()
SECTION = "Learned playbook"
PAT = open(os.path.expanduser("~/.config/od/airtable_pat")).read().strip()
URL = "https://api.airtable.com/v0/appnqjDpqDniH3IRl/tbldWLYm49Bw21WB8"
def call(method, url, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers={"Authorization": "Bearer " + PAT, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=60))
LESSON = LESSON.strip()
key = "pb-" + hashlib.sha256((SECTION + "\n" + " ".join(LESSON.split())).encode("utf-8")).hexdigest()[:16]
rows, offset = [], None
while True:
    q = {"pageSize": "100", "fields[]": "Key"}
    if offset:
        q["offset"] = offset
    d = call("GET", URL + "?" + urllib.parse.urlencode(q))
    rows += d["records"]
    offset = d.get("offset")
    if not offset:
        break
if len(rows) < 120:
    raise SystemExit("PLAYBOOK APPEND REFUSED: read %d rows, expected 120 or more, so the duplicate check cannot be trusted." % len(rows))
hit = [r["id"] for r in rows if r["fields"].get("Key") == key]
if hit:
    print("PLAYBOOK APPEND SKIPPED: key %s already exists on %s" % (key, hit[0]))
    raise SystemExit(0)
m = re.match(r"(\d{4}-\d{2}-\d{2})", LESSON)
added = m.group(1) if m else datetime.date.today().isoformat()
title = TITLE.strip() or LESSON[:100]
fields = {"Title": title[:100], "Lesson": LESSON, "Section": SECTION, "Added": added, "Source": SOURCE, "Key": key}
rec = call("POST", URL, {"records": [{"fields": fields}]})["records"][0]
back = call("GET", URL + "/" + rec["id"])["fields"]
ok = back.get("Key") == key and back.get("Lesson") == LESSON
print("PLAYBOOK APPENDED %s key %s, read back %s, table now %d rows" % (rec["id"], key, "OK" if ok else "MISMATCH", len(rows) + 1))
EOF
```

**Curating.** Never delete a row, and never change a row's `Key`: it is the row's identity, set once at creation. To correct or retire a lesson disproven later, PATCH that row's `Lesson` (its record id is in brackets in the scratch file) so it starts with `CORRECTED YYYY-MM-DD:` or `RETIRED YYYY-MM-DD:` and the reason, the way the 23 Jul Cloudflare lesson was corrected on 7 Aug. List every correction in the run report.

**If Airtable is unreachable.** Only then, search the local read-only snapshot at `/Users/kevinbrittain/Projects/leadership-dashboard/.claude/skills/prospect-daily/learned-playbook.local.md` (git-ignored, frozen at the 120 lessons of 21 Sep 2026) and say in the report that you did. Never append to it and never rebuild it from memory. If an APPEND fails, put the lesson text in the run report under `PLAYBOOK APPEND FAILED` so it is not lost, and carry on.
