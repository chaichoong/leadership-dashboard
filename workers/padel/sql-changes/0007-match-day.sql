-- 28 Nov 2026 (Kevin, Stage 3: match day on a booked hour, fair teams, Kings and challengers):
--   sessions            one row per court group on a booked hour: a match (two pairs) or Kings and
--                       challengers (who is king, the challengers, the queue, the 3-in-a-row streak,
--                       each player's points, and the states before each game, for Undo). version
--                       moves on every change, so two phones tapping the same game record it once;
--                       token is the last write's own mark, which every statement that goes with it
--                       checks; AUTOINCREMENT so a re-planned court never reuses an id (and so a
--                       game key) from before.
--   matches.session_id  the session a Kings and challengers game belongs to (a quarter-weight rated
--                       game; a session moves no level more than 0.4).
-- Applied once to the live database, BEFORE the Worker that reads these is deployed, with
--   npx wrangler d1 execute padel --remote --file=workers/padel/sql-changes/0007-match-day.sql -c workers/padel/wrangler.toml
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot TEXT NOT NULL,
  group_no INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  token TEXT,
  UNIQUE (slot, group_no)
);
ALTER TABLE matches ADD COLUMN session_id INTEGER;
