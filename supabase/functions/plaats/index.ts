// Legati Tri Dagboek – plaatsen en adressen opzoeken terwijl je typt (de velden "Waar")
//   POST /plaats  { q, s? }  (lid ingelogd) -> { r: [{ t, s, v }], bron }
//      t = hoofdregel (bv. "Roeselare" of "Groep Huyzentruyt"), s = tweede regel (adres), v = wat in het veld komt
// Bronnen:
//   - Google Places Autocomplete (New), enkel als het geheim GOOGLE_PLACES_KEY bestaat: kent ook bedrijven en zalen.
//   - Photon (OpenStreetMap, komoot): steden, gemeenten, straten en huisnummers. Gratis, zonder sleutel.
// Enkel de getypte tekst gaat naar de bron, niet wie het typt.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

export type Hit = { t: string; s: string; v: string };

const LAND: Record<string, string> = {
  BE: "België", NL: "Nederland", FR: "Frankrijk", DE: "Duitsland", LU: "Luxemburg", DK: "Denemarken", ES: "Spanje", IT: "Italië",
  AT: "Oostenrijk", CH: "Zwitserland", GB: "Verenigd Koninkrijk", IE: "Ierland", PT: "Portugal", SE: "Zweden", NO: "Noorwegen",
  US: "Verenigde Staten", PL: "Polen", CZ: "Tsjechië", HR: "Kroatië", GR: "Griekenland", FI: "Finland", EE: "Estland", SI: "Slovenië",
};
const PLACE = new Set(["city", "district", "locality", "county", "state", "country"]);
const clean = (x: unknown) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim().slice(0, 80) : "");
const join = (a: string[]) => a.filter(Boolean).join(", ");

// Photon (GeoJSON) -> regels
export function photonHits(j: any): Hit[] {
  const out: Hit[] = [];
  for (const f of Array.isArray(j?.features) ? j.features : []) {
    const p = f?.properties ?? {};
    const cc = clean(p.countrycode).toUpperCase(), land = cc && cc !== "BE" ? (LAND[cc] ?? clean(p.country)) : "";
    const naam = clean(p.name), plaats = clean(p.city) || clean(p.town) || clean(p.village) || clean(p.locality) || clean(p.district);
    const straat = clean(p.street) ? clean(p.street) + (clean(p.housenumber) ? " " + clean(p.housenumber) : "") : "";
    const pc = clean(p.postcode), ppl = pc && plaats ? pc + " " + plaats : plaats;
    const type = clean(p.type);
    let h: Hit | null = null;
    if (PLACE.has(type) && naam) {
      const st = clean(p.state);
      h = type === "city" ? { t: naam, s: join([pc, st, land]), v: join([naam, land]) }
        : type === "county" ? { t: naam, s: join(["arrondissement", st, land]), v: join([naam, land]) }
        : type === "state" || type === "country" ? { t: naam, s: land, v: join([naam, land]) }
        : { t: naam, s: join([ppl !== naam ? ppl : pc, land]), v: join([naam, plaats !== naam ? plaats : "", land]) };
    }
    else if (type === "house" && !naam && straat) h = { t: straat, s: join([ppl, land]), v: join([straat, plaats, land]) };
    else if (type === "street" && naam) h = { t: naam, s: join([ppl, land]), v: join([naam, plaats, land]) };
    else if (naam) h = { t: naam, s: join([straat, ppl, land]), v: join([naam, straat, plaats, land]) };
    if (h && h.t) out.push(h);
  }
  return out;
}

// Google Places Autocomplete (New) -> regels
export function googleHits(j: any): Hit[] {
  const out: Hit[] = [];
  for (const sg of Array.isArray(j?.suggestions) ? j.suggestions : []) {
    const pp = sg?.placePrediction; if (!pp) continue;
    const t = clean(pp.structuredFormat?.mainText?.text) || clean(pp.text?.text);
    const s = clean(pp.structuredFormat?.secondaryText?.text).replace(/,?\s*(België|Belgium|Belgique|Belgien)$/i, "");
    if (t) out.push({ t, s, v: join([t, s]).slice(0, 80) });
  }
  return out;
}

export function merge(lists: Hit[][], n = 6): Hit[] {
  const seen = new Set<string>(), out: Hit[] = [];
  for (const L of lists) for (const h of L) {
    const k = h.v.toLowerCase(); if (seen.has(k)) continue;
    seen.add(k); out.push({ t: h.t.slice(0, 80), s: h.s.slice(0, 120), v: h.v.slice(0, 80) });
    if (out.length >= n) return out;
  }
  return out;
}

const LAT = 50.95, LON = 3.2;   // West-Vlaanderen: dichtbij komt eerst, maar alles blijft vindbaar
export async function zoek(q: string, sess: string, key: string, f: typeof fetch = fetch): Promise<{ r: Hit[]; bron: string }> {
  const ph = (async () => {
    const u = `https://photon.komoot.io/api/?${new URLSearchParams({ q, limit: "8", lat: String(LAT), lon: String(LON) })}`;
    const r = await f(u, { headers: { "User-Agent": "LegatiTriDagboek/2027 (club-app)" } });
    return r.ok ? photonHits(await r.json()) : [];
  })().catch(() => [] as Hit[]);
  const go = key ? (async () => {
    const body: Record<string, unknown> = { input: q, languageCode: "nl", regionCode: "be", locationBias: { circle: { center: { latitude: LAT, longitude: LON }, radius: 50000 } } };
    if (/^[A-Za-z0-9-]{8,64}$/.test(sess)) body.sessionToken = sess;
    const r = await f("https://places.googleapis.com/v1/places:autocomplete", { method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key }, body: JSON.stringify(body) });
    if (!r.ok) { console.error("google", r.status); return [] as Hit[]; }
    return googleHits(await r.json());
  })().catch(() => [] as Hit[]) : Promise.resolve([] as Hit[]);
  const [g, p] = await Promise.all([go, ph]);
  return { r: merge([g, p]), bron: g.length ? (p.length ? "google+osm" : "google") : "osm" };
}

// ---------- server ----------
function sbKey(): string {
  try { const j = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); if (j && typeof j.default === "string" && j.default) return j.default; } catch { /* oude sleutel */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

if (typeof Deno !== "undefined" && Deno.serve) {
  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", sbKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const KEY = Deno.env.get("GOOGLE_PLACES_KEY") ?? "";
  const cache = new Map<string, { at: number; v: { r: Hit[]; bron: string } }>();
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    try {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data: { user } } = token ? await db.auth.getUser(token) : { data: { user: null } };
      if (!user) return json({ error: "niet_ingelogd" }, 401);
      const { data: p } = await db.from("profiles").select("status").eq("id", user.id).maybeSingle();
      if (p?.status !== "actief") return json({ error: "geen_lid" }, 403);
      const body = await req.json().catch(() => ({}));
      const q = clean(body?.q);
      if (q.length < 2) return json({ r: [], bron: "" });
      const k = q.toLowerCase(), c = cache.get(k);
      if (c && Date.now() - c.at < 6 * 3600_000) return json(c.v);
      const v = await zoek(q, typeof body?.s === "string" ? body.s : "", KEY);
      if (cache.size > 500) cache.clear();
      cache.set(k, { at: Date.now(), v });
      return json(v);
    } catch (e) {
      console.error(e);
      return json({ r: [], bron: "" });
    }
  });
}
