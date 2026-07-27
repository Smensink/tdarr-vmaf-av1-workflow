'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const artifact = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/grainAnalysisArtifact.js');
const canonicalDenoise = require(
    './custom-cont-init.d/vmaf-plugin-patches/_lib/canonicalDenoise.js');
const analyze = require('./custom-cont-init.d/vmaf-plugin-patches/analyzeFilmGrain/1.0.0/index.js');
const extract = require('./custom-cont-init.d/vmaf-plugin-patches/extractVideoSamples/1.0.0/index.js')._test;
const synth = require('./custom-cont-init.d/vmaf-plugin-patches/synthesizeFilmGrain/1.0.0/index.js')._test;

assert.strictEqual(artifact.MINIMUM_PROXY_TIMESTAMPS, 48);

function fullFingerprint(filePath) {
    const resolved = fs.realpathSync(filePath);
    const bytes = fs.readFileSync(resolved);
    return {
        scheme: 'sha256-full-v1',
        sha256: artifact.sha256File(resolved),
        size_bytes: bytes.length,
        resolved_path: resolved,
    };
}

function write(filePath, contents) {
    fs.writeFileSync(filePath, contents);
    return filePath;
}

function video(overrides) {
    return Object.assign({
        index: 0,
        codec_type: 'video',
        codec_name: 'hevc',
        pix_fmt: 'yuv420p10le',
        color_range: 'tv',
        color_transfer: 'bt709',
        color_primaries: 'bt709',
        color_space: 'bt709',
        disposition: { attached_pic: 0 },
    }, overrides || {});
}

function defaultInput(plugin, name) {
    const input = plugin.details().inputs.find((item) => item.name === name);
    assert(input, `missing input ${name}`);
    return input.defaultValue;
}

function denoiserAttestation() {
    return {
        schema: 1,
        validated: true,
        denoise: artifact.DENOISE_FILTER,
        method: 'deterministic-noisy-control-source-vs-canonical-denoiser-psnr-mse',
        controls: ['yuv420p', 'yuv420p10le'].map((pixelFormat) => ({
            pixel_format: pixelFormat,
            frames: 12,
            mean_square_difference: 4,
            changed: true,
        })),
    };
}

function preparedRegion(timestamp, bandIndex, meanLuma) {
    return {
        timestamp,
        band_index: bandIndex,
        x: bandIndex * 16,
        y: bandIndex * 8,
        mean_luma: meanLuma,
        edge_density: 1,
        temporal_luma_stddev: 1,
        spatial_luma_stddev: 2,
        extreme_pixel_fraction: 0,
    };
}

function nativeQualification(role, candidate) {
    return {
        role,
        candidate,
        native_luma: {
            frame_count: 48,
            frame_mean_span_codes: 2,
            mean_code: candidate.mean_luma,
            median_code: candidate.mean_luma,
        },
    };
}

function nativeSupport(regions) {
    const ordered = [...regions].sort((left, right) => left.mean_luma - right.mean_luma);
    const lumas = ordered.map((candidate) => candidate.mean_luma);
    return {
        valid: true,
        coordinate: 'native-source-frame-mean-median-av1-8-bit-code',
        candidate_count: ordered.length,
        minimum_distinct_supports: ordered.length,
        distinct_support_count: ordered.length,
        minimum_spacing_codes: artifact.PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpacing,
        minimum_span_codes: artifact.PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpan,
        measured_luma_min: lumas[0],
        measured_luma_max: lumas[lumas.length - 1],
        measured_luma_span: lumas[lumas.length - 1] - lumas[0],
        ordered_luma_codes: lumas,
        clusters: ordered.map((candidate) => ({
            mean_luma_code: candidate.mean_luma,
            minimum_luma_code: candidate.mean_luma,
            maximum_luma_code: candidate.mean_luma,
            candidate_identities: [[candidate.timestamp, candidate.band_index, candidate.x, candidate.y]],
        })),
        failures: [],
    };
}

function residualQualification(role, candidate, meanSquare = 1) {
    return {
        role,
        candidate,
        source_removed: {
            frame_count: 48,
            retained_frame_count: 40,
            observed_frame_count: 48,
            numeric_frame_count: 48,
            unavailable_frame_count: 0,
            numeric_coverage: 1,
            unavailable_frame_ids: [],
            trim_fraction: artifact.PRODUCTION_FIT_SETTINGS.energyTrimFraction,
            mean_square: meanSquare,
            rms_magnitude: Math.sqrt(meanSquare),
            median_mean_square: meanSquare,
        },
    };
}

function representabilityRecords(calibrationValues, validationValues) {
    const native = [];
    const residual = [];
    for (const [role, values, timestampBase] of [
        ['curve-calibration', calibrationValues, 100],
        ['final-validation', validationValues, 200],
    ]) {
        values.forEach(([meanLuma, energy], index) => {
            const region = preparedRegion(timestampBase + index * 10, index, meanLuma);
            native.push(nativeQualification(role, region));
            residual.push(residualQualification(role, region, energy));
        });
    }
    return { native, residual };
}

function rounded(values, digits = 9) {
    const scale = 10 ** digits;
    return values.map((value) => Math.round(value * scale) / scale);
}

{
    const records = representabilityRecords([
        [53.719082, 0.5609270314463505],
        [65.26871799999999, 0.3300186376780875],
        [86.379718, 0.1438677761964602],
        [97.301098, 0.19153380823328134],
    ], [
        [57.286882, 0.2181556609486896],
        [76.134, 0.2141175907280958],
        [87.50492, 0.16314320050265713],
        [124.26278, 9.149442652424714],
    ]);
    const evidence = artifact.deriveSourceResidualRepresentability(
        records.native, records.residual
    );
    assert.strictEqual(evidence.valid, false, 'Sopranos evidence must retain the diagnostic mismatch');
    assert.strictEqual(evidence.enforcement, 'advisory-quality-model-diagnostic-v1');
    assert.strictEqual(evidence.disposition, 'continue-with-quality-warning');
    assert.deepStrictEqual(evidence.failures,
        ['median-excess-above-maximum', 'pair-excess-above-maximum']);
    assert.deepStrictEqual(evidence.quality_warning, {
        code: 'source-residual-representability-mismatch',
        advisory: true,
        failures: ['median-excess-above-maximum', 'pair-excess-above-maximum'],
    });
    assert.deepStrictEqual(rounded(evidence.pairs.map((item) =>
        item.excess_log_amplitude_gap)), [0.32947899, 0, 0.017858764, 0.854724673]);
    assert(Math.abs(evidence.median_excess - 0.17366887705711537) < 1e-12);
    assert(Math.abs(evidence.maximum_excess - 0.8547246733866587) < 1e-12);
    assert.deepStrictEqual(artifact.validateSourceResidualRepresentability(
        evidence, records.native, records.residual
    ), evidence, 'an authentic source quality-model mismatch must be advisory');
    const forgedWarning = JSON.parse(JSON.stringify(evidence));
    forgedWarning.quality_warning.failures.pop();
    assert.throws(() => artifact.validateSourceResidualRepresentability(
        forgedWarning, records.native, records.residual
    ), /representability evidence does not reproduce/,
    'advisory disposition must not weaken evidence authentication');
}

{
    const records = representabilityRecords([
        [66.76867708333333, 1.4227488758346076],
        [91.79184895833333, 0.7935528774091962],
        [106.035234375, 2.3556069925358445],
        [133.05250520833334, 1.948031109479326],
    ], [
        [70.39374479166666, 2.1121400551105998],
        [88.23014583333332, 1.1177686111826068],
        [97.83086979166667, 1.065204121182758],
        [126.35911458333334, 2.924227758936547],
    ]);
    const evidence = artifact.deriveSourceResidualRepresentability(
        records.native, records.residual
    );
    assert.strictEqual(evidence.valid, true, 'Network evidence must pass the pre-encode gate');
    assert.strictEqual(evidence.enforcement, 'advisory-quality-model-diagnostic-v1');
    assert.strictEqual(evidence.disposition, 'quality-model-supported');
    assert.strictEqual(evidence.quality_warning, null);
    assert.deepStrictEqual(rounded(evidence.pairs.map((item) =>
        item.excess_log_amplitude_gap)), [0.052552716, 0.02881662, 0.068641415, 0]);
    assert(Math.abs(evidence.median_excess - 0.04068466804895607) < 1e-12);
    assert(Math.abs(evidence.maximum_excess - 0.06864141500589849) < 1e-12);
    const reordered = artifact.deriveSourceResidualRepresentability(
        [...records.native].reverse(),
        [...records.residual.slice(3), ...records.residual.slice(0, 3)]
    );
    assert.deepStrictEqual(reordered, evidence,
        'pairing must be independent of qualification record order');
}

{
    const lumas = [40, 80, 120, 160];
    const evaluate = (excesses) => {
        const records = representabilityRecords(
            lumas.map((luma) => [luma, 1]),
            lumas.map((luma, index) => [luma, Math.exp(2 * excesses[index])])
        );
        return artifact.deriveSourceResidualRepresentability(records.native, records.residual);
    };
    const boundary = evaluate([0, 0, 0.24, 0.30]);
    assert.strictEqual(boundary.valid, true, 'policy limits must be inclusive');
    assert(Math.abs(boundary.median_excess - 0.12) < 1e-12);
    assert(Math.abs(boundary.maximum_excess - 0.30) < 1e-12);
    assert.deepStrictEqual(evaluate([0, 0, 0.240002, 0.30]).failures,
        ['median-excess-above-maximum']);
    assert.deepStrictEqual(evaluate([0, 0, 0.24, 0.300001]).failures,
        ['pair-excess-above-maximum']);
}

{
    const validRecords = () => representabilityRecords([
        [40, 1], [80, 1], [120, 1], [160, 1],
    ], [
        [40, 1], [80, 1], [120, 1], [160, 1],
    ]);
    for (const invalid of ['40', true, null, NaN, Infinity, -Infinity]) {
        const records = validRecords();
        records.native[0].native_luma.mean_code = invalid;
        assert.throws(() => artifact.deriveSourceResidualRepresentability(
            records.native, records.residual
        ), /finite JSON number/, `native mean luma must reject ${String(invalid)}`);
    }
    for (const invalid of ['1', true, null, NaN, Infinity, -Infinity]) {
        const records = validRecords();
        records.residual[0].source_removed.mean_square = invalid;
        assert.throws(() => artifact.deriveSourceResidualRepresentability(
            records.native, records.residual
        ), /finite JSON number/, `residual energy must reject ${String(invalid)}`);
    }
    for (const [field, invalid] of [
        ['timestamp', '100'],
        ['band_index', '0'],
        ['x', true],
        ['y', null],
        ['mean_luma', NaN],
        ['edge_density', Infinity],
        ['temporal_luma_stddev', -Infinity],
    ]) {
        const records = validRecords();
        records.native[0].candidate[field] = invalid;
        assert.throws(() => artifact.deriveSourceResidualRepresentability(
            records.native, records.residual
        ), /finite JSON number|JSON integer/,
        `representability candidate ${field} must reject coercion/non-finite input`);
    }

    const records = validRecords();
    const evidence = artifact.deriveSourceResidualRepresentability(
        records.native, records.residual
    );
    for (const mutate of [
        (value) => { value.pair_count = '4'; },
        (value) => { value.maximum_pair_excess = '0.3'; },
        (value) => { value.median_excess = null; },
        (value) => { value.pairs[0].rank = true; },
        (value) => { value.pairs[0].absolute_log_amplitude_gap = NaN; },
        (value) => { value.pairs[0].luma_log_amplitude_allowance = Infinity; },
    ]) {
        const recorded = JSON.parse(JSON.stringify(evidence));
        mutate(recorded);
        assert.throws(() => artifact.validateSourceResidualRepresentability(
            recorded, records.native, records.residual
        ), /representability evidence does not reproduce/);
    }
}

