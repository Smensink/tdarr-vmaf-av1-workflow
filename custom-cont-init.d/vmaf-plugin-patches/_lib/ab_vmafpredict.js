'use strict';
/**
 * A/B backtest for selectCQ. Leave-one-out: for each test job that has a curve bracketing
 * the target, the "ground truth" optimal cq is read from the job's OWN measured curve; the
 * prediction comes from selectCQ over OTHER jobs' curves. Compares recency windows to answer:
 * does limiting to recent data improve accuracy, or is all data beneficial?
 *
 *   docker exec tdarr node /custom-cont-init.d/vmaf-plugin-patches/_lib/ab_vmafpredict.js
 */
var vmafdb = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafpredict.js'); // predictor
var DB = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');

var TARGET = Number(process.env.TARGET || 95);
var MAX_TEST_JOBS = Number(process.env.MAX_TEST_JOBS || 400);

function interpHighestCqAtTarget(points, target) {
  // points sorted by cq asc; vmaf decreases with cq. Return highest cq with vmaf>=target.
  var pts = points.filter(function (p) { return isFinite(p.cq) && isFinite(p.vmaf); }).sort(function (a, b) { return a.cq - b.cq; });
  if (pts.length < 2) return null;
  var maxV = Math.max.apply(null, pts.map(function (p) { return p.vmaf; }));
  var minV = Math.min.apply(null, pts.map(function (p) { return p.vmaf; }));
  if (maxV < target || minV >= target) return null; // not bracketed -> optimal outside tested range
  var best = null;
  for (var i = 0; i < pts.length - 1; i++) {
    var a = pts[i], b = pts[i + 1];
    // crossing where vmaf goes from >=target to <target between a(lower cq) and b(higher cq)
    if (a.vmaf >= target && b.vmaf < target) {
      var frac = (a.vmaf - target) / (a.vmaf - b.vmaf);
      best = a.cq + frac * (b.cq - a.cq);
    }
  }
  if (best === null) {
    // all-above handled above; pick highest cq still >=target
    for (var j = pts.length - 1; j >= 0; j--) if (pts[j].vmaf >= target) { best = pts[j].cq; break; }
  }
  return best;
}

function main() {
  var db = DB.openDb();
  // Load all curve points with job features, newest first.
  var rows = DB.getSimilarSweepCurves(db, {}, { limit: 100000 });
  console.log('loaded curve points:', rows.length);

  // Group by job for ground truth; index points by tier for fast neighbour sets.
  var byJob = {}, byTier = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.vmaf_mean == null) continue;
    (byJob[r.job_id] = byJob[r.job_id] || []).push(r);
    var t = r.tier || '?';
    (byTier[t] = byTier[t] || []).push(r);
  }

  // Candidate test jobs: curve brackets target, >=4 points.
  var testJobs = [];
  Object.keys(byJob).forEach(function (jid) {
    var pts = byJob[jid].map(function (p) { return { cq: Number(p.cq), vmaf: Number(p.vmaf_mean) }; });
    if (pts.length < 4) return;
    var opt = interpHighestCqAtTarget(pts, TARGET);
    if (opt === null) return;
    var f = byJob[jid][0];
    testJobs.push({ job_id: jid, optimal: opt, src: { tier: f.tier, source_codec: f.source_codec, bits_per_pixel: f.bits_per_pixel, media_is_animation: f.media_is_animation, media_genre: f.media_genre, is_hdr: f.is_hdr } });
  });
  // sample
  testJobs.sort(function () { return Math.random() - 0.5; });
  if (testJobs.length > MAX_TEST_JOBS) testJobs = testJobs.slice(0, MAX_TEST_JOBS);
  console.log('test jobs (curve brackets VMAF ' + TARGET + '):', testJobs.length);

  function neighboursFor(job, window, recencyHL) {
    // same-tier points, excluding this job, optionally limited to most-recent `window`
    var pool = byTier[job.src.tier || '?'] || [];
    var out = [];
    for (var k = 0; k < pool.length; k++) {
      if (pool[k].job_id === job.job_id) continue;
      out.push(pool[k]);
    }
    // pool is already newest-first (rows were ordered DESC); slice for window
    if (window && out.length > window) out = out.slice(0, window);
    return out;
  }

  function run(label, window, recencyHL) {
    var errs = [], signed = [], nResolved = 0;
    var nowMs = Date.now();
    for (var t = 0; t < testJobs.length; t++) {
      var job = testJobs[t];
      var nb = neighboursFor(job, window, recencyHL);
      var res = vmafdb.selectCQ(nb, job.src, { targetVmaf: TARGET }, { recencyHalfLifeDays: recencyHL, nowMs: nowMs, minSupport: 0.5 });
      if (res.cq == null) continue;
      nResolved++;
      var e = res.cq - job.optimal;
      errs.push(Math.abs(e)); signed.push(e);
    }
    errs.sort(function (a, b) { return a - b; });
    var mae = errs.reduce(function (a, b) { return a + b; }, 0) / (errs.length || 1);
    var med = errs.length ? errs[Math.floor(errs.length / 2)] : null;
    var bias = signed.reduce(function (a, b) { return a + b; }, 0) / (signed.length || 1);
    var w1 = errs.filter(function (e) { return e <= 1; }).length / (errs.length || 1);
    var w2 = errs.filter(function (e) { return e <= 2; }).length / (errs.length || 1);
    console.log(pad(label, 22) + ' n=' + pad(nResolved, 4) + ' MAE=' + mae.toFixed(2) + ' median=' + (med != null ? med.toFixed(2) : 'n/a') +
      ' bias=' + bias.toFixed(2) + ' within1=' + (w1 * 100).toFixed(0) + '% within2=' + (w2 * 100).toFixed(0) + '%');
    return { mae: mae, w2: w2 };
  }
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

  console.log('\n=== leave-one-out CQ prediction error (target VMAF ' + TARGET + ') ===');
  run('all-data', null, 0);
  run('all-data+recency', null, 120);
  run('recent-10k', 10000, 0);
  run('recent-5k', 5000, 0);
  run('recent-2k', 2000, 0);
  db.close();
}
main();
