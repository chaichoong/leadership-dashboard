-- Padel group page (workers/padel). D1 (SQLite), never KV: KV free-tier writes are 1,000 a day
-- account-wide and starve the other Workers (workers/property-manager/wrangler.toml).
--
-- Apply:  npx wrangler d1 execute padel --local  --file=workers/padel/schema.sql -c workers/padel/wrangler.toml
--         npx wrangler d1 execute padel --remote --file=workers/padel/schema.sql -c workers/padel/wrangler.toml
-- Safe to re-run: every statement is IF NOT EXISTS.
--
-- A slot is "YYYY-MM-DD|HH": the London date and the two-digit start hour (07 to 21).

-- One row per player. venues = the venue codes this person can get to (si, pdl, pp). votes_at = when
-- this person's tick list was last saved (the page uses it to decide whether ticks it kept on the
-- phone are still unsaved). Added 27 Oct 2026; the live database got it once with:
--   npx wrangler d1 execute padel --remote -c workers/padel/wrangler.toml --command "ALTER TABLE people ADD COLUMN votes_at TEXT"
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  venues TEXT NOT NULL DEFAULT 'si,pdl,pp',
  created_at TEXT NOT NULL,
  votes_at TEXT
);

-- "I can play" ticks. A person's whole list is replaced in one batch on every save.
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

-- One row per slot that has had its Slack DM. The row is inserted BEFORE the DM goes, so two
-- requests at once cannot both send; a failed DM deletes the row so the next check retries.
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
