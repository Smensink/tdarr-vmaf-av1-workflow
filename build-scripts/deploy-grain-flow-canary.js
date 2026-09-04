'use strict';

// One-shot, operator-invoked deployment of the reviewed r34 AV1 80/70 Flow.
// This file is JavaScript (not an init hook) so container restarts never mutate
// the live database implicitly. Run only after workers are idle:
//   ALLOW_AV1_80_70_HEVC_OFF_DEPLOY=1 node /usr/local/build-scripts/deploy-grain-flow-canary.js

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const quiescence = require('./assert-tdarr-quiescence.js');

const flowId = 'YR5PZ1QaD';
const releaseId = 'r34-20260904T060333Z-startup-canonical-protection';
const receiptSchema = 'tdarr-av1-80-70-hevc-off-deployment-receipt/v1';
const expectedCanonicalStructureSha256 =
  'f9e485ccf5d5e89222c3621ad295362a32e283f00e09909ac72cf991cca987ca';
const canonicalPath = process.env.GRAIN_FLOW_CANONICAL ||
  '/app/configs/flow_YR5PZ1QaD_CANONICAL.json';
const cohortPath = process.env.GRAIN_HEVC_COHORT_MANIFEST ||
  '/app/configs/hevc-fallback-canary/cohort.json';
const databasePath = process.env.GRAIN_FLOW_DATABASE ||
  '/app/server/Tdarr/DB2/SQL/database.db';
const backupRoot = process.env.GRAIN_FLOW_BACKUP_ROOT || '/app/configs/backups';
const apiBase = (process.env.GRAIN_FLOW_API_BASE || 'http://127.0.0.1:8266/api/v2')
  .replace(/\/+$/, '');
const apiTimeoutMs = Number(process.env.GRAIN_FLOW_API_TIMEOUT_MS || 10000);
const apiKey = String(process.env.TDARR_API_KEY || process.env.apiKey || '');
const gpuLockPath = process.env.GRAIN_FLOW_GPU_LOCK || '/temp/tdarr-vmaf-gpu-pipeline.lock';
const validateOnly = process.argv.includes('--validate-only');
const reviewFixture = process.argv.includes('--review-fixture');

if (!validateOnly) {
  assert.strictEqual(process.env.ALLOW_AV1_80_70_HEVC_OFF_DEPLOY, '1',
    'refusing live Flow mutation without ALLOW_AV1_80_70_HEVC_OFF_DEPLOY=1');
}
if (reviewFixture) {
  assert.strictEqual(validateOnly, true,
    '--review-fixture is restricted to non-mutating validation');
  assert.strictEqual(process.env.NODE_ENV, 'test',
    '--review-fixture is restricted to the test environment');
  assert(/^[0-9a-f]{64}$/.test(String(process.env.GRAIN_REVIEW_FIXTURE_CANONICAL_SHA256 || '')),
    'review fixture canonical SHA-256 is required');
}
assert(path.isAbsolute(gpuLockPath),
  `GRAIN_FLOW_GPU_LOCK must be an absolute path: ${gpuLockPath}`);

const canonicalRaw = fs.readFileSync(canonicalPath, 'utf8');
const requiredCanonicalSha256 = reviewFixture
  ? process.env.GRAIN_REVIEW_FIXTURE_CANONICAL_SHA256
  : expectedCanonicalStructureSha256;
assert.strictEqual(crypto.createHash('sha256').update(canonicalRaw).digest('hex'),
  requiredCanonicalSha256,
  'canonical Flow bytes differ from the exact reviewed r34 structure');
const canonical = JSON.parse(canonicalRaw);
assert.strictEqual(canonical._id, flowId, 'canonical Flow ID mismatch');
assert.strictEqual((canonical.flowPlugins || []).length, 39,
  'canonical r34 Flow must contain exactly 39 nodes');
assert.strictEqual((canonical.flowEdges || []).length, 63,
  'canonical r34 Flow must contain exactly 63 edges');

const hevcAdapter = (canonical.flowPlugins || []).find(
  (item) => item.id === 'activateHevcFallback1'
);
assert(hevcAdapter && hevcAdapter.pluginName === 'activateHevcFallback' &&
  hevcAdapter.version === '1.0.0' && hevcAdapter.sourceRepo === 'Local',
  'canonical r34 Flow is missing the local HEVC fallback adapter');
