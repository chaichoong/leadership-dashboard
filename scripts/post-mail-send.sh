#!/bin/bash
# Send ONE scanned-post document to Kevin through Mail.app, and fail loudly.
#
# WHY THIS EXISTS (finding 20260929-phase-3-660). The post-manager skill ran a
# bare `osascript -e 'tell application "Mail" ... send'` per document. Mail is
# not running on a freshly woken Mac, so AppleScript launches it and the FIRST
# send fails while it boots. Nothing checked the exit code, nothing retried,
# and step 6 moved the source PDF to Processed/ regardless — so the document
# was archived as handled with no email anywhere.
#
# Three rules, all here rather than in prose:
#   1. Mail is up BEFORE the first send, not as a side effect of it.
#   2. The exit code is read, and a failed send is retried twice.
#   3. A send that never succeeded exits non-zero, so the caller must not
#      archive the source PDF.
#
# Usage: post-mail-send.sh <pdf-path> <subject> <body-file>
# Exit:  0 sent (says which attempt), 1 every attempt failed, 2 bad arguments.
#
# Test seams (used by tests/post-mail-send.test.js, never in production):
#   POST_MAIL_OSASCRIPT  command standing in for osascript
#   POST_MAIL_ISRUNNING  command that exits 0 when Mail is up
#   POST_MAIL_OPEN       command standing in for `open -ga Mail`
#   POST_MAIL_WAIT_S     seconds between attempts (default 3)
#   POST_MAIL_BOOT_S     seconds to wait for Mail to come up (default 30)
set -u

PDF="${1:-}"
SUBJECT="${2:-}"
BODY_FILE="${3:-}"
TO="kevinbrittain@gmail.com"

if [ -z "$PDF" ] || [ -z "$SUBJECT" ] || [ -z "$BODY_FILE" ]; then
  echo "POST MAIL REFUSED: need <pdf-path> <subject> <body-file>" >&2
  exit 2
fi
# A missing attachment is a refusal, not a mail with nothing on it: the PDF is
# the whole point of the message.
if [ ! -f "$PDF" ]; then
  echo "POST MAIL REFUSED: no PDF at $PDF" >&2
  exit 2
fi
if [ ! -f "$BODY_FILE" ]; then
  echo "POST MAIL REFUSED: no body file at $BODY_FILE" >&2
  exit 2
fi

OSASCRIPT="${POST_MAIL_OSASCRIPT:-/usr/bin/osascript}"
ISRUNNING="${POST_MAIL_ISRUNNING:-}"
OPEN_MAIL="${POST_MAIL_OPEN:-}"
WAIT_S="${POST_MAIL_WAIT_S:-3}"
BOOT_S="${POST_MAIL_BOOT_S:-30}"
ATTEMPTS=3

mail_running() {
  if [ -n "$ISRUNNING" ]; then
    $ISRUNNING
  else
    /usr/bin/pgrep -x Mail >/dev/null 2>&1
  fi
}

# STEP 1 — Mail is up before anything is sent.
if ! mail_running; then
  echo "POST MAIL: Mail is not running; opening it and waiting up to ${BOOT_S}s." >&2
  if [ -n "$OPEN_MAIL" ]; then $OPEN_MAIL; else /usr/bin/open -ga Mail; fi
  waited=0
  while [ "$waited" -lt "$BOOT_S" ]; do
    if mail_running; then break; fi
    sleep 1
    waited=$((waited + 1))
  done
  if mail_running; then
    echo "POST MAIL: Mail came up after ${waited}s." >&2
  else
    # Not fatal on its own — AppleScript can still launch it — but it is said,
    # because a silent boot wait is what made this read as a hang.
    echo "POST MAIL: Mail still not up after ${BOOT_S}s; sending anyway." >&2
  fi
fi

BODY="$(cat "$BODY_FILE")"

# STEP 2 — send, read the exit code, retry twice.
attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  if "$OSASCRIPT" \
      -e 'on run {theSubject, theBody, theTo, thePath}' \
      -e '  tell application "Mail"' \
      -e '    set newMessage to make new outgoing message with properties {subject:theSubject, content:theBody, visible:false}' \
      -e '    tell newMessage' \
      -e '      make new to recipient at end of to recipients with properties {address:theTo}' \
      -e '      make new attachment with properties {file name:(POSIX file thePath)} at after the last paragraph' \
      -e '    end tell' \
      -e '    send newMessage' \
      -e '  end tell' \
      -e 'end run' \
      "$SUBJECT" "$BODY" "$TO" "$PDF" >/dev/null 2>/tmp/post-mail-send.err; then
    echo "POST MAIL SENT on attempt ${attempt}/${ATTEMPTS}: $SUBJECT"
    exit 0
  fi
  echo "POST MAIL ATTEMPT ${attempt}/${ATTEMPTS} FAILED: $(tr '\n' ' ' < /tmp/post-mail-send.err | cut -c1-300)" >&2
  attempt=$((attempt + 1))
  [ "$attempt" -le "$ATTEMPTS" ] && sleep "$WAIT_S"
done

# STEP 3 — never quiet. The caller keys the Processed/ move on this exit code.
echo "POST MAIL NOT SENT after ${ATTEMPTS} attempts: $SUBJECT ($PDF). The source PDF must NOT be archived." >&2
exit 1
