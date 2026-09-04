'use strict';
/**
 * vmafdb.js - single source of truth for the unified VMAF/AV1 training store.
 *
 * Backed by node:sqlite (built into the container's Node 24). One transactional,
 * indexed, name-based file replaces the two fragile CSVs (vmaf_cq_learning.csv +
 * vmaf_results.csv). Schema changes are ALTER TABLE ADD COLUMN, so historical rows
 * can never misalign the way the positional/header-drift CSV writers did.
 *
 * Required from the bundled Tdarr plugins by absolute (bind-mounted) path:
 *   var vmafdb = require('/custom-cont-init.d/.vmaf-plugin-patches/_lib/vmafdb.js');
 *
 * Two tables:
 *   jobs         - one row per transcode job (source facts + decision + final outcome)
 *   sweep_points - one row per (job, parameter set / CQ) measured during the sweep
 *                  (the target-INDEPENDENT CQ -> VMAF/CAMBI/size curve)
 */

var DEFAULT_DB_PATH = '/app/configs/vmaf_training.db';
var metricContracts = require('./vmafMetricContract.js');

var SCHEMA_VERSION = 20;
var LEGACY_REFERENCE_CONTRACT_ID = 'legacy-original-tf4-v1';
var LEGACY_METRIC_CONTRACT_ID = metricContracts.LEGACY_METRIC_CONTRACT_ID;
var LEGACY_ENCODER_PROFILE_ID = metricContracts.LEGACY_ENCODER_PROFILE_ID;

// ── Column whitelists (writers ignore unknown keys; readers map by name) ──
var JOB_COLUMNS = [
  'job_id', 'timestamp', 'file_path', 'file_name', 'reference_contract_id',
  'metric_contract_id', 'encoder_profile_id',
  'source_codec', 'source_width', 'source_height', 'source_bitrate_mbps',
  'source_file_size_mb', 'bits_per_pixel', 'source_duration_sec', 'pixel_format', 'bit_depth', 'is_hdr',
  'color_primaries', 'color_trc', 'colorspace', 'tier',
  'media_genre', 'media_is_animation', 'media_type', 'media_year', 'media_title',
  'media_metadata_source', 'media_source_type', 'release_group', 'network', 'original_language',
  'source_cambi', 'source_cambi_p95', 'source_cambi_time_sec',
  'grain', 'spatial_info', 'temporal_info', 'dark_fraction', 'luma_avg',
  'effective_frame_floor', 'effective_cambi_limit', 'selector_policy_version',
  'target_min_vmaf', 'selected_cq', 'selected_parameter_set_id',
  'selected_vmaf', 'selected_vmaf_min', 'selected_cambi', 'selected_size_mb',
  'projected_output_ratio_pct', 'projected_size_reduction_pct',
  'final_output_size_mb', 'final_output_ratio_pct', 'size_target_status', 'skip_reason',
  'target_size_reduction_pct', 'minimum_size_reduction_pct',
  'max_final_output_ratio_pct', 'size_policy_version',
  'outcome_stage', 'delivered_at', 'replacement_attestation_version',
  'replacement_backup_retained', 'delivery_transaction_id',
  'delivery_checkpoint_key', 'grain_output_size_ratio_pct_of_base',
  'grain_size_efficiency_warning_pct',
  'grain_size_efficiency_warning_breached',
  'grain_synthesis_quality_warnings_json',
  'transcode_succeeded', 'met_vmaf_target', 'met_size_target',
  'actual_size_reduction_pct', 'total_retries', 'transcode_retry_count',
  'holdout_encode_time_sec', 'holdout_vmaf_time_sec',
  'holdout_candidate_cambi_time_sec', 'holdout_source_cambi_time_sec',
  'sweep_retry_count', 'cq_range_retry_count',
  'updated_at'
];

var SWEEP_COLUMNS = [
  'job_id', 'parameter_set_id', 'cq', 'reference_contract_id',
  'metric_contract_id', 'encoder_profile_id',
  'preset', 'tune', 'multipass', 'spatial_aq', 'temporal_aq', 'aq_strength',
  'vmaf_mean', 'vmaf_harmonic_mean', 'vmaf_min', 'vmaf_max', 'vmaf_p1_low', 'vmaf_stddev',
  'ssim', 'cambi_mean', 'cambi_max', 'cambi_p95',
  'avg_size_mb', 'sample_count',
  'clip_vmafs', 'clip_vmaf_means', 'clip_vmaf_p1s', 'clip_cambis',
  'clip_sample_indices', 'clip_time_starts', 'clip_durations',
  'xpsnr_min', 'xpsnr_weighted', 'psnr_avg',
  'ssimulacra2', 'ssimulacra2_p5', 'butteraugli_norm_inf', 'butteraugli_norm3', 'cvvdp',
  'gpu_perceptual_contract_id',
  'encode_time_sec', 'vmaf_time_sec', 'cambi_time_sec', 'ssim_time_sec',
  'measured_work_time_sec', 'measured_clip_count', 'measured_clip_seconds', 'timing_source',
  'measurement_disposition'
];

var _dbCache = {}; // path -> DatabaseSync handle (reuse across calls within a process)

function _requireSqlite() {
  // Isolated so a missing node:sqlite degrades to a clear error rather than a
  // hard crash at module load (older Node would lack it; container has Node 24).
  return require('node:sqlite');
}

function openDb(dbPath) {
  dbPath = dbPath || DEFAULT_DB_PATH;
  var cached = _dbCache[dbPath];
  if (cached) {
    // Self-heal: the cached handle is shared across the whole node process. If any caller ever
    // closes it, the cache would otherwise hold a CLOSED handle and every later openDb() would
    // hand back a dead db ("database is not open"), silently disabling the predictor for the rest
    // of the process's life. Probe it cheaply; if it's dead, drop it and reopen transparently.
    try { cached.prepare('SELECT 1').get(); return cached; }
    catch (e) { try { cached.close(); } catch (e2) {} delete _dbCache[dbPath]; }
  }

  var sqlite = _requireSqlite();
  var DatabaseSync = sqlite.DatabaseSync;
  var db = new DatabaseSync(dbPath);

  // DELETE journal (not WAL): the DB lives on a Windows bind mount, where WAL's shared-memory
  // (-shm mmap) is fragile. Single writer (the node) + occasional readers -> a rollback journal
  // is robust and sufficient. busy_timeout covers brief lock contention.
  db.exec('PRAGMA journal_mode = DELETE;');
  db.exec('PRAGMA busy_timeout = 10000;');
  db.exec('PRAGMA foreign_keys = ON;');

  _migrate(db);

  _dbCache[dbPath] = db;
  return db;
}

function _userVersion(db) {
  var row = db.prepare('PRAGMA user_version;').get();
  // node:sqlite returns the pragma value under the key 'user_version'
  return row && (row.user_version !== undefined ? row.user_version : row['user_version']) || 0;
}

function _runMigrationStep(db, targetVersion, migrate) {
  db.exec('BEGIN IMMEDIATE');
  try {
    migrate();
    db.exec('PRAGMA user_version = ' + targetVersion + ';');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (eRollback) {}
    throw e;
  }
}

