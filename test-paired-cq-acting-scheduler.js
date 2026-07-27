'use strict';
const assert = require('assert');
const fs = require('fs');
const shadow = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/pairedCqShadow.js');

function tasks(id, quality) {
  return Array.from({ length: 8 }, (_, sampleIndex) => ({
    parameterSetId: id,
    sampleIndex,
    parameterSet: { quality, preset: 'p7', tune: 'hq' },
    fileSizeMB: 10 - quality / 10,
  }));
}
const all = tasks('cq28', 28).concat(tasks('cq30', 30));
const plan = shadow.planActingQueue(all, all, [], { sampleCount: 8 });
assert.strictEqual(plan.eligible, true);
assert.strictEqual(plan.previousId, 'cq28');
assert.strictEqual(plan.currentId, 'cq30');
assert.deepStrictEqual(plan.anchorIndices, [0, 2, 3, 4, 6, 7]);
assert.strictEqual(plan.stageOneTasks.length, 14);
assert.strictEqual(plan.currentNonanchorTasks.length, 2);
assert.strictEqual(plan.remainingTasks.length, 2);

const short = shadow.planActingQueue(all.slice(0, 12), all.slice(0, 12), [], { sampleCount: 6 });
assert.strictEqual(short.eligible, false);
assert(short.reasons.includes('sample_count_below_8'));

const mismatched = tasks('cq28', 28).concat(tasks('cq30', 30).map((task) => ({
  ...task,
  parameterSet: { ...task.parameterSet, preset: 'p6' },
})));
const mismatchPlan = shadow.planActingQueue(mismatched, mismatched, [], { sampleCount: 8 });
assert.strictEqual(mismatchPlan.eligible, false);
assert(mismatchPlan.reasons.includes('no_exact_encoder_adjacent_pair'));

const priorVmaf = [98, 97.5, 97, 96.5, 96, 95.5, 95, 94.5];
const currentVmaf = priorVmaf.map((value) => value - 0.5);
const priorCambi = [2, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7];
const currentCambi = priorCambi.map((value) => value + 0.2);
const identity = {
  metricContractId: 'metric-current',
  referenceContractId: 'reference-current',
  encoderProfileId: 'encoder-current',
  measurementSubsample: 4,
  policyId: 'paired-policy-current',
  inferenceAuthorityContractId: 'paired-cq-vmaf-v1-cambi-inference-authority-v1',
};
function row(task) {
  const previous = task.parameterSetId === 'cq28';
  const i = task.sampleIndex;
  const vmafScore = (previous ? priorVmaf : currentVmaf)[i];
  const cambiMean = (previous ? priorCambi : currentCambi)[i];
  return {
    ...task,
    vmafScore,
    vmafMean: vmafScore,
    vmafP1: vmafScore - 2,
    cambiMean,
    cambiP95: cambiMean + 0.1,
    nSubsample: 4,
    vmafTimeSec: 1,
    cambiTimeSec: 2,
  };
}
const measuredStageOne = plan.stageOneTasks.map(row);
const partial = shadow.buildMeasuredPartial(plan, measuredStageOne, identity);
assert.strictEqual(partial.eligible, true);
const reconstructed = shadow.reconstructPartial(partial.previous, partial.currentAnchors, {
  anchorCount: 6,
  maxCqGap: 2,
  targetVmaf: 94,
  vmafP1Floor: 91,
  cambiLimit: 5,
  harmonicMargin: 0.25,
  p1Margin: 0.5,
  cambiMargin: 0.25,
});
assert.strictEqual(reconstructed.eligible, true);
assert.strictEqual(reconstructed.actingSafe, true);
assert.strictEqual(reconstructed.reconstructed.inferredClipCount, 2);
assert.strictEqual(reconstructed.reconstructed.measurementDisposition, 'paired_cq_inferred_v1');

const wrongSubsample = measuredStageOne.map((item, index) => index === 0 ? { ...item, nSubsample: 1 } : item);
const rejectedPartial = shadow.buildMeasuredPartial(plan, wrongSubsample, identity);
assert.strictEqual(rejectedPartial.eligible, false);
assert(rejectedPartial.reasons.includes('measurement_subsample_mismatch'));

const source = fs.readFileSync('./custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js', 'utf8');
const exporter = fs.readFileSync('./custom-cont-init.d/vmaf-plugin-patches/exportVMAFResults/1.0.0/index.js', 'utf8');
assert(source.includes("name: 'vmafPairedCqActingEnabled'"));
assert(source.includes("defaultValue: 'false'"));
assert(source.includes('pairedActingPlan.stageOneTasks.slice()'));
assert(source.includes('pairedCqShadow.buildMeasuredPartial'));
assert(source.includes('pairedCqShadow.reconstructPartial'));
assert(source.includes('pairedActingPlan.currentNonanchorTasks'));
assert(source.includes('publishMeasuredAndInferredAggregates'));
assert(source.includes("measurementDisposition: 'paired_cq_inferred_v1'"));
assert(exporter.includes("aggregate.measurementDisposition === 'paired_cq_inferred_v1'"));
assert(exporter.includes('isOrdinaryMeasuredAggregate(_ar)'));

console.log('PASS default-off paired-CQ acting queue, reconstruction, fallback, and persistence guards');
