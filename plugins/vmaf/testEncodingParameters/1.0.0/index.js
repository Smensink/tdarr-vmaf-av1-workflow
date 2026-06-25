"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var details = function () { return ({
    name: 'Test Encoding Parameters',
    description: 'Encodes video samples with different parameters to find optimal settings.',
    style: {
        borderColor: 'orange',
    },
    tags: 'video,vmaf,encode,test',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faFlask',
    inputs: [
        {
            label: 'Use Dynamic CQ Range',
            name: 'dynamicCQ',
            type: 'boolean',
            defaultValue: 'true',
            inputUI: {
                type: 'switch',
            },
            tooltip: 'Automatically calculate optimal CQ range based on source file bitrate, resolution, and target compression. Overrides manual CQ values when enabled.',
        },
        {
            label: 'Target Minimum VMAF',
            name: 'targetMinVMAF',
            type: 'number',
            defaultValue: '95',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Target minimum VMAF score for dynamic CQ calculation. Used to estimate how aggressive compression can be. Default: 95 (visually-transparent floor; the 4K model reads optimistically, so do not go below this for 4K)',
        },
        {
            label: 'Target Size Reduction (%)',
            name: 'targetSizeReduction',
            type: 'number',
            defaultValue: '30',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Target size reduction percentage for dynamic CQ calculation. Higher = more aggressive CQ range. Default: 30',
        },
        {
            label: 'CQ Range Width',
            name: 'cqRangeWidth',
            type: 'number',
            defaultValue: '8',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Width of CQ range to test (total span from lowest to highest CQ). Default: 8 (e.g., CQ 26-34)',
        },
        {
            label: 'CQ Step Size',
            name: 'cqStep',
            type: 'number',
            defaultValue: '2',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Step size between CQ values. Default: 2 (e.g., 26, 28, 30, 32, 34)',
        },
        {
            label: 'Enable Adaptive CQ Step',
            name: 'adaptiveCQStep',
            type: 'boolean',
            defaultValue: 'true',
            inputUI: {
                type: 'switch',
            },
            tooltip: 'Automatically adjust CQ step based on VMAF slope: finer for steep, coarser for flat',
        },
        {
            label: 'Steep Slope Threshold',
            name: 'steepSlopeThreshold',
            type: 'number',
            defaultValue: '1.5',
            inputUI: {
                type: 'text',
            },
            tooltip: 'VMAF drop per CQ unit to consider steep (reduce step by 1)',
        },
        {
            label: 'Flat Slope Threshold',
            name: 'flatSlopeThreshold',
            type: 'number',
            defaultValue: '0.5',
            inputUI: {
                type: 'text',
            },
            tooltip: 'VMAF drop per CQ unit to consider flat (increase step by 1)',
        },
        {
            label: 'Manual CRF/CQ Values (comma-separated)',
            name: 'crfValues',
            type: 'string',
            defaultValue: '24,26,28,30,32',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Manual CRF/CQ values to test (only used if Dynamic CQ is disabled). e.g., 24,26,28,30,32',
        },
        {
            label: 'Presets (comma-separated)',
            name: 'presets',
            type: 'string',
            defaultValue: 'p7',
            inputUI: {
                type: 'text',
            },
            tooltip: 'NVENC presets to test (e.g., p4,p5,p6,p7). p7 is highest quality.',
        },
        {
            label: 'Enable Progressive CQ Expansion',
            name: 'progressiveCQExpansion',
            type: 'boolean',
            defaultValue: 'true',
            inputUI: {
                type: 'switch',
            },
            tooltip: 'Start with 3 CQ values, expand only if target not bracketed (saves encoding time)',
        },
        {
            label: 'Initial CQ Count',
            name: 'initialCQCount',
            type: 'number',
            defaultValue: '3',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Number of CQ values to test in initial bracket (3-5 recommended)',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'Parameter testing completed',
        },
    ],
}); };
exports.details = details;
var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    var fs = require('fs');
    var path = require('path');
    var execSync = require('child_process').execSync;

