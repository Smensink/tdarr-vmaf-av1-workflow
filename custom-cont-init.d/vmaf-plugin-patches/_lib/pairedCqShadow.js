'use strict';

var SCHEMA_VERSION = 4;
var METRIC_MODE = 'selector_authoritative_harmonic_v4_inference_authority';
var TELEMETRY_PATH = '/app/configs/vmaf_paired_cq_shadow_harmonic_v4.jsonl';

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  var number = Number(value);
  return isFinite(number) ? number : null;
}

function cqOf(result) {
  return finiteNumber(result && result.parameterSet &&
    (result.parameterSet.cq != null ? result.parameterSet.cq : result.parameterSet.quality));
}

function percentile(values, q) {
  var ordered = (values || []).map(Number).filter(isFinite).sort(function (a, b) { return a - b; });
  if (!ordered.length) return null;
  var position = (ordered.length - 1) * q;
  var lower = Math.floor(position);
  var upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] * (upper - position) + ordered[upper] * (position - lower);
}

function mean(values) {
  if (!values || !values.length) return null;
  return values.reduce(function (sum, value) { return sum + value; }, 0) / values.length;
}

function minimum(values) {
  return values && values.length ? Math.min.apply(null, values) : null;
}

function maximum(values) {
  return values && values.length ? Math.max.apply(null, values) : null;
}

function clipMaps(result) {
  result = result || {};
  var indices = Array.isArray(result.clipSampleIndices) ? result.clipSampleIndices : [];
  var harmonics = Array.isArray(result.clipVmafs) ? result.clipVmafs : [];
  var means = Array.isArray(result.clipVmafMeans) ? result.clipVmafMeans : [];
  var p1s = Array.isArray(result.clipVmafP1s) ? result.clipVmafP1s : [];
  var cambi = result.clipCambis || {};
  var cambiMeans = Array.isArray(cambi.mean) ? cambi.mean : [];
  var cambiP95s = Array.isArray(cambi.p95) ? cambi.p95 : [];
  if (!indices.length && harmonics.length) {
    indices = harmonics.map(function (_, index) { return index; });
  }
  var selectorComplete = indices.length > 0 && harmonics.length === indices.length &&
    p1s.length === indices.length && cambiMeans.length === indices.length &&
    cambiP95s.length === indices.length;
  var maps = {
    harmonic: {}, mean: {}, p1: {}, cambiMean: {}, cambiP95: {}, cambi: {},
    selectorComplete: selectorComplete,
  };
  for (var i = 0; i < indices.length; i++) {
    var index = Number(indices[i]);
    if (!isFinite(index)) continue;
    var harmonic = finiteNumber(harmonics[i]);
    var vmafMean = finiteNumber(means[i]);
    var vmafP1 = finiteNumber(p1s[i]);
    var cambiMean = finiteNumber(cambiMeans[i]);
    var cambiP95 = finiteNumber(cambiP95s[i]);
    if (harmonic !== null) maps.harmonic[index] = harmonic;
    if (vmafMean !== null) maps.mean[index] = vmafMean;
    if (vmafP1 !== null) maps.p1[index] = vmafP1;
    if (cambiMean !== null) maps.cambiMean[index] = cambiMean;
    if (cambiP95 !== null) maps.cambiP95[index] = cambiP95;
    if (cambiMean !== null && cambiP95 !== null) maps.cambi[index] = Math.max(cambiMean, cambiP95);
  }
  // Compatibility aliases for diagnostics written before selector-authoritative v2.
  maps.vmaf = maps.harmonic;
  return maps;
}

function stratified(items, count) {
  if (count >= items.length) return items.slice();
  var selected = [];
  for (var i = 0; i < count; i++) {
    selected.push(items[Math.min(items.length - 1, Math.floor((i + 0.5) * items.length / count))]);
  }
  return selected;
}

