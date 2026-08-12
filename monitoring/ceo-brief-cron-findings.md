# CEO brief — why 31 Jul 2026 did not arrive at 09:00

Checked by the `ceo-brief-morning-check` scheduled task at 10:55 London.

## What Kevin saw

At 09:00 he got the short money-only message, not the CEO brief. That is the worker's
fallback path (`sendDailyDM`, line ~587): when the CEO layer throws, it sends the proven
money DM and fires `alertFailure`. So it did not fail silently, but the brief was missing.

## Two bugs, found and fixed

### 1. The brief was cut off mid-sentence (the reason it failed today)

`callCeo` asked for at most 1,500 tokens. The model wrote past that and the JSON never
closed, so `text.match(/\{[\s\S]*\}/)` found nothing and threw:

```
CEO returned no JSON (stop=max_tokens, 4869 chars): ...censing: Mica to research and report back",
```

Reproduced live at 10:56 via `?mode=brief` — same error, same cause. Not a cron problem.

This is the SECOND time the same ceiling has bitten: 900 truncated it on 29 Jul once
`handed_off` was added, and 1,500 was raised then as "headroom". A ceiling alone was never
the fix, because nothing capped how much the model wrote.

Fixed three ways:
- Prompt now states a hard length limit (max 4 ignore, 5 handed_off, 2 flags, one line each)
  and says why: a long answer gets cut off and Kevin sees nothing.
- `max_tokens` 1,500 → 3,000.
- A truncated or unparseable reply is retried ONCE with a "you were cut off, answer shorter"
  instruction. A proxy error is not retried, because it fails the same way twice.

### 2. The 07:30 huddle was being thrown away every single day (the bigger one)

`gatherHuddle` fetched today's record WITHOUT `returnFieldsByFieldId=true`, then read every
value by field ID. Airtable keys that response by field NAME, so every `getField` returned
undefined and the function returned `null` on every run. Verified against the live API:

```
keys: ['Board Flags', 'Date', 'First Step', 'One Thing']
lookup by field ID fldQDCAcd74Bb6mpY -> None
```

This is the documented anti-pattern in CLAUDE.md ("returnFieldsByFieldId returning IDs not
names"), hit from the other direction.

Two consequences, both live since the huddle handover shipped on 30 Jul:
- The eleven department heads met at 07:30, and the CEO never saw their conclusion. It
  re-decided the day alone — exactly what commit 5d33d4e set out to prevent.
- With no `recordId`, `storeBrief` took the POST branch instead of PATCH, so a successful
  run wrote a SECOND record for the day instead of filling in the 07:30 stub.

Fixed: added `returnFieldsByFieldId=true`, and the lookup now takes the first row for today
that is still missing `Full Brief`, so a stray duplicate cannot make it create a third.

Verified after deploy: the brief now leads with the huddle's ONE THING (the payment path and
the info@ inbox) and carries the Cunningham and Wickman flags through.

## What was done to today's data

- Today's brief was generated and DM'd manually at 11:10 via `?mode=send`. Kevin has it.
- That run created record `recwW8ZNPB5NHU0pP` (complete) alongside the 07:30 stub
  `recqGluSOjxClVeNB` (empty) — bug 2 above, still deployed at that moment.
- The stub was then PATCHed with the identical content, so both rows for 31 Jul are complete
  and the CEO Brief tab shows a finished brief whichever row it reads first.
- The spare row `recwW8ZNPB5NHU0pP` was deleted on Kevin's instruction, after confirming all
  11 fields were byte-identical to the row that survives (`recqGluSOjxClVeNB`). One row per
  date again, and `ceo-brief-complete` passes.

The huddle's own ONE THING for 31 Jul, overwritten by the patch so the tab matches the Slack
DM Kevin actually received, is preserved here:

> Make the offer payable before Monday. Check a prospect could really pay the £1,500 setup
> and £350 a month today, and that the refund inbox is read. The warm 20 waits behind it: a
> call you cannot take money on is a dead call.

## Deploys

- `74b0394d-dda5-4966-b140-4661775fa831` — token ceiling + length caps + retry
- `53a65107-65cf-4159-bc82-024b32b3e45c` — huddle lookup by field ID

## The regression check

Both bugs returned the shape of a normal morning: `gatherHuddle` returning `null` is also
what a genuinely quiet day looks like, and an empty `Full Brief` is normal until 09:00. A
fixture test cannot see either, because both live in the shape of real Airtable data. So the
check went in as a live invariant, `ceo-brief-complete` in
`scripts/check-data-invariants.py`, run by the daily `prod-e2e-sweep` at STEP 4.5:

