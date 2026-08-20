# Task Hygiene Sweep — 2026-08-19 (second pass, 15:32)

The first sweep ran at 12:33 today. This is a second pass over the same list.
Read `task-sweep-2026-08-19.md` first — it holds the detail. This one only covers
what changed since lunchtime.

## Score
Live tasks: 234. Fully compliant: 226 (96.6%). Was 88.9% at 12:33 this morning.
Owned by an AI agent: 119 (50.9%). Owned by a person: 108. Owned by nobody: 7.
Also left out of the score: 70 tasks waiting on your approval, 16 with no status.

The score went up because the morning pass filled 21 missing business tags. The
list count dropped from 253 to 234 because 19 tasks were finished or moved to
"waiting on approval" during the afternoon.

## Fixed this pass (no approval needed)

Five business tags. All five are WhatsApp replies to Roy Lavin that were completed
this afternoon, so tagging them changes nothing on anyone's plate. They matter
because an untagged completed task muddies the "Work Done by AI %" figure.

| Task | Value | Why |
|---|---|---|
| Roy Lavin, better system for ordering materials for David | Real Estate | maintenance labour on the portfolio |
| Roy Lavin, GBP 340 materials for 4 Abington | Real Estate | fence posts and postcrete at 4 Abington Place |
| Roy Lavin, B and Q order payment | Real Estate | property maintenance materials |
| Roy Lavin, booking David for two days | Real Estate | jobs at 4 Abington, 13 Chedburgh, 14 Wentworth |
| Roy Lavin, GBP 40 for Duckworth electric meters | Real Estate | Duckworth Building meters |

I checked all four property names against the Properties table before writing, not
against the task titles: Duckworth Building, 4 Abington Place, 13 Chedburgh Place
and 14 Wentworth Terrace all exist in `tbl6f0OkAmTC2jbuG`.

## Waiting on you

Nothing new. The 8 decisions from this morning are untouched and still waiting.
Say "approve the sweep" in any Claude session to apply them. None names a person,
so approving the lot still sends **zero Slack DMs**.

I deliberately did NOT rewrite `task-sweep-pending.json`. The sweep is told to
overwrite that file every run, and this run had nothing to put in it, so following
that instruction would have quietly deleted your approval queue. Filed as a code
fix (finding 20260819-task-hygiene-sweep-251).

## Left alone

Everything still open was already judged at 12:33 and nothing has changed:

- **7 tasks with no owner.** Three are the owner proposals already waiting on you.
  Two are the contractor jobs (window hinge, carpet quote) blocked on the missing
  Contractor field, finding 20260819-task-hygiene-233. One is "PARKED — revisit
  after the first client". One is the SSE smart meter circular the CEO said to
  close rather than schedule.
- **2 completed tasks with no business tag.** The 123 Reg renewal (the email never
  names the domain) and Welcome to NeighborsCU (a US credit union, almost certainly
  not yours). Same as this morning.
- **149 tasks with no project.** Judged not project-based. Most work is ordinary
  operations and belongs to no project.
- **Recurring is still counted as a gap on nearly every task.** Writing "None" would
  close it and would be wrong: "None" is a value, not an empty box, and it arms the
  task to clone itself. Already filed as 20260808-task-hygiene-sweep-018.

## Still real? (8 tasks over 90 days past due)

The same 8 as this morning, all reached, none acted on. Nothing changed this
afternoon. See `task-sweep-2026-08-19.md` for the verdicts. The headline stands:
five of the eight are invoice tasks that never became invoice records, so there is
no paper trail either way. That is one decision, not five.

## Keeping the AI metric honest

**Every task completed in the last 30 days carries a time estimate (100%).** Nothing
is invisible to the "Work Done by AI %" figure. Business tags on completed work are
now at 2 missing, both explained above.

## CEO review

Reviewed before anything was written. It approved all five tags and raised three
things.

- **Verify Duckworth Building against the Properties table**, not off the task title.
  Done, it is in the portfolio. Write went ahead.
- **One closed task still has an open obligation.** Roy Lavin asked for a better way
  to order materials for David. The reply was sent and the task is closed, so the
  reminder is shut and the actual job is not. It proposes a new task owned by
  Systemisation. I have not created it — creating tasks is outside what this sweep
  is allowed to do — so it needs your yes.
- **Five of today's completions are the same shape:** you personally approving small
  material spends for one contractor. GBP 40 of meters, GBP 340 at Abington, a B&Q
  order, booking David. Its call: write a spend rule once (Roy orders and logs under
  GBP 250, over GBP 250 comes to you) and the whole category stops reaching you.

## Undo
This pass (5 writes):
python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-19b.json

This morning's pass (21 writes):
python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-19a.json
