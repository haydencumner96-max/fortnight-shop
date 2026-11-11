-- Fortnight Shop: run this once in Supabase → SQL Editor → New query → Run.
-- One table holds everything (list items, recipes, fortnights, aisles), one row per thing,
-- and every row is locked to the login that wrote it.

create table if not exists public.docs (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  col        text not null,
  id         text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, col, id)
);

alter table public.docs enable row level security;

drop policy if exists "read own"   on public.docs;
drop policy if exists "add own"    on public.docs;
drop policy if exists "change own" on public.docs;
drop policy if exists "remove own" on public.docs;

create policy "read own"   on public.docs for select to authenticated using (user_id = auth.uid());
create policy "add own"    on public.docs for insert to authenticated with check (user_id = auth.uid());
create policy "change own" on public.docs for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "remove own" on public.docs for delete to authenticated using (user_id = auth.uid());

-- live updates between phones
alter table public.docs replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;
