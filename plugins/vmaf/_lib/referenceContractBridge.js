'use strict';

/**
 * Seed-only domain adaptation between the historical original-reference/tf4
 * VMAF contract and the canonical native-depth NVEncC KNN/tf0 contract.
 *
 * Historical curves remain useful for locating fresh probes, but they never
 * become canonical measurements.  The adapter operates in CQ space: an
 * explicitly attested paired-canary cohort may shift the legacy-predicted CQ;
 * absent enough calibration it applies a zero-shift, high-uncertainty prior.
 * There is deliberately no API here that can accept/reuse a CQ, revive an
 * outcome, or apply legacy size/CAMBI/frame-floor evidence.
 */

var predictor = require('./vmafpredict.js');
var canonicalDenoise = require('./canonicalDenoise.js');
var nvenccKnn = require('./nvenccKnn.js');

var CALIBRATION_ARTIFACT_SCHEMA = 2;
var CALIBRATION_PURPOSE =
  'compare-legacy-original-tf4-vs-canonical-nvencc-knn-tf0-vmaf-contracts';

var DEFAULT_MAX_AGE_DAYS = 365;
var DEFAULT_HALF_LIFE_DAYS = 120;
var DEFAULT_MIN_SLOPE_CURVES = 5;
// Sum of per-job similarity/recency/contract-reliability weights. Three means
// the cohort has at least the mass of three perfect current-contract peers.
var DEFAULT_MIN_TOTAL_JOB_WEIGHT = 3;
var DEFAULT_UNCALIBRATED_WEIGHT = 0.18;
var DEFAULT_PRIOR_UNCERTAINTY_CQ = 4;
var DEFAULT_MIN_CALIBRATION_SOURCES = 3;
var DEFAULT_MIN_CALIBRATION_POINTS = 6;
var DEFAULT_MAX_CALIBRATION_CQ_DISTANCE = 6;
var DEFAULT_MAX_ADAPTER_SHIFT_CQ = 4;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  var n = Number(value);
  return isFinite(n) ? n : null;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function median(values) {
  var sorted = (values || []).filter(function (value) {
    return finiteNumber(value) !== null;
  }).map(Number).sort(function (a, b) { return a - b; });
  if (!sorted.length) return null;
  var middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustSigma(values, center) {
  if (!(values || []).length) return null;
  if (center === null || center === undefined) center = median(values);
  var deviation = median(values.map(function (value) { return Math.abs(Number(value) - center); }));
  return deviation === null ? null : 1.4826 * deviation;
}

function theilSenSlope(points, xName, yName) {
  var slopes = [];
  for (var left = 0; left < points.length; left++) {
    for (var right = left + 1; right < points.length; right++) {
      var dx = Number(points[right][xName]) - Number(points[left][xName]);
      if (Math.abs(dx) < 0.001) continue;
      var dy = Number(points[right][yName]) - Number(points[left][yName]);
      var slope = dy / dx;
      if (isFinite(slope)) slopes.push(slope);
    }
  }
  return median(slopes);
}

function normalizedToken(value) {
  return String(value === null || value === undefined ? '' : value).trim().toLowerCase();
}

function codecCategory(value) {
  var codec = normalizedToken(value);
  if (codec.indexOf('hevc') !== -1 || codec.indexOf('h265') !== -1 || codec.indexOf('265') !== -1) return 'hevc';
  if (codec.indexOf('h264') !== -1 || codec.indexOf('avc') !== -1 || codec.indexOf('264') !== -1) return 'h264';
  if (codec.indexOf('av1') !== -1) return 'av1';
  if (codec.indexOf('vp9') !== -1) return 'vp9';
  if (codec.indexOf('mpeg2') !== -1) return 'mpeg2';
  return codec;
}

function tierFor(width, height) {
  var w = Number(width) || 0;
  var h = Number(height) || 0;
  if (w >= 3400 || h >= 2000) return '2160p';
  if (w >= 2400 || h >= 1300) return '1440p';
  if (w >= 1700 || h >= 900) return '1080p';
  if (w >= 1100 || h >= 650) return '720p';
  return 'sd';
}

/**
 * `maxAgeDays` is a hard lookback cutoff: 0 disables legacy guidance, a
 * positive number means that many measurement days, and Infinity is unlimited.
 * `recencyHalfLifeDays` is separate: 0 means no age decay (not zero lookback).
 */
function resolveLookback(options) {
  options = options || {};
  var maxAge = options.maxAgeDays;
  if (maxAge === undefined || maxAge === null || maxAge === '') maxAge = DEFAULT_MAX_AGE_DAYS;
  maxAge = Number(maxAge);
  if (!isFinite(maxAge) && maxAge !== Infinity) maxAge = DEFAULT_MAX_AGE_DAYS;
  if (maxAge < 0) throw new Error('legacy bridge maxAgeDays must be zero, positive, or Infinity');

  var halfLife = options.recencyHalfLifeDays;
  if (halfLife === undefined || halfLife === null || halfLife === '') halfLife = DEFAULT_HALF_LIFE_DAYS;
  halfLife = Number(halfLife);
  if (!isFinite(halfLife) || halfLife < 0) throw new Error('legacy bridge recencyHalfLifeDays must be zero or positive');
  return {
    maxAgeDays: maxAge,
    recencyHalfLifeDays: halfLife,
    semantics: 'maxAgeDays=hard-cutoff; recencyHalfLifeDays=decay; half-life-0=no-decay',
  };
}

function filterRowsByLookback(rows, options) {
  var lookback = resolveLookback(options);
  if (lookback.maxAgeDays === 0) return [];
  var nowMs = finiteNumber(options && options.nowMs);
  if (nowMs === null) nowMs = Date.now();
  return (rows || []).filter(function (row) {
    if (lookback.maxAgeDays === Infinity) return true;
    var measuredAt = Date.parse(row && row.timestamp);
    if (!isFinite(measuredAt)) return false;
    var ageDays = Math.max(0, (nowMs - measuredAt) / 86400000);
    return ageDays <= lookback.maxAgeDays;
  });
}

function hdrFlag(value) {
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  return null;
}

function animationFlag(value) {
  return hdrFlag(value);
}

function filterRowsByHardSourceMatch(rows, source) {
  var sourceHdr = hdrFlag(source && source.is_hdr);
  // Unknown dynamic range is unsafe for cross-contract adaptation. Do not let
  // the predictor's historical soft 0.7 mismatch penalty bridge that gap.
  if (sourceHdr === null) return [];
  return (rows || []).filter(function (row) {
    return hdrFlag(row && row.is_hdr) === sourceHdr;
  });
}

function filterLegacyContractRows(rows) {
  return (rows || []).filter(function (row) {
    var contractId = row && row.reference_contract_id;
    if (contractId === null || contractId === undefined) {
      contractId = canonicalDenoise.LEGACY_REFERENCE_CONTRACT_ID;
    }
    return String(contractId) === canonicalDenoise.LEGACY_REFERENCE_CONTRACT_ID;
  });
}

/**
 * A paired canary attests the two commands it ran; it does not prove that an
 * arbitrary historical database row was produced by the canary's legacy-side
 * encoder profile.  Learned compensation is therefore allowed only when every
 * contributing row carries the exact comparison-profile attestation.  The
 * current historical schema deliberately has no such field, so old/mixed rows
 * remain useful through the neutral high-uncertainty planner and cannot
 * accidentally acquire a learned shift merely because of their timestamp.
 */
function legacyRowProfileAttestation(rows, expectedEncoderProfileId) {
  var expected = normalizedToken(expectedEncoderProfileId);
  var jobs = {};
  var matchedRows = 0;
  var unprofiledRows = 0;
  var mismatchedRows = 0;
  (rows || []).forEach(function (row, index) {
    var jobId = normalizedToken(row && row.job_id) || ('<missing-job-' + index + '>');
    var profile = normalizedToken(row && (row.reference_comparison_encoder_profile_id ||
      row.referenceComparisonEncoderProfileId || row.encoder_profile_id ||
      row.encoderProfileId));
    if (!jobs[jobId]) jobs[jobId] = { profiles: {}, rows: 0 };
    jobs[jobId].rows += 1;
    jobs[jobId].profiles[profile || '<unprofiled>'] = true;
    if (!profile) unprofiledRows += 1;
    else if (expected && profile === expected) matchedRows += 1;
    else mismatchedRows += 1;
  });
  var mixedJobs = Object.keys(jobs).filter(function (jobId) {
    return Object.keys(jobs[jobId].profiles).length !== 1;
  }).length;
  var rowCount = (rows || []).length;
  return {
    eligible: Boolean(expected) && rowCount > 0 && matchedRows === rowCount &&
      unprofiledRows === 0 && mismatchedRows === 0 && mixedJobs === 0,
    expectedEncoderProfileId: expected || null,
    rows: rowCount,
    jobs: Object.keys(jobs).length,
    matchedRows: matchedRows,
    unprofiledRows: unprofiledRows,
    mismatchedRows: mismatchedRows,
    mixedJobs: mixedJobs,
    semantics: 'learned-shift-requires-every-contributing-row-explicitly-attested',
  };
}

/**
 * Convert an authenticated calibration artifact to flat paired observations.
 * No database/file-path join is performed: a path by itself cannot prove that
 * two immutable-contract jobs decoded the same source bytes.  Canaries may
 * also write `observations` directly. Only schema-2 artifacts that explicitly
 * name the current NVEncC KNN reference/denoise identities are accepted.
 * Historical hqdn3d canaries target a different reference domain and cannot
 * be relabelled or used to manufacture a KNN calibration shift. Current
 * reports may learn an offset only after every hard cohort field and the exact
 * encoder profile match and enough independent source fingerprints agree.
 */
function observationsFromCalibrationArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') return [];
  if (Array.isArray(artifact.observations)) return artifact.observations.slice();
  if (Number(artifact.schema) !== CALIBRATION_ARTIFACT_SCHEMA ||
      artifact.purpose !== CALIBRATION_PURPOSE ||
      artifact.legacyReferenceContractId !== canonicalDenoise.LEGACY_REFERENCE_CONTRACT_ID ||
      artifact.canonicalReferenceContractId !== canonicalDenoise.REFERENCE_CONTRACT_ID ||
      artifact.denoiseId !== nvenccKnn.DENOISE_ID ||
      artifact.denoiseSettings !== nvenccKnn.KNN_SETTINGS ||
      Number(artifact.prerollSeconds) !== canonicalDenoise.PREROLL_SECONDS ||
      !Array.isArray(artifact.sources)) return [];

  var observations = [];
  artifact.sources.forEach(function (source) {
    if (!source || !Array.isArray(source.summary) || !source.label || !source.file) return;
    var byContractAndCq = {};
    source.summary.forEach(function (point) {
      var cq = finiteNumber(point && point.cq);
      var score = finiteNumber(point && (point.harmonic != null ? point.harmonic : point.mean));
      var contract = normalizedToken(point && point.contract);
      if (cq === null || score === null || (contract !== 'legacy' && contract !== 'canonical')) return;
      byContractAndCq[contract + '|' + cq] = score;
    });
    // New canaries hash bounded first/middle/last source regions. Historical
    // schema-1 artifacts lack that field, so retain a report-local identity for
    // uncertainty accounting only; their missing cohort context still makes
    // them ineligible to learn a production shift.
    var explicitFingerprint = source.source_fingerprint || source.sourceFingerprint || '';
    var explicitEncoderProfile = source.encoderProfileId || artifact.encoderProfileId || '';
    var fingerprint = explicitFingerprint ||
      ('attested-canary|' + source.file + '|' + source.durationSeconds + '|' +
      source.width + 'x' + source.height + '|' + source.pixelFormat);
    Object.keys(byContractAndCq).forEach(function (key) {
      if (key.indexOf('legacy|') !== 0) return;
      var cqText = key.slice('legacy|'.length);
      var canonicalScore = byContractAndCq['canonical|' + cqText];
      if (canonicalScore === undefined) return;
      observations.push({
        attested_pair: true,
        comparison_id: 'grain-contract-canary|' + source.label,
        source_fingerprint: fingerprint,
        encoder_key: explicitEncoderProfile || artifact.purpose,
        encoder_profile_attested: Boolean(explicitEncoderProfile),
        legacy_reference_contract_id: canonicalDenoise.LEGACY_REFERENCE_CONTRACT_ID,
        canonical_reference_contract_id: canonicalDenoise.REFERENCE_CONTRACT_ID,
        cq: Number(cqText),
        legacy_vmaf: byContractAndCq[key],
        canonical_vmaf: canonicalScore,
        tier: source.tier || tierFor(source.width, source.height),
        // Deliberately do not infer HDR, codec, or animation from labels/model
        // names. Contextless historical canaries therefore stay neutral.
        is_hdr: source.is_hdr,
        source_codec: source.source_codec,
        media_is_animation: source.media_is_animation,
      });
    });
  });
  return observations;
}

