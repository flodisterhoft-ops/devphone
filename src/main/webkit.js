'use strict';

/*
 * webkit.js — true WebKit engine via Playwright.
 *
 * Lazy-launched on first engine:set webkit (playwright required lazily so
 * PLAYWRIGHT_BROWSERS_PATH — set in main.js — is always in effect first).
 * One context per device; frames pushed to the shell renderer as
 * 'webkit:frame' {dataUrl, w, h, sharp?}.
 *
 * Adaptive streaming (v0.1.2):
 * - Self-scheduling capture loop: the next capture starts when the previous
 *   completes + a ~25ms breather (no fixed interval; throughput-bound).
 * - css-scale JPEG quality 75 while anything is moving; frames identical to
 *   the previous capture (base64 equality) are NOT sent.
 * - After ~600ms with no forwarded input, no navigation and no content
 *   change, ONE full-DPR frame (scale:'device', JPEG q90) is emitted with
 *   {sharp:true} so text is crisp while the user reads. The fast css loop
 *   resumes on the next input/navigation/content change.
 * - Frames are only emitted while the shell window is visible (not
 *   minimized/hidden); the loop stops cleanly on engine switch.
 *
 * Input forwarding (tap/down/move/up/wheel/key/type) — coordinates arrive
 * in CONTENT-viewport CSS px (v0.1.1) and the Playwright context viewport
 * is created from the same content-viewport override, so they map 1:1.
 * Picker via page.evaluate of src/inject/picker.js + console listener,
 * page:meta on navigation. Graceful degrade: every entry point returns
 * {ok:false,error} instead of throwing; nothing here may crash the app.
 */

const { clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
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
  viewport: null, // {width,height} the context was created with (CSS px)
  active: false,
  loopGen: 0, // generation counter — bumping it terminates a running loop
  lastFrame: null, // Buffer (jpeg) of the most recent frame
  lastB64: null, // base64 of the last css-scale capture (skip-identical)
  lastActivity: 0, // ts of last input / navigation / content change
  sharpSent: false, // one sharp frame per idle period
  histIndex: 0,
  histLength: 1,
  standalone: false,
};

const FRAME_BREATHER_MS = 25; // pause between a finished capture and the next
const FRAME_QUALITY = 75; // css-scale streaming jpeg quality
const SHARP_IDLE_MS = 600; // quiet time before the one crisp full-DPR frame
const SHARP_QUALITY = 90; // full-DPR jpeg quality
const HIDDEN_POLL_MS = 250; // re-check cadence while the shell is hidden

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Persistent storage state (v0.1.5) ───────────────────────────────
// Chromium mode keeps logins via the persist:devphone partition; WebKit
// mode used to start a fresh context every time (engine switch, device
// switch, relaunch) so sites demanded a login on every visit. Cookies +
// localStorage now round-trip through a storageState file in userData.
let storageFile; // undefined = unresolved, null = unavailable (harness)
function storageStatePath() {
  if (storageFile !== undefined) return storageFile;
  try {
    const { app } = require('electron');
    storageFile = path.join(app.getPath('userData'), 'webkit-storage.json');
  } catch (e) {
    storageFile = null;
  }
  return storageFile;
}

async function saveStorageState(context) {
  const file = storageStatePath();
  const c = context || wk.context;
  if (!file || !c) return;
  try { await c.storageState({ path: file }); } catch (e) {}
}

let saveTimer = null;
function scheduleStorageSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStorageState().catch(() => {});
  }, 2000);
}

// Any user intent or page motion: defers the sharp frame and re-arms it.
function bumpActivity() {
  wk.lastActivity = Date.now();
  wk.sharpSent = false;
}

