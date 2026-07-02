'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const browsersPath = path.join(root, 'pw-browsers');

fs.mkdirSync(browsersPath, { recursive: true });
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;

const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
const res = spawnSync(process.execPath, [cli, 'install', 'webkit'], {
  cwd: root,
  env: Object.assign({}, process.env, { PLAYWRIGHT_BROWSERS_PATH: browsersPath }),
  stdio: 'inherit',
});

if (res.error) {
  console.error('Failed to run Playwright installer: ' + res.error.message);
  process.exit(1);
}

process.exit(res.status == null ? 1 : res.status);
