'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nvenccKnn = require('./nvenccKnn.js');

const ARTIFACT_SCHEMA = 1;
const PIPELINE_MANIFEST_SCHEMA = 3;
const PIPELINE_VERSION = 4;
const DIRECT_ARTIFACT_SCHEMA = 2;
const DIRECT_PIPELINE_MANIFEST_SCHEMA = 5;
const DIRECT_PIPELINE_VERSION = 5;
const DIRECT_GRAIN_MODEL_CONTRACT_ID =
    'grav1synth-direct-global-short-clip-nvencc-knn-v1';
const DIRECT_PURPOSE = 'direct-default-grav1synth-film-grain-fit';
const DIRECT_COMPARISON_MODE = 'grav1synth-diff-original-vs-nvencc-knn';
const DIRECT_GLOBAL_SEGMENT_END = 9223372036854775807n;
const SPARSE_GLOBAL_MODEL_CONTRACT_ID = 'single-whole-title-model-sparse-evidence-v1';
const SPARSE_GLOBAL_TIMELINE_COVERAGE = 'not-established';
const SPARSE_GLOBAL_UNSEEN_INTERVAL_BASIS = 'stationarity-assumed';
const SOURCE_FINGERPRINT_SCHEME = 'sha256-sampled-v1';
const SOURCE_FINGERPRINT_CHUNK_BYTES = 1024 * 1024;
const SOURCE_FINGERPRINT_DOMAIN = Buffer.from('grain-source-sampled-v1\0', 'utf8');
const DENOISE_FILTER = 'hqdn3d=12:10:20:15';
const DENOISE_PREROLL_SECONDS = 5.0;
const NO_GRAIN_REASON_CODE = 'no_grain_exact_canonical_pairs';
const NO_GRAIN_INSUFFICIENT_ENERGY_REASON_CODE =
    'grain_synthesis_insufficient_source_removed_energy_support';
const NO_GRAIN_STATIC_MODEL_UNREPRESENTABLE_REASON_CODE =
    'grain_synthesis_static_model_unrepresentable';
const NO_GRAIN_NO_NOTICEABLE_SOURCE_NOISE_REASON_CODE =
    'grain_synthesis_no_noticeable_source_noise';
const NO_GRAIN_INSUFFICIENT_FLAT_SUPPORT_REASON_CODE =
    'grain_synthesis_insufficient_flat_support';
const NO_GRAIN_REASON_CODES = new Set([
    NO_GRAIN_REASON_CODE,
    NO_GRAIN_INSUFFICIENT_ENERGY_REASON_CODE,
    NO_GRAIN_STATIC_MODEL_UNREPRESENTABLE_REASON_CODE,
    NO_GRAIN_NO_NOTICEABLE_SOURCE_NOISE_REASON_CODE,
    NO_GRAIN_INSUFFICIENT_FLAT_SUPPORT_REASON_CODE,
]);
const NO_GRAIN_PRODUCTION_ACTION = 'continue-with-untouched-source-av1-without-film-grain';
const ANALYSIS_UNAVAILABLE_STATUS = 'analysis_unavailable';
const ANALYSIS_DIAGNOSTIC_MAX_CHARS = 4096;
const ANALYSIS_UNAVAILABLE_FORBIDDEN_VARIABLES = Object.freeze([
    'grainAnalysisArtifact',
    'grainAnalysisSourcePath',
    'grainAnalysisJobDir',
    'grainAnalysisWorkRoot',
    'grainAnalysisTablePath',
    'grainAnalysisManifestPath',
    'grainAnalysisPreparedAt',
    'grainAnalysisProfile',
    'grainAnalysisDynamicHdrProvisional',
    'grainAnalysisNoGrainArtifact',
    'grainAnalysisOutcomeReportPath',
]);
const CROP_SIZE_POLICY = 'min(requested-max,even-floor(min-dimension*8/27))';
const MINIMUM_PRODUCTION_CROP_SIZE = 64;
// Cheap proxy density; the expensive materialized region contract remains 4+4+4.
const MINIMUM_PROXY_TIMESTAMPS = 48;
const PRODUCTION_FIT_SETTINGS = Object.freeze({
    clipSeconds: 2.0,
    requestedCropMaximum: 640,
    proxyWidth: 480,
    proxyFps: 2,
    maxTemporalLumaStddev: 4.0,
    maxEdgeDensity: 8.0,
    maxSpatialLumaStddev: 24.0,
    maxExtremePixelFraction: 0.02,
    requestedScanStep: 360.0,
    requestedSkipHeadTail: 180.0,
    requestedFitSpacing: 600.0,
    minimumScanCoverage: 0.7,
    minimumValidTables: 3,
    requestedHeldoutRegions: 4,
    requestedHeldoutSpacing: 5.0,
    maxNativeLumaSpan: 8.0,
    minimumCurveLumaSpacing: 8.0,
    minimumCurveLumaSpan: 24.0,
    minimumCurveDistinctSupports: 4,
    highPassSigma: 4.0,
    energyTrimFraction: 0.10,
    minimumSourceEnergyDelta: 0.05,
});

const REGION_SET_CONTRACT = 'fit-curve-calibration-final-validation-v1';
const NATIVE_LUMA_QUALIFICATION_METHOD = 'native-cadence-frame-mean-source-luma-v1';
const POSTENCODE_RESIDUAL_QUALIFICATION_METHOD =
    'paired-high-pass-source-minus-canonical-hqdn3d-v2';
const SOURCE_RESIDUAL_REPRESENTABILITY_METHOD =
    'sorted-native-mean-luma-log-amplitude-excess-v1';
const SOURCE_RESIDUAL_REPRESENTABILITY_PAIR_COUNT = 4;
const SOURCE_RESIDUAL_LUMA_ALLOWANCE_PER_CODE = 0.04;
const SOURCE_RESIDUAL_MAXIMUM_LUMA_ALLOWANCE = Math.log(6);
const SOURCE_RESIDUAL_MAXIMUM_MEDIAN_EXCESS = 0.12;
const SOURCE_RESIDUAL_MAXIMUM_PAIR_EXCESS = 0.30;
const SOURCE_NOISE_ESTIMATOR_METHOD = 'av1-grain-estimate-plane-noise-8bit-v1';
const SOURCE_NOISE_QUALIFICATION_METHOD =
    'duration-stratified-native-resolution-source-yuv-noise-v2';
const SOURCE_NOISE_GRAY8_NORMALIZATION =
    'ffmpeg-prequantized-full-to-full-no-dither-gray8-right-shift-v1';
const SOURCE_NOISE_STRATIFICATION_METHOD =
    'duration-binned-independent-proxy-scenes-v1';
const SOURCE_NOISE_EDGE_THRESHOLD = 50;
const SOURCE_NOISE_MINIMUM_SMOOTH_PIXELS = 16;
const SOURCE_NOISE_RENDERED_FRAMES_PER_REGION = 3;
const SOURCE_NOISE_MINIMUM_VALID_FRAMES_PER_REGION = 2;
const SOURCE_NOISE_TEMPORAL_BIN_COUNT = 8;
const SOURCE_NOISE_REQUIRED_REGIONS_PER_ROLE = 4; // v1 reader only
const SOURCE_NOISE_REQUIRED_VALID_REGIONS = 8;
const SOURCE_NOISE_MAXIMUM_ATTEMPTS_PER_BIN = 4;
const SOURCE_NOISE_MINIMUM_SELECTED_SPAN_FRACTION = 0.70;
const SOURCE_NOISE_MEDIAN_THRESHOLD = 0.5;
const SOURCE_NOISE_P90_THRESHOLD = 0.5;
const SOURCE_NOISE_PLANES = Object.freeze(['y', 'u', 'v']);
const SOURCE_NOISE_CHROMA_THRESHOLD_STATUS =
    'provisional-conservative-use-of-av1-grain-0.5-band-v1';
const SOURCE_NOISE_MONOCHROME_THRESHOLD_STATUS =
    'not-applicable-monochrome-source-v1';
const SOURCE_NOISE_COMPARISON_MODE = 'native-source-plane-noise-preflight';
const SOURCE_NOISE_PURPOSE = 'film-grain-synthesis-content-eligibility';

function lower(value) {
    return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

function finiteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function safeSlug(value) {
    let slug = String(value || 'media').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) slug = 'media';
    return slug.slice(0, 80);
}

function stableId(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertRegularFile(filePath, description) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (error) {
        throw new Error(`${description} not found at ${filePath}: ${error.message}`);
    }
    if (!stat.isFile()) throw new Error(`${description} is not a regular file: ${filePath}`);
    fs.accessSync(filePath, fs.constants.R_OK);
    return stat;
}

function isWithin(root, target, allowRoot) {
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(target);
    return (allowRoot === true && resolvedTarget === resolvedRoot) ||
        resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function resolveJobOwnedRoot(args, configuredRoot, defaultChild) {
    const configuredJobRoot = String(args && args.workDir || '').trim();
    if (!configuredJobRoot || !path.isAbsolute(configuredJobRoot)) {
        throw new Error('args.workDir must be an absolute Tdarr job directory');
    }
    fs.mkdirSync(configuredJobRoot, { recursive: true });
    const jobRoot = fs.realpathSync(configuredJobRoot);
    const requested = String(configuredRoot || defaultChild || '').trim();
    const candidate = path.resolve(jobRoot, requested || defaultChild);
    if (!isWithin(jobRoot, candidate, false)) {
        throw new Error(`grain work root must be a child of args.workDir (${jobRoot}): ${candidate}`);
    }
    fs.mkdirSync(candidate, { recursive: true });
    const resolved = fs.realpathSync(candidate);
    if (!isWithin(jobRoot, resolved, false)) {
        throw new Error(`grain work root resolves outside args.workDir (${jobRoot}): ${resolved}`);
    }
    return { jobRoot, workRoot: resolved };
}

function assertJobOwnedPath(args, filePath, description) {
    const configuredJobRoot = String(args && args.workDir || '').trim();
    if (!configuredJobRoot || !path.isAbsolute(configuredJobRoot)) {
        throw new Error('args.workDir must be an absolute Tdarr job directory');
    }
    const jobRoot = fs.realpathSync(configuredJobRoot);
    const resolved = path.resolve(String(filePath || ''));
    if (!isWithin(jobRoot, resolved, false)) {
        throw new Error(`${description} is outside args.workDir (${jobRoot}): ${resolved}`);
    }
    return resolved;
}

function removeOwnedJobDir(args, jobDir) {
    if (!jobDir) return;
    const resolved = assertJobOwnedPath(args, jobDir, 'grain job directory');
    fs.rmSync(resolved, { recursive: true, force: true });
}

function registerTemporaryFile(variables, args, filePath) {
    const resolved = assertJobOwnedPath(args, filePath, 'grain temporary artifact');
    variables.vmafTemporaryFiles = Array.isArray(variables.vmafTemporaryFiles)
        ? variables.vmafTemporaryFiles : [];
    if (!variables.vmafTemporaryFiles.includes(resolved)) variables.vmafTemporaryFiles.push(resolved);
    return resolved;
}

function primaryVideo(probe) {
    const streams = probe && probe.streams;
    if (!Array.isArray(streams)) return null;
    return streams.find((stream) => stream && stream.codec_type === 'video' &&
        !(stream.disposition && Number(stream.disposition.attached_pic) === 1)) || null;
}

function isVideoTypeRelativeZero(probe, selectedStream) {
    const streams = probe && probe.streams;
    if (!Array.isArray(streams) || !selectedStream) return false;
    const firstVideo = streams.find((stream) => stream && stream.codec_type === 'video');
    return firstVideo === selectedStream;
}

function isHdr10PlusDescription(value) {
    const description = String(value || '');
    return /hdr10(?:\s*\+|plus)(?![a-z0-9])/i.test(description) ||
        /smpte(?:\s*st)?[\s._-]*2094(?:[\s._-]*40(?!\d)|[\s._-]*(?:app(?:lication)?\.?)[\s._-]*4(?!\d))/i.test(description);
}

function dynamicHdrMarkers(stream) {
    const haystack = lower(JSON.stringify({
        side_data_list: stream && stream.side_data_list,
        side_data_types: stream && stream.side_data_types,
        tags: stream && stream.tags,
        profile: stream && stream.profile,
    }));
    return {
        dolbyVision: /dolby vision|dovi|dv_profile|dv_bl_signal/.test(haystack),
        hdr10Plus: isHdr10PlusDescription(haystack),
    };
}

function hasResidualDynamicHdrMetadata(stream) {
    const sideData = lower(JSON.stringify(stream && stream.side_data_list || []));
    return /dolby vision|\bdovi\b|dv_profile|dv_bl_signal|hdr10(?:\s*\+|plus)|smpte(?:[^a-z0-9]*st)?[^a-z0-9]*2094|dynamic\s+hdr|hdr\s+dynamic|hdr\s+vivid/.test(sideData);
}

function hasStaticHdrEvidence(stream) {
    const sideData = lower(JSON.stringify(stream && stream.side_data_list || []));
    return /mastering display|content light|ambient viewing|hdr vivid/.test(sideData);
}

function isPqBt2020HighBitVideo(stream) {
    if (!stream) return false;
    const transfer = lower(stream.color_transfer);
    const primaries = lower(stream.color_primaries);
    const matrix = lower(stream.color_space);
    const pixelFormat = lower(stream.pix_fmt);
    return (transfer === 'smpte2084' || transfer === 'pq') && primaries === 'bt2020' &&
        ['bt2020nc', 'bt2020c', 'bt2020_ncl'].includes(matrix) &&
        /(?:10|12)(?:le|be)?$/.test(pixelFormat);
}

function dolbyVisionBaseLayerInfo(stream) {
    const sideData = stream && stream.side_data_list;
    if (!Array.isArray(sideData)) return null;
    for (const item of sideData) {
        if (!/dolby vision|dovi/i.test(String(item && item.side_data_type || ''))) continue;
        return {
            profile: Number.isFinite(Number(item.dv_profile)) ? Number(item.dv_profile) : null,
            compatibilityId: Number.isFinite(Number(item.dv_bl_signal_compatibility_id))
                ? Number(item.dv_bl_signal_compatibility_id) : null,
            baseLayerPresent: Number(item.bl_present_flag) === 1,
            enhancementLayerPresent: Number(item.el_present_flag) === 1,
            rpuPresent: Number(item.rpu_present_flag) === 1,
        };
    }
    return null;
}

const DYNAMIC_HDR_CONVERSION_POLICIES = Object.freeze({
    dolby_vision_to_hdr10: Object.freeze({
        sourceType: 'dolby_vision',
        reason: 'dolby_vision_hdr10_compatible_base_layer',
    }),
    hdr10plus_to_hdr10: Object.freeze({
        sourceType: 'hdr10plus',
        reason: 'hdr10plus_static_hdr10_base_layer',
    }),
});

function recognizedDynamicHdrAuthorization(variables) {
    variables = variables || {};
    const conversion = String(variables.vmafDynamicHdrConversion || '');
    const policy = DYNAMIC_HDR_CONVERSION_POLICIES[conversion];
    if (!policy ||
        !['profileAwareHdr10', 'allowStaticFallback'].includes(
            String(variables.vmafDynamicHdrPolicy || '')) ||
        variables.vmafDynamicHdrStaticFallbackAuthorized !== true ||
        variables.vmafProcessingDisposition !== 'transcode_static_hdr10_fallback' ||
        variables.vmafProcessingDispositionReason !== policy.reason ||
        variables.isHDR !== true ||
        typeof variables.isDolbyVision !== 'boolean' ||
        typeof variables.isHDR10Plus !== 'boolean') return null;
    if (policy.sourceType === 'dolby_vision') {
        // Check HDR deliberately never describes an HDR10+ fallback as independently
        // compatible when DOVI is present: Dolby Vision owns the selected conversion.
        if (variables.isDolbyVision !== true ||
            variables.vmafHdr10PlusStaticHdr10Compatible !== false) return null;
    } else if (variables.isHDR10Plus !== true ||
        variables.isDolbyVision !== false ||
        variables.vmafHdr10PlusStaticHdr10Compatible !== true) {
        return null;
    }
    return {
        sourceType: policy.sourceType,
        conversion,
        reason: policy.reason,
    };
}

function validateProvisionalDynamicHdrEvidence(evidence, description) {
    description = description || 'provisional dynamic-HDR evidence';
    if (!evidence || evidence.schema !== 1 || evidence.provisional !== true ||
        evidence.disposition !== 'transcode_static_hdr10_fallback' ||
        evidence.sourcePqBt2020HighBit !== true ||
        !Array.isArray(evidence.sourceKinds) || !Array.isArray(evidence.ffprobeKinds)) {
        throw new Error(`${description} schema is incompatible`);
    }
    const isDolbyVision = evidence.sourceType === 'dolby_vision';
    const expectedConversion = isDolbyVision ? 'dolby_vision_to_hdr10' : 'hdr10plus_to_hdr10';
    const expectedReason = isDolbyVision
        ? 'dolby_vision_hdr10_compatible_base_layer'
        : 'hdr10plus_static_hdr10_base_layer';
    if ((!isDolbyVision && evidence.sourceType !== 'hdr10plus') ||
        evidence.conversion !== expectedConversion ||
        evidence.dispositionReason !== expectedReason) {
        throw new Error(`${description} selected conversion is inconsistent`);
    }
    const sourceKinds = evidence.sourceKinds.slice();
    const ffprobeKinds = evidence.ffprobeKinds.slice();
    const sourceKindsValid = isDolbyVision
        ? (JSON.stringify(sourceKinds) === JSON.stringify(['dolby_vision']) ||
            JSON.stringify(sourceKinds) === JSON.stringify(['dolby_vision', 'hdr10_plus']))
        : JSON.stringify(sourceKinds) === JSON.stringify(['hdr10_plus']);
    const ffprobeKindsValid = isDolbyVision
        ? (JSON.stringify(ffprobeKinds) === JSON.stringify(['dolby_vision']) ||
            JSON.stringify(ffprobeKinds) === JSON.stringify(['dolby_vision', 'hdr10_plus']))
        : (ffprobeKinds.length === 0 ||
            JSON.stringify(ffprobeKinds) === JSON.stringify(['hdr10_plus']));
    if (!sourceKindsValid || !ffprobeKindsValid ||
        ffprobeKinds.some((kind) => !sourceKinds.includes(kind))) {
        throw new Error(`${description} source-kind evidence is inconsistent`);
    }
    let dolbyVision = null;
    if (isDolbyVision) {
        const value = evidence.dolbyVision;
        const keys = value && Object.keys(value).sort();
        if (!value || JSON.stringify(keys) !== JSON.stringify([
            'baseLayerPresent', 'compatibilityId', 'enhancementLayerPresent', 'profile',
            'rpuPresent',
        ]) || !Number.isFinite(value.profile) ||
            (value.compatibilityId !== 1 && value.compatibilityId !== 6) ||
            value.baseLayerPresent !== true ||
            typeof value.enhancementLayerPresent !== 'boolean' ||
            typeof value.rpuPresent !== 'boolean') {
            throw new Error(`${description} Dolby Vision base-layer evidence is inconsistent`);
        }
        dolbyVision = {
            profile: value.profile,
            compatibilityId: value.compatibilityId,
            baseLayerPresent: value.baseLayerPresent,
            enhancementLayerPresent: value.enhancementLayerPresent,
            rpuPresent: value.rpuPresent,
        };
    } else if (evidence.dolbyVision !== null) {
        throw new Error(`${description} contains unexpected Dolby Vision evidence`);
    }
    return {
        schema: 1,
        provisional: true,
        sourceType: evidence.sourceType,
        conversion: evidence.conversion,
        disposition: evidence.disposition,
        dispositionReason: evidence.dispositionReason,
        sourcePqBt2020HighBit: true,
        sourceKinds,
        ffprobeKinds,
        dolbyVision,
    };
}

function provisionalDynamicHdrEvidence(stream, variables) {
    variables = variables || {};
    const markers = dynamicHdrMarkers(stream);
    const authorization = recognizedDynamicHdrAuthorization(variables);
    if (!authorization || !isPqBt2020HighBitVideo(stream)) return null;
    if (markers.hdr10Plus && variables.isHDR10Plus !== true) return null;
    let dolbyVision = null;
    if (authorization.sourceType === 'dolby_vision') {
        if (!markers.dolbyVision) return null;
        dolbyVision = dolbyVisionBaseLayerInfo(stream);
        if (!dolbyVision || !dolbyVision.baseLayerPresent ||
            (dolbyVision.compatibilityId !== 1 && dolbyVision.compatibilityId !== 6)) return null;
    } else if (markers.dolbyVision) {
        // Check HDR always prioritizes Dolby Vision when both formats are present.
        // An HDR10+ conversion claim in the presence of DOVI is therefore inconsistent.
        return null;
    }
    const ffprobeKinds = [];
    if (markers.dolbyVision) ffprobeKinds.push('dolby_vision');
    if (markers.hdr10Plus) ffprobeKinds.push('hdr10_plus');
    const sourceKinds = authorization.sourceType === 'dolby_vision'
        ? ['dolby_vision'].concat(variables.isHDR10Plus === true ? ['hdr10_plus'] : [])
        : ['hdr10_plus'];
    return validateProvisionalDynamicHdrEvidence({
        schema: 1,
        provisional: true,
        sourceType: authorization.sourceType,
        conversion: authorization.conversion,
        disposition: variables.vmafProcessingDisposition,
        dispositionReason: authorization.reason,
        sourcePqBt2020HighBit: true,
        sourceKinds,
        ffprobeKinds,
        dolbyVision,
    });
}

function profileAllowed(profile, setting) {
    if (setting === 'sdrOnly') return profile === 'sdr';
    if (setting === 'pqOnly') return profile === 'pq';
    return profile === 'sdr' || profile === 'pq';
}

function classifySource(probe, variables, eligibleProfiles) {
    const stream = primaryVideo(probe);
    if (!stream) return { eligible: false, reason: 'no_primary_video' };
    if (!isVideoTypeRelativeZero(probe, stream)) {
        return { eligible: false, reason: 'primary_video_not_first_video_stream' };
    }
    const dynamic = dynamicHdrMarkers(stream);
    const hasDynamicAuthorizationClaim = Boolean(variables && variables.vmafDynamicHdrConversion);
    if (dynamic.dolbyVision || dynamic.hdr10Plus || hasDynamicAuthorizationClaim) {
        const evidence = provisionalDynamicHdrEvidence(stream, variables);
        if (!evidence) return { eligible: false, reason: 'dynamic_hdr_not_provisionally_authorized' };
        if (!profileAllowed('pq', eligibleProfiles)) return { eligible: false, reason: 'color_profile_not_allowlisted' };
        return { eligible: true, profile: 'pq', label: 'dynamic HDR with authorized static-HDR10 fallback', dynamicEvidence: evidence };
    }
    const transfer = lower(stream.color_transfer);
    const primaries = lower(stream.color_primaries);
    const matrix = lower(stream.color_space);
    if (transfer === 'arib-std-b67' || transfer === 'hlg') {
        return { eligible: false, reason: 'hlg_not_calibrated' };
    }
    if (transfer === 'smpte2084' || transfer === 'pq') {
        if (!isPqBt2020HighBitVideo(stream)) return { eligible: false, reason: 'ambiguous_pq_signal' };
        if (!profileAllowed('pq', eligibleProfiles)) return { eligible: false, reason: 'color_profile_not_allowlisted' };
        return { eligible: true, profile: 'pq', label: 'static HDR10 PQ/BT.2020', dynamicEvidence: null };
    }
    const sdrTransfers = new Set([
        'bt709', 'iec61966-2-1', 'gamma22', 'gamma28', 'smpte170m', 'smpte240m',
        'bt470bg', 'bt470m', 'bt2020-10', 'bt2020-12',
    ]);
    const unknown = new Set(['', 'unknown', 'unspecified', 'reserved']);
    const noHdrEvidence = !hasStaticHdrEvidence(stream) && primaries !== 'bt2020' &&
        !['bt2020nc', 'bt2020c', 'bt2020_ncl'].includes(matrix);
    if (!sdrTransfers.has(transfer) && !(unknown.has(transfer) && noHdrEvidence)) {
        return { eligible: false, reason: 'unsupported_or_ambiguous_transfer' };
    }
    if (hasStaticHdrEvidence(stream)) return { eligible: false, reason: 'contradictory_sdr_hdr_metadata' };
    if (!profileAllowed('sdr', eligibleProfiles)) return { eligible: false, reason: 'color_profile_not_allowlisted' };
    return { eligible: true, profile: 'sdr', label: unknown.has(transfer) ? 'inferred SDR' : 'SDR', dynamicEvidence: null };
}

function ensurePathAllowed(sourcePath, regexText, flagsText) {
    const pattern = String(regexText || '').trim();
    if (!pattern) return true;
    const flags = String(flagsText === undefined ? 'i' : flagsText);
    if (!/^[dgimsuvy]*$/.test(flags) || new Set(flags.split('')).size !== flags.length) {
        throw new Error(`invalid source path allowlist regex flags: ${flags}`);
    }
    let regex;
    try {
        regex = new RegExp(pattern, flags);
    } catch (error) {
        throw new Error(`invalid source path allowlist regex: ${error.message}`);
    }
    return regex.test(sourcePath);
}

function resolveAllowlistedSourcePath(sourcePath, regexText, flagsText) {
    const requested = String(sourcePath || '').trim();
    if (!requested || !path.isAbsolute(requested)) {
        throw new Error('grain source path must be absolute');
    }
    const lexical = path.resolve(requested);
    if (!ensurePathAllowed(lexical, regexText, flagsText)) return null;
    const lexicalStat = fs.lstatSync(lexical);
    if (!lexicalStat.isFile() || lexicalStat.isSymbolicLink()) {
        throw new Error(`grain source is not a non-symlink regular file: ${lexical}`);
    }
    const canonical = path.resolve(fs.realpathSync(lexical));
    const lexicalIdentity = process.platform === 'win32' ? lexical.toLowerCase() : lexical;
    const canonicalIdentity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (canonicalIdentity !== lexicalIdentity) {
        throw new Error(`grain source contains a symlinked path component: ${lexical}`);
    }
    if (!ensurePathAllowed(canonical, regexText, flagsText)) {
        throw new Error(`canonical grain source escaped the configured source scope: ${canonical}`);
    }
    return canonical;
}

function sampledSourceFingerprint(filePath) {
    const resolved = fs.realpathSync(filePath);
    const before = fs.statSync(resolved, { bigint: true });
    if (!before.isFile() || before.size <= 0n) throw new Error(`source is not a non-empty regular file: ${resolved}`);
    const chunkSize = Number(before.size < BigInt(SOURCE_FINGERPRINT_CHUNK_BYTES)
        ? before.size : BigInt(SOURCE_FINGERPRINT_CHUNK_BYTES));
    const size = Number(before.size);
    if (!Number.isSafeInteger(size)) throw new Error(`source size exceeds JavaScript safe integer range: ${resolved}`);
    const offsets = Array.from(new Set([
        0,
        Math.max(0, Math.floor((size - chunkSize) / 2)),
        Math.max(0, size - chunkSize),
    ])).sort((left, right) => left - right);
    const digest = crypto.createHash('sha256');
    digest.update(SOURCE_FINGERPRINT_DOMAIN);
    digest.update(String(size), 'ascii');
    const handle = fs.openSync(resolved, 'r');
    try {
        for (const offset of offsets) {
            const data = Buffer.allocUnsafe(chunkSize);
            const bytesRead = fs.readSync(handle, data, 0, chunkSize, offset);
            if (bytesRead !== chunkSize) throw new Error(`source changed while fingerprinting: ${resolved}`);
            const header = Buffer.alloc(16);
            header.writeBigUInt64BE(BigInt(offset), 0);
            header.writeBigUInt64BE(BigInt(bytesRead), 8);
            digest.update(header);
            digest.update(data);
        }
    } finally {
        fs.closeSync(handle);
    }
    const after = fs.statSync(resolved, { bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
        throw new Error(`source changed while fingerprinting: ${resolved}`);
    }
    return {
        scheme: SOURCE_FINGERPRINT_SCHEME,
        sha256: digest.digest('hex'),
        size_bytes: size,
        mtime_ns: Number(before.mtimeNs),
        sample_bytes: chunkSize,
        sample_offsets: offsets,
        resolved_path: resolved,
    };
}

function assertFingerprint(expected, actual, description) {
    if (!expected || expected.scheme !== SOURCE_FINGERPRINT_SCHEME) {
        throw new Error(`${description} lacks supported ${SOURCE_FINGERPRINT_SCHEME} fingerprint`);
    }
    for (const key of ['scheme', 'sha256', 'size_bytes', 'mtime_ns', 'resolved_path']) {
        const expectedValue = key === 'resolved_path' ? path.resolve(String(expected[key] || '')) : expected[key];
        const actualValue = key === 'resolved_path' ? path.resolve(String(actual[key] || '')) : actual[key];
        if (expectedValue !== actualValue) throw new Error(`${description} fingerprint mismatch: ${key}`);
    }
}

function hasSemanticGrain(text) {
    const lines = String(text || '').split(/\r?\n/);
    if (lines[0] && lines[0].trim() !== 'filmgrn1') return false;
    const hasSegment = lines.some((line) => /^E\s+\d+\s+\d+\s+/.test(line.trim()));
    const hasScale = lines.some((line) => {
        const match = line.trim().match(/^s(?:Y|Cb|Cr)\s+(\d+)\s+(.+)$/);
        if (!match) return false;
        const count = Number(match[1]);
        const values = match[2].trim().split(/\s+/).map(Number);
        if (!Number.isInteger(count) || values.length < count * 2) return false;
        for (let index = 0; index < count; index += 1) {
            if (Number.isFinite(values[index * 2 + 1]) && values[index * 2 + 1] > 0) return true;
        }
        return false;
    });
    return hasSegment && hasScale;
}

function validateDenoiserAttestation(payload) {
    if (!payload || Number(payload.schema) !== 1 || payload.validated !== true ||
        payload.denoise !== DENOISE_FILTER ||
        payload.method !== 'deterministic-noisy-control-source-vs-canonical-denoiser-psnr-mse') {
        throw new Error('canonical denoiser attestation is missing or invalid');
    }
    if (!Array.isArray(payload.controls) || payload.controls.length !== 2) {
        throw new Error('canonical denoiser attestation lacks both controls');
    }
    const formats = new Set();
    for (const control of payload.controls) {
        const format = String(control && control.pixel_format || '');
        if (!['yuv420p', 'yuv420p10le'].includes(format) || control.changed !== true ||
            !Number.isInteger(Number(control.frames)) || Number(control.frames) < 8 ||
            !Number.isFinite(Number(control.mean_square_difference)) ||
            Number(control.mean_square_difference) <= 0) {
            throw new Error('canonical denoiser failed a recorded change control');
        }
        formats.add(format);
    }
    if (formats.size !== 2 || !formats.has('yuv420p') || !formats.has('yuv420p10le')) {
        throw new Error('canonical denoiser controls do not cover 8-bit and 10-bit');
    }
    return payload;
}

function validatedRegionIdentity(region, description) {
    if (!region || typeof region !== 'object') {
        throw new Error(`${description} is malformed`);
    }
    const timestamp = Number(region.timestamp);
    const bandIndex = Number(region.band_index);
    const x = Number(region.x);
    const y = Number(region.y);
    const meanLuma = Number(region.mean_luma);
    const flatness = [
        Number(region.edge_density),
        Number(region.temporal_luma_stddev),
        Number(region.spatial_luma_stddev),
        Number(region.extreme_pixel_fraction),
    ];
    if (!Number.isFinite(timestamp) || timestamp < 0 ||
        !Number.isInteger(bandIndex) || bandIndex < 0 || bandIndex > 3 ||
        !Number.isInteger(x) || x < 0 || !Number.isInteger(y) || y < 0 ||
        !Number.isFinite(meanLuma) || meanLuma < 0 || meanLuma > 255 ||
        flatness.some((value) => !Number.isFinite(value) || value < 0) ||
        flatness[3] > 1) {
        throw new Error(`${description} contains invalid candidate evidence`);
    }
    return [timestamp, bandIndex, x, y].join('|');
}

const REGION_EVIDENCE_FIELDS = Object.freeze([
    'timestamp',
    'band_index',
    'x',
    'y',
    'mean_luma',
    'edge_density',
    'temporal_luma_stddev',
    'spatial_luma_stddev',
    'extreme_pixel_fraction',
]);

function regionEvidenceMatches(left, right) {
    if (!left || typeof left !== 'object' || !right || typeof right !== 'object') return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    const expectedKeys = [...REGION_EVIDENCE_FIELDS].sort();
    if (JSON.stringify(leftKeys) !== JSON.stringify(expectedKeys) ||
        JSON.stringify(rightKeys) !== JSON.stringify(expectedKeys)) return false;
    return REGION_EVIDENCE_FIELDS.every((field) => Number(left[field]) === Number(right[field]));
}

function strictJsonNumber(value, description) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${description} must be a finite JSON number`);
    }
    return value;
}

function strictJsonInteger(value, description) {
    const parsed = strictJsonNumber(value, description);
    if (!Number.isInteger(parsed)) throw new Error(`${description} must be a JSON integer`);
    return parsed;
}

function strictRegionEvidenceMatches(left, right) {
    if (!left || typeof left !== 'object' || Array.isArray(left) ||
        !right || typeof right !== 'object' || Array.isArray(right)) return false;
    const expectedKeys = [...REGION_EVIDENCE_FIELDS].sort();
    if (JSON.stringify(Object.keys(left).sort()) !== JSON.stringify(expectedKeys) ||
        JSON.stringify(Object.keys(right).sort()) !== JSON.stringify(expectedKeys)) return false;
    return REGION_EVIDENCE_FIELDS.every((field) => left[field] === right[field]);
}

function validateLowEnergyCandidate(region, settings, description) {
    if (!region || typeof region !== 'object' || Array.isArray(region) ||
        JSON.stringify(Object.keys(region).sort()) !==
            JSON.stringify([...REGION_EVIDENCE_FIELDS].sort())) {
        throw new Error(`${description} is malformed`);
    }
    const timestamp = strictJsonNumber(region.timestamp, `${description} timestamp`);
    const bandIndex = strictJsonInteger(region.band_index, `${description} band index`);
    const x = strictJsonInteger(region.x, `${description} x`);
    const y = strictJsonInteger(region.y, `${description} y`);
    const meanLuma = strictJsonNumber(region.mean_luma, `${description} mean luma`);
    const edge = strictJsonNumber(region.edge_density, `${description} edge density`);
    const temporal = strictJsonNumber(
        region.temporal_luma_stddev, `${description} temporal luma deviation`);
    const spatial = strictJsonNumber(
        region.spatial_luma_stddev, `${description} spatial luma deviation`);
    const extreme = strictJsonNumber(
        region.extreme_pixel_fraction, `${description} extreme-pixel fraction`);
    if (timestamp < 0 || bandIndex < 0 || bandIndex > 3 || x < 0 || y < 0 ||
        meanLuma < 0 || meanLuma > 255 || edge < 0 || edge > settings.maxEdgeDensity ||
        temporal < 0 || temporal > settings.maxTemporalLumaStddev ||
        spatial < 0 || spatial > settings.maxSpatialLumaStddev ||
        extreme < 0 || extreme > settings.maxExtremePixelFraction) {
        throw new Error(`${description} violates the production candidate limits`);
    }
    return [timestamp, bandIndex, x, y].join('|');
}

function validateLowEnergyNativeMeasurement(measurement, description) {
    if (!measurement || typeof measurement !== 'object' || Array.isArray(measurement)) {
        throw new Error(`${description} is malformed`);
    }
    const frames = strictJsonInteger(measurement.frame_count, `${description} frame count`);
    const span = strictJsonNumber(
        measurement.frame_mean_span_codes, `${description} frame-mean span`);
    const mean = strictJsonNumber(measurement.mean_code, `${description} mean luma`);
    const median = strictJsonNumber(measurement.median_code, `${description} median luma`);
    if (frames < 8 || span < 0 || mean < 0 || mean > 255 || median < 0 || median > 255) {
        throw new Error(`${description} contains invalid native-luma evidence`);
    }
    return { frames, span, mean, median };
}

function canonicalValue(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonicalValue);
    const result = {};
    Object.keys(value).sort().forEach((key) => { result[key] = canonicalValue(value[key]); });
    return result;
}

function candidateIdentityValues(candidate) {
    return [
        Number(candidate.timestamp),
        Number(candidate.band_index),
        Number(candidate.x),
        Number(candidate.y),
    ];
}

function compareIdentityValues(left, right) {
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return left[index] - right[index];
    }
    return 0;
}

function summarizeNativeLumaSupport(regions, measurementByIdentity, minimumSpacing, minimumSpan) {
    const ordered = regions.map((candidate) => {
        const identity = validatedRegionIdentity(candidate, 'native luma support candidate');
        const measurement = measurementByIdentity.get(identity);
        const median = Number(measurement && measurement.median_code);
        if (!Number.isFinite(median) || median < 0 || median > 255) {
            throw new Error('grain analysis native luma-support coordinate is invalid');
        }
        return { median, identity: candidateIdentityValues(candidate) };
    }).sort((left, right) => left.median - right.median ||
        compareIdentityValues(left.identity, right.identity));
    const clusters = [];
    for (const support of ordered) {
        const previous = clusters.length ? clusters[clusters.length - 1] : null;
        if (!previous || support.median - previous[previous.length - 1].median >= minimumSpacing) {
            clusters.push([support]);
        } else {
            previous.push(support);
        }
    }
    const clusterEvidence = clusters.map((cluster) => ({
        mean_luma_code: cluster.reduce((sum, item) => sum + item.median, 0) / cluster.length,
        minimum_luma_code: cluster[0].median,
        maximum_luma_code: cluster[cluster.length - 1].median,
        candidate_identities: cluster.map((item) => item.identity),
    }));
    const codes = clusterEvidence.map((item) => item.mean_luma_code);
    const measuredSpan = codes.length >= 2 ? codes[codes.length - 1] - codes[0] : 0;
    const failures = [];
    if (clusters.length < regions.length) failures.push('too-few-distinct-native-luma-supports');
    if (measuredSpan < minimumSpan) failures.push('native-luma-support-span-too-narrow');
    return {
        valid: failures.length === 0,
        coordinate: 'native-source-frame-mean-median-av1-8-bit-code',
        candidate_count: ordered.length,
        minimum_distinct_supports: regions.length,
        distinct_support_count: clusters.length,
        minimum_spacing_codes: minimumSpacing,
        minimum_span_codes: minimumSpan,
        measured_luma_min: codes.length ? codes[0] : null,
        measured_luma_max: codes.length ? codes[codes.length - 1] : null,
        measured_luma_span: measuredSpan,
        ordered_luma_codes: ordered.map((item) => item.median),
        clusters: clusterEvidence,
        failures,
    };
}

function validateResidualSummary(value, expectedTrim, description) {
    const frameCount = value && value.frame_count;
    const retainedCount = value && value.retained_frame_count;
    const trimFraction = value && value.trim_fraction;
    const meanSquare = value && value.mean_square;
    const rmsMagnitude = value && value.rms_magnitude;
    const medianMeanSquare = value && value.median_mean_square;
    const observedCount = value && value.observed_frame_count;
    const numericCount = value && value.numeric_frame_count;
    const unavailableCount = value && value.unavailable_frame_count;
    const numericCoverage = value && value.numeric_coverage;
    const unavailableIds = value && value.unavailable_frame_ids;
    if (!Number.isInteger(frameCount) || frameCount < 8 ||
        !Number.isInteger(retainedCount) || retainedCount < 2 || retainedCount > frameCount ||
        !Number.isInteger(observedCount) || observedCount !== frameCount ||
        !Number.isInteger(numericCount) || numericCount !== frameCount ||
        !Number.isInteger(unavailableCount) || unavailableCount !== 0 ||
        numericCoverage !== 1 || !Array.isArray(unavailableIds) || unavailableIds.length !== 0 ||
        !Number.isFinite(trimFraction) || trimFraction !== expectedTrim ||
        !Number.isFinite(meanSquare) || meanSquare < 0 ||
        !Number.isFinite(rmsMagnitude) ||
        Math.abs(rmsMagnitude - Math.sqrt(meanSquare)) > 1e-9 ||
        !Number.isFinite(medianMeanSquare) || medianMeanSquare < 0) {
        throw new Error(`${description} residual summary is invalid`);
    }
    return meanSquare;
}

function strictRepresentabilityNumber(value, description) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${description} must be a finite JSON number`);
    }
    return value;
}

