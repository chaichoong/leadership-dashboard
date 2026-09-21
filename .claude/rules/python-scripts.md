---
paths:
  - "scripts/**/*.py"
  - "tests/py-undefined-names.test.js"
  - "tests/job-queue.test.js"
---

# Python script lessons

Moved from CLAUDE.md "Known Anti-Patterns" on 21 Sep 2026, word for word. Each entry shipped, broke production and was fixed; its guard test is named in the entry.

- **A lock file rewritten in place is empty for an instant, and "unreadable" is not "abandoned"** — the job queue's heartbeat refreshed `holder.json` with `open(path, "w")`, which truncates before it writes. On 2 Sep 2026 the inbound-triage waiter, polling every two seconds, read the file in that gap, decoded nothing, judged the lock ownerless (the age gate keyed on the lock DIRECTORY's stamp, fixed at acquire time, so a 15-minute-old live lock read as 903 seconds of debris) and took it. The heartbeat then saw a foreign holder and SIGKILLed the Task Manager's 13:00 slot mid-run: no score, no report, no done line, and no alarm anywhere, because every step behaved as designed. Three rules: write shared state to a temp file and `os.replace()` it over the real one (rename is atomic, truncate-then-write is not); age-gate a "debris" verdict on the NEWEST stamp the live holder refreshes, by a margin longer than one lease; and a run that loses a lock nobody else has taken should re-take it, not die. Stop a displaced child with TERM first so its wrapper can write its own done line. Guarded by `tests/job-queue.test.js` ("holder rewrites never expose a live lock", "re-takes a lapsed lock nobody claimed")

- **A deleted constant with live uses passes every import and dies at 2am** — PR #399 (13 Sep 2026) removed `INTRO_LOCAL` from `scripts/content-engine/render.py` and left four uses inside `intro_clip()`. Python raises NameError only when that function RUNS, so the module imported, its selftest stayed green, and every long-episode render died clip by clip for two nights while the publisher held three approved episodes behind the day that could not render. Guarded by `tests/py-undefined-names.test.js`, which reads every estate script for a name it uses but never binds anywhere (back-tested: the #399 file reports `["INTRO_LOCAL"]`). Add any new production Python script to its list
