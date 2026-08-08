---
name: drive-auth-health-check
description: Daily check that the Google Drive upload worker still works; Slack-DMs Kevin only when it is genuinely broken or the check itself has gone blind.
---

## QUEUE AND WRITE POLICY (added 6 Aug 2026 — do this before anything else)

On 6 Aug 2026 ten routines woke together after the Mac slept and all ran between
08:07 and 08:33. They produced nine commits in twenty-eight minutes and left the
working tree dirty across four unrelated features. Two rules came out of it, and
they override anything below that contradicts them.

### Rule 1 — take the queue lock first

```
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/job-queue.py acquire drive-auth-health-check --lease 45
```

- exit **0** — you hold the machine. Carry on.
- exit **3** — you are too late for this work to be useful. STOP. Do nothing else.
- exit **75** — another routine holds the machine. STOP. Do nothing else.

Never continue past a non-zero exit code. Running anyway is precisely the
behaviour this replaces. Release it as your last step, success or failure:

```
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/job-queue.py release drive-auth-health-check
```

If your run will take longer than 45 minutes, extend the lease as you go:
`python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/job-queue.py heartbeat drive-auth-health-check --lease 45`.

### Rule 2 — you are read-only with respect to code

You MAY still: read anything, query Airtable, write the Airtable data your job
owns, send Slack messages, send email through the approved gate, and save reports
under `monitoring/`.

You MAY NOT, for any reason: edit a file in the repo, `git add`, `git commit`,
`git push`, create a branch, or open a pull request. Even a one-line change. Even
an obvious one. Even a report you have always committed. `queue-fixer` is the only
scheduled routine permitted to write code, and it runs at 10:15 daily.

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
- **BROKEN or UNKNOWN** (`alert_kevin` is true) — send ONE Slack DM to Kevin
  (U08HW8F1MA8). Lead with the `reason` verbatim, then the fix below. Never
  include any token or secret.

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
