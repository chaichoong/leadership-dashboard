# Daily Ops — the one routine

This is the source of truth for the `daily-ops` scheduled routine. The live copy
lives at `~/.claude/scheduled-tasks/daily-ops/SKILL.md`; this file is the
version-controlled original, because routine instructions outside git skip
review entirely (finding `20260807-queue-fixer-008`).

---

## Why one routine, and why it is now small

Fourteen separately-scheduled Claude routines shared one Mac. Three things went
wrong, in order:

1. **They stampeded.** The Mac sleeps; on wake every overdue routine fired at
   once. On 6 Aug 2026 ten launched between 08:07 and 08:33 and produced nine
   commits in twenty-eight minutes, overwriting each other.
2. **A queue fixed the overlap and created a new failure.** Serialising them
   worked, but a routine *suspended mid-run by the Mac sleeping* keeps holding
   the lock. On 8 Aug `drift-monitor` held it for **4 hours 54 minutes** while
   asleep. Everything behind it waited, then got skipped for lateness.
3. **So the sweeps stopped happening.** `ceo-huddle` never ran once.

A lock cannot fix a machine that sleeps, because the lock sleeps too. Folding
everything into one sequential routine removed that whole class of problem, and
it worked. Then it grew its own problem.

### What went wrong with the big routine (measured, 26 Aug 2026)

**It got slower every week.** Start-to-end marks from the queue log: 2h31 on
20 Aug, 3h25 on 21 Aug, 4h45 on 23 Aug, and **6h43 on 26 Aug** — 06:05 to 12:49.
The work that touches money and people sat at the END of that, behind sweeps.
On 25 Aug the run had to break its own written order and run phases side by side
to land the business actions before a 09:15 court hearing.

**Its main output was a backlog nothing could drain.** Over the 18 days to
26 Aug the phases filed **364 findings and closed 168**. Phase 8 fixes at most
ten a day; the sweeps produced about twenty. Net **+196**, ending at **202 open**
— 3 critical, 53 high, 36 older than a fortnight. And the drain was not even ten:
PRs #107, #110, #126 and #137 were **all still open and unmerged** while forty
findings sat closed as "fixed" citing them.

**The biggest producer was the weakest signal.** Drift accounted for 68 open
findings, more than any other source. Its own reports said what that was worth:
the SOP version metric was "red every day and carries no signal" (23 Aug), the
schema had not moved between 16 and 24 Aug, and its browser checks were skipped
*every single day* because nothing runs a browser unattended.

**Two phases were doing one job.** Phase 5 walked every open task, filled fields
and proposed owners. So does the Task Manager agent, three times a day. On 26 Aug
phase 5 held 13 decisions for Kevin while the Task Manager reported 191 stuck.

### The correction (Kevin, 26 Aug 2026)

Work moved to whichever of three places actually fits it:

| The work | Where it lives now |
|---|---|
| Judgement belonging to a **role** | That role's own **slot**, on its own clock |
| Mechanical: a diff, a query, a check | A **script**, wrapped as a launchd job |
| Reading exceptions, fixing, reporting | **This routine**, which is now four phases |

`daily-ops` stopped being the thing that does the work. It is the thing that
reads what everything else did, drains the fix queue, and sends Kevin his one
report. It should take minutes.

---

## Shape

```
06:20  drift-scan        script   schema + dead-reference diff
06:40  data-invariants   script   live Airtable invariants
06:45  ceo-agent         slot     huddle, then yesterday's memory sweep
06:50  drive-auth        script   Drive token health

07:00  daily-ops (THIS ROUTINE)
         phase 1  readiness    mark, guard, reopen stale claims
         phase 2  exceptions   read what the scripts flagged; judge only failures
         phase 3  calendar     monthly / weekly / quarterly, behind a date check
         phase 4  fix          drain findings → ONE pull request
         phase 5  report       loop health → ONE Slack DM

08:00  uc-check          slot     Mica's Universal Credit list
09:00  inbound-triage    slot  ┐  (the lock serialises these two)
09:00  task-manager      slot  ┘  board pass; field hygiene at 09:00 only
09:15  prospecting       slot     daily cold outbound
11:00  prod-sweep-weekly slot     SUNDAYS ONLY — full browser walk
13:00  inbound-triage + task-manager
17:00  inbound-triage + task-manager
```

