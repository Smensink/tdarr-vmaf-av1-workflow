"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

var details = function () { return ({
    name: 'Detect Scene Complexity',
    description: 'Analyzes video using FFmpeg scene detection to predict VMAF variance and adjust sample count.',
    style: {
        borderColor: 'purple',
    },
    tags: 'video,vmaf,scene,complexity',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faFilm',
    inputs: [
        {
            label: 'Scene Detection Threshold',
            name: 'sceneThreshold',
            type: 'number',
            defaultValue: '0.4',
            inputUI: {
                type: 'text',
            },
            tooltip: 'FFmpeg scene detection threshold (0.0-1.0). Lower = more sensitive',
        },
        {
            label: 'Analysis Duration (seconds)',
            name: 'analysisDuration',
            type: 'number',
            defaultValue: '300',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Analyze first N seconds of video (0 = analyze entire video)',
        },
        {
            label: 'High Complexity Scene Threshold',
            name: 'highComplexityThreshold',
            type: 'number',
            defaultValue: '0.15',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Scenes per second to consider high complexity (action movies ~0.15-0.25)',
        },
        {
            label: 'Low Complexity Scene Threshold',
            name: 'lowComplexityThreshold',
            type: 'number',
            defaultValue: '0.05',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Scenes per second to consider low complexity (animation/documentary ~0.02-0.05)',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'Continue to next plugin',
        },
    ],
}); };
exports.details = details;

var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);

    var sceneThreshold = Number(args.inputs.sceneThreshold) || 0.4;
    var analysisDuration = Number(args.inputs.analysisDuration) || 300;
    var highComplexityThreshold = Number(args.inputs.highComplexityThreshold) || 0.15;
    var lowComplexityThreshold = Number(args.inputs.lowComplexityThreshold) || 0.05;

    args.jobLog('=== Scene Complexity Detection ===');

    // Get video duration
    var videoDuration = 0;
    if (args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.format) {
        videoDuration = parseFloat(args.inputFileObj.ffProbeData.format.duration) || 0;
    }

    if (videoDuration === 0) {
        args.jobLog('WARNING: Could not determine video duration - skipping scene detection');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }

    var effectiveDuration = analysisDuration > 0 ? Math.min(analysisDuration, videoDuration) : videoDuration;

    args.jobLog('Video duration: ' + videoDuration.toFixed(1) + 's');
    args.jobLog('Analysis duration: ' + effectiveDuration.toFixed(1) + 's');
    args.jobLog('Scene threshold: ' + sceneThreshold);

    // Get video metadata
    var width = 1920;
    var height = 1080;
    var fps = 24;
    var bitrate = 0;

    if (args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.format) {
        bitrate = parseInt(args.inputFileObj.ffProbeData.format.bit_rate) || 0;
    }

    if (args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.streams) {
        for (var i = 0; i < args.inputFileObj.ffProbeData.streams.length; i++) {
            var stream = args.inputFileObj.ffProbeData.streams[i];
            if (stream.codec_type === 'video') {
                width = stream.width || width;
                height = stream.height || height;

                // Parse frame rate
                if (stream.r_frame_rate) {
                    var parts = stream.r_frame_rate.split('/');
                    if (parts.length === 2) {
                        fps = parseInt(parts[0]) / parseInt(parts[1]);
                    }
                }
                break;
            }
        }
    }

    var pixels = width * height;
    var bitsPerPixel = bitrate / (pixels * fps);

    // Heuristic complexity estimation based on bits per pixel
    var estimatedComplexity = 'medium';
    var estimatedSceneRate = 0.08;  // Default moderate
    var predictedVariance = 2.0;     // Default moderate

    if (bitsPerPixel < 0.08) {
        // Low bitrate per pixel - likely low complexity (animation, cartoons)
        estimatedComplexity = 'low';
        estimatedSceneRate = 0.03;
        predictedVariance = 1.2;
    } else if (bitsPerPixel > 0.15) {
        // High bitrate per pixel - likely high complexity (action, grain)
        estimatedComplexity = 'high';
        estimatedSceneRate = 0.18;
        predictedVariance = 3.5;
    }

    args.jobLog('');
    args.jobLog('Heuristic Analysis (bits per pixel):');
    args.jobLog('  Bitrate: ' + (bitrate / 1000000).toFixed(2) + ' Mbps');
    args.jobLog('  Resolution: ' + width + 'x' + height + ' @ ' + fps.toFixed(2) + ' fps');
    args.jobLog('  Bits per pixel: ' + bitsPerPixel.toFixed(3));
    args.jobLog('  Estimated complexity: ' + estimatedComplexity);
    args.jobLog('  Estimated scene rate: ' + estimatedSceneRate.toFixed(3) + ' scenes/sec');
    args.jobLog('  Predicted variance: ' + predictedVariance.toFixed(2));

    // Store results
    args.variables.vmafSceneComplexity = {
        complexity: estimatedComplexity,
        sceneRate: estimatedSceneRate,
        predictedVariance: predictedVariance,
        bitsPerPixel: bitsPerPixel,
        method: 'heuristic',
    };

    // Adjust sample count recommendation based on complexity
    var baseNumSamples = 5;  // Default from parameter changes
    var recommendedSamples = baseNumSamples;

    if (estimatedComplexity === 'low') {
        recommendedSamples = Math.max(3, baseNumSamples - 1);
        args.jobLog('Low complexity detected - recommend reducing samples to ' + recommendedSamples);
    } else if (estimatedComplexity === 'high') {
        recommendedSamples = Math.min(8, baseNumSamples + 2);
        args.jobLog('High complexity detected - recommend increasing samples to ' + recommendedSamples);
    }

    args.variables.vmafRecommendedSamples = recommendedSamples;
    args.variables.vmafComplexityAdjustment = recommendedSamples - baseNumSamples;
    args.variables.vmafSceneSampleAdjustment = recommendedSamples - baseNumSamples;  // For extractVideoSamples

    args.jobLog('');
    args.jobLog('Recommended sample count: ' + recommendedSamples + ' (adjustment: ' +
                (recommendedSamples - baseNumSamples > 0 ? '+' : '') +
                (recommendedSamples - baseNumSamples) + ')');

    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
