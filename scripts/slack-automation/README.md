# Contractor Slack Bot — Setup

End-to-end: contractors post in `#property-management` → Slack forwards the
message to a Cloudflare Worker → bot reads/writes Airtable via REST API and
replies in thread. **No Airtable automations, no Make / n8n / Zapier** —
Airtable stays a clean database. Everything lives in Cloudflare workers.

## Architecture

```
Slack Events API  →  contractor-bot Cloudflare Worker
                            │
                            ├── Claude proxy worker         (intent classification)
                            ├── Airtable REST API            (read/write tasks)
                            └── slack-notify worker          (post reply in thread)
```

Three Cloudflare workers in total, all self-owned:

| Worker          | URL                                              | Holds                                  |
| --------------- | ------------------------------------------------ | -------------------------------------- |
| `claude-proxy`  | `claude-proxy.kevinbrittain.workers.dev`         | Anthropic API key                      |
| `slack-notify`  | `slack-notify.kevinbrittain.workers.dev`         | `SLACK_BOT_TOKEN`                      |
| `contractor-bot`| `contractor-bot.kevinbrittain.workers.dev` (new) | `AIRTABLE_PAT`, `SLACK_SIGNING_SECRET` |

## Supabase migration path

When the SaaS migration happens, port `contractor-bot.js` into
`supabase/functions/contractor-bot/index.ts`:

1. Replace the `airtable()` calls with Supabase client queries on the
   equivalent tables/columns.
2. Replace `SLACK_NOTIFY_URL` with the Supabase Edge Function URL for the
   notify equivalent.
3. Move secrets to `supabase secrets set`.

Slack signature verification, Claude proxy call, intent routing, mrkdwn
replies — all portable as-is.

## One-time setup

### 1. Generate an Airtable Personal Access Token

1. Open https://airtable.com/create/tokens.
2. Click **Create new token**.
3. Name: `contractor-bot`.
4. Scopes: tick **`data.records:read`** and **`data.records:write`**.
5. Access: tick the **Operations Director** base (`appnqjDpqDniH3IRl`).
6. Click **Create token**, copy the value (starts `pat…`). You can't see it
   again after closing — paste somewhere safe.

### 2. Get the Slack signing secret

1. https://api.slack.com/apps → your **Operations Director** app.
2. Left sidebar → **Basic Information**.
3. Scroll to **App Credentials** → **Signing Secret** → click **Show** →
   copy the value.

### 3. Create the Cloudflare worker

1. https://dash.cloudflare.com → **Workers & Pages** → **Create**.
2. Choose **Hello World** template.
3. Name: **`contractor-bot`**.
4. **Deploy** the placeholder.
5. Click **Edit code**, `Cmd+A` / **Delete**, paste the entire contents of
   `scripts/slack-automation/contractor-bot.js`.
6. **Save and deploy**.

### 4. Add the secrets

Same worker → **Settings** → **Variables and Secrets**:

| Type   | Name                  | Value                                |
| ------ | --------------------- | ------------------------------------ |
| Secret | `AIRTABLE_PAT`        | the `pat…` token from step 1         |
| Secret | `SLACK_SIGNING_SECRET`| the signing secret from step 2       |

Save each. The worker auto-restarts.

### 5. Add the Slack scopes (if not done already)

Slack app → **OAuth & Permissions** → **Bot Token Scopes**, add:
- `channels:history` (public-channel messages — the worker doesn't actually
  need this for `#property-management` since it's private, but include it
  in case you ever switch to a public channel)
- `groups:history` (private-channel messages — required for
  `#property-management`)

