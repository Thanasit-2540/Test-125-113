self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'ADDA Service แจ้งเตือน', body: event.data.text() };
    }
  } else {
    data = { title: 'ADDA Service แจ้งเตือน', body: 'มีงานใหม่เข้ามาในระบบ' };
  }

  const title = data.title || 'ADDA Service แจ้งเตือน';

  // Standard options compatible with both iOS Safari APNs & Android Chrome
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag ? String(data.tag) : `notif_${Date.now()}`,
    data: {
      url: data.url || '/'
    }
  };

  // Optional enhancements (safely applied if supported)
  if (data.image) {
    options.image = data.image;
  }
  if (data.priority === 'urgent' && 'vibrate' in Notification.prototype) {
    options.vibrate = [300, 100, 300, 100, 400];
  }

  // Display notification with fallback in case iOS/Safari rejects extended options
  const showPromise = self.registration.showNotification(title, options).catch((err) => {
    console.warn('showNotification fallback triggered:', err);
    return self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      data: { url: data.url || '/' }
    });
  });

  event.waitUntil(showPromise);
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

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.registration.pushManager.subscribe(event.oldSubscription ? event.oldSubscription.options : { userVisibleOnly: true })
      .then((subscription) => {
        return fetch('/api/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subscription: subscription,
            deviceName: 'Auto-Renewed SW'
          })
        });
      })
      .catch((err) => {
        console.warn('pushsubscriptionchange auto-sync error:', err);
      })
  );
});
