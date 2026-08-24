'use strict';

/*
 * attachment.js — bind one DevPhone profile to another Windows window/task.
 *
 * A small hidden PowerShell helper reads the foreground HWND and the selected
 * UI Automation tab/list item. DevPhone itself remains interactive; moving to
 * a different external context auto-hides it, and returning shows it without
 * stealing focus. If an app does not expose an internal task through Windows
 * accessibility, matching falls back to the window title, then the HWND.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WATCH_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DevPhoneWindows {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Read-SelectedItems([IntPtr]$handle) {
  $items = New-Object System.Collections.Generic.List[object]
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if ($null -eq $root) { return @() }
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty,
      $true
    )
    $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $limit = [Math]::Min($found.Count, 80)
    for ($i = 0; $i -lt $limit; $i++) {
      try {
        $element = $found.Item($i)
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($pattern.Current.IsSelected) {
          $name = [string]$element.Current.Name
          $type = [string]$element.Current.ControlType.ProgrammaticName
          if ($name -and ($type -match 'TabItem|ListItem|TreeItem|DataItem')) {
            $items.Add([pscustomobject]@{ name = $name; type = $type }) | Out-Null
          }
        }
      } catch {}
    }
  } catch {}
  return @($items.ToArray())
}

$last = ''
while ($true) {
  try {
    $hwnd = [DevPhoneWindows]::GetForegroundWindow()
    if ($hwnd -ne [IntPtr]::Zero) {
      [uint32]$pidValue = 0
      [DevPhoneWindows]::GetWindowThreadProcessId($hwnd, [ref]$pidValue) | Out-Null
      $length = [DevPhoneWindows]::GetWindowTextLength($hwnd)
      $builder = New-Object System.Text.StringBuilder([Math]::Max(2, $length + 2))
      [DevPhoneWindows]::GetWindowText($hwnd, $builder, $builder.Capacity) | Out-Null
      $proc = [System.Diagnostics.Process]::GetProcessById([int]$pidValue)
      $exe = ''
      try { $exe = [string]$proc.MainModule.FileName } catch {}
      $selected = @(Read-SelectedItems $hwnd)
      $context = [pscustomobject]@{
        hwnd = $hwnd.ToInt64()
        pid = [int]$pidValue
        processName = [string]$proc.ProcessName
        exe = $exe
        title = $builder.ToString()
        selected = $selected
      }
      $json = $context | ConvertTo-Json -Depth 4 -Compress
      if ($json -ne $last) {
        [Console]::Out.WriteLine($json)
        [Console]::Out.Flush()
        $last = $json
      }
    }
  } catch {}
  Start-Sleep -Milliseconds 450
}
`;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch (e) {}
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeSelected(value) {
  const rows = Array.isArray(value) ? value : (value ? [value] : []);
  return rows
    .map((row) => ({
      name: String((row && row.name) || '').replace(/\s+/g, ' ').trim(),
      type: String((row && row.type) || '').trim(),
    }))
    .filter((row) => row.name)
    .slice(0, 12);
}

function selectionKey(context) {
  return normalizeSelected(context && context.selected)
    .map((row) => normalizeText(row.type) + ':' + normalizeText(row.name))
    .sort()
    .join('|');
}

function processKey(context) {
  return normalizeText((context && context.exe) || (context && context.processName));
}

function targetFromContext(context) {
  const selected = normalizeSelected(context && context.selected);
  const selectedKey = selectionKey({ selected });
  const title = String((context && context.title) || '').replace(/\s+/g, ' ').trim();
  const keyType = selectedKey ? 'selection' : (title ? 'title' : 'window');
  const key = keyType === 'selection' ? selectedKey : (keyType === 'title' ? normalizeText(title) : '');
  return {
    hwnd: Number(context && context.hwnd) || 0,
    pid: Number(context && context.pid) || 0,
    processName: String((context && context.processName) || ''),
    exe: String((context && context.exe) || ''),
    title,
    selected,
    keyType,
    key,
    attachedAt: new Date().toISOString(),
  };
}

function matchesTarget(target, context) {
  if (!target || !context) return false;
  const sameWindow = Number(target.hwnd) > 0 && Number(target.hwnd) === Number(context.hwnd);
  const sameProcess = processKey(target) && processKey(target) === processKey(context);
  if (!sameWindow && !sameProcess) return false;
  if (target.keyType === 'selection') return selectionKey(context) === target.key;
  if (target.keyType === 'title') return normalizeText(context.title) === target.key;
  return sameWindow;
}

function labelFor(target) {
  if (!target) return '';
  const appName = target.processName || path.basename(target.exe || '') || 'window';
  if (target.keyType === 'selection' && target.selected && target.selected.length) {
    return appName + ' — ' + target.selected.map((row) => row.name).join(' / ');
  }
  if (target.title) return appName + ' — ' + target.title;
  return appName;
}

function create(options) {
  const app = options.app;
  const selftest = !!options.selftest;
  const stateFile = path.join(app.getPath('userData'), 'attachment.json');
  const positionFile = path.join(app.getPath('userData'), 'window-position.json');
  let target = readJson(stateFile, null);
  let win = null;
  let ownWindowHandle = 0;
  let send = () => {};
  let helper = null;
  let helperReady = false;
  let helperError = '';
  let current = null;
  let lastExternal = null;
  let autoHidden = false;
  let manualMinimized = false;
  let mismatchCount = 0;
  let targetSeenThisRun = false;
  let buffer = '';
  let positionTimer = null;

  function publicStatus() {
    return {
      supported: process.platform === 'win32',
      available: helperReady,
      error: helperError,
      attached: !!target,
      target: target ? {
        label: labelFor(target),
        keyType: target.keyType,
        title: target.title,
        processName: target.processName,
        selected: target.selected || [],
      } : null,
      last: lastExternal ? { label: labelFor(targetFromContext(lastExternal)) } : null,
      autoHidden,
    };
  }

  function emit() {
    try { send('attachment:changed', publicStatus()); } catch (e) {}
  }

  function saveTarget() {
    writeJson(stateFile, target || null);
  }

  function savePositionNow() {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    try {
      const bounds = win.getBounds();
      writeJson(positionFile, { x: bounds.x, y: bounds.y, updatedAt: new Date().toISOString() });
    } catch (e) {}
  }

  function schedulePositionSave() {
    clearTimeout(positionTimer);
    positionTimer = setTimeout(savePositionNow, 250);
  }

  function showAttached() {
    if (!win || win.isDestroyed() || manualMinimized) return;
    try { win.setAlwaysOnTop(true); } catch (e) {}
    if (autoHidden || !win.isVisible()) {
      autoHidden = false;
      try {
        if (win.isMinimized()) win.restore();
        if (typeof win.showInactive === 'function') win.showInactive();
        else win.show();
      } catch (e) {}
      emit();
    }
  }

  function hideAttached() {
    if (!win || win.isDestroyed() || autoHidden || manualMinimized) return;
    autoHidden = true;
    try { win.hide(); } catch (e) {}
    emit();
  }

  function applyContext(context) {
    current = context;
    const own = Number(context && context.pid) === process.pid ||
      (ownWindowHandle > 0 && Number(context && context.hwnd) === ownWindowHandle);
    if (!own && context && context.hwnd) lastExternal = context;
    if (!target || own || manualMinimized) return;

    if (matchesTarget(target, context)) {
      targetSeenThisRun = true;
      mismatchCount = 0;
      // Rebind after the host application restarted, but only when a stable
      // title/selection key proved that this is the same context.
      if (Number(target.hwnd) !== Number(context.hwnd) && target.keyType !== 'window') {
        target.hwnd = Number(context.hwnd) || target.hwnd;
        target.pid = Number(context.pid) || target.pid;
        saveTarget();
      }
      showAttached();
    } else {
      mismatchCount++;
      if (targetSeenThisRun && mismatchCount >= 2) hideAttached();
    }
  }

  function onHelperLine(line) {
    line = String(line || '').trim();
    if (!line || line[0] !== '{') return;
    try {
      const parsed = JSON.parse(line);
      parsed.selected = normalizeSelected(parsed.selected);
      helperReady = true;
      helperError = '';
      applyContext(parsed);
    } catch (e) {}
  }

  function startHelper() {
    if (process.platform !== 'win32' || selftest || helper) return;
    const encoded = Buffer.from(WATCH_SCRIPT, 'utf16le').toString('base64');
    try {
      helper = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded,
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      helper.stdout.setEncoding('utf8');
      helper.stdout.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        lines.forEach(onHelperLine);
      });
      helper.stderr.setEncoding('utf8');
      helper.stderr.on('data', (chunk) => {
        const msg = String(chunk || '').trim();
        if (msg && !helperReady) helperError = msg.slice(0, 240);
      });
      helper.on('exit', (code) => {
        helper = null;
        helperReady = false;
        if (code && !helperError) helperError = 'Windows context helper exited (' + code + ').';
        emit();
      });
    } catch (e) {
      helper = null;
      helperError = String((e && e.message) || e);
      emit();
    }
  }

  function setWindow(nextWin, nextSend) {
    win = nextWin;
    send = nextSend || send;
    if (!win) return;
    try {
      const raw = win.getNativeWindowHandle();
      ownWindowHandle = raw.length >= 8 ? Number(raw.readBigUInt64LE(0)) : raw.readUInt32LE(0);
    } catch (e) { ownWindowHandle = 0; }
    win.on('move', schedulePositionSave);
    win.on('resize', schedulePositionSave);
    win.on('restore', () => {
      manualMinimized = false;
      autoHidden = false;
      emit();
    });
    win.on('minimize', () => {
      try { win.webContents.send('shell:visibility', { visible: false, reason: 'minimize' }); } catch (e) {}
    });
    win.on('show', () => {
      try { win.webContents.send('shell:visibility', { visible: true, reason: 'show' }); } catch (e) {}
    });
    startHelper();
    emit();
  }

  function attachLast() {
    if (!lastExternal) return { ok: false, error: 'Activate the target window or task first, then return to DevPhone.' };
    target = targetFromContext(lastExternal);
    targetSeenThisRun = true;
    try { target.alwaysOnTopBefore = !!(win && !win.isDestroyed() && win.isAlwaysOnTop()); } catch (e) {}
    mismatchCount = 0;
    saveTarget();
    try { if (win && !win.isDestroyed()) win.setAlwaysOnTop(true); } catch (e) {}
    emit();
    return { ok: true, status: publicStatus() };
  }

  function detach() {
    const restoreAlwaysOnTop = !!(target && target.alwaysOnTopBefore);
    target = null;
    targetSeenThisRun = false;
    mismatchCount = 0;
    autoHidden = false;
    saveTarget();
    try { if (win && !win.isDestroyed()) win.setAlwaysOnTop(restoreAlwaysOnTop); } catch (e) {}
    if (win && !win.isDestroyed() && !win.isVisible() && !manualMinimized) {
      try { win.show(); } catch (e) {}
    }
    emit();
    return { ok: true, status: publicStatus() };
  }

  function noteManualMinimize() {
    manualMinimized = true;
    autoHidden = false;
  }

  function getSavedPosition() {
    const saved = readJson(positionFile, null);
    if (!saved || !Number.isFinite(Number(saved.x)) || !Number.isFinite(Number(saved.y))) return null;
    return { x: Math.round(Number(saved.x)), y: Math.round(Number(saved.y)) };
  }

  function shutdown() {
    clearTimeout(positionTimer);
    savePositionNow();
    if (helper) {
      try { helper.kill(); } catch (e) {}
      helper = null;
    }
  }

  return {
    setWindow,
    attachLast,
    detach,
    getStatus: publicStatus,
    getSavedPosition,
    noteManualMinimize,
    shutdown,
    // Deterministic integration hook used by scripts/test-features.js. It is
    // not exposed through IPC/preload and cannot be reached by web content.
    _testApplyContext: applyContext,
  };
}

module.exports = {
  create,
  targetFromContext,
  matchesTarget,
  selectionKey,
};
