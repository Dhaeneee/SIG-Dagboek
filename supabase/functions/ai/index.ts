// TriDagboek AI-functie: testverslagen inlezen (foto of pdf) en een week aanpassen.
// De Anthropic-sleutel staat als geheim ANTHROPIC_API_KEY in Supabase en komt nooit in de website.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
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
const MODEL: Record<string, string> = {
  lab: Deno.env.get("AI_MODEL_LAB") ?? "claude-sonnet-5-5",
  adapt: Deno.env.get("AI_MODEL_QUICK") ?? "claude-haiku-5-5",
};
const DAILY_LIMIT = Number(Deno.env.get("AI_DAILY_LIMIT") ?? "40");
const TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "methode" }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: "geen_sleutel" }, 503);
  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "niet_ingelogd" }, 401);
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return json({ error: "niet_ingelogd" }, 401);

    const { data: prof } = await admin.from("profiles").select("status").eq("id", user.id).maybeSingle();
    if (!prof || prof.status !== "actief") return json({ error: "geen_lid" }, 403);

    const body = await req.json().catch(() => ({}));
    const kind = body.kind === "lab" || body.kind === "adapt" ? body.kind : null;
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!kind || !prompt || prompt.length > 15000) return json({ error: "ongeldig" }, 400);
    const files = Array.isArray(body.files) ? body.files.slice(0, 4) : [];
    for (const f of files) {
      if (!f || !TYPES.includes(f.mediaType) || typeof f.data !== "string" || f.data.length > 7_000_000) {
        return json({ error: "bestand" }, 400);
      }
    }

    const dag = new Date().toISOString().slice(0, 10);
    const { data: use } = await admin.from("ai_usage").select("n").eq("user_id", user.id).eq("dag", dag).maybeSingle();
    const n = use?.n ?? 0;
    if (n >= DAILY_LIMIT) return json({ error: "limiet" }, 429);
    await admin.from("ai_usage").upsert({ user_id: user.id, dag, n: n + 1 });

    const content = [
      ...files.map((f: { mediaType: string; data: string }) =>
        f.mediaType === "application/pdf"
          ? { type: "document", source: { type: "base64", media_type: f.mediaType, data: f.data } }
          : { type: "image", source: { type: "base64", media_type: f.mediaType, data: f.data } }),
      { type: "text", text: prompt },
    ];
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL[kind], max_tokens: kind === "lab" ? 2000 : 1500, messages: [{ role: "user", content }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("anthropic", r.status, JSON.stringify(j).slice(0, 600));
      return json({ error: r.status === 429 || r.status === 529 ? "druk" : "ai_fout" }, 502);
    }
    const text = (j.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
    return json({ text });
  } catch (e) {
    console.error(e);
    return json({ error: "fout" }, 500);
  }
});
