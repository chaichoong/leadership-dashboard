# Task Hygiene Sweep — 2026-08-04

> Redacted for the public repo. Names, suppliers and exact sums are in the local-only
> `monitoring/task-sweep-detail-2026-08-04.md`.

## Read this first

Two things in the task list matter far more than tidy fields tonight.

1. **A supplier is threatening small-claims action over unpaid fees (five figures).** The
   email arrived 31 July, the task is 4 days overdue, and it is sitting with an AI Operations
   agent. This is a legal matter involving an adviser being replaced by end September, not an
   ops job. Task `recgNHgmM19B1Nbey`.
2. **A rent recovery is 104 days overdue.** Due 22 April, on a unit that is tenanted and not
   paying. Currently with Mica. Task `recQrDlBBmhWyX7hq`.

Also worth attention: the debt-recovery decision session (`reckPoVJf9ml8YdTw`) is overdue and
sitting with Mica. Chasing a five-figure sum owed to Kevin is a founder call, not a staff job.

## Score

Open tasks: 323. Fully compliant: 6 (1.9%). Was 1.9% yesterday, and on 2 Aug, and on 1 Aug.

The score has not moved in four days and it cannot move. Two reasons, both below: the
recurring rule alone caps the best possible score at about 3%, and 96% of the "missing
assignee" tasks are not actually missing an owner.

The 323 also overstates things. 22 of those tasks sit in "Approval" and 18 have no status at
all. Real open work is 283.

## Fixed tonight (no approval needed)

8 writes across 5 tasks.

| Task | Field | Value | Why |
|---|---|---|---|
| Drift Monitor: dead-reference scan only read a fifth of the code | Business | Operations Director | scans this repo's own code |
| Drift Monitor: dead-reference scan only read a fifth of the code | Time Estimate | 2 hr | widen the scan beyond js/, recheck 279 IDs |
| Drift Monitor: Prospects 'Email Source' dropdown filling with sentences | Business | Operations Director | a field the OD prospecting agent writes to |
| Drift Monitor: Prospects 'Email Source' dropdown filling with sentences | Time Estimate | 2 hr | change field type, clear 61 junk options, fix the agent |
| Drift Monitor: two SOPs describe project status wrongly | Business | Operations Director | two OD platform SOP files need correcting |
| Drift Monitor: two SOPs describe project status wrongly | Time Estimate | 1 hr | edit two SOP files |
| `recD9FGOFtuKQ7ea3` (inbound legal correspondence) | Business | Real Estate | sibling tasks on the same thread are all Real Estate |
| `reckPoVJf9ml8YdTw` (debt-recovery decision session) | Business | Personal | every line item in that ledger is coded Personal |

## Waiting on you

3 decisions held. Say "approve the sweep" in any Claude session to apply them all, or name
the ones to drop.

**No assignee changes tonight, so approving this sends zero Slack messages.** Project links
do add that project's people to the task.

| Task | Field | Proposed | Why |
|---|---|---|---|
| `recGVmc4GFodYZGmL` get prospecting live | Project | The outbound engine runs, every day | getting prospecting live IS that project |
| `recQrDlBBmhWyX7hq` rent into payment | Project | Close the payment gap | "rent into payment" is literally that project |
| `recnmQD800r872iq0` export funnel email copy | Project | The outbound engine runs, every day | funnel copy feeds the content machine half of it |

The prospecting one has now waited three nights (since 2 Aug) and the task itself is 5 days
overdue. Its wording still tells Ericamae to agree cover with someone who left on 28 July, and
refers to a trip that has already happened. Approve it, or kill the task.

## The assignee number is wrong, and has been for a week

The sweep says 146 tasks have no assignee. I checked all 146 against Airtable. **140 already
have an owner** in the Team Member field, and every one of those owners is an AI agent:

- 48 AI Operations, 43 AI Analyst, 11 AI Writer, 11 AI Builder, 8 AI Researcher, 6 AI Auditor
- 5 AI Legal & Compliance, 4 AI Systemisation, one each for Sales, Finance, Strategy, HR

