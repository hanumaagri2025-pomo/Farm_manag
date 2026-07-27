// Minimal service worker — its only job is to exist and be registered, so the
// app can call registration.showNotification(), which is the reliable way to
// show notifications on Android Chrome (the plain Notification() constructor
// used directly from a page is largely ignored on mobile).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
