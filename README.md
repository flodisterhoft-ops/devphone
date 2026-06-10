# 📱 DevPhone

A phone that lives on your desktop. DevPhone wraps real mobile-web emulation
in a realistic, draggable phone body so you can test mobile-first sites the
way your clients actually see them — home screen, browser chrome, PWA
install flow and all.

Built because there is no legal, free iOS Safari for Windows — and Chrome
DevTools' device mode doesn't tell you what a site *feels* like on a phone.

## What it does

- **Realistic devices** — iPhone 14 → 17 lineups (incl. iPhone Air), iPhone
  SE, Galaxy S24 → S26 lineups, budget Android, Pixel 9. Exact logical
  viewports, devicePixelRatio, user agents (researched & verified per
  device). The window IS the phone: drag it anywhere, scale 75/100/125%.
- **Two engines**
  - *Chromium* (instant): full emulation — viewport, DPR, touch, UA +
    client hints, iOS shims (`navigator.standalone`, platform, touch
    points), safe-area insets, `display-mode: standalone`.
  - *WebKit* (true engine): real WebKit via Playwright streamed into the
    same phone frame — catches the "Chrome renders it fine but Safari
    doesn't" class of bugs. Not identical to iOS Safari (no iOS-only UI
    behaviors), but the closest thing that runs on Windows.
- **Home screen & PWA flow** — Safari / Chrome / Samsung Internet apps,
  Add-to-Home-Screen reads the site's real manifest, installed apps launch
  standalone (chrome-less) exactly like on a phone. Long-press to wiggle
  & remove.
- **Browser chrome** — Safari's bottom pill (collapses on scroll), Chrome's
  omnibox, Samsung Internet's dual bars — because half of mobile bugs hide
  behind toolbars.
- **🎯 Element picker** — tap any element on the page; a tidy report
  (selector, text, box, key styles, HTML snippet) lands on your clipboard,
  ready to paste to an AI assistant: "move this 4px left".
- **📸 Screenshots** — page-only or the whole phone (pretty frame included),
  saved to `Pictures/DevPhone` + clipboard.
- **Touch & pinch** — mouse acts as a finger; real touchscreen input passes
  through on touch laptops.
- **New-phone watcher** — checks Wikipedia daily for new iPhone / Galaxy S
  models and adds them with estimated specs (flagged until verified).

## Run it

```bash
npm install
npm run webkit:install   # one-time: downloads the WebKit engine (~90 MB)
npm start
```

## Build the installer

```bash
npm run dist             # dist/DevPhone-Setup-*.exe + portable .exe
```

## Selftest (CI-friendly smoke test)

```bash
npx electron . --selftest https://example.com --st-device=galaxy-s26-ultra
# writes selftest.png (window), selftest-screen.png (page), selftest.json (evidence)
# flags use --flag=value form; --st-engine=webkit tests the WebKit pipeline
```

## Honest limitations

- Chromium mode is an emulation: it nails sizes/UA/touch/PWA flow but
  renders with Blink. WebKit mode renders with real WebKit but is not
  iOS Safari (no iOS input auto-zoom, toolbar physics, Apple Pay, etc.).
  Final word for iOS-only quirks still belongs to a real iPhone.
- Samsung Internet is emulated as Chromium + Samsung UA + its chrome
  (faithful in practice — the real browser is Chromium-based).

## Device catalog

`devices/devices.json` (seed) + `devices/devices-researched.json`
(verified catalog, overrides seed) + `%APPDATA%/devphone/devices-extra.json`
(auto-discovered). Add your own device by copying any entry.
