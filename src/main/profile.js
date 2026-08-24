'use strict';

/*
 * profile.js — independent DevPhone process profiles.
 *
 * Electron's single-instance lock and Chromium partitions are scoped by the
 * userData directory. A named profile therefore gets its own lock, cookies,
 * localStorage, WebKit storage state and window/attachment state while still
 * running the exact same installed executable.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function argValue(argv, flag) {
  const eq = argv.find((a) => String(a).startsWith(flag + '='));
  if (eq) return String(eq).slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return (i >= 0 && argv[i + 1] && !String(argv[i + 1]).startsWith('-'))
    ? String(argv[i + 1])
    : null;
}

function safeId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function safeName(value, fallback) {
  const name = String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
  return name || fallback;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

function configure(options) {
  const app = options.app;
  const argv = options.argv || [];
  const root = options.root;
  const defaultUserData = app.getPath('userData');
  const requestedId = safeId(argValue(argv, '--profile'));
  const isolatedByEnv = !!process.env.DEVPHONE_USERDATA;
  const id = requestedId || 'default';
  const isDefault = id === 'default';

  if (!isDefault && !isolatedByEnv) {
    app.setPath('userData', path.join(defaultUserData, 'profiles', id));
  }

  const userData = app.getPath('userData');
  const metaFile = path.join(userData, 'profile.json');
  const saved = readJson(metaFile, {});
  const fallbackName = isDefault ? 'DevPhone' : 'DevPhone profile';
  const name = safeName(argValue(argv, '--profile-name') || saved.name, fallbackName);
  const info = { id, name, isDefault, userData };

  // Test harnesses deliberately point DEVPHONE_USERDATA at temporary folders.
  // Keep them self-contained and do not create entries in the normal registry.
  writeJson(metaFile, { id, name, isDefault });

  function nextProfileNumber() {
    const profilesRoot = path.join(defaultUserData, 'profiles');
    let count = 0;
    try {
      count = fs.readdirSync(profilesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).length;
    } catch (e) {}
    return count + 2; // the default profile is phone 1
  }

  function launchNew(payload) {
    if (isolatedByEnv) {
      return { ok: false, error: 'New profiles are unavailable in an isolated test run.' };
    }
    const stamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 7);
    const newId = 'phone-' + stamp + '-' + random;
    const newName = safeName(payload && payload.name, 'DevPhone ' + nextProfileNumber());
    const args = [];
    if (!app.isPackaged) args.push(root);
    args.push('--profile=' + newId, '--profile-name=' + newName);

    try {
      const env = Object.assign({}, process.env);
      delete env.DEVPHONE_USERDATA;
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        env,
      });
      child.unref();
      return { ok: true, profile: { id: newId, name: newName, isDefault: false } };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  return {
    info,
    defaultUserData,
    launchNew,
  };
}

module.exports = { configure, argValue, safeId };
