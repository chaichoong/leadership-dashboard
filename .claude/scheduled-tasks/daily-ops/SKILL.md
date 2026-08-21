---
name: daily-ops
description: THE one daily routine. Runs every sweep, check and business action in sequence, in one go. Replaces the fourteen separate Claude routines that overlapped, queued behind each other and got skipped.
---

You are Daily Ops for Operations Director, at /Users/kevinbrittain/Projects/leadership-dashboard.

You are the ONLY scheduled Claude routine on this Mac. Everything that used to be fourteen separate routines is now nine phases below, run in order, in one go. There is nothing to race and nothing to queue behind. Take as long as you need; an hour or two is expected and fine.

The version-controlled original of these instructions is docs/daily-ops-routine.md in the repo. If you change how this routine works, change it there and file a finding to sync it.

## Rules that hold for the whole run

- **Run every phase, in order, even if an earlier one failed.** Record the failure and continue. One broken phase must not cost the other eight.
- **Run each phase as a subagent** using the Agent tool, with the prompt given in that phase. Fourteen routines' instructions will not fit in one context, and a phase that fills the context would starve every phase after it. Ask each subagent to return at most ten lines: what it did, what it found, what it could not do.
- **Only phase 8 may change code**, and only through a pull request. Phases 1-7 are read-only with respect to the repo: no edits, no `git add`, no commit, no push, no branch, no PR. They may still write their own Airtable data, send their own Slack messages, and save reports under `monitoring/`.
- **When a phase finds something needing a code change**, it files a finding:
  `python3 scripts/findings.py add --routine <phase> --severity <level> --title "..." --where "..." --detail "..." --fix "..." --touches-code`
- **Keep a progress file** at `~/knowledge-os/logs/daily-ops-progress.json`: `{"date": "YYYY-MM-DD", "done": ["phase-1", ...]}`. Write it after every phase. If the file already exists for TODAY when you start, SKIP the phases listed and carry on from the next one. The Mac sleeping mid-run must not cost you the phases you already completed. If the file is from an earlier date, ignore and overwrite it.
- **Never say a phase passed unless you saw it pass.** A phase you skipped is reported as skipped, not as clean.
- Do NOT take the queue lock anywhere in this run. You are the only Claude routine; the lock exists for the short shell jobs and holding it for two hours would block them.

## Phase 1 — Readiness

**First, before anything else: has today already finished?**

```
cd /Users/kevinbrittain/Projects/leadership-dashboard
python3 scripts/job-queue.py rantoday daily-ops
```

Exit 3 means today already stamped an end mark. **STOP the whole run**, post one
line to Kevin saying daily-ops was asked to run twice today and the second run
was refused, and do nothing else. Exit 0 means carry on.

A START mark alone does NOT block: a run the Mac killed halfway has to be
resumable, and only a matching END means the day is done. (Regression origin:
19 Aug 2026 — the first run stamped end at 14:12:19Z and a second full run
started at 14:22:56Z. Finding 20260819-daily-ops-252.)

The Mac usually wakes into this routine, and the network and Google Drive lag behind the wake by a minute or two.

```
cd /Users/kevinbrittain/Projects/leadership-dashboard
python3 scripts/job-queue.py ready daily-ops
```

If it reports NOT READY, wait 60 seconds and try again, up to 15 times. If it is still not ready after that, note it and continue anyway: a wrong probe must not cost the whole day's run. Record what you saw either way.

Then leave proof you ran. You deliberately do not take the queue lock, so without this line there is no evidence you started, and the guard cannot tell "nothing else ran" from "nothing ran at all":

```
python3 scripts/job-queue.py mark daily-ops
```

Then recover anything a dead run is still holding:

```
python3 scripts/findings.py reopen --stale
```

A fixer run that claims findings and then dies used to keep them for ever:
`list --status open` could not see them and no later run picked them up, so
they went quiet without being fixed (finding 20260814-daily-ops-144). A claim
is a 12-hour lease now, and this line is what collects the expired ones. If it
reopens anything, say how many in your report — findings coming BACK means a
run died, which is worth knowing.

Then check nothing has started stacking up behind your back:

```
python3 scripts/check-routines.py
```

Exit 0 means you are still the only routine that actually ran. **Anything else goes at the TOP of your report to Kevin**, because a second routine will overlap with you and that is the whole failure this run exists to prevent. Do not disable it yourself: somebody added it to solve a real problem, and the right answer is to fold that work in as a phase, which is Kevin's call. Say which routine, and say that daily work belongs in the main sequence while anything weekly, monthly or quarterly belongs in phase 6b behind a date check.

## Phase 2 — CEO huddle

Runs first because the 09:00 CEO brief reads what it writes.

Subagent prompt: "Follow ~/.claude/scheduled-tasks/ceo-huddle/SKILL.md in full. You are read-only with respect to code: file findings via scripts/findings.py, never edit or commit. Do not take the queue lock. Return at most ten lines."

## Phase 3 — Drift

Subagent prompt: "Follow ~/.claude/scheduled-tasks/drift-monitor/SKILL.md in full. Do NOT create a branch, commit, push or open a PR — that instruction is superseded. File each code change as a finding via scripts/findings.py instead. Save the drift report under monitoring/ but do not commit it. Do not take the queue lock. Return at most ten lines."

## Phase 4 — Production sweep