**A slot is not a second Claude routine.** It is a wrapped shell job: launchd
calls `job-queue.py run`, so it takes the lock and it heartbeats. A slot
suspended by the Mac sleeping frees the lock in about five minutes instead of
holding it for hours. That is the entire difference, and it is why the 8 Aug
failure cannot come back through this door.

**Every slot is named twice, on purpose.** In `APPROVED_SLOTS` in
`scripts/check-routines.py`, with the date Kevin ruled it in, and in
`scripts/job-schedule.json`. The guard fails if the two disagree: a slot missing
from the register would be waved past the guard AND be invisible to the digest
that notices a job has stopped, which is silent on both surfaces at once.

**Phase 4 is still the only writer.** Every other phase, and every slot, is
read-only with respect to code and files findings instead. That rule survives
from the queue design and is the reason mornings stopped needing untangling.

---

## Adding new work — the rule

**Never create a second scheduled Claude routine.** That is what stacked up
before. But "make it a phase of daily-ops" is no longer the automatic answer
either — that is how this routine reached six hours forty-three.

Ask two questions, in this order.

**1. Does it need Claude's judgement at all?**

If it is a diff, a query, a threshold check or a file comparison, it is a
**script**: a launchd job wrapped by `job-queue.py run`, plus an entry in
`scripts/job-schedule.json`. Scripts run in seconds, they queue safely, and they
heartbeat. `drift-scan.py` replaced an hour of Claude judgement with 1.7 seconds
of arithmetic and did not lose a single real check.

Give every script a **control that fails on zero**. A `filterByFormula` with a
wrong field name returns `200 OK` and no rows, and reads as "all clear" for ever.
This codebase has shipped that twice: a UC search that matched 0 of 91 records
from April to August, and an accuracy card that measured the first 100 of 259
rows and reported the score as 66/100 when it was 64%.

**2. Whose job is it?**

If it belongs to a **role** — a thing an agent owns end to end — it becomes that
agent's **slot**, allowlisted and registered. If it belongs to nobody in
particular and genuinely needs judgement daily, it becomes a phase here.

| The work | Where it goes |
|---|---|
| Mechanical, any frequency | A **script**, wrapped as a launchd job |
| Judgement owned by a **role** | That role's **slot** (allowlist + register) |
| Judgement owned by **nobody**, daily | A **phase** of this routine |
| Judgement, **weekly / monthly / quarterly** | **Phase 3**, behind a date check |
| Needs a **specific time of day** | A **slot**. That is what slots are for. |

Whatever the answer, three things hold:

1. **One writer.** Only phase 4 changes code, through one PR Kevin reviews.
2. **Register it in `scripts/job-schedule.json`.** A job missing from that file
   is a job the morning digest cannot notice has stopped.
3. **Never delete a retired entry** — set `enabled: false`. Deleting it makes it
   invisible rather than retired.

### Never express a day of the week in a cron

`0 8 * * 1-5` reads as Mon–Fri to every human and to standard cron. Cloudflare
starts the week at Sunday = 1, so it runs **Sun–Thu**. The CEO brief lost every
Friday and gained a Sunday for a week before anyone noticed. Schedule every day,
decide the day **in the skill**, in London time, where a test can reach it. That
is why `prod-sweep-weekly` has a daily cron and a Sunday check in its own file.

### The guard

`scripts/check-routines.py` asserts that only `daily-ops` and its **approved
slots** actually RAN. It runs twice: phase 1 here, and the 11:00 morning digest —
the second one because if this routine stops running, its own self-check stops
with it.

