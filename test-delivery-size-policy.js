'use strict';

const assert = require('assert');
const fs = require('fs');
const policy = require('./plugins/vmaf/_lib/deliveryPolicy.js');
const deployed = require(
  './custom-cont-init.d/vmaf-plugin-patches/_lib/deliveryPolicy.js');

for (const implementation of [policy, deployed]) {
  const variables = {};
  const resolved = implementation.resolve(variables);
  assert.deepStrictEqual(resolved, {
    version: 'delivered-minimum-reduction-v1',
    targetReductionPct: 30,
    minimumReductionPct: 20,
    maxFinalOutputRatioPct: 80,
  });
  assert.strictEqual(variables.vmafMaxFinalOutputRatioPct, 80);
  assert.strictEqual(variables.vmafTargetSizeReductionPct, 30);
  assert.strictEqual(variables.vmafMinimumSizeReductionPct, 20);
  assert.strictEqual(
    variables.vmafSizePolicyVersion,
    'delivered-minimum-reduction-v1');
  assert.deepStrictEqual(implementation.requireCurrentPolicy({
    version: 'delivered-minimum-reduction-v1',
    targetReductionPct: '30',
    minimumReductionPct: '20',
    maxFinalOutputRatioPct: '80',
  }), resolved, 'a complete exact policy must normalize to numeric canonical fields');
  assert.deepStrictEqual(implementation.requireCurrentPolicy({
    vmafSizePolicyVersion: 'delivered-minimum-reduction-v1',
    vmafTargetSizeReductionPct: '30',
    vmafMinimumSizeReductionPct: '20',
    vmafMaxFinalOutputRatioPct: '80',
  }), resolved, 'the strict helper must also normalize exact flow-variable fields');
  assert.strictEqual(implementation.evaluateBytes(800, 1000, resolved).accepted, true,
    'the exact 80% boundary must be accepted');
  assert.strictEqual(implementation.evaluateBytes(801, 1000, resolved).rejected, true);
  assert.strictEqual(implementation.evaluateBytes(799, 1000, resolved).accepted, true);
  assert.throws(() => implementation.resolve({
    vmafMinimumSizeReductionPct: 20,
    vmafMaxFinalOutputRatioPct: 90,
  }), /must equal the current policy value 80/);
  assert.throws(() => implementation.resolve({
    vmafTargetSizeReductionPct: 10,
    vmafMinimumSizeReductionPct: 20,
  }), /must equal the current policy value 30/);
  assert.throws(() => implementation.resolve({
    vmafTargetSizeReductionPct: 25,
    vmafMinimumSizeReductionPct: 10,
    vmafMaxFinalOutputRatioPct: 90,
  }), /must equal the current policy value/,
  'a different internally consistent policy triple must be rejected');
  assert.throws(() => implementation.resolve({
    vmafSizePolicyVersion: 'unknown-policy',
  }), /unsupported size policy/);
  assert.throws(() => implementation.resolve(''), /variables must be an object/);
  assert.throws(() => implementation.resolve({
    vmafTargetSizeReductionPct: '',
  }), /must equal the current policy value 30/,
  'an explicitly provided empty value must not silently select the default');
  assert.throws(() => implementation.requireCurrentPolicy({
    version: 'delivered-minimum-reduction-v1',
    maxFinalOutputRatioPct: 80,
  }), /missing required field targetReductionPct/,
  'a versioned partial policy must fail closed');
  assert.throws(() => implementation.requireCurrentPolicy({
    version: 'delivered-minimum-reduction-v1',
    vmafTargetSizeReductionPct: 30,
  }), /cannot mix flow-variable and canonical fields/);
  assert.throws(() => implementation.evaluateBytes(800, 1000, {
    version: 'delivered-minimum-reduction-v1',
    maxFinalOutputRatioPct: 90,
  }), /missing required field targetReductionPct/,
  'byte evaluation must never trust a versioned partial policy');
  assert.throws(() => implementation.evaluateBytes(800, 1000, {
    version: 'delivered-minimum-reduction-v1',
    targetReductionPct: 30,
    minimumReductionPct: 10,
    maxFinalOutputRatioPct: 90,
  }), /must equal the current policy value 20/,
  'byte evaluation must validate every field in a complete policy');
  assert.throws(() => implementation.evaluateBytes(0, 1000, resolved), /output byte count/);
}

const testEncodingSource = fs.readFileSync(
  'plugins/vmaf/testEncodingParameters/1.0.0/index.js', 'utf8');
const testEncodingMirror = fs.readFileSync(
  'custom-cont-init.d/vmaf-plugin-patches/testEncodingParameters/1.0.0/index.js',
  'utf8');
assert.strictEqual(testEncodingSource, testEncodingMirror,
  'test-encoding source and deployment mirror differ');
assert(testEncodingSource.includes(
  'args.variables.vmafTargetSizeReductionPct = targetSizeReduction;'
), 'the search stage must publish its validated target reduction');
assert(testEncodingSource.includes(
  "targetSizeReduction !== deliveryPolicy.DEFAULT_TARGET_REDUCTION_PCT"
), 'an invalid explicit search target must fail closed');
assert(testEncodingSource.includes(
  "targetSizeReduction must equal the current policy value"
), 'the search-stage validation must describe the fixed current target');

const selectorSource = fs.readFileSync(
  'plugins/vmaf/selectBestParameters/1.0.0/index.js', 'utf8');
const selectorMirror = fs.readFileSync(
  'custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js',
  'utf8');
assert.strictEqual(selectorSource, selectorMirror,
  'selector source and deployment mirror differ');
assert(selectorSource.includes("defaultValue: '20'"),
  'the selector default must match the 20% delivered minimum');
assert(selectorSource.includes(
  'args.variables.vmafMinimumSizeReductionPct = minSizeReduction;'
), 'the selector must publish its validated delivered minimum');
assert(selectorSource.includes(
  'minSizeReduction !== deliveryPolicy.DEFAULT_MINIMUM_REDUCTION_PCT'
), 'the selector must reject a non-current delivered minimum');
assert(selectorSource.includes(
  'var selectedDeliveryPolicy = deliveryPolicy.resolve(args.variables);'
), 'the selector must reconcile search and delivery policy before selection');

console.log('PASS delivery size policy is one explicit 30% target / 20% minimum / 80% cap');
