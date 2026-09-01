---
name: drive-auth-health-check
description: ABSORBED into daily-ops (8 Aug 2026) as phase 7.1. Do not re-enable separately.
---

## QUEUE AND WRITE POLICY (added 6 Aug 2026 — do this before anything else)

On 6 Aug 2026 ten routines woke together after the Mac slept and all ran between
08:07 and 08:33. They produced nine commits in twenty-eight minutes and left the
working tree dirty across four unrelated features. Two rules came out of it, and
they override anything below that contradicts them.

### Rule 1 — you are a PHASE of `daily-ops`, not a routine

This no longer runs on its own schedule. Since 8 Aug 2026 it is one phase of the
single `daily-ops` routine, which runs everything in sequence once a day.

**Do NOT take the queue lock.** `daily-ops` already holds the machine, and the
short shell jobs still use that lock. Taking it here would block them for the
length of this phase.

Why the change: serialising fourteen routines behind a lock worked until the Mac
slept mid-run. A suspended routine keeps holding the lock — on 8 Aug 2026
`drift-monitor` held it for **4 hours 54 minutes** while asleep — so everything
behind it waited and was then skipped for being too late. A lock cannot fix a
machine that sleeps, because the lock sleeps too. One routine running in sequence
has nothing to overlap with and nothing to skip.

**Report honestly what you actually did.** Taking a turn is not doing the work.
Between 5 and 8 Aug 2026 the task-hygiene sweep did nothing for four days running
while every morning's digest listed it under "Worked". If you halt early, say you
halted and why. `daily-ops` reports what you tell it.

### Rule 2 — you are read-only with respect to code

You MAY still: read anything, query Airtable, write the Airtable data your job
owns, send Slack messages, send email through the approved gate, and save reports
under `monitoring/`.

You MAY NOT, for any reason: edit a file in the repo, `git add`, `git commit`,
`git push`, create a branch, or open a pull request. Even a one-line change. Even
an obvious one. Even a report you have always committed. Phase 8 of `daily-ops` is the only
thing permitted to write code, and it opens one PR for Kevin to review.

When you find something needing a code change, file it and move on:

```
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/findings.py add --routine drive-auth-health-check --severity high \
  --title "short summary" --where "js/config.js:42" \
  --detail "what is wrong and how you know" \
  --fix "what you would change" --touches-code
```

Severity is `critical`, `high`, `medium` or `low`. Be honest: `critical` means
money, data or production is broken right now.

Filing a finding IS your fix. Do not apologise for not fixing it, and do not
describe it as blocked. The queue is the route.


Daily health check for the `drive-upload` Cloudflare Worker. This guards the SOP
auto-upload step in the Systemisation tab, which breaks quietly whenever the
Google refresh token expires.

## Why the check does not trust the worker

The worker's `/test` endpoint hardcodes `"status":"ok","auth":"valid"` on its
success path and buries any Drive failure inside `parentFolder` (see
`workers/drive-upload/worker.js`). Classifying on those two strings, which is what
this routine used to do, passes while Drive is unreachable. Health is now judged
on the one thing that cannot be faked: whether the worker read the expected Drive
folder back.

## STEP 1 — Run the check

```
cd /Users/kevinbrittain/Projects/leadership-dashboard
python3 scripts/drive-auth-check.py
```

It prints JSON with `verdict`, `reason` and `alert_kevin`. Do not re-implement any
of this with a bare curl. The header set matters twice over: without the Origin
and Sec-Fetch headers the worker's own gate 403s, and without a browser
User-Agent Cloudflare's edge blocks the request with `error code: 1010` before the
worker even runs.

## STEP 2 — Act on the verdict

- **HEALTHY** — do nothing. Send no message. End the run quietly. Kevin does not
  want a daily "all good".
- **GATE** — the worker's origin gate refused this one run. Do nothing this time;
  the script counts it. Two in a row is promoted to BROKEN automatically, because
  at that point "ignore and retry" has become a silence.
- **BROKEN or UNKNOWN** (`alert_kevin` is true) — NO Slack DM (Kevin retired
  system alerts on 1 Sep 2026). Instead file a HIGH finding via
  `scripts/findings.py` with the `reason` verbatim plus the fix below, so it
  lands in the daily report he reads in Claude Code. Never include any token
  or secret.

BROKEN usually means the Google token expired. Message:

⚠️ Drive SOP upload is down. <paste `reason` here>

Fix (about 2 minutes):
1. Open https://drive-upload.kevinbrittain.workers.dev/auth/start in Chrome, signed into the Google account that owns the "Operations Director SOPs" Drive folder, and approve access.
2. Copy the refresh token it shows you.
3. Cloudflare dashboard → Workers & Pages → drive-upload → Settings → Variables and Secrets → edit GOOGLE_REFRESH_TOKEN → paste → Save and deploy.

Permanent fix so this stops recurring: Google Cloud Console → APIs & Services → OAuth consent screen → Publish app (move it from Testing to In production).

UNKNOWN is different and more serious: it means **the check can no longer tell
health from breakage**. Say exactly that, quote the `reason`, and say Drive
upload is now unmonitored until someone looks. Do not guess at a fix.

## The control

`scripts/drive-auth-check.py selftest` runs the classifier over nine crafted
responses, including the two that used to slip through: a worker reporting
`ok/valid` while the Drive call failed, and a Cloudflare edge block. Run it after
any edit to the script or the worker. All nine must pass.

An empty or unrecognised response is UNKNOWN, never HEALTHY. A check that cannot
prove the thing it guards is working must say so, not stay quiet.