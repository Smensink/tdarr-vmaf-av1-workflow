"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

var details = function () { return ({
    name: 'Learn CQ Ranges',
    description: 'Appends a per-job learning row to vmaf_cq_learning.csv and updates ema_cq_state.json with the selected CQ, fitted VMAF/CQ slope, and predicted CQ-at-target. Reads back via extractVideoSamples to bias the next transcode.',
    style: {
        borderColor: 'teal',
    },
    tags: 'video,vmaf,learn,adaptive',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faBrain',
    inputs: [
        {
            label: 'Learning CSV Path',
            name: 'learningCsvPath',
            type: 'string',
            defaultValue: '/app/configs/vmaf_cq_learning.csv',
            inputUI: { type: 'text' },
            tooltip: 'Path to the per-job learning CSV. Written on success, read by extractVideoSamples for the next job.',
        },
        {
            label: 'EMA State Path',
            name: 'emaStatePath',
            type: 'string',
            defaultValue: '/app/configs/ema_cq_state.json',
            inputUI: { type: 'text' },
            tooltip: 'Path to the per-resolution exponential moving average CQ state.',
        },
        {
            label: 'EMA Alpha',
            name: 'emaAlpha',
            type: 'number',
            defaultValue: '0.1',
            inputUI: { type: 'text' },
            tooltip: 'EMA smoothing factor (0..1). Higher = more reactive to recent selections. Default 0.1.',
        },
        {
            label: 'Minimum Samples for Confidence',
            name: 'minSamplesConfidence',
            type: 'number',
            defaultValue: '3',
            inputUI: { type: 'text' },
            tooltip: 'Below this many aggregated points, the fitted slope/intercept are not trusted and cq_at_target_estimated is empty.',
        },
        {
            label: 'Max Slope Residual (VMAF units)',
            name: 'maxResidual',
            type: 'number',
            defaultValue: '1.5',
            inputUI: { type: 'text' },
            tooltip: 'If the linear-fit residual stddev exceeds this, mark the fit as non-monotonic_skip (slopes from VMAF sweeps are typically noisy).',
        },
        {
            label: 'Run Even on Failure',
            name: 'runOnFailure',
            type: 'boolean',
            defaultValue: 'false',
            inputUI: { type: 'switch' },
            tooltip: 'If true, also records a learning row when the transcode failed (with selected_cq empty and transcode_succeeded=0). Off by default: failures skew the prior.',
        },
    ],
    outputs: [
        { number: 1, tooltip: 'Learning row written' },
        { number: 2, tooltip: 'Skipped (insufficient data or no selected CQ)' },
    ],
}); };
exports.details = details;

var HEADERS = [
    'timestamp', 'file_path',
    'source_width', 'source_height', 'source_codec',
    'bits_per_pixel', 'is_hdr', 'tier',
    'release_group', 'media_type', 'media_year', 'media_source_type',
    'is_animation', 'genre',
    'cq_min', 'cq_max', 'cq_step',
    'selected_cq', 'selected_vmaf',
    'cq_slope', 'cq_intercept',
    'cq_at_target_estimated', 'cq_at_target_confidence', 'cq_at_target_method',
    'transcode_succeeded',
];

