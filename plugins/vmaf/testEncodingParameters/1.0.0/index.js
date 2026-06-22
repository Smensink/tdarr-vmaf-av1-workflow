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
            [padLow, padHigh].forEach(function(pad) {
                if (testedCQs.indexOf(pad) === -1 && !seen[pad]) {
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

// Dynamic CQ range calculation
    else if (dynamicCQ) {
        args.jobLog('=== Dynamic CQ Range Calculation ===');

        // Get source file characteristics
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

            // Find video stream
            for (var i = 0; i < streams.length; i++) {
                if (streams[i].codec_type === 'video') {
                    sourceWidth = streams[i].width || 1920;
                    sourceHeight = streams[i].height || 1080;
                    sourceCodec = streams[i].codec_name || 'unknown';
                    // Use video stream bitrate if available and more accurate
                    if (streams[i].bit_rate) {
                        sourceBitrateMbps = parseFloat(streams[i].bit_rate) / 1000000;
                    }
                    break;
                }
            }
        }

        // If bitrate not in metadata, calculate from file size and duration
        if (sourceBitrateMbps <= 0 && sourceDuration > 0 && sourceFileSizeMB > 0) {
            sourceBitrateMbps = (sourceFileSizeMB * 8) / sourceDuration;
        }

        args.jobLog('Source file: ' + sourceFileSizeMB.toFixed(2) + ' MB');
        args.jobLog('Source codec: ' + sourceCodec);
        args.jobLog('Source resolution: ' + sourceWidth + 'x' + sourceHeight);
        args.jobLog('Source bitrate: ' + sourceBitrateMbps.toFixed(2) + ' Mbps');
        args.jobLog('Source duration: ' + sourceDuration.toFixed(2) + ' seconds');
        args.jobLog('Target VMAF: ' + targetMinVMAF);
        args.jobLog('Target size reduction: ' + targetSizeReduction + '%');

        // Check for release group profile prior
        var releaseGroupPrior = null;
        try {
            var releaseGroup = args.variables.vmafReleaseGroup || args.variables.vmafReleaseGroupUsed || null;
            if (releaseGroup) {
                var profilesPath = '/app/configs/vmaf_release_group_profiles.json';
                if (fs.existsSync(profilesPath)) {
                    var profilesContent = fs.readFileSync(profilesPath, 'utf8');
                    var profilesData = JSON.parse(profilesContent);

                    var groupKey = String(releaseGroup).toUpperCase();
                    if (profilesData.profiles && profilesData.profiles[groupKey]) {
                        releaseGroupPrior = profilesData.profiles[groupKey];
                        args.jobLog('');
                        args.jobLog('Release Group Profile Found: ' + groupKey);
                        args.jobLog('  Sample count: ' + releaseGroupPrior.sample_count);
                        args.jobLog('  CQ median: ' + releaseGroupPrior.cq_statistics.median.toFixed(1));
                        args.jobLog('  CQ range: ' + releaseGroupPrior.cq_statistics.min.toFixed(1) +
                                   '-' + releaseGroupPrior.cq_statistics.max.toFixed(1));
                        if (releaseGroupPrior.most_common_codec) {
                            args.jobLog('  Common codec: ' + releaseGroupPrior.most_common_codec);
                        }
                        if (releaseGroupPrior.most_common_resolution) {
                            args.jobLog('  Common resolution: ' + releaseGroupPrior.most_common_resolution);
                        }
                    }
                }
            }
        } catch (rgErr) {
            args.jobLog('Could not load release group profile: ' + rgErr.message);
        }

        // Calculate base CQ based on resolution and bitrate
        // AV1 NVENC CQ scale: lower = higher quality, higher = more compression
        // Typical ranges: 1080p content: CQ 24-38, 4K: CQ 20-34, 720p: CQ 28-42

        var baseCQ = 30; // Default starting point

        // Use release group prior if available and reliable
        if (releaseGroupPrior && releaseGroupPrior.sample_count >= 10) {
            baseCQ = Math.round(releaseGroupPrior.cq_statistics.median);
            args.jobLog('Using release group prior median CQ: ' + baseCQ);
        }

        // Adjust for resolution (pixels per frame)
        var pixelCount = sourceWidth * sourceHeight;
        var pixelFactor = pixelCount / (1920 * 1080); // Normalize to 1080p

        if (pixelFactor >= 4) {
            // 4K or higher - need lower CQ for quality
            baseCQ = 26;
        } else if (pixelFactor >= 2) {
            // 1440p
            baseCQ = 28;
        } else if (pixelFactor >= 1) {
            // 1080p
            baseCQ = 30;
        } else if (pixelFactor >= 0.5) {
            // 720p
            baseCQ = 34;
        } else {
            // 480p or lower
            baseCQ = 38;
        }

        args.jobLog('Base CQ for ' + sourceWidth + 'x' + sourceHeight + ': ' + baseCQ);

        // Adjust for source bitrate (bits per pixel per second)
        // Higher bitrate source = more room for compression = can use higher CQ
        var fps = 24; // Assume 24fps if not available
        var bitsPerPixel = (sourceBitrateMbps * 1000000) / (pixelCount * fps);

        args.jobLog('Bits per pixel: ' + bitsPerPixel.toFixed(4));

        // Typical H264 web content: 0.05-0.15 bpp
        // High quality source: 0.15-0.30 bpp
        // Very high quality/raw: 0.30+ bpp
        if (bitsPerPixel < 0.05) {
            // Already highly compressed. Beating such a source on size requires MORE
            // compression, not less: a low starting CQ just burns sweep retries climbing
            // back up (observed: 0.018bpp x265 720p swept 26→42, exhausted retries,
            // hard-failed wanting 44-48). The old -4 here pointed the wrong way; the 4K
            // empirical correction that used to cancel it out is folded in and now
            // applies at every resolution.
            baseCQ += 4;
            args.jobLog('Source is highly compressed (bpp < 0.05) - increasing CQ by 4 to start in the useful high-CQ region');
        } else if (bitsPerPixel < 0.10) {
            // Moderately compressed - base CQ already appropriate
            args.jobLog('Source is moderately compressed (bpp < 0.10) - keeping base CQ');
        } else if (bitsPerPixel > 0.30) {
            // Very high quality - more room for compression. This must be checked before >0.20.
            baseCQ += 4;
            args.jobLog('Source is very high quality (bpp > 0.30) - increasing CQ by 4');
        } else if (bitsPerPixel > 0.20) {
            // High quality source - can use higher CQ
            baseCQ += 2;
            args.jobLog('Source is high quality (bpp > 0.20) - increasing CQ by 2');
        }

        // Adjust for target size reduction
        // Higher target reduction = need higher CQ
        if (targetSizeReduction > 40) {
            baseCQ += 2;
            args.jobLog('High target reduction (' + targetSizeReduction + '%) - increasing CQ by 2');
        } else if (targetSizeReduction < 20) {
            baseCQ -= 2;
            args.jobLog('Low target reduction (' + targetSizeReduction + '%) - reducing CQ by 2');
        }

        // Adjust for VMAF target (monotonic: higher target -> lower CQ / higher quality).
        // Finer bands so the high-quality 94-96 region pulls CQ down more than the old 93
        // default did (old code gave the SAME -2 for 93 and 95, so raising the target never
        // moved the cold-start sweep centre). This only seeds the initial bracket; the
        // historical VMAF-vs-CQ curve below refines the centre per-content when history exists.
        if (targetMinVMAF >= 96) {
            baseCQ -= 5;
            args.jobLog('Very high VMAF target (' + targetMinVMAF + ') - reducing CQ by 5');
        } else if (targetMinVMAF >= 94) {
            baseCQ -= 4;
            args.jobLog('High VMAF target (' + targetMinVMAF + ') - reducing CQ by 4');
        } else if (targetMinVMAF >= 92) {
            baseCQ -= 2;
            args.jobLog('Moderate-high VMAF target (' + targetMinVMAF + ') - reducing CQ by 2');
        } else if (targetMinVMAF >= 90) {
            baseCQ -= 1;
            args.jobLog('Standard VMAF target (' + targetMinVMAF + ') - reducing CQ by 1');
        } else if (targetMinVMAF < 88) {
            baseCQ += 2;
            args.jobLog('Low VMAF target (' + targetMinVMAF + ') - increasing CQ by 2');
        }

        // Codec/tier/HDR awareness
        var codecCat = (sourceCodec || '').toLowerCase().indexOf('av1') !== -1 ? 'av1' :
                       ((sourceCodec || '').toLowerCase().indexOf('265') !== -1 || (sourceCodec || '').toLowerCase().indexOf('hevc') !== -1 ? 'hevc' :
                       ((sourceCodec || '').toLowerCase().indexOf('264') !== -1 ? 'h264' : 'other'));
        if (codecCat === 'av1') {
            baseCQ += 1; // AV1 handles compression better
        } else if (codecCat === 'h264') {
            baseCQ -= 1; // Needs more quality headroom
        }

        if (isHDR) {
            baseCQ -= 2; // Protect highlights
        } else if (String(pixFmt || '').toLowerCase().indexOf('10') !== -1) {
            baseCQ -= 1; // Mild buffer for 10-bit
        }

        // Release group profile-based adjustments
        var releaseGroupProfiles = null;
        try {
            var path = require('path');
            var profilePath = '/app/configs/release_group_profiles.json';
            if (fs.existsSync(profilePath)) {
                var profileContent = fs.readFileSync(profilePath, 'utf8');
                var profileData = JSON.parse(profileContent);
                releaseGroupProfiles = profileData.profiles || {};
                args.jobLog('Loaded ' + Object.keys(releaseGroupProfiles).length + ' release group profiles');
            }
        } catch (rgErr) {
            args.jobLog('⚠ Could not load release group profiles: ' + rgErr.message);
        }

        // Apply release group adjustment
        if (releaseGroup && releaseGroupProfiles && releaseGroup in releaseGroupProfiles) {
            var profile = releaseGroupProfiles[releaseGroup];
            baseCQ += profile.cq_bias;

            args.jobLog('Release group profile match: ' + releaseGroup);
            args.jobLog('  Quality tier: ' + profile.quality_tier);
            args.jobLog('  CQ bias: ' + profile.cq_bias + ' (median: ' + profile.median_cq.toFixed(1) + ')');
            args.jobLog('  Confidence: ' + (profile.confidence * 100).toFixed(0) + '% (' + profile.sample_count + ' samples)');
            args.jobLog('  Success rate: ' + (profile.success_rate * 100).toFixed(0) + '%');

            // (legacy boost: declared learningWeight here so the read path at line ~802 can
            //  later see the upstream value. The actual blend happens further down where
            //  vmafLearnedCQRange is read; this block just makes the variable available.)

            args.variables.vmafReleaseGroupProfile = profile;
            args.variables.vmafReleaseGroupUsed = releaseGroup;
        } else if (releaseGroup) {
            // Fallback to simple heuristics if no profile match
            var rg = String(releaseGroup).toLowerCase();
            if (rg.indexOf('remux') !== -1 || rg.indexOf('bluray') !== -1) {
                baseCQ += 1; // higher quality source, allow slightly higher CQ
            } else if (rg.indexOf('web') !== -1 || rg.indexOf('rip') !== -1 || rg.indexOf('hone') !== -1 || rg.indexOf('hhweb') !== -1) {
                baseCQ -= 1; // streaming/scene encodes, be a bit more conservative
            }
            args.jobLog('Release group: ' + releaseGroup + ' (no profile match, using heuristics)');
            args.variables.vmafReleaseGroupUsed = releaseGroup;
        }

        // Genre/style based adjustments (after bitrate/resolution math)
        var mediaGenres = Array.isArray(args.variables.vmafMediaGenre) ? args.variables.vmafMediaGenre : [];
        var mediaGenresLower = mediaGenres.map(function(g) { return String(g).toLowerCase(); });
        var isAnimation = args.variables.vmafMediaIsAnimation === true || mediaGenresLower.indexOf('animation') !== -1 || mediaGenresLower.indexOf('anime') !== -1 || mediaGenresLower.indexOf('cartoon') !== -1;
        var mediaType = args.variables.vmafMediaType || 'unknown';
        var metadataSource = args.variables.vmafMediaMetadataSource || 'none';

        var genreAdjustment = 0;
        var animationAdjustment = 0;
        if (isAnimation) {
            animationAdjustment = 5; // animation tolerates higher CQ
        } else {
            var hasAction = mediaGenresLower.some(function(g) { return g.indexOf('action') !== -1 || g.indexOf('thriller') !== -1 || g.indexOf('sport') !== -1; });
            var hasDoc = mediaGenresLower.some(function(g) { return g.indexOf('documentary') !== -1 || g.indexOf('news') !== -1; });
            if (hasAction) {
                genreAdjustment = -3;
            } else if (hasDoc) {
                genreAdjustment = 2;
            }
        }

        if (mediaType === 'movie') {
            genreAdjustment += 1; // movies usually higher quality sources
        } else if (mediaType === 'tv') {
            genreAdjustment += 0; // keep neutral for episodic TV
        }

        var sourceConfidence = 0.5;
        if (metadataSource === 'plex') sourceConfidence = 1.0;
        else if (metadataSource === 'tmdb') sourceConfidence = 0.9;
        else if (metadataSource === 'tvdb' || metadataSource === 'imdb') sourceConfidence = 0.8;
        else if (metadataSource === 'none') sourceConfidence = 0.3;
        var genrePresenceConfidence = mediaGenresLower.length > 0 ? 1.0 : 0.4;
        var metadataConfidence = Math.max(0.3, Math.min(1.0, sourceConfidence * genrePresenceConfidence));

        var totalGenreAdjustment = (genreAdjustment + animationAdjustment) * metadataConfidence;
        if (totalGenreAdjustment !== 0) {
            baseCQ += totalGenreAdjustment;
            args.jobLog('Genre/style adjustment applied (animation: ' + animationAdjustment + ', genre: ' + genreAdjustment + ', confidence: ' + metadataConfidence.toFixed(2) + '), new base CQ: ' + baseCQ.toFixed(2));
        }
        args.variables.vmafGenreCQAdjustment = genreAdjustment;
        args.variables.vmafAnimationCQAdjustment = animationAdjustment;

        // Clamp baseCQ to valid range
        baseCQ = Math.max(16, Math.min(48, baseCQ));

        // Adaptive range/step based on sample variance signal from extraction
        args.variables.vmafCQRangeWidthUsed = effectiveRangeWidth;
        args.variables.vmafCQStepUsed = effectiveStep;

        // Generate CQ range centered around baseCQ (heuristic), with CI-based widening if noisy
        var heuristicCQMin = Math.max(16, baseCQ - Math.floor(effectiveRangeWidth / 2));
        var heuristicCQMax = Math.min(51, heuristicCQMin + effectiveRangeWidth);

        // Ensure we don't go below 16 or above 51
        if (heuristicCQMax > 51) {
            heuristicCQMax = 51;
            heuristicCQMin = Math.max(16, heuristicCQMax - effectiveRangeWidth);
        }

        // Check for learned CQ range from Bayesian learning; adjust span based on confidence/sampleCount
        var learnedCQRange = args.variables.vmafLearnedCQRange;
        var cqMin = heuristicCQMin;
        var cqMax = heuristicCQMax;
        var cqSource = 'heuristic';

        // Analyze across-CQ slope/variance to adjust span/step
        if (aggregatedResults.length >= 2) {
            var cqPoints = aggregatedResults.filter(function(r) {
                return r.parameterSet && r.parameterSet.quality !== undefined;
            }).map(function(r) {
                return {
                    cq: r.parameterSet.quality,
                    vmaf: r.avgVMAF,
                    size: r.avgFileSizeMB,
                    std: r.vmafStdDev || 0
                };
            }).sort(function(a, b) { return a.cq - b.cq; });

            var steep = false;
            for (var si = 0; si < cqPoints.length - 1; si++) {
                var a = cqPoints[si];
                var b = cqPoints[si + 1];
                var dv = Math.abs(a.vmaf - b.vmaf);
                var dcq = b.cq - a.cq;
                if (dcq > 0 && dv / dcq > 1.5) {
                    steep = true;
                    break;
                }
            }
            var flat = false;
            if (!steep) {
                var vmafs = cqPoints.map(function(p) { return p.vmaf; });
                var meanV = vmafs.reduce(function(x, y) { return x + y; }, 0) / vmafs.length;
                var varV = vmafs.reduce(function(acc, v) {
                    var d = v - meanV;
                    return acc + d * d;
                }, 0) / vmafs.length;
                var stdV = Math.sqrt(varV);
                if (stdV < 1.0) flat = true;
            }
            if (steep) {
                effectiveRangeWidth = Math.min(14, effectiveRangeWidth + 2);
                effectiveStep = Math.max(1, effectiveStep - 1);
                args.jobLog('Across-CQ slope steep -> widening span to ' + effectiveRangeWidth + ', step ' + effectiveStep);
            } else if (flat) {
                effectiveRangeWidth = Math.max(4, effectiveRangeWidth - 2);
                effectiveStep = Math.min(4, effectiveStep + 1);
                args.jobLog('Across-CQ curve flat -> tightening span to ' + effectiveRangeWidth + ', step ' + effectiveStep);
            }
            heuristicCQMin = Math.max(16, baseCQ - Math.floor(effectiveRangeWidth / 2));
            heuristicCQMax = Math.min(51, heuristicCQMin + effectiveRangeWidth);
            if (heuristicCQMax > 51) {
                heuristicCQMax = 51;
                heuristicCQMin = Math.max(16, heuristicCQMax - effectiveRangeWidth);
            }
            args.variables.vmafCQRangeWidthUsed = effectiveRangeWidth;
            args.variables.vmafCQStepUsed = effectiveStep;
        }

        // Use release group profile to narrow range if available
        if (releaseGroupPrior && releaseGroupPrior.sample_count >= 10) {
            var rgStats = releaseGroupPrior.cq_statistics;
            var rgIQR = rgStats.q75 - rgStats.q25;  // Inter-quartile range
            var rgWidth = Math.ceil(rgIQR * 1.5);  // 1.5x IQR captures outliers

            // Only narrow if profile suggests tighter range
            if (rgWidth < effectiveRangeWidth) {
                effectiveRangeWidth = rgWidth;
                heuristicCQMin = Math.max(16, Math.round(rgStats.median - Math.floor(rgWidth / 2)));
                heuristicCQMax = Math.min(51, heuristicCQMin + rgWidth);

                if (heuristicCQMax > 51) {
                    heuristicCQMax = 51;
                    heuristicCQMin = Math.max(16, heuristicCQMax - rgWidth);
                }

                args.jobLog('Release group profile narrowed CQ range to: ' + heuristicCQMin + '-' + heuristicCQMax + ' (IQR=' + rgIQR.toFixed(1) + ')');
            }
        }

        // If we have recent per-CQ noise info from previous run, widen span slightly when noise is high
        var previousNoise = args.variables.vmafSelectedStdDev;
        if (previousNoise !== undefined && previousNoise !== null && !isNaN(previousNoise)) {
            if (previousNoise > 3) {
                effectiveRangeWidth = Math.min(14, effectiveRangeWidth + 2);
                heuristicCQMin = Math.max(16, baseCQ - Math.floor(effectiveRangeWidth / 2));
                heuristicCQMax = Math.min(51, heuristicCQMin + effectiveRangeWidth);
                args.jobLog('Previous CQ noise high (' + previousNoise.toFixed(2) + '), widening heuristic span to ' + heuristicCQMin + '-' + heuristicCQMax);
            } else if (previousNoise < 1) {
                effectiveRangeWidth = Math.max(4, effectiveRangeWidth - 2);
                heuristicCQMin = Math.max(16, baseCQ - Math.floor(effectiveRangeWidth / 2));
                heuristicCQMax = Math.min(51, heuristicCQMin + effectiveRangeWidth);
                args.jobLog('Previous CQ noise low (' + previousNoise.toFixed(2) + '), tightening heuristic span to ' + heuristicCQMin + '-' + heuristicCQMax);
            }
        }

        function adjustSpanWithConfidence(minVal, maxVal, confidence, sampleCount) {
            var span = maxVal - minVal;
            if (confidence >= 0.8 && sampleCount >= 15) {
                span = Math.max(4, Math.round(span * 0.6));
            } else if (confidence >= 0.6 && sampleCount >= 8) {
                span = Math.max(4, Math.round(span * 0.8));
            } else if (confidence < 0.4 || sampleCount < 5) {
                span = Math.min(14, Math.round(span * 1.2));
            }
            var mid = Math.round((minVal + maxVal) / 2);
            var newMin = Math.max(16, mid - Math.floor(span / 2));
            var newMax = Math.min(51, newMin + span);
            if (newMax > 51) {
                newMax = 51;
                newMin = Math.max(16, newMax - span);
            }
            return { min: newMin, max: newMax };
        }

        if (learnedCQRange && learnedCQRange.min !== undefined && learnedCQRange.max !== undefined) {
            var learnedCQMin = learnedCQRange.min;
            var learnedCQMax = learnedCQRange.max;
            var learningWeight = learnedCQRange.confidence || 0.5; // Use confidence as weight
            var minSamplesForLearning = 5; // Could be from plugin input, but using default for now
            var sampleWeight = Math.min(1, (learnedCQRange.sampleCount || 0) / 15);
            learningWeight = Math.min(1, Math.max(learningWeight, sampleWeight));

            if (learnedCQRange.sampleCount >= minSamplesForLearning) {
                // Blend learned range with heuristic, then adjust span by confidence/sampleCount
                var blendedMin = Math.round(learningWeight * learnedCQMin + (1 - learningWeight) * heuristicCQMin);
                var blendedMax = Math.round(learningWeight * learnedCQMax + (1 - learningWeight) * heuristicCQMax);
                var adjusted = adjustSpanWithConfidence(blendedMin, blendedMax, learningWeight, learnedCQRange.sampleCount);
                cqMin = adjusted.min;
                cqMax = adjusted.max;
                cqSource = 'blended (learned + heuristic, confidence-shaped span)';

                args.jobLog('');
                args.jobLog('Learning Integration:');
                args.jobLog('  Heuristic range: CQ ' + heuristicCQMin + '-' + heuristicCQMax);
                args.jobLog('  Learned range: CQ ' + learnedCQMin + '-' + learnedCQMax + ' (from ' + learnedCQRange.sampleCount + ' samples)');
                args.jobLog('  Blended range: CQ ' + cqMin + '-' + cqMax + ' (weight: ' + (learningWeight * 100).toFixed(0) + '% learned)');
            } else {
                args.jobLog('');
                args.jobLog('Learning data available but insufficient samples (' + learnedCQRange.sampleCount + ' < ' + minSamplesForLearning + ') - using heuristic');
            }
        } else {
            args.jobLog('');
            args.jobLog('No learned CQ range available - using heuristic only');
        }

        // Historical per-CQ curve: the strongest prior when enough similar sweep points exist
        // (loaded by extractVideoSamples from vmaf_results.csv). Fit a monotonic non-increasing
        // VMAF-vs-CQ curve via PAVA and centre the sweep where it crosses the VMAF target.
        var histPoints = Array.isArray(args.variables.vmafHistoricalCqPoints) ? args.variables.vmafHistoricalCqPoints : [];
        var histMeta = args.variables.vmafHistoricalCqMeta || {};
        if (histPoints.length >= 6 && (histMeta.distinctCqCount || 0) >= 3) {
            try {
                var byCq = {};
                histPoints.forEach(function(p) {
                    var k = Math.round(Number(p.cq) * 2) / 2;
                    if (!isFinite(k) || !isFinite(p.vmaf)) return;
                    var wv = isFinite(p.w) && p.w > 0 ? p.w : 1;
                    if (!byCq[k]) byCq[k] = { cq: k, sw: 0, swv: 0 };
                    byCq[k].sw += wv;
                    byCq[k].swv += p.vmaf * wv;
                });
                var hxs = Object.keys(byCq).map(function(k) { return byCq[k]; })
                    .sort(function(a, b) { return a.cq - b.cq; });
                var hVals = hxs.map(function(g) { return -(g.swv / g.sw); });
                var hWts = hxs.map(function(g) { return g.sw; });
                var hBlocks = [];
                for (var hbi = 0; hbi < hVals.length; hbi++) {
                    hBlocks.push({ s: hbi, e: hbi + 1, w: hWts[hbi], v: hVals[hbi] });
                    while (hBlocks.length >= 2) {
                        var hb0 = hBlocks[hBlocks.length - 2];
                        var hb1 = hBlocks[hBlocks.length - 1];
                        if (hb0.v <= hb1.v) break;
                        var hwsum = hb0.w + hb1.w;
                        hBlocks.splice(hBlocks.length - 2, 2, { s: hb0.s, e: hb1.e, w: hwsum, v: (hb0.v * hb0.w + hb1.v * hb1.w) / hwsum });
                    }
                }
                var hyHat = new Array(hVals.length);
                hBlocks.forEach(function(b) { for (var hj = b.s; hj < b.e; hj++) hyHat[hj] = -b.v; });
                var hcxs = hxs.map(function(g) { return g.cq; });
                var estCqHist = null;
                if (hyHat.length >= 2) {
                    if (targetMinVMAF > hyHat[0]) estCqHist = hcxs[0];
                    else if (targetMinVMAF < hyHat[hyHat.length - 1]) estCqHist = hcxs[hcxs.length - 1];
                    else {
                        for (var hii = 0; hii < hcxs.length - 1; hii++) {
                            if (hyHat[hii] >= targetMinVMAF && hyHat[hii + 1] <= targetMinVMAF) {
                                estCqHist = hyHat[hii + 1] === hyHat[hii] ? (hcxs[hii] + hcxs[hii + 1]) / 2
                                    : hcxs[hii] + (targetMinVMAF - hyHat[hii]) * (hcxs[hii + 1] - hcxs[hii]) / (hyHat[hii + 1] - hyHat[hii]);
                                break;
                            }
                        }
                    }
                }
                if (estCqHist !== null && isFinite(estCqHist)) {
                    estCqHist = Math.max(16, Math.min(51, estCqHist));
                    var histConf = Math.min(1, (histMeta.effN || 0) / 25);
                    var curCenter = (cqMin + cqMax) / 2;
                    var blendedCenter = histConf * estCqHist + (1 - histConf) * curCenter;
                    var spanH = effectiveRangeWidth;
                    if (histConf >= 0.6) spanH = Math.max(4, effectiveRangeWidth - 2);
                    cqMin = Math.max(16, Math.round(blendedCenter - spanH / 2));
                    cqMax = Math.min(51, cqMin + spanH);
                    if (cqMax > 51) {
                        cqMax = 51;
                        cqMin = Math.max(16, cqMax - spanH);
                    }
                    cqSource = 'historical-curve (estCQ@' + targetMinVMAF + '=' + estCqHist.toFixed(1) + ', conf=' + histConf.toFixed(2) + ')';
                    args.jobLog('Historical curve estimate: CQ ' + estCqHist.toFixed(2) + ' at VMAF ' + targetMinVMAF
                        + ' (effN=' + (histMeta.effN || 0) + ', points=' + histPoints.length + ') -> range ' + cqMin + '-' + cqMax);
                }
            } catch (histErr) {
                args.jobLog('Historical curve fit failed: ' + (histErr && histErr.message ? histErr.message : String(histErr)));
            }
        }

        args.jobLog('');
        args.jobLog('Final CQ range (' + cqSource + '): ' + cqMin + ' - ' + cqMax + ' (step: ' + effectiveStep + ')');

        // Progressive CQ expansion or generate all values upfront
        var progressiveExpansion = args.inputs.progressiveCQExpansion !== false && args.inputs.progressiveCQExpansion !== 'false';
        var initialCQCount = Number(args.inputs.initialCQCount) || 3;

        // Check if checkCQBracket returned with expansion CQ values
        if (args.variables.vmafNextCQs && args.variables.vmafNextCQs.length > 0) {
            // Progressive expansion phase 2: test additional CQ values from checkCQBracket
            crfValues = args.variables.vmafNextCQs;

            // Use override range if provided
            if (args.variables.vmafOverrideCQMin !== undefined) {
                cqMin = args.variables.vmafOverrideCQMin;
            }
            if (args.variables.vmafOverrideCQMax !== undefined) {
                cqMax = args.variables.vmafOverrideCQMax;
            }

            args.jobLog('Progressive Expansion Phase 2: Testing additional CQ values');
            args.jobLog('Expansion CQ values: ' + crfValues.join(', '));

            // Clear expansion variables so we don't loop
            delete args.variables.vmafNextCQs;
            delete args.variables.vmafOverrideCQMin;
            delete args.variables.vmafOverrideCQMax;

        } else if (!progressiveExpansion || isRetry) {
            // Standard: generate all CQ values upfront
            for (var cq = cqMin; cq <= cqMax; cq += effectiveStep) {
                crfValues.push(cq);
            }
            args.jobLog('CQ values to test: ' + crfValues.join(', '));
        } else {
            // Progressive: start with initial bracket around baseCQ
            var baseCQCalc = Math.round((cqMin + cqMax) / 2);

            // Generate initial points centered on baseCQ
            var initialCQs = [];
            for (var offset = -(Math.floor(initialCQCount / 2)); offset <= Math.floor(initialCQCount / 2); offset++) {
                var testCQ = baseCQCalc + (offset * effectiveStep);
                if (testCQ >= cqMin && testCQ <= cqMax) {
                    initialCQs.push(testCQ);
                }
            }

            // Ensure at least baseCQ is tested
            if (initialCQs.length === 0) {
                initialCQs = [baseCQCalc];
            }

            crfValues = initialCQs;

            // Store for phase 2 expansion
            args.variables.vmafProgressiveExpansion = {
                enabled: true,
                cqMin: cqMin,
                cqMax: cqMax,
                baseCQ: baseCQCalc,
                step: effectiveStep,
                initialCQs: initialCQs
            };

            args.jobLog('Progressive expansion enabled');
            args.jobLog('Phase 1: Testing initial bracket: ' + crfValues.join(', '));
            args.jobLog('Full range available: ' + cqMin + '-' + cqMax + ' (will expand if needed)');
        }

        args.jobLog('');

        // Store dynamic CQ info in variables for later analysis
        args.variables.vmafDynamicCQ = true;
        args.variables.vmafSourceBitrateMbps = sourceBitrateMbps;
        args.variables.vmafSourceBpp = bitsPerPixel;
        args.variables.vmafCalculatedBaseCQ = baseCQ;
        args.variables.vmafCQRange = { min: cqMin, max: cqMax, width: cqMax - cqMin };
    } else {
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
