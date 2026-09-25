// WhatsApp read-only lookup (Kevin, 25 Sep 2026). WhatsApp left agent work on 24 Aug ("Kevin's own
// channel"); on 25 Sep he allowed agents to READ the recent messages of ONE named contact or number
// for the task in hand. Never a sweep, never a send or a draft. These run the REAL lookup against a
// throwaway database with WhatsApp's table layout, never his chats. Proved live the same day from a
// robot-style run: 863 chats searched.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(root, 'scripts/whatsapp-sweep.py');

function db(sessions, messages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));
  const p = path.join(dir, 'ChatStorage.sqlite');
  execFileSync('python3', ['-c', `
import sqlite3, json, sys, time
a = json.loads(sys.stdin.read())
c = sqlite3.connect(${JSON.stringify(p)})
c.executescript("""CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID TEXT, ZPARTNERNAME TEXT);
CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZCONTACTNAME TEXT, ZMEMBERJID TEXT);
CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, ZTEXT TEXT, ZISFROMME INTEGER, ZMESSAGEDATE REAL, ZCHATSESSION INTEGER, ZGROUPMEMBER INTEGER);""")
now = time.time() - 978307200
for s in a["s"]: c.execute("INSERT INTO ZWACHATSESSION VALUES (?,?,?)", s)
for m in a["m"]: c.execute("INSERT INTO ZWAMESSAGE (ZTEXT, ZISFROMME, ZMESSAGEDATE, ZCHATSESSION, ZGROUPMEMBER) VALUES (?,?,?,?,NULL)", (m[0], m[1], now - m[2] * 86400, m[3]))
c.commit()
`], { input: JSON.stringify({ s: sessions, m: messages }) });
  return p;
}
function lookup(dbPath, ...args) {
  try {
    const out = execFileSync('python3', [SCRIPT, 'lookup', ...args], { env: { ...process.env, WHATSAPP_DB_PATH: dbPath }, encoding: 'utf8' });
    return { rc: 0, ...JSON.parse(out) };
  } catch (e) {
    return { rc: e.status, ...JSON.parse(e.stdout) };
  }
}

const SESSIONS = [
  [1, '447545000111@s.whatsapp.net', 'Jason Smith'],
  [2, '447700900222@s.whatsapp.net', 'Roy Lavin'],
  [3, '12345@newsletter', 'New York Times'],
  [4, '447700900333@s.whatsapp.net', 'Sam Brown'],
  [5, '447700900444@s.whatsapp.net', 'Sam Green'],
  [6, '447700900555@s.whatsapp.net', 'Sam White'],
  [7, '447700900666@s.whatsapp.net', 'Sam Black'],
];
const MESSAGES = [
  ['Rent is paid', 0, 2, 1], ['Thanks Jason', 1, 1, 1], ['Old message', 0, 400, 1],
  ['Boiler fixed', 0, 1, 2], ['Headline news', 0, 1, 3],
];

describe('WhatsApp read-only lookup', () => {
  it('finds one contact by a UK number (07… matched to 447…) and returns only recent messages, in order', () => {
    const r = lookup(db(SESSIONS, MESSAGES), '--who', '07545 000111');
    expect(r.rc).toBe(0);
    expect(r.chats).toHaveLength(1);
    expect(r.chats[0].chat).toBe('Jason Smith');
    expect(r.chats[0].messages.map((m) => [m.from, m.text])).toEqual([['Jason Smith', 'Rent is paid'], ['kevin', 'Thanks Jason']]);
    expect(r.chatsSearched).toBe(7);
  });

  it('finds by name, never a newsletter or broadcast', () => {
    expect(lookup(db(SESSIONS, MESSAGES), '--who', 'roy').chats.map((c) => c.chat)).toEqual(['Roy Lavin']);
    expect(lookup(db(SESSIONS, MESSAGES), '--who', 'New York').chats).toEqual([]);
  });

  it('refuses a vague search that would read many chats, and a too-short name', () => {
    const r = lookup(db(SESSIONS, MESSAGES), '--who', 'Sam');
    expect(r.rc).toBe(2);
    expect(r.error).toMatch(/4 chats match 'Sam'; give the full name or the number/);
    expect(lookup(db(SESSIONS, MESSAGES), '--who', 'ab').error).toMatch(/needs a contact name/);
  });

  it('a database with no chats is a broken read, never "nobody by that name"', () => {
    const r = lookup(db([], []), '--who', 'Jason Smith');
    expect(r.rc).toBe(1);
    expect(r.error).toMatch(/the read is broken, not empty/);
  });

  it('opens the database read-only: nothing in it changes', () => {
    const p = db(SESSIONS, MESSAGES);
    const before = fs.readFileSync(p);
    lookup(p, '--who', 'Jason Smith');
    expect(fs.readFileSync(p).equals(before)).toBe(true);
  });
});
