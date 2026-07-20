# DevPhone — Architecture Contract

Desktop phone and tablet simulator for mobile-web testing (Windows-first, Electron).
A frameless, transparent, draggable window IS the device: realistic drawn
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
      "formFactor": "phone",
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
- `formFactor`: `phone` (also the backward-compatible default when omitted) |
  `tablet`. The picker uses this field to keep the two catalogs separate.
- `cornerRadius`: CSS px radius of the SCREEN corners at 1:1 scale.
- `bodyStyle`: `titanium-pro` | `aluminum` | `glass-android` | `budget-android` |
  `tablet-apple` | `tablet-android`
- `statusBarHeight`, `safeArea`, and `gestureNavigation` are optional tablet
  overrides used by the shell and emulation layer.
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
- `device:set {deviceId, viewport?, orientation?}` → main re-applies emulation
  (metrics, UA, touch, safe areas). `orientation` is `portrait` or `landscape`;
  landscape is accepted for tablets and swaps the full screen dimensions.
  Returns the oriented device object.
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
  lacks it; on failure, no-op. (Android values superseded: the v0.1.2
  safe-area table + VERDICT below are the source of truth — android is
  0/0 because the renderer lays content out between the bars.)
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
output `dist/`. The single portable `DevPhone <ver>.exe` is the
share-with-anyone artifact — self-contained (WebKit inside), no install.

**Icon:** `build/icon.svg` is the vector master; `npm run icon`
(`scripts/make-icon.js`) renders it via the project's own Electron to
`build/icon.ico` (16→256px multi-res), `build/icon.png` (512) and
`src/assets/icon.png` (256, shipped in the asar for the runtime
BrowserWindow icon). `win.icon` + the nsis `*Icon` fields point at the
`.ico`. main sets `app.setAppUserModelId('com.devphone.app')` so the
Windows taskbar groups under the app identity and shows the icon.

**Signing:** we have no certificate, so `win.signExecutable: false` — this
skips ONLY the codesign step while electron-builder still embeds the icon +
version metadata through its pure-JS `resedit` path (no winCodeSign download,
so no symlink-privilege / Developer-Mode requirement). Do NOT revert to
`signAndEditExecutable: false`: that also drops the icon. Unsigned exes trip
SmartScreen on first run (More info → Run anyway) — expected without a cert.

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

- `device:set {deviceId, viewport?, orientation?}` — extended. Optional
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
  `orientation:'landscape'` swaps a tablet's full viewport and adds CDP
  `screenOrientation:{type:'landscapePrimary',angle:90}`; phones stay portrait.
  Preload convenience: `devphone.deviceSet(deviceId, viewport?, orientation?)`.

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

## v0.1.2 extensions (ENGINE)

### WebKit adaptive frame streaming

`webkit:frame` payload extended (backward compatible — old `{dataUrl}`
consumers keep working): `{dataUrl, w?, h?, sharp?}`. `w`/`h` are the CSS-px
viewport size the frame represents; the IMAGE may be larger (full-DPR) —
the renderer must scale whatever it gets to the canvas, keyed on the
image's natural size, never assume frame px == canvas px.

Streaming behavior (replaces the fixed ~8fps interval loop):
- Self-scheduling capture loop: next capture starts when the previous
  completes + ~25ms breather. css-scale JPEG quality 75.
- Frames identical to the previous capture (base64 equality) are NOT sent —
  a static page goes quiet instead of re-sending ~8 identical frames/s.
- SHARPNESS: after ~600ms with no forwarded input, no navigation and no
  content change, ONE full-DPR frame (`scale:'device'`, JPEG q90) is sent
  with `sharp:true` (e.g. 1320×2868 for iPhone 16 Pro Max while `w:440
  h:956`). Any input / navigation / content change resumes the fast css
  loop and re-arms the next sharp frame. Page animations never flicker
  between sharp and css frames: content changes count as activity.
- Frames are only emitted while the shell window is visible and not
  minimized; the loop exits cleanly on engine switch (generation counter).

### Safe-area insets — single source of truth + VERDICT

`emulation.applySafeArea(wc, device, standalone)` owns ALL inset logic and
is called on screen:attach, device:set re-applies, and standalone:set
(standalone keeps the same insets). Values (CSS px):