function _migrate(db) {
  var v = _userVersion(db);
  if (v < 1) _runMigrationStep(db, 1, function () {
    db.exec(
      'CREATE TABLE IF NOT EXISTS jobs (' +
      '  job_id TEXT PRIMARY KEY,' +
      '  timestamp TEXT,' +
      '  file_path TEXT,' +
      '  file_name TEXT,' +
      '  source_codec TEXT,' +
      '  source_width INTEGER,' +
      '  source_height INTEGER,' +
      '  source_bitrate_mbps REAL,' +
      '  bits_per_pixel REAL,' +
      '  source_duration_sec REAL,' +
      '  pixel_format TEXT,' +
      '  bit_depth INTEGER,' +
      '  is_hdr INTEGER,' +
      '  color_primaries TEXT,' +
      '  color_trc TEXT,' +
      '  colorspace TEXT,' +
      '  tier TEXT,' +
      '  media_genre TEXT,' +
      '  media_is_animation INTEGER,' +
      '  media_type TEXT,' +
      '  media_year INTEGER,' +
      '  media_metadata_source TEXT,' +
      '  media_source_type TEXT,' +
      '  release_group TEXT,' +
      '  source_cambi REAL,' +
      '  source_cambi_p95 REAL,' +
      '  target_min_vmaf REAL,' +
      '  selected_cq REAL,' +
      '  selected_parameter_set_id TEXT,' +
      '  selected_vmaf REAL,' +
      '  selected_vmaf_min REAL,' +
      '  selected_cambi REAL,' +
      '  selected_size_mb REAL,' +
      '  transcode_succeeded INTEGER,' +
      '  met_vmaf_target INTEGER,' +
      '  met_size_target INTEGER,' +
      '  actual_size_reduction_pct REAL,' +
      '  total_retries INTEGER,' +
      '  transcode_retry_count INTEGER,' +
      '  sweep_retry_count INTEGER,' +
      '  cq_range_retry_count INTEGER,' +
      '  created_at TEXT DEFAULT (datetime(\'now\')),' +
      '  updated_at TEXT' +
      ');'
    );
    db.exec(
      'CREATE TABLE IF NOT EXISTS sweep_points (' +
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      '  job_id TEXT,' +
      '  parameter_set_id TEXT,' +
      '  cq REAL,' +
      '  preset TEXT,' +
      '  tune TEXT,' +
      '  multipass TEXT,' +
      '  spatial_aq TEXT,' +
      '  temporal_aq TEXT,' +
      '  aq_strength TEXT,' +
      '  vmaf_mean REAL,' +
      '  vmaf_harmonic_mean REAL,' +
      '  vmaf_min REAL,' +
      '  vmaf_max REAL,' +
      '  vmaf_stddev REAL,' +
      '  cambi_mean REAL,' +
      '  cambi_p95 REAL,' +
      '  avg_size_mb REAL,' +
      '  sample_count INTEGER,' +
      '  created_at TEXT DEFAULT (datetime(\'now\'))' +
      ');'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_sweep_job ON sweep_points(job_id);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sweep_cq ON sweep_points(cq);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_tier_codec ON jobs(tier, source_codec);');
  });
  if (v < 2) _runMigrationStep(db, 2, function () {
    // Capture worst-case + secondary quality signals that were computed but never
    // persisted by the legacy CSV writers: 1%-low VMAF (the frame-percentile floor
    // used in selection), SSIM, and max CAMBI. Null on backfilled historical rows.
    db.exec('ALTER TABLE sweep_points ADD COLUMN vmaf_p1_low REAL;');
    db.exec('ALTER TABLE sweep_points ADD COLUMN ssim REAL;');
    db.exec('ALTER TABLE sweep_points ADD COLUMN cambi_max REAL;');
  });
  if (v < 3) _runMigrationStep(db, 3, function () {
    // Source content features (predict which constraint binds, esp. the 1%-low floor):
    // grain/noise energy, spatial & temporal complexity (SI/TI proxies), dark-scene fraction,
    // mean luma. Cheap to compute from the extracted clips. Null on rows from before capture.
    db.exec('ALTER TABLE jobs ADD COLUMN grain REAL;');
    db.exec('ALTER TABLE jobs ADD COLUMN spatial_info REAL;');
    db.exec('ALTER TABLE jobs ADD COLUMN temporal_info REAL;');
    db.exec('ALTER TABLE jobs ADD COLUMN dark_fraction REAL;');
    db.exec('ALTER TABLE jobs ADD COLUMN luma_avg REAL;');
  });
  if (v < 4) _runMigrationStep(db, 4, function () {
    // Metadata fields useful as encode-style/grain proxies (esp. cold-start): streaming network
    // (Apple TV+ = grainy, etc.) and original language (anime vs western). media_year already exists.
    db.exec('ALTER TABLE jobs ADD COLUMN network TEXT;');
    db.exec('ALTER TABLE jobs ADD COLUMN original_language TEXT;');
  });
  if (v < 5) _runMigrationStep(db, 5, function () {
    // Raw per-clip VMAF scores as JSON array. Enables backtesting the sequential sampler's stopping
    // rule (mean CI, 1%-low coverage) against historical measured clip distributions. Null on rows
    // from before this migration.
    db.exec('ALTER TABLE sweep_points ADD COLUMN clip_vmafs TEXT;');
  });
  if (v < 6) _runMigrationStep(db, 6, function () {
    // Series/show title (the SxxExx-stripped name for TV; movie title for film). A strong, encode-
    // pipeline-stable similarity signal: episodes of one show share source master/grain/grade, so
    // their CQ->VMAF curves cluster (measured within-series selected_cq std ~3.3 vs tier-wide ~6.4;
    // eta^2 ~0.30, beats release_group/genre). Used only as a curve-pooling WEIGHT in weightForPoint,
    // so the decision stays target-independent (re-derived from the pooled curve at the live target).
    // Null on backfilled rows whose filename was unavailable.
    db.exec('ALTER TABLE jobs ADD COLUMN media_title TEXT;');
  });
  if (v < 7) _runMigrationStep(db, 7, function () {
    // Size-viability instrumentation. These are deliberately separate from met_size_target so
    // unknown size outcomes stop being recorded as false failures. The projected fields come from
    // sample-sweep projection; final_* is reserved for full-output measurement once available.
    db.exec('ALTER TABLE jobs ADD COLUMN source_file_size_mb REAL;');
    db.exec('ALTER TABLE jobs ADD COLUMN projected_output_ratio_pct REAL;');
    db.exec('ALTER TABLE jobs ADD COLUMN projected_size_reduction_pct REAL;');
    db.exec('ALTER TABLE jobs ADD COLUMN final_output_size_mb REAL;');
    db.exec('ALTER TABLE jobs ADD COLUMN final_output_ratio_pct REAL;');
    db.exec('ALTER TABLE jobs ADD COLUMN size_target_status TEXT;');
    db.exec('ALTER TABLE jobs ADD COLUMN skip_reason TEXT;');
  });
  if (v < 8) _runMigrationStep(db, 8, function () {
    // Per-clip CAMBI as JSON ({"mean":[...],"p95":[...]}, position-aligned with clip_vmafs).
    // Replaces the conservative p95-minus-mean spread proxy in autoresearch confidence gating
    // with real per-clip CAMBI CIs, and enables paired cross-CQ CAMBI estimation. Null on rows
    // from before this migration.
    db.exec('ALTER TABLE sweep_points ADD COLUMN clip_cambis TEXT;');
  });
  if (v < 9) _runMigrationStep(db, 9, function () {
    // Per-row clip provenance: which sample indices were measured (index-aligned with clip_vmafs)
    // and where those clips sit in the source. Ends the positional ambiguity when the sequential
    // sampler measures different clip counts at different CQs. clip_time_starts/clip_durations may
    // already exist from the 2026-07-04 out-of-band autoresearch migration, so ALTERs are guarded.
    var _spCols = {};
    try {
      var _ti = db.prepare('PRAGMA table_info(sweep_points)').all();
      for (var _ci = 0; _ci < _ti.length; _ci++) _spCols[_ti[_ci].name] = true;
    } catch (eTi) {}
    if (!_spCols.clip_time_starts) db.exec('ALTER TABLE sweep_points ADD COLUMN clip_time_starts TEXT;');
    if (!_spCols.clip_durations) db.exec('ALTER TABLE sweep_points ADD COLUMN clip_durations TEXT;');
    if (!_spCols.clip_sample_indices) db.exec('ALTER TABLE sweep_points ADD COLUMN clip_sample_indices TEXT;');
  });
  if (v < 10) _runMigrationStep(db, 10, function () {
    // Live per-probe timing written by the plugins at export time (timing_source='live_plugin'),
    // replacing the job-report backfill that only covered ~10% of rows. Most timing columns
    // already exist from that backfill's out-of-band ALTERs, so everything is guarded.
    // ssim_time_sec is new: SSIM is chained inside the VMAF measurement critical path, and this
    // column decides empirically whether that cost is worth keeping per-clip.
    var _tCols = {};
    try {
      var _tti = db.prepare('PRAGMA table_info(sweep_points)').all();
      for (var _tci = 0; _tci < _tti.length; _tci++) _tCols[_tti[_tci].name] = true;
    } catch (eTti) {}
    var _tAdd = ['encode_time_sec REAL', 'vmaf_time_sec REAL', 'ssim_time_sec REAL',
      'measured_work_time_sec REAL', 'measured_clip_count INTEGER', 'measured_clip_seconds REAL',
      'timing_source TEXT', 'timing_backfilled_at TEXT'];
    for (var _tai = 0; _tai < _tAdd.length; _tai++) {
      var _tName = _tAdd[_tai].split(' ')[0];
      if (!_tCols[_tName]) db.exec('ALTER TABLE sweep_points ADD COLUMN ' + _tAdd[_tai] + ';');
    }
  });
  if (v < 11) _runMigrationStep(db, 11, function () {
    // Persist the selector-authoritative per-clip vectors needed to replay paired-CQ
    // predictions. clip_vmafs is the legacy harmonic diagnostic and cannot reconstruct
    // production arithmetic-mean or frame-level 1%-low selection semantics by itself.
    // The effective policy belongs to the job so future replay can evaluate the exact
    // target/floor/CAMBI constraints that were live for that file.
    var _v11SweepCols = {};
    var _v11JobCols = {};
    try {
      var _v11Sti = db.prepare('PRAGMA table_info(sweep_points)').all();
      for (var _v11Si = 0; _v11Si < _v11Sti.length; _v11Si++) _v11SweepCols[_v11Sti[_v11Si].name] = true;
      var _v11Jti = db.prepare('PRAGMA table_info(jobs)').all();
      for (var _v11Ji = 0; _v11Ji < _v11Jti.length; _v11Ji++) _v11JobCols[_v11Jti[_v11Ji].name] = true;
    } catch (eV11Ti) {}
    if (!_v11SweepCols.clip_vmaf_means) db.exec('ALTER TABLE sweep_points ADD COLUMN clip_vmaf_means TEXT;');
    if (!_v11SweepCols.clip_vmaf_p1s) db.exec('ALTER TABLE sweep_points ADD COLUMN clip_vmaf_p1s TEXT;');
    if (!_v11JobCols.effective_frame_floor) db.exec('ALTER TABLE jobs ADD COLUMN effective_frame_floor REAL;');
    if (!_v11JobCols.effective_cambi_limit) db.exec('ALTER TABLE jobs ADD COLUMN effective_cambi_limit REAL;');
    if (!_v11JobCols.selector_policy_version) db.exec('ALTER TABLE jobs ADD COLUMN selector_policy_version TEXT;');
  });
  if (v < 12) _runMigrationStep(db, 12, function () {
    // VMAF/CQ rows are only reusable inside the exact encoder/reference signal
    // contract that produced them. Historical NULL rows belong to the legacy
    // original-reference/tf4 contract; canonical hqdn3d/tf0 rows are explicit.
    var _v12SweepCols = {};
    var _v12JobCols = {};
    try {
      var _v12Sti = db.prepare('PRAGMA table_info(sweep_points)').all();
      for (var _v12Si = 0; _v12Si < _v12Sti.length; _v12Si++) _v12SweepCols[_v12Sti[_v12Si].name] = true;
      var _v12Jti = db.prepare('PRAGMA table_info(jobs)').all();
      for (var _v12Ji = 0; _v12Ji < _v12Jti.length; _v12Ji++) _v12JobCols[_v12Jti[_v12Ji].name] = true;
    } catch (eV12Ti) {}
    if (!_v12SweepCols.reference_contract_id) db.exec('ALTER TABLE sweep_points ADD COLUMN reference_contract_id TEXT;');
    if (!_v12JobCols.reference_contract_id) db.exec('ALTER TABLE jobs ADD COLUMN reference_contract_id TEXT;');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sweep_reference_contract ON sweep_points(reference_contract_id);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_reference_contract ON jobs(reference_contract_id);');
  });
  if (v < 13) _runMigrationStep(db, 13, function () {
    // Contract IDs form an immutable signal-domain boundary. Historical NULL
    // values are logically the legacy original-reference/tf4 contract; keep
    // their stored NULL representation while comparing through COALESCE.
    // Existing mismatches are preserved for forensics and excluded by readers.
    db.exec(
      'CREATE TRIGGER IF NOT EXISTS trg_jobs_contract_insert_consistency ' +
      'BEFORE INSERT ON jobs WHEN EXISTS (' +
      ' SELECT 1 FROM jobs old WHERE old.job_id = NEW.job_id' +
      " AND COALESCE(old.reference_contract_id, 'legacy-original-tf4-v1')" +
      " <> COALESCE(NEW.reference_contract_id, 'legacy-original-tf4-v1')" +
      ") BEGIN SELECT RAISE(ABORT, 'job reference contract is immutable'); END;"
    );
    db.exec(
      'CREATE TRIGGER IF NOT EXISTS trg_jobs_contract_update_immutable ' +
      'BEFORE UPDATE OF reference_contract_id ON jobs ' +
      "WHEN COALESCE(OLD.reference_contract_id, 'legacy-original-tf4-v1')" +
      " <> COALESCE(NEW.reference_contract_id, 'legacy-original-tf4-v1')" +
      " BEGIN SELECT RAISE(ABORT, 'job reference contract is immutable'); END;"
    );
    db.exec(
      'CREATE TRIGGER IF NOT EXISTS trg_sweep_contract_insert_consistency ' +
      'BEFORE INSERT ON sweep_points WHEN NOT EXISTS (' +
      ' SELECT 1 FROM jobs j WHERE j.job_id = NEW.job_id' +
      " AND COALESCE(j.reference_contract_id, 'legacy-original-tf4-v1')" +
      " = COALESCE(NEW.reference_contract_id, 'legacy-original-tf4-v1')" +
      ") BEGIN SELECT RAISE(ABORT, 'sweep reference contract must match its job'); END;"
    );
    db.exec(
      'CREATE TRIGGER IF NOT EXISTS trg_sweep_contract_update_consistency ' +
      'BEFORE UPDATE OF job_id, reference_contract_id ON sweep_points ' +
      'WHEN NOT EXISTS (' +
      ' SELECT 1 FROM jobs j WHERE j.job_id = NEW.job_id' +
      " AND COALESCE(j.reference_contract_id, 'legacy-original-tf4-v1')" +
      " = COALESCE(NEW.reference_contract_id, 'legacy-original-tf4-v1')" +
      ") BEGIN SELECT RAISE(ABORT, 'sweep reference contract must match its job'); END;"
    );
  });
  if (v < 14) _runMigrationStep(db, 14, function () {
    // A VMAF score is reusable only inside the exact measurement model/backend
    // and encoder profile that produced it.  Older rows predate those stamps;
    // retain them under explicit coarse legacy labels instead of pretending
    // that their model/backend/encoder provenance is exact.
    var _v14SweepCols = {};
    var _v14JobCols = {};
    try {
      var _v14Sti = db.prepare('PRAGMA table_info(sweep_points)').all();
      for (var _v14Si = 0; _v14Si < _v14Sti.length; _v14Si++) _v14SweepCols[_v14Sti[_v14Si].name] = true;
      var _v14Jti = db.prepare('PRAGMA table_info(jobs)').all();
      for (var _v14Ji = 0; _v14Ji < _v14Jti.length; _v14Ji++) _v14JobCols[_v14Jti[_v14Ji].name] = true;
    } catch (eV14Ti) {}
    if (!_v14SweepCols.metric_contract_id) db.exec('ALTER TABLE sweep_points ADD COLUMN metric_contract_id TEXT;');
    if (!_v14SweepCols.encoder_profile_id) db.exec('ALTER TABLE sweep_points ADD COLUMN encoder_profile_id TEXT;');
    if (!_v14JobCols.metric_contract_id) db.exec('ALTER TABLE jobs ADD COLUMN metric_contract_id TEXT;');
    if (!_v14JobCols.encoder_profile_id) db.exec('ALTER TABLE jobs ADD COLUMN encoder_profile_id TEXT;');

    db.prepare("UPDATE jobs SET metric_contract_id = ? WHERE metric_contract_id IS NULL OR TRIM(metric_contract_id) = ''")
      .run(LEGACY_METRIC_CONTRACT_ID);
    db.prepare("UPDATE sweep_points SET metric_contract_id = ? WHERE metric_contract_id IS NULL OR TRIM(metric_contract_id) = ''")
      .run(LEGACY_METRIC_CONTRACT_ID);
    db.prepare("UPDATE jobs SET encoder_profile_id = ? WHERE encoder_profile_id IS NULL OR TRIM(encoder_profile_id) = ''")
      .run(LEGACY_ENCODER_PROFILE_ID);
    db.prepare("UPDATE sweep_points SET encoder_profile_id = ? WHERE encoder_profile_id IS NULL OR TRIM(encoder_profile_id) = ''")
      .run(LEGACY_ENCODER_PROFILE_ID);

    db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_measurement_contract ON jobs(reference_contract_id, metric_contract_id, encoder_profile_id);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sweep_measurement_contract ON sweep_points(reference_contract_id, metric_contract_id, encoder_profile_id);');

    db.exec(
      'CREATE TRIGGER IF NOT EXISTS trg_jobs_metric_contract_required ' +
      "BEFORE INSERT ON jobs WHEN NEW.metric_contract_id IS NULL OR TRIM(NEW.metric_contract_id) = ''" +
      " BEGIN SELECT RAISE(ABORT, 'job metric contract is required'); END;"
    );
    db.exec(
      'CREATE TRIGGER IF NOT EXISTS trg_jobs_encoder_profile_required ' +
      "BEFORE INSERT ON jobs WHEN NEW.encoder_profile_id IS NULL OR TRIM(NEW.encoder_profile_id) = ''" +
      " BEGIN SELECT RAISE(ABORT, 'job encoder profile is required'); END;"
    );
    db.exec(
      'CREATE TRIGGER IF NOT EXISTS trg_jobs_metric_contract_insert_consistency ' +
      'BEFORE INSERT ON jobs WHEN EXISTS (' +
      ' SELECT 1 FROM jobs old WHERE old.job_id = NEW.job_id' +
      ' AND old.metric_contract_id <> NEW.metric_contract_id' +
      ") BEGIN SELECT RAISE(ABORT, 'job metric contract is immutable'); END;"
    );
    db.exec(
      'CREATE TRIGGER IF NOT EXISTS trg_jobs_encoder_profile_insert_consistency ' +
      'BEFORE INSERT ON jobs WHEN EXISTS (' +
      ' SELECT 1 FROM jobs old WHERE old.job_id = NEW.job_id' +
      ' AND old.encoder_profile_id <> NEW.encoder_profile_id' +
      ") BEGIN SELECT RAISE(ABORT, 'job encoder profile is immutable'); END;"
    );
    db.exec(
      'CREATE TRIGGER IF NOT EXISTS trg_jobs_metric_contract_update_immutable ' +
      'BEFORE UPDATE OF metric_contract_id ON jobs ' +
      'WHEN OLD.metric_contract_id <> NEW.metric_contract_id' +
      " BEGIN SELECT RAISE(ABORT, 'job metric contract is immutable'); END;"
    );
    db.exec(
      'CREATE TRIGGER IF NOT EXISTS trg_jobs_encoder_profile_update_immutable ' +
      'BEFORE UPDATE OF encoder_profile_id ON jobs ' +
      'WHEN OLD.encoder_profile_id <> NEW.encoder_profile_id' +
      " BEGIN SELECT RAISE(ABORT, 'job encoder profile is immutable'); END;"
    );
    db.exec(
      'CREATE TRIGGER IF NOT EXISTS trg_sweep_measurement_contract_insert_consistency ' +
      'BEFORE INSERT ON sweep_points WHEN NOT EXISTS (' +
      ' SELECT 1 FROM jobs j WHERE j.job_id = NEW.job_id' +
      ' AND j.metric_contract_id = NEW.metric_contract_id' +
      ' AND j.encoder_profile_id = NEW.encoder_profile_id' +
      ") BEGIN SELECT RAISE(ABORT, 'sweep measurement contract must match its job'); END;"
    );
    db.exec(
      'CREATE TRIGGER IF NOT EXISTS trg_sweep_measurement_contract_update_consistency ' +
      'BEFORE UPDATE OF job_id, metric_contract_id, encoder_profile_id ON sweep_points ' +
      'WHEN NOT EXISTS (' +
      ' SELECT 1 FROM jobs j WHERE j.job_id = NEW.job_id' +
      ' AND j.metric_contract_id = NEW.metric_contract_id' +
      ' AND j.encoder_profile_id = NEW.encoder_profile_id' +
      ") BEGIN SELECT RAISE(ABORT, 'sweep measurement contract must match its job'); END;"
    );
  });
  if (v < 15) _runMigrationStep(db, 15, function () {
    // CAMBI is a distinct CPU process and must be represented separately from
    // GPU VMAF. Source/holdout timing is job-level; CQ timing/provenance is row-level.
    var _v15SweepCols = {};
    var _v15JobCols = {};
    try {
      var _v15Sti = db.prepare('PRAGMA table_info(sweep_points)').all();
      for (var _v15Si = 0; _v15Si < _v15Sti.length; _v15Si++) _v15SweepCols[_v15Sti[_v15Si].name] = true;
      var _v15Jti = db.prepare('PRAGMA table_info(jobs)').all();
      for (var _v15Ji = 0; _v15Ji < _v15Jti.length; _v15Ji++) _v15JobCols[_v15Jti[_v15Ji].name] = true;
    } catch (eV15Ti) {}
    var _v15SweepAdd = ['cambi_time_sec REAL', 'measurement_disposition TEXT'];
    for (var _v15Sa = 0; _v15Sa < _v15SweepAdd.length; _v15Sa++) {
      var _v15SName = _v15SweepAdd[_v15Sa].split(' ')[0];
      if (!_v15SweepCols[_v15SName]) db.exec('ALTER TABLE sweep_points ADD COLUMN ' + _v15SweepAdd[_v15Sa] + ';');
    }
    var _v15JobAdd = [
      'source_cambi_time_sec REAL', 'holdout_encode_time_sec REAL',
      'holdout_vmaf_time_sec REAL', 'holdout_candidate_cambi_time_sec REAL',
      'holdout_source_cambi_time_sec REAL'
    ];
    for (var _v15Ja = 0; _v15Ja < _v15JobAdd.length; _v15Ja++) {
      var _v15JName = _v15JobAdd[_v15Ja].split(' ')[0];
      if (!_v15JobCols[_v15JName]) db.exec('ALTER TABLE jobs ADD COLUMN ' + _v15JobAdd[_v15Ja] + ';');
    }
  });
  if (v < 16) _runMigrationStep(db, 16, function () {
    // Delivery-authoritative size labels. Historical success rows remain NULL
    // for outcome_stage/policy provenance because a base encode completing was
    // not proof that grain/remux/replacement also completed.
    var _v16JobCols = {};
    try {
      var _v16Jti = db.prepare('PRAGMA table_info(jobs)').all();
      for (var _v16Ji = 0; _v16Ji < _v16Jti.length; _v16Ji++) {
        _v16JobCols[_v16Jti[_v16Ji].name] = true;
      }
    } catch (eV16Ti) {}
    var _v16JobAdd = [
      'target_size_reduction_pct REAL',
      'minimum_size_reduction_pct REAL',
      'max_final_output_ratio_pct REAL',
      'size_policy_version TEXT',
      'outcome_stage TEXT',
      'delivered_at TEXT',
      'replacement_attestation_version TEXT',
      'replacement_backup_retained INTEGER'
    ];
    for (var _v16Ja = 0; _v16Ja < _v16JobAdd.length; _v16Ja++) {
      var _v16JName = _v16JobAdd[_v16Ja].split(' ')[0];
      if (!_v16JobCols[_v16JName]) {
        db.exec('ALTER TABLE jobs ADD COLUMN ' + _v16JobAdd[_v16Ja] + ';');
      }
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_outcome_stage ON jobs(outcome_stage);');
  });
  if (v < 17) _runMigrationStep(db, 17, function () {
    var _v17JobCols = {};
    try {
      var _v17Jti = db.prepare('PRAGMA table_info(jobs)').all();
      for (var _v17Ji = 0; _v17Ji < _v17Jti.length; _v17Ji++) {
        _v17JobCols[_v17Jti[_v17Ji].name] = true;
      }
    } catch (eV17Ti) {}
    var _v17JobAdd = [
      'delivery_transaction_id TEXT',
      'delivery_checkpoint_key TEXT'
    ];
    for (var _v17Ja = 0; _v17Ja < _v17JobAdd.length; _v17Ja++) {
      var _v17JName = _v17JobAdd[_v17Ja].split(' ')[0];
      if (!_v17JobCols[_v17JName]) {
        db.exec('ALTER TABLE jobs ADD COLUMN ' + _v17JobAdd[_v17Ja] + ';');
      }
    }
    var _candidateGuard =
      "NEW.outcome_stage = 'candidate_ready' AND (" +
      ' NEW.delivery_checkpoint_key IS NULL OR length(NEW.delivery_checkpoint_key) <> 64' +
      " OR lower(NEW.delivery_checkpoint_key) GLOB '*[^0-9a-f]*'" +
      ' OR NEW.delivery_transaction_id IS NOT NULL' +
      ' OR NEW.transcode_succeeded IS NOT NULL OR NEW.met_vmaf_target IS NOT NULL' +
      ' OR NEW.met_size_target IS NOT NULL OR NEW.final_output_size_mb IS NOT NULL' +
      ' OR NEW.final_output_ratio_pct IS NOT NULL OR NEW.actual_size_reduction_pct IS NOT NULL' +
      " OR NEW.size_target_status IS NOT 'pending_delivery'" +
      " OR NEW.size_policy_version IS NOT 'delivered-minimum-reduction-v1'" +
      ' OR NEW.target_size_reduction_pct IS NOT 30' +
      ' OR NEW.minimum_size_reduction_pct IS NOT 20' +
      ' OR NEW.max_final_output_ratio_pct IS NOT 80' +
      ')';
    var _committingGuard =
      "NEW.outcome_stage IN ('replacement_committing','delivery_committing') AND (" +
      ' NEW.delivery_transaction_id IS NULL OR length(NEW.delivery_transaction_id) <> 64' +
      " OR lower(NEW.delivery_transaction_id) GLOB '*[^0-9a-f]*'" +
      ' OR NEW.delivery_checkpoint_key IS NULL OR length(NEW.delivery_checkpoint_key) <> 64' +
      " OR lower(NEW.delivery_checkpoint_key) GLOB '*[^0-9a-f]*'" +
      ' OR NEW.transcode_succeeded IS NOT NULL OR NEW.met_vmaf_target IS NOT NULL' +
      ' OR NEW.met_size_target IS NOT NULL OR NEW.final_output_size_mb IS NOT NULL' +
      ' OR NEW.final_output_ratio_pct IS NOT NULL OR NEW.actual_size_reduction_pct IS NOT NULL' +
      ' OR NEW.delivered_at IS NOT NULL OR NEW.replacement_attestation_version IS NOT NULL' +
      " OR NEW.size_target_status IS NOT 'pending_delivery'" +
      " OR NEW.size_policy_version IS NOT 'delivered-minimum-reduction-v1'" +
      ' OR NEW.target_size_reduction_pct IS NOT 30' +
      ' OR NEW.minimum_size_reduction_pct IS NOT 20' +
      ' OR NEW.max_final_output_ratio_pct IS NOT 80' +
      ')';
    var _deliveredGuard =
      "NEW.outcome_stage = 'delivered' AND (" +
      ' NEW.delivery_transaction_id IS NULL OR length(NEW.delivery_transaction_id) <> 64' +
      " OR lower(NEW.delivery_transaction_id) GLOB '*[^0-9a-f]*'" +
      ' OR NEW.delivery_checkpoint_key IS NULL OR length(NEW.delivery_checkpoint_key) <> 64' +
      " OR lower(NEW.delivery_checkpoint_key) GLOB '*[^0-9a-f]*'" +
      ' OR NEW.transcode_succeeded IS NOT 1 OR NEW.met_vmaf_target IS NOT 1' +
      ' OR NEW.met_size_target IS NOT 1' +
      " OR NEW.size_target_status IS NOT 'met'" +
      ' OR NEW.final_output_size_mb IS NULL OR NEW.final_output_size_mb <= 0' +
      ' OR NEW.final_output_size_mb > 1.7976931348623157e308' +
      ' OR NEW.final_output_ratio_pct IS NULL OR NEW.final_output_ratio_pct <= 0' +
      ' OR NEW.final_output_ratio_pct > 80' +
      ' OR NEW.actual_size_reduction_pct IS NULL' +
      ' OR abs((100 - NEW.final_output_ratio_pct) - NEW.actual_size_reduction_pct) > 0.000000001' +
      " OR NEW.size_policy_version IS NOT 'delivered-minimum-reduction-v1'" +
      ' OR NEW.target_size_reduction_pct IS NOT 30' +
      ' OR NEW.minimum_size_reduction_pct IS NOT 20' +
      ' OR NEW.max_final_output_ratio_pct IS NOT 80' +
      " OR NEW.delivered_at IS NULL OR NEW.delivered_at = ''" +
      " OR NEW.replacement_attestation_version IS NULL OR NEW.replacement_attestation_version = ''" +
      ' OR (NEW.replacement_backup_retained IS NOT 0' +
      ' AND NEW.replacement_backup_retained IS NOT 1)' +
      ' OR NEW.skip_reason IS NOT NULL' +
      ')';
    db.exec('CREATE TRIGGER IF NOT EXISTS trg_jobs_candidate_ready_insert_guard ' +
      'BEFORE INSERT ON jobs WHEN ' + _candidateGuard +
      " BEGIN SELECT RAISE(ABORT, 'invalid candidate-ready delivery state'); END;");
    db.exec('CREATE TRIGGER IF NOT EXISTS trg_jobs_candidate_ready_update_guard ' +
      'BEFORE UPDATE ON jobs WHEN ' + _candidateGuard +
      " BEGIN SELECT RAISE(ABORT, 'invalid candidate-ready delivery state'); END;");
    db.exec('CREATE TRIGGER IF NOT EXISTS trg_jobs_delivery_committing_insert_guard ' +
      'BEFORE INSERT ON jobs WHEN ' + _committingGuard +
      " BEGIN SELECT RAISE(ABORT, 'invalid committing delivery state'); END;");
    db.exec('CREATE TRIGGER IF NOT EXISTS trg_jobs_delivery_committing_update_guard ' +
      'BEFORE UPDATE ON jobs WHEN ' + _committingGuard +
      " BEGIN SELECT RAISE(ABORT, 'invalid committing delivery state'); END;");
    db.exec('CREATE TRIGGER IF NOT EXISTS trg_jobs_delivered_insert_guard ' +
      'BEFORE INSERT ON jobs WHEN ' + _deliveredGuard +
      " BEGIN SELECT RAISE(ABORT, 'invalid delivered state'); END;");
    db.exec('CREATE TRIGGER IF NOT EXISTS trg_jobs_delivered_update_guard ' +
      'BEFORE UPDATE ON jobs WHEN ' + _deliveredGuard +
      " BEGIN SELECT RAISE(ABORT, 'invalid delivered state'); END;");
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS trg_jobs_delivery_stage_transition_guard " +
      'BEFORE UPDATE OF outcome_stage ON jobs WHEN ' +
      "(OLD.outcome_stage = 'candidate_ready' AND (NEW.outcome_stage IS NULL OR NEW.outcome_stage NOT IN " +
      "('candidate_ready','replacement_committing','keep_original','technical_failure'))) OR " +
      "(OLD.outcome_stage = 'replacement_committing' AND (NEW.outcome_stage IS NULL OR NEW.outcome_stage NOT IN " +
      "('replacement_committing','delivery_committing','keep_original','technical_failure'))) OR " +
      "(OLD.outcome_stage = 'delivery_committing' AND (NEW.outcome_stage IS NULL OR NEW.outcome_stage NOT IN " +
      "('delivery_committing','delivered'))) OR " +
      "(OLD.outcome_stage = 'delivered' AND NEW.outcome_stage IS NOT 'delivered') " +
      "BEGIN SELECT RAISE(ABORT, 'invalid delivery stage transition'); END;"
    );
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS trg_jobs_delivered_immutable " +
      'BEFORE UPDATE ON jobs WHEN OLD.outcome_stage = \'delivered\' AND (' +
      ' NEW.outcome_stage IS NOT OLD.outcome_stage' +
      ' OR NEW.delivery_transaction_id IS NOT OLD.delivery_transaction_id' +
      ' OR NEW.delivery_checkpoint_key IS NOT OLD.delivery_checkpoint_key' +
      ' OR NEW.transcode_succeeded IS NOT OLD.transcode_succeeded' +
      ' OR NEW.met_vmaf_target IS NOT OLD.met_vmaf_target' +
      ' OR NEW.met_size_target IS NOT OLD.met_size_target' +
      ' OR NEW.final_output_size_mb IS NOT OLD.final_output_size_mb' +
      ' OR NEW.final_output_ratio_pct IS NOT OLD.final_output_ratio_pct' +
      ' OR NEW.actual_size_reduction_pct IS NOT OLD.actual_size_reduction_pct' +
      ' OR NEW.size_target_status IS NOT OLD.size_target_status' +
      ' OR NEW.target_size_reduction_pct IS NOT OLD.target_size_reduction_pct' +
      ' OR NEW.minimum_size_reduction_pct IS NOT OLD.minimum_size_reduction_pct' +
      ' OR NEW.max_final_output_ratio_pct IS NOT OLD.max_final_output_ratio_pct' +
      ' OR NEW.size_policy_version IS NOT OLD.size_policy_version' +
      ' OR NEW.delivered_at IS NOT OLD.delivered_at' +
      ' OR NEW.replacement_attestation_version IS NOT OLD.replacement_attestation_version' +
      ' OR NEW.replacement_backup_retained IS NOT OLD.replacement_backup_retained' +
      ' OR NEW.skip_reason IS NOT OLD.skip_reason' +
      ") BEGIN SELECT RAISE(ABORT, 'delivered outcome is immutable'); END;"
    );
  });
  if (v < 18) _runMigrationStep(db, 18, function () {
    // Persist the auxiliary and GPU perceptual metrics that now BIND in selection.
    //
    // Without these columns every one of them is computed, used to accept or reject a CQ,
    // and then discarded - so a corpus could never accumulate and the thresholds could never
    // be refined from evidence rather than from one title's ladder. This data is NOT
    // recoverable retroactively: any job that runs before this migration lands loses its
    // metrics permanently, which is why it went in before restarting rather than after.
    //
    // xpsnr/psnr come from the shared-decode CPU pass; ssimulacra2/butteraugli/cvvdp from the
    // per-CQ concatenated FFVship pass. Butteraugli is stored as BOTH norms because the gate
    // uses INF-Norm while Av1an's other published target is the 3-Norm, and a future
    // recalibration will want to compare them on the same rows.
    var _v18Cols = {};
    var _v18Ti = db.prepare('PRAGMA table_info(sweep_points)').all();
    for (var _v18i = 0; _v18i < _v18Ti.length; _v18i++) _v18Cols[_v18Ti[_v18i].name] = true;
    var _v18Add = [
      'xpsnr_min REAL', 'xpsnr_weighted REAL', 'psnr_avg REAL',
      'ssimulacra2 REAL', 'ssimulacra2_p5 REAL',
      'butteraugli_norm_inf REAL', 'butteraugli_norm3 REAL',
      'cvvdp REAL',
      'gpu_perceptual_contract_id TEXT'
    ];
    for (var _v18a = 0; _v18a < _v18Add.length; _v18a++) {
      var _v18Name = _v18Add[_v18a].split(' ')[0];
      if (!_v18Cols[_v18Name]) db.exec('ALTER TABLE sweep_points ADD COLUMN ' + _v18Add[_v18a] + ';');
    }
  });
  if (v < 19) _runMigrationStep(db, 19, function () {
    // The delivery guard is now a 90% output/source ceiling (10% minimum
    // reduction). Replace the v17 triggers atomically so candidate, committing,
    // and delivered rows all attest the same versioned 30/10/90 policy.
    var _v19GuardTriggers = [
      'trg_jobs_candidate_ready_insert_guard',
      'trg_jobs_candidate_ready_update_guard',
      'trg_jobs_delivery_committing_insert_guard',
      'trg_jobs_delivery_committing_update_guard',
      'trg_jobs_delivered_insert_guard',
      'trg_jobs_delivered_update_guard'
    ];
    for (var _v19t = 0; _v19t < _v19GuardTriggers.length; _v19t++) {
      db.exec('DROP TRIGGER IF EXISTS ' + _v19GuardTriggers[_v19t] + ';');
    }
    var _v19PolicyGuard =
      " OR NEW.size_policy_version IS NOT 'delivered-minimum-reduction-v2'" +
      ' OR NEW.target_size_reduction_pct IS NOT 30' +
      ' OR NEW.minimum_size_reduction_pct IS NOT 10' +
      ' OR NEW.max_final_output_ratio_pct IS NOT 90';
    var _v19CandidateGuard =
      "NEW.outcome_stage = 'candidate_ready' AND (" +
      ' NEW.delivery_checkpoint_key IS NULL OR length(NEW.delivery_checkpoint_key) <> 64' +
      " OR lower(NEW.delivery_checkpoint_key) GLOB '*[^0-9a-f]*'" +
      ' OR NEW.delivery_transaction_id IS NOT NULL' +
      ' OR NEW.transcode_succeeded IS NOT NULL OR NEW.met_vmaf_target IS NOT NULL' +
      ' OR NEW.met_size_target IS NOT NULL OR NEW.final_output_size_mb IS NOT NULL' +
      ' OR NEW.final_output_ratio_pct IS NOT NULL OR NEW.actual_size_reduction_pct IS NOT NULL' +
      " OR NEW.size_target_status IS NOT 'pending_delivery'" +
      _v19PolicyGuard + ')';
    var _v19CommittingGuard =
      "NEW.outcome_stage IN ('replacement_committing','delivery_committing') AND (" +
      ' NEW.delivery_transaction_id IS NULL OR length(NEW.delivery_transaction_id) <> 64' +
      " OR lower(NEW.delivery_transaction_id) GLOB '*[^0-9a-f]*'" +
      ' OR NEW.delivery_checkpoint_key IS NULL OR length(NEW.delivery_checkpoint_key) <> 64' +
      " OR lower(NEW.delivery_checkpoint_key) GLOB '*[^0-9a-f]*'" +
      ' OR NEW.transcode_succeeded IS NOT NULL OR NEW.met_vmaf_target IS NOT NULL' +
      ' OR NEW.met_size_target IS NOT NULL OR NEW.final_output_size_mb IS NOT NULL' +
      ' OR NEW.final_output_ratio_pct IS NOT NULL OR NEW.actual_size_reduction_pct IS NOT NULL' +
      ' OR NEW.delivered_at IS NOT NULL OR NEW.replacement_attestation_version IS NOT NULL' +
      " OR NEW.size_target_status IS NOT 'pending_delivery'" +
      _v19PolicyGuard + ')';
    var _v19DeliveredGuard =
      "NEW.outcome_stage = 'delivered' AND (" +
      ' NEW.delivery_transaction_id IS NULL OR length(NEW.delivery_transaction_id) <> 64' +
      " OR lower(NEW.delivery_transaction_id) GLOB '*[^0-9a-f]*'" +
      ' OR NEW.delivery_checkpoint_key IS NULL OR length(NEW.delivery_checkpoint_key) <> 64' +
      " OR lower(NEW.delivery_checkpoint_key) GLOB '*[^0-9a-f]*'" +
      ' OR NEW.transcode_succeeded IS NOT 1 OR NEW.met_vmaf_target IS NOT 1' +
      ' OR NEW.met_size_target IS NOT 1' +
      " OR NEW.size_target_status IS NOT 'met'" +
      ' OR NEW.final_output_size_mb IS NULL OR NEW.final_output_size_mb <= 0' +
      ' OR NEW.final_output_size_mb > 1.7976931348623157e308' +
      ' OR NEW.final_output_ratio_pct IS NULL OR NEW.final_output_ratio_pct <= 0' +
      ' OR NEW.final_output_ratio_pct > 90' +
      ' OR NEW.actual_size_reduction_pct IS NULL' +
      ' OR abs((100 - NEW.final_output_ratio_pct) - NEW.actual_size_reduction_pct) > 0.000000001' +
      _v19PolicyGuard +
      " OR NEW.delivered_at IS NULL OR NEW.delivered_at = ''" +
      " OR NEW.replacement_attestation_version IS NULL OR NEW.replacement_attestation_version = ''" +
      ' OR (NEW.replacement_backup_retained IS NOT 0' +
      ' AND NEW.replacement_backup_retained IS NOT 1)' +
      ' OR NEW.skip_reason IS NOT NULL' +
      ')';
    db.exec('CREATE TRIGGER trg_jobs_candidate_ready_insert_guard BEFORE INSERT ON jobs WHEN ' +
      _v19CandidateGuard + " BEGIN SELECT RAISE(ABORT, 'invalid candidate-ready delivery state'); END;");
    db.exec('CREATE TRIGGER trg_jobs_candidate_ready_update_guard BEFORE UPDATE ON jobs WHEN ' +
      _v19CandidateGuard + " BEGIN SELECT RAISE(ABORT, 'invalid candidate-ready delivery state'); END;");
    db.exec('CREATE TRIGGER trg_jobs_delivery_committing_insert_guard BEFORE INSERT ON jobs WHEN ' +
      _v19CommittingGuard + " BEGIN SELECT RAISE(ABORT, 'invalid committing delivery state'); END;");
    db.exec('CREATE TRIGGER trg_jobs_delivery_committing_update_guard BEFORE UPDATE ON jobs WHEN ' +
      _v19CommittingGuard + " BEGIN SELECT RAISE(ABORT, 'invalid committing delivery state'); END;");
    db.exec('CREATE TRIGGER trg_jobs_delivered_insert_guard BEFORE INSERT ON jobs WHEN ' +
      _v19DeliveredGuard + " BEGIN SELECT RAISE(ABORT, 'invalid delivered state'); END;");
    db.exec('CREATE TRIGGER trg_jobs_delivered_update_guard BEFORE UPDATE ON jobs WHEN ' +
      _v19DeliveredGuard + " BEGIN SELECT RAISE(ABORT, 'invalid delivered state'); END;");
  });
  if (v < 20) _runMigrationStep(db, 20, function () {
    // Delivery-authoritative film-grain warning telemetry. Historical rows stay
    // NULL because their job logs cannot prove the exact warning payload.
    var _v20JobCols = {};
    var _v20Jti = db.prepare('PRAGMA table_info(jobs)').all();
    for (var _v20Ji = 0; _v20Ji < _v20Jti.length; _v20Ji++) {
      _v20JobCols[_v20Jti[_v20Ji].name] = true;
    }
    var _v20JobAdd = [
      'grain_output_size_ratio_pct_of_base REAL',
      'grain_size_efficiency_warning_pct REAL',
      'grain_size_efficiency_warning_breached INTEGER',
      'grain_synthesis_quality_warnings_json TEXT'
    ];
    for (var _v20Ja = 0; _v20Ja < _v20JobAdd.length; _v20Ja++) {
      var _v20JName = _v20JobAdd[_v20Ja].split(' ')[0];
      if (!_v20JobCols[_v20JName]) {
        db.exec('ALTER TABLE jobs ADD COLUMN ' + _v20JobAdd[_v20Ja] + ';');
      }
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_grain_size_warning_breached ' +
      'ON jobs(grain_size_efficiency_warning_breached)');
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS trg_jobs_delivered_grain_observability_guard " +
      "BEFORE INSERT ON jobs WHEN NEW.outcome_stage = 'delivered' AND (" +
      ' NEW.grain_size_efficiency_warning_breached IS NULL' +
      ' OR NEW.grain_size_efficiency_warning_breached NOT IN (0, 1)' +
      ' OR NEW.grain_synthesis_quality_warnings_json IS NULL' +
      ' OR (NEW.grain_size_efficiency_warning_breached = 1 AND (' +
      ' NEW.grain_output_size_ratio_pct_of_base IS NULL' +
      ' OR NEW.grain_size_efficiency_warning_pct IS NULL' +
      ' OR NEW.grain_output_size_ratio_pct_of_base <= NEW.grain_size_efficiency_warning_pct))' +
      ") BEGIN SELECT RAISE(ABORT, 'invalid delivered grain warning observability'); END;"
    );
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS trg_jobs_delivered_grain_observability_update_guard " +
      "BEFORE UPDATE ON jobs WHEN NEW.outcome_stage = 'delivered' AND (" +
      ' NEW.grain_size_efficiency_warning_breached IS NULL' +
      ' OR NEW.grain_size_efficiency_warning_breached NOT IN (0, 1)' +
      ' OR NEW.grain_synthesis_quality_warnings_json IS NULL' +
      ' OR (NEW.grain_size_efficiency_warning_breached = 1 AND (' +
      ' NEW.grain_output_size_ratio_pct_of_base IS NULL' +
      ' OR NEW.grain_size_efficiency_warning_pct IS NULL' +
      ' OR NEW.grain_output_size_ratio_pct_of_base <= NEW.grain_size_efficiency_warning_pct))' +
      ") BEGIN SELECT RAISE(ABORT, 'invalid delivered grain warning observability'); END;"
    );
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS trg_jobs_delivered_grain_observability_immutable " +
      "BEFORE UPDATE ON jobs WHEN OLD.outcome_stage = 'delivered' AND (" +
      ' NEW.grain_output_size_ratio_pct_of_base IS NOT OLD.grain_output_size_ratio_pct_of_base' +
      ' OR NEW.grain_size_efficiency_warning_pct IS NOT OLD.grain_size_efficiency_warning_pct' +
      ' OR NEW.grain_size_efficiency_warning_breached IS NOT OLD.grain_size_efficiency_warning_breached' +
      ' OR NEW.grain_synthesis_quality_warnings_json IS NOT OLD.grain_synthesis_quality_warnings_json' +
      ") BEGIN SELECT RAISE(ABORT, 'delivered grain warning observability is immutable'); END;"
    );
  });
}