function assess(previous, current, policy) {
  policy = policy || {};
  var anchorCount = Math.max(2, Number(policy.anchorCount) || 6);
  var previousCq = cqOf(previous);
  var currentCq = cqOf(current);
  var reasons = [];
  if (previousCq === null || currentCq === null) reasons.push('missing_cq');
  var cqGap = previousCq !== null && currentCq !== null ? currentCq - previousCq : null;
  if (cqGap === null || cqGap <= 0 || cqGap > (Number(policy.maxCqGap) || 2)) reasons.push('cq_gap_out_of_range');

  var oldMaps = clipMaps(previous);
  var newMaps = clipMaps(current);
  if (!oldMaps.selectorComplete || !newMaps.selectorComplete) {
    reasons.push('missing_selector_metric_vectors');
  }
  var common = Object.keys(oldMaps.harmonic).map(Number).filter(function (index) {
    return newMaps.harmonic[index] !== undefined && oldMaps.p1[index] !== undefined &&
      newMaps.p1[index] !== undefined && oldMaps.cambiMean[index] !== undefined &&
      newMaps.cambiMean[index] !== undefined && oldMaps.cambiP95[index] !== undefined &&
      newMaps.cambiP95[index] !== undefined;
  }).sort(function (a, b) { return a - b; });
  if (common.length < Math.max(8, anchorCount + 1)) reasons.push('insufficient_matched_clips');
  if (reasons.length) {
    return {
      eligible: false, reasons: reasons, metricMode: METRIC_MODE,
      previousCQ: previousCq, currentCQ: currentCq, cqGap: cqGap,
      matchedClips: common.length, anchorCount: anchorCount,
    };
  }

  var anchors = stratified(common, anchorCount);
  function anchorDelta(oldMap, newMap) {
    return mean(anchors.map(function (index) { return newMap[index] - oldMap[index]; }));
  }
  function predict(oldMap, delta) {
    return common.map(function (index) { return oldMap[index] + delta; });
  }
  function actual(map) {
    return common.map(function (index) { return map[index]; });
  }

  var harmonicDelta = anchorDelta(oldMaps.harmonic, newMaps.harmonic);
  var p1Delta = anchorDelta(oldMaps.p1, newMaps.p1);
  var cambiMeanDelta = anchorDelta(oldMaps.cambiMean, newMaps.cambiMean);
  var cambiP95Delta = anchorDelta(oldMaps.cambiP95, newMaps.cambiP95);
  var predictedHarmonics = predict(oldMaps.harmonic, harmonicDelta);
  var predictedP1s = predict(oldMaps.p1, p1Delta);
  var predictedCambiMeans = predict(oldMaps.cambiMean, cambiMeanDelta);
  var predictedCambiP95s = predict(oldMaps.cambiP95, cambiP95Delta);
  var actualHarmonics = actual(newMaps.harmonic);
  var actualP1s = actual(newMaps.p1);
  var actualCambiMeans = actual(newMaps.cambiMean);
  var actualCambiP95s = actual(newMaps.cambiP95);

  // These reductions exactly match calculateVMAF's aggregates consumed by the selector:
  // arithmetic mean of per-clip frame-harmonic VMAF scores, minimum frame 1%-low
  // across clips, and
  // max(mean CAMBI, maximum per-clip CAMBI p95).
  var predictedHarmonic = mean(predictedHarmonics);
  var predictedP1 = minimum(predictedP1s);
  var predictedCambiMean = mean(predictedCambiMeans);
  var predictedCambiP95 = maximum(predictedCambiP95s);
  var predictedCambiRisk = Math.max(predictedCambiMean, predictedCambiP95);
  var actualHarmonic = mean(actualHarmonics);
  var actualP1 = minimum(actualP1s);
  var actualCambiMean = mean(actualCambiMeans);
  var actualCambiP95 = maximum(actualCambiP95s);
  var actualCambiRisk = Math.max(actualCambiMean, actualCambiP95);
  var target = finiteNumber(policy.targetVmaf); if (target === null) target = 95;
  var floor = finiteNumber(policy.vmafP1Floor);
  var cambiLimit = finiteNumber(policy.cambiLimit);
  var harmonicMargin = finiteNumber(policy.harmonicMargin);
  // Accept the v2 option name so callers can roll forward without silently losing
  // their configured safety margin. New records always use the harmonic name.
  if (harmonicMargin === null) harmonicMargin = finiteNumber(policy.meanMargin);
  if (harmonicMargin === null) harmonicMargin = 0.25;
  var p1Margin = finiteNumber(policy.p1Margin); if (p1Margin === null) p1Margin = 0.5;
  var cambiMargin = finiteNumber(policy.cambiMargin); if (cambiMargin === null) cambiMargin = 0.25;
  var predictedSafe = predictedHarmonic >= target + harmonicMargin && floor !== null &&
    predictedP1 >= floor + p1Margin && cambiLimit !== null &&
    predictedCambiRisk <= cambiLimit - cambiMargin;
  var actualPass = actualHarmonic >= target && floor !== null && actualP1 >= floor &&
    cambiLimit !== null && actualCambiRisk <= cambiLimit;

  return {
    eligible: true,
    reasons: [],
    metricMode: METRIC_MODE,
    previousCQ: previousCq,
    currentCQ: currentCq,
    cqGap: cqGap,
    matchedClips: common.length,
    anchorCount: anchorCount,
    anchorIndices: anchors,
    anchorDeltas: {
      harmonic: harmonicDelta, p1: p1Delta,
      cambiMean: cambiMeanDelta, cambiP95: cambiP95Delta,
    },
    predicted: {
      harmonic: predictedHarmonic, p1: predictedP1, cambiMean: predictedCambiMean,
      cambiP95: predictedCambiP95, cambiRisk: predictedCambiRisk, safe: predictedSafe,
    },
    actual: {
      harmonic: actualHarmonic, p1: actualP1, cambiMean: actualCambiMean,
      cambiP95: actualCambiP95, cambiRisk: actualCambiRisk, passed: actualPass,
    },
    errors: {
      harmonicAbsolute: Math.abs(predictedHarmonic - actualHarmonic),
      p1Absolute: Math.abs(predictedP1 - actualP1),
      cambiRiskAbsolute: Math.abs(predictedCambiRisk - actualCambiRisk),
    },
    margins: { harmonic: harmonicMargin, p1: p1Margin, cambi: cambiMargin },
    falseSafe: predictedSafe && !actualPass,
    potentiallyAvoidableScores: Math.max(0, common.length - anchorCount),
  };
}

