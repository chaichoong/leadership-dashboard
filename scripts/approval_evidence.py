"""Was a task really approved? The one check every send path uses.

Finding 20260922-agent-dispatch-572 (critical). On 22 Sep 2026 an agent created two tasks with a
raw Airtable write, typed "Approved with minor edits" into Approval Outcome itself, and ran
scripts/send-email.py. It sent both, because the gate read only that string. Two contractors
received emails Kevin never approved. The same shape had already sent six quote requests (9 and 15
Sep) "pre-approved under a parent task", one with an Approved At COPIED from the parent and earlier
than the task itself. Of every approved Correspondence task, the 143 approved in an approval surface
carried both marks below; the eight that did not were exactly these.

So an approval counts only when it left the marks a real one leaves: the task went through the gate
(Sent For Approval By, written by agent-dispatch submit), an approval was recorded (Approved At,
written by the queue, the Tasks drawer and Slack), and it came AFTER the task existed. A child of an
approved parent is not approved: it goes through the gate itself, or qualifies for a rule send.

Imported by send-email.py (PR #532) and calendar-write.py (24 Sep 2026). send-letter.py still needs
it (it was mid-edit in another session when this was written).

LIMIT, said plainly (independent review, 24 Sep 2026): every mark here is written with the same
Airtable token the agents hold, so an agent that deliberately forged all three would still pass.
This closes the shortcut that was actually taken and makes a forgery a deliberate breach of
GUARDRAILS rather than a tool failure worked around. Only separate credentials for the robots close
it fully (the parked Airtable token audit).
"""
from datetime import datetime, timezone

# Tasks field ids (js/config.js TASK_FIELDS; scripts/agent-dispatch.py AF).
SENT_FOR_APPROVAL_BY = "fld30Yw8SWYVp049g"
APPROVED_AT = "fldr4Mvf2RzKvhZhi"


def _ts(value):
    """An Airtable time as an aware datetime, or None. A value with no zone is read as UTC, so a
    bare date can never crash the comparison below."""
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def approval_evidence_problem(fields, created_time):
    """'' when the task (fields keyed by field id) carries the marks of a real approval, else why
    it does not."""
    if not fields.get(SENT_FOR_APPROVAL_BY):
        return "it never went through the approval gate (Sent For Approval By is empty)"
    raw = fields.get(APPROVED_AT) or ""
    if not raw:
        return "no approval was ever recorded (Approved At is empty)"
    approved_at = _ts(raw)
    if approved_at is None:
        return "its Approved At cannot be read (%r)" % raw
    created = _ts(created_time or "")
    if created is None:
        return "its creation time cannot be read, so the approval cannot be dated"
    if approved_at < created:
        return "its Approved At is earlier than the task itself, so it was copied, not given"
    return ""
