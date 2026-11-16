-- TriDagboek: database en privacyregels (Row Level Security)
-- Principe: elk lid ziet enkel zijn eigen dagboek. Een goedgekeurde coach ziet ook
-- het dagboek van de sporters die hem als coach kozen. Enkel het clubgedeelte
-- (gesprekken, agenda, en wat iemand zelf deelt) is zichtbaar voor alle leden.

-- ---------- leden ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  naam        text not null default '' check (char_length(naam) <= 60),
  rol         text not null default 'zelf' check (rol in ('zelf','gecoacht','coach')),
  coach_id    uuid references public.profiles(id) on delete set null,
  status      text not null default 'wacht' check (status in ('wacht','actief','geweigerd')),
  is_admin    boolean not null default false,
  coach_ok    boolean not null default false,
  akkoord_at  timestamptz,
  created_at  timestamptz not null default now()
);

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and status = 'actief')
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and status = 'actief' and is_admin)
$$;

-- is de ingelogde gebruiker de goedgekeurde coach van sporter a?
create or replace function public.is_coach_of(a uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.profiles s
    join public.profiles c on c.id = s.coach_id
    where s.id = a and s.status = 'actief'
      and c.id = auth.uid() and c.status = 'actief' and c.coach_ok and c.rol = 'coach')
$$;

-- nieuw account: profiel aanmaken; het allereerste account wordt beheerder
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare eerste boolean;
begin
  perform pg_advisory_xact_lock(4242);
  select not exists(select 1 from public.profiles) into eerste;
  insert into public.profiles(id, naam, status, is_admin, akkoord_at)
  values (new.id,
          left(coalesce(new.raw_user_meta_data->>'naam', ''), 60),
          case when eerste then 'actief' else 'wacht' end,
          eerste,
          case when (new.raw_user_meta_data->>'akkoord') = 'true' then now() end);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- enkel de beheerder wijzigt status, beheerder en coach-goedkeuring
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;            -- beheer via SQL / service
  if not public.is_admin() then
    if new.id is distinct from old.id or new.status is distinct from old.status
       or new.is_admin is distinct from old.is_admin or new.coach_ok is distinct from old.coach_ok
       or new.created_at is distinct from old.created_at or new.akkoord_at is distinct from old.akkoord_at then
      raise exception 'Alleen de beheerder kan dit wijzigen';
    end if;
    if new.coach_id is distinct from old.coach_id and new.coach_id is not null and not exists(
         select 1 from public.profiles c where c.id = new.coach_id and c.coach_ok and c.rol = 'coach' and c.status = 'actief') then
      raise exception 'Kies een goedgekeurde coach';
    end if;
  end if;
  if new.rol <> 'coach' and old.rol = 'coach' then new.coach_ok := false; end if;
  return new;
end $$;

drop trigger if exists protect_profile on public.profiles;
create trigger protect_profile before update on public.profiles
  for each row execute function public.protect_profile();

alter table public.profiles enable row level security;
drop policy if exists prof_select on public.profiles;
create policy prof_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin() or (public.is_member() and status = 'actief'));
drop policy if exists prof_update on public.profiles;
create policy prof_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());
drop policy if exists prof_delete on public.profiles;
create policy prof_delete on public.profiles for delete to authenticated
  using (public.is_admin() and id <> auth.uid());

-- ---------- privé dagboek (instellingen, zones, logboek, ochtendcheck, materiaal) ----------
create table if not exists public.athletes (
  id          uuid primary key references public.profiles(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb check (pg_column_size(data) < 3000000),
  updated_at  timestamptz not null default now()
);
alter table public.athletes enable row level security;
drop policy if exists ath_select on public.athletes;
create policy ath_select on public.athletes for select to authenticated
  using (id = auth.uid() or public.is_coach_of(id));
drop policy if exists ath_insert on public.athletes;
create policy ath_insert on public.athletes for insert to authenticated
  with check (id = auth.uid() and public.is_member());
drop policy if exists ath_update on public.athletes;
create policy ath_update on public.athletes for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and public.is_member());
drop policy if exists ath_delete on public.athletes;
create policy ath_delete on public.athletes for delete to authenticated
  using (id = auth.uid());

-- ---------- schema van de coach (ook een coach met een eigen schema) ----------
create table if not exists public.plans (
  athlete_id  uuid primary key references public.profiles(id) on delete cascade,
  cplan       jsonb not null default '{}'::jsonb check (pg_column_size(cplan) < 1000000),
  cnote       jsonb not null default '{}'::jsonb check (pg_column_size(cnote) < 200000),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);
alter table public.plans enable row level security;
drop policy if exists plan_select on public.plans;
create policy plan_select on public.plans for select to authenticated
  using (athlete_id = auth.uid() or public.is_coach_of(athlete_id));
drop policy if exists plan_insert on public.plans;
create policy plan_insert on public.plans for insert to authenticated
  with check ((athlete_id = auth.uid() and public.is_member()) or public.is_coach_of(athlete_id));
drop policy if exists plan_update on public.plans;
create policy plan_update on public.plans for update to authenticated
  using ((athlete_id = auth.uid() and public.is_member()) or public.is_coach_of(athlete_id))
  with check ((athlete_id = auth.uid() and public.is_member()) or public.is_coach_of(athlete_id));

-- ---------- berichten tussen sporter en coach ----------
create table if not exists public.cmsg (
  id          bigint generated always as identity primary key,
  athlete_id  uuid not null references public.profiles(id) on delete cascade,
  van_coach   boolean not null,
  auteur      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  t           text not null check (char_length(t) between 1 and 1000),
  ts          timestamptz not null default now()
);
create index if not exists cmsg_athlete on public.cmsg(athlete_id, ts);
alter table public.cmsg enable row level security;
drop policy if exists cmsg_select on public.cmsg;
create policy cmsg_select on public.cmsg for select to authenticated
  using (athlete_id = auth.uid() or public.is_coach_of(athlete_id));
