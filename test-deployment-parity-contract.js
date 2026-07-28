'use strict';

const assert = require('assert');
const fs = require('fs');
const canonical = JSON.parse(fs.readFileSync('configs/flow_YR5PZ1QaD_CANONICAL.json', 'utf8'));
assert.strictEqual(canonical._id, 'YR5PZ1QaD');
assert.ok(canonical.flowPlugins.some((item) => item.id === 'gpuLockErrorHandler1'));
assert.ok(!canonical.flowPlugins.some((item) => item.pluginName === 'detectSceneComplexity'));
assert.strictEqual(String(canonical.flowPlugins.find((item) => item.pluginName === 'extractVideoSamples').inputsDB.maxSegments), '16');
assert.strictEqual(String(canonical.flowPlugins.find((item) => item.pluginName === 'calculateVMAF').inputsDB.ssimMode), 'off');
const encodingInputs = canonical.flowPlugins.find((item) => item.pluginName === 'testEncodingParameters').inputsDB;
assert.strictEqual(String(encodingInputs.explorationRate), '0.02');
assert.strictEqual(String(encodingInputs.encodeHardAbort), 'false');
assert.strictEqual(String(encodingInputs.encodeHardAbortK), '4');
assert.strictEqual(String(encodingInputs.encodeHardAbortMargin), '1.5');
assert.strictEqual(String(encodingInputs.sameTitleEmptyBandShadow), 'true');
assert.strictEqual(String(encodingInputs.targetSizeReduction), '30',
  'search target must bind the exact current delivery policy');
const calculateInputs = canonical.flowPlugins.find((item) => item.pluginName === 'calculateVMAF').inputsDB;
assert.strictEqual(String(calculateInputs.maxParallelVmaf), '8');
assert.strictEqual(String(calculateInputs.vmafCpuV1QualificationEnabled), 'false');
assert.strictEqual(String(calculateInputs.vmafCpuV1ProductionEnabled), 'true');
assert.strictEqual(String(calculateInputs.vmafCpuV1ProductionAllowProvisionalHdr), 'false',
  'provisional HDR CPU-v1 authority must remain explicitly disabled');
assert.strictEqual(String(calculateInputs.maxParallelCpuV1), '1');
assert.strictEqual(String(calculateInputs.cpuV1ThreadsPerScore), '2');
assert.strictEqual(String(calculateInputs.vmafPairedCqActingEnabled), 'false',
  'paired-CQ acting must remain explicitly disabled while force-full is enabled');
assert.strictEqual(String(calculateInputs.pairedCqShadow), 'true');
assert.strictEqual(String(calculateInputs.pairedCqShadowForceFull), 'true');
assert.strictEqual(String(calculateInputs.pairedCqShadowAnchors), '6');
const selectInputs = canonical.flowPlugins.find((item) =>
  item.pluginName === 'selectBestParameters').inputsDB;
assert.strictEqual(String(selectInputs.cpuV1ThreadsPerScore), '2');
assert.strictEqual(String(selectInputs.minSizeReduction), '20',
  'selector minimum must bind the exact current delivery policy');
const bracketInputs = canonical.flowPlugins.find((item) =>
  item.pluginName === 'checkCQBracket').inputsDB;
assert.deepStrictEqual({
  targetVMAF: String(bracketInputs.targetVMAF),
  expansionCQCount: String(bracketInputs.expansionCQCount),
  highMarginVMAFHeadroom: String(bracketInputs.highMarginVMAFHeadroom),
  highMarginVMAFHeadroom4K: String(bracketInputs.highMarginVMAFHeadroom4K),
  highMarginExpansionCQCount4K: String(bracketInputs.highMarginExpansionCQCount4K),
  threeStageVmaf: String(bracketInputs.threeStageVmaf),
  intermediateVmafSubsample: String(bracketInputs.intermediateVmafSubsample),
}, {
  targetVMAF: '95',
  expansionCQCount: '2',
  highMarginVMAFHeadroom: '1.5',
  highMarginVMAFHeadroom4K: '2',
  highMarginExpansionCQCount4K: '4',
  threeStageVmaf: 'false',
  intermediateVmafSubsample: '2',
}, 'critical CQ-bracketing policy must be explicit in the Flow');
const retryInputs = canonical.flowPlugins.find((item) =>
  item.pluginName === 'checkCQRangeRetry').inputsDB;
