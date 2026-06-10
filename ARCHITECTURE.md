# DevPhone — Architecture Contract

Desktop phone simulator for mobile-web testing (Windows-first, Electron).
A frameless, transparent, draggable window IS the phone: realistic drawn
body, OS home screen, browser apps, PWA install flow, element picker,
screenshots, touch/pinch. Two engines: Chromium emulation (instant) and
true WebKit via Playwright (faithful Safari-family rendering).

**This file is the contract.** Both build agents code against it. Do not
change IPC names, file ownership, or the device schema — extend only.

## Stack & global rules

- Electron (v33+), plain JS/HTML/CSS everywhere. No frameworks, no bundler,
  no TypeScript. CommonJS in main process, plain scripts in renderer.
- The shell window: `frame:false, transparent:true, resizable:false`
  (resizing happens through explicit zoom controls that resize the window).
- Page content runs in a `<webview>` tag (`webviewTag:true`). The webview
  uses `nodeintegration=no`, partition `persist:devphone`, and
  `webpreferences="contextIsolation=no"` so its preload can patch page
  globals (acceptable: local dev tool).
- The renderer (shell UI) runs with `contextIsolation:true` + a preload
  exposing `window.devphone` (see IPC).
- Everything must work offline except actual page loads.

## File ownership

| Path | Owner |
|---|---|
| `package.json`, `README.md`, `devices/devices.json` | integrator (do not edit) |
| `src/main/main.js` (app boot, shell window, --selftest), `src/main/emulation.js`, `src/main/webkit.js`, `src/main/screenshot.js`, `src/main/updater.js`, `src/main/ipc.js`, `src/main/pwa.js` | ENGINE agent |
| `src/preload/shell-preload.js`, `src/preload/screen-preload.js`, `src/inject/picker.js`, `src/inject/ios-shims.js`, `electron-builder.yml` | ENGINE agent |
| `src/renderer/index.html`, `src/renderer/shell.css`, `src/renderer/frames.css`, `src/renderer/shell.js`, `src/renderer/homescreen.js`, `src/renderer/browser-chrome.js` | UI agent |

## Device schema (`devices/devices.json`)

```json
{
  "version": 1,
  "devices": [
    {
      "id": "iphone-16-pro-max",
      "label": "iPhone 16 Pro Max",
      "brand": "apple",
      "os": "ios",
      "osVersion": "26",
      "viewport": { "width": 440, "height": 956 },
      "dpr": 3,
      "physical": { "width": 1320, "height": 2868 },
      "diagonalInches": 6.9,
      "cutout": "dynamic-island",
      "cornerRadius": 55,
      "bodyStyle": "titanium-pro",
      "accentColor": "#3b3b3d",
      "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
      "uaModel": "",
      "browsers": ["safari", "chrome"],
      "estimated": false,
      "releaseYear": 2024
    }
  ]
}
```

- `cutout`: `dynamic-island` | `notch` | `punch-hole` | `none`
- `cornerRadius`: CSS px radius of the SCREEN corners at 1:1 scale.
- `bodyStyle`: `titanium-pro` | `aluminum` | `glass-android` | `budget-android`
- `uaModel`: Android build model for UA-CH (e.g. `SM-S938B`); empty on iOS.
- `browsers`: which browser apps appear on its home screen.
  iOS → `safari` (+`chrome` cosmetic; both render identically).
  Samsung → `chrome` + `samsung`. Other Android → `chrome`.

## Shell layout (renderer)

One window containing:
1. `#phone` — the drawn device body (frames.css; realistic: metal band,
   buttons, camera island, antenna lines; pure CSS/SVG, no images).
2. `#screen` — the screen area, exactly `viewport * scale` px, rounded by
   `cornerRadius * scale`, clipping its children:
   - `#statusbar` — OS status bar overlay (time, battery, signal;
     pointer-events:none; styled per OS; Dynamic Island / punch hole drawn
     here too).
   - `<webview id="page">` — fills the whole screen (edge-to-edge).
   - `#webkit-canvas` — canvas, hidden unless engine=webkit.
   - `#homescreen` — wallpaper (CSS gradient), app grid, dock; shown when
     no app is open.
   - `#browser-chrome` — Safari bottom bar / Chrome top bar / Samsung
     bars, overlaying the webview, per current browser app.
3. `#sidebar-controls` — a slim control rail floating beside the phone:
   device picker, engine toggle (Chromium/WebKit), scale (75/100/125%),
   picker 🎯, screenshot 📸 (screen / whole phone), rotate, home button,
   "check for new phones", and a close/minimize control.
   The rail is part of the same transparent window.
- Dragging: phone body edges get `-webkit-app-region: drag`; all
  interactive parts `no-drag`.
