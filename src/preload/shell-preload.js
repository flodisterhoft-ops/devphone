'use strict';

/*
 * shell-preload.js — exposes window.devphone to the shell renderer
 * (contextIsolation:true). Generic invoke/on plus named convenience
 * wrappers for every channel in the contract. on() returns an unsubscribe
 * function.
 */

const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const INVOKE_CHANNELS = [
  'devices:list',
  'screen:attach',
  'device:set',
  'engine:set',
  'nav',
  'standalone:set',
  'picker:toggle',
  'shot',
  'pwa:manifest',
  'updater:check',
  'devices:dismiss', // extension: hide an auto-discovered device
  'webkit:input',
  'input:set', // v0.1.1: 'touch' | 'mouse'
  'shell:activate', // v0.1.1: focus the OS window before a click lands
  'shell:resize',
  'shell:alwaysOnTop', // v0.1.3: window pinning
  'shell:minimize',
  'shell:close',
  'open:external',
];

const EVENT_CHANNELS = [
  'webkit:frame',
  'picker:result',
  'devices:new',
  'page:meta',
  'page:scroll',
];

function invoke(channel, payload) {
  if (!INVOKE_CHANNELS.includes(channel)) {
    return Promise.resolve({ ok: false, error: 'unknown channel: ' + channel });
  }
  return ipcRenderer.invoke(channel, payload);
}

function on(channel, callback) {
  if (!EVENT_CHANNELS.includes(channel) || typeof callback !== 'function') {
    return function unsubscribeNoop() {};
  }
  const listener = (_event, payload) => {
    try { callback(payload); } catch (e) { /* renderer callback error */ }
  };
  ipcRenderer.on(channel, listener);
  return function unsubscribe() {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api = {
  // generic
  invoke,
  on,

  // renderer → main conveniences
  devicesList: () => invoke('devices:list'),
  screenAttach: (webContentsId) => invoke('screen:attach', { webContentsId }),
  // v0.1.1: optional second arg {width,height} — content-viewport override
  // (page laid out between the bars); omit it to restore the full viewport.
  deviceSet: (deviceId, viewport) => invoke('device:set', { deviceId, viewport }),
  engineSet: (mode) => invoke('engine:set', { mode }),
  nav: (action, url) => invoke('nav', { action, url }),
  standaloneSet: (onFlag, themeColor) => invoke('standalone:set', { on: onFlag, themeColor }),
  pickerToggle: (onFlag) => invoke('picker:toggle', { on: onFlag }),
  shot: (mode) => invoke('shot', { mode }),
  pwaManifest: (pageUrl) => invoke('pwa:manifest', { pageUrl }),
  updaterCheck: () => invoke('updater:check'),
  devicesDismiss: (id) => invoke('devices:dismiss', { id }),
  webkitInput: (input) => invoke('webkit:input', input),
  inputSet: (mode) => invoke('input:set', { mode }), // v0.1.1: 'touch' | 'mouse'
  shellActivate: () => invoke('shell:activate'), // v0.1.1: first-click fix
  shellResize: (width, height) => invoke('shell:resize', { width, height }),
  shellAlwaysOnTop: (onFlag) => invoke('shell:alwaysOnTop', { on: onFlag }), // v0.1.3

  shellMinimize: () => invoke('shell:minimize'),
  shellClose: () => invoke('shell:close'),
  openExternal: (url) => invoke('open:external', { url }),

  // main → renderer conveniences
  onWebkitFrame: (cb) => on('webkit:frame', cb),
  onPickerResult: (cb) => on('picker:result', cb),
  onDevicesNew: (cb) => on('devices:new', cb),
  onPageMeta: (cb) => on('page:meta', cb),
  onPageScroll: (cb) => on('page:scroll', cb),

  // The <webview preload=...> attribute needs a file: URL to the screen
  // preload — the renderer can't compute absolute paths itself.
  screenPreloadPath: pathToFileURL(path.join(__dirname, 'screen-preload.js')).href,
};

contextBridge.exposeInMainWorld('devphone', api);
