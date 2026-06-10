'use strict';

/*
 * main.js — app lifecycle, shell window, --selftest.
 *
 * PLAYWRIGHT_BROWSERS_PATH is set FIRST (before anything could require
 * playwright): <root>/pw-browsers in dev, resourcesPath/pw-browsers when
 * packaged — so installs carry their own WebKit.
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu } = require('electron');

const ROOT = path.join(__dirname, '..', '..');

process.env.PLAYWRIGHT_BROWSERS_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'pw-browsers')
  : path.join(ROOT, 'pw-browsers');

const ipc = require('./ipc');
const webkit = require('./webkit');

// ---------- argv ----------

const argv = process.argv.slice(1);
const SELFTEST = argv.includes('--selftest');
let selftestUrl = 'https://example.com';
if (SELFTEST) {
  const next = argv[argv.indexOf('--selftest') + 1];
  if (next && !/^-/.test(next)) selftestUrl = next;
}

// ---------- single instance (skipped for selftest runs) ----------

if (!SELFTEST) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      const win = ipc.getState().shellWindow;
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });
  }
}

// ---------- shell window ----------

function rendererFile() {
  // The real shell UI; falls back to the scratch test renderer so the main
  // process (and --selftest) can be exercised before the UI half exists.
  const real = path.join(ROOT, 'src', 'renderer', 'index.html');
  if (fs.existsSync(real)) return 'src/renderer/index.html';
  const scratch = path.join(ROOT, 'scratch', 'test-renderer.html');
  if (fs.existsSync(scratch)) return 'scratch/test-renderer.html';
  return null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 620,
    height: 1060,
    frame: false,
    transparent: true,
    resizable: false,
    backgroundColor: '#00000000',
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs path/url modules
      preload: path.join(__dirname, '..', 'preload', 'shell-preload.js'),
      webviewTag: true,
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);

  const file = rendererFile();
  if (!file) {
    console.error('No renderer found (src/renderer/index.html missing and no scratch fallback).');
    if (SELFTEST) {
      console.error('SELFTEST FAIL no renderer to load');
      app.exit(1);
      return win;
    }
  } else {
    // Note: space-separated values (--st-device foo) get mangled somewhere in
    // the npx/Git-Bash chain on Windows and crash Electron at startup; only
    // the --flag=value form is reliable, so that's what we parse.
    const argValue = (flag) => {
      const eq = argv.find((a) => a.startsWith(flag + '='));
      if (eq) return eq.slice(flag.length + 1);
      const i = argv.indexOf(flag);
      return (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-')) ? argv[i + 1] : null;
    };
    const selftestQuery = { selftest: selftestUrl };
    const dev = argValue('--st-device');
    if (dev) selftestQuery.device = dev;
    const eng = argValue('--st-engine');
    if (eng) selftestQuery.engine = eng;
    const opts = SELFTEST ? { query: selftestQuery } : undefined;
    win.loadFile(file, opts).catch((e) => {
      console.error('loadFile failed:', e && e.message);
      if (SELFTEST) {
        console.error('SELFTEST FAIL ' + ((e && e.message) || e));
        app.exit(1);
      }
    });
  }

  win.on('closed', () => {
    if (ipc.getState().shellWindow === win) ipc.setWindow(null);
  });

  return win;
}

// ---------- selftest ----------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs, stepMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await delay(stepMs || 200);
  }
}

async function runSelftest(win) {
  // hard watchdog: a hung engine/capture must never leave a zombie process
  setTimeout(() => {
    console.error('SELFTEST FAIL watchdog timeout');
    try { process.exit(1); } catch (_) {}
  }, 90 * 1000).unref();
  try {
    // pipe the shell renderer's console so integration failures are visible
    win.webContents.on('console-message', (...args) => {
      const msg = typeof args[1] === 'object' && args[1] ? args[1].message : args[2];
      console.log('[renderer]', msg);
    });
    await new Promise((resolve) => {
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve);
      else resolve();
    });

    // contract: wait 5s for the webview page to settle
    await delay(5000);

    // diagnostics: shell renderer state (webview present? devphone bridge?)
    try {
      const shellState = await win.webContents.executeJavaScript(
        '(function(){ var p = document.getElementById("page");' +
        ' var wcid = null; try { wcid = p ? p.getWebContentsId() : null; } catch (e) { wcid = "ERR:" + e.message; }' +
        ' return { hasDevphone: !!window.devphone, hasPage: !!p, tag: p && p.tagName,' +
        '  preloadAttr: p ? String(p.getAttribute("preload")).slice(0, 60) : null, wcid: wcid,' +
        '  src: p ? p.getAttribute("src") : null }; })()', true);
      console.log('SELFTEST SHELL ' + JSON.stringify(shellState));
    } catch (e) {
      console.log('SELFTEST SHELL eval failed: ' + (e && e.message));
    }

    // make sure the renderer actually attached the screen webview
    const state = ipc.getState();
    await waitFor(() => state.screenWC && !state.screenWC.isDestroyed(), 5000);
    if (state.screenWC && !state.screenWC.isDestroyed() && state.screenWC.isLoading()) {
      await waitFor(() => !state.screenWC.isLoading(), 8000);
      await delay(500);
    }

    // evidence: emulation really applied inside the page
    let info = null;
    if (state.screenWC && !state.screenWC.isDestroyed()) {
      try {
        info = await state.screenWC.executeJavaScript(
          '({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio,' +
          ' ua: navigator.userAgent, platform: navigator.platform,' +
          ' touch: navigator.maxTouchPoints, standalone: navigator.standalone, url: location.href })', true);
      } catch (e) {
        console.error('selftest evidence eval failed:', e && e.message);
      }
    }
    if (info) {
      console.log('SELFTEST INFO innerWidth=' + info.w + ' innerHeight=' + info.h +
        ' dpr=' + info.dpr + ' platform=' + info.platform + ' maxTouchPoints=' + info.touch +
        ' standalone=' + info.standalone);
      console.log('SELFTEST INFO ua=' + info.ua);
      console.log('SELFTEST INFO url=' + info.url);
    } else {
      console.log('SELFTEST INFO no screen webview attached (renderer may not wire one)');
    }

    // whole window - force it frontmost + freshly painted first, otherwise
    // capturePage can return an empty image for transparent windows.
    try { win.setAlwaysOnTop(true); win.show(); win.focus(); } catch (_) {}
    await delay(600);
    let winImage = await win.webContents.capturePage();
    if (winImage.isEmpty()) { await delay(1000); winImage = await win.webContents.capturePage(); }
    const outPath = path.join(process.cwd(), 'selftest.png');
    fs.writeFileSync(outPath, winImage.toPNG());

    // just the webview contents
    if (state.screenWC && !state.screenWC.isDestroyed()) {
      try {
        const screenImage = await state.screenWC.capturePage();
        fs.writeFileSync(path.join(process.cwd(), 'selftest-screen.png'), screenImage.toPNG());
      } catch (e) {
        console.error('selftest screen capture failed:', e && e.message);
      }
    }

    console.log('SELFTEST OK ./selftest.png');
    // stdout through npx/Git-Bash is unreliable on Windows - persist the
    // evidence to a file so harnesses can read results deterministically.
    try {
      fs.writeFileSync(path.join(process.cwd(), 'selftest.json'), JSON.stringify({
        ok: true,
        info,
        deviceArg: (argv.find((a) => a.startsWith('--st-device=')) || '').split('=')[1] || null,
        engineArg: (argv.find((a) => a.startsWith('--st-engine=')) || '').split('=')[1] || null,
        ts: new Date().toISOString(),
      }, null, 2));
    } catch (_) {}
    await Promise.race([
      webkit.shutdown().catch(() => {}),
      delay(5000),
    ]);
    app.exit(0);
    setTimeout(() => process.exit(0), 1500).unref(); // belt and braces
  } catch (e) {
    console.error('SELFTEST FAIL ' + ((e && e.stack) || e));
    app.exit(1);
  }
}

// ---------- lifecycle ----------

// Selftest runs use an isolated profile: a normal instance (or a zombie from
// a crashed run) holding the default userData lock would make us die silently.
if (SELFTEST) {
  try {
    app.setPath('userData', path.join(require('os').tmpdir(), 'devphone-selftest-' + process.pid));
  } catch (_) {}
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // no menu bar, ever

  ipc.init({ selftest: SELFTEST }); // handlers must exist before renderer runs
  const win = createWindow();
  ipc.setWindow(win);

  if (SELFTEST) runSelftest(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow();
      ipc.setWindow(w);
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  // Give Playwright WebKit a moment to die cleanly, then continue quitting.
  event.preventDefault();
  Promise.race([webkit.shutdown(), delay(2000)])
    .catch(() => {})
    .then(() => app.quit());
});
