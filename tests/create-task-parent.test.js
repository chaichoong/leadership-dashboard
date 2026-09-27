import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = resolve(ROOT, 'scripts/create-agent-task.py');

// Finding 20260924-agent-dispatch-590 (25 Sep 2026). recPFxDmGX5pbonD2 was approved to
// raise one quote-request email per contractor as tasks of their own. The fold gate
// matched each to the open sibling recIJ4zuu2B7kSW6p ("quote request eicr") and folded
// it in, so the emails could never be raised. `--parent` creates the child as its own
// task, only for an open, really approved parent; the refusals still run.
function create(parent, parentFields, extra = {}, twins = []) {
  return JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, io, contextlib
spec = importlib.util.spec_from_file_location('g', ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
F = g.F
calls = []
PARENT = json.loads(${JSON.stringify(JSON.stringify(parentFields))})
TWINS = json.loads(${JSON.stringify(JSON.stringify(twins))})
def req(method, path, body=None):
    calls.append([method, path.split("?")[0]])
    if method == "GET" and "filterByFormula" in path:
        return {"records": [{"id": t[0], "fields": {F["name"]: t[1] or fields[F["name"]]}} for t in TWINS]}
    if method == "GET":
        return {"id": "recPFxDmGX5pbonD2", "createdTime": "2026-09-20T09:00:00.000Z",
                "fields": {F[k]: v for k, v in PARENT.items()}}
    if method == "POST":
        return {"id": "recNEWCHILD000001", "fields": body["fields"]}
    return {}
g._request = req
g.load_scan_cache = lambda: {}
g.write_track_record = lambda tid, fields: None
def board():
    raise RuntimeError("the fold gate read the board")
g.fetch_open_tasks = board
fields = {F["name"]: "COMPLIANCE: EICR quote request - Conaty & Co - 23 Viola Street Bootle L20 7DR",
          F["status"]: "Today", F["desc"]: "Ask Conaty & Co for an EICR quote."}
fields.update(json.loads(${JSON.stringify(JSON.stringify(extra))}))
out = io.StringIO(); err = None
try:
    with contextlib.redirect_stdout(out):
        rc = g.cmd_create(fields, parent=json.loads(${JSON.stringify(JSON.stringify(parent))}))
except Exception as e:
    rc, err = None, str(e)
posted = [c for c in calls if c[0] == "POST"]
print(json.dumps({"rc": rc, "err": err, "out": out.getvalue().strip(), "posted": len(posted)}))`], { encoding: 'utf8' }));
}

const APPROVED = { status: 'Today', approvalOutcome: 'Approved as-is', approvedAt: '2026-09-23T10:00:00.000Z', sentForApprovalBy: ['recwWvBju2ycB63i4'] };

describe('create --parent: a child of an approved task is created, never folded', () => {
  it('an open, really approved parent: created as its own task, the fold never runs, the child names its parent', () => {
    const r = create('recPFxDmGX5pbonD2', APPROVED);
    expect(r.err).toBeNull();
    expect(r.rc).toBe(0);
    expect(r.posted).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ action: 'created', taskId: 'recNEWCHILD000001' });
  });

  it('refuses an unapproved, a stringly-approved or a completed parent, and creates nothing', { timeout: 30000 }, () => {
    for (const bad of [
      { ...APPROVED, approvalOutcome: 'Changes requested' },
      { ...APPROVED, approvedAt: '' },                       // the string alone is not an approval
      { ...APPROVED, sentForApprovalBy: [] },
      { ...APPROVED, status: 'Completed' },
      { ...APPROVED, status: 'Cancelled' },
      { ...APPROVED, approvedAt: '2026-09-19T09:00:00.000Z' },   // approved before the task existed: copied, not given
    ]) {
      const r = create('recPFxDmGX5pbonD2', bad);
      expect(r.rc, JSON.stringify(bad)).toBe(3);
      expect(JSON.parse(r.out).reason).toMatch(/^--parent refused: the parent recPFxDmGX5pbonD2/);
      expect(r.posted).toBe(0);
    }
  });

  it('a retried --parent create returns the open child it already made, and creates nothing', () => {
    const r = create('recPFxDmGX5pbonD2', APPROVED, {}, [['recFIRSTCHILD0001', '']]);
    expect(r.rc).toBe(0);
    expect(r.posted).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ action: 'exists', taskId: 'recFIRSTCHILD0001' });
  });

  it("a second contractor's child is created, not taken for the first (the fold key is the same for both)", () => {
    const r = create('recPFxDmGX5pbonD2', APPROVED, {}, [['recFIRSTCHILD0001', 'COMPLIANCE: EICR quote request - Sparks Electrical - 23 Viola Street Bootle L20 7DR']]);
    expect(r.rc).toBe(0);
    expect(r.posted).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ action: 'created' });
  });

  it('without --parent the same task still goes through the fold gate (the board is read)', () => {
    const r = create(null, APPROVED);
    expect(r.err).toMatch(/the fold gate read the board/);
  });
});
