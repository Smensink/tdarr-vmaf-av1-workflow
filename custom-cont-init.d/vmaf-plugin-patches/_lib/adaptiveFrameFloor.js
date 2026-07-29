'use strict';

// Single source of truth for the adaptive 1%-low frame floor.
//
// The floor used to exist only inside selectBestParameters' getQualityRiskPolicy, which runs
// AFTER checkCQBracket in the flow. checkCQBracket therefore had no floor on the first cycle,
// and feasibility.evaluatePoint silently drops the 1%-low constraint when the floor is null -
// so every CQ looked feasible on mean VMAF alone and active-boundary refinement bisected a
// boundary that did not exist (Gladiator II, 2026-07-29, job Z6ErJV9Y3: four probes and 40
// minutes spent narrowing 26->27.9 while every one of those CQs was already measured 4-8
// points under an 86.30 floor).
//
// Both callers now derive the floor from this module so the numbers cannot drift apart.

// Resolution tiers, matching getQualityRiskPolicy's thresholds exactly.
function resolveTier(width, height, pixels) {
    if (width >= 3800 || height >= 1800 || pixels >= 7000000) return '4k';
    if (width >= 2500 || height >= 1300 || pixels >= 3000000) return '1440p';
    if (width >= 1700 || height >= 900 || pixels >= 1600000) return '1080p';
    if (width >= 1100 || height >= 650 || pixels >= 800000) return '720p';
    return 'sd';
}

// Pure floor table + adjustments. Keep this the only copy of these constants.
function frameFloorForTier(tier, options) {
    options = options || {};
    var isAnimation = options.isAnimation === true;
    var hdr = options.isHDR === true;
    var table = {
        '4k': isAnimation ? 84.0 : (hdr ? 86.0 : 85.5),
        '1440p': isAnimation ? 83.5 : (hdr ? 85.5 : 85.0),
        '1080p': isAnimation ? 83.0 : (hdr ? 85.0 : 84.5),
        '720p': isAnimation ? 82.5 : 83.5,
        'sd': isAnimation ? 81.5 : 82.5,
    };
    var floor = table[tier];
    if (floor === undefined) return null;
    if (options.isBluray === true && !isAnimation) floor += 0.3;
    if (options.isMovie === true && tier === '4k' && !isAnimation) floor += 0.2;
    return Math.min(94, floor);
}

function primaryVideoStream(inputFileObj) {
    var streams = (inputFileObj && inputFileObj.ffProbeData && inputFileObj.ffProbeData.streams) || [];
    for (var i = 0; i < streams.length; i++) {
        if (String(streams[i].codec_type || '').toLowerCase() === 'video') return streams[i];
    }
    return {};
}

// Derives the floor from the same job inputs getQualityRiskPolicy uses. Returns null when the
// geometry is unknown - callers must fail closed rather than treat null as "no constraint".
function resolveAdaptiveFrameFloor(inputFileObj, variables) {
    var vars = variables || {};
    var configured = Number(vars.vmafMinFrameVMAF);
    if (isFinite(configured) && configured > 0) return configured;
    var published = vars.vmafQualityRiskPolicy && Number(vars.vmafQualityRiskPolicy.adaptiveFrameFloor);
    if (isFinite(published) && published > 0) return published;

    var stream = primaryVideoStream(inputFileObj);
    var width = Number(stream.width || vars.vmafSourceWidth || 0);
    var height = Number(stream.height || vars.vmafSourceHeight || 0);
    if (!(width > 0) || !(height > 0)) return null;

    var mediaType = String(vars.vmafMediaType || '').toLowerCase();
    var sourceType = String(vars.vmafMediaSourceType || '').toLowerCase();
    var animRaw = vars.vmafMediaIsAnimation;
    return frameFloorForTier(resolveTier(width, height, width * height), {
        isHDR: !!(vars.isHDR || vars.vmafIsHDR),
        isAnimation: animRaw === true || String(animRaw).toLowerCase() === 'true',
        isBluray: sourceType.indexOf('bluray') !== -1 || sourceType.indexOf('blu-ray') !== -1,
        isMovie: mediaType.indexOf('movie') !== -1,
    });
}

module.exports = { resolveTier: resolveTier, frameFloorForTier: frameFloorForTier,
    resolveAdaptiveFrameFloor: resolveAdaptiveFrameFloor };
