'use strict';

/*
 * webkit.js — true WebKit engine via Playwright.
 *
 * Lazy-launched on first engine:set webkit (playwright required lazily so
 * PLAYWRIGHT_BROWSERS_PATH — set in main.js — is always in effect first).
 * One context per device; ~8 fps JPEG screenshot loop with an in-flight
 * guard, frames pushed to the shell renderer as 'webkit:frame'.
 * Input forwarding (tap/down/move/up/wheel/key/type), picker via
 * page.evaluate of src/inject/picker.js + console listener, page:meta on
 * navigation. Graceful degrade: every entry point returns {ok:false,error}
 * instead of throwing; nothing here may crash the app.
 */

const { clipboard } = require('electron');
const emulation = require('./emulation');

const ctx = {
  state: null,
  send: null,
};

const wk = {
  playwright: null,
  browser: null,
  context: null,
  page: null,
  device: null,
  active: false,
  timer: null,
  inFlight: false,
  lastFrame: null, // Buffer (jpeg) of the most recent frame
  histIndex: 0,
  histLength: 1,
  standalone: false,
};

const FRAME_INTERVAL_MS = 125; // ~8 fps

const SCROLL_REPORTER =
  "(function(){try{if(window.__DEVPHONE_SCROLL_INSTALLED__)return;" +
  "window.__DEVPHONE_SCROLL_INSTALLED__=true;var last=0;var pending=null;" +
  "var report=function(){last=Date.now();pending=null;" +
  "try{console.log('__DEVPHONE_SCROLL__'+JSON.stringify({y:Math.round(window.scrollY||0)}))}catch(e){}};" +
  "window.addEventListener('scroll',function(){var now=Date.now();" +
  "if(now-last>=100){report()}else if(!pending){pending=setTimeout(report,100-(now-last))}}," +
  "{passive:true,capture:true})}catch(e){}})();";

function init(options) {
  ctx.state = options.state;
  ctx.send = options.send;
}

function send(channel, payload) {
  try { if (ctx.send) ctx.send(channel, payload); } catch (e) {}
}

function buildInitScript(device, standalone) {
  const cfg = {
    standalone: !!standalone,
    os: device.os || '',
    deviceId: device.id || '',
    deviceLabel: device.label || '',
    viewport: device.viewport || null,
    dpr: device.dpr || 1,
  };
  let js =
    'window.__DEVPHONE_STANDALONE__=' + JSON.stringify(!!standalone) + ';' +
    'window.__DEVPHONE__=Object.assign(window.__DEVPHONE__||{},' + JSON.stringify(cfg) + ');' +
    '\n' + SCROLL_REPORTER;
  if (device.os === 'ios') {
    const shims = emulation.getShimSource();
    if (shims) js += '\n' + shims;
  }
  return js;
}