**It reads behaviour, not config, and that is a deliberate correction.** Until
10 Aug 2026 it read the scheduler's `scheduled-tasks.json`, a file the app no
longer writes: disabling a routine and renaming its description both reported
success while the file's mtime never moved. So it cried stacking over an
already-disabled routine and reddened the pre-push gate, and would equally have
reported all clear for a routine genuinely enabled tomorrow. Config that nothing
writes cannot fail loudly. It now reads `queue-events.jsonl`, which every job
writes for itself as it runs.

**The allowlist replaced a naming convention (26 Aug 2026).** A slot used to pass
only by being named differently from its skill folder — `task-manager` the job vs
`task-manager-board` the folder. That was deliberate and documented in
`scripts/task-manager-run.sh`, but it made the verdict depend on a filename:
renaming a folder to match its job made the guard cry stacking every morning over
work Kevin had sanctioned, and a mismatch proved nothing about whether he had.
Back-tested both ways in `tests/check-routines.test.js`.

Five states **fail** rather than passing, because each would otherwise read as
"all clear" for ever: the event log missing, the window holding zero events, the
routine folder unreadable or empty, `daily-ops` leaving no mark, and the
allowlist disagreeing with the register.

**Known limit, stated rather than hidden:** this sees a job that takes the queue
lock. One edited to skip the lock would run unseen.

### The 09:30 guard — the scheduler's word is not evidence

On 15 Aug 2026 the scheduler stamped daily-ops `lastRunAt` at 06:20 and delivered
the run to **no session at all**: no transcript, no phase-1 mark, no reports.
Anything trusting `lastRunAt` saw a healthy green run. `morning-digest.py --guard`
now checks for TODAY'S phase-1 mark and DMs Kevin when it is missing, with the
recovery step in the message. It never consults `lastRunAt`, because that is an
assertion by the component being checked.

**A component's own status stamp is never proof it worked. Only a mark written by
the work itself counts.**

---

# THE ROUTINE (this section is the live SKILL.md body, verbatim)

You are Daily Ops for Operations Director, at /Users/kevinbrittain/Projects/leadership-dashboard.

You are the only scheduled Claude ROUTINE on this Mac. Role agents run beside you in their own slots (see the shape above); they are wrapped shell jobs, they take the queue lock, and they are not your business except that you report what they did.

**You are no longer the thing that does the work.** Until 26 Aug 2026 you ran nine phases and took up to six hours forty-three. Now you read what the scripts and slots did overnight, drain the fix queue, and send Kevin one report. If this run takes more than about forty minutes, something has gone wrong — say so in the report.

The version-controlled original of these instructions is docs/daily-ops-routine.md in the repo. If you change how this routine works, change it there and file a finding to sync it.

## Rules that hold for the whole run

- **Run every phase, in order, even if an earlier one failed.** Record the failure and continue.
- **Run phases 2 and 4 as subagents** using the Agent tool. Ask each to return at most ten lines: what it did, what it found, what it could not do.
- **Only phase 4 may change code**, and only through a pull request. Phases 1, 2, 3 and 5 are read-only with respect to the repo: no edits, no `git add`, no commit, no push, no branch, no PR.
- **When a phase finds something needing a code change**, it files a finding:
  `python3 scripts/findings.py add --routine <phase> --severity <level> --title "..." --where "..." --detail "..." --fix "..." --touches-code`
  The queue now dedupes: a repeat of something already open is folded in as a recurrence and returns the ORIGINAL id, so do not worry about filing a duplicate. Each routine is capped at 15 open findings; past that the add is REFUSED with the names of its own oldest three to close first, and the refused finding is kept in the overflow log rather than lost. Critical and high are never refused.
- **Keep a progress file** at `~/knowledge-os/logs/daily-ops-progress.json`: `{"date": "YYYY-MM-DD", "done": ["phase-1", ...]}`. Write it after every phase. If the file already exists for TODAY when you start, SKIP the phases listed and carry on. If it is from an earlier date, ignore and overwrite it.
- **Never say a phase passed unless you saw it pass.** A phase you skipped is reported as skipped, not as clean.
- Do NOT take the queue lock anywhere in this run. The slots and the short shell jobs use it, and holding it would block them.

