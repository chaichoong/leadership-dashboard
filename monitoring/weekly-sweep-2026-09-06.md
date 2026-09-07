# Weekly Prod Sweep — 2026-09-06

## Summary
- Production URL: UP (HTTP 200)
- Mode: DEGRADED (browser MCP unavailable — tab walk skipped; finding filed HIGH)
- Tabs walked: 0 | PASS: 0 WARN: 0 FAIL: 0 UNVERIFIED: 28
- Data invariants (from daily job 06:43): FAIL — 3 of 19 broken

## Data invariants
- PASS: 16
- WAITING: 1 (sop-queue-not-abandoned, no population yet)
- FAIL: 3
  - knock-back-only-parks-live-approvals: 2 violations (Deferred Until left on Completed tasks)
  - rejections-record-why: 5 violations (no Verdict Reason on post-27-Aug rejections)
  - hard-deadline-passed-still-open: 4 violations (oldest: court order 95 days overdue)

## Tasks raised
- rechXmRiqbCbDEOjz — knock-back parks completed (2 violations)
- recpcftSIXL8PjNhf — rejections no reason (5 violations)
- rec9tbFzPDia6Ww9o — hard deadlines overdue (4 violations, incl. court order 95 days)

## Findings filed
- 20260906-prod-sweep-weekly-480 (HIGH): browser MCP tools absent, tab walk could not run
