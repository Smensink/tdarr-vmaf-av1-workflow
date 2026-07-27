'use strict';

// One-shot, operator-invoked deployment of the reviewed canonical Flow.
// This file is JavaScript (not an init hook) so container restarts never mutate
// the live database implicitly. Run only after workers are idle:
//   ALLOW_GRAIN_FLOW_DEPLOY=1 node /usr/local/build-scripts/deploy-grain-flow-canary.js

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const flowId = 'YR5PZ1QaD';
const canonicalPath = process.env.GRAIN_FLOW_CANONICAL ||
  '/app/configs/flow_YR5PZ1QaD_CANONICAL.json';
const databasePath = process.env.GRAIN_FLOW_DATABASE ||
  '/app/server/Tdarr/DB2/SQL/database.db';
const backupRoot = process.env.GRAIN_FLOW_BACKUP_ROOT || '/app/configs/backups';
const apiBase = (process.env.GRAIN_FLOW_API_BASE || 'http://127.0.0.1:8266/api/v2')
  .replace(/\/+$/, '');
const apiTimeoutMs = Number(process.env.GRAIN_FLOW_API_TIMEOUT_MS || 10000);
const gpuLockPath = process.env.GRAIN_FLOW_GPU_LOCK || '/temp/tdarr-vmaf-gpu-pipeline.lock';

assert.strictEqual(process.env.ALLOW_GRAIN_FLOW_DEPLOY, '1',
  'refusing live Flow mutation without ALLOW_GRAIN_FLOW_DEPLOY=1');
assert(path.isAbsolute(gpuLockPath),
  `GRAIN_FLOW_GPU_LOCK must be an absolute path: ${gpuLockPath}`);

const canonicalRaw = fs.readFileSync(canonicalPath, 'utf8');
const canonical = JSON.parse(canonicalRaw);
assert.strictEqual(canonical._id, flowId, 'canonical Flow ID mismatch');

const analysisNode = (canonical.flowPlugins || []).find((item) => item.id === 'grainAnalysis1');
assert(analysisNode, 'canonical grain analysis node is missing');
assert.strictEqual(analysisNode.pluginName, 'analyzeFilmGrain');
assert.strictEqual(analysisNode.version, '1.0.0');
assert.strictEqual(analysisNode.inputsDB && analysisNode.inputsDB.mode, 'active');
assert.strictEqual(analysisNode.inputsDB.sourcePathRegex, '^/media/',
  'canonical grain analysis scope must cover every mounted media file');
assert.strictEqual(analysisNode.inputsDB.eligibleProfiles, 'sdrAndPq');
assert.strictEqual(
  analysisNode.inputsDB.pipelinePath,
  '/opt/grain-pipeline/current/grain_pipeline_v5_direct.py'
);
assert.strictEqual(analysisNode.inputsDB.nvenccPath, '/usr/local/bin/nvencc');
assert.strictEqual(analysisNode.inputsDB.coordinatorPath,
  '/usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js');
assert.strictEqual(analysisNode.inputsDB.workRoot, 'grain-analysis',
  'grain analysis artifacts must remain beneath the Tdarr job directory');

const analysisRoutes = (canonical.flowEdges || []).filter((edge) => edge.source === analysisNode.id);
assert.deepStrictEqual(
  analysisRoutes.map((edge) => String(edge.sourceHandle)).sort(),
  ['1', '2', '3'],
  'canonical grain analysis node does not route all three outcomes'
);
for (const handle of ['1', '2']) {
  assert.strictEqual(
    analysisRoutes.find((edge) => String(edge.sourceHandle) === handle).target,
    'meta1',
    `grain analysis output ${handle} must continue to metadata and normal VMAF processing`
  );
}
assert.strictEqual(
  analysisRoutes.find((edge) => String(edge.sourceHandle) === '3').target,
  'grainFailureCleanup1',
  'grain analysis technical failure must clean up before hard failure'
);
const hdrRoutes = (canonical.flowEdges || []).filter((edge) => edge.source === 'hdr1');
for (const handle of ['1', '2']) {
  assert.strictEqual(
    hdrRoutes.find((edge) => String(edge.sourceHandle) === handle).target,
    analysisNode.id,
    `HDR classifier output ${handle} must analyze the untouched source before metadata/VMAF`
  );
}

const grainNode = (canonical.flowPlugins || []).find((item) => item.id === 'grainSynthesis1');
assert(grainNode, 'canonical grain synthesis node is missing');
assert.strictEqual(grainNode.pluginName, 'synthesizeFilmGrain');
assert.strictEqual(grainNode.version, '1.0.0');
assert.strictEqual(grainNode.inputsDB && grainNode.inputsDB.mode, 'active');
assert.strictEqual(grainNode.inputsDB.sourcePathRegex, '^/media/',
  'canonical active grain scope must cover every mounted media file');
