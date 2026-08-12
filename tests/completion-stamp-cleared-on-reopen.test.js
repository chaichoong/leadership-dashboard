// Reopening a task MUST clear its completion stamp.
//
// Found 11 Aug 2026 (finding 20260811-daily-ops-091). 88 open tasks were
// carrying a Completion Date, so every "tasks completed this month" and
// Completed Month figure counted work that was never finished — April 2026 was
// overstated by 88 tasks at the peak.
//
// The cause was NOT, as two earlier sweeps concluded, an Airtable automation
// wrongly stamping open tasks. The stamp is written correctly when a task is
// completed. The fault was that three separate code paths moved a task OFF
// Completed and left the stamp behind:
//
//   1. os/tasks/index.html      — approve/amend in the Tasks page (Status -> Today)
//   2. scripts/slack-automation/approvals.js — the same decision taken from Slack
//   3. scripts/agent-dispatch.py — submit for approval (Status -> Approval)
//
// The stale statuses matched those paths exactly: Approval 19, Today 12.
//
// The rule has to hold in all three runtimes (browser, Cloudflare worker,
// Python) and they cannot share code, so it is asserted three times here.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// Pull out the block that runs when a decision is NOT a rejection, i.e. the
// path that reopens the task. Asserting against the whole file would pass on
// the stamp-clearing that already exists in the *inline edit* path and prove
// nothing about the approval path.
function reopenBranch(src, startMarker) {
    const at = src.indexOf(startMarker);
    if (at === -1) throw new Error(`marker not found: ${startMarker}`);
    // From the marker to the close of that else block.
    const tail = src.slice(at);
    const end = tail.indexOf('\n  }');
    return end === -1 ? tail.slice(0, 800) : tail.slice(0, end);
}

describe('Tasks page: approving a task clears its completion stamp', () => {
    const src = read('os/tasks/index.html');

    it('sets the completion field to null when status goes back to Today', () => {
        const branch = reopenBranch(src, "payload[F.status]='Today';");
        expect(branch).toContain('payload[F.completion]=null');
    });

    it('still stamps completion when the outcome IS a rejection', () => {
        // Guards the opposite mistake: clearing unconditionally would stop
        // legitimate stamping, which 6,793 completed tasks depend on.
        expect(src).toContain("payload[F.status]='Completed';");
        const at = src.indexOf("payload[F.status]='Completed';");
        expect(src.slice(at, at + 200)).toContain('payload[F.completion]=nowIso');
    });
});

describe('Slack worker: approving from Slack clears the completion stamp', () => {
    const src = read('scripts/slack-automation/approvals.js');

    it('sets the completion field to null on the reopen branch', () => {
        const branch = reopenBranch(src, "fields[AF.status] = 'Today';");
        expect(branch).toContain('fields[AF.completion] = null');
    });

    it('still stamps completion on the reject branch', () => {
        const at = src.indexOf("fields[AF.status] = 'Rejected'") >= 0
            ? src.indexOf("fields[AF.status] = 'Rejected'")
            : src.indexOf("fields[AF.status] = 'Completed';");
        expect(src.slice(at, at + 200)).toContain('fields[AF.completion] = now');
    });
});

describe('agent-dispatch: submitting for approval clears the completion stamp', () => {
    // Runs the REAL cmd_submit with patch_task swapped for a recorder, so the
    // assertion is against the payload the script would actually send.
    // Re-implementing the payload in JS would guard nothing.
    function submit() {
        const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
        const script = `
import importlib.util, json, sys, tempfile, os, types
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
captured = {}
def fake_patch(task, fields):
    captured['task'] = task; captured['fields'] = fields; return {'id': task}
m.patch_task = fake_patch
# submit reads the task to find its Approver — stub it so no Airtable call happens.
m.get_task = lambda task: {'id': task, 'fields': {}}
fh = tempfile.NamedTemporaryFile('w', suffix='.md', delete=False)
fh.write('Some drafted work.'); fh.close()
agent_id = sorted(m.AGENTS)[0]
args = types.SimpleNamespace(task='recTESTTESTTEST01', agent=agent_id,
                             type='Drafting', output_file=fh.name, tier1=False)
out = {'fieldMap': m.AF}
try:
    m.cmd_submit(args); out['refused'] = False
except SystemExit as exc:
    out['refused'] = True; out['error'] = str(exc)
finally:
    os.unlink(fh.name)
out['captured'] = captured
print('---JSON---'); print(json.dumps(out))
`;
        const raw = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
        return JSON.parse(raw.split('---JSON---')[1]);
    }

    it('nulls the completion field in the same patch that sets Status=Approval', () => {
        const r = submit();
        expect(r.refused, r.error).toBe(false);
        const f = r.captured.fields;
        const AF = r.fieldMap;
        expect(f[AF.status]).toBe('Approval');
        expect(Object.prototype.hasOwnProperty.call(f, AF.completion),
            'submit does not clear Completion Date — a resubmitted task still counts as finished work'
        ).toBe(true);
        expect(f[AF.completion]).toBeNull();
    });
});
