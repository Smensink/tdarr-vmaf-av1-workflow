"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var childProcess = require('child_process');
var grainArtifact = require('../../_lib/grainAnalysisArtifact.js');
var gpuPipelineLock = require('../../_lib/gpuPipelineLock.js');
var deliveryPolicy = require('../../_lib/deliveryPolicy.js');

var CALIBRATION_REPORT_SCHEMA = 3;
var ENERGY_VALIDATION_REPORT_SCHEMA = 2;
var LUMA_CURVE_MODEL = 'luma-log-affine-v1';
var ROBUST_GLOBAL_SCALAR_MODEL = 'robust-global-log-median-v1';
var FIT_TABLE_IDENTITY_MODEL = 'fit-table-identity-gain1-v1';
var POSTENCODE_CORRECTION_POLICY =
    'bounded-luma-log-affine-then-robust-global-log-median-then-fit-table-identity-v1';
var LUMA_CURVE_TRANSFORM_ID = 'multiply-av1-scaling-curves-v1';
var GPU_PIPELINE_LOCK_DIR = '/temp/tdarr-vmaf-gpu-pipeline.lock';

var VOLATILE_TAGS = {
    encoder: true,
    duration: true,
    number_of_frames: true,
    number_of_bytes: true,
};

var MKV_VIDEO_SEMANTIC_FLAG_OPTIONS = [
    { property: 'default_track', option: '--default-track-flag', defaultValue: true },
    { property: 'forced_track', option: '--forced-display-flag', defaultValue: false },
    { property: 'enabled_track', option: '--track-enabled-flag', defaultValue: true },
    { property: 'hearing_impaired', option: '--hearing-impaired-flag', defaultValue: false },
    { property: 'visual_impaired', option: '--visual-impaired-flag', defaultValue: false },
    { property: 'text_descriptions', option: '--text-descriptions-flag', defaultValue: false },
    { property: 'original', option: '--original-flag', defaultValue: false },
    { property: 'commentary', option: '--commentary-flag', defaultValue: false },
];

var details = function () { return ({
    name: 'Synthesize Film Grain',
    description: 'Applies the authenticated direct grav1synth table exactly once, performs one final ancillary mux, and requires a full-title AV1 decode before replacement.',
    style: { borderColor: 'gold' },
    tags: 'video,av1,grain,vmaf,validation,canary',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faFilm',
    inputs: [
        {
            label: 'Rollout Mode',
            name: 'mode',
            type: 'string',
            defaultValue: 'disabled',
            inputUI: { type: 'dropdown', options: ['disabled', 'canary', 'active'] },
            tooltip: 'disabled and ineligible jobs bypass grain and continue with the normal validated transcode. canary preserves a validated review copy but keeps the library original. active may route a validated grain output to replacement.',
        },
        {
            label: 'Mounted Source Scope Regex',
            name: 'sourcePathRegex',
            type: 'string',
            defaultValue: '',
            inputUI: { type: 'text' },
            tooltip: 'Required in canary and active modes. The production value matches every file beneath /media; a non-match means the file is outside the mounted-media scope.',
        },
        {
            label: 'Eligible Color Profiles',
            name: 'eligibleProfiles',
            type: 'string',
            defaultValue: 'sdrAndPq',
            inputUI: { type: 'dropdown', options: ['sdrAndPq', 'sdrOnly', 'pqOnly'] },
            tooltip: 'Known BT.709 SDR and/or static HDR10 PQ/BT.2020. HLG and ambiguous signalling are rejected; dynamic HDR is accepted only after an exactly attested upstream conversion to a clean static-HDR10 base.',
        },
        {
            label: 'Source Path Regex Flags',
            name: 'sourcePathRegexFlags',
            type: 'string',
            defaultValue: 'i',
            inputUI: { type: 'text' },
            tooltip: 'JavaScript regex flags for the mounted-source scope. Default i makes Windows/Linux path matching case-insensitive.',
        },
        {
            label: 'Pipeline Path',
            name: 'pipelinePath',
            type: 'string',
            defaultValue: '/opt/grain-pipeline/current/grain_pipeline_v5_direct.py',
            inputUI: { type: 'text' },
            tooltip: 'Absolute path to the validated direct-fit pipeline. The prepared fit must match this exact installed script.',
        },
        {
            label: 'grav1synth Path',
            name: 'grav1synthPath',
            type: 'string',
            defaultValue: '/usr/local/bin/grav1synth',
            inputUI: { type: 'text' },
            tooltip: 'Absolute path to the production grav1synth executable.',
        },
        {
            label: 'Scratch Root',
            name: 'workRoot',
            type: 'string',
            defaultValue: 'grain-synthesis',
            inputUI: { type: 'text' },
            tooltip: 'Relative child of args.workDir. Escaping/absolute paths fail closed so normal Flow cleanup owns every artifact.',
        },
        {
            label: 'Canary Review Directory',
            name: 'reviewDir',
            type: 'string',
            defaultValue: '/grain-pilot-review',
            inputUI: { type: 'text' },
            tooltip: 'Durable mounted directory for validated canary evidence and any explicitly enabled production review pair.',
        },
        {
            label: 'Preserve Production Review Pair',
            name: 'preserveProductionReview',
            type: 'boolean',
            defaultValue: 'false',
            inputUI: { type: 'dropdown', options: ['false', 'true'] },
            tooltip: 'Explicit opt-in. Copies one full source and grain output into a two-slot private review area. Disabled by default because the copies are large and contain production media.',
        },
        {
            label: 'Maximum Output Size Ratio %',
            name: 'maxOutputSizeRatioPct',
            type: 'number',
            defaultValue: '101',
            inputUI: { type: 'text' },
            tooltip: 'Warn if the fully remuxed grain output exceeds this percentage of the completed AV1 base. Structural and integrity validation still determine acceptance.',
        },
        {
            label: 'Duration Tolerance Seconds',
            name: 'durationToleranceSeconds',
            type: 'number',
            defaultValue: '0.25',
            inputUI: { type: 'text' },
            tooltip: 'Maximum source/encode/output duration difference, with an automatic two-frame minimum.',
        },
        {
            label: 'Apply/Validation Timeout Minutes',
            name: 'validationTimeoutMinutes',
            type: 'number',
            defaultValue: '240',
            inputUI: { type: 'text' },
            tooltip: 'Per-command hard timeout for header application, probing, semantic inspection, final ancillary mux, and mandatory full-title decode validation.',
        },
    ],
    outputs: [
        { number: 1, tooltip: 'ACTIVE: structurally validated grain output; route directly toward replacement' },
        { number: 2, tooltip: 'CANARY: validated review artifact saved; cleanup and keep the library original' },
        { number: 3, tooltip: 'BYPASS: grain disabled/ineligible/analysis unavailable; continue with the already-validated normal AV1 working output' },
        { number: 4, tooltip: 'FALLBACK RE-ENCODE: cleanup and rerun AV1 from the untouched original with temporal filtering disabled' },
    ],
}); };
exports.details = details;

function boolValue(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    return value === true || String(value).toLowerCase() === 'true';
}

function finiteNumber(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function lower(value) {
    return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

function getTag(tags, name) {
    if (!tags) return '';
    var target = lower(name);
    var keys = Object.keys(tags);
    for (var i = 0; i < keys.length; i++) {
        if (lower(keys[i]) === target) return String(tags[keys[i]]);
    }
    return '';
}

function getOriginalPath(args) {
    return String(
        (args.originalLibraryFile && (args.originalLibraryFile._id || args.originalLibraryFile.file)) ||
        (args.variables && args.variables.vmafOriginalFile) ||
        ''
    );
}

function getWorkingPath(args) {
    return String(args.inputFileObj && (args.inputFileObj._id || args.inputFileObj.file) || '');
}

function keepOriginalObject(args) {
    return args.originalLibraryFile || args.inputFileObj;
}

function safeSlug(value) {
    var slug = String(value || 'media').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) slug = 'media';
    return slug.slice(0, 80);
}

function stableId(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function appendBounded(existing, chunk, limit) {
    var combined = existing + chunk;
    return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

function runProcess(executable, argv, options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
        var stdout = '';
        var stderr = '';
        var limit = Math.max(64 * 1024, Number(options.maxOutputBytes) || 16 * 1024 * 1024);
        var timedOut = false;
        var settled = false;
        var child;
        var detachedGroup = process.platform !== 'win32';
        try {
            child = childProcess.spawn(executable, argv, {
                shell: false,
                windowsHide: true,
                detached: detachedGroup,
                stdio: ['ignore', 'pipe', 'pipe'],
                cwd: options.cwd || undefined,
                env: process.env,
            });
        } catch (err) {
            reject(err);
            return;
        }
        var timer = null;
        var hardKillTimer = null;
        function signalTree(signal) {
            try {
                if (detachedGroup && child.pid > 0) process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch (err) {
                if (!err || err.code !== 'ESRCH') {
                    try { child.kill(signal); } catch (_) {}
                }
            }
        }
        if (options.timeoutMs > 0) {
            timer = setTimeout(function () {
                timedOut = true;
                signalTree('SIGTERM');
                hardKillTimer = setTimeout(function () { signalTree('SIGKILL'); }, 3000);
            }, options.timeoutMs);
        }
        child.stdout.on('data', function (chunk) {
            stdout = appendBounded(stdout, chunk.toString('utf8'), limit);
        });
        child.stderr.on('data', function (chunk) {
            stderr = appendBounded(stderr, chunk.toString('utf8'), limit);
        });
        child.on('error', function (err) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (hardKillTimer) clearTimeout(hardKillTimer);
            if (timedOut) signalTree('SIGKILL');
            reject(err);
        });
        child.on('close', function (code, signal) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (hardKillTimer) clearTimeout(hardKillTimer);
            if (timedOut) signalTree('SIGKILL');
            resolve({ code: code, signal: signal, stdout: stdout, stderr: stderr, timedOut: timedOut });
        });
    });
}

function commandTail(result) {
    var text = String((result && result.stderr) || (result && result.stdout) || '').trim();
    if (text.length > 5000) text = text.slice(text.length - 5000);
    return text;
}

async function runChecked(executable, argv, options) {
    var result = await runProcess(executable, argv, options);
    if (result.timedOut) {
        throw new Error('Command timed out: ' + executable + ' ' + argv.slice(0, 3).join(' '));
    }
    if (result.code !== 0) {
        throw new Error('Command failed with exit code ' + result.code + ': ' + executable +
            (commandTail(result) ? '\n' + commandTail(result) : ''));
    }
    return result;
}

function assertRegularFile(filePath, description) {
    var stat;
    try { stat = fs.statSync(filePath); } catch (err) {
        throw new Error(description + ' not found at ' + filePath + ': ' + err.message);
    }
    if (!stat.isFile()) throw new Error(description + ' is not a regular file: ' + filePath);
    fs.accessSync(filePath, fs.constants.R_OK);
    return stat;
}

function assertExecutableFile(filePath, description) {
    assertRegularFile(filePath, description);
    fs.accessSync(filePath, fs.constants.X_OK);
}

function canonicalAv1ColorEvidence(field, value) {
    var normalized = lower(value);
    if (!normalized || normalized === 'unknown' || normalized === 'unspecified' ||
            normalized === 'reserved' || normalized === 'n/a' || normalized === 'none') {
        return '';
    }
    var aliases = {
        color_range: { mpeg: 'tv', limited: 'tv', jpeg: 'pc', full: 'pc' },
        color_space: { bt2020_ncl: 'bt2020nc', 'bt2020-ncl': 'bt2020nc' },
        color_transfer: { pq: 'smpte2084', hlg: 'arib-std-b67' },
        color_primaries: {},
    };
    return aliases[field] && aliases[field][normalized] || normalized;
}

function reconcileAv1SequenceColorEvidence(stream, frames, description) {
    if (!stream || lower(stream.codec_name) !== 'av1') return stream;
    if (!Array.isArray(frames) || !frames.length) {
        throw new Error(description + ' has no decoded AV1 frame color evidence');
    }
    var fields = [
        ['color_range', 'COLOR_RANGE'],
        ['color_space', 'COLOR_SPACE'],
        ['color_transfer', 'COLOR_TRANSFER'],
        ['color_primaries', 'COLOR_PRIMARIES'],
    ];
    fields.forEach(function (spec) {
        var field = spec[0];
        var tag = spec[1];
        var evidence = [];
        function add(value, source) {
            var canonical = canonicalAv1ColorEvidence(field, value);
            if (canonical) evidence.push({ value: canonical, source: source });
        }
        add(stream[field], 'stream property');
        add(getTag(stream.tags, tag), 'stream tag');
        frames.forEach(function (frame, index) {
            add(frame && frame[field], 'decoded frame ' + index);
        });
        var distinct = Array.from(new Set(evidence.map(function (item) { return item.value; })));
        if (distinct.length > 1) {
            throw new Error(description + ' has conflicting AV1 ' + field +
                ' evidence: ' + evidence.map(function (item) {
                    return item.source + '=' + item.value;
                }).join(', '));
        }
        if (distinct.length === 1) stream[field] = distinct[0];
    });
    return stream;
}

async function probeMedia(ffprobePath, filePath, timeoutMs) {
    // AV1 stream-level summaries can omit sequence-header color primaries/TRC
    // even with a deep analyzeduration/probesize. Read the complete inventory,
    // then independently decode the first second below and reconcile every
    // sequence-level color scalar fail-closed.
    var result = await runChecked(ffprobePath, [
        '-v', 'error', '-analyzeduration', '100M', '-probesize', '100M',
        '-show_streams', '-show_format', '-show_chapters',
        '-show_data_hash', 'sha256', '-of', 'json', filePath,
    ], { timeoutMs: timeoutMs, maxOutputBytes: 32 * 1024 * 1024 });
    var parsed;
    try { parsed = JSON.parse(result.stdout); } catch (err) {
        throw new Error('ffprobe returned invalid JSON for ' + filePath + ': ' + err.message);
    }
    if (!parsed || !Array.isArray(parsed.streams) || !parsed.format) {
        throw new Error('ffprobe returned incomplete media data for ' + filePath);
    }
    var primary = primaryVideo(parsed);
    if (primary && lower(primary.codec_name) === 'av1') {
        var streamIndex = Number(primary.index);
        if (!Number.isInteger(streamIndex) || streamIndex < 0) {
            throw new Error('ffprobe primary AV1 stream has no exact non-negative index for ' + filePath);
        }
        var frameTimeoutMs = Math.min(60000, Math.max(10000, Number(timeoutMs) || 60000));
        var frameResult = await runChecked(ffprobePath, [
            '-v', 'error', '-read_intervals', '0%+1',
            '-select_streams', String(streamIndex), '-show_frames',
            '-show_entries',
            'frame=stream_index,color_range,color_space,color_transfer,color_primaries',
            '-of', 'json', filePath,
        ], { timeoutMs: frameTimeoutMs, maxOutputBytes: 4 * 1024 * 1024 });
        var frameProbe;
        try { frameProbe = JSON.parse(frameResult.stdout); } catch (frameErr) {
            throw new Error('ffprobe returned invalid AV1 frame JSON for ' + filePath + ': ' + frameErr.message);
        }
        var primaryFrames = frameProbe && Array.isArray(frameProbe.frames)
            ? frameProbe.frames.filter(function (frame) {
                return Number(frame && frame.stream_index) === streamIndex;
            }) : [];
        reconcileAv1SequenceColorEvidence(primary, primaryFrames, filePath);
    }
    return parsed;
}

function primaryVideo(probe) {
    var streams = probe && probe.streams;
    if (!Array.isArray(streams)) return null;
    for (var i = 0; i < streams.length; i++) {
        var stream = streams[i] || {};
        if (stream.codec_type === 'video' && !(stream.disposition && Number(stream.disposition.attached_pic) === 1)) {
            return stream;
        }
    }
    return null;
}

function dynamicHdrMarkers(stream) {
    return grainArtifact.dynamicHdrMarkers(stream);
}

function hasStaticHdrSideData(stream) {
    var sideData = lower(JSON.stringify(stream && stream.side_data_list || []));
    return /mastering display|content light|ambient viewing|hdr vivid/.test(sideData);
}

function colorProfile(probe) {
    var stream = primaryVideo(probe);
    if (!stream) return { supported: false, reason: 'no primary video stream' };
    var dynamic = dynamicHdrMarkers(stream);
    if (dynamic.dolbyVision) return { supported: false, reason: 'Dolby Vision metadata cannot be preserved safely', dynamic: dynamic, stream: stream };
    if (dynamic.hdr10Plus) return { supported: false, reason: 'HDR10+ dynamic metadata cannot be preserved safely', dynamic: dynamic, stream: stream };

    var transfer = lower(stream.color_transfer || getTag(stream.tags, 'COLOR_TRANSFER'));
    var primaries = lower(stream.color_primaries || getTag(stream.tags, 'COLOR_PRIMARIES'));
    var matrix = lower(stream.color_space || getTag(stream.tags, 'COLOR_SPACE'));
    var pixFmt = lower(stream.pix_fmt);
    if (transfer === 'arib-std-b67' || transfer === 'hlg') {
        return { supported: false, reason: 'HLG transfer is not calibrated by this pipeline', transfer: transfer, stream: stream };
    }
    if (transfer === 'smpte2084' || transfer === 'pq') {
        if (primaries !== 'bt2020' || (matrix !== 'bt2020nc' && matrix !== 'bt2020c' && matrix !== 'bt2020_ncl')) {
            return { supported: false, reason: 'PQ video has ambiguous/non-BT.2020 color signalling', transfer: transfer, primaries: primaries, matrix: matrix, stream: stream };
        }
        if (!/(10|12|p010|p012)/.test(pixFmt)) {
            return { supported: false, reason: 'PQ video is not a recognized 10/12-bit format', pixFmt: pixFmt, stream: stream };
        }
        return { supported: true, id: 'pq', label: 'HDR10 PQ/BT.2020', transfer: transfer, primaries: primaries, matrix: matrix, stream: stream };
    }
    var sdrTransfers = {
        bt709: true,
        'iec61966-2-1': true,
        gamma22: true,
        gamma28: true,
        smpte170m: true,
        smpte240m: true,
        bt470bg: true,
        bt470m: true,
        'bt2020-10': true,
        'bt2020-12': true,
    };
    if (sdrTransfers[transfer]) {
        if (hasStaticHdrSideData(stream)) {
            return { supported: false, reason: 'known SDR transfer has contradictory HDR side data', transfer: transfer, stream: stream };
        }
        return { supported: true, id: 'sdr', label: 'SDR (' + transfer + ')', transfer: transfer, primaries: primaries, matrix: matrix, stream: stream };
    }
    return { supported: false, reason: 'unsupported or ambiguous transfer characteristic: ' + (transfer || '<missing>'), transfer: transfer, stream: stream };
}

function normalizeUntaggedSdrProfile(sourceProbe, baseProfile) {
    if (!baseProfile || !baseProfile.supported || baseProfile.id !== 'sdr') return null;
    var stream = primaryVideo(sourceProbe);
    if (!stream) return null;
    var dynamic = dynamicHdrMarkers(stream);
    if (dynamic.dolbyVision || dynamic.hdr10Plus) return null;
    var transfer = lower(stream.color_transfer || getTag(stream.tags, 'COLOR_TRANSFER'));
    var primaries = lower(stream.color_primaries || getTag(stream.tags, 'COLOR_PRIMARIES'));
    var matrix = lower(stream.color_space || getTag(stream.tags, 'COLOR_SPACE'));
    var unknown = { '': true, unknown: true, unspecified: true, reserved: true };
    if (!unknown[transfer]) return null;
    if (!unknown[primaries] && primaries !== 'bt709') return null;
    if (!unknown[matrix] && matrix !== 'bt709') return null;
    var sideData = lower(JSON.stringify(stream.side_data_list || []));
    if (/mastering display|content light|hdr10|smpte.?2094|dolby vision|dovi/.test(sideData)) return null;
    return {
        supported: true,
        id: 'sdr',
        label: 'SDR BT.709 (source transfer inferred from normalized base)',
        transfer: transfer,
        primaries: primaries,
        matrix: matrix,
        inferred: true,
        stream: stream,
    };
}

function dolbyVisionBaseLayerInfo(stream) {
    var sideData = stream && stream.side_data_list;
    if (!Array.isArray(sideData)) return null;
    for (var i = 0; i < sideData.length; i++) {
        var item = sideData[i] || {};
        if (!/dolby vision|dovi/i.test(String(item.side_data_type || ''))) continue;
        return {
            profile: Number.isFinite(Number(item.dv_profile)) ? Number(item.dv_profile) : null,
            compatibility_id: Number.isFinite(Number(item.dv_bl_signal_compatibility_id))
                ? Number(item.dv_bl_signal_compatibility_id) : null,
            base_layer_present: Number(item.bl_present_flag) === 1,
            enhancement_layer_present: Number(item.el_present_flag) === 1,
            rpu_present: Number(item.rpu_present_flag) === 1,
        };
    }
    return null;
}

function isPqBt2020HighBitVideo(stream) {
    if (!stream) return false;
    var transfer = lower(stream.color_transfer || getTag(stream.tags, 'COLOR_TRANSFER'));
    var primaries = lower(stream.color_primaries || getTag(stream.tags, 'COLOR_PRIMARIES'));
    var matrix = lower(stream.color_space || getTag(stream.tags, 'COLOR_SPACE'));
    var pixFmt = lower(stream.pix_fmt);
    return (transfer === 'smpte2084' || transfer === 'pq') &&
        primaries === 'bt2020' &&
        (matrix === 'bt2020nc' || matrix === 'bt2020c' || matrix === 'bt2020_ncl') &&
        /(?:10|12)(?:le|be)?$/.test(pixFmt);
}

function exactDynamicHdrProvenance(variables, sourceType) {
    variables = variables || {};
    var authorization = grainArtifact.recognizedDynamicHdrAuthorization(variables);
    if (!authorization || (sourceType && sourceType !== authorization.sourceType) ||
        variables.vmafTranscodeSucceeded !== true ||
        variables.vmafTranscodeStatus !== 'success' ||
        variables.vmafHdrStaticMetadataVerified !== true) {
        return null;
    }
    return {
        source_type: authorization.sourceType,
        conversion: authorization.conversion,
        disposition: variables.vmafProcessingDisposition,
        disposition_reason: authorization.reason,
        transcode_status: variables.vmafTranscodeStatus,
        static_metadata_verified: true,
    };
}

function normalizeAuthorizedDynamicHdrProfile(sourceProbe, workingProfile, workingProbe, variables) {
    var sourceStream = primaryVideo(sourceProbe);
    var workingStream = primaryVideo(workingProbe);
    if (!sourceStream || !workingStream || !isPqBt2020HighBitVideo(sourceStream)) return null;
    var sourceDynamic = dynamicHdrMarkers(sourceStream);
    var workingDynamic = dynamicHdrMarkers(workingStream);
    if (workingDynamic.dolbyVision || workingDynamic.hdr10Plus ||
        grainArtifact.hasResidualDynamicHdrMetadata(workingStream)) return null;
    if (!workingProfile || !workingProfile.supported || workingProfile.id !== 'pq' ||
        !isPqBt2020HighBitVideo(workingStream)) return null;

    var provenance = exactDynamicHdrProvenance(variables);
    if (!provenance) return null;
    var sourceType = provenance.source_type;
    var provisional = grainArtifact.provisionalDynamicHdrEvidence(sourceStream, variables);
    if (!provisional || provisional.sourceType !== sourceType ||
        provisional.conversion !== provenance.conversion) return null;
    if (sourceDynamic.hdr10Plus && variables.isHDR10Plus !== true) return null;
    var dolbyInfo = null;
    if (sourceType === 'dolby_vision') {
        if (!sourceDynamic.dolbyVision) return null;
        dolbyInfo = dolbyVisionBaseLayerInfo(sourceStream);
        if (!dolbyInfo || !dolbyInfo.base_layer_present ||
            (dolbyInfo.compatibility_id !== 1 && dolbyInfo.compatibility_id !== 6)) return null;
    } else if (sourceDynamic.dolbyVision) {
        // Check HDR prioritizes Dolby Vision. HDR10+ fallback provenance is invalid
        // when the source probe still contains DOVI metadata.
        return null;
    }
    var evidence = {
        schema: 1,
        source_type: sourceType,
        conversion: provenance.conversion,
        disposition: provenance.disposition,
        disposition_reason: provenance.disposition_reason,
        transcode_status: provenance.transcode_status,
        static_metadata_verified: provenance.static_metadata_verified,
        source_pq_bt2020_high_bit: true,
        authorized_source_kinds: provisional.sourceKinds.slice(),
        detected_ffprobe_kinds: provisional.ffprobeKinds.slice(),
        working_static_pq_bt2020_high_bit: true,
        working_dynamic_metadata_absent: true,
        dolby_vision: dolbyInfo,
        manifest_evidence_validated: false,
    };
    return {
        supported: true,
        id: 'pq',
        label: 'HDR10 PQ/BT.2020 (authorized ' +
            (sourceType === 'dolby_vision' ? 'Dolby Vision' : 'HDR10+') + ' static fallback)',
        transfer: workingProfile.transfer,
        primaries: workingProfile.primaries,
        matrix: workingProfile.matrix,
        normalized_dynamic_hdr: true,
        dynamic_hdr_normalization: evidence,
        stream: sourceStream,
    };
}

function profileAllowed(profileId, setting) {
    if (setting === 'sdrOnly') return profileId === 'sdr';
    if (setting === 'pqOnly') return profileId === 'pq';
    return profileId === 'sdr' || profileId === 'pq';
}

function isMatroska(probe, filePath) {
    var formatName = lower(probe && probe.format && probe.format.format_name);
    var formats = formatName.split(',').map(function (value) { return value.trim(); }).filter(Boolean);
    var probeIsKnown = formats.length > 0 && !formats.every(function (value) {
        return value === 'unknown' || value === 'unspecified' || value === 'n/a';
    });
    if (probeIsKnown) return formats.indexOf('matroska') !== -1;
    // Only fall back to the suffix when probing supplied no trustworthy format.
    // A non-empty probe result wins over a misleading library filename.
    return path.extname(String(filePath || '')).toLowerCase() === '.mkv';
}

function ineligibleError(reason) {
    var error = new Error(reason);
    error.grainIneligible = true;
    return error;
}

