"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var nvencTemporalFilter = require('../../_lib/nvencTemporalFilter.js');
var canonicalDenoise = require('../../_lib/canonicalDenoise.js');
var grainVmafContract = require('../../_lib/grainVmafContract.js');
var referenceContractBridge = require('../../_lib/referenceContractBridge.js');
var vmafMetricContract = require('../../_lib/vmafMetricContract.js');
var deliveryPolicy = require('../../_lib/deliveryPolicy.js');
var fs = require('fs');
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
            tooltip: 'Fixed current search target: 30% size reduction. Values other than 30 fail closed so search, delivery validation, and final replacement use one policy.',
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
        {
            label: 'Sample Encode Timeout Seconds',
            name: 'sampleEncodeTimeoutSeconds',
            type: 'number',
            defaultValue: '600',
            inputUI: { type: 'text' },
            tooltip: 'Hard deadline for each sample encode. Timed-out FFmpeg children are killed and recorded as failures.',
        },
        {
            label: 'Minimum Parameter Coverage',
            name: 'minParameterCoverage',
            type: 'number',
            defaultValue: '0.8',
            inputUI: { type: 'text' },
            tooltip: 'Minimum successful sample fraction required for each parameter set before it can enter VMAF aggregation.',
        },
        {
            label: 'Research Exploration Rate',
            name: 'explorationRate',
            type: 'number',
            defaultValue: '0.02',
            inputUI: { type: 'text' },
            tooltip: 'Fraction of first-attempt jobs that add one out-of-bracket CQ solely to improve research coverage. Clamp: 0-0.25. Set 0 to disable.',
        },
        {
            label: 'Same-Title Empty-Band Shadow',
            name: 'sameTitleEmptyBandShadow',
            type: 'boolean',
            defaultValue: 'true',
            inputUI: { type: 'switch' },
            tooltip: 'Observational only: record whether repeated same-title no-feasible outcomes would justify boundary-first measurement. Never skips a current file.',
        },
        {
            label: 'Enable Encode Hard-Abort',
            name: 'encodeHardAbort',
            type: 'boolean',
            defaultValue: 'false',
            inputUI: { type: 'switch' },
            tooltip: 'Experimental: on guided rounds, encode and score the previously hardest clips first, then skip the remaining encodes for a CQ that is already a confident failure.',
        },
        {
            label: 'Encode Hard-Abort Sentinel Clips',
            name: 'encodeHardAbortK',
            type: 'number',
            defaultValue: '4',
            inputUI: { type: 'text' },
            tooltip: 'Number of previously hardest clips to encode before deciding whether a CQ is already a confident failure. Range: 2-6.',
        },
        {
            label: 'Encode Hard-Abort Margin',
            name: 'encodeHardAbortMargin',
            type: 'number',
            defaultValue: '1.5',
            inputUI: { type: 'text' },
            tooltip: 'Required VMAF margin below the target for the sentinel CI upper bound. Larger values are more conservative.',
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

function getHardestSampleIndices(hardness, sampleCount, count) {
    if (!hardness || typeof hardness !== 'object') return [];
    var known = [];
    for (var i = 0; i < sampleCount; i++) {
        var score = Number(hardness[i]);
        if (isFinite(score)) known.push({ index: i, score: score });
    }
    known.sort(function (a, b) {
        if (a.score !== b.score) return a.score - b.score;
        return a.index - b.index;
    });
    return known.slice(0, Math.max(0, count)).map(function (item) { return item.index; });
}

function shouldEncodeHardAbort(scores, target, margin) {
    var values = (Array.isArray(scores) ? scores : []).map(Number).filter(isFinite);
    var threshold = Number(target) - Number(margin);
    if (values.length < 2 || !isFinite(threshold)) {
        return { abort: false, count: values.length, mean: null, ciUpper: null, threshold: threshold };
    }
    var mean = values.reduce(function (sum, value) { return sum + value; }, 0) / values.length;
    var variance = values.reduce(function (sum, value) {
        var delta = value - mean;
        return sum + delta * delta;
    }, 0) / (values.length - 1);
    var ciUpper = mean + 1.64 * Math.sqrt(variance) / Math.sqrt(values.length);
    return {
        abort: ciUpper <= threshold,
        count: values.length,
        mean: mean,
        ciUpper: ciUpper,
        threshold: threshold,
    };
}

// Pure decision for the boundary-first CQ16 round-1 seed (2026-07-20). True only on a
// first-attempt, unguided sweep whose same-title history hint recommends boundary-first,
// when CQ16 is not already scheduled/tested and the kill switch is not engaged.
function shouldSeedBoundaryCq16(state) {
    state = state || {};
    if (state.killSwitch === false) return false;
    if (state.isRetry === true || Number(state.guidedCount) > 0) return false;
    var crfValues = Array.isArray(state.crfValues) ? state.crfValues : [];
    var testedCQs = Array.isArray(state.testedCQs) ? state.testedCQs : [];
    if (crfValues.length === 0) return false;
    if (crfValues.indexOf(16) !== -1 || testedCQs.indexOf(16) !== -1) return false;
    var hint = state.hint;
    return !!(hint && hint.recommendBoundaryFirst === true);
}

// Historical data is allowed to choose measurement order only once. A guided
// round or retry is already based on fresh measurements from this file, so
// consulting history again could override the current-contract curve.
function shouldApplyHistoricalProbeSeed(state) {
    state = state || {};
    return state.dynamicCQ === true
        && state.isRetry !== true
        && Number(state.guidedCount || 0) === 0
        && state.alreadySeeded !== true;
}

// Turn a historical centre/range into three distinct CQs that will all be
// measured under the current reference contract. Fill inward at encoder bounds
// so a collapsed range never degenerates into a one-point pseudo-curve.
function buildFreshProbeSeed(centerCq, rangeMin, rangeMax) {
    function legal(value) {
        var n = Math.round(Number(value));
        return isFinite(n) ? Math.max(16, Math.min(51, n)) : null;
    }
    var center = legal(centerCq);
    if (center === null) return [];
    var values = [];
    function add(value) {
        value = legal(value);
        if (value !== null && values.indexOf(value) === -1) values.push(value);
    }
    add(rangeMin);
    add(center);
    add(rangeMax);
    for (var distance = 2; values.length < 3 && distance <= 35; distance += 2) {
        add(center - distance);
        if (values.length < 3) add(center + distance);
    }
    return values.sort(function (a, b) { return a - b; }).slice(0, 3);
}

function loadReferenceContractCalibration(fsModule, paths, onError) {
    fsModule = fsModule || fs;
    paths = Array.isArray(paths) ? paths : [];
    for (var index = 0; index < paths.length; index++) {
        try {
            if (!paths[index] || !fsModule.existsSync(paths[index])) continue;
            return {
                artifact: JSON.parse(fsModule.readFileSync(paths[index], 'utf8')),
                path: paths[index],
            };
        } catch (error) {
            if (typeof onError === 'function') onError(paths[index], error);
        }
    }
    return { artifact: null, path: null };
}

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
        if (v.indexOf('bt2020-10') !== -1) return 14;
        if (v.indexOf('bt2020-12') !== -1) return 15;
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

function buildNvencCapabilityProbeArgs(nvencFlagArgs, temporalPolicy) {
    temporalPolicy = temporalPolicy || nvencTemporalFilter.LEGACY_POLICY;
    var argv = ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=256x256:d=0.5:r=24',
        '-c:v', 'av1_nvenc', '-pix_fmt', 'p010le', '-rc', 'vbr', '-cq', '30', '-b:v', '0',
        '-preset', 'p7'];
    nvencTemporalFilter.appendValidatedQualityFlags(argv, nvencFlagArgs, temporalPolicy, 'NVENC capability probe');
    argv.push('-g', '96', '-forced-idr', '1', '-f', 'null', '-');
    nvencTemporalFilter.assertAv1NvencCommand(argv, temporalPolicy, 'NVENC capability probe');
    return argv;
}