function measurementIdentityMatches(previous, current) {
  var keys = [
    'metricContractId', 'referenceContractId', 'encoderProfileId',
    'measurementSubsample', 'policyId', 'inferenceAuthorityContractId',
  ];
  var left = previous && previous.measurementIdentity;
  var right = current && current.measurementIdentity;
  if (!left || !right) return false;
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (left[key] === null || left[key] === undefined || left[key] === '' ||
        right[key] === null || right[key] === undefined || right[key] === '') return false;
    if (String(left[key]) !== String(right[key])) return false;
  }
  return true;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    var output = {};
    Object.keys(value).sort().forEach(function (key) {
      output[key] = stableValue(value[key]);
    });
    return output;
  }
  return value;
}

function encoderIdentity(parameterSet) {
  var normalized = {};
  Object.keys(parameterSet || {}).sort().forEach(function (key) {
    if (key === 'id' || key === 'quality' || key === 'cq') return;
    normalized[key] = stableValue(parameterSet[key]);
  });
  return JSON.stringify(normalized);
}

function planActingQueue(allResults, pendingResults, precomputedResults, options) {
  options = options || {};
  var sampleCount = Number(options.sampleCount);
  var reasons = [];
  if (!isFinite(sampleCount) || sampleCount < 8) {
    return { eligible: false, reasons: ['sample_count_below_8'] };
  }
  var groups = {};
  (Array.isArray(allResults) ? allResults : []).forEach(function (task) {
    if (!task || task.parameterSetId === null || task.parameterSetId === undefined ||
        task.sampleIndex === null || task.sampleIndex === undefined) return;
    var id = String(task.parameterSetId);
    var parameterSet = task.parameterSet || {};
    var cq = cqOf({ parameterSet: parameterSet });
    if (cq === null) return;
    if (!groups[id]) {
      groups[id] = {
        id: id,
        cq: cq,
        parameterSet: parameterSet,
        encoderIdentity: encoderIdentity(parameterSet),
        tasksByIndex: {},
        duplicate: false,
      };
    }
    var sampleIndex = Number(task.sampleIndex);
    if (!isFinite(sampleIndex)) return;
    if (groups[id].tasksByIndex[sampleIndex]) groups[id].duplicate = true;
    groups[id].tasksByIndex[sampleIndex] = task;
  });
  var complete = Object.keys(groups).map(function (id) { return groups[id]; }).filter(function (group) {
    var indices = Object.keys(group.tasksByIndex).map(Number).sort(function (a, b) { return a - b; });
    if (group.duplicate || indices.length !== sampleCount) return false;
    for (var i = 0; i < sampleCount; i++) if (indices[i] !== i) return false;
    group.indices = indices;
    return true;
  }).sort(function (a, b) {
    return a.cq - b.cq || a.id.localeCompare(b.id);
  });

  var pair = null;
  for (var pairIndex = 0; pairIndex < complete.length - 1; pairIndex++) {
    var previous = complete[pairIndex];
    var current = complete[pairIndex + 1];
    var gap = current.cq - previous.cq;
    if (gap > 0 && gap <= 2 && previous.encoderIdentity === current.encoderIdentity) {
      pair = { previous: previous, current: current, gap: gap };
      break;
    }
  }
  if (!pair) {
    return { eligible: false, reasons: ['no_exact_encoder_adjacent_pair'] };
  }

  var anchors = stratified(pair.previous.indices, 6);
  var anchorSet = {};
  anchors.forEach(function (index) { anchorSet[index] = true; });
  var currentPrecomputedNonanchor = (Array.isArray(precomputedResults) ? precomputedResults : []).some(function (row) {
    return row && String(row.parameterSetId) === pair.current.id && !anchorSet[Number(row.sampleIndex)];
  });
  if (currentPrecomputedNonanchor) {
    return {
      eligible: false,
      reasons: ['current_nonanchor_already_measured'],
      previousId: pair.previous.id,
      currentId: pair.current.id,
    };
  }

  var pending = Array.isArray(pendingResults) ? pendingResults : [];
  var stageOneTasks = [];
  var stageKeys = {};
  function addStage(task) {
    var key = String(task.parameterSetId) + ':' + String(task.sampleIndex);
    if (stageKeys[key]) return;
    stageKeys[key] = true;
    stageOneTasks.push(task);
  }
  pair.previous.indices.forEach(function (index) {
    pending.forEach(function (task) {
      if (String(task.parameterSetId) === pair.previous.id && Number(task.sampleIndex) === index) addStage(task);
    });
  });
  anchors.forEach(function (index) {
    pending.forEach(function (task) {
      if (String(task.parameterSetId) === pair.current.id && Number(task.sampleIndex) === index) addStage(task);
    });
  });
  var remainingTasks = pending.filter(function (task) {
    return !stageKeys[String(task.parameterSetId) + ':' + String(task.sampleIndex)];
  });
  var currentNonanchorTasks = remainingTasks.filter(function (task) {
    return String(task.parameterSetId) === pair.current.id && !anchorSet[Number(task.sampleIndex)];
  });

  return {
    eligible: true,
    reasons: [],
    previousId: pair.previous.id,
    currentId: pair.current.id,
    previousCQ: pair.previous.cq,
    currentCQ: pair.current.cq,
    cqGap: pair.gap,
    encoderIdentity: pair.previous.encoderIdentity,
    allIndices: pair.previous.indices.slice(),
    anchorIndices: anchors,
    stageOneTasks: stageOneTasks,
    remainingTasks: remainingTasks,
    currentNonanchorTasks: currentNonanchorTasks,
  };
}

