# Task Hygiene Sweep — 2026-08-24

## Score
Live tasks: 215. Fully compliant: 200 (93.0%). Was 94.4% on 23 Aug.
Owned by AI: 103 (47.9%). Owned by a person: 100. Owned by nobody: 12.
Completed work in the last 30 days that carries a time estimate: 118 of 118 (100%).
Nobody who has left owns anything.

The score dipped 1.4 points because four new tasks arrived overnight with gaps, not
because anything went backwards.

## Fixed tonight (no approval needed)
| Task | Field | Value | Why |
|---|---|---|---|
| INBOUND: reply to James Brittain (WhatsApp) | Business | Personal | Reply to his son about a birthday present |
| INBOUND: reply to Ciara Brittain re order (WhatsApp) | Business | Personal | Personal shopping order |
| INBOUND: reply to Tabitha Ashurst (WhatsApp) | Business | Personal | Personal chat, France and her apprenticeship |
| INBOUND: reply to Sam Atherton (WhatsApp) — already done | Business | Personal | A sum Kevin owes personally |
| INBOUND: Important information (SSE smart meters) | Due Date | 2026-09-14 | No deadline in the email, priority Not Urgent, so 15 working days out |

## Waiting on you
13 decisions held. Say "approve the sweep" in any Claude session to apply them all,
or name the ones to drop.

**Only ONE of these is a person, so approving sends only ONE Slack message.** The other
ten owners are AI agents.

| Task | Field | Proposed | Why |
|---|---|---|---|
| Replace window hinge, second bedroom | Owner | AI Operations | Books and chases the contractor; the repair itself is the contractor's job |
| Measure and quote carpets, both bedrooms | Owner | AI Operations | Arranges the supplier to measure and quote |
| INBOUND: SSE smart meter notice | Owner | AI Operations | Reads and actions a supplier notice about the properties |
| INBOUND: SMS reply from a tenant | Owner | AI Operations | Tenant lists repairs; log the jobs and reply |
| INBOUND: Manchester council, 1406 Oldham Road | Owner | AI Legal & Compliance | Council enforcement demanding an electrical safety certificate |
| INBOUND: Ribble Valley council, 18 Siddows Avenue | Owner | AI Legal & Compliance | Council complaint about garden waste and rats |
| E2E Sweep warning: stale brain feed, 19 prospects | Owner | AI Worker — Builder | Code and data fix |
| Drift warning: client CEO Brief not live | Owner | AI Worker — Builder | Run migration 0043 and deploy the worker |
| Second warm-lane touch: bring a recommendation | Owner | AI Sales | Prepares the go or no-go; Kevin still decides |
| Q4 review: live-build sales call | Owner | AI Sales | Gathers the Rocket Demo call data; Kevin still decides |
| Approve the 6 four-line test emails | Assignee | **Kevin** | Only Kevin can approve emails before they send |
| Approve the 6 four-line test emails | Project | The outbound engine runs, every day | It is that project's work |
| Drift warning: client CEO Brief not live | Project | Complete all modules for the OD Web App | The client CEO Brief is a web app module |

## Two things I could not fix but you should see
**1406 Oldham Road is sitting at "Not Urgent" and is 10 days past its date.** Manchester
council asked for an electrical safety certificate and an inspection date by 10 August.
This is a legal duty with a fine behind it. The sweep is not allowed to change priority.
Somebody needs to move it to Urgent.

**The tenant text message is four jobs squashed into one 15-minute task.** Roof leak,
loose bath tiles, a flickering socket and smoke alarms. The flickering socket is a safety
item. It should be split into separate maintenance tickets, and the 15-minute estimate is
making the "Work Done by AI" number wrong because that number is weighted by time.

## Left alone
- 133 tasks with no project. Judged not project-based: they are ordinary day-to-day work.
- "PARKED — revisit after the first client" left with no owner on the CEO's advice. Giving
  a parked task an owner makes it look like work is happening when it is not.
- Two completed tasks left with no business: a 123 Reg domain renewal (the email does not
  say which domains, so it could be Operations Director or personal) and a "Welcome to
  NeighborsCU" email from a US credit union about a vehicle loan, which does not look like
  Kevin's at all.
- Every open task still shows a "missing recurring" gap. That is a scoring quirk, not mess.
  Writing "None" would arm one-off tasks to clone themselves. The real fix is a code change
  to five Airtable formulas.

## Still real? (6 tasks over 90 days past due — proposals only, nothing was changed)
I checked all six against the Invoices table, and the CEO then checked my checking against
the bank. **It caught me out, and the result matters more than the tasks.**

| Task | What I found | What I propose |
|---|---|---|
| INV-0549, PPE & Sons for Roy Lavin | Invoice says Paid, bank shows no such payment ever | Do NOT close. Verify first |
| Fwd: Cleaning Invoice (£44) | Invoice says Paid, bank shows no such payment ever | Do NOT close. Verify first |
| Invoice 40893, DD Fire Alarms | Invoice says Paid, bank shows no payment to DD Fire ever | Do NOT close. Verify first |
| DD Fire Alarms, Duckworth Buildings | This is an expired estimate, not an invoice, and it is flagged a duplicate | Do NOT close. Verify first |
| Invoice 40859, DD Fire Alarms | No matching invoice record at all | AI Finance searches Gmail and the Intus statement before anyone phones DD Fire |
| Pay tax liability 2023/24, Ciara Brittain | 192 days past due, assigned to Mica, who cannot make payments | Kevin confirms whether it is paid, then close it or re-date it. Its business is Real Estate, not Personal |

**Why none of them close.** Seven-plus invoice rows all carry the same "paid" date of
29 June 2026 with no bank transaction attached to any of them. That is one bulk button
press, not seven real payments. Proof: an Athertons invoice carries the same 29 June stamp
while the real Atherton payments went out on 18 April and 4 June. So the word "Paid" on
those rows means nothing, and closing four supplier tasks on the strength of it would have
buried up to £400 of possibly unpaid bills. Filed as finding 20260824-task-hygiene-sweep-334
for the code queue.

The letting agent may well have netted the Duckworth and Intus ones off the rent, which
never touches the bank. That is plausible. It is not proven, which is exactly the point.

## CEO review
Ran. It approved all five auto writes and checked the Sam Atherton one independently
(£45 to Samuel John Atherton on 22 Aug, a bill at Kevin's own home, so Personal is right).

It made me change four things:
1. Dropped all four "propose complete" stale proposals, because the Paid stamp is fake.
2. Corrected the tax task's business to Real Estate, and named the real problem: it is a
   payment sitting with Mica, who cannot make payments, and has been for 192 days.
3. Sent invoice 40859 to AI Finance, not to Kevin. A phone call is a hard rule, but only
   after Gmail and the Intus statement have been searched.
4. Left the parked task unowned.

It also flagged that these same 11 tasks and 6 stale items have been re-proposed every
night for 8 nights running and nothing clears. The pending list is a treadmill, not a
queue. Its recommendation: anything proposed three sweeps running should escalate once
with a recommendation attached, or be suppressed. Same for the 133 "not project-based"
judgements, which are thrown away and re-made every night.

## Undo
python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-24.json
