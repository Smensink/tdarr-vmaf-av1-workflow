"use strict";

// Canonical grain processing applies spatial NVEncC KNN before NVENC and therefore
// disables NVENC's own temporal filter. An authenticated FGS bypass keeps the untouched
// source but also disables temporal filtering so the encoder cannot silently
// remove source texture after analysis decided not to synthesize it. Ordinary
// legacy processing keeps its established exactly-once tf_level 4 contract.
// These are distinct identities even though canonical and bypass both use tf0.
var TEMPORAL_FILTER_OPTION = '-tf_level';
var CANONICAL_POLICY = 'canonical-nvencc-knn';
var FGS_BYPASS_POLICY = 'fgs-bypass-original';
var LEGACY_POLICY = 'legacy-original';
var CANONICAL_TEMPORAL_FILTER_LEVEL = '0';
var FGS_BYPASS_TEMPORAL_FILTER_LEVEL = '0';
var LEGACY_TEMPORAL_FILTER_LEVEL = '4';
var REFERENCE_COMPARISON_ENCODER_PROFILE_ID =
    'av1-nvenc-p7-uhq-fullres-aq10-lookahead48-knn-tf0-vs-original-tf0-vs-legacy-tf4-v2';

var ENHANCED_QUALITY_FLAGS_CANONICAL = '-tune uhq -multipass fullres -spatial-aq 1 -temporal-aq 1 -aq-strength 10 -rc-lookahead 48 -lookahead_level auto -b_ref_mode middle';
var BASELINE_QUALITY_FLAGS_CANONICAL = '-tune hq -multipass fullres -spatial-aq 1 -temporal-aq 1 -aq-strength 10 -rc-lookahead 32';
var ENHANCED_QUALITY_FLAGS_LEGACY = ENHANCED_QUALITY_FLAGS_CANONICAL + ' -tf_level 4';
var BASELINE_QUALITY_FLAGS_LEGACY = BASELINE_QUALITY_FLAGS_CANONICAL + ' -tf_level 4';

function tokenize(value) {
    if (Array.isArray(value)) {
        return value.map(function (item) { return String(item); }).filter(Boolean);
    }
    return String(value == null ? '' : value).trim().split(/\s+/).filter(Boolean);
}

function temporalFilterLevels(value) {
    var tokens = tokenize(value);
    var levels = [];
    for (var index = 0; index < tokens.length; index++) {
        if (tokens[index] === TEMPORAL_FILTER_OPTION) {
            levels.push(index + 1 < tokens.length ? tokens[index + 1] : '<missing>');
        } else if (tokens[index].indexOf(TEMPORAL_FILTER_OPTION + '=') === 0 ||
                tokens[index].indexOf(TEMPORAL_FILTER_OPTION + ':') === 0) {
            levels.push('<noncanonical:' + tokens[index] + '>');
        }
    }
    return levels;
}

function assertTemporalFilterPolicy(value, policy, context) {
    var tokens = tokenize(value);
    var levels = temporalFilterLevels(tokens);
    if (policy === CANONICAL_POLICY || policy === FGS_BYPASS_POLICY) {
        var expectedTf0 = policy === CANONICAL_POLICY
            ? CANONICAL_TEMPORAL_FILTER_LEVEL : FGS_BYPASS_TEMPORAL_FILTER_LEVEL;
        if (levels.length > 1 || (levels.length === 1 && levels[0] !== expectedTf0)) {
            throw new Error((context || 'NVENC encode') + ' requires NVENC temporal filtering disabled ' +
                '(omit ' + TEMPORAL_FILTER_OPTION + ' or set it once to 0); observed ' +
                (levels.length ? levels.join(',') : 'none'));
        }
    } else if (policy === LEGACY_POLICY) {
        if (levels.length !== 1 || levels[0] !== LEGACY_TEMPORAL_FILTER_LEVEL) {
            throw new Error((context || 'NVENC encode') + ' requires exactly one ' +
                TEMPORAL_FILTER_OPTION + ' ' + LEGACY_TEMPORAL_FILTER_LEVEL + '; observed ' +
                (levels.length ? levels.join(',') : 'none'));
        }
    } else {
        throw new Error((context || 'NVENC encode') + ' has unknown temporal-filter policy ' + policy);
    }
    return tokens;
}

function appendValidatedQualityFlags(argv, value, policy, context) {
    var tokens = assertTemporalFilterPolicy(value, policy, context);
    for (var index = 0; index < tokens.length; index++) argv.push(tokens[index]);
    return argv;
}

