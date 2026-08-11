import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SEND_EMAIL = resolve(ROOT, 'scripts/send-email.py');

// The submit gate — scripts/agent-dispatch.py cmd_submit.
//
// Two bugs found on 11 Aug 2026, both of which let the approval loop believe an
// action was ready when it was not.
//
// 1) 20260811-agent-dispatch-083 (critical). submit set Status=Approval and
//    overwrote Agent Output, but never cleared Approval Outcome. Verified live
//    on recPuM3uRVPDmFhs0: Status 'Approval', Outcome 'Approved as-is', Agent
//    Output a brand new email Kevin had never read. send-email.py gates on the
//    outcome ALONE, so the send path would have posted unread words with no
//    fresh decision. The mirror image broke the redo path: a resubmitted
//    Changes-requested task kept that verdict and got re-queued as a redo on
//    every run, rewriting Agent Output under Kevin while he was reading it.
//
// 2) 20260811-agent-dispatch-085 (high). Nothing checked that a --type
//    Correspondence output matched the TO:/SUBJECT:/---/body contract that
//    send-email.py requires. recFdEICxHjYCzDkS went in as an analysis document
//    with the email buried in prose, Kevin approved it, and the failure only
//    surfaced days later at carry-out time.
//
// The real cmd_submit is exercised with patch_task swapped for a recorder, so
// no Airtable call happens and the assertions are against the payload the
// script would really send. Re-implementing the payload in JS would guard
// nothing.
function submit({ type, output, tier1 = false }) {
  const script = `
import importlib.util, json, sys, tempfile, os, types
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

captured = {}
def fake_patch(task, fields):
    captured['task'] = task
    captured['fields'] = fields
    return {'id': task}
m.patch_task = fake_patch

payload = json.loads(sys.argv[1])
fh = tempfile.NamedTemporaryFile('w', suffix='.md', delete=False)
fh.write(payload['output'])
fh.close()

agent_id = sorted(m.AGENTS)[0]
args = types.SimpleNamespace(task='recTESTTESTTEST01', agent=agent_id,
                             type=payload['type'], output_file=fh.name,
                             tier1=payload['tier1'])
out = {'agentId': agent_id, 'fieldMap': m.AF}
try:
    m.cmd_submit(args)
    out['refused'] = False
except SystemExit as exc:
    out['refused'] = True
    out['error'] = str(exc)
finally:
    os.unlink(fh.name)
out['captured'] = captured
print('---JSON---')
print(json.dumps(out))
`;
  const raw = execFileSync('python3', ['-c', script, JSON.stringify({ type, output, tier1 })],
    { encoding: 'utf8' });
  return JSON.parse(raw.split('---JSON---')[1]);
}

const GOOD_EMAIL = 'TO: someone@example.com\nSUBJECT: A subject\n---\nThe body of the email.';

describe('agent-dispatch submit gate', () => {
  it('clears the previous approval verdict in the same patch (083)', () => {
    const r = submit({ type: 'Drafting', output: 'Some drafted work.' });
    expect(r.refused, r.error).toBe(false);
    const f = r.captured.fields;
    const AF = r.fieldMap;

    // Status moves to Approval — the gate itself.
    expect(f[AF.status]).toBe('Approval');
    // ...and the stale verdict must go with it, or the gate is decorative.
    expect(Object.prototype.hasOwnProperty.call(f, AF.approvalOutcome),
      'submit does not clear Approval Outcome — a resubmitted task still reads as approved').toBe(true);
    expect(f[AF.approvalOutcome]).toBeNull();
    expect(f[AF.approvalFeedback]).toBeNull();
    expect(f[AF.approvedAt]).toBeNull();
  });

  it('accepts a Correspondence output the send gate can parse (085)', () => {
    const r = submit({ type: 'Correspondence', output: GOOD_EMAIL });
    expect(r.refused, r.error).toBe(false);
    expect(r.captured.fields[r.fieldMap.taskType]).toBe('Correspondence');
  });

  it('refuses a Correspondence output the send gate cannot parse (085)', () => {
    const r = submit({
      type: 'Correspondence',
      output: '## THE EMAIL, word for word\n\nDear Fylde Council, I am writing about...',
    });
    expect(r.refused, 'prose submitted as Correspondence was accepted').toBe(true);
    expect(r.error).toMatch(/Correspondence/);
    // Nothing may be written when the submit is refused.
    expect(r.captured.fields).toBeUndefined();
  });

  it('a tier-1 Correspondence submit still parses once the banner is on it (084)', () => {
    const r = submit({ type: 'Correspondence', output: GOOD_EMAIL, tier1: true });
    expect(r.refused, r.error).toBe(false);
    const written = r.captured.fields[r.fieldMap.agentOutput];
    expect(written, 'the tier-1 banner did not reach Agent Output').toContain('TIER 1');
    expect(written).toContain('TO: someone@example.com');
  });

  it('a non-Correspondence type is not forced into the email format', () => {
    const r = submit({ type: 'Research', output: 'A research note with no headers at all.' });
    expect(r.refused, r.error).toBe(false);
  });

  // The other half of 084: the send gate must accept what submit produced.
  // send-email.py's own offline selftest covers the parser, including the
  // tier-1 banner case, and needs no network or Airtable.
  it('the send gate parser selftest passes, banner included', () => {
    const out = execFileSync('python3', [SEND_EMAIL, 'selftest'], { encoding: 'utf8' });
    expect(out).toContain('PASS tier-1 banner stripped');
    expect(out).toContain('PASS banner not left in body');
    expect(out).toMatch(/selftest OK/);
    expect(out, 'a parser check regressed').not.toContain('FAIL ');
  });
});
