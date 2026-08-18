# Task Hygiene Sweep — 2026-08-18

## Score
Live tasks: 248. Fully compliant: 232 (93.5%). Was 97.7% on 16 Aug.
Owned by an AI agent: 139 (56.0%). Owned by a person: 103. Owned by nobody: 6.
Also excluded from the score: 42 tasks waiting on your approval, 16 with no status.

The score fell because 31 more tasks are live than on Sunday, not because anything
got worse. Nothing was swept on Monday 17 Aug — there is no report for that day.

## Read this first

**1. Three bills you were about to be chased for are already paid.**
Five old supplier invoices have sat on the list since March. I searched the bank
feed and found no payments, and I was about to report all five as unpaid. Your AI
CEO checked a different table, Dashboard Invoices, and found three of them settled
months ago: PPE & Sons £168, DD Fire Alarms £258, DD Fire invoice 40893 £121.80.
I checked that myself and it holds. Only two are genuinely unaccounted for:
DD Fire invoice 40859 at £102 and a Naturally Neat cleaning invoice at £44.

**2. The council job has now waited three nights for one click.**
1406 Oldham Road is 8 days past Manchester City Council's own deadline. Good news
buried in the pile: Roy told you on 15 Aug the EICR passed. So the job is no longer
a chase, it is "get the certificate from Roy and send it to the council". It still
has no owner, only because the routing was never approved.

**3. Six decisions are waiting and approving them sends zero Slack messages.**
Every one goes to an AI agent, not a person.

## Fixed tonight (no approval needed)

12 writes across 10 tasks.

| Task | Field | Value | Why |
|---|---|---|---|
| INBOUND: reply to UKSL re Utilita debt | Business | Real Estate | every Utilita item in Invoices is apartment energy (Apt 8, various apartments) |
| INBOUND: Manus account will be deleted | Business | Operations Director | Manus is platform tooling |
| INBOUND: reply to Roy Lavin (WhatsApp) | Business | Real Estate | EICR pass for 1406 Oldham Road |
| INBOUND: YouTube monetization terms | Business | Personal | the channel is your running vlog |
| INBOUND: SMS reply, tap charge ~£100 | Business | Real Estate | tenant repair pricing |
| E2E Sweep [CRITICAL]: completion-stamp leak | Business | Operations Director | platform's own data check |
| E2E Sweep [CRITICAL]: completion-stamp leak | Time Estimate | 2 hr | trace the leak, fix it, add a test |
| INBOUND: reply to Roy re paying David and refund | Business | Real Estate | contractor and fuel for property works |
| INBOUND: Duckworth Flats post for TNT Management | Business | Real Estate | block managing agent |
| INBOUND: tenant SMS, kitchen tap still running | Business | Real Estate | tenant repair |
| INBOUND: SMS reply, same tap thread | Business | Real Estate | same tenant, same tap |
| INBOUND: SMS reply, same tap thread | Due Date | 2026-08-20 | tenant has chased five months and water runs constantly |

## Waiting on you

6 decisions held. **This will send 0 Slack messages** — all five owner decisions go
to an AI agent. Say "approve the sweep" in any Claude session to apply them all, or
name the ones to drop.

| Task | Field | Proposed | Why |
|---|---|---|---|
| INBOUND: Urgent Update required: 1406 Oldham Road | Owner | AI Operations | 8 days past the council deadline. EICR passed 15 Aug, so send the certificate |
| INBOUND: 18 Siddows Avenue Clitheroe | Owner | AI Operations | Environmental Health on garden condition and rats; confirm we still act, then draft the reply |
| Replace window hinge, second bedroom | Owner | AI Operations | agent books the contractor, contractor attends |
| Measure and quote carpets, both bedrooms | Owner | AI Operations | agent arranges, contractor attends |
| INBOUND: SMS reply from tenant re tap | Owner | AI Operations | agent replies and books it |
| Mark Peters COA and rent into payment | Project | Close the payment gap | third night proposed, never approved |

## Left alone

- **INBOUND: reply to SSE Energy Solutions (£1,073.08 debt)** — no business set. I
  searched Costs and Invoices for "SSE Energy Solutions" and found nothing against
  a working control. I will not guess which property or business owns it.
