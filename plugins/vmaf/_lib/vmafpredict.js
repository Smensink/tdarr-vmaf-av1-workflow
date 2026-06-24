'use strict';
/**
 * vmafpredict.js - unified CQ + sample-count predictor for the Tdarr VMAF/AV1 flow.
 *
 * Replaces the scattered legacy logic (loadHistoricalCqPoints, the kNN selected_cq range,
 * the source-CAMBI slope, the per-strategy selection sprawl, and the ridge-knee sample-count
 * model) with two functions over the per-CQ curves in vmaf_training.db:
 *
 *   selectCQ(curveRows, src, constraints, opts)
 *     Pool (cq -> VMAF_mean, VMAF 1%-low, CAMBI, size) curve points from similar past
 *     sweeps, weight by source similarity x recency, and pick the HIGHEST cq (= smallest
 *     file) whose estimated metrics still satisfy ALL quality constraints:
 *       VMAF_mean >= targetVmaf, VMAF_p1_low >= vmafFloor, CAMBI <= cambiFloor.
 *     Constraints whose signal is absent in the data (e.g. CAMBI/1%-low on backfilled
 *     historical rows) are simply not enforced until that data accrues.
 *
 *   selectSampleCount(statRows, opts)
 *     CI-based stopping: pick the smallest N whose estimated standard error of the mean
 *     VMAF (stddev/sqrt(N)) is within tolerance, bounded by [minSamples, maxSamples].
 *
 * Pure functions take pre-fetched rows so they are unit-testable without a DB. DB wrappers
 * (selectCQFromDb / sampleStatsFromDb) fetch from vmafdb and delegate.
 */

var CQ_MIN = 16;
var CQ_MAX = 51;

// ── codec category (mirror of the legacy codecCategory buckets) ──
function codecCategory(c) {
  c = String(c || '').toLowerCase();
  if (c.indexOf('av1') !== -1) return 'av1';
  if (c.indexOf('hevc') !== -1 || c.indexOf('h265') !== -1 || c.indexOf('x265') !== -1 || c.indexOf('265') !== -1) return 'hevc';
  if (c.indexOf('h264') !== -1 || c.indexOf('x264') !== -1 || c.indexOf('avc') !== -1 || c.indexOf('264') !== -1) return 'h264';
  if (c.indexOf('vp9') !== -1) return 'vp9';
  if (c.indexOf('mpeg2') !== -1 || c.indexOf('mpeg-2') !== -1) return 'mpeg2';
  return c || 'other';
}

function isAnimGenre(genre) {
  var g = String(genre || '').toLowerCase();
  return g.indexOf('animation') !== -1 || g.indexOf('anime') !== -1 || g.indexOf('cartoon') !== -1;
}

// Parse a genre value (array OR comma/pipe-delimited string) into a lowercased token set.
function genreSet(g) {
  if (Array.isArray(g)) g = g.join(',');
  var out = [];
  String(g || '').toLowerCase().replace(/\|/g, ',').split(',').forEach(function (t) {
    t = t.trim(); if (t && out.indexOf(t) === -1) out.push(t);
  });
  return out;
}

/**
 * Correlation ratio eta^2 of a numeric target grouped by a categorical label: the fraction of the
 * target's variance EXPLAINED by the grouping. eta^2 in [0,1]; ~1 = the label nearly determines the
 * target, ~0 = the label is uninformative. Needs >=minPerGroup members in >=2 groups to count a
 * group, and >=minN usable points overall, else returns null (not enough data to judge).
 */
function correlationRatio(values, labels, opts) {
  opts = opts || {};
  var minPerGroup = opts.minPerGroup || 2;
  var minN = opts.minN || 12;
  var groups = {}, n = 0, sum = 0;
  for (var i = 0; i < values.length; i++) {
    var v = values[i], l = labels[i];
    if (v == null || !isFinite(v) || l == null || l === '') continue;
    (groups[l] = groups[l] || []).push(v); sum += v; n++;
  }
  if (n < minN) return null;
  var mean = sum / n;
  var ssTot = 0;
  for (var k in groups) { if (!groups.hasOwnProperty(k)) continue; var a = groups[k]; for (var j = 0; j < a.length; j++) ssTot += (a[j] - mean) * (a[j] - mean); }
  if (ssTot <= 1e-9) return null;
  var ssBetween = 0, usableGroups = 0, usableN = 0;
  for (var g in groups) {
    if (!groups.hasOwnProperty(g)) continue;
    var arr = groups[g];
    if (arr.length < minPerGroup) continue;
    var gm = 0; for (var m = 0; m < arr.length; m++) gm += arr[m]; gm /= arr.length;
    ssBetween += arr.length * (gm - mean) * (gm - mean);
    usableGroups++; usableN += arr.length;
  }
  if (usableGroups < 2 || usableN < minN) return null;
  return Math.max(0, Math.min(1, ssBetween / ssTot));
}

/**
 * LEARN the per-feature mismatch penalties for the similarity kernel from the data, instead of
 * hand-picking them. For each categorical metadata field we measure eta^2 (how much it explains the
 * spread of the per-job optimum CQ) and turn it into a mismatch penalty: an informative field gets a
 * strong penalty (down to penaltyFloor) so non-matching neighbours are discounted; an uninformative
 * field gets ~1.0 (ignored). Recomputed every prediction from the current neighbour set, so the
 * weighting self-updates as data accrues and reveals (via etaSquared) which metadata actually matters.
 *
 *   items: [{opt:Number, f:{media_genre, media_type, network, original_language, source_codec}}]
 */
