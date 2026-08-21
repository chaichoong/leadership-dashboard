#!/usr/bin/env python3
"""Has physical post been scanned recently enough to trust "nothing to do"?

WHY THIS EXISTS (18 Aug 2026, finding 20260818-post-manager-weekly-214)
-----------------------------------------------------------------------
The post phase triggers on a PDF appearing in Google Drive. Post arriving in
the real world does not put a PDF there — Kevin scanning it does. Between
3 Jul and 16 Aug 2026 the phase ran every week and reported "No new scanned
post to process" every time. It was telling the truth about the folder and
saying nothing about the post.

When the 16 Aug scan finally happened it held 29 documents dated 26 Jun to
30 Jul, and by then a 7-day Utilita demand, a 14-day Companies House
strike-off window, a 14-day charging-order reconsideration window and a
3 Aug BW Legal deadline had all closed unread.

An empty inbox is only good news if the inbox is being fed. This turns the
silence into a question: nothing scanned for STALE_DAYS means ALERT KEVIN TO
SCAN, not "nothing to do".

THE CONTROL
-----------
A folder that does not exist, or that holds no processed post at all, is NOT
a pass. It exits 2 and says so. The failure this replaces was a check that
could only ever return "fine", so a check that cannot fail would repeat it.

Exit codes: 0 fresh · 1 stale, alert · 2 cannot tell (folder missing/empty).
"""

import argparse
import os
import sys
import time

DRIVE = os.environ.get(
    "POST_INBOX_DIR",
    "/Users/kevinbrittain/Library/CloudStorage/"
    "GoogleDrive-kevin@runpreneur.org.uk/My Drive/Post Inbox",
)

# Two weeks. Most of what arrives carries a 7 to 14 day clock — a council tax
# reminder, a strike-off notice, a charging-order reconsideration window — so
# beyond two weeks unscanned, something in the pile is plausibly already
# expired. Shorter would nag through a normal holiday; longer would not have
# caught the seven-week gap in time to matter.
STALE_DAYS = 14

PDF_SUFFIXES = (".pdf", ".PDF")


def newest_processed(processed_dir):
    """(newest mtime, filename, count) of processed post PDFs. None if empty."""
    newest, name, count = None, None, 0
    try:
        entries = os.listdir(processed_dir)
    except OSError:
        return None, None, 0
    for entry in entries:
        if not entry.endswith(PDF_SUFFIXES):
            continue
        path = os.path.join(processed_dir, entry)
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        count += 1
        if newest is None or mtime > newest:
            newest, name = mtime, entry
    return newest, name, count


def check(base=None, stale_days=STALE_DAYS, now=None):
    """Returns (exit_code, message)."""
    base = base or DRIVE
    now = now if now is not None else time.time()
    processed = os.path.join(base, "Processed")

    if not os.path.isdir(base):
        return 2, ("post-inbox: CANNOT TELL — the Post Inbox folder is not there "
                   "(%s). Google Drive may not be mounted. This is not a pass: "
                   "an unreadable folder and an empty one look identical, and "
                   "reading either as 'no post' is the bug this check exists for."
                   % base)
    if not os.path.isdir(processed):
        return 2, ("post-inbox: CANNOT TELL — no Processed folder under %s, so "
                   "there is no record of post ever having been scanned."
                   % base)

    newest, name, count = newest_processed(processed)
    if newest is None:
        return 2, ("post-inbox: CANNOT TELL — %s holds no processed PDFs at all. "
                   "Either nothing has ever been scanned, or the archive moved."
                   % processed)

    days = (now - newest) / 86400.0
    stamp = time.strftime("%d %b %Y", time.localtime(newest))
    if days < stale_days:
        return 0, ("post-inbox: fresh — last post processed %s (%.0f days ago), "
                   "%d documents archived." % (stamp, days, count))

    return 1, (
        ":mailbox_with_mail: *No physical post has been scanned for %.0f days* "
        "(last processed %s).\n"
        "The post job only fires when a PDF appears in Google Drive, so an "
        "empty inbox means nobody scanned, NOT that nothing arrived. On 16 Aug "
        "2026 a seven-week gap surfaced 29 documents at once and every deadline "
        "in them had already passed — a court date, a strike-off window and a "
        "charging-order window among them.\n"
        "*Scan whatever is in the pile and drop it in Post Inbox.*"
        % (days, stamp))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--dir", default=None, help="Post Inbox folder")
    p.add_argument("--stale-days", type=int, default=STALE_DAYS)
    a = p.parse_args(argv)
    code, msg = check(a.dir, a.stale_days)
    print(msg)
    return code


if __name__ == "__main__":
    sys.exit(main())
