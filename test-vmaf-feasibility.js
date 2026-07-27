'use strict';

const assert = require('assert');
const feasibility = require('./plugins/vmaf/_lib/feasibility.js');

const policy = {
  targetVmaf: 95,
  vmafMetric: 'mean',
  requireVmafHarmonic: true,
  vmafP1Floor: 87,
  cambiLimit: 5.5,
};

function result(overrides) {
  return Object.assign({
    parameterSet: { quality: 30 },
    avgVMAF: 95.5,
    avgVMAFMean: 96,
    vmafP1Low: 89,
    p95CAMBI: 4,
  }, overrides || {});
}

assert.strictEqual(feasibility.evaluate(result(), policy).status, 'feasible');

const missingP1 = result({ vmafP1Low: null });
assert.strictEqual(feasibility.evaluate(missingP1, policy).status, 'unknown');
assert.ok(feasibility.evaluate(missingP1, policy).missing.includes('vmafP1Low'));

const missingMean = result({ avgVMAFMean: null });
assert.strictEqual(feasibility.evaluate(missingMean, policy).status, 'unknown');
assert.ok(feasibility.evaluate(missingMean, policy).missing.includes('vmafMean'));

const missingCambi = result({ p95CAMBI: null });
assert.strictEqual(feasibility.evaluate(missingCambi, policy).status, 'unknown');
assert.ok(feasibility.evaluate(missingCambi, policy).missing.includes('cambiRisk'));

assert.strictEqual(feasibility.evaluate(result({ avgVMAFMean: 94.9 }), policy).status, 'infeasible');
assert.strictEqual(feasibility.evaluate(result({ vmafP1Low: 86.9 }), policy).status, 'infeasible');
assert.strictEqual(feasibility.evaluate(result({ p95CAMBI: 5.6 }), policy).status, 'infeasible');

const sizePolicy = {
  minOutputRatioPct: 20,
  minOutputBpp: 0.03,
  minOutputMbps: 2,
  maxOutputRatioPct: 90,
};
assert.strictEqual(feasibility.evaluate({
  projectedOutputRatioPct: 50,
  projectedOutputBpp: 0.05,
  projectedOutputMbps: 4,
}, sizePolicy).status, 'feasible');
assert.strictEqual(feasibility.evaluate({
  projectedOutputRatioPct: 90,
  projectedOutputBpp: 0.05,
  projectedOutputMbps: 4,
}, sizePolicy).status, 'infeasible');
assert.strictEqual(feasibility.evaluate({}, sizePolicy).status, 'unknown');

const sourceRelative = feasibility.effectiveCambiLimit({ sourceCambiP95: 7, cambiTolerance: 1 });
assert.strictEqual(sourceRelative, 8);

console.log('PASS shared VMAF feasibility evaluator (11 cases)');
