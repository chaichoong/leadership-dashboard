# From 11 staff to 0: every number on the page and where it came from

Read on 5 September 2026. Rebuild the page from this sheet when any figure changes.

## Headline numbers

| Figure on the page | Value | Source | How it was read |
|---|---|---|---|
| 17 AI agents | 17 | AI Agents register, Airtable `tbl9msVjyQWslLOIZ` | Rows with Status `Live` (13) or `Built` (4). Excludes `Building` (Cash Flow Voids), `Planned` (3) and `Retired` (5). Kevin's ruling 5 Sep 2026: count Live plus Built, including Content Engine and Prospecting |
| 11 people's jobs | 11 | Mapping table below | Each agent mapped to the ONS occupation whose job description it does. Agents doing parts of one job share one role |
| 11 staff (then) | 11 | Kevin, 5 Sep 2026 | Kevin's ruling on the second pass: the headline reads "11 staff to 0" so the before count matches the 11 roles the agents now do. His peak headcount was about 12; not recorded anywhere in the brain or Team Members table |
| 0 staff (now) | 0 | Kevin, 5 Sep 2026 | Kevin's ruling (second pass): 0 is the direction of travel and stands. Roy is a business partner, not staff. Mica and Ericamae are contractors the business is moving away from |
| £401,347 a year | £401,347 | Sum of the 11 ONS medians below | Salaries only, before employer National Insurance and pension. With NI at 15% above £5,000 and 3% pension the all-in figure is about £465,000 |
| £2,400 a year in AI fees | £2,400 | Kevin, 5 Sep 2026 + Transactions table | Kevin (second pass): upgraded to Claude Max 20x at £180/month plus top-ups, which matches the two £90 charges on 24 Aug. Printed as £200/month, rounded up. Bank feed (`tbln0gzhCAorFc3zB`, `*Name` contains ANTHROPIC or CLAUDE) shows £90/month subscription Mar to Aug 2026 plus top-ups of £4.45 to £24.00, and two £90 charges on 24 Aug 2026. Records: recyqyBTnsgqOwpef, rec7CFQnoPCyzyAv4, recoxiyFlIDKIDwml, recsUBOtH2bf5VHgy |
| 167 times less | 167 | Arithmetic | 401,347 / 2,400 = 167.2 |
| 296 tasks completed by agents since 1 June 2026 | 296 | Tasks `tblqB8b22hKBL4PF1` | Same counting rules as the Work Done by AI card in `js/dashboard.js` (`loadAiShareKpi`): Status Completed, Completion Date on or after 2026-06-01, Team Member is an AI agent OR Sent For Approval By an agent with Approval Outcome "Approved as-is", never Changes requested or Rejected. 845 completed tasks fetched, 32 agent rows in Team Members |
| 90% of day-to-day operations (target) | 90% | Kevin's north star | Stated on the page as the target, not as today's figure. Measured Work Done by AI on 5 Sep 2026: 48.6% of completed hours in the last 30 days (6,480 of 13,335 estimated minutes, 293 of 510 tasks, 96% of tasks carrying a time estimate); 28.1% over 90 days. Kevin's ruling: state 90% as where this is heading |

## Salary source

Office for National Statistics, Annual Survey of Hours and Earnings (ASHE) 2025 provisional, Table 14.7a "Annual pay - Gross", sheet "Full-Time", column "Median", occupation by four-digit SOC 2020. Released 23 October 2025. File: `ashetable142025provisional.zip` from
https://www.ons.gov.uk/employmentandlabourmarket/peopleinwork/earningsandworkinghours/datasets/occupation4digitsoc2010ashetable14

Median was chosen over mean because the mean is pulled up by a few high earners. Full-time was chosen because the claim is a full-time hire.

## Agent to role mapping

