-- Flightlog: Supabase Auth setup
-- Run this once in the Supabase dashboard: SQL Editor > New query > paste > Run.
-- Before running, replace YOUR_EMAIL_HERE below with the email of the account
-- you created under Authentication > Users.

-- 1. Column that lets deletes sync between devices.
alter table public.flights add column if not exists deleted_at timestamptz;

-- 2. Mark your account as the owner. app_metadata cannot be edited by users,
--    so nobody can promote themselves. Every other account is a viewer.
update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"owner"}'::jsonb
 where email = 'YOUR_EMAIL_HERE';

-- 3. Helper used by the policies below.
create or replace function public.is_owner()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'owner';
$$;

-- 4. Replace every old policy (including the allow-all one) with these.
alter table public.flights enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'flights' loop
    execute format('drop policy %I on public.flights', p.policyname);
  end loop;
end $$;

-- Any signed-in account can read.
create policy flights_read on public.flights
  for select to authenticated
  using (true);

-- Only the owner can add, change or delete.
create policy flights_insert on public.flights
  for insert to authenticated
  with check (public.is_owner());

create policy flights_update on public.flights
  for update to authenticated
  using (public.is_owner())
  with check (public.is_owner());

create policy flights_delete on public.flights
  for delete to authenticated
  using (public.is_owner());

-- Signed-out requests (the anon key alone) now match no policy, so they see
-- nothing and can change nothing. The GitHub keepalive still gets a normal
-- empty response, which keeps the project awake.
