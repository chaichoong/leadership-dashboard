import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// 20260819-agent-dispatch-238.
//
// `route` accepts the 17 agent records only. `escalate` always means Kevin.
// So an APPROVED action of the form "reassign this to Mica" had no command that
// could carry it out: the approval stood, nothing moved, and the task came back
// round the queue every run. `handover` is that exit.
//
// The real cmd_handover runs with patch_task and get_task swapped for
// recorders, so no Airtable call happens and the assertions are against the
// payload the script would really send.
function handover({ to, reason = '', notes = '' }) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
captured = {}
m.get_task = lambda tid: {"id": tid, "fields": {m.AF["notes"]: ${JSON.stringify(notes)}}}
def fake_patch(tid, fields):
    captured['task'] = tid
    captured['fields'] = fields
    return {}
m.patch_task = fake_patch
class A: pass
a = A(); a.task = 'recTEST'; a.to = ${JSON.stringify(to)}; a.reason = ${JSON.stringify(reason)}
try:
    m.cmd_handover(a)
    err = ''
except SystemExit as e:
    err = str(e)
print('@@@' + json.dumps({
    'captured': captured, 'error': err,
    'fieldMap': {k: v for k, v in m.AF.items()},
    'humans': m.HUMANS,
}))
`;
  const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  const parsed = JSON.parse(out.slice(out.indexOf('@@@') + 3));
  return { ...parsed, refused: Boolean(parsed.error) };
}

describe('agent-dispatch handover', () => {
  it('points Team Member and Assignee at the named human', () => {
    const r = handover({ to: 'micaa.work@gmail.com', reason: 'Kevin approved reassignment' });
    expect(r.refused, r.error).toBe(false);
    expect(r.captured.fields[r.fieldMap.teamMember]).toEqual([r.humans['micaa.work@gmail.com'].rec]);
    expect(r.captured.fields[r.fieldMap.assignee]).toEqual({ email: 'micaa.work@gmail.com' });
  });

  it('clears the agent link, or the task is worked again tomorrow', () => {
    const r = handover({ to: 'atentaerica@gmail.com' });
    const link = r.captured.fields[r.fieldMap.teamMember];
    expect(link).toHaveLength(1);
    expect(link[0]).toBe(r.humans['atentaerica@gmail.com'].rec);
  });

  it('does NOT mark the task Completed — it changed hands, it is not done', () => {
    const r = handover({ to: 'micaa.work@gmail.com' });
    expect(Object.keys(r.captured.fields)).not.toContain(r.fieldMap.status);
    expect(Object.keys(r.captured.fields)).not.toContain(r.fieldMap.completion);
  });

  it('records who handed it over and why, without overwriting existing notes', () => {
    const r = handover({ to: 'micaa.work@gmail.com', reason: 'needs a phone call', notes: 'Kevin wrote this.' });
    const written = r.captured.fields[r.fieldMap.notes];
    expect(written).toContain('Kevin wrote this.');
    expect(written).toContain('Mica Albovias');
    expect(written).toContain('needs a phone call');
  });

  it('refuses an address that is not on the team, rather than writing it', () => {
    // Airtable accepts an unknown email without complaint, so the task would
    // point at nobody and look assigned.
    const r = handover({ to: 'someone@example.com' });
    expect(r.refused, 'an unknown address was written to a real task').toBe(true);
    expect(r.captured.fields, 'a refused handover still patched Airtable').toBeUndefined();
    expect(r.error).toMatch(/micaa\.work@gmail\.com/);
  });

  it('refuses an agent record ID — handover is for humans, route is for agents', () => {
    const r = handover({ to: 'recAnfU9fEaK8hFtk' });
    expect(r.refused).toBe(true);
  });

  it('is case-insensitive about the address, since Airtable is not consistent', () => {
    const r = handover({ to: 'Micaa.Work@Gmail.com' });
    expect(r.refused, r.error).toBe(false);
  });

  it('verify knows the handover kind, so handed-over work does not alarm', () => {
    const src = execFileSync('cat', [DISPATCH], { encoding: 'utf8' });
    const verify = src.slice(src.indexOf('def cmd_verify('));
    expect(verify, 'verify would report a handover as an unfinished action')
      .toMatch(/elif kind == "handover":/);
    // And it must check the human landed, not just accept the claim.
    expect(verify).toMatch(/HUMANS\.get\(to\)/);
  });

  it('the subcommand is wired into the parser and the dispatch table', () => {
    const help = execFileSync('python3', [DISPATCH, '--help'], { encoding: 'utf8' });
    expect(help).toContain('handover');
  });
});
