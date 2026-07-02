'use strict';

/*
 * gen-notes.js — regenerate build/release-notes.md, the changelog shown in the
 * in-app "What's new" popup (electron-builder embeds it into latest.yml and the
 * GitHub release body via releaseInfo.releaseNotesFile).
 *
 * Source of the notes, in order of preference:
 *   1. RELEASE_NOTES.md at the project root, if present and non-empty — a manual
 *      override the dev can hand-write for a release.
 *   2. git commit subjects since the previous tag (or the last 15 commits if the
 *      repo has no tags yet), cleaned into a bullet list.
 *   3. A generic fallback line.
 *
 * Good commit messages → a good changelog for free. Run automatically by
 * `npm run release`; also available as `npm run notes`.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'release-notes.md');

function version() {
  try { return require(path.join(ROOT, 'package.json')).version; } catch (e) { return ''; }
}

function git(cmd) {
  try { return execSync('git ' + cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch (e) { return ''; }
}

function fromCommits() {
  const prevTag = git('describe --tags --abbrev=0');
  const range = prevTag ? prevTag + '..HEAD' : '';
  const raw = git('log ' + (range ? range + ' ' : '') + '--no-merges --pretty=format:%s' + (range ? '' : ' -n 15'));
  const seen = new Set();
  return raw
    .split('\n')
    .map((s) => s.trim())
    // drop a leading "v0.1.4:" / "0.1.4 -" style version prefix from the subject
    .map((s) => s.replace(/^v?\d+\.\d+\.\d+\s*[:\-–]\s*/i, ''))
    .filter((s) => s && !/^(chore|wip|merge|bump|typo|fixup)\b/i.test(s))
    .filter((s) => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 12);
}

function build() {
  const override = path.join(ROOT, 'RELEASE_NOTES.md');
  if (fs.existsSync(override)) {
    const body = fs.readFileSync(override, 'utf8').trim();
    if (body) return body + '\n';
  }
  const items = fromCommits();
  const lines = items.length ? items.map((s) => '- ' + s) : ['- Improvements and fixes.'];
  return lines.join('\n') + '\n';
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const notes = build();
fs.writeFileSync(OUT, notes);
console.log('gen-notes: wrote ' + path.relative(ROOT, OUT) + ' for v' + version() + '\n');
console.log(notes);
