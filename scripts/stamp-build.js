'use strict';

/*
 * stamp-build.js — electron-builder `beforePack` hook.
 *
 * Writes build-info.json at the project root so the PACKAGED app knows
 * (a) when it was built and (b) where this project lives on disk. The
 * self-updater (src/main/selfupdate.js) compares its own stamp against
 * <projectDir>/dist/latest-build.json (written by local-publish.js) and
 * offers a one-click reinstall when a newer local build exists.
 *
 * build-info.json is listed in electron-builder.yml `files`, so the stamp
 * written here travels inside the asar of the build being produced.
 */

const fs = require('fs');
const path = require('path');

module.exports = async function beforePack() {
  const root = path.resolve(__dirname, '..');
  const webkit = require('./check-webkit').checkLocalWebkit({ root });
  if (!webkit.ok) {
    throw new Error(webkit.error);
  }

  const now = Date.now();
  const info = {
    buildTime: now,
    builtAt: new Date(now).toISOString(),
    projectDir: root,
  };
  fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
  console.log('  • stamped build-info.json (' + info.builtAt + ')');
};
