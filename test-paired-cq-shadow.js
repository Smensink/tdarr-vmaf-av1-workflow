'use strict';

const assert = require('assert');
const shadow = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/pairedCqShadow.js');

assert.strictEqual(shadow.SCHEMA_VERSION, 4);
assert.strictEqual(shadow.METRIC_MODE, 'selector_authoritative_harmonic_v4_inference_authority');
assert.strictEqual(
  shadow.TELEMETRY_PATH,
  '/app/configs/vmaf_paired_cq_shadow_harmonic_v4.jsonl',
);

function result(cq, vmafs, cambis, options = {}) {
  const means = options.means || vmafs;
  const p1s = options.p1s || vmafs.map((value) => value - 2);
  const cambiP95s = options.cambiP95s || cambis;
  return {
    parameterSetId: `cq${cq}`,
    parameterSet: { quality: cq },
    clipSampleIndices: vmafs.map((_, index) => index),
    clipVmafs: vmafs,
    clipVmafMeans: means,
    clipVmafP1s: p1s,
    clipCambis: { mean: cambis, p95: cambiP95s },
  };
}

const previous = result(28, [98, 97.5, 97, 96.5, 96, 95.5, 95, 94.5],
  [2, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7]);
const current = result(30, [97.5, 97, 96.5, 96, 95.5, 95, 94.5, 94],
  [2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9]);
const assessed = shadow.assess(previous, current, {
  anchorCount: 6,
  maxCqGap: 2,
  targetVmaf: 95,
  vmafP1Floor: 93,
  cambiLimit: 5,
  harmonicMargin: 0.25,
  p1Margin: 0.5,
  cambiMargin: 0.25,
});
assert.strictEqual(assessed.eligible, true);
assert.strictEqual(assessed.falseSafe, false);
assert.strictEqual(assessed.potentiallyAvoidableScores, 2);
assert(Math.abs(assessed.errors.harmonicAbsolute) < 1e-9);
assert(Math.abs(assessed.errors.p1Absolute) < 1e-9);
assert(Math.abs(assessed.errors.cambiRiskAbsolute) < 1e-9);

const unsafe = result(30, [97.5, 97, 96.5, 96, 95.5, 95, 90, 89],
  [2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 6.5, 7], {
    p1s: [92, 91.5, 91, 90.5, 90, 89.5, 80, 79],
  });
const rejected = shadow.assess(previous, unsafe, {
  targetVmaf: 95,
  vmafP1Floor: 93,
  cambiLimit: 5,
});
assert.strictEqual(rejected.eligible, true);
assert.strictEqual(rejected.actual.passed, false);
assert.strictEqual(rejected.metricMode, 'selector_authoritative_harmonic_v4_inference_authority');

// Regression: the old shadow used the percentile of harmonic clip scores as "p1" and could
// label a CQ safe even when the selector-authoritative minimum frame 1%-low failed badly.
const deceptivelySafeHarmonics = result(30,
  [97.5, 97.3, 97.1, 96.9, 96.7, 96.5, 96.3, 96.1],
  [2.1, 2.2, 2.1, 2.2, 2.1, 2.2, 2.1, 2.2], {
    means: [97.6, 97.4, 97.2, 97.0, 96.8, 96.6, 96.4, 96.2],
    p1s: [91, 90, 89, 88, 87, 86, 85, 80],
  });
const semanticRegression = shadow.assess(previous, deceptivelySafeHarmonics, {
  targetVmaf: 95,
  vmafP1Floor: 85,
  cambiLimit: 5,
});
assert.strictEqual(semanticRegression.predicted.safe, false);
assert.strictEqual(semanticRegression.actual.passed, false);
assert.strictEqual(semanticRegression.actual.p1, 80);

// clipVmafMeans is diagnostic only. The selector and this shadow both use the
// per-clip frame-harmonic score vector.
const noMeanDiagnostics = result(30, current.clipVmafs, current.clipCambis.mean);
delete noMeanDiagnostics.clipVmafMeans;
const noMeanAssessment = shadow.assess(previous, noMeanDiagnostics, {
  targetVmaf: 95, vmafP1Floor: 85, cambiLimit: 5,
});
assert.strictEqual(noMeanAssessment.eligible, true);

