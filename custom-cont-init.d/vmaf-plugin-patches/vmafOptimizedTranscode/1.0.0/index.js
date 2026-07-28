"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var cliUtils_1 = require("../../../../FlowHelpers/1.0.0/cliUtils");
var deliveryPolicy = require('../../_lib/deliveryPolicy.js');
var nvencTemporalFilter = require('../../_lib/nvencTemporalFilter.js');
var canonicalDenoise = require('../../_lib/canonicalDenoise.js');
var nvenccKnn = require('../../_lib/nvenccKnn.js');
var grainArtifact = require('../../_lib/grainAnalysisArtifact.js');
var grainVmafContract = require('../../_lib/grainVmafContract.js');
var postEncodeCheckpoint = require('../../_lib/postEncodeCheckpoint.js');
var CONSERVATIVE_RETAINED_SUBSTITUTION_CONTRACT_ID =
    'vmaf-conservative-postencode-cq-substitution-v1';
var MAX_RETAINED_RECOVERY_JSON_BYTES = 64 * 1024;
var POSTENCODE_ROUTINE_VALIDATOR = 'ffprobe-demux-plus-distributed-decode-v2';
var POSTENCODE_EXHAUSTIVE_VALIDATOR = 'ffprobe-demux-plus-full-decode-v1';
var POSTENCODE_SAMPLE_SECONDS = 1;
var POSTENCODE_SAMPLE_TIMEOUT_MS = 90000;
var POSTENCODE_EXHAUSTIVE_TIMEOUT_MS = 14400000;
var FINAL_TRANSCODE_WATCHDOG_MIN_SECONDS = 12 * 60 * 60;
var FINAL_TRANSCODE_WATCHDOG_MAX_SECONDS = 72 * 60 * 60;
var FINAL_TRANSCODE_WATCHDOG_FALLBACK_SECONDS = 24 * 60 * 60;

function medianPositive(values) {
    var sorted = (values || []).map(Number).filter(function (value) {
        return isFinite(value) && value > 0;
    }).sort(function (left, right) { return left - right; });
    if (!sorted.length) return null;
    var middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

function finalTranscodeWatchdogPolicy(sourceDurationSeconds, variables, selectedParameterSetId) {
    variables = variables || {};
    var duration = Number(sourceDurationSeconds);
    if (!isFinite(duration) || duration <= 0) duration = null;
    var sampleDuration = Number(variables.vmafSegmentDuration);
    if (!isFinite(sampleDuration) || sampleDuration <= 0) sampleDuration = null;
    var selectedId = String(selectedParameterSetId || '').trim();
    var matchingTimes = (Array.isArray(variables.vmafTestResults)
        ? variables.vmafTestResults : []).filter(function (result) {
        if (!result || !selectedId || String(result.parameterSetId || '') !== selectedId) return false;
        return isFinite(Number(result.encodingTimeSeconds)) && Number(result.encodingTimeSeconds) > 0;
    }).map(function (result) { return Number(result.encodingTimeSeconds); });
    var medianSampleEncodeSeconds = medianPositive(matchingTimes);
    var projectedSeconds = duration && sampleDuration && medianSampleEncodeSeconds
        ? duration * (medianSampleEncodeSeconds / sampleDuration)
        : null;
    var requestedSeconds;
    var basis;
    if (projectedSeconds) {
        // Sample encodes are short and can under-represent decoder setup,
        // difficult scenes, muxing, and shared-GPU contention. Four projected
        // runtimes plus two hours of fixed slack keeps the watchdog a true
        // liveness backstop rather than a normal scheduling deadline.
        requestedSeconds = projectedSeconds * 4 + (2 * 60 * 60);
        basis = 'selected-parameter-sample-throughput';
    } else if (duration) {
        // With no usable timing evidence, allow an encode as slow as 1/12
        // realtime plus two hours. This is deliberately conservative.
        requestedSeconds = duration * 12 + (2 * 60 * 60);
        basis = 'source-duration-conservative-fallback';
    } else {
        requestedSeconds = FINAL_TRANSCODE_WATCHDOG_FALLBACK_SECONDS;
        basis = 'missing-duration-fallback';
    }
    var timeoutSeconds = Math.round(Math.min(
        FINAL_TRANSCODE_WATCHDOG_MAX_SECONDS,
        Math.max(FINAL_TRANSCODE_WATCHDOG_MIN_SECONDS, requestedSeconds)));
    return {
        schema: 1,
        policy: 'sample-informed-absolute-liveness-cap-v1',
        basis: basis,
        timeoutSeconds: timeoutSeconds,
        timeoutMs: timeoutSeconds * 1000,
        sourceDurationSeconds: duration,
        selectedParameterSetId: selectedId || null,
        sampleDurationSeconds: sampleDuration,
        matchingSampleCount: matchingTimes.length,
        medianSampleEncodeSeconds: medianSampleEncodeSeconds,
        projectedFullEncodeSeconds: projectedSeconds,
        minimumSeconds: FINAL_TRANSCODE_WATCHDOG_MIN_SECONDS,
        maximumSeconds: FINAL_TRANSCODE_WATCHDOG_MAX_SECONDS,
    };
}

function evaluateFinalOutputSizeGate(outputBytes, sourceBytes, configuredMaxRatioPct) {
    var policy = deliveryPolicy.requireCurrentPolicy({
        version: deliveryPolicy.POLICY_VERSION,
        targetReductionPct: deliveryPolicy.DEFAULT_TARGET_REDUCTION_PCT,
        minimumReductionPct: deliveryPolicy.DEFAULT_MINIMUM_REDUCTION_PCT,
        maxFinalOutputRatioPct: Number(configuredMaxRatioPct),
    });
    return deliveryPolicy.evaluateBytes(outputBytes, sourceBytes, policy);
}

function retireRejectedPostEncodeCheckpoint(variables, checkpointModule, jobLog, now) {
    variables = variables || {};
    var record = variables.vmafPostEncodeCheckpoint;
    var log = typeof jobLog === 'function' ? jobLog : function () {};
    var timestamp = typeof now === 'function' ? now() : new Date().toISOString();
    if (!record) {
        variables.vmafPostEncodeCheckpointRetired = false;
        variables.vmafPostEncodeCheckpointStatus = 'size_rejected_checkpoint_record_missing';
        variables.vmafPostEncodeCheckpointRetirementWarning =
            'size-rejected output had no authenticated checkpoint record to retire';
        log('WARNING: ' + variables.vmafPostEncodeCheckpointRetirementWarning +
            '; preserving the original and any recoverable artifact.');
        return { retired: false, retained: true, reason: 'checkpoint_record_missing' };
    }
    try {
        checkpointModule.retire(record);
        variables.vmafRejectedPostEncodeCheckpointAudit = {
            schema: 1,
            reason: 'post_encode_size_rejected',
            checkpoint_key: record.checkpoint_key,
            encode_contract_sha256: record.encode_contract_sha256,
            reused: record.reused === true,
            retired_at: timestamp,
        };
        variables.vmafPostEncodeCheckpointRetired = true;
        variables.vmafPostEncodeCheckpointStatus = 'retired_size_rejected';
        delete variables.vmafPostEncodeCheckpointRetirementWarning;
        delete variables.vmafPostEncodeCheckpoint;
        delete variables.vmafPostEncodeCheckpointPath;
        delete variables.vmafPostEncodeCheckpointManifestPath;
        log('Retired exact authenticated checkpoint rejected by the post-encode size gate: ' +
            record.checkpoint_key);
        return { retired: true, retained: false, checkpointKey: record.checkpoint_key };
    } catch (error) {
        variables.vmafPostEncodeCheckpointRetired = false;
        variables.vmafPostEncodeCheckpointStatus = 'retirement_failed_size_rejected';
        variables.vmafPostEncodeCheckpointRetirementWarning =
            'could not retire size-rejected checkpoint: ' + error.message;
        log('WARNING: ' + variables.vmafPostEncodeCheckpointRetirementWarning +
            '; preserving the original and retaining the authenticated artifact for cleanup.');
        return {
            retired: false,
            retained: true,
            checkpointKey: record.checkpoint_key,
            reason: error.message,
        };
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

var details = function () { return ({
    name: 'VMAF Optimized Transcode',
    description: 'Transcodes the full video using the VMAF-optimized parameters with real-time progress.',
    style: {
        borderColor: 'red',
    },
    tags: 'video,vmaf,transcode',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faVideo',
    inputs: [],
    outputs: [
        {
            number: 1,
            tooltip: 'Transcode successful',
        },
        {
            number: 2,
            tooltip: 'Transcode failed or no parameters',
        },
    ],
}); };
exports.details = details;



// --- HDR metadata helper: parse hdrMasterDisplay / hdrMaxCll strings from checkHdrContent ---
// hdrMasterDisplay format: "G(x,y)B(x,y)R(x,y)WP(x,y)L(max_lum,min_lum)"
// hdrMaxCll format: "max_content_light_level,max_pic_average_light_level"
function parseHdrMasterDisplay(raw) {
    if (!raw) return null;
    var m = String(raw).match(/G\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)\s*B\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)\s*R\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)\s*WP\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)\s*L\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)/i);
    if (!m) return null;
    return {
        green_x: parseFloat(m[1]) / 50000, green_y: parseFloat(m[2]) / 50000,
        blue_x: parseFloat(m[3]) / 50000, blue_y: parseFloat(m[4]) / 50000,
        red_x: parseFloat(m[5]) / 50000, red_y: parseFloat(m[6]) / 50000,
        white_x: parseFloat(m[7]) / 50000, white_y: parseFloat(m[8]) / 50000,
        max_lum: parseFloat(m[9]) / 10000, min_lum: parseFloat(m[10]) / 10000
    };
}

function parseHdrMaxCll(raw) {
    if (!raw) return null;
    var parts = raw.split(',');
    if (parts.length < 2) return null;
    return { max_cll: parseInt(parts[0], 10), max_pall: parseInt(parts[1], 10) };
}

// Map string color primaries to integer values used by mkvpropedit
function colorPrimariesToInt(v) {
    v = String(v || '').toLowerCase();
    if (v.indexOf('bt2020') !== -1) return 9;
    if (v.indexOf('bt709') !== -1 || v.indexOf('709') !== -1) return 1;
    if (v.indexOf('bt601') !== -1 || v.indexOf('601') !== -1) return 5;
    return 2;
}

function colorTrcToInt(v) {
    v = String(v || '').toLowerCase();
    if (v.indexOf('smpte2084') !== -1 || v.indexOf('pq') !== -1) return 16;
    if (v.indexOf('arib-std-b67') !== -1 || v.indexOf('hlg') !== -1) return 18;
    if (v.indexOf('bt709') !== -1 || v.indexOf('709') !== -1) return 1;
    if (v.indexOf('bt601') !== -1 || v.indexOf('601') !== -1) return 4;
    return 2;
}

function colorMatrixToInt(v) {
    v = String(v || '').toLowerCase();
    if (v.indexOf('bt2020') !== -1) return 9;
    if (v.indexOf('bt709') !== -1 || v.indexOf('709') !== -1) return 1;
    if (v.indexOf('bt601') !== -1 || v.indexOf('601') !== -1) return 6;
    return 2;
}

function buildHdrMkvProperties(colorPrimaries, colorTrc, colorspace, hdrMasterDisplay, hdrMaxCll) {
    var mdc = parseHdrMasterDisplay(hdrMasterDisplay);
    var mcll = parseHdrMaxCll(hdrMaxCll);
    var properties = {
        color_primaries: colorPrimariesToInt(colorPrimaries),
        color_transfer_characteristics: colorTrcToInt(colorTrc),
        color_matrix_coefficients: colorMatrixToInt(colorspace)
    };
    if (mdc) {
        properties.chromaticity_coordinates = [mdc.red_x, mdc.red_y, mdc.green_x, mdc.green_y, mdc.blue_x, mdc.blue_y];
        properties.white_color_coordinates = [mdc.white_x, mdc.white_y];
        properties.max_luminance = mdc.max_lum;
        properties.min_luminance = mdc.min_lum;
    }
    if (mcll) {
        properties.max_content_light = mcll.max_cll;
        properties.max_frame_light = mcll.max_pall;
    }
    return properties;
}

function mkvPropertyArgs(properties) {
    var nameMap = {
        color_primaries: 'color-primaries', color_transfer_characteristics: 'color-transfer-characteristics',
        color_matrix_coefficients: 'color-matrix-coefficients', max_content_light: 'max-content-light',
        max_frame_light: 'max-frame-light', max_luminance: 'max-luminance', min_luminance: 'min-luminance'
    };
    var args = ['--edit', 'track:1'];
    Object.keys(nameMap).forEach(function (key) {
        if (properties[key] !== undefined) args.push('--set', nameMap[key] + '=' + properties[key]);
    });
    if (properties.chromaticity_coordinates) {
        var c = properties.chromaticity_coordinates;
        ['red-x', 'red-y', 'green-x', 'green-y', 'blue-x', 'blue-y'].forEach(function (suffix, index) {
            args.push('--set', 'chromaticity-coordinates-' + suffix + '=' + c[index]);
        });
    }
    if (properties.white_color_coordinates) {
        args.push('--set', 'white-coordinates-x=' + properties.white_color_coordinates[0]);
        args.push('--set', 'white-coordinates-y=' + properties.white_color_coordinates[1]);
    }
    return args;
}

function verifyHdrTrackProperties(actual, expected) {
    var failures = [];
    function closeNumber(a, b, tolerance) {
        return isFinite(Number(a)) && Math.abs(Number(a) - Number(b)) <= tolerance;
    }
    ['color_primaries', 'color_transfer_characteristics', 'color_matrix_coefficients',
        'max_content_light', 'max_frame_light'].forEach(function (key) {
        if (expected[key] !== undefined && Number(actual[key]) !== Number(expected[key])) failures.push(key);
    });
    ['max_luminance', 'min_luminance'].forEach(function (key) {
        if (expected[key] !== undefined && !closeNumber(actual[key], expected[key], key === 'min_luminance' ? 0.0001 : 0.01)) failures.push(key);
    });
    [['chromaticity_coordinates', 6], ['white_color_coordinates', 2]].forEach(function (item) {
        var key = item[0];
        if (!expected[key]) return;
        var values = String(actual[key] || '').split(',').map(Number);
        if (values.length !== item[1] || expected[key].some(function (value, index) { return !closeNumber(values[index], value, 0.00001); })) failures.push(key);
    });
    return { ok: failures.length === 0, failures: failures };
}

// Run mkvpropedit to apply every static HDR field supported by the installed Matroska tools.
function applyHdrColorMetadata(outputPath, sourceFile, colorPrimaries, colorTrc, colorspace, hdrMasterDisplay, hdrMaxCll, jobLog) {
    var spawnSync = require('child_process').spawnSync;
    var properties = buildHdrMkvProperties(colorPrimaries, colorTrc, colorspace, hdrMasterDisplay, hdrMaxCll);
    var args = mkvPropertyArgs(properties);
    var res = spawnSync('mkvpropedit', [outputPath].concat(args), { encoding: 'utf8', timeout: 300000 });
    if (res.error) {
        jobLog('  mkvpropedit error (HDR metadata not applied): ' + res.error.message);
        return { ok: false, reason: res.error.message };
    }
    if (res.status !== 0) {
        var errTail = String(res.stderr || res.stdout || '').trim().split('\n').slice(-1)[0];
        jobLog('  mkvpropedit warning: exit ' + res.status + ' (HDR color metadata may not be set): ' + errTail);
        return { ok: false, reason: 'mkvpropedit_exit_' + res.status };
    }
    var identify = spawnSync('mkvmerge', ['-J', outputPath], { encoding: 'utf8', timeout: 300000 });
    if (identify.error || identify.status !== 0) {
        jobLog('  HDR metadata verification failed: mkvmerge could not identify the output.');
        return { ok: false, reason: 'mkvmerge_identify_failed' };
    }
    try {
        var identified = JSON.parse(identify.stdout || '{}');
        var videoTrack = (identified.tracks || []).filter(function (track) { return track.type === 'video'; })[0];
        var verified = verifyHdrTrackProperties((videoTrack && videoTrack.properties) || {}, properties);
        if (!verified.ok) {
            jobLog('  HDR metadata verification failed for: ' + verified.failures.join(', '));
            return { ok: false, reason: 'metadata_mismatch_' + verified.failures.join('_') };
        }
    } catch (verifyError) {
        jobLog('  HDR metadata verification failed: ' + verifyError.message);
        return { ok: false, reason: 'metadata_verify_exception' };
    }
    jobLog('  HDR static metadata applied and verified (primaries=' + colorPrimaries + ', trc=' + colorTrc + ', matrix=' + colorspace + ')');
    return { ok: true, properties: properties };
}

