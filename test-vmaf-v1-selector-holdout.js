'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const deployedVmafRoot = '/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/vmaf';
const vmafRoot = fs.existsSync(deployedVmafRoot)
  ? deployedVmafRoot
  : path.join(root, 'custom-cont-init.d', 'vmaf-plugin-patches');
const selectPath = path.join(vmafRoot, 'selectBestParameters', '1.0.0', 'index.js');
const selector = require(selectPath);
const contracts = require(path.join(vmafRoot, '_lib', 'vmafMetricContract.js'));
const cpu = require(path.join(vmafRoot, '_lib', 'vmafV1Cpu.js'));

// Square-pixel scope crops; CPU-v1 requires explicit geometry identity and
// never infers SAR/DAR from the raster. 1920x1040 reduces to 24:13.
const policy = {
  width: 1920, height: 1040, fps: 24000 / 1001, isHDR: false,
  sampleAspectRatio: '1:1', displayAspectRatio: '24:13', geometryNormalization: 'none',
};
const baseVariables = {
  vmafReferenceComparisonEncoderProfileId: contracts.COMPARISON_ENCODER_PROFILE_ID,
};

const production = selector._test.resolveMeasuredSweepContract({
  variables: { ...baseVariables, vmafCpuV1ProductionActive: true },
}, policy);
assert.strictEqual(production.productionEligible, true);
assert.strictEqual(production.backend, 'cpu');
assert.strictEqual(production.metricContractFamilyId, contracts.CPU_V1_CONTRACT_FAMILY_ID);
// The measurement identity is geometry-bound: coded raster, SAR, DAR and the
// normalization decision are all part of the contract id, so two different
// rasters can never share measured history.
assert.strictEqual(production.metricContractId,
  'vmaf-v1.0.16-cpu-float-native10-integrated-cambi-v1-sdr-standard-standard-rate-untonemapped'
  + '-coded1920x1040-sar1x1-dar24x13-norm-none');
assert.strictEqual(production.encoderProfileId, contracts.COMPARISON_ENCODER_PROFILE_ID);
const scorerGeometry = selector._test.cpuV1ScorerGeometryFromContract(production);
assert.deepStrictEqual(scorerGeometry, {
  width: 1920,
  height: 1040,
  sampleAspectRatio: '1:1',
  displayAspectRatio: '24:13',
  geometryNormalization: 'none',
});
assert.throws(() => selector._test.cpuV1ScorerGeometryFromContract({
  ...production,
  sourceSampleAspectRatio: null,
}), /lacks exact coded geometry/);
assert.throws(() => selector._test.cpuV1ScorerGeometryFromContract({
  ...production,
  geometryNormalization: 'scale',
}), /lacks exact coded geometry/);

const hdr = selector._test.resolveMeasuredSweepContract({
  variables: { ...baseVariables, vmafCpuV1ProductionActive: true },
}, {
  width: 3840, height: 1604, fps: 24, isHDR: true,
  sampleAspectRatio: '1:1', displayAspectRatio: '960:401', geometryNormalization: 'none',
});
assert.strictEqual(hdr.productionEligible, true);
assert.strictEqual(hdr.contentClass, 'hdr-pq');
assert.strictEqual(hdr.modelVersion, 'vmaf_v1.0.16_1d5h_2160');

const qualification = selector._test.resolveMeasuredSweepContract({
  variables: { ...baseVariables, vmafCpuV1QualificationActive: true },
}, policy);
assert.strictEqual(qualification.productionEligible, false);
assert.strictEqual(qualification.metricContractId, production.metricContractId);

const legacy = selector._test.resolveMeasuredSweepContract({ variables: baseVariables }, policy);
assert.strictEqual(legacy.backend, 'cuda');
assert.notStrictEqual(legacy.metricContractId, production.metricContractId);

const checked = [];
selector._test.assertMeasuredSweepRuntime(production, {
  constants: { X_OK: 1 },
  accessSync(file, mode) { checked.push([file, mode]); },
});
assert.deepStrictEqual(checked.map((x) => x[0]), [cpu.WRAPPER_PATH, cpu.SCORE_WRAPPER_PATH]);
assert.throws(() => selector._test.assertMeasuredSweepRuntime(
  { ...production, upstreamRevision: 'wrong' },
  { constants: { X_OK: 1 }, accessSync() {} },
), /exact isolated runtime identity/);

const source = fs.readFileSync(selectPath, 'utf8');
for (const token of [
  'measureCpuV1Holdout',
  'buildScorerCommand',
  'parseScorerOutput',
  "subsample: 1",
  "holdoutMetricContract.backend === 'cpu'",
  'CPU VMAF-v1 authoritative holdout',
  'vmafHoldoutVmafTimeSec',
  'var scorerGeometry = cpuV1ScorerGeometryFromContract(holdoutMetricContract)',
  'sampleAspectRatio: scorerGeometry.sampleAspectRatio',
  'displayAspectRatio: scorerGeometry.displayAspectRatio',
  'geometryNormalization: scorerGeometry.geometryNormalization',
]) assert(source.includes(token), token);
assert(source.indexOf("holdoutMetricContract.backend === 'cpu'") <
  source.indexOf('var capabilityCache = args.variables.vmafGpuCapabilityCache'));

console.log('PASS CPU-v1 selector contract propagation and authoritative holdout binding');