assert(hevcAdapter.inputsDB &&
  (hevcAdapter.inputsDB.enabled === false || hevcAdapter.inputsDB.enabled === 'false'),
  'canonical HEVC fallback adapter must be explicitly toggle-disabled');
assert.strictEqual(hevcAdapter.inputsDB.manifestPath,
  '/app/configs/hevc-fallback-canary/cohort.json');
assert(/^[0-9a-f]{64}$/.test(String(hevcAdapter.inputsDB.manifestFileSha256 || '')),
  'canonical HEVC adapter must pin the physical cohort manifest SHA-256');
const cohortRaw = fs.readFileSync(cohortPath);
assert.strictEqual(crypto.createHash('sha256').update(cohortRaw).digest('hex'),
  hevcAdapter.inputsDB.manifestFileSha256,
  'canonical HEVC adapter cohort digest differs from the reviewed manifest bytes');
const cohort = JSON.parse(cohortRaw.toString('utf8'));
assert(/^[0-9a-f]{64}$/.test(String(hevcAdapter.inputsDB.manifestCanonicalSha256 || '')),
  'canonical HEVC adapter must pin the canonical cohort manifest SHA-256');
assert.strictEqual(cohort.manifest_sha256,
  hevcAdapter.inputsDB.manifestCanonicalSha256,
  'canonical HEVC adapter embedded manifest digest differs from the reviewed value');
assert.strictEqual(String(hevcAdapter.inputsDB.expectedCohortSize), '30');
assert.strictEqual(String(hevcAdapter.inputsDB.maxUniqueCqs), '8');
assert.strictEqual(String(hevcAdapter.inputsDB.maxRetries), '2');
const hevcAdapterRoutes = (canonical.flowEdges || []).filter(
  (edge) => edge.source === hevcAdapter.id
);
assert(hevcAdapterRoutes.some((edge) => String(edge.sourceHandle) === '1' &&
  edge.target === 'gpuLockAcquire1'),
  'HEVC activation must re-enter the existing locked sample pipeline');
assert(hevcAdapterRoutes.some((edge) => String(edge.sourceHandle) === '2' &&
  edge.target === 'learn1'),
  'HEVC non-activation must preserve the existing retained-original path');
assert((canonical.flowEdges || []).some((edge) => edge.source === 'retry1' &&
  String(edge.sourceHandle) === '2' && edge.target === hevcAdapter.id),
  'terminal AV1 convergence must pass through the HEVC adapter');
assert.strictEqual(hevcAdapter.inputsDB.allowManifestPriorTerminal, false,
  'late adapter must require a live authenticated AV1 terminal handoff');

const priorHevcAdapter = (canonical.flowPlugins || []).find(
  (item) => item.id === 'activateHevcPrior1'
);
assert(priorHevcAdapter && priorHevcAdapter.pluginName === 'activateHevcFallback' &&
  priorHevcAdapter.version === '1.0.0' && priorHevcAdapter.sourceRepo === 'Local',
  'canonical r32 Flow is missing the manifest-bound prior-AV1 adapter');
assert.strictEqual(priorHevcAdapter.inputsDB.allowManifestPriorTerminal, true,
  'early adapter must explicitly opt into manifest-bound prior AV1 terminal evidence');
assert(priorHevcAdapter.inputsDB &&
  (priorHevcAdapter.inputsDB.enabled === false || priorHevcAdapter.inputsDB.enabled === 'false'),
  'canonical prior-evidence HEVC adapter must be explicitly toggle-disabled');