// Maps color primaries/TRC/matrix to integer values for av1_metadata bitstream filter.
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
        if (v.indexOf('bt709') !== -1) return 1;
        return 2;
    }
    function mapMatrix(v) {
        v = String(v == null ? '' : v).toLowerCase().trim();
        if (v === '' || v === 'undefined') return 9; // safe default for HDR: bt2020nc
        if (v.indexOf('bt2020') !== -1) return 9;
        if (v.indexOf('bt709') !== -1) return 1;
        return 2;
    }
    return {
        bsf: 'av1_metadata=color_primaries=' + mapPrimaries(colorPrimaries) + ':transfer_characteristics=' + mapTransfer(colorTrc) + ':matrix_coefficients=' + mapMatrix(colorspace)
    };
}

    // Read inputs
    var dynamicCQ = args.inputs.dynamicCQ !== false && args.inputs.dynamicCQ !== 'false';
    var targetMinVMAF = Number(args.inputs.targetMinVMAF) || 90;
    var targetSizeReduction = Number(args.inputs.targetSizeReduction) || 30;
    var cqRangeWidth = Number(args.inputs.cqRangeWidth) || 8;
    var cqStep = Number(args.inputs.cqStep) || 2;
    var effectiveRangeWidth = cqRangeWidth;
    var effectiveStep = cqStep;
    
    // ENHANCEMENT FIX #14: Input validation
    if (isNaN(cqStep) || cqStep <= 0) {
        args.jobLog('WARNING: Invalid cqStep (' + args.inputs.cqStep + '), using default 2');
        cqStep = 2;
        effectiveStep = 2;
    }

    // Must be initialised before the adaptive-step call below (previously it was declared
    // further down, so the current-sweep slope fallback always saw undefined).
    var aggregatedResults = Array.isArray(args.variables.vmafAggregatedResults) ? args.variables.vmafAggregatedResults : [];

    // Adaptive CQ step function
    function getAdaptiveCQStep(baseStep, historicalSlope, aggregatedResults, steepThreshold, flatThreshold) {
        var absSlope = Math.abs(historicalSlope || 0);

        // Method 1: Use learned model slope if available and reliable
        if (historicalSlope && isFinite(historicalSlope) && historicalSlope < -0.01) {
            if (absSlope > steepThreshold) {
                args.jobLog('Steep VMAF slope detected (' + absSlope.toFixed(2) + ') - reducing step to ' + Math.max(1, baseStep - 1));
                return Math.max(1, baseStep - 1);  // Finer steps
            } else if (absSlope < flatThreshold) {
                args.jobLog('Flat VMAF slope detected (' + absSlope.toFixed(2) + ') - increasing step to ' + Math.min(4, baseStep + 1));
                return Math.min(4, baseStep + 1);  // Coarser steps
            }
        }

        // Method 2: Fallback to current sweep analysis
        if (aggregatedResults && aggregatedResults.length >= 2) {
            var cqPoints = aggregatedResults.filter(function(r) {
                return r.parameterSet && r.parameterSet.quality !== undefined && r.avgVMAF !== undefined;
            }).map(function(r) {
                return { cq: r.parameterSet.quality, vmaf: r.avgVMAF };
            }).sort(function(a, b) { return a.cq - b.cq; });

            if (cqPoints.length >= 2) {
                var totalSlope = 0;
                var count = 0;
                for (var i = 0; i < cqPoints.length - 1; i++) {
                    var dCQ = cqPoints[i + 1].cq - cqPoints[i].cq;
                    var dVMAF = cqPoints[i + 1].vmaf - cqPoints[i].vmaf;
                    if (dCQ > 0) {
                        totalSlope += Math.abs(dVMAF / dCQ);
                        count++;
                    }
                }
                var avgSlope = count > 0 ? totalSlope / count : 0;

                if (avgSlope > steepThreshold) {
                    args.jobLog('Current sweep shows steep slope (' + avgSlope.toFixed(2) + ') - reducing step');
                    return Math.max(1, baseStep - 1);
                } else if (avgSlope < flatThreshold) {
                    args.jobLog('Current sweep shows flat slope (' + avgSlope.toFixed(2) + ') - increasing step');
                    return Math.min(4, baseStep + 1);
                }
            }
        }

        return baseStep;
    }

    // Apply adaptive step if enabled
    var adaptiveCQStep = args.inputs.adaptiveCQStep !== false && args.inputs.adaptiveCQStep !== 'false';
    if (adaptiveCQStep) {
        var steepThreshold = Number(args.inputs.steepSlopeThreshold) || 1.5;
        var flatThreshold = Number(args.inputs.flatSlopeThreshold) || 0.5;

        // Get historical slope from learned model
        var historicalSlope = null;
        if (args.variables.vmafLearnedModel && args.variables.vmafLearnedModel.slope) {
            historicalSlope = args.variables.vmafLearnedModel.slope;
        }

        effectiveStep = getAdaptiveCQStep(cqStep, historicalSlope, aggregatedResults, steepThreshold, flatThreshold);

        if (effectiveStep !== cqStep) {
            args.jobLog('Adaptive CQ step: ' + cqStep + ' → ' + effectiveStep);
        }
    }

    args.variables.vmafCQStep = cqStep;
    args.variables.vmafCQStepEffective = effectiveStep;
    
    var crfValuesStr = String(args.inputs.crfValues) || '24,26,28,30,32';
    var presetsStr = String(args.inputs.presets) || 'p7';
    
    var targetMinVMAF = Number(args.inputs.targetMinVMAF);
    if (isNaN(targetMinVMAF) || targetMinVMAF < 0 || targetMinVMAF > 100) {
        args.jobLog('WARNING: Invalid targetMinVMAF (' + args.inputs.targetMinVMAF + '), using default 90');
        targetMinVMAF = 90;
    }
    
    var targetSizeReduction = Number(args.inputs.targetSizeReduction);
    if (isNaN(targetSizeReduction) || targetSizeReduction < 0 || targetSizeReduction > 100) {
        args.jobLog('WARNING: Invalid targetSizeReduction (' + args.inputs.targetSizeReduction + '), using default 30');
        targetSizeReduction = 30;
    }
    
    var cqRangeWidth = Number(args.inputs.cqRangeWidth);
    if (isNaN(cqRangeWidth) || cqRangeWidth <= 0) {
        args.jobLog('WARNING: Invalid cqRangeWidth (' + args.inputs.cqRangeWidth + '), using default 8');
        cqRangeWidth = 8;
        effectiveRangeWidth = 8;
    }
    
    var samples = args.variables.vmafSamples || [];
    var targetCodec = args.variables.vmafTargetCodec || 'av1';
    var useGPU = args.variables.vmafUseGPU || false;
    var gpuEncoder = args.variables.vmafGPUEncoder || null;
    var isHDR = args.variables.isHDR || false;
    var pixFmt = args.variables.pix_fmt || 'yuv420p';
    var colorPrimaries = args.variables.color_primaries || 'bt709';
    var colorTrc = args.variables.color_trc || 'bt709';
    var colorspace = args.variables.colorspace || 'bt709';
    var hdrMasterDisplay = args.variables.hdr_master_display || '';
    var hdrMaxCll = args.variables.hdr_max_cll || '';
    var releaseGroup = args.variables.vmafReleaseGroup || '';
    
    if (samples.length === 0) {
        args.jobLog('Error: No video samples found. Run Extract Video Samples first.');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    
    var cacheDir = args.workDir || '/temp';
    var crfValues = [];
    
    // Guided/override CQ selection (learning + retries)
    var overrideCQMin = args.variables.vmafOverrideCQMin;
    var overrideCQMax = args.variables.vmafOverrideCQMax;
    var guidedNext = Array.isArray(args.variables.vmafNextCQs) ? args.variables.vmafNextCQs : (args.variables.vmafNextCQ ? [args.variables.vmafNextCQ] : []);
    var isRetry = overrideCQMin !== undefined && overrideCQMax !== undefined;
    
    if (isRetry || guidedNext.length > 0) {
        args.jobLog('=== Guided CQ Selection ===');
        if (isRetry) {
            args.jobLog('Override CQ range: ' + overrideCQMin + ' - ' + overrideCQMax);
        }
        
        var testedCQs = args.variables.vmafTestedCQs || [];
        args.jobLog('Already tested CQ values: ' + (testedCQs.length > 0 ? testedCQs.slice().sort(function(a, b) { return a - b; }).join(', ') : 'none'));
        
        var candidateList = guidedNext.slice(0, 6);
        if (candidateList.length === 0 && isRetry) {
            for (var cq = overrideCQMin; cq <= overrideCQMax; cq += effectiveStep) {
                candidateList.push(cq);
            }
        }
        if (isRetry) {
            candidateList = candidateList.filter(function(cqVal) { return cqVal >= overrideCQMin && cqVal <= overrideCQMax; });
        }

        // ── Known-failed CQ adjustment: shift bracket below previous failures ──
        // When a file is re-queued, any CQ that previously fell short of the VMAF target
        // means compression was too aggressive. The fix is to try LOWER CQs (more bitrate,
        // higher quality), not just skip the failed values.
        var knownFailedCQs = [];
        var lowestFailedCQ = null;
        try {
            var _kfVdb = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
            var _kfDb = _kfVdb.openDb();
            var _kfFilePath = (args.inputFileObj && args.inputFileObj._id) || (args.inputFileObj && args.inputFileObj.file) || '';
            if (_kfFilePath) {
                var _kfPrev = _kfVdb.getSameFileSweepCurves(_kfDb, _kfFilePath, { limit: 200 });
                var _kfTarget = (typeof targetMinVMAF !== 'undefined' && targetMinVMAF) || Number(args.inputs.targetMinVMAF) || Number(args.variables.vmafMinVMAF) || 95;
                var _kfSeenCQ = {};
                for (var _kfi = 0; _kfi < _kfPrev.length; _kfi++) {
                    var _kfr = _kfPrev[_kfi];
                    if (_kfr.vmaf_mean !== null && _kfr.vmaf_mean < _kfTarget && !_kfSeenCQ[_kfr.cq]) {
                        knownFailedCQs.push(_kfr.cq);
                        _kfSeenCQ[_kfr.cq] = true;
                    }
                }
                if (knownFailedCQs.length > 0) {
                    knownFailedCQs.sort(function(a,b){return a-b;});
                    lowestFailedCQ = knownFailedCQs[0];
                    args.jobLog('Same-file history: ' + knownFailedCQs.length + ' CQ(s) failed VMAF target: ' + knownFailedCQs.join(', ') + '. Lowest failed CQ=' + lowestFailedCQ);
                }
            }
            // Do NOT close: openDb() returns a process-cached handle shared by every plugin/job.
            // Closing it here left the cache holding a CLOSED handle, so every later job's
            // predictor failed with "database is not open" (and first-attempt jobs then threw on
            // empty crfValues). The handle is meant to live for the node's lifetime.
        } catch (_kfE) {
            args.jobLog('Same-file history lookup failed (non-fatal): ' + _kfE.message);
        }

        // If we know a lower bound CQ failed, cap the retry bracket so every candidate is BELOW it
        if (lowestFailedCQ !== null && isRetry && overrideCQMax >= lowestFailedCQ) {
            var newMax = lowestFailedCQ - 1;
            args.jobLog('Adjusting retry bracket: capping max CQ from ' + overrideCQMax + ' to ' + newMax + ' (below known-failed CQ=' + lowestFailedCQ + ')');
            overrideCQMax = newMax;
            if (overrideCQMin > overrideCQMax) {
                overrideCQMin = Math.max(16, overrideCQMax - 5);
                args.jobLog('  Also adjusted min CQ to ' + overrideCQMin);
            }
            candidateList = [];
            for (var cqAdj = overrideCQMin; cqAdj <= overrideCQMax; cqAdj += effectiveStep) {
                candidateList.push(cqAdj);
            }
            // Also exclude any remaining known-failed CQs from the shifted range
            candidateList = candidateList.filter(function(cqVal) { return cqVal >= overrideCQMin && cqVal <= overrideCQMax && knownFailedCQs.indexOf(cqVal) === -1; });
        }

        var seen = {};
        candidateList.forEach(function(cqVal) {
            if (testedCQs.indexOf(cqVal) === -1 && !seen[cqVal]) {
                crfValues.push(cqVal);
                seen[cqVal] = true;
            }
        });

        if (crfValues.length < 2 && isRetry) {
            var padLow = Math.max(16, overrideCQMin - effectiveStep);
            var padHigh = Math.min(51, overrideCQMax + effectiveStep);
            // Skip pad values that are known to fail from previous same-file runs
            [padLow, padHigh].forEach(function(pad) {
                if (testedCQs.indexOf(pad) === -1 && !seen[pad] && knownFailedCQs.indexOf(pad) === -1) {
                    crfValues.push(pad);
                    seen[pad] = true;
                }
            });
        }

        if (crfValues.length === 0 && isRetry) {
            for (var cq4 = overrideCQMin; cq4 <= overrideCQMax; cq4 += effectiveStep) {
                if (!seen[cq4]) {
                    crfValues.push(cq4);
                }
            }
        }

        args.jobLog('CQ values to test (ordered): ' + crfValues.join(', '));
        args.jobLog('');

        delete args.variables.vmafOverrideCQMin;
        delete args.variables.vmafOverrideCQMax;
        delete args.variables.vmafNextCQ;
        delete args.variables.vmafNextCQs;

        args.variables.vmafDynamicCQ = true;
        if (isRetry) {
            args.variables.vmafCQRange = { min: overrideCQMin, max: overrideCQMax, width: overrideCQMax - overrideCQMin };
        }
    }

    // ── Source metadata extraction (for predictor) ──
        var sourceBitrateMbps = 0;
        var sourceWidth = 1920;
        var sourceHeight = 1080;
        var sourceCodec = 'unknown';
        var sourceDuration = 0;
        var sourceFileSizeMB = args.inputFileObj.file_size || 0;

        if (args.inputFileObj.ffProbeData) {
            var format = args.inputFileObj.ffProbeData.format || {};
            var streams = args.inputFileObj.ffProbeData.streams || [];

            sourceDuration = parseFloat(format.duration) || 0;
            var sourceBitrate = parseFloat(format.bit_rate) || 0;
            sourceBitrateMbps = sourceBitrate / 1000000;

            for (var i = 0; i < streams.length; i++) {
                if (streams[i].codec_type === 'video') {
                    sourceWidth = streams[i].width || 1920;
                    sourceHeight = streams[i].height || 1080;
                    sourceCodec = streams[i].codec_name || 'unknown';
                    if (streams[i].bit_rate) {
                        sourceBitrateMbps = parseFloat(streams[i].bit_rate) / 1000000;
                    }
                    break;
                }
            }
        }

        if (sourceBitrateMbps <= 0 && sourceDuration > 0 && sourceFileSizeMB > 0) {
            sourceBitrateMbps = (sourceFileSizeMB * 8) / sourceDuration;
        }

        var pixelCount = sourceWidth * sourceHeight;
        var fps = 24;
        var bitsPerPixel = (sourceBitrateMbps * 1000000) / (pixelCount * fps);
        var isHDR = args.variables.isHDR === true || args.variables.vmafIsHDR === true;

        args.jobLog('Source: ' + sourceWidth + 'x' + sourceHeight + ' | ' + sourceCodec + ' | ' + sourceBitrateMbps.toFixed(1) + ' Mbps | bpp=' + bitsPerPixel.toFixed(4) + ' | HDR=' + isHDR + ' | dur=' + sourceDuration.toFixed(0) + 's | tgt=' + targetMinVMAF);

        // ── CQ selection: predictor or manual ──
        if (!dynamicCQ) {
            // Use manual CQ values
            crfValues = crfValuesStr.split(',').map(function(v) { return parseInt(v.trim(), 10); }).filter(function(v) { return !isNaN(v); });
            args.jobLog('Using manual CQ values: ' + crfValues.join(', '));
            args.variables.vmafDynamicCQ = false;
        }

        // Track tested CQ values to avoid retesting in retry loops
    if (!args.variables.vmafTestedCQs) {
        args.variables.vmafTestedCQs = [];
    }
    // Add current CQ values to tested list (avoid duplicates)
    for (var ti = 0; ti < crfValues.length; ti++) {
        if (args.variables.vmafTestedCQs.indexOf(crfValues[ti]) === -1) {
            args.variables.vmafTestedCQs.push(crfValues[ti]);
        }
    }
    args.variables.vmafTestedCQs.sort(function(a, b) { return a - b; });
    args.jobLog('Tracked tested CQ values: ' + args.variables.vmafTestedCQs.join(', '));
    args.jobLog('');
    
    var presets = presetsStr.split(',').map(function(p) { return p.trim(); }).filter(function(p) { return p.length > 0; });
    var testResults = [];
    var parameterSets = [];
    var encodeFailures = []; // CRITICAL FIX #2: Track encoding failures

    // ── Predictor: compute CQ centre from historical sweep curves ──
    // Uses learned metadata weights (eta²) and per-CQ VMAF-vs-CQ regression
    // to predict the CQ that achieves targetVmaf, then seeds the initial sweep.
    // Falls back gracefully on new/unusual content (< 30 neighbours support).
    try {
        var _vdb = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
        var _vp = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafpredict.js');
        var _db = _vdb.openDb();
        var _streams = (args.inputFileObj && args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.streams) || [];
        var _vs = null; for (var _si = 0; _si < _streams.length; _si++) { if (_streams[_si].codec_type === 'video') { _vs = _streams[_si]; break; } }
        var _w = (_vs && _vs.width) || (typeof sourceWidth !== 'undefined' ? sourceWidth : 0);
        var _h = (_vs && _vs.height) || (typeof sourceHeight !== 'undefined' ? sourceHeight : 0);
        var _tgt = (typeof targetMinVMAF !== 'undefined' && targetMinVMAF) || Number(args.inputs.targetMinVMAF) || Number(args.variables.vmafMinVMAF) || 95;
        var _src = {
            tier: _vdb.tierFor(_w, _h),
            source_codec: (_vs && _vs.codec_name) || '',
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
            file_path: (args.inputFileObj && args.inputFileObj.file) || (args.inputFileObj && args.inputFileObj._id) || null
        };
        var _curves = _vdb.getSimilarSweepCurves(_db, _src, { limit: 20000 });
        var _ctr = _vp.predictCQCenter(_curves, _src, { targetVmaf: _tgt }, { recencyHalfLifeDays: 0 });
        var _sc = _vp.selectSampleCount(_curves, { slope: (_ctr && _ctr.priorSlope != null) ? _ctr.priorSlope : -0.4, cqPrecision: 0.75, distMinSamples: 4 });
        args.jobLog('[PREDICT] predictCQCenter=' + (_ctr.centerCq != null ? _ctr.centerCq : 'n/a')
            + (_ctr.sigmaCq != null ? ' +-' + _ctr.sigmaCq : '')
            + ' (range ' + _ctr.rangeMin + '-' + _ctr.rangeMax + ', support ' + _ctr.support + ' jobs, tier ' + _src.tier + ')'
            + ' | priorSlope=' + (_ctr.priorSlope != null ? _ctr.priorSlope : 'n/a') + ' dVMAF/dCQ (from ' + (_ctr.slopeSupport || 0) + ' curves)'
            + ' | live initial crfValues=[' + crfValues.join(',') + ']'
            + ' | sampleCount suggest=' + _sc.sampleCount + ' (sdEst=' + (_sc.sdEstimate != null ? _sc.sdEstimate.toFixed(2) : 'n/a') + ', ' + _sc.reason + ')');
        if (_ctr.featureEta) {
            var _et = _ctr.featureEta, _ek = Object.keys(_et).filter(function (k) { return _et[k] != null; })
                .sort(function (a, b) { return _et[b] - _et[a]; });
            args.jobLog('[PREDICT] learned metadata importance (eta^2, higher=more weight): '
                + _ek.map(function (k) { return k + '=' + _et[k].toFixed(3); }).join(', '));
        }

        // ── ACTING: seed crfValues from the predicted range so the sweep starts
        // centred on the likely optimum. Retries set vmafPredictorSeeded and keep
        // refining via the existing checkCQRangeRetry loop. Gated on adequate
        // neighbour support (>= 30 similar jobs).
        if (!args.variables.vmafPredictorSeeded && _ctr && _ctr.centerCq != null && _ctr.support >= 30
            && _ctr.rangeMin != null && _ctr.rangeMax != null) {
            var _cC = Math.round(_ctr.centerCq);
            var _rlo = Math.max(16, Math.min(_cC, Math.round(_ctr.rangeMin)));
            var _rhi = Math.min(51, Math.max(_cC, Math.round(_ctr.rangeMax)));
            if (_rhi - _rlo > 10) { _rlo = Math.max(16, _cC - 5); _rhi = Math.min(51, _cC + 5); } // cap span
            var _seed = [];
            [_rlo, _cC, _rhi].forEach(function (v) { if (_seed.indexOf(v) === -1) _seed.push(v); });
            _seed.sort(function (a, b) { return a - b; });
            if (_seed.length >= 2) {
                crfValues = _seed;
                args.variables.vmafTestedCQs = crfValues.slice();
                args.variables.vmafPredictorSeeded = true;
                args.jobLog('[ACTING] Predictor-seeded initial sweep: crfValues=[' + crfValues.join(',')
                    + '] (center ' + _ctr.centerCq + ', range ' + _ctr.rangeMin + '-' + _ctr.rangeMax
                    + ', priorSlope ' + _ctr.priorSlope + ', support ' + _ctr.support + ' jobs)');
            }
        }
    } catch (_shErr) {
        args.jobLog('[PREDICT] predictor calc failed (non-fatal): ' + (_shErr && _shErr.message ? _shErr.message : String(_shErr)));
    }

    // Fallback: a first-attempt dynamicCQ job has no base CQ list unless the predictor seeded one
    // (gated on DB availability AND support>=30). If the predictor was unavailable (e.g. the shared
    // SQLite handle was closed by an earlier job -> "database is not open") or support was thin, fall
    // back to the configured crfValues so the sweep still runs (pre-predictor behaviour) instead of
    // failing the whole job. The predictor is an optimisation, never a hard dependency.
    if (crfValues.length === 0) {
        crfValues = crfValuesStr.split(',').map(function(v) { return parseInt(v.trim(), 10); })
            .filter(function(v) { return !isNaN(v); });
        if (crfValues.length > 0) {
            args.jobLog('Predictor seeded no CQ values (unavailable or low support); falling back to configured crfValues: ' + crfValues.join(', '));
            if (!args.variables.vmafTestedCQs) args.variables.vmafTestedCQs = [];
            for (var _fbi = 0; _fbi < crfValues.length; _fbi++) {
                if (args.variables.vmafTestedCQs.indexOf(crfValues[_fbi]) === -1) args.variables.vmafTestedCQs.push(crfValues[_fbi]);
            }
            args.variables.vmafTestedCQs.sort(function(a, b) { return a - b; });
        }
    }

    // Generate parameter sets - all use 10-bit (p010le) format
    if (crfValues.length === 0) {
        var errorMsg = 'No CQ values to test. This may indicate all CQ values were filtered out as already tested, or dynamic CQ calculation failed.';
        args.jobLog('ERROR: ' + errorMsg);
        throw new Error(errorMsg);
    }
    
    for (var pi = 0; pi < presets.length; pi++) {
        for (var ci = 0; ci < crfValues.length; ci++) {
            var preset = presets[pi];
            var cq = crfValues[ci];
            if (useGPU && gpuEncoder) {
                parameterSets.push({
                    id: 'gpu_' + preset + '_cq' + cq,
                    encoder: gpuEncoder,
                    preset: preset,
                    quality: cq,
                    isGPU: true,
                    pixFmt: 'p010le',
                    colorPrimaries: colorPrimaries,
                    colorTrc: colorTrc,
                    colorspace: colorspace,
                    hdrMasterDisplay: hdrMasterDisplay,
                    hdrMaxCll: hdrMaxCll,
                    is10Bit: true,
                });
            }
        }
    }
    if (parameterSets.length === 0) {
        var noParamMsg = 'No encoding parameter sets generated. useGPU=' + useGPU +
            ', gpuEncoder=' + (gpuEncoder || 'none') +
            ', targetCodec=' + targetCodec +
            ', cqValues=' + crfValues.join(',') +
            ', presets=' + presets.join(',') +
            '. This usually means GPU encoder detection failed upstream; route to retry/detectGPUEncoder instead of reporting All 0 tests failed.';
        args.jobLog('ERROR: ' + noParamMsg);
        throw new Error(noParamMsg);
    }

    // Resolve the av1_nvenc quality flag set once per job and share it via flow variables so
    // the final transcode uses EXACTLY the same settings the VMAF sweep was measured with.
    // Enhanced set targets Ada/Blackwell NVENC (tune uhq, temporal filtering, deep lookahead);
    // a tiny capability encode decides, falling back to the proven hq set.
    var NVENC_FLAGS_ENHANCED = '-tune uhq -multipass fullres -spatial-aq 1 -temporal-aq 1 -aq-strength 10 -rc-lookahead 48 -lookahead_level auto -tf_level 4 -b_ref_mode middle';
    var NVENC_FLAGS_LEGACY = '-tune hq -multipass fullres -spatial-aq 1 -temporal-aq 1 -aq-strength 10 -rc-lookahead 32';
    if (!args.variables.vmafNvencFlagArgs) {
        try {
            execSync('"' + args.ffmpegPath + '" -hide_banner -y -f lavfi -i testsrc2=s=256x256:d=0.5:r=24'
                + ' -c:v av1_nvenc -pix_fmt p010le -rc vbr -cq 30 -b:v 0 -preset p7 '
                + NVENC_FLAGS_ENHANCED + ' -g 96 -forced-idr 1 -f null -', { stdio: 'pipe', timeout: 60000 });
            args.variables.vmafNvencFlagArgs = NVENC_FLAGS_ENHANCED;
            args.jobLog('NVENC enhanced quality flags enabled (tune uhq, tf_level 4, lookahead_level auto, rc-lookahead 48, b_ref_mode middle)');
        } catch (capErr) {
            args.variables.vmafNvencFlagArgs = NVENC_FLAGS_LEGACY;
            args.jobLog('NVENC enhanced flags unsupported on this encoder/driver - using legacy hq flag set');
        }
    }
    var nvencFlagArgs = args.variables.vmafNvencFlagArgs;

    var totalTests = parameterSets.length * samples.length;
    var completedTests = 0;
    args.jobLog('Testing ' + parameterSets.length + ' parameter sets on ' + samples.length + ' samples (' + totalTests + ' total encodes)...');
    
    // Report initial progress to Tdarr
    if (args.updateWorker) {
        args.updateWorker({ percentage: 0 });
    }
    
    for (var psi = 0; psi < parameterSets.length; psi++) {
        var paramSet = parameterSets[psi];
        for (var si = 0; si < samples.length; si++) {
            var sample = samples[si];
            var container = path.extname(sample).slice(1);
            var outputPath = cacheDir + '/test_' + paramSet.id + '_s' + (si + 1) + '.' + container;
            
            // Update progress at start of each encode
            var currentProgress = Math.round((completedTests / totalTests) * 100);
            if (args.updateWorker) {
                args.updateWorker({ 
                    percentage: currentProgress,
                    ETA: Math.round((totalTests - completedTests) * 15) // Estimate ~15 seconds per encode
                });
            }
            
            var cmd = '"' + args.ffmpegPath + '"';
            if (paramSet.isGPU && paramSet.encoder.indexOf('av1_nvenc') !== -1) {
                cmd += ' -hwaccel cuda';
            }
            cmd += ' -i "' + sample + '" -c:v ' + paramSet.encoder;
            if (paramSet.isGPU && paramSet.encoder.indexOf('av1_nvenc') !== -1) {
                cmd += ' -pix_fmt ' + paramSet.pixFmt;
                cmd += ' -rc vbr -cq ' + paramSet.quality + ' -b:v 0';
                cmd += ' -preset ' + paramSet.preset + ' ' + nvencFlagArgs;
                cmd += ' -g 96 -forced-idr 1';
                cmd += ' -color_primaries ' + paramSet.colorPrimaries;
                cmd += ' -color_trc ' + paramSet.colorTrc;
                cmd += ' -colorspace ' + paramSet.colorspace;
                var av1Meta = av1ColorMetadataArgs(paramSet.colorPrimaries, paramSet.colorTrc, paramSet.colorspace);
                cmd += ' -bsf:v ' + av1Meta.bsf + (av1Meta.tags || '');
                // av1_nvenc in this FFmpeg build does not expose -master_display/-max_cll encoder options.
                // Static HDR metadata is logged/exported by the flow, while the encoded AV1 stream carries
                // color primaries/TRC/matrix signalling via the supported color options above.
                cmd += ' -max_muxing_queue_size 4096';
            }
            cmd += ' -an -y "' + outputPath + '"';
            args.jobLog('Testing: ' + paramSet.id + ' on sample ' + (si + 1));
            var startTime = Date.now();
            try {
                execSync(cmd, { stdio: 'pipe' });
                var endTime = Date.now();
                var encodingTime = (endTime - startTime) / 1000;
                var fileSize = 0;
                try {
                    var stats = fs.statSync(outputPath);
                    fileSize = stats.size / (1024 * 1024);
                } catch (e) {
                    args.jobLog('Could not get file size for ' + outputPath);
                }
                // A near-empty output means the encode produced no frames (e.g. the
                // input sample had no video packets) even though ffmpeg exited 0.
                // Treat it as a failure so it cannot poison the VMAF stage.
                if (fileSize * 1024 * 1024 < 20000) {
                    encodeFailures.push({
                        parameterSetId: paramSet.id,
                        sampleIndex: si,
                        error: 'Output file is empty/near-empty (' + (fileSize * 1024).toFixed(1) + ' KB) - no video frames encoded',
                        outputPath: outputPath
                    });
                    args.jobLog('  Failed: output is empty/near-empty (' + (fileSize * 1024).toFixed(1) + ' KB) - input sample likely has no video');
                    completedTests++;
                    continue;
                }
                testResults.push({
                    parameterSetId: paramSet.id,
                    sampleIndex: si,
                    outputPath: outputPath,
                    fileSizeMB: fileSize,
                    encodingTimeSeconds: encodingTime,
                    parameterSet: paramSet,
                    originalSamplePath: sample,
                });
                args.jobLog('  Size: ' + fileSize.toFixed(2) + ' MB, Time: ' + encodingTime.toFixed(1) + 's');
                completedTests++;
                
                // Update progress after each completed encode
                var progressPercent = Math.round((completedTests / totalTests) * 100);
                args.jobLog('  Progress: ' + completedTests + '/' + totalTests + ' encodes [' + progressPercent + '%]');
                if (args.updateWorker) {
                    args.updateWorker({ 
                        percentage: progressPercent,
                        ETA: Math.round((totalTests - completedTests) * encodingTime) // Use actual encode time for better ETA
                    });
                }
            } catch (err) {
                // CRITICAL FIX #2: Track encoding failures
                var stdoutTail = err.stdout ? err.stdout.toString().slice(-1200) : '';
                var stderrTail = err.stderr ? err.stderr.toString().slice(-1200) : '';
                var detailedError = (stderrTail || stdoutTail || err.message).trim();
                encodeFailures.push({
                    parameterSetId: paramSet.id,
                    sampleIndex: si,
                    error: err.message,
                    stderrTail: stderrTail,
                    stdoutTail: stdoutTail,
                    outputPath: outputPath
                });
                args.jobLog('  Failed: ' + err.message);
                if (detailedError) {
                    args.jobLog('  FFmpeg error tail: ' + detailedError.replace(/\s+/g, ' ').substring(0, 500));
                }
                completedTests++;
            }
        }
    }
    
    // Report 100% completion
    if (args.updateWorker) {
        args.updateWorker({ percentage: 100 });
    }
    
    // CRITICAL FIX #2: Analyze failures and warn/fail if too many
    var totalExpectedTests = parameterSets.length * samples.length;
    var failureRate = encodeFailures.length / totalExpectedTests;
    
    if (encodeFailures.length > 0) {
        args.jobLog('');
        args.jobLog('=== Encoding Failure Analysis ===');
        args.jobLog('Total failures: ' + encodeFailures.length + ' / ' + totalExpectedTests + ' (' + (failureRate * 100).toFixed(1) + '%)');
        
        // Group failures by parameter set
        var failuresByParamSet = {};
        for (var f = 0; f < encodeFailures.length; f++) {
            var fail = encodeFailures[f];
            if (!failuresByParamSet[fail.parameterSetId]) {
                failuresByParamSet[fail.parameterSetId] = 0;
            }
            failuresByParamSet[fail.parameterSetId]++;
        }
        
        // Check if any parameter set had 100% failure
        var completelyFailedSets = [];
        for (var paramId in failuresByParamSet) {
            var failCount = failuresByParamSet[paramId];
            if (failCount === samples.length) {
                completelyFailedSets.push(paramId);
            }
        }
        
        if (completelyFailedSets.length > 0) {
            args.jobLog('WARNING: ' + completelyFailedSets.length + ' parameter set(s) had 100% failure: ' + completelyFailedSets.join(', '));
        }
        
        // Fail if >50% of tests failed
        if (failureRate > 0.5) {
            var errorMsg = 'Too many encoding failures (' + encodeFailures.length + ' / ' + totalExpectedTests + '). ';
            errorMsg += 'This may indicate GPU issues, codec problems, or insufficient resources. ';
            errorMsg += 'Check logs for specific error messages.';
            throw new Error(errorMsg);
        }
        
        // Warn if >20% failed
        if (failureRate > 0.2) {
            args.jobLog('WARNING: High failure rate (' + (failureRate * 100).toFixed(1) + '%). Results may be incomplete.');
        }
    }
    
    if (testResults.length === 0) {
        var errorMsg = 'No successful encoding tests. All ' + totalExpectedTests + ' tests failed. ';
        errorMsg += 'Check GPU availability, codec support, and FFmpeg configuration.';
        throw new Error(errorMsg);
    }
    
    args.variables.vmafTestResults = testResults;
    args.variables.vmafParameterSets = parameterSets;
    args.variables.vmafEncodeFailures = encodeFailures; // Store for analysis
    args.jobLog('Completed ' + testResults.length + ' encoding tests (' + encodeFailures.length + ' failed).');
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
