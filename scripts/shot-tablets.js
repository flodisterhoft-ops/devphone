'use strict';

/* Capture the tablet picker plus Galaxy Tab portrait/landscape README images
 * from the real DevPhone shell.
 *
 *   npx electron scripts/shot-tablets.js [outDir]
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, Menu } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'assets');
const ipc = require(path.join(ROOT, 'src', 'main', 'ipc'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try { app.setPath('userData', path.join(os.tmpdir(), 'devphone-tablet-shots-' + process.pid)); } catch (e) {}

async function capture(win) {
  try { win.show(); win.focus(); } catch (e) {}
  await delay(250);
  let image = await win.webContents.capturePage();
  if (image.isEmpty()) { await delay(400); image = await win.webContents.capturePage(); }
  return image;
}

async function deviceRect(win) {
  return win.webContents.executeJavaScript(`(() => {
    const r = document.getElementById('phone').getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height, dpr: devicePixelRatio || 1 };
  })()`, true);
}

function cropDevice(image, rect) {
  const dpr = rect.dpr;
  const size = image.getSize();
  const left = 34, top = 30, right = 0, bottom = 34;
  const x = Math.max(0, Math.round((rect.x - left) * dpr));
  const y = Math.max(0, Math.round((rect.y - top) * dpr));
  const width = Math.min(size.width - x, Math.round((rect.width + left + right) * dpr));
  const height = Math.min(size.height - y, Math.round((rect.height + top + bottom) * dpr));
  return image.crop({ x, y, width, height });
}

function save(image, name) {
  const target = path.join(OUT, name);
  fs.writeFileSync(target, image.toPNG());
  const size = image.getSize();
  console.log('wrote ' + target + ' (' + size.width + 'x' + size.height + ')');
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  fs.mkdirSync(OUT, { recursive: true });

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
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await delay(1200);

  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('btn-device').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.querySelector('.dev-kind[data-kind="tablet"]').click();
  })()`, true);
  await delay(350);
  save(await capture(win), 'tablet-picker.png');

  await win.webContents.executeJavaScript(`document.querySelector('.dev-row[data-id="galaxy-tab-s11-ultra"]').click()`, true);
  await delay(900);
  await win.webContents.executeJavaScript(`document.getElementById('toasts').innerHTML = ''`, true);
  save(cropDevice(await capture(win), await deviceRect(win)), 'tablet-portrait.png');

  await win.webContents.executeJavaScript(`document.getElementById('btn-rotate').click()`, true);
  await delay(900);
  await win.webContents.executeJavaScript(`document.getElementById('toasts').innerHTML = ''`, true);
  save(cropDevice(await capture(win), await deviceRect(win)), 'tablet-landscape.png');

  app.exit(0);
}).catch((err) => { console.error(err); app.exit(1); });
