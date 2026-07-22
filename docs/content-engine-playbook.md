# Content Engine Playbook

**Status:** live operating doc. Created 2026-07-21, Kevin-approved.
**Owner:** Kevin (approval), Ericamae (production support), `/content-weekly` agent (drafting).
**This is a reference spec, not a plan.** All content tasks live in `MASTER-PLAN.md` §7. Never
create a separate content plan, roadmap or task list.

---

## 1. Why this exists

Outbound prospecting books calls one at a time and stops the moment the agent stops. Content is the
second lane: it builds an audience, answers the credibility objection that real sales calls name in
the top three (new company, no track record), and warms prospects before outbound ever messages
them.

**Lane 1 is outbound. Lane 2 is content. Content does not replace outbound and never becomes a
separate funnel.** Both lanes share one calendar (Teardown, `BcVVhAg1zLaPVEXj5ih0`), one CRM
(GoHighLevel, sub-account `dgsHwbYbp6xrhRGZr9ik`), one lead magnet (Founder to Free) and one set of
hot-buttons.

| | Lane 1, outbound | Lane 2, content |
|---|---|---|
| Mechanic | Agent finds a prospect, approved message goes out | Agent publishes, audience self-selects into the magnet |
| Volume | 5 a day, capped by supply | Uncapped reach |
| Speed to call | Days | Weeks to months |
| Job | Books calls now | Builds audience, kills the credibility objection, warms lane 1 |

---

## 2. Locked decisions

| Decision | Call | Date |
|---|---|---|
| Publisher identity | Operations Director **company page** on LinkedIn | Kevin, 21 Jul |
| Kevin's personal profile | Keeps Runpreneur in the feed. Carries OD in the static sections only. Publishes no OD content | Kevin, 21 Jul |
| Channels | **LinkedIn only** until content proves attended calls | Kevin, 21 Jul |
| Cadence | 5 posts a week, one per weekday, plus one long-form a month | Kevin, 21 Jul |
| Lead magnet | Existing gated "Founder to Free" | Kevin, 21 Jul |
| Control | Agent drafts, Kevin approves, system publishes | Kevin, 21 Jul |
| Proof evidence | Dogfooding only. Kevin's own businesses | Kevin, 21 Jul |

### Why the company page, and what it costs

Kevin is known for Runpreneur. Repositioning a personal brand takes 12 to 18 months of consistent
posting, which is runway that does not exist before first revenue. So the page publishes.

Two things recorded so nobody plans around a false assumption:

1. **The name is not a search advantage.** "Operations Director" is a job title. LinkedIn search
   returns tens of thousands of people holding that role and the page ranks below them. Google ranks
   the term for job adverts and recruitment. The real search play is the website ranking for problem
   terms ("my business can't run without me", "how to systemise a small business"), which the
   monthly long-form pieces feed.
2. **A page costs reach.** LinkedIn gives company pages a fraction of the feed distribution personal
   profiles get. Accepted knowingly, and mitigated by §7 amplification.

### Runpreneur separation

Runpreneur keeps the personal LinkedIn feed, Instagram, YouTube, Facebook and Strava. Kevin carries
on posting it daily exactly as now.

The separation is about audience signal, not embarrassment. A feed trained on running distributes
business posts badly and dilutes both stories. Runpreneur is a trust asset in front of small
business owners and makes Kevin memorable in a category full of faceless AI vendors.

- **No Runpreneur content on the OD page.** No exceptions.
- **No OD posts on Kevin's personal feed.** His static sections carry OD instead (§7).

---

## 3. Audience and message

**Audience:** founder-led UK businesses, £100k to £5m turnover, 2 to 50 staff, not PE-owned,
industry-agnostic. The wedge is the situation, not the industry. Same targeting canon the
prospecting engine uses, so both lanes compound on the same people.

**Core message, 13-year-old test:** Operations Director gets AI to do 90% of the everyday work in
your business, so it runs without you.

