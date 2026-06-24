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
 *   var vmafdb = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
 *
 * Two tables:
 *   jobs         - one row per transcode job (source facts + decision + final outcome)
 *   sweep_points - one row per (job, parameter set / CQ) measured during the sweep
 *                  (the target-INDEPENDENT CQ -> VMAF/CAMBI/size curve)
 */

var DEFAULT_DB_PATH = '/app/configs/vmaf_training.db';
var SCHEMA_VERSION = 4;

// ── Column whitelists (writers ignore unknown keys; readers map by name) ──
var JOB_COLUMNS = [
  'job_id', 'timestamp', 'file_path', 'file_name',
  'source_codec', 'source_width', 'source_height', 'source_bitrate_mbps',
  'bits_per_pixel', 'source_duration_sec', 'pixel_format', 'bit_depth', 'is_hdr',
  'color_primaries', 'color_trc', 'colorspace', 'tier',
  'media_genre', 'media_is_animation', 'media_type', 'media_year',
  'media_metadata_source', 'media_source_type', 'release_group', 'network', 'original_language',
  'source_cambi', 'source_cambi_p95',
  'grain', 'spatial_info', 'temporal_info', 'dark_fraction', 'luma_avg',
  'target_min_vmaf', 'selected_cq', 'selected_parameter_set_id',
  'selected_vmaf', 'selected_vmaf_min', 'selected_cambi', 'selected_size_mb',
  'transcode_succeeded', 'met_vmaf_target', 'met_size_target',
  'actual_size_reduction_pct', 'total_retries', 'transcode_retry_count',
  'sweep_retry_count', 'cq_range_retry_count',
  'updated_at'
];

var SWEEP_COLUMNS = [
  'job_id', 'parameter_set_id', 'cq',
  'preset', 'tune', 'multipass', 'spatial_aq', 'temporal_aq', 'aq_strength',
  'vmaf_mean', 'vmaf_harmonic_mean', 'vmaf_min', 'vmaf_max', 'vmaf_p1_low', 'vmaf_stddev',
  'ssim', 'cambi_mean', 'cambi_max', 'cambi_p95',
  'avg_size_mb', 'sample_count'
];

var _dbCache = {}; // path -> DatabaseSync handle (reuse across calls within a process)

function _requireSqlite() {
  // Isolated so a missing node:sqlite degrades to a clear error rather than a
  // hard crash at module load (older Node would lack it; container has Node 24).
  return require('node:sqlite');
}