for (const field of ['manifestPath', 'manifestFileSha256', 'manifestCanonicalSha256',
  'expectedCohortSize', 'initialCqs', 'maxUniqueCqs', 'maxRetries']) {
  assert.deepStrictEqual(priorHevcAdapter.inputsDB[field], hevcAdapter.inputsDB[field],
    `early/late HEVC adapter input mismatch: ${field}`);
}
const metadataRoutes = (canonical.flowEdges || []).filter((edge) => edge.source === 'meta1');
assert(metadataRoutes.some((edge) => String(edge.sourceHandle) === '1' &&
  edge.target === 'extract1'),
'fresh sample extraction must run before the exact prior-AV1 adapter');
const extractionRoutes = (canonical.flowEdges || []).filter((edge) => edge.source === 'extract1');
assert(extractionRoutes.some((edge) => String(edge.sourceHandle) === '1' &&
  edge.target === priorHevcAdapter.id),
'extraction must hand its reset state to the exact prior-AV1 adapter');
const priorRoutes = (canonical.flowEdges || []).filter((edge) => edge.source === priorHevcAdapter.id);
assert.deepStrictEqual(priorRoutes.map((edge) => [String(edge.sourceHandle), edge.target]).sort(),
  [['1', 'gpuLockAcquire1'], ['2', 'gpuLockAcquire1']],
  'both early activation outcomes must enter testing only after the adapter establishes post-reset state');
assert.strictEqual(metadataRoutes.some((edge) => edge.target === priorHevcAdapter.id), false,
  'the prior adapter must not establish HEVC seeds before extractVideoSamples clears vmafNextCQs');

const policyPlugins = [
  'testEncodingParameters',
  'checkCQBracket',
  'checkCQRangeRetry',
  'selectBestParameters',
  'monitorTranscodeRetry',
];
for (const pluginName of policyPlugins) {
  const nodes = (canonical.flowPlugins || []).filter((node) => node.pluginName === pluginName);
  assert.strictEqual(nodes.length, 1,
    `canonical r34 Flow must contain exactly one ${pluginName} policy node`);
  assert.strictEqual(Number(nodes[0].inputsDB && nodes[0].inputsDB.ssimulacra2Floor), 80,
    `${pluginName} must carry SSIMULACRA2 mean floor 80`);
  assert.strictEqual(Number(nodes[0].inputsDB && nodes[0].inputsDB.ssimulacra2P5Floor), 70,
    `${pluginName} must carry SSIMULACRA2 p5 floor 70`);
}

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
assert.strictEqual(String(grainNode.inputsDB.maxFallbackReencodes), '1',
  'grain synthesis must permit exactly one bounded fallback re-encode');
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
  'deliveryValidate1',
  'validated active grain output must pass the final delivery validator'
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

const deliveryValidator = (canonical.flowPlugins || []).find(
  (item) => item.id === 'deliveryValidate1'
);
assert(deliveryValidator &&
  deliveryValidator.pluginName === 'validateDeliveryCandidate' &&
  deliveryValidator.version === '1.0.0',
  'canonical final delivery validator is missing');
const deliveryValidationRoutes = (canonical.flowEdges || []).filter(
  (edge) => edge.source === deliveryValidator.id
);
assert.strictEqual(
  deliveryValidationRoutes.find(
    (edge) => String(edge.sourceHandle) === '1'
  ).target,
  'replace1',
  'accepted final delivery candidate must enter attested replacement'
);
assert.strictEqual(
  deliveryValidationRoutes.find(
    (edge) => String(edge.sourceHandle) === '2'
  ).target,
  'F1jkDv0qn',
  'rejected final delivery candidate must preserve the original and clean up'
);
const remuxExecute = (canonical.flowPlugins || []).find(
  (item) => item.id === 'BthcE0uii'
);
assert(remuxExecute && remuxExecute.pluginName === 'ffmpegCommandExecute',
  'canonical remux execute node is missing');
assert((canonical.flowEdges || []).some((edge) =>
  edge.source === remuxExecute.id &&
  String(edge.sourceHandle) === '1' &&
  edge.target === deliveryValidator.id),
  'remux output must pass the final delivery validator');

const replacement = (canonical.flowPlugins || []).find(
  (item) => item.id === 'replace1'
);
const deliveryFinalizer = (canonical.flowPlugins || []).find(
  (item) => item.id === 'deliveryFinalize1'
);
assert(replacement &&
  replacement.pluginName === 'replaceOriginalFileAttested',
  'canonical attested replacement node is missing');
assert(deliveryFinalizer &&
  deliveryFinalizer.pluginName === 'finalizeDeliveredOutcome',
  'canonical delivered-outcome finalizer is missing');
