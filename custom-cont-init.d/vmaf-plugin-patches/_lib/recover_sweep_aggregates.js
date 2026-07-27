'use strict';
/**
 * Recover the column-misaligned sweep_points aggregates in vmaf_training.db.
 *
 * The legacy CSV writer (exportVMAFResults' appendFileSync path) wrote the aggregated_* block in a
 * shifted column order, so the backfill imported garbage into vmaf_mean/min/max/stddev/sample_count
 * for ~92% of rows (symptom: vmaf_min > vmaf_max, non-integer sample_count). The PER-SAMPLE columns
 * (sample_vmaf_mean/min/max/file_size) sit BEFORE the desync and are intact, so we recompute each
 * (job, parameter set) aggregate from its sample rows - which is strictly more authoritative than
 * any aggregated column (verified: recomputed mean == the one correct aggregated_vmaf_harmonic_mean).
 *
 *   DRY_RUN=1 docker exec tdarr node /custom-cont-init.d/vmaf-plugin-patches/_lib/recover_sweep_aggregates.js
 *   docker exec tdarr node /custom-cont-init.d/vmaf-plugin-patches/_lib/recover_sweep_aggregates.js   (apply)
 */
var fs = require('fs');
var vmafdb = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');

var RESULTS_CSV = process.env.RESULTS_CSV || '/app/configs/vmaf_results.csv';
var DB_PATH = process.env.DB_PATH || '/app/configs/vmaf_training.db';
var DRY = process.env.DRY_RUN === '1';
var ALL = process.env.ALL === '1'; // recompute every row, not just the currently-corrupt ones

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
function num(v) { if (v === undefined || v === null || v === '') return null; var n = parseFloat(v); return isFinite(n) ? n : null; }