function _coerce(v) {

  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string') {
    if (v === '') return null;
    return v;
  }
  // Arrays/objects (e.g. genre lists) -> JSON text
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function _logicalReferenceContract(value) {
  return (value === null || value === undefined || value === '')
    ? LEGACY_REFERENCE_CONTRACT_ID : String(value);
}

function _logicalMetricContract(value) {
  return (value === null || value === undefined || value === '')
    ? LEGACY_METRIC_CONTRACT_ID : String(value);
}

function _logicalEncoderProfile(value) {
  return (value === null || value === undefined || value === '')
    ? LEGACY_ENCODER_PROFILE_ID : String(value);
}

/**
 * Partial upsert into jobs keyed by job_id. Only the columns present in `fields`
 * are written; on conflict only those columns are updated, so a later call
 * (e.g. learnCQRange writing outcome) never clobbers earlier source/decision data.
 */
function upsertJob(db, fields) {
  if (!fields || !fields.job_id) throw new Error('upsertJob requires job_id');
  fields = Object.assign({}, fields, { updated_at: new Date().toISOString() });

  var contractFields = [
    {
      column: 'reference_contract_id',
      label: 'reference contract',
      logical: _logicalReferenceContract,
    },
    {
      column: 'metric_contract_id',
      label: 'metric contract',
      logical: _logicalMetricContract,
    },
    {
      column: 'encoder_profile_id',
      label: 'encoder profile',
      logical: _logicalEncoderProfile,
    },
  ];
  var existing = db.prepare(
    'SELECT reference_contract_id, metric_contract_id, encoder_profile_id FROM jobs WHERE job_id = ?'
  ).get(fields.job_id);
  for (var contractIndex = 0; contractIndex < contractFields.length; contractIndex++) {
    var contractField = contractFields[contractIndex];
    var hasRequestedContract = Object.prototype.hasOwnProperty.call(fields, contractField.column)
      && fields[contractField.column] !== undefined;
    if (existing && hasRequestedContract &&
        contractField.logical(existing[contractField.column]) !==
        contractField.logical(fields[contractField.column])) {
      throw new Error('upsertJob cannot change ' + contractField.label + ' for established job ' +
        fields.job_id + ' (' + contractField.logical(existing[contractField.column]) + ' -> ' +
        contractField.logical(fields[contractField.column]) + ')');
    }
    if (existing && !hasRequestedContract) {
      fields[contractField.column] = existing[contractField.column];
    }
  }
  // SQLite runs BEFORE INSERT triggers before resolving ON CONFLICT. Carry the
  // established values through a partial upsert so insert-consistency triggers
  // see the real contracts. New unstamped callers are retained under explicit,
  // coarse legacy labels rather than creating ambiguous NULL provenance.
  if (!existing) {
    if (!Object.prototype.hasOwnProperty.call(fields, 'metric_contract_id') ||
        fields.metric_contract_id === undefined || fields.metric_contract_id === null ||
        String(fields.metric_contract_id).trim() === '') {
      fields.metric_contract_id = LEGACY_METRIC_CONTRACT_ID;
    }
    if (!Object.prototype.hasOwnProperty.call(fields, 'encoder_profile_id') ||
        fields.encoder_profile_id === undefined || fields.encoder_profile_id === null ||
        String(fields.encoder_profile_id).trim() === '') {
      fields.encoder_profile_id = LEGACY_ENCODER_PROFILE_ID;
    }
  }

  var cols = [];
  var placeholders = [];
  var values = [];
  for (var i = 0; i < JOB_COLUMNS.length; i++) {
    var c = JOB_COLUMNS[i];
    if (Object.prototype.hasOwnProperty.call(fields, c) && fields[c] !== undefined) {
      cols.push(c);
      placeholders.push('?');
      values.push(_coerce(fields[c]));
    }
  }
  if (cols.length === 0) return;

  var updates = [];
  for (var j = 0; j < cols.length; j++) {
    // The insert path establishes the contract. Conflict updates retain the
    // stored representation (including historical NULL-as-legacy) forever.
    if (cols[j] !== 'job_id' && cols[j] !== 'reference_contract_id' &&
        cols[j] !== 'metric_contract_id' && cols[j] !== 'encoder_profile_id') {
      updates.push(cols[j] + ' = excluded.' + cols[j]);
    }
  }

  var sql = 'INSERT INTO jobs (' + cols.join(', ') + ') VALUES (' + placeholders.join(', ') + ')';
  if (updates.length > 0) {
    sql += ' ON CONFLICT(job_id) DO UPDATE SET ' + updates.join(', ');
  } else {
    sql += ' ON CONFLICT(job_id) DO NOTHING';
  }
  var stmt = db.prepare(sql);
  stmt.run.apply(stmt, values);
}