**The 5 hot-buttons (canon, customers' verbatim words from real sales calls).** Every post maps to
exactly one:

1. **You ARE the business.** "My business is me."
2. **You're drowning.** "Not enough hours in my day."
3. **It's all in your head.** No systems, can't hand over, can't sell.
4. **Flying blind on the numbers.** "I can't tell you my profit."
5. **Tools a mess, money wasted.** "Worst thing I've done."

**Top objections to write against:** price first (lead with £350/mo and the 30-day money back), then
"show me" (demo), credibility (new company), burned before by software, need to consult a partner.

---

## 4. The four pillars

Adopted from Ericamae's build, with Proof redefined. Each pillar is the same problem-first structure
with a different third act.

| Pillar | What it does | Third act |
|---|---|---|
| **Pain** | Leads with one hot-button. Stages a 50-word scene the reader knows from their own week | One plain sentence on what OD does. No feature list |
| **Proof** | Receipts. **Dogfooding only** | A real number from Kevin's own businesses |
| **Product** | One screen removing one hot-button | What you see, the one click, what changes after |
| **Philosophy** | Why this exists, first person as Kevin | Why a business running through one person cannot grow or be sold |

### Proof pillar, hard rule

Operations Director has no clients yet. **Proof posts draw only on Kevin's own businesses:** the
property portfolio, the agents live on his own dashboard, the jobs that no longer need a human.

"I built this for my own business, here is what it did last week" is true, checkable, and stronger
than an anonymous customer nobody can verify. When design partner #1 signs and consents, real client
proof replaces dogfooding proof, with permission in writing.

---

## 4a. Evidence inventory — what content may draw on

Verified against the code and Airtable on 2026-07-21. **This is the only approved source list for
Product and Proof posts.** If something is not here, it does not go in a post until it is verified
and added.

**Language rule (Kevin, 21 Jul): call them what they are.** An *agent* runs itself on a schedule. An
*assistant* acts when a human asks it to. Ten of the twelve are assistants today. Saying so costs
nothing and makes the 90% north star a journey the audience watches, which beats a claim. It also
protects Kevin when a prospect probes it on a Rocket Demo.

### Autonomous agents (run themselves)

| Module | Evidence | Content note |
|---|---|---|
| Credit Control / CFV | `js/cfv.js`, registered in Systemisation Workflows, `state: testing`. Ran daily 6-16 Jul, 81 actions logged, 68 proposed / 1 approved / 1 rejected | Say what it proposed. **Never claim money recovered or hours saved** — 68 of 70 proposals were never actioned, so there is output but no outcome yet |
| Prospecting | `js/prospecting.js`, `.claude/skills/prospect-daily/`, registered, GHL-wired | Real. Note it is currently misconfigured with no allowed tables |

### AI assistants (real, substantial, human-invoked)

Systemisation, Inbound Comms, Tasks & Projects team comms, Objective & Strategy planning,
Leadership Dashboard, Finance, Content Machine. Verified by AI call sites in
`os/systemisation/index.html` (25), `follow-up.html` (13), `os/tasks/index.html`,
`os/strategy/strategy.js`, `js/ai-assistant.js`, `js/pnl.js`, and the `content-machine` repo.

### Engines that are not AI, and must never be described as AI

Reconciliation (`js/reconciliation.js`, 2,151 lines, matching + knowledge base + accuracy tracking,
zero AI calls), Wealth (`js/wealth.js`, 2,932 lines of calculation), AI Brain (`ai-brain.html`, 419
lines, still the data bridge with stages 2 and 3 pending).

### The hero: Systemisation

**The Method slot is built on the process-to-agent pipeline** (Kevin, 21 Jul). It turns a documented
process into a working agent, it is genuinely built, it is the most AI-heavy module in the platform,
and nobody else has it. Every Tuesday post teaches one step of it. The monthly long-form piece is
the full method.

Teaching the mechanism is safe: OD is defensible on execution, not on secrecy. Giving the method
away is the pre-sell principle Kevin already adopted.

### Current blocker on all of it

**Every agent has been dead since 16 Jul 2026** — the Anthropic API account ran out of credit
(`proxy 400: "Your credit balance is too low"`, three failures in Agent Activity
`tblJ3GFnAAoXf99e9`). Proof posts cannot claim anything is "running today" until this is fixed and a
successful run is logged. Tracked as a separate task.

---

## 5. Weekly template

Five posts, one per weekday, each slot a fixed job. Fixed slots are what make the agent reliable: it
fills a known shape rather than inventing a format each time.

| Day | Slot | Pillar | Source material |
|---|---|---|---|
| Mon | Pain | Pain | Prospecting queue, GHL conversation threads, the 5 hot-buttons |
| Tue | Method | Product | **Process-to-agent, one step a week** (§4a hero), plus `docs/` and the Frameworks Library |
| Wed | Proof | Proof | §4a evidence inventory only. Build-in-public until real client results exist |
| Thu | Contrarian | Philosophy | Objection crib sheet from real historic calls |
| Fri | Offer | any | The week's only overt CTA, into the gated magnet |

**Monthly:** one long-form piece consolidating the month's best-performing theme. Published as a
LinkedIn article and on the website, because the website is the asset that can actually rank.

---

## 6. Hard rules

These are immutable. The `/content-weekly` agent may never modify them, only propose changes to
Kevin.

1. **No invented evidence.** Never claim a client, a result, a testimonial, a review, a video, a
   channel or an asset that does not exist. Every figure in a post cites where it came from. If the
   source cannot be named, the figure comes out. This rule exists because the first draft of the
   calendar invented eight customers with specific numbers, which breaks accuracy-over-hype,
   breaches UK advertising rules, and would destroy the credibility the content is meant to build.
2. **One CTA a week.** Only the Friday post carries an overt ask and a link. The other four carry
   none. Volume of asks is what kills a small page's reach fastest.
3. **No Runpreneur on OD channels, no OD on the personal feed.**
4. **UK English throughout.** No em dashes. No motivational padding, no AI clichés, no hype
   adjectives. Short sentences, active voice, "you" and "your".
5. **13-year-old rule.** If a sentence needs jargon explained, rewrite the sentence.
6. **PECR and consent.** Only people who ask for the magnet get emailed it. Comment requests and
   form fills are solicited and documented. Nobody is added to a sequence for engaging with a post.
7. **Kevin approves every post before it publishes** until the autonomy gate in §9 is met.
8. **Pricing stated anywhere must match the locked launch pricing:** £1,500 setup, £350/mo, 30-day
   trial. Never quote module pricing until Phase 2 pricing goes live.
9. **Agent vs assistant.** Only the two autonomous agents in §4a may be called agents. Everything
   else is an assistant. Never describe the reconciliation, wealth or AI Brain engines as AI.
10. **Never claim something is running while it is not.** Check §4a for the current blocker before
    writing any present-tense Proof post.

---

## 7. Distribution routine

A page with no audience gets almost no reach on its own. Distribution is a routine, not a hope.

**Kevin's personal profile carries OD in the static sections** while Runpreneur keeps the feed:

- **Headline:** business first, both present. "Helping founder-led UK businesses get 90% of the
  daily work run by AI | Runpreneur, running to save children's lives."
- **About:** opens with the business (what, who for, outcome), closes with a short Runpreneur
  paragraph. Buyers read three lines and stop, so order matters more than content.
- **Featured:** lead magnet first, Runpreneur second.
- **Experience:** CEO of Operations Director listed properly, which links him to the page and makes
  the page look staffed.

**Team amplification, the single biggest lever a small page has.** Kevin, Mica and Ericamae each
react and leave a real comment on the page's post inside the first hour. About five minutes each.
This goes into the daily agent brief as an instruction, not a habit anyone has to remember, and it
is tracked on the scorecard because when it slips the whole engine goes quiet.

**The page comments as the page** on relevant founder posts. A discovery route a personal profile
does not need but a page does.

---

## 8. Lead magnet mechanic

The gated "Founder to Free" magnet and its live GHL capture-and-nurture workflow already exist. No
new funnel gets built.

**Primary route, comment-gating.** "Comment SYSTEMS and I'll send it over." It outperforms
link-in-post, it pulls engagement onto the post which a page badly needs, and for PECR it is clean:
the person is soliciting the asset and the request is timestamped and public.

**Secondary route,** a plain link for anyone who prefers it.

The daily agent pass reads comments on the live CTA post, replies, captures the email into GHL and
tags the contact. The existing nurture workflow and the Teardown calendar do the rest.

---

## 9. Measurement

**North star: Teardown calls attended.** Same as prospecting, so the two lanes are comparable.

Tracked weekly: impressions, page follows, magnet opt-ins, calls booked, calls attended. Plus
amplification compliance (did all three of us engage in the first hour).

**90-day evidence gate.** If at 90 days content has produced fewer than 3 attended calls, the engine
drops to 2 posts a week on maintenance and the effort returns to outbound. Written down before the
first post rather than after the disappointment. AI-drafted content in a saturated feed can produce
reach without buyers, and this plan has to be able to say so.

**Autonomy gate.** After 2 consecutive weeks at over 90% of drafts approved without material edits,
the agent may propose auto-publishing the Mon to Thu slots. The Friday CTA post always stays
Kevin-approved.

**Learning loop.** Weekly performance writes back into the agent's own playbook section, the same
mechanism `/prospect-daily` uses. Judge on opt-ins, not impressions. Never change on fewer than 4
data points.

---

## 10. Absorbed assets, and what was not true

Ericamae built a content engine site at `chaichoong.github.io/operations-director-content/`
(verified 21 Jul 2026). Reused here rather than rebuilt.

**Absorbed:** the four pillars and their drafting prompts, the 30 drafted posts as the Phase 1
backlog, the master framework (emotion, agitate, introduce OD, CTA), the hot-button LinkedIn search
queries in the outreach tracker, the "no Runpreneur on OD channels" rule, and the choice of the
LinkedIn business page as primary, which she reached independently.

**Corrected, because the dashboard claimed things that were not true:**

| Claim on the site | Reality on 21 Jul 2026 | Fix |
|---|---|---|
| "Buffer connected, approved posts auto-queue" | The page makes zero network calls. `connected: true` is a hardcoded literal beside a fake masked token. Nothing publishes | Real publishing via GHL Social Planner |
| An engine producing content | 30 posts hand-typed into the HTML. Nothing generates post 31 | `/content-weekly` agent drafting continuously |
| A review queue Kevin signs off | Saves to the browser it is opened in. Kevin's approvals are invisible to Ericamae | Airtable queue, shared state, funnel metrics |
| Proof posts citing customers | OD has no clients. 8 posts invented customers with specific figures | Rewritten as dogfooding, and rule §6.1 added |
| 9 posts assume a YouTube channel and screen-recorded videos | Neither exists. No social links on the website at all | LinkedIn only, per §2 |
| MASTER-PLAN "3 posts/week running" | Nothing was publishing | Plan line corrected 21 Jul |

The writing quality in her 30 posts is high and the strategy underneath is sound. The gap was
between a working prototype and a running system, and the calendar it produced needed a truth pass.

---

## 11. Learned playbook

Dated bullets appended by the `/content-weekly` agent after each weekly run. Evidence bar: never
change on fewer than 4 data points. Every change logged with the numbers that justified it.

- (no entries yet, first run pending)
