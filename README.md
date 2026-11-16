# TriDagboek

Het trainingsdagboek van de club: een statische website (GitHub Pages) met een Supabase-database.

## Wat staat waar

| Bestand | Wat |
|---|---|
| `index.html` | De website: inloggen, welkomstpagina per rol, Vandaag, Plan, Club, Coach, Logboek, Zones, Materiaal, Instellingen |
| `privacy.html` | Privacyverklaring |
| `config.js` | Projectlink en publishable key van Supabase (openbaar, geen geheimen) |
| `vendor/supabase.js` | Supabase-client (v2) |
| `supabase/migrations/0001_tridagboek.sql` | Tabellen en privacyregels (Row Level Security) |
| `supabase/functions/ai/index.ts` | AI op de server: testverslag inlezen, week aanpassen |
| `supabase/migrations/0002_garmin.sql` | Tabellen voor de Garmin-koppeling (tokens enkel voor de server) |
| `supabase/functions/garmin/index.ts` | Garmin Connect: koppelen (OAuth 2.0 met PKCE), push-meldingen, ontkoppelen |

## Privacy in de database

- Elk lid ziet alleen zijn eigen dagboek (`athletes`).
- Een coach ziet het dagboek, het schema en de berichten van de sporters die hem als coach kozen, als de beheerder zijn coachrol goedkeurde.
- Alle leden zien het clubgedeelte: gesprekken, agenda, inschrijvingen, duimpjes, en wat iemand zelf deelt (`shares`, standaard niets).
- Nieuwe accounts wachten op goedkeuring. Het allereerste account wordt beheerder.
- Status, beheerder en coach-goedkeuring kan enkel de beheerder wijzigen.

## Online zetten

1. **Database:** voer `supabase/migrations/0001_tridagboek.sql` uit (SQL Editor of migratie).
2. **AI:** deploy de functie `ai` en zet het geheim `ANTHROPIC_API_KEY` bij Edge Functions, Secrets.
3. **Inloggen:** zet bij Authentication, Sign In / Providers, Email, **Confirm email** uit, zolang er geen eigen mailserver is. De standaardmail van Supabase stuurt alleen naar teamleden.
4. **config.js:** vul `url` en `key` (publishable key) in.
5. **GitHub Pages:** zet de bestanden in de repository en kies bij Settings, Pages: Deploy from a branch, `main`, map `/ (root)`.
6. **Eerste account:** de beheerder maakt als allereerste een account aan.

## Garmin Connect

1. Vraag Starter Access aan in het Garmin Connect Developer Program (Activity API en Health API).
2. Geef Garmin deze adressen:
   - redirect/callback: `https://<project>.supabase.co/functions/v1/garmin/callback`
   - push-meldingen (alle gegevenstypes): `https://<project>.supabase.co/functions/v1/garmin/push`
3. Voer `0002_garmin.sql` uit en deploy de functie `garmin` **zonder JWT-controle** (Garmin stuurt geen Supabase-token; de functie controleert leden zelf).
4. Geheimen: `GARMIN_CLIENT_ID`, `GARMIN_CLIENT_SECRET`, `SITE_URL` (het adres van de website).
5. Zet `garmin: true` in `config.js`. Leden zien dan de knop **Koppelen** bij Instellingen.

Er wordt geen gps-locatie bewaard; per training enkel hartslag, tempo/vermogen en hoogte per 30 seconden.

## Persoonlijke Garmin-sleutel

Zolang de club-app niet goedgekeurd is door Garmin, kan elk lid koppelen met zijn eigen
persoonlijke sleutel (Garmin Connect Personal API, https://connect.garmin.com/app/settings/personalApiToken).

- `config.js`: `garminKey: true`.
- Migraties `0004_garmin_persoonlijk.sql` (tabel `garmin_personal`, enkel leesbaar voor de server) en
  `0005_garmin_kwartier.sql` (pg_cron roept elk kwartier `/functions/v1/garmin/cron` aan, met een sleutel uit de Vault).
- De functie `garmin` (bestanden `index.ts` en `personal.ts`) wisselt de sleutel om voor een toegangstoken (24 uur),
  haalt trainingen op (met het .fit-bestand voor lopen en fietsen) en elk uur slaap, HRV, rustpols en Body Battery.
- Garmin bedoelt de persoonlijke sleutel voor eigen gebruik, niet voor commerciële apps met veel gebruikers.
  Voor de club op lange termijn blijft het Developer Program (hierboven) de juiste weg.

## Pushmeldingen

- `sw.js` (service worker, enkel voor meldingen), `manifest.webmanifest` en de iconen maken van de site een app voor het beginscherm.
- Functie `push` (bestanden `index.ts` en `webpush.ts`, deploy zonder JWT-controle): versleuteling volgens RFC 8291 en VAPID,
  zonder externe bibliotheek. De VAPID-sleutels maakt de functie zelf de eerste keer en bewaart ze in `app_keys` (enkel server).
- Migratie `0006_meldingen.sql`: tabel `push_subs` en triggers op `garmin_data` (nieuwe training), `cmsg` (bericht) en
  `profiles` (nieuw lid), die via pg_net `/functions/v1/push/event` aanroepen met de sleutel uit de Vault.
- Op iPhone werken meldingen enkel als de site via Safari op het beginscherm staat (iOS 16.4 of nieuwer).

## Training opladen

Tot de Garmin- en Wahoo-koppeling klaar is, laden leden hun training op als `.fit` of `.zip` (Garmin Connect: activiteit, tandwiel, Origineel exporteren). De website leest het bestand in de browser: duur, afstand, hartslag, vermogen, hoogte, rondes, grafieken, tijd in zones en hartslagdrift. Er wordt geen gps-route bewaard.

## Lokaal testen

`test/mksite.sh` bouwt een testversie met een nagebootste Supabase (`test/mock-supabase.js`); `test/e2e.py` doorloopt de hele testronde. `test/rls_test.sql` test de privacyregels op een lokale Postgres.