/**
 * Insert sweep curve points for a job inside a single transaction.
 * `points` is an array of objects keyed by SWEEP_COLUMNS (job_id is set from jobId).
 */
function insertSweepPoints(db, jobId, points) {
  if (!jobId) throw new Error('insertSweepPoints requires jobId');
  if (!points || points.length === 0) return 0;

  var parentJob = db.prepare(
    'SELECT reference_contract_id, metric_contract_id, encoder_profile_id FROM jobs WHERE job_id = ?'
  ).get(jobId);
  if (!parentJob) throw new Error('insertSweepPoints requires an existing parent job: ' + jobId);
  var jobContract = _logicalReferenceContract(parentJob.reference_contract_id);
  var jobMetricContract = _logicalMetricContract(parentJob.metric_contract_id);
  var jobEncoderProfile = _logicalEncoderProfile(parentJob.encoder_profile_id);
  // Validate the complete batch before BEGIN. Missing/NULL sweep contracts are
  // logically legacy. Exact current jobs must therefore supply exact stamps;
  // legacy/backfill jobs receive explicit coarse labels at insertion.
  for (var vp = 0; vp < points.length; vp++) {
    var point = points[vp] || {};
    var pointContract = _logicalReferenceContract(point.reference_contract_id);
    if (pointContract !== jobContract) {
      throw new Error('insertSweepPoints reference contract mismatch for job ' + jobId +
        ' at point ' + vp + ' (' + pointContract + ' != ' + jobContract + ')');
    }
    var pointMetricContract = _logicalMetricContract(point.metric_contract_id);
    if (pointMetricContract !== jobMetricContract) {
      throw new Error('insertSweepPoints metric contract mismatch for job ' + jobId +
        ' at point ' + vp + ' (' + pointMetricContract + ' != ' + jobMetricContract + ')');
    }
    var pointEncoderProfile = _logicalEncoderProfile(point.encoder_profile_id);
    if (pointEncoderProfile !== jobEncoderProfile) {
      throw new Error('insertSweepPoints encoder profile mismatch for job ' + jobId +
        ' at point ' + vp + ' (' + pointEncoderProfile + ' != ' + jobEncoderProfile + ')');
    }
  }

  var insertCols = SWEEP_COLUMNS;
  var sql = 'INSERT INTO sweep_points (' + insertCols.join(', ') + ') VALUES (' +
    insertCols.map(function () { return '?'; }).join(', ') + ')';
  var stmt = db.prepare(sql);

  // Flow retries can replay the complete accumulated vmafAggregatedResults array.
  // Compare through SQLite itself so column affinity is authoritative: plugin retries
  // may express the same REAL/INTEGER value as either a number or numeric text. An
  // application-level typed string key would treat those as different even though
  // SQLite persists both identically. Every writer column participates; created_at is
  // deliberately absent, so any genuinely changed persisted value remains evidence.
  var existsSql = 'SELECT 1 AS present FROM sweep_points WHERE ' +
    insertCols.map(function (column) { return column + ' IS ?'; }).join(' AND ') +
    ' LIMIT 1';
  var existsStmt = db.prepare(existsSql);

  function valuesFor(row) {
    var vals = [];
    for (var i = 0; i < insertCols.length; i++) {
      var c = insertCols[i];
      var v = (c === 'job_id') ? jobId : row[c];
      if ((v === undefined || v === null || String(v).trim() === '') &&
          c === 'metric_contract_id' && jobMetricContract === LEGACY_METRIC_CONTRACT_ID) {
        v = LEGACY_METRIC_CONTRACT_ID;
      }
      if ((v === undefined || v === null || String(v).trim() === '') &&
          c === 'encoder_profile_id' && jobEncoderProfile === LEGACY_ENCODER_PROFILE_ID) {
        v = LEGACY_ENCODER_PROFILE_ID;
      }
      vals.push(_coerce(v === undefined ? null : v));
    }
    return vals;
  }

  var n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (var p = 0; p < points.length; p++) {
      var vals = valuesFor(points[p] || {});
      if (existsStmt.get.apply(existsStmt, vals)) continue;
      stmt.run.apply(stmt, vals);
      // The inserted row is immediately visible in this transaction, so the same
      // existence query also suppresses affinity-equivalent repeats later in the batch.
      n++;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
    throw e;
  }
  return n;
}

