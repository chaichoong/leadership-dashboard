# Task Hygiene Sweep — 2026-08-11

## Score

Live tasks: 237. Fully compliant: 231 (97.5%). It was 95.7% when the sweep started this morning.

Who owns the work: 121 tasks belong to an AI agent (51%), 113 to a person, 3 to nobody.

Every task finished in the last 30 days now has a time estimate. That is 100% coverage,
so the "Work Done by AI %" number on the dashboard is being measured over the whole month,
not over whatever happened to carry an estimate.

## Fixed tonight (no approval needed)

11 writes across 9 tasks. No Slack messages were sent, because nothing changed an assignee.

| Task | Field | Value | Why |
|---|---|---|---|
| SMS reply from +4475XXXXX747 | Business | Real Estate | Tenant reporting a leaking tap. The phone number matches Anthony Chappell, an active tenant. |
| SMS reply from +4475XXXXX747 | Due date | 11 Aug (today) | The message says water is pouring out of the tap. The task was flagged "Not Urgent" with no date at all. |
| Urgent Update required: 1406 Oldham Road | Business | Real Estate | Manchester Council chasing the electrical safety certificate for one of your properties. |
| Urgent Update required: 1406 Oldham Road | Due date | 14 Aug | Council marked it urgent but gave no deadline in the email, so three working days. |
| Agile Estates Ltd, company number 12168161 | Business | Real Estate | Companies House late filing penalty for Agile Estates. |
| SMS from Stacey, 14 Wentworth | Business | Real Estate | Tenant reporting a broken window. 14 Wentworth Terrace is one of yours. |
| British Gas — Ciara Marie Brittain | Business | Personal | Ciara is not a tenant anywhere in the base, so this is family, not property. |
| Council Tax Payment Overdue (ARP) | Business | Real Estate | Account 101287570 is 18 Northfield Park. Matched to the cost record, not guessed. |
| Companies House appeal 12168161 (done) | Business | Real Estate | Same Agile Estates matter. |
| FCC Paragon / Legal Protection Group (done) | Business | Real Estate | Landlord legal-expenses cover. |
| British Gas final bill, Ciara Brittain (done) | Business | Personal | Same matter as the live one above. |

Undo all of it with:
`python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-11.json`

## Waiting on you

2 decisions held. Say "approve the sweep" in any Claude session to apply them.

**No assignee changes tonight, so approving this sends zero Slack messages.**

| Task | Field | Proposed | Why |
|---|---|---|---|
| Mark Peters COA and rent into payment | Project | Close the payment gap | The task is word for word what that project exists to do. |
| Fix email authentication for operationsdirector.co.uk (SPF + DKIM) | Project | The outbound engine runs, every day | Cold email will not land without these, so it blocks the outbound project. |

## Left alone

**Two tasks still have nobody on them, on purpose.**
The tenant leak and the council certificate chase are both AI work — one drafts a reply to
the council, the other books a contractor, and both of those are already built. The sweep
cannot record an AI agent as the owner (see "One thing to fix" below), so the only name it
could write was Mica's. Your CEO's call, which I took: writing a person because the tool
cannot say "agent" turns a software gap into a permanent human job that nobody ever undoes.
Blank already means an agent owns it, so blank is the more honest answer for one day.

The third unowned task is "PARKED — revisit after the first client", which is parked
deliberately. Naming anyone would ping them about work you have decided not to start.

**Five tasks where I could not confidently name the business, so I wrote nothing:**

- Google Payments: your payments are on hold. Cannot tell which of your businesses is owed.
- Virgin Media order documents (done). Could be a property or your home.
- "Session 5 Replay" (done). No clue in the record what it belongs to.
- Reply from Ibrahim Fayed at primemover.com (done). No context in the record.
- 123 Reg domain renewal (done). You hold domains across all three businesses.

**Two HMRC penalty tasks for CM Brittain (both done) left blank on purpose.** Your history
splits these — some self-assessment tasks sit under Personal, some under Real Estate. One
question settles it for good: does Ciara file a self-assessment because of rental income? If
yes they are Real Estate, if no they are Personal.

