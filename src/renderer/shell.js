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

  var PAD = 26;          // transparent margin around the phone (shadow room)
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
    'aluminum':       { top: 88, side: 19, bottom: 88, body: function ()  { return 58; } },
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
    contentViewport: null  // {width,height} of the honest content area (unscaled)
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
    ['stage', 'phone-wrap', 'phone', 'screen', 'page', 'webkit-canvas', 'homescreen',
     'startpage', 'browser-chrome', 'navbar', 'sheet-layer', 'statusbar', 'cutout',
     'home-indicator', 'home-gesture', 'open-anim-layer', 'glass', 'toasts',
     'sidebar-controls', 'device-popover', 'settings-popover',
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
    el.phone.style.setProperty('--scale', s);
    el.phoneWrap.style.width = Math.ceil(pw * s) + 'px';
    el.phoneWrap.style.height = Math.ceil(ph * s) + 'px';
    var w = Math.ceil(pw * s) + PAD * 2 + GAP + RAIL_W;
    var h = Math.max(Math.ceil(ph * s) + PAD * 2, MIN_WIN_H);
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
    pop.innerHTML = html;
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
      }
    });
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
    } catch (e) { console.warn('[DevPhone] navAction ' + action + ' failed', e); }
  }

  /* ---------- WebKit engine: canvas painting + input forwarding ------------- */

  function wireCanvas() {
    var c = el.webkitCanvas;
    if (!c) return;
    var ctx = c.getContext('2d');
    var img = new Image();
    var pending = null, drawing = false;

    img.onload = function () {
      if (c.width !== img.naturalWidth || c.height !== img.naturalHeight) {
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
      }
      try { ctx.drawImage(img, 0, 0); } catch (e) {}
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
  // right cutout hint, Samsung wallpaper-gradient screen vs dark iPhone glass
  function miniPhoneSvg(d) {
    var samsung = d.brand === 'samsung' || d.os === 'android';
    var gid = 'mp-' + String(d.id || '').replace(/[^a-z0-9]/gi, '');
    var none = d.cutout === 'none';
    var scrY = none ? 5.5 : 3;
    var scrH = none ? 27 : 32;
    var rx = Math.max(1.5, Math.min(5, (d.cornerRadius || 0) / 14));
    var stops = samsung
      ? '<stop offset="0" stop-color="#3a7bd5"/><stop offset=".55" stop-color="#7b4ddb"/><stop offset="1" stop-color="#c0467f"/>'
      : '<stop offset="0" stop-color="#2a3354"/><stop offset="1" stop-color="#0b0e1c"/>';
    var cut = '';
    if (d.cutout === 'dynamic-island') {
      cut = '<rect x="8" y="5" width="6" height="1.9" rx=".95" fill="#000"/>';
    } else if (d.cutout === 'punch-hole') {
      cut = '<circle cx="11" cy="5.6" r="1" fill="#000"/>';
    } else if (d.cutout === 'notch') {
      cut = '<rect x="7.5" y="3" width="7" height="2.2" rx="1.1" fill="#000"/>';
    } else {
      cut = '<circle cx="11" cy="35" r="1.3" fill="none" stroke="rgba(255,255,255,.4)" stroke-width=".7"/>';
    }
    return '<svg class="dev-mini" width="22" height="38" viewBox="0 0 22 38" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="1">' + stops + '</linearGradient></defs>' +
      '<rect x=".75" y=".75" width="20.5" height="36.5" rx="' + (rx + 2) + '" fill="' + esc(d.accentColor || '#2c2c2e') + '" stroke="rgba(255,255,255,.28)" stroke-width=".8"/>' +
      '<rect x="2.5" y="' + scrY + '" width="17" height="' + scrH + '" rx="' + rx + '" fill="url(#' + gid + ')"' +
        (samsung ? ' opacity=".85"' : '') + '/>' +
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
      }
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

  function wireFocusFixes() {
    // 1a) focus-follows-mouse: by the time the user clicks, the OS window is
    //     active, so the first click lands.
    var lastMove = 0;
    function activateIfNeeded() {
      if (!document.hasFocus()) invoke('shell:activate');
    }
    window.addEventListener('mousemove', function () {
      var now = Date.now();
      if (now - lastMove < 150) return;
      lastMove = now;
      activateIfNeeded();
    }, { passive: true });

    // 1b) guest/shell focus juggling
    function focusGuest() {
      var ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return; // don't steal from shell inputs
      if (!state.webviewReady || !state.app || state.engine !== 'chromium') return;
      var wv = el.page;
      if (wv && typeof wv.focus === 'function') {
        try { wv.focus(); } catch (e) {}
      }
    }
    function blurGuest() {
      var ae = document.activeElement;
      if (ae && ae === el.page && typeof ae.blur === 'function') {
        try { ae.blur(); } catch (e) {}
      }
    }
    // entering the screen / webview area → page owns the keyboard
    if (el.screen) el.screen.addEventListener('mouseenter', function () { activateIfNeeded(); focusGuest(); });
    if (el.page && typeof el.page.addEventListener === 'function') {
      el.page.addEventListener('mouseenter', function () { activateIfNeeded(); focusGuest(); });
    }
    // entering shell chrome / popovers / bars → shell owns the first click.
    // (mouseover bubbles, so this also works for #browser-chrome, whose root
    // is pointer-events:none with interactive children)
    [el.sidebarControls, el.devicePopover, el.settingsPopover, el.browserChrome,
     el.sheetLayer, el.navbar, el.homescreen].forEach(function (n) {
      if (!n) return;
      n.addEventListener('mouseover', function () { activateIfNeeded(); blurGuest(); });
    });

    // 1c) shell text inputs select-all on focus (and survive the mouseup that
    //     would normally collapse the selection)
    document.addEventListener('focusin', function (e) {
      var t = e.target;
      if (!t || t.tagName !== 'INPUT') return;
      var ty = (t.getAttribute('type') || 'text').toLowerCase();
      if (ty !== 'text' && ty !== 'search' && ty !== 'url') return;
      try { t.select(); } catch (err) {}
      var keepSel = function (ev) { ev.preventDefault(); t.removeEventListener('mouseup', keepSel); };
      t.addEventListener('mouseup', keepSel);
    });
  }

  /* ---------- boot ------------------------------------------------------------ */

  function init() {
    cacheEls();
    wireRail();
    wireWebview();
    wireCanvas();
    wireGesture();
    wireEngineEvents();
    wireFocusFixes();
    renderNavbar();
    startClock();

    // global settings (loaded before the first applyDevice)
    try { state.addrBar = localStorage.getItem('devphone.addrbar') === 'bottom' ? 'bottom' : 'top'; } catch (e) {}
    try { state.inputMode = localStorage.getItem('devphone.inputmode') === 'mouse' ? 'mouse' : 'touch'; } catch (e) {}
    updateInputBtn();

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
