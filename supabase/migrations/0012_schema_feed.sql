-- Legati Tri Dagboek: persoonlijke schema-link (alleen lezen) voor een eigen app van een lid
-- Een lid met zo'n link kan zijn eigen trainingsschema laten overnemen door een andere app (eenrichting).
-- Er is GEEN knop of scherm in de website: de link wordt enkel door de beheerder in de database aangemaakt.
-- De tabel is enkel leesbaar voor de server (geen policies, geen rechten voor anon/authenticated),
-- dus andere leden zien niets en kunnen niets aanmaken.
create table if not exists public.schema_feed (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  token       text not null unique check (token ~ '^[a-f0-9]{48}$'),
  created_at  timestamptz not null default now(),
  last_used   timestamptz
);
alter table public.schema_feed enable row level security;
revoke all on public.schema_feed from public, anon, authenticated;

-- Link aanmaken (beheerder, SQL Editor):
--   insert into public.schema_feed (user_id, token)
--   values ('<user-id>', encode(extensions.gen_random_bytes(24), 'hex'))
--   on conflict (user_id) do update set token = excluded.token, created_at = now();
-- Link intrekken:  delete from public.schema_feed where user_id = '<user-id>';
