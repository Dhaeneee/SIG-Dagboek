// Web push zonder bibliotheek: versleuteling volgens RFC 8291 (aes128gcm) en VAPID volgens RFC 8292,
// enkel met WebCrypto (werkt in Deno en in Node).
const te = new TextEncoder();
export const b64u = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ""; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64u = (s: string) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4);
  const bin = atob(t), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

export type Vapid = { publicKey: string; privateJwk: JsonWebKey };
export type Sub = { endpoint: string; p256dh: string; auth: string };

// nieuwe VAPID-sleutels (de server maakt ze zelf; de privésleutel verlaat de database nooit)
export async function newVapid(): Promise<Vapid> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { publicKey: b64u(raw), privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
}

// enkel naar echte push-diensten sturen
const HOSTS = ["googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];
export function okEndpoint(e: string) {
  try {
    const u = new URL(e);
    return u.protocol === "https:" && e.length <= 1000 && HOSTS.some(h => u.hostname === h || u.hostname.endsWith("." + h));
  } catch { return false; }
}

export async function vapidHeader(endpoint: string, v: Vapid, sub: string, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const head = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(te.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub })));
  const key = await crypto.subtle.importKey("jwk", { ...v.privateJwk, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${v.publicKey}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}

// versleutel één bericht voor één abonnement (RFC 8291)
export async function encrypt(sub: Sub, plaintext: Uint8Array, opts: { salt?: Uint8Array; asKeys?: CryptoKeyPair } = {}) {
  const uaPub = unb64u(sub.p256dh), auth = unb64u(sub.auth);
  if (uaPub.length !== 65 || auth.length < 16) throw new Error("abonnement");
  const as = opts.asKeys ?? await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, cat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const rs = 4096;
  if (plaintext.length + 17 > rs) throw new Error("te groot");
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(plaintext, new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt, 0); new DataView(head.buffer).setUint32(16, rs); head[20] = asPub.length;
  return cat(head, asPub, ct);
}

// verstuur; geeft de HTTP-status terug (201 = goed, 404/410 = abonnement bestaat niet meer)
export async function sendPush(sub: Sub, payload: unknown, v: Vapid, contact: string, f: typeof fetch = fetch, ttl = 86400) {
  if (!okEndpoint(sub.endpoint)) return 400;
  const body = await encrypt(sub, te.encode(JSON.stringify(payload)));
  const r = await f(sub.endpoint, {
    method: "POST",
    headers: {
      TTL: String(ttl), Urgency: "normal", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
      Authorization: await vapidHeader(sub.endpoint, v, contact),
    },
    body,
  });
  await r.body?.cancel().catch(() => {});
  return r.status;
}
