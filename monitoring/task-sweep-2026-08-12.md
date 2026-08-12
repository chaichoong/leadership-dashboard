# Task Hygiene Sweep — 2026-08-12

## Read this first

**A tenant says water is pouring out of their tap.** Task rec410QWIJ1wBGBo8, "INBOUND: SMS
reply from +4475XXXXX747". It was due yesterday, it is marked "Not Urgent", and nobody owns
it. I cannot change the priority or the due date (the sweep is not allowed to overwrite a
field that already has a value), so it needs a person to move it today.

**Four live jobs are owned by people who have left.** They look owned, so nothing chases
them. One is the HMRC restraint-order task dated today, sitting with Karlo Teves, who left
on 28 July.

| Task | Owner who has left | Due |
|---|---|---|
| HMRC Self Assessment — submit overdue payment / restraint order notification | Karlo Teves | 11 Aug |
| Property insurance DDs | Reichelle Rellora | 11 Aug |
| Update Together Duckworth and Together 6CP payment due dates | Reichelle Rellora | 22 Apr |
| Mark Peters COA and rent into payment | Clare Harradine | 22 Apr |

I logged the code fix for this (finding 20260812-task-hygiene-109). The sweep treats any
name in Team Member as a real owner and never checks whether that person still works here.

## Score

Live tasks: 238. Fully compliant: 231 (97.1%).
Owned by an AI agent: 122 (51.3%). Owned by a person: 111. Nobody: 5.
Excluded from the score: 41 waiting on your approval, 16 with no status set.

Gaps found: 154 missing a project (advisory only), 5 missing an owner, 2 missing a due
date, 2 missing a time estimate, 2 missing a business.

**The AI-share KPI is fully covered.** Every task completed in the last 30 days carries a
time estimate, so none of them are invisible to the "Work Done by AI %" number. Seven were
missing a business, which affects attribution only, not the KPI.

## Fixed tonight (no approval needed)

Nine writes across seven tasks.

| Task | Field | Value | Why |
|---|---|---|---|
| Replace window hinge – second bedroom | Time estimate | 1 hr | one contractor visit to swap a failed hinge |
| Replace window hinge – second bedroom | Due date | 15 Aug 2026 | the note says security and weather-tightness risk |
| Measure and quote carpets – both bedrooms | Time estimate | 1 hr | measure two rooms, photograph, produce a quote |
| Measure and quote carpets – both bedrooms | Due date | 27 Aug 2026 | low priority, quote only, no deadline in the text |
| INBOUND: Fintable Lifetime Plan | Business | Real Estate | all 4 Fintable payments are booked to Real Estate |
| INBOUND: Google Payments on hold | Business | Personal | it is an AdSense/YouTube payout hold on Kevin's own channel |
| INBOUND: Virgin Media Order Documents (done) | Business | Personal | all 16 Virgin Media payments are booked to Personal |
| INBOUND: Session 5 Replay (done) | Business | Operations Director | ClickFunnels AI Secrets Challenge — business training |
| INBOUND: Re: your message (done) | Business | Operations Director | same ClickFunnels thread |

Undo any of it with the command at the bottom.

**One thing to know about the money evidence.** Transactions carry two business fields and
they disagree. Virgin Media reads Personal on all 16 rows under `Business (For Reports)`
but Real Estate on 15 of 16 under `Business (from **Account)`. Fintable is the same split
the other way round. I followed `Business (For Reports)`, because that is the field the P&L
reads. Anyone checking with the other field will get the opposite answer.

## Waiting on you

5 decisions held. Say "approve the sweep" in any Claude session to apply them all, or name
the ones to drop.

**No human is being assigned anything, so approving this sends zero Slack DMs.**

| Task | Field | Proposed | Why |
|---|---|---|---|
| INBOUND: SMS reply — leaking tap | Owner | AI Operations | read it, raise the job, book a contractor |
| INBOUND: 1406 Oldham Road electrical certificate | Owner | AI Legal & Compliance | council chasing a certificate; hand the electrician booking to AI Operations |
| Replace window hinge – second bedroom | Owner | AI Operations | booking the contractor is admin an agent can prepare |
| Measure and quote carpets | Owner | AI Operations | chase a supplier for a measure-and-quote |
| Mark Peters COA and rent into payment | Project | Close the payment gap | that project's exact objective |