function learnFeatureWeights(items, opts) {
  opts = opts || {};
  var floor = opts.penaltyFloor != null ? opts.penaltyFloor : 0.15;
  // ALL categorical/bucketable metadata covariates - the data decides which matter (no hand-picking
  // which fields to even look at). media_year is decade-bucketed; numeric covariates (bpp,
  // source_cambi) are handled by proximity kernels in weightForPoint, not here.
  var fields = ['media_genre', 'media_type', 'network', 'original_language', 'source_codec',
                'release_group', 'media_year'];
  var vals = [];
  for (var i = 0; i < items.length; i++) vals.push(Number(items[i].opt));
  var penalty = {}, etaSquared = {};
  for (var fi = 0; fi < fields.length; fi++) {
    var ft = fields[fi];
    var labels = items.map(function (it) {
      var x = it.f ? it.f[ft] : null;
      if (ft === 'media_genre') x = genreSet(x).slice().sort().join('|'); // canonical multi-genre key
      else if (ft === 'source_codec') x = codecCategory(x);
      else if (ft === 'media_year') { var y = Number(x); x = (isFinite(y) && y >= 1900 && y <= 2100) ? (Math.floor(y / 10) * 10) + 's' : null; }
      return (x == null || x === '') ? null : String(x).toLowerCase();
    });
    var e = correlationRatio(vals, labels, opts);
    etaSquared[ft] = e;
    penalty[ft] = (e == null) ? null : (1 - e * (1 - floor)); // e~1 -> floor; e~0 -> 1 (no penalty)
  }
  return { penalty: penalty, etaSquared: etaSquared, n: items.length };
}

/**
 * Source-similarity x recency weight for one historical curve row.
 * Curves are target-INDEPENDENT, so target VMAF is intentionally NOT a weighting term.
 */
function weightForPoint(src, row, opts) {
  opts = opts || {};
  var w = 1.0;

  // bits-per-pixel (Gaussian over relative difference)
  var sbpp = Number(src.bits_per_pixel);
  var hbpp = Number(row.bits_per_pixel);
  if (isFinite(sbpp) && sbpp > 0 && isFinite(hbpp) && hbpp > 0) {
    var rel = Math.abs(hbpp - sbpp) / Math.max(0.001, sbpp);
    var sigma = opts.bppSigma || 0.25;
    w *= Math.exp(-(rel * rel) / (2 * sigma * sigma));
  }

  // codec category (soft)
  if (src.source_codec && row.source_codec) {
    w *= (codecCategory(src.source_codec) === codecCategory(row.source_codec)) ? 1.0 : 0.55;
  }

  // animation (strong: animation vs live action compress very differently)
  var sAnim = (src.media_is_animation === 1 || src.media_is_animation === true) ? true
    : (isAnimGenre(src.media_genre) ? true : null);
  var hAnim = (row.media_is_animation === 1 || row.media_is_animation === true) ? true
    : (isAnimGenre(row.media_genre) ? true : null);
  if (sAnim !== null && hAnim !== null) w *= (sAnim === hAnim) ? 1.0 : 0.5;

  // HDR (tonemapped measurement differs)
  if (src.is_hdr !== undefined && row.is_hdr !== undefined && src.is_hdr !== null && row.is_hdr !== null) {
    var sH = src.is_hdr ? 1 : 0, hH = row.is_hdr ? 1 : 0;
    if (sH !== hH) w *= 0.7;
  }

  // ── Metadata factors. The mismatch penalty per field is LEARNED from the data (opts.weights.penalty,
  //    from learnFeatureWeights' eta^2) when available; the hand value is only a cold-start fallback
  //    that fades as the learned penalty takes over. Each field is skipped when absent on either side
  //    so sparse metadata never penalises. ──
  var _pen = (opts.weights && opts.weights.penalty) || {};
  var _P = function (name, dflt) { return (_pen[name] != null && isFinite(_pen[name])) ? _pen[name] : dflt; };
  // genre overlap (Jaccard): learned floor pg when disjoint, 1.0 when identical
  var sg = genreSet(src.media_genre), hg = genreSet(row.media_genre);
  if (sg.length && hg.length) {
    var inter = 0; for (var gi = 0; gi < sg.length; gi++) if (hg.indexOf(sg[gi]) !== -1) inter++;
    var uni = sg.length + hg.length - inter;
    var jac = uni > 0 ? inter / uni : 0;
    var pg = _P('media_genre', 0.6);
    w *= pg + (1 - pg) * jac;
  }
  if (src.media_type && row.media_type) {
    w *= (String(src.media_type).toLowerCase() === String(row.media_type).toLowerCase()) ? 1.0 : _P('media_type', 0.85);
  }
  if (src.network && row.network) {
    w *= (String(src.network).toLowerCase() === String(row.network).toLowerCase()) ? 1.0 : _P('network', 0.92);
  }
  if (src.original_language && row.original_language) {
    w *= (String(src.original_language).toLowerCase() === String(row.original_language).toLowerCase()) ? 1.0 : _P('original_language', 0.94);
  }
  // release group = a strong encode-style proxy (NTb/FLUX/HONE etc. have characteristic grain/grade)
  if (src.release_group && row.release_group) {
    w *= (String(src.release_group).toLowerCase() === String(row.release_group).toLowerCase()) ? 1.0 : _P('release_group', 0.85);
  }
  // release year proximity (older content grades/grains differently); guard implausible parsed years
  var syr = Number(src.media_year), hyr = Number(row.media_year);
  if (isFinite(syr) && isFinite(hyr) && syr >= 1900 && hyr >= 1900) {
    var dyr = syr - hyr; w *= Math.exp(-(dyr * dyr) / (2 * 15 * 15));
  }
  // source banding proximity (numeric; already-banded sources tolerate a lower cq before the floor binds)
  var ssc = Number(src.source_cambi), hsc = Number(row.source_cambi);
  if (isFinite(ssc) && isFinite(hsc)) {
    var dsc = ssc - hsc; w *= Math.exp(-(dsc * dsc) / (2 * 3.0 * 3.0));
  }

  // recency (encoder settings drift). Half-life in days; disabled when recencyHalfLifeDays<=0.
  var hl = (opts.recencyHalfLifeDays === undefined) ? 120 : opts.recencyHalfLifeDays;
  if (hl > 0 && row.timestamp && opts.nowMs) {
    var t = Date.parse(row.timestamp);
    if (isFinite(t)) {
      var ageDays = Math.max(0, (opts.nowMs - t) / 86400000);
      w *= Math.pow(0.5, ageDays / hl);
    }
  }

  return (isFinite(w) && w > 0) ? w : 0;
}

