'use strict';

const assert = require('assert');
const shadow = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/emptyBandShadow.js');

function point(cq, mean, p1, cambi, ratio) {
  return { parameterSet: { quality: cq }, avgVMAFMean: mean, vmafP1Low: p1,
    p95CAMBI: cambi, projectedOutputRatioPct: ratio };
}
const policy = { targetVmaf: 95, vmafP1Floor: 86, cambiLimit: 5, maxOutputRatioPct: 100 };

const lowestMeasuredFailsButLegalLowerCqsRemain = shadow.assess(
  [point(20, 96, 85, 4, 110), point(24, 94, 83, 6, 90)], policy);
assert.strictEqual(lowestMeasuredFailsButLegalLowerCqsRemain.provenEmpty, false,
  'quality failure above the legal CQ floor does not prove lower, higher-quality CQs fail');

const legalFloorFails = shadow.assess(
  [point(16, 96, 85, 4, 110), point(20, 94, 83, 6, 90)], policy);
assert.strictEqual(legalFloorFails.provenEmpty, true);
assert.strictEqual(legalFloorFails.proof.type, 'quality_failed_at_legal_cq_floor');

const crossing = shadow.assess([point(27.9, 96, 87, 4, 101), point(28.0, 94, 85, 6, 99)], policy);
assert.strictEqual(crossing.provenEmpty, true);
assert.strictEqual(crossing.proof.type, 'adjacent_size_quality_crossing');

const possibleBand = shadow.assess([point(27, 96, 87, 4, 101), point(28, 94, 85, 6, 99)], policy);
assert.strictEqual(possibleBand.provenEmpty, false, 'a one-CQ gap is not a discrete proof');

const feasible = shadow.assess([point(27.9, 96, 87, 4, 99), point(28.0, 94, 85, 6, 90)], policy);
assert.strictEqual(feasible.provenEmpty, false);
assert.strictEqual(feasible.feasiblePoints, 1);
console.log('PASS multi-constraint empty-band shadow helper');
