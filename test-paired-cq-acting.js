'use strict';

const assert = require('assert');
const fs = require('fs');
const paired = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/pairedCqShadow.js');
const calculate = require(
  './custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js'
);
const history = require(
  './custom-cont-init.d/vmaf-plugin-patches/_lib/currentContractMeasurementHistory.js'
);
const exporter = require(
  './custom-cont-init.d/vmaf-plugin-patches/exportVMAFResults/1.0.0/index.js'
);

const calculateInputs = Object.fromEntries(calculate.details().inputs.map((input) => [input.name, input]));
assert.strictEqual(calculateInputs.vmafPairedCqActingEnabled.defaultValue, 'false');
assert.strictEqual(calculate._test.resolvePairedCqActingEnabled({ inputs: {}, variables: {} }), false);
assert.strictEqual(calculate._test.resolvePairedCqActingEnabled({
  inputs: { vmafPairedCqActingEnabled: true, pairedCqShadowForceFull: false }, variables: {},
}), true);
assert.strictEqual(calculate._test.resolvePairedCqActingEnabled({
  inputs: { vmafPairedCqActingEnabled: true, pairedCqShadowForceFull: true }, variables: {},
}), false, 'force-full audit is a hard interlock against actual inference');
assert.strictEqual(calculate._test.resolvePairedCqActingEnabled({
  inputs: { vmafPairedCqActingEnabled: true, pairedCqShadowForceFull: false },
  variables: { vmafPairedCqActingEnabled: false },
}), false, 'variable kill switch must override the plugin input');

const unresolvedPolicy = calculate._test.resolvePairedCqActingPolicy({
  variables: { vmafMetricContractId: 'vmaf-v1.0.16-cpu-float-native10-integrated-cambi-v1-sdr-standard' },
});
assert.strictEqual(unresolvedPolicy.eligible, false);
assert(unresolvedPolicy.reasons.includes('missing_frame_floor_policy'));
assert(unresolvedPolicy.reasons.includes('missing_source_cambi_policy'));

const exactEffectivePolicy = calculate._test.resolvePairedCqActingPolicy({
  variables: { vmafMetricContractId: 'vmaf-v1.0.16-cpu-float-native10-integrated-cambi-v1-sdr-standard' },
}, {
  selectorPolicyVersion: 'selector-authoritative-v2',
  targetVmaf: 95,
  vmafP1Floor: 85.5,
  cambiLimit: 6.25,
});
assert.strictEqual(exactEffectivePolicy.eligible, true,
  'force-full telemetry must be able to bind the exact locally effective policy before selector publication');
const [policyPrefix, policyJson] = exactEffectivePolicy.policy.policyId.split('|', 2);
assert.strictEqual(policyPrefix, 'paired_cq_acting_policy_v1');
assert.deepStrictEqual(JSON.parse(policyJson), {
  selectorPolicyVersion: 'selector-authoritative-v2',
  targetVmaf: 95,
  vmafP1Floor: 85.5,
  cambiLimit: 6.25,
  harmonicMargin: 0.25,
  p1Margin: 0.5,
  cambiMargin: 0.25,
  vmafScoreMax: 110,
});

function tasks(id, cq, count = 8, options = {}) {
  const preset = options.preset || 'p7';
  return Array.from({ length: count }, (_, sampleIndex) => ({
    parameterSetId: id,
    parameterSet: {
      id,
      encoder: options.encoder || 'av1_nvenc',
      preset,
      quality: cq,
      pixFmt: 'p010le',
    },
    sampleIndex,
    outputPath: `/tmp/${id}-${sampleIndex}.mkv`,
    originalSamplePath: `/tmp/ref-${sampleIndex}.mkv`,
    fileSizeMB: 2 + sampleIndex / 10,
  }));
}