/** Weighted Nadaraya-Watson estimate of a metric at cq0 (kernel over cq). */
function kernelEstimate(points, cq0, h) {
  // points: [{cq, val, w}]
  var num = 0, den = 0, support = 0, count = 0;
  var inv2h2 = 1 / (2 * h * h);
  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    if (p.val === null || p.val === undefined || !isFinite(p.val)) continue;
    var d = p.cq - cq0;
    var k = Math.exp(-(d * d) * inv2h2) * p.w;
    if (k <= 0) continue;
    num += k * p.val;
    den += k;
    support += k;
    if (Math.abs(d) <= h) count += 1;
  }
  if (den <= 0) return { val: null, support: 0, count: 0 };
  return { val: num / den, support: support, count: count };
}

/**
 * Select CQ subject to quality constraints, maximizing compression (highest feasible cq).
 *
 * curveRows: rows from vmafdb.getSimilarSweepCurves (each: cq, vmaf_mean, vmaf_p1_low,
 *            cambi_mean/p95, avg_size_mb, + job features for weighting).
 * src:       current source features {bits_per_pixel, source_codec, media_*, is_hdr, ...}
 * constraints: {targetVmaf, vmafFloor, cambiFloor, sizeBudgetMb}
 * opts:      {cqBandwidth, minSupport, bppSigma, recencyHalfLifeDays, nowMs, cambiMetric}
 */