| device | top | bottom |
|---|---|---|
| iOS dynamic-island | 59 | 34 |
| iOS notch | 47 | 34 |
| iOS classic button (`cutout:none`) | 20 | 0 |
| android (any) | 0 | 0 — status/gesture bars handled by renderer layout |

**Measured verdict (scratch/test-safearea.js + scratch/test-safearea-devices.js,
Electron 36.9.5 / Chromium 136.0.7103.177 — supersedes the Electron 33 /
Chromium 130 verdict that recorded the command as missing):**
`Emulation.setSafeAreaInsetsOverride` EXISTS and WORKS. The nested shape
`{insets:{top,topMax,left,leftMax,bottom,bottomMax,right,rightMax}}` (all
integers; *Max equal to base) is accepted; the flat `{top,...}` shape is
rejected with "Invalid parameters" — `applySafeArea` tries nested first, so
it applies on the first send. Measured through the real
`emulation.applySafeArea` against a `viewport-fit=cover` page:
`env(safe-area-inset-top/bottom)` report exactly the table above —
59/34 (dynamic-island), 47/34 (notch), 20/0 (iOS classic), 0/0 (android,
both punch-hole and notch cutouts — renderer layout owns Android bars, and
real Android Chrome reports 0 in browser mode; the "top 24 android" figure
in the original emulation spec above is superseded by this table). The
override persists across reloads and subsequent
`setDeviceMetricsOverride` calls, and standalone mode keeps the same
insets. `applySafeArea` is therefore LIVE on the current stack; the
warn-once no-op path remains only as the <136 fallback. Selftests green on
Electron 36.9.5: default (440×831 content viewport), `--st-engine=webkit`,
`--st-device=galaxy-s25-ultra` (412×804) — flags take `=value` form.

