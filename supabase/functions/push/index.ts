// Legati Tri Dagboek – pushmeldingen (web push) naar de app op het beginscherm
//   GET  /push/key          (iedereen)      -> publieke VAPID-sleutel (de server maakt ze zelf de eerste keer)
//   POST /push/subscribe    (lid ingelogd)  -> dit toestel inschrijven en een bevestiging sturen
//   POST /push/unsubscribe  (lid ingelogd)  -> dit toestel uitschrijven
//   POST /push/test         (lid ingelogd)  -> testmelding naar al je toestellen
//   POST /push/event        (database)      -> nieuwe training, bericht of nieuw lid (met de sleutel uit de Vault)
// Deploy zonder JWT-controle (de database stuurt geen gebruikerstoken); leden worden hier zelf gecontroleerd.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { newVapid, okEndpoint, sendPush, unb64u, type Sub, type Vapid } from "./webpush.ts";
import { sportOf } from "./sports.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
function sbKey(): string {
  try {
    const j = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    if (j && typeof j.default === "string" && j.default) return j.default;
  } catch { /* oude sleutel gebruiken */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const db = createClient(SUPABASE_URL, sbKey(), { auth: { persistSession: false, autoRefreshToken: false } });
const CONTACT = Deno.env.get("PUSH_CONTACT") ?? "https://dhaeneee.github.io/SIG-Dagboek";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

let VAPID: Vapid | null = null;
async function vapid(): Promise<Vapid> {
  if (VAPID) return VAPID;
  const read = async () => (await db.from("app_keys").select("value").eq("name", "vapid").maybeSingle()).data?.value as string | undefined;
  let v = await read();
  if (!v) {
    await db.from("app_keys").upsert({ name: "vapid", value: JSON.stringify(await newVapid()) }, { onConflict: "name", ignoreDuplicates: true });
    v = await read();
  }
  if (!v) throw new Error("geen vapid");
  return (VAPID = JSON.parse(v) as Vapid);
}

async function member(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return null;
  const { data: p } = await db.from("profiles").select("id,status").eq("id", user.id).maybeSingle();
  return p?.status === "actief" ? user : null;
}

type Msg = { title: string; body: string; url: string; tag?: string };
type SubRow = Sub & { fails: number | null };

async function deliver(rows: SubRow[], m: Msg) {
  let sent = 0;
  for (const s of rows) {
    let st = 0;
    try { st = await sendPush(s, m, await vapid(), CONTACT); } catch (e) { console.error("push", String(e)); }
    if (st >= 200 && st < 300) { sent++; await db.from("push_subs").update({ last_ok: new Date().toISOString(), fails: 0 }).eq("endpoint", s.endpoint); }
    else if (st === 404 || st === 410 || (st === 400 && !okEndpoint(s.endpoint))) await db.from("push_subs").delete().eq("endpoint", s.endpoint);
    else {
      const fails = (s.fails ?? 0) + 1;
      console.error("push status", st, new URL(s.endpoint).hostname);
      if (fails >= 10) await db.from("push_subs").delete().eq("endpoint", s.endpoint);
      else await db.from("push_subs").update({ fails }).eq("endpoint", s.endpoint);
    }
  }
  return sent;
}
// één melding naar veel leden (club): alle abonnementen in één keer ophalen
async function toUsers(uids: string[], m: Msg) {
  if (!uids.length) return 0;
  const { data } = await db.from("push_subs").select("endpoint,p256dh,auth,fails").in("user_id", uids);
  return deliver((data ?? []) as SubRow[], m);
}
// actieve leden, behalve wie het zelf deed, en enkel wie die soort meldingen niet uitzette (pushChat / pushAgenda)
async function clubLeden(behalve: string, soort: "pushChat" | "pushAgenda") {
  const { data: mem } = await db.from("profiles").select("id").eq("status", "actief");
  const ids = (mem ?? []).map((r: { id: string }) => r.id).filter((id: string) => id !== behalve);
  if (!ids.length) return [];
  const { data: ath } = await db.from("athletes").select("id,data").in("id", ids);
  const uit = new Set((ath ?? []).filter((a: any) => a?.data?.p?.[soort] === false).map((a: any) => a.id));
  return ids.filter((id: string) => !uit.has(id));
}
const KANAAL: Record<string, string> = { algemeen: "Algemeen", zwemmen: "Zwemmen", fietsen: "Fietsen", lopen: "Lopen", wedstrijden: "Wedstrijden" };
const dagLang = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
// deno-lint-ignore no-explicit-any
export function eventMsg(e: any, auteur: string) {
  const wanneer = dagLang(String(e.datum)) + (e.uur ? " om " + String(e.uur).replace(":", ".") + " uur" : "");
  return { title: `Nieuw in de agenda: ${trunc(e.titel, 50)}`, body: trunc(`${first(auteur)} zette ${e.titel} op ${wanneer}${e.plaats ? ", " + e.plaats : ""}. Laat weten of je komt.`, 200) };
}
// deno-lint-ignore no-explicit-any
export function pollMsg(p: any, auteur: string) {
  const n = Array.isArray(p.opties) ? p.opties.length : 0;
  return { title: `Nieuwe poll: ${trunc(p.titel, 50)}`, body: trunc(`${first(auteur)} vraagt welke datum past${n ? " (" + n + " datums)" : ""}. Stem bij Club, Agenda.`, 200) };
}
// wat er veranderde aan een activiteit, in gewone woorden
// deno-lint-ignore no-explicit-any
export function evupdMsg(nu: any, oud: any, door: string | null) {
  const uur = (u: unknown) => (u ? String(u).replace(":", ".") + " uur" : "");
  const delen: string[] = [];
  if (String(nu.datum) !== String(oud?.datum ?? nu.datum) || String(nu.uur ?? "") !== String(oud?.uur ?? nu.uur ?? ""))
    delen.push(`nu op ${dagLang(String(nu.datum))}${nu.uur ? " om " + uur(nu.uur) : ""} (was ${dagLang(String(oud?.datum ?? nu.datum))}${oud?.uur ? " om " + uur(oud.uur) : ""})`);
  if (String(nu.plaats ?? "") !== String(oud?.plaats ?? nu.plaats ?? "")) delen.push(nu.plaats ? `nieuwe plaats: ${nu.plaats}` : "de plaats is weggehaald");
  if (String(nu.titel) !== String(oud?.titel ?? nu.titel)) delen.push(`nieuwe naam: ${nu.titel}`);
  if (!delen.length) return null;
  return { title: `Aangepast: ${trunc(oud?.titel ?? nu.titel, 50)}`, body: trunc(`${door ? first(door) + " paste de activiteit aan: " : "De activiteit is aangepast: "}${delen.join(", ")}.`, 220) };
}
async function toUser(uid: string, m: Msg) {
  const { data } = await db.from("push_subs").select("endpoint,p256dh,auth,fails").eq("user_id", uid);
  return deliver((data ?? []) as SubRow[], m);
}

// ---------- teksten ----------
const first = (n: unknown) => (String(n ?? "").trim().split(/\s+/)[0] || "Een sporter").slice(0, 30);
const trunc = (t: unknown, n = 140) => { const s = String(t ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const localDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const addDay = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const monday = (d: string) => { const x = new Date(d + "T12:00:00Z"); return addDay(d, -((x.getUTCDay() + 6) % 7)); };
const dagMaand = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("nl-BE", { day: "numeric", month: "long", timeZone: "UTC" });
// tekst van de melding als de coach een week zichtbaar zet
// deno-lint-ignore no-explicit-any
export function schemaMsg(week: string, cplan: any, coachNaam: string | null) {
  const days = [0, 1, 2, 3, 4, 5, 6].map(i => addDay(week, i));
  const n = days.filter(d => { const x = cplan?.[d]; return x && x.k !== "rust" && !x.empty; }).length;
  const eind = days[6], van = new Date(week + "T12:00:00Z").getUTCMonth() === new Date(eind + "T12:00:00Z").getUTCMonth() ? String(Number(week.slice(8))) : dagMaand(week);
  const wie = coachNaam ? first(coachNaam) : "Je coach";
  return { title: "Je schema staat klaar", body: `${wie} zette je week van ${van} tot ${dagMaand(eind)} klaar: ${n} ${n === 1 ? "training" : "trainingen"}. Bekijk ze bij Plan.` };
}
// deno-lint-ignore no-explicit-any
export function actLine(s: any): string | null {
  const so = sportOf(s?.activityType); if (!so) return null;
  const [cat, name] = so, parts = [name], m = Number(s.distanceInMeters ?? 0), sec = Number(s.durationInSeconds ?? 0);
  if (m >= 100 && cat !== "kracht") parts.push(cat === "zwemmen" ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`);
  if (sec > 0) { const min = Math.round(sec / 60); parts.push(min >= 60 ? `${Math.floor(min / 60)}u${String(min % 60).padStart(2, "0")}` : `${min} min`); }
  return parts.join(" · ");
}

// ochtendmelding: zelfde regels als de ochtendcheck in de app (judge), met de drempels uit Instellingen
// deno-lint-ignore no-explicit-any
export function morningMsg(p: any, rol: string, rows: any[], plan: any) {
  const pick = (kind: string, f: (d: any) => unknown) => { for (const r of rows) if (r.kind === kind) { const v = Number(f(r.data ?? {})); if (r.data && f(r.data) != null && isFinite(v)) return v; } return null; };
  const sec = pick("sleep", d => d.durationInSeconds);
  if (sec == null) return null;
  const score = pick("sleep", d => d.overallSleepScore?.value ?? d.sleepScores?.overall?.value);
  const hrv = pick("hrv", d => d.lastNightAvg);
  const rp = pick("daily", d => d.restingHeartRateInBeatsPerMinute);
  const bb = pick("stress", d => d.bbMax) ?? pick("daily", d => d.bodyBatteryHighestValue ?? d.bodyBatteryMostRecentValue);
  const nr = (v: unknown, def: number) => (v !== "" && v != null && isFinite(Number(v)) ? Number(v) : def);
  const slm = nr(p?.slm, 6), hrvl = nr(p?.hrvl, 50), rpn = nr(p?.rp, 55), bbm = nr(p?.bbm, 40);
  const s: string[] = [];
  if (sec / 3600 < slm) s.push("kort geslapen");
  if (hrv != null && hrv < hrvl) s.push("HRV onder je normaal");
  if (rp != null && rp >= rpn + 5) s.push(`rustpols ${Math.round(rp - rpn)} slagen hoger dan normaal`);
  if (bb != null && bb < bbm) s.push("Body Battery laag");
  const kleur = s.length === 0 ? "groen" : s.length === 1 ? "oranje" : "rood", bol = s.length === 0 ? "🟢" : s.length === 1 ? "🟠" : "🔴";
  const min = Math.round(sec / 60);
  const vals = [`Slaap ${Math.floor(min / 60)}u${String(min % 60).padStart(2, "0")}` + (score != null ? ` (score ${Math.round(score)})` : ""),
    hrv != null ? `HRV ${Math.round(hrv)}` : "", rp != null ? `rustpols ${Math.round(rp)}` : "", bb != null ? `Body Battery ${Math.round(bb)}` : ""].filter(Boolean).join(" · ") + ".";
  const why = s.length ? ` Let op: ${s.join(", ")}.` : "";
  const usesPlan = (rol === "gecoacht" && (p?.src || "coach") === "coach") || (rol === "coach" && p?.src === "eigen");
  let today: string;
  if (usesPlan && plan && plan.s) {
    if (plan.k === "rust") today = " Vandaag: rust.";
    else {
      const km = plan.km ? (plan.sp === "zwemmen" ? `${Math.round(plan.km * 1000)} m` : `${String(Math.round(plan.km * 10) / 10).replace(".", ",")} km`) : "";
      const lab = [plan.t || "", km].filter(Boolean).join(" · ");
      today = kleur === "groen" ? ` Vandaag: ${plan.s}${lab ? ", " + lab : ""}.` : kleur === "oranje" ? ` Vandaag: ${plan.s}, maar korter en rustiger.` : " Vandaag: rust of heel rustig.";
    }
  } else today = kleur === "groen" ? " Tik om je training van vandaag te zien." : kleur === "oranje" ? " Vandaag korter en rustiger dan gepland." : " Vandaag: rust of heel rustig.";
  return { title: `${bol} Ochtendcheck: ${kleur}`, body: (vals + why + today).slice(0, 240) };
}

// ---------- gebeurtenissen uit de database ----------
// deno-lint-ignore no-explicit-any
export async function onEvent(e: any) {
  if (e?.type === "activity" && typeof e.user_id === "string" && typeof e.ref === "string") {
    const { data: r } = await db.from("garmin_data").select("data,day").eq("user_id", e.user_id).eq("kind", "activity").eq("ref", e.ref).maybeSingle();
    const s = r?.data?.summary ?? {}, start = Number(s.startTimeInSeconds ?? 0);
    if (!start || Date.now() / 1000 - start > 36 * 3600) return { skip: "oud" };        // geen meldingen voor oude trainingen
    const line = actLine(s); if (!line) return { skip: "sport" };
    const n = await toUser(e.user_id, { title: "Nieuwe training binnen", body: `${line}. Bekijk je analyse.`, url: r?.day === localDay() ? "#vandaag" : "#logboek", tag: `act-${e.ref}` });
    const { data: p } = await db.from("profiles").select("naam,status,coach_id").eq("id", e.user_id).maybeSingle();
    let c = 0;
    if (p?.status === "actief" && p.coach_id && p.coach_id !== e.user_id) {
      const { data: co } = await db.from("profiles").select("status,coach_ok,rol").eq("id", p.coach_id).maybeSingle();
      if (co?.status === "actief" && co.coach_ok && co.rol === "coach")
        c = await toUser(p.coach_id, { title: `${first(p.naam)} heeft getraind`, body: line, url: "#coach", tag: `cact-${e.ref}` });
    }
    return { sent: n, coach: c };
  }
  if (e?.type === "cmsg" && Number.isFinite(Number(e.id))) {
    const { data: m } = await db.from("cmsg").select("athlete_id,van_coach,t").eq("id", Number(e.id)).maybeSingle();
    if (!m) return { skip: "weg" };
    if (m.van_coach) return { sent: await toUser(m.athlete_id, { title: "Bericht van je coach", body: trunc(m.t), url: "#plan", tag: "cmsg" }) };
    const { data: p } = await db.from("profiles").select("naam,coach_id").eq("id", m.athlete_id).maybeSingle();
    if (!p?.coach_id) return { skip: "geen coach" };
    return { sent: await toUser(p.coach_id, { title: `Bericht van ${first(p.naam)}`, body: trunc(m.t), url: "#coach", tag: `cmsg-${m.athlete_id}` }) };
  }
  if (e?.type === "lid" && typeof e.user_id === "string") {
    const { data: p } = await db.from("profiles").select("naam,status").eq("id", e.user_id).maybeSingle();
    if (p?.status !== "wacht") return { skip: "niet wachtend" };
    const { data: admins } = await db.from("profiles").select("id").eq("is_admin", true).eq("status", "actief");
    let n = 0;
    for (const a of admins ?? []) n += await toUser(a.id, { title: "Nieuw lid wacht op goedkeuring", body: `${trunc(p.naam, 40) || "Iemand"} wil meedoen. Keur goed bij Instellingen.`, url: "#instellingen", tag: "lid" });
    return { sent: n };
  }
  if (e?.type === "ochtend" && typeof e.user_id === "string" && /^\d{4}-\d\d-\d\d$/.test(String(e.dag ?? ""))) {
    const dag = String(e.dag);
    const [{ data: ath }, { data: prof }, { data: rows }, { data: pl }] = await Promise.all([
      db.from("athletes").select("data").eq("id", e.user_id).maybeSingle(),
      db.from("profiles").select("rol,status").eq("id", e.user_id).maybeSingle(),
      db.from("garmin_data").select("kind,data").eq("user_id", e.user_id).eq("day", dag),
      db.from("plans").select("cplan,cpub").eq("athlete_id", e.user_id).maybeSingle(),
    ]);
    if (prof?.status !== "actief") return { skip: "geen lid" };
    const p = ath?.data?.p ?? {};
    if (p.pushOchtend === false) return { skip: "uitgezet" };
    const zichtbaar = String(prof.rol ?? "") === "coach" || !!pl?.cpub?.[monday(dag)];   // enkel weken die de coach vrijgaf
    const m = morningMsg(p, String(prof.rol ?? ""), rows ?? [], zichtbaar ? pl?.cplan?.[dag] ?? null : null);
    if (!m) return { skip: "geen slaap" };
    return { sent: await toUser(e.user_id, { ...m, url: "#vandaag", tag: `ochtend-${dag}` }) };
  }
  if (e?.type === "schema" && typeof e.user_id === "string" && /^\d{4}-\d\d-\d\d$/.test(String(e.week ?? ""))) {
    const wk = String(e.week);
    const [{ data: pl }, { data: prof }] = await Promise.all([
      db.from("plans").select("cplan,cpub").eq("athlete_id", e.user_id).maybeSingle(),
      db.from("profiles").select("status,coach_id").eq("id", e.user_id).maybeSingle(),
    ]);
    if (prof?.status !== "actief") return { skip: "geen lid" };
    if (!pl?.cpub?.[wk]) return { skip: "niet zichtbaar" };
    if (wk < monday(addDay(localDay(), -7))) return { skip: "oud" };                  // geen meldingen voor weken die al voorbij zijn
    const { data: co } = prof.coach_id ? await db.from("profiles").select("naam").eq("id", prof.coach_id).maybeSingle() : { data: null };
    const m = schemaMsg(wk, pl.cplan ?? {}, co?.naam ?? null);
    return { sent: await toUser(e.user_id, { ...m, url: "#plan", tag: `schema-${wk}` }) };
  }
  if ((e?.type === "event" || e?.type === "poll" || e?.type === "chat") && Number.isFinite(Number(e.id))) {
    const tabel = e.type === "event" ? "events" : e.type === "poll" ? "polls" : "chat";
    const { data: x } = await db.from(tabel).select("*").eq("id", Number(e.id)).maybeSingle();
    if (!x) return { skip: "weg" };
    if (Date.now() - Date.parse(x.created_at ?? x.ts ?? "") > 6 * 3600_000) return { skip: "oud" };
    if (e.type === "chat" && x.sys) return { skip: "automatisch" };
    const { data: au } = await db.from("profiles").select("naam,status").eq("id", x.auteur).maybeSingle();
    if (au?.status !== "actief") return { skip: "geen lid" };
    const naar = await clubLeden(x.auteur, e.type === "chat" ? "pushChat" : "pushAgenda");
    const m = e.type === "event" ? { ...eventMsg(x, au.naam), url: "#agenda", tag: `ev-${x.id}` }
      : e.type === "poll" ? { ...pollMsg(x, au.naam), url: "#agenda", tag: `poll-${x.id}` }
      : { title: `${first(au.naam)} · ${KANAAL[x.kanaal] ?? "Club"}`, body: trunc(x.t, 160), url: "#club", tag: `chat-${x.kanaal}` };
    return { sent: await toUsers(naar, m), leden: naar.length };
  }
  if (e?.type === "evupd" && Number.isFinite(Number(e.id))) {
    const { data: x } = await db.from("events").select("*").eq("id", Number(e.id)).maybeSingle();
    if (!x) return { skip: "weg" };
    if (String(x.datum) < localDay()) return { skip: "voorbij" };
    const { data: rs } = await db.from("rsvp").select("user_id").eq("event_id", x.id).eq("antw", "ja");
    const naar = (rs ?? []).map((r: { user_id: string }) => r.user_id).filter((u: string) => u !== e.door);
    const { data: wie } = typeof e.door === "string" ? await db.from("profiles").select("naam").eq("id", e.door).maybeSingle() : { data: null };
    const m = evupdMsg(x, e.oud ?? {}, wie?.naam ?? null);
    if (!m) return { skip: "niets veranderd" };
    return { sent: await toUsers(naar, { ...m, url: "#agenda", tag: `ev-${x.id}` }), leden: naar.length };
  }
  if (e?.type === "evweg" && e.ev && /^\d{4}-\d\d-\d\d$/.test(String(e.ev.datum ?? ""))) {
    if (String(e.ev.datum) < localDay()) return { skip: "voorbij" };
    const naar = (Array.isArray(e.naar) ? e.naar : []).filter((u: unknown) => typeof u === "string" && u !== e.door) as string[];
    const { data: wie } = typeof e.door === "string" ? await db.from("profiles").select("naam").eq("id", e.door).maybeSingle() : { data: null };
    const wanneer = dagLang(String(e.ev.datum)) + (e.ev.uur ? " om " + String(e.ev.uur).replace(":", ".") + " uur" : "");
    return { sent: await toUsers(naar, { title: `Afgelast: ${trunc(e.ev.titel, 50)}`, body: trunc(wie?.naam ? `${first(wie.naam)} haalde ${e.ev.titel} van ${wanneer} uit de agenda.` : `${e.ev.titel} van ${wanneer} is uit de agenda gehaald.`, 200), url: "#agenda", tag: "evweg" }), leden: naar.length };
  }
  return { skip: "onbekend" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const path = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop();
  try {
    if (path === "key") return json({ key: (await vapid()).publicKey });
    if (path === "event" && req.method === "POST") {
      const k = req.headers.get("x-cron-key") ?? "";
      const { data: ok } = k ? await db.rpc("garmin_cron_ok", { k }) : { data: false };
      if (ok !== true) return json({ error: "nee" }, 401);
      return json({ ok: true, ...(await onEvent(await req.json().catch(() => ({})))) });
    }
    const user = await member(req);
    if (!user) return json({ error: "niet_ingelogd" }, 401);
    const body = await req.json().catch(() => ({}));
    if (path === "subscribe" && req.method === "POST") {
      const endpoint = String(body?.endpoint ?? ""), p256dh = String(body?.keys?.p256dh ?? ""), auth = String(body?.keys?.auth ?? "");
      let good = okEndpoint(endpoint);
      try { good = good && unb64u(p256dh).length === 65 && unb64u(auth).length === 16; } catch { good = false; }
      if (!good) return json({ error: "ongeldig" }, 400);
      const ua = typeof body?.ua === "string" ? body.ua.slice(0, 60) : null;
      const { error } = await db.from("push_subs").upsert({ endpoint, user_id: user.id, p256dh, auth, ua, fails: 0 });
      if (error) { console.error("subscribe", error.message); return json({ error: "fout" }, 500); }
      const sent = await deliver([{ endpoint, p256dh, auth, fails: 0 }], { title: "Meldingen staan aan", body: "Vanaf nu hoor je het hier als er een training of een bericht binnenkomt.", url: "#instellingen", tag: "welkom" });
      return json({ ok: true, sent });
    }
    if (path === "unsubscribe" && req.method === "POST") {
      await db.from("push_subs").delete().eq("endpoint", String(body?.endpoint ?? "")).eq("user_id", user.id);
      return json({ ok: true });
    }
    if (path === "test" && req.method === "POST") {
      const sent = await toUser(user.id, { title: "Testmelding", body: "Meldingen werken op dit toestel.", url: "#instellingen", tag: "test" });
      return json({ ok: true, sent });
    }
    return json({ error: "onbekend" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "fout" }, 500);
  }
});