- Window size = phone size at scale + rail; main resizes via IPC
  `shell:resize {width,height}`.

## IPC contract (all via `window.devphone`, defined in shell-preload)

Renderer → main (invoke):
- `devices:list` → `{devices:[...]}` (main reads devices.json + appended
  auto-discovered entries from userData/devices-extra.json)
- `screen:attach {webContentsId}` → main attaches debugger to the webview
  and applies current device emulation. Renderer calls once webview is
  `dom-ready`.
- `device:set {deviceId}` → main re-applies emulation (metrics, UA, touch,
  safe areas). Returns the device object.
- `engine:set {mode}` — `chromium` | `webkit`. WebKit mode: main launches
  Playwright WebKit (context with device viewport/UA/touch), navigates to
  the current URL, starts frame streaming. Returns `{ok, mode}` (falls
  back to chromium with `{ok:false, error}` if Playwright missing).
- `nav {action,url?}` — for webkit mode navigation (chromium mode the
  renderer drives the webview directly). Actions: go/back/forward/reload.
- `standalone:set {on, themeColor?}` — toggles display-mode standalone
  emulation (CDP `Emulation.setEmulatedMedia` features) + iOS
  `navigator.standalone` shim flag for the NEXT loads.
- `picker:toggle {on}` → injects/toggles picker in the active engine.
- `shot {mode}` — `screen` (page only) | `device` (whole phone window).
  Saves PNG to `%USERPROFILE%/Pictures/DevPhone/devphone-<ts>.png`,
  copies image to clipboard too, returns `{path}`.
- `pwa:manifest {pageUrl}` → main fetches the page, finds
  `link[rel=manifest]`, fetches+parses it, returns
  `{ok, name, shortName, startUrl, display, themeColor, iconDataUrl}`.
- `updater:check` → runs the new-device check now, returns
  `{added:[device], checked:true}`.
- `webkit:input {type,x,y,dx?,dy?,key?,text?}` — forwarded gestures for
  webkit mode (tap, move, down, up, wheel, key, type). Coordinates in
  viewport CSS px.
- `shell:resize {width,height}`, `shell:minimize`, `shell:close`,
  `open:external {url}` (opens in system browser).

Main → renderer (on):
- `webkit:frame {dataUrl}` — latest WebKit frame (JPEG data URL).
- `picker:result {report}` — picker selection (already on clipboard).
- `devices:new {devices:[...]}` — auto-discovered phones (estimated).
- `page:meta {title,url,canGoBack,canGoForward,themeColor}` — webkit mode
  page state (chromium mode: renderer reads webview events itself).

## Emulation specifics (ENGINE agent)

On `screen:attach`/`device:set`, via `webContents.debugger` (CDP):
- `Emulation.setDeviceMetricsOverride` {width, height, deviceScaleFactor,
  mobile:true, screenWidth/Height} — width/height in CSS px of the device
  viewport (NOT scaled; visual scaling is done by sizing the webview
  element with CSS `transform: scale()` in the renderer — webview is laid
  out at full viewport CSS size, scaled down/up visually).
- `Emulation.setTouchEmulationEnabled {enabled:true, maxTouchPoints:5}` +
  `Emulation.setEmitTouchEventsForMouse {enabled:true, configuration:'mobile'}`.
- `Emulation.setUserAgentOverride` with `userAgentMetadata` for Android
  (brands incl. Chromium major, mobile:true, model:uaModel, platform:
  'Android'); for iOS pass UA only (try metadata:undefined; if CDP
  requires an object, send minimal and additionally strip UA-CH headers
  via `session.webRequest.onBeforeSendHeaders` for sec-ch-ua* when the
  active device is iOS).
- Safe areas: try `Emulation.setSafeAreaInsetsOverride` (top: 59 for
  dynamic-island devices, 47 notch, 24 android; bottom: 34 iOS / 24
  android gesture bar; 0 for none). Wrap in try/catch — older Chromium
  lacks it; on failure, no-op.
- `Emulation.setEmulatedMedia` features `display-mode: standalone` only
  when standalone:set on.
- Accept-Language/etc. left alone.

`src/inject/ios-shims.js` (string-injected by screen-preload when device
os==='ios'): defines `navigator.standalone` (false in browser, true when
standalone flag set — read from `window.__DEVPHONE__.standalone` injected
state), `navigator.platform='iPhone'`, `navigator.maxTouchPoints=5`,
`navigator.vendor='Apple Computer, Inc.'`. Keep defensive (try/catch
around each defineProperty).

`src/inject/picker.js`: self-contained IIFE, idempotent. When armed:
crosshair cursor, hover outline (2px #0A84FF + translucent fill overlay
box), tap/click selects (preventDefault+stopPropagation in capture phase),
builds report and `console.log('__DEVPHONE_PICK__'+JSON.stringify(report))`
(main listens via `console-message` event — robust across worlds), then
disarms. Report:

