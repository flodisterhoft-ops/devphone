/* ==========================================================================
   DevPhone homescreen.js — per-OS home screens: wallpaper, app grid, dock,
   clock widget, app-open animation, installed-PWA persistence, long-press
   wiggle/remove mode. Registers DP.home.

   Installed apps persist in localStorage under devphone.apps.<deviceId>:
     { id, name, icon (dataUrl|null), startUrl, themeColor, display, addedAt }
   ========================================================================== */
'use strict';

(function () {
  var DP = window.DP;
  if (!DP) { console.warn('[DevPhone] homescreen.js loaded before shell.js'); return; }

  var editing = false;
  var pressTimer = null;

  /* ---------- inline-SVG icon set (stylized, non-trademarked) -------------- */

  function icoSafari() {
    var ticks = '';
    for (var i = 0; i < 24; i++) {
      var a = i * 15 * Math.PI / 180;
      var len = (i % 6 === 0) ? 4 : 2.2;
      var x1 = 30 + Math.cos(a) * 22, y1 = 30 + Math.sin(a) * 22;
      var x2 = 30 + Math.cos(a) * (22 - len), y2 = 30 + Math.sin(a) * (22 - len);
      ticks += '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '"/>';
    }
    return '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><radialGradient id="dpSafBg" cx="30%" cy="22%" r="95%">' +
      '<stop offset="0" stop-color="#41d6ff"/><stop offset="1" stop-color="#1567e0"/></radialGradient></defs>' +
      '<rect width="60" height="60" fill="#f5f6f8"/>' +
      '<circle cx="30" cy="30" r="24" fill="url(#dpSafBg)"/>' +
      '<g stroke="rgba(255,255,255,.8)" stroke-width="1">' + ticks + '</g>' +
      '<g transform="rotate(45 30 30)">' +
      '<polygon points="30,11 34.5,30 30,30 25.5,30" fill="#ff3b30"/>' +
      '<polygon points="30,49 34.5,30 30,30 25.5,30" fill="#fff"/>' +
      '</g></svg>';
  }

  function icoChrome() {
    var wedge = 'M30,30 L30,4 A26,26 0 0 1 52.5,43 Z';
    return '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="60" height="60" fill="#fff"/>' +
      '<path d="' + wedge + '" fill="#ea4335"/>' +
      '<path d="' + wedge + '" fill="#fbbc05" transform="rotate(120 30 30)"/>' +
      '<path d="' + wedge + '" fill="#34a853" transform="rotate(240 30 30)"/>' +
      '<circle cx="30" cy="30" r="13.5" fill="#fff"/>' +
      '<circle cx="30" cy="30" r="10" fill="#4285f4"/></svg>';
  }

  function icoSamsungNet() {
    return '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="dpSamBg" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#8e5bff"/><stop offset="1" stop-color="#5326c9"/></linearGradient></defs>' +
      '<rect width="60" height="60" fill="url(#dpSamBg)"/>' +
      '<circle cx="30" cy="30" r="15" fill="none" stroke="#fff" stroke-width="3.4"/>' +
      '<ellipse cx="30" cy="30" rx="23" ry="7.5" fill="none" stroke="#fff" stroke-width="2.4" transform="rotate(-22 30 30)" opacity=".95"/>' +
      '<circle cx="46" cy="17" r="2.6" fill="#fff"/></svg>';
  }

  function icoMessages() {
    return '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="dpMsgBg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#67f06f"/><stop offset="1" stop-color="#0bc629"/></linearGradient></defs>' +
      '<rect width="60" height="60" fill="url(#dpMsgBg)"/>' +
      '<path d="M30 13.5c-9.7 0-17.5 6.5-17.5 14.6 0 4.9 2.9 9.2 7.4 11.9-.5 2.3-1.9 4.4-3.7 5.8 3.2.1 6.3-1 8.7-2.8 1.6.4 3.4.6 5.1.6 9.7 0 17.5-6.5 17.5-14.6S39.7 13.5 30 13.5z" fill="#fff"/></svg>';
  }

  function icoCalendar() {
    var d = new Date();
    var wd = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getDay()];
    return '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="60" height="60" fill="#fff"/>' +
      '<text x="30" y="16" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" font-weight="600" fill="#ff3b30">' + wd + '</text>' +
      '<text x="30" y="46" text-anchor="middle" font-family="Arial,sans-serif" font-size="31" font-weight="300" fill="#1c1c1e">' + d.getDate() + '</text></svg>';
  }

  function icoPhotos() {
    var colors = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#5ac8fa', '#007aff', '#5856d6', '#ff2d55'];
    var petals = '';
    for (var i = 0; i < 8; i++) {
      petals += '<ellipse cx="30" cy="18.5" rx="5.6" ry="11.5" fill="' + colors[i] +
                '" opacity=".82" transform="rotate(' + (i * 45) + ' 30 30)"/>';
    }
    return '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="60" fill="#fff"/>' + petals + '</svg>';
  }

  function icoCamera() {
    return '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="dpCamBg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#ecedf2"/><stop offset="1" stop-color="#c2c4cd"/></linearGradient></defs>' +
      '<rect width="60" height="60" fill="url(#dpCamBg)"/>' +
      '<path d="M14 20h8l3-4.5h10L38 20h8a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V23a3 3 0 0 1 3-3z" fill="#46484f"/>' +
      '<circle cx="30" cy="31.5" r="9.5" fill="#23252c"/>' +
      '<circle cx="30" cy="31.5" r="6" fill="#3a4f7d"/>' +
      '<circle cx="27.5" cy="29" r="1.8" fill="rgba(255,255,255,.55)"/></svg>';
  }

  function icoMaps() {
    return '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="60" height="60" fill="#e9e4d8"/>' +
      '<path d="M0 0h26L0 30z" fill="#b5dd8d"/>' +
      '<path d="M60 34v26H30z" fill="#a9d3f2"/>' +
      '<path d="M-4 38 38 -4 50 8 8 50z" fill="#f6d96b" opacity=".9"/>' +
      '<path d="M2 44 44 2 48 6 6 48z" fill="#fff" opacity=".75"/>' +
      '<path d="M41 22c0 6.5-8 14.5-8 14.5s-8-8-8-14.5a8 8 0 0 1 16 0z" fill="#ea4335"/>' +
      '<circle cx="33" cy="22" r="3" fill="#7c1d12"/></svg>';
  }

  function icoClock() {
    var d = new Date();
    var ha = ((d.getHours() % 12) + d.getMinutes() / 60) * 30 - 90;
    var ma = d.getMinutes() * 6 - 90;
    var ticks = '';
    for (var i = 0; i < 12; i++) {
      var a = i * 30 * Math.PI / 180;
      ticks += '<line x1="' + (30 + Math.cos(a) * 21) + '" y1="' + (30 + Math.sin(a) * 21) +
               '" x2="' + (30 + Math.cos(a) * 23.5) + '" y2="' + (30 + Math.sin(a) * 23.5) + '"/>';
    }
    function hand(angle, len, w, color) {
      var r = angle * Math.PI / 180;
      return '<line x1="30" y1="30" x2="' + (30 + Math.cos(r) * len).toFixed(1) +
             '" y2="' + (30 + Math.sin(r) * len).toFixed(1) + '" stroke="' + color +
             '" stroke-width="' + w + '" stroke-linecap="round"/>';
    }
    return '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="60" height="60" fill="#0b0b0d"/>' +
      '<circle cx="30" cy="30" r="24.5" fill="#fff"/>' +
      '<g stroke="#1c1c1e" stroke-width="1.6">' + ticks + '</g>' +
      hand(ha, 12, 3, '#1c1c1e') + hand(ma, 18, 2.4, '#1c1c1e') +
      '<circle cx="30" cy="30" r="2" fill="#ff9500"/></svg>';
  }

  function icoNotes() {
    return '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="60" height="60" fill="#fff"/>' +
      '<rect width="60" height="15" fill="#fad860"/>' +
      '<g stroke="#d9d9de" stroke-width="2"><line x1="10" y1="27" x2="50" y2="27"/>' +
      '<line x1="10" y1="37" x2="50" y2="37"/><line x1="10" y1="47" x2="38" y2="47"/></g>' +
      '<g fill="#b98a00"><circle cx="16" cy="7.5" r="1.7"/><circle cx="30" cy="7.5" r="1.7"/><circle cx="44" cy="7.5" r="1.7"/></g></svg>';
  }

  function icoSettings() {
    var teeth = '';
    for (var i = 0; i < 8; i++) {
      teeth += '<rect x="27.6" y="8.5" width="4.8" height="8" rx="2" fill="#8e9099" transform="rotate(' + (i * 45) + ' 30 30)"/>';
    }
    return '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="dpSetBg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#e3e4e9"/><stop offset="1" stop-color="#bfc1ca"/></linearGradient></defs>' +
      '<rect width="60" height="60" fill="url(#dpSetBg)"/>' + teeth +
      '<circle cx="30" cy="30" r="16" fill="#8e9099"/>' +
      '<circle cx="30" cy="30" r="7" fill="#d6d7dd"/></svg>';
  }

  function icoMail() {
    return '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="dpMailBg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#1f8efd"/><stop offset="1" stop-color="#16cdfb"/></linearGradient></defs>' +
      '<rect width="60" height="60" fill="url(#dpMailBg)"/>' +
      '<rect x="13" y="19" width="34" height="23" rx="3.5" fill="#fff"/>' +
      '<path d="M14.5 21.5 30 33l15.5-11.5" fill="none" stroke="#1f8efd" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function icoPhone(circle) {
    return '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="dpPhBg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#67f06f"/><stop offset="1" stop-color="#0bc629"/></linearGradient></defs>' +
      (circle ? '<circle cx="30" cy="30" r="30" fill="url(#dpPhBg)"/>' : '<rect width="60" height="60" fill="url(#dpPhBg)"/>') +
      '<path d="M21.8 16.6c1.1-1.1 2.9-1 3.9.2l3 3.7c.9 1.1.8 2.6-.1 3.6l-1.8 1.9c1.1 2.7 4.5 6.2 7.2 7.3l1.9-1.8c1-1 2.5-1 3.6-.2l3.7 3c1.2 1 1.3 2.8.2 3.9l-2.1 2.2c-1.1 1.1-2.7 1.5-4.2 1-8.5-3-15.4-9.9-18.3-18.4-.5-1.5-.1-3.1 1-4.2z" fill="#fff"/></svg>';
  }

  function icoGallery() {
    return '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="60" height="60" fill="#fff"/>' +
      '<rect x="8" y="12" width="44" height="36" rx="4" fill="#dfeefb"/>' +
      '<circle cx="22" cy="23" r="4.5" fill="#ffcd3c"/>' +
      '<path d="M8 44l13-14 9 9 7-7 15 14v2a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4z" fill="#56b07c"/></svg>';
  }

  /* ---------- letter-tile fallback for PWA icons --------------------------- */

  var TILE_COLORS = ['#e74c3c', '#8e44ad', '#2980b9', '#16a085', '#27ae60', '#d35400', '#2c3e50', '#c0392b'];
  function hashColor(s) {
    var h = 0;
    for (var i = 0; i < (s || '').length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return TILE_COLORS[Math.abs(h) % TILE_COLORS.length];
  }
  function letterTile(name) {
    var letter = (name || '?').trim().charAt(0).toUpperCase() || '?';
    return '<div class="letter-ico" style="background:' + hashColor(name) + '">' + DP.esc(letter) + '</div>';
  }
  DP.letterTile = letterTile;
  DP.hashColor = hashColor;

  /* ---------- installed-app persistence ------------------------------------ */

  function appsKey() {
    return 'devphone.apps.' + (DP.state.device ? DP.state.device.id : 'unknown');
  }
  function getApps() {
    try { return JSON.parse(localStorage.getItem(appsKey()) || '[]') || []; }
    catch (e) { return []; }
  }
  function saveApps(list) {
    try {
      localStorage.setItem(appsKey(), JSON.stringify(list));
      return true;
    } catch (e) {
      if (DP.toast) DP.toast('Could not save Home Screen app', 2400);
      return false;
    }
  }
  function installApp(app) {
    var list = getApps().filter(function (a) { return a.startUrl !== app.startUrl; });
    list.push(app);
    if (!saveApps(list)) return null;
    render();
    return app;
  }
  function removeApp(id) {
    saveApps(getApps().filter(function (a) { return a.id !== id; }));
    render();
    if (editing) setEditing(true); // keep wiggle alive after re-render
  }

  /* ---------- catalog ------------------------------------------------------- */

  var BROWSER_DEFS = {
    safari:  { name: 'Safari',   icon: icoSafari,     anim: '#f5f6f8' },
    chrome:  { name: 'Chrome',   icon: icoChrome,     anim: '#ffffff' },
    samsung: { name: 'Internet', icon: icoSamsungNet, anim: '#6b3df2' }
  };

  function appCell(o) {
    // o: {kind, id, name, iconHtml, removable}
    return '<button class="hs-app" data-kind="' + o.kind + '" data-id="' + DP.esc(o.id) + '"' +
           (o.removable ? ' data-removable="1"' : '') + '>' +
             '<span class="hs-remove" title="Remove">✕</span>' +
             '<span class="hs-icon">' + o.iconHtml + '</span>' +
             '<span class="hs-label">' + DP.esc(o.name) + '</span>' +
           '</button>';
  }

  function pwaCell(app) {
    var iconHtml = app.icon
      ? '<img src="' + DP.esc(app.icon) + '" alt="">'
      : letterTile(app.name);
    return appCell({ kind: 'pwa', id: app.id, name: app.name, iconHtml: iconHtml, removable: true });
  }

  function browserCell(id) {
    var def = BROWSER_DEFS[id];
    if (!def) return '';
    return appCell({ kind: 'browser', id: id, name: def.name, iconHtml: def.icon() });
  }

  function stubCell(id, name, icon) {
    return appCell({ kind: 'stub', id: id, name: name, iconHtml: icon() });
  }

  /* ---------- render -------------------------------------------------------- */

  function renderIOS(device) {
    var browsers = device.browsers || ['safari'];
    var grid = [
      stubCell('calendar', 'Calendar', icoCalendar),
      stubCell('photos', 'Photos', icoPhotos),
      stubCell('camera', 'Camera', icoCamera),
      stubCell('maps', 'Maps', icoMaps),
      stubCell('clock', 'Clock', icoClock),
      stubCell('notes', 'Notes', icoNotes),
      stubCell('settings', 'Settings', icoSettings)
    ];
    if (browsers.indexOf('chrome') >= 0) grid.push(browserCell('chrome'));
    getApps().forEach(function (a) { grid.push(pwaCell(a)); });

    var dock = [];
    if (device.formFactor !== 'tablet') {
      dock.push(stubCell('phone', 'Phone', function () { return icoPhone(false); }));
    }
    dock.push(browserCell('safari'));
    dock.push(stubCell('messages', 'Messages', icoMessages));
    dock.push(stubCell('mail', 'Mail', icoMail));

    return '<div class="hs hs-ios">' +
             '<button class="hs-done">Done</button>' +
             '<div class="hs-clock"><div class="hs-time js-clock">' + DP.fmtTime('ios') + '</div>' +
             '<div class="hs-date">' + DP.esc(DP.fmtDate()) + '</div></div>' +
             '<div class="hs-grid">' + grid.join('') + '</div>' +
             '<div class="hs-dock-wrap"><div class="hs-dock">' + dock.join('') + '</div></div>' +
           '</div>';
  }

  function renderAndroid(device) {
    var browsers = device.browsers || ['chrome'];
    var grid = [
      stubCell('gallery', 'Gallery', icoGallery),
      stubCell('calendar', 'Calendar', icoCalendar),
      stubCell('clock', 'Clock', icoClock),
      stubCell('settings', 'Settings', icoSettings)
    ];
    getApps().forEach(function (a) { grid.push(pwaCell(a)); });

    var dock = [];
    if (device.formFactor !== 'tablet') {
      dock.push(stubCell('phone', 'Phone', function () { return icoPhone(true); }));
    }
    if (browsers.indexOf('samsung') >= 0) dock.push(browserCell('samsung'));
    dock.push(browserCell('chrome'));
    dock.push(stubCell('messages', 'Messages', icoMessages));
    dock.push(stubCell('camera', 'Camera', icoCamera));

    return '<div class="hs hs-android">' +
             '<button class="hs-done">Done</button>' +
             '<div class="hs-clock"><div class="hs-time js-clock">' + DP.fmtTime('android') + '</div>' +
             '<div class="hs-date">' + DP.esc(DP.fmtDate()) + '</div></div>' +
             '<div class="hs-search"><svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="#7a7f88" stroke-width="2.4" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="6"/><path d="M13 13l5 5"/></svg>Search</div>' +
             '<div class="hs-grid">' + grid.join('') + '</div>' +
             '<div class="hs-dock-wrap"><div class="hs-dock">' + dock.join('') + '</div></div>' +
           '</div>';
  }

  function render() {
    var device = DP.state.device;
    var root = document.getElementById('homescreen');
    if (!device || !root) return;
    editing = false;
    root.innerHTML = device.os === 'ios' ? renderIOS(device) : renderAndroid(device);
    // per-device wallpaper colorway (brand + generation); the .hs-ios /
    // .hs-android CSS backgrounds remain as a fallback
    var hs = root.querySelector('.hs');
    if (hs && typeof DP.wallpaper === 'function') {
      try { hs.style.background = DP.wallpaper(device).css; } catch (e) {}
    }
    wire(root);
  }

  /* ---------- app-open animation -------------------------------------------- */

  function animateOpenFrom(iconEl, fill, done) {
    var layer = document.getElementById('open-anim-layer');
    var screen = document.getElementById('screen');
    var fired = false;
    var finish = function () { if (!fired) { fired = true; if (done) done(); } };
    if (!layer || !screen || !iconEl) { finish(); return; }
    try {
      var sr = screen.getBoundingClientRect();
      var ir = iconEl.getBoundingClientRect();
      var k = sr.width / screen.offsetWidth || 1;   // current visual scale
      var div = document.createElement('div');
      div.className = 'open-anim';
      div.style.left = ((ir.left - sr.left) / k) + 'px';
      div.style.top = ((ir.top - sr.top) / k) + 'px';
      div.style.width = (ir.width / k) + 'px';
      div.style.height = (ir.height / k) + 'px';
      div.style.background = fill || '#ffffff';
      layer.appendChild(div);
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          div.style.left = '0px';
          div.style.top = '0px';
          div.style.width = screen.offsetWidth + 'px';
          div.style.height = screen.offsetHeight + 'px';
          div.style.borderRadius = '0px';
        });
      });
      setTimeout(function () {
        finish();
        div.style.opacity = '0';
        setTimeout(function () { div.remove(); }, 220);
      }, 250);
    } catch (e) { finish(); }
  }

  /* ---------- wiggle / edit mode --------------------------------------------- */

  function setEditing(on) {
    editing = on;
    var hs = document.querySelector('#homescreen .hs');
    if (hs) hs.classList.toggle('editing', on);
  }

  /* ---------- interaction ------------------------------------------------------ */

  function wire(root) {
    var hs = root.querySelector('.hs');
    if (!hs) return;

    hs.addEventListener('click', function (e) {
      var done = e.target.closest('.hs-done');
      if (done) { setEditing(false); return; }

      var removeBtn = e.target.closest('.hs-remove');
      if (removeBtn && editing) {
        var cellRm = removeBtn.closest('.hs-app');
        if (cellRm && cellRm.getAttribute('data-removable')) {
          var appId = cellRm.getAttribute('data-id');
          removeApp(appId);
          DP.toast('🗑️ Removed from Home Screen');
        }
        return;
      }

      var cell = e.target.closest('.hs-app');
      if (!cell) {
        if (editing) setEditing(false);   // tap wallpaper exits wiggle
        return;
      }
      if (editing) return;                // taps don't launch while wiggling

      var kind = cell.getAttribute('data-kind');
      var id = cell.getAttribute('data-id');

      if (kind === 'browser') {
        var def = BROWSER_DEFS[id] || {};
        animateOpenFrom(cell.querySelector('.hs-icon'), def.anim, function () {
          if (DP.chrome) DP.chrome.open(id);
          else DP.toast('⚠️ Browser chrome not loaded');
        });
      } else if (kind === 'pwa') {
        var app = null;
        getApps().forEach(function (a) { if (a.id === id) app = a; });
        if (!app) return;
        var fill = app.themeColor || hashColor(app.name);
        animateOpenFrom(cell.querySelector('.hs-icon'), fill, function () {
          if (DP.chrome) DP.chrome.launchApp(app);
        });
      } else {
        var label = cell.querySelector('.hs-label');
        DP.toast('✨ ' + (label ? label.textContent : 'This app') + ' is decorative in DevPhone');
      }
    });

    // long-press (550ms) on a removable icon enters wiggle mode
    hs.addEventListener('pointerdown', function (e) {
      var cell = e.target.closest('.hs-app');
      clearTimeout(pressTimer);
      if (!cell) return;
      var startX = e.clientX, startY = e.clientY;
      pressTimer = setTimeout(function () {
        if (cell.getAttribute('data-removable') || getApps().length) setEditing(true);
      }, 550);
      var cancel = function (ev) {
        if (ev.type === 'pointermove' &&
            Math.abs(ev.clientX - startX) < 9 && Math.abs(ev.clientY - startY) < 9) return;
        clearTimeout(pressTimer);
        hs.removeEventListener('pointerup', cancel);
        hs.removeEventListener('pointermove', cancel);
        hs.removeEventListener('pointerleave', cancel);
      };
      hs.addEventListener('pointerup', cancel);
      hs.addEventListener('pointermove', cancel);
      hs.addEventListener('pointerleave', cancel);
    });
  }

  /* ---------- show / hide -------------------------------------------------------- */

  function show() {
    var root = document.getElementById('homescreen');
    if (root) root.hidden = false;
    setEditing(false);
  }
  function hide() {
    var root = document.getElementById('homescreen');
    if (root) root.hidden = true;
    setEditing(false);
  }

  // keep the home-screen clock fresh
  DP.bus.on('minute', function () {
    var d = DP.state.device;
    if (!d) return;
    var t = DP.fmtTime(d.os);
    document.querySelectorAll('#homescreen .hs-time').forEach(function (n) { n.textContent = t; });
  });

  DP.home = {
    render: render,
    show: show,
    hide: hide,
    getApps: getApps,
    installApp: installApp,
    removeApp: removeApp,
    animateOpenFrom: animateOpenFrom
  };

})();