function normalizeCalibrationObservations(observations) {
  // Bridge rows compare the two historical reference selectors under the same
  // legacy GPU-v0 metric. The format has no VMAF-v1 metric identity, so its
  // 0-100 validation is intentionally not relaxed for native-v1 observations.
  var normalized = [];
  (observations || []).forEach(function (row) {
    if (!row || (row.attested_pair !== true && row.attestedPair !== true)) return;
    var comparisonId = normalizedToken(row.comparison_id || row.comparisonId);
    var fingerprint = normalizedToken(row.source_fingerprint || row.sourceFingerprint);
    var encoderKey = normalizedToken(row.encoder_key || row.encoderKey);
    var legacyContract = normalizedToken(row.legacy_reference_contract_id || row.legacyReferenceContractId);
    var canonicalContract = normalizedToken(row.canonical_reference_contract_id || row.canonicalReferenceContractId);
    var legacyCq = finiteNumber(row.legacy_cq != null ? row.legacy_cq : row.cq);
    var canonicalCq = finiteNumber(row.canonical_cq != null ? row.canonical_cq : row.cq);
    var legacyVmaf = finiteNumber(row.legacy_vmaf != null ? row.legacy_vmaf : row.legacyVmaf);
    var canonicalVmaf = finiteNumber(row.canonical_vmaf != null ? row.canonical_vmaf : row.canonicalVmaf);
    if (!comparisonId || !fingerprint || !encoderKey ||
        legacyContract !== canonicalDenoise.LEGACY_REFERENCE_CONTRACT_ID ||
        canonicalContract !== canonicalDenoise.REFERENCE_CONTRACT_ID ||
        legacyCq === null || canonicalCq === null ||
        Math.abs(legacyCq - canonicalCq) > 0.001 || legacyVmaf === null || canonicalVmaf === null ||
        legacyVmaf < 0 || legacyVmaf > 100 || canonicalVmaf < 0 || canonicalVmaf > 100) return;
    normalized.push({
      comparisonId: comparisonId,
      sourceFingerprint: fingerprint,
      encoderKey: encoderKey,
      stableSourceFingerprint: /^(?:sha256|sha256-sampled-v1):[0-9a-f]{64}$/.test(fingerprint),
      encoderProfileAttested: row.encoder_profile_attested !== false,
      cq: legacyCq,
      legacyVmaf: legacyVmaf,
      canonicalVmaf: canonicalVmaf,
      tier: normalizedToken(row.tier),
      isHdr: hdrFlag(row.is_hdr != null ? row.is_hdr : row.isHdr),
      sourceCodec: codecCategory(row.source_codec || row.sourceCodec),
      mediaIsAnimation: animationFlag(row.media_is_animation != null
        ? row.media_is_animation : row.mediaIsAnimation),
    });
  });
  return normalized;
}