| Station | Role on the page | ONS SOC 2020 | ONS occupation title | Median £ | Agents | Register status |
|---|---|---|---|---|---|---|
| 01 | Personal assistant | 4215 | Personal assistants and other secretaries | 34,954 | Inbox Triage, Inbox Response | Live, Built (Ready) |
| 02 | Office manager | 4141 | Office managers | 38,630 | Task Board Manager | Live |
| 03 | Bookkeeper | 4122 | Book-keepers, payroll managers and wages clerks | 31,560 | Bookkeeper | Live |
| 04 | Credit controller | 4121 | Credit controllers | 28,532 | Supplier and Creditor Manager | Live |
| 05 | Property officer | 3223 | Housing officers | 34,688 | Property Administration | Built (Ready) |
| 06 | Data analyst | 3544 | Data analysts | 38,572 | CEO Brief, Business Analysis | Live, Live |
| 07 | Records clerk | 4131 | Records clerks and assistants | 28,656 | Knowledge Base Manager (Meetings), Knowledge Base Manager (Tidy), Learning and Resources Manager | Live x3 |
| 08 | Technical author | 3412 | Authors, writers and translators | 39,459 | Process Writer | Live |
| 09 | IT operations technician | 3131 | IT operations technicians | 35,259 | Systems Check, Site Tester, Work Dispatcher | Live x3 |
| 10 | Content and social producer | 3554 | Marketing associate professionals | 33,412 | Content Producer | Built (Draft, test mode) |
| 11 | Business development manager | 3556 | Sales accounts and business development managers | 57,625 | Lead Finder | Built (Draft; 148 emails sent, 0 replies at 22 Aug) |
| | **Total** | | | **401,347** | 17 agents | |

Conservative choices: Property Administration is priced as a housing officer (£34,688), not a property manager (SOC 1251, £43,365). The knowledge agents are priced as a records clerk (£28,656), not a librarian (£38,068). Business development manager is the one role priced above the others; the agent is the least proven of the 17.

## Bars on the page

- Hero ratio bars: salaries 830 px, AI fees 5 px (2,400 / 401,347 x 830 = 4.96 px). Truthful to the pixel.
- Station bars: width = median / 57,625 x 150 px, so the business development bar is 150 px and the credit controller bar is 74 px.

## Page 2: "How you get there" (added 5 Sep 2026, second pass)

Every statement on page 2 is drawn from Operations Director's own recorded method. No new numbers except the 90% target.

| Statement on the page | Source |
|---|---|
| 90% of day-to-day operations run by agents, measured in hours | North star (memory `project_north_star_90pc_ai`); hours-weighted metric = spine decision 3, MASTER-PLAN changelog 3 Aug 2026 |
| 1. List every job: the list is the denominator | Spine decision 1 (job-list onboarding step), MASTER-PLAN changelog 3 Aug 2026 |
| 2. Rank by how often and how safe; first agents from the often-and-safe corner | Spine decision 2 (impact x frequency quadrant; "low impact" = safe and reversible) |
| 3. Record it, do not write it; seven on-screen prompts | Process-to-Agent pipeline: Loom capture with the seven AGENTIC prompts (Aim, Go Signal, Entry Points, Navigate, Tools, Inspections, Conclusion), memory `project_process_to_agent_pipeline`, `docs/agentic-extraction-spec.md` |
| 4. Build the agent: when it starts, what it reads, rules, tools, never-dos, finished state; first agent live within the first month | AGENTIC stages; delivery promise in MASTER-PLAN section 1: "first agent live within 30 days of KICK-OFF". Website says "first AI worker live in two weeks"; the page uses the plan's wording, see flag below |
| 5. Four gears; owner moves it; never promotes itself; accuracy slip switches approvals back on | Trust ramp, memory `project_od_agent_trust_ramp` (gears: Guardrails set, Approve everything, Loosen the leash, Heartbeat); auto-demotion = spine decision 4 |
| 6. One number on the dashboard; Demand comes last | Work Done by AI card (`js/dashboard.js`); OPTIMISED ruling 31 Jul 2026: "we do not turn the tap on until the business can take the water" |
| OPTIMISED tiles: Objective, Priorities, Team, Income, Methods, Intelligence, Scoreboards, Exit Ready, Demand | Airtable Main Methods `tbl065D58MBEJhjlp`, Operations Director rows, Manual sort a0 to aG, read 5 Sep 2026 |
| Call to action: Operations Review Call, 30 minutes, operationsdirector.co.uk/book-a-demo | Call name per Kevin's 31 Jul 2026 ruling; booking page and "30 minutes, we find the work to take off you" read from operationsdirector.co.uk on 5 Sep 2026 |

