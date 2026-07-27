'use strict';

const assert = require('assert');
const path = require('path');

const root = __dirname;
const encoding = require(path.join(root,
  'custom-cont-init.d/vmaf-plugin-patches/testEncodingParameters/1.0.0/index.js'));
const calculate = require(path.join(root,
  'custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js'));

const hardest = encoding._test.getHardestSampleIndices(
  { 0: 96.1, 1: 91.2, 2: 94.0, 4: 92.5 }, 5, 3);
assert.deepStrictEqual(hardest, [1, 4, 2], 'sentinel must use the lowest prior VMAF clips');
assert.deepStrictEqual(
  encoding._test.getHardestSampleIndices({ 0: 90 }, 4, 3),
  [0],
  'caller must be able to detect insufficient prior hardness coverage');

const clearFailure = encoding._test.shouldEncodeHardAbort([90, 91, 92], 95, 1);
assert.strictEqual(clearFailure.abort, true, 'a CI clearly below target-minus-margin should abort');
assert(clearFailure.ciUpper <= 94);

const nearBoundary = encoding._test.shouldEncodeHardAbort([93, 94, 95], 95, 1);
assert.strictEqual(nearBoundary.abort, false, 'a boundary CQ must continue encoding');

const insufficient = encoding._test.shouldEncodeHardAbort([90], 95, 1);
assert.strictEqual(insufficient.abort, false, 'one sentinel cannot support the CI decision');

const valid = [
  { parameterSetId: 'cq30', sampleIndex: 0, outputPath: '/tmp/a' },
  { parameterSetId: 'cq30', sampleIndex: 1, outputPath: '/tmp/b' },
  { parameterSetId: 'cq32', sampleIndex: 0, outputPath: '/tmp/c' },
];
const precomputed = [
  { parameterSetId: 'cq30', sampleIndex: 0, vmafScore: 93.2 },
  { parameterSetId: 'cq32', sampleIndex: 0, vmafScore: 90.1 },
  { parameterSetId: 'stale', sampleIndex: 4, vmafScore: 99 },
  { parameterSetId: 'cq30', sampleIndex: 1, vmafScore: null },
];
const split = calculate._test.splitPrecomputedVmafResults(valid, precomputed);
assert.deepStrictEqual(
  split.reused.map((item) => `${item.parameterSetId}:${item.sampleIndex}`),
  ['cq30:0', 'cq32:0'],
  'only valid, matching precomputed results should be reused');
assert.deepStrictEqual(
  split.pending.map((item) => `${item.parameterSetId}:${item.sampleIndex}`),
  ['cq30:1'],
  'unmeasured results must stay pending');

const hardAbortInput = encoding.details().inputs.find((input) => input.name === 'encodeHardAbort');
assert(hardAbortInput, 'encodeHardAbort input must be declared');
assert.strictEqual(hardAbortInput.defaultValue, 'false', 'feature must remain disabled by default');
assert.strictEqual(
  encoding.details().inputs.find((input) => input.name === 'encodeHardAbortK').defaultValue,
  '4',
  'replay-safe sentinel size must remain the default');
assert.strictEqual(
  encoding.details().inputs.find((input) => input.name === 'encodeHardAbortMargin').defaultValue,
  '1.5',
  'replay-safe decision margin must remain the default');

console.log('PASS encode-side hard-abort contract');