function openDb(dbPath) {
  dbPath = dbPath || DEFAULT_DB_PATH;
  if (_dbCache[dbPath]) return _dbCache[dbPath];

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

function _migrate(db) {
  var v = _userVersion(db);
  if (v < 1) {
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
    db.exec('PRAGMA user_version = 1;');
  }
  if (v < 2) {
    // Capture worst-case + secondary quality signals that were computed but never
    // persisted by the legacy CSV writers: 1%-low VMAF (the frame-percentile floor
    // used in selection), SSIM, and max CAMBI. Null on backfilled historical rows.
    db.exec('ALTER TABLE sweep_points ADD COLUMN vmaf_p1_low REAL;');
    db.exec('ALTER TABLE sweep_points ADD COLUMN ssim REAL;');
    db.exec('ALTER TABLE sweep_points ADD COLUMN cambi_max REAL;');
    db.exec('PRAGMA user_version = 2;');
  }
  if (v < 3) {
    // Source content features (predict which constraint binds, esp. the 1%-low floor):
    // grain/noise energy, spatial & temporal complexity (SI/TI proxies), dark-scene fraction,
    // mean luma. Cheap to compute from the extracted clips. Null on rows from before capture.
    db.exec('ALTER TABLE jobs ADD COLUMN grain REAL;');
    db.exec('ALTER TABLE jobs ADD COLUMN spatial_info REAL;');
    db.exec('ALTER TABLE jobs ADD COLUMN temporal_info REAL;');
    db.exec('ALTER TABLE jobs ADD COLUMN dark_fraction REAL;');
    db.exec('ALTER TABLE jobs ADD COLUMN luma_avg REAL;');
    db.exec('PRAGMA user_version = 3;');
  }
  if (v < 4) {
    // Metadata fields useful as encode-style/grain proxies (esp. cold-start): streaming network
    // (Apple TV+ = grainy, etc.) and original language (anime vs western). media_year already exists.
    db.exec('ALTER TABLE jobs ADD COLUMN network TEXT;');
    db.exec('ALTER TABLE jobs ADD COLUMN original_language TEXT;');
    db.exec('PRAGMA user_version = 4;');
  }
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

/**
 * Partial upsert into jobs keyed by job_id. Only the columns present in `fields`
 * are written; on conflict only those columns are updated, so a later call
 * (e.g. learnCQRange writing outcome) never clobbers earlier source/decision data.
 */
function upsertJob(db, fields) {
  if (!fields || !fields.job_id) throw new Error('upsertJob requires job_id');
  fields = Object.assign({}, fields, { updated_at: new Date().toISOString() });

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
    if (cols[j] !== 'job_id') updates.push(cols[j] + ' = excluded.' + cols[j]);
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

  var insertCols = SWEEP_COLUMNS;
  var sql = 'INSERT INTO sweep_points (' + insertCols.join(', ') + ') VALUES (' +
    insertCols.map(function () { return '?'; }).join(', ') + ')';
  var stmt = db.prepare(sql);

  var n = 0;
  db.exec('BEGIN');
  try {
    for (var p = 0; p < points.length; p++) {
      var row = points[p] || {};
      var vals = [];
      for (var i = 0; i < insertCols.length; i++) {
        var c = insertCols[i];
        var v = (c === 'job_id') ? jobId : row[c];
        vals.push(_coerce(v === undefined ? null : v));
      }
      stmt.run.apply(stmt, vals);
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
  var where = [];
  var params = [];
  if (src && src.tier) { where.push('j.tier = ?'); params.push(src.tier); }
  // codec is a soft signal; do not hard-filter unless asked
  if (opts.codec && src && src.source_codec) { where.push('j.source_codec = ?'); params.push(src.source_codec); }
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
    'SELECT s.cq, s.vmaf_mean, s.vmaf_harmonic_mean, s.vmaf_min, s.vmaf_max, s.vmaf_p1_low, s.vmaf_stddev,' +
    '       s.ssim, s.cambi_mean, s.cambi_max, s.cambi_p95, s.avg_size_mb, s.sample_count, s.parameter_set_id,' +
    '       j.job_id, j.timestamp, j.tier, j.source_codec, j.bits_per_pixel,' +
    '       j.media_genre, j.media_is_animation, j.media_type, j.media_year, j.release_group,' +
    '       j.network, j.original_language, j.target_min_vmaf, j.source_cambi' +
    ' FROM sweep_points s JOIN jobs j ON s.job_id = j.job_id';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY j.timestamp DESC LIMIT ?';
  params.push(limit);

  var stmt = db.prepare(sql);
  return stmt.all.apply(stmt, params);
}

/** Pull similar completed jobs (selected CQ + outcome) for outcome-aware priors. */
function getSimilarJobs(db, src, opts) {
  opts = opts || {};
  var limit = opts.limit || 5000;
  var where = [];
  var params = [];
  if (src && src.tier) { where.push('tier = ?'); params.push(src.tier); }
  var sql = 'SELECT * FROM jobs';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);
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
  JOB_COLUMNS: JOB_COLUMNS,
  SWEEP_COLUMNS: SWEEP_COLUMNS,
  openDb: openDb,
  upsertJob: upsertJob,
  insertSweepPoints: insertSweepPoints,
  getSimilarSweepCurves: getSimilarSweepCurves,
  getSimilarJobs: getSimilarJobs,
  makeJobId: makeJobId,
  tierFor: tierFor,
  counts: counts
};
