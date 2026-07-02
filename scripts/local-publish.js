'use strict';

/*
 * local-publish.js — electron-builder `afterAllArtifactBuild` hook.
 *
 * Writes dist/latest-build.json describing the build that just finished
 * (timestamp from the build-info.json stamp + the absolute path of the
 * NSIS setup exe). Installed copies of DevPhone read this manifest on
 * launch (src/main/selfupdate.js) and offer to install the newer build —
 * the local, fully-offline stand-in for an update server.
 */

const fs = require('fs');
const path = require('path');

module.exports = async function afterAllArtifactBuild(buildResult) {
  const root = path.resolve(__dirname, '..');
  let info = null;
  try { info = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8')); } catch (e) {}
  if (!info || !info.buildTime) {
    console.warn('  • local-publish: no build-info.json stamp — latest-build.json not written');
    return [];
  }
  const artifacts = buildResult.artifactPaths || [];
  const setup = artifacts.find((p) => /setup.*\.exe$/i.test(path.basename(p))) || null;
  const manifest = {
    buildTime: info.buildTime,
    builtAt: info.builtAt,
    setup: setup,
    portable: artifacts.find((p) => /\.exe$/i.test(p) && p !== setup) || null,
  };
  const out = path.join(buildResult.outDir, 'latest-build.json');
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log('  • wrote ' + out + (setup ? '' : ' (WARNING: no setup exe found)'));
  return [];
};