function calibrationMatchesSource(row, source, expectedEncoderProfileId) {
  var sourceHdr = hdrFlag(source && source.is_hdr);
  var sourceTier = normalizedToken(source && source.tier);
  var sourceCodec = codecCategory(source && source.source_codec);
  var sourceAnimation = animationFlag(source && source.media_is_animation);
  var expectedEncoder = normalizedToken(expectedEncoderProfileId);
  // These are hard cohort boundaries. Missing calibration context is evidence
  // about uncertainty only; it may never move the production seed.
  return row.stableSourceFingerprint === true && row.encoderProfileAttested === true &&
    expectedEncoder && row.encoderKey === expectedEncoder &&
    sourceHdr !== null && row.isHdr === sourceHdr &&
    sourceTier && row.tier === sourceTier &&
    sourceCodec && row.sourceCodec === sourceCodec &&
    sourceAnimation !== null && row.mediaIsAnimation === sourceAnimation;
}

function collapseCalibrationRows(rows) {
  var cells = {};
  (rows || []).forEach(function (row) {
    var key = row.sourceFingerprint + '|' + row.comparisonId + '|' + row.encoderKey + '|' + row.cq;
    if (!cells[key]) cells[key] = { template: row, legacy: [], canonical: [] };
    cells[key].legacy.push(row.legacyVmaf);
    cells[key].canonical.push(row.canonicalVmaf);
  });
  return Object.keys(cells).map(function (key) {
    var cell = cells[key];
    var result = {};
    Object.keys(cell.template).forEach(function (name) { result[name] = cell.template[name]; });
    result.legacyVmaf = median(cell.legacy);
    result.canonicalVmaf = median(cell.canonical);
    return result;
  });
}

