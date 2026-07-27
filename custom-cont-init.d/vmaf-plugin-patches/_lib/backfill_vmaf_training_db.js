'use strict';
/**
 * One-time backfill of vmaf_training.db from the two legacy CSVs.
 *
 *   sweep_points <- vmaf_results.csv   (per-CQ curves; CAMBI null for history)
 *   jobs         <- vmaf_results.csv   (source facts + decision, file_path-keyed)
 *                 + vmaf_cq_learning.csv (selected CQ + outcome + source_cambi)
 *
 * NOTE on linkage: the legacy CSVs share no reliable key (the learning CSV has no
 * file_path, and its end-of-job timestamp differs from the mid-job export timestamp),
 * so learning rows are imported as STANDALONE jobs (no sweep curve). Going forward
 * both plugins key by a shared vmafJobId, so new jobs are fully unified. The valuable
 * curves come from results.csv and are intact.
 *
 * Run inside the container:
 *   docker exec tdarr node /custom-cont-init.d/vmaf-plugin-patches/_lib/backfill_vmaf_training_db.js
 */

var fs = require('fs');
var vmafdb = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');

var RESULTS_CSV = process.env.RESULTS_CSV || '/app/configs/vmaf_results.csv';
var LEARNING_CSV = process.env.LEARNING_CSV || '/app/configs/vmaf_cq_learning.csv';
var DB_PATH = process.env.DB_PATH || '/app/configs/vmaf_training.db';

