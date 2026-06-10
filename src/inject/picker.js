/*
 * DevPhone element picker — self-contained, idempotent IIFE.
 *
 * Injected into the page (Chromium webview via executeJavaScript, WebKit via
 * page.evaluate). Defines window.__DEVPHONE_PICKER__(on) to arm/disarm.
 * When armed: crosshair cursor + hover outline; tap/click selects the element
 * (preventDefault + stopPropagation in capture phase), builds a report and
 * emits it as console.log('__DEVPHONE_PICK__' + JSON), then disarms.
 */
(function () {
  'use strict';
  if (window.__DEVPHONE_PICKER__) return; // idempotent

  var armed = false;
  var overlay = null;
  var styleEl = null;
  var lastTarget = null;
  var suppressUntil = 0;

  function cssEscapeIdent(s) {
    try {
      return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
    } catch (e) { return String(s); }
  }

  function rgbToHex(c) {
    try {
      var m = String(c).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
      if (!m) return String(c);
      if (m[4] !== undefined && parseFloat(m[4]) === 0) return 'transparent';
      var h = function (n) { return ('0' + parseInt(n, 10).toString(16)).slice(-2); };
      var hex = '#' + h(m[1]) + h(m[2]) + h(m[3]);
      if (hex[1] === hex[2] && hex[3] === hex[4] && hex[5] === hex[6]) {
        hex = '#' + hex[1] + hex[3] + hex[5];
      }
      return hex;
    } catch (e) { return String(c); }
  }

  // Selector strategy: id > unique class path > nth-of-type chain.
  function buildSelector(el) {
    try {
      var tag = el.tagName.toLowerCase();
      if (el.id) return tag + '#' + cssEscapeIdent(el.id);
      var classes = el.classList ? Array.prototype.slice.call(el.classList) : [];
      for (var i = 0; i < classes.length; i++) {
        var one = tag + '.' + cssEscapeIdent(classes[i]);
        try { if (document.querySelectorAll(one).length === 1) return one; } catch (e) {}
      }
      if (classes.length > 1) {
        var all = tag + '.' + classes.map(cssEscapeIdent).join('.');
        try { if (document.querySelectorAll(all).length === 1) return all; } catch (e) {}
      }
      // nth-of-type chain up the tree (stop early at an id'd ancestor)
      var parts = [];
      var node = el;
      while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 6) {
        var t = node.tagName.toLowerCase();
        if (node.id) { parts.unshift(t + '#' + cssEscapeIdent(node.id)); break; }
        var idx = 1;
        var sib = node;
        while ((sib = sib.previousElementSibling)) { if (sib.tagName === node.tagName) idx++; }
        parts.unshift(t + ':nth-of-type(' + idx + ')');
        node = node.parentElement;
      }
      return parts.join(' > ') || tag;
    } catch (e) {
      return (el && el.tagName) ? el.tagName.toLowerCase() : '*';
    }
  }

  function buildReport(el) {
    var cs = window.getComputedStyle(el);
    var r = el.getBoundingClientRect();
    var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    var fontFamily = '';
    try { fontFamily = (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(); } catch (e) {}
    return {
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: el.classList ? Array.prototype.slice.call(el.classList) : [],
      text: text,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      styles: {
        fontSize: cs.fontSize,
        fontFamily: fontFamily,
        color: rgbToHex(cs.color),
        background: rgbToHex(cs.backgroundColor),
        margin: cs.margin,
        padding: cs.padding,
        display: cs.display,
        position: cs.position,
        zIndex: cs.zIndex
      },
      htmlSnippet: (el.outerHTML || '').slice(0, 300),
      pageUrl: String(location.href),
      device: (window.__DEVPHONE__ && (window.__DEVPHONE__.deviceLabel || window.__DEVPHONE__.deviceId)) || ''
    };
  }

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    overlay = document.createElement('div');
    overlay.id = '__devphone-pick-overlay';
    var s = overlay.style;
    s.position = 'fixed';
    s.left = '0px'; s.top = '0px'; s.width = '0px'; s.height = '0px';
    s.border = '2px solid #0A84FF';
    s.background = 'rgba(10,132,255,0.18)';
    s.borderRadius = '2px';
    s.boxSizing = 'border-box';
    s.pointerEvents = 'none';
    s.zIndex = '2147483647';
    s.display = 'none';
    (document.documentElement || document.body).appendChild(overlay);
    return overlay;
  }

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.createElement('style');
    styleEl.id = '__devphone-pick-style';
    styleEl.textContent = '*{cursor:crosshair !important}';
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function moveOverlayTo(el) {
    try {
      if (!el || el === overlay) return;
      var r = el.getBoundingClientRect();
      var o = ensureOverlay();
      o.style.display = 'block';
      o.style.left = r.left + 'px';
      o.style.top = r.top + 'px';
      o.style.width = Math.max(0, r.width) + 'px';
      o.style.height = Math.max(0, r.height) + 'px';
    } catch (e) {}
  }

  function targetAt(x, y) {
    try {
      var el = document.elementFromPoint(x, y);
      if (el && el !== overlay) return el;
    } catch (e) {}
    return lastTarget;
  }

  function onMove(ev) {
    if (!armed) return;
    var x = (ev.touches && ev.touches[0]) ? ev.touches[0].clientX : ev.clientX;
    var y = (ev.touches && ev.touches[0]) ? ev.touches[0].clientY : ev.clientY;
    var el = targetAt(x, y);
    if (el) { lastTarget = el; moveOverlayTo(el); }
  }

  function select(el) {
    try {
      var report = buildReport(el);
      console.log('__DEVPHONE_PICK__' + JSON.stringify(report));
    } catch (e) {
      try { console.log('__DEVPHONE_PICK__' + JSON.stringify({ error: String(e), pageUrl: String(location.href) })); } catch (e2) {}
    }
    disarm();
    suppressUntil = Date.now() + 500; // swallow the synthesized click that follows
  }

  function onDown(ev) {
    if (!armed) {
      if (Date.now() < suppressUntil) { kill(ev); }
      return;
    }
    kill(ev);
    var x = (ev.touches && ev.touches[0]) ? ev.touches[0].clientX : ev.clientX;
    var y = (ev.touches && ev.touches[0]) ? ev.touches[0].clientY : ev.clientY;
    var el = targetAt(x, y) || lastTarget;
    if (el) select(el);
  }

  function onClick(ev) {
    if (armed || Date.now() < suppressUntil) kill(ev);
  }

  function kill(ev) {
    try { ev.preventDefault(); } catch (e) {}
    try { ev.stopPropagation(); } catch (e) {}
    try { ev.stopImmediatePropagation(); } catch (e) {}
  }

  function arm() {
    armed = true;
    lastTarget = null;
    ensureStyle();
    ensureOverlay();
  }

  function disarm() {
    armed = false;
    try { if (overlay) overlay.style.display = 'none'; } catch (e) {}
    try { if (styleEl && styleEl.parentNode) { styleEl.parentNode.removeChild(styleEl); styleEl = null; } } catch (e) {}
  }

  // Capture-phase listeners registered once; inert while disarmed.
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('touchmove', onMove, true);
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('mousedown', onClick, true);
  window.addEventListener('touchstart', onClick, true);
  window.addEventListener('click', onClick, true);

  window.__DEVPHONE_PICKER__ = function (on) {
    if (on) arm(); else disarm();
    return armed;
  };
})();
