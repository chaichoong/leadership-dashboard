// A silent message database is a broken feed, not a quiet day.
//
// Regression origin: finding 20261015-agent-dispatch-910. On 15 Oct 2026 the
// iMessage scan reported 60,643 rows and exited 0, while the newest incoming
// message was from 11 Oct and nothing had gone out for 200 hours. The lane then
// reported a quiet inbox and advanced its watermark past the gap (the other
// half of that morning, finding 20261015-phase-2-894). db_total_messages counts
// HISTORY: it proves the file opened and nothing about whether it is still
// being written to.
//
// These tests drive the real scan() against a real sqlite database built here,
// with DB_PATH pointed at it. Back-tested by deleting the db_stale_problem call
// in scan(): the stale case exits 0 and the first two tests go red.
//
// Checked against the live chat.db on 22 Oct 2026 at 07:26: 60,666 messages,
// newest incoming 03:22 the same morning, so the control passes and the real
// lane is not broken by it.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/imessage-sweep.py');

// Minimal chat.db: only the tables and columns the scan reads.
function runScan({ ageHours, rows = 1 }) {
  const dir = mkdtempSync(join(tmpdir(), 'imsg-'));
  const db = join(dir, 'chat.db');
  const code = `
import importlib.util, sqlite3, sys, time
spec = importlib.util.spec_from_file_location("sweep", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

m.DB_PATH = ${JSON.stringify(db)}
APPLE = m.APPLE_EPOCH_UNIX
now_ns = int((time.time() - APPLE) * 1e9)
when_ns = now_ns - int(${ageHours} * 3600 * 1e9)

c = sqlite3.connect(${JSON.stringify(db)})
c.executescript("""
CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, text TEXT,
  attributedBody BLOB, item_type INTEGER, associated_message_type INTEGER,
  handle_id INTEGER, is_from_me INTEGER, is_read INTEGER);
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT, style INTEGER);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
""")
c.execute("INSERT INTO chat VALUES (1, 'test-chat', 'Test', 45)")
c.execute("INSERT INTO handle VALUES (1, '+447700900000')")
for i in range(${rows}):
    c.execute("INSERT INTO message VALUES (?,?,?,?,?,?,?,?,?,?)",
              (i + 1, 'g%d' % i, when_ns, 'please send the signed form', None, 0, 0, 1, 0, 0))
    c.execute("INSERT INTO chat_message_join VALUES (1, ?)", (i + 1,))
c.commit(); c.close()

rc = m.scan()
print("EXITCODE", rc, file=sys.stderr)
sys.exit(0)
`;
  const out = execFileSync('python3', ['-c', code], { encoding: 'utf8', timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'] });
  return out;
}

describe('the iMessage lane fails loudly on a stale feed', () => {
  it('THE INCIDENT: a database last written to 4 days ago exits 2 and says so', () => {
    const out = runScan({ ageHours: 96 });
    const j = JSON.parse(out);
    expect(j.error).toContain('stale');
    expect(j.error).toContain('NOT a quiet inbox');
    expect(j.db_total_messages).toBe(1);
    // the age is named, so the report can say how dead it is
    expect(j.error).toMatch(/9[0-9]\.\d hours/);
    // no candidates key at all: it refused to report a read it does not trust
    expect(j.candidates).toBeUndefined();
  });

  it('a live database still scans, and prints its freshness', () => {
    const out = runScan({ ageHours: 1 });
    const j = JSON.parse(out);
    expect(j.error).toBeUndefined();
    expect(j.newest_message_at).toBeTruthy();
    expect(j.newest_incoming_at).toBeTruthy();
    expect(Array.isArray(j.candidates)).toBe(true);
  });

  it('a NULL MAX(date) with rows present is a broken read, never quiet', () => {
    const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("sweep", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({
  "null": m.db_stale_problem(None, 1000),
  "fresh": m.db_stale_problem(1000, 1000),
  "edge": m.db_stale_problem(0, int(24 * 3600 * 1e9)),
  "over": m.db_stale_problem(0, int(24.5 * 3600 * 1e9)),
  "hours": m.STALE_DB_HOURS,
}))
`;
    const j = JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf8', timeout: 30000 }));
    expect(j.null).toContain('the read is broken');
    expect(j.fresh).toBeNull();
    expect(j.edge).toBeNull();          // exactly at the limit is still live
    expect(j.over).toContain('stale');  // past it is not
    expect(j.hours).toBe(24);
  });
});
