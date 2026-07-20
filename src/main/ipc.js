'use strict';

/*
 * ipc.js — every IPC channel from the contract, delegating to the engine
 * modules. Holds the small central state: current device, engine mode,
 * standalone flag, the screen webContents (from screen:attach) and the
 * shell window.
 *
 * Every handler is wrapped: failures return {ok:false, error} — never throw
 * across the IPC boundary.
 */

const { app, ipcMain, webContents, shell, screen } = require('electron');

const emulation = require('./emulation');
const webkit = require('./webkit');
const screenshot = require('./screenshot');
const pwa = require('./pwa');
const updater = require('./updater');

const DEFAULT_DEVICE_ID = 'iphone-16-pro-max';

const state = {
  shellWindow: null,
  screenWC: null, // webContents of the <webview> (screen:attach)
  device: null,
  engineMode: 'chromium', // 'chromium' | 'webkit'
  standalone: false,
  themeColor: null,
  currentUrl: 'about:blank',
  selftest: false,
  inputMode: 'touch', // 'touch' | 'mouse' (v0.1.1) — re-applied on every emulation pass
  viewportOverride: null, // {width,height} content viewport (v0.1.1) or null = device viewport
  mouseIgnored: false, // v0.1.5: click-through state (shell:ignoreMouse)
};

function send(channel, payload) {
  try {
    const win = state.shellWindow;
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  } catch (e) {}
}

