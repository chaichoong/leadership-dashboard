---
name: uc-check
description: "RETIRED 1 Sep 2026 — do not run. Universal Credit slot — books the checks, sends Mica ONE list. 08:00 daily. Approved slot (Kevin, 26 Aug 2026)."
---

> **RETIRED 1 Sep 2026 — Kevin's ruling (Slack cleanup).** The whole Universal
> Credit check process stopped: no tasks are created, no list is sent to Mica,
> no watchdog runs. Kevin's words: even when a missing payment was caught early
> there was never enough time to resolve it before it arrived or did not, so
> missed UC now surfaces as arrears and is dealt with then. The steps below are
> history, kept so the process can be rebuilt if he ever reverses this.

# Universal Credit check — the 08:00 slot

Send Mica ONE Slack DM listing every Universal Credit check due today or already
overdue. If nothing is due, say nothing.

Follow `~/.claude/scheduled-tasks/uc-check-slack-notifier/SKILL.md` in full: it
holds the working steps, the control checks and the reason each exists. This file
only changes WHERE it runs.

## Why it moved here (26 Aug 2026)

It was phase 6.1 of `daily-ops`. On 10 Aug Kevin ruled that losing the 08:00
delivery was acceptable rather than worth a second routine, and inside the run it
landed "whenever phase 6 was reached" — about 09:50 that day. By 26 Aug the run
took until 12:49. **That ruling accepted a later time; it did not forbid an
earlier one.** As its own slot it lands at 08:00 again, which is when the UC lines
are worth ringing, and it no longer sits behind six hours of sweeps.

Mica's Slack timezone is Asia/Chongqing. This still touches a person and a real
obligation, which is why its lateness allowance in `job-schedule.json` is generous:
a list that slips to lunchtime is still worth sending.

## The rules that do not move

- **Mica only.** Kevin does not get a copy of the working list (his instruction,
  1 Aug 2026), and this job never DMs him at all. Its faults reach him as a count
  on the Daily Ops report's BROKEN line.
- **One DM per run**, never one per task. Seven due checks is one message with
  seven lines.
- **Never re-introduce a free-text search here.** From 12 Apr to 1 Aug 2026 this
  sent zero notifications while 20+ real tasks came and went, because it searched
  task NAMES for a phrase that only ever appears in the DESCRIPTION. Back-tested:
  that query matched 0 of 91 records. It ran 144 times a day, found nothing every
  time, and looked healthy throughout. All the Airtable logic lives in the two
  scripts, each with a built-in control.
- **CONTROL FAILED (exit 2) is never "nothing due".** File a finding at severity
  high with `--touches-code`, return "UC checks are blind: <why>" for the BROKEN
  line, and stop. Do not send, do not mark.
- **Mark only after Slack confirms the send.** A failed send that gets marked is a
  check silently dropped.
- Read-only with respect to code. No commits, no PRs.

## Finish

Return at most ten lines: how many were due, whether the DM went and to whom,
and anything that failed. `daily-ops` folds them into Kevin's one report.