function durationSeconds(probe) {
    var formatDuration = finiteNumber(probe && probe.format && probe.format.duration, NaN);
    if (Number.isFinite(formatDuration)) return formatDuration;
    var video = primaryVideo(probe);
    return finiteNumber(video && video.duration, NaN);
}

function frameRateValue(stream) {
    var value = String(stream && (stream.avg_frame_rate || stream.r_frame_rate) || '');
    var parts = value.split('/');
    if (parts.length === 2) {
        var numerator = Number(parts[0]);
        var denominator = Number(parts[1]);
        if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) return numerator / denominator;
    }
    var direct = Number(value);
    return Number.isFinite(direct) && direct > 0 ? direct : NaN;
}

function durationTolerance(probe, configured) {
    var fps = frameRateValue(primaryVideo(probe));
    var twoFrames = Number.isFinite(fps) && fps > 0 ? 2 / fps : 0;
    return Math.max(0.01, finiteNumber(configured, 0.25), twoFrames);
}

function assertDurationParity(leftProbe, rightProbe, tolerance, description) {
    var left = durationSeconds(leftProbe);
    var right = durationSeconds(rightProbe);
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
        throw new Error(description + ': duration is missing or invalid');
    }
    var delta = Math.abs(left - right);
    if (delta > tolerance) {
        throw new Error(description + ': duration delta ' + delta.toFixed(6) + 's exceeds ' + tolerance.toFixed(6) + 's');
    }
    return { left: left, right: right, delta: delta, tolerance: tolerance };
}

function isVolatileMatroskaTag(key) {
    var normalized = lower(key);
    if (VOLATILE_TAGS[normalized]) return true;
    var languageSuffix = '(?:-[a-z]{3})?';
    if (new RegExp('^(?:bps|duration|number_of_frames|number_of_bytes)' +
        languageSuffix + '$').test(normalized)) return true;
    return new RegExp('^_statistics_[a-z0-9_]+' + languageSuffix + '$')
        .test(normalized);
}

function stableTagMap(tags) {
    var result = {};
    Object.keys(tags || {}).forEach(function (key) {
        var normalized = lower(key);
        if (isVolatileMatroskaTag(normalized)) return;
        result[normalized] = String(tags[key]);
    });
    return result;
}

function assertTagsPreserved(expectedTags, actualTags, description) {
    var expected = stableTagMap(expectedTags);
    var actual = stableTagMap(actualTags);
    Object.keys(expected).forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(actual, key)) {
            throw new Error(description + ': metadata tag was dropped: ' + key);
        }
        if (actual[key] !== expected[key]) {
            throw new Error(description + ': metadata tag changed: ' + key);
        }
    });
}

function normalizedVideoTagName(name) {
    return lower(name).trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function isTechnicalPrimaryVideoTag(name) {
    var normalized = normalizedVideoTagName(name);
    if (!normalized) return true;
    return /^(?:color|colour)(?:_|$)/.test(normalized) ||
        /^(?:hdr|hdr10|dynamic_hdr|dovi|dolby_vision|smpte_?st?_?2094)(?:_|$)/.test(normalized) ||
        /^(?:mastering|mastering_display|content_light|ambient_viewing|max_cll|max_fall|max_content_light|max_frame_light|min_luminance|max_luminance|chromaticity|white_color)(?:_|$)/.test(normalized) ||
        /^(?:codec|pixel|coded|display|sample_aspect|display_aspect|frame_rate|framerate|fps|field_order|chroma)(?:_|$)/.test(normalized) ||
        /^(?:matrix|matrix_coefficients|transfer|transfer_characteristics|primaries|range|video_full_range|bit_depth|bits_per_sample|bits_per_raw_sample|profile|level|default_duration)(?:_|$)/.test(normalized) ||
        /^(?:rotate|rotation|stereo|alpha|projection|spherical|crop|aspect|sar|dar|scan|interlace)(?:_|$)/.test(normalized) ||
        /^(?:encoder|encoded_by|encoding|handler_name|vendor_id)(?:_|$)/.test(normalized);
}

function stablePrimaryVideoUserTagMap(tags) {
    var stable = stableTagMap(tags);
    var result = {};
    Object.keys(stable).forEach(function (name) {
        if (!isTechnicalPrimaryVideoTag(name)) result[name] = stable[name];
    });
    return canonicalObject(result);
}

function assertPrimaryVideoUserTagsPreserved(expectedTags, actualTags, description) {
    var expected = stablePrimaryVideoUserTagMap(expectedTags);
    var actual = stablePrimaryVideoUserTagMap(actualTags);
    Object.keys(expected).forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(actual, key)) {
            throw new Error(description + ': user metadata tag was dropped: ' + key);
        }
        if (actual[key] !== expected[key]) {
            throw new Error(description + ': user metadata tag changed: ' + key);
        }
    });
}

function assertXmlText(value, description) {
    var text = String(value === undefined || value === null ? '' : value);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text)) {
        throw new Error(description + ' contains characters that XML 1.0 cannot represent');
    }
    return text;
}

function stableMkvPrimaryVideoCustomTags(track) {
    var properties = track && track.properties || {};
    var result = {};
    Object.keys(properties).sort().forEach(function (propertyName) {
        if (propertyName.indexOf('tag_') !== 0) return;
        var tagName = propertyName.slice(4);
        var normalized = lower(tagName);
        // Track language and name are copied through typed Matroska fields. Treating
        // similarly named SimpleTags as authoritative would make FFmpeg's flattened
        // metadata ambiguous, so they are outside the safe custom-tag subset.
        if (!normalized || normalized === 'language' || normalized === 'title' ||
                isVolatileMatroskaTag(normalized) || isTechnicalPrimaryVideoTag(normalized)) return;
        assertXmlText(tagName, 'source primary-video custom tag name');
        if (properties[propertyName] !== null && typeof properties[propertyName] === 'object') {
            throw new Error('source primary-video custom tag ' + tagName + ' is not scalar');
        }
        var value = assertXmlText(properties[propertyName],
            'source primary-video custom tag ' + tagName);
        if (Object.prototype.hasOwnProperty.call(result, normalized) && result[normalized] !== value) {
            throw new Error('source primary-video custom tags collide case-insensitively at ' + normalized);
        }
        result[normalized] = value;
    });
    if (Object.keys(result).length > 128) {
        throw new Error('source primary-video has more than 128 safe custom tags');
    }
    var encodedBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (encodedBytes > 1024 * 1024) {
        throw new Error('source primary-video safe custom tags exceed 1 MiB');
    }
    return canonicalObject(result);
}

function xmlEscape(value) {
    return assertXmlText(value, 'Matroska tag XML value')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildMkvmergeTrackTagsXml(customTags) {
    var names = Object.keys(customTags || {}).sort();
    if (!names.length) throw new Error('refusing to build an empty primary-video custom-tag document');
    var lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<Tags>', '  <Tag>'];
    names.forEach(function (name) {
        lines.push('    <Simple>');
        lines.push('      <Name>' + xmlEscape(name) + '</Name>');
        lines.push('      <String>' + xmlEscape(customTags[name]) + '</String>');
        lines.push('    </Simple>');
    });
    lines.push('  </Tag>', '</Tags>', '');
    return lines.join('\n');
}

function mkvSemanticBoolean(properties, field, defaultValue, description) {
    if (!Object.prototype.hasOwnProperty.call(properties || {}, field)) return defaultValue;
    if (typeof properties[field] !== 'boolean') {
        throw new Error(description + ' ' + field + ' is not a JSON boolean');
    }
    return properties[field];
}

function effectiveMkvPrimaryVideoSemantics(track, description) {
    var properties = track && track.properties || {};
    var language = String(properties.language === undefined || properties.language === null ||
        String(properties.language).trim() === '' ? 'und' : properties.language);
    var languageIetf = Object.prototype.hasOwnProperty.call(properties, 'language_ietf') &&
        String(properties.language_ietf).trim() !== '' ? String(properties.language_ietf) : null;
    var semantics = {
        language: language,
        language_ietf: languageIetf,
        track_name: Object.prototype.hasOwnProperty.call(properties, 'track_name')
            ? String(properties.track_name) : '',
        flags: {},
    };
    MKV_VIDEO_SEMANTIC_FLAG_OPTIONS.forEach(function (entry) {
        semantics.flags[entry.property] = mkvSemanticBoolean(
            properties, entry.property, entry.defaultValue, description);
    });
    return semantics;
}

function singleMkvVideoTrack(identify, description) {
    var videos = (identify && identify.tracks || []).filter(function (track) {
        return track && track.type === 'video';
    });
    if (videos.length !== 1) {
        throw new Error(description + ' must contain exactly one actual video track; found ' + videos.length);
    }
    var trackId = videos[0].id;
    if (!Number.isInteger(trackId) || trackId < 0) {
        throw new Error(description + ' primary video has an invalid mkvmerge track ID');
    }
    return videos[0];
}

function buildMkvPrimaryVideoSemanticOverlay(sourceIdentify, grainedIdentify) {
    var sourceTrack = singleMkvVideoTrack(sourceIdentify, 'source Matroska');
    var grainedTrack = singleMkvVideoTrack(grainedIdentify, 'grain-applied intermediate');
    return {
        schema: 1,
        source_track_id: sourceTrack.id,
        target_track_id: grainedTrack.id,
        source: effectiveMkvPrimaryVideoSemantics(sourceTrack, 'source Matroska primary video'),
        grained: effectiveMkvPrimaryVideoSemantics(grainedTrack,
            'grain-applied intermediate primary video'),
        custom_tags: stableMkvPrimaryVideoCustomTags(sourceTrack),
    };
}

function buildMkvPrimaryVideoSemanticArgs(overlay, customTagPath) {
    if (!overlay) return [];
    var target = String(overlay.target_track_id);
    var argv = [];
    var desiredLanguage = overlay.source.language_ietf || overlay.source.language || 'und';
    var currentLanguage = overlay.grained.language_ietf || overlay.grained.language || 'und';
    if (lower(desiredLanguage) !== lower(currentLanguage)) {
        argv.push('--language', target + ':' + desiredLanguage);
    }
    if (overlay.source.track_name !== overlay.grained.track_name) {
        argv.push('--track-name', target + ':' + overlay.source.track_name);
    }
    MKV_VIDEO_SEMANTIC_FLAG_OPTIONS.forEach(function (entry) {
        if (overlay.source.flags[entry.property] !== overlay.grained.flags[entry.property]) {
            argv.push(entry.option, target + ':' + (overlay.source.flags[entry.property] ? '1' : '0'));
        }
    });
    if (Object.keys(overlay.custom_tags || {}).length) {
        if (!customTagPath) throw new Error('primary-video custom tags require an MKVToolNix XML path');
        argv.push('--tags', target + ':' + String(customTagPath));
    }
    return argv;
}

function assertMkvPrimaryVideoSemanticsPreserved(sourceTrack, outputTrack) {
    var expected = effectiveMkvPrimaryVideoSemantics(sourceTrack, 'source Matroska primary video');
    var actual = effectiveMkvPrimaryVideoSemantics(outputTrack, 'grain-output primary video');
    if (lower(expected.language) !== lower(actual.language)) {
        throw new Error('primary video language changed during grain remux');
    }
    if (expected.language_ietf !== null &&
            lower(expected.language_ietf) !== lower(actual.language_ietf || '')) {
        throw new Error('primary video IETF language changed during grain remux');
    }
    if (expected.track_name !== actual.track_name) {
        throw new Error('primary video track name changed during grain remux');
    }
    MKV_VIDEO_SEMANTIC_FLAG_OPTIONS.forEach(function (entry) {
        if (expected.flags[entry.property] !== actual.flags[entry.property]) {
            throw new Error('primary video ' + entry.property + ' flag changed during grain remux');
        }
    });
    var expectedTags = stableMkvPrimaryVideoCustomTags(sourceTrack);
    var actualTags = stableMkvPrimaryVideoCustomTags(outputTrack);
    if (JSON.stringify(expectedTags) !== JSON.stringify(actualTags)) {
        throw new Error('primary video safe custom tags changed during grain remux');
    }
    return {
        language: expected.language,
        language_ietf: expected.language_ietf,
        track_name_present: expected.track_name !== '',
        semantic_flags: canonicalObject(expected.flags),
        safe_custom_tag_names: Object.keys(expectedTags).sort(),
    };
}

function canonicalObject(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonicalObject);
    var result = {};
    Object.keys(value).sort().forEach(function (key) { result[key] = canonicalObject(value[key]); });
    return result;
}

function approximatelyEqual(left, right) {
    var a = Number(left);
    var b = Number(right);
    return Number.isFinite(a) && Number.isFinite(b) &&
        Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function strictReportNumber(value, description) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(description + ' must be a finite JSON number');
    }
    return value;
}

function strictReportInteger(value, description) {
    var parsed = strictReportNumber(value, description);
    if (!Number.isInteger(parsed)) throw new Error(description + ' must be a JSON integer');
    return parsed;
}

function reportNumbersApproximatelyEqual(left, right) {
    return typeof left === 'number' && Number.isFinite(left) &&
        typeof right === 'number' && Number.isFinite(right) && approximatelyEqual(left, right);
}

function assertDispositionParity(expected, actual, description) {
    var left = JSON.stringify(canonicalObject(expected || {}));
    var right = JSON.stringify(canonicalObject(actual || {}));
    if (left !== right) throw new Error(description + ': stream disposition changed');
}

function normalizedFieldOrder(stream) {
    // MKVToolNix does not write a FieldOrder element for V_AV1 tracks (confirmed:
    // --field-order is a silent no-op for this codec_id), so a remuxed AV1 track's
    // field_order is always unset/'unknown' regardless of the true source. FFmpeg's
    // own AV1 muxer defaults to asserting 'progressive' even for a source it itself
    // reports as 'unknown' (this pipeline's real source files report field_order
    // 'unknown', never an explicit interlaced value). Since the remux step never
    // re-encodes video (pure stream copy), field_order cannot actually change here;
    // the difference is a container-authoring-tool artifact, not a content change.
    // Only fold the 'no real signal' values together so a genuine interlaced value
    // on either side still fails the comparison as before.
    var value = lower(stream && stream.field_order);
    if (value === undefined || value === '' || value === 'unknown') return 'progressive';
    return stream.field_order;
}

var HDR_NUMERIC_REL_TOLERANCE = 1e-6;
var HDR_NUMERIC_ABS_TOLERANCE = 1e-9;

function technicalVideoState(stream) {
    var keys = [
        'codec_name',
        'width', 'height', 'coded_width', 'coded_height', 'sample_aspect_ratio', 'display_aspect_ratio',
        'pix_fmt', 'profile', 'level', 'color_range', 'color_space', 'color_transfer', 'color_primaries',
        'chroma_location', 'avg_frame_rate', 'r_frame_rate',
    ];
    var result = {};
    keys.forEach(function (key) {
        if (stream && stream[key] !== undefined) result[key] = stream[key];
    });
    result.field_order = normalizedFieldOrder(stream);
    return canonicalObject(result);
}

function hdrSideDataState(stream) {
    return canonicalObject((stream && stream.side_data_list || []).filter(function (entry) {
        var type = lower(entry && entry.side_data_type);
        return /mastering display|content light|ambient viewing|dolby vision|dovi|smpte.?2094|hdr10/.test(type);
    }));
}

function relevantColorState(stream) {
    var result = technicalVideoState(stream);
    result.hdr_side_data = hdrSideDataState(stream);
    return canonicalObject(result);
}

function finiteRationalValue(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? { valid: true, value: value } : { valid: false };
    }
    if (typeof value !== 'string') return { valid: false };
    var numberPattern = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
    var match = value.trim().match(new RegExp('^(' + numberPattern + ')(?:/(' + numberPattern + '))?$'));
    if (!match) return { valid: false };
    var numerator = Number(match[1]);
    var denominator = match[2] === undefined ? 1 : Number(match[2]);
    var parsed = numerator / denominator;
    return Number.isFinite(parsed) && denominator !== 0
        ? { valid: true, value: parsed }
        : { valid: false };
}

function hdrNumbersApproximatelyEqual(expected, actual) {
    var left = finiteRationalValue(expected);
    var right = finiteRationalValue(actual);
    if (!left.valid || !right.valid) return false;
    var tolerance = Math.max(
        HDR_NUMERIC_ABS_TOLERANCE,
        HDR_NUMERIC_REL_TOLERANCE * Math.max(Math.abs(left.value), Math.abs(right.value))
    );
    return Math.abs(left.value - right.value) <= tolerance;
}

function firstStructuredMismatch(expected, actual, location, rationalAware) {
    location = location || '$';
    if (Array.isArray(expected) || Array.isArray(actual)) {
        if (!Array.isArray(expected) || !Array.isArray(actual)) {
            return { location: location, expected: expected, actual: actual };
        }
        if (expected.length !== actual.length) {
            return {
                location: location + '.length',
                expected: expected.length,
                actual: actual.length,
            };
        }
        for (var i = 0; i < expected.length; i++) {
            var arrayMismatch = firstStructuredMismatch(
                expected[i], actual[i], location + '[' + i + ']', rationalAware);
            if (arrayMismatch) return arrayMismatch;
        }
        return null;
    }
    var expectedObject = expected !== null && typeof expected === 'object';
    var actualObject = actual !== null && typeof actual === 'object';
    if (expectedObject || actualObject) {
        if (!expectedObject || !actualObject || Array.isArray(expected) || Array.isArray(actual)) {
            return { location: location, expected: expected, actual: actual };
        }
        var expectedKeys = Object.keys(expected).sort();
        var actualKeys = Object.keys(actual).sort();
        var allKeys = expectedKeys.concat(actualKeys).filter(function (key, index, values) {
            return values.indexOf(key) === index;
        }).sort();
        for (var j = 0; j < allKeys.length; j++) {
            var key = allKeys[j];
            if (!Object.prototype.hasOwnProperty.call(expected, key) ||
                    !Object.prototype.hasOwnProperty.call(actual, key)) {
                return { location: location + '.' + key, expected: expected[key], actual: actual[key] };
            }
            var objectMismatch = firstStructuredMismatch(
                expected[key], actual[key], location + '.' + key, rationalAware);
            if (objectMismatch) return objectMismatch;
        }
        return null;
    }
    if (rationalAware && hdrNumbersApproximatelyEqual(expected, actual)) return null;
    return JSON.stringify(expected) === JSON.stringify(actual)
        ? null
        : { location: location, expected: expected, actual: actual };
}

function parityValue(value) {
    return value === undefined ? '<missing>' : JSON.stringify(value);
}

function assertVideoParity(workingStream, outputStream, stageDescription) {
    var stage = stageDescription ? stageDescription + ': ' : '';
    var technicalMismatch = firstStructuredMismatch(
        technicalVideoState(workingStream), technicalVideoState(outputStream), '$', false);
    if (technicalMismatch) {
        throw new Error(stage + 'primary video technical metadata changed at ' +
            technicalMismatch.location + ' (expected ' + parityValue(technicalMismatch.expected) +
            ', actual ' + parityValue(technicalMismatch.actual) + ')');
    }
    var hdrMismatch = firstStructuredMismatch(
        hdrSideDataState(workingStream), hdrSideDataState(outputStream), '$.hdr_side_data', true);
    if (hdrMismatch) {
        throw new Error(stage + 'primary video HDR side-data changed at ' +
            hdrMismatch.location + ' (expected ' + parityValue(hdrMismatch.expected) +
            ', actual ' + parityValue(hdrMismatch.actual) + ')');
    }
    if (lower(outputStream && outputStream.codec_name) !== 'av1') {
        throw new Error(stage + 'grain output primary video is not AV1');
    }
}

function assertChapterParity(sourceProbe, outputProbe, tolerance) {
    var source = sourceProbe.chapters || [];
    var output = outputProbe.chapters || [];
    if (source.length !== output.length) throw new Error('chapter count changed from ' + source.length + ' to ' + output.length);
    for (var i = 0; i < source.length; i++) {
        var leftStart = finiteNumber(source[i].start_time, NaN);
        var rightStart = finiteNumber(output[i].start_time, NaN);
        var leftEnd = finiteNumber(source[i].end_time, NaN);
        var rightEnd = finiteNumber(output[i].end_time, NaN);
        if (!Number.isFinite(leftStart) || !Number.isFinite(rightStart) || Math.abs(leftStart - rightStart) > tolerance ||
            !Number.isFinite(leftEnd) || !Number.isFinite(rightEnd) || Math.abs(leftEnd - rightEnd) > tolerance) {
            throw new Error('chapter timing changed at chapter ' + i);
        }
        assertTagsPreserved(source[i].tags, output[i].tags, 'chapter ' + i);
    }
}

function matchAncillaryStreams(sourceProbe, outputProbe) {
    var sourceStreams = sourceProbe.streams || [];
    var outputStreams = outputProbe.streams || [];
    var sourcePrimary = primaryVideo(sourceProbe);
    var outputPrimary = primaryVideo(outputProbe);
    if (!sourcePrimary) throw new Error('missing source primary video stream');
    if (!outputPrimary) throw new Error('missing output primary video stream');
    if (sourceStreams.length !== outputStreams.length) {
        throw new Error('stream count changed from ' + sourceStreams.length + ' to ' + outputStreams.length);
    }
    var sourceAncillary = sourceStreams.filter(function (stream) {
        return stream !== sourcePrimary;
    });
    var remainingOutput = outputStreams.filter(function (stream) {
        return stream !== outputPrimary;
    });
    var pairs = [];
    sourceAncillary.forEach(function (sourceStream) {
        var codecCandidates = [];
        for (var i = 0; i < remainingOutput.length; i++) {
            var candidate = remainingOutput[i];
            if (sourceStream.codec_type === candidate.codec_type &&
                    sourceStream.codec_name === candidate.codec_name &&
                    (sourceStream.extradata_hash || '') === (candidate.extradata_hash || '')) {
                codecCandidates.push({ index: i, stream: candidate });
            }
        }
        if (!codecCandidates.length) {
            throw new Error('source ancillary stream ' + sourceStream.index + ' codec/type/extradata changed');
        }
        var firstValidationError = null;
        var matchedIndex = -1;
        for (var j = 0; j < codecCandidates.length; j++) {
            try {
                assertDispositionParity(sourceStream.disposition, codecCandidates[j].stream.disposition,
                    'source ancillary stream ' + sourceStream.index);
                assertTagsPreserved(sourceStream.tags, codecCandidates[j].stream.tags,
                    'source ancillary stream ' + sourceStream.index);
                matchedIndex = codecCandidates[j].index;
                break;
            } catch (candidateError) {
                if (!firstValidationError) firstValidationError = candidateError;
            }
        }
        if (matchedIndex === -1) throw firstValidationError || new Error(
            'source ancillary stream ' + sourceStream.index + ' metadata changed');
        pairs.push({ source: sourceStream, output: remainingOutput[matchedIndex] });
        remainingOutput.splice(matchedIndex, 1);
    });
    if (remainingOutput.length) throw new Error('grain output contains unmatched ancillary streams');
    return pairs;
}

function assertStreamParity(sourceProbe, workingProbe, outputProbe, videoParityOptions) {
    var sourcePrimary = primaryVideo(sourceProbe);
    var workingPrimary = primaryVideo(workingProbe);
    var outputPrimary = primaryVideo(outputProbe);
    if (!sourcePrimary || !workingPrimary) throw new Error('missing source or working primary video stream');
    if (!outputPrimary) throw new Error('missing output primary video stream');
    var videoReferenceProbe = videoParityOptions && videoParityOptions.referenceProbe || workingProbe;
    var videoReferencePrimary = primaryVideo(videoReferenceProbe);
    if (!videoReferencePrimary) throw new Error('missing video parity reference primary video stream');
    assertVideoParity(videoReferencePrimary, outputPrimary,
        videoParityOptions && videoParityOptions.stageDescription);
    assertDispositionParity(sourcePrimary.disposition, outputPrimary.disposition, 'primary video stream');
    assertPrimaryVideoUserTagsPreserved(
        sourcePrimary.tags, outputPrimary.tags, 'primary video stream');
    matchAncillaryStreams(sourceProbe, outputProbe);
    assertTagsPreserved(sourceProbe.format && sourceProbe.format.tags, outputProbe.format && outputProbe.format.tags, 'container');
}

function buildRemuxArgs(grainedVideoPath, sourcePath, outputPath, sourceProbe) {
    var sourcePrimary = primaryVideo(sourceProbe);
    if (!sourcePrimary) throw new Error('cannot build remux command without a source primary video');
    var argv = ['-hide_banner', '-loglevel', 'error', '-y', '-i', grainedVideoPath, '-i', sourcePath];
    (sourceProbe.streams || []).forEach(function (stream) {
        if (stream.index === sourcePrimary.index) argv.push('-map', '0:v:0');
        else argv.push('-map', '1:' + stream.index);
    });
    argv.push('-map_metadata', '1', '-map_chapters', '1');
    (sourceProbe.streams || []).forEach(function (stream, outputIndex) {
        argv.push('-map_metadata:s:' + outputIndex, '1:s:' + stream.index);
    });
    argv.push('-c', 'copy', '-copy_unknown', '-max_muxing_queue_size', '4096', outputPath);
    return argv;
}

function validMatroskaDate(value) {
    if (typeof value !== 'string') return null;
    var timestamp = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) ||
        !Number.isFinite(Date.parse(timestamp))) return null;
    return timestamp;
}

function sourceMatroskaDate(sourceProbe, sourceIdentify) {
    var identifyDate = sourceIdentify && sourceIdentify.container &&
        sourceIdentify.container.properties && sourceIdentify.container.properties.date_utc;
    return validMatroskaDate(identifyDate) || validMatroskaDate(
        getTag(sourceProbe && sourceProbe.format && sourceProbe.format.tags, 'creation_time'));
}

function buildMkvmergeRemuxArgs(grainedVideoPath, sourcePath, outputPath, sourceProbe, sourceIdentify,
    primaryVideoSemanticOverlay, primaryVideoCustomTagPath) {
    var argv = ['--quiet', '--disable-track-statistics-tags', '--output', String(outputPath)];
    var identifyTitle = sourceIdentify && sourceIdentify.container &&
        sourceIdentify.container.properties && sourceIdentify.container.properties.title;
    var sourceTitle = String(identifyTitle === undefined || identifyTitle === null
        ? getTag(sourceProbe && sourceProbe.format && sourceProbe.format.tags, 'title')
        : identifyTitle);
    if (sourceTitle.trim()) argv.push('--title', sourceTitle);
    var sourceDate = sourceMatroskaDate(sourceProbe, sourceIdentify);
    if (sourceDate) argv.push('--date', sourceDate);
    // These options are scoped to the following input. The calibrated grain input contributes
    // only its AV1 primary. The original Matroska contributes everything except its superseded
    // video track(s), keeping zlib-compressed PGS and every attachment out of FFmpeg entirely.
    argv.push('--no-audio', '--no-subtitles', '--no-buttons', '--no-chapters',
        '--no-attachments', '--no-global-tags', '--no-track-tags');
    argv.push.apply(argv, buildMkvPrimaryVideoSemanticArgs(
        primaryVideoSemanticOverlay, primaryVideoCustomTagPath));
    argv.push(String(grainedVideoPath));
    argv.push('--no-video', String(sourcePath));
    return argv;
}

