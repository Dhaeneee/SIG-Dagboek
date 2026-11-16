-- Pushmeldingen (web push)
-- push_subs: de toestellen die meldingen willen (enkel leesbaar voor de server).
-- app_keys: sleutels die de server zelf maakt, zoals de VAPID-sleutels (enkel leesbaar voor de server).
create table if not exists public.push_subs (
  endpoint    text primary key check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  p256dh      text not null check (char_length(p256dh) <= 200),
  auth        text not null check (char_length(auth) <= 100),
  ua          text check (char_length(ua) <= 60),
  fails       integer not null default 0,
  last_ok     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists push_subs_user on public.push_subs(user_id);
alter table public.push_subs enable row level security;

create table if not exists public.app_keys (
  name        text primary key,
  value       text not null,
  created_at  timestamptz not null default now()
);
alter table public.app_keys enable row level security;
revoke all on public.push_subs, public.app_keys from anon, authenticated;

-- melding vragen aan de functie push (via pg_net, pas na het opslaan; een fout blokkeert nooit het opslaan)
create or replace function public.push_event(payload jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://ckpizktozroqaxfoqwpy.supabase.co/functions/v1/push/event',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'garmin_cron_key')),
    body := payload, timeout_milliseconds := 30000);
exception when others then
  raise warning 'push_event: %', sqlerrm;
end $$;

create or replace function public.tg_push_activity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'activity' then perform public.push_event(jsonb_build_object('type', 'activity', 'user_id', new.user_id, 'ref', new.ref)); end if;
  return new;
end $$;
drop trigger if exists push_activity on public.garmin_data;
create trigger push_activity after insert on public.garmin_data for each row execute function public.tg_push_activity();

create or replace function public.tg_push_cmsg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.push_event(jsonb_build_object('type', 'cmsg', 'id', new.id));
  return new;
end $$;
drop trigger if exists push_cmsg on public.cmsg;
create trigger push_cmsg after insert on public.cmsg for each row execute function public.tg_push_cmsg();

create or replace function public.tg_push_lid() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'wacht' then perform public.push_event(jsonb_build_object('type', 'lid', 'user_id', new.id)); end if;
  return new;
end $$;
drop trigger if exists push_lid on public.profiles;
create trigger push_lid after insert on public.profiles for each row execute function public.tg_push_lid();

revoke all on function public.push_event(jsonb), public.tg_push_activity(), public.tg_push_cmsg(), public.tg_push_lid()
  from public, anon, authenticated;
