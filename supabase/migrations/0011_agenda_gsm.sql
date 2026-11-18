-- Legati Tri Dagboek: clubagenda op je gsm en meldingen bij wijzigingen
-- 1. Persoonlijke agenda-link (abonnement): je gsm-agenda haalt zelf de activiteiten op waarvoor je "Ik kom" tikte.
--    De link bevat een lange willekeurige sleutel; wie hem stopt, maakt hem ongeldig.
create table if not exists public.agenda_feed (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  token       text not null unique check (token ~ '^[a-f0-9]{48}$'),
  created_at  timestamptz not null default now()
);
alter table public.agenda_feed enable row level security;
drop policy if exists af_select on public.agenda_feed;
create policy af_select on public.agenda_feed for select to authenticated using (user_id = auth.uid());
drop policy if exists af_insert on public.agenda_feed;
create policy af_insert on public.agenda_feed for insert to authenticated with check (user_id = auth.uid() and public.is_member());
drop policy if exists af_delete on public.agenda_feed;
create policy af_delete on public.agenda_feed for delete to authenticated using (user_id = auth.uid());
revoke all on public.agenda_feed from anon;

-- 2. Activiteiten: versie en tijdstip van de laatste wijziging (voor de gsm-agenda)
alter table public.events add column if not exists updated_at timestamptz not null default now();
alter table public.events add column if not exists seq integer not null default 0;
create or replace function public.tg_event_versie() returns trigger
language plpgsql as $$
begin
  if (new.titel, new.type, new.datum, new.uur, new.plaats, new.info) is distinct from (old.titel, old.type, old.datum, old.uur, old.plaats, old.info) then
    new.updated_at := now(); new.seq := old.seq + 1;
  end if;
  return new;
end $$;
drop trigger if exists event_versie on public.events;
create trigger event_versie before update on public.events for each row execute function public.tg_event_versie();

-- 3. Melding naar wie komt als de titel, de datum, het uur of de plaats verandert, en als de activiteit wegvalt
create or replace function public.tg_push_event_wijzig() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if (new.titel, new.datum, new.uur, new.plaats) is distinct from (old.titel, old.datum, old.uur, old.plaats) then
      perform public.push_event(jsonb_build_object('type', 'evupd', 'id', new.id, 'door', auth.uid(),
        'oud', jsonb_build_object('titel', old.titel, 'datum', old.datum, 'uur', old.uur, 'plaats', old.plaats)));
    end if;
    return new;
  end if;
  -- verwijderd: de inschrijvingen verdwijnen mee, dus wie kwam gaat mee in de melding
  perform public.push_event(jsonb_build_object('type', 'evweg', 'door', auth.uid(),
    'ev', jsonb_build_object('titel', old.titel, 'datum', old.datum, 'uur', old.uur, 'plaats', old.plaats),
    'naar', coalesce((select jsonb_agg(r.user_id) from public.rsvp r where r.event_id = old.id and r.antw = 'ja'), '[]'::jsonb)));
  return old;
end $$;
drop trigger if exists push_event_wijzig on public.events;
create trigger push_event_wijzig after update on public.events for each row execute function public.tg_push_event_wijzig();
drop trigger if exists push_event_weg on public.events;
create trigger push_event_weg before delete on public.events for each row execute function public.tg_push_event_wijzig();
revoke all on function public.tg_push_event_wijzig() from public, anon, authenticated;
