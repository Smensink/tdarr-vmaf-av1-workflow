'use strict';

const assert = require('assert');
const path = require('path');

const plugin = require(path.join(__dirname,
  'custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js'));

const safe = plugin._test.assessHoldoutSkipShadow({
  avgVMAFMean: 97.2,
  vmafP1Low: 90.0,
  avgCAMBI: 2.5,
  p95CAMBI: 3.0,
  sampleCount: 10,
}, {
  meanFloor: 95,
  frameFloor: 86,
  cambiLimit: 5,
  directlyMeasured: true,
});
assert.strictEqual(safe.predictedSafeToSkip, true);
assert.strictEqual(safe.candidateV2Safe, true);
assert.strictEqual(safe.candidateVersion, 'loo_buffer_composite_v2');
assert.deepStrictEqual(safe.reasons, []);

// New shadow-only candidate preserves the legacy branch and adds a leave-one-out-derived,
// high-confidence mean branch. It broadens coverage without changing live behaviour.
const v2Only = plugin._test.assessHoldoutSkipShadow({
  avgVMAFMean: 98.2,
  vmafP1Low: 86.5,
  avgCAMBI: 4.5,
  p95CAMBI: 4.6,
  sampleCount: 12,
}, {
  meanFloor: 95,
  frameFloor: 86,
  cambiLimit: 5,
  directlyMeasured: true,
});
assert.strictEqual(v2Only.predictedSafeToSkip, false, 'legacy rule remains unchanged');
assert.strictEqual(v2Only.candidateV2Safe, true, 'v2 composite is telemetry-only');
assert.deepStrictEqual(v2Only.candidateV2Reasons, []);

const formerOverfitCandidate = plugin._test.assessHoldoutSkipShadow({
  avgVMAFMean: 96.8,
  vmafP1Low: 89.2,
  avgCAMBI: 3.8,
  p95CAMBI: 4.4,
  sampleCount: 6,
}, {
  meanFloor: 95,
  frameFloor: 86,
  cambiLimit: 5,
  directlyMeasured: true,
});
assert.strictEqual(formerOverfitCandidate.candidateV2Safe, false,
  'six-sample post-hoc relaxation is intentionally rejected');

const boundary = plugin._test.assessHoldoutSkipShadow({
  avgVMAFMean: 96.9,
  vmafP1Low: 88.9,
  avgCAMBI: 3.5,
  p95CAMBI: 4.1,
  sampleCount: 7,
}, {
  meanFloor: 95,
  frameFloor: 86,
  cambiLimit: 5,
  directlyMeasured: false,
});
assert.strictEqual(boundary.predictedSafeToSkip, false);
assert(boundary.reasons.includes('not_directly_measured'));
assert(boundary.reasons.includes('sample_count_below_8'));
assert(boundary.reasons.includes('mean_margin_below_2'));
assert(boundary.reasons.includes('floor_margin_below_3'));
assert(boundary.reasons.includes('cambi_margin_below_1'));

const missingMetrics = plugin._test.assessHoldoutSkipShadow({ sampleCount: 16 }, {
  meanFloor: 95,
  frameFloor: 86,
  cambiLimit: 5,
  directlyMeasured: true,
});
assert.strictEqual(missingMetrics.predictedSafeToSkip, false, 'missing evidence must fail closed');

const harmonicAuthority = plugin._test.assessHoldoutSkipShadow({
  avgVMAF: 94.9,
  avgVMAFMean: 99.0,
  vmafP1Low: 95,
  avgCAMBI: 1,
  p95CAMBI: 1,
  sampleCount: 16,
}, {
  meanFloor: 95,
  frameFloor: 86,
  cambiLimit: 5,
  directlyMeasured: true,
});
assert.strictEqual(harmonicAuthority.mean, 94.9,
  'shadow telemetry must use the same harmonic metric as live selection');
assert.strictEqual(harmonicAuthority.predictedSafeToSkip, false,
  'an optimistic arithmetic mean cannot make harmonic quality safe');

assert.strictEqual(plugin._test.shouldApplyFractionalOverride(32.5, 32, false), false,
  'prediction-only fractional CQ cannot replace a fresh measurement without holdout authority');
assert.strictEqual(plugin._test.shouldApplyFractionalOverride(32.5, 32, true), true,
  'a harder fractional CQ may proceed only to enabled fresh holdout validation');
assert.strictEqual(plugin._test.shouldApplyFractionalOverride(31.5, 32, true), false,
  'the interpolation override never makes the measured choice less compressed');

const shadowInput = plugin.details().inputs.find((input) => input.name === 'holdoutSkipShadow');
assert(shadowInput);
assert.strictEqual(shadowInput.defaultValue, 'true');

console.log('PASS holdout skip shadow contract');
