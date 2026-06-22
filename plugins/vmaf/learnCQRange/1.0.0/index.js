"use strict";

Object.defineProperty(exports, "__esModule", { value: true });

exports.plugin = exports.details = void 0;

var details = function () { return ({

    name: 'Learn CQ Range',

    description: 'Learns optimal CQ ranges from completed runs using Bayesian inference. Tracks transcode retries, CQ range retries, and VMAF-aware retry decisions for comprehensive learning.',

    style: {

        borderColor: 'blue',

    },

    tags: 'video,vmaf,learning,bayesian',

    isStartPlugin: false,

    pType: '',

    requiresVersion: '2.11.01',

    sidebarPosition: -1,

    icon: 'faBrain',

    inputs: [

        {

            label: 'Learning Enabled',

            name: 'learningEnabled',

            type: 'boolean',

            defaultValue: 'true',

            inputUI: {

                type: 'switch',

            },

            tooltip: 'Enable Bayesian learning from historical runs. Default: true',

        },

        {

            label: 'Prior Weight',

            name: 'priorWeight',

            type: 'number',

            defaultValue: '0.3',

            inputUI: {

                type: 'text',

            },

            tooltip: 'Weight of prior (heuristic) vs observed data (0-1). Higher = trust heuristics more. Default: 0.3 (30% prior, 70% observed)',

        },

        {

            label: 'Minimum Samples for Learning',

            name: 'minSamplesForLearning',

            type: 'number',

            defaultValue: '5',

            inputUI: {

                type: 'text',

            },

            tooltip: 'Minimum historical samples before using learned model. Default: 5',

        },

        {

            label: 'Bitrate Tolerance (%)',

            name: 'bitrateTolerance',

            type: 'number',

            defaultValue: '20',

            inputUI: {

                type: 'text',

            },

            tooltip: 'Bitrate matching tolerance percentage for finding similar sources. Default: 20',

        },

        {

            label: 'CSV Learning Data Path',

            name: 'csvPath',

            type: 'string',

            defaultValue: '/app/configs/vmaf_cq_learning.csv',

            inputUI: {

                type: 'text',

            },

            tooltip: 'Path to CSV file storing learning data. Default: /app/configs/vmaf_cq_learning.csv (accessible on host)',

        },

        {

            label: 'Enable EMA Trend Tracking',

            name: 'emaEnabled',

            type: 'boolean',

            defaultValue: 'true',

            inputUI: {

                type: 'switch',

            },

            tooltip: 'Track exponential moving average trends over time to adapt to system changes',

        },

        {

            label: 'EMA Alpha (Smoothing Factor)',

            name: 'emaAlpha',

            type: 'number',

            defaultValue: '0.1',

            inputUI: {

                type: 'text',

            },

            tooltip: 'EMA smoothing factor (0-1). Lower = more smoothing. 0.1 = ~10 run memory',

        },

        {

            label: 'EMA Priors Path',

            name: 'emaPriorsPath',

            type: 'string',

            defaultValue: '/app/configs/vmaf_ema_priors.json',

            inputUI: {

                type: 'text',

            },

            tooltip: 'Path to JSON file storing EMA priors for variance and CQ predictions',

        },

    ],

    outputs: [

        {

            number: 1,

            tooltip: 'Learning completed',

        },

        {

            number: 2,

            tooltip: 'Learning disabled or insufficient data',

        },

    ],

}); };

exports.details = details;



