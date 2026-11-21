// A PHOTO IS A MESSAGE (finding 20261119-agent-dispatch-1367, 19 Nov 2026). An agent was asked to check a
// photo a tenant had sent on WhatsApp and could not answer: `lookup` dropped every row with no ZTEXT, so a
// photo, voice note or document was invisible, and the only honest answer the agent could give was
// "nothing was said" — the silent zero this estate refuses. The same read capped each chat at the newest 40
// messages, so `--days 60` on a busy chat returned a few days and said nothing about the rest.
//
// These run the REAL lookup against a throwaway database with WhatsApp's table layout, never his chats.
// Back-tested: every assertion below fails on the code before this fix (the media rows are simply absent,
// there is no mediaRead / truncated field, and the 60-day ask returns 40 rows).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(root, 'scripts/whatsapp-sweep.py');

// A database with the media table, as WhatsApp on macOS has it: ZWAMESSAGE.ZMESSAGETYPE and
// ZWAMEDIAITEM.ZMEDIALOCALPATH joined to the message by ZMESSAGE.
function dbWithMedia(messages, mediaRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-'));
  const p = path.join(dir, 'ChatStorage.sqlite');
  execFileSync('python3', ['-c', `
import sqlite3, json, sys, time
a = json.loads(sys.stdin.read())
c = sqlite3.connect(${JSON.stringify(p)})
c.executescript("""CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID TEXT, ZPARTNERNAME TEXT);
CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZCONTACTNAME TEXT, ZMEMBERJID TEXT);
CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, ZTEXT TEXT, ZISFROMME INTEGER, ZMESSAGEDATE REAL,
                         ZCHATSESSION INTEGER, ZGROUPMEMBER INTEGER, ZMESSAGETYPE INTEGER);
CREATE TABLE ZWAMEDIAITEM (Z_PK INTEGER PRIMARY KEY, ZMESSAGE INTEGER, ZMEDIALOCALPATH TEXT);""")
now = time.time() - 978307200
c.execute("INSERT INTO ZWACHATSESSION VALUES (1, '447700900777@s.whatsapp.net', 'Dana Tenant')")
for i, m in enumerate(a["m"], start=1):
    c.execute("INSERT INTO ZWAMESSAGE (Z_PK, ZTEXT, ZISFROMME, ZMESSAGEDATE, ZCHATSESSION, ZGROUPMEMBER, ZMESSAGETYPE)"
              " VALUES (?,?,?,?,1,NULL,?)", (i, m[0], m[1], now - m[2] * 86400, m[3]))
    if m[4]:
        c.execute("INSERT INTO ZWAMEDIAITEM (ZMESSAGE, ZMEDIALOCALPATH) VALUES (?,?)", (i, m[4]))
c.commit()
`], { input: JSON.stringify({ m: messages }) });
  if (mediaRoot) fs.mkdirSync(path.join(dir, path.dirname(mediaRoot)), { recursive: true });
  return { db: p, dir };
}

// A database with NO media table at all, which is what the older WhatsApp (and the first version of this
// test harness) has. It must read as NOT CHECKED, never as "no media" and never as a crash.
function dbNoMediaTable(messages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-nomedia-'));
  const p = path.join(dir, 'ChatStorage.sqlite');
  execFileSync('python3', ['-c', `
import sqlite3, json, sys, time
a = json.loads(sys.stdin.read())
c = sqlite3.connect(${JSON.stringify(p)})
c.executescript("""CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID TEXT, ZPARTNERNAME TEXT);
CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZCONTACTNAME TEXT, ZMEMBERJID TEXT);
CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, ZTEXT TEXT, ZISFROMME INTEGER, ZMESSAGEDATE REAL,
                         ZCHATSESSION INTEGER, ZGROUPMEMBER INTEGER);""")
now = time.time() - 978307200
c.execute("INSERT INTO ZWACHATSESSION VALUES (1, '447700900777@s.whatsapp.net', 'Dana Tenant')")
for m in a["m"]:
    c.execute("INSERT INTO ZWAMESSAGE (ZTEXT, ZISFROMME, ZMESSAGEDATE, ZCHATSESSION, ZGROUPMEMBER)"
              " VALUES (?,?,?,1,NULL)", (m[0], m[1], now - m[2] * 86400))
c.commit()
`], { input: JSON.stringify({ m: messages }) });
  return p;
}

