-- 0020_sop_queue.sql
-- Sitemap page ("Site Map & Guides") — the site map itself renders from the static
-- page registry (config.js), so no read migration is needed. Its only Airtable touch
-- is a WRITE: the "request an SOP update / create new SOP" button appends a row to the
-- Airtable SOP-request queue (tbltuZz5Omrpo7t1x). This mirrors that table so the
-- request persists in Supabase. Write-only from the app (it never reads it back).
create table if not exists public.sop_queue (
  id            text primary key default public.new_id(),
  request       text,
  sop_file      text,
  page_version  text,
  status        text,
  page_id       text,
  requested_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists set_updated_at on public.sop_queue;
create trigger set_updated_at before update on public.sop_queue
  for each row execute function public.tg_set_updated_at();

alter table public.sop_queue enable row level security;
alter table public.sop_queue force row level security;
drop policy if exists authenticated_all on public.sop_queue;
create policy authenticated_all on public.sop_queue for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.sop_queue to authenticated;
