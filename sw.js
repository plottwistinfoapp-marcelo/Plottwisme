// Service worker de Plottwistme: mantiene el de PWABuilder y agrega abrir la app al tocar una notificación
try { importScripts('./pwabuilder-sw.js'); } catch (e) {}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/?tab=chats', self.location.origin).href;
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (c.url.startsWith(self.location.origin)) {
        try { await c.focus(); } catch (e) {}
        try { c.postMessage({ type: 'open-tab', tab: 'chats' }); } catch (e) {}
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
