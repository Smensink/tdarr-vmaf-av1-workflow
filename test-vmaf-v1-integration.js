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
const cpuThreadsInput = details.inputs.find((entry) => entry.name === 'cpuV1ThreadsPerScore');
assert.strictEqual(productionInput.defaultValue, 'false');
assert.strictEqual(hdrProductionInput.defaultValue, 'false');
assert.strictEqual(cpuThreadsInput.defaultValue, '2');

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
const sdrProductionPolicy = calculate._test.resolveCpuV1ExecutionPolicy({
  inputs: {
    vmafCpuV1ProductionEnabled: 'true',
    vmafCpuV1ProductionAllowProvisionalHdr: 'false',
  },
  variables: { isHDR: false },
});
assert.strictEqual(sdrProductionPolicy.productionEnabled, true,
  'disabling provisional HDR must preserve promoted SDR CPU-v1 authority');
assert.strictEqual(sdrProductionPolicy.qualificationEnabled, true);
assert.strictEqual(sdrProductionPolicy.fallbackToGpuV0, false);
const hdrFallbackPolicy = calculate._test.resolveCpuV1ExecutionPolicy({
  inputs: {
    vmafCpuV1ProductionEnabled: 'true',
    vmafCpuV1ProductionAllowProvisionalHdr: 'false',
  },
  variables: { isHDR: true },
});
assert.deepStrictEqual({
  productionEnabled: hdrFallbackPolicy.productionEnabled,
  qualificationEnabled: hdrFallbackPolicy.qualificationEnabled,
  fallbackToGpuV0: hdrFallbackPolicy.fallbackToGpuV0,
  fallbackCode: hdrFallbackPolicy.fallbackCode,
}, {
  productionEnabled: false,
  qualificationEnabled: false,
  fallbackToGpuV0: true,
  fallbackCode: 'CPU_V1_PROVISIONAL_HDR_NOT_AUTHORIZED',
}, 'unauthorized HDR must select the established GPU-v0 contract, not throw');
assert(Object.isFrozen(hdrFallbackPolicy));
const hdrCanaryPolicy = calculate._test.resolveCpuV1ExecutionPolicy({
  inputs: {
    vmafCpuV1ProductionEnabled: 'true',
    vmafCpuV1ProductionAllowProvisionalHdr: 'true',
  },
  variables: { isHDR: true },
});
assert.strictEqual(hdrCanaryPolicy.productionEnabled, true,
  'an explicit canary override must remain available as a separate policy decision');
assert.strictEqual(hdrCanaryPolicy.fallbackToGpuV0, false);
assert.throws(() => calculate._test.resolveCpuV1ExecutionPolicy({
  inputs: { vmafCpuV1QualificationEnabled: 'true' },
  variables: {
    isHDR: true,
    vmafCpuV1QualificationAuthorized: true,
    vmafCpuV1AllowProvisionalHdr: false,
  },
}), /qualification requires explicit vmafCpuV1AllowProvisionalHdr=true/,
'HDR qualification must retain its independent fail-closed authorization');

assert.strictEqual(calculate._test.maxParallelCpuV1({ inputs: {} }), 1);
assert.strictEqual(calculate._test.maxParallelCpuV1({ inputs: { maxParallelCpuV1: 99 } }), 1);
assert.strictEqual(calculate._test.maxParallelCpuV1({ inputs: { maxParallelCpuV1: 1 } }), 1);
assert.strictEqual(calculate._test.cpuV1ThreadsPerScore({ inputs: {} }), 2);
assert.strictEqual(calculate._test.cpuV1ThreadsPerScore({
  inputs: { cpuV1ThreadsPerScore: 99 },
}), 4);
assert.strictEqual(calculate._test.cpuV1ThreadsPerScore({
  inputs: { cpuV1ThreadsPerScore: 1 },
}), 1);
const lockInfo = {
  lockDir: '/temp/vmaf-gpu-pipeline.lock',
  token: 'owned-token',
  leaseGeneration: 'owned-generation',
};
const retainedLogs = [];
const retainedArgs = {
  variables: {
    vmafGpuPipelineLock: lockInfo,
    vmafGpuPipelineLockAcquired: true,
  },
  jobLog(message) { retainedLogs.push(String(message)); },
};
let releaseOptions = null;
assert.strictEqual(calculate._test.releaseGpuLockForCpuScoring(
  retainedArgs,
  true,
  {
    release(lockDir, token, options) {
      assert.strictEqual(lockDir, lockInfo.lockDir);
      assert.strictEqual(token, lockInfo.token);
      releaseOptions = options;
      return { released: false, reason: 'lease changed during release' };
    },
  }
), null);
assert.deepStrictEqual(releaseOptions, {
  force: false,
  expectedGeneration: lockInfo.leaseGeneration,
});
assert.strictEqual(retainedArgs.variables.vmafGpuPipelineLockAcquired, true);
assert.strictEqual(retainedArgs.variables.vmafGpuPipelineLockReleased, undefined);
assert(retainedLogs.some((line) => line.includes('retaining ownership')));

const releasedArgs = {
  variables: {
    vmafGpuPipelineLock: lockInfo,
    vmafGpuPipelineLockAcquired: true,
  },
  jobLog() {},
};
assert.strictEqual(calculate._test.releaseGpuLockForCpuScoring(
  releasedArgs, true, { release() { return { released: true }; } }
), lockInfo);
assert.strictEqual(releasedArgs.variables.vmafGpuPipelineLockAcquired, false);
assert.strictEqual(releasedArgs.variables.vmafGpuPipelineLockReleased, true);
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
assert.strictEqual(calculate._test.cpuV1Capability({},
  { ...candidate, sourceDisplayAspectRatio: '4:3' }, fakeFs), false,
  'a tampered SAR/DAR identity must fail capability before authority');
assert.strictEqual(calculate._test.cpuV1Capability({},
  { ...candidate, sourceWidth: 1280, sourceHeight: 720 }, fakeFs), false,
  'an unsupported raster must fail capability before authority');
assert.strictEqual(calculate._test.isCpuV1GeometryError(Object.assign(
  new Error('unsupported'), { code: 'VMAF_V1_GEOMETRY_UNSUPPORTED' })), true);

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
assert(source.includes('vmafCpuV1GeometryRejected = true'));
assert(source.includes('Retaining the exact GPU-v0 production contract'));

const runner = fs.readFileSync('./runtime/vmaf-v1/vmaf-v1-score.sh', 'utf8');
assert(runner.includes('--metadata-output'));
assert(runner.includes('decoded frame-count mismatch'));
assert(runner.includes('"pixelFormat":"yuv420p10le"'));
assert(runner.includes("feature_spec='cambi=full_ref=true'"));

console.log('PASS default-off CPU VMAF-v1/full-reference-CAMBI qualification integration');
