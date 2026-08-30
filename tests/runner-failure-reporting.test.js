import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve, dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// THE BUG (28 Aug 2026). The scheduled runners logged
//   "inbound-triage run FAILED (rc=0) — see …"
// which reads as a contradiction and cost real time to decode. It was not one:
// `rc` is the INNER command's exit code, while FAILED is the wrapper's broader
// verdict, which also fires on error text in the log or on a privacy
// quarantine. The wrapper does exit 1, so failures were never invisible.
//
// Decoding it, though, found a genuine fault. The privacy sweep matched the
// string "Inbound Message Content" ANYWHERE in a file. In an Airtable schema
// snapshot that string is a VALUE — the table merely naming one of its columns
// — so every daily snapshot was moved out of monitoring/ and failed the run.
// 69 snapshots had been displaced. Two failures in the same log were real
// (Full Disk Access), which is exactly the damage: true alarms buried in false.
//
// These tests hold both halves: the message must say WHY, and the privacy
// sweep must distinguish a column NAME from actual message content.

const RUNNERS = [
    'scripts/inbound-triage-run.sh',
    'scripts/agent-slot-run.sh',
    'scripts/task-manager-run.sh',
    'scripts/handback-poll-run.sh',
];
const SWEEPERS = RUNNERS.filter((r) => !r.includes('handback-poll'));

/** The privacy pattern as the script actually spells it, not a copy of it. */
function sweepPattern(runner) {
    const m = read(runner).match(/if grep -qlE '([^']+)' "\$f"/);
    return m && m[1];
}

function matches(pattern, body) {
    const f = join(mkdtempSync(join(tmpdir(), 'sweep-')), 'f.json');
    writeFileSync(f, body);
    return spawnSync('grep', ['-qlE', pattern, f]).status === 0;
}

describe('a failed run says why it failed', () => {
    for (const runner of RUNNERS) {
        it(`${runner} never reports a bare exit code as the reason`, () => {
            const src = read(runner);
            expect(src, 'the "FAILED (rc=0)" phrasing is the confusing one')
                .not.toMatch(/run FAILED \(rc=\$RC\)/);
            expect(src, 'the failure line must carry a reason')
                .toMatch(/run FAILED: \$__WHY/);
        });

        it(`${runner} builds a reason for every failing condition`, () => {
            const src = read(runner);
            expect(src).toMatch(/__WHY="the command exited \$RC"/);
            expect(src).toMatch(/error text in the log/);
            // Only the runners that actually sweep can quarantine anything.
            // handback-poll has no __LEAKED, and naming it under `set -u`
            // would abort the script at the moment it tries to report.
            const sweeps = SWEEPERS.includes(runner);
            expect(src.includes('files quarantined from monitoring/"'), runner)
                .toBe(sweeps);
        });
    }
});

describe('the privacy sweep tells a column name from real content', () => {
    // A schema snapshot NAMES the column. It carries no message content.
    const SCHEMA = JSON.stringify({
        tblqB8b22hKBL4PF1: { fields: [{ id: 'fld1', name: 'Inbound Message Content' }] },
    });
    // A real dump carries the content under that column, or under "body".
    const CONTENT_KEY = JSON.stringify({ records: [{ 'Inbound Message Content': 'hello' }] });
    const CONTENT_BODY = JSON.stringify({ messages: [{ body: 'hello' }] });
    const CONTENT_DESC = JSON.stringify({ tasks: [{ description: 'hello' }] });

    for (const runner of SWEEPERS) {
        const pattern = sweepPattern(runner);

        it(`${runner} exposes a pattern to test (control)`, () => {
            // Without this the checks below would pass vacuously on a null
            // pattern if the grep line is ever reworded.
            expect(pattern, 'could not read the sweep pattern out of the script')
                .toBeTruthy();
        });

        it(`${runner} does NOT quarantine a schema snapshot`, () => {
            expect(matches(pattern, SCHEMA),
                'a table naming its own column is not message content — this is '
                + 'what displaced 69 daily snapshots').toBe(false);
        });

        it(`${runner} DOES quarantine real message content`, () => {
            // The whole point of the sweep. Narrowing it must not blunt it.
            expect(matches(pattern, CONTENT_KEY), 'content under the field key').toBe(true);
            const other = runner.includes('inbound-triage') ? CONTENT_BODY : CONTENT_DESC;
            expect(matches(pattern, other), 'content under the runner\'s own key').toBe(true);
        });
    }
});

describe('error detection is not tripped by any number 401', () => {
    // A bare "401" matches a task count, an amount, or a record id fragment.
    // Two runners used it; the two written later already used the tight form.
    for (const runner of RUNNERS) {
        it(`${runner} matches 401 only as an HTTP status`, () => {
            const m = read(runner).match(/grep -E '([^']*401[^']*)'/);
            expect(m, 'no 401 pattern found to check').toBeTruthy();
            expect(m[1], 'a bare 401 alternative matches any occurrence of the number')
                .not.toMatch(/(^|\|)401(\||$)/);
        });
    }
});
