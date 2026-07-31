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
- **Left for Kevin:** there are two rows dated 2026-07-31 in the CEO Briefs table. Delete
  `recwW8ZNPB5NHU0pP` when convenient. Nothing is lost — the other row is identical.

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

**Note:** the duplicate row above is still there, so this invariant WILL go red on tomorrow's
sweep until `recwW8ZNPB5NHU0pP` is deleted. That is the check doing its job, not a fault.