function perSourceAdapterCandidates(rows, centerCq, options) {
  options = options || {};
  var maxDistance = finiteNumber(options.maxCalibrationCqDistance);
  if (maxDistance === null) maxDistance = DEFAULT_MAX_CALIBRATION_CQ_DISTANCE;
  var groups = {};
  collapseCalibrationRows(rows).forEach(function (row) {
    var key = row.sourceFingerprint + '|' + row.comparisonId + '|' + row.encoderKey;
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  });

  var candidatesBySource = {};
  Object.keys(groups).forEach(function (key) {
    var points = groups[key].slice().sort(function (a, b) { return a.cq - b.cq; });
    if (points.length < 2) return;
    var slope = theilSenSlope(points, 'cq', 'legacyVmaf');
    // Degenerate/saturated and physically implausible curves cannot turn a
    // small score difference into an unbounded CQ correction.
    if (slope === null || slope >= -0.03 || slope < -1.5) return;
    var shiftPoints = points.map(function (point) {
      return { cq: point.cq, shift: -(point.canonicalVmaf - point.legacyVmaf) / slope };
    }).filter(function (point) { return isFinite(point.shift) && Math.abs(point.shift) <= 8; });
    if (shiftPoints.length < 2) return;
    var minCq = shiftPoints[0].cq;
    var maxCq = shiftPoints[shiftPoints.length - 1].cq;
    var distance = Math.max(0, minCq - centerCq, centerCq - maxCq);
    if (isFinite(centerCq) && distance > maxDistance) return;

    var shiftSlope = shiftPoints.length >= 3 ? theilSenSlope(shiftPoints, 'cq', 'shift') : null;
    if (shiftSlope !== null && Math.abs(shiftSlope) > 0.25) shiftSlope = null;
    var shift;
    if (shiftSlope === null || !isFinite(centerCq)) {
      shift = median(shiftPoints.map(function (point) { return point.shift; }));
    } else {
      var intercept = median(shiftPoints.map(function (point) { return point.shift - shiftSlope * point.cq; }));
      shift = intercept + shiftSlope * centerCq;
    }
    var residuals = shiftPoints.map(function (point) {
      return point.shift - (shiftSlope === null
        ? shift : shift + shiftSlope * (point.cq - centerCq));
    });
    var sourceId = points[0].sourceFingerprint;
    if (!candidatesBySource[sourceId]) candidatesBySource[sourceId] = [];
    candidatesBySource[sourceId].push({
      shift: shift,
      uncertainty: robustSigma(residuals, 0) || 0,
      points: shiftPoints.length,
      minCq: minCq,
      maxCq: maxCq,
    });
  });

  return Object.keys(candidatesBySource).map(function (sourceId) {
    var values = candidatesBySource[sourceId];
    return {
      sourceFingerprint: sourceId,
      shift: median(values.map(function (value) { return value.shift; })),
      uncertainty: Math.max.apply(Math, values.map(function (value) { return value.uncertainty; })),
      points: values.reduce(function (sum, value) { return sum + value.points; }, 0),
      minCq: Math.min.apply(Math, values.map(function (value) { return value.minCq; })),
      maxCq: Math.max.apply(Math, values.map(function (value) { return value.maxCq; })),
    };
  });
}

