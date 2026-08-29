agent-dispatch 2026-08-26-131745

slot: 13:00 (continued from context split)
run-id: 20260826-131745
completed: 2026-08-26

QUEUE COUNTS
open tasks read: 66
agent-linked open: 22
changes requested: 20
new work: 2
tier-1 in worklist: 12
worklist total: 22
routing needed at start: 2 (re-routed 14 to creditor-management before dispatch)

ACTIONS
dispatched: 22
submitted OK: 22
verify: OK (22/22)
tier-1 submitted: 20
non-tier-1 submitted: 2 (recPtKZV2MTELYfPm DBS, recP5wrDDIzgjiXfi Sefton Council)
CEO review pass: 2 reviewed, both approved as-is

AGENT SCORES (from score step)
response agent: 18% within 24h (8/45, 7-day window); 111 open, 78 past 24h
creditor agent: 27/30 prepared, 20 with Kevin; fixed costs £22,654.09/mo

SKILLS COMPLETED
1. inbound-email-triage: completed (21 new messages processed, 100 stranded label-12 checked)
2. inbound-messages-sweep: completed (1 candidate, marketing SMS, skipped)
3. agent-dispatch: completed (22 tasks dispatched + submitted)

FINDING FILED
20260826-agent-dispatch-376: routing gap — 14 creditor enforcement tasks reached wrong agents
before re-route; AUTO_ROUTES keyword coverage needs expanding for council tax, HMRC penalty,
Advantis, UKSL, Orbit, Utilita, Companies House penalty

LEARNING LOGS PENDING (require user approval to edit ~/.claude/agents/)
- dept-finance.md: enforcement letters to creditors route to creditor-management, not finance
- dept-legal-compliance.md: creditor enforcement letters route to creditor-management, not legal
- dept-operations.md: creditor enforcement letters route to creditor-management, not operations
- worker-researcher.md: creditor enforcement letters route to creditor-management, not researcher

FLAGS FOR KEVIN
- rec9g6PKSy4nhdriO: Social Housing Estates confirmation statement NOT filed by Mica;
  company still Active but strike-off process underway; Kevin needs to check register today
- reckyUZWJ2MtAndar: Roy Lavin email has photo attachment agents cannot read; Kevin to open
  Gmail thread 19ef2086c1446bb2 and report what the document shows
- recP5wrDDIzgjiXfi: Sefton Council reply drafted but TO: email address missing; Kevin to
  confirm council's email from original inbound before approving
- recv9RExemsXhfOA6: Utilita Apt 5 account reference missing from draft; insert before send
- recAnfU9fEaK8hFtk / recKBrrBvzcf8J7FN: HMRC penalty references and amounts need inserting
  before drafts can be sent; appeal window is time-sensitive (30 days from notice date)
- rec6qlRKv6dXLHVo8: SSE Energy warrant threat is the most urgent — approve and send first
- rec0H1P4bDRhUQFa4: ACH Investments response is 29 days late; solicitor review recommended
  before sending (Simon Rice for criminal overlap check only; this needs insolvency solicitor)
