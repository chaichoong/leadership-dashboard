-- 0019_wealth.sql
-- Wealth tab (clone of the #wealth tab / js/wealth.js on Supabase).
-- Three tables the Wealth tab reads by FIELD NAME (airtableFetch without
-- returnFieldsByFieldId), so each is stored as a name-keyed `fields` jsonb blob:
--   net_worth_by_month  (tblvtDXCBJCHu9hnK) — monthly net-worth snapshot (the hero)
--   income_buckets      (tbldMPjXTu7ho5f0T) — income allocation buckets
--   personal_budgets    (tblm5ZxyoiLfaBAS4) — monthly budget per personal category
-- The optional per-property valuations + debt-terms overlays are deferred (the page
-- falls back to the snapshot's lumped real-estate/mortgage figures — it's non-fatal).
-- Reads dashboard globals (allAccounts/allTransactions) via the dashboard shim.
do $$
declare t text;
begin
  foreach t in array array['net_worth_by_month','income_buckets','personal_budgets'] loop
    execute format($f$
      create table if not exists public.%I (
        id          text primary key default public.new_id(),
        fields      jsonb not null default '{}'::jsonb,   -- values keyed by Airtable field NAME
        created_at  timestamptz not null default now(),
        updated_at  timestamptz not null default now()
      );$f$, t);
    execute format('drop trigger if exists set_updated_at on public.%I;', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.tg_set_updated_at();', t);
    execute format('alter table public.%I enable row level security;', t);
    execute format('alter table public.%I force row level security;', t);
    execute format('drop policy if exists authenticated_all on public.%I;', t);
    execute format('create policy authenticated_all on public.%I for all to authenticated using (true) with check (true);', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated;', t);
  end loop;
end $$;
