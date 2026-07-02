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
const { app, BrowserWindow, Menu, shell, session } = require('electron');
const { fileURLToPath } = require('url');

const ROOT = path.join(__dirname, '..', '..');

// Match real-phone media behavior: pages may autoplay only MUTED video;
// audible playback needs a user gesture. Electron's default
// ('no-user-gesture-required') let any site blast audio on load.
app.commandLine.appendSwitch('autoplay-policy', 'user-gesture-required');

// v0.1.2: parallel-safe test plumbing — an explicit userData dir (Playwright-
// Electron harnesses give each instance its own) MUST be set before 'ready'.
if (process.env.DEVPHONE_USERDATA) {
  try { app.setPath('userData', process.env.DEVPHONE_USERDATA); } catch (e) {
    console.error('[main] DEVPHONE_USERDATA setPath failed:', e && e.message);
  }
}

process.env.PLAYWRIGHT_BROWSERS_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'pw-browsers')
  : path.join(ROOT, 'pw-browsers');

// Windows taskbar identity. A frameless Electron app without an explicit
// AppUserModelID can be grouped under a generic host and show the wrong icon;
// pinning it to the electron-builder appId gives the running app, its taskbar
// button and any pinned shortcut one identity + the phone icon.
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.devphone.app'); } catch (e) {}
}

// Shipped inside the asar (src/**/*); used as the BrowserWindow/taskbar icon so
// the phone shows even before the exe's embedded icon would apply.
const APP_ICON = path.join(ROOT, 'src', 'assets', 'icon.png');

const ipc = require('./ipc');
const webkit = require('./webkit');

// ---------- argv ----------

const argv = process.argv.slice(1);
const SELFTEST = argv.includes('--selftest');
let selftestUrl = 'https://example.com';
function argValue(flag) {
  const eq = argv.find((a) => a.startsWith(flag + '='));
  if (eq) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-')) ? argv[i + 1] : null;
}
if (SELFTEST) {
  const next = argv[argv.indexOf('--selftest') + 1];
  if (next && !/^-/.test(next)) selftestUrl = next;
}

// ---------- security guardrails ----------

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function openExternalHttp(url) {
  if (isHttpUrl(url)) shell.openExternal(url).catch(() => {});
}

function expectedScreenPreload() {
  return path.join(__dirname, '..', 'preload', 'screen-preload.js');
}

function filePathFromMaybeUrl(value) {
  if (!value) return '';
  try {
    const s = String(value);
    if (/^file:/i.test(s)) return fileURLToPath(s);
    return path.resolve(s);
  } catch (e) {
    return '';
  }
}