function selectCQ(curveRows, src, constraints, opts) {
  constraints = constraints || {};
  opts = opts || {};
  var target = Number(constraints.targetVmaf);
  var vmafFloor = constraints.vmafFloor != null ? Number(constraints.vmafFloor) : null;
  var cambiFloor = effectiveCambiFloor(constraints); // source-relative (raised when source already banded)
  var sizeBudget = constraints.sizeBudgetMb != null ? Number(constraints.sizeBudgetMb) : null;
  var h = opts.cqBandwidth || 2.0;
  var minSupport = opts.minSupport || 0.75;
  var cambiKey = opts.cambiMetric || 'cambi_p95';

  // Build weighted point sets per metric.
  var vmafPts = [], p1Pts = [], cambiPts = [], sizePts = [];
  var nowMs = opts.nowMs || Date.now();
  var wOpts = { bppSigma: opts.bppSigma, recencyHalfLifeDays: opts.recencyHalfLifeDays, nowMs: nowMs };
  var totalW = 0, nRows = 0;
  for (var i = 0; i < curveRows.length; i++) {
    var row = curveRows[i];
    var cq = Number(row.cq);
    if (!isFinite(cq)) continue;
    var w = weightForPoint(src, row, wOpts);
    if (w <= 0) continue;
    totalW += w; nRows++;
    if (row.vmaf_mean != null) vmafPts.push({ cq: cq, val: Number(row.vmaf_mean), w: w });
    if (row.vmaf_p1_low != null) p1Pts.push({ cq: cq, val: Number(row.vmaf_p1_low), w: w });
    if (row[cambiKey] != null) cambiPts.push({ cq: cq, val: Number(row[cambiKey]), w: w });
    if (row.avg_size_mb != null) sizePts.push({ cq: cq, val: Number(row.avg_size_mb), w: w });
  }

  if (vmafPts.length === 0) {
    return { cq: null, reason: 'no_similar_curves', support: 0, neighbours: nRows };
  }

  // Evaluate each integer cq; feasibility = all KNOWN constraints satisfied with support.
  var evals = [];
  for (var c = CQ_MIN; c <= CQ_MAX; c++) {
    var ev = { cq: c };
    var vm = kernelEstimate(vmafPts, c, h);
    ev.vmaf = vm.val; ev.support = vm.support; ev.count = vm.count;
    ev.p1 = kernelEstimate(p1Pts, c, h).val;
    var cmb = kernelEstimate(cambiPts, c, h);
    ev.cambi = cmb.val; ev.cambiCount = cmb.count;
    ev.size = kernelEstimate(sizePts, c, h).val;
    evals.push(ev);
  }

  // Feasible = enough support, VMAF>=target, (1%-low>=floor if known), (CAMBI<=floor if known),
  // (size<=budget if set & known).
  function feasible(ev) {
    if (ev.vmaf == null || ev.support < minSupport) return false;
    if (ev.vmaf < target) return false;
    if (vmafFloor != null && ev.p1 != null && ev.p1 < vmafFloor) return false;
    if (cambiFloor != null && ev.cambi != null && ev.cambi > cambiFloor) return false;
    if (sizeBudget != null && ev.size != null && ev.size > sizeBudget) return false;
    return true;
  }

  // Highest feasible cq = most compression meeting quality.
  var chosen = null;
  for (var k = evals.length - 1; k >= 0; k--) {
    if (feasible(evals[k])) { chosen = evals[k]; break; }
  }

  // Which constraint binds just above the chosen cq (for observability / debugging).
  function bindingAt(ev) {
    if (!ev) return null;
    if (ev.vmaf != null && ev.vmaf < target + 0.5) return 'vmaf_mean';
    if (vmafFloor != null && ev.p1 != null && ev.p1 < vmafFloor + 0.5) return 'vmaf_p1_low';
    if (cambiFloor != null && ev.cambi != null && ev.cambi > cambiFloor - 0.3) return 'cambi';
    return 'size_or_none';
  }

  if (!chosen) {
    // Even the lowest cq fails the target: fall back to highest-quality (lowest) cq we have support for.
    for (var j = 0; j < evals.length; j++) {
      if (evals[j].vmaf != null && evals[j].support >= minSupport) { chosen = evals[j]; break; }
    }
    if (!chosen) return { cq: null, reason: 'insufficient_support', support: 0, neighbours: nRows };
    return {
      cq: chosen.cq, predictedVmaf: chosen.vmaf, predictedP1Low: chosen.p1,
      predictedCambi: chosen.cambi, predictedSizeMb: chosen.size,
      support: chosen.support, neighbours: nRows, totalWeight: totalW,
      confidence: confidenceFrom(chosen.support, chosen.count, nRows),
      bindingConstraint: 'quality_unreachable', reason: 'target_unreachable_use_min_cq'
    };
  }

  return {
    cq: chosen.cq,
    predictedVmaf: chosen.vmaf,
    predictedP1Low: chosen.p1,
    predictedCambi: chosen.cambi,
    predictedSizeMb: chosen.size,
    support: chosen.support,
    neighbours: nRows,
    totalWeight: totalW,
    confidence: confidenceFrom(chosen.support, chosen.count, nRows),
    bindingConstraint: bindingAt(evals[Math.min(evals.length - 1, (chosen.cq - CQ_MIN) + 1)]) || 'size_or_none',
    reason: 'ok'
  };
}

function confidenceFrom(support, count, neighbours) {
  // Saturating function of local kernel support and raw neighbour count near the pick.
  var s = 1 - Math.exp(-(support || 0) / 4);
  var n = 1 - Math.exp(-(count || 0) / 6);
  return Math.max(0, Math.min(1, 0.6 * s + 0.4 * n));
}

/**
 * CI-based sample-count selection. statRows: similar curves' {vmaf_stddev, sample_count}
 * (per-CQ aggregates). Estimates the typical per-sample VMAF stddev for this content, then
 * picks the smallest N with z*stddev/sqrt(N) <= tolerance.
 */