function lumaCalibrationFixture(calibrationRegions) {
    const lumas = [40, 80, 120, 160];
    return {
        model: 'luma-log-affine-v1',
        fit_parameter_count: 2,
        support_count: 4,
        distinct_support_count: 4,
        control_point_count: 4,
        representative_gain: 1,
        representative_gain_basis: 'aggregate-paired-residual-energy-telemetry-only',
        aggregate_energy_gain: 1,
        x_center: 100,
        center_log_gain: 0,
        log_intercept: 0,
        log_slope_per_code: 0,
        measured_luma_min: 40,
        measured_luma_max: 160,
        measured_luma_span: 120,
        regression_log_residual_mad: 0,
        maximum_log_residual: 0,
        maximum_control_log_slope_per_code: 0,
        observed_gain_ratio: 1,
        total_source_removed_grain_energy: 4,
        total_gain1_added_energy: 4,
        fit_supports: lumas.map((meanLuma, index) => ({
            mean_luma_code: meanLuma,
            gain: 1,
            region_indices: [index],
            source_removed_energy: 1,
            gain1_added_energy: 1,
        })),
        transform: {
            id: 'multiply-av1-scaling-curves-v1',
            domain: 'av1-normalized-8-bit-reconstructed-luma-code',
            interpolation: 'log-linear',
            extrapolation: 'neutral-log-taper-to-unity-at-0-and-255',
            control_points: [[0, 1], [40, 1], [160, 1], [255, 1]],
            channels: ['sY'],
            chroma_index_attestation: 'no-independent-chroma-grain-v1',
        },
        regions: lumas.map((meanLuma, index) => ({
            index,
            candidate: JSON.parse(JSON.stringify(calibrationRegions[index])),
            base_luma: {
                mean_code: meanLuma,
                frame_mean_span_codes: 2,
            },
            source_removed_mean_square: 1,
            gain1_added_mean_square: 1,
            source_removed_grain_energy: 1,
            gain1_added_energy: 1,
            source_removed_grain_rms: 1,
            gain1_added_rms: 1,
            region_gain: 1,
            predicted_gain: 1,
            log_gain_residual: 0,
        })),
    };
}

function robustCalibrationFixture(calibrationRegions) {
    const regionGain = 3;
    const logGain = Math.log(regionGain);
    return {
        model: 'robust-global-log-median-v1',
        estimator: 'exp-median-log-regional-amplitude-gain-v1',
        support_count: calibrationRegions.length,
        median_log_gain: logGain,
        unclamped_gain: regionGain,
        gain: 2,
        clamped: true,
        regions: calibrationRegions.map((candidate, index) => ({
            index,
            candidate: JSON.parse(JSON.stringify(candidate)),
            base_luma: {
                mean_code: 40 + index * 40,
                frame_mean_span_codes: 2,
            },
            source_removed_mean_square: 9,
            gain1_added_mean_square: 1,
            source_removed_grain_energy: 9,
            gain1_added_energy: 1,
            source_removed_grain_rms: 3,
            gain1_added_rms: 1,
            region_gain: regionGain,
            log_region_gain: logGain,
        })),
    };
}

assert.strictEqual(defaultInput(analyze, 'mode'), 'active');
assert.strictEqual(defaultInput(analyze, 'sourcePathRegex'), '^/media/');
assert.strictEqual(defaultInput(analyze, 'eligibleProfiles'), 'sdrAndPq');
assert.strictEqual(defaultInput(analyze, 'workRoot'), 'grain-analysis');
assert.deepStrictEqual(analyze.details().outputs.map((output) => output.number), [1, 2, 3]);
assert.strictEqual(
    analyze._test.commandTail({ stdout: 'progress output', stderr: 'decisive failure' }),
    'decisive failure',
    'analysis failures must not hide stderr when the pipeline also emitted stdout progress'
);

const fitArgs = analyze._test.buildPipelineArgsForContract({
    pipelinePath: '/opt/grain.py',
    sourcePath: '/media/source.mkv',
    jobDir: '/temp/job/grain-analysis/run',
    tablePath: '/temp/job/grain-analysis/run/table.txt',
    manifestPath: '/temp/job/grain-analysis/run/manifest.json',
    outcomePath: '/temp/job/grain-analysis/run/outcome.json',
    ffmpegPath: '/bin/ffmpeg',
    ffprobePath: '/bin/ffprobe',
    grav1synthPath: '/bin/grav1synth',
    nvenccPath: '/bin/nvencc',
    coordinatorPath: '/bin/tdarr-nvencc-knn-ffmpeg.js',
    mediaProfile: 'sdr',
});
assert.deepStrictEqual(fitArgs, [
    '/opt/grain.py',
    '--operation', 'fit-direct',
    '--source', '/media/source.mkv',
    '--workdir', '/temp/job/grain-analysis/run',
    '--output', '/temp/job/grain-analysis/run/table.txt',
    '--manifest', '/temp/job/grain-analysis/run/manifest.json',
    '--outcome', '/temp/job/grain-analysis/run/outcome.json',
    '--ffmpeg', '/bin/ffmpeg',
    '--ffprobe', '/bin/ffprobe',
    '--grav1synth', '/bin/grav1synth',
    '--nvencc', '/bin/nvencc',
    '--coordinator', '/bin/tdarr-nvencc-knn-ffmpeg.js',
    '--media-profile', 'sdr',
    '--frames', '144',
    '--max-candidates', '3',
]);
for (const retiredOption of [
    '--denoise', '--preroll', '--crop-size', '--scaling-gain',
    '--calibration', '--base-source', '--allow-external-research-reference',
]) {
    assert(!fitArgs.includes(retiredOption), `direct fit retained ${retiredOption}`);
}
assert.strictEqual(artifact.shouldUseCanonicalDenoise('prepared'), true);
assert.strictEqual(artifact.shouldUseCanonicalDenoise('no_grain'), false);
assert.strictEqual(artifact.shouldUseCanonicalDenoise('analysis_unavailable'), false);
assert.strictEqual(artifact.shouldUseCanonicalDenoise(null), false);
assert.throws(() => artifact.shouldUseCanonicalDenoise('unsafe'), /unsupported/);
const cleanAnalysisUnavailable = {
    grainAnalysisStatus: artifact.ANALYSIS_UNAVAILABLE_STATUS,
    grainAnalysisReason: 'bounded technical diagnostic',
    grainAnalysisCompletedAt: '2026-07-23T00:00:00.000Z',
};
assert.strictEqual(
    artifact.validateAnalysisUnavailableDisposition(cleanAnalysisUnavailable),
    artifact.ANALYSIS_UNAVAILABLE_STATUS);
assert.strictEqual(
    artifact.canonicalDenoiseDisposition(cleanAnalysisUnavailable),
    artifact.ANALYSIS_UNAVAILABLE_STATUS);
assert.deepStrictEqual(extract.referenceContractForVariables(cleanAnalysisUnavailable), {
    disposition: artifact.ANALYSIS_UNAVAILABLE_STATUS,
    selectorMode: 'original-fgs-bypass',
    canonical: false,
    id: 'fgs-bypass-original-tf0-v1',
    temporalPolicy: 'fgs-bypass-original',
    legacyHistory: false,
});
for (const staleKey of artifact.ANALYSIS_UNAVAILABLE_FORBIDDEN_VARIABLES) {
    assert.throws(() => artifact.canonicalDenoiseDisposition(Object.assign(
        {}, cleanAnalysisUnavailable, { [staleKey]: { stale: true } }
    )), /retained forbidden artifact references/, staleKey);
}
for (const invalidReason of ['', '   ',
    'x'.repeat(artifact.ANALYSIS_DIAGNOSTIC_MAX_CHARS + 1)]) {
    assert.throws(() => artifact.canonicalDenoiseDisposition(Object.assign(
        {}, cleanAnalysisUnavailable, { grainAnalysisReason: invalidReason }
    )), /analysis-unavailable grain reason/, 'tampered analysis-unavailable reason');
}
for (const invalidCompletedAt of [undefined, '', 'not-a-timestamp',
    '2026-07-23T00:00:00Z']) {
    const tampered = Object.assign({}, cleanAnalysisUnavailable);
    if (invalidCompletedAt === undefined) {
        delete tampered.grainAnalysisCompletedAt;
    } else {
        tampered.grainAnalysisCompletedAt = invalidCompletedAt;
    }
    assert.throws(() => artifact.canonicalDenoiseDisposition(tampered),
        /analysis-unavailable completion timestamp/,
        'tampered analysis-unavailable completion timestamp');
}
for (const status of ['disabled', 'ineligible']) {
    assert.deepStrictEqual(extract.referenceContractForVariables({ grainAnalysisStatus: status }), {
        disposition: null,
        selectorMode: 'legacy-original',
        canonical: false,
        id: 'legacy-original-tf4-v1',
        temporalPolicy: 'legacy-original',
        legacyHistory: true,
    });
}

assert.strictEqual(artifact.classifySource({ streams: [video()] }, {}, 'sdrAndPq').profile, 'sdr');
const globallyNonzeroPrimary = video({ index: 2 });
assert.strictEqual(artifact.classifySource({ streams: [
    { index: 0, codec_type: 'audio' },
    { index: 1, codec_type: 'subtitle' },
    globallyNonzeroPrimary,
] }, {}, 'sdrAndPq').eligible, true,
'non-video streams before the main video must not affect the 0:v:0 contract');
assert.strictEqual(artifact.isVideoTypeRelativeZero({ streams: [
    { index: 0, codec_type: 'audio' }, globallyNonzeroPrimary,
] }, globallyNonzeroPrimary), true);

const attachedCover = video({
    index: 0,
    disposition: { attached_pic: '1' },
    pix_fmt: 'yuvj420p',
});
const mainAfterCover = video({ index: 1 });
const coverFirstClassification = artifact.classifySource({
    streams: [attachedCover, mainAfterCover],
}, {}, 'sdrAndPq');
assert.deepStrictEqual(coverFirstClassification, {
    eligible: false,
    reason: 'primary_video_not_first_video_stream',
}, 'analysis must not let Python 0:v:0 select preceding attached cover art');
assert.strictEqual(artifact.primaryVideo({ streams: [attachedCover, mainAfterCover] }),
    mainAfterCover, 'the guard must describe the selected non-attached primary');
assert.strictEqual(artifact.classifySource({
    streams: [mainAfterCover, attachedCover],
}, {}, 'sdrAndPq').eligible, true,
'attached artwork after the main video does not change 0:v:0');
for (const transfer of ['bt2020-10', 'bt2020-12']) {
    const wideGamutSdr = artifact.classifySource({ streams: [video({
        color_transfer: transfer,
        color_primaries: 'bt2020',
        color_space: 'bt2020nc',
        pix_fmt: transfer === 'bt2020-12' ? 'yuv420p12le' : 'yuv420p10le',
    })] }, {}, 'sdrAndPq');
    assert.strictEqual(wideGamutSdr.eligible, true, `${transfer} SDR must remain grain-analysis eligible`);
    assert.strictEqual(wideGamutSdr.profile, 'sdr', `${transfer} must not be inferred as PQ`);
}
assert.strictEqual(artifact.classifySource({ streams: [video({
    color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc',
})] }, {}, 'sdrAndPq').profile, 'pq');
assert.strictEqual(artifact.classifySource({ streams: [video({ color_transfer: 'arib-std-b67' })] }, {}, 'sdrAndPq').eligible, false);

for (const marker of [
    'HDR10+', 'HDR10Plus', 'SMPTE2094-40', 'SMPTE ST 2094-40',
    'SMPTE ST 2094 App 4', 'SMPTE ST 2094 Application 4',
]) {
    assert.strictEqual(artifact.isHdr10PlusDescription(marker), true,
        `shared artifact HDR10+ marker was not recognized: ${marker}`);
    assert.strictEqual(artifact.dynamicHdrMarkers(video({
        side_data_list: [{ side_data_type: marker }],
    })).hdr10Plus, true);
}
for (const marker of [
    'SMPTE2094-10', 'SMPTE ST 2094 App 2', 'Dynamic HDR metadata',
    'HDR Vivid metadata', 'SMPTE2094', 'HDR10',
]) {
    assert.strictEqual(artifact.isHdr10PlusDescription(marker), false,
        `shared artifact non-HDR10+ marker was misclassified: ${marker}`);
    assert.strictEqual(artifact.dynamicHdrMarkers(video({
        side_data_list: [{ side_data_type: marker }],
    })).hdr10Plus, false);
}

