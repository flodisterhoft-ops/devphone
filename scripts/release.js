'use strict';

/*
 * release.js — cut a cloud update: regenerate the changelog, verify WebKit is
 * present, then build the NSIS installer and publish it (+ latest.yml) to the
 * GitHub releases feed configured in electron-builder.yml.
 *
 *   npm run release
 *
 * The GitHub token is taken from GH_TOKEN/GITHUB_TOKEN if set, otherwise pulled
 * from the `gh` CLI you're already logged in with — so there's nothing to paste.
 * Bump "version" in package.json first; electron-updater compares versions.
 */

const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  try {
    process.env.GH_TOKEN = execSync('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) {}
}
if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.error('No GitHub token. Run `gh auth login`, or set GH_TOKEN, then retry.');
  process.exit(1);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env, shell: true });
  if (r.status !== 0) process.exit(r.status == null ? 1 : r.status);
}

run('node', ['scripts/gen-notes.js']);
run('node', ['scripts/check-webkit.js']);

const builder = path.join('node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
run(builder, ['--win', 'nsis', '--publish', 'always']);

// electron-builder uploaded to a DRAFT release (GitHub won't auto-create a tag
// for a published one) and can even create MORE THAN ONE draft for a tag
// (concurrent per-artifact publishers). Find the draft that actually holds the
// installer, publish it (which creates the tag), and delete the empty
// duplicate drafts so the releases page stays clean.
const version = require(path.join(ROOT, 'package.json')).version;
const REPO = 'flodisterhoft-ops/devphone-releases';
const TAG = 'v' + version;

function gh(args) {
  return execSync('gh ' + args, { cwd: ROOT, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

const releases = JSON.parse(gh(`api repos/${REPO}/releases --paginate`));
const mine = releases.filter((r) => r.tag_name === TAG);
const real = mine.find((r) => (r.assets || []).some((a) => /Setup.*\.exe$/i.test(a.name)));
if (!real) {
  console.error('release: no uploaded installer found for ' + TAG + ' — nothing published.');
  process.exit(1);
}
gh(`api -X PATCH repos/${REPO}/releases/${real.id} -F draft=false -f make_latest=true`);
mine.filter((r) => r.id !== real.id).forEach((r) => {
  try { gh(`api -X DELETE repos/${REPO}/releases/${r.id}`); console.log('  • removed duplicate draft release ' + r.id); } catch (e) {}
});

console.log('\nrelease: published ' + TAG + ' to https://github.com/' + REPO + '/releases/tag/' + TAG);