function isAv1NvencCommand(argv) {
    var tokens = tokenize(argv);
    for (var index = 0; index < tokens.length - 1; index++) {
        if ((tokens[index] === '-c:v' || tokens[index] === '-codec:v') &&
                String(tokens[index + 1]).indexOf('av1_nvenc') !== -1) return true;
    }
    return false;
}

function assertAv1NvencCommand(argv, policy, context) {
    var tokens = tokenize(argv);
    if (isAv1NvencCommand(tokens)) {
        assertTemporalFilterPolicy(tokens, policy, context || 'AV1 NVENC command');
    }
    return tokens;
}

function qualityFlags(policy, enhanced) {
    if (policy === CANONICAL_POLICY || policy === FGS_BYPASS_POLICY) {
        return enhanced ? ENHANCED_QUALITY_FLAGS_CANONICAL : BASELINE_QUALITY_FLAGS_CANONICAL;
    }
    if (policy === LEGACY_POLICY) {
        return enhanced ? ENHANCED_QUALITY_FLAGS_LEGACY : BASELINE_QUALITY_FLAGS_LEGACY;
    }
    throw new Error('unknown NVENC temporal-filter policy ' + policy);
}

function referenceComparisonEncoderProfileId(options) {
    options = options || {};
    var codec = String(options.codec || '').trim().toLowerCase();
    var presets = Array.isArray(options.presets)
        ? options.presets.map(function (value) { return String(value).trim().toLowerCase(); }).filter(Boolean)
        : String(options.presets || '').split(',').map(function (value) {
            return value.trim().toLowerCase();
        }).filter(Boolean);
    if (codec !== 'av1_nvenc' || presets.length !== 1 || presets[0] !== 'p7' ||
            options.policy !== CANONICAL_POLICY) return null;
    var observed;
    try {
        observed = assertTemporalFilterPolicy(
            options.qualityFlags, CANONICAL_POLICY, 'reference comparison encoder profile');
    } catch (_error) {
        return null;
    }
    var withoutExplicitZero = [];
    for (var index = 0; index < observed.length; index++) {
        if (observed[index] === TEMPORAL_FILTER_OPTION &&
                observed[index + 1] === CANONICAL_TEMPORAL_FILTER_LEVEL) {
            index += 1;
        } else {
            withoutExplicitZero.push(observed[index]);
        }
    }
    if (withoutExplicitZero.join('\u0000') !==
            tokenize(ENHANCED_QUALITY_FLAGS_CANONICAL).join('\u0000')) return null;
    return REFERENCE_COMPARISON_ENCODER_PROFILE_ID;
}

module.exports = {
    TEMPORAL_FILTER_OPTION: TEMPORAL_FILTER_OPTION,
    CANONICAL_POLICY: CANONICAL_POLICY,
    FGS_BYPASS_POLICY: FGS_BYPASS_POLICY,
    LEGACY_POLICY: LEGACY_POLICY,
    CANONICAL_TEMPORAL_FILTER_LEVEL: CANONICAL_TEMPORAL_FILTER_LEVEL,
    FGS_BYPASS_TEMPORAL_FILTER_LEVEL: FGS_BYPASS_TEMPORAL_FILTER_LEVEL,
    LEGACY_TEMPORAL_FILTER_LEVEL: LEGACY_TEMPORAL_FILTER_LEVEL,
    REFERENCE_COMPARISON_ENCODER_PROFILE_ID: REFERENCE_COMPARISON_ENCODER_PROFILE_ID,
    ENHANCED_QUALITY_FLAGS_CANONICAL: ENHANCED_QUALITY_FLAGS_CANONICAL,
    BASELINE_QUALITY_FLAGS_CANONICAL: BASELINE_QUALITY_FLAGS_CANONICAL,
    ENHANCED_QUALITY_FLAGS_LEGACY: ENHANCED_QUALITY_FLAGS_LEGACY,
    BASELINE_QUALITY_FLAGS_LEGACY: BASELINE_QUALITY_FLAGS_LEGACY,
    // Backward aliases deliberately point at legacy behavior; canonical callers
    // must opt into their dedicated policy/flags.
    ENHANCED_QUALITY_FLAGS: ENHANCED_QUALITY_FLAGS_LEGACY,
    BASELINE_QUALITY_FLAGS: BASELINE_QUALITY_FLAGS_LEGACY,
    tokenize: tokenize,
    temporalFilterLevels: temporalFilterLevels,
    assertTemporalFilterPolicy: assertTemporalFilterPolicy,
    appendValidatedQualityFlags: appendValidatedQualityFlags,
    isAv1NvencCommand: isAv1NvencCommand,
    assertAv1NvencCommand: assertAv1NvencCommand,
    qualityFlags: qualityFlags,
    referenceComparisonEncoderProfileId: referenceComparisonEncoderProfileId,
};