// ── quote-aware CSV ──
function splitLine(line) {
  var out = [], cur = '', inQ = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function readCsv(path) {
  if (!fs.existsSync(path)) return { header: [], rows: [] };
  var lines = fs.readFileSync(path, 'utf8').split(/\r?\n/).filter(function (l) { return l.length > 0; });
  if (lines.length === 0) return { header: [], rows: [] };
  var header = splitLine(lines[0]);
  var idx = {};
  for (var i = 0; i < header.length; i++) idx[header[i].trim()] = i;
  var rows = [];
  for (var j = 1; j < lines.length; j++) rows.push(splitLine(lines[j]));
  return { header: header, idx: idx, rows: rows };
}
function num(v) { if (v === undefined || v === null || v === '') return null; var n = parseFloat(v); return isFinite(n) ? n : null; }
function intg(v) { var n = num(v); return n === null ? null : Math.round(n); }
function bool01(v) { if (v === '1' || v === 'true' || v === 'True' || v === true) return 1; if (v === '0' || v === 'false' || v === 'False' || v === false) return 0; return null; }
function str(v) { return (v === undefined || v === null || v === '') ? null : v; }
function bitDepthFromPixFmt(pf) {
  if (!pf) return null;
  pf = String(pf).toLowerCase();
  if (pf.indexOf('12le') !== -1 || pf.indexOf('12be') !== -1 || pf.indexOf('p012') !== -1) return 12;
  if (pf.indexOf('10le') !== -1 || pf.indexOf('10be') !== -1 || pf.indexOf('p010') !== -1 || pf.indexOf('yuv420p10') !== -1) return 10;
  return 8;
}

function main() {
  var db = vmafdb.openDb(DB_PATH);
  // One-time bulk load: drop the per-commit fsync (the bottleneck on a bind-mounted
  // volume). Safe because this is a rebuildable backfill, not the live write path.
  db.exec('PRAGMA synchronous = OFF;');
  db.exec('PRAGMA cache_size = -65536;'); // ~64MB page cache
  var pre = vmafdb.counts(db);
  if (pre.jobs > 0 || pre.sweep_points > 0) {
    if (process.env.FORCE !== '1') {
      console.log('DB already populated (jobs=' + pre.jobs + ', sweep_points=' + pre.sweep_points + '). Set FORCE=1 to wipe and rebuild.');
      return;
    }
    db.exec('DELETE FROM sweep_points; DELETE FROM jobs;');
    console.log('FORCE=1: cleared existing rows.');
  }

  // ── results.csv -> jobs + sweep_points ──
  var R = readCsv(RESULTS_CSV);
  console.log('results.csv rows:', R.rows.length);
  var g = function (row, name) { var i = R.idx[name]; return i === undefined ? undefined : row[i]; };

  var jobsMap = {};     // job_id -> job fields
  var sweepMap = {};    // job_id -> { psid -> point }
  for (var r = 0; r < R.rows.length; r++) {
    var row = R.rows[r];
    var fp = g(row, 'file_path');
    var ts = g(row, 'timestamp');
    if (!fp || !ts) continue;
    var jobId = vmafdb.makeJobId(fp, ts);

    if (!jobsMap[jobId]) {
      var w = intg(g(row, 'video_width')), h = intg(g(row, 'video_height'));
      jobsMap[jobId] = {
        job_id: jobId,
        timestamp: str(ts),
        file_path: str(fp),
        file_name: str(g(row, 'file_name')),
        source_codec: str(g(row, 'video_codec')),
        source_width: w,
        source_height: h,
        bits_per_pixel: num(g(row, 'source_bits_per_pixel')),
        source_duration_sec: num(g(row, 'duration_seconds')),
        pixel_format: str(g(row, 'pixel_format')),
        bit_depth: bitDepthFromPixFmt(g(row, 'pixel_format')),
        is_hdr: bool01(g(row, 'is_hdr')),
        color_primaries: str(g(row, 'color_primaries')),
        color_trc: str(g(row, 'color_trc')),
        colorspace: str(g(row, 'colorspace')),
        tier: vmafdb.tierFor(w, h),
        media_genre: str(g(row, 'media_genre')),
        media_is_animation: bool01(g(row, 'media_is_animation')),
        media_type: str(g(row, 'media_type')),
        media_year: intg(g(row, 'media_year')),
        media_metadata_source: str(g(row, 'media_metadata_source')),
        media_source_type: str(g(row, 'media_source_type')),
        release_group: str(g(row, 'release_group')),
        selected_parameter_set_id: str(g(row, 'selected_parameter_set_id')),
        selected_vmaf: num(g(row, 'selected_vmaf')),
        selected_vmaf_min: num(g(row, 'selected_vmaf_min')),
        selected_size_mb: num(g(row, 'selected_size_mb'))
      };
      sweepMap[jobId] = {};
    }

    var psid = g(row, 'parameter_set_id');
    if (psid) {
      // dedup to one curve point per (job, parameter set); aggregated_* identical across its samples
      if (!sweepMap[jobId][psid]) {
        sweepMap[jobId][psid] = {
          parameter_set_id: str(psid),
          cq: num(g(row, 'cq')),
          preset: str(g(row, 'preset')),
          tune: str(g(row, 'tune')),
          multipass: str(g(row, 'multipass')),
          spatial_aq: str(g(row, 'spatial_aq')),
          temporal_aq: str(g(row, 'temporal_aq')),
          aq_strength: str(g(row, 'aq_strength')),
          vmaf_mean: num(g(row, 'aggregated_vmaf_mean')),
          vmaf_harmonic_mean: num(g(row, 'aggregated_vmaf_harmonic_mean')),
          vmaf_min: num(g(row, 'aggregated_vmaf_min')),
          vmaf_max: num(g(row, 'aggregated_vmaf_max')),
          vmaf_stddev: num(g(row, 'aggregated_vmaf_stddev')),
          cambi_mean: null,
          cambi_p95: null,
          avg_size_mb: num(g(row, 'aggregated_avg_size_mb')),
          sample_count: intg(g(row, 'aggregated_sample_count'))
        };
      }
      // selected CQ = cq of the selected parameter set
      var selPsid = g(row, 'selected_parameter_set_id');
      if (selPsid && psid === selPsid && jobsMap[jobId].selected_cq == null) {
        jobsMap[jobId].selected_cq = num(g(row, 'cq'));
      }
    }
  }

  var jobIds = Object.keys(jobsMap);
  var sweepTotal = 0;
  for (var ji = 0; ji < jobIds.length; ji++) {
    var jid = jobIds[ji];
    vmafdb.upsertJob(db, jobsMap[jid]);
    var pts = Object.keys(sweepMap[jid]).map(function (k) { return sweepMap[jid][k]; });
    sweepTotal += vmafdb.insertSweepPoints(db, jid, pts);
  }
  console.log('results -> jobs:', jobIds.length, '| sweep_points:', sweepTotal);

  // ── learning.csv -> standalone jobs (no curve; unique key from features+timestamp) ──
  var L = readCsv(LEARNING_CSV);
  console.log('learning.csv rows:', L.rows.length);
  var lg = function (row, name) { var i = L.idx[name]; return i === undefined ? undefined : row[i]; };
  var learnCount = 0;
  for (var lr = 0; lr < L.rows.length; lr++) {
    var lrow = L.rows[lr];
    var lts = lg(lrow, 'timestamp');
    if (!lts) continue;
    var lw = intg(lg(lrow, 'source_width')), lh = intg(lg(lrow, 'source_height'));
    var synthetic = 'L|' + str(lg(lrow, 'source_codec')) + '|' + lw + '|' + lh + '|' + str(lg(lrow, 'bits_per_pixel')) + '|' + str(lg(lrow, 'selected_cq'));
    var ljobId = 'L:' + vmafdb.makeJobId(synthetic, lts);
    vmafdb.upsertJob(db, {
      job_id: ljobId,
      timestamp: str(lts),
      source_codec: str(lg(lrow, 'source_codec')),
      source_width: lw,
      source_height: lh,
      source_bitrate_mbps: num(lg(lrow, 'source_bitrate_mbps')),
      bits_per_pixel: num(lg(lrow, 'bits_per_pixel')),
      source_duration_sec: num(lg(lrow, 'source_duration_sec')),
      tier: vmafdb.tierFor(lw, lh),
      media_genre: str(lg(lrow, 'media_genre')),
      media_is_animation: bool01(lg(lrow, 'media_is_animation')),
      media_type: str(lg(lrow, 'media_type')),
      media_year: intg(lg(lrow, 'media_year')),
      media_metadata_source: str(lg(lrow, 'media_metadata_source')),
      media_source_type: str(lg(lrow, 'media_source_type')),
      source_cambi: num(lg(lrow, 'source_cambi')),
      source_cambi_p95: num(lg(lrow, 'source_cambi_p95')),
      target_min_vmaf: num(lg(lrow, 'target_min_vmaf')),
      selected_cq: num(lg(lrow, 'selected_cq')),
      selected_vmaf: num(lg(lrow, 'selected_vmaf')),
      selected_cambi: num(lg(lrow, 'selected_cambi')),
      transcode_succeeded: bool01(lg(lrow, 'transcode_succeeded')),
      met_vmaf_target: bool01(lg(lrow, 'met_vmaf_target')),
      met_size_target: bool01(lg(lrow, 'met_size_target')),
      actual_size_reduction_pct: num(lg(lrow, 'actual_size_reduction_pct')),
      total_retries: intg(lg(lrow, 'total_retries')),
      transcode_retry_count: intg(lg(lrow, 'transcode_retry_count')),
      sweep_retry_count: intg(lg(lrow, 'sweep_retry_count')),
      cq_range_retry_count: intg(lg(lrow, 'cq_range_retry_count'))
    });
    learnCount++;
  }
  console.log('learning -> standalone jobs:', learnCount);

  var post = vmafdb.counts(db);
  console.log('FINAL counts:', JSON.stringify(post));
  // sanity reports
  var withCambi = db.prepare('SELECT COUNT(*) AS n FROM sweep_points WHERE cambi_mean IS NOT NULL').get().n;
  var withOutcome = db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE transcode_succeeded IS NOT NULL').get().n;
  var withCurve = db.prepare('SELECT COUNT(DISTINCT job_id) AS n FROM sweep_points').get().n;
  var tierDist = db.prepare('SELECT tier, COUNT(*) AS n FROM jobs GROUP BY tier ORDER BY n DESC').all();
  console.log('jobs with curves:', withCurve, '| jobs with outcome:', withOutcome, '| sweep rows with CAMBI:', withCambi);
  console.log('tier distribution:', JSON.stringify(tierDist));
  db.close();
}

main();
