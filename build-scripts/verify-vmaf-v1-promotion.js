'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const inContainer = fs.existsSync('/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/vmaf');
const root = inContainer
  ? '/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/vmaf'
  : path.resolve(__dirname, '../custom-cont-init.d/vmaf-plugin-patches');
const canonicalPath = inContainer
  ? '/app/configs/flow_YR5PZ1QaD_CANONICAL.json'
  : path.resolve(__dirname, '../configs/flow_YR5PZ1QaD_CANONICAL.json');
const calculate = require(path.join(root, 'calculateVMAF/1.0.0/index.js'));
const contracts = require(path.join(root, '_lib/vmafMetricContract.js'));
const helper = require(path.join(root, '_lib/vmafV1Cpu.js'));

const flow = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
const node = flow.flowPlugins.find((entry) => entry.pluginName === 'calculateVMAF');
assert(node, 'canonical calculateVMAF node missing');
const inputs = node.inputsDB || {};
assert.strictEqual(String(inputs.vmafCpuV1QualificationEnabled), 'false');
assert.strictEqual(String(inputs.vmafCpuV1ProductionEnabled), 'true');
assert.strictEqual(String(inputs.vmafCpuV1ProductionAllowProvisionalHdr), 'false');
assert.strictEqual(String(inputs.maxParallelCpuV1), '1');
assert.strictEqual(String(inputs.vmafPairedCqActingEnabled), 'false');
assert.strictEqual(String(inputs.pairedCqShadow), 'true');
assert.strictEqual(String(inputs.pairedCqShadowForceFull), 'true');
assert.strictEqual(String(inputs.pairedCqShadowAnchors), '6');
const retryNode = flow.flowPlugins.find((entry) =>
  entry.pluginName === 'checkCQRangeRetry');
assert(retryNode, 'canonical checkCQRangeRetry node missing');
assert.deepStrictEqual(retryNode.inputsDB, {
  maxRetries: '4',
  vmafHeadroomThreshold: '5',
  vmafBelowThresholdMargin: '5',
});

assert.strictEqual(calculate._test.resolveCpuV1ProductionEnabled({ inputs, variables: {} }), true);
assert.strictEqual(calculate._test.resolveCpuV1QualificationEnabled({ inputs, variables: {} }), false);
assert.strictEqual(calculate._test.resolveCpuV1ProvisionalHdrAuthorized({ inputs, variables: {} }), false);
assert.strictEqual(calculate._test.maxParallelCpuV1({ inputs }), 1);
assert.strictEqual(calculate._test.resolvePairedCqActingEnabled({ inputs, variables: {} }), false,
  'force-full must interlock actual paired-CQ inference');
assert.strictEqual(calculate._test.resolvePairedCqActingEnabled({
  inputs: { ...inputs, pairedCqShadowForceFull: 'false' }, variables: {},
}), false, 'clearing force-full alone must not silently arm acting');
assert.strictEqual(calculate._test.resolvePairedCqActingEnabled({
  inputs: {
    ...inputs,
    vmafPairedCqActingEnabled: 'true',
    pairedCqShadowForceFull: 'false',
  },
  variables: {},
}), true, 'acting requires an explicit promotion and removal of force-full');

const sdrSpec = {
  name: 'sdr', width: 1920, height: 800, isHdr: false, frameRate: 24,
  sampleAspectRatio: '1:1', displayAspectRatio: '12:5', geometryNormalization: 'none',
};
const sdrPolicy = calculate._test.resolveCpuV1ExecutionPolicy({
  inputs,
  variables: { isHDR: false },
});
assert.strictEqual(sdrPolicy.productionEnabled, true);
assert.strictEqual(sdrPolicy.fallbackToGpuV0, false);
const sdrContract = contracts.resolveCpuV1Production({ ...sdrSpec, scoringBitDepth: 10 });
assert.strictEqual(sdrContract.productionEligible, true);
assert.strictEqual(sdrContract.backend, 'cpu');
assert.strictEqual(sdrContract.scoringBitDepth, 10);
assert.strictEqual(sdrContract.scoringPixelFormat, 'yuv420p10le');
assert.strictEqual(sdrContract.allowGpuFallback, false);
assert.strictEqual(sdrContract.inferenceAuthorityContractId,
  'paired-cq-vmaf-v1-cambi-inference-authority-v1');
if (inContainer) assert.strictEqual(calculate._test.cpuV1Capability({}, sdrContract, fs), true);
assert(helper.profileForModelVersion(sdrContract.modelVersion));

const hdrSpec = {
  name: 'hdr-pq', width: 3840, height: 1604, isHdr: true, frameRate: 24,
  sampleAspectRatio: '1:1', displayAspectRatio: '960:401', geometryNormalization: 'none',
};
const hdrPolicy = calculate._test.resolveCpuV1ExecutionPolicy({
  inputs,
  variables: { isHDR: true },
});
assert.strictEqual(hdrPolicy.productionEnabled, false);
assert.strictEqual(hdrPolicy.qualificationEnabled, false);
assert.strictEqual(hdrPolicy.fallbackToGpuV0, true);
assert.strictEqual(hdrPolicy.fallbackCode, 'CPU_V1_PROVISIONAL_HDR_NOT_AUTHORIZED');
const hdrContract = contracts.resolveProductionForVideo(
  hdrSpec.width,
  hdrSpec.height
);
assert.strictEqual(hdrContract.backend, 'cuda');
assert.strictEqual(hdrContract.requiresGpu, true);
assert.strictEqual(hdrContract.allowCpuFallback, false);
const verified = [
  {
    contentClass: sdrContract.contentClass,
    backend: sdrContract.backend,
    metricContractId: sdrContract.metricContractId,
    modelVersion: sdrContract.modelVersion,
    productionEligible: sdrContract.productionEligible,
    hdrValidationStatus: sdrContract.hdrValidationStatus,
  },
  {
    contentClass: 'hdr-pq',
    backend: hdrContract.backend,
    metricContractId: hdrContract.metricContractId,
    modelName: hdrContract.modelName,
    requiresGpu: hdrContract.requiresGpu,
    fallbackCode: hdrPolicy.fallbackCode,
  },
];

console.log(JSON.stringify({
  pass: true,
  mode: 'cpu-vmaf-v1-sdr-production-hdr-gpu-v0',
  maxParallelCpuV1: 1,
  pairedCq: {
    armed: false,
    shadowEnabled: true,
    forceFullInterlocked: true,
    inferenceActive: false,
  },
  contracts: verified,
  runtimeRevision: helper.REVISION,
}, null, 2));