function av1ColorMetadataArgs(colorPrimaries, colorTrc, colorspace) {
    function mapPrimaries(v) {
        v = String(v || '').toLowerCase();
        if (v.indexOf('bt2020') !== -1) return 9;
        if (v.indexOf('bt709') !== -1) return 1;
        return 2;
    }
    function mapTransfer(v) {
        v = String(v || '').toLowerCase();
        if (v.indexOf('smpte2084') !== -1) return 16;
        if (v.indexOf('arib-std-b67') !== -1 || v.indexOf('hlg') !== -1) return 18;
        if (v.indexOf('bt2020-10') !== -1) return 14;
        if (v.indexOf('bt2020-12') !== -1) return 15;
        if (v.indexOf('bt709') !== -1) return 1;
        return 2;
    }
    function mapMatrix(v) {
        v = String(v || '').toLowerCase();
        if (v.indexOf('bt2020') !== -1) return 9;
        if (v.indexOf('bt709') !== -1) return 1;
        return 2;
    }
    return {
        bsf: 'av1_metadata=color_primaries=' + mapPrimaries(colorPrimaries) + ':transfer_characteristics=' + mapTransfer(colorTrc) + ':matrix_coefficients=' + mapMatrix(colorspace)
    };
}

function selectOutputContainer(originalFile, variables, sourceProbe) {
    var sourceContainer = require('path').extname(originalFile).slice(1) || 'mkv';
    // Static HDR mastering metadata is written and verified with mkvpropedit/mkvmerge.
    // A Dolby Vision -> HDR10 fallback therefore always uses Matroska, including MP4 sources.
    if (variables && variables.vmafDynamicHdrConversion) return 'mkv';
    var probedFormats = String(sourceProbe && sourceProbe.format && sourceProbe.format.format_name || '')
        .toLowerCase().split(',').map(function (value) { return value.trim(); });
    // ffprobe is authoritative when a Matroska payload has a misleading suffix
    // (the live canary is Matroska named .ts).
    return probedFormats.indexOf('matroska') !== -1 ? 'mkv' : sourceContainer;
}

function isAttachedPictureStream(stream) {
    return !!(stream && stream.codec_type === 'video' && stream.disposition &&
        Number(stream.disposition.attached_pic) === 1);
}

function streamInputMap(stream, description) {
    var rawIndex = stream && stream.index;
    var index = Number(rawIndex);
    if (rawIndex === null || rawIndex === undefined || String(rawIndex).trim() === '' ||
            !Number.isInteger(index) || index < 0) {
        throw new Error((description || 'input stream') + ' has no valid ffprobe stream index');
    }
    return '0:' + index;
}

// Map one ordinary primary video plus only ffprobe-attested cover-art video streams.
// Production inventory checks reject multiple ordinary videos instead of silently dropping
// alternate angles or secondary programs. ffprobe can expose a Matroska Attachment as an
// attached_pic pseudo-stream; the separate mkvmerge source preflight distinguishes that from
// a real second Matroska video track. The primary is mapped first so its output is always v:0.
function buildVideoStreamPlan(ffProbeData, requireStreamInventory) {
    var streams = ffProbeData && Array.isArray(ffProbeData.streams)
        ? ffProbeData.streams : [];
    if (!streams.length) {
        if (requireStreamInventory === true) {
            throw new Error('ffprobe stream inventory is required to preserve attached pictures');
        }
        return { primaryInputMap: '0:v:0', attachedPictureInputMaps: [] };
    }
    var videos = streams.filter(function (stream) { return stream && stream.codec_type === 'video'; });
    if (!videos.length) {
        if (requireStreamInventory === true) {
            throw new Error('ffprobe stream inventory contains no video stream');
        }
        return { primaryInputMap: '0:v:0', attachedPictureInputMaps: [] };
    }
    var ordinaryVideos = videos.filter(function (stream) { return !isAttachedPictureStream(stream); });
    if (requireStreamInventory === true && ordinaryVideos.length !== 1) {
        throw new Error('ffprobe stream inventory must contain exactly one non-attached video stream; found ' +
            ordinaryVideos.length);
    }
    var primary = ordinaryVideos[0];
    if (!primary) throw new Error('input has no non-attached primary video stream');
    var primaryInputMap = streamInputMap(primary, 'primary video stream');
    var seen = {};
    seen[primaryInputMap] = true;
    var attachedPictureInputMaps = [];
    videos.filter(isAttachedPictureStream).forEach(function (stream) {
        var inputMap = streamInputMap(stream, 'attached-picture video stream');
        if (seen[inputMap]) throw new Error('duplicate ffprobe video stream index ' + inputMap.slice(2));
        seen[inputMap] = true;
        attachedPictureInputMaps.push(inputMap);
    });
    return {
        primaryInputMap: primaryInputMap,
        attachedPictureInputMaps: attachedPictureInputMaps
    };
}

function shouldUseMatroskaAncillaryBypass(originalFile, outputContainer, ffProbeData) {
    var formatName = String(ffProbeData && ffProbeData.format &&
        ffProbeData.format.format_name || '').toLowerCase();
    var formatNames = formatName.split(',').map(function (name) { return name.trim(); });
    if (String(outputContainer || '').toLowerCase() !== 'mkv') return false;
    if (formatName) return formatNames.indexOf('matroska') !== -1;
    // Tdarr normally supplies format_name. If it does not, an .mkv input still takes the
    // fail-closed MKVToolNix path; identifyMatroskaWithMkvmerge will reject a false extension.
    return require('path').extname(String(originalFile || '')).toLowerCase() === '.mkv';
}

function buildMkvmergeAncillaryArgs(videoOnlyPath, originalFile, partialOutputPath, sourceTitle) {
    var argv = ['--quiet', '--disable-track-statistics-tags', '--output', String(partialOutputPath)];
    if (String(sourceTitle || '').trim()) argv.push('--title', String(sourceTitle));
    // Input-scoped options must precede the input they apply to. The first input contributes
    // only the new primary video and its track metadata. The original contributes everything
    // except its old video track(s), so compressed PGS, audio, attachments, chapters, and tags
    // never pass through FFmpeg.
    argv.push('--no-audio', '--no-subtitles', '--no-buttons', '--no-chapters',
        '--no-attachments', '--no-global-tags', '--no-track-tags', String(videoOnlyPath));
    argv.push('--no-video', String(originalFile));
    return argv;
}

function canonicalJson(value) {
    if (Array.isArray(value)) return value.map(canonicalJson);
    if (!value || typeof value !== 'object') return value;
    var result = {};
    Object.keys(value).sort().forEach(function (key) { result[key] = canonicalJson(value[key]); });
    return result;
}

function stableTrackInventory(track) {
    var properties = track && track.properties || {};
    var propertyKeys = [
        'codec_id', 'codec_private_data', 'uid', 'number', 'language', 'language_ietf',
        'track_name', 'default_track',
        'forced_track', 'enabled_track', 'hearing_impaired', 'visual_impaired',
        'text_descriptions', 'original', 'commentary', 'audio_channels',
        'audio_sampling_frequency', 'default_duration',
        'content_encoding_algorithms', 'codec_private_length', 'pixel_dimensions',
        'display_dimensions', 'display_unit', 'color_primaries', 'color_transfer_characteristics',
        'color_matrix_coefficients', 'color_range', 'chroma_siting'
    ];
    var stableProperties = {};
    propertyKeys.forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) stableProperties[key] = properties[key];
    });
    return canonicalJson({
        type: track && track.type,
        codec: track && track.codec,
        properties: stableProperties
    });
}

function stableAttachmentInventory(attachment) {
    var properties = attachment && attachment.properties || {};
    return canonicalJson({
        content_type: attachment && attachment.content_type,
        description: attachment && attachment.description || '',
        file_name: attachment && attachment.file_name,
        size: attachment && attachment.size,
        uid: properties.uid
    });
}

function sortedCanonical(items) {
    return (items || []).map(function (item) { return JSON.stringify(canonicalJson(item)); }).sort();
}

function assertSameInventory(expected, actual, description) {
    var left = JSON.stringify(expected);
    var right = JSON.stringify(actual);
    if (left !== right) throw new Error(description + ' changed during Matroska ancillary merge');
}

function findDeclaredInventoryMismatch(expected, actual, path) {
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual)) return path + ' changed type';
        if (expected.length !== actual.length) return path + ' changed length';
        for (var i = 0; i < expected.length; i += 1) {
            var arrayMismatch = findDeclaredInventoryMismatch(expected[i], actual[i], path + '[' + i + ']');
            if (arrayMismatch) return arrayMismatch;
        }
        return '';
    }
    if (expected && typeof expected === 'object') {
        if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return path + ' changed type';
        var expectedKeys = Object.keys(expected);
        for (var keyIndex = 0; keyIndex < expectedKeys.length; keyIndex += 1) {
            var key = expectedKeys[keyIndex];
            var propertyPath = path + '.' + key;
            if (!Object.prototype.hasOwnProperty.call(actual, key)) return propertyPath + ' is missing';
            var objectMismatch = findDeclaredInventoryMismatch(expected[key], actual[key], propertyPath);
            if (objectMismatch) return objectMismatch;
        }
        return '';
    }
    if (JSON.stringify(expected) !== JSON.stringify(actual)) return path + ' changed value';
    return '';
}

function assertDeclaredInventoryPreserved(authoritative, actual, description) {
    // mkvmerge can materialize defaults that were implicit in its input (for example
    // language_ietf=und/en). Those additions are safe, but every property explicitly
    // reported for the authoritative input must still exist with the same value.
    var mismatch = findDeclaredInventoryMismatch(authoritative, actual, '$');
    if (mismatch) {
        throw new Error(description + ' changed during Matroska ancillary merge: ' + mismatch);
    }
}

function assertUnorderedDeclaredInventoryPreserved(authoritative, actual, description) {
    var expectedItems = authoritative || [];
    var remainingItems = (actual || []).slice();
    if (expectedItems.length !== remainingItems.length) {
        throw new Error(description + ' changed during Matroska ancillary merge: item count changed');
    }
    for (var i = 0; i < expectedItems.length; i += 1) {
        var matchIndex = -1;
        for (var j = 0; j < remainingItems.length; j += 1) {
            if (!findDeclaredInventoryMismatch(expectedItems[i], remainingItems[j], '$')) {
                matchIndex = j;
                break;
            }
        }
        if (matchIndex === -1) {
            var firstMismatch = remainingItems.length
                ? findDeclaredInventoryMismatch(expectedItems[i], remainingItems[0], '$') : '';
            throw new Error(description + ' changed during Matroska ancillary merge: ' +
                'no output item preserves authoritative item ' + i +
                (firstMismatch ? ' (' + firstMismatch + ')' : ''));
        }
        remainingItems.splice(matchIndex, 1);
    }
}

function assertMatroskaSourceVideoTopology(sourceIdentify) {
    var sourceTracks = sourceIdentify && sourceIdentify.tracks || [];
    var sourceVideos = sourceTracks.filter(function (track) { return track && track.type === 'video'; });
    if (sourceVideos.length !== 1) {
        throw new Error('source Matroska must contain exactly one actual video track for ancillary bypass; found ' +
            sourceVideos.length);
    }
    return {
        video_tracks: sourceVideos.length,
        attachments: (sourceIdentify && sourceIdentify.attachments || []).length
    };
}

function preflightMatroskaAncillarySource(originalFile, identifyFn) {
    var identify = identifyFn || identifyMatroskaWithMkvmerge;
    var sourceIdentify = identify(String(originalFile));
    return {
        identify: sourceIdentify,
        inventory: assertMatroskaSourceVideoTopology(sourceIdentify)
    };
}

function verifyMkvmergeAncillaryInventory(sourceIdentify, videoIdentify, outputIdentify) {
    var sourceTracks = sourceIdentify && sourceIdentify.tracks || [];
    var videoTracks = videoIdentify && videoIdentify.tracks || [];
    var outputTracks = outputIdentify && outputIdentify.tracks || [];
    assertMatroskaSourceVideoTopology(sourceIdentify);
    if (videoTracks.length !== 1 || videoTracks[0].type !== 'video') {
        throw new Error('FFmpeg intermediate is not exactly one video track');
    }
    // FFmpeg's Matroska muxer may synthesize global/track statistics even with
    // -map_metadata -1. The mkvmerge command suppresses those first-input tags, disables
    // regenerated statistics, and the final source-owned global-tag inventory is checked
    // below. Attachments and chapters in this supposedly video-only file are never valid.
    if ((videoIdentify.attachments || []).length || (videoIdentify.chapters || []).length) {
        throw new Error('FFmpeg intermediate unexpectedly contains ancillary Matroska inventory');
    }
    var outputVideos = outputTracks.filter(function (track) { return track && track.type === 'video'; });
    if (outputVideos.length !== 1) {
        throw new Error('merged Matroska does not contain exactly one primary video track');
    }
    if (String(outputVideos[0].codec || '') !== String(videoTracks[0].codec || '') ||
            String(outputVideos[0].properties && outputVideos[0].properties.codec_id || '') !==
            String(videoTracks[0].properties && videoTracks[0].properties.codec_id || '')) {
        throw new Error('merged Matroska primary video codec changed');
    }
    assertDeclaredInventoryPreserved(stableTrackInventory(videoTracks[0]),
        stableTrackInventory(outputVideos[0]), 'primary video track inventory');
    var sourceNonVideo = sourceTracks.filter(function (track) { return track && track.type !== 'video'; });
    var outputNonVideo = outputTracks.filter(function (track) { return track && track.type !== 'video'; });
    if (sourceNonVideo.length !== outputNonVideo.length) {
        throw new Error('non-video track count changed from ' + sourceNonVideo.length +
            ' to ' + outputNonVideo.length);
    }
    assertDeclaredInventoryPreserved(sourceNonVideo.map(stableTrackInventory),
        outputNonVideo.map(stableTrackInventory), 'non-video track inventory');
    assertUnorderedDeclaredInventoryPreserved(
        (sourceIdentify.attachments || []).map(stableAttachmentInventory),
        (outputIdentify.attachments || []).map(stableAttachmentInventory),
        'attachment inventory');
    assertSameInventory(sortedCanonical(sourceIdentify.chapters || []),
        sortedCanonical(outputIdentify.chapters || []), 'chapter inventory');
    assertSameInventory(sortedCanonical(sourceIdentify.global_tags || []),
        sortedCanonical(outputIdentify.global_tags || []), 'global tag inventory');
    var sourceTitle = String(sourceIdentify && sourceIdentify.container &&
        sourceIdentify.container.properties && sourceIdentify.container.properties.title || '');
    var outputTitle = String(outputIdentify && outputIdentify.container &&
        outputIdentify.container.properties && outputIdentify.container.properties.title || '');
    if (sourceTitle !== outputTitle) throw new Error('Matroska segment title changed');
    return {
        video_tracks: outputVideos.length,
        non_video_tracks: outputNonVideo.length,
        attachments: (outputIdentify.attachments || []).length,
        chapter_editions: (outputIdentify.chapters || []).length,
        global_tag_sets: (outputIdentify.global_tags || []).length
    };
}