function parseMkvmergeIdentifyJson(rawJson, filePath) {
    // MKVToolNix emits unsigned 64-bit track, attachment, and chapter UIDs as
    // JSON numbers. JSON.parse would silently round adjacent values above
    // Number.MAX_SAFE_INTEGER, so quote exact `uid` integers before parsing.
    // Other numeric properties retain their native JSON types.
    var losslessJson = String(rawJson || '{}').replace(
        /("uid"\s*:\s*)(-?\d+)(?=\s*[,}])/g, '$1"$2"');
    try { return JSON.parse(losslessJson); }
    catch (_) {
        throw new Error('mkvmerge identify returned invalid JSON for ' + String(filePath || 'input'));
    }
}

async function identifyMatroskaWithMkvmerge(filePath, timeoutMs) {
    var result = await runChecked('mkvmerge', ['-J', String(filePath)], {
        timeoutMs: timeoutMs,
        maxOutputBytes: 32 * 1024 * 1024,
    });
    var parsed = parseMkvmergeIdentifyJson(result.stdout, filePath);
    if (!parsed || !parsed.container || parsed.container.supported !== true || !Array.isArray(parsed.tracks)) {
        throw new Error('mkvmerge does not identify a supported container at ' + filePath);
    }
    if ((parsed.errors || []).length || (parsed.warnings || []).length) {
        throw new Error('mkvmerge identify reported errors or warnings for ' + filePath);
    }
    return parsed;
}

function assertUidFieldsLossless(value, description, location) {
    location = location || '$';
    if (Array.isArray(value)) {
        value.forEach(function (item, index) {
            assertUidFieldsLossless(item, description, location + '[' + index + ']');
        });
        return;
    }
    if (!value || typeof value !== 'object') return;
    Object.keys(value).forEach(function (key) {
        var childLocation = location + '.' + key;
        if (lower(key) === 'uid') {
            if (typeof value[key] !== 'string' || !/^-?\d+$/.test(value[key])) {
                throw new Error(description + ' has a UID that was not parsed losslessly at ' + childLocation);
            }
            return;
        }
        assertUidFieldsLossless(value[key], description, childLocation);
    });
}

function assertRequiredMkvEntityUids(identify, description) {
    (identify && identify.tracks || []).forEach(function (track, index) {
        var uid = track && track.properties && track.properties.uid;
        if (typeof uid !== 'string' || !/^-?\d+$/.test(uid)) {
            throw new Error(description + ' track ' + index + ' has no lossless decimal UID');
        }
    });
    (identify && identify.attachments || []).forEach(function (attachment, index) {
        var uid = attachment && attachment.properties && attachment.properties.uid;
        if (typeof uid !== 'string' || !/^-?\d+$/.test(uid)) {
            throw new Error(description + ' attachment ' + index + ' has no lossless decimal UID');
        }
    });
}

function stableMkvTrackInventory(track) {
    var properties = track && track.properties || {};
    var propertyKeys = [
        'codec_id', 'codec_private_data', 'uid', 'language', 'language_ietf',
        'track_name', 'default_track', 'forced_track', 'enabled_track',
        'hearing_impaired', 'visual_impaired', 'text_descriptions', 'original',
        'commentary', 'audio_channels', 'audio_sampling_frequency', 'default_duration',
        'content_encoding_algorithms', 'codec_private_length', 'pixel_dimensions',
        'display_dimensions', 'display_unit', 'color_primaries',
        'color_transfer_characteristics', 'color_matrix_coefficients', 'color_range',
        'chroma_siting',
    ];
    var stableProperties = {};
    propertyKeys.forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) stableProperties[key] = properties[key];
    });
    return canonicalObject({
        type: track && track.type,
        codec: track && track.codec,
        properties: stableProperties,
    });
}

function stableMkvPrimaryTechnicalInventory(track) {
    var inventory = stableMkvTrackInventory(track);
    ['language', 'language_ietf', 'track_name'].concat(
        MKV_VIDEO_SEMANTIC_FLAG_OPTIONS.map(function (entry) { return entry.property; })
    ).forEach(function (property) {
        delete inventory.properties[property];
    });
    return inventory;
}

function stableMkvAttachmentInventory(attachment) {
    var properties = attachment && attachment.properties || {};
    return canonicalObject({
        content_type: attachment && attachment.content_type,
        description: attachment && attachment.description || '',
        file_name: attachment && attachment.file_name,
        size: attachment && attachment.size,
        uid: properties.uid,
    });
}

function findDeclaredMkvInventoryMismatch(expected, actual, location) {
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual)) return location + ' changed type';
        if (expected.length !== actual.length) return location + ' changed length';
        for (var i = 0; i < expected.length; i++) {
            var arrayMismatch = findDeclaredMkvInventoryMismatch(
                expected[i], actual[i], location + '[' + i + ']');
            if (arrayMismatch) return arrayMismatch;
        }
        return '';
    }
    if (expected && typeof expected === 'object') {
        if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return location + ' changed type';
        var keys = Object.keys(expected);
        for (var j = 0; j < keys.length; j++) {
            var key = keys[j];
            var propertyLocation = location + '.' + key;
            if (!Object.prototype.hasOwnProperty.call(actual, key)) return propertyLocation + ' is missing';
            var objectMismatch = findDeclaredMkvInventoryMismatch(
                expected[key], actual[key], propertyLocation);
            if (objectMismatch) return objectMismatch;
        }
        return '';
    }
    if (JSON.stringify(expected) !== JSON.stringify(actual)) return location + ' changed value';
    return '';
}

function assertDeclaredMkvInventoryPreserved(expected, actual, description) {
    var mismatch = findDeclaredMkvInventoryMismatch(expected, actual, '$');
    if (mismatch) throw new Error(description + ' changed during grain remux: ' + mismatch);
}

function assertUnorderedDeclaredMkvInventoryPreserved(expected, actual, description) {
    var authoritativeItems = expected || [];
    var remainingItems = (actual || []).slice();
    if (authoritativeItems.length !== remainingItems.length) {
        throw new Error(description + ' changed during grain remux: item count changed');
    }
    for (var i = 0; i < authoritativeItems.length; i++) {
        var matchIndex = -1;
        for (var j = 0; j < remainingItems.length; j++) {
            if (!findDeclaredMkvInventoryMismatch(authoritativeItems[i], remainingItems[j], '$')) {
                matchIndex = j;
                break;
            }
        }
        if (matchIndex === -1) {
            throw new Error(description + ' changed during grain remux: no output item preserves item ' + i);
        }
        remainingItems.splice(matchIndex, 1);
    }
}

function sortedCanonicalMkvInventory(items) {
    return (items || []).map(function (item) {
        return JSON.stringify(canonicalObject(item));
    }).sort();
}

function assertExactUnorderedMkvInventory(expected, actual, description) {
    var left = JSON.stringify(sortedCanonicalMkvInventory(expected));
    var right = JSON.stringify(sortedCanonicalMkvInventory(actual));
    if (left !== right) throw new Error(description + ' changed during grain remux');
}

function assertMatroskaSourceVideoTopology(sourceIdentify) {
    var videos = (sourceIdentify && sourceIdentify.tracks || []).filter(function (track) {
        return track && track.type === 'video';
    });
    if (videos.length !== 1) {
        throw new Error('source Matroska must contain exactly one actual video track for grain remux; found ' +
            videos.length);
    }
    return videos[0];
}

function chapterEntryCount(chapters) {
    return (chapters || []).reduce(function (total, edition) {
        var count = Number(edition && edition.num_entries);
        return total + (Number.isFinite(count) && count >= 0 ? count : 0);
    }, 0);
}

function verifyMkvmergeGrainInventory(sourceIdentify, grainedIdentify, outputIdentify) {
    assertUidFieldsLossless(sourceIdentify, 'source Matroska identify');
    assertUidFieldsLossless(grainedIdentify, 'grained-video Matroska identify');
    assertUidFieldsLossless(outputIdentify, 'grain-output Matroska identify');
    assertRequiredMkvEntityUids(sourceIdentify, 'source Matroska identify');
    assertRequiredMkvEntityUids(grainedIdentify, 'grained-video Matroska identify');
    assertRequiredMkvEntityUids(outputIdentify, 'grain-output Matroska identify');
    var sourceVideo = assertMatroskaSourceVideoTopology(sourceIdentify);

    var grainedVideos = (grainedIdentify && grainedIdentify.tracks || []).filter(function (track) {
        return track && track.type === 'video';
    });
    if (grainedVideos.length !== 1) {
        throw new Error('grain-applied intermediate must contain exactly one actual video track; found ' +
            grainedVideos.length);
    }
    var outputVideos = (outputIdentify && outputIdentify.tracks || []).filter(function (track) {
        return track && track.type === 'video';
    });
    if (outputVideos.length !== 1) {
        throw new Error('grain-remuxed output must contain exactly one actual video track; found ' +
            outputVideos.length);
    }
    assertDeclaredMkvInventoryPreserved(
        stableMkvPrimaryTechnicalInventory(grainedVideos[0]),
        stableMkvPrimaryTechnicalInventory(outputVideos[0]),
        'primary grained video technical inventory');
    var primaryVideoSemantics = assertMkvPrimaryVideoSemanticsPreserved(
        sourceVideo, outputVideos[0]);

    var sourceNonVideo = (sourceIdentify.tracks || []).filter(function (track) {
        return track && track.type !== 'video';
    }).map(stableMkvTrackInventory);
    var outputNonVideo = (outputIdentify.tracks || []).filter(function (track) {
        return track && track.type !== 'video';
    }).map(stableMkvTrackInventory);
    // Track order and Matroska TrackNumber are mux-local details. Match by the
    // losslessly parsed UID and declared semantic inventory instead.
    assertUnorderedDeclaredMkvInventoryPreserved(
        sourceNonVideo, outputNonVideo, 'source non-video track inventory');
    assertUnorderedDeclaredMkvInventoryPreserved(
        (sourceIdentify.attachments || []).map(stableMkvAttachmentInventory),
        (outputIdentify.attachments || []).map(stableMkvAttachmentInventory),
        'source attachment inventory');
    assertExactUnorderedMkvInventory(
        sourceIdentify.chapters || [], outputIdentify.chapters || [], 'source chapter editions');
    assertExactUnorderedMkvInventory(
        sourceIdentify.global_tags || [], outputIdentify.global_tags || [], 'source global tag sets');

    var sourceTitle = String(sourceIdentify && sourceIdentify.container &&
        sourceIdentify.container.properties && sourceIdentify.container.properties.title || '');
    var outputTitle = String(outputIdentify && outputIdentify.container &&
        outputIdentify.container.properties && outputIdentify.container.properties.title || '');
    if (sourceTitle !== outputTitle) throw new Error('Matroska segment title changed during grain remux');

    return {
        schema: 1,
        verifier: 'mkvmerge-identify-lossless-directional-v1',
        uid_fields_lossless_decimal_strings: true,
        primary_video_tracks: outputVideos.length,
        non_video_tracks: outputNonVideo.length,
        attachments: (outputIdentify.attachments || []).length,
        chapter_editions: (outputIdentify.chapters || []).length,
        chapter_entries: chapterEntryCount(outputIdentify.chapters),
        global_tag_sets: (outputIdentify.global_tags || []).length,
        primary_video_semantics: primaryVideoSemantics,
    };
}

function nonPrimaryPayloadIndexes(sourceProbe) {
    var primary = primaryVideo(sourceProbe);
    return (sourceProbe.streams || []).filter(function (stream) {
        return primary && stream.index !== primary.index && stream.codec_type !== 'attachment';
    }).map(function (stream) { return stream.index; });
}

async function streamHashes(ffmpegPath, filePath, streamIndexes, timeoutMs) {
    if (!streamIndexes.length) return [];
    var argv = ['-hide_banner', '-loglevel', 'error', '-i', filePath];
    streamIndexes.forEach(function (index) { argv.push('-map', '0:' + index); });
    argv.push('-c', 'copy', '-f', 'streamhash', '-hash', 'sha256', '-');
    var result = await runChecked(ffmpegPath, argv, { timeoutMs: timeoutMs, maxOutputBytes: 4 * 1024 * 1024 });
    return result.stdout.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean).map(function (line) {
        var match = line.match(/^\d+,([^,]+),SHA256=([0-9a-f]+)$/i);
        if (!match) throw new Error('unexpected streamhash output: ' + line);
        return { type: match[1], hash: lower(match[2]) };
    });
}

function hasSemanticGrain(text) {
    var lines = String(text || '').split(/\r?\n/);
    if (lines[0] && lines[0].trim() !== 'filmgrn1') return false;
    var hasSegment = lines.some(function (line) { return /^E\s+\d+\s+\d+\s+/.test(line.trim()); });
    var hasScale = lines.some(function (line) {
        var match = line.trim().match(/^s(?:Y|Cb|Cr)\s+(\d+)\s+(.+)$/);
        if (!match) return false;
        var count = Number(match[1]);
        var values = match[2].trim().split(/\s+/).map(Number);
        if (!Number.isInteger(count) || values.length < count * 2) return false;
        for (var i = 0; i < count; i++) {
            if (Number.isFinite(values[i * 2 + 1]) && values[i * 2 + 1] > 0) return true;
        }
        return false;
    });
    return hasSegment && hasScale;
}

function sha256File(filePath) {
    var hash = crypto.createHash('sha256');
    var buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    var handle = fs.openSync(filePath, 'r');
    try {
        var position = 0;
        while (true) {
            var count = fs.readSync(handle, buffer, 0, buffer.length, position);
            if (count === 0) break;
            hash.update(count === buffer.length ? buffer : buffer.subarray(0, count));
            position += count;
        }
    } finally {
        fs.closeSync(handle);
    }
    return hash.digest('hex');
}

function tablesHaveIdenticalPayload(leftPath, rightPath) {
    return sha256File(leftPath) === sha256File(rightPath);
}

function atomicCopy(source, destination) {
    var partial = destination + '.partial-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    fs.copyFileSync(source, partial, fs.constants.COPYFILE_EXCL);
    try {
        fs.renameSync(partial, destination);
    } catch (err) {
        try { fs.unlinkSync(partial); } catch (_) {}
        throw err;
    }
}

function writeJsonAtomic(destination, value) {
    var partial = destination + '.partial-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(partial, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    try {
        fs.renameSync(partial, destination);
    } catch (err) {
        try { fs.unlinkSync(partial); } catch (_) {}
        throw err;
    }
}

function writeTextAtomic(destination, value) {
    var partial = destination + '.partial-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    var handle = null;
    try {
        handle = fs.openSync(partial, 'wx', 0o600);
        fs.writeFileSync(handle, String(value), { encoding: 'utf8' });
        fs.fsyncSync(handle);
        fs.closeSync(handle);
        handle = null;
        fs.renameSync(partial, destination);
    } catch (err) {
        if (handle !== null) {
            try { fs.closeSync(handle); } catch (_) {}
        }
        try { fs.unlinkSync(partial); } catch (_) {}
        throw err;
    }
}

function reviewStem(sourcePath) {
    var base = path.basename(sourcePath, path.extname(sourcePath));
    var stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    return safeSlug(base) + '.grain-canary.' + stamp + '.' + stableId(sourcePath + ':' + Date.now() + ':' + process.pid);
}

function activeReplacementPath(workRoot, sourcePath) {
    var root = path.resolve(String(workRoot || ''));
    var sourceName = path.basename(String(sourcePath || ''));
    var sourceStem = path.basename(sourceName, path.extname(sourceName));
    if (!sourceStem || sourceStem === '.' || sourceStem === '..') {
        throw new Error('cannot derive a safe replacement basename from the library source');
    }
    var outputPath = path.resolve(path.join(root, sourceStem + '.mkv'));
    if (outputPath.indexOf(root + path.sep) !== 0) {
        throw new Error('refusing to promote active grain output outside scratch root');
    }
    return outputPath;
}

function summarizeManifest(manifest) {
    return {
        schema: manifest.schema,
        scan: manifest.scan,
        selected: manifest.selected,
        merge: manifest.merge,
        settings: manifest.settings,
        comparison: manifest.comparison,
        media_profile: manifest.media_profile,
        source_residual_representability: manifest.source_residual_representability,
        smoke_validated: manifest.smoke_validated,
        elapsed_seconds: manifest.elapsed_seconds,
    };
}

function validateDeferredGrainBaseContract(args, sourcePath, workingPath, workingProbe) {
    if (!args.variables || args.variables.vmafAncillaryRemuxDeferred !== true) return null;
    var record = args.variables.vmafDeferredGrainBase;
    if (!record || record.schema !== 1 ||
        record.contract_id !== 'protected-video-only-checkpoint-materialization-v1' ||
        record.ancillary_remux_deferred !== true || record.exactly_one_video_only_stream !== true ||
        !/^[0-9a-f]{64}$/.test(String(record.checkpoint_key || ''))) {
        throw new Error('deferred grain base lacks an authenticated checkpoint materialization record');
    }
    var resolvedWorking = fs.realpathSync(workingPath);
    if (path.resolve(String(record.path || '')) !== path.resolve(resolvedWorking)) {
        throw new Error('deferred grain base path does not match its checkpoint materialization record');
    }
    var workingStat = assertRegularFile(resolvedWorking, 'deferred video-only grain base');
    if (workingStat.size !== Number(record.size_bytes)) {
        throw new Error('deferred grain base size changed after checkpoint materialization');
    }
    if (!/^[0-9a-f]{64}$/.test(String(record.sha256_full || ''))) {
        throw new Error('deferred grain base lacks a full SHA-256 materialization identity');
    }
    if (sha256File(resolvedWorking) !== record.sha256_full) {
        throw new Error('deferred grain base SHA-256 changed after checkpoint materialization');
    }
    if (!workingProbe || !Array.isArray(workingProbe.streams) || workingProbe.streams.length !== 1 ||
        !primaryVideo(workingProbe) || lower(primaryVideo(workingProbe).codec_name) !== 'av1') {
        throw new Error('deferred grain base must contain exactly one total AV1 video stream');
    }
    var currentSourceFingerprint = grainArtifact.sampledSourceFingerprint(sourcePath);
    grainArtifact.assertFingerprint(record.source_fingerprint, currentSourceFingerprint,
        'deferred grain-base source');

    var manifestPath = String(record.checkpoint_manifest_path || '');
    var artifactPath = String(record.checkpoint_artifact_path || '');
    assertRegularFile(manifestPath, 'protected post-encode checkpoint manifest');
    assertRegularFile(artifactPath, 'protected post-encode checkpoint artifact');
    var checkpointManifest = readJsonObject(manifestPath, 'protected post-encode checkpoint manifest');
    if (checkpointManifest.schema !== 1 ||
        checkpointManifest.contract_id !== 'vmaf-postencode-checkpoint-v1' ||
        checkpointManifest.checkpoint_key !== record.checkpoint_key ||
        !checkpointManifest.artifact ||
        path.basename(artifactPath) !== checkpointManifest.artifact.relative_path) {
        throw new Error('deferred grain base checkpoint manifest identity is incompatible');
    }
    grainArtifact.assertFingerprint(checkpointManifest.source_fingerprint, currentSourceFingerprint,
        'protected post-encode checkpoint source');
    return record;
}

function makeResult(args, outputNumber, outputFileObj, status, extraVariables) {
    args.variables = args.variables || {};
    if (outputNumber === 3 && args.variables.vmafAncillaryRemuxDeferred === true) {
        var bypassReason = String(extraVariables && extraVariables.grainSynthesisReason || status || 'unknown');
        args.jobLog('FILM GRAIN FAILED CLOSED: refusing to bypass with a video-only deferred base (' +
            bypassReason + '); the protected checkpoint remains reusable.');
        outputNumber = 4;
        outputFileObj = keepOriginalObject(args);
        status = 'failed';
        extraVariables = Object.assign({}, extraVariables || {}, {
            grainSynthesisReason: 'deferred_video_only_base_cannot_bypass: ' + bypassReason,
        });
    }
    args.variables.grainSynthesisStatus = status;
    args.variables.grainSynthesisCompletedAt = new Date().toISOString();
    Object.keys(extraVariables || {}).forEach(function (key) { args.variables[key] = extraVariables[key]; });
    return { outputFileObj: outputFileObj, outputNumber: outputNumber, variables: args.variables };
}

/**
 * Authoritative check of a finished grain output against the ORIGINAL library
 * file.
 *
 * assessOutputSizeRatio() compares the grained output to `workingPath` — the
 * grain stage's own input — and only ever raises an advisory. That is a valid
 * measure of what grain costs, but it cannot see that the pipeline as a whole
 * has produced something bigger than the file it is about to replace: a
 * transcode at 95% of source that grain inflates by 10% passes the 101%
 * per-stage limit while landing at 104.5% of the original.
 *
 * Returns null when the output is acceptable, or a rejection describing why it
 * must not replace the original.
 */
function assessGrainOutputAgainstOriginal(originalPath, outputPath, maximumRatioPct) {
    var fsMod = require('fs');
    var originalBytes = fsMod.statSync(originalPath).size;
    var outputBytes = fsMod.statSync(outputPath).size;
    if (!Number.isSafeInteger(originalBytes) || originalBytes <= 0 ||
        !Number.isSafeInteger(outputBytes) || outputBytes <= 0) {
        throw new Error('grain output/original size evidence is invalid');
    }
    var ratioPct = outputBytes / originalBytes * 100;
    if (!Number.isFinite(ratioPct)) {
        throw new Error('grain output original-size ratio is non-finite');
    }
    if (ratioPct <= maximumRatioPct) return null;
    return {
        ratioPct: ratioPct,
        originalBytes: originalBytes,
        outputBytes: outputBytes,
        capPct: maximumRatioPct,
        reason: 'grain output is ' + ratioPct.toFixed(3) + '% of the ORIGINAL library file (cap '
            + maximumRatioPct.toFixed(3) + '%)',
    };
}

/** Cap for grain output measured against the original library file. */
function grainOriginalRatioCap(args) {
    return deliveryPolicy.resolve(args.variables || {}).maxFinalOutputRatioPct;
}

function recordQualityWarning(args, warnings, stage, warning) {
    if (!warning) return null;
    var entry = {
        stage: stage,
        code: String(warning.code || 'grain-quality-warning'),
        advisory: true,
        failures: Array.isArray(warning.failures) ? warning.failures.slice() : [],
        reason_code: warning.reason_code || null,
        message: warning.message || null,
    };
    warnings.push(entry);
    args.variables.grainSynthesisQualityWarnings = warnings.map(function (item) {
        return Object.assign({}, item, { failures: item.failures.slice() });
    });
    var detail = entry.failures.length
        ? entry.failures.join('; ')
        : [entry.reason_code, entry.message].filter(Boolean).join(': ');
    args.jobLog('!!! FILM GRAIN QUALITY WARNING [' + stage + '] ' + entry.code +
        (detail ? ': ' + detail : '') + '. Structural validation will continue.');
    return entry;
}

function assessOutputSizeRatio(baseBytes, outputBytes, maximumRatioPct) {
    if (!Number.isSafeInteger(baseBytes) || baseBytes <= 0 ||
        !Number.isSafeInteger(outputBytes) || outputBytes <= 0 ||
        typeof maximumRatioPct !== 'number' || !Number.isFinite(maximumRatioPct) ||
        maximumRatioPct < 1 || maximumRatioPct > 500) {
        throw new Error('grain output size evidence or configured ratio is invalid');
    }
    var ratioPct = outputBytes / baseBytes * 100;
    if (!Number.isFinite(ratioPct)) {
        throw new Error('grain output size ratio is non-finite');
    }
    return {
        ratioPct: ratioPct,
        qualityWarning: ratioPct > maximumRatioPct ? {
            code: 'grain-output-size-ratio-above-policy',
            advisory: true,
            failures: [
                'output is ' + ratioPct.toFixed(3) + '% of completed base, above the ' +
                    maximumRatioPct.toFixed(3) + '% advisory limit',
            ],
        } : null,
    };
}

function rollbackPromotedReviewArtifacts(args, promotedPaths) {
    var failures = [];
    (promotedPaths || []).forEach(function (reviewPath) {
        try {
            fs.unlinkSync(reviewPath);
        } catch (err) {
            if (!err || err.code !== 'ENOENT') {
                failures.push(String(reviewPath) + ': ' + (err && err.message || err));
            }
        }
    });
    if (Array.isArray(promotedPaths)) promotedPaths.length = 0;
    args.variables = args.variables || {};
    Object.keys(args.variables).forEach(function (key) {
        if (key.indexOf('grainSynthesisReview') === 0 ||
            key === 'grainSynthesisValidationReport' ||
            key === 'grainSynthesisValidation') {
            delete args.variables[key];
        }
    });
    return failures;
}

function ensurePathAllowed(sourcePath, regexText, flagsText) {
    if (!regexText) return true;
    var regex;
    var flags = String(flagsText === undefined ? 'i' : flagsText);
    if (!/^[dgimsuvy]*$/.test(flags) || new Set(flags.split('')).size !== flags.length) {
        throw new Error('invalid source path allowlist regex flags: ' + flags);
    }
    try { regex = new RegExp(String(regexText), flags); } catch (err) {
        throw new Error('invalid source path allowlist regex: ' + err.message);
    }
    return regex.test(sourcePath);
}

function requireSourceAllowlist(mode, regexText) {
    var pattern = String(regexText || '').trim();
    if ((mode === 'canary' || mode === 'active') && !pattern) {
        throw new Error('source path allowlist regex is required in ' + mode + ' mode');
    }
    return pattern;
}

