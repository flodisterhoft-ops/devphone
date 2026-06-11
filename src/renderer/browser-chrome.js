/* ==========================================================================
   DevPhone browser-chrome.js — per-browser UI: Safari bottom pill (with
   scroll-collapse + share sheet + Add to Home Screen), Chrome omnibox + menu,
   Samsung Internet top bar + bottom toolbar, in-shell start page with recents
   and quick links, PWA standalone launch. Registers DP.chrome.
   ========================================================================== */
'use strict';

(function () {
  var DP = window.DP;
  if (!DP) { console.warn('[DevPhone] browser-chrome.js loaded before shell.js'); return; }

  var current = null;        // {type:'browser', browser} | {type:'pwa', app}
  var collapsed = false;
  var lastScrollY = 0;
  var startVisible = false;

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- bar metrics (CSS px @1:1, must match the CSS below) ------------ */
  // Safari bottom bar: 8 pad + 46 pill + 9 gap + 36 tools + 26 pad = 125
  //          collapsed: 3 pad + 21 pill + 7 pad                    = 31
  // Chrome top bar (below status bar): 6 pad + 40 field + 9 pad    = 55
  // Chrome bottom omnibox:             8 pad + 40 field + 8 pad    = 56
  // Samsung top (below status bar):    6 pad + 38 field + 8 pad    = 52
  // Samsung bottom toolbar:                                          54
  var SAF_BAR = 125, SAF_BAR_COLLAPSED = 31;
  var CHR_TOP = 55, CHR_BOTTOM = 56;
  var SAM_TOP = 52, SAM_BOTTOM = 54;

  function addrBarBottom() {
    return !!(DP.settings && typeof DP.settings.getAddrBar === 'function' &&
              DP.settings.getAddrBar() === 'bottom');
  }

  function relayout() {
    if (typeof DP.layoutContent === 'function') DP.layoutContent();
  }

  // honest content-area insets contributed by the current browser chrome.
  // Status bar is included for Android-style top bars (their white bar paints
  // the status area); Safari keeps top:0 — iOS pages draw under the status bar.
  function getInsets() {
    if (!current || current.type !== 'browser') return { top: 0, bottom: 0 };
    var d = DP.state.device || {};
    var sb = (typeof DP.sbHeight === 'function') ? DP.sbHeight(d) : 0;
    if (current.browser === 'safari') {
      return { top: 0, bottom: collapsed ? SAF_BAR_COLLAPSED : SAF_BAR };
    }
    if (current.browser === 'samsung') {
      return { top: sb + SAM_TOP, bottom: SAM_BOTTOM };
    }
    // chrome
    if (addrBarBottom()) return { top: sb, bottom: CHR_BOTTOM };
    return { top: sb + CHR_TOP, bottom: 0 };
  }

  /* ---------- small SVG glyphs ---------------------------------------------- */

  function svgChevron(dir) {
    var d = dir === 'back' ? 'M13.5 4 7 11l6.5 7' : 'M8.5 4 15 11l-6.5 7';
    return '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>';
  }
  function svgShare() {
    return '<svg width="20" height="24" viewBox="0 0 20 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M10 14V2.8"/><path d="M6 6.4 10 2.4l4 4"/>' +
      '<path d="M6.5 9.5H5A2 2 0 0 0 3 11.5v8A2 2 0 0 0 5 21.5h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1.5"/></svg>';
  }
  function svgTabs() {
    return '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.8">' +
      '<rect x="6.5" y="2.5" width="13" height="13" rx="2.4"/>' +
      '<path d="M15.5 19.5H4.4a2 2 0 0 1-2-2V6.5"/></svg>';
  }
  function svgReload(size) {
    var s = size || 17;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
      '<path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8"/><path d="M13.7 1.6v3h-3"/></svg>';
  }
  function svgLock(h) {
    return '<svg class="pill-lock" width="10" height="' + (h || 13) + '" viewBox="0 0 12 14" fill="currentColor">' +
      '<rect x="1" y="6" width="10" height="7.4" rx="1.8"/>' +
      '<path d="M3.4 6.2V4.5a2.6 2.6 0 0 1 5.2 0v1.7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  }
  function svgHome() {
    return '<svg width="21" height="21" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3.5 9.5 11 3l7.5 6.5"/><path d="M5.5 8.5v9a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-9"/></svg>';
  }
  function svgPlusSquare() {
    return '<svg width="21" height="21" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
      '<rect x="2.8" y="2.8" width="16.4" height="16.4" rx="4"/><path d="M11 7.2v7.6M7.2 11h7.6"/></svg>';
  }
  function svgCopy() {
    return '<svg width="19" height="19" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.7">' +
      '<rect x="7.5" y="7.5" width="11" height="11" rx="2.4"/>' +
      '<path d="M14.5 4.5h-8a2 2 0 0 0-2 2v8"/></svg>';
  }
  function svgExternal() {
    return '<svg width="19" height="19" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M9 4.5H6A2 2 0 0 0 4 6.5v9A2 2 0 0 0 6 17.5h9a2 2 0 0 0 2-2v-3"/>' +
      '<path d="M13 3.5h5v5"/><path d="M18 4 10.5 11.5"/></svg>';
  }

  /* ---------- url helpers ------------------------------------------------------ */

  function smartUrl(q) {
    q = String(q || '').trim();
    if (!q) return null;
    if (/^https?:\/\//i.test(q)) return q;
    if (/^about:/i.test(q)) return q;
    if (q.indexOf('.') < 0 || /\s/.test(q)) return null;   // not a URL → no-op
    return 'https://' + q;
  }
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url || ''; }
  }
  function isWeb(url) { return /^https?:\/\//i.test(url || ''); }
  function faviconImg(host, size) {
    // favicons via Google's s2 endpoint; falls back to a letter tile on error
    return '<img src="https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) +
           '&sz=' + (size || 64) + '" alt="" onerror="this.remove()">';
  }

  /* ---------- recents ----------------------------------------------------------- */

  function getRecents() {
    try { return JSON.parse(localStorage.getItem('devphone.recents') || '[]') || []; }
    catch (e) { return []; }
  }
  function recordRecent(url) {
    if (!isWeb(url)) return;
    try {
      var host = hostOf(url);
      if (!host) return;
      var list = getRecents().filter(function (r) { return r.url !== url; });
      list.unshift({ url: url, host: host, title: DP.state.title || host, ts: Date.now() });
      localStorage.setItem('devphone.recents', JSON.stringify(list.slice(0, 8)));
    } catch (e) {}
  }

  /* ---------- chrome bars --------------------------------------------------------- */

  function chromeRoot() { return $('browser-chrome'); }

  function renderSafari() {
    chromeRoot().innerHTML =
      '<div class="bc bc-safari">' +
        '<div class="saf-bar">' +
          '<div class="saf-pill" id="saf-pill">' +
            svgLock(12) +
            '<span class="pill-host" id="saf-host">Start Page</span>' +
            '<button class="saf-reload" id="saf-reload" title="Reload">' + svgReload() + '</button>' +
          '</div>' +
          '<div class="saf-tools">' +
            '<button id="saf-back" title="Back">' + svgChevron('back') + '</button>' +
            '<button id="saf-fwd" title="Forward">' + svgChevron('fwd') + '</button>' +
            '<button id="saf-share" title="Share">' + svgShare() + '</button>' +
            '<button id="saf-tabs" title="Tabs">' + svgTabs() + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    $('saf-reload').addEventListener('click', function (e) { e.stopPropagation(); DP.navAction('reload'); });
    $('saf-back').addEventListener('click', function () { DP.navAction('back'); });
    $('saf-fwd').addEventListener('click', function () { DP.navAction('forward'); });
    $('saf-share').addEventListener('click', openShareSheet);
    $('saf-tabs').addEventListener('click', function () { DP.toast('🗂️ Tabs are decorative'); });
    $('saf-pill').addEventListener('click', function () {
      if (collapsed) { setCollapsed(false); return; }
      editUrlInline($('saf-pill'), 'pill-edit');
    });
  }

  function renderChromeAndroid() {
    var bottom = addrBarBottom();
    chromeRoot().innerHTML =
      '<div class="bc bc-chrome' + (bottom ? ' addr-bottom' : '') + '">' +
        (bottom ? '<div class="chr-statusfill"></div>' : '') +
        '<div class="menu-catcher" hidden></div>' +
        '<div class="chr-bar">' +
          '<div class="chr-field" id="chr-field">' +
            svgLock(12) +
            '<span class="pill-host" id="chr-host">Search or type web address</span>' +
            '<button class="chr-reload" id="chr-reload" title="Reload">' + svgReload(16) + '</button>' +
          '</div>' +
          '<button class="chr-tabs" id="chr-tabs" title="Tabs">1</button>' +
          '<button class="chr-menu" id="chr-menu" title="Menu">⋮</button>' +
        '</div>' +
        '<div class="menu-pop" id="chr-menu-pop" hidden>' +
          '<div class="menu-navrow">' +
            '<button id="chr-back" title="Back">' + svgChevron('back') + '</button>' +
            '<button id="chr-fwd" title="Forward">' + svgChevron('fwd') + '</button>' +
            '<button id="chr-reload2" title="Reload">' + svgReload(18) + '</button>' +
            '<button id="chr-ext" title="Open in system browser">' + svgExternal() + '</button>' +
          '</div>' +
          '<button class="menu-item" id="chr-newtab">New tab</button>' +
          '<button class="menu-item" id="chr-a2hs">Add to Home screen</button>' +
          '<button class="menu-item" id="chr-addrbar">' +
            (bottom ? 'Move address bar to top' : 'Move address bar to bottom') + '</button>' +
          '<button class="menu-item" id="chr-copy">Copy link</button>' +
        '</div>' +
      '</div>';

    $('chr-reload').addEventListener('click', function (e) { e.stopPropagation(); DP.navAction('reload'); });
    $('chr-field').addEventListener('click', function () { editUrlInline($('chr-field'), 'pill-edit'); });
    $('chr-tabs').addEventListener('click', function () { DP.toast('🗂️ Tabs are decorative'); });
    // menu opens on MOUSEDOWN so the first press lands even mid focus-juggle
    $('chr-menu').addEventListener('mousedown', function (e) {
      e.stopPropagation();
      setMenuOpen($('chr-menu-pop'), $('chr-menu-pop').hidden);
    });
    wireMenuCatcher();
    $('chr-back').addEventListener('click', function () { hideMenus(); DP.navAction('back'); });
    $('chr-fwd').addEventListener('click', function () { hideMenus(); DP.navAction('forward'); });
    $('chr-reload2').addEventListener('click', function () { hideMenus(); DP.navAction('reload'); });
    $('chr-ext').addEventListener('click', function () {
      hideMenus();
      if (isWeb(DP.state.url)) DP.invoke('open:external', { url: DP.state.url });
    });
    $('chr-newtab').addEventListener('click', function () { hideMenus(); showStart('chrome'); });
    $('chr-a2hs').addEventListener('click', function () { hideMenus(); beginAddToHome('chrome'); });
    $('chr-addrbar').addEventListener('click', function () {
      hideMenus();
      if (DP.settings && DP.settings.setAddrBar) {
        DP.settings.setAddrBar(bottom ? 'top' : 'bottom'); // re-render via settings-changed
      }
    });
    $('chr-copy').addEventListener('click', function () {
      hideMenus();
      copyLink();
    });
  }

  function renderSamsung() {
    chromeRoot().innerHTML =
      '<div class="bc bc-samsung">' +
        '<div class="menu-catcher" hidden></div>' +
        '<div class="sam-top">' +
          '<div class="sam-field" id="sam-field">' +
            svgLock(12) +
            '<span class="pill-host" id="sam-host">Search or enter URL</span>' +
            '<button class="sam-reload" id="sam-reload" title="Reload">' + svgReload(15) + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="sam-bottom">' +
          '<button id="sam-back" title="Back">' + svgChevron('back') + '</button>' +
          '<button id="sam-fwd" title="Forward">' + svgChevron('fwd') + '</button>' +
          '<button id="sam-home" title="Home page">' + svgHome() + '</button>' +
          '<button id="sam-tabs" title="Tabs"><span class="sam-tabcount">1</span></button>' +
          '<button id="sam-menu" title="Menu"><svg width="20" height="20" viewBox="0 0 22 22" fill="currentColor"><circle cx="4.5" cy="11" r="1.9"/><circle cx="11" cy="11" r="1.9"/><circle cx="17.5" cy="11" r="1.9"/></svg></button>' +
        '</div>' +
        '<div class="menu-pop sam-menu-pop" id="sam-menu-pop" hidden>' +
          '<button class="menu-item" id="sam-a2hs">Add page to → Home screen</button>' +
          '<button class="menu-item" id="sam-copy">Copy link</button>' +
          '<button class="menu-item" id="sam-ext">Open in system browser</button>' +
        '</div>' +
      '</div>';

    $('sam-reload').addEventListener('click', function (e) { e.stopPropagation(); DP.navAction('reload'); });
    $('sam-field').addEventListener('click', function () { editUrlInline($('sam-field'), 'pill-edit'); });
    $('sam-back').addEventListener('click', function () { DP.navAction('back'); });
    $('sam-fwd').addEventListener('click', function () { DP.navAction('forward'); });
    $('sam-home').addEventListener('click', function () { showStart('samsung'); });
    $('sam-tabs').addEventListener('click', function () { DP.toast('🗂️ Tabs are decorative'); });
    // menu opens on MOUSEDOWN — first press lands
    $('sam-menu').addEventListener('mousedown', function (e) {
      e.stopPropagation();
      setMenuOpen($('sam-menu-pop'), $('sam-menu-pop').hidden);
    });
    wireMenuCatcher();
    $('sam-a2hs').addEventListener('click', function () { hideMenus(); beginAddToHome('samsung'); });
    $('sam-copy').addEventListener('click', function () { hideMenus(); copyLink(); });
    $('sam-ext').addEventListener('click', function () {
      hideMenus();
      if (isWeb(DP.state.url)) DP.invoke('open:external', { url: DP.state.url });
    });
  }

  function menuCatcher() {
    var root = chromeRoot();
    return root ? root.querySelector('.menu-catcher') : null;
  }

  // toggle a ⋮/⋯ menu together with its in-screen click-catcher. The catcher
  // covers the page + bars below the open menu, so ONE tap anywhere outside
  // the menu closes it AND is swallowed — clicks in the webview don't bubble
  // to this document, the catcher is what makes outside-tap-to-close work.
  function setMenuOpen(popEl, open) {
    if (!popEl) return;
    popEl.hidden = !open;
    var cat = menuCatcher();
    if (cat) cat.hidden = !open;
  }

  function hideMenus() {
    ['chr-menu-pop', 'sam-menu-pop'].forEach(function (id) {
      var n = $(id);
      if (n) n.hidden = true;
    });
    var cat = menuCatcher();
    if (cat) cat.hidden = true;
  }

  function wireMenuCatcher() {
    var cat = menuCatcher();
    if (!cat) return;
    cat.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      try { cat.setPointerCapture(e.pointerId); } catch (err) {}
      // close the menus but keep the catcher up until the press completes so
      // the matching mouseup/click can't fall through to what's underneath
      ['chr-menu-pop', 'sam-menu-pop'].forEach(function (id) {
        var n = $(id);
        if (n) n.hidden = true;
      });
    });
    function release(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      // hide the catcher only when no menu is open anymore. The pointerUP
      // of the very click that OPENED a menu (menus open on mousedown of
      // ⋮/⋯) lands on the freshly shown catcher — unconditionally hiding
      // here dropped the shield while the menu was still open, so the next
      // page press hit the touch-layer (which preventDefaults, so the
      // document-mousedown closer never saw it) and the menu stayed open.
      // (v0.1.4; previously masked by a stale-press leak in the layer.)
      var anyOpen = ['chr-menu-pop', 'sam-menu-pop'].some(function (id) {
        var n = $(id);
        return !!(n && !n.hidden);
      });
      if (!anyOpen) cat.hidden = true;
    }
    cat.addEventListener('pointerup', release);
    cat.addEventListener('pointercancel', release);
    cat.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
  }

  // close on the FIRST press anywhere else (mousedown, not click).
  // .menu-catcher presses manage themselves (they must NOT hide the catcher
  // before the press completes).
  document.addEventListener('mousedown', function (e) {
    if (e.target.closest('.menu-catcher')) return;
    if (!e.target.closest('.menu-pop') && !e.target.closest('#chr-menu') && !e.target.closest('#sam-menu')) hideMenus();
  });

  function copyLink() {
    if (!DP.state.url || !isWeb(DP.state.url)) { DP.toast('Nothing to copy yet'); return; }
    try {
      navigator.clipboard.writeText(DP.state.url).then(
        function () { DP.toast('🔗 Link copied'); },
        function () { DP.toast('⚠️ Copy failed'); }
      );
    } catch (e) { DP.toast('⚠️ Copy failed'); }
  }

  /* ---------- inline URL editing ---------------------------------------------------- */

  function editUrlInline(container, cls) {
    if (container.querySelector('input')) return;
    var input = document.createElement('input');
    input.className = cls;
    input.type = 'text';
    input.value = isWeb(DP.state.url) ? DP.state.url : '';
    input.placeholder = 'Search or enter website';
    input.spellcheck = false;
    container.appendChild(input);
    input.focus();
    input.select();
    var done = false;
    function teardown() {
      if (done) return;
      done = true;
      input.remove();
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var url = smartUrl(input.value);
        if (!url) { input.classList.add('shake'); setTimeout(function () { input.classList.remove('shake'); }, 350); return; }
        teardown();
        go(url);
      } else if (e.key === 'Escape') teardown();
    });
    input.addEventListener('blur', function () { setTimeout(teardown, 120); });
    input.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  /* ---------- Safari collapse on scroll ----------------------------------------------- */

  function setCollapsed(on) {
    if (!current || current.type !== 'browser' || current.browser !== 'safari') return;
    if (collapsed === on) return;
    collapsed = on;
    var bc = chromeRoot().querySelector('.bc-safari');
    if (bc) bc.classList.toggle('collapsed', on);
    // content area grows/shrinks with the pill (real dvh behavior); the
    // resize is CSS-animated and the viewport re-send is debounced ~250ms
    relayout();
  }

  DP.bus.on('scroll', function (y) {
    if (!current || current.type !== 'browser' || current.browser !== 'safari' || startVisible) return;
    if (y > lastScrollY + 6 && y > 60) setCollapsed(true);
    else if (y < lastScrollY - 6 || y <= 10) setCollapsed(false);
    lastScrollY = y;
  });

  /* ---------- nav-state → UI updates ---------------------------------------------------- */

  function displayHost() {
    if (startVisible || !isWeb(DP.state.url)) return null;
    return hostOf(DP.state.url);
  }

  function updateBars() {
    if (!current || current.type !== 'browser') return;
    var host = displayHost();
    var safHost = $('saf-host'), chrHost = $('chr-host'), samHost = $('sam-host');
    if (safHost) safHost.textContent = host || 'Start Page';
    if (chrHost) chrHost.textContent = host || 'Search or type web address';
    if (samHost) samHost.textContent = host || 'Search or enter URL';
    var lock = chromeRoot().querySelector('.pill-lock');
    if (lock) lock.style.visibility = host ? 'visible' : 'hidden';
    [['saf-back', 'saf-fwd'], ['chr-back', 'chr-fwd'], ['sam-back', 'sam-fwd']].forEach(function (pair) {
      var b = $(pair[0]), f = $(pair[1]);
      if (b) b.disabled = !DP.state.canGoBack;
      if (f) f.disabled = !DP.state.canGoForward;
    });
  }

  // global settings changed (e.g. address-bar position) → rebuild Chrome bar
  DP.bus.on('settings-changed', function () {
    if (current && current.type === 'browser' && current.browser === 'chrome') {
      renderChromeAndroid();
      chromeRoot().hidden = false;
      updateBars();
    }
  });

  DP.bus.on('navstate', updateBars);
  DP.bus.on('navigated', function (info) {
    var url = info && info.url;
    if (isWeb(url)) {
      if (startVisible) hideStart();
      recordRecent(url);
    }
    updateBars();
  });
  DP.bus.on('title', function () {
    // refresh stored recents title for the current URL
    if (isWeb(DP.state.url)) recordRecent(DP.state.url);
  });

  /* ---------- start page ------------------------------------------------------------------ */

  var QUICK_LINKS = [
    { name: 'Skycrew Portal', url: 'https://skycrewltd.ca/portal/' }
  ];

  function showStart(browser) {
    var sp = $('startpage');
    if (!sp) return;
    startVisible = true;
    setCollapsed(false);
    sp.className = 'sp sp-' + browser;
    sp.hidden = false;

    var tiles = QUICK_LINKS.map(function (q) {
      return '<button class="sp-tile" data-url="' + DP.esc(q.url) + '">' +
               '<span class="tile-ico" style="background:' + DP.hashColor(q.name) + '">' +
                 faviconImg(hostOf(q.url)) + '</span>' +
               '<span class="tl">' + DP.esc(q.name) + '</span>' +
             '</button>';
    });
    getRecents().slice(0, 7).forEach(function (r) {
      tiles.push(
        '<button class="sp-tile" data-url="' + DP.esc(r.url) + '">' +
          '<span class="tile-ico" style="background:' + DP.hashColor(r.host) + '">' +
            faviconImg(r.host) + '</span>' +
          '<span class="tl">' + DP.esc(r.host) + '</span>' +
        '</button>');
    });

    var recents = getRecents();
    var recentRows = recents.length
      ? recents.map(function (r) {
          return '<button class="r-row" data-url="' + DP.esc(r.url) + '">' +
                   '<span class="r-ico" style="background:' + DP.hashColor(r.host) + '">' +
                     faviconImg(r.host, 32) + '</span>' +
                   '<span class="r-meta"><div class="r-host">' + DP.esc(r.title || r.host) + '</div>' +
                   '<div class="r-url">' + DP.esc(r.url) + '</div></span>' +
                 '</button>';
        }).join('')
      : '<li class="sp-empty">Pages you visit will show up here.</li>';

    var titles = { safari: 'Start Page', chrome: 'New tab', samsung: 'Quick access' };
    sp.innerHTML =
      '<div class="sp-title">' + titles[browser] + '</div>' +
      '<form class="sp-search"><input type="text" placeholder="Search or enter website" spellcheck="false"></form>' +
      '<div class="sp-sec">Favorites</div>' +
      '<div class="sp-tiles">' + tiles.join('') + '</div>' +
      '<div class="sp-sec">Recent</div>' +
      '<ul class="sp-recents">' + recentRows + '</ul>';

    var form = sp.querySelector('.sp-search');
    var input = form.querySelector('input');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var url = smartUrl(input.value);
      if (!url) {  // "no dots" → about:blank no-op, just nudge the field
        input.classList.add('shake');
        setTimeout(function () { input.classList.remove('shake'); }, 350);
        return;
      }
      go(url);
    });
    sp.addEventListener('click', function (e) {
      var t = e.target.closest('[data-url]');
      if (t) go(t.getAttribute('data-url'));
    });
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 80);
    updateBars();
    DP.applyStatusTheme();
  }

  function hideStart() {
    var sp = $('startpage');
    if (sp) { sp.hidden = true; sp.innerHTML = ''; }
    startVisible = false;
  }

  function go(url) {
    hideStart();
    DP.navigate(url);
    updateBars();
  }

  /* ---------- share sheet & Add-to-Home-Screen ----------------------------------------------- */

  function sheetLayer() { return $('sheet-layer'); }

  function showSheet(innerHtml) {
    var layer = sheetLayer();
    layer.hidden = false;
    layer.innerHTML = '<div class="sheet-backdrop"></div>' + innerHtml;
    layer.querySelector('.sheet-backdrop').addEventListener('click', closeSheet);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { layer.classList.add('show'); });
    });
    return layer;
  }
  function closeSheet() {
    var layer = sheetLayer();
    layer.classList.remove('show');
    setTimeout(function () {
      layer.hidden = true;
      layer.innerHTML = '';
    }, 300);
  }

  function pageFavHtml() {
    var host = hostOf(DP.state.url);
    return '<span class="sheet-fav" style="background:' + DP.hashColor(host) + '">' +
           faviconImg(host, 48) + '</span>';
  }

  function openShareSheet() {
    if (!isWeb(DP.state.url)) { DP.toast('Open a website first'); return; }
    var layer = showSheet(
      '<div class="sheet">' +
        '<div class="sheet-grab"></div>' +
        '<div class="sheet-page">' + pageFavHtml() +
          '<span><div class="sp-t">' + DP.esc(DP.state.title || hostOf(DP.state.url)) + '</div>' +
          '<div class="sp-u">' + DP.esc(DP.state.url) + '</div></span>' +
        '</div>' +
        '<div class="sheet-actions">' +
          '<button id="sh-a2hs">Add to Home Screen <span class="ic">' + svgPlusSquare() + '</span></button>' +
          '<button id="sh-copy">Copy Link <span class="ic">' + svgCopy() + '</span></button>' +
          '<button id="sh-ext">Open in System Browser <span class="ic">' + svgExternal() + '</span></button>' +
        '</div>' +
        '<button class="sheet-cancel" id="sh-cancel">Cancel</button>' +
      '</div>');
    layer.querySelector('#sh-cancel').addEventListener('click', closeSheet);
    layer.querySelector('#sh-copy').addEventListener('click', function () { closeSheet(); copyLink(); });
    layer.querySelector('#sh-ext').addEventListener('click', function () {
      closeSheet();
      DP.invoke('open:external', { url: DP.state.url });
    });
    layer.querySelector('#sh-a2hs').addEventListener('click', function () {
      closeSheet();
      setTimeout(function () { beginAddToHome('safari'); }, 320);
    });
  }

  function beginAddToHome(style) {
    var pageUrl = DP.state.url;
    if (!isWeb(pageUrl)) { DP.toast('Open a website first'); return; }
    DP.toast('🔍 Reading manifest…', 1600);
    DP.invoke('pwa:manifest', { pageUrl: pageUrl }).then(function (res) {
      var ok = res && res.ok;
      var info = {
        name: (ok && (res.shortName || res.name)) || DP.state.title || hostOf(pageUrl),
        icon: (ok && res.iconDataUrl) || null,
        startUrl: (ok && res.startUrl) || pageUrl,
        display: (ok && res.display) || 'browser',
        themeColor: (ok && res.themeColor) || null
      };
      if (!ok) DP.toast('ℹ️ No manifest — added as bookmark', 2200);
      confirmAddToHome(info, style);
    });
  }

  function confirmAddToHome(info, style) {
    var iconHtml = info.icon
      ? '<img src="' + DP.esc(info.icon) + '" alt="">'
      : DP.esc((info.name || '?').charAt(0).toUpperCase());
    var iconStyle = info.icon ? '' : ' style="background:' + DP.hashColor(info.name) + '"';
    var layer;

    if (style === 'safari') {
      layer = showSheet(
        '<div class="sheet">' +
          '<div class="a2hs-head">' +
            '<button id="a2hs-cancel">Cancel</button>' +
            '<span class="a2hs-title">Add to Home Screen</span>' +
            '<button class="a2hs-add" id="a2hs-add">Add</button>' +
          '</div>' +
          '<div class="a2hs-body">' +
            '<span class="a2hs-icon"' + iconStyle + '>' + iconHtml + '</span>' +
            '<span class="a2hs-fields">' +
              '<input class="a2hs-name" id="a2hs-name" value="' + DP.esc(info.name) + '" spellcheck="false">' +
              '<div class="a2hs-url">' + DP.esc(info.startUrl) + '</div>' +
            '</span>' +
          '</div>' +
          '<div class="a2hs-note">An icon will be added to your Home Screen so you can quickly access this website.</div>' +
        '</div>');
    } else {
      layer = showSheet(
        '<div class="dlg' + (style === 'samsung' ? ' sam-dlg' : '') + '">' +
          '<div class="dlg-title">Add to Home screen</div>' +
          '<div class="dlg-body">' +
            '<span class="a2hs-icon"' + iconStyle + '>' + iconHtml + '</span>' +
            '<span class="a2hs-fields">' +
              '<input class="a2hs-name" id="a2hs-name" value="' + DP.esc(info.name) + '" spellcheck="false">' +
              '<div class="a2hs-url">' + DP.esc(hostOf(info.startUrl)) + '</div>' +
            '</span>' +
          '</div>' +
          '<div class="dlg-actions">' +
            '<button id="a2hs-cancel">Cancel</button>' +
            '<button id="a2hs-add">Add</button>' +
          '</div>' +
        '</div>');
    }

    layer.querySelector('#a2hs-cancel').addEventListener('click', closeSheet);
    layer.querySelector('#a2hs-add').addEventListener('click', function () {
      var nameInput = layer.querySelector('#a2hs-name');
      var app = {
        id: 'pwa-' + Date.now().toString(36),
        name: (nameInput && nameInput.value.trim()) || info.name,
        icon: info.icon,
        startUrl: info.startUrl,
        themeColor: info.themeColor,
        display: info.display,
        addedAt: Date.now()
      };
      closeSheet();
      if (DP.home) DP.home.installApp(app);
      DP.toast('✅ Added to Home Screen', 2200);
      setTimeout(function () { DP.goHome(); }, 350);
    });
  }

  /* ---------- open / close / standalone launch -------------------------------------------------- */

  function open(browser, opts) {
    opts = opts || {};
    if (!browser || !{ safari: 1, chrome: 1, samsung: 1 }[browser]) browser = 'safari';
    current = { type: 'browser', browser: browser };
    DP.state.app = current;
    collapsed = false;
    lastScrollY = 0;
    if (DP.home) DP.home.hide();

    if (browser === 'safari') renderSafari();
    else if (browser === 'samsung') renderSamsung();
    else renderChromeAndroid();
    chromeRoot().hidden = false;

    if (opts.url) {
      var url = smartUrl(opts.url) || opts.url;
      hideStart();
      DP.navigate(url);
    } else if (isWeb(DP.state.url)) {
      // browser re-opened with a page still loaded — resume it
      hideStart();
    } else {
      showStart(browser);
    }
    updateBars();
    DP.applyStatusTheme();
    DP.updateHomeIndicator();
    relayout();
  }

  function launchApp(app) {
    if (!app || !app.startUrl) return;
    var standaloneDisplay = { standalone: 1, fullscreen: 1, 'minimal-ui': 1 }[app.display];
    if (!standaloneDisplay) {
      // plain bookmark → open in the device's default browser
      var d = DP.state.device;
      open((d && d.browsers && d.browsers[0]) || 'safari', { url: app.startUrl });
      return;
    }
    current = { type: 'pwa', app: app };
    DP.state.app = current;
    if (DP.home) DP.home.hide();
    hideStart();
    chromeRoot().hidden = true;             // no browser chrome in standalone
    chromeRoot().innerHTML = '';
    DP.state.standalone = true;
    DP.invoke('standalone:set', { on: true, themeColor: app.themeColor || undefined });
    DP.navigate(app.startUrl);
    DP.state.themeColor = app.themeColor || null;
    DP.applyStatusTheme();
    DP.updateHomeIndicator();
    relayout();   // Android: black status strip; iOS: edge-to-edge
    DP.toast('▶️ ' + app.name, 2000);
  }

  function close() {
    current = null;
    collapsed = false;
    hideStart();
    closeSheet();
    var root = chromeRoot();
    if (root) { root.hidden = true; root.innerHTML = ''; }
  }

  DP.chrome = {
    open: open,
    close: close,
    launchApp: launchApp,
    getInsets: getInsets,
    isOpen: function () { return !!current; }
  };

})();
