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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

// ── THE SCAN (18 Aug 2026, finding 20260818-prod-e2e-sweep-198) ──────────
//
// The three describes below were the whole test, and they named three files.
// A FOURTH path (scripts/slack-automation/contractor-bot.js) shipped with the
// bug and this file could not see it, by construction: it was not on the list.
// Naming the paths is what made the regression invisible.
//
// So the list is now DERIVED. Any file that writes the Tasks Status field is
// found by its field id, and every write that moves a task to a non-Completed
// status on an EXISTING record must clear the stamp in the same call. A fifth
// and sixth path fail this automatically — which is exactly what happened when
// it was first run: follow-up.html's reopenAirtableTask, a function whose own
// comment says "Reopen a completed Airtable task", was silently leaving the
// stamp behind.
//
// CREATES are exempt and the exemption is stated, not silent: a record that
// does not exist yet has no stamp to clear. A site counts as an update only
// when the write carries a record id — a PATCH, updateTask(), patchTask(),
// patch_task(). Anything else is a create.
describe('every reopen path clears the completion stamp (derived, not listed)', () => {
    const STATUS_FIELD = 'fldx4qCw17UfrKpaN';
    const COMPLETION_FIELD = 'fldFOi1SwEKuJRmdN';
    // How far either side of the status write the clear may sit. Wide enough
    // for a multi-line fields object, tight enough that an unrelated mention
    // elsewhere in a 8,000-line file cannot vouch for it.
    const WINDOW = 400;
    const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'monitoring', 'tests', 'docs']);

    function sources(dir = ROOT, out = []) {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.name.startsWith('.') && e.name !== '.claude') {
                if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
            }
            if (SKIP_DIRS.has(e.name)) continue;
            const full = join(dir, e.name);
            if (e.isDirectory()) sources(full, out);
            else if (/\.(js|html|py)$/.test(e.name)) out.push(full);
        }
        return out;
    }

    // Which identifier in this file is the Tasks field map? Whichever object
    // literal the status field id was declared inside. Found, not assumed, so
    // a new file using a new name for the map is covered on day one.
    function taskFieldMaps(src) {
        const maps = new Set();
        const decl = /(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*\{/g;
        let at = src.indexOf(STATUS_FIELD);
        while (at !== -1) {
            const head = src.slice(0, at);
            let m, last = null;
            decl.lastIndex = 0;
            while ((m = decl.exec(head)) !== null) last = m[1];
            if (last) maps.add(last);
            at = src.indexOf(STATUS_FIELD, at + 1);
        }
        return [...maps];
    }

    const UPDATE_HINT = /PATCH|updateTask\s*\(|patchTask\s*\(|patch_task\s*\(|airtablePatch\s*\(/;

    function offenders() {
        const bad = [];
        for (const file of sources()) {
            const src = readFileSync(file, 'utf8');
            if (!src.includes(STATUS_FIELD)) continue;
            for (const map of taskFieldMaps(src)) {
                const write = new RegExp(
                    map.replace(/[$]/g, '\\$&') + "\\.status\\]\\s*[:=]\\s*['\"]([A-Za-z ]+)['\"]", 'g');
                let m;
                while ((m = write.exec(src)) !== null) {
                    if (m[1] === 'Completed') continue;
                    const win = src.slice(Math.max(0, m.index - WINDOW), m.index + m[0].length + WINDOW);
                    if (!UPDATE_HINT.test(win)) continue;   // a create — nothing to clear
                    // The clear must be a clear. A nearby `completion = now`
                    // on the SIBLING reject branch sits inside the window and
                    // would otherwise vouch for a reopen that stamps nothing —
                    // caught while back-testing this against approvals.js.
                    const clearRe = new RegExp(
                        '(?:' + map.replace(/[$]/g, '\\$&') + '\\.completion|' + COMPLETION_FIELD +
                        ")['\"]?\\]?\\s*[:=]\\s*(?:null|None)", 'i');
                    const cleared = clearRe.test(win);
                    if (cleared) continue;
                    const line = src.slice(0, m.index).split('\n').length;
                    bad.push(`${file.replace(ROOT + '/', '')}:${line} sets Status='${m[1]}' on an existing record without clearing the completion stamp`);
                }
            }
        }
        return bad;
    }

    it('no code path moves a task off Completed and leaves the stamp behind', () => {
        const bad = offenders();
        expect(bad, `Reopen paths that keep a stale completion stamp:\n  ${bad.join('\n  ')}\n\n` +
            'Set the completion field to null in the SAME write as the status change. ' +
            'If this really is a create, it needs no clear — make that obvious in the code.'
        ).toEqual([]);
    });

    it('the scan can actually find something — it is not matching nothing', () => {
        // THE CONTROL. A regex typo would return zero offenders and read as a
        // permanent pass, which is the failure mode this whole file is about.
        // Prove the scan sees the real write sites before trusting an empty list.
        let seen = 0;
        for (const file of sources()) {
            const src = readFileSync(file, 'utf8');
            if (!src.includes(STATUS_FIELD)) continue;
            for (const map of taskFieldMaps(src)) {
                const write = new RegExp(
                    map.replace(/[$]/g, '\\$&') + "\\.status\\]\\s*[:=]\\s*['\"][A-Za-z ]+['\"]", 'g');
                seen += (src.match(write) || []).length;
            }
        }
        expect(seen, 'the scan matched no status writes at all — the pattern is broken')
            .toBeGreaterThan(10);
    });
});

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
# Behaves like Airtable: the post-patch read-back (finding
# 20260823-queue-fixer-329) must see what submit just wrote.
m.get_task = lambda task: {'id': task, 'fields': dict(captured.get('fields', {}))}
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
