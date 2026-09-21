---
name: airtable-task-creator
description: Create a task in Kevin Brittain's Operations Director Airtable base (Tasks table) with the two-phase workflow, routed to the right owner. Routing (21 Sep 2026) - an AI agent owns the task by default (Assignee left blank, Team Member set to the agent); repairs, and property work Kevin asks to be Roy's, go to Roy Lavin, head of the property business (a team member, not a contractor); Kevin only when no agent can do it. Never Mica (no routing since 25 Aug 2026) or Ericamae (left 17 Sep 2026). This project copy REPLACES the claude.ai skill of the same name (anthropic-skills:airtable-task-creator), which still routed to Mica and Ericamae, treated Roy as a contractor and defaulted the assignee to Kevin. Use when Kevin asks to create a task, add a task, or schedule work in Airtable.
---

# Airtable Task Creator

This is the reviewed project copy (21 Sep 2026). It replaces the claude.ai skill
`anthropic-skills:airtable-task-creator`. The field IDs and the two-phase workflow are the
original skill's. The routing is rewritten to the current rules, each checked against its
source (listed under "Sources" at the bottom), and the Airtable calls use the path that runs
in this repo.

## Step 0: pick the owner (routing)

Work down this list and stop at the first route that fits.

1. **An AI agent (the default).** Leave **Assignee blank**. A blank Assignee is not a gap: it
   means an AI agent owns the task through the **Team Member** link. Never fill an Assignee
   to "complete" a task. Set Team Member to the AI CEO (`reciHUAEcEkbctnZ6`) unless Kevin
   names a specific agent, in which case use that agent's Team Members row from `AGENTS` or
   `ROLE_AGENTS` in `scripts/agent-dispatch.py` (read it there, never from a list in a
   prompt). On its next run the dispatch engine applies the fixed lanes: repairs to Roy;
   certificates, licences, landlord insurance and inspections to Property Administration;
   creditor and payment chasing to the Supplier and Creditor Manager; inbound replies to
   Inbox Response. The CEO routes everything else to the agent whose goal matches.
2. **Roy Lavin, head of the property business.** Roy is a TEAM MEMBER, not a contractor
   (since 25 Aug 2026). Hand a task straight to him when it is a **repair** (Kevin's standing
   approval: every maintenance task passes to Roy with no per-task yes) or when **Kevin asks
   for it to be Roy's** (his ask is the yes). Any other property work goes to an agent first
   (route 1) and reaches Roy prepared. Never send Roy non-property work. Roy is not on
   Operations Director: email is his channel, and the handover in Phase 2b sends it.
3. **Kevin, the last resort.** Only for work no agent can do: a payment, a signature, a
   credential, a bank action, a physical action, or a founder decision. Prepare it in full
   first, so the task carries one clear ask. Set Assignee to Kevin. Since 17 Sep 2026 Kevin
   does not work a task list: a task he holds reaches him in the 09:00 CEO brief's "only
   you today" section.

**Never route to:**

- **Mica.** No task has been routed to Mica since 25 Aug 2026. She is a team member, not a
  routing destination. If Kevin asks for a task to be Mica's, say it goes against his
  25 Aug 2026 ruling and go ahead only on his explicit yes, with the Phase 2b handover and
  `--to micaa.work@gmail.com`.
- **Ericamae.** She left on 17 Sep 2026. Never assign to her, even on request. Say she has
  left and offer route 1.

> **CONTRACTOR GUARDRAIL.** If the requested owner is a contractor (Gary or Rob), the job
> is a repair: route it to **Roy** (route 2) with **Maintenance Ticket** ticked and the
> contractor named in the description. Roy instructs the contractors. Do not assign a
> contractor directly. The old redirects are retired: the `#property-management` Slack
> channel and the contractor bot stopped on 1 Sep 2026 (the bot's `/create-task` returns
> 410). `scripts/slack-automation/CONTRACTOR-TASK-PATHS.md` predates that and its Slack
> paths no longer run.

## Base Configuration

- **Base ID**: `appnqjDpqDniH3IRl`
- **Tasks Table ID**: `tblqB8b22hKBL4PF1`
- **Projects Table ID**: `tblHrpTMd5LNYn8v1`
- **Team Members Table ID**: `tblco0p2OnlLQVAX7` (people AND the AI agents)
- **Default owner**: an AI agent, the AI CEO (`reciHUAEcEkbctnZ6`), with Assignee blank
- **Roy Lavin**: Team Members row `reclbdjfVev3bqNHS`, collaborator `usr5vWiGkkgXEs5wS`,
  `roy.lavin1978@gmail.com`
- **Kevin Brittain** (last resort): Team Members row `recHEt2VPYothaqTd`, collaborator
  `usrKkopUJSGsBhWMD`, `kevin@runpreneur.org.uk`

