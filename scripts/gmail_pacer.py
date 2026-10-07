#!/usr/bin/env python3
"""ONE SHARED GMAIL PACER for every process on this Mac that reads Gmail.

Kevin's approved build, 5 Oct 2026 (finding 20261002-phase-2-702). Lives in its
own module so inbound-triage.py and payment-run.py cannot drift apart on the
cost model or keep separate ledgers: two processes each politely staying under
the limit still produce 403s if they do not count each other's calls.

The ledger is per MAILBOX, on disk, and every writer takes the same advisory
lock, so the budget holds across processes rather than inside one run.

Nothing here prints or exits. The caller decides how to report a wait.
"""
import json
import os
import re
import tempfile
import time
from pathlib import Path


# ---------------------------------------------------------------------------
# ONE SHARED GMAIL PACER (Kevin's approved build, 5 Oct 2026; finding
# 20261002-phase-2-702)
# ---------------------------------------------------------------------------
# The history book was last rebuilt on 1 Sep 2026. Every rebuild since died on
# Gmail's per-minute metric, the cooldown deferred it, the give-up counter
# reached its limit on a `kind=rate` failure, and the retry STOPPED. By 7 Oct
# the agent had filed 35 days of mail against 1 Sep sender knowledge while
# every slot reported ok. Each layer did its job; none of them could see that
# the fault was capacity, not logic.
#
# Waiting AFTER a 403 cannot fix that, because the quota is already spent by
# then and the slot's own scan has to fight for what is left. So nothing asks
# Gmail for more than it will give: every call prices itself first and waits
# for room.
#
# THE REAL LIMIT, not a guess: Gmail allows 6,000 quota units per minute per
# user. A /gmail/list page is one messages.list (5 units) plus up to 25
# messages.get (20 each) = 505 units, because the worker hydrates every message
# in the page (workers/drive-upload/worker.js, max 25 a call). A modify is 5 a
# message, an attachment fetch 5, a labels list 1.
GMAIL_UNITS_PER_MINUTE = 6000
GMAIL_UNITS_LIST = 5            # messages.list
GMAIL_UNITS_GET = 20            # messages.get, once per message in the page
GMAIL_UNITS_MODIFY = 5          # messages.modify, per id
GMAIL_UNITS_ATTACHMENT = 5      # messages.attachments.get
GMAIL_UNITS_LABELS = 1          # labels.list
GMAIL_LIST_PAGE_MAX = 25        # the worker's own cap, and its default
# THE STARTING CEILINGS ARE WHAT WAS MEASURED, NOT WHAT IS DOCUMENTED (7 Oct 2026).
# The first live run was refused after 2,525 units in a minute, with Gmail naming
# the metric itself: "Quota exceeded for quota metric 'Total Query Cost' and limit
# 'Units per minute per user'". So the documented 6,000 is not what this project
# gets. Starting at 5,000 guaranteed a refusal in the first minute of every fresh
# ledger, which is a wasted page and a wasted wait every time.
#
# These are starting points only — gmail_note_refusal learns the real rate from
# the first refusal and _pace_recovered edges it back up over clean stretches, so
# the pacer settles near the truth whatever these say. They are set under the
# observed figure so the common case needs no refusal to find it.
GMAIL_PACE_CEILING = 2000
# A rebuild never takes more than about half, so a slot's scan — the work that
# actually triages mail — always has its share. This is the rule whose absence let
# nine rebuilds a day starve the 09:00 scan (8-10 Sep 2026).
GMAIL_REBUILD_CEILING = 1200
# OD_GMAIL_PACE_DIR exists so a test can never write to the live ledger. Before
# 7 Oct 2026 a test that drove worker_post taught the REAL pacer a ceiling from
# its own fake refusals, which would have throttled production from a fixture.
GMAIL_PACE_DIR = Path(os.environ.get("OD_GMAIL_PACE_DIR")
                      or (Path.home() / ".config/od/gmail_pace"))
# MEASURED, NOT ASSUMED (7 Oct 2026). The first real run of this pacer took a
# short-window refusal after 2,526 units in a minute — less than half the 6,000
# the documentation describes, and below even the 3,000 rebuild ceiling. The
# published figure is a per-user-per-minute budget; what Gmail actually enforces
# behaves like a moving average, so a burst of 505-unit pages is refused long
# before the minute's total is spent.
#
# A constant that is wrong in that direction makes the pacer useless, so the
# pacer LEARNS instead: every short-window refusal records what was in flight at
# the time, and from then on this mailbox is paced under that. A wrong constant
# can slow the estate down; it can no longer stop it.
GMAIL_OBSERVED_MARGIN = 0.8     # pace to 80% of whatever Gmail last refused at
# Never learn a ceiling so low that a single page cannot get through, or the
# rebuild would wait for ever on a limit of its own making.
GMAIL_OBSERVED_FLOOR = 1010     # two pages plus change
# A LIMIT THAT ONLY FALLS ENDS AT THE FLOOR FOR EVER. Each refusal ratchets the
# ceiling down, so without recovery a few bad minutes would throttle the mailbox
# permanently — the live rebuild went 1,617 then 1,215 within minutes. So after a
# clean stretch the ceiling edges back up: slow additive recovery against fast
# multiplicative backoff, which is how every well-behaved rate limiter settles
# near the true rate instead of oscillating or collapsing.
GMAIL_OBSERVED_RECOVER_AFTER = 600     # ten clean minutes
GMAIL_OBSERVED_RECOVER_STEP = 250      # then half a page at a time
# One wait is never longer than the window it is waiting for, plus skew.
GMAIL_PACE_MAX_WAIT = 70
# Enough attempts for a genuinely busy mailbox to clear several windows, few enough that a stopped
# clock surfaces in seconds rather than hanging the run.
GMAIL_PACE_MAX_HOLDS = 60


