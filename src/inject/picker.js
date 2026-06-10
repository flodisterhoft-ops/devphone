/*
 * DevPhone element picker — self-contained, idempotent IIFE.
 *
 * Injected into the page (Chromium webview via executeJavaScript, WebKit via
 * page.evaluate — keep this file engine-agnostic, no Chromium-only APIs).
 * Defines window.__DEVPHONE_PICKER__(on) to arm/disarm.
 *
 * v0.1.1 — Chrome-DevTools-style inspector:
 *  - armed cursor is the normal ARROW (cursor:default !important), precise
 *    pointing instead of crosshair/touch circle.
 *  - hover overlay (pointer-events:none, max z-index): content box filled
 *    rgba(111,168,220,.35) + 1px solid #1a73e8 outline; margin ring tinted
 *    rgba(246,178,107,.25) (computed from getComputedStyle margins); tooltip
 *    pill `tag#id.class` (mono) + ` · W×H`, dark + rounded, auto-flips when
 *    the element is near the top of the viewport.
 *  - hover tracking via elementFromPoint, rAF-throttled; the overlay is
 *    hidden during the probe so it never picks itself.
 *  - click/tap selects (capture phase, preventDefault + stopPropagation),
 *    emits console.log('__DEVPHONE_PICK__' + JSON) — report fields unchanged
 *    — then disarms and removes overlay + cursor style. Escape disarms.
 */
