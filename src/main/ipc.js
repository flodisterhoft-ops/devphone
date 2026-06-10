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

const { ipcMain, webContents, shell } = require('electron');

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
};

function send(channel, payload) {
  try {
    const win = state.shellWindow;
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
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

  handle('device:set', async ({ deviceId }) => {
    const device = updater.findDevice(deviceId);
    if (!device) return { ok: false, error: 'unknown device: ' + deviceId };
    state.device = device;
    if (state.screenWC && !state.screenWC.isDestroyed()) {
      await emulation.applyDevice(state.screenWC, device, { standalone: state.standalone });
      await emulation.injectCfg(state.screenWC);
    }
    if (state.engineMode === 'webkit') {
      await webkit.setDevice(device, { standalone: state.standalone, url: state.currentUrl });
    }
    return device; // contract: returns the device object
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

  handle('shell:resize', async ({ width, height }) => {
    const win = state.shellWindow;
    if (!win || win.isDestroyed()) return { ok: false, error: 'no shell window' };
    const w = Math.max(1, Math.round(Number(width) || 0));
    const h = Math.max(1, Math.round(Number(height) || 0));
    if (!w || !h) return { ok: false, error: 'bad size ' + width + 'x' + height };
    try {
      // resizable:false blocks user resizing; allow it briefly for our own.
      win.setResizable(true);
      win.setSize(w, h);
    } finally {
      try { win.setResizable(false); } catch (e) {}
    }
    return { ok: true, width: w, height: h };
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
      viewport: d ? d.viewport : null,
      dpr: d ? d.dpr : 1,
      themeColor: state.themeColor,
    };
  });

  ipcMain.on('screen:shims', (event) => {
    event.returnValue = emulation.getShimSource();
  });
}

function setWindow(win) {
  state.shellWindow = win;
}

function getState() {
  return state;
}

module.exports = { init, setWindow, getState, send };
