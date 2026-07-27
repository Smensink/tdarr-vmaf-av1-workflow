'use strict';
/**
 * Backtest for the SWEEP-DOMAIN predictor: predict a centre CQ + uncertainty -> [min,max]
 * range to sweep, with the real objective = contain the true optimal CQ (coverage) using the
 * FEWEST test CQs (width). Compares two centring methods:
 *   (A) pooled (cq->VMAF) curve, find cq where pooled VMAF == target  [content-offset biased]
 *   (B) weighted distribution of similar jobs' OWN-curve optimal cq    [predict cq directly]
 * and reports, per uncertainty multiplier z, the coverage and mean width.
 */
var DB = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
var PRED = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafpredict.js');
var T = Number(process.env.TARGET || 95);

function optCq(pts, target) {
  pts = pts.map(p => ({ cq: +p.cq, vmaf: +p.vmaf_mean })).filter(p => isFinite(p.cq) && isFinite(p.vmaf)).sort((a, b) => a.cq - b.cq);
  if (pts.length < 2) return null;
  var mx = Math.max.apply(null, pts.map(p => p.vmaf)), mn = Math.min.apply(null, pts.map(p => p.vmaf));
  if (mx < target || mn >= target) return null;
  var best = null;
  for (var i = 0; i < pts.length - 1; i++) { var a = pts[i], b = pts[i + 1]; if (a.vmaf >= target && b.vmaf < target) best = a.cq + (a.vmaf - target) / (a.vmaf - b.vmaf) * (b.cq - a.cq); }
  return best;
}
function wQuantile(items, q) { // items: [{v,w}]
  var s = items.slice().sort((a, b) => a.v - b.v); var tot = s.reduce((a, b) => a + b.w, 0); if (tot <= 0) return null;
  var acc = 0; for (var i = 0; i < s.length; i++) { acc += s[i].w; if (acc >= q * tot) return s[i].v; } return s[s.length - 1].v;
}
function wStats(items) {
  var tot = items.reduce((a, b) => a + b.w, 0); if (tot <= 0) return null;
  var mean = items.reduce((a, b) => a + b.w * b.v, 0) / tot;
  var varc = items.reduce((a, b) => a + b.w * (b.v - mean) * (b.v - mean), 0) / tot;
  return { mean: mean, std: Math.sqrt(varc), median: wQuantile(items, 0.5), q25: wQuantile(items, 0.25), q75: wQuantile(items, 0.75) };
}

var db = DB.openDb();
var rows = DB.getSimilarSweepCurves(db, {}, { limit: 100000 });
var byJob = {}, byTier = {};
for (var i = 0; i < rows.length; i++) { var r = rows[i]; if (r.vmaf_mean == null) continue; (byJob[r.job_id] = byJob[r.job_id] || []).push(r); (byTier[r.tier || '?'] = byTier[r.tier || '?'] || []).push(r); }

// Precompute every job's own-curve optimal (for ground truth + as (B) training labels).
var jobOpt = {};
Object.keys(byJob).forEach(jid => { var o = optCq(byJob[jid], T); if (o != null) jobOpt[jid] = { opt: o, f: byJob[jid][0] }; });

// Test set = jobs with a wide, well-bracketed curve.
var tests = Object.keys(byJob).filter(jid => byJob[jid].length >= 6 && jobOpt[jid] != null)
  .map(jid => ({ jid: jid, opt: jobOpt[jid].opt, src: jobOpt[jid].f }));
console.log('test jobs (wide curve):', tests.length, '| labelled jobs:', Object.keys(jobOpt).length);

function weight(src, row) {
  var w = 1.0;
  var sb = +src.bits_per_pixel, hb = +row.bits_per_pixel;
  if (isFinite(sb) && sb > 0 && isFinite(hb) && hb > 0) { var rel = Math.abs(hb - sb) / Math.max(0.001, sb); w *= Math.exp(-(rel * rel) / (2 * 0.2 * 0.2)); }
  if (src.source_codec && row.source_codec) w *= PRED.codecCategory(src.source_codec) === PRED.codecCategory(row.source_codec) ? 1 : 0.5;
  var sa = src.media_is_animation ? 1 : 0, ha = row.media_is_animation ? 1 : 0; if (sa !== ha) w *= 0.5;
  var sh = src.is_hdr ? 1 : 0, hh = row.is_hdr ? 1 : 0; if (sh !== hh) w *= 0.7;
  return w > 0 ? w : 0;
}

// Method B: weighted distribution of neighbours' own-curve optimal cq.
function centerB(job) {
  var items = [];
  var pool = byTier[job.src.tier || '?'] || [];
  var seen = {};
  for (var k = 0; k < pool.length; k++) {
    var jid = pool[k].job_id; if (jid === job.jid || seen[jid] || jobOpt[jid] == null) continue; seen[jid] = 1;
    var w = weight(job.src, pool[k]); if (w <= 0) continue;
    items.push({ v: jobOpt[jid].opt, w: w });
  }
  if (items.length < 3) return null;
  return wStats(items);
}
// Method A: pooled curve crossing.
function centerA(job) {
  var nb = (byTier[job.src.tier || '?'] || []).filter(p => p.job_id !== job.jid);
  var r = PRED.selectCQ(nb, job.src, { targetVmaf: T }, { recencyHalfLifeDays: 0, minSupport: 0.5, nowMs: Date.now() });
  return r.cq;
}

// Evaluate centring accuracy.
function biasReport(label, fn) {
  var e = [], s = [];
  for (var t = 0; t < tests.length; t++) { var c = fn(tests[t]); if (c == null) continue; e.push(Math.abs(c - tests[t].opt)); s.push(c - tests[t].opt); }
  s.sort((a, b) => a - b); var mae = e.reduce((a, b) => a + b, 0) / (e.length || 1); var med = s[Math.floor(s.length / 2)];
  console.log(label.padEnd(30) + ' n=' + e.length + ' MAE=' + mae.toFixed(2) + ' medBias=' + med.toFixed(2));
}
console.log('\n=== centring accuracy vs true optimal ===');
biasReport('A: pooled-curve crossing', j => centerA(j));
biasReport('B: wMedian(neighbour optima)', j => centerB(j) ? centerB(j).median : null);

// Coverage vs width for method B with bias-corrected centre + z*spread.
console.log('\n=== B: range coverage vs width (centre=median, halfWidth=z*max(std,IQR/1.35)) ===');
[1.0, 1.28, 1.64, 2.0].forEach(function (z) {
  var cov = 0, wsum = 0, n = 0;
  for (var t = 0; t < tests.length; t++) {
    var st = centerB(tests[t]); if (st == null) continue; n++;
    var spread = Math.max(st.std, (st.q75 - st.q25) / 1.35, 1.0);
    var lo = st.median - z * spread, hi = st.median + z * spread;
    if (tests[t].opt >= lo && tests[t].opt <= hi) cov++;
    wsum += (hi - lo);
  }
  console.log('z=' + z.toFixed(2) + '  coverage=' + (cov / n * 100).toFixed(0) + '%  meanWidth=' + (wsum / n).toFixed(1) + ' CQ  (~' + Math.ceil((wsum / n) / 2) + ' tests at step2)');
});
db.close();