async function inspectGrain(grav1synthPath, inputPath, outputPath, timeoutMs) {
    try { fs.unlinkSync(outputPath); } catch (_) {}
    await runChecked(grav1synthPath, ['inspect', '-y', '-o', outputPath, inputPath], { timeoutMs: timeoutMs });
    if (!fs.existsSync(outputPath)) return { present: false, text: '' };
    var text = fs.readFileSync(outputPath, 'utf8');
    return { present: hasSemanticGrain(text), text: text };
}

async function validatePayloadParity(ffmpegPath, sourcePath, outputPath, sourceProbe, outputProbe, timeoutMs) {
    var pairs = matchAncillaryStreams(sourceProbe, outputProbe).filter(function (pair) {
        return pair.source.codec_type !== 'attachment';
    });
    var sourceIndexes = pairs.map(function (pair) { return pair.source.index; });
    var outputIndexes = pairs.map(function (pair) { return pair.output.index; });
    var sourceHashes = await streamHashes(ffmpegPath, sourcePath, sourceIndexes, timeoutMs);
    var outputHashes = await streamHashes(ffmpegPath, outputPath, outputIndexes, timeoutMs);
    if (JSON.stringify(sourceHashes) !== JSON.stringify(outputHashes)) {
        throw new Error('one or more non-primary stream payload hashes changed during remux');
    }
    return {
        checked_stream_indexes: sourceIndexes,
        checked_output_stream_indexes: outputIndexes,
        stream_pairs: pairs.map(function (pair) {
            return { source_index: pair.source.index, output_index: pair.output.index };
        }),
        hashes: sourceHashes,
    };
}

function decodeCommandFailure(description, result) {
    var reason;
    if (result && result.spawnError) reason = result.spawnError.message || String(result.spawnError);
    else if (result && result.timedOut) reason = 'command timed out';
    else {
        reason = 'exit code ' + String(result && result.code);
        var tail = commandTail(result);
        if (tail) reason += ': ' + tail;
    }
    return new Error(description + ' failed: ' + reason);
}

function gpuDecodeUnavailableBeforePass(result) {
    if (!result || result.spawnError || result.timedOut || result.code === 0) return false;
    var evidence = lower(String(result.stderr || '') + '\n' + String(result.stdout || ''));
    // This allowlist is deliberately limited to decoder/device capability and
    // initialization failures. Bitstream errors are not GPU-unavailability:
    // they must fail validation instead of being laundered through a sampled
    // software fallback.
    return [
        /unknown decoder[^a-z0-9]+av1_cuvid/,
        /decoder[^\r\n]*av1_cuvid[^\r\n]*(?:not found|unavailable|unsupported)/,
        /no device available for decoder/,
        /device setup failed for decoder/,
        /cannot load libcuda/,
        /could not dynamically load cuda/,
        /cannot (?:init|initialize|initialise) (?:cuda|cuvid|nvdec)/,
        /failed to (?:init|initialize|initialise) (?:cuda|cuvid|nvdec)/,
        /hwaccel initialisation returned error/,
        /cuda_error_(?:no_device|insufficient_driver|system_driver_mismatch|device_unavailable)/,
        /cuvidgetdecodercaps[^\r\n]*failed/,
        /(?:av1_cuvid|cuvid|nvdec)[^\r\n]*(?:hardware is lacking|required capabilities|not supported by device)/,
    ].some(function (pattern) { return pattern.test(evidence); });
}

function boundedDecodeReason(result) {
    var value = commandTail(result).replace(/\s+/g, ' ').trim();
    if (!value && result && result.spawnError) {
        value = String(result.spawnError.message || result.spawnError).replace(/\s+/g, ' ').trim();
    }
    if (!value) value = 'GPU AV1 decoder/device unavailable';
    return value.slice(0, 500);
}

function gpuAv1DecodeArgs(outputPath, primaryIndex, singleFrame) {
    var argv = [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        '-xerror', '-err_detect', 'explode',
        '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
        '-c:v', 'av1_cuvid',
        '-i', outputPath,
        '-map', '0:' + primaryIndex,
    ];
    if (singleFrame) argv.push('-frames:v', '1');
    return argv.concat(['-an', '-sn', '-dn', '-f', 'null', '-']);
}

function distributedDecodeSamples(outputProbe, options) {
    options = options || {};
    var duration = durationSeconds(outputProbe);
    if (!(Number.isFinite(duration) && duration > 0)) {
        throw new Error('cannot sample-decode output without a finite positive duration');
    }
    var windowSeconds = clamp(finiteNumber(options.windowSeconds, 2), 0.25, 5);
    var maximumSamples = Math.round(clamp(finiteNumber(options.maximumSamples, 8), 3, 12));
    var count = Math.min(maximumSamples, Math.max(1, Math.ceil(duration / windowSeconds)));
    var maximumStart = Math.max(0, duration - Math.min(windowSeconds, duration));
    var samples = [];
    for (var index = 0; index < count; index += 1) {
        var fraction = count === 1 ? 0 : index / (count - 1);
        var start = maximumStart * fraction;
        var length = Math.min(windowSeconds, Math.max(0.001, duration - start));
        samples.push({
            start_seconds: Number(start.toFixed(3)),
            duration_seconds: Number(length.toFixed(3)),
        });
    }
    return samples;
}

function softwareSampleDecodeArgs(outputPath, primaryIndex, sample) {
    return [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        '-xerror', '-err_detect', 'explode',
        '-ss', String(sample.start_seconds),
        '-i', outputPath,
        '-map', '0:' + primaryIndex,
        '-t', String(sample.duration_seconds),
        '-an', '-sn', '-dn', '-f', 'null', '-',
    ];
}

function softwareFullDecodeArgs(outputPath, primaryIndex) {
    return [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        '-xerror', '-err_detect', 'explode',
        '-i', outputPath,
        '-map', '0:' + primaryIndex,
        '-an', '-sn', '-dn', '-f', 'null', '-',
    ];
}

async function runDecodeCommand(runner, ffmpegPath, argv, timeoutMs) {
    try {
        return await runner(ffmpegPath, argv, {
            timeoutMs: timeoutMs,
            maxOutputBytes: 4 * 1024 * 1024,
        });
    } catch (error) {
        return {
            code: null,
            signal: null,
            stdout: '',
            stderr: '',
            timedOut: false,
            spawnError: error,
        };
    }
}

function flowGpuLeaseIdentity(args, lock, lockDir) {
    var variables = args && args.variables || {};
    if (variables.vmafGpuPipelineLockAcquired !== true) return null;
    var info = variables.vmafGpuPipelineLock || {};
    if (!info.token || !info.leaseGeneration) {
        throw new Error('flow GPU lease is marked acquired without an exact token and generation');
    }
    var recordedDir = lock.resolveLockDir(info.lockDir || lockDir);
    if (recordedDir !== lockDir) {
        throw new Error('flow GPU lease does not use the canonical fixed lock path');
    }
    var owner = lock.readOwner(lockDir);
    if (!owner || owner.token !== info.token ||
            owner.leaseGeneration !== info.leaseGeneration) {
        throw new Error('flow GPU lease variables do not match the current exact lock owner');
    }
    return {
        token: info.token,
        leaseGeneration: info.leaseGeneration,
    };
}

function createGpuDecodeLeaseController(args, lockOverride) {
    var lock = lockOverride || gpuPipelineLock;
    var lockDir = lock.resolveLockDir(GPU_PIPELINE_LOCK_DIR);
    var log = args && typeof args.jobLog === 'function'
        ? function (message) { args.jobLog(message); }
        : function () {};

    return {
        acquire: async function () {
            var existing = flowGpuLeaseIdentity(args, lock, lockDir);
            var sourcePath = getOriginalPath(args || {});
            var result = await lock.acquire({
                lockDir: lockDir,
                owner: {
                    ownerId: stableId(sourcePath + ':grain-final-av1-decode'),
                    workerName: process.env.Tdarr_Node_Name ||
                        process.env.TDARR_NODE_NAME || process.env.HOSTNAME ||
                        'unknown-worker',
                    filePath: sourcePath,
                    stage: 'grain-final-av1-decode',
                    plugin: 'synthesizeFilmGrain',
                },
                waitPollSeconds: 5,
                waitLogSeconds: 60,
                maxWaitSeconds: 12 * 3600,
                staleHeartbeatSeconds: 2 * 3600,
                maxLockAgeSeconds: 8 * 3600,
                orphanProcessGraceSeconds: 180,
                heartbeatIntervalSeconds: 30,
                existingToken: existing ? existing.token : null,
                log: log,
            });
            var owner = result && result.owner;
            if (!owner || !owner.token || !owner.leaseGeneration) {
                throw new Error('GPU decode lease acquisition returned no exact token and generation');
            }
            if (existing && (result.reentrant !== true ||
                    owner.token !== existing.token ||
                    owner.leaseGeneration !== existing.leaseGeneration)) {
                if (result.reentrant !== true) {
                    var cleanup = lock.release(lockDir, owner.token, {
                        force: false,
                        expectedGeneration: owner.leaseGeneration,
                    });
                    if (!cleanup.released) {
                        var cleanupError = new Error(
                            'GPU decode lease changed during reentrant acquisition and exact cleanup failed: ' +
                            cleanup.reason);
                        cleanupError.gpuPipelineLeaseReleaseFailed = true;
                        throw cleanupError;
                    }
                }
                throw new Error('GPU decode lease changed during reentrant acquisition');
            }
            args.variables = args.variables || {};
            args.variables.vmafGpuPipelineLock = {
                lockDir: lockDir,
                token: owner.token,
                leaseGeneration: owner.leaseGeneration,
                ownerId: owner.ownerId || null,
                workerName: owner.workerName || null,
                acquiredAt: owner.acquiredAt || null,
                stage: 'grain-final-av1-decode',
            };
            args.variables.vmafGpuPipelineLockAcquired = true;
            args.variables.vmafGpuPipelineLockReleased = false;
            log(result.reentrant
                ? 'Borrowed the exact flow-owned GPU lease for final CUVID validation.'
                : 'Acquired the internal GPU lease for final CUVID validation.');
            return {
                lock: lock,
                lockDir: lockDir,
                token: owner.token,
                leaseGeneration: owner.leaseGeneration,
                borrowed: result.reentrant === true,
            };
        },
        release: async function (lease) {
            if (!lease || !lease.token || !lease.leaseGeneration) {
                throw new Error('cannot release GPU decode lease without its exact token and generation');
            }
            var released = lock.release(lease.lockDir, lease.token, {
                force: false,
                expectedGeneration: lease.leaseGeneration,
            });
            if (!released.released) {
                var releaseError = new Error(
                    'exact GPU decode lease release failed: ' + released.reason);
                releaseError.gpuPipelineLeaseReleaseFailed = true;
                throw releaseError;
            }
            args.variables.vmafGpuPipelineLockAcquired = false;
            args.variables.vmafGpuPipelineLockReleased = true;
            if (lease.borrowed) {
                log('Released the exact reentrant flow-owned GPU lease after final CUVID validation.');
            } else {
                log('Released the internal GPU lease after final CUVID validation.');
            }
            return released;
        },
    };
}

async function withGpuDecodeLease(controller, operation) {
    if (!controller || typeof controller.acquire !== 'function' ||
            typeof controller.release !== 'function') {
        throw new Error('final CUVID validation requires a GPU lease controller');
    }
    var lease = await controller.acquire();
    var value;
    var operationError = null;
    try {
        value = await operation();
    } catch (error) {
        operationError = error;
    }
    try {
        await controller.release(lease);
    } catch (releaseError) {
        var fatalReleaseError = new Error(
            'GPU decode lease release failed closed: ' + releaseError.message +
            (operationError ? '; GPU validation also failed: ' + operationError.message : ''));
        fatalReleaseError.gpuPipelineLeaseReleaseFailed = true;
        throw fatalReleaseError;
    }
    if (operationError) throw operationError;
    return value;
}

async function validateFinalAv1Decode(ffmpegPath, outputPath, outputProbe, options) {
    options = options || {};
    var primary = primaryVideo(outputProbe);
    if (!primary) throw new Error('cannot decode-validate output without primary video');
    if (lower(primary.codec_name) !== 'av1') {
        throw new Error('final primary-video decode validation requires AV1');
    }
    var runner = options.runner || runProcess;
    var timeoutMs = Math.max(1000, finiteNumber(options.timeoutMs, 240 * 60 * 1000));
    var mode = lower(options.mode);
    var auditMode = mode === 'canary' || mode === 'audit';
    var requireFullTitle = options.requireFullTitle === true;
    var log = typeof options.log === 'function' ? options.log : function () {};

    // The legacy calibrated active path has already passed ffprobe packet/stream/duration
    // inventory, remux payload hashes, grav1synth semantic inspection, and
    // calibration plus held-out decoded-region validation before reaching this
    // point. Re-decoding an entire feature adds catastrophic latency without
    // enough incremental production value to justify it. Direct bitstream
    // rewriting sets requireFullTitle and is never eligible for this fast path.
    if (!auditMode && !requireFullTitle) {
        log('Final AV1 validation mode: active structural, semantic, payload, and held-out sampled evidence; no additional full-title decode.');
        return {
            schema: 1,
            mode: 'active_structural_semantic_sampled_v1',
            exhaustive: false,
            sampled: true,
            hardware_accelerated: false,
            decoder: 'existing-heldout-region-decodes',
            additional_decode_commands: 0,
            validation_basis: [
                'ffprobe-stream-duration-inventory',
                'ancillary-payload-sha256-parity',
                'grav1synth-semantic-grain-inspection',
                'calibration-and-heldout-decoded-energy-regions',
            ],
            gpu_preflight: {
                attempted: false,
                available: null,
                reason: 'active production does not require exhaustive full-title decode',
            },
        };
    }

    // A one-frame decode is the capability/device preflight. Once it succeeds,
    // the exhaustive GPU pass is authoritative and any later error fails
    // closed; it can never fall back to a sampled software success.
    var preflightTimeoutMs = Math.min(timeoutMs, 30 * 1000);
    var gpuOutcome = await withGpuDecodeLease(options.gpuLease, async function () {
        var preflight = await runDecodeCommand(
            runner, ffmpegPath,
            gpuAv1DecodeArgs(outputPath, primary.index, true),
            preflightTimeoutMs);
        if (preflight.code === 0 && !preflight.timedOut && !preflight.spawnError) {
            log('Final AV1 decode validation mode: exhaustive GPU NVDEC/CUVID (av1_cuvid).');
            var gpuFull = await runDecodeCommand(
                runner, ffmpegPath,
                gpuAv1DecodeArgs(outputPath, primary.index, false),
                timeoutMs);
            if (gpuFull.code !== 0 || gpuFull.timedOut || gpuFull.spawnError) {
                throw decodeCommandFailure(
                    'exhaustive GPU AV1 decode validation after successful preflight; sampled fallback is forbidden',
                    gpuFull);
            }
            return {
                validation: {
                    schema: 1,
                    mode: mode + '_nvdec_full_v1',
                    exhaustive: true,
                    sampled: false,
                    hardware_accelerated: true,
                    decoder: 'av1_cuvid',
                    additional_decode_commands: 2,
                    gpu_preflight: {
                        attempted: true,
                        available: true,
                        decoded_frames: 1,
                    },
                },
            };
        }
        if (!gpuDecodeUnavailableBeforePass(preflight)) {
            throw decodeCommandFailure('GPU AV1 decode preflight', preflight);
        }
        return { unavailablePreflight: preflight };
    });
    if (gpuOutcome.validation) return gpuOutcome.validation;

    // The internal lease is intentionally released before any software decode.
    var preflight = gpuOutcome.unavailablePreflight;
    var unavailableReason = boundedDecodeReason(preflight);
    if (requireFullTitle) {
        log('GPU AV1 decode preflight unavailable (' + unavailableReason +
            '); mandatory full-title validation is using the software AV1 decoder.');
        var softwareFull = await runDecodeCommand(
            runner,
            ffmpegPath,
            softwareFullDecodeArgs(outputPath, primary.index),
            timeoutMs);
        if (softwareFull.code !== 0 || softwareFull.timedOut || softwareFull.spawnError) {
            throw decodeCommandFailure(
                'mandatory full-title software AV1 decode after grain bitstream rewrite',
                softwareFull);
        }
        return {
            schema: 1,
            mode: mode + '_software_full_gpu_unavailable_v1',
            exhaustive: true,
            sampled: false,
            hardware_accelerated: false,
            decoder: 'software-auto',
            additional_decode_commands: 2,
            gpu_preflight: {
                attempted: true,
                available: false,
                reason: unavailableReason,
            },
        };
    }
    var samples = distributedDecodeSamples(outputProbe, options.samplePolicy);
    var fallbackBudgetMs = Math.min(timeoutMs, 5 * 60 * 1000);
    var fallbackStarted = Date.now();
    log('GPU AV1 decode preflight unavailable (' + unavailableReason +
        '); canary/audit decode validation mode: ' + samples.length +
        ' distributed software samples of at most ' +
        Math.max.apply(null, samples.map(function (sample) { return sample.duration_seconds; })) +
        ' seconds each.');
    for (var sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
        var elapsedMs = Date.now() - fallbackStarted;
        var remainingMs = fallbackBudgetMs - elapsedMs;
        if (remainingMs <= 0) {
            throw new Error('bounded distributed software decode validation exceeded its ' +
                fallbackBudgetMs + 'ms total budget');
        }
        var sampleResult = await runDecodeCommand(
            runner,
            ffmpegPath,
            softwareSampleDecodeArgs(outputPath, primary.index, samples[sampleIndex]),
            Math.min(60 * 1000, remainingMs));
        if (sampleResult.code !== 0 || sampleResult.timedOut || sampleResult.spawnError) {
            throw decodeCommandFailure(
                'distributed software AV1 sample decode ' + (sampleIndex + 1) + '/' + samples.length,
                sampleResult);
        }
    }
    return {
        schema: 1,
        mode: mode + '_distributed_software_samples_gpu_unavailable_v1',
        exhaustive: false,
        sampled: true,
        hardware_accelerated: false,
        decoder: 'software-auto',
        gpu_preflight: {
            attempted: true,
            available: false,
            reason: unavailableReason,
        },
        sample_count: samples.length,
        sample_window_seconds: Math.max.apply(null, samples.map(function (sample) {
            return sample.duration_seconds;
        })),
        sampled_media_seconds: samples.reduce(function (total, sample) {
            return total + sample.duration_seconds;
        }, 0),
        samples: samples,
    };
}

function readJsonObject(filePath, description) {
    var parsed;
    try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (err) {
        throw new Error(description + ' is not valid JSON: ' + err.message);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(description + ' must contain a JSON object');
    }
    return parsed;
}

function fullArtifactFingerprint(filePath) {
    var resolved = fs.realpathSync(filePath);
    var stat = assertRegularFile(resolved, 'pipeline artifact');
    if (!(stat.size > 0)) throw new Error('pipeline artifact is empty: ' + resolved);
    return {
        scheme: 'sha256-full-v1',
        sha256: sha256File(resolved),
        size_bytes: stat.size,
        resolved_path: resolved,
    };
}

function assertFullArtifactFingerprint(recorded, filePath, description) {
    var actual = fullArtifactFingerprint(filePath);
    if (!recorded || recorded.scheme !== 'sha256-full-v1') {
        throw new Error(description + ' lacks a sha256-full-v1 fingerprint');
    }
    ['scheme', 'sha256', 'size_bytes', 'resolved_path'].forEach(function (key) {
        var left = key === 'resolved_path' ? path.resolve(String(recorded[key] || '')) : recorded[key];
        var right = key === 'resolved_path' ? path.resolve(String(actual[key] || '')) : actual[key];
        if (left !== right) throw new Error(description + ' fingerprint mismatch: ' + key);
    });
    return actual;
}

function assertSampledMediaFingerprint(recorded, filePath, description) {
    var actual = grainArtifact.sampledSourceFingerprint(filePath);
    grainArtifact.assertFingerprint(recorded, actual, description);
    return actual;
}

function energyOptionsFromInputs(inputs) {
    var options = {
        highPassSigma: finiteNumber(inputs.highPassSigma, 4.0),
        trimFraction: finiteNumber(inputs.energyTrimFraction, 0.10),
        timeoutSeconds: finiteNumber(inputs.energyTimeoutSeconds, 180),
        minimumDelta: finiteNumber(inputs.energyMinDelta, 0.05),
        gainMin: finiteNumber(inputs.energyGainMin, 0.25),
        gainMax: finiteNumber(inputs.energyGainMax, 2.00),
        maxLogMad: finiteNumber(inputs.energyMaxLogMad, 0.12),
        maxLogDeviation: finiteNumber(inputs.energyMaxLogDeviation, 0.30),
        minLumaSpacing: finiteNumber(inputs.energyMinLumaSpacing, 8.0),
        minLumaSpan: finiteNumber(inputs.energyMinLumaSpan, 24.0),
        maxLumaSpan: finiteNumber(inputs.energyMaxLumaSpan, 8.0),
        maxLogSlopePerCode: finiteNumber(inputs.energyMaxLogSlopePerCode, 0.04),
        maxGainRatio: finiteNumber(inputs.energyMaxGainRatio, 6.0),
        aggregateTolerancePct: finiteNumber(inputs.energyAggregateTolerancePct, 8.0),
        regionTolerancePct: finiteNumber(inputs.energyRegionTolerancePct, 15.0),
    };
    if (!(options.highPassSigma > 0) || !(options.timeoutSeconds > 0) ||
        !(options.trimFraction >= 0 && options.trimFraction < 0.5) ||
        !(options.minimumDelta > 0) || !(options.gainMin > 0 && options.gainMin <= options.gainMax) ||
        options.maxLogMad < 0 || options.maxLogDeviation < 0 ||
        !(options.minLumaSpacing > 0) || !(options.minLumaSpan > 0) ||
        !(options.maxLumaSpan > 0) || !(options.maxLogSlopePerCode > 0) ||
        !(options.maxGainRatio >= 1) ||
        options.aggregateTolerancePct < 0 || options.regionTolerancePct < 0) {
        throw new Error('invalid film-grain energy calibration configuration');
    }
    return options;
}

function assertPreparedEnergyPolicy(artifact, energy) {
    if (!artifact ||
        Number(artifact.residualHighPassSigma) !== Number(energy.highPassSigma) ||
        Number(artifact.residualTrimFraction) !== Number(energy.trimFraction) ||
        Number(artifact.residualMinimumEnergyDelta) !== Number(energy.minimumDelta)) {
        throw new Error('film-grain energy settings differ from fit-time residual qualification');
    }
}

function appendEnergyArgs(argv, energy) {
    argv.push(
        '--high-pass-sigma', String(energy.highPassSigma),
        '--energy-trim-fraction', String(energy.trimFraction),
        '--energy-timeout-seconds', String(energy.timeoutSeconds),
        '--energy-min-delta', String(energy.minimumDelta),
        '--energy-gain-min', String(energy.gainMin),
        '--energy-gain-max', String(energy.gainMax),
        '--energy-max-log-mad', String(energy.maxLogMad),
        '--energy-max-log-deviation', String(energy.maxLogDeviation),
        '--energy-min-luma-spacing', String(energy.minLumaSpacing),
        '--energy-min-luma-span', String(energy.minLumaSpan),
        '--energy-max-luma-span', String(energy.maxLumaSpan),
        '--energy-max-log-slope-per-code', String(energy.maxLogSlopePerCode),
        '--energy-max-gain-ratio', String(energy.maxGainRatio),
        '--energy-aggregate-tolerance-pct', String(energy.aggregateTolerancePct),
        '--energy-region-tolerance-pct', String(energy.regionTolerancePct)
    );
    return argv;
}

function pipelineDynamicHdrKind(dynamicHdrNormalization) {
    if (!dynamicHdrNormalization) return null;
    if (dynamicHdrNormalization.schema !== 1) {
        throw new Error('dynamic-HDR normalization schema is incompatible with energy operations');
    }
    if (dynamicHdrNormalization.source_type === 'dolby_vision') return 'dolby_vision';
    if (dynamicHdrNormalization.source_type === 'hdr10plus') return 'hdr10_plus';
    throw new Error('dynamic-HDR normalization has an unsupported selected source kind');
}

function appendDynamicHdrEnergyClaim(argv, dynamicHdrNormalization) {
    var kind = pipelineDynamicHdrKind(dynamicHdrNormalization);
    if (kind) argv.push('--expected-dynamic-hdr-kind', kind);
    return argv;
}

function buildCalibrateEnergyArgs(options) {
    var argv = [
        options.pipelinePath,
        '--operation', 'calibrate-energy',
        '--source', options.sourcePath,
        '--base-source', options.workingPath,
        '--grained-source', options.gain1Path,
        '--input-table', options.fitTablePath,
        '--input-manifest', options.fitManifestPath,
        '--workdir', options.jobDir,
        '--output', options.calibratedTablePath,
        '--calibration-report', options.calibrationReportPath,
        '--ffmpeg', options.ffmpegPath,
        '--ffprobe', options.ffprobePath,
        '--grav1synth', options.grav1synthPath,
    ];
    appendDynamicHdrEnergyClaim(argv, options.dynamicHdrNormalization);
    return appendEnergyArgs(argv, options.energy);
}

function buildValidateEnergyArgs(options) {
    var argv = [
        options.pipelinePath,
        '--operation', 'validate-energy',
        '--source', options.sourcePath,
        '--base-source', options.workingPath,
        '--grained-source', options.calibratedGrainPath,
        '--input-manifest', options.fitManifestPath,
        '--calibration-report', options.calibrationReportPath,
        '--energy-validation-report', options.energyValidationReportPath,
        '--workdir', options.jobDir,
        '--ffmpeg', options.ffmpegPath,
        '--ffprobe', options.ffprobePath,
        '--grav1synth', options.grav1synthPath,
    ];
    appendDynamicHdrEnergyClaim(argv, options.dynamicHdrNormalization);
    return appendEnergyArgs(argv, options.energy);
}

