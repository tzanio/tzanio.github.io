'use strict';
const ROOT = new URL('./', self.location.href);
const PREFIX = 'mfem-offline:' + ROOT.pathname + ':';
const META = PREFIX + 'metadata';
const DEMAND = PREFIX + 'demand';
const DEMAND_LIMIT = 256 * 1024 * 1024;
const STATE_URL = new URL('__offline_state__', ROOT).href;
const MANIFEST_URL = new URL('offline-manifest.json', ROOT).href;
let download = null;
let statePromise, demandWrites = 0, trimming = Promise.resolve();
const address = path => new URL(path, ROOT).href;
async function readState() {
  if (!statePromise) statePromise = (async () => {
    const response = await (await caches.open(META)).match(STATE_URL);
    return response ? response.json() : {ready: false};
  })();
  return statePromise;
}
async function writeState(state) {
  await (await caches.open(META)).put(STATE_URL, new Response(JSON.stringify(state)));
  statePromise = Promise.resolve(state);
}
async function trimDemand() {
  const cache = await caches.open(DEMAND), keys = await cache.keys();
  const entries = [];
  for (const key of keys) {
    const response = await cache.match(key);
    if (!response) continue;
    const recorded = response.headers.get('x-mfem-bytes');
    const size = recorded === null ? (await response.arrayBuffer()).byteLength : Number(recorded);
    entries.push([key, size]);
  }
  let bytes = entries.reduce((sum, item) => sum + item[1], 0), count = entries.length;
  for (const [key, size] of entries) {
    if (bytes <= DEMAND_LIMIT && count <= 1500) break;
    await cache.delete(key); bytes -= size; count--;
  }
}
function pruneDemand() {
  trimming = trimming.then(trimDemand, trimDemand).catch(() => {});
  return trimming;
}
function storedResponse(response, body) {
  const headers = new Headers(response.headers);
  // Fetch returns decoded bytes even when the server used compression.
  headers.delete('content-encoding');
  headers.set('content-length', String(body.byteLength));
  headers.set('x-mfem-bytes', String(body.byteLength));
  return new Response(body, {status: response.status, headers});
}
async function manifest() {
  let response;
  try {
    response = await fetch(MANIFEST_URL, {cache: 'no-store'});
    if (!response.ok) throw new Error('Offline manifest: HTTP ' + response.status);
    await (await caches.open(META)).put(MANIFEST_URL, response.clone());
  } catch (error) {
    response = await (await caches.open(META)).match(MANIFEST_URL);
    if (!response) throw error;
  }
  const value = await response.json();
  if (value.schema !== 1 || !/^[a-f0-9]{24}$/.test(value.version) || !Array.isArray(value.assets)) {
    throw new Error('Invalid offline release manifest');
  }
  for (const item of value.assets) {
    const url = new URL(item.url, ROOT);
    if (url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname) ||
        url.search || url.hash || !Number.isSafeInteger(item.bytes) || item.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid offline asset');
  }
  return value;
}
async function status() {
  const state = await readState();
  if (state.ready) {
    const cache = await caches.open(PREFIX + state.version);
    if ((await cache.keys()).length !== state.files) return {...state, ready: false, incomplete: true};
  }
  return {...state, downloading: !!download};
}
async function saveOffline(port) {
  if (download) throw new Error('An offline download is already running in another tab');
  const controller = new AbortController();
  download = {controller};
  try {
    const release = await manifest();
    const cache = await caches.open(PREFIX + release.version);
    const demandCache = await caches.open(DEMAND);
    const state = {ready: false, version: release.version, files: release.assets.length,
      total_bytes: release.total_bytes};
    let cursor = 0, completed = 0, bytes = 0, lastProgress = 0;
    const progress = force => {
      if (!force && performance.now() - lastProgress < 100) return;
      lastProgress = performance.now();
      port.postMessage({type: 'progress', ...state, completed, bytes});
    };
    progress(true);
    const lanes = Array.from({length: 6}, async () => {
      while (cursor < release.assets.length) {
        if (controller.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
        const item = release.assets[cursor++], url = address(item.url);
        if (!(await cache.match(url))) {
          const response = await demandCache.match(url) ||
            await fetch(url, {cache: 'no-store', signal: controller.signal});
          if (!response.ok) throw new Error(item.url + ': HTTP ' + response.status);
          const body = await response.arrayBuffer();
          if (body.byteLength !== item.bytes) throw new Error('Release changed during download: ' + item.url);
          const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))]
            .map(byte => byte.toString(16).padStart(2, '0')).join('');
          if (hash !== item.sha256) throw new Error('Release changed during download: ' + item.url);
          if (controller.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
          await cache.put(url, storedResponse(response, body));
        }
        completed++; bytes += item.bytes; progress(false);
      }
    });
    try {await Promise.all(lanes);}
    catch (error) {controller.abort(); await Promise.allSettled(lanes); throw error;}
    state.ready = true; state.saved_at = new Date().toISOString();
    await writeState(state);
    // Keep the previous complete release until its replacement is fully saved.
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && key !== META && key !== PREFIX + state.version) await caches.delete(key);
    }
    progress(true);
    port.postMessage({type: 'complete', state});
  } finally {download = null;}
}
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(Promise.all([self.clients.claim(), pruneDemand()])));
self.addEventListener('message', event => {
  const port = event.ports[0]; if (!port) return;
  event.waitUntil((async () => {
    try {
      if (event.data.type === 'download') await saveOffline(port);
      else if (event.data.type === 'cancel') {download?.controller.abort(); port.postMessage({type: 'result', value: true});}
      else if (event.data.type === 'status') port.postMessage({type: 'result', value: await status()});
      else if (event.data.type === 'manifest') port.postMessage({type: 'result', value: await manifest()});
      else if (event.data.type === 'remove') {
        if (download) throw new Error('Cancel the download before removing offline files');
        for (const key of await caches.keys()) if (key.startsWith(PREFIX)) await caches.delete(key);
        statePromise = null;
        port.postMessage({type: 'result', value: {ready: false}});
      } else throw new Error('Unknown offline action');
    } catch (error) {
      port.postMessage({type: 'error', cancelled: error.name === 'AbortError',
        error: error.name === 'QuotaExceededError' ? 'Browser storage is full. Free some space and retry.' : error.message});
    }
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname)) return;
  // Never swallow external requests or guest RPCs; the application is static.
  event.respondWith((async () => {
    const canonical = new URL(url); canonical.search = ''; canonical.hash = '';
    if (canonical.pathname === ROOT.pathname) canonical.pathname += 'index.html';
    const state = await readState();
    const immutable = /\/vm\/fs\/[a-f0-9]{64}\.bin$/.test(canonical.pathname);
    const cache = state.ready ? await caches.open(PREFIX + state.version) : null;
    if (immutable && cache) {
      const cached = await cache.match(canonical.href); if (cached) return cached;
    }
    const demand = immutable ? await caches.open(DEMAND) : null;
    if (demand) {
      const cached = await demand.match(canonical.href); if (cached) return cached;
    }
    try {
      const response = await fetch(event.request, immutable ? {} : {cache: 'no-cache'});
      if (demand && response.ok && response.status === 200) {
        const save = response.clone().arrayBuffer().then(async body => {
          if (body.byteLength > DEMAND_LIMIT) return;
          await demand.put(canonical.href, storedResponse(response, body));
          if (++demandWrites % 32 === 0 || body.byteLength > 16 * 1024 * 1024) return pruneDemand();
        }).catch(() => pruneDemand());
        event.waitUntil(save);
      }
      return response;
    }
    catch (error) {
      const cached = cache && await cache.match(canonical.href);
      if (cached) return cached;
      if (canonical.href === MANIFEST_URL) {
        const saved = await (await caches.open(META)).match(MANIFEST_URL);
        if (saved) return saved;
      }
      throw error;
    }
  })());
});