**WebKit engine (measured, Playwright 1.x webkit-2287, same probe page):**
NO inset emulation exists or is possible — `env(safe-area-inset-*)` is
supported syntax but always resolves `0px` in Playwright WebKit (desktop
port, no notch geometry), and Playwright exposes no API to override it
(nothing in context options, no protocol command). webkit.js intentionally
has no inset code; the renderer's content-viewport layout is the only
safe-area protection in WebKit mode. Validate `env()`-dependent fixes
(e.g. a real site's `env()`-positioned overlay buttons) on the Chromium engine.

### Parallel-safe test plumbing

`DEVPHONE_USERDATA` env var: when set, main.js calls
`app.setPath('userData', …)` before app ready — each Playwright-Electron
test instance gets its own profile (and thus its own single-instance lock).
Takes precedence over the `--selftest` tmp-profile isolation.

### Selftest fix (webkit engine)

With `--st-engine=webkit` the renderer hides the `<webview>`, and
`capturePage()` on a hidden webContents never resolves — the selftest used
to hang until the watchdog. `selftest-screen.png` now comes from
`webkit.captureFull()` (device-scale PNG) when engineMode is webkit; the
chromium path is bounded by a 10s race. Step timings are logged as
`SELFTEST TIMING …`.

## v0.1.3 extensions (UI, + one sanctioned IPC)

### New IPC: `shell:alwaysOnTop {on}` → `{ok, on}`

`win.setAlwaysOnTop(!!on)` (ipc.js) + preload allowlist entry
(`devphone.shellAlwaysOnTop(on)`). The renderer persists the flag in
localStorage (`devphone.alwaysontop`) and re-applies it at boot. Reachable
from the ⚙ Settings popover ("Window · 📌 Always on top") and a custom
right-click context menu (#ctx-menu) on the phone bezel / shadow margin
(also offers Minimize/Close).

### Shadow margin

`PAD` (shell.js) is now a 48px transparent SHADOW MARGIN, scaled with the
phone scale and pushed to CSS as `--stage-pad`; window size =
phone·scale + 2·pad + gap + rail. The phone drop-shadow (frames.css) is
sized to fade fully inside it (≈ offset + 1.5×blur ≤ 41px) — no hard clip
at the window edge. Drag regions: `#stage` (the margin) and the rail are
the drag areas; `#phone` is now NO-drag — drag regions are HTCAPTION on
Windows, which would swallow bezel right-clicks (system menu, no DOM
events).

### Context-menu under touch emulation (probe-verified)

While the guest's touch emulation is active it hooks the whole window:
right-button down/up never reach the shell DOM; Chromium synthesizes a
keyboard-style `contextmenu` with `button === -1` at the FOCUSED element
with bogus coordinates (scratch/probe-ctx2.js). The renderer treats any
`button === -1` contextmenu as a bezel right-click (a touch-mode phone
page has no right-click concept) and anchors the menu to the phone's top
bezel; real mouse-mode right-clicks are scoped to bezel/margin only.

### Cursor + input-mode scoping

The touch experience exists ONLY over the page content area: a fingertip
cursor on `#touch-layer` / `#webkit-canvas` via `body.input-touch`
(toggled by setInputMode). Everything else — rail, shadow margin, chrome
bars, popovers, home screen — keeps normal desktop cursors.

### Shell text inputs: desktop-native in BOTH input modes

The old first-click-select-all mouseup suppressor + caret-on-click
collapsed drag selections (the v0.1.2 known bug). Replaced by a pointer-
events controller that fully owns shell-input interaction (native mouse
defaults on those inputs are preventDefault-ed): first click → select
all; stationary second click → caret (canvas text measurement); press
moved >3px → live arbitrary drag selection (never overridden);
double-click → word; triple-click → select all. Inputs get
`touch-action:none` so pointermove streams under touch emulation.

## v0.1.4 extensions (ENGINE + renderer input pipeline)

### Native scroll physics — `guest:gesture` IPC

The v0.1.2 synthetic in-guest `window.scrollBy` made scrolling work but feel
dead: stepwise, no momentum, no fling. Replaced by NATIVE input replay on the
guest's CDP debugger.

New IPC `guest:gesture {samples:[...]}` → `{ok, dispatched}` (preload:
`devphone.guestGesture(samples)`). Sample shapes (guest CSS px, `t` =
`Date.now()` ms):
- `{phase:'start'|'move', x, y, t}` → `Input.dispatchTouchEvent`
  touchStart/touchMove (`timestamp` = t/1000 — Chromium derives the FLING
  velocity from these, so they are real per-move times)
- `{phase:'end'|'cancel', x, y, t}` → touchEnd/touchCancel (empty touchPoints)
- `{phase:'wheel', x, y, dx, dy, t}` → `Input.dispatchMouseEvent` mouseWheel

`emulation.dispatchGesture(wc, samples)` serializes all batches through a
promise chain (start/move/end order survives concurrent IPC). WebKit engine
returns `{ok:false}` — its `webkit:input` path is unchanged.

Renderer (#touch-layer): touch-mode drags batch pointermove samples per rAF
(taps still take the synthetic-click path; the 8px/700ms discrimination is
unchanged); the gesture end flushes IMMEDIATELY so release timing isn't a
frame stale. Wheel (BOTH input modes) coalesces one mouseWheel sample per
frame. The old synthetic scrollBy stays as automatic FALLBACK: the first
`{ok:false}` flips a latch, the failed batch's distance is recovered
synthetically, and every later drag/wheel uses the old path.

**Wheel sign (measured, probe-cdpscroll*.js):** Electron 36 passes
`Input.dispatchMouseEvent` mouseWheel deltas to the page UNCHANGED, DOM-
signed — positive deltaY scrolls content down. Senders use DOM-signed deltas.

**Fling (measured):** flick 180px → release → scrollY keeps growing ~500ms
(e.g. 139→575 across post-release samples), decaying naturally. A slow drag
with a hold tracks ~1:1 (200px drag → 185px scroll; ~15px native touch slop).

### `setEmitTouchEventsForMouse` is now ALWAYS OFF (capture-trap root fix)

With it enabled, the guest installs a window-wide mouse hook as soon as it
processes ANY real input — which now includes every dispatched touch gesture,
so each drag re-armed the v0.1.2 "press twice" trap (measured: the next shell
click was routed into the guest; the shell DOM saw nothing; `wv.blur()` did
NOT release it). Nothing needs mouse→touch conversion anymore: drags arrive
as real touch via CDP, taps are synthetic, and forwarded hover mouseMoves —
formerly swallowed by the emulator — now arrive as real mousemoves (:hover
works). `setTouchEmulationEnabled` (maxTouchPoints/ontouchstart identity)
still follows the input mode. Bonus: in touch mode, real right-clicks now
reach the shell DOM normally (`button===2`), the synthesized `button===-1`
contextmenu path remains as harmless fallback.

### Renderer robustness fixes

- Stale-press healing: if a layer pointerdown arrives while a press is still
  open (dropped pointerup — this transparent frameless window sporadically
  loses events), the old gesture is closed out (touchCancel / mouseUp) instead
  of swallowing the new one whole.
- Post-gesture `guestBlurUnlessEditing` after each native drag end (belt &
  braces; the compositor fling survives the blur — suite-verified).
- browser-chrome `.menu-catcher` release: only hides the catcher when no
  menu is open — the opening click's own pointerup used to drop the shield,
  leaving an open menu that a page click could no longer close (previously
  masked by the stale-press leak).

### Suite updates (merge gates)

`scratch/test-gestures-v012.js` → 12 checks: + wheel in MOUSE input mode,
slow-drag distance tracking, flick→fling (3+ growing post-release samples,
total > dragged distance). Drags are now driven as PointerEvents dispatched
on the #touch-layer (deterministic; window-level CDP touch streams get taken
over by the compositor → pointercancel + native guest fling outside the
pipeline under test). `scratch/test-ui-v012.js` unchanged: 27 scenarios.
Both suites green twice consecutively; selftest
`--st-device=galaxy-s26-ultra` still reports 412×804.

### Guest WebAuthn shim (tap-beacon injection)

Chromium exposes `PublicKeyCredential`, so passkey-first sites (e.g. a
bank or portal) hide their PIN UI — but `navigator.credentials.get()`
can never complete inside the webview, hanging "Sign In" forever. The
per-load guest injection now wraps `credentials.get/create`: publicKey
requests reject after ~400ms with `NotAllowedError` (= user cancelled
Face ID), so pages fall into their own PIN/password fallback.
non-publicKey requests pass through.

### syntheticTap fidelity

The dispatched sequence now carries `buttons:1` on the down phase /
`buttons:0` up, `detail:1`, `composed:true` and pressure, in the order
pointerdown → mousedown → focus → pointerup → mouseup → click. Suite
scenario S13 replicates the portal pattern locally (click-bound card +
capture-phase document listener); S9–S12 cover selection, shadow margin,
always-on-top and cursor scoping. test-ui-v012: 27 scenarios.

## v0.1.5 extensions (renderer input pipeline + emulation)

### sendInputEvent offset compensation REMOVED (measured, probe-mousemode.js)

Electron 36 delivers `webContents.sendInputEvent` coordinates to the guest
UNCHANGED (sent == arrival; guest CSS px). The E33-era "arrival = sent +
webview rect offset" pre-compensation (`fwdXY`) therefore shifted EVERY
forwarded event ~65px up-left: mouse-mode clicks landed on the wrong element
(or nothing), and the hover mouseMoves forwarded in BOTH input modes lit up
the wrong control's `:hover` — on a real card-based portal the highlight sat on a
neighboring card/button while the synthetic tap hit the aimed one, reading as
"taps click the wrong location". `fwdXY` is gone; all forwarding uses
`localXY` (plain guest-local CSS px, descaled by the visual transform).
Verified on the live portal (probe-v015-verify.js): hover tracks the aimed
card, mouse-mode click selects it.

### Wheel scrolling is EASED (was: one raw tick = one visible jump)

A CDP `Input.dispatchMouseEvent mouseWheel` applies its whole delta
instantly — Chromium's smooth wheel-scroll animation never runs for injected
events — so forwarding ~100px hardware ticks 1:1 produced stepwise jumps.
The renderer now drains accumulated wheel deltas through a per-frame
exponential ease-out (~28%/frame, ≥16px/frame, first step ships in the wheel
handler itself — no added latency), one small mouseWheel sample per frame.
Distance is preserved exactly; new ticks fold into a running drain; the
`gestureBroken` fallback recovers any undrained remainder synthetically.
Measured: a single 240px tick lands as ~8 growing frames (67→115→…→240).

### dispatchGesture is PIPELINED (was: one ack round-trip per sample)

Every CDP input ack waits for the guest main thread to process the event;
awaiting each `Input.dispatchTouchEvent` sequentially throttled drag-move
delivery to one guest-frame per sample — drags stuttered on any page doing
work. All sends in a batch are now issued synchronously (the debugger
session serializes them, so touchStart/move/end order still holds) and the
batch resolves on the last ack. The cross-batch promise chain stays.

Suite gates unchanged: test-gestures-v012 12/12, test-ui-v012 27/27, both
green twice consecutively after the change.

### Local self-update (no update server — builds are local)

Symptom this kills: the user reinstalls from `dist/` but the installer there
predates the latest source fixes, silently shipping old code (it happened:
the 14:09 installer vs the 14:28 fixes).

- `scripts/stamp-build.js` (electron-builder `beforePack`): writes
  `build-info.json` at the project root — `{buildTime, builtAt, projectDir}`
  — included in the asar via `files`, so every build knows when it was built
  and where the project lives.
- `scripts/local-publish.js` (`afterAllArtifactBuild`): writes
  `dist/latest-build.json` — `{buildTime, builtAt, setup, portable}` (abs
  artifact paths) — the local stand-in for an update feed.
- `src/main/selfupdate.js`: ~1.5s after the shell window is up, a PACKAGED
  NSIS install compares its stamp against the manifest in
  `<projectDir>/dist/`. Strictly-newer build present → native dialog
  ("Install now" / "Later"); install = spawn the setup exe DETACHED with
  `/S --force-run` (electron-updater's recipe: silent NSIS install closes
  the running app, installs, relaunches) and quit.
- Silent no-ops by design: dev runs, portable exes
  (`PORTABLE_EXECUTABLE_FILE`), selftest, pre-v0.1.5 installs (no stamp),
  moved/missing project dir, malformed manifests. The check can never break
  boot. No IPC, no renderer involvement, fully offline.

Workflow: edit source → `npm run dist` → the already-installed app offers
the update on its next launch.

### New IPC: `shell:drag {phase:'start'|'move'|'end', x?, y?}` → `{ok}`

Bezel window drag. The phone FRAME can't be a CSS app-region (drag regions
are HTCAPTION on Windows and swallow bezel right-clicks — the v0.1.3
context-menu lesson), so dragging is manual: the renderer pointer-captures
`#phone` presses that did NOT start on `#screen` / `#hw-home-button` and
pings start/move/end per animation frame (NO coordinates).

COORDINATES ARE MAIN'S JOB: `screen.getCursorScreenPoint()` — OS ground
truth in integer DIPs, the same space as window bounds. The first version
streamed the renderer's `e.screenX/Y` instead; those are computed against a
window origin that lags our own moves during the drag, and the feedback
accumulated into a slow DOWNWARD drift — the phone visibly slid out from
under the grab cursor on long back-and-forth drags (user-reported, v0.1.5).
Anchor + ground truth cannot drift: cursor back at the press point ⇒ window
back at the press bounds, exactly. Each move is ONE
`setBounds({x,y,width,height})` with the ANCHORED size and NO style
toggles. Measured verdicts behind that exact shape (probe-setbounds.js,
Electron 36 / Windows 11 / 150% display scale):
- `setPosition` GROWS a resizable:false window ~1px per call
  (DIP→physical→DIP re-rounding) — accumulated during the move stream and
  made the phone snap at drag release when a one-shot restore corrected it;
- `setResizable(true)…(false)` toggles (per-move OR once at release) make
  Windows 11 blink its standard window border around the mostly transparent
  window rectangle;
- `setBounds` WITH a size applies cleanly on resizable:false — the
  long-standing "size writes are blocked on resizable:false" assumption is
  FALSE on this stack — and holds bounds exactly: zero drift, zero
  restyling. `shell:resize` uses the same toggle-free setBounds now.
No-op moves are skipped. Explicit `{x,y}` on start/move is still honored so
the suite can drive the handler deterministically without moving the real
cursor.

Preload: `devphone.shellDrag(phase, x?, y?)`. Cursor affordance: `grab` on
the frame, `grabbing` while dragging; the `#screen` subtree resets to its
own cursors. Suite: scratch/test-bezeldrag.js (6 checks — exact delta move,
ZERO drift across 50 wiggle cycles incl. size, pointer arm/disarm, no drag
from screen presses, bezel right-click menu, cursor scoping); UI 27/27 +
gestures 12/12 + clickthrough 7/7 unchanged.

### WebKit engine: persistent logins (storageState round-trip)

Chromium mode keeps sessions via the `persist:devphone` partition, but the
WebKit engine created a pristine `newContext()` on every start — engine
switch, device switch, or app relaunch logged the user out of everything
(symptom: re-entering a portal PIN on every single visit). Cookies +
localStorage now persist through Playwright's `storageState`:
`userData/webkit-storage.json` is loaded into `newContext()` when present
(corrupt/incompatible file → deleted, clean start; never blocks engine
start), saved on every `closeContext()` (covers stop/switch/quit) and
debounced ~2s after each `domcontentloaded`. HttpOnly cookies are included
— Playwright captures them below the page layer. Probe:
`scratch/probe-wkstate.js` (6 checks: save on stop, cookie + localStorage
in the file, fresh-context restore resends the cookie to the server).

### New IPC: `webkit:window {url?}` → `{ok, reused?}` — standalone WebKit preview

⚙ Settings → "Preview · 🧭 Open in WebKit window" opens the CURRENT page in
a real, headed Playwright-WebKit window: native interaction speed (no frame
streaming, no bezel) for quickly clicking through a page in true WebKit.
`webkit.openWindow({device,url})` launches a SEPARATE headed browser
process (the streaming engine stays headless), with the device's full
viewport/dpr/UA + the same init shims, and the SAME
`userData/webkit-storage.json` storage state — logins carry over both ways
(saved on each `domcontentloaded` and on window close). A second call while
the window is open navigates + refocuses it (`{reused:true}`) instead of
spawning another. The renderer passes its own `state.url` (main's
`currentUrl` can lag in chromium mode) and rejects `about:blank`/`data:`
with a toast. Closed by the user like any window; `shutdown()` also reaps
it. Preload: `devphone.webkitWindow(url)`. Probe:
`scratch/probe-wkwindow.js` (5 checks: open, navigation hit, persisted
cookie arrives in the headed window, reuse path).

### New IPC: `shell:ignoreMouse {on}` → `{ok, on}` — invisible regions are CLICK-THROUGH

The OS window is a big transparent rectangle (phone + 48px shadow margin +
gap + rail + MIN_WIN_H slack above/below); those invisible areas swallowed
clicks meant for the window BEHIND DevPhone. The renderer (wireClickThrough)
now drives `win.setIgnoreMouseEvents(on, {forward:true})` from cursor
position: over nothing visible → ignored (clicks/focus fall through to the
app behind), over `#phone-wrap` / the rail / popovers / ctx menu →
interactive. `forward:true` keeps mousemoves flowing while ignored so the
shell re-arms itself at the phone edge. Rules: any open popover/ctx-menu
(click-catcher modality) keeps the WHOLE window interactive so the outside
click can close it; no state flips mid-press (`e.buttons`); the v0.1.1
focus-follows-mouse `shell:activate` is suppressed while click-through (it
used to steal focus when the cursor merely crossed the margin). The `#stage`
app-region drag is GONE — window dragging is bezel (shell:drag) + rail.
`state.mouseIgnored` in main + `win.__mouseIgnored` are the observable test
hooks. Preload: `devphone.shellIgnoreMouse(on)`.
Suite: scratch/test-clickthrough.js (7 checks); UI 27/27, gestures 12/12,
bezeldrag 5/5 unchanged.

## v0.1.6 extensions (cloud auto-update + app icon)

### Cloud auto-update (electron-updater + GitHub, custom in-app UX)

Supersedes the v0.1.5 local `dist/` self-update (`selfupdate.js` retained but no
longer wired). Installed NSIS builds check a GitHub releases feed on launch and
drive a phone-styled in-app flow instead of electron-updater's default dialogs.

- Feed: `publish` in electron-builder.yml → github, owner `flodisterhoft-ops`,
  repo `devphone-releases` — a PUBLIC releases-only repo (installers +
  latest.yml, no source), so clients update with NO token embedded.
  `releaseType: release` publishes immediately. electron-builder bakes
  `app-update.yml` into the package from this config.
- `src/main/cloudupdate.js` — owns `electron-updater`'s autoUpdater with
  `autoDownload=false` (show the changelog first) + `autoInstallOnAppQuit=true`
  (safety net). Every updater event is funneled to the renderer as one
  `appupdate:event {type,...}` (`type`: checking | available | progress |
  downloaded | none | error). Logs the whole lifecycle to
  `userData/update.log`. No-ops in an unpackaged dev run (no app-update.yml)
  unless `DEVPHONE_FORCE_UPDATE`. Test hook `DEVPHONE_UPDATE_TESTVER=<low ver>`
  overrides `autoUpdater.currentVersion` so a check finds the current release.
  main.js calls `cloudupdate.init({send})` + a check ~3s after launch (packaged,
  non-selftest).

New IPC (renderer → main invoke; preload allowlist + conveniences):
`appupdate:check` → `check()`; `appupdate:download` → `downloadUpdate()`;
`appupdate:install` → `quitAndInstall(false,true)` (silent per-user NSIS +
relaunch). Event channel `appupdate:event`. Preload: `devphone.appUpdateCheck /
appUpdateDownload / appUpdateInstall / onAppUpdate(cb)`.

`src/renderer/update.js` (+ `.dpu-*` in shell.css; loaded last in index.html) —
self-contained overlay: "What's new" card + changelog, download progress bar,
then a brief installation/confetti state which calls `appupdate:install`
automatically. Update now is the only required click; the app installs, quits,
and relaunches itself. It is a full-window
modal, so `wireClickThrough`'s `overVisible()` returns true whenever
`#dpu-overlay` is shown (keeps the window interactive for its buttons). Demo:
Ctrl+Shift+U, or `window.dpuDemo('available'|'progress'|'done')` (used by
`scripts/shot-update.js` to screenshot the flow without a release).

**Settings → About:** the app version comes from the sync `app:version`
channel (ipc.js → `app.getVersion()`, exposed as `devphone.version`), shown in
the ⚙ Settings popover next to a "Check for updates" row that calls
`window.dpUpdate.check()` — a manual check with toast feedback (up to date /
couldn't check); an available update opens the popup as usual.
`scripts/shots.js` renders the README product screenshots from the real shell.

### Changelog + release workflow

`scripts/gen-notes.js` → `build/release-notes.md` from git commit subjects since
the last tag (or `RELEASE_NOTES.md` verbatim if present); electron-builder
embeds it into latest.yml (→ electron-updater `releaseNotes`, rendered as the
changelog) and the GitHub release body. `scripts/release.js` (`npm run release`)
pulls the GitHub token from the `gh` CLI, regenerates notes, gates on WebKit,
then `electron-builder --win nsis --publish always`. Workflow: bump
`package.json` version → `npm run release` → installed copies offer the update
on their next launch. `npm run dist` stays local-only (nsis + portable, no
publish); the auto-updatable artifact is the NSIS installer.

### App icon

`build/icon.svg` → `npm run icon` (`scripts/make-icon.js`, renders via the
project's Electron) → `build/icon.ico` (16–256px) + `src/assets/icon.png` (256,
shipped for the runtime BrowserWindow icon). `win.signExecutable: false` keeps
icon+metadata embedding (pure-JS resedit) while skipping only codesign — see the
Packaging section. `app.setAppUserModelId('com.devphone.app')` sets the taskbar
identity.

## v0.1.8 extensions (tablets, rotation, one-click update completion)

- `formFactor:'tablet'` presets live behind a separate Device → Tablet category:
  multiple iPad generations plus Galaxy Tab S11 and S11 Ultra.
- Renderer orientation is stored per tablet in
  `devphone.orientation.<deviceId>`. Rotation swaps the device viewport, frame,
  window bounds, home-grid layout, and content viewport, then reapplies the
  active engine without returning home.
- Main clones the immutable catalog preset into an oriented device. Chromium
  receives full rotated `screenWidth/screenHeight` plus `screenOrientation`;
  WebKit recreates its context with the rotated content viewport.
- Once an accepted update finishes downloading, the renderer immediately calls
  `quitAndInstall(false,true)` after a short visible confirmation. The existing
  `autoInstallOnAppQuit` remains the safety net.