## The slots that run beside you

These are role agents on their own clocks. **You never run their work**, and you
never fold one back in as a phase without Kevin's word. What you owe them is the
half no arrivals list can show: **saying when one did not run.**

| Slot | launchd label | When | Ruled in |
|---|---|---|---|
| Inbound Comms Triage | `com.kevinbrittain.inbound-triage` | 09:00 / 13:00 / 17:00 | Kevin, 24 Aug 2026 |
| Task Manager board pass | `com.kevinbrittain.task-manager` | 09:00 / 13:00 / 17:00 | Kevin, 25 Aug 2026 |
| CEO huddle + memory sweep | `com.kevinbrittain.ceo-agent` | 06:45 | Kevin, 26 Aug 2026 |
| Prospecting | `com.kevinbrittain.prospecting` | 09:15 | Kevin, 26 Aug 2026 |
| Production sweep (full walk) | `com.kevinbrittain.prod-sweep-weekly` | Sundays 11:00 | Kevin, 26 Aug 2026 |

And three script jobs, with no Claude in them at all:
`com.kevinbrittain.drift-scan` (06:20), `com.kevinbrittain.data-invariants`
(06:40), `com.kevinbrittain.drive-auth` (06:50).

Each is a WRAPPED job — launchd calls `job-queue.py run`, so it takes the lock
and heartbeats. Each is named in `APPROVED_SLOTS` in `scripts/check-routines.py`
AND in `scripts/job-schedule.json`, and the guard fails if those two disagree.

**Do not re-add any of these as a phase.** The Task Manager also absorbed the
old task-hygiene sweep on 26 Aug 2026, so its field-filling runs in the 09:00
board pass and nowhere else.

## Your reporting window is the LAST 24 HOURS

You run at 07:00. The role-agent slots run at 09:00, 13:00 and 17:00. So the day you report on is **yesterday 07:00 to today 07:00** — yesterday's three slot rounds, plus this morning's scripts and the CEO huddle. Nothing is lost; it is shifted. Say "in the last day", never "today", so the window is honest.

STUCK and NEEDS YOU are live reads of the board, so they are current regardless.

## What Kevin's Slack receives (the contract, retightened 1 Sep 2026)

Kevin set the first version of this on 21 Aug 2026 after nine automated message types buried his phone. On 1 Sep 2026 he tightened it again: the Daily Ops DM, all per-task approval cards to him, the contractor bot, his CEO DM chat, the whole Universal Credit process and every system alert are GONE. If you are about to send a Slack message that is not on this list, do not send it. Put it in your report file or file a finding.

**On a normal day, at most three messages, all morning:**

1. The 08:00 approvals digest (`approvals.js` in the contractor-bot worker). ONE DM: how many items wait for his decision, the top names, a link to the dashboard queue. Silent when nothing is waiting.
2. The 09:00 CEO brief (`money-daily-worker.js`). Owns "what to do today".
3. Task movement DMs (assigned / completed / comment) via the slack-notify worker and the Airtable task automations. These are working messages between people, not reports.

**Only when it applies:**

- Mica's approval cards, in her bot DM. Her lane only; Kevin gets no cards.
- Agent-dispatch escalation: a task taken off the agents because preparing it would mean acting for Kevin in the legal matter.
- Production DOWN, from the weekly sweep. The single surviving system alert, kept by Kevin's explicit choice on 1 Sep 2026.
- A correction to an earlier message, only when it changes what Kevin should do.

**Retired on 1 Sep 2026 (do not bring these back without his word):** the Daily Ops DM (phase 5 now writes the report file ONLY — he reads it in Claude Code), per-task approval cards to Kevin, the 09:30 guard DM, the job digest Slack post, Drive-auth DMs, the "brief was late" DM, the CEO huddle late-path DM (write the record, skip the DM), the contractor bot in full, the CEO DM chat, and the Universal Credit list and process.

**Never a separate DM from:** any slot, any script, the fixer, drift, the memory sweep. Each returns its lines to you, and you fold them into the one report file. A fault that is not urgent goes to `scripts/findings.py` and is counted in the report's BROKEN line.

