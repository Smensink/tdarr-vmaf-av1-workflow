"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

// Retained only so an old imported flow fails safe instead of silently changing
// its graph. The former implementation never ran FFmpeg scene detection: it
// inferred "scene rate" from bitrate-per-pixel and advertised the result as
// measured complexity. No active flow uses this payload.
var details = function () { return ({
    name: '[Retired] Detect Scene Complexity',
    description: 'Retired compatibility payload. It performs no scene analysis and makes no sampling recommendation.',
    style: { borderColor: 'grey' },
    tags: 'video,vmaf,retired',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faBan',
    inputs: [],
    outputs: [
        {
            number: 1,
            tooltip: 'Compatibility pass-through; replace/remove this retired node.',
        },
    ],
}); };
exports.details = details;

var plugin = function (args) {
    args.variables = args.variables || {};
    delete args.variables.vmafSceneComplexity;
    delete args.variables.vmafRecommendedSamples;
    delete args.variables.vmafComplexityAdjustment;
    delete args.variables.vmafSceneSampleAdjustment;
    args.variables.vmafDetectSceneComplexityRetired = true;
    args.jobLog('RETIRED: Detect Scene Complexity never implemented scene analysis. No complexity or sample-count adjustment was applied; remove this node from the flow.');
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
