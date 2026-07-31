# Task Hygiene Sweep — 2026-07-31

## Score

Open tasks: 283. Fully compliant: 12 (4.2%). Was 4.3% yesterday.

The score did not move, and it will not move until you approve last night's pile. Everything
the sweep can fix on its own is already fixed. What is left needs one word from you.

## Read this first — a privacy problem I found and part-fixed

This repo is **public**. Last night the sweep committed its working files to it. One of them,
the work-list, holds the full text of every open task: inbound email bodies, tenant names and
rent amounts, court and enforcement letters, a restraint order reference, solicitor
correspondence, personal tax items, and at least one mobile phone number.

That should never have gone public. What I did tonight:

- Added the sweep's data files to `monitoring/.gitignore` so they are never committed again.
- Untracked last night's four data files, so they no longer sit in the public repo.
- Rewrote tonight's report to use record IDs instead of names for anything sensitive.

What I could **not** fix: git keeps history. Last night's files are still readable in the
repo's past commits by anyone who looks. Removing them properly means rewriting the repo's
history and force-pushing, which is not reversible and is not something I will do without you
saying so. **That is a decision for you.** Say the word and I will do it in a controlled way.

## Fixed tonight (no approval needed)

Four fields on three tasks. Small, because last night cleared the backlog.

| Task | Field | Value | Why |
|---|---|---|---|
| recORQDQtwvht7j0C (property servicing notice) | Business | Real Estate | Servicing job raised on one of the properties |
| recORQDQtwvht7j0C | Due Date | 2026-08-15 | **Rule-derived, not a real deadline.** No date in the letter, Not Urgent, so +15 days. If that job is gas or electrical servicing it has a legal deadline, so treat the date as a placeholder |
| recgiWC9RTXJ4JHkS (a solicitor's invoice) | Business | Personal | The only matching payment in Transactions is filed under Personal. One record, so weak evidence, but Personal is the only sensible option of the three |
| recybV5qjCptZ8gCF (Runpreneur GPT) | Business | Personal | There is no Runpreneur record in the Business table. Personal is the only correct option, not a guess |

## Waiting on you

**322 decisions are held.** Do not read 322 rows. Approve them as five classes instead. One
yes per class clears the lot:

| # | Class | Count | What you are agreeing |
|---|---|---|---|
| 1 | One-off items are not recurring | 267 | Records "does not repeat" on tasks that plainly happen once. No task is cloned. Zero side effects |
| 2 | Legal and safety certificates repeat yearly | 3 | Property Redress membership, emergency lighting, gas safety. These three **will** clone on their next due date. That is the point |
| 3 | Property, supplier and inbound admin goes to Mica | 37 | 37 Slack DMs to Mica in one burst |
| 4 | Decisions, money and client-facing work goes to you | 13 | 13 Slack DMs to you |
| 5 | Outreach messaging goes to Ericamae | 1 | The warm-lane re-engagement task. Your CEO wants this split: she owns the messaging, you own any call that books |

**Slack warning: approving classes 3, 4 and 5 fires 51 Slack DMs at once, 37 of them to Mica.**
Message her first, or approve class 3 on its own day.

Plus **1 project link**: the prospecting go-live task onto Launch & First Revenue.

To approve everything:

```bash
python3 scripts/task-hygiene-sweep.py apply --decisions monitoring/task-sweep-pending.json --tier all
```

Or say "approve the sweep" in any Claude session, and name any class you want held back.

## Left alone

**4 tasks have no business** and I will not guess:

- rec0H1P4bDRhUQFa4 and reckPoVJf9ml8YdTw — no matching records anywhere to read the answer from
- recD9FGOFtuKQ7ea3 and recGO5pvoBxY8Iy6p — a debt recovery firm with no matching payments at all

**recsv02sVimmH3rFw — switch accountants, replace MHH.** I proposed Real Estate tonight and
your CEO stopped it, correctly. All ten MHH retainers are filed under Real Estate, including
the one named "Operations Director" and the one for your personal tax return, so Real Estate
is that table's default bucket, not a real answer. The switch covers nine entities across all
three businesses. **Which business should carry it, or should it be split?** One line from you
settles it.

**5 tasks have no assignee on purpose** (four platform faults and one parked item). Your CEO
flagged a structural problem here: nobody will ever own an AI-fixable platform fault, so this
class stays permanently non-compliant and drags the score down. It needs an "AI Session" owner
option. That is a system change, not a nightly decision.

**215 tasks have no project.** They are ordinary operations and belong to none. The 11
numbered launch tasks are already linked. Three older tasks look like launch work and are worth
a link next run: recys69W6LuAtW62c, recnmQD800r872iq0, recdclE7VwVPhc7qp.

## Also worth knowing

- **All ten MHH retainers are Paused**, including an arrears repayment of £453.60. An outgoing
  accountant with unpaid fees can be slow to hand over records, and the switch is due end
  September. Not a blocker, just something to sequence.
- **rec8Q5NVspOHwimyb is your CEO's own output breaking.** The CEO Brief tab is showing the
  07:30 huddle stub as if it were the finished brief. You could read a placeholder and think it
  is real direction. Worth fixing before the next morning brief.
- **reckPoVJf9ml8YdTw cites a "Monies Owed ledger" of about £13k. No such table exists** in
  Airtable. Either the task is stale or the ledger was never built.

## CEO review

Verdict: **proceed with changes.** Three changes made before anything was written:

1. Dropped the MHH accountants business fill, with the evidence above. It caught that I had
   read who pays rather than what the task covers.
2. Kept the Runpreneur fill but replaced my reason. The cost-filing evidence was unsafe for the
   same reason as 1. The sound reason is that no Runpreneur business record exists.
3. Kept the solicitor invoice fill but labelled the evidence as a single record, and told me to
   keep that task's title and content off any shared surface. That is what led to the privacy
   finding above.

It confirmed the five held-back items were right to hold, and backed the UC verification call:
those checks are already generated per tenancy by an Airtable automation, so setting them to
Monthly would double them up.

## Undo

```bash
python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-07-31.json
```

That restores all four fields to blank. Every write carries its previous value.
