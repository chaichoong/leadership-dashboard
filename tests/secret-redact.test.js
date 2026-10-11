import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const py = (code) =>
  execFileSync('python3', ['-c', code], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, OD_NO_NET: '1' } });

// Finding 20261010-phase-5-822: a live Anthropic key reached an OPEN Airtable task's Notes because
// Kevin pasted it into a card's feedback box and the write path stored his words verbatim. These
// tests DRIVE the real write function with the real key shape — the only thing stubbed is the
// network call, so what is asserted is what Airtable would have been sent.

describe('secret_redact: the helper, back-tested on real token shapes', () => {
  it('passes its own selftest', () => {
    expect(py('import sys; sys.path.insert(0,"scripts"); import secret_redact; secret_redact.selftest()'))
      .toContain('selftest: ok');
  });
});

describe('agent-dispatch patch_task: no credential can reach a task field', () => {
  const drive = (fields) => `
import importlib.util, json, sys
sys.path.insert(0, "scripts")
spec = importlib.util.spec_from_file_location("ad", "scripts/agent-dispatch.py")
ad = importlib.util.module_from_spec(spec); spec.loader.exec_module(ad)
sent = {}
def fake_request(method, path, body=None, **kw):
    sent["method"], sent["path"], sent["body"] = method, path, body
    return {"id": "recTEST"}
ad._request = fake_request
ad.patch_task("recTEST", ${JSON.stringify(fields)})
print(json.dumps(sent))
`;

  it('redacts an Anthropic key pasted into card feedback, keeping the rest of the words', () => {
    const key = 'sk-ant-api03-' + 'A1b2C3d4E5'.repeat(10);
    const out = JSON.parse(
      py(drive({ fldR7apBzSp3oxFxz: `Replace Karlo's CLAUDE_AI_KEY secret. The new key is ${key} — use that one.` }))
    );
    const notes = out.body.fields.fldR7apBzSp3oxFxz;
    expect(notes).not.toContain(key);
    expect(notes).toContain('sk-ant-REDACTED');
    expect(notes).toContain("Replace Karlo's CLAUDE_AI_KEY secret.");
    expect(out.method).toBe('PATCH');
  });

  it('redacts an Airtable PAT and a GitHub token in any field, not just Notes', () => {
    const pat = 'patAbCdEfGhIjKl.1234567890abcdefghijklmnopqrstuvwxyz0123456789';
    const gh = 'ghp_' + 'x'.repeat(36);
    const out = JSON.parse(
      py(drive({ fldRGhBQViKZKtkQ6: `use ${pat}`, 'Agent Output': `and ${gh}` }))
    );
    const f = out.body.fields;
    expect(JSON.stringify(f)).not.toContain(pat);
    expect(JSON.stringify(f)).not.toContain(gh);
    expect(f.fldRGhBQViKZKtkQ6).toContain('patREDACTED');
    expect(f['Agent Output']).toContain('ghp_REDACTED');
  });

  it('leaves ordinary task text, numbers and links exactly as they were', () => {
    const plain = 'Rotate the sk-ant- key in the Anthropic console. Key fob for 12 Dalham Road. keyword search found nothing.';
    const out = JSON.parse(
      py(drive({ fldR7apBzSp3oxFxz: plain, 'Time Estimate': 45, Status: 'Approval' }))
    );
    expect(out.body.fields.fldR7apBzSp3oxFxz).toBe(plain);
    expect(out.body.fields['Time Estimate']).toBe(45);
    expect(out.body.fields.Status).toBe('Approval');
  });

  it('still sets typecast, so the redaction did not change how the write behaves', () => {
    const out = JSON.parse(py(drive({ Status: 'Approval' })));
    expect(out.body.typecast).toBe(true);
    expect(out.path).toContain('recTEST');
  });
});
