'use strict';

/*
 * emulation.js — Chromium (webview) device emulation via CDP.
 *
 * - attachScreen(wc): debugger attach + dom-ready re-apply + console-message
 *   bridge (__DEVPHONE_PICK__ / __DEVPHONE_SCROLL__).
 * - applyDevice(wc, device, {standalone}): metrics, touch, UA (+ UA-CH
 *   metadata for Android; header stripping for iOS via session.webRequest on
 *   partition 'persist:devphone'), safe-area insets (try/catch), emulated
 *   media display-mode.
 * - composePickText(report, device): human-readable clipboard text.
 */

const path = require('path');
const fs = require('fs');
const { session, clipboard } = require('electron');

const ctx = {
  state: null, // shared state object owned by ipc.js
  send: null, // (channel, payload) => void  → shell renderer
};

const attached = new WeakSet();
let shimSource = null;
let pickerSource = null;
let headerFilterInstalled = false;

function getShimSource() {
  if (shimSource == null) {
    try {
      shimSource = fs.readFileSync(path.join(__dirname, '..', 'inject', 'ios-shims.js'), 'utf8');
    } catch (e) {
      console.error('[emulation] cannot read ios-shims.js:', e);
      shimSource = '';
    }
  }
  return shimSource;
}

function getPickerSource() {
  if (pickerSource == null) {
    try {
      pickerSource = fs.readFileSync(path.join(__dirname, '..', 'inject', 'picker.js'), 'utf8');
    } catch (e) {
      console.error('[emulation] cannot read picker.js:', e);
      pickerSource = '';
    }
  }
  return pickerSource;
}

function init(options) {
  ctx.state = options.state;
  ctx.send = options.send;
  installHeaderFilter();
}

// Strip sec-ch-ua* request headers whenever the active device is iOS.
// Single global listener on the persist:devphone partition (re-registering
// would replace it, so install once).
function installHeaderFilter() {
  if (headerFilterInstalled) return;
  headerFilterInstalled = true;
  try {
    const ses = session.fromPartition('persist:devphone');
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      try {
        const st = ctx.state;
        if (st && st.device && st.device.os === 'ios' && details.requestHeaders) {
          for (const key of Object.keys(details.requestHeaders)) {
            if (key.toLowerCase().indexOf('sec-ch-ua') === 0) delete details.requestHeaders[key];
          }
        }
      } catch (e) { /* never break requests */ }
      callback({ requestHeaders: details.requestHeaders });
    });
  } catch (e) {
    console.error('[emulation] header filter install failed:', e);
  }
}

function extractConsoleMessage(args) {
  // Electron is migrating 'console-message' from positional args
  // (event, level, message, line, sourceId) to an event object with
  // .message — handle both shapes.
  try {
    const first = args[0];
    if (first && typeof first === 'object' && typeof first.message === 'string') return first.message;
    if (typeof args[2] === 'string') return args[2];
    if (typeof args[1] === 'string' && args[1].indexOf('__DEVPHONE_') === 0) return args[1];
  } catch (e) {}
  return null;
}

function handleBridgeMessage(msg) {
  if (typeof msg !== 'string') return false;
  try {
    if (msg.indexOf('__DEVPHONE_PICK__') === 0) {
      const report = JSON.parse(msg.slice('__DEVPHONE_PICK__'.length));
      const device = ctx.state ? ctx.state.device : null;
      if (device && !report.device) report.device = device.label || device.id;
      try { clipboard.writeText(composePickText(report, device)); } catch (e) {}
      if (ctx.send) ctx.send('picker:result', { report });
      return true;
    }
    if (msg.indexOf('__DEVPHONE_SCROLL__') === 0) {
      const data = JSON.parse(msg.slice('__DEVPHONE_SCROLL__'.length));
      if (ctx.send) ctx.send('page:scroll', { y: Number(data.y) || 0 });
      return true;
    }
  } catch (e) { /* malformed bridge message — ignore */ }
  return false;
}

