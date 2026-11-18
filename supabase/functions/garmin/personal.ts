// Legati Tri Dagboek – persoonlijke Garmin-sleutel (Garmin Connect Personal API)
// Elk lid kan zijn eigen sleutel invullen. De server wisselt die om voor een toegangstoken (24 uur geldig)
// en haalt enkel gegevens van dat lid op: trainingen (met het .fit-bestand), slaap, HRV, rustpols en Body Battery.
// De gegevens worden in hetzelfde formaat bewaard als de push-meldingen van het Developer Program,
// zodat de website ze op dezelfde manier toont. Er wordt nooit een gps-locatie bewaard.
// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { sportOf } from "./sports.ts";
export { fitSportOf, sportOf } from "./sports.ts";

export const PBASE = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const MAX_FIT_PER_RUN = 6;          // .fit-bestanden per ophaalbeurt (de rest volgt bij de volgende)
const BACKFILL_DAYS = 14;           // eerste keer: twee weken terug
const HEALTH_EVERY_MS = 60 * 60_000; // gezondheidswaarden hoogstens elk uur

export type PRow = {
  user_id: string; api_key: string; token: string | null; token_exp: string | null;
  last_sync: string | null; last_health: string | null; last_ok: string | null; last_error: string | null;
};
type Fetch = typeof fetch;

export class KeyError extends Error {}
export class GarminError extends Error { constructor(public status: number, msg: string) { super(msg); } }

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);
// Belgische kalenderdag (Garmin werkt met de lokale dag van het horloge)
export const localDay = (d = new Date(), tz = "Europe/Brussels") =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export const localHour = (d = new Date(), tz = "Europe/Brussels") =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(d));

function jwtExp(tok: string): number | null {
  try {
    const p = tok.split(".")[1];
    const j = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - p.length % 4) % 4)));
    return typeof j.exp === "number" ? j.exp : null;
  } catch { return null; }
}

// sleutel omwisselen voor een toegangstoken
export async function exchangeKey(key: string, f: Fetch = fetch): Promise<{ token: string; exp: Date }> {
  const r = await f(PBASE + TOKEN_PATH, { method: "POST", headers: { Accept: "*/*", Authorization: `ApiKey ${key}` } });
  const text = (await r.text()).trim();
  if (r.status === 401 || r.status === 403 || r.status === 400 || r.status === 404) throw new KeyError(`sleutel ${r.status}`);
  if (!r.ok) throw new GarminError(r.status, `token ${r.status}`);
  let token = text;
  if (text.startsWith("{")) { try { const j = JSON.parse(text); token = j.access_token ?? j.token ?? ""; } catch { /* tekst */ } }
  if (!token) throw new GarminError(502, "leeg token");
  const exp = jwtExp(token);
  return { token, exp: new Date(exp ? exp * 1000 : Date.now() + 23 * 3600_000) };
}

// ---------------- .fit lezen (zelfde logica als op de website) ----------------
const FITEPOCH = 631065600;
export async function unzipFits(buf: ArrayBuffer): Promise<ArrayBuffer[]> {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  if (!(u8[0] === 0x50 && u8[1] === 0x4b)) return [buf];                 // geen zip: zelf een .fit
  let e = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) { if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; } }
  if (e < 0) throw new Error("zip");
  const n = dv.getUint16(e + 10, true); let q = dv.getUint32(e + 16, true); const out: ArrayBuffer[] = [];
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(q, true) !== 0x02014b50) break;
    const meth = dv.getUint16(q + 10, true), csz = dv.getUint32(q + 20, true), nl = dv.getUint16(q + 28, true),
      xl = dv.getUint16(q + 30, true), cl = dv.getUint16(q + 32, true), lo = dv.getUint32(q + 42, true),
      name = new TextDecoder().decode(u8.subarray(q + 46, q + 46 + nl));
    q += 46 + nl + xl + cl;
    if (!/\.fit$/i.test(name)) continue;
    const ds = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), data = u8.subarray(ds, ds + csz);
    if (meth === 0) out.push(data.slice().buffer);
    else if (meth === 8) {
      const st = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      out.push(await new Response(st).arrayBuffer());
    }
  }
  return out;
}