function buildCqAdapter(calibrationInput, source, centerCq, options) {
  options = options || {};
  var observations = [];
  if (Array.isArray(calibrationInput)) observations = calibrationInput.slice();
  else observations = observationsFromCalibrationArtifact(calibrationInput);
  var normalized = normalizeCalibrationObservations(observations);
  var expectedEncoderProfileId = normalizedToken(options.expectedEncoderProfileId ||
    (source && (source.encoder_profile_id || source.encoderProfileId)));
  var allCandidates = perSourceAdapterCandidates(normalized, Number(centerCq), options);
  var cohortRows = normalized.filter(function (row) {
    return calibrationMatchesSource(row, source || {}, expectedEncoderProfileId);
  });
  var candidates = perSourceAdapterCandidates(cohortRows, Number(centerCq), options);
  var pointCount = candidates.reduce(function (sum, value) { return sum + value.points; }, 0);
  var minSources = Math.max(1, Number(options.minCalibrationSources) || DEFAULT_MIN_CALIBRATION_SOURCES);
  var minPoints = Math.max(2, Number(options.minCalibrationPoints) || DEFAULT_MIN_CALIBRATION_POINTS);
  var maxShift = finiteNumber(options.maxAdapterShiftCq);
  if (maxShift === null) maxShift = DEFAULT_MAX_ADAPTER_SHIFT_CQ;

  if (candidates.length >= minSources && pointCount >= minPoints) {
    var shifts = candidates.map(function (candidate) { return candidate.shift; });
    var rawShift = median(shifts);
    var betweenSigma = robustSigma(shifts, rawShift) || 0;
    var withinSigma = median(candidates.map(function (candidate) { return candidate.uncertainty; })) || 0;
    var uncertainty = Math.max(0.75, betweenSigma, withinSigma, 2.5 / Math.sqrt(candidates.length));
    if (Math.abs(rawShift) > maxShift || uncertainty > 3) {
      return {
        mode: 'neutral_high_uncertainty_prior',
        deltaCq: 0,
        rawDeltaCq: rawShift,
        uncertaintyCq: Math.max(DEFAULT_PRIOR_UNCERTAINTY_CQ, uncertainty, Math.abs(rawShift)),
        legacyWeight: DEFAULT_UNCALIBRATED_WEIGHT,
        supportSources: candidates.length,
        supportPoints: pointCount,
        evidenceSources: allCandidates.length,
        shrinkage: 0,
        reason: Math.abs(rawShift) > maxShift
          ? 'attested_adapter_shift_out_of_bounds' : 'attested_adapter_uncertainty_too_high',
        expectedEncoderProfileId: expectedEncoderProfileId || null,
      };
    }
    var supportShrinkage = candidates.length / (candidates.length + 4);
    var reliability = supportShrinkage * Math.exp(-uncertainty / 4);
    var weight = clamp(DEFAULT_UNCALIBRATED_WEIGHT + 0.47 * reliability,
      DEFAULT_UNCALIBRATED_WEIGHT, 0.65);
    return {
      mode: 'learned_attested_cq_adapter',
      deltaCq: clamp(rawShift * supportShrinkage, -maxShift, maxShift),
      rawDeltaCq: rawShift,
      uncertaintyCq: uncertainty,
      legacyWeight: weight,
      supportSources: candidates.length,
      supportPoints: pointCount,
      evidenceSources: allCandidates.length,
      shrinkage: supportShrinkage,
      reason: 'attested_comparable_overlap',
      expectedEncoderProfileId: expectedEncoderProfileId,
    };
  }

  // Sparse or context-incomplete canary evidence may increase uncertainty but
  // can never supply an offset.  This preserves old curves as weak scheduling
  // evidence without pretending that two reference contracts are equivalent.
  var observedMagnitude = allCandidates.length ? Math.max.apply(Math, allCandidates.map(function (candidate) {
    return Math.abs(candidate.shift) + candidate.uncertainty;
  })) : 0;
  return {
    mode: 'neutral_high_uncertainty_prior',
    deltaCq: 0,
    rawDeltaCq: null,
    uncertaintyCq: Math.max(DEFAULT_PRIOR_UNCERTAINTY_CQ, observedMagnitude),
    legacyWeight: DEFAULT_UNCALIBRATED_WEIGHT,
    supportSources: candidates.length,
    supportPoints: pointCount,
    evidenceSources: allCandidates.length,
    shrinkage: 0,
    reason: normalized.length ? 'insufficient_comparable_attested_overlap' : 'no_attested_calibration',
    expectedEncoderProfileId: expectedEncoderProfileId || null,
  };
}

