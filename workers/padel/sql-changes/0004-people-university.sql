-- 29 Oct 2026: the University of Cambridge Sports Centre (cu) joins the page. A new person can do
-- every venue until they untick one, so everyone already on the list gets cu too; anyone who cannot
-- get there unticks it under "Can't do". Applied once to the live database with
--   npx wrangler d1 execute padel --remote --file=workers/padel/sql-changes/0004-people-university.sql -c workers/padel/wrangler.toml
-- (safe before or after the Worker deploy: an older Worker drops venue codes it does not know).
UPDATE people SET venues = CASE WHEN venues = '' THEN 'cu' ELSE venues || ',cu' END
WHERE (',' || venues || ',') NOT LIKE '%,cu,%';
