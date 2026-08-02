# Task Hygiene Sweep — 2026-08-02

## Score

Open tasks: 317. Fully compliant: 6 (1.9%). Same as yesterday.

**But the score is measuring its own blind spot, not your mess.** Read the next section
before you approve anything. Last night's file was about to move 158 jobs off your AI agents
and onto you, Mica and Ericamae.

## The thing I got wrong last night, and caught tonight

Last night I left 158 decisions waiting for you, nearly all of them "this task has nobody's
name on it, give it to Mica or Kevin or Ericamae". You never approved them. Good.

Tonight I checked **why** those tasks had no name on them. Of the 165 tasks flagged as having
no assignee, **163 already have an owner**. The owner is an AI agent:

| Agent | Tasks it already owns |
|---|---|
| AI Operations (Gino Wickman) | 59 |
| AI Worker — Analyst | 53 |
| AI Worker — Writer | 13 |
| AI Worker — Builder | 11 |
| AI Worker — Researcher | 8 |
| AI Worker — Auditor | 6 |
| AI Legal & Compliance | 5 |
| AI Systemisation | 4 |
| Sales, Finance, Strategy, HR | 1 each |

Two things in your own code prove a blank name is correct on these, not missing:

1. The dispatch engine picks up agent work by the **Team Member** link, not by the assignee
   box (`scripts/agent-dispatch.py`, lines 262-271). Those 163 tasks are the live agent queue.
2. When you approve an agent's work, the system **deliberately empties the assignee box**.
   The line even says so: "the agent owns it now; Assignee cannot hold one"
   (`scripts/slack-automation/approvals.js:436`).

So the sweep was reading an empty box as a problem when the empty box is the design. Writing
names into those 163 would have fired **158 Slack messages** and, worse, quietly handed work
your AI agents are already doing to three humans. That is the opposite of your "AI first, team
second, founder last" rule.

**Tonight I propose zero assignees.** The only two tasks with no agent and no person are one
marked "PARKED — revisit after the first client" and one whose own notes say nothing needs
doing by a human. Both are right to stay empty.

## Fixed tonight (no approval needed)

| Task | Field | Value | Why |
|---|---|---|---|
| INBOUND: Companies House Ref COH2241140X | Business | Real Estate | I opened the actual email chain. The reference is Agile Estates Ltd, company 12168161, about overdue confirmation statements. |
| Drift Monitor: SOP staleness under-reported | Business | Operations Director | Platform documentation, your software. |
| Drift Monitor: SOP staleness under-reported | Time Estimate | 1 hr | It asks you for a decision, not code: read 12 pages whose guides are behind and 13 with no guide, and say which need one. |
| E2E Sweep: red push gate | Business | Operations Director | Platform deploy check, your software. |
| E2E Sweep: red push gate | Time Estimate | 45 min | Bump two version numbers across about six pages and re-run the tests. |

All five verified in Airtable after writing.

## Waiting on you

2 decisions held. Say "approve the sweep" in any Claude session to apply them.
**Neither sends a Slack message to anyone.**

| Task | Field | Proposed | Why |
|---|---|---|---|
| Pay Property Redress Membership | Recurring | Annually | Membership renews yearly, and the task is due 10 Aug so the yearly cycle starts from a date you have not already missed. |
| Get prospecting ready to go live | Project | The outbound engine project | It is that project's work. |

## Two things you need to see, that are not tidy-up

**1. Three gas safety certificates have expired and still read "Active" in Airtable.**

I checked all 83 certificates. 16 are past their renewal date. Six of those still show as
Active, which means nothing is flagging them:

| Expired | Type | Certificate record |
|---|---|---|
| 24 Apr 2026 | Gas safety | recaHmCjCt55X3PJw |
| 22 May 2026 | Gas safety | (2 of 3, see the Property Certificates table) |
| 31 Jul 2026 | Gas safety | (3 of 3, see the Property Certificates table) |
| 17 Mar 2026 | EICR | 1 record |
| 22 Apr 2026 | Emergency lighting | 1 record |
| 19 Jun 2026 | EPC | 1 record |

Addresses left out on purpose: this repo is public, and a list of your properties with lapsed
safety certificates is not something to publish. The full list with addresses is in the
Property Certificates table in Airtable, filtered to Renewal Date before today.

A lapsed gas safety certificate on a let property is a criminal offence and it kills a
section 21 notice. The oldest one has been overdue 100 days and its renewal task has sat on
"Today" for 102 days.

This is also why I dropped two of last night's proposals. I was going to mark those renewal
tasks as yearly. That would have locked the next inspection to the anniversary of a date the
inspection did not happen on.

**Suggested next action: book the three gas safety inspections this week.**

**2. Your accountant is threatening the small claims court.**

The MHH email of 31 July (subject "Outstanding invocies", from the director) says he now has
no option other than to pursue the outstanding fees through the small claims court, and gives
a five-figure total owed across all the companies. The exact figure is in the email; it is not
repeated here because this repo is public.

I was going to file this under Real Estate. I dropped it, because the email says the debt
spans all companies — it is a group matter, not one business. The same goes for the "switch
accountants" task.

Nothing in the agent system's danger list catches the words "small claims court", so this
reached the ordinary work queue rather than being flagged. Given your live legal matter, this
is yours to look at, not an agent's.

**3. A tenant-data video was taken down.**

YouTube removed "Email Utility Company to Request that Liability is Switched to the
Tenant(s)" for breaching its rules on personal information. That is a property how-to video
that appears to have had tenant details visible on a public channel. Worth checking what else
is on that channel before appealing. I left its business tag blank rather than guess.

## Left alone

- **306 tasks with no Recurring value.** Unchanged from last night, and still correct. Filling
  them with "None" would treat every one as a monthly job in your capacity numbers, because
  the "30 Day Occurrences" formula falls back to 1 for any value it does not recognise. It
  would also pollute Mica's and Ericamae's on-time recurring scores.
- **219 tasks with no project.** Most are ordinary operations and belong to no project.
- **3 tasks where I could not tell the business**, and would rather leave blank than guess:
  the two BW Legal chasers (BW Legal pursues both TNT Management and a separate personal tax
  debt; the email names neither) and the £13k Monies Owed ledger, which the master plan
  records as spanning you personally and Social Housing Estates.

## CEO review

The CEO backed dropping all 158 assignee writes, and found more than I had: **four** deployed
Airtable automations watch the assignee box, not one. Beyond the Slack message, writing a name
also strips a task out of the Inbound Approval view, clears the Some Day tick, and rewrites
the assignee history.

It made me drop three of my eight planned writes:
- The two MHH ones, because the email says "across all companies" (I checked; it does).
- The YouTube one, because the tag is a guess and the data exposure is the real story.

It also corrected me on one detail: the task-cloning automation is switched off, so "None"
would not actually clone anything today. The capacity and scoring damage is real; the cloning
claim was not. I checked both against the live formulas.

**One recommendation I have NOT acted on, because it changes what the sweep measures and you
approved this scope on 30 July:** teach the sweep to count an AI agent as an owner, and stop
counting a blank Recurring as a gap. On tonight's identical data that moves compliance from
**1.9% to about 97%**. Without it, tomorrow night proposes the same 158 assignees again. Say
the word and I will make the change.

## Undo

python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-02.json