function assertDynamicEnergyAlignment(report, dynamicHdrNormalization, description) {
    if (!dynamicHdrNormalization) return;
    var alignment = report && report.comparison && report.comparison.source_base_alignment || {};
    var proof = alignment.dynamic_hdr_normalization || {};
    var expectedKind = pipelineDynamicHdrKind(dynamicHdrNormalization);
    var detected = proof.detected_ffprobe_kinds;
    var normalizedDetected = dynamicHdrNormalization.detected_ffprobe_kinds;
    var authorized = dynamicHdrNormalization.authorized_source_kinds;
    var allowedDetected = expectedKind === 'dolby_vision'
        ? [['dolby_vision'], ['dolby_vision', 'hdr10_plus']]
        : [[], ['hdr10_plus']];
    var allowedAuthorized = expectedKind === 'dolby_vision'
        ? [['dolby_vision'], ['dolby_vision', 'hdr10_plus']]
        : [['hdr10_plus']];
    var detectedAllowed = Array.isArray(detected) && allowedDetected.some(function (allowed) {
        return JSON.stringify(detected) === JSON.stringify(allowed);
    });
    var authorizedAllowed = Array.isArray(authorized) && allowedAuthorized.some(function (allowed) {
        return JSON.stringify(authorized) === JSON.stringify(allowed);
    });
    if (proof.validated !== true || proof.rule !== 'dynamic-hdr-source-to-static-pq-base' ||
        proof.base_dynamic_metadata_absent !== true || proof.selected_kind !== expectedKind ||
        proof.selected_kind_basis !== 'authenticated-provisional-artifact-v1' ||
        !detectedAllowed || !authorizedAllowed ||
        JSON.stringify(normalizedDetected) !== JSON.stringify(detected) ||
        detected.some(function (kind) { return authorized.indexOf(kind) === -1; }) ||
        authorized.some(function (kind) {
            return detected.indexOf(kind) === -1 && kind !== 'hdr10_plus';
        }) || JSON.stringify(proof.source_kinds) !== JSON.stringify(detected)) {
        throw new Error(description + ' lacks exact dynamic-HDR to static-PQ alignment evidence');
    }
}

function validateLumaCalibrationModel(calibration, expected, options) {
    options = options || {};
    var expectedRegions = expected && expected.calibrationRegions;
    if (!calibration || calibration.model !== LUMA_CURVE_MODEL ||
        !Array.isArray(expectedRegions) || expectedRegions.length < 3 ||
        calibration.fit_parameter_count !== 2 ||
        !Number.isInteger(calibration.support_count) || calibration.support_count < 3 ||
        !Number.isInteger(calibration.distinct_support_count) ||
        calibration.distinct_support_count < expectedRegions.length ||
        calibration.distinct_support_count > calibration.support_count ||
        calibration.control_point_count !== 4 ||
        calibration.representative_gain_basis !==
        'aggregate-paired-residual-energy-telemetry-only') {
        throw new Error('energy calibration report lacks a qualified luma-log-affine model');
    }
    var numeric = [
        calibration.representative_gain,
        calibration.aggregate_energy_gain,
        calibration.x_center,
        calibration.center_log_gain,
        calibration.log_intercept,
        calibration.log_slope_per_code,
        calibration.measured_luma_min,
        calibration.measured_luma_max,
        calibration.measured_luma_span,
        calibration.regression_log_residual_mad,
        calibration.maximum_log_residual,
        calibration.maximum_control_log_slope_per_code,
        calibration.observed_gain_ratio,
        calibration.total_source_removed_grain_energy,
        calibration.total_gain1_added_energy,
    ];
    if (numeric.some(function (value) {
        return typeof value !== 'number' || !Number.isFinite(value);
    })) {
        throw new Error('energy calibration report contains non-finite luma-curve evidence');
    }
    var representativeGain = calibration.representative_gain;
    if (representativeGain !== calibration.aggregate_energy_gain ||
        representativeGain < expected.energy.gainMin || representativeGain > expected.energy.gainMax ||
        calibration.measured_luma_min < 0 || calibration.measured_luma_max > 255 ||
        !(calibration.measured_luma_min < calibration.measured_luma_max) ||
        Math.abs(calibration.measured_luma_span -
            (calibration.measured_luma_max - calibration.measured_luma_min)) > 1e-9 ||
        calibration.measured_luma_span < expected.energy.minLumaSpan ||
        Math.abs(calibration.log_slope_per_code) > expected.energy.maxLogSlopePerCode ||
        calibration.regression_log_residual_mad < 0 ||
        calibration.regression_log_residual_mad > expected.energy.maxLogMad ||
        calibration.maximum_log_residual < 0 ||
        calibration.maximum_log_residual > expected.energy.maxLogDeviation ||
        calibration.maximum_control_log_slope_per_code < 0 ||
        calibration.maximum_control_log_slope_per_code > expected.energy.maxLogSlopePerCode ||
        calibration.observed_gain_ratio < 1 ||
        calibration.observed_gain_ratio > expected.energy.maxGainRatio ||
        calibration.total_source_removed_grain_energy <= expected.energy.minimumDelta ||
        calibration.total_gain1_added_energy <= expected.energy.minimumDelta) {
        throw new Error('energy calibration report luma-curve evidence violates configured policy');
    }

    var supports = calibration.fit_supports;
    if (!Array.isArray(supports) ||
        supports.length !== Number(calibration.distinct_support_count)) {
        throw new Error('energy calibration report fit supports are incomplete');
    }
    var previousLuma = -Infinity;
    var coveredRegionIndices = [];
    supports.forEach(function (support) {
        var meanLuma = support && support.mean_luma_code;
        var gain = support && support.gain;
        var removed = support && support.source_removed_energy;
        var added = support && support.gain1_added_energy;
        var regionIndices = support && support.region_indices;
        if (typeof meanLuma !== 'number' || !Number.isFinite(meanLuma) ||
            meanLuma <= previousLuma ||
            (Number.isFinite(previousLuma) &&
                meanLuma - previousLuma < expected.energy.minLumaSpacing) ||
            meanLuma < 0 || meanLuma > 255 ||
            typeof gain !== 'number' || !Number.isFinite(gain) ||
            gain < expected.energy.gainMin || gain > expected.energy.gainMax ||
            typeof removed !== 'number' || !Number.isFinite(removed) ||
            removed <= expected.energy.minimumDelta ||
            typeof added !== 'number' || !Number.isFinite(added) ||
            added <= expected.energy.minimumDelta ||
            !Array.isArray(regionIndices) || !regionIndices.length ||
            new Set(regionIndices).size !== regionIndices.length ||
            regionIndices.some(function (index) {
                return typeof index !== 'number' || !Number.isInteger(index) || index < 0 ||
                    index >= calibration.support_count;
            })) {
            throw new Error('energy calibration report contains an invalid luma fit support');
        }
        coveredRegionIndices = coveredRegionIndices.concat(regionIndices);
        previousLuma = meanLuma;
    });
    coveredRegionIndices.sort(function (left, right) { return left - right; });
    if (coveredRegionIndices.length !== calibration.support_count ||
        coveredRegionIndices.some(function (index, position) { return index !== position; }) ||
        supports[0].mean_luma_code !== calibration.measured_luma_min ||
        supports[supports.length - 1].mean_luma_code !== calibration.measured_luma_max) {
        throw new Error('energy calibration report fit supports do not cover the regional evidence');
    }

    var transform = calibration.transform || {};
    var points = transform.control_points;
    if (transform.id !== LUMA_CURVE_TRANSFORM_ID ||
        transform.domain !== 'av1-normalized-8-bit-reconstructed-luma-code' ||
        transform.interpolation !== 'log-linear' ||
        transform.extrapolation !== 'neutral-log-taper-to-unity-at-0-and-255' ||
        !Array.isArray(points) || points.length !== Number(calibration.control_point_count)) {
        throw new Error('energy calibration report luma transform is incompatible');
    }
    var previousX = -1;
    points.forEach(function (point, index) {
        var x = point && point[0];
        var gain = point && point[1];
        if (!Array.isArray(point) || point.length !== 2 || !Number.isInteger(x) ||
            x < 0 || x > 255 || x <= previousX || typeof gain !== 'number' ||
            !Number.isFinite(gain) || gain <= 0 ||
            (index > 0 && index < points.length - 1 &&
                (gain < expected.energy.gainMin || gain > expected.energy.gainMax))) {
            throw new Error('energy calibration report has invalid luma transform points');
        }
        previousX = x;
    });
    if (points[0][0] !== 0 || points[0][1] !== 1 ||
        points[points.length - 1][0] !== 255 ||
        points[points.length - 1][1] !== 1) {
        throw new Error('energy calibration report luma transform is not neutral at endpoints');
    }
    var channels = transform.channels;
    var chromaAttestation = transform.chroma_index_attestation;
    var yOnly = Array.isArray(channels) && channels.length === 1 && channels[0] === 'sY';
    var allChannels = Array.isArray(channels) && channels.length === 3 &&
        channels[0] === 'sY' && channels[1] === 'sCb' && channels[2] === 'sCr';
    var unmaterializedChroma = options.allowUnmaterializedChroma === true &&
        channels === undefined && chromaAttestation === undefined;
    if (!(unmaterializedChroma || (yOnly && ['av1-chroma-scaling-from-luma-v1',
        'no-independent-chroma-grain-v1'].includes(chromaAttestation)) ||
        (allChannels && chromaAttestation === 'aom-luma-equivalent-chroma-index-v1'))) {
        throw new Error('energy calibration report has invalid luma/chroma transform attestation');
    }

    var regions = calibration.regions;
    if (!Array.isArray(regions) || regions.length !== Number(calibration.support_count) ||
        !Array.isArray(expectedRegions) || expectedRegions.length !== regions.length) {
        throw new Error('energy calibration report lacks regional curve evidence');
    }
    regions.forEach(function (region, index) {
        var baseLuma = region && region.base_luma;
        var meanCode = baseLuma && baseLuma.mean_code;
        var lumaSpan = baseLuma && baseLuma.frame_mean_span_codes;
        var removed = region && region.source_removed_mean_square;
        var added = region && region.gain1_added_mean_square;
        var regionGain = region && region.region_gain;
        var predictedGain = region && region.predicted_gain;
        var residual = region && region.log_gain_residual;
        var expectedRegionGain = Math.sqrt(removed / added);
        var expectedPredictedGain = Math.exp(
            calibration.log_intercept + calibration.log_slope_per_code * meanCode);
        var expectedResidual = Math.log(expectedRegionGain) - Math.log(expectedPredictedGain);
        var candidateMatchesManifest = JSON.stringify(canonicalObject(region && region.candidate)) ===
            JSON.stringify(canonicalObject(expectedRegions[index]));
        if (typeof (region && region.index) !== 'number' ||
            !Number.isInteger(region.index) || region.index !== index || !candidateMatchesManifest ||
            typeof meanCode !== 'number' || !Number.isFinite(meanCode) ||
            meanCode < 0 || meanCode > 255 || !Number.isFinite(lumaSpan) ||
            typeof lumaSpan !== 'number' || lumaSpan < 0 ||
            lumaSpan > expected.energy.maxLumaSpan ||
            typeof removed !== 'number' || !Number.isFinite(removed) ||
            removed <= expected.energy.minimumDelta ||
            typeof added !== 'number' || !Number.isFinite(added) ||
            added <= expected.energy.minimumDelta ||
            typeof regionGain !== 'number' || !Number.isFinite(regionGain) ||
            regionGain < expected.energy.gainMin ||
            regionGain > expected.energy.gainMax || typeof predictedGain !== 'number' ||
            !Number.isFinite(predictedGain) ||
            predictedGain < expected.energy.gainMin || predictedGain > expected.energy.gainMax ||
            typeof residual !== 'number' || !Number.isFinite(residual) ||
            Math.abs(residual) > expected.energy.maxLogDeviation ||
            !reportNumbersApproximatelyEqual(region.source_removed_grain_energy, removed) ||
            !reportNumbersApproximatelyEqual(region.gain1_added_energy, added) ||
            !reportNumbersApproximatelyEqual(region.source_removed_grain_rms, Math.sqrt(removed)) ||
            !reportNumbersApproximatelyEqual(region.gain1_added_rms, Math.sqrt(added)) ||
            !reportNumbersApproximatelyEqual(regionGain, expectedRegionGain) ||
            !reportNumbersApproximatelyEqual(predictedGain, expectedPredictedGain) ||
            !reportNumbersApproximatelyEqual(residual, expectedResidual)) {
            throw new Error('energy calibration report contains invalid regional curve evidence');
        }
    });
    supports.forEach(function (support) {
        var regionIndices = support.region_indices.map(Number);
        var supportRegions = regionIndices.map(function (index) { return regions[index]; });
        var expectedLuma = supportRegions.reduce(function (sum, region) {
            return sum + Number(region.base_luma.mean_code);
        }, 0) / supportRegions.length;
        var expectedRemoved = supportRegions.reduce(function (sum, region) {
            return sum + Number(region.source_removed_mean_square);
        }, 0);
        var expectedAdded = supportRegions.reduce(function (sum, region) {
            return sum + Number(region.gain1_added_mean_square);
        }, 0);
        var expectedGain = Math.sqrt(expectedRemoved / expectedAdded);
        if (!approximatelyEqual(support.mean_luma_code, expectedLuma) ||
            !approximatelyEqual(support.source_removed_energy, expectedRemoved) ||
            !approximatelyEqual(support.gain1_added_energy, expectedAdded) ||
            !approximatelyEqual(support.gain, expectedGain)) {
            throw new Error('energy calibration report fit support is not derived from its regions');
        }
    });
    return {
        model: LUMA_CURVE_MODEL,
        representativeGain: representativeGain,
        representativeGainBasis: calibration.representative_gain_basis,
        transformId: LUMA_CURVE_TRANSFORM_ID,
        controlPointCount: points.length,
        channels: unmaterializedChroma ? [] : channels.slice(),
        chromaIndexAttestation: unmaterializedChroma ? null : chromaAttestation,
    };
}

function validateRobustGlobalCalibrationModel(calibration, expected) {
    var expectedRegions = expected && expected.calibrationRegions;
    if (!calibration || calibration.model !== ROBUST_GLOBAL_SCALAR_MODEL ||
        calibration.estimator !== 'exp-median-log-regional-amplitude-gain-v1' ||
        !Array.isArray(expectedRegions) || !Array.isArray(calibration.regions)) {
        throw new Error('energy calibration report lacks a qualified robust global model');
    }
    var supportCount = strictReportInteger(
        calibration.support_count, 'robust global calibration support count');
    if (supportCount !== expectedRegions.length || supportCount < 2 ||
        calibration.regions.length !== supportCount) {
        throw new Error('energy calibration report robust global supports are incomplete');
    }
    var logGains = [];
    calibration.regions.forEach(function (region, index) {
        var candidateMatchesManifest = JSON.stringify(canonicalObject(region && region.candidate)) ===
            JSON.stringify(canonicalObject(expectedRegions[index]));
        var regionIndex = strictReportInteger(
            region && region.index, 'robust global calibration region index');
        var baseLuma = region && region.base_luma;
        var meanCode = strictReportNumber(
            baseLuma && baseLuma.mean_code, 'robust global calibration mean luma');
        var lumaSpan = strictReportNumber(
            baseLuma && baseLuma.frame_mean_span_codes,
            'robust global calibration luma span');
        var removed = strictReportNumber(
            region && region.source_removed_mean_square,
            'robust global calibration removed energy');
        var added = strictReportNumber(
            region && region.gain1_added_mean_square,
            'robust global calibration gain-1 energy');
        if (regionIndex !== index || !candidateMatchesManifest || meanCode < 0 || meanCode > 255 ||
            lumaSpan < 0 || lumaSpan > expected.energy.maxLumaSpan ||
            removed <= expected.energy.minimumDelta || added <= expected.energy.minimumDelta) {
            throw new Error('energy calibration report contains invalid robust global regional evidence');
        }
        var gain = Math.sqrt(removed / added);
        var logGain = Math.log(gain);
        if (!Number.isFinite(gain) || gain <= 0 || !Number.isFinite(logGain) ||
            !reportNumbersApproximatelyEqual(region.source_removed_grain_energy, removed) ||
            !reportNumbersApproximatelyEqual(region.gain1_added_energy, added) ||
            !reportNumbersApproximatelyEqual(region.source_removed_grain_rms, Math.sqrt(removed)) ||
            !reportNumbersApproximatelyEqual(region.gain1_added_rms, Math.sqrt(added)) ||
            !reportNumbersApproximatelyEqual(region.region_gain, gain) ||
            !reportNumbersApproximatelyEqual(region.log_region_gain, logGain)) {
            throw new Error('energy calibration report robust global regional evidence does not reproduce');
        }
        logGains.push(logGain);
    });
    logGains.sort(function (left, right) { return left - right; });
    var middle = Math.floor(logGains.length / 2);
    var medianLogGain = logGains.length % 2 === 1
        ? logGains[middle]
        : (logGains[middle - 1] + logGains[middle]) / 2;
    var unclampedGain = Math.exp(medianLogGain);
    var gain = Math.min(expected.energy.gainMax,
        Math.max(expected.energy.gainMin, unclampedGain));
    var clamped = gain !== unclampedGain;
    if (!reportNumbersApproximatelyEqual(calibration.median_log_gain, medianLogGain) ||
        !reportNumbersApproximatelyEqual(calibration.unclamped_gain, unclampedGain) ||
        !reportNumbersApproximatelyEqual(calibration.gain, gain) ||
        calibration.clamped !== clamped) {
        throw new Error('energy calibration report robust global estimate does not reproduce');
    }
    return {
        model: ROBUST_GLOBAL_SCALAR_MODEL,
        representativeGain: gain,
        representativeGainBasis: calibration.estimator,
        transformId: null,
        controlPointCount: 0,
        channels: [],
        chromaIndexAttestation: null,
    };
}

function validateCorrectionSelection(report, expected) {
    var selection = report && report.correction_selection;
    if (!selection || selection.policy !== POSTENCODE_CORRECTION_POLICY ||
        !Array.isArray(selection.attempts) ||
        JSON.stringify(Object.keys(selection).sort()) !== JSON.stringify([
            'attempts', 'policy', 'quality_warning', 'selected_model',
        ])) {
        throw new Error('energy calibration report correction selection is invalid');
    }
    var qualityModelReasons = [
        'regional-gain-outside-safe-bounds',
        'insufficient-distinct-luma-support',
        'insufficient-luma-span',
        'no-luma-variance',
        'log-slope-outside-safe-bounds',
        'regional-log-residual-mad',
        'regional-log-residual-deviation',
        'endpoint-gain-outside-safe-bounds',
        'gain-dynamic-range-outside-safe-bounds',
        'rounded-support-endpoints-invalid',
        'rounded-control-gain-outside-safe-bounds',
        'neutral-taper-slope-outside-safe-bounds',
    ];
    var curveMaterializationReasons = [
        'independent-chroma-index-not-luma-representable',
        'luma-curve-outside-av1-scaling-range',
        'luma-curve-loses-mandatory-support',
        'luma-curve-av1-representation-error',
        'luma-curve-quantized-to-zero-grain',
    ];
    var scalarMaterializationReasons = [
        'scalar-gain-outside-av1-scaling-range',
        'scalar-gain-quantized-to-zero-grain',
    ];
    function validateRejection(attempt, model, status, reasons) {
        if (!attempt || attempt.model !== model || attempt.status !== status ||
            !reasons.includes(attempt.reason_code) || typeof attempt.message !== 'string' ||
            attempt.message.length === 0 ||
            JSON.stringify(Object.keys(attempt).sort()) !== JSON.stringify([
                'message', 'model', 'reason_code', 'status',
            ])) {
            throw new Error('energy calibration report fallback attempts are invalid');
        }
        return attempt;
    }
    function exactSelected(attempt, model) {
        return JSON.stringify(attempt) === JSON.stringify({ model: model, status: 'selected' });
    }

    var selectedModel = selection.selected_model;
    if (selectedModel === LUMA_CURVE_MODEL) {
        if (report.disposition !== 'calibrated' || selection.quality_warning !== false ||
            selection.attempts.length !== 1 ||
            !exactSelected(selection.attempts[0], LUMA_CURVE_MODEL)) {
            throw new Error('energy calibration report curve selection disposition is invalid');
        }
        return {
            descriptor: validateLumaCalibrationModel(report.calibration, expected),
            qualityWarning: null,
        };
    }
    if (selectedModel === ROBUST_GLOBAL_SCALAR_MODEL) {
        if (report.disposition !== 'calibrated_with_quality_model_fallback' ||
            selection.quality_warning !== true || selection.attempts.length !== 2 ||
            !exactSelected(selection.attempts[1], ROBUST_GLOBAL_SCALAR_MODEL)) {
            throw new Error('energy calibration report scalar fallback disposition is invalid');
        }
        var qualityRejection = validateRejection(selection.attempts[0], LUMA_CURVE_MODEL,
            'rejected-quality-model-mismatch', qualityModelReasons);
        return {
            descriptor: validateRobustGlobalCalibrationModel(report.calibration, expected),
            qualityWarning: {
                code: 'postencode-calibration-quality-model-fallback',
                advisory: true,
                reason_code: qualityRejection.reason_code,
                message: qualityRejection.message,
            },
        };
    }
    if (selectedModel !== FIT_TABLE_IDENTITY_MODEL ||
        report.disposition !== 'calibrated_with_quality_model_fallback' ||
        selection.quality_warning !== true ||
        (selection.attempts.length !== 2 && selection.attempts.length !== 3) ||
        !exactSelected(selection.attempts[selection.attempts.length - 1],
            FIT_TABLE_IDENTITY_MODEL)) {
        throw new Error('energy calibration report identity fallback disposition is invalid');
    }
    var materializationRejection;
    var rejectedDescriptor;
    if (selection.attempts.length === 2) {
        materializationRejection = validateRejection(selection.attempts[0], LUMA_CURVE_MODEL,
            'rejected-quality-materialization-mismatch', curveMaterializationReasons);
        rejectedDescriptor = validateLumaCalibrationModel(
            report.calibration && report.calibration.rejected_calibration, expected, {
                allowUnmaterializedChroma: materializationRejection.reason_code ===
                    'independent-chroma-index-not-luma-representable',
            });
    } else {
        validateRejection(selection.attempts[0], LUMA_CURVE_MODEL,
            'rejected-quality-model-mismatch', qualityModelReasons);
        materializationRejection = validateRejection(selection.attempts[1],
            ROBUST_GLOBAL_SCALAR_MODEL, 'rejected-quality-materialization-mismatch',
            scalarMaterializationReasons);
        rejectedDescriptor = validateRobustGlobalCalibrationModel(
            report.calibration && report.calibration.rejected_calibration, expected);
    }
    var identity = report.calibration || {};
    var identityKeys = Object.keys(identity).sort();
    if (identity.model !== FIT_TABLE_IDENTITY_MODEL || identity.gain !== 1 ||
        identity.basis !== 'authenticated-fit-table-gain1-preservation-v1' ||
        JSON.stringify(identityKeys) !== JSON.stringify([
            'basis', 'gain', 'model', 'regions', 'rejected_calibration',
        ]) || JSON.stringify(canonicalObject(identity.regions)) !==
            JSON.stringify(canonicalObject(identity.rejected_calibration &&
                identity.rejected_calibration.regions))) {
        throw new Error('energy calibration report fit-table identity evidence is invalid');
    }
    var rejectedAttempts = selection.attempts.slice(0, -1);
    return {
        descriptor: {
            model: FIT_TABLE_IDENTITY_MODEL,
            representativeGain: 1,
            representativeGainBasis: identity.basis,
            transformId: null,
            controlPointCount: 0,
            channels: [],
            chromaIndexAttestation: null,
            rejectedModel: rejectedDescriptor.model,
        },
        qualityWarning: {
            code: 'postencode-calibration-fit-table-identity-fallback',
            advisory: true,
            failures: rejectedAttempts.map(function (attempt) {
                return attempt.reason_code + ': ' + attempt.message;
            }),
            reason_code: materializationRejection.reason_code,
            message: materializationRejection.message,
        },
    };
}

function validateCalibrationReport(report, expected) {
    if (!report || report.schema !== CALIBRATION_REPORT_SCHEMA || report.operation !== 'calibrate-energy' ||
        report.purpose !== 'post-encode-content-adaptive-film-grain-energy-calibration') {
        throw new Error('energy calibration report schema/operation is incompatible');
    }
    assertFullArtifactFingerprint(report.fit_manifest, expected.fitManifestPath, 'calibration fit manifest');
    assertFullArtifactFingerprint(report.fit_table, expected.fitTablePath, 'calibration fit table');
    assertSampledMediaFingerprint(report.source_fingerprint, expected.sourcePath, 'calibration original source');
    assertSampledMediaFingerprint(report.ungrained_final_av1_fingerprint, expected.workingPath, 'calibration ungrained final AV1');
    assertSampledMediaFingerprint(report.gain1_grained_final_av1_fingerprint, expected.gain1Path, 'calibration gain-1 AV1');
    assertFullArtifactFingerprint(report.calibrated_table, expected.calibratedTablePath, 'calibrated grain table');
    if (!report.comparison || report.comparison.mode !== 'original-vs-ungrained-and-gain1-final-av1' ||
        report.comparison.calibration_regions !== 'reserved-curve-calibration-regions' ||
        report.comparison.final_validation_regions_distinct !== true) {
        throw new Error('energy calibration report comparison mode is invalid');
    }
    var measurement = report.measurement || {};
    var fitSettings = expected.fitSettings || {};
    if (measurement.metric !== 'paired-high-pass-residual-energy-v2' ||
        measurement.amplitude !== 'sqrt(mean_square)' ||
        measurement.target_energy !== 'highpass(original-source-minus-canonical-hqdn3d-source)' ||
        measurement.synthesized_energy !== 'highpass(grain-enabled-decode-minus-grain-disabled-decode)' ||
        measurement.baseline_subtraction !== 'none-paired-residual-formed-before-highpass' ||
        measurement.codec_error_excluded_from_grain_target !== true ||
        measurement.denoise !== grainArtifact.DENOISE_FILTER ||
        measurement.luma_coordinate !== 'native-grain-off-av1-frame-mean-code' ||
        typeof measurement.clip_seconds !== 'number' ||
        measurement.clip_seconds !== Number(fitSettings.clip_seconds) ||
        typeof measurement.crop_size !== 'number' ||
        !Number.isInteger(measurement.crop_size) ||
        measurement.crop_size !== Number(fitSettings.crop_size) ||
        typeof measurement.preroll_seconds !== 'number' ||
        measurement.preroll_seconds !== Number(fitSettings.preroll)) {
        throw new Error('energy calibration report measurement basis does not match the prepared canonical fit');
    }
    grainArtifact.validateDenoiserAttestation(
        report.comparison && report.comparison.denoiser_attestation
    );
    var safety = report.safety || {};
    var settingPairs = [
        ['measurement sigma', measurement.sigma, expected.energy.highPassSigma],
        ['measurement trim fraction', measurement.trim_fraction, expected.energy.trimFraction],
        ['minimum gain', safety.gain_min, expected.energy.gainMin],
        ['maximum gain', safety.gain_max, expected.energy.gainMax],
        ['minimum energy delta', safety.minimum_energy_delta, expected.energy.minimumDelta],
        ['maximum log MAD', safety.maximum_log_mad, expected.energy.maxLogMad],
        ['maximum log deviation', safety.maximum_log_deviation, expected.energy.maxLogDeviation],
        ['minimum luma spacing', safety.minimum_luma_spacing_codes, expected.energy.minLumaSpacing],
        ['minimum luma span', safety.minimum_luma_span_codes, expected.energy.minLumaSpan],
        ['minimum distinct luma supports', safety.minimum_distinct_luma_supports,
            expected.calibrationRegions.length],
        ['maximum regional luma span', measurement.maximum_luma_span_codes, expected.energy.maxLumaSpan],
        ['maximum log slope per code', safety.maximum_log_slope_per_code, expected.energy.maxLogSlopePerCode],
        ['maximum gain ratio', safety.maximum_gain_ratio, expected.energy.maxGainRatio],
    ];
    settingPairs.forEach(function (entry) {
        if (typeof entry[1] !== 'number' || !Number.isFinite(entry[1]) ||
            entry[1] !== Number(entry[2])) {
            throw new Error('energy calibration report ' + entry[0] + ' does not match configured policy');
        }
    });
    var selected = validateCorrectionSelection(report, expected);
    if (selected.descriptor.model === FIT_TABLE_IDENTITY_MODEL &&
        !tablesHaveIdenticalPayload(expected.calibratedTablePath, expected.fitTablePath)) {
        throw new Error('fit-table identity fallback did not preserve the authenticated gain-1 table');
    }
    assertDynamicEnergyAlignment(report, expected.dynamicHdrNormalization, 'energy calibration report');
    selected.descriptor.disposition = report.disposition;
    selected.descriptor.qualityWarning = selected.qualityWarning;
    return selected.descriptor;
}