/**
 * Pull per-CQ sweep curves from jobs similar to the current source, joined to
 * job-level features needed for weighting (bpp, codec, genre, animation, target,
 * timestamp). Filtering is intentionally permissive (tier OR codec); the predictor
 * applies soft similarity + recency weighting. Returns rows newest-first.
 */
function getSimilarSweepCurves(db, src, opts) {
  opts = opts || {};
  var limit = opts.limit || 20000;
  var metricContractId = _logicalMetricContract(opts.metricContractId);
  var encoderProfileId = _logicalEncoderProfile(opts.encoderProfileId);
  var where = [
    "COALESCE(s.reference_contract_id, 'legacy-original-tf4-v1') = " +
    "COALESCE(j.reference_contract_id, 'legacy-original-tf4-v1')",
    's.metric_contract_id = j.metric_contract_id',
    's.encoder_profile_id = j.encoder_profile_id',
    's.metric_contract_id = ?',
    's.encoder_profile_id = ?'
  ];
  // Measurement identity is a mandatory query boundary. Callers that have not
  // yet been upgraded see only explicitly labelled coarse legacy rows; they
  // can never accidentally mix those rows with exact current measurements.
  var params = [metricContractId, encoderProfileId];
  // Historical backfills used both `SD` and `sd`; tier identity is semantic,
  // not case-sensitive. Without this normalization every pre-canonical SD
  // curve would be silently discarded from planning.
  if (src && src.tier) { where.push('LOWER(j.tier) = LOWER(?)'); params.push(src.tier); }
  // codec is a soft signal; do not hard-filter unless asked
  if (opts.codec && src && src.source_codec) { where.push('j.source_codec = ?'); params.push(src.source_codec); }
  if (opts.referenceContractId) {
    where.push("COALESCE(s.reference_contract_id, 'legacy-original-tf4-v1') = ?");
    params.push(opts.referenceContractId);
  }
  // DATA-QUALITY GUARD (default on): exclude physically-impossible rows. ~92% of the original
  // CSV->DB backfill was column-misaligned (vmaf_min=100 > vmaf_max~5, vmaf_mean outside [min,max],
  // per-frame spread written into vmaf_stddev) and would poison the curve fits and sigma estimate.
  // Keep mean-only rows (min/max NULL) and fully-consistent rows; drop the swapped/garbage ones.
  // Pass opts.includeInvalid to inspect the raw rows for forensics.
  if (!opts.includeInvalid) {
    where.push('s.vmaf_mean IS NOT NULL');
    where.push('(s.vmaf_min IS NULL OR s.vmaf_max IS NULL OR (s.vmaf_min <= s.vmaf_mean AND s.vmaf_mean <= s.vmaf_max AND s.vmaf_min <= s.vmaf_max))');
  }

  var sql =
    'SELECT s.cq, s.reference_contract_id, s.metric_contract_id, s.encoder_profile_id,' +
    '       s.vmaf_mean, s.vmaf_harmonic_mean, s.vmaf_min, s.vmaf_max, s.vmaf_p1_low, s.vmaf_stddev,' +
    '       s.ssim, s.cambi_mean, s.cambi_max, s.cambi_p95, s.avg_size_mb, s.sample_count, s.parameter_set_id,' +
    '       j.job_id, j.timestamp, j.tier, j.source_codec, j.bits_per_pixel,' +
    '       j.media_genre, j.media_is_animation, j.media_type, j.media_year, j.media_title, j.release_group,' +
    '       j.is_hdr, j.network, j.original_language, j.target_min_vmaf, j.source_cambi, j.source_cambi_p95' +
    ' FROM sweep_points s JOIN jobs j ON s.job_id = j.job_id';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY j.timestamp DESC LIMIT ?';
  params.push(limit);

  var stmt = db.prepare(sql);
  return stmt.all.apply(stmt, params);
}

