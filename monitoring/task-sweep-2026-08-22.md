# Task Hygiene Sweep — 2026-08-22

## Score
Live tasks: 228. Fully compliant: 215 (94.3%). Was 94.3% on 20 Aug.
AI owns 118 of 228 (51.8%). People own 98. Nobody owns 12 — that is what tonight fixes.
Gaps: 12 with no owner, 3 with no business, 1 with no due date, 139 with no project (project does not count against the score).

## Fixed tonight (no approval needed)
| Task | Field | Value | Why |
|---|---|---|---|
| Drift Monitor: Client CEO Brief merged but not live | Business | Operations Director | Supabase migration and worker deploy for the platform |
| INBOUND: Important information (SSE smart meter) | Business | Real Estate | the record links 22 Newton Street, which is Real Estate |
| INBOUND: reply to Roy Lavin re Thursday 4:30 start (done) | Business | Real Estate | backfill so finished work shows against the right business |
| INBOUND: reply to Roy Lavin re Oldham Road invoice (done) | Business | Real Estate | same |
| INBOUND: reply to Roy Lavin, fuel and materials (done) | Business | Real Estate | same |

Time estimates: nothing to fix. Every task finished in the last 30 days already carries one, so the "Work Done by AI %" number is measured over 100% of the work.

## Waiting on you
12 decisions held. Say "approve the sweep" in any Claude session to apply them all, or name the ones to drop.
Only ONE of them is a person, so approving sends ONE Slack message, not twelve.

| Task | Field | Proposed | Why |
|---|---|---|---|
| E2E Sweep warning: brain feed stale, 19 prospects missing entity type | Owner | AI Worker — Builder | fixing a feed and a missing field is build work |
| Drift Monitor: CEO Brief migration not applied, worker not deployed | Owner | AI Worker — Builder | it prepares the deploy, you approve it |
| INBOUND: Urgent Update required, 1406 Oldham Road | Owner | AI Legal & Compliance | Manchester council chasing a compliance update |
| INBOUND: 18 Siddows Avenue, Clitheroe | Owner | AI Legal & Compliance | Ribble Valley council licence conditions |
| Second warm-lane touch: bring Kevin a recommendation | Owner | AI Marketing | checks replies and the prospect list, then recommends |
| Q4 review: bring back the live-build sales call | Owner | AI Sales | gathers the real call data, you make the call |
| INBOUND: SMS reply from +4477XXXXX077 | Owner | AI Operations | read it and triage it |
| Replace window hinge, second bedroom | Owner | AI Operations | book and quote it; a person only if someone must attend |
| Measure and quote carpets, both bedrooms | Owner | AI Operations | quote only, nothing ordered |
| Approve the 6 four-line test emails + 1 seed | Assignee | Kevin | only you can approve a send. This is the one Slack message |
| Mark Peters COA and rent into payment | Project | Close the payment gap | he is one of the tenancies not paying |
| Drift Monitor: CEO Brief not live | Project | Complete all modules for the web app | the CEO Brief is a client module |

## Left alone
- **PARKED — revisit after the first client.** No owner on purpose. It is parked until client one.
- **INBOUND: reply to SSE Energy Solutions.** Business left blank because the task itself still has to work out which property account 8702010539 belongs to. See the flag below.
- **INBOUND: 123 Reg renewal notice (done)** and **INBOUND: Welcome to NeighborsCU (done).** Cannot tell which business pays for the domains, and the credit union email looks like it was sent to the wrong person. Left blank rather than guessed.
- **137 of the 139 tasks with no project** are ordinary day-to-day work and belong to no project. Only 2 were linked. That is a real answer, not a miss.
- Project links proposed are only 2 of 139 because the open projects are narrow and forcing links would pull project collaborators onto unrelated tasks.

## Needs your eye (not a field the sweep can fix)
1. **An approval you gave never happened.** "INBOUND: reply to SSE Energy Solutions" was approved 16 Aug at 08:45 and was due the same day. Six days on, nothing has been sent. It is a Tier 1 money matter. The send gate refused it because the task is set up as Drafting, not Correspondence.
2. **A council email marked Not Urgent is 8 days overdue.** "Urgent Update required: 1406 Oldham Road" from Manchester City Council still sits at Not Urgent. The sweep does not touch priority.

## Still real? (6 tasks over 90 days past due — proposals only, nothing changed)
| Task | Overdue | My read | Proposal |
|---|---|---|---|
| Pay tax liability 2023/24, Ciara Brittain | 190 days | still live — a tax debt does not go away | give it a new date; it sits in your lane with the legal matter |
| DD Fire Alarms Ltd, Duckworth Buildings | 155 days | dead — this is a quote that expired on 23 Feb 2026 | close it, reason: estimate expired |
| Invoice 40859 from DD Fire Alarms | 155 days | still live | no matching payment in the accounts, so it looks unpaid |
| Invoice 40893 from DD Fire Alarms | 148 days | still live | same, and the letting agent asked for direct settlement |
| Invoice INV-0549, PPE & Sons for Roy Lavin, £168 | 155 days | still live | no matching payment found |
| Fwd: Cleaning Invoice (Naturally Neat) | 148 days | still live | no matching payment found |

How I checked: searched every transaction for "FIRE", "PPE" and "CLEAN". None of the three suppliers appears. Caveat: if Roy Lavin or the letting agent paid any of them from their own account, it would not show in your transactions.
No duplicates found. All 6 were reviewed, none skipped.

## CEO review
Reviewed before anything was written. Verdict: proceed, with four corrections, all of which I made.
1. Added Business = Real Estate to the SSE smart meter task, because the record already links 22 Newton Street. I had left it blank.
2. Dropped the due date I had proposed for that same task. It is a mass-mailer about a meter upgrade, and giving junk mail three weeks of runway creates work nobody asked for. The due-date gap therefore stays open on purpose.
3. Moved the window hinge and the carpet quote off Mica and onto AI Operations. Both are quote-and-book jobs an agent can prepare. That took the Slack messages from three down to one.
4. Corrected my reasoning on the three finished Roy Lavin tasks. Business is not an input to the AI percentage; it is a reporting backfill. The write itself was right.
It also flagged the two items under "Needs your eye" above.

## Undo
python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-22.json
