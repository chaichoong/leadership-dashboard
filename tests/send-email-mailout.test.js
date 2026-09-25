// TO-EACH mail-outs (Kevin, 25 Sep 2026, the tenant-finding chain). One approved card sends the
// SAME approved words to each address as a separate email, so thirty council and charity contacts
// cost Kevin one approval and none of them sees the others.
//
// These drive the REAL parse_output() and send_each() with the worker and Airtable replaced by
// fakes and the ledger pointed at a temp file, so what is tested is what sends. Back-tested by
// (a) making mailout_progress() return empty sets: the resume and never-twice cases fail, and
// (b) dropping the per-address `to`: the "each separately" case fails.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = JSON.stringify(path.join(root, 'scripts/send-email.py'));

const OUT3 = 'TO-EACH: a@council.gov.uk, b@charity.org.uk, c@probation.gov.uk\n'
  + 'FROM: info@agilelets.co.uk\nSUBJECT: Rooms for single adults aged 35+ on Universal Credit\n---\n'
  + 'Hello,\n\nWe have rooms in Haverhill.\n\nKind regards\nRoy Lavin\nAgile Lets';

function run(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailout-'));
  const ledger = path.join(dir, 'sent-email.jsonl');
  if (opts.ledgerRows) fs.writeFileSync(ledger, opts.ledgerRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, argparse
sys.argv = ["send-email.py"]
spec = importlib.util.spec_from_file_location("se", ${SCRIPT})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = json.loads(sys.stdin.read())
m.SENT_LEDGER = a["ledger"]; m.STATE_DIR = a["dir"]; m.MAILOUT_PAUSE_SECONDS = 0
calls, patches = [], []
F = {m.AF["name"]: "TENANT MAIL-OUT: Haverhill", m.AF["agentOutput"]: a["output"],
     m.AF["taskType"]: {"name": "Correspondence"}, m.AF["status"]: {"name": "Approval"},
     m.AF["approvalOutcome"]: {"name": a.get("outcome", "Approved as-is")}}
m.get_task = lambda tid: {"id": tid, "createdTime": "2026-09-25T09:00:00.000Z", "fields": F}
m.approval_evidence_problem = lambda f, created: ""
m.load_approved.__globals__["approval_evidence_problem"] = lambda f, created: ""
def fake_worker(url, payload=None):
    calls.append(payload)
    if payload and payload.get("to") in a.get("failOn", []):
        sys.exit(a.get("failWith", "ERROR: worker 500: boom"))
    return {"id": "msg-%d" % len(calls)}
m.worker_call = fake_worker
m.api = lambda method, url, payload=None: patches.append(payload) or {}
res = {"calls": calls, "patches": patches}
try:
    m.cmd_send(argparse.Namespace(task="recMAILOUT", dry_run=a.get("dryRun", False), rule=None))
    res["exit"] = 0
except SystemExit as e:
    res["exit"] = e.code if isinstance(e.code, int) else 1
    res["message"] = str(e)
rows = []
try:
    rows = [json.loads(l) for l in open(a["ledger"]) if l.strip()]
except FileNotFoundError:
    pass
res["ledger"] = rows
print("RESULT " + json.dumps(res))
`], { input: JSON.stringify({ output: opts.output || OUT3, ledger, dir, ...opts }), encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  return { ...JSON.parse(line.slice(7)), stdout: out };
}

function parse(output) {
  const out = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(root, 'scripts'))})
from agent_email_format import parse_output, rule_send_problem, EmailFormatError
try:
    p = parse_output(sys.stdin.read())
    print(json.dumps({"ok": True, "toEach": p["toEach"], "to": p["to"],
                      "rule": rule_send_problem("quote-request", p, {"name": "COMPLIANCE: x", "notes": "", "taskType": "Correspondence"}, require_stamp=False)}))
except EmailFormatError as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`], { input: output, encoding: 'utf8' });
  return JSON.parse(out.trim());
}

describe('TO-EACH format', () => {
  it('parses a mail-out and keeps TO empty', () => {
    const p = parse(OUT3);
    expect(p.ok).toBe(true);
    expect(p.toEach).toEqual(['a@council.gov.uk', 'b@charity.org.uk', 'c@probation.gov.uk']);
    expect(p.to).toEqual([]);
  });
  it('is never sent by rule', () => {
    expect(parse(OUT3).rule).toMatch(/TO-EACH/);
  });
  it.each([
    ['TO and TO-EACH together', OUT3.replace('FROM:', 'TO: x@y.com\nFROM:'), /TO and TO-EACH/],
    ['CC', OUT3.replace('FROM:', 'CC: x@y.com\nFROM:'), /CC is not allowed/],
    ['ATTACH', OUT3.replace('FROM:', 'ATTACH: /tmp/a.pdf\nFROM:'), /ATTACH is not allowed/],
    ['a repeated address', OUT3.replace('c@probation.gov.uk', 'A@council.gov.uk'), /twice/],
    ['more than 50', OUT3.replace(/TO-EACH: [^\n]+/, 'TO-EACH: ' + Array.from({ length: 51 }, (_, i) => `p${i}@x.org`).join(', ')), /at most|most one card/],
  ])('refuses %s', (_, output, why) => {
    const p = parse(output);
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(why);
  });
});

