-- 0002: rate, a per-client request count for each minute (the Worker refuses the 61st request in a
-- minute). Applied to the live database `padel` on 27 Oct 2026; safe to run again (IF NOT EXISTS).
-- A fresh database built from ../schema.sql already has the table.
--
--   npx wrangler d1 execute padel --remote --file=workers/padel/sql-changes/0002-rate.sql -c workers/padel/wrangler.toml
CREATE TABLE IF NOT EXISTS rate (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