assert.strictEqual(grainNode.inputsDB.eligibleProfiles, 'sdrAndPq');
assert.strictEqual(
  grainNode.inputsDB.pipelinePath,
  '/opt/grain-pipeline/current/grain_pipeline_v5_direct.py'
);
assert.strictEqual(grainNode.inputsDB.workRoot, 'grain-synthesis',
  'grain synthesis artifacts must remain beneath the Tdarr job directory');
for (const obsolete of [
  'pythonPath', 'workers', 'scalingGain', 'highPassSigma',
  'energyTrimFraction', 'energyTimeoutSeconds', 'energyMinDelta',
  'energyGainMin', 'energyGainMax', 'energyMaxLogMad', 'energyMaxLogDeviation',
  'energyMinLumaSpacing',
  'energyMinLumaSpan', 'energyMaxLumaSpan', 'energyMaxLogSlopePerCode',
  'energyMaxGainRatio', 'energyAggregateTolerancePct', 'energyRegionTolerancePct',
  'pipelineTimeoutMinutes', 'requireExistingGpuLock', 'lockDir',
]) {
  assert.ok(!(obsolete in grainNode.inputsDB),
    `direct synthesizeFilmGrain must not retain ${obsolete}`);
}

const grainRoutes = (canonical.flowEdges || []).filter((edge) => edge.source === grainNode.id);
assert.deepStrictEqual(
  grainRoutes.map((edge) => String(edge.sourceHandle)).sort(),
  ['1', '2', '3', '4'],
  'canonical grain synthesis node does not route all four outcomes'
);
assert.strictEqual(
  grainRoutes.find((edge) => String(edge.sourceHandle) === '1').target,
  'replace1',
  'validated active grain output must bypass every post-validation remux'
);
assert.strictEqual(
  grainRoutes.find((edge) => String(edge.sourceHandle) === '2').target,
  'F1jkDv0qn',
  'grain canary output must keep the library original'
);
assert.strictEqual(
  grainRoutes.find((edge) => String(edge.sourceHandle) === '3').target,
  'A811lg3V4',
  'no-grain bypass must retain the normal reorder/replacement path'
);
assert.strictEqual(
  grainRoutes.find((edge) => String(edge.sourceHandle) === '4').target,
  'extract1',
  'grain technical failure must re-enter VMAF from the untouched original'
);
const grainFailureCleanup = (canonical.flowPlugins || []).find(
  (item) => item.id === 'grainFailureCleanup1'
);
const grainFailureFail = (canonical.flowPlugins || []).find(
  (item) => item.id === 'grainFailureFail1'
);
assert(grainFailureCleanup && grainFailureCleanup.pluginName === 'cleanupTempFiles',
  'canonical grain technical-failure cleanup node is missing');
assert(grainFailureFail && grainFailureFail.pluginName === 'failFlow',
  'canonical grain hard-failure node is missing');
const failureExit = (canonical.flowEdges || []).find(
  (edge) => edge.source === grainFailureCleanup.id && String(edge.sourceHandle) === '1'
);
assert(failureExit && failureExit.target === grainFailureFail.id,
  'grain technical-failure cleanup must terminate in Fail Flow');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
function requestJson(relativePath, options = {}) {
  const url = new URL(`${apiBase}/${relativePath.replace(/^\/+/, '')}`);
  const transport = url.protocol === 'https:' ? https : http;
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: options.method || 'GET',
      headers: body === null ? { accept: 'application/json' } : {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: apiTimeoutMs,
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Tdarr API ${url.pathname} returned HTTP ${response.statusCode}: ${raw}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`Tdarr API ${url.pathname} returned invalid JSON: ${error.message}`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error(
      `Tdarr API ${url.pathname} timed out after ${apiTimeoutMs}ms`
    )));
    request.on('error', reject);
    if (body !== null) request.write(body);
    request.end();
  });
}

function pauseIsAsserted(settings) {
  return settings && (settings.pauseAllNodes === true || settings.pauseAllNodes === 'manual');
}