function sanitizeLegacyRows(rows, adapter) {
  var keys = [
    'job_id', 'timestamp', 'cq', 'bits_per_pixel', 'source_codec',
    'media_genre', 'media_is_animation', 'media_type', 'media_year', 'media_title',
    'release_group', 'is_hdr', 'network', 'original_language'
  ];
  return (rows || []).map(function (row) {
    var score = predictor.primaryVmaf(row || {});
    if (score === null) return null;
    var clean = {};
    keys.forEach(function (key) { if (row[key] !== undefined) clean[key] = row[key]; });
    clean.reference_contract_id = canonicalDenoise.LEGACY_REFERENCE_CONTRACT_ID;
    clean.vmaf_harmonic_mean = score;
    clean.vmaf_mean = score;
    clean.reference_contract_weight = adapter.legacyWeight;
    clean.reference_contract_uncertainty_cq = adapter.uncertaintyCq;
    clean.reference_contract_adapter_mode = adapter.mode;
    return clean;
  }).filter(Boolean);
}

function provenance(lookback, rowCount, adapter) {
  return {
    role: 'probe_planning_only',
    sourceReferenceContractId: canonicalDenoise.LEGACY_REFERENCE_CONTRACT_ID,
    targetReferenceContractId: canonicalDenoise.REFERENCE_CONTRACT_ID,
    acceptanceAuthority: 'fresh-current-contract-measurements-only',
    finalCqReuseAndOutcomeAuthority: false,
    legacySizeCambiAndFrameFloorIgnored: true,
    legacyScoresSanitizedToPrimaryVmafOnly: true,
    calibrationPairing: 'explicit-attested-pairs-only; never-file-path-join',
    maxAgeDays: lookback.maxAgeDays,
    recencyHalfLifeDays: lookback.recencyHalfLifeDays,
    lookbackSemantics: lookback.semantics,
    eligibleLegacyRows: rowCount,
    adapter: adapter || null,
  };
}

