# Contractor task creation — paths, drift, and the unified architecture

## TL;DR

Three ways to create a contractor task today. They've drifted because each
path had its own copy of the rules. We've now unified them: the
contractor-bot Cloudflare Worker is the single source of truth, and every
other path posts to its `/create-task` endpoint instead of writing
Airtable directly.

## The three paths

### 1. Slack `#property-management` channel → contractor-bot worker

A contractor (Gary/Roy/Rob) or team member (Kevin/Mica/Ericamae) posts a
message in `#property-management`. The bot classifies intent, asks for
confirmation, and writes the task on "yes". Since the bot owns this path
end-to-end it's always been the most consistent.

The bot supports the same actions for both senders:
- **New job** — describe the work and (for team senders) say who it's
  for. Bot logs the task and DMs the contractor.
- **Status update** — "completed boiler at 55 Elmdon" or "started the
  garden clear-out". Bot fuzzy-matches the open job, confirms, and
  marks it complete / in progress. Comments are appended too.
- **Attach photo** — drop a photo in the channel; bot asks which open
  job to attach it to (or uses the thread-task mapping if you're in a
  thread the bot logged a task in).
- **List request** — "what's on my list?" returns the sender's open
  jobs (for contractors: their assigned work; for team members: every
  task they're Assignee or Collaborator on, which covers every
  contractor task).

### 2. The `contractor-job-creator` Claude skill — RETIRED

**Status: removed.** Used to be a local skill on each office team
member's machine. Caused the drift bug that triggered this whole
audit (skill on Mica's machine was stale → tasks misassigned to
Kevin → no Business field → not visible in Contractor Tasks tab).

Replacement: office team uses the Slack channel (path 1) or the
dashboard form (path 3). Zero local setup, no SKILL.md to keep in
sync, no bearer tokens to distribute. New customers / team members
get added to the Slack workspace and they're done — that's the
SaaS-ready shape.

The bot's `/create-task` HTTP endpoint stays as infrastructure for
future integrations (dashboard form refactor, partner integrations,
admin scripts) but no end-user skill now calls it directly.

### 2a. Generic task-creating skills — guardrails added

The local `airtable-task-creator` and `weekly-checkin-task-manager`
skills can also create tasks in the same Airtable Tasks table, and
without protection could create contractor tasks that bypass the
unified flow. Both SKILL.md files now carry an explicit contractor
guardrail at the top: if the assignee is Gary / Roy / Rob, STOP and
redirect the user to Slack `#property-management`.

### 3. The dashboard `Add Task` form (web app)

Manual entry through the Tasks OS. The user fills the fields by hand
including Assignee and Business, so this path doesn't suffer the same
auto-default problem. It's not under Slack-bot control today and isn't
in scope for this commit; future work would have it call the same
`/create-task` endpoint so the per-contractor business resolution +
auto-collaborator setup happens automatically.

## What the paths wrote (before this work)

| Field | Slack bot | Skill (RETIRED) | Dashboard form |
|---|---|---|---|
| Task Name | ✅ AI-generated | ✅ AI-generated | ✅ user-typed |
| Description | ✅ | ✅ | ✅ |
| Status | ✅ Upcoming | ✅ Upcoming (after Phase 2) | manual |
| Priority | ✅ Urgent / Not Urgent | ✅ Urgent / Not Urgent | manual |
| Assignee | ✅ Contractor email | ❌ Often Kevin's email | manual |
| Properties | ✅ Linked record | ✅ Linked record | manual |
| **Business** | ⚠️ Hard-coded Real Estate (now per-contractor) | ❌ Not set at all | manual (RE default) |
| Maintenance Ticket | ✅ true | ✅ true | manual (not asked) |
| Collaborators | ✅ Kevin/Mica/Erica | ❌ Not added | partial (creator + project) |
| Slack channel notify | ✅ via bot's reply | ❌ Skill posted SEPARATE notification (filtered now) | n/a |
| Contractor DM | ✅ via slack-notify worker | ❌ Not done | ✅ via slack-notify worker |

