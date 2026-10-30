-- 30 Oct 2026 (Kevin: "amend people who have given themselves nicknames to put their actual names",
-- and Booked and paid into Splitwise with texts to the players):
--   people.real_name   the name Kevin sets on his People screen; shown, with its initials, everywhere
--   booked.price_pence / players / paid_at   the total Kevin paid and who is playing (JSON person ids)
--   booked.splitwise_* / texts_*             where the Mac robot's two steps stand: claimed, done or
--                                            failed, when, and a short note (never a phone number)
-- Applied once to the live database, BEFORE the Worker that reads these columns is deployed, with
--   npx wrangler d1 execute padel --remote --file=workers/padel/sql-changes/0005-names-and-paid.sql -c workers/padel/wrangler.toml
-- (the live Worker names its columns, so new ones cannot break it).
ALTER TABLE people ADD COLUMN real_name TEXT;
ALTER TABLE booked ADD COLUMN price_pence INTEGER;
ALTER TABLE booked ADD COLUMN players TEXT;
ALTER TABLE booked ADD COLUMN paid_at TEXT;
ALTER TABLE booked ADD COLUMN splitwise_state TEXT;
ALTER TABLE booked ADD COLUMN splitwise_at TEXT;
ALTER TABLE booked ADD COLUMN splitwise_note TEXT;
ALTER TABLE booked ADD COLUMN texts_state TEXT;
ALTER TABLE booked ADD COLUMN texts_at TEXT;
ALTER TABLE booked ADD COLUMN texts_note TEXT;
