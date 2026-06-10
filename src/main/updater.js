'use strict';

/*
 * updater.js — daily Wikipedia device discovery + device list merging.
 *
 * devices:list merge order:
 *   devices/devices.json  (built-in, integrator-owned)
 *   devices/devices-researched.json (optional; same-id entries OVERRIDE
 *     built-ins, new ids are unioned)
 *   userData/devices-extra.json (auto-discovered; union only — never
 *     overrides curated entries)
 *
 * Discovery: on launch + every 24h, fetch Wikipedia REST HTML for
 * List_of_iPhone_models and Samsung_Galaxy_S_series, regex model names,
 * diff against known ids + dismissed list, clone the nearest predecessor
 * with estimated:true (resolution parsed from nearby text best-effort),
 * persist to devices-extra.json, emit 'devices:new'.
 * Only models NEWER than the newest known generation are added — the list
 * articles enumerate every historical model and those are not "new".
 * All network failures are silent (log only).
 */

const path = require('path');
const fs = require('fs');
const { app, net } = require('electron');

const ctx = { send: null };
let dailyTimer = null;
let initialTimer = null;

const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;

const SOURCES = [
  { title: 'List_of_iPhone_models', regex: /iPhone \d\d[^,<]*/g, kind: 'iphone' },
  { title: 'Samsung_Galaxy_S_series', regex: /Galaxy S\d\d[^,<]*/g, kind: 'galaxy' },
];

// ---------- file helpers ----------

function userDataFile(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[updater] write failed:', file, e && e.message);
  }
}

// Resolve from this file, not app.getAppPath() — correct in dev, inside
// app.asar when packaged, and regardless of the electron entry point.
const DEVICES_DIR = path.join(__dirname, '..', '..', 'devices');
function builtinPath() { return path.join(DEVICES_DIR, 'devices.json'); }
function researchedPath() { return path.join(DEVICES_DIR, 'devices-researched.json'); }
function extrasPath() { return userDataFile('devices-extra.json'); }
function dismissedPath() { return userDataFile('dismissed.json'); }

// ---------- device list ----------

function listDevices() {
  const base = (readJson(builtinPath(), {}).devices) || [];
  const researched = (readJson(researchedPath(), {}).devices) || [];
  const extras = (readJson(extrasPath(), {}).devices) || [];

  const byId = new Map();
  const order = [];
  const put = (d, override) => {
    if (!d || !d.id) return;
    if (byId.has(d.id)) {
      if (override) byId.set(d.id, d);
      return;
    }
    byId.set(d.id, d);
    order.push(d.id);
  };
  for (const d of base) put(d, false);
  for (const d of researched) put(d, true); // researched overrides same ids
  for (const d of extras) put(d, false); // extras are union-only
  return order.map((id) => byId.get(id));
}

function findDevice(id) {
  if (!id) return null;
  return listDevices().find((d) => d.id === id) || null;
}