If you added scopes, click **Reinstall to Workspace** at the top, copy the
new bot token, and update `SLACK_BOT_TOKEN` in the **slack-notify** worker
(not contractor-bot — it doesn't hold the bot token).

### 6. Wire Slack Event Subscriptions

Slack app → **Event Subscriptions**:

1. Toggle **Enable Events** to **On**.
2. **Request URL**: `https://contractor-bot.kevinbrittain.workers.dev/`
   - Slack pings the URL with a `url_verification` payload — the worker
     responds with the challenge value automatically. Should turn green
     ("Verified ✓") within a few seconds.
3. **Subscribe to bot events** → click **Add Bot User Event** and add
   **both**:
   - `message.channels`  (public channels)
   - `message.groups`    (private channels)
4. **Save Changes** at the bottom.

### 7. Verify with a real message

Have one of the contractors (or simulate by posting under a contractor's
account, if you have access) send a message in `#property-management`
like:

> Boiler at 55 Elmdon has stopped working — no hot water

Within 5–15 seconds, the bot should reply in thread:

> ✅ Logged, Gary.
> *Fix boiler — no hot water/heating*
> 📍 55 Elmdon Place
> ⚡ Priority: Urgent
> Added to your list.

Check the Tasks OS — there's a new Maintenance-Ticket task assigned to the
contractor, with the property linked.

## Logic reference

### Intent classification

Claude (Haiku) is called with the message text and returns exactly one of:

- `new_job`        — contractor is reporting a new maintenance job
- `status_update`  — contractor is reporting progress on an existing job
- `list_request`   — contractor is asking "what's on my list"
- `unknown`        — anything else → bot asks for clarification

### New job — field defaults

| Field               | Source                                                            |
| ------------------- | ----------------------------------------------------------------- |
| Task Name           | AI-generated short title (3–7 words)                              |
| Description         | Full Slack message verbatim                                       |
| Status              | `Upcoming`                                                        |
| Priority            | AI-inferred → `Urgent` or `Not Urgent` (see mapping below)        |
| Assignee            | The contractor (resolved by email — Airtable maps it to the user) |
| Properties          | AI-matched against Properties table                               |
| Maintenance Ticket  | `true`                                                            |
| Due Date            | unset                                                             |
| Time Estimate       | unset                                                             |

**Priority mapping:**

- Health/safety, no heating/hot water, leaks, structural, security,
  electrical, gas, fire, flooding, sewage → `Urgent`
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
message against the contractor's active tasks. If it's unsure, the bot
lists the open jobs and asks the contractor to pick a number.

### List request — reply format

```
Gary, here's your list (3):
1. *Fix boiler - no hot water* — 55 Elmdon Place 🔴
2. *Replace front door lock* — 12 Woodcock Close
3. *Repair ceiling leak* — 41 Duckworth Road
```

`🔴` = `Urgent` priority.

### Security: Slack signature verification

Every request is verified with HMAC-SHA256 over `v0:<timestamp>:<rawBody>`
using `SLACK_SIGNING_SECRET`. Requests older than 5 minutes are rejected
(replay protection). Anyone POSTing to the worker without a valid
signature gets a `401`. Constant-time comparison guards against timing
attacks.

## Troubleshooting

| Symptom                                        | Likely cause                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| Slack URL verification fails                   | `SLACK_SIGNING_SECRET` not set, or wrong value                        |
| Bot doesn't respond at all                     | Event Subscriptions off, or scopes missing (`groups:history`)         |
| 401 Invalid signature in worker logs           | `SLACK_SIGNING_SECRET` mismatch — re-copy from Slack app              |
| Airtable 403 in worker logs                    | `AIRTABLE_PAT` missing scopes or wrong base                           |
| "Claude proxy 5xx"                             | claude-proxy worker is down                                           |
| New jobs created with no property linked       | Property hint didn't match any Property record name                   |
| Task assignee shows as empty                   | Contractor's email in `CONTRACTORS` doesn't match the Airtable user   |
| Bot replies in channel instead of thread       | `event.thread_ts` was empty — the reply is now in a new thread under  |
|                                                | the original message (correct behaviour)                              |

## Related files

- `scripts/slack-automation/contractor-bot.js` — the worker source
- `scripts/slack-automation/notify-slack-worker.js` — slack-notify worker
  source (used for outbound replies)
- `~/.claude/.../contractor-job-creator/SKILL.md` — Kevin's personal Claude
  skill for creating jobs by describing them in conversation
- `os/tasks/index.html` — main Tasks OS (Contractor Tasks tab shows the
  same Maintenance-Ticket records)
