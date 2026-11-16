// TriDagboek – Garmin Connect-koppeling (Garmin Connect Developer Program, OAuth 2.0 met PKCE)
//   POST /garmin/start       (lid ingelogd)  -> { url } naar de toestemmingspagina van Garmin
//   GET  /garmin/callback    (Garmin)        -> wisselt de code voor tokens, terug naar de website
//   POST /garmin/disconnect  (lid ingelogd)  -> verbreekt de koppeling bij Garmin en bij ons
//   POST /garmin/push        (Garmin)        -> slaap, HRV, rustpols, Body Battery en trainingen
//   POST /garmin/pkey        (lid ingelogd)  -> persoonlijke Garmin-sleutel opslaan en meteen ophalen
//   POST /garmin/psync       (lid ingelogd)  -> nu ophalen met de persoonlijke sleutel
//   POST /garmin/punkey      (lid ingelogd)  -> persoonlijke sleutel verwijderen
//   POST /garmin/cron        (pg_cron)       -> elk kwartier ophalen voor alle leden met een sleutel
// Deploy zonder JWT-controle (Garmin stuurt geen Supabase-token); leden worden hier zelf gecontroleerd.
// Geheimen: GARMIN_CLIENT_ID, GARMIN_CLIENT_SECRET, SITE_URL. Er wordt nooit een gps-locatie bewaard.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { exchangeKey, KeyError, syncUser, type PRow } from "./personal.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
// Supabase-sleutels: eerst de nieuwe (sb_secret / sb_publishable), anders de oude JWT-sleutels.
function sbKey(kind: "secret" | "publishable"): string {
  try {
    const j = JSON.parse(Deno.env.get(kind === "secret" ? "SUPABASE_SECRET_KEYS" : "SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
    if (j && typeof j.default === "string" && j.default) return j.default;
  } catch { /* oude sleutels gebruiken */ }
  return Deno.env.get(kind === "secret" ? "SUPABASE_SERVICE_ROLE_KEY" : "SUPABASE_ANON_KEY") ?? "";
}
const SERVICE_KEY = sbKey("secret");
const CLIENT_ID = Deno.env.get("GARMIN_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GARMIN_CLIENT_SECRET") ?? "";
const SITE_URL = (Deno.env.get("SITE_URL") ?? "https://dhaeneee.github.io/SIG-Dagboek").replace(/\/$/, "");
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/garmin/callback`;
const AUTH_URL = "https://connect.garmin.com/oauth2Confirm";
const TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const API = "https://apis.garmin.com/wellness-api/rest";

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const back = (q: string) => new Response(null, { status: 302, headers: { Location: `${SITE_URL}/?garmin=${q}#instellingen` } });
const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = (n = 48) => b64url(crypto.getRandomValues(new Uint8Array(n)));

type Link = { user_id: string; garmin_user_id: string; access_token: string | null; refresh_token: string | null; expires_at: string | null };

async function member(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return null;
  const { data: p } = await db.from("profiles").select("status").eq("id", user.id).maybeSingle();
  return p?.status === "actief" ? user : null;
}

async function tokenRequest(params: Record<string, string>) {
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`token ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j as { access_token: string; refresh_token?: string; expires_in?: number };
}

async function accessToken(l: Link) {
  if (l.access_token && l.expires_at && new Date(l.expires_at).getTime() - Date.now() > 120_000) return l.access_token;
  const j = await tokenRequest({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: l.refresh_token ?? "" });
  const upd = { access_token: j.access_token, refresh_token: j.refresh_token ?? l.refresh_token, expires_at: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString() };
  await db.from("garmin_links").update(upd).eq("user_id", l.user_id);
  Object.assign(l, upd);
  return j.access_token;
}

// ---------- gegevens omzetten (klein houden, nooit gps) ----------
const DROP = new Set(["sleepLevelsMap", "hrvValues", "timeOffsetHeartRateSamples", "timeOffsetStressLevelValues", "timeOffsetBodyBatteryValues", "timeOffsetSleepSpo2", "timeOffsetSleepRespiration"]);
const slim = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !DROP.has(k)));
const SUMMARY_KEYS = ["activityId", "activityName", "activityType", "startTimeInSeconds", "startTimeOffsetInSeconds", "durationInSeconds", "movingDurationInSeconds",
  "distanceInMeters", "averageHeartRateInBeatsPerMinute", "maxHeartRateInBeatsPerMinute", "averageSpeedInMetersPerSecond", "totalElevationGainInMeters",
  "averagePowerInWatts", "averageBikeCadenceInRoundsPerMinute", "averageRunCadenceInStepsPerMinute", "deviceName", "manual"];
const pickSummary = (s: Record<string, unknown>) => Object.fromEntries(SUMMARY_KEYS.filter(k => s[k] != null).map(k => [k, s[k]]));
const dayOf = (s: Record<string, unknown>) => {
  if (typeof s.calendarDate === "string") return s.calendarDate;
  const t = Number(s.startTimeInSeconds ?? 0) + Number(s.startTimeOffsetInSeconds ?? 0);
  return t ? new Date(t * 1000).toISOString().slice(0, 10) : null;
};
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

// deno-lint-ignore no-explicit-any
function processDetails(d: any) {
  const s = d.summary ?? {}, S: any[] = Array.isArray(d.samples) ? d.samples : [];
  const t0 = s.startTimeInSeconds ?? S[0]?.startTimeInSeconds ?? 0;
  const dur = Math.max(1, s.durationInSeconds ?? ((S.at(-1)?.startTimeInSeconds ?? t0) - t0));
  const bike = /CYCL|BIK|RIDE|SPIN/.test(String(s.activityType ?? ""));
  const bin = Math.max(30, Math.ceil(dur / 400 / 10) * 10), nb = Math.ceil((dur + 1) / bin);
  const acc = Array.from({ length: nb }, () => ({ h: [] as number[], o: [] as number[], e: [] as number[] }));
  for (const x of S) {
    if (x.startTimeInSeconds == null) continue;
    const a = acc[Math.min(nb - 1, Math.max(0, Math.floor((x.startTimeInSeconds - t0) / bin)))];
    if (x.heartRate > 30) a.h.push(x.heartRate);
    if (x.elevationInMeters != null) a.e.push(x.elevationInMeters);
    if (bike) { if (x.powerInWatts != null) a.o.push(x.powerInWatts); } else if (x.speedMetersPerSecond != null) a.o.push(x.speedMetersPerSecond);
  }
  const t: number[] = [], H: (number | null)[] = [], O: (number | null)[] = [], E: (number | null)[] = [];
  acc.forEach((a, i) => {
    t.push(+((i * bin + bin / 2) / 60).toFixed(2));
    const hh = mean(a.h), ee = mean(a.e), oo = mean(a.o);
    H.push(hh == null ? null : Math.round(hh)); E.push(ee == null ? null : Math.round(ee));
    O.push(bike ? (oo == null ? null : Math.round(oo)) : (oo != null && oo > 1 ? Math.round(1000 / oo) : null));
  });
  const starts: number[] = (Array.isArray(d.laps) ? d.laps : []).map((l: any) => l.startTimeInSeconds).filter((v: unknown) => typeof v === "number").sort((a: number, b: number) => a - b);
  const laps = starts.map((st, i) => {
    const en = i < starts.length - 1 ? starts[i + 1] : t0 + dur, xs = S.filter(x => x.startTimeInSeconds >= st && x.startTimeInSeconds < en);
    const hr = mean(xs.map(x => x.heartRate).filter((v: number) => v > 30)), w = mean(xs.map(x => x.powerInWatts).filter((v: unknown) => v != null));
    return { a: +((st - t0) / 60).toFixed(2), dur: en - st, el: en - st, hr: hr ? Math.round(hr) : null, w: w ? Math.round(w) : null };
  });
  const pw = S.map(x => x.powerInWatts).filter((v: unknown) => v != null) as number[];
  return {
    summary: pickSummary(s),
    st: { t, hr: H.some(v => v) ? H : null, o: O.some(v => v) ? O : null, el: E.some(v => v != null) ? E : null },
    laps, avgPower: pw.length ? Math.round(mean(pw)!) : null,
  };
}

const KINDS: Record<string, string> = {
  dailies: "daily", sleeps: "sleep", hrv: "hrv", stressDetails: "stress", userMetrics: "metrics",
  activities: "activity", manuallyUpdatedActivities: "activity", activityDetails: "activity",
};

// deno-lint-ignore no-explicit-any
async function store(uid: string, key: string, kind: string, s: any) {
  const received_at = new Date().toISOString();
  if (kind === "activity") {
    const ref = String(s.activityId ?? s.summary?.activityId ?? s.summaryId ?? "").replace(/-detail$/, "");
    if (!ref) return;
    let data: any = key === "activityDetails" ? processDetails(s) : { summary: pickSummary(s) };
    const { data: old } = await db.from("garmin_data").select("data").eq("user_id", uid).eq("kind", "activity").eq("ref", ref).maybeSingle();
    if (old?.data) data = { ...old.data, ...data, summary: { ...(old.data.summary ?? {}), ...data.summary }, st: data.st ?? old.data.st, laps: data.laps ?? old.data.laps };
    await db.from("garmin_data").upsert({ user_id: uid, kind, ref, day: dayOf(data.summary), data, received_at });
    return;
  }
  let data: any = slim(s);
  if (kind === "stress") {
    const v = Object.values(s.timeOffsetBodyBatteryValues ?? {}).filter(x => typeof x === "number") as number[];
    data = { calendarDate: s.calendarDate, bbMax: v.length ? Math.max(...v) : null, bbLast: v.length ? v[v.length - 1] : null };
  }
  const ref = String(s.summaryId ?? s.calendarDate ?? crypto.randomUUID());
  await db.from("garmin_data").upsert({ user_id: uid, kind, ref, day: dayOf(s), data, received_at });
}

// deno-lint-ignore no-explicit-any
async function push(body: any) {
  const cache = new Map<string, Link | null>();
  const linkFor = async (gid: string) => {
    if (!cache.has(gid)) { const { data } = await db.from("garmin_links").select("*").eq("garmin_user_id", gid).maybeSingle(); cache.set(gid, data as Link | null); }
    return cache.get(gid) ?? null;
  };
  for (const d of body.deregistrations ?? []) {
    const l = await linkFor(d.userId); if (l) await db.from("garmin_links").delete().eq("user_id", l.user_id);
  }
  for (const [key, kind] of Object.entries(KINDS)) {
    for (const item of body[key] ?? []) {
      try {
        const l = await linkFor(item.userId); if (!l) continue;
        let items = [item];
        if (item.callbackURL) {                                   // ping: gegevens zelf ophalen
          const cb = new URL(String(item.callbackURL));            // token enkel naar Garmin zelf sturen
          if (cb.protocol !== "https:" || !(cb.hostname === "garmin.com" || cb.hostname.endsWith(".garmin.com"))) continue;
          const r = await fetch(cb.toString(), { headers: { Authorization: `Bearer ${await accessToken(l)}` } });
          const j = r.ok ? await r.json() : []; items = Array.isArray(j) ? j : [j];
        }
        for (const s of items) await store(l.user_id, key, kind, s);
      } catch (e) { console.error("push", key, e); }
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const path = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop();
  try {
    if (path === "push" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      await push(body);
      return new Response("ok", { status: 200 });
    }
    if (path === "callback" && req.method === "GET") {
      const u = new URL(req.url), code = u.searchParams.get("code"), state = u.searchParams.get("state");
      if (!code || !state) return back("geweigerd");
      const { data: pk } = await db.from("garmin_pkce").select("*").eq("state", state).maybeSingle();
      await db.from("garmin_pkce").delete().eq("state", state);
      if (!pk || Date.now() - new Date(pk.created_at).getTime() > 15 * 60_000) return back("verlopen");
      const tok = await tokenRequest({ grant_type: "authorization_code", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, code_verifier: pk.verifier, redirect_uri: REDIRECT_URI });
      const r = await fetch(`${API}/user/id`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const { userId } = await r.json();
      if (!userId) return back("fout");
      const { data: other } = await db.from("garmin_links").select("user_id").eq("garmin_user_id", userId).maybeSingle();
      if (other && other.user_id !== pk.user_id) return back("bezet");
      await db.from("garmin_links").upsert({ user_id: pk.user_id, garmin_user_id: userId, access_token: tok.access_token, refresh_token: tok.refresh_token ?? null, expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString() });
      return back("ok");
    }
    if (path === "cron" && req.method === "POST") {
      const k = req.headers.get("x-cron-key") ?? "";
      const { data: ok } = k ? await db.rpc("garmin_cron_ok", { k }) : { data: false };
      if (ok !== true) return json({ error: "nee" }, 401);
      const { data: rows } = await db.from("garmin_personal").select("*");
      let n = 0, users = 0;
      for (const row of (rows ?? []) as PRow[]) {
        // een ingetrokken sleutel nog hoogstens om de 6 uur proberen
        if (row.last_error === "sleutel" && row.last_sync && Date.now() - Date.parse(row.last_sync) < 6 * 3600_000) continue;
        users++; n += (await syncUser(db, row)).n;
      }
      return json({ ok: true, users, n });
    }
    const user = await member(req);
    if (!user) return json({ error: "niet_ingelogd" }, 401);
    if (path === "pkey" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const key = typeof body.key === "string" ? body.key.replace(/\s+/g, "") : "";
      if (!/^[\x21-\x7e]{16,512}$/.test(key)) return json({ error: "ongeldig" }, 400);
      let t;
      try { t = await exchangeKey(key); }
      catch (e) { return e instanceof KeyError ? json({ error: "sleutel_ongeldig" }, 400) : json({ error: "garmin_druk" }, 502); }
      const row: PRow = { user_id: user.id, api_key: key, token: t.token, token_exp: t.exp.toISOString(), last_sync: null, last_health: null, last_ok: null, last_error: null };
      const { error } = await db.from("garmin_personal").upsert(row);
      if (error) { console.error("pkey", error.message); return json({ error: "fout" }, 500); }
      const r = await syncUser(db, row, { health: true });
      return json({ ok: true, n: r.n, error: r.error });
    }
    if (path === "psync" && req.method === "POST") {
      const { data: row } = await db.from("garmin_personal").select("*").eq("user_id", user.id).maybeSingle();
      if (!row) return json({ error: "geen_sleutel" }, 404);
      if (row.last_sync && Date.now() - Date.parse(row.last_sync) < 60_000) return json({ ok: true, n: 0, wait: true });
      const r = await syncUser(db, row as PRow, { health: true });
      return json({ ok: true, n: r.n, error: r.error });
    }
    if (path === "punkey" && req.method === "POST") {
      await db.from("garmin_personal").delete().eq("user_id", user.id);
      return json({ ok: true });
    }
    if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: "niet_ingesteld" }, 503);
    if (path === "start" && req.method === "POST") {
      const verifier = rand(48), state = rand(24);
      const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      await db.from("garmin_pkce").delete().lt("created_at", new Date(Date.now() - 3600_000).toISOString());
      await db.from("garmin_pkce").insert({ state, user_id: user.id, verifier });
      const q = new URLSearchParams({ client_id: CLIENT_ID, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", redirect_uri: REDIRECT_URI, state });
      return json({ url: `${AUTH_URL}?${q}` });
    }
    if (path === "disconnect" && req.method === "POST") {
      const { data: l } = await db.from("garmin_links").select("*").eq("user_id", user.id).maybeSingle();
      if (l) {
        try { await fetch(`${API}/user/registration`, { method: "DELETE", headers: { Authorization: `Bearer ${await accessToken(l as Link)}` } }); } catch (e) { console.error("deregister", e); }
        await db.from("garmin_links").delete().eq("user_id", user.id);
      }
      return json({ ok: true });
    }
    return json({ error: "onbekend" }, 404);
  } catch (e) {
    console.error(e);
    if (path === "callback") return back("fout");
    if (path === "push") return new Response("ok", { status: 200 });
    return json({ error: "fout" }, 500);
  }
});
