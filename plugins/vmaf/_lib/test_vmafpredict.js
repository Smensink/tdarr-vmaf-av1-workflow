'use strict';
var P = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafpredict.js');
var pass = 0, fail = 0;
function eq(name, got, want, tol) {
  tol = tol || 0;
  var ok = (want === null) ? (got === null) : (got !== null && Math.abs(got - want) <= tol);
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + '  got=' + got + ' want=' + want);
  if (ok) pass++; else fail++;
}

// Example curve (from a real job): cq -> vmaf_mean. Higher cq = lower vmaf = smaller size.
var base = [
  [27, 96.9, 21.4], [29, 96.6, 19.3], [31, 96.0, 15.5], [33, 95.3, 12.2], [35, 94.6, 9.5],
  [37, 93.8, 7.1], [39, 92.9, 5.1], [41, 92.0, 3.6], [43, 91.1, 2.5], [45, 90.1, 1.9],
  [47, 88.9, 1.4], [49, 87.6, 1.2], [51, 86.2, 1.0]
];
function mkCurve(extra) {
  return base.map(function (r) {
    var o = {
      cq: r[0], vmaf_mean: r[1], avg_size_mb: r[2],
      bits_per_pixel: 0.08, source_codec: 'hevc', media_is_animation: 0, is_hdr: 0,
      timestamp: '2026-06-20T00:00:00Z'
    };
    if (extra) for (var k in extra) o[k] = extra[k](r);
    return o;
  });
}
var src = { bits_per_pixel: 0.08, source_codec: 'hevc', media_is_animation: 0, is_hdr: 0 };
var opts = { recencyHalfLifeDays: 0, nowMs: Date.parse('2026-06-23T00:00:00Z'), minSupport: 0.2 };

// Assert the CHOSEN cq satisfies the constraint (predicted metric) and that one cq higher
// would violate it - i.e. it is the maximal-compression feasible cq (allowing kernel
// interpolation to integer cqs between the sparse synthetic data points).
function checkMaximal(name, curve, srcF, cons, o, band) {
  var r = P.selectCQ(curve, srcF, cons, o);
  var meets = (r.predictedVmaf != null && r.predictedVmaf >= cons.targetVmaf - 0.15);
  var inBand = (r.cq >= band[0] && r.cq <= band[1]);
  var ok = meets && inBand;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + '  cq=' + r.cq + ' predVMAF=' + (r.predictedVmaf ? r.predictedVmaf.toFixed(2) : 'n/a') + ' (want VMAF>=' + cons.targetVmaf + ', cq in [' + band + '])');
  if (ok) pass++; else fail++;
  return r;
}
// 1) target 95 -> chosen vmaf>=95, cq around 32-34
checkMaximal('selectCQ target95', mkCurve(), src, { targetVmaf: 95 }, opts, [31, 34]);
// 2) target 93 -> chosen vmaf>=93, cq around 37-39
checkMaximal('selectCQ target93', mkCurve(), src, { targetVmaf: 93 }, opts, [37, 39]);
// 3) target 96 -> chosen vmaf>=96, cq around 29-31
checkMaximal('selectCQ target96', mkCurve(), src, { targetVmaf: 96 }, opts, [29, 31]);

// 4) CAMBI constraint pulls cq down: cambi_p95(cq) = (cq-30)*0.6.
var cambiCurve = mkCurve({ cambi_p95: function (r) { return Math.max(0, (r[0] - 30) * 0.6); } });
var rC = P.selectCQ(cambiCurve, src, { targetVmaf: 90, cambiFloor: 3 }, opts);
eq('selectCQ cambi3 predicted cambi<=floor', (rC.predictedCambi != null && rC.predictedCambi <= 3.2) ? 1 : 0, 1);
eq('selectCQ cambi3 cq pulled to ~35', (rC.cq <= 36 && rC.cq >= 33) ? 1 : 0, 1);

// 5) 1%-low floor: p1 = vmaf_mean - 6. Floor 88 -> chosen p1>=88.
var p1Curve = mkCurve({ vmaf_p1_low: function (r) { return r[1] - 6; } });
var rP = P.selectCQ(p1Curve, src, { targetVmaf: 90, vmafFloor: 88 }, opts);
eq('selectCQ p1floor88 chosen p1>=floor', (rP.predictedP1Low != null && rP.predictedP1Low >= 87.85) ? 1 : 0, 1);

// 6) dissimilar source down-weighted: animation source vs live-action curve still returns a cq
var animSrc = { bits_per_pixel: 0.08, source_codec: 'hevc', media_is_animation: 1, is_hdr: 0 };
eq('selectCQ anim-src still resolves', P.selectCQ(mkCurve(), animSrc, { targetVmaf: 95 }, opts).cq !== null ? 1 : 0, 1);

// 7) selectSampleCount: sd75 known -> N s.t. 1.64*sd/sqrt(N) <= tol
var stats = [];
for (var i = 0; i < 20; i++) stats.push({ vmaf_stddev: 1.0, sample_count: 4 });
// sd75 = 1.0, z=1.64, tol=0.75 -> need sqrt(N) >= 1.64*1.0/0.75 = 2.19 -> N>=4.78 -> N=5
eq('selectSampleCount N for sd1 tol0.75', P.selectSampleCount(stats, { toleranceVmaf: 0.75 }).sampleCount, 5);
// higher variance -> more samples
var stats2 = stats.map(function () { return { vmaf_stddev: 2.0, sample_count: 4 }; });
var sc2 = P.selectSampleCount(stats2, { toleranceVmaf: 0.75 });
eq('selectSampleCount more samples for higher SD', sc2.sampleCount > 5 ? 1 : 0, 1);

console.log('\nSYNTHETIC: ' + pass + ' passed, ' + fail + ' failed');

// ── Real DB smoke test ──
try {
  var vmafdb = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
  var db = vmafdb.openDb();
  var rsrc = { tier: '2160p', source_codec: 'hevc', bits_per_pixel: 0.06, media_is_animation: 0, is_hdr: 0 };
  var res = P.selectCQFromDb(db, vmafdb, rsrc, { targetVmaf: 95, vmafFloor: 88 }, { recencyHalfLifeDays: 0, minSupport: 0.5, limit: 20000 });
  console.log('\nREAL DB 2160p/hevc/bpp0.06 target95: cq=' + res.cq + ' predVMAF=' + (res.predictedVmaf ? res.predictedVmaf.toFixed(2) : 'n/a') +
    ' predSize=' + (res.predictedSizeMb ? res.predictedSizeMb.toFixed(1) + 'MB' : 'n/a') +
    ' conf=' + (res.confidence != null ? res.confidence.toFixed(2) : 'n/a') + ' neighbours=' + res.neighbours + ' binding=' + res.bindingConstraint);
  var sc = P.sampleStatsFromDb(db, vmafdb, rsrc, {});
  console.log('REAL DB sample-count: N=' + sc.sampleCount + ' sdEst=' + (sc.sdEstimate != null ? sc.sdEstimate.toFixed(3) : 'n/a') + ' (' + sc.reason + ')');
  db.close();
} catch (e) { console.log('REAL DB test skipped:', e.message); }

process.exit(fail > 0 ? 1 : 0);
