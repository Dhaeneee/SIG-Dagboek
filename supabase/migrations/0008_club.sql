-- Legati Tri Dagboek: profielfoto, "kan niet komen" in de agenda, en datumpolls
-- 1. Profielfoto: een klein verkleind beeld (jpeg, 160x160) als data-URL, zichtbaar voor de leden
alter table public.profiles add column if not exists foto text;
alter table public.profiles drop constraint if exists profiles_foto_ok;
alter table public.profiles add constraint profiles_foto_ok
  check (foto is null or (char_length(foto) <= 40000 and foto like 'data:image/jpeg;base64,%'));

-- 2. Agenda: antwoord "ja" (ik kom) of "nee" (ik kan niet). Wie geen rij heeft, antwoordde nog niet.
alter table public.rsvp add column if not exists antw text not null default 'ja';
alter table public.rsvp drop constraint if exists rsvp_antw_ok;
alter table public.rsvp add constraint rsvp_antw_ok check (antw in ('ja','nee'));
drop policy if exists rsvp_update on public.rsvp;
create policy rsvp_update on public.rsvp for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member());

-- 3. Datumpolls: een lid stelt 2 tot 8 datums voor, de leden stemmen per datum ja / misschien / nee
create table if not exists public.polls (
  id          bigint generated always as identity primary key,
  titel       text not null check (char_length(titel) between 1 and 60),
  type        text not null default 'club' check (type in ('zwem','fiets','loop','club')),
  plaats      text not null default '' check (char_length(plaats) <= 80),
  info        text not null default '' check (char_length(info) <= 300),
  opties      jsonb not null check (jsonb_typeof(opties) = 'array' and jsonb_array_length(opties) between 2 and 8 and pg_column_size(opties) < 2000),
  open        boolean not null default true,
  event_id    bigint references public.events(id) on delete set null,
  auteur      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now()
);
alter table public.polls enable row level security;
drop policy if exists poll_select on public.polls;
create policy poll_select on public.polls for select to authenticated using (public.is_member());
drop policy if exists poll_insert on public.polls;
create policy poll_insert on public.polls for insert to authenticated
  with check (auteur = auth.uid() and public.is_member());
drop policy if exists poll_update on public.polls;
create policy poll_update on public.polls for update to authenticated
  using (auteur = auth.uid() or public.is_admin()) with check (public.is_member());
drop policy if exists poll_delete on public.polls;
create policy poll_delete on public.polls for delete to authenticated
  using (auteur = auth.uid() or public.is_admin());

create table if not exists public.poll_votes (
  poll_id  bigint not null references public.polls(id) on delete cascade,
  user_id  uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  keuze    smallint[] not null check (array_length(keuze, 1) between 1 and 8 and keuze <@ array[0,1,2]::smallint[]),  -- per datum: 2 ja, 1 misschien, 0 nee
  ts       timestamptz not null default now(),
  primary key (poll_id, user_id)
);
alter table public.poll_votes enable row level security;
drop policy if exists pv_select on public.poll_votes;
create policy pv_select on public.poll_votes for select to authenticated using (public.is_member());
drop policy if exists pv_insert on public.poll_votes;
create policy pv_insert on public.poll_votes for insert to authenticated
  with check (user_id = auth.uid() and public.is_member() and exists (select 1 from public.polls p where p.id = poll_id and p.open));
drop policy if exists pv_update on public.poll_votes;
create policy pv_update on public.poll_votes for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_member() and exists (select 1 from public.polls p where p.id = poll_id and p.open));
drop policy if exists pv_delete on public.poll_votes;
create policy pv_delete on public.poll_votes for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on public.polls, public.poll_votes to authenticated;
revoke all on public.polls, public.poll_votes from anon;
