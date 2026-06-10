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
    newIds: {}             // deviceId -> true for freshly discovered phones
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
     'startpage', 'browser-chrome', 'sheet-layer', 'statusbar', 'cutout',
     'home-indicator', 'home-gesture', 'open-anim-layer', 'glass', 'toasts',
     'sidebar-controls', 'device-popover', 'device-label', 'engine-label', 'scale-label',
     'hw-home-button',
     'btn-min', 'btn-close', 'btn-device', 'btn-engine', 'btn-scale', 'btn-picker',
     'btn-shot-screen', 'btn-shot-device', 'btn-rotate', 'btn-home', 'btn-updater'
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
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 350);
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
    if (!state.app) {
      darkText = false;                       // wallpapers are dark → white text
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

  function applyDevice(device) {
    state.device = device;
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
    bus.emit('device-changed', device);
  }

  function switchDevice(id) {
    var device = null;
    state.devices.forEach(function (d) { if (d.id === id) device = d; });
    if (!device || (state.device && state.device.id === id)) return;
    goHome(true);
    applyDevice(device);
    if (state.attached) invoke('device:set', { deviceId: device.id });
    delete state.newIds[id];
    renderDevicePopover();
    toast('📱 ' + device.label + ' — ' + device.viewport.width + '×' + device.viewport.height + ' @' + device.dpr + 'x');
  }

  /* ---------- home indicator / gesture ------------------------------------- */

  function updateHomeIndicator() {
    var d = state.device;
    var gesturePhone = d && d.cutout !== 'none';
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
            if (state.device) invoke('device:set', { deviceId: state.device.id });
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

    // -- input forwarding (coordinates in viewport CSS px = screen px / scale)
    function vpPoint(ev) {
      var r = c.getBoundingClientRect();
      var vw = state.device ? state.device.viewport.width : r.width;
      var vh = state.device ? state.device.viewport.height : r.height;
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
      toast('🧭 Starting WebKit (Playwright)…');
      return invoke('engine:set', { mode: 'webkit' }).then(function (res) {
        if (!res || res.ok === false) {
          toast('⚠️ WebKit unavailable' + (res && res.error ? ' — ' + res.error : ' — staying on Chromium'));
          updateEngineBtn();
          return;
        }
        state.engine = 'webkit';
        document.body.classList.add('engine-webkit');
        updateEngineBtn();
        toast('🧭 WebKit engine active — true Safari rendering');
      });
    }
    return invoke('engine:set', { mode: 'chromium' }).then(function () {
      state.engine = 'chromium';
      document.body.classList.remove('engine-webkit');
      updateEngineBtn();
      updateNavState();
      toast('⚡ Chromium engine active');
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
    invoke('picker:toggle', { on: on });
    if (on) toast('🎯 Picker armed — tap an element on the page');
  }

  function takeShot(mode) {
    invoke('shot', { mode: mode }).then(function (res) {
      if (res && res.path) toast('📸 Saved → ' + res.path + ' (also on clipboard)');
      else toast('⚠️ Screenshot failed — engine not ready?');
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
      toast('📱 ' + (d.label || d.id) + ' detected — added with estimated specs', 5000);
    });
    if (added) renderDevicePopover();
    return added;
  }

  /* ---------- device popover ------------------------------------------------ */

  function renderDevicePopover() {
    var pop = el.devicePopover;
    if (!pop) return;
    pop.innerHTML = state.devices.map(function (d) {
      var cur = state.device && d.id === state.device.id;
      var badges = (state.newIds[d.id] ? '<em class="new-badge">NEW</em>' : '') +
                   (d.estimated ? '<em class="est-badge">est.</em>' : '');
      return '<button class="dev-row' + (cur ? ' current' : '') + '" data-id="' + esc(d.id) + '">' +
               '<span class="dev-name">' + esc(d.label) + badges + '</span>' +
               '<span class="dev-sub">' + d.viewport.width + '×' + d.viewport.height +
                 ' @' + d.dpr + 'x · ' + (d.os === 'ios' ? 'iOS' : 'Android') + ' ' + esc(d.osVersion || '') +
               '</span>' +
             '</button>';
    }).join('');
  }

  function toggleDevicePopover(show) {
    var pop = el.devicePopover;
    if (!pop) return;
    var willShow = (show != null) ? show : pop.hidden;
    pop.hidden = !willShow;
    if (willShow) renderDevicePopover();
  }

  /* ---------- control rail --------------------------------------------------- */

  function updateScaleBtn() {
    if (el.scaleLabel) el.scaleLabel.textContent = Math.round(state.scale * 100) + '%';
  }

  function wireRail() {
    if (el.btnMin) el.btnMin.addEventListener('click', function () { invoke('shell:minimize'); });
    if (el.btnClose) el.btnClose.addEventListener('click', function () { invoke('shell:close'); });

    if (el.btnDevice) el.btnDevice.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleDevicePopover();
    });
    if (el.devicePopover) el.devicePopover.addEventListener('click', function (e) {
      var row = e.target.closest('.dev-row');
      if (!row) return;
      toggleDevicePopover(false);
      switchDevice(row.getAttribute('data-id'));
    });
    document.addEventListener('click', function (e) {
      if (el.devicePopover && !el.devicePopover.hidden &&
          !el.devicePopover.contains(e.target) && e.target !== el.btnDevice &&
          !el.btnDevice.contains(e.target)) {
        toggleDevicePopover(false);
      }
    });

    if (el.btnEngine) el.btnEngine.addEventListener('click', function () {
      setEngine(state.engine === 'webkit' ? 'chromium' : 'webkit');
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

    if (el.btnUpdater) el.btnUpdater.addEventListener('click', function () {
      toast('📡 Checking for new phones…');
      invoke('updater:check').then(function (res) {
        if (res && res.added && res.added.length) addDiscoveredDevices(res.added);
        else if (res && res.checked) toast('✓ Device list is up to date');
        else toast('⚠️ Check failed — engine not ready or offline');
      });
    });

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
    listen('picker:result', function (payload) {
      var report = (payload && payload.report) ? payload.report : payload;
      state.pickerOn = false;
      if (el.btnPicker) el.btnPicker.classList.remove('active');
      var what = report && report.selector ? ' — ' + report.selector : '';
      toast('📋 Copied for Claude' + what, 4500);
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

  /* ---------- boot ------------------------------------------------------------ */

  function init() {
    cacheEls();
    wireRail();
    wireWebview();
    wireCanvas();
    wireGesture();
    wireEngineEvents();
    startClock();

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
    getWebview: function () { return el.page; }
    // DP.home / DP.chrome are attached by homescreen.js / browser-chrome.js
  };

  window.addEventListener('DOMContentLoaded', init);

})();
