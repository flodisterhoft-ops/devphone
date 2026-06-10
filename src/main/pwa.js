'use strict';

/*
 * pwa.js — pwa:manifest {pageUrl}.
 * Fetches the page, finds <link rel="manifest">, fetches + parses the
 * manifest, resolves start_url and icon URLs against the MANIFEST url,
 * picks the largest icon ≤512px, downloads it and returns a data URL.
 * Missing/broken manifest → {ok:false}.
 */

const { net } = require('electron');

const FETCH_TIMEOUT_MS = 15000;

async function fetchResponse(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await net.fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'Accept': '*/*' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const res = await fetchResponse(url);
  return await res.text();
}

function attr(tag, name) {
  const m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return m ? (m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4])) : '';
}

function findManifestUrl(html, baseUrl) {
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    const rel = attr(tag, 'rel');
    if (!/(^|\s)manifest(\s|$)/i.test(rel)) continue;
    const href = attr(tag, 'href');
    if (!href) continue;
    try { return new URL(href, baseUrl).toString(); } catch (e) {}
  }
  return null;
}

// Largest declared dimension of an icon entry ("192x192", "48x48 96x96", "any").
function iconMaxSize(icon) {
  const sizes = String((icon && icon.sizes) || '').trim().toLowerCase();
  if (!sizes) return 0;
  if (sizes.indexOf('any') !== -1) return 512; // scalable (svg) — treat as ideal
  let max = 0;
  for (const part of sizes.split(/\s+/)) {
    const mm = part.match(/^(\d+)x(\d+)$/);
    if (mm) max = Math.max(max, parseInt(mm[1], 10), parseInt(mm[2], 10));
  }
  return max;
}

// Pick the largest icon ≤512px; if none qualify, the smallest available.
function pickIcon(icons) {
  if (!Array.isArray(icons) || !icons.length) return null;
  const withSize = icons
    .filter((i) => i && i.src)
    .map((i) => ({ icon: i, size: iconMaxSize(i) }));
  if (!withSize.length) return null;
  const fitting = withSize.filter((e) => e.size > 0 && e.size <= 512);
  if (fitting.length) {
    fitting.sort((a, b) => b.size - a.size);
    return fitting[0].icon;
  }
  withSize.sort((a, b) => (a.size || Infinity) - (b.size || Infinity));
  return withSize[0].icon;
}

function guessMime(url) {
  const u = String(url).split('?')[0].toLowerCase();
  if (u.endsWith('.svg')) return 'image/svg+xml';
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg';
  if (u.endsWith('.webp')) return 'image/webp';
  if (u.endsWith('.ico')) return 'image/x-icon';
  return 'image/png';
}

async function fetchIconDataUrl(icon, manifestUrl) {
  try {
    const iconUrl = new URL(icon.src, manifestUrl).toString();
    const res = await fetchResponse(iconUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    let mime = res.headers.get('content-type') || icon.type || guessMime(iconUrl);
    mime = String(mime).split(';')[0].trim() || 'image/png';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch (e) {
    return null;
  }
}

async function fetchManifest(options) {
  const pageUrl = options && options.pageUrl;
  try {
    if (!pageUrl) return { ok: false, error: 'no pageUrl' };

    const html = await fetchText(pageUrl);
    const manifestUrl = findManifestUrl(html, pageUrl);
    if (!manifestUrl) return { ok: false, error: 'no manifest link on page' };

    let manifest;
    try {
      manifest = JSON.parse(await fetchText(manifestUrl));
    } catch (e) {
      return { ok: false, error: 'manifest fetch/parse failed: ' + String((e && e.message) || e) };
    }
    if (!manifest || typeof manifest !== 'object') return { ok: false, error: 'manifest is not an object' };

    // start_url resolves against the manifest URL (per spec).
    let startUrl = pageUrl;
    if (manifest.start_url) {
      try { startUrl = new URL(manifest.start_url, manifestUrl).toString(); } catch (e) {}
    }

    let iconDataUrl = null;
    const icon = pickIcon(manifest.icons);
    if (icon) iconDataUrl = await fetchIconDataUrl(icon, manifestUrl);

    return {
      ok: true,
      name: manifest.name || manifest.short_name || '',
      shortName: manifest.short_name || manifest.name || '',
      startUrl: startUrl,
      display: manifest.display || 'browser',
      themeColor: manifest.theme_color || null,
      iconDataUrl: iconDataUrl,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { fetchManifest };
