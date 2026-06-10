'use strict';

/*
 * screenshot.js — shot({mode}) per contract.
 *  - mode 'screen': page only — capturePage of the screen webview
 *    (chromium) or the latest WebKit frame converted to PNG (webkit).
 *  - mode 'device': whole phone — capturePage of the shell window.
 * Saves PNG to the user's Pictures/DevPhone folder (mkdir -p), copies the
 * image to the clipboard, returns {ok, path}.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, clipboard, nativeImage } = require('electron');

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  );
}

function picturesDir() {
  // %USERPROFILE%/Pictures/DevPhone — via app.getPath so OneDrive-redirected
  // Pictures folders resolve correctly; plain homedir fallback otherwise.
  let base;
  try { base = app.getPath('pictures'); } catch (e) {}
  if (!base) base = path.join(os.homedir(), 'Pictures');
  return path.join(base, 'DevPhone');
}

async function shot(options) {
  const mode = (options && options.mode) || 'screen';
  const state = options && options.state;
  const webkit = options && options.webkit;
  try {
    let image = null;

    if (mode === 'device') {
      const win = state && state.shellWindow;
      if (!win || win.isDestroyed()) return { ok: false, error: 'no shell window' };
      image = await win.webContents.capturePage();
    } else if (mode === 'screen') {
      if (state && state.engineMode === 'webkit' && webkit && webkit.isActive()) {
        // fresh full-resolution capture; fall back to the latest stream frame
        const full = await webkit.captureFull();
        const buf = full || webkit.getLastFrame();
        if (!buf) return { ok: false, error: 'no webkit frame available yet' };
        image = nativeImage.createFromBuffer(buf);
      } else if (state && state.screenWC && !state.screenWC.isDestroyed()) {
        image = await state.screenWC.capturePage();
      } else {
        return { ok: false, error: 'nothing to capture (no screen attached)' };
      }
    } else {
      return { ok: false, error: 'unknown shot mode: ' + mode };
    }

    if (!image || image.isEmpty()) return { ok: false, error: 'capture produced an empty image' };

    const dir = picturesDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'devphone-' + timestamp() + '.png');
    fs.writeFileSync(file, image.toPNG());

    try { clipboard.writeImage(image); } catch (e) {}

    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { shot };
