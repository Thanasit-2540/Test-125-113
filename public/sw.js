self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    data = { title: 'แจ้งเตือนใหม่', body: event.data.text() };
  }

  const title = data.title || 'NotifyHub แจ้งเตือน';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.svg',
    badge: data.badge || '/icon-192.svg',
    image: data.image || undefined,
    tag: data.tag || `notif-${Date.now()}`,
    renotify: true,
    requireInteraction: data.priority === 'urgent' || data.priority === 'high',
    vibrate: data.priority === 'urgent' ? [300, 100, 300, 100, 400] : [200, 100, 200],
    data: {
      url: data.url || '/'
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
