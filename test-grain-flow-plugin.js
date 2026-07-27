"use strict";

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const grainPlugin = require('./custom-cont-init.d/vmaf-plugin-patches/synthesizeFilmGrain/1.0.0/index.js');
const test = grainPlugin._test;

const inputDefaults = Object.fromEntries(grainPlugin.details().inputs.map((input) =>
    [input.name, input.defaultValue]));
for (const retired of [
    'pythonPath', 'workers', 'scalingGain', 'highPassSigma',
    'energyTrimFraction', 'energyTimeoutSeconds', 'energyMinDelta',
    'energyGainMin', 'energyGainMax', 'energyMaxLogMad',
    'energyMaxLogDeviation', 'energyMinLumaSpacing', 'energyMinLumaSpan',
    'energyMaxLumaSpan', 'energyMaxLogSlopePerCode', 'energyMaxGainRatio',
    'energyAggregateTolerancePct', 'energyRegionTolerancePct',
    'pipelineTimeoutMinutes', 'requireExistingGpuLock', 'lockDir',
]) {
    assert.ok(!(retired in inputDefaults), `retired direct FGS input remained exposed: ${retired}`);
}

function stream(overrides) {
    return Object.assign({
        index: 0,
        codec_name: 'av1',
        codec_type: 'video',
        width: 1920,
        height: 1080,
        coded_width: 1920,
        coded_height: 1080,
        pix_fmt: 'yuv420p10le',
        profile: 'Main',
        level: 8,
        color_range: 'tv',
        color_space: 'bt709',
        color_transfer: 'bt709',
        color_primaries: 'bt709',
        field_order: 'progressive',
        avg_frame_rate: '24000/1001',
        r_frame_rate: '24000/1001',
        sample_aspect_ratio: '1:1',
        disposition: { default: 1, attached_pic: 0 },
        tags: { language: 'eng', title: 'Main video' },
    }, overrides || {});
}

function probe(video, otherStreams) {
    const streams = [video].concat(otherStreams || []);
    return {
        streams,
        chapters: [],
        format: { duration: '100.000', format_name: 'matroska,webm', tags: { title: 'Movie' } },
    };
}

function inputDefault(name) {
    const input = grainPlugin.details().inputs.find((item) => item.name === name);
    assert(input, `missing input ${name}`);
    return input.defaultValue;
}

assert.strictEqual(inputDefault('mode'), 'disabled');
assert.strictEqual(inputDefault('sourcePathRegex'), '');
assert.strictEqual(inputDefault('reviewDir'), '/grain-pilot-review');
assert.strictEqual(inputDefault('maxOutputSizeRatioPct'), '101');
assert.match(grainPlugin.details().inputs.find((item) =>
    item.name === 'maxOutputSizeRatioPct').tooltip, /Warn/);
assert.strictEqual(grainPlugin.details().outputs.length, 4);
assert.match(grainPlugin.details().outputs[2].tooltip, /BYPASS/);

const sdr = probe(stream());
assert.strictEqual(test.colorProfile(sdr).id, 'sdr');

[
    'iec61966-2-1', 'gamma22', 'gamma28', 'smpte170m', 'smpte240m',
    'bt470bg', 'bt470m', 'bt2020-10', 'bt2020-12',
].forEach((transfer) => {
    const legacy = probe(stream({ color_transfer: transfer }));
    assert.strictEqual(test.colorProfile(legacy).id, 'sdr', transfer);
});
const contradictorySdr = probe(stream({
    color_transfer: 'smpte170m',
    side_data_list: [{ side_data_type: 'Mastering display metadata' }],
}));
assert.strictEqual(test.colorProfile(contradictorySdr).supported, false);

const pq = probe(stream({
    color_space: 'bt2020nc',
    color_transfer: 'smpte2084',
    color_primaries: 'bt2020',
}));
assert.strictEqual(test.colorProfile(pq).id, 'pq');

for (const marker of [
    'HDR10+', 'HDR10Plus', 'SMPTE2094-40', 'SMPTE ST 2094-40',
    'SMPTE ST 2094 App 4', 'SMPTE ST 2094 Application 4',
]) {
    const markers = test.dynamicHdrMarkers(stream({
        side_data_list: [{ side_data_type: marker }],
    }));
    assert.strictEqual(markers.hdr10Plus, true,
        `synthesis HDR10+ marker was not recognized: ${marker}`);
}
for (const marker of [
    'SMPTE2094-10', 'SMPTE ST 2094 App 2', 'Dynamic HDR metadata',
    'HDR Vivid metadata', 'SMPTE2094', 'HDR10',
]) {
    const source = probe(stream({
        color_space: 'bt2020nc', color_transfer: 'smpte2084', color_primaries: 'bt2020',
        side_data_list: [{ side_data_type: marker }],
    }));
    assert.strictEqual(test.dynamicHdrMarkers(source.streams[0]).hdr10Plus, false,
        `synthesis non-HDR10+ marker was misclassified: ${marker}`);
    assert.strictEqual(test.colorProfile(source).id, 'pq');
}

const hlg = probe(stream({
    color_space: 'bt2020nc',
    color_transfer: 'arib-std-b67',
    color_primaries: 'bt2020',
}));
assert.strictEqual(test.colorProfile(hlg).supported, false);
assert.match(test.colorProfile(hlg).reason, /HLG/);

