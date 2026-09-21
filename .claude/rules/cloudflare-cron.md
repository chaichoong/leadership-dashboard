---
paths:
  - "**/wrangler*.toml"
  - "workers/**/*.js"
  - "scripts/slack-automation/*.js"
  - "cloudflare-worker/**/*"
---

# Cloudflare cron lesson

Moved from CLAUDE.md "Known Anti-Patterns" on 21 Sep 2026, word for word. Each entry shipped, broke production and was fixed; its guard test is named in the entry.

- **Never express the day of the week in a Cloudflare cron** — `"0 8 * * 1-5"` reads as Mon–Fri to every human and to standard cron, where Sunday is 0. Cloudflare starts the week at **Sunday = 1**, so `1-5` runs **Sun–Thu**. The CEO brief lost every Friday and gained a Sunday for a week before anyone noticed, because a brief still arrived most mornings and no error was ever raised. Measured via `workersInvocationsAdaptive` for 27 Jul – 3 Aug 2026: zero invocations Sat 1 Aug, a full pair Sun 2 Aug, no 08:00 firing Fri 31 Jul. Set the cron to `* * *` (every day) and decide the day **in the worker**, in the target timezone, with a test. See `isLondonSendTime()` in `scripts/slack-automation/money-daily-worker.js` and `tests/ceo-brief-schedule.test.js`, which also fails if a day-of-week filter reappears in the cron. Applies to the hour too: a scheduled job that must land at a UK local time needs two UTC crons plus a code gate, never one cron and an assumption about BST