// Attach the screen webview's webContents: CDP debugger + per-load re-apply.
// Idempotent per webContents (WeakSet guard) — listeners registered once.
function attachScreen(wc) {
  if (!wc || wc.isDestroyed() || attached.has(wc)) return;
  attached.add(wc);

  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  } catch (e) {
    console.error('[emulation] debugger attach failed:', e && e.message);
  }

  wc.on('dom-ready', () => {
    const st = ctx.state;
    if (!st) return;
    if (st.device) {
      applyDevice(wc, st.device, { standalone: st.standalone }).catch(() => {});
    }
    injectCfg(wc).catch(() => {});
  });

  wc.on('console-message', (...args) => {
    const msg = extractConsoleMessage(args);
    if (msg) handleBridgeMessage(msg);
  });

  wc.on('did-navigate', (event, url) => {
    if (ctx.state && url) ctx.state.currentUrl = url;
  });
  wc.on('did-navigate-in-page', (event, url) => {
    if (ctx.state && url) ctx.state.currentUrl = url;
  });
}

// Inject live config globals into the current page. Also (re-)applies the
// iOS shims from main — covers pages where the preload could not (CSP /
// sandbox edge cases). Shim + injection are both idempotent.
async function injectCfg(wc) {
  const st = ctx.state;
  if (!st || !wc || wc.isDestroyed()) return;
  const d = st.device || {};
  const cfg = {
    standalone: !!st.standalone,
    os: d.os || '',
    deviceId: d.id || '',
    deviceLabel: d.label || '',
    viewport: d.viewport || null,
    dpr: d.dpr || 1,
    themeColor: st.themeColor || null,
  };
  let js =
    'window.__DEVPHONE_STANDALONE__=' + JSON.stringify(!!st.standalone) + ';' +
    'window.__DEVPHONE__=Object.assign(window.__DEVPHONE__||{},' + JSON.stringify(cfg) + ');';
  if (d.os === 'ios') {
    const shims = getShimSource();
    if (shims) js += '\n' + shims;
  }
  try { await wc.executeJavaScript(js, true); } catch (e) { /* page may be navigating */ }
}

function computeInsets(device) {
  if (!device || device.cutout === 'none') return { top: 0, bottom: 0, left: 0, right: 0 };
  if (device.os === 'ios') {
    return { top: device.cutout === 'dynamic-island' ? 59 : 47, bottom: 34, left: 0, right: 0 };
  }
  return { top: 24, bottom: 24, left: 0, right: 0 }; // android + gesture bar
}

async function applyDevice(wc, device, options) {
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'webContents destroyed' };
  if (!device) return { ok: false, error: 'no device' };
  const standalone = !!(options && options.standalone);

  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  } catch (e) { /* already attached or unattachable — commands below will tell */ }

  // Every CDP send individually wrapped: older Chromium may lack commands.
  const cdp = async (method, params) => {
    try {
      return await wc.debugger.sendCommand(method, params);
    } catch (e) {
      return null;
    }
  };

  const vp = device.viewport || { width: 390, height: 844 };
  const dpr = device.dpr || 2;

  await cdp('Emulation.setDeviceMetricsOverride', {
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: dpr,
    mobile: true,
    screenWidth: vp.width,
    screenHeight: vp.height,
  });

  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });

  // UA: Electron-level (headers for the loader) + CDP (navigator.userAgent).
  try { wc.setUserAgent(device.ua); } catch (e) {}

  if (device.os === 'android') {
    const major = (String(device.ua).match(/Chrome\/(\d+)/) || [])[1] || '124';
    await cdp('Emulation.setUserAgentOverride', {
      userAgent: device.ua,
      userAgentMetadata: {
        brands: [
          { brand: 'Chromium', version: major },
          { brand: 'Google Chrome', version: major },
          { brand: 'Not/A)Brand', version: '24' },
        ],
        fullVersion: major + '.0.0.0',
        platform: 'Android',
        platformVersion: String(device.osVersion || ''),
        architecture: '',
        model: device.uaModel || '',
        mobile: true,
        bitness: '',
        wow64: false,
      },
    });
  } else {
    // iOS: UA only, no metadata (sec-ch-ua* headers are stripped by the
    // session webRequest filter while an iOS device is active).
    const res = await cdp('Emulation.setUserAgentOverride', { userAgent: device.ua });
    if (res === null) {
      // Some CDP versions insist on a metadata object — send a minimal one.
      await cdp('Emulation.setUserAgentOverride', {
        userAgent: device.ua,
        userAgentMetadata: {
          brands: [],
          fullVersion: '',
          platform: '',
          platformVersion: '',
          architecture: '',
          model: '',
          mobile: true,
        },
      });
    }
  }

  // Safe areas — newer CDP only; both parameter shapes attempted, no-op on failure.
  const insets = computeInsets(device);
  const insetRes = await cdp('Emulation.setSafeAreaInsetsOverride', { insets: insets });
  if (insetRes === null) await cdp('Emulation.setSafeAreaInsetsOverride', insets);

  await cdp('Emulation.setEmulatedMedia', {
    features: [{ name: 'display-mode', value: standalone ? 'standalone' : 'browser' }],
  });

  return { ok: true };
}

