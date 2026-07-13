# GHL Sequence Copy Pack — Operations Director prospecting

Paste-ready copy + build steps for every sequence. Written 13 Jul 2026, final version.
Grounded in the **2026-06-17 Sales & Marketing Team Brief** (Software as a Science; 13-year-old test; one channel to green = LinkedIn outreach; capture the lead, never a dead end) and its **five evidence-based hot-buttons** from real sales calls:
1. You ARE the business ("my business is me")
2. You're drowning ("not enough hours in my day")
3. It's all in your head (no systems, can't hand over or sell)
4. Flying blind on the numbers ("I can't tell you my profit")
5. Tools are a mess, money wasted on software ("worst thing I've done")

Top objection from real calls = PRICE: lead with £350/month and the 30-day money-back guarantee. Second = "show me": offer the live dashboard on the call.
Sub-account: **Operations Director** (`dgsHwbYbp6xrhRGZr9ik`).
Send from: **kevin@operationsdirector.co.uk**. Booking link: `https://api.leadconnectorhq.com/widget/booking/BcVVhAg1zLaPVEXj5ih0`.
Every email footer (PECR): sender identity + postal address + unsubscribe link (use GHL's unsubscribe merge tag).

Footer block for ALL emails:
> Kevin Brittain, Operations Director — 61 Bridge Street, Kington, HR5 3DJ
> Prefer not to hear from me? {{unsubscribe_link}}

---

## Workflow 1 — Booking confirmation + reminders (build FIRST)

**Trigger:** Appointment Booked → filter: calendar = Operations Director - Teardown Call.

**Step 1 — Email, immediately. Subject: `Confirmed: your call with Operations Director`**
> Hi {{contact.first_name}},
>
> Your call is booked: {{appointment.start_time}}.
>
> Here is what you leave with, whether or not we ever work together: a teardown of how your week actually runs, and a map of the first three processes you could hand to an AI operations department tomorrow.
>
> One thing to prepare: jot down the three tasks that ate most of your week. That is where we start.
>
> Need to move it? Use the reschedule link in this email rather than cancelling.
>
> Speak soon,
> Kevin

**Step 2 — Wait until 24 hours before appointment. Email. Subject: `Tomorrow: your Operations Director call`**
> Hi {{contact.first_name}},
>
> Quick reminder about our call tomorrow at {{appointment.start_time}}.
>
> It is 30 minutes, no slides, no pitch deck. You talk me through how your week actually runs; I show you which parts an AI operations department would take off your plate first.
>
> Kevin

**Step 3 — Wait until 1 hour before appointment. Email. Subject: `Speaking in an hour`**
> Hi {{contact.first_name}},
>
> We are on in an hour. The joining link is in your calendar invite.
>
> Grab a coffee, bring the three tasks, and I will bring the plan.
>
> Kevin

## Workflow 2 — No-show recovery

**Trigger:** Appointment Status = No-show (same calendar).

**Step 1 — Email, 1 hour after no-show. Subject: `We missed each other`**
> Hi {{contact.first_name}},
>
> Looks like today ran away with you — which, honestly, is the exact problem we were going to talk about.
>
> No lecture. Grab another slot here and we will pick it up: https://api.leadconnectorhq.com/widget/booking/BcVVhAg1zLaPVEXj5ih0
>
> Kevin

**Step 2 — Wait 2 days. Condition: no appointment booked. Email. Subject: `Second attempt (I get it)`**
> Hi {{contact.first_name}},
>
> When a founder cannot find 30 minutes to talk about getting time back, that is usually the strongest sign they need it.
>
> One click, pick any slot: https://api.leadconnectorhq.com/widget/booking/BcVVhAg1zLaPVEXj5ih0
>
> If now is genuinely not the time, reply "later" and I will leave you alone until next quarter.
>
> Kevin

## Workflow 3 — Cold nurture (3 emails max — Kevin's rule)

**Trigger:** Tag added = `od-prospect-nurture`. (The prospecting agent applies this tag only after 7 silent days, Limited Companies only.)

**Email 1 — immediately. Subject: `What is your hour actually worth?`** *(hot-buttons 1 + 2)*
> Hi {{contact.first_name}},
>
> I emailed you last week about {{contact.company_name}} — no reply needed, founders are busy. That is rather the point.
>
> A founder said to me recently: "my business is me. It's only myself doing everything." Sound familiar?
>
> Quick sum. Take what the business pays you, divide by your working hours. That is your hourly rate. Now look at yesterday: how many of those hours went on chasing, filing, scheduling and follow-ups — £10-an-hour work?
>
> You do not fix that by working harder. You buy those hours back.
>
> Operations Director is an AI-run operations department for founder-led firms. It takes the £10 work, and the thirty tasks behind it, off your plate.
>
> Thirty minutes to see your map: https://api.leadconnectorhq.com/widget/booking/BcVVhAg1zLaPVEXj5ih0
>
> Kevin

**Email 2 — wait 4 days. Subject: `What I run on it`** *(hot-button 3 + the "show me" objection)*
> Hi {{contact.first_name}},
>
> Most founder-led businesses run out of one place: the founder's head. Which works, right up until you want a holiday, a hire, or a buyer.
>
> Fair question to ask any software founder: do you use your own product?
>
> I run a 27-property portfolio on Operations Director. Rent reconciliation, compliance deadlines, contractor jobs, tenant comms — the system does the work, I approve decisions from one screen in about 20 minutes a day. Nothing lives in my head.
>
> On the call I show you that live dashboard, running my real business, then map yours.
>
> Worth a look: https://api.leadconnectorhq.com/widget/booking/BcVVhAg1zLaPVEXj5ih0
>
> Kevin

**Email 3 — wait 5 days. Subject: `Closing the loop`**
> Hi {{contact.first_name}},
>
> Last one from me. If the timing is wrong, no hard feelings — you know where I am when the admin pile wins.
>
> One thing worth knowing before I go: this is £350 a month with a 30-day money-back guarantee, and we are onboarding founding clients this quarter at the founding rate — those terms retire when the places fill. Founders who join now shape what the product becomes.
>
> The call costs you 30 minutes and nothing else: https://api.leadconnectorhq.com/widget/booking/BcVVhAg1zLaPVEXj5ih0
>
> Either way, good luck with the business. Genuinely.
>
> Kevin

**End of workflow:** add tag `od-sequence-done` (the prospecting agent uses it to mark No Response).

## Workflow 4 — Post-call proposal follow-up
**A draft already exists in GHL ("Post-Call Proposal Follow-Up") — finish that rather than rebuild.** Trigger: manual add or tag `od-proposal-sent`. One email at +2 days ("Any questions on the plan?"), one at +5 days ("Shall I hold your onboarding slot?"). Kevin to review the existing draft's content first.

## Workflow 5 — Replied but not booked
**Trigger:** tag `od-replied-no-booking` (applied by Claude during conversation management when a conversation stalls after a reply). One email, wait 3 days after tag:

**Subject: `That call link, again`**
> Hi {{contact.first_name}},
>
> Enjoyed the exchange — did not want it to fizzle out in both our inboxes.
>
> Easiest next step is 30 minutes on a call: https://api.leadconnectorhq.com/widget/booking/BcVVhAg1zLaPVEXj5ih0
>
> Kevin

## Workflow 6 — 90-day reactivation (build LAST, optional)
**Trigger:** tag `od-reactivate` (agent applies to No Response prospects after 90 days, Ltd only). Single email; copy to be written when we switch it on — the offer may have evolved by then.

---

## Build checklist (per workflow)
1. Automation → Create workflow → Start from scratch
2. Add the trigger + calendar/tag filter as specified
3. Add email actions with waits between; paste subject + body; set From = kevin@operationsdirector.co.uk
4. Append the PECR footer block to every email
5. Rename the workflow (pencil, top bar), Save, then **Publish** only after Kevin sign-off
6. Workflows 1 + 2 also need: Settings → allow re-entry (a contact can book more than once)

## Sanity rules
- Nurture NEVER triggers on `od-prospect` or `od-prospect-manual` — only `od-prospect-nurture`
- 3 emails maximum in the nurture, no exceptions
- Test each workflow with a dummy contact before publish