function resolutionTier(width, height) {
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

// Release-group extraction: mirrors generate_release_group_profiles.py so we get
// the same group keys the static JSON uses. Falls back to '' when no match.
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
function deriveReleaseGroup(filePath) {
    if (!filePath) return '';
    var base = String(filePath).replace(/^.*[\\\/]/, ''); // filename only
    base = base.replace(/\.[a-z0-9]{2,5}$/i, ''); // strip extension
    var patterns = [
        /-([A-Za-z0-9]+)$/,
        /\[([A-Za-z0-9]+)\]$/,
        /\.([A-Za-z0-9]+)$/,
    ];
    for (var i = 0; i < patterns.length; i++) {
        var m = base.match(patterns[i]);
        if (m && m[1]) {
            var g = m[1].toUpperCase();
            if (!IGNORE_GROUPS[g]) return g;
        }
    }
    return '';
}

// Year from filename: 4-digit year 19xx/20xx, prefer 19xx-20xx range, in any of
// the common separators (., -, _, space, [..], (..))
function deriveYear(filePath) {
    if (!filePath) return '';
    var base = String(filePath).replace(/^.*[\\\/]/, '');
    var m = base.match(/[.\-_\s\[(]((?:19|20)\d{2})[.\-_\s\])]/);
    if (m && m[1]) return m[1];
    return '';
}

// Heuristic media type from file path: very lightweight, folder-name based.
function deriveMediaType(filePath) {
    if (!filePath) return 'unknown';
    var p = String(filePath).toLowerCase();
    if (/\b(tv|series|shows?|season\s*\d|episode\s*\d|s\d{1,2}e\d{1,2})\b/.test(p)) return 'tv';
    if (/\b(movies?|films?)\b/.test(p)) return 'movie';
    return 'unknown';
}

// Heuristic source type from filename tokens: bluray-remux > web-dl > hdtv > etc.
function deriveSourceType(filePath) {
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

// Heuristic animation detection: filename token, container metadata, or genre.
function deriveIsAnimation(filePath, argsVariables) {
    if (argsVariables && argsVariables.vmafMediaIsAnimation === true) return true;
    var genres = (argsVariables && argsVariables.vmafMediaGenre) || [];
    for (var i = 0; i < genres.length; i++) {
        var g = String(genres[i]).toLowerCase();
        if (g.indexOf('animation') !== -1 || g.indexOf('anime') !== -1 || g.indexOf('cartoon') !== -1) return true;
    }
    if (filePath) {
        var p = String(filePath).toLowerCase();
        if (/\b(anime|animation|cartoon|animated)\b/.test(p)) return true;
    }
    return false;
}

// Pipe-delimited list of matched genre tokens, drawn from filename + injected
// args.variables.vmafMediaGenre (which Tdarr doesn't currently set, but a future
// metadata plugin might). Avoids CSV commas in a single column.
function deriveGenres(filePath, argsVariables) {
    var out = [];
    var injected = (argsVariables && argsVariables.vmafMediaGenre) || [];
    for (var i = 0; i < injected.length; i++) {
        var g = String(injected[i]).trim();
        if (g) out.push(g);
    }
    if (filePath) {
        var p = String(filePath).toLowerCase();
        var tokens = ['action', 'thriller', 'sport', 'documentary', 'news', 'drama', 'comedy', 'horror', 'scifi', 'fantasy', 'romance', 'crime', 'mystery', 'animation', 'anime', 'cartoon', 'war', 'western', 'musical', 'history', 'biography', 'family', 'adventure'];
        for (var j = 0; j < tokens.length; j++) {
            var t = tokens[j];
            var re = new RegExp('\\b' + t + '\\b');
            if (re.test(p) && out.indexOf(t) === -1) out.push(t);
        }
    }
    return out.slice(0, 6).join('|');
}

function csvEscape(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

function num(v, digits) {
    if (v === null || v === undefined || isNaN(v)) return '';
    return digits === undefined ? String(v) : Number(v).toFixed(digits);
}

/**
 * Fit a simple linear model VMAF = slope * CQ + intercept on the aggregated
 * results (which are already averaged across samples). Returns:
 *   { slope, intercept, residualStd, n, monotonic, method }
 * - monotonic: true if all VMAF values are non-increasing as CQ rises
 * - residualStd: stddev of residuals (a rough noise/fit-quality indicator)
 * - method: 'linear' | 'insufficient_points' | 'non_monotonic_skip'
 *
 * NB: aggregated results are typically 3-5 points from a single sweep, so the
 * fit is informational. The 'non_monotonic_skip' guard prevents a fitted slope
 * from being used to extrapolate CQ-at-target when the data is too noisy.
 */
function fitLinearOnAggregated(aggregated) {
    var pts = (aggregated || [])
        .filter(function (r) { return r && r.parameterSet && r.parameterSet.quality !== undefined && r.avgVMAF !== undefined && r.avgVMAF !== null; })
        .map(function (r) { return { cq: Number(r.parameterSet.quality), vmaf: Number(r.avgVMAF) }; })
        .sort(function (a, b) { return a.cq - b.cq; });

    if (pts.length < 2) {
        return { slope: null, intercept: null, residualStd: null, n: pts.length, monotonic: false, method: 'insufficient_points' };
    }

    // Monotonicity: each successive (higher CQ) point should have VMAF <= previous.
    var monotonic = true;
    for (var i = 1; i < pts.length; i++) {
        if (pts[i].vmaf > pts[i - 1].vmaf + 0.05) { monotonic = false; break; }
    }

    // Simple OLS slope/intercept
    var n = pts.length;
    var meanCq = 0, meanV = 0;
    for (var k = 0; k < n; k++) { meanCq += pts[k].cq; meanV += pts[k].vmaf; }
    meanCq /= n; meanV /= n;
    var num_ = 0, den = 0;
    for (var k2 = 0; k2 < n; k2++) {
        num_ += (pts[k2].cq - meanCq) * (pts[k2].vmaf - meanV);
        den += (pts[k2].cq - meanCq) * (pts[k2].cq - meanCq);
    }
    if (Math.abs(den) < 1e-6) {
        return { slope: 0, intercept: meanV, residualStd: 0, n: n, monotonic: monotonic, method: 'insufficient_points' };
    }
    var slope = num_ / den;
    var intercept = meanV - slope * meanCq;

    // Residual stddev
    var sumSq = 0;
    for (var k3 = 0; k3 < n; k3++) {
        var r = pts[k3].vmaf - (slope * pts[k3].cq + intercept);
        sumSq += r * r;
    }
    var residualStd = Math.sqrt(sumSq / Math.max(1, n - 2));

    return { slope: slope, intercept: intercept, residualStd: residualStd, n: n, monotonic: monotonic, method: 'linear' };
}

function estimateCQAtTarget(fit, targetVMAF, minSamplesConfidence, maxResidual) {
    if (fit.n < minSamplesConfidence) return { value: null, confidence: 0, method: 'insufficient_points' };
    if (fit.residualStd === null || fit.residualStd > maxResidual) return { value: null, confidence: 0, method: 'non_monotonic_skip' };
    if (fit.slope === null || fit.slope >= 0) return { value: null, confidence: 0, method: 'non_monotonic_skip' };
    // slope is negative (higher CQ = lower VMAF). Solve CQ = (target - intercept) / slope
    var cq = (targetVMAF - fit.intercept) / fit.slope;
    if (cq < 16 || cq > 51) return { value: null, confidence: 0, method: 'non_monotonic_skip' };
    // Confidence: tighter residual = higher confidence, scaled 0..1
    var conf = Math.max(0, Math.min(1, 1 - (fit.residualStd / Math.max(maxResidual, 0.01))));
    return { value: cq, confidence: conf, method: 'linear' };
}

function readEmaState(path) {
    var fs = require('fs');
    if (!fs.existsSync(path)) {
        return { ema: {}, alpha: 0.1, sampleCounts: {}, lastUpdated: '' };
    }
    try {
        var content = fs.readFileSync(path, 'utf8');
        var obj = JSON.parse(content);
        return {
            ema: obj.ema || {},
            alpha: typeof obj.alpha === 'number' ? obj.alpha : 0.1,
            sampleCounts: obj.sampleCounts || {},
            lastUpdated: obj.lastUpdated || '',
        };
    } catch (e) {
        return { ema: {}, alpha: 0.1, sampleCounts: {}, lastUpdated: '' };
    }
}

function writeEmaState(path, state) {
    var fs = require('fs');
    try {
        fs.writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o644 });
    } catch (e) {
        // Non-fatal: EMA is a hint, not a hard dependency.
    }
}

function writeLearningRow(csvPath, row) {
    var fs = require('fs');
    var dir = require('path').dirname(csvPath);
    if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* swallow */ }
    }
    var line = row.map(csvEscape).join(',') + '\n';
    if (!fs.existsSync(csvPath)) {
        fs.writeFileSync(csvPath, HEADERS.join(',') + '\n' + line, { mode: 0o644 });
    } else {
        fs.appendFileSync(csvPath, line);
    }
}