function lookup(dbPath, ...args) {
  try {
    const out = execFileSync('python3', [SCRIPT, 'lookup', ...args], {
      env: { ...process.env, WHATSAPP_DB_PATH: dbPath }, encoding: 'utf8' });
    return { rc: 0, ...JSON.parse(out) };
  } catch (e) {
    return { rc: e.status, ...JSON.parse(e.stdout) };
  }
}

describe('a WhatsApp lookup answers a photo check', () => {
  it('a message with no text comes back as media, with its kind, date and the file on this Mac', () => {
    // [text, fromMe, daysAgo, messageType, mediaPath]
    const { db, dir } = dbWithMedia([
      ['The boiler is leaking', 0, 3, 0, null],
      ['', 0, 2, 1, 'Media/447700900777@s.whatsapp.net/1/2/photo-leak.jpg'],
      ['', 0, 2, 3, 'Media/447700900777@s.whatsapp.net/1/3/voice-note.opus'],
      ['I will send someone', 1, 1, 0, null],
    ]);
    fs.mkdirSync(path.join(dir, 'Media/447700900777@s.whatsapp.net/1/2'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Media/447700900777@s.whatsapp.net/1/2/photo-leak.jpg'), 'not-a-real-jpeg');

    const r = lookup(db, '--who', 'Dana Tenant', '--days', '30');
    expect(r.rc).toBe(0);
    expect(r.chats).toHaveLength(1);
    const msgs = r.chats[0].messages;
    // Four messages, not two: the photo and the voice note are no longer dropped.
    expect(msgs).toHaveLength(4);
    expect(r.chats[0].mediaMessages).toBe(2);
    expect(r.mediaRead).toBe('read');
    expect(r.typeRead).toBe('read');

    const photo = msgs.find(m => (m.media || {}).typeName === 'image');
    expect(photo).toBeTruthy();
    expect(photo.media.type).toBe(1);
    expect(photo.media.path).toMatch(/photo-leak\.jpg$/);
    // The file really is where the answer says it is, so the post-run step can copy it to the task.
    expect(photo.media.onDisk).toBe(true);
    expect(photo.at).toMatch(/^\d{4}-\d{2}-\d{2}/);

    const voice = msgs.find(m => (m.media || {}).typeName === 'audio');
    expect(voice.media.path).toMatch(/voice-note\.opus$/);
    // Named in the answer, but not on disk here: said plainly, never as a path that works.
    expect(voice.media.onDisk).toBe(false);

    // The text messages are untouched, and still in oldest-first order.
    expect(msgs[0].text).toBe('The boiler is leaking');
    expect(msgs[3].from).toBe('kevin');
  });

  it('the window is the days asked for, not the newest 40, and a ceiling that bites is reported', () => {
    // 60 messages inside a 30-day window. The old newest-40 cap returned 40 and said nothing.
    const many = [];
    for (let i = 0; i < 60; i++) many.push([`message ${i}`, 0, 1 + (i % 20), 0, null]);
    const { db } = dbWithMedia(many);
    const all = lookup(db, '--who', 'Dana Tenant', '--days', '30');
    expect(all.rc).toBe(0);
    expect(all.chats[0].messages).toHaveLength(60);
    expect(all.truncated).toBe(null);
    expect(all.limit).toBe(null);

    // A caller may still ask for a cap. When it bites, the answer SAYS so and says how far back it got.
    const capped = lookup(db, '--who', 'Dana Tenant', '--days', '30', '--limit', '10');
    expect(capped.chats[0].messages).toHaveLength(10);
    expect(capped.truncated).toHaveLength(1);
    expect(capped.truncated[0].rowsRead).toBe(10);
    expect(capped.truncated[0].why).toMatch(/NOT the whole window/);
    expect(capped.truncated[0].coveredBackTo).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('a database with no media table reads NOT CHECKED, and still never drops the row', () => {
    const p = dbNoMediaTable([['Rent paid', 0, 2], ['', 0, 1]]);
    const r = lookup(p, '--who', 'Dana Tenant', '--days', '30');
    expect(r.rc).toBe(0);
    expect(r.mediaRead).toMatch(/^NOT CHECKED: this database has no ZWAMEDIAITEM table/);
    expect(r.typeRead).toMatch(/^NOT CHECKED: ZWAMESSAGE has no ZMESSAGETYPE column/);
    // The textless row is still returned, marked unreadable rather than deleted.
    expect(r.chats[0].messages).toHaveLength(2);
    expect(r.chats[0].mediaMessages).toBe(1);
    const blank = r.chats[0].messages.find(m => m.media);
    expect(blank.media.typeName).toBe('unknown');
    expect(blank.media.note).toMatch(/no ZMESSAGETYPE column/);
  });
});