**Reading level:** a 13-year-old on a phone. Banned from any message to Kevin: record IDs (`rec...`), finding numbers, PR numbers, exit codes, phase numbers, field names, script names, and the words "invariant", "control", "subagent", "dispatch", "slot". If a sentence needs one of those to make sense, it belongs in the report file.

## Phase 1 — Readiness

**First, before anything else: has today already finished?**

```
cd /Users/kevinbrittain/Projects/leadership-dashboard
python3 scripts/job-queue.py rantoday daily-ops
```

Exit 3 means today already stamped an end mark. **STOP the whole run**, post one line to Kevin saying daily-ops was asked to run twice today and the second run was refused, and do nothing else. Exit 0 means carry on.

A START mark alone does NOT block: a run the Mac killed halfway has to be resumable, and only a matching END means the day is done. (Regression origin: 19 Aug 2026 — the first run stamped end at 14:12:19Z and a second full run started at 14:22:56Z. Finding 20260819-daily-ops-252.)

**Then sweep the queue.**

```
python3 scripts/job-queue.py sweep
```

Exit 0 means nothing was wrong (no lock, or a live one). **Exit 1 means it found a lock whose lease had run out and reclaimed it — put that line in the report**, because everything queued behind that holder never ran and nobody was told.

Why it is here (9 Aug 2026, finding 20260809-drift-029): expired locks were only ever broken inside `acquire`, so a crashed holder kept the queue until the next job turned up and asked. Over a quiet weekend that is two days of a dead holder while `status` reported the queue as busy. This is one file read and needs no daemon; daily-ops is simply the thing that runs most reliably on a clock.

The Mac usually wakes into this routine, and the network and Google Drive lag behind the wake by a minute or two.

```
python3 scripts/job-queue.py ready daily-ops
```

If it reports NOT READY, wait 60 seconds and try again, up to 15 times. If it is still not ready after that, note it and continue anyway: a wrong probe must not cost the whole day's run.

Then leave proof you ran. You deliberately do not take the queue lock, so without this line there is no evidence you started, and the guard cannot tell "nothing else ran" from "nothing ran at all":

```
python3 scripts/job-queue.py mark daily-ops
```

Return any findings stranded by a dead run:

```
python3 scripts/findings.py reopen --stale
```

Then check nothing has started stacking up behind your back:

```
python3 scripts/check-routines.py
```

Exit 0 means only you and your approved slots ran. **Anything else goes at the TOP of your report to Kevin.** Do not disable it yourself: somebody added it to solve a real problem. Say which job, and say that the right answer is a script if it is mechanical, a slot if it belongs to a role, and a phase here only if it belongs to nobody.

A **MISSED SLOT RUNS** line can appear at ANY exit code, including 0: an approved slot ran fewer times than its own cron implies in the window (added 5 Sep 2026, after four role-agent slot runs vanished on 4 Sep with the Mac awake and nothing raised it). Exit 0 still means nothing is stacking; a missing run is a different problem. Put the numbers in your report as "ran N of M".

Exit 2 means the guard **could not verify**, which is not a pass. The likeliest cause is the allowlist and the register disagreeing. Report it as broken.

## Phase 2 — Exceptions

The overnight scripts have already run. **You are reading their results, not redoing their work.** Where a script exited 0, say so in one line and move on. Only where one FAILED do you apply judgement.

Run this as one subagent with the prompt: "Read the results of this morning's three script jobs and report what needs a human decision. Do NOT re-run work that passed. You are read-only with respect to code; file findings via scripts/findings.py. Do not take the queue lock. Return at most ten lines."