type Msg = Record<number, number>;
export function parseFit(buf: ArrayBuffer): { recs: Msg[]; laps: Msg[]; sess: Msg[]; lens: Msg[]; sports: { sport?: number; sub?: number; name?: string }[] } {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (u8.length < 14) throw new Error("kort");
  const hs = u8[0];
  if (String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) !== ".FIT") throw new Error("geen fit");
  const end = Math.min(u8.length, hs + dv.getUint32(4, true));
  const defs: Record<number, { g: number; le: boolean; fs: number[][]; len: number }> = {};
  const sports: { sport?: number; sub?: number; name?: string }[] = [];
  const recs: Msg[] = [], laps: Msg[] = [], sess: Msg[] = [], lens: Msg[] = [], BS = [1, 1, 1, 2, 2, 4, 4, 1, 4, 8, 1, 2, 4, 1, 8, 8, 8];
  let q = hs, lastTs = 0;
  const rd = (o: number, size: number, bt: number, le: boolean): number | null => {
    const b = bt & 31; if (b > 16 || size !== BS[b]) return null;
    switch (b) {
      case 0: case 2: case 13: { const v = dv.getUint8(o); return v === 255 ? null : v; }
      case 10: { const v = dv.getUint8(o); return v === 0 ? null : v; }
      case 1: { const v = dv.getInt8(o); return v === 127 ? null : v; }
      case 3: { const v = dv.getInt16(o, le); return v === 32767 ? null : v; }
      case 4: { const v = dv.getUint16(o, le); return v === 65535 ? null : v; }
      case 11: { const v = dv.getUint16(o, le); return v === 0 ? null : v; }
      case 5: { const v = dv.getInt32(o, le); return v === 2147483647 ? null : v; }
      case 6: { const v = dv.getUint32(o, le); return v === 4294967295 ? null : v; }
      case 12: { const v = dv.getUint32(o, le); return v === 0 ? null : v; }
      case 8: { const v = dv.getFloat32(o, le); return isFinite(v) ? v : null; }
      default: return null;
    }
  };
  const txt = (o: number, size: number) => { let e = o; while (e < o + size && u8[e] !== 0) e++; return new TextDecoder().decode(u8.subarray(o, e)).trim(); };
  const msg = (d: { le: boolean; g?: number; fs: number[][] }, o: number) => {
    if (d.g === 12) {
      const sp: { sport?: number; sub?: number; name?: string } = {};
      for (const [num, size, bt, off] of d.fs) {
        if (o + off + size > end) break;
        if (num === 3 && (bt & 31) === 7) sp.name = txt(o + off, size).slice(0, 40);
        else if (num === 0 || num === 1) { const v = rd(o + off, size, bt, d.le); if (v != null) sp[num === 0 ? "sport" : "sub"] = v; }
      }
      sports.push(sp); return {} as Msg;
    }
    const m: Msg = {};
    for (const [num, size, bt, off] of d.fs) { if (o + off + size > end) break; const v = rd(o + off, size, bt, d.le); if (v != null) m[num] = v; }
    return m;
  };
  // gps-velden (positie) worden nooit bewaard
  const put = (g: number, m: Msg) => {
    if (g === 20) { delete m[0]; delete m[1]; recs.push(m); }
    else if (g === 19) { [3, 4, 5, 6].forEach(k => delete m[k]); laps.push(m); }
    else if (g === 18) { [3, 4, 29, 30, 31, 32].forEach(k => delete m[k]); sess.push(m); }
    else if (g === 101) lens.push(m);
  };
  while (q < end) {
    const h = u8[q++];
    if (h & 128) {
      const d = defs[(h >> 5) & 3]; if (!d) throw new Error("def");
      const off = h & 31; let ts = (lastTs & ~31) + off; if (off < (lastTs & 31)) ts += 32; lastTs = ts;
      const m = msg(d, q); q += d.len; m[253] = ts; put(d.g, m); continue;
    }
    const lt = h & 15;
    if (h & 64) {
      const le = u8[q + 1] === 0, g = dv.getUint16(q + 2, le), nf = u8[q + 4];
      let r = q + 5, len = 0; const fs: number[][] = [];
      for (let i = 0; i < nf; i++) { fs.push([u8[r], u8[r + 1], u8[r + 2], len]); len += u8[r + 1]; r += 3; }
      if (h & 32) { const nd = u8[r++]; for (let i = 0; i < nd; i++) { len += u8[r + 1]; r += 3; } }
      defs[lt] = { g, le, fs, len }; q = r; continue;
    }
    const d = defs[lt]; if (!d) throw new Error("def");
    const m = msg(d, q); q += d.len; if (m[253] != null) lastTs = m[253]; put(d.g, m);
  }
  return { recs, laps, sess, lens, sports };
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

