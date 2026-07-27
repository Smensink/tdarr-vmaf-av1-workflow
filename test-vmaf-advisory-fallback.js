'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const selectorPath = path.join(__dirname,
  'custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js');
const selector = require(selectorPath);
const {
  chooseMeasuredToleranceFallback,
  classifyToleranceRejection,
  measuredQualityPasses,
} = selector._test;

function point(cq, vmaf, p1, cambi, sizeMb) {
  return {
    parameterSetId: `gpu_p7_cq${cq}`,
    parameterSet: { id: `gpu_p7_cq${cq}`, quality: cq, encoder: 'av1_nvenc', preset: 'p7' },
    avgVMAF: vmaf,
    avgVMAFMean: vmaf + 0.03,
    vmafP1Low: p1,
    minVMAF: p1 - 1,
    avgCAMBI: cambi,
    p95CAMBI: cambi,
    avgFileSizeMB: sizeMb,
    sampleCount: 3,
  };
}

function rejected(points, reason) {
  return points.map((p) => ({
    id: p.parameterSetId,
    cq: p.parameterSet.quality,
    reason,
    category: classifyToleranceRejection(reason),
  }));
}

// Quality-saturated HDR canary: measured quality is excellent at every CQ. The lower
// ratio/BPP/Mbps plausibility model is advisory, so all three remain in the
// normal target selector and its highest quality-passing CQ is 38. No descent.
const over = [
  point(28, 97.68, 92.11, 2.1, 12),
  point(33, 96.71, 90.42, 2.2, 8),
  point(38, 95.39, 89.04, 2.3, 5),
];
assert.ok(over.every((p) => measuredQualityPasses(p, 95, 86)));
assert.strictEqual(Math.max(...over.filter((p) => measuredQualityPasses(p, 95, 86))
  .map((p) => p.parameterSet.quality)), 38);

const source = fs.readFileSync(selectorPath, 'utf8');
const lowerBlock = source.slice(source.indexOf('var sharedSizeEvaluation'),
  source.indexOf('// Size gate (demoted'));
assert.ok(lowerBlock.includes('LOWER-SIZE PLAUSIBILITY ADVISORY'));
assert.ok(!/rejected\s*=\s*true/.test(lowerBlock),
  'lower ratio/BPP/Mbps plausibility must not reject a quality-passing measurement');
assert.ok(source.includes('lowerModelAdvisory ? cand.avgVMAF >= targetVMAF : lcb >= targetVMAF'),
  'lower-size advisory path must choose by measured VMAF/frame floors, not retry-producing LCB');

// Silo: CAMBI is the only miss and source CAMBI was unavailable. Choose the
// lowest measured CAMBI risk immediately, with highest CQ as the exact-risk tie-break.
const silo = [
  point(28, 98.79, 96.72, 6.62, 12),
  point(33, 98.14, 95.86, 6.70, 8),
  point(38, 97.20, 94.21, 6.87, 5),
];
let decision = chooseMeasuredToleranceFallback(silo, {
  targetVmaf: 95,
  frameFloor: 86,
  rejectedResults: rejected(silo, 'CAMBI banding risk 6.62 above floor 5.0'),
  terminal: false,
});
assert.ok(decision);
assert.strictEqual(decision.mode, 'cambi_only');
assert.strictEqual(decision.result.parameterSet.quality, 28);

const cambiTie = [point(28, 98.9, 96, 6.62, 12), point(33, 98.1, 95, 6.62, 8)];
decision = chooseMeasuredToleranceFallback(cambiTie, {
  targetVmaf: 95,
  frameFloor: 86,
  rejectedResults: rejected(cambiTie, 'Shared feasibility: cambiRisk 6.62 above 5.00'),
});
assert.strictEqual(decision.result.parameterSet.quality, 33);

// Upper size-model miss: select the smallest measured output, not the original source.
const oversize = [point(28, 98, 94, 2, 15), point(33, 97, 92, 2, 10), point(38, 95.5, 89, 2, 6)];
decision = chooseMeasuredToleranceFallback(oversize, {
  targetVmaf: 95,
  frameFloor: 86,
  rejectedResults: rejected(oversize, 'Projected output 120.0% of source (>= 110% emergency cutoff)'),
});
assert.strictEqual(decision.mode, 'oversize_only');
assert.strictEqual(decision.result.parameterSet.quality, 38);