function selectSampleCount(statRows, opts) {
  opts = opts || {};
  var minN = opts.minSamples || 3;
  var maxN = opts.maxSamples || 10;
  var z = opts.z || 1.64; // ~90% CI

  // ── sigma: prefer THIS file's own measured per-clip VMAFs (no data-starvation, content-exact);
  //    fall back to the 75th-pct historical stddev for similar content. ──
  var sigma = null, sigmaSource = 'none', nObs = 0;
  if (opts.measuredVmafs && opts.measuredVmafs.length >= 2) {
    var vs = [];
    for (var a = 0; a < opts.measuredVmafs.length; a++) { var x = Number(opts.measuredVmafs[a]); if (isFinite(x)) vs.push(x); }
    nObs = vs.length;
    if (nObs >= 2) {
      var mean = 0; for (var b = 0; b < nObs; b++) mean += vs[b]; mean /= nObs;
      var s2 = 0; for (var c = 0; c < nObs; c++) s2 += (vs[c] - mean) * (vs[c] - mean);
      sigma = Math.sqrt(s2 / (nObs - 1)); sigmaSource = 'measured';
    }
  }
  if (sigma == null) {
    var sds = [];
    var sdFloor = opts.minSigmaFloor != null ? Number(opts.minSigmaFloor) : 0.05;
    var sdCap = opts.maxPlausibleSigma != null ? Number(opts.maxPlausibleSigma) : 6.0;
    for (var i = 0; i < (statRows || []).length; i++) {
      var sd = Number(statRows[i].vmaf_stddev), sc = Number(statRows[i].sample_count);
      // Need a TRUSTWORTHY per-clip-mean stddev. Three artifacts to reject:
      //  - sd ~0 with sc>=3: stddev was never actually computed (clip means can't be identical) -> skip.
      //  - sd from 1-2 clips: reported as ~0, also an artifact -> require sc>=3.
      //  - sd > ~6 VMAF: that is per-FRAME spread leaked from a column-misaligned backfill row, not
      //    the spread of clip MEANS (which is ~1-3) -> implausible, skip.
      if (isFinite(sd) && sd > sdFloor && sd < sdCap && isFinite(sc) && sc >= 3) sds.push(sd);
    }
    if (sds.length >= (opts.minSigmaSamples || 5)) {
      sds.sort(function (p, q) { return p - q; });
      // 75th percentile = mild conservatism (sample enough for the higher-variance content in the set).
      sigma = sds[Math.floor(0.75 * (sds.length - 1))];
      sigmaSource = 'historical'; nObs = sds.length;
    }
  }
  if (sigma == null) return { sampleCount: opts.defaultSamples || 6, reason: 'no_variance_data', sigma: null, enough: null };

  // ── precision target: keep the curve's target-CROSSING accurate to ~cqPrecision CQ. A steeper
  //    slope tolerates more VMAF noise for the same CQ precision -> tol = cqPrecision*|slope|.
  //    This is the fix for the old gap/coverage heuristic (which targeted spread, not the mean,
  //    and over-sampled low-variance content). ──
  var slope = isFinite(Number(opts.slope)) ? Math.abs(Number(opts.slope)) : 0.4;
  var tol = opts.toleranceVmaf != null ? Number(opts.toleranceVmaf) : Math.max(0.3, (opts.cqPrecision || 0.75) * slope);

  var nMean = minN;
  for (; nMean <= maxN; nMean++) { if (z * sigma / Math.sqrt(nMean) <= tol) break; }
  if (nMean > maxN) nMean = maxN;

  // distribution floor: need a few clips before the 1%-low / spread is meaningful at all.
  var distMin = Math.min(opts.distMinSamples || 4, maxN);
  var N = Math.max(minN, Math.min(maxN, Math.max(nMean, distMin)));

  // sequential mode: when fed the file's own clips, report whether THAT many is already enough.
  var enough = (sigmaSource === 'measured')
    ? ((z * sigma / Math.sqrt(nObs) <= tol) && nObs >= distMin)
    : null;

  return {
    sampleCount: N,
    sigma: Math.round(sigma * 1000) / 1000,
    sigmaSource: sigmaSource,
    measuredClips: sigmaSource === 'measured' ? nObs : null,
    slope: Math.round(slope * 1000) / 1000,
    tol: Math.round(tol * 1000) / 1000,
    ciHalfWidthAtN: Math.round((z * sigma / Math.sqrt(N)) * 1000) / 1000,
    enough: enough,
    reason: sigmaSource === 'measured' ? 'measured_ci' : 'historical_ci'
  };
}

// ── Sweep-domain prediction (centre + uncertainty) and sequential refinement ──

function _clampCq(c) { return Math.max(CQ_MIN, Math.min(CQ_MAX, c)); }

/**
 * Fit VMAF = ceiling - exp(a + b*cq) by OLS on log(ceiling - VMAF) ~ cq. The CQ->VMAF curve
 * saturates against the VMAF ceiling at low cq, so this monotone, closed-form-invertible model
 * fits ~22% better than linear (RMSE 0.26 vs 0.33 VMAF on real curves) and beats a quadratic
 * for robustness (always monotone, sane extrapolation). Needs >=2 points. Returns null if the
 * fit is degenerate or non-decreasing.
 */
function fitLogCeiling(points, ceiling) {
  ceiling = ceiling || 100;
  var xs = [], ys = [];
  for (var i = 0; i < points.length; i++) {
    var cq = Number(points[i].cq);
    var v = Number(points[i].vmaf_mean != null ? points[i].vmaf_mean : points[i].v);
    if (isFinite(cq) && isFinite(v)) { xs.push(cq); ys.push(Math.log(Math.max(0.05, ceiling - v))); }
  }
  var n = xs.length;
  if (n < 2) return null;
  var sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (var j = 0; j < n; j++) { sx += xs[j]; sy += ys[j]; sxx += xs[j] * xs[j]; sxy += xs[j] * ys[j]; }
  var denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return null;
  var b = (n * sxy - sx * sy) / denom;
  var a = (sy - b * sx) / n;
  if (!isFinite(a) || !isFinite(b) || b <= 0) return null; // b>0 => VMAF strictly decreasing in cq
  return {
    a: a, b: b, ceiling: ceiling, n: n,
    vmafAt: function (cq) { return ceiling - Math.exp(a + b * cq); },
    cqAt: function (target) { var t = ceiling - target; if (t <= 0) return null; return (Math.log(t) - a) / b; }
  };
}

function weightedStats(items) { // items: [{v,w}]
  var tot = 0; for (var i = 0; i < items.length; i++) tot += items[i].w;
  if (tot <= 0) return null;
  var mean = 0; for (var j = 0; j < items.length; j++) mean += items[j].w * items[j].v; mean /= tot;
  var varc = 0; for (var k = 0; k < items.length; k++) varc += items[k].w * (items[k].v - mean) * (items[k].v - mean); varc /= tot;
  var s = items.slice().sort(function (a, b) { return a.v - b.v; });
  function q(p) { var acc = 0; for (var m = 0; m < s.length; m++) { acc += s[m].w; if (acc >= p * tot) return s[m].v; } return s[s.length - 1].v; }
  return { mean: mean, std: Math.sqrt(varc), median: q(0.5), q25: q(0.25), q75: q(0.75) };
}

