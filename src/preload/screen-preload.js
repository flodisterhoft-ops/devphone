'use strict';

/*
 * screen-preload.js — runs inside the <webview> (contextIsolation=no, so
 * this shares the page's JS context and can patch page globals directly).
 *
 * Race-safe design: shims are installed HERE, before any page script runs.
 * Static facts (platform, vendor, maxTouchPoints) are plain getters; the
 * one dynamic fact (navigator.standalone) reads window.__DEVPHONE_STANDALONE__
 * live — seeded synchronously below via ipcRenderer.sendSync and refreshed
 * by the main process (emulation.js) on dom-ready / standalone:set.
 *
 * iOS shims install ONLY when the UA contains 'iPhone' (the UA override is
 * already active at preload time). Single source of the shim code is
 * src/inject/ios-shims.js — require()'d when node is available (the module
 * auto-applies to the shared window), otherwise fetched as text from main
 * and evaluated.
 */

(function () {
  let ipcRenderer = null;
  try {
    ipcRenderer = require('electron').ipcRenderer;
  } catch (e) { /* no electron require — bridge features degrade below */ }

  // ---- seed config synchronously (before any page script) ----
  let cfg = { standalone: false, os: '', deviceId: '', deviceLabel: '' };
  try {
    if (ipcRenderer) {
      const fromMain = ipcRenderer.sendSync('screen:cfg');
      if (fromMain && typeof fromMain === 'object') cfg = Object.assign(cfg, fromMain);
    }
  } catch (e) {}

  try {
    if (typeof window.__DEVPHONE_STANDALONE__ === 'undefined') {
      window.__DEVPHONE_STANDALONE__ = !!cfg.standalone;
    }
    window.__DEVPHONE__ = Object.assign(window.__DEVPHONE__ || {}, cfg);
  } catch (e) {}

  // ---- iOS shims (gated on the active UA override) ----
  try {
    if (String(navigator.userAgent).indexOf('iPhone') !== -1) {
      let applied = false;
      // Preferred: require the module — it auto-applies to this window.
      try {
        const mod = require('path')
          ? require(require('path').join(__dirname, '..', 'inject', 'ios-shims.js'))
          : null;
        if (mod && typeof mod.applyIosShims === 'function') {
          applied = mod.applyIosShims(window);
        }
      } catch (e) {}
      // Fallback: pull the source from main and evaluate it here.
      if (!applied && ipcRenderer) {
        try {
          const src = ipcRenderer.sendSync('screen:shims');
          if (src) {
            (0, eval)(src); // eslint-disable-line no-eval — shim auto-applies
            applied = true;
          }
        } catch (e) {}
      }
      // Last resort: emulation.js re-injects the same shim source from the
      // main process on dom-ready, so a CSP-blocked eval still self-heals.
    }
  } catch (e) {}

  // ---- scroll reporter (every page, throttled ~10/s) ----
  try {
    if (!window.__DEVPHONE_SCROLL_INSTALLED__) {
      window.__DEVPHONE_SCROLL_INSTALLED__ = true;
      let last = 0;
      let pending = null;
      const report = function () {
        last = Date.now();
        pending = null;
        try {
          console.log('__DEVPHONE_SCROLL__' + JSON.stringify({ y: Math.round(window.scrollY || 0) }));
        } catch (e) {}
      };
      window.addEventListener('scroll', function () {
        const now = Date.now();
        if (now - last >= 100) report();
        else if (!pending) pending = setTimeout(report, 100 - (now - last));
      }, { passive: true, capture: true });
    }
  } catch (e) {}
})();