function strictRepresentabilityInteger(value, description) {
    const parsed = strictRepresentabilityNumber(value, description);
    if (!Number.isInteger(parsed)) {
        throw new Error(`${description} must be a JSON integer`);
    }
    return parsed;
}

function strictRepresentabilityCandidateIdentity(candidate, description) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error(`${description} is malformed`);
    }
    const timestamp = strictRepresentabilityNumber(
        candidate.timestamp, `${description} timestamp`
    );
    const bandIndex = strictRepresentabilityInteger(
        candidate.band_index, `${description} band index`
    );
    const x = strictRepresentabilityInteger(candidate.x, `${description} x`);
    const y = strictRepresentabilityInteger(candidate.y, `${description} y`);
    const meanLuma = strictRepresentabilityNumber(
        candidate.mean_luma, `${description} mean luma`
    );
    const edgeDensity = strictRepresentabilityNumber(
        candidate.edge_density, `${description} edge density`
    );
    const temporalStddev = strictRepresentabilityNumber(
        candidate.temporal_luma_stddev, `${description} temporal luma standard deviation`
    );
    const spatialStddev = strictRepresentabilityNumber(
        candidate.spatial_luma_stddev, `${description} spatial luma standard deviation`
    );
    const extremeFraction = strictRepresentabilityNumber(
        candidate.extreme_pixel_fraction, `${description} extreme pixel fraction`
    );
    if (timestamp < 0 || bandIndex < 0 || bandIndex > 3 || x < 0 || y < 0 ||
        meanLuma < 0 || meanLuma > 255 || edgeDensity < 0 || temporalStddev < 0 ||
        spatialStddev < 0 || extremeFraction < 0 || extremeFraction > 1) {
        throw new Error(`${description} contains invalid candidate evidence`);
    }
    const values = [timestamp, bandIndex, x, y];
    return { key: values.join('|'), values };
}

function deriveSourceResidualRepresentability(nativeQualified, residualQualified) {
    if (!Array.isArray(nativeQualified) || !Array.isArray(residualQualified)) {
        throw new Error('source-residual representability evidence is incomplete');
    }
    const roles = ['curve-calibration', 'final-validation'];
    const nativeByRole = new Map(roles.map((role) => [role, new Map()]));
    const residualByRole = new Map(roles.map((role) => [role, new Map()]));
    nativeQualified.forEach((record, index) => {
        const role = String(record && record.role || '');
        if (!roles.includes(role)) return;
        const candidate = record && record.candidate;
        const identity = strictRepresentabilityCandidateIdentity(candidate,
            `source-residual native-luma record ${index}`);
        const meanLuma = strictRepresentabilityNumber(
            record && record.native_luma && record.native_luma.mean_code,
            `source-residual native mean luma ${index}`
        );
        const roleMap = nativeByRole.get(role);
        if (meanLuma < 0 || meanLuma > 255 || roleMap.has(identity.key)) {
            throw new Error('source-residual native-luma evidence is invalid');
        }
        roleMap.set(identity.key, {
            luma: meanLuma,
            identity: identity.values,
        });
    });
    residualQualified.forEach((record, index) => {
        const role = String(record && record.role || '');
        if (!roles.includes(role)) {
            throw new Error('source-residual energy record has an invalid role');
        }
        const candidate = record && record.candidate;
        const identity = strictRepresentabilityCandidateIdentity(candidate,
            `source-residual energy record ${index}`);
        const energy = strictRepresentabilityNumber(
            record && record.source_removed && record.source_removed.mean_square,
            `source-residual mean-square energy ${index}`
        );
        const roleMap = residualByRole.get(role);
        if (energy <= 0 || roleMap.has(identity.key)) {
            throw new Error('source-residual energy evidence is invalid');
        }
        roleMap.set(identity.key, energy);
    });
    for (const role of roles) {
        const nativeRole = nativeByRole.get(role);
        const residualRole = residualByRole.get(role);
        if (nativeRole.size !== SOURCE_RESIDUAL_REPRESENTABILITY_PAIR_COUNT ||
            residualRole.size !== SOURCE_RESIDUAL_REPRESENTABILITY_PAIR_COUNT ||
            [...nativeRole.keys()].some((identity) => !residualRole.has(identity))) {
            throw new Error(
                'source-residual representability requires the frozen four-by-four regions'
            );
        }
    }
    if ([...nativeByRole.get(roles[0]).keys()].some((identity) =>
        nativeByRole.get(roles[1]).has(identity))) {
        throw new Error('source-residual representability roles overlap');
    }
    const ordered = new Map();
    roles.forEach((role) => {
        const residualRole = residualByRole.get(role);
        ordered.set(role, [...nativeByRole.get(role).entries()].map(([key, value]) => ({
            luma: value.luma,
            identity: value.identity,
            energy: residualRole.get(key),
        })).sort((left, right) => left.luma - right.luma ||
            compareIdentityValues(left.identity, right.identity)));
    });
    const pairs = [];
    const excesses = [];
    for (let rank = 0; rank < SOURCE_RESIDUAL_REPRESENTABILITY_PAIR_COUNT; rank += 1) {
        const calibration = ordered.get(roles[0])[rank];
        const validation = ordered.get(roles[1])[rank];
        const lumaDelta = Math.abs(validation.luma - calibration.luma);
        const energyRatio = validation.energy / calibration.energy;
        if (!Number.isFinite(energyRatio) || energyRatio <= 0) {
            throw new Error('source-residual energy ratio is not finite and positive');
        }
        const amplitudeGap = Math.abs(0.5 * Math.log(energyRatio));
        const allowance = Math.min(
            SOURCE_RESIDUAL_LUMA_ALLOWANCE_PER_CODE * lumaDelta,
            SOURCE_RESIDUAL_MAXIMUM_LUMA_ALLOWANCE
        );
        const excess = Math.max(0, amplitudeGap - allowance);
        if (![lumaDelta, amplitudeGap, allowance, excess].every(Number.isFinite)) {
            throw new Error('source-residual representability derived evidence is non-finite');
        }
        excesses.push(excess);
        pairs.push({
            rank,
            calibration_candidate_identity: calibration.identity,
            final_validation_candidate_identity: validation.identity,
            calibration_native_mean_luma: calibration.luma,
            final_validation_native_mean_luma: validation.luma,
            absolute_luma_delta_codes: lumaDelta,
            calibration_mean_square_energy: calibration.energy,
            final_validation_mean_square_energy: validation.energy,
            absolute_log_amplitude_gap: amplitudeGap,
            luma_log_amplitude_allowance: allowance,
            excess_log_amplitude_gap: excess,
        });
    }
    const sortedExcesses = [...excesses].sort((left, right) => left - right);
    const medianExcess = (sortedExcesses[1] + sortedExcesses[2]) / 2;
    const maximumExcess = sortedExcesses[sortedExcesses.length - 1];
    const failures = [];
    if (medianExcess > SOURCE_RESIDUAL_MAXIMUM_MEDIAN_EXCESS + 1e-12) {
        failures.push('median-excess-above-maximum');
    }
    if (maximumExcess > SOURCE_RESIDUAL_MAXIMUM_PAIR_EXCESS + 1e-12) {
        failures.push('pair-excess-above-maximum');
    }
    const qualityWarning = failures.length === 0 ? null : {
        code: 'source-residual-representability-mismatch',
        advisory: true,
        failures: [...failures],
    };
    return {
        method: SOURCE_RESIDUAL_REPRESENTABILITY_METHOD,
        enforcement: 'advisory-quality-model-diagnostic-v1',
        disposition: failures.length === 0
            ? 'quality-model-supported'
            : 'continue-with-quality-warning',
        quality_warning: qualityWarning,
        selection_state:
            'frozen-four-calibration-four-final-validation-no-retry-or-reselection',
        pairing: 'sort-each-role-by-native-source-mean-luma-ascending-then-pair-by-rank',
        luma_coordinate: 'native-source-frame-mean-average-av1-8-bit-code',
        energy_metric: 'paired-high-pass-residual-energy-v2-mean-square',
        pair_count: SOURCE_RESIDUAL_REPRESENTABILITY_PAIR_COUNT,
        luma_log_amplitude_allowance_per_code: SOURCE_RESIDUAL_LUMA_ALLOWANCE_PER_CODE,
        maximum_luma_log_amplitude_allowance: SOURCE_RESIDUAL_MAXIMUM_LUMA_ALLOWANCE,
        maximum_median_excess: SOURCE_RESIDUAL_MAXIMUM_MEDIAN_EXCESS,
        maximum_pair_excess: SOURCE_RESIDUAL_MAXIMUM_PAIR_EXCESS,
        pairs,
        median_excess: medianExcess,
        maximum_excess: maximumExcess,
        valid: failures.length === 0,
        failures,
    };
}

function derivedEvidenceMatches(recorded, expected) {
    if (expected === null || typeof expected === 'string' || typeof expected === 'boolean') {
        return typeof recorded === typeof expected && recorded === expected;
    }
    if (typeof expected === 'number') {
        return typeof recorded === 'number' && Number.isFinite(recorded) &&
            Math.abs(recorded - expected) <= 1e-12 * Math.max(1, Math.abs(expected));
    }
    if (Array.isArray(expected)) {
        return Array.isArray(recorded) && recorded.length === expected.length &&
            expected.every((value, index) => derivedEvidenceMatches(recorded[index], value));
    }
    if (expected && typeof expected === 'object') {
        if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) return false;
        const expectedKeys = Object.keys(expected).sort();
        const recordedKeys = Object.keys(recorded).sort();
        return JSON.stringify(recordedKeys) === JSON.stringify(expectedKeys) &&
            expectedKeys.every((key) => derivedEvidenceMatches(recorded[key], expected[key]));
    }
    return recorded === expected;
}

function validateSourceResidualRepresentability(recorded, nativeQualified, residualQualified) {
    const expected = deriveSourceResidualRepresentability(nativeQualified, residualQualified);
    if (!derivedEvidenceMatches(recorded, expected)) {
        throw new Error('source-residual representability evidence does not reproduce');
    }
    return expected;
}