async function start(options) {
  const device = options && options.device;
  const url = (options && options.url) || 'about:blank';
  const standalone = !!(options && options.standalone);
  // v0.1.1: optional content-viewport override (page laid out between the
  // phone's bars) — mirrors the Chromium-side device:set viewport override.
  const vpo = (options && options.viewport) || null;
  if (!device) return { ok: false, error: 'no device selected' };

  try {
    if (!wk.playwright) wk.playwright = require('playwright');
    if (!wk.browser || !wk.browser.isConnected()) {
      wk.browser = await wk.playwright.webkit.launch({ headless: true });
      wk.browser.on('disconnected', () => {
        wk.browser = null;
        if (wk.active) stop().catch(() => {});
      });
    }

    await closeContext();

    wk.context = await wk.browser.newContext({
      viewport: {
        width: (vpo && vpo.width) || (device.viewport && device.viewport.width) || 390,
        height: (vpo && vpo.height) || (device.viewport && device.viewport.height) || 844,
      },
      deviceScaleFactor: device.dpr || 2,
      isMobile: true,
      hasTouch: true,
      userAgent: device.ua,
    });
    await wk.context.addInitScript({ content: buildInitScript(device, standalone) });

    wk.page = await wk.context.newPage();
    wk.device = device;
    wk.standalone = standalone;
    wk.histIndex = 0;
    wk.histLength = 1;
    wirePage(wk.page);

    wk.active = true;

    if (url && url !== 'about:blank') {
      wk.histIndex = 1;
      wk.histLength = 2;
      try {
        await wk.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch (e) {
        // Navigation failure is not a mode failure — stream whatever renders.
        console.error('[webkit] initial goto failed:', e && e.message);
      }
    }

    startFrameLoop();
    emitMeta();
    return { ok: true, mode: 'webkit' };
  } catch (e) {
    try { await stop(); } catch (e2) {}
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function wirePage(page) {
  page.on('console', (msg) => {
    try {
      const text = msg.text();
      if (typeof text !== 'string') return;
      if (text.indexOf('__DEVPHONE_PICK__') === 0) {
        const report = JSON.parse(text.slice('__DEVPHONE_PICK__'.length));
        const device = wk.device;
        if (device && !report.device) report.device = device.label || device.id;
        try { clipboard.writeText(emulation.composePickText(report, device)); } catch (e) {}
        send('picker:result', { report });
      } else if (text.indexOf('__DEVPHONE_SCROLL__') === 0) {
        const data = JSON.parse(text.slice('__DEVPHONE_SCROLL__'.length));
        send('page:scroll', { y: Number(data.y) || 0 });
      }
    } catch (e) { /* malformed bridge message — ignore */ }
  });

  page.on('framenavigated', (frame) => {
    try {
      if (frame !== page.mainFrame()) return;
      emitMeta();
    } catch (e) {}
  });

  page.on('domcontentloaded', () => emitMeta());

  page.on('close', () => {
    if (wk.page === page) wk.page = null;
  });
}

async function emitMeta() {
  try {
    if (!wk.active || !wk.page) return;
    const url = wk.page.url();
    if (ctx.state && url && url !== 'about:blank') ctx.state.currentUrl = url;
    let title = '';
    try { title = await wk.page.title(); } catch (e) {}
    let themeColor = null;
    try {
      themeColor = await wk.page.evaluate(
        "(function(){var m=document.querySelector('meta[name=\"theme-color\"]');return m?m.getAttribute('content'):null})()");
    } catch (e) {}
    send('page:meta', {
      title: title,
      url: url,
      canGoBack: wk.histIndex > 0,
      canGoForward: wk.histIndex < wk.histLength - 1,
      themeColor: themeColor,
    });
  } catch (e) {}
}

function startFrameLoop() {
  stopFrameLoop();
  wk.timer = setInterval(async () => {
    if (!wk.active || !wk.page || wk.inFlight) return;
    wk.inFlight = true;
    try {
      // scale:'css' keeps frames at viewport CSS size — full-DPR jpegs cost
      // ~400ms each and cap the stream near 2 fps; CSS scale sustains ~8.
      const buf = await wk.page.screenshot({ type: 'jpeg', quality: 70, scale: 'css', timeout: 4000 });
      wk.lastFrame = buf;
      send('webkit:frame', { dataUrl: 'data:image/jpeg;base64,' + buf.toString('base64') });
    } catch (e) {
      /* page navigating / closed mid-shot — skip frame */
    } finally {
      wk.inFlight = false;
    }
  }, FRAME_INTERVAL_MS);
}

function stopFrameLoop() {
  if (wk.timer) {
    clearInterval(wk.timer);
    wk.timer = null;
  }
}

async function nav(options) {
  const action = options && options.action;
  const url = options && options.url;
  try {
    if (!wk.active || !wk.page) return { ok: false, error: 'webkit not active' };
    if (action === 'go') {
      if (!url) return { ok: false, error: 'nav go requires url' };
      wk.histIndex += 1;
      wk.histLength = wk.histIndex + 1; // pushing truncates forward history
      await wk.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    } else if (action === 'back') {
      const res = await wk.page.goBack({ timeout: 15000 }).catch(() => null);
      if (res !== null && wk.histIndex > 0) wk.histIndex -= 1;
    } else if (action === 'forward') {
      const res = await wk.page.goForward({ timeout: 15000 }).catch(() => null);
      if (res !== null && wk.histIndex < wk.histLength - 1) wk.histIndex += 1;
    } else if (action === 'reload') {
      await wk.page.reload({ timeout: 30000 }).catch(() => {});
    } else {
      return { ok: false, error: 'unknown nav action: ' + action };
    }
    await emitMeta();
    return { ok: true, url: wk.page ? wk.page.url() : '' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function input(a) {
  try {
    if (!wk.active || !wk.page) return { ok: false, error: 'webkit not active' };
    const p = wk.page;
    const type = a && a.type;
    switch (type) {
      case 'tap':
        await p.touchscreen.tap(a.x || 0, a.y || 0);
        break;
      case 'down':
        await p.mouse.move(a.x || 0, a.y || 0);
        await p.mouse.down();
        break;
      case 'move':
        await p.mouse.move(a.x || 0, a.y || 0);
        break;
      case 'up':
        await p.mouse.up();
        break;
      case 'wheel':
        try {
          await p.mouse.wheel(a.dx || 0, a.dy || 0);
        } catch (e) {
          // Mobile WebKit rejects mouse.wheel — scroll the document instead.
          await p.evaluate(
            'window.scrollBy({left:' + (Number(a.dx) || 0) +
            ',top:' + (Number(a.dy) || 0) + ',behavior:"instant"})').catch(() => {});
        }
        break;
      case 'key':
        if (a.key) await p.keyboard.press(a.key);
        break;
      case 'type':
        if (a.text) await p.keyboard.type(String(a.text));
        break;
      default:
        return { ok: false, error: 'unknown input type: ' + type };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function setPicker(on) {
  try {
    if (!wk.active || !wk.page) return { ok: false, error: 'webkit not active' };
    const src = emulation.getPickerSource();
    if (!src) return { ok: false, error: 'picker source missing' };
    await wk.page.evaluate(src); // idempotent IIFE (string evaluated in page)
    await wk.page.evaluate(
      'window.__DEVPHONE_PICKER__ && window.__DEVPHONE_PICKER__(' + (on ? 'true' : 'false') + ');');
    return { ok: true, on: !!on };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function setStandalone(on) {
  wk.standalone = !!on;
  try {
    if (!wk.active) return { ok: true, standalone: wk.standalone };
    // Future loads: appended init scripts run after earlier ones, so the
    // latest value wins. Current page: set the live flag directly.
    if (wk.context) {
      await wk.context.addInitScript({
        content: 'window.__DEVPHONE_STANDALONE__=' + JSON.stringify(!!on) + ';',
      }).catch(() => {});
    }
    if (wk.page) {
      await wk.page.evaluate('window.__DEVPHONE_STANDALONE__=' + JSON.stringify(!!on) + ';').catch(() => {});
    }
    return { ok: true, standalone: wk.standalone };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Device switch while webkit mode is active → new context for the device.
async function setDevice(device, options) {
  if (!wk.active) return { ok: true, inactive: true };
  return start({
    device: device,
    url: (options && options.url) || (ctx.state && ctx.state.currentUrl) || 'about:blank',
    standalone: !!(options && options.standalone),
    viewport: (options && options.viewport) || null,
  });
}

// v0.1.1: input:set lands here when the webkit engine is active. WebKit's
// touch behavior is fixed at context creation (hasTouch) — accept the call
// and decline gracefully so the IPC never throws in webkit mode.
async function setInputMode() {
  return { ok: false, error: 'webkit mode: input mode fixed' };
}

async function closeContext() {
  const c = wk.context;
  wk.context = null;
  wk.page = null;
  if (c) {
    try { await c.close(); } catch (e) {}
  }
}

// Mode switch / screen teardown: stop streaming, close context, keep the
// browser process warm for fast re-entry.
async function stop() {
  wk.active = false;
  stopFrameLoop();
  wk.inFlight = false;
  await closeContext();
  return { ok: true };
}

// App quit: full shutdown including the browser process.
async function shutdown() {
  try { await stop(); } catch (e) {}
  const b = wk.browser;
  wk.browser = null;
  if (b) {
    try { await b.close(); } catch (e) {}
  }
  return { ok: true };
}

function getLastFrame() {
  return wk.lastFrame;
}

// Full-resolution PNG (device scale) for saved screenshots; null on failure
// (callers fall back to getLastFrame()).
async function captureFull() {
  try {
    if (!wk.active || !wk.page) return null;
    return await wk.page.screenshot({ type: 'png', scale: 'device', timeout: 8000 });
  } catch (e) {
    return null;
  }
}

function isActive() {
  return wk.active;
}

module.exports = {
  init,
  start,
  stop,
  shutdown,
  nav,
  input,
  setPicker,
  setStandalone,
  setInputMode,
  setDevice,
  getLastFrame,
  captureFull,
  isActive,
};
