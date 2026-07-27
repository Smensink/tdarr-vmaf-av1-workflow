'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vmafdb = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
const calculateVmaf = require(
  './custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js');
const selectBest = require(
  './custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js');
const dbPath = path.join(os.tmpdir(), `vmafdb-cambi-timing-${process.pid}.db`);
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(dbPath + suffix); } catch (_) {}
}
const db = vmafdb.openDb(dbPath);
assert.strictEqual(vmafdb.SCHEMA_VERSION, 15);
assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 15);
const sweepColumns = new Set(db.prepare('PRAGMA table_info(sweep_points)').all().map((row) => row.name));
const jobColumns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((row) => row.name));
for (const column of ['cambi_time_sec', 'measurement_disposition']) assert(sweepColumns.has(column), column);
for (const column of [
  'source_cambi_time_sec', 'holdout_encode_time_sec', 'holdout_vmaf_time_sec',
  'holdout_candidate_cambi_time_sec', 'holdout_source_cambi_time_sec',
]) assert(jobColumns.has(column), column);

vmafdb.upsertJob(db, {
  job_id: 'timing-job',
  reference_contract_id: 'ref-current',
  metric_contract_id: 'metric-current',
  encoder_profile_id: 'encoder-current',
  source_cambi_time_sec: 12.5,
  holdout_encode_time_sec: 3.25,
  holdout_vmaf_time_sec: 4.5,
  holdout_candidate_cambi_time_sec: 5.75,
  holdout_source_cambi_time_sec: 6.0,
});
const inserted = vmafdb.insertSweepPoints(db, 'timing-job', [{
  parameter_set_id: 'cq30', cq: 30,
  reference_contract_id: 'ref-current',
  metric_contract_id: 'metric-current',
  encoder_profile_id: 'encoder-current',
  vmaf_time_sec: 10,
  cambi_time_sec: 11,
  measured_work_time_sec: 21,
  measurement_disposition: 'measured_full_current_contract',
}]);
assert.strictEqual(inserted, 1);
const sweep = db.prepare('SELECT cambi_time_sec, measurement_disposition FROM sweep_points WHERE job_id = ?').get('timing-job');
assert.strictEqual(sweep.cambi_time_sec, 11);
assert.strictEqual(sweep.measurement_disposition, 'measured_full_current_contract');
const job = db.prepare(`SELECT source_cambi_time_sec, holdout_encode_time_sec, holdout_vmaf_time_sec,
  holdout_candidate_cambi_time_sec, holdout_source_cambi_time_sec FROM jobs WHERE job_id = ?`).get('timing-job');
assert.strictEqual(job.source_cambi_time_sec, 12.5);
assert.strictEqual(job.holdout_encode_time_sec, 3.25);
assert.strictEqual(job.holdout_vmaf_time_sec, 4.5);
assert.strictEqual(job.holdout_candidate_cambi_time_sec, 5.75);
assert.strictEqual(job.holdout_source_cambi_time_sec, 6);

const calculateTiming = {};
assert.strictEqual(calculateVmaf._test.accumulateTimingSeconds(
  calculateTiming, 'vmafSourceCambiTimeSec', 1.25), 1.25);
assert.strictEqual(calculateVmaf._test.accumulateTimingSeconds(
  calculateTiming, 'vmafSourceCambiTimeSec', 2.5), 3.75,
  'source CAMBI subprocess durations must accumulate across authenticated clips/rounds');
assert.strictEqual(calculateVmaf._test.accumulateTimingSeconds(
  calculateTiming, 'vmafSourceCambiTimeSec', NaN), 3.75,
  'invalid timing samples must not corrupt accumulated telemetry');

const holdoutTiming = {};
for (const [key, value] of [
  ['vmafHoldoutEncodeTimeSec', 1.1],
  ['vmafHoldoutVmafTimeSec', 2.2],
  ['vmafHoldoutCandidateCambiTimeSec', 3.3],
  ['vmafHoldoutSourceCambiTimeSec', 4.4],
]) {
  assert.strictEqual(selectBest._test.accumulateTimingSeconds(holdoutTiming, key, value), value);
  assert.strictEqual(selectBest._test.accumulateTimingSeconds(holdoutTiming, key, value), value * 2,
    `${key} must accumulate when selection runs more than one authoritative holdout`);
}

const calculateSource = fs.readFileSync('./custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js', 'utf8');
const selectSource = fs.readFileSync('./custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js', 'utf8');
const exportSource = fs.readFileSync('./custom-cont-init.d/vmaf-plugin-patches/exportVMAFResults/1.0.0/index.js', 'utf8');
assert(calculateSource.includes('cambiTimeSecTotal'));
assert(calculateSource.includes("accumulateTimingSeconds(args.variables, 'vmafSourceCambiTimeSec'"));
for (const field of [
  'vmafHoldoutEncodeTimeSec', 'vmafHoldoutVmafTimeSec',
  'vmafHoldoutCandidateCambiTimeSec', 'vmafHoldoutSourceCambiTimeSec',
]) assert(selectSource.includes(field), field);
for (const mapping of [
  'source_cambi_time_sec: optionalNonnegativeSeconds(args.variables.vmafSourceCambiTimeSec)',
  'holdout_encode_time_sec: optionalNonnegativeSeconds(args.variables.vmafHoldoutEncodeTimeSec)',
  'holdout_vmaf_time_sec: optionalNonnegativeSeconds(args.variables.vmafHoldoutVmafTimeSec)',
  'holdout_candidate_cambi_time_sec: optionalNonnegativeSeconds(args.variables.vmafHoldoutCandidateCambiTimeSec)',
  'holdout_source_cambi_time_sec: optionalNonnegativeSeconds(args.variables.vmafHoldoutSourceCambiTimeSec)',
]) assert(exportSource.includes(mapping), mapping);
assert(exportSource.includes('cambi_time_sec: isFinite(_ct) ? _ct : null'));
assert(exportSource.includes("aggregate.measurementDisposition === 'paired_cq_inferred_v1'"));
assert(exportSource.includes('isOrdinaryMeasuredAggregate(_ar)'));
assert(exportSource.includes("measurementDisposition || 'measured_full_current_contract'"));

db.close();
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(dbPath + suffix); } catch (_) {}
}
console.log('PASS CAMBI/source/holdout timing schema');