> a past weekday has exactly ONE CEO Briefs row, and that row's `Full Brief` is populated

Only dates strictly before today are asserted on, so a sweep running before 09:00 is not a
false red, and weekends are skipped because the cron is Mon-Fri.

Back-tested read-only against the real broken state, no bad data written:
- duplicate branch fires on the two live 31 Jul rows: `('2026-07-31', 'DUPLICATE', 2)`
- empty-brief branch fires when this morning's stub is replayed in memory with `Full Brief`
  removed: `('2026-07-31', 'EMPTY FULL BRIEF', 'recqGluSOjxClVeNB')`
- control population is 3 live weekday rows, so the check is asserting something; an empty
  population reports CONTROL FAILED rather than a silent pass

Passing on live data now that the duplicate is gone, against a control of 3 weekday rows.

## The day-ahead stub — checked, and it is not a bug

`recqGluSOjxClVeNB` is dated 2026-07-31 but was created **2026-07-30T12:42Z**. Chased it
down: the `ceo-huddle` task computes `Date` as today's Europe/London date and cannot produce
a future date on its own. Its cron is `0 6 * * 1-5` and it did not fire at 13:42 on 30 Jul.

The record was seeded by hand. The `ceo-huddle` task was CREATED on the afternoon of 30 Jul
(session "Pre-launch task prioritization"), and Kevin asked for a first run right there:

> run the huddle now so tomorrow's brief has it

The 30 Jul brief had already gone out at 09:00, so that first run correctly wrote the next
weekday. The scheduled 06:31 run on 31 Jul then found a record for today and PATCHed it, per
step 4 of the skill. `createdTime` 30 Jul with 31 Jul content is exactly what that sequence
looks like. Nothing to fix.

The one real consequence is already guarded. Content written the afternoon before goes stale
overnight, and on 31 Jul the pre-written flag claimed the contract was still at old terms
after that had been disproved the same morning. Line 48 of the `ceo-huddle` SKILL.md now
tells the run to check any pre-existing One Thing, First Step or Board Flags against the
tasks before keeping them.

No future-dated row exists now — the newest is 31 Jul. Deliberately did NOT add an invariant
for future-dated rows: seeding one is a legitimate thing Kevin can ask for, so the check
would be a red light on a correct action, and the staleness risk it points at is a judgement
call the SKILL.md guard already covers.

---

# 4 Aug 2026 — check passed, and why the watchdog STAYS ON

Checked by `ceo-brief-morning-check` at 09:27 London.

## Result: the brief fired correctly

- CEO Briefs record `rec1YY1ws8s5n7IeC`, Date 2026-08-04, `Full Brief` populated (2,047 chars).
- Cloudflare `workersInvocationsAdaptive`: one invocation at `2026-08-04T08:00:00Z`
  (= 09:00 London, BST), `requests=1 errors=0`. So the cron path did the work, not a
  manual send. No message sent to Kevin — no news is good news.
- The record was CREATED at 04:15Z by the huddle stub, then PATCHed by the worker at
  08:00Z. Creation time is not evidence either way; the invocation record is.

## Do NOT disable this task yet — the 5-weekday rule is NOT met

The rule reads "unbroken run of weekday records". Taken literally the table passes
(28–31 Jul, 3–4 Aug). Taken as intended — *the cron ran correctly* for 5 weekdays — it
fails, and the literal reading is the exact trap this task was rewritten to avoid on
30 Jul. A record proves nothing about who wrote it.

Counting only runs the fixed config actually produced:

| Weekday | Record | Who really produced it |
|---|---|---|
| Fri 31 Jul | yes | **manual send by this watchdog at 10:55** — cron never fired |
| Mon 3 Aug | yes | cron, but on the OLD `1-5` config (Cloudflare Sun–Thu still covers Monday) |
| Tue 4 Aug | yes | **cron, fixed config** — first genuine one |

Worker version 23 (the weekday-gate fix) deployed `2026-08-03T09:28:49Z`, i.e. 10:28
London — an hour AFTER Monday's 08:00Z brief had already gone. So the corrected
configuration has exactly **one** verified weekday run: today.

**The decisive day is Friday 7 Aug.** Friday is the day the old `1-5` cron silently
dropped, and no Friday has yet run under the fix. Disabling now would switch the
watchdog off immediately before the only test that matters.

