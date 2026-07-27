'use strict';

const nvenccKnn = require('./nvenccKnn.js');

// The canonical denoise is now an external, native-depth GPU KNN producer.
// FFmpeg consumes its raw NUT stream and must never repeat a denoiser.
const FILTER = null;
const PREROLL_SECONDS = 0.0;
const REFERENCE_CONTRACT_ID = nvenccKnn.REFERENCE_CONTRACT_ID;
const FGS_BYPASS_REFERENCE_CONTRACT_ID = 'fgs-bypass-original-tf0-v1';
const LEGACY_REFERENCE_CONTRACT_ID = 'legacy-original-tf4-v1';

function filterOccurrences(value) {
    const text = (Array.isArray(value) ? value : [value])
        .map((item) => String(item === undefined || item === null ? '' : item))
        .join(' ');
    return text.match(/(?:hqdn3d|nlmeans|knnlm|vpp-knn)(?:=[^,;\]\s"']*)?/gi) || [];
}

function assertCanonicalExactlyOnce(value, context) {
    const matches = filterOccurrences(value);
    if (matches.length) {
        throw new Error(`${context || 'FFmpeg consumer'} must consume the external canonical KNN stream without another denoiser; observed ` +
            matches.join(','));
    }
    return value;
}

function assertAbsent(value, context) {
    const matches = filterOccurrences(value);
    if (matches.length) {
        throw new Error(`${context || 'video filter graph'} must not denoise an already canonical sample; observed ${matches.join(',')}`);
    }
    return value;
}

function sampleFilter() {
    throw new Error('canonical KNN samples are produced by NVEncC, not an FFmpeg filter graph');
}

module.exports = {
    FILTER,
    PREROLL_SECONDS,
    DENOISE_ID: nvenccKnn.DENOISE_ID,
    KNN_SETTINGS: nvenccKnn.KNN_SETTINGS,
    NVENCC_PATH: nvenccKnn.DEFAULT_NVENCC_PATH,
    COORDINATOR_PATH: nvenccKnn.DEFAULT_COORDINATOR_PATH,
    REFERENCE_CONTRACT_ID,
    FGS_BYPASS_REFERENCE_CONTRACT_ID,
    LEGACY_REFERENCE_CONTRACT_ID,
    filterOccurrences,
    assertCanonicalExactlyOnce,
    assertAbsent,
    sampleFilter,
};