var plugin = function (args) {

    var lib = require('../../../../../methods/lib')();

    args.inputs = lib.loadDefaultValues(args.inputs, details);



    var fs = require('fs');

    var path = require('path');

    var learningEnabled = args.inputs.learningEnabled !== false && args.inputs.learningEnabled !== 'false';

    var priorWeight = Number(args.inputs.priorWeight);

    if (isNaN(priorWeight) || priorWeight < 0 || priorWeight > 1) priorWeight = 0.3;

    var minSamplesForLearning = Number(args.inputs.minSamplesForLearning) || 5;

    var bitrateTolerance = Number(args.inputs.bitrateTolerance) || 20;

    var csvPath = args.inputs.csvPath || '/app/configs/vmaf_cq_learning.csv';



    args.jobLog('=== Bayesian CQ Range Learning (Enhanced) ===');



    if (!learningEnabled) {

        args.jobLog('Learning is disabled');

        return {

            outputFileObj: args.inputFileObj,

            outputNumber: 2,

            variables: args.variables,

        };

    }



    // Get learning data from selectBestParameters

    var learningData = args.variables.vmafLearningData;

    if (!learningData) {

        args.jobLog('⚠ No learning data available from selectBestParameters');

        return {

            outputFileObj: args.inputFileObj,

            outputNumber: 2,

            variables: args.variables,

        };

    }



    // Get retry history data

    var transcodeFailures = args.variables.vmafTranscodeFailures || [];

    var transcodeRetryHistory = args.variables.vmafTranscodeRetryHistory || [];

    var sweepRetryHistory = args.variables.vmafSweepRetryHistory || [];

    var cqRangeRetryHistory = args.variables.vmafCQRangeRetryHistory || [];

    var releaseGroup = args.variables.vmafReleaseGroup || args.variables.vmafReleaseGroupUsed || '';



    // Get current heuristic CQ range (for prior)

    var heuristicCQMin = args.variables.vmafCalculatedBaseCQ ?

        Math.max(16, args.variables.vmafCalculatedBaseCQ - Math.floor((args.variables.vmafCQRange?.width || 8) / 2)) : null;

    var heuristicCQMax = args.variables.vmafCalculatedBaseCQ ?

        Math.min(51, heuristicCQMin + (args.variables.vmafCQRange?.width || 8)) : null;



    // Load historical data from CSV

    var historicalData = [];

    if (fs.existsSync(csvPath)) {

        try {

            var csvContent = fs.readFileSync(csvPath, 'utf8');

            var lines = csvContent.split('\n').filter(function(line) { return line.trim().length > 0; });



            if (lines.length > 1) {

                // Parse header

                var headers = lines[0].split(',').map(function(h) { return h.trim().replace(/^"|"$/g, ''); });



                // Simple CSV parser that handles quoted fields

                function parseCSVLine(line) {

                    var values = [];

                    var current = '';

                    var inQuotes = false;



                    for (var i = 0; i < line.length; i++) {

                        var char = line[i];

                        if (char === '"') {

                            if (inQuotes && line[i + 1] === '"') {

                                current += '"';

                                i++;

                            } else {

                                inQuotes = !inQuotes;

                            }

                        } else if (char === ',' && !inQuotes) {

                            values.push(current.trim());

                            current = '';

                        } else {

                            current += char;

                        }

                    }

                    values.push(current.trim());

                    return values;

                }



                // Parse data rows

                for (var i = 1; i < lines.length; i++) {

                    try {

                        var values = parseCSVLine(lines[i]);

                        if (values.length >= 10) { // Minimum required fields

                            var row = {};

                            for (var j = 0; j < headers.length && j < values.length; j++) {

                                var val = values[j].replace(/^"|"$/g, '');

                                if (headers[j] === 'timestamp') {

                                    if (val && val.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {

                                        row[headers[j]] = val;

                                    } else {

                                        row = null;

                                        break;

                                    }

                                } else {

                                    var numVal = parseFloat(val);

                                    row[headers[j]] = isNaN(numVal) ? val : numVal;

                                }

                            }

                            if (row) {

                                historicalData.push(row);

                            }

                        }

                    } catch (rowErr) {

                        // Skip invalid rows silently

                    }

                }

            }

            args.jobLog('Loaded ' + historicalData.length + ' historical samples from CSV');

        } catch (err) {

            args.jobLog('⚠ Error reading CSV: ' + err.message);

        }

    } else {

        args.jobLog('CSV file does not exist - will create new file');

    }



    // Find similar sources

    var similarSources = [];

    var sourceBitrate = learningData.source_bitrate_mbps || 0;

    var sourceWidth = learningData.source_width || 1920;

    var sourceHeight = learningData.source_height || 1080;

    var sourceCodec = learningData.source_codec || 'unknown';

    var sourceReleaseGroup = learningData.release_group || releaseGroup || '';

    var currentGenres = (args.variables.vmafMediaGenre || []).map(function(g) { return String(g).toLowerCase(); });

    var currentIsAnimation = args.variables.vmafMediaIsAnimation === true;

    var currentMediaType = args.variables.vmafMediaType || 'unknown';

    var currentMediaYear = args.variables.vmafMediaYear || null;

    var currentMetadataSource = args.variables.vmafMediaMetadataSource || 'none';

    var currentSourceType = String(args.variables.vmafMediaSourceType || 'unknown').toLowerCase();



    // Determine resolution tier

    var pixelCount = sourceWidth * sourceHeight;

    var resolutionTier = 'other';

    if (pixelCount >= 3840 * 2160) resolutionTier = '4K';

    else if (pixelCount >= 2560 * 1440) resolutionTier = '1440p';

    else if (pixelCount >= 1920 * 1080) resolutionTier = '1080p';

    else if (pixelCount >= 1280 * 720) resolutionTier = '720p';



    args.jobLog('Source characteristics:');

    args.jobLog('  Resolution: ' + sourceWidth + 'x' + sourceHeight + ' (' + resolutionTier + ')');

    args.jobLog('  Bitrate: ' + sourceBitrate.toFixed(2) + ' Mbps');

    args.jobLog('  Codec: ' + sourceCodec);

    args.jobLog('  Source type: ' + (currentSourceType || 'unknown'));



    function parseBoolLoose(val) {

        if (val === true) return true;

        if (val === false) return false;

        var s = String(val || '').trim().toLowerCase();

        if (!s) return false;

        return s === 'true' || s === '1' || s === 'yes' || s === 'y';

    }



    // Find similar sources

    for (var i = 0; i < historicalData.length; i++) {

        var hist = historicalData[i];

        var histBitrate = hist.source_bitrate_mbps || 0;

        var histWidth = hist.source_width || 1920;

        var histHeight = hist.source_height || 1080;

        var histCodec = hist.source_codec || 'unknown';

        var histReleaseGroup = String(hist.release_group || '');

        var histYear = hist.media_year !== undefined && hist.media_year !== null ? parseInt(hist.media_year) || 0 : 0;

        var histSourceType = String(hist.media_source_type || '').toLowerCase();



        var histPixelCount = histWidth * histHeight;

        var histResolutionTier = 'other';

        if (histPixelCount >= 3840 * 2160) histResolutionTier = '4K';

        else if (histPixelCount >= 2560 * 1440) histResolutionTier = '1440p';

        else if (histPixelCount >= 1920 * 1080) histResolutionTier = '1080p';

        else if (histPixelCount >= 1280 * 720) histResolutionTier = '720p';



        var bitrateDiff = Math.abs(histBitrate - sourceBitrate);

        var bitrateThreshold = sourceBitrate * (bitrateTolerance / 100);



        var codecCategory = sourceCodec.toLowerCase().indexOf('264') !== -1 ? 'h264' :

                           (sourceCodec.toLowerCase().indexOf('265') !== -1 || sourceCodec.toLowerCase().indexOf('hevc') !== -1 ? 'hevc' :

                           (sourceCodec.toLowerCase().indexOf('av1') !== -1 ? 'av1' : 'other'));

        var histCodecCategory = histCodec.toLowerCase().indexOf('264') !== -1 ? 'h264' :

                                (histCodec.toLowerCase().indexOf('265') !== -1 || histCodec.toLowerCase().indexOf('hevc') !== -1 ? 'hevc' :

                                (histCodec.toLowerCase().indexOf('av1') !== -1 ? 'av1' : 'other'));

        var histGenres = [];

        if (hist.media_genre) {

            histGenres = String(hist.media_genre).split(',').map(function(g) { return g.trim().toLowerCase(); });

        }

        var histIsAnimation = parseBoolLoose(hist.media_is_animation);

        var genreMatchScore = 0;

        if (currentGenres.length > 0 && histGenres.length > 0) {

            var matchingGenres = currentGenres.filter(function(g) { return histGenres.indexOf(g) !== -1; });

            genreMatchScore = matchingGenres.length / Math.max(currentGenres.length, histGenres.length);

        }

        var animationMatches = currentIsAnimation === histIsAnimation;



        var releaseMatches = sourceReleaseGroup && histReleaseGroup && sourceReleaseGroup.toLowerCase() === histReleaseGroup.toLowerCase();

        var yearDistance = (currentMediaYear && histYear) ? Math.abs(currentMediaYear - histYear) : null;



        var sourceTypeMatches = true;

        if (currentSourceType && currentSourceType !== 'unknown' && histSourceType && histSourceType !== 'unknown') {

            sourceTypeMatches = histSourceType === currentSourceType;

        }



        if (histResolutionTier === resolutionTier &&

            bitrateDiff <= bitrateThreshold &&

            codecCategory === histCodecCategory &&

            (currentGenres.length === 0 || genreMatchScore >= 0.3) &&

            animationMatches &&

            sourceTypeMatches) {

            similarSources.push({

                data: hist,

                genreMatchScore: genreMatchScore,

                exactGenreMatch: genreMatchScore === 1,

                releaseMatch: releaseMatches,

                yearDistance: yearDistance

            });

        }

    }



    // Profile prior: median CQ for same resolution tier + codec + animation (ignore genre) when few similar sources

    function computeProfilePriorCQ() {

        var profileMatches = [];

        for (var i = 0; i < historicalData.length; i++) {

            var h = historicalData[i];

            if (h.selected_cq === undefined) continue;

            var hWidth = h.source_width || 1920;

            var hHeight = h.source_height || 1080;

            var hPixels = hWidth * hHeight;

            var hTier = 'other';

            if (hPixels >= 3840 * 2160) hTier = '4K';

            else if (hPixels >= 2560 * 1440) hTier = '1440p';

            else if (hPixels >= 1920 * 1080) hTier = '1080p';

            else if (hPixels >= 1280 * 720) hTier = '720p';



            var hCodecCat = h.source_codec ? h.source_codec.toLowerCase() : 'unknown';

            if (hCodecCat.indexOf('264') !== -1) hCodecCat = 'h264';

            else if (hCodecCat.indexOf('265') !== -1 || hCodecCat.indexOf('hevc') !== -1) hCodecCat = 'hevc';

            else if (hCodecCat.indexOf('av1') !== -1) hCodecCat = 'av1';

            else hCodecCat = 'other';



            var hAnim = h.media_is_animation === true || h.media_is_animation === 'true' || h.media_is_animation === '1';



            if (hTier === resolutionTier && hCodecCat === codecCategory && hAnim === currentIsAnimation) {

                profileMatches.push(h.selected_cq);

            }

        }

        if (profileMatches.length === 0) return null;

        profileMatches.sort(function(a, b) { return a - b; });

        var mid = Math.floor(profileMatches.length / 2);

        var median = profileMatches.length % 2 === 0 ? (profileMatches[mid - 1] + profileMatches[mid]) / 2 : profileMatches[mid];

        return { median: Math.round(median), count: profileMatches.length };

    }



    args.jobLog('Found ' + similarSources.length + ' similar historical sources');



    // Online posterior-style range and next CQ selection

    function linearFit(points) {

        if (!points || points.length === 0) return null;

        var sumX = 0, sumY = 0, sumXY = 0, sumXX = 0, weightTotal = 0;

        for (var i = 0; i < points.length; i++) {

            var p = points[i];

            sumX += p.cq * p.w;

            sumY += p.vmaf * p.w;

            sumXY += p.cq * p.vmaf * p.w;

            sumXX += p.cq * p.cq * p.w;

            weightTotal += p.w;

        }

        if (weightTotal === 0) return null;

        var meanX = sumX / weightTotal;

        var meanY = sumY / weightTotal;

        var denom = sumXX / weightTotal - meanX * meanX;

        if (denom === 0) return null;

        var slope = (sumXY / weightTotal - meanX * meanY) / denom;

        var intercept = meanY - slope * meanX;

        var residuals = 0;

        var n = 0;

        for (var j = 0; j < points.length; j++) {

            var pred = intercept + slope * points[j].cq;

            var diff = points[j].vmaf - pred;

            residuals += diff * diff * points[j].w;

            n += points[j].w;

        }

        var variance = n > 1 ? residuals / Math.max(1, n - 1) : 4; // guard

        return { slope: slope, intercept: intercept, std: Math.sqrt(variance) };

    }



    // Isotonic regression (monotonic) helpers. We enforce a non-increasing VMAF vs CQ curve which is safer than

    // assuming linearity when samples are noisy. Uses PAVA on -VMAF to get a non-decreasing sequence.

    function pavaNonDecreasing(values, weights) {

        var n = values.length;

        var w = weights && weights.length === n ? weights : null;

        var blocks = []; // {s,e,w,v}

        for (var i = 0; i < n; i++) {

            var wi = w ? Number(w[i]) : 1;

            if (!isFinite(wi) || wi <= 0) wi = 1;

            var vi = Number(values[i]);

            if (!isFinite(vi)) vi = 0;

            blocks.push({ s: i, e: i + 1, w: wi, v: vi });

            while (blocks.length >= 2) {

                var b0 = blocks[blocks.length - 2];

                var b1 = blocks[blocks.length - 1];

                if (b0.v <= b1.v) break;

                var wsum = b0.w + b1.w;

                var vavg = wsum ? (b0.v * b0.w + b1.v * b1.w) / wsum : (b0.v + b1.v) / 2;

                blocks.pop();

                blocks.pop();

                blocks.push({ s: b0.s, e: b1.e, w: wsum, v: vavg });

            }

        }

        var out = new Array(n);

        for (var bi = 0; bi < blocks.length; bi++) {

            var b = blocks[bi];

            for (var j = b.s; j < b.e; j++) out[j] = b.v;

        }

        return out;

    }



    function isotonicFitDecreasing(points) {

        if (!points || points.length < 2) return null;

        // Aggregate by CQ (weighted mean VMAF) to avoid duplicate x-values breaking interpolation.

        var byCq = {};

        for (var i = 0; i < points.length; i++) {

            var cq = Number(points[i].cq);

            var vmaf = Number(points[i].vmaf);

            var wt = Number(points[i].w);

            if (!isFinite(cq) || !isFinite(vmaf)) continue;

            if (!isFinite(wt) || wt <= 0) wt = 1;

            var k = cq.toFixed(3);

            if (!byCq[k]) byCq[k] = { cq: cq, sumW: 0, sumVW: 0 };

            byCq[k].sumW += wt;

            byCq[k].sumVW += vmaf * wt;

        }

        var xs = [];

        var ys = [];

        var ws = [];

        for (var k in byCq) {

            if (!Object.prototype.hasOwnProperty.call(byCq, k)) continue;

            var g = byCq[k];

            if (!g.sumW) continue;

            xs.push(g.cq);

            ys.push(g.sumVW / g.sumW);

            ws.push(g.sumW);

        }

        if (xs.length < 2) return null;

        // sort by x

        var idxs = xs.map(function(_v, i) { return i; }).sort(function(a, b) { return xs[a] - xs[b]; });

        var x2 = idxs.map(function(i) { return xs[i]; });

        var y2 = idxs.map(function(i) { return ys[i]; });

        var w2 = idxs.map(function(i) { return ws[i]; });



        // Fit non-increasing y by running PAVA on -y to make it non-decreasing.

        var yNeg = y2.map(function(v) { return -v; });

        var yNegHat = pavaNonDecreasing(yNeg, w2);

        var yHat = yNegHat.map(function(v) { return -v; });



        // Residual stddev for diagnostics.

        var sumW = 0;

        var sumRes2 = 0;

        for (var ri = 0; ri < y2.length; ri++) {

            var r = y2[ri] - yHat[ri];

            sumW += w2[ri];

            sumRes2 += r * r * w2[ri];

        }

        var effN = 0;

        var sumWsq = 0;

        for (var wi = 0; wi < w2.length; wi++) {

            effN += w2[wi];

            sumWsq += w2[wi] * w2[wi];

        }

        var nEff = sumWsq ? (effN * effN) / sumWsq : y2.length;

        var variance = sumW ? sumRes2 / Math.max(1, nEff - 1) : 4;

        return { xs: x2, yHat: yHat, std: Math.sqrt(variance) };

    }



    function estimateCqFromIsotonic(fit, target) {

        if (!fit || !fit.xs || fit.xs.length < 2) return null;

        var xs = fit.xs;

        var ys = fit.yHat;

        var t = Number(target);

        if (!isFinite(t)) return null;



        // ys is non-increasing (as CQ increases).

        if (t > ys[0]) {

            // Extrapolate using first segment if possible (very low confidence).

            var dx0 = xs[1] - xs[0];

            var dy0 = ys[1] - ys[0];

            var slope0 = dx0 !== 0 ? (dy0 / dx0) : 0;

            var ls0 = dx0 !== 0 ? Math.abs(slope0) : null;

            if (dx0 !== 0 && isFinite(slope0) && slope0 < -0.01) {

                var cq0 = xs[0] + (t - ys[0]) / slope0;

                return { cq: cq0, method: 'isotonic_extrap_low', bracketWidth: null, localSlopeAbs: ls0 };

            }

            return { cq: xs[0], method: 'isotonic_clamped_low', bracketWidth: null, localSlopeAbs: ls0 };

        }

        if (t < ys[ys.length - 1]) {

            // Extrapolate using last segment if possible (very low confidence).

            var n = ys.length;

            var dx1 = xs[n - 1] - xs[n - 2];

            var dy1 = ys[n - 1] - ys[n - 2];

            var slope1 = dx1 !== 0 ? (dy1 / dx1) : 0;

            var ls1 = dx1 !== 0 ? Math.abs(slope1) : null;

            if (dx1 !== 0 && isFinite(slope1) && slope1 < -0.01) {

                var cq1 = xs[n - 1] + (t - ys[n - 1]) / slope1;

                return { cq: cq1, method: 'isotonic_extrap_high', bracketWidth: null, localSlopeAbs: ls1 };

            }

            return { cq: xs[xs.length - 1], method: 'isotonic_clamped_high', bracketWidth: null, localSlopeAbs: ls1 };

        }



        for (var i = 0; i < xs.length - 1; i++) {

            if (ys[i] >= t && ys[i + 1] <= t) {

                var x1 = xs[i], x2 = xs[i + 1];

                var y1 = ys[i], y2 = ys[i + 1];

                var bw = Math.abs(x2 - x1);

                var ls = (x2 !== x1) ? Math.abs((y2 - y1) / (x2 - x1)) : null;

                var cq = null;

                if (y2 === y1) cq = (x1 + x2) / 2;

                else cq = x1 + (t - y1) * (x2 - x1) / (y2 - y1);

                return { cq: cq, method: 'isotonic_interp', bracketWidth: bw, localSlopeAbs: ls };

            }

        }

        return null;

    }



    function computeEstimateMeta(points, estimatedCq, method, fitStd, bracketWidth, localSlopeAbs) {

        if (estimatedCq === null || estimatedCq === undefined || !isFinite(estimatedCq)) {

            return { confidence: null, support: null, minAbsDelta: null, method: method || '' };

        }

        var support2 = 0;

        var minAbs = null;

        var hasLower = false;

        var hasUpper = false;

        for (var ti = 0; ti < points.length; ti++) {

            var dcq = Math.abs(points[ti].cq - estimatedCq);

            if (dcq <= 2) support2 += 1;

            if (minAbs === null || dcq < minAbs) minAbs = dcq;

            if (points[ti].cq < estimatedCq) hasLower = true;

            if (points[ti].cq > estimatedCq) hasUpper = true;

        }

        var base = Math.min(1.0, points.length / 20);

        var supportFactor = 0.6 + 0.4 * Math.min(1.0, support2 / 4);

        var noiseFactor = Math.exp(-Math.max(0, isFinite(fitStd) ? fitStd : 0) / 3);

        var bracketFactor = (method === 'isotonic_interp' || (hasLower && hasUpper)) ? 1.0 : 0.75;

        var widthFactor = 1.0;

        if (bracketWidth !== null && bracketWidth !== undefined && isFinite(bracketWidth)) {

            widthFactor = Math.max(0.0, Math.min(1.0, 1.0 - (bracketWidth / 6.0)));

        }

        var slopeFactor = 1.0;

        if (localSlopeAbs !== null && localSlopeAbs !== undefined && isFinite(localSlopeAbs)) {

            slopeFactor = Math.max(0.0, Math.min(1.0, localSlopeAbs / 0.6));

        }

        var confidence = Math.max(0.0, Math.min(1.0, 0.85 * base * bracketFactor * widthFactor * slopeFactor * supportFactor * noiseFactor));

        return {

            confidence: confidence,

            support: support2,

            minAbsDelta: minAbs === null ? null : Math.round(minAbs * 1000) / 1000,

            method: method || ''

        };

    }



    function successScore(pred, target, std) {

        var buffer = 0.5;

        var lower = pred - 1.64 * (std || 1);

        if (lower >= target + buffer) return 1;

        if (pred <= target - 5) return 0;

        var span = 5 + (std || 1);

        return Math.max(0, Math.min(1, (pred - (target - 5)) / span));

    }



    var targetVmaf = learningData.target_min_vmaf || learningData.source_target_vmaf || args.variables.vmafMinVMAF || 90;

    var training = [];

    for (var s = 0; s < similarSources.length; s++) {

        var srcEntry = similarSources[s].data || similarSources[s];

        if (srcEntry.selected_cq === undefined || srcEntry.selected_vmaf === undefined) continue;

        var wt = 1;

        if (srcEntry.transcode_succeeded === 0 || srcEntry.transcode_succeeded === '0') wt = 0.6;

        if (similarSources[s].genreMatchScore && similarSources[s].genreMatchScore > 0.7) wt *= 1.2;

        if (similarSources[s].releaseMatch) wt *= 1.1;

        if (similarSources[s].yearDistance !== null) {

            var yd = similarSources[s].yearDistance;

            if (yd <= 2) wt *= 1.2;

            else if (yd <= 5) wt *= 1.1;

            else if (yd <= 10) wt *= 1.0;

            else if (yd <= 20) wt *= 0.9;

            else wt *= 0.8;

        }

        if (srcEntry.timestamp) {

            var tfit = Date.parse(srcEntry.timestamp);

            if (!isNaN(tfit)) {

                var days = (Date.now() - tfit) / (1000 * 60 * 60 * 24);

                wt *= Math.exp(-days / 120);

            }

        }

        training.push({ cq: srcEntry.selected_cq, vmaf: srcEntry.selected_vmaf, w: wt });

    }



    // Keep the raw linear fit for observability, but avoid using it as guidance when it violates the expected trend:

    // higher CQ should not increase VMAF.

    var modelRaw = training.length > 0 ? linearFit(training) : null;

    var model = modelRaw;

    if (model && (!isFinite(model.slope) || model.slope >= -0.01)) {

        model = null;

    }

    var defaultWidth = (args.variables.vmafCQRange && args.variables.vmafCQRange.width) || 6;

    var bracketMin = heuristicCQMin || 22;

    var bracketMax = heuristicCQMax || Math.min(51, bracketMin + defaultWidth);

    var nextCandidates = [];

    var estimatedCqAtTarget = null;

    var estimatedCqConfidence = null;

    var estimatedCqSupport = null;

    var estimatedCqMinAbsDelta = null;

    var estimatedCqMethod = '';



    // Prefer estimating CQ-at-target from the current file's sweep results (vmafAggregatedResults).

    // This is per-file evidence and avoids nonsense estimates from tiny historical match sets.

    try {

        var sweepAgg = args.variables.vmafAggregatedResults || [];

        var sweepPts = [];

        for (var si = 0; si < sweepAgg.length; si++) {

            var ar = sweepAgg[si];

            if (!ar) continue;

            var cqv = null;

            if (ar.parameterSet && ar.parameterSet.quality !== undefined) cqv = Number(ar.parameterSet.quality);

            if (!isFinite(cqv) && ar.parameterSetId) {

                var mCq = String(ar.parameterSetId).match(/cq(\d+(?:\.\d+)?)/);

                if (mCq) cqv = Number(mCq[1]);

            }

            var vmafv = ar.avgVMAF !== undefined ? Number(ar.avgVMAF) : (ar.avgVMAFMean !== undefined ? Number(ar.avgVMAFMean) : null);

            if (!isFinite(cqv) || !isFinite(vmafv)) continue;

            sweepPts.push({ cq: cqv, vmaf: vmafv, w: 1 });

        }

        if (sweepPts.length >= 2) {

            var isoSweep = isotonicFitDecreasing(sweepPts);

            var estSweep = estimateCqFromIsotonic(isoSweep, targetVmaf);

            if (isoSweep && estSweep && isFinite(estSweep.cq)) {

                estimatedCqAtTarget = Math.max(16, Math.min(51, estSweep.cq));

                estimatedCqMethod = 'current_sweep_' + (estSweep.method || 'isotonic');

                var metaSweep = computeEstimateMeta(sweepPts, estimatedCqAtTarget, estSweep.method || 'isotonic', isoSweep.std, estSweep.bracketWidth, estSweep.localSlopeAbs);

                estimatedCqConfidence = metaSweep.confidence;

                estimatedCqSupport = metaSweep.support;

                estimatedCqMinAbsDelta = metaSweep.minAbsDelta;

                args.jobLog('Estimated CQ-at-target from current sweep: ' + estimatedCqAtTarget.toFixed(2) + ' (method=' + estimatedCqMethod + ', points=' + sweepPts.length + ')');

            }

        }

    } catch (eSweep) {

        // ignore; fall back to historical fit below

    }



    if (model) {

        var slope = model.slope;

        var intercept = model.intercept;

        var estCQ = slope !== 0 ? (targetVmaf - intercept) / slope : (heuristicCQMin || 24);

        if (isNaN(estCQ)) estCQ = heuristicCQMin || 24;

        // Estimate CQ at target using isotonic regression over the training data (monotonic non-increasing VMAF vs CQ).

        // This is more robust than a linear slope, especially when samples are noisy or sparse.

        if (estimatedCqAtTarget === null && training.length >= Math.max(2, minSamplesForLearning)) {

            var iso = isotonicFitDecreasing(training);

            var estIso = estimateCqFromIsotonic(iso, targetVmaf);

            if (iso && estIso && isFinite(estIso.cq)) {

                estimatedCqAtTarget = Math.max(16, Math.min(51, estIso.cq));

                estimatedCqMethod = 'similar_sources_' + (estIso.method || 'isotonic');

                var metaHist = computeEstimateMeta(training, estimatedCqAtTarget, estIso.method || 'isotonic', iso.std, estIso.bracketWidth, estIso.localSlopeAbs);

                estimatedCqConfidence = metaHist.confidence;

                estimatedCqSupport = metaHist.support;

                estimatedCqMinAbsDelta = metaHist.minAbsDelta;

            }

        }

        // If we have a sweep- or isotonic-derived estimate, use it to center the range.

        if (estimatedCqAtTarget !== null && isFinite(estimatedCqAtTarget)) {

            estCQ = estimatedCqAtTarget;

        }

        estCQ = Math.max(16, Math.min(51, estCQ));

        var conf = (estimatedCqConfidence !== null && isFinite(estimatedCqConfidence))
            ? Math.max(0, Math.min(1, estimatedCqConfidence)) : 0.4;
        var adaptiveWidth = Math.max(4, Math.min(8, Math.round(10 - conf * 6)));
        bracketMin = Math.max(16, Math.round(estCQ - Math.ceil(adaptiveWidth / 2)));
        bracketMax = Math.min(51, Math.round(estCQ + Math.ceil(adaptiveWidth / 2)));

        var probeSet = [];
        var mid = Math.round((bracketMin + bracketMax) / 2);

        probeSet.push(mid);

        probeSet.push(bracketMin);

        probeSet.push(bracketMax);

        // add point closest to estimated CQ

        if (probeSet.indexOf(Math.round(estCQ)) === -1) {

            probeSet.push(Math.round(estCQ));

        }

        var uniqueProbe = Array.from(new Set(probeSet)).filter(function(cq) { return cq >= bracketMin && cq <= bracketMax; });

        uniqueProbe.sort(function(a, b) { return a - b; });

        var scored = uniqueProbe.map(function(cq) {

            var pred = intercept + slope * cq;

            var sc = successScore(pred, targetVmaf, model.std);

            return { cq: cq, score: sc, pred: pred };

        }).sort(function(a, b) { return b.score - a.score; });

        nextCandidates = scored.slice(0, 3).map(function(x) { return x.cq; });



        args.jobLog('');

        if (estimatedCqMethod && estimatedCqMethod.indexOf('current_sweep_') === 0) {

            args.jobLog('Historical guidance (prior): fit VMAF ≈ ' + intercept.toFixed(2) + ' + (' + slope.toFixed(3) + ' * CQ), σ=' + model.std.toFixed(3) + ' (samples=' + training.length + ')');

        } else {

            args.jobLog('Posterior CQ guidance: fit VMAF ≈ ' + intercept.toFixed(2) + ' + (' + slope.toFixed(3) + ' * CQ), σ=' + model.std.toFixed(3) + ' (samples=' + training.length + ')');

        }

        if (estimatedCqAtTarget !== null && isFinite(estimatedCqAtTarget)) {

            args.jobLog('  Estimated CQ for target ' + targetVmaf + ': ' + estimatedCqAtTarget.toFixed(2) + ' (method=' + (estimatedCqMethod || 'unknown') + ')');

        } else {

            args.jobLog('  Estimated CQ for target ' + targetVmaf + ': ' + estCQ.toFixed(2) + ' (linear fallback)');

        }

    } else {

        if (estimatedCqAtTarget !== null && isFinite(estimatedCqAtTarget)) {

            var estCenter = Math.max(16, Math.min(51, estimatedCqAtTarget));

            bracketMin = Math.max(16, Math.round(estCenter - Math.ceil(defaultWidth / 2)));

            bracketMax = Math.min(51, Math.round(estCenter + Math.ceil(defaultWidth / 2)));

            args.jobLog('Insufficient similar samples (' + similarSources.length + ' < ' + minSamplesForLearning + '), using sweep-derived range centered at ' + estCenter.toFixed(2));

        } else {

            args.jobLog('Insufficient similar samples (' + similarSources.length + ' < ' + minSamplesForLearning + '), using heuristic range');

        }

    }



    // If still no learned range, fallback to profile prior (resolution tier + codec + animation)

    if (!model && (estimatedCqAtTarget === null || !isFinite(estimatedCqAtTarget)) && !args.variables.vmafLearnedCQRange) {

        var prior = computeProfilePriorCQ();

        if (prior) {

            var span = 4;

            var priorMin = Math.max(16, prior.median - Math.floor(span / 2));

            var priorMax = Math.min(51, priorMin + span);

            bracketMin = priorMin;

            bracketMax = priorMax;

            args.jobLog('Using profile prior CQ range (median ' + prior.median + ', count ' + prior.count + '): ' + priorMin + '-' + priorMax);

        }

    }



    args.variables.vmafLearnedCQRange = {

        min: bracketMin,

        max: bracketMax,

        confidence: (estimatedCqConfidence !== null && isFinite(estimatedCqConfidence)) ? estimatedCqConfidence : Math.min(1.0, similarSources.length / 20),

        sampleCount: (estimatedCqSupport !== null && isFinite(estimatedCqSupport)) ? estimatedCqSupport : similarSources.length

    };



    // Export learned model for adaptive CQ step

    if (model && model.slope !== undefined && model.intercept !== undefined) {

        args.variables.vmafLearnedModel = {

            slope: model.slope,

            intercept: model.intercept,

            std: model.std,

            sampleCount: training.length

        };

        args.jobLog('Exported learned model: slope=' + model.slope.toFixed(3) + ', intercept=' + model.intercept.toFixed(2) + ', std=' + model.std.toFixed(2));

    }



    args.variables.vmafOverrideCQMin = bracketMin;

    args.variables.vmafOverrideCQMax = bracketMax;

    if (nextCandidates.length === 0) {

        var center = Math.round((bracketMin + bracketMax) / 2);

        nextCandidates = [center, bracketMin, bracketMax];

    }

    args.variables.vmafNextCQs = nextCandidates;

    args.jobLog('Posterior CQ range: ' + bracketMin + '-' + bracketMax
    + ' (adaptive width ' + adaptiveWidth + ', conf=' + ((estimatedCqConfidence !== null && isFinite(estimatedCqConfidence)) ? estimatedCqConfidence.toFixed(3) : 'n/a') + ')'
    + ' | Next CQs: ' + nextCandidates.join(', '));



    // Log retry history for analysis

    args.jobLog('');

    args.jobLog('=== Retry History Analysis ===');



    // Transcode retry history

    if (transcodeRetryHistory.length > 0) {

        args.jobLog('Transcode Retries: ' + transcodeRetryHistory.length);

        for (var i = 0; i < transcodeRetryHistory.length; i++) {

            var retry = transcodeRetryHistory[i];

            args.jobLog('  Retry #' + (i + 1) + ': CQ ' + retry.fromCQ + ' → ' + retry.toCQ +

                       ' (VMAF at target: ' + (retry.vmafAtToCQ ? retry.vmafAtToCQ.toFixed(2) : 'N/A') + ')');

        }

    } else {

        args.jobLog('Transcode Retries: None');

    }



    // Sweep retry history

    if (sweepRetryHistory.length > 0) {

        args.jobLog('Sweep Retries (triggered by transcode): ' + sweepRetryHistory.length);

        for (var i = 0; i < sweepRetryHistory.length; i++) {

            var sweepRetry = sweepRetryHistory[i];

            args.jobLog('  Sweep Retry #' + (i + 1) + ': Trigger CQ ' + sweepRetry.triggerCQ +

                       ' → Range ' + sweepRetry.newCQRange + ' (Reason: ' + sweepRetry.reason + ')');

        }

    }



    // CQ range retry history

    if (cqRangeRetryHistory.length > 0) {

        args.jobLog('CQ Range Retries (from selectBestParameters): ' + cqRangeRetryHistory.length);

        for (var i = 0; i < cqRangeRetryHistory.length; i++) {

            var rangeRetry = cqRangeRetryHistory[i];

            args.jobLog('  Range Retry #' + (i + 1) + ': ' + rangeRetry.newRange +

                       ' (Reason: ' + rangeRetry.reason + ', Executed: ' + (rangeRetry.executed ? 'Yes' : 'No') + ')');

        }

    }



    // Transcode failures analysis. learnedCQMin/Max start from the posterior bracket and

    // are shifted upward when a failure occurred inside the learned range.

    var learnedCQMin = (args.variables.vmafLearnedCQRange && isFinite(args.variables.vmafLearnedCQRange.min))

        ? args.variables.vmafLearnedCQRange.min : bracketMin;

    var learnedCQMax = (args.variables.vmafLearnedCQRange && isFinite(args.variables.vmafLearnedCQRange.max))

        ? args.variables.vmafLearnedCQRange.max : bracketMax;

    if (transcodeFailures.length > 0) {

        args.jobLog('');

        args.jobLog('Transcode Failures/Successes:');

        for (var f = 0; f < transcodeFailures.length; f++) {

            var failure = transcodeFailures[f];

            var status = failure.succeeded ? '✓' : '✗';

            args.jobLog('  ' + status + ' CQ ' + failure.originalCQ + ' → ' + failure.finalCQ +

                       ' (Retries: ' + failure.retries + ', Reason: ' + failure.reason + ')');



            // Adjust learned range based on failures

            if (!failure.succeeded && failure.originalCQ && learnedCQMin !== null && learnedCQMax !== null) {

                var failureCQ = failure.originalCQ;

                if (failureCQ <= learnedCQMax && failureCQ >= learnedCQMin) {

                    var shift = Math.min(3, failureCQ - learnedCQMin + 2);

                    learnedCQMin = Math.min(51, learnedCQMin + shift);

                    learnedCQMax = Math.min(51, learnedCQMax + shift);

                    args.jobLog('  → Adjusted learned range to avoid failure: CQ ' + learnedCQMin + '-' + learnedCQMax);

                }

            }

        }



        // Update learned range if adjusted

        if (learnedCQMin !== null && learnedCQMax !== null) {

            args.variables.vmafLearnedCQRange = {

                min: learnedCQMin,

                max: learnedCQMax,

                confidence: Math.min(1.0, similarSources.length / 20),

                sampleCount: similarSources.length

            };

        }

    }



    // Save current run to CSV with enhanced retry tracking

    try {

        var now = new Date();

        if (isNaN(now.getTime())) {

            now = new Date(Date.now());

        }

        var timestamp = now.toISOString();



        if (!timestamp || !timestamp.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {

            timestamp = new Date(Date.now()).toISOString();

        }



        // Compile retry data

        var transcodeRetryCount = transcodeRetryHistory.length;

        var transcodeRetryCQs = transcodeRetryHistory.map(function(r) { return r.toCQ; }).join(';');

        var transcodeRetryVMAFs = transcodeRetryHistory.map(function(r) {

            return r.vmafAtToCQ ? r.vmafAtToCQ.toFixed(2) : 'N/A';

        }).join(';');



        var sweepRetryCount = sweepRetryHistory.length;

        var sweepRetryRanges = sweepRetryHistory.map(function(r) { return r.newCQRange; }).join(';');

        var sweepRetryReasons = sweepRetryHistory.map(function(r) { return r.reason; }).join(';');



        var cqRangeRetryCount = cqRangeRetryHistory.filter(function(r) { return r.executed; }).length;

        var cqRangeRetryRanges = cqRangeRetryHistory.filter(function(r) { return r.executed; }).map(function(r) { return r.newRange; }).join(';');

        var cqRangeRetryReasons = cqRangeRetryHistory.filter(function(r) { return r.executed; }).map(function(r) { return r.reason; }).join(';');



        // Get final outcome

        var finalCQ = learningData.selected_cq;

        var transcodeSucceeded = true;

        var totalRetries = transcodeRetryCount;



        if (transcodeFailures.length > 0) {

            var lastFailure = transcodeFailures[transcodeFailures.length - 1];

            if (lastFailure.finalCQ) {

                finalCQ = lastFailure.finalCQ;

            }

            totalRetries = lastFailure.retries || 0;

            transcodeSucceeded = lastFailure.succeeded !== false;

        }



        var mediaGenreString = (args.variables.vmafMediaGenre || []).join(';');

        var mediaIsAnimationVal = args.variables.vmafMediaIsAnimation === true ? '1' : '0';

        var mediaTypeVal = args.variables.vmafMediaType || 'unknown';

        var mediaYearVal = args.variables.vmafMediaYear || '';

        var mediaSourceVal = args.variables.vmafMediaMetadataSource || 'none';



        function escapeCsvField(val) {

            var str = String(val);

            if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1 || str.indexOf(';') !== -1) {

                return '"' + str.replace(/"/g, '""') + '"';

            }

            return str;

        }

        function formatCsvRow(values) {

            return values.map(escapeCsvField).join(',');

        }



        // Persist the model-derived CQ-at-target so future runs can bias toward retry-avoiding CQ even if we overshot VMAF.

        // Also persist fit parameters for observability/debugging.

        var modelSlope = modelRaw && isFinite(modelRaw.slope) ? modelRaw.slope : '';

        var modelIntercept = modelRaw && isFinite(modelRaw.intercept) ? modelRaw.intercept : '';

        var modelStd = modelRaw && isFinite(modelRaw.std) ? modelRaw.std : '';

        var modelTrainingSamples = training ? training.length : '';

        var estCqRounded = estimatedCqAtTarget !== null && isFinite(estimatedCqAtTarget) ? Math.round(estimatedCqAtTarget * 100) / 100 : '';

        var estConfRounded = estimatedCqConfidence !== null && isFinite(estimatedCqConfidence) ? Math.round(estimatedCqConfidence * 1000) / 1000 : '';

        var estSupportVal = estimatedCqSupport !== null && isFinite(estimatedCqSupport) ? estimatedCqSupport : '';

        var estMinAbsVal = estimatedCqMinAbsDelta !== null && isFinite(estimatedCqMinAbsDelta) ? estimatedCqMinAbsDelta : '';

        var estMethod = estCqRounded !== '' ? (estimatedCqMethod || 'isotonic') : '';



        var csvRowValues = [

            timestamp,

            learningData.source_bitrate_mbps || '',

            learningData.source_width || '',

            learningData.source_height || '',

            learningData.source_codec || '',

            learningData.source_duration_sec || '',

            learningData.source_file_size_mb || '',

            learningData.bits_per_pixel || '',

            learningData.tested_cq_min || '',

            learningData.tested_cq_max || '',

            finalCQ || learningData.selected_cq || '',

            learningData.selected_vmaf || '',

            learningData.selected_ssim || '',

            learningData.selected_cambi || '',

            learningData.selected_projected_output_bpp || '',

            learningData.selected_projected_output_ratio_pct || '',

            learningData.target_min_vmaf || '',

            (args.variables.vmafQualityRiskPolicy ? args.variables.vmafQualityRiskPolicy.adaptiveFrameFloor : '') || '',

            learningData.actual_size_reduction_pct || '',

            learningData.met_vmaf_target ? '1' : '0',

            learningData.met_size_target ? '1' : '0',

            totalRetries,

            transcodeSucceeded ? '1' : '0',

            transcodeRetryCount,

            transcodeRetryCQs || '',

            transcodeRetryVMAFs || '',

            sweepRetryCount,

            sweepRetryRanges || '',

            sweepRetryReasons || '',

            cqRangeRetryCount,

            cqRangeRetryRanges || '',

            cqRangeRetryReasons || '',

            mediaGenreString,

            mediaIsAnimationVal,

            mediaTypeVal,

            mediaYearVal,

            mediaSourceVal,

            learningData.media_source_type || '',

            estCqRounded,

            estConfRounded,

            estMethod,

            estSupportVal,

            estMinAbsVal,

            modelSlope,

            modelIntercept,

            modelStd,

            modelTrainingSamples

        ];

        var csvRow = formatCsvRow(csvRowValues);



        var csvHeader = 'timestamp,source_bitrate_mbps,source_width,source_height,source_codec,source_duration_sec,source_file_size_mb,bits_per_pixel,tested_cq_min,tested_cq_max,selected_cq,selected_vmaf,selected_ssim,selected_cambi,selected_projected_output_bpp,selected_projected_output_ratio_pct,target_min_vmaf,adaptive_frame_floor_used,actual_size_reduction_pct,met_vmaf_target,met_size_target,total_retries,transcode_succeeded,transcode_retry_count,transcode_retry_cqs,transcode_retry_vmafs,sweep_retry_count,sweep_retry_ranges,sweep_retry_reasons,cq_range_retry_count,cq_range_retry_ranges,cq_range_retry_reasons,media_genre,media_is_animation,media_type,media_year,media_metadata_source,media_source_type,estimated_cq_at_target,estimated_cq_confidence,estimated_cq_method,estimated_cq_support,estimated_cq_min_abs_delta,model_slope,model_intercept,model_std,model_training_samples';



        var fileExists = fs.existsSync(csvPath);

        var csvDir = path.dirname(csvPath);

        if (csvDir && !fs.existsSync(csvDir)) {

            fs.mkdirSync(csvDir, { recursive: true });

        }



        // The header must exactly match the row format this plugin writes. If it does not

        // (older lean-schema writers left mismatched headers that silently corrupted the

        // similar-source matching), migrate: keep only rows with the canonical column count.

        if (fileExists) {

            try {

                var existing = fs.readFileSync(csvPath, 'utf8');

                var existingLines = existing.split('\n').filter(function(l) { return l && l.trim().length > 0; });

                if (existingLines.length > 0 && existingLines[0].trim() !== csvHeader) {

                    var expectedCols = csvHeader.split(',').length;

                    function countCsvCols(line) {

                        var n = 1;

                        var inQ = false;

                        for (var ci = 0; ci < line.length; ci++) {

                            var ch = line[ci];

                            if (ch === '"') inQ = !inQ;

                            else if (ch === ',' && !inQ) n++;

                        }

                        return n;

                    }

                    var migrated = [csvHeader];

                    var droppedRows = 0;

                    for (var li = 1; li < existingLines.length; li++) {

                        if (countCsvCols(existingLines[li]) === expectedCols) migrated.push(existingLines[li]);

                        else droppedRows++;

                    }

                    fs.writeFileSync(csvPath + '.pre_migration.bak', existing);

                    fs.writeFileSync(csvPath, migrated.join('\n'));

                    args.jobLog('Migrated learning CSV to canonical schema: ' + (migrated.length - 1) + ' rows kept, '

                        + droppedRows + ' dropped (backup: ' + csvPath + '.pre_migration.bak)');

                }

            } catch (upgradeErr) {

                args.jobLog('Warning: could not migrate learning CSV header: ' + (upgradeErr && upgradeErr.message ? upgradeErr.message : String(upgradeErr)));

            }

        }



        if (fileExists) {

            fs.appendFileSync(csvPath, '\n' + csvRow);

        } else {

            fs.writeFileSync(csvPath, csvHeader + '\n' + csvRow);

        }



        args.jobLog('');

        args.jobLog('✓ Saved enhanced learning data to CSV: ' + csvPath);

        args.jobLog('  Total retries tracked: ' + totalRetries);

        args.jobLog('  Transcode retries: ' + transcodeRetryCount);

        args.jobLog('  Sweep retries: ' + sweepRetryCount);

        args.jobLog('  CQ range retries: ' + cqRangeRetryCount);

    } catch (err) {

        args.jobLog('⚠ Error saving to CSV: ' + err.message);

    }



    // Update EMA state for trend tracking

    try {

        var path = require('path');

        var emaStatePath = path.join(path.dirname(csvPath), 'ema_cq_state.json');

        var emaState = {

            ema: {},

            alpha: 0.1,

            sampleCounts: {},

            lastUpdated: new Date().toISOString()

        };



        // Load existing state

        if (fs.existsSync(emaStatePath)) {

            try {

                var emaContent = fs.readFileSync(emaStatePath, 'utf8');

                emaState = JSON.parse(emaContent);

            } catch (e) {

                args.jobLog('⚠ Could not load EMA state, using defaults');

            }

        }



        // Determine resolution tier (same logic as CSV writing)

        var tier = resolutionTier;  // Already calculated earlier in the code

        var selectedCQ = finalCQ || learningData.selected_cq;



        if (tier && selectedCQ !== undefined && isFinite(selectedCQ)) {

            // Update EMA: ema_new = alpha * cq_new + (1 - alpha) * ema_old

            if (!(tier in emaState.ema)) {

                emaState.ema[tier] = selectedCQ;

                emaState.sampleCounts[tier] = 1;

            } else {

                var alpha = emaState.alpha || 0.1;

                emaState.ema[tier] = alpha * selectedCQ + (1 - alpha) * emaState.ema[tier];

                emaState.sampleCounts[tier] = (emaState.sampleCounts[tier] || 0) + 1;

            }



            emaState.lastUpdated = new Date().toISOString();



            // Save updated state

            fs.writeFileSync(emaStatePath, JSON.stringify(emaState, null, 2));



            args.jobLog('Updated EMA for ' + tier + ': ' + emaState.ema[tier].toFixed(2) + ' CQ (N=' + emaState.sampleCounts[tier] + ')');

        }

    } catch (emaErr) {

        args.jobLog('⚠ Error updating EMA state: ' + emaErr.message);

    }



    return {

        outputFileObj: args.inputFileObj,

        outputNumber: 1,

        variables: args.variables,

    };

};

exports.plugin = plugin;
