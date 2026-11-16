-- Elk kwartier de persoonlijke Garmin-sleutels laten ophalen (pg_cron + pg_net).
-- De sleutel voor deze oproep wordt hier willekeurig aangemaakt en in de Vault bewaard; niemand hoeft hem te kennen.
-- Pas de projectlink aan als je dit in een ander Supabase-project gebruikt.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$ begin
  if not exists (select 1 from vault.secrets where name = 'garmin_cron_key') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
                                'garmin_cron_key', 'Sleutel waarmee pg_cron de Garmin-functie aanroept');
  end if;
end $$;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'garmin-kwartier') then
    perform cron.unschedule('garmin-kwartier');
  end if;
end $$;

select cron.schedule('garmin-kwartier', '*/15 * * * *', $job$
  select net.http_post(
    url := 'https://ckpizktozroqaxfoqwpy.supabase.co/functions/v1/garmin/cron',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'garmin_cron_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$job$);
