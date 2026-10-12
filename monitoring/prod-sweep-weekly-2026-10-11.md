# Prod Sweep Weekly — 2026-10-11

- Day check: Sunday — ran in full.
- Production: UP (200), app shell title present.
- Mode: FULL (signed in, scripted walk), 213 seconds, transactions loaded: 9,681.
- Pages walked: 32 | PASS: 30 | WARN: 2 | FAIL: 0.
- WARN pages: 2, both sign-in gates (data not checked on those two).
- Writes blocked by the walk: 13 (Tasks 2, Costs at least 5; per-page lists are capped at 5). Writes allowed: 1 (a sign-in request, not a data write).
- Outside noise (hosts the app does not own): 1.
- Data invariants (read from today's 06:42 daily job, not re-run here): 26 PASS, 2 WAITING, 3 FAIL.
- Airtable sweep task: none raised (no page failed).
- Findings filed this run: 1 (low).
- Detail (page names, record ids) held in scratch, not here — this repo is public.
