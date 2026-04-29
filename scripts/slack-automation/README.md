# Contractor Slack Bot — Setup

End-to-end: contractors post in `#property-management` → message routed to the
Tasks table → bot replies in thread. All logic lives in Airtable; no Make.com,
no third-party glue layer.

## Architecture

```
Slack Events API  →  existing Slack app  →  Airtable incoming webhook (automation trigger)
                                                  ↓
                                           contractor-bot.js (Airtable script)
                                                  ↓
                                   classifies intent via Claude proxy
                                                  ↓
                                new job / status update / list reply
                                                  ↓
              writes to Tasks table + replies via slack-notify worker
```

> The existing **slack-notify** Cloudflare worker
> (`https://slack-notify.kevinbrittain.workers.dev/`) already holds the
> `SLACK_BOT_TOKEN` and is used by the dashboard for assignment DMs. The
> contractor-bot reuses it — no new Slack app required.

## One-time setup

### 1. Redeploy the slack-notify worker

The worker source in `scripts/slack-automation/notify-slack-worker.js` now
handles two payload shapes (the original assignee-DM, and a new channel-reply
flow used by the contractor-bot). Kevin needs to redeploy the worker once for
this change to take effect.

If it's deployed via `wrangler`:
```bash
wrangler deploy
```
If it's pasted into the Cloudflare dashboard, paste the new contents of
`notify-slack-worker.js` into the worker source and click *Save and Deploy*.

Verify by sending a smoke-test channel reply:
```bash
curl -X POST https://slack-notify.kevinbrittain.workers.dev/ \
  -H "Content-Type: application/json" \
  -d '{"channel": "C09EMKREPJL", "text": "Smoke test from worker"}'
```

### 2. Add the Slack app's event subscription

The existing Slack app (the one whose bot token is in `slack-notify`) needs
permission to *receive* messages in `#property-management`, not just send
them. In https://api.slack.com/apps → your app → **OAuth & Permissions**:

- Add bot token scope: `channels:history` (probably already has `chat:write`
  and `users:read.email`).
- Reinstall the app to the workspace if scopes changed.

In **Event Subscriptions**:

- Toggle on.
- Request URL: paste the Airtable webhook URL (from step 3).
- Subscribe to bot event: `message.channels`.
- Save changes.

Make sure the bot is in `#property-management` (`/invite @<bot-name>`).

### 3. Airtable automation

In base `appnqjDpqDniH3IRl`, create a new automation:

- **Trigger**: *When webhook received*. Airtable gives you a URL — paste it
  into the Slack app's Event Subscription Request URL.
- **Action**: *Run a script*. Paste the full contents of `contractor-bot.js`
  into the editor.
- **Input variables** (map each one from the webhook payload):

  | Variable      | Webhook path                          |
  | ------------- | ------------------------------------- |
  | `messageText` | `event.text`                          |
  | `slackUserId` | `event.user`                          |
  | `slackTs`     | `event.ts`                            |
  | `threadTs`    | `event.thread_ts` (may be empty)      |
  | `channel`     | `event.channel`                       |

  > No Slack token here — the worker holds it.

- **Test** the automation with a sample payload before enabling.

### 4. Deploy & verify

Turn the automation on. Post a message in `#property-management` as one of the
contractors (or ask Kevin to simulate it). The bot should reply in thread.

## Logic reference

### Intent classification

Claude (Haiku) is called with the message text and returns exactly one of:

- `new_job`        — contractor is reporting a new maintenance job
- `status_update`  — contractor is reporting progress on an existing job
- `list_request`   — contractor is asking "what's on my list"
- `unknown`        — anything else → bot asks for clarification

### New job — field defaults

| Field               | Source                                                       |
| ------------------- | ------------------------------------------------------------ |
| Task Name           | AI-generated short title (3–7 words)                         |
| Description         | Full Slack message verbatim                                  |
| Status              | `Upcoming`                                                   |
| Priority            | AI-inferred → `Urgent` or `Not Urgent` (see mapping below)   |
| Assignee            | The contractor (resolved by email — Airtable maps it to the collaborator) |
| Properties          | AI-matched → Properties table                                |
| Maintenance Ticket  | `true`                                                       |
| Due Date            | unset                                                        |
| Time Estimate       | unset                                                        |

**Priority mapping** (the skill collapses two-tier → four-tier):

- Health/safety, no heating/hot water, leaks, structural, security, electrical,
  gas, fire, flooding, sewage → `Urgent`
- Everything else → `Not Urgent`

### Missing-info handling

| Situation                      | Bot reply                                                         |
| ------------------------------ | ----------------------------------------------------------------- |
| No property mentioned          | Asks for the property name                                        |
| Property ambiguous (>1 match)  | Lists the candidates, asks the contractor to reply with a number  |
| Message empty                  | Ignored                                                           |
| Unknown intent                 | Bot explains the three things it understands                      |

### Status update — parsed actions

Claude picks one of:

- `completed`   → `Status = Completed`
- `in_progress` → `Status = Today`
- `note`        → appends a timestamped note to the Notes field

Claude also picks *which* open job the update refers to, by comparing the
message against the contractor's active tasks. If it's unsure, the bot lists
the open jobs and asks the contractor to pick a number.

### List request — reply format

```
Gary, here's your list (3):
1. *Fix boiler - no hot water* — 55 Elmdon Place 🔴
2. *Replace front door lock* — 12 Woodcock Close
3. *Repair ceiling leak* — 41 Duckworth Road
```

`🔴` = `Urgent` priority.

## Why this shape

- **Single script, single automation.** Easier to maintain than separate
  automations per intent — the router is five lines.
- **Claude classifies intent instead of regex.** Contractors can write
  naturally ("done with the Elmdon job", "started the boiler one", "what am I
  doing today") without learning a syntax.
- **Assignee is the single source of truth.** No Contractor singleSelect, no
  dual-writing. `jobs.html` and the main Tasks OS both already filter on
  Assignee — this just matches them.
- **Cloudflare Worker + Slack + Airtable only.** Zero new services. Bot token
  and proxy URL are the only external configuration.

## Troubleshooting

| Symptom                                        | Likely cause                                                    |
| ---------------------------------------------- | --------------------------------------------------------------- |
| Bot doesn't respond at all                     | Automation off, or Slack event URL not verified                 |
| "Claude proxy error 5xx"                       | Worker is down — check `claude-proxy.kevinbrittain.workers.dev` |
| "Slack reply failed: invalid_auth"             | `slack-notify` worker hasn't been redeployed with the channel-reply branch |
| New jobs created with no property linked       | Property hint didn't match — contractor needs to include a name |
| Task assignee shows as empty                   | Contractor's email in `CONTRACTORS` doesn't match the Airtable collaborator email |
| Bot replies in channel instead of thread       | `threadTs` input variable not mapped from webhook payload       |

## Related files

- `scripts/slack-automation/contractor-bot.js` — the script itself
- `~/.claude/.../contractor-job-creator/SKILL.md` — Kevin's personal Claude
  skill for creating jobs by describing them in a conversation (unchanged
  except for the schema update)
- `os/tasks/jobs.html` — mobile contractor-facing view of open jobs
- `os/tasks/index.html` — main Tasks OS (shows all tasks including
  Maintenance-Ticket ones)