**1. Drift scan** — `python3 scripts/drift-scan.py --json` already ran at 06:20.
   - Exit 0: nothing that can break. Two verdicts land here. `CLEAN` means nothing moved. `ADDITIONS` means new tables or fields appeared and nothing else did — that cannot break anything, because no code already written can reference a field that did not exist until today. One line, move on; the report already names them and says which the repo references.
   - Exit 1: read `monitoring/drift-exceptions-{date}.json`. Since 28 Aug 2026 this fires ONLY for changes that can break something, so treat every one as real. A **removed** or **retyped** field that config.js maps is a live break — file it high. A renamed field is the dangerous quiet one: it keeps the same field id, so every id check in the scan passes while a name-matched `filterByFormula` silently returns zero rows, and sub-category names are load-bearing in the P&L and Wealth code.
   - Exit 2: **CANNOT VERIFY.** Do not read this as clean. Report it on the BROKEN line.

**2. Data invariants** — `scripts/check-data-invariants.py` already ran at 06:40.
   - Exit 0: say how many passed and how many skipped on an empty population.
   - Non-zero: this is the layer with teeth, and the one that would have caught both of this platform's worst incidents. Work each failure. Raise ONE task per distinct failure, deduped against open tasks, and **run the control on the dedupe query itself** — on 25 Aug a dedupe search returned a false zero because it asked for `Name` when the field is `Task Name`.
   - CONTROL_FAILED on any invariant is a broken check, not a clean population.

**3. Drive auth** — `scripts/drive-auth-check.py` already ran at 06:50. BROKEN is one of the few things allowed to DM Kevin directly.

**4. The slots' own reports.** Read what the last 24 hours of slot runs left in `~/knowledge-os/logs/<job>/runs.log` and in `monitoring/`. You are looking for one thing: **a slot that should have run and did not**, or one that ran and failed. An arrivals list cannot restore trust; absence is the signal.

## Phase 3 — Calendar work (only when due)

Check the date first and SKIP with a note when not due. A skip you announce is fine; a silent one is how a monthly job stops running for a quarter.

- **1st of the month:** `~/.claude/scheduled-tasks/monthly-rent-due-date/SKILL.md`
  Advances rent due dates for every active tenancy. This is a real obligation; if it is the 1st and this fails, say so at the very top of the report.
- **EVERY DAY — post:** run `python3 scripts/post-inbox-absence.py` from the repo. It is one directory listing and costs seconds.
  - **exit 3** — scans are sitting unprocessed in the Post Inbox root. Run `~/.claude/scheduled-tasks/post-manager-weekly/SKILL.md` NOW, whatever day it is. Only the days it finds something pay for the OCR, split and email work.
  - **exit 1 on a Monday** — nothing scanned for a fortnight. Put the printed message at the top of the report, per that skill's STEP 0.
  - **exit 1 midweek** — note it in the report and move on. Monday owns the nobody-scanned alarm; repeating it daily would train Kevin to skip it.
  - **exit 2** — say you could not tell. Never report "no post" on an exit 2.
- **Mondays:** the full `~/.claude/scheduled-tasks/post-manager-weekly/SKILL.md` pass, including its STEP 0 absence alert, even when the daily check found nothing.

  Why the check is daily (31 Aug 2026, finding 20260831-post-manager-weekly-419): the post phase was Mondays-only, so a Wednesday scan sat unread until the following Monday. Post carries 7 and 14 day clocks — a Companies House strike-off window, a charging-order reconsideration window — and losing five days of a fourteen spends more than a third of the response time before the letter is even opened. On 31 Aug 37 pages scanned on 26 Aug were still unread, including four charging-order threats.
- **1st of Jan / Apr / Jul / Oct:** `~/.claude/scheduled-tasks/update-master-prompt-quarterly/SKILL.md`
  Propose-only. It must never write to the master prompt without Kevin's yes.

## Phase 4 — Fix (the ONLY phase that writes code)

Follow `~/.claude/scheduled-tasks/queue-fixer/SKILL.md`, with these changes:

- Do NOT take the queue lock; you already hold the machine.
- **Also commit the reports** the scripts and slots left in `monitoring/`. Copy them into the worktree before committing — they are written in the main checkout and a fresh worktree cannot see them. APPEND to existing report files, never overwrite: on 7 Aug 2026 rewriting one destroyed 195 lines of earlier investigation.