assert.deepStrictEqual({
  maxRetries: String(retryInputs.maxRetries),
  vmafHeadroomThreshold: String(retryInputs.vmafHeadroomThreshold),
  vmafBelowThresholdMargin: String(retryInputs.vmafBelowThresholdMargin),
}, {
  maxRetries: '4',
  vmafHeadroomThreshold: '5',
  vmafBelowThresholdMargin: '5',
}, 'critical CQ retry policy must be explicit in the Flow');
const hdrNode = canonical.flowPlugins.find((item) => item.id === 'hdr1');
assert.ok(hdrNode, 'canonical flow omits the dynamic-HDR policy node');
assert.strictEqual(hdrNode.inputsDB.dynamicHdrPolicy, 'profileAwareHdr10');
const dynamicHdrCleanup = canonical.flowEdges.find((edge) =>
  edge.source === 'hdr1' && String(edge.sourceHandle) === '3');
assert.ok(dynamicHdrCleanup, 'canonical flow lacks the incompatible dynamic-HDR route');
assert.strictEqual(dynamicHdrCleanup.target, 'F1jkDv0qn',
  'incompatible dynamic HDR must keep the library original');
const analysisNode = canonical.flowPlugins.find((item) => item.id === 'grainAnalysis1');
assert.ok(analysisNode, 'canonical flow omits the pre-encode grain analysis node');
assert.strictEqual(analysisNode.pluginName, 'analyzeFilmGrain');
assert.strictEqual(analysisNode.version, '1.0.0');
assert.strictEqual(analysisNode.inputsDB.mode, 'active');
assert.strictEqual(analysisNode.inputsDB.sourcePathRegex, '^/media/');
assert.strictEqual(analysisNode.inputsDB.eligibleProfiles, 'sdrAndPq');
assert.strictEqual(analysisNode.inputsDB.workRoot, 'grain-analysis');
assert.strictEqual(
  analysisNode.inputsDB.pipelinePath,
  '/opt/grain-pipeline/current/grain_pipeline_v5_direct.py'
);
assert.strictEqual(analysisNode.inputsDB.nvenccPath, '/usr/local/bin/nvencc');
assert.strictEqual(
  analysisNode.inputsDB.coordinatorPath,
  '/usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js'
);
const hdrAnalysisRoutes = canonical.flowEdges.filter((edge) =>
  edge.source === 'hdr1' && ['1', '2'].includes(String(edge.sourceHandle)));
assert.strictEqual(hdrAnalysisRoutes.length, 2,
  'both SDR and compatible HDR routes must run pre-encode grain analysis');
// Preserve the observed live topology: grain analysis is currently outside
// the GPU lock. This is snapshot fidelity, not evidence that concurrent KNN
// denoise is safe; the lock boundary remains an unresolved measured-design
// decision and must be changed with the canonical graph and tests together.
for (const edge of hdrAnalysisRoutes) assert.strictEqual(edge.target, 'grainAnalysis1');
const analysisRoutes = canonical.flowEdges.filter((edge) => edge.source === 'grainAnalysis1');
assert.deepStrictEqual(analysisRoutes.map((edge) => String(edge.sourceHandle)).sort(), ['1', '2', '3']);
for (const handle of ['1', '2']) {
  assert.strictEqual(analysisRoutes.find((edge) => String(edge.sourceHandle) === handle).target, 'meta1');
}
assert.strictEqual(analysisRoutes.find((edge) => String(edge.sourceHandle) === '3').target,
  'grainFailureCleanup1');
const metadataExtractRoutes = canonical.flowEdges.filter((edge) => edge.source === 'meta1');
assert.strictEqual(metadataExtractRoutes.length, 1,
  'grain disposition must reach extraction through one deterministic metadata edge');