// ---------- discovery ----------

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await net.fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'Accept': 'text/html' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeName(raw) {
  let s = String(raw).replace(/&[a-z]+;|&#\d+;/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // cut at the first character outside [letters digits space +]
  const m = s.match(/^[A-Za-z0-9+ ]+/);
  s = m ? m[0].trim() : '';
  s = s.replace(/\s+(and|or|was|is|in|with|series)\b.*$/i, '').trim();
  const words = s.split(' ');
  if (words.length > 5) s = words.slice(0, 5).join(' ');
  if (s.length < 8 || s.length > 30) return '';
  return s;
}

function slug(name) {
  return String(name)
    .toLowerCase()
    .replace(/\+/g, '-plus')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function familyNumber(device, kind) {
  const id = String(device.id || '');
  if (kind === 'iphone') {
    const m = id.match(/^iphone-(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }
  const m = id.match(/^galaxy-s(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function familyDevices(kind, all) {
  if (kind === 'iphone') return all.filter((d) => d.brand === 'apple' && /^iphone-\d+/.test(d.id));
  return all.filter((d) => d.brand === 'samsung' && /^galaxy-s\d+/.test(d.id));
}

function suffixOfName(name, kind) {
  const re = kind === 'iphone' ? /^iPhone\s*\d+\s*/i : /^Galaxy\s*S\s*?\d+\s*/i;
  return String(name).replace(re, '').trim().toLowerCase();
}

function suffixOfId(device, kind) {
  const re = kind === 'iphone' ? /^iphone-\d+-?/ : /^galaxy-s\d+-?/;
  return String(device.id).replace(re, '').replace(/-/g, ' ').trim().toLowerCase();
}

function buildEstimatedDevice(kind, name, id, html, foundAt, all) {
  const numM = name.match(/\d+/);
  const num = numM ? parseInt(numM[0], 10) : 0;
  if (!num || !isFinite(num)) return null;

  const family = familyDevices(kind, all);
  if (!family.length) return null;
  const maxKnown = Math.max.apply(null, family.map((d) => familyNumber(d, kind)));
  if (num <= maxKnown) return null; // not actually new

  // nearest predecessor: same variant suffix if available, else the newest.
  const wantSuffix = suffixOfName(name, kind);
  const sorted = family.slice().sort((a, b) => familyNumber(b, kind) - familyNumber(a, kind));
  const base = sorted.find((d) => suffixOfId(d, kind) === wantSuffix) || sorted[0];
  const baseNum = familyNumber(base, kind);

  const dev = JSON.parse(JSON.stringify(base));
  dev.id = id;
  dev.label = name;
  dev.estimated = true;
  dev.releaseYear = (base.releaseYear || 2025) + Math.max(1, num - baseNum);

  // best-effort resolution near the model name mention
  try {
    const slice = html.slice(foundAt, foundAt + 3000);
    const rm = slice.match(/(\d{3,4})\s?[×x]\s?(\d{3,4})/);
    if (rm) {
      const a = parseInt(rm[1], 10);
      const b = parseInt(rm[2], 10);
      if (a >= 480 && b >= 480) {
        dev.physical = { width: Math.min(a, b), height: Math.max(a, b) };
        const dpr = dev.dpr || 3;
        dev.viewport = {
          width: Math.round(dev.physical.width / dpr),
          height: Math.round(dev.physical.height / dpr),
        };
      }
    }
  } catch (e) {}

  return dev;
}

async function checkNow() {
  const added = [];
  try {
    const all = listDevices();
    const known = new Set(all.map((d) => d.id));
    const dismissed = new Set(readJson(dismissedPath(), []) || []);
    const extrasDoc = readJson(extrasPath(), { version: 1, devices: [] });
    if (!Array.isArray(extrasDoc.devices)) extrasDoc.devices = [];

    for (const src of SOURCES) {
      let html = '';
      try {
        html = await fetchText('https://en.wikipedia.org/api/rest_v1/page/html/' + src.title);
      } catch (e) {
        console.log('[updater] fetch failed (' + src.title + '):', String((e && e.message) || e));
        continue;
      }
      const seen = new Set();
      src.regex.lastIndex = 0;
      let m;
      while ((m = src.regex.exec(html))) {
        const name = normalizeName(m[0]);
        if (!name) continue;
        const id = slug(name);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (known.has(id) || dismissed.has(id)) continue;
        const device = buildEstimatedDevice(src.kind, name, id, html, m.index, all);
        if (!device) continue;
        extrasDoc.devices.push(device);
        known.add(id);
        added.push(device);
      }
    }

    if (added.length) {
      writeJson(extrasPath(), extrasDoc);
      if (ctx.send) ctx.send('devices:new', { devices: added });
    }
  } catch (e) {
    console.log('[updater] check failed:', String((e && e.message) || e));
  }
  return { added: added, checked: true };
}

// Hide a discovered device permanently (kept out of future discovery too).
function dismiss(id) {
  try {
    if (!id) return { ok: false, error: 'no id' };
    const dismissed = readJson(dismissedPath(), []) || [];
    if (!dismissed.includes(id)) {
      dismissed.push(id);
      writeJson(dismissedPath(), dismissed);
    }
    const extrasDoc = readJson(extrasPath(), { version: 1, devices: [] });
    if (Array.isArray(extrasDoc.devices)) {
      const before = extrasDoc.devices.length;
      extrasDoc.devices = extrasDoc.devices.filter((d) => d && d.id !== id);
      if (extrasDoc.devices.length !== before) writeJson(extrasPath(), extrasDoc);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function start(options) {
  ctx.send = options && options.send;
  const enableSchedule = !options || options.enableSchedule !== false;
  if (!enableSchedule) return; // selftest: no background network chatter
  try {
    initialTimer = setTimeout(() => { checkNow().catch(() => {}); }, 7000);
    dailyTimer = setInterval(() => { checkNow().catch(() => {}); }, DAY_MS);
  } catch (e) {
    console.log('[updater] schedule failed:', String((e && e.message) || e));
  }
}

function stopSchedule() {
  if (initialTimer) { clearTimeout(initialTimer); initialTimer = null; }
  if (dailyTimer) { clearInterval(dailyTimer); dailyTimer = null; }
}

module.exports = {
  start,
  stopSchedule,
  checkNow,
  listDevices,
  findDevice,
  dismiss,
};