function validateThreeRegionSets(manifest) {
    const settings = manifest.settings || {};
    const selected = manifest.selected;
    const calibration = manifest.calibration || {};
    const heldout = manifest.heldout || {};
    const heldoutMinimum = Number(heldout.minimum_regions);
    const heldoutRequested = Number(heldout.requested_minimum_regions);
    const heldoutAdapted = heldout.minimum_adapted;
    const separation = Number(heldout.minimum_spacing_seconds);
    const calibrationSeparation = Number(calibration.minimum_spacing_seconds);

    if (!Array.isArray(selected) || selected.length !== 4) {
        throw new Error('grain analysis fit regions do not cover all four luminance bands');
    }
    if (heldout.purpose !== 'independent final post-encode energy validation' ||
        heldout.distinct_from_fit !== true || !Number.isInteger(heldoutMinimum) ||
        heldoutMinimum < 3 || heldoutMinimum !== heldoutRequested ||
        heldoutRequested !== PRODUCTION_FIT_SETTINGS.requestedHeldoutRegions ||
        heldoutAdapted !== false || Number(settings.min_heldout_regions) !== heldoutMinimum ||
        Number(settings.requested_min_heldout_regions) !== heldoutRequested ||
        settings.heldout_minimum_adapted !== false || !Array.isArray(heldout.regions) ||
        heldout.regions.length !== heldoutMinimum) {
        throw new Error('grain analysis manifest lacks independent final-validation regions');
    }
    if (calibration.purpose !== 'post-encode luma-curve energy calibration' ||
        calibration.distinct_from_fit !== true ||
        calibration.distinct_from_final_validation !== true ||
        !Number.isInteger(Number(calibration.minimum_regions)) ||
        Number(calibration.minimum_regions) !== heldoutMinimum ||
        !Array.isArray(calibration.regions) ||
        calibration.regions.length !== Number(calibration.minimum_regions)) {
        throw new Error('grain analysis manifest lacks distinct curve-calibration regions');
    }
    if (!Number.isFinite(separation) || separation <
        PRODUCTION_FIT_SETTINGS.clipSeconds + DENOISE_PREROLL_SECONDS ||
        calibrationSeparation !== separation) {
        throw new Error('grain analysis calibration/final-validation spacing policy is invalid');
    }

    const roleSets = [
        ['fit', selected],
        ['curve-calibration', calibration.regions],
        ['final-validation', heldout.regions],
    ];
    const all = [];
    const roleByIdentity = new Map();
    const regionByIdentity = new Map();
    for (const [role, regions] of roleSets) {
        const bands = new Set();
        for (const [index, region] of regions.entries()) {
            const identity = validatedRegionIdentity(region, `${role} region ${index}`);
            if (roleByIdentity.has(identity)) {
                throw new Error('grain analysis fit, calibration, and final-validation sets overlap');
            }
            roleByIdentity.set(identity, role);
            regionByIdentity.set(identity, region);
            bands.add(Number(region.band_index));
            all.push({ role, region, identity });
        }
        const requiredBands = role === 'fit' ? 4 : (role === 'curve-calibration' ? 3 : 2);
        if (bands.size < Math.min(requiredBands, regions.length)) {
            throw new Error(`grain analysis ${role} regions do not span enough valid luminance bands`);
        }
    }
    if (![0, 1, 2, 3].every((band) =>
        selected.some((region) => Number(region.band_index) === band))) {
        throw new Error('grain analysis fit regions do not cover all four luminance bands');
    }
    const fitSpacing = Number(settings.sampling && settings.sampling.effective &&
        settings.sampling.effective.min_spacing);
    if (!Number.isFinite(fitSpacing) || fitSpacing <= 0 || selected.some((region, index) =>
        selected.slice(index + 1).some((other) =>
            Math.abs(Number(region.timestamp) - Number(other.timestamp)) < fitSpacing))) {
        throw new Error('grain analysis fit regions violate their recorded sparse spacing');
    }
    for (let left = 0; left < all.length; left += 1) {
        for (let right = left + 1; right < all.length; right += 1) {
            if (Math.abs(Number(all[left].region.timestamp) -
                Number(all[right].region.timestamp)) < separation) {
                throw new Error('grain analysis fit, calibration, and final-validation windows overlap');
            }
        }
    }

    const native = manifest.native_luma_qualification || {};
    const maximumSpan = Number(native.maximum_span_codes);
    const minimumCurveSpacing = Number(native.minimum_curve_spacing_codes);
    const minimumCurveSpan = Number(native.minimum_curve_span_codes);
    const minimumCurveDistinctSupports = Number(native.minimum_curve_distinct_supports);
    if (native.method !== NATIVE_LUMA_QUALIFICATION_METHOD ||
        maximumSpan !== PRODUCTION_FIT_SETTINGS.maxNativeLumaSpan ||
        maximumSpan !== Number(settings.max_native_luma_span) ||
        minimumCurveSpacing !== PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpacing ||
        minimumCurveSpan !== PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpan ||
        minimumCurveDistinctSupports !== PRODUCTION_FIT_SETTINGS.minimumCurveDistinctSupports ||
        minimumCurveDistinctSupports !== heldoutMinimum ||
        !Array.isArray(native.qualified) || !Array.isArray(native.rejected)) {
        throw new Error('grain analysis manifest lacks native-cadence luma qualification');
    }
    const qualified = new Map();
    const nativeMeasurements = new Map();
    for (const [index, record] of native.qualified.entries()) {
        const role = String(record && record.role || '');
        const identity = validatedRegionIdentity(record && record.candidate,
            `native qualification ${index}`);
        const measurement = record && record.native_luma;
        const frameCount = Number(measurement && measurement.frame_count);
        const span = Number(measurement && measurement.frame_mean_span_codes);
        const meanCode = Number(measurement && measurement.mean_code);
        const medianCode = Number(measurement && measurement.median_code);
        if (!['fit', 'curve-calibration', 'final-validation'].includes(role) ||
            roleByIdentity.get(identity) !== role || qualified.has(identity) ||
            !regionEvidenceMatches(record && record.candidate, regionByIdentity.get(identity)) ||
            !Number.isInteger(frameCount) || frameCount < 2 ||
            !Number.isFinite(span) || span < 0 || span > maximumSpan ||
            !Number.isFinite(meanCode) || meanCode < 0 || meanCode > 255 ||
            !Number.isFinite(medianCode) || medianCode < 0 || medianCode > 255) {
            throw new Error('grain analysis native-cadence qualification evidence is invalid');
        }
        qualified.set(identity, role);
        nativeMeasurements.set(identity, measurement);
    }
    if (qualified.size !== roleByIdentity.size ||
        [...roleByIdentity].some(([identity, role]) => qualified.get(identity) !== role)) {
        throw new Error('grain analysis native-cadence qualification does not bind every selected region');
    }
    const expectedCalibrationSupport = summarizeNativeLumaSupport(
        calibration.regions, nativeMeasurements, minimumCurveSpacing, minimumCurveSpan
    );
    const expectedValidationSupport = summarizeNativeLumaSupport(
        heldout.regions, nativeMeasurements, minimumCurveSpacing, minimumCurveSpan
    );
    if (expectedCalibrationSupport.valid !== true || expectedValidationSupport.valid !== true ||
        JSON.stringify(canonicalValue(native.calibration_support)) !==
            JSON.stringify(canonicalValue(expectedCalibrationSupport)) ||
        JSON.stringify(canonicalValue(native.final_validation_support)) !==
            JSON.stringify(canonicalValue(expectedValidationSupport))) {
        throw new Error('grain analysis manifest lacks valid native luma calibration/validation support');
    }
    const residual = manifest.postencode_residual_qualification || {};
    const residualSigma = Number(residual.sigma);
    const residualTrim = Number(residual.trim_fraction);
    const residualMinimum = Number(residual.minimum_mean_square_exclusive);
    if (residual.method !== POSTENCODE_RESIDUAL_QUALIFICATION_METHOD ||
        residual.metric !== 'paired-high-pass-residual-energy-v2' ||
        residual.normalized_units !== '8-bit-luma-code-squared' ||
        residual.denoise !== DENOISE_FILTER || residual.valid !== true ||
        residualSigma !== PRODUCTION_FIT_SETTINGS.highPassSigma ||
        residualTrim !== PRODUCTION_FIT_SETTINGS.energyTrimFraction ||
        residualMinimum !== PRODUCTION_FIT_SETTINGS.minimumSourceEnergyDelta ||
        residualSigma !== Number(settings.high_pass_sigma) ||
        residualTrim !== Number(settings.energy_trim_fraction) ||
        residualMinimum !== Number(settings.energy_min_delta) ||
        !Array.isArray(residual.qualified) || !Array.isArray(residual.rejected)) {
        throw new Error('grain analysis manifest lacks postencode residual qualification');
    }
    const expectedResidualRoles = new Map();
    calibration.regions.forEach((region) => expectedResidualRoles.set(
        validatedRegionIdentity(region, 'residual calibration region'), 'curve-calibration'));
    heldout.regions.forEach((region) => expectedResidualRoles.set(
        validatedRegionIdentity(region, 'residual final-validation region'), 'final-validation'));
    const observedResidualRoles = new Map();
    for (const [index, record] of residual.qualified.entries()) {
        const identity = validatedRegionIdentity(record && record.candidate,
            `residual qualification ${index}`);
        const role = String(record && record.role || '');
        const meanSquare = validateResidualSummary(record && record.source_removed,
            residualTrim, `residual qualification ${index}`);
        if (expectedResidualRoles.get(identity) !== role || observedResidualRoles.has(identity) ||
            !regionEvidenceMatches(record && record.candidate, regionByIdentity.get(identity)) ||
            !(meanSquare > residualMinimum)) {
            throw new Error('grain analysis residual qualification does not bind an eligible region');
        }
        observedResidualRoles.set(identity, role);
    }
    if (observedResidualRoles.size !== expectedResidualRoles.size ||
        [...expectedResidualRoles].some(([identity, role]) => observedResidualRoles.get(identity) !== role)) {
        throw new Error('grain analysis residual qualification does not bind all postencode regions');
    }
    const rejectedResidualIds = new Set();
    for (const [index, record] of residual.rejected.entries()) {
        const identity = validatedRegionIdentity(record && record.candidate,
            `rejected residual qualification ${index}`);
        const meanSquare = validateResidualSummary(record && record.source_removed,
            residualTrim, `rejected residual qualification ${index}`);
        if (rejectedResidualIds.has(identity) || expectedResidualRoles.has(identity) ||
            !['curve-calibration', 'final-validation'].includes(String(record && record.role_when_rejected || '')) ||
            record.reason !== 'source-removed-energy-at-or-below-minimum' ||
            record.excluded_from_both_postencode_roles !== true ||
            Number(record.minimum_mean_square_exclusive) !== residualMinimum ||
            meanSquare > residualMinimum) {
            throw new Error('grain analysis rejected residual qualification is inconsistent');
        }
        rejectedResidualIds.add(identity);
    }
    const representability = validateSourceResidualRepresentability(
        manifest.source_residual_representability,
        native.qualified,
        residual.qualified
    );
    return {
        contract: REGION_SET_CONTRACT,
        selected,
        calibration: calibration.regions,
        heldout: heldout.regions,
        postencodeResidualQualificationMethod: POSTENCODE_RESIDUAL_QUALIFICATION_METHOD,
        sourceResidualRepresentability: representability,
    };
}

function directTableSegments(text) {
    const segments = [];
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith('E ')) continue;
        const match = line.match(/^E\s+(\d+)\s+(\d+)(?:\s|$)/);
        if (!match) throw new Error('direct grav1synth table contains a malformed segment header');
        segments.push({ start: BigInt(match[1]), end: BigInt(match[2]) });
    }
    return segments;
}

function assertDirectGlobalTable(tablePath) {
    const text = fs.readFileSync(tablePath, 'utf8');
    if (!hasSemanticGrain(text)) {
        throw new Error('direct grav1synth table contains no semantic grain');
    }
    const segments = directTableSegments(text);
    if (segments.length !== 1 || segments[0].start !== 0n ||
        segments[0].end !== DIRECT_GLOBAL_SEGMENT_END) {
        throw new Error('direct grav1synth table must contain exactly one unmodified global segment');
    }
    return segments;
}

function validateDirectSelection(selection, requireSelected) {
    if (!selection || selection.method !== 'flat-mid-luma-no-cut-proxy-ranking-v1' ||
        !Number.isInteger(Number(selection.requested_frames)) ||
        Number(selection.requested_frames) < 100 || Number(selection.requested_frames) > 200 ||
        !Number.isInteger(Number(selection.requested_candidate_limit)) ||
        Number(selection.requested_candidate_limit) < 1 ||
        Number(selection.requested_candidate_limit) > 3 ||
        !Array.isArray(selection.attempts) ||
        selection.attempts.length > Number(selection.requested_candidate_limit)) {
        throw new Error('direct grain analysis selection contract mismatch');
    }
    const selected = selection.attempts.filter((attempt) => attempt && attempt.status === 'selected');
    if ((requireSelected && selected.length !== 1) || (!requireSelected && selected.length !== 0)) {
        throw new Error('direct grain analysis selected-clip disposition mismatch');
    }
    if (requireSelected) {
        const evidence = selected[0];
        const segments = Array.isArray(evidence.segments) ? evidence.segments : [];
        if (evidence.semantic_grain !== true || segments.length !== 1 ||
            Number(segments[0] && segments[0].start) !== 0 ||
            Number(segments[0] && segments[0].end) !== Number(DIRECT_GLOBAL_SEGMENT_END) ||
            !/^[0-9a-f]{64}$/.test(lower(evidence.source_clip_sha256)) ||
            !/^[0-9a-f]{64}$/.test(lower(evidence.denoised_clip_sha256))) {
            throw new Error('direct grain analysis selected clip lacks global-table evidence');
        }
    }
    return selected[0] || null;
}

function assertDirectToolchain(toolchain, options) {
    const expected = {
        ffmpeg: options.ffmpegPath,
        ffprobe: options.ffprobePath,
        grav1synth: options.grav1synthPath,
        nvencc: options.nvenccPath || nvenccKnn.DEFAULT_NVENCC_PATH,
        coordinator: options.coordinatorPath || nvenccKnn.DEFAULT_COORDINATOR_PATH,
    };
    for (const [name, configuredPath] of Object.entries(expected)) {
        const record = toolchain && toolchain[name];
        const target = configuredPath || (record && record.resolved_path);
        if (!target) throw new Error(`direct grain analysis lacks ${name} tool identity`);
        assertFullArtifactFingerprint(record, target, `direct grain analysis ${name}`);
    }
}

function validateDirectPreparedManifest(manifest, options) {
    const sourcePath = fs.realpathSync(options.sourcePath);
    const tablePath = fs.realpathSync(options.tablePath);
    const pipelinePath = fs.realpathSync(options.pipelinePath);
    if (!manifest || Number(manifest.schema) !== DIRECT_PIPELINE_MANIFEST_SCHEMA ||
        Number(manifest.pipeline_version) !== DIRECT_PIPELINE_VERSION ||
        manifest.operation !== 'fit-direct' || manifest.purpose !== DIRECT_PURPOSE ||
        manifest.grain_model_contract_id !== DIRECT_GRAIN_MODEL_CONTRACT_ID) {
        throw new Error(`direct grain manifest schema ${DIRECT_PIPELINE_MANIFEST_SCHEMA} is required`);
    }
    if (path.resolve(String(manifest.source || '')) !== path.resolve(sourcePath)) {
        throw new Error('direct grain manifest source path does not match the library original');
    }
    const currentFingerprint = sampledSourceFingerprint(sourcePath);
    assertFingerprint(manifest.source_fingerprint, currentFingerprint, 'direct grain source');

    const comparison = manifest.comparison || {};
    if (comparison.mode !== DIRECT_COMPARISON_MODE ||
        comparison.source_role !== 'lossless-original-source-clip' ||
        comparison.denoised_role !== 'same-lossless-clip-after-spatial-gpu-knn' ||
        comparison.encoded_output_used_for_fit !== false ||
        comparison.direct_unmodified_table !== true ||
        comparison.global_segment_required !== true) {
        throw new Error('direct grain manifest comparison contract mismatch');
    }
    const denoise = manifest.denoise || {};
    const outputDepth = Number(denoise.output_depth);
    if (denoise.id !== nvenccKnn.DENOISE_ID ||
        denoise.implementation !== 'NVEncC 9.25 vpp-knn' ||
        denoise.settings !== nvenccKnn.KNN_SETTINGS ||
        denoise.temporal_filtering !== false ||
        ![8, 10].includes(outputDepth) ||
        denoise.transport !== 'raw-yuv420-nut-stdout') {
        throw new Error('direct grain manifest NVEncC KNN contract mismatch');
    }
    if (Number(manifest.source_video && manifest.source_video.bit_depth) !== outputDepth) {
        throw new Error('direct grain manifest changes bit depth between source clip and KNN output');
    }
    const selected = validateDirectSelection(manifest.selection, true);
    if (!manifest.selected_clip || manifest.selected_clip.status !== 'selected' ||
        Number(manifest.selected_clip.rank) !== Number(selected.rank) ||
        Number(manifest.selected_clip.start_seconds) !== Number(selected.start_seconds)) {
        throw new Error('direct grain manifest selected clip is not bound to selection evidence');
    }

    if (!manifest.pipeline || Number(manifest.pipeline.version) !== DIRECT_PIPELINE_VERSION ||
        path.resolve(String(manifest.pipeline.script || '')) !== path.resolve(pipelinePath) ||
        lower(manifest.pipeline.sha256) !== sha256File(pipelinePath)) {
        throw new Error(`direct grain manifest does not match pipeline version ${DIRECT_PIPELINE_VERSION}`);
    }
    const tableStat = assertRegularFile(tablePath, 'direct prepared grain table');
    if (!manifest.output ||
        path.resolve(String(manifest.output.path || '')) !== path.resolve(tablePath) ||
        lower(manifest.output.sha256) !== sha256File(tablePath) ||
        Number(manifest.output.bytes) !== tableStat.size ||
        Number(manifest.output.segment_count) !== 1 ||
        Number(manifest.output.segment_start) !== 0 ||
        Number(manifest.output.segment_end) !== Number(DIRECT_GLOBAL_SEGMENT_END)) {
        throw new Error('direct grain manifest table identity does not match the prepared table');
    }
    assertDirectGlobalTable(tablePath);
    assertDirectToolchain(manifest.toolchain, options);
    if (!manifest.scratch || manifest.scratch.retained !== false || manifest.scratch.path !== null) {
        throw new Error('direct grain manifest must prove internal clips were removed');
    }
    const transferFamily = manifest.media_profile && manifest.media_profile.transfer_family;
    if (!['sdr', 'pq'].includes(transferFamily) ||
        (options.expectedProfile && options.expectedProfile !== transferFamily)) {
        throw new Error('direct grain manifest media profile mismatch');
    }
    return {
        currentFingerprint,
        transferFamily,
        outputDepth,
        selectedClip: selected,
    };
}

function buildDirectPreparedArtifact(manifest, options) {
    const checked = validateDirectPreparedManifest(manifest, options);
    const tableStat = fs.statSync(options.tablePath);
    const dynamicEvidence = options.dynamicEvidence
        ? validateProvisionalDynamicHdrEvidence(
            options.dynamicEvidence, 'prepared direct grain dynamic-HDR evidence')
        : null;
    return {
        schema: DIRECT_ARTIFACT_SCHEMA,
        state: 'prepared',
        contractKind: 'direct-global-v1',
        sourcePath: String(options.sourcePath),
        sourceFingerprint: checked.currentFingerprint,
        tablePath: path.resolve(options.tablePath),
        tableSha256: sha256File(options.tablePath),
        tableBytes: tableStat.size,
        manifestPath: path.resolve(options.manifestPath),
        manifestSha256: sha256File(options.manifestPath),
        pipelinePath: fs.realpathSync(options.pipelinePath),
        pipelineSha256: sha256File(options.pipelinePath),
        pipelineVersion: DIRECT_PIPELINE_VERSION,
        comparisonMode: DIRECT_COMPARISON_MODE,
        denoiseId: nvenccKnn.DENOISE_ID,
        denoiseSettings: nvenccKnn.KNN_SETTINGS,
        denoisePrerollSeconds: 0,
        temporalFiltering: false,
        outputDepth: checked.outputDepth,
        grainModelContractId: DIRECT_GRAIN_MODEL_CONTRACT_ID,
        tableApplication: 'single-direct-unmodified-apply',
        mediaProfile: checked.transferFamily,
        provisionalDynamicHdr: dynamicEvidence,
        preparedAt: new Date().toISOString(),
    };
}

function validateDirectPreparedArtifact(artifact, options) {
    if (!artifact || Number(artifact.schema) !== DIRECT_ARTIFACT_SCHEMA ||
        artifact.state !== 'prepared' || artifact.contractKind !== 'direct-global-v1') {
        throw new Error(`prepared direct grain artifact schema ${DIRECT_ARTIFACT_SCHEMA} is required`);
    }
    for (const [key, expected] of [
        ['sourcePath', options.sourcePath],
        ['tablePath', options.tablePath],
        ['manifestPath', options.manifestPath],
        ['pipelinePath', fs.realpathSync(options.pipelinePath)],
    ]) {
        if (path.resolve(String(artifact[key] || '')) !== path.resolve(String(expected || ''))) {
            throw new Error(`prepared direct grain artifact ${key} mismatch`);
        }
    }
    if (Number(artifact.pipelineVersion) !== DIRECT_PIPELINE_VERSION ||
        artifact.comparisonMode !== DIRECT_COMPARISON_MODE ||
        artifact.denoiseId !== nvenccKnn.DENOISE_ID ||
        artifact.denoiseSettings !== nvenccKnn.KNN_SETTINGS ||
        Number(artifact.denoisePrerollSeconds) !== 0 ||
        artifact.temporalFiltering !== false ||
        ![8, 10].includes(Number(artifact.outputDepth)) ||
        artifact.grainModelContractId !== DIRECT_GRAIN_MODEL_CONTRACT_ID ||
        artifact.tableApplication !== 'single-direct-unmodified-apply') {
        throw new Error('prepared direct grain artifact contract mismatch');
    }
    if (artifact.provisionalDynamicHdr !== null) {
        const canonicalDynamic = validateProvisionalDynamicHdrEvidence(
            artifact.provisionalDynamicHdr, 'prepared direct grain dynamic-HDR evidence');
        if (JSON.stringify(artifact.provisionalDynamicHdr) !== JSON.stringify(canonicalDynamic)) {
            throw new Error('prepared direct grain dynamic-HDR evidence is not canonical');
        }
    }
    if (lower(artifact.tableSha256) !== sha256File(options.tablePath) ||
        Number(artifact.tableBytes) !== fs.statSync(options.tablePath).size ||
        lower(artifact.manifestSha256) !== sha256File(options.manifestPath) ||
        lower(artifact.pipelineSha256) !== sha256File(options.pipelinePath)) {
        throw new Error('prepared direct grain artifact checksum mismatch');
    }
    const manifest = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'));
    const checked = validateDirectPreparedManifest(manifest, {
        ...options,
        expectedProfile: artifact.mediaProfile,
    });
    if (Number(artifact.outputDepth) !== checked.outputDepth) {
        throw new Error('prepared direct grain artifact output-depth mismatch');
    }
    assertFingerprint(artifact.sourceFingerprint, checked.currentFingerprint,
        'prepared direct grain artifact source');
    return { artifact, manifest, checked };
}

function validatePreparedManifest(manifest, options) {
    const sourcePath = fs.realpathSync(options.sourcePath);
    const tablePath = fs.realpathSync(options.tablePath);
    const pipelinePath = fs.realpathSync(options.pipelinePath);
    if (!manifest || manifest.schema !== PIPELINE_MANIFEST_SCHEMA) {
        throw new Error(`grain analysis manifest schema ${PIPELINE_MANIFEST_SCHEMA} is required`);
    }
    if (manifest.grain_model_contract_id !== SPARSE_GLOBAL_MODEL_CONTRACT_ID ||
        manifest.timeline_coverage !== SPARSE_GLOBAL_TIMELINE_COVERAGE ||
        manifest.unseen_interval_basis !== SPARSE_GLOBAL_UNSEEN_INTERVAL_BASIS) {
        throw new Error('grain analysis manifest does not declare the sparse global-model contract');
    }
    if (path.resolve(String(manifest.source || '')) !== path.resolve(options.sourcePath)) {
        throw new Error('grain analysis manifest source path does not match the library original');
    }
    const currentFingerprint = sampledSourceFingerprint(sourcePath);
    assertFingerprint(manifest.source_fingerprint, currentFingerprint, 'grain analysis source');
    if (!manifest.comparison || manifest.comparison.mode !== 'hqdn3d' ||
        manifest.comparison.purpose !== 'source-denoise-grain-fit' ||
        manifest.comparison.production_eligible !== true ||
        manifest.comparison.base_role !== 'same-decode-hqdn3d-denoised-crops' ||
        manifest.comparison.base_source !== null || manifest.comparison.base_fingerprint !== null ||
        manifest.comparison.base_video !== null) {
        throw new Error('grain analysis manifest must prove source-only hqdn3d comparison mode');
    }
    const alignment = manifest.comparison.alignment || {};
    if (alignment.validated !== true || !/same-decode split filter graph/i.test(String(alignment.method || '')) ||
        !(Number(alignment.sample_pairs_validated) > 0)) {
        throw new Error('grain analysis manifest lacks same-decode sample-pair validation');
    }
    if (!manifest.pipeline || Number(manifest.pipeline.version) !== PIPELINE_VERSION ||
        path.resolve(String(manifest.pipeline.script || '')) !== path.resolve(pipelinePath) ||
        lower(manifest.pipeline.sha256) !== sha256File(pipelinePath)) {
        throw new Error(`grain analysis manifest does not match installed pipeline version ${PIPELINE_VERSION}`);
    }
    const tableStat = assertRegularFile(tablePath, 'prepared grain table');
    if (!manifest.output || path.resolve(String(manifest.output.path || '')) !== path.resolve(options.tablePath) ||
        lower(manifest.output.sha256) !== sha256File(tablePath) ||
        Number(manifest.output.bytes) !== tableStat.size) {
        throw new Error('grain analysis manifest table identity does not match the prepared table');
    }
    if (!hasSemanticGrain(fs.readFileSync(tablePath, 'utf8'))) {
        throw new Error('prepared grain table contains no semantic grain');
    }
    validateDenoiserAttestation(manifest.comparison.denoiser_attestation);
    const settingsCrop = manifest.settings && Number(manifest.settings.crop_size);
    const requestedCrop = manifest.settings && Number(manifest.settings.crop_size_requested_maximum);
    const sourceWidth = Number(manifest.source_video && manifest.source_video.width);
    const sourceHeight = Number(manifest.source_video && manifest.source_video.height);
    const policyCrop = Number.isFinite(sourceWidth) && Number.isFinite(sourceHeight)
        ? Math.min(requestedCrop, Math.floor((Math.min(sourceWidth, sourceHeight) * 8 / 27) / 2) * 2)
        : NaN;
    const requestedSampling = manifest.settings && manifest.settings.sampling && manifest.settings.sampling.requested;
    const effectiveSampling = manifest.settings && manifest.settings.sampling && manifest.settings.sampling.effective;
    if (!manifest.settings || manifest.settings.denoise !== DENOISE_FILTER ||
        Number(manifest.settings.scaling_gain) !== 1 ||
        Number(manifest.settings.preroll) !== DENOISE_PREROLL_SECONDS ||
        Number(manifest.settings.clip_seconds) !== PRODUCTION_FIT_SETTINGS.clipSeconds ||
        requestedCrop !== PRODUCTION_FIT_SETTINGS.requestedCropMaximum ||
        Number(manifest.settings.proxy_width) !== PRODUCTION_FIT_SETTINGS.proxyWidth ||
        Number(manifest.settings.proxy_fps) !== PRODUCTION_FIT_SETTINGS.proxyFps ||
        Number(manifest.settings.minimum_proxy_timestamps) !== MINIMUM_PROXY_TIMESTAMPS ||
        Number(manifest.settings.max_temporal_luma_stddev) !== PRODUCTION_FIT_SETTINGS.maxTemporalLumaStddev ||
        Number(manifest.settings.max_edge_density) !== PRODUCTION_FIT_SETTINGS.maxEdgeDensity ||
        Number(manifest.settings.max_spatial_luma_stddev) !== PRODUCTION_FIT_SETTINGS.maxSpatialLumaStddev ||
        Number(manifest.settings.max_extreme_pixel_fraction) !== PRODUCTION_FIT_SETTINGS.maxExtremePixelFraction ||
        Number(manifest.settings.max_native_luma_span) !== PRODUCTION_FIT_SETTINGS.maxNativeLumaSpan ||
        Number(manifest.settings.high_pass_sigma) !== PRODUCTION_FIT_SETTINGS.highPassSigma ||
        Number(manifest.settings.energy_trim_fraction) !== PRODUCTION_FIT_SETTINGS.energyTrimFraction ||
        Number(manifest.settings.energy_min_delta) !== PRODUCTION_FIT_SETTINGS.minimumSourceEnergyDelta ||
        Number(manifest.settings.min_scan_coverage) !== PRODUCTION_FIT_SETTINGS.minimumScanCoverage ||
        Number(manifest.settings.min_valid_tables) !== PRODUCTION_FIT_SETTINGS.minimumValidTables ||
        manifest.settings.crop_size_policy !== CROP_SIZE_POLICY ||
        !Number.isInteger(settingsCrop) || settingsCrop < MINIMUM_PRODUCTION_CROP_SIZE || settingsCrop % 2 !== 0 ||
        !Number.isInteger(requestedCrop) || requestedCrop < settingsCrop || settingsCrop !== policyCrop ||
        !requestedSampling || Number(requestedSampling.scan_step) !== PRODUCTION_FIT_SETTINGS.requestedScanStep ||
        Number(requestedSampling.skip_head_tail) !== PRODUCTION_FIT_SETTINGS.requestedSkipHeadTail ||
        Number(requestedSampling.min_spacing) !== PRODUCTION_FIT_SETTINGS.requestedFitSpacing ||
        !effectiveSampling || !(Number(effectiveSampling.min_spacing) > 0) ||
        Number(effectiveSampling.planned_min_spacing) < Number(effectiveSampling.min_spacing) ||
        Number(effectiveSampling.observed_fit_spacing) < Number(effectiveSampling.min_spacing)) {
        throw new Error(`grain analysis must use source-only ${DENOISE_FILTER} at scaling gain 1.0 with ` +
            `${DENOISE_PREROLL_SECONDS}-second preroll and the production crop/sampling policy`);
    }
    if (!manifest.scan || Number(manifest.scan.attempted) < MINIMUM_PROXY_TIMESTAMPS ||
        !(Number(manifest.scan.coverage) >= Number(manifest.settings.min_scan_coverage || 0.7))) {
        throw new Error('grain analysis scan coverage is absent or below its configured minimum');
    }
    if (!manifest.scratch || manifest.scratch.retained !== false || manifest.scratch.path !== null) {
        throw new Error('grain analysis manifest must prove internal clips were not retained');
    }
    const regionSets = validateThreeRegionSets(manifest);
    const transferFamily = manifest.media_profile && manifest.media_profile.transfer_family;
    if (transferFamily !== 'sdr' && transferFamily !== 'pq') {
        throw new Error('grain analysis manifest has an unsupported media profile');
    }
    const expectedBandSelection = `content-adaptive-${transferFamily}-1-code-quantiles`;
    if (manifest.media_profile.band_selection !== expectedBandSelection) {
        throw new Error(`grain analysis ${transferFamily} profile must use ${expectedBandSelection}`);
    }
    if (options.expectedProfile && transferFamily !== options.expectedProfile) {
        throw new Error(`grain analysis media profile changed from ${options.expectedProfile} to ${transferFamily}`);
    }
    return {
        currentFingerprint,
        transferFamily,
        regionSetContract: regionSets.contract,
        grainModelContractId: SPARSE_GLOBAL_MODEL_CONTRACT_ID,
        timelineCoverage: SPARSE_GLOBAL_TIMELINE_COVERAGE,
        unseenIntervalBasis: SPARSE_GLOBAL_UNSEEN_INTERVAL_BASIS,
        sourceResidualRepresentability: regionSets.sourceResidualRepresentability,
    };
}

