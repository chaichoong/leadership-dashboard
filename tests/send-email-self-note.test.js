// The self-note gate (28 Sep 2026).
//
// send-email.py is the one road to the Gmail worker, and every other mode sends
// only what Kevin approved. `self-note` exists so a personal job (the UK gigs
// check) can email Kevin himself. It must never become a road to anyone else:
// no recipient can be given, the subject must carry a registered prefix, and a
// rerun of the same key never sends a second copy.
//
// These drive the REAL send_self_note with the worker replaced by a fake and the
// ledger pointed at a temp file.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(root, 'scripts/send-email.py');

function run(steps, opts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-note-'));
    const ledger = path.join(dir, 'self-notes.jsonl');
    if (opts.rows) fs.writeFileSync(ledger, opts.rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.argv = ["send-email.py"]
spec = importlib.util.spec_from_file_location("se", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = json.loads(sys.stdin.read())
m.SELF_NOTE_LEDGER = a["ledger"]
calls = []
def fake_worker(url, payload=None):
    calls.append(payload)
    if a.get("failWith"):
        sys.exit(a["failWith"])
    return {"id": "msg-%d" % len(calls)}
m.worker_call = fake_worker
results = []
for s in a["steps"]:
    try:
        results.append(m.send_self_note(s.get("key", "uk-gigs:2026-09-28"), s["subject"], s.get("body", "hi")))
    except SystemExit as e:
        results.append({"exit": str(e.code)})
print(json.dumps({"results": results, "calls": calls}))
`], { input: JSON.stringify({ ledger, steps, failWith: opts.failWith }), encoding: 'utf8' });
    const parsed = JSON.parse(out.trim());
    parsed.ledger = fs.existsSync(ledger)
        ? fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    return parsed;
}

describe('send-email self-note', () => {
    it('sends to Kevin\'s own address and nowhere else', () => {
        const r = run([{ subject: 'UK gigs: 2 new (Queen)' }]);
        expect(r.calls).toHaveLength(1);
        expect(r.calls[0].to).toBe('kevinbrittain@gmail.com');
        expect(r.calls[0].from).toBe('kevinbrittain@gmail.com');
        expect(r.results[0].sent).toBe('uk-gigs:2026-09-28');
    });

    it('offers no way to name a recipient', () => {
        // Back-tested 28 Sep 2026: adding a --to option to the self-note parser
        // makes this exit 0 instead of refusing.
        const p = spawnSync('python3', [SCRIPT, 'self-note', '--key', 'k', '--subject', 'UK gigs: x',
            '--to', 'someone@example.com', '--dry-run'], { input: 'body', encoding: 'utf8' });
        expect(p.status).not.toBe(0);
        expect(p.stderr).toMatch(/unrecognized arguments: --to/);
    });

    it('refuses a subject without a registered prefix', () => {
        const r = run([{ subject: 'Invoice overdue' }]);
        expect(r.results[0].exit).toMatch(/REFUSED: a self-note subject opens with/);
        expect(r.calls).toEqual([]);
    });

    it('never sends the same key twice', () => {
        const r = run([{ subject: 'UK gigs: a' }, { subject: 'UK gigs: a' }]);
        expect(r.calls).toHaveLength(1);
        expect(r.results[1].skipped).toBe('uk-gigs:2026-09-28');
    });

    it('refuses a key whose send died half way, and retries one the worker refused', () => {
        const died = run([{ subject: 'UK gigs: a' }], {
            rows: [{ key: 'uk-gigs:2026-09-28', ts: 't', event: 'intent' }],
        });
        expect(died.results[0].exit).toMatch(/never finished/);
        expect(died.calls).toEqual([]);

        const refused = run([{ subject: 'UK gigs: a' }], { failWith: 'ERROR: worker 500: down' });
        expect(refused.results[0].exit).toMatch(/worker 500/);
        expect(refused.ledger.map((row) => row.event)).toEqual(['intent', 'failed']);

        const retry = run([{ subject: 'UK gigs: a' }], {
            rows: [{ key: 'uk-gigs:2026-09-28', ts: 't', event: 'intent' },
                { key: 'uk-gigs:2026-09-28', ts: 't', event: 'failed' }],
        });
        expect(retry.results[0].sent).toBe('uk-gigs:2026-09-28');
    });
});