// .fit -> grafiekpunten (st), ronden (laps), zwemblokken (sw) en een samenvatting als aanvulling
// soort: "run" (tempo + cadans), "bike" (vermogen + snelheid), "swim" (lengtes en blokken), "other" (hartslag)
export type Kind = "run" | "bike" | "swim" | "other";
export const kindOf = (type: string): Kind =>
  /SWIM/.test(type) ? "swim" : /RUN/.test(type) ? "run" : /CYCL|BIK|RIDE|SPIN/.test(type) && !/MOTOR/.test(type) ? "bike" : "other";
const r1 = (v: number) => Math.round(v * 10) / 10;
export function fitDetails(f: { recs: Msg[]; laps: Msg[]; sess: Msg[]; lens?: Msg[] }, kind: Kind) {
  const R = f.recs.filter(r => r[253] != null), s = f.sess[0] ?? {};
  const t0 = s[2] ?? R[0]?.[253] ?? f.lens?.[0]?.[2] ?? f.laps[0]?.[2];
  if (t0 == null) return null;
  const fill: Record<string, number> = {};
  if (s[16] != null) fill.averageHeartRateInBeatsPerMinute = s[16];
  if (s[17] != null) fill.maxHeartRateInBeatsPerMinute = s[17];
  if (s[20] != null) fill.averagePowerInWatts = s[20];
  if (s[22] != null) fill.totalElevationGainInMeters = s[22];
  if (s[9] != null) fill.distanceInMeters = s[9] / 100;
  if (s[8] != null) fill.durationInSeconds = Math.round(s[8] / 1000);
  if (s[2] != null) fill.startTimeInSeconds = s[2] + FITEPOCH;
  const vmax = s[125] ?? s[15], vavg = s[124] ?? s[14];
  if (vmax != null && kind !== "swim") fill.maxSpeedInMetersPerSecond = Math.round(vmax / 10) / 100;
  if (vavg != null) fill.averageSpeedInMetersPerSecond = Math.round(vavg) / 1000;
  if (s[18] != null && kind === "run") fill.averageRunCadenceInStepsPerMinute = Math.round((s[18] + (s[41] ?? 0) / 128) * 2);
  if (s[18] != null && kind === "bike") fill.averageBikeCadenceInRoundsPerMinute = s[18];

  let st = null as null | Record<string, (number | null)[] | null>;
  if (R.length > 5) {
    const dur = Math.max(1, R[R.length - 1][253] - t0);
    const bin = Math.max(30, Math.ceil(dur / 400 / 10) * 10), nb = Math.ceil((dur + 1) / bin);
    const acc = Array.from({ length: nb }, () => ({ h: [] as number[], o: [] as number[], e: [] as number[], c: [] as number[], v: [] as number[] }));
    let vTop = 0;
    for (const r of R) {
      const a = acc[Math.min(nb - 1, Math.max(0, Math.floor((r[253] - t0) / bin)))];
      if (r[3] > 30) a.h.push(r[3]);
      const alt = r[78] != null ? r[78] / 5 - 500 : r[2] != null ? r[2] / 5 - 500 : null;
      if (alt != null && alt > -450 && kind !== "swim") a.e.push(alt);
      const v = r[73] != null ? r[73] / 1000 : r[6] != null ? r[6] / 1000 : null;
      if (kind === "bike") {
        if (r[7] != null) a.o.push(r[7]);
        if (v != null && v < 30) { a.v.push(v * 3.6); if (v > vTop) vTop = v; }
        if (r[4] != null && r[4] > 0) a.c.push(r[4]);
      } else if (kind === "run") {
        if (v != null) a.o.push(v);
        if (r[4] != null) { const spm = (r[4] + (r[53] ?? 0) / 128) * 2; if (spm >= 120 && spm <= 240) a.c.push(spm); }
      } else if (kind === "swim") { if (v != null && v > .3) a.o.push(v); }
    }
    const t: number[] = [], H: (number | null)[] = [], O: (number | null)[] = [], E: (number | null)[] = [], C: (number | null)[] = [], V: (number | null)[] = [];
    acc.forEach((a, i) => {
      t.push(+((i * bin + bin / 2) / 60).toFixed(2));
      const hh = mean(a.h), ee = mean(a.e), oo = mean(a.o), cc = mean(a.c), vv = mean(a.v);
      H.push(hh == null ? null : Math.round(hh)); E.push(ee == null ? null : Math.round(ee));
      C.push(cc == null ? null : Math.round(cc)); V.push(vv == null ? null : r1(vv));
      O.push(kind === "bike" ? (oo == null ? null : Math.round(oo)) : kind === "swim" ? (oo != null ? Math.round(100 / oo) : null) : (oo != null && oo > 1 ? Math.round(1000 / oo) : null));
    });
    const has = (a: (number | null)[]) => a.some(v => v != null);
    st = { t, hr: has(H) ? H : null, o: has(O) ? O : null, el: has(E) ? E : null, cad: has(C) ? C : null, v: has(V) ? V : null };
    if (kind === "bike" && vTop > 0 && fill.maxSpeedInMetersPerSecond == null) fill.maxSpeedInMetersPerSecond = Math.round(vTop * 100) / 100;
  }
  const laps = kind === "swim" ? [] : f.laps.filter(L => L[2] != null && L[2] >= t0 - 1).map(L => ({
    a: +((L[2] - t0) / 60).toFixed(2), dur: (L[8] ?? L[7] ?? 0) / 1000, el: (L[7] ?? L[8] ?? 0) / 1000,
    hr: L[15] ?? null, w: L[19] ?? null,
  }));
  const pw = R.map(r => r[7]).filter(v => v != null) as number[];
  const out: Record<string, unknown> = { st, laps, avgPower: kind === "bike" && pw.length ? Math.round(mean(pw)!) : null, fill };
  if (kind === "swim") { const sw = swimData(f, t0, s); if (sw) out.sw = sw; }
  return st || out.sw ? out : null;
}