/**
 * Pull sweep curves for the exact same file_path — used as a high-weight prior
 * when a file has been re-queued (either a re-encode trigger or a retry after
 * previously failing to meet the VMAF target). Returns rows newest-first.
 */
function getSameFileSweepCurves(db, filePath, opts) {
  opts = opts || {};
  var limit = opts.limit || 2000;
  if (!filePath) return [];
  var where = [
    "COALESCE(s.reference_contract_id, 'legacy-original-tf4-v1') = " +
      "COALESCE(j.reference_contract_id, 'legacy-original-tf4-v1')",
    's.metric_contract_id = j.metric_contract_id',
    's.encoder_profile_id = j.encoder_profile_id',
    'j.file_path = ?',
    's.vmaf_mean IS NOT NULL',
    's.metric_contract_id = ?',
    's.encoder_profile_id = ?'
  ];
  var params = [
    filePath,
    _logicalMetricContract(opts.metricContractId),
    _logicalEncoderProfile(opts.encoderProfileId)
  ];
  if (opts.referenceContractId) {
    where.push("COALESCE(s.reference_contract_id, 'legacy-original-tf4-v1') = ?");
    params.push(opts.referenceContractId);
  }
  var sql =
    'SELECT s.cq, s.reference_contract_id, s.metric_contract_id, s.encoder_profile_id,' +
    '       s.vmaf_mean, s.vmaf_harmonic_mean, s.vmaf_min, s.vmaf_max, s.vmaf_p1_low, s.vmaf_stddev,' +
    '       s.ssim, s.cambi_mean, s.cambi_max, s.cambi_p95, s.avg_size_mb, s.sample_count, s.parameter_set_id,' +
    '       j.job_id, j.timestamp, j.tier, j.source_codec, j.bits_per_pixel,' +
    '       j.media_genre, j.media_is_animation, j.media_type, j.media_year, j.media_title, j.release_group,' +
    '       j.is_hdr, j.network, j.original_language, j.target_min_vmaf, j.source_cambi, j.source_cambi_p95' +
    ' FROM sweep_points s JOIN jobs j ON s.job_id = j.job_id' +
    ' WHERE ' + where.join(' AND ') +
    ' ORDER BY j.timestamp DESC LIMIT ?';
  params.push(limit);
  var stmt = db.prepare(sql);
  return stmt.all.apply(stmt, params);
}