Earliest safe disable: after **Mon 10 Aug 2026**, giving 4/5/6/7/10 Aug — five
consecutive weekdays including a Friday, each confirmed by a Cloudflare invocation
rather than by a record existing.

## Sunday 2 Aug record — explained, not a live bug

`recNKx0obyNFTdiCl` was created 2026-08-02T08:00:26Z, a Sunday. That is the old
`1-5`-means-Sun–Thu bug, one day before the fix deployed. `isLondonSendTime()` now
blocks weekends in code. Expect no Saturday or Sunday records from 8 Aug onwards; if
one appears, the gate has regressed and `tests/ceo-brief-schedule.test.js` should have
caught it.

---

# 6 Aug 2026 — check passed (and 5 Aug backfilled)

Checked by `ceo-brief-morning-check` at 09:25 London. No message sent to Kevin.

## Result: the cron fired, both days

| Weekday | Record | `Full Brief` | Cloudflare invocation | Verdict |
|---|---|---|---|---|
| Wed 5 Aug | `reckSSGmUCcPM8MNU` | 1,955 chars | `2026-08-05T08:00:00Z` success, errors=0 | cron did the work |
| Thu 6 Aug | `recBWBf5afFNWexnV` | 2,117 chars | `2026-08-06T08:01:00Z` success, errors=0 | cron did the work |

Both are 09:00 London (BST = UTC+1). One row per date, no duplicates. The 5 Aug run left
no entry in this file, so it is recorded here from the invocation data rather than being
assumed.

The second daily invocation (`09:00:00Z` = 10:00 London) also shows on 4 and 5 Aug with
errors=0. That is the two-cron design working: the second one runs and
`isLondonSendTime()` declines to send. Today's has not fired yet at time of check.

## Still do NOT disable — Friday is tomorrow

Verified weekday runs under the fixed config (worker v23, deployed 2026-08-03T09:28:49Z):
**4, 5, 6 Aug — three.** The 30 Jul rule needs five, and the one that matters,
**Friday 7 Aug**, has not happened. Friday is the exact day the old `1-5` cron silently
dropped. Earliest safe disable is unchanged: after **Mon 10 Aug 2026** (4/5/6/7/10 Aug),
each confirmed by an invocation, not by a record existing.

## Query that produced the evidence

`workersInvocationsAdaptive` rejects a bare `datetime` field. The working shape:

```
dimensions { datetimeMinute scriptName status } sum { requests errors }
orderBy: [datetimeMinute_ASC]
```

---

# 7 Aug 2026 — the brief did NOT fire

## Run: 2026-08-07 (Friday), checked 09:12 London

**Verdict: the 09:00 brief did NOT fire. Sent manually. Generation is healthy; the trigger is not.**

### What was observed

