-- Padel group page (workers/padel). D1 (SQLite), never KV: KV free-tier writes are 1,000 a day
-- account-wide and starve the other Workers (workers/property-manager/wrangler.toml).
--
-- This file builds a FRESH database only (a local `wrangler dev` copy, the tests' SQLite):
--   npx wrangler d1 execute padel --local --file=workers/padel/schema.sql -c workers/padel/wrangler.toml
-- It never changes a database that already exists (every statement is IF NOT EXISTS, so a table
-- that is there is skipped, columns and all). A change to the LIVE database goes through a
-- numbered file in sql-changes/, applied once by hand with `wrangler d1 execute padel --remote --file`
-- (not migrations/: that is wrangler's folder for `d1 migrations apply`, which would run them again),
-- and the same change made here so a fresh build matches. Applied so far: 0001-votes-at.sql.
--
-- A slot is "YYYY-MM-DD|HH": the London date and the two-digit start hour (07 to 21).

-- One row per player. venues = the venue codes this person can get to (si, pdl, pp). votes_at = when
-- this person last saved their ticks (sql-changes/0001-votes-at.sql, 27 Oct 2026).
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  venues TEXT NOT NULL DEFAULT 'si,pdl,pp',
  created_at TEXT NOT NULL,
  votes_at TEXT
);

-- "I can play" ticks. A save adds and removes single hours (POST /api/vote { add, remove }).
CREATE TABLE IF NOT EXISTS votes (
  person_id INTEGER NOT NULL,
  slot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (person_id, slot)
);

-- A slot somebody has booked a court for: no more alerts, and the page shows who and where.
CREATE TABLE IF NOT EXISTS booked (
  slot TEXT PRIMARY KEY,
  person_id INTEGER,
  venue TEXT,
  created_at TEXT NOT NULL
);

-- One row per slot that has had its Slack DM. The row is inserted BEFORE the DM goes, with
-- relay_reply {"claimed":true,...}, so two requests at once cannot both send and a claim is final.
-- The relay's reply (or a timeout or error marker) overwrites it. Only a definite refusal from the
-- relay (a non-200) deletes the row, so a later check retries. At most one DM per slot, ever.
CREATE TABLE IF NOT EXISTS alerts (
  slot TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL,
  names TEXT NOT NULL,
  venues TEXT NOT NULL,
  relay_reply TEXT
);

-- availability (the last venue read, JSON) and refresh_started_at (epoch ms of the last refresh
-- start, the 90-second guard).
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