function buildMeasuredPartial(plan, measuredRows, measurementIdentity) {
  var reasons = [];
  if (!plan || plan.eligible !== true) return { eligible: false, reasons: ['acting_plan_ineligible'] };
  var requiredIdentityKeys = [
    'metricContractId', 'referenceContractId', 'encoderProfileId',
    'measurementSubsample', 'policyId', 'inferenceAuthorityContractId',
  ];
  requiredIdentityKeys.forEach(function (key) {
    if (!measurementIdentity || measurementIdentity[key] === null ||
        measurementIdentity[key] === undefined || measurementIdentity[key] === '') {
      reasons.push('missing_measurement_identity_' + key);
    }
  });
  var byKey = {};
  var duplicate = false;
  (Array.isArray(measuredRows) ? measuredRows : []).forEach(function (row) {
    if (!row || row.parameterSetId === null || row.parameterSetId === undefined ||
        row.sampleIndex === null || row.sampleIndex === undefined) return;
    var key = String(row.parameterSetId) + ':' + String(Number(row.sampleIndex));
    if (byKey[key]) duplicate = true;
    byKey[key] = row;
  });
  if (duplicate) reasons.push('duplicate_measured_clip');

  function collect(parameterSetId, indices, disposition) {
    var rows = [];
    indices.forEach(function (index) {
      var row = byKey[String(parameterSetId) + ':' + String(index)];
      if (!row) {
        reasons.push(disposition === 'measured_full_current_contract'
          ? 'previous_not_fully_measured' : 'current_anchors_not_measured');
        return;
      }
      var values = [row.vmafScore, row.vmafP1, row.cambiMean, row.cambiP95];
      if (!values.every(function (value) { return finiteNumber(value) !== null; })) {
        reasons.push('non_finite_measured_metric');
      }
      if (Number(row.nSubsample || 1) !== Number(measurementIdentity.measurementSubsample)) {
        reasons.push('measurement_subsample_mismatch');
      }
      rows.push(row);
    });
    if (!rows.length) return null;
    return {
      parameterSetId: parameterSetId,
      parameterSet: rows[0].parameterSet,
      clipSampleIndices: rows.map(function (row) { return Number(row.sampleIndex); }),
      clipVmafs: rows.map(function (row) { return Number(row.vmafScore); }),
      clipVmafMeans: rows.map(function (row) {
        return finiteNumber(row.vmafMean) !== null ? Number(row.vmafMean) : Number(row.vmafScore);
      }),
      clipVmafP1s: rows.map(function (row) { return Number(row.vmafP1); }),
      clipCambis: {
        mean: rows.map(function (row) { return Number(row.cambiMean); }),
        p95: rows.map(function (row) { return Number(row.cambiP95); }),
      },
      measurementIdentity: stableValue(measurementIdentity),
      evidenceDisposition: disposition,
    };
  }

  var previous = collect(plan.previousId, plan.allIndices, 'measured_full_current_contract');
  var currentAnchors = collect(plan.currentId, plan.anchorIndices, 'measured_anchor_current_contract');
  if (reasons.length) {
    return { eligible: false, reasons: reasons.filter(function (value, index, all) {
      return all.indexOf(value) === index;
    }) };
  }
  return { eligible: true, reasons: [], previous: previous, currentAnchors: currentAnchors };
}

