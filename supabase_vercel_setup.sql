-- Flightlog on Vercel: lock the database so only your Vercel functions can reach it.
-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run.

-- 1. Column that lets deletes sync between devices.
alter table public.flights add column if not exists deleted_at timestamptz;

-- 2. Turn on row level security and remove every policy, including any
--    allow-all policy from earlier versions. With no policies, the public
--    (anon) key and any signed-in user token can read and change nothing.
--    Your Vercel functions use the secret key, which skips these rules.
alter table public.flights enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'flights' loop
    execute format('drop policy %I on public.flights', p.policyname);
  end loop;
end $$;

-- 3. Cleanup: only needed if you ran the earlier Supabase Auth draft.
drop function if exists public.is_owner();

-- Not changed on purpose: the anon role keeps its table privileges, so the
-- GitHub keepalive (which calls the REST API with the anon key) still gets a
-- normal, empty response and keeps the project from pausing.