function identifyMatroskaWithMkvmerge(filePath) {
    var spawnSync = require('child_process').spawnSync;
    var result = spawnSync('mkvmerge', ['-J', String(filePath)], {
        encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024
    });
    if (result.error) throw new Error('mkvmerge identify failed for ' + filePath + ': ' + result.error.message);
    if (result.status !== 0) {
        throw new Error('mkvmerge identify exited ' + result.status + ' for ' + filePath + ': ' +
            String(result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-1)[0]);
    }
    var parsed = parseMkvmergeIdentifyJson(result.stdout || '{}', filePath);
    if (!parsed || !parsed.container || parsed.container.supported !== true || !Array.isArray(parsed.tracks)) {
        throw new Error('mkvmerge does not identify a supported container at ' + filePath);
    }
    if ((parsed.errors || []).length || (parsed.warnings || []).length) {
        throw new Error('mkvmerge identify reported errors or warnings for ' + filePath);
    }
    return parsed;
}

function parseMkvmergeIdentifyJson(rawJson, filePath) {
    // mkvmerge emits unsigned 64-bit track/attachment UIDs as JSON numbers. Native
    // JSON.parse would round values above Number.MAX_SAFE_INTEGER and could miss a UID
    // change. Quote only exact `uid` integer values before parsing so comparisons remain
    // decimal-string lossless; unrelated numeric properties keep their native types.
    var losslessJson = String(rawJson || '{}').replace(
        /("uid"\s*:\s*)(-?\d+)(?=\s*[,}])/g, '$1"$2"');
    try { return JSON.parse(losslessJson); }
    catch (parseError) {
        throw new Error('mkvmerge identify returned invalid JSON for ' + String(filePath || 'input'));
    }
}

function preserveMatroskaAncillaryWithMkvmerge(videoOnlyPath, originalFile, outputPath, jobLog) {
    var fs = require('fs');
    var path = require('path');
    var spawnSync = require('child_process').spawnSync;
    var partialOutputPath = String(outputPath) + '.mkvmerge-partial.mkv';
    var resolved = [videoOnlyPath, originalFile, outputPath, partialOutputPath].map(function (item) {
        return path.resolve(String(item));
    });
    if ((new Set(resolved)).size !== resolved.length) {
        throw new Error('Matroska ancillary merge paths are not distinct');
    }
    try { fs.unlinkSync(partialOutputPath); } catch (staleError) {
        if (!staleError || staleError.code !== 'ENOENT') throw staleError;
    }
    var sourceIdentify = identifyMatroskaWithMkvmerge(originalFile);
    var videoIdentify = identifyMatroskaWithMkvmerge(videoOnlyPath);
    var sourceTitle = sourceIdentify.container && sourceIdentify.container.properties &&
        sourceIdentify.container.properties.title;
    var mergeArgs = buildMkvmergeAncillaryArgs(
        videoOnlyPath, originalFile, partialOutputPath, sourceTitle);
    jobLog('MKVToolNix ancillary command: mkvmerge ' + mergeArgs.join(' '));
    var merge = spawnSync('mkvmerge', mergeArgs, {
        encoding: 'utf8', timeout: 1800000, maxBuffer: 32 * 1024 * 1024
    });
    if (merge.error || merge.status !== 0) {
        try { fs.unlinkSync(partialOutputPath); } catch (_cleanupError) {}
        throw new Error(merge.error ? merge.error.message :
            'mkvmerge exited ' + merge.status + ': ' +
            String(merge.stderr || merge.stdout || '').trim().split(/\r?\n/).slice(-1)[0]);
    }
    var outputIdentify;
    try {
        outputIdentify = identifyMatroskaWithMkvmerge(partialOutputPath);
        var inventory = verifyMkvmergeAncillaryInventory(
            sourceIdentify, videoIdentify, outputIdentify);
        try { fs.unlinkSync(outputPath); } catch (staleOutputError) {
            if (!staleOutputError || staleOutputError.code !== 'ENOENT') throw staleOutputError;
        }
        fs.renameSync(partialOutputPath, outputPath);
        return { inventory: inventory, mergeArgs: mergeArgs };
    } catch (verifyError) {
        try { fs.unlinkSync(partialOutputPath); } catch (_verifyCleanupError) {}
        throw verifyError;
    }
}

function buildFinalTranscodeArgs(options) {
    options = options || {};
    var bestParams = options.bestParams || {};
    var encoder = String(bestParams.encoder || '');
    var isAv1Nvenc = bestParams.isGPU && encoder.indexOf('av1_nvenc') !== -1;
    var canonicalInput = options.canonicalDenoise === true;
    var temporalPolicy = options.temporalPolicy || (canonicalInput
        ? nvencTemporalFilter.CANONICAL_POLICY : nvencTemporalFilter.LEGACY_POLICY);
    if (canonicalInput && temporalPolicy !== nvencTemporalFilter.CANONICAL_POLICY) {
        throw new Error('canonical final transcode requires the canonical tf0 policy');
    }
    var argv = [];
    var videoStreamPlan = buildVideoStreamPlan(
        options.ffProbeData, options.requireStreamInventory === true);
    if (canonicalInput) {
        argv.push('-f', 'nut', '-i', 'pipe:0');
        if (options.matroskaVideoOnly !== true) {
            argv.push('-i', String(options.originalFile));
        }
    } else {
        if (isAv1Nvenc) argv.push('-hwaccel', 'cuda');
        argv.push('-i', String(options.originalFile));
    }
    argv.push('-c:v', encoder);
    if (isAv1Nvenc) {
        argv.push('-pix_fmt', String(options.pixFmt));
        argv.push('-rc', 'vbr', '-cq', String(options.useCQ), '-b:v', '0');
        argv.push('-preset', String(bestParams.preset));
        nvencTemporalFilter.appendValidatedQualityFlags(argv,
            options.nvencFlagArgs || nvencTemporalFilter.qualityFlags(temporalPolicy, false),
            temporalPolicy,
            'final AV1 production transcode');
        argv.push('-g', '96', '-forced-idr', '1');
        argv.push('-color_primaries', String(options.colorPrimaries));
        argv.push('-color_trc', String(options.colorTrc));
        argv.push('-colorspace', String(options.colorspace));
        var av1Meta = av1ColorMetadataArgs(options.colorPrimaries, options.colorTrc, options.colorspace);
        // AV1 metadata is valid only for the encoded primary, never MJPEG/PNG cover art.
        argv.push('-bsf:v:0', av1Meta.bsf);
        argv.push('-metadata:s:v:0', 'COLOR_PRIMARIES=' + options.colorPrimaries);
        argv.push('-metadata:s:v:0', 'COLOR_TRANSFER=' + options.colorTrc);
        argv.push('-metadata:s:v:0', 'COLOR_SPACE=' + options.colorspace);
        argv.push('-max_muxing_queue_size', '4096');
    }
    // For a Matroska source the FFmpeg stage is intentionally video-only. MKVToolNix later
    // takes every non-video payload directly from the original, bypassing FFmpeg content-
    // encoding limitations such as zlib-compressed PGS. Other containers retain the scoped
    // FFmpeg stream-copy plan.
    argv.push('-map', canonicalInput ? '0:v:0' : videoStreamPlan.primaryInputMap);
    if (options.matroskaVideoOnly === true) {
        argv.push('-map_metadata', '-1', '-map_chapters', '-1', '-an', '-sn', '-dn');
    } else {
        videoStreamPlan.attachedPictureInputMaps.forEach(function (inputMap) {
            argv.push('-map', canonicalInput
                ? String(inputMap).replace(/^0:/, '1:') : inputMap);
        });
        var ancillaryInput = canonicalInput ? '1' : '0';
        argv.push('-map', ancillaryInput + ':a?', '-map', ancillaryInput + ':s?',
            '-map', ancillaryInput + ':t?');
        argv.push('-map_metadata', ancillaryInput, '-map_chapters', ancillaryInput, '-dn');
        videoStreamPlan.attachedPictureInputMaps.forEach(function (_inputMap, index) {
            var outputVideoIndex = index + 1;
            argv.push('-c:v:' + outputVideoIndex, 'copy');
            argv.push('-disposition:v:' + outputVideoIndex, 'attached_pic');
        });
        argv.push('-c:a', 'copy', '-c:s', 'copy', '-c:t', 'copy');
    }
    argv.push('-y', String(options.outputPath));
    nvencTemporalFilter.assertAv1NvencCommand(argv, temporalPolicy, 'final AV1 production transcode');
    if (canonicalInput) canonicalDenoise.assertCanonicalExactlyOnce(argv, 'final AV1 production transcode');
    else canonicalDenoise.assertAbsent(argv, 'original-source final AV1 production transcode');
    return argv;
}

function resolveFinalTranscodeCQ(bestParams, variables) {
    var rawCQ = bestParams && bestParams.quality;
    if (rawCQ === null || rawCQ === undefined || (typeof rawCQ === 'string' && rawCQ.trim() === '')) {
        throw new Error('selected parameter set has no finite CQ');
    }
    var cq = Number(rawCQ);
    if (!isFinite(cq)) throw new Error('selected parameter set has no finite CQ');

    var contractedCQ = variables && variables.vmafFinalSelectedCQ;
    if (contractedCQ !== null && contractedCQ !== undefined && contractedCQ !== '') {
        contractedCQ = Number(contractedCQ);
        if (!isFinite(contractedCQ) || Math.abs(contractedCQ - cq) > 0.000001) {
            throw new Error('final selected CQ contract mismatch: selector=' + contractedCQ + ', parameters=' + cq);
        }
    }

    var contractedId = String((variables && variables.vmafSelectedParameterSetId) || '').trim();
    var parameterSetId = String((bestParams && bestParams.id) || '').trim();
    if (contractedId && contractedId !== parameterSetId) {
        throw new Error('final selected parameter-set contract mismatch: selector=' + contractedId
            + ', parameters=' + parameterSetId);
    }
    return cq;
}

var executableIdentityCache = new Map();

function executableByteIdentity(requestedPath, resolvedPath, stat) {
    // Filesystem instance metadata is deliberately cache-only. Persisting ctime,
    // inode, or mtime would invalidate an otherwise identical checkpoint every
    // time the container recreates its launcher wrapper.
    var cacheKey = [resolvedPath, stat.size, stat.mtimeNs, stat.ctimeNs, stat.dev, stat.ino]
        .map(String).join('\u0000');
    var digest = executableIdentityCache.get(cacheKey);
    if (!digest) {
        digest = postEncodeCheckpoint.sha256FileSync(resolvedPath);
        executableIdentityCache.set(cacheKey, digest);
        while (executableIdentityCache.size > 32) {
            executableIdentityCache.delete(executableIdentityCache.keys().next().value);
        }
    }
    return {
        requested_path: String(requestedPath),
        resolved_path: resolvedPath,
        size_bytes: Number(stat.size),
        sha256_full: digest,
    };
}

function readExecutablePrefix(filePath, sizeBytes) {
    var fs = require('fs');
    var length = Math.min(Number(sizeBytes), 64 * 1024);
    var buffer = Buffer.alloc(length);
    var handle = fs.openSync(filePath, 'r');
    try {
        var count = fs.readSync(handle, buffer, 0, length, 0);
        return buffer.subarray(0, count).toString('utf8');
    } finally {
        fs.closeSync(handle);
    }
}

function absoluteShellExecTarget(scriptText) {
    if (String(scriptText || '').slice(0, 2) !== '#!') return null;
    var match = String(scriptText).match(
        /^[ \t]*exec[ \t]+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^ \t\r\n"'$;&|<>]+))[ \t]+["']\$@["'][ \t]*$/m);
    var target = match && (match[1] || match[2] || match[3]);
    return target ? String(target) : null;
}

function resolveExecutableIdentity(executable) {
    var fs = require('fs');
    var path = require('path');
    var requested = String(executable || '');
    var candidates = [];
    if (path.isAbsolute(requested) || requested.indexOf(path.sep) !== -1 ||
            (path.sep === '\\' && requested.indexOf('/') !== -1)) {
        candidates.push(requested);
    } else {
        String(process.env.PATH || '').split(path.delimiter).filter(Boolean).forEach(function (directory) {
            candidates.push(path.join(directory, requested));
            if (process.platform === 'win32' && !path.extname(requested)) {
                String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean).forEach(function (extension) {
                    candidates.push(path.join(directory, requested + extension.toLowerCase()));
                    candidates.push(path.join(directory, requested + extension.toUpperCase()));
                });
            }
        });
    }
    for (var i = 0; i < candidates.length; i += 1) {
        var resolved;
        var stat;
        try {
            resolved = fs.realpathSync(candidates[i]);
            stat = fs.statSync(resolved, { bigint: true });
        } catch (_) {}
        if (!resolved || !stat || !stat.isFile() || stat.size <= 0n) continue;

        var identity = executableByteIdentity(requested, resolved, stat);
        var prefix = readExecutablePrefix(resolved, stat.size);
        var target = absoluteShellExecTarget(prefix);
        var isProductionWrapper = path.basename(requested).toLowerCase() === 'tdarr-ffmpeg' ||
            path.basename(candidates[i]).toLowerCase() === 'tdarr-ffmpeg';
        if (target) {
            if (!path.isAbsolute(target)) {
                throw new Error('post-encode checkpoint cannot authenticate a non-absolute FFmpeg wrapper target: ' + target);
            }
            var targetResolved;
            var targetStat;
            try {
                targetResolved = fs.realpathSync(target);
                targetStat = fs.statSync(targetResolved, { bigint: true });
            } catch (targetError) {
                throw new Error('post-encode checkpoint cannot authenticate FFmpeg wrapper target ' +
                    target + ': ' + targetError.message);
            }
            if (!targetStat.isFile() || targetStat.size <= 0n) {
                throw new Error('post-encode checkpoint FFmpeg wrapper target is not a non-empty file: ' + target);
            }
            identity.effective_target = executableByteIdentity(target, targetResolved, targetStat);
        } else if (isProductionWrapper) {
            throw new Error('post-encode checkpoint cannot authenticate the effective absolute exec target ' +
                'of the production tdarr-ffmpeg wrapper');
        }
        return identity;
    }
    // Unit harnesses sometimes provide a virtual executable. Production uses an
    // installed tdarr-ffmpeg wrapper and authenticates both it and its target above.
    return { requested_path: requested, resolved_path: null, unresolved: true };
}

function buildPostEncodeContract(executable, argv, sourcePath, outputPath, pipelineTools) {
    var source = String(sourcePath);
    var output = String(outputPath);
    var producerLog = pipelineTools && pipelineTools.producerLog
        ? String(pipelineTools.producerLog) : null;
    var contract = {
        schema: pipelineTools ? 2 : 1,
        executable: String(executable),
        executable_identity: resolveExecutableIdentity(executable),
        argv: (argv || []).map(function (item) {
            var value = String(item);
            if (value === source) return '<SOURCE>';
            if (value === output) return '<OUTPUT>';
            if (producerLog && value === producerLog) return '<PRODUCER_LOG>';
            return value;
        }),
    };
    if (pipelineTools) {
        contract.pipeline = pipelineTools.pipeline;
        contract.producer_identity = resolveExecutableIdentity(pipelineTools.producer);
        contract.consumer_identity = resolveExecutableIdentity(pipelineTools.consumer);
    }
    return contract;
}

