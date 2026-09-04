'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKUP_SUFFIX = /(?:\.bak[^/\\]*|\.orig|~)$/;
const SKIP_DISCOVERY_DIRS = new Set(['.git', '.worktrees', 'node_modules']);

function walkDirectories(root, visit) {
  if (!fs.existsSync(root)) return;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (SKIP_DISCOVERY_DIRS.has(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    visit(absolute, entry.name);
    walkDirectories(absolute, visit);
  }
}

function walkFiles(root, visit) {
  if (!fs.existsSync(root)) return;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      walkFiles(absolute, visit);
    } else if (entry.isFile()) {
      visit(absolute, entry.name);
    }
  }
}

function findBackupPayloadFiles(releaseRoot) {
  const payloadRoots = new Set();
  const initRoot = path.join(releaseRoot, 'custom-cont-init.d');
  if (fs.existsSync(initRoot) && fs.statSync(initRoot).isDirectory()) {
    payloadRoots.add(path.resolve(initRoot));
  }
  walkDirectories(releaseRoot, (absolute, name) => {
    if (name.endsWith('plugin-patches')) payloadRoots.add(path.resolve(absolute));
  });

  const matches = new Set();
  for (const payloadRoot of payloadRoots) {
    walkFiles(payloadRoot, (absolute, name) => {
      if (BACKUP_SUFFIX.test(name)) {
        matches.add(path.relative(releaseRoot, absolute).split(path.sep).join('/'));
      }
    });
  }
  return [...matches].sort();
}

const releaseRoot = fs.existsSync(path.join(__dirname, 'run-release-tests.js'))
  ? path.resolve(__dirname, '..')
  : __dirname;
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-release-payload-hygiene-'));

try {
  const initPayload = path.join(
    fixtureRoot, 'custom-cont-init.d', '.vmaf-plugin-patches', '_lib'
  );
  const detachedPayload = path.join(fixtureRoot, 'staging', 'tools-plugin-patches');
  const archiveRoot = path.join(fixtureRoot, 'init-script-backups');
  fs.mkdirSync(initPayload, { recursive: true });
  fs.mkdirSync(detachedPayload, { recursive: true });
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.writeFileSync(path.join(initPayload, 'gpuPipelineLock.js'), 'clean\n');
  assert.deepStrictEqual(findBackupPayloadFiles(fixtureRoot), []);

  fs.writeFileSync(path.join(initPayload, 'gpuPipelineLock.js.bak-retry'), 'stale\n');
  fs.writeFileSync(path.join(initPayload, 'index.js.orig'), 'stale\n');
  fs.writeFileSync(path.join(initPayload, 'index.js~'), 'stale\n');
  fs.writeFileSync(path.join(detachedPayload, 'plugin.js.bak'), 'stale\n');
  fs.writeFileSync(path.join(archiveRoot, 'retained-hook.sh.bak'), 'archive\n');
  assert.deepStrictEqual(findBackupPayloadFiles(fixtureRoot), [
    'custom-cont-init.d/.vmaf-plugin-patches/_lib/gpuPipelineLock.js.bak-retry',
    'custom-cont-init.d/.vmaf-plugin-patches/_lib/index.js.orig',
    'custom-cont-init.d/.vmaf-plugin-patches/_lib/index.js~',
    'staging/tools-plugin-patches/plugin.js.bak',
  ]);

  const currentMatches = findBackupPayloadFiles(releaseRoot);
  assert.deepStrictEqual(
    currentMatches,
    [],
    `backup-suffixed release payload files found:\n${currentMatches.join('\n')}`
  );
  console.log('PASS release payload excludes .bak*, .orig, and *~ files');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

module.exports = { findBackupPayloadFiles };
