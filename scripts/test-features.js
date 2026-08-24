'use strict';

/* Focused integration checks for profiles, clock/toasts, resume, and search. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { _electron } = require('playwright');
const attachment = require('../src/main/attachment');

const ROOT = path.resolve(__dirname, '..');
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devphone-features-'));
const parallelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devphone-profiles-'));
const shotArg = process.argv[2] || process.env.DEVPHONE_FEATURE_SHOT || '';
const shotDir = shotArg ? path.resolve(shotArg) : '';

function assert(value, message) {
  if (!value) throw new Error(message);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitUntil(fn, timeoutMs, message) {
  const deadline = Date.now() + (timeoutMs || 8000);
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(120);
  }
  throw new Error('Timed out: ' + message);
}

async function main() {
  const contextA = {
    hwnd: 41,
    pid: 700,
    processName: 'Codex',
    exe: 'C:\\Apps\\Codex.exe',
    title: 'Codex',
    selected: [{ name: 'DevPhone feature', type: 'ControlType.ListItem' }],
  };
  const target = attachment.targetFromContext(contextA);
  assert(attachment.matchesTarget(target, contextA), 'same selected task should match');
  assert(!attachment.matchesTarget(target, Object.assign({}, contextA, {
    selected: [{ name: 'Another task', type: 'ControlType.ListItem' }],
  })), 'another selected task must not match');

  class FakeWindow extends EventEmitter {
    constructor() { super(); this.visible = true; this.minimized = false; this.top = false; }
    isDestroyed() { return false; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    isAlwaysOnTop() { return this.top; }
    setAlwaysOnTop(on) { this.top = !!on; }
    getNativeWindowHandle() { const value = Buffer.alloc(8); value.writeBigUInt64LE(900n); return value; }
    getBounds() { return { x: 10, y: 20, width: 620, height: 1060 }; }
    hide() { this.visible = false; }
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    restore() { this.minimized = false; this.visible = true; }
  }
  const fakeWindow = new FakeWindow();
  const attachmentLogic = attachment.create({
    app: { getPath: () => path.join(profileDir, 'attachment-logic') },
    selftest: true,
  });
  attachmentLogic.setWindow(fakeWindow, () => {});
  attachmentLogic._testApplyContext(contextA);
  assert(attachmentLogic.attachLast().ok, 'deterministic attachment capture failed');
  const otherContext = Object.assign({}, contextA, { hwnd: 99, pid: 701, exe: 'C:\\Apps\\Other.exe', processName: 'Other' });
  attachmentLogic._testApplyContext(otherContext);
  attachmentLogic._testApplyContext(otherContext);
  assert(!fakeWindow.visible && attachmentLogic.getStatus().autoHidden, 'attached phone did not hide after context switch');
  attachmentLogic._testApplyContext(contextA);
  assert(fakeWindow.visible && !attachmentLogic.getStatus().autoHidden, 'attached phone did not return with target context');
  attachmentLogic.shutdown();

  const electronApp = await _electron.launch({
    args: [ROOT],
    env: Object.assign({}, process.env, { DEVPHONE_USERDATA: profileDir }),
  });

  try {
    const win = await electronApp.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => window.DP && DP.state && DP.state.device);

    const profile = await win.evaluate(() => window.devphone.profileGet());
    assert(profile && profile.ok && profile.profile.name === 'DevPhone', 'default profile identity missing');

    await waitUntil(async () => {
      const result = await win.evaluate(() => window.devphone.attachmentGet());
      return !!(result && result.status && result.status.available);
    }, 10000, 'Windows attachment helper');
    const attachmentStatus = await win.evaluate(() => window.devphone.attachmentGet());
    assert(attachmentStatus.status.supported, 'Windows attachment support was not reported');

    const statusTime = await win.locator('#statusbar .js-clock').first().textContent();
    assert(/\b(?:AM|PM)$/.test(statusTime || ''), 'status-bar clock must include AM/PM: ' + statusTime);

    await win.evaluate(() => window.DP.toast('transient probe', 250));
    assert(await win.locator('#toasts .toast').count() === 1, 'toast was not created');
    await win.evaluate(() => window.devphone.shellMinimize());
    await sleep(450);
    assert(await win.locator('#toasts .toast').count() === 0, 'toast survived minimization');
    await electronApp.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) { w.restore(); w.show(); }
    });

    await win.evaluate(() => {
      document.getElementById('btn-device').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.querySelector('#device-popover .dev-kind[data-kind="phone"]').click();
      document.querySelector('#device-popover .dev-row[data-id="galaxy-s26-ultra"]').click();
    });
    await win.waitForFunction(() => DP.state.device && DP.state.device.id === 'galaxy-s26-ultra');
    assert(await win.locator('#homescreen .hs-search-input').count() === 1, 'Android home search input missing');
    const homeTime = await win.locator('#homescreen .hs-time').textContent();
    assert(/\b(?:AM|PM)$/.test(homeTime || ''), 'home clock must include AM/PM: ' + homeTime);
    if (shotDir) {
      fs.mkdirSync(shotDir, { recursive: true });
      await win.screenshot({ path: path.join(shotDir, 'v020-home-search.png') });
    }

    await win.evaluate(() => {
      const input = document.querySelector('#homescreen .hs-search-input');
      input.value = 'example.com';
      input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await win.waitForFunction(() => DP.state.app && DP.state.app.browser === 'chrome');
    const openedUrl = await win.evaluate(() => DP.state.url);
    assert(openedUrl === 'https://example.com', 'home search did not open the URL in Chrome: ' + openedUrl);

    const queryUrl = await win.evaluate(() => DP.chrome.resolveQuery('coffee near me'));
    assert(/^https:\/\/www\.google\.com\/search\?q=coffee%20near%20me$/.test(queryUrl), 'search query resolution failed');

    await sleep(300);
    const resume = await win.evaluate(() => JSON.parse(localStorage.getItem('devphone.resume') || 'null'));
    assert(resume && resume.app && resume.app.browser === 'chrome', 'per-profile browser resume state missing');
    if (shotDir) {
      await win.evaluate(() => {
        DP.goHome();
        document.getElementById('btn-settings').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      await win.screenshot({ path: path.join(shotDir, 'v020-settings.png') });
    }

    console.log('PASS attachment task matching');
    console.log('PASS attachment hide/return lifecycle');
    console.log('PASS Windows foreground/accessibility helper');
    console.log('PASS AM/PM status clock');
    console.log('PASS toast clears while minimized');
    console.log('PASS Android home search opens Chrome');
    console.log('PASS search terms resolve through Chrome search');
    console.log('PASS per-profile resume snapshot');
  } finally {
    await electronApp.close().catch(() => {});
  }

  const profileEnv = Object.assign({}, process.env, { APPDATA: parallelRoot });
  delete profileEnv.DEVPHONE_USERDATA;
  const [phoneA, phoneB] = await Promise.all([
    _electron.launch({ args: [ROOT, '--profile=alpha', '--profile-name=Alpha phone'], env: profileEnv }),
    _electron.launch({ args: [ROOT, '--profile=beta', '--profile-name=Beta phone'], env: profileEnv }),
  ]);
  try {
    const [winA, winB] = await Promise.all([phoneA.firstWindow(), phoneB.firstWindow()]);
    const [infoA, infoB] = await Promise.all([
      winA.evaluate(() => window.devphone.profileGet()),
      winB.evaluate(() => window.devphone.profileGet()),
    ]);
    assert(infoA.profile.id === 'alpha' && infoB.profile.id === 'beta', 'parallel profiles did not stay isolated');
    assert(infoA.profile.userData !== infoB.profile.userData, 'parallel profiles shared userData');
    console.log('PASS two isolated DevPhone profiles run together');

  } finally {
    await Promise.all([phoneA.close().catch(() => {}), phoneB.close().catch(() => {})]);
  }
}

main().then(() => {
  try {
    const tmp = path.resolve(os.tmpdir()).toLowerCase();
    const target = path.resolve(profileDir).toLowerCase();
    if (target.startsWith(tmp + path.sep) && path.basename(target).startsWith('devphone-features-')) {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
    const parallel = path.resolve(parallelRoot).toLowerCase();
    if (parallel.startsWith(tmp + path.sep) && path.basename(parallel).startsWith('devphone-profiles-')) {
      fs.rmSync(parallelRoot, { recursive: true, force: true });
    }
  } catch (e) {}
}).catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
