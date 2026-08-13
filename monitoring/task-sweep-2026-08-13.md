# Task Hygiene Sweep — 2026-08-13

## Read this first — two things are running late in the real world

**1. A tap is pouring water at a tenant's property and nobody has been sent.**
On Mon 10 Aug the tenant texted "Get some one around to fix our tap. Water is pouring out of it."
(task `rec410QWIJ1wBGBo8`). On Wed 12 Aug they texted again asking if we have any maintenance
people (task `reccQAxF8x2TZIla2`). The chase sits with Ericamae, who does marketing, not property.
Three days, no contractor booked. This needs a plumber today.

**2. A council deadline has already passed.** Hannah Lea, Housing Enforcement Officer at
Manchester City Council, asked for the electrical inspection date and a satisfactory EICR on
1406 Oldham Road "no later than Monday 10 August 2026" (task `rec6sFWeMMhtSzgrE`). No reply has
been sent. An electrician has to attend, so this is not just a letter to write.

## Score
Live tasks: 250. Fully compliant: 241 (96.4%).
Owned by an AI agent: 150 (60%). Owned by a person: 95. Owned by nobody: 5.
Gaps: 166 missing a project, 5 missing an owner, 4 missing a business, 8 badly overdue.

## Fixed tonight (no approval needed)
Six business tags. Nothing else needed filling: no task was missing a time estimate or a due date.

| Task | Field | Value | Why |
|---|---|---|---|
| INBOUND: Re: Council Tax - 20005049078 | Business | Real Estate | Burnley council tax for 22 Newton Street, a rental property |
| INBOUND: Fix: Monese — 10 days to deletion | Business | Personal | the Monese CB account is documented as Personal in our own reconciliation rules |
| INBOUND: SMS reply from +4475XXXXX747 | Business | Real Estate | tenant text about a fridge freezer and maintenance people |
| INBOUND: Reply from Kent Reliance | Business | Real Estate | Kent Reliance is a buy-to-let mortgage lender |
| INBOUND: HMRC SelfAssessment DailyPenalty_CM Brittain (completed 29 Jul) | Business | Personal | personal self assessment |
| INBOUND: BW Legal (acting for HMRC) SelfAssessment debt (completed 29 Jul) | Business | Personal | personal self assessment |

Undo log: `monitoring/task-sweep-applied-2026-08-13.json`.

## Waiting on you
2 decisions held. Both hand work to an AI agent, not to a person. **No human assignee changes
tonight, so approving these sends zero Slack DMs.** Say "approve the sweep" in any Claude session
to apply them, or name the ones to drop.

| Task | Field | Proposed | Why |
|---|---|---|---|
| INBOUND: SMS reply from +4475XXXXX747 | Owner (agent) | AI Operations (Gino Wickman) | inbound tenant text to triage and answer |
| INBOUND: Urgent Update required: 1406 Oldham Road | Owner (agent) | AI Legal & Compliance (Keith Cunningham) | council enforcement letter to answer |

## Left alone
- **PARKED — revisit after the first client** (`recDxBEUC8wk6UIl7`) — deliberately parked, so no
  owner proposed. Worth a look though: it is a rolled-up bundle of four items on an off-track
  project, and one of them is chasing $1,800 of GoHighLevel commission. Money owed should not be
  buried in a parked bundle.
- Two completed inbound emails I could not attribute to a business: a 123 Reg domain renewal
  (no way to tell which domain) and "Welcome to NeighborsCU!" (looks like it is not ours at all).
- **Two maintenance tickets I nearly got wrong** — "Replace window hinge, second bedroom" and
  "Measure and quote carpets, both bedrooms", both at 14 Wentworth Terrace, Haverhill. I proposed
  putting Mica's name on them. The CEO stopped it: the physical work belongs to a contractor, and
  a blank assignee already means an agent owns it, so naming Mica would have moved two hours off
  the AI column for nothing. Left blank. What they actually need is a contractor linked.

## Still real? (8 badly overdue tasks, all reviewed)
| Task | Days late | My read |
|---|---|---|
| Pay Final Council Tax Adjustment – 32 Elmdon Place, Haverhill | 203 | Still live. Needs a new due date and a person, as paying is a Kevin action. |
| Pay tax liability for tax return 2023/24 – Ciara Brittain | 181 | Still live, and connected to the HMRC penalty letters above. Needs a new date. |
| Fwd: Invoice INV-0549 from PPE & Sons (£168, due 16 Mar) | 146 | Probably done already. Check the payment before closing. |
| DD Fire Alarms Ltd – Duckworth Buildings | 146 | Probably done already. Same check. |
| Invoice 40859 from DD Fire Alarms Ltd | 146 | Probably done already. Same check. |
| Fwd: Cleaning Invoice | 139 | Probably done already. Same check. |
| Invoice 40893 from DD Fire Alarms Ltd | 139 | Probably done already. Same check. |
| Mark Peters COA and rent into payment | 113 | Still live. This is a payment-gap tenancy, so it belongs on that project with a real date. |

All 8 reviewed, none skipped. I have not acted on any of them — these are proposals.
No duplicates found: none of the pairs matched on name, business and due date together.

## Coverage of the AI-share KPI
118 tasks completed in the last 30 days. **All of them carry a time estimate (100%).** Nothing is
invisible to "Work Done by AI %" this month. Four completed tasks were missing a business; I filled
two and left two I could not judge. Business does not affect the KPI, only the attribution.

## Known scoring artefact (unchanged, already filed)
"Missing project" is 166 of the 250 and dominates the gap count. Most tasks are ordinary operations
and genuinely belong to no project, so this is a scoring artefact, not mess. Already filed as
finding `20260808-task-hygiene-sweep-018`. Not filed again.

## CEO review
Reviewed all ten proposals. Verdict: approved 6 business tags, kept both agent routes, **dropped
both Mica assignments** for the reason above. It also found the water leak and the passed council
deadline, which the field-filling had reduced to two tidy little tagging jobs. Both changes taken.

## Undo
python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-13.json
