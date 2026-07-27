'use strict';

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  var number = Number(value);
  return isFinite(number) ? number : null;
}

function firstFinite(values) {
  for (var i = 0; i < values.length; i++) {
    var value = finiteNumber(values[i]);
    if (value !== null) return value;
  }
  return null;
}

function maximumFinite(values) {
  var found = [];
  for (var i = 0; i < values.length; i++) {
    var value = finiteNumber(values[i]);
    if (value !== null) found.push(value);
  }
  return found.length ? Math.max.apply(null, found) : null;
}

function metricsFromResult(result) {
  result = result || {};
  var harmonic = firstFinite([result.avgVMAF, result.vmafHarmonic, result.vmaf_harmonic]);
  return {
    cq: firstFinite([
      result.parameterSet && result.parameterSet.quality,
      result.cq,
      result.quality
    ]),
    vmafHarmonic: harmonic,
    vmafMean: firstFinite([result.avgVMAFMean, result.vmafMean, result.vmaf_mean]),
    vmafP1Low: firstFinite([result.vmafP1Low, result.vmaf_p1_low]),
    cambiRisk: maximumFinite([
      result.p95CAMBI,
      result.avgCAMBI,
      result.maxCAMBI,
      result.cambi_p95,
      result.cambi_mean,
      result.cambiRisk
    ]),
    projectedOutputRatioPct: firstFinite([
      result.projectedOutputRatioPct,
      result.outputRatioPct,
      result.projected_output_ratio_pct
    ]),
    projectedOutputBpp: firstFinite([result.projectedOutputBpp, result.outputBpp]),
    projectedOutputMbps: firstFinite([result.projectedOutputMbps, result.outputMbps])
  };
}

function evaluate(result, policy) {
  policy = policy || {};
  var metrics = metricsFromResult(result);
  var missing = [];
  var failures = [];
  var target = finiteNumber(policy.targetVmaf);
  var metricName = policy.vmafMetric === 'harmonic' ? 'vmafHarmonic' : 'vmafMean';
  var targetMetric = metrics[metricName];

  if (target !== null) {
    if (targetMetric === null) missing.push(metricName);
    else if (targetMetric < target) failures.push(metricName + ' ' + targetMetric.toFixed(2) + ' below ' + target.toFixed(2));
  }
  if (policy.requireVmafMean === true && metrics.vmafMean === null) missing.push('vmafMean');
  if (policy.requireVmafHarmonic === true && metrics.vmafHarmonic === null) missing.push('vmafHarmonic');

  var floor = finiteNumber(policy.vmafP1Floor);
  if (floor !== null && floor > 0) {
    if (metrics.vmafP1Low === null) missing.push('vmafP1Low');
    else if (metrics.vmafP1Low < floor) failures.push('vmafP1Low ' + metrics.vmafP1Low.toFixed(2) + ' below ' + floor.toFixed(2));
  }

  var cambiLimit = finiteNumber(policy.cambiLimit);
  if (cambiLimit !== null) {
    if (metrics.cambiRisk === null) missing.push('cambiRisk');
    else if (metrics.cambiRisk > cambiLimit) failures.push('cambiRisk ' + metrics.cambiRisk.toFixed(2) + ' above ' + cambiLimit.toFixed(2));
  }

  var maxRatio = finiteNumber(policy.maxOutputRatioPct);
  if (maxRatio !== null) {
    if (metrics.projectedOutputRatioPct === null) missing.push('projectedOutputRatioPct');
    else if (metrics.projectedOutputRatioPct >= maxRatio) {
      failures.push('projectedOutputRatioPct ' + metrics.projectedOutputRatioPct.toFixed(1) + ' at or above ' + maxRatio.toFixed(1));
    }
  }

  var minRatio = finiteNumber(policy.minOutputRatioPct);
  var minBpp = finiteNumber(policy.minOutputBpp);
  var minMbps = finiteNumber(policy.minOutputMbps);
  if (minRatio !== null || minBpp !== null || minMbps !== null) {
    if (metrics.projectedOutputRatioPct === null) missing.push('projectedOutputRatioPct');
    if (metrics.projectedOutputBpp === null) missing.push('projectedOutputBpp');
    if (metrics.projectedOutputMbps === null) missing.push('projectedOutputMbps');
    if (metrics.projectedOutputRatioPct !== null && metrics.projectedOutputBpp !== null && metrics.projectedOutputMbps !== null) {
      var ratioLow = minRatio !== null && metrics.projectedOutputRatioPct < minRatio;
      var bppLow = minBpp !== null && metrics.projectedOutputBpp < minBpp;
      var mbpsLow = minMbps !== null && metrics.projectedOutputMbps < minMbps;
      var severeBppLow = minBpp !== null && metrics.projectedOutputBpp < minBpp * 0.75;
      if ((ratioLow && (bppLow || mbpsLow)) || severeBppLow) {
        failures.push('projected output below the configured quality-risk size floor');
      }
    }
  }

  var status = missing.length ? 'unknown' : (failures.length ? 'infeasible' : 'feasible');
  return {
    status: status,
    feasible: status === 'feasible',
    metricsComplete: missing.length === 0,
    missing: missing.filter(function (value, index, values) { return values.indexOf(value) === index; }),
    failures: failures,
    metrics: metrics,
    reason: missing.length ? 'missing mandatory metrics: ' + missing.join(', ')
      : (failures.length ? failures.join('; ') : 'all mandatory constraints passed')
  };
}

function evaluateCurve(results, policy) {
  return (results || []).map(function (result) {
    return { result: result, evaluation: evaluate(result, policy) };
  });
}

function highestFeasible(results, policy) {
  var evaluated = evaluateCurve(results, policy).filter(function (entry) {
    return entry.evaluation.feasible && entry.evaluation.metrics.cq !== null;
  });
  evaluated.sort(function (a, b) { return b.evaluation.metrics.cq - a.evaluation.metrics.cq; });
  return evaluated.length ? evaluated[0] : null;
}

function effectiveCambiLimit(options) {
  options = options || {};
  var base = options.isAnimation === true ? 6.0 : (options.isHDR === true ? 5.0 : 5.5);
  var source = maximumFinite([options.sourceCambi, options.sourceCambiP95]);
  var tolerance = finiteNumber(options.cambiTolerance);
  if (tolerance === null) tolerance = 1.0;
  return source === null ? base : Math.max(base, source + tolerance);
}

module.exports = {
  evaluate: evaluate,
  evaluateCurve: evaluateCurve,
  highestFeasible: highestFeasible,
  metricsFromResult: metricsFromResult,
  effectiveCambiLimit: effectiveCambiLimit
};
