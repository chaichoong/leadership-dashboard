---
name: contractor-job-creator
description: Add a contractor maintenance job by POSTing to the contractor-bot Cloudflare Worker. Use when Kevin (or anyone on the office team) says "add a job", "new contractor job", "log a maintenance job", "add to the job list", describes work that needs doing at a property, or mentions a contractor task. Bot handles property matching, business resolution, contractor assignment, channel post, and contractor DM — this skill is just a thin client.
---

# Contractor Job Creator

> ⚠️ **CANONICAL VERSION** — this is the source of truth committed to the
> repo at `scripts/slack-automation/contractor-job-creator.SKILL.md`.
> The version in `~/.claude/skills/contractor-job-creator/SKILL.md`
> on each office team member's machine should match this file.
> Sync ritual at the bottom of this document.

## What this skill does

Posts a single HTTP request to the contractor-bot Cloudflare Worker.
The worker handles everything — extracting the task name, matching the
property, picking the right business, assigning the contractor, posting
to `#property-management`, DMing the contractor. **This skill writes
nothing to Airtable directly.** That's deliberate — it means there's
ONE place that owns the rules (the bot), and any changes to those rules
take effect for everyone instantly. No more "Mica's machine has an
older version of the skill".

## Endpoint

```
POST https://contractor-bot.kevinbrittain.workers.dev/create-task
Authorization: Bearer <INTERNAL_BEARER>
Content-Type: application/json
```

## Bearer token (one-time setup per machine)

The bearer token lives at `~/.contractor-bot-bearer.txt`. If you don't
have this file yet, ask Kevin for the value. To install:

```bash
echo "<paste-bearer-from-kevin>" > ~/.contractor-bot-bearer.txt
chmod 600 ~/.contractor-bot-bearer.txt
```

The skill reads this file via `cat` before each POST. Don't commit it
to git, don't paste it into Slack — keep it local.

## Workflow

### Step 1 — Collect what's needed

Ask Kevin (or whoever is using the skill) for:
- **Description** — natural language description of the work, including
  the property and the fault. Example: *"The boiler at 55 Elmdon Place
  has stopped working, no hot water — tenant says it's been off all
  morning"*.
- **Contractor first name** — Gary, Roy, or Rob.
- **(Optional) Business override** — only ask if the user volunteers
  it. Otherwise the bot resolves it: Gary/Rob → Real Estate;
  Roy + property → Real Estate; Roy + sales/customer/lead vocabulary
  → Operations Director; Roy + ambiguous → Real Estate (with a
  prompt to override in the bot's confirmation message).

If the user doesn't say which contractor, ask them directly. Don't
guess. Don't default to Kevin.

### Step 2 — Read the bearer token

```bash
BEARER="$(cat ~/.contractor-bot-bearer.txt 2>/dev/null)"
if [ -z "$BEARER" ]; then
  echo "Bearer token not found at ~/.contractor-bot-bearer.txt — ask Kevin." >&2
  exit 1
fi
```

### Step 3 — POST to the worker

```bash
curl -sS -X POST \
  https://contractor-bot.kevinbrittain.workers.dev/create-task \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  -d '{
    "description":       "<the user-typed description>",
    "assigneeFirstName": "<Gary|Roy|Rob>",
    "actorName":         "<who is using the skill, e.g. Mica Albovias>",
    "actorEmail":        "<their email, e.g. micaa.work@gmail.com>"
  }'
```

`actorName` and `actorEmail` are optional but useful — they let the
bot label the channel post with who created the task ("Logged for
Gary (added by Mica)").

### Step 4 — Surface the response to the user

The bot returns JSON. Show it in plain English:

| Response | Tell the user |
|---|---|
| `{"ok": true, "taskName": "...", "propertyName": "...", ...}` | "Logged ✅ — *<taskName>* at <propertyName>, assigned to <assigneeName>, business: <businessName>, priority: <priority>." |
| `{"ok": false, "error": "...assigneeFirstName..."}` | Ask which contractor. Retry. |
| `{"ok": false, "error": "...No property matched..."}` or `"...candidates..."` | Show the candidates if any. Ask the user to be more specific. Retry. |
| `{"ok": false, "error": "...INTERNAL_BEARER..."}` | Worker isn't configured yet — tell Kevin. |
| `{"ok": false, "error": "Unauthorised..."}` | Bearer file is wrong/missing — tell user to refresh from Kevin. |
| Any other 5xx | Show the error to the user. Don't retry automatically. |

### Step 5 — Don't double-write

The bot already posts to `#property-management` and DMs the contractor.
**Do not separately post a Slack notification** from the skill — that
caused the "duplicate task" issue we fixed previously. The bot's filter
even drops messages that look like skill notifications, so any extra
post would be silently ignored *and* confusing.

## Why this design

Until recently the skill wrote tasks directly to Airtable, and the
office team's local copies of the skill drifted out of sync — the
result was tasks showing up assigned to Kevin instead of the named
contractor, missing the Real Estate business, etc. Now there's one
source of truth (the bot) and the skill is a 30-line client. To fix
business rules, you change the bot once and every entry point picks
it up.

## Sync ritual

When this file changes in the repo, every office team member needs to
re-copy it to their local skills directory:

```bash
cp ~/Projects/leadership-dashboard/scripts/slack-automation/contractor-job-creator.SKILL.md \
   ~/.claude/skills/contractor-job-creator/SKILL.md
# Or wherever your local skills directory is — check ~/.claude/skills/
```

Run this after pulling latest. If you want to be paranoid, restart
Claude Code afterwards so the skill is reloaded from disk.

## Related

- `scripts/slack-automation/contractor-bot.js` — the worker that owns
  the rules
- `scripts/slack-automation/notify-slack-worker.js` — separate
  Cloudflare worker for assignee DMs from the dashboard
- `os/tasks/index.html` — Tasks OS, where the Contractor Tasks tab
  filters by Assignee identity (case-insensitive, post-audit)