var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    var fs = require('fs');
    var path = require('path');

    var learningCsvPath = args.inputs.learningCsvPath || '/app/configs/vmaf_cq_learning.csv';
    var emaStatePath = args.inputs.emaStatePath || '/app/configs/ema_cq_state.json';
    var emaAlpha = Number(args.inputs.emaAlpha);
    if (isNaN(emaAlpha) || emaAlpha <= 0 || emaAlpha > 1) emaAlpha = 0.1;
    var minSamplesConfidence = Number(args.inputs.minSamplesConfidence) || 3;
    var maxResidual = Number(args.inputs.maxResidual) || 1.5;
    var runOnFailure = args.inputs.runOnFailure === true || args.inputs.runOnFailure === 'true';

    args.jobLog('=== Learn CQ Ranges ===');

    // Pull the upstream data
    var bestParams = args.variables.vmafBestParameters || null;
    var aggregated = args.variables.vmafAggregatedResults || [];
    var transcodeSucceeded = args.variables.vmafTranscodeSucceeded === true; // set by vmafOptimizedTranscode on success
    var targetMinVMAF = Number(args.variables.vmafMinVMAF) || 90;
    var inputFile = args.inputFileObj || {};
    var streams = (inputFile.ffProbeData && inputFile.ffProbeData.streams) || [];
    var videoStream = null;
    for (var si = 0; si < streams.length; si++) {
        if (streams[si] && streams[si].codec_type === 'video') { videoStream = streams[si]; break; }
    }
    var sourceWidth = (videoStream && videoStream.width) || 0;
    var sourceHeight = (videoStream && videoStream.height) || 0;
    var sourceCodec = (videoStream && videoStream.codec_name) || '';
    var tier = resolutionTier(sourceWidth, sourceHeight);
    var isHdr = args.variables.isHDR === true;
    var cqMin = (args.variables.vmafCQRange && args.variables.vmafCQRange.min) || '';
    var cqMax = (args.variables.vmafCQRange && args.variables.vmafCQRange.max) || '';
    var cqStep = args.variables.vmafCQStepUsed || args.variables.vmafCQStepEffective || '';

    // Media metadata: prefer upstream-injected values, fall back to filename heuristics.
    // This keeps the schema populated even though Tdarr itself doesn't set these vars.
    var filePath = inputFile._id || '';
    var releaseGroup = (args.variables.vmafReleaseGroup || '').toString().toUpperCase() || deriveReleaseGroup(filePath);
    var mediaType = args.variables.vmafMediaType || deriveMediaType(filePath);
    var mediaYear = args.variables.vmafMediaYear || deriveYear(filePath);
    var mediaSourceType = args.variables.vmafMediaSourceType || deriveSourceType(filePath);
    var isAnimation = deriveIsAnimation(filePath, args.variables) ? 1 : 0;
    var genres = deriveGenres(filePath, args.variables);

    // Source BPP if not already computed upstream
    var bpp = args.variables.vmafSourceBpp;
    if (bpp === undefined || bpp === null || bpp === '') {
        var bitrate = (inputFile.ffProbeData && inputFile.ffProbeData.format && parseFloat(inputFile.ffProbeData.format.bit_rate)) || 0;
        var duration = (inputFile.ffProbeData && inputFile.ffProbeData.format && parseFloat(inputFile.ffProbeData.format.duration)) || 0;
        var sizeBytes = inputFile.file_size || 0;
        var sizeMb = sizeBytes;
        if (sizeMb > 0 && sizeMb < 1e6) { sizeMb = sizeMb * 1024 * 1024; } // already MB? rough heuristic
        var fps = 24;
        if (videoStream && videoStream.r_frame_rate) {
            var parts = String(videoStream.r_frame_rate).split('/');
            if (parts.length === 2) {
                var n = parseFloat(parts[0]); var d = parseFloat(parts[1]);
                if (n > 0 && d > 0) fps = n / d;
            }
        }
        var mbps = bitrate > 0 ? bitrate / 1e6 : (duration > 0 && sizeMb > 0 ? (sizeMb * 8) / duration : 0);
        var px = sourceWidth * sourceHeight;
        bpp = px > 0 && fps > 0 ? (mbps * 1e6) / (px * fps) : 0;
    }

    var selectedCQ = (bestParams && bestParams.parameterSet && bestParams.parameterSet.quality !== undefined) ? Number(bestParams.parameterSet.quality) : null;
    var selectedVMAF = (bestParams && bestParams.avgVMAF !== undefined && bestParams.avgVMAF !== null) ? Number(bestParams.avgVMAF) : null;

    // Fit VMAF/CQ model on this job's aggregated results
    var fit = fitLinearOnAggregated(aggregated);
    var est = estimateCQAtTarget(fit, targetMinVMAF, minSamplesConfidence, maxResidual);

    args.jobLog('  Source: ' + sourceWidth + 'x' + sourceHeight + ' ' + sourceCodec + ' (tier=' + tier + ', bpp=' + num(bpp, 4) + ', hdr=' + isHdr + ')');
    args.jobLog('  Media: type=' + mediaType + ', year=' + (mediaYear || '-') + ', source=' + mediaSourceType + ', group=' + (releaseGroup || '-') + ', animation=' + isAnimation + ', genre=' + (genres || '-'));
    args.jobLog('  CQ sweep: ' + cqMin + '-' + cqMax + ' (step ' + cqStep + '), selected_cq=' + (selectedCQ === null ? 'none' : selectedCQ) + ', selected_vmaf=' + num(selectedVMAF, 2));
    args.jobLog('  Fit: slope=' + num(fit.slope, 4) + ', intercept=' + num(fit.intercept, 2) + ', residual_std=' + num(fit.residualStd, 3) + ', n=' + fit.n + ', monotonic=' + fit.monomonic);
    args.jobLog('  CQ-at-target: ' + (est.value === null ? 'n/a' : num(est.value, 2)) + ' (confidence=' + num(est.confidence, 2) + ', method=' + est.method + ')');

    // Decide whether to record a row
    var shouldWrite = transcodeSucceeded || runOnFailure;
    if (!shouldWrite) {
        args.jobLog('  Transcode did not succeed and runOnFailure=false; skipping CSV append.');
    } else if (selectedCQ === null) {
        args.jobLog('  No selected CQ; skipping CSV append (no training signal).');
        shouldWrite = false;
    } else {
        var row = [
            new Date().toISOString(),
            filePath,
            sourceWidth, sourceHeight, sourceCodec,
            num(bpp, 6), isHdr ? 1 : 0, tier,
            releaseGroup, mediaType, mediaYear, mediaSourceType,
            isAnimation, genres,
            cqMin, cqMax, cqStep,
            selectedCQ, num(selectedVMAF, 4),
            num(fit.slope, 6), num(fit.intercept, 4),
            est.value === null ? '' : num(est.value, 3),
            num(est.confidence, 4), est.method,
            transcodeSucceeded ? 1 : 0,
        ];
        try {
            writeLearningRow(learningCsvPath, row);
            args.jobLog('  Appended learning row to: ' + learningCsvPath);
        } catch (e) {
            args.jobLog('  ⚠ Could not write learning CSV: ' + e.message);
        }
    }

    // Always update EMA on success (even if CSV write failed) - EMA is the cheap, high-value prior.
    if (transcodeSucceeded && selectedCQ !== null) {
        try {
            var state = readEmaState(emaStatePath);
            state.alpha = emaAlpha;
            if (!state.ema[tier]) {
                state.ema[tier] = selectedCQ;
                state.sampleCounts[tier] = 1;
            } else {
                state.ema[tier] = emaAlpha * selectedCQ + (1 - emaAlpha) * state.ema[tier];
                state.sampleCounts[tier] = (state.sampleCounts[tier] || 0) + 1;
            }
            state.lastUpdated = new Date().toISOString();
            writeEmaState(emaStatePath, state);
            args.jobLog('  EMA: tier=' + tier + ' cq=' + num(state.ema[tier], 2) + ' (n=' + state.sampleCounts[tier] + ', alpha=' + emaAlpha + ')');
        } catch (e) {
            args.jobLog('  ⚠ EMA update failed: ' + e.message);
        }
    }

    // Surface the fit and predicted CQ at the variable layer so other plugins (or humans inspecting the job log) can see them
    args.variables.vmafCqSlope = fit.slope;
    args.variables.vmafCqIntercept = fit.intercept;
    args.variables.vmafCqAtTargetEstimated = est.value;
    args.variables.vmafCqAtTargetConfidence = est.confidence;
    args.variables.vmafCqAtTargetMethod = est.method;
    args.variables.vmafLearningSourceTier = tier;
    // Surface the derived media metadata so downstream plugins (and the next job's
    // read side) can use them without re-deriving from the file path each time.
    args.variables.vmafReleaseGroup = releaseGroup;
    args.variables.vmafReleaseGroupUsed = releaseGroup;
    args.variables.vmafMediaType = mediaType;
    args.variables.vmafMediaYear = mediaYear;
    args.variables.vmafMediaSourceType = mediaSourceType;
    args.variables.vmafMediaIsAnimation = isAnimation === 1;
    args.variables.vmafMediaGenre = genres ? genres.split('|') : [];

    return {
        outputFileObj: args.inputFileObj,
        outputNumber: shouldWrite ? 1 : 2,
        variables: args.variables,
    };
};
exports.plugin = plugin;