function main() {
  var lines = fs.readFileSync(RESULTS_CSV, 'utf8').split(/\r?\n/);
  var header = splitLine(lines[0]); var idx = {};
  for (var i = 0; i < header.length; i++) idx[header[i].trim()] = i;
  var I = {
    fp: idx.file_path, ts: idx.timestamp, psid: idx.parameter_set_id,
    sMean: idx.sample_vmaf_mean, sMin: idx.sample_vmaf_min, sMax: idx.sample_vmaf_max,
    sHarm: idx.sample_vmaf_harmonic_mean, sSize: idx.sample_file_size_mb
  };

  // group per (job_id, parameter_set_id) -> sample arrays
  var groups = {};
  for (var j = 1; j < lines.length; j++) {
    if (!lines[j]) continue;
    var f = splitLine(lines[j]);
    var fp = f[I.fp], ts = f[I.ts], psid = f[I.psid];
    if (!fp || !ts || !psid) continue;
    var jobId = vmafdb.makeJobId(fp, ts);
    var key = jobId + '\0' + psid;
    var grp = groups[key] || (groups[key] = { jobId: jobId, psid: psid, mean: [], min: [], max: [], harm: [], size: [] });
    var m = num(f[I.sMean]), mn = num(f[I.sMin]), mx = num(f[I.sMax]), hm = num(f[I.sHarm]), sz = num(f[I.sSize]);
    if (m != null) grp.mean.push(m);
    if (mn != null) grp.min.push(mn);
    if (mx != null) grp.max.push(mx);
    if (hm != null) grp.harm.push(hm);
    if (sz != null) grp.size.push(sz);
  }

  function avg(a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; }
  function harm(a) { var s = 0, n = 0; for (var k = 0; k < a.length; k++) { if (a[k] > 0) { s += 1 / a[k]; n++; } } return n ? n / s : null; }
  function std(a) { if (a.length < 2) return 0; var m = avg(a); return Math.sqrt(a.reduce(function (x, y) { return x + (y - m) * (y - m); }, 0) / (a.length - 1)); }

  var db = vmafdb.openDb(DB_PATH);
  db.exec('PRAGMA busy_timeout = 30000;');
  // match the DB row by (job_id, parameter_set_id); read current state to decide corrupt vs ok
  var sel = db.prepare('SELECT id, vmaf_mean, vmaf_min, vmaf_max, sample_count FROM sweep_points WHERE job_id = ? AND parameter_set_id = ?');
  var upd = db.prepare('UPDATE sweep_points SET vmaf_mean=?, vmaf_harmonic_mean=?, vmaf_min=?, vmaf_max=?, vmaf_stddev=?, sample_count=?, avg_size_mb=? WHERE id=?');

  function isCorrupt(r) {
    if (r.vmaf_min != null && r.vmaf_max != null && r.vmaf_min > r.vmaf_max) return true;
    if (r.vmaf_mean != null && r.vmaf_min != null && r.vmaf_max != null && (r.vmaf_mean < r.vmaf_min || r.vmaf_mean > r.vmaf_max)) return true;
    if (r.sample_count != null && Math.abs(r.sample_count - Math.round(r.sample_count)) > 1e-9) return true;
    return false;
  }

  var stats = { groups: 0, matched: 0, corrupt: 0, updated: 0, noSamples: 0, recomputeBad: 0, skippedOk: 0 };
  var samples = [];
  if (!DRY) db.exec('BEGIN');
  try {
    for (var key in groups) {
      if (!Object.prototype.hasOwnProperty.call(groups, key)) continue;
      var g = groups[key]; stats.groups++;
      if (g.mean.length === 0 || g.min.length === 0 || g.max.length === 0) { stats.noSamples++; continue; }
      var rec = {
        vmaf_mean: avg(g.mean),
        vmaf_harmonic_mean: g.harm.length ? harm(g.harm) : harm(g.mean),
        vmaf_min: Math.min.apply(null, g.min),
        vmaf_max: Math.max.apply(null, g.max),
        vmaf_stddev: std(g.mean),
        sample_count: g.mean.length,
        avg_size_mb: g.size.length ? avg(g.size) : null
      };
      // This repair consumes the pre-contract legacy CSV only. Its GPU-v0 rows
      // retain the historical 0-100 bound; native VMAF-v1 evidence is never
      // reconstructed by this utility and must remain in its exact-contract DB path.
      // Recomputed values must themselves be physically sane before we trust them.
      if (!(rec.vmaf_min <= rec.vmaf_mean && rec.vmaf_mean <= rec.vmaf_max && rec.vmaf_max <= 100.0001)) { stats.recomputeBad++; continue; }
      var dbrows = sel.all(g.jobId, g.psid);
      for (var d = 0; d < dbrows.length; d++) {
        stats.matched++;
        var r = dbrows[d];
        var corrupt = isCorrupt(r);
        if (corrupt) stats.corrupt++;
        if (!ALL && !corrupt) { stats.skippedOk++; continue; }
        if (samples.length < 6) samples.push({ job: g.jobId.slice(0, 24), psid: g.psid, was: { mean: r.vmaf_mean, min: r.vmaf_min, max: r.vmaf_max, sc: r.sample_count }, now: { mean: +rec.vmaf_mean.toFixed(3), min: +rec.vmaf_min.toFixed(3), max: +rec.vmaf_max.toFixed(3), sc: rec.sample_count } });
        if (!DRY) upd.run(rec.vmaf_mean, rec.vmaf_harmonic_mean, rec.vmaf_min, rec.vmaf_max, rec.vmaf_stddev, rec.sample_count, rec.avg_size_mb, r.id);
        stats.updated++;
      }
    }
    if (!DRY) db.exec('COMMIT');
  } catch (e) {
    if (!DRY) { try { db.exec('ROLLBACK'); } catch (e2) {} }
    throw e;
  }

  console.log((DRY ? '[DRY RUN] ' : '[APPLIED] ') + 'mode=' + (ALL ? 'ALL' : 'corrupt-only'));
  console.log(JSON.stringify(stats, null, 0));
  console.log('sample changes:');
  samples.forEach(function (s) { console.log('  ' + s.job + ' ' + s.psid + '  was ' + JSON.stringify(s.was) + ' -> ' + JSON.stringify(s.now)); });
  // post-condition check
  var stillBad = db.prepare('SELECT COUNT(*) n FROM sweep_points WHERE vmaf_min > vmaf_max').get().n;
  console.log('rows still vmaf_min>vmaf_max after' + (DRY ? ' (DRY, unchanged)' : '') + ': ' + stillBad);
  db.close();
}
main();
