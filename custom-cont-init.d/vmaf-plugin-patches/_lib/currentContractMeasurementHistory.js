'use strict';

var SCHEMA_VERSION = 1;
var MEASUREMENT_ORIGIN = 'fresh-current-job';
var MAX_POINTS = 256;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function deepClone(value) {
  if (Array.isArray(value)) {
    return value.map(deepClone);
  }
  if (value && typeof value === 'object') {
    var output = {};
    Object.keys(value).forEach(function (key) {
      output[key] = deepClone(value[key]);
    });
    return output;
  }
  return value;
}

function requiredText(value, label) {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new Error('current-contract measurement history requires ' + label);
  }
  return String(value);
}

function normalizeContext(context) {
  context = context || {};
  return {
    jobId: requiredText(context.jobId, 'jobId'),
    sourcePath: requiredText(context.sourcePath, 'sourcePath'),
    referenceContractId: requiredText(context.referenceContractId, 'referenceContractId'),
  };
}

function cqForPoint(point) {
  var rawCq = point && point.parameterSet && point.parameterSet.quality;
  if (rawCq === null || rawCq === undefined || String(rawCq).trim() === '') {
    throw new Error('current-contract measurement point requires a finite parameterSet.quality CQ');
  }
  var cq = Number(rawCq);
  if (!isFinite(cq)) {
    throw new Error('current-contract measurement point requires a finite parameterSet.quality CQ');
  }
  return cq;
}

function pointIdentity(point, context, requireStamps) {
  if (!point || typeof point !== 'object' || Array.isArray(point)) {
    throw new Error('current-contract measurement point must be an object');
  }
  if (hasOwn(point, 'reusedFromJobId')) {
    throw new Error('cross-job reused measurement cannot enter current-contract history');
  }
  if (point.measurementDisposition === 'paired_cq_inferred_v1' ||
      (Array.isArray(point.clipProvenance) && point.clipProvenance.some(function (value) {
        return value === 'paired_cq_inferred_v1';
      }))) {
    throw new Error('inferred paired-CQ evidence cannot enter current-contract measurement history');
  }

  var parameterSetId = requiredText(point.parameterSetId, 'point parameterSetId');
  var cq = cqForPoint(point);
  var origin = point.measurementOrigin;
  var measurementJobId = point.measurementJobId;
  var referenceContractId = point.referenceContractId;

  if (requireStamps || origin !== undefined) {
    if (origin !== MEASUREMENT_ORIGIN) {
      throw new Error('current-contract measurement point has the wrong measurement origin');
    }
  }
  if (requireStamps || measurementJobId !== undefined) {
    if (String(measurementJobId || '') !== context.jobId) {
      throw new Error('current-contract measurement point has the wrong job id');
    }
  }
  if (requireStamps || referenceContractId !== undefined) {
    if (String(referenceContractId || '') !== context.referenceContractId) {
      throw new Error('current-contract measurement point has the wrong reference contract');
    }
  }

  var normalizedCq = Number(cq.toFixed(6));
  return {
    parameterSetId: parameterSetId,
    normalizedCq: normalizedCq,
    cqKey: normalizedCq.toFixed(6),
    key: context.referenceContractId + '\u0000' + parameterSetId + '\u0000' + normalizedCq.toFixed(6),
  };
}

function validateEnvelope(envelope, context) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('current-contract measurement history envelope must be an object');
  }
  if (envelope.schema !== SCHEMA_VERSION) {
    throw new Error('unsupported current-contract measurement history schema');
  }
  if (String(envelope.jobId || '') !== context.jobId) {
    throw new Error('current-contract measurement history job changed without a reset');
  }
  if (String(envelope.sourcePath || '') !== context.sourcePath) {
    throw new Error('current-contract measurement history source changed without a reset');
  }
  if (String(envelope.referenceContractId || '') !== context.referenceContractId) {
    throw new Error('current-contract measurement history reference contract changed without a reset');
  }
  if (!Array.isArray(envelope.points)) {
    throw new Error('current-contract measurement history points must be an array');
  }
  if (envelope.points.length > MAX_POINTS) {
    throw new Error('current-contract measurement history exceeds the point limit');
  }
  var round = Number(envelope.round);
  if (!isFinite(round) || round < 0 || Math.floor(round) !== round) {
    throw new Error('current-contract measurement history round is invalid');
  }
  return round;
}

function mergeCurrentMeasurements(previousEnvelope, rawContext, currentPoints) {
  var context = normalizeContext(rawContext);
  if (!Array.isArray(currentPoints)) {
    throw new Error('current-contract measurements must be an array');
  }

  var previousPoints = [];
  var previousRound = 0;
  if (previousEnvelope !== null && previousEnvelope !== undefined) {
    previousRound = validateEnvelope(previousEnvelope, context);
    previousPoints = previousEnvelope.points;
  }

  var byKey = new Map();
  var cqByParameterSetId = new Map();

  function addPoint(rawPoint, requireStamps) {
    var identity = pointIdentity(rawPoint, context, requireStamps);
    var priorCq = cqByParameterSetId.get(identity.parameterSetId);
    if (priorCq !== undefined && priorCq !== identity.cqKey) {
      throw new Error('parameterSetId ' + identity.parameterSetId + ' changed CQ within current-contract history');
    }
    cqByParameterSetId.set(identity.parameterSetId, identity.cqKey);

    var point = deepClone(rawPoint);
    point.measurementOrigin = MEASUREMENT_ORIGIN;
    point.measurementJobId = context.jobId;
    point.referenceContractId = context.referenceContractId;
    byKey.set(identity.key, point);
  }

  previousPoints.forEach(function (point) { addPoint(point, true); });
  currentPoints.forEach(function (point) { addPoint(point, false); });

  if (byKey.size > MAX_POINTS) {
    throw new Error('current-contract measurement history exceeds the point limit');
  }

  return {
    schema: SCHEMA_VERSION,
    jobId: context.jobId,
    sourcePath: context.sourcePath,
    referenceContractId: context.referenceContractId,
    round: previousRound + 1,
    points: Array.from(byKey.values()),
  };
}

function publishPoints(envelope) {
  if (!envelope || !Array.isArray(envelope.points)) {
    throw new Error('cannot publish an invalid current-contract measurement history envelope');
  }
  return deepClone(envelope.points);
}

module.exports = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  MEASUREMENT_ORIGIN: MEASUREMENT_ORIGIN,
  MAX_POINTS: MAX_POINTS,
  mergeCurrentMeasurements: mergeCurrentMeasurements,
  publishPoints: publishPoints,
};
