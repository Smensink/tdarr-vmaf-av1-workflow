"use strict";



Object.defineProperty(exports, "__esModule", { value: true });



exports.plugin = exports.details = void 0;

var canonicalDenoise = require('../../_lib/canonicalDenoise.js');
var grainArtifact = require('../../_lib/grainAnalysisArtifact.js');
var grainVmafContract = require('../../_lib/grainVmafContract.js');
var nvenccKnn = require('../../_lib/nvenccKnn.js');

// Hard ceiling for a single extracted sample. A legitimate few-second window off a
// 4K remux is tens of MB; anything approaching this is a runaway copy, so capping
// stops it in seconds instead of letting it write GBs until the spawn timeout.
var SAMPLE_EXTRACTION_MAX_BYTES = 512 * 1024 * 1024;

function buildSampleExtractionArgs(inputPath, outputPath, seekSeconds, durationSeconds, videoMap, options) {
    var robustSeek = !!(options && options.robustSeek);
    var seek = Number(seekSeconds).toFixed(2);
    // Fast path: input-side seek, which uses the container index and is cheap.
    // Robust path: output-side seek, which demuxes from 0 and discards. Structurally
    // damaged Matroska (master-element overruns) has an unusable index, so input-side
    // seek lands at the wrong offset and -t never bounds the copy - ffmpeg then runs
    // to EOF and emits a multi-GB, multi-minute "sample". Output-side seek is immune
    // to that because the cut is driven by decoded packet order, not the index.
    var head = robustSeek
        ? ['-i', String(inputPath), '-ss', seek]
        : ['-ss', seek, '-i', String(inputPath)];
    return head.concat([
        '-t', String(durationSeconds),
        '-map', String(videoMap),
        '-an', '-sn', '-dn',
        '-c:v', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-reset_timestamps', '1',
        '-fs', String(SAMPLE_EXTRACTION_MAX_BYTES),
        '-y', String(outputPath),
    ]);
}

function buildFeatureExtractionArgs(inputPath, filterComplex) {
    return [
        '-y',
        '-hwaccel', 'cuda',
        '-i', String(inputPath),
        '-filter_complex', String(filterComplex),
        '-map', '[o1]',
        '-an',
        '-f', 'null', '-',
    ];
}

function resetVmafJobIdentity(variables) {
    if (!variables || typeof variables !== 'object') {
        throw new Error('VMAF job identity reset requires a variables object');
    }
    delete variables.vmafJobId;
    delete variables.vmafCanonicalJobId;
    delete variables.vmafRunId;
    delete variables.vmafJobStartTime;
}

function seedVmafJobIdentity(variables, jobId, startedAt) {
    var normalizedJobId = String(jobId === undefined || jobId === null ? '' : jobId).trim();
    var normalizedStartedAt = String(startedAt === undefined || startedAt === null ? '' : startedAt).trim();
    if (!normalizedJobId || !normalizedStartedAt) {
        throw new Error('VMAF job identity seed requires jobId and startedAt');
    }
    variables.vmafJobStartTime = normalizedStartedAt;
    variables.vmafJobId = normalizedJobId;
    variables.vmafCanonicalJobId = normalizedJobId;
}

function knownColorValue(value) {
    var normalized = String(value === undefined || value === null ? '' : value).trim();
    return normalized && !/^(unknown|unspecified|reserved)$/i.test(normalized) ? normalized : '';
}

function matroskaColorValue(kind, value) {
    var normalized = knownColorValue(value).toLowerCase();
    var maps = {
        range: { tv: 1, mpeg: 1, limited: 1, pc: 2, jpeg: 2, full: 2 },
        primaries: { bt709: 1, bt470m: 4, bt470bg: 5, smpte170m: 6, smpte240m: 7, film: 8, bt2020: 9, smpte428: 10, smpte431: 11, smpte432: 12, jedec_p22: 22 },
        transfer: { bt709: 1, gamma22: 4, gamma28: 5, smpte170m: 6, smpte240m: 7, linear: 8, log: 9, log_sqrt: 10, 'iec61966-2-4': 11, bt1361e: 12, 'iec61966-2-1': 13, 'bt2020-10': 14, 'bt2020-12': 15, smpte2084: 16, smpte428: 17, 'arib-std-b67': 18 },
        matrix: { rgb: 0, bt709: 1, fcc: 4, bt470bg: 5, smpte170m: 6, smpte240m: 7, ycocg: 8, bt2020nc: 9, bt2020_ncl: 9, bt2020c: 10 },
    };
    return Object.prototype.hasOwnProperty.call(maps[kind], normalized) ? maps[kind][normalized] : null;
}

function buildMkvColorMetadataArgs(samplePath, stream) {
    stream = stream || {};
    var argv = [String(samplePath), '--edit', 'track:v1'];
    [
        ['colour-range', 'range', stream.color_range],
        ['colour-primaries', 'primaries', stream.color_primaries],
        ['colour-transfer-characteristics', 'transfer', stream.color_transfer],
        ['colour-matrix-coefficients', 'matrix', stream.color_space],
    ].forEach(function (entry) {
        var mapped = matroskaColorValue(entry[1], entry[2]);
        if (mapped !== null) argv.push('--set', entry[0] + '=' + mapped);
    });
    var chroma = knownColorValue(stream.chroma_location).toLowerCase();
    var chromaSiting = {
        left: [1, 2], center: [2, 2], topleft: [1, 1], top: [2, 1],
    }[chroma];
    if (chromaSiting) {
        argv.push('--set', 'chroma-siting-horizontal=' + chromaSiting[0]);
        argv.push('--set', 'chroma-siting-vertical=' + chromaSiting[1]);
    }
    return argv;
}

