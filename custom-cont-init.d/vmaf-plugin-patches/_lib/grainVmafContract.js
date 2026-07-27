'use strict';

const canonicalDenoise = require('./canonicalDenoise.js');
const grainArtifact = require('./grainAnalysisArtifact.js');
const nvencTemporalFilter = require('./nvencTemporalFilter.js');

// CQ prediction/acceptance must stay inside the signal domain that will be
// encoded. A denoised reference with decoder-side grain synthesis is not
// interchangeable with an untouched source that bypasses FGS, even though both
// intentionally disable NVENC temporal filtering.
const SELECTOR_MODE_PREPARED = 'canonical-denoise-fgs';
const SELECTOR_MODE_BYPASS = 'original-fgs-bypass';
const SELECTOR_MODE_LEGACY = 'legacy-original';

function forDisposition(disposition) {
    // Keep validation centralized in the authenticated grain-artifact module.
    grainArtifact.shouldUseCanonicalDenoise(disposition);
    if (disposition === 'prepared') {
        return {
            disposition: 'prepared',
            selectorMode: SELECTOR_MODE_PREPARED,
            canonical: true,
            id: canonicalDenoise.REFERENCE_CONTRACT_ID,
            temporalPolicy: nvencTemporalFilter.CANONICAL_POLICY,
            legacyHistory: false,
        };
    }
    if (disposition === 'no_grain' ||
        disposition === grainArtifact.ANALYSIS_UNAVAILABLE_STATUS) {
        return {
            disposition: disposition,
            selectorMode: SELECTOR_MODE_BYPASS,
            canonical: false,
            id: canonicalDenoise.FGS_BYPASS_REFERENCE_CONTRACT_ID,
            temporalPolicy: nvencTemporalFilter.FGS_BYPASS_POLICY,
            legacyHistory: false,
        };
    }
    return {
        disposition: null,
        selectorMode: SELECTOR_MODE_LEGACY,
        canonical: false,
        id: canonicalDenoise.LEGACY_REFERENCE_CONTRACT_ID,
        temporalPolicy: nvencTemporalFilter.LEGACY_POLICY,
        legacyHistory: true,
    };
}

function forVariables(variables) {
    return forDisposition(grainArtifact.canonicalDenoiseDisposition(variables || {}));
}

function assertVariables(variables, options) {
    variables = variables || {};
    options = options || {};
    const contract = forVariables(variables);
    const context = options.context || 'VMAF';
    if (variables.vmafReferenceContractId !== contract.id ||
        variables.vmafCanonicalDenoiseActive !== contract.canonical) {
        throw new Error(`${context} reference disposition does not match authenticated grain analysis`);
    }
    if (options.requireTemporalPolicy === true &&
        variables.vmafNvencTemporalPolicy !== contract.temporalPolicy) {
        throw new Error(`${context} temporal-filter policy does not match authenticated grain analysis`);
    }
    return contract;
}

module.exports = {
    SELECTOR_MODE_PREPARED,
    SELECTOR_MODE_BYPASS,
    SELECTOR_MODE_LEGACY,
    forDisposition,
    forVariables,
    assertVariables,
};