/** Highest cq on ONE job's measured curve whose VMAF >= target (linear interp). */
function curveOptimalAtTarget(points, target) {
  var pts = [];
  for (var i = 0; i < points.length; i++) {
    var cq = Number(points[i].cq), v = points[i].vmaf_mean;
    if (isFinite(cq) && v != null && isFinite(Number(v))) pts.push({ cq: cq, v: Number(v) });
  }
  if (pts.length < 2) return null;
  pts.sort(function (a, b) { return a.cq - b.cq; });
  var best = null;
  for (var j = 0; j < pts.length - 1; j++) {
    var a = pts[j], b = pts[j + 1];
    if (a.v >= target && b.v < target) best = a.cq + (a.v - target) / (a.v - b.v) * (b.cq - a.cq);
  }
  if (best === null) {
    var mx = -Infinity, mn = Infinity;
    for (var k = 0; k < pts.length; k++) { if (pts[k].v > mx) mx = pts[k].v; if (pts[k].v < mn) mn = pts[k].v; }
    if (mn >= target) best = pts[pts.length - 1].cq; // entire tested range clears target -> optimum at/above max tested
    // entire range below target -> null (unreachable in tested span)
  }
  return best;
}

/** Fit a rising metric (CAMBI) vs cq as linear (a + b*cq, b>0) and invert to a threshold. */
function fitRising(points, key) {
  var xs = [], ys = [];
  for (var i = 0; i < points.length; i++) {
    var cq = Number(points[i].cq), v = Number(points[i][key]);
    if (isFinite(cq) && isFinite(v)) { xs.push(cq); ys.push(v); }
  }
  var n = xs.length;
  if (n < 2) return null;
  var sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (var j = 0; j < n; j++) { sx += xs[j]; sy += ys[j]; sxx += xs[j] * xs[j]; sxy += xs[j] * ys[j]; }
  var denom = n * sxx - sx * sx; if (Math.abs(denom) < 1e-9) return null;
  var b = (n * sxy - sx * sy) / denom, a = (sy - b * sx) / n;
  return {
    a: a, b: b,
    at: function (cq) { return a + b * cq; },
    cqAt: function (thr) { if (Math.abs(b) < 1e-9) return null; return (thr - a) / b; } // cq where metric == thr
  };
}

/**
 * Source-relative CAMBI floor: a source that is already banded (high source CAMBI) must not
 * have its output rejected - or its sweep pulled down - for merely matching that existing
 * banding. Raise the floor to max(base, sourceCambiRisk + tolerance), mirroring the
 * effectiveCambiLimit gate in selectBestParameters. constraints may carry sourceCambi,
 * sourceCambiP95 and cambiTolerance (default 1.0).
 */
function effectiveCambiFloor(constraints) {
  if (constraints.cambiFloor == null) return null;
  var base = Number(constraints.cambiFloor);
  var sc = Number(constraints.sourceCambi);
  var scp = Number(constraints.sourceCambiP95);
  var srcRisk = Math.max(isFinite(sc) ? sc : -Infinity, isFinite(scp) ? scp : -Infinity);
  if (!isFinite(srcRisk)) return base;
  var tol = constraints.cambiTolerance != null ? Number(constraints.cambiTolerance) : 1.0;
  return Math.max(base, srcRisk + tol);
}

/**
 * The cq at which each ENABLED rejection threshold binds, and the most restrictive (smallest).
 * VMAF mean / 1%-low are saturating-decreasing (log-ceiling); CAMBI is rising (linear). The
 * feasible cq = the minimum binding cq, so the sweep aims there instead of the VMAF-only cq -
 * this is what stops a high-CAMBI or low-1%-low output from being chosen and then rejected.
 */
function bindingTargetCQ(pts, constraints) {
  var limits = [];
  if (constraints.targetVmaf != null) {
    var fv = fitLogCeiling(pts.map(function (p) { return { cq: p.cq, vmaf_mean: p.vmaf_mean != null ? p.vmaf_mean : p.v }; }));
    if (fv) { var c1 = fv.cqAt(constraints.targetVmaf); if (c1 != null && isFinite(c1)) limits.push({ cq: c1, k: 'vmaf_mean' }); }
  }
  if (constraints.vmafFloor != null) {
    var pp = pts.filter(function (p) { return p.vmaf_p1_low != null; });
    if (pp.length >= 2) { var fp = fitLogCeiling(pp.map(function (p) { return { cq: p.cq, vmaf_mean: p.vmaf_p1_low }; })); if (fp) { var c2 = fp.cqAt(constraints.vmafFloor); if (c2 != null && isFinite(c2)) limits.push({ cq: c2, k: 'vmaf_p1_low' }); } }
  }
  var effCambi = effectiveCambiFloor(constraints);
  if (effCambi != null) {
    var pc = pts.filter(function (p) { return p.cambi != null || p.cambi_p95 != null; }).map(function (p) { return { cq: p.cq, cambi: p.cambi != null ? p.cambi : p.cambi_p95 }; });
    if (pc.length >= 2) { var fc = fitRising(pc, 'cambi'); if (fc && fc.b > 0) { var c3 = fc.cqAt(effCambi); if (c3 != null && isFinite(c3)) limits.push({ cq: c3, k: 'cambi' }); } }
  }
  if (!limits.length) return null;
  limits.sort(function (a, b) { return a.cq - b.cq; });
  return { cq: limits[0].cq, binding: limits[0].k, all: limits };
}