// Emit only while the shell window can actually be seen. No window (module
// harnesses) counts as visible so streaming still works headless.
function shellVisible() {
  try {
    const win = ctx.state && ctx.state.shellWindow;
    if (!win || win.isDestroyed()) return true;
    return win.isVisible() && !win.isMinimized();
  } catch (e) {
    return true;
  }
}

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
    formFactor: device.formFactor === 'tablet' ? 'tablet' : 'phone',
    orientation: device.orientation || 'portrait',
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

    const vp = {
      width: (vpo && vpo.width) || (device.viewport && device.viewport.width) || 390,
      height: (vpo && vpo.height) || (device.viewport && device.viewport.height) || 844,
    };
    const ctxOptions = {
      viewport: vp,
      deviceScaleFactor: device.dpr || 2,
      isMobile: true,
      hasTouch: true,
      userAgent: device.ua,
    };
    const stateFile = storageStatePath();
    if (stateFile && fs.existsSync(stateFile)) {
      try {
        wk.context = await wk.browser.newContext(
          Object.assign({ storageState: stateFile }, ctxOptions));
      } catch (e) {
        // Corrupt/incompatible state file — drop it and start clean.
        try { fs.unlinkSync(stateFile); } catch (e2) {}
        wk.context = null;
      }
    }
    if (!wk.context) wk.context = await wk.browser.newContext(ctxOptions);
    await wk.context.addInitScript({ content: buildInitScript(device, standalone) });

    wk.page = await wk.context.newPage();
    wk.device = device;
    wk.viewport = vp;
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
      bumpActivity();
      emitMeta();
    } catch (e) {}
  });

  page.on('domcontentloaded', () => { bumpActivity(); emitMeta(); scheduleStorageSave(); });

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
  const gen = ++wk.loopGen; // implicitly stops any previous loop
  wk.lastB64 = null;
  bumpActivity();
  (async () => {
    while (wk.active && wk.loopGen === gen) {
      const page = wk.page;
      if (!page) { await delay(HIDDEN_POLL_MS); continue; }
      if (!shellVisible()) { await delay(HIDDEN_POLL_MS); continue; }

      const idle = Date.now() - wk.lastActivity >= SHARP_IDLE_MS;
      if (idle && !wk.sharpSent) {
        // Idle: ONE crisp full-DPR frame so text is readable. The fast loop
        // below keeps probing for changes and resumes streaming on motion.
        try {
          const buf = await page.screenshot({
            type: 'jpeg', quality: SHARP_QUALITY, scale: 'device', timeout: 8000,
          });
          if (!wk.active || wk.loopGen !== gen) break;
          wk.sharpSent = true;
          wk.lastFrame = buf;
          send('webkit:frame', {
            dataUrl: 'data:image/jpeg;base64,' + buf.toString('base64'),
            w: wk.viewport ? wk.viewport.width : undefined,
            h: wk.viewport ? wk.viewport.height : undefined,
            sharp: true,
          });
        } catch (e) {
          // device-scale shot failed (navigation mid-shot / huge page) —
          // don't retry-spin: mark sent; any activity re-arms it.
          wk.sharpSent = true;
        }
      } else {
        try {
          // scale:'css' keeps frames at viewport CSS size — full-DPR jpegs
          // cost ~400ms each; CSS scale sustains a fluid stream.
          const buf = await page.screenshot({
            type: 'jpeg', quality: FRAME_QUALITY, scale: 'css', timeout: 4000,
          });
          if (!wk.active || wk.loopGen !== gen) break;
          const b64 = buf.toString('base64');
          if (b64 !== wk.lastB64) {
            // Content changed: stream it, and treat motion as activity so
            // the sharp frame waits for the page to settle (no flicker
            // between sharp and css frames during animations).
            wk.lastB64 = b64;
            wk.lastFrame = buf;
            bumpActivity();
            send('webkit:frame', {
              dataUrl: 'data:image/jpeg;base64,' + b64,
              w: wk.viewport ? wk.viewport.width : undefined,
              h: wk.viewport ? wk.viewport.height : undefined,
            });
          }
        } catch (e) {
          /* page navigating / closed mid-shot — skip frame */
        }
      }
      await delay(FRAME_BREATHER_MS);
    }
  })().catch(() => { /* loop must never throw */ });
}

function stopFrameLoop() {
  wk.loopGen += 1; // running loop sees the generation change and exits
}

