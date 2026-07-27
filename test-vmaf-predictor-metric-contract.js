'use strict';

const assert = require('assert');
const predictor = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/vmafpredict.js');
const canonical = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/canonicalDenoise.js');

assert.strictEqual(predictor.primaryVmaf({
  vmaf_harmonic_mean: 94.25,
  vmaf_mean: 95.5,
  vmaf_min: 80,
  vmaf_max: 99,
}), 94.25, 'the selector target must use the authoritative harmonic aggregate');

assert.strictEqual(predictor.primaryVmaf({
  vmaf_harmonic_mean: null,
  vmaf_mean: 95.5,
  vmaf_min: 80,
  vmaf_max: 99,
}), 95.5, 'legacy rows without a harmonic aggregate must retain arithmetic fallback');

assert.strictEqual(predictor.primaryVmaf({
  vmaf_harmonic_mean: 5,
  vmaf_mean: 95.5,
  vmaf_min: 80,
  vmaf_max: 99,
}), 95.5, 'column-shifted harmonic data below its own minimum must be rejected');

assert.strictEqual(predictor.primaryVmaf({
  vmaf_harmonic_mean: 96,
  vmaf_mean: 95.5,
  vmaf_min: 80,
  vmaf_max: 99,
}), 95.5, 'a harmonic aggregate above its arithmetic mean must be rejected');

assert.strictEqual(predictor.primaryVmaf({
  vmaf_harmonic_mean: null,
  vmaf_mean: null,
}), null, 'missing metrics must not be coerced to zero');

const v1ContractId = 'vmaf-v1.0.16-cpu-float-native10-sdr-standard-3d0h-v1';
assert.strictEqual(predictor.maximumVmafObservation({ metric_contract_id: v1ContractId }), 110);
assert.strictEqual(predictor.maximumVmafObservation({ metric_contract_id: 'legacy-v0' }), 100);
assert.strictEqual(predictor.primaryVmaf({
  metric_contract_id: v1ContractId,
  vmaf_harmonic_mean: 104.5,
  vmaf_mean: 105,
  vmaf_min: 96,
  vmaf_max: 107,
}), 104.5, 'an exact VMAF-v1 contract may retain valid observations above 100');
assert.strictEqual(predictor.primaryVmaf({
  metric_contract_id: 'legacy-v0',
  vmaf_harmonic_mean: 104.5,
  vmaf_mean: 105,
  vmaf_min: 96,
  vmaf_max: 107,
}), null, 'legacy contracts must continue rejecting impossible >100 observations');
const v1Fit = predictor.fitLogCeiling([
  { cq: 20, vmaf_mean: 104, metric_contract_id: v1ContractId },
  { cq: 30, vmaf_mean: 98, metric_contract_id: v1ContractId },
]);
assert(v1Fit, 'VMAF-v1 values above 100 must remain usable by the curve fitter');
assert.strictEqual(v1Fit.ceiling, 110);
const legacyFit = predictor.fitLogCeiling([
  { cq: 20, vmaf_mean: 99, metric_contract_id: 'legacy-v0' },
  { cq: 30, vmaf_mean: 95, metric_contract_id: 'legacy-v0' },
]);
assert(legacyFit);
assert.strictEqual(legacyFit.ceiling, 100);

const calls = [];
const fakeDbModule = {
  getSimilarSweepCurves(db, src, options) {
    calls.push({ kind: 'similar', options });
    return [];
  },
  getSameFileSweepCurves(db, filePath, options) {
    calls.push({ kind: 'same-file', options });
    return [];
  },
};
predictor.selectCQFromDb({}, fakeDbModule, { file_path: '/media/title.mkv' },
  { targetVmaf: 95 }, {
    referenceContractId: canonical.REFERENCE_CONTRACT_ID,
    metricContractId: 'current-metric',
    encoderProfileId: 'current-encoder',
  });
predictor.selectCQFromDb({}, fakeDbModule, { file_path: '/media/title.mkv' },
  { targetVmaf: 95 }, {
    referenceContractId: canonical.FGS_BYPASS_REFERENCE_CONTRACT_ID,
    metricContractId: 'current-metric',
    encoderProfileId: 'current-encoder',
  });
predictor.sampleStatsFromDb({}, fakeDbModule, { file_path: '/media/title.mkv' },
  {
    referenceContractId: 'legacy-original-tf4-v1',
    metricContractId: 'legacy-metric',
    encoderProfileId: 'legacy-encoder',
  });
assert.deepStrictEqual(calls.map((call) => call.options.referenceContractId), [
  canonical.REFERENCE_CONTRACT_ID, canonical.REFERENCE_CONTRACT_ID,
  canonical.FGS_BYPASS_REFERENCE_CONTRACT_ID, canonical.FGS_BYPASS_REFERENCE_CONTRACT_ID,
  'legacy-original-tf4-v1', 'legacy-original-tf4-v1',
]);
assert.deepStrictEqual(calls.map((call) => call.options.metricContractId), [
  'current-metric', 'current-metric', 'current-metric', 'current-metric',
  'legacy-metric', 'legacy-metric',
]);
assert.deepStrictEqual(calls.map((call) => call.options.encoderProfileId), [
  'current-encoder', 'current-encoder', 'current-encoder', 'current-encoder',
  'legacy-encoder', 'legacy-encoder',
]);

console.log('PASS harmonic-VMAF authority, legacy fallback, and query-contract propagation');
