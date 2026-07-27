'use strict';
/**
 * Validate the "fewest test transcodes" claim. For each wide-curve job we treat its measured
 * curve as ground truth, predict the anchor centre from OTHER jobs (leave-one-out), then run
 * the sequential nextSweepCQ loop - "measuring" VMAF by interpolating the job's true curve -
 * and count transcodes to converge within tolerance of the target. Compares to a static grid.
 */
var DB = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
var P = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafpredict.js');
var T = Number(process.env.TARGET || 95);
var TOL = Number(process.env.TOL || 0.5);

var db = DB.openDb();
var rows = DB.getSimilarSweepCurves(db, {}, { limit: 100000 });
var byJob = {}, byTier = {};
for (var i = 0; i < rows.length; i++) { var r = rows[i]; if (r.vmaf_mean == null || r.cq == null) continue; (byJob[r.job_id] = byJob[r.job_id] || []).push(r); (byTier[r.tier || '?'] = byTier[r.tier || '?'] || []).push(r); }

function curvePts(jid) { return byJob[jid].map(function (p) { return { cq: +p.cq, v: +p.vmaf_mean }; }).filter(function (p) { return isFinite(p.cq) && isFinite(p.v); }).sort(function (a, b) { return a.cq - b.cq; }); }
function interpVmaf(pts, cq) { // measure VMAF at arbitrary cq: interp within range, LINEAR extrapolate outside
  var n = pts.length;
  if (cq <= pts[0].cq) { var s0 = (pts[1].v - pts[0].v) / (pts[1].cq - pts[0].cq); return pts[0].v + s0 * (cq - pts[0].cq); }
  if (cq >= pts[n - 1].cq) { var s1 = (pts[n - 1].v - pts[n - 2].v) / (pts[n - 1].cq - pts[n - 2].cq); return pts[n - 1].v + s1 * (cq - pts[n - 1].cq); }
  for (var i = 0; i < n - 1; i++) { if (cq >= pts[i].cq && cq <= pts[i + 1].cq) { var f = (cq - pts[i].cq) / (pts[i + 1].cq - pts[i].cq); return pts[i].v + f * (pts[i + 1].v - pts[i].v); } }
  return pts[n - 1].v;
}
function optOf(pts) { return P.curveOptimalAtTarget(pts.map(function (p) { return { cq: p.cq, vmaf_mean: p.v }; }), T); }

var tests = Object.keys(byJob).filter(function (jid) { return byJob[jid].length >= 6 && optOf(curvePts(jid)) != null; })
  .map(function (jid) { var f = byJob[jid][0]; return { jid: jid, pts: curvePts(jid), opt: optOf(curvePts(jid)), src: { tier: f.tier, source_codec: f.source_codec, bits_per_pixel: f.bits_per_pixel, media_is_animation: f.media_is_animation, is_hdr: f.is_hdr } }; });
console.log('test jobs (wide curve):', tests.length, '| tolerance +-' + TOL + ' VMAF of target ' + T);

function simulate(job, opts) {
  var measured = [], nTests = 0, maxT = 8;
  // anchor centre from leave-one-out neighbours
  var nb = (byTier[job.src.tier || '?'] || []).filter(function (p) { return p.job_id !== job.jid; });
  var ctr = P.predictCQCenter(nb, job.src, { targetVmaf: T }, { recencyHalfLifeDays: 0 });
  var center = ctr.centerCq != null ? ctr.centerCq : 33;
  while (nTests < maxT) {
    var step = P.nextSweepCQ(measured, { targetVmaf: T }, { centerCq: center, toleranceVmaf: TOL, priorSlope: -0.4 });
    if (step.cq == null) return { tests: nTests, finalCq: step.cqFinal, conv: true };
    var v = interpVmaf(job.pts, step.cq);
    measured.push({ cq: step.cq, vmaf_mean: v });
    nTests++;
  }
  // not converged within maxT: final = constrained optimizer on measured
  var sel = P.selectCQ(measured.map(function (m) { return { cq: m.cq, vmaf_mean: m.vmaf_mean, bits_per_pixel: job.src.bits_per_pixel, source_codec: job.src.source_codec }; }), job.src, { targetVmaf: T }, { minSupport: 0.05 });
  return { tests: nTests, finalCq: sel.cq, conv: false };
}

var counts = [], errs = [], nonconv = 0;
for (var t = 0; t < tests.length; t++) {
  var r = simulate(tests[t]);
  counts.push(r.tests);
  if (!r.conv) nonconv++;
  if (r.finalCq != null) errs.push(Math.abs(r.finalCq - tests[t].opt));
}
counts.sort(function (a, b) { return a - b; });
errs.sort(function (a, b) { return a - b; });
var mean = counts.reduce(function (a, b) { return a + b; }, 0) / counts.length;
var mae = errs.reduce(function (a, b) { return a + b; }, 0) / (errs.length || 1);
console.log('\n=== SEQUENTIAL sweep (centre B + secant) ===');
console.log('transcodes to converge: mean=' + mean.toFixed(2) + ' median=' + counts[Math.floor(counts.length / 2)] + ' p90=' + counts[Math.floor(0.9 * counts.length)] + ' max=' + counts[counts.length - 1]);
console.log('final CQ error vs optimal: MAE=' + mae.toFixed(2) + ' within1=' + (errs.filter(function (e) { return e <= 1; }).length / errs.length * 100).toFixed(0) + '% within2=' + (errs.filter(function (e) { return e <= 2; }).length / errs.length * 100).toFixed(0) + '%');
console.log('did not converge within 8 tests: ' + nonconv + '/' + tests.length);

// Static-grid baseline: how many CQs would a fixed +-N range need to bracket the optimum?
console.log('\n=== STATIC grid baseline (for comparison) ===');
console.log('Method-B range for 88% coverage was ~12 CQ wide = ~6 transcodes at step 2 (from ab_sweepdomain).');
db.close();