function jobSupportSummary(rows, source, lookback, options) {
  var jobs = {};
  (rows || []).forEach(function (row) {
    if (row && row.job_id && !jobs[row.job_id]) jobs[row.job_id] = row;
  });
  var nowMs = finiteNumber(options && options.nowMs) || Date.now();
  var sum = 0;
  var sumSquares = 0;
  Object.keys(jobs).forEach(function (jobId) {
    var weight = predictor.weightForPoint(source || {}, jobs[jobId], {
      recencyHalfLifeDays: lookback.recencyHalfLifeDays,
      nowMs: nowMs,
    });
    if (weight > 0) {
      sum += weight;
      sumSquares += weight * weight;
    }
  });
  return {
    rawJobs: Object.keys(jobs).length,
    totalWeight: sum,
    effectiveJobs: sumSquares > 0 ? (sum * sum) / sumSquares : 0,
  };
}

function effectiveJobSupport(rows, source, lookback, options) {
  return jobSupportSummary(rows, source, lookback, options).effectiveJobs;
}

function predictorCenter(rows, source, targetVmaf, lookback, options) {
  return predictor.predictCQCenter(rows, source || {}, { targetVmaf: Number(targetVmaf) }, {
    recencyHalfLifeDays: lookback.recencyHalfLifeDays,
    nowMs: finiteNumber(options.nowMs) || Date.now(),
    minNeighbours: Math.max(3, Number(options.minNeighbours) || 3),
    minSlopeSamples: Math.max(2, Number(options.minSlopeCurves) || DEFAULT_MIN_SLOPE_CURVES),
    learnWeights: options.learnWeights !== false,
  });
}

