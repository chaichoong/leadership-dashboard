# Task Hygiene Sweep — 2026-08-03

## Score

Open tasks: 320. Fully compliant: 6 (1.9%). Same as yesterday.

The score is stuck for a known reason, not because your tasks are messy. 309 of the 320 have
no "Recurring" value, and that is correct — nearly all of them are one-off jobs. The score
counts a blank Recurring box as a fault. Until that is changed, it can never rise. Fixing it
is a code change, not a tidy-up, and it is written up at the bottom.

**Nothing tonight sends a Slack message to anyone.**

## Fixed tonight (no approval needed)

| Task | Field | Value | Why |
|---|---|---|---|
| INBOUND: BW Legal query resolution | Business | Real Estate | I opened the email. It is addressed to one of your property companies by name, about an energy account. The entity is named in the letter itself, not guessed. |
| Switch accountants — replace MHH | Business | Real Estate | Three earlier MHH tasks are all tagged Real Estate. |
| INBOUND: YouTube removed your content | Business | Real Estate | The video they pulled is a property job: "Email Utility Company to Request that Liability is Switched to the Tenant(s)". |
| 2-6-2 review: Mica and Ericamae | Business | Operations Director | It is about how your team's roles are set up. |
| Start the weekly work-feed rhythm | Business | Operations Director | Same — how you hand work to the team. |
| Drift Monitor: 12 page health checks | Business | Operations Director | A fault in your software. |
| Drift Monitor: 12 page health checks | Time Estimate | 4 hr | 11 separate checks in different files. Each one has to be read, rewritten so it can actually fail, and tested. |

All seven read back from Airtable after writing and confirmed.

## Waiting on you

**1 decision held.** Say "approve the sweep" in any Claude session to apply it.

| Task | Field | Proposed | Why |
|---|---|---|---|
| Get prospecting ready to go live | Project | The outbound engine runs, every day | Getting prospecting live is that project's own work. |

Carried over from 2 Aug, still not approved. It writes no assignee, so no Slack messages.

**One thing to fix on that task before you action it:** its instructions still tell Ericamae
to "agree with Karlo who checks and answers them each day while Kevin is away". Karlo left on
28 July. It also refers to a trip that has already happened.

## Left alone

**No assignees proposed, for the second night running.** 156 tasks show an empty assignee box.
I checked every one against the Team Member field: **153 already have an AI agent on them.**

| Agent | Tasks it owns |
|---|---|
| AI Operations | 58 |
| AI Worker — Analyst | 46 |
| AI Worker — Writer | 11 |
| AI Worker — Builder | 11 |
| AI Worker — Researcher | 8 |
| AI Worker — Auditor | 6 |
| AI Legal & Compliance | 5 |
| AI Systemisation | 4 |
| Sales, Finance, Strategy, HR | 1 each |

An empty assignee box on those is the design, not a gap. Only **3** tasks have neither a person
nor an agent:

- PARKED — revisit after the first client. Correctly empty.
- E2E Sweep [INFO]: red push gate. Its own notes say nothing needs doing by a human.
- **Drift Monitor: 12 page health checks.** This one is a genuine hole. It was created today
  and shipped with nobody and no agent on it. It is a code fix, so under your AI-first rule it
  should go to the Builder agent. The sweep script cannot write the Team Member field, so it
  needs doing by hand or by whatever creates drift-monitor tasks.

**No recurring values proposed.** I read all 309. Every candidate turned out to be a one-off
job *about* a repeating payment — "set up a standing order for £X a month", "update the standing
order amount on this property". The payment repeats. The task does not. Setting Recurring on those
would make Airtable clone them forever.

**No new project links.** 222 tasks have no project. Almost none should. The 26 monthly UC
verification jobs are routine work, not project work — the payment-gap project is scoped to
four named tenancies plus one empty flat, and dumping 26 chores into it would make its progress
bar meaningless.

**Two business tags I started to write and then dropped**, both after reading the actual email:

- *INBOUND: BW Legal - Our response to your query* — the letter says only "Dear customer" and
  gives reference X2096880. No company named. BW Legal chases you on two separate fronts, one
  property and one personal, so a guess had a real chance of being wrong.
- *INBOUND: Outstanding invoices (MHH)* — the email states the total outstanding is **across
  all companies**. Business is a single-company box, so tagging it Real Estate would hide a
  claim that spans everything.

Also left blank: *Debt recovery decision session — Monies Owed ledger*, same reason.

## Two things worth your attention

**1. MHH is no longer chasing an invoice.** Their director's email of 31 July says they will
now pursue the outstanding fees through the small claims court, for a total spanning every
company. That task is sitting with the AI Operations agent, marked Urgent, due 31 July, now
overdue, with no human on it. A court threat is your decision and a legal matter, not an inbox
item. The email, the figure and the record ID are in tonight's local sweep files, which stay
off this public repo.

**2. The YouTube removal is a data-protection incident.** They pulled a published video for
showing personally identifiable information. That is three days after tenant data went out
through the public repo on 31 July. Two exposures of personal data in three days is a pattern.
Somebody should check what else on that channel has the same problem.

## CEO review

Ran before anything was written. Verdict, in its words:

> "Reviewed against live Airtable before writing. Seven of nine writes approved. Two dropped:
> recD9FGOFtuKQ7ea3 (BW Legal reference X2096880 names no entity, and BW Legal chases both a
> Real Estate and a Personal matter) and recgNHgmM19B1Nbey (the MHH email says the debt spans
> all companies, so a single-entity tag would hide it, the same reason reckPoVJf9ml8YdTw was
> left blank). One carried item dropped: receS4ea0c6kGrqKF must not be made Annually, because
> the task is a failure notice, not the annual routine."

What it changed: I dropped the two business tags above, and dropped yesterday's proposal to make
"Pay Property Redress Membership" an annual repeat. It was right on that last one — the task is
a one-off "your auto-renewal failed" notice. Repeating it yearly would clone a failure email
every August. The yearly obligation belongs in the compliance calendar, not as a cloned task.

It also flagged **a duplicate**: one tenant has two open tasks covering the same change of
address and rent-into-payment job, and only one of them is linked to the payment-gap project.
Two tasks, one job. Worth merging. Both record IDs are in tonight's local sweep files.

Two of its own figures were wrong, and I checked both against Airtable rather than take them:
it reported 263 tasks missing a project and 72 missing a time estimate. The real numbers are
222 and 1. The 263 counts maintenance tickets, which are deliberately exempt. The 72 is a
different field.

**But that 72 is a real find by accident.** 72 open tasks have a Time Estimate filled in and an
empty "Time" box. "Time" is supposed to be copied automatically from Time Estimate by an
Airtable automation. On 72 tasks it has not happened, so any capacity total built on "Time" is
under-counting by about a fifth of your open work. Worth a look.

## The score will not move until this is fixed

Three nights running the score has read 1.9%. It is not measuring mess. 309 of 320 open tasks
are marked non-compliant purely for having a blank Recurring box, and blank is the right answer
for nearly all of them.

Writing "None" into those boxes is not the fix and must never be done: five Airtable formulas
treat "None" as a real repeat value, which would drop one-off tasks into Mica's and Ericamae's
performance figures and arm them to clone themselves.

The real fix is one of:
- stop counting a blank Recurring as a gap, or
- add a "None" guard to the five formulas that misread it.

Until then, read the "fixed tonight" and "waiting on you" sections and ignore the percentage.

## Undo

python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-03.json