const easier = tasks('cq28', 28);
const harder = tasks('cq30', 30);
const unrelated = tasks('cq34', 34);
const all = easier.concat(harder, unrelated);
const plan = paired.planActingQueue(all, all, [], { sampleCount: 8 });
assert.strictEqual(plan.eligible, true);
assert.strictEqual(plan.previousId, 'cq28');
assert.strictEqual(plan.currentId, 'cq30');
assert.strictEqual(plan.cqGap, 2);
assert.deepStrictEqual(plan.anchorIndices, [0, 2, 3, 4, 6, 7]);
assert.strictEqual(plan.stageOneTasks.length, 14,
  'the easier CQ must be complete before acting and the harder CQ must measure six anchors');
assert.strictEqual(plan.remainingTasks.length, 10);
assert.strictEqual(plan.currentNonanchorTasks.length, 2);
assert(plan.stageOneTasks.slice(0, 8).every((task) => task.parameterSetId === 'cq28'));
assert.deepStrictEqual(
  plan.stageOneTasks.slice(8).map((task) => task.sampleIndex),
  plan.anchorIndices,
);

const tooShort = paired.planActingQueue(
  tasks('short28', 28, 7).concat(tasks('short30', 30, 7)),
  tasks('short28', 28, 7).concat(tasks('short30', 30, 7)),
  [],
  { sampleCount: 7 },
);
assert.strictEqual(tooShort.eligible, false);
assert(tooShort.reasons.includes('sample_count_below_8'));

const mismatchedEncoder = tasks('other30', 30, 8, { preset: 'p6' });
const encoderMismatch = paired.planActingQueue(
  easier.concat(mismatchedEncoder), easier.concat(mismatchedEncoder), [], { sampleCount: 8 },
);
assert.strictEqual(encoderMismatch.eligible, false);
assert(encoderMismatch.reasons.includes('no_exact_encoder_adjacent_pair'));

const precomputedNonanchor = [{
  parameterSetId: 'cq30', sampleIndex: 1, vmafScore: 96, vmafP1: 93,
  cambiMean: 2, cambiP95: 2.5, nSubsample: 4,
}];
const pendingWithoutPrecomputed = all.filter((task) =>
  !(task.parameterSetId === 'cq30' && task.sampleIndex === 1));
const precomputedRejected = paired.planActingQueue(
  all, pendingWithoutPrecomputed, precomputedNonanchor, { sampleCount: 8 },
);
assert.strictEqual(precomputedRejected.eligible, false);
assert(precomputedRejected.reasons.includes('current_nonanchor_already_measured'));

const identity = {
  metricContractId: 'metric-v1',
  referenceContractId: 'reference-v1',
  encoderProfileId: `encoder-v1|${plan.encoderIdentity}`,
  measurementSubsample: 4,
  policyId: 'paired-policy-v1',
  inferenceAuthorityContractId: 'paired-cq-vmaf-v1-cambi-inference-authority-v1',
  };
function measuredRow(task, delta) {
  const base = 98 - task.sampleIndex * 0.25 + delta;
  return Object.assign({}, task, {
    nSubsample: 4,
    vmafScore: base,
    vmafMean: base + 0.1,
    vmafP1: base - 2,
    vmafMin: base - 3,
    vmafMax: base + 1,
    cambiMean: 2 + task.sampleIndex * 0.05 - delta / 2,
    cambiP95: 2.4 + task.sampleIndex * 0.05 - delta / 2,
    vmafTimeSec: 1,
    cambiTimeSec: 2,
  });
}
const stagedRows = easier.map((task) => measuredRow(task, 0))
  .concat(plan.stageOneTasks.slice(8).map((task) => measuredRow(task, -0.5)));
const partial = paired.buildMeasuredPartial(plan, stagedRows, identity);
assert.strictEqual(partial.eligible, true);
assert.strictEqual(partial.previous.evidenceDisposition, 'measured_full_current_contract');
assert.strictEqual(partial.currentAnchors.evidenceDisposition, 'measured_anchor_current_contract');
assert.deepStrictEqual(partial.currentAnchors.clipSampleIndices, plan.anchorIndices);