// A true quality miss must NOT be promoted, terminal or not.
//
// This previously asserted the opposite: terminal=true shipped the highest-VMAF
// / lowest-CQ measurement (note the old expectation of quality === 16). Highest
// VMAF is always the lowest CQ and so the largest file, which meant a quality
// miss committed the most expensive encode available — one already rejected for
// missing the limit. In production that produced five outputs larger than their
// sources (up to 165% in the observed incident), all at CQ 16, all
// still sub-threshold, each destroying its original. Keeping the original is
// strictly better, so the selector now returns null and the existing "No
// parameter sets met quality thresholds" give-up path preserves the source.
const qualityMiss = [point(16, 93.7, 83, 3, 20), point(18, 93.1, 82, 3, 16)];
const qualityRejected = rejected(qualityMiss, 'Harmonic mean 93.70 below threshold 95');
assert.strictEqual(chooseMeasuredToleranceFallback(qualityMiss, {
  targetVmaf: 95, frameFloor: 86, rejectedResults: qualityRejected, terminal: false,
}), null);
assert.strictEqual(chooseMeasuredToleranceFallback(qualityMiss, {
  targetVmaf: 95, frameFloor: 86, rejectedResults: qualityRejected, terminal: true,
}), null, 'a terminal quality miss must preserve the original, not commit the largest encode');

// Missing mandatory measurement data is technical and may never be promoted.
const incomplete = point(16, 94, 84, 3, 20);
incomplete.avgVMAFMean = null;
assert.strictEqual(chooseMeasuredToleranceFallback([incomplete], {
  targetVmaf: 95,
  frameFloor: 86,
  rejectedResults: rejected([incomplete], 'missing mandatory metrics: vmafMean'),
  terminal: true,
}), null);

const missingStableId = point(16, 94, 84, 3, 20);
delete missingStableId.parameterSetId;
assert.strictEqual(chooseMeasuredToleranceFallback([missingStableId], {
  targetVmaf: 95,
  frameFloor: 86,
  rejectedResults: [{ id: '', reason: 'Harmonic mean below threshold', category: 'quality' }],
  terminal: true,
}), null, 'parameterSet.id must not substitute for a missing stable result parameterSetId');

const mismatchedId = point(16, 94, 84, 3, 20);
mismatchedId.parameterSet.id = 'gpu_p7_cq16_other';
assert.strictEqual(chooseMeasuredToleranceFallback([mismatchedId], {
  targetVmaf: 95,
  frameFloor: 86,
  rejectedResults: rejected([mismatchedId], 'Harmonic mean below threshold'),
  terminal: true,
}), null, 'result and parameter-set IDs must match exactly');

const mismatchedRejectionId = point(16, 94, 84, 3, 20);
assert.strictEqual(chooseMeasuredToleranceFallback([mismatchedRejectionId], {
  targetVmaf: 95,
  frameFloor: 86,
  rejectedResults: [{ id: 'different-result', reason: 'Harmonic mean below threshold', category: 'quality' }],
  terminal: true,
}), null, 'fallback requires an exact rejection entry for the measured result');

// Unavailable CAMBI must not make an otherwise complete GPU-only measurement
// "technical" (which would bar it from promotion entirely). This is now shown
// through the cambi_only path: the quality-miss path returns null regardless, so
// it can no longer distinguish "excluded as technical" from "quality miss".
const missingCambi = point(16, 96.4, 88, 3, 20);
missingCambi.avgCAMBI = null;
missingCambi.p95CAMBI = null;
const missingCambiDecision = chooseMeasuredToleranceFallback([missingCambi], {
  targetVmaf: 95,
  frameFloor: 86,
  rejectedResults: [{
    id: missingCambi.parameterSetId,
    cq: missingCambi.parameterSet.quality,
    reason: 'cambiRisk 5.49 above 5.00',
    category: 'cambi',
  }],
  terminal: true,
});
assert(missingCambiDecision && missingCambiDecision.result === missingCambi,
  'unavailable CAMBI must not make an otherwise complete GPU-only measurement technical');

const duplicateTechnical = point(16, 94, 84, 3, 20);
assert.strictEqual(chooseMeasuredToleranceFallback([duplicateTechnical], {
  targetVmaf: 95,
  frameFloor: 86,
  rejectedResults: [
    { id: duplicateTechnical.parameterSetId, reason: 'missing mandatory metrics: vmafMean', category: 'technical' },
    { id: duplicateTechnical.parameterSetId, reason: 'Harmonic mean below threshold', category: 'quality' },
  ],
  terminal: true,
}), null, 'any technical rejection for a duplicate ID must exclude that candidate');

assert.ok(source.includes('vmafToleranceFallbackDegraded = true'));
assert.match(source, /!args\.variables\.vmafToleranceFallbackActive\s*&&\s*shouldApplyFractionalOverride/);

console.log('PASS VMAF advisory fallback contract (Over, Silo, oversize, terminal quality, technical hard-stop)');
