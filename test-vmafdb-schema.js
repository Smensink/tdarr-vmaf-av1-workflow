'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const dbModule = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
const metricContracts = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/vmafMetricContract.js');
const referenceContractBridge = require(
  './custom-cont-init.d/vmaf-plugin-patches/_lib/referenceContractBridge.js');

const currentMetric = metricContracts.PRODUCTION_STANDARD_METRIC_CONTRACT_ID;
const currentEncoder = metricContracts.COMPARISON_ENCODER_PROFILE_ID;

const dbPath = path.join(os.tmpdir(), `vmafdb-schema-${process.pid}-${Date.now()}.db`);
const migrationPath = path.join(os.tmpdir(), `vmafdb-migration-${process.pid}-${Date.now()}.db`);
const mismatchMigrationPath = path.join(os.tmpdir(), `vmafdb-mismatch-${process.pid}-${Date.now()}.db`);
try {
  const db = dbModule.openDb(dbPath);
  assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 15);

  const sweepColumns = new Set(db.prepare('PRAGMA table_info(sweep_points)').all().map((row) => row.name));
  const jobColumns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((row) => row.name));
  for (const column of ['clip_vmaf_means', 'clip_vmaf_p1s']) assert(sweepColumns.has(column));
  for (const column of ['cambi_time_sec', 'measurement_disposition']) assert(sweepColumns.has(column));
  assert(sweepColumns.has('reference_contract_id'));
  assert(sweepColumns.has('metric_contract_id'));
  assert(sweepColumns.has('encoder_profile_id'));
  for (const column of ['effective_frame_floor', 'effective_cambi_limit', 'selector_policy_version']) {
    assert(jobColumns.has(column));
  }
  for (const column of [
    'source_cambi_time_sec', 'holdout_encode_time_sec', 'holdout_vmaf_time_sec',
    'holdout_candidate_cambi_time_sec', 'holdout_source_cambi_time_sec',
  ]) assert(jobColumns.has(column));
  assert(jobColumns.has('reference_contract_id'));
  assert(jobColumns.has('metric_contract_id'));
  assert(jobColumns.has('encoder_profile_id'));
  const triggers = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger'"
  ).all().map((row) => row.name));
  for (const trigger of [
    'trg_jobs_contract_insert_consistency',
    'trg_jobs_contract_update_immutable',
    'trg_sweep_contract_insert_consistency',
    'trg_sweep_contract_update_consistency',
    'trg_jobs_metric_contract_required',
    'trg_jobs_encoder_profile_required',
    'trg_jobs_metric_contract_update_immutable',
    'trg_jobs_encoder_profile_update_immutable',
    'trg_sweep_measurement_contract_insert_consistency',
    'trg_sweep_measurement_contract_update_consistency',
  ]) assert(triggers.has(trigger));

  dbModule.upsertJob(db, {
    job_id: 'job-1',
    effective_frame_floor: 86,
    effective_cambi_limit: 5,
    selector_policy_version: 'selector-authoritative-v2',
    reference_contract_id: 'canonical-hqdn3d-v1',
    metric_contract_id: currentMetric,
    encoder_profile_id: currentEncoder,
    file_path: '/media/current.mkv',
    media_title: 'Current Title',
    transcode_succeeded: 1,
  });
  dbModule.insertSweepPoints(db, 'job-1', [{
    parameter_set_id: 'cq30',
    cq: 30,
    reference_contract_id: 'canonical-hqdn3d-v1',
    metric_contract_id: currentMetric,
    encoder_profile_id: currentEncoder,
    vmaf_mean: 95,
    clip_vmafs: [95],
    clip_vmaf_means: [96],
    clip_vmaf_p1s: [88],
    clip_cambis: { mean: [1], p95: [2] },
  }]);
  const row = db.prepare(
    'SELECT clip_vmaf_means, clip_vmaf_p1s, metric_contract_id, encoder_profile_id FROM sweep_points WHERE job_id = ?'
  ).get('job-1');
  assert.deepStrictEqual(JSON.parse(row.clip_vmaf_means), [96]);
  assert.deepStrictEqual(JSON.parse(row.clip_vmaf_p1s), [88]);
  assert.strictEqual(row.metric_contract_id, currentMetric);
  assert.strictEqual(row.encoder_profile_id, currentEncoder);

  assert.throws(() => dbModule.upsertJob(db, {
    job_id: 'job-1', reference_contract_id: null,
  }), /cannot change reference contract/);
  assert.throws(() => dbModule.upsertJob(db, {
    job_id: 'job-1', metric_contract_id: 'other-metric',
  }), /cannot change metric contract/);
  assert.throws(() => dbModule.upsertJob(db, {
    job_id: 'job-1', encoder_profile_id: 'other-encoder',
  }), /cannot change encoder profile/);
  assert.strictEqual(db.prepare(
    'SELECT reference_contract_id FROM jobs WHERE job_id = ?'
  ).get('job-1').reference_contract_id, 'canonical-hqdn3d-v1');
  dbModule.upsertJob(db, { job_id: 'job-1', transcode_succeeded: 1 });
  dbModule.upsertJob(db, {
    job_id: 'job-1',
    source_cambi_time_sec: 12.5,
    holdout_encode_time_sec: 3.25,
    holdout_vmaf_time_sec: 4.5,
    holdout_candidate_cambi_time_sec: 5.75,
    holdout_source_cambi_time_sec: 6,
  });
  dbModule.upsertJob(db, { job_id: 'job-1', transcode_retry_count: 2 });
  const persistedTiming = db.prepare(`SELECT source_cambi_time_sec, holdout_encode_time_sec,
    holdout_vmaf_time_sec, holdout_candidate_cambi_time_sec, holdout_source_cambi_time_sec
    FROM jobs WHERE job_id = ?`).get('job-1');
  assert.deepStrictEqual(Object.assign({}, persistedTiming), {
    source_cambi_time_sec: 12.5,
    holdout_encode_time_sec: 3.25,
    holdout_vmaf_time_sec: 4.5,
    holdout_candidate_cambi_time_sec: 5.75,
    holdout_source_cambi_time_sec: 6,
  }, 'later partial DB updates must preserve every source/holdout timing component');
  const inheritedContracts = db.prepare(
    'SELECT reference_contract_id, metric_contract_id, encoder_profile_id FROM jobs WHERE job_id = ?'
  ).get('job-1');
  assert.strictEqual(inheritedContracts.reference_contract_id, 'canonical-hqdn3d-v1');
  assert.strictEqual(inheritedContracts.metric_contract_id, currentMetric);
  assert.strictEqual(inheritedContracts.encoder_profile_id, currentEncoder,
    'partial current-job updates must inherit every immutable contract field');

  const beforeRejectedBatch = db.prepare(
    'SELECT COUNT(*) AS n FROM sweep_points WHERE job_id = ?'
  ).get('job-1').n;
  assert.throws(() => dbModule.insertSweepPoints(db, 'job-1', [
    { parameter_set_id: 'matching', cq: 31, reference_contract_id: 'canonical-hqdn3d-v1',
      metric_contract_id: currentMetric, encoder_profile_id: currentEncoder, vmaf_mean: 95 },
    { parameter_set_id: 'mismatch', cq: 32, reference_contract_id: null,
      metric_contract_id: currentMetric, encoder_profile_id: currentEncoder, vmaf_mean: 94 },
  ]), /reference contract mismatch/);
  assert.strictEqual(db.prepare(
    'SELECT COUNT(*) AS n FROM sweep_points WHERE job_id = ?'
  ).get('job-1').n, beforeRejectedBatch, 'mismatched batch must be rejected before any row is inserted');
  assert.throws(() => dbModule.insertSweepPoints(db, 'missing-parent', [{
    parameter_set_id: 'orphan', cq: 30, reference_contract_id: null, vmaf_mean: 95,
  }]), /existing parent job/);

  dbModule.upsertJob(db, { job_id: 'legacy-null-job', reference_contract_id: null });
  dbModule.upsertJob(db, {
    job_id: 'legacy-null-job',
    reference_contract_id: 'legacy-original-tf4-v1',
    tier: '1080p',
  });
  const labelledLegacyJob = db.prepare(
    'SELECT metric_contract_id, encoder_profile_id FROM jobs WHERE job_id = ?'
  ).get('legacy-null-job');
  assert.strictEqual(labelledLegacyJob.metric_contract_id, dbModule.LEGACY_METRIC_CONTRACT_ID);
  assert.strictEqual(labelledLegacyJob.encoder_profile_id, dbModule.LEGACY_ENCODER_PROFILE_ID);
  assert.strictEqual(db.prepare(
    'SELECT reference_contract_id FROM jobs WHERE job_id = ?'
  ).get('legacy-null-job').reference_contract_id, null,
  'same logical legacy contract must preserve the historical NULL representation');
  assert.throws(() => dbModule.upsertJob(db, {
    job_id: 'legacy-null-job', reference_contract_id: 'canonical-hqdn3d-v1',
  }), /cannot change reference contract/);
  const canonicalCurves = dbModule.getSimilarSweepCurves(db, {}, {
    limit: 10, referenceContractId: 'canonical-hqdn3d-v1',
    metricContractId: currentMetric, encoderProfileId: currentEncoder,
  });
  assert.strictEqual(canonicalCurves.length, 1);
  assert.strictEqual(canonicalCurves[0].reference_contract_id, 'canonical-hqdn3d-v1');
  assert.strictEqual(dbModule.getSimilarSweepCurves(db, {}, {
    limit: 10, referenceContractId: 'legacy-original-tf4-v1',
  }).length, 0);
  dbModule.upsertJob(db, { job_id: 'job-1', tier: 'SD' });
  assert.strictEqual(dbModule.getSimilarSweepCurves(db, { tier: 'sd' }, {
    limit: 10, referenceContractId: 'canonical-hqdn3d-v1',
    metricContractId: currentMetric, encoderProfileId: currentEncoder,
  }).length, 1, 'tier matching must preserve historical uppercase SD rows');

  dbModule.upsertJob(db, {
    job_id: 'job-other-metric',
    timestamp: '2026-01-02T00:00:00.000Z',
    file_path: '/media/current.mkv',
    media_title: 'Current Title',
    tier: 'SD',
    reference_contract_id: 'canonical-hqdn3d-v1',
    metric_contract_id: 'other-metric',
    encoder_profile_id: currentEncoder,
    transcode_succeeded: 1,
  });
  dbModule.insertSweepPoints(db, 'job-other-metric', [{
    parameter_set_id: 'cq31', cq: 31, vmaf_mean: 94,
    reference_contract_id: 'canonical-hqdn3d-v1',
    metric_contract_id: 'other-metric', encoder_profile_id: currentEncoder,
  }]);
  dbModule.upsertJob(db, {
    job_id: 'job-other-encoder',
    timestamp: '2026-01-03T00:00:00.000Z',
    file_path: '/media/current.mkv',
    media_title: 'Current Title',
    tier: 'SD',
    reference_contract_id: 'canonical-hqdn3d-v1',
    metric_contract_id: currentMetric,
    encoder_profile_id: 'other-encoder',
    transcode_succeeded: 1,
  });
  dbModule.insertSweepPoints(db, 'job-other-encoder', [{
    parameter_set_id: 'cq32', cq: 32, vmaf_mean: 93,
    reference_contract_id: 'canonical-hqdn3d-v1',
    metric_contract_id: currentMetric, encoder_profile_id: 'other-encoder',
  }]);
  const exactOpts = {
    limit: 10,
    referenceContractId: 'canonical-hqdn3d-v1',
    metricContractId: currentMetric,
    encoderProfileId: currentEncoder,
  };
  assert.strictEqual(dbModule.getSimilarSweepCurves(db, { tier: 'SD' }, exactOpts).length, 1,
    'similar-curve reads must not mix metric or encoder identities');
  assert.strictEqual(dbModule.getSameFileSweepCurves(db, '/media/current.mkv', exactOpts).length, 1,
    'same-file reads must not mix metric or encoder identities');
  assert.strictEqual(dbModule.getSimilarJobs(db, { tier: 'SD' }, exactOpts).length, 1,
    'job priors must not mix metric or encoder identities');
  assert.strictEqual(dbModule.getSameTitleOutcomes(db, {
    media_title: 'Current Title',
    tier: 'SD',
    metric_contract_id: currentMetric,
    encoder_profile_id: currentEncoder,
  }, exactOpts).length, 1, 'same-title outcomes must not mix metric or encoder identities');
  db.close();

  // Exercise the actual production upgrade path: historical v11 rows have no
  // contract column and must remain queryable only as legacy after v12 migration.
  const v11 = new DatabaseSync(migrationPath);
  const legacyJobColumns = dbModule.JOB_COLUMNS.filter((column) =>
    !['reference_contract_id', 'metric_contract_id', 'encoder_profile_id'].includes(column));
  const legacySweepColumns = dbModule.SWEEP_COLUMNS.filter((column) =>
    !['reference_contract_id', 'metric_contract_id', 'encoder_profile_id'].includes(column));
  v11.exec(`CREATE TABLE jobs (${legacyJobColumns.map((column) =>
    column === 'job_id' ? 'job_id TEXT PRIMARY KEY' : `${column} TEXT`).join(', ')})`);
  v11.exec(`CREATE TABLE sweep_points (id INTEGER PRIMARY KEY AUTOINCREMENT, ${legacySweepColumns
    .map((column) => `${column} TEXT`).join(', ')})`);
  v11.prepare('INSERT INTO jobs (job_id, timestamp, tier) VALUES (?, ?, ?)')
    .run('legacy-job', '2026-01-01T00:00:00.000Z', '1080p');
  v11.prepare('INSERT INTO sweep_points (job_id, parameter_set_id, cq, vmaf_mean) VALUES (?, ?, ?, ?)')
    .run('legacy-job', 'legacy-cq30', 30, 95);
  v11.exec('PRAGMA user_version = 11');
  v11.close();

  const migrated = dbModule.openDb(migrationPath);
  assert.strictEqual(migrated.prepare('PRAGMA user_version').get().user_version, 15);
  const migratedPoint = migrated.prepare(
    'SELECT reference_contract_id, metric_contract_id, encoder_profile_id FROM sweep_points WHERE job_id = ?'
  ).get('legacy-job');
  assert.strictEqual(migratedPoint.reference_contract_id, null);
  assert.strictEqual(migratedPoint.metric_contract_id, dbModule.LEGACY_METRIC_CONTRACT_ID);
  assert.strictEqual(migratedPoint.encoder_profile_id, dbModule.LEGACY_ENCODER_PROFILE_ID);
  const migratedJob = migrated.prepare(
    'SELECT metric_contract_id, encoder_profile_id FROM jobs WHERE job_id = ?'
  ).get('legacy-job');
  assert.strictEqual(migratedJob.metric_contract_id, dbModule.LEGACY_METRIC_CONTRACT_ID);
  assert.strictEqual(migratedJob.encoder_profile_id, dbModule.LEGACY_ENCODER_PROFILE_ID);
  const migratedLegacyCurves = dbModule.getSimilarSweepCurves(migrated, { tier: '1080p' }, {
    limit: 10, referenceContractId: 'legacy-original-tf4-v1',
    metricContractId: dbModule.LEGACY_METRIC_CONTRACT_ID,
    encoderProfileId: dbModule.LEGACY_ENCODER_PROFILE_ID,
  });
  assert.strictEqual(migratedLegacyCurves.length, 1);
  const bridgeSeedRows = referenceContractBridge.sanitizeLegacyRows(migratedLegacyCurves, {
    legacyWeight: referenceContractBridge.DEFAULT_UNCALIBRATED_WEIGHT,
    uncertaintyCq: referenceContractBridge.DEFAULT_PRIOR_UNCERTAINTY_CQ,
    mode: 'neutral_high_uncertainty_prior',
  });
  assert.strictEqual(bridgeSeedRows.length, 1,
    'schema-v14 legacy labels must retain historical rows for seed-only bridge planning');
  assert.strictEqual(bridgeSeedRows[0].reference_contract_id, 'legacy-original-tf4-v1');
  assert.strictEqual(bridgeSeedRows[0].vmaf_min, undefined,
    'bridge seed rows must strip acceptance-only frame-floor evidence');
  assert.strictEqual(dbModule.getSimilarSweepCurves(migrated, { tier: '1080p' }, {
    limit: 10, referenceContractId: 'canonical-hqdn3d-v1',
  }).length, 0);
  assert.throws(() => dbModule.upsertJob(migrated, {
    job_id: 'legacy-job', reference_contract_id: 'canonical-hqdn3d-v1',
  }), /cannot change reference contract/,
  'a migrated NULL job is immutably legacy');
  migrated.close();

  // A v12 database may already contain a mismatched job/sweep pair from an old
  // writer. Migration preserves it, installs guards, and readers quarantine it.
  const preMismatch = dbModule.openDb(mismatchMigrationPath);
  preMismatch.close();
  const rawMismatch = new DatabaseSync(mismatchMigrationPath);
  for (const trigger of rawMismatch.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger'"
  ).all().map((row) => row.name)) rawMismatch.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  rawMismatch.prepare(
    'INSERT INTO jobs (job_id, timestamp, file_path, tier, reference_contract_id) VALUES (?, ?, ?, ?, ?)'
  ).run('mixed-job', '2026-01-01T00:00:00.000Z', '/media/mixed.mkv', '1080p', 'canonical-hqdn3d-v1');
  rawMismatch.prepare(
    'INSERT INTO sweep_points (job_id, parameter_set_id, cq, vmaf_mean, reference_contract_id) VALUES (?, ?, ?, ?, ?)'
  ).run('mixed-job', 'canonical-cq30', 30, 95, 'canonical-hqdn3d-v1');
  rawMismatch.prepare(
    'INSERT INTO sweep_points (job_id, parameter_set_id, cq, vmaf_mean, reference_contract_id) VALUES (?, ?, ?, ?, ?)'
  ).run('mixed-job', 'legacy-cq32', 32, 94, null);
  rawMismatch.exec('PRAGMA user_version = 12');
  rawMismatch.close();

  const quarantined = dbModule.openDb(mismatchMigrationPath);
  assert.strictEqual(quarantined.prepare('PRAGMA user_version').get().user_version, 15);
  assert.strictEqual(dbModule.getSimilarSweepCurves(quarantined, { tier: '1080p' }, {
    limit: 10, referenceContractId: 'canonical-hqdn3d-v1',
  }).length, 1);
  assert.strictEqual(dbModule.getSimilarSweepCurves(quarantined, { tier: '1080p' }, {
    limit: 10, referenceContractId: 'legacy-original-tf4-v1',
  }).length, 0, 'legacy sweep attached to canonical job must be quarantined');
  assert.strictEqual(dbModule.getSimilarSweepCurves(quarantined, { tier: '1080p' }, {
    limit: 10,
  }).length, 1, 'unfiltered joined reads must also quarantine mismatches');
  assert.strictEqual(dbModule.getSameFileSweepCurves(quarantined, '/media/mixed.mkv', {
    limit: 10, referenceContractId: 'canonical-hqdn3d-v1',
  }).length, 1);
  assert.strictEqual(dbModule.getSameFileSweepCurves(quarantined, '/media/mixed.mkv', {
    limit: 10, referenceContractId: 'legacy-original-tf4-v1',
  }).length, 0);
  assert.throws(() => quarantined.prepare(
    'INSERT INTO sweep_points (job_id, parameter_set_id, cq, vmaf_mean, reference_contract_id, metric_contract_id, encoder_profile_id)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('mixed-job', 'new-mismatch', 34, 93, null,
    dbModule.LEGACY_METRIC_CONTRACT_ID, dbModule.LEGACY_ENCODER_PROFILE_ID),
  /sweep reference contract must match its job/);
  quarantined.close();
  console.log('PASS VMAF DB schema v15 measurement-contract and timing integrity');
} finally {
  for (const file of [dbPath, migrationPath, mismatchMigrationPath]) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { fs.unlinkSync(file + suffix); } catch (_) {}
    }
  }
}
