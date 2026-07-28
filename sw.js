// Service worker for the Orchard farm manager.
//
// Two jobs:
// 1) Exist and be registered, so registration.showNotification() works
//    reliably on Android Chrome (the plain Notification() constructor used
//    directly from a page is largely ignored there).
// 2) Periodic Background Sync: when this app is installed (Add to Home
//    Screen) on a Chromium/Android browser, the browser may occasionally
//    wake this service worker up in the background (roughly every ~12h+,
//    timing is entirely browser-controlled, not exact) to check for due
//    tasks and notify — even while the app itself is fully closed.
//
// It reads from IndexedDB, not localStorage, because localStorage is only
// reachable from an open page — IndexedDB is the one storage a service
// worker can read on its own.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const IDB_NAME = "farm-app-db";
const IDB_STORE = "kv";

function idbGet(key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(IDB_STORE, "readonly");
      const getReq = tx.objectStore(IDB_STORE).get(key);
      getReq.onsuccess = () => { db.close(); resolve(getReq.result); };
      getReq.onerror = () => { db.close(); reject(getReq.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

function idbPut(key, value) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}
function fmtDateShort(d) {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

// The browser — not this code — decides exactly when periodicsync fires, so
// there's no way to guarantee it lands precisely at 8:00/10:00/20:00. Instead,
// this only allows a notification through when the wake-up happens to land in
// the same clock hour as one of those three times, and only once per hour-slot
// per day (tracked here, since a service worker can't use localStorage).
const NOTIFY_HOURS = [8, 10, 20];

async function checkAndNotify() {
  const hour = new Date().getHours();
  if (!NOTIFY_HOURS.includes(hour)) return;

  const slotKey = `${todayStr()}-${hour}`;
  let lastFired = null;
  try {
    lastFired = await idbGet("lastNotifySlot");
  } catch (e) {
    /* ignore */
  }
  if (lastFired === slotKey) return;

  let data;
  try {
    data = await idbGet("farm-data");
  } catch (e) {
    return;
  }
  if (!data || !data.settings || !data.settings.notifyEnabled) return;

  const notifyBy = data.settings.notifyDaysBefore || 3;
  const today = todayStr();
  const msgs = [];

  (data.events || []).filter((e) => !e.done).forEach((item) => {
    const diff = daysBetween(today, item.date);
    if (diff < 0) msgs.push(`Overdue: ${item.title}`);
    else if (diff <= notifyBy) msgs.push(diff === 0 ? `Today: ${item.title}` : `In ${diff} day(s): ${item.title}`);
  });

  (data.sprays || []).filter((s) => s.status === "planned").forEach((s) => {
    const hasBio = (s.items || []).some((it) => {
      const inv = (data.inventory || []).find((i) => i.id === it.inventoryId);
      return inv && inv.category === "Bio Stimulant";
    });
    const lead = hasBio ? 3 : 0;
    const diff = daysBetween(today, s.date);
    const label = (s.items || []).map((it) => `${it.productName} (${it.quantity}${it.unit})`).join(", ") || "Plan";
    const kind = s.type === "spray" ? "Spray" : "Fertigation";
    if (diff < 0) {
      msgs.push(`Overdue: ${kind}: ${label}`);
    } else if (diff <= lead) {
      msgs.push(
        diff === 0
          ? `Today (${fmtDateShort(s.date)}): ${kind}: ${label}`
          : `In ${diff} day(s) — on ${fmtDateShort(s.date)}: ${kind}: ${label}`
      );
    }
  });

  if (msgs.length === 0) return;

  try {
    await idbPut("lastNotifySlot", slotKey);
  } catch (e) {
    /* ignore */
  }

  for (const m of msgs.slice(0, 6)) {
    try {
      await self.registration.showNotification("Orchard reminder", { body: m, icon: "icon-192.png", badge: "icon-192.png" });
    } catch (e) {
      /* ignore */
    }
  }
}

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "check-farm-tasks") {
    event.waitUntil(checkAndNotify());
  }
});
