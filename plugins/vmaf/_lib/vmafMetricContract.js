'use strict';

const crypto = require('crypto');
const fs = require('fs');
const nvencTemporalFilter = require('./nvencTemporalFilter.js');
const preFgsCambi = require('./preFgsCambi.js');

const CONTRACT_SCHEMA_VERSION = 1;
const MODEL_ROOT = '/usr/local/share/model';
const FOUR_K_MIN_WIDTH = 3840;
const FOUR_K_MIN_HEIGHT = 2160;

const PRODUCTION_METRIC_CONTRACT_FAMILY_ID =
    'vmaf-v0.6.1-resolution-selected-libvmaf-cuda-yuv420p8-harmonic-prefgs-cambi-cpu-yuv420p8-v1';
const PRODUCTION_STANDARD_METRIC_CONTRACT_ID =
    'vmaf-v0.6.1-standard-libvmaf-cuda-yuv420p8-harmonic-prefgs-cambi-cpu-yuv420p8-v1';
const PRODUCTION_4K_METRIC_CONTRACT_ID =
    'vmaf-v0.6.1-4k-libvmaf-cuda-yuv420p8-harmonic-prefgs-cambi-cpu-yuv420p8-v1';

// Existing rows predate an immutable metric/encoder contract. This label is
// intentionally coarse: those rows may mix libvmaf/libvmaf_cuda, 8/10-bit
// scoring, and encoder settings that cannot be attested after the fact.
const LEGACY_METRIC_CONTRACT_ID =
    'vmaf-v0-resolution-selected-legacy-mixed-backend-v1';
const LEGACY_ENCODER_PROFILE_ID =
    'legacy-unattested-mixed-encoder-profile-v1';

const COMPARISON_ENCODER_PROFILE_ID =
    nvencTemporalFilter.REFERENCE_COMPARISON_ENCODER_PROFILE_ID;

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(function (key) {
        deepFreeze(value[key]);
    });
    return Object.freeze(value);
}

const PRODUCTION_MODELS = deepFreeze({
    standard: {
        resolutionClass: 'standard',
        name: 'vmaf_v0.6.1',
        path: MODEL_ROOT + '/vmaf_v0.6.1.json',
        sha256: '5950d61fa1f861bd45d8149d80539ed9f3376cfc2495b8f0fa8e9f57cb131ee3',
        metricContractId: PRODUCTION_STANDARD_METRIC_CONTRACT_ID,
    },
    fourK: {
        resolutionClass: '4k',
        name: 'vmaf_4k_v0.6.1',
        path: MODEL_ROOT + '/vmaf_4k_v0.6.1.json',
        sha256: '73b187001309703c89d57cf58baab01660bd11e4ea6fac62bc064c5f5da6dac8',
        metricContractId: PRODUCTION_4K_METRIC_CONTRACT_ID,
    },
});

const POOLING_POLICY = deepFreeze({
    primary: 'harmonic_mean',
    vmafMetricKey: 'vmaf',
    reported: ['harmonic_mean', 'mean', 'min', 'max'],
});

const CAMBI_POLICY = deepFreeze({
    policyId: preFgsCambi.POLICY_ID,
    mode: 'pre-fgs-standalone-cpu',
    integratedInModel: false,
    required: true,
    featureName: 'cambi',
    metricKey: 'cambi',
    backend: 'cpu',
    filterName: 'libvmaf',
    scoringBitDepth: 8,
    scoringPixelFormat: 'yuv420p',
    tonemap: false,
    stage: 'pre-fgs-grain-free-candidate',
    sourceBaseline: 'same-authenticated-reference-domain-self-comparison',
    subsamplePolicy: 'match-production-vmaf-n-subsample',
    reasonCode: null,
});

const V1_MODEL_ROOT = MODEL_ROOT + '/vmaf_v1.0.16';
const V1_HFR_MODEL_ROOT = MODEL_ROOT + '/vmaf_v1.0.16_hfr';
const CPU_V1_UPSTREAM_REVISION = '78e11b52c8fc1fcc6d15afd6c7479394fb3bc6af';
const CPU_V1_RUNTIME_PATH = '/usr/local/bin/vmaf-v1';
const CPU_V1_CONTRACT_FAMILY_ID =
    'vmaf-v1.0.16-cpu-float-native10-integrated-cambi-v1';
