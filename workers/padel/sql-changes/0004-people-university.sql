-- 29 Oct 2026: the University of Cambridge Sports Centre (cu) joins the page. A new person can do
-- every venue until they untick one. Someone already on the list gets cu when they can get to
-- Cambridge (pdl, five minutes from it); someone who unticked Cambridge does not. Anyone can change
-- it under "Can't do". Applied once to the live database with
--   npx wrangler d1 execute padel --remote --file=workers/padel/sql-changes/0004-people-university.sql -c workers/padel/wrangler.toml
-- Apply it AFTER the Worker deploy: an older Worker drops a venue code it does not know. A phone
-- tab opened before the deploy and never reloaded also drops cu if that person changes their venues
-- there; they tick Cambridge Uni again once the page reloads.
UPDATE people SET venues = venues || ',cu'
WHERE (',' || venues || ',') LIKE '%,pdl,%' AND (',' || venues || ',') NOT LIKE '%,cu,%';