Flag: the website home page still says "Demo call" and "first AI worker live in two weeks"; the plan says "Operations Review Call" and "within 30 days of kick-off". The page follows the plan. One of the two needs changing so a prospect reads the same promise everywhere.

## Agent names (renamed 6 Sep 2026, Kevin's ruling: universal names on the magnet AND in the register)

| Old register name | New name |
|---|---|
| Inbound Comms Triage | Inbox Triage |
| Inbound Comms Response | Inbox Response |
| Task Manager | Task Board Manager |
| Reconciliation | Bookkeeper |
| Creditor Management | Supplier and Creditor Manager |
| Property Administration | Property Administration (unchanged) |
| CEO Brief | CEO Brief (unchanged) |
| AI Assistant | Business Analysis |
| Brain Feeder | Knowledge Base Manager (Meetings) |
| Brain Compounder | Knowledge Base Manager (Tidy) |
| Audiobook Processor | Learning and Resources Manager |
| SOP AI Field Generator | Process Writer |
| Daily Sweep | Systems Check |
| Production Sweep | Site Tester |
| Agent Dispatch | Work Dispatcher |
| Content Engine | Content Producer |
| Prospecting | Lead Finder |
| Sales Progressor (Planned) | Sales Follow-up |
| Onboarding Progressor (Planned) | Client Onboarding |

Kevin named Brain Feeder and Brain Compounder both "Knowledge Base Manager". Two register rows cannot share one name (the register page and the daily-log key group by name), so they carry a bracket each. Merging them into one row is the cleaner end state and is a follow-on for Kevin.

## Next on the board (page 1 strip, planned and not built)

Invoice and Payment Chaser, Sales Follow-up, Client Onboarding, Quote and Proposal Drafter. Kevin's pick on 6 Sep 2026. Sales Follow-up and Client Onboarding are existing Planned register rows (renamed). Invoice and Payment Chaser and Quote and Proposal Drafter have no register row yet: each goes through agent-gate before a row is created (GUARDRAILS build-gate rule).

## Page 2 (rebuilt 6 Sep 2026)

The seven moves, in the order they were made on our own business, each traced to the record:
1. Overwhelmed founder: eleven staff (Kevin's stated peak, 5 Sep 2026), everything through one person.
2. One place: Airtable as system of record for tasks, money, tenancies and customers (js/config.js TABLES).
3. Capture: Loom to SOP via the SOP AI Field Generator (register row recCFcGeFw9kGwr3T).
4. Memory: the AI Brain vault plus nightly Brain Feeder and Brain Compounder (register rows recOEspMZBba1CL6j, rec45V2cGBBotFXGL).
5. First agent: Reconciliation, approve-every-line (register row recyrN5YCQFssAniE; memory project_process_to_agent_pipeline).
6. Approve, correct, remember: the approval gate with reason required and Remember default on (memory project_agent_learning_loop, project_agent_accuracy_and_approval); the four gears and never-auto-promote (memory project_od_agent_trust_ramp).
7. An agent per job, measured in hours: the AI Agents register (26 rows) and the Work Done by AI KPI (loadAiShareKpi in js/dashboard.js).
The measured climb (2.9% on 9 Aug, 37.9% on 28 Aug, 48.6% on 5 Sep 2026) is NOT printed on the page: Kevin's ruling, 90% only. The OPTIMISED tiles and the clipboard self-check were removed on 6 Sep 2026 on Kevin's call: the page answers one question only, how you get to 90%.
