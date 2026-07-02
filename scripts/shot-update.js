'use strict';

/*
 * shot-update.js — screenshot the auto-update popup in the REAL shell, at each
 * stage, so the UX can be eyeballed without cutting a release. Loads the actual
 * renderer + preload + IPC, forces window.dpuDemo(stage), captures the window.
 *
 *   npx electron scripts/shot-update.js [outDir]
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'scratch');
const STAGES = ['available', 'progress', 'done'];

const ipc = require(path.join(ROOT, 'src', 'main', 'ipc'));

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: 620, height: 1060,
    frame: false, transparent: true, resizable: false,
    backgroundColor: '#00000000', show: true,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      preload: path.join(ROOT, 'src', 'preload', 'shell-preload.js'),
      webviewTag: true, backgroundThrottling: false,
    },
  });
  ipc.setWindow(win);
  ipc.init({ selftest: true });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html')).catch((e) => {
    console.error('loadFile failed:', e && e.message);
  });
  await delay(1200); // let the shell paint the phone + overlay build

  for (const stage of STAGES) {
    await win.webContents.executeJavaScript('window.dpuDemo && window.dpuDemo(' + JSON.stringify(stage) + ')', true);
    // 'done' animates confetti — grab a lively frame mid-burst
    await delay(stage === 'done' ? 650 : 450);
    try { win.setAlwaysOnTop(true); win.show(); win.focus(); } catch (e) {}
    await delay(250);
    let img = await win.webContents.capturePage();
    if (img.isEmpty()) { await delay(500); img = await win.webContents.capturePage(); }
    const out = path.join(OUT, 'dpu-' + stage + '.png');
    fs.writeFileSync(out, img.toPNG());
    console.log('wrote ' + out + ' (' + img.getSize().width + 'x' + img.getSize().height + ')');
  }

  app.exit(0);
});
