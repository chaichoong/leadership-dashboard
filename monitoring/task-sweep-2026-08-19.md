# Task Hygiene Sweep — 2026-08-19

## Score
Live tasks: 253. Fully compliant: 225 (88.9%). Was 93.5% yesterday.
Owned by an AI agent: 138 (54.5%). Owned by a person: 108. Owned by nobody: 7.
Also left out of the score: 52 tasks waiting on your approval, 16 with no status.

The score dropped because 22 brand-new inbound items arrived overnight with no
business tag, most of them scanned post from 16 August. That is new post landing,
not old work rotting. Twenty-one of those gaps are now closed.

## Fixed tonight (no approval needed)

Twenty-one business tags filled in. No due dates, no owners, no projects.

| Task | Value | Why |
|---|---|---|
| Burnley Council court summons, 22 Newton Street | Real Estate | council tax on a portfolio property |
| Fylde Council payment arrangement, Flat 1 Duckworth | Real Estate | council tax on a flat |
| Companies House, action to strike off Social Housing Estates | Real Estate | that company's other task is tagged Real Estate |
| Hambury Tilmond notice of enforcement, West Suffolk | Real Estate | enforcement on a property's council tax |
| Ronald Fletcher Baker, final charging order, 17 Newington | Real Estate | charging order over a property |
| Companies House, overdue confirmation statement, Brittain Holdings | Real Estate | all five existing Brittain Holdings tasks are Real Estate |
| West Suffolk arrangement reminder, 4 Abington Place | Real Estate | council tax on a property |
| Fylde Council payment arrangement, Flat 3 Duckworth | Real Estate | council tax on a flat |
| Fylde Council court summons, Flat 2 Duckworth | Real Estate | council tax on a flat |
| Companies House, strike-off start, Social Housing Estates | Real Estate | same company as above |
| West Suffolk special arrangement, 13 Chedburgh Place | Real Estate | council tax on a property |
| EDF, get back on track | Real Estate | every existing EDF task is Real Estate (13 Eldon Road) |
| Companies House, overdue ID verification, Brittain Holdings | Real Estate | same company as above |
| Council tax query, 14 Wentworth Terrace | Real Estate | occupancy question on a let property |
| HMRC late tax return penalty, Mrs CM Brittain | Personal | self assessment; existing HMRC self-assessment tasks are Personal |
| HMRC late tax return penalty, Mr KJ Brittain | Personal | same |
| Reply to Lee Drury (WhatsApp) | Personal | the task itself says this is personal, not business |
| Alamo hire car return | Personal | your holiday car |
| SMS reply from Anthony (completed) | Real Estate | tenant chasing a fridge freezer swap |
| Reply to Roy Lavin re UC payment dates (completed) | Real Estate | rent payments on lets |
| Reply to Roy Lavin re Viola Street (completed) | Real Estate | Airbnb guest and neighbour's garden |

## Waiting on you

8 decisions held. Say "approve the sweep" in any Claude session to apply them all,
or name the ones to drop.

Only 3 of these name an AI agent and none names a person, so approving the lot sends
**zero Slack DMs**.

| Task | Field | Proposed | Why |
|---|---|---|---|
| 1406 Oldham Road, council chasing electrical certificate | Owner | AI Legal & Compliance | council letter with a compliance deadline |
| 18 Siddows Avenue, council garden complaint | Owner | AI Legal & Compliance | statutory complaint needing a reply |
| SMS reply from +4477XXXXX077 | Owner | AI Operations | inbound tenant text about a maintenance job |
| Mark Peters COA and rent into payment | Project | Close the payment gap | that is exactly what the project covers |
| Together arrears top up payments | Project | £12,000 Operating Cushion | the project title names the £500 Together allowance |
| Mortgage Product Transfers Plan | Project | £12,000 Operating Cushion | product transfers cut the monthly fixed cost the project measures |
| Reply to SSE Energy Solutions (£1,073 debt) | Business | Real Estate | held, see CEO review below |
| DBS enhanced certificate | Business | Real Estate | held, see CEO review below |

## Left alone

Seven things I would not guess at.

- **Advantis chasing HMRC VAT for Two Chefs Cambridge.** Two Chefs has its own
  business record in Airtable, but it is not one of the three active choices, so
  Operations Director, Personal and Real Estate would all be wrong.