/** Pull similar completed jobs (selected CQ + outcome) for outcome-aware priors. */
function getSimilarJobs(db, src, opts) {
  opts = opts || {};
  var limit = opts.limit || 5000;
  var where = ['metric_contract_id = ?', 'encoder_profile_id = ?'];
  var params = [
    _logicalMetricContract(opts.metricContractId),
    _logicalEncoderProfile(opts.encoderProfileId)
  ];
  if (src && src.tier) { where.push('tier = ?'); params.push(src.tier); }
  if (opts.referenceContractId) {
    where.push("COALESCE(reference_contract_id, 'legacy-original-tf4-v1') = ?");
    params.push(opts.referenceContractId);
  }
  var sql = 'SELECT * FROM jobs';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);
  var stmt = db.prepare(sql);
  return stmt.all.apply(stmt, params);
}

/** Exact-title terminal outcomes for observational same-title routing research. */
function getSameTitleOutcomes(db, src, opts) {
  opts = opts || {};
  if (!src || !src.media_title) return [];
  var metricContractId = Object.prototype.hasOwnProperty.call(opts, 'metricContractId')
    ? opts.metricContractId : src.metric_contract_id;
  var encoderProfileId = Object.prototype.hasOwnProperty.call(opts, 'encoderProfileId')
    ? opts.encoderProfileId : src.encoder_profile_id;
  var where = ['media_title = ?', 'metric_contract_id = ?', 'encoder_profile_id = ?'];
  var params = [
    src.media_title,
    _logicalMetricContract(metricContractId),
    _logicalEncoderProfile(encoderProfileId)
  ];
  if (src.tier) { where.push('tier = ?'); params.push(src.tier); }
  if (src.is_hdr !== null && src.is_hdr !== undefined) {
    where.push('is_hdr = ?'); params.push(src.is_hdr ? 1 : 0);
  }
  if (src.job_id) { where.push('job_id <> ?'); params.push(src.job_id); }
  if (src.reference_contract_id) {
    where.push("COALESCE(reference_contract_id, 'legacy-original-tf4-v1') = ?");
    params.push(src.reference_contract_id);
  }
  where.push('(skip_reason IS NOT NULL OR transcode_succeeded IS NOT NULL)');
  var sql = 'SELECT job_id, timestamp, media_title, tier, is_hdr, selected_cq, skip_reason, transcode_succeeded' +
    ' FROM jobs WHERE ' + where.join(' AND ') + ' ORDER BY timestamp DESC LIMIT ?';
  params.push(Math.max(1, Number(opts.limit) || 100));
  var stmt = db.prepare(sql);
  return stmt.all.apply(stmt, params);
}