drop policy if exists cmsg_insert on public.cmsg;
create policy cmsg_insert on public.cmsg for insert to authenticated
  with check (auteur = auth.uid() and (
    (athlete_id = auth.uid() and not van_coach and public.is_member())
    or (van_coach and public.is_coach_of(athlete_id))));

-- ---------- club: gesprekken ----------
create table if not exists public.chat (
  id      bigint generated always as identity primary key,
  kanaal  text not null check (kanaal in ('algemeen','zwemmen','fietsen','lopen','wedstrijden')),
  auteur  uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  t       text not null check (char_length(t) between 1 and 1000),
  sys     boolean not null default false,
  ts      timestamptz not null default now()
);
create index if not exists chat_kanaal on public.chat(kanaal, ts);
alter table public.chat enable row level security;
drop policy if exists chat_select on public.chat;
create policy chat_select on public.chat for select to authenticated using (public.is_member());
drop policy if exists chat_insert on public.chat;
create policy chat_insert on public.chat for insert to authenticated
  with check (auteur = auth.uid() and public.is_member());
drop policy if exists chat_delete on public.chat;
create policy chat_delete on public.chat for delete to authenticated
  using (auteur = auth.uid() or public.is_admin());

-- ---------- club: agenda ----------
create table if not exists public.events (
  id          bigint generated always as identity primary key,
  titel       text not null check (char_length(titel) between 1 and 60),
  type        text not null default 'club' check (type in ('zwem','fiets','loop','club')),
  datum       date not null,
  uur         text not null default '' check (uur ~ '^([0-2][0-9]:[0-5][0-9])?$'),
  plaats      text not null default '' check (char_length(plaats) <= 80),
  info        text not null default '' check (char_length(info) <= 300),
  auteur      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now()
);
alter table public.events enable row level security;
drop policy if exists ev_select on public.events;
create policy ev_select on public.events for select to authenticated using (public.is_member());
drop policy if exists ev_insert on public.events;
create policy ev_insert on public.events for insert to authenticated
  with check (auteur = auth.uid() and public.is_member());
drop policy if exists ev_update on public.events;
create policy ev_update on public.events for update to authenticated
  using (auteur = auth.uid() or public.is_admin()) with check (public.is_member());
drop policy if exists ev_delete on public.events;
create policy ev_delete on public.events for delete to authenticated
  using (auteur = auth.uid() or public.is_admin());

create table if not exists public.rsvp (
  event_id  bigint not null references public.events(id) on delete cascade,
  user_id   uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  primary key (event_id, user_id)
);
alter table public.rsvp enable row level security;
drop policy if exists rsvp_select on public.rsvp;
create policy rsvp_select on public.rsvp for select to authenticated using (public.is_member());
drop policy if exists rsvp_insert on public.rsvp;
create policy rsvp_insert on public.rsvp for insert to authenticated
  with check (user_id = auth.uid() and public.is_member());
drop policy if exists rsvp_delete on public.rsvp;
create policy rsvp_delete on public.rsvp for delete to authenticated using (user_id = auth.uid());

-- ---------- club: wat een lid zelf deelt (standaard niets) ----------
-- enkel weektotalen-bronnen (datum, sport, duur, km) en gedeelde wedstrijden
create table if not exists public.shares (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb check (pg_column_size(data) < 300000),
  updated_at  timestamptz not null default now()
);
alter table public.shares enable row level security;
drop policy if exists sh_select on public.shares;
create policy sh_select on public.shares for select to authenticated using (public.is_member());
drop policy if exists sh_insert on public.shares;
create policy sh_insert on public.shares for insert to authenticated
  with check (user_id = auth.uid() and public.is_member());
drop policy if exists sh_update on public.shares;
create policy sh_update on public.shares for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists sh_delete on public.shares;
create policy sh_delete on public.shares for delete to authenticated using (user_id = auth.uid());

create table if not exists public.kudos (
  owner   uuid not null references public.profiles(id) on delete cascade,
  log_id  text not null check (char_length(log_id) <= 60),
  giver   uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  primary key (owner, log_id, giver)
);
alter table public.kudos enable row level security;
drop policy if exists kd_select on public.kudos;
create policy kd_select on public.kudos for select to authenticated using (public.is_member());
drop policy if exists kd_insert on public.kudos;
create policy kd_insert on public.kudos for insert to authenticated
  with check (giver = auth.uid() and public.is_member());
drop policy if exists kd_delete on public.kudos;
create policy kd_delete on public.kudos for delete to authenticated using (giver = auth.uid());

-- ---------- AI-gebruik per dag (enkel voor de server) ----------
create table if not exists public.ai_usage (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  dag      date not null default current_date,
  n        integer not null default 0,
  primary key (user_id, dag)
);
alter table public.ai_usage enable row level security;

-- ---------- live bijwerken van gesprekken en coachberichten ----------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.chat; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.cmsg; exception when duplicate_object then null; end;
  end if;
end $$;

-- ---------- toegang: enkel ingelogde gebruikers, de privacyregels hierboven bepalen welke rijen ----------
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to authenticated;
grant select, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.athletes, public.plans, public.cmsg, public.chat,
  public.events, public.rsvp, public.shares, public.kudos to authenticated;
revoke all on public.ai_usage from anon, authenticated;
revoke all on function public.is_member(), public.is_admin(), public.is_coach_of(uuid) from public, anon;
grant execute on function public.is_member(), public.is_admin(), public.is_coach_of(uuid) to authenticated;
revoke all on function public.handle_new_user(), public.protect_profile() from public, anon, authenticated;