const decodedSdrStream = stream({
    color_range: 'limited',
    color_space: undefined,
    color_transfer: undefined,
    color_primaries: undefined,
    tags: {
        language: 'eng',
        COLOR_RANGE: 'mpeg',
        COLOR_SPACE: 'bt709',
        COLOR_TRANSFER: 'bt709',
        COLOR_PRIMARIES: 'bt709',
    },
});
test.reconcileAv1SequenceColorEvidence(decodedSdrStream, [
    { color_range: 'tv', color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709' },
    { color_range: 'limited', color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709' },
], 'decoded SDR fixture');
assert.deepStrictEqual({
    color_range: decodedSdrStream.color_range,
    color_space: decodedSdrStream.color_space,
    color_transfer: decodedSdrStream.color_transfer,
    color_primaries: decodedSdrStream.color_primaries,
}, {
    color_range: 'tv', color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709',
});
assert.strictEqual(test.colorProfile(probe(decodedSdrStream)).id, 'sdr');

const decodedPqStream = stream({
    color_range: undefined,
    color_space: undefined,
    color_transfer: undefined,
    color_primaries: undefined,
    tags: {},
});
test.reconcileAv1SequenceColorEvidence(decodedPqStream, [
    { color_range: 'tv', color_space: 'bt2020_ncl', color_transfer: 'pq', color_primaries: 'bt2020' },
    { color_range: 'tv', color_space: 'bt2020nc', color_transfer: 'smpte2084', color_primaries: 'bt2020' },
], 'decoded PQ fixture');
assert.strictEqual(test.colorProfile(probe(decodedPqStream)).id, 'pq');

const decodedHlgStream = stream({
    color_range: undefined,
    color_space: undefined,
    color_transfer: undefined,
    color_primaries: undefined,
    tags: {},
});
test.reconcileAv1SequenceColorEvidence(decodedHlgStream, [
    { color_range: 'tv', color_space: 'bt2020nc', color_transfer: 'hlg', color_primaries: 'bt2020' },
], 'decoded HLG fixture');
assert.strictEqual(test.colorProfile(probe(decodedHlgStream)).supported, false);
assert.match(test.colorProfile(probe(decodedHlgStream)).reason, /HLG/);

assert.throws(() => test.reconcileAv1SequenceColorEvidence(
    stream({ color_primaries: 'bt709', tags: { COLOR_PRIMARIES: 'bt2020' } }),
    [{ color_primaries: 'bt709' }], 'conflicting AV1 tag fixture'
), /conflicting AV1 color_primaries evidence/);
assert.throws(() => test.reconcileAv1SequenceColorEvidence(
    stream({ color_transfer: undefined, tags: {} }),
    [{ color_transfer: 'bt709' }, { color_transfer: 'smpte2084' }],
    'conflicting AV1 frame fixture'
), /conflicting AV1 color_transfer evidence/);
assert.throws(() => test.reconcileAv1SequenceColorEvidence(
    stream(), [], 'missing AV1 frame fixture'
), /no decoded AV1 frame color evidence/);
const nonAv1Color = stream({ codec_name: 'hevc', color_transfer: undefined });
assert.strictEqual(test.reconcileAv1SequenceColorEvidence(
    nonAv1Color, [], 'non-AV1 fixture'
), nonAv1Color);

const dolbyVision = probe(stream({
    color_space: 'bt2020nc',
    color_transfer: 'smpte2084',
    color_primaries: 'bt2020',
    side_data_list: [{ side_data_type: 'DOVI configuration record', dv_profile: 8 }],
}));
assert.strictEqual(test.colorProfile(dolbyVision).supported, false);
assert.match(test.colorProfile(dolbyVision).reason, /Dolby Vision/);

function dynamicProvenance(sourceType) {
    const isDolbyVision = sourceType === 'dolby_vision';
    return {
        isHDR: true,
        vmafDynamicHdrPolicy: 'profileAwareHdr10',
        vmafDynamicHdrStaticFallbackAuthorized: true,
        vmafDynamicHdrConversion: isDolbyVision ? 'dolby_vision_to_hdr10' : 'hdr10plus_to_hdr10',
        vmafProcessingDisposition: 'transcode_static_hdr10_fallback',
        vmafProcessingDispositionReason: isDolbyVision
            ? 'dolby_vision_hdr10_compatible_base_layer'
            : 'hdr10plus_static_hdr10_base_layer',
        vmafTranscodeSucceeded: true,
        vmafTranscodeStatus: 'success',
        vmafHdrStaticMetadataVerified: true,
        isDolbyVision,
        isHDR10Plus: !isDolbyVision,
        vmafHdr10PlusStaticHdr10Compatible: !isDolbyVision,
    };
}

const staticPqWorking = probe(stream({
    codec_name: 'av1',
    color_space: 'bt2020nc',
    color_transfer: 'smpte2084',
    color_primaries: 'bt2020',
    pix_fmt: 'yuv420p10le',
    side_data_list: [{ side_data_type: 'Mastering display metadata' }],
}));
const compatibleDolbyVision = probe(stream({
    codec_name: 'hevc',
    color_space: 'bt2020nc',
    color_transfer: 'smpte2084',
    color_primaries: 'bt2020',
    pix_fmt: 'yuv420p10le',
    side_data_list: [{
        side_data_type: 'DOVI configuration record',
        dv_profile: 8,
        dv_bl_signal_compatibility_id: 1,
        bl_present_flag: 1,
        el_present_flag: 0,
        rpu_present_flag: 1,
    }],
}));
assert.strictEqual(test.colorProfile(compatibleDolbyVision).supported, false,
    'colorProfile must remain fail-closed for dynamic HDR');
const normalizedDolbyVision = test.normalizeAuthorizedDynamicHdrProfile(
    compatibleDolbyVision, test.colorProfile(staticPqWorking), staticPqWorking,
    dynamicProvenance('dolby_vision'),
);
assert(normalizedDolbyVision && normalizedDolbyVision.supported);
assert.strictEqual(normalizedDolbyVision.id, 'pq');
assert.strictEqual(normalizedDolbyVision.dynamic_hdr_normalization.source_type, 'dolby_vision');
assert.strictEqual(normalizedDolbyVision.dynamic_hdr_normalization.dolby_vision.compatibility_id, 1);
const primeLikeProvenance = dynamicProvenance('dolby_vision');
primeLikeProvenance.isHDR10Plus = true;
const primeLikeNormalizedDolbyVision = test.normalizeAuthorizedDynamicHdrProfile(
    compatibleDolbyVision, test.colorProfile(staticPqWorking), staticPqWorking,
    primeLikeProvenance,
);
assert(primeLikeNormalizedDolbyVision && primeLikeNormalizedDolbyVision.supported,
    'DOVI conversion must tolerate auxiliary HDR10+ detected only by MediaInfo');
assert.strictEqual(primeLikeNormalizedDolbyVision.dynamic_hdr_normalization.source_type, 'dolby_vision');
assert.deepStrictEqual(primeLikeNormalizedDolbyVision.dynamic_hdr_normalization.authorized_source_kinds,
    ['dolby_vision', 'hdr10_plus']);
assert.deepStrictEqual(primeLikeNormalizedDolbyVision.dynamic_hdr_normalization.detected_ffprobe_kinds,
    ['dolby_vision']);
assert.strictEqual(test.exactDynamicHdrProvenance(primeLikeProvenance).source_type, 'dolby_vision');
const compatibleDolbyVisionId6 = JSON.parse(JSON.stringify(compatibleDolbyVision));
compatibleDolbyVisionId6.streams[0].side_data_list[0].dv_bl_signal_compatibility_id = 6;
assert(test.normalizeAuthorizedDynamicHdrProfile(
    compatibleDolbyVisionId6, test.colorProfile(staticPqWorking), staticPqWorking,
    dynamicProvenance('dolby_vision'),
));

const compatibleHdr10Plus = probe(stream({
    codec_name: 'hevc',
    color_space: 'bt2020nc',
    color_transfer: 'smpte2084',
    color_primaries: 'bt2020',
    pix_fmt: 'yuv420p10le',
    side_data_list: [{ side_data_type: 'HDR10+ dynamic metadata (SMPTE 2094-40)' }],
}));
const normalizedHdr10Plus = test.normalizeAuthorizedDynamicHdrProfile(
    compatibleHdr10Plus, test.colorProfile(staticPqWorking), staticPqWorking,
    dynamicProvenance('hdr10plus'),
);
assert(normalizedHdr10Plus && normalizedHdr10Plus.supported);
assert.strictEqual(normalizedHdr10Plus.dynamic_hdr_normalization.source_type, 'hdr10plus');

const mediaInfoOnlyHdr10Plus = probe(stream({
    codec_name: 'hevc',
    color_space: 'bt2020nc',
    color_transfer: 'smpte2084',
    color_primaries: 'bt2020',
    pix_fmt: 'yuv420p10le',
    side_data_list: [],
}));
const mediaInfoOnlyHdr10PlusProvenance = dynamicProvenance('hdr10plus');
const normalizedMediaInfoOnlyHdr10Plus = test.normalizeAuthorizedDynamicHdrProfile(
    mediaInfoOnlyHdr10Plus, test.colorProfile(staticPqWorking), staticPqWorking,
    mediaInfoOnlyHdr10PlusProvenance,
);
assert(normalizedMediaInfoOnlyHdr10Plus && normalizedMediaInfoOnlyHdr10Plus.supported,
    'MediaInfo-only HDR10+ authorization must survive synthesis provenance validation');
assert.strictEqual(normalizedMediaInfoOnlyHdr10Plus.dynamic_hdr_normalization.source_type, 'hdr10plus');
assert.deepStrictEqual(normalizedMediaInfoOnlyHdr10Plus.dynamic_hdr_normalization.authorized_source_kinds,
    ['hdr10_plus']);
assert.deepStrictEqual(normalizedMediaInfoOnlyHdr10Plus.dynamic_hdr_normalization.detected_ffprobe_kinds, []);
assert.strictEqual(test.exactDynamicHdrProvenance(
    mediaInfoOnlyHdr10PlusProvenance
).source_type, 'hdr10plus');

const incompatibleDolbyVision = JSON.parse(JSON.stringify(compatibleDolbyVision));
incompatibleDolbyVision.streams[0].side_data_list[0].dv_bl_signal_compatibility_id = 0;
assert.strictEqual(test.normalizeAuthorizedDynamicHdrProfile(
    incompatibleDolbyVision, test.colorProfile(staticPqWorking), staticPqWorking,
    dynamicProvenance('dolby_vision'),
), null);
const lowBitDolbyVision = JSON.parse(JSON.stringify(compatibleDolbyVision));
lowBitDolbyVision.streams[0].pix_fmt = 'yuv410p';
assert.strictEqual(test.normalizeAuthorizedDynamicHdrProfile(
    lowBitDolbyVision, test.colorProfile(staticPqWorking), staticPqWorking,
    dynamicProvenance('dolby_vision'),
), null);
const dualDynamicSource = JSON.parse(JSON.stringify(compatibleDolbyVision));
dualDynamicSource.streams[0].side_data_list.push({ side_data_type: 'HDR10+ dynamic metadata (SMPTE 2094-40)' });
assert.strictEqual(test.normalizeAuthorizedDynamicHdrProfile(
    dualDynamicSource, test.colorProfile(staticPqWorking), staticPqWorking,
    dynamicProvenance('dolby_vision'),
), null, 'an FFprobe HDR10+ marker must match the Check HDR auxiliary flag');
const normalizedDualDynamic = test.normalizeAuthorizedDynamicHdrProfile(
    dualDynamicSource, test.colorProfile(staticPqWorking), staticPqWorking,
    primeLikeProvenance,
);
assert(normalizedDualDynamic && normalizedDualDynamic.supported,
    'authorized DOVI fallback must accept a genuine dual-dynamic-HDR source');
assert.strictEqual(normalizedDualDynamic.dynamic_hdr_normalization.source_type, 'dolby_vision');
assert.deepStrictEqual(normalizedDualDynamic.dynamic_hdr_normalization.authorized_source_kinds,
    ['dolby_vision', 'hdr10_plus']);
assert.deepStrictEqual(normalizedDualDynamic.dynamic_hdr_normalization.detected_ffprobe_kinds,
    ['dolby_vision', 'hdr10_plus']);
assert.strictEqual(test.normalizeAuthorizedDynamicHdrProfile(
    dualDynamicSource, test.colorProfile(staticPqWorking), staticPqWorking,
    dynamicProvenance('hdr10plus'),
), null, 'HDR10+ conversion must not supersede DOVI when both are present');
for (const residualMarker of [
    'HDR10+ dynamic metadata (SMPTE 2094-40)',
    'Dynamic HDR metadata',
    'HDR Dynamic Metadata',
    'SMPTE ST 2094 App 2',
    'SMPTE2094',
    'HDR Vivid metadata',
]) {
    const residualDynamicWorking = JSON.parse(JSON.stringify(staticPqWorking));
    residualDynamicWorking.streams[0].side_data_list.push({ side_data_type: residualMarker });
    assert.strictEqual(test.normalizeAuthorizedDynamicHdrProfile(
        compatibleDolbyVision, test.colorProfile(residualDynamicWorking), residualDynamicWorking,
        dynamicProvenance('dolby_vision'),
    ), null, `working static-PQ base retained residual dynamic metadata: ${residualMarker}`);
}
[
    ['vmafDynamicHdrStaticFallbackAuthorized', false],
    ['vmafDynamicHdrConversion', 'hdr10plus_to_hdr10'],
    ['vmafProcessingDisposition', 'keep_original_dynamic_hdr'],
    ['vmafProcessingDispositionReason', 'wrong_reason'],
    ['vmafTranscodeSucceeded', false],
    ['vmafTranscodeStatus', 'technical_failure'],
    ['vmafHdrStaticMetadataVerified', false],
    ['isHDR', false],
    ['vmafDynamicHdrPolicy', 'keepOriginal'],
    ['vmafHdr10PlusStaticHdr10Compatible', true],
    ['isDolbyVision', false],
].forEach(([key, value]) => {
    const provenance = dynamicProvenance('dolby_vision');
    provenance[key] = value;
    assert.strictEqual(test.normalizeAuthorizedDynamicHdrProfile(
        compatibleDolbyVision, test.colorProfile(staticPqWorking), staticPqWorking, provenance,
    ), null, `dynamic normalization accepted invalid provenance field ${key}`);
});
[
    ['vmafHdr10PlusStaticHdr10Compatible', false],
    ['isHDR10Plus', false],
    ['isDolbyVision', true],
    ['vmafProcessingDispositionReason', 'wrong_reason'],
].forEach(([key, value]) => {
    const provenance = dynamicProvenance('hdr10plus');
    provenance[key] = value;
    assert.strictEqual(test.normalizeAuthorizedDynamicHdrProfile(
        mediaInfoOnlyHdr10Plus, test.colorProfile(staticPqWorking), staticPqWorking, provenance,
    ), null, `MediaInfo-only HDR10+ accepted invalid provenance field ${key}`);
});
const lowBitMediaInfoOnlyHdr10Plus = JSON.parse(JSON.stringify(mediaInfoOnlyHdr10Plus));
lowBitMediaInfoOnlyHdr10Plus.streams[0].pix_fmt = 'yuv420p';
assert.strictEqual(test.normalizeAuthorizedDynamicHdrProfile(
    lowBitMediaInfoOnlyHdr10Plus, test.colorProfile(staticPqWorking), staticPqWorking,
    mediaInfoOnlyHdr10PlusProvenance,
), null, 'MediaInfo-only HDR10+ must retain high-bit static-base validation');

const untaggedSdr = probe(stream({
    color_space: undefined,
    color_transfer: undefined,
    color_primaries: undefined,
}));
const untaggedProfile = test.colorProfile(untaggedSdr);
assert.strictEqual(untaggedProfile.supported, false);
const normalized = test.normalizeUntaggedSdrProfile(untaggedSdr, test.colorProfile(sdr));
assert(normalized && normalized.supported);
assert.strictEqual(normalized.id, 'sdr');
assert.strictEqual(normalized.inferred, true);
assert.strictEqual(test.normalizeUntaggedSdrProfile(untaggedSdr, test.colorProfile(pq)), null);

assert.strictEqual(test.profileAllowed('sdr', 'sdrAndPq'), true);
assert.strictEqual(test.profileAllowed('pq', 'sdrOnly'), false);
assert.strictEqual(test.ensurePathAllowed('/media/library/Allowed.mkv', 'library/.*\\.mkv$'), true);
assert.strictEqual(test.ensurePathAllowed('/MEDIA/LIBRARY/ALLOWED.MKV', 'library/.*\\.mkv$'), true);
assert.strictEqual(test.ensurePathAllowed('/media/other/Skipped.mkv', 'library/'), false);
assert.throws(() => test.ensurePathAllowed('/media/test.mkv', '['), /invalid source path/);
assert.throws(() => test.ensurePathAllowed('/media/test.mkv', 'test', 'ii'), /regex flags/);
assert.strictEqual(test.requireSourceAllowlist('disabled', ''), '');
assert.strictEqual(test.requireSourceAllowlist('canary', '  Movies/  '), 'Movies/');
assert.strictEqual(test.requireSourceAllowlist('active', '^/media/Allowed/'), '^/media/Allowed/');
assert.throws(() => test.requireSourceAllowlist('canary', ''), /required in canary mode/);
assert.throws(() => test.requireSourceAllowlist('active', '   '), /required in active mode/);
assert.strictEqual(test.isMatroska(sdr, '/temp/base.mkv'), true);
assert.strictEqual(test.isMatroska(sdr, '/temp/base.mp4'), true);
assert.strictEqual(test.isMatroska(sdr, '/temp/mislabeled-source.ts'), true);
const mp4Probe = JSON.parse(JSON.stringify(sdr));
mp4Probe.format.format_name = 'mov,mp4,m4a,3gp,3g2,mj2';
assert.strictEqual(test.isMatroska(mp4Probe, '/temp/base.mkv'), false);
const unknownProbe = JSON.parse(JSON.stringify(sdr));
unknownProbe.format.format_name = 'unknown';
assert.strictEqual(test.isMatroska(unknownProbe, '/temp/base.mkv'), true);
assert.strictEqual(test.isMatroska(unknownProbe, '/temp/base.ts'), false);

for (const key of [
    'BPS', 'BPS-eng', 'DURATION', 'DURATION-jpn',
    'NUMBER_OF_FRAMES', 'NUMBER_OF_FRAMES-und',
    'NUMBER_OF_BYTES', 'NUMBER_OF_BYTES-fra',
    '_STATISTICS_WRITING_APP', '_STATISTICS_WRITING_APP-eng',
    '_STATISTICS_WRITING_DATE_UTC-eng', '_STATISTICS_TAGS-eng',
    'encoder',
]) {
    assert.strictEqual(test.isVolatileMatroskaTag(key), true,
        `generated Matroska statistics tag was treated as semantic: ${key}`);
}
for (const key of [
    'title', 'language', 'BPS-commentary', 'BPS-en', 'DURATION-custom',
    'NUMBER_OF_FRAMES-production', 'NUMBER_OF_BYTES-main-track',
    '_STATISTIC_WRITING_APP-eng', '_STATISTICSX_TAG-eng',
    'encoder-eng', 'custom-tag-eng', 'release-name',
]) {
    assert.strictEqual(test.isVolatileMatroskaTag(key), false,
        `semantic/custom metadata tag was treated as volatile: ${key}`);
}
const sourceTrackTags = {
    'BPS-eng': '1234567',
    'DURATION-eng': '01:02:03.004000000',
    'NUMBER_OF_FRAMES-eng': '89234',
    'NUMBER_OF_BYTES-eng': '7654321',
    '_STATISTICS_WRITING_APP-eng': 'mkvmerge v99',
    '_STATISTICS_WRITING_DATE_UTC-eng': '2026-07-23 00:00:00',
    '_STATISTICS_TAGS-eng': 'BPS DURATION NUMBER_OF_FRAMES NUMBER_OF_BYTES',
    encoder: 'generated encoder tag',
    title: 'Main Feature',
    language: 'eng',
    'BPS-commentary': 'semantic custom value',
    'custom-tag-eng': 'preserve this',
};
assert.deepStrictEqual(test.stableTagMap(sourceTrackTags), {
    title: 'Main Feature',
    language: 'eng',
    'bps-commentary': 'semantic custom value',
    'custom-tag-eng': 'preserve this',
});
assert.doesNotThrow(() => test.assertTagsPreserved(sourceTrackTags, {
    title: 'Main Feature',
    language: 'eng',
    'BPS-commentary': 'semantic custom value',
    'custom-tag-eng': 'preserve this',
}, 'primary video stream'));
assert.throws(() => test.assertTagsPreserved(sourceTrackTags, {
    title: 'Main Feature',
    language: 'eng',
    'custom-tag-eng': 'preserve this',
}, 'primary video stream'), /metadata tag was dropped: bps-commentary/,
'arbitrary hyphenated tags must remain preservation-gated');
const technicalAndUserVideoTags = Object.assign({}, sourceTrackTags, {
    COLOR_RANGE: 'tv',
    COLOR_SPACE: 'bt2020nc',
    COLOR_TRANSFER: 'smpte2084',
    COLOR_PRIMARIES: 'bt2020',
    HDR10_PLUS: 'technical dynamic metadata',
    MASTERING_DISPLAY_METADATA: 'technical mastering metadata',
    CODEC_PROFILE: 'Main 10',
    PIXEL_DIMENSIONS: '3840x1600',
});
assert.deepStrictEqual(test.stablePrimaryVideoUserTagMap(technicalAndUserVideoTags), {
    title: 'Main Feature',
    language: 'eng',
    'bps-commentary': 'semantic custom value',
    'custom-tag-eng': 'preserve this',
});
assert.doesNotThrow(() => test.assertPrimaryVideoUserTagsPreserved(
    technicalAndUserVideoTags, {
        title: 'Main Feature', language: 'eng',
        'BPS-commentary': 'semantic custom value',
        'custom-tag-eng': 'preserve this',
    }, 'primary video stream'),
'source technical video tags must not become semantic preservation requirements');
assert.throws(() => test.assertPrimaryVideoUserTagsPreserved(
    technicalAndUserVideoTags, {
        title: 'Main Feature', language: 'eng',
        'BPS-commentary': 'semantic custom value',
    }, 'primary video stream'), /user metadata tag was dropped: custom-tag-eng/);

const audio = stream({
    index: 1,
    codec_name: 'truehd',
    codec_type: 'audio',
    width: undefined,
    height: undefined,
    pix_fmt: undefined,
    disposition: { default: 1, attached_pic: 0 },
    tags: { language: 'jpn', title: 'Atmos' },
    extradata_hash: 'SHA256:audio',
});
const subtitle = stream({
    index: 2,
    codec_name: 'subrip',
    codec_type: 'subtitle',
    width: undefined,
    height: undefined,
    pix_fmt: undefined,
    disposition: { default: 0, forced: 1, attached_pic: 0 },
    tags: { language: 'eng', title: 'Forced' },
    extradata_hash: '',
});
const attachment = stream({
    index: 3,
    codec_name: 'ttf',
    codec_type: 'attachment',
    width: undefined,
    height: undefined,
    pix_fmt: undefined,
    disposition: { default: 0, attached_pic: 0 },
    tags: { filename: 'font.ttf', mimetype: 'application/x-truetype-font' },
    extradata_hash: 'SHA256:font',
});
const base = probe(stream(), [audio, subtitle, attachment]);
base.chapters = [{ start_time: '0.000', end_time: '10.000', tags: { title: 'Opening' } }];

const remuxArgs = test.buildRemuxArgs('/tmp/grain-video.mkv', '/temp/completed-base.mkv', '/tmp/out.mkv', base);
assert.deepStrictEqual(remuxArgs.slice(0, 9), [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', '/tmp/grain-video.mkv', '-i', '/temp/completed-base.mkv', '-map',
]);
assert(remuxArgs.includes('0:v:0'));
assert(remuxArgs.includes('1:1'));
assert(remuxArgs.includes('1:2'));
assert(remuxArgs.includes('1:3'));
assert(remuxArgs.includes('-map_chapters'));
assert(remuxArgs.includes('-copy_unknown'));
assert.deepStrictEqual(test.nonPrimaryPayloadIndexes(base), [1, 2]);

const mkvmergeRemuxArgs = test.buildMkvmergeRemuxArgs(
    '/tmp/grain-video.mkv', '/media/original.mkv', '/tmp/out.mkv', base);
assert.deepStrictEqual(mkvmergeRemuxArgs, [
    '--quiet', '--disable-track-statistics-tags', '--output', '/tmp/out.mkv', '--title', 'Movie',
    '--no-audio', '--no-subtitles', '--no-buttons', '--no-chapters',
    '--no-attachments', '--no-global-tags', '--no-track-tags', '/tmp/grain-video.mkv',
    '--no-video', '/media/original.mkv',
]);
assert(!mkvmergeRemuxArgs.includes('--date'),
    'a source without an authenticated creation date must not invent one');
assert.strictEqual(mkvmergeRemuxArgs.filter((item) => item === '--no-video').length, 1);

const noSemanticSourceIdentify = {
    container: { properties: {} },
    tracks: [{
        id: 0, type: 'video', properties: {
            language: 'und', language_ietf: 'und', default_track: true,
            forced_track: false, enabled_track: true,
        },
    }],
};
const noSemanticGrainedIdentify = {
    container: { properties: {} },
    tracks: [{
        id: 0, type: 'video', properties: {
            language: 'und', default_track: true, forced_track: false,
            enabled_track: true,
        },
    }],
};
const noSemanticOverlay = test.buildMkvPrimaryVideoSemanticOverlay(
    noSemanticSourceIdentify, noSemanticGrainedIdentify);
assert.deepStrictEqual(test.buildMkvPrimaryVideoSemanticArgs(noSemanticOverlay, null), [],
    'default/undefined source semantics must not perturb the current title remux');
assert.deepStrictEqual(test.buildMkvmergeRemuxArgs(
    '/tmp/grain-video.mkv', '/media/original.mkv', '/tmp/out.mkv', base,
    noSemanticSourceIdentify, noSemanticOverlay, null), mkvmergeRemuxArgs,
'a source with only default semantics must retain the existing remux command');

const richSemanticSourceIdentify = {
    container: { properties: { title: 'Movie' } },
    tracks: [{
        id: 7, type: 'video', codec: 'HEVC/H.265/MPEG-H', properties: {
            codec_id: 'V_MPEGH/ISO/HEVC', pixel_dimensions: '4096x1716',
            color_transfer_characteristics: 16, language: 'fra', language_ietf: 'fr-CA',
            track_name: "Director's <Cut>", default_track: false, forced_track: true,
            enabled_track: false, hearing_impaired: true, visual_impaired: true,
            text_descriptions: true, original: true, commentary: true,
            tag_custom_rating: 'PG & 13', tag_release_name: 'Festival <Master>',
            tag_color_transfer: 'smpte2084', tag_hdr10_plus: 'technical',
            tag_encoder: 'source encoder', tag_bps: '999999',
            tag_title: 'ambiguous SimpleTag title', tag_language: 'ambiguous-language',
        },
    }],
};
const richSemanticGrainedIdentify = {
    container: { properties: {} },
    tracks: [{
        id: 3, type: 'video', codec: 'AV1', properties: {
            codec_id: 'V_AV1', pixel_dimensions: '1920x804',
            color_transfer_characteristics: 1, language: 'und',
            default_track: true, forced_track: false, enabled_track: true,
        },
    }],
};
const richSemanticOverlay = test.buildMkvPrimaryVideoSemanticOverlay(
    richSemanticSourceIdentify, richSemanticGrainedIdentify);
assert.deepStrictEqual(richSemanticOverlay.custom_tags, {
    custom_rating: 'PG & 13',
    release_name: 'Festival <Master>',
});
const semanticTagPath = '/tmp/source-primary-video-tags.xml';
assert.deepStrictEqual(test.buildMkvPrimaryVideoSemanticArgs(
    richSemanticOverlay, semanticTagPath), [
    '--language', '3:fr-CA',
    '--track-name', "3:Director's <Cut>",
    '--default-track-flag', '3:0',
    '--forced-display-flag', '3:1',
    '--track-enabled-flag', '3:0',
    '--hearing-impaired-flag', '3:1',
    '--visual-impaired-flag', '3:1',
    '--text-descriptions-flag', '3:1',
    '--original-flag', '3:1',
    '--commentary-flag', '3:1',
    '--tags', `3:${semanticTagPath}`,
]);
const richSemanticRemuxArgs = test.buildMkvmergeRemuxArgs(
    '/tmp/grain-video.mkv', '/media/original.mkv', '/tmp/out.mkv', base,
    richSemanticSourceIdentify, richSemanticOverlay, semanticTagPath);
assert.deepStrictEqual(richSemanticRemuxArgs.slice(
    richSemanticRemuxArgs.indexOf('--no-track-tags') + 1,
    richSemanticRemuxArgs.indexOf('/tmp/grain-video.mkv')),
test.buildMkvPrimaryVideoSemanticArgs(richSemanticOverlay, semanticTagPath));
assert(!JSON.stringify(richSemanticRemuxArgs).includes('smpte2084'));
assert(!JSON.stringify(richSemanticRemuxArgs).includes('4096x1716'));
assert.throws(() => test.buildMkvPrimaryVideoSemanticArgs(
    richSemanticOverlay, null), /custom tags require an MKVToolNix XML path/);
const semanticTagXml = test.buildMkvmergeTrackTagsXml(richSemanticOverlay.custom_tags);
assert.match(semanticTagXml, /<Name>custom_rating<\/Name>/);
assert.match(semanticTagXml, /<String>PG &amp; 13<\/String>/);
assert.match(semanticTagXml, /<String>Festival &lt;Master&gt;<\/String>/);
assert(!/color_transfer|hdr10|encoder|<Name>bps<\/Name>/.test(semanticTagXml));
assert.throws(() => test.buildMkvmergeTrackTagsXml({}), /empty primary-video custom-tag/);
const invalidSemanticBoolean = JSON.parse(JSON.stringify(richSemanticSourceIdentify));
invalidSemanticBoolean.tracks[0].properties.commentary = 1;
assert.throws(() => test.buildMkvPrimaryVideoSemanticOverlay(
    invalidSemanticBoolean, richSemanticGrainedIdentify), /commentary is not a JSON boolean/);

const titlelessBase = JSON.parse(JSON.stringify(base));
delete titlelessBase.format.tags.title;
assert(!test.buildMkvmergeRemuxArgs(
    '/tmp/grain-video.mkv', '/media/original.mkv', '/tmp/out.mkv', titlelessBase).includes('--title'));
const identifyTitleArgs = test.buildMkvmergeRemuxArgs(
    '/tmp/grain-video.mkv', '/media/original.mkv', '/tmp/out.mkv', titlelessBase,
    { container: { properties: { title: 'Identify-authoritative title' } } });
assert.deepStrictEqual(identifyTitleArgs.slice(4, 6), ['--title', 'Identify-authoritative title']);

const datedBase = JSON.parse(JSON.stringify(base));
datedBase.format.tags.creation_time = '2020-02-03T04:05:06.123000Z';
const identifyDateArgs = test.buildMkvmergeRemuxArgs(
    '/tmp/grain-video.mkv', '/media/original.mkv', '/tmp/out.mkv', datedBase,
    { container: { properties: {
        title: 'Identify-authoritative title',
        date_utc: '2019-01-23T06:21:13Z',
    } } });
assert.strictEqual(identifyDateArgs[identifyDateArgs.indexOf('--date') + 1],
    '2019-01-23T06:21:13Z',
    'lossless mkvmerge identify date must override ffprobe metadata');
assert.strictEqual(identifyDateArgs.filter((item) => item === '--date').length, 1);
const fallbackDateArgs = test.buildMkvmergeRemuxArgs(
    '/tmp/grain-video.mkv', '/media/original.mkv', '/tmp/out.mkv', datedBase,
    { container: { properties: { date_utc: 'not-a-date' } } });
assert.strictEqual(fallbackDateArgs[fallbackDateArgs.indexOf('--date') + 1],
    '2020-02-03T04:05:06.123000Z',
    'valid ffprobe creation_time must be the identify fallback');
const invalidDateBase = JSON.parse(JSON.stringify(base));
invalidDateBase.format.tags.creation_time = 'not-a-date';
assert(!test.buildMkvmergeRemuxArgs(
    '/tmp/grain-video.mkv', '/media/original.mkv', '/tmp/out.mkv', invalidDateBase,
    { container: { properties: { date_utc: '   ' } } }).includes('--date'),
'invalid or empty timestamps must not reach mkvmerge');
assert.strictEqual(test.validMatroskaDate('2019-01-23T06:21:13.123456789Z'),
    '2019-01-23T06:21:13.123456789Z');
assert.strictEqual(test.validMatroskaDate('2019-01-23 06:21:13'), null);
assert.deepStrictEqual(test.stableTagMap({ creation_time: '2019-01-23T06:21:13Z' }), {
    creation_time: '2019-01-23T06:21:13Z',
}, 'creation_time must remain semantic metadata');
assert.throws(() => test.assertTagsPreserved(
    { creation_time: '2019-01-23T06:21:13Z' },
    { creation_time: '2026-07-23T00:00:00Z' },
    'container'), /metadata tag changed: creation_time/);
assert.throws(() => test.assertTagsPreserved(
    { creation_time: '2019-01-23T06:21:13Z' }, {}, 'container'),
/metadata tag was dropped: creation_time/);
const mutatedDateOutput = JSON.parse(JSON.stringify(datedBase));
mutatedDateOutput.format.tags.creation_time = '2026-07-23T00:00:00Z';
assert.throws(() => test.assertStreamParity(datedBase, base, mutatedDateOutput),
    /container: metadata tag changed: creation_time/,
    'a remuxed output with a mutated creation date must remain rejected');

const losslessUidProbe = test.parseMkvmergeIdentifyJson([
    '{"tracks":[',
    '{"properties":{"uid":9007199254740992}},',
    '{"properties":{"uid":9007199254740993}}',
    '],"ordinary_number":42}',
].join(''), 'lossless UID fixture');
assert.strictEqual(losslessUidProbe.tracks[0].properties.uid, '9007199254740992');
assert.strictEqual(losslessUidProbe.tracks[1].properties.uid, '9007199254740993');
assert.notStrictEqual(losslessUidProbe.tracks[0].properties.uid,
    losslessUidProbe.tracks[1].properties.uid);
assert.strictEqual(losslessUidProbe.ordinary_number, 42,
    'unrelated JSON numbers must retain their native type');
assert.throws(() => test.parseMkvmergeIdentifyJson('{not-json}', 'broken fixture'),
    /invalid JSON/);

function networkLikeMkvInventoryFixtures() {
    const source = {
        container: { supported: true, properties: { title: 'Example Container Title' } },
        errors: [], warnings: [],
        // Audio deliberately precedes video to prove matching is UID/semantic,
        // not tied to ffprobe or mux-local track order/number.
        tracks: [
            {
                id: 0, type: 'audio', codec: 'AAC',
                properties: {
                    number: 1, uid: '9007199254741001', codec_id: 'A_AAC',
                    language: 'eng', default_track: true, audio_channels: 1,
                    audio_sampling_frequency: 48000,
                },
            },
            {
                id: 1, type: 'video', codec: 'HEVC/H.265/MPEG-H',
                properties: {
                    number: 2, uid: '9007199254741002', codec_id: 'V_MPEGH/ISO/HEVC',
                    language: 'und', default_track: true, pixel_dimensions: '1920x1040',
                },
            },
            {
                id: 2, type: 'subtitles', codec: 'HDMV PGS',
                properties: {
                    number: 3, uid: '9007199254741003', codec_id: 'S_HDMV/PGS',
                    language: 'eng', default_track: false, forced_track: false,
                    content_encoding_algorithms: [0],
                },
            },
        ],
        attachments: [{
            content_type: 'image/jpeg', description: '', file_name: 'cover.jpg', size: 115232,
            properties: { uid: '9007199254741004' },
        }],
        chapters: [
            { num_entries: 7, uid: '9007199254741005' },
            { num_entries: 5, uid: '9007199254741006' },
        ],
        global_tags: [
            { num_entries: 2, uid: '9007199254741007' },
            { num_entries: 1, uid: '9007199254741008' },
        ],
    };
    const grained = {
        container: { supported: true, properties: {} },
        errors: [], warnings: [],
        tracks: [{
            id: 0, type: 'video', codec: 'AV1',
            properties: {
                number: 1, uid: '9007199254741010', codec_id: 'V_AV1',
                language: 'und', default_track: true, pixel_dimensions: '1920x1040',
                color_primaries: 1, color_transfer_characteristics: 1,
                color_matrix_coefficients: 1, color_range: 1,
            },
        }],
        attachments: [], chapters: [], global_tags: [],
    };
    const output = {
        container: { supported: true, properties: { title: 'Example Container Title' } },
        errors: [], warnings: [],
        tracks: [
            {
                id: 0, type: 'video', codec: 'AV1',
                properties: {
                    number: 1, uid: '9007199254741010', codec_id: 'V_AV1',
                    language: 'und', language_ietf: 'und', default_track: true,
                    pixel_dimensions: '1920x1040', color_primaries: 1,
                    color_transfer_characteristics: 1, color_matrix_coefficients: 1,
                    color_range: 1,
                },
            },
            // Source non-video tracks are intentionally reordered and renumbered.
            {
                id: 1, type: 'subtitles', codec: 'HDMV PGS',
                properties: {
                    number: 2, uid: '9007199254741003', codec_id: 'S_HDMV/PGS',
                    language: 'eng', language_ietf: 'en', default_track: false,
                    forced_track: false, content_encoding_algorithms: [0],
                },
            },
            {
                id: 2, type: 'audio', codec: 'AAC',
                properties: {
                    number: 3, uid: '9007199254741001', codec_id: 'A_AAC',
                    language: 'eng', language_ietf: 'en', default_track: true,
                    audio_channels: 1, audio_sampling_frequency: 48000,
                },
            },
        ],
        attachments: [{
            content_type: 'image/jpeg', description: '', file_name: 'cover.jpg', size: 115232,
            properties: { uid: '9007199254741004' },
        }],
        // Exact inventories may be reordered without changing their meaning.
        chapters: [source.chapters[1], source.chapters[0]].map((item) =>
            JSON.parse(JSON.stringify(item))),
        global_tags: [source.global_tags[1], source.global_tags[0]].map((item) =>
            JSON.parse(JSON.stringify(item))),
    };
    return { source, grained, output };
}

const mkvInventory = networkLikeMkvInventoryFixtures();
const mkvInventoryAttestation = test.verifyMkvmergeGrainInventory(
    mkvInventory.source, mkvInventory.grained, mkvInventory.output);
assert.deepStrictEqual(mkvInventoryAttestation, {
    schema: 1,
    verifier: 'mkvmerge-identify-lossless-directional-v1',
    uid_fields_lossless_decimal_strings: true,
    primary_video_tracks: 1,
    non_video_tracks: 2,
    attachments: 1,
    chapter_editions: 2,
    chapter_entries: 12,
    global_tag_sets: 2,
    primary_video_semantics: {
        language: 'und',
        language_ietf: null,
        track_name_present: false,
        semantic_flags: {
            commentary: false,
            default_track: true,
            enabled_track: true,
            forced_track: false,
            hearing_impaired: false,
            original: false,
            text_descriptions: false,
            visual_impaired: false,
        },
        safe_custom_tag_names: [],
    },
});

const semanticInventory = networkLikeMkvInventoryFixtures();
const semanticSourceVideo = semanticInventory.source.tracks.find((track) => track.type === 'video');
Object.assign(semanticSourceVideo.properties, {
    language: 'fra', language_ietf: 'fr-CA', track_name: "Director's Cut",
    default_track: false, forced_track: true, enabled_track: false,
    hearing_impaired: true, visual_impaired: true, text_descriptions: true,
    original: true, commentary: true,
    // These technical source values intentionally differ from the AV1 values and
    // must never become the validation reference for the replacement video.
    pixel_dimensions: '4096x1716', color_transfer_characteristics: 16,
    tag_custom_rating: 'PG-13', tag_release_name: 'Festival Master',
    tag_color_transfer: 'smpte2084', tag_hdr10_plus: 'technical',
    tag_encoder: 'source encoder',
});
const semanticOutputVideo = semanticInventory.output.tracks.find((track) => track.type === 'video');
Object.assign(semanticOutputVideo.properties, {
    language: 'fra', language_ietf: 'fr-CA', track_name: "Director's Cut",
    default_track: false, forced_track: true, enabled_track: false,
    hearing_impaired: true, visual_impaired: true, text_descriptions: true,
    original: true, commentary: true,
    tag_custom_rating: 'PG-13', tag_release_name: 'Festival Master',
});
const semanticInventoryAttestation = test.verifyMkvmergeGrainInventory(
    semanticInventory.source, semanticInventory.grained, semanticInventory.output);
assert.deepStrictEqual(semanticInventoryAttestation.primary_video_semantics, {
    language: 'fra',
    language_ietf: 'fr-CA',
    track_name_present: true,
    semantic_flags: {
        commentary: true,
        default_track: false,
        enabled_track: false,
        forced_track: true,
        hearing_impaired: true,
        original: true,
        text_descriptions: true,
        visual_impaired: true,
    },
    safe_custom_tag_names: ['custom_rating', 'release_name'],
});
const semanticNameDropped = JSON.parse(JSON.stringify(semanticInventory));
delete semanticNameDropped.output.tracks.find((track) => track.type === 'video').properties.track_name;
assert.throws(() => test.verifyMkvmergeGrainInventory(
    semanticNameDropped.source, semanticNameDropped.grained, semanticNameDropped.output),
    /primary video track name changed/);
const semanticFlagChanged = JSON.parse(JSON.stringify(semanticInventory));
semanticFlagChanged.output.tracks.find((track) => track.type === 'video').properties.commentary = false;
assert.throws(() => test.verifyMkvmergeGrainInventory(
    semanticFlagChanged.source, semanticFlagChanged.grained, semanticFlagChanged.output),
    /primary video commentary flag changed/);
const semanticTagDropped = JSON.parse(JSON.stringify(semanticInventory));
delete semanticTagDropped.output.tracks.find((track) => track.type === 'video').properties.tag_custom_rating;
assert.throws(() => test.verifyMkvmergeGrainInventory(
    semanticTagDropped.source, semanticTagDropped.grained, semanticTagDropped.output),
    /primary video safe custom tags changed/);
const sourceTechnicalVideoCopied = JSON.parse(JSON.stringify(semanticInventory));
sourceTechnicalVideoCopied.output.tracks.find((track) => track.type === 'video')
    .properties.pixel_dimensions = '4096x1716';
assert.throws(() => test.verifyMkvmergeGrainInventory(
    sourceTechnicalVideoCopied.source, sourceTechnicalVideoCopied.grained,
    sourceTechnicalVideoCopied.output), /primary grained video technical inventory changed/,
'copying source geometry over the grain-applied AV1 geometry must fail');

const changedTrackUid = networkLikeMkvInventoryFixtures();
changedTrackUid.output.tracks[1].properties.uid = '9007199254741002';
assert.throws(() => test.verifyMkvmergeGrainInventory(
    changedTrackUid.source, changedTrackUid.grained, changedTrackUid.output),
    /non-video track inventory changed/);
const changedPrimaryUid = networkLikeMkvInventoryFixtures();
changedPrimaryUid.output.tracks[0].properties.uid = '9007199254741011';
assert.throws(() => test.verifyMkvmergeGrainInventory(
    changedPrimaryUid.source, changedPrimaryUid.grained, changedPrimaryUid.output),
    /primary grained video technical inventory changed/);
const unsafeNumericUid = networkLikeMkvInventoryFixtures();
unsafeNumericUid.output.attachments[0].properties.uid = 9007199254741004;
assert.throws(() => test.verifyMkvmergeGrainInventory(
    unsafeNumericUid.source, unsafeNumericUid.grained, unsafeNumericUid.output),
    /UID that was not parsed losslessly/);
const missingTrackUid = networkLikeMkvInventoryFixtures();
delete missingTrackUid.output.tracks[2].properties.uid;
assert.throws(() => test.verifyMkvmergeGrainInventory(
    missingTrackUid.source, missingTrackUid.grained, missingTrackUid.output),
    /has no lossless decimal UID/);
const changedAttachment = networkLikeMkvInventoryFixtures();
changedAttachment.output.attachments[0].size += 1;
assert.throws(() => test.verifyMkvmergeGrainInventory(
    changedAttachment.source, changedAttachment.grained, changedAttachment.output),
    /attachment inventory changed/);
const changedChapter = networkLikeMkvInventoryFixtures();
changedChapter.output.chapters[0].num_entries -= 1;
assert.throws(() => test.verifyMkvmergeGrainInventory(
    changedChapter.source, changedChapter.grained, changedChapter.output),
    /chapter editions changed/);
const changedGlobalTags = networkLikeMkvInventoryFixtures();
changedGlobalTags.output.global_tags.pop();
assert.throws(() => test.verifyMkvmergeGrainInventory(
    changedGlobalTags.source, changedGlobalTags.grained, changedGlobalTags.output),
    /global tag sets changed/);
const changedSegmentTitle = networkLikeMkvInventoryFixtures();
changedSegmentTitle.output.container.properties.title = 'Changed';
assert.throws(() => test.verifyMkvmergeGrainInventory(
    changedSegmentTitle.source, changedSegmentTitle.grained, changedSegmentTitle.output),
    /segment title changed/);
const multipleSourceVideos = networkLikeMkvInventoryFixtures();
multipleSourceVideos.source.tracks.push({
    type: 'video', codec: 'HEVC/H.265/MPEG-H',
    properties: { uid: '9007199254741011', codec_id: 'V_MPEGH/ISO/HEVC' },
});
assert.throws(() => test.verifyMkvmergeGrainInventory(
    multipleSourceVideos.source, multipleSourceVideos.grained, multipleSourceVideos.output),
    /exactly one actual video track/);

const output = JSON.parse(JSON.stringify(base));
assert.doesNotThrow(() => test.assertStreamParity(base, base, output));
assert.doesNotThrow(() => test.assertChapterParity(base, output, 0.01));
const unusualSourceOrder = JSON.parse(JSON.stringify(base));
unusualSourceOrder.streams = [
    Object.assign({}, unusualSourceOrder.streams[1], { index: 0 }),
    Object.assign({}, unusualSourceOrder.streams[0], { index: 1 }),
    Object.assign({}, unusualSourceOrder.streams[3], { index: 2 }),
    Object.assign({}, unusualSourceOrder.streams[2], { index: 3 }),
];
const reorderedOutput = JSON.parse(JSON.stringify(base));
reorderedOutput.streams = [
    Object.assign({}, reorderedOutput.streams[0], { index: 0 }),
    Object.assign({}, reorderedOutput.streams[2], { index: 1 }),
    Object.assign({}, reorderedOutput.streams[1], { index: 2 }),
    Object.assign({}, reorderedOutput.streams[3], { index: 3 }),
];
assert.doesNotThrow(() => test.assertStreamParity(unusualSourceOrder, base, reorderedOutput));
assert.deepStrictEqual(test.matchAncillaryStreams(unusualSourceOrder, reorderedOutput).map((pair) => ({
    source_index: pair.source.index,
    output_index: pair.output.index,
})), [
    { source_index: 0, output_index: 2 },
    { source_index: 2, output_index: 3 },
    { source_index: 3, output_index: 1 },
]);
const reorderedPayloadChanged = JSON.parse(JSON.stringify(reorderedOutput));
reorderedPayloadChanged.streams[2].extradata_hash = 'SHA256:changed-audio';
assert.throws(() => test.assertStreamParity(unusualSourceOrder, base, reorderedPayloadChanged),
    /codec\/type\/extradata changed/);
const unsetFieldOrderOutput = JSON.parse(JSON.stringify(base));
delete unsetFieldOrderOutput.streams[0].field_order;
assert.doesNotThrow(() => test.assertStreamParity(base, base, unsetFieldOrderOutput));
const explicitInterlacedOutput = JSON.parse(JSON.stringify(base));
explicitInterlacedOutput.streams[0].field_order = 'tt';
assert.throws(() => test.assertStreamParity(base, base, explicitInterlacedOutput),
    /primary video technical metadata changed at \$\.field_order/);

const observedHdrWorking = stream({
    color_space: 'bt2020nc',
    color_transfer: 'smpte2084',
    color_primaries: 'bt2020',
    side_data_list: [{
        side_data_type: 'Mastering display metadata',
        red_x: '17/25',
        red_y: '8/25',
        green_x: '53/200',
        green_y: '69/100',
        blue_x: '3/20',
        blue_y: '3/50',
        white_point_x: '3127/10000',
        white_point_y: '329/1000',
        min_luminance: '1/10000',
        max_luminance: '1000/1',
    }],
});
const observedHdrMkvmerge = JSON.parse(JSON.stringify(observedHdrWorking));
Object.assign(observedHdrMkvmerge.side_data_list[0], {
    red_x: '11408507/16777216',
    red_y: '5368709/16777216',
    green_x: '2222981/8388608',
    green_y: '11576279/16777216',
    blue_x: '5033165/33554432',
    blue_y: '16106127/268435456',
    white_point_x: '10492471/33554432',
    white_point_y: '689963/2097152',
    min_luminance: '209800/2098000053',
});
assert.doesNotThrow(() => test.assertVideoParity(
    observedHdrWorking, observedHdrMkvmerge, 'grain-applied AV1 -> final remux'));

const materiallyChangedHdr = JSON.parse(JSON.stringify(observedHdrMkvmerge));
materiallyChangedHdr.side_data_list[0].green_x = '1/2';
assert.throws(() => test.assertVideoParity(
    observedHdrWorking, materiallyChangedHdr, 'grain-applied AV1 -> final remux'), (error) => {
    assert.match(error.message,
        /grain-applied AV1 -> final remux: primary video HDR side-data changed at \$\.hdr_side_data\[0\]\.green_x/);
    assert.match(error.message, /expected "53\/200", actual "1\/2"/);
    return true;
});

const structurallyChangedHdr = JSON.parse(JSON.stringify(observedHdrMkvmerge));
delete structurallyChangedHdr.side_data_list[0].white_point_x;
assert.throws(() => test.assertVideoParity(
    observedHdrWorking, structurallyChangedHdr, 'completed AV1 -> grain-applied AV1'),
    /completed AV1 -> grain-applied AV1: primary video HDR side-data changed at .*white_point_x.*<missing>/);

const technicallyChangedGrainedVideo = JSON.parse(JSON.stringify(observedHdrWorking));
technicallyChangedGrainedVideo.width = 3838;
assert.throws(() => test.assertVideoParity(
    observedHdrWorking, technicallyChangedGrainedVideo, 'completed AV1 -> grain-applied AV1'),
    /completed AV1 -> grain-applied AV1: primary video technical metadata changed at \$\.width .*expected 1920, actual 3838/);
output.streams[1].tags.title = 'Changed';
assert.throws(() => test.assertStreamParity(base, base, output), /metadata tag changed/);

assert.strictEqual(test.hasSemanticGrain([
    'filmgrn1',
    'E 0 1000 1 0 1',
    '\tsY 2 0 0 255 8',
].join('\n')), true);
assert.strictEqual(test.hasSemanticGrain('filmgrn1\nE 0 1000 1 0 1\n\tsY 2 0 0 255 0\n'), false);

const energy = test.energyOptionsFromInputs({});
assert.strictEqual(energy.gainMin, 0.25);
assert.strictEqual(energy.gainMax, 2.0);
assert.strictEqual(energy.minLumaSpacing, 8.0);
assert.strictEqual(energy.minLumaSpan, 24.0);
assert.strictEqual(energy.maxLumaSpan, 8.0);
assert.strictEqual(energy.maxLogSlopePerCode, 0.04);
assert.strictEqual(energy.maxGainRatio, 6.0);
assert.throws(() => test.energyOptionsFromInputs({ energyMaxGainRatio: '0.99' }),
    /invalid film-grain energy calibration configuration/);
function dynamicEnergyReport(selectedKind, detectedKinds) {
    return {
        comparison: {
            source_base_alignment: {
                dynamic_hdr_normalization: {
                    validated: true,
                    rule: 'dynamic-hdr-source-to-static-pq-base',
                    selected_kind: selectedKind,
                    selected_kind_basis: 'authenticated-provisional-artifact-v1',
                    detected_ffprobe_kinds: detectedKinds,
                    source_kinds: detectedKinds,
                    base_dynamic_metadata_absent: true,
                },
            },
        },
    };
}
assert.doesNotThrow(() => test.assertDynamicEnergyAlignment(
    dynamicEnergyReport('dolby_vision', ['dolby_vision']),
    primeLikeNormalizedDolbyVision.dynamic_hdr_normalization,
    'Prime-like dynamic alignment'
));
assert.doesNotThrow(() => test.assertDynamicEnergyAlignment(
    dynamicEnergyReport('dolby_vision', ['dolby_vision', 'hdr10_plus']),
    normalizedDualDynamic.dynamic_hdr_normalization,
    'true dual dynamic alignment'
));
assert.doesNotThrow(() => test.assertDynamicEnergyAlignment(
    dynamicEnergyReport('hdr10_plus', []),
    normalizedMediaInfoOnlyHdr10Plus.dynamic_hdr_normalization,
    'MediaInfo-only HDR10+ alignment'
));
assert.doesNotThrow(() => test.assertDynamicEnergyAlignment(
    dynamicEnergyReport('hdr10_plus', ['hdr10_plus']),
    normalizedHdr10Plus.dynamic_hdr_normalization,
    'FFprobe HDR10+ alignment'
));
for (const invalid of [
    dynamicEnergyReport('hdr10_plus', ['dolby_vision']),
    dynamicEnergyReport('dolby_vision', []),
    dynamicEnergyReport('dolby_vision', ['dolby_vision', 'hdr10_plus']),
]) {
    assert.throws(() => test.assertDynamicEnergyAlignment(
        invalid, primeLikeNormalizedDolbyVision.dynamic_hdr_normalization,
        'forged dynamic alignment'
    ), /lacks exact dynamic-HDR/);
}
const calibrateArgs = test.buildCalibrateEnergyArgs({
    pipelinePath: '/opt/grain.py', sourcePath: '/media/source.mkv',
    workingPath: '/temp/base.mkv', gain1Path: '/temp/gain1.mkv',
    fitTablePath: '/temp/fit.txt', fitManifestPath: '/temp/fit.json',
    jobDir: '/temp/job', calibratedTablePath: '/temp/calibrated.txt',
    calibrationReportPath: '/temp/calibration.json', ffmpegPath: '/bin/ffmpeg',
    ffprobePath: '/bin/ffprobe', grav1synthPath: '/bin/grav1synth',
    dynamicHdrNormalization: primeLikeNormalizedDolbyVision.dynamic_hdr_normalization, energy,
});
assert.deepStrictEqual(calibrateArgs.slice(0, 3), ['/opt/grain.py', '--operation', 'calibrate-energy']);
assert(calibrateArgs.includes('--base-source'));
assert(calibrateArgs.includes('--grained-source'));
assert(calibrateArgs.includes('--input-table'));
assert(calibrateArgs.includes('--calibration-report'));
assert.strictEqual(calibrateArgs[calibrateArgs.indexOf('--expected-dynamic-hdr-kind') + 1],
    'dolby_vision');
for (const option of [
    '--energy-min-luma-spacing',
    '--energy-min-luma-span',
    '--energy-max-luma-span',
    '--energy-max-log-slope-per-code',
    '--energy-max-gain-ratio',
]) assert(calibrateArgs.includes(option), `missing ${option}`);
const validateArgs = test.buildValidateEnergyArgs({
    pipelinePath: '/opt/grain.py', sourcePath: '/media/source.mkv',
    workingPath: '/temp/base.mkv', calibratedGrainPath: '/temp/calibrated.mkv',
    fitManifestPath: '/temp/fit.json', calibrationReportPath: '/temp/calibration.json',
    energyValidationReportPath: '/temp/energy.json', jobDir: '/temp/job',
    ffmpegPath: '/bin/ffmpeg', ffprobePath: '/bin/ffprobe',
    grav1synthPath: '/bin/grav1synth',
    dynamicHdrNormalization: normalizedMediaInfoOnlyHdr10Plus.dynamic_hdr_normalization, energy,
});
assert.deepStrictEqual(validateArgs.slice(0, 3), ['/opt/grain.py', '--operation', 'validate-energy']);
assert(validateArgs.includes('--energy-validation-report'));
assert.strictEqual(validateArgs[validateArgs.indexOf('--expected-dynamic-hdr-kind') + 1],
    'hdr10_plus');
assert(!validateArgs.includes('--input-table'));

assert.deepStrictEqual(test.assessOutputSizeRatio(1000, 1000, 101), {
    ratioPct: 100,
    qualityWarning: null,
});
const sizeWarning = test.assessOutputSizeRatio(1000, 1020, 101);
assert.strictEqual(sizeWarning.ratioPct, 102);
assert.deepStrictEqual(sizeWarning.qualityWarning, {
    code: 'grain-output-size-ratio-above-policy',
    advisory: true,
    failures: ['output is 102.000% of completed base, above the 101.000% advisory limit'],
});
assert.throws(() => test.assessOutputSizeRatio(0, 1020, 101), /size evidence/);
const qualityLogs = [];
const qualityArgs = { variables: {}, jobLog: (message) => qualityLogs.push(message) };
const qualityWarnings = [];
test.recordQualityWarning(qualityArgs, qualityWarnings, 'output-size-efficiency',
    sizeWarning.qualityWarning);
assert.strictEqual(qualityWarnings.length, 1);
assert.strictEqual(qualityArgs.variables.grainSynthesisQualityWarnings.length, 1);
assert.match(qualityLogs[0], /^!!! FILM GRAIN QUALITY WARNING/);
assert.match(qualityLogs[0], /Structural validation will continue/);

const activeRoot = path.resolve(os.tmpdir(), 'grain-active-output-contract');
const activePath = test.activeReplacementPath(
    activeRoot,
    '/media/library/Movie.Title (2026)/Movie.Title (2026).source.ts'
);
assert.strictEqual(activePath, path.join(activeRoot, 'Movie.Title (2026).source.mkv'));
assert.strictEqual(path.basename(activePath), 'Movie.Title (2026).source.mkv');
assert(!path.basename(activePath).includes('grain-output'),
    'active output basename must not expose a random grain scratch name to Replace Original File');
assert.throws(() => test.activeReplacementPath(activeRoot, ''),
    /cannot derive a safe replacement basename/);

const rollbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grain-review-rollback-'));
try {
    const reviewPaths = ['video.mkv', 'table.txt', 'validation.json'].map((name) => {
        const filePath = path.join(rollbackRoot, name);
        fs.writeFileSync(filePath, name);
        return filePath;
    });
    const rollbackArgs = {
        variables: {
            grainSynthesisReviewOutput: reviewPaths[0],
            grainSynthesisReviewTable: reviewPaths[1],
            grainSynthesisReviewFitTable: reviewPaths[1],
            grainSynthesisReviewManifest: reviewPaths[2],
            grainSynthesisReviewCalibrationReport: reviewPaths[2],
            grainSynthesisReviewEnergyValidationReport: reviewPaths[2],
            grainSynthesisValidationReport: reviewPaths[2],
            grainSynthesisValidation: { output: reviewPaths[0] },
            unrelatedVariable: 'preserve-me',
        },
    };
    assert.deepStrictEqual(test.rollbackPromotedReviewArtifacts(rollbackArgs, reviewPaths), []);
    assert.deepStrictEqual(reviewPaths, [], 'rollback must consume the promoted-path inventory');
    assert.strictEqual(fs.existsSync(path.join(rollbackRoot, 'video.mkv')), false);
    assert.strictEqual(fs.existsSync(path.join(rollbackRoot, 'table.txt')), false);
    assert.strictEqual(fs.existsSync(path.join(rollbackRoot, 'validation.json')), false);
    assert.strictEqual(rollbackArgs.variables.unrelatedVariable, 'preserve-me');
    assert.strictEqual(Object.keys(rollbackArgs.variables).some((key) =>
        key.startsWith('grainSynthesisReview')), false,
    'failed lock release must clear every review variable');
    assert.strictEqual('grainSynthesisValidationReport' in rollbackArgs.variables, false);
    assert.strictEqual('grainSynthesisValidation' in rollbackArgs.variables, false);
} finally {
    const resolvedRollbackRoot = path.resolve(rollbackRoot);
    assert(resolvedRollbackRoot.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(resolvedRollbackRoot, { recursive: true, force: true });
}

const almostSame = probe(stream());
almostSame.format.duration = '100.080';
assert.doesNotThrow(() => test.assertDurationParity(base, almostSame, 0.1, 'duration'));
almostSame.format.duration = '100.500';
assert.throws(() => test.assertDurationParity(base, almostSame, 0.1, 'duration'), /exceeds/);

async function testProcessTreeTimeout() {
    if (process.platform === 'win32') return;
    const result = await test.runProcess('/bin/sh', ['-c', 'sleep 29.321'], { timeoutMs: 100 });
    assert.strictEqual(result.timedOut, true);
    const lingering = childProcess.spawnSync('pgrep', ['-f', '^sleep 29[.]321$'], { encoding: 'utf8' });
    assert.notStrictEqual(lingering.status, 0, `timeout left orphan process: ${lingering.stdout}`);
}

testProcessTreeTimeout().then(() => {
    console.log('grain Flow plugin tests passed');
}).catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