function buildPreparedArtifact(manifest, options) {
    if (manifest && Number(manifest.schema) === DIRECT_PIPELINE_MANIFEST_SCHEMA) {
        return buildDirectPreparedArtifact(manifest, options);
    }
    const checked = validatePreparedManifest(manifest, options);
    const tableStat = fs.statSync(options.tablePath);
    const dynamicEvidence = options.dynamicEvidence
        ? validateProvisionalDynamicHdrEvidence(
            options.dynamicEvidence, 'prepared grain analysis dynamic-HDR evidence')
        : null;
    return {
        schema: ARTIFACT_SCHEMA,
        state: 'prepared',
        sourcePath: String(options.sourcePath),
        sourceFingerprint: checked.currentFingerprint,
        tablePath: path.resolve(options.tablePath),
        tableSha256: sha256File(options.tablePath),
        tableBytes: tableStat.size,
        manifestPath: path.resolve(options.manifestPath),
        manifestSha256: sha256File(options.manifestPath),
        pipelinePath: fs.realpathSync(options.pipelinePath),
        pipelineSha256: sha256File(options.pipelinePath),
        pipelineVersion: PIPELINE_VERSION,
        comparisonMode: 'hqdn3d',
        denoise: DENOISE_FILTER,
        denoisePrerollSeconds: DENOISE_PREROLL_SECONDS,
        scalingGain: 1,
        regionSetContract: checked.regionSetContract,
        grainModelContractId: checked.grainModelContractId,
        timelineCoverage: checked.timelineCoverage,
        unseenIntervalBasis: checked.unseenIntervalBasis,
        nativeLumaQualificationMethod: NATIVE_LUMA_QUALIFICATION_METHOD,
        maxNativeLumaSpan: PRODUCTION_FIT_SETTINGS.maxNativeLumaSpan,
        minimumCurveLumaSpacing: PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpacing,
        minimumCurveLumaSpan: PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpan,
        minimumCurveDistinctSupports: PRODUCTION_FIT_SETTINGS.minimumCurveDistinctSupports,
        postencodeResidualQualificationMethod: POSTENCODE_RESIDUAL_QUALIFICATION_METHOD,
        residualHighPassSigma: PRODUCTION_FIT_SETTINGS.highPassSigma,
        residualTrimFraction: PRODUCTION_FIT_SETTINGS.energyTrimFraction,
        residualMinimumEnergyDelta: PRODUCTION_FIT_SETTINGS.minimumSourceEnergyDelta,
        sourceResidualRepresentabilityMethod: SOURCE_RESIDUAL_REPRESENTABILITY_METHOD,
        sourceResidualMaximumMedianExcess: SOURCE_RESIDUAL_MAXIMUM_MEDIAN_EXCESS,
        sourceResidualMaximumPairExcess: SOURCE_RESIDUAL_MAXIMUM_PAIR_EXCESS,
        sourceResidualMedianExcess: checked.sourceResidualRepresentability.median_excess,
        sourceResidualMaximumExcess: checked.sourceResidualRepresentability.maximum_excess,
        mediaProfile: checked.transferFamily,
        provisionalDynamicHdr: dynamicEvidence,
        preparedAt: new Date().toISOString(),
    };
}

function validatePreparedArtifact(artifact, options) {
    if (artifact && Number(artifact.schema) === DIRECT_ARTIFACT_SCHEMA) {
        return validateDirectPreparedArtifact(artifact, options);
    }
    if (!artifact || artifact.schema !== ARTIFACT_SCHEMA || artifact.state !== 'prepared') {
        throw new Error(`prepared grain analysis artifact schema ${ARTIFACT_SCHEMA} is required`);
    }
    for (const [key, expected] of [
        ['sourcePath', options.sourcePath],
        ['tablePath', options.tablePath],
        ['manifestPath', options.manifestPath],
        ['pipelinePath', fs.realpathSync(options.pipelinePath)],
    ]) {
        if (path.resolve(String(artifact[key] || '')) !== path.resolve(String(expected || ''))) {
            throw new Error(`prepared grain analysis artifact ${key} mismatch`);
        }
    }
    if (artifact.comparisonMode !== 'hqdn3d' || artifact.denoise !== DENOISE_FILTER ||
        Number(artifact.denoisePrerollSeconds) !== DENOISE_PREROLL_SECONDS ||
        Number(artifact.scalingGain) !== 1 || Number(artifact.pipelineVersion) !== PIPELINE_VERSION ||
        artifact.regionSetContract !== REGION_SET_CONTRACT ||
        artifact.grainModelContractId !== SPARSE_GLOBAL_MODEL_CONTRACT_ID ||
        artifact.timelineCoverage !== SPARSE_GLOBAL_TIMELINE_COVERAGE ||
        artifact.unseenIntervalBasis !== SPARSE_GLOBAL_UNSEEN_INTERVAL_BASIS ||
        artifact.nativeLumaQualificationMethod !== NATIVE_LUMA_QUALIFICATION_METHOD ||
        Number(artifact.maxNativeLumaSpan) !== PRODUCTION_FIT_SETTINGS.maxNativeLumaSpan ||
        Number(artifact.minimumCurveLumaSpacing) !== PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpacing ||
        Number(artifact.minimumCurveLumaSpan) !== PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpan ||
        Number(artifact.minimumCurveDistinctSupports) !==
            PRODUCTION_FIT_SETTINGS.minimumCurveDistinctSupports ||
        artifact.postencodeResidualQualificationMethod !==
            POSTENCODE_RESIDUAL_QUALIFICATION_METHOD ||
        Number(artifact.residualHighPassSigma) !== PRODUCTION_FIT_SETTINGS.highPassSigma ||
        Number(artifact.residualTrimFraction) !== PRODUCTION_FIT_SETTINGS.energyTrimFraction ||
        Number(artifact.residualMinimumEnergyDelta) !==
            PRODUCTION_FIT_SETTINGS.minimumSourceEnergyDelta ||
        artifact.sourceResidualRepresentabilityMethod !==
            SOURCE_RESIDUAL_REPRESENTABILITY_METHOD ||
        typeof artifact.sourceResidualMaximumMedianExcess !== 'number' ||
        artifact.sourceResidualMaximumMedianExcess !==
            SOURCE_RESIDUAL_MAXIMUM_MEDIAN_EXCESS ||
        typeof artifact.sourceResidualMaximumPairExcess !== 'number' ||
        artifact.sourceResidualMaximumPairExcess !==
            SOURCE_RESIDUAL_MAXIMUM_PAIR_EXCESS ||
        typeof artifact.sourceResidualMedianExcess !== 'number' ||
        !Number.isFinite(artifact.sourceResidualMedianExcess) ||
        artifact.sourceResidualMedianExcess < 0 ||
        typeof artifact.sourceResidualMaximumExcess !== 'number' ||
        !Number.isFinite(artifact.sourceResidualMaximumExcess) ||
        artifact.sourceResidualMaximumExcess < 0) {
        throw new Error('prepared grain analysis artifact contract mismatch');
    }
    if (artifact.provisionalDynamicHdr !== null) {
        const canonicalDynamic = validateProvisionalDynamicHdrEvidence(
            artifact.provisionalDynamicHdr, 'prepared grain analysis dynamic-HDR evidence');
        if (JSON.stringify(artifact.provisionalDynamicHdr) !== JSON.stringify(canonicalDynamic)) {
            throw new Error('prepared grain analysis dynamic-HDR evidence is not canonical');
        }
    }
    if (lower(artifact.tableSha256) !== sha256File(options.tablePath) ||
        Number(artifact.tableBytes) !== fs.statSync(options.tablePath).size ||
        lower(artifact.manifestSha256) !== sha256File(options.manifestPath) ||
        lower(artifact.pipelineSha256) !== sha256File(options.pipelinePath)) {
        throw new Error('prepared grain analysis artifact checksum mismatch');
    }
    const manifest = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'));
    const checked = validatePreparedManifest(manifest, {
        ...options,
        expectedProfile: artifact.mediaProfile,
    });
    if (Math.abs(Number(artifact.sourceResidualMedianExcess) -
        Number(checked.sourceResidualRepresentability.median_excess)) > 1e-12 ||
        Math.abs(Number(artifact.sourceResidualMaximumExcess) -
        Number(checked.sourceResidualRepresentability.maximum_excess)) > 1e-12) {
        throw new Error('prepared grain analysis artifact representability mismatch');
    }
    assertFingerprint(artifact.sourceFingerprint, checked.currentFingerprint, 'prepared artifact source');
    return { artifact, manifest, checked };
}

function assertFullArtifactFingerprint(expected, filePath, description) {
    const resolved = fs.realpathSync(filePath);
    const stat = assertRegularFile(resolved, description);
    if (!expected || expected.scheme !== 'sha256-full-v1' ||
        path.resolve(String(expected.resolved_path || '')) !== path.resolve(resolved) ||
        Number(expected.size_bytes) !== stat.size || lower(expected.sha256) !== sha256File(resolved)) {
        throw new Error(`${description} fingerprint mismatch`);
    }
    return resolved;
}

function validateExactPairEvidence(pair, description) {
    const sourceHash = lower(pair && pair.source_framemd5_sequence_sha256);
    const denoisedHash = lower(pair && pair.denoised_framemd5_sequence_sha256);
    if (!pair || pair.exact_identical !== true ||
        !Number.isInteger(Number(pair.frames)) || Number(pair.frames) < 2 ||
        !/^[0-9a-f]{64}$/.test(sourceHash) || sourceHash !== denoisedHash) {
        throw new Error(`${description} is not an exact canonical source/denoised pair`);
    }
}

function validateNoGrainOutcome(report, options) {
    const sourcePath = fs.realpathSync(options.sourcePath);
    const pipelinePath = fs.realpathSync(options.pipelinePath);
    if (!report || Number(report.schema) !== 1 || report.operation !== 'fit' ||
        report.outcome !== 'bypass' || report.reason_code !== NO_GRAIN_REASON_CODE ||
        report.production_action !== NO_GRAIN_PRODUCTION_ACTION) {
        throw new Error('no-grain outcome has an unsupported disposition');
    }
    if (!report.pipeline || Number(report.pipeline.version) !== PIPELINE_VERSION) {
        throw new Error(`no-grain outcome does not identify pipeline version ${PIPELINE_VERSION}`);
    }
    assertFullArtifactFingerprint(report.pipeline, pipelinePath, 'no-grain pipeline');
    const currentFingerprint = sampledSourceFingerprint(sourcePath);
    assertFingerprint(report.input_identities && report.input_identities.source,
        currentFingerprint, 'no-grain source');

    const settings = report.fit_settings || {};
    const effectiveCrop = Number(settings.crop_size);
    const requestedCrop = Number(settings.crop_size_requested_maximum);
    if (settings.comparison_mode !== 'hqdn3d' ||
        settings.purpose !== 'source-denoise-grain-fit' ||
        settings.denoise !== DENOISE_FILTER || Number(settings.scaling_gain) !== 1 ||
        Number(settings.preroll_seconds) !== DENOISE_PREROLL_SECONDS ||
        Number(settings.clip_seconds) !== PRODUCTION_FIT_SETTINGS.clipSeconds ||
        requestedCrop !== PRODUCTION_FIT_SETTINGS.requestedCropMaximum ||
        Number(settings.proxy_width) !== PRODUCTION_FIT_SETTINGS.proxyWidth ||
        Number(settings.proxy_fps) !== PRODUCTION_FIT_SETTINGS.proxyFps ||
        Number(settings.max_temporal_luma_stddev) !== PRODUCTION_FIT_SETTINGS.maxTemporalLumaStddev ||
        Number(settings.max_edge_density) !== PRODUCTION_FIT_SETTINGS.maxEdgeDensity ||
        Number(settings.max_spatial_luma_stddev) !== PRODUCTION_FIT_SETTINGS.maxSpatialLumaStddev ||
        Number(settings.max_extreme_pixel_fraction) !== PRODUCTION_FIT_SETTINGS.maxExtremePixelFraction ||
        Number(settings.minimum_scan_coverage) !== PRODUCTION_FIT_SETTINGS.minimumScanCoverage ||
        Number(settings.minimum_valid_tables) !== PRODUCTION_FIT_SETTINGS.minimumValidTables ||
        Number(settings.requested_fit_spacing_seconds) !== PRODUCTION_FIT_SETTINGS.requestedFitSpacing ||
        Number(settings.requested_heldout_spacing_seconds) !== PRODUCTION_FIT_SETTINGS.requestedHeldoutSpacing ||
        settings.crop_size_policy !== CROP_SIZE_POLICY ||
        !Number.isInteger(effectiveCrop) || effectiveCrop < MINIMUM_PRODUCTION_CROP_SIZE ||
        effectiveCrop % 2 !== 0 || !Number.isInteger(requestedCrop) || requestedCrop < effectiveCrop ||
        Number(settings.minimum_fit_regions) !== 4 || Number(settings.minimum_heldout_regions) < 3 ||
        Number(settings.requested_minimum_heldout_regions) !== Number(settings.minimum_heldout_regions) ||
        Number(settings.requested_minimum_heldout_regions) > 4 ||
        Number(settings.requested_minimum_heldout_regions) !== PRODUCTION_FIT_SETTINGS.requestedHeldoutRegions ||
        settings.heldout_minimum_adapted !== false ||
        Number(settings.minimum_valid_tables) < 3 ||
        !Number.isFinite(Number(settings.minimum_scan_coverage))) {
        throw new Error('no-grain outcome fit settings do not match the production contract');
    }
    const evidence = report.evidence || {};
    const comparison = evidence.comparison || {};
    if (evidence.all_canonical_pairs_exact !== true || comparison.mode !== 'hqdn3d' ||
        comparison.purpose !== 'source-denoise-grain-fit' || comparison.denoise !== DENOISE_FILTER) {
        throw new Error('no-grain outcome lacks exact production comparison evidence');
    }
    validateDenoiserAttestation(comparison.denoiser_attestation);
    const selected = evidence.selected;
    const calibration = evidence.calibration;
    const heldout = evidence.heldout;
    const fitPairs = evidence.fit_pairs;
    const calibrationPairs = evidence.calibration_pairs;
    const heldoutPairs = evidence.heldout_pairs;
    const sampling = evidence.sampling || {};
    if (!Array.isArray(selected) || selected.length !== 4 || !Array.isArray(calibration) ||
        calibration.length !== Number(settings.minimum_heldout_regions) || !Array.isArray(heldout) ||
        heldout.length !== Number(settings.minimum_heldout_regions) ||
        !Array.isArray(fitPairs) || fitPairs.length !== selected.length ||
        !Array.isArray(calibrationPairs) || calibrationPairs.length !== calibration.length ||
        !Array.isArray(heldoutPairs) || heldoutPairs.length !== heldout.length) {
        throw new Error('no-grain outcome has incomplete fit, calibration, or final-validation evidence');
    }
    if (Number(evidence.crop_size) !== effectiveCrop || !(Number(sampling.fit_spacing) > 0) ||
        Number(sampling.min_spacing) < Number(sampling.fit_spacing) ||
        Number(sampling.observed_fit_spacing) < Number(sampling.fit_spacing) ||
        Number(sampling.heldout_spacing) < PRODUCTION_FIT_SETTINGS.clipSeconds + DENOISE_PREROLL_SECONDS) {
        throw new Error('no-grain outcome does not prove the production crop and sparse-sampling policy');
    }
    if (Number(evidence.minimum_heldout_regions) !== Number(settings.minimum_heldout_regions) ||
        Number(evidence.requested_minimum_heldout_regions) !== Number(settings.requested_minimum_heldout_regions) ||
        evidence.heldout_minimum_adapted !== settings.heldout_minimum_adapted) {
        throw new Error('no-grain outcome held-out adaptation evidence is inconsistent');
    }
    const selectedBands = new Set(selected.map((item) => Number(item && item.band_index)));
    const calibrationBands = new Set(calibration.map((item) => Number(item && item.band_index)));
    const heldoutBands = new Set(heldout.map((item) => Number(item && item.band_index)));
    if (selectedBands.size !== 4 || ![0, 1, 2, 3].every((band) => selectedBands.has(band)) ||
        calibrationBands.has(NaN) || calibrationBands.size < Math.min(3, calibration.length) ||
        heldoutBands.has(NaN) || heldoutBands.size < Math.min(2, heldout.length)) {
        throw new Error('no-grain outcome lacks diverse fit, calibration, and final-validation regions');
    }
    const noGrainSets = [selected, calibration, heldout];
    const noGrainIdentities = new Set();
    const noGrainRegions = [];
    noGrainSets.forEach((regions, setIndex) => regions.forEach((region, index) => {
        const identity = validatedRegionIdentity(region, `no-grain region ${setIndex}:${index}`);
        if (noGrainIdentities.has(identity)) {
            throw new Error('no-grain fit, calibration, and final-validation sets overlap');
        }
        noGrainIdentities.add(identity);
        noGrainRegions.push(region);
    }));
    const fitSpacing = Number(sampling.fit_spacing);
    const postencodeSpacing = Number(sampling.heldout_spacing);
    if (selected.some((region, index) => selected.slice(index + 1).some((other) =>
        Math.abs(Number(region.timestamp) - Number(other.timestamp)) < fitSpacing)) ||
        noGrainRegions.some((region, index) => noGrainRegions.slice(index + 1).some((other) =>
            Math.abs(Number(region.timestamp) - Number(other.timestamp)) < postencodeSpacing))) {
        throw new Error('no-grain fit, calibration, or final-validation spacing is invalid');
    }
    fitPairs.forEach((pair, index) => {
        validateExactPairEvidence(pair, `no-grain fit pair ${index}`);
        if (Number(pair.index) !== index || !regionEvidenceMatches(pair.candidate, selected[index])) {
            throw new Error(`no-grain fit pair ${index} is not bound to its selected region`);
        }
    });
    calibrationPairs.forEach((pair, index) => {
        validateExactPairEvidence(pair, `no-grain calibration pair ${index}`);
        if (Number(pair.index) !== index || !regionEvidenceMatches(pair.candidate, calibration[index])) {
            throw new Error(`no-grain calibration pair ${index} is not bound to its reserved region`);
        }
    });
    heldoutPairs.forEach((pair, index) => {
        validateExactPairEvidence(pair, `no-grain held-out pair ${index}`);
        if (Number(pair.index) !== index || !regionEvidenceMatches(pair.candidate, heldout[index])) {
            throw new Error(`no-grain held-out pair ${index} is not bound to its reserved region`);
        }
    });
    if (!evidence.scan || Number(evidence.scan.attempted) < MINIMUM_PROXY_TIMESTAMPS ||
        Number(evidence.scan.coverage) < Number(settings.minimum_scan_coverage)) {
        throw new Error('no-grain outcome scan coverage is below the production minimum');
    }
    const requested = report.requested_outputs || {};
    if (requested.artifacts_published !== false ||
        path.resolve(String(requested.table || '')) !== path.resolve(String(options.tablePath || '')) ||
        path.resolve(String(requested.manifest || '')) !== path.resolve(String(options.manifestPath || '')) ||
        fs.existsSync(options.tablePath) || fs.existsSync(options.manifestPath)) {
        throw new Error('no-grain outcome published or mismatched forbidden grain artifacts');
    }
    const transferFamily = evidence.media_profile && evidence.media_profile.transfer_family;
    if (transferFamily !== 'sdr' && transferFamily !== 'pq') {
        throw new Error('no-grain outcome has an unsupported media profile');
    }
    if (options.expectedProfile && transferFamily !== options.expectedProfile) {
        throw new Error(`no-grain media profile changed from ${options.expectedProfile} to ${transferFamily}`);
    }
    return { currentFingerprint, transferFamily, reasonCode: NO_GRAIN_REASON_CODE };
}

