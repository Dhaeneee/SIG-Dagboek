-- Ochtendmelding: elke ochtend één melding met de nachtwaarden en de kleur van de dag.
-- De Garmin-functie schrijft hier één rij per lid per dag zodra de slaap van afgelopen nacht binnen is;
-- de trigger vraagt dan de functie push om de melding te sturen.
create table if not exists public.push_ochtend (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  dag         date not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, dag)
);
alter table public.push_ochtend enable row level security;
revoke all on public.push_ochtend from anon, authenticated;

create or replace function public.tg_push_ochtend() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.push_event(jsonb_build_object('type', 'ochtend', 'user_id', new.user_id, 'dag', new.dag));
  return new;
end $$;
create or replace trigger push_ochtend_aan after insert on public.push_ochtend for each row execute function public.tg_push_ochtend();
revoke all on function public.tg_push_ochtend() from public, anon, authenticated;