/**
 * One job's local dVMAF/dcq slope near the target crossing (model-free): the slope of the
 * measured segment that brackets VMAF==target, else the overall OLS slope. Used to build a
 * content-specific prior slope for the FIRST sweep step (before this file's own curve exists).
 */
function localSlopeAtTarget(points, target) {
  var pts = [];
  for (var i = 0; i < points.length; i++) {
    var cq = Number(points[i].cq), v = Number(points[i].vmaf_mean != null ? points[i].vmaf_mean : points[i].v);
    if (isFinite(cq) && isFinite(v)) pts.push({ cq: cq, v: v });
  }
  if (pts.length < 2) return null;
  pts.sort(function (a, b) { return a.cq - b.cq; });
  for (var j = 0; j < pts.length - 1; j++) {
    var a = pts[j], b = pts[j + 1];
    if (a.v >= target && b.v < target && b.cq !== a.cq) { var s = (b.v - a.v) / (b.cq - a.cq); return isFinite(s) ? s : null; }
  }
  var n = pts.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (var k = 0; k < n; k++) { sx += pts[k].cq; sy += pts[k].v; sxx += pts[k].cq * pts[k].cq; sxy += pts[k].cq * pts[k].v; }
  var d = n * sxx - sx * sx; if (Math.abs(d) < 1e-9) return null;
  var slope = (n * sxy - sx * sy) / d;
  return isFinite(slope) ? slope : null;
}

/**
 * Predict the sweep CENTRE + uncertainty + a content-specific PRIOR SLOPE from history
 * (Method B: weighted distribution of similar jobs' OWN optimal cq at the current target).
 * Backtest: centre MAE ~3.2 CQ, the best static estimator (beats pooling VMAF curves, which
 * carry a content-offset bias). priorSlope is the weighted-median local dVMAF/dcq of the same
 * neighbours - used for the single first sweep step before this file's own curve exists
 * (replaces the global -0.4 constant). Final convergence comes from nextSweepCQ on the file's
 * own measured slope.
 */
function predictCQCenter(curveRows, src, constraints, opts) {
  opts = opts || {};
  var target = Number(constraints.targetVmaf);
  var jobs = {};
  for (var i = 0; i < curveRows.length; i++) {
    var r = curveRows[i];
    if (!jobs[r.job_id]) jobs[r.job_id] = { rows: [], f: r };
    jobs[r.job_id].rows.push(r);
  }
  // ── Pass 1: each neighbour's own optimum cq + local slope + features (no weighting yet). ──
  var raw = [];
  for (var jid in jobs) {
    if (!Object.prototype.hasOwnProperty.call(jobs, jid)) continue;
    var o0 = curveOptimalAtTarget(jobs[jid].rows, target);
    var sl0 = localSlopeAtTarget(jobs[jid].rows, target);
    if (o0 === null && sl0 === null) continue;
    raw.push({ o: o0, sl: sl0, f: jobs[jid].f });
  }

  // ── LEARN the similarity feature penalties from (optimum, features) instead of hand-setting them.
  //    eta^2 of the optimum-cq distribution per metadata field -> mismatch penalty. Self-updates each
  //    call; returned as featureEta so callers can log which metadata currently matters most. ──
  var learned = (opts.learnWeights === false) ? null
    : learnFeatureWeights(raw.filter(function (r) { return r.o !== null; }).map(function (r) { return { opt: r.o, f: r.f }; }),
        { penaltyFloor: opts.penaltyFloor, minN: opts.learnMinN || 12 });

  // ── Pass 2: weight neighbours with the LEARNED penalties, then aggregate. ──
  var wOpts = { bppSigma: opts.bppSigma, recencyHalfLifeDays: opts.recencyHalfLifeDays, nowMs: opts.nowMs || Date.now(), weights: learned };
  var items = [], slopes = [];
  for (var ri = 0; ri < raw.length; ri++) {
    var w = weightForPoint(src, raw[ri].f, wOpts);
    if (w <= 0) continue;
    if (raw[ri].o !== null) items.push({ v: raw[ri].o, w: w });
    if (raw[ri].sl !== null && raw[ri].sl < -0.02) slopes.push({ v: raw[ri].sl, w: w });
  }
  if (items.length < (opts.minNeighbours || 3)) return { centerCq: null, reason: 'insufficient_neighbours', support: items.length };
  var st = weightedStats(items);
  var sigma = Math.max(st.std, (st.q75 - st.q25) / 1.35, opts.minSigma || 1.0);

  // Content-specific prior slope: weighted median of neighbour local slopes, clamped to a sane
  // band; fall back to the global -0.4 when too few slope samples.
  var priorSlope = -0.4, slopeSupport = slopes.length;
  if (slopes.length >= (opts.minSlopeSamples || 5)) {
    var sm = weightedStats(slopes).median;
    if (isFinite(sm)) priorSlope = Math.max(-1.2, Math.min(-0.1, sm));
  }

  return {
    centerCq: Math.round(_clampCq(st.median) * 10) / 10,
    sigmaCq: Math.round(sigma * 10) / 10,
    support: items.length,
    priorSlope: Math.round(priorSlope * 1000) / 1000,
    slopeSupport: slopeSupport,
    rangeMin: _clampCq(Math.floor(st.median - (opts.z || 1.0) * sigma)),
    rangeMax: _clampCq(Math.ceil(st.median + (opts.z || 1.0) * sigma)),
    featureEta: learned ? learned.etaSquared : null,
    featurePenalty: learned ? learned.penalty : null,
    reason: 'ok'
  };
}