function samePath(a, b) {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

function installWebContentsGuards() {
  app.on('web-contents-created', (_event, contents) => {
    try {
      contents.setWindowOpenHandler(({ url }) => {
        openExternalHttp(url);
        return { action: 'deny' };
      });
    } catch (e) {}

    contents.on('will-navigate', (event, url) => {
      try {
        // The shell renderer is local UI and should never be navigated away.
        // Guest webviews are the actual browser surface and keep normal nav.
        if (contents.getType && contents.getType() === 'window' && !/^file:/i.test(String(url || ''))) {
          event.preventDefault();
          openExternalHttp(url);
        }
      } catch (e) {}
    });

    contents.on('will-attach-webview', (event, webPreferences, params) => {
      const actualPreload = filePathFromMaybeUrl(params.preloadURL || webPreferences.preload);
      if (!samePath(actualPreload, expectedScreenPreload())) {
        console.warn('[security] blocked webview with unexpected preload:', params.preloadURL || webPreferences.preload);
        event.preventDefault();
        return;
      }

      params.partition = 'persist:devphone';
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.nodeIntegrationInWorker = false;
      webPreferences.contextIsolation = false; // intentional: iOS globals must be patched in page world
      webPreferences.sandbox = false; // preload needs require('electron') for sync config seeding
      webPreferences.webSecurity = true;
      webPreferences.allowRunningInsecureContent = false;
      webPreferences.plugins = false;
      webPreferences.experimentalFeatures = false;
    });
  });
}

function configureSessionSecurity() {
  const sessions = [session.fromPartition('persist:devphone')];
  for (const ses of sessions) {
    try {
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    } catch (e) {}
    try {
      if (typeof ses.setPermissionCheckHandler === 'function') {
        ses.setPermissionCheckHandler(() => false);
      }
    } catch (e) {}
  }
}

installWebContentsGuards();

function cancelTaskbarFlash(win) {
  if (process.platform !== 'win32') return;
  try {
    if (win && !win.isDestroyed() && typeof win.flashFrame === 'function') {
      win.flashFrame(false);
    }
  } catch (e) {}
}

function settleTaskbarAttention(win) {
  if (process.platform !== 'win32') return;
  cancelTaskbarFlash(win);
  [120, 600, 1600].forEach((ms) => {
    const timer = setTimeout(() => cancelTaskbarFlash(win), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
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
        settleTaskbarAttention(win);
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
    icon: APP_ICON,
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
  win.on('show', () => settleTaskbarAttention(win));
  win.on('focus', () => settleTaskbarAttention(win));
  settleTaskbarAttention(win);

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

    const state = ipc.getState();

    // make sure the renderer actually attached the screen webview
    await waitFor(() => state.screenWC && !state.screenWC.isDestroyed(), 5000);
    if (state.screenWC && !state.screenWC.isDestroyed() && state.screenWC.isLoading()) {
      await waitFor(() => !state.screenWC.isLoading(), 8000);
      await delay(500);
    }

    const requestedEngine = argValue('--st-engine') || 'chromium';
    if (requestedEngine === 'webkit') {
      const active = await waitFor(() => state.engineMode === 'webkit' && webkit.isActive(), 20000, 250);
      if (!active) {
        throw new Error('requested WebKit selftest but WebKit did not become active');
      }
      await delay(500);
    }

    // evidence: emulation really applied inside the page
    let info = null;
    if (state.engineMode === 'webkit' && webkit.isActive()) {
      info = await webkit.getEvidence();
    } else if (state.screenWC && !state.screenWC.isDestroyed()) {
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
      console.log('SELFTEST INFO engine=' + (info.engine || state.engineMode) +
        ' innerWidth=' + info.w + ' innerHeight=' + info.h +
        ' dpr=' + info.dpr + ' platform=' + info.platform + ' maxTouchPoints=' + info.touch +
        ' standalone=' + info.standalone);
      console.log('SELFTEST INFO ua=' + info.ua);
      console.log('SELFTEST INFO url=' + info.url);
    } else {
      console.log('SELFTEST INFO no screen webview attached (renderer may not wire one)');
    }

    // whole window - force it frontmost + freshly painted first, otherwise
    // capturePage can return an empty image for transparent windows.
    const tCap = Date.now();
    try { win.setAlwaysOnTop(true); win.show(); win.focus(); } catch (_) {}
    await delay(600);
    let winImage = await win.webContents.capturePage();
    if (winImage.isEmpty()) { await delay(1000); winImage = await win.webContents.capturePage(); }
    const outPath = path.join(process.cwd(), 'selftest.png');
    fs.writeFileSync(outPath, winImage.toPNG());
    console.log('SELFTEST TIMING window capture took ' + (Date.now() - tCap) + 'ms');

    // just the screen contents. WebKit engine: the webview is hidden
    // (renderer CSS) and capturePage on a hidden webContents never resolves —
    // take the evidence from the engine instead, and keep the chromium path
    // bounded by a timeout so the selftest can never hang here.
    try {
      const tScreen = Date.now();
      const screenPath = path.join(process.cwd(), 'selftest-screen.png');
      if (state.engineMode === 'webkit') {
        const buf = (await webkit.captureFull()) || webkit.getLastFrame();
        if (buf) fs.writeFileSync(screenPath, buf);
      } else if (state.screenWC && !state.screenWC.isDestroyed()) {
        const screenImage = await Promise.race([state.screenWC.capturePage(), delay(10000)]);
        if (screenImage && !screenImage.isEmpty()) fs.writeFileSync(screenPath, screenImage.toPNG());
        else console.error('selftest screen capture empty/timed out');
      }
      console.log('SELFTEST TIMING screen capture took ' + (Date.now() - tScreen) + 'ms');
    } catch (e) {
      console.error('selftest screen capture failed:', e && e.message);
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
        engineMode: state.engineMode,
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
// An explicit DEVPHONE_USERDATA (set above) takes precedence over the tmp dir.
if (SELFTEST && !process.env.DEVPHONE_USERDATA) {
  try {
    app.setPath('userData', path.join(require('os').tmpdir(), 'devphone-selftest-' + process.pid));
  } catch (_) {}
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // no menu bar, ever
  configureSessionSecurity();

  ipc.init({ selftest: SELFTEST }); // handlers must exist before renderer runs
  const win = createWindow();
  ipc.setWindow(win);

  if (SELFTEST) runSelftest(win);

  // v0.1.6: cloud auto-update — packaged installs check the GitHub releases
  // feed and drive the custom in-app update UX (changelog → progress →
  // celebration → restart). No-op in dev/selftest and on portable builds.
  // (Supersedes the v0.1.5 local dist/ self-update; selfupdate.js is retained
  // but no longer wired.)
  if (!SELFTEST) {
    try {
      const cloudupdate = require('./cloudupdate');
      cloudupdate.init({ send: ipc.send });
      // Let the renderer subscribe to appupdate:event before the first check.
      setTimeout(() => { try { cloudupdate.check(); } catch (e) {} }, 3000);
    } catch (e) {}
  }

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