async function nav(options) {
  const action = options && options.action;
  const url = options && options.url;
  try {
    if (!wk.active || !wk.page) return { ok: false, error: 'webkit not active' };
    bumpActivity();
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
    } else if (action === 'hardReload') {
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
    bumpActivity(); // forwarded input resumes the fast css-scale loop
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
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (c) {
    await saveStorageState(c).catch(() => {});
    try { await c.close(); } catch (e) {}
  }
}

// ── Standalone headed WebKit window (v0.1.5) ────────────────────────
// "Open in WebKit window": a real, interactive WebKit window at native
// speed (no frame streaming) for previewing the current page. Separate
// HEADED browser process (the streaming engine stays headless); same
// device identity (viewport/dpr/UA/shims) and the SAME storage state
// file, so logins made in either place carry over to the other.
const hw = { browser: null, context: null, page: null };

async function openWindow(options) {
  const device = options && options.device;
  const url = (options && options.url) || 'about:blank';
  if (!device) return { ok: false, error: 'no device selected' };
  try {
    if (!wk.playwright) wk.playwright = require('playwright');

    // Already open → just retarget and surface the existing window.
    if (hw.page && !hw.page.isClosed()) {
      await hw.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await hw.page.bringToFront().catch(() => {});
      return { ok: true, reused: true };
    }

    if (!hw.browser || !hw.browser.isConnected()) {
      hw.browser = await wk.playwright.webkit.launch({ headless: false });
      hw.browser.on('disconnected', () => {
        hw.browser = null; hw.context = null; hw.page = null;
      });
    }

    const ctxOptions = {
      viewport: {
        width: (device.viewport && device.viewport.width) || 390,
        height: (device.viewport && device.viewport.height) || 844,
      },
      deviceScaleFactor: device.dpr || 2,
      isMobile: true,
      hasTouch: true,
      userAgent: device.ua,
    };
    const stateFile = storageStatePath();
    if (stateFile && fs.existsSync(stateFile)) {
      try {
        hw.context = await hw.browser.newContext(
          Object.assign({ storageState: stateFile }, ctxOptions));
      } catch (e) {
        hw.context = null;
      }
    }
    if (!hw.context) hw.context = await hw.browser.newContext(ctxOptions);
    await hw.context.addInitScript({ content: buildInitScript(device, false) });

    hw.page = await hw.context.newPage();
    hw.page.on('domcontentloaded', () => { saveStorageState(hw.context).catch(() => {}); });
    hw.page.on('close', async () => {
      const c = hw.context;
      hw.context = null; hw.page = null;
      if (c) {
        await saveStorageState(c).catch(() => {});
        try { await c.close(); } catch (e) {}
      }
    });

    await hw.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function closeWindow() {
  const b = hw.browser;
  hw.browser = null;
  if (hw.context) {
    await saveStorageState(hw.context).catch(() => {});
    try { await hw.context.close(); } catch (e) {}
  }
  hw.context = null; hw.page = null;
  if (b) {
    try { await b.close(); } catch (e) {}
  }
}

// Mode switch / screen teardown: stop streaming, close context, keep the
// browser process warm for fast re-entry.
async function stop() {
  wk.active = false;
  stopFrameLoop();
  wk.lastB64 = null;
  await closeContext();
  return { ok: true };
}

// App quit: full shutdown including the browser process.
async function shutdown() {
  try { await stop(); } catch (e) {}
  try { await closeWindow(); } catch (e) {}
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

async function getEvidence() {
  try {
    if (!wk.active || !wk.page) return null;
    const info = await wk.page.evaluate(
      '({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio,' +
      ' screen: [screen.width, screen.height], orientation: screen.orientation && screen.orientation.type,' +
      ' ua: navigator.userAgent, platform: navigator.platform,' +
      ' touch: navigator.maxTouchPoints, standalone: navigator.standalone, url: location.href })');
    info.engine = 'webkit';
    info.viewport = wk.viewport || null;
    info.deviceId = wk.device ? wk.device.id : null;
    return info;
  } catch (e) {
    return null;
  }
}

module.exports = {
  init,
  start,
  stop,
  shutdown,
  openWindow,
  nav,
  input,
  setPicker,
  setStandalone,
  setInputMode,
  setDevice,
  getLastFrame,
  captureFull,
  getEvidence,
  isActive,
};