const reconstruction = paired.reconstructPartial(partial.previous, partial.currentAnchors, {
  anchorCount: 6,
  maxCqGap: 2,
  targetVmaf: 94,
  vmafP1Floor: 93,
  cambiLimit: 5,
  harmonicMargin: 0.25,
  p1Margin: 0.5,
  cambiMargin: 0.25,
});
assert.strictEqual(reconstruction.eligible, true);
assert.strictEqual(reconstruction.actingSafe, true);
assert.strictEqual(reconstruction.reconstructed.measurementDisposition, 'paired_cq_inferred_v1');
assert.strictEqual(reconstruction.reconstructed.inferredClipCount, 2);

const wrongSubsampleRows = stagedRows.map((row) => Object.assign({}, row));
wrongSubsampleRows[0].nSubsample = 1;
const wrongSubsample = paired.buildMeasuredPartial(plan, wrongSubsampleRows, identity);
assert.strictEqual(wrongSubsample.eligible, false);
assert(wrongSubsample.reasons.includes('measurement_subsample_mismatch'));

const unsafe = paired.reconstructPartial(partial.previous, partial.currentAnchors, {
  anchorCount: 6,
  maxCqGap: 2,
  targetVmaf: 99,
  vmafP1Floor: 98,
  cambiLimit: 2.5,
  harmonicMargin: 0.25,
  p1Margin: 0.5,
  cambiMargin: 0.25,
});
assert.strictEqual(unsafe.eligible, true);
assert.strictEqual(unsafe.actingSafe, false,
  'failed conservative margins must force the scheduler to measure every remaining task');

const inferredAggregate = Object.assign({}, reconstruction.reconstructed, {
  parameterSetId: plan.currentId,
  parameterSet: harder[0].parameterSet,
});
assert.strictEqual(exporter._test.isOrdinaryMeasuredAggregate(inferredAggregate), false);
assert.strictEqual(exporter._test.isOrdinaryMeasuredAggregate({
  parameterSetId: 'cq28', measurementDisposition: 'measured_full_current_contract',
}), true);
assert.throws(() => history.mergeCurrentMeasurements(null, {
  jobId: 'job', sourcePath: '/media/source.mkv', referenceContractId: 'reference-v1',
}, [inferredAggregate]), /inferred paired-CQ/,
'current-contract history must reject inferred evidence even if a caller forgets to filter it');

const measuredAggregate = {
  parameterSetId: 'cq28',
  parameterSet: { quality: 28 },
  avgVMAF: 97,
};
const publishArgs = {
  inputFileObj: { _id: '/media/source.mkv' },
  variables: { vmafCanonicalJobId: 'job' },
};
const published = calculate._test.publishMeasuredAndInferredAggregates(
  publishArgs, 'reference-v1', [measuredAggregate, {
    parameterSetId: 'cq30', parameterSet: { quality: 30 }, avgVMAF: 96,
  }], inferredAggregate,
);
assert.deepStrictEqual(
  publishArgs.variables.vmafCurrentContractMeasurementHistory.points.map((row) => row.parameterSetId),
  ['cq28'],
  'neither the anchor-only aggregate nor the inferred replacement may enter measured history',
);
assert.strictEqual(published.find((row) => row.parameterSetId === 'cq30').measurementDisposition,
  'paired_cq_inferred_v1');

const source = fs.readFileSync(
  'custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js', 'utf8');
assert.match(source, /maxParallelMetric = hasCpuV1 \? maxParallelCpuV1\(args\) : maxParallelGpu/);
assert.match(source, /Math\.min\(maxParallelMetric, queue\.length\)/,
  'acting stages must retain bounded backend-specific parallelism');
assert.match(source, /measurePreFgsCambiAsync[\s\S]*runOptionalSsimAsync/,
  'the unchanged production worker must remain GPU VMAF -> CPU CAMBI -> optional SSIM');
assert.match(source, /hasCpuV1[\s\S]*calculateSingleVmafV1CpuAsync/,
  'the qualification worker must use the separately bounded integrated CPU-v1 topology');
assert.doesNotMatch(source, /vmafHoldoutSample\s*=/,
  'the acting scheduler must not mutate or bypass the downstream full-rate holdout');

console.log('PASS paired-CQ default-off acting scheduler integration');
