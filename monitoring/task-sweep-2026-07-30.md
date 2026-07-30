# Task Hygiene Sweep — 2026-07-30 (first run, triggered by Kevin)

## Score

279 open tasks. Every one of them was missing at least one required field when this started.

- **Fixed tonight, no approval needed: 161 fields across 123 tasks.**
- Time estimates: 82 missing → **0**
- Due dates: 13 missing → **0**
- Businesses: 72 missing → **6** (left blank on purpose, listed below)
- Waiting on Kevin: 317 decisions (50 assignees, 266 recurring values, 1 project link)

Compliance sits at 4.3% until the pending pile is approved. Approving it takes it to roughly 95%. The remainder is the 6 tasks nobody can place without asking Kevin.

## Fixed tonight

| Field | Written | How the value was chosen |
|---|---|---|
| Time Estimate | 82 | Size of the real work. Inbound email 15 to 30 min, contractor visit 1 to 4 hr, rolled-up launch task 8 hr |
| Business | 66 | Property, tenants, utilities, councils and contractors → Real Estate. Platform, funnel, client journey → Operations Director. Dental appointment and a family vehicle finance letter → Personal |
| Due Date | 13 | The task's own content first (7-day demands, leak warnings), otherwise by priority: Urgent +2 working days, Not Urgent +15 |

Two due dates deliberately broke the priority rule and were pulled forward, with the reason recorded on each: a sewage backup into a garden and an Anglian Water leak warning, both flagged Not Urgent but both costing money or risking health every day they sit.

## Waiting on you

Say **"approve the sweep"** in any Claude session. To release it in parts, name what to hold.

**50 assignees** — 36 Mica, 13 Kevin, 1 Ericamae. Approving all 50 at once fires 50 Slack DMs, 36 of them to Mica in one burst. The CEO's advice was to release these in waves, or to message Mica once and suppress the automation for the batch.

**266 recurring values** — 263 are "None", which simply records that the task does not repeat. Only 3 will actually clone: Property Redress membership, emergency lighting certificate and gas safety certificate, all annual and all legally driven.

**1 project link** — the prospecting go-live task onto Launch & First Revenue. The other 212 tasks with no project were judged to be ordinary operations that belong to none. That is a real answer, not a gap.

**One to decide separately:** "8. Warm lane: re-engage the 20 previous call bookings" is proposed for Ericamae. The CEO wants it split, she owns the messaging, you own any call that books.

## Left alone

Six tasks have no business because guessing would have been worse than leaving it:

- INBOUND: ACH Investments Ltd in Voluntary Liquidation
- INBOUND: BW Legal query resolution
- INBOUND: Our Invoice (Esme McKenzie)
- Debt recovery decision session, Monies Owed ledger (~£13k)
- Switch accountants, replace MHH
- Runpreneur GPT (Runpreneur is not one of the three active businesses)

## CEO review

Verdict: **proceed with changes.** Six changes made before anything was written:

1. E2E sweep warning — assignee dropped. A platform fault an AI session fixes, not Kevin's job.
2. Build the AI CEO org chart — assignee dropped. It is substantially built already (17 agent files exist); only the daily-brief rewire is left, so the task needs rescoping first.
3. PARKED task — assignee dropped. Assigning a parked item drops dead weight into a live queue and fires a Slack DM for nothing.
4. 6-Month Review Ericamae — recurring changed from Bi-Annually to None. A dated milestone, not a cycle.
5. SSL Certificate Renewal — recurring dropped. Managed certs auto-renew and Let's Encrypt runs 90 days, so an annual clone is either late or noise.
6. Warm lane task — flagged for a separate yes/no rather than bulk approval.

It also asked three business routings be checked. Two of those tasks had no business proposed at all, and the third was already Real Estate. No change needed.

## Undo

```
python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-07-30.json
```

That restores all 161 fields to blank. Every write carries its previous value.
