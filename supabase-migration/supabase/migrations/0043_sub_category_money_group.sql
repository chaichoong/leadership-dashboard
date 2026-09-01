-- 0043_sub_category_money_group.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- "Money Group" single-select (Needs | Wants) on Chart of Accounts – Sub
-- Categories (Airtable field fld4sJbnOMJ4A1Uey). Added to the live app 20 Jul; it
-- drives the Wealth page's split of personal money into budgets (Needs/Wants) vs
-- buckets. The Supabase coa_sub_categories table (Module 1) didn't have it, so
-- Wealth budgets/buckets couldn't group on Vercel.
--
-- Adds the column + backfills the 10 sub-categories that currently have a value
-- (read live from Airtable 2026-07-31: 8 Needs, 2 Wants; the other 39 are blank).
-- Idempotent (add column if not exists; updates key by the Airtable record id,
-- which is the Supabase coa_sub_categories.id). dashboard-shim v9 maps the field.
--
-- DEPLOY (Kevin): run this file in the Supabase SQL editor.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

alter table public.coa_sub_categories
  add column if not exists money_group text;   -- 'Needs' | 'Wants' | null

update public.coa_sub_categories set money_group = 'Needs' where id in (
  'rec1KfO2hixb1DA2e', 'rec2yAlBoqSZrXtHW', 'rec4fuKSWoK8ftkLJ', 'rec6b96i917M64Nof',
  'recF1C2ZXBfNeYlGT', 'recICmYNPZBQbeWWE', 'recPA5FxzccOfWvQd', 'recl1UbR0LhffjWbg'
);
update public.coa_sub_categories set money_group = 'Wants' where id in (
  'rec7uCvNlKGlieZMS', 'recism4LGdEx0Nh9Q'
);

commit;

-- Verify:
--   select money_group, count(*) from public.coa_sub_categories group by money_group;
--     -> Needs 8, Wants 2, (null) 39