function applyDenoisedSampleMetadata(mkvpropeditPath, samplePath, stream) {
    var result = require('child_process').spawnSync(mkvpropeditPath, buildMkvColorMetadataArgs(samplePath, stream), {
        encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error('mkvpropedit failed for canonical denoised sample: ' +
            String(result.stderr || result.stdout || '').trim());
    }
}

function resolveExecutablePath(value, description) {
    var fs = require('fs');
    var path = require('path');
    var requested = String(value || '').trim();
    if (!requested) throw new Error(description + ' path is required');
    var candidates = path.isAbsolute(requested)
        ? [requested]
        : String(process.env.PATH || '').split(path.delimiter)
            .filter(Boolean).map(function (directory) { return path.join(directory, requested); });
    for (var index = 0; index < candidates.length; index++) {
        try {
            fs.accessSync(candidates[index], fs.constants.R_OK | fs.constants.X_OK);
            return fs.realpathSync(candidates[index]);
        } catch (_) {}
    }
    throw new Error(description + ' executable not found: ' + requested);
}

function buildDenoisedSampleArgs(options) {
    var target = Number(options.targetSeconds);
    var duration = Number(options.durationSeconds);
    if (!Number.isFinite(target) || target < 0 || !Number.isFinite(duration) || duration <= 0) {
        throw new Error('invalid canonical denoised sample timing');
    }
    var stream = options.stream || {};
    var outputDepth = nvenccKnn.outputDepthForStream(stream);
    var frames = nvenccKnn.frameCount(duration, stream);
    // The NUT stream out of NVEncC carries no sample aspect ratio, so the denoised reference was
    // being written with SAR/DAR unset while the plain-extracted samples and the encoded distorted
    // clips both carry the source's 1:1/16:9. The CPU VMAF-v1 scorer requires all three to agree
    // and rejects the pair outright ("coded geometry/SAR/DAR mismatch ... reference sar=N/A",
    // exit 65), which fails every sample on the canonical-denoise path. Restamp the source SAR;
    // setsar is metadata-only and leaves pixels untouched.
    var vfChain = 'setpts=PTS-STARTPTS';
    var sourceSar = String(stream.sample_aspect_ratio || '').trim();
    if (/^[0-9]+:[0-9]+$/.test(sourceSar) && sourceSar.indexOf('0:') !== 0) {
        vfChain += ',setsar=' + sourceSar.replace(':', '/');
    }
    var consumerArgs = [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-f', 'nut', '-i', 'pipe:0',
        '-map', '0:v:0', '-an', '-sn', '-dn',
        '-frames:v', String(Math.max(1, frames - 1)),
        '-vf', vfChain,
        '-c:v', 'ffv1', '-level', '3', '-coder', '1', '-context', '1', '-slicecrc', '1',
    ];
    consumerArgs.push('-pix_fmt', outputDepth === 10 ? 'yuv420p10le' : 'yuv420p');
    [
        ['color_range', '-color_range'],
        ['color_space', '-colorspace'],
        ['color_transfer', '-color_trc'],
        ['color_primaries', '-color_primaries'],
        ['chroma_location', '-chroma_sample_location'],
        ['field_order', '-field_order'],
    ].forEach(function (entry) {
        var value = knownColorValue(stream[entry[0]]);
        if (value) consumerArgs.push(entry[1], value);
    });
    consumerArgs.push('-fps_mode', 'passthrough', String(options.outputPath));
    canonicalDenoise.assertCanonicalExactlyOnce(
        consumerArgs, 'denoised VMAF reference sample');
    var coordinatorPath = String(
        options.coordinatorPath || canonicalDenoise.COORDINATOR_PATH);
    var coordinatorArgs = nvenccKnn.buildCoordinatorArgs({
        nvenccPath: String(options.nvenccPath || canonicalDenoise.NVENCC_PATH),
        sourcePath: String(options.sourcePath),
        outputDepth: outputDepth,
        seekSeconds: target,
        frames: frames,
        producerLog: String(options.outputPath) + '.nvencc.log',
        ffmpegPath: String(options.ffmpegPath),
        ffmpegArgs: consumerArgs,
    });
    return {
        executable: coordinatorPath,
        argv: coordinatorArgs,
        seekSeconds: target,
        trimOffsetSeconds: 0,
        readDurationSeconds: duration,
        denoiseId: canonicalDenoise.DENOISE_ID,
        outputDepth: outputDepth,
        frames: frames,
    };
}

function validateDenoisedSampleMetadata(ffprobePath, samplePath, sourceStream) {
    var result = require('child_process').spawnSync(ffprobePath, [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,chroma_location,field_order',
        '-of', 'json', samplePath,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('ffprobe failed for canonical denoised sample: ' + String(result.stderr || '').trim());
    var payload = JSON.parse(result.stdout || '{}');
    var stream = payload.streams && payload.streams[0];
    if (!stream || stream.codec_name !== 'ffv1') throw new Error('canonical denoised sample is not FFV1');
    ['width', 'height'].forEach(function (key) {
        if (sourceStream[key] !== undefined && String(stream[key]) !== String(sourceStream[key])) {
            throw new Error('canonical denoised sample changed ' + key + ' from ' + sourceStream[key] + ' to ' + stream[key]);
        }
    });
    var expectedDepth = nvenccKnn.outputDepthForStream(sourceStream);
    var outputDepth = nvenccKnn.outputDepthForStream(stream);
    if (expectedDepth !== outputDepth) {
        throw new Error('canonical denoised sample changed bit depth from ' +
            expectedDepth + ' to ' + outputDepth);
    }
    ['color_range', 'color_space', 'color_transfer', 'color_primaries', 'chroma_location', 'field_order'].forEach(function (key) {
        var expected = knownColorValue(sourceStream[key]);
        if (expected && String(stream[key] || '') !== expected) {
            throw new Error('canonical denoised sample changed ' + key + ' from ' + expected + ' to ' + stream[key]);
        }
    });
    return stream;
}

function referenceContractForVariables(variables) {
    return grainVmafContract.forVariables(variables || {});
}



var details = function () { return ({



    name: 'Extract Video Samples',



    description: 'Extracts multiple video segments from the original file for VMAF quality testing.',



    style: {



        borderColor: 'blue',



    },



    tags: 'video,vmaf,testing',



    isStartPlugin: false,



    pType: '',



    requiresVersion: '2.11.01',



    sidebarPosition: -1,



    icon: 'faVideo',



    inputs: [



        {



            label: 'Number of Segments',



            name: 'numSegments',



            type: 'number',



            defaultValue: '6',



            inputUI: {



                type: 'text',



            },



            tooltip: 'Number of video segments to extract for testing (6 recommended for better coverage).',



        },



        {



            label: 'Segment Duration (seconds)',



            name: 'segmentDuration',



            type: 'number',



            defaultValue: '5',



            inputUI: {



                type: 'text',



            },



            tooltip: 'Duration of each segment in seconds (5 seconds recommended for faster processing while maintaining accuracy).',



        },



        {



            label: 'Adaptive Samples (use historical variance)',



            name: 'adaptiveSamples',



            type: 'boolean',



            defaultValue: 'true',



            inputUI: {



                type: 'switch',



            },



            tooltip: 'Adjust sample count based on historical VMAF variance priors.',



        },



        {



            label: 'Minimum Segments (adaptive)',



            name: 'minSegments',



            type: 'number',



            defaultValue: '3',



            inputUI: {



                type: 'text',



            },



            tooltip: 'Lower bound when adaptive sampling reduces segment count.',



        },



        {



            label: 'Maximum Segments (adaptive)',



            name: 'maxSegments',



            type: 'number',



            defaultValue: '16',



            inputUI: {



                type: 'text',



            },



            tooltip: 'Upper bound when adaptive sampling increases segment count.',



        },



        {



            label: 'Variance High Threshold',



            name: 'varianceHighThreshold',



            type: 'number',



            defaultValue: '3',



            inputUI: {



                type: 'text',



            },



            tooltip: 'If historical VMAF sample stddev is above this, increase segments.',



        },



        {



            label: 'Variance Low Threshold',



            name: 'varianceLowThreshold',



            type: 'number',



            defaultValue: '1',



            inputUI: {



                type: 'text',



            },



            tooltip: 'If historical VMAF sample stddev is below this, decrease segments.',



        },



        {



            label: 'Results CSV Path (priors)',



            name: 'resultsCsvPath',



            type: 'string',



            defaultValue: '/app/configs/vmaf_results.csv',



            inputUI: {



                type: 'text',



            },



            tooltip: 'Path to VMAF results CSV sidecar (SQLite is the primary store). Used for legacy fallback.',



        },



        {



            label: 'Align samples to keyframes',



            name: 'keyframeAlign',



            type: 'boolean',



            defaultValue: 'true',



            inputUI: {



                type: 'switch',



            },



            tooltip: 'Uses a fast seek + accurate seek to start each sample on the next decodable keyframe (more robust for stream-copy segments).',



        },



        {



            label: 'Use Stratified Sampling',



            name: 'stratifiedSampling',



            type: 'boolean',



            defaultValue: 'true',



            inputUI: {



                type: 'switch',



            },



            tooltip: 'Divide video into segments and sample from each segment center with random offset for better coverage',



        },



        {



            label: 'Stratified Random Range',



            name: 'stratifiedRandomRange',



            type: 'number',



            defaultValue: '0.33',



            inputUI: {



                type: 'text',



            },



            tooltip: 'Random offset range as fraction of segment length (0.33 = ±1/6 segment)',



        },



        {



            label: 'Keyframe seek window (seconds)',



            name: 'keyframeSeekWindowSeconds',



            type: 'number',



            defaultValue: '30',



            inputUI: {



                type: 'text',



            },



            tooltip: 'How far back to fast-seek before doing accurate seek for keyframe-aligned extraction (30s is usually plenty).',



        },



        {



            label: 'CQ Learning CSV Path',



            name: 'learningCsvPath',



            type: 'string',



            defaultValue: '/app/configs/vmaf_cq_learning.csv',



            inputUI: {



                type: 'text',



            },



            tooltip: 'Path to CQ learning CSV sidecar (SQLite is the primary store). Used for legacy fallback.',



        },



        {



            label: 'CQ Learning Min Samples',



            name: 'learningMinSamples',



            type: 'number',



            defaultValue: '5',



            inputUI: {



                type: 'text',



            },



            tooltip: 'Minimum similar historical samples required before using learned CQ range.',



        },



        {



            label: 'CQ Learning Bitrate Tolerance (%)',



            name: 'learningBitrateTolerance',



            type: 'number',



            defaultValue: '20',



            inputUI: {



                type: 'text',



            },



            tooltip: 'Bitrate tolerance for matching similar sources (percentage).',



        },



        {



            label: 'CQ Learning Use Only Successes',



            name: 'learningOnlySuccesses',



            type: 'boolean',



            defaultValue: 'true',



            inputUI: {



                type: 'switch',



            },



            tooltip: 'If true, only learn from rows where transcode_succeeded=1.',



        },



    ],



    outputs: [



        {



            number: 1,



            tooltip: 'Samples extracted successfully',



        },



    ],



}); };



exports.details = details;







// Filters out attached_pic, still_image, tiny resolutions to find the primary video stream.



function getVideoStream(inputFile) {



    var streams = inputFile && inputFile.ffProbeData && inputFile.ffProbeData.streams;



    if (!Array.isArray(streams)) return null;



    var candidates = [];



    var videoTypeCount = 0;



    for (var i = 0; i < streams.length; i++) {



        var s = streams[i];



        if (!s || s.codec_type !== 'video') continue;



        // typeIndex = position among video-type streams, for type-relative -map 0:v:N.



        // Counted before the skip filters so attached pics still occupy a slot.



        var typeIndex = videoTypeCount;



        videoTypeCount++;



        if (s.disposition && (s.disposition.attached_pic === 1 || s.disposition.clean_effects === 1)) continue;



        if (s.tags && s.tags.filename && /\.(jpg|jpeg|png|gif|bmp)$/i.test(s.tags.filename)) continue;



        if (s.still_image === 1 || s.multilayer === 1) continue;



        if ((s.width || 0) < 100 || (s.height || 0) < 100) continue;



        var priority = 0;



        if (s.disposition) {



            if (s.disposition.default === 1) priority = 2;



            else if (s.disposition.forced === 1) priority = 1;



        }



        candidates.push({ stream: s, priority: priority, index: i, typeIndex: typeIndex });



    }



    if (candidates.length === 0) return null;



    candidates.sort(function(a, b) { return b.priority - a.priority || a.index - b.index; });



    // Every caller consumes the selected item as an ffprobe stream (width,
    // pix_fmt, colour metadata, and so on) plus the type-relative map index.
    // Returning the internal ranking wrapper silently discarded all stream
    // metadata and reduced mkvpropedit to `file --edit track:v1`, which exits
    // with "Nothing to do".  Copy instead of mutating Tdarr's cached probe.
    return Object.assign({}, candidates[0].stream, {
        typeIndex: candidates[0].typeIndex,
    });



}







// A sample is only usable if it actually contains decodable video. Stream-copy



// extraction can exit 0 yet write a header-only file (no keyframe in the copy



// window), which then breaks every downstream encode/VMAF step.



function isValidVideoSample(samplePath, args, expectedDuration) {



    var fs = require('fs');



    var execFileSync = require('child_process').execFileSync;



    try {



        var st = fs.statSync(samplePath);



        if (!st || st.size < 20000) return false;







        // Guard against pathological Matroska/WebDL files with broken cues/keyframes.



        // Stream-copy extraction can silently copy from the start of the file to the target



        // position, producing multi-GB/multi-minute "samples". Those make calculateVMAF



        // look stuck for hours. Reject anything materially longer than the requested window.



        if (expectedDuration && isFinite(expectedDuration) && expectedDuration > 0) {



            try {



                var probeOut = execFileSync(args.ffprobePath || 'tdarr-ffprobe', [
                    '-v', 'error', '-show_entries', 'format=duration',
                    '-of', 'default=nw=1:nk=1', samplePath
                ], {



                    stdio: 'pipe',



                    timeout: 15000,
                    shell: false,
                    windowsHide: true



                }).toString().trim();



                var actualDuration = parseFloat(probeOut);



                var maxAllowedDuration = Math.max(expectedDuration * 4, expectedDuration + 20);



                if (isFinite(actualDuration) && actualDuration > maxAllowedDuration) {



                    if (args && args.jobLog) {



                        args.jobLog('Rejected overlong VMAF sample: ' + actualDuration.toFixed(1)



                            + 's for requested ' + expectedDuration + 's window (' + samplePath + ')');



                    }



                    return false;



                }



            } catch (probeErr) {



                // Keep the existing decodability check as the source of truth if ffprobe fails.



            }



        }







        execFileSync(args.ffmpegPath, [
            '-v', 'error', '-i', samplePath, '-map', '0:v:0',
            '-frames:v', '1', '-f', 'null', '-'
        ], { stdio: 'pipe', timeout: 30000, shell: false, windowsHide: true });



        return true;



    } catch (e) {



        return false;



    }



}











var plugin = function (args) {



    var lib = require('../../../../../methods/lib')();



    args.inputs = lib.loadDefaultValues(args.inputs, details);

    var referenceContract = referenceContractForVariables(args.variables);
    var canonicalDisposition = referenceContract.disposition;
    var useCanonicalDenoise = referenceContract.canonical;
    var canonicalFfmpegPath = useCanonicalDenoise
        ? resolveExecutablePath(args.ffmpegPath || '/usr/local/bin/tdarr-ffmpeg', 'FFmpeg')
        : null;
    if (args.variables.vmafNvencTemporalPolicy &&
        args.variables.vmafNvencTemporalPolicy !== referenceContract.temporalPolicy) {
        delete args.variables.vmafNvencFlagArgs;
    }
    args.variables.vmafCanonicalDenoiseActive = useCanonicalDenoise;
    args.variables.vmafCanonicalDenoiseDisposition = canonicalDisposition;
    args.variables.vmafReferenceContractId = referenceContract.id;
    args.variables.vmafNvencTemporalPolicy = referenceContract.temporalPolicy;







    // CRITICAL FIX #1: Reset all VMAF-related variables at start of flow to prevent state leakage between files



    args.variables.vmafTestedCQs = [];



    args.variables.vmafRetryCount = 0;



    args.variables.vmafTranscodeRetryCount = 0;



    args.variables.vmafTestResults = [];



    args.variables.vmafResults = [];



    args.variables.vmafAggregatedResults = [];



    // Current-contract measurements persist across refinement/retry loops, but never across
    // source files. Reset both the authoritative fresh envelope and selector attempt memory at
    // the new-file boundary before any samples or a new job id are created.



    resetVmafJobIdentity(args.variables);



    args.variables.vmafCurrentContractMeasurementHistory = null;



    args.variables.vmafSweepResultHistory = [];



    args.variables.vmafBestParameters = null;



    args.variables.vmafSelectOutput = 1;



    args.variables.vmafOverrideCQMin = undefined;



    args.variables.vmafOverrideCQMax = undefined;



    args.variables.vmafNextCQ = undefined;



    args.variables.vmafNextCQs = [];



    args.variables.vmafTranscodeRetryCQ = undefined;



    args.variables.vmafTranscodeOriginalCQ = undefined;



    args.variables.vmafTranscodeOutputPath = undefined;



    args.variables.vmafTriggerSweepRetry = false;



    args.variables.vmafSweepRetryReason = '';



    args.variables.vmafSweepRetriesExhausted = false;



    args.variables.vmafTranscodeGaveUp = false;



    args.variables.vmafTranscodeFailures = [];



    args.variables.vmafTranscodeRetryHistory = [];



    args.variables.vmafSweepRetryHistory = [];



    args.variables.vmafCQRangeRetryHistory = [];



    args.variables.vmafLearningData = null;



    args.variables.vmafLearnedCQRange = null;



    args.variables.vmafRecommendedPixFmt = null;



    args.variables.vmafAdaptiveSampleCount = null;



    args.variables.vmafAdaptiveSampleReason = '';



    args.variables.vmafHoldoutSample = null;



    args.variables.vmafHoldoutFailReason = null;



    args.variables.vmafHoldoutSuggestedCQ = null;







    // ---- Media metadata derivation (release_group, year, media_type, etc.) ----



    // Tdarr doesn't currently populate these via library scan, so we derive them



    // from the file path. They are then used by:



    //   - the SQLite-based CQ prior (this plugin, via getSimilarSweepCurves)



    //   - the SQLite training store write (exportVMAFResults plugin)



    //   - testEncodingParameters line 624+ (genre/animation/mediaType adjustment)



    //   - the EMA prior (releaseGroup tier)



    // Anything we can't derive stays as '' and is ignored by the readers.



    (function deriveMediaMetadata() {



        var filePath = (args.inputFileObj && args.inputFileObj._id) || '';



        var IGNORE_GROUPS = {



            'UNKNOWN': 1, 'NONE': 1, 'N/A': 1, 'NA': 1,



            'WEB': 1, 'WEBDL': 1, 'WEBDL1080P': 1, 'WEBDL720P': 1, 'WEBDL480P': 1,



            'WEBRIP': 1, 'WEBRIP1080P': 1, 'WEBRIP720P': 1, 'WEBRIP480P': 1,



            'BLURAY': 1, 'BLU-RAY': 1, 'BD': 1, 'BDREMUX': 1, 'BD-RIP': 1, 'BDRIP': 1,



            'HDTV': 1, 'PDTV': 1, 'SDTV': 1, 'DSR': 1,



            'X264': 1, 'X265': 1, 'HEVC': 1, 'AVC': 1, 'AV1': 1, 'H264': 1, 'H265': 1,



            'MKV': 1, 'MP4': 1, 'AVI': 1, 'M2TS': 1, 'REMUX': 1, 'REPACK': 1, 'PROPER': 1,



            'INTERNAL': 1, 'LIMITED': 1, 'COMPLETE': 1, 'EXTENDED': 1, 'THEATRICAL': 1, 'UNRATED': 1, 'DIRECTORS': 1, 'DC': 1, 'CRITERION': 1,



            'UHD': 1, 'UHDTV': 1, '4K': 1, '1080P': 1, '720P': 1, '2160P': 1, 'HDR': 1, 'HDR10': 1, 'DV': 1, 'DOLBY': 1, 'ATMOS': 1, 'TRUEHD': 1, 'DTS': 1, 'DTS-HD': 1, 'DTSHD': 1



        };



        function deriveGroup() {



            if (!filePath) return '';



            var base = String(filePath).replace(/^.*[\\\/]/, '');



            base = base.replace(/\.[a-z0-9]{2,5}$/i, '');



            var patterns = [/-([A-Za-z0-9]+)$/, /\[([A-Za-z0-9]+)\]$/, /\.([A-Za-z0-9]+)$/];



            for (var i = 0; i < patterns.length; i++) {



                var m = base.match(patterns[i]);



                if (m && m[1]) {



                    var g = m[1].toUpperCase();



                    if (!IGNORE_GROUPS[g]) return g;



                }



            }



            return '';



        }



        function deriveYear() {



            if (!filePath) return '';



            var base = String(filePath).replace(/^.*[\\\/]/, '');



            var m = base.match(/[.\-_\s\[(]((?:19|20)\d{2})[.\-_\s\])]/);



            return m && m[1] ? m[1] : '';



        }



        function deriveType() {



            if (!filePath) return 'unknown';



            var p = String(filePath).toLowerCase();



            if (/\b(tv|series|shows?|season\s*\d|episode\s*\d|s\d{1,2}e\d{1,2})\b/.test(p)) return 'tv';



            if (/\b(movies?|films?)\b/.test(p)) return 'movie';



            return 'unknown';



        }



        function deriveSourceType() {



            if (!filePath) return 'unknown';



            var p = String(filePath).toLowerCase();



            if (/\b(remux|uhd\.?bluray|uhd\b|bdremux|bluray\.?remux)\b/.test(p)) return 'bluray-remux';



            if (/\b(bluray|blu-ray|bdrip|bd-rip|brrip)\b/.test(p)) return 'bluray';



            if (/\b(web-?dl|webdl)\b/.test(p)) return 'web-dl';



            if (/\b(web-?rip|webrip)\b/.test(p)) return 'web-rip';



            if (/\b(hdtv|pdtv|sdtv|dsr)\b/.test(p)) return 'hdtv';



            if (/\b(dvdrip|dvd-r|dvdscr|r5)\b/.test(p)) return 'dvd';



            return 'unknown';



        }



        function deriveAnimation() {



            if (args.variables.vmafMediaIsAnimation === true) return true;



            var genres = args.variables.vmafMediaGenre || [];



            for (var i = 0; i < genres.length; i++) {



                var g = String(genres[i]).toLowerCase();



                if (g.indexOf('animation') !== -1 || g.indexOf('anime') !== -1 || g.indexOf('cartoon') !== -1) return true;



            }



            if (filePath && /\b(anime|animation|cartoon|animated)\b/.test(String(filePath).toLowerCase())) return true;



            return false;



        }



        function deriveGenres() {



            var out = [];



            var injected = args.variables.vmafMediaGenre || [];



            for (var i = 0; i < injected.length; i++) {



                var g = String(injected[i]).trim();



                if (g) out.push(g);



            }



            if (filePath) {



                var p = String(filePath).toLowerCase();



                var tokens = ['action', 'thriller', 'sport', 'documentary', 'news', 'drama', 'comedy', 'horror', 'scifi', 'fantasy', 'romance', 'crime', 'mystery', 'animation', 'anime', 'cartoon', 'war', 'western', 'musical', 'history', 'biography', 'family', 'adventure'];



                for (var j = 0; j < tokens.length; j++) {



                    var t = tokens[j];



                    if (new RegExp('\\b' + t + '\\b').test(p) && out.indexOf(t) === -1) out.push(t);



                }



            }



            return out.slice(0, 6);



        }



        // Only set if not already populated by an upstream provider.



        if (!args.variables.vmafReleaseGroup) {



            args.variables.vmafReleaseGroup = deriveGroup();



            args.variables.vmafReleaseGroupUsed = args.variables.vmafReleaseGroup;



        }



        if (!args.variables.vmafMediaType) args.variables.vmafMediaType = deriveType();



        if (!args.variables.vmafMediaYear) args.variables.vmafMediaYear = deriveYear();



        if (!args.variables.vmafMediaSourceType) args.variables.vmafMediaSourceType = deriveSourceType();



        if (args.variables.vmafMediaIsAnimation === undefined) args.variables.vmafMediaIsAnimation = deriveAnimation();



        if (!Array.isArray(args.variables.vmafMediaGenre) || args.variables.vmafMediaGenre.length === 0) {



            args.variables.vmafMediaGenre = deriveGenres();



        }



    })();







    var numSegments = Number(args.inputs.numSegments) || 6;



    var segmentDuration = Number(args.inputs.segmentDuration) || 5;



    var adaptiveSamples = !useCanonicalDenoise &&
        args.inputs.adaptiveSamples !== false && args.inputs.adaptiveSamples !== 'false';



    var minSegments = Number(args.inputs.minSegments) || 3;



    var maxSegments = Number(args.inputs.maxSegments) || 16;



    var varianceHighThreshold = Number(args.inputs.varianceHighThreshold);



    if (isNaN(varianceHighThreshold)) varianceHighThreshold = 0.5;



    var varianceLowThreshold = Number(args.inputs.varianceLowThreshold);



    if (isNaN(varianceLowThreshold)) varianceLowThreshold = 0.2;



    var resultsCsvPath = args.inputs.resultsCsvPath || '/app/configs/vmaf_results.csv';



    var learningCsvPath = args.inputs.learningCsvPath || '/app/configs/vmaf_cq_learning.csv';



    var learningMinSamples = Number(args.inputs.learningMinSamples) || 5;



    var learningBitrateTolerance = Number(args.inputs.learningBitrateTolerance);



    if (isNaN(learningBitrateTolerance)) learningBitrateTolerance = 20;



    var learningOnlySuccesses = args.inputs.learningOnlySuccesses !== false && args.inputs.learningOnlySuccesses !== 'false';



    minSegments = Math.max(1, minSegments);



    maxSegments = Math.max(minSegments, maxSegments);



    var inputFile = args.inputFileObj._id;



    var path = require('path');



    var fs = require('fs');



    var execFileSync = require('child_process').execFileSync;



    var cacheDir = args.workDir || '/temp';



    var fileName = path.basename(inputFile, path.extname(inputFile));



    var container = path.extname(inputFile).slice(1);



    var videoDuration = 0;



    if (args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.format) {



        videoDuration = parseFloat(args.inputFileObj.ffProbeData.format.duration) || 0;



    }



    if (videoDuration <= 0) {



        var errorMsg = 'Cannot extract video samples: Could not determine video duration. ';



        errorMsg += 'This may indicate a corrupt file or missing ffprobe data. ';



        errorMsg += 'File: ' + inputFile;



        args.jobLog('ERROR: ' + errorMsg);



        throw new Error(errorMsg);



    }



    args.jobLog('Video duration: ' + videoDuration.toFixed(2) + ' seconds');



    if (videoDuration < segmentDuration * numSegments) {



        numSegments = Math.max(1, Math.floor(videoDuration / segmentDuration));



    }







    // Adaptive sampling based on historical VMAF variance priors



    function resolutionTierFor(width, height) {



        var pixels = width * height;



        if (pixels >= 3840 * 2160) return '4K';



        if (pixels >= 2560 * 1440) return '1440p';



        if (pixels >= 1920 * 1080) return '1080p';



        if (pixels >= 1280 * 720) return '720p';



        return 'sd';



    }



    function codecCategory(codec) {



        var lc = String(codec || '').toLowerCase();



        if (lc.indexOf('av1') !== -1) return 'av1';



        if (lc.indexOf('265') !== -1 || lc.indexOf('hevc') !== -1 || lc.indexOf('h265') !== -1) return 'hevc';



        if (lc.indexOf('264') !== -1 || lc.indexOf('avc') !== -1) return 'h264';



        return 'other';



    }



    function parseCSVLine(line) {



        var values = [];



        var current = '';



        var inQuotes = false;



        for (var i = 0; i < line.length; i++) {



            var ch = line[i];



            if (ch === '"') {



                if (inQuotes && line[i + 1] === '"') {



                    current += '"';



                    i++;



                } else {



                    inQuotes = !inQuotes;



                }



            } else if (ch === ',' && !inQuotes) {



                values.push(current);



                current = '';



            } else {



                current += ch;



            }



        }



        values.push(current);



        return values;



    }



    function genreOverlap(currentGenres, csvGenreStr) {



        if (!csvGenreStr) return 0;



        var histGenres = String(csvGenreStr).split(',').map(function(g) { return g.trim().toLowerCase(); }).filter(Boolean);



        if (currentGenres.length === 0 || histGenres.length === 0) return 0;



        var match = currentGenres.filter(function(g) { return histGenres.indexOf(g) !== -1; });



        return match.length / Math.max(currentGenres.length, histGenres.length);



    }



    function stddev(values) {



        if (!values || values.length < 2) return 0;



        var mean = values.reduce(function(a, b) { return a + b; }, 0) / values.length;



        var variance = values.reduce(function(acc, v) {



            var diff = v - mean;



            return acc + diff * diff;



        }, 0) / values.length;



        return Math.sqrt(variance);



    }



    function median(values) {



        if (!values || values.length === 0) return 0;



        var sorted = values.slice().sort(function(a, b) { return a - b; });



        var mid = Math.floor(sorted.length / 2);



        if (sorted.length % 2 === 0) {



            return (sorted[mid - 1] + sorted[mid]) / 2;



        }



        return sorted[mid];



    }







    // CQ learning preload: set vmafLearnedCQRange early so testEncodingParameters can blend learned+heuristic.



    // learnCQRange runs later (after selectBestParameters) to append new samples; this step makes learning



    // affect subsequent files.



    function percentile(sorted, p) {



        if (!sorted || sorted.length === 0) return null;



        var idx = (sorted.length - 1) * p;



        var lo = Math.floor(idx);



        var hi = Math.ceil(idx);



        if (lo === hi) return sorted[lo];



        var w = idx - lo;



        return sorted[lo] * (1 - w) + sorted[hi] * w;



    }



    function inferSourceCharacteristics() {



        var sourceWidth = 1920;



        var sourceHeight = 1080;



        var sourceCodec = 'unknown';



        var bitrateMbps = 0;



        var fps = 24;



        if (args.inputFileObj.ffProbeData) {



            var format = args.inputFileObj.ffProbeData.format || {};



            var streams = args.inputFileObj.ffProbeData.streams || [];



            for (var si = 0; si < streams.length; si++) {



                if (streams[si].codec_type === 'video') {



                    sourceWidth = streams[si].width || sourceWidth;



                    sourceHeight = streams[si].height || sourceHeight;



                    sourceCodec = streams[si].codec_name || sourceCodec;



                    var sbr = parseFloat(streams[si].bit_rate);



                    if (!isNaN(sbr) && sbr > 0) bitrateMbps = sbr / 1000000;



                    if (streams[si].r_frame_rate) {



                        var parts = String(streams[si].r_frame_rate).split('/');



                        if (parts.length === 2) {



                            var n = parseFloat(parts[0]); var d = parseFloat(parts[1]);



                            if (n > 0 && d > 0) fps = n / d;



                        }



                    }



                    break;



                }



            }



            if (bitrateMbps <= 0) {



                var fbr = parseFloat(format.bit_rate);



                if (!isNaN(fbr) && fbr > 0) bitrateMbps = fbr / 1000000;



            }



        }



        if (bitrateMbps <= 0 && videoDuration > 0) {



            var sizeBytes = Number(args.inputFileObj.file_size || 0);



            if (!sizeBytes && args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.format) {



                sizeBytes = Number(args.inputFileObj.ffProbeData.format.size || 0);



            }



            if (sizeBytes > 0) bitrateMbps = (sizeBytes * 8) / (videoDuration * 1000000);



        }



        var pixels = sourceWidth * sourceHeight;



        var bitsPerPixel = (pixels > 0 && fps > 0) ? (bitrateMbps * 1e6) / (pixels * fps) : 0;



        return { width: sourceWidth, height: sourceHeight, codec: sourceCodec, bitrateMbps: bitrateMbps, bitsPerPixel: bitsPerPixel, fps: fps };



    }



    function parseBoolLoose(val) {



        if (val === true) return true;



        var s = String(val || '').toLowerCase();



        return s === '1' || s === 'true' || s === 'yes';



    }



    function weightedQuantile(pairs, q) {



        if (!pairs || pairs.length === 0) return null;



        var items = pairs



            .filter(function(p) { return p && isFinite(p.v) && isFinite(p.w) && p.w > 0; })



            .sort(function(a, b) { return a.v - b.v; });



        if (items.length === 0) return null;



        var total = items.reduce(function(acc, p) { return acc + p.w; }, 0);



        if (!total || !isFinite(total)) return null;



        var target = total * q;



        var c = 0;



        for (var i = 0; i < items.length; i++) {



            c += items[i].w;



            if (c >= target) return items[i].v;



        }



        return items[items.length - 1].v;



    }



    function effectiveSampleSize(pairs) {



        if (!pairs || pairs.length === 0) return 0;



        var sum = 0;



        var sumSq = 0;



        for (var i = 0; i < pairs.length; i++) {



            var w = pairs[i] && pairs[i].w;



            if (!isFinite(w) || w <= 0) continue;



            sum += w;



            sumSq += w * w;



        }



        if (!sumSq) return 0;



        return (sum * sum) / sumSq;



    }



    function clamp(min, max, v) {



        return Math.max(min, Math.min(max, v));



    }



    function parseIntSafe(v) {



        var n = parseInt(String(v || ''), 10);



        return isNaN(n) ? null : n;



    }



    function loadLearnedCQRangeFromCsv() {



        try {



            if (!learningCsvPath || !fs.existsSync(learningCsvPath)) {



                args.jobLog('CQ learning CSV path not found (SQLite DB is the primary store) - skipping legacy CSV preload');



                return;



            }



            var src = inferSourceCharacteristics();



            if (!src.bitrateMbps || isNaN(src.bitrateMbps) || src.bitrateMbps <= 0) {



                args.jobLog('CQ learning: source bitrate unknown - skipping learned CQ range preload');



                return;



            }



            var tier = resolutionTierFor(src.width, src.height);



            var srcCodecCat = codecCategory(src.codec);



            var currentMediaType = String(args.variables.vmafMediaType || 'unknown').toLowerCase();



            var currentYear = args.variables.vmafMediaYear ? parseInt(args.variables.vmafMediaYear, 10) || null : null;



            var currentSourceType = String(args.variables.vmafMediaSourceType || 'unknown').toLowerCase();



            var currentGenresLower = (args.variables.vmafMediaGenre || []).map(function(g) { return String(g).toLowerCase(); });



            var content = fs.readFileSync(learningCsvPath, 'utf8');



            var lines = content.split('\n').filter(function(l) { return l && l.trim().length > 0; });



            if (lines.length < 2) {



                args.jobLog('CQ learning CSV path empty (SQLite DB is the primary store) - skipping legacy CSV preload');



                return;



            }



            var headers = parseCSVLine(lines[0]).map(function(h) { return String(h).trim().replace(/^"|"$/g, ''); });



            var idx = function(name, altName) {



                var i = headers.indexOf(name);



                if (i === -1 && altName) i = headers.indexOf(altName);



                return i;



            };



            // Canonical schema is what learnCQRange writes (source_width/height instead of a



            // precomputed tier, media_* prefixed metadata, estimated_cq_* columns). The alt



            // names keep compatibility with the older lean schema.



            var tierIdx = idx('tier');



            var widthIdx = idx('source_width');



            var heightIdx = idx('source_height');



            var bppIdx = idx('bits_per_pixel');



            var cIdx = idx('source_codec');



            var cqIdx = idx('selected_cq');



            var estIdx = idx('estimated_cq_at_target', 'cq_at_target_estimated');



            var estConfIdx = idx('estimated_cq_confidence', 'cq_at_target_confidence');



            var estMethodIdx = idx('estimated_cq_method', 'cq_at_target_method');



            var succIdx = idx('transcode_succeeded');



            var gIdx = idx('media_genre', 'genre');



            var animIdx = idx('media_is_animation', 'is_animation');



            var typeIdx = idx('media_type');



            var sourceTypeIdx = idx('media_source_type');



            var yearIdx = idx('media_year');

            // Source banding column - present only on rows written after the source-CAMBI
            // recording change. Older rows have it empty/absent (idx may be -1 or value '').
            var cambiIdx = idx('source_cambi');

            // Target VMAF column - used to down-weight rows optimized to a different VMAF
            // target (e.g. recovered VMAF-93-era history when the current job targets 95).
            var targetIdx = idx('target_min_vmaf');



            if ((tierIdx === -1 && (widthIdx === -1 || heightIdx === -1)) || cIdx === -1 || cqIdx === -1) {



                args.jobLog('CQ learning CSV missing required columns (SQLite DB is the primary store) - skipping legacy CSV preload');



                return;



            }







            // Bayesian-style scored matching: uses each signal as soft evidence rather than requiring exact matches.



            // This avoids the "0 similar sources" failure mode when metadata is sparse/inconsistent.



            var scored = [];

            // Weighted (source_cambi, selected_cq) pairs for the CAMBI->CQ slope model.
            var cambiPairs = [];

            // Current job's VMAF target, for target-proximity weighting of historical rows.
            var currentTargetVmaf = Number(args.variables.vmafMinVMAF) || Number(args.inputs && args.inputs.targetMinVMAF) || 95;



            var strictCount = 0;



            var looseCount = 0;



            var tol = learningBitrateTolerance / 100;



            var sigma = Math.max(0.05, tol / 2); // relative sigma



            var anyAnim = args.variables.vmafMediaIsAnimation === true ? true : (currentGenresLower.some(function(g) { return g.indexOf('animation') !== -1 || g.indexOf('anime') !== -1 || g.indexOf('cartoon') !== -1; }) ? true : null);



            for (var li = 1; li < lines.length; li++) {



                var cols = parseCSVLine(lines[li]).map(function(v) { return v.replace(/^"|"$/g, ''); });



                if (cols.length <= cqIdx) continue;



                // Tier is the primary key; derive it from width/height when the canonical



                // schema is in use. bpp is a soft codec-agnostic bitrate proxy.



                var hTier = tierIdx !== -1 ? String(cols[tierIdx] || '').trim() : '';



                if (!hTier && widthIdx !== -1 && heightIdx !== -1) {



                    var hw = parseInt(cols[widthIdx], 10) || 0;



                    var hh = parseInt(cols[heightIdx], 10) || 0;



                    if (hw > 0 && hh > 0) hTier = resolutionTierFor(hw, hh);



                }



                var hbpp = bppIdx !== -1 ? parseFloat(cols[bppIdx]) : NaN;



                var hc = cols[cIdx] || '';



                if (!hTier) continue;



                if (learningOnlySuccesses && succIdx !== -1 && cols.length > succIdx) {



                    if (!parseBoolLoose(cols[succIdx])) continue;



                }



                // Prefer model-derived "CQ at target" (biases away from overshoot), but ONLY



                // when it came from a bracketed interpolation with reasonable confidence.



                // Extrapolated/clamped estimates (e.g. extrap_high values of ~50 when the



                // actual selection was CQ 30) are wildly unreliable and would poison the



                // learned range - fall back to the real selected CQ for those rows.



                var cq = null;



                var estConf = null;



                var estMethod = '';



                if (estConfIdx !== -1 && cols.length > estConfIdx) {



                    var cval = parseFloat(cols[estConfIdx]);



                    if (!isNaN(cval) && isFinite(cval)) estConf = Math.max(0, Math.min(1, cval));



                }



                if (estMethodIdx !== -1 && cols.length > estMethodIdx) {



                    estMethod = String(cols[estMethodIdx] || '').toLowerCase();



                }



                var estTrustworthy = estMethod.indexOf('interp') !== -1



                    && estMethod.indexOf('extrap') === -1



                    && estMethod.indexOf('clamped') === -1



                    && (estConf === null || estConf >= 0.25);



                if (estTrustworthy && estIdx !== -1 && cols.length > estIdx) {



                    var est = parseFloat(cols[estIdx]);



                    if (!isNaN(est) && isFinite(est) && est >= 16 && est <= 51) cq = est;



                }



                if (cq === null) {



                    var sel = parseFloat(cols[cqIdx]);



                    if (!isNaN(sel) && isFinite(sel)) cq = sel;



                }



                if (cq === null) continue;







                // Soft evidence weights



                var w = 1.0;







                // Tier match is strong evidence: mismatch isn't zero, but heavily downweighted.



                w *= (hTier === tier) ? 1.0 : 0.05;







                // Bitrate evidence: Gaussian kernel over relative bpp difference.



                // (We dropped per-row source_bitrate_mbps in the lean schema because it's



                //  redundant with bpp + tier for cross-source matching.)



                var srcBpp = src.bitsPerPixel;



                var bppW = 1.0;



                if (isFinite(hbpp) && hbpp > 0 && isFinite(srcBpp) && srcBpp > 0) {



                    var relBpp = Math.abs(hbpp - srcBpp) / Math.max(0.001, srcBpp);



                    bppW = Math.exp(-(relBpp * relBpp) / (2 * sigma * sigma));



                }



                w *= bppW;

                // Target-VMAF proximity: a row optimized to a different VMAF target picked its
                // CQ on a different quality curve, so it's weaker evidence for this job. Gaussian
                // decay by target distance (sigma 2.0 VMAF pts: a 93-vs-95 gap -> ~0.61 weight)
                // lets recovered VMAF-93-era history still inform a VMAF-95 job, just less, and
                // shifts naturally toward same-target rows as they accrue. Tune sigmaT to taste.
                if (targetIdx !== -1 && cols.length > targetIdx) {
                    var hTarget = parseFloat(cols[targetIdx]);
                    if (!isNaN(hTarget) && isFinite(hTarget) && isFinite(currentTargetVmaf)) {
                        var dT = Math.abs(hTarget - currentTargetVmaf);
                        var sigmaT = 2.0;
                        w *= Math.exp(-(dT * dT) / (2 * sigmaT * sigmaT));
                    }
                }







                // Codec evidence: prefer same codec category but allow cross-codec learning with penalty.



                var hCodecCat = codecCategory(hc);



                var codecW = (hCodecCat === srcCodecCat) ? 1.0 : 0.55;



                w *= codecW;







                // Genre evidence (soft): overlap boosts weight but doesn't block when missing.



                var gScore = gIdx !== -1 ? genreOverlap(currentGenresLower, cols[gIdx] || '') : 0;



                if (gScore > 0) w *= (1.0 + 0.6 * clamp(0, 1, gScore));







                // Animation evidence: if we can infer animation, mismatch penalizes.



                var hAnim = animIdx !== -1 ? (cols[animIdx] === '1' || cols[animIdx] === 'true') : null;



                if (anyAnim !== null && hAnim !== null) {



                    w *= (hAnim === anyAnim) ? 1.0 : 0.7;



                }







                // Media type evidence: mild penalty for mismatch when known.



                var hType = typeIdx !== -1 ? String(cols[typeIdx] || '').toLowerCase() : '';



                if (currentMediaType && currentMediaType !== 'unknown' && hType && hType !== 'unknown') {



                    w *= (hType === currentMediaType) ? 1.1 : 0.85;



                }







                var hSourceType = sourceTypeIdx !== -1 ? String(cols[sourceTypeIdx] || '').toLowerCase() : '';



                if (currentSourceType && currentSourceType !== 'unknown' && hSourceType && hSourceType !== 'unknown') {



                    w *= (hSourceType === currentSourceType) ? 1.1 : 0.85;



                }







                // Year evidence: mild decay by distance when available.



                var hYear = yearIdx !== -1 ? parseIntSafe(cols[yearIdx]) : null;



                if (currentYear !== null && hYear !== null && isFinite(currentYear) && isFinite(hYear)) {



                    var dy = Math.abs(hYear - currentYear);



                    w *= Math.exp(-dy / 25);



                }







                // (Retry-count penalty removed: the lean schema doesn't track retries. The



                //  transcode_succeeded filter already drops failed runs at line ~472.)







                // When the trusted estimate was used, scale weight by its confidence.



                // (When falling back to the real selected CQ, the row is solid evidence



                // regardless of how poor the estimate was - no penalty.)



                if (estTrustworthy && estConf !== null && isFinite(estConf)) {



                    // Map [0..1] -> [0.75..1.25]



                    w *= (0.75 + 0.5 * estConf);



                }







                if (!isFinite(w) || w <= 0) continue;



                scored.push({ v: cq, w: w });

                // Source-banding evidence: only rows that recorded a source CAMBI value.
                if (cambiIdx !== -1 && cols.length > cambiIdx) {
                    var hSrcCambi = parseFloat(cols[cambiIdx]);
                    if (!isNaN(hSrcCambi) && isFinite(hSrcCambi)) {
                        cambiPairs.push({ x: hSrcCambi, y: cq, w: w });
                    }
                }



                looseCount += 1;



                if (hCodecCat === srcCodecCat) strictCount += 1;



            }







            // ── Source CAMBI -> CQ slope model (data-driven replacement for the fixed
            //    +1/+2/+3 banding heuristic in testEncodingParameters). Weighted least squares
            //    selected_cq ~ a + b*source_cambi over matched neighbours that recorded a
            //    source CAMBI. Fit here from history (no dependency on the current job's source
            //    CAMBI, which isn't measured until later in this plugin); applied in
            //    testEncodingParameters where the current source CAMBI is known. Only set when
            //    there is enough support and real spread, so the heuristic carries cold-start.
            (function fitSourceCambiCQModel() {
                var n = cambiPairs.length;
                if (n < 8) return;
                var sw = 0, swx = 0, swy = 0;
                for (var i = 0; i < n; i++) { sw += cambiPairs[i].w; swx += cambiPairs[i].w * cambiPairs[i].x; swy += cambiPairs[i].w * cambiPairs[i].y; }
                if (!(sw > 0)) return;
                var mx = swx / sw, my = swy / sw;
                var sxx = 0, sxy = 0, xmin = Infinity, xmax = -Infinity;
                for (var j = 0; j < n; j++) {
                    var dx = cambiPairs[j].x - mx;
                    sxx += cambiPairs[j].w * dx * dx;
                    sxy += cambiPairs[j].w * dx * (cambiPairs[j].y - my);
                    if (cambiPairs[j].x < xmin) xmin = cambiPairs[j].x;
                    if (cambiPairs[j].x > xmax) xmax = cambiPairs[j].x;
                }
                // Need real spread in source CAMBI to estimate a slope.
                if (!(sxx > 1e-6) || (xmax - xmin) < 1.0) return;
                var slope = sxy / sxx;
                if (!isFinite(slope)) return;
                args.variables.vmafSourceCambiCQModel = {
                    slope: slope,
                    meanCambi: mx,
                    cambiMin: xmin,
                    cambiMax: xmax,
                    support: n
                };
                args.jobLog('Source-CAMBI CQ model: slope=' + slope.toFixed(3) + ' CQ per CAMBI point, meanCAMBI='
                    + mx.toFixed(2) + ', support=' + n + ' rows (x-range ' + xmin.toFixed(2) + '-' + xmax.toFixed(2) + ')');
            })();

            var effN = effectiveSampleSize(scored);



            if (effN < learningMinSamples) {



                args.jobLog('CQ learning: insufficient similar samples (' + effN.toFixed(1) + ' < ' + learningMinSamples + ')'



                    + ' [rows=' + scored.length + ', tier=' + tier + ', codec=' + srcCodecCat + ', bpp=' + (isFinite(src.bitsPerPixel) ? src.bitsPerPixel.toFixed(4) : '?') + ']');



                return;



            }



            var q20 = weightedQuantile(scored, 0.2);



            var q80 = weightedQuantile(scored, 0.8);



            var med = weightedQuantile(scored, 0.5);



            if (q20 === null || q80 === null || med === null) return;



            var learnedMin = Math.max(16, Math.floor(q20) - 1);



            var learnedMax = Math.min(51, Math.ceil(q80) + 1);



            if (learnedMax - learnedMin < 4) {



                learnedMin = Math.max(16, Math.round(med) - 2);



                learnedMax = Math.min(51, learnedMin + 4);



            }



            args.variables.vmafLearnedCQRange = {



                min: learnedMin,



                max: learnedMax,



                confidence: Math.min(1.0, effN / 20),



                sampleCount: Math.round(effN),



            };



            args.jobLog('Historical CQ prior: range ' + learnedMin + '-' + learnedMax
                + ' (N=' + effN.toFixed(1) + ' rows, tier=' + tier + ', codec=' + srcCodecCat + ', bpp=' + (isFinite(src.bitsPerPixel) ? src.bitsPerPixel.toFixed(4) : '?') + ')')










            // Load EMA state as additional prior



            try {



                var path = require('path');



                var emaStatePath = path.join(path.dirname(learningCsvPath), 'ema_cq_state.json');



                if (fs.existsSync(emaStatePath)) {



                    var emaContent = fs.readFileSync(emaStatePath, 'utf8');



                    var emaState = JSON.parse(emaContent);







                    // Use EMA as high-confidence prior when recent data exists



                    if (emaState.ema && tier in emaState.ema) {



                        var emaCQ = emaState.ema[tier];



                        var emaSampleCount = emaState.sampleCounts[tier] || 0;







                        if (emaSampleCount >= 10) {



                            // Blend EMA with learned range (30% EMA weight)



                            var emaWeight = 0.3;



                            var learnedMid = (learnedMin + learnedMax) / 2;



                            var blendedMid = emaWeight * emaCQ + (1 - emaWeight) * learnedMid;







                            var halfSpan = (learnedMax - learnedMin) / 2;



                            var priorMin = Math.max(16, blendedMid - halfSpan);



                            var priorMax = Math.min(51, blendedMid + halfSpan);







                            // Update learned range with EMA blend



                            args.variables.vmafLearnedCQRange.min = Math.round(priorMin);



                            args.variables.vmafLearnedCQRange.max = Math.round(priorMax);







                            args.jobLog('EMA-adjusted CQ range: ' + args.variables.vmafLearnedCQRange.min + '-' + args.variables.vmafLearnedCQRange.max);



                        }



                    }



                }



            } catch (emaErr) {



                // Silently continue if EMA not available



            }







        } catch (err) {



            args.jobLog('CQ learning preload error: ' + (err && err.message ? err.message : String(err)));



        }



    }



    // loadLearnedCQRangeFromCsv removed - SQLite getSimilarSweepCurves is primary







    // Historical per-CQ curve preload: pool (CQ, VMAF) points from past sweeps of similar



    // files (vmaf_results.csv has one aggregated row per tested CQ per run). Downstream,



    // testEncodingParameters fits a monotonic curve to these points and centres the first



    // sweep on the estimated CQ-at-target, which converges far faster than tier heuristics.



    function loadHistoricalCqPoints() {



        try {



            var rPath = args.inputs.resultsCsvPath || '/app/configs/vmaf_results.csv';



            if (!rPath || !fs.existsSync(rPath)) return;



            var src = inferSourceCharacteristics();



            var tier = resolutionTierFor(src.width, src.height);



            var srcCodecCat = codecCategory(src.codec);



            var srcBpp = src.bitsPerPixel;



            var anyAnim = args.variables.vmafMediaIsAnimation === true ? true



                : ((args.variables.vmafMediaGenre || []).some(function(g) {



                    g = String(g).toLowerCase();



                    return g.indexOf('animation') !== -1 || g.indexOf('anime') !== -1 || g.indexOf('cartoon') !== -1;



                }) ? true : null);







            var content = fs.readFileSync(rPath, 'utf8');



            var lines = content.split('\n').filter(function(l) { return l && l.trim().length > 0; });



            if (lines.length < 2) return;



            // Recent rows matter most (encoder settings drift over time); cap parse cost too.



            var maxLines = 20000;



            if (lines.length > maxLines + 1) {



                lines = [lines[0]].concat(lines.slice(lines.length - maxLines));



            }



            var headers = parseCSVLine(lines[0]).map(function(h) { return h.trim().replace(/^"|"$/g, ''); });



            var hIdx = function(n) { return headers.indexOf(n); };



            var fpIdx = hIdx('file_path');



            var wIdx = hIdx('video_width');



            var hgtIdx = hIdx('video_height');



            var codIdx = hIdx('video_codec');



            var bppIdx2 = hIdx('source_bits_per_pixel');



            var animIdx2 = hIdx('media_is_animation');



            var cqIdx2 = hIdx('cq');



            var aggIdx = hIdx('aggregated_vmaf_harmonic_mean');



            var tsIdx2 = hIdx('timestamp');



            if (fpIdx === -1 || cqIdx2 === -1 || aggIdx === -1 || wIdx === -1 || hgtIdx === -1) return;







            var seen = {};



            var points = [];



            var tol = (learningBitrateTolerance || 25) / 100;



            var sigma = Math.max(0.05, tol / 2);



            for (var li = 1; li < lines.length; li++) {



                var cols = parseCSVLine(lines[li]).map(function(v) { return v.replace(/^"|"$/g, ''); });



                if (cols.length <= aggIdx) continue;



                var vmafV = parseFloat(cols[aggIdx]);



                var cqV = parseFloat(cols[cqIdx2]);



                if (!isFinite(vmafV) || !isFinite(cqV) || vmafV <= 0) continue;



                var key = cols[fpIdx] + '|' + cqV;



                if (seen[key]) continue; // one point per file+CQ (rows repeat per sample)



                seen[key] = true;



                var hw2 = parseInt(cols[wIdx], 10) || 0;



                var hh2 = parseInt(cols[hgtIdx], 10) || 0;



                if (resolutionTierFor(hw2, hh2) !== tier) continue;



                var w = 1.0;



                var hCodecCat2 = codecCategory(codIdx !== -1 ? cols[codIdx] : '');



                w *= (hCodecCat2 === srcCodecCat) ? 1.0 : 0.5;



                if (bppIdx2 !== -1 && isFinite(srcBpp) && srcBpp > 0) {



                    var hb = parseFloat(cols[bppIdx2]);



                    if (isFinite(hb) && hb > 0) {



                        var rel = Math.abs(hb - srcBpp) / Math.max(0.001, srcBpp);



                        w *= Math.exp(-(rel * rel) / (2 * sigma * sigma));



                    }



                }



                if (anyAnim !== null && animIdx2 !== -1) {



                    var hAnim2 = cols[animIdx2] === '1' || cols[animIdx2] === 'true';



                    w *= (hAnim2 === anyAnim) ? 1.0 : 0.7;



                }



                if (tsIdx2 !== -1 && cols[tsIdx2]) {



                    var t2 = Date.parse(cols[tsIdx2]);



                    if (!isNaN(t2)) {



                        var days2 = (Date.now() - t2) / 86400000;



                        w *= Math.exp(-days2 / 90);



                    }



                }



                if (!isFinite(w) || w < 0.01) continue;



                points.push({ cq: cqV, vmaf: vmafV, w: w });



            }



            if (points.length < 6) {



                args.jobLog('Historical CQ curve: only ' + points.length + ' similar points - skipping');



                return;



            }



            // Keep the strongest evidence to bound variable size (variables travel over the wire).



            points.sort(function(a, b) { return b.w - a.w; });



            if (points.length > 200) points = points.slice(0, 200);



            var effNCurve = effectiveSampleSize(points);



            var distinctCqs = {};



            points.forEach(function(p) { distinctCqs[Math.round(p.cq)] = true; });



            args.variables.vmafHistoricalCqPoints = points;



            args.variables.vmafHistoricalCqMeta = {



                effN: Math.round(effNCurve * 10) / 10,



                pointCount: points.length,



                distinctCqCount: Object.keys(distinctCqs).length,



                tier: tier,



                codec: srcCodecCat



            };



            args.jobLog('Historical CQ curve preload: ' + points.length + ' points (effN=' + effNCurve.toFixed(1)



                + ', distinct CQs=' + Object.keys(distinctCqs).length + ', tier=' + tier + ', codec=' + srcCodecCat + ')');



        } catch (curveErr) {



            args.jobLog('Historical CQ curve preload error: ' + (curveErr && curveErr.message ? curveErr.message : String(curveErr)));



        }



    }



    // The CSV has no reference-contract column and this legacy sidecar preload
    // has no canonical consumer. Avoid synchronously reading the full results
    // file (currently >100 MB) for canonical jobs; the contract-aware SQLite
    // predictor performs any probe-planning lookup later.
    if (referenceContract.legacyHistory) {
        loadHistoricalCqPoints();
    } else {
        delete args.variables.vmafHistoricalCqPoints;
        delete args.variables.vmafHistoricalCqMeta;
        args.jobLog('Current VMAF contract: skipped contract-blind legacy CSV preload.');
    }







    function loadHistoricalVariance(csvPath, filters, maxLines) {



        if (!fs.existsSync(csvPath)) return null;



        var content = fs.readFileSync(csvPath, 'utf8');



        var lines = content.split('\n').filter(function(l) { return l.trim().length > 0; });



        if (lines.length < 2) return null;



        if (maxLines && lines.length > maxLines) {



            lines = [lines[0]].concat(lines.slice(lines.length - maxLines));



        }



        var headers = parseCSVLine(lines[0]).map(function(h) { return h.trim().replace(/^"|"$/g, ''); });



        var idx = function(name) { return headers.indexOf(name); };



        var widthIdx = idx('video_width');



        var heightIdx = idx('video_height');



        var codecIdx = idx('video_codec');



        var sampleVmafIdx = idx('sample_vmaf_score');



        var paramIdIdx = idx('parameter_set_id');



        var cqIdx = idx('cq');



        var mediaGenreIdx = idx('media_genre');



        var mediaAnimIdx = idx('media_is_animation');



        if (sampleVmafIdx === -1 || paramIdIdx === -1 || cqIdx === -1) return null;







        var groups = {};



        for (var i = 1; i < lines.length; i++) {



            var cols = parseCSVLine(lines[i]).map(function(v) { return v.replace(/^"|"$/g, ''); });



            var sVmaf = parseFloat(cols[sampleVmafIdx]);



            if (isNaN(sVmaf)) continue;



            var w = widthIdx !== -1 ? parseInt(cols[widthIdx]) || 0 : 0;



            var h = heightIdx !== -1 ? parseInt(cols[heightIdx]) || 0 : 0;



            var tier = resolutionTierFor(w || filters.width || 1920, h || filters.height || 1080);



            if (tier !== filters.resTier) continue;



            var codecCat = codecCategory(codecIdx !== -1 ? cols[codecIdx] : '');



            if (codecCat !== filters.codecCat) continue;



            var histAnim = mediaAnimIdx !== -1 ? (cols[mediaAnimIdx] === '1' || cols[mediaAnimIdx] === 'true') : null;



            if (histAnim !== null && filters.isAnimation !== null && histAnim !== filters.isAnimation) continue;



            var genreScore = genreOverlap(filters.genresLower, mediaGenreIdx !== -1 ? cols[mediaGenreIdx] : '');



            if (filters.genresLower.length > 0 && genreScore < 0.2) continue;







            var groupKey = (cols[paramIdIdx] || 'na') + '|' + (cols[cqIdx] || 'na') + '|' + (cols[mediaGenreIdx] || 'na');



            if (!groups[groupKey]) groups[groupKey] = [];



            groups[groupKey].push(sVmaf);



        }







        var stds = [];



        Object.keys(groups).forEach(function(k) {



            var vals = groups[k];



            if (vals.length >= 2) {



                stds.push(stddev(vals));



            }



        });



        if (stds.length === 0) return null;



        return {



            medianStd: median(stds),



            count: stds.length



        };



    }







    function parseBool(val) {



        if (val === true) return true;



        if (val === false) return false;



        var s = String(val || '').trim().toLowerCase();



        if (!s) return false;



        return s === 'true' || s === '1' || s === 'yes' || s === 'y';



    }



    function hashStr(str, buckets) {



        if (!str) return 0;



        var h = 5381;



        for (var i = 0; i < str.length; i++) {



            h = ((h << 5) + h) + str.charCodeAt(i);



        }



        return Math.abs(h) % buckets;



    }



    function deriveTitleKey(name) {



        if (!name) return '';



        var base = String(name).replace(/\.[^.]+$/, '');



        var m = base.match(/^(.*?)[ ._-]?s\d{1,2}e\d{1,2}/i);



        if (m && m[1]) base = m[1];



        base = base.replace(/[_\-\.]+/g, ' ').trim().toLowerCase();



        return base;



    }



    function loadSampleStdModel(csvPath, filters, maxLines, targetMode) {



        var SOURCE_TYPE_BUCKETS = 8;



        if (!fs.existsSync(csvPath)) return null;



        var content = fs.readFileSync(csvPath, 'utf8');



        var lines = content.split('\n').filter(function(l) { return l.trim().length > 0; });



        if (lines.length < 2) return null;



        if (maxLines && lines.length > maxLines) {



            lines = [lines[0]].concat(lines.slice(lines.length - maxLines));



        }



        var headers = parseCSVLine(lines[0]).map(function(h) { return h.trim().replace(/^"|"$/g, ''); });



        var idx = function(name) { return headers.indexOf(name); };



        var widthIdx = idx('video_width');



        var heightIdx = idx('video_height');



        var codecIdx = idx('video_codec');



        var hdrIdx = idx('is_hdr');



        var animIdx = idx('media_is_animation');



        var stdIdx = idx('aggregated_vmaf_stddev');



        var meanIdx = idx('aggregated_vmaf_mean');



        var minIdx = idx('aggregated_vmaf_min');



        var countIdx = idx('aggregated_sample_count');



        var bitrateIdx = idx('video_bitrate');



        var durIdx = idx('duration_seconds');



        var tsIdx = idx('timestamp');



        var rgIdx = idx('release_group');



        var fileNameIdx = idx('file_name');



        var yearIdx = idx('media_year');



        var sourceTypeIdx = idx('media_source_type');



        var filterSourceType = filters && filters.sourceType ? String(filters.sourceType).toLowerCase() : '';



        if (targetMode === 'meanmin') {



            if (meanIdx === -1 || minIdx === -1 || countIdx === -1) return null;



        } else {



            if (stdIdx === -1 || countIdx === -1) return null;



        }







        var rows = [];



        for (var i = 1; i < lines.length; i++) {



            var cols = parseCSVLine(lines[i]).map(function(v) { return v.replace(/^"|"$/g, ''); });



            var w = widthIdx !== -1 ? parseInt(cols[widthIdx]) || 0 : 0;



            var h = heightIdx !== -1 ? parseInt(cols[heightIdx]) || 0 : 0;



            var codecCat = codecCategory(codecIdx !== -1 ? cols[codecIdx] : '');



            var isHdrVal = hdrIdx !== -1 ? parseBool(cols[hdrIdx]) : false;



            var isAnimVal = animIdx !== -1 ? parseBool(cols[animIdx]) : false;



            var nVal = parseInt(cols[countIdx]) || 0;



            var stdVal;



            if (targetMode === 'meanmin') {



                var mv = meanIdx !== -1 ? parseFloat(cols[meanIdx]) : NaN;



                var mnv = minIdx !== -1 ? parseFloat(cols[minIdx]) : NaN;



                stdVal = (isFinite(mv) && isFinite(mnv)) ? Math.max(0, mv - mnv) : NaN;



            } else {



                stdVal = parseFloat(cols[stdIdx]);



            }



            if (isNaN(stdVal) || nVal <= 0) continue;



            var bitrateVal = bitrateIdx !== -1 ? parseFloat(cols[bitrateIdx]) || 0 : 0;



            var durVal = durIdx !== -1 ? parseFloat(cols[durIdx]) || 0 : 0;



            var releaseKey = rgIdx !== -1 ? (cols[rgIdx] || '') : '';



            var titleKey = fileNameIdx !== -1 ? deriveTitleKey(cols[fileNameIdx]) : '';



            var releaseYear = yearIdx !== -1 ? parseInt(cols[yearIdx]) || 0 : 0;



            var sourceTypeVal = sourceTypeIdx !== -1 ? String(cols[sourceTypeIdx] || '').toLowerCase() : '';



            var weight = 1;



            if (tsIdx !== -1 && cols[tsIdx]) {



                var t = Date.parse(cols[tsIdx]);



                if (!isNaN(t)) {



                    var days = (Date.now() - t) / (1000 * 60 * 60 * 24);



                    weight = Math.exp(-days / 180);



                }



            }



            if (filterSourceType && filterSourceType !== 'unknown') {



                if (sourceTypeVal && sourceTypeVal !== 'unknown') {



                    weight *= (sourceTypeVal === filterSourceType) ? 1.0 : 0.65;



                } else {



                    weight *= 0.8;



                }



            }



            rows.push({



                n: nVal,



                std: stdVal,



                w: weight,



                width: w,



                height: h,



                codec: codecCat,



                hdr: isHdrVal,



                anim: isAnimVal,



                bitrate: bitrateVal,



                duration: durVal,



                release: releaseKey,



                title: titleKey,



                year: releaseYear,



                source: sourceTypeVal



            });



        }



        if (rows.length < 5) return null;







        // Build features and fit ridge regression: std ~ beta * X



        function makeFeatures(row) {



            var pixels = Math.max(1, row.width * row.height || 0);



            var RG_BUCKETS = 12;



            var TITLE_BUCKETS = 16;



            var f = [];



            f.push(1); // bias



            f.push(1 / Math.sqrt(row.n));



            f.push(Math.log10(Math.max(0.1, row.bitrate / 1000000 || 0.1))); // Mbps



            f.push(Math.log10(Math.max(1, row.duration || 1)));



            f.push(Math.log10(Math.max(1, pixels)));



            f.push(row.hdr ? 1 : 0);



            f.push(row.anim ? 1 : 0);



            f.push(row.codec === 'hevc' ? 1 : 0);



            f.push(row.codec === 'av1' ? 1 : 0);



            f.push(row.year ? row.year / 2100 : 0); // normalized release year to keep scale stable



            var rgBucket = hashStr(String(row.release || '').toLowerCase(), RG_BUCKETS);



            for (var i = 0; i < RG_BUCKETS; i++) {



                f.push(i === rgBucket ? 1 : 0);



            }



            var srcBucket = hashStr(String(row.source || '').toLowerCase(), SOURCE_TYPE_BUCKETS);



            for (var k = 0; k < SOURCE_TYPE_BUCKETS; k++) {



                f.push(k === srcBucket ? 1 : 0);



            }



            var titleBucket = hashStr(String(row.title || '').toLowerCase(), TITLE_BUCKETS);



            for (var j = 0; j < TITLE_BUCKETS; j++) {



                f.push(j === titleBucket ? 1 : 0);



            }



            return f;



        }







        var d = makeFeatures(rows[0]).length; // feature count



        var XtWX = [];



        for (var r1 = 0; r1 < d; r1++) {



            XtWX[r1] = [];



            for (var r2 = 0; r2 < d; r2++) XtWX[r1][r2] = 0;



        }



        var XtWy = new Array(d).fill(0);



        var lambda = 0.1;



        for (var r = 0; r < rows.length; r++) {



            var fvec = makeFeatures(rows[r]);



            var wght = rows[r].w;



            for (var a = 0; a < d; a++) {



                XtWy[a] += fvec[a] * rows[r].std * wght;



                for (var b = 0; b < d; b++) {



                    XtWX[a][b] += fvec[a] * fvec[b] * wght;



                }



            }



        }



        for (var k = 0; k < d; k++) {



            XtWX[k][k] += lambda;



        }







        function solve(A, b) {



            var n = A.length;



            // Augment



            for (var i = 0; i < n; i++) {



                A[i] = A[i].slice();



                A[i].push(b[i]);



            }



            for (var col = 0; col < n; col++) {



                // pivot



                var pivot = col;



                for (var r = col + 1; r < n; r++) {



                    if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;



                }



                if (Math.abs(A[pivot][col]) < 1e-9) return null;



                if (pivot !== col) {



                    var tmp = A[col]; A[col] = A[pivot]; A[pivot] = tmp;



                }



                var div = A[col][col];



                for (var c = col; c < n + 1; c++) A[col][c] /= div;



                for (var r2 = 0; r2 < n; r2++) {



                    if (r2 === col) continue;



                    var factor = A[r2][col];



                    for (var c2 = col; c2 < n + 1; c2++) {



                        A[r2][c2] -= factor * A[col][c2];



                    }



                }



            }



            var x = new Array(n);



            for (var i2 = 0; i2 < n; i2++) x[i2] = A[i2][n];



            return x;



        }







        var beta = solve(XtWX, XtWy);



        if (!beta) return null;







        // Compute weighted RMSE for goodness of fit



        var sumErr = 0;



        var wTot = 0;



        for (var r = 0; r < rows.length; r++) {



            var fvec = makeFeatures(rows[r]);



            var pred = 0;



            for (var i = 0; i < beta.length && i < fvec.length; i++) {



                pred += beta[i] * fvec[i];



            }



            var err = rows[r].std - pred;



            sumErr += rows[r].w * err * err;



            wTot += rows[r].w;



        }



        var rmse = wTot > 0 ? Math.sqrt(sumErr / wTot) : null;







        return { beta: beta, count: rows.length, rmse: rmse };



    }







    var streamMeta = getVideoStream(args.inputFileObj) ||
      ((args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.streams && args.inputFileObj.ffProbeData.streams[0]) ? args.inputFileObj.ffProbeData.streams[0] : {});



    var formatMeta = (args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.format) ? args.inputFileObj.ffProbeData.format : {};



    var sourceWidth = streamMeta.width || 1920;



    var sourceHeight = streamMeta.height || 1080;



    var sourceCodec = streamMeta.codec_name || args.inputFileObj.codec || 'unknown';



    var sourceBitrateMbps = 0;



    try {



        var streamBr = parseFloat(streamMeta.bit_rate);



        if (!isNaN(streamBr) && streamBr > 0) {



            sourceBitrateMbps = streamBr / 1000000;



        } else {



            var formatBr = parseFloat(formatMeta.bit_rate);



            if (!isNaN(formatBr) && formatBr > 0) {



                sourceBitrateMbps = formatBr / 1000000;



            }



        }



        if (sourceBitrateMbps <= 0 && videoDuration > 0) {



            var sizeBytes = Number(args.inputFileObj.file_size || 0);



            if (!sizeBytes) {



                sizeBytes = Number(formatMeta.size || 0);



            }



            if (sizeBytes > 0) {



                sourceBitrateMbps = (sizeBytes * 8) / (videoDuration * 1000000);



            }



        }



    } catch (e) {



        sourceBitrateMbps = 0;



    }



    // Carry source-rate features into downstream plugins. They were previously computed
    // only for local priors and then lost, so the live size model imputed both fields.
    var sourceFrameRate = 0;
    try {
        var sourceRate = String(streamMeta.avg_frame_rate || streamMeta.r_frame_rate || '');
        var sourceRateMatch = sourceRate.match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
        if (sourceRateMatch) {
            var sourceRateNum = Number(sourceRateMatch[1]);
            var sourceRateDen = sourceRateMatch[2] ? Number(sourceRateMatch[2]) : 1;
            if (sourceRateNum > 0 && sourceRateDen > 0) sourceFrameRate = sourceRateNum / sourceRateDen;
        }
    } catch (eSourceRate) {}
    var liveSourceBpp = sourceWidth > 0 && sourceHeight > 0 && sourceFrameRate > 0 && sourceBitrateMbps > 0
        ? (sourceBitrateMbps * 1000000) / (sourceWidth * sourceHeight * sourceFrameRate)
        : null;
    args.variables.vmafSourceBitrateMbps = sourceBitrateMbps > 0 ? sourceBitrateMbps : null;
    args.variables.vmafSourceBpp = liveSourceBpp !== null && isFinite(liveSourceBpp) && liveSourceBpp > 0
        ? liveSourceBpp : null;
    args.variables.vmafSourceFps = sourceFrameRate > 0 ? sourceFrameRate : null;

    var sourceTier = resolutionTierFor(sourceWidth, sourceHeight);



    var currentGenresLower = (args.variables.vmafMediaGenre || []).map(function(g) { return String(g).toLowerCase(); });



    var currentIsAnimation = args.variables.vmafMediaIsAnimation === true ? true : (currentGenresLower.some(function(g) { return g.indexOf('animation') !== -1 || g.indexOf('anime') !== -1 || g.indexOf('cartoon') !== -1; }) ? true : null);



    var currentSourceType = String(args.variables.vmafMediaSourceType || 'unknown').toLowerCase();







    if (adaptiveSamples) {



        try {



            var legacyTargetStd = 1.5;



            var adaptiveMode = (String(args.inputs.adaptiveTargetMode || 'meanmin').toLowerCase() === 'stddev') ? 'stddev' : 'meanmin';



            var deltaThreshold = Number(args.inputs.meanMinDeltaThreshold);



            if (isNaN(deltaThreshold) || deltaThreshold <= 0) deltaThreshold = 0.2;



            var coverageFraction = Number(args.inputs.meanMinCoverageFraction);



            if (isNaN(coverageFraction) || coverageFraction <= 0 || coverageFraction > 1) coverageFraction = 0.6;



            if (!resultsCsvPath || !fs.existsSync(resultsCsvPath)) {



                args.jobLog('Adaptive samples: results path not found at ' + resultsCsvPath + ' - checking SQLite training store');



                throw new Error('resultsCsvPath missing');



            }



            var adaptiveFilterObj = {



                resTier: sourceTier,



                codecCat: codecCategory(sourceCodec),



                isHDR: parseBool(args.variables.isHDR),



                isAnimation: currentIsAnimation,



                width: sourceWidth,



                height: sourceHeight,



                genresLower: currentGenresLower,



                sourceType: currentSourceType



            };



            var model = loadSampleStdModel(resultsCsvPath, adaptiveFilterObj, 4000, adaptiveMode);



            var stdModelForLog = (adaptiveMode === 'meanmin') ? loadSampleStdModel(resultsCsvPath, adaptiveFilterObj, 4000, 'stddev') : null;







            if (model) {



                var originalNum = numSegments;



                var chosen = null;



                var fitRmseStr = (model.rmse !== null && model.rmse !== undefined) ? model.rmse.toFixed(3) : 'n/a';



                function buildFeaturesFor(n) {



                    var pixels = Math.max(1, sourceWidth * sourceHeight || 0);



                    var RG_BUCKETS = 12;



                    var TITLE_BUCKETS = 16;



                    var f = [];



                    f.push(1);



                    f.push(1 / Math.sqrt(n));



            f.push(Math.log10(Math.max(0.1, sourceBitrateMbps || 0.1)));



            f.push(Math.log10(Math.max(1, videoDuration || 1)));



            f.push(Math.log10(Math.max(1, pixels)));



            f.push(parseBool(args.variables.isHDR) ? 1 : 0);



            f.push(currentIsAnimation ? 1 : 0);



            f.push(codecCategory(sourceCodec) === 'hevc' ? 1 : 0);



            f.push(codecCategory(sourceCodec) === 'av1' ? 1 : 0);



            var releaseYear = args.variables.vmafMediaYear || 0;



            f.push(releaseYear ? releaseYear / 2100 : 0);



            var releaseKey = String(args.variables.vmafReleaseGroup || args.variables.vmafReleaseGroupUsed || '').toLowerCase();



            var rgBucket = hashStr(releaseKey, RG_BUCKETS);



            for (var i = 0; i < RG_BUCKETS; i++) {



                f.push(i === rgBucket ? 1 : 0);



            }



                    var titleKey = deriveTitleKey(args.inputFileObj.file_name || args.inputFileObj._id || '');



                    var titleBucket = hashStr(String(titleKey).toLowerCase(), TITLE_BUCKETS);



                    for (var j = 0; j < TITLE_BUCKETS; j++) {



                        f.push(j === titleBucket ? 1 : 0);



                    }



                    return f;



                }



                function predict(n) {



                    var f = buildFeaturesFor(n);



                    var s = 0;



                    for (var i = 0; i < model.beta.length && i < f.length; i++) {



                        s += model.beta[i] * f[i];



                    }



                    return s;



                }



                                if (adaptiveMode === 'meanmin') {



                    // Mean-min gap targeting: choose N where (A) the gap curve has stabilised



                    // (marginal growth < deltaThreshold) AND (B) we have covered enough of the



                    // quality-floor headroom. Take the max of the two so both are satisfied.



                    var hdrNow = parseBool(args.variables.isHDR);



                    var animNow = currentIsAnimation === true;



                    var pxNow = sourceWidth * sourceHeight;



                    var tierFloor;



                    if (pxNow >= 3800 * 1800) tierFloor = animNow ? 88.5 : (hdrNow ? 90.5 : 90.0);



                    else if (pxNow >= 2500 * 1300) tierFloor = animNow ? 88.5 : (hdrNow ? 90.0 : 89.5);



                    else if (pxNow >= 1700 * 900) tierFloor = animNow ? 88.0 : (hdrNow ? 89.5 : 89.0);



                    else if (pxNow >= 1100 * 650) tierFloor = animNow ? 87.5 : 88.5;



                    else tierFloor = animNow ? 86.0 : 87.0;



                    var targetMeanVmaf = Number(args.variables.vmafMinVMAF) || Number(args.inputs.targetMinVMAF) || 95;



                    var headroom = Math.max(1.0, targetMeanVmaf - tierFloor);



                    var coverageTargetGap = headroom * coverageFraction;



                    var preds = {};



                    for (var nn = minSegments; nn <= maxSegments; nn++) preds[nn] = Math.max(0, predict(nn));



                    var knee = null;



                    for (var na = minSegments; na < maxSegments; na++) {



                        if ((preds[na + 1] - preds[na]) < deltaThreshold) { knee = na; break; }



                    }



                    if (knee === null) knee = maxSegments;



                    var cover = null;



                    for (var nb = minSegments; nb <= maxSegments; nb++) {



                        if (preds[nb] >= coverageTargetGap) { cover = nb; break; }



                    }



                    if (cover === null) cover = maxSegments;



                    var combinedN = Math.max(knee, cover);



                    combinedN = Math.max(minSegments, Math.min(maxSegments, combinedN));



                    chosen = { n: combinedN, pred: preds[combinedN] };



                    numSegments = combinedN;



                    var stdNote = '';



                    if (stdModelForLog && stdModelForLog.beta) {



                        var sf = buildFeaturesFor(combinedN);



                        var sp = 0;



                        for (var si2 = 0; si2 < stdModelForLog.beta.length && si2 < sf.length; si2++) sp += stdModelForLog.beta[si2] * sf[si2];



                        stdNote = ', legacy std pred=' + sp.toFixed(3);



                    }



                    args.variables.vmafAdaptiveSampleReason = 'Mean-min adaptive: knee N=' + knee + ', coverage N=' + cover + ' (targetGap=' + coverageTargetGap.toFixed(2) + ' VMAF, floor=' + tierFloor.toFixed(1) + ', headroom=' + headroom.toFixed(1) + '), predicted gap@N=' + preds[combinedN].toFixed(2) + ', rows=' + model.count + ', rmse=' + fitRmseStr;







                } else {



                    for (var n = minSegments; n <= maxSegments; n++) {



                        var pred = predict(n);



                        if (pred <= legacyTargetStd) { chosen = { n: n, pred: pred }; break; }



                    }



                    if (!chosen) { var predMax = predict(maxSegments); chosen = { n: maxSegments, pred: predMax }; }



                    numSegments = chosen.n;



                    args.variables.vmafAdaptiveSampleReason = 'Learned target std<= ' + legacyTargetStd + ' (pred=' + chosen.pred.toFixed(3) + ', model from ' + model.count + ' rows, rmse=' + fitRmseStr + ')';







                }



            } else {



                    args.jobLog('Adaptive samples: insufficient variance data, using ' + numSegments + ' samples');



            }



        } catch (adaptiveErr) {



            args.jobLog('Adaptive samples disabled due to error reading priors: ' + adaptiveErr.message);



        }



    }







    numSegments = Math.max(minSegments, Math.min(maxSegments, numSegments));







    // ── SE-based adaptive sample count (supersedes the gap-knee/coverage heuristic above) ──
    // Targets the precision of the VMAF MEAN (SE = sigma/sqrt(N)) scaled by the content slope so
    // the sweep curve's target-crossing is accurate to ~0.75 CQ. High-variance content gets more
    // clips, low-variance fewer (the old coverage rule did the opposite). sigma + slope come from
    // similar content in vmaf_training.db. Non-fatal: falls back to the value computed above.
    if (referenceContract.legacyHistory) try {
        var _vdbS = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
        var _vpS = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafpredict.js');
        var _dbS = _vdbS.openDb();
        var _strmS = (args.inputFileObj && args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.streams) || [];
        var _vsS = null; for (var _ssi = 0; _ssi < _strmS.length; _ssi++) { if (_strmS[_ssi].codec_type === 'video') { _vsS = _strmS[_ssi]; break; } }
        var _wS = (_vsS && _vsS.width) || (typeof sourceWidth !== 'undefined' ? sourceWidth : 0);
        var _hS = (_vsS && _vsS.height) || (typeof sourceHeight !== 'undefined' ? sourceHeight : 0);
        var _tgtS = Number(args.inputs.targetMinVMAF) || Number(args.variables.vmafMinVMAF) || 95;
        var _srcS = {
            tier: _vdbS.tierFor(_wS, _hS),
            source_codec: (_vsS && _vsS.codec_name) || '',
            bits_per_pixel: (typeof bitsPerPixel !== 'undefined' && isFinite(bitsPerPixel)) ? bitsPerPixel : null,
            media_is_animation: args.variables.vmafMediaIsAnimation === true ? 1 : 0,
            is_hdr: args.variables.isHDR ? 1 : 0,
            media_genre: args.variables.vmafMediaGenre || null,
            media_type: args.variables.vmafMediaType || null,
            media_year: args.variables.vmafMediaYear || null,
            release_group: args.variables.vmafReleaseGroup || null,
            network: args.variables.vmafNetwork || null,
            original_language: args.variables.vmafOriginalLanguage || null,
            source_cambi: (args.variables.vmafSourceCAMBI != null ? Number(args.variables.vmafSourceCAMBI) : null),
            source_cambi_p95: (args.variables.vmafSourceCAMBIP95 != null ? Number(args.variables.vmafSourceCAMBIP95) : null),
            file_path: (args.inputFileObj && args.inputFileObj._id) || null
        };
        var _curvesS = _vdbS.getSimilarSweepCurves(_dbS, _srcS, {
            limit: 20000,
            referenceContractId: args.variables.vmafReferenceContractId,
        });
        var _ctrS = _vpS.predictCQCenter(_curvesS, _srcS, { targetVmaf: _tgtS }, { recencyHalfLifeDays: 0 });
        var _slopeS = (_ctrS && _ctrS.priorSlope != null) ? _ctrS.priorSlope : -0.4;
        var _scS = _vpS.selectSampleCount(_curvesS, {
            slope: _slopeS, minSamples: minSegments, maxSamples: maxSegments, cqPrecision: 0.75, distMinSamples: 4
        });
        if (_scS && _scS.sampleCount && _scS.reason !== 'no_variance_data') {
            var _preS = numSegments;
            numSegments = Math.max(minSegments, Math.min(maxSegments, _scS.sampleCount));
            args.variables.vmafAdaptiveSampleReason = 'SE-based: N=' + numSegments + ' (sigma=' + _scS.sigma + ' [' + _scS.sigmaSource + '], tol=' + _scS.tol + ' VMAF @slope ' + _scS.slope + ', CI@N=' + _scS.ciHalfWidthAtN + ')';
            args.jobLog('Adaptive samples (SE-based): ' + numSegments + ' (was ' + _preS + ') - sigma=' + _scS.sigma + ' [' + _scS.sigmaSource + '], SE target tol=' + _scS.tol + ' VMAF (slope ' + _scS.slope + '), predicted CI@N=' + _scS.ciHalfWidthAtN);
        }
    } catch (_scErr) {
        args.jobLog('SE-based sample count skipped (non-fatal, keeping ' + numSegments + '): ' + _scErr.message);
    }

    // Apply scene complexity adjustment



    if (args.variables.vmafSceneSampleAdjustment !== undefined) {



        var sceneAdj = args.variables.vmafSceneSampleAdjustment;



        var preSampleCount = numSegments;



        numSegments = Math.max(minSegments, Math.min(maxSegments, numSegments + sceneAdj));







    }











    // Risk-aware sampling advisory only. Mean-min adaptive sampling decides N; this



    // block records/logs the old tier recommendation without forcing extra samples.



    try {



        var riskStream = getVideoStream(args.inputFileObj);



        var rw = riskStream ? Number(riskStream.width || 0) : 0;



        var rh = riskStream ? Number(riskStream.height || 0) : 0;



        var rpixels = rw * rh;



        var rfmt = String((riskStream && riskStream.pix_fmt) || '').toLowerCase();



        var rbits = Number((riskStream && (riskStream.bits_per_raw_sample || riskStream.bits_per_sample)) || 0);



        var rhdr = args.variables.isHDR === true || args.variables.vmafIsHDR === true;



        var rgenre = String(args.variables.vmafMediaGenre || '').toLowerCase();



        var ranim = args.variables.vmafMediaIsAnimation === true



            || String(args.variables.vmafMediaIsAnimation).toLowerCase() === 'true'



            || rgenre.indexOf('animation') !== -1 || rgenre.indexOf('anime') !== -1;



        var riskRecommendedSamples = minSegments;



        if (!ranim && (rw >= 3800 || rh >= 1800 || rpixels >= 7000000)) riskRecommendedSamples = rhdr ? 8 : 7;



        else if (!ranim && (rw >= 1700 || rh >= 900 || rpixels >= 1600000)



            && (rhdr || rfmt.indexOf('10') !== -1 || rbits >= 10)) riskRecommendedSamples = 7;



        else if (!ranim && (rw >= 1700 || rh >= 900 || rpixels >= 1600000)) riskRecommendedSamples = 6;



        args.variables.vmafRiskRecommendedSampleCount = riskRecommendedSamples;



        if (riskRecommendedSamples > numSegments) {



            args.jobLog('Risk advisory: adaptive sampling chose ' + numSegments



                + ' samples; old tier recommendation would have been ' + riskRecommendedSamples



                + ' for ' + rw + 'x' + rh + (rhdr ? ' HDR' : ' SDR') + (ranim ? ' animation' : ' live-action')



                + '. Not forcing the floor.');



        }



    } catch (riskSampleErr) {



        args.jobLog('Risk advisory skipped: ' + (riskSampleErr && riskSampleErr.message ? riskSampleErr.message : String(riskSampleErr)));



    }







    args.variables.vmafAdaptiveSampleCount = numSegments;







    // Stratified sampling or uniform sampling



    var stratifiedSampling = args.inputs.stratifiedSampling !== false && args.inputs.stratifiedSampling !== 'false';



    var stratifiedRandomRange = Number(args.inputs.stratifiedRandomRange) || 0.33;







    var segmentPositions = [];



    if (stratifiedSampling) {



        // Stratified sampling: divide video into segments and sample from each segment center with random offset



        var segmentLength = (videoDuration - segmentDuration) / numSegments;







for (var i = 0; i < numSegments; i++) {



            var segStart = i * segmentLength;



            var segMid = segStart + segmentLength / 2;







            // Random offset within specified range (default ±1/6 segment)



            var maxOffset = segmentLength * stratifiedRandomRange / 2;



            var offset = (Math.random() - 0.5) * 2 * maxOffset;







            var pos = Math.max(0, Math.min(segMid + offset, videoDuration - segmentDuration));



            segmentPositions.push(pos);



        }







        args.jobLog('Using stratified sampling with ±' + maxOffset.toFixed(1) + 's random offset');



    } else {



        // Original uniform spacing (kept as fallback)



        var spacing = (videoDuration - (segmentDuration * numSegments)) / (numSegments + 1);



        for (var i = 0; i < numSegments; i++) {



            var pos = spacing * (i + 1) + (segmentDuration * i);



            segmentPositions.push(Math.max(0, Math.min(pos, videoDuration - segmentDuration)));



        }



        args.jobLog('Using uniform sampling');



    }







    args.jobLog('Sample positions: ' + segmentPositions.map(function(p) { return p.toFixed(1) + 's'; }).join(', '));







    // Dark-scene bias: VMAF's main blind spot is banding/detail loss in dark scenes, and



    // stratified-random positions rarely land on the darkest content. Probe average luma



    // (one frame per candidate position, ~0.3s each) and if no selected position falls in



    // the darkest quartile of probes, swap the brightest selection for the darkest



    // alternate. Relative comparison only, so it works for SDR/HDR/8/10-bit alike.



    try {



        if (segmentPositions.length >= 3 && videoDuration > segmentDuration * 3) {



            var probeStream = getVideoStream(args.inputFileObj);



            var probeMap = probeStream ? '0:v:' + probeStream.typeIndex : '0:v:0';



            var execFileSyncProbe = require('child_process').execFileSync;
            var probeTimedOut = false;
            var probeStats = function(pos) {
                if (probeTimedOut) return { luma: null, motion: null, timedOut: true };
                try {
                    // Invoke FFmpeg directly. execSync used a shell, so its timeout killed only
                    // /bin/sh and left the expensive decoder orphaned under PID 1. Downscaling is
                    // sufficient for relative luma/motion ranking and makes three-frame probes cheap.
                    var pOut = execFileSyncProbe(args.ffmpegPath, [
                        '-hide_banner', '-loglevel', 'error', '-threads', '1',
                        '-ss', pos.toFixed(2), '-i', inputFile,
                        '-map', probeMap, '-frames:v', '3',
                        '-vf', 'scale=320:-2,signalstats,metadata=print:file=-',
                        '-an', '-sn', '-dn', '-f', 'null', '-'
                    ], {
                        stdio: ['ignore', 'pipe', 'pipe'],
                        timeout: 20000,
                        killSignal: 'SIGKILL',
                        maxBuffer: 4 * 1024 * 1024
                    }).toString();
                    var pm = pOut.match(/YAVG=([0-9.]+)/);
                    // YDIF = mean abs luma difference vs previous frame; max over the 3 probed
                    // frames is a cheap temporal-complexity (motion) proxy at this position.
                    var motion = null;
                    var dm, dre = /YDIF=([0-9.]+)/g;
                    while ((dm = dre.exec(pOut)) !== null) {
                        var dv = parseFloat(dm[1]);
                        if (isFinite(dv) && (motion === null || dv > motion)) motion = dv;
                    }
                    return { luma: pm ? parseFloat(pm[1]) : null, motion: motion, timedOut: false };
                } catch (pe) {
                    var timedOut = !!(pe && (pe.code === 'ETIMEDOUT' || pe.killed || pe.signal === 'SIGKILL'));
                    if (timedOut) {
                        probeTimedOut = true;
                        args.jobLog('Dark-scene probe timed out; stopping remaining probes and retaining existing sample positions.');
                    }
                    return { luma: null, motion: null, timedOut: timedOut };
                }
            };



            var probes = [];



            for (var spi = 0; spi < segmentPositions.length && probes.length < 12; spi++) {



                var pstSel = probeStats(segmentPositions[spi]);
                if (pstSel.timedOut) break;
                probes.push({ pos: segmentPositions[spi], selected: true, idx: spi, luma: pstSel.luma, motion: pstSel.motion });



            }



            for (var sai = 0; !probeTimedOut && sai < segmentPositions.length - 1 && probes.length < 12; sai++) {



                var altPos = (segmentPositions[sai] + segmentPositions[sai + 1]) / 2;



                var pstAlt = probeStats(altPos);
                if (pstAlt.timedOut) break;
                probes.push({ pos: altPos, selected: false, idx: -1, luma: pstAlt.luma, motion: pstAlt.motion });



            }



            var valid = probes.filter(function(p) { return p.luma !== null && isFinite(p.luma); });



            if (valid.length >= 4) {



                var lumasSorted = valid.map(function(p) { return p.luma; }).sort(function(a, b) { return a - b; });



                var q25 = lumasSorted[Math.floor((lumasSorted.length - 1) * 0.25)];



                var selectedValid = valid.filter(function(p) { return p.selected; });



                var hasDark = selectedValid.some(function(p) { return p.luma <= q25; });



                if (!hasDark) {



                    var darkestAlt = null;



                    valid.forEach(function(p) {



                        if (!p.selected && (darkestAlt === null || p.luma < darkestAlt.luma)) darkestAlt = p;



                    });



                    var brightestSel = null;



                    selectedValid.forEach(function(p) {



                        if (brightestSel === null || p.luma > brightestSel.luma) brightestSel = p;



                    });



                    if (darkestAlt && brightestSel && darkestAlt.luma < brightestSel.luma) {



                        args.jobLog('Dark-scene bias: no selected position in darkest luma quartile (q25=' + q25.toFixed(1) + ').'



                            + ' Swapping position ' + brightestSel.pos.toFixed(1) + 's (luma ' + brightestSel.luma.toFixed(1) + ')'



                            + ' for ' + darkestAlt.pos.toFixed(1) + 's (luma ' + darkestAlt.luma.toFixed(1) + ')');



                        segmentPositions[brightestSel.idx] = darkestAlt.pos;
                        darkestAlt.selected = true; darkestAlt.idx = brightestSel.idx; darkestAlt.darkCover = true;
                        brightestSel.selected = false; brightestSel.idx = -1;



                        args.variables.vmafDarkSceneSwap = { from: brightestSel.pos, to: darkestAlt.pos, luma: darkestAlt.luma };



                    }



                } else {
                    // Tag the dark-coverage pick so the high-motion pass below never swaps it out.
                    selectedValid.forEach(function(p) { if (p.luma <= q25) p.darkCover = true; });
                    args.jobLog('Dark-scene bias: selected positions already cover the darkest luma quartile (q25=' + q25.toFixed(1) + ')');



                }



            }



        }



    } catch (darkErr) {



        args.jobLog('Dark-scene bias probe skipped: ' + (darkErr && darkErr.message ? darkErr.message : String(darkErr)));



    }

    // High-motion bias: the binding constraints (1%-low VMAF, CAMBI) are worst-case statistics,
    // and representative positions under-sample the most temporally complex content the encoder
    // will struggle with. Reuse the same probes: if no selected position reaches the top motion
    // quartile, swap the lowest-motion selected position (never the dark-coverage pick) for the
    // highest-motion alternate. Relative comparison only, cost already paid by the luma probes.
    try {
        if (typeof probes !== 'undefined' && probes && probes.length >= 4) {
            var mValid = probes.filter(function(p) { return p.motion !== null && isFinite(p.motion); });
            if (mValid.length >= 4) {
                var motionsSorted = mValid.map(function(p) { return p.motion; }).sort(function(a, b) { return a - b; });
                var mq75 = motionsSorted[Math.floor((motionsSorted.length - 1) * 0.75)];
                var mSelected = mValid.filter(function(p) { return p.selected; });
                var hasFast = mSelected.some(function(p) { return p.motion >= mq75; });
                if (!hasFast) {
                    var fastestAlt = null;
                    mValid.forEach(function(p) {
                        if (!p.selected && (fastestAlt === null || p.motion > fastestAlt.motion)) fastestAlt = p;
                    });
                    var slowestSel = null;
                    mSelected.forEach(function(p) {
                        if (!p.darkCover && (slowestSel === null || p.motion < slowestSel.motion)) slowestSel = p;
                    });
                    if (fastestAlt && slowestSel && slowestSel.idx >= 0 && fastestAlt.motion > slowestSel.motion) {
                        args.jobLog('High-motion bias: no selected position in the top motion quartile (q75=' + mq75.toFixed(1) + ').'
                            + ' Swapping position ' + slowestSel.pos.toFixed(1) + 's (motion ' + slowestSel.motion.toFixed(1) + ')'
                            + ' for ' + fastestAlt.pos.toFixed(1) + 's (motion ' + fastestAlt.motion.toFixed(1) + ')');
                        segmentPositions[slowestSel.idx] = fastestAlt.pos;
                        fastestAlt.selected = true; fastestAlt.idx = slowestSel.idx;
                        slowestSel.selected = false; slowestSel.idx = -1;
                        args.variables.vmafMotionSceneSwap = { from: slowestSel.pos, to: fastestAlt.pos, motion: fastestAlt.motion };
                    }
                } else {
                    args.jobLog('High-motion bias: selected positions already cover the top motion quartile (q75=' + mq75.toFixed(1) + ')');
                }
            }
        }
    } catch (motionErr) {
        args.jobLog('High-motion bias pass skipped: ' + (motionErr && motionErr.message ? motionErr.message : String(motionErr)));
    }







    // Keep source-copy clips solely for original-signal feature analysis. CQ
    // encoding and VMAF consume the canonical denoised FFV1 clips below.
    var samplePaths = [];
    var denoisedSamplePaths = [];

    // Source-time position of each successfully extracted sample, index-aligned with samplePaths.
    // Pushed at the same site as samplePaths so a failed extraction cannot misalign the arrays.
    var samplePositions = [];



    function chooseHoldoutPosition(positions, duration, segDur) {

        var safeEnd = Math.max(0, duration - segDur);

        if (!positions || positions.length === 0) return Math.max(0, Math.min(safeEnd, duration * 0.82));

        var pts = positions.slice().sort(function(a, b) { return a - b; });

        var bestGap = -1;

        var bestPos = Math.max(0, Math.min(safeEnd, duration * 0.82));

        var boundaries = [0].concat(pts).concat([safeEnd]);

        for (var hi = 0; hi < boundaries.length - 1; hi++) {

            var left = boundaries[hi];

            var right = boundaries[hi + 1];

            var gap = right - left;

            if (gap > bestGap) {

                bestGap = gap;

                bestPos = Math.max(0, Math.min(safeEnd, left + gap / 2));

            }

        }

        var tooClose = pts.some(function(p) { return Math.abs(p - bestPos) < Math.max(segDur * 1.5, 8); });

        if (tooClose) bestPos = Math.max(0, Math.min(safeEnd, duration * 0.82));

        return bestPos;

    }





    var keyframeAlign = String(args.inputs.keyframeAlign) === 'true';



    var keyframeSeekWindowSeconds = Number(args.inputs.keyframeSeekWindowSeconds);



    if (isNaN(keyframeSeekWindowSeconds) || keyframeSeekWindowSeconds < 0) {



        keyframeSeekWindowSeconds = 30;



    }







    // Report initial progress



    if (args.updateWorker) {



        args.updateWorker({ percentage: 0 });



    }







    for (var i = 0; i < numSegments; i++) {



        var position = segmentPositions[i];



        var startTime = position.toFixed(2);



        var outputPath = cacheDir + '/' + fileName + '_sample_' + (i + 1) + '.' + container;







        var progressPercent = Math.round((i / numSegments) * 100);



        args.jobLog('Extracting sample ' + (i + 1) + '/' + numSegments + ': ' + startTime + 's [' + progressPercent + '%]');







        // Update progress



        if (args.updateWorker) {



            args.updateWorker({ percentage: progressPercent });



        }







        // Find the primary video stream (skip cover images/attached pics)



        var primaryStream = getVideoStream(args.inputFileObj);



        var videoMap = primaryStream ? '0:v:' + primaryStream.typeIndex : '0:v:0';







        // Single input seek only. With -c:v copy, an input seek starts at the keyframe



        // at/before the position, so the window always contains video packets. The old



        // fast-seek + output-seek combo copied ZERO packets whenever no keyframe fell



        // inside the short window (10s+ GOPs are common), producing video-less samples



        // that ffmpeg still exited 0 on. Validate each sample and retry shifted once.



        // Third attempt uses output-side seek. It is materially slower (everything up to
        // the cut point is demuxed and discarded), so it stays a last resort - but it is
        // the only mode that survives a damaged container index, where both index-driven
        // attempts above copy to EOF instead of the requested window.
        var seekAttempts = [
            { seek: position, robustSeek: false },
            { seek: Math.max(0, position - keyframeSeekWindowSeconds), robustSeek: false },
            { seek: position, robustSeek: true },
        ];



        var extracted = false;



        for (var att = 0; att < seekAttempts.length && !extracted; att++) {



            var extractionArgs = buildSampleExtractionArgs(
                inputFile, outputPath, seekAttempts[att].seek, segmentDuration, videoMap,
                { robustSeek: seekAttempts[att].robustSeek });









            try {



                execFileSync(args.ffmpegPath, extractionArgs, {
                    stdio: 'pipe',
                    timeout: seekAttempts[att].robustSeek ? 300000 : 120000,
                    shell: false, windowsHide: true
                });



                if (isValidVideoSample(outputPath, args, segmentDuration)) {



                    extracted = true;



                } else {



                    args.jobLog('Sample ' + (i + 1) + ' attempt ' + (att + 1) + ' contained no usable video, ' +



                        (att + 1 < seekAttempts.length ? 'retrying at shifted position...' : 'giving up on this sample'));



                }



            } catch (err) {



                var stdoutTail = err.stdout ? err.stdout.toString().slice(-1200) : '';



                var stderrTail = err.stderr ? err.stderr.toString().slice(-1200) : '';



                var detail = (stderrTail || stdoutTail || err.message).trim();



                args.jobLog('Error extracting sample ' + (i + 1) + ' attempt ' + (att + 1) + ': ' + err.message);



                if (detail) {



                    args.jobLog('FFmpeg extract error tail: ' + detail.replace(/\s+/g, ' ').substring(0, 700));



                }



            }



        }



        if (extracted && !useCanonicalDenoise) {
            grainArtifact.registerTemporaryFile(args.variables, args, outputPath);
            samplePaths.push(outputPath);
            samplePositions.push(Math.round(position * 10) / 10);
            args.jobLog('Sample ' + (i + 1) + ' extracted for the original-reference path (' +
                referenceContract.id + '): ' + outputPath);
        } else if (extracted) {
            var denoisedOutputPath = cacheDir + '/' + fileName + '_sample_' + (i + 1) + '_canonical-denoised.mkv';
            try {
                var denoisedSpec = buildDenoisedSampleArgs({
                    sourcePath: inputFile,
                    outputPath: denoisedOutputPath,
                    targetSeconds: position,
                    durationSeconds: segmentDuration,
                    stream: primaryStream || {},
                    ffmpegPath: canonicalFfmpegPath,
                    nvenccPath: process.env.TDARR_NVENCC || canonicalDenoise.NVENCC_PATH,
                    coordinatorPath: process.env.TDARR_NVENCC_COORDINATOR ||
                        canonicalDenoise.COORDINATOR_PATH,
                });
                var denoisedRun = require('child_process').spawnSync(
                    denoisedSpec.executable, denoisedSpec.argv, {
                    encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 16 * 1024 * 1024,
                });
                if (denoisedRun.error) throw denoisedRun.error;
                if (denoisedRun.status !== 0) {
                    throw new Error('NVEncC KNN pipeline exit ' + denoisedRun.status + ': ' +
                        String(denoisedRun.stderr || denoisedRun.stdout || '').trim().slice(-1200));
                }
                applyDenoisedSampleMetadata(
                    args.variables.vmafMkvpropeditPath || '/usr/bin/mkvpropedit',
                    denoisedOutputPath,
                    primaryStream || {}
                );
                if (!isValidVideoSample(denoisedOutputPath, args, segmentDuration)) {
                    throw new Error('canonical denoised sample failed duration/decode validation');
                }
                validateDenoisedSampleMetadata(args.ffprobePath || 'tdarr-ffprobe', denoisedOutputPath, primaryStream || {});
                grainArtifact.registerTemporaryFile(args.variables, args, outputPath);
                grainArtifact.registerTemporaryFile(args.variables, args, denoisedOutputPath);
                grainArtifact.registerTemporaryFile(
                    args.variables, args, denoisedOutputPath + '.nvencc.log');
                samplePaths.push(outputPath);
                denoisedSamplePaths.push(denoisedOutputPath);
                samplePositions.push(Math.round(position * 10) / 10);
                args.jobLog('Sample ' + (i + 1) + ' extracted with canonical denoised reference: ' + denoisedOutputPath);
            } catch (denoisedError) {
                try { require('fs').unlinkSync(outputPath); } catch (_) {}
                try { require('fs').unlinkSync(denoisedOutputPath); } catch (_) {}
                try { require('fs').unlinkSync(denoisedOutputPath + '.nvencc.log'); } catch (_) {}
                args.jobLog('Canonical denoised sample ' + (i + 1) + ' failed closed: ' + denoisedError.message);
            }
        }



    }









    // Extract one reserved holdout segment that is NOT included in vmafSamples. This lets

    // selectBestParameters validate the finally chosen CQ against fresh content instead of

    // re-checking the same windows used to fit the CQ curve.

    try {

        var holdoutPosition = chooseHoldoutPosition(segmentPositions, videoDuration, segmentDuration);

        var holdoutPath = cacheDir + '/' + fileName + '_holdout.' + container;

        var holdoutStart = holdoutPosition.toFixed(2);

        var holdoutStream = getVideoStream(args.inputFileObj);

        var holdoutMap = holdoutStream ? '0:v:' + holdoutStream.typeIndex : '0:v:0';

        args.jobLog('Extracting reserved holdout sample: ' + holdoutStart + 's');

        // Same damaged-index fallback as the main sample loop above.
        var holdoutAttempts = [
            { seek: holdoutPosition, robustSeek: false },
            { seek: Math.max(0, holdoutPosition - keyframeSeekWindowSeconds), robustSeek: false },
            { seek: holdoutPosition, robustSeek: true },
        ];

        var holdoutExtracted = false;

        for (var ha = 0; ha < holdoutAttempts.length && !holdoutExtracted; ha++) {

            var holdoutExtractionArgs = buildSampleExtractionArgs(
                inputFile, holdoutPath, holdoutAttempts[ha].seek, segmentDuration, holdoutMap,
                { robustSeek: holdoutAttempts[ha].robustSeek });



            try {

                execFileSync(args.ffmpegPath, holdoutExtractionArgs, {
                    stdio: 'pipe',
                    timeout: holdoutAttempts[ha].robustSeek ? 300000 : 120000,
                    shell: false, windowsHide: true
                });

                if (isValidVideoSample(holdoutPath, args, segmentDuration)) {

                    holdoutExtracted = true;

                } else {

                    args.jobLog('Holdout attempt ' + (ha + 1) + ' contained no usable video, '

                        + (ha + 1 < holdoutAttempts.length ? 'retrying at shifted position...' : 'skipping holdout'));

                }

            } catch (herr) {

                var hstderr = herr.stderr ? herr.stderr.toString().slice(-1000) : '';

                var hstdout = herr.stdout ? herr.stdout.toString().slice(-1000) : '';

                var hdetail = (hstderr || hstdout || herr.message).trim();

                args.jobLog('Holdout extraction attempt ' + (ha + 1) + ' failed: ' + herr.message);

                if (hdetail) args.jobLog('Holdout FFmpeg error tail: ' + hdetail.replace(/\s+/g, ' ').substring(0, 500));

            }

        }

        if (holdoutExtracted && !useCanonicalDenoise) {
            grainArtifact.registerTemporaryFile(args.variables, args, holdoutPath);
            args.variables.vmafHoldoutSample = {
                path: holdoutPath,
                originalPath: holdoutPath,
                referenceContractId: referenceContract.id,
                startTime: holdoutPosition,
                duration: segmentDuration,
                segmentIndex: samplePaths.length + 1
            };
            args.jobLog('Reserved holdout extracted for the original-reference path (' +
                referenceContract.id + '): ' + holdoutPath);
        } else if (holdoutExtracted) {
            var denoisedHoldoutPath = cacheDir + '/' + fileName + '_holdout_canonical-denoised.mkv';
            var holdoutDenoiseSpec = buildDenoisedSampleArgs({
                sourcePath: inputFile,
                outputPath: denoisedHoldoutPath,
                targetSeconds: holdoutPosition,
                durationSeconds: segmentDuration,
                stream: holdoutStream || {},
                ffmpegPath: canonicalFfmpegPath,
                nvenccPath: process.env.TDARR_NVENCC || canonicalDenoise.NVENCC_PATH,
                coordinatorPath: process.env.TDARR_NVENCC_COORDINATOR ||
                    canonicalDenoise.COORDINATOR_PATH,
            });
            var holdoutDenoiseRun = require('child_process').spawnSync(
                holdoutDenoiseSpec.executable, holdoutDenoiseSpec.argv, {
                encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 16 * 1024 * 1024,
            });
            if (holdoutDenoiseRun.error) throw holdoutDenoiseRun.error;
            if (holdoutDenoiseRun.status !== 0) {
                throw new Error('holdout denoise FFmpeg exit ' + holdoutDenoiseRun.status + ': ' +
                    String(holdoutDenoiseRun.stderr || holdoutDenoiseRun.stdout || '').trim().slice(-1200));
            }
            applyDenoisedSampleMetadata(
                args.variables.vmafMkvpropeditPath || '/usr/bin/mkvpropedit',
                denoisedHoldoutPath,
                holdoutStream || {}
            );
            if (!isValidVideoSample(denoisedHoldoutPath, args, segmentDuration)) {
                throw new Error('canonical denoised holdout failed duration/decode validation');
            }
            validateDenoisedSampleMetadata(args.ffprobePath || 'tdarr-ffprobe', denoisedHoldoutPath, holdoutStream || {});
            grainArtifact.registerTemporaryFile(args.variables, args, holdoutPath);
            grainArtifact.registerTemporaryFile(args.variables, args, denoisedHoldoutPath);
            grainArtifact.registerTemporaryFile(
                args.variables, args, denoisedHoldoutPath + '.nvencc.log');
            args.variables.vmafHoldoutSample = {
                path: denoisedHoldoutPath,
                originalPath: holdoutPath,
                denoiseId: canonicalDenoise.DENOISE_ID,
                denoiseSettings: canonicalDenoise.KNN_SETTINGS,
                denoisePrerollSeconds: canonicalDenoise.PREROLL_SECONDS,
                referenceContractId: canonicalDenoise.REFERENCE_CONTRACT_ID,
                startTime: holdoutPosition,
                duration: segmentDuration,
                segmentIndex: samplePaths.length + 1
            };
            args.jobLog('Reserved holdout extracted with canonical denoised reference: ' + denoisedHoldoutPath);

        } else {

            args.variables.vmafHoldoutSample = null;

            args.jobLog('Reserved holdout sample unavailable - selection will proceed without holdout validation');

        }

    } catch (holdoutErr) {

        try { require('fs').unlinkSync(holdoutPath); } catch (_) {}
        try { if (denoisedHoldoutPath) require('fs').unlinkSync(denoisedHoldoutPath); } catch (_) {}

        args.variables.vmafHoldoutSample = null;

        args.jobLog('Reserved holdout extraction skipped: ' + (holdoutErr && holdoutErr.message ? holdoutErr.message : String(holdoutErr)));

    }



    // Report 100% completion



    if (args.updateWorker) {



        args.updateWorker({ percentage: 100 });



    }







    // CRITICAL FIX #4: Validate sample extraction success



    if (samplePaths.length === 0) {



        var errorMsg = 'Sample extraction failed: No samples were successfully extracted. ';



        errorMsg += 'This may indicate file corruption, insufficient disk space, or FFmpeg errors. ';



        errorMsg += 'File: ' + inputFile;



        args.jobLog('ERROR: ' + errorMsg);



        throw new Error(errorMsg);



    }







    if (samplePaths.length < numSegments) {



        args.jobLog('WARNING: Only ' + samplePaths.length + ' of ' + numSegments + ' samples were extracted successfully.');



    }







    if (useCanonicalDenoise && denoisedSamplePaths.length !== samplePaths.length) {
        throw new Error('canonical denoised VMAF sample count does not match original feature samples');
    }
    args.variables.vmafSamples = useCanonicalDenoise ? denoisedSamplePaths : samplePaths;
    args.variables.vmafOriginalSourceSamples = samplePaths;
    if (useCanonicalDenoise) {
        delete args.variables.vmafDenoiseFilter;
        args.variables.vmafDenoiseId = canonicalDenoise.DENOISE_ID;
        args.variables.vmafDenoiseSettings = canonicalDenoise.KNN_SETTINGS;
        args.variables.vmafDenoisePrerollSeconds = canonicalDenoise.PREROLL_SECONDS;
    } else {
        delete args.variables.vmafDenoiseFilter;
        delete args.variables.vmafDenoiseId;
        delete args.variables.vmafDenoiseSettings;
        delete args.variables.vmafDenoisePrerollSeconds;
    }



    args.variables.vmafSampleCount = samplePaths.length;

    args.variables.vmafSamplePositions = samplePositions;



    args.variables.vmafSegmentDuration = segmentDuration;



    args.variables.vmafOriginalFile = inputFile;

    // Seed a stable per-job id shared across the flow. exportVMAFResults and learnCQRange
    // both key their unified-DB writes by this, so the curve, decision and outcome all land
    // on one jobs row. Deterministic fallback (filePath + start time) keeps export/learn in
    // sync even if this seed is somehow skipped.
    try {
        var _vdbSeed = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
        var _seedStartedAt = new Date().toISOString();
        var _seedFilePath = (args.inputFileObj &&
            (args.inputFileObj._id || args.inputFileObj.file || args.inputFileObj.filePath)) ||
            (typeof inputFile === 'string' ? inputFile : '');
        seedVmafJobIdentity(args.variables,
            _vdbSeed.makeJobId(_seedFilePath, _seedStartedAt), _seedStartedAt);
    } catch (eSeed) { args.jobLog('vmafJobId seed skipped (non-fatal): ' + eSeed.message); }



    args.jobLog('Extracted ' + samplePaths.length + ' video samples.');


    // Source CAMBI is measured after the canonical-denoised reference has been
    // authenticated and immediately before candidate scoring. Deferring it here
    // prevents the original grainy source from becoming the baseline for an FGS
    // job whose actual pre-FGS reference is the denoised FFV1 signal.
    args.variables.vmafSourceCAMBI = null;
    args.variables.vmafSourceCAMBIP95 = null;
    args.variables.vmafSourceCAMBIMax = null;
    args.variables.vmafSourceCambiSignature = null;
    args.variables.vmafCambiAvailable = true;
    args.variables.vmafCambiPolicy = 'pre-fgs-standalone-cpu';
    args.variables.vmafCambiUnavailableReason = null;
    args.jobLog('Pre-FGS CAMBI source baseline deferred to authenticated reference scoring.');

    // ── Source content features (for predicting which constraint binds the CQ) ──
    // grain/noise energy, spatial (SI) + temporal (TI) complexity, dark-scene fraction, mean luma.
    // Cheap signalstats/sobel/hqdn3d passes over a few extracted clips (every 4th frame). Grain &
    // dark-fraction in particular drive the 1%-low ceiling that's been the binding constraint.
    var srcGrain = null, srcSI = null, srcTI = null, srcDark = null, srcLuma = null;
    try {
        if (samplePaths.length > 0) {
            var execFeat = require('child_process').execFileSync;
            var fsFeat = require('fs');
            var featIdx = [0];
            if (samplePaths.length >= 3) { featIdx.push(Math.floor(samplePaths.length / 2)); featIdx.push(samplePaths.length - 1); }
            else if (samplePaths.length === 2) { featIdx.push(1); }
            var sel = 'select=not(mod(n\\,8))';
            function _featVals(file, key) {
                try {
                    return fsFeat.readFileSync(file, 'utf8').split(/\r?\n/)
                        .filter(function (l) { return l.indexOf('signalstats.' + key + '=') >= 0; })
                        .map(function (l) { return parseFloat(l.split('=')[1]); })
                        .filter(function (x) { return isFinite(x); });
                } catch (e) { return []; }
            }
            var yavgAll = [], ydifAll = [], sobAll = [], grainAll = [];
            for (var _fi = 0; _fi < featIdx.length; _fi++) {
                var _sp = samplePaths[featIdx[_fi]];
                var _f1 = '/tmp/feat1_' + Date.now() + '_' + _fi + '.txt';
                var _f2 = '/tmp/feat2_' + Date.now() + '_' + _fi + '.txt';
                var _f3 = '/tmp/feat3_' + Date.now() + '_' + _fi + '.txt';
                // One decode, downscaled to 1280w for cheap CPU filters, split into 3 analysis
                // chains: [a] luma/temporal (signalstats), [b] spatial (sobel), [c] grain (denoise
                // difference). ~5s/clip at 4K vs ~25s for three separate passes.
                var _fc = '[0:v]' + sel + ',format=yuv420p,scale=1280:-2,split=3[a][b][c];'
                    + '[a]signalstats,metadata=print:file=' + _f1 + '[o1];'
                    + '[b]sobel,signalstats,metadata=print:file=' + _f2 + ',nullsink;'
                    + '[c]split[c1][c2];[c2]hqdn3d=4:4:6:6[cd];[c1][cd]blend=all_mode=difference,signalstats,metadata=print:file=' + _f3 + ',nullsink';
                try {
                    execFeat(args.ffmpegPath, buildFeatureExtractionArgs(_sp, _fc), {
                        stdio: 'pipe', timeout: 120000, shell: false, windowsHide: true
                    });
                } catch (e) {}
                yavgAll = yavgAll.concat(_featVals(_f1, 'YAVG'));
                ydifAll = ydifAll.concat(_featVals(_f1, 'YDIF'));
                sobAll = sobAll.concat(_featVals(_f2, 'YAVG'));
                grainAll = grainAll.concat(_featVals(_f3, 'YAVG'));
                try { fsFeat.unlinkSync(_f1); } catch (e) {} try { fsFeat.unlinkSync(_f2); } catch (e) {} try { fsFeat.unlinkSync(_f3); } catch (e) {}
            }
            function _featMean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
            srcLuma = _featMean(yavgAll);
            srcDark = yavgAll.length ? (yavgAll.filter(function (v) { return v < 60; }).length / yavgAll.length) : null;
            srcTI = _featMean(ydifAll);
            srcSI = _featMean(sobAll);
            srcGrain = _featMean(grainAll);
            args.jobLog('Source content features: grain=' + (srcGrain != null ? srcGrain.toFixed(2) : 'N/A')
                + ', SI=' + (srcSI != null ? srcSI.toFixed(1) : 'N/A') + ', TI=' + (srcTI != null ? srcTI.toFixed(2) : 'N/A')
                + ', dark=' + (srcDark != null ? srcDark.toFixed(3) : 'N/A') + ', luma=' + (srcLuma != null ? srcLuma.toFixed(1) : 'N/A')
                + ' (from ' + featIdx.length + ' clips, ' + yavgAll.length + ' frames)');
        }
    } catch (eFeat) {
        args.jobLog('Source content feature extraction failed (non-fatal): ' + eFeat.message);
    }
    args.variables.vmafSourceGrain = srcGrain;
    args.variables.vmafSourceSI = srcSI;
    args.variables.vmafSourceTI = srcTI;
    args.variables.vmafSourceDarkFrac = srcDark;
    args.variables.vmafSourceLumaAvg = srcLuma;



    return {



        outputFileObj: args.inputFileObj,



        outputNumber: 1,



        variables: args.variables,



    };



};



exports.plugin = plugin;
exports._test = {
    buildSampleExtractionArgs: buildSampleExtractionArgs,
    buildFeatureExtractionArgs: buildFeatureExtractionArgs,
    knownColorValue: knownColorValue,
    matroskaColorValue: matroskaColorValue,
    buildMkvColorMetadataArgs: buildMkvColorMetadataArgs,
    applyDenoisedSampleMetadata: applyDenoisedSampleMetadata,
    resolveExecutablePath: resolveExecutablePath,
    buildDenoisedSampleArgs: buildDenoisedSampleArgs,
    validateDenoisedSampleMetadata: validateDenoisedSampleMetadata,
    referenceContractForVariables: referenceContractForVariables,
    resetVmafJobIdentity: resetVmafJobIdentity,
    seedVmafJobIdentity: seedVmafJobIdentity,
    getVideoStream: getVideoStream,
};