function assertGpuLockAbsent(stage) {
  try {
    fs.lstatSync(gpuLockPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw new Error(`could not inspect GPU pipeline lock during ${stage} check: ${gpuLockPath}: ${error.message}`);
  }
  throw new Error(`refusing Flow mutation while GPU pipeline lock exists during ${stage} check: ${gpuLockPath}`);
}

async function assertDeploymentQuiescence() {
  assertGpuLockAbsent('initial');
  const settingsRequest = {
    data: {
      collection: 'SettingsGlobalJSONDB',
      mode: 'getById',
      docID: 'globalsettings',
      obj: {},
    },
    timeout: 20000,
  };
  const settingsBefore = await requestJson('cruddb', { method: 'POST', body: settingsRequest });
  assert(pauseIsAsserted(settingsBefore),
    `refusing Flow mutation while pauseAllNodes=${JSON.stringify(settingsBefore && settingsBefore.pauseAllNodes)}`);

  const nodes = await requestJson('get-nodes');
  assert(nodes && typeof nodes === 'object' && !Array.isArray(nodes),
    'Tdarr get-nodes response is not an object');
  const nonIdle = [];
  for (const [nodeId, node] of Object.entries(nodes)) {
    for (const [workerId, worker] of Object.entries((node && node.workers) || {})) {
      if (!worker || worker.idle !== true) {
        nonIdle.push(`${nodeId}/${workerId}(${worker && worker.workerType || 'unknown'}:${worker && worker.status || 'unknown'})`);
      }
    }
  }
  assert.strictEqual(nonIdle.length, 0,
    `refusing Flow mutation with non-idle workers: ${nonIdle.join(', ')}`);

  // Re-read after worker inspection. A continuous asserted pause plus an idle
  // worker snapshot prevents a new assignment from racing the DB transaction.
  const settingsAfter = await requestJson('cruddb', { method: 'POST', body: settingsRequest });
  assert(pauseIsAsserted(settingsAfter),
    `pauseAllNodes changed during deployment preflight: ${JSON.stringify(settingsAfter && settingsAfter.pauseAllNodes)}`);
  assertGpuLockAbsent('final');
  console.log('PASS deployment preflight: queues paused, all workers idle, and GPU pipeline lock absent');
}

async function main() {
  await assertDeploymentQuiescence();
  fs.mkdirSync(backupRoot, { recursive: true });

  const db = new DatabaseSync(databasePath);
  let transactionOpen = false;
  let backupPath;
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const row = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(flowId);
    assert(row && typeof row.json_data === 'string', 'live Flow row is missing');
    const live = JSON.parse(row.json_data);

    // Canonical snapshots deliberately contain environment placeholders instead
    // of credentials. Until every community plugin supports env fallbacks, retain
    // the corresponding non-empty live values while replacing everything else
    // with the reviewed canonical structure.
    const deployment = JSON.parse(canonicalRaw);
    const liveById = new Map((live.flowPlugins || []).map((item) => [item.id, item]));
    const secretKeys = ['plexToken', 'tmdbApiKey', 'tvdbApiKey', 'arr_api_key'];
    for (const targetNode of deployment.flowPlugins || []) {
      const liveNode = liveById.get(targetNode.id);
      if (!targetNode.inputsDB || !liveNode || !liveNode.inputsDB) continue;
      for (const key of secretKeys) {
        const canonicalValue = String(targetNode.inputsDB[key] || '');
        if (!/^\$\{TDARR_[A-Z0-9_]+\}$/.test(canonicalValue)) continue;
        const liveValue = String(liveNode.inputsDB[key] || '');
        assert(liveValue && !/^\$\{TDARR_[A-Z0-9_]+\}$/.test(liveValue),
          `live credential ${targetNode.id}.${key} is missing; refusing placeholder deployment`);
        targetNode.inputsDB[key] = liveValue;
      }
    }
    const deploymentRaw = JSON.stringify(deployment);

    backupPath = path.join(backupRoot, `flow_${flowId}.pre-grain-active-${stamp}.json`);
    fs.writeFileSync(backupPath, row.json_data.endsWith('\n') ? row.json_data : `${row.json_data}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });

    const update = db.prepare(
      'UPDATE flowsjsondb SET json_data = ?, timestamp = ? WHERE id = ?'
    ).run(deploymentRaw, Date.now(), flowId);
    assert.strictEqual(Number(update.changes), 1, 'live Flow update did not affect exactly one row');

    // This read is deliberately inside the write transaction. Any trigger,
    // storage anomaly, or payload mismatch aborts and rolls back before COMMIT.
    const savedInside = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(flowId);
    assert(savedInside && savedInside.json_data === deploymentRaw,
      'transactional Flow read-back differs from the exact deployment payload');
    db.exec('COMMIT');
    transactionOpen = false;

    // A post-commit exact read is defense in depth and produces a clear failure
    // if the durable row is not byte-for-byte the payload verified above.
    const saved = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(flowId);
    assert(saved && saved.json_data === deploymentRaw,
      'post-commit Flow read-back differs from the exact deployment payload');
    console.log(`PASS deployed active grain Flow ${flowId}`);
    console.log(`Backup: ${backupPath}`);
    console.log(`Canonical structure SHA-256: ${digest(canonicalRaw)}`);
    console.log(`Deployed payload SHA-256: ${digest(deploymentRaw)}`);
  } catch (error) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch (_) {}
    }
    throw error;
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
