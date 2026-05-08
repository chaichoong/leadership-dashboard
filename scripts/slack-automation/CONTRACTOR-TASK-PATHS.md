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

### 2. The `contractor-job-creator` Claude skill (Code / Co-Work)

Someone on the office team — most often Mica or Erica — describes a
task to Claude Code or Co-Work, and the skill creates the task. **This
is where the drift came from.** Each user has a local copy of the
SKILL.md in `~/.claude/skills/`; updating one machine doesn't update
the others. Two specific failures resulted:

- The skill wrote tasks with **Assignee = Kevin** when the user didn't
  explicitly name a contractor (or the local SKILL.md was a stale
  pre-fix version).
- The skill never wrote the `Business` field at all, so contractor
  tasks landed without the Real Estate link, which broke filters and
  reports downstream.

Both issues showed up on real records — see the two repaired tasks at
`reccTZF9yVPDyzRoR` and `recdV45Rt9Peleq0q`.

### 3. The dashboard `Add Task` form (web app)

Manual entry through the Tasks OS. The user fills the fields by hand
including Assignee and Business, so this path doesn't suffer the same
auto-default problem. It's not under Slack-bot control today and isn't
in scope for this commit; future work would have it call the same
`/create-task` endpoint so the per-contractor business resolution +
auto-collaborator setup happens automatically.

## What the three paths wrote (before this work)

| Field | Slack bot | Skill (Mica's stale copy) | Dashboard form |
|---|---|---|---|
| Task Name | ✅ AI-generated | ✅ AI-generated | ✅ user-typed |
| Description | ✅ | ✅ | ✅ |
| Status | ✅ Upcoming | ✅ Upcoming (after Phase 2) | manual |
| Priority | ✅ Urgent / Not Urgent | ✅ Urgent / Not Urgent | manual |
| Assignee | ✅ Contractor email | ❌ Often Kevin's email | manual |
| Properties | ✅ Linked record | ✅ Linked record | manual |
| **Business** | ⚠️ Hard-coded Real Estate | ❌ Not set at all | manual |
| Maintenance Ticket | ✅ true | ✅ true | manual |
| Collaborators | ✅ Kevin/Mica/Erica | ❌ Not added | manual |
| Slack channel notify | ✅ via bot's reply | ❌ Skill posts a SEPARATE notification (filtered out by the bot now) | n/a |
| Contractor DM | ✅ via slack-notify worker | ❌ Not done | n/a |

Two columns of red-cross is exactly what produced the misassigned-task
incident.

## The unified architecture (now in place)

```
Slack #property-management  ──►  contractor-bot worker
                                       ▲
                                       │ POST /create-task
                                       │ Authorization: Bearer <INTERNAL_BEARER>
                                       │
contractor-job-creator skill  ─────────┘
(Mica / Erica / Kevin running                     ▲
 Claude Code or Co-Work)                          │  (future)
                                                  │
                          dashboard "Add Task" ───┘
                          form (os/tasks/index.html)
```

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

## Migration path for office team's local skill installs

The repo has the canonical SKILL.md at:

```
scripts/slack-automation/contractor-job-creator.SKILL.md
```

After pulling latest, each office team member runs:

```bash
cp ~/Projects/leadership-dashboard/scripts/slack-automation/contractor-job-creator.SKILL.md \
   ~/.claude/skills/contractor-job-creator/SKILL.md
```

(Kevin's local file is at a different path because of how Claude
Co-Work stores plugin skills — adjust the destination accordingly if
needed.)

Each user also needs the bearer token in `~/.contractor-bot-bearer.txt`:

```bash
echo "<paste-bearer-from-kevin>" > ~/.contractor-bot-bearer.txt
chmod 600 ~/.contractor-bot-bearer.txt
```

Distribute the bearer via password manager (1Password etc.), not via
Slack/email.

## Whoever onboards a new office team member

Three things to do:

1. Their email goes into the `TEAM_COLLABORATOR_EMAILS` array in
   `contractor-bot.js` so they get auto-added as a collaborator on
   every contractor task.
2. Their email goes into the `TEAM_MEMBERS` map in `contractor-bot.js`
   so the bot recognises their Slack messages.
3. They get the canonical SKILL.md and the bearer token (steps above).

Long-term, all three should be driven by an Airtable Team Members table
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
