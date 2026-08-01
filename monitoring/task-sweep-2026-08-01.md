# Task Hygiene Sweep — 2026-08-01

## Score

Open tasks: 319. Fully compliant: 6 (1.9%). Was 4.2% yesterday.

The score went down because the pile got bigger, not because anything broke. You had 283 open
tasks yesterday and 319 tonight. The 36 new ones arrived with the same gaps as everything else,
and last night's pile is still waiting on your word.

**Read the next section before you approve anything. I was about to make 308 writes that would
have quietly damaged your team's performance numbers.**

## The thing I got wrong, and caught before writing it

I planned to set **Recurring = "None"** on all 308 tasks that have no recurring value. My
reasoning was that "None" means "does not repeat", so it is a free way to close the biggest gap
in one move.

That is wrong, and I checked it against your live base rather than assuming:

- **"None" is a value, not an empty box.** Your `Is Recurring` field is literally `Recurring is
  not blank`. I pulled real records: tasks set to "None" come back with `Is Recurring = 1`.
  Tasks left blank come back with `0`. So "None" makes a task count as recurring.
- Once a task counts as recurring it enters your **recurring on-time metrics**, which roll up
  into Mica's and Ericamae's performance review numbers. 308 one-off jobs would have landed in
  their review scores.
- It also changes the **30-day workload figure**. That calculation has a branch for recurring
  tasks that skips the "is it due in the next 30 days" filter, so 125 tasks with due dates
  further out would start counting against capacity today.
- Worst of it: `Recurring Next Due Date` for "None" comes back as **the due date itself**, and
  the "should this clone today?" check only tests that Recurring is not empty. So 129 tasks
  would have been sitting armed to duplicate themselves on their due date.

The only reason nothing would have cloned tonight is that the **"Recurring Tasks" automation is
switched off**. One toggle stands between that write and 129 duplicate tasks.

**So I wrote none of them.** Leaving the field blank is the correct and safe state. It already
reads properly everywhere. The "308 missing recurring" line in the score is a scoring quirk, not
real mess. See "What needs fixing at the source" at the bottom.

## Fixed tonight (no approval needed)

Three writes, on two tasks.

| Task | Field | Value | Why |
|---|---|---|---|
| rec0H1P4bDRhUQFa4 (ACH Investments, liquidation) | Business | Real Estate | The Insolvency Service letter itself says the claim follows a company investment in a Rent-to-Rent scheme. That is property. |
| recsWrVeAZafPH1NL (platform sweep warning) | Business | Operations Director | It is a check on your own platform. |
| recsWrVeAZafPH1NL | Time Estimate | 2 hr | Work out why the sweep cannot see your data, then fix a version number on two pages. |

## Waiting on you — and please do NOT approve it all at once

**162 decisions held. 158 of them set an assignee, and every assignee write sends that person a
Slack message.** Approving the lot fires 158 Slack alerts, 92 of them to Mica in one burst. That
is not a notification, it is a wall she will scroll past, and it wrecks the alert for weeks.

I have split them into batches. Say the batch name and I will apply just that one.

| Batch | What it is | Slack DMs | Command |
|---|---|---|---|
| **quiet** | 1 project link + 3 yearly renewal frequencies. No DMs at all. | 0 | `--decisions monitoring/task-sweep-pending-quiet.json` |
| **1-uc** | 25 Universal Credit rent checks → Mica | 25 | `--decisions monitoring/task-sweep-pending-1-uc.json` |
| **2-mica** | 52 more property, supplier and compliance jobs → Mica | 52 | `--decisions monitoring/task-sweep-pending-2-mica.json` |
| **3-kevin-erica** | 48 to you, 7 to Ericamae | 55 | `--decisions monitoring/task-sweep-pending-3-kevin-erica.json` |
| **4-inbound** | 26 INBOUND email tasks. **Read the warning below.** | 26 | `--decisions monitoring/task-sweep-pending-4-inbound.json` |

Run any of them with:

```bash
python3 scripts/task-hygiene-sweep.py apply --decisions monitoring/task-sweep-pending-quiet.json --tier all
```

**Start with `quiet` and `1-uc`.** The quiet batch bothers nobody. The 25 UC checks are the
safest assignment in the set: I looked at all 65 completed UC verification tasks and every single
one was Mica's.

**The warning on batch 4-inbound.** Assigning an INBOUND task also **clears its Inbound
Approval** automatically. That pushes 26 emails through your inbound comms gate as a side effect
of tidying up. I am not doing that without you saying yes to it specifically.

### Where the 158 assignments go

| Who | How many | The kind of work |
|---|---|---|
| Mica | 92 | UC rent checks, supplier invoices to prepare, certificates, licensing, tenant and neighbour issues, routine mortgage and council tax letters |
| You | 59 | Money decisions, legal and creditor matters, the Simon Collins recovery, the platform build, the offer and sales calls |
| Ericamae | 7 | LinkedIn posts, prospect sourcing and contact, video and funnel copy |

## What your CEO changed

I sent the whole set to your CEO before writing anything. It returned **STOP**, and it was right
on the big one. I checked every claim against your live base rather than taking its word.

**It was right, and I acted on it:**

1. **The Recurring "None" problem above.** Its finding, my mistake. All 308 dropped.
2. **I repeated a decision you already rejected on 31 July.** I proposed filing the two MHH
   accountant tasks under Real Estate because every MHH cost record is filed there. But those
   records include one named "Operations Director" and one for your personal tax return, both
   filed under Real Estate. That makes Real Estate the *default* in that table, not an answer.
   My own query showed me this and I read past it. **Both dropped.** The question is still open
   with you from last night.
