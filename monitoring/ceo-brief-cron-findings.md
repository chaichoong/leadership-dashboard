# CEO brief cron — findings

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
| `?mode=send` manual call | **200 OK, 24s, ok:true, sent:true**, safeToActToday £[redacted — public repo] |
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

## Prior run: 2026-07-29
Cron was invoked but produced nothing, silently. Observability enabled in response.
