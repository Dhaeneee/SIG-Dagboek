-- Persoonlijke Garmin-sleutel (Garmin Connect Personal API)
-- De sleutel en het toegangstoken staan enkel hier en zijn enkel leesbaar voor de server (geen policies, geen rechten).
-- Opgehaalde gegevens komen in garmin_data, met dezelfde privacyregels als de rest van Garmin.

create table if not exists public.garmin_personal (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  api_key      text not null check (char_length(api_key) between 16 and 512),
  token        text,
  token_exp    timestamptz,
  last_sync    timestamptz,
  last_health  timestamptz,
  last_ok      timestamptz,
  last_error   text check (last_error in ('sleutel','garmin')),
  created_at   timestamptz not null default now()
);
alter table public.garmin_personal enable row level security;
revoke all on public.garmin_personal from anon, authenticated;

-- status voor het lid zelf: gekoppeld via Garmin (OAuth) en/of via de persoonlijke sleutel, zonder sleutels te tonen
drop function if exists public.garmin_status();
create function public.garmin_status()
returns table(linked boolean, since timestamptz, pkey boolean, psince timestamptz, plast timestamptz, perr text)
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.garmin_links where user_id = auth.uid()),
         (select created_at from public.garmin_links where user_id = auth.uid()),
         exists(select 1 from public.garmin_personal where user_id = auth.uid()),
         (select created_at from public.garmin_personal where user_id = auth.uid()),
         (select last_ok from public.garmin_personal where user_id = auth.uid()),
         (select last_error from public.garmin_personal where user_id = auth.uid())
$$;
revoke all on function public.garmin_status() from public, anon;
grant execute on function public.garmin_status() to authenticated;

-- controle voor de kwartier-ophaling: klopt de sleutel die pg_cron meestuurt? (enkel voor de server)
create or replace function public.garmin_cron_ok(k text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return k is not null and length(k) >= 32 and exists(
    select 1 from vault.decrypted_secrets where name = 'garmin_cron_key' and decrypted_secret = k);
end $$;
revoke all on function public.garmin_cron_ok(text) from public, anon, authenticated;
grant execute on function public.garmin_cron_ok(text) to service_role;
