'use strict';

/*
 * cloudupdate.js — GitHub-hosted auto-update (electron-updater) with our OWN
 * renderer UX instead of electron-updater's default dialogs.
 *
 * Flow (autoDownload OFF so we can show the changelog first):
 *   launch → checkForUpdates()
 *     → update-available   → renderer shows "What's new" popup + changelog
 *     → user clicks Update  → downloadUpdate() → download-progress → progress bar
 *     → update-downloaded   → renderer plays the celebration, offers Restart
 *     → user clicks Restart → quitAndInstall() (silent per-user NSIS, relaunch)
 *
 * Every electron-updater event is funneled to the renderer as a single
 * 'appupdate:event' {type, ...}. autoInstallOnAppQuit stays ON as a safety net:
 * if a download finished, closing the app applies it even without a click.
 *
 * Reads its feed from the app-update.yml electron-builder bakes in from the
 * `publish` config (github → flodisterhoft-ops/devphone-releases). No-ops in an
 * unpackaged dev run (no app-update.yml) unless DEVPHONE_FORCE_UPDATE is set.
 * Nothing here can throw across the boundary or break app boot.
 */

const path = require('path');
const fs = require('fs');
const { app, ipcMain } = require('electron');

let inited = false;
let send = () => {};
let autoUpdater = null;
let downloading = false;

function post(type, extra) {
  try { send('appupdate:event', Object.assign({ type }, extra || {})); } catch (e) {}
}

// Minimal file logger (userData/update.log) so update behaviour is diagnosable
// on any machine without a console — electron-updater logs its whole lifecycle.
function fileLogger() {
  let logPath = '';
  try { logPath = path.join(app.getPath('userData'), 'update.log'); } catch (e) {}
  const write = (level, args) => {
    if (!logPath) return;
    try {
      fs.appendFileSync(logPath, '[' + new Date().toISOString() + '] ' + level + ' ' +
        Array.prototype.map.call(args, String).join(' ') + '\n');
    } catch (e) {}
  };
  return {
    info() { write('INFO', arguments); },
    warn() { write('WARN', arguments); },
    error() { write('ERROR', arguments); },
    debug() {},
  };
}

// releaseNotes is a string (single release) or [{version, note}] (fullChangelog).
function normalizeNotes(notes) {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) return notes.map((n) => (n && n.note) || '').join('\n\n');
  return String(notes);
}

function init(opts) {
  if (inited) return;
  send = (opts && opts.send) || (() => {});
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    // electron-updater missing (shouldn't happen in a packaged build) — stay quiet.
    return;
  }
  inited = true;

  autoUpdater.autoDownload = false;        // we gate download behind the popup
  autoUpdater.autoInstallOnAppQuit = true; // safety net once a download exists
  try { autoUpdater.logger = fileLogger(); } catch (e) {}

  // Test hook: pretend to be an older version so a check finds the current
  // release (verifies the real GitHub feed without waiting for a newer build).
  if (process.env.DEVPHONE_UPDATE_TESTVER) {
    try { autoUpdater.currentVersion = process.env.DEVPHONE_UPDATE_TESTVER; } catch (e) {}
  }

  autoUpdater.on('checking-for-update', () => post('checking'));
  autoUpdater.on('update-available', (info) => post('available', {
    version: info && info.version,
    notes: normalizeNotes(info && info.releaseNotes),
    date: info && info.releaseDate,
  }));
  autoUpdater.on('update-not-available', (info) => post('none', {
    version: info && info.version,
  }));
  autoUpdater.on('download-progress', (p) => post('progress', {
    percent: Math.max(0, Math.min(100, (p && p.percent) || 0)),
    transferred: p && p.transferred,
    total: p && p.total,
    bytesPerSecond: p && p.bytesPerSecond,
  }));
  autoUpdater.on('update-downloaded', (info) => {
    downloading = false;
    post('downloaded', { version: info && info.version });
  });
  autoUpdater.on('error', (err) => {
    downloading = false;
    post('error', { message: String((err && err.message) || err) });
  });

  ipcMain.handle('appupdate:check', async () => safeCheck());

  ipcMain.handle('appupdate:download', async () => {
    if (!autoUpdater) return { ok: false, error: 'no updater' };
    if (downloading) return { ok: true, already: true };
    downloading = true;
    try {
      autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (e) {
      downloading = false;
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('appupdate:install', async () => {
    if (!autoUpdater) return { ok: false, error: 'no updater' };
    // Defer so the IPC reply is delivered before the app tears down.
    setImmediate(() => { try { autoUpdater.quitAndInstall(false, true); } catch (e) {} });
    return { ok: true };
  });
}

function safeCheck() {
  if (!autoUpdater) return { ok: false, error: 'no updater' };
  if (!app.isPackaged && !process.env.DEVPHONE_FORCE_UPDATE) {
    // Unpackaged dev run has no app-update.yml — don't let electron-updater throw.
    post('none', { dev: true });
    return { ok: true, dev: true };
  }
  try {
    autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    post('error', { message: String((e && e.message) || e) });
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { init, check: safeCheck };
