-- Legati Tri Dagboek: de coach zet een week zichtbaar voor de sporter (vinkje); de sporter krijgt dan een melding.
-- plans.cpub = { "maandag van de week": "tijdstip van vrijgeven" }. Een week zonder sleutel ziet de sporter niet.
alter table public.plans add column if not exists cpub jsonb not null default '{}'::jsonb;
alter table public.plans drop constraint if exists plans_cpub_ok;
alter table public.plans add constraint plans_cpub_ok check (jsonb_typeof(cpub) = 'object' and pg_column_size(cpub) < 50000);

-- weken die al bestonden, blijven zichtbaar (zonder melding: de triggers bestaan nog niet)
update public.plans p set cpub = coalesce((
  select jsonb_object_agg(w, to_jsonb(now()::text)) from (
    select distinct to_char(date_trunc('week', k::date), 'YYYY-MM-DD') as w
    from jsonb_object_keys(p.cplan) k where k ~ '^\d{4}-\d{2}-\d{2}$') s), '{}'::jsonb)
where p.cpub = '{}'::jsonb;

-- enkel de coach van de sporter mag een week vrijgeven of verbergen
create or replace function public.protect_cpub() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_coach_of(new.athlete_id) then return new; end if;
  if tg_op = 'INSERT' then new.cpub := '{}'::jsonb; else new.cpub := old.cpub; end if;
  return new;
end $$;
drop trigger if exists protect_cpub on public.plans;
create trigger protect_cpub before insert or update on public.plans for each row execute function public.protect_cpub();

-- melding naar de sporter zodra een week zichtbaar wordt
create or replace function public.tg_push_schema() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  for k in select e.key from jsonb_each(coalesce(new.cpub, '{}'::jsonb)) e
           where jsonb_typeof(e.value) = 'string' and e.key ~ '^\d{4}-\d{2}-\d{2}$' loop
    if tg_op = 'INSERT' or not (coalesce(old.cpub, '{}'::jsonb) ? k) then
      perform public.push_event(jsonb_build_object('type', 'schema', 'user_id', new.athlete_id, 'week', k));
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists push_schema on public.plans;
create trigger push_schema after insert or update of cpub on public.plans for each row execute function public.tg_push_schema();
revoke all on function public.protect_cpub(), public.tg_push_schema() from public, anon, authenticated;
