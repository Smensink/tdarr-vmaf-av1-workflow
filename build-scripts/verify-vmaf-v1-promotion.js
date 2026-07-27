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
assert.strictEqual(String(inputs.vmafCpuV1ProductionAllowProvisionalHdr), 'true');
assert.strictEqual(String(inputs.maxParallelCpuV1), '2');
assert.strictEqual(String(inputs.vmafPairedCqActingEnabled), 'true');
assert.strictEqual(String(inputs.pairedCqShadow), 'true');
assert.strictEqual(String(inputs.pairedCqShadowForceFull), 'true');
assert.strictEqual(String(inputs.pairedCqShadowAnchors), '6');

assert.strictEqual(calculate._test.resolveCpuV1ProductionEnabled({ inputs, variables: {} }), true);
assert.strictEqual(calculate._test.resolveCpuV1QualificationEnabled({ inputs, variables: {} }), false);
assert.strictEqual(calculate._test.resolveCpuV1ProvisionalHdrAuthorized({ inputs, variables: {} }), true);
assert.strictEqual(calculate._test.maxParallelCpuV1({ inputs }), 2);
assert.strictEqual(calculate._test.resolvePairedCqActingEnabled({ inputs, variables: {} }), false,
  'force-full must interlock actual paired-CQ inference');
assert.strictEqual(calculate._test.resolvePairedCqActingEnabled({
  inputs: { ...inputs, pairedCqShadowForceFull: 'false' }, variables: {},
}), true, 'armed acting must become active only when force-full is explicitly cleared');

const specs = [
  {
    name: 'sdr', width: 1920, height: 800, isHdr: false, frameRate: 24,
    sampleAspectRatio: '1:1', displayAspectRatio: '12:5', geometryNormalization: 'none',
  },
  {
    name: 'hdr-pq', width: 3840, height: 1604, isHdr: true, frameRate: 24,
    sampleAspectRatio: '1:1', displayAspectRatio: '960:401', geometryNormalization: 'none',
  },
];
const verified = specs.map((spec) => {
  const contract = contracts.resolveCpuV1Production({ ...spec, scoringBitDepth: 10 });
  assert.strictEqual(contract.productionEligible, true);
  assert.strictEqual(contract.backend, 'cpu');
  assert.strictEqual(contract.scoringBitDepth, 10);
  assert.strictEqual(contract.scoringPixelFormat, 'yuv420p10le');
  assert.strictEqual(contract.allowGpuFallback, false);
  assert.strictEqual(contract.inferenceAuthorityContractId,
    'paired-cq-vmaf-v1-cambi-inference-authority-v1');
  if (inContainer) assert.strictEqual(calculate._test.cpuV1Capability({}, contract, fs), true);
  const profile = helper.profileForModelVersion(contract.modelVersion);
  assert(profile);
  return {
    contentClass: contract.contentClass,
    metricContractId: contract.metricContractId,
    modelVersion: contract.modelVersion,
    productionEligible: contract.productionEligible,
    hdrValidationStatus: contract.hdrValidationStatus,
  };
});

console.log(JSON.stringify({
  pass: true,
  mode: 'cpu-vmaf-v1-native10-integrated-cambi-production',
  maxParallelCpuV1: 2,
  pairedCq: {
    armed: true,
    forceFullInterlocked: true,
    inferenceActive: false,
  },
  contracts: verified,
  runtimeRevision: helper.REVISION,
}, null, 2));