function validateInsufficientResidualSupportOutcome(report, options) {
    const sourcePath = fs.realpathSync(options.sourcePath);
    const pipelinePath = fs.realpathSync(options.pipelinePath);
    if (!report || report.schema !== 1 || report.operation !== 'fit' ||
        report.outcome !== 'bypass' ||
        report.reason_code !== NO_GRAIN_INSUFFICIENT_ENERGY_REASON_CODE ||
        report.production_action !== NO_GRAIN_PRODUCTION_ACTION) {
        throw new Error('low-energy grain outcome has an unsupported disposition');
    }
    if (!report.pipeline || report.pipeline.version !== PIPELINE_VERSION) {
        throw new Error(`low-energy grain outcome does not identify pipeline version ${PIPELINE_VERSION}`);
    }
    assertFullArtifactFingerprint(report.pipeline, pipelinePath, 'low-energy grain pipeline');
    const currentFingerprint = sampledSourceFingerprint(sourcePath);
    assertFingerprint(report.input_identities && report.input_identities.source,
        currentFingerprint, 'low-energy grain source');

    const settings = report.fit_settings || {};
    const settingNumber = (name) => strictJsonNumber(
        settings[name], `low-energy fit setting ${name}`);
    const effectiveCrop = strictJsonInteger(settings.crop_size, 'low-energy effective crop size');
    const requestedCrop = strictJsonInteger(
        settings.crop_size_requested_maximum, 'low-energy requested crop size');
    const minimumFitRegions = strictJsonInteger(
        settings.minimum_fit_regions, 'low-energy minimum fit regions');
    const minimumHeldoutRegions = strictJsonInteger(
        settings.minimum_heldout_regions, 'low-energy minimum held-out regions');
    const requestedHeldoutRegions = strictJsonInteger(
        settings.requested_minimum_heldout_regions,
        'low-energy requested minimum held-out regions');
    if (settings.comparison_mode !== 'hqdn3d' ||
        settings.purpose !== 'source-denoise-grain-fit' ||
        settings.denoise !== DENOISE_FILTER || settingNumber('scaling_gain') !== 1 ||
        settingNumber('preroll_seconds') !== DENOISE_PREROLL_SECONDS ||
        settingNumber('clip_seconds') !== PRODUCTION_FIT_SETTINGS.clipSeconds ||
        requestedCrop !== PRODUCTION_FIT_SETTINGS.requestedCropMaximum ||
        settingNumber('proxy_width') !== PRODUCTION_FIT_SETTINGS.proxyWidth ||
        settingNumber('proxy_fps') !== PRODUCTION_FIT_SETTINGS.proxyFps ||
        settingNumber('max_temporal_luma_stddev') !== PRODUCTION_FIT_SETTINGS.maxTemporalLumaStddev ||
        settingNumber('max_edge_density') !== PRODUCTION_FIT_SETTINGS.maxEdgeDensity ||
        settingNumber('max_spatial_luma_stddev') !== PRODUCTION_FIT_SETTINGS.maxSpatialLumaStddev ||
        settingNumber('max_extreme_pixel_fraction') !== PRODUCTION_FIT_SETTINGS.maxExtremePixelFraction ||
        settingNumber('max_native_luma_span') !== PRODUCTION_FIT_SETTINGS.maxNativeLumaSpan ||
        settingNumber('energy_min_luma_spacing') !== PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpacing ||
        settingNumber('energy_min_luma_span') !== PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpan ||
        settingNumber('high_pass_sigma') !== PRODUCTION_FIT_SETTINGS.highPassSigma ||
        settingNumber('energy_trim_fraction') !== PRODUCTION_FIT_SETTINGS.energyTrimFraction ||
        settingNumber('energy_min_delta') !== PRODUCTION_FIT_SETTINGS.minimumSourceEnergyDelta ||
        settingNumber('minimum_scan_coverage') !== PRODUCTION_FIT_SETTINGS.minimumScanCoverage ||
        settingNumber('minimum_valid_tables') !== PRODUCTION_FIT_SETTINGS.minimumValidTables ||
        settingNumber('requested_fit_spacing_seconds') !== PRODUCTION_FIT_SETTINGS.requestedFitSpacing ||
        settingNumber('requested_heldout_spacing_seconds') !== PRODUCTION_FIT_SETTINGS.requestedHeldoutSpacing ||
        settings.crop_size_policy !== CROP_SIZE_POLICY ||
        !Number.isInteger(effectiveCrop) || effectiveCrop < MINIMUM_PRODUCTION_CROP_SIZE ||
        effectiveCrop % 2 !== 0 || !Number.isInteger(requestedCrop) || requestedCrop < effectiveCrop ||
        minimumFitRegions !== 4 || minimumHeldoutRegions !== 4 ||
        requestedHeldoutRegions !== 4 ||
        settings.heldout_minimum_adapted !== false) {
        throw new Error('low-energy grain outcome fit settings do not match production');
    }

    const evidence = report.evidence || {};
    const comparison = evidence.comparison || {};
    if (evidence.advisory !== true || evidence.source_grain_absence_proven !== false ||
        evidence.selection_exhausted !== true || comparison.mode !== 'hqdn3d' ||
        comparison.purpose !== 'source-denoise-grain-fit' || comparison.denoise !== DENOISE_FILTER) {
        throw new Error('low-energy grain outcome lacks advisory comparison evidence');
    }
    validateDenoiserAttestation(comparison.denoiser_attestation);
    const selected = evidence.selected;
    const calibration = evidence.calibration;
    const heldout = evidence.heldout;
    const fitPairs = evidence.fit_pairs;
    const sampling = evidence.sampling || {};
    const timestamps = sampling.timestamps;
    const fitSpacing = strictJsonNumber(sampling.fit_spacing, 'low-energy fit spacing');
    const observedFitSpacing = strictJsonNumber(
        sampling.observed_fit_spacing, 'low-energy observed fit spacing');
    const postencodeSpacing = strictJsonNumber(
        sampling.heldout_spacing, 'low-energy held-out spacing');
    if (!Array.isArray(selected) || selected.length !== 4 ||
        !Array.isArray(calibration) || calibration.length !== 4 ||
        !Array.isArray(heldout) || heldout.length !== 4 ||
        !Array.isArray(fitPairs) || fitPairs.length !== 4 ||
        !Array.isArray(timestamps) || timestamps.length < MINIMUM_PROXY_TIMESTAMPS ||
        !(fitSpacing > 0) || observedFitSpacing < fitSpacing ||
        postencodeSpacing < PRODUCTION_FIT_SETTINGS.clipSeconds + DENOISE_PREROLL_SECONDS) {
        throw new Error('low-energy grain outcome lacks complete sparse regions');
    }
    const timestampValues = timestamps.map((value, index) =>
        strictJsonNumber(value, `low-energy scan timestamp ${index}`));
    if (timestampValues.some((value, index) => value < 0 ||
        (index > 0 && value <= timestampValues[index - 1]))) {
        throw new Error('low-energy scan timestamps are not strictly increasing');
    }
    const selectedBands = new Set(selected.map((item) => item && item.band_index));
    if (selectedBands.size !== 4 || ![0, 1, 2, 3].every((band) => selectedBands.has(band))) {
        throw new Error('low-energy grain fit regions lack luma-band coverage');
    }
    const regionSets = [selected, calibration, heldout];
    const allIdentities = new Set();
    const expectedRegions = new Map();
    regionSets.forEach((regions, setIndex) => regions.forEach((region, index) => {
        const identity = validateLowEnergyCandidate(
            region, PRODUCTION_FIT_SETTINGS, `low-energy region ${setIndex}:${index}`);
        if (allIdentities.has(identity)) throw new Error('low-energy grain region sets overlap');
        allIdentities.add(identity);
        expectedRegions.set(identity, region);
    }));
    const postencode = calibration.concat(heldout);
    if (selected.some((region, index) => selected.slice(index + 1).some((other) =>
        Math.abs(Number(region.timestamp) - Number(other.timestamp)) < fitSpacing)) ||
        postencode.some((region, index) => postencode.slice(index + 1).some((other) =>
            Math.abs(Number(region.timestamp) - Number(other.timestamp)) < postencodeSpacing))) {
        throw new Error('low-energy grain region spacing is invalid');
    }
    fitPairs.forEach((pair, index) => {
        const sourceHash = lower(pair && pair.source_framemd5_sequence_sha256);
        const denoisedHash = lower(pair && pair.denoised_framemd5_sequence_sha256);
        const pairIndex = strictJsonInteger(pair && pair.index, `low-energy fit pair ${index} index`);
        const pairFrames = strictJsonInteger(pair && pair.frames, `low-energy fit pair ${index} frames`);
        validateLowEnergyCandidate(
            pair && pair.candidate, PRODUCTION_FIT_SETTINGS,
            `low-energy fit pair ${index} candidate`);
        if (!pair || pairIndex !== index || pairFrames < 2 ||
            !/^[0-9a-f]{64}$/.test(sourceHash) || !/^[0-9a-f]{64}$/.test(denoisedHash) ||
            pair.exact_identical !== (sourceHash === denoisedHash) ||
            !strictRegionEvidenceMatches(pair.candidate, selected[index])) {
            throw new Error(`low-energy fit pair ${index} is inconsistent`);
        }
    });
    const scan = evidence.scan || {};
    const scanAttempted = strictJsonInteger(scan.attempted, 'low-energy scan attempts');
    const scanSuccessful = strictJsonInteger(scan.successful, 'low-energy successful scans');
    const scanCoverage = strictJsonNumber(scan.coverage, 'low-energy scan coverage');
    if (!Array.isArray(scan.failures) || scanAttempted !== timestampValues.length ||
        scanAttempted < MINIMUM_PROXY_TIMESTAMPS || scanSuccessful < 0 ||
        scanSuccessful > scanAttempted || scan.failures.length !== scanAttempted - scanSuccessful ||
        Math.abs(scanCoverage - scanSuccessful / scanAttempted) > 1e-12 ||
        scanCoverage < settings.minimum_scan_coverage) {
        throw new Error('low-energy grain scan coverage is below production minimum');
    }

    const native = evidence.native_luma_qualification || {};
    const nativeQualified = native.qualified;
    const nativeRejected = native.rejected;
    const nativeMaximumSpan = strictJsonNumber(
        native.maximum_span_codes, 'low-energy native maximum span');
    const nativeMinimumSpacing = strictJsonNumber(
        native.minimum_curve_spacing_codes, 'low-energy native minimum spacing');
    const nativeMinimumSpan = strictJsonNumber(
        native.minimum_curve_span_codes, 'low-energy native minimum curve span');
    const nativeMinimumSupports = strictJsonInteger(
        native.minimum_curve_distinct_supports, 'low-energy native minimum supports');
    if (native.method !== NATIVE_LUMA_QUALIFICATION_METHOD ||
        nativeMaximumSpan !== PRODUCTION_FIT_SETTINGS.maxNativeLumaSpan ||
        nativeMinimumSpacing !== PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpacing ||
        nativeMinimumSpan !== PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpan ||
        nativeMinimumSupports !== 4 ||
        !Array.isArray(nativeQualified) || nativeQualified.length !== 12 ||
        !Array.isArray(nativeRejected)) {
        throw new Error('low-energy native-luma policy is inconsistent');
    }
    const expectedNativeRoles = new Map();
    selected.forEach((region) => expectedNativeRoles.set(
        validateLowEnergyCandidate(region, PRODUCTION_FIT_SETTINGS, 'low-energy fit'),
        { role: 'fit', region }));
    calibration.forEach((region) => expectedNativeRoles.set(
        validateLowEnergyCandidate(region, PRODUCTION_FIT_SETTINGS, 'low-energy calibration'),
        { role: 'curve-calibration', region }));
    heldout.forEach((region) => expectedNativeRoles.set(
        validateLowEnergyCandidate(region, PRODUCTION_FIT_SETTINGS, 'low-energy validation'),
        { role: 'final-validation', region }));
    const nativeByIdentity = new Map();
    nativeQualified.forEach((record, index) => {
        const identity = validateLowEnergyCandidate(record && record.candidate,
            PRODUCTION_FIT_SETTINGS, `low-energy native record ${index}`);
        const expected = expectedNativeRoles.get(identity);
        const measurement = record && record.native_luma;
        const checkedMeasurement = validateLowEnergyNativeMeasurement(
            measurement, `low-energy native record ${index}`);
        if (nativeByIdentity.has(identity) || !expected || expected.role !== record.role ||
            !strictRegionEvidenceMatches(record.candidate, expected.region) ||
            checkedMeasurement.span > PRODUCTION_FIT_SETTINGS.maxNativeLumaSpan) {
            throw new Error('low-energy native-luma record is inconsistent');
        }
        nativeByIdentity.set(identity, measurement);
    });
    if (nativeByIdentity.size !== expectedNativeRoles.size ||
        [...expectedNativeRoles.keys()].some((identity) => !nativeByIdentity.has(identity))) {
        throw new Error('low-energy native-luma evidence does not cover all regions');
    }
    const nativeRejectedKeys = new Set();
    nativeRejected.forEach((record, index) => {
        const identity = validateLowEnergyCandidate(record && record.candidate,
            PRODUCTION_FIT_SETTINGS, `low-energy rejected native record ${index}`);
        const checkedMeasurement = validateLowEnergyNativeMeasurement(
            record && record.native_luma, `low-energy rejected native record ${index}`);
        const reason = record && record.reason;
        const key = `${identity}|${String(record && record.role || '')}|${String(reason || '')}`;
        const spanRejected = reason === 'native-frame-mean-luma-span-exceeded' &&
            checkedMeasurement.span > PRODUCTION_FIT_SETTINGS.maxNativeLumaSpan;
        const supportRejected = reason === 'native-luma-curve-support-retry' &&
            ['curve-calibration', 'final-validation'].includes(record.role) &&
            record.set_support && record.set_support.valid === false &&
            Array.isArray(record.set_support.failures) && record.set_support.failures.length > 0;
        if (nativeRejectedKeys.has(key) || (!spanRejected && !supportRejected)) {
            throw new Error('low-energy rejected native-luma record is inconsistent');
        }
        nativeRejectedKeys.add(key);
    });
    const expectedCalibrationSupport = summarizeNativeLumaSupport(calibration, nativeByIdentity,
        PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpacing,
        PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpan);
    const expectedValidationSupport = summarizeNativeLumaSupport(heldout, nativeByIdentity,
        PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpacing,
        PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpan);
    if (expectedCalibrationSupport.valid !== true || expectedValidationSupport.valid !== true ||
        JSON.stringify(canonicalValue(native.calibration_support)) !==
            JSON.stringify(canonicalValue(expectedCalibrationSupport)) ||
        JSON.stringify(canonicalValue(native.final_validation_support)) !==
            JSON.stringify(canonicalValue(expectedValidationSupport))) {
        throw new Error('low-energy native-luma support does not reproduce');
    }

    const residual = evidence.postencode_residual_qualification || {};
    const residualQualified = residual.qualified;
    const residualRejected = residual.rejected;
    const residualSigma = strictJsonNumber(residual.sigma, 'low-energy residual sigma');
    const residualTrim = strictJsonNumber(
        residual.trim_fraction, 'low-energy residual trim fraction');
    const minimum = strictJsonNumber(
        residual.minimum_mean_square_exclusive, 'low-energy residual minimum');
    if (residual.method !== POSTENCODE_RESIDUAL_QUALIFICATION_METHOD ||
        residual.metric !== 'paired-high-pass-residual-energy-v2' ||
        residual.normalized_units !== '8-bit-luma-code-squared' ||
        residual.denoise !== DENOISE_FILTER || residual.valid !== false ||
        residualSigma !== PRODUCTION_FIT_SETTINGS.highPassSigma ||
        residualTrim !== PRODUCTION_FIT_SETTINGS.energyTrimFraction ||
        minimum !== PRODUCTION_FIT_SETTINGS.minimumSourceEnergyDelta ||
        !Array.isArray(residualQualified) || !Array.isArray(residualRejected)) {
        throw new Error('low-energy residual policy is inconsistent');
    }
    const currentRoles = new Map();
    const currentRegions = new Map();
    calibration.forEach((region) => currentRoles.set(
        validateLowEnergyCandidate(region, PRODUCTION_FIT_SETTINGS,
            'low-energy current calibration'), 'curve-calibration'));
    calibration.forEach((region) => currentRegions.set(
        validateLowEnergyCandidate(region, PRODUCTION_FIT_SETTINGS,
            'low-energy current calibration'), region));
    heldout.forEach((region) => currentRoles.set(
        validateLowEnergyCandidate(region, PRODUCTION_FIT_SETTINGS,
            'low-energy current validation'), 'final-validation'));
    heldout.forEach((region) => currentRegions.set(
        validateLowEnergyCandidate(region, PRODUCTION_FIT_SETTINGS,
            'low-energy current validation'), region));
    const qualifiedIds = new Set();
    residualQualified.forEach((record, index) => {
        const identity = validateLowEnergyCandidate(record && record.candidate,
            PRODUCTION_FIT_SETTINGS, `low-energy qualified residual ${index}`);
        const meanSquare = validateResidualSummary(record && record.source_removed,
            PRODUCTION_FIT_SETTINGS.energyTrimFraction, `low-energy qualified residual ${index}`);
        if (qualifiedIds.has(identity) || currentRoles.get(identity) !== record.role ||
            !strictRegionEvidenceMatches(record.candidate, currentRegions.get(identity)) ||
            meanSquare <= minimum) {
            throw new Error('low-energy qualified residual record is inconsistent');
        }
        qualifiedIds.add(identity);
    });
    const rejectedIds = new Set();
    const currentWeakIds = new Set();
    residualRejected.forEach((record, index) => {
        const identity = validateLowEnergyCandidate(record && record.candidate,
            PRODUCTION_FIT_SETTINGS, `low-energy rejected residual ${index}`);
        const meanSquare = validateResidualSummary(record && record.source_removed,
            PRODUCTION_FIT_SETTINGS.energyTrimFraction, `low-energy rejected residual ${index}`);
        if (rejectedIds.has(identity) || qualifiedIds.has(identity) ||
            !['curve-calibration', 'final-validation'].includes(record.role_when_rejected) ||
            (currentRoles.has(identity) && record.role_when_rejected !== currentRoles.get(identity)) ||
            (currentRegions.has(identity) &&
                !strictRegionEvidenceMatches(record.candidate, currentRegions.get(identity))) ||
            record.reason !== 'source-removed-energy-at-or-below-minimum' ||
            record.excluded_from_both_postencode_roles !== true ||
            strictJsonNumber(record.minimum_mean_square_exclusive,
                `low-energy rejected residual ${index} minimum`) !== minimum ||
            meanSquare > minimum) {
            throw new Error('low-energy rejected residual record is inconsistent');
        }
        rejectedIds.add(identity);
        if (currentRoles.has(identity)) currentWeakIds.add(identity);
    });
    const accounted = new Set([...qualifiedIds, ...currentWeakIds]);
    if (accounted.size !== currentRoles.size ||
        [...currentRoles.keys()].some((identity) => !accounted.has(identity)) ||
        currentWeakIds.size < 1 || qualifiedIds.size >= currentRoles.size) {
        throw new Error('low-energy residual evidence does not cover every current region');
    }

    const requested = report.requested_outputs || {};
    if (requested.artifacts_published !== false ||
        path.resolve(String(requested.table || '')) !== path.resolve(String(options.tablePath || '')) ||
        path.resolve(String(requested.manifest || '')) !== path.resolve(String(options.manifestPath || '')) ||
        fs.existsSync(options.tablePath) || fs.existsSync(options.manifestPath)) {
        throw new Error('low-energy outcome published or mismatched forbidden grain artifacts');
    }
    const transferFamily = evidence.media_profile && evidence.media_profile.transfer_family;
    if (transferFamily !== 'sdr' && transferFamily !== 'pq') {
        throw new Error('low-energy grain outcome has an unsupported media profile');
    }
    if (options.expectedProfile && transferFamily !== options.expectedProfile) {
        throw new Error(`low-energy media profile changed from ${options.expectedProfile} to ${transferFamily}`);
    }
    return {
        currentFingerprint,
        transferFamily,
        reasonCode: NO_GRAIN_INSUFFICIENT_ENERGY_REASON_CODE,
    };
}

function validateStaticModelUnrepresentableOutcome(report, options) {
    const sourcePath = fs.realpathSync(options.sourcePath);
    const pipelinePath = fs.realpathSync(options.pipelinePath);
    const description = 'unrepresentable static-grain outcome';
    if (!report || report.schema !== 1 || report.operation !== 'fit' ||
        report.outcome !== 'bypass' ||
        report.reason_code !== NO_GRAIN_STATIC_MODEL_UNREPRESENTABLE_REASON_CODE ||
        report.production_action !== NO_GRAIN_PRODUCTION_ACTION) {
        throw new Error(`${description} has an unsupported disposition`);
    }
    if (!report.pipeline || report.pipeline.version !== PIPELINE_VERSION) {
        throw new Error(`${description} does not identify pipeline version ${PIPELINE_VERSION}`);
    }
    assertFullArtifactFingerprint(report.pipeline, pipelinePath, `${description} pipeline`);
    const currentFingerprint = sampledSourceFingerprint(sourcePath);
    assertFingerprint(report.input_identities && report.input_identities.source,
        currentFingerprint, `${description} source`);

    const settings = report.fit_settings || {};
    const settingNumber = (name) => strictJsonNumber(
        settings[name], `${description} fit setting ${name}`);
    const effectiveCrop = strictJsonInteger(settings.crop_size,
        `${description} effective crop size`);
    const requestedCrop = strictJsonInteger(settings.crop_size_requested_maximum,
        `${description} requested crop size`);
    const minimumFitRegions = strictJsonInteger(settings.minimum_fit_regions,
        `${description} minimum fit regions`);
    const minimumHeldoutRegions = strictJsonInteger(settings.minimum_heldout_regions,
        `${description} minimum held-out regions`);
    const requestedHeldoutRegions = strictJsonInteger(
        settings.requested_minimum_heldout_regions,
        `${description} requested minimum held-out regions`);
    if (settings.comparison_mode !== 'hqdn3d' ||
        settings.purpose !== 'source-denoise-grain-fit' ||
        settings.denoise !== DENOISE_FILTER || settingNumber('scaling_gain') !== 1 ||
        settingNumber('preroll_seconds') !== DENOISE_PREROLL_SECONDS ||
        settingNumber('clip_seconds') !== PRODUCTION_FIT_SETTINGS.clipSeconds ||
        requestedCrop !== PRODUCTION_FIT_SETTINGS.requestedCropMaximum ||
        settingNumber('proxy_width') !== PRODUCTION_FIT_SETTINGS.proxyWidth ||
        settingNumber('proxy_fps') !== PRODUCTION_FIT_SETTINGS.proxyFps ||
        settingNumber('max_temporal_luma_stddev') !==
            PRODUCTION_FIT_SETTINGS.maxTemporalLumaStddev ||
        settingNumber('max_edge_density') !== PRODUCTION_FIT_SETTINGS.maxEdgeDensity ||
        settingNumber('max_spatial_luma_stddev') !==
            PRODUCTION_FIT_SETTINGS.maxSpatialLumaStddev ||
        settingNumber('max_extreme_pixel_fraction') !==
            PRODUCTION_FIT_SETTINGS.maxExtremePixelFraction ||
        settingNumber('max_native_luma_span') !== PRODUCTION_FIT_SETTINGS.maxNativeLumaSpan ||
        settingNumber('energy_min_luma_spacing') !==
            PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpacing ||
        settingNumber('energy_min_luma_span') !==
            PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpan ||
        settingNumber('high_pass_sigma') !== PRODUCTION_FIT_SETTINGS.highPassSigma ||
        settingNumber('energy_trim_fraction') !== PRODUCTION_FIT_SETTINGS.energyTrimFraction ||
        settingNumber('energy_min_delta') !== PRODUCTION_FIT_SETTINGS.minimumSourceEnergyDelta ||
        settingNumber('minimum_scan_coverage') !== PRODUCTION_FIT_SETTINGS.minimumScanCoverage ||
        settingNumber('minimum_valid_tables') !== PRODUCTION_FIT_SETTINGS.minimumValidTables ||
        settingNumber('requested_fit_spacing_seconds') !==
            PRODUCTION_FIT_SETTINGS.requestedFitSpacing ||
        settingNumber('requested_heldout_spacing_seconds') !==
            PRODUCTION_FIT_SETTINGS.requestedHeldoutSpacing ||
        settings.crop_size_policy !== CROP_SIZE_POLICY ||
        effectiveCrop < MINIMUM_PRODUCTION_CROP_SIZE || effectiveCrop % 2 !== 0 ||
        requestedCrop < effectiveCrop || minimumFitRegions !== 4 ||
        minimumHeldoutRegions !== 4 || requestedHeldoutRegions !== 4 ||
        settings.heldout_minimum_adapted !== false) {
        throw new Error(`${description} fit settings do not match production`);
    }

    const evidence = report.evidence || {};
    const comparison = evidence.comparison || {};
    if (evidence.advisory !== true || evidence.source_grain_absence_proven !== false ||
        evidence.selection_exhausted !== true || comparison.mode !== 'hqdn3d' ||
        comparison.purpose !== 'source-denoise-grain-fit' ||
        comparison.denoise !== DENOISE_FILTER) {
        throw new Error(`${description} lacks authenticated comparison evidence`);
    }
    validateDenoiserAttestation(comparison.denoiser_attestation);

    const selected = evidence.selected;
    const calibration = evidence.calibration;
    const heldout = evidence.heldout;
    const sampling = evidence.sampling || {};
    const timestamps = sampling.timestamps;
    const fitSpacing = strictJsonNumber(sampling.fit_spacing,
        `${description} fit spacing`);
    const observedFitSpacing = strictJsonNumber(sampling.observed_fit_spacing,
        `${description} observed fit spacing`);
    const heldoutSpacing = strictJsonNumber(sampling.heldout_spacing,
        `${description} held-out spacing`);
    if (!Array.isArray(selected) || selected.length !== 4 ||
        !Array.isArray(calibration) || calibration.length !== 4 ||
        !Array.isArray(heldout) || heldout.length !== 4 ||
        !Array.isArray(timestamps) || timestamps.length < MINIMUM_PROXY_TIMESTAMPS ||
        !(fitSpacing > 0) || observedFitSpacing < fitSpacing ||
        heldoutSpacing < PRODUCTION_FIT_SETTINGS.clipSeconds + DENOISE_PREROLL_SECONDS ||
        strictJsonInteger(evidence.crop_size, `${description} evidence crop size`) !==
            effectiveCrop ||
        strictJsonInteger(evidence.minimum_heldout_regions,
            `${description} effective held-out minimum`) !== minimumHeldoutRegions ||
        strictJsonInteger(evidence.requested_minimum_heldout_regions,
            `${description} requested held-out minimum`) !== requestedHeldoutRegions ||
        evidence.heldout_minimum_adapted !== false) {
        throw new Error(`${description} lacks complete sparse region evidence`);
    }
    const timestampValues = timestamps.map((value, index) =>
        strictJsonNumber(value, `${description} scan timestamp ${index}`));
    if (timestampValues.some((value, index) => value < 0 ||
        (index > 0 && value <= timestampValues[index - 1]))) {
        throw new Error(`${description} scan timestamps are not strictly increasing`);
    }
    const expectedRoles = new Map();
    const expectedRegions = new Map();
    const allIdentities = new Set();
    [
        [selected, 'fit'],
        [calibration, 'curve-calibration'],
        [heldout, 'final-validation'],
    ].forEach(([regions, role], setIndex) => regions.forEach((region, index) => {
        const identity = validateLowEnergyCandidate(region, PRODUCTION_FIT_SETTINGS,
            `${description} region ${setIndex}:${index}`);
        if (allIdentities.has(identity)) throw new Error(`${description} region sets overlap`);
        allIdentities.add(identity);
        expectedRoles.set(identity, role);
        expectedRegions.set(identity, region);
    }));
    const selectedBands = new Set(selected.map((region) => region.band_index));
    if (selectedBands.size !== 4 || ![0, 1, 2, 3].every((band) => selectedBands.has(band)) ||
        selected.some((region, index) => selected.slice(index + 1).some((other) =>
            Math.abs(Number(region.timestamp) - Number(other.timestamp)) < fitSpacing)) ||
        calibration.concat(heldout).some((region, index, regions) =>
            regions.slice(index + 1).some((other) =>
                Math.abs(Number(region.timestamp) - Number(other.timestamp)) < heldoutSpacing))) {
        throw new Error(`${description} region coverage or spacing is invalid`);
    }
    const scan = evidence.scan || {};
    const scanAttempted = strictJsonInteger(scan.attempted, `${description} scan attempts`);
    const scanSuccessful = strictJsonInteger(scan.successful, `${description} successful scans`);
    const scanCoverage = strictJsonNumber(scan.coverage, `${description} scan coverage`);
    if (!Array.isArray(scan.failures) || scanAttempted !== timestampValues.length ||
        scanAttempted < MINIMUM_PROXY_TIMESTAMPS || scanSuccessful < 0 ||
        scanSuccessful > scanAttempted ||
        scan.failures.length !== scanAttempted - scanSuccessful ||
        Math.abs(scanCoverage - scanSuccessful / scanAttempted) > 1e-12 ||
        scanCoverage < settings.minimum_scan_coverage) {
        throw new Error(`${description} scan coverage is below production minimum`);
    }

    const native = evidence.native_luma_qualification || {};
    const nativeQualified = native.qualified;
    if (native.method !== NATIVE_LUMA_QUALIFICATION_METHOD ||
        strictJsonNumber(native.maximum_span_codes,
            `${description} native maximum span`) !==
            PRODUCTION_FIT_SETTINGS.maxNativeLumaSpan ||
        strictJsonNumber(native.minimum_curve_spacing_codes,
            `${description} native minimum spacing`) !==
            PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpacing ||
        strictJsonNumber(native.minimum_curve_span_codes,
            `${description} native minimum span`) !==
            PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpan ||
        strictJsonInteger(native.minimum_curve_distinct_supports,
            `${description} native minimum supports`) !== 4 ||
        !Array.isArray(nativeQualified) || nativeQualified.length !== 12 ||
        !Array.isArray(native.rejected)) {
        throw new Error(`${description} native-luma policy is inconsistent`);
    }
    const nativeByIdentity = new Map();
    nativeQualified.forEach((record, index) => {
        const identity = validateLowEnergyCandidate(record && record.candidate,
            PRODUCTION_FIT_SETTINGS, `${description} native record ${index}`);
        const expectedRole = expectedRoles.get(identity);
        const checkedMeasurement = validateLowEnergyNativeMeasurement(
            record && record.native_luma, `${description} native record ${index}`);
        if (!expectedRole || record.role !== expectedRole || nativeByIdentity.has(identity) ||
            !strictRegionEvidenceMatches(record.candidate, expectedRegions.get(identity)) ||
            checkedMeasurement.span > PRODUCTION_FIT_SETTINGS.maxNativeLumaSpan) {
            throw new Error(`${description} native-luma record is inconsistent`);
        }
        nativeByIdentity.set(identity, record.native_luma);
    });
    if (nativeByIdentity.size !== expectedRoles.size ||
        [...expectedRoles.keys()].some((identity) => !nativeByIdentity.has(identity))) {
        throw new Error(`${description} native-luma evidence does not cover all regions`);
    }
    const expectedCalibrationSupport = summarizeNativeLumaSupport(
        calibration, nativeByIdentity,
        PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpacing,
        PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpan);
    const expectedValidationSupport = summarizeNativeLumaSupport(
        heldout, nativeByIdentity,
        PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpacing,
        PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpan);
    if (expectedCalibrationSupport.valid !== true || expectedValidationSupport.valid !== true ||
        JSON.stringify(canonicalValue(native.calibration_support)) !==
            JSON.stringify(canonicalValue(expectedCalibrationSupport)) ||
        JSON.stringify(canonicalValue(native.final_validation_support)) !==
            JSON.stringify(canonicalValue(expectedValidationSupport))) {
        throw new Error(`${description} native-luma support does not reproduce`);
    }

    const residual = evidence.postencode_residual_qualification || {};
    const residualQualified = residual.qualified;
    if (residual.method !== POSTENCODE_RESIDUAL_QUALIFICATION_METHOD ||
        residual.metric !== 'paired-high-pass-residual-energy-v2' ||
        residual.normalized_units !== '8-bit-luma-code-squared' ||
        residual.denoise !== DENOISE_FILTER || residual.valid !== true ||
        strictJsonNumber(residual.sigma, `${description} residual sigma`) !==
            PRODUCTION_FIT_SETTINGS.highPassSigma ||
        strictJsonNumber(residual.trim_fraction, `${description} residual trim`) !==
            PRODUCTION_FIT_SETTINGS.energyTrimFraction ||
        strictJsonNumber(residual.minimum_mean_square_exclusive,
            `${description} residual minimum`) !==
            PRODUCTION_FIT_SETTINGS.minimumSourceEnergyDelta ||
        !Array.isArray(residualQualified) || residualQualified.length !== 8 ||
        !Array.isArray(residual.rejected)) {
        throw new Error(`${description} residual policy is inconsistent`);
    }
    const residualIds = new Set();
    residualQualified.forEach((record, index) => {
        const identity = validateLowEnergyCandidate(record && record.candidate,
            PRODUCTION_FIT_SETTINGS, `${description} residual record ${index}`);
        const expectedRole = expectedRoles.get(identity);
        const meanSquare = validateResidualSummary(record && record.source_removed,
            PRODUCTION_FIT_SETTINGS.energyTrimFraction,
            `${description} residual record ${index}`);
        if (!['curve-calibration', 'final-validation'].includes(expectedRole) ||
            record.role !== expectedRole || residualIds.has(identity) ||
            !strictRegionEvidenceMatches(record.candidate, expectedRegions.get(identity)) ||
            meanSquare <= PRODUCTION_FIT_SETTINGS.minimumSourceEnergyDelta) {
            throw new Error(`${description} residual record is inconsistent`);
        }
        residualIds.add(identity);
    });
    const expectedResidualIds = new Set([
        ...calibration.map((region) => validateLowEnergyCandidate(
            region, PRODUCTION_FIT_SETTINGS, `${description} calibration`)),
        ...heldout.map((region) => validateLowEnergyCandidate(
            region, PRODUCTION_FIT_SETTINGS, `${description} validation`)),
    ]);
    if (residualIds.size !== expectedResidualIds.size ||
        [...expectedResidualIds].some((identity) => !residualIds.has(identity))) {
        throw new Error(`${description} residual evidence does not cover postencode regions`);
    }
    const representability = validateSourceResidualRepresentability(
        evidence.source_residual_representability,
        nativeQualified,
        residualQualified
    );
    if (representability.valid !== false || !Array.isArray(representability.failures) ||
        representability.failures.length === 0) {
        throw new Error(`${description} does not prove a static-model mismatch`);
    }

    const requested = report.requested_outputs || {};
    if (requested.artifacts_published !== false ||
        path.resolve(String(requested.table || '')) !==
            path.resolve(String(options.tablePath || '')) ||
        path.resolve(String(requested.manifest || '')) !==
            path.resolve(String(options.manifestPath || '')) ||
        fs.existsSync(options.tablePath) || fs.existsSync(options.manifestPath)) {
        throw new Error(`${description} published or mismatched forbidden grain artifacts`);
    }
    const transferFamily = evidence.media_profile && evidence.media_profile.transfer_family;
    if (transferFamily !== 'sdr' && transferFamily !== 'pq') {
        throw new Error(`${description} has an unsupported media profile`);
    }
    if (options.expectedProfile && transferFamily !== options.expectedProfile) {
        throw new Error(
            `${description} media profile changed from ${options.expectedProfile} to ${transferFamily}`
        );
    }
    return {
        currentFingerprint,
        transferFamily,
        reasonCode: NO_GRAIN_STATIC_MODEL_UNREPRESENTABLE_REASON_CODE,
    };
}

function exactObjectFields(value, expectedFields) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
        JSON.stringify(Object.keys(value).sort()) ===
            JSON.stringify([...expectedFields].sort());
}

function sourceNoiseMedian(values, description) {
    if (!Array.isArray(values) || values.length === 0 ||
        values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`${description} requires finite values`);
    }
    const ordered = [...values].sort((left, right) => left - right);
    const midpoint = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 1
        ? ordered[midpoint]
        : (ordered[midpoint - 1] + ordered[midpoint]) / 2;
}

function sourceNoiseNearestRank(values, fraction, description) {
    if (!Array.isArray(values) || values.length === 0 ||
        typeof fraction !== 'number' || !(fraction > 0 && fraction <= 1) ||
        values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`${description} requires finite values and q in (0, 1]`);
    }
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)];
}