- **"PARKED — revisit after the first client".** A parked list due 31 December. Giving
  it an owner would just restart work you deliberately stopped. Worth knowing: it still
  contains "$1,800 GHL commission due" buried in it. That is cash, not an idea, and it
  should come out of the parked bucket.
- **Window hinge repair** and **carpet measure and quote.** Both are physical jobs for a
  contractor. The sweep has no way to write the Contractor field, only Assignee, and
  putting a contractor in Assignee hides the job from the maintenance workflow. Logged
  as a code fix (finding 20260819-task-hygiene-233). Until that lands these two stay
  unowned. Gary Marsh is the obvious contractor for both.
- **Window hinge repair, again.** Its description says "High Priority, security and
  weather-tightness risk" but the Priority field reads Not Urgent and it went overdue on
  15 August. The sweep cannot write Priority. Worth a manual bump.
- **123 Reg domain renewal** (completed) — the email never names the domain, so I cannot
  tell which business owns it.
- **NeighborsCU vehicle welcome** (completed) — a US credit union congratulating someone
  on a car purchase. Almost certainly not yours.

## Still real? (8 tasks over 90 days past due)

I reached all 8. None acted on; these are proposals only.

| Task | Overdue | Verdict |
|---|---|---|
| Pay final council tax adjustment, 32 Elmdon Place | 209 days | **Probably done.** Nothing in Costs or Transactions matches. Check the council account, then close. |
| Pay tax liability 2023/24, Ciara Brittain | 187 days | **Still live.** Fresh HMRC late-return penalties arrived in the post on 16 August. Needs a new due date and an owner. |
| Invoice INV-0549, PPE & Sons for Roy Lavin | 152 days | **Cannot tell.** No matching invoice record exists, so I cannot prove it was paid. Someone has to look. |
| DD Fire Alarms Ltd, Duckworth Buildings | 152 days | **Cannot tell.** Same: no invoice record, no cost record. |
| Invoice 40859, DD Fire Alarms | 152 days | **Cannot tell.** Same. |
| Fwd: Cleaning Invoice | 145 days | **Cannot tell.** Same. |
| Invoice 40893, DD Fire Alarms | 145 days | **Cannot tell.** Same. |
| Mark Peters COA and rent into payment | 119 days | **Probably done.** He now has live UC verification tasks for August and September, so the rent is flowing. Verify, then close. |

The five invoice tasks are one decision, not five: none of them ever became an invoice
record, so there is no paper trail either way. Ask the suppliers or write them off.

## Keeping the AI metric honest

181 tasks were completed in the last 30 days. **All 181 carry a time estimate (100%).**
Nothing is invisible to the "Work Done by AI %" figure this month.

179 of the 181 also carry a business tag. The two that do not are the 123 Reg and
NeighborsCU emails above, which affects attribution only, not the KPI.

## CEO review

Reviewed before anything was written. It changed five things and I took all five.

- **Dropped 3 decisions** on the SSE smart meter email. I had given it a business, a due
  date and an owner. The CEO pointed out it is a mass "national smart meter upgrade"
  circular with no account number and no property in it, so all three were invented.
  It should be closed, not scheduled. That was the only missing due date in the whole
  list, so closing that one task takes due-date gaps to zero.
- **Held the SSE debt tag.** The task's own instructions say "identify which property or
  business this account belongs to". I was auto-writing the answer to the question the
  task exists to answer, on a £1,073 debt that has tripled since May. Now waiting on you.
- **Held the DBS tag.** A DBS certificate belongs to a person, not a portfolio. My
  "precedent" was a guess dressed up as evidence.
- **Dropped both contractor assignments** (see Left alone).
- **Asked for two tasks to be scoped, not just owned.** Manchester Council wants a date
  the contractors will attend 1406 Oldham Road, and no contractor is booked. Same at 18
  Siddows Avenue, where the garden physically needs clearing. If an agent just replies,
  it closes the reminder and leaves the actual job undone. Both need "draft a holding
  reply that promises no date, and raise the contractor job" written into them.

One CEO flag I checked and did not act on: it said three statutory items (the charging
order and the two Social Housing Estates strike-off notices) were sitting with no owner.
They are not. All three are already owned by the AI CEO agent. Whether AI Legal &
Compliance would be the better owner is your call, but they are not unowned.

## Undo
python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-19.json
