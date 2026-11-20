// Legati Tri Dagboek 2027 – service worker: enkel voor pushmeldingen (geen offline-cache, zodat je altijd de nieuwste versie krijgt)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || "Legati Tri Dagboek", {
      body: d.body || "", icon: "icon-192.png?v=legati2", badge: "badge-96.png", tag: d.tag || undefined,
      data: { url: d.url || "#vandaag" },
    });
    // staat de app open, dan haalt ze meteen de nieuwe gegevens op
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    cs.forEach(c => c.postMessage({ type: "td-refresh" }));
  })());
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "#vandaag", self.registration.scope).href;
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of cs) {
      if (c.url.startsWith(self.registration.scope)) { await c.focus(); c.postMessage({ type: "td-nav", url }); return; }
    }
    await self.clients.openWindow(url);
  })());
});