Skill column is the failure mode that produced the misassigned-task
incident — it's been removed.

## The unified architecture (now in place)

```
Slack #property-management  ──►  contractor-bot worker  ◄──  HTTP /create-task
                                                              (bearer-authenticated;
                                                               admin scripts /
                                                               future dashboard
                                                               form refactor)
dashboard "Add Task" form
(os/tasks/index.html)        ──►  Airtable directly  +  notifyAssigneeSlack
                                                          (slack-notify worker)
```

Two end-user paths today:
- **Slack** — office team and contractors all use the same channel.
  Best for natural-language descriptions and conversational follow-up.
- **Dashboard form** — power users adding from the web app. Triggers
  the existing assignee-DM via slack-notify, so the contractor still
  gets pinged.

The `/create-task` HTTP endpoint exists as infrastructure but is not
wired to any end-user surface today — it's the integration seam for
the future dashboard form refactor and any admin tooling.

The worker owns:

- Task name extraction (Sonnet)
- Property matching (token-based, case-insensitive)
- Per-contractor business resolution (Gary/Rob → RE; Roy → RE if
  property linked, OD if sales-vocabulary present, RE if ambiguous
  with a "no, ops" override hint)
- Assignee email-resolution
- Auto-collaborators (Kevin / Mica / Erica)
- Maintenance Ticket = true
- Channel notification post
- Contractor DM
- Confirmation prompts (for the Slack flow only — `/create-task`
  callers commit immediately because they've already collected the
  inputs from the user)

When the rules need to change, change them ONCE in `contractor-bot.js`
and every path picks the change up immediately.

## Office team onboarding — what to tell them

> "Use `#property-management` in Slack as your one-stop shop for
> contractor work, or the dashboard if you'd rather click through a
> form. The bot understands plain English in the channel:
>
> • **New job** — *'boiler broken at 55 Elmdon, give it to Gary'*.
>   Bot logs the task and DMs Gary.
> • **Mark something done** — *'completed the boiler at 55 Elmdon'*.
>   Bot fuzzy-matches one of the open jobs and asks you to confirm.
> • **Add a comment** — *'tenant says the heating is back on'*. Bot
>   asks which job, then posts the comment (visible on the dashboard
>   and DM'd to every collaborator).
> • **Attach a photo** — drop the photo in the channel; bot asks which
>   open job to attach it to.
>
> Or use the dashboard:
>
> • **Add Task** — click *Add Task* on the Tasks OS, set Assignee to
>   the contractor, leave Business as *Real Estate* (change to
>   *Operations Director* only if it's a non-property task for Roy).
>   Saving the task automatically DMs the contractor.
>
> Both paths produce the same end state. There's nothing to install
> on your machine."

That's the whole onboarding. No bearer tokens, no SKILL.md to copy,
no `~/.claude/` rituals. Multi-user / multi-customer ready.

## Whoever onboards a new office team member

Two code-side updates:

1. Their email goes into the `TEAM_COLLABORATOR_EMAILS` array in
   `contractor-bot.js` so they get auto-added as a collaborator on
   every bot-created contractor task.
2. Their email goes into the `TEAM_MEMBERS` map in `contractor-bot.js`
   so the bot recognises their Slack messages.

Then bot redeploy. That's it — no skill installs, no bearer tokens.

Long-term, both should be driven by an Airtable Team Members table
with an `internal` / `contractor` flag — that's a future cleanup
already on the parked list.

## Two repaired tasks (this commit)

- `reccTZF9yVPDyzRoR` "Inspect crumbling external wall — urgent
  (safety)" — was assigned to Kevin, no Business set. Reassigned
  to Gary, Business set to Real Estate.
- `recdV45Rt9Peleq0q` "Clear waste in front garden" — was assigned
  to Kevin (Business already correct). Reassigned to Gary.

Both should now appear under Gary's bucket in the Contractor Tasks
tab on next dashboard refresh.
