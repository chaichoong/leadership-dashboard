---
name: ai-team-week-check-2026-10-22
description: One-off, 22 Oct 2026: is the AI team improving a week after the 14-15 Oct fixes? Compare, then one decision card for Kevin.
---

You are running a ONE-OFF check for Kevin Brittain on Thursday 22 Oct 2026, on the Mac mini, in the repo /Users/kevinbrittain/Projects/leadership-dashboard. Read its CLAUDE.md first. Kevin is non-technical with ADHD: write for a 13-year-old, UK English, no em dashes, lead with the answer, at most 5 bullets.

WHY THIS EXISTS: on 14-15 Oct 2026 a /fix session rebuilt how the AI estate improves itself (PRs #780 no silent parking, #782/#784/#790/#795 honest AI team view, #783 inbox cards, #787 fixer 90 min by 08:20, #788 video job stops blocking the queue, #792/#793/#794 no orphaned work, one shared task rule). Kevin agreed to change nothing else for a week and then decide from data. Brain notes: "00 AI Context/Decisions/2026-10-15 One AI team health panel answers Kevin's questions in plain words.md" and "2026-10-15 No AI agent holds work no robot picks up, every answered card has a taker.md" (Google Drive mount under ~/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/My Drive/).

BASELINE (15 Oct 2026, 19:20): Things needing a fix = 67 (19 stuck, 14 blocked too long, 4 jobs failing, 5 data checks wrong, 2 missed, plus others). Lights: Work is flowing RED, Something is broken RED, It can keep going AMBER. Code problems open 169-171 (vs 132 a week earlier). Problems found about 14 a day vs about 4 fixed a day before the change. Approval cards waiting for Kevin: 22, of which 9 blocked steps only Kevin can do. Inbox: 12 after the backlog clear (from 155). Weekly allowance: 45% used by Thursday 15 Oct.

DO (READ-ONLY except the two writes named below; never change code, never send email or messages):
1. Read the live Estate Status row Key 'ai-team-verdict' (table id = TABLES.estateStatus in js/config.js; Airtable base appnqjDpqDniH3IRl; PAT at ~/.config/od/airtable_pat via curl, never print it). From its payload take: today's "Things needing a fix", the weekly series, the three lights, the verdict, and each check's number. Also read 'ai-team-health' (defects filed7d / fixed7d, rework) and 'agent-blockers'. If any row is older than 2 hours or unreadable, say so plainly and do not guess.
2. Fixer throughput for 15-22 Oct: findings filed vs fixed per day (python3 scripts/findings.py count / list, and the defects numbers above). Note whether the fixer ran every morning (~/knowledge-os/logs/daily-ops/ reports) and how often it stopped at the 90-minute or 08:20 cap.
3. Kevin's queue: live Approval cards now and the oldest age; how many extra cards the no-silent-parking rule made this week (agent-dispatch run reports under ~/knowledge-os/logs/agent-dispatch/, look for no-card / escalate cards).
4. Inbox: messages in the inbox after the latest triage run (~/knowledge-os/logs/inbound-triage/runs.log).
5. Allowance: robot pauses this week (each job's runs.log limit lines) and, if readable, the weekly all-models percent.

DECIDE (one recommendation only):
- If fixed per day >= found per day this week AND "Things needing a fix" fell: recommend "Keep going, change nothing".
- If found > fixed: recommend adding an independent review step to the daily fixer's change before it merges (it attacks fixes that need re-fixing and slow fixing together), and size its cost: extra minutes per morning and an estimated allowance share, from this week's real fixer runtimes. If allowance ran out or came within 5% this week, say the review must replace part of the 90 minutes, not add to it.
- If the number did not fall mainly because of Kevin's own blocked steps, say that plainly and name how many.

WRITE (exactly two writes):
A. The full report to ~/knowledge-os/logs/weekly-checks/ai-team-2026-10-22.md (create the folder; private, never the repo).
B. ONE task for the AI CEO so it reaches Kevin's approval queue as a decision card: run from the repo root `python3 scripts/create-agent-task.py create --fields-json '<json>'` with fields: Task Name fldgFjGBw6bTKJFCD = "DECIDE: AI team after one week - <your recommendation in 8 words>"; Status fldx4qCw17UfrKpaN = "Today"; Due Date fld7XP8w8kbxfETV4 = "2026-10-22"; Priority fldS21RwmwOqt71LI = "High"; Description fldRGhBQViKZKtkQ6 = the answer first, then at most 5 plain bullets (number then vs now, found vs fixed per day, Kevin's queue, inbox, allowance), then the one recommendation with its cost, then the report path. Team Member flduCtmQGpOA4eWaj = the AI CEO's Team Members record id (read it live from table tblco0p2OnlLQVAX7 where Name contains "AI CEO"; never guess). Read the created task back by listing Tasks on RECORD_ID() and confirm it did not fold into another task.

Finish with a 3-line summary: the answer, the task id, the report path.