## Left alone

- **PARKED — revisit after the first client** (recDxBEUC8wk6UIl7): no owner proposed. It is
  parked by your own decision until client one.
- **123 Reg renewal notice** (done): no business. The email does not name the domains and
  there is no 123 Reg payment in the base to trace.
- **Welcome to NeighborsCU!** (done): no business. A US credit union welcoming someone to a
  car loan. It looks misdirected and is not yours.
- **153 of the 154 missing project links.** Most of the list is ordinary operations — UC
  verifications, standing orders, inbound email — and belongs to no project. Forcing a link
  would be worse than a blank.
- **No recurring values proposed, deliberately.** Writing one arms Airtable to clone the
  task and feeds Mica's and Ericamae's recurring performance figures. Several monthly jobs
  in the list would qualify, but the cost of a wrong one is real work for a real person.

## Still real? (9 stale tasks, all over 90 days past due)

Proposals only. Nothing here was changed.

| Task | Due | Verdict |
|---|---|---|
| Pay Final Council Tax Adjustment – 32 Elmdon Place | 22 Jan | **Still live.** Assigned to Mica, 202 days past due. Confirm it was paid, then close it or set a new date. |
| Pay tax liability for tax return 2023/24 – Ciara Brittain | 13 Feb | **Still live and urgent.** Same debt BW Legal are chasing on your inbound queue. Should not be drifting. |
| Fwd: Invoice INV-0549, PPE & Sons Heating & Plumbing (Roy Lavin) | 20 Mar | **Verify then close.** No matching payment in Transactions, but supplier names on bank lines vary, so that is not proof. |
| DD Fire Alarms Ltd – Duckworth Buildings (estimate) | 20 Mar | **Probably dead.** It is an estimate, not an invoice, and the two invoices below followed it. |
| Invoice 40859 from DD Fire Alarms Ltd | 20 Mar | **Verify then close.** No matching payment found. |
| Fwd: Cleaning Invoice (Naturally Neat) | 27 Mar | **Verify then close.** No matching payment found. |
| Invoice 40893 from DD Fire Alarms Ltd | 27 Mar | **Verify then close.** No matching payment found. |
| Update Together Duckworth and Together 6CP payment due dates to the 28th | 22 Apr | **Still live.** Owned by Reichelle Rellora, who has left. Needs a live owner first. |
| Mark Peters COA and rent into payment | 22 Apr | **Still live.** Owned by Clare Harradine, who has left. Needs a live owner first. |

All nine were reached; none skipped. Note that five of the seven invoice or payment items
are already owned by AI Worker — Analyst and have still sat untouched for 138 to 145 days.
An agent holding a task is not the same as an agent doing it. There is already a task on
your list to reconcile these (reclRU3XUWjKgU1Zd, "Reconcile the 19 stale invoice and
payment tasks against Transactions"). That task is the answer to this whole section.

No duplicates flagged. Nothing matched on name, business and due date together.

## CEO review

The AI CEO reviewed the full set before anything was written. Verdict: proceed, with two
changes, both of which I made.

1. **Dropped two writes.** I was going to book the HMRC Self Assessment penalty and the BW
   Legal chase to Personal because they name C M Brittain. The CEO pointed out that Ciara
   co-owns the property portfolio, so a self-assessment liability in her name is at least as
   likely to be rental income tax. Both left blank rather than guessed.
2. **Tightened a due date.** The window hinge moved from 19 Aug to 15 Aug, because the note
   describes a security and weather-tightness risk even though the Priority field says
   "Not Urgent".

It also confirmed the leaking-tap task needs moving today, found the Clare Harradine
ownership problem, and corrected my Virgin Media evidence (16 transactions, not the 6 my
query returned — I had capped the result and quoted the cap as the total). Both business
calls still stand; the field is named in the evidence now.

## Filed for the code queue

- `20260812-task-hygiene-109` (high) — the sweep counts an offboarded person as a valid
  owner, which is how four live jobs came to be owned by people who have left.
- `20260812-task-hygiene-110` (low) — the stale list does not carry enough detail to judge
  a task without re-reading each record from Airtable.

Nothing was committed. No code was changed.

## Undo

python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-12.json