**Close findings honestly.** A fix that is written but sitting in an open PR is `--outcome pending --pr <n>`, NOT `--outcome fixed`. On 26 Aug 2026 four fixer PRs (#107, #110, #126, #137) were all open and unmerged while forty findings sat closed as "fixed" citing them — the queue was reporting work as done that had never reached production. When a PR merges, `python3 scripts/findings.py land --pr <n>` turns its pending findings into fixed.

**Before you open a new PR, check the old ones.** Since 29 Aug 2026 the fixer merges its own
green work, so an open fixer PR now means one of two things and the report must say which: the
gate went RED, or it touched a protected path and is waiting for Kevin. If three or more are
open, do NOT open a fourth — that is the drain failing again, and only he can clear it.

Cap at **25** findings and one pull request, then **merge it through the gate**:

```
python3 scripts/fixer-merge.py merge --pr <n>
```

Kevin's ruling, 29 Aug 2026. He was the drain — 213 open findings against a cap of ten — and the
gate is stricter than his glance: full vitest AND browser suite, and an outright refusal on
money, auth, the approval loop, the send path, shared files and the workers. Those stay open and
go on NEEDS YOU. A red gate leaves the PR open and merges nothing.

## Phase 5 — Report

**First, run the approval-loop check.** This is the trust surface: it is the only thing in the run that reports what SHOULD have moved and did not.

```
python3 scripts/loop-health.py
```

It exits 1 rather than printing an all-clear if the read failed or no task anywhere links to an agent, so a broken query can never read as "nothing is stuck". If it exits 1, the STUCK line reads "*STUCK: could not check*" plus the reason in plain words.

Put anything under **NOT MOVING** into the report's *STUCK* block, with the count and the FIRST THREE AS PRINTED. Do not re-sort them by age: the list is already ordered by how much each item needs someone, and the "agent has drafted nothing" rule deliberately carries no day count, so an age sort buries exactly the items that mean nothing has started. Kevin asked for this on 14 Aug 2026 after losing trust in the loop: an approvals list only shows what arrived, and a completions list only shows successes, so neither can show the thing that actually went wrong.

If NOT MOVING is zero, say that explicitly — "nothing has stalled" is the sentence that earns the trust, and a silent omission reads identically to the check never having run.

**Write the full report file:** `monitoring/daily-ops-{date}.md`. Run time, one line per phase, one line per slot and script in the last 24 hours, counts, record IDs, finding numbers, PR links. Phase 4 commits it tomorrow. The file is the record.

**NO Slack DM. None.** Kevin retired the Daily Ops DM on 1 Sep 2026: he reads this in Claude Code each morning, so the DM told him nothing the file did not. Open the report with a summary block in exactly the shape the DM used, so his morning read starts the same way:

```
*Daily Ops, {weekday} {day} {month}.* {Ran fine. | N things broke.}

*NEEDS YOU*            (at most 3; leave the heading out if none)
1. {What it is, then the one action, in one sentence.}

*STUCK: N*             (or "*STUCK: nothing has stalled*", or
                        "*STUCK: could not check* — {why}" when loop-health exited 1)
• {task's plain name} — {waiting N days | nothing started}

*BROKEN: N things*     (or "*Nothing broke.*")
{Name them in plain words, one line.}

Everything else ran.   (or: "{Name} did not run: {why, plainly}.")
```

Rules for the summary block:

- NEEDS YOU is only for things Kevin himself must do: a decision, an approval, a signature, a payment, a call only he can make. **Unmerged fix PRs belong here** whenever three or more are open — that is the drain on the whole fix queue and only he can clear it.
- STUCK keeps the order loop-health printed. Strip the `rec...` IDs and field names from the summary block (they belong in the detail below it).
- **A slot that did not run is named on the "Everything else ran" line.** This is the half that cannot be seen from an arrivals list, and it is the reason phase 2 reads absence rather than successes.
- Never present a partial run as a complete one.

Finally, delete `~/knowledge-os/logs/daily-ops-progress.json` so tomorrow starts fresh.
