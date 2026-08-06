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
