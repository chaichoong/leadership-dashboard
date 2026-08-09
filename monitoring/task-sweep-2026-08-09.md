# Task Hygiene Sweep — 2026-08-09

## Score

Open tasks: 350. Fully compliant: 8 (2.3%). It read 1.9% on 8 Aug.

That score is wrong, and it has been wrong every night since 30 July. The real
number is much higher. Read the next section before you look at the score again.

## The score has been lying, and I proved it tonight

The sweep counts a task as "nobody owns this" when the Assignee box is empty.
But your AI agents cannot be put in the Assignee box at all. They are recorded in
a different box called Team Member.

I checked all 128 tasks the sweep called unowned, straight against Airtable:

- 120 of them already have an owner. Every single one is an AI agent.
- Only 8 are genuinely unowned.

So the sweep has been reporting your entire live agent queue as abandoned work.

The same thing happens with "recurring". Most tasks happen once, so the right
answer is to leave that box empty. The sweep counted an empty box as a gap, which
alone caps the best possible score near 3%.

Someone else is already fixing this in the code as I write. I have not touched it.
The evidence above is filed as finding 20260809-task-hygiene-045 so it does not get
solved twice.

## Fixed tonight (no approval needed)

42 fields filled across 21 tasks. Nothing here sends a message to anyone.

| Task | Field | Value | Why |
|---|---|---|---|
| Warm lane: re-engage Jack Duddy | Time Estimate | 15 min | read one drafted email and approve it |
| Warm lane: re-engage Jack Duddy | Business | Operations Director | sales work, not property |
| Warm lane: re-engage Saqib Javaid | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Suyesh Sharma | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Tory Bloom | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Edson Diaz-Fuentes | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Jonathan Mottram | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Adrian Cierpikowski | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Joyce Tetteh | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Darren Wolff | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Agnese Daverio | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Reginald Flint | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Gemma Coles | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Charlie Corless | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Josephine Ann Wilson | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Andrew Bizzell | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Neil Gillan | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Luke Field | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Adesina Okuboyejo | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage James Anyanwu | Time Estimate / Business | 15 min / Operations Director | as above |
| Warm lane: re-engage Cassandra Ademola | Time Estimate / Business | 15 min / Operations Director | as above |
| E2E Sweep: 143 tasks carry a stale Completion Date (8 Aug original) | Time Estimate | 2 hr | clear 143 records, then prove the count is zero |
| E2E Sweep: 143 tasks carry a stale Completion Date (8 Aug original) | Business | Operations Director | defect in your own platform |

I checked all 22 records beforehand: every one had both boxes genuinely empty.
I checked three afterwards and the values are there.

## Waiting on you

1 decision held. Say "approve the sweep" in any Claude session to apply it.

| Task | Field | Proposed | Why |
|---|---|---|---|
| Get prospecting ready to go live before Kevin leaves next Tuesday | Project | The outbound engine runs, every day | it is that project's work |

**Zero assignee changes proposed tonight**, so no Slack messages will be sent to
anyone when you approve. That is deliberate, not an oversight: 120 of the 128 are
already owned by an agent, and filling in a person's name would have pulled agent
work back onto Mica and Ericamae and pinged them about it.

## Left alone

- **8 tasks with no owner at all.** Six are Drift Monitor and E2E Sweep findings,
  which are code jobs that should go to an AI agent through Team Member. This sweep
  cannot write that box, so putting a person there would be the wrong answer, not a
  partial one. The other two are "Apartment 9 Duckworth Building: send the Intus
  email then fix the tenancy record" and "PARKED, revisit after the first client".
- **184 tasks with no project.** They are ordinary operations: invoices, council
  tax, UC verifications, licensing, inbound post. Forcing a project link on them
  would make the board harder to read, not easier.
- **All recurring boxes.** Left empty on purpose. Writing "None" is a value, not an
  empty box, and it would push one-off jobs into Mica's and Ericamae's recurring
  performance figures and arm them to clone themselves.

## One thing worth a look tomorrow

"Get prospecting ready to go live before Kevin leaves next Tuesday" was due
30 July. It is 10 days past due, still marked Urgent, still sitting with Ericamae.
Your CEO agent raised it: that is a huddle question, not a filing question.

## CEO review

Reviewed before anything was written. Agreed with holding back the assignees, the
recurring boxes and the project links. Made me change two things:

1. I was going to fill in both E2E Sweep tasks. It checked them and they are the
   same finding raised twice, a day apart. Filling both would have booked 4 hours
   for one 2-hour job. I filled the 8 Aug original only and left the 9 Aug twin
   alone. Filed as 20260809-task-hygiene-043.
2. It called 15 minutes too generous for approving one pre-written email. It is
   right, but 15 min is the smallest option the field allows. Filed as
   20260809-task-hygiene-044.

It also warned me not to write anything off a task count that does not reconcile,
because another session is changing the scoring script right now. So instead of
trusting the count, I checked each of the 22 target records against Airtable
one by one first. All 22 were genuinely empty.

## Findings filed

- 20260809-task-hygiene-043 (high) — the E2E sweep raises the same finding again
  every day instead of updating the open task
- 20260809-task-hygiene-044 (medium) — no time estimate smaller than 15 minutes,
  so 20 one-click approvals book 5 hours of your day
- 20260809-task-hygiene-045 (medium) — the assignee gap is a scoring artefact,
  with the live proof, plus a note that a fix is already in flight

## Undo

python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-09.json