function parseEnergyFailureDisplay(value) {
    if (typeof value !== 'string') return null;
    var region = /^region (\d+) amplitude error (\d+(?:\.\d+)?)% exceeds (\d+(?:\.\d+)?)%$/.exec(value);
    if (region) {
        return {
            code: 'region-amplitude-error',
            index: Number(region[1]),
            errorPct: Number(region[2]),
            thresholdPct: Number(region[3]),
        };
    }
    var aggregate = /^(aggregate|band-balanced) amplitude error (\d+(?:\.\d+)?)% exceeds (\d+(?:\.\d+)?)%$/.exec(value);
    if (!aggregate) return null;
    return {
        code: aggregate[1] === 'aggregate'
            ? 'aggregate-amplitude-error'
            : 'band-balanced-amplitude-error',
        index: null,
        errorPct: Number(aggregate[2]),
        thresholdPct: Number(aggregate[3]),
    };
}

function displayedEnergyNumberMatches(recorded, expected) {
    return Number.isFinite(recorded) && Number.isFinite(expected) &&
        Math.abs(recorded - expected) <= 0.005 +
            1e-12 * Math.max(1, Math.abs(recorded), Math.abs(expected));
}

function energyFailureDisplayMatches(recorded, expected) {
    var parsed = parseEnergyFailureDisplay(recorded);
    return parsed !== null && parsed.code === expected.code && parsed.index === expected.index &&
        displayedEnergyNumberMatches(parsed.errorPct, expected.errorPct) &&
        displayedEnergyNumberMatches(parsed.thresholdPct, expected.thresholdPct);
}

function validateEnergyValidationReport(report, expected) {
    if (!report || report.schema !== ENERGY_VALIDATION_REPORT_SCHEMA || report.operation !== 'validate-energy' ||
        report.purpose !== 'final-decoded-film-grain-energy-validation' || report.validated !== true ||
        report.accepted !== true || !report.evaluation ||
        (report.evaluation.validated !== true && report.evaluation.validated !== false)) {
        throw new Error('final energy validation report did not authenticate the calibrated AV1');
    }
    assertFullArtifactFingerprint(report.fit_manifest, expected.fitManifestPath, 'validation fit manifest');
    assertFullArtifactFingerprint(report.calibration_report, expected.calibrationReportPath, 'validation calibration report');
    assertSampledMediaFingerprint(report.source_fingerprint, expected.sourcePath, 'validation original source');
    assertSampledMediaFingerprint(report.ungrained_final_av1_fingerprint, expected.workingPath, 'validation ungrained final AV1');
    assertSampledMediaFingerprint(report.calibrated_final_av1_fingerprint, expected.calibratedGrainPath, 'validation calibrated AV1');
    if (!report.comparison || report.comparison.mode !== 'original-vs-ungrained-and-calibrated-final-av1') {
        throw new Error('final energy validation report comparison mode is invalid');
    }
    grainArtifact.validateDenoiserAttestation(report.comparison.denoiser_attestation);
    var tolerances = report.tolerances || {};
    var tolerancePairs = [
        ['aggregate amplitude error', tolerances.aggregate_amplitude_error_pct, expected.energy.aggregateTolerancePct],
        ['per-region amplitude error', tolerances.per_region_amplitude_error_pct, expected.energy.regionTolerancePct],
        ['minimum energy delta', tolerances.minimum_energy_delta, expected.energy.minimumDelta],
    ];
    tolerancePairs.forEach(function (entry) {
        if (typeof entry[1] !== 'number' || !Number.isFinite(entry[1]) ||
            entry[1] !== Number(entry[2])) {
            throw new Error('final energy validation report ' + entry[0] + ' tolerance does not match configured policy');
        }
    });
    var expectedRegions = expected && expected.heldoutRegions;
    var evaluated = report.evaluation || {};
    var regions = evaluated.regions;
    if (!Array.isArray(expectedRegions) || !Array.isArray(regions) ||
        regions.length !== expectedRegions.length || !Array.isArray(evaluated.failures) ||
        regions.length < 2) {
        throw new Error('final energy validation report lacks complete held-out regional evidence');
    }
    var totalRemoved = 0;
    var totalAdded = 0;
    var logRatios = [];
    var expectedFailures = [];
    regions.forEach(function (region, index) {
        var removed = strictReportNumber(region && region.source_removed_mean_square,
            'final energy validation removed energy');
        var added = strictReportNumber(region && region.final_added_mean_square,
            'final energy validation added energy');
        var ratio = strictReportNumber(region && region.amplitude_ratio,
            'final energy validation amplitude ratio');
        var errorPct = strictReportNumber(region && region.amplitude_error_pct,
            'final energy validation amplitude error');
        var expectedRatio = Math.sqrt(added / removed);
        var expectedError = Math.abs(expectedRatio - 1) * 100;
        var candidateMatchesManifest = JSON.stringify(canonicalObject(region && region.candidate)) ===
            JSON.stringify(canonicalObject(expectedRegions[index]));
        if (typeof (region && region.index) !== 'number' ||
            !Number.isInteger(region.index) || region.index !== index || !candidateMatchesManifest ||
            !Number.isFinite(removed) || removed <= expected.energy.minimumDelta ||
            !Number.isFinite(added) || added <= expected.energy.minimumDelta ||
            !approximatelyEqual(ratio, expectedRatio) || !approximatelyEqual(errorPct, expectedError) ||
            !approximatelyEqual(region && region.source_removed_grain_energy, removed) ||
            !approximatelyEqual(region && region.final_added_energy, added)) {
            throw new Error('final energy validation report contains invalid held-out regional evidence');
        }
        if (errorPct > expected.energy.regionTolerancePct) {
            expectedFailures.push({
                code: 'region-amplitude-error',
                index: index,
                errorPct: errorPct,
                thresholdPct: expected.energy.regionTolerancePct,
            });
        }
        totalRemoved += removed;
        totalAdded += added;
        logRatios.push(Math.log(expectedRatio));
    });
    var aggregateRatio = Math.sqrt(totalAdded / totalRemoved);
    var aggregateError = Math.abs(aggregateRatio - 1) * 100;
    var bandBalancedRatio = Math.exp(logRatios.reduce(function (sum, value) {
        return sum + value;
    }, 0) / logRatios.length);
    var bandBalancedError = Math.abs(bandBalancedRatio - 1) * 100;
    if (aggregateError > expected.energy.aggregateTolerancePct) {
        expectedFailures.push({
            code: 'aggregate-amplitude-error',
            index: null,
            errorPct: aggregateError,
            thresholdPct: expected.energy.aggregateTolerancePct,
        });
    }
    if (bandBalancedError > expected.energy.aggregateTolerancePct) {
        expectedFailures.push({
            code: 'band-balanced-amplitude-error',
            index: null,
            errorPct: bandBalancedError,
            thresholdPct: expected.energy.aggregateTolerancePct,
        });
    }
    if (!reportNumbersApproximatelyEqual(evaluated.aggregate_amplitude_ratio, aggregateRatio) ||
        !reportNumbersApproximatelyEqual(evaluated.aggregate_amplitude_error_pct, aggregateError) ||
        !reportNumbersApproximatelyEqual(evaluated.band_balanced_amplitude_ratio, bandBalancedRatio) ||
        !reportNumbersApproximatelyEqual(
            evaluated.band_balanced_amplitude_error_pct, bandBalancedError)) {
        throw new Error('final energy validation report aggregate evidence is invalid');
    }
    if (evaluated.failures.length !== expectedFailures.length ||
        expectedFailures.some(function (failure, index) {
            return !energyFailureDisplayMatches(evaluated.failures[index], failure);
        }) ||
        evaluated.validated !== (expectedFailures.length === 0)) {
        throw new Error('final energy validation report quality disposition does not reproduce');
    }
    var qualityThresholdsMet = expectedFailures.length === 0;
    var expectedDisposition = qualityThresholdsMet ? 'accepted' : 'accepted_with_quality_warning';
    var qualityWarning = report.quality_warning;
    var warningIsValid = qualityThresholdsMet
        ? qualityWarning === null
        : qualityWarning && qualityWarning.code === 'heldout-energy-tolerance-mismatch' &&
            qualityWarning.advisory === true && Array.isArray(qualityWarning.failures) &&
            JSON.stringify(Object.keys(qualityWarning).sort()) ===
                JSON.stringify(['advisory', 'code', 'failures']) &&
            JSON.stringify(qualityWarning.failures) === JSON.stringify(evaluated.failures);
    if (report.quality_thresholds_met !== qualityThresholdsMet ||
        report.disposition !== expectedDisposition ||
        !warningIsValid) {
        throw new Error('final energy validation report advisory status does not reproduce');
    }
    assertDynamicEnergyAlignment(report, expected.dynamicHdrNormalization, 'final energy validation report');
    return {
        accepted: true,
        qualityThresholdsMet: qualityThresholdsMet,
        disposition: expectedDisposition,
        qualityWarning: qualityWarning,
        failures: evaluated.failures.slice(),
        structuredFailures: expectedFailures.map(function (failure) {
            return Object.assign({}, failure);
        }),
    };
}

