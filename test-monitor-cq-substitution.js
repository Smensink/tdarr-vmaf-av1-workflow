'use strict';

const assert = require('assert');
const monitor = require(
  './custom-cont-init.d/vmaf-plugin-patches/monitorTranscodeRetry/1.0.0/index.js'
);

function makeVariables() {
  const parameterSet = {
    id: 'gpu_p7_cq28',
    quality: 28,
    encoder: 'av1_nvenc',
    preset: 'p7',
    pixFmt: 'p010le',
    outputWidth: 3840,
    outputHeight: 1600,
  };
  return {
    vmafAggregatedResults: [{
      parameterSetId: 'gpu_p7_cq28',
      parameterSet,
      avgVMAF: 98.7885565,
      minVMAF: 95.339997,
      vmafP1Low: 95.339997,
      avgCAMBI: 1.75,
      avgFileSizeMB: 1.266494,
      sampleCount: 4,
      measurementOrigin: 'current_job',
      measurementJobId: 'job-current',
    }],
    vmafPostEncodeCqSubstitution: {
      schema: 'vmaf_postencode_cq_substitution_v1',
      contract_id: 'vmaf-conservative-postencode-cq-substitution-v1',
      policy: 'cq_only_conservative',
      requested_cq: 37.2,
      actual_cq: 28,
      relation: 'identical_except_lower_cq',
      conservative: true,
      no_encode: true,
      current_measurement: {
        parameter_set_id: 'gpu_p7_cq28',
        avg_vmaf: 98.7885565,
        min_vmaf: 95.339997,
        p1_vmaf: 95.339997,
        avg_cambi: 1.75,
        avg_sample_size_mb: 1.266494,
        sample_count: 4,
        measurement_origin: 'current_job',
        measurement_job_id: 'job-current',
        parameter_set_contract_sha256:
          monitor._test.measurementParameterContractSha256(parameterSet),
      },
    },
    vmafPostEncodeCheckpoint: {
      checkpoint_key: 'a'.repeat(64),
    },
    vmafOriginalFile: 'C:/media/source.mkv',
    vmafFinalOutputRatioPct: 75,
    vmafFinalOutputSizeMB: 900,
  };
}

const resolved = monitor._test.resolveConservativeCqSubstitution(makeVariables());
assert.strictEqual(resolved.requestedCQ, 37.2);
assert.strictEqual(resolved.actualCQ, 28);
assert.deepStrictEqual(resolved.fields, {
  selected_cq: 28,
  selected_parameter_set_id: 'gpu_p7_cq28',
  selected_vmaf: 98.7885565,
  selected_vmaf_min: 95.339997,
  selected_cambi: 1.75,
  selected_size_mb: 1.266494,
});

const noAudit = makeVariables();
delete noAudit.vmafPostEncodeCqSubstitution;
assert.strictEqual(monitor._test.resolveConservativeCqSubstitution(noAudit), null);

const lessConservative = makeVariables();
lessConservative.vmafPostEncodeCqSubstitution.actual_cq = 40;
assert.throws(
  () => monitor._test.resolveConservativeCqSubstitution(lessConservative),
  /not strictly conservative/
);

const mismatchedMeasurement = makeVariables();
mismatchedMeasurement.vmafPostEncodeCqSubstitution.current_measurement.avg_vmaf = 97;
assert.throws(
  () => monitor._test.resolveConservativeCqSubstitution(mismatchedMeasurement),
  /measurement mismatch for avg_vmaf/
);

const priorJobMeasurement = makeVariables();
priorJobMeasurement.vmafAggregatedResults[0].reusedFromJobId = 'job-prior';
assert.throws(
  () => monitor._test.resolveConservativeCqSubstitution(priorJobMeasurement),
  /absent from the current sweep/
);

const wrongResolution = makeVariables();
wrongResolution.vmafAggregatedResults[0].parameterSet.outputWidth = 1920;
assert.throws(
  () => monitor._test.resolveConservativeCqSubstitution(wrongResolution),
  /absent from the current sweep/
);

const noCambiMeasurement = makeVariables();
delete noCambiMeasurement.vmafAggregatedResults[0].avgCAMBI;
noCambiMeasurement.vmafPostEncodeCqSubstitution.current_measurement.avg_cambi = null;
assert.strictEqual(
  monitor._test.resolveConservativeCqSubstitution(noCambiMeasurement).fields.selected_cambi,
  null
);

const Module = require('module');
const originalLoad = Module._load;
const upserts = [];
let persistedJob = null;
const dbMock = {
  prepare() {
    return {
      get() {
        return persistedJob && { ...persistedJob };
      },
    };
  },
};
Module._load = function mockMonitorDependencies(request, parent, isMain) {
  if (request === '../../../../../methods/lib') {
    return () => ({
      loadDefaultValues(inputs) {
        return inputs || {};
      },
    });
  }
  if (request === '/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js') {
    return {
      openDb() {
        return dbMock;
      },
      upsertJob(db, fields) {
        upserts.push({ ...fields });
        persistedJob = { ...(persistedJob || {}), ...fields };
      },
      makeJobId() {
        return 'unexpected-derived-job-id';
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const variables = makeVariables();
  variables.vmafTranscodeStatus = 'success';
  variables.vmafTranscodeSucceeded = true;
  variables.vmafCanonicalJobId = 'job-current';
  variables.vmafSizeFailureShadowPrediction = { prediction_id: 'prediction-cq37.2' };
  const logs = [];
  const result = monitor.plugin({
    inputFileObj: { _id: 'C:/media/source.mkv' },
    inputs: {},
    variables,
    jobLog(message) {
      logs.push(String(message));
    },
  });

  assert.strictEqual(result.outputNumber, 2);
  assert.strictEqual(upserts.length, 1);
  assert.strictEqual(upserts[0].job_id, 'job-current');
  assert.strictEqual(upserts[0].selected_cq, 28);
  assert.strictEqual(upserts[0].selected_parameter_set_id, 'gpu_p7_cq28');
  assert.strictEqual(upserts[0].selected_vmaf, 98.7885565);
  assert.strictEqual(upserts[0].selected_vmaf_min, 95.339997);
  assert.strictEqual(upserts[0].selected_cambi, 1.75);
  assert.strictEqual(upserts[0].selected_size_mb, 1.266494);
  assert.strictEqual(upserts[0].transcode_succeeded, null);
  assert.strictEqual(upserts[0].outcome_stage, 'candidate_ready');
  assert.strictEqual(upserts[0].size_target_status, 'pending_delivery');
  assert.strictEqual(upserts[0].max_final_output_ratio_pct, 80);
  assert.strictEqual(variables.vmafPostEncodeCqSubstitution.requested_cq, 37.2);
  assert.strictEqual(variables.vmafSizeFailureShadowOutcomeRecorded, undefined,
    'pre-delivery candidate success must not publish a terminal shadow label');
  assert.strictEqual(variables.vmafDeliveryOutcomePending.status, 'candidate_ready');
  assert.strictEqual(variables.vmafPostEncodeCqSubstitutionDbOutcome.recorded, true);
  assert.ok(logs.some((line) => line.includes(
    'using conservative retained checkpoint substitution'
  )));
  assert.ok(!logs.some((line) => line.includes('Size-failure shadow outcome excluded')),
    'shadow outcome must wait for delivered-file finalization');
  assert.ok(!logs.some((line) => line.includes('no retries needed')));
} finally {
  Module._load = originalLoad;
}

console.log('PASS monitor conservative CQ substitution bookkeeping (8 cases)');