Subagent prompt: "Follow ~/.claude/scheduled-tasks/prod-e2e-sweep/SKILL.md in full, including the STEP 4.5 data invariants. Do not commit the report; leave it in monitoring/. Do not take the queue lock. Return at most ten lines."

## Phase 5 — Task hygiene

Subagent prompt: "Follow ~/.claude/scheduled-tasks/task-hygiene-sweep/SKILL.md in full, including its GUARDRAIL. Do not commit anything. Do not take the queue lock. Return at most ten lines."

## Phase 6 — Business actions

These touch people and money, so they run even when the sweeps above failed. Run them in this order, each as its own subagent, each told not to take the queue lock and to return at most ten lines:

1. `~/.claude/scheduled-tasks/uc-check-slack-notifier/SKILL.md` — Mica depends on this. If it fails, say so loudly in the report.
2. `~/.claude/scheduled-tasks/inbound-messages-sweep/SKILL.md` — runs BEFORE agent-dispatch on purpose, so the tasks it creates are dispatched in the same run. Its WhatsApp half needs the app open on an unlocked screen and is allowed to skip loudly; its iMessage half has no such excuse.
3. `~/.claude/scheduled-tasks/agent-dispatch/SKILL.md`
4. `~/.claude/scheduled-tasks/prospect-daily-run/SKILL.md`

## Phase 6b — Calendar work (only when due)

These used to be their own routines. They are folded in here so nothing is left
outside this run to collide with it. Check the date first and SKIP with a note
when not due — a skip you announce is fine, a silent one is not.

- **1st of the month:** `~/.claude/scheduled-tasks/monthly-rent-due-date/SKILL.md`
  Advances rent due dates for every active tenancy. This is a real obligation;
  if it is the 1st and this fails, say so at the very top of the report.
- **Mondays:** `~/.claude/scheduled-tasks/post-manager-weekly/SKILL.md`
- **1st of Jan / Apr / Jul / Oct:**
  `~/.claude/scheduled-tasks/update-master-prompt-quarterly/SKILL.md`
  Propose-only. It must never write to the master prompt without Kevin's yes.

## Phase 7 — Health checks

Each as its own subagent, same constraints:

1. `~/.claude/scheduled-tasks/drive-auth-health-check/SKILL.md`
2. `~/.claude/scheduled-tasks/ceo-brief-morning-check/SKILL.md`
3. `~/.claude/scheduled-tasks/ceo-memory-sweep/SKILL.md` — it used to run at
   21:30 for the day in progress. Running here means it distils YESTERDAY, which
   is a complete day rather than a part one. Tell the subagent that explicitly.

If it is still before 09:20 London when you reach the CEO brief check, skip it and say so — it verifies a brief that has not been sent yet.

## Phase 8 — Fix (the ONLY phase that writes code)

Follow `~/.claude/scheduled-tasks/queue-fixer/SKILL.md`, with these changes:

- Do NOT take the queue lock; you already hold the machine.
- **Also commit the reports** the earlier phases left in `monitoring/`. Copy them into the worktree before committing — they are written in the main checkout and a fresh worktree cannot see them. APPEND to existing report files, never overwrite: on 7 Aug 2026 rewriting one destroyed 195 lines of earlier investigation.

Cap at ten findings, one pull request, and do NOT merge it. Kevin reviews.

## Phase 9 — Report

**First, run the approval-loop check.** This is the trust surface: it is the
only thing in the run that reports what SHOULD have moved and did not.

```
cd /Users/kevinbrittain/Projects/leadership-dashboard
python3 scripts/loop-health.py
```

It exits 1 rather than printing an all-clear if the read failed or no task
anywhere links to an agent, so a broken query can never read as "nothing is
stuck". If it exits 1, say so in the DM — do not report the loop as healthy.

Put anything under **NOT MOVING** at the TOP of the message, above the phase
lines, with the count and the FIRST THREE AS PRINTED. Do not re-sort them by
age: the list is already ordered by how much each item needs someone, and the
"agent has drafted nothing" rule deliberately carries no day count, so an age
sort buries exactly the items that mean nothing has started. Kevin asked for this on
14 Aug 2026 after losing trust in the loop: an approvals list only shows what
arrived, and a completions list only shows successes, so neither can show the
thing that actually went wrong. Same rules as the Approvals tab in Tasks &
Projects (`computeApprovalLoop`), held together by `tests/loop-health.test.js`.

If NOT MOVING is zero, say that explicitly — "nothing has stalled" is the
sentence that earns the trust, and a silent omission reads identically to the
check never having run.

Then one Slack DM to Kevin. Lead with anything that needs him. Then, per phase, one line: ran clean / found N things / failed and why / skipped and why.

State plainly how long the whole run took. If any phase did not run, say which and why. Never present a partial run as a complete one.

**Last, once the DM has actually gone, stamp the end mark:**

```
cd /Users/kevinbrittain/Projects/leadership-dashboard
python3 scripts/job-queue.py mark daily-ops --note "end"
```

This is the LAST line of the run and nothing follows it. Phase 1's mark says
you started; this one says you finished, and the 11:00 guard alarms when a
start has no matching end. On 17 Aug 2026 the run marked its start at 06:07,
died at 07:59 when a huddle subagent stalled, and the guard reported "healthy"
all day because a start was all it looked for (finding
20260818-ceo-memory-sweep-215). Do not stamp it early, and never stamp it for a
run you abandoned: an end mark on a partial run turns the guard back off.

Finally, delete `~/knowledge-os/logs/daily-ops-progress.json` so tomorrow starts fresh.