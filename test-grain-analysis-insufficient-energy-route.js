'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const artifact = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/grainAnalysisArtifact.js');
const analyze = require('./custom-cont-init.d/vmaf-plugin-patches/analyzeFilmGrain/1.0.0/index.js');
const extract = require('./custom-cont-init.d/vmaf-plugin-patches/extractVideoSamples/1.0.0/index.js')._test;
const synthesize = require('./custom-cont-init.d/vmaf-plugin-patches/synthesizeFilmGrain/1.0.0/index.js');

function write(filePath, contents) {
    fs.writeFileSync(filePath, contents);
    return filePath;
}

function fullFingerprint(filePath) {
    const resolved = fs.realpathSync(filePath);
    return {
        scheme: 'sha256-full-v1',
        sha256: artifact.sha256File(resolved),
        size_bytes: fs.statSync(resolved).size,
        resolved_path: resolved,
    };
}

function loadDefaults(inputs, details) {
    const defaults = {};
    for (const input of details().inputs) defaults[input.name] = input.defaultValue;
    return Object.assign(defaults, inputs || {});
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

function region(timestamp, bandIndex, meanLuma, coordinateOffset) {
    return {
        timestamp,
        band_index: bandIndex,
        x: coordinateOffset + bandIndex * 16,
        y: coordinateOffset + bandIndex * 8,
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

function residualSummary(meanSquare) {
    return {
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
    };
}

function buildLowEnergyReport(sourcePath, pipelinePath) {
    const selected = [0, 1, 2, 3].map((bandIndex) =>
        region(600 + bandIndex * 600, bandIndex, 35 + bandIndex * 40, 0));
    const calibration = [0, 1, 2, 3].map((bandIndex) =>
        region(3000 + bandIndex * 10, bandIndex, 40 + bandIndex * 40, 64));
    const heldout = [0, 1, 2, 3].map((bandIndex) =>
        region(3040 + bandIndex * 10, bandIndex, 45 + bandIndex * 40, 128));
    const nativeQualified = [
        ...selected.map((candidate) => nativeQualification('fit', candidate)),
        ...calibration.map((candidate) => nativeQualification('curve-calibration', candidate)),
        ...heldout.map((candidate) => nativeQualification('final-validation', candidate)),
    ];
    const strongRegions = [
        ...calibration.map((candidate) => ({ role: 'curve-calibration', candidate })),
        ...heldout.slice(0, 3).map((candidate) => ({ role: 'final-validation', candidate })),
    ];
    const weakCandidate = heldout[3];
    const sourceHash = 'a'.repeat(64);
    const denoisedHash = 'b'.repeat(64);
    const fit = artifact.PRODUCTION_FIT_SETTINGS;

    return {
        schema: 1,
        operation: 'fit',
        outcome: 'bypass',
        reason_code: artifact.NO_GRAIN_INSUFFICIENT_ENERGY_REASON_CODE,
        message: 'selection exhausted after authenticated residual measurements; one final-validation region remained at the source-energy floor',
        production_action: artifact.NO_GRAIN_PRODUCTION_ACTION,
        generated_utc: new Date().toISOString(),
        pipeline: { version: artifact.PIPELINE_VERSION, ...fullFingerprint(pipelinePath) },
        input_identities: { source: artifact.sampledSourceFingerprint(sourcePath) },
        fit_settings: {
            comparison_mode: 'hqdn3d',
            purpose: 'source-denoise-grain-fit',
            denoise: artifact.DENOISE_FILTER,
            scaling_gain: 1,
            clip_seconds: fit.clipSeconds,
            crop_size: fit.requestedCropMaximum,
            crop_size_requested_maximum: fit.requestedCropMaximum,
            crop_size_policy: artifact.CROP_SIZE_POLICY,
            preroll_seconds: artifact.DENOISE_PREROLL_SECONDS,
            max_temporal_luma_stddev: fit.maxTemporalLumaStddev,
            max_spatial_luma_stddev: fit.maxSpatialLumaStddev,
            max_edge_density: fit.maxEdgeDensity,
            max_extreme_pixel_fraction: fit.maxExtremePixelFraction,
            max_native_luma_span: fit.maxNativeLumaSpan,
            energy_min_luma_spacing: fit.minimumCurveLumaSpacing,
            energy_min_luma_span: fit.minimumCurveLumaSpan,
            high_pass_sigma: fit.highPassSigma,
            energy_trim_fraction: fit.energyTrimFraction,
            energy_min_delta: fit.minimumSourceEnergyDelta,
            minimum_fit_regions: 4,
            minimum_heldout_regions: 4,
            requested_minimum_heldout_regions: 4,
            heldout_minimum_adapted: false,
            minimum_valid_tables: fit.minimumValidTables,
            minimum_scan_coverage: fit.minimumScanCoverage,
            proxy_width: fit.proxyWidth,
            proxy_fps: fit.proxyFps,
            requested_fit_spacing_seconds: fit.requestedFitSpacing,
            requested_heldout_spacing_seconds: fit.requestedHeldoutSpacing,
        },
        evidence: {
            advisory: true,
            source_grain_absence_proven: false,
            selection_exhausted: true,
            comparison: {
                mode: 'hqdn3d',
                purpose: 'source-denoise-grain-fit',
                denoise: artifact.DENOISE_FILTER,
                denoiser_attestation: denoiserAttestation(),
            },
            media_profile: { selected: 'sdr-limited', transfer_family: 'sdr' },
            sampling: {
                timestamps: Array.from({ length: artifact.MINIMUM_PROXY_TIMESTAMPS },
                    (_unused, index) => index * 10),
                fit_spacing: fit.requestedFitSpacing,
                observed_fit_spacing: fit.requestedFitSpacing,
                heldout_spacing: fit.clipSeconds + artifact.DENOISE_PREROLL_SECONDS,
            },
            scan: {
                attempted: artifact.MINIMUM_PROXY_TIMESTAMPS,
                successful: artifact.MINIMUM_PROXY_TIMESTAMPS,
                coverage: 1,
                failures: [],
            },
            selected,
            calibration,
            heldout,
            fit_pairs: selected.map((candidate, index) => ({
                index,
                candidate,
                frames: 48,
                exact_identical: false,
                source_framemd5_sequence_sha256: sourceHash,
                denoised_framemd5_sequence_sha256: denoisedHash,
            })),
            native_luma_qualification: {
                method: artifact.NATIVE_LUMA_QUALIFICATION_METHOD,
                maximum_span_codes: fit.maxNativeLumaSpan,
                minimum_curve_spacing_codes: fit.minimumCurveLumaSpacing,
                minimum_curve_span_codes: fit.minimumCurveLumaSpan,
                minimum_curve_distinct_supports: 4,
                qualified: nativeQualified,
                rejected: [],
                calibration_support: nativeSupport(calibration),
                final_validation_support: nativeSupport(heldout),
            },
            postencode_residual_qualification: {
                method: artifact.POSTENCODE_RESIDUAL_QUALIFICATION_METHOD,
                metric: 'paired-high-pass-residual-energy-v2',
                normalized_units: '8-bit-luma-code-squared',
                denoise: artifact.DENOISE_FILTER,
                valid: false,
                sigma: fit.highPassSigma,
                trim_fraction: fit.energyTrimFraction,
                minimum_mean_square_exclusive: fit.minimumSourceEnergyDelta,
                qualified: strongRegions.map(({ role, candidate }) => ({
                    role,
                    candidate,
                    source_removed: residualSummary(1),
                })),
                rejected: [{
                    candidate: weakCandidate,
                    source_removed: residualSummary(fit.minimumSourceEnergyDelta),
                    role_when_rejected: 'final-validation',
                    reason: 'source-removed-energy-at-or-below-minimum',
                    excluded_from_both_postencode_roles: true,
                    minimum_mean_square_exclusive: fit.minimumSourceEnergyDelta,
                }],
            },
        },
        requested_outputs: {
            table: 'replaced-by-pipeline-stub',
            manifest: 'replaced-by-pipeline-stub',
            artifacts_published: false,
        },
    };
}

function staleGrainVariables() {
    return {
        grainAnalysisArtifact: { stale: true },
        grainAnalysisSourcePath: '/stale/source.mkv',
        grainAnalysisJobDir: '/stale/job',
        grainAnalysisWorkRoot: '/stale/work',
        grainAnalysisTablePath: '/stale/grain-table.txt',
        grainAnalysisManifestPath: '/stale/grain-manifest.json',
        grainAnalysisPreparedAt: 'stale',
        grainAnalysisProfile: 'pq',
        grainAnalysisDynamicHdrProvisional: { stale: true },
        grainAnalysisNoGrainArtifact: { stale: true },
        grainAnalysisOutcomeReportPath: '/stale/outcome.json',
    };
}

function pluginArgs(root, sourcePath, pipelinePath, workRoot, variables, logs) {
    const ffmpegProbeExecutable = process.platform === 'win32'
        ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe')
        : '/bin/true';
    return {
        inputs: {
            mode: 'active',
            sourcePathRegex: '[\\s\\S]*',
            sourcePathRegexFlags: '',
            eligibleProfiles: 'sdrAndPq',
            pipelinePath,
            pythonPath: process.execPath,
            grav1synthPath: process.execPath,
            nvenccPath: process.execPath,
            coordinatorPath: process.execPath,
            workRoot,
            workers: '1',
            pipelineTimeoutMinutes: '5',
        },
        variables,
        workDir: root,
        originalLibraryFile: { _id: sourcePath },
        inputFileObj: {
            _id: sourcePath,
            ffProbeData: {
                streams: [{
                    index: 0,
                    codec_type: 'video',
                    codec_name: 'hevc',
                    pix_fmt: 'yuv420p10le',
                    color_range: 'tv',
                    color_transfer: 'bt709',
                    color_primaries: 'bt709',
                    color_space: 'bt709',
                    disposition: { attached_pic: 0 },
                }],
            },
        },
        ffmpegPath: ffmpegProbeExecutable,
        ffprobePath: ffmpegProbeExecutable,
        jobLog: (message) => logs.push(String(message)),
        updateWorker: () => {},
    };
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-grain-energy-routing-'));
    const originalLoad = Module._load;
    try {
        const sourcePath = write(path.join(root, 'sparse-stationary-source.mkv'),
            Buffer.from('non-exact sparse-stationary grain source'));
        const outcomeTemplatePath = path.join(root, 'low-energy-outcome-template.json');
        const lowEnergyPipelinePath = write(path.join(root, 'fit-low-energy-advisory.js'), [
            "'use strict';",
            "const fs = require('fs');",
            "const path = require('path');",
            "const argv = process.argv.slice(2);",
            "const value = (name) => argv[argv.indexOf(name) + 1];",
            "const report = JSON.parse(fs.readFileSync(path.join(__dirname, 'low-energy-outcome-template.json'), 'utf8'));",
            "report.requested_outputs.table = path.resolve(value('--output'));",
            "report.requested_outputs.manifest = path.resolve(value('--manifest'));",
            "fs.writeFileSync(value('--outcome'), JSON.stringify(report, null, 2) + '\\n');",
            "process.stderr.write('grain pipeline optional bypass: ' + report.reason_code + '; ' + report.message + '\\n');",
            'process.exitCode = 3;',
            '',
        ].join('\n'));
        write(outcomeTemplatePath,
            `${JSON.stringify(buildLowEnergyReport(sourcePath, lowEnergyPipelinePath), null, 2)}\n`);
        const invalidMsePipelinePath = write(path.join(root, 'fit-invalid-mse.js'), [
            "'use strict';",
            "const fs = require('fs');",
            "const argv = process.argv.slice(2);",
            "const value = (name) => argv[argv.indexOf(name) + 1];",
            "fs.writeFileSync(value('--output'), 'partial untrusted grain table\\n');",
            "fs.writeFileSync(value('--manifest'), '{\"partial\":true}\\n');",
            "fs.writeFileSync(value('--outcome'), '{\"partial\":true}\\n');",
            "process.stderr.write('x'.repeat(7000) + '\\ngrain pipeline failed: high-pass measurement emitted invalid MSE data\\n');",
            'process.exitCode = 2;',
            '',
        ].join('\n'));
        const invalidSuccessPipelinePath = write(path.join(root, 'fit-invalid-success.js'), [
            "'use strict';",
            "process.stderr.write('pipeline exited successfully without authenticated outputs\\n');",
            '',
        ].join('\n'));

        Module._load = function patchedLoad(request, parent, isMain) {
            if (request === '../../../../../methods/lib') {
                return () => ({ loadDefaultValues: loadDefaults });
            }
            return originalLoad.call(this, request, parent, isMain);
        };

        const invalidRegexArgs = pluginArgs(
            root, sourcePath, lowEnergyPipelinePath, 'grain-analysis-invalid-regex',
            staleGrainVariables(), []
        );
        invalidRegexArgs.inputs.sourcePathRegex = '[';
        const invalidRegex = await analyze.plugin(invalidRegexArgs);
        assert.strictEqual(invalidRegex.outputNumber, 2,
            'FGS regex configuration errors after a readable source must fail open');
        assert.strictEqual(invalidRegex.variables.grainAnalysisStatus,
            artifact.ANALYSIS_UNAVAILABLE_STATUS);
        assert.doesNotThrow(() =>
            artifact.validateAnalysisUnavailableDisposition(invalidRegex.variables));

        const missingToolArgs = pluginArgs(
            root, sourcePath, path.join(root, 'missing-grain-pipeline.py'),
            'grain-analysis-missing-tool', staleGrainVariables(), []
        );
        const missingTool = await analyze.plugin(missingToolArgs);
        assert.strictEqual(missingTool.outputNumber, 2,
            'missing optional FGS tools after a readable source must fail open');
        assert.strictEqual(missingTool.variables.grainAnalysisStatus,
            artifact.ANALYSIS_UNAVAILABLE_STATUS);

        const invalidSuccess = await analyze.plugin(pluginArgs(
            root, sourcePath, invalidSuccessPipelinePath, 'grain-analysis-invalid-success',
            staleGrainVariables(), []
        ));
        assert.strictEqual(invalidSuccess.outputNumber, 2,
            'an unauthenticated exit-0 pipeline result must fail open');
        assert.strictEqual(invalidSuccess.variables.grainAnalysisStatus,
            artifact.ANALYSIS_UNAVAILABLE_STATUS);
        const invalidSuccessDir = path.join(root, 'grain-analysis-invalid-success');
        assert.deepStrictEqual(
            fs.existsSync(invalidSuccessDir) ? fs.readdirSync(invalidSuccessDir) : [], [],
            'invalid exit-0 validation left partial analysis state');

        const unreadableSourcePath = path.join(root, 'missing-library-source.mkv');
        const unreadableSource = await analyze.plugin(pluginArgs(
            root, unreadableSourcePath, lowEnergyPipelinePath,
            'grain-analysis-unreadable-source', staleGrainVariables(), []
        ));
        assert.strictEqual(unreadableSource.outputNumber, 3,
            'an unreadable library source must retain the hard-failure route');
        assert.strictEqual(unreadableSource.variables.grainAnalysisStatus, 'failed');

        const coverGuardLogs = [];
        const coverGuardArgs = pluginArgs(
            root, sourcePath, lowEnergyPipelinePath, 'grain-analysis-cover-guard',
            staleGrainVariables(), coverGuardLogs
        );
        coverGuardArgs.inputFileObj.ffProbeData.streams = [{
            index: 0,
            codec_type: 'video',
            codec_name: 'mjpeg',
            pix_fmt: 'yuvj420p',
            disposition: { attached_pic: 1 },
        }, {
            index: 1,
            codec_type: 'video',
            codec_name: 'hevc',
            pix_fmt: 'yuv420p10le',
            color_range: 'tv',
            color_transfer: 'bt709',
            color_primaries: 'bt709',
            color_space: 'bt709',
            disposition: { attached_pic: 0 },
        }];
        const coverGuard = await analyze.plugin(coverGuardArgs);
        assert.strictEqual(coverGuard.outputNumber, 2,
            'cover art before the main video must take the advisory-ineligible route');
        assert.strictEqual(coverGuard.variables.grainAnalysisStatus, 'ineligible');
        assert.strictEqual(coverGuard.variables.grainAnalysisReason,
            'primary_video_not_first_video_stream');
        assert(coverGuardLogs.some((line) => line.includes(
            'primary_video_not_first_video_stream')));
        assert.strictEqual(fs.existsSync(path.join(root, 'grain-analysis-cover-guard')), false,
            'selector guard must run before creating grain-analysis scratch state');

        const advisoryLogs = [];
        const advisoryVariables = staleGrainVariables();
        const advisory = await analyze.plugin(pluginArgs(
            root, sourcePath, lowEnergyPipelinePath, 'grain-analysis-advisory',
            advisoryVariables, advisoryLogs
        ));

        assert.strictEqual(advisory.outputNumber, 1,
            'authenticated low-energy exit 3 must continue into normal untouched-source transcode');
        assert.strictEqual(advisory.outputFileObj._id, sourcePath,
            'the advisory path must retain the untouched library input');
        assert.strictEqual(advisory.variables.grainAnalysisStatus, 'no_grain',
            `authenticated low-energy fixture was rejected:\n${advisoryLogs.join('\n')}`);
        assert.strictEqual(advisory.variables.grainAnalysisReason,
            artifact.NO_GRAIN_INSUFFICIENT_ENERGY_REASON_CODE,
            'the advisory reason must come from the authenticated outcome disposition');
        assert.strictEqual(advisory.variables.grainAnalysisNoGrainArtifact.reasonCode,
            artifact.NO_GRAIN_INSUFFICIENT_ENERGY_REASON_CODE);
        assert.strictEqual(artifact.canonicalDenoiseDisposition(advisory.variables), 'no_grain');
        assert.deepStrictEqual(extract.referenceContractForVariables(advisory.variables), {
            disposition: 'no_grain',
            selectorMode: 'original-fgs-bypass',
            canonical: false,
            id: 'fgs-bypass-original-tf0-v1',
            temporalPolicy: 'fgs-bypass-original',
            legacyHistory: false,
        }, 'the authenticated FGS bypass must select the untouched-source VMAF/CQ contract');
        assert(advisoryLogs.some((line) => line.includes(
            artifact.NO_GRAIN_INSUFFICIENT_ENERGY_REASON_CODE)),
        'the dynamic low-energy reason must remain visible in the job log');
        assert(advisoryLogs.some((line) => /ADVISORY NO SYNTHETIC GRAIN/.test(line)),
            'the operator-facing advisory must explain why synthesis is omitted');
        assert.strictEqual(fs.existsSync(
            advisory.variables.grainAnalysisNoGrainArtifact.requestedTablePath), false,
        'low-energy advisory published a forbidden grain table');
        assert.strictEqual(fs.existsSync(
            advisory.variables.grainAnalysisNoGrainArtifact.requestedManifestPath), false,
        'low-energy advisory published a forbidden grain manifest');
        assert(fs.existsSync(advisory.variables.grainAnalysisOutcomeReportPath),
            'authenticated advisory outcome was not retained for downstream validation');
        assert.doesNotThrow(() => artifact.validateNoGrainArtifact(
            advisory.variables.grainAnalysisNoGrainArtifact));
        assert.strictEqual(Object.prototype.hasOwnProperty.call(
            advisory.variables, 'grainAnalysisArtifact'), false,
        'advisory path leaked a stale prepared artifact');

        const advisoryRoot = path.join(root, 'grain-analysis-advisory');
        const advisoryJobs = fs.readdirSync(advisoryRoot);
        assert.strictEqual(advisoryJobs.length, 1,
            'authenticated advisory must retain exactly one owned evidence directory');
        assert.deepStrictEqual(fs.readdirSync(path.join(advisoryRoot, advisoryJobs[0])),
            ['grain-fit-outcome.json'],
            'authenticated advisory retained a table, manifest, or unrelated partial artifact');

        const untouchedSourceAv1Path = write(path.join(root, 'untouched-source-output.mkv'),
            Buffer.from('untouched-source AV1 candidate'));
        const synthesisLogs = [];
        const synthesisInput = { _id: untouchedSourceAv1Path };
        const synthesis = await synthesize.plugin({
            inputs: {
                mode: 'active',
                sourcePathRegex: '[\\s\\S]*',
                sourcePathRegexFlags: '',
            },
            variables: advisory.variables,
            workDir: root,
            originalLibraryFile: { _id: sourcePath },
            inputFileObj: synthesisInput,
            ffmpegPath: path.join(root, 'must-not-run-ffmpeg'),
            ffprobePath: path.join(root, 'must-not-run-ffprobe'),
            jobLog: (message) => synthesisLogs.push(String(message)),
            updateWorker: () => {},
        });
        assert.strictEqual(synthesis.outputNumber, 3,
            'authenticated low-energy synthesis bypass must keep the untouched-source AV1');
        assert.strictEqual(synthesis.outputFileObj, synthesisInput,
            'synthesis advisory must return the exact untouched-source AV1 file object');
        assert.strictEqual(synthesis.outputFileObj._id, untouchedSourceAv1Path);
        assert.strictEqual(synthesis.variables.grainSynthesisStatus, 'no_grain');
        assert.strictEqual(synthesis.variables.grainSynthesisReason,
            artifact.NO_GRAIN_INSUFFICIENT_ENERGY_REASON_CODE,
            'synthesis must propagate the authenticated low-energy reason');
        assert(synthesisLogs.some((line) => /Authenticated direct grav1synth bypass/.test(line)),
            'synthesis job log must identify the authenticated low-energy bypass');

        const failureLogs = [];
        const failureVariables = staleGrainVariables();
        const failureStaleKeys = Object.keys(failureVariables);
        const failure = await analyze.plugin(pluginArgs(
            root, sourcePath, invalidMsePipelinePath, 'grain-analysis-invalid-mse',
            failureVariables, failureLogs
        ));

        assert.strictEqual(failure.outputNumber, 2,
            'invalid MSE/exit 2 must fail open into normal AV1 optimization');
        assert.strictEqual(failure.outputFileObj._id, sourcePath,
            'the invalid-measurement fallback must retain the untouched library input');
        assert.strictEqual(failure.variables.grainAnalysisStatus,
            artifact.ANALYSIS_UNAVAILABLE_STATUS);
        assert(failure.variables.grainAnalysisReason.length <=
            analyze._test.ANALYSIS_DIAGNOSTIC_MAX_CHARS,
        'technical analysis diagnostic exceeded its persisted bound');
        assert.match(failure.variables.grainAnalysisReason, /bounded diagnostic/);
        assert.match(String(failure.variables.grainAnalysisReason),
            /exit code 2[\s\S]*high-pass measurement emitted invalid MSE data/);
        assert(failureLogs.some((line) => /high-pass measurement emitted invalid MSE data/.test(line)),
            'the decisive measurement-integrity failure must remain visible in the job log');
        for (const key of failureStaleKeys) {
            assert.strictEqual(Object.prototype.hasOwnProperty.call(failure.variables, key), false,
                `analysis-unavailable fallback leaked stale or partial ${key}`);
        }
        assert.strictEqual(artifact.validateAnalysisUnavailableDisposition(failure.variables),
            artifact.ANALYSIS_UNAVAILABLE_STATUS);
        assert.strictEqual(artifact.canonicalDenoiseDisposition(failure.variables),
            artifact.ANALYSIS_UNAVAILABLE_STATUS);
        assert.deepStrictEqual(extract.referenceContractForVariables(failure.variables), {
            disposition: artifact.ANALYSIS_UNAVAILABLE_STATUS,
            selectorMode: 'original-fgs-bypass',
            canonical: false,
            id: 'fgs-bypass-original-tf0-v1',
            temporalPolicy: 'fgs-bypass-original',
            legacyHistory: false,
        }, 'technical FGS failure must keep the untouched source and disable NVENC temporal filtering');
        assert.deepStrictEqual(extract.referenceContractForVariables({}), {
            disposition: null,
            selectorMode: 'legacy-original',
            canonical: false,
            id: 'legacy-original-tf4-v1',
            temporalPolicy: 'legacy-original',
            legacyHistory: true,
        }, 'a null grain disposition must retain the legacy tf4 contract');
        const failureRoot = path.join(root, 'grain-analysis-invalid-mse');
        assert(fs.existsSync(failureRoot), 'technical-failure analysis work root was not created');
        assert.deepStrictEqual(fs.readdirSync(failureRoot), [],
            'fail-open cleanup left an outcome, grain artifact, or owned job directory behind');

        const technicalAv1Path = write(path.join(root, 'analysis-unavailable-output.mkv'),
            Buffer.from('completed untouched-source tf0 AV1'));
        const cleanUnavailableVariables = Object.assign({}, failure.variables);
        const technicalSynthesisInput = { _id: technicalAv1Path };
        const technicalSynthesisLogs = [];
        const technicalSynthesis = await synthesize.plugin({
            inputs: {
                mode: 'active',
                sourcePathRegex: '[\\s\\S]*',
                sourcePathRegexFlags: '',
            },
            variables: cleanUnavailableVariables,
            workDir: root,
            originalLibraryFile: { _id: sourcePath },
            inputFileObj: technicalSynthesisInput,
            ffmpegPath: path.join(root, 'must-not-run-technical-ffmpeg'),
            ffprobePath: path.join(root, 'must-not-run-technical-ffprobe'),
            jobLog: (message) => technicalSynthesisLogs.push(String(message)),
            updateWorker: () => {},
        });
        assert.strictEqual(technicalSynthesis.outputNumber, 3,
            'analysis-unavailable synthesis must keep the completed normal AV1');
        assert.strictEqual(technicalSynthesis.outputFileObj, technicalSynthesisInput);
        assert.strictEqual(technicalSynthesis.variables.grainSynthesisStatus,
            artifact.ANALYSIS_UNAVAILABLE_STATUS);
        assert.strictEqual(technicalSynthesis.variables.grainSynthesisReason,
            failure.variables.grainAnalysisReason);
        assert(technicalSynthesisLogs.some((line) => /original-source\/tf0 AV1/.test(line)));

        const staleUnavailableVariables = Object.assign({}, failure.variables, {
            grainAnalysisTablePath: path.join(root, 'forbidden-stale-table.txt'),
        });
        assert.throws(() => artifact.canonicalDenoiseDisposition(staleUnavailableVariables),
            /retained forbidden artifact references/);
        const rejectedSynthesis = await synthesize.plugin({
            inputs: {
                mode: 'active',
                sourcePathRegex: '[\\s\\S]*',
                sourcePathRegexFlags: '',
            },
            variables: staleUnavailableVariables,
            workDir: root,
            originalLibraryFile: { _id: sourcePath },
            inputFileObj: { _id: technicalAv1Path },
            ffmpegPath: path.join(root, 'must-not-run-stale-ffmpeg'),
            ffprobePath: path.join(root, 'must-not-run-stale-ffprobe'),
            jobLog: () => {},
            updateWorker: () => {},
        });
        assert.strictEqual(rejectedSynthesis.outputNumber, 4,
            'analysis-unavailable handoff with a stale table reference must fail closed');
        assert.match(String(rejectedSynthesis.variables.grainSynthesisReason),
            /invalid analysis-unavailable handoff/);

        for (const tamperedReason of ['', 'x'.repeat(
            artifact.ANALYSIS_DIAGNOSTIC_MAX_CHARS + 1)]) {
            const rejectedReasonSynthesis = await synthesize.plugin({
                inputs: {
                    mode: 'active',
                    sourcePathRegex: '[\\s\\S]*',
                    sourcePathRegexFlags: '',
                },
                variables: Object.assign({}, failure.variables, {
                    grainAnalysisReason: tamperedReason,
                }),
                workDir: root,
                originalLibraryFile: { _id: sourcePath },
                inputFileObj: { _id: technicalAv1Path },
                ffmpegPath: path.join(root, 'must-not-run-tampered-reason-ffmpeg'),
                ffprobePath: path.join(root, 'must-not-run-tampered-reason-ffprobe'),
                jobLog: () => {},
                updateWorker: () => {},
            });
            assert.strictEqual(rejectedReasonSynthesis.outputNumber, 4,
                'analysis-unavailable handoff with a tampered reason must fail closed');
            assert.match(String(rejectedReasonSynthesis.variables.grainSynthesisReason),
                /invalid analysis-unavailable handoff/);
        }

        const flow = JSON.parse(fs.readFileSync(
            path.join(__dirname, 'configs', 'flow_YR5PZ1QaD_CANONICAL.json'), 'utf8'));
        const continueRoute = flow.flowEdges.find((edge) =>
            edge.source === 'grainAnalysis1' && String(edge.sourceHandle) === '1');
        const failOpenRoute = flow.flowEdges.find((edge) =>
            edge.source === 'grainAnalysis1' && String(edge.sourceHandle) === '2');
        const failureRoute = flow.flowEdges.find((edge) =>
            edge.source === 'grainAnalysis1' && String(edge.sourceHandle) === '3');
        assert(continueRoute, 'canonical Flow lacks the grain-analysis continue route');
        assert(failOpenRoute, 'canonical Flow lacks the grain-analysis fail-open route');
        assert(failureRoute, 'canonical Flow lacks the grain-analysis failure route');
        const continueNode = flow.flowPlugins.find((node) => node.id === continueRoute.target);
        assert.strictEqual(continueNode && continueNode.pluginName, 'fetchMediaMetadata',
            'authenticated low-energy advisory must enter the canonical metadata/VMAF/CQ pipeline');
        const failOpenNode = flow.flowPlugins.find((node) => node.id === failOpenRoute.target);
        assert.strictEqual(failOpenNode && failOpenNode.pluginName, 'fetchMediaMetadata',
            'technical grain-analysis failure must continue into metadata/VMAF/CQ');
        const cleanupNode = flow.flowPlugins.find((node) => node.id === failureRoute.target);
        assert.strictEqual(cleanupNode && cleanupNode.pluginName, 'cleanupTempFiles',
            'unreadable-source output 3 must retain the original via cleanup');
        assert.notStrictEqual(failOpenRoute.target, failureRoute.target,
            'technical FGS errors and unreadable sources must remain distinct');

        console.log('PASS content bypass and technical fail-open preserve untouched-source tf0 AV1');
    } finally {
        Module._load = originalLoad;
        const resolved = path.resolve(root);
        const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
        assert(resolved.startsWith(temporaryRoot), `refusing unsafe cleanup: ${resolved}`);
        fs.rmSync(resolved, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
});