const dynamicVideo = video({
    color_transfer: 'smpte2084',
    color_primaries: 'bt2020',
    color_space: 'bt2020nc',
    side_data_list: [{
        side_data_type: 'DOVI configuration record',
        dv_profile: 8,
        dv_bl_signal_compatibility_id: 1,
        bl_present_flag: 1,
        el_present_flag: 0,
        rpu_present_flag: 1,
    }],
});
const dynamicVariables = {
    isHDR: true,
    vmafDynamicHdrPolicy: 'profileAwareHdr10',
    vmafDynamicHdrStaticFallbackAuthorized: true,
    vmafDynamicHdrConversion: 'dolby_vision_to_hdr10',
    vmafProcessingDisposition: 'transcode_static_hdr10_fallback',
    vmafProcessingDispositionReason: 'dolby_vision_hdr10_compatible_base_layer',
    isDolbyVision: true,
    isHDR10Plus: false,
    vmafHdr10PlusStaticHdr10Compatible: false,
};
const dynamicClassification = artifact.classifySource(
    { streams: [dynamicVideo] }, dynamicVariables, 'sdrAndPq'
);
assert.strictEqual(dynamicClassification.eligible, true);
assert.strictEqual(dynamicClassification.profile, 'pq');
assert.strictEqual(dynamicClassification.dynamicEvidence.provisional, true);
assert.strictEqual(dynamicClassification.dynamicEvidence.sourceType, 'dolby_vision');
assert.deepStrictEqual(dynamicClassification.dynamicEvidence.sourceKinds, ['dolby_vision']);
assert.deepStrictEqual(dynamicClassification.dynamicEvidence.ffprobeKinds, ['dolby_vision']);

const primeLikeVariables = Object.assign({}, dynamicVariables, { isHDR10Plus: true });
const primeLikeClassification = artifact.classifySource(
    { streams: [dynamicVideo] }, primeLikeVariables, 'sdrAndPq'
);
assert.strictEqual(primeLikeClassification.eligible, true,
    'DV conversion must tolerate auxiliary MediaInfo HDR10+ evidence');
assert.strictEqual(primeLikeClassification.dynamicEvidence.sourceType, 'dolby_vision');
assert.strictEqual(primeLikeClassification.dynamicEvidence.conversion, 'dolby_vision_to_hdr10');
assert.deepStrictEqual(primeLikeClassification.dynamicEvidence.sourceKinds,
    ['dolby_vision', 'hdr10_plus']);
assert.deepStrictEqual(primeLikeClassification.dynamicEvidence.ffprobeKinds, ['dolby_vision']);

const dualMarkerVideo = JSON.parse(JSON.stringify(dynamicVideo));
dualMarkerVideo.side_data_list.push({ side_data_type: 'HDR10+ dynamic metadata (SMPTE 2094-40)' });
const dualMarkerClassification = artifact.classifySource(
    { streams: [dualMarkerVideo] }, primeLikeVariables, 'sdrAndPq'
);
assert.strictEqual(dualMarkerClassification.eligible, true,
    'authorized DV conversion must accept a genuinely dual-dynamic-HDR source');
assert.deepStrictEqual(dualMarkerClassification.dynamicEvidence.sourceKinds,
    ['dolby_vision', 'hdr10_plus']);
assert.deepStrictEqual(dualMarkerClassification.dynamicEvidence.ffprobeKinds,
    ['dolby_vision', 'hdr10_plus']);
assert.strictEqual(artifact.classifySource(
    { streams: [dualMarkerVideo] }, dynamicVariables, 'sdrAndPq'
).eligible, false, 'an FFprobe HDR10+ marker must not be hidden by a false Check HDR flag');

const mediaInfoOnlyHdr10PlusVideo = video({
    color_transfer: 'smpte2084',
    color_primaries: 'bt2020',
    color_space: 'bt2020nc',
    side_data_list: [],
});
const mediaInfoOnlyHdr10PlusVariables = {
    isHDR: true,
    vmafDynamicHdrPolicy: 'profileAwareHdr10',
    vmafDynamicHdrStaticFallbackAuthorized: true,
    vmafDynamicHdrConversion: 'hdr10plus_to_hdr10',
    vmafProcessingDisposition: 'transcode_static_hdr10_fallback',
    vmafProcessingDispositionReason: 'hdr10plus_static_hdr10_base_layer',
    isDolbyVision: false,
    isHDR10Plus: true,
    vmafHdr10PlusStaticHdr10Compatible: true,
};
const mediaInfoOnlyHdr10PlusClassification = artifact.classifySource(
    { streams: [mediaInfoOnlyHdr10PlusVideo] }, mediaInfoOnlyHdr10PlusVariables, 'sdrAndPq'
);
assert.strictEqual(mediaInfoOnlyHdr10PlusClassification.eligible, true,
    'Check HDR-authenticated MediaInfo-only HDR10+ must be provisionally eligible');
assert.strictEqual(mediaInfoOnlyHdr10PlusClassification.dynamicEvidence.sourceType, 'hdr10plus');
assert.strictEqual(mediaInfoOnlyHdr10PlusClassification.dynamicEvidence.conversion, 'hdr10plus_to_hdr10');
assert.deepStrictEqual(mediaInfoOnlyHdr10PlusClassification.dynamicEvidence.sourceKinds, ['hdr10_plus']);
assert.deepStrictEqual(mediaInfoOnlyHdr10PlusClassification.dynamicEvidence.ffprobeKinds, []);
assert.doesNotThrow(() => artifact.validateProvisionalDynamicHdrEvidence(
    mediaInfoOnlyHdr10PlusClassification.dynamicEvidence
));
for (const mutate of [
    (value) => { value.sourceKinds = []; },
    (value) => { value.ffprobeKinds = ['dolby_vision']; },
    (value) => { value.conversion = 'dolby_vision_to_hdr10'; },
]) {
    const forged = JSON.parse(JSON.stringify(mediaInfoOnlyHdr10PlusClassification.dynamicEvidence));
    mutate(forged);
    assert.throws(() => artifact.validateProvisionalDynamicHdrEvidence(forged),
        /dynamic-HDR evidence/);
}

for (const invalidVariables of [
    Object.assign({}, mediaInfoOnlyHdr10PlusVariables, { vmafHdr10PlusStaticHdr10Compatible: false }),
    Object.assign({}, mediaInfoOnlyHdr10PlusVariables, { isDolbyVision: true }),
    Object.assign({}, mediaInfoOnlyHdr10PlusVariables, { vmafDynamicHdrConversion: 'unknown_to_hdr10' }),
    Object.assign({}, mediaInfoOnlyHdr10PlusVariables, { vmafProcessingDispositionReason: 'wrong_reason' }),
]) {
    assert.strictEqual(artifact.classifySource(
        { streams: [mediaInfoOnlyHdr10PlusVideo] }, invalidVariables, 'sdrAndPq'
    ).eligible, false, 'invalid HDR10+ authorization must remain fail-closed');
}
assert.strictEqual(artifact.classifySource({ streams: [video(Object.assign(
    {}, mediaInfoOnlyHdr10PlusVideo, { pix_fmt: 'yuv420p' }
))] }, mediaInfoOnlyHdr10PlusVariables, 'sdrAndPq').eligible, false,
'MediaInfo-only HDR10+ still requires a high-bit static base');
assert.strictEqual(artifact.classifySource(
    { streams: [dynamicVideo] }, mediaInfoOnlyHdr10PlusVariables, 'sdrAndPq'
).eligible, false, 'HDR10+ conversion must be rejected when DOVI is present');