**Airtable access.** Use curl with the PAT at `~/.config/od/airtable_pat` and never print
the token. The original skill's `manus-mcp-cli` commands do not run here (there is no such
tool, and the airtable MCP connector is broken), so the payloads below are the same fields
in a form that runs. Commands run from `/Users/kevinbrittain/Projects/leadership-dashboard`.

## Task Creation Workflow

### Phase 1: Initial Task Creation

Collect from Kevin:
- **Description** - What the task is
- **Owner** - From Step 0 (default: an AI agent; never Mica or Ericamae)
- **Due Date** - When it's due (default: today)
- **Time Estimate** - How long it takes (options: `15 min`, `30 min`, `45 min`, `1 hr`, `2 hr`, `3 hr`, `4 hr`, `8 hr`)
- **Priority** - Type: `Project` (linked to project), `Urgent`, or `Not Urgent`

Create the task with the **Task Name**, **Status** and the **owner fields**, through the
create-time duplicate gate (one subject = one open task):

```bash
python3 scripts/create-agent-task.py create --fields-json '{
  "fldgFjGBw6bTKJFCD": "<description>",
  "fldx4qCw17UfrKpaN": "Today",
  <owner fields>
}'
```

Owner fields by route:

| Route | Owner fields at create |
|---|---|
| 1, AI agent | `"flduCtmQGpOA4eWaj": ["reciHUAEcEkbctnZ6"]` (or the named agent's row). No Assignee. |
| 2, Roy | None yet (Phase 2b writes them). For a repair add `"fldSEUvVA98as1HW6": true` (Maintenance Ticket). |
| 3, Kevin | `"fldELMncVJYPDRJNc": {"id": "usrKkopUJSGsBhWMD", "email": "kevin@runpreneur.org.uk"}` |

The script prints JSON. `"action": "created"` gives the new `taskId`. `"action": "updated"`
means an open task already carries the same subject and the new item was folded into it:
use that `taskId` and tell Kevin which task it joined. Exit 2 means the gate could not read
the board and nothing was created: say so, never retry with a bare POST. Exit 3 means the
item was refused (a machine receipt is never a task): report the reason.

**Why Status is set at create (21 Sep 2026).** The original skill created the task with only
Task Name and Assignee and relied on the Airtable automation "Task Configuration Upon
Creation" (`wflCFctB5DDepIuai`) to set Time Estimate, Priority and Status (Today). Read on
21 Sep 2026, that automation is UNDEPLOYED. The dispatch engine only picks up tasks on
Today or Overdue, so an agent-owned task with no Status would sit on no surface. The gate
script also sets Today when no board status is passed. Phase 2 sets Time Estimate and
Priority.

### Phase 2: Update Fields After Automation (Wait 30 seconds)

After 30 seconds, update the task with Kevin's values:

```bash
PAT=$(cat ~/.config/od/airtable_pat)
curl -s -X PATCH "https://api.airtable.com/v0/appnqjDpqDniH3IRl/tblqB8b22hKBL4PF1/<record_id>" \
  -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
  -d '{"fields": {
    "fld7XP8w8kbxfETV4": "<YYYY-MM-DD>",
    "fld10VzzbiNNgRmIi": "<user_specified_time>",
    "fldS21RwmwOqt71LI": "<Project|Urgent|Not Urgent>",
    "fldBg0rQy0FrOAkRN": ["<project_record_id>"]
  }}'
```

**Note**: Only include the Projects field (`fldBg0rQy0FrOAkRN`) if Priority is `Project`.
Read the response: a 200 with the record is the proof. An error body means nothing changed.

### Phase 2b: Hand to Roy (route 2 only)

After Phase 2, so the email carries the finished task:

```bash
python3 scripts/agent-dispatch.py handover <record_id> \
  --to roy.lavin1978@gmail.com --reason "<why this is Roy's: a repair, or Kevin asked>"
```

The handover writes BOTH owner links (Team Member and Assignee), clears any agent link,
refuses tier-1 content (the private legal and financial matter) unless Kevin has approved
that exact handover, and emails Roy the work. A failed email does not undo the
reassignment: the output then carries `"NOT EMAILED"` with the reason, and you report it.
The same command, with `--to micaa.work@gmail.com`, is the only route to Mica, and only on
Kevin's explicit yes (see Step 0).

### Phase 3: Notify

No route sends a message from this skill any more:

- **Route 1 (AI agent):** nobody to tell. The agent picks the task up on its next dispatch run.
- **Route 2 (Roy):** the Phase 2b handover emails him the work.
- **Route 3 (Kevin):** no message. He sees tasks he holds in the 09:00 CEO brief. Never add a
  Slack message to Kevin: his Slack contract (1 Sep 2026) allows only the 08:00 digest, the
  09:00 brief and task movement DMs.

The original skill's Phase 3 posted a Slack DM through the `slack-notify` Cloudflare Worker
(`https://slack-notify.kevinbrittain.workers.dev/`, the same path as the dashboard's
`notifyAssigneeSlack`). It was written for assigning to Mica and Ericamae, and no current
route uses it.

## Finding Owners and Projects

### Look Up Owner IDs

- An AI agent: its Team Members row from `AGENTS` or `ROLE_AGENTS` in
  `scripts/agent-dispatch.py`. Dispatchability is decided by the live AI Agents register
  (`tbl9msVjyQWslLOIZ`, Status Built or Live), so an agent that is paused there will not be
  given the work: route 1 to the AI CEO is always safe.
- Roy and Kevin: the IDs under Base Configuration (read live from Team Members,
  21 Sep 2026). A person not listed there is not a routing destination.

### Link to Project (if Priority = Project)

Search for the project by keyword (the primary field is `Project Name`):

```bash
PAT=$(cat ~/.config/od/airtable_pat)
curl -s -G "https://api.airtable.com/v0/appnqjDpqDniH3IRl/tblHrpTMd5LNYn8v1" \
  -H "Authorization: Bearer $PAT" \
  --data-urlencode 'filterByFormula=SEARCH("<project keyword, lower case>", LOWER({Project Name}))' \
  --data-urlencode 'fields[]=Project Name'
```

Zero rows is not proof the project does not exist: a typo in the field name also returns
zero. Try a shorter keyword, and ask Kevin before creating the task without the link.
Use the project's record ID in the `Projects` field during Phase 2.

## Field Reference

| Field Name | Field ID | Type | Phase Set |
|------------|----------|------|-----------|
| Task Name | fldgFjGBw6bTKJFCD | singleLineText | Phase 1 |
| Status | fldx4qCw17UfrKpaN | singleSelect | Phase 1 (`Today`; the creation automation is undeployed) |
| Team Member | flduCtmQGpOA4eWaj | multipleRecordLinks (Team Members) | Phase 1, route 1; Phase 2b, route 2 |
| Assignee | fldELMncVJYPDRJNc | singleCollaborator | Phase 1, route 3 only; Phase 2b, route 2. Blank on agent-owned tasks |
| Maintenance Ticket | fldSEUvVA98as1HW6 | checkbox | Phase 1, repairs |
| Due Date | fld7XP8w8kbxfETV4 | date | Phase 2 |
| Time Estimate | fld10VzzbiNNgRmIi | singleSelect | Phase 2 |
| Priority | fldS21RwmwOqt71LI | singleSelect | Phase 2 |
| Projects | fldBg0rQy0FrOAkRN | multipleRecordLinks | Phase 2 (conditional) |

Every ID above was checked on 21 Sep 2026 against `js/config.js` and a read-only schema call
on base `appnqjDpqDniH3IRl`.

## Example Workflows

**Research or admin task (the default, an AI agent):**

1. Phase 1: create with the description, Status `Today`, Team Member = AI CEO, no Assignee
2. Phase 2 (after 30s): set due date, time estimate, priority
3. No notification: the dispatch engine routes it on its next run

**Project task for an agent (linked to project, 1 hr, specific date):**

1. Phase 1: create with the description, Status `Today`, Team Member = AI CEO, no Assignee
2. Phase 2 (after 30s): set due date, time to `1 hr`, priority to `Project`, link project
3. No notification

**Repair (boiler, leak, damp, a job for Gary or Rob):**

1. Phase 1: create with the description (naming any contractor), Status `Today`, Maintenance Ticket ticked
2. Phase 2 (after 30s): set due date, time estimate, priority
3. Phase 2b: `handover` to Roy, which emails him the work

**Only Kevin can do it (a payment, a signature, a bank action):**

1. Prepare it in full so the task carries one clear ask
2. Phase 1: create with the description, Status `Today`, Assignee = Kevin
3. Phase 2 (after 30s): set due date, time estimate, priority to `Urgent` if it is
4. No notification: it reaches him in the 09:00 CEO brief

## Sources (checked 21 Sep 2026)

- Blank Assignee means an AI agent owns the task: Claude Code memory
  `project_assignee_blank_means_agent_owned.md`; `cmd_queue` in `scripts/agent-dispatch.py`
  selects agent work by Team Member.
- No routing to Mica since 25 Aug 2026; Ericamae left 17 Sep 2026; Kevin is the last resort:
  `~/.claude/agents/ESTATE.md` section 2, and memory `project_ai_only_task_routing.md`.
- Roy is head of the property business, a team member not a contractor, with standing
  approval for maintenance; email is his channel: memory `project_roy_property_head.md`;
  `HUMANS` and `cmd_handover` in `scripts/agent-dispatch.py`.
- The fixed routing lanes: `~/.claude/agents/ESTATE.md` section 3.
- Kevin does not work a task list; only-you items go in the 09:00 CEO brief: ESTATE.md,
  ruling of 17 Sep 2026.
- Contractor bot and Slack job flow retired 1 Sep 2026: `scripts/slack-automation/contractor-bot.js`
  (`/create-task` returns 410); memory `project_slack_notification_contract.md`.
- The creation automation `wflCFctB5DDepIuai` is undeployed: Airtable automation listing,
  read 21 Sep 2026.
