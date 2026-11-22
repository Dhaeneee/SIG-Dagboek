// Legati Tri Dagboek – persoonlijk trainingsschema als JSON, alleen lezen
//   GET /schema/<sleutel>  -> het schema van dit lid (zoals het lid het zelf in de app ziet)
// Bedoeld voor een eigen app van een lid die zijn schema overneemt (eenrichting: niets wordt hier gewijzigd).
// Zonder inloggen, maar met een lange geheime sleutel per lid (tabel schema_feed, enkel leesbaar voor de server).
// Er is geen knop in de website; de beheerder maakt de sleutel aan in de database.
// Versie 2: ook de eigen Garmin-gegevens van dit lid (activiteiten 60 dagen, slaap/HRV/rustpols/stress/VO2max 30 dagen),
// zodat de eigen app van het lid geen aparte Garmin-koppeling nodig heeft.
// Deploy zonder JWT-controle.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const DAG = /^\d{4}-\d{2}-\d{2}$/;
const VELDEN = ["k", "sp", "s", "t", "min", "z", "km"] as const;

// maandag van de week van dag d (YYYY-MM-DD)
export function maandag(d: string): string {
  const x = new Date(d + "T12:00:00Z"); const wd = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - wd); return x.toISOString().slice(0, 10);
}

// Zelfde regel als de website: een sporter met een coach ziet enkel de weken die de coach zichtbaar zette;
// een coach (ook met een eigen schema) ziet alles.
export function schema(plan: { cplan?: any; cnote?: any; cpub?: any } | null, rol: string, van: string) {
  const cplan = plan?.cplan ?? {}, cnote = plan?.cnote ?? {}, pub = plan?.cpub ?? {};
  const zichtbaar = (d: string) => rol === "coach" || !!pub[maandag(d)];
  const trainingen = Object.keys(cplan).filter((d) => DAG.test(d) && d >= van && zichtbaar(d)).sort().map((d) => {
    const e = cplan[d] ?? {}, out: Record<string, unknown> = { datum: d };
    for (const k of VELDEN) if (e[k] !== undefined && e[k] !== null && e[k] !== "") out[k] = e[k];
    return out;
  });
  const weeknotities: Record<string, string> = {};
  for (const [w, t] of Object.entries(cnote)) if (DAG.test(w) && w >= maandag(van) && zichtbaar(w) && typeof t === "string" && t) weeknotities[w] = t;
  return { trainingen, weeknotities };
}

const GARMIN = ["activity", "daily", "sleep", "hrv", "stress", "metrics"];
// eigen Garmin-rijen van het lid, enkel kind/ref/day/data
export function garmin(rows: any[] | null, vanAct: string, vanGez: string) {
  return (rows ?? []).filter((r) => r && GARMIN.includes(r.kind) && typeof r.ref === "string" && r.data && (!r.day || r.day >= (r.kind === "activity" ? vanAct : vanGez)))
    .map((r) => ({ kind: r.kind, ref: r.ref, day: r.day ?? null, data: r.data }));
}

function sbKey(): string {
  try { const j = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); if (j && typeof j.default === "string" && j.default) return j.default; } catch { /* oude sleutel */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

if (typeof Deno !== "undefined" && Deno.serve) {
  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", sbKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const hdr = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" };
  const fout = (s: number) => new Response(JSON.stringify({ error: s === 404 ? "onbekend" : "fout" }), { status: s, headers: hdr });
  Deno.serve(async (req) => {
    if (req.method !== "GET") return fout(404);
    const tok = (new URL(req.url).pathname.split("/").pop() ?? "").toLowerCase();
    if (!/^[a-f0-9]{48}$/.test(tok)) return fout(404);
    try {
      const { data: f } = await db.from("schema_feed").select("user_id").eq("token", tok).maybeSingle();
      if (!f) return fout(404);
      const { data: p } = await db.from("profiles").select("status, rol").eq("id", f.user_id).maybeSingle();
      if (p?.status !== "actief") return fout(404);
      const { data: plan } = await db.from("plans").select("cplan, cnote, cpub, updated_at").eq("athlete_id", f.user_id).maybeSingle();
      const van = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
      const van30 = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const { data: g } = await db.from("garmin_data").select("kind, ref, day, data").eq("user_id", f.user_id).gte("day", van).order("day").limit(2000);
      await db.from("schema_feed").update({ last_used: new Date().toISOString() }).eq("user_id", f.user_id);
      return new Response(JSON.stringify({ bron: "Legati Tri Dagboek", versie: 2, gewijzigd: plan?.updated_at ?? null, gemaakt: new Date().toISOString(), ...schema(plan, p.rol, van), garmin: garmin(g, van, van30) }), { status: 200, headers: hdr });
    } catch (e) { console.error(e); return fout(503); }
  });
}