function reconstructPartial(previous, currentAnchors, policy) {
  policy = policy || {};
  var anchorCount = Math.max(2, Number(policy.anchorCount) || 6);
  var reasons = [];
  var previousCq = cqOf(previous);
  var currentCq = cqOf(currentAnchors);
  var cqGap = previousCq !== null && currentCq !== null ? currentCq - previousCq : null;
  if (previousCq === null || currentCq === null) reasons.push('missing_cq');
  if (cqGap === null || cqGap <= 0 || cqGap > (Number(policy.maxCqGap) || 2)) {
    reasons.push('cq_gap_out_of_range');
  }
  if (!previous || previous.evidenceDisposition !== 'measured_full_current_contract') {
    reasons.push('previous_not_fully_measured');
  }
  if (!currentAnchors || currentAnchors.evidenceDisposition !== 'measured_anchor_current_contract') {
    reasons.push('current_anchors_not_measured');
  }
  if (!measurementIdentityMatches(previous, currentAnchors)) {
    reasons.push('measurement_identity_mismatch');
  }

  var oldMaps = clipMaps(previous);
  var anchorMaps = clipMaps(currentAnchors);
  if (!oldMaps.selectorComplete) reasons.push('previous_missing_selector_metric_vectors');
  if (!anchorMaps.selectorComplete) reasons.push('anchors_missing_selector_metric_vectors');
  var allIndices = Object.keys(oldMaps.harmonic).map(Number).filter(function (index) {
    return oldMaps.p1[index] !== undefined && oldMaps.cambiMean[index] !== undefined &&
      oldMaps.cambiP95[index] !== undefined;
  }).sort(function (a, b) { return a - b; });
  if (allIndices.length < Math.max(8, anchorCount + 1)) reasons.push('insufficient_matched_clips');

  var expectedAnchors = stratified(allIndices, anchorCount);
  var actualAnchors = Object.keys(anchorMaps.harmonic).map(Number).filter(function (index) {
    return anchorMaps.p1[index] !== undefined && anchorMaps.cambiMean[index] !== undefined &&
      anchorMaps.cambiP95[index] !== undefined;
  }).sort(function (a, b) { return a - b; });
  if (expectedAnchors.length !== actualAnchors.length || expectedAnchors.some(function (value, index) {
    return value !== actualAnchors[index];
  })) reasons.push('anchor_set_mismatch');

  if (reasons.length) {
    return {
      eligible: false,
      reasons: reasons,
      previousCQ: previousCq,
      currentCQ: currentCq,
      cqGap: cqGap,
      anchorCount: anchorCount,
      expectedAnchorIndices: expectedAnchors,
      actualAnchorIndices: actualAnchors,
    };
  }

  function anchorDeltas(oldMap, currentMap) {
    return expectedAnchors.map(function (index) { return currentMap[index] - oldMap[index]; });
  }
  function delta(oldMap, currentMap) {
    return mean(anchorDeltas(oldMap, currentMap));
  }
  function confidenceHalfwidth(values) {
    if (!Array.isArray(values) || values.length < 2) return Infinity;
    var center = mean(values);
    var variance = values.reduce(function (sum, value) {
      var difference = value - center;
      return sum + difference * difference;
    }, 0) / (values.length - 1);
    return 1.96 * Math.sqrt(variance) / Math.sqrt(values.length);
  }
  var deltas = {
    harmonic: delta(oldMaps.harmonic, anchorMaps.harmonic),
    p1: delta(oldMaps.p1, anchorMaps.p1),
    cambiMean: delta(oldMaps.cambiMean, anchorMaps.cambiMean),
    cambiP95: delta(oldMaps.cambiP95, anchorMaps.cambiP95),
  };
  var hasMeans = expectedAnchors.every(function (index) {
    return oldMaps.mean[index] !== undefined && anchorMaps.mean[index] !== undefined;
  });
  deltas.mean = hasMeans ? delta(oldMaps.mean, anchorMaps.mean) : deltas.harmonic;
  if (deltas.harmonic > 0 || deltas.p1 > 0 || deltas.mean > 0) {
    return {
      eligible: false,
      reasons: ['non_monotonic_harder_cq_vmaf'],
      previousCQ: previousCq,
      currentCQ: currentCq,
      cqGap: cqGap,
      anchorCount: anchorCount,
      anchorDeltas: deltas,
    };
  }
  var confidence = {
    harmonic: confidenceHalfwidth(anchorDeltas(oldMaps.harmonic, anchorMaps.harmonic)),
    p1: confidenceHalfwidth(anchorDeltas(oldMaps.p1, anchorMaps.p1)),
    cambiMean: confidenceHalfwidth(anchorDeltas(oldMaps.cambiMean, anchorMaps.cambiMean)),
    cambiP95: confidenceHalfwidth(anchorDeltas(oldMaps.cambiP95, anchorMaps.cambiP95)),
  };
  var maxConfidence = {
    harmonic: finiteNumber(policy.maxHarmonicCiHalfwidth),
    p1: finiteNumber(policy.maxP1CiHalfwidth),
    cambiMean: finiteNumber(policy.maxCambiMeanCiHalfwidth),
    cambiP95: finiteNumber(policy.maxCambiP95CiHalfwidth),
  };
  if (maxConfidence.harmonic === null) maxConfidence.harmonic = 0.35;
  if (maxConfidence.p1 === null) maxConfidence.p1 = 0.75;
  if (maxConfidence.cambiMean === null) maxConfidence.cambiMean = 0.35;
  if (maxConfidence.cambiP95 === null) maxConfidence.cambiP95 = 0.35;
  if (Object.keys(confidence).some(function (key) {
    return !isFinite(confidence[key]) || confidence[key] > maxConfidence[key];
  })) {
    return {
      eligible: false,
      reasons: ['anchor_delta_uncertain'],
      previousCQ: previousCq,
      currentCQ: currentCq,
      cqGap: cqGap,
      anchorCount: anchorCount,
      anchorDeltas: deltas,
      confidence95Halfwidth: confidence,
      maximumConfidence95Halfwidth: maxConfidence,
    };
  }

  var clipVmafs = [];
  var clipVmafMeans = [];
  var clipVmafP1s = [];
  var clipCambiMeans = [];
  var clipCambiP95s = [];
  var clipProvenance = [];
  var scoreMax = finiteNumber(policy.vmafScoreMax);
  if (scoreMax === null) scoreMax = 100;
  var invalidPrediction = false;
  allIndices.forEach(function (index) {
    var measured = anchorMaps.harmonic[index] !== undefined;
    var harmonic = measured ? anchorMaps.harmonic[index] : oldMaps.harmonic[index] + deltas.harmonic;
    var p1 = measured ? anchorMaps.p1[index] : oldMaps.p1[index] + deltas.p1;
    var cambiMean = measured ? anchorMaps.cambiMean[index] : oldMaps.cambiMean[index] + deltas.cambiMean;
    var cambiP95 = measured ? anchorMaps.cambiP95[index] : oldMaps.cambiP95[index] + deltas.cambiP95;
    var vmafMean = measured && anchorMaps.mean[index] !== undefined
      ? anchorMaps.mean[index]
      : (oldMaps.mean[index] !== undefined ? oldMaps.mean[index] + deltas.mean : harmonic);
    if (![harmonic, p1, cambiMean, cambiP95, vmafMean].every(function (value) { return isFinite(value); }) ||
        harmonic < 0 || harmonic > scoreMax || p1 < 0 || p1 > scoreMax ||
        vmafMean < 0 || vmafMean > scoreMax || cambiMean < 0 || cambiP95 < 0) {
      invalidPrediction = true;
    }
    clipVmafs.push(harmonic);
    clipVmafMeans.push(vmafMean);
    clipVmafP1s.push(p1);
    clipCambiMeans.push(cambiMean);
    clipCambiP95s.push(cambiP95);
    clipProvenance.push(measured ? 'measured_anchor' : 'paired_cq_inferred_v1');
  });
  if (invalidPrediction) {
    return {
      eligible: false,
      reasons: ['predicted_metric_out_of_range'],
      previousCQ: previousCq,
      currentCQ: currentCq,
      cqGap: cqGap,
      anchorCount: anchorCount,
    };
  }

  var aggregate = {
    harmonic: mean(clipVmafs),
    p1: minimum(clipVmafP1s),
    cambiMean: mean(clipCambiMeans),
    cambiP95: maximum(clipCambiP95s),
  };
  aggregate.cambiRisk = Math.max(aggregate.cambiMean, aggregate.cambiP95);
  var target = finiteNumber(policy.targetVmaf); if (target === null) target = 95;
  var floor = finiteNumber(policy.vmafP1Floor);
  var cambiLimit = finiteNumber(policy.cambiLimit);
  var harmonicMargin = finiteNumber(policy.harmonicMargin); if (harmonicMargin === null) harmonicMargin = 0.25;
  var p1Margin = finiteNumber(policy.p1Margin); if (p1Margin === null) p1Margin = 0.5;
  var cambiMargin = finiteNumber(policy.cambiMargin); if (cambiMargin === null) cambiMargin = 0.25;
  var actingSafe = aggregate.harmonic - confidence.harmonic >= target + harmonicMargin && floor !== null &&
    aggregate.p1 - confidence.p1 >= floor + p1Margin && cambiLimit !== null &&
    Math.max(aggregate.cambiMean + confidence.cambiMean,
      aggregate.cambiP95 + confidence.cambiP95) <= cambiLimit - cambiMargin;

  var identity = {};
  Object.keys(previous.measurementIdentity).forEach(function (key) {
    identity[key] = previous.measurementIdentity[key];
  });
  return {
    eligible: true,
    reasons: [],
    actingSafe: actingSafe,
    previousCQ: previousCq,
    currentCQ: currentCq,
    cqGap: cqGap,
    anchorCount: anchorCount,
    anchorIndices: expectedAnchors,
    anchorDeltas: deltas,
    confidence95Halfwidth: confidence,
    maximumConfidence95Halfwidth: maxConfidence,
    predicted: aggregate,
    margins: { harmonic: harmonicMargin, p1: p1Margin, cambi: cambiMargin },
    reconstructed: {
      parameterSetId: currentAnchors.parameterSetId,
      parameterSet: currentAnchors.parameterSet,
      clipSampleIndices: allIndices,
      clipVmafs: clipVmafs,
      clipVmafMeans: clipVmafMeans,
      clipVmafP1s: clipVmafP1s,
      clipCambis: { mean: clipCambiMeans, p95: clipCambiP95s },
      clipProvenance: clipProvenance,
      sampleCount: allIndices.length,
      measuredClipCount: expectedAnchors.length,
      inferredClipCount: allIndices.length - expectedAnchors.length,
      avgVMAF: aggregate.harmonic,
      avgVMAFMean: mean(clipVmafMeans),
      vmafP1Low: aggregate.p1,
      avgCAMBI: aggregate.cambiMean,
      p95CAMBI: aggregate.cambiP95,
      measurementDisposition: 'paired_cq_inferred_v1',
      measurementIdentity: identity,
    },
  };
}

module.exports = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  METRIC_MODE: METRIC_MODE,
  TELEMETRY_PATH: TELEMETRY_PATH,
  assess: assess,
  reconstructPartial: reconstructPartial,
  planActingQueue: planActingQueue,
  buildMeasuredPartial: buildMeasuredPartial,
  measurementIdentityMatches: measurementIdentityMatches,
  encoderIdentity: encoderIdentity,
  clipMaps: clipMaps,
  cqOf: cqOf,
  percentile: percentile,
  stratified: stratified,
};
