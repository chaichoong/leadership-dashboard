---
name: post-manager-weekly
description: ABSORBED into daily-ops (8 Aug 2026) as phase 6b, which runs it on Mondays. Do not re-enable separately.
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
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/findings.py add --routine post-manager-weekly --severity high \
  --title "short summary" --where "js/config.js:42" \
  --detail "what is wrong and how you know" \
  --fix "what you would change" --touches-code
```

Severity is `critical`, `high`, `medium` or `low`. Be honest: `critical` means
money, data or production is broken right now.

Filing a finding IS your fix. Do not apologise for not fixing it, and do not
describe it as blocked. The queue is the route.


## STEP 0 — Is the pipe being fed? (run this FIRST, every time)

```
cd /Users/kevinbrittain/Projects/leadership-dashboard
python3 scripts/post-inbox-absence.py
```

- **exit 0** — post was scanned recently. Carry on below.
- **exit 1** — nothing has been scanned for two weeks or more. **Put the printed
  message at the TOP of your report and DM it to Kevin.** This is the finding,
  not a footnote: an empty inbox is only good news when somebody is feeding it.
- **exit 2** — the folder is missing or unreadable. Report that you could not
  tell. Never report "no post" on an exit 2.

Why this comes first (16 Aug 2026, finding 20260818-post-manager-weekly-214):
this phase fires when a PDF appears in Google Drive, and post arriving in the
real world does not put one there. From 3 Jul to 16 Aug it ran every week and
said "No new scanned post to process" every week — true about the folder,
silent about the post. The scan on 16 Aug held 29 documents dated 26 Jun to
30 Jul, and by then a 7-day Utilita demand, a 14-day Companies House strike-off
window, a 14-day charging-order reconsideration window and a 3 Aug BW Legal
deadline had all closed unread.

## STEP 1 — Process what is there

Check the Google Drive Post Inbox folder ("/Users/kevinbrittain/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/My Drive/Post Inbox") for unprocessed PDF files. If none are found, report "No new scanned post to process" **together with the STEP 0 result** — never on its own — and exit.

If PDFs are found, process each one through this pipeline:

1. Install dependencies if needed: `python3 -c "from pypdf import PdfReader" 2>/dev/null || python3 -m pip install pypdf --quiet --break-system-packages`

2. Ensure subfolders exist: `mkdir -p "/Users/kevinbrittain/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/My Drive/Post Inbox/Processed" "/Users/kevinbrittain/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/My Drive/Post Inbox/Split"`

3. For each PDF in the Post Inbox folder ("/Users/kevinbrittain/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/My Drive/Post Inbox", ignore the Processed/ and Split/ subfolders):
   a. **First try the Read tool** with the `pages` parameter (max 20 pages per request) — this gives you visual access to letterheads, logos, and layout. If the Read tool fails with a `pdftoppm`/poppler error, that's expected on this Mac.
   b. **If the Read tool fails OR the PDF is text-empty (scanned)**, fall back to the bundled Swift OCR helper. It uses the macOS Vision framework so no `brew install` is required:
      ```
      swift ~/.claude/scheduled-tasks/post-manager-weekly/bin/ocr_pdf.swift "<PDF path>" > /tmp/post_ocr.txt
      ```
      Then read `/tmp/post_ocr.txt`. Pages are delimited by `===== PAGE n =====` markers.
   c. Identify senders from the OCR'd text (look for letterheads, return addresses, company names, account numbers, reference codes).
   d. Group consecutive pages belonging to the same sender/document.
   e. For each group, note: sender name, summary of the document, recommended action, urgency (high/medium/low), and **the deadline**.

      The deadline is the part that has actually cost money. Read the letter for
      any date by which something must happen: a court or hearing date, a summons
      return date, a "pay by", a filing or response window, or a relative one
      ("within 14 days of this notice" — resolve it against the letter's own
      date). Record it as `YYYY-MM-DD`, or `none` when the letter genuinely names
      no date. Do NOT use the date the letter was written, and do NOT guess.

      Why this line exists: from 3 Jul to 24 Aug 2026 several dated response
      windows in scanned post closed unread. The dates were in the letters.
      Nothing ever lifted them out of the prose, so no task was ever dated and
      nothing chased them. (Specific instances live in the private brain, not
      in this public file.)

4. Split the PDF into individual files using Python pypdf:
   - Output to "/Users/kevinbrittain/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/My Drive/Post Inbox/Split/"
   - One PDF per sender/document group
   - Use a short, filesystem-safe filename: `<sender>_<short-summary>.pdf`

5. Email each split PDF to kevinbrittain@gmail.com via Mail.app AppleScript:
   ```
   osascript -e 'tell application "Mail"
       set newMessage to make new outgoing message with properties {subject:"POST: SENDER - SUMMARY", content:"This document was scanned from physical post on DATE.\n\nSender: SENDER\nSummary: SUMMARY\nRecommended action: ACTION\nUrgency: URGENCY\nDeadline: YYYY-MM-DD\n\nThe PDF is attached. This email was generated by the post-manager skill.", visible:false}
       tell newMessage
           set sender to "kevinbrittain@gmail.com"
           make new to recipient at end of to recipients with properties {address:"kevinbrittain@gmail.com"}
           make new attachment with properties {file name:POSIX file "PDF_PATH"} at after the last paragraph
       end tell
       send newMessage
   end tell'
   ```
   Wait 2 seconds between each email.

6. Archive: move the original PDF to "/Users/kevinbrittain/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/My Drive/Post Inbox/Processed/" and delete the contents of "/Users/kevinbrittain/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/My Drive/Post Inbox/Split/"

7. Report a summary: source filename, number of documents found, number of emails sent, and a list of each document (sender, summary, urgency, deadline).

   Put every document carrying a deadline inside the next 14 days at the TOP of
   the report, with its date, and say so in one line at the very start. A
   deadline buried at position nine of a list of twelve is the same as no
   deadline at all.

   The `Deadline:` line in the email is not decoration: it is the one place
   the date survives outside the PDF's prose, and the enforcement chain reads
   it (BUILT 25 Aug 2026). Inbound triage — the inbound-email-triage skill and
   the Inbound Comms page both — writes it into the task's Due Date and ticks
   Hard Deadline, which the auto-rescheduler never rolls. From there
   scripts/loop-health.py reports it under NOT MOVING from 3 days out
   (rule "deadline"), and the daily `hard-deadline-passed-still-open`
   invariant in scripts/check-data-invariants.py fails the sweep if the date
   passes with the task still open. Omit the line and that whole chain goes
   quiet — which is exactly what happened before 25 Aug 2026.

   You still MUST NOT pay anything, contact a council, or answer a court. Tier 1
   work is prepared for Kevin's approval, never carried out.

## OCR helper

`bin/ocr_pdf.swift` is a self-contained Swift script that renders each PDF page via PDFKit and OCRs it via the Vision framework. Requires only the Xcode Command Line Tools (already present on this Mac — `xcode-select -p` returns `/Library/Developer/CommandLineTools`). No Homebrew, no Tesseract, no poppler. If a future macOS update breaks it, fall back to installing poppler with Homebrew so the Read tool's native PDF rendering works again.