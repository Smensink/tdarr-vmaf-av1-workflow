'use strict';

var POLICY_VERSION = 'delivered-minimum-reduction-v1';
var DEFAULT_TARGET_REDUCTION_PCT = 30;
var DEFAULT_MINIMUM_REDUCTION_PCT = 20;
var DEFAULT_MAX_FINAL_OUTPUT_RATIO_PCT = 80;

function hasOwn(value, key) {
  return Boolean(value) &&
    Object.prototype.hasOwnProperty.call(value, key);
}

function requireExactNumber(value, expected, label) {
  var number = Number(value);
  if (!isFinite(number)) throw new Error(label + ' must be finite');
  if (number !== expected) {
    throw new Error(label + ' must equal the current policy value ' + expected);
  }
  return expected;
}

function normalizeCompletePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('delivery size policy must be a complete object');
  }
  for (var i = 0; i < 4; i += 1) {
    var requiredKey = [
      'version',
      'targetReductionPct',
      'minimumReductionPct',
      'maxFinalOutputRatioPct',
    ][i];
    if (!hasOwn(policy, requiredKey)) {
      throw new Error('delivery size policy is missing required field ' + requiredKey);
    }
  }
  var version = String(policy.version || '').trim();
  if (version !== POLICY_VERSION) {
    throw new Error('unsupported size policy version: ' + version);
  }
  return {
    version: POLICY_VERSION,
    targetReductionPct: requireExactNumber(
      policy.targetReductionPct,
      DEFAULT_TARGET_REDUCTION_PCT,
      'target size reduction'),
    minimumReductionPct: requireExactNumber(
      policy.minimumReductionPct,
      DEFAULT_MINIMUM_REDUCTION_PCT,
      'minimum size reduction'),
    maxFinalOutputRatioPct: requireExactNumber(
      policy.maxFinalOutputRatioPct,
      DEFAULT_MAX_FINAL_OUTPUT_RATIO_PCT,
      'maximum final output ratio'),
  };
}

function requireCurrentPolicy(variablesOrPolicy) {
  var variableKeys = [
    'vmafSizePolicyVersion',
    'vmafTargetSizeReductionPct',
    'vmafMinimumSizeReductionPct',
    'vmafMaxFinalOutputRatioPct',
  ];
  var policyKeys = [
    'version',
    'targetReductionPct',
    'minimumReductionPct',
    'maxFinalOutputRatioPct',
  ];
  var hasVariableField = variableKeys.some(function (key) {
    return hasOwn(variablesOrPolicy, key);
  });
  var hasPolicyField = policyKeys.some(function (key) {
    return hasOwn(variablesOrPolicy, key);
  });
  if (hasVariableField && hasPolicyField) {
    throw new Error('delivery size policy cannot mix flow-variable and canonical fields');
  }
  return hasVariableField
    ? resolve(variablesOrPolicy)
    : normalizeCompletePolicy(variablesOrPolicy);
}

function resolve(variables) {
  if (variables === undefined || variables === null) variables = {};
  if (typeof variables !== 'object' || Array.isArray(variables)) {
    throw new Error('delivery size policy variables must be an object');
  }
  var target = hasOwn(variables, 'vmafTargetSizeReductionPct')
    ? requireExactNumber(
      variables.vmafTargetSizeReductionPct,
      DEFAULT_TARGET_REDUCTION_PCT,
      'target size reduction')
    : DEFAULT_TARGET_REDUCTION_PCT;
  var minimum = hasOwn(variables, 'vmafMinimumSizeReductionPct')
    ? requireExactNumber(
      variables.vmafMinimumSizeReductionPct,
      DEFAULT_MINIMUM_REDUCTION_PCT,
      'minimum size reduction')
    : DEFAULT_MINIMUM_REDUCTION_PCT;
  var cap = hasOwn(variables, 'vmafMaxFinalOutputRatioPct')
    ? requireExactNumber(
      variables.vmafMaxFinalOutputRatioPct,
      DEFAULT_MAX_FINAL_OUTPUT_RATIO_PCT,
      'maximum final output ratio')
    : DEFAULT_MAX_FINAL_OUTPUT_RATIO_PCT;
  var requestedVersion = hasOwn(variables, 'vmafSizePolicyVersion')
    ? String(variables.vmafSizePolicyVersion || '').trim()
    : POLICY_VERSION;
  if (requestedVersion !== POLICY_VERSION) {
    throw new Error('unsupported size policy version: ' + requestedVersion);
  }
  variables.vmafTargetSizeReductionPct = target;
  variables.vmafMinimumSizeReductionPct = minimum;
  variables.vmafMaxFinalOutputRatioPct = cap;
  variables.vmafSizePolicyVersion = POLICY_VERSION;
  return normalizeCompletePolicy({
    version: POLICY_VERSION,
    targetReductionPct: target,
    minimumReductionPct: minimum,
    maxFinalOutputRatioPct: cap,
  });
}

function evaluateBytes(outputBytes, sourceBytes, policy) {
  var output = Number(outputBytes);
  var source = Number(sourceBytes);
  if (!Number.isSafeInteger(output) || output <= 0) {
    throw new Error('delivery size policy requires a positive safe-integer output byte count');
  }
  if (!Number.isSafeInteger(source) || source <= 0) {
    throw new Error('delivery size policy requires a positive safe-integer source byte count');
  }
  // Byte evaluation accepts only the complete canonical policy returned by
  // resolve/requireCurrentPolicy. It must never default omitted policy fields.
  var effective = normalizeCompletePolicy(policy);
  var cap = effective.maxFinalOutputRatioPct;
  var ratio = (output / source) * 100;
  return {
    policyVersion: POLICY_VERSION,
    outputBytes: output,
    sourceBytes: source,
    ratioPct: ratio,
    actualReductionPct: 100 - ratio,
    capPct: cap,
    accepted: ratio <= cap,
    rejected: ratio > cap,
  };
}

module.exports = {
  POLICY_VERSION: POLICY_VERSION,
  DEFAULT_TARGET_REDUCTION_PCT: DEFAULT_TARGET_REDUCTION_PCT,
  DEFAULT_MINIMUM_REDUCTION_PCT: DEFAULT_MINIMUM_REDUCTION_PCT,
  DEFAULT_MAX_FINAL_OUTPUT_RATIO_PCT: DEFAULT_MAX_FINAL_OUTPUT_RATIO_PCT,
  requireCurrentPolicy: requireCurrentPolicy,
  resolve: resolve,
  evaluateBytes: evaluateBytes,
};
