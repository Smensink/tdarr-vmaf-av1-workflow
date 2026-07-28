'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const plugins = [
  'calculateVMAF', 'detectGPUEncoder', 'checkCQBracket', 'vmafOptimizedTranscode', 'checkHdrContent',
  'exportVMAFResults', 'extractVideoSamples', 'testEncodingParameters', 'selectBestParameters',
  'checkCQRangeRetry', 'learnCQRange', 'fetchMediaMetadata', 'monitorTranscodeRetry',
  'acquireGpuPipelineLock', 'releaseGpuPipelineLock', 'analyzeFilmGrain', 'synthesizeFilmGrain',
  'validateDeliveryCandidate', 'replaceOriginalFileAttested', 'finalizeDeliveredOutcome',
  'cleanupTempFiles'
];
const filterPlugins = ['checkFileAge'];
const toolsPlugins = ['unmonitorRadarrOrSonarr'];
const sharedHelpers = [
  'feasibility.js', 'gpuPipelineLock.js', 'sizeFailureShadow.js', 'vmafdb.js',
  'vmafpredict.js', 'referenceContractBridge.js', 'pairedCqShadow.js', 'emptyBandShadow.js', 'rejectionReasons.js',
  'grainAnalysisArtifact.js', 'postEncodeCheckpoint.js', 'postReplaceAttestation.js',
  'deliveryPolicy.js', 'deliveryFinalization.js', 'deliveryTransaction.js', 'canonicalDenoise.js',
  'nvencTemporalFilter.js', 'nvenccKnn.js', 'grainVmafContract.js', 'preFgsCambi.js',
  'vmafMetricContract.js', 'currentContractMeasurementHistory.js', 'vmafV1Cpu.js'
];
const roots = [
  '/custom-cont-init.d/vmaf-plugin-patches',
  '/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/vmaf',
  '/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins/vmaf'
];
const filterRoots = [
  '/custom-cont-init.d/filter-plugin-patches',
  '/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/filter',
  '/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins/filter'
];
const toolsRoots = [
  '/custom-cont-init.d/tools-plugin-patches',
  '/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/tools',
  '/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins/tools'
];
const serverPluginsRoot = '/app/server/Tdarr/Plugins';
const localServerRoot = '/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins';
const localNodeRoot = '/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins';
const nodePluginsRoot = '/app/Tdarr_Node/assets/app/plugins';
const nodePluginPinSentinel = `${nodePluginsRoot}/.git`;
const requiredTdarrHelperFiles = Object.freeze([
  'FlowPlugins/FlowHelpers/1.0.0/cliUtils.js',
  'FlowPlugins/FlowHelpers/1.0.0/hardwareUtils.js',
  'FlowPlugins/FlowHelpers/1.0.0/hardwareUtils.test.js',
]);
const flowParityBootstrap = process.env.TDARR_FLOW_PARITY_BOOTSTRAP === '1';
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function findPlugin(root, pluginName, version) {
  const suffix = `/${pluginName}/${version}/index.js`;
  const matches = [];
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) visit(fullPath);
      else if (item.isFile() && fullPath.replaceAll('\\', '/').endsWith(suffix)) matches.push(fullPath);
    }
  }
  visit(root);
  return matches;
}
const mismatches = [];
function catalogSnapshot(root, label, ignoredTopLevel = new Set()) {
  const files = new Map();
  function visit(directory, relativeDirectory = '') {
    let entries;
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        mismatches.push(`${label} contains an unsafe directory: ${relativeDirectory || '.'}`);
        return;
      }
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (_) {
      mismatches.push(`${label} cannot be inspected: ${relativeDirectory || '.'}`);
      return;
    }
    for (const entry of entries) {
      if (!relativeDirectory && ignoredTopLevel.has(entry.name)) continue;
      const relative = path.posix.join(relativeDirectory, entry.name);
      const fullPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        mismatches.push(`${label} contains a symlink: ${relative}`);
      } else if (stat.isDirectory()) {
        visit(fullPath, relative);
      } else if (stat.isFile()) {
        files.set(relative, sha(fullPath));
      } else {
        mismatches.push(`${label} contains an unsupported entry: ${relative}`);
      }
    }
  }
  visit(root);
  return files;
}
try {
  const root = fs.lstatSync(nodePluginsRoot);
  const sentinel = fs.lstatSync(nodePluginPinSentinel);
  if (!root.isDirectory() || root.isSymbolicLink()
    || !sentinel.isDirectory() || sentinel.isSymbolicLink()
    || fs.realpathSync(nodePluginsRoot) !== nodePluginsRoot
    || fs.realpathSync(nodePluginPinSentinel) !== nodePluginPinSentinel
    || sentinel.uid !== root.uid || sentinel.gid !== root.gid
    || (sentinel.mode & 0o022) !== 0) {
    mismatches.push('internal-node plugin pin sentinel is unsafe');
  }
} catch (_) {
  mismatches.push('internal-node plugin pin sentinel is missing');
}
const serverCatalog = catalogSnapshot(serverPluginsRoot, 'server plugin catalog');
const nodeCatalog = catalogSnapshot(
  nodePluginsRoot,
  'internal-node plugin catalog',
  new Set(['.git'])
);
for (const requiredFile of requiredTdarrHelperFiles) {
  if (!serverCatalog.has(requiredFile)) {
    mismatches.push(`server plugin catalog missing required helper: ${requiredFile}`);
  }
}
const serverCatalogFiles = [...serverCatalog.keys()].sort();
const nodeCatalogFiles = [...nodeCatalog.keys()].sort();
if (JSON.stringify(serverCatalogFiles) !== JSON.stringify(nodeCatalogFiles)) {
  mismatches.push('server/internal-node plugin catalog file sets differ');
} else {
  for (const relative of serverCatalogFiles) {
    if (serverCatalog.get(relative) !== nodeCatalog.get(relative)) {
      mismatches.push(`server/internal-node plugin catalog hash mismatch: ${relative}`);
    }
  }
}
for (const plugin of plugins) {
  const files = roots.map((root) => `${root}/${plugin}/1.0.0/index.js`);
  const missing = files.filter((file) => !fs.existsSync(file));
  if (missing.length) { mismatches.push(`${plugin}: missing ${missing.join(', ')}`); continue; }
  const hashes = files.map(sha);
  if (!hashes.every((hash) => hash === hashes[0])) mismatches.push(`${plugin}: hash mismatch`);
}
for (const plugin of filterPlugins) {
  const files = filterRoots.map((root) => `${root}/${plugin}/1.0.0/index.js`);
  const missing = files.filter((file) => !fs.existsSync(file));
  if (missing.length) { mismatches.push(`filter/${plugin}: missing ${missing.join(', ')}`); continue; }
  const hashes = files.map(sha);
  if (!hashes.every((hash) => hash === hashes[0])) mismatches.push(`filter/${plugin}: hash mismatch`);
}
for (const plugin of toolsPlugins) {
  const files = toolsRoots.map((root) => `${root}/${plugin}/1.0.0/index.js`);
  const missing = files.filter((file) => !fs.existsSync(file));
  if (missing.length) { mismatches.push(`tools/${plugin}: missing ${missing.join(', ')}`); continue; }
  const hashes = files.map(sha);
  if (!hashes.every((hash) => hash === hashes[0])) mismatches.push(`tools/${plugin}: hash mismatch`);
}
for (const helper of sharedHelpers) {
  const files = roots.map((root) => `${root}/_lib/${helper}`);
  const missing = files.filter((file) => !fs.existsSync(file));
  if (missing.length) { mismatches.push(`_lib/${helper}: missing ${missing.join(', ')}`); continue; }
  const hashes = files.map(sha);
  if (!hashes.every((hash) => hash === hashes[0])) mismatches.push(`_lib/${helper}: hash mismatch`);
}
const canonical = JSON.parse(fs.readFileSync('/app/configs/flow_YR5PZ1QaD_CANONICAL.json', 'utf8'));
const canonicalLocalPlugins = new Map();
for (const item of canonical.flowPlugins || []) {
  if (item.sourceRepo !== 'Local') continue;
  const pluginName = String(item.pluginName || '');
  const version = String(item.version || '');
  if (!pluginName || !version) {
    mismatches.push(`canonical local plugin has incomplete identity: ${item.id || '[no id]'}`);
    continue;
  }
  canonicalLocalPlugins.set(`${pluginName}@${version}`, { pluginName, version });
}
for (const { pluginName, version } of canonicalLocalPlugins.values()) {
  const serverMatches = findPlugin(localServerRoot, pluginName, version);
  if (serverMatches.length !== 1) {
    mismatches.push(`${pluginName}@${version}: expected one server catalog entry, found ${serverMatches.length}`);
    continue;
  }
  const relative = path.relative(localServerRoot, serverMatches[0]);
  const nodeFile = path.join(localNodeRoot, relative);
  if (!fs.existsSync(nodeFile)) {
    mismatches.push(`${pluginName}@${version}: node catalog missing ${nodeFile}`);
    continue;
  }
  if (sha(serverMatches[0]) !== sha(nodeFile)) {
    mismatches.push(`${pluginName}@${version}: server/node catalog hash mismatch`);
  }
}
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (['plexToken', 'tmdbApiKey', 'tvdbApiKey', 'arr_api_key'].includes(key)) output[key] = '[SECRET]';
    else output[key] = normalize(value[key]);
  }
  return output;
}
if (flowParityBootstrap) {
  console.warn(
    'WARNING: TDARR_FLOW_PARITY_BOOTSTRAP=1; skipping only the live DB flow comparison. '
    + 'Reset it to 0 and recreate immediately after importing the canonical flow.',
  );
} else {
  const dbPath = '/app/server/Tdarr/DB2/SQL/database.db';
  if (!fs.existsSync(dbPath)) {
    mismatches.push(`live database missing: ${dbPath}`);
  } else {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get('YR5PZ1QaD');
      db.close();
      if (!row) mismatches.push('live flow missing');
      const live = row ? JSON.parse(row.json_data) : {};
      if (JSON.stringify(normalize(live)) !== JSON.stringify(normalize(canonical))) {
        mismatches.push('live flow differs from canonical definition');
      }
    } catch (error) {
      mismatches.push(`live flow verification failed: ${error.message}`);
    }
  }
}
assert.deepStrictEqual(mismatches, [], mismatches.join('; '));
const liveFlowScope = flowParityBootstrap
  ? 'live flow explicitly skipped for first-start bootstrap'
  : 'canonical live flow';
console.log(`PASS deployment parity (${serverCatalog.size} complete catalog files + ${plugins.length} pinned VMAF plugins + ${filterPlugins.length} pinned filter plugin + ${toolsPlugins.length} pinned tools plugin + ${sharedHelpers.length} shared helpers + ${canonicalLocalPlugins.size} canonical local plugins + ${liveFlowScope})`);