const missingHarmonics = result(30, current.clipVmafs, current.clipCambis.mean);
delete missingHarmonics.clipVmafs;
const missingRejected = shadow.assess(previous, missingHarmonics, {
  targetVmaf: 95, vmafP1Floor: 85, cambiLimit: 5,
});
assert.strictEqual(missingRejected.eligible, false);
assert(missingRejected.reasons.includes('missing_selector_metric_vectors'));

// Regression: arithmetic clip means can be comfortably above target while the
// selector-authoritative harmonic aggregate fails. V3 must follow clipVmafs.
const divergentMeans = result(30,
  [94.8, 94.7, 94.6, 94.5, 94.4, 94.3, 94.2, 94.1],
  [2.1, 2.2, 2.1, 2.2, 2.1, 2.2, 2.1, 2.2], {
    means: [98.4, 98.3, 98.2, 98.1, 98.0, 97.9, 97.8, 97.7],
    p1s: [94.5, 94.5, 94.5, 94.5, 94.5, 94.5, 94.5, 94.5],
  });
const harmonicRegression = shadow.assess(previous, divergentMeans, {
  targetVmaf: 95,
  vmafP1Floor: 93,
  cambiLimit: 5,
  // Compatibility: the old option name is accepted but reported under the
  // unambiguous v3 harmonic name.
  meanMargin: 0.4,
});
assert.strictEqual(harmonicRegression.eligible, true);
assert(harmonicRegression.actual.harmonic < 95);
assert.strictEqual(harmonicRegression.actual.passed, false);
assert.strictEqual(harmonicRegression.margins.harmonic, 0.4);
assert.strictEqual(harmonicRegression.actual.mean, undefined);
assert.strictEqual(harmonicRegression.errors.meanAbsolute, undefined);

const short = shadow.assess(previous, result(31, previous.clipVmafs.slice(0, 6),
  previous.clipCambis.mean.slice(0, 6)), { targetVmaf: 95, vmafP1Floor: 93, cambiLimit: 5 });
assert.strictEqual(short.eligible, false);
assert(short.reasons.includes('cq_gap_out_of_range'));
assert(short.reasons.includes('insufficient_matched_clips'));

assert.deepStrictEqual(shadow.stratified([0, 1, 2, 3, 4, 5, 6, 7], 6), [0, 2, 3, 4, 6, 7]);

// Acting reconstruction: one easier CQ is fully measured under the exact current
// contract; the adjacent harder CQ measures only deterministic anchors. Non-anchor
// values are inferred, explicitly labelled, and may act only when all margins pass.
const identity = {
  metricContractId: 'metric-current-v1',
  referenceContractId: 'reference-current-v1',
  encoderProfileId: 'encoder-current-v1',
  measurementSubsample: 4,
  policyId: 'selector-policy-current-v1',
  inferenceAuthorityContractId: 'paired-cq-vmaf-v1-cambi-inference-authority-v1',
};
const actingPrevious = Object.assign({}, previous, {
  measurementIdentity: identity,
  evidenceDisposition: 'measured_full_current_contract',
});
const actingAnchorIndices = shadow.stratified(previous.clipSampleIndices, 6);
function anchorOnly(full, indices) {
  return {
    parameterSetId: full.parameterSetId,
    parameterSet: full.parameterSet,
    clipSampleIndices: indices,
    clipVmafs: indices.map((index) => full.clipVmafs[index]),
    clipVmafMeans: indices.map((index) => full.clipVmafMeans[index]),
    clipVmafP1s: indices.map((index) => full.clipVmafP1s[index]),
    clipCambis: {
      mean: indices.map((index) => full.clipCambis.mean[index]),
      p95: indices.map((index) => full.clipCambis.p95[index]),
    },
    measurementIdentity: identity,
    evidenceDisposition: 'measured_anchor_current_contract',
  };
}
const actingCurrentAnchors = anchorOnly(current, actingAnchorIndices);
const reconstruction = shadow.reconstructPartial(actingPrevious, actingCurrentAnchors, {
  anchorCount: 6,
  maxCqGap: 2,
  targetVmaf: 94,
  vmafP1Floor: 91,
  cambiLimit: 5,
  harmonicMargin: 0.25,
  p1Margin: 0.5,
  cambiMargin: 0.25,
  vmafScoreMax: 100,
});
assert.strictEqual(reconstruction.eligible, true);
assert.strictEqual(reconstruction.actingSafe, true);
assert.strictEqual(reconstruction.reconstructed.sampleCount, 8);
assert.strictEqual(reconstruction.reconstructed.measuredClipCount, 6);
assert.strictEqual(reconstruction.reconstructed.inferredClipCount, 2);
assert.deepStrictEqual(reconstruction.reconstructed.clipSampleIndices, previous.clipSampleIndices);
assert.strictEqual(
  reconstruction.reconstructed.clipProvenance.filter((value) => value === 'paired_cq_inferred_v1').length,
  2,
);
assert.strictEqual(reconstruction.reconstructed.measurementDisposition, 'paired_cq_inferred_v1');
assert.deepStrictEqual(reconstruction.reconstructed.measurementIdentity, identity);