class GmailPaceStuck(RuntimeError):
    """The pacer could not find room and the clock is not advancing."""


def gmail_units(path, payload=None):
    """What this call will cost Gmail, in quota units.

    An unknown path is priced as a FULL PAGE, not as free: a new endpoint added
    without touching this function must make the pacer cautious, never blind.
    """
    payload = payload or {}
    if path == "/gmail/list":
        try:
            n = int(payload.get("maxResults") or GMAIL_LIST_PAGE_MAX)
        except (TypeError, ValueError):
            n = GMAIL_LIST_PAGE_MAX
        n = max(1, min(n, GMAIL_LIST_PAGE_MAX))
        return GMAIL_UNITS_LIST + n * GMAIL_UNITS_GET
    if path == "/gmail/modify":
        ids = payload.get("ids") or []
        return GMAIL_UNITS_MODIFY * max(1, len(ids))
    if path == "/gmail/attachment":
        return GMAIL_UNITS_ATTACHMENT
    if path == "/gmail/labels":
        return GMAIL_UNITS_LABELS
    return GMAIL_UNITS_LIST + GMAIL_LIST_PAGE_MAX * GMAIL_UNITS_GET


def _pace_dir():
    """Read the override each time: a test may set it after import."""
    return Path(os.environ.get("OD_GMAIL_PACE_DIR") or GMAIL_PACE_DIR)


def _pace_file(account):
    safe = re.sub(r"[^a-z0-9._-]", "_", (account or "default").lower())
    return _pace_dir() / ("%s.json" % safe)


class _pace_lock:
    """An advisory lock around one mailbox's ledger, held only for the
    read-modify-write.

    flock, not a lock FILE with a pid in it: the kernel releases it when the
    holder dies, so a killed slot can never wedge the queue — which is the
    failure the job-queue heartbeat incident taught (2 Sep 2026, and
    .claude/rules/python-scripts.md). On a filesystem with no flock the pacer
    degrades to unsynchronised, which is still better than no pacing at all.
    """

    def __init__(self, account):
        self.path = _pace_file(account).with_suffix(".lock")
        self.fh = None

    def __enter__(self):
        _pace_dir().mkdir(parents=True, exist_ok=True)
        try:
            import fcntl
            self.fh = open(self.path, "a+")
            fcntl.flock(self.fh.fileno(), fcntl.LOCK_EX)
        except (ImportError, OSError):
            if self.fh:
                try: self.fh.close()
                except OSError: pass
            self.fh = None
        return self

    def __exit__(self, *exc):
        if self.fh:
            try:
                import fcntl
                fcntl.flock(self.fh.fileno(), fcntl.LOCK_UN)
            except (ImportError, OSError):
                pass
            try: self.fh.close()
            except OSError: pass
        return False


def _pace_observed(account):
    """The ceiling Gmail last refused at for this mailbox, or None if never."""
    p = _pace_file(account)
    if not p.exists():
        return None
    try:
        v = json.loads(p.read_text()).get("observedCeiling")
        return int(v) if v else None
    except (ValueError, OSError, TypeError):
        return None