**One dropped after CEO review.** The Fintable "Lifetime Plan" reply was going to Real
Estate on precedent. Fintable also feeds the platform's own sync monitor, so booking it to
property hides an Operations Director cost inside the portfolio, and a lifetime licence is
your spending decision anyway. Left blank.

## Needs you today, not triage

**"Welcome to NeighborsCU!"** is sitting in the queue as an ordinary 15-minute inbound
email. It is a US credit union confirming a new membership, a vehicle loan and a savings
account. Either it is misdirected mail, or an account has been opened in your name. With
the legal and financial matter live, that is your decision, not something to triage.

## Still real? (the 9 oldest overdue tasks)

All nine are genuinely still live. None are duplicates and none look already done.

Five are unpaid supplier invoices, and I checked the bank data rather than assuming: there
is no payment to DD Fire Alarms, PPE & Sons Heating & Plumbing, or Naturally Neat anywhere
in the transaction history. They have simply been left.

| Task | Overdue | Verdict |
|---|---|---|
| Pay Final Council Tax Adjustment — 32 Elmdon Place | 201 days | Still live. Needs a new date. |
| Pay tax liability 2023/24 — Ciara Brittain | 179 days | Still live. HMRC and BW Legal are still chasing this in your inbox this week. |
| Invoice INV-0549, PPE & Sons (£168) | 144 days | Still live. Never paid. |
| DD Fire Alarms — Duckworth estimate | 144 days | Still live, but it is an estimate, not a bill. Likely superseded by the two invoices below — worth closing if so. |
| Invoice 40859, DD Fire Alarms | 144 days | Still live. Never paid. |
| Invoice 40893, DD Fire Alarms | 137 days | Still live. Never paid. |
| Cleaning invoice (Naturally Neat) | 137 days | Still live. Never paid. |
| Update Together payment dates to the 28th | 111 days | Still live. Small admin job. |
| Mark Peters COA and rent into payment | 111 days | Still live. This is the payment-gap project. |

None skipped — the list was 9 tonight, down from 65 on 9 August.

## Project links

155 tasks carry no project link. I proposed 2. The other 153 are ordinary operations —
UC verifications, standing orders, council letters, inbound email triage — and belong to no
project. Forcing links would add project collaborators to tasks that do not need them.

## Recurring

Nothing written. Recurring is no longer counted as a gap by the audit, so it no longer drags
the score down, and the old trap still stands: writing "None" is a value, not an empty box,
and would arm one-off tasks to clone themselves.

## CEO review

od-ceo reviewed the whole set before anything was written, and changed four things:

1. **Dropped the Fintable business fill** — an Operations Director cost was about to be
   booked to Real Estate.
2. **Dropped both Mica assignments** — see "Left alone" above.
3. **Moved the leak due date from 13 Aug to today.** It also said the tenant's message was
   missing from the record; I re-read the raw field and the text is there, about 600
   characters in, buried inside the SMS relay's table markup. The date change was right, the
   reason for it was not.
4. **Refused to accept "11 of 11 similar tasks went to Real Estate" as proof** for the
   council tax item and told me to match the account number instead. I did: account
   101287570 is 18 Northfield Park. Same answer, now evidenced.

It also flagged that inbound capture stamps nearly every email Urgent / today / 15 minutes,
so Priority carries almost no information. Filed as a finding.

## One thing to fix (filed for the code queue, not done here)

The sweep is told to hand unowned work to an AI agent first and only name a person when a
person is genuinely needed. It cannot. The script can write Assignee (people) but not Team
Member (where agent ownership lives), so the only owner it can ever propose is a human. Every
night the AI-first rule quietly becomes a human assignment plus a Slack message. Filed as
`20260811-task-hygiene-081` (high). The capture-default problem is `20260811-task-hygiene-082`.

## Undo

python3 scripts/task-hygiene-sweep.py undo --applied monitoring/task-sweep-applied-2026-08-11.json
