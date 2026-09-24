import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

// Finding 20260824-agent-dispatch-340. The sweep wrote one task per MESSAGE.
// Task recdX1iKpBUplFIUb's description said "the actual product is NOT known
// from this task" because the sender posted the product link and the words as
// two messages 46 seconds apart, and only the second survived. In a group chat
// the mention test ran per message too, so the link-only message was dropped
// before anything could read it.
//
// This drives the REAL scan() against a fixture chat.db, because the bug was the
// ORDER of grouping and filtering, not the grouping helper on its own. A test of
// group_messages alone would have passed against the broken code.

const SCRIPT = resolve(__dirname, '../scripts/imessage-sweep.py');
const APPLE_EPOCH_UNIX = 978307200;

function scanFixture({ style, messages }) {
  const dir = mkdtempSync(join(tmpdir(), 'imsg-'));
  const db = join(dir, 'chat.db');
  const state = join(dir, 'state');
  const rows = messages.map((m, i) => ({
    rowid: i + 1,
    guid: m.guid,
    // Seconds from now, as Apple nanoseconds; all inside the default window.
    offset: m.offset,
    text: m.text,
    handle: m.sender,
  }));
  const py = `
import json, sqlite3, os, importlib.util, time
db = ${JSON.stringify(db)}
conn = sqlite3.connect(db)
conn.executescript("""
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT, style INTEGER);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, text TEXT,
  attributedBody BLOB, item_type INTEGER, associated_message_type INTEGER,
  handle_id INTEGER, is_from_me INTEGER, is_read INTEGER);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
""")
conn.execute("INSERT INTO chat VALUES (1, 'chat-fixture', 'Fixture Chat', ?)", (${style},))
handles = {}
rows = json.loads(${JSON.stringify(JSON.stringify(rows))})
now_apple_ns = int((time.time() - ${APPLE_EPOCH_UNIX}) * 1e9)
for r in rows:
    h = r["handle"]
    if h not in handles:
        handles[h] = len(handles) + 1
        conn.execute("INSERT INTO handle VALUES (?, ?)", (handles[h], h))
    conn.execute("INSERT INTO message VALUES (?,?,?,?,?,0,0,?,0,0)",
                 (r["rowid"], r["guid"], now_apple_ns + int(r["offset"] * 1e9),
                  r["text"], None, handles[h]))
    conn.execute("INSERT INTO chat_message_join VALUES (1, ?)", (r["rowid"],))
conn.commit(); conn.close()

spec = importlib.util.spec_from_file_location("sweep", ${JSON.stringify(SCRIPT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.DB_PATH = db
mod.STATE_DIR = ${JSON.stringify(state)}
mod.STATE_PATH = os.path.join(${JSON.stringify(state)}, "state.json")
mod.scan()
`;
  const out = execFileSync('python3', ['-c', py], { encoding: 'utf8', maxBuffer: 8e6 });
  return JSON.parse(out.slice(out.indexOf('{')));
}

// Ciara's real shape: the link, then 46 seconds later the words.
const SPLIT_ASK = [
  { guid: 'g-link', offset: -300, text: 'https://example.com/product/123', sender: '+447900000001' },
  { guid: 'g-words', offset: -254, text: 'Kevin can you order this one please', sender: '+447900000001' },
];

describe('imessage-sweep groups a split ask (finding 340)', () => {
  it('one candidate carries both messages and the link, in a 1:1 chat', () => {
    const r = scanFixture({ style: 45, messages: SPLIT_ASK });
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.message_count).toBe(2);
    expect(c.urls).toEqual(['https://example.com/product/123']);
    expect(c.text).toContain('example.com/product/123');
    expect(c.text).toContain('order this one');
    expect(c.guids).toEqual(['g-link', 'g-words']);
  });

  // THE PART THAT LOST THE LINK. In a group chat the link-only message mentions
  // nobody, so a per-message mention test discarded it and kept only the words.
  it('a group chat keeps the link-only message when the block mentions Kevin', () => {
    const r = scanFixture({ style: 43, messages: SPLIT_ASK });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].urls).toEqual(['https://example.com/product/123']);
    expect(r.group_skipped_no_mention).toBe(0);
  });

  it('a group chat still drops a block that mentions nobody', () => {
    const r = scanFixture({
      style: 43,
      messages: [
        { guid: 'a', offset: -300, text: 'anyone fancy lunch?', sender: '+447900000001' },
        { guid: 'b', offset: -290, text: 'I could eat', sender: '+447900000001' },
      ],
    });
    expect(r.candidates).toHaveLength(0);
    expect(r.group_skipped_no_mention).toBe(1);
  });

  it('messages further apart than the window stay separate asks', () => {
    const r = scanFixture({
      style: 45,
      messages: [
        { guid: 'a', offset: -900, text: 'first ask', sender: '+447900000001' },
        { guid: 'b', offset: -600, text: 'unrelated second ask', sender: '+447900000001' },
      ],
    });
    expect(r.candidates).toHaveLength(2);
  });

  it('two senders in one chat are never merged', () => {
    const r = scanFixture({
      style: 45,
      messages: [
        { guid: 'a', offset: -300, text: 'from one', sender: '+447900000001' },
        { guid: 'b', offset: -295, text: 'from two', sender: '+447900000002' },
      ],
    });
    expect(r.candidates).toHaveLength(2);
  });
});