def _pace_recovered(account, now):
    """The learned ceiling, edged back up for every clean stretch since the last
    refusal. Never above GMAIL_PACE_CEILING, never below the floor.

    Recovery is computed on read rather than written on a timer: there is no
    daemon here, and a pure function of (ceiling, last refusal, now) cannot drift
    from whatever the file says.
    """
    p = _pace_file(account)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text())
    except (ValueError, OSError):
        return None
    try:
        ceiling = int(data.get("observedCeiling") or 0)
        at = float(data.get("observedAt") or 0)
    except (TypeError, ValueError):
        return None
    if not ceiling or not at:
        return None
    clean = max(0.0, now - at)
    steps = int(clean // GMAIL_OBSERVED_RECOVER_AFTER)
    if steps <= 0:
        return ceiling
    return min(GMAIL_PACE_CEILING,
               max(GMAIL_OBSERVED_FLOOR, ceiling + steps * GMAIL_OBSERVED_RECOVER_STEP))


def gmail_note_refusal(account, now=None):
    """Gmail just refused a call on a short-window metric. Record what was in
    flight so every later call on this mailbox is paced under it.

    Returns the new ceiling. Called from the caller's slowdown branch, which is
    the only place that knows a refusal happened.
    """
    t = (now or time.time)()
    with _pace_lock(account):
        rows = _pace_read(account, t)
        in_flight = sum(u for _, u in rows)
        prev = _pace_recovered(account, t)
        learned = max(GMAIL_OBSERVED_FLOOR, int(in_flight * GMAIL_OBSERVED_MARGIN))
        ceiling = min(prev, learned) if prev else learned
        p = _pace_file(account)
        try:
            data = json.loads(p.read_text()) if p.exists() else {}
        except (ValueError, OSError):
            data = {}
        data["spent"] = rows
        data["observedCeiling"] = ceiling
        data["observedAt"] = int(t)
        _pace_write_raw(account, data)
        return ceiling


def _pace_read(account, now):
    """The units spent in the last minute, as a list of [timestamp, units].

    An unreadable ledger is treated as a FULL minute, never an empty one. A
    corrupt or half-written file must make the pacer wait, because reading it
    as empty is exactly how an unpaced burst gets through ("unreadable is not
    abandoned", .claude/rules/python-scripts.md).
    """
    p = _pace_file(account)
    if not p.exists():
        return []
    try:
        rows = json.loads(p.read_text()).get("spent") or []
    except (ValueError, OSError):
        return [[now, GMAIL_UNITS_PER_MINUTE]]
    out = []
    for r in rows:
        try:
            ts, units = float(r[0]), int(r[1])
        except (TypeError, ValueError, IndexError):
            continue
        if now - ts < 60:
            out.append([ts, units])
    return out


def _pace_write_raw(account, data):
    _pace_dir().mkdir(parents=True, exist_ok=True)
    p = _pace_file(account)
    data = dict(data)
    data["spent"] = (data.get("spent") or [])[-400:]
    fd, tmp = tempfile.mkstemp(dir=str(_pace_dir()), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.replace(tmp, p)      # rename is atomic; truncate-then-write is not
    except OSError:
        try: os.unlink(tmp)
        except OSError: pass


def _pace_write(account, rows):
    """Record the spend, keeping any learned ceiling that is already on file."""
    p = _pace_file(account)
    try:
        data = json.loads(p.read_text()) if p.exists() else {}
    except (ValueError, OSError):
        data = {}
    data["spent"] = rows
    _pace_write_raw(account, data)


def gmail_pace(path, payload=None, account=None, ceiling=None,
               sleep=time.sleep, now=None, on_wait=None):
    """Hold this call until Gmail has room for it, then record the spend.

    Returns (units, waited_seconds). The lock is taken only around the ledger,
    never across the sleep, so one waiting process does not block another from
    recording a call that fits.
    """
    clock = now or time.time
    cost = gmail_units(path, payload)
    ceiling = ceiling or _pace["ceiling"]
    # Whatever Gmail last refused at beats whatever is written here.
    observed = _pace_recovered(account, clock())
    if observed:
        ceiling = min(ceiling, observed)
    # A single call dearer than the whole ceiling would wait for ever.
    room = max(ceiling, cost)
    waited = 0.0
    # A WAIT THAT NEVER ENDS IS WORSE THAN A REFUSAL. If the clock does not move — a stopped
    # monotonic source, a caller whose sleep is a no-op, a ledger whose stamps are in the future —
    # the room test can never become true and this would spin for ever holding nothing but the
    # agent's run. Bounded at a few windows' worth of attempts, then it gives up and says why, so
    # the caller's own quota handling takes over instead of the process hanging silently.
    for _ in range(GMAIL_PACE_MAX_HOLDS):
        t = clock()
        with _pace_lock(account):
            rows = _pace_read(account, t)
            spent = sum(u for _, u in rows)
            if spent + cost <= room:
                rows.append([t, cost])
                _pace_write(account, rows)
                _pace["units"] += cost
                return cost, round(waited, 2)
            # Wait only until the oldest entry falls out of the window, which is
            # the earliest moment room can appear.
            oldest = min(ts for ts, _ in rows)
            wait = max(0.5, min(GMAIL_PACE_MAX_WAIT, (oldest + 60) - t + 0.5))
        if on_wait:
            on_wait(cost, spent, ceiling, wait)
        sleep(wait)
        waited += wait
    raise GmailPaceStuck(
        "waited %.0fs over %d attempts and never found room for a %d-unit call under a ceiling of "
        "%d; the clock or the ledger is not moving" % (waited, GMAIL_PACE_MAX_HOLDS, cost, ceiling))


_pace = {"ceiling": GMAIL_PACE_CEILING, "units": 0, "waited": 0.0}
