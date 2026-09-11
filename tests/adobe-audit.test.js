// Kevin's ruling, 8 Sep 2026: a document signed through Adobe Sign goes out
// with Adobe's Final Audit Report as its last pages. The module proves the
// pages are there and appends them; both send scripts refuse without them
// (signed before 9 Sep 2026: excused); signature-watch fetches and appends
// the report when it downloads the signed copy.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('the audit report travels with the signed document', () => {
  it('the module selftest passes (recognises the pages, appends them, dates the rule)', () => {
    const out = execFileSync('python3', [join(ROOT, 'scripts', 'adobe_audit.py'), 'selftest'], { encoding: 'utf8' });
    expect(out).toMatch(/selftest OK/);
  });
  it('both send scripts know a signed document (stamp or signed_ name) and refuse it without the report', () => {
    for (const script of ['send-letter.py', 'send-email.py']) {
      const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location('s', ${JSON.stringify(join(ROOT, 'scripts', script))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([
  m.signed_via_adobe('r', '/x/loa.pdf', notes='[03 Sep 2026 10:00 — signature-watch] SIGNED COPY BACK: LOA came back signed. Signed PDF: /Users/k/attachments/loa.pdf\\nNEXT (gate 2): post it'),
  m.signed_via_adobe('r', '/x/signed_recX_LOA.pdf', notes=''),
  m.signed_via_adobe('r', '/x/loa.pdf', notes='nothing here'),
  m.signed_via_adobe('r', '/x/restraint-order-pages-1-3.pdf', notes='[03 Sep 2026 10:00 — signature-watch] SIGNED COPY BACK: LOA came back signed. Signed PDF: /Users/k/attachments/loa.pdf'),
]))`], { encoding: 'utf8' });
      // The stamped file is signed; a different file on the same task is not.
      expect(JSON.parse(out)).toEqual(['03 Sep 2026', null, false, false]);
      const src = readFileSync(join(ROOT, 'scripts', script), 'utf8');
      expect(src).toMatch(/from adobe_audit import audit_problem/);
      expect(src).toMatch(/problem = audit_problem\(real, signed_on\)/);
      expect(src).toMatch(/sys\.exit\(f"REFUSED: task \{task_id\} — \{problem\}"\)/);
    }
  });
  it('signature-watch fetches the audit report, appends it through the module, and records ok or the reason', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'signature-watch.js'), 'utf8');
    expect(src).toMatch(/async function downloadAuditReport/);
    expect(src).toMatch(/Download Audit Report/);
    expect(src).toMatch(/adobe_audit\.py'\), 'append'/);
    expect(src).toMatch(/audit: audit\.ok, auditNote: audit\.note/);
    expect(src.indexOf('await download.saveAs(out)')).toBeLessThan(src.indexOf('await downloadAuditReport(page, item, out)'));
  });
  it('the guardrail carries the rule in words agents read', () => {
    const g = readFileSync(join(process.env.HOME, '.claude', 'agents', 'GUARDRAILS.md'), 'utf8');
    expect(g).toMatch(/Final Audit Report as its last pages/);
    expect(g).toMatch(/adobe_audit\.py append/);
  });
});