The sweep script never reads that field, so it treats agent-owned work as unassigned. Had I
filled those in, it would have fired 140 Slack messages and moved 140 agent jobs onto Kevin,
Mica and Ericamae.

Only 6 tasks have no owner at all: four Drift Monitor alerts, one E2E Sweep alert, and one
parked rollup. The five alerts are code jobs that should go to an AI agent, but the script is
not allowed to write Team Member, so I left them blank rather than put them on a person.

This is the fifth night running that this has been re-discovered. It was written to memory on
2 August. The script has not changed since 30 July.

## Left alone

- **1 business** — an inbound invoice-chasing email. It says the debt is "across all
  companies", so it genuinely is not one business. Blank is the honest answer.
- **5 ownerless monitor tasks** — need an AI agent on Team Member, which the script cannot write.
- **222 project links** — ordinary operations work that belongs to no project. Not mess.
- **312 recurring** — deliberately untouched. Writing "None" is a real value, not an empty
  box: it flips those tasks into the recurring reports that feed Mica's and Ericamae's
  performance reviews, and arms them to clone themselves. Real repeaters do exist (the weekly
  routine form, the credit card payments due on the 5th), but several already show up as
  duplicate one-off records, so setting a frequency risks creating them twice.

## CEO review

The `od-ceo` agent reviewed all 12 proposed decisions before anything was written.

**Verdict: approve 8, drop 1, hold 3.** It independently confirmed the Team Member finding and
called it the most valuable thing in the batch.

What it made me change:

- **Dropped** assigning the parked rollup ("PARKED — revisit after the first client") to Kevin.
  It is parked until after client one and due 31 December. Assigning it would have pinged him
  about work he has already decided not to do. A parked task needs no owner.
- **Reframed the invoice-chasing task.** I had it filed as a "which business is this?"
  question. It is a court threat, and it is in the wrong lane — Legal & Compliance, not Operations.
- **Caught a miscount.** I said three Drift Monitor alerts were ownerless; it is four. The extra
  one, "12 page health checks report a pass they cannot fail", is due today and is the most
  serious item in the batch: 12 checks written so they always say "pass" no matter what the
  data says. A check that cannot fail is a green light that is painted on.
- **Caught the inflated denominator** — the 22 Approval and 18 status-less records above.

It also backed leaving four low-confidence property project links alone. Those are ordinary
mortgage admin, and filing them into the recovery project would tie routine admin to a
recovery action before the legal position is confirmed.

## What would actually fix the score

1. Make the sweep read Team Member. An AI agent there is an owner. Until this ships the sweep
   is wrong by 140 tasks every night.
2. Drop recurring from the score until the five Airtable formulas get a "None" guard. 312 of
   323 gaps, where the right action is almost always to write nothing.
3. Fix the denominator: exclude "Approval", and fix the 18 tasks with no status.
4. Let the script write Team Member, so monitor alerts route to an agent instead of waiting on
   a field it cannot touch.
5. Score overdue-and-urgent first, empty fields second. Tonight the sweep produced 12 metadata
   decisions and would not have mentioned a five-figure court threat.

## Change to what this sweep commits (new tonight)

`monitoring/.gitignore` says only a **redacted** `task-sweep-{date}.md` should be tracked. My
first draft tonight broke that — it named a tenant, a supplier, and exact sums, because the
two most important findings are a court threat and an overdue rent recovery, and those are
hard to report usefully without specifics.

So I split the report. The tracked one is redacted and uses record IDs. The full version, with
names, suppliers and exact sums, stays on Kevin's Mac as `task-sweep-detail-{date}.md`, now
covered by a new ignore rule.

**No new leak.** I checked the 2 and 3 Aug reports: both are properly redacted and name no
tenant, supplier or personal sum. The redaction convention has been holding. The 30 July raw
data files are still in git history, and scrubbing that still needs Kevin's go-ahead, but
nothing was added to the problem tonight.

## Undo

python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-04.json
