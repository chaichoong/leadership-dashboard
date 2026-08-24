# Task Hygiene Sweep — 2026-08-14

## Score
Live tasks: 251. Fully compliant: 239 (95.2%). Was 95.6% yesterday (13 Aug).
Owned by an AI agent: 153 (61.0%). Owned by a person: 94. Owned by nobody: 4.
Gaps tonight: 168 missing a project, 8 missing a business, 4 missing an owner, 8 tasks more than 90 days past due.

## Read this first
The council deadline on 1406 Oldham Road has passed. Manchester City Council's housing
officer asked for an update "no later than Monday 10 August". Today is the 14th, so that
is four days late. The email wants two things: the date the electrician attends, and a
satisfactory Electrical Safety Certificate. Roy Lavin already holds five open tasks on
that property, including one for the certificate due today.

## Fixed tonight (no approval needed)
| Task | Field | Value | Why |
|---|---|---|---|
| INBOUND: reply re CreditStyle debt notice for Ciara | Business | Personal | debt notice addressed to Ciara Brittain, a household matter |
| INBOUND: reply to Virgin Media fibre switch text | Business | Personal | home phone line at Kevin's own house |
| INBOUND: verify Interactive Investor password change | Business | Personal | Kevin's personal investment account |
| INBOUND: reply to P&J 50th Anniversary group | Business | Personal | family caravan weekend |

No time estimates or due dates needed filling tonight. Every open task already carries both.

## Waiting on you
3 decisions held. Say "approve the sweep" in any Claude session to apply them all, or name
the ones to drop. Only 2 of them are assignee writes, so approving sends 2 Slack messages.

| Task | Field | Proposed | Why |
|---|---|---|---|
| INBOUND: Urgent Update required: 1406 Oldham Road | Owner (AI) | AI Operations | operational chase, not a legal question; the answer is already in Roy Lavin's five tasks |
| Replace window hinge – second bedroom | Assignee | Mica | someone must book a contractor and get on site; no contractor set |
| Measure and quote carpets – both bedrooms | Assignee | Mica | on-site measure, photos and a quote; no contractor set |

## Left alone
4 tasks where I could not make an honest call:

- **INBOUND: reply to SSE Energy Solutions** — no business. £1,073.08 energy balance, account
  8702010539. The task itself says the property or business behind the account is still to be
  identified, so Real Estate or Personal is a coin toss.
- **INBOUND: reply to UKSL re Utilita debt** — no business. Same reason, reference 5482505.
- **INBOUND: reply to Anglia Revenues council tax notice** — no business. Anglia Revenues bills
  for several of the Haverhill-area properties and for a home address, so I cannot tell which.
- **PARKED — revisit after the first client** — no owner. It is a holding record for four jobs
  Kevin parked until client one. Naming an owner would restart work he deliberately stopped.

Two tasks completed in the last 30 days still have no business: the 123 Reg renewal notice
(the email names no domain, so I cannot say which business it belongs to) and the
NeighborsCU welcome email. Neither affects the "Work Done by AI %" figure — every completed
task in the window carries a time estimate, so coverage is 100 of 100%.

## Still real? (8 tasks over 90 days past due — proposals only, nothing changed)
| Task | Due | Days late | My read |
|---|---|---|---|
| Pay Final Council Tax Adjustment – 32 Elmdon Place | 22 Jan | 204 | Probably done already. Mica owns it and the property pays £165 council tax monthly. Propose asking her to confirm and close. |
| Pay tax liability for tax return 2023/24 – Ciara Brittain | 13 Feb | 182 | Still live and it is a debt. Marked Urgent, seven months untouched. Propose a new date and a check of what is outstanding. |
| Fwd: Invoice INV-0549, PPE & Sons for Roy Lavin | 20 Mar | 147 | Cannot tell. No payment matching this supplier exists in the transactions, but the invoice went to Roy Lavin, who may have settled it himself. Propose one message to Roy covering all four. |
| DD Fire Alarms Ltd – Duckworth Buildings | 20 Mar | 147 | Same. This one is an estimate, not an invoice, so it may simply be dead. |
| Invoice 40859 from DD Fire Alarms Ltd | 20 Mar | 147 | Same. No DD Fire payment found in transactions. |
| Fwd: Cleaning Invoice (Naturally Neat) | 27 Mar | 140 | Same, and low value. Propose closing if Roy confirms it was paid. |
| Invoice 40893 from DD Fire Alarms Ltd | 27 Mar | 140 | Same. [name redacted] asked Kevin to settle direct with DD Fire. |
| [name redacted] COA and rent into payment | 22 Apr | 114 | Still live. Mica owns it, status Today, and it belongs with the payment-gap project. Propose a new due date. |

All 8 reached, none skipped. I did not act on any of them.

## The write nobody proposed
No task in the base links to the property 1406 Oldham Road, even though six live tasks are
about it. Linking them is mechanical, fires no Slack message, and it is what makes
property-level cost and compliance reporting correct. Not in this sweep's scope, so flagged
rather than done.

## Recurring stays open on purpose
167 tasks still count as "missing recurring". Writing "None" is not a fix: Airtable reads
"None" as a real value, which arms a one-off task to clone itself and drags Mica's and
Ericamae's performance figures. The real fix is a code change to five formulas, so the
score stays low by choice.

## CEO review
Reviewed by AI CEO. Verdict: six of eight writes sound, two changed.

- **Re-routed** the 1406 Oldham Road task from AI Legal & Compliance to AI Operations. It is
  a chase for a date and a certificate, not a legal question, and it matches how the last
  Manchester council email was routed. The CEO also found the expired 10 August deadline,
  which is now at the top of this report.
- **Dropped** the Sam Atherton business fill. I had read "Personal" from the task's own
  description, which the inbound sweep wrote. The invoice PDF sits unread in WhatsApp since
  5 August, so the answer is retrievable rather than inferred. Left blank.
- Kept the two Mica assignments. The CEO checked and Mica is the standing owner for
  maintenance coordination across the portfolio.

## Undo
python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-14.json