assert.strictEqual(metadataExtractRoutes[0].target, 'extract1',
  'Analyze Film Grain must run before Extract Video Samples so reference selection is authenticated');
const grainNode = canonical.flowPlugins.find((item) => item.id === 'grainSynthesis1');
assert.ok(grainNode, 'canonical flow omits the grain synthesis node');
assert.strictEqual(grainNode.pluginName, 'synthesizeFilmGrain');
assert.strictEqual(grainNode.inputsDB.mode, 'active');
assert.strictEqual(grainNode.inputsDB.sourcePathRegex, '^/media/',
  'active grain scope must cover every mounted media file');
assert.strictEqual(grainNode.inputsDB.eligibleProfiles, 'sdrAndPq');
assert.strictEqual(grainNode.inputsDB.workRoot, 'grain-synthesis');
for (const obsolete of [
  'pythonPath', 'workers', 'scalingGain', 'highPassSigma',
  'energyTrimFraction', 'energyTimeoutSeconds', 'energyMinDelta',
  'energyGainMin', 'energyGainMax', 'energyMaxLogMad', 'energyMaxLogDeviation',
  'energyMinLumaSpacing',
  'energyMinLumaSpan', 'energyMaxLumaSpan', 'energyMaxLogSlopePerCode',
  'energyMaxGainRatio', 'energyAggregateTolerancePct', 'energyRegionTolerancePct',
  'pipelineTimeoutMinutes', 'requireExistingGpuLock', 'lockDir',
]) assert.ok(!(obsolete in grainNode.inputsDB), `direct FGS flow retained ${obsolete}`);
assert.strictEqual(
  grainNode.inputsDB.pipelinePath,
  '/opt/grain-pipeline/current/grain_pipeline_v5_direct.py'
);
const grainRoutes = canonical.flowEdges.filter((edge) => edge.source === 'grainSynthesis1');
assert.deepStrictEqual(grainRoutes.map((edge) => String(edge.sourceHandle)).sort(), ['1', '2', '3', '4']);
assert.strictEqual(grainRoutes.find((edge) => String(edge.sourceHandle) === '1').target,
  'deliveryValidate1',
  'validated grain output must reach exact-byte delivery validation');
assert.strictEqual(grainRoutes.find((edge) => String(edge.sourceHandle) === '2').target, 'F1jkDv0qn');
assert.strictEqual(grainRoutes.find((edge) => String(edge.sourceHandle) === '3').target, 'A811lg3V4');
assert.strictEqual(grainRoutes.find((edge) => String(edge.sourceHandle) === '4').target,
  'extract1', 'post-encode FGS failure must re-encode the untouched original');
