/* ==========================================================================
   DevPhone shell.js — boot, device switching, scale, engine toggle, picker,
   screenshots, webview wiring, status bar, control rail, toasts.

   Exposes window.DP (shared with homescreen.js / browser-chrome.js, which
   are loaded after this file and register DP.home / DP.chrome).
   Every window.devphone call is guarded — the engine half may lag behind.
   ========================================================================== */
'use strict';

(function () {

  /* ---------- constants --------------------------------------------------- */

  var PAD = 48;          // transparent SHADOW MARGIN around the phone (scaled
                         // with phone scale) — the drop-shadow must fade fully
                         // inside it, no hard clip at the window edge
  var RAIL_W = 86;       // control rail width
  var GAP = 12;          // gap between phone and rail
  var MIN_WIN_H = 600;   // rail needs at least this
  var SCALES = [0.75, 1, 1.25];
  var NAV_H = 44;            // Android 3-button navigation bar height (CSS px @1:1)
  var ANDROID_PWA_SB = 28;   // black status strip in Android standalone apps

  // bezel metrics per bodyStyle. Single source of truth — JS pushes these
  // into CSS custom properties so frames.css and window sizing never drift.
  var BODY_METRICS = {
    'titanium-pro':   { top: 17, side: 17, bottom: 17, body: function (r) { return r + 15; } },
    // modern non-Pro iPhone (14/15/16/17/Air): edge-to-edge glass, slim even
    // bezels, a hair thicker than the Pro
    'aluminum':       { top: 19, side: 19, bottom: 19, body: function (r) { return r + 16; } },
    // classic home-button body (iPhone SE): symmetric big forehead/chin
    'classic-button': { top: 88, side: 19, bottom: 88, body: function ()  { return 58; } },
    'glass-android':  { top: 13, side: 12, bottom: 16, body: function (r) { return r + 11; } },
    'budget-android': { top: 18, side: 14, bottom: 24, body: function (r) { return r + 12; } }
  };

  // used when the engine half isn't running yet (pure UI preview)
  var FALLBACK_DEVICE = {
    id: 'iphone-16-pro-max', label: 'iPhone 16 Pro Max', brand: 'apple',
    os: 'ios', osVersion: '26',
    viewport: { width: 440, height: 956 }, dpr: 3,
    cutout: 'dynamic-island', cornerRadius: 55,
    bodyStyle: 'titanium-pro', accentColor: '#3b3b3d',
    browsers: ['safari', 'chrome'], estimated: false
  };

  /* ---------- shared state ------------------------------------------------ */

  var state = {
    devices: [],
    device: null,
    scale: 1,
    engine: 'chromium',
    app: null,             // null | {type:'browser', browser} | {type:'pwa', app}
    standalone: false,
    url: '',
    title: '',
    canGoBack: false,
    canGoForward: false,
    themeColor: null,
    pickerOn: false,
    attached: false,
    webviewReady: false,
    newIds: {},            // deviceId -> true for freshly discovered phones
    nav3: false,           // Android 3-button navigation (per device id)
    addrBar: 'top',        // Chrome address bar position (global)
    inputMode: 'touch',    // 'touch' | 'mouse' (global)
    alwaysOnTop: false,    // window pinning (global)
    contentViewport: null, // {width,height} of the honest content area (unscaled)
    clickThrough: false    // v0.1.5: cursor is over an INVISIBLE window region
  };

  /* ---------- tiny pub/sub ------------------------------------------------ */

  var bus = {
    _m: {},
    on: function (ev, fn) { (this._m[ev] = this._m[ev] || []).push(fn); },
    emit: function (ev, data) {
      (this._m[ev] || []).forEach(function (fn) {
        try { fn(data); } catch (e) { console.warn('[DevPhone] bus handler for "' + ev + '" threw', e); }
      });
    }
  };

  /* ---------- devphone bridge (guarded) ----------------------------------- */

  function camelName(name) {
    return name.replace(/[:\-](\w)/g, function (_, c) { return c.toUpperCase(); });
  }

  function invoke(name, payload) {
    var dp = window.devphone;
    if (!dp) {
      console.warn('[DevPhone] window.devphone missing — cannot invoke ' + name);
      return Promise.resolve(undefined);
    }
    var fn = null;
    // Prefer the generic bridge: it takes (channel, payload) verbatim. The
    // named wrappers take RAW values (e.g. screenAttach(id)), so calling
    // them with a payload object double-wraps it - never use them here.
    if (typeof dp.invoke === 'function') fn = function (p) { return dp.invoke(name, p); };
    else if (typeof dp[name] === 'function') fn = dp[name];
    else if (typeof dp[camelName(name)] === 'function') fn = dp[camelName(name)];
    if (!fn) {
      console.warn('[DevPhone] devphone.' + name + ' not available yet');
      return Promise.resolve(undefined);
    }
    try {
      return Promise.resolve(fn.call(dp, payload)).catch(function (e) {
        console.warn('[DevPhone] invoke ' + name + ' rejected', e);
        return undefined;
      });
    } catch (e) {
      console.warn('[DevPhone] invoke ' + name + ' threw', e);
      return Promise.resolve(undefined);
    }
  }

  // subscribe to main → renderer events, tolerant of preload API shape:
  //   devphone.on('chan', cb) | devphone.onChanName(cb) | devphone['chan'](cb)
  function listen(channel, fn) {
    var dp = window.devphone;
    if (!dp) { console.warn('[DevPhone] no devphone — cannot listen for ' + channel); return; }
    var wrapped = function () {
      var payload = arguments.length ? arguments[arguments.length - 1] : undefined;
      try { fn(payload); } catch (e) { console.warn('[DevPhone] listener for ' + channel + ' threw', e); }
    };
    var camel = camelName(channel);
    var onName = 'on' + camel.charAt(0).toUpperCase() + camel.slice(1);
    try {
      if (typeof dp.on === 'function') { dp.on(channel, wrapped); return; }
      if (typeof dp[onName] === 'function') { dp[onName](wrapped); return; }
      if (typeof dp[channel] === 'function') { dp[channel](wrapped); return; }
    } catch (e) { console.warn('[DevPhone] listen(' + channel + ') failed', e); }
    console.warn('[DevPhone] no subscription API found for ' + channel);
  }

  /* ---------- DOM refs ---------------------------------------------------- */

  var el = {};
  function cacheEls() {
    ['stage', 'phone-wrap', 'phone', 'screen', 'page', 'webkit-canvas', 'touch-layer', 'homescreen',
     'startpage', 'browser-chrome', 'navbar', 'sheet-layer', 'statusbar', 'cutout',
     'home-indicator', 'home-gesture', 'open-anim-layer', 'glass', 'toasts',
     'sidebar-controls', 'device-popover', 'settings-popover', 'click-catcher', 'ctx-menu',
     'device-label', 'engine-label', 'scale-label', 'input-label',
     'hw-home-button',
     'btn-min', 'btn-close', 'btn-device', 'btn-engine', 'btn-input', 'btn-scale',
     'btn-picker', 'btn-shot-screen', 'btn-shot-device', 'btn-rotate', 'btn-home',
     'btn-settings'
    ].forEach(function (id) {
      el[camelName(id.replace(/-/g, ':'))] = document.getElementById(id);
    });
  }

  /* ---------- helpers ----------------------------------------------------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg, ms) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    el.toasts.appendChild(t);
    while (el.toasts.children.length > 4) el.toasts.removeChild(el.toasts.firstChild);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () {
      t.classList.add('hide');
      setTimeout(function () { t.remove(); }, 200);
    }, ms || 3600);
  }

  function fmtTime(os) {
    var d = new Date();
    var h = d.getHours();
    var m = ('0' + d.getMinutes()).slice(-2);
    if (os === 'android') return ('0' + h).slice(-2) + ':' + m;
    return (((h + 11) % 12) + 1) + ':' + m;
  }

  function fmtDate() {
    try {
      return new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    } catch (e) { return new Date().toDateString(); }
  }

  // perceived luminance 0..255 from '#rgb' | '#rrggbb' | 'rgb(a)(...)'
  function luminance(color) {
    if (!color) return null;
    var r, g, b, m;
    color = String(color).trim();
    if (color[0] === '#') {
      var hex = color.slice(1);
      if (hex.length === 3 || hex.length === 4) hex = hex.split('').map(function (c) { return c + c; }).join('');
      if (hex.length < 6) return null;
      r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
    } else if ((m = color.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/))) {
      r = +m[1]; g = +m[2]; b = +m[3];
    } else return null;
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function metricsFor(device) {
    return BODY_METRICS[device.bodyStyle] || BODY_METRICS['glass-android'];
  }

  function sbHeight(device) {
    if (device.os === 'ios') {
      if (device.cutout === 'dynamic-island') return 59;
      if (device.cutout === 'notch') return 47;
      return 20;
    }
    return 32;
  }

  /* ---------- per-device wallpaper colorways --------------------------------
     One source of truth for the home-screen wallpaper AND the device-picker
     mini icons, so a phone is recognizable at a glance ("release colorway").
     Pure CSS gradients only. Returns { css, stops:[...] }.                  */

  function wallpaperFor(d) {
    d = d || {};
    var id = String(d.id || '');
    if (d.os === 'ios') {
      if (d.bodyStyle === 'classic-button') {
        // SE: quiet deep slate — the classic look
        return {
          stops: ['#5d7390', '#1a2330'],
          css: 'linear-gradient(200deg,#5d7390 0%,#33415a 48%,#161e2b 100%)'
        };
      }
      // flowing iOS aurora; hue follows the device generation
      var gen = (id.match(/iphone-(\d+)/) || [])[1] || '';
      if (id.indexOf('air') >= 0) gen = '17';
      var GEN_HUES = {
        '14': ['#8a5cf0', '#c084e8', '#1b1140'],   // 14s: violet
        '15': ['#23c4ae', '#7fe3cd', '#072a33'],   // 15s: teal
        '16': ['#3e7bf0', '#7fb4ff', '#0a1640'],   // 16s: ultramarine
        '17': ['#ff8a45', '#ffc06e', '#3a1430']    // 17s/Air: cosmic orange
      };
      var c = GEN_HUES[gen] || ['#5e6ce0', '#9aa6ff', '#141a45'];
      return {
        stops: [c[1], c[0], c[2]],
        css: 'radial-gradient(120% 85% at 18% 12%,' + c[0] + ' 0%,rgba(0,0,0,0) 56%),' +
             'radial-gradient(110% 80% at 85% 28%,' + c[1] + ' 0%,rgba(0,0,0,0) 58%),' +
             'radial-gradient(130% 105% at 68% 96%,' + c[0] + ' 0%,rgba(0,0,0,0) 55%),' +
             'linear-gradient(178deg,' + c[2] + ' 0%,#05060f 100%)'
      };
    }
    if (d.brand === 'google') {
      // Pixel: clean dual-tone split
      return {
        stops: ['#2e564b', '#16302a'],
        css: 'linear-gradient(168deg,#22413a 0%,#2e564b 49.8%,#16302a 50.2%,#0d1d19 100%)'
      };
    }
    if (d.bodyStyle === 'budget-android') {
      // budget: simple two-stop fade
      return {
        stops: ['#33486b', '#0d1421'],
        css: 'linear-gradient(192deg,#33486b 0%,#1d2a44 55%,#0c1220 100%)'
      };
    }
    // Samsung flagship: One-UI-style soft abstract mesh
    return {
      stops: ['#3a7bd5', '#7b4ddb', '#c0467f'],
      css: 'radial-gradient(95% 70% at 20% 16%,rgba(77,130,224,.85) 0%,rgba(0,0,0,0) 60%),' +
           'radial-gradient(90% 75% at 84% 36%,rgba(132,84,228,.75) 0%,rgba(0,0,0,0) 62%),' +
           'radial-gradient(110% 90% at 55% 96%,rgba(212,86,150,.65) 0%,rgba(0,0,0,0) 60%),' +
           'linear-gradient(180deg,#1c2350 0%,#0d1030 100%)'
    };
  }

  /* ---------- status bar --------------------------------------------------- */

  function svgSignal() {
    return '<svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor">' +
      '<rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/>' +
      '<rect x="10" y="2.8" width="3" height="9.2" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1" opacity=".35"/></svg>';
  }
  function svgWifi() {
    return '<svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor">' +
      '<path d="M8.5 12 11.1 8.8a4.4 4.4 0 0 0-5.2 0Z"/>' +
      '<path d="M3.7 6.2a7.4 7.4 0 0 1 9.6 0l-1.5 1.8a5.1 5.1 0 0 0-6.6 0Z"/>' +
      '<path d="M.9 3.3a11.4 11.4 0 0 1 15.2 0l-1.5 1.8a9 9 0 0 0-12.2 0Z"/></svg>';
  }
  function svgBattery() {
    return '<svg width="28" height="13" viewBox="0 0 28 13">' +
      '<rect x="0.6" y="0.6" width="23.8" height="11.8" rx="3.6" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".4"/>' +
      '<path d="M26 4.4v4.2c1.1-.3 1.7-1.1 1.7-2.1S27.1 4.7 26 4.4z" fill="currentColor" opacity=".4"/>' +
      '<rect x="2.3" y="2.3" width="17.8" height="8.4" rx="2.1" fill="currentColor"/></svg>';
  }

  function renderStatusbar() {
    var d = state.device;
    if (!d || !el.statusbar) return;
    var html;
    if (d.os === 'ios' && d.cutout === 'none') {
      html = '<div class="sb sb-classic">' +
               '<span class="sb-carrier">DevPhone ' + svgWifi() + '</span>' +
               '<span class="sb-time js-clock">' + fmtTime(d.os) + '</span>' +
               '<span class="sb-right">' + svgBattery() + '</span>' +
             '</div>';
    } else if (d.os === 'ios') {
      html = '<div class="sb sb-island">' +
               '<div class="sb-ear-left"><span class="sb-time js-clock">' + fmtTime(d.os) + '</span></div>' +
               '<div class="sb-ear-right">' + svgSignal() + svgWifi() + svgBattery() + '</div>' +
             '</div>';
    } else {
      html = '<div class="sb sb-android">' +
               '<span class="sb-time js-clock">' + fmtTime(d.os) + '</span>' +
               '<span class="sb-right">' + svgWifi() + svgSignal() +
                 '<span class="sb-batt-pct">87%</span>' + svgBattery() +
               '</span>' +
             '</div>';
    }
    el.statusbar.innerHTML = html;
  }

  function renderCutout() {
    var d = state.device;
    if (!d || !el.cutout) return;
    el.cutout.className = (d.cutout || 'none') + ' os-' + d.os;
  }

  // black or white status text from the active page's theme-color
  function applyStatusTheme() {
    var darkText;
    var d = state.device;
    if (!state.app) {
      darkText = false;                       // wallpapers are dark → white text
    } else if (state.standalone && d && d.os === 'android') {
      darkText = false;                       // solid black status strip → white text
    } else {
      var lum = luminance(state.themeColor);
      darkText = (lum == null) ? true : lum > 150;
    }
    if (el.statusbar) {
      el.statusbar.classList.toggle('sb-dark', darkText);
      el.statusbar.classList.toggle('sb-light', !darkText);
    }
    if (el.homeIndicator) el.homeIndicator.classList.toggle('dark', darkText);
  }

  function startClock() {
    setInterval(function () {
      var os = state.device ? state.device.os : 'ios';
      var t = fmtTime(os);
      document.querySelectorAll('.js-clock').forEach(function (n) { n.textContent = t; });
      bus.emit('minute');
    }, 15000);
  }

  /* ---------- device application & window layout --------------------------- */

  function layout() {
    var d = state.device;
    if (!d) return;
    var m = metricsFor(d);
    var pw = d.viewport.width + m.side * 2;
    var ph = d.viewport.height + m.top + m.bottom;
    var s = state.scale;
    var pad = Math.round(PAD * s);   // shadow margin scales with the phone
    el.phone.style.setProperty('--scale', s);
    el.phoneWrap.style.width = Math.ceil(pw * s) + 'px';
    el.phoneWrap.style.height = Math.ceil(ph * s) + 'px';
    // --stage-pad drives #stage padding AND the popover anchoring in CSS
    document.documentElement.style.setProperty('--stage-pad', pad + 'px');
    var w = Math.ceil(pw * s) + pad * 2 + GAP + RAIL_W;
    var h = Math.max(Math.ceil(ph * s) + pad * 2, MIN_WIN_H);
    invoke('shell:resize', { width: w, height: h });
  }

  /* ---------- honest content-area layout + viewport overrides --------------
     The webview occupies the CONTENT AREA between bars (status bar, browser
     chrome, 3-button navbar). Every layout change re-sends the visible size
     via device:set {viewport} so window.innerHeight in the page is honest.
     All values are UNSCALED CSS px, rounded to integers.                     */

  function nav3On() {
    var d = state.device;
    return !!(d && d.os === 'android' && state.nav3);
  }

  function contentInsets() {
    var d = state.device;
    if (!d) return { top: 0, bottom: 0 };
    var navH = nav3On() ? NAV_H : 0;
    if (!state.app) return { top: 0, bottom: 0 };            // home — no page
    if (state.app.type === 'pwa') {
      if (d.os === 'ios') return { top: 0, bottom: 0 };      // edge-to-edge
      return { top: ANDROID_PWA_SB, bottom: navH };          // black strip + navbar
    }
    // browser mode — the chrome module knows its own bars (incl. status bar
    // for android-style top bars; Safari pages draw under the status bar)
    var ch = (DP.chrome && DP.chrome.getInsets) ? DP.chrome.getInsets() : { top: 0, bottom: 0 };
    return { top: ch.top, bottom: ch.bottom + navH };
  }

  var vpTimer = null;
  var lastVp = '';

  function sendViewport() {
    var d = state.device;
    if (!d || !state.attached) return;
    var ins = contentInsets();
    var w = Math.round(d.viewport.width);
    var h = Math.round(d.viewport.height - ins.top - ins.bottom);
    state.contentViewport = { width: w, height: h };
    var key = d.id + ':' + w + 'x' + h;
    if (key === lastVp) return;
    lastVp = key;
    invoke('device:set', { deviceId: d.id, viewport: { width: w, height: h } })
      .then(function () {
        // input mode must survive every re-emulation
        invoke('input:set', { mode: state.inputMode });
      });
  }

  function scheduleViewport(immediate) {
    if (vpTimer) { clearTimeout(vpTimer); vpTimer = null; }
    if (immediate) { sendViewport(); return; }
    vpTimer = setTimeout(function () { vpTimer = null; sendViewport(); }, 250);
  }

  function layoutContent(opts) {
    var d = state.device;
    if (!d || !el.screen) return;
    var ins = contentInsets();
    var st = el.screen.style;
    st.setProperty('--content-top', Math.round(ins.top) + 'px');
    st.setProperty('--content-h', Math.round(d.viewport.height - ins.top - ins.bottom) + 'px');
    st.setProperty('--nav-h', (nav3On() ? NAV_H : 0) + 'px');
    state.contentViewport = {
      width: Math.round(d.viewport.width),
      height: Math.round(d.viewport.height - ins.top - ins.bottom)
    };
    if (el.navbar) el.navbar.hidden = !nav3On();
    // input interceptor only while a page is actually on screen (chromium)
    if (el.touchLayer) el.touchLayer.hidden = !(state.app && state.engine === 'chromium');
    document.body.classList.toggle('android-standalone',
      !!(state.standalone && d.os === 'android'));
    applyStatusTheme();
    scheduleViewport(opts && opts.immediate);
  }

  /* ---------- Android 3-button navigation bar ------------------------------- */

  function renderNavbar() {
    if (!el.navbar) return;
    el.navbar.innerHTML =
      '<button id="nb-recents" title="Recents">' +
        '<svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 2.5v13M9 2.5v13M15 2.5v13"/></svg>' +
      '</button>' +
      '<button id="nb-home" title="Home">' +
        '<svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="9" r="6.4"/></svg>' +
      '</button>' +
      '<button id="nb-back" title="Back">' +
        '<svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5 5 9l6.5 6.5"/></svg>' +
      '</button>';
    var rec = el.navbar.querySelector('#nb-recents');
    var home = el.navbar.querySelector('#nb-home');
    var back = el.navbar.querySelector('#nb-back');
    if (rec) rec.addEventListener('click', recentsFlourish);
    if (home) home.addEventListener('click', function () { goHome(); });
    if (back) back.addEventListener('click', navbarBack);
  }

  function navbarBack() {
    if (state.app && state.canGoBack) { navAction('back'); return; }
    if (state.app) goHome();   // standalone (or empty history) → exit to home
  }

  function recentsFlourish() {
    if (!el.screen) return;
    el.screen.classList.add('recents-anim');
    setTimeout(function () { el.screen.classList.remove('recents-anim'); }, 240);
  }

  /* ---------- per-device / global settings ----------------------------------- */

  function loadDeviceSettings(device) {
    var v = null;
    try { v = localStorage.getItem('devphone.nav3.' + device.id); } catch (e) {}
    state.nav3 = v === '1';
  }

  function setNav3(on) {
    state.nav3 = !!on;
    try {
      if (state.device) localStorage.setItem('devphone.nav3.' + state.device.id, on ? '1' : '0');
    } catch (e) {}
    renderSettingsPopover();
    updateHomeIndicator();
    layoutContent();
  }

  function setAddrBar(pos) {
    pos = pos === 'bottom' ? 'bottom' : 'top';
    if (state.addrBar === pos) { renderSettingsPopover(); return; }
    state.addrBar = pos;
    try { localStorage.setItem('devphone.addrbar', pos); } catch (e) {}
    renderSettingsPopover();
    bus.emit('settings-changed', { addrBar: pos });  // chrome bar re-renders itself
    layoutContent();
  }

  function setInputMode(mode, fromUser) {
    state.inputMode = mode === 'mouse' ? 'mouse' : 'touch';
    try { localStorage.setItem('devphone.inputmode', state.inputMode); } catch (e) {}
    // cursor scoping: the fingertip cursor exists ONLY over the page content
    // area (#touch-layer / #webkit-canvas) and only in touch mode — the rest
    // of the shell always shows normal desktop cursors (shell.css)
    document.body.classList.toggle('input-touch', state.inputMode === 'touch');
    updateInputBtn();
    invoke('input:set', { mode: state.inputMode });
    if (fromUser) {
      toast(state.inputMode === 'mouse'
        ? '🖱️ Mouse — precise cursor & selection'
        : '👆 Touch — swipe & scroll like a finger', 1800);
    }
  }

  function updateInputBtn() {
    if (!el.btnInput) return;
    var mouse = state.inputMode === 'mouse';
    el.btnInput.firstChild.textContent = mouse ? '🖱️' : '👆';
    if (el.inputLabel) el.inputLabel.textContent = mouse ? 'Mouse' : 'Touch';
    el.btnInput.title = mouse
      ? 'Input: Mouse — precise cursor + text selection. Click for Touch.'
      : 'Input: Touch — swipes & flick-scroll like a finger. Click for Mouse.';
  }

  /* ---------- always on top ----------------------------------------------------
     New IPC shell:alwaysOnTop {on} (the one allowed main/preload extension).
     Persisted globally; re-applied at boot. Reachable from the ⚙ popover AND
     a right-click context menu on the phone bezel / shadow margin.          */

  function setAlwaysOnTop(on) {
    state.alwaysOnTop = !!on;
    try { localStorage.setItem('devphone.alwaysontop', on ? '1' : '0'); } catch (e) {}
    invoke('shell:alwaysOnTop', { on: state.alwaysOnTop });
    renderSettingsPopover();
  }

  /* ---------- standalone WebKit preview window (v0.1.5) ------------------------
     Opens the current page in a real, headed Playwright-WebKit window —
     native interaction speed (no frame streaming), same device identity
     (viewport/dpr/UA/shims) and the same persisted storage state, so
     logins carry over both ways. Main reuses an already-open window.    */

  function openWebkitWindow() {
    toggleSettingsPopover(false);
    var url = state.url || '';
    if (!url || url === 'about:blank' || url.indexOf('data:') === 0) {
      toast('Open a page first', 1800);
      return;
    }
    toast('🧭 Opening WebKit window…', 1800);
    invoke('webkit:window', { url: url }).then(function (res) {
      if (!res || !res.ok) {
        toast('WebKit window failed: ' + ((res && res.error) || 'unknown error'), 2600);
      }
    });
  }

  /* ---------- settings popover ------------------------------------------------ */

  function renderSettingsPopover() {
    var pop = el.settingsPopover;
    if (!pop) return;
    var d = state.device || {};
    var html = '<div class="set-title">Settings</div>' +
      '<div class="set-sec">Navigation · ' + esc(d.label || 'device') + '</div>';
    if (d.os === 'android') {
      html += '<div class="set-seg" data-set="nav">' +
        '<button data-v="gestures" class="' + (!state.nav3 ? 'on' : '') + '">Gestures</button>' +
        '<button data-v="3btn" class="' + (state.nav3 ? 'on' : '') + '">3 buttons</button>' +
      '</div>';
    } else {
      html += '<div class="set-note">iPhones always use gesture navigation</div>';
    }
    html += '<div class="set-sec">Address bar · Chrome</div>' +
      '<div class="set-seg" data-set="addr">' +
        '<button data-v="top" class="' + (state.addrBar !== 'bottom' ? 'on' : '') + '">Top</button>' +
        '<button data-v="bottom" class="' + (state.addrBar === 'bottom' ? 'on' : '') + '">Bottom</button>' +
      '</div>';
    html += '<div class="set-sec">Window</div>' +
      '<button class="set-row" id="set-aot">📌 Always on top' +
        '<span class="set-check">' + (state.alwaysOnTop ? '✓' : '✗') + '</span>' +
      '</button>';
    html += '<div class="set-sec">Preview</div>' +
      '<button class="set-row" id="set-wkwin">🧭 Open in WebKit window</button>' +
      '<div class="set-note">Real WebKit, full speed — no phone frame</div>';
    var ver = (window.devphone && devphone.version) || '';
    html += '<div class="set-sec">About</div>' +
      '<button class="set-row" id="set-update">🔄 Check for updates' +
        (ver ? '<span class="set-check">v' + esc(ver) + '</span>' : '') +
      '</button>';
    pop.innerHTML = html;
  }

  /* ---------- click-catcher (popover modality) -------------------------------
     Clicks inside the <webview> never bubble to this document, so an
     "outside click" closer can't see them. Whenever a rail popover is open we
     show an invisible overlay covering everything below the popovers (incl.
     the page and the phone): one click on it closes the popovers and is
     swallowed — nothing behind it can also activate.                         */

  var catcherHeld = false;   // a press started on the catcher is in flight

  function anyPopoverOpen() {
    return !!((el.devicePopover && !el.devicePopover.hidden) ||
              (el.settingsPopover && !el.settingsPopover.hidden));
  }

  function updateCatcher() {
    if (!el.clickCatcher) return;
    // keep the catcher up mid-press so the matching mouseup/click can't
    // fall through to whatever is underneath
    el.clickCatcher.hidden = !anyPopoverOpen() && !catcherHeld;
  }

  function wireCatcher() {
    var c = el.clickCatcher;
    if (!c) return;
    c.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      catcherHeld = true;
      try { c.setPointerCapture(e.pointerId); } catch (err) {}
      toggleDevicePopover(false);
      toggleSettingsPopover(false);
    });
    function release(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      catcherHeld = false;
      updateCatcher();
    }
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', release);
    c.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
  }

  function toggleSettingsPopover(show) {
    var pop = el.settingsPopover;
    if (!pop) return;
    var willShow = (show != null) ? show : pop.hidden;
    pop.hidden = !willShow;
    if (willShow) {
      renderSettingsPopover();
      toggleDevicePopover(false);
    }
    updateCatcher();
  }

  function applyDevice(device) {
    state.device = device;
    loadDeviceSettings(device);
    // suppress the content-area resize animation during a device swap
    if (el.screen) {
      el.screen.classList.add('no-anim');
      setTimeout(function () { el.screen.classList.remove('no-anim'); }, 80);
    }
    var m = metricsFor(device);
    var ph = el.phone;
    ph.className = 'body-' + device.bodyStyle + ' brand-' + device.brand + ' os-' + device.os;
    var st = ph.style;
    st.setProperty('--screen-w', device.viewport.width + 'px');
    st.setProperty('--screen-h', device.viewport.height + 'px');
    st.setProperty('--corner-radius', (device.cornerRadius || 0) + 'px');
    st.setProperty('--body-radius', m.body(device.cornerRadius || 0) + 'px');
    st.setProperty('--body-color', device.accentColor || '#2c2c2e');
    st.setProperty('--bz-t', m.top + 'px');
    st.setProperty('--bz-s', m.side + 'px');
    st.setProperty('--bz-b', m.bottom + 'px');
    st.setProperty('--sb-h', sbHeight(device) + 'px');
    renderStatusbar();
    renderCutout();
    layout();
    if (el.deviceLabel) el.deviceLabel.textContent = device.label;
    try { localStorage.setItem('devphone.device', device.id); } catch (e) {}
    if (DP.home) DP.home.render();
    updateHomeIndicator();
    applyStatusTheme();
    renderSettingsPopover();
    layoutContent();
    bus.emit('device-changed', device);
  }

  function switchDevice(id) {
    var device = null;
    state.devices.forEach(function (d) { if (d.id === id) device = d; });
    if (!device || (state.device && state.device.id === id)) return;
    goHome(true);
    applyDevice(device);
    if (state.attached) { lastVp = ''; scheduleViewport(true); }
    delete state.newIds[id];
    renderDevicePopover();
    toast('📱 ' + device.label + ' — ' + device.viewport.width + '×' + device.viewport.height + ' @' + device.dpr + 'x');
  }

  /* ---------- home indicator / gesture ------------------------------------- */

  function updateHomeIndicator() {
    var d = state.device;
    // 3-button phones have no gesture pill / swipe area
    var gesturePhone = d && d.cutout !== 'none' && !nav3On();
    if (el.homeIndicator) el.homeIndicator.hidden = !gesturePhone;
    if (el.homeGesture) el.homeGesture.hidden = !(gesturePhone && state.app);
  }

  function goHome(silent) {
    if (state.standalone) {
      state.standalone = false;
      invoke('standalone:set', { on: false });
    }
    // the page is leaving the screen — a guest holding focus would keep the
    // browser-level input capture alive and eat the next shell click
    try { if (el.page && el.page.blur) el.page.blur(); } catch (e) {}
    if (DP.chrome) DP.chrome.close();
    state.app = null;
    state.themeColor = null;
    if (DP.home) DP.home.show();
    applyStatusTheme();
    updateHomeIndicator();
    layoutContent();
    if (!silent) bus.emit('went-home');
  }

  function wireGesture() {
    var g = el.homeGesture;
    if (!g) return;
    var startY = null;
    g.addEventListener('pointerdown', function (ev) {
      startY = ev.clientY;
      try { g.setPointerCapture(ev.pointerId); } catch (e) {}
    });
    g.addEventListener('pointermove', function (ev) {
      if (startY != null && startY - ev.clientY > 26) { startY = null; goHome(); }
    });
    g.addEventListener('pointerup', function () { startY = null; });
  }

  /* ---------- webview wiring ------------------------------------------------ */

  function wireWebview() {
    var wv = el.page;
    if (!wv || typeof wv.addEventListener !== 'function') return;

    wv.addEventListener('dom-ready', function () {
      state.webviewReady = true;
      injectTapBeacon();
      if (!state.attached) {
        state.attached = true;
        var id = null;
        try { id = wv.getWebContentsId(); } catch (e) { console.warn('[DevPhone] getWebContentsId failed', e); }
        if (id != null) {
          invoke('screen:attach', { webContentsId: id }).then(function () {
            lastVp = '';                 // force a fresh viewport push
            scheduleViewport(true);      // device:set {deviceId, viewport} + input mode
            bus.emit('attached');
          });
        } else {
          bus.emit('attached');
        }
      }
    });

    wv.addEventListener('did-navigate', function (e) { onNavigated(e.url, false); });
    wv.addEventListener('did-navigate-in-page', function (e) {
      if (e.isMainFrame === false) return;
      onNavigated(e.url, true);
    });
    wv.addEventListener('page-title-updated', function (e) {
      state.title = e.title || '';
      bus.emit('title', state.title);
    });
    wv.addEventListener('did-change-theme-color', function (e) {
      state.themeColor = e.themeColor || null;
      applyStatusTheme();
      bus.emit('themecolor', state.themeColor);
    });
    wv.addEventListener('did-start-loading', function () { bus.emit('loading', true); });
    wv.addEventListener('did-stop-loading', function () {
      bus.emit('loading', false);
      updateNavState();
    });
    wv.addEventListener('did-fail-load', function (e) {
      if (e.errorCode !== -3 && e.isMainFrame) {
        toast('⚠️ Load failed: ' + (e.errorDescription || e.errorCode));
      }
    });
    wv.addEventListener('console-message', function (e) {
      var msg = e.message || '';
      if (msg.indexOf('__DEVPHONE_SCROLL__') === 0) {
        var y = parseScrollPayload(msg.slice('__DEVPHONE_SCROLL__'.length));
        if (y != null) bus.emit('scroll', y);
      } else if (msg === '__DEVPHONE_TAP__') {
        // a tap happened INSIDE the guest (forwarded, or captured while an
        // editable held focus) — re-evaluate whether it may keep focus
        setTimeout(guestBlurUnlessEditing, 90);
      }
    });
  }

  /* ---------- touch layer: shell-owned page input (chromium engine) ----------
     WHY: with CDP touch emulation active on the guest, any REAL click routed
     into the <webview> makes the guest webContents grab browser-level mouse
     capture + focus. From then on every mouse event in the WINDOW — including
     clicks on the rail / bars / popovers, and even an "outside click" catcher
     overlay — is captured straight into the guest, bypassing the shell DOM
     entirely, until ONE shell-bound click is sacrificed to break the capture.
     That was the "press twice" bug, and no hover/blur juggling in the shell
     can see (let alone fix) events it never receives.

     FIX: a transparent #touch-layer covers the webview, so the guest never
     receives real input. The shell owns every gesture — the same input model
     the WebKit canvas path already uses:
       tap   → synthetic pointer/mouse/click sequence dispatched INSIDE the
               guest (executeJavaScript + elementFromPoint). Forwarded
               sendInputEvent mouseDown/Up can NOT be used here: the guest's
               touch emulator turns the down into a touchstart but never
               terminates the sequence (no touchend, no click), leaving a
               poisoned input state. The synthetic tap also focuses tapped
               editables; ONLY then is real guest focus granted (typing
               needs it) — otherwise the guest stays blurred.
       drag  → synthetic scroll dispatched INSIDE the guest (executeJavaScript
               + elementFromPoint + scrollable-ancestor walk + scrollBy),
               descaled by zoom. Forwarded sendInputEvent mouseWheel is no
               longer trusted: Electron 36 / Chromium 136 FLIPPED its delta
               sign convention (E33: DOM-signed, positive deltaY scrolls
               content down; E36: hardware-signed, NEGATIVE deltaY scrolls
               down — verified empirically, scratch/probe-gest*.js), which
               silently inverted every drag/wheel scroll. scrollBy() is
               DOM-signed by spec and immune to the next flip.
       wheel → same synthetic scroll (a real phone page never sees wheel
               events anyway, so nothing of value is lost)
       hover → forwarded mouseMove (throttled) so :hover / the picker work
     In MOUSE input mode events are forwarded raw (down/move/up) — without
     touch emulation there is no capture trap, and text selection just works.
     sendInputEvent coordinates: plain guest-local CSS px. Electron 36 passes
     them to the guest UNCHANGED (measured, scratch/probe-mousemode.js:
     sent == arrival). The old E33-era "arrival = sent + rect offset"
     pre-compensation shifted every forwarded event ~65px off-target — that
     was mouse-mode clicks landing on the wrong element AND the touch-mode
     hover highlight lighting up the wrong control (e.g. the Skycrew portal
     cards) while the synthetic tap then hit the aimed one.                  */

  function guestBlurUnlessEditing() {
    var wv = el.page;
    if (!wv) return;
    var done = false;
    var doBlur = function () { try { wv.blur(); } catch (e) {} };
    // fail-safe: if the probe never answers (page tearing down, hung guest)
    // blur anyway — a focused guest must never linger, it captures all input
    var failSafe = setTimeout(function () {
      if (!done) { done = true; doBlur(); }
    }, 300);
    var js = '(function(){try{var a=document.activeElement;if(!a)return false;' +
             'if(a.isContentEditable)return true;var t=a.tagName;' +
             'return t==="INPUT"||t==="TEXTAREA"||t==="SELECT";}catch(e){return false}})()';
    try {
      Promise.resolve(wv.executeJavaScript(js)).then(function (editing) {
        if (done) return;
        done = true;
        clearTimeout(failSafe);
        if (!editing) doBlur();
      }).catch(function () {});
    } catch (e) { /* fail-safe timer covers it */ }
  }

  // every page load: plant a tiny tap beacon. If the guest ever DOES end up
  // holding the capture (e.g. a tap while an editable kept it focused), each
  // captured tap pings us via console-message and we re-evaluate → the shell
  // heals back to the un-captured state without eating extra clicks.
  function injectTapBeacon() {
    var wv = el.page;
    if (!wv || typeof wv.executeJavaScript !== 'function') return;
    var js = '(function(){if(window.__dpTapBeacon)return;window.__dpTapBeacon=1;' +
             'document.addEventListener("pointerdown",function(){' +
             'try{console.log("__DEVPHONE_TAP__")}catch(e){}},{capture:true,passive:true});' +
             // WebAuthn: Chromium exposes PublicKeyCredential, so passkey-first
             // sites (e.g. the Skycrew portal) switch to "Sign In with Face /
             // Fingerprint" — but navigator.credentials.get() can never
             // complete inside this webview (no authenticator UI), leaving
             // the page stuck on "Waiting…" forever. Behave like a user who
             // cancelled Face ID: reject promptly with NotAllowedError so the
             // page falls into its own PIN/password fallback path.
             'try{var cc=navigator.credentials;' +
             'if(cc&&cc.get){var og=cc.get.bind(cc),oc=cc.create?cc.create.bind(cc):null;' +
             'var cancel=function(){return new Promise(function(_,rej){setTimeout(function(){' +
             'rej(new DOMException("The operation either timed out or was not allowed.","NotAllowedError"))},400)})};' +
             'cc.get=function(o){return(o&&o.publicKey)?cancel():og(o)};' +
             'if(oc)cc.create=function(o){return(o&&o.publicKey)?cancel():oc(o)};}}catch(e){}' +
             '})()';
    try { Promise.resolve(wv.executeJavaScript(js)).catch(function () {}); } catch (e) {}
  }

  function wireTouchLayer() {
    var layer = el.touchLayer;
    if (!layer) return;

    function sendToGuest(ev) {
      var wv = el.page;
      if (!wv || !state.webviewReady) return;
      try { wv.sendInputEvent(ev); } catch (e) {}
    }

    // guest-local CSS px of a layer event — used both for sendInputEvent
    // forwarding (E36 delivers coordinates unchanged) and for the in-guest
    // elementFromPoint paths
    function localXY(e) {
      var r = el.page.getBoundingClientRect();
      var s = (el.page.offsetWidth ? r.width / el.page.offsetWidth : 1) || 1;
      return {
        x: Math.round((e.clientX - r.left) / s),
        y: Math.round((e.clientY - r.top) / s)
      };
    }

    // tap = full synthetic sequence inside the guest. Returns whether an
    // editable was tapped; only then the guest gets real focus (typing).
    function syntheticTap(local) {
      var wv = el.page;
      if (!wv || !state.webviewReady || typeof wv.executeJavaScript !== 'function') return;
      var w = (state.contentViewport && state.contentViewport.width) ||
              (state.device && state.device.viewport.width) || 0;
      var js = '(function(x,y,w){try{' +
        // map widget CSS px → page client px (pages without a mobile
        // viewport meta lay out wider than the widget, e.g. 980px)
        'var k=(w&&window.innerWidth)?(window.innerWidth/w):1;' +
        'x=Math.round(x*k);y=Math.round(y*k);' +
        'var el=document.elementFromPoint(x,y)||document.body;' +
        // faithful sequence: pointerdown/mousedown carry buttons:1, the up/
        // click phase buttons:0; detail:1 and composed:true throughout so
        // capture-phase document listeners and shadow DOM delegates all fire
        'var base={bubbles:true,cancelable:true,composed:true,view:window,clientX:x,clientY:y,button:0,detail:1};' +
        'var dn=Object.assign({},base,{buttons:1,pointerId:1,pointerType:"touch",isPrimary:true,pressure:0.5});' +
        'var up=Object.assign({},base,{buttons:0,pointerId:1,pointerType:"touch",isPrimary:true,pressure:0});' +
        'try{el.dispatchEvent(new PointerEvent("pointerdown",dn))}catch(e){}' +
        'try{el.dispatchEvent(new MouseEvent("mousedown",dn))}catch(e){}' +
        'var ed=null,n=el;while(n&&n.tagName){var t=n.tagName;' +
        'if(n.isContentEditable||t==="INPUT"||t==="TEXTAREA"||t==="SELECT"){ed=n;break}n=n.parentElement}' +
        'if(ed){try{ed.focus()}catch(e){}}' +
        'try{el.dispatchEvent(new PointerEvent("pointerup",up))}catch(e){}' +
        'try{el.dispatchEvent(new MouseEvent("mouseup",up))}catch(e){}' +
        'try{if(typeof el.click==="function")el.click();else el.dispatchEvent(new MouseEvent("click",up))}catch(e){}' +
        'return ed?"editable":"tapped"}catch(e){return "err"}})(' +
        local.x + ',' + local.y + ',' + w + ')';
      try {
        Promise.resolve(wv.executeJavaScript(js)).then(function (res) {
          if (res === 'editable') {
            try { wv.focus(); } catch (e) {}   // real keystrokes → guest
          } else {
            try { wv.blur(); } catch (e) {}    // guest must not hold focus
          }
        }).catch(function () {});
      } catch (e) {}
    }

    function readNativeSelectAt(local) {
      var wv = el.page;
      if (!wv || !state.webviewReady || typeof wv.executeJavaScript !== 'function') {
        return Promise.resolve(null);
      }
      var w = (state.contentViewport && state.contentViewport.width) ||
              (state.device && state.device.viewport.width) || 0;
      var js = '(function(x,y,w){try{' +
        'var k=(w&&window.innerWidth)?(window.innerWidth/w):1;' +
        'x=Math.round(x*k);y=Math.round(y*k);' +
        'var el=document.elementFromPoint(x,y);' +
        'for(var n=el;n&&n.tagName;n=n.parentElement){' +
          'if(n.tagName==="SELECT"){' +
            'if(n.disabled)return{kind:"select",disabled:true};' +
            'var store=window.__DEVPHONE_SELECT_TARGETS__||(window.__DEVPHONE_SELECT_TARGETS__={});' +
            'var id=n.__devphoneSelectId||(n.__devphoneSelectId=("sel-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2)));' +
            'store[id]=n;' +
            'var clean=function(s){return String(s||"").replace(/\\s+/g," ").trim()};' +
            'var label=clean(n.getAttribute("aria-label")||n.getAttribute("title")||"");' +
            'if(!label&&n.id){var labs=document.querySelectorAll("label[for]");' +
              'for(var i=0;i<labs.length;i++){if(labs[i].getAttribute("for")===n.id){label=clean(labs[i].textContent);break}}}' +
            'if(!label){var wrap=n.closest&&n.closest("label");if(wrap)label=clean(wrap.textContent.replace(n.textContent,""))}' +
            'if(!label)label=clean(n.name||"Select");' +
            'var opts=[];for(var j=0;j<n.options.length&&opts.length<200;j++){' +
              'var o=n.options[j],p=o.parentElement;' +
              'if(o.hidden)continue;' +
              'opts.push({index:j,text:clean(o.label||o.text||o.value),value:String(o.value||""),' +
                'selected:!!o.selected,disabled:!!(o.disabled||(p&&p.tagName==="OPTGROUP"&&p.disabled)),' +
                'group:(p&&p.tagName==="OPTGROUP")?clean(p.label):""});' +
            '}' +
            'return{kind:"select",id:id,label:label,multiple:!!n.multiple,selectedIndex:n.selectedIndex,options:opts};' +
          '}' +
        '}' +
        'return null;' +
      '}catch(e){return{kind:"error",error:String(e&&e.message||e)}}})(' +
        local.x + ',' + local.y + ',' + w + ')';
      try {
        return Promise.resolve(wv.executeJavaScript(js)).catch(function () { return null; });
      } catch (e) {
        return Promise.resolve(null);
      }
    }

    function closeNativeSelectPicker() {
      var sheet = el.sheetLayer;
      if (!sheet) return;
      sheet.classList.remove('show');
      sheet.classList.remove('native-select-open');
      setTimeout(function () {
        if (!sheet.classList.contains('show')) {
          sheet.hidden = true;
          sheet.innerHTML = '';
        }
      }, 220);
    }

    function commitNativeSelectChoice(info, optIndex, keepOpen, button) {
      var wv = el.page;
      if (!wv || !state.webviewReady || typeof wv.executeJavaScript !== 'function') return;
      var js = '(function(id,idx){try{' +
        'var store=window.__DEVPHONE_SELECT_TARGETS__||{};var sel=store[id];' +
        'if(!sel||sel.tagName!=="SELECT")return{ok:false,error:"target missing"};' +
        'var opt=sel.options[idx];if(!opt||opt.disabled)return{ok:false,error:"option unavailable"};' +
        'var p=opt.parentElement;if(p&&p.tagName==="OPTGROUP"&&p.disabled)return{ok:false,error:"group disabled"};' +
        'if(sel.multiple){opt.selected=!opt.selected}else{sel.selectedIndex=idx}' +
        'sel.dispatchEvent(new Event("input",{bubbles:true}));' +
        'sel.dispatchEvent(new Event("change",{bubbles:true}));' +
        'return{ok:true,selected:!!opt.selected,value:sel.value};' +
      '}catch(e){return{ok:false,error:String(e&&e.message||e)}}})(' +
        JSON.stringify(info.id) + ',' + Number(optIndex) + ')';
      try {
        Promise.resolve(wv.executeJavaScript(js)).then(function (res) {
          if (!res || res.ok === false) {
            toast('Selection failed', 1800);
            return;
          }
          if (keepOpen && button) {
            button.classList.toggle('selected', !!res.selected);
            var mark = button.querySelector('.ns-check');
            if (mark) mark.innerHTML = res.selected ? '&#10003;' : '';
          } else {
            closeNativeSelectPicker();
          }
        }).catch(function () { toast('Selection failed', 1800); });
      } catch (e) {
        toast('Selection failed', 1800);
      }
    }

    function openNativeSelectPicker(info) {
      var sheet = el.sheetLayer;
      if (!sheet || !info || !info.options || !info.options.length) return false;
      var android = state.device && state.device.os === 'android';
      var options = info.options.map(function (o) {
        return '<button class="ns-option' + (o.selected ? ' selected' : '') + '" data-idx="' + o.index + '"' +
          (o.disabled ? ' disabled' : '') + '>' +
          '<span class="ns-text">' +
            (o.group ? '<span class="ns-group">' + esc(o.group) + '</span>' : '') +
            '<span>' + esc(o.text || o.value || 'Option') + '</span>' +
          '</span>' +
          '<span class="ns-check">' + (o.selected ? '&#10003;' : '') + '</span>' +
        '</button>';
      }).join('');
      sheet.hidden = false;
      sheet.classList.remove('show');
      sheet.classList.add('native-select-open');
      sheet.innerHTML =
        '<div class="native-select-backdrop"></div>' +
        '<div class="native-select ' + (android ? 'ns-android' : 'ns-ios') + '">' +
          (android ? '' : '<div class="ns-grab"></div>') +
          '<div class="ns-title">' + esc(info.label || 'Select') + '</div>' +
          '<div class="ns-options">' + options + '</div>' +
          (android ? '' : '<button class="ns-cancel">Cancel</button>') +
        '</div>';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { sheet.classList.add('show'); });
      });
      var close = function (e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        closeNativeSelectPicker();
      };
      var backdrop = sheet.querySelector('.native-select-backdrop');
      if (backdrop) backdrop.addEventListener('click', close);
      var cancel = sheet.querySelector('.ns-cancel');
      if (cancel) cancel.addEventListener('click', close);
      sheet.querySelectorAll('.ns-option').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          commitNativeSelectChoice(info, btn.getAttribute('data-idx'), !!info.multiple, btn);
        });
      });
      try { el.page.blur(); } catch (e) {}
      return true;
    }

    function tapGuest(local) {
      readNativeSelectAt(local).then(function (info) {
        if (info && info.kind === 'select') {
          if (info.disabled) return;
          if (openNativeSelectPicker(info)) return;
        }
        syntheticTap(local);
      });
    }

    // synthetic in-guest scrolling (see the block comment above): find the
    // element under the point, walk up consuming the delta on scrollable
    // ancestors, hand any leftover to the window. Coordinates/deltas are
    // widget CSS px; the guest maps them to page px (k) like syntheticTap.
    function scrollGuest(local, dx, dy) {
      var wv = el.page;
      if (!wv || !state.webviewReady || typeof wv.executeJavaScript !== 'function') return;
      var w = (state.contentViewport && state.contentViewport.width) ||
              (state.device && state.device.viewport.width) || 0;
      var js = '(function(x,y,dx,dy,w){try{' +
        'var k=(w&&window.innerWidth)?(window.innerWidth/w):1;' +
        'x=Math.round(x*k);y=Math.round(y*k);dx*=k;dy*=k;' +
        'var e=document.elementFromPoint(x,y),rx=dx,ry=dy;' +
        'while(e&&e!==document.body&&e!==document.documentElement&&(Math.abs(rx)>=1||Math.abs(ry)>=1)){' +
          'var s;try{s=getComputedStyle(e)}catch(_){break}' +
          'if(ry&&(s.overflowY==="auto"||s.overflowY==="scroll"||s.overflowY==="overlay")&&e.scrollHeight>e.clientHeight){' +
            'var t=e.scrollTop;e.scrollTop=t+ry;ry-=e.scrollTop-t}' +
          'if(rx&&(s.overflowX==="auto"||s.overflowX==="scroll"||s.overflowX==="overlay")&&e.scrollWidth>e.clientWidth){' +
            'var l=e.scrollLeft;e.scrollLeft=l+rx;rx-=e.scrollLeft-l}' +
          'e=e.parentElement}' +
        'if(Math.abs(rx)>=1||Math.abs(ry)>=1)window.scrollBy(rx,ry);' +
        '}catch(_){}})(' + local.x + ',' + local.y + ',' + dx + ',' + dy + ',' + w + ')';
      try { Promise.resolve(wv.executeJavaScript(js)).catch(function () {}); } catch (e) {}
    }

    // picker hover (touch mode): Electron 36's touch emulator SWALLOWS
    // forwarded sendInputEvent mouseMoves — no DOM mousemove ever reaches the
    // page (verified: scratch/probe-picker-e36.js), so the picker's
    // DevTools-style highlight box never drew. While the picker is armed,
    // hover moves are therefore dispatched synthetically INSIDE the guest
    // (same executeJavaScript + elementFromPoint pattern as syntheticTap),
    // coalesced to one eval per ~16ms. Mouse input mode keeps raw forwarding
    // — without touch emulation the forwarded moves still arrive (probe-
    // verified). Normal forwarding resumes by itself once the picker disarms:
    // every move re-checks state.pickerOn, which the picker:result listener
    // (and the rail toggle) reset.
    function syntheticMove(local) {
      var wv = el.page;
      if (!wv || !state.webviewReady || typeof wv.executeJavaScript !== 'function') return;
      var w = (state.contentViewport && state.contentViewport.width) ||
              (state.device && state.device.viewport.width) || 0;
      var js = '(function(x,y,w){try{' +
        'var k=(w&&window.innerWidth)?(window.innerWidth/w):1;' +
        'x=Math.round(x*k);y=Math.round(y*k);' +
        'var el=document.elementFromPoint(x,y)||document.documentElement;' +
        'var o={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,button:0,buttons:0};' +
        'try{el.dispatchEvent(new MouseEvent("mousemove",o))}catch(e){}' +
        '}catch(e){}})(' + local.x + ',' + local.y + ',' + w + ')';
      try { Promise.resolve(wv.executeJavaScript(js)).catch(function () {}); } catch (e) {}
    }
    var pickerMovePt = null, pickerMoveTimer = null;
    function queuePickerMove(local) {
      pickerMovePt = local;
      if (pickerMoveTimer) return;
      pickerMoveTimer = setTimeout(function () {
        pickerMoveTimer = null;
        var p = pickerMovePt;
        pickerMovePt = null;
        if (p && state.pickerOn) syntheticMove(p);
      }, 16);
    }

    /* v0.1.4: NATIVE scroll pipeline. Drag/wheel samples are batched per rAF
       and replayed in main on the GUEST's CDP debugger (Input.dispatchTouch-
       Event / Input.dispatchMouseEvent mouseWheel — see emulation.js
       dispatchGesture). That gives Chromium's real scroll physics: smooth
       tracking, momentum FLING from release velocity, rubber-band-style
       feel, and proper touchmove events to the page. CDP injects directly
       into the guest renderer, so the window-wide capture trap that real
       forwarded input arms under touch emulation can not return.
       The synthetic in-guest scrollBy above stays as the AUTOMATIC FALLBACK:
       the first {ok:false} from guest:gesture (debugger detached, channel
       missing, …) flips gestureBroken and every later drag/wheel takes the
       old path. WebKit engine is untouched (its canvas pipeline below).     */
    var gestureBroken = false;
    var samplesPending = [];
    var samplesScheduled = false;

    function sendSampleBatch(batch) {
      invoke('guest:gesture', { samples: batch }).then(function (res) {
        if (res && res.ok !== false) return;
        gestureBroken = true;
        // recover the ground this failed batch covered via the old path
        var touches = batch.filter(function (s) {
          return s.phase === 'start' || s.phase === 'move';
        });
        if (touches.length >= 2) {
          var a = touches[0], b = touches[touches.length - 1];
          // finger up (y shrinking) scrolls content down → invert the path
          scrollGuest({ x: b.x, y: b.y }, a.x - b.x, a.y - b.y);
        }
        batch.forEach(function (s) {
          if (s.phase === 'wheel') scrollGuest({ x: s.x, y: s.y }, s.dx, s.dy);
        });
      });
    }

    function flushSamples() {
      if (!samplesPending.length) return;
      var batch = samplesPending;
      samplesPending = [];
      sendSampleBatch(batch);
    }

    // batched per animation frame: one IPC round-trip per frame, real
    // per-move timestamps preserved (fling velocity comes from them).
    // flushNow (gesture end / wheel) ships immediately — release timing
    // must not lag a frame behind or the fling velocity reads stale.
    function queueSample(s, flushNow) {
      samplesPending.push(s);
      if (flushNow) { flushSamples(); return; }
      if (samplesScheduled) return;
      samplesScheduled = true;
      requestAnimationFrame(function () {
        samplesScheduled = false;
        flushSamples();
      });
    }

    // wheel: per-frame EASED steps instead of raw ticks (DOM-signed deltas —
    // positive deltaY scrolls content down; see emulation.js). A CDP
    // mouseWheel applies its whole delta INSTANTLY — Chromium's own smooth
    // wheel-scroll animation never runs for injected events — so forwarding
    // a mouse wheel's ~100px ticks 1:1 landed as one visible jump per tick:
    // the "choppy scrolling". The animator accumulates incoming deltas and
    // drains them with an exponential ease-out (~28%/frame, ≥16px/frame),
    // one small mouseWheel per frame, which reads like native smooth scroll.
    // Distance is preserved exactly; new ticks fold into a running drain.
    var wheelAnim = null;   // {x, y, rx, ry} remaining deltas at last point
    function pumpWheel() {
      var a = wheelAnim;
      if (!a) return;
      if (gestureBroken) {  // native path died mid-drain → recover the rest
        wheelAnim = null;
        if (Math.abs(a.rx) >= 0.5 || Math.abs(a.ry) >= 0.5) {
          queueGuestScroll({ x: a.x, y: a.y }, a.rx, a.ry);
        }
        return;
      }
      var step = function (rest) {
        var mag = Math.abs(rest);
        if (mag < 0.5) return rest;               // final crumb, all at once
        return (rest < 0 ? -1 : 1) * Math.min(mag, Math.max(16, mag * 0.28));
      };
      var dx = step(a.rx), dy = step(a.ry);
      a.rx -= dx;
      a.ry -= dy;
      if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
        queueSample({ phase: 'wheel', x: a.x, y: a.y, dx: dx, dy: dy, t: Date.now() }, true);
      }
      if (Math.abs(a.rx) >= 0.5 || Math.abs(a.ry) >= 0.5) requestAnimationFrame(pumpWheel);
      else wheelAnim = null;
    }
    function queueNativeWheel(local, dx, dy) {
      if (gestureBroken) { queueGuestScroll(local, dx, dy); return; }
      if (wheelAnim) {      // drain in progress — fold the new tick in
        wheelAnim.x = local.x;
        wheelAnim.y = local.y;
        wheelAnim.rx += dx;
        wheelAnim.ry += dy;
        return;
      }
      wheelAnim = { x: local.x, y: local.y, rx: dx, ry: dy };
      pumpWheel();          // first step ships NOW — no added latency
    }

    // coalesce per-pointermove deltas into ~16ms batches (one in-guest eval
    // per tick instead of one per move; fast flicks stay smooth) — FALLBACK
    // path only (gestureBroken), plus wheel recovery above.
    var scrollAcc = null, scrollTimer = null;
    function queueGuestScroll(local, dx, dy) {
      if (!scrollAcc) scrollAcc = { x: local.x, y: local.y, dx: 0, dy: 0 };
      scrollAcc.x = local.x;
      scrollAcc.y = local.y;
      scrollAcc.dx += dx;
      scrollAcc.dy += dy;
      if (!scrollTimer) {
        scrollTimer = setTimeout(function () {
          scrollTimer = null;
          var a = scrollAcc;
          scrollAcc = null;
          if (a && (Math.abs(a.dx) >= 0.5 || Math.abs(a.dy) >= 0.5)) {
            scrollGuest({ x: a.x, y: a.y }, a.dx, a.dy);
          }
        }, 16);
      }
    }

    var press = null;       // {t, lastX, lastY, mouse} while a button is down
    var movedPx = 0;
    var lastHover = 0;

    layer.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (press) {
        // the previous gesture never delivered its pointerup/cancel (input
        // streams on this transparent frameless window sporadically drop
        // events) — close it out instead of letting the stale press eat
        // this gesture: the next tap would otherwise be swallowed whole.
        if (press.drag && !gestureBroken) {
          queueSample({ phase: 'cancel', x: press.lastX, y: press.lastY, t: Date.now() }, true);
        } else if (press.mouse) {
          var mu = localXY(e);
          sendToGuest({ type: 'mouseUp', x: mu.x, y: mu.y, button: 'left', clickCount: 1 });
        }
        press = null;
      }
      e.preventDefault();
      try { layer.setPointerCapture(e.pointerId); } catch (err) {}
      if (state.inputMode === 'mouse') {
        press = { mouse: true };
        var p = localXY(e);
        sendToGuest({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
        return;
      }
      press = {
        t: Date.now(),
        lastX: e.clientX, lastY: e.clientY,
        startLocal: localXY(e),   // touchStart anchor for the native gesture
        drag: false               // becomes a drag once movedPx > 8
      };
      movedPx = 0;
    });

    layer.addEventListener('pointermove', function (e) {
      if (!press) {
        // picker armed under touch emulation: forwarded mouseMoves never
        // become DOM events in E36 — dispatch the hover inside the guest
        if (state.pickerOn && state.inputMode !== 'mouse') {
          queuePickerMove(localXY(e));
          return;
        }
        var now = Date.now();
        if (now - lastHover < 25) return;
        lastHover = now;
        var h = localXY(e);
        sendToGuest({ type: 'mouseMove', x: h.x, y: h.y });
        return;
      }
      if (press.mouse) {
        var m = localXY(e);
        sendToGuest({ type: 'mouseMove', x: m.x, y: m.y, button: 'left', modifiers: ['leftButtonDown'] });
        return;
      }
      var dx = e.clientX - press.lastX;
      var dy = e.clientY - press.lastY;
      press.lastX = e.clientX;
      press.lastY = e.clientY;
      movedPx += Math.abs(dx) + Math.abs(dy);
      if (movedPx > 8 && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) {
        if (gestureBroken) {
          var s = state.scale || 1;
          // fallback: synthetic in-guest scroll; dragging the finger UP
          // (dy < 0) must scroll the content DOWN → negate.
          queueGuestScroll(localXY(e), -dx / s, -dy / s);
          return;
        }
        // native path: replay the finger itself (touchStart at the original
        // press point, then the real move trail with real timestamps) —
        // Chromium's gesture recognizer does direction/physics/fling.
        if (!press.drag) {
          press.drag = true;
          queueSample({ phase: 'start', x: press.startLocal.x, y: press.startLocal.y, t: press.t });
        }
        var lp = localXY(e);
        queueSample({ phase: 'move', x: lp.x, y: lp.y, t: Date.now() });
      }
    });

    function endPress(e) {
      if (!press) return;
      var wasMouse = press.mouse;
      var wasDrag = press.drag;
      var dt = Date.now() - (press.t || 0);
      var tap = !wasMouse && movedPx < 8 && dt < 700;
      press = null;
      if (wasMouse) {
        var p = localXY(e);
        sendToGuest({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
        return;   // mouse mode: no touch emulation → no capture trap
      }
      if (tap) { tapGuest(localXY(e)); return; }   // select taps get a native-style picker
      if (wasDrag && !gestureBroken) {
        // terminate the native touch sequence NOW (flushed immediately) —
        // Chromium computes the fling velocity at this exact moment
        var lp = localXY(e);
        queueSample({
          phase: e.type === 'pointercancel' ? 'cancel' : 'end',
          x: lp.x, y: lp.y, t: Date.now()
        }, true);
        // real touch inside the guest re-arms the browser-level mouse
        // capture (the guest grabs capture+focus once it processes real
        // input — same trap as v0.1.2, measured: the NEXT shell click was
        // routed into the guest, shell DOM saw nothing). Heal proactively
        // like the tap beacon does: blur the guest unless it is editing.
        // The momentum fling is compositor-driven and survives the blur
        // (verified: the gesture suite's fling samples keep growing).
        setTimeout(guestBlurUnlessEditing, 140);
      }
      // fallback scroll gestures need no cleanup: nothing pulled guest focus
    }
    layer.addEventListener('pointerup', function (e) {
      if (e.button !== 0) return;
      endPress(e);
    });
    layer.addEventListener('pointercancel', function (e) { endPress(e); });

    layer.addEventListener('wheel', function (e) {
      e.preventDefault();
      var s = state.scale || 1;
      // both sides are DOM-signed → apply 1:1 (descaled by visual zoom).
      // Native CDP mouseWheel in BOTH input modes; synthetic fallback inside.
      queueNativeWheel(localXY(e), e.deltaX / s, e.deltaY / s);
    }, { passive: false });
  }

  function parseScrollPayload(s) {
    try {
      var v = JSON.parse(s);
      if (typeof v === 'number') return v;
      if (v && typeof v.y === 'number') return v.y;
    } catch (e) {
      var n = parseFloat(s);
      if (!isNaN(n)) return n;
    }
    return null;
  }

  function onNavigated(url, inPage) {
    state.url = url || '';
    if (!inPage) { state.themeColor = null; applyStatusTheme(); }
    updateNavState();
    bus.emit('navigated', { url: state.url, inPage: !!inPage });
  }

  function updateNavState() {
    if (state.engine === 'chromium' && state.webviewReady) {
      try {
        state.canGoBack = el.page.canGoBack();
        state.canGoForward = el.page.canGoForward();
      } catch (e) {}
    }
    bus.emit('navstate');
  }

  function navigate(url) {
    state.url = url;
    bus.emit('willnavigate', { url: url });
    if (state.engine === 'webkit') { invoke('nav', { action: 'go', url: url }); return; }
    var wv = el.page;
    try {
      if (state.webviewReady && typeof wv.loadURL === 'function') wv.loadURL(url);
      else wv.setAttribute('src', url);
    } catch (e) {
      try { wv.setAttribute('src', url); } catch (e2) { console.warn('[DevPhone] navigate failed', e2); }
    }
  }

  function navAction(action) {
    if (state.engine === 'webkit') { invoke('nav', { action: action }); return; }
    var wv = el.page;
    if (!state.webviewReady) return;
    try {
      if (action === 'back') wv.goBack();
      else if (action === 'forward') wv.goForward();
      else if (action === 'reload') wv.reload();
      else if (action === 'hardReload') {
        invoke('nav', { action: 'hardReload' }).then(function (res) {
          if (res && res.ok !== false) return;
          try {
            if (typeof wv.reloadIgnoringCache === 'function') wv.reloadIgnoringCache();
            else wv.reload();
          } catch (e) { console.warn('[DevPhone] hard reload fallback failed', e); }
        });
      }
    } catch (e) { console.warn('[DevPhone] navAction ' + action + ' failed', e); }
  }

  /* ---------- WebKit engine: canvas painting + input forwarding ------------- */

  function wireCanvas() {
    var c = el.webkitCanvas;
    if (!c) return;
    var ctx = c.getContext('2d');
    var img = new Image();
    var pending = null, drawing = false;

    // The engine streams frames of VARYING sizes (fast CSS-scale frames mixed
    // with occasional sharp full-DPR ones). The canvas backing store is kept
    // at a FIXED target size derived from the content viewport — never from
    // the incoming frame — and every frame is scaled onto it with high-quality
    // smoothing, so sharp/fast frames can alternate without any flicker.
    function targetSize() {
      var cv = state.contentViewport ||
               (state.device && state.device.viewport) || null;
      var w = cv ? cv.width : (c.clientWidth || 390);
      var h = cv ? cv.height : (c.clientHeight || 700);
      var dpr = Math.max(1, Math.min(3, (state.device && state.device.dpr) || 2));
      return {
        w: Math.max(1, Math.round(w * dpr)),
        h: Math.max(1, Math.round(h * dpr))
      };
    }

    img.onload = function () {
      var t = targetSize();
      if (c.width !== t.w || c.height !== t.h) {  // resize only on layout change
        c.width = t.w;
        c.height = t.h;
      }
      try {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, c.width, c.height);
      } catch (e) {}
      next();
    };
    img.onerror = next;
    function next() {
      if (pending) { var u = pending; pending = null; img.src = u; }
      else drawing = false;
    }
    listen('webkit:frame', function (payload) {
      var u = typeof payload === 'string' ? payload : (payload && payload.dataUrl);
      if (!u) return;
      if (drawing) pending = u;
      else { drawing = true; img.src = u; }
    });

    // -- input forwarding (coordinates in CONTENT viewport CSS px — the
    //    engine's emulated viewport matches the honest content area)
    function vpPoint(ev) {
      var r = c.getBoundingClientRect();
      var cv = state.contentViewport || (state.device && state.device.viewport) || null;
      var vw = cv ? cv.width : r.width;
      var vh = cv ? cv.height : r.height;
      return {
        x: Math.max(0, Math.min(vw, (ev.clientX - r.left) * vw / r.width)),
        y: Math.max(0, Math.min(vh, (ev.clientY - r.top) * vh / r.height))
      };
    }

    var press = null, movedPx = 0;
    var wheelAccum = 0, wheelPt = null, wheelTimer = null;
    function queueWheel(pt, dy, dx) {
      wheelAccum += dy;
      wheelPt = pt;
      if (!wheelTimer) {
        wheelTimer = setTimeout(function () {
          wheelTimer = null;
          if (Math.abs(wheelAccum) > 0.5 && wheelPt) {
            invoke('webkit:input', { type: 'wheel', x: wheelPt.x, y: wheelPt.y, dx: dx || 0, dy: wheelAccum });
          }
          wheelAccum = 0;
        }, 16);
      }
    }

    c.addEventListener('pointerdown', function (ev) {
      c.focus();
      press = { t: Date.now(), p: vpPoint(ev), lastY: ev.clientY };
      movedPx = 0;
      try { c.setPointerCapture(ev.pointerId); } catch (e) {}
    });
    c.addEventListener('pointermove', function (ev) {
      if (!press) return;
      var dy = ev.clientY - press.lastY;
      press.lastY = ev.clientY;
      movedPx += Math.abs(dy) + Math.abs(ev.movementX || 0);
      if (Math.abs(dy) > 0.5) queueWheel(vpPoint(ev), -dy / (state.scale || 1));
    });
    c.addEventListener('pointerup', function () {
      if (!press) return;
      var dt = Date.now() - press.t;
      if (movedPx < 8 && dt < 700) {
        invoke('webkit:input', { type: 'tap', x: press.p.x, y: press.p.y });
      }
      press = null;
    });
    c.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var p = vpPoint(ev);
      invoke('webkit:input', { type: 'wheel', x: p.x, y: p.y, dx: ev.deltaX, dy: ev.deltaY });
    }, { passive: false });
    c.addEventListener('keydown', function (ev) {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      ev.preventDefault();
      if (ev.key && ev.key.length === 1) invoke('webkit:input', { type: 'type', text: ev.key });
      else invoke('webkit:input', { type: 'key', key: ev.key });
    });
  }

  function setEngine(mode) {
    if (mode === state.engine) return Promise.resolve();
    if (mode === 'webkit') {
      toast('🧭 Starting WebKit…');
      return invoke('engine:set', { mode: 'webkit' }).then(function (res) {
        if (!res || res.ok === false) {
          toast('⚠️ WebKit unavailable' + (res && res.error ? ' — ' + res.error : ''));
          updateEngineBtn();
          return;
        }
        state.engine = 'webkit';
        document.body.classList.add('engine-webkit');
        updateEngineBtn();
        toast('🧭 WebKit active', 2200);
      });
    }
    return invoke('engine:set', { mode: 'chromium' }).then(function () {
      state.engine = 'chromium';
      document.body.classList.remove('engine-webkit');
      updateEngineBtn();
      updateNavState();
      toast('⚡ Chromium active', 2200);
    });
  }

  function updateEngineBtn() {
    if (!el.btnEngine) return;
    var webkit = state.engine === 'webkit';
    el.btnEngine.firstChild.textContent = webkit ? '🧭' : '⚡';
    el.engineLabel.textContent = webkit ? 'WebKit' : 'Chromium';
    el.btnEngine.classList.toggle('active', webkit);
  }

  /* ---------- picker / screenshots / updater -------------------------------- */

  function togglePicker(force) {
    var on = (force != null) ? !!force : !state.pickerOn;
    state.pickerOn = on;
    if (el.btnPicker) el.btnPicker.classList.toggle('active', on);
    document.body.classList.toggle('picker-on', on);   // shell cursor = arrow
    invoke('picker:toggle', { on: on });
    if (on) toast('🎯 Tap an element on the page', 2200);
  }

  function takeShot(mode) {
    invoke('shot', { mode: mode }).then(function (res) {
      if (res && res.path) toast('📸 Saved to Pictures · copied', 2200);
      else toast('⚠️ Screenshot failed');
    });
  }

  function addDiscoveredDevices(list) {
    var added = 0;
    (list || []).forEach(function (d) {
      if (!d || !d.id) return;
      var exists = state.devices.some(function (x) { return x.id === d.id; });
      if (!exists) state.devices.push(d);
      state.newIds[d.id] = true;
      added++;
      toast('📱 ' + (d.label || d.id) + ' added (estimated)', 3500);
    });
    if (added) renderDevicePopover();
    return added;
  }

  /* ---------- device popover ------------------------------------------------ */

  // mini phone illustration (~22×38): body in the device accentColor, the
  // REAL cutout shape, a home-button dot only for classic-button bodies, and
  // the screen filled with that device's wallpaper colorway — phones are
  // recognizable at a glance.
  function miniPhoneSvg(d) {
    var gid = 'mp-' + String(d.id || '').replace(/[^a-z0-9]/gi, '');
    var classic = d.bodyStyle === 'classic-button';
    var scrY = classic ? 5.5 : 2.6;
    var scrH = classic ? 27 : 32.8;
    var rx = Math.max(1.5, Math.min(5, (d.cornerRadius || 0) / 14));
    var wp = wallpaperFor(d);
    var stops = wp.stops.map(function (c, i, arr) {
      var off = arr.length < 2 ? 0 : (i / (arr.length - 1));
      return '<stop offset="' + off.toFixed(2) + '" stop-color="' + c + '"/>';
    }).join('');
    var cut = '';
    if (d.cutout === 'dynamic-island') {
      cut = '<rect x="8" y="4.2" width="6" height="1.9" rx=".95" fill="#000"/>';
    } else if (d.cutout === 'punch-hole') {
      cut = '<circle cx="11" cy="4.9" r="1" fill="#000"/>';
    } else if (d.cutout === 'notch') {
      cut = (d.os === 'ios')
        ? '<rect x="7" y="2.6" width="8" height="2.1" rx="1.05" fill="#000"/>'      // wide iPhone notch
        : '<rect x="9.4" y="2.6" width="3.2" height="2.3" rx="1.15" fill="#000"/>'; // waterdrop
    }
    if (classic) {
      cut += '<circle cx="11" cy="35" r="1.3" fill="none" stroke="rgba(255,255,255,.4)" stroke-width=".7"/>';
    }
    return '<svg class="dev-mini" width="22" height="38" viewBox="0 0 22 38" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="1">' + stops + '</linearGradient></defs>' +
      '<rect x=".75" y=".75" width="20.5" height="36.5" rx="' + (rx + 2) + '" fill="' + esc(d.accentColor || '#2c2c2e') + '" stroke="rgba(255,255,255,.28)" stroke-width=".8"/>' +
      '<rect x="2.5" y="' + scrY + '" width="17" height="' + scrH + '" rx="' + rx + '" fill="url(#' + gid + ')"/>' +
      cut +
      '</svg>';
  }

  // pinned "check for new phones" row state
  var checkState = { phase: 'idle', msg: '' };

  function checkRowHtml() {
    if (checkState.phase === 'busy') {
      return '<span class="dc-ico spin">🔄</span><span class="dc-txt">Checking…</span>';
    }
    if (checkState.phase === 'done') {
      return '<span class="dc-ico">📡</span><span class="dc-txt">' + esc(checkState.msg) + '</span>';
    }
    return '<span class="dc-ico">🔄</span><span class="dc-txt">Check for new phones</span>';
  }

  function runUpdaterCheck() {
    if (checkState.phase === 'busy') return;
    checkState = { phase: 'busy', msg: '' };
    renderDevicePopover();
    invoke('updater:check').then(function (res) {
      var n = (res && res.added) ? res.added.length : 0;
      if (n) addDiscoveredDevices(res.added);
      var msg;
      if (!res) msg = 'Check failed — engine offline?';
      else if (n) msg = '+' + n + ' new phone' + (n > 1 ? 's' : '');
      else msg = 'Up to date';
      checkState = { phase: 'done', msg: msg };
      renderDevicePopover();
      setTimeout(function () {
        checkState = { phase: 'idle', msg: '' };
        if (el.devicePopover && !el.devicePopover.hidden) renderDevicePopover();
      }, 2600);
    });
  }

  function renderDevicePopover() {
    var pop = el.devicePopover;
    if (!pop) return;
    var rows = state.devices.map(function (d) {
      var cur = state.device && d.id === state.device.id;
      var badges = (state.newIds[d.id] ? '<em class="new-badge">NEW</em>' : '') +
                   (d.estimated ? '<em class="est-badge">est.</em>' : '');
      return '<button class="dev-row' + (cur ? ' current' : '') + '" data-id="' + esc(d.id) + '">' +
               miniPhoneSvg(d) +
               '<span class="dev-col">' +
                 '<span class="dev-name">' + esc(d.label) + badges + '</span>' +
                 '<span class="dev-sub">' + d.viewport.width + '×' + d.viewport.height +
                   ' @' + d.dpr + 'x · ' + (d.os === 'ios' ? 'iOS' : 'Android') + ' ' + esc(d.osVersion || '') +
                 '</span>' +
               '</span>' +
             '</button>';
    }).join('');
    pop.innerHTML =
      '<button class="dev-check" id="dev-check-row"' +
        (checkState.phase === 'busy' ? ' disabled' : '') + '>' + checkRowHtml() + '</button>' +
      rows;
  }

  function toggleDevicePopover(show) {
    var pop = el.devicePopover;
    if (!pop) return;
    var willShow = (show != null) ? show : pop.hidden;
    pop.hidden = !willShow;
    if (willShow) {
      renderDevicePopover();
      if (el.settingsPopover) el.settingsPopover.hidden = true;
    }
    updateCatcher();
  }

  /* ---------- control rail --------------------------------------------------- */

  function updateScaleBtn() {
    if (el.scaleLabel) el.scaleLabel.textContent = Math.round(state.scale * 100) + '%';
  }

  function wireRail() {
    if (el.btnMin) el.btnMin.addEventListener('click', function () { invoke('shell:minimize'); });
    if (el.btnClose) el.btnClose.addEventListener('click', function () { invoke('shell:close'); });

    // popover toggles react on MOUSEDOWN so the first press opens them even
    // when focus was elsewhere (no more "press twice")
    if (el.btnDevice) el.btnDevice.addEventListener('mousedown', function (e) {
      e.stopPropagation();
      toggleDevicePopover();
    });
    if (el.btnSettings) el.btnSettings.addEventListener('mousedown', function (e) {
      e.stopPropagation();
      toggleSettingsPopover();
    });

    if (el.devicePopover) el.devicePopover.addEventListener('click', function (e) {
      if (e.target.closest('#dev-check-row')) { runUpdaterCheck(); return; }
      var row = e.target.closest('.dev-row');
      if (!row) return;
      toggleDevicePopover(false);
      switchDevice(row.getAttribute('data-id'));
    });

    if (el.settingsPopover) el.settingsPopover.addEventListener('click', function (e) {
      if (e.target.closest('#set-aot')) { setAlwaysOnTop(!state.alwaysOnTop); return; }
      if (e.target.closest('#set-wkwin')) { openWebkitWindow(); return; }
      if (e.target.closest('#set-update')) { toggleSettingsPopover(false); if (window.dpUpdate) dpUpdate.check(); return; }
      var btn = e.target.closest('.set-seg button');
      if (!btn) return;
      var seg = btn.parentElement.getAttribute('data-set');
      if (seg === 'nav') setNav3(btn.getAttribute('data-v') === '3btn');
      else if (seg === 'addr') setAddrBar(btn.getAttribute('data-v'));
    });

    // close popovers on the FIRST press anywhere else (mousedown, not click)
    document.addEventListener('mousedown', function (e) {
      if (el.devicePopover && !el.devicePopover.hidden &&
          !el.devicePopover.contains(e.target) &&
          !(el.btnDevice && el.btnDevice.contains(e.target))) {
        toggleDevicePopover(false);
      }
      if (el.settingsPopover && !el.settingsPopover.hidden &&
          !el.settingsPopover.contains(e.target) &&
          !(el.btnSettings && el.btnSettings.contains(e.target))) {
        toggleSettingsPopover(false);
      }
    });

    if (el.btnEngine) el.btnEngine.addEventListener('click', function () {
      setEngine(state.engine === 'webkit' ? 'chromium' : 'webkit');
    });

    if (el.btnInput) el.btnInput.addEventListener('click', function () {
      setInputMode(state.inputMode === 'mouse' ? 'touch' : 'mouse', true);
    });

    if (el.btnScale) el.btnScale.addEventListener('click', function () {
      var i = SCALES.indexOf(state.scale);
      state.scale = SCALES[(i + 1) % SCALES.length];
      try { localStorage.setItem('devphone.scale', String(state.scale)); } catch (e) {}
      updateScaleBtn();
      layout();
    });

    if (el.btnPicker) el.btnPicker.addEventListener('click', function () { togglePicker(); });
    if (el.btnShotScreen) el.btnShotScreen.addEventListener('click', function () { takeShot('screen'); });
    if (el.btnShotDevice) el.btnShotDevice.addEventListener('click', function () { takeShot('device'); });
    if (el.btnHome) el.btnHome.addEventListener('click', function () { goHome(); });
    if (el.hwHomeButton) el.hwHomeButton.addEventListener('click', function () { goHome(); });

    // v1: the contract's device:set only accepts {deviceId} — no orientation
    // parameter — so rotation is hidden until the engine supports it.
    if (el.btnRotate) el.btnRotate.style.display = 'none';

    window.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault(); togglePicker();
      } else if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
        e.preventDefault(); takeShot('screen');
      } else if (e.ctrlKey && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
        e.preventDefault(); navAction('hardReload');
      }
    });
  }

  /* ---------- click-through over invisible regions (v0.1.5) --------------------
     The OS window is a big transparent rectangle: phone + shadow margin +
     gap + rail + the MIN_WIN_H slack above/below. Those invisible areas used
     to swallow clicks (and drag the window), blocking whatever sits behind
     DevPhone. Now the window ignores mouse events whenever the cursor is
     over nothing visible — clicks land on the window BEHIND, exactly like
     clicking beside any normal app. setIgnoreMouseEvents({forward:true})
     keeps mousemoves flowing while ignored, so the shell can re-arm itself
     the moment the cursor reaches the phone or the rail.
     Rules:
       · popover / context-menu open → whole window stays interactive (the
         click-catcher modality needs the outside click to CLOSE the menu)
       · a button is held (e.buttons) → no state change mid-press/drag
       · visible = #phone-wrap, the rail, popovers, ctx menu               */

  function wireClickThrough() {
    function overVisible(x, y) {
      // The auto-update popup (update.js) is a full-window modal — keep the
      // whole window interactive while it's up so its buttons are clickable.
      var dpu = document.getElementById('dpu-overlay');
      if (dpu && !dpu.hidden) return true;
      if (anyPopoverOpen()) return true;
      if (el.clickCatcher && !el.clickCatcher.hidden) return true;
      if (el.ctxMenu && !el.ctxMenu.hidden) return true;
      var n = document.elementFromPoint(x, y);
      if (!n || !n.closest) return false;
      return !!(n.closest('#phone-wrap') || n.closest('#sidebar-controls') ||
                n.closest('#device-popover') || n.closest('#settings-popover') ||
                n.closest('#ctx-menu'));
    }
    function apply(on) {
      if (state.clickThrough === on) return;
      state.clickThrough = on;
      invoke('shell:ignoreMouse', { on: on });
    }
    window.addEventListener('mousemove', function (e) {
      if (e.buttons) return;   // mid-press/drag — never flip while held
      apply(!overVisible(e.clientX, e.clientY));
    }, { passive: true });
    // safety: anything that opens UI re-arms the window immediately
    window.addEventListener('mousedown', function () { apply(false); }, true);
  }

  /* ---------- bezel window drag (v0.1.5) ---------------------------------------
     Grab the phone FRAME anywhere to move the window. The bezel can't be a
     CSS app-region: drag regions are HTCAPTION on Windows, which swallows
     bezel right-clicks (the v0.1.3 context-menu lesson). So the drag is
     manual: pointer capture on #phone, per-frame screen-coordinate deltas →
     shell:drag IPC → win.setPosition in main. The page area (#screen) and
     the home button keep their own behavior; the #stage shadow margin stays
     an app-region drag area as before.                                      */

  function wirePhoneDrag() {
    var ph = el.phone;
    if (!ph) return;
    var dragging = false;
    var scheduled = false;

    // NO coordinates in the pings: main samples the OS cursor itself
    // (screen.getCursorScreenPoint — ground truth). Event screenX/Y are
    // computed against a window origin that lags our own moves, and that
    // feedback made the phone slowly slide out from under the cursor on
    // long back-and-forth drags (v0.1.5 drift bug).
    function sendMove() {
      scheduled = false;
      if (!dragging) return;
      invoke('shell:drag', { phase: 'move' });
    }

    ph.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || dragging) return;
      // bezel/frame only — presses on the screen content (touch layer, bars,
      // home screen) and the SE home button are not window drags
      if (e.target.closest && (e.target.closest('#screen') || e.target.closest('#hw-home-button'))) return;
      dragging = true;
      document.body.classList.add('win-dragging');
      try { ph.setPointerCapture(e.pointerId); } catch (err) {}
      invoke('shell:drag', { phase: 'start' });
    });
    ph.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(sendMove);
      }
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('win-dragging');
      invoke('shell:drag', { phase: 'end' });
    }
    ph.addEventListener('pointerup', endDrag);
    ph.addEventListener('pointercancel', endDrag);
  }

  /* ---------- bezel context menu ----------------------------------------------
     Right-click on the phone BEZEL / edge / shadow margin → small custom menu
     with the always-on-top toggle (+ Minimize / Close). Not over the screen
     (pages own their own context behavior) and not over the rail buttons.   */

  function hideCtxMenu() {
    if (el.ctxMenu) el.ctxMenu.hidden = true;
  }

  function showCtxMenu(x, y) {
    var menu = el.ctxMenu;
    if (!menu) return;
    menu.innerHTML =
      '<button class="ctx-item" id="ctx-aot">📌 Always on top' +
        '<span class="ctx-check">' + (state.alwaysOnTop ? '✓' : '✗') + '</span></button>' +
      '<div class="ctx-sep"></div>' +
      '<button class="ctx-item" id="ctx-min">Minimize</button>' +
      '<button class="ctx-item" id="ctx-close">Close</button>';
    menu.hidden = false;
    // clamp inside the window
    var mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - mw - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - mh - 4)) + 'px';
    menu.querySelector('#ctx-aot').addEventListener('click', function () {
      hideCtxMenu();
      setAlwaysOnTop(!state.alwaysOnTop);
      toast(state.alwaysOnTop ? '📌 Always on top' : 'Always on top off', 1600);
    });
    menu.querySelector('#ctx-min').addEventListener('click', function () {
      hideCtxMenu();
      invoke('shell:minimize');
    });
    menu.querySelector('#ctx-close').addEventListener('click', function () {
      invoke('shell:close');
    });
  }

  function wireCtxMenu() {
    document.addEventListener('contextmenu', function (e) {
      // While the guest's touch emulation is active it hooks the WHOLE
      // window: the right-button down/up never reach the DOM and Chromium
      // synthesizes a keyboard-style contextmenu (button === -1) at the
      // FOCUSED element with bogus coordinates (verified:
      // scratch/probe-ctx2.js). A phone in touch mode has no in-page
      // right-click concept anyway, so a synthesized right-click always
      // opens the shell menu, anchored to the phone's top bezel. Real
      // (mouse-mode) right-clicks are scoped: bezel/edge/shadow margin
      // only — the screen and the rail keep their normal behavior.
      if (e.button !== -1) {
        var onScreen = e.target.closest && e.target.closest('#screen');
        var onRail = e.target.closest && (e.target.closest('#sidebar-controls') ||
                     e.target.closest('#device-popover') || e.target.closest('#settings-popover'));
        if (onScreen || onRail || (el.ctxMenu && el.ctxMenu.contains(e.target))) return;
        e.preventDefault();
        showCtxMenu(e.clientX, e.clientY);
        return;
      }
      e.preventDefault();
      var r = el.phoneWrap ? el.phoneWrap.getBoundingClientRect() : { left: 20, top: 20 };
      showCtxMenu(Math.round(r.left + 14), Math.round(r.top + 10));
    });
    document.addEventListener('mousedown', function (e) {
      if (el.ctxMenu && !el.ctxMenu.hidden && !el.ctxMenu.contains(e.target)) hideCtxMenu();
    }, true);
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideCtxMenu();
    });
  }

  /* ---------- main → renderer events ----------------------------------------- */

  function wireEngineEvents() {
    listen('picker:result', function () {
      state.pickerOn = false;
      if (el.btnPicker) el.btnPicker.classList.remove('active');
      document.body.classList.remove('picker-on');
      toast('Copied to clipboard', 1200);
    });

    listen('devices:new', function (payload) {
      var list = Array.isArray(payload) ? payload : (payload && payload.devices) || [];
      addDiscoveredDevices(list);
    });

    listen('page:meta', function (meta) {
      if (!meta) return;
      if (meta.url != null) state.url = meta.url;
      if (meta.title != null) state.title = meta.title;
      if (meta.canGoBack != null) state.canGoBack = !!meta.canGoBack;
      if (meta.canGoForward != null) state.canGoForward = !!meta.canGoForward;
      state.themeColor = meta.themeColor || null;
      applyStatusTheme();
      bus.emit('navigated', { url: state.url, meta: true });
      bus.emit('title', state.title);
      bus.emit('navstate');
    });

    listen('page:scroll', function (payload) {
      var y = (typeof payload === 'number') ? payload : (payload && payload.y);
      if (typeof y === 'number') bus.emit('scroll', y);
    });
  }

  /* ---------- focus fixes ("press twice" killers) ------------------------------ */

  function isTextualInput(t) {
    if (!t || t.tagName !== 'INPUT') return false;
    var ty = (t.getAttribute('type') || 'text').toLowerCase();
    return ty === 'text' || ty === 'search' || ty === 'url';
  }

  // approximate caret index for a click at clientX inside a text input.
  // Needed because the shell's input arrives with TOUCH-tap semantics (the
  // guest touch emulation hooks the whole window): a tap on selected text
  // KEEPS the selection instead of collapsing it, so we place the caret
  // ourselves. Handles text-align + padding + scroll + visual zoom.
  var caretCanvas = null;
  function caretIndexFromPoint(input, clientX) {
    var v = input.value || '';
    if (!v) return 0;
    try {
      var rect = input.getBoundingClientRect();
      var cs = getComputedStyle(input);
      if (!caretCanvas) caretCanvas = document.createElement('canvas');
      var ctx = caretCanvas.getContext('2d');
      ctx.font = (cs.fontWeight || '400') + ' ' + cs.fontSize + ' ' + cs.fontFamily;
      var visScale = (input.offsetWidth ? rect.width / input.offsetWidth : 1) || 1;
      var padL = parseFloat(cs.paddingLeft) || 0;
      var padR = parseFloat(cs.paddingRight) || 0;
      var inner = input.clientWidth - padL - padR;
      var textW = ctx.measureText(v).width;
      var startX;
      if (cs.textAlign === 'center') startX = padL + Math.max(0, (inner - textW) / 2);
      else if (cs.textAlign === 'right' || cs.textAlign === 'end') startX = padL + Math.max(0, inner - textW);
      else startX = padL;
      var x = (clientX - rect.left) / visScale - startX + (input.scrollLeft || 0);
      if (x <= 0) return 0;
      if (x >= textW) return v.length;
      for (var i = 1; i <= v.length; i++) {
        var w = ctx.measureText(v.slice(0, i)).width;
        if (w >= x) {
          var prev = ctx.measureText(v.slice(0, i - 1)).width;
          return (x - prev < w - x) ? i - 1 : i;
        }
      }
      return v.length;
    } catch (e) { return v.length; }
  }

  // INTENTIONALLY NOT focusing the guest. Any programmatic webview.focus()
  // (and any real click routed into the guest) arms the touch-emulation
  // mouse-capture trap that eats the next shell-bound click — see the
  // touch-layer block above wireWebview for the full story. The guest only
  // gains focus through a forwarded tap, and only KEEPS it while an editable
  // element is focused in the page.

  function wireFocusFixes() {
    // 1a) focus-follows-mouse: by the time the user clicks, the OS window is
    //     active, so the first click lands.
    var lastMove = 0;
    function activateIfNeeded() {
      // v0.1.5: never steal focus while the cursor is over an INVISIBLE
      // region — the user is working with the window behind DevPhone there.
      if (state.clickThrough) return;
      if (!document.hasFocus()) invoke('shell:activate');
    }
    window.addEventListener('mousemove', function () {
      var now = Date.now();
      if (now - lastMove < 150) return;
      lastMove = now;
      activateIfNeeded();
    }, { passive: true });

    // 1b) guest focus is managed by the touch-layer (see wireTouchLayer) —
    //     no mouseenter/mouseover focus juggling here. The old hover-based
    //     juggling could never work: while the guest held the capture, the
    //     shell received NO mouse events at all, so hover handlers were
    //     blind exactly when they were needed.

    // 1c) shell text inputs are DESKTOP-NATIVE in BOTH input modes (the
    //     Touch/Mouse toggle governs the PAGE only — these are shell UI).
    //     The guest's touch emulation hooks the whole window, so native
    //     behavior over shell inputs is unreliable (touch mode: taps keep
    //     selections, drags pan instead of selecting; and the old one-shot
    //     mouseup suppressor + caret-on-click collapsed real drag
    //     selections). Fix: the shell OWNS the entire interaction through
    //     pointer events — the native mouse layer on these inputs is
    //     suppressed — giving identical, desktop behavior in both modes:
    //       · first click into an unfocused input → select all
    //       · stationary second click → caret at the clicked character
    //       · press that MOVED >3px → live drag selection of an arbitrary
    //         range (never overridden afterwards)
    //       · double-click → word select · triple-click → select all
    function selectWordAt(input, idx) {
      var v = input.value || '';
      if (!v) return;
      var re = /[A-Za-z0-9_]/;
      var i = Math.max(0, Math.min(idx, v.length - 1));
      if (!re.test(v[i]) && i > 0 && re.test(v[i - 1])) i--;
      var a = i, b = i;
      if (re.test(v[i])) {
        while (a > 0 && re.test(v[a - 1])) a--;
        while (b < v.length && re.test(v[b])) b++;
      } else {
        b = i + 1;                       // lone separator char
      }
      try { input.setSelectionRange(a, b); } catch (e) {}
    }

    var sip = null;                                       // press in flight
    var lastClick = { el: null, time: 0, x: 0, y: 0, count: 0 };

    document.addEventListener('pointerdown', function (e) {
      var t = e.target;
      if (!isTextualInput(t) || e.button !== 0) { sip = null; return; }
      if (sip && sip.t === t) return;   // duplicate down for the same press
      var now = Date.now();
      if (lastClick.el === t && now - lastClick.time < 450 &&
          Math.abs(e.clientX - lastClick.x) < 6 && Math.abs(e.clientY - lastClick.y) < 6) {
        lastClick.count++;
      } else {
        lastClick = { el: t, count: 1 };
      }
      lastClick.time = now;
      lastClick.x = e.clientX;
      lastClick.y = e.clientY;
      sip = {
        t: t,
        idx: caretIndexFromPoint(t, e.clientX),
        x0: e.clientX, y0: e.clientY,
        moved: false,
        wasFocused: document.activeElement === t,
        count: lastClick.count
      };
      if (!sip.wasFocused) { try { t.focus(); } catch (err) {} }
      try { t.setPointerCapture(e.pointerId); } catch (err) {}
    }, true);

    document.addEventListener('pointermove', function (e) {
      if (!sip) return;
      if (!sip.moved &&
          Math.abs(e.clientX - sip.x0) <= 3 && Math.abs(e.clientY - sip.y0) <= 3) return;
      sip.moved = true;                                   // it's a DRAG now
      var cur = caretIndexFromPoint(sip.t, e.clientX);
      try {
        if (cur >= sip.idx) sip.t.setSelectionRange(sip.idx, cur, 'forward');
        else sip.t.setSelectionRange(cur, sip.idx, 'backward');
      } catch (err) {}
    }, true);

    function sipEnd(e) {
      if (!sip) return;
      var s = sip;
      sip = null;
      if (e.type === 'pointercancel' || s.moved) return;  // drag selection stands
      try {
        if (s.count >= 3) s.t.setSelectionRange(0, (s.t.value || '').length);
        else if (s.count === 2) selectWordAt(s.t, s.idx);
        else if (!s.wasFocused) s.t.select();             // first click → all
        else s.t.setSelectionRange(s.idx, s.idx);         // second click → caret
      } catch (err) {}
    }
    document.addEventListener('pointerup', sipEnd, true);
    document.addEventListener('pointercancel', sipEnd, true);

    // the controller above owns focus/selection — silence the native mouse
    // layer on shell text inputs so touch-emulated compat events (or native
    // mouse defaults) can't fight it. Other listeners still run.
    ['mousedown', 'mouseup', 'click', 'dblclick'].forEach(function (type) {
      document.addEventListener(type, function (e) {
        if (isTextualInput(e.target)) e.preventDefault();
      }, true);
    });

    // keyboard focus (Tab) still selects all, like desktop address bars
    document.addEventListener('focusin', function (e) {
      var t = e.target;
      if (!isTextualInput(t)) return;
      if (sip && sip.t === t) return;   // pointer controller decides this one
      try { t.select(); } catch (err) {}
    });
  }

  /* ---------- boot ------------------------------------------------------------ */

  function init() {
    cacheEls();
    wireRail();
    wireCatcher();
    wireWebview();
    wireTouchLayer();
    wireCanvas();
    wireGesture();
    wireEngineEvents();
    wireFocusFixes();
    wirePhoneDrag();
    wireClickThrough();
    wireCtxMenu();
    renderNavbar();
    startClock();

    // global settings (loaded before the first applyDevice)
    try { state.addrBar = localStorage.getItem('devphone.addrbar') === 'bottom' ? 'bottom' : 'top'; } catch (e) {}
    try { state.inputMode = localStorage.getItem('devphone.inputmode') === 'mouse' ? 'mouse' : 'touch'; } catch (e) {}
    document.body.classList.toggle('input-touch', state.inputMode === 'touch');
    updateInputBtn();
    // always-on-top: persisted globally, re-applied at boot
    try { state.alwaysOnTop = localStorage.getItem('devphone.alwaysontop') === '1'; } catch (e) {}
    if (state.alwaysOnTop) invoke('shell:alwaysOnTop', { on: true });

    invoke('devices:list').then(function (res) {
      var devices = res && res.devices;
      if (devices && devices.length) {
        state.devices = devices;
      } else {
        state.devices = [FALLBACK_DEVICE];
        toast('⚠️ Engine not connected — UI preview mode');
      }

      var savedScale = NaN;
      try { savedScale = parseFloat(localStorage.getItem('devphone.scale')); } catch (e) {}
      state.scale = SCALES.indexOf(savedScale) >= 0 ? savedScale : 1;

      var savedId = null;
      try { savedId = localStorage.getItem('devphone.device'); } catch (e) {}
      // selftest can pin a device: ?device=<id>
      try {
        var forcedId = new URLSearchParams(location.search).get('device');
        if (forcedId) savedId = forcedId;
      } catch (e) {}
      var device = null;
      state.devices.forEach(function (d) { if (d.id === savedId) device = d; });
      applyDevice(device || state.devices[0]);

      updateScaleBtn();
      updateEngineBtn();
      renderDevicePopover();
      if (DP.home) DP.home.show();

      // --selftest support: main hands us ?selftest=<url>
      var selftestUrl = null;
      try { selftestUrl = new URLSearchParams(location.search).get('selftest'); } catch (e) {}
      if (selftestUrl) {
        var opened = false;
        var openIt = function () {
          if (opened) return;
          opened = true;
          var d = state.device;
          var browser = (d && d.browsers && d.browsers[0]) || 'safari';
          if (DP.chrome) DP.chrome.open(browser, { url: selftestUrl });
          // optional engine override: ?engine=webkit
          try {
            var eng = new URLSearchParams(location.search).get('engine');
            if (eng === 'webkit') setTimeout(function () { setEngine('webkit'); }, 3000);
          } catch (e) {}
        };
        if (state.attached) openIt();
        else { bus.on('attached', openIt); setTimeout(openIt, 2500); }
      }
    });
  }

  /* ---------- export ----------------------------------------------------------- */

  window.DP = {
    state: state,
    bus: bus,
    invoke: invoke,
    listen: listen,
    toast: toast,
    esc: esc,
    fmtTime: fmtTime,
    fmtDate: fmtDate,
    luminance: luminance,
    navigate: navigate,
    navAction: navAction,
    goHome: goHome,
    wallpaper: wallpaperFor,
    applyStatusTheme: applyStatusTheme,
    updateHomeIndicator: updateHomeIndicator,
    layoutContent: layoutContent,
    sbHeight: sbHeight,
    settings: {
      getAddrBar: function () { return state.addrBar; },
      setAddrBar: setAddrBar,
      setNav3: setNav3,
      nav3On: nav3On
    },
    getWebview: function () { return el.page; }
    // DP.home / DP.chrome are attached by homescreen.js / browser-chrome.js
  };

  window.addEventListener('DOMContentLoaded', init);

})();
