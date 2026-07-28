'use strict';

/**
 * Pure command metadata builder and JSON parser for the pinned CPU VMAF v1
 * runtime. This module deliberately does not execute the command or inspect
 * media. Callers must authenticate and prepare both inputs separately.
 */

const BACKEND = 'cpu-vmaf-v1';
const REVISION = '78e11b52c8fc1fcc6d15afd6c7479394fb3bc6af';
const WRAPPER_PATH = '/usr/local/bin/vmaf-v1';
const SCORE_WRAPPER_PATH = '/usr/local/bin/vmaf-v1-score';
const PIXEL_FORMAT = 'yuv420p10le';
const CHROMA_SUBSAMPLING = '420';
const BIT_DEPTH = 10;
// These are two different contracts emitted by the same scorer invocation:
// - The model-qualified candidate CAMBI feature is configured with cmxv=17.
// - The explicit full_ref CAMBI feature does not set cmxv, so pinned libvmaf
//   78e11b52 uses DEFAULT_CAMBI_MAX_VAL=1000 for its distorted/source/delta
//   observations (cambi, cambi_source, cambi_full_reference). cmxv is an
//   output clip, not a mathematical claim that every CAMBI feature is <= 17.
const CAMBI_MODEL_MAX = 17;
const CAMBI_FULL_REFERENCE_MAX = 1000;
const CAMBI_ALIAS = 'cambi_hrs_1080_cmxv_17_vlt_0.06';
const CAMBI_PQ_ALIAS = 'cambi_ceot_pq_hrs_1080_cmxv_17_vlt_0.06';

const POOLING_METHODS = new Set(['min', 'max', 'mean', 'harmonic_mean']);
const TRANSPORTS = new Set(['raw', 'y4m']);
const FFPROBE_PATH = '/usr/local/bin/tdarr-ffprobe';

const MODEL_DEFINITIONS = Object.freeze({
  '1080p-3h': Object.freeze({
    version: 'vmaf_v1.0.16_3d0h',
    resolutionClass: '1080p',
    viewingDistance: '3h',
    maxScore: 100,
    cambiAlias: CAMBI_ALIAS,
  }),
  '4k-1.5h': Object.freeze({
    version: 'vmaf_v1.0.16_1d5h_2160',
    resolutionClass: '4k',
    viewingDistance: '1.5h',
    maxScore: 100,
    cambiAlias: CAMBI_ALIAS,
  }),
  '4k-3h': Object.freeze({
    version: 'vmaf_v1.0.16_3d0h_2160',
    resolutionClass: '4k',
    viewingDistance: '3h',
    maxScore: 110,
    cambiAlias: CAMBI_ALIAS,
  }),
  '1080p-hfr-3h': Object.freeze({
    version: 'vmaf_v1.0.16_hfr_3d0h',
    resolutionClass: '1080p',
    viewingDistance: '3h',
    maxScore: 100,
    cambiAlias: CAMBI_ALIAS,
  }),
  '4k-hfr-1.5h': Object.freeze({
    version: 'vmaf_v1.0.16_hfr_1d5h_2160',
    resolutionClass: '4k',
    viewingDistance: '1.5h',
    maxScore: 110,
    cambiAlias: CAMBI_ALIAS,
  }),
});

const MODELS_BY_VERSION = new Map(
  Object.values(MODEL_DEFINITIONS).map((model) => [model.version, model]),
);
const MODEL_PROFILES_BY_VERSION = new Map(
  Object.entries(MODEL_DEFINITIONS).map(([profile, model]) => [model.version, profile]),
);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}

function geometryError(code, message, ErrorType = RangeError) {
  const error = new ErrorType(message);
  error.code = code;
  return error;
}

function parsedAspectRatio(value, label) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  const match = text.match(/^(\d+):(\d+)$/u);
  const rawNumerator = match ? Number(match[1]) : NaN;
  const rawDenominator = match ? Number(match[2]) : NaN;
  if (!match || !Number.isSafeInteger(rawNumerator) || rawNumerator <= 0
      || !Number.isSafeInteger(rawDenominator) || rawDenominator <= 0) {
    throw geometryError(
      'VMAF_V1_GEOMETRY_INCOMPLETE',
      `${label} must be an explicit positive N:D ratio with safe-integer components`,
      TypeError,
    );
  }
  let numerator = rawNumerator;
  let denominator = rawDenominator;
  function gcd(a, b) {
    while (b) { const next = a % b; a = b; b = next; }
    return a;
  }
  const divisor = gcd(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  return Object.freeze({
    numerator,
    denominator,
    text: `${numerator}:${denominator}`,
  });
}

function assertPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty path without control characters`);
  }
}

function resolutionClassForGeometry(width, height) {
  // Preserve two documented display-model families without treating every
  // lower-resolution raster as 1080p/4K:
  //   * full-width scope crops (1920x720..1080, 3840x1440..2160)
  //   * full-height 4:3/anamorphic rasters (1440..1920x1080,
  //     2880..3840x2160)
  // The latter covers real 1440x1080 Blu-ray material while 1280x720 and
  // 2560x1440 remain outside this immutable contract. The scorer independently
  // requires exact reference/candidate coded geometry and transport identity.
  if (width % 2 !== 0 || height % 2 !== 0) return null;
  if ((width === 1920 && height >= 720 && height <= 1080)
      || (height === 1080 && width >= 1440 && width <= 1920)) return '1080p';
  if ((width === 3840 && height >= 1440 && height <= 2160)
      || (height === 2160 && width >= 2880 && width <= 3840)) return '4k';
  return null;
}

/**
 * Authenticate the complete coded/display geometry accepted by the pinned
 * model families. The exact rational equality prevents a stale or inferred
 * DAR from laundering a crop or anamorphic source into CPU-v1 authority.
 */
function validateGeometry(options) {
  assertPlainObject(options, 'geometry options');
  try {
    assertPositiveInteger(options.width, 'width');
    assertPositiveInteger(options.height, 'height');
  } catch (error) {
    throw geometryError(
      'VMAF_V1_GEOMETRY_INCOMPLETE',
      `CPU VMAF-v1 geometry requires positive integer coded dimensions: ${error.message}`,
      TypeError,
    );
  }
  if (options.geometryNormalization !== 'none') {
    throw geometryError(
      'VMAF_V1_GEOMETRY_NORMALIZATION_UNSUPPORTED',
      'CPU VMAF-v1 geometryNormalization must explicitly be none',
    );
  }

  const sample = parsedAspectRatio(options.sampleAspectRatio, 'sampleAspectRatio');
  const display = parsedAspectRatio(options.displayAspectRatio, 'displayAspectRatio');
  const resolutionClass = resolutionClassForGeometry(options.width, options.height);
  if (!resolutionClass) {
    throw geometryError(
      'VMAF_V1_GEOMETRY_UNSUPPORTED',
      `CPU VMAF-v1 does not support coded geometry ${options.width}x${options.height}; `
        + 'only even 1080/2160 full-height or 1920/3840 full-width model-family rasters are eligible',
    );
  }

  const expectedLeft = BigInt(options.width)
    * BigInt(sample.numerator)
    * BigInt(display.denominator);
  const expectedRight = BigInt(options.height)
    * BigInt(sample.denominator)
    * BigInt(display.numerator);
  if (expectedLeft !== expectedRight) {
    throw geometryError(
      'VMAF_V1_GEOMETRY_ASPECT_MISMATCH',
      `CPU VMAF-v1 coded geometry ${options.width}x${options.height}, `
        + `SAR ${sample.text}, and DAR ${display.text} are inconsistent`,
    );
  }

  return Object.freeze({
    width: options.width,
    height: options.height,
    sampleAspectRatio: sample.text,
    displayAspectRatio: display.text,
    geometryNormalization: 'none',
    resolutionClass,
  });
}

function selectModel({ width, height, modelProfile } = {}) {
  assertPositiveInteger(width, 'width');
  assertPositiveInteger(height, 'height');

  let resolutionClass;
  let defaultProfile;
  resolutionClass = resolutionClassForGeometry(width, height);
  if (resolutionClass === '1080p') {
    defaultProfile = '1080p-3h';
  } else if (resolutionClass === '4k') {
    defaultProfile = '4k-1.5h';
  } else {
    throw new RangeError('VMAF v1 model selection supports only 1080p or 4K full-width display geometry');
  }

  const profile = modelProfile || defaultProfile;
  const model = MODEL_DEFINITIONS[profile];
  if (!model) {
    throw new RangeError(`unsupported VMAF v1 modelProfile: ${profile}`);
  }
  if (model.resolutionClass !== resolutionClass) {
    throw new RangeError(`modelProfile ${profile} is not valid for ${resolutionClass}`);
  }

  // Return a copy so public callers cannot observe or attempt to mutate the
  // private definition object. The command builder freezes its own copy.
  return { ...model };
}

function buildMetricIdentity(options) {
  assertPlainObject(options, 'metric identity options');

  if (options.backend !== undefined && options.backend !== BACKEND) {
    throw new RangeError(`backend must be ${BACKEND}`);
  }
  if (options.revision !== undefined && options.revision !== REVISION) {
    throw new RangeError(`revision must be ${REVISION}`);
  }
  if (!MODELS_BY_VERSION.has(options.model)) {
    throw new RangeError('model must be a supported built-in VMAF v1 model');
  }
  if (options.pixelFormat !== PIXEL_FORMAT) {
    throw new RangeError(`pixelFormat must be ${PIXEL_FORMAT}`);
  }
  if (options.bitDepth !== BIT_DEPTH) {
    throw new RangeError('bitDepth must preserve the native 10-bit contract');
  }
  if (!POOLING_METHODS.has(options.pooling)) {
    throw new RangeError('pooling must be min, max, mean, or harmonic_mean');
  }
  assertPositiveInteger(options.subsample, 'subsample');
  const geometry = validateGeometry({
    width: options.codedWidth,
    height: options.codedHeight,
    sampleAspectRatio: options.sampleAspectRatio,
    displayAspectRatio: options.displayAspectRatio,
    geometryNormalization: options.geometryNormalization,
  });
  if (!['sdr', 'hdr-pq-provisional'].includes(options.contentClass)) {
    throw new RangeError('contentClass must be sdr or hdr-pq-provisional');
  }

  const fields = {
    backend: BACKEND,
    revision: REVISION,
    model: options.model,
    pixelFormat: PIXEL_FORMAT,
    bitDepth: BIT_DEPTH,
    pooling: options.pooling,
    subsample: options.subsample,
    contentClass: options.contentClass,
    codedWidth: geometry.width,
    codedHeight: geometry.height,
    sampleAspectRatio: geometry.sampleAspectRatio,
    displayAspectRatio: geometry.displayAspectRatio,
    geometryNormalization: geometry.geometryNormalization,
  };
  const id = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join('|');

  return Object.freeze({ id, ...fields });
}

function buildCommand(options) {
  assertPlainObject(options, 'command options');

  const {
    referencePath,
    distortedPath,
    outputPath,
    width,
    height,
    sampleAspectRatio,
    displayAspectRatio,
    geometryNormalization,
    transport,
    pixelFormat,
    bitDepth,
    frameCount,
    subsample = 1,
    pooling = 'harmonic_mean',
    contentClass = 'sdr',
    modelProfile,
    fullReferenceCambi = false,
    allowProvisionalHdr = false,
    threads,
  } = options;

  assertPath(referencePath, 'referencePath');
  assertPath(distortedPath, 'distortedPath');
  assertPath(outputPath, 'outputPath');
  const geometry = validateGeometry({
    width,
    height,
    sampleAspectRatio,
    displayAspectRatio,
    geometryNormalization,
  });
  if (!TRANSPORTS.has(transport)) {
    throw new RangeError('transport must be raw or y4m');
  }
  if (transport === 'y4m'
      && (!/\.y4m$/iu.test(referencePath) || !/\.y4m$/iu.test(distortedPath))) {
    throw new RangeError('y4m transport requires .y4m reference and distorted paths');
  }
  if (pixelFormat !== PIXEL_FORMAT) {
    throw new RangeError(`pixelFormat must be ${PIXEL_FORMAT}`);
  }
  if (bitDepth !== BIT_DEPTH) {
    throw new RangeError('bitDepth must preserve the native 10-bit contract');
  }
  assertPositiveInteger(frameCount, 'frameCount');
  assertPositiveInteger(subsample, 'subsample');
  if (threads !== undefined) assertPositiveInteger(threads, 'threads');
  if (typeof fullReferenceCambi !== 'boolean') {
    throw new TypeError('fullReferenceCambi must be a boolean');
  }

  let identityContentClass;
  let contractStatus;
  let modelValidatedForContent;
  if (contentClass === 'sdr') {
    identityContentClass = 'sdr';
    contractStatus = 'model-documented-sdr-runtime-unqualified';
    modelValidatedForContent = true;
  } else if (contentClass === 'hdr-pq') {
    if (allowProvisionalHdr !== true) {
      throw new Error('HDR is provisional and requires allowProvisionalHdr=true');
    }
    identityContentClass = 'hdr-pq-provisional';
    contractStatus = 'provisional-hdr-unvalidated';
    modelValidatedForContent = false;
  } else {
    throw new RangeError('contentClass must be sdr or hdr-pq');
  }

  const selectedModel = selectModel({
    width: geometry.width,
    height: geometry.height,
    modelProfile,
  });
  const model = Object.freeze({
    ...selectedModel,
    // The pinned FIFO scorer passes name=<model version> to libvmaf. Bind that
    // exact JSON metric alias so results from another model (or a bare default
    // alias) can never be accepted as this measurement.
    vmafAlias: selectedModel.version,
    // PQ EOTF produces a distinct model-qualified CAMBI key alongside the
    // standalone `cambi_ceot_pq` full-reference feature. Bind the exact model
    // key so the parser does not guess between those two candidate metrics.
    cambiAlias: identityContentClass === 'hdr-pq-provisional'
      ? CAMBI_PQ_ALIAS : CAMBI_ALIAS,
  });
  const metricIdentity = buildMetricIdentity({
    model: model.version,
    pixelFormat,
    bitDepth,
    pooling,
    subsample,
    contentClass: identityContentClass,
    codedWidth: geometry.width,
    codedHeight: geometry.height,
    sampleAspectRatio: geometry.sampleAspectRatio,
    displayAspectRatio: geometry.displayAspectRatio,
    geometryNormalization: geometry.geometryNormalization,
  });

  const modelOptions = [`version=${model.version}`, `name=${model.vmafAlias}`];
  if (identityContentClass === 'hdr-pq-provisional') {
    modelOptions.push('cambi.cambi_eotf=pq');
  }

  const args = [
    '--reference', referencePath,
    '--distorted', distortedPath,
  ];
  if (transport === 'raw') {
    args.push(
      '--width', String(geometry.width),
      '--height', String(geometry.height),
      '--pixel_format', CHROMA_SUBSAMPLING,
      '--bitdepth', String(BIT_DEPTH),
    );
  }
  args.push(
    '--model', modelOptions.join(':'),
    '--output', outputPath,
    '--json',
    '--subsample', String(subsample),
    '--frame_cnt', String(frameCount),
  );
  if (fullReferenceCambi) args.push('--feature', 'cambi=full_ref=true');
  if (threads !== undefined) args.push('--threads', String(threads));
  args.push('--quiet');

  const transportMetadata = Object.freeze({
    kind: transport,
    pixelFormat: PIXEL_FORMAT,
    chromaSubsampling: CHROMA_SUBSAMPLING,
    bitDepth: BIT_DEPTH,
    width: geometry.width,
    height: geometry.height,
    sampleAspectRatio: geometry.sampleAspectRatio,
    displayAspectRatio: geometry.displayAspectRatio,
    geometryNormalization: geometry.geometryNormalization,
  });
  const expectedMeasuredFrames = Math.floor((frameCount - 1) / subsample) + 1;

  return Object.freeze({
    executable: WRAPPER_PATH,
    args: Object.freeze(args),
    backend: BACKEND,
    revision: REVISION,
    transport: transportMetadata,
    model,
    metricIdentity,
    frameCount,
    expectedMeasuredFrames,
    fullReferenceCambi,
    contractStatus,
    modelValidatedForContent,
  });
}

function validateCommandMetadata(command) {
  assertPlainObject(command, 'command metadata');
  const validIdentity = command.metricIdentity
    && command.metricIdentity.backend === BACKEND
    && command.metricIdentity.revision === REVISION
    && command.metricIdentity.id === buildMetricIdentity(command.metricIdentity).id;
  const expectedModel = command.model && MODELS_BY_VERSION.get(command.model.version);
  const expectedVmafAlias = expectedModel && expectedModel.version;
  const expectedCambiAlias = command.metricIdentity
    && command.metricIdentity.contentClass === 'hdr-pq-provisional'
    ? CAMBI_PQ_ALIAS : CAMBI_ALIAS;
  const contentContractValid = command.metricIdentity
    && ((command.metricIdentity.contentClass === 'sdr'
      && command.contractStatus === 'model-documented-sdr-runtime-unqualified'
      && command.modelValidatedForContent === true)
      || (command.metricIdentity.contentClass === 'hdr-pq-provisional'
        && command.contractStatus === 'provisional-hdr-unvalidated'
        && command.modelValidatedForContent === false));
  const transportValid = command.transport
    && TRANSPORTS.has(command.transport.kind)
    && command.transport.pixelFormat === PIXEL_FORMAT
    && command.transport.chromaSubsampling === CHROMA_SUBSAMPLING
    && command.transport.bitDepth === BIT_DEPTH
    && command.transport.width === command.metricIdentity.codedWidth
    && command.transport.height === command.metricIdentity.codedHeight
    && command.transport.sampleAspectRatio === command.metricIdentity.sampleAspectRatio
    && command.transport.displayAspectRatio === command.metricIdentity.displayAspectRatio
    && command.transport.geometryNormalization === command.metricIdentity.geometryNormalization
    && resolutionClassForGeometry(command.transport.width, command.transport.height)
      === command.model.resolutionClass;
  const valid = command.executable === WRAPPER_PATH
    && command.backend === BACKEND
    && command.revision === REVISION
    && expectedModel
    && command.model.maxScore === expectedModel.maxScore
    && command.model.vmafAlias === expectedVmafAlias
    && command.model.cambiAlias === expectedCambiAlias
    && validIdentity
    && contentContractValid
    && transportValid
    && command.metricIdentity.model === command.model.version
    && Number.isSafeInteger(command.frameCount)
    && command.frameCount > 0
    && command.expectedMeasuredFrames
      === Math.floor((command.frameCount - 1) / command.metricIdentity.subsample) + 1
    && typeof command.fullReferenceCambi === 'boolean';
  if (!valid) throw new Error('invalid command metadata for pinned CPU VMAF v1 helper');
}

function parseDocument(input) {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch (error) {
      throw new SyntaxError(`VMAF output is not valid JSON: ${error.message}`);
    }
  }
  assertPlainObject(input, 'VMAF output');
  return input;
}

function exactVmafAlias(metrics, command, label) {
  assertPlainObject(metrics, label);
  const aliases = Object.keys(metrics).filter((key) =>
    key === 'vmaf' || key.startsWith('vmaf_'));
  const expected = command && command.model && command.model.vmafAlias;
  if (!expected || aliases.length !== 1 || aliases[0] !== expected) {
    throw new Error(aliases.length
      ? `${label} has unexpected VMAF metric aliases: ${aliases.join(', ')}; expected ${expected || '(missing command alias)'}`
      : `${label} is missing exact VMAF metric ${expected || '(missing command alias)'}`);
  }
  return expected;
}

function findAliases(metrics, command, label = 'metrics') {
  assertPlainObject(metrics, label);
  const keys = Object.keys(metrics);
  const expected = command && command.model && command.model.cambiAlias;
  const expectedBareDistorted = command.fullReferenceCambi
    ? (command.metricIdentity.contentClass === 'hdr-pq-provisional'
      ? 'cambi_ceot_pq' : 'cambi')
    : null;
  const bareDistorted = keys.filter((key) =>
    key === 'cambi' || key === 'cambi_ceot_pq');
  const candidates = keys.filter((key) => (
    key.startsWith('cambi_')
      && !key.startsWith('cambi_source')
      && !key.startsWith('cambi_full_reference')
      && key !== 'cambi_ceot_pq'
  ));
  const observedCandidates = candidates.concat(bareDistorted);
  if (!expected || candidates.length !== 1 || candidates[0] !== expected) {
    throw new Error(observedCandidates.length
      ? `${label} has unexpected candidate CAMBI metric aliases: ${observedCandidates.join(', ')}; expected ${expected || '(missing command alias)'}`
      : `${label} is missing exact candidate CAMBI metric ${expected || '(missing command alias)'}`);
  }

  // `--feature cambi=full_ref=true` publishes a second standalone distorted
  // metric alongside the model-qualified candidate feature: `cambi` for SDR
  // and `cambi_ceot_pq` for provisional PQ. It is an expected, separately
  // bounded full-reference observation, not a competing candidate alias. Bind
  // it exactly so arbitrary duplicate model aliases remain fail-closed.
  if ((expectedBareDistorted
      && (bareDistorted.length !== 1 || bareDistorted[0] !== expectedBareDistorted))
      || (!expectedBareDistorted && bareDistorted.length !== 0)) {
    throw new Error(bareDistorted.length
      ? `${label} has unexpected full-reference distorted CAMBI metric aliases: ${bareDistorted.join(', ')}; expected ${expectedBareDistorted || 'none'}`
      : `${label} is missing exact full-reference distorted CAMBI metric ${expectedBareDistorted}`);
  }

  const source = keys.filter((key) => key === 'cambi_source' || key.startsWith('cambi_source_'));
  const fullReference = keys.filter((key) => (
    key === 'cambi_full_reference' || key.startsWith('cambi_full_reference_')
  ));
  const expectedSource = command.fullReferenceCambi ? 'cambi_source' : null;
  const expectedFullReference = command.fullReferenceCambi ? 'cambi_full_reference' : null;
  if ((expectedSource && (source.length !== 1 || source[0] !== expectedSource))
      || (!expectedSource && source.length !== 0)) {
    throw new Error(source.length
      ? `${label} has unexpected source CAMBI metric aliases: ${source.join(', ')}; expected ${expectedSource || 'none'}`
      : `${label} is missing exact source CAMBI metric ${expectedSource}`);
  }
  if ((expectedFullReference
      && (fullReference.length !== 1 || fullReference[0] !== expectedFullReference))
      || (!expectedFullReference && fullReference.length !== 0)) {
    throw new Error(fullReference.length
      ? `${label} has unexpected full-reference CAMBI metric aliases: ${fullReference.join(', ')}; expected ${expectedFullReference || 'none'}`
      : `${label} is missing exact full-reference CAMBI metric ${expectedFullReference}`);
  }

  return {
    cambi: expected,
    cambiDistorted: expectedBareDistorted || undefined,
    cambiSource: expectedSource || undefined,
    cambiFullReference: expectedFullReference || undefined,
  };
}

function assertScore(value, label, min, max) {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  // Harmonic aggregation can produce an IEEE-754 residue such as
  // 100.0000000000000142 for an all-100 sequence. Normalize only values within
  // a tiny arithmetic tolerance of the model-specific bound; this is not a
  // global VMAF clamp and materially out-of-contract observations still fail.
  const tolerance = 1e-9;
  if (value < min - tolerance || value > max + tolerance) {
    throw new RangeError(`${label} ${value} is outside the allowed range [${min}, ${max}]`);
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function pooledScore(pooledMetrics, alias, pooling, label, min, max) {
  if (!alias) return undefined;
  const metric = pooledMetrics[alias];
  assertPlainObject(metric, `pooled metric ${alias}`);
  for (const [method, value] of Object.entries(metric)) {
    if (POOLING_METHODS.has(method)) assertScore(value, `${label} ${method}`, min, max);
  }
  if (!Object.prototype.hasOwnProperty.call(metric, pooling)) {
    throw new Error(`pooled metric ${alias} is missing ${pooling}`);
  }
  return assertScore(metric[pooling], `${label} ${pooling}`, min, max);
}

function frameScore(metrics, alias, label, min, max, required = true) {
  if (!alias || !Object.prototype.hasOwnProperty.call(metrics, alias)) {
    if (required) throw new Error(`missing ${label}`);
    return undefined;
  }
  return assertScore(metrics[alias], label, min, max);
}

function parseOutput(input, command) {
  validateCommandMetadata(command);
  const document = parseDocument(input);

  if (!Array.isArray(document.frames)) throw new TypeError('VMAF output frames must be an array');
  if (document.frames.length !== command.expectedMeasuredFrames) {
    throw new Error(
      `VMAF output frame count ${document.frames.length} does not match expected frame count ${command.expectedMeasuredFrames}`,
    );
  }
  assertPlainObject(document.pooled_metrics, 'VMAF output pooled_metrics');
  const vmafAlias = exactVmafAlias(document.pooled_metrics, command, 'pooled_metrics');

  const aliases = findAliases(document.pooled_metrics, command, 'pooled_metrics');
  const candidateCambiMax = CAMBI_MODEL_MAX;

  const pooling = command.metricIdentity.pooling;
  const maxVmaf = command.model.maxScore;
  const parsedFrames = document.frames.map((frame, index) => {
    assertPlainObject(frame, `frame ${index}`);
    const expectedFrameNum = index * command.metricIdentity.subsample;
    if (!Number.isSafeInteger(frame.frameNum) || frame.frameNum !== expectedFrameNum) {
      throw new Error(`frameNum at output index ${index} must be ${expectedFrameNum}`);
    }
    assertPlainObject(frame.metrics, `frame ${frame.frameNum} metrics`);
    exactVmafAlias(frame.metrics, command, `frame ${frame.frameNum} metrics`);
    findAliases(frame.metrics, command, `frame ${frame.frameNum} metrics`);

    const parsed = {
      frameNum: frame.frameNum,
      vmaf: frameScore(frame.metrics, vmafAlias,
        `VMAF frame ${frame.frameNum} score (${vmafAlias})`, 0, maxVmaf),
      cambi: frameScore(frame.metrics, aliases.cambi,
        `CAMBI frame ${frame.frameNum} score (${aliases.cambi})`, 0, candidateCambiMax),
    };
    if (aliases.cambiDistorted || command.fullReferenceCambi) {
      parsed.cambiDistorted = frameScore(
        frame.metrics,
        aliases.cambiDistorted,
        `full-reference distorted CAMBI frame ${frame.frameNum} score (${aliases.cambiDistorted})`,
        0,
        CAMBI_FULL_REFERENCE_MAX,
        command.fullReferenceCambi,
      );
    }
    if (aliases.cambiSource || command.fullReferenceCambi) {
      parsed.cambiSource = frameScore(
        frame.metrics,
        aliases.cambiSource,
        `source CAMBI frame ${frame.frameNum} score (${aliases.cambiSource})`,
        0,
        CAMBI_FULL_REFERENCE_MAX,
        command.fullReferenceCambi,
      );
    }
    if (aliases.cambiFullReference || command.fullReferenceCambi) {
      parsed.cambiFullReference = frameScore(
        frame.metrics,
        aliases.cambiFullReference,
        `full-reference CAMBI frame ${frame.frameNum} score (${aliases.cambiFullReference})`,
        0,
        CAMBI_FULL_REFERENCE_MAX,
        command.fullReferenceCambi,
      );
    }
    return Object.freeze(parsed);
  });

  const result = {
    metricIdentity: command.metricIdentity,
    contractStatus: command.contractStatus,
    modelValidatedForContent: command.modelValidatedForContent,
    frameCount: parsedFrames.length,
    expectedFrameCount: command.expectedMeasuredFrames,
    vmaf: pooledScore(document.pooled_metrics, vmafAlias, pooling, 'VMAF pooled score', 0, maxVmaf),
    cambi: pooledScore(
      document.pooled_metrics,
      aliases.cambi,
      pooling,
      'CAMBI pooled score',
      0,
      candidateCambiMax,
    ),
    aliases: Object.freeze({ vmaf: vmafAlias, ...aliases }),
    frames: Object.freeze(parsedFrames),
  };
  if (aliases.cambiDistorted || command.fullReferenceCambi) {
    result.cambiDistorted = pooledScore(
      document.pooled_metrics,
      aliases.cambiDistorted,
      pooling,
      'full-reference distorted CAMBI pooled score',
      0,
      CAMBI_FULL_REFERENCE_MAX,
    );
  }
  if (aliases.cambiSource || command.fullReferenceCambi) {
    result.cambiSource = pooledScore(
      document.pooled_metrics,
      aliases.cambiSource,
      pooling,
      'source CAMBI pooled score',
      0,
      CAMBI_FULL_REFERENCE_MAX,
    );
  }
  if (aliases.cambiFullReference || command.fullReferenceCambi) {
    result.cambiFullReference = pooledScore(
      document.pooled_metrics,
      aliases.cambiFullReference,
      pooling,
      'full-reference CAMBI pooled score',
      0,
      CAMBI_FULL_REFERENCE_MAX,
    );
  }

  return Object.freeze(result);
}

function profileForModelVersion(version) {
  const profile = MODEL_PROFILES_BY_VERSION.get(String(version || ''));
  if (!profile) throw new RangeError(`unsupported VMAF v1 model version: ${version}`);
  return profile;
}

function buildScorerCommand(options) {
  assertPlainObject(options, 'scorer command options');
  assertPositiveInteger(options.subsample, 'subsample');
  assertPositiveInteger(options.threads, 'threads');
  const modelProfile = options.modelProfile || profileForModelVersion(options.modelVersion);
  const template = buildCommand({
    referencePath: '/runtime/reference.y4m',
    distortedPath: '/runtime/distorted.y4m',
    outputPath: options.outputPath,
    width: options.width,
    height: options.height,
    sampleAspectRatio: options.sampleAspectRatio,
    displayAspectRatio: options.displayAspectRatio,
    geometryNormalization: options.geometryNormalization,
    transport: 'y4m',
    pixelFormat: PIXEL_FORMAT,
    bitDepth: BIT_DEPTH,
    frameCount: 1,
    subsample: options.subsample,
    pooling: options.pooling || 'harmonic_mean',
    contentClass: options.contentClass,
    modelProfile,
    fullReferenceCambi: true,
    allowProvisionalHdr: options.allowProvisionalHdr === true,
    threads: options.threads,
  });
  assertPath(options.referencePath, 'referencePath');
  assertPath(options.distortedPath, 'distortedPath');
  assertPath(options.outputPath, 'outputPath');
  assertPath(options.metadataOutputPath, 'metadataOutputPath');
  assertPath(options.ffmpegPath, 'ffmpegPath');
  const ffprobePath = options.ffprobePath || FFPROBE_PATH;
  assertPath(ffprobePath, 'ffprobePath');
  const eotf = options.contentClass === 'hdr-pq' ? 'pq' : 'sdr';
  const args = [
    '--reference', options.referencePath,
    '--distorted', options.distortedPath,
    '--output', options.outputPath,
    '--metadata-output', options.metadataOutputPath,
    '--model', template.model.version,
    '--cambi-eotf', eotf,
    '--ffmpeg', options.ffmpegPath,
    '--ffprobe', ffprobePath,
    '--coded-width', String(options.width),
    '--coded-height', String(options.height),
    '--sample-aspect-ratio', template.metricIdentity.sampleAspectRatio,
    '--display-aspect-ratio', template.metricIdentity.displayAspectRatio,
    '--geometry-normalization', template.metricIdentity.geometryNormalization,
    '--threads', String(options.threads),
    '--subsample', String(options.subsample),
  ];
  return Object.freeze({
    executable: SCORE_WRAPPER_PATH,
    args: Object.freeze(args),
    backend: BACKEND,
    revision: REVISION,
    model: template.model,
    modelProfile,
    metricIdentity: template.metricIdentity,
    contractStatus: template.contractStatus,
    modelValidatedForContent: template.modelValidatedForContent,
    contentClass: options.contentClass,
    allowProvisionalHdr: options.allowProvisionalHdr === true,
    outputPath: options.outputPath,
    metadataOutputPath: options.metadataOutputPath,
    subsample: options.subsample,
    threads: options.threads,
    width: options.width,
    height: options.height,
    sampleAspectRatio: template.metricIdentity.sampleAspectRatio,
    displayAspectRatio: template.metricIdentity.displayAspectRatio,
    geometryNormalization: template.metricIdentity.geometryNormalization,
    ffprobePath,
    eotf,
    fullReferenceCambi: true,
    productionEligible: false,
  });
}

function parseScorerOutput(outputInput, transportInput, scorerCommand) {
  assertPlainObject(scorerCommand, 'scorer command metadata');
  if (scorerCommand.executable !== SCORE_WRAPPER_PATH || scorerCommand.backend !== BACKEND ||
      scorerCommand.revision !== REVISION || scorerCommand.productionEligible !== false ||
      scorerCommand.fullReferenceCambi !== true) {
    throw new Error('invalid pinned FIFO scorer command metadata');
  }
  const transport = parseDocument(transportInput);
  const referenceFrames = Number(transport.referenceFrames);
  const distortedFrames = Number(transport.distortedFrames);
  if (Number(transport.schema) !== 2 || !Number.isSafeInteger(referenceFrames) ||
      referenceFrames < 1 || referenceFrames !== distortedFrames ||
      transport.pixelFormat !== PIXEL_FORMAT || Number(transport.bitDepth) !== BIT_DEPTH ||
      Number(transport.subsample) !== Number(scorerCommand.subsample) ||
      Number(transport.codedWidth) !== Number(scorerCommand.width) ||
      Number(transport.codedHeight) !== Number(scorerCommand.height) ||
      transport.referenceSampleAspectRatio !== scorerCommand.sampleAspectRatio ||
      transport.distortedSampleAspectRatio !== scorerCommand.sampleAspectRatio ||
      transport.referenceDisplayAspectRatio !== scorerCommand.displayAspectRatio ||
      transport.distortedDisplayAspectRatio !== scorerCommand.displayAspectRatio ||
      transport.geometryNormalization !== scorerCommand.geometryNormalization ||
      transport.model !== scorerCommand.model.version || transport.cambiEotf !== scorerCommand.eotf) {
    throw new Error('FIFO scorer transport metadata is missing or identity-mismatched');
  }
  const parserCommand = buildCommand({
    referencePath: '/runtime/reference.y4m',
    distortedPath: '/runtime/distorted.y4m',
    outputPath: scorerCommand.outputPath,
    width: scorerCommand.width,
    height: scorerCommand.height,
    sampleAspectRatio: scorerCommand.sampleAspectRatio,
    displayAspectRatio: scorerCommand.displayAspectRatio,
    geometryNormalization: scorerCommand.geometryNormalization,
    transport: 'y4m',
    pixelFormat: PIXEL_FORMAT,
    bitDepth: BIT_DEPTH,
    frameCount: referenceFrames,
    subsample: scorerCommand.subsample,
    pooling: scorerCommand.metricIdentity.pooling,
    contentClass: scorerCommand.contentClass,
    modelProfile: scorerCommand.modelProfile,
    fullReferenceCambi: true,
    allowProvisionalHdr: scorerCommand.allowProvisionalHdr,
    threads: scorerCommand.threads,
  });
  if (parserCommand.metricIdentity.id !== scorerCommand.metricIdentity.id) {
    throw new Error('FIFO scorer parser identity does not match execution identity');
  }
  return parseOutput(outputInput, parserCommand);
}

module.exports = Object.freeze({
  BACKEND,
  REVISION,
  WRAPPER_PATH,
  SCORE_WRAPPER_PATH,
  PIXEL_FORMAT,
  BIT_DEPTH,
  CHROMA_SUBSAMPLING,
  CAMBI_MODEL_MAX,
  CAMBI_FULL_REFERENCE_MAX,
  buildCommand,
  buildScorerCommand,
  buildMetricIdentity,
  parseOutput,
  parseScorerOutput,
  profileForModelVersion,
  resolutionClassForGeometry,
  selectModel,
  validateGeometry,
});