function buildSeed(legacyRows, source, targetVmaf, options) {
  options = options || {};
  var lookback = resolveLookback(options);
  var rows = filterRowsByHardSourceMatch(
    filterLegacyContractRows(filterRowsByLookback(legacyRows, options)), source);
  var neutralAdapter = buildCqAdapter(null, source, 33, options);
  var meta = provenance(lookback, rows.length, neutralAdapter);
  if (!rows.length) return { action: 'broad_fresh_sweep', reason: 'no_legacy_rows_in_lookback', provenance: meta };

  // First obtain only the legacy location. Contract reliability is uniform
  // across jobs, so using the neutral weight cannot bias this provisional
  // median; it simply prevents these clones being mistaken for canonical rows.
  var provisionalRows = sanitizeLegacyRows(rows, neutralAdapter);
  var provisional = predictorCenter(provisionalRows, source, targetVmaf, lookback, options);
  if (!provisional || provisional.centerCq === null || provisional.centerCq === undefined) {
    return {
      action: 'broad_fresh_sweep',
      reason: provisional && provisional.reason || 'insufficient_legacy_support',
      provenance: meta,
    };
  }

  var calibrationInput = options.calibrationObservations || options.calibrationArtifact || null;
  var expectedEncoderProfileId = options.expectedEncoderProfileId ||
    (source && (source.encoder_profile_id || source.encoderProfileId));
  var rowProfileAttestation = legacyRowProfileAttestation(rows, expectedEncoderProfileId);
  // A canary may move only a centre made entirely from rows explicitly
  // attested to that comparison profile. Untagged/mixed history still plans
  // probes through the neutral adapter; no data is discarded.
  var adapter = buildCqAdapter(rowProfileAttestation.eligible ? calibrationInput : null,
    source, provisional.centerCq, options);
  if (!rowProfileAttestation.eligible && calibrationInput) {
    adapter.reason = 'legacy_row_profile_unattested_or_mixed';
  }
  adapter.legacyRowProfileAttestation = rowProfileAttestation;
  var planningRows = sanitizeLegacyRows(rows, adapter);
  meta = provenance(lookback, rows.length, adapter);
  meta.compensatedLegacyRows = planningRows.length;
  var supportSummary = jobSupportSummary(planningRows, source, lookback, options);
  var minTotalWeight = finiteNumber(options.minTotalJobWeight);
  if (minTotalWeight === null) minTotalWeight = DEFAULT_MIN_TOTAL_JOB_WEIGHT;
  if (minTotalWeight < 0) throw new Error('legacy bridge minTotalJobWeight must be zero or positive');
  meta.rawSupportJobs = supportSummary.rawJobs;
  meta.effectiveSupportJobs = Math.round(supportSummary.effectiveJobs * 10) / 10;
  meta.totalSimilarityWeight = Math.round(supportSummary.totalWeight * 1000) / 1000;
  meta.minTotalSimilarityWeight = minTotalWeight;
  if (supportSummary.totalWeight < minTotalWeight) {
    return {
      action: 'broad_fresh_sweep',
      reason: 'insufficient_absolute_similarity_weight',
      provenance: meta,
    };
  }

  var center = predictorCenter(planningRows, source, targetVmaf, lookback, options);
  if (!center || center.centerCq === null || center.centerCq === undefined) {
    return { action: 'broad_fresh_sweep', reason: center && center.reason || 'insufficient_legacy_support', provenance: meta };
  }
  var shiftedCenter = Number(center.centerCq) + adapter.deltaCq;
  var uncertaintyPad = Math.ceil(adapter.uncertaintyCq);
  var adaptedSlope = -0.4 + (Number(center.priorSlope) + 0.4) * adapter.legacyWeight;
  return {
    action: 'schedule_fresh_seed_probes',
    centerCq: clamp(Math.round(shiftedCenter), 16, 51),
    rangeMin: clamp(Math.floor(Number(center.rangeMin) + adapter.deltaCq - uncertaintyPad), 16, 51),
    rangeMax: clamp(Math.ceil(Number(center.rangeMax) + adapter.deltaCq + uncertaintyPad), 16, 51),
    priorSlope: clamp(adaptedSlope, -1.2, -0.1),
    supportJobs: Number(center.support) || 0,
    effectiveSupportJobs: Math.round(supportSummary.effectiveJobs * 10) / 10,
    totalSimilarityWeight: Math.round(supportSummary.totalWeight * 1000) / 1000,
    slopeSupportCurves: Number(center.slopeSupport) || 0,
    adapterDeltaCq: Math.round(adapter.deltaCq * 1000) / 1000,
    adapterUncertaintyCq: Math.round(adapter.uncertaintyCq * 1000) / 1000,
    legacyEvidenceWeight: Math.round(adapter.legacyWeight * 1000) / 1000,
    provenance: meta,
  };
}

module.exports = {
  CALIBRATION_ARTIFACT_SCHEMA: CALIBRATION_ARTIFACT_SCHEMA,
  CALIBRATION_PURPOSE: CALIBRATION_PURPOSE,
  DEFAULT_MAX_AGE_DAYS: DEFAULT_MAX_AGE_DAYS,
  DEFAULT_HALF_LIFE_DAYS: DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_MIN_TOTAL_JOB_WEIGHT: DEFAULT_MIN_TOTAL_JOB_WEIGHT,
  DEFAULT_UNCALIBRATED_WEIGHT: DEFAULT_UNCALIBRATED_WEIGHT,
  DEFAULT_PRIOR_UNCERTAINTY_CQ: DEFAULT_PRIOR_UNCERTAINTY_CQ,
  resolveLookback: resolveLookback,
  filterRowsByLookback: filterRowsByLookback,
  filterRowsByHardSourceMatch: filterRowsByHardSourceMatch,
  filterLegacyContractRows: filterLegacyContractRows,
  legacyRowProfileAttestation: legacyRowProfileAttestation,
  observationsFromCalibrationArtifact: observationsFromCalibrationArtifact,
  normalizeCalibrationObservations: normalizeCalibrationObservations,
  calibrationMatchesSource: calibrationMatchesSource,
  perSourceAdapterCandidates: perSourceAdapterCandidates,
  buildCqAdapter: buildCqAdapter,
  sanitizeLegacyRows: sanitizeLegacyRows,
  jobSupportSummary: jobSupportSummary,
  effectiveJobSupport: effectiveJobSupport,
  buildSeed: buildSeed,
};
