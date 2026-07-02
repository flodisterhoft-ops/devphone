'use strict';

const fs = require('fs');
const path = require('path');

function rootDir() {
  return path.resolve(__dirname, '..');
}

function browserDir(root) {
  return path.join(root || rootDir(), 'pw-browsers');
}

function checkLocalWebkit(options) {
  const opts = options || {};
  const root = opts.root || rootDir();
  const dir = browserDir(root);
  process.env.PLAYWRIGHT_BROWSERS_PATH = dir;

  let executable = '';
  try {
    executable = require('playwright').webkit.executablePath();
  } catch (e) {
    return {
      ok: false,
      error: 'Playwright is not installed: ' + String((e && e.message) || e),
      dir,
    };
  }

  if (!fs.existsSync(executable)) {
    return {
      ok: false,
      error:
        'Playwright WebKit is missing from ' + dir + '. Run `npm run webkit:install`.',
      dir,
      executable,
    };
  }

  return { ok: true, dir, executable };
}

if (require.main === module) {
  const res = checkLocalWebkit();
  if (!res.ok) {
    console.error(res.error);
    if (res.executable) console.error('Expected executable: ' + res.executable);
    process.exit(1);
  }
  console.log('WebKit ready: ' + res.executable);
}

module.exports = { checkLocalWebkit, browserDir };