function resolveNvencFlagContract(args, temporalPolicy, execFileSync) {
    // Preserve the test/helper's old boolean API while production callers pass
    // the explicit three-way policy.
    if (temporalPolicy === true) temporalPolicy = nvencTemporalFilter.CANONICAL_POLICY;
    if (temporalPolicy === false || !temporalPolicy) temporalPolicy = nvencTemporalFilter.LEGACY_POLICY;
    var enhanced = nvencTemporalFilter.qualityFlags(temporalPolicy, true);
    var baseline = nvencTemporalFilter.qualityFlags(temporalPolicy, false);
    if (args.variables.vmafNvencTemporalPolicy &&
        args.variables.vmafNvencTemporalPolicy !== temporalPolicy) {
        delete args.variables.vmafNvencFlagArgs;
    }
    args.variables.vmafNvencTemporalPolicy = temporalPolicy;
    if (!args.variables.vmafNvencFlagArgs) {
        try {
            execFileSync(args.ffmpegPath, buildNvencCapabilityProbeArgs(enhanced, temporalPolicy),
                { stdio: 'pipe', timeout: 60000, windowsHide: true });
            args.variables.vmafNvencFlagArgs = enhanced;
            args.jobLog('NVENC enhanced quality flags enabled for ' + temporalPolicy + ' temporal policy.');
        } catch (_enhancedError) {
            args.jobLog('NVENC enhanced flags unsupported on this encoder/driver; probing baseline flags for ' + temporalPolicy);
            try {
                execFileSync(args.ffmpegPath, buildNvencCapabilityProbeArgs(baseline, temporalPolicy),
                    { stdio: 'pipe', timeout: 60000, windowsHide: true });
                args.variables.vmafNvencFlagArgs = baseline;
                args.jobLog('NVENC baseline quality flags enabled for ' + temporalPolicy + ' temporal policy.');
            } catch (baselineError) {
                throw new Error('Neither enhanced nor baseline NVENC quality flags passed the ' + temporalPolicy +
                    ' temporal-filter contract: ' + baselineError.message);
            }
        }
    }
    return {
        temporalPolicy: temporalPolicy,
        nvencFlagArgs: nvencTemporalFilter.assertTemporalFilterPolicy(
            args.variables.vmafNvencFlagArgs, temporalPolicy,
            'VMAF sample flag contract').join(' '),
    };
}

function buildSampleEncodeArgs(paramSet, sample, outputPath, nvencFlagArgs, options) {
    options = options || {};
    var canonicalInput = options.canonicalInput === true;
    var temporalPolicy = options.temporalPolicy || (canonicalInput
        ? nvencTemporalFilter.CANONICAL_POLICY : nvencTemporalFilter.LEGACY_POLICY);
    if (canonicalInput && temporalPolicy !== nvencTemporalFilter.CANONICAL_POLICY) {
        throw new Error('canonical VMAF sample requires the canonical tf0 policy');
    }
    var argv = [];
    if (!canonicalInput && paramSet.isGPU && paramSet.encoder.indexOf('av1_nvenc') !== -1) {
        argv.push('-hwaccel', 'cuda');
    }
    argv.push('-i', sample, '-c:v', paramSet.encoder);
    if (paramSet.isGPU && paramSet.encoder.indexOf('av1_nvenc') !== -1) {
        argv.push('-pix_fmt', paramSet.pixFmt, '-rc', 'vbr', '-cq', String(paramSet.quality), '-b:v', '0');
        argv.push('-preset', paramSet.preset);
        nvencTemporalFilter.appendValidatedQualityFlags(argv, nvencFlagArgs, temporalPolicy, 'VMAF sample encode');
        argv.push('-g', '96', '-forced-idr', '1');
        argv.push('-color_primaries', paramSet.colorPrimaries, '-color_trc', paramSet.colorTrc, '-colorspace', paramSet.colorspace);
        var av1Meta = av1ColorMetadataArgs(paramSet.colorPrimaries, paramSet.colorTrc, paramSet.colorspace);
        argv.push('-bsf:v', av1Meta.bsf);
        // av1_nvenc in this FFmpeg build does not expose -master_display/-max_cll encoder options.
        // Static HDR metadata is logged/exported by the flow, while the encoded AV1 stream carries
        // color primaries/TRC/matrix signalling via the supported color options above.
        argv.push('-max_muxing_queue_size', '4096');
    }
    argv.push('-an', '-y', outputPath);
    nvencTemporalFilter.assertAv1NvencCommand(argv, temporalPolicy, 'VMAF sample encode');
    canonicalDenoise.assertAbsent(argv, canonicalInput
        ? 'VMAF encode from canonical denoised FFV1 sample'
        : 'legacy VMAF sample encode');
    return argv;
}

