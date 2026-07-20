/*
 * DevPhone iOS shims — SINGLE SOURCE of the shim code.
 *
 * Usable three ways (all kept in sync because this file is the only copy):
 *  1. require()'d by screen-preload.js (unsandboxed webview preload) —
 *     auto-applies to the shared window on load (contextIsolation=no).
 *  2. Read as text by the main process (emulation.js getShimSource) and
 *     injected via executeJavaScript / Playwright addInitScript — the
 *     trailing auto-apply runs in the page.
 *  3. Evaluated from a string in the webview preload as a fallback.
 *
 * Shims (each defineProperty individually try/catch'd):
 *  - navigator.standalone — live getter reading window.__DEVPHONE_STANDALONE__
 *    (set synchronously by screen-preload from main state, refreshed by
 *    emulation.js on dom-ready and on standalone:set), falling back to
 *    window.__DEVPHONE__.standalone, default false.
 *  - navigator.platform = 'iPhone' or 'iPad' from the active form factor
 *  - navigator.maxTouchPoints = 5
 *  - navigator.vendor = 'Apple Computer, Inc.'
 *
 * Callers gate on iOS (UA contains 'iPhone'/'iPad' or device.os === 'ios'); the shim
 * itself only guards against double application.
 */
(function (global) {
  'use strict';

  function applyIosShims(win) {
    win = win || (typeof window !== 'undefined' ? window : null);
    if (!win) return false;
    try {
      if (win.__DEVPHONE_IOS_SHIMS__) return true;
      win.__DEVPHONE_IOS_SHIMS__ = true;
    } catch (e) {}

    var nav = win.navigator;
    if (!nav) return false;

    function platformName() {
      try {
        if (win.__DEVPHONE__ && win.__DEVPHONE__.os && win.__DEVPHONE__.os !== 'ios') {
          return 'Linux armv8l';
        }
        if (win.__DEVPHONE__ && win.__DEVPHONE__.formFactor === 'tablet') return 'iPad';
        if (String(nav.userAgent || '').indexOf('iPad') !== -1) return 'iPad';
      } catch (e) {}
      return 'iPhone';
    }

    function vendorName() {
      try {
        if (win.__DEVPHONE__ && win.__DEVPHONE__.os && win.__DEVPHONE__.os !== 'ios') {
          return 'Google Inc.';
        }
      } catch (e) {}
      return 'Apple Computer, Inc.';
    }

    try {
      Object.defineProperty(nav, 'standalone', {
        configurable: true,
        get: function () {
          try {
            if (typeof win.__DEVPHONE_STANDALONE__ !== 'undefined') return !!win.__DEVPHONE_STANDALONE__;
            if (win.__DEVPHONE__ && typeof win.__DEVPHONE__.standalone !== 'undefined') return !!win.__DEVPHONE__.standalone;
          } catch (e) {}
          return false;
        }
      });
    } catch (e) {}

    try {
      Object.defineProperty(nav, 'platform', {
        configurable: true,
        get: platformName
      });
    } catch (e) {}

    try {
      Object.defineProperty(nav, 'maxTouchPoints', {
        configurable: true,
        get: function () { return 5; }
      });
    } catch (e) {}

    try {
      Object.defineProperty(nav, 'vendor', {
        configurable: true,
        get: vendorName
      });
    } catch (e) {}

    return true;
  }

  // Export when loaded as a CommonJS module (preload require path).
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = { applyIosShims: applyIosShims };
    }
  } catch (e) {}

  // Auto-apply whenever a window is present (preload shares the page context;
  // injected-string and init-script paths run directly in the page).
  try {
    if (typeof window !== 'undefined') applyIosShims(window);
  } catch (e) {}
})(typeof globalThis !== 'undefined' ? globalThis : this);