// zwemmen: elke lengte (tijd, slagen, slag) en de blokken met de rust ertussen
export function swimData(f: { laps: Msg[]; lens?: Msg[] }, t0: number, s: Msg) {
  const L = (f.lens ?? []).map(x => {
    const el = (x[3] ?? x[4] ?? 0) / 1000, st = x[2] ?? (x[253] != null ? x[253] - el : null);
    return { st, el, act: x[12] == null ? (x[5] ?? 1) > 0 || el > 0 : x[12] === 1, str: x[5] ?? null, k: x[7] ?? null };
  }).filter(x => x.st != null && x.el > 0).sort((a, b) => a.st! - b.st!);
  const laps = f.laps.filter(x => x[2] != null).sort((a, b) => a[2] - b[2]);
  let pool = s[44] != null ? s[44] / 100 : null;
  if (!pool) { const l = laps.find(x => (x[9] ?? 0) > 0 && (x[40] ?? x[32] ?? 0) > 0); if (l) pool = Math.round(l[9] / 100 / (l[40] ?? l[32])); }
  if (!pool || pool < 10 || pool > 100) pool = L.length ? 25 : null;
  const sets: Record<string, number | null>[] = [];
  const lapSets = laps.filter(x => (x[8] ?? x[7]) != null);
  if (lapSets.some(x => (x[9] ?? 0) > 0) && lapSets.length > 1) {
    for (const x of lapSets) {
      const a = +((x[2] - t0) / 60).toFixed(2), dur = Math.round((x[8] ?? x[7]) / 100) / 10, m = (x[9] ?? 0) / 100;
      if (m > 0) sets.push({ a, dur, m: Math.round(m), hr: x[15] ?? null, k: x[38] ?? null, str: x[10] ?? null });
      else if (dur >= 3) sets.push({ a, dur, r: 1 });
    }
  } else if (L.length && pool) {
    let cur: { a: number; dur: number; m: number; n: number; str: number; k: number | null } | null = null;
    for (const x of L) {
      const a = +((x.st! - t0) / 60).toFixed(2);
      if (x.act) {
        if (!cur) { cur = { a, dur: 0, m: 0, n: 0, str: 0, k: x.k }; sets.push(cur as unknown as Record<string, number | null>); }
        cur.dur = r1(cur.dur + x.el); cur.m += pool; cur.n++; cur.str += x.str ?? 0; if (cur.k !== x.k) cur.k = 5;
      } else { cur = null; if (x.el >= 3) sets.push({ a, dur: r1(x.el), r: 1 }); }
    }
    sets.forEach(x => { if (!x.r) { x.str = x.str || null; delete (x as Record<string, unknown>).n; } });
  }
  if (!L.length && !sets.length) return null;
  return {
    pool,
    len: L.slice(0, 400).map(x => [+((x.st! - t0) / 60).toFixed(2), r1(x.el), x.act ? 1 : 0, x.str ?? 0, x.k ?? -1]),
    sets: sets.slice(0, 120),
  };
}

