// Trip app ↔ Google Sheet data layer.
//
// Two-way: load() pulls the whole trip out of the Sheet, push() sends one
// change back. Everything is cached in localStorage so the app opens with no
// signal, and writes made offline queue up and flush on the next successful
// call. With no endpoint configured the app runs on its built-in demo data.

const CACHE_KEY = 'trip-app-sheet-cache-v1';
const QUEUE_KEY = 'trip-app-sheet-queue-v1';
const CONF_KEY = 'trip-app-sheet-config-v1';

let cfg = { endpoint: '', token: '' };

export function loadConfig() {
  try {
    const raw = localStorage.getItem(CONF_KEY);
    if (raw) cfg = Object.assign(cfg, JSON.parse(raw));
  } catch (e) { /* first run */ }
  return Object.assign({}, cfg);
}

export function saveConfig(next) {
  cfg = Object.assign({}, cfg, next);
  try { localStorage.setItem(CONF_KEY, JSON.stringify(cfg)); } catch (e) { /* private mode */ }
  return Object.assign({}, cfg);
}

export function isLive() { return !!cfg.endpoint; }

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || null; } catch (e) { return null; }
}
function writeCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ data, at: Date.now() })); } catch (e) { /* full */ }
}
function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch (e) { return []; }
}
function writeQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) { /* full */ }
}

export function queueLength() { return readQueue().length; }

export function cachedAt() {
  const c = readCache();
  return c ? c.at : null;
}

// Apps Script web apps don't answer CORS preflights, so writes go as a plain
// text/plain POST (a "simple request") with the payload in the body.
async function call(payload) {
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ token: cfg.token }, payload)),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error('Sheet returned ' + res.status);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

// Pull the trip. Returns { data, source: 'sheet' | 'cache' | 'none' }.
export async function load() {
  if (!isLive()) {
    const c = readCache();
    return { data: c ? c.data : null, source: c ? 'cache' : 'none' };
  }
  try {
    const json = await call({ action: 'read' });
    writeCache(json.data);
    await flush();
    return { data: json.data, source: 'sheet' };
  } catch (e) {
    const c = readCache();
    return { data: c ? c.data : null, source: c ? 'cache' : 'none', error: e.message };
  }
}

// Send one change. Ops are shaped { type, ...fields } — see Code.gs for the
// list the Sheet understands. Offline, the op queues and load() flushes later.
export async function push(op) {
  if (!isLive()) return { ok: false, queued: false, demo: true };
  const stamped = Object.assign({ at: new Date().toISOString() }, op);
  try {
    const json = await call({ action: 'write', ops: [stamped] });
    if (json.data) writeCache(json.data);
    return { ok: true, queued: false, data: json.data };
  } catch (e) {
    const q = readQueue();
    q.push(stamped);
    writeQueue(q);
    return { ok: false, queued: true, error: e.message };
  }
}

// Replay anything written while offline, oldest first.
export async function flush() {
  const q = readQueue();
  if (!q.length || !isLive()) return { sent: 0 };
  try {
    const json = await call({ action: 'write', ops: q });
    writeQueue([]);
    if (json.data) writeCache(json.data);
    return { sent: q.length, data: json.data };
  } catch (e) {
    return { sent: 0, error: e.message };
  }
}