function validateSourceNoiseFrame(frame, cropSize, description) {
    const expectedFields = [
        'schema', 'method', 'width', 'height', 'max_value', 'pixel_sha256',
        'edge_threshold_exclusive', 'minimum_smooth_pixels',
        'smooth_pixel_count', 'laplacian_absolute_sum', 'estimate',
    ];
    if (!exactObjectFields(frame, expectedFields)) {
        throw new Error(`${description} is malformed`);
    }
    const schema = strictJsonInteger(frame.schema, `${description} schema`);
    const width = strictJsonInteger(frame.width, `${description} width`);
    const height = strictJsonInteger(frame.height, `${description} height`);
    const maxValue = strictJsonInteger(frame.max_value, `${description} maximum`);
    const edgeThreshold = strictJsonInteger(
        frame.edge_threshold_exclusive, `${description} edge threshold`);
    const minimumSmooth = strictJsonInteger(
        frame.minimum_smooth_pixels, `${description} minimum smooth pixels`);
    const smoothCount = strictJsonInteger(
        frame.smooth_pixel_count, `${description} smooth count`);
    const laplacianSum = strictJsonInteger(
        frame.laplacian_absolute_sum, `${description} Laplacian sum`);
    if (schema !== 1 || frame.method !== SOURCE_NOISE_ESTIMATOR_METHOD ||
        width !== cropSize || height !== cropSize || maxValue !== 255 ||
        edgeThreshold !== SOURCE_NOISE_EDGE_THRESHOLD ||
        minimumSmooth !== SOURCE_NOISE_MINIMUM_SMOOTH_PIXELS ||
        smoothCount < 0 || smoothCount > Math.max(0, width - 2) * Math.max(0, height - 2) ||
        laplacianSum < 0 || !Number.isSafeInteger(laplacianSum) ||
        typeof frame.pixel_sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(frame.pixel_sha256)) {
        throw new Error(`${description} violates the estimator contract`);
    }
    if (smoothCount < SOURCE_NOISE_MINIMUM_SMOOTH_PIXELS) {
        if (frame.estimate !== null) {
            throw new Error(`${description} reports an estimate without flat support`);
        }
        return null;
    }
    const estimate = strictJsonNumber(frame.estimate, `${description} estimate`);
    const expected = laplacianSum / (6 * smoothCount) * Math.sqrt(Math.PI / 2);
    if (estimate < 0 || Math.abs(estimate - expected) > 1e-12) {
        throw new Error(`${description} estimate does not reproduce`);
    }
    return estimate;
}

function validateSourceNoiseQualificationV1Legacy(
    qualification,
    expectedNoiseRegions,
    cropSize,
    description
) {
    const expectedFields = [
        'schema', 'method', 'estimator', 'render',
        'minimum_valid_frames_per_region', 'required_valid_regions',
        'required_regions_per_role', 'aggregation',
        'median_threshold_exclusive', 'p90_threshold_exclusive',
        'valid_region_count', 'valid_region_count_by_role', 'valid_support',
        'median_noise', 'p90_noise', 'no_noticeable_noise', 'regions',
    ];
    if (!exactObjectFields(qualification, expectedFields)) {
        throw new Error(`${description} qualification is malformed`);
    }
    const render = qualification.render;
    if (!exactObjectFields(render, [
        'source_plane', 'pixel_format', 'spatial_resolution',
        'numeric_normalization', 'source_bit_depth', 'right_shift_bits',
        'prequantization_step', 'denoised', 'frames_per_region',
    ])) {
        throw new Error(`${description} render evidence is malformed`);
    }
    const sourceBitDepth = strictJsonInteger(
        render.source_bit_depth, `${description} source bit depth`);
    const rightShiftBits = strictJsonInteger(
        render.right_shift_bits, `${description} right shift`);
    const prequantizationStep = strictJsonInteger(
        render.prequantization_step, `${description} prequantization step`);
    const expectedRender = {
        source_plane: 'luma',
        pixel_format: 'gray8',
        spatial_resolution: 'native-crop-no-downscale',
        numeric_normalization: SOURCE_NOISE_GRAY8_NORMALIZATION,
        source_bit_depth: sourceBitDepth,
        right_shift_bits: rightShiftBits,
        prequantization_step: prequantizationStep,
        denoised: false,
        frames_per_region: SOURCE_NOISE_RENDERED_FRAMES_PER_REGION,
    };
    if (strictJsonInteger(qualification.schema, `${description} qualification schema`) !== 1 ||
        qualification.method !== SOURCE_NOISE_QUALIFICATION_METHOD ||
        qualification.estimator !== SOURCE_NOISE_ESTIMATOR_METHOD ||
        sourceBitDepth < 8 || sourceBitDepth > 16 ||
        rightShiftBits !== sourceBitDepth - 8 ||
        prequantizationStep !== 2 ** rightShiftBits ||
        JSON.stringify(canonicalValue(render)) !==
            JSON.stringify(canonicalValue(expectedRender)) ||
        strictJsonInteger(
            qualification.minimum_valid_frames_per_region,
            `${description} minimum valid frames`) !==
            SOURCE_NOISE_MINIMUM_VALID_FRAMES_PER_REGION ||
        strictJsonInteger(
            qualification.required_valid_regions,
            `${description} required valid regions`) !==
            SOURCE_NOISE_REQUIRED_VALID_REGIONS ||
        strictJsonInteger(
            qualification.required_regions_per_role,
            `${description} required regions per role`) !==
            SOURCE_NOISE_REQUIRED_REGIONS_PER_ROLE ||
        qualification.aggregation !==
            'region-frame-median-then-nearest-rank-p90-v1' ||
        strictJsonNumber(
            qualification.median_threshold_exclusive,
            `${description} median threshold`) !== SOURCE_NOISE_MEDIAN_THRESHOLD ||
        strictJsonNumber(
            qualification.p90_threshold_exclusive,
            `${description} p90 threshold`) !== SOURCE_NOISE_P90_THRESHOLD ||
        !Array.isArray(qualification.regions) ||
        qualification.regions.length !== SOURCE_NOISE_REQUIRED_VALID_REGIONS) {
        throw new Error(`${description} qualification policy is inconsistent`);
    }

    const observed = new Set();
    const validValues = [];
    const validByRole = {
        'curve-calibration': 0,
        'final-validation': 0,
    };
    qualification.regions.forEach((record, index) => {
        const regionDescription = `${description} region ${index}`;
        if (!exactObjectFields(record, [
            'role', 'candidate', 'rendered_frame_count', 'valid_frame_count',
            'valid', 'median_noise', 'frames',
        ])) {
            throw new Error(`${regionDescription} is malformed`);
        }
        const identity = validateLowEnergyCandidate(
            record.candidate, PRODUCTION_FIT_SETTINGS, `${regionDescription} candidate`);
        const expected = expectedNoiseRegions.get(identity);
        const renderedCount = strictJsonInteger(
            record.rendered_frame_count, `${regionDescription} rendered count`);
        const validCount = strictJsonInteger(
            record.valid_frame_count, `${regionDescription} valid count`);
        if (!expected || observed.has(identity) || record.role !== expected.role ||
            !strictRegionEvidenceMatches(record.candidate, expected.region) ||
            renderedCount !== SOURCE_NOISE_RENDERED_FRAMES_PER_REGION ||
            !Array.isArray(record.frames) || record.frames.length !== renderedCount) {
            throw new Error(`${regionDescription} is inconsistent`);
        }
        observed.add(identity);
        const estimates = record.frames.map((frame, frameIndex) =>
            validateSourceNoiseFrame(
                frame, cropSize, `${regionDescription} frame ${frameIndex}`));
        const numeric = estimates.filter((value) => value !== null);
        const expectedValid =
            numeric.length >= SOURCE_NOISE_MINIMUM_VALID_FRAMES_PER_REGION;
        if (validCount !== numeric.length || record.valid !== expectedValid) {
            throw new Error(`${regionDescription} support does not reproduce`);
        }
        if (expectedValid) {
            const median = strictJsonNumber(
                record.median_noise, `${regionDescription} median`);
            const expectedMedian = sourceNoiseMedian(numeric, `${regionDescription} median`);
            if (Math.abs(median - expectedMedian) > 1e-12) {
                throw new Error(`${regionDescription} median does not reproduce`);
            }
            validValues.push(median);
            validByRole[record.role] += 1;
        } else if (record.median_noise !== null) {
            throw new Error(`${regionDescription} has an unsupported median`);
        }
    });
    if (observed.size !== expectedNoiseRegions.size ||
        [...expectedNoiseRegions.keys()].some((identity) => !observed.has(identity))) {
        throw new Error(`${description} does not cover the frozen regions`);
    }

    const validSupport =
        validValues.length === SOURCE_NOISE_REQUIRED_VALID_REGIONS &&
        Object.values(validByRole).every(
            (count) => count === SOURCE_NOISE_REQUIRED_REGIONS_PER_ROLE);
    const medianNoise = validSupport
        ? sourceNoiseMedian(validValues, `${description} aggregate median`) : null;
    const p90Noise = validSupport
        ? sourceNoiseNearestRank(validValues, 0.9, `${description} aggregate p90`) : null;
    const noNoticeable = validSupport &&
        medianNoise < SOURCE_NOISE_MEDIAN_THRESHOLD &&
        p90Noise < SOURCE_NOISE_P90_THRESHOLD;
    const recordedByRole = qualification.valid_region_count_by_role;
    if (!exactObjectFields(recordedByRole, Object.keys(validByRole)) ||
        Object.entries(validByRole).some(([role, expectedCount]) =>
            strictJsonInteger(
                recordedByRole[role], `${description} ${role} valid count`) !== expectedCount) ||
        strictJsonInteger(
            qualification.valid_region_count, `${description} valid region count`) !==
            validValues.length ||
        qualification.valid_support !== validSupport ||
        qualification.no_noticeable_noise !== noNoticeable ||
        (medianNoise === null
            ? qualification.median_noise !== null
            : Math.abs(strictJsonNumber(
                qualification.median_noise, `${description} aggregate median`) -
                medianNoise) > 1e-12) ||
        (p90Noise === null
            ? qualification.p90_noise !== null
            : Math.abs(strictJsonNumber(
                qualification.p90_noise, `${description} aggregate p90`) -
                p90Noise) > 1e-12)) {
        throw new Error(`${description} aggregate verdict does not reproduce`);
    }
    return {
        validSupport,
        noNoticeable,
        medianNoise,
        p90Noise,
    };
}

function validateSourceNoiseBypassOutcomeV1Legacy(report, options) {
    const sourcePath = fs.realpathSync(options.sourcePath);
    const pipelinePath = fs.realpathSync(options.pipelinePath);
    const reasonCode = report && report.reason_code;
    const supportedReasons = new Set([
        NO_GRAIN_NO_NOTICEABLE_SOURCE_NOISE_REASON_CODE,
        NO_GRAIN_INSUFFICIENT_FLAT_SUPPORT_REASON_CODE,
    ]);
    const description = 'native source-noise grain outcome';
    if (!report || report.schema !== 1 || report.operation !== 'fit' ||
        report.outcome !== 'bypass' || !supportedReasons.has(reasonCode) ||
        report.production_action !== NO_GRAIN_PRODUCTION_ACTION) {
        throw new Error(`${description} has an unsupported disposition`);
    }
    if (!report.pipeline || report.pipeline.version !== PIPELINE_VERSION) {
        throw new Error(`${description} does not identify pipeline version ${PIPELINE_VERSION}`);
    }
    assertFullArtifactFingerprint(report.pipeline, pipelinePath, `${description} pipeline`);
    const currentFingerprint = sampledSourceFingerprint(sourcePath);
    assertFingerprint(
        report.input_identities && report.input_identities.source,
        currentFingerprint,
        `${description} source`
    );

    const settings = report.fit_settings;
    const expectedSettingFields = [
        'comparison_mode', 'purpose', 'denoise', 'scaling_gain', 'clip_seconds',
        'crop_size', 'crop_size_requested_maximum', 'crop_size_policy',
        'preroll_seconds', 'minimum_fit_regions', 'minimum_heldout_regions',
        'requested_minimum_heldout_regions', 'heldout_minimum_adapted',
        'source_noise_median_threshold_exclusive',
        'source_noise_p90_threshold_exclusive',
        'source_noise_minimum_valid_frames_per_region',
        'source_noise_required_valid_regions',
    ];
    if (!exactObjectFields(settings, expectedSettingFields)) {
        throw new Error(`${description} fit settings are malformed`);
    }
    const effectiveCrop = strictJsonInteger(
        settings.crop_size, `${description} effective crop size`);
    const requestedCrop = strictJsonInteger(
        settings.crop_size_requested_maximum, `${description} requested crop size`);
    if (settings.comparison_mode !== 'hqdn3d' ||
        settings.purpose !== 'source-denoise-grain-fit' ||
        settings.denoise !== DENOISE_FILTER ||
        strictJsonNumber(settings.scaling_gain, `${description} scaling gain`) !== 1 ||
        strictJsonNumber(settings.clip_seconds, `${description} clip seconds`) !==
            PRODUCTION_FIT_SETTINGS.clipSeconds ||
        strictJsonNumber(settings.preroll_seconds, `${description} preroll`) !==
            DENOISE_PREROLL_SECONDS ||
        requestedCrop !== PRODUCTION_FIT_SETTINGS.requestedCropMaximum ||
        settings.crop_size_policy !== CROP_SIZE_POLICY ||
        effectiveCrop < MINIMUM_PRODUCTION_CROP_SIZE ||
        effectiveCrop > requestedCrop || effectiveCrop % 2 !== 0 ||
        strictJsonInteger(
            settings.minimum_fit_regions, `${description} fit regions`) !== 4 ||
        strictJsonInteger(
            settings.minimum_heldout_regions, `${description} held-out regions`) !== 4 ||
        strictJsonInteger(
            settings.requested_minimum_heldout_regions,
            `${description} requested held-out regions`) !== 4 ||
        settings.heldout_minimum_adapted !== false ||
        strictJsonNumber(
            settings.source_noise_median_threshold_exclusive,
            `${description} median threshold`) !== SOURCE_NOISE_MEDIAN_THRESHOLD ||
        strictJsonNumber(
            settings.source_noise_p90_threshold_exclusive,
            `${description} p90 threshold`) !== SOURCE_NOISE_P90_THRESHOLD ||
        strictJsonInteger(
            settings.source_noise_minimum_valid_frames_per_region,
            `${description} minimum valid frames`) !==
            SOURCE_NOISE_MINIMUM_VALID_FRAMES_PER_REGION ||
        strictJsonInteger(
            settings.source_noise_required_valid_regions,
            `${description} required valid regions`) !==
            SOURCE_NOISE_REQUIRED_VALID_REGIONS) {
        throw new Error(`${description} fit settings do not match production`);
    }

    const evidence = report.evidence;
    const expectedEvidenceFields = [
        'advisory', 'source_grain_absence_proven', 'selection_exhausted',
        'source_fingerprint', 'comparison', 'media_profile', 'sampling', 'scan',
        'selected', 'calibration', 'heldout',
        'native_source_noise_qualification', 'crop_size',
        'minimum_heldout_regions', 'requested_minimum_heldout_regions',
        'heldout_minimum_adapted',
    ];
    if (!exactObjectFields(evidence, expectedEvidenceFields) ||
        evidence.advisory !== true ||
        evidence.source_grain_absence_proven !== false ||
        evidence.selection_exhausted !== true) {
        throw new Error(`${description} evidence is malformed`);
    }
    assertFingerprint(evidence.source_fingerprint, currentFingerprint, `${description} evidence source`);
    const comparison = evidence.comparison;
    if (!exactObjectFields(comparison, [
        'mode', 'purpose', 'denoise', 'denoiser_attestation',
    ]) || comparison.mode !== 'hqdn3d' ||
        comparison.purpose !== 'source-denoise-grain-fit' ||
        comparison.denoise !== DENOISE_FILTER) {
        throw new Error(`${description} comparison evidence is not authenticated`);
    }
    validateDenoiserAttestation(comparison.denoiser_attestation);

    const mediaProfile = evidence.media_profile;
    if (!exactObjectFields(mediaProfile, [
        'selected', 'transfer_family', 'signal_range', 'luma_bands',
    ]) || !['sdr', 'pq'].includes(mediaProfile.transfer_family) ||
        !['limited', 'full'].includes(mediaProfile.signal_range) ||
        !Array.isArray(mediaProfile.luma_bands) ||
        mediaProfile.luma_bands.length !== 4) {
        throw new Error(`${description} media profile is malformed`);
    }
    const lumaBands = mediaProfile.luma_bands.map((band, index) => {
        if (!Array.isArray(band) || band.length !== 2) {
            throw new Error(`${description} luma band ${index} is malformed`);
        }
        const low = strictJsonNumber(band[0], `${description} luma band ${index} low`);
        const high = strictJsonNumber(band[1], `${description} luma band ${index} high`);
        if (!(low >= 0 && low < high && high <= 256)) {
            throw new Error(`${description} luma band ${index} is invalid`);
        }
        return [low, high];
    });
    if (lumaBands.some((band, index) =>
        index > 0 && lumaBands[index - 1][1] > band[0])) {
        throw new Error(`${description} luma bands overlap`);
    }
    if (options.expectedProfile &&
        mediaProfile.transfer_family !== options.expectedProfile) {
        throw new Error(
            `${description} media profile changed from ${options.expectedProfile} ` +
            `to ${mediaProfile.transfer_family}`
        );
    }

    const selected = evidence.selected;
    const calibration = evidence.calibration;
    const heldout = evidence.heldout;
    if (![selected, calibration, heldout].every(
        (regions) => Array.isArray(regions) && regions.length === 4) ||
        strictJsonInteger(evidence.crop_size, `${description} evidence crop`) !==
            effectiveCrop ||
        strictJsonInteger(
            evidence.minimum_heldout_regions,
            `${description} evidence held-out regions`) !== 4 ||
        strictJsonInteger(
            evidence.requested_minimum_heldout_regions,
            `${description} evidence requested held-out regions`) !== 4 ||
        evidence.heldout_minimum_adapted !== false) {
        throw new Error(`${description} lacks frozen four-by-four region evidence`);
    }
    const expectedRegions = new Map();
    const expectedNoiseRegions = new Map();
    [
        [selected, 'fit'],
        [calibration, 'curve-calibration'],
        [heldout, 'final-validation'],
    ].forEach(([regions, role], setIndex) => regions.forEach((region, index) => {
        const identity = validateLowEnergyCandidate(
            region, PRODUCTION_FIT_SETTINGS, `${description} region ${setIndex}:${index}`);
        if (expectedRegions.has(identity)) {
            throw new Error(`${description} region sets overlap`);
        }
        const band = lumaBands[region.band_index];
        if (!band || region.mean_luma < band[0] || region.mean_luma > band[1]) {
            throw new Error(`${description} region falls outside its luma band`);
        }
        expectedRegions.set(identity, { role, region });
        if (role !== 'fit') expectedNoiseRegions.set(identity, { role, region });
    }));
    const selectedBands = new Set(selected.map((region) => region.band_index));
    if (selectedBands.size !== 4 ||
        ![0, 1, 2, 3].every((band) => selectedBands.has(band))) {
        throw new Error(`${description} fit regions do not cover every luma band`);
    }

    const sampling = evidence.sampling;
    if (!exactObjectFields(sampling, [
        'timestamps', 'skip_head_tail', 'scan_step', 'min_spacing', 'adjusted',
        'rationale', 'fit_spacing', 'observed_fit_spacing', 'heldout_spacing',
    ]) || !Array.isArray(sampling.timestamps) ||
        sampling.timestamps.length < MINIMUM_PROXY_TIMESTAMPS ||
        typeof sampling.adjusted !== 'boolean' ||
        typeof sampling.rationale !== 'string' || !sampling.rationale.trim()) {
        throw new Error(`${description} sampling evidence is malformed`);
    }
    const timestamps = sampling.timestamps.map((value, index) =>
        strictJsonNumber(value, `${description} timestamp ${index}`));
    const skipHeadTail = strictJsonNumber(
        sampling.skip_head_tail, `${description} head-tail exclusion`);
    const scanStep = strictJsonNumber(sampling.scan_step, `${description} scan step`);
    const plannedSpacing = strictJsonNumber(
        sampling.min_spacing, `${description} planned spacing`);
    const fitSpacing = strictJsonNumber(
        sampling.fit_spacing, `${description} fit spacing`);
    const observedFitSpacing = strictJsonNumber(
        sampling.observed_fit_spacing, `${description} observed fit spacing`);
    const heldoutSpacing = strictJsonNumber(
        sampling.heldout_spacing, `${description} held-out spacing`);
    if (skipHeadTail < 0 || !(scanStep > 0) || plannedSpacing < fitSpacing ||
        !(fitSpacing > 0) || observedFitSpacing < fitSpacing ||
        heldoutSpacing < PRODUCTION_FIT_SETTINGS.clipSeconds + DENOISE_PREROLL_SECONDS ||
        Math.abs(timestamps[0] - skipHeadTail) > 1e-12 ||
        timestamps.some((value, index) => value < 0 ||
            (index > 0 && (value <= timestamps[index - 1] ||
                Math.abs(value - timestamps[index - 1] - scanStep) > 1e-10)))) {
        throw new Error(`${description} sampling evidence is inconsistent`);
    }

    const scan = evidence.scan;
    if (!exactObjectFields(scan, ['attempted', 'successful', 'coverage', 'failures']) ||
        !Array.isArray(scan.failures)) {
        throw new Error(`${description} scan evidence is malformed`);
    }
    const attempted = strictJsonInteger(scan.attempted, `${description} scan attempts`);
    const successful = strictJsonInteger(scan.successful, `${description} successful scans`);
    const coverage = strictJsonNumber(scan.coverage, `${description} scan coverage`);
    const failedIndexes = new Set();
    scan.failures.forEach((failure, index) => {
        if (!exactObjectFields(failure, ['index', 'timestamp', 'error'])) {
            throw new Error(`${description} scan failure ${index} is malformed`);
        }
        const failureIndex = strictJsonInteger(
            failure.index, `${description} scan failure ${index} index`);
        const failureTimestamp = strictJsonNumber(
            failure.timestamp, `${description} scan failure ${index} timestamp`);
        if (failedIndexes.has(failureIndex) ||
            failureIndex < 0 || failureIndex >= timestamps.length ||
            Math.abs(failureTimestamp - timestamps[failureIndex]) > 1e-12 ||
            typeof failure.error !== 'string' || !failure.error.trim()) {
            throw new Error(`${description} scan failure ${index} is inconsistent`);
        }
        failedIndexes.add(failureIndex);
    });
    if (attempted !== timestamps.length ||
        successful !== attempted - scan.failures.length ||
        Math.abs(coverage - successful / attempted) > 1e-12 ||
        coverage < PRODUCTION_FIT_SETTINGS.minimumScanCoverage) {
        throw new Error(`${description} scan coverage does not reproduce`);
    }
    const successfulTimestamps = new Set(
        timestamps.filter((_timestamp, index) => !failedIndexes.has(index)));
    if ([...expectedRegions.values()].some(
        ({ region }) => !successfulTimestamps.has(region.timestamp))) {
        throw new Error(`${description} selected a failed proxy timestamp`);
    }
    const actualFitSpacing = Math.min(...selected.flatMap((left, index) =>
        selected.slice(index + 1).map(
            (right) => Math.abs(left.timestamp - right.timestamp))));
    const allRegions = [...selected, ...calibration, ...heldout];
    if (Math.abs(observedFitSpacing - actualFitSpacing) > 1e-12 ||
        allRegions.some((left, index) => allRegions.slice(index + 1).some(
            (right) => Math.abs(left.timestamp - right.timestamp) < heldoutSpacing))) {
        throw new Error(`${description} region spacing does not reproduce`);
    }

    const qualification = validateSourceNoiseQualificationV1Legacy(
        evidence.native_source_noise_qualification,
        expectedNoiseRegions,
        effectiveCrop,
        description
    );
    if (reasonCode === NO_GRAIN_NO_NOTICEABLE_SOURCE_NOISE_REASON_CODE) {
        if (!qualification.validSupport || !qualification.noNoticeable) {
            throw new Error(`${description} no-noise verdict does not reproduce`);
        }
    } else if (qualification.validSupport || qualification.noNoticeable) {
        throw new Error(`${description} insufficient-support verdict does not reproduce`);
    }

    const requested = report.requested_outputs;
    if (!exactObjectFields(requested, ['table', 'manifest', 'artifacts_published']) ||
        requested.artifacts_published !== false ||
        path.resolve(String(requested.table || '')) !==
            path.resolve(String(options.tablePath || '')) ||
        path.resolve(String(requested.manifest || '')) !==
            path.resolve(String(options.manifestPath || '')) ||
        fs.existsSync(options.tablePath) || fs.existsSync(options.manifestPath)) {
        throw new Error(`${description} published or mismatched forbidden grain artifacts`);
    }
    return {
        currentFingerprint,
        transferFamily: mediaProfile.transfer_family,
        reasonCode,
    };
}

function sourceNoiseClose(left, right, tolerance = 1e-12) {
    return typeof left === 'number' && Number.isFinite(left) &&
        typeof right === 'number' && Number.isFinite(right) &&
        Math.abs(left - right) <= tolerance;
}

function validateSourceNoiseFrameV2(frame, expectedWidth, expectedHeight, description) {
    if (!exactObjectFields(frame, [
        'schema', 'method', 'width', 'height', 'max_value', 'pixel_sha256',
        'edge_threshold_exclusive', 'minimum_smooth_pixels',
        'smooth_pixel_count', 'laplacian_absolute_sum', 'estimate',
    ])) {
        throw new Error(`${description} is malformed`);
    }
    const width = strictJsonInteger(frame.width, `${description} width`);
    const height = strictJsonInteger(frame.height, `${description} height`);
    const smoothCount = strictJsonInteger(
        frame.smooth_pixel_count, `${description} smooth count`);
    const laplacianSum = strictJsonInteger(
        frame.laplacian_absolute_sum, `${description} Laplacian sum`);
    if (strictJsonInteger(frame.schema, `${description} schema`) !== 1 ||
        frame.method !== SOURCE_NOISE_ESTIMATOR_METHOD ||
        width !== expectedWidth || height !== expectedHeight ||
        strictJsonInteger(frame.max_value, `${description} maximum`) !== 255 ||
        strictJsonInteger(
            frame.edge_threshold_exclusive, `${description} edge threshold`) !==
            SOURCE_NOISE_EDGE_THRESHOLD ||
        strictJsonInteger(
            frame.minimum_smooth_pixels, `${description} minimum smooth pixels`) !==
            SOURCE_NOISE_MINIMUM_SMOOTH_PIXELS ||
        smoothCount < 0 ||
        smoothCount > Math.max(0, width - 2) * Math.max(0, height - 2) ||
        laplacianSum < 0 || !Number.isSafeInteger(laplacianSum) ||
        typeof frame.pixel_sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(frame.pixel_sha256)) {
        throw new Error(`${description} violates the estimator contract`);
    }
    if (smoothCount < SOURCE_NOISE_MINIMUM_SMOOTH_PIXELS) {
        if (frame.estimate !== null) {
            throw new Error(`${description} reports an estimate without smooth support`);
        }
        return null;
    }
    const estimate = strictJsonNumber(frame.estimate, `${description} estimate`);
    const expected = laplacianSum / (6 * smoothCount) * Math.sqrt(Math.PI / 2);
    if (estimate < 0 || !sourceNoiseClose(estimate, expected)) {
        throw new Error(`${description} estimate does not reproduce`);
    }
    return estimate;
}

function sourceNoiseFlatnessScore(candidate) {
    return candidate.edge_density +
        0.05 * candidate.temporal_luma_stddev +
        0.01 * candidate.spatial_luma_stddev +
        10.0 * candidate.extreme_pixel_fraction;
}