```
{ selector, tag, id, classes, text (≤120 chars), rect:{x,y,w,h},
  styles:{fontSize, fontFamily, color, background, margin, padding,
  display, position, zIndex}, htmlSnippet (outerHTML ≤300 chars),
  pageUrl, device }
```

Clipboard text format (main composes; human-readable for pasting to an
AI assistant):

```
[DevPhone pick · iPhone 16 Pro Max · 440×956@3x]
URL: https://…
Element: button#login-btn .btn.btn-primary
Text: "Sign In"
Box: x=24 y=712 w=392 h=52 (CSS px)
Styles: font 16px Inter · color #fff · bg #2563EB · padding 12px 24px · position static
HTML: <button id="login-btn" class="btn btn-primary">Sign In</button>
```

## WebKit mode (ENGINE agent)

- `playwright` is a dependency; engines installed to a project-local
  `PLAYWRIGHT_BROWSERS_PATH` (`./pw-browsers`, set in main before
  require) so packaged installs carry WebKit.
- On engine:set webkit: `webkit.launch()` → `newContext({ viewport,
  deviceScaleFactor, isMobile:true, hasTouch:true, userAgent })` → page.
- Frame streaming: capture `page.screenshot({type:'jpeg', quality:70})`
  in a loop (target ~8 fps; skip if previous capture in flight), send as
  data URL via `webkit:frame`. Pause streaming when no changes? v1: always
  loop while mode active; stop on mode switch/close.
- Input forwarding: tap → `page.touchscreen.tap(x,y)`; wheel/drag-scroll →
  `page.mouse.wheel(dx,dy)`; key/type via keyboard API.
- Picker in webkit mode: `page.evaluate` the same picker.js source; listen
  via page 'console' events for the `__DEVPHONE_PICK__` prefix.
- `page:meta` events on navigation (title/url/canGoBack via page.url() &
  history tracking — best effort).
- All Playwright failures must degrade gracefully to chromium mode with a
  visible toast (`{ok:false,error}` return; renderer shows it).

## Home screen & PWA flow (UI agent)

- iOS home: gradient wallpaper, 4-col app grid, dock with Safari (+Chrome
  cosmetic). Android/Samsung home: own wallpaper + Chrome (+Samsung
  Internet on Samsung devices). Icons drawn in CSS/SVG (no trademarked
  bitmaps; stylized look-alikes: Safari compass, Chrome circle, Samsung
  Internet planet).
- Tapping a browser opens it: browser chrome appears, webview shows start
  page (a small built-in start page with URL field + recent sites,
  document in renderer as data: URL or about:blank+overlay).
- Safari chrome: bottom URL pill + back/fwd/share/tabs; collapses to a
  thin strip when the page scrolls down (screen-preload reports scroll
  via console-message or webview ipc; simplest: inject scroll listener
  that posts `__DEVPHONE_SCROLL__{y}` console messages, throttled).
- Share menu → "Add to Home Screen": calls `pwa:manifest`, shows iOS-style
  sheet with icon+name, confirm → saved to localStorage
  (`devphone.apps.<deviceId>` keyed per OS), icon appears on home grid.
- Launching an installed app: `standalone:set {on:true}`, hide browser
  chrome entirely, navigate webview to startUrl; status bar stays. An
  iOS-style home-indicator swipe area (or the rail Home button) exits →
  `standalone:set {on:false}`.
- Long-press an installed icon → wiggle + ✕ to remove (nice-to-have; at
  minimum a context-menu Remove).

## Status bar (UI agent)

Live clock (HH:MM), battery (fake 87%), signal/wifi glyphs; black or white
text auto-chosen per current page theme-color luminance (renderer listens
to webview `did-change-theme-color` / `page:meta`). Drawn around the
cutout (time left of island on iOS, right side glyphs).

## Auto device-discovery (`updater.js`, ENGINE agent)

- On launch + every 24h (`setInterval`): fetch Wikipedia REST API pages
  `List_of_iPhone_models` and `Samsung_Galaxy_S_series` (en.wikipedia.org
  /api/rest_v1/page/html/<title>), extract model names via regex
  (`iPhone \d\d[^,<]*`, `Galaxy S\d\d[^,<]*`), normalize, diff against
  known ids (built-in + extras + a dismissed list in userData).
- For unknown models: create an entry cloning the nearest predecessor
  (e.g. "Galaxy S27 Ultra" clones s26-ultra) with `estimated:true`, parse
  resolution from the article HTML if a `\d{3,4}\s?[×x]\s?\d{3,4}` appears
  near the model name (best effort), save to userData/devices-extra.json,
  emit `devices:new`.
