// Legati Tri Dagboek – clubagenda als abonnement voor je gsm-agenda (iCalendar / webcal)
//   GET /agenda/<sleutel>.ics  -> de activiteiten waarvoor dit lid "Ik kom" tikte (van 60 dagen terug tot later)
// De agenda-app haalt dit zelf op; daarom zonder inloggen, maar met een lange geheime sleutel per lid (tabel agenda_feed).
// Deploy zonder JWT-controle.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

export type Ev = { id: number; titel: string; type: string; datum: string; uur: string; plaats: string; info: string; updated_at?: string; created_at?: string; seq?: number };

// tekst veilig maken voor iCalendar
export const icsText = (s: unknown) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
// regels van hoogstens 75 bytes (iCalendar-regel), vervolgregels beginnen met een spatie
export function fold(line: string): string {
  const enc = new TextEncoder(); if (enc.encode(line).length <= 75) return line;
  const out: string[] = []; let cur = "", n = 0, lim = 75;
  for (const ch of line) { const b = enc.encode(ch).length; if (n + b > lim) { out.push(cur); cur = " "; n = 1; lim = 75; } cur += ch; n += b; }
  out.push(cur); return out.join("\r\n");
}
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const dval = (d: string) => d.replace(/-/g, "");
const addDay = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const DUUR: Record<string, number> = { fiets: 180, loop: 90, zwem: 90, club: 120 };
const SOORT: Record<string, string> = { fiets: "Fietsen", loop: "Lopen", zwem: "Zwemmen", club: "Clubactiviteit" };

const VTZ = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Brussels",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
  "END:VTIMEZONE",
];

export function ics(evs: Ev[], club = "Legati Triteam", now = new Date()): string {
  const L: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Legati Triteam//Legati Tri Dagboek 2027//NL", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(club)}`, "X-WR-TIMEZONE:Europe/Brussels", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H", ...VTZ];
  for (const e of evs) {
    if (!/^\d{4}-\d\d-\d\d$/.test(e.datum)) continue;
    L.push("BEGIN:VEVENT", `UID:legati-ev-${e.id}@legati-tri-dagboek`, `DTSTAMP:${stamp(now)}`,
      `LAST-MODIFIED:${stamp(new Date(e.updated_at ?? e.created_at ?? now))}`, `SEQUENCE:${Number(e.seq ?? 0)}`);
    if (/^\d\d:\d\d$/.test(e.uur || "")) {
      const [h, m] = e.uur.split(":").map(Number), dur = DUUR[e.type] ?? 120, end = h * 60 + m + dur;
      const endDay = addDay(e.datum, Math.floor(end / 1440)), em = end % 1440;
      L.push(`DTSTART;TZID=Europe/Brussels:${dval(e.datum)}T${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}00`,
        `DTEND;TZID=Europe/Brussels:${dval(endDay)}T${String(Math.floor(em / 60)).padStart(2, "0")}${String(em % 60).padStart(2, "0")}00`);
    } else L.push(`DTSTART;VALUE=DATE:${dval(e.datum)}`, `DTEND;VALUE=DATE:${dval(addDay(e.datum, 1))}`);
    L.push(`SUMMARY:${icsText(e.titel)}`);
    if (e.plaats) L.push(`LOCATION:${icsText(e.plaats)}`);
    L.push(`DESCRIPTION:${icsText([SOORT[e.type] ?? "", e.info ?? "", "Uit de clubagenda van " + club + ". Kan je toch niet? Tik in de app op Ik kan niet."].filter(Boolean).join("\n"))}`,
      "STATUS:CONFIRMED", "TRANSP:OPAQUE", "END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n") + "\r\n";
}

// ---------- server ----------
function sbKey(): string {
  try { const j = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); if (j && typeof j.default === "string" && j.default) return j.default; } catch { /* oude sleutel */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
if (typeof Deno !== "undefined" && Deno.serve) {
  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", sbKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const CLUB = Deno.env.get("CLUB_NAAM") ?? "Legati Triteam";
  const niets = (s: number) => new Response(s === 404 ? "Deze agenda-link bestaat niet (meer). Maak een nieuwe in de app bij Instellingen." : "Even niet beschikbaar.", { status: s, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  Deno.serve(async (req) => {
    if (req.method !== "GET" && req.method !== "HEAD") return niets(404);
    const tok = (new URL(req.url).pathname.split("/").pop() ?? "").replace(/\.ics$/i, "").toLowerCase();
    if (!/^[a-f0-9]{48}$/.test(tok)) return niets(404);
    try {
      const { data: f } = await db.from("agenda_feed").select("user_id").eq("token", tok).maybeSingle();
      if (!f) return niets(404);
      const { data: p } = await db.from("profiles").select("status").eq("id", f.user_id).maybeSingle();
      if (p?.status !== "actief") return niets(404);
      const { data: rs } = await db.from("rsvp").select("event_id").eq("user_id", f.user_id).eq("antw", "ja");
      const ids = (rs ?? []).map((r: any) => r.event_id);
      const van = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
      const { data: evs } = ids.length ? await db.from("events").select("*").in("id", ids).gte("datum", van).order("datum") : { data: [] };
      return new Response(ics((evs ?? []) as Ev[], CLUB), { status: 200, headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "private, max-age=300", "Content-Disposition": 'inline; filename="legati-agenda.ics"' } });
    } catch (e) { console.error(e); return niets(503); }
  });
}