describe('a long visible TO line is refused at submit', () => {
  it('eleven addresses on TO are refused with the fix named (TO-EACH); ten are fine', () => {
    const res = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(root, 'scripts'))})
from agent_email_format import validate_submission, EmailFormatError
def out(n):
    to = ", ".join("p%d@x.org" % i for i in range(n))
    return "TO: " + to + "\\nFROM: info@agilelets.co.uk\\nSUBJECT: Rooms\\n---\\nHello.\\n\\nKind regards\\nRoy Lavin"
r = {}
for n in (10, 11):
    try:
        validate_submission(out(n)); r[n] = "ok"
    except EmailFormatError as e:
        r[n] = str(e)
print(json.dumps(r))
`], { encoding: 'utf8' });
    const r = JSON.parse(res.trim());
    expect(r['10']).toBe('ok');
    expect(r['11']).toMatch(/TO-EACH/);
  });
});

describe('send_each', () => {
  it('sends each address separately, the approved words verbatim, and stamps the task', () => {
    const r = run({});
    expect(r.exit).toBe(0);
    expect(r.calls.map((c) => c.to)).toEqual(['a@council.gov.uk', 'b@charity.org.uk', 'c@probation.gov.uk']);
    for (const c of r.calls) {
      expect(c.to).not.toMatch(/,/);
      expect(c.cc).toBeUndefined();
      expect(c.from).toBe('info@agilelets.co.uk');
      expect(c.text).toContain('We have rooms in Haverhill.');
    }
    expect(r.ledger.filter((x) => x.event === 'sent')).toHaveLength(3);
    expect(JSON.stringify(r.patches)).toMatch(/3 of 3 done/);
  });

  it('resumes after a crash without a second copy to the address that was in flight', () => {
    const r = run({ ledgerRows: [{ task: 'recMAILOUT', recipient: 'a@council.gov.uk', event: 'intent' }] });
    expect(r.exit).toBe(0);
    expect(r.calls.map((c) => c.to)).toEqual(['b@charity.org.uk', 'c@probation.gov.uk']);
  });

  it('a refusal that proves nothing left (403) is retried next run, and the card says PARTIAL, not SENT', () => {
    const first = run({ failOn: ['b@charity.org.uk'], failWith: 'ERROR: the worker rejected the key in x' });
    expect(first.exit).toBe(1);
    expect(first.calls.map((c) => c.to)).toEqual(['a@council.gov.uk', 'b@charity.org.uk']);
    expect(first.ledger.find((x) => x.recipient === 'b@charity.org.uk' && x.event === 'failed')).toBeTruthy();
    expect(JSON.stringify(first.patches)).toMatch(/PARTIAL: mail-out/);
    expect(JSON.stringify(first.patches)).not.toMatch(/SENT: mail-out/);
    const second = run({ ledgerRows: first.ledger });
    expect(second.exit).toBe(0);
    expect(second.calls.map((c) => c.to)).toEqual(['b@charity.org.uk', 'c@probation.gov.uk']);
    expect(JSON.stringify(second.patches)).toMatch(/SENT: mail-out/);
  });

  it('a worker 500 that says Gmail refused the message is retried: nothing left', () => {
    const first = run({ failOn: ['b@charity.org.uk'], failWith: 'ERROR: worker 500: {"error":"Gmail send failed: 400 invalid"}' });
    expect(first.ledger.find((x) => x.recipient === 'b@charity.org.uk' && x.event === 'failed')).toBeTruthy();
    const second = run({ ledgerRows: first.ledger });
    expect(second.calls.map((c) => c.to)).toEqual(['b@charity.org.uk', 'c@probation.gov.uk']);
  });

  it('a worker 500 or a timeout may have sent: never resent, reported UNCERTAIN', () => {
    const first = run({ failOn: ['b@charity.org.uk'], failWith: 'ERROR: worker 500: boom' });
    expect(first.ledger.find((x) => x.recipient === 'b@charity.org.uk' && x.event === 'uncertain')).toBeTruthy();
    const second = run({ ledgerRows: first.ledger });
    expect(second.calls.map((c) => c.to)).toEqual(['c@probation.gov.uk']);
    expect(JSON.stringify(second.patches)).toMatch(/UNCERTAIN[^"]*b@charity.org.uk/);
  });

  it('refuses to send a finished mail-out twice', () => {
    const done = ['a@council.gov.uk', 'b@charity.org.uk', 'c@probation.gov.uk']
      .map((x) => ({ task: 'recMAILOUT', recipient: x, event: 'sent' }));
    const r = run({ ledgerRows: done });
    expect(r.exit).not.toBe(0);
    expect(r.message).toMatch(/already went to all 3/);
    expect(r.calls).toHaveLength(0);
  });

  it('a dry run lists who would get it and sends nothing', () => {
    const r = run({ dryRun: true, ledgerRows: [{ task: 'recMAILOUT', recipient: 'a@council.gov.uk', event: 'sent' }] });
    expect(r.exit).toBe(0);
    expect(r.calls).toHaveLength(0);
    expect(r.stdout).toMatch(/"wouldSendTo": \[\s*"b@charity.org.uk",\s*"c@probation.gov.uk"\s*\]/);
  });

  it('refuses a card Kevin has not approved', () => {
    const r = run({ outcome: '' });
    expect(r.exit).not.toBe(0);
    expect(r.message).toMatch(/not approved/);
    expect(r.calls).toHaveLength(0);
  });
});
