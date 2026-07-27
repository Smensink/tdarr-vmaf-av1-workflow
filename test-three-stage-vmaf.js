'use strict';

const assert = require('assert');
const bracket = require('./custom-cont-init.d/vmaf-plugin-patches/checkCQBracket/1.0.0/index.js');
const calculate = require('./custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js');

const inputs = Object.fromEntries(bracket.details().inputs.map((input) => [input.name, input]));
assert.strictEqual(inputs.threeStageVmaf.defaultValue, 'false');
assert.strictEqual(inputs.intermediateVmafSubsample.defaultValue, '2');

const choose = bracket._test.chooseRefinementSubsample;
assert.strictEqual(choose({ inputs: { threeStageVmaf: false }, variables: {} }), 1);
assert.strictEqual(choose({ inputs: { threeStageVmaf: true }, variables: {} }), 1,
  'no holdout must retain full-rate refinement');
assert.strictEqual(choose({ inputs: { threeStageVmaf: true, intermediateVmafSubsample: 2 },
  variables: { vmafHoldoutSample: { path: '/tmp/holdout.mkv' } } }), 2);
assert.strictEqual(choose({ inputs: { threeStageVmaf: false, intermediateVmafSubsample: 3 },
  variables: { vmafThreeStageSubsample: true, vmafHoldoutSample: { path: '/tmp/holdout.mkv' } } }), 3);
assert.strictEqual(choose({ inputs: { threeStageVmaf: true },
  variables: { vmafThreeStageSubsample: false, vmafHoldoutSample: { path: '/tmp/holdout.mkv' } } }), 1);
assert.strictEqual(choose({ inputs: { threeStageVmaf: true, intermediateVmafSubsample: 99 },
  variables: { vmafHoldoutSample: { path: '/tmp/holdout.mkv' } } }), 4);

const calculateSource = require('fs').readFileSync(
  './custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js', 'utf8');
// 2026-07-21: measurementSubsample changed from the invocation-global setting (which
// mislabelled rows carried over from earlier rounds) to the per-set coarsest row stamp.
// The contract is now: the sole GPU result-push site stamps r.nSubsample, and the
// aggregate reports the max stamp (unstamped legacy rows count as full-rate 1).
// CPU VMAF result-push sites were intentionally removed from the production path.
assert.ok(calculateSource.includes('measurementSubsample: item._maxNSubsample || 1'));
assert.strictEqual((calculateSource.match(/\.nSubsample = getVmafSubsampleInt\(args\)/g) || []).length, 1,
  'the sole GPU VMAF result-push site must stamp nSubsample');
assert.doesNotMatch(calculateSource, /buildCpuVmafCommand|processBatch\(/,
  'three-stage measurement must not retain a CPU VMAF fallback');
assert.ok(calculate.details().inputs.some((input) => input.name === 'vmafSubsample'));

console.log('PASS three-stage VMAF schedule contract');