// ---------------- Garmin Connect-formaat -> ons formaat ----------------
const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && isFinite(+v) ? +v : null);
const gmtSec = (s: unknown) => { if (typeof s !== "string") return null; const t = Date.parse(s.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z")); return isFinite(t) ? Math.round(t / 1000) : null; };

export function actSummary(a: any) {
  const type = String(a?.activityType?.typeKey ?? a?.activityTypeDTO?.typeKey ?? a?.activityType ?? "").toUpperCase();
  const start = num(a?.beginTimestamp) != null ? Math.round(num(a.beginTimestamp)! / 1000) : gmtSec(a?.startTimeGMT);
  const local = gmtSec(a?.startTimeLocal), gmt = gmtSec(a?.startTimeGMT);
  const s: Record<string, unknown> = {
    activityId: a?.activityId, activityName: typeof a?.activityName === "string" ? a.activityName.slice(0, 80) : undefined,
    activityType: type || undefined, startTimeInSeconds: start ?? undefined,
    startTimeOffsetInSeconds: local != null && gmt != null ? local - gmt : undefined,
    durationInSeconds: num(a?.duration) != null ? Math.round(num(a.duration)!) : undefined,
    movingDurationInSeconds: num(a?.movingDuration) != null ? Math.round(num(a.movingDuration)!) : undefined,
    distanceInMeters: num(a?.distance) ?? undefined,
    averageHeartRateInBeatsPerMinute: num(a?.averageHR) ?? undefined,
    maxHeartRateInBeatsPerMinute: num(a?.maxHR) ?? undefined,
    averageSpeedInMetersPerSecond: num(a?.averageSpeed) ?? undefined,
    totalElevationGainInMeters: num(a?.elevationGain) ?? undefined,
    averagePowerInWatts: num(a?.avgPower) ?? undefined,
    maxSpeedInMetersPerSecond: num(a?.maxSpeed) ?? undefined,
    averageRunCadenceInStepsPerMinute: num(a?.averageRunningCadenceInStepsPerMinute) != null ? Math.round(num(a.averageRunningCadenceInStepsPerMinute)!) : undefined,
    averageBikeCadenceInRoundsPerMinute: num(a?.averageBikingCadenceInRevPerMinute) != null ? Math.round(num(a.averageBikingCadenceInRevPerMinute)!) : undefined,
    activeLengths: num(a?.activeLengths) ?? undefined,
  };
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

// eerste getal onder een van deze sleutels (diep zoeken; Garmin verpakt waarden soms anders)
export function dfind(o: any, keys: string[], depth = 0): number | null {
  if (o == null || typeof o !== "object" || depth > 6) return null;
  for (const k of keys) { const v = num(o[k]); if (v != null) return v; }
  for (const v of Array.isArray(o) ? o : Object.values(o)) { const r = dfind(v, keys, depth + 1); if (r != null) return r; }
  return null;
}

export function sleepRow(j: any) {
  const dto = j?.dailySleepDTO ?? j?.sleep ?? j ?? {};
  const dur = num(dto?.sleepTimeSeconds) ?? dfind(j, ["sleepTimeSeconds", "durationInSeconds", "totalSleepSeconds"]);
  const score = num(dto?.sleepScores?.overall?.value) ?? num(j?.sleepScores?.overall?.value) ?? dfind(j, ["overallSleepScore", "sleepScore"]);
  return { durationInSeconds: dur, overallSleepScore: score != null ? { value: score } : null };
}
export const hrvRow = (j: any) => ({ lastNightAvg: num(j?.hrvSummary?.lastNightAvg) ?? dfind(j, ["lastNightAvg", "avgOvernightHrv"]) });
export const rhrRow = (j: any) => ({ restingHeartRateInBeatsPerMinute: num(j?.restingHeartRate) ?? dfind(j, ["restingHeartRate", "restingHeartRateInBeatsPerMinute"]) });

// Body Battery per dag: hoogste en laatste waarde
export function bbRows(j: any): Record<string, { bbMax: number | null; bbLast: number | null }> {
  const out: Record<string, { bbMax: number | null; bbLast: number | null }> = {};
  const list = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : j ? [j] : [];
  for (const d of list) {
    const day = typeof d?.date === "string" ? d.date : typeof d?.calendarDate === "string" ? d.calendarDate : null;
    if (!day) continue;
    const desc = d.bodyBatteryValueDescriptorDTOList ?? d.bodyBatteryValueDescriptorsDTOList ?? [];
    let idx = -1;
    if (Array.isArray(desc)) {
      const x = desc.find((q: any) => /level|value/i.test(String(q?.bodyBatteryValueDescriptorKey ?? q?.key ?? "")) && !/timestamp/i.test(String(q?.bodyBatteryValueDescriptorKey ?? q?.key ?? "")));
      if (x) idx = num(x.bodyBatteryValueDescriptorIndex ?? x.index) ?? -1;
    }
    const vals: number[] = [];
    for (const it of Array.isArray(d.bodyBatteryValuesArray) ? d.bodyBatteryValuesArray : []) {
      if (!Array.isArray(it)) continue;
      const v = num(idx >= 0 ? it[idx] : it.length === 2 ? it[1] : it[2]);
      if (v != null && v >= 0 && v <= 100) vals.push(v);
    }
    const hi = vals.length ? Math.max(...vals) : dfind(d, ["bodyBatteryHighestValue", "highest"]);
    const last = vals.length ? vals[vals.length - 1] : dfind(d, ["bodyBatteryMostRecentValue", "mostRecent"]);
    if (hi != null || last != null) out[day] = { bbMax: hi, bbLast: last };
  }
  return out;
}
export const vo2Row = (j: any) => dfind(j, ["vo2MaxPreciseValue", "vo2MaxValue"]);

// ---------------- ophalen voor één lid ----------------
const SKIP = /MEDITATION|BREATHWORK|SLEEP|NAP/;   // geen training
export const FV = 2;                             // versie van de .fit-verwerking (hoger = opnieuw ophalen)

export async function syncUser(db: SupabaseClient, row: PRow, opts: { health?: boolean; now?: Date; f?: Fetch } = {}) {
  const f = opts.f ?? fetch, now = opts.now ?? new Date();
  const upd: Partial<PRow> = { last_sync: now.toISOString() };
  let token = row.token, n = 0;
  try {
    if (!token || !row.token_exp || new Date(row.token_exp).getTime() - now.getTime() < 3600_000) {
      const t = await exchangeKey(row.api_key, f);
      token = t.token; upd.token = t.token; upd.token_exp = t.exp.toISOString();
    }
    const get = async (path: string, accept = "application/json") => {
      const r = await f(PBASE + path, { headers: { Accept: accept, Authorization: `Bearer ${token}` } });
      if (r.status === 401) throw new GarminError(401, "token verlopen");
      if (r.status === 204 || r.status === 404) return null;
      if (!r.ok) throw new GarminError(r.status, `${path.split("?")[0]} ${r.status}`);
      return accept === "application/json" ? (await r.text().then(t => (t ? JSON.parse(t) : null))) : await r.arrayBuffer();
    };
    const received_at = now.toISOString();

    // trainingen
    const from = row.last_sync ? addDays(new Date(row.last_sync), -2) : addDays(now, -BACKFILL_DAYS);
    const q = new URLSearchParams({ start: "0", limit: "30", startDate: isoDay(from), endDate: isoDay(addDays(now, 1)) });
    const list = await get(`/activitylist-service/activities/search/activities?${q}`);
    const acts: any[] = Array.isArray(list) ? list : Array.isArray(list?.activityList) ? list.activityList : [];
    let fits = 0;
    for (const a of acts) {
      const ref = String(a?.activityId ?? ""); if (!/^\d+$/.test(ref)) continue;
      const summary = actSummary(a);
      if (!summary.activityType || SKIP.test(String(summary.activityType)) || !sportOf(summary.activityType)) continue;
      const { data: old } = await db.from("garmin_data").select("data").eq("user_id", row.user_id).eq("kind", "activity").eq("ref", ref).maybeSingle();
      const od: any = old?.data ?? null;
      let data: any = { ...(od ?? {}), summary: { ...(od?.summary ?? {}), ...summary } };
      const type = String(summary.activityType ?? "");
      if ((od?.fv ?? 0) < FV && fits < MAX_FIT_PER_RUN) {
        fits++;
        try {
          const zip = await get(`/download-service/files/activity/${ref}`, "application/zip, application/x-zip-compressed, application/octet-stream") as ArrayBuffer | null;
          if (zip && zip.byteLength) {
            const bufs = await unzipFits(zip);
            const det = bufs.length ? fitDetails(parseFit(bufs[0]), kindOf(type)) : null;
            if (det) {
              const { fill, ...rest } = det as Record<string, unknown> & { fill: Record<string, number> };
              data = { ...data, ...rest, summary: { ...fill, ...data.summary } };
              if (!rest.st) delete data.st;
            }
          }
        } catch (e) { if (e instanceof KeyError) throw e; console.error("fit", ref, String(e)); }
        data.fv = FV; delete data.fitTried;
      }
      const changed = !od || JSON.stringify(od) !== JSON.stringify(data);
      if (!changed) continue;
      const t = Number(data.summary.startTimeInSeconds ?? 0) + Number(data.summary.startTimeOffsetInSeconds ?? 0);
      await db.from("garmin_data").upsert({ user_id: row.user_id, kind: "activity", ref, day: t ? isoDay(new Date(t * 1000)) : null, data, received_at });
      if (!od) n++;
    }

    // gezondheid: vandaag (en gisteren bij de eerste keer op een nieuwe dag)
    // 's ochtends (5 tot 12 u) elk kwartier kijken of de slaap van afgelopen nacht al binnen is, voor de ochtendmelding
    const today = localDay(now), hour = localHour(now), morning = hour >= 5 && hour < 12;
    let haveSleepToday = false, sleepNow = false;
    if (morning) {
      const { data: sl0 } = await db.from("garmin_data").select("data").eq("user_id", row.user_id).eq("kind", "sleep").eq("ref", `p-${today}`).maybeSingle();
      haveSleepToday = (sl0?.data as any)?.durationInSeconds != null;
    }
    let due = opts.health || !row.last_health || now.getTime() - new Date(row.last_health).getTime() >= HEALTH_EVERY_MS;
    if (!due && morning && !haveSleepToday) {
      const sl = await get(`/sleep-service/sleep/dailySleep?date=${today}`).catch(e => { if (e instanceof KeyError) throw e; return null; });
      if (sl && sleepRow(sl).durationInSeconds != null) due = true;           // slaap is net binnen: alles ophalen
    }
    if (due) {
      const yest = localDay(addDays(now, -1));
      const newDay = !row.last_health || localDay(new Date(row.last_health)) !== today;
      const days = newDay ? [yest, today] : [today];
      const put = async (kind: string, day: string, data: Record<string, unknown>) => {
        if (!Object.values(data).some(v => v != null)) return;
        await db.from("garmin_data").upsert({ user_id: row.user_id, kind, ref: `p-${day}`, day, data: { calendarDate: day, ...data }, received_at });
      };
      for (const day of days) {
        const [sl, hv, hr] = await Promise.all([
          get(`/sleep-service/sleep/dailySleep?date=${day}`).catch(e => { if (e instanceof KeyError) throw e; return null; }),
          get(`/hrv-service/hrv/${day}`).catch(e => { if (e instanceof KeyError) throw e; return null; }),
          get(`/wellness-service/wellness/dailyHeartRate?date=${day}`).catch(e => { if (e instanceof KeyError) throw e; return null; }),
        ]);
        if (sl) { const sr = sleepRow(sl); await put("sleep", day, sr); if (day === today && sr.durationInSeconds != null) sleepNow = true; }
        if (hv) await put("hrv", day, hrvRow(hv));
        if (hr) await put("daily", day, rhrRow(hr));
      }
      const bb = await get(`/wellness-service/wellness/bodyBattery/reports/daily?startDate=${days[0]}&endDate=${today}`).catch(e => { if (e instanceof KeyError) throw e; return null; });
      for (const [day, v] of Object.entries(bbRows(bb))) await put("stress", day, v);
      if (newDay) {
        const vo = await get(`/metrics-service/metrics/maxmet/daily/${localDay(addDays(now, -7))}/${today}`).catch(e => { if (e instanceof KeyError) throw e; return null; });
        const v = vo2Row(Array.isArray(vo) ? vo[vo.length - 1] : vo);
        if (v != null) await put("metrics", today, { vo2Max: Math.round(v * 10) / 10 });
      }
      upd.last_health = now.toISOString();
    }
    // één ochtendmelding per dag (de database stuurt ze via de functie push)
    if (morning && (sleepNow || haveSleepToday)) await db.from("push_ochtend").upsert({ user_id: row.user_id, dag: today }, { onConflict: "user_id,dag", ignoreDuplicates: true });
    upd.last_ok = now.toISOString(); upd.last_error = null;
  } catch (e) {
    if (e instanceof KeyError) { upd.last_error = "sleutel"; upd.token = null; upd.token_exp = null; }
    else {
      upd.last_error = "garmin"; console.error("sync", row.user_id, String(e));
      if (e instanceof GarminError && e.status === 401) { upd.token = null; upd.token_exp = null; }   // volgende keer een nieuw token
    }
  }
  await db.from("garmin_personal").update(upd).eq("user_id", row.user_id);
  return { n, error: upd.last_error ?? null };
}