const wrongIdentityAnchors = anchorOnly(current, actingAnchorIndices);
wrongIdentityAnchors.measurementIdentity = Object.assign({}, identity, { measurementSubsample: 1 });
const wrongIdentity = shadow.reconstructPartial(actingPrevious, wrongIdentityAnchors, {
  anchorCount: 6, targetVmaf: 94, vmafP1Floor: 91, cambiLimit: 5,
});
assert.strictEqual(wrongIdentity.eligible, false);
assert(wrongIdentity.reasons.includes('measurement_identity_mismatch'));

const biasedAnchors = anchorOnly(current, [0, 1, 2, 3, 4, 5]);
const biased = shadow.reconstructPartial(actingPrevious, biasedAnchors, {
  anchorCount: 6, targetVmaf: 94, vmafP1Floor: 91, cambiLimit: 5,
});
assert.strictEqual(biased.eligible, false);
assert(biased.reasons.includes('anchor_set_mismatch'));

const missingMeasuredDisposition = Object.assign({}, actingPrevious);
delete missingMeasuredDisposition.evidenceDisposition;
const unproven = shadow.reconstructPartial(missingMeasuredDisposition, actingCurrentAnchors, {
  anchorCount: 6, targetVmaf: 94, vmafP1Floor: 91, cambiLimit: 5,
});
assert.strictEqual(unproven.eligible, false);
assert(unproven.reasons.includes('previous_not_fully_measured'));

const unsafeAnchors = anchorOnly(unsafe, actingAnchorIndices);
unsafeAnchors.measurementIdentity = identity;
unsafeAnchors.evidenceDisposition = 'measured_anchor_current_contract';
const unsafeReconstruction = shadow.reconstructPartial(actingPrevious, unsafeAnchors, {
  anchorCount: 6, targetVmaf: 95, vmafP1Floor: 93, cambiLimit: 5,
});
assert.strictEqual(unsafeReconstruction.eligible, false);
assert(unsafeReconstruction.reasons.includes('anchor_delta_uncertain'));

const marginUnsafe = shadow.reconstructPartial(actingPrevious, actingCurrentAnchors, {
  anchorCount: 6, targetVmaf: 98, vmafP1Floor: 96, cambiLimit: 5,
});
assert.strictEqual(marginUnsafe.eligible, true);
assert.strictEqual(marginUnsafe.actingSafe, false);

const improving = result(30,
  previous.clipVmafs.map((value) => value + 0.2),
  previous.clipCambis.mean.map((value) => value + 0.1));
const improvingAnchors = anchorOnly(improving, actingAnchorIndices);
improvingAnchors.measurementIdentity = identity;
improvingAnchors.evidenceDisposition = 'measured_anchor_current_contract';
const nonMonotonic = shadow.reconstructPartial(actingPrevious, improvingAnchors, {
  anchorCount: 6, targetVmaf: 94, vmafP1Floor: 91, cambiLimit: 5,
});
assert.strictEqual(nonMonotonic.eligible, false);
assert(nonMonotonic.reasons.includes('non_monotonic_harder_cq_vmaf'));

console.log('PASS paired-CQ shadow and acting reconstruction helper');