const replacementRoutes = (canonical.flowEdges || []).filter(
  (edge) => edge.source === replacement.id
);
for (const handle of ['1', '2']) {
  assert.strictEqual(
    replacementRoutes.find(
      (edge) => String(edge.sourceHandle) === handle
    ).target,
    deliveryFinalizer.id,
    `replacement output ${handle} must enter delivered-outcome finalization`
  );
}
assert.strictEqual(
  replacementRoutes.find(
    (edge) => String(edge.sourceHandle) === '3'
  ).target,
  'F1jkDv0qn',
  'replacement keep-original output must clean up without finalization'
);

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
function requestJson(relativePath, options = {}) {
  const url = new URL(`${apiBase}/${relativePath.replace(/^\/+/, '')}`);
  const transport = url.protocol === 'https:' ? https : http;
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const headers = body === null ? { accept: 'application/json' } : {
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    };
    if (apiKey) headers['x-api-key'] = apiKey;
    const request = transport.request(url, {
      method: options.method || 'GET',
      headers,
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

function activeProductionProcesses() {
  // Tdarr's worker snapshot can transiently say idle while a CLI child still
  // owns the GPU lock and is encoding. Treat /proc as an independent drain
  // authority and report only PID/tool identity so media paths are not leaked.
  if (process.platform !== 'linux' || !fs.existsSync('/proc')) return [];
  const active = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^[1-9][0-9]*$/.test(name) || Number(name) === process.pid) continue;
    let argv;
    try {
      argv = fs.readFileSync(`/proc/${name}/cmdline`)
        .toString('utf8').split('\0').filter(Boolean);
    } catch (_) {
      continue;
    }
    if (argv.length === 0) continue;
    const executable = path.basename(argv[0]).toLowerCase();
    const script = argv.length > 1 ? path.basename(argv[1]).toLowerCase() : '';
    let identity = null;
    if (script === 'tdarr-nvencc-knn-ffmpeg.js') identity = script;
    else if (executable === 'nvencc') identity = executable;
    else if (executable === 'grav1synth') identity = executable;
    else if (executable === 'vmaf-v1-score.sh' || script === 'vmaf-v1-score.sh') {
      identity = 'vmaf-v1-score.sh';
    } else if (executable === 'tdarr-ffmpeg' || executable === 'tdarr-ffprobe') {
      identity = executable;
    } else if ((executable === 'ffmpeg' || executable === 'ffprobe') &&
        argv.slice(1).some((value) =>
          /\/temp\/(?:tdarr-workdir|\.vmaf-postencode-checkpoints-v1|vmaf-v1-score)/i
            .test(String(value)))) {
      identity = executable;
    }
    if (identity) active.push({ pid: Number(name), identity });
  }
  return active.sort((left, right) => left.pid - right.pid);
}

function assertNoProductionProcesses(stage) {
  const active = activeProductionProcesses();
  assert.strictEqual(active.length, 0,
    `refusing Flow mutation with live production CLI processes during ${stage} check: ` +
    active.map((item) => `${item.pid}/${item.identity}`).join(', '));
}

async function assertDeploymentQuiescence() {
  assertGpuLockAbsent('initial');
  assertNoProductionProcesses('initial');
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
  assertNoProductionProcesses('final');
  assertGpuLockAbsent('final');
  console.log('PASS deployment preflight: queues paused, workers idle, production CLI processes absent, and GPU pipeline lock absent');
}

async function main() {
  await quiescence.assertTdarrQuiescence(quiescence.configFromEnv());
  fs.mkdirSync(backupRoot, { recursive: true });

  const db = new DatabaseSync(databasePath);
  let transactionOpen = false;
  let backupPath;
  let receiptPath;
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const row = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(flowId);
    assert(row && typeof row.json_data === 'string', 'live Flow row is missing');
    const live = JSON.parse(row.json_data);

    // Canonical snapshots deliberately contain environment placeholders instead
    // of credentials. Until every community plugin supports env fallbacks, retain
    // validated live values while replacing everything else with the reviewed
    // canonical structure. Legacy <RADARR_API_KEY>/<SONARR_API_KEY> strings are
    // placeholders too; treating them as credentials caused post-delivery HTTP 401s.
    const deployment = JSON.parse(canonicalRaw);
    const liveById = new Map((live.flowPlugins || []).map((item) => [item.id, item]));
    const secretKeys = ['plexToken', 'tmdbApiKey', 'tvdbApiKey', 'arr_api_key'];
    const isCredentialPlaceholder = (value) => {
      const text = String(value || '').trim();
      return /^\$\{TDARR_[A-Z0-9_]+\}$/.test(text) || /^<[A-Z0-9_]+>$/.test(text);
    };
    const hasUsableCredential = (value) => Boolean(String(value || '').trim())
      && !isCredentialPlaceholder(value);
    const arrKind = (node) => {
      const inputs = (node && node.inputsDB) || {};
      const configured = String(inputs.arr || '').trim().toLowerCase();
      const host = String(inputs.arr_host || '').toLowerCase();
      return configured === 'sonarr' || host.includes(':8989') || /sonarr/.test(host)
        ? 'sonarr' : 'radarr';
    };
    const liveArrCredentials = new Map();
    for (const liveNode of live.flowPlugins || []) {
      if (liveNode.pluginName !== 'notifyRadarrOrSonarr') continue;
      const kind = arrKind(liveNode);
      const credential = liveNode.inputsDB && liveNode.inputsDB.arr_api_key;
      assert(hasUsableCredential(credential),
        `trusted live ${kind} notify credential is missing or still a placeholder`);
      assert(!liveArrCredentials.has(kind), `multiple trusted live ${kind} notify credentials found`);
      liveArrCredentials.set(kind, String(credential));
    }
    for (const targetNode of deployment.flowPlugins || []) {
      const liveNode = liveById.get(targetNode.id);
      if (!targetNode.inputsDB || !liveNode || !liveNode.inputsDB) continue;
      for (const key of secretKeys) {
        const canonicalValue = String(targetNode.inputsDB[key] || '');
        if (!/^\$\{TDARR_[A-Z0-9_]+\}$/.test(canonicalValue)) continue;
        let liveValue = String(liveNode.inputsDB[key] || '');
        if (key === 'arr_api_key' && !hasUsableCredential(liveValue)) {
          liveValue = String(liveArrCredentials.get(arrKind(targetNode)) || '');
        }
        assert(hasUsableCredential(liveValue),
          `live credential ${targetNode.id}.${key} is missing or still a placeholder`);
        targetNode.inputsDB[key] = liveValue;
      }
    }
    const deploymentRaw = JSON.stringify(deployment);

    backupPath = path.join(backupRoot, `flow_${flowId}.pre-r34-av1-80-70-hevc-off-${stamp}.json`);
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

    receiptPath = path.join(
      backupRoot, `flow_${flowId}.r34-av1-80-70-hevc-off-deployment-receipt-${stamp}.json`
    );
    const receipt = {
      schema: receiptSchema,
      release_id: releaseId,
      flow_id: flowId,
      deployed_payload_sha256: digest(deploymentRaw),
      canonical_structure_sha256: digest(canonicalRaw),
      cohort_file_sha256: hevcAdapter.inputsDB.manifestFileSha256,
      backup_path: backupPath,
      backup_sha256: digest(String(row.json_data).trim()),
      created_utc: new Date().toISOString(),
    };
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });

    db.exec('COMMIT');
    transactionOpen = false;

    // A post-commit exact read is defense in depth and produces a clear failure
    // if the durable row is not byte-for-byte the payload verified above.
    const saved = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(flowId);
    assert(saved && saved.json_data === deploymentRaw,
      'post-commit Flow read-back differs from the exact deployment payload');
    console.log(`PASS deployed r34 AV1 80/70 HEVC-off Flow ${flowId}`);
    console.log(`Backup: ${backupPath}`);
    console.log(`Deployment receipt: ${receiptPath}`);
    console.log(`Canonical structure SHA-256: ${digest(canonicalRaw)}`);
    console.log(`Deployed payload SHA-256: ${digest(deploymentRaw)}`);
  } catch (error) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      if (receiptPath) {
        try { fs.unlinkSync(receiptPath); } catch (_) {}
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

if (validateOnly) {
  console.log(`PASS validated r34 AV1 80/70 HEVC-off deployment payload ${flowId}`);
  console.log(`Canonical structure SHA-256: ${digest(canonicalRaw)}`);
} else {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
