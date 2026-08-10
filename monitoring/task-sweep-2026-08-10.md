# Task Hygiene Sweep — 2026-08-10

## Score

Live tasks: 264. Fully compliant: 263 (99.6%). It read 96.7% yesterday.

Owner split: 120 tasks owned by an AI agent (45.5%), 143 by a person, 1 by nobody.

Only two gaps are left in the whole live list:

- 173 tasks have no project link. That is advisory and does not count against the score.
- 1 task has no owner at all.

Completed work in the last 30 days: **128 of 128 carry a time estimate (100%)**. Nothing is
invisible to the "Work Done by AI %" figure on the dashboard. 60 of them were missing a
business, which is attribution only and does not move that figure.

**No assignee changes are proposed tonight, so no Slack messages fire.**

## Fixed tonight (no approval needed)

51 business labels filled in on tasks that were already finished, so the money and the work
land against the right side of the business.

| What kind of task | How many | Labelled as |
|---|---|---|
| Council tax, water, mortgages, landlord insurance, letting agent, tenant messages, contractor invoices, company filings and tax, accountant handover, Nest pensions | 28 | Real Estate |
| Platform build (Supabase migration, multi-tenancy, website, client template, defects) plus marketing and outreach (lead magnets, prospecting list, GoHighLevel, content machine, LinkedIn, Ericamae's review) | 17 | Operations Director |
| Own money buckets, a family transfer, two personal deliveries, a Runpreneur Ltd filing | 6 | Personal |

Full list with a reason for every single one:
`monitoring/task-sweep-decisions-2026-08-10.json`

How I decided: I did not guess a company. I looked up how the same company had been labelled
on tasks that already exist. Brittain Holdings, TNT Management, Agile Estates, Nest, British
Gas, AO Finance, Close Brothers, Swinton, Kent Reliance, Intus and the MHH accountants all
already sit under Real Estate. Runpreneur already sits under Personal.

## Waiting on you

2 decisions held. Say "approve the sweep" in any Claude session to apply them both.

| Task | Field | Proposed | Why |
|---|---|---|---|
| Fix email authentication for operationsdirector.co.uk (SPF + DKIM) | Project | The outbound engine runs, every day | Its own description says the warm-20 emails go out over exactly this path |
| Customer Journey Map v7 note: stage 4 silence no longer hands prospects to W3 | Project | The outbound engine runs, every day | The map has to match what the daily prospecting agent actually does now |

Neither is an assignee, so approving them sends nobody a message.

## Left alone

- **171 of the 173 missing project links.** They are ordinary day-to-day operations: council
  tax standing orders, UC verifications, supplier invoices, inbound post. They do not belong
  to any of the eight open projects and forcing a link would make the projects meaningless.
- **1 task with no owner: "PARKED — revisit after the first client"** (due 31 Dec 2026). It is
  a container holding four shelved ideas, not a job. Giving it an owner puts a fake task on
  someone's list. Leave it.
- **5 completed tasks I would not label**, because the evidence points both ways and a wrong
  entity label is expensive on this class of record: two HMRC self-assessment letters for
  CM Brittain, a British Gas final bill for Ciara Brittain, a Companies House penalty appeal
  that never names the company, and a debt-recovery letter from a company with no history in
  the system.
- **4 more I would not label:** a Virgin Media order, a 123 Reg domain renewal that does not
  say which domain, and two emails about a course replay.

## Still real? (the 53 tasks over 90 days past due)

These are proposals only. Nothing was changed. I judged the 20 oldest; 33 were not reached.

**Probably done already — propose closing (7)**

| Task | Overdue | Why |
|---|---|---|
| 42 Elmdon Place — January Invoice | 185 days | Rob's monthly letting invoice; six later months have come and gone |
| 32 Elmdon Place — January Invoice | 185 days | Same |
| 28 Chedburgh Place — December Invoice | 185 days | Same |
| Invoice 002KBRI26 — Athertons Exterior Cleaning (£45) | 164 days | Small one-off from February |
| Fwd: Invoice INV-0549, PPE & Sons (£168) | 143 days | Was due 16 March |
| Invoice 40859 from DD Fire Alarms Ltd | 143 days | Was due March |
| Fwd: Cleaning Invoice | 136 days | Was due March |

Worth a two-minute check of the bank feed before closing. I did not verify payment; the
transaction records are not linked to these tasks.

**Probably dead — propose closing with the reason (5)**

| Task | Overdue | Why |
|---|---|---|
| Onyx Bureau — ONYX888-0255 | 332 days | No detail at all on the record and nearly a year old |
| Pay AXA Outstanding Balances | 318 days | Insurance has since moved to Swinton |
| duckworth snagging 23rd | 290 days | Superseded by the later Duckworth compliance work |
| DD Fire Alarms Ltd — Duckworth Buildings | 143 days | This is an estimate, not an invoice; the invoice above covers it |
| Brett Wilson (Feb invoice) | 185 days | Two newer Brett Wilson invoices are already live and dated August |

**Still live, just slipped — propose a new date (8)**

| Task | Overdue | Proposed next step |
|---|---|---|
| RE: Duckworth Apartments — Back West Crescent | 159 days | A Section 59 Building Act demand from Fylde Council. Legally serious. Give it to the AI legal and compliance agent to prepare a reply, due 17 Aug |
| Pay tax liability for 2023/24 — Ciara Brittain | 178 days | Part of the live HMRC matter. Stays with you. New date 24 Aug |
| MHH Confirmation statements | 435 days | Check Companies House for what is actually outstanding, then close or file. AI legal and compliance agent, due 24 Aug |
| Pay Final Council Tax Adjustment — 32 Elmdon Place | 200 days | Council tax is now on standing orders. Confirm the balance, then close. Due 24 Aug |
| Housing Benefits Overpayments — 41052677 (£15.99) | 161 days | Pay it and close. Due 17 Aug |
| Send Rob Jackson the referral email list | 164 days | An agent can draft it for your approval. Due 17 Aug |
| Land registry Docs — 4 Abington | 350 days | No detail on the record. Needs one line from you: still needed, or close it |
| 42 elmdon doors | 304 days | No detail on the record. Needs one line from you: still needed, or close it |

**Duplicates:** I checked all 323 live tasks for exact matches on name, business and due date
together. There are none. Name-similarity alone is not evidence and I did not use it.

## CEO review

The `od-ceo` agent reviewed the set before anything was written and told me to drop four of
the business labels. It was right, and I checked its evidence rather than taking its word:

- It found that Ciara Brittain's tax letters are labelled **Real Estate** on some existing
  records and **Personal** on others. My rule said Personal. Mixed evidence is not a rule, so
  those come out.
- The Companies House penalty appeal never names the company, which is exactly why I had
  already left four others blank. Inconsistent of me. Dropped.
- Legal Protection Group has never appeared on any task before, so there was nothing to match
  against. Dropped.

I dropped a fifth on the same reasoning it gave (the second CM Brittain letter), taking the
auto tier from 56 down to 51. It approved both project links and agreed the parked container
should stay unowned.

Its wider point, which I am passing on unchanged: attribution tidy-ups do not move revenue,
and 53 tasks over 90 days past due is a fifth of the live list. The stale list is worth more
of your attention than the field-filling.

## Undo

python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-10.json
