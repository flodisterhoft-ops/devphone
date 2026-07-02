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
const MAX_PAGE_HTML_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ICON_BYTES = 1024 * 1024;

function httpUrl(value, baseUrl, label) {
  let u;
  try {
    u = baseUrl ? new URL(value, baseUrl) : new URL(value);
  } catch (e) {
    throw new Error('bad ' + (label || 'url'));
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error((label || 'url') + ' must be http(s)');
  }
  return u.toString();
}

function normalizedContentType(res) {
  return String((res && res.headers && res.headers.get('content-type')) || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

function isHtmlLike(type) {
  return !type || type === 'text/html' || type === 'application/xhtml+xml' || type === 'text/plain';
}

function isManifestLike(type) {
  return !type ||
    type === 'application/manifest+json' ||
    type === 'application/json' ||
    type === 'text/json' ||
    type === 'text/plain' ||
    type === 'application/octet-stream' ||
    /\+json$/i.test(type);
}

function isImageLike(type) {
  return !type || /^image\//i.test(type);
}

async function fetchResponse(url, options) {
  const opts = options || {};
  const safeUrl = httpUrl(url, null, opts.label || 'url');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await net.fetch(safeUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'Accept': opts.accept || '*/*' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + safeUrl);
    const type = normalizedContentType(res);
    if (opts.allowContentType && !opts.allowContentType(type)) {
      throw new Error('unexpected content-type "' + (type || 'unknown') + '" for ' + safeUrl);
    }
    const len = Number(res.headers.get('content-length') || 0);
    if (opts.maxBytes && len > opts.maxBytes) {
      throw new Error('response too large for ' + safeUrl);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedBuffer(res, maxBytes, url) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (maxBytes && total > maxBytes) {
        try { await reader.cancel(); } catch (e) {}
        throw new Error('response too large for ' + url);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (maxBytes && buf.length > maxBytes) throw new Error('response too large for ' + url);
  return buf;
}

async function fetchBuffer(url, options) {
  const opts = options || {};
  const safeUrl = httpUrl(url, null, opts.label || 'url');
  const res = await fetchResponse(safeUrl, opts);
  return {
    res,
    buf: await readLimitedBuffer(res, opts.maxBytes || 0, safeUrl),
    url: safeUrl,
  };
}

async function fetchText(url, options) {
  const got = await fetchBuffer(url, options);
  return got.buf.toString('utf8');
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
    try { return httpUrl(href, baseUrl, 'manifest url'); } catch (e) {}
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
    const iconUrl = httpUrl(icon.src, manifestUrl, 'icon url');
    const got = await fetchBuffer(iconUrl, {
      label: 'icon url',
      accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.2',
      maxBytes: MAX_ICON_BYTES,
      allowContentType: isImageLike,
    });
    const res = got.res;
    const buf = got.buf;
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
    const safePageUrl = httpUrl(pageUrl, null, 'pageUrl');

    const html = await fetchText(safePageUrl, {
      label: 'pageUrl',
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.2',
      maxBytes: MAX_PAGE_HTML_BYTES,
      allowContentType: isHtmlLike,
    });
    const manifestUrl = findManifestUrl(html, safePageUrl);
    if (!manifestUrl) return { ok: false, error: 'no manifest link on page' };

    let manifest;
    try {
      manifest = JSON.parse(await fetchText(manifestUrl, {
        label: 'manifest url',
        accept: 'application/manifest+json,application/json,text/json,text/plain;q=0.8,*/*;q=0.2',
        maxBytes: MAX_MANIFEST_BYTES,
        allowContentType: isManifestLike,
      }));
    } catch (e) {
      return { ok: false, error: 'manifest fetch/parse failed: ' + String((e && e.message) || e) };
    }
    if (!manifest || typeof manifest !== 'object') return { ok: false, error: 'manifest is not an object' };

    // start_url resolves against the manifest URL (per spec).
    let startUrl = safePageUrl;
    if (manifest.start_url) {
      try { startUrl = httpUrl(manifest.start_url, manifestUrl, 'start_url'); } catch (e) {}
    }

    let iconDataUrl = null;
    const icon = pickIcon(manifest.icons);
    if (icon) iconDataUrl = await fetchIconDataUrl(icon, manifestUrl);

    return {
      ok: true,
      name: cleanText(manifest.name || manifest.short_name || '', 120),
      shortName: cleanText(manifest.short_name || manifest.name || '', 80),
      startUrl: startUrl,
      display: cleanText(manifest.display || 'browser', 40),
      themeColor: cleanText(manifest.theme_color || '', 80) || null,
      iconDataUrl: iconDataUrl,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function cleanText(value, maxLen) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen || 120);
}

module.exports = { fetchManifest };
