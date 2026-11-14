// A test never writes the estate's real state folders (14 Nov 2026).
//
// The create gate's record_fold (scripts/create-agent-task.py, PR #925) appends a `folded` event to
// the dispatcher's carry-out ledger on every real fold, through agent-dispatch.py's own
// ledger_append, at ~/knowledge-os/logs/agent-dispatch/carryout-intent.jsonl. That ledger decides
// which tasks rest and which are woken, so a test row in it is a real task woken (or a fake one
// listed) on Kevin's board. agent-dispatch.py reads AGENT_DISPATCH_DIR at import; this sets it to a
// fresh temp folder in every test file, so every Python child a test starts with the inherited
// environment (`{ ...process.env }` or no env at all) writes there. A test that passes its own env
// without process.env must set it itself. merge-approved.py's MERGE_APPROVED_DIR gets the same.
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.AGENT_DISPATCH_DIR = mkdtempSync(join(tmpdir(), 'od-test-agent-dispatch-'));
process.env.MERGE_APPROVED_DIR = mkdtempSync(join(tmpdir(), 'od-test-merge-approved-'));
