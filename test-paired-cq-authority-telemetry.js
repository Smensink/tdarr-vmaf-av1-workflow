'use strict';
const assert = require('assert');
const exporter = require('./custom-cont-init.d/vmaf-plugin-patches/exportVMAFResults/1.0.0/index.js');

const identity = {
  metricContractId: 'metric-v1-4k-sdr',
  referenceContractId: 'reference-v1',
  encoderProfileId: 'encoder-v1',
  measurementSubsample: 1,
  policyId: 'selector_authoritative_harmonic_v4_inference_authority',
  inferenceAuthorityContractId: 'paired-cq-vmaf-v1-cambi-inference-authority-v1',
};
const variables = {
  vmafCanonicalJobId: 'job-a',
  vmafPairedCqActingOutcome: {
    schema: 4,
    action: 'paired_cq_inferred_v1',
    previousParameterSetId: 'cq28',
    currentParameterSetId: 'cq30',
    measurementIdentity: identity,
    measuredClipCount: 6,
    inferredClipCount: 2,
    skippedMetricCalls: 2,
    conservativeCiMargins: { harmonic: 0.8, p1: 0.4, cambi: 0.3 },
    confidence95Halfwidth: { harmonic: 0.1, p1: 0.2, cambiMean: 0.1, cambiP95: 0.1 },
    estimatedMetricSecondsSaved: 12.5,
  },
  vmafAuthoritativeHoldoutOutcome: {
    passed: true,
    directlyMeasured: true,
    metricContractId: identity.metricContractId,
    referenceContractId: identity.referenceContractId,
    vmaf: 96,
    p1: 90,
    cambiMean: 2,
    cambiP95: 3,
  },
};
const record = exporter._test.buildPairedCqAuthorityRecord(variables);
assert.strictEqual(record.schema, 4);
assert.strictEqual(record.decision.action, 'predicted_safe');
assert.strictEqual(record.eligibleForPromotion, true);
assert.strictEqual(record.falseSafe, false);
assert.strictEqual(record.measurementCounts.measuredClipCount, 6);
assert.strictEqual(record.measurementCounts.inferredClipCount, 2);
assert.strictEqual(record.estimatedMetricSecondsSaved, 12.5);
assert.strictEqual(record.realizedMetricSecondsSaved, null,
  'estimated skipped work must not masquerade as realized counterfactual timing');

const missingAuthority = JSON.parse(JSON.stringify(variables));
delete missingAuthority.vmafPairedCqActingOutcome.measurementIdentity.inferenceAuthorityContractId;
const excluded = exporter._test.buildPairedCqAuthorityRecord(missingAuthority);
assert.strictEqual(excluded.eligibleForPromotion, false);
assert(excluded.exclusionReasons.includes('incomplete_measurement_identity'));

const wrongHoldout = JSON.parse(JSON.stringify(variables));
wrongHoldout.vmafAuthoritativeHoldoutOutcome.metricContractId = 'other';
const mismatched = exporter._test.buildPairedCqAuthorityRecord(wrongHoldout);
assert.strictEqual(mismatched.eligibleForPromotion, false);
assert.strictEqual(mismatched.holdoutOutcome, null);

const failed = JSON.parse(JSON.stringify(variables));
failed.vmafAuthoritativeHoldoutOutcome.passed = false;
const falseSafe = exporter._test.buildPairedCqAuthorityRecord(failed);
assert.strictEqual(falseSafe.eligibleForPromotion, true,
  'a labelled false-safe is promotion evidence, though it vetoes promotion in the reviewer');
assert.strictEqual(falseSafe.falseSafe, true);

const fallback = JSON.parse(JSON.stringify(variables));
fallback.vmafPairedCqActingOutcome.action = 'fallback_full';
fallback.vmafPairedCqActingOutcome.conservativeCiMargins = {};
const fallbackRecord = exporter._test.buildPairedCqAuthorityRecord(fallback);
assert.strictEqual(fallbackRecord.decision.action, 'fallback_full');
assert.strictEqual(fallbackRecord.eligibleForPromotion, false);
assert.strictEqual(fallbackRecord.falseSafe, null);
assert.strictEqual(exporter._test.buildPairedCqAuthorityRecord({}), null);

const calculateSource = require('fs').readFileSync(
  './custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js', 'utf8');
for (const token of ['conservativeCiMargins', 'estimatedMetricSecondsSaved',
  'confidence95Halfwidth', 'inferenceAuthorityContractId', 'forceFullCounterfactual',
  'holdoutOutcome', 'decisionId']) assert(calculateSource.includes(token), token);
assert(calculateSource.includes('force-full switch is a hard promotion interlock'));

console.log('PASS paired-CQ schema-v4 inference-authority publication and holdout binding');
