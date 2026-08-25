# Inbound Messages Sweep — 2026-08-24

Slot: 09:00 scheduled run.

## iMessage

- Scan result: BROKEN — authorization denied (macOS Full Disk Access permission not granted to this process)
- Candidates found: 0 (scan could not run)
- Tasks created: 0
- Watermark advanced: no (scan broken; do not advance past unseen messages)

## Step 2b: self-handled check

- Sent check also broken (same auth error — both scan and sent read the Messages database)
- Open iMessage tasks checked via Airtable: 6 remain open
- Control check (total iMessage tasks incl. completed): 9 — field match confirmed working
- Tasks auto-closed: 0 (could not verify sent messages)

## Action needed

iMessage sweep has been broken at this slot. The process running this scheduled job lacks macOS Full Disk Access to read ~/Library/Messages/chat.db. This has likely affected all scheduled runs — check whether this has been working in any recent slot.

To fix: grant Full Disk Access to the process (Terminal, Claude desktop app, or launchd agent) that runs this scheduled job, then verify with `python3 scripts/imessage-sweep.py scan`.