const PAIRED_CQ_INFERENCE_AUTHORITY_CONTRACT_ID =
    'paired-cq-vmaf-v1-cambi-inference-authority-v1';
const CPU_V1_MODELS = deepFreeze({
    standard: { version: 'vmaf_v1.0.16_3d0h', resolutionClass: 'standard', hfr: false },
    fourK: { version: 'vmaf_v1.0.16_1d5h_2160', resolutionClass: '4k', hfr: false },
    hfrStandard: { version: 'vmaf_v1.0.16_hfr_3d0h', resolutionClass: 'standard', hfr: true },
    hfrFourK: { version: 'vmaf_v1.0.16_hfr_1d5h_2160', resolutionClass: '4k', hfr: true },
});
const V1_CUDA_CAPABILITY_SPEC = deepFreeze({
    capabilityId: 'vmaf-v1.0.16-libvmaf-cuda-upstream-3.2.0-unsupported-v1',
    modelVersion: 'vmaf_v1.0.16',
    backend: 'cuda',
    filterName: 'libvmaf_cuda',
    scoringBitDepth: 8,
    scoringPixelFormat: 'yuv420p',
    expectedSupported: false,
    productionEligible: false,
    reasonCode: 'required-v1-features-have-no-upstream-cuda-extractors',
    verifiedAgainstUpstreamLibvmaf: '3.2.0',
    requiredFeaturesWithoutCompleteCudaSupport: [
        'Cambi_feature_cambi_score',
        'Speed_chroma_feature_speed_chroma_uv_score',
        'VMAF_integer_feature_adm3_score',
        'VMAF_integer_feature_motion3_score',
    ],
    // These are discovery/capability-probe paths only. Production resolution
    // below cannot select any VMAF v1 model while this capability is unsupported.
    models: {
        standard: {
            name: 'vmaf_v1.0.16_3d0h',
            path: V1_MODEL_ROOT + '/vmaf_v1.0.16_3d0h.json',
            sha256: 'e4cf8c147e1368b35497d772920bc92f98c1ad7853c1033d8a836947f427140e',
        },
        fourK: {
            name: 'vmaf_v1.0.16_1d5h_2160',
            path: V1_MODEL_ROOT + '/vmaf_v1.0.16_1d5h_2160.json',
            sha256: '634d36e0502cb797384726cdd1a106a2c207827595a9e4958d3dae1bd517b139',
        },
        hfrStandard: {
            name: 'vmaf_v1.0.16_hfr_3d0h',
            path: V1_HFR_MODEL_ROOT + '/vmaf_v1.0.16_hfr_3d0h.json',
            sha256: 'dcfdfab1c00685c1e5f75b6f1078bb4a44c722654e4de090fa5c66784c75241b',
        },
        hfrFourK: {
            name: 'vmaf_v1.0.16_hfr_1d5h_2160',
            path: V1_HFR_MODEL_ROOT + '/vmaf_v1.0.16_hfr_1d5h_2160.json',
            sha256: '0371db55d3de81a760125f6d65eb4386f1d38af6cf1d00c2f48158e3596246d4',
        },
    },
});

function numberOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizedAspectRatio(value, label) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    const match = text.match(/^(\d+):(\d+)$/);
    if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) {
        throw new TypeError(label + ' must be an explicit positive N:D ratio');
    }
    let numerator = Number(match[1]);
    let denominator = Number(match[2]);
    function gcd(a, b) {
        while (b) { const next = a % b; a = b; b = next; }
        return a;
    }
    const divisor = gcd(numerator, denominator);
    numerator /= divisor;
    denominator /= divisor;
    return numerator + ':' + denominator;
}

function dimensionsFromInput(input) {
    if (!input || typeof input !== 'object') {
        throw new TypeError('VMAF metric contract resolution requires video dimensions');
    }

    let width = numberOrNull(input.width);
    let height = numberOrNull(input.height);
    if (width === null) width = numberOrNull(input.sourceWidth);
    if (height === null) height = numberOrNull(input.sourceHeight);

    const probe = input.ffProbeData || input.ffprobeData || input;
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    let videoStream = null;
    for (let index = 0; index < streams.length; index += 1) {
        if (streams[index] && streams[index].codec_type === 'video') {
            videoStream = streams[index];
            break;
        }
    }
    if (!videoStream && streams.length === 1) videoStream = streams[0];
    if (videoStream) {
        if (width === null) width = numberOrNull(videoStream.width);
        if (height === null) height = numberOrNull(videoStream.height);
    }

    if (!(width > 0) || !(height > 0)) {
        throw new TypeError('VMAF metric contract resolution requires positive width and height');
    }
    return { width: width, height: height };
}

