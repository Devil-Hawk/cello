// Cello's push worker: shows what the server sent, and opens the page it names when pressed.
// The server sends { title, body, url }; the body is a sentence about who and what, never a message's text.

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (_) {
    data = {}
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Cello'
  const body = typeof data.body === 'string' ? data.body : ''
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/'
  event.waitUntil(self.registration.showNotification(title, { body, data: { url }, tag: url }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
      for (const c of all) {
        if ('focus' in c) {
          c.navigate(url)
          return c.focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