const incompatibleDynamicVideo = JSON.parse(JSON.stringify(dynamicVideo));
incompatibleDynamicVideo.side_data_list[0].dv_bl_signal_compatibility_id = 0;
assert.strictEqual(artifact.classifySource(
    { streams: [incompatibleDynamicVideo] }, primeLikeVariables, 'sdrAndPq'
).eligible, false, 'dual-flag authorization must not weaken Dolby Vision base-layer validation');
for (const invalidVariables of [
    Object.assign({}, primeLikeVariables, { isHDR: false }),
    Object.assign({}, primeLikeVariables, { vmafDynamicHdrPolicy: 'keepOriginal' }),
    Object.assign({}, primeLikeVariables, { vmafDynamicHdrPolicy: 'forgedPolicy' }),
    Object.assign({}, primeLikeVariables, { vmafHdr10PlusStaticHdr10Compatible: true }),
]) {
    assert.strictEqual(artifact.classifySource(
        { streams: [dynamicVideo] }, invalidVariables, 'sdrAndPq'
    ).eligible, false, 'impossible Check HDR Dolby Vision bundle must remain fail-closed');
}
const unauthorisedDynamic = artifact.classifySource({ streams: [dynamicVideo] }, {}, 'sdrAndPq');
assert.strictEqual(unauthorisedDynamic.eligible, false);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-grain-analysis-contract-'));
try {
    const args = { workDir: root };
    const roots = artifact.resolveJobOwnedRoot(args, 'grain-analysis', 'grain-analysis');
    assert(artifact.isWithin(root, roots.workRoot, false));
    assert.throws(
        () => artifact.resolveJobOwnedRoot(args, path.resolve(root, '..', 'escape'), 'grain-analysis'),
        /must be a child of args\.workDir/
    );

    const jobDir = fs.mkdtempSync(path.join(roots.workRoot, 'fixture-'));
    const sourcePath = write(path.join(root, 'source.mkv'), Buffer.from('source-fixture-content'));
    const pipelinePath = write(path.join(root, 'grain-pipeline.py'), '# validated test pipeline\n');
    const tablePath = write(path.join(jobDir, 'grain-table.txt'), [
        'filmgrn1',
        'E 0 10000000 1 0 1',
        '\tsY 2 0 0 255 8',
        '',
    ].join('\n'));
    const manifestPath = path.join(jobDir, 'grain-pipeline-manifest.json');
    const sourceFingerprint = artifact.sampledSourceFingerprint(sourcePath);
    const manifest = {
        schema: artifact.PIPELINE_MANIFEST_SCHEMA,
        grain_model_contract_id: artifact.SPARSE_GLOBAL_MODEL_CONTRACT_ID,
        timeline_coverage: artifact.SPARSE_GLOBAL_TIMELINE_COVERAGE,
        unseen_interval_basis: artifact.SPARSE_GLOBAL_UNSEEN_INTERVAL_BASIS,
        source: sourcePath,
        source_fingerprint: sourceFingerprint,
        source_video: { width: 3840, height: 2160, color_transfer: 'bt709', side_data_types: [] },
        pipeline: {
            version: 4,
            script: fs.realpathSync(pipelinePath),
            sha256: artifact.sha256File(pipelinePath),
        },
        comparison: {
            mode: 'hqdn3d',
            purpose: 'source-denoise-grain-fit',
            production_eligible: true,
            base_role: 'same-decode-hqdn3d-denoised-crops',
            base_source: null,
            base_fingerprint: null,
            base_video: null,
            alignment: {
                validated: true,
                method: 'same-decode split filter graph',
                sample_pairs_validated: 4,
            },
            denoiser_attestation: denoiserAttestation(),
        },
        media_profile: {
            transfer_family: 'sdr',
            selected: 'sdr-limited',
            band_selection: 'content-adaptive-sdr-1-code-quantiles',
        },
        settings: {
            denoise: artifact.DENOISE_FILTER,
            scaling_gain: 1.0,
            min_scan_coverage: 0.7,
            min_valid_tables: 3,
            clip_seconds: 2.0,
            crop_size: 640,
            crop_size_requested_maximum: 640,
            crop_size_policy: artifact.CROP_SIZE_POLICY,
            preroll: artifact.DENOISE_PREROLL_SECONDS,
            proxy_width: 480,
            proxy_fps: 2,
            minimum_proxy_timestamps: artifact.MINIMUM_PROXY_TIMESTAMPS,
            max_temporal_luma_stddev: 4,
            max_edge_density: 8,
            max_spatial_luma_stddev: 24,
            max_extreme_pixel_fraction: 0.02,
            max_native_luma_span: 8,
            high_pass_sigma: artifact.PRODUCTION_FIT_SETTINGS.highPassSigma,
            energy_trim_fraction: artifact.PRODUCTION_FIT_SETTINGS.energyTrimFraction,
            energy_min_delta: artifact.PRODUCTION_FIT_SETTINGS.minimumSourceEnergyDelta,
            sampling: {
                requested: { scan_step: 360, skip_head_tail: 180, min_spacing: 600 },
                effective: { min_spacing: 7, planned_min_spacing: 7, observed_fit_spacing: 10 },
            },
            min_heldout_regions: 4,
            requested_min_heldout_regions: 4,
            heldout_minimum_adapted: false,
        },
        scan: { attempted: artifact.MINIMUM_PROXY_TIMESTAMPS, coverage: 1.0 },
        selected: [
            preparedRegion(10, 0, 40),
            preparedRegion(20, 1, 80),
            preparedRegion(30, 2, 120),
            preparedRegion(40, 3, 160),
        ],
        calibration: {
            purpose: 'post-encode luma-curve energy calibration',
            distinct_from_fit: true,
            distinct_from_final_validation: true,
            minimum_regions: 4,
            minimum_spacing_seconds: 7,
            regions: [
                preparedRegion(50, 0, 45),
                preparedRegion(60, 1, 90),
                preparedRegion(70, 2, 135),
                preparedRegion(80, 3, 170),
            ],
        },
        heldout: {
            purpose: 'independent final post-encode energy validation',
            distinct_from_fit: true,
            minimum_regions: 4,
            requested_minimum_regions: 4,
            minimum_adapted: false,
            minimum_spacing_seconds: 7,
            regions: [
                preparedRegion(90, 0, 50),
                preparedRegion(100, 1, 95),
                preparedRegion(110, 2, 140),
                preparedRegion(120, 3, 180),
            ],
        },
        output: {
            path: tablePath,
            sha256: artifact.sha256File(tablePath),
            bytes: fs.statSync(tablePath).size,
        },
        scratch: { retained: false, path: null },
    };
    manifest.native_luma_qualification = {
        method: artifact.NATIVE_LUMA_QUALIFICATION_METHOD,
        maximum_span_codes: artifact.PRODUCTION_FIT_SETTINGS.maxNativeLumaSpan,
        minimum_curve_spacing_codes: artifact.PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpacing,
        minimum_curve_span_codes: artifact.PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpan,
        minimum_curve_distinct_supports:
            artifact.PRODUCTION_FIT_SETTINGS.minimumCurveDistinctSupports,
        calibration_support: nativeSupport(manifest.calibration.regions),
        final_validation_support: nativeSupport(manifest.heldout.regions),
        qualified: [
            ...manifest.selected.map((candidate) => nativeQualification('fit', candidate)),
            ...manifest.calibration.regions.map((candidate) =>
                nativeQualification('curve-calibration', candidate)),
            ...manifest.heldout.regions.map((candidate) =>
                nativeQualification('final-validation', candidate)),
        ],
        rejected: [],
    };
    manifest.postencode_residual_qualification = {
        method: artifact.POSTENCODE_RESIDUAL_QUALIFICATION_METHOD,
        metric: 'paired-high-pass-residual-energy-v2',
        normalized_units: '8-bit-luma-code-squared',
        denoise: artifact.DENOISE_FILTER,
        sigma: artifact.PRODUCTION_FIT_SETTINGS.highPassSigma,
        trim_fraction: artifact.PRODUCTION_FIT_SETTINGS.energyTrimFraction,
        minimum_mean_square_exclusive:
            artifact.PRODUCTION_FIT_SETTINGS.minimumSourceEnergyDelta,
        valid: true,
        qualified: [
            ...manifest.calibration.regions.map((candidate) =>
                residualQualification('curve-calibration', candidate)),
            ...manifest.heldout.regions.map((candidate) =>
                residualQualification('final-validation', candidate)),
        ],
        rejected: [],
    };
    manifest.source_residual_representability =
        artifact.deriveSourceResidualRepresentability(
            manifest.native_luma_qualification.qualified,
            manifest.postencode_residual_qualification.qualified
        );
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const prepared = artifact.buildPreparedArtifact(manifest, {
        sourcePath, tablePath, manifestPath, pipelinePath, expectedProfile: 'sdr',
    });
    assert.strictEqual(prepared.comparisonMode, 'hqdn3d');
    assert.strictEqual(prepared.scalingGain, 1);
    assert.strictEqual(prepared.regionSetContract, artifact.REGION_SET_CONTRACT);
    assert.strictEqual(prepared.grainModelContractId,
        artifact.SPARSE_GLOBAL_MODEL_CONTRACT_ID);
    assert.strictEqual(prepared.timelineCoverage,
        artifact.SPARSE_GLOBAL_TIMELINE_COVERAGE);
    assert.strictEqual(prepared.unseenIntervalBasis,
        artifact.SPARSE_GLOBAL_UNSEEN_INTERVAL_BASIS);
    assert.strictEqual(prepared.nativeLumaQualificationMethod,
        artifact.NATIVE_LUMA_QUALIFICATION_METHOD);
    assert.strictEqual(prepared.maxNativeLumaSpan,
        artifact.PRODUCTION_FIT_SETTINGS.maxNativeLumaSpan);
    assert.strictEqual(prepared.minimumCurveLumaSpacing,
        artifact.PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpacing);
    assert.strictEqual(prepared.minimumCurveLumaSpan,
        artifact.PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpan);
    assert.strictEqual(prepared.minimumCurveDistinctSupports,
        artifact.PRODUCTION_FIT_SETTINGS.minimumCurveDistinctSupports);
    assert.strictEqual(prepared.postencodeResidualQualificationMethod,
        artifact.POSTENCODE_RESIDUAL_QUALIFICATION_METHOD);
    assert.strictEqual(prepared.residualHighPassSigma,
        artifact.PRODUCTION_FIT_SETTINGS.highPassSigma);
    assert.strictEqual(prepared.residualTrimFraction,
        artifact.PRODUCTION_FIT_SETTINGS.energyTrimFraction);
    assert.strictEqual(prepared.residualMinimumEnergyDelta,
        artifact.PRODUCTION_FIT_SETTINGS.minimumSourceEnergyDelta);
    assert.strictEqual(prepared.sourceResidualRepresentabilityMethod,
        artifact.SOURCE_RESIDUAL_REPRESENTABILITY_METHOD);
    assert.strictEqual(prepared.sourceResidualMaximumMedianExcess,
        artifact.SOURCE_RESIDUAL_MAXIMUM_MEDIAN_EXCESS);
    assert.strictEqual(prepared.sourceResidualMaximumPairExcess,
        artifact.SOURCE_RESIDUAL_MAXIMUM_PAIR_EXCESS);
    assert.strictEqual(prepared.sourceResidualMedianExcess, 0);
    assert.strictEqual(prepared.sourceResidualMaximumExcess, 0);
    assert.doesNotThrow(() => artifact.validatePreparedArtifact(prepared, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }));
    assert.strictEqual(artifact.canonicalDenoiseDisposition({
        grainAnalysisStatus: 'prepared', grainAnalysisArtifact: prepared,
    }), 'prepared');
    assert.strictEqual(extract.referenceContractForVariables({
        grainAnalysisStatus: 'prepared', grainAnalysisArtifact: prepared,
    }).id, canonicalDenoise.REFERENCE_CONTRACT_ID);

    const overlappingCalibration = JSON.parse(JSON.stringify(manifest));
    overlappingCalibration.calibration.regions[0] =
        JSON.parse(JSON.stringify(overlappingCalibration.selected[0]));
    assert.throws(() => artifact.validatePreparedManifest(overlappingCalibration, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /sets overlap|windows overlap/);
    const missingNativeQualification = JSON.parse(JSON.stringify(manifest));
    missingNativeQualification.native_luma_qualification.qualified.pop();
    assert.throws(() => artifact.validatePreparedManifest(missingNativeQualification, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /does not bind every selected region/);
    const unstableNativeQualification = JSON.parse(JSON.stringify(manifest));
    unstableNativeQualification.native_luma_qualification.qualified[0]
        .native_luma.frame_mean_span_codes = 8.01;
    assert.throws(() => artifact.validatePreparedManifest(unstableNativeQualification, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /qualification evidence is invalid/);
    const narrowNativeSupport = JSON.parse(JSON.stringify(manifest));
    narrowNativeSupport.native_luma_qualification.qualified
        .filter((record) => record.role === 'curve-calibration')[1].native_luma.median_code = 46;
    assert.throws(() => artifact.validatePreparedManifest(narrowNativeSupport, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /native luma calibration\/validation support/);
    const mismatchedNativeCandidate = JSON.parse(JSON.stringify(manifest));
    mismatchedNativeCandidate.native_luma_qualification.qualified[0].candidate.mean_luma += 1;
    assert.throws(() => artifact.validatePreparedManifest(mismatchedNativeCandidate, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /qualification evidence is invalid/);
    const falseFitSpacing = JSON.parse(JSON.stringify(manifest));
    falseFitSpacing.settings.sampling.effective.min_spacing = 11;
    falseFitSpacing.settings.sampling.effective.planned_min_spacing = 11;
    falseFitSpacing.settings.sampling.effective.observed_fit_spacing = 11;
    assert.throws(() => artifact.validatePreparedManifest(falseFitSpacing, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /recorded sparse spacing/);
    const missingResidualQualification = JSON.parse(JSON.stringify(manifest));
    missingResidualQualification.postencode_residual_qualification.qualified.pop();
    assert.throws(() => artifact.validatePreparedManifest(missingResidualQualification, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /does not bind all postencode regions/);
    const weakResidualQualification = JSON.parse(JSON.stringify(manifest));
    weakResidualQualification.postencode_residual_qualification.qualified[0]
        .source_removed.mean_square = 0.05;
    weakResidualQualification.postencode_residual_qualification.qualified[0]
        .source_removed.rms_magnitude = Math.sqrt(0.05);
    assert.throws(() => artifact.validatePreparedManifest(weakResidualQualification, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /does not bind an eligible region/);
    const roleSwappedResidualQualification = JSON.parse(JSON.stringify(manifest));
    roleSwappedResidualQualification.postencode_residual_qualification.qualified[0].role =
        'final-validation';
    assert.throws(() => artifact.validatePreparedManifest(roleSwappedResidualQualification, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /does not bind an eligible region/);
    const legacySchema = JSON.parse(JSON.stringify(manifest));
    legacySchema.schema = 2;
    assert.throws(() => artifact.validatePreparedManifest(legacySchema, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /manifest schema 3 is required/);
    const coercedSchema = JSON.parse(JSON.stringify(manifest));
    coercedSchema.schema = '3';
    assert.throws(() => artifact.validatePreparedManifest(coercedSchema, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /manifest schema 3 is required/);
    const reorderedRepresentabilityPairs = JSON.parse(JSON.stringify(manifest));
    reorderedRepresentabilityPairs.source_residual_representability.pairs.reverse();
    assert.throws(() => artifact.validatePreparedManifest(reorderedRepresentabilityPairs, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /representability evidence does not reproduce/);
    const tamperedRepresentabilityNumber = JSON.parse(JSON.stringify(manifest));
    tamperedRepresentabilityNumber.source_residual_representability.median_excess += 0.001;
    assert.throws(() => artifact.validatePreparedManifest(tamperedRepresentabilityNumber, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /representability evidence does not reproduce/);
    const tamperedRepresentabilityInput = JSON.parse(JSON.stringify(manifest));
    const changedResidual = tamperedRepresentabilityInput.postencode_residual_qualification
        .qualified[0].source_removed;
    changedResidual.mean_square = 1.21;
    changedResidual.rms_magnitude = 1.1;
    changedResidual.median_mean_square = 1.21;
    assert.throws(() => artifact.validatePreparedManifest(tamperedRepresentabilityInput, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /representability evidence does not reproduce/);
    const reorderedRepresentabilityInputs = JSON.parse(JSON.stringify(manifest));
    reorderedRepresentabilityInputs.native_luma_qualification.qualified.reverse();
    const residualInputs = reorderedRepresentabilityInputs.postencode_residual_qualification.qualified;
    reorderedRepresentabilityInputs.postencode_residual_qualification.qualified = [
        ...residualInputs.slice(3), ...residualInputs.slice(0, 3),
    ];
    assert.doesNotThrow(() => artifact.validatePreparedManifest(reorderedRepresentabilityInputs, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }));
    const advisoryRepresentability = JSON.parse(JSON.stringify(manifest));
    advisoryRepresentability.postencode_residual_qualification.qualified
        .filter((record) => record.role === 'final-validation')
        .forEach((record) => {
            record.source_removed.mean_square = 4;
            record.source_removed.rms_magnitude = 2;
            record.source_removed.median_mean_square = 4;
        });
    advisoryRepresentability.source_residual_representability =
        artifact.deriveSourceResidualRepresentability(
            advisoryRepresentability.native_luma_qualification.qualified,
            advisoryRepresentability.postencode_residual_qualification.qualified
        );
    assert.strictEqual(advisoryRepresentability.source_residual_representability.valid, false);
    assert.doesNotThrow(() => artifact.validatePreparedManifest(advisoryRepresentability, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), 'an authentic representability mismatch must not reject the fit manifest');
    fs.writeFileSync(manifestPath, `${JSON.stringify(advisoryRepresentability, null, 2)}\n`);
    const advisoryPrepared = artifact.buildPreparedArtifact(advisoryRepresentability, {
        sourcePath, tablePath, manifestPath, pipelinePath, expectedProfile: 'sdr',
    });
    assert(advisoryPrepared.sourceResidualMaximumExcess >
        artifact.SOURCE_RESIDUAL_MAXIMUM_PAIR_EXCESS);
    assert.doesNotThrow(() => artifact.validatePreparedArtifact(advisoryPrepared, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), 'prepared-artifact authentication must preserve an advisory mismatch');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const wrongRegionContract = JSON.parse(JSON.stringify(prepared));
    wrongRegionContract.regionSetContract = 'two-set-legacy';
    assert.throws(() => artifact.validatePreparedArtifact(wrongRegionContract, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /prepared grain analysis artifact contract mismatch/);
    const wrongGrainModelContract = JSON.parse(JSON.stringify(prepared));
    wrongGrainModelContract.grainModelContractId = 'whole-title-stationarity-proven-v1';
    assert.throws(() => artifact.validatePreparedArtifact(wrongGrainModelContract, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /prepared grain analysis artifact contract mismatch/);
    const wrongRepresentabilityContract = JSON.parse(JSON.stringify(prepared));
    wrongRepresentabilityContract.sourceResidualMaximumPairExcess = 0.31;
    assert.throws(() => artifact.validatePreparedArtifact(wrongRepresentabilityContract, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /prepared grain analysis artifact contract mismatch/);
    const missingRepresentabilityMetric = JSON.parse(JSON.stringify(prepared));
    delete missingRepresentabilityMetric.sourceResidualMedianExcess;
    assert.throws(() => artifact.validatePreparedArtifact(missingRepresentabilityMetric, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /prepared grain analysis artifact contract mismatch/);
    const coercedPreparedSchema = JSON.parse(JSON.stringify(prepared));
    coercedPreparedSchema.schema = '1';
    assert.throws(() => artifact.validatePreparedArtifact(coercedPreparedSchema, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /prepared grain analysis artifact schema 1 is required/);
    for (const [field, value] of [
        ['grain_model_contract_id', 'whole-title-stationarity-proven-v1'],
        ['timeline_coverage', 'complete'],
        ['unseen_interval_basis', 'measured'],
    ]) {
        const overclaimedTimeline = JSON.parse(JSON.stringify(manifest));
        overclaimedTimeline[field] = value;
        assert.throws(() => artifact.buildPreparedArtifact(overclaimedTimeline, {
            sourcePath, tablePath, manifestPath, pipelinePath,
        }), /sparse global-model contract/);
    }

    const noGrainDir = fs.mkdtempSync(path.join(roots.workRoot, 'no-grain-'));
    const noGrainOutcomePath = path.join(noGrainDir, 'grain-fit-outcome.json');
    const forbiddenTablePath = path.join(noGrainDir, 'forbidden-table.txt');
    const forbiddenManifestPath = path.join(noGrainDir, 'forbidden-manifest.json');
    const exactHash = 'a'.repeat(64);
    const noGrainSelected = [0, 1, 2, 3].map((bandIndex, index) =>
        preparedRegion(10 + index * 10, bandIndex, 40 + index * 40));
    const noGrainCalibration = [
        preparedRegion(60, 0, 45),
        preparedRegion(70, 1, 85),
        preparedRegion(80, 2, 125),
        preparedRegion(90, 3, 165),
    ];
    const noGrainHeldout = [
        preparedRegion(110, 0, 50),
        preparedRegion(120, 1, 90),
        preparedRegion(130, 2, 130),
        preparedRegion(140, 3, 170),
    ];
    const exactPair = (candidate, index) => ({
        index, candidate, frames: 12, exact_identical: true,
        source_framemd5_sequence_sha256: exactHash,
        denoised_framemd5_sequence_sha256: exactHash,
    });
    const noGrainReport = {
        schema: 1,
        operation: 'fit',
        outcome: 'bypass',
        reason_code: artifact.NO_GRAIN_REASON_CODE,
        production_action: artifact.NO_GRAIN_PRODUCTION_ACTION,
        pipeline: { version: 4, ...fullFingerprint(pipelinePath) },
        input_identities: { source: artifact.sampledSourceFingerprint(sourcePath) },
        fit_settings: {
            comparison_mode: 'hqdn3d', purpose: 'source-denoise-grain-fit',
            denoise: artifact.DENOISE_FILTER, scaling_gain: 1,
            clip_seconds: 2, crop_size: 640, crop_size_requested_maximum: 640,
            crop_size_policy: artifact.CROP_SIZE_POLICY,
            preroll_seconds: artifact.DENOISE_PREROLL_SECONDS,
            minimum_fit_regions: 4, minimum_heldout_regions: 4,
            requested_minimum_heldout_regions: 4, heldout_minimum_adapted: false,
            minimum_valid_tables: 3, minimum_scan_coverage: 0.7,
            proxy_width: 480, proxy_fps: 2,
            max_temporal_luma_stddev: 4, max_edge_density: 8,
            max_spatial_luma_stddev: 24, max_extreme_pixel_fraction: 0.02,
            requested_fit_spacing_seconds: 600, requested_heldout_spacing_seconds: 5,
        },
        evidence: {
            all_canonical_pairs_exact: true,
            comparison: {
                mode: 'hqdn3d', purpose: 'source-denoise-grain-fit',
                denoise: artifact.DENOISE_FILTER,
                denoiser_attestation: denoiserAttestation(),
            },
            media_profile: { selected: 'sdr-limited', transfer_family: 'sdr' },
            sampling: { min_spacing: 7, fit_spacing: 7, observed_fit_spacing: 10, heldout_spacing: 7 },
            scan: { attempted: artifact.MINIMUM_PROXY_TIMESTAMPS, coverage: 1 },
            crop_size: 640,
            minimum_heldout_regions: 4,
            requested_minimum_heldout_regions: 4,
            heldout_minimum_adapted: false,
            selected: noGrainSelected,
            calibration: noGrainCalibration,
            heldout: noGrainHeldout,
            fit_pairs: noGrainSelected.map(exactPair),
            calibration_pairs: noGrainCalibration.map(exactPair),
            heldout_pairs: noGrainHeldout.map(exactPair),
        },
        requested_outputs: {
            table: forbiddenTablePath,
            manifest: forbiddenManifestPath,
            artifacts_published: false,
        },
    };
    fs.writeFileSync(noGrainOutcomePath, `${JSON.stringify(noGrainReport, null, 2)}\n`);
    const noGrainArtifact = artifact.buildNoGrainArtifact(noGrainReport, {
        sourcePath, pipelinePath, tablePath: forbiddenTablePath,
        manifestPath: forbiddenManifestPath, outcomePath: noGrainOutcomePath,
        expectedProfile: 'sdr',
    });
    assert.doesNotThrow(() => artifact.validateNoGrainArtifact(noGrainArtifact));

    const advisoryDir = fs.mkdtempSync(path.join(roots.workRoot, 'low-energy-advisory-'));
    const advisoryOutcomePath = path.join(advisoryDir, 'grain-fit-outcome.json');
    const advisoryTablePath = path.join(advisoryDir, 'forbidden-table.txt');
    const advisoryManifestPath = path.join(advisoryDir, 'forbidden-manifest.json');
    const changedHash = 'b'.repeat(64);
    const advisoryNative = [
        ...noGrainSelected.map((candidate) => nativeQualification('fit', candidate)),
        ...noGrainCalibration.map((candidate) => nativeQualification('curve-calibration', candidate)),
        ...noGrainHeldout.map((candidate) => nativeQualification('final-validation', candidate)),
    ];
    const advisoryResidualQualified = [
        ...noGrainCalibration.slice(1).map((candidate) =>
            residualQualification('curve-calibration', candidate, 1)),
        ...noGrainHeldout.map((candidate) =>
            residualQualification('final-validation', candidate, 1)),
    ];
    const advisoryWeak = residualQualification('curve-calibration', noGrainCalibration[0], 0.04);
    const lowEnergyReport = JSON.parse(JSON.stringify(noGrainReport));
    lowEnergyReport.reason_code = artifact.NO_GRAIN_INSUFFICIENT_ENERGY_REASON_CODE;
    Object.assign(lowEnergyReport.fit_settings, {
        max_native_luma_span: artifact.PRODUCTION_FIT_SETTINGS.maxNativeLumaSpan,
        energy_min_luma_spacing: artifact.PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpacing,
        energy_min_luma_span: artifact.PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpan,
        high_pass_sigma: artifact.PRODUCTION_FIT_SETTINGS.highPassSigma,
        energy_trim_fraction: artifact.PRODUCTION_FIT_SETTINGS.energyTrimFraction,
        energy_min_delta: artifact.PRODUCTION_FIT_SETTINGS.minimumSourceEnergyDelta,
    });
    lowEnergyReport.evidence = {
        advisory: true,
        source_grain_absence_proven: false,
        selection_exhausted: true,
        comparison: noGrainReport.evidence.comparison,
        media_profile: noGrainReport.evidence.media_profile,
        sampling: {
            ...noGrainReport.evidence.sampling,
            timestamps: Array.from({ length: artifact.MINIMUM_PROXY_TIMESTAMPS },
                (_unused, index) => index * 10),
        },
        scan: {
            attempted: artifact.MINIMUM_PROXY_TIMESTAMPS,
            successful: artifact.MINIMUM_PROXY_TIMESTAMPS,
            coverage: 1,
            failures: [],
        },
        selected: noGrainSelected,
        calibration: noGrainCalibration,
        heldout: noGrainHeldout,
        fit_pairs: noGrainSelected.map((candidate, index) => ({
            index, candidate, frames: 12, exact_identical: false,
            source_framemd5_sequence_sha256: exactHash,
            denoised_framemd5_sequence_sha256: changedHash,
        })),
        native_luma_qualification: {
            method: artifact.NATIVE_LUMA_QUALIFICATION_METHOD,
            maximum_span_codes: artifact.PRODUCTION_FIT_SETTINGS.maxNativeLumaSpan,
            minimum_curve_spacing_codes: artifact.PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpacing,
            minimum_curve_span_codes: artifact.PRODUCTION_FIT_SETTINGS.minimumCurveLumaSpan,
            minimum_curve_distinct_supports: 4,
            calibration_support: nativeSupport(noGrainCalibration),
            final_validation_support: nativeSupport(noGrainHeldout),
            qualified: advisoryNative,
            rejected: [],
        },
        postencode_residual_qualification: {
            method: artifact.POSTENCODE_RESIDUAL_QUALIFICATION_METHOD,
            metric: 'paired-high-pass-residual-energy-v2',
            normalized_units: '8-bit-luma-code-squared',
            denoise: artifact.DENOISE_FILTER,
            sigma: artifact.PRODUCTION_FIT_SETTINGS.highPassSigma,
            trim_fraction: artifact.PRODUCTION_FIT_SETTINGS.energyTrimFraction,
            minimum_mean_square_exclusive: artifact.PRODUCTION_FIT_SETTINGS.minimumSourceEnergyDelta,
            valid: false,
            qualified: advisoryResidualQualified,
            rejected: [{
                role_when_rejected: 'curve-calibration',
                candidate: advisoryWeak.candidate,
                source_removed: advisoryWeak.source_removed,
                reason: 'source-removed-energy-at-or-below-minimum',
                minimum_mean_square_exclusive: artifact.PRODUCTION_FIT_SETTINGS.minimumSourceEnergyDelta,
                excluded_from_both_postencode_roles: true,
            }],
        },
    };
    lowEnergyReport.requested_outputs = {
        table: advisoryTablePath,
        manifest: advisoryManifestPath,
        artifacts_published: false,
    };
    assert.doesNotThrow(() => artifact.validateInsufficientResidualSupportOutcome(
        lowEnergyReport, {
            sourcePath, pipelinePath, tablePath: advisoryTablePath,
            manifestPath: advisoryManifestPath, expectedProfile: 'sdr',
        }
    ));
    fs.writeFileSync(advisoryOutcomePath, `${JSON.stringify(lowEnergyReport, null, 2)}\n`);
    const lowEnergyArtifact = artifact.buildNoGrainArtifact(lowEnergyReport, {
        sourcePath, pipelinePath, tablePath: advisoryTablePath,
        manifestPath: advisoryManifestPath, outcomePath: advisoryOutcomePath,
        expectedProfile: 'sdr',
    });
    assert.strictEqual(lowEnergyArtifact.reasonCode,
        artifact.NO_GRAIN_INSUFFICIENT_ENERGY_REASON_CODE);
    assert.doesNotThrow(() => artifact.validateNoGrainArtifact(lowEnergyArtifact));
    assert.strictEqual(artifact.canonicalDenoiseDisposition({
        grainAnalysisStatus: 'no_grain', grainAnalysisNoGrainArtifact: lowEnergyArtifact,
    }), 'no_grain');
    for (const mutate of [
        (report) => { report.evidence.postencode_residual_qualification.qualified.pop(); },
        (report) => {
            report.evidence.postencode_residual_qualification.rejected[0]
                .source_removed.numeric_coverage = 0.9;
        },
        (report) => {
            report.evidence.postencode_residual_qualification.rejected[0]
                .role_when_rejected = 'final-validation';
        },
        (report) => {
            Object.assign(report.evidence.scan,
                { successful: 0, coverage: 1, failures: [] });
        },
        (report) => { report.evidence.sampling.timestamps = []; },
        (report) => { report.evidence.selected[0].edge_density = 999; },
        (report) => {
            report.evidence.native_luma_qualification.qualified[0]
                .candidate.mean_luma += 1;
        },
        (report) => {
            report.evidence.native_luma_qualification.rejected.push({ garbage: true });
        },
        (report) => { report.fit_settings.scaling_gain = '1'; },
    ]) {
        const tampered = JSON.parse(JSON.stringify(lowEnergyReport));
        mutate(tampered);
        assert.throws(() => artifact.validateInsufficientResidualSupportOutcome(tampered, {
            sourcePath, pipelinePath, tablePath: advisoryTablePath,
            manifestPath: advisoryManifestPath, expectedProfile: 'sdr',
        }), /low-energy/);
    }
    const legacyAdaptedNoGrain = JSON.parse(JSON.stringify(noGrainReport));
    legacyAdaptedNoGrain.fit_settings.minimum_heldout_regions = 2;
    legacyAdaptedNoGrain.fit_settings.heldout_minimum_adapted = true;
    legacyAdaptedNoGrain.evidence.minimum_heldout_regions = 2;
    legacyAdaptedNoGrain.evidence.heldout_minimum_adapted = true;
    assert.throws(() => artifact.validateNoGrainOutcome(legacyAdaptedNoGrain, {
        sourcePath, pipelinePath, tablePath: forbiddenTablePath,
        manifestPath: forbiddenManifestPath,
    }), /production contract/);
    const mismatchedNoGrainPair = JSON.parse(JSON.stringify(noGrainReport));
    mismatchedNoGrainPair.evidence.heldout_pairs[0].candidate.mean_luma += 1;
    assert.throws(() => artifact.validateNoGrainOutcome(mismatchedNoGrainPair, {
        sourcePath, pipelinePath, tablePath: forbiddenTablePath,
        manifestPath: forbiddenManifestPath,
    }), /not bound to its reserved region/);
    const missingNoGrainCalibrationPair = JSON.parse(JSON.stringify(noGrainReport));
    missingNoGrainCalibrationPair.evidence.calibration_pairs.pop();
    assert.throws(() => artifact.validateNoGrainOutcome(missingNoGrainCalibrationPair, {
        sourcePath, pipelinePath, tablePath: forbiddenTablePath,
        manifestPath: forbiddenManifestPath,
    }), /incomplete fit, calibration, or final-validation evidence/);
    const overlappingNoGrainCalibration = JSON.parse(JSON.stringify(noGrainReport));
    overlappingNoGrainCalibration.evidence.calibration[0] =
        JSON.parse(JSON.stringify(overlappingNoGrainCalibration.evidence.selected[0]));
    overlappingNoGrainCalibration.evidence.calibration_pairs[0].candidate =
        JSON.parse(JSON.stringify(overlappingNoGrainCalibration.evidence.selected[0]));
    assert.throws(() => artifact.validateNoGrainOutcome(overlappingNoGrainCalibration, {
        sourcePath, pipelinePath, tablePath: forbiddenTablePath,
        manifestPath: forbiddenManifestPath,
    }), /sets overlap|spacing is invalid/);
    assert.strictEqual(artifact.canonicalDenoiseDisposition({
        grainAnalysisStatus: 'no_grain', grainAnalysisNoGrainArtifact: noGrainArtifact,
    }), 'no_grain');
    assert.strictEqual(extract.referenceContractForVariables({
        grainAnalysisStatus: 'no_grain', grainAnalysisNoGrainArtifact: noGrainArtifact,
    }).id, 'fgs-bypass-original-tf0-v1');
    assert.strictEqual(extract.referenceContractForVariables({
        grainAnalysisStatus: 'no_grain', grainAnalysisNoGrainArtifact: noGrainArtifact,
    }).canonical, false);
    assert.strictEqual(extract.referenceContractForVariables({
        grainAnalysisStatus: 'no_grain', grainAnalysisNoGrainArtifact: noGrainArtifact,
    }).temporalPolicy, 'fgs-bypass-original');
    assert.throws(() => artifact.canonicalDenoiseDisposition({ grainAnalysisStatus: 'no_grain' }),
        /authenticated no-grain artifact/);
    const originalOutcome = fs.readFileSync(noGrainOutcomePath);
    fs.appendFileSync(noGrainOutcomePath, 'tampered');
    assert.throws(() => artifact.validateNoGrainArtifact(noGrainArtifact), /checksum mismatch/);
    fs.writeFileSync(noGrainOutcomePath, originalOutcome);

    const temporaryVariables = {};
    artifact.registerTemporaryFile(temporaryVariables, args, tablePath);
    artifact.registerTemporaryFile(temporaryVariables, args, manifestPath);
    assert.deepStrictEqual(temporaryVariables.vmafTemporaryFiles.sort(),
        [path.resolve(tablePath), path.resolve(manifestPath)].sort());

    const badManifest = JSON.parse(JSON.stringify(manifest));
    badManifest.comparison.production_eligible = false;
    assert.throws(() => artifact.validatePreparedManifest(badManifest, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /source-only hqdn3d/);
    const overlappingHeldout = JSON.parse(JSON.stringify(manifest));
    overlappingHeldout.heldout.regions.forEach((region) => { region.band_index = 0; });
    assert.throws(() => artifact.validatePreparedManifest(overlappingHeldout, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /enough valid luminance bands/);
    const staleBandSelection = JSON.parse(JSON.stringify(manifest));
    staleBandSelection.media_profile.band_selection = 'content-adaptive-1-code-quantiles';
    assert.throws(() => artifact.validatePreparedManifest(staleBandSelection, {
        sourcePath, tablePath, manifestPath, pipelinePath,
    }), /content-adaptive-sdr-1-code-quantiles/);
    const pqBandSelection = JSON.parse(JSON.stringify(manifest));
    pqBandSelection.media_profile.transfer_family = 'pq';
    pqBandSelection.media_profile.selected = 'pq-limited';
    pqBandSelection.media_profile.band_selection = 'content-adaptive-pq-1-code-quantiles';
    assert.doesNotThrow(() => artifact.validatePreparedManifest(pqBandSelection, {
        sourcePath, tablePath, manifestPath, pipelinePath, expectedProfile: 'pq',
    }));

    const workingPath = write(path.join(root, 'ungrained.mkv'), Buffer.from('ungrained-final-av1'));
    const gain1Path = write(path.join(jobDir, 'gain1.mkv'), Buffer.from('gain1-grained-final-av1'));
    const calibratedTablePath = write(path.join(jobDir, 'calibrated.txt'), fs.readFileSync(tablePath));
    const calibrationReportPath = path.join(jobDir, 'calibration.json');
    const energy = synth.energyOptionsFromInputs({});
    assert.doesNotThrow(() => synth.assertPreparedEnergyPolicy(prepared, energy));
    assert.throws(() => synth.assertPreparedEnergyPolicy(prepared,
        Object.assign({}, energy, { highPassSigma: 5 })), /fit-time residual qualification/);
    const calibrationReport = {
        schema: 3,
        operation: 'calibrate-energy',
        purpose: 'post-encode-content-adaptive-film-grain-energy-calibration',
        disposition: 'calibrated',
        fit_manifest: fullFingerprint(manifestPath),
        fit_table: fullFingerprint(tablePath),
        source_fingerprint: artifact.sampledSourceFingerprint(sourcePath),
        ungrained_final_av1_fingerprint: artifact.sampledSourceFingerprint(workingPath),
        gain1_grained_final_av1_fingerprint: artifact.sampledSourceFingerprint(gain1Path),
        comparison: {
            mode: 'original-vs-ungrained-and-gain1-final-av1',
            denoiser_attestation: denoiserAttestation(),
            calibration_regions: 'reserved-curve-calibration-regions',
            final_validation_regions_distinct: true,
        },
        measurement: {
            metric: 'paired-high-pass-residual-energy-v2',
            amplitude: 'sqrt(mean_square)',
            target_energy: 'highpass(original-source-minus-canonical-hqdn3d-source)',
            synthesized_energy: 'highpass(grain-enabled-decode-minus-grain-disabled-decode)',
            baseline_subtraction: 'none-paired-residual-formed-before-highpass',
            codec_error_excluded_from_grain_target: true,
            denoise: artifact.DENOISE_FILTER,
            luma_coordinate: 'native-grain-off-av1-frame-mean-code',
            clip_seconds: manifest.settings.clip_seconds,
            crop_size: manifest.settings.crop_size,
            preroll_seconds: manifest.settings.preroll,
            sigma: energy.highPassSigma,
            trim_fraction: energy.trimFraction,
            maximum_luma_span_codes: energy.maxLumaSpan,
        },
        safety: {
            gain_min: energy.gainMin,
            gain_max: energy.gainMax,
            minimum_energy_delta: energy.minimumDelta,
            maximum_log_mad: energy.maxLogMad,
            maximum_log_deviation: energy.maxLogDeviation,
            minimum_luma_spacing_codes: energy.minLumaSpacing,
            minimum_luma_span_codes: energy.minLumaSpan,
            minimum_distinct_luma_supports: manifest.calibration.regions.length,
            maximum_log_slope_per_code: energy.maxLogSlopePerCode,
            maximum_gain_ratio: energy.maxGainRatio,
        },
        calibration: lumaCalibrationFixture(manifest.calibration.regions),
        correction_selection: {
            policy: 'bounded-luma-log-affine-then-robust-global-log-median-then-fit-table-identity-v1',
            selected_model: 'luma-log-affine-v1',
            quality_warning: false,
            attempts: [{ model: 'luma-log-affine-v1', status: 'selected' }],
        },
        calibrated_table: fullFingerprint(calibratedTablePath),
    };
    fs.writeFileSync(calibrationReportPath, `${JSON.stringify(calibrationReport, null, 2)}\n`);
    assert.deepStrictEqual(synth.validateCalibrationReport(calibrationReport, {
        fitManifestPath: manifestPath,
        fitTablePath: tablePath,
        sourcePath,
        workingPath,
        gain1Path,
        calibratedTablePath,
        fitSettings: manifest.settings,
        calibrationRegions: manifest.calibration.regions,
        energy,
        dynamicHdrNormalization: null,
    }), {
        model: 'luma-log-affine-v1',
        representativeGain: 1,
        representativeGainBasis: 'aggregate-paired-residual-energy-telemetry-only',
        transformId: 'multiply-av1-scaling-curves-v1',
        controlPointCount: 4,
        channels: ['sY'],
        chromaIndexAttestation: 'no-independent-chroma-grain-v1',
        disposition: 'calibrated',
        qualityWarning: null,
    });
    assert.strictEqual(synth.tablesHaveIdenticalPayload(calibratedTablePath, tablePath), true,
        'gain-1 reuse must be authorized by exact table payload identity');
    const differentTablePath = write(path.join(jobDir, 'different-calibrated.txt'),
        `${fs.readFileSync(tablePath, 'utf8')}# different\n`);
    assert.strictEqual(synth.tablesHaveIdenticalPayload(differentTablePath, tablePath), false,
        'a distinct calibrated table must be reapplied from the ungrained base');
    for (const [section, key] of [
        ['measurement', 'sigma'],
        ['measurement', 'trim_fraction'],
        ['safety', 'gain_min'],
        ['safety', 'gain_max'],
        ['safety', 'minimum_energy_delta'],
        ['safety', 'maximum_log_mad'],
        ['safety', 'maximum_log_deviation'],
        ['safety', 'minimum_luma_spacing_codes'],
        ['safety', 'minimum_luma_span_codes'],
        ['safety', 'minimum_distinct_luma_supports'],
        ['safety', 'maximum_log_slope_per_code'],
        ['safety', 'maximum_gain_ratio'],
        ['measurement', 'maximum_luma_span_codes'],
    ]) {
        const altered = JSON.parse(JSON.stringify(calibrationReport));
        altered[section][key] = Number(altered[section][key]) + 0.01;
        assert.throws(() => synth.validateCalibrationReport(altered, {
            fitManifestPath: manifestPath,
            fitTablePath: tablePath,
            sourcePath,
            workingPath,
            gain1Path,
            calibratedTablePath,
            fitSettings: manifest.settings,
            calibrationRegions: manifest.calibration.regions,
            energy,
            dynamicHdrNormalization: null,
        }), /does not match configured policy/, `${section}.${key} was not bound to policy`);
    }
    for (const mutate of [
        (report) => { report.schema = 2; },
        (report) => { report.schema = '3'; },
        (report) => { report.measurement.amplitude = 'mean_square'; },
        (report) => { report.calibration.model = 'scalar-v1'; },
        (report) => { report.correction_selection.selected_model = 'scalar-v1'; },
        (report) => { report.correction_selection.quality_warning = true; },
        (report) => { report.calibration.transform.id = 'unknown-transform'; },
        (report) => { report.calibration.transform.control_points[1][0] = 255; },
        (report) => { report.calibration.transform.control_points[0][1] = 0.9; },
        (report) => { report.calibration.transform.channels = ['sY', 'sCb']; },
        (report) => { report.calibration.regions[0].base_luma.frame_mean_span_codes = 8.01; },
        (report) => { report.calibration.fit_supports[1].mean_luma_code = 47; },
        (report) => { report.calibration.fit_supports[1].region_indices = [0]; },
        (report) => { report.calibration.fit_supports[1].gain = 1.01; },
        (report) => { report.calibration.regions[0].candidate.mean_luma += 1; },
        (report) => { report.calibration.regions[0].source_removed_mean_square = '1'; },
        (report) => { report.calibration.representative_gain = 2.01; },
    ]) {
        const altered = JSON.parse(JSON.stringify(calibrationReport));
        mutate(altered);
        assert.throws(() => synth.validateCalibrationReport(altered, {
            fitManifestPath: manifestPath,
            fitTablePath: tablePath,
            sourcePath,
            workingPath,
            gain1Path,
            calibratedTablePath,
            fitSettings: manifest.settings,
            calibrationRegions: manifest.calibration.regions,
            energy,
            dynamicHdrNormalization: null,
        }), /schema|basis|luma|curve|transform|regional|support|policy|fallback|disposition/);
    }

    const fallbackReport = JSON.parse(JSON.stringify(calibrationReport));
    fallbackReport.disposition = 'calibrated_with_quality_model_fallback';
    fallbackReport.calibration = robustCalibrationFixture(manifest.calibration.regions);
    fallbackReport.correction_selection = {
        policy: 'bounded-luma-log-affine-then-robust-global-log-median-then-fit-table-identity-v1',
        selected_model: 'robust-global-log-median-v1',
        quality_warning: true,
        attempts: [
            {
                model: 'luma-log-affine-v1',
                status: 'rejected-quality-model-mismatch',
                reason_code: 'regional-gain-outside-safe-bounds',
                message: 'regional adaptive gain 3.0000 is outside safe bounds [0.2500, 2.0000]',
            },
            { model: 'robust-global-log-median-v1', status: 'selected' },
        ],
    };
    assert.deepStrictEqual(synth.validateCalibrationReport(fallbackReport, {
        fitManifestPath: manifestPath,
        fitTablePath: tablePath,
        sourcePath,
        workingPath,
        gain1Path,
        calibratedTablePath,
        fitSettings: manifest.settings,
        calibrationRegions: manifest.calibration.regions,
        energy,
        dynamicHdrNormalization: null,
    }), {
        model: 'robust-global-log-median-v1',
        representativeGain: 2,
        representativeGainBasis: 'exp-median-log-regional-amplitude-gain-v1',
        transformId: null,
        controlPointCount: 0,
        channels: [],
        chromaIndexAttestation: null,
        disposition: 'calibrated_with_quality_model_fallback',
        qualityWarning: {
            code: 'postencode-calibration-quality-model-fallback',
            advisory: true,
            reason_code: 'regional-gain-outside-safe-bounds',
            message: 'regional adaptive gain 3.0000 is outside safe bounds [0.2500, 2.0000]',
        },
    }, 'a bounded scalar fallback must remain authenticated and advisory');
    for (const mutate of [
        (report) => { report.calibration.gain = 1.9; },
        (report) => { report.calibration.regions[0].source_removed_grain_rms = 2.9; },
        (report) => { report.correction_selection.attempts[0].reason_code = 'decode-failed'; },
        (report) => { report.correction_selection.attempts.pop(); },
        (report) => { report.disposition = 'calibrated'; },
    ]) {
        const altered = JSON.parse(JSON.stringify(fallbackReport));
        mutate(altered);
        assert.throws(() => synth.validateCalibrationReport(altered, {
            fitManifestPath: manifestPath,
            fitTablePath: tablePath,
            sourcePath,
            workingPath,
            gain1Path,
            calibratedTablePath,
            fitSettings: manifest.settings,
            calibrationRegions: manifest.calibration.regions,
            energy,
            dynamicHdrNormalization: null,
        }), /robust global|fallback|disposition|attempts/,
        'fallback telemetry must be recomputed before advisory acceptance');
    }

    const identityReport = JSON.parse(JSON.stringify(fallbackReport));
    identityReport.calibration = {
        model: 'fit-table-identity-gain1-v1',
        gain: 1,
        basis: 'authenticated-fit-table-gain1-preservation-v1',
        rejected_calibration: JSON.parse(JSON.stringify(fallbackReport.calibration)),
        regions: JSON.parse(JSON.stringify(fallbackReport.calibration.regions)),
    };
    identityReport.correction_selection.selected_model = 'fit-table-identity-gain1-v1';
    identityReport.correction_selection.attempts[1] = {
        model: 'robust-global-log-median-v1',
        status: 'rejected-quality-materialization-mismatch',
        reason_code: 'scalar-gain-outside-av1-scaling-range',
        message: 'rescaled scaling curve cannot be represented in AV1 range',
    };
    identityReport.correction_selection.attempts.push({
        model: 'fit-table-identity-gain1-v1', status: 'selected',
    });
    const identityDescriptor = synth.validateCalibrationReport(identityReport, {
        fitManifestPath: manifestPath,
        fitTablePath: tablePath,
        sourcePath,
        workingPath,
        gain1Path,
        calibratedTablePath,
        fitSettings: manifest.settings,
        calibrationRegions: manifest.calibration.regions,
        energy,
        dynamicHdrNormalization: null,
    });
    assert.strictEqual(identityDescriptor.model, 'fit-table-identity-gain1-v1');
    assert.strictEqual(identityDescriptor.representativeGain, 1);
    assert.strictEqual(identityDescriptor.rejectedModel, 'robust-global-log-median-v1');
    assert.strictEqual(identityDescriptor.qualityWarning.code,
        'postencode-calibration-fit-table-identity-fallback');
    assert.deepStrictEqual(identityDescriptor.qualityWarning.failures, [
        'regional-gain-outside-safe-bounds: regional adaptive gain 3.0000 is outside safe bounds [0.2500, 2.0000]',
        'scalar-gain-outside-av1-scaling-range: rescaled scaling curve cannot be represented in AV1 range',
    ]);

    const curveIdentityReport = JSON.parse(JSON.stringify(calibrationReport));
    const rejectedCurve = JSON.parse(JSON.stringify(calibrationReport.calibration));
    delete rejectedCurve.transform.channels;
    delete rejectedCurve.transform.chroma_index_attestation;
    curveIdentityReport.disposition = 'calibrated_with_quality_model_fallback';
    curveIdentityReport.calibration = {
        model: 'fit-table-identity-gain1-v1',
        gain: 1,
        basis: 'authenticated-fit-table-gain1-preservation-v1',
        rejected_calibration: rejectedCurve,
        regions: JSON.parse(JSON.stringify(rejectedCurve.regions)),
    };
    curveIdentityReport.correction_selection = {
        policy: 'bounded-luma-log-affine-then-robust-global-log-median-then-fit-table-identity-v1',
        selected_model: 'fit-table-identity-gain1-v1',
        quality_warning: true,
        attempts: [
            {
                model: 'luma-log-affine-v1',
                status: 'rejected-quality-materialization-mismatch',
                reason_code: 'independent-chroma-index-not-luma-representable',
                message: 'independent chroma scaling is not indexed by luma',
            },
            { model: 'fit-table-identity-gain1-v1', status: 'selected' },
        ],
    };
    const curveIdentityDescriptor = synth.validateCalibrationReport(curveIdentityReport, {
        fitManifestPath: manifestPath,
        fitTablePath: tablePath,
        sourcePath,
        workingPath,
        gain1Path,
        calibratedTablePath,
        fitSettings: manifest.settings,
        calibrationRegions: manifest.calibration.regions,
        energy,
        dynamicHdrNormalization: null,
    });
    assert.strictEqual(curveIdentityDescriptor.model, 'fit-table-identity-gain1-v1');
    assert.strictEqual(curveIdentityDescriptor.rejectedModel, 'luma-log-affine-v1');
    for (const mutate of [
        (report) => { report.calibration.gain = 0.99; },
        (report) => { report.calibration.regions[0].source_removed_mean_square = 8; },
        (report) => { report.correction_selection.attempts[1].reason_code = 'decode-failed'; },
        (report) => { report.correction_selection.attempts[2].model = 'luma-log-affine-v1'; },
    ]) {
        const altered = JSON.parse(JSON.stringify(identityReport));
        mutate(altered);
        assert.throws(() => synth.validateCalibrationReport(altered, {
            fitManifestPath: manifestPath,
            fitTablePath: tablePath,
            sourcePath,
            workingPath,
            gain1Path,
            calibratedTablePath,
            fitSettings: manifest.settings,
            calibrationRegions: manifest.calibration.regions,
            energy,
            dynamicHdrNormalization: null,
        }), /identity|fallback|attempts/,
        'fit-table identity fallback must remain exactly authenticated');
    }

    const calibratedGrainPath = write(path.join(jobDir, 'calibrated.mkv'), Buffer.from('calibrated-grained-final-av1'));
    const validationRegions = manifest.heldout.regions.map((candidate, index) => ({
        index,
        candidate: JSON.parse(JSON.stringify(candidate)),
        source_removed_mean_square: 1,
        final_added_mean_square: 1,
        source_removed_grain_energy: 1,
        final_added_energy: 1,
        amplitude_ratio: 1,
        amplitude_error_pct: 0,
    }));
    const validationReport = {
        schema: 2,
        operation: 'validate-energy',
        purpose: 'final-decoded-film-grain-energy-validation',
        validated: true,
        accepted: true,
        quality_thresholds_met: true,
        disposition: 'accepted',
        quality_warning: null,
        fit_manifest: fullFingerprint(manifestPath),
        calibration_report: fullFingerprint(calibrationReportPath),
        source_fingerprint: artifact.sampledSourceFingerprint(sourcePath),
        ungrained_final_av1_fingerprint: artifact.sampledSourceFingerprint(workingPath),
        calibrated_final_av1_fingerprint: artifact.sampledSourceFingerprint(calibratedGrainPath),
        comparison: {
            mode: 'original-vs-ungrained-and-calibrated-final-av1',
            denoiser_attestation: denoiserAttestation(),
        },
        tolerances: {
            aggregate_amplitude_error_pct: energy.aggregateTolerancePct,
            per_region_amplitude_error_pct: energy.regionTolerancePct,
            minimum_energy_delta: energy.minimumDelta,
        },
        evaluation: {
            validated: true,
            aggregate_amplitude_ratio: 1,
            aggregate_amplitude_error_pct: 0,
            band_balanced_amplitude_ratio: 1,
            band_balanced_amplitude_error_pct: 0,
            failures: [],
            regions: validationRegions,
        },
    };
    assert.deepStrictEqual(synth.validateEnergyValidationReport(validationReport, {
        fitManifestPath: manifestPath,
        calibrationReportPath,
        sourcePath,
        workingPath,
        calibratedGrainPath,
        heldoutRegions: manifest.heldout.regions,
        dynamicHdrNormalization: null,
        energy,
    }), {
        accepted: true,
        qualityThresholdsMet: true,
        disposition: 'accepted',
        qualityWarning: null,
        failures: [],
        structuredFailures: [],
    });
    const legacyValidation = JSON.parse(JSON.stringify(validationReport));
    legacyValidation.schema = 1;
    assert.throws(() => synth.validateEnergyValidationReport(legacyValidation, {
        fitManifestPath: manifestPath,
        calibrationReportPath,
        sourcePath,
        workingPath,
        calibratedGrainPath,
        heldoutRegions: manifest.heldout.regions,
        dynamicHdrNormalization: null,
        energy,
    }), /did not authenticate/);
    const coercedValidationSchema = JSON.parse(JSON.stringify(validationReport));
    coercedValidationSchema.schema = '2';
    assert.throws(() => synth.validateEnergyValidationReport(coercedValidationSchema, {
        fitManifestPath: manifestPath,
        calibrationReportPath,
        sourcePath,
        workingPath,
        calibratedGrainPath,
        heldoutRegions: manifest.heldout.regions,
        dynamicHdrNormalization: null,
        energy,
    }), /did not authenticate/);
    for (const key of [
        'aggregate_amplitude_error_pct',
        'per_region_amplitude_error_pct',
        'minimum_energy_delta',
    ]) {
        const altered = JSON.parse(JSON.stringify(validationReport));
        altered.tolerances[key] = Number(altered.tolerances[key]) + 0.01;
        assert.throws(() => synth.validateEnergyValidationReport(altered, {
            fitManifestPath: manifestPath,
            calibrationReportPath,
            sourcePath,
            workingPath,
            calibratedGrainPath,
            heldoutRegions: manifest.heldout.regions,
            dynamicHdrNormalization: null,
            energy,
        }), /does not match configured policy/, `validation tolerance ${key} was not bound to policy`);
    }
    const failedValidation = JSON.parse(JSON.stringify(validationReport));
    failedValidation.validated = false;
    assert.throws(() => synth.validateEnergyValidationReport(failedValidation, {
        fitManifestPath: manifestPath,
        calibrationReportPath,
        sourcePath,
        workingPath,
        calibratedGrainPath,
        heldoutRegions: manifest.heldout.regions,
        dynamicHdrNormalization: null,
        energy,
    }), /did not authenticate/);
    const warningValidation = JSON.parse(JSON.stringify(validationReport));
    const warningFailures = manifest.heldout.regions.map((_candidate, index) =>
        `region ${index} amplitude error 100.00% exceeds ${energy.regionTolerancePct.toFixed(2)}%`);
    warningFailures.push(
        `aggregate amplitude error 100.00% exceeds ${energy.aggregateTolerancePct.toFixed(2)}%`,
        `band-balanced amplitude error 100.00% exceeds ${energy.aggregateTolerancePct.toFixed(2)}%`
    );
    warningValidation.evaluation.regions.forEach((region) => {
        region.final_added_mean_square = 4;
        region.final_added_energy = 4;
        region.amplitude_ratio = 2;
        region.amplitude_error_pct = 100;
    });
    warningValidation.evaluation.validated = false;
    warningValidation.evaluation.aggregate_amplitude_ratio = 2;
    warningValidation.evaluation.aggregate_amplitude_error_pct = 100;
    warningValidation.evaluation.band_balanced_amplitude_ratio = 2;
    warningValidation.evaluation.band_balanced_amplitude_error_pct = 100;
    warningValidation.evaluation.failures = warningFailures.slice();
    warningValidation.quality_thresholds_met = false;
    warningValidation.disposition = 'accepted_with_quality_warning';
    warningValidation.quality_warning = {
        code: 'heldout-energy-tolerance-mismatch',
        advisory: true,
        failures: warningFailures.slice(),
    };
    const structuredWarningFailures = manifest.heldout.regions.map((_candidate, index) => ({
        code: 'region-amplitude-error',
        index,
        errorPct: 100,
        thresholdPct: energy.regionTolerancePct,
    }));
    structuredWarningFailures.push(
        {
            code: 'aggregate-amplitude-error',
            index: null,
            errorPct: 100,
            thresholdPct: energy.aggregateTolerancePct,
        },
        {
            code: 'band-balanced-amplitude-error',
            index: null,
            errorPct: 100,
            thresholdPct: energy.aggregateTolerancePct,
        }
    );
    assert.deepStrictEqual(synth.validateEnergyValidationReport(warningValidation, {
        fitManifestPath: manifestPath,
        calibrationReportPath,
        sourcePath,
        workingPath,
        calibratedGrainPath,
        heldoutRegions: manifest.heldout.regions,
        dynamicHdrNormalization: null,
        energy,
    }), {
        accepted: true,
        qualityThresholdsMet: false,
        disposition: 'accepted_with_quality_warning',
        qualityWarning: {
            code: 'heldout-energy-tolerance-mismatch',
            advisory: true,
            failures: warningFailures,
        },
        failures: warningFailures,
        structuredFailures: structuredWarningFailures,
    }, 'an authenticated tolerance mismatch must be accepted with a warning');
    for (const mutate of [
        (report) => { report.accepted = false; },
        (report) => { report.quality_thresholds_met = true; },
        (report) => { report.quality_warning.failures.pop(); },
        (report) => { report.evaluation.failures.pop(); },
        (report) => { report.evaluation.validated = true; },
        (report) => { report.evaluation.regions[0].final_added_energy = 3.9; },
    ]) {
        const altered = JSON.parse(JSON.stringify(warningValidation));
        mutate(altered);
        assert.throws(() => synth.validateEnergyValidationReport(altered, {
            fitManifestPath: manifestPath,
            calibrationReportPath,
            sourcePath,
            workingPath,
            calibratedGrainPath,
            heldoutRegions: manifest.heldout.regions,
            dynamicHdrNormalization: null,
            energy,
        }), /authenticate|regional evidence|quality disposition|advisory status/,
        'warning acceptance must not permit malformed or forged evidence');
    }
    assert.strictEqual((15.625).toFixed(2), '15.63',
        'boundary fixture must exercise JavaScript round-half-up display behavior');
    const boundaryValidation = JSON.parse(JSON.stringify(validationReport));
    const boundaryRatio = 1.15625;
    const boundaryError = 15.625;
    const boundaryAdded = boundaryRatio ** 2;
    const boundaryFailures = manifest.heldout.regions.map((_candidate, index) =>
        `region ${index} amplitude error 15.62% exceeds 15.00%`);
    boundaryFailures.push(
        'aggregate amplitude error 15.62% exceeds 8.00%',
        'band-balanced amplitude error 15.62% exceeds 8.00%'
    );
    boundaryValidation.evaluation.regions.forEach((region) => {
        region.final_added_mean_square = boundaryAdded;
        region.final_added_energy = boundaryAdded;
        region.amplitude_ratio = boundaryRatio;
        region.amplitude_error_pct = boundaryError;
    });
    boundaryValidation.evaluation.validated = false;
    boundaryValidation.evaluation.aggregate_amplitude_ratio = boundaryRatio;
    boundaryValidation.evaluation.aggregate_amplitude_error_pct = boundaryError;
    boundaryValidation.evaluation.band_balanced_amplitude_ratio = boundaryRatio;
    boundaryValidation.evaluation.band_balanced_amplitude_error_pct = boundaryError;
    boundaryValidation.evaluation.failures = boundaryFailures.slice();
    boundaryValidation.quality_thresholds_met = false;
    boundaryValidation.disposition = 'accepted_with_quality_warning';
    boundaryValidation.quality_warning = {
        code: 'heldout-energy-tolerance-mismatch',
        advisory: true,
        failures: boundaryFailures.slice(),
    };
    const boundaryDescriptor = synth.validateEnergyValidationReport(boundaryValidation, {
        fitManifestPath: manifestPath,
        calibrationReportPath,
        sourcePath,
        workingPath,
        calibratedGrainPath,
        heldoutRegions: manifest.heldout.regions,
        dynamicHdrNormalization: null,
        energy,
    });
    assert.strictEqual(boundaryDescriptor.disposition, 'accepted_with_quality_warning');
    assert(Math.abs(boundaryDescriptor.structuredFailures[0].errorPct - 15.625) < 1e-12,
        'structured evidence must retain the unrounded numeric boundary');
    const tamperedBoundary = JSON.parse(JSON.stringify(boundaryValidation));
    tamperedBoundary.evaluation.failures[0] =
        'region 0 amplitude error 15.70% exceeds 15.00%';
    tamperedBoundary.quality_warning.failures[0] =
        'region 0 amplitude error 15.70% exceeds 15.00%';
    assert.throws(() => synth.validateEnergyValidationReport(tamperedBoundary, {
        fitManifestPath: manifestPath,
        calibrationReportPath,
        sourcePath,
        workingPath,
        calibratedGrainPath,
        heldoutRegions: manifest.heldout.regions,
        dynamicHdrNormalization: null,
        energy,
    }), /quality disposition does not reproduce/,
    'display tolerance must not permit numeric tampering');
    const mismatchedValidationRegion = JSON.parse(JSON.stringify(validationReport));
    mismatchedValidationRegion.evaluation.regions[0].candidate.mean_luma += 1;
    assert.throws(() => synth.validateEnergyValidationReport(mismatchedValidationRegion, {
        fitManifestPath: manifestPath,
        calibrationReportPath,
        sourcePath,
        workingPath,
        calibratedGrainPath,
        heldoutRegions: manifest.heldout.regions,
        dynamicHdrNormalization: null,
        energy,
    }), /invalid held-out regional evidence/);
    const falseValidationAggregate = JSON.parse(JSON.stringify(validationReport));
    falseValidationAggregate.evaluation.band_balanced_amplitude_ratio = 0.9;
    assert.throws(() => synth.validateEnergyValidationReport(falseValidationAggregate, {
        fitManifestPath: manifestPath,
        calibrationReportPath,
        sourcePath,
        workingPath,
        calibratedGrainPath,
        heldoutRegions: manifest.heldout.regions,
        dynamicHdrNormalization: null,
        energy,
    }), /aggregate evidence is invalid/);

    console.log('PASS grain analysis/prepared-artifact/calibration contract');
} finally {
    const resolved = path.resolve(root);
    const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    assert(resolved.startsWith(tempRoot), `refusing unsafe cleanup: ${resolved}`);
    fs.rmSync(resolved, { recursive: true, force: true });
}