(function () {
  'use strict';
  if (window.__DEVPHONE_PICKER__) return; // idempotent

  var armed = false;
  var ui = null; // { root, marginBox, contentBox, tip, tipSel, tipDims }
  var styleEl = null;
  var lastTarget = null;
  var suppressUntil = 0;
  var rafPending = false;
  var lastX = 0;
  var lastY = 0;

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

  // ---------- overlay ----------

  function ensureUi() {
    if (ui && ui.root && ui.root.isConnected) return ui;

    var root = document.createElement('div');
    root.id = '__devphone-pick-overlay';
    var rs = root.style;
    rs.position = 'fixed';
    rs.left = '0'; rs.top = '0'; rs.width = '100%'; rs.height = '100%';
    rs.pointerEvents = 'none';
    rs.zIndex = '2147483647';
    rs.margin = '0'; rs.padding = '0'; rs.border = '0';

    // Margin ring: a box at the margin-rect whose BORDERS are the margins —
    // tints only the margin area, never the content underneath.
    var marginBox = document.createElement('div');
    var ms = marginBox.style;
    ms.position = 'absolute';
    ms.boxSizing = 'border-box';
    ms.borderStyle = 'solid';
    ms.borderColor = 'rgba(246,178,107,.25)';
    ms.background = 'transparent';
    ms.pointerEvents = 'none';
    ms.display = 'none';

    // Content box: translucent blue fill + hairline outline (outline does
    // not shift geometry, the fill matches the rect exactly).
    var contentBox = document.createElement('div');
    var cs = contentBox.style;
    cs.position = 'absolute';
    cs.boxSizing = 'border-box';
    cs.background = 'rgba(111,168,220,.35)';
    cs.outline = '1px solid #1a73e8';
    cs.pointerEvents = 'none';
    cs.display = 'none';

    // Tooltip pill: `tag#id.class` in mono + ` · W×H`, dark, rounded.
    var tip = document.createElement('div');
    var ts = tip.style;
    ts.position = 'absolute';
    ts.display = 'none';
    ts.maxWidth = '92%';
    ts.padding = '3px 8px';
    ts.background = 'rgba(32,33,36,.95)';
    ts.color = '#fff';
    ts.borderRadius = '6px';
    ts.boxShadow = '0 2px 8px rgba(0,0,0,.35)';
    ts.font = '12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif';
    ts.whiteSpace = 'nowrap';
    ts.overflow = 'hidden';
    ts.textOverflow = 'ellipsis';
    ts.pointerEvents = 'none';

    var tipSel = document.createElement('span');
    tipSel.style.fontFamily = 'Menlo, Consolas, "SF Mono", monospace';
    tipSel.style.color = '#93b8f8';

    var tipDims = document.createElement('span');
    tipDims.style.color = '#d5d8dc';

    tip.appendChild(tipSel);
    tip.appendChild(tipDims);
    root.appendChild(marginBox);
    root.appendChild(contentBox);
    root.appendChild(tip);
    (document.documentElement || document.body).appendChild(root);

    ui = { root: root, marginBox: marginBox, contentBox: contentBox, tip: tip, tipSel: tipSel, tipDims: tipDims };
    return ui;
  }

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.createElement('style');
    styleEl.id = '__devphone-pick-style';
    // Precise arrow pointer while inspecting — not crosshair, not touch circle.
    styleEl.textContent = '*{cursor:default !important}';
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function tipLabel(el) {
    var label = el.tagName.toLowerCase();
    try {
      if (el.id) label += '#' + el.id;
      var classes = el.classList ? Array.prototype.slice.call(el.classList) : [];
      for (var i = 0; i < classes.length && label.length < 60; i++) label += '.' + classes[i];
    } catch (e) {}
    if (label.length > 64) label = label.slice(0, 63) + '…';
    return label;
  }

  function drawOverlay(el) {
    try {
      if (!el) return;
      var u = ensureUi();
      var r = el.getBoundingClientRect();
      var cs = window.getComputedStyle(el);
      var mt = Math.max(0, parseFloat(cs.marginTop) || 0);
      var mr = Math.max(0, parseFloat(cs.marginRight) || 0);
      var mb = Math.max(0, parseFloat(cs.marginBottom) || 0);
      var ml = Math.max(0, parseFloat(cs.marginLeft) || 0);

      var c = u.contentBox.style;
      c.left = r.left + 'px';
      c.top = r.top + 'px';
      c.width = Math.max(0, r.width) + 'px';
      c.height = Math.max(0, r.height) + 'px';
      c.display = 'block';

      var m = u.marginBox.style;
      if (mt || mr || mb || ml) {
        m.left = (r.left - ml) + 'px';
        m.top = (r.top - mt) + 'px';
        m.width = Math.max(0, r.width + ml + mr) + 'px';
        m.height = Math.max(0, r.height + mt + mb) + 'px';
        m.borderWidth = mt + 'px ' + mr + 'px ' + mb + 'px ' + ml + 'px';
        m.display = 'block';
      } else {
        m.display = 'none';
      }

      u.tipSel.textContent = tipLabel(el);
      u.tipDims.textContent = ' · ' + Math.round(r.width) + '×' + Math.round(r.height);
      var t = u.tip.style;
      t.display = 'block';
      t.left = '0px'; t.top = '-9999px'; // measure off-screen first
      var tr = u.tip.getBoundingClientRect();
      var vw = window.innerWidth || document.documentElement.clientWidth || 0;
      var vh = window.innerHeight || document.documentElement.clientHeight || 0;
      var tx = Math.max(4, Math.min(r.left, vw - tr.width - 4));
      var ty = r.top - tr.height - 6; // preferred: above the element
      if (ty < 4) ty = r.top + r.height + 6; // near the top → flip below
      if (ty + tr.height > vh - 4) ty = Math.max(4, Math.min(r.top + 6, vh - tr.height - 4)); // huge element → pin inside
      t.left = tx + 'px';
      t.top = ty + 'px';
    } catch (e) {}
  }

  function hideOverlay() {
    try {
      if (!ui) return;
      ui.contentBox.style.display = 'none';
      ui.marginBox.style.display = 'none';
      ui.tip.style.display = 'none';
    } catch (e) {}
  }

  function isOwnNode(el) {
    try { return !!(ui && ui.root && (el === ui.root || ui.root.contains(el))); } catch (e) { return false; }
  }

  // elementFromPoint with the overlay hidden during the probe (belt and
  // braces — it is pointer-events:none already) so it can never self-hit.
  function probe(x, y) {
    var el = null;
    var prev = '';
    try {
      if (ui && ui.root) { prev = ui.root.style.display; ui.root.style.display = 'none'; }
    } catch (e) {}
    try { el = document.elementFromPoint(x, y); } catch (e) {}
    try {
      if (ui && ui.root) ui.root.style.display = prev || '';
    } catch (e) {}
    if (el && !isOwnNode(el) && el !== styleEl) return el;
    return null;
  }

  // ---------- events ----------

  function onMove(ev) {
    if (!armed) return;
    var p = (ev.touches && ev.touches[0]) ? ev.touches[0] : ev;
    lastX = p.clientX;
    lastY = p.clientY;
    if (rafPending) return;
    rafPending = true;
    var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
    raf(function () {
      rafPending = false;
      if (!armed) return;
      var el = probe(lastX, lastY);
      if (el) { lastTarget = el; drawOverlay(el); }
    });
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
    var el = probe(x, y) || lastTarget;
    if (el) select(el);
  }

  function onClick(ev) {
    if (armed || Date.now() < suppressUntil) kill(ev);
  }

  function onKey(ev) {
    if (!armed) return;
    var key = ev.key || ev.keyCode;
    if (key === 'Escape' || key === 'Esc' || key === 27) {
      kill(ev);
      disarm();
    }
  }

  function kill(ev) {
    try { ev.preventDefault(); } catch (e) {}
    try { ev.stopPropagation(); } catch (e) {}
    try { ev.stopImmediatePropagation(); } catch (e) {}
  }

  function arm() {
    armed = true;
    lastTarget = null;
    rafPending = false;
    ensureStyle();
    ensureUi();
    hideOverlay(); // visible only once something is hovered
  }

  function disarm() {
    armed = false;
    rafPending = false;
    lastTarget = null;
    try {
      if (ui && ui.root && ui.root.parentNode) ui.root.parentNode.removeChild(ui.root);
    } catch (e) {}
    ui = null;
    try { if (styleEl && styleEl.parentNode) { styleEl.parentNode.removeChild(styleEl); } } catch (e) {}
    styleEl = null;
  }

  // Capture-phase listeners registered once; inert while disarmed.
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('touchmove', onMove, true);
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('mousedown', onClick, true);
  window.addEventListener('touchstart', onClick, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);

  window.__DEVPHONE_PICKER__ = function (on) {
    if (on) arm(); else disarm();
    return armed;
  };
})();
