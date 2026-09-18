---
name: prospecting
description: "Prospecting slot — daily cold-outbound run. 09:15 daily. Approved slot (Kevin, 26 Aug 2026)."
---

# Prospecting — the 09:15 slot

Follow `~/.claude/scheduled-tasks/prospect-daily-run/SKILL.md` in full. This file
only changes where it runs and what it must carry forward.

## Why it moved here (26 Aug 2026)

It was phase 6.3 of `daily-ops`, at the tail of a run that reached six hours
forty-three on 26 August. It is a role agent with its own register row (status:
Built), so it gets its own slot like the Task Manager and Inbound Triage agents
before it.

09:15 is deliberate: it runs just after the 09:00 board pass, so a task it
creates is picked up by the same morning's Task Manager slot rather than waiting
until tomorrow.

## Carry these forward — measured 26 Aug 2026

- **Zero replies from 130 emails is not a deliverability problem.** The first
  whole-population measurement, via GoHighLevel's per-email status endpoint:
  **126 of 130 delivered, 52 opened (41%), 4 clicked, 0 replied, 0 booked.**
  Reputation is fine and the entity gate is fine. The ASK is what fails. Do not
  go looking for a sending problem that has been measured and ruled out.
- **Almost all 130 went out under the OLD booking-link opener.** Kevin's 21 Aug
  four-line voice change has barely been measured. **Leave it alone and let it
  run** — changing it again now destroys the only clean read you are going to get.
- **Never write "Contacted" on a send that 4xx'd.** On 26 Aug four openers were
  never delivered yet all four records said "Contacted (1:1)", and two had been
  closed as "No Response" as though the prospect ignored them. Already filed as
  `20260826-prospect-daily-run-371`. Check the send result before you write the
  status, every time.
- **The PECR entity gate is not optional.** 23 of the emailed prospects are not
  Limited Companies. Companies House gate first, email second.

## Chrome sourcing is the ONLY source — say so when it is missing (18 Sep 2026)

LinkedIn sourcing runs through `claude-in-chrome`. When those tools are not
loaded in the slot there is no other lane, so the run has found nothing and
must not look like a quiet zero. Print, as a line of its own:

```
LANE UNAVAILABLE: claude-in-chrome - Chrome sourcing tools not loaded in this slot
```

The wrapper fails the run on that line. Finding
20260918-daily-ops-phase2-excepti-544: on 17 Sep the slot said 'Chrome
sourcing: SKIPPED', found 0, synced 0, used 0 keywords and exited 0, so the
job read as green while 89 prospects sat at Ready for Review. A zero reported
with its control is fine; a zero reported as success is not.

Follow-up work that needs no Chrome (dedupe, Companies House gate, GHL sync of
already-Approved prospects) still runs — report it, and still print the line.

## The rules that do not move

- Read-only with respect to code. Findings, never commits.
- No DM to Kevin from this job. Anything he must decide reaches him through the
  Daily Ops report or the approval queue.
- Dedupe before any website or Companies House work — that is where the cost is.
- A zero result is reported as zero WITH its control, never as a quiet success.

## Finish

Return at most fifteen lines of counts and decisions: found, deduped, synced,
follow-ups, and anything needing Kevin. Never prospect content.