async function plugin(args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    args.variables = args.variables || {};

    var mode = String(args.inputs.mode || 'disabled');
    var sourcePath = getOriginalPath(args);
    var workingPath = getWorkingPath(args);
    var originalObj = keepOriginalObject(args);
    args.jobLog('=== Synthesize Film Grain (' + mode + ') ===');

    if (mode === 'disabled') {
        args.jobLog('Film-grain rollout is disabled; bypassing to the normal validated transcode.');
        return makeResult(args, 3, args.inputFileObj, 'disabled', { grainSynthesisReason: 'rollout_disabled' });
    }
    if (mode !== 'canary' && mode !== 'active') {
        return makeResult(args, 4, originalObj, 'failed', { grainSynthesisReason: 'invalid_rollout_mode' });
    }
    var analysisStatus = String(args.variables.grainAnalysisStatus || '');
    if (analysisStatus === 'disabled' || analysisStatus === 'ineligible') {
        args.jobLog('Prepared grain analysis is unavailable by policy (' + analysisStatus + '); using normal AV1 output.');
        return makeResult(args, 3, args.inputFileObj, 'ineligible', {
            grainSynthesisReason: args.variables.grainAnalysisReason || 'grain_analysis_' + analysisStatus,
        });
    }
    if (analysisStatus === grainArtifact.ANALYSIS_UNAVAILABLE_STATUS) {
        try {
            grainArtifact.validateAnalysisUnavailableDisposition(args.variables);
        } catch (unavailableError) {
            args.jobLog('Film-grain synthesis failed closed: analysis-unavailable handoff is invalid: ' +
                unavailableError.message);
            return makeResult(args, 4, originalObj, 'failed', {
                grainSynthesisReason: 'invalid_analysis_unavailable_handoff: ' + unavailableError.message,
            });
        }
        args.jobLog('Film-grain analysis was technically unavailable; keeping the completed untouched-source/tf0 AV1 without synthetic grain.');
        return makeResult(args, 3, args.inputFileObj, grainArtifact.ANALYSIS_UNAVAILABLE_STATUS, {
            grainSynthesisReason: args.variables.grainAnalysisReason || 'grain_analysis_unavailable',
        });
    }
    if (analysisStatus === 'no_grain') {
        try {
            var noGrainArtifact = args.variables.grainAnalysisNoGrainArtifact;
            grainArtifact.validateNoGrainArtifact(noGrainArtifact);
            if (noGrainArtifact.reasonCode === grainArtifact.NO_GRAIN_REASON_CODE) {
                args.jobLog('Authenticated exact no-grain outcome: keeping the untouched-source AV1 without synthetic film grain.');
            } else if (noGrainArtifact.reasonCode ===
                grainArtifact.NO_GRAIN_NO_NOTICEABLE_SOURCE_NOISE_REASON_CODE) {
                args.jobLog('Authenticated native source-noise bypass: sampled source noise is below noticeable thresholds; keeping the untouched-source AV1 without synthetic film grain.');
            } else if (noGrainArtifact.reasonCode ===
                grainArtifact.NO_GRAIN_INSUFFICIENT_FLAT_SUPPORT_REASON_CODE) {
                args.jobLog('Authenticated native source-noise bypass: flat-region support is insufficient for a trustworthy grain estimate; keeping the untouched-source AV1 without synthetic film grain.');
            } else if (noGrainArtifact.reasonCode ===
                grainArtifact.NO_GRAIN_STATIC_MODEL_UNREPRESENTABLE_REASON_CODE) {
                args.jobLog('Authenticated static-model grain bypass: the title needs changing grain parameters; keeping the untouched-source AV1.');
            } else {
                args.jobLog('Authenticated advisory grain bypass: source-removed energy support was insufficient; keeping the untouched-source AV1 without synthetic film grain.');
            }
            return makeResult(args, 3, args.inputFileObj, 'no_grain', {
                grainSynthesisReason: noGrainArtifact.reasonCode,
            });
        } catch (noGrainError) {
            args.jobLog('Film-grain synthesis failed closed: no-grain outcome authentication failed: ' + noGrainError.message);
            return makeResult(args, 4, originalObj, 'failed', {
                grainSynthesisReason: 'invalid_no_grain_outcome: ' + noGrainError.message,
            });
        }
    }
    if (analysisStatus !== 'prepared') {
        args.jobLog('Film-grain synthesis failed closed: required prepared analysis status is missing.');
        return makeResult(args, 4, originalObj, 'failed', { grainSynthesisReason: 'prepared_grain_analysis_required' });
    }
    var sourcePathRegex;
    try {
        sourcePathRegex = requireSourceAllowlist(mode, args.inputs.sourcePathRegex);
    } catch (allowlistErr) {
        args.jobLog('Film-grain rollout configuration failed closed: ' + allowlistErr.message);
        return makeResult(args, 4, originalObj, 'failed', { grainSynthesisReason: 'source_path_allowlist_required' });
    }
    if (!sourcePath || !workingPath) {
        return makeResult(args, 4, originalObj, 'failed', { grainSynthesisReason: 'missing_source_or_working_path' });
    }
    try {
        var canonicalSourcePath = grainArtifact.resolveAllowlistedSourcePath(
            sourcePath,
            sourcePathRegex,
            String(args.inputs.sourcePathRegexFlags === undefined ? 'i' : args.inputs.sourcePathRegexFlags));
        if (!canonicalSourcePath) {
            args.jobLog('Original path is outside the mounted grain source scope; bypassing grain: ' + sourcePath);
            return makeResult(args, 3, args.inputFileObj, 'ineligible', { grainSynthesisReason: 'source_path_not_allowlisted' });
        }
        sourcePath = canonicalSourcePath;
    } catch (regexErr) {
        args.jobLog('Film-grain source-scope safety error: ' + regexErr.message);
        return makeResult(args, 4, originalObj, 'failed', {
            grainSynthesisReason: 'invalid_or_unsafe_source_scope',
        });
    }

    var pipelinePath = String(args.inputs.pipelinePath);
    var pythonPath = String(args.inputs.pythonPath || 'python3');
    var grav1synthPath = String(args.inputs.grav1synthPath);
    var ffmpegPath = String(args.ffmpegPath || '/usr/local/bin/tdarr-ffmpeg');
    var ffprobePath = String(args.ffprobePath || 'ffprobe');
    var workRoot;
    var jobDir = null;
    var activeOutput = null;
    var promotedReviewPaths = [];
    var result = null;
    var sourceMkvIdentify = null;
    var qualityWarnings = [];
    args.variables.grainSynthesisQualityWarnings = [];
    var pipelineTimeoutMs = clamp(finiteNumber(args.inputs.pipelineTimeoutMinutes, 45), 5, 240) * 60 * 1000;
    var validationTimeoutMs = clamp(finiteNumber(args.inputs.validationTimeoutMinutes, 240), 10, 720) * 60 * 1000;

    try {
        var roots = grainArtifact.resolveJobOwnedRoot(args, args.inputs.workRoot, 'grain-synthesis');
        workRoot = roots.workRoot;
        assertRegularFile(sourcePath, 'original library source');
        assertRegularFile(workingPath, 'completed working transcode');
        assertRegularFile(pipelinePath, 'validated grain pipeline');
        assertExecutableFile(grav1synthPath, 'grav1synth');
        await runChecked(pythonPath, ['--version'], { timeoutMs: 10000 });
        await runChecked(grav1synthPath, ['--version'], { timeoutMs: 10000 });
        await runChecked(ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: 10000 });
        await runChecked(ffprobePath, ['-hide_banner', '-version'], { timeoutMs: 10000 });

        var sourceProbe = await probeMedia(ffprobePath, sourcePath, validationTimeoutMs);
        var workingProbe = await probeMedia(ffprobePath, workingPath, validationTimeoutMs);
        var deferredGrainBase = validateDeferredGrainBaseContract(
            args, sourcePath, workingPath, workingProbe);
        var sourceProfile = colorProfile(sourceProbe);
        var workingProfile = colorProfile(workingProbe);
        var dynamicHdrNormalization = null;
        if (!sourceProfile.supported) {
            var inferredSdrProfile = normalizeUntaggedSdrProfile(sourceProbe, workingProfile);
            if (inferredSdrProfile) sourceProfile = inferredSdrProfile;
        }
        var hasDynamicConversionClaim = Boolean(args.variables && args.variables.vmafDynamicHdrConversion);
        if (!sourceProfile.supported || hasDynamicConversionClaim) {
            var normalizedDynamicProfile = normalizeAuthorizedDynamicHdrProfile(
                sourceProbe, workingProfile, workingProbe, args.variables
            );
            if (normalizedDynamicProfile) {
                sourceProfile = normalizedDynamicProfile;
                dynamicHdrNormalization = normalizedDynamicProfile.dynamic_hdr_normalization;
                args.jobLog('Authorized dynamic HDR source normalized to its verified static HDR10 working base: ' +
                    dynamicHdrNormalization.conversion + '.');
            } else if (hasDynamicConversionClaim) {
                sourceProfile = {
                    supported: false,
                    reason: 'dynamic HDR conversion claim failed exact source/provenance validation',
                };
            }
        }
        if (!sourceProfile.supported) {
            args.jobLog('Film-grain source is ineligible; bypassing grain: ' + sourceProfile.reason);
            return makeResult(args, 3, args.inputFileObj, 'ineligible', { grainSynthesisReason: sourceProfile.reason });
        }
        if (!workingProfile.supported) {
            args.jobLog('Film-grain working encode is ineligible; bypassing grain: ' + workingProfile.reason);
            return makeResult(args, 3, args.inputFileObj, 'ineligible', { grainSynthesisReason: workingProfile.reason });
        }
        if (!isMatroska(workingProbe, workingPath)) {
            args.jobLog('Film-grain production remux is restricted to Matroska .mkv bases; bypassing grain.');
            return makeResult(args, 3, args.inputFileObj, 'ineligible', { grainSynthesisReason: 'working_container_not_matroska' });
        }
        var useMkvmergeRemux = isMatroska(sourceProbe, sourcePath);
        if (deferredGrainBase && !useMkvmergeRemux) {
            throw new Error('deferred Matroska ancillary remux was requested for a non-Matroska source');
        }
        if (useMkvmergeRemux) {
            // Check before the expensive calibration/apply/validation stages. Any non-zero
            // MKVToolNix status is a technical failure; no FFmpeg fallback is allowed for a
            // Matroska source because it could silently corrupt content-compressed subtitles.
            await runChecked('mkvmerge', ['--version'], { timeoutMs: 10000 });
            sourceMkvIdentify = await identifyMatroskaWithMkvmerge(sourcePath, validationTimeoutMs);
            assertUidFieldsLossless(sourceMkvIdentify, 'source Matroska identify');
            assertRequiredMkvEntityUids(sourceMkvIdentify, 'source Matroska identify');
            assertMatroskaSourceVideoTopology(sourceMkvIdentify);
        }
        if (sourceProfile.id !== workingProfile.id) throw new Error('original and working encode color profiles do not match');
        if (!profileAllowed(sourceProfile.id, String(args.inputs.eligibleProfiles || 'sdrAndPq'))) {
            args.jobLog(sourceProfile.label + ' is outside the configured rollout profile allowlist.');
            return makeResult(args, 3, args.inputFileObj, 'ineligible', { grainSynthesisReason: 'color_profile_not_allowlisted' });
        }
        if (Math.abs(finiteNumber(args.inputs.scalingGain, 1.0) - 1.0) > 1e-12) {
            throw new Error('static scalingGain overrides are forbidden; adaptive calibrate-energy owns per-title gain');
        }
        var workingPrimary = primaryVideo(workingProbe);
        if (!workingPrimary || lower(workingPrimary.codec_name) !== 'av1') {
            args.jobLog('Completed working video is not AV1; keeping original.');
            return makeResult(args, 3, args.inputFileObj, 'ineligible', { grainSynthesisReason: 'working_video_not_av1' });
        }
        var tolerance = durationTolerance(sourceProbe, args.inputs.durationToleranceSeconds);
        var sourceWorkingDuration = assertDurationParity(sourceProbe, workingProbe, tolerance, 'original/completed-encode parity');

        var fitTablePath = String(args.variables.grainAnalysisTablePath || '');
        var fitManifestPath = String(args.variables.grainAnalysisManifestPath || '');
        if (!fitTablePath || !fitManifestPath || !args.variables.grainAnalysisArtifact) {
            throw new Error('prepared grain analysis artifact paths are missing');
        }
        grainArtifact.assertJobOwnedPath(args, fitTablePath, 'prepared grain table');
        grainArtifact.assertJobOwnedPath(args, fitManifestPath, 'prepared grain manifest');
        var prepared = grainArtifact.validatePreparedArtifact(args.variables.grainAnalysisArtifact, {
            sourcePath: sourcePath,
            tablePath: fitTablePath,
            manifestPath: fitManifestPath,
            pipelinePath: pipelinePath,
        });
        var representabilityWarning = prepared.checked.sourceResidualRepresentability &&
            prepared.checked.sourceResidualRepresentability.quality_warning;
        recordQualityWarning(args, qualityWarnings, 'source-representability',
            representabilityWarning);
        if (prepared.artifact.mediaProfile !== sourceProfile.id) {
            throw new Error('prepared grain analysis color profile does not match the final source classification');
        }
        var energy = energyOptionsFromInputs(args.inputs);
        assertPreparedEnergyPolicy(prepared.artifact, energy);
        var currentProvisionalDynamic = grainArtifact.provisionalDynamicHdrEvidence(
            primaryVideo(sourceProbe), args.variables
        );
        if (dynamicHdrNormalization) {
            var preparedDynamic = prepared.artifact.provisionalDynamicHdr;
            if (!preparedDynamic || !currentProvisionalDynamic ||
                JSON.stringify(preparedDynamic) !== JSON.stringify(currentProvisionalDynamic) ||
                JSON.stringify(dynamicHdrNormalization.authorized_source_kinds) !==
                    JSON.stringify(currentProvisionalDynamic.sourceKinds) ||
                JSON.stringify(dynamicHdrNormalization.detected_ffprobe_kinds) !==
                    JSON.stringify(currentProvisionalDynamic.ffprobeKinds)) {
                throw new Error('prepared grain analysis lacks matching provisional dynamic-HDR authorization');
            }
            dynamicHdrNormalization.manifest_evidence_validated = true;
            dynamicHdrNormalization.manifest_evidence = {
                source_video: prepared.manifest.source_video,
                media_profile: prepared.manifest.media_profile,
                comparison: prepared.manifest.comparison,
            };
            args.variables.grainSynthesisDynamicHdrNormalization = dynamicHdrNormalization;
        } else if (prepared.artifact.provisionalDynamicHdr) {
            throw new Error('prepared grain analysis expected dynamic-HDR normalization but the completed AV1 lacks it');
        }
        grainArtifact.registerTemporaryFile(args.variables, args, fitTablePath);
        grainArtifact.registerTemporaryFile(args.variables, args, fitManifestPath);

        jobDir = fs.mkdtempSync(path.join(workRoot, safeSlug(path.basename(sourcePath, path.extname(sourcePath))) + '-' + stableId(sourcePath) + '-'));
        grainArtifact.assertJobOwnedPath(args, jobDir, 'grain synthesis job directory');
        args.variables.grainSynthesisJobDir = jobDir;
        args.variables.grainSynthesisWorkRoot = workRoot;
        var preInspectPath = path.join(jobDir, 'working-existing-grain.txt');
        var gain1GrainPath = path.join(jobDir, 'grain-gain1-video-only.mkv');
        var calibratedTablePath = path.join(jobDir, 'grain-table-calibrated.txt');
        var calibrationReportPath = path.join(jobDir, 'grain-energy-calibration.json');
        var calibratedGrainPath = path.join(jobDir, 'grain-calibrated-video-only.mkv');
        var energyValidationReportPath = path.join(jobDir, 'grain-energy-validation.json');
        var finalPartialPath = path.join(jobDir, 'grain-output.partial.mkv');
        var validatedOutputPath = path.join(jobDir, 'grain-output.mkv');
        var postInspectPath = path.join(jobDir, 'grain-output-inspected.txt');

        var existingGrain = await inspectGrain(grav1synthPath, workingPath, preInspectPath, validationTimeoutMs);
        if (existingGrain.present) {
            args.jobLog('Working AV1 already contains film-grain headers; refusing to stack or replace them.');
            throw ineligibleError('working_video_already_has_grain');
        }

        args.jobLog('Applying prepared gain-1 grain table to the completed AV1.');
        await runChecked(grav1synthPath, [
            'apply', '-y', '-g', fitTablePath, '-o', gain1GrainPath, workingPath,
        ], { timeoutMs: validationTimeoutMs, maxOutputBytes: 8 * 1024 * 1024 });
        assertRegularFile(gain1GrainPath, 'gain-1 grain-applied AV1');

        var calibrateArgs = buildCalibrateEnergyArgs({
            pipelinePath: pipelinePath,
            sourcePath: sourcePath,
            workingPath: workingPath,
            gain1Path: gain1GrainPath,
            fitTablePath: fitTablePath,
            fitManifestPath: fitManifestPath,
            jobDir: jobDir,
            calibratedTablePath: calibratedTablePath,
            calibrationReportPath: calibrationReportPath,
            ffmpegPath: ffmpegPath,
            ffprobePath: ffprobePath,
            grav1synthPath: grav1synthPath,
            dynamicHdrNormalization: dynamicHdrNormalization,
            energy: energy,
        });
        args.jobLog('Calibrating decoded grain energy on reserved curve-calibration regions.');
        if (args.updateWorker) args.updateWorker({ CLIType: pythonPath, preset: calibrateArgs.join(' ') });
        var calibrationResult = await runChecked(pythonPath, calibrateArgs, {
            timeoutMs: pipelineTimeoutMs,
            maxOutputBytes: 16 * 1024 * 1024,
        });
        var calibrationTail = commandTail({ stderr: calibrationResult.stdout || calibrationResult.stderr });
        if (calibrationTail) args.jobLog('Energy calibration tail:\n' + calibrationTail);
        assertRegularFile(calibratedTablePath, 'calibrated grain table');
        assertRegularFile(calibrationReportPath, 'energy calibration report');
        grainArtifact.registerTemporaryFile(args.variables, args, calibratedTablePath);
        grainArtifact.registerTemporaryFile(args.variables, args, calibrationReportPath);
        var calibrationReport = readJsonObject(calibrationReportPath, 'energy calibration report');
        var adaptiveCalibration = validateCalibrationReport(calibrationReport, {
            fitManifestPath: fitManifestPath,
            fitTablePath: fitTablePath,
            sourcePath: sourcePath,
            workingPath: workingPath,
            gain1Path: gain1GrainPath,
            calibratedTablePath: calibratedTablePath,
            energy: energy,
            fitSettings: prepared.manifest.settings,
            calibrationRegions: prepared.manifest.calibration.regions,
            dynamicHdrNormalization: dynamicHdrNormalization,
        });
        var adaptiveGain = adaptiveCalibration.representativeGain;
        args.variables.grainSynthesisAdaptiveGain = adaptiveGain;
        args.variables.grainSynthesisCalibrationModel = adaptiveCalibration.model;
        args.variables.grainSynthesisCalibrationSummary = adaptiveCalibration;
        recordQualityWarning(args, qualityWarnings, 'postencode-calibration',
            adaptiveCalibration.qualityWarning);

        var calibratedTableMatchesGain1 = tablesHaveIdenticalPayload(calibratedTablePath, fitTablePath);
        if (adaptiveCalibration.model === FIT_TABLE_IDENTITY_MODEL &&
            !calibratedTableMatchesGain1) {
            throw new Error('fit-table identity fallback did not preserve the authenticated gain-1 table');
        }
        if (calibratedTableMatchesGain1) {
            calibratedGrainPath = gain1GrainPath;
            args.jobLog('Calibrated table is byte-identical to gain-1; reusing the gain-1 application.');
        } else {
            args.jobLog('Applying calibrated ' + adaptiveCalibration.model +
                ' grain table (representative gain ' + adaptiveGain.toFixed(6) + ').');
            await runChecked(grav1synthPath, [
                'apply', '-y', '-g', calibratedTablePath, '-o', calibratedGrainPath, workingPath,
            ], { timeoutMs: validationTimeoutMs, maxOutputBytes: 8 * 1024 * 1024 });
            assertRegularFile(calibratedGrainPath, 'calibrated grain-applied AV1');
        }

        args.jobLog('Validating completed AV1 -> grain-applied AV1 technical parity.');
        var calibratedGrainProbe = await probeMedia(
            ffprobePath, calibratedGrainPath, validationTimeoutMs);
        var calibratedGrainPrimary = primaryVideo(calibratedGrainProbe);
        if (!calibratedGrainPrimary) {
            throw new Error('completed AV1 -> grain-applied AV1: missing grain-applied primary video stream');
        }
        assertVideoParity(
            workingPrimary, calibratedGrainPrimary, 'completed AV1 -> grain-applied AV1');
        var workingGrainedDuration = assertDurationParity(
            workingProbe, calibratedGrainProbe, tolerance, 'completed AV1 -> grain-applied AV1');

        var validateEnergyArgs = buildValidateEnergyArgs({
            pipelinePath: pipelinePath,
            sourcePath: sourcePath,
            workingPath: workingPath,
            calibratedGrainPath: calibratedGrainPath,
            fitManifestPath: fitManifestPath,
            calibrationReportPath: calibrationReportPath,
            energyValidationReportPath: energyValidationReportPath,
            jobDir: jobDir,
            ffmpegPath: ffmpegPath,
            ffprobePath: ffprobePath,
            grav1synthPath: grav1synthPath,
            dynamicHdrNormalization: dynamicHdrNormalization,
            energy: energy,
        });
        args.jobLog('Validating final decoded grain energy against held-out source regions.');
        if (args.updateWorker) args.updateWorker({ CLIType: pythonPath, preset: validateEnergyArgs.join(' ') });
        var energyValidationResult = await runChecked(pythonPath, validateEnergyArgs, {
            timeoutMs: validationTimeoutMs,
            maxOutputBytes: 16 * 1024 * 1024,
        });
        var energyTail = commandTail({ stderr: energyValidationResult.stdout || energyValidationResult.stderr });
        if (energyTail) args.jobLog('Energy validation tail:\n' + energyTail);
        assertRegularFile(energyValidationReportPath, 'final energy validation report');
        grainArtifact.registerTemporaryFile(args.variables, args, energyValidationReportPath);
        var energyValidationReport = readJsonObject(energyValidationReportPath, 'final energy validation report');
        var energyValidation = validateEnergyValidationReport(energyValidationReport, {
            fitManifestPath: fitManifestPath,
            calibrationReportPath: calibrationReportPath,
            sourcePath: sourcePath,
            workingPath: workingPath,
            calibratedGrainPath: calibratedGrainPath,
            heldoutRegions: prepared.manifest.heldout.regions,
            dynamicHdrNormalization: dynamicHdrNormalization,
            energy: energy,
        });
        recordQualityWarning(args, qualityWarnings, 'heldout-energy-validation',
            energyValidation.qualityWarning);

        var remuxMethod;
        var grainedMkvIdentify = null;
        var primaryVideoSemanticOverlay = null;
        var primaryVideoCustomTagPath = null;
        if (useMkvmergeRemux) {
            remuxMethod = 'mkvmerge-source-no-video-v1';
            grainedMkvIdentify = await identifyMatroskaWithMkvmerge(
                calibratedGrainPath, validationTimeoutMs);
            primaryVideoSemanticOverlay = buildMkvPrimaryVideoSemanticOverlay(
                sourceMkvIdentify, grainedMkvIdentify);
            if (Object.keys(primaryVideoSemanticOverlay.custom_tags).length) {
                primaryVideoCustomTagPath = path.join(jobDir, 'source-primary-video-tags.xml');
                writeTextAtomic(primaryVideoCustomTagPath,
                    buildMkvmergeTrackTagsXml(primaryVideoSemanticOverlay.custom_tags));
                grainArtifact.registerTemporaryFile(
                    args.variables, args, primaryVideoCustomTagPath);
            }
            args.jobLog('Remuxing grain video with original Matroska ancillary payloads via MKVToolNix (FFmpeg bypass).');
            await runChecked('mkvmerge',
                buildMkvmergeRemuxArgs(
                    calibratedGrainPath, sourcePath, finalPartialPath, sourceProbe, sourceMkvIdentify,
                    primaryVideoSemanticOverlay, primaryVideoCustomTagPath), {
                    timeoutMs: validationTimeoutMs,
                    maxOutputBytes: 8 * 1024 * 1024,
                });
        } else {
            remuxMethod = 'ffmpeg-scoped-stream-copy-v1';
            args.jobLog('Remuxing non-Matroska source ancillary payloads with scoped FFmpeg stream copy.');
            await runChecked(ffmpegPath, buildRemuxArgs(
                calibratedGrainPath, sourcePath, finalPartialPath, sourceProbe), {
                    timeoutMs: validationTimeoutMs,
                    maxOutputBytes: 8 * 1024 * 1024,
                });
        }
        assertRegularFile(finalPartialPath, 'fully remuxed grain output');

        var matroskaInventory = null;
        if (useMkvmergeRemux) {
            var outputMkvIdentify = await identifyMatroskaWithMkvmerge(
                finalPartialPath, validationTimeoutMs);
            matroskaInventory = verifyMkvmergeGrainInventory(
                sourceMkvIdentify, grainedMkvIdentify, outputMkvIdentify);
            if (deferredGrainBase) args.variables.vmafAncillaryRemuxDeferredResolved = true;
        }

        var outputProbe = await probeMedia(ffprobePath, finalPartialPath, validationTimeoutMs);
        assertStreamParity(sourceProbe, workingProbe, outputProbe, {
            referenceProbe: calibratedGrainProbe,
            stageDescription: 'grain-applied AV1 -> final remux',
        });
        assertChapterParity(sourceProbe, outputProbe, Math.min(tolerance, 0.05));
        var grainedOutputDuration = assertDurationParity(
            calibratedGrainProbe, outputProbe, tolerance, 'grain-applied AV1 -> final remux');
        var workingOutputDuration = assertDurationParity(workingProbe, outputProbe, tolerance, 'completed-encode/grain-output parity');
        var sourceOutputDuration = assertDurationParity(sourceProbe, outputProbe, tolerance, 'original/grain-output parity');
        var payloadParity = await validatePayloadParity(
            ffmpegPath, sourcePath, finalPartialPath, sourceProbe, outputProbe, validationTimeoutMs);

        var postGrain = await inspectGrain(grav1synthPath, finalPartialPath, postInspectPath, validationTimeoutMs);
        if (!postGrain.present) throw new Error('grav1synth inspect found no semantic grain in the final remux');
        var decodeValidation = await validateFinalAv1Decode(
            ffmpegPath, finalPartialPath, outputProbe, {
                mode: mode,
                timeoutMs: validationTimeoutMs,
                gpuLease: createGpuDecodeLeaseController(args),
                log: function (message) { args.jobLog(message); },
            });
        args.variables.grainSynthesisDecodeValidationMode = decodeValidation.mode;
        args.jobLog('Final AV1 decode validation completed: ' + decodeValidation.mode + '.');

        var baseBytes = fs.statSync(workingPath).size;
        var outputBytes = fs.statSync(finalPartialPath).size;
        var maxSizeRatio = clamp(finiteNumber(args.inputs.maxOutputSizeRatioPct, 101), 1, 500);
        var outputSizeAssessment = assessOutputSizeRatio(baseBytes, outputBytes, maxSizeRatio);
        var sizeRatioPct = outputSizeAssessment.ratioPct;
        recordQualityWarning(args, qualityWarnings, 'output-size-efficiency',
            outputSizeAssessment.qualityWarning);
        // Fail closed against the ORIGINAL library file before this output can
        // replace it. Dropping the grain keeps the already-validated, already
        // size-checked AV1 working output, so the size benefit is preserved.
        var grainOriginalRejection = assessGrainOutputAgainstOriginal(
            sourcePath, finalPartialPath, grainOriginalRatioCap(args));
        if (grainOriginalRejection) {
            args.jobLog('FILM GRAIN REJECTED ON SIZE: ' + grainOriginalRejection.reason
                + '; discarding the grained output and continuing with the non-grained AV1 output.');
            try { fs.unlinkSync(finalPartialPath); } catch (_unlinkErr) {}
            return makeResult(args, 3, args.inputFileObj, 'size_rejected', {
                grainSynthesisReason: 'grain_output_not_smaller_than_original',
                grainSynthesisOriginalRatioPct: grainOriginalRejection.ratioPct,
                grainSynthesisOriginalRatioCapPct: grainOriginalRejection.capPct,
            });
        }
        fs.renameSync(finalPartialPath, validatedOutputPath);

        var qualityDisposition = qualityWarnings.length
            ? 'completed_with_quality_warning'
            : 'quality_thresholds_met';
        args.variables.grainSynthesisQualityDisposition = qualityDisposition;

        var validationReport = {
            schema: 1,
            mode: mode,
            source: sourcePath,
            base_source: workingPath,
            output: validatedOutputPath,
            color_profile: sourceProfile.id,
            color_profile_label: sourceProfile.label,
            dynamic_hdr_normalization: dynamicHdrNormalization,
            source_working_duration: sourceWorkingDuration,
            working_grained_duration: workingGrainedDuration,
            grained_output_duration: grainedOutputDuration,
            working_output_duration: workingOutputDuration,
            source_output_duration: sourceOutputDuration,
            stream_count: outputProbe.streams.length,
            chapter_count: (outputProbe.chapters || []).length,
            payload_parity: payloadParity,
            ancillary_remux_method: remuxMethod,
            matroska_inventory: matroskaInventory,
            semantic_grain_inspected: true,
            decode_validation: decodeValidation,
            full_decode_validated: decodeValidation.exhaustive === true,
            sampled_decode_validated: decodeValidation.sampled === true,
            output_size_bytes: outputBytes,
            output_size_ratio_pct_of_base: sizeRatioPct,
            prepared_analysis: summarizeManifest(prepared.manifest),
            adaptive_gain: adaptiveGain,
            adaptive_gain_semantics: 'deprecated-representative-telemetry-only',
            calibration_model: adaptiveCalibration.model,
            calibration_summary: adaptiveCalibration,
            energy_calibration: calibrationReport,
            energy_validation: energyValidationReport,
            quality_disposition: qualityDisposition,
            quality_warnings: qualityWarnings,
            completed_at: new Date().toISOString(),
        };

        if (mode === 'canary') {
            var reviewDir = path.resolve(String(args.inputs.reviewDir || '/grain-pilot-review'));
            if (reviewDir === path.resolve('/')) throw new Error('canary review directory cannot be filesystem root');
            fs.mkdirSync(reviewDir, { recursive: true });
            var stem = reviewStem(sourcePath);
            var reviewVideo = path.join(reviewDir, stem + '.mkv');
            var reviewTable = path.join(reviewDir, stem + '.grain.txt');
            var reviewFitTable = path.join(reviewDir, stem + '.fit-grain.txt');
            var reviewManifest = path.join(reviewDir, stem + '.pipeline.json');
            var reviewCalibration = path.join(reviewDir, stem + '.calibration.json');
            var reviewEnergyValidation = path.join(reviewDir, stem + '.energy-validation.json');
            var reviewValidation = path.join(reviewDir, stem + '.validation.json');
            atomicCopy(validatedOutputPath, reviewVideo); promotedReviewPaths.push(reviewVideo);
            atomicCopy(calibratedTablePath, reviewTable); promotedReviewPaths.push(reviewTable);
            atomicCopy(fitTablePath, reviewFitTable); promotedReviewPaths.push(reviewFitTable);
            atomicCopy(fitManifestPath, reviewManifest); promotedReviewPaths.push(reviewManifest);
            atomicCopy(calibrationReportPath, reviewCalibration); promotedReviewPaths.push(reviewCalibration);
            atomicCopy(energyValidationReportPath, reviewEnergyValidation); promotedReviewPaths.push(reviewEnergyValidation);
            validationReport.output = reviewVideo;
            writeJsonAtomic(reviewValidation, validationReport); promotedReviewPaths.push(reviewValidation);
            grainArtifact.removeOwnedJobDir(args, jobDir);
            jobDir = null;
            activeOutput = null;
            args.jobLog((qualityWarnings.length ? 'CANARY STRUCTURALLY VALIDATED WITH QUALITY WARNING: '
                : 'CANARY VALIDATED: ') + 'review artifact preserved at ' + reviewVideo +
                '; library original will not be replaced.');
            result = makeResult(args, 2, originalObj, 'canary_validated', {
                grainSynthesisReason: null,
                grainSynthesisReviewOutput: reviewVideo,
                grainSynthesisReviewTable: reviewTable,
                grainSynthesisReviewFitTable: reviewFitTable,
                grainSynthesisReviewManifest: reviewManifest,
                grainSynthesisReviewCalibrationReport: reviewCalibration,
                grainSynthesisReviewEnergyValidationReport: reviewEnergyValidation,
                grainSynthesisValidationReport: reviewValidation,
                grainSynthesisValidation: validationReport,
            });
        } else {
            // Replace Original File derives the final library name from the working
            // basename. Preserve the source stem here; a random job-directory name
            // would otherwise leak into the media library on successful replacement.
            activeOutput = activeReplacementPath(workRoot, sourcePath);
            fs.renameSync(validatedOutputPath, activeOutput);
            grainArtifact.removeOwnedJobDir(args, jobDir);
            jobDir = null;
            args.variables.vmafTemporaryFiles = Array.isArray(args.variables.vmafTemporaryFiles)
                ? args.variables.vmafTemporaryFiles : [];
            if (args.variables.vmafTemporaryFiles.indexOf(activeOutput) === -1) {
                args.variables.vmafTemporaryFiles.push(activeOutput);
            }
            validationReport.output = activeOutput;
            args.jobLog((qualityWarnings.length ? 'ACTIVE STRUCTURALLY VALIDATED WITH QUALITY WARNING: '
                : 'ACTIVE VALIDATED: ') + 'grain output passed structural and integrity gates at ' + activeOutput);
            result = makeResult(args, 1, { _id: activeOutput }, 'active_validated', {
                grainSynthesisReason: null,
                grainSynthesisOutputPath: activeOutput,
                grainSynthesisValidation: validationReport,
            });
        }
    } catch (err) {
        args.jobLog((err.grainIneligible ? 'FILM GRAIN INELIGIBLE: ' : 'FILM GRAIN FAILED CLOSED: ') + err.message);
        if (jobDir) {
            try { grainArtifact.removeOwnedJobDir(args, jobDir); } catch (cleanupErr) {
                args.jobLog('Grain scratch cleanup also failed: ' + cleanupErr.message);
            }
            jobDir = null;
        }
        if (activeOutput) {
            try { fs.unlinkSync(activeOutput); } catch (_) {}
            activeOutput = null;
        }
        rollbackPromotedReviewArtifacts(args, promotedReviewPaths).forEach(function (failure) {
            args.jobLog('Grain review rollback also failed: ' + failure);
        });
        result = err.grainIneligible
            ? makeResult(args, 3, args.inputFileObj, 'ineligible', {
                grainSynthesisReason: err.message,
                grainSynthesisOutputPath: null,
            })
            : makeResult(args, 4, originalObj, 'failed', {
                grainSynthesisReason: err.message,
                grainSynthesisOutputPath: null,
            });
    }

    return result;
}
async function runOutputCommandTwice(args, label, executable, argv, outputPath, options) {
    var firstError = null;
    for (var attempt = 1; attempt <= 2; attempt += 1) {
        try { fs.unlinkSync(outputPath); } catch (unlinkError) {
            if (!unlinkError || unlinkError.code !== 'ENOENT') throw unlinkError;
        }
        try {
            await runChecked(executable, argv, options);
            assertRegularFile(outputPath, label + ' output');
            return attempt;
        } catch (error) {
            if (attempt === 1) {
                firstError = error;
                args.jobLog(label + ' failed once; retrying from the existing completed AV1 checkpoint: ' +
                    error.message);
                continue;
            }
            throw new Error(label + ' failed twice without re-transcoding: first=' +
                firstError.message + '; second=' + error.message);
        }
    }
    throw new Error(label + ' retry loop ended unexpectedly');
}

function directFallbackResult(args, originalObj, reason) {
    var diagnostic = String(reason && reason.message || reason || 'film grain synthesis failed')
        .replace(/\0/g, '').trim().slice(0, grainArtifact.ANALYSIS_DIAGNOSTIC_MAX_CHARS);
    var analysisJobDir = String(args.variables.grainAnalysisJobDir || '');
    if (analysisJobDir) {
        try {
            grainArtifact.removeOwnedJobDir(args, analysisJobDir);
        } catch (cleanupError) {
            args.jobLog('Prepared grain artifact cleanup before original-source fallback failed: ' +
                cleanupError.message);
        }
    }
    grainArtifact.ANALYSIS_UNAVAILABLE_FORBIDDEN_VARIABLES.forEach(function (key) {
        delete args.variables[key];
    });
    args.variables.grainAnalysisStatus = grainArtifact.ANALYSIS_UNAVAILABLE_STATUS;
    args.variables.grainAnalysisReason = 'postencode_fgs_failed; original-source_reencode_required: ' +
        diagnostic;
    if (args.variables.grainAnalysisReason.length >
        grainArtifact.ANALYSIS_DIAGNOSTIC_MAX_CHARS) {
        args.variables.grainAnalysisReason = args.variables.grainAnalysisReason.slice(
            0, grainArtifact.ANALYSIS_DIAGNOSTIC_MAX_CHARS);
    }
    args.variables.grainAnalysisCompletedAt = new Date().toISOString();
    args.variables.grainSynthesisFallbackToOriginalRequired = true;
    grainArtifact.validateAnalysisUnavailableDisposition(args.variables);
    args.jobLog('FILM GRAIN FALLBACK: the table/apply/mux path could not complete after its bounded retry. ' +
        'Routing the untouched original back through AV1 with temporal filtering disabled; the job is not skipped.');
    return makeResult(args, 4, originalObj, 'fallback_reencode_required', {
        grainSynthesisReason: diagnostic,
        grainSynthesisOutputPath: null,
    });
}

function discardRejectedDirectGrainJob(args, jobDir) {
    if (!jobDir) {
        throw new Error('direct grain size rejection has no owned job directory');
    }
    grainArtifact.removeOwnedJobDir(args, jobDir);
    return null;
}

function reserveProductionReviewSlot(reviewDir) {
    fs.mkdirSync(reviewDir, { recursive: true });
    for (var slot = 1; slot <= 2; slot += 1) {
        var slotDir = path.join(reviewDir, 'production-review-' + String(slot).padStart(2, '0'));
        try {
            fs.mkdirSync(slotDir);
            return { slot: slot, directory: slotDir };
        } catch (error) {
            if (!error || error.code !== 'EEXIST') throw error;
        }
    }
    return null;
}

function preserveProductionReview(args, reviewDir, sourcePath, outputPath, tablePath,
    manifestPath, validationReport) {
    var resolvedReview = path.resolve(String(reviewDir || '/grain-pilot-review'));
    if (resolvedReview === path.parse(resolvedReview).root) {
        throw new Error('production review directory cannot be a filesystem root');
    }
    var reservation = reserveProductionReviewSlot(resolvedReview);
    if (!reservation) return null;
    var sourceExtension = path.extname(sourcePath) || '.source';
    var sourceCopy = path.join(reservation.directory, 'source' + sourceExtension);
    var outputCopy = path.join(reservation.directory, 'output.mkv');
    var tableCopy = path.join(reservation.directory, 'grain-table.txt');
    var manifestCopy = path.join(reservation.directory, 'grain-manifest.json');
    var reportCopy = path.join(reservation.directory, 'validation.json');
    try {
        args.jobLog('Preserving production review slot ' + reservation.slot +
            ' (full source and output) for visual comparison.');
        atomicCopy(sourcePath, sourceCopy);
        atomicCopy(outputPath, outputCopy);
        atomicCopy(tablePath, tableCopy);
        atomicCopy(manifestPath, manifestCopy);
        var report = Object.assign({}, validationReport, {
            review_source: sourceCopy,
            review_output: outputCopy,
        });
        writeJsonAtomic(reportCopy, report);
        return {
            slot: reservation.slot,
            directory: reservation.directory,
            source: sourceCopy,
            output: outputCopy,
            table: tableCopy,
            manifest: manifestCopy,
            validation: reportCopy,
        };
    } catch (error) {
        try { fs.rmSync(reservation.directory, { recursive: true, force: true }); } catch (_) {}
        args.jobLog('Production review preservation was unavailable and will not block the transcode: ' +
            error.message);
        return {
            slot: reservation.slot,
            directory: null,
            preserved: false,
            reason: error.message,
        };
    }
}

