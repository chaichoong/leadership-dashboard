# Daily Ops — the one routine

This is the source of truth for the `daily-ops` scheduled routine. The live copy
lives at `~/.claude/scheduled-tasks/daily-ops/SKILL.md`; this file is the
version-controlled original, because routine instructions outside git skip
review entirely (finding `20260807-queue-fixer-008`).

---

## Why one routine

Fourteen separately-scheduled Claude routines shared one Mac. Three things went
wrong, in order:

1. **They stampeded.** The Mac sleeps; on wake every overdue routine fired at
   once. On 6 Aug 2026 ten launched between 08:07 and 08:33 and produced nine
   commits in twenty-eight minutes, overwriting each other.
2. **A queue fixed the overlap and created a new failure.** Serialising them
   worked, but a routine that is *suspended mid-run by the Mac sleeping* keeps
   holding the lock. On 8 Aug `drift-monitor` held it for **4 hours 54 minutes**
   while asleep. Everything behind it waited, then got skipped for lateness.
3. **So the sweeps stopped happening.** `ceo-huddle` never ran once. The nightly
   sweeps were skipped most days for being hours late, because the Mac is never
   awake at 02:00.

A lock cannot fix a machine that sleeps, because the lock sleeps too. One
routine, running its work in sequence, removes the whole class of problem: there
is nothing to overlap with, nothing to queue behind, and nothing to skip for
lateness. It runs when the Mac is awake, and takes as long as it takes.

## Shape

```
daily-ops (07:00, or on wake)
  └─ phase 1  readiness       wait for network + Drive
  └─ phase 2  huddle          must finish before the 09:00 CEO brief reads it
  └─ phase 3  drift           schema + code drift
  └─ phase 4  e2e             production browser sweep
  └─ phase 5  hygiene         Airtable task field rules
  └─ phase 6  business        UC checks, agent dispatch, prospecting
  └─ phase 7  health          Drive auth, CEO brief verification
  └─ phase 8  fix             drain findings → ONE pull request
  └─ phase 9  report          one Slack message
```

**Each phase runs as a subagent.** Fourteen routines' worth of instructions will
not fit in one context, and a phase that fills the context would starve every
phase after it. A subagent gets its own context, returns a short summary, and
the orchestrator keeps only the summary.

**Phases are isolated.** A phase that fails is recorded and the run continues.
One broken sweep must not cost the other eight.

**Phase 8 is the only writer.** Every other phase is read-only with respect to
code and files findings instead. That rule survives from the queue design and is
the reason mornings stopped needing untangling.

---

## Adding new work — the rule

**Never create a second scheduled Claude routine.** That is what stacked up
before, and it will stack up again. New work becomes a phase of this one.

Decide with a single question: *does the work need Claude's judgement?*

| The work | Where it goes |
|---|---|
| Needs judgement, runs **daily** | A new phase in the main sequence. Put it where its dependencies sit — anything the 09:00 CEO brief reads must land before phase 2 finishes. |
| Needs judgement, runs **weekly / monthly / quarterly / annually** | **Phase 6b**, behind a date check. Say plainly when it is due and SKIP with a note on other days. A skip you announce is fine; a silent one is how a monthly job stops running for a quarter. |
| Is a **script**, no judgement needed | A launchd job wrapped by `job-queue.py run`, plus an entry in `scripts/job-schedule.json`. These are seconds long, they queue safely, and they heartbeat so a sleeping one frees the lock in minutes. |
| Needs a **specific time of day** and judgement | Still a phase. If the time genuinely cannot move, that is a conversation with Kevin, not a second routine. A second routine reintroduces the exact failure this design removes. |

Whatever the frequency, three things hold:

1. **One writer.** Only phase 8 changes code, through one PR Kevin reviews.
   Everything else files findings.
2. **Register it in `scripts/job-schedule.json`.** A job missing from that file
   is a job the morning digest cannot notice has stopped.
3. **Never delete a retired routine's entry** — set `enabled: false`. Deleting it
   makes it invisible rather than retired.

### The guard

`scripts/check-routines.py` asserts exactly one enabled Claude routine, reading
the **scheduler's own store** rather than our config, because a routine created
through the app never touches our config. It runs twice: phase 1 of this routine,
and the 11:00 morning digest — the second one matters because if this routine
stops running, its own self-check stops with it.

A store it cannot find, or one holding zero tasks, **fails**. Those are precisely
the states that would otherwise read as "no extra routines, all clear" for ever.

---

# THE ROUTINE (this section is the live SKILL.md body, verbatim)

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

The Mac usually wakes into this routine, and the network and Google Drive lag behind the wake by a minute or two.

```
cd /Users/kevinbrittain/Projects/leadership-dashboard
python3 scripts/job-queue.py ready daily-ops
```

If it reports NOT READY, wait 60 seconds and try again, up to 15 times. If it is still not ready after that, note it and continue anyway: a wrong probe must not cost the whole day's run. Record what you saw either way.


Then check nothing has started stacking up behind your back:

```
python3 scripts/check-routines.py
```

Exit 0 means you are still the only enabled routine. **Anything else goes at the TOP of your report to Kevin**, because a second routine will overlap with you and that is the whole failure this run exists to prevent. Do not disable it yourself: somebody added it to solve a real problem, and the right answer is to fold that work in as a phase, which is Kevin's call. Say which routine, and say that daily work belongs in the main sequence while anything weekly, monthly or quarterly belongs in phase 6b behind a date check.

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
2. `~/.claude/scheduled-tasks/agent-dispatch/SKILL.md`
3. `~/.claude/scheduled-tasks/prospect-daily-run/SKILL.md`

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

One Slack DM to Kevin. Lead with anything that needs him. Then, per phase, one line: ran clean / found N things / failed and why / skipped and why.

State plainly how long the whole run took. If any phase did not run, say which and why. Never present a partial run as a complete one.

Finally, delete `~/knowledge-os/logs/daily-ops-progress.json` so tomorrow starts fresh.