/**
 * Sequential sweep controller. Given the points already measured for THIS file, return the
 * next CQ to test (or {cq:null, converged} when a tested point is within tolerance of target).
 * Uses the file's OWN measured slope once 2 points exist (secant / regula-falsi), which removes
 * the historical-slope uncertainty -> typically converges in ~3 transcodes.
 *
 *   measured: [{cq, vmaf_mean}]   constraints:{targetVmaf}   opts:{centerCq, priorSlope, toleranceVmaf, cqStep}
 */
function nextSweepCQ(measured, constraints, opts) {
  opts = opts || {};
  var target = Number(constraints.targetVmaf);
  var tol = opts.toleranceVmaf != null ? opts.toleranceVmaf : 0.4;
  var priorSlope = opts.priorSlope || -0.4;
  var step = opts.cqStep || 2;

  var tolCq = opts.toleranceCq != null ? opts.toleranceCq : 1.0;

  // Carry every measured metric so the controller can root-find on whichever threshold binds.
  var pts = [];
  for (var i = 0; i < measured.length; i++) {
    var m = measured[i], cq = Number(m.cq), v = m.vmaf_mean;
    if (!isFinite(cq) || v == null || !isFinite(Number(v))) continue;
    pts.push({ cq: cq, v: Number(v), vmaf_mean: Number(v), vmaf_p1_low: m.vmaf_p1_low, cambi: (m.cambi != null ? m.cambi : m.cambi_p95), cambi_p95: m.cambi_p95 });
  }
  pts.sort(function (a, b) { return a.cq - b.cq; });

  if (pts.length === 0) {
    return { cq: _clampCq(Math.round(opts.centerCq != null ? opts.centerCq : 33)), reason: 'anchor' };
  }

  // Target cq = the most binding rejection threshold (VMAF mean / 1%-low / CAMBI). With one
  // point only VMAF is usable, via a prior-slope step.
  var targetCq = null, binding = 'vmaf_mean';
  if (pts.length >= 2) {
    var bt = bindingTargetCQ(pts, constraints);
    if (bt) { targetCq = bt.cq; binding = bt.binding; }
  }
  if (targetCq == null) { // 1 point, or fits failed -> VMAF prior-slope step
    targetCq = pts[0].cq + (target - pts[0].v) / priorSlope;
    binding = 'vmaf_mean(prior)';
  }

  // Converged once a tested cq sits within tolCq of the binding cq (we've measured the edge).
  var nearest = pts[0];
  for (var c = 1; c < pts.length; c++) if (Math.abs(pts[c].cq - targetCq) < Math.abs(nearest.cq - targetCq)) nearest = pts[c];
  if (Math.abs(nearest.cq - targetCq) <= tolCq) {
    // highest feasible cq is at/just below the binding edge
    return { cq: null, converged: true, cqFinal: _clampCq(Math.floor(targetCq + 1e-6)), binding: binding, reason: 'converged' };
  }

  var tested = {}; for (var t = 0; t < pts.length; t++) tested[pts[t].cq] = 1;
  var next = _clampCq(Math.round(targetCq));
  var walkDir = (next > nearest.cq) ? 1 : -1;
  var guard = 0;
  while (tested[next] && guard < 10) { next = _clampCq(next + walkDir); guard++; }
  if (tested[next]) {
    return { cq: null, converged: true, cqFinal: _clampCq(Math.floor(targetCq + 1e-6)), binding: binding, reason: 'exhausted' };
  }
  return { cq: next, binding: binding, reason: pts.length === 1 ? 'prior_slope_step' : 'binding_constraint' };
}

// ── DB convenience wrappers ──
function selectCQFromDb(db, vmafdb, src, constraints, opts) {
  opts = opts || {};
  var curves = vmafdb.getSimilarSweepCurves(db, src, { limit: opts.limit || 20000, codec: opts.hardCodecFilter });
  return selectCQ(curves, src, constraints, opts);
}
function sampleStatsFromDb(db, vmafdb, src, opts) {
  opts = opts || {};
  var curves = vmafdb.getSimilarSweepCurves(db, src, { limit: opts.limit || 20000 });
  return selectSampleCount(curves, opts);
}

module.exports = {
  CQ_MIN: CQ_MIN,
  CQ_MAX: CQ_MAX,
  codecCategory: codecCategory,
  weightForPoint: weightForPoint,
  genreSet: genreSet,
  correlationRatio: correlationRatio,
  learnFeatureWeights: learnFeatureWeights,
  kernelEstimate: kernelEstimate,
  selectCQ: selectCQ,
  selectSampleCount: selectSampleCount,
  predictCQCenter: predictCQCenter,
  nextSweepCQ: nextSweepCQ,
  fitLogCeiling: fitLogCeiling,
  fitRising: fitRising,
  effectiveCambiFloor: effectiveCambiFloor,
  bindingTargetCQ: bindingTargetCQ,
  curveOptimalAtTarget: curveOptimalAtTarget,
  localSlopeAtTarget: localSlopeAtTarget,
  weightedStats: weightedStats,
  selectCQFromDb: selectCQFromDb,
  sampleStatsFromDb: sampleStatsFromDb,
  confidenceFrom: confidenceFrom
};
