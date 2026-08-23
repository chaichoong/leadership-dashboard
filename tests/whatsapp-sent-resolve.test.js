// Findings 20260815-149, 20260818-202, 20260819-234, 20260820-261, 20260822-305
// and 20260823-321 — six reports of ONE bug, filed over eight days.
//
// scripts/whatsapp-sweep.py `sent` matched `ZWACHATSESSION.ZCONTACTJID = ?`
// exactly. Step 5 of the inbound sweep writes "sender handle or chat name" into
// Inbound Sender, so some tasks store a DISPLAY NAME. A name matches no chat,
// the query returns no rows, and the command printed
// {"found": false, "outgoing_checked": 0} and exited 0 — which is exactly what
// a genuinely quiet chat looks like. Step 2b therefore read "Kevin never
// replied" for those tasks on every run, so they could never auto-close.
//
// Proven live 20 Aug 2026: JID 447881924047@s.whatsapp.net returned 3 outgoing
// matches; "Roy Lavin", the same chat, returned 0. Same class as the
// filterByFormula silent zero: a lookup that CANNOT match reads as a clean
// negative.
//
// The real functions run against a temporary SQLite file shaped like WhatsApp's.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SWEEP = resolve(ROOT, 'scripts/whatsapp-sweep.py');

// chats: [[jid, name], ...]   outgoing: [[jid, text, hoursAgo], ...]
function sent(identifier, { chats, outgoing = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-'));
  const db = join(dir, 'ChatStorage.sqlite');
  try {
    const script = `
import importlib.util, json, sqlite3, io, contextlib, sys, time
spec = importlib.util.spec_from_file_location('wa', ${JSON.stringify(SWEEP)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
db = ${JSON.stringify(db)}
con = sqlite3.connect(db)
con.execute("CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID TEXT, ZPARTNERNAME TEXT)")
con.execute("CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, ZCHATSESSION INTEGER, ZISFROMME INTEGER, ZMESSAGEDATE REAL, ZMESSAGETYPE INTEGER, ZTEXT TEXT)")
pk = {}
for i, (jid, name) in enumerate(json.loads(${JSON.stringify(JSON.stringify(chats))}), start=1):
    con.execute("INSERT INTO ZWACHATSESSION VALUES (?,?,?)", (i, jid, name))
    pk.setdefault(jid, i)
now = m.now_apple_ts()
for j, (jid, text, hours) in enumerate(json.loads(${JSON.stringify(JSON.stringify(outgoing))}), start=1):
    con.execute("INSERT INTO ZWAMESSAGE VALUES (?,?,?,?,?,?)",
                (j, pk[jid], 1, now - hours * 3600, m.TEXT_MESSAGE_TYPE, text))
con.commit(); con.close()
m.DB_PATH = db
buf, err = io.StringIO(), io.StringIO()
with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(err):
    rc = m.sent_check(${JSON.stringify(identifier)}, None, 48)
body = (buf.getvalue() or err.getvalue()).strip()
print('@@@' + json.dumps({"rc": rc, "out": json.loads(body) if body else None}))
`;
    const raw = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
    return JSON.parse(raw.slice(raw.indexOf('@@@') + 3));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ROY = ['447881924047@s.whatsapp.net', 'Roy Lavin'];
const SAM = ['447756646045@s.whatsapp.net', 'Sam Atherton'];

describe('whatsapp sent — a name must not read as "no reply"', () => {
  it('finds the reply when given the JID (the case that always worked)', () => {
    const r = sent(ROY[0], { chats: [ROY], outgoing: [[ROY[0], 'on my way', 2]] });
    expect(r.rc).toBe(0);
    expect(r.out.found).toBe(true);
    expect(r.out.resolved_via).toBe('jid');
  });

  it('finds the SAME reply when given the chat name — the bug', () => {
    const r = sent('Roy Lavin', { chats: [ROY], outgoing: [[ROY[0], 'on my way', 2]] });
    expect(r.rc).toBe(0);
    expect(r.out.found, 'a chat name still reads as "Kevin never replied"').toBe(true);
    expect(r.out.resolved_jid).toBe(ROY[0]);
    expect(r.out.resolved_via).toBe('name');
  });

  it('matches the name whatever the case and spacing', () => {
    const r = sent('  roy lavin ', { chats: [ROY], outgoing: [[ROY[0], 'hi', 1]] });
    expect(r.out.found).toBe(true);
  });

  it('exits 2 on an identifier that matches nothing, instead of found:false', () => {
    // The heart of it. "I could not find this chat" and "this chat is quiet"
    // were the same answer, so a broken lookup read as a clean negative.
    const r = sent('Somebody Not In WhatsApp', { chats: [ROY, SAM] });
    expect(r.rc, 'an unresolvable identifier still exited 0').toBe(2);
    expect(r.out.resolved).toBe(false);
    expect(r.out.found).toBeNull();
    expect(r.out.error).toMatch(/unresolved identifier/);
  });

  it('exits 2 rather than guessing when two chats share a name', () => {
    const r = sent('Roy Lavin', { chats: [ROY, ['447900000009@s.whatsapp.net', 'Roy Lavin']] });
    expect(r.rc).toBe(2);
    expect(r.out.error).toMatch(/ambiguous/);
  });

  it('still reports a genuinely quiet chat as no reply, resolved', () => {
    // The answer that must stay distinguishable from the one above.
    const r = sent('Sam Atherton', { chats: [ROY, SAM], outgoing: [[ROY[0], 'to roy only', 1]] });
    expect(r.rc).toBe(0);
    expect(r.out.found).toBe(false);
    expect(r.out.resolved, 'a quiet chat must still say it was found').toBe(true);
    expect(r.out.outgoing_checked).toBe(0);
  });

  it('exits 2 on an empty identifier rather than scanning nothing', () => {
    expect(sent('', { chats: [ROY] }).rc).toBe(2);
  });
});
