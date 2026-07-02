'use strict';

/*
 * make-icon.js — turn build/icon.svg into the app icons, using the Electron
 * that already ships with this project (no ImageMagick / sharp / native deps).
 *
 * Renders the SVG onto an offscreen <canvas> at each target size (canvas 2D
 * keeps alpha exactly — unlike capturePage on a transparent window) and reads
 * back PNG bytes, then packs a multi-resolution Windows .ico by hand (the ICO
 * container is just a header + per-image directory entries + PNG payloads).
 *
 * Run:  npm run icon   (=> npx electron scripts/make-icon.js)
 * Out:  build/icon.ico            (electron-builder: exe + installer + shortcuts)
 *       build/icon.png  (512)     (master / general use)
 *       src/assets/icon.png (256) (runtime BrowserWindow icon — shipped in asar)
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'build', 'icon.svg'), 'utf8');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIco(images) {
  // images: [{ size, buf }] sorted however; ICONDIR + ICONDIRENTRY[] + payloads
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const payloads = [];
  images.forEach((img, i) => {
    const e = dir.subarray(i * 16, i * 16 + 16);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // width (0 => 256)
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 1); // height
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(img.buf.length, 8); // size of PNG payload
    e.writeUInt32LE(offset, 12); // offset of payload
    offset += img.buf.length;
    payloads.push(img.buf);
  });
  return Buffer.concat([header, dir, ...payloads]);
}

async function renderPng(win, size) {
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const svg = ${JSON.stringify(SVG)};
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    await img.decode();
    const c = document.createElement('canvas');
    c.width = ${size}; c.height = ${size};
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, ${size}, ${size});
    ctx.drawImage(img, 0, 0, ${size}, ${size});
    return c.toDataURL('image/png');
  })()`, true);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 300,
    height: 300,
    webPreferences: { offscreen: false, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL('data:text/html,<meta charset="utf-8"><body></body>');

  const buffers = {};
  for (const s of Array.from(new Set([...ICO_SIZES, 256, 512]))) {
    buffers[s] = await renderPng(win, s);
    console.log('  • rendered ' + s + 'px (' + buffers[s].length + ' bytes)');
  }

  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'src', 'assets'), { recursive: true });

  const ico = buildIco(ICO_SIZES.map((s) => ({ size: s, buf: buffers[s] })));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), buffers[512]);
  fs.writeFileSync(path.join(ROOT, 'src', 'assets', 'icon.png'), buffers[256]);

  console.log('  • wrote build/icon.ico (' + ico.length + ' bytes, ' + ICO_SIZES.length + ' sizes)');
  console.log('  • wrote build/icon.png (512), src/assets/icon.png (256)');
  app.exit(0);
});
