// Email attachments for the agents (Kevin, 25 Sep 2026: "a major bottleneck ... they can't read
// attachments or download attachments to emails; any agent who's accessing the Gmail needs to have
// that facility"). These drive the REAL cmd_attachments / cmd_search with the Gmail worker faked,
// saving into a temp folder. Proved live the same day on the PIB renewal (6 PDFs, text extracted).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = JSON.stringify(path.join(root, 'scripts/inbound-triage.py'));

function run(cmd, args = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, base64, io, contextlib
spec = importlib.util.spec_from_file_location("tri", ${SCRIPT})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = json.loads(sys.stdin.read())
calls = []
def b64(s): return base64.urlsafe_b64encode(s.encode()).decode().rstrip("=")
MSG = {"id": "msg1", "subject": "Renewal", "attachments": [
  {"filename": "schedule.pdf", "mimeType": "application/pdf", "size": 20, "attachmentId": "a1"},
  {"filename": "../../../etc/evil name.docx", "mimeType": "application/msword", "size": 10, "attachmentId": "a2"},
  {"filename": "run-me.exe", "mimeType": "application/octet-stream", "size": 10, "attachmentId": "a3"},
  {"filename": "huge.pdf", "mimeType": "application/pdf", "size": 50 * 1024 * 1024, "attachmentId": "a4"}]}
def fake_list(q=None, label_ids=None, max_pages=1, account=None):
    calls.append(["list", q, account]); return [MSG], False
def fake_post(path, payload, sleep=None):
    calls.append(["post", path, payload.get("attachmentId"), payload.get("account")])
    return {"data": b64("%PDF-not-really " + payload["attachmentId"])}
m.worker_list = fake_list; m.worker_post = fake_post
m.fail = lambda msg, kind="error": (_ for _ in ()).throw(SystemExit(msg))
buf = io.StringIO(); err = None
try:
    with contextlib.redirect_stdout(buf):
        if a["cmd"] == "attachments":
            m.cmd_attachments(a.get("q"), a.get("id"), a.get("account"), a["dir"])
        else:
            m.cmd_search(a.get("q"), 5, a.get("account"))
except SystemExit as e:
    err = str(e)
print("---JSON---"); print(json.dumps({"out": buf.getvalue(), "err": err, "calls": calls}))
`], { input: JSON.stringify({ cmd, dir, ...args }), encoding: 'utf8' });
  const r = JSON.parse(out.split('---JSON---')[1]);
  r.dir = dir;
  r.json = r.out ? JSON.parse(r.out) : null;
  return r;
}

describe('agents can read email attachments', () => {
  it('saves documents and images, never an executable or an oversized file, and keeps every file inside its folder', () => {
    const r = run('attachments', { q: 'from:monika@pib.example', account: 'kevinbrittain@gmail.com' });
    expect(r.err).toBeNull();
    const rows = Object.fromEntries(r.json.attachments.map((x) => [x.filename, x]));
    expect(rows['schedule.pdf'].path).toBe(path.join(r.dir, 'msg1', 'schedule.pdf'));
    expect(fs.readFileSync(rows['schedule.pdf'].path, 'utf8')).toBe('%PDF-not-really a1');
    expect(rows['evil name.docx'].path).toBe(path.join(r.dir, 'msg1', 'evil name.docx'));   // no climbing out
    expect(rows['run-me.exe'].skipped).toMatch(/never saved/);
    expect(rows['huge.pdf'].skipped).toMatch(/over 10 MB/);
    expect(fs.readdirSync(path.join(r.dir, 'msg1')).sort()).toEqual(['evil name.docx', 'schedule.pdf']);
    // the attachment is fetched from the mailbox that was searched
    expect(r.calls.filter((c) => c[0] === 'post').map((c) => [c[2], c[3]])).toEqual([['a1', 'kevinbrittain@gmail.com'], ['a2', 'kevinbrittain@gmail.com']]);
  });

  it('refuses a mailbox the worker is not connected to, and a query that is missing', () => {
    expect(run('attachments', { q: 'x', account: 'someone@else.example' }).err).toMatch(/must be one of/);
    expect(run('attachments', {}).err).toMatch(/needs --q/);
  });

  it('--id narrows to one message and says so when it is not there', () => {
    expect(run('attachments', { q: 'x', id: 'nope' }).err).toMatch(/no message nope among those the query found/);
  });

  it('search now shows what is attached, so an agent knows there is something to read', () => {
    const r = run('search', { q: 'from:monika@pib.example', account: 'kevinbrittain@gmail.com' });
    expect(r.json.messages[0].attachments.map((a) => a.filename)).toEqual(['schedule.pdf', '../../../etc/evil name.docx', 'run-me.exe', 'huge.pdf']);
  });
});
