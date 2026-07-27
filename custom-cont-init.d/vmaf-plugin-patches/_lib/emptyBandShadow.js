'use strict';

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  var number = Number(value);
  return isFinite(number) ? number : null;
}

function metrics(result) {
  result = result || {};
  var parameterSet = result.parameterSet || {};
  var cambiValues = [result.avgCAMBI, result.p95CAMBI, result.maxCAMBI]
    .map(finiteNumber).filter(function (value) { return value !== null; });
  return {
    cq: finiteNumber(parameterSet.cq != null ? parameterSet.cq : parameterSet.quality),
    mean: finiteNumber(result.avgVMAFMean != null ? result.avgVMAFMean : result.avgVMAF),
    p1: finiteNumber(result.vmafP1Low != null ? result.vmafP1Low : result.minVMAF),
    cambiRisk: cambiValues.length ? Math.max.apply(null, cambiValues) : null,
    outputRatioPct: finiteNumber(result.projectedOutputRatioPct),
  };
}

function assess(results, policy) {
  policy = policy || {};
  var target = finiteNumber(policy.targetVmaf); if (target === null) target = 95;
  var floor = finiteNumber(policy.vmafP1Floor);
  var cambiLimit = finiteNumber(policy.cambiLimit);
  var maxRatio = finiteNumber(policy.maxOutputRatioPct); if (maxRatio === null) maxRatio = 100;
  var gridStep = finiteNumber(policy.gridStep); if (gridStep === null) gridStep = 0.1;
  var legalCqFloor = finiteNumber(policy.legalCqFloor); if (legalCqFloor === null) legalCqFloor = 16;
  var points = (results || []).map(metrics).filter(function (point) { return point.cq !== null; })
    .sort(function (a, b) { return a.cq - b.cq; });
  points.forEach(function (point) {
    point.metricsComplete = point.mean !== null && point.p1 !== null && point.cambiRisk !== null &&
      point.outputRatioPct !== null && floor !== null && cambiLimit !== null;
    point.qualityPass = point.metricsComplete && point.mean >= target && point.p1 >= floor &&
      point.cambiRisk <= cambiLimit;
    point.sizePass = point.metricsComplete && point.outputRatioPct < maxRatio;
    point.feasible = point.qualityPass && point.sizePass;
  });
  var feasible = points.filter(function (point) { return point.feasible; });
  var proof = null;

  // A quality failure proves the entire legal CQ range is outside the band only when the
  // measurement is already at the encoder's legal floor. A failure at CQ25 says nothing about
  // unmeasured CQ16-24, which are higher quality and may succeed (the original shadow produced
  // two false no-feasible predictions by treating "lowest measured" as "lowest legal").
  if (!feasible.length && points.length && points[0].metricsComplete && !points[0].qualityPass &&
      points[0].cq <= legalCqFloor + 0.001) {
    proof = { type: 'quality_failed_at_legal_cq_floor', lower: points[0], upper: points[0] };
  }

  // On the configured 0.1 grid, adjacent points leave no untested CQ between them. A size failure
  // at the lower CQ followed by a quality failure at the upper CQ proves an empty discrete band.
  if (!proof && !feasible.length) {
    for (var i = 0; i < points.length - 1; i++) {
      var lower = points[i];
      var upper = points[i + 1];
      if (lower.metricsComplete && upper.metricsComplete && !lower.sizePass && !upper.qualityPass &&
          upper.cq - lower.cq <= gridStep + 0.001) {
        proof = { type: 'adjacent_size_quality_crossing', lower: lower, upper: upper };
        break;
      }
    }
  }

  return {
    provenEmpty: proof !== null,
    proof: proof,
    points: points.length,
    completePoints: points.filter(function (point) { return point.metricsComplete; }).length,
    feasiblePoints: feasible.length,
  };
}

module.exports = { assess: assess, metrics: metrics };
