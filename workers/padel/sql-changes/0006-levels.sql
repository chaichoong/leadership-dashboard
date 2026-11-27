-- 27 Nov 2026 (Kevin: "every player can be graded ... a league table of level in the app"; Stage 2):
--   people.level            the player's level on Playtomic's 0 to 7 scale (NULL until picked)
--   people.level_matches    rated scores that moved it: a player picks their own level only while 0
--   people.level_active_at  the London date of the last level pick or rated score: 90 days on, the
--                           shown level drops 0.10, and again every 90 days (Nettla's rule)
--   matches                 one row per score: the two pairs, the games per set, rated or friendly, who
--                           entered it, and the exact change it made to each level (so a delete
--                           reverses it exactly). key is the form's own id: a double tap is one score;
--                           fingerprint (the pairs and games) allows one live score per match a day.
--   feedback                peer feedback after a score (Nettla): each player marks the other three
--                           higher, expected or lower; 2 matching votes move that player 0.05.
-- Applied once to the live database, BEFORE the Worker that reads these is deployed, with
--   npx wrangler d1 execute padel --remote --file=workers/padel/sql-changes/0006-levels.sql -c workers/padel/wrangler.toml
-- (the live Worker names its columns, so new ones cannot break it).
ALTER TABLE people ADD COLUMN level REAL;
ALTER TABLE people ADD COLUMN level_matches INTEGER NOT NULL DEFAULT 0;
ALTER TABLE people ADD COLUMN level_active_at TEXT;
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  played_on TEXT NOT NULL,
  team_a TEXT NOT NULL,
  team_b TEXT NOT NULL,
  sets TEXT NOT NULL,
  rated INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'match',
  entered_by INTEGER NOT NULL,
  entered_at TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '{}',
  feedback_changes TEXT NOT NULL DEFAULT '{}',
  deleted_at TEXT,
  fingerprint TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_played_on ON matches (played_on);
-- One score per match a day: the same pairs and games (either way round) cannot go in twice, even sent
-- by both pairs at the same moment. A deleted score frees its place.
CREATE UNIQUE INDEX IF NOT EXISTS matches_one_a_day ON matches (played_on, fingerprint) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS feedback (
  match_id INTEGER NOT NULL,
  from_id INTEGER NOT NULL,
  about_id INTEGER NOT NULL,
  vote TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (match_id, from_id, about_id)
);