- Renderer shows a toast: "📱 Galaxy S27 Ultra detected — added with
  estimated specs" and a NEW badge in the device picker.
- All network failures silent (log only).

## Selftest (`--selftest`, ENGINE agent in main.js)

`electron . --selftest [url]`: boots shell with default device
(iphone-16-pro-max), loads url (default https://example.com) in the
webview via a `selftest` query param handed to the renderer, waits 5s,
captures the WHOLE window (`webContents.capturePage`) to
`./selftest.png`, prints `SELFTEST OK ./selftest.png` and exits 0 (any
exception → print + exit 1). Also dump `webview.getUserAgent?` not needed.
A second capture `./selftest-screen.png` of just the webview contents.

## Packaging (`electron-builder.yml`, ENGINE agent)

appId `com.devphone.app`, productName `DevPhone`, win targets `nsis` +
`portable`, includes `pw-browsers/**` via extraResources (and main sets
PLAYWRIGHT_BROWSERS_PATH to resourcesPath/pw-browsers when packaged),
icon optional (skip if none), output `dist/`.

## Visual quality bar (UI agent)

This must feel like a hardware product, not a wireframe: subtle metal
gradient band, separate volume/action/power buttons with highlights, soft
ambient shadow under the phone (CSS drop-shadow on the body, since window
is transparent), screen glass with a faint top-edge reflection, smooth
60fps open/close animations for apps (scale+fade from icon), wiggle mode,
believable iOS/One UI typography (system-ui stack). Colors per bodyStyle.

## v0.1.1 extensions (ENGINE)

New/extended IPC (renderer → main, invoke; all exposed on `window.devphone`):

- `shell:activate` (no payload) → `{ok:true}` — first-click fix. The
  renderer sends this on mousemove while the OS window is unfocused; main
  calls `win.focus()` if `!win.isFocused()` (no moveTop / alwaysOnTop), so
  the activating click is no longer eaten and "press twice" goes away.
  Preload convenience: `devphone.shellActivate()`.

- `input:set {mode}` → `{ok, mode}` — `mode: 'touch' | 'mouse'`.
  - `touch` (default, previous behavior):
    `Emulation.setTouchEmulationEnabled {enabled:true, maxTouchPoints:5}` +
    `Emulation.setEmitTouchEventsForMouse {enabled:true, configuration:'mobile'}`.
  - `mouse`: both disabled → normal desktop mouse (text selection,
    drag-to-highlight, native cursor). UA/metrics/safe-areas unchanged —
    the page still believes it is a phone.
  The mode lives in main central state and is re-applied on every emulation
  pass (dom-ready re-apply, `device:set`) — it no longer silently resets to
  touch on navigation. WebKit engine: mode is fixed at context creation, the
  call is accepted but declined: `{ok:false, error:'webkit mode: input mode
  fixed'}`. Note: on iOS devices `navigator.maxTouchPoints` stays 5 in mouse
  mode (ios-shims pins it — identity, not input pipeline).
  Preload convenience: `devphone.inputSet(mode)`.

- `device:set {deviceId, viewport?}` — extended. Optional
  `viewport:{width,height}` = the CONTENT viewport in CSS px: the renderer
  now lays the page out BETWEEN the phone's bars (status bar, browser
  chrome, Android nav bar) and passes the visible area here. When present it
  is used for `Emulation.setDeviceMetricsOverride` width/height; DPR, UA,
  touch, safe-areas still come from the device, and screenWidth/Height stay
  the device's FULL viewport (so `screen.width/height` report the real
  phone). The override is stored in main state — dom-ready re-applies honor
  it — and is CLEARED by any `device:set` without a viewport. Backward
  compatible: old calls behave exactly as before. WebKit mode: the override
  is also used for the Playwright context viewport.
  Preload convenience: `devphone.deviceSet(deviceId, viewport?)`.

Picker (`src/inject/picker.js`) — rewritten as a Chrome-DevTools-style
inspector. Contract unchanged: `window.__DEVPHONE_PICKER__(on)` arm/disarm
global, `__DEVPHONE_PICK__` console bridge, report fields identical,
idempotent IIFE, engine-agnostic (same source evaluated in WebKit mode).
New behavior while armed: normal ARROW cursor (`cursor:default !important`),
hover overlay (pointer-events:none, max z-index) with the element box filled
`rgba(111,168,220,.35)` + 1px `#1a73e8` outline, margin ring tinted
`rgba(246,178,107,.25)`, and a dark rounded tooltip pill
`` `tag#id.class` `` (mono) + `· W×H` that auto-flips below the element near
the top edge. Tracking is rAF-throttled `elementFromPoint` with the overlay
hidden during the probe. Click selects (capture phase, preventDefault +
stopPropagation), emits the report, then disarms and removes overlay +
cursor style. Escape disarms.
