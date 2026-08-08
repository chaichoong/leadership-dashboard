---
name: post-manager-weekly
description: Weekly Monday 8:30am check for scanned post PDFs. Processes any found through the split-and-email pipeline.
---

## QUEUE AND WRITE POLICY (added 6 Aug 2026 — do this before anything else)

On 6 Aug 2026 ten routines woke together after the Mac slept and all ran between
08:07 and 08:33. They produced nine commits in twenty-eight minutes and left the
working tree dirty across four unrelated features. Two rules came out of it, and
they override anything below that contradicts them.

### Rule 1 — take the queue lock first

```
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/job-queue.py acquire post-manager-weekly --lease 45
```

- exit **0** — you hold the machine. Carry on.
- exit **3** — you are too late for this work to be useful. STOP. Do nothing else.
- exit **75** — another routine holds the machine. STOP. Do nothing else.

Never continue past a non-zero exit code. Running anyway is precisely the
behaviour this replaces. Release it as your last step, success or failure:

```
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/job-queue.py release post-manager-weekly
```

If your run will take longer than 45 minutes, extend the lease as you go:
`python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/job-queue.py heartbeat post-manager-weekly --lease 45`.

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
python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/findings.py add --routine post-manager-weekly --severity high \
  --title "short summary" --where "js/config.js:42" \
  --detail "what is wrong and how you know" \
  --fix "what you would change" --touches-code
```

Severity is `critical`, `high`, `medium` or `low`. Be honest: `critical` means
money, data or production is broken right now.

Filing a finding IS your fix. Do not apologise for not fixing it, and do not
describe it as blocked. The queue is the route.


Check the Google Drive Post Inbox folder ("/Users/kevinbrittain/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/My Drive/Post Inbox") for unprocessed PDF files. If none are found, report "No new scanned post to process" and exit.

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
   e. For each group, note: sender name, summary of the document, recommended action, urgency (high/medium/low).

4. Split the PDF into individual files using Python pypdf:
   - Output to "/Users/kevinbrittain/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/My Drive/Post Inbox/Split/"
   - One PDF per sender/document group
   - Use a short, filesystem-safe filename: `<sender>_<short-summary>.pdf`

5. Email each split PDF to kevinbrittain@gmail.com via Mail.app AppleScript:
   ```
   osascript -e 'tell application "Mail"
       set newMessage to make new outgoing message with properties {subject:"POST: SENDER - SUMMARY", content:"This document was scanned from physical post on DATE.\n\nSender: SENDER\nSummary: SUMMARY\nRecommended action: ACTION\nUrgency: URGENCY\n\nThe PDF is attached. This email was generated by the post-manager skill.", visible:false}
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

7. Report a summary: source filename, number of documents found, number of emails sent, and a list of each document (sender, summary, urgency).

## OCR helper

`bin/ocr_pdf.swift` is a self-contained Swift script that renders each PDF page via PDFKit and OCRs it via the Vision framework. Requires only the Xcode Command Line Tools (already present on this Mac — `xcode-select -p` returns `/Library/Developer/CommandLineTools`). No Homebrew, no Tesseract, no poppler. If a future macOS update breaks it, fall back to installing poppler with Homebrew so the Read tool's native PDF rendering works again.