| Check | Result |
|---|---|
| CEO Briefs record for 2026-08-07 at 09:12 London | **Absent.** Newest was 2026-08-06 |
| `ceo-huddle` (creates the 07:30 stub record) | **Skipped as stale** at 08:01:53Z, 302 min late, limit 180 |
| Registered cron triggers on deployed worker | `0 8 * * *`, `0 9 * * *` — correct, no day-of-week field, created 2026-08-03T09:29Z |
| `isLondonSendTime()` for today | Correct: Friday, weekday, 08:00 UTC = 09:00 BST → gate passes |
| `?mode=brief` manual call | **200 OK, 22s, ok:true.** Full brief generated, money light green, calendar connected, task counts read (327 open / 168 overdue / 43 due today / 69 Kevin's) |
| `?mode=send` manual call | **200 OK, 24s, ok:true, sent:true**, safeToActToday £9,861.38 |
| CEO Briefs record after manual send | **Created: `receQ13VvkzCst5bQ`**, `Full Brief` populated, 2,294 chars |
| Slack DM to Kevin | Sent (brief itself via worker, plus one plain-English heads-up) |

### Invocation history (workersInvocationsAdaptive, 25 Jul – 7 Aug)

```
2026-07-31 Fri  09:55, 09:59, 10:03          <-- NO 08:00 run (pre-fix day-of-week bug)
2026-08-01 Sat  (none)                        correct
2026-08-02 Sun  08:00, 09:00                  fired, gate correctly suppressed
2026-08-03 Mon  08:00, 09:00, 09:29
2026-08-04 Tue  08:00, 09:00
2026-08-05 Wed  08:00, 09:00
2026-08-06 Thu  08:01, 09:01
2026-08-07 Fri  (no cron run)                 <-- TODAY. First Friday since the 3 Aug fix.
```

Today is the first Friday since the day-of-week cron fix was deployed on 3 Aug. The Friday
coincidence is worth noting but is almost certainly *not* causal: the cron is now `0 8 * * *`
with no day-of-week field, so no Friday-specific path exists in either the cron or the gate.

### Honest limit on the evidence

`workersInvocationsAdaptive` is **sampled and eventually consistent**, and it under-reports.
My own manual `mode=brief` call appeared as an `08:14` row in one query and had vanished from
the identical query three minutes later. So "zero invocations today" is strong evidence that
the cron did not fire — but it is **not proof**. Two hypotheses remain open:

- **A. The cron never fired.** Cloudflare does not guarantee cron punctuality or delivery.
- **B. The cron fired late and the gate discarded it.** `isLondonSendTime()` requires
  `hour === 9 && minute <= 10`. A cron delayed more than 10 minutes is silently dropped,
  returns early, and writes nothing anywhere.

**Both hypotheses have the same fix**, so this does not need to be resolved before acting.

Workers Logs (observability) — enabled on 29 Jul precisely to settle this kind of question —
could **not** be queried: `POST /workers/observability/telemetry/query` returns `success:false`
with a null error body using the Workers-scoped token at `~/.config/od/cloudflare_token`. The
diagnostic tool added for this failure mode is unreachable from automation.

### Root-cause assessment

The brief has **no redundancy and no self-healing**. Exactly one of the two crons can pass the
gate on any given day (BST: the 08:00 UTC one; GMT: the 09:00 UTC one). The other is always
rejected by design. So a single missed or >10-minutes-late cron means **no brief at all**, and
nothing raises an alarm — the worker's `alertFailure` only fires on a thrown error, and an
early `return` from the gate throws nothing.

The trigger is time-shaped when it should be **state-shaped**: the question that matters is
not "is it 09:00 now?" but "does today's brief exist yet?".

### Recommended fix (filed to the queue; NOT applied — this routine is read-only on code)

1. Make the scheduled handler idempotent and self-healing: on every cron firing between 09:00
   and, say, 11:00 London on a weekday, read the CEO Briefs table for today. Send only if
   today's record has no `Full Brief`. That makes a late cron harmless and a missed one
   recoverable by the next firing, instead of discarded.
2. Widen the crons to hourly across the London morning (e.g. `0 8-10 * * *`) so there are
   several chances to catch up, with idempotency doing the deduplication.
3. Keep this morning-check routine as the backstop. It worked today — it is the only reason
   the failure was caught at all.

### Do NOT disable this routine

The SKILL.md says to disable after 5 consecutive clean weekdays. The run is **broken today**,
so the counter resets. Current weekday record since the 3 Aug fix: 3, 4, 5, 6 Aug clean;
7 Aug failed. Keep running.

---

# 10 Aug 2026 — check passed, and the retry fix is confirmed live

## Run: 2026-08-10 (Monday), checked 09:54 London

**Verdict: the 09:00 brief fired on the cron. Nothing sent to Kevin. No news is good news.**

| Check | Result |
|---|---|
| CEO Briefs record for 2026-08-10 | `rec8Yxal8aA9X6qIq`, `Full Brief` populated, **1,971 chars** |
| Cloudflare invocation | `2026-08-10T08:00:00Z` = 09:00 London BST, status success, requests 1, **errors 0** |
| Manual intervention this morning | **None.** Not a backfill — the record and the invocation match |

Evidence standard held to the 6 Aug rule: verified by an invocation, not by a record existing.

## The 7 Aug retry recommendation is now DEPLOYED and working

Finding `20260807-ceo-brief-morning-check-003` asked for a state-shaped trigger and a wider
cron window. Both are live in `scripts/slack-automation/money-daily-worker.js`:

- `isLondonSendTime()` (line 672) now returns `isWeekday && hour >= 9 && hour <= 11` — a
  three-hour window instead of the old `hour === 9 && minute <= 10` knife-edge that hypothesis
  B on 7 Aug turned on.
- `alreadyBriefedToday()` (line ~714, inside `ctx.waitUntil`) reads today's row and treats a
  populated `Full Brief` as "sent", so the extra firings deduplicate instead of triple-sending.
  It fails OPEN on an Airtable read error, which is the correct direction and is documented in
  the source comment. Do not flip it.
- Crons are now hourly across the window. Invocations confirm 08:00, 09:00, 10:00 and 11:00 UTC
  on 8, 9 and 10 Aug.

Finding closed as `fixed` on 10 Aug 2026.

## Invocation history (workersInvocationsAdaptive, 8–10 Aug)

```
2026-08-08 Sat  08:00, 09:00, 10:00, 11:00   all success, errors=0, correctly sent nothing
2026-08-09 Sun  08:00, 09:00, 10:00, 11:00   all success, errors=0, correctly sent nothing
2026-08-10 Mon  08:00                        success, errors=0  <-- TODAY, the brief
```

The weekend rows are the useful part: four firings a day, zero briefs, zero errors. That is
`isLondonSendTime()`'s weekday gate doing its job under the widened window. Compare 2 Aug,
when a Sunday firing produced a real brief under the old `1-5` day-of-week cron bug.

## New issue found: this check has no weekend guard

`rece4zSbOj9cA48m4` dated Sunday 9 Aug exists with One Thing, First Step and Board Flags and
an **empty `Full Brief`** — a `ceo-huddle` stub. The worker was right not to fill it.

But this skill's only test is "is `Full Brief` populated on today's record?", with no
day-of-week condition anywhere in steps 1–4. `daily-ops` runs every day. On a Saturday or
Sunday this phase would read that empty field, conclude at step 3 that the brief did not fire,
and at step 4 fire `mode=send` and DM Kevin that his brief was late — sending a weekday brief
on a day the system is designed to be silent.

It did **not** happen on 9 Aug: that row is still empty and no manual send occurred. So this is
a latent path, not an incident. Filed as `20260810-ceo-brief-check-064` (low).

## Disable rule: still NOT met, and now moot anyway

The 30 Jul rule needs five consecutive clean weekday **cron** runs. 7 Aug failed and was sent
by hand, which reset the counter. Since then: 10 Aug is **one**. Earliest possible disable is
after Fri 14 Aug.

Moot regardless — since 8 Aug this is phase 7.2 of `daily-ops`, not a standalone routine, and
its own frontmatter says do not re-enable it separately. There is no separate schedule left to
disable. The frontmatter was left unedited: this run is read-only on files outside `monitoring/`.

## Run: 2026-08-12 (Wednesday), checked 09:21 London

**Verdict: the brief did NOT arrive, and for the first time the cause is not the cron.**
The cron fired on time and the worker ran clean. The AI call behind it is out of credit.

Evidence, in order:

- CEO Briefs `recSNmV9t789MokgE` dated 2026-08-12 exists (created 05:10 UTC by `ceo-huddle`)
  with One Thing, First Step and Board Flags, and `Full Brief` **empty** (length 0). By the
  30 Jul rule that means the 09:00 brief did not complete.
- `workersInvocationsAdaptive` for `money-confidence-daily`: one invocation at
  **2026-08-12T08:00:00Z** (09:00 London), `status: success`, 0 errors. Yesterday's four
  firings (08:00–11:00Z on 11 Aug) all succeeded too and 11 Aug has a 1,930-char `Full Brief`.
  So the schedule, the London gate and the deploy are all fine.
- Workers Logs for that invocation: `outcome: ok`, `eventType: cron`, `wallTimeMs 9162`,
  `cpuTimeMs 24`. Nine seconds is the CEO path being attempted and failing, not the gate
  returning early.
- `GET /?mode=brief` reproduced it on demand:
  `CEO proxy error 400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropi…` (truncated at 100 chars by the worker).
- Slack DM `D0B08L64Y3E` at 09:00:46 London carries exactly what the code says that path
  sends: the money-only fallback (`Safe to act today: £8,904.19`, GREEN) plus the
  `could not compute today's figure` warning with the same 400 in it.

So `sendDailyDM` behaved as designed — `callCeo` threw, the money DM went out as fallback,
`alertFailure` warned Kevin, nothing was stored. The failure is **upstream of this repo**:
the Anthropic account behind the `claude-proxy` service binding has no credit.

**Not fixable by this routine.** `mode=send` was deliberately NOT run: it would call the same
proxy, fail the same way, and post Kevin a second money-only DM plus a second warning. Topping
up credit is a payment action and Kevin's alone.

**Inference, stated as inference:** every other worker AI call routed through `claude-proxy`
(approvals judgement, agent dispatch, recon assists) shares that key and will be failing the
same way until it is topped up. Not separately verified in this run.

Filed as a finding for the queue. Kevin DM'd once, in plain English, with the one action.

**Disable rule:** still not met. 10 Aug clean, 11 Aug clean, 12 Aug failed — counter reset to
zero. Moot anyway; this is phase 7.2 of `daily-ops` with no schedule of its own.