- **PARKED — revisit after the first client** (due 31 Dec) — no owner proposed.
  Naming one risks an agent picking up work you deliberately parked. Your CEO's
  view: change its status rather than manage it with a blank.

## Still real? (8 tasks over 90 days past due — proposals only, nothing was changed)

| Task | Age | What I think it is | Proposal |
|---|---|---|---|
| Fwd: Invoice INV-0549, PPE & Sons, £168 | 151 days | **Done already** — Invoices says Paid | Complete it. Also two identical rows exist, delete one |
| DD Fire Alarms Ltd, Duckworth, Estimate 1724, £258 | 151 days | **Done already** — Invoices says Paid | Complete it |
| Invoice 40893 from DD Fire Alarms, £121.80 | 144 days | **Done already** — Invoices says Paid (via Intus) | Complete it |
| Invoice 40859 from DD Fire Alarms, £102 | 151 days | **Still live** — no invoice record at all | Verify with DD Fire, then pay or close |
| Fwd: Cleaning Invoice, Naturally Neat, £44 | 144 days | **Still live** — no invoice record at all | Verify with Roy, then pay or close |
| Pay Final Council Tax Adjustment, 32 Elmdon Place, £9.96 | 208 days | **Still live**, misrouted | £9.96 is under your £50 act-and-go rule. Chasing it for seven months has cost more than the debt. Just pay it |
| Pay tax liability 2023/24, Ciara Brittain, £124.60 | 186 days | **Still live**, misrouted | Sat with Mica since February marked Urgent. Only you can pay it. Agent prepares, you click once |
| Mark Peters COA and rent into payment | 118 days | **Still live** | See the project decision above |

All 8 reviewed. None left unreached.

## Completed-work coverage (keeps the "Work Done by AI %" honest)

164 of 164 tasks completed in the last 30 days carry a time estimate — 100%.
(Counted directly against Airtable with pagination, not read off the audit summary.)
4 completed tasks are missing a Business. That is attribution only and does not
touch the AI-share number, so I left them: three are one-line inbound emails
(123 Reg renewal, NeighborsCU welcome, an SMS reply) and one is a Roy Lavin
Universal Credit reply. None are worth a guess.

## The recurring gap is a scoring artefact, not mess

Most open tasks still count as "missing recurring". Writing "None" into that field
is not the same as leaving it empty — Airtable treats "None" as a real value and it
would arm one-off tasks to clone themselves and pollute Mica's and Ericamae's
performance figures. So I do not fill it. The real fix is a code change and it is
on the findings queue.

## CEO review

Your AI CEO reviewed everything before a single write. Verdict: auto tier sound
with two corrections, stale tier wrong as it stood. What it changed:

- **Caught the three paid invoices.** Without it this report would have created
  about £548 of chase work against settled bills. I verified its evidence myself in
  Dashboard Invoices before accepting it.
- **Filled a blank I had left.** UKSL/Utilita is Real Estate, evidenced by apartment
  energy invoices. I applied that.
- **Confirmed** the YouTube-to-Personal call, all the Real Estate calls, and that the
  Ribble Valley rats job belongs to Operations, not Legal.
- **Flagged** that the two payment tasks sitting with Mica since February can only be
  executed by you, and that £9.96 is below your own act-under-£50 threshold.
- **Noted** Roy's "how are the leads going" question is an Operations Director thread
  that will get buried inside a property reply.

Where I did not follow it: it said not to override the tap task's due date and to fix
its Priority instead. The task had **no** due date at all, which is the gap, and
Priority is not a field this sweep may write. So I set 20 Aug and flag it here: that
task is marked "Not Urgent" and it is a tenant with water running constantly. The
Priority is wrong and only you or Mica can change it.

## Filed for the code queue (I am not allowed to edit code)

- `20260818-task-hygiene-sweep-199` — the sweep judges old invoice tasks with no
  source, which is how it nearly chased three paid bills. It should read Dashboard
  Invoices.
- `20260818-task-hygiene-sweep-200` — "project" is blank on 66% of live work and is
  still reported nightly. Either drop it from the report or let it apply itself.

## Undo
python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-18.json