function mediaDurationSeconds(probe) {
    var formatDuration = Number(probe && probe.format && probe.format.duration);
    if (isFinite(formatDuration) && formatDuration > 0) return formatDuration;
    var streams = probe && Array.isArray(probe.streams) ? probe.streams : [];
    for (var i = 0; i < streams.length; i += 1) {
        var streamDuration = Number(streams[i] && streams[i].duration);
        if (isFinite(streamDuration) && streamDuration > 0) return streamDuration;
    }
    return null;
}

function parseFrameRate(value) {
    var match = String(value || '').match(/^(-?\d+(?:\.\d+)?)(?:\/(-?\d+(?:\.\d+)?))?$/);
    if (!match) return null;
    var numerator = Number(match[1]);
    var denominator = match[2] === undefined ? 1 : Number(match[2]);
    var rate = denominator !== 0 ? numerator / denominator : NaN;
    return isFinite(rate) && rate > 0 ? rate : null;
}

function selectedOutputGeometry(bestParams, variables) {
    bestParams = bestParams || {};
    variables = variables || {};
    var selected = variables.vmafSelectedOutputResolution || {};
    var width = Number(selected.width || variables.vmafSelectedOutputWidth ||
        bestParams.outputWidth || bestParams.width);
    var height = Number(selected.height || variables.vmafSelectedOutputHeight ||
        bestParams.outputHeight || bestParams.height);
    return {
        width: Number.isInteger(width) && width > 0 ? width : null,
        height: Number.isInteger(height) && height > 0 ? height : null,
    };
}

function hasConfirmedMediaCorruption(stderr) {
    var message = String(stderr || '');
    return /invalid data found|error while decoding|corrupt(?:ion|ed)?|(?:invalid|malformed|truncated)\s+(?:av1\s+)?(?:obu|packet|frame|bitstream|temporal unit|sequence header)|(?:failed|error)\s+(?:to parse|parsing)\s+(?:an?\s+)?(?:av1|obu|temporal unit|sequence header)/i.test(message);
}

function distributedDecodeOffsets(durationSeconds, sampleSeconds) {
    var duration = Number(durationSeconds);
    var sample = Number(sampleSeconds);
    if (!(duration > 0) || !(sample > 0)) return [0];
    var latest = Math.max(0, duration - sample);
    var candidates = [0, latest / 2, latest];
    var offsets = [];
    candidates.forEach(function (candidate) {
        var rounded = Number(Math.max(0, candidate).toFixed(3));
        if (offsets.indexOf(rounded) === -1) offsets.push(rounded);
    });
    return offsets;
}

function decodeValidationArgs(filePath, offsetSeconds, durationSeconds, useCuda) {
    var args = ['-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode'];
    if (useCuda) args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
    if (offsetSeconds !== null && offsetSeconds !== undefined) {
        args.push('-ss', Number(offsetSeconds).toFixed(3));
    }
    args.push('-i', String(filePath));
    if (durationSeconds !== null && durationSeconds !== undefined) {
        args.push('-t', Number(durationSeconds).toFixed(3));
    }
    args.push('-map', '0:v:0', '-an', '-sn', '-dn', '-f', 'null', '-');
    return args;
}

function runDecodeValidation(ffmpegPath, filePath, offsetSeconds, durationSeconds, timeoutMs) {
    var spawnSync = require('child_process').spawnSync;
    var cudaResult = spawnSync(String(ffmpegPath), decodeValidationArgs(
        filePath, offsetSeconds, durationSeconds, true), {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
    });
    if (!cudaResult.error && cudaResult.status === 0) {
        return { backend: 'nvdec', stderr: String(cudaResult.stderr || '') };
    }
    if (hasConfirmedMediaCorruption(cudaResult && cudaResult.stderr)) {
        throw postEncodeCheckpoint.confirmedInvalidError(
            'post-encode AV1 GPU decode confirmed corruption: ' +
            String(cudaResult.stderr || '').trim());
    }

    // CUDA decode is an optimization, not a production dependency. A missing
    // driver/decoder or transient GPU setup failure falls back to the same
    // bounded software sample instead of rejecting otherwise healthy media.
    var softwareResult = spawnSync(String(ffmpegPath), decodeValidationArgs(
        filePath, offsetSeconds, durationSeconds, false), {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
    });
    if (softwareResult.error) {
        throw new Error('post-encode AV1 bounded decode validation failed: ' +
            softwareResult.error.message);
    }
    if (softwareResult.status !== 0) {
        var failure = String(softwareResult.stderr || '').trim();
        if (hasConfirmedMediaCorruption(failure)) {
            throw postEncodeCheckpoint.confirmedInvalidError(
                'post-encode AV1 bounded decode confirmed corruption: ' + failure);
        }
        throw new Error('post-encode AV1 bounded decode validation failed: ' + failure);
    }
    return { backend: 'software', stderr: String(softwareResult.stderr || '') };
}

function packetCountFromPrimaryVideo(probe) {
    var streams = probe && Array.isArray(probe.streams) ? probe.streams : [];
    var primary = streams.filter(function (stream) {
        return stream && stream.codec_type === 'video' && !isAttachedPictureStream(stream);
    })[0];
    var count = Number(primary && primary.nb_read_packets);
    return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function measuredSourcePacketCount(ffprobePath, sourcePath, sourceProbe) {
    var embeddedCount = packetCountFromPrimaryVideo(sourceProbe);
    if (embeddedCount !== null) return embeddedCount;
    if (!sourcePath) {
        throw new Error('source packet coverage requires the original source path');
    }
    var spawnSync = require('child_process').spawnSync;
    var result = spawnSync(String(ffprobePath || 'ffprobe'), [
        '-v', 'error', '-count_packets', '-show_streams', '-of', 'json', String(sourcePath)
    ], { encoding: 'utf8', timeout: 3600000, maxBuffer: 32 * 1024 * 1024 });
    if (result.error) {
        throw new Error('source packet-count validation failed: ' + result.error.message);
    }
    var parsed;
    try { parsed = JSON.parse(result.stdout || '{}'); }
    catch (error) {
        throw new Error('source packet-count ffprobe returned invalid JSON: ' + error.message);
    }
    var measuredCount = packetCountFromPrimaryVideo(parsed);
    if (result.status !== 0 || measuredCount === null) {
        throw new Error('source packet-count validation did not produce a complete primary-video count' +
            (String(result.stderr || '').trim() ? ': ' + String(result.stderr || '').trim() : ''));
    }
    return measuredCount;
}

function validatePostEncodeMedia(ffprobePath, ffmpegPath, filePath, sourceProbe, expectedGeometry, requireVideoOnly, validationOptions) {
    var fs = require('fs');
    var spawnSync = require('child_process').spawnSync;
    validationOptions = validationOptions || {};
    var validationMode = validationOptions.mode === 'exhaustive' ? 'exhaustive' : 'routine';
    var stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
        throw postEncodeCheckpoint.confirmedInvalidError(
            'post-encode AV1 is not a non-empty regular file');
    }
    var probeResult = spawnSync(String(ffprobePath || 'ffprobe'), [
        '-v', 'error', '-count_packets', '-show_streams', '-show_format', '-of', 'json', String(filePath)
    ], { encoding: 'utf8', timeout: 3600000, maxBuffer: 32 * 1024 * 1024 });
    if (probeResult.error) {
        throw new Error('post-encode AV1 demux validation failed: ' +
            probeResult.error.message);
    }
    if (probeResult.status !== 0) {
        var probeFailure = 'post-encode AV1 demux validation failed: ' +
            String(probeResult.stderr || '').trim();
        if (hasConfirmedMediaCorruption(probeResult.stderr)) {
            throw postEncodeCheckpoint.confirmedInvalidError(probeFailure);
        }
        throw new Error(probeFailure);
    }
    var parsed;
    try { parsed = JSON.parse(probeResult.stdout || '{}'); }
    catch (error) { throw new Error('post-encode ffprobe returned invalid JSON: ' + error.message); }
    if (!parsed || !parsed.format || !Array.isArray(parsed.streams)) {
        throw postEncodeCheckpoint.confirmedInvalidError(
            'post-encode ffprobe returned incomplete media inventory');
    }
    var ordinaryVideos = parsed.streams.filter(function (stream) {
        return stream && stream.codec_type === 'video' && !isAttachedPictureStream(stream);
    });
    if (ordinaryVideos.length !== 1) {
        throw postEncodeCheckpoint.confirmedInvalidError(
            'post-encode output must contain exactly one ordinary video stream; found ' +
            ordinaryVideos.length);
    }
    if (requireVideoOnly && parsed.streams.length !== 1) {
        throw postEncodeCheckpoint.confirmedInvalidError(
            'protected Matroska encoder checkpoint must contain exactly one total stream; found ' +
            parsed.streams.length);
    }
    var primary = ordinaryVideos[0];
    if (String(primary.codec_name || '').toLowerCase() !== 'av1') {
        throw postEncodeCheckpoint.confirmedInvalidError('post-encode primary video is not AV1');
    }
    var packetCount = Number(primary.nb_read_packets);
    if (!Number.isSafeInteger(packetCount) || packetCount <= 0) {
        throw postEncodeCheckpoint.confirmedInvalidError(
            'post-encode AV1 has no complete demuxed packet count');
    }
    expectedGeometry = expectedGeometry || {};
    ['width', 'height'].forEach(function (key) {
        // Resolution is an optimization dimension. Bind only an explicitly selected
        // output geometry, never the source dimensions by assumption.
        var expected = Number(expectedGeometry[key]);
        var actual = Number(primary[key]);
        if (isFinite(expected) && expected > 0 && actual !== expected) {
            throw postEncodeCheckpoint.confirmedInvalidError(
                'post-encode AV1 ' + key + ' changed from ' + expected + ' to ' + actual);
        }
    });
    var sourceDuration = mediaDurationSeconds(sourceProbe);
    var outputDuration = mediaDurationSeconds(parsed);
    if (!(outputDuration > 0)) {
        throw postEncodeCheckpoint.confirmedInvalidError(
            'post-encode AV1 has no finite positive duration');
    }
    if (sourceDuration > 0) {
        var durationTolerance = Math.max(1, Math.min(5, sourceDuration * 0.001));
        if (Math.abs(sourceDuration - outputDuration) > durationTolerance) {
            throw postEncodeCheckpoint.confirmedInvalidError(
                'post-encode AV1 duration differs from source by ' +
                Math.abs(sourceDuration - outputDuration).toFixed(3) + ' seconds');
        }
    }
    // Container duration multiplied by nominal frame rate is not a measured
    // frame count. Sparse, VFR, or damaged-but-decodable Matroska sources can
    // legitimately carry fewer packets (and stale NUMBER_OF_FRAMES tags).
    // Compare two demuxed packet counts instead; inability to authenticate the
    // source count is retryable and must not condemn a completed candidate.
    var sourcePacketCount = measuredSourcePacketCount(
        ffprobePath, validationOptions.sourcePath, sourceProbe);
    var sourceFrameRate = parseFrameRate(
        (sourceProbe && sourceProbe.streams && sourceProbe.streams[0] &&
            (sourceProbe.streams[0].avg_frame_rate || sourceProbe.streams[0].r_frame_rate)) ||
        primary.avg_frame_rate || primary.r_frame_rate);
    var packetTolerance = Math.max(2, Math.ceil((sourceFrameRate || 24) * 2));
    if (sourcePacketCount >= 100 && packetCount + packetTolerance < sourcePacketCount) {
        throw postEncodeCheckpoint.confirmedInvalidError(
            'post-encode AV1 packet coverage is incomplete: source=' +
            sourcePacketCount + ', output=' + packetCount + ', tolerance=' + packetTolerance);
    }
    var decodeBackends = [];
    var decodeOffsets = [];
    if (validationMode === 'exhaustive') {
        var exhaustiveDecode = runDecodeValidation(
            ffmpegPath, filePath, null, null, POSTENCODE_EXHAUSTIVE_TIMEOUT_MS);
        decodeBackends.push(exhaustiveDecode.backend);
    } else {
        decodeOffsets = distributedDecodeOffsets(outputDuration, POSTENCODE_SAMPLE_SECONDS);
        decodeOffsets.forEach(function (offset) {
            var sampledDecode = runDecodeValidation(
                ffmpegPath, filePath, offset, POSTENCODE_SAMPLE_SECONDS,
                POSTENCODE_SAMPLE_TIMEOUT_MS);
            decodeBackends.push(sampledDecode.backend);
        });
    }
    return {
        validator: validationMode === 'exhaustive'
            ? POSTENCODE_EXHAUSTIVE_VALIDATOR : POSTENCODE_ROUTINE_VALIDATOR,
        format_name: String(parsed.format.format_name || ''),
        size_bytes: stat.size,
        duration_seconds: Number(outputDuration.toFixed(6)),
        stream_count: parsed.streams.length,
        ordinary_video_streams: ordinaryVideos.length,
        primary: {
            codec_name: 'av1',
            width: Number(primary.width) || null,
            height: Number(primary.height) || null,
            pix_fmt: String(primary.pix_fmt || ''),
            avg_frame_rate: String(primary.avg_frame_rate || ''),
            packet_count: packetCount,
            source_packet_count: sourcePacketCount,
            packet_count_delta: packetCount - sourcePacketCount,
            packet_tolerance: packetTolerance,
        },
        full_primary_video_decode: validationMode === 'exhaustive',
        decode_policy: validationMode === 'exhaustive'
            ? {
                mode: 'exhaustive',
                backend: decodeBackends[0] || null,
            }
            : {
                mode: 'distributed_samples',
                sample_seconds: POSTENCODE_SAMPLE_SECONDS,
                offsets_seconds: decodeOffsets,
                backends: decodeBackends,
            },
    };
}

function sha256Canonical(value) {
    return require('crypto').createHash('sha256')
        .update(postEncodeCheckpoint.canonicalJson(value), 'utf8').digest('hex');
}

function protectedPathWithin(rootPath, childPath) {
    var path = require('path');
    var relative = path.relative(path.resolve(rootPath), path.resolve(childPath));
    return relative !== '' && relative !== '..' &&
        !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function assertProtectedRealDirectory(directory, description) {
    var fs = require('fs');
    var path = require('path');
    var resolved = path.resolve(String(directory || ''));
    if (!resolved || resolved === path.parse(resolved).root) {
        throw new Error(description + ' path is empty or unsafe');
    }
    var stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(description + ' is not a real directory');
    }
    if (path.resolve(fs.realpathSync(resolved)) !== resolved) {
        throw new Error(description + ' contains a symlinked path component');
    }
    return resolved;
}

function readProtectedRecoveryJson(filePath, description) {
    var fs = require('fs');
    var path = require('path');
    var resolved = path.resolve(String(filePath || ''));
    var stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 ||
        stat.size > MAX_RETAINED_RECOVERY_JSON_BYTES) {
        throw new Error(description + ' is not a bounded regular file');
    }
    if (path.resolve(fs.realpathSync(resolved)) !== resolved) {
        throw new Error(description + ' contains a symlinked path component');
    }
    var value = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(description + ' is not a JSON object');
    }
    return value;
}