const grainFailureCleanup = canonical.flowPlugins.find((item) => item.id === 'grainFailureCleanup1');
const grainFailureFail = canonical.flowPlugins.find((item) => item.id === 'grainFailureFail1');
assert.ok(grainFailureCleanup && grainFailureCleanup.pluginName === 'cleanupTempFiles');
assert.ok(grainFailureFail && grainFailureFail.pluginName === 'failFlow');
assert.strictEqual(canonical.flowEdges.find((edge) =>
  edge.source === grainFailureCleanup.id && String(edge.sourceHandle) === '1').target,
'grainFailureFail1');
const raw = fs.readFileSync('configs/flow_YR5PZ1QaD_CANONICAL.json', 'utf8');
assert.ok(!/"(plexToken|tmdbApiKey|tvdbApiKey|arr_api_key)"\s*:\s*"(?!\$\{TDARR_)/.test(raw));
const paritySource = fs.readFileSync('build-scripts/verify-vmaf-deployment-parity.js', 'utf8');
const initSource = fs.readFileSync('custom-cont-init.d/96-apply-vmaf-plugin-patches.sh', 'utf8');
const promotionSource = fs.readFileSync(
  'custom-cont-init.d/update-vmaf-flow-v1-promotion.js', 'utf8');
for (const binding of [
  "vmafCpuV1ProductionAllowProvisionalHdr: 'false'",
  "vmafPairedCqActingEnabled: 'false'",
  "pairedCqShadow: 'true'",
  "pairedCqShadowForceFull: 'true'",
  "targetSizeReduction: '30'",
  "minSizeReduction: '20'",
  "maxRetries: '4'",
  "vmafHeadroomThreshold: '5'",
  "vmafBelowThresholdMargin: '5'",
]) {
  assert.ok(promotionSource.includes(binding),
    `flow update script omits explicit policy binding ${binding}`);
}
assert.ok(promotionSource.includes('checkCQRangeRetry: {'),
  'flow update script does not target the CQ retry node');
const canonicalLocalNames = [...new Set(canonical.flowPlugins
  .filter((item) => item.sourceRepo === 'Local')
  .map((item) => item.pluginName))];
const expectedPinnedVmaf = canonicalLocalNames
  .filter((plugin) => !['checkFileAge', 'unmonitorRadarrOrSonarr'].includes(plugin))
  .sort();
const initPinnedVmaf = [...initSource.matchAll(/apply_patch_file '([^']+)\/1\.0\.0'/g)]
  .map((match) => match[1])
  .sort();
const parityPluginBlock = paritySource.match(/const plugins = \[([\s\S]*?)\];/);
assert.ok(parityPluginBlock, 'deployment parity plugin allowlist is not readable');
const parityPinnedVmaf = [...parityPluginBlock[1].matchAll(/'([^']+)'/g)]
  .map((match) => match[1])
  .sort();
assert.deepStrictEqual(initPinnedVmaf, expectedPinnedVmaf,
  'container init pinned-plugin set differs from canonical Local VMAF plugins');
assert.deepStrictEqual(parityPinnedVmaf, expectedPinnedVmaf,
  'deployment parity pinned-plugin set differs from canonical Local VMAF plugins');
for (const plugin of expectedPinnedVmaf) {
  assert.ok(fs.existsSync(
    `custom-cont-init.d/vmaf-plugin-patches/${plugin}/1.0.0/index.js`
  ), `host ${plugin}/1.0.0 payload is missing`);
}
assert.ok(initSource.includes(
  "SERVER_PLUGINS_ROOT='/app/server/Tdarr/Plugins'"
), 'container init must bind the complete persistent server plugin catalog');
assert.ok(initSource.includes('cp -a "$SERVER_PLUGINS_ROOT/." "$NODE_PLUGINS_ROOT/"'),
  'container init does not seed the ephemeral node from the complete server catalog');
assert.ok(initSource.includes(
  'find "$SERVER_PLUGINS_ROOT" -type l -print -quit'
), 'container init must reject symlinks in the persistent server plugin catalog');
assert.ok(initSource.includes('chown -R abc:abc "$NODE_PLUGINS_ROOT"'),
  'container init leaves the complete node catalog vulnerable to ownership failures');
assert.ok(initSource.includes(
  "NODE_PLUGINS_ROOT='/app/Tdarr_Node/assets/app/plugins'"
), 'container init must bind the exact internal-node plugin root');
assert.ok(initSource.includes(
  'NODE_PLUGIN_PIN_SENTINEL="$NODE_PLUGINS_ROOT/.git"'
), 'container init must use Tdarr_Node development-preservation interlock');
assert.ok(initSource.includes('mkdir -p "$NODE_PLUGIN_PIN_SENTINEL"'),
  'container init must arm the internal-node catalog pin');
assert.ok(
  initSource.includes(
    'chown --reference="$NODE_PLUGINS_ROOT" "$NODE_PLUGIN_PIN_SENTINEL"'
  ),
  'internal-node catalog pin must match its parent ownership before parity runs'
);
assert.ok(
  initSource.indexOf('cp -a "$SERVER_PLUGINS_ROOT/." "$NODE_PLUGINS_ROOT/"') <
    initSource.indexOf('mkdir -p "$NODE_PLUGIN_PIN_SENTINEL"'),
  'node download interlock must not precede the full catalog seed'
);
assert.ok(
  initSource.indexOf("apply_shared_lib_file 'vmafV1Cpu.js'") <
    initSource.indexOf('mkdir -p "$NODE_PLUGIN_PIN_SENTINEL"'),
  'node download interlock must not precede the last pinned helper'
);
assert.ok(paritySource.includes(
  "const nodePluginsRoot = '/app/Tdarr_Node/assets/app/plugins'"
), 'deployment parity must bind the exact internal-node plugin root');
assert.ok(paritySource.includes(
  "const serverPluginsRoot = '/app/server/Tdarr/Plugins'"
), 'deployment parity must bind the complete persistent server plugin catalog');
assert.ok(paritySource.includes('catalogSnapshot') &&
  paritySource.includes('server/internal-node plugin catalog file sets differ') &&
  paritySource.includes('server/internal-node plugin catalog hash mismatch:'),
'deployment parity must compare the complete server and internal-node catalogs');
for (const helper of ['cliUtils.js', 'hardwareUtils.js', 'hardwareUtils.test.js']) {
  assert.ok(paritySource.includes(
    `'FlowPlugins/FlowHelpers/1.0.0/${helper}'`
  ), `deployment parity omits required Tdarr helper ${helper}`);
}
assert.ok(paritySource.includes(
  'const nodePluginPinSentinel = `${nodePluginsRoot}/.git`'
), 'deployment parity must require the exact post-init download interlock');
assert.ok(paritySource.includes(
  "mismatches.push('internal-node plugin pin sentinel is missing')"
), 'deployment parity must fail closed when the interlock is absent');
assert.ok(paritySource.includes('canonicalLocalPlugins') && paritySource.includes('findPlugin'),
  'deployment parity does not validate every canonical Local plugin in the server and node catalogs');
assert.ok(paritySource.includes("process.env.TDARR_FLOW_PARITY_BOOTSTRAP === '1'") &&
  paritySource.includes('skipping only the live DB flow comparison') &&
  paritySource.includes('live database missing:'),
'fresh-install bootstrap must skip only DB flow equality and default to fail-closed parity');
assert.ok(paritySource.includes("const filterPlugins = ['checkFileAge']"),
  'deployment parity omits filter/checkFileAge/1.0.0');
assert.ok(paritySource.includes('/custom-cont-init.d/filter-plugin-patches'),
  'deployment parity omits the filter patch source root');
assert.ok(paritySource.includes('/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/filter'),
  'deployment parity omits the server filter root');
assert.ok(paritySource.includes('/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins/filter'),
  'deployment parity omits the node filter root');
assert.ok(initSource.includes("apply_filter_patch_file 'checkFileAge/1.0.0'"),
  'container init does not deploy filter/checkFileAge/1.0.0');
for (const helper of ['feasibility.js', 'gpuPipelineLock.js', 'sizeFailureShadow.js', 'vmafdb.js',
  'vmafpredict.js', 'referenceContractBridge.js', 'pairedCqShadow.js', 'emptyBandShadow.js', 'rejectionReasons.js',
  'grainAnalysisArtifact.js', 'postEncodeCheckpoint.js', 'postReplaceAttestation.js',
  'deliveryPolicy.js', 'deliveryFinalization.js', 'deliveryTransaction.js',
  'canonicalDenoise.js', 'nvencTemporalFilter.js', 'nvenccKnn.js',
  'grainVmafContract.js', 'vmafMetricContract.js',
  'currentContractMeasurementHistory.js', 'preFgsCambi.js', 'vmafV1Cpu.js']) {
  assert.ok(paritySource.includes(`'${helper}'`), `deployment parity omits ${helper}`);
  assert.ok(initSource.includes(`apply_shared_lib_file '${helper}'`),
    `container init does not deploy ${helper}`);
  assert.ok(fs.existsSync(`custom-cont-init.d/vmaf-plugin-patches/_lib/${helper}`),
    `host ${helper} payload is missing`);
}
assert.strictEqual(
  fs.readFileSync('plugins/vmaf/_lib/vmafV1Cpu.js', 'utf8'),
  fs.readFileSync('custom-cont-init.d/vmaf-plugin-patches/_lib/vmafV1Cpu.js', 'utf8'),
  'CPU-v1 helper source and deployment mirror differ'
);
assert.strictEqual(
  fs.readFileSync('plugins/vmaf/_lib/vmafV1Cpu.test.js', 'utf8'),
  fs.readFileSync('custom-cont-init.d/vmaf-plugin-patches/_lib/vmafV1Cpu.test.js', 'utf8'),
  'CPU-v1 helper tests and deployment mirror differ'
);
assert.strictEqual(
  fs.readFileSync('plugins/vmaf/calculateVMAF/1.0.0/index.js', 'utf8'),
  fs.readFileSync(
    'custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js', 'utf8'),
  'calculateVMAF source and deployment mirror differ'
);
const gitignore = fs.readFileSync('.gitignore', 'utf8');
assert.ok(gitignore.includes('plugins/vmaf/_lib/size_failure_shadow_hgb.json') &&
  gitignore.includes('custom-cont-init.d/vmaf-plugin-patches/_lib/size_failure_shadow_hgb.json'),
'row-derived size-failure model must remain an ignored private artifact');
const parityInitSource = fs.readFileSync('custom-cont-init.d/97-verify-vmaf-deployment-parity.sh', 'utf8');
assert.ok(parityInitSource.includes('/usr/local/build-scripts/verify-vmaf-deployment-parity.js'),
  'container init does not enforce deployment parity');
assert.ok(fs.existsSync(
  'custom-cont-init.d/vmaf-plugin-patches/synthesizeFilmGrain/1.0.0/index.js'
), 'host synthesizeFilmGrain/1.0.0 payload is missing');
assert.ok(fs.existsSync(
  'custom-cont-init.d/vmaf-plugin-patches/analyzeFilmGrain/1.0.0/index.js'
), 'host analyzeFilmGrain/1.0.0 payload is missing');
assert.ok(fs.existsSync(
  'custom-cont-init.d/vmaf-plugin-patches/detectGPUEncoder/1.0.0/index.js'
), 'host detectGPUEncoder/1.0.0 payload is missing');
assert.ok(fs.existsSync(
  'custom-cont-init.d/vmaf-plugin-patches/_lib/grainAnalysisArtifact.js'
), 'host grainAnalysisArtifact.js payload is missing');
assert.ok(initSource.includes("apply_tools_patch_file 'unmonitorRadarrOrSonarr/1.0.0'"),
  'container init does not pin tools/unmonitorRadarrOrSonarr/1.0.0');
assert.ok(fs.existsSync(
  'custom-cont-init.d/tools-plugin-patches/unmonitorRadarrOrSonarr/1.0.0/index.js'
), 'host unmonitorRadarrOrSonarr/1.0.0 payload is missing');
const deploySource = fs.readFileSync('build-scripts/deploy-grain-flow-canary.js', 'utf8');
assert.ok(deploySource.includes("process.env.ALLOW_GRAIN_FLOW_DEPLOY, '1'"),
  'live Flow deploy helper lacks its explicit operator guard');
assert.ok(deploySource.includes("db.exec('BEGIN IMMEDIATE')"),
  'live Flow deploy helper lacks a write transaction');
assert.ok(deploySource.includes('pre-grain-active-${stamp}.json'),
  'live Flow deploy helper lacks a pre-deployment backup');
assert.ok(deploySource.includes("'/temp/tdarr-vmaf-gpu-pipeline.lock'"),
  'live Flow deploy helper does not pin the production GPU lock');
assert.ok(deploySource.includes('activeProductionProcesses') &&
  deploySource.includes('/proc/${name}/cmdline') &&
  deploySource.includes('tdarr-nvencc-knn-ffmpeg.js'),
  'live Flow deploy helper trusts worker-idle state without an independent process drain check');
console.log('PASS canonical flow definition contract');
