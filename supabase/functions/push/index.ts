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
async function toUser(uid: string, m: Msg) {
  const { data } = await db.from("push_subs").select("endpoint,p256dh,auth,fails").eq("user_id", uid);
  return deliver((data ?? []) as SubRow[], m);
}

// ---------- teksten ----------
const first = (n: unknown) => (String(n ?? "").trim().split(/\s+/)[0] || "Een sporter").slice(0, 30);
const trunc = (t: unknown, n = 140) => { const s = String(t ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const localDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
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
      db.from("plans").select("cplan").eq("athlete_id", e.user_id).maybeSingle(),
    ]);
    if (prof?.status !== "actief") return { skip: "geen lid" };
    const p = ath?.data?.p ?? {};
    if (p.pushOchtend === false) return { skip: "uitgezet" };
    const m = morningMsg(p, String(prof.rol ?? ""), rows ?? [], pl?.cplan?.[dag] ?? null);
    if (!m) return { skip: "geen slaap" };
    return { sent: await toUser(e.user_id, { ...m, url: "#vandaag", tag: `ochtend-${dag}` }) };
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