function isSha256(value) {
    return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function assertCqOnlyConservativeContractDelta(requestedContract, retainedContract) {
    if (!requestedContract || !retainedContract ||
        typeof requestedContract !== 'object' || typeof retainedContract !== 'object') {
        throw new Error('conservative checkpoint substitution requires two exact encode contracts');
    }
    var requestedKeys = Object.keys(requestedContract).sort();
    var retainedKeys = Object.keys(retainedContract).sort();
    if (JSON.stringify(requestedKeys) !== JSON.stringify(retainedKeys)) {
        throw new Error('retained encode contract has different top-level fields');
    }
    for (var keyIndex = 0; keyIndex < requestedKeys.length; keyIndex += 1) {
        var key = requestedKeys[keyIndex];
        if (key === 'argv') continue;
        if (postEncodeCheckpoint.canonicalJson(requestedContract[key]) !==
            postEncodeCheckpoint.canonicalJson(retainedContract[key])) {
            throw new Error('retained encode contract differs outside CQ at ' + key);
        }
    }
    if (!Array.isArray(requestedContract.argv) || !Array.isArray(retainedContract.argv) ||
        requestedContract.argv.length !== retainedContract.argv.length) {
        throw new Error('retained encode contract argv shape differs');
    }
    var requestedCqIndexes = [];
    var retainedCqIndexes = [];
    for (var i = 0; i < requestedContract.argv.length; i += 1) {
        if (String(requestedContract.argv[i]) === '-cq') requestedCqIndexes.push(i);
        if (String(retainedContract.argv[i]) === '-cq') retainedCqIndexes.push(i);
    }
    if (requestedCqIndexes.length !== 1 || retainedCqIndexes.length !== 1 ||
        requestedCqIndexes[0] !== retainedCqIndexes[0] ||
        requestedCqIndexes[0] + 1 >= requestedContract.argv.length) {
        throw new Error('encode contracts do not contain one aligned CQ field');
    }
    var cqValueIndex = requestedCqIndexes[0] + 1;
    for (var argvIndex = 0; argvIndex < requestedContract.argv.length; argvIndex += 1) {
        if (argvIndex === cqValueIndex) continue;
        if (String(requestedContract.argv[argvIndex]) !== String(retainedContract.argv[argvIndex])) {
            throw new Error('retained encode contract differs outside CQ at argv[' + argvIndex + ']');
        }
    }
    var requestedCQ = Number(requestedContract.argv[cqValueIndex]);
    var retainedCQ = Number(retainedContract.argv[cqValueIndex]);
    if (!isFinite(requestedCQ) || requestedCQ < 0 || requestedCQ > 63 ||
        !Number.isInteger(retainedCQ) || retainedCQ < 0 || retainedCQ > 63) {
        throw new Error('conservative checkpoint substitution has an invalid CQ value');
    }
    if (retainedCQ > requestedCQ) {
        throw new Error('retained CQ ' + retainedCQ +
            ' is less conservative than requested CQ ' + requestedCQ);
    }
    return {
        requestedCQ: requestedCQ,
        retainedCQ: retainedCQ,
        argvIndex: cqValueIndex,
        relation: 'identical_except_lower_cq',
    };
}

function measurementParameterContract(parameterSet) {
    if (!parameterSet || typeof parameterSet !== 'object' || Array.isArray(parameterSet)) {
        return null;
    }
    var contract = {};
    Object.keys(parameterSet).sort().forEach(function (key) {
        if (key === 'id' || key === 'quality' || key === 'cq') return;
        if (parameterSet[key] !== undefined) contract[key] = parameterSet[key];
    });
    return contract;
}

function measurementParameterContractSha256(parameterSet) {
    var contract = measurementParameterContract(parameterSet);
    return contract ? sha256Canonical(contract) : '';
}

function currentMeasurementForCQ(variables, cq, expectedParameterSet) {
    var results = variables && Array.isArray(variables.vmafAggregatedResults)
        ? variables.vmafAggregatedResults : [];
    var expectedParameterContractSha256 =
        measurementParameterContractSha256(expectedParameterSet);
    var matches = results.filter(function (result) {
        var parameterSet = result && result.parameterSet || {};
        var measuredCQ = Number(parameterSet.quality !== undefined
            ? parameterSet.quality : parameterSet.cq);
        return isFinite(measuredCQ) && Math.abs(measuredCQ - Number(cq)) < 0.000001 &&
            !result.reusedFromJobId &&
            (!expectedParameterContractSha256 ||
                measurementParameterContractSha256(parameterSet) ===
                    expectedParameterContractSha256);
    }).sort(function (left, right) {
        return (Number(right.sampleCount) || 0) - (Number(left.sampleCount) || 0);
    });
    if (matches.length === 0) return null;
    var selected = matches[0];
    return {
        parameter_set_id: String(selected.parameterSetId || ''),
        avg_vmaf: isFinite(Number(selected.avgVMAF)) ? Number(selected.avgVMAF) : null,
        min_vmaf: isFinite(Number(selected.minVMAF)) ? Number(selected.minVMAF) : null,
        p1_vmaf: isFinite(Number(selected.vmafP1Low)) ? Number(selected.vmafP1Low) : null,
        avg_cambi: isFinite(Number(selected.avgCAMBI)) ? Number(selected.avgCAMBI) : null,
        max_cambi: isFinite(Number(selected.maxCAMBI)) ? Number(selected.maxCAMBI) : null,
        p95_cambi: isFinite(Number(selected.p95CAMBI)) ? Number(selected.p95CAMBI) : null,
        avg_sample_size_mb: isFinite(Number(selected.avgFileSizeMB))
            ? Number(selected.avgFileSizeMB) : null,
        sample_count: Number.isSafeInteger(Number(selected.sampleCount))
            ? Number(selected.sampleCount) : null,
        measurement_origin: String(selected.measurementOrigin || ''),
        measurement_job_id: String(selected.measurementJobId || ''),
        parameter_set_contract_sha256:
            measurementParameterContractSha256(selected.parameterSet),
    };
}

function resolveConservativeRetainedCqSubstitution(requestedContext, options) {
    options = options || {};
    if (!requestedContext || !requestedContext.plan || !requestedContext.sourceFingerprint) {
        throw new Error('requested protected plan is incomplete');
    }
    var fs = require('fs');
    var path = require('path');
    var checkpointRoot = path.resolve(String(options.checkpointRoot || ''));
    var reuseRequiredRoot = path.resolve(String(options.reuseRequiredRoot || ''));
    if (options.enforcePinnedStorage === true) {
        postEncodeCheckpoint.assertPinnedStorage(checkpointRoot, reuseRequiredRoot);
    }
    postEncodeCheckpoint.assertReuseRequiredRoot(reuseRequiredRoot);
    checkpointRoot = assertProtectedRealDirectory(checkpointRoot, 'post-encode checkpoint root');

    var sourceFingerprint = requestedContext.sourceFingerprint;
    var sourceScopeKey = sha256Canonical({
        contract_id: postEncodeCheckpoint.REUSE_REQUIRED_CONTRACT_ID,
        source_fingerprint: sourceFingerprint,
    });
    var markerBucket = path.join(reuseRequiredRoot, sourceScopeKey.slice(0, 2));
    var markerPath = path.join(markerBucket, sourceScopeKey + '.json');
    if (!protectedPathWithin(reuseRequiredRoot, markerPath)) {
        throw new Error('derived retained marker escaped its protected root');
    }
    assertProtectedRealDirectory(markerBucket, 'reuse-required marker bucket');
    var marker = readProtectedRecoveryJson(markerPath, 'reuse-required marker');
    if (marker.schema !== postEncodeCheckpoint.REUSE_REQUIRED_SCHEMA ||
        marker.contract_id !== postEncodeCheckpoint.REUSE_REQUIRED_CONTRACT_ID ||
        marker.state !== 'reuse_required' || marker.created_by !== 'retained-output-import-v1' ||
        marker.source_scope_key !== sourceScopeKey ||
        postEncodeCheckpoint.canonicalJson(marker.source_fingerprint) !==
            postEncodeCheckpoint.canonicalJson(sourceFingerprint) ||
        !isSha256(marker.checkpoint_key) || !isSha256(marker.encode_contract_sha256) ||
        !marker.source || !isSha256(marker.source.sha256_full) ||
        !marker.artifact || !Number.isSafeInteger(Number(marker.artifact.size_bytes)) ||
        Number(marker.artifact.size_bytes) <= 0 || !isSha256(marker.artifact.sha256_full)) {
        throw new Error('reuse-required marker identity is invalid');
    }

    var checkpointBucket = path.join(checkpointRoot, marker.checkpoint_key.slice(0, 2));
    var checkpointEntry = path.join(checkpointBucket, marker.checkpoint_key);
    var manifestPath = path.join(checkpointEntry, 'manifest.json');
    if (!protectedPathWithin(checkpointRoot, manifestPath)) {
        throw new Error('derived retained manifest escaped its protected root');
    }
    assertProtectedRealDirectory(checkpointBucket, 'retained checkpoint bucket');
    assertProtectedRealDirectory(checkpointEntry, 'retained checkpoint entry');
    var manifest = readProtectedRecoveryJson(manifestPath, 'retained checkpoint manifest');
    var encodeContractSha256 = sha256Canonical(manifest.encode_contract);
    var expectedCheckpointKey = sha256Canonical({
        contract_id: postEncodeCheckpoint.CONTRACT_ID,
        source_fingerprint: sourceFingerprint,
        encode_contract_sha256: encodeContractSha256,
    });
    if (manifest.schema !== postEncodeCheckpoint.SCHEMA ||
        manifest.contract_id !== postEncodeCheckpoint.CONTRACT_ID ||
        manifest.checkpoint_key !== marker.checkpoint_key ||
        expectedCheckpointKey !== marker.checkpoint_key ||
        manifest.encode_contract_sha256 !== encodeContractSha256 ||
        encodeContractSha256 !== marker.encode_contract_sha256 ||
        postEncodeCheckpoint.canonicalJson(manifest.source_fingerprint) !==
            postEncodeCheckpoint.canonicalJson(sourceFingerprint) ||
        !manifest.artifact ||
        Number(manifest.artifact.size_bytes) !== Number(marker.artifact.size_bytes) ||
        manifest.artifact.sha256_full !== marker.artifact.sha256_full) {
        throw new Error('retained checkpoint manifest identity does not match its latch');
    }
    var artifactName = String(manifest.artifact.relative_path || '');
    if (!artifactName || artifactName === '.' || artifactName === '..' ||
        path.basename(artifactName) !== artifactName) {
        throw new Error('retained checkpoint artifact path is unsafe');
    }
    var artifactPath = path.join(checkpointEntry, artifactName);
    if (!protectedPathWithin(checkpointEntry, artifactPath)) {
        throw new Error('retained checkpoint artifact escaped its protected entry');
    }
    var artifactStat = fs.lstatSync(artifactPath);
    if (!artifactStat.isFile() || artifactStat.isSymbolicLink() ||
        artifactStat.size !== Number(marker.artifact.size_bytes) ||
        path.resolve(fs.realpathSync(artifactPath)) !== path.resolve(artifactPath)) {
        throw new Error('retained checkpoint artifact is not the expected regular file');
    }
    var mediaValidation = manifest.media_validation || {};
    if (mediaValidation.validator !== 'ffprobe-demux-plus-full-decode-v1' ||
        mediaValidation.full_primary_video_decode !== true ||
        Number(mediaValidation.size_bytes) !== artifactStat.size ||
        !mediaValidation.primary || mediaValidation.primary.codec_name !== 'av1') {
        throw new Error('retained checkpoint lacks an authenticated full AV1 decode');
    }

    var delta = assertCqOnlyConservativeContractDelta(
        requestedContext.encodeContract, manifest.encode_contract);
    var alternateOptions = Object.assign({}, options, { useCQ: delta.retainedCQ });
    var alternateContext = buildProtectedPostEncodePlan(alternateOptions);
    if (postEncodeCheckpoint.canonicalJson(alternateContext.encodeContract) !==
            postEncodeCheckpoint.canonicalJson(manifest.encode_contract) ||
        alternateContext.plan.checkpointKey !== marker.checkpoint_key ||
        alternateContext.plan.encodeContractSha256 !== marker.encode_contract_sha256 ||
        alternateContext.plan.artifactPath !== artifactPath ||
        alternateContext.plan.manifestPath !== manifestPath ||
        alternateContext.plan.reused !== true) {
        throw new Error('rebuilt conservative checkpoint plan does not exactly match the imported generation');
    }
    return {
        context: alternateContext,
        marker: marker,
        manifest: manifest,
        delta: delta,
        markerPath: markerPath,
    };
}

function buildProtectedPostEncodePlan(options) {
    options = options || {};
    var spawnArgs;
    var spawnExecutable = options.ffmpegPath;
    var pipelineTools = null;
    try {
        var ffmpegConsumerArgs = buildFinalTranscodeArgs({
            bestParams: options.bestParams,
            originalFile: options.originalFile,
            outputPath: options.contractOutputPath,
            pixFmt: options.pixFmt,
            useCQ: options.useCQ,
            nvencFlagArgs: options.variables && options.variables.vmafNvencFlagArgs,
            colorPrimaries: options.colorPrimaries,
            colorTrc: options.colorTrc,
            colorspace: options.colorspace,
            canonicalDenoise: options.useCanonicalDenoise,
            temporalPolicy: options.temporalPolicy,
            ffProbeData: options.inputProbeData,
            requireStreamInventory: true,
            matroskaVideoOnly: options.useMatroskaAncillaryBypass,
        });
        if (options.useCanonicalDenoise) {
            var coordinatorFfmpegPath = resolveExecutablePath(
                options.ffmpegPath, 'FFmpeg');
            var streams = options.inputProbeData &&
                Array.isArray(options.inputProbeData.streams)
                ? options.inputProbeData.streams : [];
            var primaryStream = streams.filter(function (stream) {
                return stream && stream.codec_type === 'video' &&
                    !isAttachedPictureStream(stream);
            })[0];
            if (!primaryStream) {
                throw new Error('canonical KNN final transcode requires a primary source video stream');
            }
            var outputDepth = nvenccKnn.outputDepthForStream(primaryStream);
            var nvenccPath = String(process.env.TDARR_NVENCC ||
                canonicalDenoise.NVENCC_PATH);
            var coordinatorPath = String(process.env.TDARR_NVENCC_COORDINATOR ||
                canonicalDenoise.COORDINATOR_PATH);
            var producerLog = String(options.contractOutputPath) + '.nvencc.log';
            var coordinatorOptions = {
                nvenccPath: nvenccPath,
                coordinatorPath: coordinatorPath,
                sourcePath: options.originalFile,
                outputDepth: outputDepth,
                producerLog: producerLog,
                ffmpegPath: coordinatorFfmpegPath,
                ffmpegArgs: ffmpegConsumerArgs,
            };
            spawnExecutable = coordinatorPath;
            spawnArgs = nvenccKnn.buildCoordinatorArgs(coordinatorOptions);
            pipelineTools = {
                producer: nvenccPath,
                consumer: coordinatorFfmpegPath,
                producerLog: producerLog,
                pipeline: nvenccKnn.contractDescriptor(coordinatorOptions),
            };
        } else {
            spawnArgs = ffmpegConsumerArgs;
        }
    } catch (error) {
        error.protectedPostEncodeSetupStage = 'command_policy';
        throw error;
    }
    var expectedOutputGeometry = selectedOutputGeometry(options.bestParams, options.variables);
    var validator = function (candidatePath) {
        return validatePostEncodeMedia(
            options.ffprobePath, options.ffmpegPath, candidatePath, options.inputProbeData,
            expectedOutputGeometry, options.useMatroskaAncillaryBypass, {
                mode: options.postEncodeValidationMode,
                sourcePath: options.originalFile,
            });
    };
    var sourceFingerprint = grainArtifact.sampledSourceFingerprint(options.originalFile);
    var encodeContract = buildPostEncodeContract(
        spawnExecutable, spawnArgs, options.originalFile, options.contractOutputPath,
        pipelineTools);
    var plan;
    try {
        plan = postEncodeCheckpoint.buildPlan({
            workDir: options.workDir,
            checkpointRoot: options.checkpointRoot,
            reuseRequiredRoot: options.reuseRequiredRoot,
            requireInitializedReuseRequiredRoot: options.requireInitializedReuseRequiredRoot === true,
            enforcePinnedStorage: options.enforcePinnedStorage === true,
            sourceFingerprint: sourceFingerprint,
            encodeContract: encodeContract,
            extension: require('path').extname(options.contractOutputPath) || '.mkv',
            validateArtifact: validator,
        });
    } catch (error) {
        error.protectedPostEncodeSetupStage = 'checkpoint';
        throw error;
    }
    return {
        spawnExecutable: spawnExecutable,
        spawnArgs: spawnArgs,
        validator: validator,
        sourceFingerprint: sourceFingerprint,
        encodeContract: encodeContract,
        expectedOutputGeometry: expectedOutputGeometry,
        contractOutputPath: options.contractOutputPath,
        plan: plan,
    };
}

function buildRetainedRecoveryPlan(request) {
    request = request || {};
    var variables = Object.assign({}, request.variables || {});
    var originalFile = String(request.sourcePath || '');
    var workDir = String(request.workDir || '');
    var ffmpegPath = String(request.ffmpegPath || '');
    var ffprobePath = String(request.ffprobePath || '');
    var inputProbeData = request.sourceProbe;
    if (!originalFile || !workDir || !ffmpegPath || !ffprobePath ||
        !inputProbeData || !Array.isArray(inputProbeData.streams) || !inputProbeData.format) {
        throw new Error('retained recovery requires absolute media/tool paths, workDir, and a current source probe');
    }
    if (request.preparedGrainReplay) {
        var replay = request.preparedGrainReplay;
        var expectedProfile = String(replay.expectedProfile || '');
        if (expectedProfile !== 'pq' && expectedProfile !== 'sdr') {
            throw new Error('retained recovery grain replay requires expectedProfile pq or sdr');
        }
        var replayManifestPath = String(replay.manifestPath || '');
        var replayTablePath = String(replay.tablePath || '');
        var replayPipelinePath = String(replay.pipelinePath || '');
        var replayManifest;
        try { replayManifest = JSON.parse(require('fs').readFileSync(replayManifestPath, 'utf8')); }
        catch (error) { throw new Error('retained recovery grain manifest could not be read: ' + error.message); }
        var replayEligibility = grainArtifact.classifySource(
            inputProbeData, variables, expectedProfile === 'pq' ? 'pqOnly' : 'sdrOnly');
        if (!replayEligibility.eligible || replayEligibility.profile !== expectedProfile) {
            throw new Error('retained recovery source no longer matches grain replay profile: ' +
                (replayEligibility.reason || replayEligibility.profile || 'unknown'));
        }
        var replayArtifact = grainArtifact.buildPreparedArtifact(replayManifest, {
            sourcePath: originalFile,
            tablePath: replayTablePath,
            manifestPath: replayManifestPath,
            pipelinePath: replayPipelinePath,
            expectedProfile: expectedProfile,
            dynamicEvidence: replayEligibility.dynamicEvidence || null,
        });
        variables.vmafOriginalFile = originalFile;
        variables.grainAnalysisArtifact = replayArtifact;
        variables.grainAnalysisSourcePath = originalFile;
        variables.grainAnalysisTablePath = replayTablePath;
        variables.grainAnalysisManifestPath = replayManifestPath;
        variables.grainAnalysisPreparedAt = replayArtifact.preparedAt;
        variables.grainAnalysisProfile = replayArtifact.mediaProfile;
        variables.grainAnalysisDynamicHdrProvisional = replayArtifact.provisionalDynamicHdr;
        variables.grainAnalysisStatus = 'prepared';
        variables.grainAnalysisReason = null;
    }
    var bestParams = variables.vmafBestParameters;
    if (!bestParams) throw new Error('retained recovery requires vmafBestParameters');
    if (variables.vmafOriginalFile && String(variables.vmafOriginalFile) !== originalFile) {
        throw new Error('retained recovery source differs from vmafOriginalFile');
    }
    if ((variables.isDolbyVision === true || variables.isHDR10Plus === true) &&
        variables.vmafDynamicHdrStaticFallbackAuthorized !== true) {
        throw new Error('dynamic HDR static fallback is not authorized by the terminal job contract');
    }
    if (variables.vmafRequireGpuTranscode !== false &&
        (!bestParams.isGPU || String(bestParams.encoder || '').indexOf('_nvenc') === -1)) {
        throw new Error('terminal job contract requires an NVENC final transcode');
    }

    var finalContract = grainVmafContract.assertVariables(variables, {
        context: 'terminal job',
        requireTemporalPolicy: true,
    });
    var canonicalDisposition = finalContract.disposition;
    var useCanonicalDenoise = finalContract.canonical;

    var path = require('path');
    var fileName = path.basename(originalFile, path.extname(originalFile));
    var container = selectOutputContainer(originalFile, variables, inputProbeData);
    var outputPath = path.join(workDir, fileName + '_vmaf_optimized.' + container);
    var useMatroskaAncillaryBypass = shouldUseMatroskaAncillaryBypass(
        originalFile, container, inputProbeData);
    if (useMatroskaAncillaryBypass) preflightMatroskaAncillarySource(originalFile);
    var contractOutputPath = useMatroskaAncillaryBypass
        ? path.join(workDir, fileName + '_vmaf_primary_video_only.mkv') : outputPath;
    var useCQ = resolveFinalTranscodeCQ(bestParams, variables);
    if (variables.vmafTranscodeRetryCQ !== undefined && variables.vmafTranscodeRetryCQ !== null) {
        useCQ = variables.vmafTranscodeRetryCQ;
    }
    var protectedPlan = buildProtectedPostEncodePlan({
        bestParams: bestParams,
        variables: variables,
        originalFile: originalFile,
        workDir: workDir,
        checkpointRoot: String(request.checkpointRoot || ''),
        reuseRequiredRoot: String(request.reuseRequiredRoot || ''),
        requireInitializedReuseRequiredRoot: request.requireInitializedReuseRequiredRoot === true,
        enforcePinnedStorage: request.enforcePinnedStorage === true,
        ffmpegPath: ffmpegPath,
        ffprobePath: ffprobePath,
        inputProbeData: inputProbeData,
        contractOutputPath: contractOutputPath,
        pixFmt: variables.vmafRecommendedPixFmt || variables.pix_fmt || bestParams.pixFmt || 'yuv420p',
        useCQ: useCQ,
        colorPrimaries: variables.color_primaries || bestParams.colorPrimaries || 'bt709',
        colorTrc: variables.color_trc || bestParams.colorTrc || 'bt709',
        colorspace: variables.colorspace || bestParams.colorspace || 'bt709',
        useCanonicalDenoise: useCanonicalDenoise,
        temporalPolicy: finalContract.temporalPolicy,
        useMatroskaAncillaryBypass: useMatroskaAncillaryBypass,
        // Retained imports are a one-shot trust-boundary operation. They keep
        // exhaustive decode attestation; ordinary production commits/reuses use
        // the bounded distributed validator.
        postEncodeValidationMode: 'exhaustive',
    });
    protectedPlan.outputPath = outputPath;
    protectedPlan.canonicalDisposition = canonicalDisposition;
    protectedPlan.useCanonicalDenoise = useCanonicalDenoise;
    protectedPlan.useMatroskaAncillaryBypass = useMatroskaAncillaryBypass;
    protectedPlan.deferMatroskaAncillaryForGrain = useMatroskaAncillaryBypass &&
        canonicalDisposition === 'prepared';
    protectedPlan.useCQ = useCQ;
    return protectedPlan;
}

var plugin = async function (args) {
    return __awaiter(this, void 0, void 0, function () {
        var lib, path, bestParams, originalFile, cacheDir, fileName, container, pixFmt, colorPrimaries, colorTrc, colorspace, hdrMasterDisplay, hdrMaxCll, outputPath, useMatroskaAncillaryBypass, deferMatroskaAncillaryForGrain, ffmpegOutputPath, spawnArgs, postEncodePlan, postEncodeValidator, cli, res, err;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    lib = require('../../../../../methods/lib')();
                    args.inputs = lib.loadDefaultValues(args.inputs, details);
                    path = require('path');
                    bestParams = args.variables.vmafBestParameters;
                    originalFile = args.variables.vmafOriginalFile || args.inputFileObj._id;
                    cacheDir = args.workDir || '/temp';
                    fileName = path.basename(originalFile, path.extname(originalFile));
                    container = selectOutputContainer(originalFile, args.variables,
                        args.inputFileObj && args.inputFileObj.ffProbeData);

                    // Every exit from this plugin must leave an explicit outcome. The downstream
                    // monitor used to infer success from "not cancelled by the size guard", which
                    // misclassified no-parameter and FFmpeg-error paths as successful transcodes.
                    args.variables.vmafTranscodeSucceeded = false;
                    args.variables.vmafTranscodeStatus = 'not_started';
                    args.variables.vmafTranscodeFailureReason = null;
                    args.variables.vmafAncillaryRemuxDeferred = false;
                    delete args.variables.vmafDeferredGrainBase;
                    delete args.variables.vmafFinalTranscodeRequestedCQ;
                    delete args.variables.vmafFinalTranscodeActualCQ;
                    delete args.variables.vmafPostEncodeCqSubstitution;
                    delete args.variables.vmafPostEncodeCqSubstitutionDbOutcome;
                    delete args.variables.vmafPostEncodeCheckpoint;
                    delete args.variables.vmafPostEncodeCheckpointPath;
                    delete args.variables.vmafPostEncodeCheckpointManifestPath;
                    delete args.variables.vmafPostEncodeCheckpointStatus;
                    delete args.variables.vmafPostEncodeReuseRequired;
                    delete args.variables.vmafPostEncodeReuseRequiredMarker;

                    if ((args.variables.isDolbyVision === true || args.variables.isHDR10Plus === true)
                        && args.variables.vmafDynamicHdrStaticFallbackAuthorized !== true) {
                        args.jobLog('KEEP ORIGINAL: Dynamic HDR metadata cannot be preserved by this AV1/NVENC transcode.');
                        args.variables.vmafTranscodeStatus = 'keep_original_dynamic_hdr_unsupported';
                        args.variables.vmafTranscodeFailureReason = args.variables.isDolbyVision === true
                            ? 'dolby_vision_metadata_not_preservable'
                            : 'hdr10plus_metadata_not_preservable';
                        args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                        return [2 /*return*/, {
                            outputFileObj: args.inputFileObj,
                            outputNumber: 2,
                            variables: args.variables,
                        }];
                    }

                    if (!bestParams) {
                        args.jobLog('Error: No optimal parameters found. Run Select Best Parameters first.');
                        args.variables.vmafTranscodeStatus = 'keep_original_no_parameters';
                        args.variables.vmafTranscodeFailureReason = 'no_optimal_parameters';
                        args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                        return [2 /*return*/, {
                            outputFileObj: args.inputFileObj,
                            outputNumber: 2,
                            variables: args.variables,
                        }];
                    }

                    var finalGpuRequired = args.variables.vmafRequireGpuTranscode !== false;
                    if (finalGpuRequired && (!bestParams.isGPU || String(bestParams.encoder || '').indexOf('_nvenc') === -1)) {
                        args.jobLog('ERROR: GPU final transcode is required, but selected parameters are not NVENC/GPU: ' + JSON.stringify(bestParams));
                        args.variables.vmafTranscodeStatus = 'technical_failure';
                        args.variables.vmafTranscodeFailureReason = 'gpu_encoder_required_but_not_selected';
                        args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                        return [2 /*return*/, {
                            outputFileObj: args.inputFileObj,
                            outputNumber: 2,
                            variables: args.variables,
                        }];
                    }
                    args.variables.vmafFinalTranscodeGpuRequired = finalGpuRequired;
                    args.variables.vmafFinalTranscodeGpuEncoder = bestParams.encoder;

                    var canonicalDisposition;
                    try {
                        canonicalDisposition = grainArtifact.canonicalDenoiseDisposition(args.variables);
                    } catch (grainContractError) {
                        args.jobLog('ERROR: Refusing final AV1 encode: grain-analysis authentication failed: ' + grainContractError.message);
                        args.variables.vmafTranscodeStatus = 'technical_failure';
                        args.variables.vmafTranscodeFailureReason = 'grain_analysis_contract_failed: ' + grainContractError.message;
                        args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                        return [2 /*return*/, {
                            outputFileObj: args.inputFileObj,
                            outputNumber: 2,
                            variables: args.variables,
                        }];
                    }
                    var finalContract = grainVmafContract.forDisposition(canonicalDisposition);
                    var useCanonicalDenoise = finalContract.canonical;
                    if (args.variables.vmafReferenceContractId !== finalContract.id ||
                        args.variables.vmafCanonicalDenoiseActive !== useCanonicalDenoise ||
                        args.variables.vmafNvencTemporalPolicy !== finalContract.temporalPolicy) {
                        args.jobLog('ERROR: Refusing final AV1 encode: measured sweep contract does not match grain disposition.');
                        args.variables.vmafTranscodeStatus = 'technical_failure';
                        args.variables.vmafTranscodeFailureReason = 'vmaf_reference_or_temporal_contract_mismatch';
                        args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                        return [2 /*return*/, {
                            outputFileObj: args.inputFileObj,
                            outputNumber: 2,
                            variables: args.variables,
                        }];
                    }

                    // Use recommended pixel format from VMAF analysis if available
                    pixFmt = args.variables.vmafRecommendedPixFmt || args.variables.pix_fmt || bestParams.pixFmt || 'yuv420p';
                    colorPrimaries = args.variables.color_primaries || bestParams.colorPrimaries || 'bt709';
                    colorTrc = args.variables.color_trc || bestParams.colorTrc || 'bt709';
                    colorspace = args.variables.colorspace || bestParams.colorspace || 'bt709';
                    hdrMasterDisplay = args.variables.hdr_master_display || '';
                    hdrMaxCll = args.variables.hdr_max_cll || '';
                    outputPath = cacheDir + '/' + fileName + '_vmaf_optimized.' + container;
                    var inputProbeData = args.inputFileObj && args.inputFileObj.ffProbeData;
                    useMatroskaAncillaryBypass = shouldUseMatroskaAncillaryBypass(
                        originalFile, container, inputProbeData);
                    deferMatroskaAncillaryForGrain = useMatroskaAncillaryBypass &&
                        canonicalDisposition === 'prepared';
                    ffmpegOutputPath = useMatroskaAncillaryBypass
                        ? cacheDir + '/' + fileName + '_vmaf_primary_video_only.mkv'
                        : outputPath;
                    if (useMatroskaAncillaryBypass) {
                        try {
                            var _sourceMkvPreflight = preflightMatroskaAncillarySource(originalFile);
                            args.jobLog('Matroska source preflight passed: exactly one actual video track; ' +
                                _sourceMkvPreflight.inventory.attachments + ' attachment(s).');
                        } catch (sourceInventoryError) {
                            args.jobLog('ERROR: Refusing final AV1 encode before FFmpeg: Matroska source inventory ' +
                                'is not preservation-safe: ' + sourceInventoryError.message);
                            args.variables.vmafTranscodeSucceeded = false;
                            args.variables.vmafTranscodeStatus = 'technical_failure';
                            args.variables.vmafTranscodeFailureReason =
                                'mkvmerge_source_inventory_preflight_failed: ' + sourceInventoryError.message;
                            args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                            return [2 /*return*/, {
                                outputFileObj: args.inputFileObj,
                                outputNumber: 2,
                                variables: args.variables,
                            }];
                        }
                    }

                    // Check for retry CQ (from monitorTranscodeRetry)
                    var useCQ;
                    try {
                        useCQ = resolveFinalTranscodeCQ(bestParams, args.variables);
                    } catch (selectionContractError) {
                        args.jobLog('ERROR: Refusing final AV1 encode: selector/transcode handoff failed: '
                            + selectionContractError.message);
                        args.variables.vmafTranscodeStatus = 'technical_failure';
                        args.variables.vmafTranscodeFailureReason = 'selection_handoff_contract_failed: '
                            + selectionContractError.message;
                        args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                        return [2 /*return*/, {
                            outputFileObj: args.inputFileObj,
                            outputNumber: 2,
                            variables: args.variables,
                        }];
                    }
                    var retryCQ = args.variables.vmafTranscodeRetryCQ;
                    var retryCount = args.variables.vmafTranscodeRetryCount || 0;
                    var isRetry = retryCQ !== undefined && retryCQ !== null;

                    if (isRetry) {
                        useCQ = retryCQ;
                        // Store output path for cleanup on retry
                        args.variables.vmafTranscodeOutputPath = outputPath;
                    }

                    args.jobLog('=== VMAF Optimized Transcode ===');
                    if (isRetry) {
                        args.jobLog('⚠ RETRY ATTEMPT #' + retryCount);
                        args.jobLog('Original CQ: ' + bestParams.quality);
                        args.jobLog('Retry CQ: ' + useCQ + ' (incremented for smaller file size)');
                    }
                    args.jobLog('Parameter set: ' + bestParams.id);
                    args.jobLog('Encoder: ' + bestParams.encoder);
                    args.jobLog('GPU final encode required: ' + ((args.variables.vmafFinalTranscodeGpuRequired !== false) ? 'Yes' : 'No'));
                    args.jobLog('Preset: ' + bestParams.preset);
                    args.jobLog('Quality (CQ): ' + useCQ + (isRetry ? ' (retry)' : ''));
                    args.jobLog('Pixel Format: ' + pixFmt + (args.variables.vmafRecommendedPixFmt ? ' (VMAF recommended)' : ''));
                    args.jobLog('Color: ' + colorPrimaries + '/' + colorTrc + '/' + colorspace);
                    if (args.variables.hdr_dynamic_metadata_warning) {
                        args.jobLog('⚠ ' + args.variables.hdr_dynamic_metadata_warning);
                    }
                    if (pixFmt === 'p010le') {
                        args.jobLog('10-bit encoding enabled' + (args.variables.isHDR ? ' (HDR content)' : ' (VMAF analysis showed quality benefit)'));
                    }
                    args.jobLog('Output: ' + outputPath);
                    args.jobLog('');

                    // Size/quality policy is advisory after candidate selection. A noisy live
                    // extrapolation must never kill a technically healthy title encode: doing so
                    // discards the only result and guarantees another expensive encode. Keep the
                    // policy object for downstream telemetry, but explicitly disable cancellation.
                    args.variables.liveSizeCompare = {
                        enabled: false,
                        compareMethod: 'estimatedFinalSize',
                        thresholdPerc: 100,
                        checkDelaySeconds: 600,
                        advisoryOnly: true,
                        error: false,
                    };

                    // Build the exact command used by first attempts and retry CQs.
                    // Shared policy rejects stacked NVENC temporal filtering; the
                    // external KNN producer is the only denoiser used by samples
                    // and the final encode.
                    var _protectedPlanContext;
                    var _requestedProtectedPlanContext;
                    var _protectedPlanOptions;
                    try {
                        var _unitTestStorageOverride = process.platform === 'win32' &&
                            process.env.NODE_ENV === 'test' &&
                            process.env.VMAF_POSTENCODE_TEST_UNPINNED_STORAGE === '1';
                        _protectedPlanOptions = {
                            bestParams: bestParams,
                            variables: args.variables,
                            originalFile: originalFile,
                            workDir: cacheDir,
                            checkpointRoot: process.env.VMAF_POSTENCODE_CHECKPOINT_ROOT || '',
                            reuseRequiredRoot: process.env.VMAF_POSTENCODE_REUSE_REQUIRED_ROOT || '',
                            requireInitializedReuseRequiredRoot: true,
                            // The deployed Linux plugin has no runtime opt-in:
                            // missing or drifted roots always fail closed. The
                            // explicit double-gated override exists only for
                            // isolated unit tests using temporary Windows paths.
                            enforcePinnedStorage: !_unitTestStorageOverride,
                            ffmpegPath: args.ffmpegPath,
                            ffprobePath: String(args.ffprobePath || 'ffprobe'),
                            inputProbeData: inputProbeData,
                            contractOutputPath: ffmpegOutputPath,
                            pixFmt: pixFmt,
                            useCQ: useCQ,
                            colorPrimaries: colorPrimaries,
                            colorTrc: colorTrc,
                            colorspace: colorspace,
                            useCanonicalDenoise: useCanonicalDenoise,
                            temporalPolicy: finalContract.temporalPolicy,
                            useMatroskaAncillaryBypass: useMatroskaAncillaryBypass,
                        };
                        _protectedPlanContext = buildProtectedPostEncodePlan(_protectedPlanOptions);
                        _requestedProtectedPlanContext = _protectedPlanContext;
                        spawnArgs = _protectedPlanContext.spawnArgs;
                        var spawnExecutable = _protectedPlanContext.spawnExecutable;
                        postEncodeValidator = _protectedPlanContext.validator;
                        postEncodePlan = _protectedPlanContext.plan;
                    } catch (commandPolicyError) {
                        args.jobLog('ERROR: Refusing final AV1 encode: ' + commandPolicyError.message);
                        args.variables.vmafTranscodeStatus = 'technical_failure';
                        args.variables.vmafTranscodeFailureReason =
                            (commandPolicyError.protectedPostEncodeSetupStage === 'command_policy'
                                ? 'nvenc_temporal_filter_contract_failed: '
                                : 'postencode_checkpoint_setup_failed: ') + commandPolicyError.message;
                        args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                        return [2 /*return*/, {
                            outputFileObj: args.inputFileObj,
                            outputNumber: 2,
                            variables: args.variables,
                        }];
                    }
                    var _contractOutputPath = _protectedPlanContext.contractOutputPath;
                    args.variables.vmafFinalTranscodeRequestedCQ = Number(useCQ);
                    args.variables.vmafFinalTranscodeActualCQ = Number(useCQ);
                    var _reuseRequirement;
                    try {
                        _reuseRequirement = postEncodeCheckpoint.enforceReuseRequired(postEncodePlan);
                    } catch (reuseRequirementError) {
                        var _cqSubstitutionCandidate =
                            postEncodeCheckpoint.isReuseRequiredError(reuseRequirementError) &&
                            String(reuseRequirementError.message || '').indexOf(
                                'expected a different exact encode contract') !== -1;
                        if (!_cqSubstitutionCandidate) {
                            args.variables.vmafPostEncodeReuseRequired = true;
                            args.variables.vmafPostEncodeCheckpointStatus = 'reuse_required_not_satisfied';
                            args.variables.vmafTranscodeStatus = 'technical_failure';
                            args.variables.vmafTranscodeFailureReason =
                                'postencode_checkpoint_reuse_required: ' + reuseRequirementError.message;
                            args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                            args.jobLog('ERROR: Protected retained-output recovery failed closed before FFmpeg: ' +
                                reuseRequirementError.message);
                            return [2 /*return*/, {
                                outputFileObj: args.inputFileObj,
                                outputNumber: 2,
                                variables: args.variables,
                            }];
                        }
                        try {
                            var _substitution = resolveConservativeRetainedCqSubstitution(
                                _requestedProtectedPlanContext, _protectedPlanOptions);
                            _protectedPlanContext = _substitution.context;
                            spawnArgs = _protectedPlanContext.spawnArgs;
                            spawnExecutable = _protectedPlanContext.spawnExecutable;
                            postEncodeValidator = _protectedPlanContext.validator;
                            postEncodePlan = _protectedPlanContext.plan;
                            _contractOutputPath = _protectedPlanContext.contractOutputPath;
                            _reuseRequirement = postEncodeCheckpoint.enforceReuseRequired(postEncodePlan);
                            if (!_reuseRequirement.required || _reuseRequirement.satisfied !== true ||
                                !_reuseRequirement.location ||
                                _reuseRequirement.location.markerPath !== _substitution.markerPath) {
                                throw new Error('conservative retained checkpoint did not satisfy the source latch');
                            }
                            args.variables.vmafFinalTranscodeActualCQ = _substitution.delta.retainedCQ;
                            args.variables.vmafPostEncodeCqSubstitution = {
                                schema: 'vmaf_postencode_cq_substitution_v1',
                                contract_id: CONSERVATIVE_RETAINED_SUBSTITUTION_CONTRACT_ID,
                                policy: 'cq_only_conservative',
                                requested_cq: _substitution.delta.requestedCQ,
                                actual_cq: _substitution.delta.retainedCQ,
                                requested_checkpoint_key:
                                    _requestedProtectedPlanContext.plan.checkpointKey,
                                actual_checkpoint_key: postEncodePlan.checkpointKey,
                                requested_encode_contract_sha256:
                                    _requestedProtectedPlanContext.plan.encodeContractSha256,
                                actual_encode_contract_sha256: postEncodePlan.encodeContractSha256,
                                marker_path: _substitution.markerPath,
                                relation: _substitution.delta.relation,
                                conservative: true,
                                no_encode: true,
                                current_measurement: currentMeasurementForCQ(
                                    args.variables, _substitution.delta.retainedCQ, bestParams),
                                substituted_at: new Date().toISOString(),
                            };
                            args.jobLog('Conservative retained checkpoint substitution authenticated: requested CQ ' +
                                _substitution.delta.requestedCQ + ', using completed CQ ' +
                                _substitution.delta.retainedCQ + '; every encode-contract field except CQ is identical.');
                        } catch (substitutionError) {
                            args.variables.vmafPostEncodeReuseRequired = true;
                            args.variables.vmafPostEncodeCheckpointStatus = 'reuse_required_not_satisfied';
                            args.variables.vmafTranscodeStatus = 'technical_failure';
                            args.variables.vmafTranscodeFailureReason =
                                'postencode_checkpoint_cq_substitution_failed: ' + substitutionError.message;
                            args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                            args.jobLog('ERROR: Conservative retained-output substitution failed closed before FFmpeg: ' +
                                substitutionError.message);
                            return [2 /*return*/, {
                                outputFileObj: args.inputFileObj,
                                outputNumber: 2,
                                variables: args.variables,
                            }];
                        }
                    }
                    args.variables.vmafPostEncodeReuseRequired = _reuseRequirement.required === true;
                    if (_reuseRequirement.required) {
                        args.variables.vmafPostEncodeReuseRequiredMarker =
                            _reuseRequirement.location.markerPath;
                        args.jobLog('Imported retained-output checkpoint latch authenticated; encoder reuse is mandatory.');
                    }
                    args.variables.vmafPostEncodeCheckpoint = {
                        schema: postEncodeCheckpoint.SCHEMA,
                        contract_id: postEncodeCheckpoint.CONTRACT_ID,
                        checkpoint_key: postEncodePlan.checkpointKey,
                        artifact_path: postEncodePlan.artifactPath,
                        manifest_path: postEncodePlan.manifestPath,
                        reuse_required_root: postEncodePlan.reuseRequiredRoot,
                        encode_contract_sha256: postEncodePlan.encodeContractSha256,
                        reused: postEncodePlan.reused,
                    };
                    args.variables.vmafPostEncodeCheckpointPath = postEncodePlan.artifactPath;
                    args.variables.vmafPostEncodeCheckpointManifestPath = postEncodePlan.manifestPath;
                    if (postEncodePlan.validationBlocked) {
                        args.variables.vmafPostEncodeCheckpointStatus = postEncodePlan.pendingCandidate
                            ? 'pending_candidate_validation' : 'committed_validation_retry';
                        args.variables.vmafTranscodeStatus = 'technical_failure';
                        args.variables.vmafTranscodeFailureReason =
                            'postencode_checkpoint_validation_retry: ' +
                            postEncodePlan.validationBlockedReason;
                        args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                        args.jobLog('Protected post-encode artifact retained; validation could not complete ' +
                            'for a transient/tool reason. The next attempt will retry validation without encoding: ' +
                            postEncodePlan.validationBlockedReason);
                        return [2 /*return*/, {
                            outputFileObj: args.inputFileObj,
                            outputNumber: 2,
                            variables: args.variables,
                        }];
                    }
                    if (postEncodePlan.reused) {
                        ffmpegOutputPath = postEncodePlan.artifactPath;
                        args.variables.vmafPostEncodeCheckpointStatus = 'reused';
                        args.jobLog('Protected post-encode checkpoint verified; skipping the completed title encode: ' +
                            postEncodePlan.artifactPath);
                    } else {
                        if (spawnArgs[spawnArgs.length - 1] !== _contractOutputPath) {
                            args.variables.vmafTranscodeStatus = 'technical_failure';
                            args.variables.vmafTranscodeFailureReason =
                                'postencode_checkpoint_output_contract_failed';
                            args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                            return [2 /*return*/, {
                                outputFileObj: args.inputFileObj,
                                outputNumber: 2,
                                variables: args.variables,
                            }];
                        }
                        spawnArgs[spawnArgs.length - 1] = postEncodePlan.encodePath;
                        ffmpegOutputPath = postEncodePlan.encodePath;
                        args.variables.vmafPostEncodeCheckpointStatus = postEncodePlan.invalidReason
                            ? 'invalid_reencode_required' : 'encoding';
                        if (postEncodePlan.invalidReason) {
                            args.jobLog('Protected post-encode checkpoint rejected; a real encode is required: ' +
                                postEncodePlan.invalidReason);
                        }
                    }
                    if (bestParams.isGPU && bestParams.encoder.indexOf('av1_nvenc') !== -1 &&
                            (hdrMasterDisplay || hdrMaxCll)) {
                        args.jobLog('⚠ Static HDR mastering/CLL metadata detected but av1_nvenc in this FFmpeg build does not support -master_display/-max_cll. Preserving HDR color primaries/TRC/matrix only.');
                    }

                    if (!postEncodePlan.reused) {
                        args.jobLog((useCanonicalDenoise
                            ? 'NVEncC KNN -> FFmpeg command: ' : 'FFmpeg command: ') +
                            spawnExecutable + ' ' + spawnArgs.join(' '));
                    }

                    // Update worker with CLI info for progress display
                    if (args.updateWorker) {
                        args.updateWorker({
                            CLIType: spawnExecutable,
                            preset: spawnArgs.join(' '),
                        });
                    }

                    _a.trys.push([0, 2, , 3]);

                    // The final transcode watchdog is an absolute liveness
                    // backstop, not a performance SLA. Prefer measured timing
                    // from this title's selected sample set; otherwise allow a
                    // deliberately slow 1/12-realtime encode. The 12h..72h
                    // bounds avoid killing healthy long/slow titles while
                    // still guaranteeing eventual release of a wedged job.
                    var _srcDur = parseFloat(args.inputFileObj && args.inputFileObj.ffProbeData
                        && args.inputFileObj.ffProbeData.format && args.inputFileObj.ffProbeData.format.duration) || 0;
                    var _watchdog = finalTranscodeWatchdogPolicy(
                        _srcDur, args.variables, bestParams && bestParams.id);
                    var _capMs = _watchdog.timeoutMs;
                    args.variables.vmafFinalTranscodeWatchdog = _watchdog;
                    args.jobLog('Transcode watchdog: absolute liveness cap ' +
                        (_watchdog.timeoutSeconds / 3600).toFixed(1) + 'h (' +
                        _watchdog.basis + ', selected samples=' +
                        _watchdog.matchingSampleCount + ', bounded 12h-72h) -> SIGKILL only if exceeded');

                    cli = postEncodePlan.reused ? {
                        runCli: function () { return Promise.resolve({ cliExitCode: 0, checkpointReused: true }); }
                    } : new cliUtils_1.CLI({
                            cli: spawnExecutable,
                            spawnArgs: spawnArgs,
                            spawnOpts: { timeout: _capMs, killSignal: 'SIGKILL' },
                            jobLog: args.jobLog,
                            outputFilePath: ffmpegOutputPath,
                            inputFileObj: args.inputFileObj,
                            logFullCliOutput: args.logFullCliOutput,
                            updateWorker: args.updateWorker,
                            args: args,
                        });
                    args.variables.vmafTranscodeStatus = 'running';

                    return [4 /*yield*/, cli.runCli()];
                case 1:
                    res = _a.sent();
                    if (res.cliExitCode !== 0) {
                        try { postEncodeCheckpoint.abandon(postEncodePlan); } catch (_) {}
                        args.jobLog('Transcode failed with exit code: ' + res.cliExitCode);
                        var _liveFailed = args.variables.liveSizeCompare && args.variables.liveSizeCompare.error === true;
                        args.variables.vmafTranscodeStatus = _liveFailed ? 'size_failed' : 'technical_failure';
                        args.variables.vmafTranscodeFailureReason = _liveFailed
                            ? 'live_size_guard_exceeded'
                            : 'ffmpeg_exit_code_' + res.cliExitCode;
                        args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                        return [2 /*return*/, {
                            outputFileObj: args.inputFileObj,
                            outputNumber: 2,
                            variables: args.variables,
                        }];
                    }
                    if (!postEncodePlan.reused) {
                        postEncodeCheckpoint.commit(postEncodePlan, postEncodeValidator);
                        args.variables.vmafPostEncodeCheckpointStatus = 'committed';
                        args.variables.vmafPostEncodeCheckpoint.reused = false;
                        args.jobLog('Completed AV1 committed to protected post-encode checkpoint: ' +
                            postEncodePlan.artifactPath);
                    }
                    ffmpegOutputPath = postEncodePlan.artifactPath;
                    if (deferMatroskaAncillaryForGrain) {
                        postEncodeCheckpoint.materialize(postEncodePlan, outputPath, cacheDir);
                        args.variables.vmafAncillaryPreservationMethod = 'deferred-to-grain-synthesis-v1';
                        args.variables.vmafAncillaryRemuxDeferred = true;
                        args.jobLog('Prepared grain flow: materialized the protected video-only AV1 checkpoint; ' +
                            'ancillary remux is deferred until after grain application.');
                    } else if (useMatroskaAncillaryBypass) {
                        args.jobLog('Primary video encode completed; preserving original Matroska ancillary payloads with MKVToolNix.');
                        try {
                            var _mkvPreservation = preserveMatroskaAncillaryWithMkvmerge(
                                ffmpegOutputPath, originalFile, outputPath, args.jobLog);
                            args.variables.vmafAncillaryPreservationMethod = 'mkvmerge-source-no-video-v1';
                            args.variables.vmafAncillaryInventory = _mkvPreservation.inventory;
                        } catch (mkvmergeError) {
                            args.jobLog('ERROR: Matroska ancillary preservation failed closed: ' + mkvmergeError.message);
                            args.variables.vmafTranscodeSucceeded = false;
                            args.variables.vmafTranscodeStatus = 'technical_failure';
                            args.variables.vmafTranscodeFailureReason =
                                'mkvmerge_ancillary_preservation_failed: ' + mkvmergeError.message;
                            args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                            return [2 /*return*/, {
                                outputFileObj: args.inputFileObj,
                                outputNumber: 2,
                                variables: args.variables,
                            }];
                        }
                    } else {
                        postEncodeCheckpoint.materialize(postEncodePlan, outputPath, cacheDir);
                        args.variables.vmafAncillaryPreservationMethod = 'ffmpeg-scoped-stream-copy-v1';
                        args.variables.vmafAncillaryRemuxDeferred = false;
                    }
                    args.jobLog('Transcode completed successfully: ' + outputPath);

                    // Record exact final size after muxing and enforce the
                    // original-preserving efficiency boundary before success.
                    try {
                        var fs = require('fs');
                        var outBytes = fs.statSync(outputPath).size;
                        // stat the source for BYTES. Tdarr's inputFileObj.file_size is in MB
                        // (verified against filejsondb), so the old bytes-vs-MB comparison
                        // inflated ratios ~1,048,576x and rerouted EVERY successful transcode
                        // into the size-failure retry path (2026-07-05..07 poison window).
                        var inBytes = 0;
                        try { inBytes = fs.statSync(originalFile).size; } catch (eInSz) {}
                        if (!(inBytes > 0)) {
                            var _fszMb = Number(args.inputFileObj && args.inputFileObj.file_size) || 0;
                            inBytes = _fszMb > 1024 * 1024 ? _fszMb : _fszMb * 1024 * 1024;
                        }
                        var resolvedDeliveryPolicy = deliveryPolicy.resolve(args.variables);
                        var finalSizeGate = evaluateFinalOutputSizeGate(
                            outBytes, inBytes, resolvedDeliveryPolicy.maxFinalOutputRatioPct);
                        var finalRatio = finalSizeGate.ratioPct;
                        var _maxFinalRatio = finalSizeGate.capPct;
                        args.variables.vmafFinalOutputSizeMB = outBytes / (1024 * 1024);
                        args.variables.vmafFinalOutputRatioPct = finalRatio;
                        args.jobLog('Final output ratio after VMAF transcode: ' + finalRatio.toFixed(2) + '% of source');
                        // AUTHORITATIVE POST-ENCODE SIZE GATE.
                        //
                        // This is the only place that compares real output bytes against real
                        // source bytes, and it is the last chance to refuse before the original
                        // is replaced. It used to log a "QUALITY ADVISORY" and keep the output.
                        // That is how five outputs at 103%-165% of source size reached the
                        // library during a 2026-07 incident, each replacing its original and
                        // consuming about 7.1 GB of avoidable extra disk.
                        //
                        // Every upstream guard can miss this: the projected-ratio emergency gate
                        // fails open when the projection is null (projections are only computed
                        // for candidates that were not already rejected), and film-grain
                        // synthesis measures its own input rather than the original source. An
                        // output above the delivered cap misses the minimum reduction,
                        // so the source must be kept. Equality is accepted.
                        if (finalSizeGate.rejected) {
                            args.jobLog('ERROR: Final output is ' + finalRatio.toFixed(2)
                                + '% of source (cap ' + _maxFinalRatio.toFixed(2)
                                + '%); refusing the encode and preserving the original.');
                            args.variables.vmafTranscodeQualityWarnings =
                                Array.isArray(args.variables.vmafTranscodeQualityWarnings)
                                    ? args.variables.vmafTranscodeQualityWarnings : [];
                            args.variables.vmafTranscodeQualityWarnings.push({
                                code: 'final-output-larger-than-source',
                                stage: 'post-encode-size',
                                ratio_pct: finalRatio,
                                output_size_bytes: outBytes,
                                source_size_bytes: inBytes,
                                cap_pct: _maxFinalRatio,
                                advisory: false,
                            });
                            args.variables.vmafFinalOutputSizeAdvisory = false;
                            args.variables.vmafFinalOutputSizeRejected = true;
                            args.variables.vmafTranscodeSucceeded = false;
                            args.variables.vmafTranscodeStatus = 'size_failed';
                            args.variables.vmafTranscodeFailureReason =
                                'final_output_exceeds_minimum_reduction_cap';
                            args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                            args.variables.liveSizeCompare = args.variables.liveSizeCompare || {};
                            args.variables.liveSizeCompare.enabled = false;
                            args.variables.liveSizeCompare.error = true;
                            args.variables.liveSizeCompare.errorType = 'upperThreshold';
                            args.variables.liveSizeCompare.advisoryOnly = false;
                            args.variables.liveSizeCompare.finalOutputRatioPct = finalRatio;
                            args.variables.liveSizeCompare.finalOutputSizeMB = outBytes / (1024 * 1024);
                            retireRejectedPostEncodeCheckpoint(
                                args.variables, postEncodeCheckpoint, args.jobLog);
                            return [2 /*return*/, {
                                outputFileObj: args.inputFileObj,
                                outputNumber: 2,
                                variables: args.variables,
                            }];
                        }
                        args.variables.liveSizeCompare = args.variables.liveSizeCompare || {};
                        args.variables.liveSizeCompare.enabled = false;
                        args.variables.liveSizeCompare.error = false;
                        args.variables.liveSizeCompare.advisoryOnly = true;
                        args.variables.liveSizeCompare.finalOutputRatioPct = finalRatio;
                        args.variables.liveSizeCompare.finalOutputSizeMB = outBytes / (1024 * 1024);
                    } catch (_sizeE) {
                        args.jobLog('ERROR: Final output size check failed; refusing to treat the transcode as successful: ' + _sizeE.message);
                        args.variables.vmafTranscodeSucceeded = false;
                        args.variables.vmafTranscodeStatus = 'technical_failure';
                        args.variables.vmafTranscodeFailureReason = 'final_size_verification_failed';
                        args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                        return [2 /*return*/, {
                            outputFileObj: args.inputFileObj,
                            outputNumber: 2,
                            variables: args.variables,
                        }];
                    }

                    // Apply HDR color metadata from source to output file via mkvpropedit.
                    // Must run synchronously: returning a raw Promise from a __generator
                    // case body makes the state machine spin forever (job stuck at 100%).
                    if (colorPrimaries && colorPrimaries !== 'bt709') {
                        args.jobLog('  Preserving HDR color metadata from source...');
                        var _hdrResult = applyHdrColorMetadata(outputPath, originalFile, colorPrimaries, colorTrc, colorspace, hdrMasterDisplay, hdrMaxCll, args.jobLog);
                        if (!_hdrResult.ok) {
                            args.variables.vmafTranscodeSucceeded = false;
                            args.variables.vmafTranscodeStatus = 'technical_failure';
                            args.variables.vmafTranscodeFailureReason = 'hdr_metadata_verification_failed: ' + _hdrResult.reason;
                            args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                            return [2 /*return*/, {
                                outputFileObj: args.inputFileObj,
                                outputNumber: 2,
                                variables: args.variables,
                            }];
                        }
                        args.variables.vmafHdrStaticMetadataVerified = true;
                    }

                    if (deferMatroskaAncillaryForGrain) {
                        var _deferredStat = require('fs').statSync(outputPath);
                        args.variables.vmafDeferredGrainBase = {
                            schema: 1,
                            contract_id: 'protected-video-only-checkpoint-materialization-v1',
                            path: require('fs').realpathSync(outputPath),
                            size_bytes: _deferredStat.size,
                            sha256_full: postEncodeCheckpoint.sha256FileSync(outputPath),
                            checkpoint_key: postEncodePlan.checkpointKey,
                            checkpoint_artifact_path: postEncodePlan.artifactPath,
                            checkpoint_manifest_path: postEncodePlan.manifestPath,
                            source_fingerprint: postEncodePlan.sourceFingerprint,
                            exactly_one_video_only_stream: true,
                            ancillary_remux_deferred: true,
                        };
                    }

                    args.variables.vmafTranscodeSucceeded = true;
                    args.variables.vmafTranscodeStatus = 'success';
                    args.variables.vmafTranscodeFailureReason = null;
                    args.variables.vmafTranscodeCompletedAt = new Date().toISOString();

                    // monitorTranscodeRetry is the single terminal-outcome writer. It records
                    // success only after consuming this explicit status and all final metrics.

                    return [2 /*return*/, {
                        outputFileObj: { _id: outputPath },
                        outputNumber: 1,
                        variables: args.variables,
                    }];
                case 2:
                    err = _a.sent();
                    try { postEncodeCheckpoint.abandon(postEncodePlan); } catch (_) {}
                    args.jobLog('Transcode failed: ' + err.message);
                    args.variables.vmafTranscodeSucceeded = false;
                    args.variables.vmafTranscodeStatus = 'technical_failure';
                    if (postEncodeCheckpoint.isRetryableValidationError(err) && postEncodePlan &&
                            postEncodePlan.pendingCandidate) {
                        args.variables.vmafPostEncodeCheckpointStatus = 'pending_candidate_validation';
                        args.variables.vmafTranscodeFailureReason =
                            'postencode_checkpoint_validation_retry: ' + err.message;
                        args.jobLog('Completed FFmpeg exit-0 artifact remains protected; retry will ' +
                            'revalidate it without running the title encode again.');
                    } else if (postEncodeCheckpoint.isConfirmedInvalidError(err)) {
                        args.variables.vmafPostEncodeCheckpointStatus = 'confirmed_invalid';
                        args.variables.vmafTranscodeFailureReason =
                            'postencode_checkpoint_confirmed_invalid: ' + err.message;
                    } else {
                        args.variables.vmafTranscodeFailureReason = 'transcode_exception: ' + err.message;
                    }
                    args.variables.vmafTranscodeCompletedAt = new Date().toISOString();
                    return [2 /*return*/, {
                        outputFileObj: args.inputFileObj,
                        outputNumber: 2,
                        variables: args.variables,
                    }];
                case 3:
                    return [2 /*return*/];
            }
        });
    });
};
exports.plugin = plugin;
exports.recovery = {
    contractId: 'vmaf-retained-postencode-import-v1',
    buildRetainedRecoveryPlan: buildRetainedRecoveryPlan,
    importRetainedCheckpoint: postEncodeCheckpoint.importRetained,
};
exports._test = {
    finalTranscodeWatchdogPolicy: finalTranscodeWatchdogPolicy,
    evaluateFinalOutputSizeGate: evaluateFinalOutputSizeGate,
    retireRejectedPostEncodeCheckpoint: retireRejectedPostEncodeCheckpoint,
    parseHdrMasterDisplay: parseHdrMasterDisplay,
    parseHdrMaxCll: parseHdrMaxCll,
    buildHdrMkvProperties: buildHdrMkvProperties,
    verifyHdrTrackProperties: verifyHdrTrackProperties,
    applyHdrColorMetadata: applyHdrColorMetadata,
    selectOutputContainer: selectOutputContainer,
    buildVideoStreamPlan: buildVideoStreamPlan,
    shouldUseMatroskaAncillaryBypass: shouldUseMatroskaAncillaryBypass,
    buildMkvmergeAncillaryArgs: buildMkvmergeAncillaryArgs,
    parseMkvmergeIdentifyJson: parseMkvmergeIdentifyJson,
    assertMatroskaSourceVideoTopology: assertMatroskaSourceVideoTopology,
    preflightMatroskaAncillarySource: preflightMatroskaAncillarySource,
    verifyMkvmergeAncillaryInventory: verifyMkvmergeAncillaryInventory,
    preserveMatroskaAncillaryWithMkvmerge: preserveMatroskaAncillaryWithMkvmerge,
    buildFinalTranscodeArgs: buildFinalTranscodeArgs,
    resolveExecutablePath: resolveExecutablePath,
    resolveFinalTranscodeCQ: resolveFinalTranscodeCQ,
    absoluteShellExecTarget: absoluteShellExecTarget,
    resolveExecutableIdentity: resolveExecutableIdentity,
    buildPostEncodeContract: buildPostEncodeContract,
    buildProtectedPostEncodePlan: buildProtectedPostEncodePlan,
    buildRetainedRecoveryPlan: buildRetainedRecoveryPlan,
    assertCqOnlyConservativeContractDelta: assertCqOnlyConservativeContractDelta,
    measurementParameterContract: measurementParameterContract,
    measurementParameterContractSha256: measurementParameterContractSha256,
    currentMeasurementForCQ: currentMeasurementForCQ,
    resolveConservativeRetainedCqSubstitution: resolveConservativeRetainedCqSubstitution,
    hasConfirmedMediaCorruption: hasConfirmedMediaCorruption,
    distributedDecodeOffsets: distributedDecodeOffsets,
    decodeValidationArgs: decodeValidationArgs,
    runDecodeValidation: runDecodeValidation,
    validatePostEncodeMedia: validatePostEncodeMedia,
    measuredSourcePacketCount: measuredSourcePacketCount,
    postEncodeRoutineValidator: POSTENCODE_ROUTINE_VALIDATOR,
    postEncodeExhaustiveValidator: POSTENCODE_EXHAUSTIVE_VALIDATOR,
    importRetainedCheckpoint: postEncodeCheckpoint.importRetained,
};