function cpuV1GeometryFromInput(input) {
    const dimensions = dimensionsFromInput(input);
    const probe = input.ffProbeData || input.ffprobeData || input;
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    let videoStream = null;
    for (let index = 0; index < streams.length; index += 1) {
        if (streams[index] && streams[index].codec_type === 'video') {
            videoStream = streams[index];
            break;
        }
    }
    if (!videoStream && streams.length === 1) videoStream = streams[0];
    videoStream = videoStream || {};
    const sampleAspectRatio = normalizedAspectRatio(
        input.sampleAspectRatio || input.sample_aspect_ratio || videoStream.sample_aspect_ratio,
        'CPU VMAF-v1 sample aspect ratio',
    );
    const displayAspectRatio = normalizedAspectRatio(
        input.displayAspectRatio || input.display_aspect_ratio || videoStream.display_aspect_ratio,
        'CPU VMAF-v1 display aspect ratio',
    );
    const normalization = String(
        input.geometryNormalization || input.normalizationDecision || '',
    ).trim();
    if (normalization !== 'none') {
        throw new TypeError('CPU VMAF-v1 geometry normalization must be explicitly none');
    }
    return {
        width: dimensions.width,
        height: dimensions.height,
        sampleAspectRatio: sampleAspectRatio,
        displayAspectRatio: displayAspectRatio,
        normalization: normalization,
    };
}

function explicitlyAttestedEncoderProfile(options) {
    options = options || {};
    return options.attestedEncoderProfileId === COMPARISON_ENCODER_PROFILE_ID
        ? COMPARISON_ENCODER_PROFILE_ID : null;
}

/** Resolve the isolated CPU-v1 migration contract without changing production. */
function resolveCpuV1Candidate(input, options) {
    options = options || {};
    const dimensions = cpuV1GeometryFromInput(input);
    if (typeof input.isHdr !== 'boolean') {
        throw new TypeError('CPU VMAF-v1 candidate resolution requires explicit isHdr');
    }
    if (input.scoringBitDepth !== undefined && Number(input.scoringBitDepth) !== 10) {
        throw new TypeError('CPU VMAF-v1 candidate contract requires native 10-bit scoring');
    }
    const frameRate = numberOrNull(input.frameRate);
    const hfr = frameRate !== null && frameRate > 30;
    const fourK = dimensions.width >= FOUR_K_MIN_WIDTH || dimensions.height >= FOUR_K_MIN_HEIGHT;
    const model = hfr
        ? (fourK ? CPU_V1_MODELS.hfrFourK : CPU_V1_MODELS.hfrStandard)
        : (fourK ? CPU_V1_MODELS.fourK : CPU_V1_MODELS.standard);
    const contentClass = input.isHdr ? 'hdr-pq' : 'sdr';
    const metricContractId = [
        CPU_V1_CONTRACT_FAMILY_ID,
        contentClass,
        model.resolutionClass,
        model.hfr ? 'hfr' : 'standard-rate',
        'untonemapped',
        'coded' + dimensions.width + 'x' + dimensions.height,
        'sar' + dimensions.sampleAspectRatio.replace(':', 'x'),
        'dar' + dimensions.displayAspectRatio.replace(':', 'x'),
        'norm-' + dimensions.normalization,
    ].join('-');
    const attestedEncoderProfileId = explicitlyAttestedEncoderProfile(options);
    return deepFreeze({
        schemaVersion: 3,
        metricContractFamilyId: CPU_V1_CONTRACT_FAMILY_ID,
        metricContractId: metricContractId,
        inferenceAuthorityContractId: PAIRED_CQ_INFERENCE_AUTHORITY_CONTRACT_ID,
        encoderProfileId: attestedEncoderProfileId || LEGACY_ENCODER_PROFILE_ID,
        encoderProfileAttested: Boolean(attestedEncoderProfileId),
        productionEligible: false,
        qualificationStatus: 'source-only-candidate',
        contentClass: contentClass,
        hdrValidationStatus: input.isHdr
            ? 'provisional-needs-real-content-calibration' : 'needs-real-content-calibration',
        modelFamilyVersion: 'vmaf-v1.0.16-resolution-and-rate-selected',
        modelVersion: model.version,
        modelName: model.version,
        modelResolutionClass: model.resolutionClass,
        builtInModel: true,
        upstreamRevision: CPU_V1_UPSTREAM_REVISION,
        runtimePath: CPU_V1_RUNTIME_PATH,
        backend: 'cpu',
        filterName: 'standalone-vmaf',
        requiresGpu: false,
        allowGpuFallback: false,
        scoringBitDepth: 10,
        scoringPixelFormat: 'yuv420p10le',
        chromaSubsampling: '420',
        tonemap: false,
        poolingPrimary: POOLING_POLICY.primary,
        pooling: POOLING_POLICY,
        // Do not clamp here: candidate parsers must preserve observed values for calibration.
        vmafScoreRange: { minimum: 0, maximum: 110, parserMustNotClamp: true },
        cambi: {
            policyId: 'prefgs-cambi-cpu-vmaf-v1-native10-integrated-v1',
            mode: 'pre-fgs-integrated-cpu-vmaf-v1',
            integratedInModel: true,
            required: true,
            metricAliasPolicy: 'exact-model-qualified-or-unambiguous-bare-key',
            fullReference: true,
            scoringBitDepth: 10,
            scoringPixelFormat: 'yuv420p10le',
            tonemap: false,
            stage: 'pre-fgs-grain-free-candidate',
        },
        sourceWidth: dimensions.width,
        sourceHeight: dimensions.height,
        sourceSampleAspectRatio: dimensions.sampleAspectRatio,
        sourceDisplayAspectRatio: dimensions.displayAspectRatio,
        geometryNormalization: dimensions.normalization,
        frameRate: frameRate,
    });
}

