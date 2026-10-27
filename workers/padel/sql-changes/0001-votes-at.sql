-- 0001: people.votes_at, when a person's ticks were last saved.
-- ALREADY APPLIED to the live database `padel` on 27 Oct 2026. Do not run it again: SQLite has no
-- "ADD COLUMN IF NOT EXISTS", so a second run fails with "duplicate column name". A fresh database
-- built from ../schema.sql already has the column.
--
-- How it was applied:
--   npx wrangler d1 execute padel --remote -c workers/padel/wrangler.toml --file workers/padel/sql-changes/0001-votes-at.sql
ALTER TABLE people ADD COLUMN votes_at TEXT;