3. **I was sending routine post to you that has always gone to Mica.** I checked the completed
   record: of 73 finished mortgage tasks, 41 were Mica's and 20 yours. Of 81 council tax tasks,
   only 4 were yours. **I moved 9 tasks from you to Mica** — five routine mortgage letters, three
   council tax arrangements, and one where the lender just wants a phone call.
4. **Three tasks it spotted that I had left blank.** One task description literally opens "Hi
   @Ericamae Atenta" (→ Ericamae). One is a Manchester council complaint about a property (→
   Mica). And the Supabase migration, which I had left blank because your 29 July note says you
   build and the 30 July note says Mica runs it — **the 30 July one is a day later, so it wins**
   (→ Mica).
5. **Yesterday's pending file was still sitting there.** If you had said "approve the sweep"
   this morning you would have applied **31 July's 322 decisions**, not tonight's. Overwritten.
6. **Three yearly renewals I had wrongly called one-offs** — property redress membership, an
   emergency lighting certificate and a gas safety certificate. Gas safety is a yearly legal
   duty. Restored to Annually, in the quiet batch.
7. **Five tasks I was going to ask you to set a frequency on by hand already had one.** Checked:
   all five were done. Dropped from the report rather than handing you five finished jobs.

**Where I did not follow it:** it recommended dropping the 26 INBOUND assignments entirely. I
have kept them, in their own batch, with the side effect spelled out. That is your call, not
mine to make by leaving them out.

**Its count was off on one thing** — it said 199 completed mortgage tasks, I measured 73. The
direction was right either way, so the 9 moves stand.

## Left alone — 20 tasks where I would have been guessing

**Cannot tell which business (6):**

- recCeYjOO4URqmOtR — Companies House reply, but it is an automatic acknowledgement and never
  names which of your companies it is about.
- recD9FGOFtuKQ7ea3 and recGO5pvoBxY8Iy6p — two BW Legal letters. Your old BW Legal tasks were
  about TNT Management, but those carry reference T9790936 and these carry X2096880. Different
  matter. Could be the personal HMRC debt instead.
- recgNHgmM19B1Nbey and recsv02sVimmH3rFw — the two MHH accountant ones, explained above.
- recnEuReyawSFxLzE — YouTube pulled a video called "Email Utility Company to Request that
  Liability is Switched to the Tenant(s)". The subject is property, but a how-to video is also
  exactly what an Operations Director SOP library holds. Needs someone to look at which channel
  it is on.
- reckPoVJf9ml8YdTw — the £13k Monies Owed ledger has no detail on the record at all.

**Cannot tell who should own it (14):** eight Some Day tasks (see below), plus recDxBEUC8wk6UIl7,
recGImsRxDQ1UYBti, recIErKEWuCCxKfwK, recNmYVMAAzfG8YSN, reclJ4oFhhbPnGPYl and recybV5qjCptZ8gCF.

**On the Some Day ones:** I proposed **zero** assignees for all eight, deliberately. Assigning a
Some Day task automatically **unticks its Some Day box** and drags it into your live list. You
parked those on purpose.

**Two housekeeping items, not assignments:**

- recNmYVMAAzfG8YSN is an **OpenRent marketing newsletter**, not a job. It should be closed.
- recrGG00unq8Pup2V and recsWrVeAZafPH1NL are the **same bug** logged two days running. Two
  tasks, one problem, two Slack DMs if both are approved. Worth closing the older one.

## Projects: 220 of 221 left unlinked, on purpose

Only one task needed a project link tonight (recGVmc4GFodYZGmL, getting prospecting live). I
checked 32 candidates against your eight open projects and 31 of them were **already linked** —
the Simon Collins work, the payment gap, the outbound engine, the delivery rehearsals, first
cash. That part of your board is in good shape.

Everything else with no project is ordinary operations: invoices, tenant issues, council post,
repairs. Those do not belong to a project and forcing a link would only make the board messier.

## What needs fixing at the source

These are the reasons the score cannot reach 100% by tidying alone. Each is a small job.

1. **Five formulas treat "None" as recurring.** `Recur Task Today?`, `Is Recurring`, the two
   recurring on-time fields and `30 Day Load (Minutes)` all need a guard for "None" — or the
   sweep should stop counting a blank Recurring as a gap at all. Right now 308 of your 319 tasks
   are marked non-compliant for a box that is correctly empty.
2. **Your AI agents cannot be given a task.** Assignee is a people-only field, and the 17 AI
   agent records have no login, so they can never hold one. About 26 of the 59 tasks I routed to
   you tonight are things an agent could do or at least draft: version bumps, a flaky test, two
   drift-monitor defects, an SSL renewal, rebuilding the Simon Collins arrears from transactions.
   There is already a separate `Team Member` link field on Tasks that **can** hold an agent. The
   sweep is not allowed to write it. Letting it would put your delegation rule into practice
   instead of quietly breaking it every night.
3. **The public repo history still holds last night's leak.** Flagged on 31 July and still true.
   Tonight's working files are all correctly ignored (I added the missing pattern for the new
   batch files), but the old ones remain readable in past commits. Cleaning that needs a history
   rewrite and your explicit go-ahead.

## Undo

```bash
python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-01.json
```