/** Promote the exact calibrated CPU-v1 metric identity without changing its evidence key. */
function resolveCpuV1Production(input, options) {
    const candidate = resolveCpuV1Candidate(input, options);
    return deepFreeze(Object.assign({}, candidate, {
        productionEligible: true,
        qualificationStatus: 'promoted-production-authority',
        hdrValidationStatus: input.isHdr
            ? 'provisional-hdr-explicitly-authorized-with-full-holdout'
            : 'promoted-sdr-with-full-holdout',
    }));
}

function resolveProduction(input, options) {
    const dimensions = dimensionsFromInput(input);
    const useFourK = dimensions.width >= FOUR_K_MIN_WIDTH ||
        dimensions.height >= FOUR_K_MIN_HEIGHT;
    const model = useFourK ? PRODUCTION_MODELS.fourK : PRODUCTION_MODELS.standard;
    const attestedEncoderProfileId = explicitlyAttestedEncoderProfile(options);

    return deepFreeze({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        metricContractFamilyId: PRODUCTION_METRIC_CONTRACT_FAMILY_ID,
        metricContractId: model.metricContractId,
        encoderProfileId: attestedEncoderProfileId || LEGACY_ENCODER_PROFILE_ID,
        encoderProfileAttested: Boolean(attestedEncoderProfileId),
        modelFamilyVersion: 'vmaf-v0.6.1-resolution-selected',
        modelVersion: model.name,
        modelResolutionClass: model.resolutionClass,
        modelName: model.name,
        modelPath: model.path,
        modelSha256: model.sha256,
        backend: 'cuda',
        filterName: 'libvmaf_cuda',
        requiresGpu: true,
        allowCpuFallback: false,
        scoringBitDepth: 8,
        scoringPixelFormat: 'yuv420p',
        poolingPrimary: POOLING_POLICY.primary,
        pooling: POOLING_POLICY,
        cambiPolicy: CAMBI_POLICY.mode,
        cambi: CAMBI_POLICY,
        resolutionSelectionPolicy: 'width-gte-3840-or-height-gte-2160-v1',
        sourceWidth: dimensions.width,
        sourceHeight: dimensions.height,
    });
}

function resolveProductionForVideo(width, height, options) {
    return resolveProduction({ width: width, height: height }, options);
}

function modelIdentity(contract) {
    if (!contract || typeof contract !== 'object') {
        throw new TypeError('VMAF model verification requires a contract or model descriptor');
    }
    const modelPath = contract.modelPath || contract.path;
    const expectedSha256 = String(contract.modelSha256 || contract.sha256 || '').toLowerCase();
    if (!modelPath || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
        throw new TypeError('VMAF model verification requires modelPath/path and a SHA-256 digest');
    }
    return {
        modelName: contract.modelName || contract.name || null,
        modelPath: String(modelPath),
        expectedSha256: expectedSha256,
    };
}

