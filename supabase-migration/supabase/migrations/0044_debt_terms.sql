-- 0044_debt_terms.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Debt Terms (Airtable tblTz8ErAmQGu7rIZ) → Supabase. Drives the Wealth tab's
-- liabilities (mortgages/loans/credit cards) and the "Payment Match" credit-card
-- single-source matching (field fldgcwyxNgr8n4128). It was STUBBED empty in the
-- wealth shim; this un-stubs it (wealth-shim v3 maps it → debt_terms).
--
-- Read id-keyed (returnFieldsByFieldId=true), so — like performance_reviews/dod —
-- each row is a `fields` jsonb blob keyed by Airtable field id. Text id = Airtable
-- rec id for idempotent upsert. Org-scoped RLS per 0022.
--
-- ⚠️ DATA IS **NOT** SEEDED HERE — this repo is PUBLIC and Debt Terms contains
-- balances, card numbers and sensitive legal notes (a charging order / judgment
-- debt). The table is created EMPTY; scripts/sync-debt-terms.py copies the rows in
-- at runtime using the repo secrets (nothing sensitive is ever committed).
--
-- DEPLOY (Kevin): (1) run this file in the Supabase SQL editor; (2) run the
-- "Copy Debt Terms" GitHub Action to populate it. Until then the Wealth tab keeps
-- falling back to the monthly snapshot's lumped figures (same as when stubbed).
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.debt_terms (
  id          text primary key default public.new_id(),   -- Airtable rec id on ETL upsert
  org_id      uuid references public.organizations(id) on delete cascade,
  fields      jsonb not null default '{}'::jsonb,          -- debt-term fields, keyed by Airtable field id
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

do $$ begin
  if exists (select 1 from pg_proc where proname = 'tg_set_updated_at') then
    execute 'drop trigger if exists set_updated_at on public.debt_terms';
    execute 'create trigger set_updated_at before update on public.debt_terms for each row execute function public.tg_set_updated_at()';
  end if;
end $$;

create index if not exists idx_debt_terms_org on public.debt_terms(org_id);
alter table public.debt_terms
  alter column org_id set default coalesce(public.current_org_id(), public.bridge_default_org_id());
alter table public.debt_terms enable row level security;
alter table public.debt_terms force row level security;
drop policy if exists org_isolation on public.debt_terms;
create policy org_isolation on public.debt_terms for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
grant select, insert, update, delete on public.debt_terms to authenticated;

commit;

-- Verify:  select count(*) from public.debt_terms;   -- 0 until the copy job runs, then 37
