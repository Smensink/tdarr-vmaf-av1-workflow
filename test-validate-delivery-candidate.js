'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-delivery-candidate-'));
const workDir = path.join(root, 'work');
const source = path.join(root, 'source.mkv');
fs.mkdirSync(workDir);
fs.writeFileSync(source, Buffer.alloc(1000, 0x41));

const originalLoad = Module._load;
const upserts = [];
Module._load = function mockRuntime(request, parent, isMain) {
  if (request === '../../../../../methods/lib') {
    return () => ({ loadDefaultValues(inputs) { return inputs || {}; } });
  }
  if (request === '/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js') {
    return {
      openDb() { return {}; },
      makeJobId() { return 'derived-job'; },
      upsertJob(db, fields) { upserts.push({ ...fields }); },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const validator = require(
  './plugins/vmaf/validateDeliveryCandidate/1.0.0/index.js');

function argsFor(candidate, variables) {
  const logs = [];
  const checkpointKey = 'a'.repeat(64);
  return {
    inputFileObj: { _id: candidate },
    originalLibraryFile: { _id: source },
    workDir,
    inputs: {},
    variables: {
      vmafCanonicalJobId: 'job-1',
      vmafOriginalFile: source,
      vmafPostEncodeCheckpoint: { checkpoint_key: checkpointKey },
      vmafDeliveryOutcomePending: {
        schema: 'vmaf-delivery-outcome-pending/v1',
        version: 1,
        status: 'candidate_ready',
        database_recorded: true,
        job_id: 'job-1',
        checkpoint_key: checkpointKey,
        source_path: source,
        size_policy_version: 'delivered-minimum-reduction-v1',
        target_size_reduction_pct: 30,
        minimum_size_reduction_pct: 20,
        max_final_output_ratio_pct: 80,
      },
      ...(variables || {}),
    },
    jobLog(message) { logs.push(String(message)); },
    logs,
  };
}

try {
  const exact = path.join(workDir, 'exact.mkv');
  fs.writeFileSync(exact, Buffer.alloc(800, 0x42));
  const exactArgs = argsFor(exact);
  const accepted = validator.plugin(exactArgs);
  assert.strictEqual(accepted.outputNumber, 1);
  assert.strictEqual(exactArgs.variables.vmafDeliveryCandidateRejected, false);
  assert.strictEqual(
    exactArgs.variables.vmafDeliveryCandidateValidation.output_ratio_pct,
    80,
  );
  assert.strictEqual(
    exactArgs.variables.vmafDeliveryCandidateValidation.schema,
    'vmaf-delivery-candidate-validation/v1',
  );
  assert.strictEqual(exactArgs.variables.vmafDeliveryCandidateValidation.job_id, 'job-1');
  assert.strictEqual(
    exactArgs.variables.vmafDeliveryCandidateValidation.checkpoint_key,
    'a'.repeat(64),
  );
  assert.match(
    exactArgs.variables.vmafDeliveryCandidateValidation.candidate.sha256_full,
    /^[0-9a-f]{64}$/,
  );
  assert.match(
    exactArgs.variables.vmafDeliveryCandidateValidation.source.sha256_full,
    /^[0-9a-f]{64}$/,
  );

  const over = path.join(workDir, 'over.mkv');
  fs.writeFileSync(over, Buffer.alloc(801, 0x43));
  const overArgs = argsFor(over);
  const rejected = validator.plugin(overArgs);
  assert.strictEqual(rejected.outputNumber, 2);
  assert.strictEqual(overArgs.variables.vmafTranscodeStatus,
    'keep_original_delivery_size_policy');
  assert.strictEqual(fs.existsSync(source), true);
  assert.strictEqual(upserts.length, 1);
  assert.strictEqual(upserts[0].job_id, 'job-1');
  assert.strictEqual(upserts[0].transcode_succeeded, 0);
  assert.strictEqual(upserts[0].met_size_target, 0);
  assert.strictEqual(upserts[0].outcome_stage, 'keep_original');
  assert.strictEqual(upserts[0].max_final_output_ratio_pct, 80);
  assert.strictEqual(upserts[0].final_output_ratio_pct, null,
    'a rejected candidate is not a delivered final output');

  const outside = path.join(root, 'outside.mkv');
  fs.writeFileSync(outside, Buffer.alloc(700, 0x44));
  assert.throws(() => validator.plugin(argsFor(outside)), /outside the canonical job workDir/);

  const alias = path.join(workDir, 'hard-link.mkv');
  fs.linkSync(source, alias);
  assert.throws(() => validator.plugin(argsFor(alias)), /aliases the original/);

  const missingPending = argsFor(exact);
  delete missingPending.variables.vmafDeliveryOutcomePending;
  assert.throws(() => validator.plugin(missingPending),
    /durable candidate-ready proof/);

  assert.throws(() => validator.plugin(argsFor(exact, {
    vmafMinimumSizeReductionPct: 20,
    vmafMaxFinalOutputRatioPct: 90,
  })), /must equal the current policy value 80/);

  const mirrors = [
    'plugins/vmaf/validateDeliveryCandidate/1.0.0/index.js',
    'custom-cont-init.d/vmaf-plugin-patches/validateDeliveryCandidate/1.0.0/index.js',
  ].map((file) => fs.readFileSync(path.join(__dirname, file)));
  assert(mirrors[0].equals(mirrors[1]));
  console.log('PASS delivery candidate exact-byte boundary, containment, alias, and DB rejection');
} finally {
  Module._load = originalLoad;
  fs.rmSync(root, { recursive: true, force: true });
}