function verifyModelFile(contract, options) {
    options = options || {};
    const identity = modelIdentity(contract);
    const fsImpl = options.fs || fs;
    const cryptoImpl = options.crypto || crypto;
    const modelPath = options.modelPath || identity.modelPath;
    let bytes;
    try {
        bytes = fsImpl.readFileSync(modelPath);
    } catch (error) {
        return deepFreeze({
            ok: false,
            reason: 'model-not-readable',
            modelName: identity.modelName,
            modelPath: modelPath,
            expectedSha256: identity.expectedSha256,
            actualSha256: null,
            errorCode: error && error.code ? String(error.code) : null,
        });
    }
    const actualSha256 = cryptoImpl.createHash('sha256').update(bytes).digest('hex').toLowerCase();
    return deepFreeze({
        ok: actualSha256 === identity.expectedSha256,
        reason: actualSha256 === identity.expectedSha256 ? 'verified' : 'sha256-mismatch',
        modelName: identity.modelName,
        modelPath: modelPath,
        expectedSha256: identity.expectedSha256,
        actualSha256: actualSha256,
        errorCode: null,
    });
}

function assertModelFile(contract, options) {
    const result = verifyModelFile(contract, options);
    if (result.ok) return result;
    const error = new Error(result.reason === 'model-not-readable'
        ? 'VMAF model is not readable: ' + result.modelPath
        : 'VMAF model SHA-256 mismatch for ' + result.modelPath +
          ' (expected ' + result.expectedSha256 + ', observed ' + result.actualSha256 + ')');
    error.code = result.reason === 'model-not-readable'
        ? 'VMAF_MODEL_NOT_READABLE' : 'VMAF_MODEL_SHA256_MISMATCH';
    error.verification = result;
    throw error;
}

function v1CudaCapabilitySpec() {
    return V1_CUDA_CAPABILITY_SPEC;
}

module.exports = {
    CONTRACT_SCHEMA_VERSION: CONTRACT_SCHEMA_VERSION,
    MODEL_ROOT: MODEL_ROOT,
    FOUR_K_MIN_WIDTH: FOUR_K_MIN_WIDTH,
    FOUR_K_MIN_HEIGHT: FOUR_K_MIN_HEIGHT,
    PRODUCTION_METRIC_CONTRACT_FAMILY_ID: PRODUCTION_METRIC_CONTRACT_FAMILY_ID,
    PRODUCTION_STANDARD_METRIC_CONTRACT_ID: PRODUCTION_STANDARD_METRIC_CONTRACT_ID,
    PRODUCTION_4K_METRIC_CONTRACT_ID: PRODUCTION_4K_METRIC_CONTRACT_ID,
    LEGACY_METRIC_CONTRACT_ID: LEGACY_METRIC_CONTRACT_ID,
    LEGACY_ENCODER_PROFILE_ID: LEGACY_ENCODER_PROFILE_ID,
    COMPARISON_ENCODER_PROFILE_ID: COMPARISON_ENCODER_PROFILE_ID,
    PRODUCTION_MODELS: PRODUCTION_MODELS,
    POOLING_POLICY: POOLING_POLICY,
    CAMBI_POLICY: CAMBI_POLICY,
    CPU_V1_UPSTREAM_REVISION: CPU_V1_UPSTREAM_REVISION,
    CPU_V1_RUNTIME_PATH: CPU_V1_RUNTIME_PATH,
    CPU_V1_CONTRACT_FAMILY_ID: CPU_V1_CONTRACT_FAMILY_ID,
    PAIRED_CQ_INFERENCE_AUTHORITY_CONTRACT_ID: PAIRED_CQ_INFERENCE_AUTHORITY_CONTRACT_ID,
    CPU_V1_MODELS: CPU_V1_MODELS,
    resolveProduction: resolveProduction,
    resolveProductionForVideo: resolveProductionForVideo,
    resolveCpuV1Candidate: resolveCpuV1Candidate,
    resolveCpuV1Production: resolveCpuV1Production,
    verifyModelFile: verifyModelFile,
    assertModelFile: assertModelFile,
    v1CudaCapabilitySpec: v1CudaCapabilitySpec,
};
