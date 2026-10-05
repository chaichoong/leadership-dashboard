// Email attachments for the agents (Kevin, 25 Sep 2026: "a major bottleneck ... they can't read
// attachments or download attachments to emails; any agent who's accessing the Gmail needs to have
// that facility"). These drive the REAL cmd_attachments / cmd_search with the Gmail worker faked,
// saving into a temp folder. Proved live the same day on the PIB renewal (6 PDFs, text extracted).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  {"filename": "huge.pdf", "mimeType": "application/pdf", "size": 50 * 1024 * 1024, "attachmentId": "a4"}] + a.get("extra", [])}
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
        elif a["cmd"] == "name":
            print(json.dumps([m.safe_attachment_name(n) for n in a["names"]]))
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

  // 5 Oct 2026: a 130-character screencapture PDF was cut to 120 characters with its ".pdf", so the
  // allow-list read no extension and skipped it as "not a document or image".
  const fp = (s) => '-' + createHash('sha1').update(s).digest('hex').slice(0, 8);
  const prefix = 'screencapture-example-service-gov-uk-identity-check-complete-2026-01-02-';
  const longName = (tail) => prefix + 'x'.repeat(146 - prefix.length - tail.length) + tail + '.pdf';

  it('a long file name is cut in its stem, so a 150-character PDF keeps ".pdf" and is saved', () => {
    const long = longName('');
    expect(long.length).toBe(150);
    const [cut, noExt, hugeExt, short] = run('name', { names: [long, 'y'.repeat(150), 'a.pdf' + 'b'.repeat(150), 'schedule.pdf'] }).json;
    expect(cut).toBe(prefix + 'x'.repeat(107 - prefix.length) + fp(long) + '.pdf');
    expect(cut.length).toBe(120);
    expect(noExt).toBe('y'.repeat(111) + fp('y'.repeat(150)));
    expect(hugeExt).toBe('a.pdf' + 'b'.repeat(115));   // an extension too long to keep is not one
    expect(short).toBe('schedule.pdf');

    const r = run('attachments', { q: 'x', extra: [{ filename: long, mimeType: 'application/pdf', size: 20, attachmentId: 'a5' }] });
    const row = r.json.attachments.find((x) => x.filename.startsWith('screencapture-'));
    expect(row.filename).toBe(cut);
    expect(row.skipped).toBeUndefined();
    expect(row.path).toBe(path.join(r.dir, 'msg1', cut));
    expect(fs.readFileSync(row.path, 'utf8')).toBe('%PDF-not-really a5');
  });

  it('two long names that differ only past the cut are two files, never one overwriting the other', () => {
    const first = longName('14_03_01'), second = longName('14_07_44');
    const r = run('attachments', { q: 'x', extra: [
      { filename: first, mimeType: 'application/pdf', size: 20, attachmentId: 'a6' },
      { filename: second, mimeType: 'application/pdf', size: 20, attachmentId: 'a7' }] });
    const rows = r.json.attachments.filter((x) => x.filename.startsWith('screencapture-'));
    expect(rows).toHaveLength(2);
    expect(rows[0].path).not.toBe(rows[1].path);
    expect(rows.map((x) => fs.readFileSync(x.path, 'utf8'))).toEqual(['%PDF-not-really a6', '%PDF-not-really a7']);
  });

  it('search now shows what is attached, so an agent knows there is something to read', () => {
    const r = run('search', { q: 'from:monika@pib.example', account: 'kevinbrittain@gmail.com' });
    expect(r.json.messages[0].attachments.map((a) => a.filename)).toEqual(['schedule.pdf', '../../../etc/evil name.docx', 'run-me.exe', 'huge.pdf']);
  });
});
