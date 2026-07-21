-- 0031_meetings_full_fidelity.sql
-- Add the Airtable Meetings fields the initial table missed, so the Supabase
-- meeting-intake process stores everything Airtable did:
--   • transcript    — the raw meeting summary text (enables the "repair" path
--                     that rebuilds missing tasks)
--   • meeting_uuid  — the source message id → robust de-duplication (matches
--                     Airtable's "Meeting UUID" dedupe field)
--   • zoom_mid      — Zoom/provider meeting id (metadata)
--   • projects      — meeting-level project links (jsonb array of project ids)

begin;

alter table public.meetings add column if not exists transcript   text;
alter table public.meetings add column if not exists meeting_uuid  text;
alter table public.meetings add column if not exists zoom_mid      text;
alter table public.meetings add column if not exists projects      jsonb not null default '[]'::jsonb;

-- Dedupe guard: at most one meeting per source message id within a workspace.
create unique index if not exists uq_meetings_org_uuid
  on public.meetings (org_id, meeting_uuid) where meeting_uuid is not null;

commit;