function compareSourceNoiseCandidates(left, right, targetBand, center) {
    const leftTarget = left.band_index === targetBand ? 0 : 1;
    const rightTarget = right.band_index === targetBand ? 0 : 1;
    if (leftTarget !== rightTarget) return leftTarget - rightTarget;
    const flatness = sourceNoiseFlatnessScore(left) - sourceNoiseFlatnessScore(right);
    if (flatness !== 0) return flatness;
    const distance = Math.abs(left.timestamp - center) -
        Math.abs(right.timestamp - center);
    if (distance !== 0) return distance;
    return compareIdentityValues(
        candidateIdentityValues(left), candidateIdentityValues(right));
}

function validateSourceNoiseStratificationV2(
    stratification,
    timestamps,
    successfulTimestamps,
    lumaBands,
    description
) {
    if (!exactObjectFields(stratification, [
        'schema', 'method', 'scene_proxy_contract', 'ranking_method',
        'candidate_pool_count', 'maximum_attempts_per_bin',
        'successful_proxy_count_by_bin', 'operational_coverage_valid',
        'bin_count', 'timeline_start_seconds', 'timeline_end_seconds',
        'timeline_span_seconds', 'bin_width_seconds', 'required_populated_bins',
        'populated_bin_count', 'bin_coverage_fraction', 'required_luma_bands',
        'represented_luma_bands', 'minimum_selected_span_fraction',
        'selected_span_fraction', 'coverage_valid', 'bins',
    ]) || strictJsonInteger(stratification.schema, `${description} schema`) !== 1 ||
        stratification.method !== SOURCE_NOISE_STRATIFICATION_METHOD ||
        stratification.scene_proxy_contract !==
            'rank-all-successful-proxy-flat-crops-per-duration-bin-target-luma-band-first-v1' ||
        stratification.ranking_method !==
            'target-band-flatness-center-distance-candidate-identity-v1' ||
        strictJsonInteger(
            stratification.maximum_attempts_per_bin,
            `${description} maximum attempts`) !==
            SOURCE_NOISE_MAXIMUM_ATTEMPTS_PER_BIN ||
        strictJsonInteger(stratification.bin_count, `${description} bin count`) !==
            SOURCE_NOISE_TEMPORAL_BIN_COUNT ||
        strictJsonInteger(
            stratification.required_populated_bins,
            `${description} required populated bins`) !==
            SOURCE_NOISE_TEMPORAL_BIN_COUNT ||
        JSON.stringify(stratification.required_luma_bands) !==
            JSON.stringify(lumaBands.map((_band, index) => index)) ||
        !Array.isArray(stratification.bins) ||
        stratification.bins.length !== SOURCE_NOISE_TEMPORAL_BIN_COUNT) {
        throw new Error(`${description} policy is malformed`);
    }
    const timelineStart = timestamps[0];
    const timelineEnd = timestamps[timestamps.length - 1];
    const timelineSpan = timelineEnd - timelineStart;
    const binWidth = timelineSpan / SOURCE_NOISE_TEMPORAL_BIN_COUNT;
    if (!(timelineSpan > 0) ||
        !sourceNoiseClose(
            strictJsonNumber(
                stratification.timeline_start_seconds, `${description} timeline start`),
            timelineStart) ||
        !sourceNoiseClose(
            strictJsonNumber(
                stratification.timeline_end_seconds, `${description} timeline end`),
            timelineEnd) ||
        !sourceNoiseClose(
            strictJsonNumber(
                stratification.timeline_span_seconds, `${description} timeline span`),
            timelineSpan) ||
        !sourceNoiseClose(
            strictJsonNumber(
                stratification.bin_width_seconds, `${description} bin width`),
            binWidth)) {
        throw new Error(`${description} timeline does not reproduce`);
    }

    const successfulCounts = Array(SOURCE_NOISE_TEMPORAL_BIN_COUNT).fill(0);
    successfulTimestamps.forEach((timestamp) => {
        const index = Math.min(
            SOURCE_NOISE_TEMPORAL_BIN_COUNT - 1,
            Math.floor((timestamp - timelineStart) / binWidth));
        successfulCounts[index] += 1;
    });
    const operationalCoverage = successfulCounts.every((count) => count > 0);
    if (JSON.stringify(stratification.successful_proxy_count_by_bin) !==
            JSON.stringify(successfulCounts) ||
        stratification.operational_coverage_valid !== operationalCoverage ||
        !operationalCoverage) {
        throw new Error(`${description} lacks operational proxy-bin coverage`);
    }

    const identities = new Set();
    const rankedByBin = new Map();
    const primaryCandidates = [];
    let candidatePoolCount = 0;
    stratification.bins.forEach((bin, binIndex) => {
        const binDescription = `${description} bin ${binIndex}`;
        if (!exactObjectFields(bin, [
            'bin_index', 'start_seconds', 'end_seconds', 'target_luma_band',
            'status', 'candidate_count', 'ranked_candidates',
        ])) {
            throw new Error(`${binDescription} is malformed`);
        }
        const expectedStart = timelineStart + binIndex * binWidth;
        const expectedEnd = binIndex === SOURCE_NOISE_TEMPORAL_BIN_COUNT - 1
            ? timelineEnd : expectedStart + binWidth;
        const targetBand = binIndex % lumaBands.length;
        if (strictJsonInteger(bin.bin_index, `${binDescription} index`) !== binIndex ||
            !sourceNoiseClose(
                strictJsonNumber(bin.start_seconds, `${binDescription} start`),
                expectedStart) ||
            !sourceNoiseClose(
                strictJsonNumber(bin.end_seconds, `${binDescription} end`),
                expectedEnd) ||
            strictJsonInteger(
                bin.target_luma_band, `${binDescription} target band`) !== targetBand ||
            !Array.isArray(bin.ranked_candidates) ||
            strictJsonInteger(
                bin.candidate_count, `${binDescription} candidate count`) !==
                bin.ranked_candidates.length) {
            throw new Error(`${binDescription} boundaries or counts changed`);
        }
        if (bin.ranked_candidates.length === 0) {
            if (bin.status !== 'missing') {
                throw new Error(`${binDescription} missing status is inconsistent`);
            }
            return;
        }
        if (bin.status !== 'ranked') {
            throw new Error(`${binDescription} ranked status is inconsistent`);
        }
        const checked = bin.ranked_candidates.map((entry, rankIndex) => {
            const rankDescription = `${binDescription} candidate ${rankIndex + 1}`;
            if (!exactObjectFields(entry, ['rank', 'candidate']) ||
                strictJsonInteger(entry.rank, `${rankDescription} rank`) !== rankIndex + 1) {
                throw new Error(`${rankDescription} rank is malformed`);
            }
            const candidate = entry.candidate;
            const identity = validateLowEnergyCandidate(
                candidate, PRODUCTION_FIT_SETTINGS, rankDescription);
            const band = lumaBands[candidate.band_index];
            const inLastBin = binIndex === SOURCE_NOISE_TEMPORAL_BIN_COUNT - 1
                ? candidate.timestamp <= expectedEnd
                : candidate.timestamp < expectedEnd;
            if (!band || candidate.mean_luma < band[0] || candidate.mean_luma > band[1] ||
                candidate.timestamp < expectedStart || !inLastBin ||
                !successfulTimestamps.has(candidate.timestamp) || identities.has(identity)) {
                throw new Error(`${rankDescription} is not independent, successful, and in-bin`);
            }
            identities.add(identity);
            return candidate;
        });
        const expectedOrder = [...checked].sort(
            (left, right) => compareSourceNoiseCandidates(
                left, right, targetBand, (expectedStart + expectedEnd) / 2));
        if (checked.some((candidate, index) =>
            !strictRegionEvidenceMatches(candidate, expectedOrder[index]))) {
            throw new Error(`${binDescription} candidate ranks do not reproduce`);
        }
        rankedByBin.set(binIndex, checked);
        primaryCandidates.push(checked[0]);
        candidatePoolCount += checked.length;
    });

    const represented = [...new Set(
        primaryCandidates.map((candidate) => candidate.band_index))].sort((a, b) => a - b);
    const selectedSpan = primaryCandidates.length >= 2
        ? (Math.max(...primaryCandidates.map((candidate) => candidate.timestamp)) -
            Math.min(...primaryCandidates.map((candidate) => candidate.timestamp))) /
            timelineSpan
        : 0;
    const populated = primaryCandidates.length;
    const coverageValid = populated === SOURCE_NOISE_TEMPORAL_BIN_COUNT &&
        represented.length === lumaBands.length &&
        lumaBands.every((_band, index) => represented.includes(index)) &&
        selectedSpan >= SOURCE_NOISE_MINIMUM_SELECTED_SPAN_FRACTION;
    if (strictJsonInteger(
        stratification.candidate_pool_count, `${description} candidate pool count`) !==
            candidatePoolCount ||
        strictJsonInteger(
            stratification.populated_bin_count, `${description} populated bins`) !==
            populated ||
        !sourceNoiseClose(
            strictJsonNumber(
                stratification.bin_coverage_fraction, `${description} bin coverage`),
            populated / SOURCE_NOISE_TEMPORAL_BIN_COUNT) ||
        JSON.stringify(stratification.represented_luma_bands) !==
            JSON.stringify(represented) ||
        !sourceNoiseClose(
            strictJsonNumber(
                stratification.minimum_selected_span_fraction,
                `${description} minimum selected span`),
            SOURCE_NOISE_MINIMUM_SELECTED_SPAN_FRACTION) ||
        !sourceNoiseClose(
            strictJsonNumber(
                stratification.selected_span_fraction, `${description} selected span`),
            selectedSpan) ||
        stratification.coverage_valid !== coverageValid) {
        throw new Error(`${description} aggregate coverage does not reproduce`);
    }
    return { rankedByBin, coverageValid };
}

function validateSourceNoiseQualificationV2(
    qualification,
    rankedByBin,
    cropSize,
    requiredLumaBands,
    description
) {
    if (!exactObjectFields(qualification, [
        'schema', 'method', 'estimator', 'render',
        'minimum_valid_frames_per_region', 'maximum_attempts_per_bin',
        'required_valid_regions', 'required_temporal_bins', 'required_luma_bands',
        'selected_luma_bands', 'luma_coverage_valid', 'aggregation',
        'plane_thresholds_exclusive', 'chroma_threshold_status',
        'attempted_region_count', 'rejected_candidate_count',
        'exhausted_bin_indexes', 'valid_region_count', 'quiet_region_count',
        'valid_support', 'plane_aggregates', 'no_noticeable_noise', 'regions',
    ])) {
        throw new Error(`${description} qualification is malformed`);
    }
    const render = qualification.render;
    if (!exactObjectFields(render, [
        'source_planes', 'pixel_format', 'spatial_resolution',
        'numeric_normalization', 'pixel_hash_role', 'source_bit_depth',
        'right_shift_bits', 'prequantization_step',
        'chroma_subsampling_log2', 'denoised', 'frames_per_region',
    ])) {
        throw new Error(`${description} render evidence is malformed`);
    }
    const sourcePlanes = Array.isArray(render.source_planes)
        ? render.source_planes : [];
    const planeSetValid = JSON.stringify(sourcePlanes) === JSON.stringify(['y']) ||
        JSON.stringify(sourcePlanes) === JSON.stringify(SOURCE_NOISE_PLANES);
    const subsampling = render.chroma_subsampling_log2;
    const sourceBitDepth = strictJsonInteger(
        render.source_bit_depth, `${description} source bit depth`);
    const rightShift = strictJsonInteger(
        render.right_shift_bits, `${description} right shift`);
    const expectedChromaStatus = sourcePlanes.length === 1
        ? SOURCE_NOISE_MONOCHROME_THRESHOLD_STATUS
        : SOURCE_NOISE_CHROMA_THRESHOLD_STATUS;
    if (strictJsonInteger(qualification.schema, `${description} schema`) !== 1 ||
        qualification.method !== SOURCE_NOISE_QUALIFICATION_METHOD ||
        qualification.estimator !== SOURCE_NOISE_ESTIMATOR_METHOD ||
        !planeSetValid || render.pixel_format !== 'gray8' ||
        render.spatial_resolution !== 'native-plane-crops-no-downscale' ||
        render.numeric_normalization !== SOURCE_NOISE_GRAY8_NORMALIZATION ||
        render.pixel_hash_role !==
            'decoded-plane-integrity-evidence-under-pinned-toolchain-v1' ||
        sourceBitDepth < 8 || sourceBitDepth > 16 ||
        rightShift !== sourceBitDepth - 8 ||
        strictJsonInteger(
            render.prequantization_step, `${description} prequantization step`) !==
            2 ** rightShift ||
        !Array.isArray(subsampling) || subsampling.length !== 2 ||
        subsampling.some((value) => !Number.isInteger(value) || ![0, 1].includes(value)) ||
        (sourcePlanes.length === 1 && JSON.stringify(subsampling) !== '[0,0]') ||
        render.denoised !== false ||
        strictJsonInteger(
            render.frames_per_region, `${description} frames per region`) !==
            SOURCE_NOISE_RENDERED_FRAMES_PER_REGION ||
        strictJsonInteger(
            qualification.minimum_valid_frames_per_region,
            `${description} minimum valid frames`) !==
            SOURCE_NOISE_MINIMUM_VALID_FRAMES_PER_REGION ||
        strictJsonInteger(
            qualification.maximum_attempts_per_bin,
            `${description} maximum attempts`) !==
            SOURCE_NOISE_MAXIMUM_ATTEMPTS_PER_BIN ||
        strictJsonInteger(
            qualification.required_valid_regions,
            `${description} required valid regions`) !==
            SOURCE_NOISE_REQUIRED_VALID_REGIONS ||
        strictJsonInteger(
            qualification.required_temporal_bins,
            `${description} required temporal bins`) !==
            SOURCE_NOISE_TEMPORAL_BIN_COUNT ||
        JSON.stringify(qualification.required_luma_bands) !==
            JSON.stringify(requiredLumaBands) ||
        qualification.aggregation !==
            'per-plane-frame-median-and-nearest-rank-p90-v2' ||
        qualification.chroma_threshold_status !== expectedChromaStatus) {
        throw new Error(`${description} qualification policy is inconsistent`);
    }
    const thresholds = qualification.plane_thresholds_exclusive;
    if (!exactObjectFields(thresholds, sourcePlanes) ||
        sourcePlanes.some((plane) => {
            const threshold = thresholds[plane];
            return !exactObjectFields(threshold, ['median', 'p90']) ||
                strictJsonNumber(
                    threshold.median, `${description} ${plane} median threshold`) !==
                    SOURCE_NOISE_MEDIAN_THRESHOLD ||
                strictJsonNumber(
                    threshold.p90, `${description} ${plane} p90 threshold`) !==
                    SOURCE_NOISE_P90_THRESHOLD;
        })) {
        throw new Error(`${description} plane thresholds are malformed`);
    }
    if (!Array.isArray(qualification.regions) ||
        qualification.regions.length >
            SOURCE_NOISE_TEMPORAL_BIN_COUNT * SOURCE_NOISE_MAXIMUM_ATTEMPTS_PER_BIN) {
        throw new Error(`${description} attempt records are malformed`);
    }
    const geometry = {
        y: [cropSize, cropSize],
        u: [cropSize >> subsampling[0], cropSize >> subsampling[1]],
        v: [cropSize >> subsampling[0], cropSize >> subsampling[1]],
    };
    [...rankedByBin.values()].flat().forEach((candidate) => {
        if (candidate.x % (2 ** subsampling[0]) !== 0 ||
            candidate.y % (2 ** subsampling[1]) !== 0 ||
            cropSize % (2 ** subsampling[0]) !== 0 ||
            cropSize % (2 ** subsampling[1]) !== 0) {
            throw new Error(`${description} candidate is not chroma aligned`);
        }
    });

    const observed = new Set();
    let previousKey = null;
    const results = qualification.regions.map((record, index) => {
        const recordDescription = `${description} attempt ${index}`;
        if (!exactObjectFields(record, [
            'bin_index', 'candidate_rank', 'candidate', 'valid', 'quiet',
            'selected', 'planes',
        ])) {
            throw new Error(`${recordDescription} is malformed`);
        }
        const binIndex = strictJsonInteger(
            record.bin_index, `${recordDescription} bin`);
        const candidateRank = strictJsonInteger(
            record.candidate_rank, `${recordDescription} candidate rank`);
        const planned = rankedByBin.get(binIndex);
        if (!planned || candidateRank < 1 ||
            candidateRank > Math.min(
                planned.length, SOURCE_NOISE_MAXIMUM_ATTEMPTS_PER_BIN) ||
            !strictRegionEvidenceMatches(record.candidate, planned[candidateRank - 1])) {
            throw new Error(`${recordDescription} candidate is unplanned`);
        }
        const key = `${String(binIndex).padStart(3, '0')}|${String(candidateRank).padStart(3, '0')}`;
        if (observed.has(key) || (previousKey !== null && key <= previousKey)) {
            throw new Error(`${recordDescription} order or identity is invalid`);
        }
        observed.add(key);
        previousKey = key;
        if (!exactObjectFields(record.planes, sourcePlanes)) {
            throw new Error(`${recordDescription} lacks every present plane`);
        }
        const planeResults = {};
        sourcePlanes.forEach((plane) => {
            const planeRecord = record.planes[plane];
            const planeDescription = `${recordDescription} ${plane}`;
            if (!exactObjectFields(planeRecord, [
                'rendered_frame_count', 'valid_frame_count', 'valid',
                'median_noise', 'p90_noise', 'quiet', 'frames',
            ]) || !Array.isArray(planeRecord.frames) ||
                strictJsonInteger(
                    planeRecord.rendered_frame_count,
                    `${planeDescription} rendered frames`) !==
                    SOURCE_NOISE_RENDERED_FRAMES_PER_REGION ||
                planeRecord.frames.length !== SOURCE_NOISE_RENDERED_FRAMES_PER_REGION) {
                throw new Error(`${planeDescription} frame evidence is malformed`);
            }
            const estimates = planeRecord.frames.map((frame, frameIndex) =>
                validateSourceNoiseFrameV2(
                    frame, geometry[plane][0], geometry[plane][1],
                    `${planeDescription} frame ${frameIndex}`));
            const numeric = estimates.filter((value) => value !== null);
            const valid = numeric.length >= SOURCE_NOISE_MINIMUM_VALID_FRAMES_PER_REGION;
            const median = valid
                ? sourceNoiseMedian(numeric, `${planeDescription} median`) : null;
            const p90 = valid
                ? sourceNoiseNearestRank(numeric, 0.90, `${planeDescription} p90`) : null;
            const quiet = valid && median < SOURCE_NOISE_MEDIAN_THRESHOLD &&
                p90 < SOURCE_NOISE_P90_THRESHOLD;
            if (strictJsonInteger(
                planeRecord.valid_frame_count, `${planeDescription} valid frames`) !==
                    numeric.length ||
                planeRecord.valid !== valid || planeRecord.quiet !== quiet ||
                (median === null
                    ? planeRecord.median_noise !== null
                    : !sourceNoiseClose(
                        strictJsonNumber(
                            planeRecord.median_noise, `${planeDescription} median`),
                        median)) ||
                (p90 === null
                    ? planeRecord.p90_noise !== null
                    : !sourceNoiseClose(
                        strictJsonNumber(
                            planeRecord.p90_noise, `${planeDescription} p90`),
                        p90))) {
                throw new Error(`${planeDescription} verdict does not reproduce`);
            }
            planeResults[plane] = { valid, quiet, median };
        });
        const valid = sourcePlanes.every((plane) => planeResults[plane].valid);
        const quiet = valid && sourcePlanes.every((plane) => planeResults[plane].quiet);
        if (record.valid !== valid || record.quiet !== quiet ||
            typeof record.selected !== 'boolean') {
            throw new Error(`${recordDescription} aggregate does not reproduce`);
        }
        return {
            binIndex,
            candidateRank,
            candidate: record.candidate,
            valid,
            quiet,
            recordedSelected: record.selected,
            planes: planeResults,
        };
    });

    const selected = [];
    const exhaustedBins = [];
    [...rankedByBin.entries()].sort((left, right) => left[0] - right[0])
        .forEach(([binIndex, planned]) => {
            const attempts = results.filter((result) => result.binIndex === binIndex);
            if (attempts.some((result, index) => result.candidateRank !== index + 1)) {
                throw new Error(`${description} bin ${binIndex} attempts are not contiguous`);
            }
            const firstValid = attempts.find((result) => result.valid);
            if (firstValid) {
                if (attempts[attempts.length - 1] !== firstValid ||
                    attempts.some((result) =>
                        result.recordedSelected !== (result === firstValid))) {
                    throw new Error(
                        `${description} bin ${binIndex} did not stop at first valid fallback`);
                }
                selected.push(firstValid);
            } else {
                const expectedAttempts = Math.min(
                    planned.length, SOURCE_NOISE_MAXIMUM_ATTEMPTS_PER_BIN);
                if (attempts.length !== expectedAttempts ||
                    attempts.some((result) => result.recordedSelected !== false)) {
                    throw new Error(`${description} bin ${binIndex} exhaustion is incomplete`);
                }
                exhaustedBins.push(binIndex);
            }
        });
    const quietSelected = selected.filter((result) => result.quiet);
    const selectedBands = [...new Set(
        selected.map((result) => result.candidate.band_index))].sort((a, b) => a - b);
    const lumaCoverage = JSON.stringify(selectedBands) === JSON.stringify(requiredLumaBands);
    const validSupport = selected.length === SOURCE_NOISE_REQUIRED_VALID_REGIONS &&
        selected.every((result, index) => result.binIndex === index) && lumaCoverage;
    if (!exactObjectFields(qualification.plane_aggregates, sourcePlanes)) {
        throw new Error(`${description} plane aggregates are malformed`);
    }
    const aggregateQuiet = {};
    sourcePlanes.forEach((plane) => {
        const aggregate = qualification.plane_aggregates[plane];
        const aggregateDescription = `${description} ${plane} aggregate`;
        if (!exactObjectFields(aggregate, [
            'valid_region_count', 'median_noise', 'p90_noise', 'quiet',
        ])) {
            throw new Error(`${aggregateDescription} is malformed`);
        }
        const values = selected.map((result) => result.planes[plane].median);
        const median = validSupport
            ? sourceNoiseMedian(values, `${aggregateDescription} median`) : null;
        const p90 = validSupport
            ? sourceNoiseNearestRank(values, 0.90, `${aggregateDescription} p90`) : null;
        const quiet = validSupport && median < SOURCE_NOISE_MEDIAN_THRESHOLD &&
            p90 < SOURCE_NOISE_P90_THRESHOLD;
        if (strictJsonInteger(
            aggregate.valid_region_count, `${aggregateDescription} valid count`) !==
                values.length ||
            aggregate.quiet !== quiet ||
            (median === null
                ? aggregate.median_noise !== null
                : !sourceNoiseClose(
                    strictJsonNumber(
                        aggregate.median_noise, `${aggregateDescription} median`),
                    median)) ||
            (p90 === null
                ? aggregate.p90_noise !== null
                : !sourceNoiseClose(
                    strictJsonNumber(
                        aggregate.p90_noise, `${aggregateDescription} p90`),
                    p90))) {
            throw new Error(`${aggregateDescription} does not reproduce`);
        }
        aggregateQuiet[plane] = quiet;
    });
    const noNoticeable = validSupport &&
        quietSelected.length === SOURCE_NOISE_REQUIRED_VALID_REGIONS &&
        sourcePlanes.every((plane) => aggregateQuiet[plane]);
    if (strictJsonInteger(
        qualification.attempted_region_count, `${description} attempted count`) !==
            results.length ||
        strictJsonInteger(
            qualification.rejected_candidate_count, `${description} rejected count`) !==
            results.length - selected.length ||
        JSON.stringify(qualification.exhausted_bin_indexes) !==
            JSON.stringify(exhaustedBins) ||
        JSON.stringify(qualification.selected_luma_bands) !==
            JSON.stringify(selectedBands) ||
        qualification.luma_coverage_valid !== lumaCoverage ||
        strictJsonInteger(
            qualification.valid_region_count, `${description} valid count`) !==
            selected.length ||
        strictJsonInteger(
            qualification.quiet_region_count, `${description} quiet count`) !==
            quietSelected.length ||
        qualification.valid_support !== validSupport ||
        qualification.no_noticeable_noise !== noNoticeable) {
        throw new Error(`${description} aggregate verdict does not reproduce`);
    }
    return {
        validSupport,
        noNoticeable,
        exhaustedBins,
        sourcePlanes,
        chromaThresholdStatus: expectedChromaStatus,
    };
}

