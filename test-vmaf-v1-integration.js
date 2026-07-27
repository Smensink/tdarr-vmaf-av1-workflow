'use strict';
const assert = require('assert');
const fs = require('fs');
const calculate = require('./custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js');
const contracts = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/vmafMetricContract.js');
// Square-pixel 16:9 rasters; CPU-v1 requires explicit geometry identity.
const GEO = { sampleAspectRatio: '1:1', displayAspectRatio: '16:9', geometryNormalization: 'none' };
const helper = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/vmafV1Cpu.js');

const details = calculate.details();
const switchInput = details.inputs.find((entry) => entry.name === 'vmafCpuV1QualificationEnabled');
assert(switchInput, 'qualification switch is declared');
assert.strictEqual(switchInput.defaultValue, 'false', 'CPU-v1 must remain default-off');
const productionInput = details.inputs.find((entry) => entry.name === 'vmafCpuV1ProductionEnabled');
const hdrProductionInput = details.inputs.find((entry) => entry.name === 'vmafCpuV1ProductionAllowProvisionalHdr');
assert.strictEqual(productionInput.defaultValue, 'false');
assert.strictEqual(hdrProductionInput.defaultValue, 'false');

const resolve = calculate._test.resolveCpuV1QualificationEnabled;
assert.strictEqual(resolve({ inputs: {}, variables: {} }), false);
assert.strictEqual(resolve({
  inputs: { vmafCpuV1QualificationEnabled: true }, variables: {},
}), false, 'UI/input switch alone must not authorize candidate execution');
assert.strictEqual(resolve({
  inputs: { vmafCpuV1QualificationEnabled: false },
  variables: { vmafCpuV1QualificationAuthorized: true },
}), false, 'run authorization alone must not authorize candidate execution');
assert.strictEqual(resolve({
  inputs: { vmafCpuV1QualificationEnabled: 'true' },
  variables: { vmafCpuV1QualificationAuthorized: true },
}), true, 'candidate execution requires the double kill switch');
assert.strictEqual(calculate._test.resolveCpuV1ProductionEnabled({
  inputs: { vmafCpuV1ProductionEnabled: 'true' }, variables: {},
}), true, 'explicit production promotion is independently resolved');
assert.strictEqual(calculate._test.resolveCpuV1ProvisionalHdrAuthorized({
  inputs: { vmafCpuV1ProductionAllowProvisionalHdr: 'true' }, variables: {},
}), true, 'provisional HDR requires its own explicit authorization');

assert.strictEqual(calculate._test.maxParallelCpuV1({ inputs: {} }), 2);
assert.strictEqual(calculate._test.maxParallelCpuV1({ inputs: { maxParallelCpuV1: 99 } }), 2);
assert.strictEqual(calculate._test.maxParallelCpuV1({ inputs: { maxParallelCpuV1: 1 } }), 1);
assert(Math.abs(calculate._test.parseFrameRate({ avg_frame_rate: '24000/1001' }) - 23.976) < 0.001);

const candidate = contracts.resolveCpuV1Candidate({ ...GEO, width: 1920, height: 1080, isHdr: false, frameRate: 24, scoringBitDepth: 10, }, { attestedEncoderProfileId: 'test-profile' });
const accessible = [];
const fakeFs = {
  constants: { X_OK: 1 },
  accessSync(path, mode) { accessible.push([path, mode]); },
};
assert.strictEqual(calculate._test.cpuV1Capability({}, candidate, fakeFs), true);
const promoted = contracts.resolveCpuV1Production({ ...GEO, width: 1920, height: 1080, isHdr: false, frameRate: 24, scoringBitDepth: 10, }, { attestedEncoderProfileId: 'test-profile' });
assert.strictEqual(calculate._test.cpuV1Capability({}, promoted, fakeFs), true);
assert.deepStrictEqual(accessible.map((entry) => entry[0]),
  [helper.WRAPPER_PATH, helper.SCORE_WRAPPER_PATH,
    helper.WRAPPER_PATH, helper.SCORE_WRAPPER_PATH]);
assert.strictEqual(calculate._test.cpuV1Capability({},
  { ...candidate, upstreamRevision: 'wrong' }, fakeFs), false);

const pairedPolicyVariables = {
  vmafMinVMAF: 95,
  vmafMinFrameVMAF: 70,
  vmafSourceCAMBI: 1,
  vmafSourceCAMBIP95: 2,
};
assert.strictEqual(calculate._test.resolvePairedCqActingPolicy({
  variables: pairedPolicyVariables,
}).policy.vmafScoreMax, 100, 'legacy paired-CQ observations remain capped at 100');
assert.strictEqual(calculate._test.resolvePairedCqActingPolicy({
  variables: { ...pairedPolicyVariables, vmafMetricContractId: candidate.metricContractId },
}).policy.vmafScoreMax, 110, 'exact VMAF-v1 paired-CQ observations use the model ceiling');

for (const spec of [
  [1920, 1080, 24, false],
  [1920, 1080, 60, false],
  [3840, 2160, 24, false],
  [3840, 2160, 60, true],
]) {
  const contract = contracts.resolveCpuV1Candidate({ ...GEO, width: spec[0], height: spec[1], frameRate: spec[2], isHdr: spec[3], scoringBitDepth: 10, }, { attestedEncoderProfileId: 'test-profile' });
  assert.doesNotThrow(() => helper.profileForModelVersion(contract.modelVersion));
}

const source = fs.readFileSync(
  './custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js', 'utf8');
assert(source.includes("? calculateSingleVmafV1CpuAsync(args, calcResult, samples, cacheDir, metricContract)"));
assert(source.includes("? { reused: [], pending: validResults.slice() }"),
  'CPU-v1 must exclude precomputed GPU-v0 sentinels');
assert(source.includes('Cross-contract fallback is disabled'));
assert(source.includes("cambiTimingAttribution: 'integrated-in-vmaf-v1-wall-clock'"));
assert(source.includes("vmafSourceCambiTimingAttribution = 'integrated-in-vmaf-v1-wall-clock'"));

const runner = fs.readFileSync('./runtime/vmaf-v1/vmaf-v1-score.sh', 'utf8');
assert(runner.includes('--metadata-output'));
assert(runner.includes('decoded frame-count mismatch'));
assert(runner.includes('"pixelFormat":"yuv420p10le"'));
assert(runner.includes("feature_spec='cambi=full_ref=true'"));

console.log('PASS default-off CPU VMAF-v1/full-reference-CAMBI qualification integration');
