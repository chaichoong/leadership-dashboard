// Two controls the skill promised and the script never had.
//
// 1) 20260824-agent-dispatch-336. SKILL.md step 1 has mandated
//    `agent-dispatch.py reconcile` as the FIRST action of every run since
//    19 Aug 2026 — it names finished deliverables on disk whose Airtable record
//    still carries an empty Agent Output, i.e. work an agent did that never
//    reached Kevin because the run died between writing the file and calling
//    submit. The subparser list was queue/route/escalate/handover/submit/
//    annotate/intent/complete/verify. Running it exited 2 with "invalid choice".
//    On 19 Aug the orphan was a tier-1 deliverable with a five-day court
//    deadline, invisible in every surface Kevin looks at.
//
// 2) 20260823-queue-fixer-329. SKILL.md step 4 told the dispatcher that submit
//    "reads the record back and exits non-zero if the Agent Output is empty or
//    the Status did not move". cmd_submit's only get_task was the approver
//    lookup BEFORE the patch. A submit was recorded green on the strength of a
//    200 — and a PATCH returning 200 does not mean the field holds what you sent.
//
// Back-tested: deleting the reconcile subparser makes the first block fail with
// "invalid choice"; deleting the post-patch get_task makes the read-back block
// report a successful submit against an empty record.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// Drive the real cmd_reconcile with get_task stubbed and RUN_LOG_ROOT pointed
// at a fixture tree, so nothing touches Airtable or the real run log.
function reconcile({ deliverables, stored }) {
  const root = mkdtempSync(join(tmpdir(), 'recon-'));
  const runDir = join(root, '20260824-000000');
  mkdirSync(runDir, { recursive: true });
  for (const id of deliverables) {
    writeFileSync(join(runDir, `${id}.md`), '# finished work\n');
    // Scratch inside the agent's own working directory must be ignored.
    mkdirSync(join(runDir, id), { recursive: true });
    writeFileSync(join(runDir, id, 'notes.md'), 'scratch');
  }

  const script = `
import importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.RUN_LOG_ROOT = ${JSON.stringify(root)}
stored = json.loads(sys.argv[1])
m.get_task = lambda t: {'id': t, 'fields': (
    {m.AF['agentOutput']: stored[t], m.AF['name']: 'A task'} if stored.get(t) else {}
)}
code = m.cmd_reconcile(types.SimpleNamespace(runs=3))
print('---CODE---')
print(code)
`;
  let out;
  try {
    out = execFileSync('python3', ['-c', script, JSON.stringify(stored)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    out = `${err.stdout || ''}`;
  }
  const [body, code] = out.split('---CODE---');
  return { json: JSON.parse(body), code: Number((code || '').trim()) };
}

describe('agent-dispatch reconcile', () => {
  it('exists as a subcommand at all (the whole of finding 336)', () => {
    const help = execFileSync('python3', [DISPATCH, '--help'], { encoding: 'utf8' });
    expect(help).toMatch(/reconcile/);
  });

  it('names a deliverable whose Airtable record has an empty Agent Output', () => {
    const r = reconcile({
      deliverables: ['recORPHAN0000001', 'recFINE000000001'],
      stored: { recFINE000000001: 'the submitted output' },
    });
    expect(r.json.orphans.map((o) => o.task)).toEqual(['recORPHAN0000001']);
    expect(r.code, 'an orphan must not exit 0').toBe(1);
  });

  it('exits 0 when every deliverable reached Airtable', () => {
    const r = reconcile({
      deliverables: ['recFINE000000001'],
      stored: { recFINE000000001: 'the submitted output' },
    });
    expect(r.json.orphans).toEqual([]);
    expect(r.code).toBe(0);
  });

  it('fails rather than passing when it inspected nothing (the control)', () => {
    // "No orphans" and "found nothing to look at" print the same reassuring
    // line, and only one of them is good news.
    const r = reconcile({ deliverables: [], stored: {} });
    expect(r.json.deliverablesFound).toBe(0);
    expect(r.code, 'a reconcile that verified nothing must not read as clean').toBe(1);
  });
});

describe('agent-dispatch submit reads the record back (329)', () => {
  function submit({ storedAfterPatch, statusAfterPatch }) {
    const script = `
import importlib.util, json, sys, tempfile, os, types
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
payload = json.loads(sys.argv[1])
m.patch_task = lambda task, fields: {'id': task}
# The record as Airtable would return it AFTER the write — which is the point:
# a 200 on the PATCH is not evidence the field holds anything.
m.get_task = lambda task: {'id': task, 'fields': {
    m.AF['agentOutput']: payload['storedAfterPatch'],
    m.AF['status']: payload['statusAfterPatch'],
}}
fh = tempfile.NamedTemporaryFile('w', suffix='.md', delete=False)
fh.write('Some drafted work that is long enough to be real.')
fh.close()
agent_id = sorted(m.AGENTS)[0]
args = types.SimpleNamespace(task='recTESTTESTTEST01', agent=agent_id,
                             type='Drafting', output_file=fh.name, tier1=False)
out = {}
try:
    m.cmd_submit(args)
    out['refused'] = False
except SystemExit as exc:
    out['refused'] = True
    out['error'] = str(exc)
finally:
    os.unlink(fh.name)
print('---JSON---')
print(json.dumps(out))
`;
    const raw = execFileSync('python3', ['-c', script, JSON.stringify({ storedAfterPatch, statusAfterPatch })], {
      encoding: 'utf8',
    });
    return JSON.parse(raw.split('---JSON---')[1]);
  }

  it('refuses when the Agent Output is empty after the write', () => {
    const r = submit({ storedAfterPatch: '', statusAfterPatch: 'Approval' });
    expect(r.refused, 'a blank Agent Output after a 200 must not read as submitted').toBe(true);
    expect(r.error).toMatch(/EMPTY/);
  });

  it('refuses when the Status did not move to Approval', () => {
    const r = submit({ storedAfterPatch: 'the output', statusAfterPatch: 'Today' });
    expect(r.refused).toBe(true);
    expect(r.error).toMatch(/Approval/);
  });

  it('succeeds when the record really holds the work', () => {
    const r = submit({ storedAfterPatch: 'the output', statusAfterPatch: 'Approval' });
    expect(r.refused, r.error).toBe(false);
  });
});