async function directPlugin(args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    args.variables = args.variables || {};

    var mode = String(args.inputs.mode || 'disabled');
    var sourcePath = getOriginalPath(args);
    var workingPath = getWorkingPath(args);
    var originalObj = keepOriginalObject(args);
    args.jobLog('=== Synthesize Film Grain Direct (' + mode + ') ===');

    if (mode === 'disabled') {
        return makeResult(args, 3, args.inputFileObj, 'disabled', {
            grainSynthesisReason: 'rollout_disabled',
        });
    }
    if (mode !== 'canary' && mode !== 'active') {
        return makeResult(args, 4, originalObj, 'failed', {
            grainSynthesisReason: 'invalid_rollout_mode',
        });
    }

    var analysisStatus = String(args.variables.grainAnalysisStatus || '');
    if (analysisStatus === grainArtifact.ANALYSIS_UNAVAILABLE_STATUS) {
        try {
            grainArtifact.validateAnalysisUnavailableDisposition(args.variables);
        } catch (error) {
            return directFallbackResult(args, originalObj,
                'invalid analysis-unavailable handoff: ' + error.message);
        }
        args.jobLog('Film-grain analysis was unavailable; keeping the completed original-source/tf0 AV1.');
        return makeResult(args, 3, args.inputFileObj, analysisStatus, {
            grainSynthesisReason: args.variables.grainAnalysisReason,
        });
    }
    if (analysisStatus === 'disabled' || analysisStatus === 'ineligible') {
        return makeResult(args, 3, args.inputFileObj, analysisStatus, {
            grainSynthesisReason: args.variables.grainAnalysisReason ||
                'grain_analysis_' + analysisStatus,
        });
    }
    if (analysisStatus === 'no_grain') {
        try {
            var authenticatedBypass = grainArtifact.validateNoGrainArtifact(
                args.variables.grainAnalysisNoGrainArtifact);
            args.jobLog('Authenticated direct grav1synth bypass (' +
                authenticatedBypass.artifact.reasonCode +
                '); keeping the completed original-source/tf0 AV1.');
            return makeResult(args, 3, args.inputFileObj, 'no_grain', {
                grainSynthesisReason: authenticatedBypass.artifact.reasonCode,
            });
        } catch (error) {
            return directFallbackResult(args, originalObj,
                'invalid authenticated no-grain disposition: ' + error.message);
        }
    }
    if (analysisStatus !== 'prepared') {
        return directFallbackResult(args, originalObj, 'prepared grain analysis is missing');
    }

    var jobDir = null;
    var activeOutput = null;
    var promotedReviewPaths = [];
    var result = null;
    try {
        var sourceScope = requireSourceAllowlist(mode, args.inputs.sourcePathRegex);
        if (!sourcePath || !workingPath) throw new Error('missing source or completed AV1 path');
        var canonicalSourcePath = grainArtifact.resolveAllowlistedSourcePath(
            sourcePath,
            sourceScope,
            String(args.inputs.sourcePathRegexFlags === undefined
                ? 'i' : args.inputs.sourcePathRegexFlags));
        if (!canonicalSourcePath) {
            throw new Error('source is outside the mounted /media scope');
        }
        sourcePath = canonicalSourcePath;

        var pipelinePath = String(args.inputs.pipelinePath);
        var grav1synthPath = String(args.inputs.grav1synthPath);
        var ffmpegPath = String(args.ffmpegPath || '/usr/local/bin/tdarr-ffmpeg');
        var ffprobePath = String(args.ffprobePath || 'ffprobe');
        var validationTimeoutMs = clamp(
            finiteNumber(args.inputs.validationTimeoutMinutes, 240), 10, 720) * 60 * 1000;
        var roots = grainArtifact.resolveJobOwnedRoot(
            args, args.inputs.workRoot, 'grain-synthesis');
        var workRoot = roots.workRoot;
        assertRegularFile(sourcePath, 'original library source');
        assertRegularFile(workingPath, 'completed working transcode');
        assertRegularFile(pipelinePath, 'validated direct grain pipeline');
        assertExecutableFile(grav1synthPath, 'grav1synth');
        await runChecked(grav1synthPath, ['--version'], { timeoutMs: 10000 });
        await runChecked(ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: 10000 });
        await runChecked(ffprobePath, ['-hide_banner', '-version'], { timeoutMs: 10000 });

        var sourceProbe = await probeMedia(ffprobePath, sourcePath, validationTimeoutMs);
        var workingProbe = await probeMedia(ffprobePath, workingPath, validationTimeoutMs);
        var deferredGrainBase = validateDeferredGrainBaseContract(
            args, sourcePath, workingPath, workingProbe);
        var sourceProfile = colorProfile(sourceProbe);
        var workingProfile = colorProfile(workingProbe);
        var dynamicHdrNormalization = null;
        if (!sourceProfile.supported) {
            var inferredSdrProfile = normalizeUntaggedSdrProfile(sourceProbe, workingProfile);
            if (inferredSdrProfile) sourceProfile = inferredSdrProfile;
        }
        if (!sourceProfile.supported ||
            Boolean(args.variables && args.variables.vmafDynamicHdrConversion)) {
            var normalizedDynamicProfile = normalizeAuthorizedDynamicHdrProfile(
                sourceProbe, workingProfile, workingProbe, args.variables);
            if (normalizedDynamicProfile) {
                sourceProfile = normalizedDynamicProfile;
                dynamicHdrNormalization = normalizedDynamicProfile.dynamic_hdr_normalization;
            }
        }
        if (!sourceProfile.supported || !workingProfile.supported ||
            sourceProfile.id !== workingProfile.id) {
            throw new Error('source/completed AV1 color profiles are unsupported or do not match');
        }
        if (!profileAllowed(sourceProfile.id,
            String(args.inputs.eligibleProfiles || 'sdrAndPq'))) {
            throw new Error('source color profile is outside configured production scope');
        }
        if (!isMatroska(workingProbe, workingPath)) {
            throw new Error('completed AV1 base is not Matroska');
        }
        var workingPrimary = primaryVideo(workingProbe);
        if (!workingPrimary || lower(workingPrimary.codec_name) !== 'av1') {
            throw new Error('completed working video is not AV1');
        }
        var tolerance = durationTolerance(sourceProbe, args.inputs.durationToleranceSeconds);
        var sourceWorkingDuration = assertDurationParity(
            sourceProbe, workingProbe, tolerance, 'original/completed-encode parity');

        var fitTablePath = String(args.variables.grainAnalysisTablePath || '');
        var fitManifestPath = String(args.variables.grainAnalysisManifestPath || '');
        if (!fitTablePath || !fitManifestPath || !args.variables.grainAnalysisArtifact) {
            throw new Error('prepared direct grain artifact paths are missing');
        }
        grainArtifact.assertJobOwnedPath(args, fitTablePath, 'prepared direct grain table');
        grainArtifact.assertJobOwnedPath(args, fitManifestPath, 'prepared direct grain manifest');
        var prepared = grainArtifact.validatePreparedArtifact(
            args.variables.grainAnalysisArtifact, {
                sourcePath: sourcePath,
                tablePath: fitTablePath,
                manifestPath: fitManifestPath,
                pipelinePath: pipelinePath,
            });
        if (Number(prepared.artifact.schema) !== grainArtifact.DIRECT_ARTIFACT_SCHEMA ||
            prepared.artifact.tableApplication !== 'single-direct-unmodified-apply') {
            throw new Error('legacy fitted/calibrated grain artifacts are not production eligible');
        }
        if (prepared.artifact.mediaProfile !== sourceProfile.id) {
            throw new Error('prepared direct grain profile does not match the source');
        }
        var currentProvisionalDynamic = grainArtifact.provisionalDynamicHdrEvidence(
            primaryVideo(sourceProbe), args.variables);
        if (dynamicHdrNormalization) {
            if (!prepared.artifact.provisionalDynamicHdr || !currentProvisionalDynamic ||
                JSON.stringify(prepared.artifact.provisionalDynamicHdr) !==
                    JSON.stringify(currentProvisionalDynamic)) {
                throw new Error('prepared direct grain artifact lacks matching dynamic-HDR authorization');
            }
            dynamicHdrNormalization.manifest_evidence_validated = true;
        } else if (prepared.artifact.provisionalDynamicHdr) {
            throw new Error('prepared direct grain artifact expected dynamic-HDR normalization');
        }
        grainArtifact.registerTemporaryFile(args.variables, args, fitTablePath);
        grainArtifact.registerTemporaryFile(args.variables, args, fitManifestPath);

        var useMkvmergeRemux = isMatroska(sourceProbe, sourcePath);
        if (deferredGrainBase && !useMkvmergeRemux) {
            throw new Error('deferred Matroska ancillary remux has a non-Matroska source');
        }
        var sourceMkvIdentify = null;
        if (useMkvmergeRemux) {
            await runChecked('mkvmerge', ['--version'], { timeoutMs: 10000 });
            sourceMkvIdentify = await identifyMatroskaWithMkvmerge(
                sourcePath, validationTimeoutMs);
            assertUidFieldsLossless(sourceMkvIdentify, 'source Matroska identify');
            assertRequiredMkvEntityUids(sourceMkvIdentify, 'source Matroska identify');
            assertMatroskaSourceVideoTopology(sourceMkvIdentify);
        }

        jobDir = fs.mkdtempSync(path.join(
            workRoot,
            safeSlug(path.basename(sourcePath, path.extname(sourcePath))) + '-' +
                stableId(sourcePath) + '-'));
        grainArtifact.assertJobOwnedPath(args, jobDir, 'direct grain synthesis job directory');
        args.variables.grainSynthesisJobDir = jobDir;
        args.variables.grainSynthesisWorkRoot = workRoot;
        var preInspectPath = path.join(jobDir, 'working-existing-grain.txt');
        var grainedVideoPath = path.join(jobDir, 'grain-applied-video-only.mkv');
        var finalPartialPath = path.join(jobDir, 'grain-output.partial.mkv');
        var validatedOutputPath = path.join(jobDir, 'grain-output.mkv');
        var postInspectPath = path.join(jobDir, 'grain-output-inspected.txt');

        var existingGrain = await inspectGrain(
            grav1synthPath, workingPath, preInspectPath, validationTimeoutMs);
        if (existingGrain.present) {
            throw new Error('completed AV1 already contains film-grain headers');
        }

        args.jobLog('Applying the authenticated grav1synth table once, byte-for-byte and without gain fitting.');
        var applyAttempts = await runOutputCommandTwice(
            args,
            'direct grav1synth apply',
            grav1synthPath,
            ['apply', '-y', '-g', fitTablePath, '-o', grainedVideoPath, workingPath],
            grainedVideoPath,
            { timeoutMs: validationTimeoutMs, maxOutputBytes: 8 * 1024 * 1024 });
        var grainedProbe = await probeMedia(ffprobePath, grainedVideoPath, validationTimeoutMs);
        var grainedPrimary = primaryVideo(grainedProbe);
        if (!grainedPrimary) throw new Error('grain-applied AV1 lacks a primary video stream');
        assertVideoParity(workingPrimary, grainedPrimary,
            'completed AV1 -> direct grain-applied AV1');
        var workingGrainedDuration = assertDurationParity(
            workingProbe, grainedProbe, tolerance,
            'completed AV1 -> direct grain-applied AV1');

        var remuxMethod;
        var grainedMkvIdentify = null;
        var primaryVideoSemanticOverlay = null;
        var primaryVideoCustomTagPath = null;
        var remuxExecutable;
        var remuxArgv;
        if (useMkvmergeRemux) {
            remuxMethod = 'mkvmerge-source-no-video-v1';
            grainedMkvIdentify = await identifyMatroskaWithMkvmerge(
                grainedVideoPath, validationTimeoutMs);
            primaryVideoSemanticOverlay = buildMkvPrimaryVideoSemanticOverlay(
                sourceMkvIdentify, grainedMkvIdentify);
            if (Object.keys(primaryVideoSemanticOverlay.custom_tags).length) {
                primaryVideoCustomTagPath = path.join(jobDir, 'source-primary-video-tags.xml');
                writeTextAtomic(primaryVideoCustomTagPath,
                    buildMkvmergeTrackTagsXml(primaryVideoSemanticOverlay.custom_tags));
            }
            remuxExecutable = 'mkvmerge';
            remuxArgv = buildMkvmergeRemuxArgs(
                grainedVideoPath, sourcePath, finalPartialPath, sourceProbe,
                sourceMkvIdentify, primaryVideoSemanticOverlay, primaryVideoCustomTagPath);
        } else {
            remuxMethod = 'ffmpeg-scoped-stream-copy-v1';
            remuxExecutable = ffmpegPath;
            remuxArgv = buildRemuxArgs(
                grainedVideoPath, sourcePath, finalPartialPath, sourceProbe);
        }
        args.jobLog('Performing the one required final ancillary mux.');
        var remuxAttempts = await runOutputCommandTwice(
            args, 'final ancillary mux', remuxExecutable, remuxArgv, finalPartialPath, {
                timeoutMs: validationTimeoutMs,
                maxOutputBytes: 8 * 1024 * 1024,
            });

        var matroskaInventory = null;
        if (useMkvmergeRemux) {
            var outputMkvIdentify = await identifyMatroskaWithMkvmerge(
                finalPartialPath, validationTimeoutMs);
            matroskaInventory = verifyMkvmergeGrainInventory(
                sourceMkvIdentify, grainedMkvIdentify, outputMkvIdentify);
            if (deferredGrainBase) {
                args.variables.vmafAncillaryRemuxDeferredResolved = true;
            }
        }
        var outputProbe = await probeMedia(ffprobePath, finalPartialPath, validationTimeoutMs);
        assertStreamParity(sourceProbe, workingProbe, outputProbe, {
            referenceProbe: grainedProbe,
            stageDescription: 'direct grain-applied AV1 -> final mux',
        });
        assertChapterParity(sourceProbe, outputProbe, Math.min(tolerance, 0.05));
        var grainedOutputDuration = assertDurationParity(
            grainedProbe, outputProbe, tolerance, 'grain-applied AV1 -> final mux');
        var sourceOutputDuration = assertDurationParity(
            sourceProbe, outputProbe, tolerance, 'original -> final grain output');
        var postGrain = await inspectGrain(
            grav1synthPath, finalPartialPath, postInspectPath, validationTimeoutMs);
        if (!postGrain.present) {
            throw new Error('final mux does not expose semantic AV1 film-grain headers');
        }
        args.jobLog('Running mandatory full-title AV1 decode validation after direct grain bitstream rewrite.');
        var directDecodeValidation = await validateFinalAv1Decode(
            ffmpegPath, finalPartialPath, outputProbe, {
                mode: 'direct-' + mode,
                requireFullTitle: true,
                timeoutMs: validationTimeoutMs,
                gpuLease: createGpuDecodeLeaseController(args),
                log: function (message) { args.jobLog(message); },
            });
        if (directDecodeValidation.exhaustive !== true ||
                directDecodeValidation.sampled !== false) {
            throw new Error('direct grain output did not receive exhaustive full-title decode validation');
        }
        args.variables.grainSynthesisDecodeValidationMode =
            directDecodeValidation.mode;
        args.jobLog('Mandatory full-title AV1 decode validation completed: ' +
            directDecodeValidation.mode + '.');

        var baseBytes = fs.statSync(workingPath).size;
        var outputBytes = fs.statSync(finalPartialPath).size;
        var maxSizeRatio = clamp(
            finiteNumber(args.inputs.maxOutputSizeRatioPct, 101), 1, 500);
        var sizeAssessment = assessOutputSizeRatio(baseBytes, outputBytes, maxSizeRatio);
        var qualityWarnings = [];
        recordQualityWarning(args, qualityWarnings, 'output-size-efficiency',
            sizeAssessment.qualityWarning);
        // Fail closed against the ORIGINAL library file before this output can
        // replace it (see assessGrainOutputAgainstOriginal).
        var directGrainOriginalRejection = assessGrainOutputAgainstOriginal(
            sourcePath, finalPartialPath, grainOriginalRatioCap(args));
        if (directGrainOriginalRejection) {
            args.jobLog('FILM GRAIN REJECTED ON SIZE: ' + directGrainOriginalRejection.reason
                + '; discarding the grained output and continuing with the non-grained AV1 output.');
            jobDir = discardRejectedDirectGrainJob(args, jobDir);
            return makeResult(args, 3, args.inputFileObj, 'size_rejected', {
                grainSynthesisReason: 'grain_output_not_smaller_than_original',
                grainSynthesisOriginalRatioPct: directGrainOriginalRejection.ratioPct,
                grainSynthesisOriginalRatioCapPct: directGrainOriginalRejection.capPct,
            });
        }
        fs.renameSync(finalPartialPath, validatedOutputPath);
        var validationReport = {
            schema: 2,
            pipeline: 'direct-grav1synth-global-table-v1',
            mode: mode,
            source: sourcePath,
            base_source: workingPath,
            output: validatedOutputPath,
            table: fitTablePath,
            table_sha256: sha256File(fitTablePath),
            manifest: fitManifestPath,
            direct_unmodified_table: true,
            table_application_count: 1,
            gain_fit_performed: false,
            energy_validation_performed: false,
            full_title_decode_validation_performed: true,
            decode_validation: directDecodeValidation,
            apply_attempts: applyAttempts,
            remux_attempts: remuxAttempts,
            ancillary_remux_method: remuxMethod,
            source_working_duration: sourceWorkingDuration,
            working_grained_duration: workingGrainedDuration,
            grained_output_duration: grainedOutputDuration,
            source_output_duration: sourceOutputDuration,
            stream_count: outputProbe.streams.length,
            chapter_count: (outputProbe.chapters || []).length,
            matroska_inventory: matroskaInventory,
            semantic_grain_inspected: true,
            output_size_bytes: outputBytes,
            output_size_ratio_pct_of_base: sizeAssessment.ratioPct,
            quality_warnings: qualityWarnings,
            completed_at: new Date().toISOString(),
        };

        if (mode === 'canary') {
            var reviewDir = path.resolve(String(args.inputs.reviewDir || '/grain-pilot-review'));
            if (reviewDir === path.parse(reviewDir).root) {
                throw new Error('canary review directory cannot be filesystem root');
            }
            fs.mkdirSync(reviewDir, { recursive: true });
            var stem = reviewStem(sourcePath);
            var reviewSource = path.join(reviewDir, stem + '.source' +
                (path.extname(sourcePath) || '.mkv'));
            var reviewVideo = path.join(reviewDir, stem + '.output.mkv');
            var reviewTable = path.join(reviewDir, stem + '.grain.txt');
            var reviewManifest = path.join(reviewDir, stem + '.pipeline.json');
            var reviewValidation = path.join(reviewDir, stem + '.validation.json');
            atomicCopy(sourcePath, reviewSource); promotedReviewPaths.push(reviewSource);
            atomicCopy(validatedOutputPath, reviewVideo); promotedReviewPaths.push(reviewVideo);
            atomicCopy(fitTablePath, reviewTable); promotedReviewPaths.push(reviewTable);
            atomicCopy(fitManifestPath, reviewManifest); promotedReviewPaths.push(reviewManifest);
            validationReport.output = reviewVideo;
            validationReport.review_source = reviewSource;
            writeJsonAtomic(reviewValidation, validationReport);
            promotedReviewPaths.push(reviewValidation);
            grainArtifact.removeOwnedJobDir(args, jobDir);
            jobDir = null;
            result = makeResult(args, 2, originalObj, 'canary_validated', {
                grainSynthesisReason: null,
                grainSynthesisReviewSource: reviewSource,
                grainSynthesisReviewOutput: reviewVideo,
                grainSynthesisReviewTable: reviewTable,
                grainSynthesisReviewManifest: reviewManifest,
                grainSynthesisValidationReport: reviewValidation,
                grainSynthesisValidation: validationReport,
            });
        } else {
            var productionReview = null;
            if (boolValue(args.inputs.preserveProductionReview, false)) {
                productionReview = preserveProductionReview(
                    args,
                    args.inputs.reviewDir || '/grain-pilot-review',
                    sourcePath,
                    validatedOutputPath,
                    fitTablePath,
                    fitManifestPath,
                    validationReport);
            }
            activeOutput = activeReplacementPath(workRoot, sourcePath);
            fs.renameSync(validatedOutputPath, activeOutput);
            grainArtifact.removeOwnedJobDir(args, jobDir);
            jobDir = null;
            args.variables.vmafTemporaryFiles = Array.isArray(args.variables.vmafTemporaryFiles)
                ? args.variables.vmafTemporaryFiles : [];
            if (args.variables.vmafTemporaryFiles.indexOf(activeOutput) === -1) {
                args.variables.vmafTemporaryFiles.push(activeOutput);
            }
            validationReport.output = activeOutput;
            result = makeResult(args, 1, { _id: activeOutput }, 'active_validated', {
                grainSynthesisReason: null,
                grainSynthesisOutputPath: activeOutput,
                grainSynthesisProductionReview: productionReview,
                grainSynthesisValidation: validationReport,
            });
        }
    } catch (error) {
        args.jobLog('DIRECT FILM GRAIN PATH FAILED: ' + error.message);
        if (jobDir) {
            try { grainArtifact.removeOwnedJobDir(args, jobDir); } catch (cleanupError) {
                args.jobLog('Direct grain scratch cleanup also failed: ' + cleanupError.message);
            }
            jobDir = null;
        }
        if (activeOutput) {
            try { fs.unlinkSync(activeOutput); } catch (_) {}
            activeOutput = null;
        }
        rollbackPromotedReviewArtifacts(args, promotedReviewPaths).forEach(function (failure) {
            args.jobLog('Direct grain review rollback also failed: ' + failure);
        });
        if (error && error.gpuPipelineLeaseReleaseFailed === true) {
            throw error;
        }
        result = directFallbackResult(args, originalObj, error);
    }

    return result;
}

exports.plugin = directPlugin;

exports._test = {
    runProcess: runProcess,
    probeMedia: probeMedia,
    boolValue: boolValue,
    dynamicHdrMarkers: dynamicHdrMarkers,
    colorProfile: colorProfile,
    normalizeUntaggedSdrProfile: normalizeUntaggedSdrProfile,
    canonicalAv1ColorEvidence: canonicalAv1ColorEvidence,
    reconcileAv1SequenceColorEvidence: reconcileAv1SequenceColorEvidence,
    dolbyVisionBaseLayerInfo: dolbyVisionBaseLayerInfo,
    isPqBt2020HighBitVideo: isPqBt2020HighBitVideo,
    exactDynamicHdrProvenance: exactDynamicHdrProvenance,
    normalizeAuthorizedDynamicHdrProfile: normalizeAuthorizedDynamicHdrProfile,
    profileAllowed: profileAllowed,
    isMatroska: isMatroska,
    durationTolerance: durationTolerance,
    assertDurationParity: assertDurationParity,
    isVolatileMatroskaTag: isVolatileMatroskaTag,
    stableTagMap: stableTagMap,
    assertTagsPreserved: assertTagsPreserved,
    isTechnicalPrimaryVideoTag: isTechnicalPrimaryVideoTag,
    stablePrimaryVideoUserTagMap: stablePrimaryVideoUserTagMap,
    assertPrimaryVideoUserTagsPreserved: assertPrimaryVideoUserTagsPreserved,
    stableMkvPrimaryVideoCustomTags: stableMkvPrimaryVideoCustomTags,
    buildMkvmergeTrackTagsXml: buildMkvmergeTrackTagsXml,
    effectiveMkvPrimaryVideoSemantics: effectiveMkvPrimaryVideoSemantics,
    buildMkvPrimaryVideoSemanticOverlay: buildMkvPrimaryVideoSemanticOverlay,
    buildMkvPrimaryVideoSemanticArgs: buildMkvPrimaryVideoSemanticArgs,
    assertMkvPrimaryVideoSemanticsPreserved: assertMkvPrimaryVideoSemanticsPreserved,
    relevantColorState: relevantColorState,
    assertVideoParity: assertVideoParity,
    assertChapterParity: assertChapterParity,
    matchAncillaryStreams: matchAncillaryStreams,
    assertStreamParity: assertStreamParity,
    gpuDecodeUnavailableBeforePass: gpuDecodeUnavailableBeforePass,
    gpuAv1DecodeArgs: gpuAv1DecodeArgs,
    distributedDecodeSamples: distributedDecodeSamples,
    softwareSampleDecodeArgs: softwareSampleDecodeArgs,
    softwareFullDecodeArgs: softwareFullDecodeArgs,
    flowGpuLeaseIdentity: flowGpuLeaseIdentity,
    createGpuDecodeLeaseController: createGpuDecodeLeaseController,
    withGpuDecodeLease: withGpuDecodeLease,
    validateFinalAv1Decode: validateFinalAv1Decode,
    buildRemuxArgs: buildRemuxArgs,
    validMatroskaDate: validMatroskaDate,
    sourceMatroskaDate: sourceMatroskaDate,
    buildMkvmergeRemuxArgs: buildMkvmergeRemuxArgs,
    parseMkvmergeIdentifyJson: parseMkvmergeIdentifyJson,
    assertUidFieldsLossless: assertUidFieldsLossless,
    assertRequiredMkvEntityUids: assertRequiredMkvEntityUids,
    stableMkvTrackInventory: stableMkvTrackInventory,
    stableMkvPrimaryTechnicalInventory: stableMkvPrimaryTechnicalInventory,
    stableMkvAttachmentInventory: stableMkvAttachmentInventory,
    assertMatroskaSourceVideoTopology: assertMatroskaSourceVideoTopology,
    verifyMkvmergeGrainInventory: verifyMkvmergeGrainInventory,
    nonPrimaryPayloadIndexes: nonPrimaryPayloadIndexes,
    hasSemanticGrain: hasSemanticGrain,
    ensurePathAllowed: ensurePathAllowed,
    requireSourceAllowlist: requireSourceAllowlist,
    fullArtifactFingerprint: fullArtifactFingerprint,
    assertFullArtifactFingerprint: assertFullArtifactFingerprint,
    tablesHaveIdenticalPayload: tablesHaveIdenticalPayload,
    energyOptionsFromInputs: energyOptionsFromInputs,
    assertPreparedEnergyPolicy: assertPreparedEnergyPolicy,
    buildCalibrateEnergyArgs: buildCalibrateEnergyArgs,
    buildValidateEnergyArgs: buildValidateEnergyArgs,
    assertDynamicEnergyAlignment: assertDynamicEnergyAlignment,
    recordQualityWarning: recordQualityWarning,
    assessOutputSizeRatio: assessOutputSizeRatio,
    assessGrainOutputAgainstOriginal: assessGrainOutputAgainstOriginal,
    grainOriginalRatioCap: grainOriginalRatioCap,
    discardRejectedDirectGrainJob: discardRejectedDirectGrainJob,
    activeReplacementPath: activeReplacementPath,
    validateDeferredGrainBaseContract: validateDeferredGrainBaseContract,
    makeResult: makeResult,
    rollbackPromotedReviewArtifacts: rollbackPromotedReviewArtifacts,
    parseEnergyFailureDisplay: parseEnergyFailureDisplay,
    validateRobustGlobalCalibrationModel: validateRobustGlobalCalibrationModel,
    validateCorrectionSelection: validateCorrectionSelection,
    validateCalibrationReport: validateCalibrationReport,
    validateEnergyValidationReport: validateEnergyValidationReport,
};