function validateSourceNoiseBypassOutcome(report, options) {
    const description = 'duration-stratified native source-noise grain outcome';
    const reasonCode = report && report.reason_code;
    if (!report || report.schema !== 1 || report.operation !== 'fit' ||
        report.outcome !== 'bypass' ||
        !new Set([
            NO_GRAIN_NO_NOTICEABLE_SOURCE_NOISE_REASON_CODE,
            NO_GRAIN_INSUFFICIENT_FLAT_SUPPORT_REASON_CODE,
        ]).has(reasonCode) ||
        report.production_action !== NO_GRAIN_PRODUCTION_ACTION ||
        !report.pipeline || report.pipeline.version !== PIPELINE_VERSION) {
        throw new Error(`${description} has an unsupported disposition`);
    }
    const sourcePath = fs.realpathSync(options.sourcePath);
    const pipelinePath = fs.realpathSync(options.pipelinePath);
    assertFullArtifactFingerprint(report.pipeline, pipelinePath, `${description} pipeline`);
    const currentFingerprint = sampledSourceFingerprint(sourcePath);
    assertFingerprint(
        report.input_identities && report.input_identities.source,
        currentFingerprint,
        `${description} source`);

    const settings = report.fit_settings;
    if (!exactObjectFields(settings, [
        'comparison_mode', 'purpose', 'denoised', 'clip_seconds', 'crop_size',
        'crop_size_requested_maximum', 'crop_size_policy',
        'source_noise_stratification_method', 'source_noise_temporal_bin_count',
        'source_noise_minimum_selected_span_fraction',
        'source_noise_estimator_method', 'source_noise_qualification_method',
        'source_noise_planes', 'source_noise_median_threshold_exclusive',
        'source_noise_p90_threshold_exclusive',
        'source_noise_minimum_valid_frames_per_region',
        'source_noise_required_valid_regions',
        'source_noise_chroma_threshold_status',
    ])) {
        throw new Error(`${description} fit settings are malformed`);
    }
    const effectiveCrop = strictJsonInteger(
        settings.crop_size, `${description} effective crop`);
    const requestedCrop = strictJsonInteger(
        settings.crop_size_requested_maximum, `${description} requested crop`);
    if (settings.comparison_mode !== SOURCE_NOISE_COMPARISON_MODE ||
        settings.purpose !== SOURCE_NOISE_PURPOSE || settings.denoised !== false ||
        strictJsonNumber(settings.clip_seconds, `${description} clip seconds`) !==
            PRODUCTION_FIT_SETTINGS.clipSeconds ||
        requestedCrop !== PRODUCTION_FIT_SETTINGS.requestedCropMaximum ||
        settings.crop_size_policy !== CROP_SIZE_POLICY ||
        effectiveCrop < MINIMUM_PRODUCTION_CROP_SIZE ||
        effectiveCrop > requestedCrop || effectiveCrop % 2 !== 0 ||
        settings.source_noise_stratification_method !==
            SOURCE_NOISE_STRATIFICATION_METHOD ||
        strictJsonInteger(
            settings.source_noise_temporal_bin_count,
            `${description} temporal bins`) !== SOURCE_NOISE_TEMPORAL_BIN_COUNT ||
        strictJsonNumber(
            settings.source_noise_minimum_selected_span_fraction,
            `${description} minimum selected span`) !==
            SOURCE_NOISE_MINIMUM_SELECTED_SPAN_FRACTION ||
        settings.source_noise_estimator_method !== SOURCE_NOISE_ESTIMATOR_METHOD ||
        settings.source_noise_qualification_method !==
            SOURCE_NOISE_QUALIFICATION_METHOD ||
        strictJsonNumber(
            settings.source_noise_median_threshold_exclusive,
            `${description} median threshold`) !== SOURCE_NOISE_MEDIAN_THRESHOLD ||
        strictJsonNumber(
            settings.source_noise_p90_threshold_exclusive,
            `${description} p90 threshold`) !== SOURCE_NOISE_P90_THRESHOLD ||
        strictJsonInteger(
            settings.source_noise_minimum_valid_frames_per_region,
            `${description} minimum valid frames`) !==
            SOURCE_NOISE_MINIMUM_VALID_FRAMES_PER_REGION ||
        strictJsonInteger(
            settings.source_noise_required_valid_regions,
            `${description} required valid regions`) !==
            SOURCE_NOISE_REQUIRED_VALID_REGIONS) {
        throw new Error(`${description} fit settings do not match production`);
    }

    const evidence = report.evidence;
    if (!exactObjectFields(evidence, [
        'advisory', 'source_grain_absence_proven', 'selection_exhausted',
        'attempt_limit_reached', 'policy_exhausted', 'source_fingerprint',
        'comparison', 'media_profile', 'sampling', 'scan', 'decode_tool_versions',
        'source_noise_stratification', 'native_source_noise_qualification',
        'crop_size',
    ]) || evidence.advisory !== true ||
        evidence.source_grain_absence_proven !== false ||
        typeof evidence.selection_exhausted !== 'boolean' ||
        typeof evidence.attempt_limit_reached !== 'boolean' ||
        typeof evidence.policy_exhausted !== 'boolean') {
        throw new Error(`${description} evidence is malformed`);
    }
    assertFingerprint(
        evidence.source_fingerprint, currentFingerprint, `${description} evidence source`);
    if (!exactObjectFields(evidence.comparison, ['mode', 'purpose', 'denoised']) ||
        evidence.comparison.mode !== SOURCE_NOISE_COMPARISON_MODE ||
        evidence.comparison.purpose !== SOURCE_NOISE_PURPOSE ||
        evidence.comparison.denoised !== false) {
        throw new Error(`${description} comparison is not source-only`);
    }
    if (!exactObjectFields(evidence.decode_tool_versions, ['ffmpeg', 'ffprobe']) ||
        Object.values(evidence.decode_tool_versions).some(
            (value) => typeof value !== 'string' || !value.trim())) {
        throw new Error(`${description} decode tool versions are malformed`);
    }
    const mediaProfile = evidence.media_profile;
    if (!exactObjectFields(mediaProfile, [
        'selected', 'transfer_family', 'signal_range', 'luma_bands',
    ]) || !['sdr', 'pq'].includes(mediaProfile.transfer_family) ||
        !['limited', 'full'].includes(mediaProfile.signal_range) ||
        !Array.isArray(mediaProfile.luma_bands) || mediaProfile.luma_bands.length !== 4) {
        throw new Error(`${description} media profile is malformed`);
    }
    const lumaBands = mediaProfile.luma_bands.map((band, index) => {
        if (!Array.isArray(band) || band.length !== 2) {
            throw new Error(`${description} luma band ${index} is malformed`);
        }
        const low = strictJsonNumber(band[0], `${description} luma band ${index} low`);
        const high = strictJsonNumber(band[1], `${description} luma band ${index} high`);
        if (!(low >= 0 && low < high && high <= 256)) {
            throw new Error(`${description} luma band ${index} is invalid`);
        }
        return [low, high];
    });
    if (lumaBands.some((band, index) =>
        index > 0 && lumaBands[index - 1][1] > band[0])) {
        throw new Error(`${description} luma bands overlap`);
    }
    if (options.expectedProfile &&
        mediaProfile.transfer_family !== options.expectedProfile) {
        throw new Error(`${description} media profile changed`);
    }
    if (strictJsonInteger(evidence.crop_size, `${description} evidence crop`) !==
        effectiveCrop) {
        throw new Error(`${description} crop evidence changed`);
    }

    const sampling = evidence.sampling;
    if (!exactObjectFields(sampling, [
        'timestamps', 'skip_head_tail', 'scan_step', 'min_spacing',
        'adjusted', 'rationale',
    ]) || !Array.isArray(sampling.timestamps) ||
        sampling.timestamps.length < MINIMUM_PROXY_TIMESTAMPS ||
        typeof sampling.adjusted !== 'boolean' ||
        typeof sampling.rationale !== 'string' || !sampling.rationale.trim()) {
        throw new Error(`${description} sampling evidence is malformed`);
    }
    const timestamps = sampling.timestamps.map((value, index) =>
        strictJsonNumber(value, `${description} timestamp ${index}`));
    const skipHeadTail = strictJsonNumber(
        sampling.skip_head_tail, `${description} head-tail exclusion`);
    const scanStep = strictJsonNumber(sampling.scan_step, `${description} scan step`);
    if (skipHeadTail < 0 || !(scanStep > 0) ||
        !(strictJsonNumber(sampling.min_spacing, `${description} spacing`) > 0) ||
        !sourceNoiseClose(timestamps[0], skipHeadTail) ||
        timestamps.some((value, index) => value < 0 ||
            (index > 0 && (value <= timestamps[index - 1] ||
                Math.abs(value - timestamps[index - 1] - scanStep) > 1e-10)))) {
        throw new Error(`${description} sampling evidence is inconsistent`);
    }
    const scan = evidence.scan;
    if (!exactObjectFields(scan, ['attempted', 'successful', 'coverage', 'failures']) ||
        !Array.isArray(scan.failures)) {
        throw new Error(`${description} scan evidence is malformed`);
    }
    const failedIndexes = new Set();
    scan.failures.forEach((failure, index) => {
        if (!exactObjectFields(failure, ['index', 'timestamp', 'error'])) {
            throw new Error(`${description} scan failure ${index} is malformed`);
        }
        const failedIndex = strictJsonInteger(
            failure.index, `${description} scan failure ${index} index`);
        if (failedIndexes.has(failedIndex) || failedIndex < 0 ||
            failedIndex >= timestamps.length ||
            !sourceNoiseClose(
                strictJsonNumber(
                    failure.timestamp, `${description} scan failure timestamp`),
                timestamps[failedIndex]) ||
            typeof failure.error !== 'string' || !failure.error.trim()) {
            throw new Error(`${description} scan failure ${index} is inconsistent`);
        }
        failedIndexes.add(failedIndex);
    });
    const attempted = strictJsonInteger(scan.attempted, `${description} attempts`);
    const successful = strictJsonInteger(scan.successful, `${description} successful`);
    const coverage = strictJsonNumber(scan.coverage, `${description} coverage`);
    if (attempted !== timestamps.length ||
        successful !== attempted - scan.failures.length ||
        !sourceNoiseClose(coverage, successful / attempted) ||
        coverage < PRODUCTION_FIT_SETTINGS.minimumScanCoverage) {
        throw new Error(`${description} scan coverage does not reproduce`);
    }
    const successfulTimestamps = new Set(
        timestamps.filter((_timestamp, index) => !failedIndexes.has(index)));
    const stratification = validateSourceNoiseStratificationV2(
        evidence.source_noise_stratification,
        timestamps,
        successfulTimestamps,
        lumaBands,
        `${description} stratification`);
    const qualification = validateSourceNoiseQualificationV2(
        evidence.native_source_noise_qualification,
        stratification.rankedByBin,
        effectiveCrop,
        evidence.source_noise_stratification.required_luma_bands,
        `${description} qualification`);
    const eligibleSupport = stratification.coverageValid && qualification.validSupport;
    if (reasonCode === NO_GRAIN_NO_NOTICEABLE_SOURCE_NOISE_REASON_CODE) {
        if (!eligibleSupport || !qualification.noNoticeable) {
            throw new Error(`${description} no-noise verdict does not reproduce`);
        }
    } else if (eligibleSupport) {
        throw new Error(`${description} insufficient-support verdict does not reproduce`);
    }
    const missingBins = evidence.source_noise_stratification.bins.some(
        (bin) => bin.status === 'missing');
    const attemptLimitReached = qualification.exhaustedBins.some(
        (binIndex) =>
            stratification.rankedByBin.get(binIndex).length >
                SOURCE_NOISE_MAXIMUM_ATTEMPTS_PER_BIN);
    const selectionExhausted =
        reasonCode === NO_GRAIN_INSUFFICIENT_FLAT_SUPPORT_REASON_CODE &&
        (missingBins || qualification.exhaustedBins.length > 0) &&
        !attemptLimitReached;
    const policyExhausted =
        reasonCode === NO_GRAIN_INSUFFICIENT_FLAT_SUPPORT_REASON_CODE;
    if (evidence.attempt_limit_reached !== attemptLimitReached ||
        evidence.selection_exhausted !== selectionExhausted ||
        evidence.policy_exhausted !== policyExhausted ||
        JSON.stringify(settings.source_noise_planes) !==
            JSON.stringify(qualification.sourcePlanes) ||
        settings.source_noise_chroma_threshold_status !==
            qualification.chromaThresholdStatus) {
        throw new Error(`${description} bounded fallback disposition does not reproduce`);
    }
    const requested = report.requested_outputs;
    if (!exactObjectFields(requested, ['table', 'manifest', 'artifacts_published']) ||
        requested.artifacts_published !== false ||
        path.resolve(String(requested.table || '')) !==
            path.resolve(String(options.tablePath || '')) ||
        path.resolve(String(requested.manifest || '')) !==
            path.resolve(String(options.manifestPath || '')) ||
        fs.existsSync(options.tablePath) || fs.existsSync(options.manifestPath)) {
        throw new Error(`${description} published forbidden grain artifacts`);
    }
    return {
        currentFingerprint,
        transferFamily: mediaProfile.transfer_family,
        reasonCode,
    };
}

function validateNoGrainDispositionOutcome(report, options) {
    if (report && Number(report.schema) === DIRECT_PIPELINE_MANIFEST_SCHEMA) {
        return validateDirectBypassOutcome(report, options);
    }
    if (report && (
        report.reason_code === NO_GRAIN_NO_NOTICEABLE_SOURCE_NOISE_REASON_CODE ||
        report.reason_code === NO_GRAIN_INSUFFICIENT_FLAT_SUPPORT_REASON_CODE
    )) {
        return validateSourceNoiseBypassOutcome(report, options);
    }
    if (report && report.reason_code === NO_GRAIN_INSUFFICIENT_ENERGY_REASON_CODE) {
        return validateInsufficientResidualSupportOutcome(report, options);
    }
    if (report && report.reason_code === NO_GRAIN_STATIC_MODEL_UNREPRESENTABLE_REASON_CODE) {
        return validateStaticModelUnrepresentableOutcome(report, options);
    }
    return validateNoGrainOutcome(report, options);
}

function validateDirectBypassOutcome(report, options) {
    const sourcePath = fs.realpathSync(options.sourcePath);
    const pipelinePath = fs.realpathSync(options.pipelinePath);
    const allowedReasons = new Set([
        NO_GRAIN_INSUFFICIENT_FLAT_SUPPORT_REASON_CODE,
        NO_GRAIN_STATIC_MODEL_UNREPRESENTABLE_REASON_CODE,
    ]);
    if (!report || Number(report.schema) !== DIRECT_PIPELINE_MANIFEST_SCHEMA ||
        Number(report.pipeline_version) !== DIRECT_PIPELINE_VERSION ||
        report.operation !== 'fit-direct' || report.purpose !== DIRECT_PURPOSE ||
        report.disposition !== 'bypass' || !allowedReasons.has(report.reason_code) ||
        report.production_action !== NO_GRAIN_PRODUCTION_ACTION) {
        throw new Error('direct grain bypass has an unsupported disposition');
    }
    if (path.resolve(String(report.source || '')) !== path.resolve(sourcePath)) {
        throw new Error('direct grain bypass source path mismatch');
    }
    const currentFingerprint = sampledSourceFingerprint(sourcePath);
    assertFingerprint(report.source_fingerprint, currentFingerprint, 'direct grain bypass source');
    assertFullArtifactFingerprint(report.pipeline, pipelinePath, 'direct grain bypass pipeline');
    validateDirectSelection(report.selection, false);
    if (!['sdr', 'pq'].includes(report.media_profile) ||
        (options.expectedProfile && options.expectedProfile !== report.media_profile)) {
        throw new Error('direct grain bypass media profile mismatch');
    }
    if (fs.existsSync(options.tablePath) || fs.existsSync(options.manifestPath)) {
        throw new Error('direct grain bypass published forbidden table artifacts');
    }
    return {
        currentFingerprint,
        transferFamily: report.media_profile,
        reasonCode: report.reason_code,
    };
}

function buildDirectNoGrainArtifact(report, options) {
    const checked = validateDirectBypassOutcome(report, options);
    const outcomeStat = assertRegularFile(options.outcomePath, 'direct grain bypass report');
    return {
        schema: DIRECT_ARTIFACT_SCHEMA,
        state: 'no_grain',
        contractKind: 'direct-global-v1',
        sourcePath: String(options.sourcePath),
        sourceFingerprint: checked.currentFingerprint,
        outcomePath: path.resolve(options.outcomePath),
        outcomeSha256: sha256File(options.outcomePath),
        outcomeBytes: outcomeStat.size,
        pipelinePath: fs.realpathSync(options.pipelinePath),
        pipelineSha256: sha256File(options.pipelinePath),
        pipelineVersion: DIRECT_PIPELINE_VERSION,
        requestedTablePath: path.resolve(options.tablePath),
        requestedManifestPath: path.resolve(options.manifestPath),
        reasonCode: checked.reasonCode,
        productionAction: NO_GRAIN_PRODUCTION_ACTION,
        denoiseId: nvenccKnn.DENOISE_ID,
        denoiseSettings: nvenccKnn.KNN_SETTINGS,
        denoisePrerollSeconds: 0,
        temporalFiltering: false,
        mediaProfile: checked.transferFamily,
        preparedAt: new Date().toISOString(),
    };
}

function buildNoGrainArtifact(report, options) {
    if (report && Number(report.schema) === DIRECT_PIPELINE_MANIFEST_SCHEMA) {
        return buildDirectNoGrainArtifact(report, options);
    }
    const checked = validateNoGrainDispositionOutcome(report, options);
    const outcomeStat = assertRegularFile(options.outcomePath, 'no-grain outcome report');
    return {
        schema: ARTIFACT_SCHEMA,
        state: 'no_grain',
        sourcePath: String(options.sourcePath),
        sourceFingerprint: checked.currentFingerprint,
        outcomePath: path.resolve(options.outcomePath),
        outcomeSha256: sha256File(options.outcomePath),
        outcomeBytes: outcomeStat.size,
        pipelinePath: fs.realpathSync(options.pipelinePath),
        pipelineSha256: sha256File(options.pipelinePath),
        pipelineVersion: PIPELINE_VERSION,
        requestedTablePath: path.resolve(options.tablePath),
        requestedManifestPath: path.resolve(options.manifestPath),
        reasonCode: checked.reasonCode,
        productionAction: NO_GRAIN_PRODUCTION_ACTION,
        denoise: DENOISE_FILTER,
        denoisePrerollSeconds: DENOISE_PREROLL_SECONDS,
        mediaProfile: checked.transferFamily,
        preparedAt: new Date().toISOString(),
    };
}

function validateNoGrainArtifact(artifact) {
    if (artifact && Number(artifact.schema) === DIRECT_ARTIFACT_SCHEMA) {
        return validateDirectNoGrainArtifact(artifact);
    }
    if (!artifact || Number(artifact.schema) !== ARTIFACT_SCHEMA || artifact.state !== 'no_grain' ||
        !NO_GRAIN_REASON_CODES.has(artifact.reasonCode) ||
        artifact.productionAction !== NO_GRAIN_PRODUCTION_ACTION ||
        artifact.denoise !== DENOISE_FILTER ||
        Number(artifact.denoisePrerollSeconds) !== DENOISE_PREROLL_SECONDS ||
        Number(artifact.pipelineVersion) !== PIPELINE_VERSION) {
        throw new Error(`authenticated no-grain artifact schema ${ARTIFACT_SCHEMA} is required`);
    }
    const outcomePath = fs.realpathSync(artifact.outcomePath);
    if (lower(artifact.outcomeSha256) !== sha256File(outcomePath) ||
        Number(artifact.outcomeBytes) !== fs.statSync(outcomePath).size ||
        lower(artifact.pipelineSha256) !== sha256File(artifact.pipelinePath)) {
        throw new Error('authenticated no-grain artifact checksum mismatch');
    }
    const report = JSON.parse(fs.readFileSync(outcomePath, 'utf8'));
    const checked = validateNoGrainDispositionOutcome(report, {
        sourcePath: artifact.sourcePath,
        pipelinePath: artifact.pipelinePath,
        tablePath: artifact.requestedTablePath,
        manifestPath: artifact.requestedManifestPath,
        expectedProfile: artifact.mediaProfile,
    });
    if (checked.reasonCode !== artifact.reasonCode) {
        throw new Error('authenticated no-grain artifact reason mismatch');
    }
    assertFingerprint(artifact.sourceFingerprint, checked.currentFingerprint, 'authenticated no-grain source');
    return { artifact, report, checked };
}

function validateDirectNoGrainArtifact(artifact) {
    if (!artifact || Number(artifact.schema) !== DIRECT_ARTIFACT_SCHEMA ||
        artifact.state !== 'no_grain' || artifact.contractKind !== 'direct-global-v1' ||
        ![
            NO_GRAIN_INSUFFICIENT_FLAT_SUPPORT_REASON_CODE,
            NO_GRAIN_STATIC_MODEL_UNREPRESENTABLE_REASON_CODE,
        ].includes(artifact.reasonCode) ||
        artifact.productionAction !== NO_GRAIN_PRODUCTION_ACTION ||
        artifact.denoiseId !== nvenccKnn.DENOISE_ID ||
        artifact.denoiseSettings !== nvenccKnn.KNN_SETTINGS ||
        Number(artifact.denoisePrerollSeconds) !== 0 ||
        artifact.temporalFiltering !== false ||
        Number(artifact.pipelineVersion) !== DIRECT_PIPELINE_VERSION) {
        throw new Error(`authenticated direct no-grain artifact schema ${DIRECT_ARTIFACT_SCHEMA} is required`);
    }
    const outcomePath = fs.realpathSync(artifact.outcomePath);
    if (lower(artifact.outcomeSha256) !== sha256File(outcomePath) ||
        Number(artifact.outcomeBytes) !== fs.statSync(outcomePath).size ||
        lower(artifact.pipelineSha256) !== sha256File(artifact.pipelinePath)) {
        throw new Error('authenticated direct no-grain artifact checksum mismatch');
    }
    const report = JSON.parse(fs.readFileSync(outcomePath, 'utf8'));
    const checked = validateDirectBypassOutcome(report, {
        sourcePath: artifact.sourcePath,
        pipelinePath: artifact.pipelinePath,
        tablePath: artifact.requestedTablePath,
        manifestPath: artifact.requestedManifestPath,
        expectedProfile: artifact.mediaProfile,
    });
    if (checked.reasonCode !== artifact.reasonCode) {
        throw new Error('authenticated direct no-grain artifact reason mismatch');
    }
    assertFingerprint(artifact.sourceFingerprint, checked.currentFingerprint,
        'authenticated direct no-grain source');
    return { artifact, report, checked };
}

function validateAnalysisUnavailableDisposition(variables) {
    if (!variables || typeof variables !== 'object' ||
        String(variables.grainAnalysisStatus || '') !== ANALYSIS_UNAVAILABLE_STATUS) {
        throw new Error('analysis-unavailable grain disposition is required');
    }
    const stale = ANALYSIS_UNAVAILABLE_FORBIDDEN_VARIABLES.filter((key) =>
        Object.prototype.hasOwnProperty.call(variables, key));
    if (stale.length) {
        throw new Error(`analysis-unavailable grain disposition retained forbidden artifact references: ${stale.join(', ')}`);
    }
    const reason = variables.grainAnalysisReason;
    if (typeof reason !== 'string' || !reason.trim() || reason !== reason.trim() ||
        reason.length > ANALYSIS_DIAGNOSTIC_MAX_CHARS) {
        throw new Error('analysis-unavailable grain reason must be trimmed, nonempty, and bounded');
    }
    const completedAt = variables.grainAnalysisCompletedAt;
    const completedDate = typeof completedAt === 'string' ? new Date(completedAt) : null;
    if (!completedDate || Number.isNaN(completedDate.getTime()) ||
        completedDate.toISOString() !== completedAt) {
        throw new Error('analysis-unavailable completion timestamp must be canonical');
    }
    return ANALYSIS_UNAVAILABLE_STATUS;
}

function canonicalDenoiseDisposition(variables) {
    const status = String(variables && variables.grainAnalysisStatus || '');
    if (status === 'prepared') {
        const artifact = variables && variables.grainAnalysisArtifact;
        validatePreparedArtifact(artifact, {
            sourcePath: artifact && artifact.sourcePath,
            tablePath: artifact && artifact.tablePath,
            manifestPath: artifact && artifact.manifestPath,
            pipelinePath: artifact && artifact.pipelinePath,
        });
        return 'prepared';
    }
    if (status === 'no_grain') {
        validateNoGrainArtifact(variables && variables.grainAnalysisNoGrainArtifact);
        return 'no_grain';
    }
    if (status === ANALYSIS_UNAVAILABLE_STATUS) {
        validateAnalysisUnavailableDisposition(variables);
        return ANALYSIS_UNAVAILABLE_STATUS;
    }
    return null;
}

function shouldUseCanonicalDenoise(disposition) {
    if (disposition !== null && disposition !== 'prepared' && disposition !== 'no_grain' &&
        disposition !== ANALYSIS_UNAVAILABLE_STATUS) {
        throw new Error(`unsupported grain-analysis disposition: ${disposition}`);
    }
    return disposition === 'prepared';
}

module.exports = {
    ARTIFACT_SCHEMA,
    PIPELINE_MANIFEST_SCHEMA,
    PIPELINE_VERSION,
    DIRECT_ARTIFACT_SCHEMA,
    DIRECT_PIPELINE_MANIFEST_SCHEMA,
    DIRECT_PIPELINE_VERSION,
    DIRECT_GRAIN_MODEL_CONTRACT_ID,
    DIRECT_PURPOSE,
    DIRECT_COMPARISON_MODE,
    DIRECT_GLOBAL_SEGMENT_END,
    SPARSE_GLOBAL_MODEL_CONTRACT_ID,
    SPARSE_GLOBAL_TIMELINE_COVERAGE,
    SPARSE_GLOBAL_UNSEEN_INTERVAL_BASIS,
    DENOISE_FILTER,
    DENOISE_PREROLL_SECONDS,
    NO_GRAIN_REASON_CODE,
    NO_GRAIN_INSUFFICIENT_ENERGY_REASON_CODE,
    NO_GRAIN_STATIC_MODEL_UNREPRESENTABLE_REASON_CODE,
    NO_GRAIN_NO_NOTICEABLE_SOURCE_NOISE_REASON_CODE,
    NO_GRAIN_INSUFFICIENT_FLAT_SUPPORT_REASON_CODE,
    NO_GRAIN_PRODUCTION_ACTION,
    ANALYSIS_UNAVAILABLE_STATUS,
    ANALYSIS_DIAGNOSTIC_MAX_CHARS,
    ANALYSIS_UNAVAILABLE_FORBIDDEN_VARIABLES,
    CROP_SIZE_POLICY,
    MINIMUM_PRODUCTION_CROP_SIZE,
    MINIMUM_PROXY_TIMESTAMPS,
    PRODUCTION_FIT_SETTINGS,
    REGION_SET_CONTRACT,
    NATIVE_LUMA_QUALIFICATION_METHOD,
    POSTENCODE_RESIDUAL_QUALIFICATION_METHOD,
    SOURCE_RESIDUAL_REPRESENTABILITY_METHOD,
    SOURCE_RESIDUAL_REPRESENTABILITY_PAIR_COUNT,
    SOURCE_RESIDUAL_LUMA_ALLOWANCE_PER_CODE,
    SOURCE_RESIDUAL_MAXIMUM_LUMA_ALLOWANCE,
    SOURCE_RESIDUAL_MAXIMUM_MEDIAN_EXCESS,
    SOURCE_RESIDUAL_MAXIMUM_PAIR_EXCESS,
    SOURCE_NOISE_ESTIMATOR_METHOD,
    SOURCE_NOISE_QUALIFICATION_METHOD,
    SOURCE_NOISE_GRAY8_NORMALIZATION,
    SOURCE_NOISE_STRATIFICATION_METHOD,
    SOURCE_NOISE_EDGE_THRESHOLD,
    SOURCE_NOISE_MINIMUM_SMOOTH_PIXELS,
    SOURCE_NOISE_RENDERED_FRAMES_PER_REGION,
    SOURCE_NOISE_MINIMUM_VALID_FRAMES_PER_REGION,
    SOURCE_NOISE_TEMPORAL_BIN_COUNT,
    SOURCE_NOISE_REQUIRED_VALID_REGIONS,
    SOURCE_NOISE_MAXIMUM_ATTEMPTS_PER_BIN,
    SOURCE_NOISE_MINIMUM_SELECTED_SPAN_FRACTION,
    SOURCE_NOISE_MEDIAN_THRESHOLD,
    SOURCE_NOISE_P90_THRESHOLD,
    SOURCE_NOISE_PLANES,
    SOURCE_NOISE_CHROMA_THRESHOLD_STATUS,
    SOURCE_NOISE_MONOCHROME_THRESHOLD_STATUS,
    SOURCE_NOISE_COMPARISON_MODE,
    SOURCE_NOISE_PURPOSE,
    lower,
    finiteNumber,
    safeSlug,
    stableId,
    sha256File,
    assertRegularFile,
    isWithin,
    resolveJobOwnedRoot,
    assertJobOwnedPath,
    removeOwnedJobDir,
    registerTemporaryFile,
    primaryVideo,
    isVideoTypeRelativeZero,
    isHdr10PlusDescription,
    dynamicHdrMarkers,
    hasResidualDynamicHdrMetadata,
    isPqBt2020HighBitVideo,
    dolbyVisionBaseLayerInfo,
    recognizedDynamicHdrAuthorization,
    validateProvisionalDynamicHdrEvidence,
    provisionalDynamicHdrEvidence,
    profileAllowed,
    classifySource,
    ensurePathAllowed,
    resolveAllowlistedSourcePath,
    sampledSourceFingerprint,
    assertFingerprint,
    hasSemanticGrain,
    validateDenoiserAttestation,
    deriveSourceResidualRepresentability,
    validateSourceResidualRepresentability,
    validateThreeRegionSets,
    directTableSegments,
    assertDirectGlobalTable,
    validateDirectSelection,
    validateDirectPreparedManifest,
    buildDirectPreparedArtifact,
    validateDirectPreparedArtifact,
    validatePreparedManifest,
    buildPreparedArtifact,
    validatePreparedArtifact,
    assertFullArtifactFingerprint,
    validateExactPairEvidence,
    validateNoGrainOutcome,
    validateInsufficientResidualSupportOutcome,
    validateStaticModelUnrepresentableOutcome,
    validateSourceNoiseBypassOutcome,
    validateDirectBypassOutcome,
    validateNoGrainDispositionOutcome,
    buildDirectNoGrainArtifact,
    buildNoGrainArtifact,
    validateDirectNoGrainArtifact,
    validateNoGrainArtifact,
    validateAnalysisUnavailableDisposition,
    canonicalDenoiseDisposition,
    shouldUseCanonicalDenoise,
};
