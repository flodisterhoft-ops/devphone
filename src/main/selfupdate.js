'use strict';

/*
 * selfupdate.js — launch-time update offer for INSTALLED builds (v0.1.5).
 *
 * There is no update server: builds are produced locally by `npm run dist`.
 * Each build is stamped (scripts/stamp-build.js) with its build time and the
 * project directory it came from; the build step also writes
 * <projectDir>/dist/latest-build.json (scripts/local-publish.js).
 *
 * On launch, a packaged NSIS install compares its own stamp against that
 * manifest. If a newer build exists, a native dialog offers "Install now":
 * the setup exe is spawned silently with --force-run (the same flags
 * electron-updater uses — the NSIS script closes the running app, installs,
 * and relaunches the new build), then this instance quits.
 *
 * Silent no-ops, by design: dev runs (`electron .`), portable exes
 * (PORTABLE_EXECUTABLE_FILE set — nothing to reinstall over), selftest,
 * missing/moved project dir, malformed manifests, same-or-older builds.
 * Everything is wrapped — an update check must never break app boot.
 * On Windows, the prompt is foreground-only so launch checks cannot flash
 * the taskbar for attention while DevPhone is in the background.
 */

const path = require('path');
const fs = require('fs');
const { app, dialog } = require('electron');
const { spawn } = require('child_process');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function fmt(ts, iso) {
  try { return new Date(iso || ts).toLocaleString(); } catch (e) { return String(iso || ts); }
}

// Returns {mine, latest} when a strictly newer installable build exists.
function findUpdate() {
  if (!app.isPackaged) return null;                       // dev run
  if (process.env.PORTABLE_EXECUTABLE_FILE) return null;  // portable exe
  const mine = readJson(path.join(app.getAppPath(), 'build-info.json'));
  if (!mine || !mine.buildTime || !mine.projectDir) return null; // pre-v0.1.5 build
  const latest = readJson(path.join(mine.projectDir, 'dist', 'latest-build.json'));
  if (!latest || !latest.buildTime || !latest.setup) return null;
  if (latest.buildTime <= mine.buildTime) return null;
  if (!fs.existsSync(latest.setup)) return null;
  return { mine, latest };
}

function installAndRestart(setupPath) {
  try {
    // electron-updater's exact recipe: silent NSIS install + relaunch.
    const child = spawn(setupPath, ['/S', '--force-run'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (e) {
    console.error('[selfupdate] failed to launch installer:', e && e.message);
    return;
  }
  setTimeout(() => { try { app.quit(); } catch (e) {} }, 250);
}

function cancelTaskbarFlash(win) {
  if (process.platform !== 'win32') return;
  try {
    if (win && !win.isDestroyed() && typeof win.flashFrame === 'function') {
      win.flashFrame(false);
    }
  } catch (e) {}
}

function canShowPrompt(win) {
  if (!win || win.isDestroyed()) return false;
  if (!win.isVisible() || win.isMinimized()) return false;
  return process.platform !== 'win32' || win.isFocused();
}

// Call once after the shell window is up. Never throws.
function check(win) {
  let found = null;
  try { found = findUpdate(); } catch (e) { return; }
  if (!found) return;
  if (!canShowPrompt(win)) {
    cancelTaskbarFlash(win);
    return;
  }
  cancelTaskbarFlash(win);
  const opts = {
    type: 'info',
    title: 'DevPhone update',
    message: 'A newer DevPhone build is available',
    detail:
      'Installed build:  ' + fmt(found.mine.buildTime, found.mine.builtAt) + '\n' +
      'Available build:  ' + fmt(found.latest.buildTime, found.latest.builtAt) + '\n\n' +
      'Install it and relaunch now?',
    buttons: ['Install now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const p = (win && !win.isDestroyed())
    ? dialog.showMessageBox(win, opts)
    : dialog.showMessageBox(opts);
  p.then((r) => {
    cancelTaskbarFlash(win);
    if (r && r.response === 0) installAndRestart(found.latest.setup);
  }).catch(() => {
    cancelTaskbarFlash(win);
  });
}

module.exports = { check, findUpdate };
