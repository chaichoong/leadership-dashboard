# Task Hygiene Sweep — 2026-08-23

## Score
Live tasks: 214. Fully compliant: 202 (94.4%). Was 94.3% on 22 Aug.
AI owns 102 of 214 (47.7%). People own 100. Nobody owns 12.
Gaps: 12 with no owner, 3 completed with no business, 1 with no due date, 132 with no project (project does not count against the score).

Yesterday's 12 proposals were never approved, so the same 12 tasks are still ownerless. Tonight's list is a corrected version of it, not a new one.

## Fixed tonight (no approval needed)
| Task | Field | Value | Why |
|---|---|---|---|
| INBOUND: reply to Roy Lavin (WhatsApp), completed 22 Aug | Business | Real Estate | £25 materials and £40 utilities is property maintenance |

Time estimates: nothing to fix. Every task finished in the last 30 days carries one, so "Work Done by AI %" is measured over 100% of the work.

Only one auto write tonight because the CEO review killed the other one (see below).

## Waiting on you
12 decisions held. Say "approve the sweep" in any Claude session to apply them all, or name the ones to drop.
**Three of them name a person, so approving sends three Slack messages, not twelve.**

| Task | Field | Proposed | Why |
|---|---|---|---|
| E2E Sweep warning: brain feed stale, 19 prospects missing entity type | Owner | AI Worker — Builder | fixing a feed and a missing field is build work |
| Drift Monitor: CEO Brief migration not applied, worker not deployed | Owner | AI Worker — Builder | it prepares the deploy, you approve it |
| INBOUND: Urgent Update required, 1406 Oldham Road | Owner | AI Legal & Compliance | Manchester council chasing a compliance update |
| INBOUND: 18 Siddows Avenue, Clitheroe | Owner | AI Legal & Compliance | Ribble Valley council licence conditions |
| Second warm-lane touch: bring Kevin a recommendation | Owner | AI Marketing | checks replies and the prospect list, then recommends |
| Q4 review: bring back the live-build sales call | Owner | AI Sales | gathers the real call data, you make the call |
| Approve the 6 four-line test emails + 1 seed | Assignee | Kevin | only you can approve a send (Slack message 1) |
| Replace window hinge, second bedroom | Assignee | Roy Lavin | someone has to turn up with a screwdriver (Slack message 2) |
| Measure and quote carpets, both bedrooms | Assignee | Roy Lavin | someone has to measure the rooms on site (Slack message 3) |
| [name redacted] COA and rent into payment | Project | Close the payment gap | he is one of the tenancies not paying |
| Drift Monitor: CEO Brief not live | Project | Complete all modules for the web app | the CEO Brief is a client module |
| Fix email authentication for operationsdirector.co.uk | Project | The outbound engine runs, every day | SPF and DKIM decide whether the cold emails land |

## Left alone
- **PARKED — revisit after the first client.** No owner on purpose.
- **INBOUND: Important information (SSE smart-meter blast).** No owner and no due date proposed. It is a marketing notice, and there is a far more serious SSE thread that needs you instead (see below).
- **INBOUND: SMS reply from +4477XXXXX077.** Left alone because the same conversation already has a task owned by Mica. Giving the reply side an AI owner would put two owners on one unidentified number.
- **INBOUND: 123 Reg renewal notice (done).** Business still blank, but now with evidence: I searched the whole transaction ledger for "123 REG", "123-REG" and "123REG" and got zero rows, against a control search for "ANGLIAN" that returned 4. The domain fees are not in the ledger under that name, so there is nothing to attribute from.
- **INBOUND: Welcome to NeighborsCU (done).** You already closed this on 11 Aug as spam sent to the wrong person. Leaving it blank stands.
- **129 of the 132 tasks with no project** are ordinary day-to-day work and belong to no project. Only 3 were linked. That is a real answer, not a miss.
- **Recurring: nothing proposed.** Writing "None" would arm one-off tasks to clone themselves. The real fix is a code change to five Airtable formulas, not a bulk write here.

## Needs your eye (not a field the sweep can fix)
1. **The £1,073 SSE debt is still stuck, 5 days on.** "INBOUND: reply to SSE Energy Solutions" (account 8702010539) is Urgent, due today, sitting in Approval. The balance has gone £60.75 in May, £773.45 in June, £1,073.08 now, and SSE threaten a site visit. Nothing has been sent since it was approved on 18 Aug. Yesterday's sweep flagged the same thing.
2. **Two council letters are marked Not Urgent and are overdue.** 1406 Oldham Road (Manchester, titled "Urgent Update required") is 9 days past due; 18 Siddows Avenue (Ribble Valley licence conditions) is 2 days past due. Housing enforcement runs to legal deadlines. The sweep does not touch priority.
3. **Approve SPF and DKIM before you approve the 6 test emails.** Both are on your list today. Sending test emails from a domain that is not yet authenticated burns sender reputation to measure a problem you already know about. The DNS change needs your registrar login, so it is yours; 10 minutes.
4. **Filed a finding for the inbound router** (`20260823-task-hygiene-sweep-320`): it stamps "Maintenance Ticket" on council letters and marketing emails. 10 live records are wrong. No code was changed here.

## CEO review
The `od-ceo` agent checked the set against live Airtable and told me not to apply it as written. It found four bad owner calls and I changed all four:
- Dropped the due date and the owner on the SSE smart-meter blast, and surfaced the £1,073 SSE debt thread instead.
- Dropped the AI owner on the SMS reply, because Mica already owns the same conversation.
- Moved the window hinge and the carpets off AI Operations. Its point was fair: an AI agent cannot replace a hinge, and booking it to an agent would also credit those hours to AI in the "Work Done by AI %" number. Both now go to Roy Lavin.
It also caught that my working-day date maths ignores UK bank holidays (31 Aug is one). Harmless tonight because the date was dropped, but worth fixing before this routine ever dates a compliance deadline.
It approved the Roy Lavin business backfill, all three project links, Kevin on the prospecting approval, leaving PARKED unowned, and proposing nothing on Recurring.

## Still real? (6 tasks over 90 days past due — proposals only, nothing changed)
All 6 reviewed, none skipped. All 6 are money, and all 6 already have an owner, so the sweep cannot re-route them.

| Task | Overdue | My read | Proposal |
|---|---|---|---|
| Pay tax liability 2023/24, Ciara Brittain | 191 days | still live — a tax debt does not disappear | give it a new date; it sits with the legal matter in your lane |
| DD Fire Alarms Ltd, Duckworth Buildings | 156 days | dead — this is an estimate, not an invoice | close it, reason: quote expired |
| Invoice 40859 from DD Fire Alarms | 156 days | still live | no matching payment in the ledger |
| Invoice 40893 from DD Fire Alarms | 149 days | still live | the letting agent asked for direct settlement, still no payment found |
| Invoice INV-0549, PPE & Sons for Roy Lavin, £168 | 156 days | still live | no matching payment found |
| Fwd: Cleaning Invoice (Naturally Neat) | 149 days | still live | no matching payment found |

The CEO's suggestion, which I agree with: hand all six to AI Finance in one go to establish paid or unpaid from the ledger, then close or pay. They have been reported unchanged every night for two weeks.
No duplicates found. Caveat on all six: if Roy Lavin or the letting agent paid a supplier from their own account, it would not show in your transactions.

## Undo
python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-23.json
