'use strict';

/*
 * update.js — the in-app auto-update UX. Self-contained renderer
 * module: listens to window.devphone.onAppUpdate (electron-updater events from
 * cloudupdate.js) and drives a phone-styled popup:
 *
 *   available  → "What's new" card + changelog + [Later] [Update now]
 *   progress   → download bar with live percent
 *   downloaded → brief "Installing" confirmation, then automatic restart
 *
 * The Update button starts the download; completion calls appUpdateInstall()
 * automatically so the complete update remains a one-click flow. The whole
 * thing is decoupled from the rest of the shell — it builds its own overlay and
 * a full-window confetti canvas. A demo mode (Ctrl+Shift+U, or window.dpuDemo)
 * runs the same UI with fake data so the flow can be previewed without a real
 * release.
 */

(function () {
  // Compact phone glyph (same art as the app icon) for the popup header.
  var HEADER_SVG =
    '<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">' +
    '<defs>' +
    '<linearGradient id="dpuBg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366F1"/><stop offset=".5" stop-color="#8B5CF6"/><stop offset="1" stop-color="#A855F7"/></linearGradient>' +
    '<linearGradient id="dpuBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#33333A"/><stop offset="1" stop-color="#141417"/></linearGradient>' +
    '<linearGradient id="dpuScreen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22D3EE"/><stop offset=".52" stop-color="#3B82F6"/><stop offset="1" stop-color="#818CF8"/></linearGradient>' +
    '</defs>' +
    '<rect x="8" y="8" width="240" height="240" rx="56" fill="url(#dpuBg)"/>' +
    '<rect x="76" y="30" width="104" height="196" rx="27" fill="url(#dpuBody)" stroke="#9AA0AB" stroke-width="2"/>' +
    '<rect x="83" y="38" width="90" height="180" rx="20" fill="url(#dpuScreen)"/>' +
    '<rect x="111" y="47" width="34" height="11" rx="5.5" fill="#0A0A0C"/>' +
    '<rect x="112" y="205" width="32" height="4.5" rx="2.25" fill="#fff" fill-opacity=".55"/>' +
    '</svg>';

  var CONFETTI_COLORS = ['#22D3EE', '#6366F1', '#8B5CF6', '#A855F7', '#F472B6', '#34D399', '#FBBF24', '#FB7185'];

  var els = null;
  var cur = { state: 'idle', version: '', demo: false };
  var confetti = { raf: 0, parts: [], ctx: null, running: false, t0: 0 };

  function esc(s) {
    if (window.DP && DP.esc) return DP.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function notify(msg) {
    if (window.DP && DP.toast) DP.toast(msg);
  }

  /* ---------- DOM ---------- */

  function build() {
    if (els) return;
    var ov = document.createElement('div');
    ov.id = 'dpu-overlay';
    ov.hidden = true;
    ov.innerHTML =
      '<div class="dpu-backdrop"></div>' +
      '<canvas class="dpu-confetti"></canvas>' +
      '<div class="dpu-card" role="dialog" aria-modal="true" aria-labelledby="dpu-title">' +
        '<div class="dpu-head">' +
          '<span class="dpu-appicon" aria-hidden="true">' + HEADER_SVG + '</span>' +
          '<div class="dpu-heads">' +
            '<div class="dpu-title" id="dpu-title">Update available</div>' +
            '<div class="dpu-ver"></div>' +
          '</div>' +
        '</div>' +
        '<div class="dpu-body">' +
          '<div class="dpu-view dpu-notes">' +
            '<div class="dpu-whatsnew">What’s new</div>' +
            '<ul class="dpu-changelog"></ul>' +
          '</div>' +
          '<div class="dpu-view dpu-progress" hidden>' +
            '<div class="dpu-bar"><div class="dpu-bar-fill"></div></div>' +
            '<div class="dpu-progmeta"><span class="dpu-pct">0%</span><span class="dpu-speed"></span></div>' +
          '</div>' +
          '<div class="dpu-view dpu-done" hidden>' +
            '<div class="dpu-done-emoji">🎉</div>' +
            '<div class="dpu-done-sub">DevPhone is up to date.</div>' +
          '</div>' +
        '</div>' +
        '<div class="dpu-actions">' +
          '<button type="button" class="dpu-btn dpu-later">Later</button>' +
          '<button type="button" class="dpu-btn dpu-primary dpu-go">Update now</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    els = {
      overlay: ov,
      card: ov.querySelector('.dpu-card'),
      title: ov.querySelector('.dpu-title'),
      ver: ov.querySelector('.dpu-ver'),
      changelog: ov.querySelector('.dpu-changelog'),
      viewNotes: ov.querySelector('.dpu-notes'),
      viewProgress: ov.querySelector('.dpu-progress'),
      viewDone: ov.querySelector('.dpu-done'),
      doneSub: ov.querySelector('.dpu-done-sub'),
      doneEmoji: ov.querySelector('.dpu-done-emoji'),
      barFill: ov.querySelector('.dpu-bar-fill'),
      pct: ov.querySelector('.dpu-pct'),
      speed: ov.querySelector('.dpu-speed'),
      actions: ov.querySelector('.dpu-actions'),
      later: ov.querySelector('.dpu-later'),
      go: ov.querySelector('.dpu-go'),
      canvas: ov.querySelector('.dpu-confetti'),
    };

    els.later.addEventListener('click', onLater);
    els.go.addEventListener('click', onPrimary);
    ov.querySelector('.dpu-backdrop').addEventListener('click', function () {
      if (cur.state === 'notes') onLater();
    });
    window.addEventListener('keydown', function (e) {
      if (!els.overlay.hidden && e.key === 'Escape' && cur.state === 'notes') { onLater(); }
    });
  }

  function showView(name) {
    els.viewNotes.hidden = name !== 'notes';
    els.viewProgress.hidden = name !== 'progress';
    els.viewDone.hidden = name !== 'done';
  }

  /* ---------- states ---------- */

  function renderChangelog(notes) {
    var lines = String(notes || '')
      .split(/\r?\n/)
      .map(function (s) { return s.replace(/^\s*[-*•]\s*/, '').trim(); })
      .filter(function (s) { return s && !/^#{1,6}\s/.test(s) && !/^what'?s new/i.test(s); });
    if (!lines.length) lines = ['Improvements and fixes.'];
    els.changelog.innerHTML = lines.slice(0, 10).map(function (s) {
      return '<li><span class="dpu-dot" aria-hidden="true"></span><span>' + esc(s) + '</span></li>';
    }).join('');
  }

  function toAvailable(version, notes) {
    cur.state = 'notes';
    cur.version = version || '';
    els.title.textContent = 'Update available';
    els.ver.textContent = version ? 'Version ' + version : '';
    renderChangelog(notes);
    showView('notes');
    els.actions.hidden = false;
    els.later.hidden = false;
    els.later.textContent = 'Later';
    els.go.hidden = false;
    els.go.textContent = 'Update now';
    els.go.disabled = false;
    stopConfetti();
    els.overlay.hidden = false;
  }

  function toProgress() {
    cur.state = 'progress';
    els.title.textContent = 'Downloading update';
    setProgress(0, 0);
    showView('progress');
    els.later.hidden = true;
    els.go.hidden = true;
    els.overlay.hidden = false;
  }

  function setProgress(percent, bytesPerSecond) {
    var p = Math.max(0, Math.min(100, Math.round(percent || 0)));
    els.barFill.style.width = p + '%';
    els.pct.textContent = p + '%';
    els.speed.textContent = bytesPerSecond ? fmtRate(bytesPerSecond) : '';
  }

  function fmtRate(bps) {
    var mb = bps / (1024 * 1024);
    if (mb >= 1) return mb.toFixed(1) + ' MB/s';
    return Math.max(1, Math.round(bps / 1024)) + ' KB/s';
  }

  function toDone(version) {
    cur.state = 'restarting';
    if (version) cur.version = version;
    els.title.textContent = 'Installing update';
    els.doneEmoji.textContent = '✨';
    els.doneSub.textContent = cur.version
      ? 'DevPhone ' + cur.version + ' will restart automatically.'
      : 'DevPhone will restart automatically.';
    showView('done');
    els.actions.hidden = true;
    els.overlay.hidden = false;
    els.card.classList.remove('dpu-poof');
    void els.card.offsetWidth; // restart the pop animation
    els.card.classList.add('dpu-poof');
    startConfetti();
    if (!cur.demo) {
      setTimeout(function () {
        if (window.devphone && devphone.appUpdateInstall) {
          devphone.appUpdateInstall().then(function (r) {
            if (r && r.ok === false) {
              notify('The update is ready. Restart DevPhone to finish installing it.');
              hide();
            }
          }).catch(function () {
            notify('The update is ready. Restart DevPhone to finish installing it.');
            hide();
          });
        } else {
          notify('The update is ready. Restart DevPhone to finish installing it.');
          hide();
        }
      }, 900);
    }
  }

  function hide() {
    if (els) els.overlay.hidden = true;
    stopConfetti();
    cur.state = 'idle';
  }

  /* ---------- button handlers ---------- */

  function onLater() { hide(); }

  function onPrimary() {
    if (cur.state === 'notes') {
      toProgress();
      if (cur.demo) { runDemoProgress(); return; }
      if (window.devphone && devphone.appUpdateDownload) {
        devphone.appUpdateDownload().then(function (r) {
          if (r && r.ok === false) { notify('Update download failed.'); hide(); }
        });
      }
    }
  }

  /* ---------- manual "check for updates" (Settings → About) ---------- */

  var manualPending = false;
  var manualTimer = 0;

  function manualCheck() {
    if (!(window.devphone && devphone.appUpdateCheck)) { notify('Updates aren’t available in this build.'); return; }
    manualPending = true;
    clearTimeout(manualTimer);
    manualTimer = setTimeout(function () { manualPending = false; }, 20000);
    notify('Checking for updates…');
    devphone.appUpdateCheck().then(function (r) {
      if (r && r.ok === false) { manualPending = false; notify('Couldn’t check for updates.'); }
    });
  }

  /* ---------- events from main ---------- */

  function onEvent(e) {
    if (!e || !e.type) return;
    if (cur.demo && e.type !== 'error') return; // don't let a background check stomp a demo
    // A user-triggered check gets explicit feedback (an automatic one stays silent).
    if (manualPending && (e.type === 'none' || e.type === 'available' || e.type === 'error')) {
      manualPending = false;
      clearTimeout(manualTimer);
      if (e.type === 'none') { notify(e.dev ? 'Update checks run in the installed app.' : 'You’re on the latest version.'); return; }
      if (e.type === 'error') { notify('Couldn’t check for updates. Try again later.'); return; }
      // 'available' falls through to show the popup
    }
    switch (e.type) {
      case 'available': toAvailable(e.version, e.notes); break;
      case 'progress': if (cur.state !== 'progress') toProgress(); setProgress(e.percent, e.bytesPerSecond); break;
      case 'downloaded': setProgress(100, 0); setTimeout(function () { toDone(e.version); }, 350); break;
      case 'error':
        if (cur.state === 'progress' || cur.state === 'notes') { notify('Update failed. Try again later.'); hide(); }
        break;
      default: break; // checking / none — silent
    }
  }

  /* ---------- confetti ---------- */

  function startConfetti() {
    var c = els.canvas;
    var dpr = window.devicePixelRatio || 1;
    c.width = window.innerWidth * dpr;
    c.height = window.innerHeight * dpr;
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    confetti.ctx = ctx;
    confetti.parts = [];
    var W = window.innerWidth, H = window.innerHeight;
    var n = 160;
    for (var i = 0; i < n; i++) {
      var fromLeft = i % 2 === 0;
      confetti.parts.push({
        x: fromLeft ? W * 0.2 : W * 0.8,
        y: H * 0.42,
        vx: (fromLeft ? 1 : -1) * (2 + Math.random() * 6) + (Math.random() - 0.5) * 3,
        vy: -(6 + Math.random() * 9),
        g: 0.22 + Math.random() * 0.12,
        w: 6 + Math.random() * 6,
        h: 9 + Math.random() * 8,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.4,
        color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
        life: 0,
      });
    }
    confetti.running = true;
    confetti.t0 = 0;
    cancelAnimationFrame(confetti.raf);
    confetti.raf = requestAnimationFrame(confettiStep);
  }

  function confettiStep(ts) {
    if (!confetti.running) return;
    if (!confetti.t0) confetti.t0 = ts;
    var elapsed = ts - confetti.t0;
    var ctx = confetti.ctx;
    var W = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);
    var alive = 0;
    for (var i = 0; i < confetti.parts.length; i++) {
      var p = confetti.parts[i];
      p.life += 1;
      p.vy += p.g;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y < H + 40) alive++;
      var fade = elapsed > 2000 ? Math.max(0, 1 - (elapsed - 2000) / 900) : 1;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (elapsed < 3200 && alive > 0) {
      confetti.raf = requestAnimationFrame(confettiStep);
    } else {
      stopConfetti();
    }
  }

  function stopConfetti() {
    confetti.running = false;
    cancelAnimationFrame(confetti.raf);
    if (confetti.ctx) confetti.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  /* ---------- demo (Ctrl+Shift+U) ---------- */

  var DEMO_NOTES =
    'Regular tablets now open larger at 75%\n' +
    'Oversized Ultra and iPad Pro models still fit at 50%\n' +
    'Zoom is remembered separately for every tablet';

  function runDemo() {
    cur.demo = true;
    toAvailable('0.1.9', DEMO_NOTES);
  }

  function runDemoProgress() {
    var p = 0;
    var iv = setInterval(function () {
      p += 6 + Math.random() * 12;
      if (p >= 100) {
        p = 100; clearInterval(iv);
        setProgress(100, 3.2 * 1024 * 1024);
        setTimeout(function () { toDone('0.1.9'); }, 400);
      } else {
        setProgress(p, (2 + Math.random() * 3) * 1024 * 1024);
      }
    }, 220);
  }

  // Force a specific stage with fake data (used by scripts/shot-update.js).
  window.dpuDemo = function (stage) {
    cur.demo = true;
    if (stage === 'progress') { toAvailable('0.1.9', DEMO_NOTES); toProgress(); setProgress(46, 2.6 * 1024 * 1024); }
    else if (stage === 'done') { toDone('0.1.9'); }
    else runDemo();
  };

  /* ---------- init ---------- */

  function init() {
    build();
    if (window.devphone && devphone.onAppUpdate) devphone.onAppUpdate(onEvent);
    window.dpUpdate = { check: manualCheck }; // Settings → "Check for updates"
    window.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.shiftKey && (e.key === 'U' || e.key === 'u')) { e.preventDefault(); runDemo(); }
    });
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