async function setStandalone(wc, on) {
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'webContents destroyed' };
  try {
    try {
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'display-mode', value: on ? 'standalone' : 'browser' }],
      });
    } catch (e) {}
    await injectCfg(wc); // refresh window.__DEVPHONE_STANDALONE__ live
    return { ok: true, standalone: !!on };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function setPicker(wc, on) {
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'no screen attached' };
  const src = getPickerSource();
  if (!src) return { ok: false, error: 'picker source missing' };
  try {
    await wc.executeJavaScript(src, true); // idempotent IIFE
    await wc.executeJavaScript(
      'window.__DEVPHONE_PICKER__ && window.__DEVPHONE_PICKER__(' + (on ? 'true' : 'false') + ');', true);
    return { ok: true, on: !!on };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function firstDefined() {
  for (let i = 0; i < arguments.length; i++) {
    if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== '') return arguments[i];
  }
  return '';
}

// Human-readable clipboard text per contract.
function composePickText(report, device) {
  const d = device || {};
  const vp = d.viewport || {};
  const r = report.rect || {};
  const s = report.styles || {};

  const lines = [];
  lines.push('[DevPhone pick · ' + firstDefined(d.label, report.device, 'Unknown device') +
    ' · ' + firstDefined(vp.width, '?') + '×' + firstDefined(vp.height, '?') +
    '@' + firstDefined(d.dpr, '?') + 'x]');
  lines.push('URL: ' + (report.pageUrl || ''));

  let el = report.selector || report.tag || '';
  if (Array.isArray(report.classes) && report.classes.length) {
    el += ' .' + report.classes.join('.');
  }
  lines.push('Element: ' + el);

  if (report.text) lines.push('Text: "' + report.text + '"');

  lines.push('Box: x=' + Math.round(r.x || 0) + ' y=' + Math.round(r.y || 0) +
    ' w=' + Math.round(r.w || 0) + ' h=' + Math.round(r.h || 0) + ' (CSS px)');

  const bits = [];
  if (s.fontSize || s.fontFamily) bits.push('font ' + [s.fontSize, s.fontFamily].filter(Boolean).join(' '));
  if (s.color) bits.push('color ' + s.color);
  if (s.background && s.background !== 'transparent') bits.push('bg ' + s.background);
  if (s.padding && s.padding !== '0px') bits.push('padding ' + s.padding);
  if (s.margin && s.margin !== '0px') bits.push('margin ' + s.margin);
  if (s.display) bits.push('display ' + s.display);
  if (s.position) bits.push('position ' + s.position);
  if (s.zIndex && s.zIndex !== 'auto') bits.push('z-index ' + s.zIndex);
  lines.push('Styles: ' + bits.join(' · '));

  if (report.htmlSnippet) lines.push('HTML: ' + report.htmlSnippet);
  return lines.join('\n');
}

module.exports = {
  init,
  attachScreen,
  applyDevice,
  injectCfg,
  setStandalone,
  setPicker,
  composePickText,
  getShimSource,
  getPickerSource,
  handleBridgeMessage, // exposed for webkit.js console routing
};
