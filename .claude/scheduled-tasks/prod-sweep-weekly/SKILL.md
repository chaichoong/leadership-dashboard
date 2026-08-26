---
name: prod-sweep-weekly
description: "The FULL authenticated browser walk. Sundays only — the day check is HERE, never in the cron. Approved slot (Kevin, 26 Aug 2026)."
---

# Production sweep — the weekly walk

Follow `~/.claude/scheduled-tasks/prod-e2e-sweep/SKILL.md` in full, with the two
changes below.

## STEP 0 — is today Sunday?

```
TZ=Europe/London date +%A
```

Not Sunday: **stop, and say plainly that you skipped and why.** A skip you
announce is fine. A silent one is how a weekly job stops running for a quarter
without anyone noticing.

**The day check lives here, in code, never in the cron.** A Cloudflare cron cost
this platform every Friday for a week because `1-5` means Sun–Thu there and
Mon–Fri to every human reading it. The rule that came out of it applies to launchd
too: schedule every day, decide the day in the target timezone, in a place a test
can reach.

## The split, and why (26 Aug 2026)

The daily sweep walked 28 pages every morning inside a run that reached six hours
forty-three. Measured over 22–26 August, **the page walk passed clean every single
day** — 28/28, zero console errors — while **STEP 4.5, the live data invariants,
was the part that caught things**: on 26 Aug it failed with 7 open tasks past
their hard deadlines, and it is the layer that would have caught both of this
platform's worst incidents (the 8,667-transaction `Report Amount` blanking and the
split sign-flip), neither of which any fixture test could see.

So the two were separated by how much they earn:

- **The invariants run daily, as a plain script**, with no Claude in the loop:
  the `data-invariants` job runs `scripts/check-data-invariants.py` every morning.
  Each invariant carries a control that fails the run rather than passing on an
  empty population.
- **The full browser walk runs weekly, here.** It needs Kevin's signed-in Chrome
  and real judgement about what a page is showing, and neither is worth an hour
  a day to re-confirm what passed yesterday.

**Do not run STEP 4.5 again here.** It has already run today as its own job. Read
its result and say whether it passed; do not duplicate the work.

## Everything else holds

- Production DOWN is the one thing that DMs Kevin directly. Everything else goes
  in the report and, if it needs code, into `scripts/findings.py`.
- Read-only with respect to code. No commits, no PRs.
- Dedupe against open tasks before raising anything, and **run the control on the
  dedupe query itself**: on 25 Aug the first dedupe search returned a false zero
  because it asked for a field called `Name` when the real field is `Task Name`.
  Its control caught it before it could write a duplicate. Keep that control.
- Report to `monitoring/`, counts only, never page content.

## Finish

Return at most fifteen lines. If you skipped for not being Sunday, that is one
line and you are done.
