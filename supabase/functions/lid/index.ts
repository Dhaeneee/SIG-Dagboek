// Legati Tri Dagboek – een lid uit de club zetten (enkel beheerders)
//   POST /lid  { id }  -> { ok: true }
// Het account (inloggegevens) wordt gewist. Via de koppelingen in de database verdwijnen ook het profiel,
// het dagboek, het schema en alles wat aan die persoon hangt. Wil die persoon terugkomen, dan maakt hij
// opnieuw een account en keurt een beheerder hem opnieuw goed.
// Regels: enkel een actieve beheerder; nooit jezelf; nooit een andere beheerder (eerst die rol intrekken).
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "methode" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const db = createClient(url, sbKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    // wie vraagt het? (het token wordt hier opnieuw gecontroleerd, niet enkel gelezen)
    const { data: who, error: we } = await db.auth.getUser(token);
    const me = who?.user?.id;
    if (we || !me) return json({ error: "niet_ingelogd" }, 401);
    const body = await req.json().catch(() => ({}));
    const id = typeof body?.id === "string" ? body.id : "";
    if (!UUID.test(id)) return json({ error: "ongeldig" }, 400);
    if (id === me) return json({ error: "jezelf" }, 400);
    const { data: ik } = await db.from("profiles").select("is_admin,status").eq("id", me).maybeSingle();
    if (!ik?.is_admin || ik.status !== "actief") return json({ error: "geen_beheerder" }, 403);
    const { data: hij } = await db.from("profiles").select("is_admin").eq("id", id).maybeSingle();
    if (hij?.is_admin) return json({ error: "beheerder" }, 400);
    // het account wissen; profiel en gegevens volgen via de koppelingen (on delete cascade)
    const { error: de } = await db.auth.admin.deleteUser(id);
    if (de) { console.error("deleteUser", de.message); return json({ error: "mislukt" }, 500); }
    await db.from("profiles").delete().eq("id", id);   // voor de zekerheid, als er geen account meer was
    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ error: "mislukt" }, 500);
  }
});
