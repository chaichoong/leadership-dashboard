-- 29 Oct 2026 (Kevin's feedback on the first bookings): a booking records its start ("19:30"), its
-- length in minutes and how many courts were booked (1, or 2 when 8 or more can play and a second
-- court was free). The hour row (slot) stays the key: one booking a day is the rule, and the day's
-- other hours drop out of the Ready list. Applied once to the live database with
--   npx wrangler d1 execute padel --remote --file=workers/padel/sql-changes/0003-booked-details.sql -c workers/padel/wrangler.toml
-- and mirrored in schema.sql for fresh builds.
ALTER TABLE booked ADD COLUMN start TEXT;
ALTER TABLE booked ADD COLUMN minutes INTEGER;
ALTER TABLE booked ADD COLUMN courts INTEGER NOT NULL DEFAULT 1;
