'use strict';

/*
 * shots.js — product screenshots for the README, captured from the REAL shell.
 *   npx electron scripts/shots.js <outDir> <demoHtmlPath>
 * Serves the demo page on localhost (so the address bar reads like a real dev
 * preview), drives the shell (home screen → open site → update popup →
 * settings → phone/tablet picker → tablet rotation), and writes product shots.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { app, BrowserWindow, Menu, nativeImage } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'scratch');
const DEMO = process.argv[3];
const PORT = 8137;

const ipc = require(path.join(ROOT, 'src', 'main', 'ipc'));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Fresh profile each run so a previous device switch / state doesn't leak in
// (the shell restores its last device + engine from localStorage).
try { app.setPath('userData', path.join(require('os').tmpdir(), 'devphone-shots-' + process.pid)); } catch (e) {}

async function shot(win) {
  try { win.setAlwaysOnTop(true); win.show(); win.focus(); } catch (e) {}
  await delay(280);
  let img = await win.webContents.capturePage();
  if (img.isEmpty()) { await delay(500); img = await win.webContents.capturePage(); }
  return img;
}
async function phoneRect(win) {
  return win.webContents.executeJavaScript(`(() => {
    const p = document.getElementById('phone'); const r = p.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 };
  })()`, true);
}
function cropPhone(img, rect) {
  // Asymmetric: the control rail always sits to the RIGHT, so keep the right
  // pad tight while leaving shadow room on the other sides.
  const d = rect.dpr, size = img.getSize();
  const l = 34, t = 30, b = 34, r = 10;
  const x = Math.max(0, Math.round((rect.x - l) * d));
  const y = Math.max(0, Math.round((rect.y - t) * d));
  const w = Math.min(size.width - x, Math.round((rect.w + l + r) * d));
  const h = Math.min(size.height - y, Math.round((rect.h + t + b) * d));
  return img.crop({ x, y, width: w, height: h });
}
function save(img, name) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, img.toPNG());
  console.log('wrote ' + name + ' (' + img.getSize().width + 'x' + img.getSize().height + ')');
}
async function js(win, code) { return win.webContents.executeJavaScript(code, true); }

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  fs.mkdirSync(OUT, { recursive: true });

  const html = fs.readFileSync(DEMO, 'utf8');
  http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); }).listen(PORT);

  const win = new BrowserWindow({
    width: 640, height: 1100, frame: false, transparent: true, resizable: false,
    backgroundColor: '#00000000', show: true,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      preload: path.join(ROOT, 'src', 'preload', 'shell-preload.js'),
      webviewTag: true, backgroundThrottling: false,
    },
  });
  ipc.setWindow(win);
  ipc.init({ selftest: true });
  // In this ad-hoc harness app.getVersion() is Electron's version, not the
  // app's — override the sync channel so Settings shows the real app version.
  const APPVER = require(path.join(ROOT, 'package.json')).version;
  require('electron').ipcMain.removeAllListeners('app:version');
  require('electron').ipcMain.on('app:version', (e) => { e.returnValue = APPVER; });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html')).catch((e) => console.error('load', e.message));
  await delay(1600);

  // 1) iPhone home screen (cropped hero)
  save(cropPhone(await shot(win), await phoneRect(win)), 'hero.png');

  // 2) open the demo site in Safari, wait for the real page load
  await js(win, `window.DP && DP.chrome && DP.chrome.open('safari', { url: 'http://localhost:${PORT}/' })`);
  await delay(4200);
  save(cropPhone(await shot(win), await phoneRect(win)), 'site.png');
  save(await shot(win), 'workspace.png');

  // 3) settings → about / check for updates (rail buttons open on mousedown)
  await js(win, `(() => { const b = document.getElementById('btn-settings');
    if (b) b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); })()`);
  await delay(500);
  save(await shot(win), 'settings.png');
  await js(win, `(() => { const p = document.getElementById('settings-popover'); if (p) p.hidden = true;
    const c = document.getElementById('click-catcher'); if (c) c.hidden = true; })()`);

  // 4) auto-update popup
  await js(win, `window.dpuDemo && window.dpuDemo('available')`);
  await delay(500);
  save(await shot(win), 'update.png');

  // 5) Android phone + tablet picker + tablet portrait/landscape
  try {
    await js(win, `window.dpuDemo && (document.getElementById('dpu-overlay').hidden = true)`);
    const switched = await js(win, `(() => {
      const b = document.getElementById('btn-device');
      if (b) b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      const kind = document.querySelector('.dev-kind[data-kind="phone"]'); if (kind) kind.click();
      const row = document.querySelector('.dev-row[data-id*="galaxy"]') || document.querySelector('.dev-row[data-id*="pixel"]');
      if (row) { row.click(); return row.getAttribute('data-id'); } return null;
    })()`);
    if (switched) { await delay(1500); save(cropPhone(await shot(win), await phoneRect(win)), 'android.png'); console.log('android device: ' + switched); }

    await js(win, `(() => {
      const b = document.getElementById('btn-device');
      if (b) b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      const kind = document.querySelector('.dev-kind[data-kind="tablet"]'); if (kind) kind.click();
    })()`);
    await delay(500);
    save(await shot(win), 'tablet-picker.png');

    const tablet = await js(win, `(() => {
      const row = document.querySelector('.dev-row[data-id="galaxy-tab-s11-ultra"]');
      if (row) { row.click(); return row.getAttribute('data-id'); } return null;
    })()`);
    if (tablet) {
      await delay(1200);
      save(cropPhone(await shot(win), await phoneRect(win)), 'tablet-portrait.png');
      await js(win, `document.getElementById('btn-rotate').click()`);
      await delay(1200);
      save(cropPhone(await shot(win), await phoneRect(win)), 'tablet-landscape.png');
      console.log('tablet device: ' + tablet);
    }
  } catch (e) { console.error('android shot skipped:', e.message); }

  app.exit(0);
});