var plugin = async function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    var path = require('path');
    var execFileSync = require('child_process').execFileSync;
    var spawn = require('child_process').spawn;
    var referenceContract = grainVmafContract.assertVariables(args.variables, {
        context: 'VMAF sample',
        requireTemporalPolicy: true,
    });
    var canonicalInput = referenceContract.canonical;
    var allowHistoricalGuidance = referenceContract.legacyHistory;
    args.variables.vmafSelectorSignalDomain = referenceContract.selectorMode;
    args.variables.vmafSelectorLegacyBridgePlanningOnly =
        referenceContract.selectorMode === grainVmafContract.SELECTOR_MODE_PREPARED;
    args.jobLog('[SELECTOR CONTRACT] mode=' + referenceContract.selectorMode +
        ' reference=' + referenceContract.id +
        ' canonicalDenoise=' + (referenceContract.canonical ? 'yes' : 'no') +
        ' fgs=' + (referenceContract.disposition === 'prepared' ? 'prepared' : 'bypass') +
        ' historicalAcceptance=' + (referenceContract.legacyHistory ? 'allowed' : 'fresh-only'));
    args.variables.vmafHistoricalGuidanceAllowed = allowHistoricalGuidance;
    args.variables.vmafHistoricalProbePlanningAllowed = true;
    if (!allowHistoricalGuidance) {
        args.variables.vmafCrossJobReuse = false;
        args.variables.vmafInfeasibleCooldown = false;
        args.variables.vmafSameTitleShadowInitialized = true;
        args.variables.vmafSameTitleEmptyBandShadow = null;
        args.variables.vmafReusedSweepRows = [];
        args.jobLog('[CONTRACT] ' + referenceContract.id +
            ': legacy exact reuse, cooldown, acceptance, and size/CAMBI/frame-floor authority are disabled.');
    }

    // Same-title history is a routing hint only. It cannot reject the current file and is carried
    // to the terminal monitor so the recommendation can be scored against the real outcome.
    if (args.inputs.sameTitleEmptyBandShadow !== false && args.inputs.sameTitleEmptyBandShadow !== 'false' &&
            args.variables.vmafSameTitleShadowInitialized !== true) {
        args.variables.vmafSameTitleShadowInitialized = true;
        try {
            var _stTitle = String(args.variables.vmafSeriesTitle || '').trim();
            if (_stTitle) {
                var _stDbModule = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
                var _stDb = _stDbModule.openDb();
                var _stStreams = args.inputFileObj && args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.streams;
                var _stVideo = Array.isArray(_stStreams) ? _stStreams.filter(function (stream) {
                    return stream && stream.codec_type === 'video' && !(stream.disposition && stream.disposition.attached_pic === 1);
                })[0] : null;
                var _stTier = _stDbModule.tierFor(_stVideo && _stVideo.width, _stVideo && _stVideo.height);
                var _stHdr = args.variables.isHDR === true || args.variables.vmafIsHDR === true;
                var _stRows = _stDbModule.getSameTitleOutcomes(_stDb, {
                    media_title: _stTitle,
                    tier: _stTier,
                    is_hdr: _stHdr,
                    job_id: args.variables.vmafCanonicalJobId || args.variables.vmafJobId || null,
                    reference_contract_id: args.variables.vmafReferenceContractId,
                }, { limit: 100 });
                // hintVersion 2 (2026-07-20): target_vmaf_unreachable priors count toward the
                // trigger too — those are exactly the class-A jobs where a round-1 CQ16 probe
                // proves give-up immediately. v1 rows counted no_feasible_parameters only.
                var _stFailures = _stRows.filter(function (row) {
                    return row.skip_reason === 'no_feasible_parameters'
                        || row.skip_reason === 'target_vmaf_unreachable';
                });
                args.variables.vmafSameTitleEmptyBandShadow = {
                    title: _stTitle,
                    tier: _stTier,
                    isHDR: _stHdr,
                    hintVersion: 2,
                    priorTerminalOutcomes: _stRows.length,
                    priorNoFeasible: _stFailures.length,
                    recommendBoundaryFirst: _stFailures.length >= 2,
                    action: 'measurement_order_hint_promoted_to_cq16_seed_v2',
                };
                args.jobLog('Same-title empty-band history: ' + _stFailures.length + '/' + _stRows.length +
                    ' prior matched terminal job(s) were no-feasible/unreachable; boundary-first CQ16 seed=' +
                    (_stFailures.length >= 2 ? 'yes' : 'no'));
            }
        } catch (_stError) {
            args.jobLog('Same-title empty-band shadow unavailable (non-fatal): ' + _stError.message);
        }
    }

    // Read inputs
    var dynamicCQ = args.inputs.dynamicCQ !== false && args.inputs.dynamicCQ !== 'false';
    var targetMinVMAF = Number(args.inputs.targetMinVMAF) || 90;
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
        if (allowHistoricalGuidance && args.variables.vmafLearnedModel && args.variables.vmafLearnedModel.slope) {
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
    if (!isFinite(targetSizeReduction) ||
            targetSizeReduction !== deliveryPolicy.DEFAULT_TARGET_REDUCTION_PCT) {
        throw new Error('targetSizeReduction must equal the current policy value ' +
            deliveryPolicy.DEFAULT_TARGET_REDUCTION_PCT);
    }
    args.variables.vmafTargetSizeReductionPct = targetSizeReduction;
    var initialDeliveryPolicy = deliveryPolicy.resolve(args.variables);
    args.jobLog('Delivery size policy: search target ' +
        initialDeliveryPolicy.targetReductionPct + '%, minimum delivered reduction ' +
        initialDeliveryPolicy.minimumReductionPct + '%, final byte cap ' +
        initialDeliveryPolicy.maxFinalOutputRatioPct + '% (' +
        initialDeliveryPolicy.version + ')');

    // ── Prior infeasible-result telemetry (cooldown retired 2026-07-23) ──
    // 24 files terminally failed, were requeued unchanged, and failed again (26 extra full
    // sweeps, ~17 GPU-h since 06-15). If THIS exact file already failed terminally under the
    // CURRENT feasibility-policy era with the same VMAF target — and that failure came from a
    // real sweep (has sweep_points; cooldown skips themselves never re-arm the cooldown) —
    // this used to skip the sweep and keep the original. Prescribed model/quality limits are now
    // advisory at terminal fallback, so a matching prior is logged but the sweep always runs and
    // selects the closest technically valid measured CQ. The query remains for migration telemetry.
    try {
        var _cdIsRetryPass = args.variables.vmafOverrideCQMin !== undefined
            || (Number(args.variables.vmafRetryCount) || 0) > 0;
        if (args.variables.vmafInfeasibleCooldown !== false && !_cdIsRetryPass
            && args.variables.vmafCooldownSkip === undefined) {
            var _cdEraFloor = '2026-07-20'; // feasibility-policy era: size-gate demotion
            var _cdDays = Number(args.variables.vmafInfeasibleCooldownDays);
            if (!isFinite(_cdDays) || _cdDays <= 0) _cdDays = 30;
            var _cdSince = new Date(Date.now() - _cdDays * 86400000).toISOString();
            if (_cdSince < _cdEraFloor) _cdSince = _cdEraFloor;
            var _cdPath = String((args.inputFileObj && (args.inputFileObj._id || args.inputFileObj.file)) || '');
            if (_cdPath) {
                var _cdDbm = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
                var _cdDb = _cdDbm.openDb();
                var _cdPrior = _cdDb.prepare(
                    'SELECT job_id, timestamp, skip_reason FROM jobs' +
                    ' WHERE file_path = ? AND timestamp >= ?' +
                     " AND skip_reason IN ('no_feasible_parameters','target_vmaf_unreachable')" +
                     ' AND target_min_vmaf = ?' +
                     " AND COALESCE(reference_contract_id, 'legacy-original-tf4-v1') = ?" +
                     ' AND metric_contract_id = ? AND encoder_profile_id = ?' +
                     " AND job_id IN (SELECT DISTINCT job_id FROM sweep_points WHERE COALESCE(reference_contract_id, 'legacy-original-tf4-v1') = ?" +
                     ' AND metric_contract_id = ? AND encoder_profile_id = ?)' +
                     ' ORDER BY timestamp DESC LIMIT 1').get(_cdPath, _cdSince, targetMinVMAF,
                         args.variables.vmafReferenceContractId,
                         _cdDbm.LEGACY_METRIC_CONTRACT_ID,
                         _cdDbm.LEGACY_ENCODER_PROFILE_ID,
                         args.variables.vmafReferenceContractId,
                         _cdDbm.LEGACY_METRIC_CONTRACT_ID,
                         _cdDbm.LEGACY_ENCODER_PROFILE_ID);
                if (_cdPrior) {
                    // Prescribed quality/size/model limits are advisory at terminal fallback.
                    // A prior no-feasible outcome therefore cannot authorize skipping a new
                    // sweep: the selector can now ship the closest technically valid measured
                    // CQ instead of retaining the source. Keep the prior only as telemetry.
                    args.variables.vmafPriorInfeasibleAdvisory = {
                        priorJobId: _cdPrior.job_id,
                        priorTimestamp: _cdPrior.timestamp,
                        priorSkipReason: _cdPrior.skip_reason,
                        eraFloor: _cdEraFloor,
                        cooldownDays: _cdDays,
                    };
                    args.jobLog('=== Prior Infeasible Result (Advisory Only) ===');
                    args.jobLog('RE-SWEEPING: this exact file previously missed prescribed limits ('
                        + _cdPrior.skip_reason + ') on ' + String(_cdPrior.timestamp).slice(0, 10)
                        + ' under the current feasibility policy era (>= ' + _cdSince.slice(0, 10)
                        + ') at the same VMAF target ' + targetMinVMAF + '.');
                    args.jobLog('Prior keep-original cooldown is retired: collecting measurements and selecting the closest technically valid CQ.');
                }
            }
        }
    } catch (_cdErr) {
        args.jobLog('Infeasible-file cooldown check failed (non-fatal, sweeping normally): '
            + (_cdErr && _cdErr.message ? _cdErr.message : String(_cdErr)));
    }

    var cqRangeWidth = Number(args.inputs.cqRangeWidth);
    if (isNaN(cqRangeWidth) || cqRangeWidth <= 0) {
        args.jobLog('WARNING: Invalid cqRangeWidth (' + args.inputs.cqRangeWidth + '), using default 8');
        cqRangeWidth = 8;
        effectiveRangeWidth = 8;
    }

    var samples = args.variables.vmafSamples || [];
    if (canonicalInput && (args.variables.vmafDenoiseId !== canonicalDenoise.DENOISE_ID ||
        args.variables.vmafDenoiseSettings !== canonicalDenoise.KNN_SETTINGS ||
        Number(args.variables.vmafDenoisePrerollSeconds) !== canonicalDenoise.PREROLL_SECONDS)) {
        throw new Error('authenticated canonical denoised VMAF samples are required before CQ encoding');
    }
    if (!canonicalInput && (args.variables.vmafDenoiseFilter !== undefined ||
        args.variables.vmafDenoiseId !== undefined ||
        args.variables.vmafDenoiseSettings !== undefined ||
        args.variables.vmafDenoisePrerollSeconds !== undefined)) {
        throw new Error('original-source VMAF samples must not claim the canonical denoise contract');
    }
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
    var isGuidedRound = isRetry || guidedNext.length > 0;

    if (isRetry || guidedNext.length > 0) {
        args.jobLog('=== Guided CQ Selection ===');
        if (isRetry) {
            args.jobLog('Override CQ range: ' + overrideCQMin + ' - ' + overrideCQMax);
        }

        var testedCQs = args.variables.vmafTestedCQs || [];
        var forceRetestCQs = Array.isArray(args.variables.vmafForceRetestCQs) ? args.variables.vmafForceRetestCQs : [];
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
        if (allowHistoricalGuidance) try {
            var _kfVdb = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
            var _kfDb = _kfVdb.openDb();
            var _kfFilePath = (args.inputFileObj && args.inputFileObj._id) || (args.inputFileObj && args.inputFileObj.file) || '';
            if (_kfFilePath) {
                 var _kfPrev = _kfVdb.getSameFileSweepCurves(_kfDb, _kfFilePath, {
                     limit: 200,
                     referenceContractId: args.variables.vmafReferenceContractId,
                     metricContractId: args.variables.vmafMetricContractId ||
                         _kfVdb.LEGACY_METRIC_CONTRACT_ID,
                     encoderProfileId: args.variables.vmafEncoderProfileId ||
                         _kfVdb.LEGACY_ENCODER_PROFILE_ID,
                 });
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
            if ((testedCQs.indexOf(cqVal) === -1 || forceRetestCQs.indexOf(cqVal) !== -1) && !seen[cqVal]) {
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
        delete args.variables.vmafForceRetestCQs;

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
    var resolvedNvencContract = null;
    if (useGPU && gpuEncoder && String(gpuEncoder).toLowerCase() === 'av1_nvenc') {
        resolvedNvencContract = resolveNvencFlagContract(
            args, referenceContract.temporalPolicy, execFileSync);
    }
    var referenceComparisonEncoderProfileId = resolvedNvencContract
        ? nvencTemporalFilter.referenceComparisonEncoderProfileId({
            codec: gpuEncoder,
            presets: presets,
            policy: resolvedNvencContract.temporalPolicy,
            qualityFlags: resolvedNvencContract.nvencFlagArgs,
        }) : null;
    args.variables.vmafReferenceComparisonEncoderProfileId =
        referenceComparisonEncoderProfileId;
    var measurementMetricContract = vmafMetricContract.resolveProductionForVideo(
        sourceWidth,
        sourceHeight,
        { attestedEncoderProfileId: referenceComparisonEncoderProfileId }
    );
    vmafMetricContract.assertModelFile(measurementMetricContract, { fs: fs });
    args.variables.vmafMetricContractFamilyId = measurementMetricContract.metricContractFamilyId;
    args.variables.vmafMetricContractId = measurementMetricContract.metricContractId;
    args.variables.vmafEncoderProfileId = measurementMetricContract.encoderProfileId;
    args.variables.vmafEncoderProfileAttested = measurementMetricContract.encoderProfileAttested;
    args.variables.vmafModelPath = measurementMetricContract.modelPath;
    args.variables.vmafModelName = measurementMetricContract.modelName;
    args.variables.vmafModelSha256 = measurementMetricContract.modelSha256;
    args.variables.vmafMetricBackend = measurementMetricContract.backend;
    args.variables.vmafMetricFilterName = measurementMetricContract.filterName;
    args.variables.vmafScoringBitDepth = measurementMetricContract.scoringBitDepth;
    args.variables.vmafScoringPixelFormat = measurementMetricContract.scoringPixelFormat;
    args.variables.vmafPoolingPrimary = measurementMetricContract.poolingPrimary;
    args.variables.vmafCambiPolicy = measurementMetricContract.cambiPolicy;
    args.variables.vmafCambiAvailable = measurementMetricContract.cambi.required === true;
    args.variables.vmafCambiUnavailableReason =
        measurementMetricContract.cambi.reasonCode || null;
    args.variables.vmafRequireGpuVmaf = true;
    var testResults = [];
    var parameterSets = [];
    var encodeFailures = []; // CRITICAL FIX #2: Track encoding failures

    // ── Predictor: compute a CQ centre used ONLY to schedule fresh probes ──
    // Same-reference-contract history is preferred. While canonical history is
    // sparse, legacy original/tf4 curves may seed the centre and prior slope via
    // referenceContractBridge. Legacy scores, p1/CAMBI/size values and outcomes
    // never enter acceptance, reuse, cooldown, or final CQ selection.
    // Never consult or act on history after fresh measurements have caused a
    // guided round/retry. selectBestParameters/checkCQRangeRetry retain the
    // current file's measured curve across attempts and own all later CQs.
    if (dynamicCQ && (allowHistoricalGuidance || canonicalInput) && !isGuidedRound) try {
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
            source_width: _w,
            source_height: _h,
            source_duration_sec: (typeof sourceDuration !== 'undefined' && isFinite(sourceDuration)) ? sourceDuration : null,
            source_file_size_mb: (typeof sourceFileSizeMB !== 'undefined' && isFinite(sourceFileSizeMB)) ? sourceFileSizeMB : null,
            pixel_format: (_vs && _vs.pix_fmt) || pixFmt || null,
            bit_depth: (_vs && _vs.bits_per_raw_sample) ? Number(_vs.bits_per_raw_sample) : null,
            color_primaries: (_vs && _vs.color_primaries) || colorPrimaries || null,
            color_trc: (_vs && _vs.color_transfer) || colorTrc || null,
            colorspace: (_vs && _vs.color_space) || colorspace || null,
            bits_per_pixel: (typeof bitsPerPixel !== 'undefined' && isFinite(bitsPerPixel)) ? bitsPerPixel : null,
            media_is_animation: args.variables.vmafMediaIsAnimation === true ? 1 : 0,
            is_hdr: isHDR ? 1 : 0,
            media_genre: args.variables.vmafMediaGenre || null,
            media_type: args.variables.vmafMediaType || null,
            media_year: args.variables.vmafMediaYear || null,
            media_title: args.variables.vmafSeriesTitle || null,
            release_group: args.variables.vmafReleaseGroup || null,
            network: args.variables.vmafNetwork || null,
            original_language: args.variables.vmafOriginalLanguage || null,
            source_cambi: (args.variables.vmafSourceCAMBI != null ? Number(args.variables.vmafSourceCAMBI) : null),
            source_cambi_p95: (args.variables.vmafSourceCAMBIP95 != null ? Number(args.variables.vmafSourceCAMBIP95) : null),
            metric_contract_id: measurementMetricContract.metricContractId,
            encoder_profile_id: measurementMetricContract.encoderProfileId,
            file_path: (args.inputFileObj && args.inputFileObj.file) || (args.inputFileObj && args.inputFileObj._id) || null
        };
        var _historyHalfLifeDays = 120;
        var _curves = _vdb.getSimilarSweepCurves(_db, _src, {
            limit: 20000,
            referenceContractId: args.variables.vmafReferenceContractId,
            metricContractId: measurementMetricContract.metricContractId,
            encoderProfileId: measurementMetricContract.encoderProfileId,
        });
        // Binding-constraint floors for the constraint-aware centre. These activate predictCQCenter's
        // per-neighbour bindingTargetCQ ONLY for neighbours whose curve carries 1%-low / CAMBI (sparse
        // today, accruing via the dual-write); all other neighbours keep the VMAF-mean crossing, so the
        // centre is unchanged until the data fills in, then it self-corrects for banding/grain-bound
        // content. Floors mirror the live selection gates (1%-low 88; CAMBI 6.0 anim / 5.0 HDR / 5.5 SDR).
        var _vmafFloor = Number(args.variables.vmafMinFrameVMAF) || Number(args.inputs && args.inputs.minFrameVMAF) || 88;
        var _cambiFloor = (args.variables.vmafMediaIsAnimation === true) ? 6.0 : (isHDR ? 5.0 : 5.5);
        var _labelMaxExtrap = String(_src.tier || '').toLowerCase() === '720p' ? 12 : 5;
        var _ctr = _vp.predictCQCenter(_curves, _src, { targetVmaf: _tgt },
            { recencyHalfLifeDays: _historyHalfLifeDays, vmafFloor: _vmafFloor,
                cambiFloor: _cambiFloor, maxLabelExtrap: _labelMaxExtrap });
        var _sameContractEffectiveSupport = referenceContractBridge.effectiveJobSupport(
            _curves, _src, { recencyHalfLifeDays: _historyHalfLifeDays }, {});
        if (_ctr) _ctr.effectiveSupport = Math.round(_sameContractEffectiveSupport * 10) / 10;
        var _predictionRole = 'same_contract_probe_planning';
        var _legacySeed = null;
        // Require useful same-contract support before falling back. The legacy
        // bridge applies a hard 365-day cutoff plus a real 120-day half-life;
        // unlike the old recencyHalfLifeDays=0 call, this is not infinite-age
        // equal weighting.
        if (canonicalInput && (!_ctr || _ctr.centerCq == null || Number(_ctr.support) < 30
            || _sameContractEffectiveSupport < 8)) {
            var _legacyCurves = _vdb.getSimilarSweepCurves(_db, _src, {
                limit: 20000,
                referenceContractId: canonicalDenoise.LEGACY_REFERENCE_CONTRACT_ID,
                metricContractId: _vdb.LEGACY_METRIC_CONTRACT_ID,
                encoderProfileId: _vdb.LEGACY_ENCODER_PROFILE_ID,
            });
            // Calibration is accepted only from a paired-canary artifact. The
            // bridge never joins immutable legacy/canonical jobs by file path:
            // a path can be replaced in-place and is not a source fingerprint.
            // A durable operator-supplied artifact wins; the bounded grain
            // canary is optional sparse evidence and can only widen uncertainty
            // until it contains enough fully-contextualized source pairs.
            var _configuredCalibrationPath = process.env.TDARR_VMAF_REFERENCE_CALIBRATION || '';
            var _calibrationPaths = _configuredCalibrationPath
                ? [_configuredCalibrationPath]
                : ['/app/configs/vmaf_reference_contract_calibration.json', '/temp/grain-vmaf-contract-canary.json'];
            var _loadedCalibration = loadReferenceContractCalibration(fs, _calibrationPaths,
                function (_calibrationPath, _calibrationReadError) {
                    args.jobLog('Reference-contract calibration ignored (' + _calibrationPath + '): '
                        + (_calibrationReadError && _calibrationReadError.message
                            ? _calibrationReadError.message : String(_calibrationReadError)));
                });
            var _calibrationArtifact = _loadedCalibration.artifact;
            var _calibrationArtifactPath = _loadedCalibration.path;
            _legacySeed = referenceContractBridge.buildSeed(_legacyCurves, _src, _tgt, {
                maxAgeDays: 365,
                recencyHalfLifeDays: _historyHalfLifeDays,
                minNeighbours: 3,
                minSlopeCurves: 5,
                calibrationArtifact: _calibrationArtifact,
                expectedEncoderProfileId: referenceComparisonEncoderProfileId,
            });
            if (_legacySeed && _legacySeed.provenance) {
                _legacySeed.provenance.calibrationArtifactPath = _calibrationArtifactPath;
            }
            args.variables.vmafReferenceContractBridge = _legacySeed;
            if (_legacySeed.action === 'schedule_fresh_seed_probes') {
                _predictionRole = 'legacy_contract_probe_planning_only';
                _ctr = {
                    centerCq: _legacySeed.centerCq,
                    rangeMin: _legacySeed.rangeMin,
                    rangeMax: _legacySeed.rangeMax,
                    priorSlope: _legacySeed.priorSlope,
                    support: _legacySeed.supportJobs,
                    effectiveSupport: _legacySeed.effectiveSupportJobs,
                    totalSimilarityWeight: _legacySeed.totalSimilarityWeight,
                    slopeSupport: _legacySeed.slopeSupportCurves,
                    sigmaCq: null,
                    featureEta: null,
                };
                // Legacy variance is not transferable through denoising. Sample
                // count remains governed by current-contract/default policy.
                _curves = [];
            }
        } else if (canonicalInput) {
            args.variables.vmafReferenceContractBridge = {
                action: 'schedule_fresh_seed_probes',
                provenance: {
                    role: _predictionRole,
                    sourceReferenceContractId: args.variables.vmafReferenceContractId,
                    targetReferenceContractId: args.variables.vmafReferenceContractId,
                    acceptanceAuthority: 'fresh-current-contract-measurements-only',
                    recencyHalfLifeDays: _historyHalfLifeDays,
                    lookbackSemantics: 'positive half-life decays history; row limit is not a day lookback',
                },
            };
        }
        var _sc = _vp.selectSampleCount(_curves, { slope: (_ctr && _ctr.priorSlope != null) ? _ctr.priorSlope : -0.4, cqPrecision: 0.75, distMinSamples: 4 });
        args.jobLog('[PREDICT] role=' + _predictionRole + ' | predictCQCenter=' + (_ctr && _ctr.centerCq != null ? _ctr.centerCq : 'n/a')
            + (_ctr && _ctr.sigmaCq != null ? ' +-' + _ctr.sigmaCq : '')
            + ' (range ' + (_ctr && _ctr.rangeMin != null ? _ctr.rangeMin : 'n/a') + '-'
            + (_ctr && _ctr.rangeMax != null ? _ctr.rangeMax : 'n/a') + ', support '
            + (_ctr && _ctr.support != null ? _ctr.support : 0) + ' jobs'
            + (_ctr && _ctr.effectiveSupport != null ? ', effectiveSupport ' + _ctr.effectiveSupport : '')
            + (_ctr && _ctr.totalSimilarityWeight != null ? ', totalWeight ' + _ctr.totalSimilarityWeight : '')
            + ', tier ' + _src.tier + ', labelExtrap ' + _labelMaxExtrap + ')'
            + ' | priorSlope=' + (_ctr && _ctr.priorSlope != null ? _ctr.priorSlope : 'n/a') + ' dVMAF/dCQ (from ' + (_ctr && _ctr.slopeSupport || 0) + ' curves)'
            + ' | live initial crfValues=[' + crfValues.join(',') + ']'
            + ' | sampleCount suggest=' + _sc.sampleCount + ' (sdEst=' + (_sc.sdEstimate != null ? _sc.sdEstimate.toFixed(2) : 'n/a') + ', ' + _sc.reason + ')');
        if (_ctr && _ctr.featureEta) {
            var _et = _ctr.featureEta, _ek = Object.keys(_et).filter(function (k) { return _et[k] != null; })
                .sort(function (a, b) { return _et[b] - _et[a]; });
            args.jobLog('[PREDICT] learned metadata importance (eta^2, higher=more weight): '
                + _ek.map(function (k) { return k + '=' + _et[k].toFixed(3); }).join(', '));
        }

        // ── ACTING: use history once to schedule three FRESH measurements.
        // Every later guided/retry round bypasses this block and follows only
        // the current file's measured current-contract curve.
        var _legacyEffectiveSupportOk = _predictionRole !== 'legacy_contract_probe_planning_only'
            || Number(_ctr && _ctr.effectiveSupport) >= 8;
        if (shouldApplyHistoricalProbeSeed({
                isRetry: isRetry,
                guidedCount: guidedNext.length,
                alreadySeeded: args.variables.vmafPredictorSeeded,
                dynamicCQ: dynamicCQ,
            }) && _ctr && _ctr.centerCq != null && _ctr.support >= 30
            && _legacyEffectiveSupportOk
            && _ctr.rangeMin != null && _ctr.rangeMax != null) {
            var _cC = Math.max(16, Math.min(51, Math.round(_ctr.centerCq)));
            var _rlo = Math.max(16, Math.min(_cC, Math.round(_ctr.rangeMin)));
            var _rhi = Math.min(51, Math.max(_cC, Math.round(_ctr.rangeMax)));
            if (_rhi - _rlo > 10) { _rlo = Math.max(16, _cC - 5); _rhi = Math.min(51, _cC + 5); } // cap span
            var _seed = buildFreshProbeSeed(_cC, _rlo, _rhi);
            if (_seed.length === 3) {
                crfValues = _seed;
                args.variables.vmafTestedCQs = crfValues.slice();
                args.variables.vmafPredictorSeeded = true;
                args.jobLog('[ACTING] Predictor-seeded FRESH sweep: crfValues=[' + crfValues.join(',')
                    + '] (center ' + _ctr.centerCq + ', range ' + _ctr.rangeMin + '-' + _ctr.rangeMax
                    + ', priorSlope ' + _ctr.priorSlope + ', support ' + _ctr.support + ' jobs, role '
                    + _predictionRole + '). Every scheduled CQ remains current-contract measured.');
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

    // ── Boundary-first CQ16 seed (hint promoted to action, 2026-07-20) ──
    // SweepLog 2026-07-20: failure jobs burn a median 9 CQ tests vs 3 for clean jobs and 89%
    // descend to CQ<=16.5 anyway across 4-5 retry rounds. When same-title history already shows
    // repeated no-feasible/unreachable outcomes, measure the CQ16 quality ceiling in round 1 so
    // selection/retry can terminate early instead of walking down. This is a measurement-order
    // change only: it adds a probe, never skips or rejects anything.
    // Kill switch: args.variables.vmafBoundarySeed === false.
    try {
        var _bsHint = args.variables.vmafSameTitleEmptyBandShadow;
        if (shouldSeedBoundaryCq16({
            killSwitch: args.variables.vmafBoundarySeed,
            isRetry: isRetry,
            guidedCount: guidedNext.length,
            crfValues: crfValues,
            testedCQs: args.variables.vmafTestedCQs,
            hint: _bsHint,
        })) {
            crfValues.push(16);
            crfValues.sort(function (a, b) { return a - b; });
            args.variables.vmafTestedCQs.push(16);
            args.variables.vmafTestedCQs.sort(function (a, b) { return a - b; });
            args.variables.vmafBoundarySeedCQ16 = true;
            _bsHint.boundarySeedApplied = true;
            args.jobLog('[BOUNDARY-SEED] Same-title history shows ' + _bsHint.priorNoFeasible
                + ' prior no-feasible/unreachable outcome(s); seeding CQ16 into round 1 to measure'
                + ' the quality ceiling up front (measurement-order change only)');
        }
    } catch (_bsErr) {
        args.jobLog('[BOUNDARY-SEED] skipped (non-fatal): ' + (_bsErr && _bsErr.message ? _bsErr.message : String(_bsErr)));
    }

    // ── Epsilon-exploration probe: grow bracketed oracle coverage for autoresearch ──
    // ~88% of recorded sweep curves have exactly 3 points clustered where the predictor already
    // aims, so the backtest can only grade jobs whose curve happened to bracket the binding CQ.
    // On a deterministic ~1-in-10 slice of first-attempt jobs (hash of file path, so requeues of
    // the same file make the same choice), add ONE extra probe CQ beyond the bracket edge. Skewed
    // upward 3:1 because all-feasible curves (optimum above the tested max) outnumber
    // all-infeasible ones ~2:1 in the training DB. Retries/guided sweeps are excluded.
    try {
        var exploreRateRaw = args.variables.vmafExplorationRate;
        if (exploreRateRaw === undefined || exploreRateRaw === null || exploreRateRaw === '') {
            exploreRateRaw = args.inputs.explorationRate;
        }
        var exploreRate = Number(exploreRateRaw);
        if (!isFinite(exploreRate)) exploreRate = 0.02;
        exploreRate = Math.max(0, Math.min(0.25, exploreRate));
        args.variables.vmafExplorationRateEffective = exploreRate;
        if (!isRetry && guidedNext.length === 0) {
            args.jobLog('[EXPLORE] research-only extra-CQ rate: ' + (exploreRate * 100).toFixed(1) + '%');
        }
        if (!isRetry && guidedNext.length === 0 && crfValues.length >= 2) {
            var _exPath = String((args.inputFileObj && (args.inputFileObj._id || args.inputFileObj.file)) || '');
            var _exHash = 0;
            for (var _exI = 0; _exI < _exPath.length; _exI++) {
                _exHash = ((_exHash << 5) - _exHash + _exPath.charCodeAt(_exI)) | 0;
            }
            _exHash = Math.abs(_exHash);
            if ((_exHash % 1000) / 1000 < exploreRate) {
                var _exUp = (_exHash % 4) !== 3;
                var _exCq = _exUp
                    ? Math.min(51, Math.max.apply(null, crfValues) + 2 * effectiveStep)
                    : Math.max(16, Math.min.apply(null, crfValues) - 2 * effectiveStep);
                var _exKnownFailed = (typeof knownFailedCQs !== 'undefined' && knownFailedCQs && knownFailedCQs.indexOf(_exCq) !== -1);
                if (crfValues.indexOf(_exCq) === -1 && args.variables.vmafTestedCQs.indexOf(_exCq) === -1 && !_exKnownFailed) {
                    crfValues.push(_exCq);
                    crfValues.sort(function (a, b) { return a - b; });
                    args.variables.vmafTestedCQs.push(_exCq);
                    args.variables.vmafTestedCQs.sort(function (a, b) { return a - b; });
                    args.variables.vmafExploreCQ = _exCq;
                    args.jobLog('[EXPLORE] added exploration probe CQ ' + _exCq + ' (' + (_exUp ? 'above' : 'below')
                        + ' bracket; deterministic 1-in-' + Math.round(1 / exploreRate) + ' file slice)');
                }
            }
        }
    } catch (_exErr) {
        args.jobLog('[EXPLORE] exploration probe skipped (non-fatal): ' + (_exErr && _exErr.message ? _exErr.message : String(_exErr)));
    }

    // ── Cross-job sweep reuse (2026-07-20) ──
    // Requeued files re-measured identical (file, CQ) points 162 times since 06-15 (~15 GPU-h),
    // concentrated in requeue waves. If the training DB already holds a current-era measurement
    // of this exact file at a scheduled CQ, skip re-encoding it: selectBestParameters revives
    // the stored row and re-judges it under CURRENT policy. At least one CQ is always measured
    // fresh — it acts as an encoder/pipeline drift canary and guarantees selection has a
    // parameterSet template for revived rows. Era floor 2026-07-08 (hardness-first sampling +
    // corrected size projection both live); rows must carry harmonic/1%-low/size and >=8 clips.
    // Kill switch: args.variables.vmafCrossJobReuse === false.
    try {
        if (args.variables.vmafCrossJobReuse !== false && crfValues.length >= 2) {
            var _cjPath = String((args.inputFileObj && (args.inputFileObj._id || args.inputFileObj.file)) || '');
            if (_cjPath) {
                var _cjDbm = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
                var _cjDb = _cjDbm.openDb();
                var _cjMaxAgeDays = Number(args.variables.vmafCrossJobReuseMaxAgeDays);
                if (!isFinite(_cjMaxAgeDays) || _cjMaxAgeDays <= 0) _cjMaxAgeDays = 45;
                var _cjSince = new Date(Date.now() - _cjMaxAgeDays * 86400000).toISOString();
                if (_cjSince < '2026-07-08') _cjSince = '2026-07-08';
                var _cjRows = _cjDb.prepare(
                    'SELECT s.cq, s.parameter_set_id, s.preset, s.vmaf_mean, s.vmaf_harmonic_mean, s.vmaf_min,' +
                    ' s.vmaf_max, s.vmaf_p1_low, s.vmaf_stddev, s.cambi_mean, s.cambi_max, s.cambi_p95,' +
                    ' s.avg_size_mb, s.sample_count, s.clip_sample_indices, s.created_at, s.job_id' +
                    ' FROM sweep_points s JOIN jobs j ON s.job_id = j.job_id' +
                    ' WHERE j.file_path = ? AND s.created_at >= ?' +
                    " AND COALESCE(s.reference_contract_id, 'legacy-original-tf4-v1') = ?" +
                    " AND COALESCE(j.reference_contract_id, 'legacy-original-tf4-v1') = ?" +
                     " AND COALESCE(s.reference_contract_id, 'legacy-original-tf4-v1')" +
                     " = COALESCE(j.reference_contract_id, 'legacy-original-tf4-v1')" +
                     ' AND s.metric_contract_id = j.metric_contract_id' +
                     ' AND s.encoder_profile_id = j.encoder_profile_id' +
                     ' AND s.metric_contract_id = ? AND s.encoder_profile_id = ?' +
                     ' AND s.vmaf_harmonic_mean IS NOT NULL AND s.vmaf_p1_low IS NOT NULL' +
                     ' AND s.avg_size_mb IS NOT NULL AND s.sample_count >= 8' +
                     ' ORDER BY s.created_at DESC').all(_cjPath, _cjSince,
                         args.variables.vmafReferenceContractId,
                         args.variables.vmafReferenceContractId,
                         measurementMetricContract.metricContractId,
                         measurementMetricContract.encoderProfileId);
                var _cjByCq = {};
                for (var _cjI = 0; _cjI < _cjRows.length; _cjI++) {
                    var _cjR = _cjRows[_cjI];
                    if (_cjR.preset && presets.indexOf(_cjR.preset) === -1) continue;
                    var _cjKey = Math.round(Number(_cjR.cq) * 10) / 10;
                    if (isFinite(_cjKey) && _cjByCq[_cjKey] === undefined) _cjByCq[_cjKey] = _cjR; // newest wins
                }
                var _cjReusable = crfValues.filter(function (v) {
                    return _cjByCq[Math.round(v * 10) / 10] !== undefined;
                });
                if (_cjReusable.length >= crfValues.length) {
                    // Keep the middle CQ fresh as the drift canary / parameterSet template.
                    var _cjSorted = crfValues.slice().sort(function (a, b) { return a - b; });
                    var _cjKeep = _cjSorted[Math.floor(_cjSorted.length / 2)];
                    _cjReusable = _cjReusable.filter(function (v) { return v !== _cjKeep; });
                }
                if (_cjReusable.length > 0) {
                    // Merge with rows reused in earlier rounds of this job (dedupe by CQ).
                    var _cjPrev = Array.isArray(args.variables.vmafReusedSweepRows)
                        ? args.variables.vmafReusedSweepRows : [];
                    var _cjSeenCq = {};
                    _cjPrev.forEach(function (row) {
                        _cjSeenCq[Math.round(Number(row.cq) * 10) / 10] = true;
                    });
                    args.variables.vmafReusedSweepRows = _cjPrev.concat(_cjReusable
                        .filter(function (v) { return !_cjSeenCq[Math.round(v * 10) / 10]; })
                        .map(function (v) { return _cjByCq[Math.round(v * 10) / 10]; }));
                    crfValues = crfValues.filter(function (v) { return _cjReusable.indexOf(v) === -1; });
                    args.jobLog('[REUSE] Skipping re-encode of CQ ' + _cjReusable.join(', ')
                        + ' - current-era measurement(s) of this exact file exist in the training DB'
                        + ' (since ' + _cjSince.slice(0, 10) + '); revived at selection under current policy.'
                        + ' Fresh probe(s): ' + crfValues.join(', '));
                }
            }
        }
    } catch (_cjErr) {
        args.jobLog('[REUSE] cross-job reuse skipped (non-fatal): ' + (_cjErr && _cjErr.message ? _cjErr.message : String(_cjErr)));
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

    // The flag contract is resolved before historical probe planning so an
    // adapter can match only the exact comparison profile used by this sweep.
    if (!resolvedNvencContract) {
        resolvedNvencContract = resolveNvencFlagContract(
            args, referenceContract.temporalPolicy, execFileSync);
    }
    var temporalPolicy = resolvedNvencContract.temporalPolicy;
    var nvencFlagArgs = resolvedNvencContract.nvencFlagArgs;

    var totalTests = parameterSets.length * samples.length;
    var completedTests = 0;
    args.jobLog('Testing ' + parameterSets.length + ' parameter sets on ' + samples.length + ' samples (' + totalTests + ' total encodes)...');

    // Report initial progress to Tdarr
    if (args.updateWorker) {
        args.updateWorker({ percentage: 0 });
    }

    // Run every encode (paramSet x sample) through a bounded-concurrency pool so several NVENC
    // sessions stay busy at once. A single av1_nvenc pass leaves the encoder + decoder idle during
    // multipass passes and serial cuvid decode, so running ~3 concurrently is ~2.5x faster wall-clock
    // than the old one-at-a-time execSync loop (benchmarked on 4K HDR). Encode FLAGS are unchanged
    // (they MUST match the final transcode) - only scheduling changes. Tune via
    // inputs.maxParallelEncodes / variables.vmafMaxParallelEncodes (default 3, clamped 1-6).
    var maxParallelEncodes = Math.max(1, Math.min(6,
        Number(args.inputs.maxParallelEncodes) || Number(args.variables.vmafMaxParallelEncodes) || 3));
    var sampleEncodeTimeoutSeconds = Math.max(30, Math.min(3600,
        Number(args.inputs.sampleEncodeTimeoutSeconds) || Number(args.variables.vmafSampleEncodeTimeoutSeconds) || 600));
    var minParameterCoverage = Number(args.inputs.minParameterCoverage);
    if (!isFinite(minParameterCoverage)) minParameterCoverage = 0.8;
    minParameterCoverage = Math.max(0.5, Math.min(1, minParameterCoverage));
    args.jobLog('Encoding in parallel: up to ' + maxParallelEncodes + ' concurrent NVENC sessions');
    args.jobLog('Sample encode deadline: ' + sampleEncodeTimeoutSeconds + 's; minimum per-parameter coverage: ' + Math.round(minParameterCoverage * 100) + '%');

    var encodeTasks = [];
    for (var psi = 0; psi < parameterSets.length; psi++) {
        for (var si = 0; si < samples.length; si++) {
            encodeTasks.push({ paramSet: parameterSets[psi], sampleIndex: si, sample: samples[si] });
        }
    }

    function runEncodeTask(task) {
        return new Promise(function (resolve) {
            var paramSet = task.paramSet, si = task.sampleIndex, sample = task.sample;
            var container = path.extname(sample).slice(1);
            var outputPath = cacheDir + '/test_' + paramSet.id + '_s' + (si + 1) + '.' + container;
            var invocationArgs = buildSampleEncodeArgs(paramSet, sample, outputPath, nvencFlagArgs, {
                canonicalInput: canonicalInput,
                temporalPolicy: referenceContract.temporalPolicy,
            });
            args.jobLog('Testing: ' + paramSet.id + ' on sample ' + (si + 1));
            var startTime = Date.now();
            var child = spawn(args.ffmpegPath, invocationArgs, { shell: false, windowsHide: true });
            var stderrTail = '';
            var settled = false;
            var timedOut = false;
            var timeout = setTimeout(function () {
                timedOut = true;
                try { child.kill('SIGKILL'); } catch (e) {}
            }, sampleEncodeTimeoutSeconds * 1000);
            function finish(result) {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve(result);
            }
            if (child.stderr) child.stderr.on('data', function (d) {
                stderrTail += d.toString();
                if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
            });
            child.on('error', function (e) {
                finish({ paramSet: paramSet, sampleIndex: si, sample: sample, outputPath: outputPath,
                    ok: false, error: e.message, stderrTail: stderrTail, encodingTime: (Date.now() - startTime) / 1000 });
            });
            child.on('close', function (code) {
                finish({ paramSet: paramSet, sampleIndex: si, sample: sample, outputPath: outputPath,
                    ok: code === 0 && !timedOut, error: timedOut ? ('sample encode timed out after ' + sampleEncodeTimeoutSeconds + 's')
                        : (code === 0 ? null : ('ffmpeg exited with code ' + code)),
                    stderrTail: stderrTail, encodingTime: (Date.now() - startTime) / 1000 });
            });
        });
    }

    function handleEncodeResult(r) {
        completedTests++;
        if (!Array.isArray(args.variables.vmafTemporaryFiles)) args.variables.vmafTemporaryFiles = [];
        if (r.outputPath && args.variables.vmafTemporaryFiles.indexOf(r.outputPath) === -1) {
            args.variables.vmafTemporaryFiles.push(r.outputPath);
        }
        if (!r.ok) {
            encodeFailures.push({ parameterSetId: r.paramSet.id, sampleIndex: r.sampleIndex,
                error: r.error || 'encode failed', stderrTail: r.stderrTail, outputPath: r.outputPath });
            args.jobLog('  Failed (' + r.paramSet.id + ' s' + (r.sampleIndex + 1) + '): ' + (r.error || 'encode failed'));
            var det = (r.stderrTail || '').trim();
            if (det) args.jobLog('  FFmpeg error tail: ' + det.replace(/\s+/g, ' ').substring(0, 500));
        } else {
            var fileSize = 0;
            try { fileSize = fs.statSync(r.outputPath).size / (1024 * 1024); }
            catch (e) { args.jobLog('Could not get file size for ' + r.outputPath); }
            // A near-empty output means the encode produced no frames (e.g. the input sample had no
            // video packets) even though ffmpeg exited 0. Treat as failure so it can't poison VMAF.
            if (fileSize * 1024 * 1024 < 20000) {
                encodeFailures.push({ parameterSetId: r.paramSet.id, sampleIndex: r.sampleIndex,
                    error: 'Output file is empty/near-empty (' + (fileSize * 1024).toFixed(1) + ' KB) - no video frames encoded',
                    outputPath: r.outputPath });
                args.jobLog('  Failed: output is empty/near-empty (' + (fileSize * 1024).toFixed(1) + ' KB) - input sample likely has no video');
            } else {
                testResults.push({ parameterSetId: r.paramSet.id, sampleIndex: r.sampleIndex,
                    outputPath: r.outputPath, fileSizeMB: fileSize, encodingTimeSeconds: r.encodingTime,
                    parameterSet: r.paramSet, originalSamplePath: r.sample });
                args.jobLog('  Done: ' + r.paramSet.id + ' s' + (r.sampleIndex + 1) + ' -> ' + fileSize.toFixed(2) + ' MB, ' + r.encodingTime.toFixed(1) + 's');
            }
        }
        var progressPercent = Math.round((completedTests / totalTests) * 100);
        args.jobLog('  Progress: ' + completedTests + '/' + totalTests + ' encodes [' + progressPercent + '%]');
        if (args.updateWorker) {
            args.updateWorker({ percentage: progressPercent,
                ETA: Math.round((totalTests - completedTests) * (r.encodingTime || 15) / maxParallelEncodes) });
        }
    }

    // Bounded-concurrency worker pool: maxParallelEncodes workers, each pulls the next task on finish.
    // It accepts an explicit task list so an experimental guided round can encode a small sentinel
    // block first and avoid launching the remaining encodes for CQs that are already clear failures.
    function runEncodePool(tasks) {
        var taskIndex = 0;
        function worker() {
            if (taskIndex >= tasks.length) return Promise.resolve();
            var task = tasks[taskIndex++];
            return runEncodeTask(task).then(function (result) {
                handleEncodeResult(result);
                return worker();
            });
        }
        var workers = [];
        for (var workerIndex = 0; workerIndex < Math.min(maxParallelEncodes, tasks.length); workerIndex++) {
            workers.push(worker());
        }
        return Promise.all(workers);
    }

    // Encode-side hard-abort (experimental, disabled by default). The downstream VMAF plugin already
    // stops measuring a clearly failed CQ, but by then every clip has been encoded. On a guided round
    // we have prior per-clip hardness, so encode the K hardest clips first, measure those serially,
    // and skip the rest only when their collective 90% CI upper bound is below target-minus-margin.
    // A hard-abort can only reject an aggressive CQ, moving selection toward a safer/lower CQ.
    args.variables.vmafPrecomputedVmafResults = [];
    args.variables.vmafEncodeHardAbortedParameterSets = [];
    var encodeHardAbortEnabled = (args.inputs.encodeHardAbort === true || args.inputs.encodeHardAbort === 'true');
    var encodeHardAbortK = Math.max(2, Math.min(6, Number(args.inputs.encodeHardAbortK) || 4));
    var encodeHardAbortMargin = Number(args.inputs.encodeHardAbortMargin);
    if (!isFinite(encodeHardAbortMargin) || encodeHardAbortMargin <= 0) encodeHardAbortMargin = 1.5;
    var sentinelIndices = getHardestSampleIndices(args.variables.vmafClipHardness, samples.length, encodeHardAbortK);
    var priorGpuCapability = args.variables.vmafGpuCapabilityCache;
    var hasPositiveGpuCapability = !!(priorGpuCapability && priorGpuCapability.available === true &&
        priorGpuCapability.ffmpegPath === args.ffmpegPath &&
        priorGpuCapability.metricContractId === measurementMetricContract.metricContractId &&
        priorGpuCapability.modelPath === measurementMetricContract.modelPath &&
        priorGpuCapability.modelSha256 === measurementMetricContract.modelSha256 &&
        priorGpuCapability.filterName === measurementMetricContract.filterName &&
        priorGpuCapability.scoringPixelFormat === measurementMetricContract.scoringPixelFormat);
    var canUseEncodeHardAbort = encodeHardAbortEnabled && isGuidedRound && hasPositiveGpuCapability &&
        sentinelIndices.length === encodeHardAbortK;

    if (canUseEncodeHardAbort) {
        args.jobLog('Encode hard-abort staged: hardest ' + encodeHardAbortK + ' clips first (indices ' +
            sentinelIndices.join(',') + '); abort threshold is CI upper <= ' +
            (targetMinVMAF - encodeHardAbortMargin).toFixed(2));
        var sentinelLookup = {};
        sentinelIndices.forEach(function (sampleIndex) { sentinelLookup[sampleIndex] = true; });
        var sentinelTasks = encodeTasks.filter(function (task) { return sentinelLookup[task.sampleIndex]; });
        await runEncodePool(sentinelTasks);

        try {
            var calculateModule = require('../../calculateVMAF/1.0.0/index.js');
            var calculateTestApi = calculateModule && calculateModule._test;
            if (!calculateTestApi || typeof calculateTestApi.calculateSingleVmafGpuAsync !== 'function' ||
                    typeof calculateTestApi.findVmafModel !== 'function') {
                throw new Error('calculateVMAF sentinel API is unavailable');
            }
            var sentinelModelPath = calculateTestApi.findVmafModel(fs, args.inputFileObj);
            var sentinelArgs = Object.assign({}, args, {
                inputs: Object.assign({}, args.inputs, { ssimMode: 'off' }),
                variables: Object.assign({}, args.variables, { vmafSsimMode: 'off' }),
            });
            var sentinelScoresByParameter = {};
            for (var sentinelResultIndex = 0; sentinelResultIndex < testResults.length; sentinelResultIndex++) {
                var encodedSentinel = testResults[sentinelResultIndex];
                if (!sentinelLookup[encodedSentinel.sampleIndex]) continue;
                var sentinelVmaf = await calculateTestApi.calculateSingleVmafGpuAsync(
                    sentinelArgs, encodedSentinel, samples, cacheDir, sentinelModelPath);
                if (!sentinelVmaf || !sentinelVmaf.success) {
                    args.jobLog('Encode hard-abort sentinel VMAF failed for ' + encodedSentinel.parameterSetId +
                        ' sample ' + (encodedSentinel.sampleIndex + 1) + '; encoding the full CQ. ' +
                        ((sentinelVmaf && sentinelVmaf.error) || 'unknown VMAF error'));
                    continue;
                }
                args.variables.vmafPrecomputedVmafResults.push(sentinelVmaf.result);
                if (!sentinelScoresByParameter[encodedSentinel.parameterSetId]) {
                    sentinelScoresByParameter[encodedSentinel.parameterSetId] = [];
                }
                sentinelScoresByParameter[encodedSentinel.parameterSetId].push(sentinelVmaf.result.vmafScore);
            }

            for (var sentinelParameterIndex = 0; sentinelParameterIndex < parameterSets.length; sentinelParameterIndex++) {
                var sentinelParameterId = parameterSets[sentinelParameterIndex].id;
                var sentinelScores = sentinelScoresByParameter[sentinelParameterId] || [];
                if (sentinelScores.length !== encodeHardAbortK) continue;
                var sentinelDecision = shouldEncodeHardAbort(sentinelScores, targetMinVMAF, encodeHardAbortMargin);
                if (sentinelDecision.abort) {
                    args.variables.vmafEncodeHardAbortedParameterSets.push(sentinelParameterId);
                    args.jobLog('Encode hard-abort ' + sentinelParameterId + ': hardest-' + sentinelDecision.count +
                        ' mean=' + sentinelDecision.mean.toFixed(2) + ', CI upper=' +
                        sentinelDecision.ciUpper.toFixed(2) + ' <= ' + sentinelDecision.threshold.toFixed(2) +
                        '; skipping ' + Math.max(0, samples.length - encodeHardAbortK) + ' remaining encodes');
                }
            }
        } catch (sentinelError) {
            // Fail open to the proven full-encode path. Already completed sentinel encodes remain valid.
            args.jobLog('Encode hard-abort unavailable; encoding every remaining clip: ' + sentinelError.message);
        }

        var hardAbortedLookup = {};
        args.variables.vmafEncodeHardAbortedParameterSets.forEach(function (parameterSetId) {
            hardAbortedLookup[parameterSetId] = true;
        });
        var remainingTasks = encodeTasks.filter(function (task) {
            return !sentinelLookup[task.sampleIndex] && !hardAbortedLookup[task.paramSet.id];
        });
        await runEncodePool(remainingTasks);
    } else {
        if (encodeHardAbortEnabled) {
            args.jobLog('Encode hard-abort not armed: it requires a guided round, a cached positive GPU VMAF capability, and ' +
                encodeHardAbortK + ' prior clip-hardness scores; using the full-encode path');
        }
        await runEncodePool(encodeTasks);
    }

    // A partially encoded CQ must not enter VMAF aggregation with an unrepresentative subset.
    var requiredPerParameter = Math.max(1, Math.ceil(samples.length * minParameterCoverage));
    var successCountByParameter = {};
    for (var _tr = 0; _tr < testResults.length; _tr++) {
        var _pid = testResults[_tr].parameterSetId;
        successCountByParameter[_pid] = Number(successCountByParameter[_pid] || 0) + 1;
    }
    var incompleteParameterSets = [];
    var encodeHardAbortedLookup = {};
    args.variables.vmafEncodeHardAbortedParameterSets.forEach(function (parameterSetId) {
        encodeHardAbortedLookup[parameterSetId] = true;
    });
    for (var _ps = 0; _ps < parameterSets.length; _ps++) {
        var _parameterId = parameterSets[_ps].id;
        var _successes = Number(successCountByParameter[_parameterId] || 0);
        if (_successes < requiredPerParameter && !encodeHardAbortedLookup[_parameterId]) {
            incompleteParameterSets.push({ parameterSetId: _parameterId, successes: _successes,
                expected: samples.length, required: requiredPerParameter });
        }
    }
    if (incompleteParameterSets.length > 0) {
        var _incompleteIds = incompleteParameterSets.map(function (item) { return item.parameterSetId; });
        testResults = testResults.filter(function (item) { return _incompleteIds.indexOf(item.parameterSetId) === -1; });
        args.variables.vmafIncompleteParameterSets = incompleteParameterSets;
        args.jobLog('Rejected ' + incompleteParameterSets.length + ' incomplete parameter set(s): ' +
            incompleteParameterSets.map(function (item) { return item.parameterSetId + '=' + item.successes + '/' + item.expected; }).join(', '));
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
exports._test = {
    getHardestSampleIndices: getHardestSampleIndices,
    shouldEncodeHardAbort: shouldEncodeHardAbort,
    shouldSeedBoundaryCq16: shouldSeedBoundaryCq16,
    shouldApplyHistoricalProbeSeed: shouldApplyHistoricalProbeSeed,
    buildFreshProbeSeed: buildFreshProbeSeed,
    loadReferenceContractCalibration: loadReferenceContractCalibration,
    buildNvencCapabilityProbeArgs: buildNvencCapabilityProbeArgs,
    resolveNvencFlagContract: resolveNvencFlagContract,
    buildSampleEncodeArgs: buildSampleEncodeArgs,
};