/** Canonical resolution tier bucket - shared by backfill, predictors and plugins. */
function tierFor(width, height) {
  var w = Number(width) || 0;
  var h = Number(height) || 0;
  if (w >= 3400 || h >= 2000) return '2160p';
  if (w >= 2400 || h >= 1300) return '1440p';
  if (w >= 1700 || h >= 900) return '1080p';
  if (w >= 1200 || h >= 650) return '720p';
  if (w > 0 || h > 0) return 'SD';
  return '';
}

/** Stable per-job id shared by all plugins: <startISO>-<8hex of file_path>. */
function makeJobId(filePath, startTimestamp) {
  var crypto = require('crypto');
  var h = crypto.createHash('sha1').update(String(filePath || '')).digest('hex').slice(0, 8);
  var ts = startTimestamp || new Date().toISOString();
  return ts + '-' + h;
}

function counts(db) {
  var j = db.prepare('SELECT COUNT(*) AS n FROM jobs').get();
  var s = db.prepare('SELECT COUNT(*) AS n FROM sweep_points').get();
  return { jobs: j.n, sweep_points: s.n };
}

module.exports = {
  DEFAULT_DB_PATH: DEFAULT_DB_PATH,
  SCHEMA_VERSION: SCHEMA_VERSION,
  LEGACY_REFERENCE_CONTRACT_ID: LEGACY_REFERENCE_CONTRACT_ID,
  LEGACY_METRIC_CONTRACT_ID: LEGACY_METRIC_CONTRACT_ID,
  LEGACY_ENCODER_PROFILE_ID: LEGACY_ENCODER_PROFILE_ID,
  JOB_COLUMNS: JOB_COLUMNS,
  SWEEP_COLUMNS: SWEEP_COLUMNS,
  openDb: openDb,
  upsertJob: upsertJob,
  insertSweepPoints: insertSweepPoints,
  getSimilarSweepCurves: getSimilarSweepCurves,
  getSameFileSweepCurves: getSameFileSweepCurves,
  getSimilarJobs: getSimilarJobs,
  getSameTitleOutcomes: getSameTitleOutcomes,
  makeJobId: makeJobId,
  tierFor: tierFor,
  counts: counts
};