function cancelTaskbarFlash(win) {
  if (process.platform !== 'win32') return;
  try {
    if (win && !win.isDestroyed() && typeof win.flashFrame === 'function') {
      win.flashFrame(false);
    }
  } catch (e) {}
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, args) => {
    try {
      return await fn(args || {}, event);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

function ensureDevice() {
  if (!state.device) {
    state.device = updater.findDevice(DEFAULT_DEVICE_ID) || updater.listDevices()[0] || null;
  }
  return state.device;
}

function orientedDevice(device, orientation) {
  if (!device) return device;
  const next = device.formFactor === 'tablet' && orientation === 'landscape'
    ? 'landscape'
    : 'portrait';
  const oriented = Object.assign({}, device, {
    orientation: next,
    viewport: Object.assign({}, device.viewport || {}),
  });
  if (next === 'landscape') {
    oriented.viewport.width = device.viewport.height;
    oriented.viewport.height = device.viewport.width;
  }
  return oriented;
}

function init(options) {
  state.selftest = !!(options && options.selftest);

  emulation.init({ state, send });
  webkit.init({ state, send });
  updater.start({ send, enableSchedule: !state.selftest });

  // ---------- renderer → main (invoke) ----------

  handle('devices:list', async () => {
    return { devices: updater.listDevices() };
  });

  handle('screen:attach', async ({ webContentsId }) => {
    const wc = webContents.fromId(Number(webContentsId));
    if (!wc || wc.isDestroyed()) {
      return { ok: false, error: 'webContents not found: ' + webContentsId };
    }
    state.screenWC = wc;
    wc.once('destroyed', () => {
      if (state.screenWC === wc) state.screenWC = null;
    });
    const device = ensureDevice();
    emulation.attachScreen(wc);
    const res = await emulation.applyDevice(wc, device, { standalone: state.standalone });
    await emulation.injectCfg(wc);
    return { ok: !!(res && res.ok), deviceId: device ? device.id : null, error: res && res.error };
  });

  handle('device:set', async ({ deviceId, viewport, orientation }) => {
    const preset = updater.findDevice(deviceId);
    if (!preset) return { ok: false, error: 'unknown device: ' + deviceId };
    const device = orientedDevice(preset, orientation);
    state.device = device;
    // v0.1.1: optional content-viewport override — the renderer lays the page
    // out BETWEEN the phone's bars and tells us the visible area. Stored in
    // state so dom-ready re-applies honor it; CLEARED whenever a device:set
    // arrives without one (backward compatible: old calls behave as before).
    const vw = viewport ? Math.round(Number(viewport.width)) : 0;
    const vh = viewport ? Math.round(Number(viewport.height)) : 0;
    state.viewportOverride = vw > 0 && vh > 0 ? { width: vw, height: vh } : null;
    if (state.screenWC && !state.screenWC.isDestroyed()) {
      await emulation.applyDevice(state.screenWC, device, { standalone: state.standalone });
      await emulation.injectCfg(state.screenWC);
    }
    if (state.engineMode === 'webkit') {
      await webkit.setDevice(device, {
        standalone: state.standalone,
        url: state.currentUrl,
        viewport: state.viewportOverride,
      });
    }
    return device; // contract: returns the device object
  });

  // v0.1.1: input mode — 'touch' (emulated touch, default) | 'mouse' (normal
  // desktop mouse: text selection, drag-to-highlight, native cursor). UA and
  // metrics stay phone-like either way. Persisted in state so every
  // emulation re-apply (dom-ready, device:set) keeps the chosen mode.
  handle('input:set', async ({ mode }) => {
    if (mode !== 'touch' && mode !== 'mouse') {
      return { ok: false, error: "unknown input mode: " + mode + " (use 'touch' or 'mouse')" };
    }
    if (state.engineMode === 'webkit') {
      return webkit.setInputMode(mode); // {ok:false, error:'webkit mode: input mode fixed'}
    }
    state.inputMode = mode;
    if (state.screenWC && !state.screenWC.isDestroyed()) {
      await emulation.setInputMode(state.screenWC, mode);
    }
    return { ok: true, mode };
  });

  handle('engine:set', async ({ mode }) => {
    if (mode === 'chromium') {
      await webkit.stop();
      state.engineMode = 'chromium';
      return { ok: true, mode: 'chromium' };
    }
    if (mode === 'webkit') {
      const device = ensureDevice();
      if (!device) return { ok: false, error: 'no device available', mode: 'chromium' };
      const res = await webkit.start({
        device,
        url: state.currentUrl,
        standalone: state.standalone,
        viewport: state.viewportOverride,
      });
      if (res && res.ok) {
        state.engineMode = 'webkit';
        return { ok: true, mode: 'webkit' };
      }
      state.engineMode = 'chromium';
      return { ok: false, error: (res && res.error) || 'WebKit failed to start', mode: 'chromium' };
    }
    return { ok: false, error: 'unknown engine mode: ' + mode };
  });

  handle('nav', async ({ action, url }) => {
    if (state.engineMode === 'webkit') {
      return webkit.nav({ action, url });
    }
    // Chromium mode: renderer drives the webview directly per contract, but
    // handle it here too so nav is never a dead end.
    const wc = state.screenWC;
    if (!wc || wc.isDestroyed()) return { ok: false, error: 'no screen attached' };
    try {
      if (action === 'go' && url) {
        state.currentUrl = url;
        await wc.loadURL(url).catch(() => {});
      } else if (action === 'back') {
        if (wc.navigationHistory && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      } else if (action === 'forward') {
        if (wc.navigationHistory && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      } else if (action === 'reload') {
        wc.reload();
      } else if (action === 'hardReload') {
        try {
          if (wc.session && typeof wc.session.clearCache === 'function') {
            await wc.session.clearCache();
          }
        } catch (e) {}
        try {
          if (wc.debugger && wc.debugger.isAttached()) {
            await wc.debugger.sendCommand('Network.clearBrowserCache');
          }
        } catch (e) {}
        state.currentUrl = (typeof wc.getURL === 'function' && wc.getURL()) || state.currentUrl;
        if (typeof wc.reloadIgnoringCache === 'function') wc.reloadIgnoringCache();
        else wc.reload();
      } else {
        return { ok: false, error: 'unknown nav action: ' + action };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  handle('standalone:set', async ({ on, themeColor }) => {
    state.standalone = !!on;
    if (themeColor !== undefined) state.themeColor = themeColor;
    if (state.screenWC && !state.screenWC.isDestroyed()) {
      await emulation.setStandalone(state.screenWC, state.standalone);
    }
    if (state.engineMode === 'webkit') {
      await webkit.setStandalone(state.standalone);
    }
    return { ok: true, standalone: state.standalone };
  });

  handle('picker:toggle', async ({ on }) => {
    if (state.engineMode === 'webkit') {
      return webkit.setPicker(!!on);
    }
    return emulation.setPicker(state.screenWC, !!on);
  });

  handle('shot', async ({ mode }) => {
    return screenshot.shot({ mode: mode || 'screen', state, webkit });
  });

  handle('pwa:manifest', async ({ pageUrl }) => {
    return pwa.fetchManifest({ pageUrl });
  });

  handle('updater:check', async () => {
    return updater.checkNow();
  });

  // Extension (not in base contract): hide an auto-discovered device.
  handle('devices:dismiss', async ({ id }) => {
    return updater.dismiss(id);
  });

  handle('webkit:input', async (input) => {
    return webkit.input(input);
  });

  // v0.1.5: standalone headed WebKit window — full-speed real-WebKit preview
  // of the current page (no frame streaming). The renderer passes its own
  // current URL since main's state.currentUrl can lag in chromium mode.
  handle('webkit:window', async (payload) => {
    const device = ensureDevice();
    if (!device) return { ok: false, error: 'no device available' };
    const url = (payload && payload.url) || state.currentUrl;
    return webkit.openWindow({ device, url });
  });

  // v0.1.4: native drag/wheel replay on the GUEST debugger (chromium engine).
  // Batched samples {phase:'start'|'move'|'end'|'cancel'|'wheel', x, y, t,
  // dx?, dy?} are dispatched as Input.dispatchTouchEvent / mouseWheel — real
  // Chromium scroll physics (momentum fling, smooth wheel). The renderer
  // falls back to its synthetic in-guest scrollBy on any {ok:false}.
  // WebKit engine keeps its existing webkit:input path.
  handle('guest:gesture', async ({ samples }) => {
    if (state.engineMode !== 'chromium') {
      return { ok: false, error: 'webkit engine: use webkit:input' };
    }
    return emulation.dispatchGesture(state.screenWC, samples);
  });

  handle('shell:resize', async ({ width, height }) => {
    const win = state.shellWindow;
    if (!win || win.isDestroyed()) return { ok: false, error: 'no shell window' };
    const w = Math.max(1, Math.round(Number(width) || 0));
    const h = Math.max(1, Math.round(Number(height) || 0));
    if (!w || !h) return { ok: false, error: 'bad size ' + width + 'x' + height };
    // setBounds applies a new size on resizable:false directly (measured,
    // probe-setbounds.js) — the old setResizable(true)…(false) toggle made
    // Windows 11 blink its window border around the transparent rectangle.
    const b = win.getBounds();
    win.setBounds({ x: b.x, y: b.y, width: w, height: h });
    return { ok: true, width: w, height: h };
  });

  // v0.1.1: first-click fix — the renderer sends this on mousemove while the
  // OS window is unfocused; focusing BEFORE the click lands means the
  // activating click is no longer eaten. No moveTop/alwaysOnTop games.
  handle('shell:activate', async () => {
    const win = state.shellWindow;
    if (win && !win.isDestroyed() && !win.isFocused()) {
      win.focus();
      cancelTaskbarFlash(win);
    }
    return { ok: true };
  });

  // v0.1.5: click-through for the window's INVISIBLE regions. The window is
  // a big transparent rectangle (phone + shadow margin + gap + rail + min
  // height); whenever the cursor is over nothing visible the renderer turns
  // mouse-ignoring ON ({forward:true} keeps mousemoves flowing so it can
  // turn it back OFF when the cursor reaches the phone/rail) — clicks in
  // the empty area land on whatever window is BEHIND DevPhone.
  handle('shell:ignoreMouse', async ({ on }) => {
    const win = state.shellWindow;
    if (!win || win.isDestroyed()) return { ok: false, error: 'no shell window' };
    win.setIgnoreMouseEvents(!!on, { forward: true });
    state.mouseIgnored = !!on;
    win.__mouseIgnored = !!on; // test hook: BrowserWindow has no getter for this
    return { ok: true, on: !!on };
  });

  // v0.1.5: manual window drag from the phone bezel. The bezel can NOT be a
  // CSS app-region (drag regions are HTCAPTION on Windows and swallow bezel
  // right-clicks — the v0.1.3 context-menu lesson), so the renderer pings
  // start/move/end and MAIN derives the motion.
  //
  // Coordinates come from screen.getCursorScreenPoint() — OS ground truth in
  // integer DIPs, the same space as window bounds. They must NOT come from
  // the renderer's event screenX/Y: those are computed against a window
  // origin that lags our own moves during the drag, and the feedback
  // accumulated — measurably, the phone slid DOWN out of the grab cursor on
  // longer back-and-forth drags. Anchor-based ground truth cannot drift:
  // returning the cursor to its press point returns the window exactly to
  // its press bounds. Explicit {x,y} is still honored so the deterministic
  // suite can drive the handler without moving the real cursor.
  //
  // setBounds (not setPosition) with the ANCHORED size: on scaled displays
  // a bare position move can re-round the size of this resizable:false
  // window, and a 1px size wobble per move also reads as drift.
  let dragAnchor = null;
  handle('shell:drag', async ({ phase, x, y }) => {
    const win = state.shellWindow;
    if (!win || win.isDestroyed()) return { ok: false, error: 'no shell window' };
    const cur = (typeof x === 'number' && typeof y === 'number')
      ? { x: Math.round(x), y: Math.round(y) }
      : screen.getCursorScreenPoint();
    if (phase === 'start') {
      const b = win.getBounds();
      dragAnchor = { bx: b.x, by: b.y, bw: b.width, bh: b.height, x: cur.x, y: cur.y, lx: b.x, ly: b.y };
      return { ok: true };
    }
    if (phase === 'move') {
      if (!dragAnchor) return { ok: false, error: 'no drag in progress' };
      const nx = dragAnchor.bx + (cur.x - dragAnchor.x);
      const ny = dragAnchor.by + (cur.y - dragAnchor.y);
      if (nx !== dragAnchor.lx || ny !== dragAnchor.ly) {
        dragAnchor.lx = nx;
        dragAnchor.ly = ny;
        // ONE setBounds with the ANCHORED size — no style toggles, ever.
        // Measured on this machine (150% display scale, probe-setbounds.js):
        //   · setPosition GROWS a resizable:false window ~1px per call
        //     (DIP→physical→DIP re-rounding) — the phone visibly snapped at
        //     drag release when a restore corrected the accumulation
        //   · per-move setResizable toggles made Windows 11 blink its border
        //     around the transparent window rectangle
        //   · setBounds WITH size applies cleanly on resizable:false (the
        //     old "size writes are blocked" assumption is false on E36/win32)
        //     and holds bounds exactly: zero drift, zero restyling
        win.setBounds({ x: nx, y: ny, width: dragAnchor.bw, height: dragAnchor.bh });
      }
      return { ok: true };
    }
    dragAnchor = null; // 'end' / 'cancel' — size never drifted, nothing to restore
    return { ok: true };
  });

  // v0.1.3: window pinning (UI-agent exception: this one handler + its
  // preload allowlist entry). Persisted/re-applied by the renderer.
  handle('shell:alwaysOnTop', async ({ on }) => {
    const win = state.shellWindow;
    if (!win || win.isDestroyed()) return { ok: false, error: 'no shell window' };
    win.setAlwaysOnTop(!!on);
    return { ok: true, on: !!on };
  });

  handle('shell:minimize', async () => {
    const win = state.shellWindow;
    if (win && !win.isDestroyed()) win.minimize();
    return { ok: true };
  });

  handle('shell:close', async () => {
    const win = state.shellWindow;
    if (win && !win.isDestroyed()) win.close();
    return { ok: true };
  });

  handle('open:external', async ({ url }) => {
    if (!/^https?:\/\//i.test(String(url || ''))) {
      return { ok: false, error: 'only http(s) urls can be opened externally' };
    }
    await shell.openExternal(url);
    return { ok: true };
  });

  // ---------- synchronous channels for the SCREEN preload ----------
  // (race-safe seeding of page globals before any page script runs)

  ipcMain.on('screen:cfg', (event) => {
    const d = state.device;
    event.returnValue = {
      standalone: !!state.standalone,
      os: d ? d.os : '',
      deviceId: d ? d.id : '',
      deviceLabel: d ? d.label : '',
      formFactor: d && d.formFactor === 'tablet' ? 'tablet' : 'phone',
      orientation: d ? (d.orientation || 'portrait') : 'portrait',
      viewport: d ? d.viewport : null,
      dpr: d ? d.dpr : 1,
      themeColor: state.themeColor,
    };
  });

  ipcMain.on('screen:shims', (event) => {
    event.returnValue = emulation.getShimSource();
  });

  // v0.1.6: current app version for the shell (Settings → About). Sync so the
  // preload can expose it as a plain value at load.
  ipcMain.on('app:version', (event) => {
    try { event.returnValue = app.getVersion(); } catch (e) { event.returnValue = ''; }
  });
}

function setWindow(win) {
  state.shellWindow = win;
}

function getState() {
  return state;
}

module.exports = { init, setWindow, getState, send };
